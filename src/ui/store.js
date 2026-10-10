/**
 * 应用状态（单一数据源）。
 *
 * ## 这里只做一件事：把「一份歌曲 + 它的历史 + 它的落盘状态」管住
 *
 * 界面上的任何一次改动都走 `run()`：调一个 `core/edit.js` 的纯函数拿到新歌曲，
 * 成功后进历史栈、进曲库、排一次自动保存，然后通知订阅者重画。
 * 失败时**什么都不变**，把错误原样交回给调用方去决定怎么提示。
 *
 * 这条路径只有一条，是刻意的：只要有第二条路能改歌曲（比如界面自己拼一个新对象
 * 塞进状态），「撤销一定能回到上一个状态」和「保存的一定是屏幕上那一份」就都不成立了。
 *
 * ## 落盘状态必须是真的
 *
 * `saveStatus` 只有五种取值，每种都对应真实发生的事：
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `saved` | 上一次写入 `localStorage` 成功 |
 * | `pending` | 有改动还没写下去（自动保存有 200ms 合并窗口） |
 * | `error` | 写入失败，`saveError` 里是真实原因（配额满 / 无痕模式…） |
 * | `unsupported` | 这个环境没有可用的 `localStorage`，本机会话内有效 |
 * | `blocked` | 读到损坏数据，**在用户处理之前一次都不写**（SPEC §7.3） |
 *
 * `blocked` 是这里最要紧的一条：读到坏数据就自动覆盖，等于替用户删档。
 *
 * @module ui/store
 */

import {
  LIBRARY_CODES,
  clearLibrary,
  createEmptyLibrary,
  findSongById,
  getDefaultStorage,
  hasSongId,
  loadLibrary,
  readRawLibrary,
  removeSongById,
  saveLibrary,
  setActiveSongId,
  upsertSong,
} from '../core/library.js';
import {
  canRedo,
  canUndo,
  commit as commitHistory,
  createHistory,
  currentLabel,
  currentSong,
  redo as redoHistory,
  resetHistory,
  redoLabel,
  undo as undoHistory,
  undoDepth,
  undoLabel,
} from '../core/history.js';
import { cloneSong, createBlankSong, validateSongShape, migrateSong } from '../core/song.js';
import { emptyOrganization, validateOrganization } from '../core/organization.js';
import { duplicateSong } from '../core/edit.js';
import { createId } from '../core/ids.js';
import { createLiveDemo } from '../data/live-song.js';

/** 自动保存的合并窗口：连点几下按钮只写一次盘。 */
const SAVE_DEBOUNCE_MS = 200;
const SAMPLE_MIGRATION_KEY = 'chord-chart-workbench/v1/sample-migration';
const BUILT_IN_DEMO_TITLES = new Set(['候鸟信', '把日子唱成歌']);

/** 允许的界面模式。 */
export const MODES = Object.freeze(['edit', 'preview', 'present']);

export function createStore(options = {}) {
  const storage = options.storage !== undefined ? options.storage : getDefaultStorage();

  /** @type {{
   *   library: import('../core/library.js').Library,
   *   history: import('../core/history.js').History,
   *   saveStatus: 'saved'|'pending'|'error'|'unsupported'|'blocked',
   *   saveError: ?{code: string, message: string},
   *   storageProblem: ?{raw: ?string, code: string, message: string},
   *   repairWarning: ?string,
   *   textDraft: ?string,
   *   mode: 'edit'|'preview'|'present',
   *   selection: ?{sectionId: string, barIndex: ?number, eventIndex: ?number},
   * }} */
  const state = {
    library: createEmptyLibrary(),
    history: null,
    saveStatus: 'saved',
    saveError: null,
    storageProblem: null,
    repairWarning: null,
    textDraft: null,
    mode: 'edit',
    selection: null,
  };

  /** @type {Set<(reason: string) => void>} */
  const listeners = new Set();
  let saveTimer = null;

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  function emit(reason) {
    for (const listener of [...listeners]) listener(reason);
  }

  /** 当前打开的歌。曲库空的话返回 null（只有初始化那一瞬间会空）。 */
  function activeSong() {
    const byId = findSongById(state.library, state.library.activeSongId);
    return byId ?? state.library.songs[0] ?? null;
  }

  function getSong() {
    return currentSong(state.history);
  }

  /** 首次使用保留一个空白写谱入口，同时给用户一首可直接试听的示例。 */
  function seedLibrary() {
    const demo = createLiveDemo();
    const blank = createBlankSong();
    let library = createEmptyLibrary();
    library = upsertSong(library, demo);
    library = upsertSong(library, blank);
    return setActiveSongId(library, blank.id).library;
  }

  /**
   * 把本版本之前内置的演示曲移入回收站，并只补一首新的《小星星》示例。
   * 只按已知内置 ID/标题匹配，避免误删用户自己的歌曲；标记写在独立键里，
   * 所以用户删除示例后刷新不会再次自动塞回来。
   */
  function migrateBuiltInDemos(library) {
    const migrated = storage?.getItem?.(SAMPLE_MIGRATION_KEY) === 'v2';
    if (migrated) return { library, changed: false };

    const removed = library.songs.filter((song) => song.id === 'sng_sample0001' || BUILT_IN_DEMO_TITLES.has(song.title));
    const songs = library.songs.filter((song) => !removed.includes(song));
    const organization = structuredClone(library.organization ?? emptyOrganization());
    for (const song of removed) {
      if (!organization.trash.some((item) => item.song.id === song.id)) {
        organization.trash.push({ song: cloneSong(song), deletedAt: new Date().toISOString() });
      }
    }

    const hasNewDemo = songs.some((song) => song.title === '小星星（爵士前奏练习）');
    if (!hasNewDemo) songs.push(createLiveDemo());
    const activeSongId = songs.some((song) => song.id === library.activeSongId) ? library.activeSongId : songs[0]?.id ?? null;
    storage?.setItem?.(SAMPLE_MIGRATION_KEY, 'v2');
    return { library: { ...library, songs, activeSongId, organization, updatedAt: new Date().toISOString() }, changed: true };
  }

  /** 把曲库里的活跃歌曲换成 `song`（按 ID 覆盖），并选它。 */
  function putSongIntoLibrary(song, { select = false } = {}) {
    let library = upsertSong(state.library, song);
    if (select) library = setActiveSongId(library, song.id).library;
    state.library = library;
  }

  function setSaveStatus(status, error = null) {
    state.saveStatus = status;
    state.saveError = error;
  }

  /** 真正写盘。写失败如实记录，绝不吞掉。 */
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (state.saveStatus === 'blocked' || state.saveStatus === 'unsupported') return;

    const result = saveLibrary(storage, state.library);
    if (result.ok) {
      setSaveStatus('saved');
    } else {
      setSaveStatus('error', { code: result.code, message: result.message });
    }
    emit('save');
  }

  function scheduleSave() {
    if (state.saveStatus === 'blocked' || state.saveStatus === 'unsupported') return;
    setSaveStatus('pending');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    emit('save');
  }

  /* ---------------------------------------------------------------- *
   * 初始化
   * ---------------------------------------------------------------- */

  function init() {
    if (!storage) {
      state.library = seedLibrary();
      state.history = createHistory(activeSong(), { label: '示例歌曲' });
      setSaveStatus('unsupported', {
        code: LIBRARY_CODES.STORAGE_UNAVAILABLE,
        message: '这个浏览器环境不支持 localStorage（可能处于无痕模式或被隐私设置禁用）。本次编辑只保存在当前页面里，刷新就会丢——请用「导出工程」备份。',
      });
      return;
    }

    const loaded = loadLibrary(storage);
    if (!loaded.ok) {
      // 损坏：**一律不写**。原始字符串原样留着，等用户在界面上做决定。
      state.storageProblem = { raw: loaded.raw, code: loaded.code, message: loaded.message };
      state.library = seedLibrary();
      state.history = createHistory(activeSong(), { label: '示例歌曲' });
      setSaveStatus('blocked', { code: loaded.code, message: loaded.message });
      return;
    }

    let library = loaded.value;
    let seeded = false;
    if (library.songs.length === 0) {
      library = seedLibrary();
      seeded = true;
    } else {
      const migrated = migrateBuiltInDemos(library);
      library = migrated.library;
      seeded = migrated.changed;
    }
    state.library = library;
    state.repairWarning = loaded.needsRepair ? loaded.warnings.join('\n') : null;
    state.history = createHistory(activeSong(), { label: '已保存的歌曲' });

    // 首次使用：把空白草稿落盘，让用户下次打开还在。
    // 注意这只在曲库本来就是空的时候发生，不会覆盖任何既有内容。
    if (seeded) scheduleSave();
  }

  init();

  /* ---------------------------------------------------------------- *
   * 对外
   * ---------------------------------------------------------------- */

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSong,
    getLibrary: () => state.library,
    getMode: () => state.mode,
    getSelection: () => state.selection,
    getSaveStatus: () => state.saveStatus,
    getSaveError: () => state.saveError,
    getStorageProblem: () => state.storageProblem,
    getRepairWarning: () => state.repairWarning,
    hasStorage: () => Boolean(storage),

    /** 撤销 / 重做按钮的可用状态与文案。 */
    getHistoryInfo: () => ({
      canUndo: canUndo(state.history),
      canRedo: canRedo(state.history),
      undoLabel: undoLabel(state.history),
      redoLabel: redoLabel(state.history),
      currentLabel: currentLabel(state.history),
      depth: undoDepth(state.history),
    }),

    /**
     * 执行一次编辑。
     *
     * @param {string} label 这一步操作的名字（会显示在「撤销：<label>」上）
     * @param {(song: import('../core/song.js').Song) => import('../core/edit.js').EditResult} mutator
     * @returns {{ok: true} | {ok: false, code: string, message: string}}
     */
    run(label, mutator) {
      const song = getSong();
      const result = mutator(song);
      if (!result || result.ok !== true) {
        return { ok: false, code: result?.code ?? 'E_UNKNOWN', message: result?.message ?? '操作没有生效' };
      }
      if (result.value === song) return { ok: true }; // 幂等操作：没变化就不进历史
      const checked = validateSongShape(result.value);
      if (!checked.ok) return { ok: false, code: 'E_EDIT_SHAPE', message: checked.errors.map((e) => `${e.path}：${e.message}`).slice(0, 3).join('\n') };

      state.history = commitHistory(state.history, result.value, label);
      putSongIntoLibrary(result.value);
      scheduleSave();
      emit('edit');
      return { ok: true };
    },

    undo() {
      if (!canUndo(state.history)) return false;
      state.history = undoHistory(state.history);
      putSongIntoLibrary(getSong());
      scheduleSave();
      state.selection = null;
      emit('undo');
      return true;
    },

    redo() {
      if (!canRedo(state.history)) return false;
      state.history = redoHistory(state.history);
      putSongIntoLibrary(getSong());
      scheduleSave();
      state.selection = null;
      emit('redo');
      return true;
    },

    setMode(mode) {
      if (!MODES.includes(mode) || state.mode === mode) return;
      state.mode = mode;
      state.selection = null;
      emit('mode');
    },

    setSelection(selection) {
      state.selection = selection;
      emit('selection');
    },

    /* -------------------------------------------------------------- *
     * 文本草稿
     * -------------------------------------------------------------- */

    getTextDraft: () => state.textDraft,

    /** 用户在文本框里改了内容（还没解析应用）。 */
    setTextDraft(text) {
      state.textDraft = text;
      emit('text');
    },

    clearTextDraft() {
      state.textDraft = null;
      emit('text');
    },

    /**
     * 有没有「改了但还没应用的文本」。
     * 切换歌曲、导入工程之前要问一次，否则用户敲了半天的话会无声消失（SPEC §7.3）。
     */
    hasPendingTextDraft() {
      return state.textDraft !== null;
    },

    /* -------------------------------------------------------------- *
     * 曲库
     * -------------------------------------------------------------- */

    /** 新建一首空白歌曲并切过去。 */
    createSong(title) {
      const song = createBlankSong(title ?? '');
      putSongIntoLibrary(song, { select: true });
      state.history = createHistory(song, { label: '新建歌曲' });
      state.textDraft = null;
      state.selection = null;
      scheduleSave();
      emit('song-switch');
      return song;
    },

    /** 切换当前歌曲。找不到那首歌时返回 false。 */
    switchSong(songId) {
      const result = setActiveSongId(state.library, songId);
      if (!result.ok) return false;
      state.library = result.library;
      const song = activeSong();
      state.history = createHistory(song, { label: '切换歌曲' });
      state.textDraft = null;
      state.selection = null;
      scheduleSave();
      emit('song-switch');
      return true;
    },

    /** 复制当前歌曲（全套新 ID），并切到副本。 */
    duplicateSong() {
      const copy = duplicateSong(getSong());
      putSongIntoLibrary(copy, { select: true });
      state.history = createHistory(copy, { label: '复制歌曲' });
      state.textDraft = null;
      state.selection = null;
      scheduleSave();
      emit('song-switch');
      return copy;
    },

    /** 删除一首歌。曲库至少要留一首，删最后一首会被拒绝。 */
    deleteSong(songId) {
      const removed = state.library.songs.find((song) => song.id === songId);
      if (!removed) return { ok: false, message: '没有找到这首曲谱。' };
      const organization = structuredClone(state.library.organization ?? emptyOrganization());
      organization.trash.push({ song: cloneSong(removed), deletedAt: new Date().toISOString() });
      state.library = { ...state.library, organization };
      const wasActive = state.library.activeSongId === songId;
      state.library = removeSongById(state.library, songId);
      if (!state.library.songs.length) putSongIntoLibrary(createBlankSong(), { select: true });
      if (wasActive) {
        state.history = createHistory(activeSong(), { label: '切换歌曲' });
        state.textDraft = null;
      }
      scheduleSave();
      emit('song-switch');
      return { ok: true };
    },

    /**
     * 把一首（来自工程文件或其它来源的）歌放进曲库。
     *
     * @param {import('../core/song.js').Song} song
     * @param {{select?: boolean}} [options]
     */
    importSong(song, options = {}) {
      const validation = validateSongShape(song);
      if (!validation.ok) throw new Error(validation.errors[0].message);
      const select = options.select !== false;
      putSongIntoLibrary(song, { select });
      if (select) {
        state.history = createHistory(song, { label: '导入工程' });
        state.textDraft = null;
        state.selection = null;
      }
      scheduleSave();
      emit('song-switch');
      return song;
    },

    songIdExists: (songId) => hasSongId(state.library, songId),

    getOrganization: () => state.library.organization ?? emptyOrganization(),

    organize(mutator) {
      const next = structuredClone(state.library.organization ?? emptyOrganization());
      mutator(next);
      if (!validateOrganization(next)) return { ok: false, message: '分类或曲单信息不合法，未保存。' };
      state.library = { ...state.library, organization: next };
      scheduleSave();
      emit('organization');
      return { ok: true };
    },

    restoreSong(songId) {
      const org = structuredClone(state.library.organization ?? emptyOrganization());
      const index = org.trash.findIndex((item) => item.song.id === songId);
      if (index < 0) return { ok: false, message: '回收站里没有这首谱。' };
      const raw = migrateSong(org.trash[index].song);
      const song = hasSongId(state.library, raw.id) ? duplicateSong(raw) : cloneSong(raw);
      org.trash.splice(index, 1);
      state.library = { ...state.library, organization: org };
      putSongIntoLibrary(song, { select: true });
      state.history = createHistory(song, { label: '恢复曲谱' });
      scheduleSave();
      emit('song-switch');
      return { ok: true };
    },

    restoreBackup(library) {
      if (!library || !Array.isArray(library.songs) || library.songs.some((song) => !validateSongShape(migrateSong(song)).ok) || (library.organization && !validateOrganization(library.organization))) return { ok: false, message: '备份结构不完整，没有导入。' };
      if (new Set(library.songs.map((song) => song.id)).size !== library.songs.length) return { ok: false, message: '备份中有重复曲谱 ID，没有导入。' };
      const mapping = new Map();
      const incoming = library.songs.map((raw) => {
        const song = migrateSong(raw);
        const copy = hasSongId(state.library, song.id) ? duplicateSong(song) : cloneSong(song);
        mapping.set(song.id, copy.id);
        return copy;
      });
      const source = library.organization ?? emptyOrganization();
      const target = structuredClone(state.library.organization ?? emptyOrganization());
      target.folders.push(...source.folders.filter((f) => !target.folders.some((t) => t.id === f.id)));
      for (const id of source.favorites) { const next = mapping.get(id); if (next && !target.favorites.includes(next)) target.favorites.push(next); }
      for (const [id, folder] of Object.entries(source.assignments)) if (mapping.has(id)) target.assignments[mapping.get(id)] = folder;
      for (const [id, tags] of Object.entries(source.tags)) if (mapping.has(id)) target.tags[mapping.get(id)] = [...tags];
      target.setlists.push(...source.setlists.map((list) => ({ ...list, id: crypto.randomUUID(), songIds: list.songIds.map((id) => mapping.get(id)).filter(Boolean) })));
      target.trash.push(...source.trash.map((item) => ({ ...item, song: migrateSong(item.song) })));
      if (!validateOrganization(target)) return { ok: false, message: '合并后的曲库超过限制，请分批恢复。' };
      for (const song of incoming) putSongIntoLibrary(song);
      state.library = { ...state.library, organization: target };
      scheduleSave();
      emit('organization');
      return { ok: true, count: incoming.length };
    },

    /* -------------------------------------------------------------- *
     * 存储维护
     * -------------------------------------------------------------- */

    /** 立刻写盘（页面卸载前、或用户手动点「重试保存」）。 */
    flushSave,

    /**
     * 把本地存储里的**原始字符串**取出来，供「导出损坏数据备份」用。
     * 取的是存储里的原文，不是内存里的状态——用户要救的是硬盘上那份。
     */
    readRawStorage: () => readRawLibrary(storage),

    /**
     * 清空本地存储并重新开始。
     *
     * 这是**唯一**会覆盖损坏数据的动作，必须由用户明确确认后调用
     * （界面上要求输入确认词）。
     */
    clearStorageAndRestart() {
      const cleared = clearLibrary(storage);
      if (!cleared.ok) return cleared;
      state.storageProblem = null;
      state.repairWarning = null;
      state.library = seedLibrary();
      state.history = createHistory(activeSong(), { label: '重新开始' });
      state.textDraft = null;
      setSaveStatus('saved');
      flushSave();
      storage?.setItem?.(SAMPLE_MIGRATION_KEY, 'v2');
      emit('song-switch');
      return { ok: true };
    },
  };
}

/**
 * 曲库的本地保存（docs/SPEC.md §7.3）。
 *
 * 数据放在浏览器 `localStorage` 的单个键里（`chord-chart-workbench/v1/library`），
 * 结构是「一个曲库对象含多首歌」，而不是「一首歌一个键」。原因是：
 * 需要记录「上次打开的是哪首」、需要一次性读到全部歌曲做列表，
 * 单键读写也让「损坏时整体保留原文」这件事变得简单。
 *
 * ## 三条必须守住的规则
 *
 * 1. **读不动就不要写。** 读到损坏数据时，把**原始字符串**一起返回给调用方，
 *    本模块绝不自动覆盖、绝不「顺手修一下」。用户可能靠这段原文救回数据，
 *    自动清理等于替用户删档。
 * 2. **写失败要说实话。** localStorage 会满（`QuotaExceededError`），
 *    无痕模式会直接抛异常。这些错误必须原样往上报，不能吞掉后返回「已保存」。
 * 3. **不做假设性的修复。** 单首歌结构不合法时，把它隔离进 `brokenSongs`
 *    并置 `needsRepair`，其余歌曲照常加载；但**不自动回写**。
 *
 * ## storage 是注入的
 *
 * 所有读写都通过传入的 `storage` 对象（只要求 `getItem` / `setItem` / `removeItem`），
 * 这样 Node 里能用一个内存实现跑测试，不必模拟浏览器。
 *
 * @module core/library
 */

import { LIMITS, SCHEMA_VERSION, STORAGE_KEY } from './constants.js';
import { nowIso, validateSongShape, migrateSong } from './song.js';
import { validateOrganization } from './organization.js';

/** 曲库自身的结构版本，与歌曲的 `schemaVersion` 相互独立。 */
export const LIBRARY_SCHEMA_VERSION = 1;

/** localStorage 键名，与 SPEC §7.3 一致。 */
export const LIBRARY_STORAGE_KEY = STORAGE_KEY;

/**
 * 本地保存的错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const LIBRARY_CODES = Object.freeze({
  STORAGE_UNAVAILABLE: 'E_LIBRARY_STORAGE_UNAVAILABLE',
  READ_FAILED: 'E_LIBRARY_READ_FAILED',
  CORRUPT_JSON: 'E_LIBRARY_CORRUPT_JSON',
  INVALID_SHAPE: 'E_LIBRARY_INVALID_SHAPE',
  VERSION_UNSUPPORTED: 'E_LIBRARY_VERSION_UNSUPPORTED',
  WRITE_FAILED: 'E_LIBRARY_WRITE_FAILED',
  SONG_INVALID: 'E_LIBRARY_SONG_INVALID',
  QUOTA_EXCEEDED: 'E_LIBRARY_QUOTA_EXCEEDED',
});

/* ------------------------------------------------------------------ *
 * storage 适配
 * ------------------------------------------------------------------ */

/**
 * 取浏览器默认的 localStorage；拿不到（服务端渲染、测试环境、被策略禁用）返回 null。
 * @returns {{getItem: Function, setItem: Function, removeItem: Function}|null}
 */
export function getDefaultStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    // 有些环境里 localStorage 存在但一碰就抛（无痕模式的旧实现）。
    const probe = '__chord_chart_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * 造一个内存版 storage，给测试和「localStorage 不可用时的临时兜底」用。
 *
 * @param {Record<string, string>} [initial]
 * @returns {{getItem: (k: string) => string|null, setItem: (k: string, v: string) => void,
 *   removeItem: (k: string) => void, keys: () => string[]}}
 */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

/* ------------------------------------------------------------------ *
 * 曲库对象
 * ------------------------------------------------------------------ */

/**
 * 歌曲库。
 *
 * @typedef {Object} Library
 * @property {number} schemaVersion
 * @property {string|null} activeSongId 上次打开的歌曲 ID。
 * @property {import('./song.js').Song[]} songs
 * @property {string} updatedAt
 */

/**
 * 创建一个空曲库。
 * @returns {Library}
 */
export function createEmptyLibrary() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    activeSongId: null,
    songs: [],
    updatedAt: nowIso(),
  };
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/**
 * 读取结果。失败时 `raw` 是磁盘上的原始字符串（**必须原样保留**）。
 *
 * 成功但 `needsRepair` 为 true 时，`brokenSongs` 里是那些结构不合法、被暂时
 * 隔离的歌曲原文；调用方应当提示用户，并且**不要自动回写**。
 *
 * @typedef {{ok: true, value: Library, raw: string|null, warnings: string[],
 *    needsRepair: boolean, brokenSongs?: Array<{index: number, song: unknown,
 *    errors: import('./song.js').ValidationIssue[]}>}
 *   | {ok: false, value: null, raw: string|null, code: string, message: string,
 *      errors: import('./song.js').ValidationIssue[]}} LoadResult
 */

/**
 * 从 storage 读取曲库。
 *
 * @param {{getItem: Function}|null} [storage] 省略时用浏览器 localStorage。
 * @returns {LoadResult}
 */
export function loadLibrary(storage = getDefaultStorage()) {
  if (!storage || typeof storage.getItem !== 'function') {
    return {
      ok: false,
      value: null,
      raw: null,
      code: LIBRARY_CODES.STORAGE_UNAVAILABLE,
      message: '这个浏览器环境不支持 localStorage（可能处于无痕模式或被隐私设置禁用），无法读取本地曲库。你依然可以编辑并用「导出工程」备份。',
      errors: [],
    };
  }

  let raw = null;
  try {
    raw = storage.getItem(LIBRARY_STORAGE_KEY);
  } catch (error) {
    return {
      ok: false,
      value: null,
      raw: null,
      code: LIBRARY_CODES.READ_FAILED,
      message: `读取本地存储失败：${error?.message ?? error}`,
      errors: [],
    };
  }

  // 从没保存过：这是一个正常的空曲库，不是错误。
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: createEmptyLibrary(), raw: null, warnings: [], needsRepair: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      value: null,
      raw,
      code: LIBRARY_CODES.CORRUPT_JSON,
      message: `本地曲库不是合法的 JSON（${error?.message ?? error}）。原始内容已保留，未做任何修改——你可以导出备份或手动清理后再重试。`,
      errors: [],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      value: null,
      raw,
      code: LIBRARY_CODES.INVALID_SHAPE,
      message: `本地曲库的顶层结构不是对象（实际为 ${Array.isArray(parsed) ? 'array' : typeof parsed}）。原始内容已保留。`,
      errors: [],
    };
  }

  if (parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
    return {
      ok: false,
      value: null,
      raw,
      code: LIBRARY_CODES.VERSION_UNSUPPORTED,
      message: `本地曲库版本为 ${JSON.stringify(parsed.schemaVersion)}，本版只支持 ${LIBRARY_SCHEMA_VERSION}。原始内容已保留，未做修改。`,
      errors: [],
    };
  }

  if (!Array.isArray(parsed.songs)) {
    return {
      ok: false,
      value: null,
      raw,
      code: LIBRARY_CODES.INVALID_SHAPE,
      message: `本地曲库的 songs 字段必须是数组（实际为 ${parsed.songs === null ? 'null' : typeof parsed.songs}）。原始内容已保留。`,
      errors: [],
    };
  }

  if (parsed.organization !== undefined && !validateOrganization(parsed.organization)) {
    return { ok: false, value: null, raw, code: LIBRARY_CODES.INVALID_SHAPE, message: '本地曲库的分类或回收站信息有问题，原文已保留。', errors: [] };
  }

  // 逐首校验：坏歌隔离出来，好歌照常加载，但整体标记为「需要修复」且不自动回写。
  /** @type {import('./song.js').Song[]} */
  const songs = [];
  /** @type {Array<{index: number, song: unknown, errors: import('./song.js').ValidationIssue[]}>} */
  const brokenSongs = [];
  const warnings = [];

  parsed.songs.forEach((original, index) => {
    const song = migrateSong(original);
    const validation = validateSongShape(song);
    if (validation.ok) {
      songs.push(song);
    } else {
      brokenSongs.push({ index, song, errors: validation.errors });
    }
  });

  if (brokenSongs.length > 0) {
    warnings.push(
      `曲库里有 ${brokenSongs.length} 首歌曲数据不合法，已暂时隔离（未被删除，原始内容仍在本地存储里）。第 ${brokenSongs[0].index + 1} 首的首条问题：${brokenSongs[0].errors[0]?.path || '(根)'} ${brokenSongs[0].errors[0]?.message ?? ''}`,
    );
  }

  let activeSongId = typeof parsed.activeSongId === 'string' ? parsed.activeSongId : null;
  if (activeSongId && !songs.some((song) => song.id === activeSongId)) {
    // 上次打开的歌已经不在了（被隔离或本来就不存在），退回第一首，不报错。
    activeSongId = songs.length > 0 ? songs[0].id : null;
  }

  return {
    ok: true,
    value: {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      activeSongId,
      songs,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
      ...(parsed.organization !== undefined ? { organization: parsed.organization } : {}),
    },
    raw,
    warnings,
    needsRepair: brokenSongs.length > 0,
    brokenSongs,
  };
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 写入结果。
 * @typedef {{ok: true, bytes: number}
 *   | {ok: false, code: string, message: string, errors: import('./song.js').ValidationIssue[]}}
 */

/**
 * 把曲库写入 storage。
 *
 * 写之前会把每首歌过一遍结构校验：宁可拒绝写入并报错，也不要把一份
 * 已经不合法的数据钉死在本地存储里——那会让下次启动直接读到坏数据。
 *
 * **本函数不修改 `updatedAt`。** 「最后一次改动时间」是内容语义，由真正改动
 * 内容的那些纯函数（`upsertSong` / `removeSongById` / `setActiveSongId`）负责刷新。
 * 持久化动作若也去改它，就会变成「同一份曲库保存两次、读出来却不同」——
 * 那样「是否有未保存改动」根本没法判断。这里只在缺字段时补一个默认值。
 *
 * @param {{setItem: Function}|null} storage
 * @param {Library} library
 * @returns {WriteResult}
 */
export function saveLibrary(storage, library) {
  if (!storage || typeof storage.setItem !== 'function') {
    return {
      ok: false,
      code: LIBRARY_CODES.STORAGE_UNAVAILABLE,
      message: '这个浏览器环境不支持 localStorage，无法保存到本地。请用「导出工程」把当前歌曲备份成 JSON 文件。',
      errors: [],
    };
  }

  if (!library || typeof library !== 'object' || !Array.isArray(library.songs)) {
    return {
      ok: false,
      code: LIBRARY_CODES.INVALID_SHAPE,
      message: '要保存的曲库结构不合法（缺少 songs 数组）。',
      errors: [],
    };
  }

  const errors = [];
  if (library.organization !== undefined && !validateOrganization(library.organization)) {
    return { ok: false, code: LIBRARY_CODES.INVALID_SHAPE, message: '曲库分类或回收站数据无效，未覆盖本地内容。', errors: [] };
  }
  library.songs.forEach((song, index) => {
    const validation = validateSongShape(song);
    if (!validation.ok) {
      validation.errors.slice(0, 3).forEach((issue) => {
        errors.push({ path: `songs[${index}]${issue.path ? `.${issue.path}` : ''}`, message: issue.message });
      });
    }
  });
  if (errors.length > 0) {
    return {
      ok: false,
      code: LIBRARY_CODES.SONG_INVALID,
      message: `曲库里有 ${errors.length} 处数据问题，已拒绝写入，避免把坏数据钉在本地存储里。首条：${errors[0].path} ${errors[0].message}`,
      errors,
    };
  }

  const payload = JSON.stringify({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    activeSongId: library.activeSongId ?? null,
    songs: library.songs,
    ...(library.organization !== undefined ? { organization: library.organization } : {}),
    // 只在缺字段时补默认值，绝不覆盖调用方给的时间。
    updatedAt: typeof library.updatedAt === 'string' ? library.updatedAt : nowIso(),
  });

  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > LIMITS.maxSongJsonBytes * 4) {
    return {
      ok: false,
      code: LIBRARY_CODES.QUOTA_EXCEEDED,
      message: `曲库体积 ${(bytes / 1024 / 1024).toFixed(2)} MB，已经超出本版愿意写入本地存储的上限，未尝试写入。请删除不再需要的歌曲，或导出后清理。`,
      errors: [],
    };
  }

  try {
    storage.setItem(LIBRARY_STORAGE_KEY, payload);
  } catch (error) {
    const name = error?.name ?? '';
    const isQuota = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22;
    return {
      ok: false,
      code: isQuota ? LIBRARY_CODES.QUOTA_EXCEEDED : LIBRARY_CODES.WRITE_FAILED,
      message: isQuota
        ? '本地存储空间已满，这次保存没有成功。请删除不再需要的歌曲，或用「导出工程」把当前歌曲备份成 JSON 文件。'
        : `写入本地存储失败：${error?.message ?? error}`,
      errors: [],
    };
  }

  return { ok: true, bytes };
}

/**
 * 清空本地曲库（删除整个键）。用于「曲库损坏后手动清理」这条路。
 *
 * @param {{removeItem: Function}|null} storage
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function clearLibrary(storage) {
  if (!storage || typeof storage.removeItem !== 'function') {
    return { ok: false, code: LIBRARY_CODES.STORAGE_UNAVAILABLE, message: '这个环境不支持 localStorage，无法清理。' };
  }
  try {
    storage.removeItem(LIBRARY_STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: LIBRARY_CODES.WRITE_FAILED, message: `清理本地存储失败：${error?.message ?? error}` };
  }
}

/**
 * 读出本地存储里的**原始字符串**，供「导出损坏数据备份」使用。
 *
 * @param {{getItem: Function}|null} storage
 * @returns {{ok: true, raw: string|null} | {ok: false, code: string, message: string}}
 */
export function readRawLibrary(storage = getDefaultStorage()) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ok: false, code: LIBRARY_CODES.STORAGE_UNAVAILABLE, message: '这个环境不支持 localStorage。' };
  }
  try {
    return { ok: true, raw: storage.getItem(LIBRARY_STORAGE_KEY) };
  } catch (error) {
    return { ok: false, code: LIBRARY_CODES.READ_FAILED, message: `读取本地存储失败：${error?.message ?? error}` };
  }
}

/* ------------------------------------------------------------------ *
 * 曲库内容的纯函数操作（返回新曲库，便于测试与撤销）
 * ------------------------------------------------------------------ */

/**
 * 插入或替换一首歌（按 `song.id`）。新歌追加到末尾。
 *
 * @param {Library} library
 * @param {import('./song.js').Song} song
 * @returns {Library}
 */
export function upsertSong(library, song) {
  const index = library.songs.findIndex((item) => item.id === song.id);
  const songs = library.songs.slice();
  if (index >= 0) songs[index] = song;
  else songs.push(song);
  return { ...library, songs, updatedAt: nowIso() };
}

/**
 * 按 ID 删除一首歌。删的是当前打开的那首时，`activeSongId` 退到剩余的第一首。
 *
 * @param {Library} library
 * @param {string} songId
 * @returns {Library}
 */
export function removeSongById(library, songId) {
  const songs = library.songs.filter((song) => song.id !== songId);
  let activeSongId = library.activeSongId;
  if (activeSongId === songId) activeSongId = songs.length > 0 ? songs[0].id : null;
  return { ...library, songs, activeSongId, updatedAt: nowIso() };
}

/**
 * 设置当前打开的歌曲。传入不存在的 ID 时保持原样并返回 false 供调用方判断。
 *
 * @param {Library} library
 * @param {string} songId
 * @returns {{library: Library, ok: boolean}}
 */
export function setActiveSongId(library, songId) {
  if (!library.songs.some((song) => song.id === songId)) {
    return { library, ok: false };
  }
  return { library: { ...library, activeSongId: songId, updatedAt: nowIso() }, ok: true };
}

/**
 * 按 ID 取一首歌。
 * @param {Library} library
 * @param {string} songId
 * @returns {import('./song.js').Song|null}
 */
export function findSongById(library, songId) {
  return library.songs.find((song) => song.id === songId) ?? null;
}

/**
 * 曲库里是否已经用过某个歌曲 ID（导入工程时用来判断要不要换 ID）。
 *
 * @param {Library} library
 * @param {string} songId
 * @returns {boolean}
 */
export function hasSongId(library, songId) {
  return library.songs.some((song) => song.id === songId);
}

/**
 * 给一首歌起一个在曲库内不重复的标题（「未命名歌曲」→「未命名歌曲 2」…）。
 * 只用于新建时的友好命名，不强制同名歌曲必须唯一。
 *
 * @param {Library} library
 * @param {string} baseTitle
 * @returns {string}
 */
export function suggestTitle(library, baseTitle) {
  const used = new Set(library.songs.map((song) => song.title));
  if (!used.has(baseTitle)) return baseTitle;
  let counter = 2;
  while (used.has(`${baseTitle} ${counter}`)) counter += 1;
  return `${baseTitle} ${counter}`;
}

/** 曲库里的歌曲数（界面列表用）。 */
export function songCount(library) {
  return library.songs.length;
}

/** 估算曲库序列化后的字节数，用于在界面上提示空间占用。 */
export function estimateLibraryBytes(library) {
  return new TextEncoder().encode(JSON.stringify(library)).length;
}

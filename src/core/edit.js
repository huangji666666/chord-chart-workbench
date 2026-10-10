/**
 * 编辑操作（docs/SPEC.md §7.1）。
 *
 * ## 三条不变的约定
 *
 * 1. **所有操作都是纯函数**：接收一个歌曲对象，返回一个**新的**歌曲对象。
 *    绝不原地修改入参。撤销栈存的就是这些对象，一旦有人原地改，历史记录会一起变形。
 * 2. **按 ID 查找，不按数组下标**（§2.3）。段落用 `sectionId` 定位；
 *    小节和事件用「段落 ID + 序号」定位——序号只是界面的操作坐标，
 *    数据里的每个实体依然带自己的独立 ID，序号永远不写进数据。
 * 3. **失败返回 `{ok: false}` 而不是抛异常**。ID 和序号是界面传进来的，
 *    找不到往往只因为用户刚把它删了——那不该让整个页面崩掉。
 *
 * ## 为什么每种操作都手写一遍，而不是抽一个通用包装
 *
 * 试过用「传一个 mapper 进去」的通用写法，结果是每个操作都要在 mapper 里
 * 借 `null` 当错误信号往外抛，报出来的位置全是错的（`duplicateBar` 会报成
 * 「小节序号超出范围」）。定位逻辑抽出来了（`locateSection` / `locateBar`），
 * 剩下的每一步都写明白——多几行，但出错时喊的是对的地方，接手的人一眼能看懂。
 *
 * ## 复制操作必须换 ID
 *
 * `duplicateSection` / `duplicateBar` 会给复制出来的每个实体生成新 ID（§7.2）。
 * 复用原 ID 会立刻被校验器查出重复（song.js 会遍历整棵对象树查重），
 * 而且会出现「点一个和弦、两个地方同时高亮」这种极难排查的 bug。
 *
 * ## 自动维护数据合法性
 *
 * 有三处本模块会**拒绝**执行，而不是留下一个已知非法的歌曲：
 *
 * | 操作 | 拒绝条件 | 为什么 |
 * | --- | --- | --- |
 * | `removeSection` | 只剩一个段落时 | 页面会变成一片空白，用户无处可点 |
 * | `removeBar` | 只剩一个小节时 | 同上，而且段落结构会失去意义 |
 * | `removeEvent` | 删掉小节里唯一的事件时 | 「chords 类型但没有事件」是非法的（§3.3），且和「空白小节」是两种含义（§2.4） |
 *
 * @module core/edit
 */

import {
  ACCIDENTAL_GLYPH_STYLES,
  BARS_PER_ROW_OPTIONS,
  CHORD_SYMBOL_STYLES,
  DIM_SUFFIX_STYLES,
  DISPLAY_LINE_IDS,
  LIMITS,
  MAX_DISPLAY_LINES,
  REST_TEXT_STYLES,
  SEVENTH_SUFFIX_STYLES,
  TIME_SIGNATURE_IDS,
  getBeatsPerBar,
  isAccidentalGlyphsValid,
  isChordSymbolsValid,
  isDimSuffixValid,
  isDisplayLinesValid,
  isRestTextValid,
  isSeventhSuffixValid,
  isTextBlockModeValid,
  normalizeDisplayLines,
} from './constants.js';
import { createChord } from './chord.js';
import { checkBeatsValue } from './duration.js';
import { createId } from './ids.js';
import { nowIso, barAnnotations } from './song.js';
import { defaultAlignment, splitWords } from './alignment.js';

/**
 * 编辑结果。成功时 `value` 是新歌曲；失败时 `value` 为 null，`message` 可直接展示。
 *
 * @typedef {{ok: true, value: import('./song.js').Song, message?: undefined, code?: undefined}
 *   | {ok: false, value: null, message: string, code: string}} EditResult
 */

/**
 * 编辑操作的错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const EDIT_CODES = Object.freeze({
  SECTION_NOT_FOUND: 'E_EDIT_SECTION_NOT_FOUND',
  SECTION_INDEX_INVALID: 'E_EDIT_SECTION_INDEX_INVALID',
  BAR_OUT_OF_RANGE: 'E_EDIT_BAR_OUT_OF_RANGE',
  EVENT_OUT_OF_RANGE: 'E_EDIT_EVENT_OUT_OF_RANGE',
  SECTION_NAME_EMPTY: 'E_EDIT_SECTION_NAME_EMPTY',
  SECTION_NAME_TOO_LONG: 'E_EDIT_SECTION_NAME_TOO_LONG',
  SECTION_REPEAT_INVALID: 'E_EDIT_SECTION_REPEAT_INVALID',
  SECTION_CUE_TOO_LONG: 'E_EDIT_SECTION_CUE_TOO_LONG',
  LAST_SECTION: 'E_EDIT_LAST_SECTION',
  LAST_BAR: 'E_EDIT_LAST_BAR',
  LAST_EVENT: 'E_EDIT_LAST_EVENT',
  MOVE_EDGE: 'E_EDIT_MOVE_EDGE',
  BAR_NOT_EMPTY: 'E_EDIT_BAR_NOT_EMPTY',
  EVENT_KIND_UNKNOWN: 'E_EDIT_EVENT_KIND_UNKNOWN',
  BEATS_INVALID: 'E_EDIT_BEATS_INVALID',
  CHORD_INVALID: 'E_EDIT_CHORD_INVALID',
  TITLE_EMPTY: 'E_EDIT_TITLE_EMPTY',
  TEXT_TOO_LONG: 'E_EDIT_TEXT_TOO_LONG',
  BPM_INVALID: 'E_EDIT_BPM_INVALID',
  TIME_SIGNATURE_UNSUPPORTED: 'E_EDIT_TIME_SIGNATURE_UNSUPPORTED',
  KEY_INVALID: 'E_EDIT_KEY_INVALID',
  MODE_UNSUPPORTED: 'E_EDIT_MODE_UNSUPPORTED',
  LAYOUT_INVALID: 'E_EDIT_LAYOUT_INVALID',
  DISPLAY_MODE_INVALID: 'E_EDIT_DISPLAY_MODE_INVALID',
  TEXT_BLOCK_NOT_FOUND: 'E_EDIT_TEXT_BLOCK_NOT_FOUND',
});

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 成功：把新对象刷上 `updatedAt` 再返回。 */
function ok(song) {
  return { ok: true, value: { ...song, updatedAt: nowIso() } };
}

/** 失败。 */
function fail(code, message) {
  return { ok: false, value: null, code, message };
}

/**
 * 按 ID 找段落。
 * @returns {{index: number, section: import('./song.js').Section, error?: undefined}
 *   | {index?: undefined, section?: undefined, error: EditResult}}
 */
function locateSection(song, sectionId) {
  const index = (song.sections ?? []).findIndex((section) => section.id === sectionId);
  if (index < 0) {
    return {
      error: fail(
        EDIT_CODES.SECTION_NOT_FOUND,
        `找不到段落 ${JSON.stringify(sectionId)}，它可能已经被删除了。请刷新歌曲后重试。`,
      ),
    };
  }
  return { index, section: song.sections[index] };
}

/**
 * 按「段落 ID + 小节序号」找小节。
 * @returns {{sectionIndex: number, section: Object, bar: Object, error?: undefined} | {error: EditResult}}
 */
function locateBar(song, sectionId, barIndex) {
  const located = locateSection(song, sectionId);
  if (located.error) return located;
  const { index: sectionIndex, section } = located;
  if (!Number.isInteger(barIndex) || barIndex < 0 || barIndex >= section.bars.length) {
    return {
      error: fail(
        EDIT_CODES.BAR_OUT_OF_RANGE,
        `[${section.name}] 里没有第 ${barIndex + 1} 个小节（它现在有 ${section.bars.length} 个小节）。`,
      ),
    };
  }
  return { sectionIndex, section, bar: section.bars[barIndex] };
}

/** 换掉一个段落，返回新歌曲。 */
function withSection(song, sectionIndex, nextSection) {
  const sections = song.sections.slice();
  sections[sectionIndex] = nextSection;
  return ok({ ...song, sections });
}

/** 换掉段落里的一个小节，返回新歌曲。 */
function withBar(song, sectionIndex, section, barIndex, nextBar) {
  const bars = section.bars.slice();
  bars[barIndex] = nextBar;
  return withSection(song, sectionIndex, { ...section, bars });
}

/** 深拷贝一个小节并换掉它和它内部所有事件的 ID。 */
export function cloneBarWithNewIds(bar) {
  if (bar.type === 'empty') {
    const clone = { id: createId('bar'), type: 'empty', events: [], ...barAnnotations(bar) };
    if (Array.isArray(bar.melody)) clone.melody = bar.melody.map((note) => ({ ...note }));
    if (bar.length !== undefined) clone.length = bar.length;
    // 空白小节也能有文字块（§8.10），复制时一并带过去、换新 ID。
    if (Array.isArray(bar.textBlocks)) {
      clone.textBlocks = bar.textBlocks.map((block) => ({
        id: createId('textBlock'),
        text: block.text,
        x: block.x,
        y: block.y,
        anchor: block.anchor,
      }));
    }
    return clone;
  }
  const clone = { id: createId('bar'), type: 'chords', events: bar.events.map(cloneEventWithNewIds), ...barAnnotations(bar) };
  if (Array.isArray(bar.melody)) clone.melody = bar.melody.map((note) => ({ ...note }));
  if (bar.length !== undefined) clone.length = bar.length;
  // 歌词对齐事件，复制小节时一起带过去（逐字对齐，SPEC §8.9）。
  if (Array.isArray(bar.lyrics)) {
    clone.lyrics = bar.lyrics.map((fragment) => (fragment ? { text: fragment.text } : null));
  }
  // 文字块同理（§8.10），换新 ID、保留坐标与锚点。
  if (Array.isArray(bar.textBlocks)) {
    clone.textBlocks = bar.textBlocks.map((block) => ({
      id: createId('textBlock'),
      text: block.text,
      x: block.x,
      y: block.y,
      anchor: block.anchor,
    }));
  }
  return clone;
}

/** 深拷贝一个事件并换上新的 ID。 */
export function cloneEventWithNewIds(event) {
  if (event.kind === 'rest') return { kind: 'rest', id: createId('event'), beats: event.beats };
  return {
    kind: 'chord',
    id: createId('event'),
    beats: event.beats,
    chord: { root: event.chord.root, quality: event.chord.quality, bass: event.chord.bass ?? null },
  };
}

/**
 * 根据输入构造一个新事件（带新 ID）。
 *
 * @param {{kind?: 'chord'|'rest', beats: number, chord?: {root: string, quality?: string, bass?: string|null}}} input
 * @returns {{ok: true, event: import('./song.js').SongEvent} | {ok: false, value: null, message: string, code: string}}
 */
function buildEvent(input) {
  const kind = input?.kind ?? 'chord';
  if (kind !== 'chord' && kind !== 'rest') {
    return fail(EDIT_CODES.EVENT_KIND_UNKNOWN, `未知事件类型 ${JSON.stringify(kind)}，只能是 chord 或 rest。`);
  }

  const beatsChecked = checkBeatsValue(Number(input?.beats));
  if (!beatsChecked.ok) return fail(EDIT_CODES.BEATS_INVALID, beatsChecked.message);
  const beats = Number(input.beats);

  if (kind === 'rest') {
    return { ok: true, event: { kind: 'rest', id: createId('event'), beats } };
  }

  const chord = createChord(input?.chord ?? {});
  if (!chord.ok) return fail(EDIT_CODES.CHORD_INVALID, chord.message);
  return { ok: true, event: { kind: 'chord', id: createId('event'), beats, chord: chord.value } };
}

/** 校验文本字段的长度 / 非空。 */
function checkText(value, maxLength, code, label, { required = false } = {}) {
  if (typeof value !== 'string') return fail(code, `${label}必须是文本`);
  if (required && value.trim() === '') return fail(code, `${label}不能为空`);
  if (value.length > maxLength) {
    return fail(code, `${label}长度超过上限 ${maxLength} 个字符（当前 ${value.length}）`);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 歌曲信息
 * ------------------------------------------------------------------ */

/**
 * 更新歌曲的元信息。只处理传入的字段，未传的保持原样。
 *
 * @param {import('./song.js').Song} song
 * @param {{title?: string, artist?: string, notes?: string, style?: string, bpm?: number,
 *   key?: {tonic?: string, mode?: string},
 *   layout?: {barsPerRow?: number, displayLines?: string[], dimSuffix?: string,
 *     chordSymbols?: string, accidentalGlyphs?: string, seventhSuffix?: string,
 *     restText?: string, fontScale?: number}}} patch
 * @returns {EditResult}
 */
export function updateSongMeta(song, patch = {}) {
  const next = { ...song };

  if (patch.title !== undefined) {
    const checked = checkText(patch.title, LIMITS.titleMaxLength, EDIT_CODES.TITLE_EMPTY, '标题', { required: !song.unsetMeta });
    if (!checked.ok) return checked;
    next.title = patch.title;
  }
  for (const [field, maxLength, label] of [
    ['artist', LIMITS.artistMaxLength, '艺人'],
    ['notes', LIMITS.notesMaxLength, '备注'],
    ['style', LIMITS.styleMaxLength, '风格 / 预设'],
  ]) {
    if (patch[field] !== undefined) {
      const checked = checkText(patch[field], maxLength, EDIT_CODES.TEXT_TOO_LONG, label);
      if (!checked.ok) return checked;
      next[field] = patch[field];
    }
  }

  if (patch.bpm !== undefined) {
    if (!Number.isInteger(patch.bpm) || patch.bpm < LIMITS.bpmMin || patch.bpm > LIMITS.bpmMax) {
      return fail(
        EDIT_CODES.BPM_INVALID,
        `BPM 必须是 ${LIMITS.bpmMin}–${LIMITS.bpmMax} 之间的整数，收到 ${JSON.stringify(patch.bpm)}`,
      );
    }
    next.bpm = patch.bpm;
  }

  if (patch.key !== undefined) {
    const tonicText = String(patch.key?.tonic ?? '').trim();
    // 借用 createChord 来校验音名，根音部分的校验规则和调号主音完全一致。
    const tonicParsed = createChord({ root: tonicText, quality: 'maj' });
    if (!tonicParsed.ok) return fail(EDIT_CODES.KEY_INVALID, `调号主音无效：${tonicParsed.message}`);

    const mode = patch.key?.mode ?? next.key?.mode ?? 'major';
    if (!['major', 'minor'].includes(mode)) {
      return fail(
        EDIT_CODES.MODE_UNSUPPORTED,
        `请选择大调或小调，收到 ${JSON.stringify(mode)}。`,
      );
    }
    next.key = { tonic: tonicParsed.value.root, mode };
  }

  if (patch.layout !== undefined) {
    const layout = { ...next.layout };
    if (patch.layout.barsPerRow !== undefined) {
      if (!BARS_PER_ROW_OPTIONS.includes(patch.layout.barsPerRow)) {
        return fail(
          EDIT_CODES.LAYOUT_INVALID,
          `每行小节数只能是 ${BARS_PER_ROW_OPTIONS.join(' / ')}，收到 ${JSON.stringify(patch.layout.barsPerRow)}`,
        );
      }
      layout.barsPerRow = patch.layout.barsPerRow;
    }
    if (patch.layout.displayLines !== undefined) {
      if (!isDisplayLinesValid(patch.layout.displayLines)) {
        return fail(
          EDIT_CODES.DISPLAY_MODE_INVALID,
          `显示行必须是 1–${MAX_DISPLAY_LINES} 项且不重复，取值只能是 ${DISPLAY_LINE_IDS.join(' / ')}，收到 ${JSON.stringify(patch.layout.displayLines)}`,
        );
      }
      // 顺序固定（SPEC §8.1.1）：不跟随调用方传进来的排列，统一按 chord → degree → roman 落库
      layout.displayLines = normalizeDisplayLines(patch.layout.displayLines);
    }
    if (patch.layout.dimSuffix !== undefined) {
      if (!isDimSuffixValid(patch.layout.dimSuffix)) {
        return fail(
          EDIT_CODES.LAYOUT_INVALID,
          `减三和弦后缀只能是 ${DIM_SUFFIX_STYLES.join(' / ')}，收到 ${JSON.stringify(patch.layout.dimSuffix)}`,
        );
      }
      // 这里**不做 normalize** —— 写进来的值已经严格校验过，直接落库。
      // normalize 是给「读进来的不可信数据」用的，不是给写入路径用的：
      // 在写入路径上容错，等于把用户拼错的值悄悄改成别的，然后告诉他保存成功。
      layout.dimSuffix = patch.layout.dimSuffix;
    }
    // 后加的四组风格字段规则完全一样，共用一张表：**写严格、不 normalize**。
    //
    // 与读取路径（`song.createSong` 的 `normalizeXxx`、渲染关口的容错）刚好相反 ——
    // 这不是不一致，是分工：读进来的是不可信数据，值得容错保住整首歌；
    // 写进来的是界面刚给的值，容错只会把缺陷藏起来。
    // 「什么算合法」由 constants.js 的 `isXxxValid` 定义，这里不重写一遍。
    const styleFields = [
      { field: 'chordSymbols', styles: CHORD_SYMBOL_STYLES, label: '和弦性质符号体系', isValid: isChordSymbolsValid },
      { field: 'accidentalGlyphs', styles: ACCIDENTAL_GLYPH_STYLES, label: '升降号字形', isValid: isAccidentalGlyphsValid },
      { field: 'seventhSuffix', styles: SEVENTH_SUFFIX_STYLES, label: '属七后缀位置', isValid: isSeventhSuffixValid },
      { field: 'restText', styles: REST_TEXT_STYLES, label: '休止符写法', isValid: isRestTextValid },
    ];
    for (const { field, styles, label, isValid } of styleFields) {
      const value = patch.layout[field];
      // `undefined` 的意思是「这一项不改」，不是「设成 undefined」——
      // 一个 patch 里只带一个字段时，其余字段必须原样保留。
      if (value === undefined) continue;
      if (!isValid(value)) {
        return fail(
          EDIT_CODES.LAYOUT_INVALID,
          `${label}只能是 ${styles.join(' / ')}，收到 ${JSON.stringify(value)}`,
        );
      }
      layout[field] = value;
    }
    if (patch.layout.fontScale !== undefined) {
      const scale = Number(patch.layout.fontScale);
      if (!Number.isFinite(scale) || scale < LIMITS.fontScaleMin || scale > LIMITS.fontScaleMax) {
        return fail(
          EDIT_CODES.LAYOUT_INVALID,
          `字号缩放必须在 ${LIMITS.fontScaleMin}–${LIMITS.fontScaleMax} 之间，收到 ${JSON.stringify(patch.layout.fontScale)}`,
        );
      }
      layout.fontScale = scale;
    }
    if (patch.layout.textBlockMode !== undefined) {
      if (!isTextBlockModeValid(patch.layout.textBlockMode)) {
        return fail(
          EDIT_CODES.LAYOUT_INVALID,
          `文字块粒度只能是 ${['bar', 'chord'].join(' / ')}，收到 ${JSON.stringify(patch.layout.textBlockMode)}`,
        );
      }
      layout.textBlockMode = patch.layout.textBlockMode;
    }
    for (const prop of ['lyricScale', 'chordScale']) {
      if (patch.layout[prop] === undefined) continue;
      const value = Number(patch.layout[prop]);
      if (!Number.isFinite(value) || value < 0.6 || value > 2) return fail(EDIT_CODES.LAYOUT_INVALID, '字号比例应为 0.6–2');
      layout[prop] = value;
    }
    if (patch.layout.showMelody !== undefined) {
      if (typeof patch.layout.showMelody !== 'boolean') return fail(EDIT_CODES.LAYOUT_INVALID, '简谱显示需要一个开关值');
      layout.showMelody = patch.layout.showMelody;
    }
    for (const prop of ['showLyrics','showMeta','showCues','showBarNumbers','compact']) {
      if (patch.layout[prop] === undefined) continue;
      if (typeof patch.layout[prop] !== 'boolean') return fail(EDIT_CODES.LAYOUT_INVALID, '显示选项应为布尔值');
      layout[prop] = patch.layout[prop];
    }
    if (patch.layout.numberedKey !== undefined) {
      if (!parsePitchName(patch.layout.numberedKey).ok) return fail(EDIT_CODES.LAYOUT_INVALID, '简谱调号无效');
      layout.numberedKey = patch.layout.numberedKey;
    }
    next.layout = layout;
  }

  if (patch.capo !== undefined) {
    if (!Number.isInteger(patch.capo) || patch.capo < 0 || patch.capo > 12) return fail(EDIT_CODES.LAYOUT_INVALID, '变调夹应为 0–12 品');
    next.capo = patch.capo;
  }

  if (song.unsetMeta) next.unsetMeta = song.unsetMeta.filter((field) => patch[field] === undefined || (field === 'title' && !patch.title.trim()));
  if (song.unsetMeta && patch.title !== undefined && !patch.title.trim()) next.unsetMeta = [...new Set([...next.unsetMeta, 'title'])];

  return ok(next);
}

/**
 * 修改拍号。
 *
 * **只改拍号，不重算任何时值**（SPEC §3.5）。改完之后请调用
 * core/duration.js 的 `collectDurationIssues()`，把欠拍 / 超拍的小节列给用户，
 * 由用户决定怎么改——自动把 4 拍压成 3 拍等于替用户改音乐。
 *
 * @param {import('./song.js').Song} song
 * @param {string} timeSignature
 * @returns {EditResult}
 */
export function setTimeSignature(song, timeSignature) {
  if (!TIME_SIGNATURE_IDS.includes(timeSignature)) {
    return fail(
      EDIT_CODES.TIME_SIGNATURE_UNSUPPORTED,
      `不支持的拍号 ${JSON.stringify(timeSignature)}。本版支持：${TIME_SIGNATURE_IDS.join(' / ')}`,
    );
  }
  return ok({ ...song, timeSignature, ...(song.unsetMeta ? { unsetMeta: song.unsetMeta.filter((field) => field !== 'timeSignature') } : {}) });
}

/* ------------------------------------------------------------------ *
 * 段落
 * ------------------------------------------------------------------ */

/**
 * 在指定位置插入一个新段落。新段落默认带一个空白小节，用户可以立刻往里写和弦。
 *
 * @param {import('./song.js').Song} song
 * @param {{name?: string, atIndex?: number, bars?: import('./song.js').Bar[]}} [input]
 * @returns {EditResult}
 */
export function addSection(song, input = {}) {
  const name = String(input.name ?? '新段落').trim();
  const checked = checkText(name, LIMITS.sectionNameMaxLength, EDIT_CODES.SECTION_NAME_TOO_LONG, '段落名', {
    required: true,
  });
  if (!checked.ok) return checked;

  const atIndex = input.atIndex ?? song.sections.length;
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > song.sections.length) {
    return fail(
      EDIT_CODES.SECTION_INDEX_INVALID,
      `插入位置 ${JSON.stringify(atIndex)} 超出范围（0–${song.sections.length}）。`,
    );
  }

  const bars = input.bars
    ? input.bars.map(cloneBarWithNewIds)
    : [{ id: createId('bar'), type: 'empty', events: [] }];

  const sections = song.sections.slice();
  sections.splice(atIndex, 0, { id: createId('section'), name, repeat: 1, cue: '', bars });
  return ok({ ...song, sections });
}

/**
 * 重命名段落。允许改成与其它段落同名（同名段落合法，也很常见，见 SPEC §4.4）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {string} name
 * @returns {EditResult}
 */
export function renameSection(song, sectionId, name) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;

  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return fail(EDIT_CODES.SECTION_NAME_EMPTY, '段落名不能为空');
  const checked = checkText(trimmed, LIMITS.sectionNameMaxLength, EDIT_CODES.SECTION_NAME_TOO_LONG, '段落名');
  if (!checked.ok) return checked;

  return withSection(song, located.index, { ...located.section, name: trimmed });
}

/**
 * 复制段落，插在被复制段落的后面。段落本身、它的小节和事件都会拿到新 ID。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @returns {EditResult}
 */
export function duplicateSection(song, sectionId) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;

  const source = located.section;
  const sections = song.sections.slice();
  sections.splice(located.index + 1, 0, {
    id: createId('section'),
    name: source.name,
    repeat: source.repeat,
    cue: source.cue,
    bars: source.bars.map(cloneBarWithNewIds),
  });
  return ok({ ...song, sections });
}

/**
 * 删除段落。歌曲至少要留一个段落。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @returns {EditResult}
 */
export function removeSection(song, sectionId) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;
  if (song.sections.length <= 1) {
    return fail(EDIT_CODES.LAST_SECTION, '歌曲至少要保留一个段落。想清空内容，请把它改成只含一个小节的空白段落。');
  }
  const sections = song.sections.slice();
  sections.splice(located.index, 1);
  return ok({ ...song, sections });
}

/**
 * 上下移动段落。界面上「点按上移 / 下移」按钮走这条路（§9 要求排序不能只支持拖动）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {'up'|'down'} direction
 * @returns {EditResult}
 */
export function moveSection(song, sectionId, direction) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;

  const index = located.index;
  if (direction !== 'up' && direction !== 'down') {
    return fail(EDIT_CODES.MOVE_EDGE, `未知的移动方向 ${JSON.stringify(direction)}，只能是 up 或 down`);
  }
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0) return fail(EDIT_CODES.MOVE_EDGE, '这已经是第一个段落了');
  if (target >= song.sections.length) return fail(EDIT_CODES.MOVE_EDGE, '这已经是最后一个段落了');

  const sections = song.sections.slice();
  [sections[index], sections[target]] = [sections[target], sections[index]];
  return ok({ ...song, sections });
}

/**
 * 设置段落重复次数。这只是**演奏标注**，不会复制实际小节（SPEC §2.3 第 6 条）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} repeat
 * @returns {EditResult}
 */
export function setSectionRepeat(song, sectionId, repeat) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;
  if (!Number.isInteger(repeat) || repeat < LIMITS.sectionRepeatMin || repeat > LIMITS.sectionRepeatMax) {
    return fail(
      EDIT_CODES.SECTION_REPEAT_INVALID,
      `重复次数必须是 ${LIMITS.sectionRepeatMin}–${LIMITS.sectionRepeatMax} 的整数，收到 ${JSON.stringify(repeat)}`,
    );
  }
  return withSection(song, located.index, { ...located.section, repeat });
}

/**
 * 设置段落演奏提示。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {string} cue
 * @returns {EditResult}
 */
export function setSectionCue(song, sectionId, cue) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;
  const text = String(cue ?? '');
  const checked = checkText(text, LIMITS.sectionCueMaxLength, EDIT_CODES.SECTION_CUE_TOO_LONG, '演奏提示');
  if (!checked.ok) return checked;
  return withSection(song, located.index, { ...located.section, cue: text });
}

/* ------------------------------------------------------------------ *
 * 小节
 * ------------------------------------------------------------------ */

/** 造一个空白小节。 */
function makeEmptyBar() {
  return { id: createId('bar'), type: 'empty', events: [] };
}

/**
 * 在段落里插入一个小节。默认插入**空白小节**（不是休止，见 SPEC §2.4）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} atIndex 0 起；等于小节数时追加到末尾。
 * @param {import('./song.js').Bar} [bar] 想插入现成的小节时传入，会换新 ID。
 * @returns {EditResult}
 */
export function insertBar(song, sectionId, atIndex, bar) {
  const located = locateSection(song, sectionId);
  if (located.error) return located.error;

  const { section } = located;
  const index = atIndex ?? section.bars.length;
  if (!Number.isInteger(index) || index < 0 || index > section.bars.length) {
    return fail(
      EDIT_CODES.BAR_OUT_OF_RANGE,
      `插入位置 ${index} 超出范围（0–${section.bars.length}）。`,
    );
  }

  const bars = section.bars.slice();
  bars.splice(index, 0, bar ? cloneBarWithNewIds(bar) : makeEmptyBar());
  return withSection(song, located.index, { ...section, bars });
}

/**
 * 复制一个小节，插在它后面。新小节里的每个事件都会拿到新 ID。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @returns {EditResult}
 */
export function duplicateBar(song, sectionId, barIndex) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;

  const bars = located.section.bars.slice();
  const copy=cloneBarWithNewIds(located.bar);
  for(const prop of ['sourceNumber','repeatStart','repeatEnd','ending'])delete copy[prop];
  bars.splice(barIndex + 1, 0, copy);
  return withSection(song, located.sectionIndex, { ...located.section, bars });
}

/**
 * 删除小节。段落至少要留一个小节。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @returns {EditResult}
 */
export function removeBar(song, sectionId, barIndex) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  if (located.section.bars.length <= 1) {
    return fail(EDIT_CODES.LAST_BAR, '这一段至少要保留一个小节。想清空它，请把这一小节设为空白小节。');
  }
  const bars = located.section.bars.slice();
  bars.splice(barIndex, 1);
  return withSection(song, located.sectionIndex, { ...located.section, bars });
}

/**
 * 上下移动小节。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {'up'|'down'} direction
 * @returns {EditResult}
 */
export function moveBar(song, sectionId, barIndex, direction) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;

  if (direction !== 'up' && direction !== 'down') {
    return fail(EDIT_CODES.MOVE_EDGE, `未知的移动方向 ${JSON.stringify(direction)}，只能是 up 或 down`);
  }
  const target = direction === 'up' ? barIndex - 1 : barIndex + 1;
  if (target < 0) return fail(EDIT_CODES.MOVE_EDGE, '这已经是第一个小节了');
  if (target >= located.section.bars.length) return fail(EDIT_CODES.MOVE_EDGE, '这已经是最后一个小节了');

  const bars = located.section.bars.slice();
  [bars[barIndex], bars[target]] = [bars[target], bars[barIndex]];
  return withSection(song, located.sectionIndex, { ...located.section, bars });
}

/**
 * 把一个小节设为空白 / 取消空白。
 *
 * **设为空白会丢掉小节里的事件**，所以对一个有内容的小节调用时必须显式传
 * `{discardEvents: true}`。这不是形式主义：空白小节和休止是两种不同的音乐含义
 * （SPEC §2.4），一次误触就把和弦清空、而且从谱面上看不出来，代价太大。
 * 界面上应该先弹一次确认，再把 `discardEvents` 传进来。
 *
 * **取消空白**会往小节里放一个**占满整小节的休止**。为什么不给一个「零事件」的
 * 小节？因为「chords 类型但没有任何事件」按 SPEC §3.3 是非法的——那会让这首歌
 * 从一改完就处于「导出前必须处理」的状态。放一个休止既立刻合法，含义也明确
 * （这一小节不发声），用户点掉它再放和弦即可。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {boolean} isEmpty
 * @param {{discardEvents?: boolean}} [options]
 * @returns {EditResult}
 */
export function setBarEmpty(song, sectionId, barIndex, isEmpty, options = {}) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  if (isEmpty) {
    if (bar.type === 'empty') return ok({ ...song }); // 已经是空白，幂等
    if (bar.events.length > 0 && !options.discardEvents) {
      return fail(
        EDIT_CODES.BAR_NOT_EMPTY,
        `这一小节里有 ${bar.events.length} 个事件，设为空白会把它们全部删掉。确认要清空的话，请再操作一次并带上 discardEvents。`,
      );
    }
    // 设为空白：事件清空，歌词也一并清空（歌词对齐的是事件，事件没了歌词无处安放）。
    // 文字块**保留**（§8.10：空白小节也能写文字），但 anchor 指向的和弦没了，全部降级为小节级（-1）。
    const nextBar = { id: bar.id, type: 'empty', events: [] };
    if (Array.isArray(bar.textBlocks) && bar.textBlocks.length > 0) {
      nextBar.textBlocks = bar.textBlocks.map((block) => ({ ...block, anchor: -1 }));
    }
    return withBar(song, sectionIndex, section, barIndex, nextBar);
  }

  if (bar.type === 'chords') return ok({ ...song }); // 已经是普通小节，幂等
  const beatsPerBar = getBeatsPerBar(song.timeSignature);
  return withBar(song, sectionIndex, section, barIndex, {
    id: bar.id,
    type: 'chords',
    events: [{ kind: 'rest', id: createId('event'), beats: beatsPerBar }],
    // 取消空白只填一个休止，不附带歌词（新填的休止没有词）。
  });
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

/**
 * 在小节末尾添加一个事件。往空白小节里添加事件会自动把它变成普通小节。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {{kind?: 'chord'|'rest', beats: number, chord?: {root: string, quality?: string, bass?: string|null}}} input
 * @returns {EditResult}
 */
export function addEvent(song, sectionId, barIndex, input) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;

  const built = buildEvent(input);
  if (!built.ok) return built;

  const { bar, section, sectionIndex } = located;
  const events = bar.type === 'empty' ? [built.event] : [...bar.events, built.event];
  return withBar(song, sectionIndex, section, barIndex, { id: bar.id, type: 'chords', events });
}

/**
 * 修改一个事件。传入哪些字段就改哪些，`id` 保持不变（撤销重做依赖 ID 稳定）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @param {{kind?: 'chord'|'rest', beats?: number, chord?: {root: string, quality?: string, bass?: string|null}}} patch
 * @returns {EditResult}
 */
export function updateEvent(song, sectionId, barIndex, eventIndex, patch = {}) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  if (bar.type === 'empty') {
    return fail(
      EDIT_CODES.EVENT_OUT_OF_RANGE,
      '这是一个空白小节，里面没有事件可以改。想写和弦请直接添加事件，或先取消空白。',
    );
  }
  const current = bar.events[eventIndex];
  if (!current) {
    return fail(
      EDIT_CODES.EVENT_OUT_OF_RANGE,
      `这一小节只有 ${bar.events.length} 个事件，没有第 ${eventIndex + 1} 个。`,
    );
  }

  const nextKind = patch.kind ?? current.kind;
  if (nextKind !== 'chord' && nextKind !== 'rest') {
    return fail(EDIT_CODES.EVENT_KIND_UNKNOWN, `未知事件类型 ${JSON.stringify(nextKind)}，只能是 chord 或 rest。`);
  }

  const nextBeats = patch.beats !== undefined ? Number(patch.beats) : current.beats;
  const beatsChecked = checkBeatsValue(nextBeats);
  if (!beatsChecked.ok) return fail(EDIT_CODES.BEATS_INVALID, beatsChecked.message);

  let nextEvent;
  if (nextKind === 'rest') {
    nextEvent = { kind: 'rest', id: current.id, beats: nextBeats };
  } else {
    // 从休止改成和弦时没有现成和弦可继承，给一个 C 大三和弦作为起点；
    // 界面上的「改成和弦」按钮会同时把用户选的和弦传进来，走不到这个分支。
    const source = patch.chord ?? (current.kind === 'chord' ? current.chord : { root: 'C', quality: 'maj', bass: null });
    const chord = createChord(source);
    if (!chord.ok) return fail(EDIT_CODES.CHORD_INVALID, chord.message);
    nextEvent = { kind: 'chord', id: current.id, beats: nextBeats, chord: chord.value };
  }

  const events = bar.events.slice();
  events[eventIndex] = nextEvent;
  return withBar(song, sectionIndex, section, barIndex, { ...bar, events });
}

/**
 * 只改时值。
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @param {number} beats
 * @returns {EditResult}
 */
export function setEventBeats(song, sectionId, barIndex, eventIndex, beats) {
  return updateEvent(song, sectionId, barIndex, eventIndex, { beats });
}

/**
 * 只改斜杠低音。传 `null` 或空串表示去掉斜杠低音。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @param {?string} bass
 * @returns {EditResult}
 */
export function setEventBass(song, sectionId, barIndex, eventIndex, bass) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const current = located.bar.events?.[eventIndex];
  if (!current || current.kind !== 'chord') {
    return fail(EDIT_CODES.EVENT_OUT_OF_RANGE, '这一位置不是和弦事件，没有斜杠低音可改。');
  }
  const normalized = bass === null || bass === undefined || String(bass).trim() === '' ? null : String(bass).trim();
  return updateEvent(song, sectionId, barIndex, eventIndex, {
    chord: { root: current.chord.root, quality: current.chord.quality, bass: normalized },
  });
}

/**
 * 设置某个事件下方的歌词片段（逐字对齐，SPEC §8.9）。
 *
 * 歌词对齐事件：`bar.lyrics[eventIndex]` 对应 `bar.events[eventIndex]`。传空串或 null
 * 表示清掉这一处的歌词。歌词是可缺省字段——整小节清空后字段会被整个移除，
 * 不会留一个全空数组，这样「有没有歌词」始终可判定。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @param {?string} text
 * @returns {EditResult}
 */
export function setEventLyric(song, sectionId, barIndex, eventIndex, text) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  if (bar.type === 'empty') {
    return fail(EDIT_CODES.EVENT_OUT_OF_RANGE, '这是一个空白小节，没有事件，也就没有可以对齐的歌词位置。');
  }
  if (!bar.events[eventIndex]) {
    return fail(
      EDIT_CODES.EVENT_OUT_OF_RANGE,
      `这一小节只有 ${bar.events.length} 个事件，没有第 ${eventIndex + 1} 个可以挂歌词。`,
    );
  }

  const value = text === null || text === undefined ? '' : String(text);
  if (value.length > LIMITS.lyricMaxLength) {
    return fail(EDIT_CODES.TEXT_TOO_LONG, `歌词长度超过上限 ${LIMITS.lyricMaxLength} 个字符（当前 ${value.length}）`);
  }

  // 拷贝一份对齐到 events 长度的歌词数组，改掉目标下标。
  const lyrics = Array.from({ length: bar.events.length }, (_, index) => {
    const existing = bar.lyrics?.[index];
    return existing ? { text: existing.text } : null;
  });
  lyrics[eventIndex] = value.trim() === '' ? null : { text: value };

  // 全空就整个字段去掉（可缺省），否则写回。干净地决定「有没有 lyrics 键」。
  const hasAny = lyrics.some((fragment) => fragment && fragment.text !== '');
  const nextBar = { ...bar };
  if ((bar.lyrics?.[eventIndex]?.text ?? '') !== value && (bar.alignment || bar.melody?.length)) {
    const alignment=structuredClone(bar.alignment??defaultAlignment(bar,song));
    const total=bar.length??getBeatsPerBar(song.timeSignature);
    const start=bar.events.slice(0,eventIndex).reduce((sum,event)=>sum+event.beats,0),end=start+bar.events[eventIndex].beats;
    let cursor=0;const noteTimes=(bar.melody??[]).map((note)=>{const at=cursor;cursor+=note.beats;return at;});
    alignment.words=alignment.words.filter((word)=>{const at=word.noteIndex===null?word.x*total:noteTimes[word.noteIndex];return at<start||at>=end;});
    const letters=splitWords(value);
    alignment.words.push(...letters.map((text,i)=>({text,noteIndex:null,x:(start+(i+.5)*(end-start)/letters.length)/total,y:.5,scale:1})));
    nextBar.alignment=alignment;
    if(bar.melody)nextBar.melody=bar.melody.map((note,i)=>({...note,lyric:alignment.words.filter((word)=>word.noteIndex===i).map((word)=>word.text).join('')}));
  }
  if (hasAny) {
    nextBar.lyrics = lyrics;
  } else {
    delete nextBar.lyrics;
  }

  return withBar(song, sectionIndex, section, barIndex, nextBar);
}

/**
 * 删除一个事件。
 *
 * **拒绝删掉小节里唯一的事件**：那会得到「chords 类型但没有任何事件」的小节，
 * 按 §3.3 是非法的，而且和「空白小节」是两种不同的含义（§2.4）。
 * 想留白应该走 `setBarEmpty`，让用户在明确知道含义变化的前提下操作。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @returns {EditResult}
 */
export function removeEvent(song, sectionId, barIndex, eventIndex) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  if (bar.type === 'empty') {
    return fail(EDIT_CODES.EVENT_OUT_OF_RANGE, '这是一个空白小节，里面没有事件。');
  }
  if (!bar.events[eventIndex]) {
    return fail(EDIT_CODES.EVENT_OUT_OF_RANGE, `这一小节只有 ${bar.events.length} 个事件，没有第 ${eventIndex + 1} 个。`);
  }
  if (bar.events.length <= 1) {
    return fail(
      EDIT_CODES.LAST_EVENT,
      '这是这一小节唯一的事件，删掉之后小节就没有内容了。如果想留白，请把这一小节设为空白小节（这两者的音乐含义不同）。',
    );
  }

  const events = bar.events.slice();
  events.splice(eventIndex, 1);

  // 文字块跟随调整（§8.10）：删掉 events[eventIndex] 后，绑定到它的块降级为小节级（-1），
  // 绑定到它后面和弦的块 anchor 前移一位，避免文字块「挂在已经消失的和弦上」。
  const nextBar = { ...bar, events };
  if (Array.isArray(bar.textBlocks) && bar.textBlocks.length > 0) {
    nextBar.textBlocks = bar.textBlocks.map((block) => {
      if (block.anchor === eventIndex) return { ...block, anchor: -1 };
      if (block.anchor > eventIndex) return { ...block, anchor: block.anchor - 1 };
      return block;
    });
  }
  return withBar(song, sectionIndex, section, barIndex, nextBar);
}

/**
 * 在小节内左右移动一个事件。和弦顺序会改变演奏顺序，所以这个操作有意义。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {number} eventIndex
 * @param {'up'|'down'} direction up = 前移，down = 后移（沿用段落 / 小节的按钮语义）
 * @returns {EditResult}
 */
export function moveEvent(song, sectionId, barIndex, eventIndex, direction) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  if (bar.type === 'empty' || !bar.events[eventIndex]) {
    return fail(EDIT_CODES.EVENT_OUT_OF_RANGE, '这一位置没有事件可以移动。');
  }
  if (direction !== 'up' && direction !== 'down') {
    return fail(EDIT_CODES.MOVE_EDGE, `未知的移动方向 ${JSON.stringify(direction)}，只能是 up 或 down`);
  }
  const target = direction === 'up' ? eventIndex - 1 : eventIndex + 1;
  if (target < 0) return fail(EDIT_CODES.MOVE_EDGE, '这已经是小节里第一个事件了');
  if (target >= bar.events.length) return fail(EDIT_CODES.MOVE_EDGE, '这已经是小节里最后一个事件了');

  const events = bar.events.slice();
  [events[eventIndex], events[target]] = [events[target], events[eventIndex]];

  // 文字块跟随调整（§8.10）：交换两个和弦后，绑定到这两个下标的块要交换 anchor，
  // 否则文字块会「留在原地」而它绑定的和弦已经换走了。
  const nextBar = { ...bar, events };
  if (Array.isArray(bar.textBlocks) && bar.textBlocks.length > 0) {
    nextBar.textBlocks = bar.textBlocks.map((block) => {
      if (block.anchor === eventIndex) return { ...block, anchor: target };
      if (block.anchor === target) return { ...block, anchor: eventIndex };
      return block;
    });
  }
  return withBar(song, sectionIndex, section, barIndex, nextBar);
}

/* ------------------------------------------------------------------ *
 * 整首歌
 * ------------------------------------------------------------------ */

/**
 * 复制整首歌：所有 ID 重新生成，标题加「（副本）」后缀。
 *
 * @param {import('./song.js').Song} song
 * @returns {import('./song.js').Song}
 */
export function duplicateSong(song) {
  const timestamp = nowIso();
  return {
    ...song,
    id: createId('song'),
    createdAt: timestamp,
    updatedAt: timestamp,
    title: `${song.title}（副本）`,
    ...(song.unsetMeta ? { unsetMeta: song.unsetMeta.filter((field) => field !== 'title') } : {}),
    ...(song.chordDiagrams ? { chordDiagrams: song.chordDiagrams.map((item) => ({ ...item, chord: { ...item.chord } })) } : {}),
    key: { ...song.key },
    layout: { ...song.layout },
    sections: song.sections.map((section) => ({
      id: createId('section'),
      name: section.name,
      repeat: section.repeat,
      cue: section.cue,
      bars: section.bars.map(cloneBarWithNewIds),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 自由文字块（SPEC §8.10）
 * ------------------------------------------------------------------ */

/** 定位一个小节里的某个文字块。 */
function locateTextBlock(bar, textBlockId) {
  const blocks = Array.isArray(bar.textBlocks) ? bar.textBlocks : [];
  const index = blocks.findIndex((block) => block.id === textBlockId);
  if (index < 0) return { error: fail(EDIT_CODES.TEXT_BLOCK_NOT_FOUND, `找不到文字块 ${JSON.stringify(textBlockId)}，它可能刚被删除了。`) };
  return { index, block: blocks[index] };
}

/**
 * 在小节里新增一个自由文字块（SPEC §8.10）。
 *
 * `x` / `y` 是 0–1 比例坐标；`anchor` 决定绑定到哪个和弦（-1 = 小节级）。
 * 空串文字会被拒绝——空块不是真数据，不落盘。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {{text: string, x: number, y: number, anchor?: number}} input
 * @returns {EditResult}
 */
export function addTextBlock(song, sectionId, barIndex, input = {}) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;

  const text = String(input.text ?? '');
  if (text.trim() === '') return fail(EDIT_CODES.TEXT_TOO_LONG, '文字块不能为空。');
  if (text.length > LIMITS.textBlockMaxLength) {
    return fail(EDIT_CODES.TEXT_TOO_LONG, `文字块长度超过上限 ${LIMITS.textBlockMaxLength} 个字符（当前 ${text.length}）`);
  }
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || x < 0 || x > 1) return fail(EDIT_CODES.LAYOUT_INVALID, `水平坐标必须是 0–1，收到 ${JSON.stringify(input.x)}`);
  if (!Number.isFinite(y) || y < 0 || y > 1) return fail(EDIT_CODES.LAYOUT_INVALID, `垂直坐标必须是 0–1，收到 ${JSON.stringify(input.y)}`);
  const anchor = Number.isInteger(Number(input.anchor)) ? Number(input.anchor) : -1;
  if (anchor < -1 || anchor >= bar.events.length) {
    return fail(EDIT_CODES.LAYOUT_INVALID, `锚点必须是 -1 或有效的和弦下标，收到 ${JSON.stringify(input.anchor)}`);
  }

  const blocks = Array.isArray(bar.textBlocks) ? bar.textBlocks.slice() : [];
  blocks.push({ id: createId('textBlock'), text, x, y, anchor });
  return withBar(song, sectionIndex, section, barIndex, { ...bar, textBlocks: blocks });
}

/**
 * 改一个文字块的文字内容。空串表示删除该块（空块不落盘）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {string} textBlockId
 * @param {string} text
 * @returns {EditResult}
 */
export function setTextBlockText(song, sectionId, barIndex, textBlockId, text) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;
  const found = locateTextBlock(bar, textBlockId);
  if (found.error) return found.error;

  const value = String(text ?? '');
  if (value.trim() === '') {
    // 空串 = 删除该块（空块不是真数据）。
    const blocks = bar.textBlocks.filter((block) => block.id !== textBlockId);
    const nextBar = { ...bar };
    if (blocks.length > 0) nextBar.textBlocks = blocks;
    else delete nextBar.textBlocks;
    return withBar(song, sectionIndex, section, barIndex, nextBar);
  }
  if (value.length > LIMITS.textBlockMaxLength) {
    return fail(EDIT_CODES.TEXT_TOO_LONG, `文字块长度超过上限 ${LIMITS.textBlockMaxLength} 个字符（当前 ${value.length}）`);
  }
  const blocks = bar.textBlocks.map((block) => (block.id === textBlockId ? { ...block, text: value } : block));
  return withBar(song, sectionIndex, section, barIndex, { ...bar, textBlocks: blocks });
}

/**
 * 改一个文字块的位置（0–1 比例坐标）。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {string} textBlockId
 * @param {{x: number, y: number}} position
 * @returns {EditResult}
 */
export function moveTextBlock(song, sectionId, barIndex, textBlockId, position = {}) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;
  const found = locateTextBlock(bar, textBlockId);
  if (found.error) return found.error;

  const x = Number(position.x);
  const y = Number(position.y);
  if (!Number.isFinite(x) || x < 0 || x > 1) return fail(EDIT_CODES.LAYOUT_INVALID, `水平坐标必须是 0–1，收到 ${JSON.stringify(position.x)}`);
  if (!Number.isFinite(y) || y < 0 || y > 1) return fail(EDIT_CODES.LAYOUT_INVALID, `垂直坐标必须是 0–1，收到 ${JSON.stringify(position.y)}`);

  const blocks = bar.textBlocks.map((block) => (block.id === textBlockId ? { ...block, x, y } : block));
  return withBar(song, sectionIndex, section, barIndex, { ...bar, textBlocks: blocks });
}

/**
 * 删除一个文字块。
 *
 * @param {import('./song.js').Song} song
 * @param {string} sectionId
 * @param {number} barIndex
 * @param {string} textBlockId
 * @returns {EditResult}
 */
export function removeTextBlock(song, sectionId, barIndex, textBlockId) {
  const located = locateBar(song, sectionId, barIndex);
  if (located.error) return located.error;
  const { bar, section, sectionIndex } = located;
  const found = locateTextBlock(bar, textBlockId);
  if (found.error) return found.error;

  const blocks = bar.textBlocks.filter((block) => block.id !== textBlockId);
  const nextBar = { ...bar };
  if (blocks.length > 0) nextBar.textBlocks = blocks;
  else delete nextBar.textBlocks;
  return withBar(song, sectionIndex, section, barIndex, nextBar);
}

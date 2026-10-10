/**
 * 歌曲数据模型：工厂函数、结构校验、序列化。
 *
 * 这是整个应用的唯一数据真相来源。输入解析、触屏编辑、谱面预览、导出
 * 全都读写同一份 Song 对象（见 docs/SPEC.md §2）。任何界面都不允许
 * 自己缓存一份「影子数据」，也绝不把渲染出来的 DOM 当成歌曲源数据。
 *
 * 两类 API 的错误约定：
 * - `createXxx()` 工厂函数遇到非法输入会 **抛异常**。它们只在我们自己的代码里
 *   用已知合法的参数调用，抛异常等于暴露编程错误。
 * - `validateSongShape()` 用于 **不可信数据**（工程文件导入、人工编辑的示例数据），
 *   永不抛异常，而是返回错误列表。
 *
 * @module core/song
 */

import {
  ACCIDENTAL_GLYPH_STYLES,
  BARS_PER_ROW_OPTIONS,
  CHORD_SYMBOL_STYLES,
  DEFAULT_BARS_PER_ROW,
  DEFAULT_TIME_SIGNATURE,
  DISPLAY_LINE_IDS,
  DIM_SUFFIX_STYLES,
  LEGACY_DISPLAY_MODE_TO_LINES,
  LIMITS,
  MAX_DISPLAY_LINES,
  REST_TEXT_STYLES,
  SCHEMA_VERSION,
  SEVENTH_SUFFIX_STYLES,
  TIME_SIGNATURE_IDS,
  getBeatsPerBar,
  getChordQuality,
  isAccidentalGlyphsValid,
  isChordSymbolsValid,
  isDimSuffixValid,
  isDisplayLinesValid,
  isRestTextValid,
  isSeventhSuffixValid,
  isTextBlockModeValid,
  normalizeAccidentalGlyphs,
  normalizeChordSymbols,
  normalizeDimSuffix,
  normalizeDisplayLines,
  normalizeRestText,
  normalizeSeventhSuffix,
  normalizeTextBlockMode,
  TEXT_BLOCK_MODES,
} from './constants.js';
import { createChord, parsePitchName } from './chord.js';
import { validAlignment } from './alignment.js';
import { collectIds, createId, isIdLike } from './ids.js';

/**
 * 小节类型。空的小节是独立的类型，**不等于休止**（见 docs/SPEC.md §2.4）。
 *
 * - `'chords'`：含和弦 / 休止事件的小节。
 * - `'empty'`：整小节留白，没有任何事件，谱面上保留正常宽度。
 *
 * @typedef {'chords'|'empty'} BarType
 */

/**
 * 和弦事件。
 *
 * @typedef {Object} ChordEvent
 * @property {'chord'} kind
 * @property {string} id
 * @property {number} beats 时值，单位「拍」（见 docs/SPEC.md §3.1）。
 * @property {import('./chord.js').Chord} chord
 */

/**
 * 休止事件。
 *
 * @typedef {Object} RestEvent
 * @property {'rest'} kind
 * @property {string} id
 * @property {number} beats 时值，单位「拍」。
 */

/**
 * 小节的音乐事件。第一版只有和弦与休止两种。
 *
 * @typedef {ChordEvent|RestEvent} SongEvent
 */

/**
 * 小节的歌词片段（逐字对齐，SPEC §8.9）。
 *
 * 歌词对齐的是「事件」——每个和弦 / 休止下方的那段词。所以歌词不独立成实体，
 * 而是挂在小节上，用**事件下标**对齐：`bar.lyrics[i]` 对应 `bar.events[i]`。
 * 一个片段可以放一个或多个音节；渲染时片段内的字在事件占的水平空间里均匀铺开。
 *
 * @typedef {Object} LyricFragment
 * @property {string} text 该事件下方的一段歌词（可为空串表示「这里留空」）。
 */

/**
 * 小节上的自由文字块（SPEC §8.10）。
 *
 * 与歌词（§8.9）是两套并存的机制：歌词跟和弦强绑定、系统排版；文字块自由定位、
 * 用户手动拖到任意位置。文字块存** 0–1 比例坐标**（不是像素），保证屏幕、导出、
 * 打印位置一致；`anchor` 决定它跟哪个和弦走。
 *
 * @typedef {Object} TextBlock
 * @property {string} id 以 `txt_` 开头，全局唯一。
 * @property {string} text 文字内容，可含 `\n` 换行（逐行写）。空串不落盘。
 * @property {number} x 相对小节框左边的水平位置（0–1）。
 * @property {number} y 相对小节框顶部的垂直位置（0–1）。
 * @property {number} anchor 对齐到的和弦下标（`bar.events[anchor]`）；`-1` 表示小节级。
 */

/**
 * 小节。
 *
 * @typedef {Object} Bar
 * @property {string} id
 * @property {BarType} type
 * @property {SongEvent[]} events `type === 'empty'` 时恒为空数组。
 * @property {Array<LyricFragment|null>} [lyrics] **可缺省**。与 `events` 按下标对齐的歌词；
 *   缺失或整段为空即等于「没有歌词」（旧行为）。`type === 'empty'` 时无意义，应忽略。
 * @property {TextBlock[]} [textBlocks] **可缺省**。自由定位的文字块（§8.10）；
 *   缺失或为空数组即等于「没有文字块」（旧行为）。`type === 'empty'` 时仍可存在。
 */

/**
 * 段落。
 *
 * @typedef {Object} Section
 * @property {string} id
 * @property {string} name 段落名称，例如 'Intro'、'副歌'。
 * @property {number} repeat 重复次数。第一版只是**演奏标注**，不复制实际小节。
 * @property {string} cue 演奏提示，例如 '清音扫弦，弱起'。
 * @property {Bar[]} bars 有序小节列表。
 */

/**
 * 谱面排版设置。
 *
 * **带 `[]` 的字段全部可缺省，缺失即等于缺省值，而且缺省值必须等于引入该字段之前的观感。**
 *
 * 这不是风格洁癖：`library.js` 读 `localStorage` 时**直接调 `validateSongShape`、
 * 不走迁移**。任何一个字段变成必需，用户已存的每一首歌都会在下次打开时被判为损坏并隔离
 * （SPEC §2.2、§7.4）。
 *
 * 另一个共同点：**它们全部只影响「怎么画」，不改「存了什么」**。数据里永远只有
 * 音乐事实（`root` / `quality` / `bass` / `beats`），字形与符号体系都是渲染参数
 * （SPEC §6.4、§8.1）。
 *
 * @typedef {Object} LayoutSettings
 * @property {2|4|8} barsPerRow 每行小节数。
 * @property {('chord'|'degree'|'roman')[]} displayLines 显示哪些行，按
 *   `chord → degree → roman` 的固定顺序排列，**1–3 项**。只影响显示，不改数据（SPEC §8.1.1）。
 * @property {('dim'|'°')} [dimSuffix] 级数行里**减三和弦后缀**的写法（SPEC §6.7.1）。
 *   缺失等价于 `'dim'`。只影响级数行；和弦名由 `chordSymbols` 单独管，两者互不影响。
 * @property {('common'|'jazz')} [chordSymbols] 和弦性质用哪套**符号体系**（SPEC §5.1.1）。
 *   缺失等价于 `'common'`（`Cmaj7` `Cm7` `Cdim`）。`'jazz'` 给 `CΔ7` `C-7` `C°`。
 *   影响和弦名与**文本导出**（§4.8），不影响级数行。
 * @property {('glyph'|'ascii')} [accidentalGlyphs] 升降号画成 `♯` `♭` 还是 `#` `b`
 *   （SPEC §5.1.2）。缺失等价于 `'glyph'`。**只作用于和弦名与音名，不作用于级数行** ——
 *   级数里的 `#4` 那个 `#` 是级数限定符，属于另一层。
 * @property {('subscript'|'plain'|'superscript'|'parens')} [seventhSuffix] 属七和弦在
 *   级数行里后缀 `7` 的位置（SPEC §6.6）。缺失等价于 `'subscript'`（右下角小角标）。
 * @property {('cn'|'dash'|'R')} [restText] 休止符在谱面上写什么（SPEC §8.1.2）。
 *   缺失等价于 `'cn'`（「休止」）。刻意没有 `'0'`：那是空白小节的文本记号（§2.4）。
 * @property {number} fontScale 谱面字号缩放，1 为基准。
 */

/**
 * 调号。
 *
 * @typedef {Object} SongKey
 * @property {string} tonic 主音音名，形如 'C'、'F#'、'Bb'。
 * @property {'major'} mode 第一版只支持大调；传入其它值会被校验拒绝。
 */

/**
 * 一首歌。
 *
 * @typedef {Object} Song
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} createdAt ISO 8601 时间戳。
 * @property {string} updatedAt ISO 8601 时间戳。
 * @property {string} title
 * @property {string} artist 艺人
 * @property {string} notes 备注
 * @property {SongKey} key
 * @property {number} bpm
 * @property {string} timeSignature
 * @property {string} style 风格或效果器预设名称。
 * @property {Section[]} sections
 * @property {LayoutSettings} layout
 */

/**
 * 校验问题。`path` 是可以直接展示给用户的位置描述。
 *
 * @typedef {Object} ValidationIssue
 * @property {string} path 例如 `sections[2].bars[3].events[0].beats`
 * @property {string} message
 */

/* ------------------------------------------------------------------ *
 * 工厂函数
 * ------------------------------------------------------------------ */

/**
 * 生成 ISO 8601 时间戳。
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 规范化一个事件输入：补齐 ID、分派到具体的工厂函数。
 *
 * @param {unknown} input
 * @returns {SongEvent}
 */
function normalizeEventInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`事件必须是对象，收到 ${describeType(input)}`);
  }
  const id = isIdLike(input.id, 'event') ? input.id : createId('event');
  if (input.kind === 'chord') return createChordEvent({ ...input, id });
  if (input.kind === 'rest') return createRestEvent({ ...input, id });
  throw new Error(`未知事件类型 ${JSON.stringify(input.kind)}，可用：chord / rest`);
}

/**
 * 规范化一个小节输入：补齐 ID、明确类型。
 *
 * `type` 缺省时按 `'chords'` 处理；只有显式写 `'empty'` 才是空白小节。
 * 空白小节不允许携带事件——这是「空白 ≠ 休止」这条约束的落地点。
 *
 * @param {unknown} input
 * @returns {Bar}
 */
/**
 * 规范化小节的歌词片段。认不出的输入（非数组、项不是对象、text 不是字符串）一律丢弃，
 * 得到一个干净的可选数组；整段为空时返回 `undefined`，表示「没有歌词」——不落一个空数组进数据，
 * 让「有没有歌词」这个事实始终可判定（SPEC §8.9 的可缺省语义）。
 *
 * @param {unknown} input
 * @returns {Array<{text: string}> | undefined}
 */
function normalizeLyricsInput(input) {
  if (!Array.isArray(input)) return undefined;
  const fragments = input
    .map((fragment) => fragment && typeof fragment === 'object' && !Array.isArray(fragment) ? { text: String(fragment.text ?? '') } : null);
  return fragments.length > 0 ? fragments : undefined;
}

/**
 * 规范化小节的文字块（SPEC §8.10）。认不出的输入（非数组、项不是对象、text 不是字符串）
 * 一律丢弃；空串文字或坐标越界的块也丢掉。得到一个干净的可选数组；全空返回 `undefined`，
 * 表示「没有文字块」——不落一个空数组进数据，让「有没有文字块」始终可判定。
 *
 * @param {unknown} input
 * @returns {Array<TextBlock> | undefined}
 */
function normalizeTextBlocksInput(input) {
  if (!Array.isArray(input)) return undefined;
  const blocks = input
    .filter((block) => block && typeof block === 'object' && !Array.isArray(block))
    .map((block) => {
      const text = String(block.text ?? '');
      const x = Number(block.x);
      const y = Number(block.y);
      const anchor = Number.isInteger(Number(block.anchor)) ? Number(block.anchor) : -1;
      const id = isIdLike(block.id, 'textBlock') ? block.id : createId('textBlock');
      return { id, text, x, y, anchor };
    })
    .filter((block) => block.text.trim() !== '' && Number.isFinite(block.x) && Number.isFinite(block.y));
  return blocks.length > 0 ? blocks : undefined;
}

export function barAnnotations(bar) {
  return Object.fromEntries(['alignment','sourceNumber','repeatStart','repeatEnd','ending','showMelody'].filter((key) => bar[key] !== undefined).map((key) => [key, structuredClone(bar[key])]));
}

function normalizeBarInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`小节必须是对象，收到 ${describeType(input)}`);
  }
  const id = isIdLike(input.id, 'bar') ? input.id : createId('bar');

  if (input.type === 'empty') {
    // 空白小节没有任何事件，歌词对不上位置，忽略掉；但文字块可以存在（§8.10），
    // 「间奏」「转调」这类标注就写在空白小节上。
    const bar = { id, type: 'empty', events: [], ...barAnnotations(input) };
    const textBlocks = normalizeTextBlocksInput(input.textBlocks);
    if (textBlocks) bar.textBlocks = textBlocks;
    if (Array.isArray(input.melody)) bar.melody = input.melody.map((note) => ({ ...note }));
    if (input.length !== undefined) bar.length = input.length;
    return bar;
  }
  if (input.type !== undefined && input.type !== 'chords') {
    throw new Error(`未知小节类型 ${JSON.stringify(input.type)}，可用：chords / empty`);
  }

  const rawEvents = input.events ?? [];
  if (!Array.isArray(rawEvents)) {
    throw new Error(`小节的 events 必须是数组，收到 ${describeType(rawEvents)}`);
  }
  const bar = { id, type: 'chords', events: rawEvents.map(normalizeEventInput), ...barAnnotations(input) };
  // 歌词是可缺省字段：有才挂上去，没有就省略整个字段，绝不写一个空数组。
  const lyrics = normalizeLyricsInput(input.lyrics);
  if (lyrics) bar.lyrics = lyrics;
  // 文字块也是可缺省字段（§8.10）。空白小节（type='empty'）也能有文字块，
  // 但 empty 分支在上面提前 return 了，所以这里要单独处理 —— 见下面的 empty 分支。
  const textBlocks = normalizeTextBlocksInput(input.textBlocks);
  if (textBlocks) bar.textBlocks = textBlocks;
  if (Array.isArray(input.melody)) bar.melody = input.melody.map((note) => ({ ...note }));
  if (input.length !== undefined) bar.length = input.length;
  return bar;
}

/**
 * 创建一个休止事件。
 *
 * @param {{beats: number, id?: string}} input
 * @returns {RestEvent}
 */
export function createRestEvent(input) {
  const beats = Number(input?.beats);
  if (!Number.isFinite(beats) || beats <= 0) {
    throw new Error(`createRestEvent: 休止时值必须是正数，收到 ${JSON.stringify(input?.beats)}`);
  }
  return { kind: 'rest', id: input?.id ?? createId('event'), beats };
}

/**
 * 创建一个和弦事件。
 *
 * @param {{chord: {root: string, quality?: string, bass?: string|null}, beats: number, id?: string}} input
 * @returns {ChordEvent}
 */
export function createChordEvent(input) {
  const beats = Number(input?.beats);
  if (!Number.isFinite(beats) || beats <= 0) {
    throw new Error(`createChordEvent: 和弦时值必须是正数，收到 ${JSON.stringify(input?.beats)}`);
  }
  const parsed = createChord(input?.chord ?? {});
  if (!parsed.ok) {
    throw new Error(`createChordEvent: ${parsed.message}`);
  }
  return { kind: 'chord', id: input?.id ?? createId('event'), beats, chord: parsed.value };
}

/**
 * 创建一个小节。
 *
 * @param {{type?: BarType, events?: SongEvent[], id?: string}} [input]
 * @returns {Bar}
 */
export function createBar(input = {}) {
  return normalizeBarInput(input);
}

/** 创建一个不带任何事件的空白小节（`type: 'empty'`）。 */
export function createEmptyBar(id) {
  return createBar({ type: 'empty', id });
}

/**
 * 创建一个段落。输入里缺 ID 的段落和小节会自动补齐 ID，
 * 因此可以直接往里塞「手写的原始对象」。
 *
 * @param {{name: string, repeat?: number, cue?: string, bars?: Bar[], id?: string}} input
 * @returns {Section}
 */
export function createSection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`createSection: 段落必须是对象，收到 ${describeType(input)}`);
  }
  const name = String(input.name ?? '').trim();
  if (name === '') {
    throw new Error('createSection: 段落名称不能为空');
  }
  const repeat = input.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < LIMITS.sectionRepeatMin || repeat > LIMITS.sectionRepeatMax) {
    throw new Error(
      `createSection: 重复次数必须是 ${LIMITS.sectionRepeatMin}–${LIMITS.sectionRepeatMax} 的整数，收到 ${JSON.stringify(input.repeat)}`,
    );
  }
  const rawBars = input.bars ?? [];
  if (!Array.isArray(rawBars)) {
    throw new Error(`createSection: 段落的 bars 必须是数组，收到 ${describeType(rawBars)}`);
  }
  return {
    id: isIdLike(input.id, 'section') ? input.id : createId('section'),
    name,
    repeat,
    cue: String(input.cue ?? ''),
    bars: rawBars.map(normalizeBarInput),
  };
}

/**
 * 创建一首歌。未提供的字段使用默认值；段落 / 小节 / 事件缺 ID 时会自动补齐。
 *
 * @param {Partial<Song>} [input]
 * @returns {Song}
 */
export function createSong(input = {}) {
  const timestamp = nowIso();
  const rawSections = input.sections ?? [];
  if (!Array.isArray(rawSections)) {
    throw new Error(`createSong: sections 必须是数组，收到 ${describeType(rawSections)}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: isIdLike(input.id, 'song') ? input.id : createId('song'),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    title: String(input.title ?? '未命名歌曲'),
    ...(input.unsetMeta ? { unsetMeta: [...input.unsetMeta] } : {}),
    ...(input.chordDiagrams ? { chordDiagrams: input.chordDiagrams.map((item) => ({ ...item, chord: { ...item.chord } })) } : {}),
    artist: String(input.artist ?? ''),
    notes: String(input.notes ?? ''),
    key: { tonic: input.key?.tonic ?? 'C', mode: input.key?.mode ?? 'major' },
    ...(input.capo !== undefined ? { capo: input.capo } : {}),
    ...(input.timing !== undefined ? { timing: input.timing } : {}),
    ...(input.importIssues !== undefined ? { importIssues: input.importIssues.map((item) => ({ ...item })) } : {}),
    ...(input.importSource !== undefined ? { importSource: { ...input.importSource } } : {}),
    bpm: input.bpm ?? 90,
    timeSignature: input.timeSignature ?? DEFAULT_TIME_SIGNATURE,
    style: String(input.style ?? ''),
    sections: rawSections.map(createSection),
    layout: {
      barsPerRow: input.layout?.barsPerRow ?? DEFAULT_BARS_PER_ROW,
      // v1 存的是单个 displayMode 字符串，v2 换成了数组 —— 旧值在这里翻译一次
      // 就丢弃，**永不写回**，所以数据里只留 displayLines 一个真相（SPEC §7.4）。
      displayLines: normalizeDisplayLines(
        input.layout?.displayLines ?? LEGACY_DISPLAY_MODE_TO_LINES[input.layout?.displayMode],
      ),
      // 新歌总是写全这些字段（哪怕等于缺省）—— 让「自己造的歌曲」形态统一。
      // 老数据里缺字段是**合法状态**，由渲染关口兜底，不在这里补（SPEC §7.4）。
      //
      // 五个风格字段一律走 `normalizeXxx`（**读容错**）：这里收到的可能是用户手改过的
      // 工程文件，为一个显示偏好让整首歌创建失败不值得。写入侧的严格判断在
      // `edit.updateSongMeta` 与 `validateSongShape` 里。
      dimSuffix: normalizeDimSuffix(input.layout?.dimSuffix),
      chordSymbols: normalizeChordSymbols(input.layout?.chordSymbols),
      accidentalGlyphs: normalizeAccidentalGlyphs(input.layout?.accidentalGlyphs),
      seventhSuffix: normalizeSeventhSuffix(input.layout?.seventhSuffix),
      restText: normalizeRestText(input.layout?.restText),
      textBlockMode: normalizeTextBlockMode(input.layout?.textBlockMode),
      fontScale: input.layout?.fontScale ?? 1,
      ...(input.layout?.showMelody !== undefined ? { showMelody: input.layout.showMelody } : {}),
      ...(input.layout?.lyricScale !== undefined ? { lyricScale: input.layout.lyricScale } : {}),
      ...(input.layout?.chordScale !== undefined ? { chordScale: input.layout.chordScale } : {}),
      ...(input.layout?.numberedKey !== undefined ? { numberedKey: input.layout.numberedKey } : {}),
      ...Object.fromEntries(['showLyrics','showMeta','showCues','showBarNumbers','compact'].filter((key) => input.layout?.[key] !== undefined).map((key) => [key,input.layout[key]])),
    },
  };
}

/**
 * 创建一首可直接编辑的新歌：一个 A 段，四小节空白。
 * 空白小节用 `type: 'empty'` 表达，不是休止。
 *
 * @returns {Song}
 */
export function createEmptySong(title = '未命名歌曲') {
  return createSong({
    title,
    sections: [{ name: 'A', bars: [createEmptyBar(), createEmptyBar(), createEmptyBar(), createEmptyBar()] }],
  });
}

/** Empty user draft. Internal rhythm defaults only support editing; unsetMeta
 * records that they are not supplied song metadata and must not be printed. */
export function createBlankSong(title = '') {
  return createSong({ title, unsetMeta: [...(!title.trim() ? ['title'] : []), 'key', 'bpm', 'timeSignature'], sections: [] });
}

export const metaIsSet = (song, field) => !song.unsetMeta?.includes(field);

/* ------------------------------------------------------------------ *
 * 克隆
 * ------------------------------------------------------------------ */

/** @param {SongEvent} event @returns {SongEvent} */
export function cloneEvent(event) {
  if (event?.kind === 'chord') {
    return {
      kind: 'chord',
      id: event.id,
      beats: event.beats,
      chord: { root: event.chord.root, quality: event.chord.quality, bass: event.chord.bass ?? null },
    };
  }
  if (event?.kind === 'rest') {
    return { kind: 'rest', id: event.id, beats: event.beats };
  }
  throw new Error(`cloneEvent: 未知事件类型 ${JSON.stringify(event?.kind)}`);
}

/** @param {Bar} bar @returns {Bar} */
export function cloneBar(bar) {
  if (bar?.type === 'empty') {
    const clone = { id: bar.id, type: 'empty', events: [], ...barAnnotations(bar) };
    // 空白小节也能有文字块（§8.10），一并深拷贝。
    if (Array.isArray(bar?.textBlocks)) {
      clone.textBlocks = bar.textBlocks.map(cloneTextBlock);
    }
    if (Array.isArray(bar.melody)) clone.melody = bar.melody.map((note) => ({ ...note }));
    if (bar.length !== undefined) clone.length = bar.length;
    return clone;
  }
  const clone = { id: bar.id, type: 'chords', events: (bar?.events ?? []).map(cloneEvent), ...barAnnotations(bar) };
  if (Array.isArray(bar.melody)) clone.melody = bar.melody.map((note) => ({ ...note }));
  if (bar.length !== undefined) clone.length = bar.length;
  // 歌词是可缺省字段，跟着小节一起深拷贝（每个片段都是独立对象，别共享引用）。
  if (Array.isArray(bar?.lyrics)) {
    clone.lyrics = bar.lyrics.map((fragment) => (fragment ? { text: fragment.text } : null));
  }
  // 文字块同理（§8.10）。
  if (Array.isArray(bar?.textBlocks)) {
    clone.textBlocks = bar.textBlocks.map(cloneTextBlock);
  }
  return clone;
}

/** @param {TextBlock} block @returns {TextBlock} */
function cloneTextBlock(block) {
  return { id: block.id, text: block.text, x: block.x, y: block.y, anchor: block.anchor };
}

/** @param {Section} section @returns {Section} */
export function cloneSection(section) {
  return {
    id: section.id,
    name: section.name,
    repeat: section.repeat,
    cue: section.cue,
    bars: (section.bars ?? []).map(cloneBar),
  };
}

/**
 * 深拷贝一首歌。撤销 / 重做和「复制」操作都依赖它，
 * 保证两份数据不共享任何可变对象。
 *
 * @param {Song} song
 * @returns {Song}
 */
export function cloneSong(song) {
  return {
    ...song,
    ...(song.unsetMeta ? { unsetMeta: [...song.unsetMeta] } : {}),
    ...(song.chordDiagrams ? { chordDiagrams: song.chordDiagrams.map((item) => ({ ...item, chord: { ...item.chord } })) } : {}),
    key: { ...song.key },
    ...(song.importIssues ? { importIssues: song.importIssues.map((item) => ({ ...item })) } : {}),
    ...(song.importSource ? { importSource: { ...song.importSource } } : {}),
    sections: (song.sections ?? []).map(cloneSection),
    layout: { ...song.layout, displayLines: [...(song.layout?.displayLines ?? [])] },
  };
}

/**
 * 返回一份把 `updatedAt` 刷新为当前时间的拷贝。
 * 所有写操作都应经过它，这样「是否有未保存改动」的判断永远可靠。
 *
 * @param {Song} song
 * @returns {Song}
 */
export function touchSong(song) {
  return { ...cloneSong(song), updatedAt: nowIso() };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/** 收集用的小工具：把一个问题的位置和说明推进列表。 */
function issue(list, path, message) {
  list.push({ path, message });
}

/** 检查字符串字段的长度。 */
function checkText(list, value, path, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') {
    issue(list, path, `必须是字符串，当前类型为 ${describeType(value)}`);
    return;
  }
  if (required && value.trim() === '') {
    issue(list, path, '不能为空');
    return;
  }
  if (value.length > maxLength) {
    issue(list, path, `长度超过上限 ${maxLength} 个字符（当前 ${value.length}）`);
  }
}

/** 生成人类可读的类型名，用于错误信息。 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 检查 ISO 8601 时间戳字符串。 */
function checkIsoTimestamp(list, value, path) {
  if (typeof value !== 'string') {
    issue(list, path, `必须是 ISO 8601 时间字符串，当前类型为 ${describeType(value)}`);
    return;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    issue(list, path, `不是合法的时间字符串："${value}"`);
  }
}

/**
 * 校验一个和弦对象。
 * @param {ValidationIssue[]} list
 * @param {unknown} chord
 * @param {string} path
 */
function checkChord(list, chord, path) {
  if (!chord || typeof chord !== 'object' || Array.isArray(chord)) {
    issue(list, path, `必须是和弦对象，当前类型为 ${describeType(chord)}`);
    return;
  }
  const rootParsed = parsePitchName(String(chord.root ?? ''));
  if (!rootParsed.ok) {
    issue(list, `${path}.root`, rootParsed.message);
  }
  if (!getChordQuality(chord.quality)) {
    issue(
      list,
      `${path}.quality`,
      `未知和弦性质 "${chord.quality}"，可用取值：${['maj', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'aug'].join(' / ')}`,
    );
  }
  if (chord.bass !== null && chord.bass !== undefined) {
    const bassParsed = parsePitchName(String(chord.bass));
    if (!bassParsed.ok) {
      issue(list, `${path}.bass`, `斜杠低音无效：${bassParsed.message}`);
    }
  }
}

/**
 * 校验一个小节。
 * @param {ValidationIssue[]} list
 * @param {unknown} bar
 * @param {string} path
 */
function checkBar(list, bar, path) {
  if (!bar || typeof bar !== 'object' || Array.isArray(bar)) {
    issue(list, path, `必须是对象，当前类型为 ${describeType(bar)}`);
    return;
  }
  if (!isIdLike(bar.id, 'bar')) {
    issue(list, `${path}.id`, `ID 缺失或格式不合法（应以 bar_ 开头），当前值 ${JSON.stringify(bar.id)}`);
  }
  if (bar.type !== 'chords' && bar.type !== 'empty') {
    issue(list, `${path}.type`, `小节类型必须是 "chords" 或 "empty"，当前值 ${JSON.stringify(bar.type)}`);
  }
  if (!Array.isArray(bar.events)) {
    issue(list, `${path}.events`, `必须是数组，当前类型为 ${describeType(bar.events)}`);
    return;
  }
  if (bar.type === 'empty' && bar.events.length > 0) {
    issue(list, path, '空白小节（type: "empty"）不能包含事件；若要表达无声，请用休止事件或把类型改为 "chords"');
  }
  if (bar.events.length > LIMITS.maxEventsPerBar) {
    issue(list, `${path}.events`, `事件数超过上限 ${LIMITS.maxEventsPerBar}（当前 ${bar.events.length}）`);
  }

  // 歌词（可缺省，SPEC §8.9）：若存在，必须是数组，且每一项要么是 null、要么是带
  // 字符串 text 的对象。长度允许与 events 不同（短的尾部视为无歌词，长的忽略多出的）。
  // 这里**不要求它存在**——缺失等价于「没有歌词」（旧行为）。
  if (bar.lyrics !== undefined) {
    if (!Array.isArray(bar.lyrics)) {
      issue(list, `${path}.lyrics`, `歌词必须是数组，当前类型为 ${describeType(bar.lyrics)}`);
    } else {
      bar.lyrics.forEach((fragment, index) => {
        if (fragment === null) return;
        if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
          issue(list, `${path}.lyrics[${index}]`, `歌词片段必须是对象或 null，当前类型为 ${describeType(fragment)}`);
          return;
        }
        if (typeof fragment.text !== 'string') {
          issue(list, `${path}.lyrics[${index}].text`, `歌词文本必须是字符串，当前类型为 ${describeType(fragment.text)}`);
        } else if (fragment.text.length > LIMITS.lyricMaxLength) {
          issue(list, `${path}.lyrics[${index}].text`, `歌词长度超过上限 ${LIMITS.lyricMaxLength} 个字符（当前 ${fragment.text.length}）`);
        }
      });
    }
  }

  if (bar.length !== undefined && (!Number.isFinite(bar.length) || bar.length <= 0 || bar.length > 32)) {
    issue(list, `${path}.length`, '小节长度必须为 0–32 之间的正数');
  }
  if (bar.alignment !== undefined && !validAlignment(bar.alignment, bar)) issue(list, `${path}.alignment`, '逐字对齐需要合法坐标、字号与音符对应关系');
  if (bar.sourceNumber !== undefined && (!Number.isInteger(bar.sourceNumber) || bar.sourceNumber < 1 || bar.sourceNumber > 100000)) issue(list, `${path}.sourceNumber`, '原谱小节编号应为正整数');
  for (const prop of ['repeatStart','showMelody']) if (bar[prop] !== undefined && typeof bar[prop] !== 'boolean') issue(list, `${path}.${prop}`, '该小节显示选项应为布尔值');
  if (bar.repeatEnd !== undefined && (!Number.isInteger(bar.repeatEnd) || bar.repeatEnd < 2 || bar.repeatEnd > 8)) issue(list, `${path}.repeatEnd`, '反复次数应为 2–8');
  if (bar.ending !== undefined && ![1,2].includes(bar.ending)) issue(list, `${path}.ending`, '跳房子只支持第一、第二结尾');
  if (bar.melody !== undefined) {
    if (!Array.isArray(bar.melody) || bar.melody.length > 256) {
      issue(list, `${path}.melody`, '旋律必须是最多 256 个音符的数组');
    } else {
      for (const [index, note] of bar.melody.entries()) {
        if (!note || (note.pitch !== null && (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127)) || !Number.isFinite(note.beats) || note.beats <= 0 || note.beats > 32 || (note.lyric !== undefined && (typeof note.lyric !== 'string' || note.lyric.length > 100))) {
          issue(list, `${path}.melody[${index}]`, '音符需要有效音高（休止为 null）、正时值和歌词文本');
        }
        if (note?.tie !== undefined && typeof note.tie !== 'boolean') issue(list, `${path}.melody[${index}].tie`, '延音标记必须是布尔值');
      }
    }
  }

  // 文字块（可缺省，SPEC §8.10）：若存在，必须是数组，且每项必须是带合法 text/x/y/anchor 的对象。
  // 缺失等价于「没有文字块」（旧行为）。空白小节也可以有文字块。
  if (bar.textBlocks !== undefined) {
    if (!Array.isArray(bar.textBlocks)) {
      issue(list, `${path}.textBlocks`, `文字块必须是数组，当前类型为 ${describeType(bar.textBlocks)}`);
    } else {
      bar.textBlocks.forEach((block, index) => {
        const blockPath = `${path}.textBlocks[${index}]`;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          issue(list, blockPath, `文字块必须是对象，当前类型为 ${describeType(block)}`);
          return;
        }
        if (!isIdLike(block.id, 'textBlock')) {
          issue(list, `${blockPath}.id`, `文字块 ID 缺失或格式不合法（应以 txt_ 开头），当前值 ${JSON.stringify(block.id)}`);
        }
        if (typeof block.text !== 'string') {
          issue(list, `${blockPath}.text`, `文字内容必须是字符串，当前类型为 ${describeType(block.text)}`);
        } else if (block.text.length > LIMITS.textBlockMaxLength) {
          issue(list, `${blockPath}.text`, `文字内容长度超过上限 ${LIMITS.textBlockMaxLength} 个字符（当前 ${block.text.length}）`);
        }
        if (typeof block.x !== 'number' || !Number.isFinite(block.x) || block.x < 0 || block.x > 1) {
          issue(list, `${blockPath}.x`, `水平坐标必须是 0–1 的数值，当前值 ${JSON.stringify(block.x)}`);
        }
        if (typeof block.y !== 'number' || !Number.isFinite(block.y) || block.y < 0 || block.y > 1) {
          issue(list, `${blockPath}.y`, `垂直坐标必须是 0–1 的数值，当前值 ${JSON.stringify(block.y)}`);
        }
        if (!Number.isInteger(block.anchor) || block.anchor < -1) {
          issue(list, `${blockPath}.anchor`, `锚点必须是 -1 或和弦下标（非负整数），当前值 ${JSON.stringify(block.anchor)}`);
        }
      });
    }
  }

  bar.events.forEach((event, index) => {
    const eventPath = `${path}.events[${index}]`;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      issue(list, eventPath, `必须是对象，当前类型为 ${describeType(event)}`);
      return;
    }
    if (!isIdLike(event.id, 'event')) {
      issue(list, `${eventPath}.id`, `ID 缺失或格式不合法（应以 evt_ 开头），当前值 ${JSON.stringify(event.id)}`);
    }
    if (event.kind !== 'chord' && event.kind !== 'rest') {
      issue(list, `${eventPath}.kind`, `事件类型必须是 "chord" 或 "rest"，当前值 ${JSON.stringify(event.kind)}`);
      return;
    }
    if (typeof event.beats !== 'number' || !Number.isFinite(event.beats)) {
      issue(list, `${eventPath}.beats`, `时值必须是有限数值，当前值 ${JSON.stringify(event.beats)}`);
    } else if (event.beats <= 0) {
      issue(list, `${eventPath}.beats`, `时值必须为正数，当前值 ${event.beats}`);
    } else if (event.beats > LIMITS.beatsMax) {
      issue(list, `${eventPath}.beats`, `时值超过上限 ${LIMITS.beatsMax} 拍，当前值 ${event.beats}`);
    }
    if (event.kind === 'chord') {
      checkChord(list, event.chord, `${eventPath}.chord`);
    }
    if (event.kind === 'rest' && event.chord !== undefined) {
      issue(list, eventPath, '休止事件不应带 chord 字段');
    }
  });
}

/**
 * 校验一个段落。
 * @param {ValidationIssue[]} list
 * @param {unknown} section
 * @param {string} path
 */
function checkSection(list, section, path) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    issue(list, path, `必须是对象，当前类型为 ${describeType(section)}`);
    return;
  }
  if (!isIdLike(section.id, 'section')) {
    issue(list, `${path}.id`, `ID 缺失或格式不合法（应以 sec_ 开头），当前值 ${JSON.stringify(section.id)}`);
  }
  checkText(list, section.name, `${path}.name`, LIMITS.sectionNameMaxLength, { required: true });
  if (!Number.isInteger(section.repeat) || section.repeat < LIMITS.sectionRepeatMin || section.repeat > LIMITS.sectionRepeatMax) {
    issue(
      list,
      `${path}.repeat`,
      `重复次数必须是 ${LIMITS.sectionRepeatMin}–${LIMITS.sectionRepeatMax} 的整数，当前值 ${JSON.stringify(section.repeat)}`,
    );
  }
  checkText(list, section.cue, `${path}.cue`, LIMITS.sectionCueMaxLength);

  if (!Array.isArray(section.bars)) {
    issue(list, `${path}.bars`, `必须是数组，当前类型为 ${describeType(section.bars)}`);
    return;
  }
  if (section.bars.length > LIMITS.maxBarsPerSection) {
    issue(list, `${path}.bars`, `小节数超过上限 ${LIMITS.maxBarsPerSection}（当前 ${section.bars.length}）`);
  }
  section.bars.forEach((bar, index) => checkBar(list, bar, `${path}.bars[${index}]`));
}

/**
 * 校验歌曲的结构、字段类型、数值范围。
 *
 * 这是导入工程文件和加载本地存储数据时唯一的结构入口。
 * 永不抛异常；调用方必须检查 `ok`，失败时**保留原有数据不动**。
 *
 * 注意：这里只做结构校验，不做音乐语义校验（小节拍数是否够）——
 * 语义校验属于 docs/SPEC.md §3.3，由后续阶段的时值校验模块负责。
 *
 * @param {unknown} song
 * @returns {{ok: boolean, errors: ValidationIssue[]}}
 */
export function validateSongShape(song) {
  /** @type {ValidationIssue[]} */
  const errors = [];

  if (!song || typeof song !== 'object' || Array.isArray(song)) {
    return { ok: false, errors: [{ path: '', message: `歌曲数据必须是对象，当前类型为 ${describeType(song)}` }] };
  }

  if (song.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `只支持 schemaVersion = ${SCHEMA_VERSION}，当前值为 ${JSON.stringify(song.schemaVersion)}。请用对应版本的工程文件，或先升级数据。`,
    });
  }

  if (!isIdLike(song.id, 'song')) {
    issue(errors, 'id', `歌曲 ID 缺失或格式不合法（应以 sng_ 开头），当前值 ${JSON.stringify(song.id)}`);
  }
  checkIsoTimestamp(errors, song.createdAt, 'createdAt');
  checkIsoTimestamp(errors, song.updatedAt, 'updatedAt');

  if (song.unsetMeta !== undefined && (!Array.isArray(song.unsetMeta) || song.unsetMeta.some((field) => !['title','key','bpm','timeSignature'].includes(field)) || new Set(song.unsetMeta).size !== song.unsetMeta.length)) issue(errors, 'unsetMeta', '未填写信息的字段不合法');
  checkText(errors, song.title, 'title', LIMITS.titleMaxLength, { required: !(Array.isArray(song.unsetMeta) && song.unsetMeta.includes('title')) });
  if (Array.isArray(song.unsetMeta) && song.unsetMeta.includes('title') && typeof song.title === 'string' && song.title.trim()) issue(errors, 'unsetMeta', '已有歌名不能标记为空白');
  if (song.chordDiagrams !== undefined) {
    if (!Array.isArray(song.chordDiagrams) || song.chordDiagrams.length > 48) issue(errors, 'chordDiagrams', '和弦图应为数组，最多 48 个');
    else song.chordDiagrams.forEach((item, index) => {
      const path = `chordDiagrams[${index}]`;
      if (!item || typeof item !== 'object') { issue(errors, path, '和弦图数据不合法'); return; }
      checkChord(errors, item.chord, `${path}.chord`);
      if (!Number.isInteger(item.position) || item.position < 0 || item.position > 100) issue(errors, path, '指法编号不合法');
      if (!Number.isFinite(item.size) || item.size < 60 || item.size > 180) issue(errors, path, '和弦图宽度应为 60–180');
    });
  }
  checkText(errors, song.artist, 'artist', LIMITS.artistMaxLength);
  checkText(errors, song.notes, 'notes', LIMITS.notesMaxLength);
  checkText(errors, song.style, 'style', LIMITS.styleMaxLength);

  // 调号
  if (!song.key || typeof song.key !== 'object' || Array.isArray(song.key)) {
    issue(errors, 'key', `调号必须是对象，当前类型为 ${describeType(song.key)}`);
  } else {
    const tonicParsed = parsePitchName(String(song.key.tonic ?? ''));
    if (!tonicParsed.ok) {
      issue(errors, 'key.tonic', `主音无效：${tonicParsed.message}`);
    }
    if (!['major', 'minor'].includes(song.key.mode)) {
      issue(
        errors,
        'key.mode',
        `调式应为 major 或 minor，当前值 ${JSON.stringify(song.key.mode)}。`,
      );
    }
  }

  if (song.capo !== undefined && (!Number.isInteger(song.capo) || song.capo < 0 || song.capo > 12)) issue(errors, 'capo', '变调夹应为 0–12 品的整数');
  if (song.timing !== undefined && !['exact', 'practice'].includes(song.timing)) issue(errors, 'timing', '节奏类型应为 exact 或 practice');
  if (song.importIssues !== undefined && (!Array.isArray(song.importIssues) || song.importIssues.length > 300 || song.importIssues.some((item) => !item || typeof item.location !== 'string' || typeof item.message !== 'string'))) issue(errors, 'importIssues', '待核对信息必须是位置与说明的数组');
  if (song.importSource !== undefined && (!song.importSource || !['chordpro', 'chordmark', 'abc'].includes(song.importSource.notation) || typeof song.importSource.content !== 'string' || song.importSource.content.length > 500000)) issue(errors, 'importSource', '原始谱文格式不合法或超过长度限制');

  // BPM
  if (!Number.isInteger(song.bpm)) {
    issue(errors, 'bpm', `BPM 必须是整数，当前值 ${JSON.stringify(song.bpm)}`);
  } else if (song.bpm < LIMITS.bpmMin || song.bpm > LIMITS.bpmMax) {
    issue(errors, 'bpm', `BPM 必须在 ${LIMITS.bpmMin}–${LIMITS.bpmMax} 之间，当前值 ${song.bpm}`);
  }

  // 拍号
  if (!TIME_SIGNATURE_IDS.includes(song.timeSignature)) {
    issue(
      errors,
      'timeSignature',
      `不支持的拍号 ${JSON.stringify(song.timeSignature)}，本版支持：${TIME_SIGNATURE_IDS.join(' / ')}`,
    );
  }

  // 段落
  if (!Array.isArray(song.sections)) {
    issue(errors, 'sections', `必须是数组，当前类型为 ${describeType(song.sections)}`);
  } else {
    if (song.sections.length > LIMITS.maxSections) {
      issue(errors, 'sections', `段落数超过上限 ${LIMITS.maxSections}（当前 ${song.sections.length}）`);
    }
    song.sections.forEach((section, index) => checkSection(errors, section, `sections[${index}]`));
  }

  // 排版设置
  if (!song.layout || typeof song.layout !== 'object' || Array.isArray(song.layout)) {
    issue(errors, 'layout', `排版设置必须是对象，当前类型为 ${describeType(song.layout)}`);
  } else {
    if (!BARS_PER_ROW_OPTIONS.includes(song.layout.barsPerRow)) {
      issue(errors, 'layout.barsPerRow', `每行小节数只能是 ${BARS_PER_ROW_OPTIONS.join(' / ')}，当前值 ${JSON.stringify(song.layout.barsPerRow)}`);
    }
    if (!isDisplayLinesValid(song.layout.displayLines)) {
      issue(
        errors,
        'layout.displayLines',
        `显示行必须是 1–${MAX_DISPLAY_LINES} 项且不重复，取值只能是 ${DISPLAY_LINE_IDS.join(' / ')}，当前值 ${JSON.stringify(song.layout.displayLines)}`,
      );
    }
    // 五个风格字段都是**可缺省**字段：缺失等价于各自的缺省值，**不算错**。
    //
    // 这一段不能改成必需字段。`library.js` 读 localStorage 时**直接调这个函数、不走迁移**，
    // 一旦要求必需，用户已存的每一首歌都会在下次打开时被判为损坏并隔离 ——
    // 为一个后缀写法赔上用户全部的歌。
    //
    // 五个字段的规则完全一样，所以共用一张表。逐个手写五遍，早晚有人漏掉其中一个的
    // 「缺失检查」，而漏掉的那个不会报错，只会把用户的歌挡在门外。
    // 校验函数取自 `constants.js`，不在这里重写 `styles.includes(...)` ——
    // 那等于把「什么算合法」写了两遍。
    const optionalStyleFields = [
      { field: 'dimSuffix', styles: DIM_SUFFIX_STYLES, label: '减三和弦后缀', fallback: 'dim', isValid: isDimSuffixValid },
      { field: 'chordSymbols', styles: CHORD_SYMBOL_STYLES, label: '和弦性质符号体系', fallback: 'common', isValid: isChordSymbolsValid },
      { field: 'accidentalGlyphs', styles: ACCIDENTAL_GLYPH_STYLES, label: '升降号字形', fallback: 'glyph', isValid: isAccidentalGlyphsValid },
      { field: 'seventhSuffix', styles: SEVENTH_SUFFIX_STYLES, label: '属七后缀位置', fallback: 'subscript', isValid: isSeventhSuffixValid },
      { field: 'restText', styles: REST_TEXT_STYLES, label: '休止符写法', fallback: 'cn', isValid: isRestTextValid },
    ];
    for (const { field, styles, label, fallback, isValid } of optionalStyleFields) {
      const value = song.layout[field];
      if (value === undefined) continue; // 缺失 = 合法状态
      if (!isValid(value)) {
        issue(
          errors,
          `layout.${field}`,
          `${label}只能是 ${styles.join(' / ')}（也可以整个省略，省略等价于 '${fallback}'），当前值 ${JSON.stringify(value)}`,
        );
      }
    }
    if (typeof song.layout.fontScale !== 'number' || !Number.isFinite(song.layout.fontScale)) {
      issue(errors, 'layout.fontScale', `字号缩放必须是数值，当前值 ${JSON.stringify(song.layout.fontScale)}`);
    } else if (song.layout.fontScale < LIMITS.fontScaleMin || song.layout.fontScale > LIMITS.fontScaleMax) {
      issue(errors, 'layout.fontScale', `字号缩放必须在 ${LIMITS.fontScaleMin}–${LIMITS.fontScaleMax} 之间，当前值 ${song.layout.fontScale}`);
    }
    // textBlockMode 也是可缺省字段（SPEC §8.10）：缺失等价于 'bar'，存在则必须合法。
    if (song.layout.textBlockMode !== undefined && !isTextBlockModeValid(song.layout.textBlockMode)) {
      issue(errors, 'layout.textBlockMode', `文字块粒度只能是 ${TEXT_BLOCK_MODES.join(' / ')}（也可以整个省略，省略等价于 'bar'），当前值 ${JSON.stringify(song.layout.textBlockMode)}`);
    }
    for (const prop of ['lyricScale', 'chordScale']) {
      if (song.layout[prop] !== undefined && (!Number.isFinite(song.layout[prop]) || song.layout[prop] < 0.6 || song.layout[prop] > 2)) issue(errors, `layout.${prop}`, '字号比例应为 0.6–2');
    }
    if (song.layout.showMelody !== undefined && typeof song.layout.showMelody !== 'boolean') issue(errors, 'layout.showMelody', '简谱开关必须为布尔值');
    for (const prop of ['showLyrics','showMeta','showCues','showBarNumbers','compact']) if (song.layout[prop] !== undefined && typeof song.layout[prop] !== 'boolean') issue(errors, `layout.${prop}`, '显示选项必须为布尔值');
    if (song.layout.numberedKey !== undefined && !parsePitchName(song.layout.numberedKey).ok) issue(errors, 'layout.numberedKey', '简谱的 1=音名无效');
  }

  // ID 全局唯一：复制 / 移动元素时若误用了数组下标，这里会立刻暴露。
  let repeatOpen=false;
  for(const section of Array.isArray(song.sections)?song.sections:[])for(const bar of Array.isArray(section?.bars)?section.bars:[]){
    if(bar?.repeatStart){if(repeatOpen)issue(errors,'sections','暂不支持嵌套反复，请拆成独立的反复段后保存。');repeatOpen=true;}
    if(bar?.repeatEnd)repeatOpen=false;
  }
  const ids = collectIds(song);
  const seen = new Set();
  const duplicated = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  if (duplicated.size > 0) {
    issue(errors, 'id', `存在重复 ID：${[...duplicated].join(', ')}。每个实体必须有独立唯一的 ID，不能用数组下标代替。`);
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * 序列化
 * ------------------------------------------------------------------ */

/**
 * 把歌曲序列化成可保存的 JSON 文本。
 *
 * @param {Song} song
 * @param {{pretty?: boolean}} [options] 默认带缩进，便于人工查看和版本对比。
 * @returns {string}
 */
export function serializeSong(song, options = {}) {
  const { pretty = true } = options;
  const validation = validateSongShape(song);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`serializeSong: 歌曲数据不合法（${validation.errors.length} 处问题），首条：${first.path} ${first.message}`);
  }
  return JSON.stringify(song, null, pretty ? 2 : 0);
}

/**
 * 把旧版本的歌曲数据升级到当前 `schemaVersion`（SPEC §7.4）。
 *
 * 目前只有一处迁移：v1 的 `layout.displayMode`（单个字符串）→ v2 的
 * `layout.displayLines`（1–3 项数组）。旧字段翻译完就**丢掉，永不写回**，
 * 所以升完级的数据里只有一个真相，不会出现两份互相打架的显示偏好。
 *
 * 三条边界：
 * - 不是对象、或版本号不是 1 的输入**原样返回**，交给后面的严格校验去报错。
 *   迁移不该抢校验的活 —— 否则一份版本号是 9999 的文件会得到「迁移失败」
 *   这种没法定位的说法，而不是「不支持这个版本」。
 * - 迁移是**纯函数**：返回新对象，不修改传入的数据。
 * - 迁移的目标是**救回老文件**，不是挡住它。所以显示行的取值走容错版
 *   `normalizeDisplayLines`（认不出的值退化成默认），而不是报错。
 *
 * @param {unknown} raw
 * @returns {unknown} 升级后（或原样）的数据
 */
export function migrateSong(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  if (raw.schemaVersion === 2) return { ...raw, schemaVersion: SCHEMA_VERSION };
  if (raw.schemaVersion !== 1) return raw;

  const layout =
    raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout) ? raw.layout : {};

  const displayLines = normalizeDisplayLines(
    layout.displayLines ?? LEGACY_DISPLAY_MODE_TO_LINES[layout.displayMode],
  );

  const nextLayout = { ...layout, displayLines };
  delete nextLayout.displayMode;

  return { ...raw, schemaVersion: SCHEMA_VERSION, layout: nextLayout };
}

/**
 * 解析并校验一段 JSON 文本，得到歌曲对象。
 *
 * 失败时返回错误列表，调用方必须保持当前数据不变。
 * 导入前先做体积检查，避免一个超大文件把浏览器卡死。
 * v1 的旧文件会先按 §7.4 升级到 v2 再校验（见 `migrateSong`）。
 *
 * @param {string} text
 * @returns {{ok: true, value: Song, errors: []} | {ok: false, value: null, errors: ValidationIssue[]}}
 */
export function deserializeSongText(text) {
  if (typeof text !== 'string') {
    return { ok: false, value: null, errors: [{ path: '', message: `输入必须是字符串，当前类型为 ${describeType(text)}` }] };
  }

  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > LIMITS.maxSongJsonBytes) {
    return {
      ok: false,
      value: null,
      errors: [
        {
          path: '',
          message: `文件体积 ${(byteLength / 1024 / 1024).toFixed(2)} MB 超过上限 ${(LIMITS.maxSongJsonBytes / 1024 / 1024).toFixed(0)} MB，已拒绝导入`,
        },
      ],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, value: null, errors: [{ path: '', message: `不是合法的 JSON：${error.message}` }] };
  }

  // 先迁移再校验（SPEC §7.4）。**顺序不能反** —— 反了的话一份完全合法的 v1
  // 文件会被报成「只支持 schemaVersion = 2」，而那正是这次迁移要救回来的数据。
  const migrated = migrateSong(parsed);
  const validation = validateSongShape(migrated);
  if (!validation.ok) {
    return { ok: false, value: null, errors: validation.errors };
  }
  return { ok: true, value: migrated, errors: [] };
}

/**
 * 把若干条校验问题整理成一段人类可读的文本。
 *
 * @param {ValidationIssue[]} errors
 * @param {number} [maxLines] 最多列出几条，其余折叠为计数。
 * @returns {string}
 */
export function formatValidationIssues(errors, maxLines = 8) {
  const shown = errors.slice(0, maxLines).map((e) => (e.path ? `${e.path}：${e.message}` : e.message));
  if (errors.length > shown.length) {
    shown.push(`…另有 ${errors.length - shown.length} 处问题`);
  }
  return shown.join('\n');
}

/** 暴露给上层，便于在 UI 里直接显示「这首歌每小节应该有多少拍」。 */
export { getBeatsPerBar };

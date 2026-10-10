/**
 * 和弦的解析与格式化。
 *
 * 数据里的和弦只保存「音乐事实」——根音、性质、斜杠低音，
 * 不保存显示字形。和弦名称显示、级数显示、谱面渲染都从这份数据推导，
 * 因此切换显示方式永远不会改动原始数据（见 docs/SPEC.md §6.4）。
 *
 * @module core/chord
 */

import {
  ACCIDENTAL_DISPLAY,
  ACCIDENTAL_INPUT_ALIASES,
  ACCIDENTAL_MAX,
  ACCIDENTAL_MIN,
  CHORD_QUALITIES,
  CHORD_QUALITY_IDS,
  CHORD_SUFFIX_ALIASES,
  PITCH_LETTERS,
  PITCH_LETTER_SEMITONES,
  UNSUPPORTED_CHORD_HINTS,
  getChordQuality,
  getChordSymbol,
} from './constants.js';

/**
 * 一个音名（音级）的写法。
 *
 * @typedef {Object} PitchName
 * @property {string} letter 自然音名，'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'。
 * @property {number} accidental 升降号个数，-2..2（-1 = 一个降号，1 = 一个升号）。
 */

/**
 * 一个和弦的音乐事实。
 *
 * @typedef {Object} Chord
 * @property {string} root 根音音名，形如 'C'、'F#'、'Bb'。
 * @property {string} quality 和弦性质 id，取值见 constants.CHORD_QUALITY_IDS。
 * @property {?string} bass 斜杠低音音名；无斜杠低音时为 null。
 */

/**
 * 解析结果。成功时 `ok` 为 true，失败时带可读的 `message`。
 * 失败绝不返回半个和弦——调用方必须显式处理。
 *
 * `code` 是给程序判断用的稳定标识（见 CHORD_PARSE_CODES），`message` 是给人看的中文说明。
 * 解析器（core/parser.js）靠 `code` 决定往草稿上标哪个错误码，因此**不要**靠匹配
 * `message` 的文案来判断错误类型——文案随时会改，code 不会。
 *
 * @template T
 * @typedef {{ok: true, value: T, message?: undefined, code?: undefined}
 *   | {ok: false, value: null, message: string, code: string}} ParseResult
 */

/**
 * 和弦 / 音名解析的错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const CHORD_PARSE_CODES = Object.freeze({
  /** 和弦名为空。 */
  CHORD_EMPTY: 'E_CHORD_EMPTY',
  /** 根音不是 A–G 开头。 */
  CHORD_BAD_ROOT: 'E_CHORD_BAD_ROOT',
  /** 后缀不是本版支持的九种之一。 */
  CHORD_UNKNOWN_QUALITY: 'E_CHORD_UNKNOWN_QUALITY',
  /** 出现了一个以上的斜杠。 */
  CHORD_MULTIPLE_SLASH: 'E_CHORD_MULTIPLE_SLASH',
  /** 斜杠后缺少低音音名。 */
  CHORD_MISSING_BASS: 'E_CHORD_MISSING_BASS',
  /** 斜杠低音音名非法。 */
  BASS_INVALID: 'E_BASS_INVALID',
  /** 音名为空。 */
  PITCH_EMPTY: 'E_PITCH_EMPTY',
  /** 音名没有以 A–G 开头。 */
  PITCH_BAD_LETTER: 'E_PITCH_BAD_LETTER',
  /** 音名里出现了升降号以外的字符。 */
  PITCH_BAD_CHARACTER: 'E_PITCH_BAD_CHARACTER',
  /** 升降号方向不一致（例如 #b）。 */
  PITCH_ACCIDENTAL_MISMATCH: 'E_PITCH_ACCIDENTAL_MISMATCH',
  /** 升降号个数超出 ±2。 */
  PITCH_ACCIDENTAL_RANGE: 'E_PITCH_ACCIDENTAL_RANGE',
});

/** 规范化升降号字符：♯→#，♭→b，未知字符返回 null。 */
function normalizeAccidentalChar(char) {
  return Object.prototype.hasOwnProperty.call(ACCIDENTAL_INPUT_ALIASES, char)
    ? ACCIDENTAL_INPUT_ALIASES[char]
    : null;
}

/**
 * 解析音名，例如 'C'、'F#'、'Bb'、'E##'。
 *
 * 规则：
 * - 音名必须以 A–G 开头（大小写都接受，内部统一成大写）。
 * - 其后可以跟 0–2 个升降号，且必须是同方向的（'##' 或 'bb'，'#b' 视为错误）。
 * - 不允许出现其它字符。
 *
 * @param {string} text
 * @returns {ParseResult<PitchName>}
 */
export function parsePitchName(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') {
    return { ok: false, value: null, code: CHORD_PARSE_CODES.PITCH_EMPTY, message: '音名为空' };
  }

  const letter = raw[0].toUpperCase();
  if (!PITCH_LETTERS.includes(letter)) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.PITCH_BAD_LETTER,
      message: `"${raw}" 不是有效音名：必须以 A–G 开头`,
    };
  }

  let accidental = 0;
  let seen = null;
  for (let i = 1; i < raw.length; i += 1) {
    const normalized = normalizeAccidentalChar(raw[i]);
    if (normalized === null) {
      return {
        ok: false,
        value: null,
        code: CHORD_PARSE_CODES.PITCH_BAD_CHARACTER,
        message: `"${raw}" 不是有效音名：只允许音名后跟随 # / b（或 ♯ / ♭）`,
      };
    }
    if (seen !== null && seen !== normalized) {
      return {
        ok: false,
        value: null,
        code: CHORD_PARSE_CODES.PITCH_ACCIDENTAL_MISMATCH,
        message: `"${raw}" 的升降号方向不一致，本版只支持同向的 ## 或 bb`,
      };
    }
    seen = normalized;
    accidental += normalized === '#' ? 1 : -1;
  }

  if (accidental < ACCIDENTAL_MIN || accidental > ACCIDENTAL_MAX) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.PITCH_ACCIDENTAL_RANGE,
      message: `"${raw}" 的升降号超出范围，本版支持 ${ACCIDENTAL_MIN} 到 ${ACCIDENTAL_MAX}`,
    };
  }

  return { ok: true, value: { letter, accidental } };
}

/**
 * 把音名格式化成显示字符串。
 *
 * @param {PitchName} pitch
 * @param {{glyphs?: boolean}} [options] `glyphs` 为 true 时用 ♯ / ♭（谱面显示默认值），
 *   为 false 时用 ASCII 的 # / b（调试、纯文本场景）。
 * @returns {string}
 */
export function formatPitchName(pitch, options = {}) {
  const { glyphs = true } = options;
  if (!pitch || !PITCH_LETTERS.includes(pitch.letter)) return '';
  const count = Math.abs(pitch.accidental);
  const symbol = pitch.accidental > 0 ? '#' : 'b';
  const char = glyphs ? ACCIDENTAL_DISPLAY[symbol] : symbol;
  return pitch.letter + char.repeat(count);
}

/**
 * 音名 → 半音序号（0..11，C = 0）。用于级数推导和后续移调。
 *
 * @param {PitchName} pitch
 * @returns {number}
 */
export function pitchNameToSemitone(pitch) {
  const base = PITCH_LETTER_SEMITONES[pitch.letter];
  if (base === undefined) return Number.NaN;
  return (((base + pitch.accidental) % 12) + 12) % 12;
}

/**
 * 解析和弦名，例如 'C'、'Am7'、'G/B'、'F#m'、'Bbmaj7'。
 *
 * @param {string} text
 * @returns {ParseResult<Chord>}
 */
export function parseChordSymbol(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') {
    return { ok: false, value: null, code: CHORD_PARSE_CODES.CHORD_EMPTY, message: '和弦名为空' };
  }

  const slashParts = raw.split('/');
  if (slashParts.length > 2) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_MULTIPLE_SLASH,
      message: `"${raw}" 含有多个斜杠，本版只支持一个斜杠低音（例如 G/B）`,
    };
  }

  const [rootPart, bassPart] = slashParts.map((part) => part.trim());
  if (rootPart === '') {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_BAD_ROOT,
      message: `"${raw}" 的斜杠前缺少和弦根音`,
    };
  }

  const rootParsed = parsePitchNameWithSuffix(rootPart);
  if (!rootParsed.ok) {
    // 根音部分的错误码原样上抛：`E_CHORD_BAD_ROOT`（字母问题）和
    // `E_PITCH_ACCIDENTAL_*`（升降号问题）是两类不同的修法，报错要能区分。
    return rootParsed;
  }

  if (slashParts.length === 2 && bassPart === '') {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_MISSING_BASS,
      message: `"${raw}" 的斜杠后缺少低音音名`,
    };
  }

  // 低音的音名错误统一归类为 E_BASS_INVALID，但保留底层 message 的细节
  // （是字母写错还是升降号写错，用户看到说明才知道怎么改）。
  let bass = null;
  if (slashParts.length === 2) {
    const bassParsed = parsePitchName(bassPart);
    if (!bassParsed.ok) {
      return {
        ok: false,
        value: null,
        code: CHORD_PARSE_CODES.BASS_INVALID,
        message: `斜杠低音无效：${bassParsed.message}`,
      };
    }
    bass = formatPitchName(bassParsed.value, { glyphs: false });
  }

  return {
    ok: true,
    value: {
      root: formatPitchName(rootParsed.value.pitch, { glyphs: false }),
      quality: rootParsed.value.quality,
      bass,
    },
  };
}

/**
 * 把形如 'F#m7' 的字符串拆成音名部分和性质后缀部分。
 * 音名部分允许带 1–2 个同向升降号；剩余部分必须完全等于某个已支持的性质后缀。
 *
 * @param {string} text
 * @returns {ParseResult<{pitch: PitchName, quality: string}>}
 */
function parsePitchNameWithSuffix(text) {
  const letter = text[0].toUpperCase();
  if (!PITCH_LETTERS.includes(letter)) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_BAD_ROOT,
      message: `"${text}" 不是有效和弦名：必须以 A–G 开头`,
    };
  }

  let index = 1;
  let accidental = 0;
  let seen = null;
  while (index < text.length) {
    const normalized = normalizeAccidentalChar(text[index]);
    if (normalized === null) break;
    if (seen !== null && seen !== normalized) {
      return {
        ok: false,
        value: null,
        code: CHORD_PARSE_CODES.PITCH_ACCIDENTAL_MISMATCH,
        message: `"${text}" 的升降号方向不一致，本版只支持同向的 ## 或 bb`,
      };
    }
    seen = normalized;
    accidental += normalized === '#' ? 1 : -1;
    index += 1;
    if (Math.abs(accidental) > ACCIDENTAL_MAX) break;
  }

  if (accidental < ACCIDENTAL_MIN || accidental > ACCIDENTAL_MAX) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.PITCH_ACCIDENTAL_RANGE,
      message: `"${text}" 的升降号超出范围，本版支持 ${ACCIDENTAL_MIN} 到 ${ACCIDENTAL_MAX}`,
    };
  }

  const suffix = text.slice(index);
  const quality = matchQualitySuffix(suffix);
  if (quality === null) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_UNKNOWN_QUALITY,
      message: describeUnknownQuality(suffix, text),
    };
  }

  return { ok: true, value: { pitch: { letter, accidental }, quality } };
}

/**
 * 匹配和弦性质后缀（SPEC §5.2.1，决策点 H「放开输入」）。
 *
 * 匹配的是 `symbol` 与 `aliases` 的并集，所以 `maj7` `M7` `Δ7` 都会读成同一个 `maj7`。
 * **数据里只留性质 id**，不存在「用户打的是哪种写法」这个信息 —— 这是 SPEC §6.4
 * 「显示偏好不进数据」在不同场景下的同一个要求。
 *
 * 用**精确相等**比较，所以结果与表的顺序无关（表按长度降序只是为了读起来清楚）。
 * 空后缀仍然等价于大三和弦。
 *
 * @param {string} suffix
 * @returns {string|null} 性质 id；无匹配返回 null。
 */
export function matchQualitySuffix(suffix) {
  if (suffix === '') return 'maj';
  const hit = CHORD_SUFFIX_ALIASES.find((entry) => entry.suffix === suffix);
  return hit ? hit.qualityId : getChordQuality(suffix)?.id ?? null;
}

/**
 * 生成「不支持的和弦写法」的说明文字。
 *
 * 已知的常见写法给出针对性提示（`UNSUPPORTED_CHORD_HINTS`），其余给出支持列表。
 * 提示里列的是**通用后缀**，但消息里要说清别名也认 ——
 * 否则用户刚打的 `Δ7` 被拒，看到「本版支持：maj7 …」会以为是自己拼错了，
 * 而实际上真正的原因多半是那几个**本版没有的**和弦（`ø` / `9` / `6`）。
 *
 * @param {string} suffix
 * @param {string} fullText
 * @returns {string}
 */
function describeUnknownQuality(suffix, fullText) {
  // 按**声明顺序**列出，不按长度排序 —— 这条消息是给人看的，
  // `maj7 / sus2 / sus4 / dim / aug / m7 / m / 7` 那种顺序读起来毫无头绪。
  const supported = CHORD_QUALITIES.filter((q) => q.symbol !== '')
    .map((q) => q.symbol)
    .join(' / ');
  const hint = UNSUPPORTED_CHORD_HINTS.find((entry) => entry.pattern.test(suffix));
  const base = `"${fullText}" 里的后缀 "${suffix}" 不是本版支持的和弦性质`;
  const tail = hint
    ? hint.message
    : `本版支持的后缀：${supported}（大三和弦不写后缀）。写成 M7 / Δ7 / -7 这类常见别名也认。`;
  return `${base}。${tail}`;
}

/**
 * 把和弦格式化成和弦名，例如 'G/B'、'CΔ7'。
 *
 * 两个选项彼此正交，都**只影响这一串字长什么样**，不影响数据：
 *
 * - `glyphs`  —— 升降号画成 `♯` `♭`（默认）还是 ASCII 的 `#` `b`。
 *   内部规范化存储（`createChord` / `parseChordSymbol`）一律传 `false`，
 *   因为 SPEC §2.2 要求数据里只存 ASCII。歌曲级设置请用
 *   `usesAccidentalGlyphs(song.layout?.accidentalGlyphs)` 算出这个布尔值。
 * - `symbols` —— 和弦性质用哪套符号体系（SPEC §5.1.1，`'common'` / `'jazz'`）。
 *
 * @param {Chord} chord
 * @param {{glyphs?: boolean, symbols?: 'common'|'jazz'}} [options]
 * @returns {string}
 */
export function formatChordSymbol(chord, options = {}) {
  if (!chord || typeof chord !== 'object') return '';
  const root = parsePitchName(chord.root);
  if (!root.ok) return chord.root ?? '';
  const qualitySymbol = getChordSymbol(chord.quality, options.symbols);

  let text = formatPitchName(root.value, options) + qualitySymbol;
  if (chord.bass) {
    const bass = parsePitchName(chord.bass);
    text += `/${bass.ok ? formatPitchName(bass.value, options) : chord.bass}`;
  }
  return text;
}

/**
 * 把和弦格式化成「和弦名 + 性质中文名」，用于编辑面板和校验报告。
 *
 * @param {Chord} chord
 * @returns {string}
 */
export function formatChordLabel(chord) {
  const symbol = formatChordSymbol(chord);
  const quality = getChordQuality(chord.quality);
  if (!quality) return symbol;
  const bassParsed = chord.bass ? parsePitchName(chord.bass) : null;
  const bassName = bassParsed && bassParsed.ok ? formatPitchName(bassParsed.value, { glyphs: false }) : chord.bass;
  return chord.bass ? `${symbol}（${quality.label}，低音 ${bassName}）` : `${symbol}（${quality.label}）`;
}

/**
 * 构造一个和弦对象。逐项校验，错误信息直接指向出问题的那一部分。
 *
 * 注意：这里 **分别** 校验根音、性质、低音，而不是把三段拼成一个字符串再解析。
 * 拼字符串会让 "根音写错" 和 "性质写错" 混成一条含糊的报错，
 * 而且一旦根音里混进后缀（例如把 Am 填进 root），拼接就会产生误导性的错误。
 *
 * @param {{root: string, quality?: string, bass?: string|null}} input
 * @returns {ParseResult<Chord>}
 */
export function createChord(input) {
  const rootText = String(input?.root ?? '').trim();
  const rootParsed = parsePitchName(rootText);
  if (!rootParsed.ok) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_BAD_ROOT,
      message: `根音无效：${rootParsed.message}`,
    };
  }

  const qualityId = input?.quality ?? 'maj';
  const quality = getChordQuality(qualityId);
  if (!quality) {
    return {
      ok: false,
      value: null,
      code: CHORD_PARSE_CODES.CHORD_UNKNOWN_QUALITY,
      message: `未知和弦性质 "${qualityId}"，可用取值：${CHORD_QUALITY_IDS.join(' / ')}`,
    };
  }

  const bassText = input?.bass === undefined || input?.bass === null ? '' : String(input.bass).trim();
  let bass = null;
  if (bassText !== '') {
    const bassParsed = parsePitchName(bassText);
    if (!bassParsed.ok) {
      return {
        ok: false,
        value: null,
        code: CHORD_PARSE_CODES.BASS_INVALID,
        message: `斜杠低音无效：${bassParsed.message}`,
      };
    }
    bass = formatPitchName(bassParsed.value, { glyphs: false });
  }

  return {
    ok: true,
    value: {
      root: formatPitchName(rootParsed.value, { glyphs: false }),
      quality: quality.id,
      bass,
    },
  };
}

/** 供外部使用的受支持和弦性质 id 列表（只读）。 */
export const SUPPORTED_QUALITY_IDS = CHORD_QUALITY_IDS;

/**
 * 数字功能谱：把和弦换算成大调级数（docs/SPEC.md §6）。
 *
 * ## 核心：级数由「字母距离」决定，不是「半音距离」
 *
 * 这条如果搞反了，输出会错得很难看，但表面上又很像对的。看一个例子：
 *
 * - `F#` 在 C 大调里是 `#4`（F 是 C 的**第 4 个字母**，需要升号才是调内音）
 * - `F#` 在 G 大调里是 `7`（F 是 G 的**第 7 个字母**，G 大调本来就有 F#）
 *
 * 同一个音、同一个半音位置，级数完全不同。如果按半音距离算，两个都会得到
 * 同一个答案，其中一个必然是错的。所以 §6.1 的算法是：
 *
 * ```
 * 级数 = 字母距离（mod 7）+ 1        ← 决定了「几级」
 * 升降号前缀 = 实际升降号 - 该级在本调应有的升降号   ← 决定了「#/b」
 * ```
 *
 * 第二步的 `expectAcc` 是「本调中这一级本来该带什么升降号」。C 大调没有升降号，
 * 所以 F# 的 `expectAcc = 0`，`delta = 1-0 = 1` → 前缀一个 `#`。
 * G 大调的第 7 级本来就该是 F#，`expectAcc = 1`，`delta = 0` → 不带前缀。
 *
 * ## 本版只支持大调
 *
 * `key.mode !== 'major'` 时直接报错，**不会**把小调当关系大调去算（§6.5）。
 * 那会安静地输出一份错误结果——比报错糟得多。
 *
 * @module core/degrees
 */

import {
  DEFAULT_SEVENTH_SUFFIX,
  MAJOR_SCALE_SEMITONES,
  PITCH_LETTERS,
  PITCH_LETTER_SEMITONES,
  getChordQuality,
  normalizeDimSuffix,
  normalizeSeventhSuffix,
  usesAccidentalGlyphs,
} from './constants.js';
import { parsePitchName } from './chord.js';
import { Note, Scale } from 'tonal';

/**
 * 级数转换的错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const DEGREE_CODES = Object.freeze({
  /** 调号不是大调，级数推导未实现。 */
  MODE_UNSUPPORTED: 'E_DEGREE_MODE_UNSUPPORTED',
  /** 调号主音不是有效音名。 */
  TONIC_INVALID: 'E_DEGREE_TONIC_INVALID',
  /** 和弦根音或低音不是有效音名。 */
  PITCH_INVALID: 'E_DEGREE_PITCH_INVALID',
  /** 和弦性质不在支持列表里。 */
  QUALITY_UNKNOWN: 'E_DEGREE_QUALITY_UNKNOWN',
});

/**
 * 级数记法里后缀需要**特殊处理**的和弦性质。现在只有属七一项。
 *
 * 属七和弦的级数是 `57` —— 两个数字直接粘在一起，第一眼容易被读成「五十七」。
 * 所以它的后缀要按 `layout.seventhSuffix` 的规则单独摆位（SPEC §6.6）：
 * 缺省是右下角小角标（`5` + 小 `7`），也可写成 `57` / `5⁷` / `5(7)`。
 *
 * **这个集合只有属七一项，而且这一轮没有扩大它的计划**（SPEC §11 第 12 条）。
 * 理由是：小七 `1m7`、大七 `1maj7` 的和弦性质符号里带字母，数字之间不会相邻；
 * `#4dim`、`5sus4` 同理。只有属七的符号是**纯数字**，才会和根音的级数数字连成一片。
 *
 * **注意「写成什么样」和「谁需要特殊处理」是两个决策点。** 这一轮放开了前者
 * （`seventhSuffix` 四档），刻意**没有**放开后者 —— 改字形是低风险改动，
 * 改「谁需要特殊处理」会波及每一个和弦块。
 *
 * @type {ReadonlySet<string>}
 */
const SEVENTH_QUALITY_IDS = new Set(['7']);

/**
 * 按 `seventhSuffix` 的档位，把属七的后缀切成一个 `parts` 片段。
 *
 * 四档里 **`'parens'` 是唯一一个改变 `value` 的**：括号是这个写法的组成部分，
 * 不是排版。另外三档改的只是同一串字符怎么摆位。
 *
 * @param {string} suffix 后缀文字（属七恒为 `'7'`，罗马字形下也是 `'7'`）
 * @param {unknown} style
 * @returns {{text: string, script: ?'sub'|'sup'}}
 */
function buildSeventhSuffixPart(suffix, style) {
  switch (normalizeSeventhSuffix(style)) {
    case 'parens':
      return { text: `(${suffix})`, script: null };
    case 'superscript':
      return { text: suffix, script: 'sup' };
    case 'subscript':
      return { text: suffix, script: 'sub' };
    case 'plain':
    default:
      return { text: suffix, script: null };
  }
}


/** 罗马数字字形表（SPEC §6.7）。下标是「第几级 − 1」。 */
const ROMAN_NUMERALS = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']);

/**
 * 罗马数字字形下，后缀要如何改写（SPEC §6.7）。
 *
 * **`m` 后缀被大小写吸收**，不能重复表达：小写 `i` 已经说明这是小三和弦，
 * 再补一个 `m` 就成了 `im` —— 同一件事在一套字形里说了两遍。
 * 只有这两个性质需要改写；其余后缀（`maj7` `dim` `aug` `sus2` `sus4`）原样保留。
 */
const ROMAN_SUFFIX_REWRITE = Object.freeze({ m: '', m7: '7' });

/** 罗马数字字形下，级数要写成**小写**的和弦性质（小三 / 小七 / 减三）。 */
const ROMAN_LOWERCASE_QUALITIES = new Set(['m', 'm7', 'dim']);

/** 把级数记号里的罗马数字部分转小写，升降号前缀原样保留（`#IV` → `#iv`）。 */
function lowercaseRoman(token) {
  return String(token).replace(/[IV]+/g, (match) => match.toLowerCase());
}

/**
 * 把一个半音差规约到 [-6, +6]，用于判断「该写成升号还是降号」。
 *
 * `12` 和 `-12` 是同一个音，但我们只接受最小写法：
 * 差 11 个半音其实等于差 -1 个半音，前缀应该写一个 `b` 而不是十一个 `#`。
 *
 * @param {number} delta 半音差
 * @returns {number}
 */
function signedDiff(delta) {
  const wrapped = ((delta % 12) + 12) % 12;
  return wrapped > 6 ? wrapped - 12 : wrapped;
}

/** 取音名在 C D E F G A B 中的下标（C = 0）。 */
function letterIndex(letter) {
  return PITCH_LETTERS.indexOf(letter);
}

/**
 * 把一个音名换算成「相对调主音的级数记号」，例如 `#4`、`b7`、`3`。
 *
 * 只做级数本身，不带和弦性质后缀——这样它能被复用于根音和斜杠低音两处。
 *
 * 字形由 `glyph` 决定（SPEC §6.7）：阿拉伯数字给 `#4` / `b7` / `3`，
 * 罗马数字给 `#IV` / `bVII` / `III`。**大小写不在这里定** ——
 * 罗马数字的大小写取决于和弦性质，由 `chordToDegree` 统一处理。
 *
 * @param {import('./chord.js').PitchName} pitch 要换算的音名
 * @param {import('./chord.js').PitchName} tonic 调主音
 * @param {'arabic'|'roman'} [glyph] 字形，默认阿拉伯数字
 * @returns {string} 形如 `#4` / `b7` / `3`；输入不合法时返回空串。
 */
export function pitchToDegreeToken(pitch, tonic, glyph = 'arabic', mode = 'major') {
  if (!pitch || !tonic) return '';
  const toLetter = letterIndex(pitch.letter);
  const tonicLetter = letterIndex(tonic.letter);
  if (toLetter < 0 || tonicLetter < 0) return '';

  // 第 2 步：级数由字母距离决定
  const degree = ((toLetter - tonicLetter) % 7 + 7) % 7 + 1;

  // 第 1、3、4 步：算出本调中这一级「本来该带什么升降号」
  const tonicSemitone = PITCH_LETTER_SEMITONES[tonic.letter] + tonic.accidental;
  const minorNote = mode === 'minor' ? Scale.get(`${tonic.root ?? tonic.letter + (tonic.accidental > 0 ? '#'.repeat(tonic.accidental) : 'b'.repeat(-tonic.accidental))} minor`).notes[degree - 1] : null;
  const expectSemitone = minorNote ? Note.get(minorNote).chroma : ((tonicSemitone + MAJOR_SCALE_SEMITONES[degree - 1]) % 12 + 12) % 12;
  const naturalSemitone = PITCH_LETTER_SEMITONES[pitch.letter];
  const expectAccidental = signedDiff(expectSemitone - naturalSemitone);

  // 第 6、7 步：实际升降号与应有升降号之差，就是前缀
  const delta = pitch.accidental - expectAccidental;
  const prefix = delta > 0 ? '#'.repeat(delta) : delta < 0 ? 'b'.repeat(-delta) : '';

  // 第 8 步：只有字形不同。阿拉伯给 `4`，罗马给 `IV` —— 前面的字母距离、
  // 升降号判断完全共用，这也是「两种字形不可能算出不同级数」的原因。
  const numeral = glyph === 'roman' ? ROMAN_NUMERALS[degree - 1] : String(degree);

  return `${prefix}${numeral}`;
}

/**
 * 把整首歌的调号解析成算法需要的两个音名。
 *
 * @param {{tonic?: string, mode?: string}} key
 * @returns {{ok: true, tonic: import('./chord.js').PitchName} | {ok: false, code: string, message: string}}
 */
function resolveTonic(key) {
  if (!key || typeof key !== 'object') {
    return { ok: false, code: DEGREE_CODES.TONIC_INVALID, message: '调号缺失，无法换算级数' };
  }
  if (!['major', 'minor'].includes(key.mode)) {
    return {
      ok: false,
      code: DEGREE_CODES.MODE_UNSUPPORTED,
      message: `当前调式 ${JSON.stringify(key.mode)} 尚不支持级数换算，请使用和弦名。`,
    };
  }
  const parsed = parsePitchName(String(key.tonic ?? ''));
  if (!parsed.ok) {
    return { ok: false, code: DEGREE_CODES.TONIC_INVALID, message: `调号主音无效：${parsed.message}` };
  }
  return { ok: true, tonic: parsed.value };
}

/**
 * 把和弦换算成级数记号，例如 `1`、`6m7`、`#4dim`、`1/5`。
 *
 * @param {import('./chord.js').Chord} chord
 * @param {{tonic?: string, mode?: string}} key
 * @param {'arabic'|'roman'} [glyph] 字形（SPEC §6.7），默认阿拉伯数字
 * @param {'dim'|'°'} [dimSuffix] 减三和弦后缀的写法（SPEC §6.7.1），默认 `'dim'`。
 *   **两种字形共用这一个值**：设成 `'°'` 时数字行与罗马行同时变，
 *   否则并排会出现 `7dim` 与 `vii°` 并存，看着像两个不同的和弦。
 * @param {'subscript'|'plain'|'superscript'|'parens'} [seventhSuffix] 属七后缀 `7`
 *   的位置（SPEC §6.6），默认 `'subscript'`（右下角小角标）。认不出的值退化到缺省。
 *
 * 三个风格参数都是**可缺省的**，缺省值等于引入各自开关之前的观感；它们也都**读容错**
 * （认不出退化成缺省，不报错），因为它们收到的值来自工程文件与 localStorage。
 *
 * `value` 是这段记号的纯文本（缺省档下是 `57`）；`parts` 是它按语义切开的片段
 * （`[{5}, {7, script:'sub'}]`），供谱面把后缀画成角标 / 上标 / 括号。
 * **`parts` 拼起来必然等于 `value`** —— 而且这个 `value` 就是由 `parts` 拼出来的，
 * 所以这条不变式不会因为多一个档位而失效。
 *
 * @returns {{ok: true, value: string, parts: Array<{text: string, script: null|'sub'|'sup'}>}
 *   | {ok: false, value: null, parts: null, code: string, message: string}}
 */
export function chordToDegree(chord, key, glyph = 'arabic', dimSuffix = 'dim', seventhSuffix = DEFAULT_SEVENTH_SUFFIX) {
  const tonicResult = resolveTonic(key);
  if (!tonicResult.ok) {
    return { ok: false, value: null, parts: null, code: tonicResult.code, message: tonicResult.message };
  }
  const { tonic } = tonicResult;

  const rootParsed = parsePitchName(String(chord?.root ?? ''));
  if (!rootParsed.ok) {
    return {
      ok: false,
      value: null,
      parts: null,
      code: DEGREE_CODES.PITCH_INVALID,
      message: `和弦根音无效：${rootParsed.message}`,
    };
  }

  const quality = getChordQuality(chord?.quality);
  if (!quality) {
    return {
      ok: false,
      value: null,
      parts: null,
      code: DEGREE_CODES.QUALITY_UNKNOWN,
      message: `未知和弦性质 ${JSON.stringify(chord?.quality)}，无法换算级数`,
    };
  }

  const useRoman = glyph === 'roman';

  // 罗马字形下大小写由和弦性质决定（小三系写小写），并且 `m` 后缀要被大小写吸收 ——
  // 见本文件顶部的 ROMAN_SUFFIX_REWRITE 说明。
  const rootTokenRaw = pitchToDegreeToken(rootParsed.value, tonic, glyph, key.mode);
  const rootToken =
    useRoman && (ROMAN_LOWERCASE_QUALITIES.has(quality.id) || /^m(?!aj)/.test(quality.id)) ? lowercaseRoman(rootTokenRaw) : rootTokenRaw;

  // #### 后缀文字：三套规则，优先级从高到低
  //
  // 1. **减三后缀可切换**（SPEC §6.7.1）：`'dim'` → `7dim` / `viidim`，`'°'` → `7°` / `vii°`。
  // 2. **罗马字形下 `m` 被大小写吸收**：`6m7` → `vi7`，`6m` → `vi`。
  // 3. 其余原样用 `quality.symbol`。
  //
  // 第 1 条放在罗马改写**之前**，而且两者不可能打架：`dim` 不在 `ROMAN_SUFFIX_REWRITE` 里
  // （罗马字形下大小写已经承担了「小」这层意思，后缀本来就不需要改）。顺序照这个写清楚，
  // 接手的人不必自己去推。
  //
  // 顺手走一遍 `normalizeDimSuffix`：这里是级数唯一的产出点，而它收到的值来自
  // 工程文件与 localStorage。「一个拼错的写法让整首歌加载失败」不值得省这一次容错。
  //
  // **注意第 3 条用的是 `quality.symbol`，不是 `getChordSymbol(...)`。** 这是刻意的：
  // 级数行**不跟随** `chordSymbols` 那个开关（SPEC §5.1.1）。级数行已经有自己的一套
  // 更严格的约定（大小写承担性质、`m` 被吸收、减三后缀单独可配），再叠一层符号体系
  // 会直接打架 —— 比如爵士体系下 `m7` 写成 `-7`，级数行就会出现 `6-7`，看着像负数。
  const suffix =
    quality.id === 'dim' && normalizeDimSuffix(dimSuffix) === '°'
      ? '°'
      : useRoman && Object.prototype.hasOwnProperty.call(ROMAN_SUFFIX_REWRITE, quality.id)
        ? ROMAN_SUFFIX_REWRITE[quality.id]
        : useRoman && /^m(?!aj)/.test(quality.id) ? quality.symbol.slice(1) : quality.symbol;

  /** @type {Array<{text: string, script: null|'sub'|'sup'}>} */
  const parts = [{ text: rootToken, script: null }];
  if (suffix !== '') {
    // 属七的后缀按 `seventhSuffix` 摆位（SPEC §6.6）：角标 / 平写 / 上标 / 括号。
    // 其余性质一律普通段落 —— 需要特殊处理的范围仍然只有属七一项。
    parts.push(
      SEVENTH_QUALITY_IDS.has(quality.id)
        ? buildSeventhSuffixPart(suffix, seventhSuffix)
        : { text: suffix, script: null },
    );
  }

  // 斜杠低音用同一套算法单独换算（§6.3），再拼成 `级数/低音级数`
  if (chord.bass) {
    const bassParsed = parsePitchName(String(chord.bass));
    if (!bassParsed.ok) {
      return {
        ok: false,
        value: null,
        parts: null,
        code: DEGREE_CODES.PITCH_INVALID,
        message: `斜杠低音无效：${bassParsed.message}`,
      };
    }
    // 斜杠低音只换算音名、不带和弦性质，所以不跟随上面那条大小写规则
    const bassToken = pitchToDegreeToken(bassParsed.value, tonic, glyph, key.mode);
    parts.push({ text: `/${bassToken}`, script: null });
  }

  // `value` 从 `parts` 拼出来。这样「两者拼起来必然相等」这条不变式是**结构上成立**的，
  // 而不是靠两个地方各拼一遍再指望它们不漂移 —— 以前 `text` 是单独累加的，
  // 加一个「括号档」就得记得同时改两处，忘一处测试才发现。
  const text = parts.map((part) => part.text).join('');

  return { ok: true, value: text, parts };
}

/**
 * 按显示方式格式化一个和弦：和弦名或级数。
 *
 * 级数换算失败时**回退到和弦名**，并把原因放进 `note`——
 * 界面上宁可显示一个正确但没转换的和弦名，也不要显示一个可能错误的级数。
 *
 * @param {import('./chord.js').Chord} chord
 * @param {{line?: 'chord'|'degree'|'roman', key?: {tonic?: string, mode?: string},
 *   dimSuffix?: 'dim'|'°', seventhSuffix?: 'subscript'|'plain'|'superscript'|'parens',
 *   chordSymbols?: 'common'|'jazz', accidentalGlyphs?: 'glyph'|'ascii'}} options
 *   `line` 是要渲染的那一行（SPEC §8.1.1）：`'chord'` 和弦名、`'degree'` 数字级数、
 *   `'roman'` 罗马级数。
 *
 *   **四个风格选项各管一段，互不重叠：**
 *   - `chordSymbols` / `accidentalGlyphs` —— **只对和弦名那一行有效**，走早期返回。
 *   - `dimSuffix` / `seventhSuffix` —— **只对级数行有效**，和弦名不受影响。
 *
 *   这个划分是刻意的（SPEC §5.1.1、§6.6）：级数行有自己一套更严格的约定
 *   （大小写承担性质、`m` 被吸收），把和弦名的符号体系也叠上去会直接打架。
 *
 *   全部四个都是**可缺省**的，缺省值等于各自的旧行为；且都读容错。
 * @param {(chord: import('./chord.js').Chord,
 *   options?: {glyphs?: boolean, symbols?: 'common'|'jazz'}) => string} formatChordSymbol
 *   由调用方注入 core/chord.js 的 `formatChordSymbol`，避免本模块反向依赖格式化层。
 * @returns {{text: string, parts: Array<{text: string, script: null|'sub'|'sup'}>, usedDegree: boolean, note: ?string}}
 */
export function formatChordForDisplay(chord, options, formatChordSymbol) {
  const line = options?.line ?? 'chord';
  // 和弦名跟随 `chordSymbols` + `accidentalGlyphs`；`usesAccidentalGlyphs` 是全应用
  // 唯一一处「风格 → 是否用 ♯♭ 字形」的映射，别在这里自己写 `!== 'ascii'`。
  const chordText = formatChordSymbol(chord, {
    symbols: options?.chordSymbols,
    glyphs: usesAccidentalGlyphs(options?.accidentalGlyphs),
  });
  // 和弦名没有「性质后缀」这个概念，整串就是一段 —— 保证 parts 恒不为空
  const chordParts = [{ text: chordText, script: null }];

  if (line === 'chord') {
    return { text: chordText, parts: chordParts, usedDegree: false, note: null };
  }

  const converted = chordToDegree(
    chord,
    options?.key ?? {},
    line === 'roman' ? 'roman' : 'arabic',
    options?.dimSuffix,
    options?.seventhSuffix,
  );
  if (!converted.ok) {
    // 换算不了就回退到和弦名（§6.4）—— 宁可显示一个没转换但对的和弦名，
    // 也不显示一个可能错的级数。原因放进 note，界面据此给出提示。
    return { text: chordText, parts: chordParts, usedDegree: false, note: converted.message };
  }
  return { text: converted.value, parts: converted.parts, usedDegree: true, note: null };
}

/**
 * 当前调号是否支持级数显示。界面用它决定要不要把「级数」选项置灰并给出说明。
 *
 * @param {{tonic?: string, mode?: string}} key
 * @returns {{ok: boolean, message: ?string}}
 */
export function canShowDegrees(key) {
  const result = resolveTonic(key);
  return result.ok ? { ok: true, message: null } : { ok: false, message: result.message };
}

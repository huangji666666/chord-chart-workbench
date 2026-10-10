/**
 * 全局常量与枚举表。
 *
 * 设计原则：所有「音乐语义」的枚举都集中在这里，解析器、校验器、渲染器和导出器
 * 必须共用同一张表，避免各自维护一份互相漂移的规则。
 *
 * @module core/constants
 */

/**
 * 当前数据结构的版本号。写入工程文件，导入时用于兼容性判断。
 *
 * v1 → v2 只差一处：`layout.displayMode`（单个字符串）换成了 `layout.displayLines`
 * （1–3 项数组）。迁移规则见 docs/SPEC.md §7.4。
 */
import { Chord as TonalChord } from 'tonal';

export const SCHEMA_VERSION = 3;

/**
 * 支持的拍号。
 *
 * 时值单位（拍）的定义见 docs/SPEC.md §3.1：
 * 每小节的拍数 = beatsPerBar；1 拍等于拍号分母所表示的音符时值。
 *
 * @type {Readonly<Record<string, {beatsPerBar: number, beatNote: 'quarter'|'eighth', label: string, hint: string}>>}
 */
export const TIME_SIGNATURES = Object.freeze({
  '4/4': Object.freeze({
    beatsPerBar: 4,
    beatNote: 'quarter',
    label: '4/4',
    hint: '四分音符 = 1 拍，每小节 4 拍',
  }),
  '3/4': Object.freeze({
    beatsPerBar: 3,
    beatNote: 'quarter',
    label: '3/4',
    hint: '四分音符 = 1 拍，每小节 3 拍',
  }),
  '6/8': Object.freeze({
    beatsPerBar: 6,
    beatNote: 'eighth',
    label: '6/8',
    hint: '八分音符 = 1 拍，每小节 6 拍。注意：这里的 1 拍是八分音符，不是附点四分音符的「大拍」（一个附点四分音符 = 3 拍）',
  }),
});

/** @type {readonly string[]} */
export const TIME_SIGNATURE_IDS = Object.freeze(Object.keys(TIME_SIGNATURES));

export const DEFAULT_TIME_SIGNATURE = '4/4';

/**
 * 取某拍号下每小节的拍数。
 * @param {string} timeSignature 例如 "4/4"
 * @returns {number} 每小节拍数；拍号不受支持时返回 0
 */
export function getBeatsPerBar(timeSignature) {
  const entry = TIME_SIGNATURES[timeSignature];
  return entry ? entry.beatsPerBar : 0;
}

/** 每行小节数可选项（谱面排版设置）。 */
export const BARS_PER_ROW_OPTIONS = Object.freeze([2, 4, 8]);
export const DEFAULT_BARS_PER_ROW = 4;

/**
 * 谱面「显示行」—— 一个和弦块可以同时显示最多三行标签（SPEC §8.1.1）。
 *
 * - `chord`  和弦名（`Cm7`）
 * - `degree` 数字级数（`1m7`）
 * - `roman`  罗马数字级数（`i7`）
 *
 * 顺序是**固定**的：`chord → degree → roman`，从上到下。用户只能选显示哪几行，
 * 不能调换顺序 —— 固定顺序让「哪一行是什么」始终可预期，也让组合数不至于无意义地膨胀。
 */
export const DISPLAY_LINE_IDS = Object.freeze(['chord', 'degree', 'roman']);

/** 需要「调号是大调」才能显示的两种级数行（SPEC §6.5）。 */
export const DEGREE_LINE_IDS = Object.freeze(['degree', 'roman']);

/** 一个和弦块最多能同时显示几行。 */
export const MAX_DISPLAY_LINES = 3;

/** 默认只显示和弦名 —— 与 v1 的默认一致，老用户升级后观感不变。 */
export const DEFAULT_DISPLAY_LINES = Object.freeze(['chord']);

/**
 * 级数的字形（SPEC §6.7）。阿拉伯数字与罗马数字由同一套算法产出，只差最后一步字形表。
 */
export const DEGREE_GLYPHS = Object.freeze(['arabic', 'roman']);

/**
 * 级数行里**减三和弦后缀**的两种写法（SPEC §6.7.1）。
 *
 * 两种都在用，所以做成可选：`dim` 是本站缺省（与旧行为一致），`°` 是学院派写法。
 * 取值直接存字形本身（而不是 `'dim' | 'symbol'` 这类语义 ID）—— 只有两项、
 * 校验表就这么小，而 `°` 在 JSON 里一眼可读，比多一层映射更不容易被接手的人看错。
 *
 * **只作用于级数记法，不作用于和弦名**：`°` 是级数的后缀，和弦名永远写 `Bdim`。
 * 混淆这两件事会让「显示偏好」渗进「和弦数据」，那是本文件顶部那条原则的反面。
 */
export const DIM_SUFFIX_STYLES = Object.freeze(['dim', '°']);

/** 缺省写法。缺省值**必须**等于旧行为，否则就成了「悄悄改变用户已有的谱子」。 */
export const DEFAULT_DIM_SUFFIX = 'dim';

/**
 * 自由文字块的两种粒度（SPEC §8.10）。
 *
 * - `'bar'`  按小节写：一个小节一个大文本框，写整段词。新建块默认 `anchor = -1`。
 * - `'chord'` 按和弦写：每个和弦下方单独一个小框。新建块默认 `anchor = 对应和弦下标`。
 *
 * 切换**只改变新建块的默认锚点**，不动已有块。
 */
export const TEXT_BLOCK_MODES = Object.freeze(['bar', 'chord']);
export const DEFAULT_TEXT_BLOCK_MODE = 'bar';

/** 读容错：认不出的值退化成缺省。 */
export function normalizeTextBlockMode(input) {
  return TEXT_BLOCK_MODES.includes(input) ? input : DEFAULT_TEXT_BLOCK_MODE;
}

/** 写严格：只认表里的取值（不判断「缺失」——它也是可缺省字段）。 */
export function isTextBlockModeValid(input) {
  return TEXT_BLOCK_MODES.includes(input);
}

/**
 * 把任意输入规整成合法的减三后缀写法。
 *
 * 与 `normalizeDisplayLines` 同样是**容错**：认不出的值退化成缺省，不报错。
 * 这里读的数据来自工程文件和 localStorage，为一个后缀写法让整首歌加载失败不值得。
 * 写入侧的严格判断由 `isDimSuffixValid` 负责。
 *
 * @param {unknown} input
 * @returns {'dim'|'°'}
 */
export function normalizeDimSuffix(input) {
  return DIM_SUFFIX_STYLES.includes(input) ? input : DEFAULT_DIM_SUFFIX;
}

/**
 * 判断一个值是不是合法的减三后缀写法（写入侧与导入侧的严格校验）。
 *
 * **注意它不判断「缺失」**：`dimSuffix` 是可缺省字段，缺失等价于 `'dim'`（SPEC §7.4）。
 * 调用方若要校验整首歌，应当写成 `value === undefined || isDimSuffixValid(value)`。
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isDimSuffixValid(input) {
  return DIM_SUFFIX_STYLES.includes(input);
}

/* ------------------------------------------------------------------ *
 * 记谱风格：四个各自独立的显示偏好（SPEC §5.1.1 / §5.1.2 / §6.6 / §8.1.2）
 *
 * 四个字段遵循同一条纪律，没有例外：
 *
 *   1. **全部可缺省**，缺省值等于引入该字段之前的观感。
 *   2. **只在写入路径上严格**（`isXxxValid`），读取路径上一律容错（`normalizeXxx`）。
 *   3. 兜底只在**消费端写一处**，上游直接透传 `undefined`。
 *
 * 第 1 条不是风格问题：`library.js` 读 `localStorage` 时**直接调 `validateSongShape`、
 * 不走迁移**。任何一个字段变成必需，用户已存的每一首歌都会在下次打开时被判为损坏并隔离。
 * ------------------------------------------------------------------ */

/**
 * 和弦性质符号体系（SPEC §5.1.1）—— 决策点 A。
 *
 * - `'common'` 通用写法（`Cmaj7` `Cm7` `Cm` `Cdim` `Caug`），本站缺省、等于旧行为。
 * - `'jazz'`   爵士圈写法（`CΔ7` `C-7` `C-` `C°` `C+`）。
 *
 * **只作用于和弦名与文本导出。** 级数行有自己的后缀规则（罗马字形下 `m` 被小写吸收、
 * 减三后缀由 `dimSuffix` 单独管），不跟随这个开关 —— 两套规则叠在一起会打架。
 */
export const CHORD_SYMBOL_STYLES = Object.freeze(['common', 'jazz']);
export const DEFAULT_CHORD_SYMBOLS = 'common';

/**
 * 升降号字形（SPEC §5.1.2）—— 决策点 B。
 *
 * **只作用于和弦名与音名，不作用于级数行**：级数里的 `#4` / `b7` 那个 `#` `b` 是
 * **级数限定符**，属于级数记法本身，不是音名升降号。改它会让所有已有谱子的级数行外观都变，
 * 而缺省值必须等于旧行为 —— 旧行为下这两处本来就不一样，所以划在这里。
 */
export const ACCIDENTAL_GLYPH_STYLES = Object.freeze(['glyph', 'ascii']);
export const DEFAULT_ACCIDENTAL_GLYPHS = 'glyph';

/**
 * 属七后缀 `7` 在级数行里的位置（SPEC §6.6）—— 决策点 C。
 *
 * | 取值 | 数字级数 | `value` |
 * | --- | --- | --- |
 * | `'subscript'`（缺省） | `5` + 小 `7` | `57` |
 * | `'plain'` | `57` | `57` |
 * | `'superscript'` | `5` + 上标 `7` | `57` |
 * | `'parens'` | `5(7)` | `5(7)` |
 *
 * **`'parens'` 是唯一一个改变 `value` 的档**：括号是这个写法的组成部分，不是排版。
 * 另外三档改的只是同一串字符怎么摆。
 *
 * 这里只决定「写成什么样」，**不决定「谁需要特殊处理」** ——
 * 那个范围仍然只有属七一项（SPEC §11 第 12 条已拍板不扩大）。
 */
export const SEVENTH_SUFFIX_STYLES = Object.freeze(['subscript', 'plain', 'superscript', 'parens']);
export const DEFAULT_SEVENTH_SUFFIX = 'subscript';

/**
 * 休止符在谱面上的文字（SPEC §8.1.2）—— 决策点 F。
 *
 * **刻意没有 `'0'` 这一档**：`0` 在本工具的文本语法里已经是**空白小节**的记号
 * （SPEC §2.4），同一个字形不能有两个意思。简谱里 `0` 确实是休止符，
 * 但那是另一套语法，混进这里只会让人分不清「没排」和「要求不发声」。
 */
export const REST_TEXT_STYLES = Object.freeze(['cn', 'dash', 'R']);
export const DEFAULT_REST_TEXT = 'cn';

/**
 * 三种休止写法对应的字。
 *
 * `dash` 用的是 **U+2014 EM DASH**，不是 ASCII 连字符、也不是 U+2013 EN DASH ——
 * 这是个非 ASCII 字形，和 `°` 一样属于「断言抓不到编码损坏」的那一类（见 SPEC §11 第 10 条）。
 * 改动这一行时请用码点验证，别只跑测试。
 */
export const REST_TEXTS = Object.freeze({ cn: '休止', dash: '—', R: 'R' });

/** 取休止符在谱面上该显示的文字。认不出的值退化成缺省。 */
export function getRestText(style) {
  return REST_TEXTS[normalizeRestText(style)];
}

/**
 * 生成一组「读容错 / 写严格」的成对函数。
 *
 * 四个风格字段的规则完全一样，只有取值表不同 —— 逐个手写四遍，
 * 早晚会有人把其中一个的容错方向写反（那正是最难发现的一类缺陷：
 * 表现是「设置偶尔不生效」，而不是报错）。
 */
function defineStyleField({ styles, fallback }) {
  return {
    normalize(input) {
      return styles.includes(input) ? input : fallback;
    },
    isValid(input) {
      return styles.includes(input);
    },
  };
}

const chordSymbolsField = defineStyleField({ styles: CHORD_SYMBOL_STYLES, fallback: DEFAULT_CHORD_SYMBOLS });
const accidentalGlyphsField = defineStyleField({
  styles: ACCIDENTAL_GLYPH_STYLES,
  fallback: DEFAULT_ACCIDENTAL_GLYPHS,
});
const seventhSuffixField = defineStyleField({ styles: SEVENTH_SUFFIX_STYLES, fallback: DEFAULT_SEVENTH_SUFFIX });
const restTextField = defineStyleField({ styles: REST_TEXT_STYLES, fallback: DEFAULT_REST_TEXT });

/** 读容错：认不出的值退化成缺省，不报错（数据来自工程文件与 localStorage）。 */
export function normalizeChordSymbols(input) {
  return chordSymbolsField.normalize(input);
}
export function normalizeAccidentalGlyphs(input) {
  return accidentalGlyphsField.normalize(input);
}
export function normalizeSeventhSuffix(input) {
  return seventhSuffixField.normalize(input);
}
export function normalizeRestText(input) {
  return restTextField.normalize(input);
}

/**
 * 写严格：只认表里的取值。
 *
 * **四个都不判断「缺失」** —— 它们都是可缺省字段，缺失等价于缺省值（SPEC §2.2）。
 * 调用方校验整首歌时应当写成 `value === undefined || isXxxValid(value)`。
 */
export function isChordSymbolsValid(input) {
  return chordSymbolsField.isValid(input);
}
export function isAccidentalGlyphsValid(input) {
  return accidentalGlyphsField.isValid(input);
}
export function isSeventhSuffixValid(input) {
  return seventhSuffixField.isValid(input);
}
export function isRestTextValid(input) {
  return restTextField.isValid(input);
}

/**
 * 风格 → 是否画成 `♯` / `♭` 字形。
 *
 * **全应用只在这一处做这个映射。** 散布在各处的话，早晚有人写反，而写反了不会报错、
 * 也不会被断言抓到 —— 表现只是「这个设置偶尔不生效」。
 *
 * @param {unknown} style
 * @returns {boolean} `'ascii'` 为 false，其余（含认不出的值）为 true
 */
export function usesAccidentalGlyphs(style) {
  return normalizeAccidentalGlyphs(style) !== 'ascii';
}

/**
 * v1 → v2 迁移表（SPEC §7.4）。
 *
 * v1 把显示方式存成单个字符串 `layout.displayMode`，v2 换成了数组 `layout.displayLines`。
 * 旧值在这里翻译一次，**翻译完就丢弃、永不写回** —— 数据里只留 `displayLines` 一个真相，
 * 不会出现两份互相打架的显示偏好。
 */
export const LEGACY_DISPLAY_MODE_TO_LINES = Object.freeze({
  chord: Object.freeze(['chord']),
  degree: Object.freeze(['degree']),
});

/**
 * 把任意输入规整成合法的显示行数组。
 *
 * 规则：丢弃未知值 → 去重 → 按固定顺序排列 → 至少留一行。
 * 永远返回**新数组**，不修改输入；也永远不返回空数组
 * （一行都不显示等于看不见任何和弦，没有意义）。
 *
 * 这是**容错**而不是报错：显示行是纯显示偏好，为读取到的一个拼错的值就让界面空掉
 * 不值得。写入侧的严格校验由 `isDisplayLinesValid` 负责。
 *
 * @param {unknown} input
 * @returns {string[]} 至少一项，按固定顺序
 */
export function normalizeDisplayLines(input) {
  const list = Array.isArray(input) ? input : [];
  const kept = DISPLAY_LINE_IDS.filter((id) => list.includes(id));
  return kept.length > 0 ? kept : [...DEFAULT_DISPLAY_LINES];
}

/**
 * 判断一个值是不是合法的显示行数组（写入侧与导入侧的严格校验）。
 *
 * 要求：是数组、1–3 项、取值合法、无重复。
 * **不要求顺序** —— 顺序由渲染按固定顺序排列，数据里怎么排都等价，
 * 不必为此拒绝一份工程文件。
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isDisplayLinesValid(input) {
  if (!Array.isArray(input)) return false;
  if (input.length < 1 || input.length > MAX_DISPLAY_LINES) return false;
  if (new Set(input).size !== input.length) return false;
  return input.every((id) => DISPLAY_LINE_IDS.includes(id));
}

/**
 * 和弦性质表 —— 每个性质的**唯一真相来源**。
 *
 * 每一条同时带着三样东西，它们必须一起改：
 *
 * - `symbol`      —— `common` 体系下的后缀，**既用于缺省显示、也用于解析**。
 * - `jazzSymbol`  —— `jazz` 体系下的后缀，**只用于显示**（§5.1.1）。
 * - `aliases`     —— 解析时额外接受的写法（§5.2.1），**只用于解析、永不用于显示**。
 *   `symbol` 本身也是合法输入，不必在 `aliases` 里重复列一遍。
 *
 * 把三者放在同一条记录里，是为了让「加一种写法」这件事只能在一个地方发生 ——
 * 拆成三张平行表的话，早晚有人只改了其中两张，而漏掉的那张不会报错，
 * 只会表现为「这个写法时好时坏」。
 *
 * `label` 是给编辑面板和校验报告用的中文名，与解析无关。
 *
 * @type {ReadonlyArray<{id: string, symbol: string, jazzSymbol: string, label: string, aliases: readonly string[]}>}
 */
export const CHORD_QUALITIES = Object.freeze([
  Object.freeze({ id: 'maj', symbol: '', jazzSymbol: '', label: '大三和弦', aliases: Object.freeze(['maj', 'M']) }),
  Object.freeze({ id: 'm', symbol: 'm', jazzSymbol: '-', label: '小三和弦', aliases: Object.freeze(['min', '-']) }),
  Object.freeze({ id: '7', symbol: '7', jazzSymbol: '7', label: '属七和弦', aliases: Object.freeze([]) }),
  Object.freeze({
    id: 'maj7',
    symbol: 'maj7',
    jazzSymbol: 'Δ7',
    label: '大七和弦',
    aliases: Object.freeze(['Maj7', 'MAJ7', 'M7', 'Δ', 'Δ7']),
  }),
  Object.freeze({ id: 'm7', symbol: 'm7', jazzSymbol: '-7', label: '小七和弦', aliases: Object.freeze(['min7', '-7']) }),
  Object.freeze({ id: 'sus2', symbol: 'sus2', jazzSymbol: 'sus2', label: '挂二和弦', aliases: Object.freeze([]) }),
  Object.freeze({ id: 'sus4', symbol: 'sus4', jazzSymbol: 'sus4', label: '挂四和弦', aliases: Object.freeze([]) }),
  Object.freeze({ id: 'dim', symbol: 'dim', jazzSymbol: '°', label: '减三和弦', aliases: Object.freeze(['o', '°']) }),
  Object.freeze({ id: 'aug', symbol: 'aug', jazzSymbol: '+', label: '增三和弦', aliases: Object.freeze(['+']) }),
]);

/**
 * 解析用的后缀匹配表 —— `symbol` 与 `aliases` 的并集。
 *
 * 按别名长度降序：解析用的是**精确相等**比较，所以顺序本身不影响结果，
 * 但把长别名排在前面能让这张表的意图一眼看明白，也免得以后有人
 * 改成前缀匹配时忘记调整（`maj7` 会立刻被 `m` 抢先吃掉）。
 *
 * @type {ReadonlyArray<{suffix: string, qualityId: string}>}
 */
export const CHORD_SUFFIX_ALIASES = Object.freeze(
  CHORD_QUALITIES.flatMap((q) =>
    Object.freeze([q.symbol, ...q.aliases])
      .filter((suffix) => suffix !== '')
      .map((suffix) => Object.freeze({ suffix, qualityId: q.id })),
  ).sort((a, b) => b.suffix.length - a.suffix.length),
);

/** 解析用的匹配表（按 `symbol` 长度降序）——只含通用后缀，用于「本版支持的后缀」提示文案。 */
export const CHORD_QUALITIES_BY_MATCH_ORDER = Object.freeze(
  [...CHORD_QUALITIES].sort((a, b) => b.symbol.length - a.symbol.length),
);

/** @type {ReadonlyArray<string>} */
export const CHORD_QUALITY_IDS = Object.freeze(CHORD_QUALITIES.map((q) => q.id));

/**
 * 按 id 取和弦性质定义。
 * @param {string} id
 * @returns {{id: string, symbol: string, jazzSymbol: string, label: string, aliases: readonly string[]} | null}
 */
export function getChordQuality(id) {
  const known = CHORD_QUALITIES.find((q) => q.id === id);
  if (known) return known;
  if (typeof id !== 'string' || id.length > 32) return null;
  const chord = TonalChord.get(`C${id}`);
  return chord.empty ? null : { id, symbol: id, jazzSymbol: id, label: chord.type, aliases: chord.aliases };
}

/**
 * 按符号体系取某个和弦性质的**显示**后缀（SPEC §5.1.1）。
 *
 * 这是「id → 屏幕上那串字」的唯一出口。**不要**在渲染层直接读 `quality.symbol` ——
 * 那样 `chordSymbols: 'jazz'` 就会在某个没人注意的分支上静默失效。
 *
 * @param {string} qualityId
 * @param {'common'|'jazz'} [style] 认不出的值退化成缺省（读容错）
 * @returns {string} 后缀字串；未知性质返回 `[id]` 便于一眼看出是数据坏了
 */
export function getChordSymbol(qualityId, style) {
  const quality = getChordQuality(qualityId);
  if (!quality) return `[${qualityId}]`;
  return normalizeChordSymbols(style) === 'jazz' ? quality.jazzSymbol : quality.symbol;
}

/**
 * 已知但本版「故意不支持」的和弦写法。
 * 命中时给出针对性说明，避免用户以为已经解析成功。
 *
 * **这张表在 2026-09-22 变短了**（SPEC §5.4）：`°` `o` `+` `-` `M` `M7` `Maj7` 七种写法
 * 从「报错」变成了**合法别名**（`CHORD_SUFFIX_ALIASES`），所以它们不再出现在这里。
 *
 * **剩下的每一条都是乐理范围问题，不是字形问题。** 这些和弦本版根本没有对应的
 * 性质 id —— 要支持它们得先定乐理语义（半减七的拼写、扩展音的省略规则），
 * 那是一次独立的、更大的改动；而加一条别名只影响解析。两者不要混在一起谈。
 *
 * 匹配对象是**后缀部分**（`parsePitchNameWithSuffix` 切出来的那段）。
 *
 * @type {ReadonlyArray<{pattern: RegExp, message: string}>}
 */
export const UNSUPPORTED_CHORD_HINTS = Object.freeze([
  Object.freeze({ pattern: /^m7b5$|^ø|^m\(b5\)$/, message: '半减七和弦（m7b5）本版不支持，请改用 dim 或等待后续版本' }),
  Object.freeze({ pattern: /^(°7|o7|dim7)$/, message: '减七和弦本版不支持（表里只有减三 dim）。如果写的是减三，去掉那个 7' }),
  Object.freeze({ pattern: /^add\d+$|^\d{2}$|^9$|^11$|^13$|^m9$|^-9$|^m11$|^-11$|^m13$|^-13$/, message: '扩展音（add9 / 9 / 11 / 13 等）本版不支持' }),
  Object.freeze({ pattern: /^6$|^m6$|^-6$/, message: '六和弦本版不支持' }),
  Object.freeze({ pattern: /^5$/, message: '强力和弦（C5）本版不支持，请写 C' }),
  Object.freeze({ pattern: /^sus$/, message: 'sus 请明确写作 sus2 或 sus4' }),
  Object.freeze({ pattern: /^7sus4$|^7sus2$/, message: '挂留七和弦本版不支持' }),
  Object.freeze({ pattern: /^mmaj7$|^mM7$|^mMaj7$|^-M7$|^-maj7$/, message: '小大七和弦本版不支持' }),
  Object.freeze({ pattern: /^alt$|^no\d+$|^omit\d+$/, message: '变化音 / 省略音写法本版不支持' }),
]);

/** 音名（自然音级）顺序，同时定义了「按字母拼写」的级数对应关系：C→1, D→2, …, B→7。 */
export const PITCH_LETTERS = Object.freeze(['C', 'D', 'E', 'F', 'G', 'A', 'B']);

/** 自然音名对应的半音序号（C = 0）。 */
export const PITCH_LETTER_SEMITONES = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/** 大调音阶各级相对主音的半音数（度 1..7）。 */
export const MAJOR_SCALE_SEMITONES = Object.freeze([0, 2, 4, 5, 7, 9, 11]);

/** 升降号的输入别名 → 内部规范化字符。 */
export const ACCIDENTAL_INPUT_ALIASES = Object.freeze({ '#': '#', '♯': '#', b: 'b', '♭': 'b' });

/** 内部字符 → 谱面显示字形。集中定义，方便后期统一替换字体方案。 */
export const ACCIDENTAL_DISPLAY = Object.freeze({ '#': '♯', b: '♭' });

/**
 * 允许的升降号个数（-2..2，即 bb/b/本位/#/##）。
 * 超出范围时解析直接报错，不做近似。
 */
export const ACCIDENTAL_MIN = -2;
export const ACCIDENTAL_MAX = 2;

/**
 * 时值比较容差。浮点数比较统一使用它，避免 0.1 + 0.2 之类的问题。
 * 实际单位是「拍」，见 docs/SPEC.md §3。
 */
export const BEATS_EPSILON = 1e-9;

/**
 * 「精确可表达」判定的分母上限。
 * 均分小节得到的时值，若能表示成 1/16 拍的整数倍则视为可精确表达；
 * 否则报错要求用户显式填写，绝不四舍五入。
 */
export const BEATS_EXACT_DENOMINATOR = 16;

/** 数值范围限制（同时用于输入校验和工程文件导入校验）。 */
export const LIMITS = Object.freeze({
  titleMaxLength: 120,
  artistMaxLength: 120,
  notesMaxLength: 500,
  styleMaxLength: 120,
  sectionNameMaxLength: 40,
  sectionCueMaxLength: 200,
  /** 单个歌词片段（对齐到一个事件下方）的最大字符数（SPEC §8.9）。 */
  lyricMaxLength: 60,
  /** 单个自由文字块的最大字符数（SPEC §8.10）。 */
  textBlockMaxLength: 500,
  sectionRepeatMin: 1,
  sectionRepeatMax: 99,
  bpmMin: 20,
  bpmMax: 400,
  beatsMin: 0,
  beatsMax: 64,
  fontScaleMin: 0.8,
  fontScaleMax: 1.6,
  /** 段落数 / 每段小节数 / 每小节事件数的软上限，防止一次导入把页面卡死。 */
  maxSections: 200,
  maxBarsPerSection: 512,
  maxEventsPerBar: 32,
  /** 工程文件体积上限（字节），导入前检查。 */
  maxSongJsonBytes: 4 * 1024 * 1024,
});

/** 实体类型 → ID 前缀。ID 必须全局唯一，绝不能用数组下标代替。 */
export const ID_PREFIXES = Object.freeze({
  song: 'sng',
  section: 'sec',
  bar: 'bar',
  event: 'evt',
  textBlock: 'txt',
});

/** localStorage 中保存曲库的键名。 */
export const STORAGE_KEY = 'chord-chart-workbench/v1/library';

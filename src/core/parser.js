/**
 * 功能谱文本的解析与序列化（docs/SPEC.md §4）。
 *
 * ## 为什么要先解析成「草稿」，而不是直接建 Song
 *
 * 文本里的时值是可以省略的（`C | Am`），而 Song 数据模型里的 `beats` **必须**是正数。
 * 所以中间必然有一层：先按语法拆成「段落 / 小节 / 事件」的草稿，草稿里的 `beats`
 * 允许是 `null`，再交给 core/duration.js 把省略的时值算成具体数字。算不出来就报错。
 *
 * 这样安排的好处是：**「写下什么」和「算成几拍」是两件事**，各自有单一的实现。
 * 如果把它们揉在一个循环里，改一条时值规则就得同时动解析和校验两处代码。
 *
 * ## 原子性（SPEC §4.7）
 *
 * 解析失败**绝不**返回半份数据，也绝不修改传入的歌曲。失败时调用方保留用户的
 * 原始草稿文本，把 `issues` 显示出来即可。`parseSongText()` 只读入参，
 * `applyParsedSections()` 只返回新对象——两者都不碰 `baseSong`。
 *
 * ## 换行是分隔符，不是空白（SPEC §4.3）
 *
 * ```
 * [Verse]
 * C:4      ← 第 1 小节
 * Am:4     ← 第 2 小节
 * ```
 * 如果把换行当普通空白，上面两行会被读成「一个小节里放着 C:4 和 Am:4」——
 * 这是一个**安静的数据损坏**。所以换行在这里等价于 `|`。
 *
 * @module core/parser
 */

import { DEFAULT_BARS_PER_ROW, DEFAULT_TIME_SIGNATURE, LIMITS } from './constants.js';
import { formatChordSymbol, parseChordSymbol } from './chord.js';
import { checkBeatsValue, resolveBarBeats } from './duration.js';
import { createId } from './ids.js';
import { cloneSong, nowIso } from './song.js';

/**
 * 解析错误。比时值校验的问题多了文本位置：`line` / `column` 都是 1 起。
 *
 * `column` 按 UTF-16 码元计数，与 `String.prototype.length` 一致；对纯 ASCII 与
 * 常见中文标点都能得到预期列号，不必为 emoji 之类的情况做特殊处理。
 *
 * @typedef {Object} ParseIssue
 * @property {string} code
 * @property {string} message
 * @property {number} line 1 起。
 * @property {number} column 1 起。
 * @property {?string} sectionName
 * @property {?number} barIndex 段落内第几小节，0 起；无法定位时为 null。
 * @property {?number} eventIndex 小节内第几个事件，0 起；不针对单个事件时为 null。
 * @property {string} snippet 出错的原始文本片段，便于用户对照。
 */

/**
 * 解析草稿里的事件。`beats` 为 `null` 表示用户省略了时值，等待自动分配。
 *
 * @typedef {Object} ParsedEvent
 * @property {'chord'|'rest'} kind
 * @property {?import('./chord.js').Chord} chord 仅 `kind === 'chord'` 时存在。
 * @property {?number} beats
 */

/**
 * 解析草稿里的小节。
 *
 * @typedef {Object} ParsedBar
 * @property {'chords'|'empty'} type
 * @property {ParsedEvent[]} events 时值已全部解析为具体数值。
 * @property {number} line
 */

/**
 * 解析草稿里的段落。`repeat` 和 `cue` 不在文本语法里（SPEC §4.7），
 * 由 `applyParsedSections()` 从原歌曲按名字继承过来。
 *
 * @typedef {Object} ParsedSection
 * @property {string} name
 * @property {number} line
 * @property {ParsedBar[]} bars
 */

/**
 * 解析错误码。docs/SPEC.md §4.6 是这张表的权威版本。
 * @type {Readonly<Record<string, string>>}
 */
export const PARSE_CODES = Object.freeze({
  INPUT_TYPE: 'E_INPUT_TYPE',
  NO_SECTION: 'E_NO_SECTION',
  SECTION_NAME_EMPTY: 'E_SECTION_NAME_EMPTY',
  SECTION_NAME_TOO_LONG: 'E_SECTION_NAME_TOO_LONG',
  SECTION_HEADER_NOT_ALONE: 'E_SECTION_HEADER_NOT_ALONE',
  UNEXPECTED_BRACKET: 'E_UNEXPECTED_BRACKET',
  CONTENT_BEFORE_SECTION: 'E_CONTENT_BEFORE_SECTION',
  BAR_SEGMENT_EMPTY: 'E_BAR_SEGMENT_EMPTY',
  BAR_HAS_NO_EVENT: 'E_BAR_HAS_NO_EVENT',
  EMPTY_BAR_WITH_EVENTS: 'E_EMPTY_BAR_WITH_EVENTS',
  ZERO_WITH_DURATION: 'E_ZERO_WITH_DURATION',
  DURATION_INVALID: 'E_DURATION_INVALID',
});

/** 段落头：整行只有 `[名称]`，允许前后空白。名称内部允许空格，但不允许另一对方括号。 */
const SECTION_HEADER_PATTERN = /^\[([^[\]]*)\]$/;

/** 休止记号，大小写均可（`r` 不是有效音名，不会和和弦冲突）。 */
const REST_SYMBOL_PATTERN = /^[Rr]$/;

/** 「整小节留白」记号的两种写法：合法的 `0`，和写了时值的 `0:2`（后者是错的）。 */
function isZeroToken(text) {
  return text === '0' || text.startsWith('0:');
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 组装一条解析错误。 */
function makeIssue(code, message, location) {
  return {
    code,
    message,
    line: location.line ?? 0,
    column: location.column ?? 0,
    sectionName: location.sectionName ?? null,
    barIndex: location.barIndex ?? null,
    eventIndex: location.eventIndex ?? null,
    snippet: location.snippet ?? '',
  };
}

/**
 * 切开一行的「小节片段」，同时记住每个片段在原始行里的起始下标，用于报告列号。
 *
 * 行尾多余的分隔符允许出现并被忽略（`C:4 | Am:4 |` → 2 个小节）；
 * 但中间的空片段**报错**（`C:4 || Am:4`），因为静默忽略会把作者的手误吞掉。
 *
 * @param {string} line
 * @returns {Array<{text: string, start: number}>}
 */
function splitBarSegments(line) {
  const segments = [];
  let start = 0;
  for (let i = 0; i <= line.length; i += 1) {
    if (i === line.length || line[i] === '|') {
      segments.push({ text: line.slice(start, i), start });
      start = i + 1;
    }
  }
  // 只有真的出现了分隔符（片段数 > 1）才允许丢掉末尾的空片段。
  const last = segments[segments.length - 1];
  if (segments.length > 1 && last.text.trim() === '') segments.pop();
  return segments;
}

/**
 * 把一个片段按空白切成事件记号，并记下每个记号的列号。
 *
 * @param {{text: string, start: number}} segment
 * @returns {Array<{text: string, column: number}>}
 */
function tokenizeSegment(segment) {
  const tokens = [];
  const { text } = segment;
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i += 1;
    tokens.push({ text: text.slice(start, i), column: segment.start + start + 1 });
  }
  return tokens;
}

/**
 * 解析冒号后面的时值文本。
 *
 * @param {string} raw
 * @returns {{ok: true, value: number} | {ok: false, message: string}}
 */
function parseBeatsToken(raw) {
  if (raw === '') {
    return { ok: false, message: '时值不能为空：冒号后面要写数字，例如 C:2' };
  }
  if (/^-/.test(raw)) {
    return { ok: false, message: `时值必须是正数，不能写成 ${raw}` };
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return { ok: false, message: `"${raw}" 不是有效时值：只能写数字，单位是拍（例如 2、1.5、0.5）` };
  }
  const value = Number(raw);
  if (value === 0) {
    return { ok: false, message: '时值不能是 0。整小节留白请单独写一个 0（不要写成 0:0 或 C:0）' };
  }
  const check = checkBeatsValue(value);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, value };
}

/**
 * 解析一个事件记号，例如 `C:2`、`G/B:1.5`、`R:2`、`Am`。
 *
 * @param {{text: string, column: number}} token
 * @param {object} context 当前行 / 段落 / 小节的位置信息
 * @returns {{ok: true, event: ParsedEvent} | {ok: false, issue: ParseIssue}}
 */
function parseEventToken(token, context) {
  const { text } = token;
  const location = { ...context, column: token.column, snippet: text };

  const colonParts = text.split(':');
  if (colonParts.length > 2) {
    return {
      ok: false,
      issue: makeIssue(
        PARSE_CODES.DURATION_INVALID,
        `"${text}" 里的时值只能写一次（正确写法例如 C:2；想表达 2 分 3 秒之类的时间请改用 BPM 与拍数）`,
        location,
      ),
    };
  }

  const head = colonParts[0];
  const hasDuration = colonParts.length === 2;

  let event = null;
  if (REST_SYMBOL_PATTERN.test(head)) {
    event = { kind: 'rest', chord: null, beats: null };
  } else {
    const parsed = parseChordSymbol(head);
    if (!parsed.ok) {
      return { ok: false, issue: makeIssue(parsed.code, parsed.message, location) };
    }
    event = { kind: 'chord', chord: parsed.value, beats: null };
  }

  if (hasDuration) {
    const beatsResult = parseBeatsToken(colonParts[1]);
    if (!beatsResult.ok) {
      return { ok: false, issue: makeIssue(PARSE_CODES.DURATION_INVALID, beatsResult.message, location) };
    }
    event.beats = beatsResult.value;
  }

  return { ok: true, event };
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 解析一段功能谱文本，得到段落草稿。
 *
 * 成功时所有事件的 `beats` 都是具体数值；失败时 `sections` 为空数组，
 * 绝不会返回「一半解析成功」的结果。调用方只需看 `ok`。
 *
 * @param {string} text
 * @param {{timeSignature?: string}} [options] 拍号决定每小节拍数，用于分配与校验时值。
 * @returns {{ok: true, sections: ParsedSection[], issues: []} | {ok: false, sections: [], issues: ParseIssue[]}}
 */
export function parseSongText(text, options = {}) {
  const timeSignature = options.timeSignature ?? DEFAULT_TIME_SIGNATURE;

  if (typeof text !== 'string') {
    return {
      ok: false,
      sections: [],
      issues: [makeIssue(PARSE_CODES.INPUT_TYPE, `输入必须是字符串，当前类型为 ${typeof text}`, {})],
    };
  }

  /** @type {ParsedSection[]} */
  const sections = [];
  /** @type {ParseIssue[]} */
  const issues = [];
  /** @type {?ParsedSection} */
  let currentSection = null;

  const beatsPerBarOf = () => {
    // 这里只做「每小节多少拍」的查询；拍号本身是否受支持由 validateSongShape 负责。
    // 拿不到就当作 4/4，避免解析阶段因为一个上游问题整份草稿失效。
    const beats = { '4/4': 4, '3/4': 3, '6/8': 6 }[timeSignature];
    return beats ?? 4;
  };

  const lines = text.split(/\r\n|\r|\n/);

  lines.forEach((line, lineIndex) => {
    const lineNo = lineIndex + 1;
    const trimmed = line.trim();
    if (trimmed === '') return; // 空行忽略，可用来分隔段落

    const lineStartColumn = line.indexOf(trimmed) + 1;
    const sectionName = currentSection ? currentSection.name : null;

    // —— 段落头 ——
    if (trimmed.startsWith('[')) {
      const matched = trimmed.match(SECTION_HEADER_PATTERN);
      if (!matched) {
        issues.push(
          makeIssue(
            PARSE_CODES.SECTION_HEADER_NOT_ALONE,
            `"${trimmed}" 不是合法的段落头。段落名必须写成 [名称] 并独占一行，和弦要写在下一行`,
            { line: lineNo, column: lineStartColumn, snippet: trimmed },
          ),
        );
        return;
      }
      const name = matched[1].trim();
      if (name === '') {
        issues.push(
          makeIssue(PARSE_CODES.SECTION_NAME_EMPTY, '段落名不能为空，请写成 [Intro] 这样的形式', {
            line: lineNo,
            column: lineStartColumn,
            snippet: trimmed,
          }),
        );
        return;
      }
      if (name.length > LIMITS.sectionNameMaxLength) {
        issues.push(
          makeIssue(
            PARSE_CODES.SECTION_NAME_TOO_LONG,
            `段落名 "${name}" 长度超过上限 ${LIMITS.sectionNameMaxLength} 个字符（当前 ${name.length}）`,
            { line: lineNo, column: lineStartColumn, snippet: trimmed },
          ),
        );
        return;
      }
      currentSection = { name, line: lineNo, bars: [] };
      sections.push(currentSection);
      return;
    }

    // 行内混进方括号：多半是想把段落头和和弦写在同一行
    if (trimmed.includes('[') || trimmed.includes(']')) {
      issues.push(
        makeIssue(
          PARSE_CODES.UNEXPECTED_BRACKET,
          `"${trimmed}" 里的方括号位置不对。段落头要单独占一行，写成 [名称]，和弦写在下一行`,
          { line: lineNo, column: lineStartColumn, snippet: trimmed },
        ),
      );
      return;
    }

    if (!currentSection) {
      issues.push(
        makeIssue(
          PARSE_CODES.CONTENT_BEFORE_SECTION,
          '这段内容不属于任何段落。请先写一个段落名（例如 [Intro]），再把和弦写在它下面',
          { line: lineNo, column: lineStartColumn, snippet: trimmed },
        ),
      );
      return;
    }

    // —— 一行里的若干小节 ——
    for (const segment of splitBarSegments(line)) {
      const segmentText = segment.text.trim();
      const barIndex = currentSection.bars.length;
      const barLocation = {
        line: lineNo,
        column: segment.start + 1,
        sectionName,
        barIndex,
        snippet: segmentText,
      };

      if (segmentText === '') {
        issues.push(
          makeIssue(
            PARSE_CODES.BAR_SEGMENT_EMPTY,
            '出现了空的小节片段（连续两个分隔符）。整小节留白请写一个 0，不要留空',
            barLocation,
          ),
        );
        continue;
      }

      const tokens = tokenizeSegment(segment);

      // 整小节留白：必须独占一个小节
      if (tokens.length === 1 && tokens[0].text === '0') {
        currentSection.bars.push({ type: 'empty', events: [], line: lineNo });
        continue;
      }

      const zeroTokens = tokens.filter((token) => isZeroToken(token.text));
      if (zeroTokens.length > 0) {
        for (const token of zeroTokens) {
          const isBareZero = token.text === '0';
          issues.push(
            makeIssue(
              isBareZero ? PARSE_CODES.EMPTY_BAR_WITH_EVENTS : PARSE_CODES.ZERO_WITH_DURATION,
              isBareZero
                ? '0 表示整小节留白，必须独占一个小节，不能和和弦写在同一个小节里'
                : `"${token.text}" 不是有效写法。整小节留白请单独写一个 0`,
              { ...barLocation, column: token.column, eventIndex: 0, snippet: token.text },
            ),
          );
        }
        // 这一小节不生成：生成的话，剩下的和弦会带着错误的上下文进入数据。
        continue;
      }

      /** @type {ParsedEvent[]} */
      const draftEvents = [];
      let barFailed = false;
      tokens.forEach((token, eventIndex) => {
        if (barFailed) return;
        const result = parseEventToken(token, { ...barLocation, eventIndex });
        if (!result.ok) {
          issues.push(result.issue);
          barFailed = true;
          return;
        }
        draftEvents.push(result.event);
      });
      if (barFailed) continue;

      // 时值：省略的算出来，写明的校验总和
      const resolved = resolveBarBeats(draftEvents, beatsPerBarOf(), {
        sectionName,
        barIndex,
        eventIndex: null,
      });
      if (!resolved.ok) {
        // resolveBarBeats 不带行号，这里补上，保证每个错误都能定位到文本位置
        for (const issue of resolved.issues) {
          issues.push(makeIssue(issue.code, issue.message, barLocation));
        }
        continue;
      }

      currentSection.bars.push({
        type: 'chords',
        line: lineNo,
        events: draftEvents.map((event, index) => ({ ...event, beats: resolved.value[index] })),
      });
    }
  });

  if (sections.length === 0 && issues.length === 0) {
    issues.push(makeIssue(PARSE_CODES.NO_SECTION, '还没有任何段落。请先写一个段落名（例如 [Intro]）', { line: 1, column: 1 }));
  }

  if (issues.length > 0) {
    return { ok: false, sections: [], issues };
  }
  return { ok: true, sections, issues: [] };
}

/* ------------------------------------------------------------------ *
 * 把草稿合并进歌曲
 * ------------------------------------------------------------------ */

/**
 * 用解析出来的段落替换歌曲的段落，返回**新的**歌曲对象。
 *
 * 文本语法里没有 `repeat` 和 `cue`（SPEC §4.7），但它们不该因为改一次文本就丢失。
 * 所以按**同名段落的出现顺序**继承：
 * 新文本里第 k 个 `[Chorus]` 会继承原歌曲里第 k 个叫 `Chorus` 的段落的
 * `repeat` / `cue` / `id`。名字对不上就当作新段落。
 *
 * 为什么按名字而不是按位置？因为位置会随着「在中间插一段」整片错位，
 * 而名字是用户自己写的、有语义的标识——按名字继承才符合用户预期。
 *
 * 小节和事件一律生成新 ID：小节是**按位置**存在的，文本里插一个小节会让后面全部
 * 平移，按位置继承 ID 只会把 ID 张冠李戴。ID 的职责是「稳定唯一」，不是「位置记忆」。
 *
 * @param {import('./song.js').Song} baseSong
 * @param {ParsedSection[]} sections
 * @param {{idFactory?: (entity: 'section'|'bar'|'event') => string}} [options]
 * @returns {import('./song.js').Song}
 */
export function applyParsedSections(baseSong, sections, options = {}) {
  const idFactory = options.idFactory ?? createId;

  /** @type {Map<string, import('./song.js').Section[]>} */
  const previousByName = new Map();
  for (const section of baseSong.sections ?? []) {
    const list = previousByName.get(section.name) ?? [];
    list.push(section);
    previousByName.set(section.name, list);
  }

  /** @type {Map<string, number>} */
  const consumed = new Map();

  const nextSections = sections.map((parsedSection) => {
    const used = consumed.get(parsedSection.name) ?? 0;
    consumed.set(parsedSection.name, used + 1);
    const previous = (previousByName.get(parsedSection.name) ?? [])[used] ?? null;

    return {
      id: previous ? previous.id : idFactory('section'),
      name: parsedSection.name,
      repeat: previous ? previous.repeat : 1,
      cue: previous ? previous.cue : '',
      bars: parsedSection.bars.map((parsedBar) =>
        parsedBar.type === 'empty'
          ? { id: idFactory('bar'), type: 'empty', events: [] }
          : {
              id: idFactory('bar'),
              type: 'chords',
              events: parsedBar.events.map((event) =>
                event.kind === 'rest'
                  ? { kind: 'rest', id: idFactory('event'), beats: event.beats }
                  : { kind: 'chord', id: idFactory('event'), beats: event.beats, chord: { ...event.chord } },
              ),
            },
      ),
    };
  });

  return { ...cloneSong(baseSong), sections: nextSections, updatedAt: nowIso() };
}

/**
 * 一步到位：解析文本并合并进歌曲。
 *
 * 失败时**不动** `baseSong` 的任何内容，只把 `issues` 交给调用方显示。
 *
 * @param {string} text
 * @param {import('./song.js').Song} baseSong
 * @param {{idFactory?: (entity: 'section'|'bar'|'event') => string}} [options]
 * @returns {{ok: true, value: import('./song.js').Song, issues: []} | {ok: false, value: null, issues: ParseIssue[]}}
 */
export function parseSongTextInto(text, baseSong, options = {}) {
  const parsed = parseSongText(text, { timeSignature: baseSong.timeSignature });
  if (!parsed.ok) {
    return { ok: false, value: null, issues: parsed.issues };
  }
  return { ok: true, value: applyParsedSections(baseSong, parsed.sections, options), issues: [] };
}

/* ------------------------------------------------------------------ *
 * 反向序列化：歌曲 → 文本
 * ------------------------------------------------------------------ */

/** 时值转文本。数据里的时值都是 1/16 拍的整数倍，二进制表示精确，直接 String 即可。 */
function formatBeats(beats) {
  return String(beats);
}

/**
 * 把歌曲写成功能谱文本。
 *
 * 所有事件的时值都**显式写出**。这样既不依赖自动均分（避免「除不尽」的报错），
 * 也不会踩到「混合填写」的歧义，往返一次信息不丢。
 *
 * **导出的记号只有一处跟随谱面设置**（SPEC §4.8）：
 *
 * | 元素 | 导出成 | 跟随吗 |
 * | --- | --- | --- |
 * | 和弦性质后缀 | `layout.chordSymbols`（`Cmaj7` / `CΔ7`） | **跟随** |
 * | 升 / 降号 | ASCII `#` / `b` | 不跟随 |
 * | 休止 | `R` | 不跟随 |
 * | 空白小节 | `0` | 不跟随（文本语法本来就这么定义） |
 *
 * 后面三项为什么不跟：它们是这套语法的**记号**（SPEC §4.2 的定义表），
 * 不是「怎么写好看」的问题。`R` 换成 `—`、`#` 换成 `♯`，这份文本就不再是同一套语法了。
 * 而性质后缀是**内容**，换符号体系不影响可解析性 —— §5.2.1 保证别名都能读回来。
 *
 * 缺省（`chordSymbols: 'common'`）下导出结果与引入这个开关之前**逐字相同**。
 *
 * 注意：`repeat` 和 `cue` 表达不了（文本语法里没有），需要靠同一首歌做基底再解析回来
 * 才能保留。`songToText` 只负责「曲子内容」，不负责这两项元信息。
 *
 * @param {import('./song.js').Song} song
 * @param {{barsPerRow?: number}} [options] 默认沿用歌曲排版设置里的每行小节数。
 * @returns {{ok: true, value: string, issues: []} | {ok: false, value: null, issues: import('./duration.js').DurationIssue[]}}
 */
export function songToText(song, options = {}) {
  const barsPerRow = options.barsPerRow ?? song.layout?.barsPerRow ?? DEFAULT_BARS_PER_ROW;
  // 升降号恒为 ASCII（`glyphs: false`）—— 存储格式如此，交换格式也如此。
  const chordTextStyle = { glyphs: false, symbols: song.layout?.chordSymbols };
  const issues = [];

  const lines = [];
  (song.sections ?? []).forEach((section, sectionIndex) => {
    lines.push(`[${section.name}]`);
    const bars = section.bars ?? [];

    bars.forEach((bar, barIndex) => {
      const position = { path: `sections[${sectionIndex}].bars[${barIndex}]`, sectionIndex, sectionName: section.name, barIndex };

      let text;
      if (bar.type === 'empty') {
        text = '0';
      } else if ((bar.events ?? []).length === 0) {
        // 「chords 类型但没有任何事件」在文本里没有对应写法。
        // 写成 0 会把它偷偷变成空白小节——那正是 SPEC §2.4 要区分开的两件事，不能干。
        issues.push({
          code: 'E_BAR_HAS_NO_EVENT',
          message: '这一小节没有任何事件，无法写成文本。请把它设为空白小节（等价于文本里的 0），或补上和弦',
          eventIndex: null,
          ...position,
        });
        text = '';
      } else {
        text = bar.events
          .map((event) => {
            const symbol = event.kind === 'rest' ? 'R' : formatChordSymbol(event.chord, chordTextStyle);
            return `${symbol}:${formatBeats(event.beats)}`;
          })
          .join(' ');
      }

      // 每行放 barsPerRow 个小节，段落的最后一行不足时也正常结束
      const slot = barIndex % barsPerRow;
      if (slot === 0) {
        lines.push(text);
      } else {
        lines[lines.length - 1] += ` | ${text}`;
      }
    });

    lines.push(''); // 段落之间空一行，纯为可读性
  });

  if (issues.length > 0) {
    return { ok: false, value: null, issues };
  }
  return { ok: true, value: `${lines.join('\n').replace(/\n+$/, '')}\n`, issues: [] };
}

/**
 * 把一条解析错误整理成人类可读的一行，形如：
 * `第 3 行 · 第 2 小节 · 第 1 个事件：时值必须是正数`。
 *
 * @param {ParseIssue} issue
 * @returns {string}
 */
export function formatParseIssue(issue) {
  const parts = [];
  if (issue.line > 0) parts.push(`第 ${issue.line} 行`);
  if (issue.sectionName) parts.push(`[${issue.sectionName}]`);
  if (issue.barIndex !== null && issue.barIndex !== undefined) parts.push(`第 ${issue.barIndex + 1} 小节`);
  if (issue.eventIndex !== null && issue.eventIndex !== undefined) parts.push(`第 ${issue.eventIndex + 1} 个事件`);
  const where = parts.join(' · ');
  return where ? `${where}：${issue.message}` : issue.message;
}

/**
 * 把一批解析错误整理成多行文本，供界面直接显示。
 *
 * @param {ParseIssue[]} issues
 * @param {number} [maxLines]
 * @returns {string}
 */
export function formatParseIssues(issues, maxLines = 8) {
  const shown = issues.slice(0, maxLines).map(formatParseIssue);
  if (issues.length > shown.length) {
    shown.push(`…另有 ${issues.length - shown.length} 处问题`);
  }
  return shown.join('\n');
}

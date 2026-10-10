/**
 * 时值与小节长度校验（docs/SPEC.md §3）。
 *
 * 这个模块回答一个问题：**一个小节的时值加起来，到底该等于多少拍？**
 * 答案由拍号决定（§3.1），而「用户写了几分时值」有三种情况（§3.3）：
 *
 *   A. 全部省略时值 → 把整小节平均分给 n 个事件
 *   B. 全部写明时值 → 校验总和
 *   C. 混合           → 直接报错，不做任何推测
 *
 * 为什么要专门为「C. 混合」报错？因为「两个写明时值 + 一个没写」可以解释成
 * 补满剩余、平分剩余、或者作者漏写了。猜错会安静地产出一份**错误的谱子**，
 * 而一份看起来没问题的错谱，比一条报错危险得多。同理，均分除不尽时
 * 绝不四舍五入（§3.4）——`4 拍 / 3` 变成 `1.5` 就改变了音乐内容。
 *
 * 本模块同时服务两个场景，所以拆成两层：
 * - `resolveBarBeats()`：给**解析草稿**用。草稿里的 `beats` 允许是 `null`（省略），
 *   它负责把省略的时值算成具体数值，或者报错。
 * - `collectDurationIssues()`：给**已建好的歌曲**用。此时所有时值都已经是数字，
 *   它只做校验——改拍号后的重新校验（§3.5）、导入工程文件后的检查都走这里。
 *
 * @module core/duration
 */

import { BEATS_EPSILON, BEATS_EXACT_DENOMINATOR, LIMITS, getBeatsPerBar } from './constants.js';

/**
 * 时值问题。
 *
 * `code` 是给程序判断用的稳定标识，`message` 是给人看的中文说明。
 * 位置信息分两套：`sectionIndex`/`barIndex`/`eventIndex` 是结构化位置（0 起），
 * `path` 是给工程文件校验用的字段路径（如 `sections[2].bars[3]`）。
 * 解析器会在此基础上再补 `line`/`column`。
 *
 * @typedef {Object} DurationIssue
 * @property {string} code
 * @property {string} message
 * @property {string} path
 * @property {number} sectionIndex
 * @property {string} sectionName
 * @property {number} barIndex 段落内第几小节，0 起。
 * @property {?number} eventIndex 小节内第几个事件，0 起；不针对单个事件时为 null。
 */

/**
 * 时值问题的错误码。与 docs/SPEC.md §4.6 的表保持一致。
 * @type {Readonly<Record<string, string>>}
 */
export const DURATION_CODES = Object.freeze({
  MIXED: 'E_DURATION_MIXED',
  INVALID: 'E_DURATION_INVALID',
  UNDER: 'E_DURATION_UNDER',
  OVER: 'E_DURATION_OVER',
  NOT_DIVISIBLE: 'E_DURATION_NOT_DIVISIBLE',
  BAR_HAS_NO_EVENT: 'E_BAR_HAS_NO_EVENT',
  TIME_SIGNATURE_UNSUPPORTED: 'E_TIME_SIGNATURE_UNSUPPORTED',
});

/** 数字格式化：最多保留 4 位小数并去掉末尾的 0，用于错误信息里的人类可读数字。 */
function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 10000) / 10000);
}

/** 组装一条时值问题。 */
function makeIssue(code, message, location) {
  return {
    code,
    message,
    path: location.path ?? '',
    sectionIndex: location.sectionIndex ?? -1,
    sectionName: location.sectionName ?? '',
    barIndex: location.barIndex ?? -1,
    eventIndex: location.eventIndex ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 基础计算
 * ------------------------------------------------------------------ */

/**
 * 判断一个时值能否被「精确表达」。
 *
 * 判定标准（SPEC §3.4）：`beats × 16` 必须是整数，即最多精确到 1/16 拍。
 * 浮点比较一律走容差，不允许 `===`。
 *
 * @param {number} beats
 * @returns {boolean}
 */
export function isExactlyRepresentable(beats) {
  const scaled = beats * BEATS_EXACT_DENOMINATOR;
  return Math.abs(scaled - Math.round(scaled)) < BEATS_EPSILON;
}

/**
 * 判定两个时值是否相等（带容差）。
 *
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function beatsEqual(a, b) {
  return Math.abs(a - b) < BEATS_EPSILON;
}

/**
 * 累加一组事件的时值。`beats` 为 `null`（省略）的事件直接跳过，
 * 判定「是否全部省略」请用 `classifyBarEvents()`。
 *
 * @param {ReadonlyArray<{beats?: number|null}>} events
 * @returns {number}
 */
export function sumEventBeats(events) {
  let total = 0;
  for (const event of events) {
    if (typeof event?.beats === 'number' && Number.isFinite(event.beats)) {
      total += event.beats;
    }
  }
  return total;
}

/**
 * 判断一个小节的时值填写情况。
 *
 * @param {ReadonlyArray<{beats?: number|null}>} events
 * @returns {'empty'|'all-omitted'|'all-explicit'|'mixed'}
 */
export function classifyBarEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'empty';
  let omitted = 0;
  let explicit = 0;
  for (const event of events) {
    if (typeof event?.beats === 'number' && Number.isFinite(event.beats)) explicit += 1;
    else omitted += 1;
  }
  if (omitted === 0) return 'all-explicit';
  if (explicit === 0) return 'all-omitted';
  return 'mixed';
}

/**
 * 校验单个时值数值本身是否合法（正数、不超过上限、是有限数值）。
 *
 * @param {unknown} beats
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkBeatsValue(beats) {
  if (typeof beats !== 'number' || !Number.isFinite(beats)) {
    return { ok: false, message: `时值必须是数值，当前值 ${JSON.stringify(beats)}` };
  }
  if (beats <= 0) {
    return { ok: false, message: `时值必须是正数，当前值 ${formatNumber(beats)}` };
  }
  if (beats > LIMITS.beatsMax) {
    return { ok: false, message: `时值超过上限 ${LIMITS.beatsMax} 拍，当前值 ${formatNumber(beats)}` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 解析草稿：把省略的时值算出来
 * ------------------------------------------------------------------ */

/**
 * 处理一个小节的时值，返回每个事件最终应采用的时值。
 *
 * 三种情况见 SPEC §3.3。返回的 `value` 与传入的 `events` 一一对应，
 * 调用方可以用它去构造真正的 `ChordEvent` / `RestEvent`。
 *
 * @param {ReadonlyArray<{beats?: number|null}>} events
 * @param {number} beatsPerBar 每小节拍数
 * @param {Partial<DurationIssue>} [location] 出错时用于定位
 * @returns {{ok: true, value: number[], issues: []} | {ok: false, value: null, issues: DurationIssue[]}}
 */
export function resolveBarBeats(events, beatsPerBar, location = {}) {
  const mode = classifyBarEvents(events);

  if (mode === 'empty') {
    return {
      ok: false,
      value: null,
      issues: [
        makeIssue(
          DURATION_CODES.BAR_HAS_NO_EVENT,
          '这一小节没有任何事件。如果要留白，请把小节设为空白小节（写一个 0）',
          location,
        ),
      ],
    };
  }

  // A. 全部省略 → 平均分配
  if (mode === 'all-omitted') {
    const share = beatsPerBar / events.length;
    if (!isExactlyRepresentable(share)) {
      return {
        ok: false,
        value: null,
        issues: [
          makeIssue(
            DURATION_CODES.NOT_DIVISIBLE,
            `${beatsPerBar} 拍无法平均分成 ${events.length} 份（每份 ${formatNumber(share)} 拍，最多只能精确到 1/16 拍）。请给这一小节的事件写明时值，本版不会自动取整。`,
            location,
          ),
        ],
      };
    }
    return { ok: true, value: events.map(() => share), issues: [] };
  }

  // C. 混合 → 报错，不猜
  if (mode === 'mixed') {
    return {
      ok: false,
      value: null,
      issues: [
        makeIssue(
          DURATION_CODES.MIXED,
          '这一小节里有的事件写了时值、有的没写。混合填写有歧义（是补满剩余还是平分剩余？），本版不做推测，请把这一小节所有事件的时值都写上',
          location,
        ),
      ],
    };
  }

  // B. 全部写明 → 逐个检查合法性与总和
  const issues = [];
  events.forEach((event, index) => {
    const check = checkBeatsValue(event?.beats);
    if (!check.ok) {
      issues.push(makeIssue(DURATION_CODES.INVALID, check.message, { ...location, eventIndex: index }));
    }
  });
  if (issues.length > 0) {
    return { ok: false, value: null, issues };
  }

  const total = sumEventBeats(events);
  if (!beatsEqual(total, beatsPerBar)) {
    const diff = beatsPerBar - total;
    issues.push(
      makeIssue(
        diff > 0 ? DURATION_CODES.UNDER : DURATION_CODES.OVER,
        diff > 0
          ? `这一小节时值总和是 ${formatNumber(total)} 拍，比每小节要求的 ${beatsPerBar} 拍少了 ${formatNumber(diff)} 拍`
          : `这一小节时值总和是 ${formatNumber(total)} 拍，比每小节要求的 ${beatsPerBar} 拍多了 ${formatNumber(-diff)} 拍`,
        location,
      ),
    );
    return { ok: false, value: null, issues };
  }

  return { ok: true, value: events.map((event) => event.beats), issues: [] };
}

/* ------------------------------------------------------------------ *
 * 已建好的歌曲：只校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个已建好的小节。
 *
 * 空白小节（`type === 'empty'`）视为满足要求，不参与计算（SPEC §3.2）。
 *
 * @param {{type?: string, events?: ReadonlyArray<{beats?: number|null}>}} bar
 * @param {number} beatsPerBar
 * @param {Partial<DurationIssue>} [location]
 * @returns {DurationIssue[]}
 */
export function checkBarDuration(bar, beatsPerBar, location = {}) {
  if (bar?.type === 'empty') return [];
  // 已建好的歌曲里所有时值都是数字，走 resolveBarBeats 的 B 分支即可。
  // 直接复用它，保证「草稿校验」和「歌曲校验」用的是同一套规则，不会漂移。
  const expected = bar?.length ?? beatsPerBar;
  const result = resolveBarBeats(bar?.events ?? [], expected, location);
  const issues = result.ok ? [] : result.issues;
  if (Array.isArray(bar?.melody) && bar.melody.length && !beatsEqual(bar.melody.reduce((sum, note) => sum + note.beats, 0), expected)) {
    issues.push(makeIssue(DURATION_CODES.UNDER, '简谱总时值与小节长度不一致，请核对。', location));
  }
  return issues;
}

/**
 * 校验整首歌的小节时值，返回全部问题。
 *
 * 这是改拍号后重新校验（§3.5）和导入工程文件后的统一入口。
 * 永不抛异常，失败时由调用方**原样保留**用户数据。
 *
 * @param {{timeSignature?: string, sections?: Array<{name?: string, bars?: Array<{type?: string, events?: Array<{beats?: number}>}>}>}} song
 * @returns {DurationIssue[]}
 */
export function collectDurationIssues(song) {
  const beatsPerBar = getBeatsPerBar(song?.timeSignature);
  if (beatsPerBar <= 0) {
    return [
      makeIssue(
        DURATION_CODES.TIME_SIGNATURE_UNSUPPORTED,
        `无法校验时值：拍号 ${JSON.stringify(song?.timeSignature)} 不受支持`,
        { path: 'timeSignature' },
      ),
    ];
  }

  const issues = [];
  const sections = Array.isArray(song?.sections) ? song.sections : [];
  sections.forEach((section, sectionIndex) => {
    const bars = Array.isArray(section?.bars) ? section.bars : [];
    bars.forEach((bar, barIndex) => {
      issues.push(
        ...checkBarDuration(bar, beatsPerBar, {
          path: `sections[${sectionIndex}].bars[${barIndex}]`,
          sectionIndex,
          sectionName: section?.name ?? '',
          barIndex,
        }),
      );
    });
  });
  return issues;
}

/**
 * 这首歌的小节时值是否全部合法。
 *
 * @param {Parameters<typeof collectDurationIssues>[0]} song
 * @returns {boolean}
 */
export function isSongDurationsValid(song) {
  return collectDurationIssues(song).length === 0;
}

/**
 * 统计一个问题所处的段落名与小节序号，生成人类可读的位置前缀。
 * 形如 `第 3 行 · 第 2 小节 · 第 1 个事件：`。
 *
 * @param {DurationIssue} issue
 * @returns {string}
 */
export function formatDurationLocation(issue) {
  const parts = [];
  if (issue.sectionName) parts.push(`[${issue.sectionName}]`);
  if (issue.barIndex >= 0) parts.push(`第 ${issue.barIndex + 1} 小节`);
  if (issue.eventIndex !== null && issue.eventIndex !== undefined) {
    parts.push(`第 ${issue.eventIndex + 1} 个事件`);
  }
  return parts.join(' · ');
}

/**
 * 把一批时值问题整理成人类可读的多行文本。
 *
 * @param {DurationIssue[]} issues
 * @param {number} [maxLines] 最多列出几条，其余折叠为计数。
 * @returns {string}
 */
export function formatDurationIssues(issues, maxLines = 8) {
  const shown = issues.slice(0, maxLines).map((issue) => {
    const where = formatDurationLocation(issue);
    return where ? `${where}：${issue.message}` : issue.message;
  });
  if (issues.length > shown.length) {
    shown.push(`…另有 ${issues.length - shown.length} 处时值问题`);
  }
  return shown.join('\n');
}

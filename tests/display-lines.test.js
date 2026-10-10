/**
 * 显示行（docs/SPEC.md §8.1.1）的自动测试。
 *
 * 覆盖两层：
 * - `core/constants.js` 的 `normalizeDisplayLines` / `isDisplayLinesValid`
 *   —— 一个是容错（读），一个是严格（写）。
 * - `ui/chart.js` 的 `eventDisplayLines` —— 屏幕与 PNG 共用的**唯一**显示关口。
 *
 * 这一组的关键断言是「行数只增高、不改宽度」之外的两条：
 * 1. **顺序固定** `chord → degree → roman`，与用户在设置里的勾选顺序无关。
 * 2. **至少一行**：小调时级数行全被跳过，也必须退回和弦名，
 *    否则谱面上会出现「什么标签都没有」的和弦块。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DIM_SUFFIX,
  DEFAULT_DISPLAY_LINES,
  DIM_SUFFIX_STYLES,
  DISPLAY_LINE_IDS,
  MAX_DISPLAY_LINES,
  isDimSuffixValid,
  isDisplayLinesValid,
  normalizeDimSuffix,
  normalizeDisplayLines,
} from '../src/core/constants.js';
import { eventDisplayLines } from '../src/ui/chart.js';

const C_MAJOR = { tonic: 'C', mode: 'major' };
const A_MINOR = { tonic: 'A', mode: 'minor' };

function songWith(displayLines, key = C_MAJOR) {
  return { key, layout: { barsPerRow: 4, displayLines, fontScale: 1 } };
}

const chordEvent = { kind: 'chord', beats: 4, chord: { root: 'G', quality: '7', bass: null } };
const restEvent = { kind: 'rest', beats: 4 };

/* ------------------------------------------------------------------ *
 * 读取侧：容错
 * ------------------------------------------------------------------ */

test('normalizeDisplayLines 丢弃未知值、去重、按固定顺序排列', () => {
  assert.deepEqual(normalizeDisplayLines(['roman', 'chord']), ['chord', 'roman'], '顺序按固定表，不按输入');
  assert.deepEqual(normalizeDisplayLines(['degree', 'degree']), ['degree'], '去重');
  assert.deepEqual(normalizeDisplayLines(['bogus', 'chord', 42, null]), ['chord'], '未知值一律丢掉');
  assert.deepEqual(normalizeDisplayLines(['roman', 'degree', 'chord']), ['chord', 'degree', 'roman']);
});

test('normalizeDisplayLines 永远返回至少一项，且不返回空数组', () => {
  for (const input of [undefined, null, '', 42, {}, [], ['nope']]) {
    const result = normalizeDisplayLines(input);
    assert.equal(result.length >= 1, true, `输入 ${JSON.stringify(input)} 也要有结果`);
    assert.deepEqual(result, [...DEFAULT_DISPLAY_LINES]);
  }
});

test('normalizeDisplayLines 返回新数组，不修改输入', () => {
  const input = ['roman', 'chord'];
  const snapshot = JSON.stringify(input);
  const result = normalizeDisplayLines(input);

  assert.notEqual(result, input);
  assert.equal(JSON.stringify(input), snapshot, '规整必须只读');
});

test('normalizeDisplayLines 最多给出 3 项 —— 一个块放不下第四行', () => {
  const result = normalizeDisplayLines(['chord', 'degree', 'roman', 'chord', 'degree']);
  assert.equal(result.length, MAX_DISPLAY_LINES);
  assert.deepEqual(result, [...DISPLAY_LINE_IDS]);
});

/* ------------------------------------------------------------------ *
 * 写入侧：严格
 * ------------------------------------------------------------------ */

test('isDisplayLinesValid 接受 1–3 项合法值（任意顺序）', () => {
  assert.equal(isDisplayLinesValid(['chord']), true);
  assert.equal(isDisplayLinesValid(['degree']), true);
  assert.equal(isDisplayLinesValid(['roman']), true);
  assert.equal(isDisplayLinesValid(['chord', 'degree', 'roman']), true);
  assert.equal(isDisplayLinesValid(['roman', 'chord']), true, '顺序由渲染负责，数据里怎么排都等价');
});

test('isDisplayLinesValid 拒绝空数组、重复、未知值与超长', () => {
  assert.equal(isDisplayLinesValid([]), false, '一行都不显示等于看不见任何和弦');
  assert.equal(isDisplayLinesValid(['chord', 'chord']), false);
  assert.equal(isDisplayLinesValid(['both']), false, 'v1 的 both 不是合法值');
  assert.equal(isDisplayLinesValid(['chord', 'degree', 'roman', 'chord']), false);
  assert.equal(isDisplayLinesValid('chord'), false, 'v1 的单个字符串不再合法');
  assert.equal(isDisplayLinesValid(undefined), false);
  assert.equal(isDisplayLinesValid(null), false);
});

/* ------------------------------------------------------------------ *
 * 显示关口：eventDisplayLines
 * ------------------------------------------------------------------ */

test('三行并行时按固定顺序给出三行，内容各不相同', () => {
  const { lines } = eventDisplayLines(chordEvent, songWith(['chord', 'degree', 'roman']));

  assert.deepEqual(lines.map((l) => l.line), ['chord', 'degree', 'roman']);
  assert.deepEqual(lines.map((l) => l.text), ['G7', '57', 'V7']);
  assert.deepEqual(lines.map((l) => l.usedDegree), [false, true, true]);
});

test('输入顺序不影响输出顺序 —— 顺序是「哪一行是什么」的保证', () => {
  const { lines } = eventDisplayLines(chordEvent, songWith(['roman', 'chord', 'degree']));
  assert.deepEqual(lines.map((l) => l.line), ['chord', 'degree', 'roman']);
});

test('只选一行时就是那一行', () => {
  for (const [id, text] of [['chord', 'G7'], ['degree', '57'], ['roman', 'V7']]) {
    const { lines } = eventDisplayLines(chordEvent, songWith([id]));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].line, id);
    assert.equal(lines[0].text, text);
  }
});

test('每一行都带着自己的 parts，属七的角标只出现在级数行', () => {
  const { lines } = eventDisplayLines(chordEvent, songWith(['chord', 'degree', 'roman']));

  assert.deepEqual(lines[0].parts, [{ text: 'G7', script: null }], '和弦名整串就是一段');
  for (const line of lines.slice(1)) {
    assert.deepEqual(line.parts.map((p) => p.script), [null, 'sub'], `${line.line} 的属七后缀要带角标`);
    assert.equal(line.parts.map((p) => p.text).join(''), line.text, 'parts 拼起来必须等于 text');
  }
});

test('未支持调式时级数行被跳过，只剩和弦名', () => {
  const { lines, note } = eventDisplayLines(chordEvent, songWith(['chord', 'degree', 'roman'], { tonic:'A', mode:'dorian' }));

  assert.deepEqual(lines.map((l) => l.line), ['chord']);
  assert.equal(lines[0].text, 'G7');
  assert.match(note, /尚不支持级数/, '要说明为什么级数行不见了');
});

test('未支持调式 + 只选了级数行时退回和弦名', () => {
  for (const selection of [['degree'], ['roman'], ['degree', 'roman']]) {
    const { lines } = eventDisplayLines(chordEvent, songWith(selection, { tonic:'A', mode:'dorian' }));
    assert.equal(lines.length, 1, `选了 ${selection.join('+')} 也必须至少有一行`);
    assert.equal(lines[0].line, 'chord');
    assert.equal(lines[0].text, 'G7');
  }
});

test('休止固定占一行，不会因为选了三行就画三次「休止」', () => {
  const { lines, note } = eventDisplayLines(restEvent, songWith(['chord', 'degree', 'roman']));

  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, 'rest');
  assert.equal(lines[0].text, '休止');
  assert.equal(lines[0].usedDegree, false);
  assert.equal(note, null);
});

test('layout 缺失或 displayLines 非法时退回和弦名，不抛异常', () => {
  const bare = { key: C_MAJOR };

  for (const layout of [undefined, {}, { displayLines: [] }, { displayLines: 'degree' }, { displayLines: ['bogus'] }]) {
    const { lines } = eventDisplayLines(chordEvent, { key: C_MAJOR, ...(layout ? { layout } : {}) });
    assert.equal(lines.length, 1, `layout=${JSON.stringify(layout)} 也要能渲染`);
    assert.equal(lines[0].text, 'G7');
  }

  assert.equal(eventDisplayLines(chordEvent, bare).lines[0].text, 'G7');
});

test('换算必须只读：显示一遍不改动事件与歌曲', () => {
  const event = { kind: 'chord', beats: 4, chord: { root: 'G', quality: '7', bass: null } };
  const song = songWith(['chord', 'degree', 'roman']);
  const snapshot = JSON.stringify([event, song]);

  eventDisplayLines(event, song);

  assert.equal(JSON.stringify([event, song]), snapshot, '显示关口不得写回数据');
});

/* ------------------------------------------------------------------ *
 * 减三后缀 `dimSuffix`（SPEC §6.7.1）
 *
 * 它和 `displayLines` 走同一套「读容错 / 写严格」的分工，但**多一条**：
 * 它是可缺省字段（§7.4），所以「缺失」本身必须被当成合法，而不是错。
 * ------------------------------------------------------------------ */

test('normalizeDimSuffix：认不出的值一律退化成缺省，且缺省等于旧行为', () => {
  assert.equal(DEFAULT_DIM_SUFFIX, 'dim', '缺省值变了就等于悄悄改了用户已有的谱子');
  assert.equal(normalizeDimSuffix('°'), '°');
  assert.equal(normalizeDimSuffix('dim'), 'dim');

  for (const bogus of [undefined, null, '', 'o', 'DIM', '°°', 0, 1, {}, [], true]) {
    assert.equal(
      normalizeDimSuffix(bogus),
      DEFAULT_DIM_SUFFIX,
      `${JSON.stringify(bogus)} 应当退化成缺省`,
    );
  }
});

test('isDimSuffixValid：只认表里的两个值，且不负责判断「缺失」', () => {
  for (const value of DIM_SUFFIX_STYLES) assert.equal(isDimSuffixValid(value), true);
  for (const bogus of ['o', 'DIM', '', null, 0, {}, []]) {
    assert.equal(isDimSuffixValid(bogus), false, `${JSON.stringify(bogus)} 不是合法取值`);
  }
  // 缺失不是「合法取值」，而是「这个字段不参与判断」—— 由调用方写成
  // `value === undefined || isDimSuffixValid(value)`。这里把它钉住，
  // 免得以后有人顺手改成 `isDimSuffixValid(undefined) === true` 而破坏写入侧的严格性。
  assert.equal(isDimSuffixValid(undefined), false);
});

test('老数据没有 dimSuffix：级数行照常渲染成 dim，不报错也不留空', () => {
  // `songWith` 造出来的 layout 就**没有** dimSuffix —— 正是 localStorage 里老数据的形态。
  const event = { kind: 'chord', beats: 4, chord: { root: 'B', quality: 'dim', bass: null } };
  const { lines, note } = eventDisplayLines(event, songWith(['chord', 'degree', 'roman']));

  assert.equal(note, null, '缺字段不该被当成错误报出来');
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Bdim', '7dim', 'viidim'],
    '缺省等价于 dim；和弦名那行永远是 Bdim',
  );
});

test('dimSuffix 为 ° 时透传到每一行级数，而和弦名那行不受影响', () => {
  const event = { kind: 'chord', beats: 4, chord: { root: 'B', quality: 'dim', bass: null } };
  const song = { key: C_MAJOR, layout: { barsPerRow: 4, displayLines: ['chord', 'degree', 'roman'], dimSuffix: '°', fontScale: 1 } };
  const { lines } = eventDisplayLines(event, song);

  assert.deepEqual(
    lines.map((line) => line.text),
    ['Bdim', '7°', 'vii°'],
    '和弦名不带 °，两行级数都带 —— 这正是「° 是级数记法、不是和弦性质符号」',
  );
  assert.equal(lines[0].usedDegree, false);
  assert.equal(lines[1].usedDegree, true);
  assert.equal(lines[2].usedDegree, true);
});

test('非法的 dimSuffix 不会让谱面空掉（显示关口自己兜底）', () => {
  const event = { kind: 'chord', beats: 4, chord: { root: 'B', quality: 'dim', bass: null } };

  for (const bogus of ['o', 'DIM', 42, {}]) {
    const song = { key: C_MAJOR, layout: { barsPerRow: 4, displayLines: ['degree'], dimSuffix: bogus, fontScale: 1 } };
    const { lines, note } = eventDisplayLines(event, song);
    assert.equal(lines.length, 1, `dimSuffix=${JSON.stringify(bogus)} 也要能渲染`);
    assert.equal(lines[0].text, '7dim', '退化成缺省写法');
    assert.equal(note, null);
  }
});

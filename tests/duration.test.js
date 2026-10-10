/**
 * 时值与小节长度校验（src/core/duration.js）的自动测试。
 *
 * 这里的每一条都对应 SPEC §3 的一条规则。之所以写得这么细，是因为时值算错
 * 属于「安静地坏掉」：谱面看起来正常，演出现场才发现小节少了一拍。
 *
 * @see docs/SPEC.md §3
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSong } from '../src/core/song.js';
import {
  DURATION_CODES,
  beatsEqual,
  checkBarDuration,
  checkBeatsValue,
  classifyBarEvents,
  collectDurationIssues,
  formatDurationIssues,
  formatDurationLocation,
  isExactlyRepresentable,
  isSongDurationsValid,
  resolveBarBeats,
  sumEventBeats,
} from '../src/core/duration.js';

/** 造一组「只关心时值」的事件草稿。`null` 表示省略了时值。 */
function drafts(beatsList) {
  return beatsList.map((beats) => ({ kind: 'chord', chord: { root: 'C', quality: 'maj', bass: null }, beats }));
}

/* ------------------------------------------------------------------ *
 * 「精确可表达」判定（§3.4）
 * ------------------------------------------------------------------ */

test('精确可表达判定：要求时值最多精确到 1/16 拍', () => {
  // SPEC §3.4 的表格逐行验证。
  assert.equal(isExactlyRepresentable(4 / 2), true, '4/4 分 2 份 → 2 拍');
  assert.equal(isExactlyRepresentable(4 / 4), true, '4/4 分 4 份 → 1 拍');
  assert.equal(isExactlyRepresentable(4 / 3), false, '4/4 分 3 份 → 1.333… 必须报错');
  assert.equal(isExactlyRepresentable(3 / 2), true, '3/4 分 2 份 → 1.5 拍（附点四分音符）');
  assert.equal(isExactlyRepresentable(6 / 4), true, '6/8 分 4 份 → 1.5 拍');
  assert.equal(isExactlyRepresentable(6 / 5), false, '6/8 分 5 份 → 1.2 拍必须报错');

  assert.equal(isExactlyRepresentable(1 / 16), true, '1/16 拍是下界');
  assert.equal(isExactlyRepresentable(1 / 32), false, '比 1/16 拍更细就不接受');
  assert.equal(isExactlyRepresentable(0.0625), true, '0.0625 = 1/16');
});

test('beatsEqual 用容差比较，不靠 ===', () => {
  assert.equal(beatsEqual(0.1 + 0.2, 0.3), true, '浮点误差不应判为不等');
  assert.equal(beatsEqual(1, 1.5), false);
  assert.equal(beatsEqual(4, 4 + 1e-12), true);
});

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

test('classifyBarEvents 分辨四种填写情况', () => {
  assert.equal(classifyBarEvents([]), 'empty');
  assert.equal(classifyBarEvents(undefined), 'empty');
  assert.equal(classifyBarEvents(drafts([null, null])), 'all-omitted');
  assert.equal(classifyBarEvents(drafts([2, 2])), 'all-explicit');
  assert.equal(classifyBarEvents(drafts([2, null])), 'mixed');
  assert.equal(classifyBarEvents([{ beats: NaN }]), 'all-omitted', 'NaN 不算写明时值');
});

test('sumEventBeats 跳过省略的时值', () => {
  assert.equal(sumEventBeats(drafts([2, 2])), 4);
  assert.equal(sumEventBeats(drafts([2, null])), 2);
  assert.equal(sumEventBeats(drafts([null, null])), 0);
  assert.equal(sumEventBeats([]), 0);
  assert.equal(sumEventBeats(drafts([1.5, 2.5])), 4, '1.5 + 2.5 = 4（浮点下用容差）');
});

test('checkBeatsValue 校验单个时值：正数、有限、不超上限', () => {
  assert.equal(checkBeatsValue(1).ok, true);
  assert.equal(checkBeatsValue(0.5).ok, true);
  assert.equal(checkBeatsValue(64).ok, true, '上限本身是允许的');
  assert.equal(checkBeatsValue(0).ok, false, '0 不是正数');
  assert.equal(checkBeatsValue(-1).ok, false);
  assert.equal(checkBeatsValue(64.5).ok, false);
  assert.equal(checkBeatsValue('2').ok, false, '字符串不是数值');
  assert.equal(checkBeatsValue(null).ok, false);
  assert.equal(checkBeatsValue(NaN).ok, false);
  assert.equal(checkBeatsValue(Infinity).ok, false);
});

/* ------------------------------------------------------------------ *
 * resolveBarBeats：情况 A / B / C
 * ------------------------------------------------------------------ */

test('情况 A：全部省略时均分整小节', () => {
  const two = resolveBarBeats(drafts([null, null]), 4);
  assert.equal(two.ok, true);
  assert.deepEqual(two.value, [2, 2]);

  const four = resolveBarBeats(drafts([null, null, null, null]), 4);
  assert.deepEqual(four.value, [1, 1, 1, 1]);

  const waltz = resolveBarBeats(drafts([null, null]), 3);
  assert.deepEqual(waltz.value, [1.5, 1.5], '3/4 分 2 份 = 1.5 拍，可精确表达');

  const sixEight = resolveBarBeats(drafts([null, null, null, null]), 6);
  assert.deepEqual(sixEight.value, [1.5, 1.5, 1.5, 1.5], '6/8 里 1 拍是八分音符');
});

test('情况 A：除不尽时报错，绝不四舍五入（§3.4）', () => {
  const result = resolveBarBeats(drafts([null, null, null]), 4, { sectionName: 'Verse', barIndex: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null, '失败时不返回任何半成品数值');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, DURATION_CODES.NOT_DIVISIBLE);
  assert.equal(result.issues[0].sectionName, 'Verse');
  assert.equal(result.issues[0].barIndex, 2);
  assert.match(result.issues[0].message, /无法平均分成 3 份/);
  assert.match(result.issues[0].message, /不会自动取整/);
});

test('情况 A：6/8 分 5 份也必须报错', () => {
  const result = resolveBarBeats(drafts([null, null, null, null, null]), 6);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, DURATION_CODES.NOT_DIVISIBLE);
});

test('情况 B：全部写明时校验总和', () => {
  const ok = resolveBarBeats(drafts([2, 2]), 4);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, [2, 2], '写明时值时原样保留，不做任何改写');

  const thirds = resolveBarBeats(drafts([1.5, 1.5, 1]), 4);
  assert.equal(thirds.ok, true);
  assert.deepEqual(thirds.value, [1.5, 1.5, 1]);
});

test('情况 B：欠拍 / 超拍分别报错并给出差额', () => {
  const under = resolveBarBeats(drafts([1, 1]), 4, { sectionName: 'A', barIndex: 0 });
  assert.equal(under.ok, false);
  assert.equal(under.issues[0].code, DURATION_CODES.UNDER);
  assert.match(under.issues[0].message, /少了 2 拍/);

  const over = resolveBarBeats(drafts([3, 3]), 4, { sectionName: 'A', barIndex: 1 });
  assert.equal(over.ok, false);
  assert.equal(over.issues[0].code, DURATION_CODES.OVER);
  assert.equal(over.issues[0].barIndex, 1);
  assert.match(over.issues[0].message, /多了 2 拍/);
});

test('情况 B：时值本身不合法时逐条报出，并带上事件序号', () => {
  const result = resolveBarBeats(
    [
      { kind: 'chord', chord: { root: 'C', quality: 'maj', bass: null }, beats: 0 },
      { kind: 'chord', chord: { root: 'G', quality: 'maj', bass: null }, beats: 4 },
    ],
    4,
    { sectionName: 'A', barIndex: 0 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, DURATION_CODES.INVALID);
  assert.equal(result.issues[0].eventIndex, 0, '应定位到第 1 个事件');
});

test('情况 C：混合填写直接报错，不做任何推测（§3.3）', () => {
  const result = resolveBarBeats(drafts([2, null]), 4, { sectionName: 'Verse', barIndex: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.issues[0].code, DURATION_CODES.MIXED);
  assert.match(result.issues[0].message, /不做推测/);
  assert.equal(result.issues[0].sectionName, 'Verse');
});

test('空小节（chords 类型但没有事件）报错，提示改用 0', () => {
  const result = resolveBarBeats([], 4, { sectionName: 'A', barIndex: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, DURATION_CODES.BAR_HAS_NO_EVENT);
  assert.match(result.issues[0].message, /空白小节/);
});

/* ------------------------------------------------------------------ *
 * checkBarDuration / collectDurationIssues
 * ------------------------------------------------------------------ */

test('已建好的小节：空白小节视为满足，不参与计算（§3.2）', () => {
  assert.deepEqual(checkBarDuration({ type: 'empty', events: [] }, 4), []);
  assert.deepEqual(checkBarDuration({ type: 'empty', events: [] }, 3), []);
});

test('已建好的小节：普通小节直接校验总和', () => {
  assert.deepEqual(checkBarDuration({ type: 'chords', events: drafts([4]) }, 4), []);
  assert.deepEqual(checkBarDuration({ type: 'chords', events: drafts([2, 2]) }, 4), []);

  const issues = checkBarDuration({ type: 'chords', events: drafts([2]) }, 4, { sectionName: 'A', barIndex: 1 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, DURATION_CODES.UNDER);
});

test('整首歌校验：逐小节检查并给出可定位的路径', () => {
  const song = createSong({
    timeSignature: '4/4',
    sections: [
      {
        name: 'Intro',
        bars: [
          { type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }] },
          { type: 'empty' },
        ],
      },
      {
        name: 'Verse',
        bars: [
          { type: 'chords', events: [{ kind: 'chord', beats: 3, chord: { root: 'F' } }] },
          { type: 'chords', events: [{ kind: 'rest', beats: 5 }] },
        ],
      },
    ],
  });

  const issues = collectDurationIssues(song);
  assert.equal(issues.length, 2, 'Intro 两小节都合法，Verse 两小节一欠一超');
  assert.equal(issues[0].path, 'sections[1].bars[0]');
  assert.equal(issues[0].code, DURATION_CODES.UNDER);
  assert.equal(issues[0].sectionName, 'Verse');
  assert.equal(issues[0].barIndex, 0);
  assert.equal(issues[1].path, 'sections[1].bars[1]');
  assert.equal(issues[1].code, DURATION_CODES.OVER);
  assert.equal(isSongDurationsValid(song), false);
});

test('整首歌校验：拍号不受支持时明确报出，而不是当作 4/4 硬算', () => {
  const issues = collectDurationIssues({ timeSignature: '5/4', sections: [] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, DURATION_CODES.TIME_SIGNATURE_UNSUPPORTED);
  assert.equal(issues[0].path, 'timeSignature');
});

test('改拍号之后重新校验能查出原本合法的小节（§3.5）', () => {
  const song = createSong({
    timeSignature: '4/4',
    sections: [{ name: 'A', bars: [{ type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }] }] }],
  });
  assert.equal(isSongDurationsValid(song), true);

  // 只改拍号，时值一动不动 —— 于是 4 拍的小节在 3/4 里就超拍了。
  const waltz = { ...song, timeSignature: '3/4' };
  const issues = collectDurationIssues(waltz);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, DURATION_CODES.OVER);
  assert.match(issues[0].message, /多了 1 拍/);
});

test('示例歌曲的每个非空白小节都正好填满整小节', () => {
  // 这是 §10 第 2 项检查的一部分：不同拍号下的时值校验在真实数据上也要成立。
  const song = createSong({
    timeSignature: '6/8',
    sections: [
      {
        name: 'A',
        bars: [
          { type: 'chords', events: [{ kind: 'chord', beats: 3, chord: { root: 'C' } }, { kind: 'chord', beats: 3, chord: { root: 'G' } }] },
          { type: 'empty' },
          { type: 'chords', events: [{ kind: 'rest', beats: 6 }] },
        ],
      },
    ],
  });
  assert.deepEqual(collectDurationIssues(song), []);
  assert.equal(isSongDurationsValid(song), true);
});

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

test('formatDurationLocation 拼出人可读的位置', () => {
  assert.equal(
    formatDurationLocation({ sectionName: 'Verse', barIndex: 1, eventIndex: 0 }),
    '[Verse] · 第 2 小节 · 第 1 个事件',
  );
  assert.equal(formatDurationLocation({ sectionName: 'Verse', barIndex: 1, eventIndex: null }), '[Verse] · 第 2 小节');
  assert.equal(formatDurationLocation({}), '');
});

test('formatDurationIssues 折叠过多的条目', () => {
  const issues = Array.from({ length: 11 }, (_, i) => ({
    code: DURATION_CODES.UNDER,
    message: `第 ${i} 个小节欠拍`,
    sectionName: 'A',
    barIndex: i,
    eventIndex: null,
  }));
  const text = formatDurationIssues(issues, 8);
  assert.equal(text.split('\n').length, 9);
  assert.match(text, /另有 3 处时值问题/);
});

/**
 * 数据模型、结构校验与和弦解析的测试。
 *
 * 覆盖：示例歌曲数据自洽、结构校验拦坏数据、和弦解析与格式化、拍号单位。
 * 解析器、时值校验、编辑操作、撤销重做、本地存储、导入导出的测试分别在
 * parser / duration / edit / history / library / project 各自的测试文件里。
 *
 * 运行：npm test
 *
 * 注：阶段一这里曾有一组「用正则按 SPEC §4 自己数小节」的临时交叉检查，
 * 用来在没有解析器时挡住示例文本与数据脱节。阶段二实现了真解析器之后，
 * 它已由 `tests/parser.test.js` 的「示例文本解析出来与示例数据结构完全一致」
 * 取代并删除——那种自己实现一遍规则的检查会随着语法演进而漂移，
 * 留着反而是第二套真相。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SAMPLE_SONG } from '../src/data/sample-song.js';
import { createChord, formatChordSymbol, parseChordSymbol } from '../src/core/chord.js';
import { TIME_SIGNATURES, getBeatsPerBar } from '../src/core/constants.js';
import {
  cloneSong,
  createEmptySong,
  deserializeSongText,
  serializeSong,
  validateSongShape,
} from '../src/core/song.js';
import { collectIds } from '../src/core/ids.js';

/** 把歌曲里所有小节摊平，方便逐小节断言。 */
function allBars(song) {
  return song.sections.flatMap((section) =>
    section.bars.map((bar) => ({ sectionName: section.name, bar })),
  );
}

/** 计算一个小节里显式写出的时值总和；含未写时值的事件时返回 null。 */
function sumExplicitBeats(bar) {
  let total = 0;
  for (const event of bar.events) {
    if (typeof event.beats !== 'number' || !Number.isFinite(event.beats)) return null;
    total += event.beats;
  }
  return total;
}

describe('示例歌曲数据', () => {
  it('通过结构校验', () => {
    const result = validateSongShape(SAMPLE_SONG);
    assert.equal(
      result.ok,
      true,
      `示例歌曲未通过校验：\n${result.errors.map((e) => `${e.path} ${e.message}`).join('\n')}`,
    );
  });

  it('所有 ID 唯一（不依赖数组下标）', () => {
    const ids = collectIds(SAMPLE_SONG);
    assert.equal(new Set(ids).size, ids.length, '存在重复 ID');
    assert.ok(ids.length > 20, '示例歌曲的 ID 数量异常偏少，示例数据可能被截断');
  });

  it('每个非空白小节都填满整小节时值', () => {
    const beatsPerBar = getBeatsPerBar(SAMPLE_SONG.timeSignature);
    assert.equal(beatsPerBar, 4);
    for (const { sectionName, bar } of allBars(SAMPLE_SONG)) {
      if (bar.type === 'empty') {
        assert.equal(bar.events.length, 0, `${sectionName} 的空白小节不应有事件`);
        continue;
      }
      const total = sumExplicitBeats(bar);
      assert.equal(total, beatsPerBar, `${sectionName} 有小节时值为 ${total} 拍，应为 ${beatsPerBar} 拍`);
    }
  });

  it('序列化后能原样读回（JSON 往返不丢信息）', () => {
    const text = serializeSong(SAMPLE_SONG);
    const parsed = deserializeSongText(text);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.map((e) => e.message).join('\n'));
    assert.deepEqual(parsed.value, SAMPLE_SONG);
  });

  it('深拷贝不共享可变对象', () => {
    const copy = cloneSong(SAMPLE_SONG);
    copy.sections[0].bars[0].events[0].chord.root = 'D';
    copy.sections[0].name = '改过的名字';
    assert.equal(SAMPLE_SONG.sections[0].bars[0].events[0].chord.root, 'C');
    assert.equal(SAMPLE_SONG.sections[0].name, 'Intro');
  });

  it('空白小节与休止是两种不同的东西', () => {
    const outro = SAMPLE_SONG.sections.find((s) => s.name === 'Outro');
    assert.ok(outro, '示例歌曲应包含 Outro 段');

    const emptyBar = outro.bars.find((bar) => bar.type === 'empty');
    assert.ok(emptyBar, '示例歌曲应包含一个空白小节');
    assert.equal(emptyBar.events.length, 0);

    const chordBar = outro.bars.find((bar) => bar.events.some((e) => e.kind === 'rest'));
    assert.ok(chordBar, '示例歌曲应包含一个带休止的小节');
    assert.equal(chordBar.type, 'chords', '带休止的小节类型仍是 chords');
    assert.ok(chordBar.events.length > 0, '休止小节不能同时是空白小节');
  });
});

describe('结构校验会拦住坏数据', () => {
  it('拒绝 schemaVersion 不匹配的数据', () => {
    const broken = { ...cloneSong(SAMPLE_SONG), schemaVersion: 99 };
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'schemaVersion'));
  });

  it('拒绝重复 ID', () => {
    const broken = cloneSong(SAMPLE_SONG);
    broken.sections[1].bars[0].id = broken.sections[0].bars[0].id;
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes('重复 ID')));
  });

  it('拒绝带事件的空白小节', () => {
    const broken = cloneSong(SAMPLE_SONG);
    // 按段落名查找，而不是用 sections[3] 这类下标——增删段落时下标会漂，测试不该跟着坏。
    const outro = broken.sections.find((section) => section.name === 'Outro');
    const emptyBar = outro.bars.find((bar) => bar.type === 'empty');
    assert.ok(emptyBar, '示例歌曲应包含一个空白小节');
    emptyBar.events = [{ kind: 'rest', id: 'evt_fake00001', beats: 4 }];
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.message.includes('空白小节')));
  });

  it('拒绝非正数时值', () => {
    for (const beats of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = cloneSong(SAMPLE_SONG);
      broken.sections[0].bars[0].events[0].beats = beats;
      const result = validateSongShape(broken);
      assert.equal(result.ok, false, `时值 ${beats} 应被拒绝`);
    }
  });

  it('拒绝不支持的小调调号，而不是默默按大调算', () => {
    const broken = cloneSong(SAMPLE_SONG);
    broken.key = { tonic: 'A', mode: 'dorian' };
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    const issue = result.errors.find((e) => e.path === 'key.mode');
    assert.ok(issue, '应报出 key.mode 问题');
    assert.ok(issue.message.includes('major'), '错误信息应说明支持的调式');
  });

  it('拒绝不支持的拍号', () => {
    const broken = cloneSong(SAMPLE_SONG);
    broken.timeSignature = '5/4';
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'timeSignature'));
  });

  it('拒绝非法的每行小节数', () => {
    const broken = cloneSong(SAMPLE_SONG);
    broken.layout.barsPerRow = 3;
    const result = validateSongShape(broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'layout.barsPerRow'));
  });

  it('导入非法 JSON 时返回错误而不是抛异常', () => {
    const result = deserializeSongText('{ 这不是 JSON');
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].message.includes('JSON'));
  });

  it('导入结构正确的 JSON 会成功', () => {
    const result = deserializeSongText(serializeSong(SAMPLE_SONG));
    assert.equal(result.ok, true);
    assert.equal(result.value.title, '候鸟信');
  });

  it('新建的空歌曲也通过校验', () => {
    const result = validateSongShape(createEmptySong('测试歌曲'));
    assert.equal(result.ok, true, result.errors.map((e) => e.message).join('\n'));
  });
});

describe('和弦解析与格式化', () => {
  it('示例歌曲覆盖全部 9 种和弦性质，这样它才能当 fixture 用', () => {
    const qualities = new Set();
    for (const { bar } of allBars(SAMPLE_SONG)) {
      for (const event of bar.events) {
        if (event.kind === 'chord') qualities.add(event.chord.quality);
      }
    }
    const expected = ['maj', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'aug'];
    for (const quality of expected) {
      assert.ok(qualities.has(quality), `示例歌曲没有覆盖和弦性质 "${quality}"`);
    }
    assert.equal(qualities.size, expected.length, `出现了预期之外的和弦性质：${[...qualities].join(', ')}`);
  });

  it('示例歌曲里出现的和弦都能解析并原样格式化回去', () => {
    const symbols = new Set();
    for (const { bar } of allBars(SAMPLE_SONG)) {
      for (const event of bar.events) {
        if (event.kind === 'chord') symbols.add(formatChordSymbol(event.chord, { glyphs: false }));
      }
    }
    assert.ok(symbols.size >= 15, `示例歌曲的和弦种类偏少（${symbols.size} 种）：${[...symbols].join(', ')}`);

    for (const symbol of symbols) {
      const parsed = parseChordSymbol(symbol);
      assert.equal(parsed.ok, true, `"${symbol}" 解析失败：${parsed.ok ? '' : parsed.message}`);
      assert.equal(formatChordSymbol(parsed.value, { glyphs: false }), symbol);
    }
  });

  it('斜杠低音被正确拆成根音和低音', () => {
    const parsed = parseChordSymbol('G/B');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { root: 'G', quality: 'maj', bass: 'B' });
  });

  it('长后缀优先，maj7 不会被 m 抢先匹配', () => {
    const parsed = parseChordSymbol('Bbmaj7');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { root: 'Bb', quality: 'maj7', bass: null });
  });

  it('明确拒绝不支持的和弦写法，而不是猜一个近似结果', () => {
    for (const bad of ['Cinvalid-quality', 'Cmystery', 'Cunknown']) {
      const parsed = parseChordSymbol(bad);
      assert.equal(parsed.ok, false, `"${bad}" 本版不支持，不应解析成功`);
      assert.ok(parsed.message.length > 0);
    }
  });

  it('拒绝格式不合法的输入', () => {
    for (const bad of ['', 'H7', 'C#b', 'C/G/B', 'C/']) {
      const parsed = parseChordSymbol(bad);
      assert.equal(parsed.ok, false, `"${bad}" 应被拒绝`);
    }
  });

  it('createChord 逐项校验并给出指向具体字段的错误', () => {
    const ok = createChord({ root: 'F#', quality: 'm7', bass: 'A' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { root: 'F#', quality: 'm7', bass: 'A' });

    const badRoot = createChord({ root: 'X', quality: 'm' });
    assert.equal(badRoot.ok, false);
    assert.ok(badRoot.message.includes('根音'));

    const badQuality = createChord({ root: 'C', quality: 'invalid-quality' });
    assert.equal(badQuality.ok, false);
    assert.ok(badQuality.message.includes('和弦性质'));
  });
});

describe('拍号的拍数单位', () => {
  it('每个拍号都给出明确的每小节拍数', () => {
    assert.equal(getBeatsPerBar('4/4'), 4);
    assert.equal(getBeatsPerBar('3/4'), 3);
    assert.equal(getBeatsPerBar('6/8'), 6);
    assert.equal(getBeatsPerBar('5/4'), 0, '不支持的拍号应返回 0，由调用方报错');
  });

  it('6/8 的说明点明单位是八分音符，避免与附点四分音符混淆', () => {
    assert.equal(TIME_SIGNATURES['6/8'].beatNote, 'eighth');
    assert.ok(TIME_SIGNATURES['6/8'].hint.includes('八分音符'));
    assert.ok(TIME_SIGNATURES['6/8'].hint.includes('附点四分音符'));
  });
});

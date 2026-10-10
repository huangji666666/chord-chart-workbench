/**
 * 功能谱文本解析与序列化（src/core/parser.js）的自动测试。
 *
 * 这个文件里最重要的一条是「示例文本与示例数据一致」：它同时验证语法实现、
 * 时值分配、段落继承和序列化的正确性——任何一环偏了都会在这里露出来。
 *
 * @see docs/SPEC.md §4
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptySong, createSong, validateSongShape } from '../src/core/song.js';
import { SAMPLE_SONG, SAMPLE_SONG_TEXT } from '../src/data/sample-song.js';
import {
  PARSE_CODES,
  applyParsedSections,
  formatParseIssue,
  formatParseIssues,
  parseSongText,
  parseSongTextInto,
  songToText,
} from '../src/core/parser.js';

/** 只用来兜底的基底歌曲：解析结果会整体替换它的段落。 */
function baseSong() {
  return createSong({ title: '基底', timeSignature: '4/4', sections: [{ name: '占位', bars: [{ type: 'empty' }] }] });
}

/* ------------------------------------------------------------------ *
 * 示例文本 ↔ 示例数据（SPEC §10 第 1 项）
 * ------------------------------------------------------------------ */

test('示例文本解析出来与示例数据结构完全一致', () => {
  const result = parseSongTextInto(SAMPLE_SONG_TEXT, SAMPLE_SONG);
  assert.equal(result.ok, true, `示例文本应当解析成功，实际错误：\n${formatParseIssues(result.issues ?? [])}`);

  const actual = result.value.sections;
  const expected = SAMPLE_SONG.sections;
  assert.equal(actual.length, expected.length, '段落数');

  expected.forEach((expectedSection, sectionIndex) => {
    const actualSection = actual[sectionIndex];
    // 文本语法里没有 repeat / cue，它们按同名段落继承（§4.7）。
    assert.equal(actualSection.id, expectedSection.id, `第 ${sectionIndex + 1} 段应继承原段落 ID`);
    assert.equal(actualSection.name, expectedSection.name);
    assert.equal(actualSection.repeat, expectedSection.repeat, `[${expectedSection.name}] 的 repeat 应被继承`);
    assert.equal(actualSection.cue, expectedSection.cue, `[${expectedSection.name}] 的 cue 应被继承`);
    assert.equal(actualSection.bars.length, expectedSection.bars.length, `[${expectedSection.name}] 的小节数`);

    expectedSection.bars.forEach((expectedBar, barIndex) => {
      const actualBar = actualSection.bars[barIndex];
      const where = `[${expectedSection.name}] 第 ${barIndex + 1} 小节`;
      assert.equal(actualBar.type, expectedBar.type, `${where} 的小节类型`);
      assert.equal(actualBar.events.length, expectedBar.events.length, `${where} 的事件数`);
      expectedBar.events.forEach((expectedEvent, eventIndex) => {
        const actualEvent = actualBar.events[eventIndex];
        const eventWhere = `${where} 第 ${eventIndex + 1} 个事件`;
        assert.equal(actualEvent.kind, expectedEvent.kind, eventWhere);
        assert.equal(actualEvent.beats, expectedEvent.beats, `${eventWhere} 的时值`);
        if (expectedEvent.kind === 'chord') {
          assert.deepEqual(actualEvent.chord, expectedEvent.chord, `${eventWhere} 的和弦`);
        }
      });
    });
  });
});

test('示例歌曲的规模：5 段 32 小节 44 个事件', () => {
  const result = parseSongText(SAMPLE_SONG_TEXT);
  assert.equal(result.ok, true);

  const barCount = result.sections.reduce((sum, section) => sum + section.bars.length, 0);
  const eventCount = result.sections.reduce(
    (sum, section) => sum + section.bars.reduce((barSum, bar) => barSum + bar.events.length, 0),
    0,
  );

  assert.equal(result.sections.length, 5);
  assert.equal(barCount, 32);
  assert.equal(eventCount, 44);
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'],
  );
});

test('示例文本里出现的和弦覆盖全部 9 种性质', () => {
  const result = parseSongText(SAMPLE_SONG_TEXT);
  const qualities = new Set();
  for (const section of result.sections) {
    for (const bar of section.bars) {
      for (const event of bar.events) {
        if (event.kind === 'chord') qualities.add(event.chord.quality);
      }
    }
  }
  assert.deepEqual(
    [...qualities].sort(),
    ['7', 'aug', 'dim', 'm', 'm7', 'maj', 'maj7', 'sus2', 'sus4'],
    '示例数据是 fixture，必须覆盖全部 9 种性质',
  );
});

test('示例歌曲里空白小节与休止是两种不同的小节', () => {
  const result = parseSongText(SAMPLE_SONG_TEXT);
  const outro = result.sections.find((section) => section.name === 'Outro');

  assert.equal(outro.bars[2].type, 'empty', '单独一个 0 是空白小节');
  assert.equal(outro.bars[2].events.length, 0);

  assert.equal(outro.bars[3].type, 'chords', '含休止的小节是 chords 类型');
  assert.deepEqual(outro.bars[3].events.map((event) => event.kind), ['chord', 'rest']);
  assert.equal(outro.bars[3].events[1].beats, 2);
});

/* ------------------------------------------------------------------ *
 * 语法元素
 * ------------------------------------------------------------------ */

test('换行等价于小节分隔符，不会把两行悄悄并成一个小节（§4.3）', () => {
  const result = parseSongText('[Verse]\nC:4\nAm:4\n');
  assert.equal(result.ok, true);
  assert.equal(result.sections[0].bars.length, 2, '必须解析成 2 个小节');
  assert.equal(result.sections[0].bars[0].events.length, 1);
  assert.equal(result.sections[0].bars[1].events.length, 1);
});

test('同一行里用 | 写多个小节', () => {
  const result = parseSongText('[Verse]\nC:4 | Am:4 | F:2 G:2');
  assert.equal(result.ok, true);
  assert.equal(result.sections[0].bars.length, 3);
  assert.equal(result.sections[0].bars[2].events.length, 2);
});

test('行尾多余的 | 允许出现并被忽略（§4.3）', () => {
  const result = parseSongText('[Verse]\nC:4 | Am:4 |');
  assert.equal(result.ok, true);
  assert.equal(result.sections[0].bars.length, 2, '末尾的空片段应被丢掉');
});

test('连续分隔符产生空片段时报错，而不是静默忽略（§4.3）', () => {
  const result = parseSongText('[Verse]\nC:4 || Am:4');
  assert.equal(result.ok, false);
  assert.equal(result.sections.length, 0, '失败时不返回半份数据');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, PARSE_CODES.BAR_SEGMENT_EMPTY);
  assert.equal(result.issues[0].line, 2);
  assert.match(result.issues[0].message, /整小节留白请写一个 0/);
});

test('完全空白的行被忽略，可用来分隔段落', () => {
  const result = parseSongText('[A]\nC:4\n\n\n[A2]\nG:4\n');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['A', 'A2'],
  );
  assert.equal(result.sections[0].bars.length, 1);
});

test('休止记号 R:2 与省略时值的 R 都能解析', () => {
  const explicit = parseSongText('[A]\nC:2 R:2');
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.sections[0].bars[0].events.map((event) => event.kind), ['chord', 'rest']);
  assert.deepEqual(explicit.sections[0].bars[0].events.map((event) => event.beats), [2, 2]);

  const omitted = parseSongText('[A]\nR R');
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.sections[0].bars[0].events.map((event) => event.beats), [2, 2], '两个事件均分 4 拍');
  assert.equal(omitted.sections[0].bars[0].events[0].kind, 'rest');
});

test('小写 r 也认，大小写不敏感', () => {
  const result = parseSongText('[A]\nr:4');
  assert.equal(result.ok, true);
  assert.equal(result.sections[0].bars[0].events[0].kind, 'rest');
});

test('斜杠和弦解析成根音 + 性质 + 低音', () => {
  const result = parseSongText('[A]\nG/B:4');
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections[0].bars[0].events[0].chord, { root: 'G', quality: 'maj', bass: 'B' });
});

test('0 独占一个小节表示空白小节（§2.4）', () => {
  const result = parseSongText('[A]\n0 | C:4 | 0');
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections[0].bars.map((bar) => bar.type), ['empty', 'chords', 'empty']);
});

test('0:2 这种写法报错', () => {
  const result = parseSongText('[A]\n0:2');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.ZERO_WITH_DURATION);
});

test('0 与和弦混在同一个片段里报错', () => {
  const result = parseSongText('[A]\nC:2 0');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.EMPTY_BAR_WITH_EVENTS);
  assert.equal(result.issues[0].column > 0, true, '应指出出错记号的列号');
});

test('段落名允许空格与中文，同名段落合法（§4.4）', () => {
  const result = parseSongText('[副歌 第二次]\nC:4\n\n[副歌 第二次]\nG:4');
  assert.equal(result.ok, true);
  assert.equal(result.sections.length, 2);
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['副歌 第二次', '副歌 第二次'],
  );
});

/* ------------------------------------------------------------------ *
 * 时值：三种情况
 * ------------------------------------------------------------------ */

test('全部省略时值 → 均分整小节（§3.3 A）', () => {
  const result = parseSongText('[A]\nC Am F G');
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections[0].bars[0].events.map((event) => event.beats), [1, 1, 1, 1]);
});

test('均分除不尽时报错，不返回任何半成品（§3.4）', () => {
  const result = parseSongText('[A]\nC Am F');
  assert.equal(result.ok, false);
  assert.equal(result.sections.length, 0);
  assert.equal(result.issues[0].code, 'E_DURATION_NOT_DIVISIBLE');
});

test('全部写明时值 → 校验总和（§3.3 B）', () => {
  assert.equal(parseSongText('[A]\nC:2 Am:2').ok, true);

  const under = parseSongText('[A]\nC:2');
  assert.equal(under.ok, false);
  assert.equal(under.issues[0].code, 'E_DURATION_UNDER');
  assert.equal(under.issues[0].sectionName, 'A');
  assert.equal(under.issues[0].barIndex, 0);

  const over = parseSongText('[A]\nC:4 Am:4');
  assert.equal(over.ok, false);
  assert.equal(over.issues[0].code, 'E_DURATION_OVER');
});

test('混合填写直接报错，不做推测（§3.3 C）', () => {
  const result = parseSongText('[A]\nC:2 Am');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'E_DURATION_MIXED');
});

test('时值本身非法时逐条报出（§3.3）', () => {
  const cases = [
    ['C:0', /时值不能是 0/],
    ['C:-1', /必须是正数/],
    ['C:abc', /不是有效时值/],
    ['C:65', /超过上限/],
    ['C:', /时值不能为空/],
    ['C:2:3', /时值只能写一次/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseSongText(`[A]\n${text}`);
    assert.equal(result.ok, false, `${text} 应当报错`);
    assert.equal(result.issues[0].code, PARSE_CODES.DURATION_INVALID, `${text} 的错误码`);
    assert.match(result.issues[0].message, pattern, `${text} 的提示`);
  }
});

test('6/8 下每小节 6 拍：C:3 Am:3 合法，C:2 Am:2 欠拍', () => {
  assert.equal(parseSongText('[A]\nC:3 Am:3', { timeSignature: '6/8' }).ok, true);

  const under = parseSongText('[A]\nC:2 Am:2', { timeSignature: '6/8' });
  assert.equal(under.ok, false);
  assert.equal(under.issues[0].code, 'E_DURATION_UNDER');
  assert.match(under.issues[0].message, /每小节要求的 6 拍/);
});

test('3/4 下每小节 3 拍：C:1.5 G:1.5 合法', () => {
  assert.equal(parseSongText('[A]\nC:1.5 G:1.5', { timeSignature: '3/4' }).ok, true);
  assert.equal(parseSongText('[A]\nC:4', { timeSignature: '3/4' }).ok, false, '4 拍在 3/4 里超拍');
});

/* ------------------------------------------------------------------ *
 * 段落头与结构性错误
 * ------------------------------------------------------------------ */

test('段落头必须独占一行', () => {
  const result = parseSongText('[Intro] C:4');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.SECTION_HEADER_NOT_ALONE);
});

test('空段落名报错', () => {
  for (const text of ['[]\nC:4', '[   ]\nC:4']) {
    const result = parseSongText(text);
    assert.equal(result.ok, false, `${JSON.stringify(text)} 应报错`);
    assert.equal(result.issues[0].code, PARSE_CODES.SECTION_NAME_EMPTY);
  }
});

test('段落名过长报错', () => {
  const result = parseSongText(`[${'x'.repeat(41)}]\nC:4`);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.SECTION_NAME_TOO_LONG);
});

test('第一个段落头之前出现内容时报错，不自动补默认段落（§4.4）', () => {
  const result = parseSongText('C:4\n[Intro]\nG:4');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.CONTENT_BEFORE_SECTION);
  assert.equal(result.issues[0].line, 1);
});

test('行内混进方括号时报错并提示写法', () => {
  const result = parseSongText('[A]\nC:4 [B] G:4');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, PARSE_CODES.UNEXPECTED_BRACKET);
});

test('整段文本没有段落时报错', () => {
  const empty = parseSongText('');
  assert.equal(empty.ok, false);
  assert.equal(empty.issues[0].code, PARSE_CODES.NO_SECTION);

  const blank = parseSongText('\n\n   \n');
  assert.equal(blank.ok, false);
  assert.equal(blank.issues[0].code, PARSE_CODES.NO_SECTION);
});

test('非字符串输入报错而不是崩掉', () => {
  for (const value of [null, undefined, 42, {}]) {
    const result = parseSongText(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} 应报错`);
    assert.equal(result.issues[0].code, PARSE_CODES.INPUT_TYPE);
  }
});

/* ------------------------------------------------------------------ *
 * 和弦：不支持的写法（§5.4）
 * ------------------------------------------------------------------ */

test('明确拒绝不支持的和弦写法，并给出针对性提示', () => {
  // 这张表在 2026-09-22 变短了（SPEC §5.4）：`°` `+` `-` `M7` 等写法现在是**合法别名**，
  // 见紧随其后的那一条用例。剩下的每一条都是**乐理范围**问题
  // （本版根本没有对应的性质 id），不是字形问题。
  const cases = [
    ['Cinvalid-quality', /支持|和弦/],
    ['Cmystery', /支持|和弦/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseSongText(`[A]\n${text}:4`);
    assert.equal(result.ok, false, `${text} 应当被拒绝`);
    assert.match(result.issues[0].message, pattern, `${text} 的提示应指出正确写法`);
  }
});

test('输入的别名一律接受，并归一到同一个性质 id（§5.2.1，决策点 H）', () => {
  // 「屏幕上能显示的写法，输入框里就必须能打进来」——
  // 这一条是那条规则的可执行版本：jazz 体系显示出来的每一种后缀，都必须能原样打回去。
  const cases = [
    ['Cm', 'm'],
    ['Cmin', 'm'],
    ['C-', 'm'],
    ['CM', 'maj'],
    ['Cmaj', 'maj'],
    ['Cmaj7', 'maj7'],
    ['CM7', 'maj7'],
    ['CMaj7', 'maj7'],
    ['CMAJ7', 'maj7'],
    ['CΔ', 'maj7'],
    ['CΔ7', 'maj7'],
    ['Cm7', 'm7'],
    ['Cmin7', 'm7'],
    ['C-7', 'm7'],
    ['Cdim', 'dim'],
    ['C°', 'dim'],
    ['Co', 'dim'],
    ['Caug', 'aug'],
    ['C+', 'aug'],
  ];
  for (const [text, expected] of cases) {
    const result = parseSongText(`[A]\n${text}:4`);
    assert.equal(result.ok, true, `${text} 应当被接受`);
    assert.equal(result.sections[0].bars[0].events[0].chord.quality, expected, `${text} 应归一为 ${expected}`);
  }
});

test('别名只影响解析，不进数据 —— 打 CΔ7 存下来就是 {root, quality, bass}（§5.2.1）', () => {
  const result = parseSongText('[A]\nCΔ7:4');
  assert.equal(result.ok, true);
  // 数据里不存在「用户打的是哪种写法」这个信息，跟 §6.4 是同一条原则
  assert.deepEqual(result.sections[0].bars[0].events[0].chord, { root: 'C', quality: 'maj7', bass: null });
});

test('最长后缀优先：maj7 不会被 m 抢先吃掉（§5.2）', () => {
  const result = parseSongText('[A]\nCmaj7:2 Am7:2');
  assert.equal(result.ok, true);
  const [first, second] = result.sections[0].bars[0].events;
  assert.equal(first.chord.quality, 'maj7');
  assert.equal(second.chord.quality, 'm7');
});

test('根音大小写不敏感，内部统一成大写（§5.2）', () => {
  const result = parseSongText('[A]\nc#m7:4');
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections[0].bars[0].events[0].chord, { root: 'C#', quality: 'm7', bass: null });
});

/* ------------------------------------------------------------------ *
 * 错误定位（§4.6）
 * ------------------------------------------------------------------ */

test('错误能定位到行、列、段落、小节和事件', () => {
  const text = ['[Intro]', 'C:4 | Am:4', '', '[Verse]', 'C:4 | Am:4', 'F:2 G:2 X:2'].join('\n');
  const result = parseSongText(text);

  assert.equal(result.ok, false);
  const issue = result.issues[0];
  assert.equal(issue.line, 6, '出错在第 6 行');
  assert.equal(issue.sectionName, 'Verse');
  assert.equal(issue.barIndex, 2, '是该段落第 3 个小节');
  assert.equal(issue.eventIndex, 2, '是第 3 个事件');
  assert.equal(issue.column > 0, true);
  assert.equal(issue.snippet, 'X:2', '应带上出错的原始片段');
});

test('formatParseIssue 拼出可读的一行', () => {
  const line = formatParseIssue({
    code: 'E_CHORD_BAD_ROOT',
    message: '根音无效',
    line: 6,
    column: 10,
    sectionName: 'Verse',
    barIndex: 2,
    eventIndex: 0,
    snippet: 'X:2',
  });
  assert.equal(line, '第 6 行 · [Verse] · 第 3 小节 · 第 1 个事件：根音无效');
});

test('多个错误全部收集，而不是遇到第一个就停', () => {
  const result = parseSongText('[A]\nX:4\n[B]\nY:4');
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2, '两处错误都应报出来');
  assert.deepEqual(
    result.issues.map((issue) => issue.line),
    [2, 4],
  );
});

test('formatParseIssues 折叠过多条目', () => {
  const issues = Array.from({ length: 12 }, (_, i) => ({
    code: 'E_TEST',
    message: `问题 ${i}`,
    line: i + 1,
    column: 1,
    sectionName: 'A',
    barIndex: null,
    eventIndex: null,
    snippet: '',
  }));
  const text = formatParseIssues(issues, 8);
  assert.match(text, /另有 4 处问题/);
});

/* ------------------------------------------------------------------ *
 * 原子性（§4.7）
 * ------------------------------------------------------------------ */

test('解析失败时不返回任何段落，也不改动基底歌曲', () => {
  const song = baseSong();
  const before = JSON.stringify(song);

  const result = parseSongTextInto('[A]\nC:4 || Am:4', song);
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.issues.length > 0);
  assert.equal(JSON.stringify(song), before, '失败的解析绝不能碰基底歌曲');
});

test('解析成功时也返回新对象，基底歌曲保持不变', () => {
  const song = baseSong();
  const before = JSON.stringify(song);

  const result = parseSongTextInto('[A]\nC:4', song);
  assert.equal(result.ok, true);
  assert.notEqual(result.value, song);
  assert.equal(JSON.stringify(song), before);
  assert.equal(validateSongShape(result.value).ok, true);
  assert.equal(result.value.sections[0].name, 'A');
  assert.equal(result.value.sections[0].bars.length, 1);
});

/* ------------------------------------------------------------------ *
 * 段落的 repeat / cue / id 继承（§4.7）
 * ------------------------------------------------------------------ */

test('同名段落按出现顺序继承 repeat / cue / id', () => {
  const base = createSong({
    title: '继承测试',
    sections: [
      { name: 'Chorus', repeat: 3, cue: '第一次的提示', bars: [{ type: 'empty' }] },
      { name: 'Verse', repeat: 2, cue: '主歌', bars: [{ type: 'empty' }] },
      { name: 'Chorus', repeat: 5, cue: '第二次的提示', bars: [{ type: 'empty' }] },
    ],
  });

  const sections = [
    { name: 'Chorus', line: 1, bars: [{ type: 'chords', line: 2, events: [{ kind: 'chord', chord: { root: 'C', quality: 'maj', bass: null }, beats: 4 }] }] },
    { name: 'Chorus', line: 4, bars: [{ type: 'empty', events: [], line: 5 }] },
    { name: '新段落', line: 7, bars: [{ type: 'empty', events: [], line: 8 }] },
  ];

  const next = applyParsedSections(base, sections);
  assert.equal(next.sections.length, 3);

  assert.equal(next.sections[0].id, base.sections[0].id, '第 1 个 Chorus 继承第 1 个');
  assert.equal(next.sections[0].repeat, 3);
  assert.equal(next.sections[0].cue, '第一次的提示');

  assert.equal(next.sections[1].id, base.sections[2].id, '第 2 个 Chorus 继承第 2 个');
  assert.equal(next.sections[1].repeat, 5);
  assert.equal(next.sections[1].cue, '第二次的提示');

  assert.equal(next.sections[2].repeat, 1, '新段落用默认值');
  assert.equal(next.sections[2].cue, '');
  assert.match(next.sections[2].id, /^sec_/);
  assert.notEqual(next.sections[2].id, base.sections[1].id);
});

test('小节与事件一律生成新 ID，不复用旧 ID（§7.2）', () => {
  const base = createSong({
    title: '换 ID',
    sections: [
      {
        name: 'A',
        bars: [{ type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }] }],
      },
    ],
  });
  const oldBarId = base.sections[0].bars[0].id;
  const oldEventId = base.sections[0].bars[0].events[0].id;

  const result = parseSongTextInto('[A]\nC:4', base);
  assert.equal(result.ok, true);
  const newBar = result.value.sections[0].bars[0];

  assert.notEqual(newBar.id, oldBarId, '小节按位置存在，插一节就会整体平移，不能继承 ID');
  assert.notEqual(newBar.events[0].id, oldEventId);
  assert.equal(result.value.sections[0].id, base.sections[0].id, '段落 ID 按名字继承，保持不变');
});

test('applyParsedSections 可以注入确定性 ID 工厂', () => {
  let counter = 0;
  const idFactory = (entity) => `${entity}_test${(counter += 1)}`;
  const sections = [
    {
      name: 'A',
      line: 1,
      bars: [
        {
          type: 'chords',
          line: 2,
          events: [
            { kind: 'chord', chord: { root: 'C', quality: 'maj', bass: null }, beats: 2 },
            { kind: 'rest', chord: null, beats: 2 },
          ],
        },
      ],
    },
  ];

  const next = applyParsedSections(baseSong(), sections, { idFactory });
  assert.equal(next.sections[0].bars[0].id, 'bar_test2');
  assert.equal(next.sections[0].bars[0].events[0].id, 'event_test3');
  assert.equal(next.sections[0].bars[0].events[1].id, 'event_test4');
});

/* ------------------------------------------------------------------ *
 * 反向序列化：歌曲 → 文本（§10 第 1 项）
 * ------------------------------------------------------------------ */

test('示例歌曲写成文本后能原样解析回来', () => {
  const written = songToText(SAMPLE_SONG);
  assert.equal(written.ok, true, `序列化应当成功：${written.issues?.map((i) => i.message).join('; ') ?? ''}`);

  const back = parseSongTextInto(written.value, SAMPLE_SONG);
  assert.equal(back.ok, true, `往返解析应当成功：\n${formatParseIssues(back.issues ?? [])}`);

  const original = SAMPLE_SONG.sections;
  const roundTripped = back.value.sections;
  assert.equal(roundTripped.length, original.length);

  original.forEach((section, sectionIndex) => {
    assert.equal(roundTripped[sectionIndex].name, section.name);
    assert.equal(roundTripped[sectionIndex].bars.length, section.bars.length, `[${section.name}] 的小节数`);
    section.bars.forEach((bar, barIndex) => {
      const other = roundTripped[sectionIndex].bars[barIndex];
      assert.equal(other.type, bar.type, `[${section.name}] 第 ${barIndex + 1} 小节类型`);
      assert.deepEqual(
        other.events.map((event) => [event.kind, event.beats, event.chord ?? null]),
        bar.events.map((event) => [event.kind, event.beats, event.chord ?? null]),
        `[${section.name}] 第 ${barIndex + 1} 小节的事件`,
      );
    });
  });
});

test('序列化时所有时值都显式写出，不依赖自动均分', () => {
  const song = createSong({
    title: '时值',
    sections: [
      {
        name: 'A',
        bars: [
          { type: 'chords', events: [{ kind: 'chord', beats: 2, chord: { root: 'C' } }, { kind: 'chord', beats: 2, chord: { root: 'G' } }] },
        ],
      },
    ],
  });
  const written = songToText(song);
  assert.equal(written.value.includes('C:2'), true);
  assert.equal(written.value.includes('G:2'), true);

  // 三轮往返都不应发生漂移。
  let current = song;
  for (let i = 0; i < 3; i += 1) {
    const text = songToText(current).value;
    current = parseSongTextInto(text, current).value;
  }
  assert.deepEqual(
    current.sections[0].bars[0].events.map((event) => event.beats),
    [2, 2],
  );
});

test('空白小节序列化成 0，不会变成休止', () => {
  const song = createEmptySong('空白');
  const written = songToText(song);
  assert.equal(written.ok, true);
  assert.equal(written.value.includes('0'), true);

  const back = parseSongTextInto(written.value, song);
  assert.equal(back.value.sections[0].bars.every((bar) => bar.type === 'empty'), true);
  assert.equal(back.value.sections[0].bars.every((bar) => bar.events.length === 0), true);
});

test('「chords 类型但零事件」的小节无法序列化，明确报错', () => {
  const song = createSong({
    title: '零事件',
    sections: [{ name: 'A', bars: [{ type: 'chords', events: [] }] }],
  });
  const written = songToText(song);
  assert.equal(written.ok, false);
  assert.equal(written.value, null);
  assert.equal(written.issues[0].code, 'E_BAR_HAS_NO_EVENT');
  assert.equal(written.issues[0].sectionName, 'A');
  assert.match(written.issues[0].message, /空白小节/);
});

test('序列化按 barsPerRow 每行排若干小节，并可用参数覆盖', () => {
  const song = createSong({
    title: '排版',
    sections: [
      {
        name: 'A',
        bars: Array.from({ length: 5 }, () => ({
          type: 'chords',
          events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }],
        })),
      },
    ],
  });

  const byTwo = songToText(song, { barsPerRow: 2 });
  const body = byTwo.value.split('\n').filter((line) => line.includes('C:4'));
  assert.equal(body.length, 3, '5 个小节按每行 2 个排成 3 行');
  assert.equal(body[0].split('|').length, 2);
  assert.equal(body[2].split('|').length, 1, '最后一行只有 1 个小节');
});

test('repeat 与 cue 表达不进文本，但以原歌为基底能保留（§4.7）', () => {
  const written = songToText(SAMPLE_SONG);
  assert.equal(written.value.includes('repeat'), false);
  assert.equal(written.value.includes(SAMPLE_SONG.sections[1].cue), false);

  const back = parseSongTextInto(written.value, SAMPLE_SONG);
  assert.equal(back.value.sections[1].repeat, SAMPLE_SONG.sections[1].repeat, '以原歌为基底，repeat 得以保留');
  assert.equal(back.value.sections[1].cue, SAMPLE_SONG.sections[1].cue);
});

test('文本导出不受显示行影响：三行并行导出的文本与只有和弦名时逐字相同（§6.4）', () => {
  // 显示行是渲染偏好，不是数据。如果有人把「显示级数」实现成改写和弦字段，
  // 或者让 songToText 跟着 displayLines 变化，这里会立刻红。
  const onlyChord = SAMPLE_SONG;
  const threeLines = {
    ...SAMPLE_SONG,
    layout: { ...SAMPLE_SONG.layout, displayLines: ['chord', 'degree', 'roman'] },
  };

  const a = songToText(onlyChord);
  const b = songToText(threeLines);

  assert.equal(a.ok && b.ok, true);
  assert.equal(b.value, a.value, '切换显示行不该让导出的文本变形');
  assert.equal(b.value.includes('V7') || b.value.includes('1maj7'), false, '文本里不该出现级数');
});


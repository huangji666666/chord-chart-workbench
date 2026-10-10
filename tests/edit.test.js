/**
 * 编辑操作模块（src/core/edit.js）的自动测试。
 *
 * 这个文件重点守住三件事，它们出问题都是「安静地坏掉」型的：
 *
 * 1. **纯函数性**：每个操作都不能动入参。撤销栈里存的是这些对象，
 *    只要有一个操作原地改，历史记录会跟着一起变形，而界面上看不出来。
 * 2. **结果合法**：每个成功的结果都要能通过 `validateSongShape()`。
 *    误用数组下标当 ID、复制时不换 ID，都会在这里被查出来。
 * 3. **拒绝要拒绝得准**：错误码必须指向真实原因，不能张冠李戴。
 *
 * @see docs/SPEC.md §7.1 §7.2
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSong, validateSongShape } from '../src/core/song.js';
import {
  EDIT_CODES,
  addEvent,
  addSection,
  duplicateBar,
  duplicateSection,
  duplicateSong,
  insertBar,
  moveBar,
  moveEvent,
  moveSection,
  removeBar,
  removeEvent,
  removeSection,
  renameSection,
  setBarEmpty,
  setEventBass,
  setEventBeats,
  setSectionCue,
  setSectionRepeat,
  setTimeSignature,
  updateEvent,
  updateSongMeta,
} from '../src/core/edit.js';

/* ------------------------------------------------------------------ *
 * 测试夹具与断言助手
 * ------------------------------------------------------------------ */

/**
 * 一份有内容的测试曲：Intro（一个含两事件的小节 + 一个空白小节）、
 * Verse（一个全休止小节）。
 */
function chartFixture() {
  return createSong({
    title: '测试曲',
    timeSignature: '4/4',
    key: { tonic: 'C', mode: 'major' },
    bpm: 96,
    sections: [
      {
        name: 'Intro',
        bars: [
          {
            type: 'chords',
            events: [
              { kind: 'chord', beats: 2, chord: { root: 'C' } },
              { kind: 'chord', beats: 2, chord: { root: 'G', quality: '7', bass: 'B' } },
            ],
          },
          { type: 'empty' },
        ],
      },
      {
        name: 'Verse',
        repeat: 2,
        cue: '轻扫',
        bars: [{ type: 'chords', events: [{ kind: 'rest', beats: 4 }] }],
      },
    ],
  });
}

function sectionNamed(song, name) {
  const found = song.sections.find((section) => section.name === name);
  assert.ok(found, `夹具里应当有段落 ${name}`);
  return found;
}

/** 成功结果必须能通过结构校验，否则测试立刻失败并打印全部问题。 */
function assertValidSong(song, hint = '') {
  const { ok, errors } = validateSongShape(song);
  assert.equal(
    ok,
    true,
    `${hint}结果应当通过结构校验，实际有 ${errors.length} 处问题：\n${JSON.stringify(errors, null, 2)}`,
  );
}

/** 取出一首歌里所有 ID（含歌本身的）。 */
function allIds(song) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      if (typeof node.id === 'string') out.push(node.id);
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'id') walk(value);
      }
    }
  };
  walk(song);
  return out;
}

/** 断言一次失败的编辑：错误码正确、value 为 null、message 非空。 */
function assertFails(result, code, hint = '') {
  assert.equal(result.ok, false, `${hint}应当失败`);
  assert.equal(result.value, null, `${hint}失败时 value 必须为 null`);
  assert.equal(result.code, code, `${hint}错误码应为 ${code}，实际 ${result.code}（${result.message}）`);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0, `${hint}失败信息不能为空`);
}

/* ------------------------------------------------------------------ *
 * 纯函数性：所有操作都不许动入参
 * ------------------------------------------------------------------ */

test('每一个编辑操作都不修改传入的歌曲对象', () => {
  const song = chartFixture();
  const before = JSON.stringify(song);
  const introId = sectionNamed(song, 'Intro').id;
  const verseId = sectionNamed(song, 'Verse').id;

  /** @type {Array<[string, () => unknown]>} */
  const operations = [
    ['updateSongMeta', () => updateSongMeta(song, { title: '新标题' })],
    ['setTimeSignature', () => setTimeSignature(song, '3/4')],
    ['addSection', () => addSection(song, { name: 'Bridge' })],
    ['renameSection', () => renameSection(song, introId, '前奏')],
    ['duplicateSection', () => duplicateSection(song, introId)],
    ['removeSection', () => removeSection(song, introId)],
    ['moveSection', () => moveSection(song, verseId, 'up')],
    ['setSectionRepeat', () => setSectionRepeat(song, verseId, 3)],
    ['setSectionCue', () => setSectionCue(song, verseId, '用力')],
    ['insertBar', () => insertBar(song, introId, 1)],
    ['duplicateBar', () => duplicateBar(song, introId, 0)],
    ['removeBar', () => removeBar(song, introId, 1)],
    ['moveBar', () => moveBar(song, introId, 0, 'down')],
    ['setBarEmpty(清空)', () => setBarEmpty(song, introId, 0, true, { discardEvents: true })],
    ['addEvent', () => addEvent(song, introId, 1, { kind: 'chord', beats: 4, chord: { root: 'D' } })],
    ['updateEvent', () => updateEvent(song, introId, 0, 0, { beats: 4 })],
    ['setEventBeats', () => setEventBeats(song, introId, 0, 0, 1)],
    ['setEventBass', () => setEventBass(song, introId, 0, 1, 'E')],
    ['removeEvent', () => removeEvent(song, introId, 0, 0)],
    ['moveEvent', () => moveEvent(song, introId, 0, 0, 'down')],
  ];

  for (const [name, run] of operations) {
    const result = run();
    assert.equal(JSON.stringify(song), before, `${name} 修改了入参`);
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.ok, 'boolean', `${name} 必须返回带 ok 字段的结果对象`);
  }
});

test('成功的操作返回新对象而不是同一个引用', () => {
  const song = chartFixture();
  const result = renameSection(song, sectionNamed(song, 'Intro').id, '前奏');
  assert.equal(result.ok, true);
  assert.notEqual(result.value, song, '必须返回新的歌曲对象');
  assert.equal(song.sections[0].name, 'Intro', '原对象的段落名不应被改动');
});

test('edit 模块导出的错误码两两不同，避免用错码还查不出来', () => {
  const codes = Object.values(EDIT_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^E_EDIT_/);
});

/* ------------------------------------------------------------------ *
 * 定位失败：错误码必须指向真实原因
 * ------------------------------------------------------------------ */

test('段落 ID 找不到时报「段落不存在」，而不是小节越界', () => {
  const song = chartFixture();
  assertFails(renameSection(song, 'sec_不存在', 'X'), EDIT_CODES.SECTION_NOT_FOUND);
  assertFails(duplicateSection(song, 'sec_不存在'), EDIT_CODES.SECTION_NOT_FOUND);
  assertFails(removeSection(song, 'sec_不存在'), EDIT_CODES.SECTION_NOT_FOUND);
  assertFails(addEvent(song, 'sec_不存在', 0, { beats: 4, chord: { root: 'C' } }), EDIT_CODES.SECTION_NOT_FOUND);
});

test('小节序号越界时报「小节越界」', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  // Intro 只有 2 个小节（序号 0、1）。
  assertFails(duplicateBar(song, introId, 2), EDIT_CODES.BAR_OUT_OF_RANGE);
  assertFails(removeBar(song, introId, 5), EDIT_CODES.BAR_OUT_OF_RANGE);
  assertFails(removeBar(song, introId, -1), EDIT_CODES.BAR_OUT_OF_RANGE);
  assertFails(addEvent(song, introId, 9, { beats: 4, chord: { root: 'C' } }), EDIT_CODES.BAR_OUT_OF_RANGE);
});

test('小节序号不是整数时也按越界处理，不静默取值', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  assertFails(duplicateBar(song, introId, 1.5), EDIT_CODES.BAR_OUT_OF_RANGE);
  assertFails(duplicateBar(song, introId, '0'), EDIT_CODES.BAR_OUT_OF_RANGE);
});

/* ------------------------------------------------------------------ *
 * 歌曲信息
 * ------------------------------------------------------------------ */

test('updateSongMeta 只改传入的字段', () => {
  const song = chartFixture();
  const result = updateSongMeta(song, { title: '新名字' });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, '新名字');
  assert.equal(result.value.artist, song.artist);
  assert.equal(result.value.bpm, song.bpm);
  assert.equal(result.value.sections.length, song.sections.length);
  assertValidSong(result.value);
});

test('updateSongMeta 拒绝空标题与越界 BPM', () => {
  const song = chartFixture();
  assertFails(updateSongMeta(song, { title: '   ' }), EDIT_CODES.TITLE_EMPTY);
  assertFails(updateSongMeta(song, { title: 42 }), EDIT_CODES.TITLE_EMPTY);
  assertFails(updateSongMeta(song, { bpm: 5 }), EDIT_CODES.BPM_INVALID);
  assertFails(updateSongMeta(song, { bpm: 401 }), EDIT_CODES.BPM_INVALID);
  assertFails(updateSongMeta(song, { bpm: 96.5 }), EDIT_CODES.BPM_INVALID);
});

test('updateSongMeta 拒绝超长文本字段', () => {
  const song = chartFixture();
  assertFails(updateSongMeta(song, { notes: 'x'.repeat(501) }), EDIT_CODES.TEXT_TOO_LONG);
  assertFails(updateSongMeta(song, { artist: 'x'.repeat(121) }), EDIT_CODES.TEXT_TOO_LONG);
});

test('updateSongMeta 校验调号：合法的规范化，小调明确拒绝', () => {
  const song = chartFixture();

  const ok = updateSongMeta(song, { key: { tonic: 'bb', mode: 'major' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.key.tonic, 'Bb', '音名应规范化为大写');
  assert.equal(ok.value.key.mode, 'major');

  assertFails(updateSongMeta(song, { key: { tonic: 'H' } }), EDIT_CODES.KEY_INVALID);
  // 小调必须拒绝，不能悄悄当关系大调算级数（§6.5）。
  assert.equal(updateSongMeta(song, { key: { tonic: 'A', mode: 'minor' } }).ok, true);
  assertFails(updateSongMeta(song, { key: { tonic: 'D', mode: 'dorian' } }), EDIT_CODES.MODE_UNSUPPORTED);
});

test('updateSongMeta 校验排版设置', () => {
  const song = chartFixture();

  const ok = updateSongMeta(song, { layout: { barsPerRow: 8, fontScale: 1.2 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.layout.barsPerRow, 8);
  assert.equal(ok.value.layout.fontScale, 1.2);
  assert.deepEqual(ok.value.layout.displayLines, song.layout.displayLines, '未传的字段应保持原样');

  assertFails(updateSongMeta(song, { layout: { barsPerRow: 3 } }), EDIT_CODES.LAYOUT_INVALID);
  assertFails(updateSongMeta(song, { layout: { fontScale: 2 } }), EDIT_CODES.LAYOUT_INVALID);
  // 显示行必须是 1–3 项、取值合法、不重复（SPEC §8.1.1）
  assertFails(updateSongMeta(song, { layout: { displayLines: 'both' } }), EDIT_CODES.DISPLAY_MODE_INVALID);
  assertFails(updateSongMeta(song, { layout: { displayLines: [] } }), EDIT_CODES.DISPLAY_MODE_INVALID);
  assertFails(updateSongMeta(song, { layout: { displayLines: ['chord', 'chord'] } }), EDIT_CODES.DISPLAY_MODE_INVALID);
  assertFails(updateSongMeta(song, { layout: { displayLines: ['both'] } }), EDIT_CODES.DISPLAY_MODE_INVALID);
  assertFails(
    updateSongMeta(song, { layout: { displayLines: ['chord', 'degree', 'roman', 'chord'] } }),
    EDIT_CODES.DISPLAY_MODE_INVALID,
  );
  // 合法：单独一行、两行并行、三行全开都行
  assertValidSong(updateSongMeta(song, { layout: { displayLines: ['degree'] } }).value);
  assertValidSong(updateSongMeta(song, { layout: { displayLines: ['roman'] } }).value);
  assertValidSong(updateSongMeta(song, { layout: { displayLines: ['chord', 'degree', 'roman'] } }).value);
  // 顺序由数据层规范化，不跟随调用方传进来的排列
  assert.deepEqual(
    updateSongMeta(song, { layout: { displayLines: ['roman', 'chord'] } }).value.layout.displayLines,
    ['chord', 'roman'],
  );
});

test('updateSongMeta：减三后缀只认 dim / °，且写入路径上**不做容错**（§6.7.1）', () => {
  const song = chartFixture();

  const asSymbol = updateSongMeta(song, { layout: { dimSuffix: '°' } });
  assert.equal(asSymbol.ok, true);
  assert.equal(asSymbol.value.layout.dimSuffix, '°');
  assertValidSong(asSymbol.value);

  const back = updateSongMeta(asSymbol.value, { layout: { dimSuffix: 'dim' } });
  assert.equal(back.ok, true);
  assert.equal(back.value.layout.dimSuffix, 'dim');

  // 非法值**必须报错**，不能像读取侧那样悄悄退化成 dim。
  // 在写入路径上容错，等于把用户拼错的值换成别的、然后告诉他保存成功。
  for (const bogus of ['o', 'DIM', '', '°°', 42, null, {}, ['°']]) {
    const result = updateSongMeta(song, { layout: { dimSuffix: bogus } });
    assert.equal(result.ok, false, `${JSON.stringify(bogus)} 应当被拒绝`);
    assert.equal(result.code, EDIT_CODES.LAYOUT_INVALID);
    assert.match(result.message, /减三/);
  }

  // 但 `undefined` 的意思是「这次不改这个字段」，不是「把它设成非法值」。
  assert.equal(updateSongMeta(song, { layout: { dimSuffix: undefined } }).ok, true);
});

test('updateSongMeta：改别的排版字段不会碰掉 dimSuffix', () => {
  const song = updateSongMeta(chartFixture(), { layout: { dimSuffix: '°' } }).value;
  const after = updateSongMeta(song, { layout: { barsPerRow: 8 } });

  assert.equal(after.ok, true);
  assert.equal(after.value.layout.dimSuffix, '°', '未传的字段必须原样保留');
});

test('updateSongMeta：改减三后缀是纯函数，不改动传入的歌', () => {
  const song = chartFixture();
  const snapshot = JSON.stringify(song);

  updateSongMeta(song, { layout: { dimSuffix: '°' } });

  assert.equal(JSON.stringify(song), snapshot);
});

/* ------------------------------------------------------------------ *
 * 拍号：只改拍号，不重算时值
 * ------------------------------------------------------------------ */

test('setTimeSignature 拒绝不支持的拍号', () => {
  const song = chartFixture();
  assertFails(setTimeSignature(song, '2/4'), EDIT_CODES.TIME_SIGNATURE_UNSUPPORTED);
  assertFails(setTimeSignature(song, '4/4 '), EDIT_CODES.TIME_SIGNATURE_UNSUPPORTED);
});

test('setTimeSignature 只改拍号，绝不改写已有时值', () => {
  const song = chartFixture();
  const beatsBefore = song.sections
    .flatMap((section) => section.bars)
    .flatMap((bar) => bar.events)
    .map((event) => event.beats);

  const result = setTimeSignature(song, '3/4');
  assert.equal(result.ok, true);
  assert.equal(result.value.timeSignature, '3/4');

  const beatsAfter = result.value.sections
    .flatMap((section) => section.bars)
    .flatMap((bar) => bar.events)
    .map((event) => event.beats);
  assert.deepEqual(beatsAfter, beatsBefore, '时值必须原样保留，欠拍问题交给用户决定（§3.5）');
});

/* ------------------------------------------------------------------ *
 * 段落
 * ------------------------------------------------------------------ */

test('addSection 默认带一个空白小节，并可用 atIndex 指定插入位置', () => {
  const song = chartFixture();
  const result = addSection(song, { name: 'Bridge', atIndex: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.value.sections.length, 3);
  assert.equal(result.value.sections[1].name, 'Bridge');

  const created = result.value.sections[1];
  assert.equal(created.bars.length, 1, '新段落应有一个小节供用户立刻写和弦');
  assert.equal(created.bars[0].type, 'empty', '默认是空白小节，不是休止（§2.4）');
  assert.match(created.id, /^sec_/);
  assert.match(created.bars[0].id, /^bar_/);
  assertValidSong(result.value);
});

test('addSection 拒绝空名与越界插入位置', () => {
  const song = chartFixture();
  assertFails(addSection(song, { name: '   ' }), EDIT_CODES.SECTION_NAME_TOO_LONG);
  assertFails(addSection(song, { name: 'X'.repeat(41) }), EDIT_CODES.SECTION_NAME_TOO_LONG);
  assertFails(addSection(song, { name: 'X', atIndex: 99 }), EDIT_CODES.SECTION_INDEX_INVALID);
});

test('renameSection 允许与其它段落同名（同名段落合法）', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const result = renameSection(song, introId, 'Verse');
  assert.equal(result.ok, true);
  assert.equal(result.value.sections.filter((s) => s.name === 'Verse').length, 2);
});

test('renameSection 拒绝空名并去掉首尾空白', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  assertFails(renameSection(song, introId, '   '), EDIT_CODES.SECTION_NAME_EMPTY);
  assertFails(renameSection(song, introId, 'x'.repeat(41)), EDIT_CODES.SECTION_NAME_TOO_LONG);

  const trimmed = renameSection(song, introId, '  前奏  ');
  assert.equal(trimmed.value.sections[0].name, '前奏');
});

test('duplicateSection 换掉段落、小节和事件的 ID，并插在原段落之后', () => {
  const song = chartFixture();
  const intro = sectionNamed(song, 'Intro');
  const result = duplicateSection(song, intro.id);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections.length, 3);
  assert.equal(result.value.sections[1].name, 'Intro', '副本应紧跟在原段落之后');

  const copy = result.value.sections[1];
  assert.notEqual(copy.id, intro.id, '段落 ID 必须换新');
  assert.equal(copy.bars.length, intro.bars.length);

  const originalIds = new Set(allIds(song));
  for (const id of allIds(copy)) {
    assert.equal(originalIds.has(id), false, `副本里不应复用原 ID：${id}`);
  }
  assert.equal(result.value.sections[0].id, intro.id, '原段落 ID 不应被改动');
  assertValidSong(result.value);
  assert.equal(new Set(allIds(result.value)).size, allIds(result.value).length, '整首歌内 ID 必须唯一');
});

test('removeSection 至少保留一个段落', () => {
  const song = chartFixture();
  const oneSection = removeSection(song, sectionNamed(song, 'Intro').id);
  assert.equal(oneSection.ok, true);
  assert.equal(oneSection.value.sections.length, 1);

  assertFails(removeSection(oneSection.value, oneSection.value.sections[0].id), EDIT_CODES.LAST_SECTION);
});

test('moveSection 上下移动，边界处明确拒绝', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const verseId = sectionNamed(song, 'Verse').id;

  const down = moveSection(song, introId, 'down');
  assert.equal(down.ok, true);
  assert.equal(down.value.sections[0].name, 'Verse');
  assert.equal(down.value.sections[1].name, 'Intro');
  assertValidSong(down.value);

  assertFails(moveSection(song, introId, 'up'), EDIT_CODES.MOVE_EDGE, '第一个段落不能上移：');
  assertFails(moveSection(song, verseId, 'down'), EDIT_CODES.MOVE_EDGE, '最后一个段落不能下移：');
  assertFails(moveSection(song, introId, 'left'), EDIT_CODES.MOVE_EDGE, '未知方向：');
});

test('setSectionRepeat 只做演奏标注，范围 1–99', () => {
  const song = chartFixture();
  const verseId = sectionNamed(song, 'Verse').id;

  const result = setSectionRepeat(song, verseId, 4);
  assert.equal(result.ok, true);
  assert.equal(sectionNamed(result.value, 'Verse').repeat, 4);
  assert.equal(
    result.value.sections.reduce((sum, section) => sum + section.bars.length, 0),
    3,
    'repeat 是标注，不得复制实际小节（§2.3 第 6 条）',
  );

  assertFails(setSectionRepeat(song, verseId, 0), EDIT_CODES.SECTION_REPEAT_INVALID);
  assertFails(setSectionRepeat(song, verseId, 100), EDIT_CODES.SECTION_REPEAT_INVALID);
  assertFails(setSectionRepeat(song, verseId, 2.5), EDIT_CODES.SECTION_REPEAT_INVALID);
});

test('setSectionCue 写演奏提示并限制长度', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const result = setSectionCue(song, introId, '清音扫弦，弱起');
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].cue, '清音扫弦，弱起');

  assertFails(setSectionCue(song, introId, 'x'.repeat(201)), EDIT_CODES.SECTION_CUE_TOO_LONG);
});

/* ------------------------------------------------------------------ *
 * 小节
 * ------------------------------------------------------------------ */

test('insertBar 默认插入空白小节，传现成小节时会换新 ID', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const appended = insertBar(song, introId, 2);
  assert.equal(appended.ok, true);
  assert.equal(appended.value.sections[0].bars.length, 3);
  assert.equal(appended.value.sections[0].bars[2].type, 'empty');
  assertValidSong(appended.value);

  const source = sectionNamed(song, 'Intro').bars[0];
  const inserted = insertBar(song, introId, 0, source);
  assert.equal(inserted.ok, true);
  const newBar = inserted.value.sections[0].bars[0];
  assert.notEqual(newBar.id, source.id, '插入现成小节也必须换新 ID');
  assert.equal(newBar.events.length, source.events.length);
  for (const event of newBar.events) {
    assert.equal(
      source.events.some((original) => original.id === event.id),
      false,
      '插入的小节里事件 ID 也要换新',
    );
  }
  assertValidSong(inserted.value);
});

test('insertBar 拒绝越界插入位置', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  assertFails(insertBar(song, introId, 3), EDIT_CODES.BAR_OUT_OF_RANGE);
  assertFails(insertBar(song, introId, -1), EDIT_CODES.BAR_OUT_OF_RANGE);
});

test('duplicateBar 复制到下一格并全换 ID', () => {
  const song = chartFixture();
  const intro = sectionNamed(song, 'Intro');
  const result = duplicateBar(song, intro.id, 0);
  assert.equal(result.ok, true);

  const bars = result.value.sections[0].bars;
  assert.equal(bars.length, 3);
  assert.notEqual(bars[1].id, intro.bars[0].id, '副本小节必须换 ID');
  assert.equal(bars[1].events.length, intro.bars[0].events.length);

  const originalIds = new Set(allIds(song));
  for (const id of allIds(bars[1])) {
    assert.equal(originalIds.has(id), false, `副本事件不应复用原 ID：${id}`);
  }
  assertValidSong(result.value);
});

test('removeBar 至少保留一个小节', () => {
  const song = chartFixture();
  const verseId = sectionNamed(song, 'Verse').id;
  assertFails(removeBar(song, verseId, 0), EDIT_CODES.LAST_BAR);

  const introId = sectionNamed(song, 'Intro').id;
  const result = removeBar(song, introId, 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars.length, 1);
  assertValidSong(result.value);
});

test('moveBar 交换相邻小节，边界处拒绝', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const moved = moveBar(song, introId, 0, 'down');
  assert.equal(moved.ok, true);
  assert.equal(moved.value.sections[0].bars[0].type, 'empty', '原第 2 个空白小节应移到前面');
  assert.equal(moved.value.sections[0].bars[1].events.length, 2);

  assertFails(moveBar(song, introId, 0, 'up'), EDIT_CODES.MOVE_EDGE);
  assertFails(moveBar(song, introId, 1, 'down'), EDIT_CODES.MOVE_EDGE);
});

/* ------------------------------------------------------------------ *
 * 空白小节 ↔ 休止：两种含义必须分得清
 * ------------------------------------------------------------------ */

test('把有内容的小节设为空白，必须显式确认，否则拒绝', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  assertFails(setBarEmpty(song, introId, 0, true), EDIT_CODES.BAR_NOT_EMPTY, '未确认就清空：');

  const confirmed = setBarEmpty(song, introId, 0, true, { discardEvents: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.value.sections[0].bars[0].type, 'empty');
  assert.equal(confirmed.value.sections[0].bars[0].events.length, 0);
  assertValidSong(confirmed.value);
});

test('把已是空白的小节再设为空白是幂等的', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const result = setBarEmpty(song, introId, 1, true);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[1].type, 'empty');
  assert.equal(result.value.sections[0].bars[1].events.length, 0);
});

test('取消空白时填入占满整小节的休止，结果立刻合法', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const result = setBarEmpty(song, introId, 1, false);
  assert.equal(result.ok, true);

  const bar = result.value.sections[0].bars[1];
  assert.equal(bar.type, 'chords');
  assert.equal(bar.events.length, 1, '「chords 类型但零事件」是非法的，所以要放一个休止占位');
  assert.equal(bar.events[0].kind, 'rest');
  assert.equal(bar.events[0].beats, 4, '4/4 下应占满 4 拍');
  assert.match(bar.events[0].id, /^evt_/);
  assertValidSong(result.value);
});

test('取消空白时用的拍数跟随拍号', () => {
  const song = setTimeSignature(chartFixture(), '6/8').value;
  const introId = sectionNamed(song, 'Intro').id;
  const result = setBarEmpty(song, introId, 1, false);
  assert.equal(result.value.sections[0].bars[1].events[0].beats, 6, '6/8 每小节 6 拍');
});

test('已是普通小节时取消空白是幂等的', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const result = setBarEmpty(song, introId, 0, false);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].events.length, 2, '不应破坏已有事件');
});

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

test('addEvent 往空白小节里加事件会自动把它变成普通小节', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const result = addEvent(song, introId, 1, { kind: 'chord', beats: 4, chord: { root: 'A', quality: 'm7' } });
  assert.equal(result.ok, true);

  const bar = result.value.sections[0].bars[1];
  assert.equal(bar.type, 'chords', '有事件的小节必须是 chords 类型');
  assert.equal(bar.events.length, 1);
  // 数据里根音和后缀是分开的两个字段，`Am` 这种「合在一起的写法」只属于文本语法层。
  assert.equal(bar.events[0].chord.root, 'A');
  assert.equal(bar.events[0].chord.quality, 'm7');
  assert.match(bar.events[0].id, /^evt_/);
  assertValidSong(result.value);
});

test('addEvent 追加到普通小节末尾', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const result = addEvent(song, introId, 0, { kind: 'rest', beats: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].events.length, 3);
  assert.equal(result.value.sections[0].bars[0].events[2].kind, 'rest');
});

test('addEvent 拒绝非法和弦、非法时值和未知事件类型', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const barIndex = 1;

  assertFails(addEvent(song, introId, barIndex, { beats: 4, chord: { root: 'X' } }), EDIT_CODES.CHORD_INVALID);
  // `root` 字段只接受音名；`Am` 这种「音名 + 后缀」的合并写法属于文本语法层（§4.2），
  // 塞进结构化的 root 字段必须被拒绝，不能靠猜把它拆开。
  assertFails(addEvent(song, introId, barIndex, { beats: 4, chord: { root: 'Am', quality: 'm7' } }), EDIT_CODES.CHORD_INVALID);
  // m7b5 属于「已知但不支持」的写法，必须报错而不是假装解析成功（§5.4）。
  assertFails(addEvent(song, introId, barIndex, { beats: 4, chord: { root: 'C', quality: 'invalid-quality' } }), EDIT_CODES.CHORD_INVALID);
  assertFails(addEvent(song, introId, barIndex, { beats: 0, chord: { root: 'C' } }), EDIT_CODES.BEATS_INVALID);
  assertFails(addEvent(song, introId, barIndex, { beats: -1, chord: { root: 'C' } }), EDIT_CODES.BEATS_INVALID);
  assertFails(addEvent(song, introId, barIndex, { beats: 65, chord: { root: 'C' } }), EDIT_CODES.BEATS_INVALID);
  assertFails(addEvent(song, introId, barIndex, { kind: 'note', beats: 4, chord: { root: 'C' } }), EDIT_CODES.EVENT_KIND_UNKNOWN);
});

test('updateEvent 改和弦保留事件 ID（撤销重做依赖 ID 稳定）', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const eventId = song.sections[0].bars[0].events[0].id;

  const result = updateEvent(song, introId, 0, 0, { chord: { root: 'F', quality: 'maj7' } });
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].events[0].id, eventId, 'ID 必须保持不变');
  assert.equal(result.value.sections[0].bars[0].events[0].chord.quality, 'maj7');
  assertValidSong(result.value);
});

test('updateEvent 只改时值，不影响同小节其它事件', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const otherId = song.sections[0].bars[0].events[1].id;
  const otherBeats = song.sections[0].bars[0].events[1].beats;

  const result = setEventBeats(song, introId, 0, 0, 3);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].events[0].beats, 3);
  assert.equal(result.value.sections[0].bars[0].events[1].id, otherId);
  assert.equal(result.value.sections[0].bars[0].events[1].beats, otherBeats);
});

test('updateEvent 在空白小节和越界序号上拒绝', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  assertFails(updateEvent(song, introId, 1, 0, { beats: 2 }), EDIT_CODES.EVENT_OUT_OF_RANGE, '空白小节：');
  assertFails(updateEvent(song, introId, 0, 5, { beats: 2 }), EDIT_CODES.EVENT_OUT_OF_RANGE, '事件序号越界：');
});

test('setEventBass 设置与清除斜杠低音', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;

  const set = setEventBass(song, introId, 0, 0, 'E');
  assert.equal(set.ok, true);
  assert.equal(set.value.sections[0].bars[0].events[0].chord.bass, 'E');
  assertValidSong(set.value);

  const cleared = setEventBass(set.value, introId, 0, 0, null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.sections[0].bars[0].events[0].chord.bass, null, '传 null 表示去掉斜杠低音');

  const blank = setEventBass(song, introId, 0, 1, '   ');
  assert.equal(blank.value.sections[0].bars[0].events[1].chord.bass, null, '全空白字符视为清除');
});

test('setEventBass 拒绝休止事件和越界序号', () => {
  const song = chartFixture();
  const verseId = sectionNamed(song, 'Verse').id;
  assertFails(setEventBass(song, verseId, 0, 0, 'E'), EDIT_CODES.EVENT_OUT_OF_RANGE, '休止事件没有低音：');

  const introId = sectionNamed(song, 'Intro').id;
  assertFails(setEventBass(song, introId, 0, 9, 'E'), EDIT_CODES.EVENT_OUT_OF_RANGE);
});

test('removeEvent 拒绝删掉小节里唯一的事件', () => {
  const song = chartFixture();
  const verseId = sectionNamed(song, 'Verse').id;
  assertFails(removeEvent(song, verseId, 0, 0), EDIT_CODES.LAST_EVENT);

  const introId = sectionNamed(song, 'Intro').id;
  const result = removeEvent(song, introId, 0, 0);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].events.length, 1);
  assert.equal(result.value.sections[0].bars[0].events[0].kind, 'chord', '留下的应是原来的第二个事件');
  assertValidSong(result.value);
});

test('moveEvent 交换小节内相邻事件', () => {
  const song = chartFixture();
  const introId = sectionNamed(song, 'Intro').id;
  const [first, second] = song.sections[0].bars[0].events;

  const moved = moveEvent(song, introId, 0, 0, 'down');
  assert.equal(moved.ok, true);
  assert.equal(moved.value.sections[0].bars[0].events[0].id, second.id);
  assert.equal(moved.value.sections[0].bars[0].events[1].id, first.id);
  assertValidSong(moved.value);

  assertFails(moveEvent(song, introId, 0, 0, 'up'), EDIT_CODES.MOVE_EDGE);
  assertFails(moveEvent(song, introId, 0, 1, 'down'), EDIT_CODES.MOVE_EDGE);
});

/* ------------------------------------------------------------------ *
 * 整首歌
 * ------------------------------------------------------------------ */

test('duplicateSong 生成全新 ID 并加「（副本）」后缀', () => {
  const song = chartFixture();
  const copy = duplicateSong(song);

  assert.notEqual(copy.id, song.id);
  assert.equal(copy.title, '测试曲（副本）');
  assert.equal(copy.sections.length, song.sections.length);
  assertValidSong(copy);

  const originalIds = new Set(allIds(song));
  const copyIds = allIds(copy);
  for (const id of copyIds) {
    assert.equal(originalIds.has(id), false, `副本不应残留原 ID：${id}`);
  }
  assert.equal(new Set(copyIds).size, copyIds.length, '副本内部 ID 必须唯一');
  assert.deepEqual(copy.key, song.key);
  assert.deepEqual(copy.layout, song.layout);
});

test('duplicateSong 得到的副本与原曲互不影响（不共享可变对象）', () => {
  const song = chartFixture();
  const copy = duplicateSong(song);
  copy.sections[0].bars[0].events.push({ kind: 'rest', id: 'evt_probe0000', beats: 1 });
  copy.layout.barsPerRow = 8;

  assert.equal(song.sections[0].bars[0].events.length, 2, '改副本不应影响原曲');
  assert.notEqual(song.layout, copy.layout, 'layout 不应是同一个对象');
});

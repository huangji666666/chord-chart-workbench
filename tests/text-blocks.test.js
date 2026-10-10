/**
 * 自由文字块（SPEC §8.10）的自动测试。
 *
 * 文字块挂在 `bar.textBlocks` 上，用 **0–1 比例坐标**定位、`anchor` 绑定和弦下标。
 * 这是**可缺省字段**——缺失等于「没有文字块」（旧行为），守住三条：
 *
 * 1. **缺省不破坏老数据**：没有 `textBlocks` 字段的小节照常通过校验。
 * 2. **纯函数 + 深拷贝**：编辑、克隆、复制都不共享可变对象，也不动入参。
 * 3. **可判定 + 跟随**：空块不落盘；删除/移动和弦时绑定到它的块要跟随调整（§8.10）。
 *
 * @see docs/SPEC.md §8.10
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cloneSong, createSong, deserializeSongText, validateSongShape } from '../src/core/song.js';
import {
  addTextBlock,
  setTextBlockText,
  moveTextBlock,
  removeTextBlock,
  cloneBarWithNewIds,
  duplicateBar,
  duplicateSong,
  removeEvent,
  moveEvent,
  setBarEmpty,
  updateSongMeta,
} from '../src/core/edit.js';

/** 一份含两个和弦事件的小节。 */
function twoChordBar() {
  return {
    type: 'chords',
    events: [
      { kind: 'chord', beats: 2, chord: { root: 'C' } },
      { kind: 'chord', beats: 2, chord: { root: 'G', quality: '7', bass: 'B' } },
    ],
  };
}

function songWithBar() {
  return createSong({
    title: '文字块测试',
    timeSignature: '4/4',
    key: { tonic: 'C', mode: 'major' },
    sections: [{ name: 'Verse', bars: [twoChordBar()] }],
  });
}

/* ------------------------------------------------------------------ *
 * 数据模型：可缺省、校验
 * ------------------------------------------------------------------ */

test('没有 textBlocks 字段的老数据照常通过校验（缺省 = 旧行为）', () => {
  const song = songWithBar();
  assert.equal(song.sections[0].bars[0].textBlocks, undefined);
  const { ok } = validateSongShape(song);
  assert.equal(ok, true);
});

test('合法的 textBlocks 通过校验，字段齐全', () => {
  const song = createSong({
    sections: [
      {
        name: 'V',
        bars: [
          {
            type: 'chords',
            events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }],
            textBlocks: [{ text: '副歌', x: 0.5, y: 0.8, anchor: 0 }],
          },
        ],
      },
    ],
  });
  const { ok, errors } = validateSongShape(song);
  assert.equal(ok, true, JSON.stringify(errors));
  const block = song.sections[0].bars[0].textBlocks[0];
  assert.equal(block.text, '副歌');
  assert.equal(block.x, 0.5);
  assert.equal(block.y, 0.8);
  assert.equal(block.anchor, 0);
  assert.ok(block.id.startsWith('txt_'), 'ID 应以 txt_ 开头');
});

test('空白小节也能有文字块（§8.10：间奏等标注）', () => {
  const song = createSong({
    sections: [
      { name: 'V', bars: [{ type: 'empty', textBlocks: [{ text: '间奏', x: 0.5, y: 0.5, anchor: -1 }] }] },
    ],
  });
  const { ok } = validateSongShape(song);
  assert.equal(ok, true);
  assert.equal(song.sections[0].bars[0].textBlocks[0].text, '间奏');
});

test('非法 textBlocks（非数组、项非对象、坐标越界）被校验拒绝', () => {
  const badCases = [
    { textBlocks: '不是数组' },
    { textBlocks: ['字符串项'] },
    { textBlocks: [{ text: 'x', x: 1.5, y: 0.5, anchor: -1 }] }, // x 越界
    { textBlocks: [{ text: 'y', x: 0.5, y: -0.1, anchor: -1 }] }, // y 越界
    { textBlocks: [{ text: 'a', x: 0.5, y: 0.5, anchor: -2 }] }, // anchor 非法
  ];
  for (const patch of badCases) {
    const song = createSong({
      sections: [{ name: 'V', bars: [{ type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }], ...patch }] }],
    });
    const raw = { ...song, sections: [{ ...song.sections[0], bars: [{ ...song.sections[0].bars[0], ...patch }] }] };
    const { ok } = validateSongShape(raw);
    assert.equal(ok, false, `应当拒绝 ${JSON.stringify(patch)}`);
  }
});

/* ------------------------------------------------------------------ *
 * 编辑：addTextBlock / setTextBlockText / moveTextBlock / removeTextBlock
 * ------------------------------------------------------------------ */

test('addTextBlock 新增块，空串被拒绝', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;

  const empty = addTextBlock(song, sectionId, 0, { text: '  ', x: 0.5, y: 0.5 });
  assert.equal(empty.ok, false, '空文字块应被拒绝');

  const ok = addTextBlock(song, sectionId, 0, { text: '副歌第一遍', x: 0.5, y: 0.5, anchor: 0 });
  assert.equal(ok.ok, true);
  const blocks = ok.value.sections[0].bars[0].textBlocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, '副歌第一遍');
  assert.equal(blocks[0].anchor, 0);
  // 纯函数：原对象不动
  assert.equal(song.sections[0].bars[0].textBlocks, undefined);
});

test('addTextBlock 拒绝越界坐标和越界锚点', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;

  assert.equal(addTextBlock(song, sectionId, 0, { text: 'a', x: 1.5, y: 0.5 }).ok, false);
  assert.equal(addTextBlock(song, sectionId, 0, { text: 'a', x: 0.5, y: -0.1 }).ok, false);
  assert.equal(addTextBlock(song, sectionId, 0, { text: 'a', x: 0.5, y: 0.5, anchor: 99 }).ok, false, '锚点不能超过事件数');
});

test('setTextBlockText 改文字，空串删除该块，全空移除字段', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const added = addTextBlock(song, sectionId, 0, { text: '旧词', x: 0.5, y: 0.5, anchor: -1 });
  const blockId = added.value.sections[0].bars[0].textBlocks[0].id;

  const edited = setTextBlockText(added.value, sectionId, 0, blockId, '新词');
  assert.equal(edited.ok, true);
  assert.equal(edited.value.sections[0].bars[0].textBlocks[0].text, '新词');

  const cleared = setTextBlockText(edited.value, sectionId, 0, blockId, '  ');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.sections[0].bars[0].textBlocks, undefined, '全空后字段应整个移除');
});

test('moveTextBlock 改位置，越界坐标被拒绝', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const added = addTextBlock(song, sectionId, 0, { text: '词', x: 0.5, y: 0.5, anchor: -1 });
  const blockId = added.value.sections[0].bars[0].textBlocks[0].id;

  const moved = moveTextBlock(added.value, sectionId, 0, blockId, { x: 0.9, y: 0.1 });
  assert.equal(moved.ok, true);
  assert.equal(moved.value.sections[0].bars[0].textBlocks[0].x, 0.9);
  assert.equal(moved.value.sections[0].bars[0].textBlocks[0].y, 0.1);

  assert.equal(moveTextBlock(added.value, sectionId, 0, blockId, { x: 2, y: 0.5 }).ok, false);
});

test('removeTextBlock 删除块，最后一个删除后字段移除', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const added = addTextBlock(song, sectionId, 0, { text: '词', x: 0.5, y: 0.5, anchor: -1 });
  const blockId = added.value.sections[0].bars[0].textBlocks[0].id;

  const removed = removeTextBlock(added.value, sectionId, 0, blockId);
  assert.equal(removed.ok, true);
  assert.equal(removed.value.sections[0].bars[0].textBlocks, undefined);
});

/* ------------------------------------------------------------------ *
 * 跟随调整：删除 / 移动和弦时 anchor 跟着走（§8.10）
 * ------------------------------------------------------------------ */

test('removeEvent 删和弦后：绑定的块降级 -1，后面的块 anchor 前移', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  // 两个和弦，块分别绑定 0 和 1。
  let s = addTextBlock(song, sectionId, 0, { text: '绑0', x: 0.3, y: 0.5, anchor: 0 }).value;
  s = addTextBlock(s, sectionId, 0, { text: '绑1', x: 0.7, y: 0.5, anchor: 1 }).value;

  const removed = removeEvent(s, sectionId, 0, 0);
  assert.equal(removed.ok, true);
  const blocks = removed.value.sections[0].bars[0].textBlocks;
  const b0 = blocks.find((b) => b.text === '绑0');
  const b1 = blocks.find((b) => b.text === '绑1');
  assert.equal(b0.anchor, -1, '绑定到被删和弦的块应降级为小节级');
  assert.equal(b1.anchor, 0, '绑定到后面和弦的块应前移一位');
});

test('moveEvent 交换和弦时：绑定的块 anchor 跟着换', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  let s = addTextBlock(song, sectionId, 0, { text: '绑0', x: 0.3, y: 0.5, anchor: 0 }).value;
  s = addTextBlock(s, sectionId, 0, { text: '绑1', x: 0.7, y: 0.5, anchor: 1 }).value;

  // 交换第 0 和第 1 个和弦（down 方向）。
  const moved = moveEvent(s, sectionId, 0, 0, 'down');
  assert.equal(moved.ok, true);
  const blocks = moved.value.sections[0].bars[0].textBlocks;
  assert.equal(blocks.find((b) => b.text === '绑0').anchor, 1, '绑定到原第0个和弦的块应跟着到第1');
  assert.equal(blocks.find((b) => b.text === '绑1').anchor, 0, '绑定到原第1个和弦的块应跟着到第0');
});

test('setBarEmpty 设为空白：文字块保留、anchor 全部降级 -1', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  let s = addTextBlock(song, sectionId, 0, { text: '间奏', x: 0.5, y: 0.5, anchor: 0 }).value;

  const emptied = setBarEmpty(s, sectionId, 0, true, { discardEvents: true });
  assert.equal(emptied.ok, true);
  const bar = emptied.value.sections[0].bars[0];
  assert.equal(bar.type, 'empty');
  assert.equal(bar.textBlocks[0].text, '间奏', '文字块应保留');
  assert.equal(bar.textBlocks[0].anchor, -1, '和弦没了，anchor 降级为小节级');
});

/* ------------------------------------------------------------------ *
 * 克隆与复制：文字块跟着走，换新 ID
 * ------------------------------------------------------------------ */

test('cloneBarWithNewIds / duplicateBar 复制小节带文字块且换新 ID', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  let s = addTextBlock(song, sectionId, 0, { text: '词', x: 0.5, y: 0.5, anchor: 0 }).value;

  const dup = duplicateBar(s, sectionId, 0);
  assert.equal(dup.ok, true);
  const [orig, copy] = dup.value.sections[0].bars;
  assert.equal(copy.textBlocks[0].text, '词');
  assert.equal(copy.textBlocks[0].x, 0.5);
  assert.notEqual(copy.textBlocks[0].id, orig.textBlocks[0].id, '复制后文字块要换新 ID');
});

test('cloneSong 深拷贝文字块，不共享可变对象', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const s = addTextBlock(song, sectionId, 0, { text: '词', x: 0.5, y: 0.5, anchor: -1 }).value;

  const copy = cloneSong(s);
  copy.sections[0].bars[0].textBlocks[0].text = '改过';
  assert.equal(s.sections[0].bars[0].textBlocks[0].text, '词', '原对象不应被改动');
});

test('duplicateSong 复制整首歌时文字块跟随', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const s = addTextBlock(song, sectionId, 0, { text: '词', x: 0.5, y: 0.5, anchor: -1 }).value;

  const copy = duplicateSong(s);
  assert.equal(copy.sections[0].bars[0].textBlocks[0].text, '词');
});

/* ------------------------------------------------------------------ *
 * 序列化：JSON 往返不丢文字块
 * ------------------------------------------------------------------ */

test('序列化再反序列化，文字块信息保持', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const s = addTextBlock(song, sectionId, 0, { text: '副歌第一遍\n转调前', x: 0.5, y: 0.8, anchor: 0 }).value;

  const text = JSON.stringify(s);
  const back = deserializeSongText(text);
  assert.equal(back.ok, true);
  const block = back.value.sections[0].bars[0].textBlocks[0];
  assert.equal(block.text, '副歌第一遍\n转调前');
  assert.equal(block.x, 0.5);
  assert.equal(block.y, 0.8);
  assert.equal(block.anchor, 0);
});

/* ------------------------------------------------------------------ *
 * 粒度开关：layout.textBlockMode（§8.10）
 * ------------------------------------------------------------------ */

test('textBlockMode 是可缺省字段，缺省等于 bar，老数据通过校验', () => {
  const song = songWithBar();
  assert.equal(song.layout.textBlockMode, 'bar', '新歌默认写全 textBlockMode = bar');
  const { ok } = validateSongShape(song);
  assert.equal(ok, true);
});

test('updateSongMeta 改 textBlockMode，非法值被拒绝', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;

  const chord = updateSongMeta(song, { layout: { textBlockMode: 'chord' } });
  assert.equal(chord.ok, true);
  assert.equal(chord.value.layout.textBlockMode, 'chord');

  assert.equal(updateSongMeta(song, { layout: { textBlockMode: 'bogus' } }).ok, false);
});

test('序列化往返保留 textBlockMode', () => {
  const song = songWithBar();
  const s = updateSongMeta(song, { layout: { textBlockMode: 'chord' } }).value;
  const back = deserializeSongText(JSON.stringify(s));
  assert.equal(back.ok, true);
  assert.equal(back.value.layout.textBlockMode, 'chord');
});

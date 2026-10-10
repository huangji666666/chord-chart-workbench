/**
 * 歌词（逐字对齐，SPEC §8.9）的自动测试。
 *
 * 歌词挂在 `bar.lyrics` 上，用**事件下标**对齐：`bar.lyrics[i]` 对应 `bar.events[i]`。
 * 这是**可缺省字段**——缺失等于「没有歌词」（旧行为），所以必须守住三条：
 *
 * 1. **缺省不破坏老数据**：没有 `lyrics` 字段的小节照常通过校验，绝不能被判损坏。
 * 2. **纯函数 + 深拷贝**：编辑、克隆、复制都不共享可变对象，也不动入参。
 * 3. **可判定**：整段清空后字段应整个移除，而不是留一个全空数组，让「有没有歌词」始终可判定。
 *
 * @see docs/SPEC.md §8.9
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cloneSong, createSong, deserializeSongText, validateSongShape } from '../src/core/song.js';
import { setEventLyric, cloneBarWithNewIds, duplicateBar, duplicateSong } from '../src/core/edit.js';

/** 一份含两个和弦事件的小节，便于对齐歌词。 */
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
    title: '歌词测试',
    timeSignature: '4/4',
    key: { tonic: 'C', mode: 'major' },
    sections: [{ name: 'Verse', bars: [twoChordBar()] }],
  });
}

/* ------------------------------------------------------------------ *
 * 数据模型：可缺省、对齐、校验
 * ------------------------------------------------------------------ */

test('没有 lyrics 字段的老数据照常通过校验（缺省 = 旧行为）', () => {
  const song = songWithBar();
  assert.equal(song.sections[0].bars[0].lyrics, undefined);
  const { ok } = validateSongShape(song);
  assert.equal(ok, true);
});

test('lyrics 数组按下标对齐 events：lyrics[i] 对应 events[i]', () => {
  const song = createSong({
    sections: [
      {
        name: 'Verse',
        bars: [
          {
            type: 'chords',
            events: [
              { kind: 'chord', beats: 2, chord: { root: 'C' } },
              { kind: 'chord', beats: 2, chord: { root: 'G' } },
            ],
            lyrics: [{ text: '候鸟' }, { text: '飞向南方' }],
          },
        ],
      },
    ],
  });
  const { ok, errors } = validateSongShape(song);
  assert.equal(ok, true, JSON.stringify(errors));
  const bar = song.sections[0].bars[0];
  assert.equal(bar.lyrics[0].text, '候鸟');
  assert.equal(bar.lyrics[1].text, '飞向南方');
});

test('非法歌词（非数组、项不是对象、text 非字符串）会被校验拒绝', () => {
  const badCases = [
    { lyrics: '不是数组' },
    { lyrics: ['字符串项'] },
    { lyrics: [{ text: 42 }] },
    { lyrics: [{ nope: true }] },
  ];
  for (const patch of badCases) {
    const song = createSong({
      sections: [{ name: 'V', bars: [{ type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }], ...patch }] }],
    });
    // createSong 会走 normalizeLyricsInput 容错；这里直接构造原始对象再校验，验证校验器的严格性。
    const raw = { ...song, sections: [{ ...song.sections[0], bars: [{ ...song.sections[0].bars[0], ...patch }] }] };
    const { ok } = validateSongShape(raw);
    assert.equal(ok, false, `应当拒绝 ${JSON.stringify(patch)}`);
  }
});

test('歌词片段超长时被校验拒绝', () => {
  const song = songWithBar();
  const long = '长'.repeat(61);
  song.sections[0].bars[0].lyrics = [{ text: long }];
  const { ok, errors } = validateSongShape(song);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path.includes('lyrics')), '错误应指向 lyrics 字段');
});

test('空白小节忽略 lyrics：设空白不会把歌词写进数据', () => {
  const song = createSong({
    sections: [{ name: 'V', bars: [{ type: 'empty', lyrics: [{ text: '不该存在' }] }] }],
  });
  const { ok } = validateSongShape(song);
  assert.equal(ok, true);
  assert.equal(song.sections[0].bars[0].lyrics, undefined, '空白小节的歌词应被丢弃');
});

/* ------------------------------------------------------------------ *
 * 编辑：setEventLyric
 * ------------------------------------------------------------------ */

test('setEventLyric 设置单个事件下方的歌词', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const result = setEventLyric(song, sectionId, 0, 0, '候鸟');
  assert.equal(result.ok, true);
  assert.equal(result.value.sections[0].bars[0].lyrics[0].text, '候鸟');
  assert.equal(result.value.sections[0].bars[0].lyrics[1], null, '未设置的位置应为 null');
  // 纯函数：原对象不动
  assert.equal(song.sections[0].bars[0].lyrics, undefined);
});

test('setEventLyric 传空串或 null 清掉该处歌词，全空时整个字段移除', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;

  const set = setEventLyric(song, sectionId, 0, 0, '候鸟');
  assert.equal(set.ok, true);
  assert.equal(set.value.sections[0].bars[0].lyrics.length, 2);

  const cleared = setEventLyric(set.value, sectionId, 0, 0, '');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.sections[0].bars[0].lyrics, undefined, '全空后字段应整个移除');
});

test('setEventLyric 拒绝空白小节和越界下标', () => {
  const song = createSong({
    sections: [
      { name: 'V', bars: [{ type: 'empty' }, { type: 'chords', events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }] }] },
    ],
  });
  const sectionId = song.sections[0].id;

  const onEmpty = setEventLyric(song, sectionId, 0, 0, '词');
  assert.equal(onEmpty.ok, false, '空白小节没有事件可对齐');

  const outOfRange = setEventLyric(song, sectionId, 1, 5, '词');
  assert.equal(outOfRange.ok, false, '越界下标应被拒绝');
});

test('setEventLyric 超长歌词被拒绝', () => {
  const song = songWithBar();
  const sectionId = song.sections[0].id;
  const result = setEventLyric(song, sectionId, 0, 0, '长'.repeat(61));
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ *
 * 克隆与复制：歌词跟着走，且不共享引用
 * ------------------------------------------------------------------ */

test('cloneBarWithNewIds / duplicateBar 复制小节时带歌词且换新 ID', () => {
  const song = createSong({
    sections: [
      {
        name: 'V',
        bars: [
          {
            type: 'chords',
            events: [
              { kind: 'chord', beats: 2, chord: { root: 'C' } },
              { kind: 'chord', beats: 2, chord: { root: 'G' } },
            ],
            lyrics: [{ text: '候鸟' }, { text: '飞向南方' }],
          },
        ],
      },
    ],
  });
  const sectionId = song.sections[0].id;
  const dup = duplicateBar(song, sectionId, 0);
  assert.equal(dup.ok, true);
  const [orig, copy] = dup.value.sections[0].bars;
  assert.deepEqual(copy.lyrics, [{ text: '候鸟' }, { text: '飞向南方' }]);
  assert.notEqual(copy.lyrics[0], orig.lyrics[0], '歌词片段不能共享引用');
  assert.notEqual(copy.id, orig.id);
});

test('cloneSong 深拷贝歌词，不共享可变对象', () => {
  const song = createSong({
    sections: [
      {
        name: 'V',
        bars: [
          {
            type: 'chords',
            events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }],
            lyrics: [{ text: '候鸟' }],
          },
        ],
      },
    ],
  });
  const copy = cloneSong(song);
  copy.sections[0].bars[0].lyrics[0].text = '改过';
  assert.equal(song.sections[0].bars[0].lyrics[0].text, '候鸟', '原对象不应被改动');
});

test('duplicateSong 复制整首歌时歌词跟随', () => {
  const song = createSong({
    sections: [
      {
        name: 'V',
        bars: [
          {
            type: 'chords',
            events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }],
            lyrics: [{ text: '候鸟' }],
          },
        ],
      },
    ],
  });
  const copy = duplicateSong(song);
  assert.equal(copy.sections[0].bars[0].lyrics[0].text, '候鸟');
});

/* ------------------------------------------------------------------ *
 * 序列化：JSON 往返不丢歌词
 * ------------------------------------------------------------------ */

test('序列化再反序列化，歌词信息保持', () => {
  const song = createSong({
    title: '歌词往返',
    sections: [
      {
        name: 'V',
        bars: [
          {
            type: 'chords',
            events: [{ kind: 'chord', beats: 4, chord: { root: 'C' } }],
            lyrics: [{ text: '候鸟飞向南方' }],
          },
        ],
      },
    ],
  });
  const text = JSON.stringify(song);
  const back = deserializeSongText(text);
  assert.equal(back.ok, true);
  assert.equal(back.value.sections[0].bars[0].lyrics[0].text, '候鸟飞向南方');
});

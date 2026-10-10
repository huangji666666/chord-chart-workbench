import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseImportedSong, songToChordPro, songToABC } from '../src/core/import-score.js';

globalThis.self = globalThis;
const windowObject = new JSDOM('').window;

test('ChordPro 导入保留元数据、段落、歌词和待核对信息', async () => {
  const source = JSON.stringify({
    format: 'qingpu-import',
    version: 1,
    notation: 'chordpro',
    content: '{title: 春风练习}\n{key: G}\n{capo: 2}\n{time: 4/4}\n{tempo: 82}\n{start_of_verse: 主歌}\n[G]春风[Em]轻轻[F]吹向[C]远方\n{end_of_verse}',
    issues: [{ location: '第 1 行', message: '原图有一个字不清楚' }],
  });
  const result = await parseImportedSong(source, { windowObject });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(result.song.title, '春风练习');
  assert.deepEqual(result.song.key, { tonic: 'G', mode: 'major' });
  assert.equal(result.song.capo, 2);
  assert.equal(result.song.sections[0].name, '主歌');
  assert.equal(result.song.sections[0].bars[0].lyrics[0].text, '春风');
  assert.equal(result.song.importSource.notation, 'chordpro');
  assert.equal(result.issues[0].location, '第 1 行');
});

test('ChordPro 未知和弦直接拒绝，不静默转换成休止', async () => {
  const result = await parseImportedSong('{title: 坏谱}\n{key: C}\n[Cmystery]看不清', { windowObject });
  assert.equal(result.ok, false);
  assert.match(result.message, /无法解析/);
});

test('ABC 导入提取单声部音高、和弦、歌词和精确时值', async () => {
  const source = `X:1\nT:微风练习\nM:4/4\nL:1/4\nQ:1/4=76\nK:C\nP:主歌\n"C" E D "Am" C A, |\nw: 微 风 轻 唱\n`;
  const result = await parseImportedSong(source, { windowObject });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(result.song.timing, 'exact');
  assert.equal(result.song.layout.showMelody, true);
  assert.equal(result.song.sections[0].bars[0].melody.length, 4);
  assert.equal(result.song.sections[0].bars[0].events[0].chord.root, 'C');
  assert.equal(result.song.sections[0].bars[0].events[1].chord.root, 'A');
  assert.equal(result.song.sections[0].bars[0].melody[0].lyric, '微');
});

test('ChordPro / ABC 文本导出保留可编辑入口', () => {
  const song = {
    schemaVersion: 3,
    id: 'sng_import_test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: '导出练习', artist: '', notes: '', key: { tonic: 'C', mode: 'major' }, bpm: 80,
    timeSignature: '4/4', style: '',
    sections: [{ id: 'sec_import_test', name: '主歌', repeat: 1, cue: '', bars: [{ id: 'bar_import_test', type: 'chords', events: [{ id: 'evt_import_test', kind: 'chord', beats: 4, chord: { root: 'C', quality: 'maj', bass: null } }], melody: [{ pitch: 60, beats: 4, lyric: '啊' }], lyrics: [{ text: '啊' }] }] }],
    layout: { barsPerRow: 4, displayLines: ['chord'], fontScale: 1, showMelody: true },
  };
  assert.match(songToChordPro(song), /\{title: 导出练习\}/);
  assert.match(songToABC(song), /X:1/);
  assert.match(songToABC(song), /"C"/);
});

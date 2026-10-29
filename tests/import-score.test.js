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

test('AI 返回 JSON5 风格代码时自动修复并保留待核对提示', async () => {
  const source = `识别结果如下：
\`\`\`json
{
  format: 'qingpu-import', // 模型加的说明
  version: '2',
  notation: 'abc',
  has_melody: 'true',
  timing: 'exact',
  content: \`X:1
T:修复练习
M:4/4
L:1/4
Q:1/4=76
K:C
P:主歌
"C" C D E F |
w: 一 闪 一 闪\`,
  measure: [{bar: '1', lyrics: [{lyric: '一', noteIndex: '0'}, {text: '闪', note: '2'}, {text: '一', note: 3}, {text: '闪', note: 4}]}],
  issues: [{location: '第1小节', message: '请核对字位'},],
}
\`\`\`
以上是识别结果。`;
  const result = await parseImportedSong(source, { windowObject });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(result.song.title, '修复练习');
  assert.equal(result.song.sections[0].bars[0].sourceNumber, 1);
  assert.deepEqual(result.song.sections[0].bars[0].alignment.words.map((word) => word.text), ['一', '闪', '一', '闪']);
  assert.equal(result.issues.some((item) => item.location === '自动修正'), true);
  assert.equal(result.issues.some((item) => item.location === '第1小节'), true);
});

test('AI 把结果包在 data 里、前后带说明文字时仍能识别', async () => {
  const payload = {
    data: {
      format: 'qingpu-import', version: 2, notation: 'abc', hasMelody: false, timing: 'practice',
      abc: 'X:1\nT:包装练习\nM:4/4\nL:1/4\nK:C\n"C" z2 "Am" z2 |',
      bars: [{ number: '7', syllables: [{ text: '微', note: null, x: '0.2' }], }],
    },
  };
  const result = await parseImportedSong(`模型回答：\n${JSON.stringify(payload)}\n结束`, { windowObject });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(result.song.title, '包装练习');
  assert.equal(result.song.layout.showMelody, false);
  assert.equal(result.song.sections[0].bars[0].sourceNumber, 7);
  assert.equal(result.song.sections[0].bars[0].alignment.words[0].x > 0, true);
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

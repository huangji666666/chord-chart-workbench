/**
 * 工程文件导入导出（src/core/project.js）的自动测试。
 *
 * 覆盖 SPEC §7.4 的八步导入流程，重点是「失败时当前数据完全不变」
 * 和「ID 冲突要换新 ID 而不是覆盖已有歌曲」这两条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptySong, createSong } from '../src/core/song.js';
import { SCHEMA_VERSION } from '../src/core/constants.js';
import {
  PROJECT_CODES,
  buildProject,
  formatProjectErrors,
  parseProject,
  serializeProject,
  suggestProjectFileName,
} from '../src/core/project.js';

function sampleSong() {
  return createSong({
    title: '测试曲',
    artist: '黄鸡',
    key: { tonic: 'G', mode: 'major' },
    bpm: 128,
    timeSignature: '4/4',
    sections: [
      {
        name: 'Intro',
        repeat: 2,
        cue: '清音扫弦',
        bars: [
          {
            type: 'chords',
            events: [
              { kind: 'chord', beats: 2, chord: { root: 'G', quality: 'maj' } },
              { kind: 'chord', beats: 2, chord: { root: 'D', quality: 'maj', bass: 'F#' } },
            ],
          },
          { type: 'empty' },
        ],
      },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

test('buildProject 产出固定的外层结构', () => {
  const song = sampleSong();
  const project = buildProject(song);

  assert.equal(project.schemaVersion, SCHEMA_VERSION);
  assert.equal(project.song, song);
  assert.equal(typeof project.exportedAt, 'string');
  assert.equal(new Date(project.exportedAt).toString() === 'Invalid Date', false, 'exportedAt 应是合法 ISO 时间');
});

test('导出的文本里只有和弦数据，不含任何级数字符串（§6.4）', () => {
  const song = sampleSong();
  // 就算显示模式是级数，导出的数据也必须还是和弦。
  const degreeSong = { ...song, layout: { ...song.layout, displayLines: ['degree'] } };
  const text = serializeProject(degreeSong);
  const parsed = JSON.parse(text);

  for (const section of parsed.song.sections) {
    for (const bar of section.bars) {
      for (const event of bar.events) {
        assert.deepEqual(Object.keys(event).sort(), ['beats', 'chord', 'id', 'kind']);
        assert.deepEqual(Object.keys(event.chord).sort(), ['bass', 'quality', 'root'], '和弦对象只保留 root/quality/bass');
      }
    }
  }
  assert.equal(text.includes('"1maj7"') || text.includes('"b7"'), false, '不应出现级数字符串');
});

test('导出默认带缩进，可关掉', () => {
  const song = sampleSong();
  assert.match(serializeProject(song), /\n\s+"schemaVersion"/);
  assert.equal(serializeProject(song, { pretty: false }).includes('\n'), false);
});

test('buildProject 对不合法的歌曲直接抛出，不产出坏文件', () => {
  const bad = { ...sampleSong(), bpm: 9999 };
  assert.throws(() => buildProject(bad), /歌曲数据不合法/);
  assert.throws(() => serializeProject(bad), /歌曲数据不合法/);
});

test('suggestProjectFileName 过滤掉文件系统不接受的字符', () => {
  const song = { ...sampleSong(), title: 'C/G 的练习: 第一版?', artist: '黄鸡' };
  const name = suggestProjectFileName(song);
  assert.equal(/[\\/:*?"<>|]/.test(name), false, `文件名不应含非法字符，实际：${name}`);
  assert.match(name, /\.json$/);

  assert.equal(suggestProjectFileName({ title: '', artist: '' }), '功能谱.json');
  assert.equal(suggestProjectFileName(song, '.txt').endsWith('.txt'), true);
});

/* ------------------------------------------------------------------ *
 * 往返一致
 * ------------------------------------------------------------------ */

test('导出再导入，数据完全一致（信息保持）', () => {
  const song = sampleSong();
  const text = serializeProject(song);
  const result = parseProject(text);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, song, '往返之后应逐字段相等');
  assert.equal(result.meta.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.meta.idRegenerated, false);
  assert.equal(result.meta.originalSongId, song.id);
  assert.deepEqual(result.warnings, []);
  assert.equal(typeof result.meta.exportedAt, 'string');
});

test('导入结果可以再次导出，两次文本的歌曲部分相同', () => {
  const song = sampleSong();
  const first = parseProject(serializeProject(song));
  const second = parseProject(serializeProject(first.value));
  assert.deepEqual(second.value, song);
});

/* ------------------------------------------------------------------ *
 * 导入的失败分支：任何一种都必须「当前数据不变」
 * ------------------------------------------------------------------ */

test('导入非文本类型直接拒绝', () => {
  const result = parseProject(null);
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.INPUT_TYPE);
  assert.equal(result.value, null);
});

test('体积超限时在解析之前就拒绝', () => {
  const huge = `{"schemaVersion":1,"song":${'x'.repeat(5 * 1024 * 1024)}}`;
  const result = parseProject(huge);
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.TOO_LARGE);
  assert.match(result.message, /超过上限/);
});

test('JSON 语法错误给出语法层面的提示', () => {
  const result = parseProject('{"schemaVersion":1,"song":');
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.BAD_JSON);
  assert.equal(result.value, null);
});

test('顶层不是对象时拒绝', () => {
  for (const text of ['[]', '"hi"', '42', 'null']) {
    const result = parseProject(text);
    assert.equal(result.ok, false, `${text} 应被拒绝`);
    assert.equal(result.code, PROJECT_CODES.NOT_OBJECT);
  }
});

test('顶层直接放一首歌时，给出针对性提示而不是笼统的字段错误', () => {
  const bare = JSON.stringify(sampleSong());
  const result = parseProject(bare);
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.MISSING_SONG);
  assert.match(result.message, /Song 对象本身/);
});

test('song 字段不是对象时拒绝', () => {
  const result = parseProject('{"schemaVersion":1,"song":[1,2,3]}');
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.SONG_NOT_OBJECT);
});

test('schemaVersion 不匹配时拒绝，并说明支持的版本', () => {
  const song = sampleSong();
  const result = parseProject(JSON.stringify({ schemaVersion: 99, song }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.VERSION_UNSUPPORTED);
  assert.match(result.message, new RegExp(`支持 ${SCHEMA_VERSION}`));
});

test('字段或数值不合法时给出结构化错误列表', () => {
  const song = sampleSong();
  const cases = [
    ['bpm', { ...song, bpm: 9999 }],
    ['timeSignature', { ...song, timeSignature: '5/4' }],
    ['title', { ...song, title: '' }],
    ['key.mode', { ...song, key: { tonic: 'A', mode: 'dorian' } }],
    ['layout.barsPerRow', { ...song, layout: { ...song.layout, barsPerRow: 3 } }],
  ];
  for (const [label, bad] of cases) {
    const result = parseProject(JSON.stringify({ schemaVersion: SCHEMA_VERSION, song: bad }));
    assert.equal(result.ok, false, `${label} 应被拒绝`);
    assert.equal(result.code, PROJECT_CODES.SONG_INVALID);
    assert.ok(result.errors.length > 0, `${label} 应给出错误列表`);
    assert.equal(result.value, null);
  }
});

test('歌曲内部 ID 重复时拒绝导入', () => {
  const song = sampleSong();
  const duplicated = structuredClone(song);
  duplicated.sections[0].bars[0].events[1].id = duplicated.sections[0].bars[0].events[0].id;

  const result = parseProject(JSON.stringify({ schemaVersion: SCHEMA_VERSION, song: duplicated }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PROJECT_CODES.SONG_INVALID);
  assert.ok(result.errors.some((issue) => /重复 ID/.test(issue.message)));
});

test('formatProjectErrors 会把超出的条数折叠起来', () => {
  const errors = Array.from({ length: 12 }, (_, i) => ({ path: `sections[0].bars[${i}]`, message: '出问题了' }));
  const text = formatProjectErrors(errors, 5);
  assert.equal(text.split('\n').length, 6);
  assert.match(text, /另有 7 处问题/);
});

/* ------------------------------------------------------------------ *
 * ID 冲突处理
 * ------------------------------------------------------------------ */

test('歌曲 ID 与曲库中已有歌曲冲突时换新 ID，不覆盖已有歌曲', () => {
  const song = sampleSong();
  const text = serializeProject(song);

  const result = parseProject(text, { existingSongIds: [song.id, 'sng_别的歌'] });
  assert.equal(result.ok, true);
  assert.notEqual(result.value.id, song.id, '冲突时必须换一个新 ID');
  assert.match(result.value.id, /^sng_/);
  assert.equal(result.meta.idRegenerated, true);
  assert.equal(result.meta.originalSongId, song.id);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /生成新的 ID/);

  // 除了 ID，其余内容必须原样保留。
  const { id: _changed, ...rest } = result.value;
  const { id: _original, ...expected } = song;
  assert.deepEqual(rest, expected);
});

test('新生成的 ID 不能撞上曲库里已有的其它 ID', () => {
  const song = sampleSong();
  // 故意让已有的 ID 集合很长，尽量抬高撞车概率。
  const existing = [song.id, ...Array.from({ length: 200 }, (_, i) => `sng_filler${i}`)];
  const result = parseProject(serializeProject(song), { existingSongIds: existing });
  assert.equal(result.ok, true);
  assert.equal(existing.includes(result.value.id), false);
});

test('不冲突时保留原 ID，并通过 regenerateOnConflict:false 关闭该行为', () => {
  const song = sampleSong();

  const kept = parseProject(serializeProject(song), { existingSongIds: ['sng_别的歌'] });
  assert.equal(kept.value.id, song.id);
  assert.equal(kept.meta.idRegenerated, false);
  assert.deepEqual(kept.warnings, []);

  const forced = parseProject(serializeProject(song), { existingSongIds: [song.id], regenerateOnConflict: false });
  assert.equal(forced.ok, true);
  assert.equal(forced.value.id, song.id, '关掉之后应原样保留，交给调用方自己处理');
  assert.equal(forced.meta.idRegenerated, false);
});

test('连续导入同一份文件两次会得到两个不同的歌曲 ID', () => {
  const text = serializeProject(sampleSong());
  const first = parseProject(text);
  const second = parseProject(text, { existingSongIds: [first.value.id] });
  assert.notEqual(first.value.id, second.value.id);
});

/* ------------------------------------------------------------------ *
 * 与「新建歌曲」的一致性
 * ------------------------------------------------------------------ */

test('新导出的空歌曲也能原样导入', () => {
  const song = createEmptySong('空白新歌');
  const result = parseProject(serializeProject(song));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, song);
});

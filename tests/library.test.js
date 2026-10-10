/**
 * 曲库本地保存（src/core/library.js）的自动测试。
 *
 * 重点检查三件事（都对应用户会真实丢数据的场景）：
 * 1. 读到损坏数据时**原始字符串必须原样保留**，且不能被自动覆盖。
 * 2. 写失败（配额满 / 隐私模式）必须如实上报，不能假装保存成功。
 * 3. 刷新后能恢复（存进去什么，读出来就是什么）。
 *
 * @see docs/SPEC.md §7.3
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptySong, createSong } from '../src/core/song.js';
import {
  LIBRARY_CODES,
  LIBRARY_SCHEMA_VERSION,
  LIBRARY_STORAGE_KEY,
  clearLibrary,
  createEmptyLibrary,
  createMemoryStorage,
  estimateLibraryBytes,
  findSongById,
  hasSongId,
  loadLibrary,
  readRawLibrary,
  removeSongById,
  saveLibrary,
  setActiveSongId,
  songCount,
  suggestTitle,
  upsertSong,
} from '../src/core/library.js';

function sampleLibrary() {
  const first = createEmptySong('第一首');
  const second = createSong({
    title: '第二首',
    timeSignature: '3/4',
    sections: [{ name: 'Verse', bars: [{ type: 'chords', events: [{ kind: 'chord', beats: 3, chord: { root: 'A', quality: 'm' } }] }] }],
  });
  return { ...createEmptyLibrary(), songs: [first, second], activeSongId: second.id };
}

/* ------------------------------------------------------------------ *
 * 空库与往返恢复
 * ------------------------------------------------------------------ */

test('从没保存过时返回一个空曲库，而不是报错', () => {
  const storage = createMemoryStorage();
  const result = loadLibrary(storage);
  assert.equal(result.ok, true);
  assert.equal(result.raw, null);
  assert.deepEqual(result.value.songs, []);
  assert.equal(result.value.activeSongId, null);
  assert.equal(result.value.schemaVersion, LIBRARY_SCHEMA_VERSION);
});

test('存进去再读出来，内容一致（模拟刷新页面）', () => {
  const storage = createMemoryStorage();
  const library = sampleLibrary();

  const saved = saveLibrary(storage, library);
  assert.equal(saved.ok, true);
  assert.ok(saved.bytes > 0);

  const loaded = loadLibrary(storage);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.value, library, '读出来的结构应与存入时完全一致');
  assert.equal(loaded.value.activeSongId, library.activeSongId, '「上次打开的是哪首」也要恢复');
  assert.equal(loaded.needsRepair, false);
  assert.deepEqual(loaded.warnings, []);
});

test('storage 不可用时读取与写入都如实报错', () => {
  const load = loadLibrary(null);
  assert.equal(load.ok, false);
  assert.equal(load.code, LIBRARY_CODES.STORAGE_UNAVAILABLE);
  assert.equal(load.raw, null);

  const save = saveLibrary(null, createEmptyLibrary());
  assert.equal(save.ok, false);
  assert.equal(save.code, LIBRARY_CODES.STORAGE_UNAVAILABLE);
});

test('写入失败（配额满）如实上报，并明确是配额问题', () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    const error = new Error('The quota has been exceeded.');
    error.name = 'QuotaExceededError';
    throw error;
  };

  const result = saveLibrary(storage, sampleLibrary());
  assert.equal(result.ok, false);
  assert.equal(result.code, LIBRARY_CODES.QUOTA_EXCEEDED);
  assert.match(result.message, /空间已满/);
});

test('其它写入异常报 WRITE_FAILED，不冒充配额问题', () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    throw new Error('boom');
  };
  const result = saveLibrary(storage, sampleLibrary());
  assert.equal(result.ok, false);
  assert.equal(result.code, LIBRARY_CODES.WRITE_FAILED);
  assert.match(result.message, /boom/);
});

/* ------------------------------------------------------------------ *
 * 损坏数据：保留原文，绝不覆盖
 * ------------------------------------------------------------------ */

test('JSON 损坏时返回原始字符串，并且不修改本地存储', () => {
  const broken = '{"schemaVersion":1,"songs":[{"id":"sng_1"';
  const storage = createMemoryStorage({ [LIBRARY_STORAGE_KEY]: broken });
  const before = storage.getItem(LIBRARY_STORAGE_KEY);

  const result = loadLibrary(storage);
  assert.equal(result.ok, false);
  assert.equal(result.code, LIBRARY_CODES.CORRUPT_JSON);
  assert.equal(result.raw, broken, '原始内容必须原样交回，供用户导出备份');
  assert.equal(storage.getItem(LIBRARY_STORAGE_KEY), before, '读取过程绝不能写回');
  assert.match(result.message, /原始内容已保留/);
});

test('顶层不是对象、songs 不是数组、版本不符都分别报清楚', () => {
  const cases = [
    ['[1,2,3]', LIBRARY_CODES.INVALID_SHAPE],
    ['"hello"', LIBRARY_CODES.INVALID_SHAPE],
    ['{"schemaVersion":1}', LIBRARY_CODES.INVALID_SHAPE],
    ['{"schemaVersion":99,"songs":[]}', LIBRARY_CODES.VERSION_UNSUPPORTED],
    ['{"schemaVersion":1,"songs":"nope"}', LIBRARY_CODES.INVALID_SHAPE],
  ];
  for (const [raw, code] of cases) {
    const storage = createMemoryStorage({ [LIBRARY_STORAGE_KEY]: raw });
    const result = loadLibrary(storage);
    assert.equal(result.ok, false, `raw=${raw} 应当失败`);
    assert.equal(result.code, code, `raw=${raw} 的错误码`);
    assert.equal(result.raw, raw);
    assert.equal(storage.getItem(LIBRARY_STORAGE_KEY), raw, '内容不能被改动');
  }
});

test('单首歌不合法时隔离它，其余歌曲照常加载，并标记需要修复', () => {
  const good = createEmptySong('好歌');
  const bad = { ...createEmptySong('坏歌'), timeSignature: '5/4' };
  const raw = JSON.stringify({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    activeSongId: good.id,
    songs: [good, bad],
    updatedAt: new Date().toISOString(),
  });
  const storage = createMemoryStorage({ [LIBRARY_STORAGE_KEY]: raw });

  const result = loadLibrary(storage);
  assert.equal(result.ok, true, '整体仍然可加载，不能因为一首坏歌让整个曲库打不开');
  assert.equal(result.value.songs.length, 1);
  assert.equal(result.value.songs[0].title, '好歌');
  assert.equal(result.needsRepair, true);
  assert.equal(result.brokenSongs.length, 1);
  assert.equal(result.brokenSongs[0].index, 1);
  assert.ok(result.brokenSongs[0].errors.length > 0);
  assert.match(result.warnings[0], /1 首歌曲数据不合法/);
  assert.equal(storage.getItem(LIBRARY_STORAGE_KEY), raw, '隔离不等于改写，原始内容必须原封不动');
});

test('activeSongId 指向已不存在的歌曲时退回第一首', () => {
  const library = sampleLibrary();
  const storage = createMemoryStorage();
  saveLibrary(storage, { ...library, activeSongId: 'sng_根本不存在' });

  const result = loadLibrary(storage);
  assert.equal(result.ok, true);
  assert.equal(result.value.activeSongId, result.value.songs[0].id);
});

test('saveLibrary 拒绝把不合法的歌曲写进本地存储', () => {
  const storage = createMemoryStorage();
  const library = { ...createEmptyLibrary(), songs: [{ ...createEmptySong('坏的'), bpm: 9999 }] };

  const result = saveLibrary(storage, library);
  assert.equal(result.ok, false);
  assert.equal(result.code, LIBRARY_CODES.SONG_INVALID);
  assert.equal(storage.getItem(LIBRARY_STORAGE_KEY), null, '拒绝写入时本地存储应保持原样');
});

/* ------------------------------------------------------------------ *
 * 清理与原始备份
 * ------------------------------------------------------------------ */

test('clearLibrary 删除整个键，readRawLibrary 能取出原文', () => {
  const raw = '{"schemaVersion":1,"songs":[],"activeSongId":null}';
  const storage = createMemoryStorage({ [LIBRARY_STORAGE_KEY]: raw });

  const before = readRawLibrary(storage);
  assert.equal(before.ok, true);
  assert.equal(before.raw, raw);

  assert.equal(clearLibrary(storage).ok, true);
  assert.equal(storage.getItem(LIBRARY_STORAGE_KEY), null);
  assert.equal(readRawLibrary(storage).raw, null);
});

/* ------------------------------------------------------------------ *
 * 曲库内容的纯函数操作
 * ------------------------------------------------------------------ */

test('upsertSong 按 ID 替换或追加，且不修改原曲库', () => {
  const library = sampleLibrary();
  const before = JSON.stringify(library);

  const third = createEmptySong('第三首');
  const added = upsertSong(library, third);
  assert.equal(added.songs.length, 3);
  assert.equal(JSON.stringify(library), before, '不能修改入参');

  const renamed = { ...added.songs[0], title: '改过名' };
  const replaced = upsertSong(added, renamed);
  assert.equal(replaced.songs.length, 3, '同 ID 应替换而不是追加');
  assert.equal(replaced.songs[0].title, '改过名');
});

test('removeSongById 删除歌曲，删的是当前那首时自动切换', () => {
  const library = sampleLibrary();
  const activeId = library.activeSongId;

  const removed = removeSongById(library, activeId);
  assert.equal(removed.songs.length, 1);
  assert.equal(removed.activeSongId, removed.songs[0].id, '当前歌被删后应退到剩余的第一首');
  assert.equal(JSON.stringify(library) !== JSON.stringify(removed), true);

  const empty = removeSongById(removed, removed.songs[0].id);
  assert.equal(empty.songs.length, 0);
  assert.equal(empty.activeSongId, null);
});

test('setActiveSongId 拒绝不存在的 ID', () => {
  const library = sampleLibrary();
  const miss = setActiveSongId(library, 'sng_不存在');
  assert.equal(miss.ok, false);
  assert.equal(miss.library, library, '失败时应原样返回原曲库');

  const hit = setActiveSongId(library, library.songs[0].id);
  assert.equal(hit.ok, true);
  assert.equal(hit.library.activeSongId, library.songs[0].id);
});

test('findSongById / hasSongId / songCount 行为正确', () => {
  const library = sampleLibrary();
  assert.equal(findSongById(library, library.songs[1].id).title, '第二首');
  assert.equal(findSongById(library, 'nope'), null);
  assert.equal(hasSongId(library, library.songs[0].id), true);
  assert.equal(hasSongId(library, 'nope'), false);
  assert.equal(songCount(library), 2);
});

test('suggestTitle 在重名时追加序号', () => {
  const library = createEmptyLibrary();
  assert.equal(suggestTitle(library, '新歌'), '新歌');

  const withOne = upsertSong(library, createEmptySong('新歌'));
  assert.equal(suggestTitle(withOne, '新歌'), '新歌 2');

  const withTwo = upsertSong(withOne, createEmptySong('新歌 2'));
  assert.equal(suggestTitle(withTwo, '新歌'), '新歌 3');
});

test('estimateLibraryBytes 随歌曲增加而变大', () => {
  const library = createEmptyLibrary();
  const one = upsertSong(library, createEmptySong('一'));
  const two = upsertSong(one, createEmptySong('二'));
  assert.ok(estimateLibraryBytes(one) > estimateLibraryBytes(library));
  assert.ok(estimateLibraryBytes(two) > estimateLibraryBytes(one));
});

test('内存 storage 的行为与 localStorage 一致（getItem 未命中返回 null）', () => {
  const storage = createMemoryStorage();
  assert.equal(storage.getItem('不存在'), null);
  storage.setItem('k', 'v');
  assert.equal(storage.getItem('k'), 'v');
  storage.setItem('k', 123);
  assert.equal(storage.getItem('k'), '123', '写入应转成字符串，和 localStorage 一样');
  storage.removeItem('k');
  assert.equal(storage.getItem('k'), null);
});

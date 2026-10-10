/**
 * v1 → v2 数据迁移（docs/SPEC.md §7.4）的自动测试。
 *
 * v1 把显示方式存成单个字符串 `layout.displayMode`，v2 换成了数组
 * `layout.displayLines`。这份测试盯住三件事：
 *
 * 1. **老文件能救回来**，而不是被版本号挡在门外 —— 这是迁移存在的唯一理由。
 *    如果哪天有人把迁移挪到校验后面，这里会红，而错误信息会指向版本号，
 *    用户根本看不出「其实可以升级」。
 * 2. **旧字段不会写回**：迁移后数据里没有 `displayMode`，只剩 `displayLines`
 *    一个真相，否则两份显示偏好会互相打架。
 * 3. **迁移是纯函数**：不修改传入的原始数据 —— 否则「导入失败时当前数据不变」
 *    这条承诺会被从侧面绕过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptySong,
  deserializeSongText,
  migrateSong,
  serializeSong,
  validateSongShape,
} from '../src/core/song.js';
import { SCHEMA_VERSION } from '../src/core/constants.js';
import { parseProject } from '../src/core/project.js';

/** 造一份 v1 格式的歌曲数据：`schemaVersion: 1` + `layout.displayMode`。 */
function v1Song(displayMode) {
  const song = createEmptySong('老歌');
  return {
    ...song,
    schemaVersion: 1,
    layout: { barsPerRow: 4, displayMode, fontScale: 1 },
  };
}

test('v1 的 displayMode 字符串被翻译成 v2 的 displayLines 数组', () => {
  assert.deepEqual(migrateSong(v1Song('chord')).layout.displayLines, ['chord']);
  assert.deepEqual(migrateSong(v1Song('degree')).layout.displayLines, ['degree']);
});

test('迁移后版本号是当前版本，且旧字段不留在数据里', () => {
  const migrated = migrateSong(v1Song('degree'));

  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(
    Object.prototype.hasOwnProperty.call(migrated.layout, 'displayMode'),
    false,
    'displayMode 必须在迁移时丢弃，否则数据里会有两份互相打架的显示偏好',
  );
  assert.deepEqual(
    Object.keys(migrated.layout).sort(),
    ['barsPerRow', 'displayLines', 'fontScale'],
    'layout 的形状必须和 v2 完全一致，不多不少',
  );
});

test('displayMode 缺失或非法时退回默认，而不是让迁移失败', () => {
  assert.deepEqual(migrateSong(v1Song(undefined)).layout.displayLines, ['chord']);
  assert.deepEqual(migrateSong(v1Song('both')).layout.displayLines, ['chord']);
  assert.deepEqual(migrateSong(v1Song(123)).layout.displayLines, ['chord']);
  assert.deepEqual(migrateSong(v1Song(null)).layout.displayLines, ['chord']);
});

test('v1 里 layout 缺失时也能迁移，不抛异常', () => {
  const bare = { ...createEmptySong('老歌'), schemaVersion: 1 };
  delete bare.layout;

  const migrated = migrateSong(bare);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.layout.displayLines, ['chord']);
});

test('迁移是纯函数：不修改传入的原始数据', () => {
  const original = v1Song('degree');
  const snapshot = JSON.stringify(original);

  migrateSong(original);

  assert.equal(JSON.stringify(original), snapshot, '迁移不得就地改写');
  assert.equal(original.schemaVersion, 1, '原始数据必须保持 v1');
  assert.equal(original.layout.displayMode, 'degree', '原始数据的旧字段必须还在');
});

test('迁移结果直接通过 v2 的严格校验', () => {
  const result = validateSongShape(migrateSong(v1Song('degree')));
  assert.equal(result.ok, true, result.ok ? '' : result.errors.map((e) => e.message).join('\n'));
});

test('不是对象、或版本号不是 1 的输入原样返回 —— 迁移不抢校验的活', () => {
  for (const raw of [null, undefined, 'x', 42, [], { schemaVersion: 99 }]) {
    assert.equal(migrateSong(raw), raw);
  }
});

test('deserializeSongText 能读进一份 v1 文件并升级到 v2', () => {
  const result = deserializeSongText(JSON.stringify(v1Song('degree')));

  assert.equal(result.ok, true, result.ok ? '' : result.errors.map((e) => e.message).join('\n'));
  assert.equal(result.value.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(result.value.layout.displayLines, ['degree']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.value.layout, 'displayMode'), false);
});

test('v1 文件的迁移发生在校验之前（回归测试）', () => {
  // 反例：把 migrateSong 挪到 validateSongShape 后面，一份完全合法的 v1 文件
  // 会得到「只支持 schemaVersion = 2，当前值为 1」——那条信息把「可以升级」
  // 这件唯一重要的事藏了起来，用户只会以为文件坏了。
  const result = deserializeSongText(JSON.stringify(v1Song('chord')));

  assert.equal(result.ok, true, '合法的 v1 文件必须能导入，而不是被拒');
  assert.equal(
    result.errors.length,
    0,
    '不该有任何「版本不支持」之类的错误',
  );
});

test('导入工程文件时 v1 同样可迁移，且 meta 如实报告源文件版本', () => {
  const project = {
    schemaVersion: 1,
    exportedAt: '2026-09-20T10:00:00.000Z',
    song: v1Song('degree'),
  };

  const result = parseProject(JSON.stringify(project));

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
  assert.equal(result.value.schemaVersion, SCHEMA_VERSION, '导入进来的歌曲必须是当前版本');
  assert.deepEqual(result.value.layout.displayLines, ['degree']);
  assert.equal(result.meta.schemaVersion, 1, 'meta 报的是源文件版本，界面据此提示「已升级」');
});

test('真正不支持的版本号仍然被拒，且错误指向版本号', () => {
  const result = deserializeSongText(
    JSON.stringify({ ...v1Song('chord'), schemaVersion: 9999 }),
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === 'schemaVersion'),
    `应当有一条指向 schemaVersion 的错误，实际：${JSON.stringify(result.errors)}`,
  );
});

test('已迁移的数据再导出是 v2，不会退回 v1', () => {
  const migrated = migrateSong(v1Song('degree'));
  const roundTrip = deserializeSongText(serializeSong(migrated));

  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.value.schemaVersion, SCHEMA_VERSION);
  assert.equal(
    Object.prototype.hasOwnProperty.call(roundTrip.value.layout, 'displayMode'),
    false,
    '来回一次不该长出旧字段',
  );
  assert.deepEqual(roundTrip.value.layout.displayLines, ['degree'], '显示偏好要活过来');
});

/* ------------------------------------------------------------------ *
 * 后加的可选字段 `dimSuffix` 不升版本号（SPEC §7.4、§11 第 11 条）
 *
 * 这一组里第一条是**最要命**的一条回归：`library.js` 读 localStorage 时
 * 直接调 `validateSongShape`、**不走迁移**。若谁把 `dimSuffix` 改成必需字段，
 * 用户已存的每一首歌都会在下次打开时被判为损坏并隔离 —— 测试跑不出来的话，
 * 代价是用户全部的歌。
 * ------------------------------------------------------------------ */

test('v2 数据缺 dimSuffix 必须被接受 —— 老数据不能因为新字段变成「损坏」', () => {
  const song = createEmptySong('老歌');
  delete song.layout.dimSuffix; // 模拟 schemaVersion=2 时代存下来的数据

  const validation = validateSongShape(song);
  assert.equal(
    validation.ok,
    true,
    `若这里红了，说明 dimSuffix 被当成必需字段了：library.js 直接调本函数读 localStorage，用户已存的每首歌都会在下次打开时被隔离。实际错误：${JSON.stringify(validation.errors)}`,
  );
});

test('createSong 造出来的新歌总是写全 dimSuffix，且版本号不变', () => {
  const song = createEmptySong('新歌');
  assert.equal(song.layout.dimSuffix, 'dim', '自己造的歌曲形态统一');
  assert.equal(song.schemaVersion, SCHEMA_VERSION, '新歌使用支持旋律的当前版本');
});

test('dimSuffix 非法时校验必须报错，并定位到 layout.dimSuffix', () => {
  for (const bogus of ['o', 'DIM', '', 42, null, {}, ['°']]) {
    const song = createEmptySong('坏字段');
    song.layout.dimSuffix = bogus;

    const validation = validateSongShape(song);
    assert.equal(validation.ok, false, `${JSON.stringify(bogus)} 应当被拒绝`);
    assert.equal(
      validation.errors.some((issue) => issue.path === 'layout.dimSuffix'),
      true,
      '错误必须定位到 layout.dimSuffix，否则用户不知道去改哪里',
    );
  }
});

test('缺 dimSuffix 的歌走完整导入链路也照常通过，且不被偷偷补值', () => {
  const song = createEmptySong('缺字段的歌');
  delete song.layout.dimSuffix;

  const parsed = parseProject(JSON.stringify({ schemaVersion: 2, exportedAt: null, song }));
  if (!parsed.ok) assert.fail(`导入被拒绝了：${parsed.message}`);

  assert.equal(
    parsed.value.layout.dimSuffix,
    undefined,
    '导入不该顺手补字段 —— 「缺失」是合法状态，补默认值的是渲染关口，不是导入',
  );
});

test('v1 老文件升级后 displayLines 到位，而 dimSuffix 仍然缺失（迁移不造字段）', () => {
  const migrated = migrateSong(v1Song('degree'));

  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.layout.displayLines, ['degree']);
  assert.equal(migrated.layout.displayMode, undefined, '旧字段被丢弃');
  assert.equal(
    migrated.layout.dimSuffix,
    undefined,
    'v1 里没有这个字段，迁移不该凭空造一个 —— 那会假装「用户设置过」',
  );
});

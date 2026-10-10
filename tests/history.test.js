/**
 * 撤销 / 重做历史栈（src/core/history.js）的自动测试。
 *
 * @see docs/SPEC.md §7.2
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSong, validateSongShape } from '../src/core/song.js';
import { addEvent, removeBar, renameSection, setBarEmpty } from '../src/core/edit.js';
import {
  DEFAULT_HISTORY_LIMIT,
  canRedo,
  canUndo,
  commit,
  createHistory,
  currentLabel,
  currentSong,
  describeHistory,
  redo,
  redoLabel,
  resetHistory,
  undo,
  undoDepth,
  undoLabel,
} from '../src/core/history.js';

function baseSong(title = '历史测试') {  return createSong({
    title,
    timeSignature: '4/4',
    sections: [
      {
        name: 'A',
        bars: [
          {
            type: 'chords',
            events: [
              { kind: 'chord', beats: 2, chord: { root: 'C' } },
              { kind: 'chord', beats: 2, chord: { root: 'G' } },
            ],
          },
          { type: 'empty' },
        ],
      },
    ],
  });
}

/**
 * 取出编辑结果里的新歌曲；失败时立刻报出真实错误原因，
 * 而不是让它变成下游一句莫名其妙的 "Cannot read properties of null"。
 */
function unwrap(result, hint = '编辑') {
  assert.equal(result.ok, true, `${hint}应当成功，实际失败：${result.message ?? '(无信息)'}`);
  return result.value;
}

/* ------------------------------------------------------------------ *
 * 基本行为
 * ------------------------------------------------------------------ */

test('刚创建的历史栈没有可撤销 / 可重做的步', () => {
  const history = createHistory(baseSong());
  assert.equal(currentSong(history), history.entries[0].song);
  assert.equal(currentLabel(history), '初始状态');
  assert.equal(canUndo(history), false);
  assert.equal(canRedo(history), false);
  assert.equal(undoLabel(history), null);
  assert.equal(redoLabel(history), null);
  assert.equal(undoDepth(history), 0);
});

test('commit 推进一步，撤销与重做各回退 / 前进一步', () => {
  const song = baseSong();
  let history = createHistory(song);

  const edited = renameSection(song, song.sections[0].id, '前奏').value;
  history = commit(history, edited, '重命名段落');

  assert.equal(currentSong(history), edited);
  assert.equal(canUndo(history), true);
  assert.equal(canRedo(history), false);
  assert.equal(undoLabel(history), '重命名段落', '撤销按钮应显示刚做的那一步');

  const back = undo(history);
  assert.equal(canUndo(back), false);
  assert.equal(canRedo(back), true);
  assert.equal(currentSong(back), song, '撤销应取回原来那个对象');
  assert.equal(redoLabel(back), '重命名段落');

  const forward = redo(back);
  assert.equal(currentSong(forward), edited);
  assert.equal(canRedo(forward), false);
});

test('撤销到不能撤销时原样返回，不抛异常也不破坏历史', () => {
  const history = createHistory(baseSong());
  assert.equal(undo(history), history);
  assert.equal(redo(history), history);
});

test('提交同一个对象视为无变化，不污染撤销栈', () => {
  const song = baseSong();
  let history = createHistory(song);
  const same = commit(history, song, '什么都没改');
  assert.equal(same, history, '应当返回原历史栈');
  assert.equal(canUndo(same), false);
});

test('撤销两步后再做新编辑，重做分支被截断', () => {
  const song = baseSong();
  const sectionId = song.sections[0].id;
  let history = createHistory(song);

  const step1 = unwrap(renameSection(song, sectionId, '第一步'), '第一步');
  history = commit(history, step1, '第一步');
  const step2 = unwrap(renameSection(step1, sectionId, '第二步'), '第二步');
  history = commit(history, step2, '第二步');
  assert.equal(describeHistory(history).total, 3);

  history = undo(history);
  assert.equal(canRedo(history), true);

  const branch = unwrap(renameSection(step1, sectionId, '另一条路'), '另一条路');
  history = commit(history, branch, '另一条路');

  assert.deepEqual(
    describeHistory(history).labels,
    ['初始状态', '第一步', '另一条路'],
    '被撤销的「第二步」应被丢弃，新编辑接在撤销点上',
  );
  assert.equal(canRedo(history), false, '截断之后不能再重做');
  assert.equal(currentLabel(history), '另一条路');
});

test('历史长度受 limit 限制，超出时丢弃最旧的一步', () => {
  const song = baseSong();
  const sectionId = song.sections[0].id;
  let history = createHistory(song, { limit: 3 });
  let current = song;

  for (let i = 1; i <= 6; i += 1) {
    current = renameSection(current, sectionId, `第 ${i} 次`).value;
    history = commit(history, current, `第 ${i} 次`);
  }

  assert.equal(history.entries.length, 4, 'entries 上限是 limit + 1');
  assert.equal(history.limit, 3);
  assert.equal(describeHistory(history).labels[0], '第 3 次', '最旧的几步应被丢弃');
  assert.equal(currentLabel(history), '第 6 次');
  assert.equal(undoDepth(history), 3, '最多还能撤销 3 步');
});

test('limit 传非法值时退回默认值', () => {
  const history = createHistory(baseSong(), { limit: 0 });
  assert.equal(history.limit, DEFAULT_HISTORY_LIMIT);
  assert.equal(createHistory(baseSong(), { limit: -5 }).limit, DEFAULT_HISTORY_LIMIT);
  assert.equal(createHistory(baseSong(), { limit: 2.5 }).limit, DEFAULT_HISTORY_LIMIT);
});

test('resetHistory 换歌后重新开始记录', () => {
  const song = baseSong();
  let history = createHistory(song);
  history = commit(history, renameSection(song, song.sections[0].id, 'X').value, '改名');
  assert.equal(canUndo(history), true);

  const other = baseSong('另一首');
  const reset = resetHistory(history, other, '切换歌曲');
  assert.equal(currentSong(reset), other);
  assert.equal(canUndo(reset), false, '切换歌曲不应变成可撤销的一步');
  assert.equal(canRedo(reset), false);
  assert.equal(currentLabel(reset), '切换歌曲');
  assert.equal(reset.limit, history.limit, 'limit 应保留');
});

/* ------------------------------------------------------------------ *
 * 与编辑模块联动（真实使用路径）
 * ------------------------------------------------------------------ */

test('一串真实编辑之后逐步撤销，能精确回到每一个中间状态', () => {
  const song = baseSong();
  const a = song.sections[0];
  let history = createHistory(song);

  const v1 = unwrap(renameSection(song, a.id, '前奏'), '重命名');
  history = commit(history, v1, '重命名段落');
  const v2 = unwrap(addEvent(v1, a.id, 1, { kind: 'chord', beats: 4, chord: { root: 'A', quality: 'm' } }), '添加和弦');
  history = commit(history, v2, '添加和弦');
  const v3 = unwrap(setBarEmpty(v2, a.id, 0, true, { discardEvents: true }), '设为空白');
  history = commit(history, v3, '设为空白小节');
  const v4 = unwrap(removeBar(v3, a.id, 1), '删除小节');
  history = commit(history, v4, '删除小节');

  assert.equal(undoDepth(history), 4);
  assert.equal(currentLabel(history), '删除小节');

  const states = [v4, v3, v2, v1, song];
  const labels = ['删除小节', '设为空白小节', '添加和弦', '重命名段落', null];
  for (let i = 0; i < states.length; i += 1) {
    assert.equal(currentSong(history), states[i], `第 ${i} 个状态应吻合`);
    if (i < labels.length - 1) {
      assert.equal(undoLabel(history), labels[i]);
      history = undo(history);
    }
  }
  assert.equal(canUndo(history), false);
});

test('撤销返回的是原来的对象，ID 全程保持不变（§7.2）', () => {
  const song = baseSong();
  const sectionId = song.sections[0].id;
  const eventIds = song.sections[0].bars[0].events.map((event) => event.id);

  let history = createHistory(song);
  history = commit(history, setBarEmpty(song, sectionId, 0, true, { discardEvents: true }).value, '清空小节');

  const restored = currentSong(undo(history));
  assert.equal(restored, song, '撤销必须取回同一个对象，而不是一份重建的拷贝');
  assert.equal(restored.sections[0].bars[0].events.map((event) => event.id).join(','), eventIds.join(','), '事件 ID 必须原样保留');
  assert.equal(validateSongShape(restored).ok, true);
});

test('历史栈里每一步存下的歌曲都是合法的', () => {
  const song = baseSong();
  const sectionId = song.sections[0].id;
  let history = createHistory(song);

  const edits = [
    renameSection(song, sectionId, '前奏').value,
    addEvent(song, sectionId, 1, { kind: 'rest', beats: 4 }).value,
    setBarEmpty(song, sectionId, 1, false).value,
  ];
  for (const [index, edited] of edits.entries()) {
    history = commit(history, edited, `第 ${index + 1} 步`);
  }

  for (const entry of history.entries) {
    assert.equal(validateSongShape(entry.song).ok, true, `「${entry.label}」这一步的数据必须合法`);
  }
});

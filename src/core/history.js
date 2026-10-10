/**
 * 撤销 / 重做历史栈（docs/SPEC.md §7.2）。
 *
 * ## 为什么用「一串快照 + 一个游标」而不是命令模式
 *
 * 快照方案看起来「浪费」，但在这个规模下是最省心的：一首功能谱撑死几十 KB，
 * 存 50 步也就几 MB 内存，而命令模式需要为每种操作各写一份 `do` / `undo`，
 * 一旦某对写得不完全对称，撤销之后数据就会悄悄偏掉——这种 bug 极难发现。
 * 快照是**结构上不可能不对称**的。
 *
 * 代价是每次编辑都要新建对象。`edit.js` 里所有操作本来就是纯函数、返回新对象，
 * 所以这里不需要额外做深拷贝。
 *
 * ## 粒度的定义
 *
 * 一次 `commit()` = 一次用户操作（不是一次字段改动）。界面上的「改标题」应该
 * 在输入结束时 commit 一次，而不是每敲一个字符 commit 一次，否则撤销要按几十次
 * 才退得回去。
 *
 * ## 重做分支会被截断
 *
 * 撤销两步之后又做了一次新编辑，那条「未来」就作废了——这是所有编辑器的
 * 通用行为，也是唯一说得通的行为。
 *
 * @module core/history
 */

/** 默认最多记住多少步（不含当前状态）。 */
export const DEFAULT_HISTORY_LIMIT = 50;

/**
 * 历史栈。
 *
 * `entries` 是一条时间线，`index` 指向「当前状态」。撤销只是把 `index` 往回挪，
 * 不删除任何 entry，所以重做随时可用。
 *
 * @typedef {Object} History
 * @property {Array<{song: import('./song.js').Song, label: string}>} entries
 * @property {number} index 当前状态在 entries 中的下标。
 * @property {number} limit 最多保留多少条历史（不含当前状态）。
 */

/**
 * 创建历史栈。
 *
 * @param {import('./song.js').Song} song 初始歌曲。
 * @param {{limit?: number, label?: string}} [options]
 * @returns {History}
 */
export function createHistory(song, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_HISTORY_LIMIT;
  return {
    entries: [{ song, label: options.label ?? '初始状态' }],
    index: 0,
    limit,
  };
}

/**
 * 取当前歌曲。
 * @param {History} history
 * @returns {import('./song.js').Song}
 */
export function currentSong(history) {
  return history.entries[history.index].song;
}

/**
 * 取当前状态是由哪一步操作产生的（界面上「撤销：<label>」用）。
 * @param {History} history
 * @returns {string}
 */
export function currentLabel(history) {
  return history.entries[history.index].label;
}

/**
 * 还能撤销吗。
 * @param {History} history
 * @returns {boolean}
 */
export function canUndo(history) {
  return history.index > 0;
}

/**
 * 还能重做吗。
 * @param {History} history
 * @returns {boolean}
 */
export function canRedo(history) {
  return history.index < history.entries.length - 1;
}

/**
 * 撤销一步会退回到哪一步的标签（用于按钮文案），不能撤销时返回 null。
 * @param {History} history
 * @returns {string|null}
 */
export function undoLabel(history) {
  return canUndo(history) ? history.entries[history.index].label : null;
}

/**
 * 重做一步会前进到哪一步的标签，不能重做时返回 null。
 * @param {History} history
 * @returns {string|null}
 */
export function redoLabel(history) {
  return canRedo(history) ? history.entries[history.index + 1].label : null;
}

/**
 * 提交一次编辑，产生新的历史栈。
 *
 * 传入的歌曲与当前歌曲**引用相同**时视为无变化，直接返回原历史栈
 * （避免「点了按钮但什么都没改」这类操作污染撤销栈）。
 *
 * @param {History} history
 * @param {import('./song.js').Song} song 编辑后的新歌曲。
 * @param {string} [label] 这一步的操作名，用于界面提示。
 * @returns {History}
 */
export function commit(history, song, label = '编辑') {
  if (song === currentSong(history)) return history;

  // 丢掉被撤销掉的那条「未来」。
  const kept = history.entries.slice(0, history.index + 1);
  kept.push({ song, label });

  // 超出上限时从最旧的一端丢弃，保证 entries 长度不超过 limit + 1。
  const maxEntries = history.limit + 1;
  const entries = kept.length > maxEntries ? kept.slice(kept.length - maxEntries) : kept;

  return { ...history, entries, index: entries.length - 1 };
}

/**
 * 撤销一步。不能撤销时原样返回（调用方可用 `canUndo()` 先判断）。
 *
 * 注意返回的是历史里**原来那个歌曲对象**，ID 全部保持不变——
 * 这正是 SPEC §7.2 里「撤销还原」不需要换 ID 的原因。
 *
 * @param {History} history
 * @returns {History}
 */
export function undo(history) {
  if (!canUndo(history)) return history;
  return { ...history, index: history.index - 1 };
}

/**
 * 重做一步。不能重做时原样返回。
 * @param {History} history
 * @returns {History}
 */
export function redo(history) {
  if (!canRedo(history)) return history;
  return { ...history, index: history.index + 1 };
}

/**
 * 换一首歌重新开始记录（切换歌曲、导入工程、新建歌曲时使用）。
 *
 * 为什么不把「切换歌曲」也做成可撤销的一步？因为它跨越了歌曲边界，
 * 撤销回去会变成「切回上一首歌」，和用户对「撤销」的预期不符。
 *
 * @param {History} history
 * @param {import('./song.js').Song} song
 * @param {string} [label]
 * @returns {History}
 */
export function resetHistory(history, song, label = '载入歌曲') {
  return { ...createHistory(song, { limit: history.limit, label }), limit: history.limit };
}

/**
 * 当前历史栈里有几步可撤销（界面上可以显示「还可以撤销 N 步」）。
 * @param {History} history
 * @returns {number}
 */
export function undoDepth(history) {
  return history.index;
}

/**
 * 当前历史栈里有多少条记录，供调试与测试使用。
 * @param {History} history
 * @returns {{total: number, index: number, labels: string[]}}
 */
export function describeHistory(history) {
  return {
    total: history.entries.length,
    index: history.index,
    labels: history.entries.map((entry) => entry.label),
  };
}

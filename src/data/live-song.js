/**
 * 曲库里的**唯一**示范曲：《小星星》爵士前奏练习。
 *
 * 用途只有两个：新用户第一次打开时有东西可看可听，以及「智能导入」面板里的
 * 「先试一首示例」按钮。它是**数据**，不是渲染逻辑 —— 每一处画面都来自这里。
 *
 * ## 为什么是这一首
 *
 * - 旋律是公有领域的儿歌，人人认得，一看就知道谱面在表达什么。
 * - 和弦只用了本版**支持**的三种性质：`maj7` / `m7` / `7`。
 *   刻意不写 `9` `6` `ø` 这些本版没有的后缀 —— 一份示范曲里出现解析不了的和弦，
 *   等于把「这软件能干什么」讲错了。
 * - 调号 C 大调、4/4、96 BPM：最普通的设置，改起来不费劲。
 * - 旋律每个音符都带一个字的歌词，所以 `bar.melody[].lyric` 直接构成逐字对齐
 *   （SPEC §8.9）。不需要另外写 `bar.lyrics` —— 那是「只有和弦、没有简谱」时的
 *   对齐方式，两种机制同时写会打架。
 *
 * ## 时值
 *
 * 每小节的和弦事件与旋律音符**都**必须正好填满 4 拍：`collectDurationIssues()`
 * 对两者分别求和，任何一边不对，「试听」会直接拒绝播放。所以这里不省略任何时值，
 * 也不依赖自动均分（`1 1 1 2` 这种「三个四分音符 + 一个二分音符」的写法，
 * 均分是分不出来的）。
 *
 * @module data/live-song
 */

import { createSong } from '../core/song.js';
import { parseChordSymbol } from '../core/chord.js';

/**
 * 构造一个和弦事件。解析失败直接抛异常 —— 这是**我们自己的**数据，
 * 写错和弦名属于编程错误，应该在开发时立刻炸掉，而不是安静地少一个和弦。
 *
 * @param {string} symbol 和弦名，例如 'Cmaj7'、'G7'
 * @param {number} beats 时值（拍）
 */
function chord(symbol, beats) {
  const parsed = parseChordSymbol(symbol);
  if (!parsed.ok) throw new Error(`示范曲里的和弦 ${symbol} 无法解析：${parsed.message}`);
  return { kind: 'chord', beats, chord: parsed.value };
}

/**
 * 构造一个旋律音符。
 *
 * @param {number} pitch MIDI 音高（C4 = 60）
 * @param {number} beats 时值（拍）
 * @param {string} lyric 这一个音对应的**一个字**
 */
function note(pitch, beats, lyric) {
  return { pitch, beats, lyric, tie: false };
}

/**
 * 构造一个小节。
 *
 * @param {Array<{kind: string, beats: number, chord?: object}>} events 和弦事件
 * @param {Array<object>} [melody] 旋律音符；不给就是「只有和弦」的小节
 */
function bar(events, melody = []) {
  return { type: 'chords', events, ...(melody.length ? { melody } : {}) };
}

/**
 * 创建《小星星》爵士前奏练习。
 *
 * 结构：4 小节前奏 + 12 小节主题（6 句，每句 2 小节），共 16 小节。
 * 主题的时值就是儿歌本来的样子：一句里前一小节四个四分音符，
 * 后一小节「四分、四分、二分」。前奏只有和弦，最后停在 `G7` 上把主题领进来。
 *
 * @returns {import('../core/song.js').Song}
 */
export function createLiveDemo() {
  return createSong({
    title: '小星星（爵士前奏练习）',
    artist: '儿歌 · 爵士改编示例',
    key: { tonic: 'C', mode: 'major' },
    capo: 0,
    bpm: 96,
    timeSignature: '4/4',
    timing: 'exact',
    style: '爵士 · 大七和弦铺底',
    notes: '示例数据，可直接删除。前奏走 Cmaj7 / Am7 / Dm7 / G7 的爵士进行；主题旋律每个音对齐一个字。',
    layout: {
      barsPerRow: 4,
      displayLines: ['chord', 'degree'],
      showMelody: true,
      lyricScale: 1.2,
      numberedKey: 'C',
    },
    sections: [
      {
        name: '前奏',
        repeat: 1,
        cue: '大七和弦铺底，最后一小节停在 G7 领进主题',
        bars: [
          bar([chord('Cmaj7', 4)]),
          bar([chord('Am7', 4)]),
          bar([chord('Dm7', 2), chord('G7', 2)]),
          bar([chord('Cmaj7', 2), chord('G7', 2)]),
        ],
      },
      {
        name: '主题',
        repeat: 1,
        cue: '儿歌旋律，每个音一个字；和弦走爵士进行',
        bars: [
          // 一闪一闪亮晶晶
          bar([chord('Cmaj7', 4)], [note(60, 1, '一'), note(60, 1, '闪'), note(67, 1, '一'), note(67, 1, '闪')]),
          bar([chord('Am7', 4)], [note(69, 1, '亮'), note(69, 1, '晶'), note(67, 2, '晶')]),
          // 满天都是小星星
          bar([chord('Dm7', 4)], [note(65, 1, '满'), note(65, 1, '天'), note(64, 1, '都'), note(64, 1, '是')]),
          bar([chord('G7', 4)], [note(62, 1, '小'), note(62, 1, '星'), note(60, 2, '星')]),
          // 挂在天上放光明
          bar([chord('Cmaj7', 4)], [note(67, 1, '挂'), note(67, 1, '在'), note(65, 1, '天'), note(65, 1, '上')]),
          bar([chord('Am7', 4)], [note(64, 1, '放'), note(64, 1, '光'), note(62, 2, '明')]),
          // 好像许多小眼睛
          bar([chord('Fmaj7', 4)], [note(67, 1, '好'), note(67, 1, '像'), note(65, 1, '许'), note(65, 1, '多')]),
          bar([chord('G7', 4)], [note(64, 1, '小'), note(64, 1, '眼'), note(62, 2, '睛')]),
          // 一闪一闪亮晶晶
          bar([chord('Cmaj7', 4)], [note(60, 1, '一'), note(60, 1, '闪'), note(67, 1, '一'), note(67, 1, '闪')]),
          bar([chord('Am7', 4)], [note(69, 1, '亮'), note(69, 1, '晶'), note(67, 2, '晶')]),
          // 满天都是小星星（末句收在 Cmaj7 上）
          bar([chord('Dm7', 4)], [note(65, 1, '满'), note(65, 1, '天'), note(64, 1, '都'), note(64, 1, '是')]),
          bar([chord('G7', 2), chord('Cmaj7', 2)], [note(62, 1, '小'), note(62, 1, '星'), note(60, 2, '星')]),
        ],
      },
    ],
  });
}

export default createLiveDemo;

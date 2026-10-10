/**
 * 虚构示例歌曲：《候鸟信》
 *
 * 这是一首**完全虚构**的示例，用于开发、演示和测试，不涉及任何真实作品。
 *
 * 本文件同时提供两种形式：
 * - `SAMPLE_SONG_TEXT`：用户在文本框里输入的功能谱文本（docs/SPEC.md §4 语法）。
 * - `SAMPLE_SONG`：等价的歌曲数据结构。
 *
 * 两者必须表达同一首曲子。`tests/parser.test.js` 里的
 * 「示例文本解析出来与示例数据结构完全一致」就是这条约束的检查：
 * 它以 `SAMPLE_SONG` 为基底解析 `SAMPLE_SONG_TEXT`，再逐段落、逐小节、
 * 逐事件比对类型、时值、和弦与继承来的 `repeat` / `cue`。
 * 文本和数据任何一边被改动而没有同步，那条测试就会红。
 *
 * 音乐设定：C 大调，4/4，BPM 96，共 5 个段落 32 小节。
 *
 * 示例歌曲刻意覆盖了本版支持的**全部 9 种和弦性质**，以及斜杠低音、休止和空白小节。
 * 这样它既是演示，也是 fixture：解析器、级数显示、导出只要在任何一种性质上出问题，
 * 都会在这里立刻暴露。
 *
 * @module data/sample-song
 */

/**
 * 示例歌曲的输入文本。
 * 换行等价于小节分隔符 `|`，因此每一行就是一个（或若干）完整小节。
 * 所有时值都显式写出，避免依赖自动均分。
 */
export const SAMPLE_SONG_TEXT = `[Intro]
C:4 | Am:4 | F:2 G:2 | C:4

[Verse]
C:2 G/B:2 | Am7:4 | F:2 G:2 | C:4
Am:2 Em:2 | F:4 | Dm7:2 G:2 | C:4

[Chorus]
F:4 | G:4 | Em7:4 | Am:4
F:4 | G:4 | C:4 | C:4

[Bridge]
Dm7:2 G7:2 | Cmaj7:4 | Asus4:2 A:2 | Dm7:2 G:2
Caug:2 Am:2 | Fmaj7:2 F#dim:2 | Csus2:2 C:2 | G7:4

[Outro]
F:2 G:2 | C:4 | 0 | C:2 R:2
`;

/**
 * @typedef {import('../core/chord.js').Chord} Chord
 * @typedef {import('../core/song.js').Song} Song
 */

/** 和弦字面量的简写，仅用于本文件的示例数据，让 fixture 保持可读。 */
const CHORD_C = { root: 'C', quality: 'maj', bass: null };
const CHORD_AM = { root: 'A', quality: 'm', bass: null };
const CHORD_F = { root: 'F', quality: 'maj', bass: null };
const CHORD_G = { root: 'G', quality: 'maj', bass: null };
const CHORD_G_OVER_B = { root: 'G', quality: 'maj', bass: 'B' };
const CHORD_A = { root: 'A', quality: 'maj', bass: null };
const CHORD_AM7 = { root: 'A', quality: 'm7', bass: null };
const CHORD_EM = { root: 'E', quality: 'm', bass: null };
const CHORD_DM7 = { root: 'D', quality: 'm7', bass: null };
const CHORD_EM7 = { root: 'E', quality: 'm7', bass: null };
const CHORD_G7 = { root: 'G', quality: '7', bass: null };
const CHORD_CMAJ7 = { root: 'C', quality: 'maj7', bass: null };
const CHORD_FMAJ7 = { root: 'F', quality: 'maj7', bass: null };
const CHORD_ASUS4 = { root: 'A', quality: 'sus4', bass: null };
const CHORD_CSUS2 = { root: 'C', quality: 'sus2', bass: null };
const CHORD_CAUG = { root: 'C', quality: 'aug', bass: null };
const CHORD_F_SHARP_DIM = { root: 'F#', quality: 'dim', bass: null };

/**
 * 构造一个和弦事件。ID 显式给出，让示例数据是稳定、可复现的。
 * @param {string} id
 * @param {Chord} chord
 * @param {number} beats
 */
function chordEvent(id, chord, beats) {
  return { kind: 'chord', id, beats, chord };
}

/**
 * 构造一个休止事件。
 * @param {string} id
 * @param {number} beats
 */
function restEvent(id, beats) {
  return { kind: 'rest', id, beats };
}

/**
 * 构造一个空白小节（不是休止）。
 * @param {string} id
 */
function emptyBar(id) {
  return { id, type: 'empty', events: [] };
}

/**
 * 构造一个含事件的小节。
 * @param {string} id
 * @param {import('../core/song.js').SongEvent[]} events
 */
function bar(id, events) {
  return { id, type: 'chords', events };
}

/**
 * 示例歌曲的数据结构。
 *
 * @type {Song}
 */
export const SAMPLE_SONG = {
  schemaVersion: 3,
  id: 'sng_sample0001',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:30:00.000Z',
  title: '候鸟信',
  artist: '虚构示例乐队',
  notes: '排练用功能谱。示例数据，可直接删除。',
  key: { tonic: 'C', mode: 'major' },
  bpm: 96,
  timeSignature: '4/4',
  style: '清音 + 轻混响',
  sections: [
    {
      id: 'sec_intro',
      name: 'Intro',
      repeat: 1,
      cue: '清音扫弦入场，弱起',
      bars: [
        bar('bar_intro_1', [chordEvent('evt_intro_1_1', CHORD_C, 4)]),
        bar('bar_intro_2', [chordEvent('evt_intro_2_1', CHORD_AM, 4)]),
        bar('bar_intro_3', [
          chordEvent('evt_intro_3_1', CHORD_F, 2),
          chordEvent('evt_intro_3_2', CHORD_G, 2),
        ]),
        bar('bar_intro_4', [chordEvent('evt_intro_4_1', CHORD_C, 4)]),
      ],
    },
    {
      id: 'sec_verse',
      name: 'Verse',
      repeat: 2,
      cue: '主歌收着唱，鼓刷',
      bars: [
        bar('bar_verse_1', [
          chordEvent('evt_verse_1_1', CHORD_C, 2),
          chordEvent('evt_verse_1_2', CHORD_G_OVER_B, 2),
        ]),
        bar('bar_verse_2', [chordEvent('evt_verse_2_1', CHORD_AM7, 4)]),
        bar('bar_verse_3', [
          chordEvent('evt_verse_3_1', CHORD_F, 2),
          chordEvent('evt_verse_3_2', CHORD_G, 2),
        ]),
        bar('bar_verse_4', [chordEvent('evt_verse_4_1', CHORD_C, 4)]),
        bar('bar_verse_5', [
          chordEvent('evt_verse_5_1', CHORD_AM, 2),
          chordEvent('evt_verse_5_2', CHORD_EM, 2),
        ]),
        bar('bar_verse_6', [chordEvent('evt_verse_6_1', CHORD_F, 4)]),
        bar('bar_verse_7', [
          chordEvent('evt_verse_7_1', CHORD_DM7, 2),
          chordEvent('evt_verse_7_2', CHORD_G, 2),
        ]),
        bar('bar_verse_8', [chordEvent('evt_verse_8_1', CHORD_C, 4)]),
      ],
    },
    {
      id: 'sec_chorus',
      name: 'Chorus',
      repeat: 1,
      cue: '副歌放开，全鼓进',
      bars: [
        bar('bar_chorus_1', [chordEvent('evt_chorus_1_1', CHORD_F, 4)]),
        bar('bar_chorus_2', [chordEvent('evt_chorus_2_1', CHORD_G, 4)]),
        bar('bar_chorus_3', [chordEvent('evt_chorus_3_1', CHORD_EM7, 4)]),
        bar('bar_chorus_4', [chordEvent('evt_chorus_4_1', CHORD_AM, 4)]),
        bar('bar_chorus_5', [chordEvent('evt_chorus_5_1', CHORD_F, 4)]),
        bar('bar_chorus_6', [chordEvent('evt_chorus_6_1', CHORD_G, 4)]),
        bar('bar_chorus_7', [chordEvent('evt_chorus_7_1', CHORD_C, 4)]),
        bar('bar_chorus_8', [chordEvent('evt_chorus_8_1', CHORD_C, 4)]),
      ],
    },
    {
      id: 'sec_bridge',
      name: 'Bridge',
      repeat: 1,
      cue: '桥段转调感；第 5 小节的增和弦只是过门，第 7 小节挂二留到下一拍解决',
      bars: [
        bar('bar_bridge_1', [
          chordEvent('evt_bridge_1_1', CHORD_DM7, 2),
          chordEvent('evt_bridge_1_2', CHORD_G7, 2),
        ]),
        bar('bar_bridge_2', [chordEvent('evt_bridge_2_1', CHORD_CMAJ7, 4)]),
        bar('bar_bridge_3', [
          chordEvent('evt_bridge_3_1', CHORD_ASUS4, 2),
          chordEvent('evt_bridge_3_2', CHORD_A, 2),
        ]),
        bar('bar_bridge_4', [
          chordEvent('evt_bridge_4_1', CHORD_DM7, 2),
          chordEvent('evt_bridge_4_2', CHORD_G, 2),
        ]),
        bar('bar_bridge_5', [
          chordEvent('evt_bridge_5_1', CHORD_CAUG, 2),
          chordEvent('evt_bridge_5_2', CHORD_AM, 2),
        ]),
        bar('bar_bridge_6', [
          chordEvent('evt_bridge_6_1', CHORD_FMAJ7, 2),
          chordEvent('evt_bridge_6_2', CHORD_F_SHARP_DIM, 2),
        ]),
        bar('bar_bridge_7', [
          chordEvent('evt_bridge_7_1', CHORD_CSUS2, 2),
          chordEvent('evt_bridge_7_2', CHORD_C, 2),
        ]),
        bar('bar_bridge_8', [chordEvent('evt_bridge_8_1', CHORD_G7, 4)]),
      ],
    },
    {
      id: 'sec_outro',
      name: 'Outro',
      repeat: 1,
      cue: '渐弱收尾；第 3 小节留白，第 4 小节末两拍停手',
      bars: [
        bar('bar_outro_1', [
          chordEvent('evt_outro_1_1', CHORD_F, 2),
          chordEvent('evt_outro_1_2', CHORD_G, 2),
        ]),
        bar('bar_outro_2', [chordEvent('evt_outro_2_1', CHORD_C, 4)]),
        // 空白小节：整小节留白，谱面保留正常宽度。注意它和休止不是一回事。
        emptyBar('bar_outro_3'),
        // 休止：这一小节前半有和弦，后半是明确标注的静音。
        bar('bar_outro_4', [
          chordEvent('evt_outro_4_1', CHORD_C, 2),
          restEvent('evt_outro_4_2', 2),
        ]),
      ],
    },
  ],
  layout: {
    barsPerRow: 4,
    displayLines: ['chord'],
    fontScale: 1,
  },
};

export default SAMPLE_SONG;

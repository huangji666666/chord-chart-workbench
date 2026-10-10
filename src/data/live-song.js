import { createSong } from '../core/song.js';
import { parseChordSymbol } from '../core/chord.js';

const bar = (chords, lyrics = [], pitches = []) => ({
  type: 'chords',
  events: chords.map((symbol) => ({ kind: 'chord', beats: 4 / chords.length, chord: parseChordSymbol(symbol).value })),
  ...(lyrics.length ? { lyrics: lyrics.map((text) => ({ text })) } : {}),
  ...(pitches.length ? { melody: pitches.map((pitch, i) => ({ pitch, beats: 4 / pitches.length, lyric: [...lyrics.join('')][i] ?? '' })) } : {}),
});

export function createLiveDemo() {
  return createSong({
    title: '把日子唱成歌', artist: '原创练习曲', capo: 2,
    key: { tonic: 'C', mode: 'major' }, bpm: 76, timeSignature: '4/4',
    notes: '轻轻唱，让每个和弦都有温度。', style: '轻柔分解', timing: 'exact',
    layout: { barsPerRow: 4, displayLines: ['chord', 'degree'], showMelody: false, lyricScale: 1.2, numberedKey: 'C' },
    sections: [
      { name: '前奏', cue: '轻柔分解 · 进入主歌', bars: [bar(['C','Am']), bar(['F','G'])] },
      { name: '主歌', cue: '轻一点，留一点呼吸', bars: [
        bar(['C','G/B'], ['微风经过','窗前'], [64,64,62,60,62,64,67,67]),
        bar(['Am','Em'], ['把故事','轻轻唱'], [69,67,64,64,62,60,62,64]),
        bar(['F','G'], ['星光落在','指间'], [65,65,64,62,67,64,62,62]),
        bar(['C','G'], ['陪我们','到远方'], [64,62,60,60,62,64,67,67]),
      ] },
      { name: '副歌', cue: '稍稍打开，温暖地唱', bars: [
        bar(['F','G'], ['把日子','唱成歌'], [65,65,67,69,67,65,64,62]),
        bar(['Em','Am'], ['把温柔','留心上'], [64,64,67,64,69,67,64,64]),
        bar(['Dm7','G7'], ['沿着有光','的地方'], [62,62,65,65,67,65,64,62]),
        bar(['C','C'], ['慢慢走向','远方'], [64,62,60,62,64,62,60,60]),
      ] },
      { name: '尾奏', cue: '渐弱 · 最后一拍留住', bars: [bar(['F','G']),bar(['C'])] },
    ],
  });
}

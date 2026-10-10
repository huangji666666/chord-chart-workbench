import { Chord, Interval, Note, Scale } from 'tonal';
import { cloneSong, touchSong } from './song.js';
import { formatChordSymbol, parseChordSymbol } from './chord.js';

export const beatSeconds = (song, bpm = song.bpm) => 60 / bpm;
export const quarterFactor = (song) => 4 / Number(song.timeSignature.split('/')[1]);
export const melodyExists = (song) => song.sections.some((s) => s.bars.some((b) => b.melody?.length));

export function transposePitch(pitch, semitones) {
  return Note.pitchClass(Note.transpose(pitch, Interval.fromSemitones(semitones)));
}

export function transposeSong(song, semitones) {
  const result = cloneSong(song);
  result.key.tonic = transposePitch(result.key.tonic, semitones);
  if (result.layout.numberedKey) result.layout.numberedKey = transposePitch(result.layout.numberedKey, semitones);
  for (const item of result.chordDiagrams ?? []) {
    item.chord.root = transposePitch(item.chord.root, semitones);
    if (item.chord.bass) item.chord.bass = transposePitch(item.chord.bass, semitones);
    item.position = 0;
  }
  for (const section of result.sections) for (const bar of section.bars) {
    for (const event of bar.events) if (event.kind === 'chord') {
      event.chord.root = transposePitch(event.chord.root, semitones);
      if (event.chord.bass) event.chord.bass = transposePitch(event.chord.bass, semitones);
    }
    for (const note of bar.melody ?? []) if (note.pitch !== null) note.pitch += semitones;
  }
  return { ok: true, value: touchSong(result) };
}

export function degreeChord(text, key) {
  const normalized = text.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const match = normalized.match(/^([#b]*)([1-7]|[ivIV]+)(.*)$/);
  if (!match) return parseChordSymbol(normalized);
  const roman = ['I','II','III','IV','V','VI','VII'];
  const index = /^\d$/.test(match[2]) ? Number(match[2]) - 1 : roman.indexOf(match[2].toUpperCase());
  if (index < 0) return { ok: false, message: `无法识别级数 ${text}` };
  const scale = Scale.get(`${key.tonic} ${key.mode === 'minor' ? 'minor' : 'major'}`).notes;
  const offset = [...match[1]].reduce((n, c) => n + (c === '#' ? 1 : -1), 0);
  const root = offset ? transposePitch(scale[index], offset) : scale[index];
  const suffix = match[3] || (/^[iv]+$/.test(match[2]) ? 'm' : '');
  return parseChordSymbol(root + suffix);
}

export function chordPitches(chord, capo = 0) {
  const model = Chord.get(formatChordSymbol(chord, { glyphs: false }));
  const pitches = model.notes.slice(0, 6).map((n) => Note.midi(`${n}3`) + capo).filter(Number.isFinite);
  if (chord.bass) pitches.unshift(Note.midi(`${chord.bass}2`) + capo);
  return pitches;
}

export function numberedPitch(pitch, tonic = 'C') {
  if (pitch === null) return { text: '0', octave: 0 };
  const middle = Note.midi(`${tonic}4`);
  const offset = pitch - middle;
  const octave = Math.floor(offset / 12);
  const chroma = ((offset % 12) + 12) % 12;
  const map = ['1','#1','2','#2','3','4','#4','5','#5','6','#6','7'];
  return { text: map[chroma], octave };
}

export function parseNumberedNotes(source, tonic = 'C', beatUnit = 4) {
  const middle = Note.midi(`${tonic}4`);
  const scale = Scale.get(`${tonic} major`).notes;
  return source.trim().split(/\s+/).filter(Boolean).map((token) => {
    const m = token.match(/^([#b]?)([0-7])([',]*)(?:\:([\d.]+))?(?:\/(\d+))?(~)?$/);
    if (!m) throw new Error(`无法识别 ${token}，例如 1:1、3:0.5、5':2、0:1。`);
    const beats = m[4] ? Number(m[4]) : m[5] ? 1 / Number(m[5]) : 1;
    if (!Number.isFinite(beats) || beats <= 0 || beats > 32) throw new Error('时值需要为 0–32 之间的正数。');
    const octave = [...m[3]].reduce((n, c) => n + (c === "'" ? 1 : -1), 0);
    const degreePitch = Number(m[2]) ? Note.midi(`${scale[Number(m[2]) - 1]}4`) : null;
    const base = degreePitch === null ? null : degreePitch < middle ? degreePitch + 12 : degreePitch;
    return { pitch: base === null ? null : base + octave * 12 + (m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0), beats, tie: Boolean(m[6]), lyric: '' };
  });
}

export function notesToText(notes, tonic) {
  return (notes ?? []).map((note) => {
    const n = numberedPitch(note.pitch, tonic);
    return `${n.text}${n.octave > 0 ? "'".repeat(n.octave) : ','.repeat(-n.octave)}:${note.beats}${note.tie ? '~' : ''}`;
  }).join(' ');
}

import { chordPitches, quarterFactor } from '../core/music.js';
import { getBeatsPerBar } from '../core/constants.js';
import { collectDurationIssues } from '../core/duration.js';
import { repeatBarOrder } from '../core/alignment.js';

export function buildTimeline(song, sectionId = null) {
  const bars = [], chords = [], notes = [];
  let cursor = 0;
  const source=song.sections.filter((s)=>!sectionId||s.id===sectionId).flatMap((section)=>Array.from({length:section.repeat},()=>section.bars.map((bar,barIndex)=>({...bar,section,barIndex}))).flat());
  for (const [,entry] of repeatBarOrder(source)) {
      const {section,barIndex,...bar}=entry;
      const length = bar.length ?? getBeatsPerBar(song.timeSignature);
      bars.push({ id: bar.id, sectionId: section.id, sectionName: section.name, barIndex, at: cursor, beats: length });
      let at = cursor;
      for (const [eventIndex, event] of bar.events.entries()) {
        if (event.kind === 'chord') chords.push({ at, beats: event.beats, pitches: chordPitches(event.chord, song.capo ?? 0), sectionId: section.id, barIndex, eventIndex });
        at += event.beats;
      }
      at = cursor;
      for (const [noteIndex, note] of (bar.melody ?? []).entries()) {
        notes.push({ ...note, at, pitch: note.pitch === null ? null : note.pitch + (song.capo ?? 0), sectionId: section.id, barIndex, noteIndex });
        at += note.beats;
      }
      cursor += length;
  }
  return { bars, chords, notes, beats: cursor };
}

export function buildBeatTimeline(timeline) {
  return timeline.bars.flatMap((bar, index) => Array.from({ length: Math.ceil(bar.beats) }, (_, beat) => ({ ...bar, at: bar.at + beat, barAt: bar.at, beat, barNumber: index + 1 })));
}

export function createPlayer({ onPosition = () => {}, onState = () => {}, onBeat = () => {} } = {}) {
  let Tone, transport, harmony, melody, click, volume, clock;
  let song = null, timeline = null, factor = 1;
  let state = { playing: false, paused: false, bpm: 80, loop: false, metronome: false, volume: 0.32, part: '', pattern: 'block', track: 'both', position: '' };
  const notify = () => onState({ ...state });

  async function init() {
    if (!Tone) {
      Tone = await import('tone');
      transport = Tone.getTransport();
      volume = new Tone.Volume(-14).toDestination();
      harmony = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.02, decay: 0.18, sustain: 0.2, release: 0.3 } }).connect(volume);
      melody = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.01, decay: 0.15, sustain: 0.25, release: 0.15 } }).connect(volume);
      click = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 1, envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.03 }, volume: -22 }).connect(volume);
    }
    await Tone.start();
  }

  function stop(notifyState = true) {
    if (transport) { transport.stop(); transport.cancel(); Tone.getDraw().cancel(0); harmony.releaseAll(); melody.triggerRelease(); }
    if (clock) clearInterval(clock);
    clock = null;
    state = { ...state, playing: false, paused: false, position: '' };
    onPosition(null);
    onBeat(null);
    if (notifyState) notify();
  }

  async function play(nextSong, options = {}) {
    if (collectDurationIssues(nextSong).length) throw new Error('先修正小节时值，再开始试听。');
    await init();
    stop(false);
    song = nextSong;
    factor = quarterFactor(song);
    state = { ...state, ...options, bpm: options.bpm ?? song.bpm, playing: true, paused: false };
    timeline = buildTimeline(song, state.part || null);
    transport.bpm.value = state.bpm * factor;
    volume.volume.value = state.volume > 0 ? Tone.gainToDb(state.volume) : -Infinity;
    const tick = (beats) => `${Math.round(beats * factor * transport.PPQ)}i`;
    const seconds = (beats) => beats * 60 / state.bpm;
    if (state.track === 'both' || state.track === 'chords') for (const chord of timeline.chords) {
      transport.schedule((time) => {
        const pitches = chord.pitches.map((p) => Tone.Frequency(p, 'midi').toNote());
        if (!pitches.length) return;
        const duration = Math.max(0.08, seconds(chord.beats) * 0.82);
        if (state.pattern === 'arpeggio') pitches.forEach((pitch, i) => harmony.triggerAttackRelease(pitch, Math.min(duration, 0.8), time + i * seconds(chord.beats) / pitches.length));
        else if (state.pattern === 'strum') pitches.forEach((pitch, i) => harmony.triggerAttackRelease(pitch, duration, time + i * 0.025));
        else harmony.triggerAttackRelease(pitches, duration, time);
      }, tick(chord.at));
    }
    if (state.track === 'both' || state.track === 'melody') {
      for (let index = 0; index < timeline.notes.length; index++) {
        const note = timeline.notes[index];
        if (note.pitch === null || (index > 0 && timeline.notes[index - 1].tie && timeline.notes[index - 1].pitch === note.pitch && Math.abs(timeline.notes[index - 1].at + timeline.notes[index - 1].beats - note.at) < 1e-6)) continue;
        let beats = note.beats;
        let last = note;
        for (let next = index + 1; next < timeline.notes.length && last.tie && timeline.notes[next].pitch === note.pitch && Math.abs(last.at + last.beats - timeline.notes[next].at) < 1e-6; next++) { beats += timeline.notes[next].beats; last = timeline.notes[next]; }
        transport.schedule((time) => melody.triggerAttackRelease(Tone.Frequency(note.pitch, 'midi').toNote(), Math.max(0.07, seconds(beats) * 0.92), time), tick(note.at));
      }
    }
    for (const beat of buildBeatTimeline(timeline)) transport.schedule((time) => {
      if (state.metronome) click.triggerAttackRelease(beat.beat === 0 ? 'C3' : 'G2', '32n', time);
      Tone.getDraw().schedule(() => { if (state.playing) onBeat(beat); }, time);
    }, tick(beat.at));
    transport.loop = state.loop;
    transport.loopStart = 0;
    transport.loopEnd = tick(timeline.beats);
    transport.schedule((time) => { Tone.getDraw().schedule(() => { if (!state.loop) stop(); }, time); }, tick(timeline.beats));
    transport.start();
    clock = setInterval(() => {
      const at = transport.ticks / transport.PPQ / factor;
      const bar = timeline.bars.find((b) => at >= b.at && at < b.at + b.beats);
      const note = timeline.notes.find((n) => at >= n.at && at < n.at + n.beats);
      const chord = timeline.chords.find((c) => at >= c.at && at < c.at + c.beats);
      state.position = bar ? `${bar.sectionName} · ${bar.barIndex + 1}` : '';
      onPosition(bar ? { ...bar, absoluteBeat: at, noteIndex: note?.noteIndex, eventIndex: chord?.eventIndex, progress: timeline.beats ? at / timeline.beats : 0 } : null);
      onState({ ...state });
    }, 100);
    notify();
  }

  return {
    getState: () => ({ ...state }), getTimeline: () => timeline, play, stop,
    pause() { if (!transport || !state.playing) return; transport.pause(); harmony.releaseAll(); melody.triggerRelease(); Tone.getDraw().cancel(0); onBeat(null); state.playing = false; state.paused = true; notify(); },
    resume() { if (!transport || !state.paused) return; transport.start(); state.playing = true; state.paused = false; notify(); },
    setOption(name, value) { state[name] = value; if (name === 'loop' && transport) transport.loop = value; if (name === 'volume' && volume) volume.volume.value = value > 0 ? Tone.gainToDb(value) : -Infinity; if (name === 'bpm' && transport) { transport.bpm.value = value * factor; } notify(); },
    async audition(chord, capo = 0) { await init(); const notes = chordPitches(chord, capo).map((p) => Tone.Frequency(p, 'midi').toNote()); if (notes.length) harmony.triggerAttackRelease(notes, 1.2); },
  };
}

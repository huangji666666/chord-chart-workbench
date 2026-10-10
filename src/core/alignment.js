import { getBeatsPerBar } from './constants.js';

export const clampPosition = (value) => Math.max(0.025, Math.min(0.975, value));
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
export const splitWords = (text) => Array.from(graphemes.segment(String(text ?? '').normalize('NFC')),(part)=>part.segment).filter((c) => !/\s/.test(c));
export function barNumber(song, sectionId, barIndex) {
  let number=song.sections[0]?.bars[0]?.sourceNumber??1;
  for(const section of song.sections){if(section.id===sectionId)return number+barIndex;number+=section.bars.length;}
  return number;
}

/** Coordinates are relative to their own row, so they survive screen/A4 resizing. */
export function defaultAlignment(bar, song) {
  const total = bar.length ?? getBeatsPerBar(song.timeSignature);
  let at = 0;
  const notes = (bar.melody ?? []).map((note) => {
    const position = { x: clampPosition((at + Math.min(1,note.beats) / 2) / total), y: .5 };
    at += note.beats;
    return position;
  });
  const words = [];
  const lineCount=Math.max(1,...(bar.melody??[]).map((note)=>String(note.lyric??'').split('\n').length),...(bar.lyrics??[]).map((lyric)=>String(lyric?.text??'').split('\n').length));
  if(bar.alignment?.words){
    for(const word of bar.alignment.words){
      const siblings=bar.alignment.words.filter((w)=>w.noteIndex!==null && w.noteIndex===word.noteIndex);
      const offset=siblings.indexOf(word)-(siblings.length-1)/2;
      words.push({...word,free:false,x:word.noteIndex===null?word.x:clampPosition(notes[word.noteIndex].x+offset*.035),y:.5});
    }
  } else if (bar.melody?.some((note) => note.lyric)) {
    bar.melody.forEach((note, noteIndex) => {
      String(note.lyric??'').split('\n').forEach((line,row)=>{const letters=splitWords(line);
      letters.forEach((text, i) => words.push({ text, noteIndex, x: clampPosition(notes[noteIndex].x + (i - (letters.length - 1) / 2) * .035), y: (row+.5)/lineCount, scale: 1 }));});
    });
  } else {
    at = 0;
    bar.events.forEach((event, index) => {
      String(bar.lyrics?.[index]?.text??'').split('\n').forEach((line,row)=>{const letters=splitWords(line);
      letters.forEach((text, i) => words.push({ text, noteIndex: null, x: clampPosition((at + event.beats * (i + .5) / letters.length) / total), y: (row+.5)/lineCount, scale: 1 }));});
      at += event.beats;
    });
  }
  return { words, notes, height: Math.min(160,Math.max(48,lineCount*28)) };
}

export function validAlignment(value, bar) {
  const position = (p) => p && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1;
  return value && Number.isFinite(value.height) && value.height >= 28 && value.height <= 160
    && Array.isArray(value.notes) && value.notes.length === (bar.melody?.length ?? 0) && value.notes.every(position)
    && Array.isArray(value.words) && value.words.length <= 1024 && value.words.every((w) => position(w) && (w.free===undefined||typeof w.free==='boolean') && typeof w.text === 'string' && w.text.length <= 100 && Number.isFinite(w.scale) && w.scale >= .6 && w.scale <= 2 && (w.noteIndex === null || Number.isInteger(w.noteIndex) && w.noteIndex >= 0 && w.noteIndex < value.notes.length));
}

export function setBarAlignment(song, sectionId, barIndex, alignment) {
  const section = song.sections.find((s) => s.id === sectionId), bar = section?.bars[barIndex];
  if (!bar || !validAlignment(alignment, bar)) return { ok:false, message:'字与音符的位置或对应关系不合法，未保存。' };
  const next = { ...bar, alignment: structuredClone(alignment) };
  if (next.melody?.length) next.melody = next.melody.map((note, i) => ({ ...note, lyric: alignment.words.filter((w) => w.noteIndex === i).map((w) => w.text).join('') }));
  let at = 0;
  const noteTimes = (next.melody ?? []).map((note) => { const start=at;at+=note.beats;return start; });
  const total = next.length ?? getBeatsPerBar(song.timeSignature);
  at = 0;
  next.lyrics = next.events.map((event, index) => {
    const start=at;at+=event.beats;
    const text=alignment.words.filter((word) => {
      const here=word.noteIndex === null ? word.x * total : noteTimes[word.noteIndex];
      return here >= start && (here < at || index === next.events.length - 1 && here === at);
    }).map((w) => w.text).join('');
    return text ? { text } : null;
  });
  return { ok:true, value:{ ...song, updatedAt:new Date().toISOString(), sections:song.sections.map((s) => s.id === sectionId ? {...s,bars:s.bars.map((b,i) => i === barIndex ? next : b)} : s) } };
}

/** Basic repeat spans and first/second endings; no implicit nested repeats. */
export function repeatBarOrder(bars) {
  const order=[];
  let pending=[];
  for (let i=0;i<bars.length;i++) {
    if (bars[i].repeatStart) { order.push(...pending);pending=[]; }
    pending.push([i,bars[i]]);
    if (bars[i].repeatEnd) {
      for(let pass=1;pass<=bars[i].repeatEnd;pass++) order.push(...pending.filter(([,bar]) => !bar.ending || bar.ending === pass));
      pending=[];
    }
  }
  order.push(...pending);
  return order;
}

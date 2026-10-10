import { button, el, field, input, select, details } from './dom.js';
import { openSheet, toast } from './dialogs.js';
import { parseChordSymbol, formatChordSymbol } from '../core/chord.js';
import { degreeChord, notesToText, parseNumberedNotes } from '../core/music.js';
import { getBeatsPerBar } from '../core/constants.js';
import { eventDisplayLines } from './chart.js';
import * as edit from '../core/edit.js';
import { openBarSheet } from './sheets.js';
import { withIcon } from './icons.js';
import { Key, Note } from 'tonal';
import { openAlignmentEditor } from './alignment-editor.js';
import { defaultAlignment, setBarAlignment, barNumber } from '../core/alignment.js';
import { openChordDiagrams } from './chord-diagrams.js';
import { metaIsSet } from '../core/song.js';

export function openChordEditor(ctx, args) {
  const song=ctx.store.getSong();
  const bar=song.sections.find((s)=>s.id===args.sectionId).bars[args.barIndex];
  const event=bar.events[args.eventIndex];
  const symbol=input({value:event.kind==='chord'?formatChordSymbol(event.chord,{glyphs:false}):'R',ariaLabel:'和弦或级数',placeholder:'例如 Am、G7、6m',focusKey:'quick-chord'});
  const lyrics=el('textarea',{class:'input lyric-editor',rows:'3','aria-label':'这一格歌词',placeholder:'写下这个和弦对应的歌词…'});lyrics.value=bar.lyrics?.[args.eventIndex]?.text??'';
  const beats=input({type:'number',value:event.beats,min:0.0625,max:32,step:0.5,ariaLabel:'和弦时值'});
  const status=el('p',{class:'chord-preview','aria-live':'polite'});
  const error=el('p',{class:'field__error',role:'alert'});
  const parse=()=>/^(R|N\.C\.)$/i.test(symbol.value.trim())?{ok:true,rest:true}:!metaIsSet(song,'key')&&/^[#b]*[1-7ivIV]/.test(symbol.value.trim())?{ok:false,message:'填写歌曲调号后即可使用和弦级数。'}:degreeChord(symbol.value,song.key);
  const refresh=()=>{const parsed=parse();if(!parsed.ok){status.textContent=parsed.message;return;}if(parsed.rest){status.textContent='休止';return;}const display=eventDisplayLines({kind:'chord',chord:parsed.value},{...song,layout:{...song.layout,displayLines:['chord','degree']}});status.textContent=display.lines.map((l)=>l.text).join('  ·  ');};
  symbol.addEventListener('input',refresh);refresh();
  const scale=metaIsSet(song,'key')?(song.key.mode==='minor'?Key.minorKey(song.key.tonic).natural.chords:Key.majorKey(song.key.tonic).chords):['C','G','Am','F','Dm','Em'];
  const suggestions=el('div',{class:'quick-chords'},scale.slice(0,7).map((s)=>button(s,{class:'chord-suggestion',onClick:()=>{symbol.value=s;refresh();}})));
  const diagramDetails=button('查看指法 / 加入和弦图',{variant:'quiet',onClick:()=>{const parsed=parse();if(!parsed.ok||parsed.rest){error.textContent='请先填写一个和弦。';return;}openChordDiagrams(ctx,{chord:parsed.value});}});
  let handle;
  handle=openSheet({title:'编辑和弦与歌词',subtitle:`第 ${barNumber(song,args.sectionId,args.barIndex)} 小节 · 第 ${args.eventIndex+1} 格`,body:el('div',{class:'compact-form'},[
    field({label:'和弦 / 级数',control:symbol}),suggestions,status,field({label:'歌词',control:lyrics}),
    el('div',{class:'chord-extra'},[withIcon(button('试听和弦',{variant:'quiet',onClick:async()=>{const parsed=parse();if(!parsed.ok){error.textContent=parsed.message;return;}if(!parsed.rest)try{await ctx.player.audition(parsed.value,song.capo??0);}catch(e){error.textContent=e.message;}}}),'play'),button('小节操作',{variant:'quiet',onClick:()=>{handle.close(null);openBarSheet(ctx,args);}})]),
    button('逐字与简谱对齐',{onClick:()=>{handle.close(null);openAlignmentEditor(ctx,args.sectionId,args.barIndex);}}),
    diagramDetails,details('节奏与时值',field({label:'拍数',control:beats,hint:`这小节共 ${bar.length??getBeatsPerBar(song.timeSignature)} 拍`})),error,
  ]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('完成',{variant:'primary',onClick:()=>{
    const parsed=parse();if(!parsed.ok){error.textContent=parsed.message;return;}
    const result=ctx.store.run('修改和弦与歌词',(current)=>{const res=edit.updateEvent(current,args.sectionId,args.barIndex,args.eventIndex,{kind:parsed.rest?'rest':'chord',beats:Number(beats.value),...(parsed.rest?{}:{chord:parsed.value})});return res.ok?edit.setEventLyric(res.value,args.sectionId,args.barIndex,args.eventIndex,lyrics.value):res;});
    if(!result.ok){error.textContent=result.message;return;}handle.close(null);
  }})]});
}

export function openMelodyEditor(ctx, sectionId, barIndex) {
  const song=ctx.store.getSong();
  const bar=song.sections.find((s)=>s.id===sectionId).bars[barIndex];
  const tonic=song.layout.numberedKey??song.key.tonic;
  const notes=el('textarea',{class:'input import-text',rows:'4','aria-label':'小节简谱',placeholder:"例如：3:1 2:1 1:1 6,:1"});notes.value=notesToText(bar.melody,tonic);
  const words=input({value:(bar.melody??[]).filter((n)=>n.pitch!==null).map((n)=>n.lyric||'_').join(' '),ariaLabel:'简谱对应歌词',placeholder:'每个字用空格分开，_ 表示这个音符不填词'});
  const error=el('p',{class:'field__error',role:'alert'});
  let handle;
  handle=openSheet({title:'编辑旋律简谱',subtitle:`第 ${barNumber(song,sectionId,barIndex)} 小节 · 1=${tonic}`,body:el('div',{class:'compact-form'},[
    field({label:'音符 : 拍数',control:notes}),el('p',{class:'notice',text:"1–7 为音符，0 为休止；' 升八度，, 降八度；3:0.5 是半拍，3:1.5 是附点拍；~ 连到下一个同音。"}),field({label:'对应歌词',control:words}),
    button('放大逐字对齐',{onClick:()=>{handle.close(null);openAlignmentEditor(ctx,sectionId,barIndex);}}),el('p',{class:'field__hint',text:'整段重写音符后会重新自动对齐；保留位置微调请用逐字对齐。'}),error,
  ]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('保存简谱',{variant:'primary',onClick:()=>{
    try{
      const melody=notes.value.trim()?parseNumberedNotes(notes.value,tonic):[];
      const lyrics=words.value.trim().split(/\s+/);
      let lyricIndex=0;
      for(const note of melody){if(note.pitch!==null){const text=lyrics[lyricIndex++]??'';note.lyric=text==='_'?'':text;}else note.lyric='';}
      const total=melody.reduce((n,note)=>n+note.beats,0),expected=bar.length??getBeatsPerBar(song.timeSignature);
      if(melody.length&&Math.abs(total-expected)>1e-6)throw new Error(`音符共 ${total} 拍，这个小节需要 ${expected} 拍。`);
      const result=ctx.store.run('修改简谱',(current)=>{
        const next={...current,sections:current.sections.map((section)=>section.id===sectionId?{...section,bars:section.bars.map((b,index)=>index===barIndex?{...b,melody,alignment:undefined}:b)}:section),layout:{...current.layout,showMelody:true}};
        const updated=next.sections.find((s)=>s.id===sectionId).bars[barIndex];
        return setBarAlignment(next,sectionId,barIndex,defaultAlignment(updated,next));
      });
      if(!result.ok)throw new Error(result.message);handle.close(null);
    }catch(e){error.textContent=e.message;}
  }})]});
}

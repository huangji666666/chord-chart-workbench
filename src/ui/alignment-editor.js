import { button, el, field, input, select } from './dom.js';
import { openSheet, toast } from './dialogs.js';
import { defaultAlignment, setBarAlignment, clampPosition, splitWords, barNumber } from '../core/alignment.js';
import { numberedPitch, parseNumberedNotes, notesToText } from '../core/music.js';
import { getBeatsPerBar } from '../core/constants.js';
import { attachPositionDrag } from './position.js';

export function openAlignmentEditor(ctx, sectionId, barIndex, initial={kind:'word',index:0}) {
  const song=ctx.store.getSong(),section=song.sections.find((s)=>s.id===sectionId),original=section?.bars[barIndex];
  if(!original)return;
  const bar=structuredClone(original);
  let alignment=structuredClone(bar.alignment??defaultAlignment(bar,song)),selected=initial,zoom=1.5,handle;
  const tonic=song.layout.numberedKey??song.key.tonic;
  const board=el('div',{class:'alignment-board'}),controls=el('div',{class:'alignment-inspector'}),error=el('p',{class:'field__error',role:'alert'});
  const viewport=el('div',{class:'alignment-viewport',tabindex:0,'aria-label':'放大的歌词与简谱，可左右滚动'},[board]);
  const noteLabel=(note)=>{const pitch=numberedPitch(note.pitch,tonic);return pitch.text+(pitch.octave>0?'·'.repeat(pitch.octave):pitch.octave<0?'̣'.repeat(-pitch.octave):'');};
  const saveDraft=(current)=>{
    const next={...current,sections:current.sections.map((s)=>s.id===sectionId?{...s,bars:s.bars.map((b,i)=>i===barIndex?{...b,melody:bar.melody??[],showMelody:bar.showMelody,repeatStart:bar.repeatStart,repeatEnd:bar.repeatEnd,ending:bar.ending}:b)}:s)};
    return setBarAlignment(next,sectionId,barIndex,alignment);
  };
  function inspector(){
    const entry=selected.kind==='note'?alignment.notes[selected.index]:alignment.words[selected.index];
    controls.replaceChildren();
    if(!entry){controls.append(el('p',{class:'notice',text:'点一个字或音符，再拖动或微调。'}));return;}
    const isNote=selected.kind==='note';
    const heading=el('strong',{text:isNote?'第 '+(selected.index+1)+' 个音符':'第 '+(selected.index+1)+' 个字'});
    const text=input({value:isNote?notesToText([bar.melody[selected.index]],tonic).split(':')[0]:entry.text,ariaLabel:isNote?'选中音符音高':'选中字的内容'});
    text.addEventListener('input',()=>{
      try{if(isNote){const parsed=parseNumberedNotes(text.value+':'+bar.melody[selected.index].beats,tonic);bar.melody[selected.index].pitch=parsed[0].pitch;}else entry.text=text.value;error.textContent='';paint();}catch(e){error.textContent=e.message;}
    });
    const x=input({type:'number',value:Math.round(entry.x*1000)/10,min:0,max:100,step:.5,ariaLabel:'选中项水平位置'});
    const y=input({type:'number',value:Math.round(entry.y*1000)/10,min:0,max:100,step:.5,ariaLabel:'选中项垂直位置'});
    const update=()=>{if(!Number.isFinite(Number(x.value))||!Number.isFinite(Number(y.value)))return;entry.x=clampPosition(Number(x.value)/100);entry.y=clampPosition(Number(y.value)/100);paint();};
    x.addEventListener('input',update);y.addEventListener('input',update);
    controls.append(heading,field({label:isNote?'音高（可含升降号、八度点）':'文字',control:text}),el('div',{class:'field-pair'},[field({label:'水平 / %',control:x}),field({label:'垂直 / %',control:y})]));
    if(isNote){
      const beats=input({type:'number',value:bar.melody[selected.index].beats,min:.0625,max:32,step:.25,ariaLabel:'选中音符时值'});
      beats.addEventListener('input',()=>{bar.melody[selected.index].beats=Number(beats.value);paint();});
      controls.append(field({label:'时值 / 拍',control:beats}));
    }else{
      const mapping=select({value:entry.noteIndex??'',ariaLabel:'歌词对应音符',options:[{value:'',label:'未对应 / 自由位置'},...(bar.melody??[]).map((note,i)=>({value:i,label:`${i+1} · ${noteLabel(note)} · ${note.beats} 拍`}))],onChange:(value)=>{entry.noteIndex=value===''?null:Number(value);inspector();}});
      const scale=input({type:'number',value:entry.scale,min:.6,max:2,step:.1,ariaLabel:'单字字号比例'});
      scale.addEventListener('input',()=>{entry.scale=Number(scale.value);paint();});
      const free=el('input',{type:'checkbox',checked:Boolean(entry.free),'aria-label':'在整个小节内自由放置'});
      free.addEventListener('change',()=>{entry.free=free.checked;entry.y=entry.free ? .85 : .5;paint();inspector();});
      controls.append(el('div',{class:'field-pair'},[field({label:'对应音符',control:mapping}),field({label:'字号比例',control:scale})]),el('div',{class:'alignment-word-actions'},[
        button('对齐到音符',{disabled:entry.noteIndex===null,onClick:()=>{entry.x=alignment.notes[entry.noteIndex].x;paint();inspector();}}),
        button('拆成单字',{disabled:splitWords(entry.text).length<2,onClick:()=>{const letters=splitWords(entry.text).map((text,i)=>({...entry,text,x:clampPosition(entry.x+i*.04)}));alignment.words.splice(selected.index,1,...letters);paint();inspector();}}),
        button('删除这个字',{onClick:()=>{alignment.words.splice(selected.index,1);selected.index=Math.max(0,selected.index-1);paint();inspector();}}),
      ]));
      controls.append(el('label',{class:'practice-choice'},[free,'允许移到和弦、简谱区域']));
      if(entry.free)controls.append(el('p',{class:'field__hint',text:'自由模式的坐标相对于整个小节；保存后，也可直接在谱面上拖动这个字。'}));
      const targets=song.sections.flatMap((s)=>s.bars.map((b,i)=>({sectionId:s.id,index:i,label:`${s.name} · 第 ${barNumber(song,s.id,i)} 小节`}))).filter((t)=>t.sectionId!==sectionId||t.index!==barIndex);
      if(targets.length){
        const destination=select({value:0,ariaLabel:'移动歌词到小节',options:targets.map((t,i)=>({value:i,label:t.label}))});
        controls.append(field({label:'字放错小节了',control:destination}),button('移动到这个小节',{onClick:()=>{
          const target=targets[Number(destination.value)];
          const moved={...entry,noteIndex:null,x:.5,y:.5};alignment.words.splice(selected.index,1);
          const result=ctx.store.run('移动歌词到另一小节',(current)=>{
            const source=saveDraft(current);if(!source.ok)return source;
            const destinationBar=source.value.sections.find((s)=>s.id===target.sectionId).bars[target.index];
            const next=structuredClone(destinationBar.alignment??defaultAlignment(destinationBar,source.value));next.words.push(moved);
            return setBarAlignment(source.value,target.sectionId,target.index,next);
          });
          if(!result.ok){alignment.words.splice(selected.index,0,entry);error.textContent=result.message;return;}
          const last=ctx.store.getSong().sections.find((s)=>s.id===target.sectionId).bars[target.index].alignment.words.length-1;
          handle.close(null);openAlignmentEditor(ctx,target.sectionId,target.index,{kind:'word',index:last});
        }}));
      }
    }
    controls.append(el('p',{class:'field__hint',text:'拖动调整位置；方向键微调，Shift + 方向键精调。位置变化不改音符时值。'}));
  }
  function paint(){
    board.style.width=(640*zoom)+'px';board.replaceChildren();
    const draw=(kind,items,height)=>{
      const row=el('div',{class:'alignment-row alignment-row--'+kind,style:`height:${height*zoom}px`,'aria-label':kind==='note'?'可拖动简谱音符':'可拖动歌词'});
      items.forEach((entry,index)=>{
        const node=button('',{class:'alignment-token'+(selected.kind===kind&&selected.index===index?' is-selected':''),ariaLabel:kind==='note'?'调整第 '+(index+1)+' 个音符':'选择歌词 '+entry.text,onClick:()=>{selected={kind,index};paint();inspector();}});
        node.style.cssText=`left:${entry.x*100}%;top:${entry.y*100}%;font-size:${(kind==='word'?entry.scale:1)*22*zoom}px`;
        if(kind==='note')node.append(el('span',{text:noteLabel(bar.melody[index])}),el('small',{text:bar.melody[index].beats+' 拍'}));else node.textContent=entry.text;
        attachPositionDrag(node,entry,()=>entry.free?board.getBoundingClientRect():row.getBoundingClientRect(),(position,keyboard)=>{Object.assign(entry,position);selected={kind,index};paint();inspector();if(keyboard)board.querySelector('.is-selected')?.focus();});
        (entry.free?board:row).append(node);
      });
      board.append(row);
    };
    let at=0;
    const chords=el('div',{class:'alignment-chords'});
    bar.events.forEach((event)=>{const x=at/(bar.length??getBeatsPerBar(song.timeSignature));at+=event.beats;chords.append(el('span',{text:event.kind==='chord'?event.chord.root+(event.chord.quality==='maj'?'':event.chord.quality):'休止',style:`left:${x*100}%`}));});
    board.append(chords);
    if(alignment.notes.length)draw('note',alignment.notes,86);
    draw('word',alignment.words,Math.max(60,alignment.height));
  }
  const show=el('input',{type:'checkbox',checked:bar.showMelody!==false,'aria-label':'这个小节显示简谱'});show.addEventListener('change',()=>{bar.showMelody=show.checked;});
  const repeatStart=el('input',{type:'checkbox',checked:Boolean(bar.repeatStart),'aria-label':'反复起点'});repeatStart.addEventListener('change',()=>{bar.repeatStart=repeatStart.checked;});
  const repeatEnd=select({value:bar.repeatEnd??'',ariaLabel:'反复终点次数',options:[{value:'',label:'无反复终点'},...[2,3,4,5,6,7,8].map((n)=>({value:n,label:'反复 '+n+' 次'}))],onChange:(v)=>{bar.repeatEnd=v?Number(v):undefined;}});
  const ending=select({value:bar.ending??'',ariaLabel:'跳房子结尾',options:[{value:'',label:'普通小节'},{value:1,label:'第一结尾'},{value:2,label:'第二结尾'}],onChange:(v)=>{bar.ending=v?Number(v):undefined;}});
  const height=input({type:'range',value:alignment.height,min:28,max:160,step:4,ariaLabel:'歌词行高度'});height.addEventListener('input',()=>{alignment.height=Number(height.value);paint();});
  handle=openSheet({title:'逐字与简谱对齐',subtitle:`${section.name} · 第 ${barNumber(song,sectionId,barIndex)} 小节`,body:el('div',{class:'alignment-editor'},[
    el('div',{class:'alignment-actions'},[
      field({label:'放大',control:select({value:zoom,ariaLabel:'对齐画面放大',options:[1,1.5,2,3].map((n)=>({value:n,label:n*100+'%'})),onChange:(v)=>{zoom=Number(v);paint();}})}),
      button('添加一个字',{onClick:()=>{alignment.words.push({text:'字',noteIndex:null,x:.5,y:.5,scale:1});selected={kind:'word',index:alignment.words.length-1};paint();inspector();}}),
      button('自动对齐',{onClick:()=>{const synced=saveDraft(song);const current=synced.ok?synced.value.sections.find((s)=>s.id===sectionId).bars[barIndex]:bar;alignment=defaultAlignment(current,song);paint();inspector();}}),
    ]),viewport,controls,
    field({label:'歌词行高度',control:height}),
    el('div',{class:'field-pair'},[field({label:'反复终点',control:repeatEnd}),field({label:'跳房子',control:ending})]),
    el('div',{class:'playback-switches'},[el('label',{},[show,'本小节简谱']),el('label',{},[repeatStart,'反复起点'])]),error,
  ]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('保存对齐',{variant:'primary',onClick:()=>{
    const total=(bar.melody??[]).reduce((sum,note)=>sum+note.beats,0),expected=bar.length??getBeatsPerBar(song.timeSignature);
    if(bar.melody?.length&&Math.abs(total-expected)>1e-6){error.textContent=`音符共 ${total} 拍，小节需 ${expected} 拍。请修改时值后保存。`;return;}
    const result=ctx.store.run('调整歌词与简谱',saveDraft);if(!result.ok){error.textContent=result.message;return;}handle.close(null);toast('已保存字与音符的位置',{type:'success'});
  }})]});
  handle.element.classList.add('modal--alignment');paint();inspector();
}

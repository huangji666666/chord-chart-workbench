import { el } from './dom.js';
import { numberedPitch, quarterFactor } from '../core/music.js';
import { Note } from 'tonal';
import { defaultAlignment } from '../core/alignment.js';

let engine;
const pending = new WeakMap();

export function melodyRow(bar, ctx) {
  if (!ctx.song.layout.showMelody || !bar.melody?.length) return null;
  const tonic = ctx.song.layout.numberedKey ?? ctx.song.key.tonic;
  const wrapper = el(ctx.editable ? 'button' : 'div', {
    class: 'bar__melody', type: ctx.editable ? 'button' : null,
    'aria-label': ctx.editable ? `编辑第 ${ctx.number ?? ctx.barIndex + 1} 小节简谱` : '旋律简谱',
    dataset: { melodyBar: bar.id },
    onClick: ctx.editable && ctx.onMelody ? () => ctx.onMelody(ctx.sectionId, ctx.barIndex) : null,
  });
  wrapper.append(el('span', { class: 'melody-fallback', text: bar.melody.map((n) => { const p=numberedPitch(n.pitch,tonic);return p.text+(p.octave>0?'·'.repeat(p.octave):p.octave<0?'̣'.repeat(-p.octave):''); }).join('  ') }));
  const task = new Promise((resolve) => queueMicrotask(async () => {
    let mount, renderer;
    try {
      engine ??= import('jianpurender');
      const lib = await engine;
      const Renderer = lib.JianpuSVGRender ?? lib.default?.JianpuSVGRender;
      const factor = quarterFactor(ctx.song);
      const key = Note.get(tonic).chroma;
      let time = 0;
      const notes = [];
      for (const note of bar.melody) {
        if (note.pitch !== null) notes.push({ start: time, length: note.beats * factor, pitch: note.pitch - (key ? 12 : 0), intensity: 80 });
        time += note.beats * factor;
      }
      // The renderer expresses rests as gaps. A removed next-bar marker lets a trailing gap render too.
      notes.push({ start: time, length: 0.0625, pitch: 60, intensity: 0 });
      mount = el('div', { class: 'melody-measure-mount', style: 'position:fixed;left:-10000px;top:0;width:900px;' });
      document.body.append(mount);
      const [num,den]=ctx.song.timeSignature.split('/').map(Number);
      renderer = new Renderer({ notes, keySignatures:[{start:0,key}], timeSignatures:[{start:0,numerator:num,denominator:den}] }, { noteHeight:24*ctx.song.layout.fontScale, noteSpacingFactor:1.45, showBarNumbers:false, showTempoMarking:false, fontFamily:'Arial, sans-serif' }, mount);
      const music = mount.querySelector('[data-id="music"]');
      if (!music) throw new Error('简谱绘制层不可用');
      // JianpuRender puts the end marker inside a block, with the note id
      // containing both time and pitch. Remove that entire generated block.
      for (const block of music.querySelectorAll('[data-block-start]')) {
        if (Number(block.getAttribute('data-block-start')) >= time - 1e-6) block.remove();
      }
      const clone=music.cloneNode(true);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
      svg.append(clone);mount.append(svg);
      const css=getComputedStyle(wrapper);
      const width=Math.max(40,wrapper.clientWidth-parseFloat(css.paddingLeft||0)-parseFloat(css.paddingRight||0));
      const height=56*ctx.song.layout.fontScale;
      const scale=Math.min(1,width/Math.max(1,bar.melody.length*22*ctx.song.layout.fontScale));
      const positions=bar.alignment?.notes??defaultAlignment(bar,ctx.song).notes;
      // Each app bar already supplies its own boundary and repeat marks. The
      // renderer's trailing marker also leaves vertical paths at baseline zero.
      for(const path of [...clone.children].filter((node)=>node.tagName.toLowerCase()==='path')){
        const bounds=path.getBBox();
        if(bounds.width<3&&bounds.height>16)path.remove();
        else path.setAttribute('transform',`translate(0 ${height/2+8})`);
      }
      let noteAt=0;
      const ranges=bar.melody.map((note,index)=>{const start=noteAt;noteAt+=note.beats*factor;return {start,end:noteAt,index};});
      const total=noteAt;
      const glyphs=[];
      const musicMatrix=clone.getCTM();
      for(const block of [...clone.querySelectorAll('[data-block-start]')]){
        const blockAt=Number(block.getAttribute('data-block-start'));
        const range=ranges.find((r)=>blockAt>=r.start-1e-6&&blockAt<r.end-1e-6);
        if(!range)continue;
        const index=range.index;
        const position=positions[index];
        if(block&&position){
          const text=[...block.querySelectorAll('text')].find((text)=>/^[0-7]$/.test(text.textContent.trim()));
          const anchor=text??block;
          const bounds=anchor.getBBox();
          const matrix=musicMatrix.inverse().multiply(anchor.getCTM());
          const center=new DOMPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2).matrixTransform(matrix);
          const group=document.createElementNS('http://www.w3.org/2000/svg','g');
          const targetX=Math.max(10,Math.min(width-10,(position.x+(blockAt-range.start)/total)*width));
          const targetY=Math.max(16,Math.min(height-16,position.y*height));
          group.setAttribute('transform',`translate(${targetX} ${targetY}) scale(${scale}) translate(${-center.x} ${-center.y})`);
          block.replaceWith(group);group.append(block);
          if(text&&bar.melody[index].pitch!==null)glyphs.push({index,x:targetX,y:targetY});
        }
      }
      for(let i=1;i<glyphs.length;i++){
        const prev=glyphs[i-1],next=glyphs[i];
        if(prev.index!==next.index && (!bar.melody[prev.index].tie || bar.melody[prev.index].pitch!==bar.melody[next.index].pitch))continue;
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');
        const y=Math.min(prev.y,next.y)-12;
        path.setAttribute('d',`M ${prev.x+5} ${y} Q ${(prev.x+next.x)/2} ${y-8} ${next.x-5} ${y}`);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.2');clone.append(path);
      }
      clone.removeAttribute('transform');
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
      svg.setAttribute('width','100%');svg.setAttribute('height',String(height));svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.setAttribute('aria-hidden','true');
      let at=0;
      for(const [index,note] of bar.melody.entries()){
        for(const g of clone.querySelectorAll('g[data-id]')){if(Math.abs(Number(g.dataset.id.split('-')[0])-at)<1e-6 && g.querySelector('text'))g.dataset.noteIndex=String(index);}
        at+=note.beats*factor;
      }
      wrapper.replaceChildren(svg);
      wrapper.dataset.renderStatus='ready';
    } catch(error) {
      wrapper.dataset.renderStatus='fallback';
      wrapper.title='简谱组件未完成渲染，显示基础数字。';
      console.warn('简谱渲染：',error.message);
    } finally { renderer?.destroy();mount?.remove();resolve(); }
  }));
  pending.set(wrapper,task);
  return wrapper;
}

export async function waitForMelodies(root) {
  await Promise.all([...root.querySelectorAll('[data-melody-bar]')].map((node)=>pending.get(node)).filter(Boolean));
}

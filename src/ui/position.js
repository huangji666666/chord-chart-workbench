import { clampPosition } from '../core/alignment.js';

/** Shared touch/mouse drag for words, notes and existing free text blocks. */
export function attachPositionDrag(node, initial, getBounds, commit, { preview } = {}) {
  let start=null, position={x:initial.x,y:initial.y}, moved=false, suppress=false;
  const paint=() => { node.style.left=position.x*100+'%';node.style.top=position.y*100+'%';preview?.(position); };
  node.style.touchAction='none';
  node.addEventListener('pointerdown',(event) => {
    if(event.pointerType==='mouse' && event.button!==0)return;
    start={x:event.clientX,y:event.clientY};moved=false;
    node.setPointerCapture?.(event.pointerId);
  });
  node.addEventListener('pointermove',(event) => {
    if(!start)return;
    const bounds=getBounds();
    const dx=event.clientX-start.x,dy=event.clientY-start.y;
    if(Math.abs(dx)+Math.abs(dy)<4&&!moved)return;
    moved=true;node.classList.add('is-dragging');event.preventDefault();
    position={x:clampPosition(initial.x+dx/Math.max(1,bounds.width)),y:clampPosition(initial.y+dy/Math.max(1,bounds.height))};paint();
  });
  node.addEventListener('pointerup',() => {
    if(!start)return;start=null;node.classList.remove('is-dragging');
    if(moved){suppress=true;commit({...position});setTimeout(()=>{suppress=false;},0);}
  });
  node.addEventListener('pointercancel',()=>{start=null;position={x:initial.x,y:initial.y};paint();node.classList.remove('is-dragging');});
  node.addEventListener('click',(event)=>{if(suppress){event.preventDefault();event.stopImmediatePropagation();}},true);
  node.addEventListener('keydown',(event)=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();const amount=event.shiftKey?.005:.02;
    position={x:clampPosition(position.x+(event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0)),y:clampPosition(position.y+(event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0))};paint();commit({...position},true);
  });
}

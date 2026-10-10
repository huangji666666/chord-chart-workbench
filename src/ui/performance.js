import { button, el, field, input, select } from './dom.js';
import { openSheet, toast } from './dialogs.js';
import { withIcon } from './icons.js';

const STORAGE_KEY = 'qingpu/performance/v1';
export function normalizePerformancePrefs(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    visual: typeof raw.visual === 'boolean' ? raw.visual : true,
    range: ['dots', 'edge', 'row', 'screen'].includes(raw.range) ? raw.range : 'dots',
    strength: Number.isFinite(raw.strength) ? Math.max(0.02, Math.min(0.35, raw.strength)) : 0.1,
    color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#4a7c59',
    flip: ['manual', 'page', 'follow'].includes(raw.flip) ? raw.flip : 'manual',
    countdown: [1, 2, 3, 4].includes(raw.countdown) ? raw.countdown : 3,
    silent: typeof raw.silent === 'boolean' ? raw.silent : false,
    practice: typeof raw.practice === 'boolean' ? raw.practice : false,
  };
}

/** Group measured rows without cutting a bar across two live pages. */
export function paginateRows(rows, height, start = 0) {
  const pages = [];
  let page = { top: start, bottom: start, rows: [], ids: [] };
  for (const row of rows) {
    if (page.rows.length && row.bottom - page.top > height) {
      pages.push(page);
      page = { top: row.top, bottom: row.bottom, rows: [], ids: [] };
    }
    page.rows.push(row);
    page.ids.push(...row.ids);
    page.bottom = Math.max(page.bottom, row.bottom);
  }
  if (page.rows.length) pages.push(page);
  return pages;
}

export function createPerformance({ shell, paper, player, getSong, isPresent, top }) {
  let prefs;
  try { prefs = normalizePerformancePrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
  catch { prefs = normalizePerformancePrefs(); }
  let pages = [], pageMap = new Map(), pageIndex = 0, current = null, held = false;
  let ui, flashTimer, frame, targetScroll = null, lastScroll = 0;
  const automatic = () => isPresent() && prefs.flip !== 'manual' && !held && (getSong().timing !== 'practice' || prefs.practice);
  const inset = () => top.getBoundingClientRect().height + (shell.querySelector('.stage-controls')?.getBoundingClientRect().height || 0) + 12;

  function stopMotion() {
    if (frame) cancelAnimationFrame(frame);
    frame = null; targetScroll = null;
  }
  function clearPulse() {
    clearTimeout(flashTimer);
    shell.classList.remove('beat-pulse');
    paper.querySelector('.beat-row')?.classList.remove('beat-row');
    shell.querySelectorAll('.beat-dot.is-active').forEach((node) => node.classList.remove('is-active'));
  }
  function refreshUi() {
    if (!ui) return;
    ui.querySelector('.live-page-count').textContent = (pageIndex + 1) + ' / ' + Math.max(1, pages.length);
    ui.querySelector('[data-page-direction="-1"]').disabled = pageIndex <= 0;
    ui.querySelector('[data-page-direction="1"]').disabled = pageIndex >= pages.length - 1;
    const resume = ui.querySelector('.follow-resume');
    resume.hidden = !held || prefs.flip === 'manual';
    const auto = ui.querySelector('.live-flip-label');
    auto.textContent = prefs.flip === 'manual' ? '手动翻谱' : prefs.flip === 'page' ? '按页翻谱' : '跟随翻谱';
    auto.classList.toggle('is-active', prefs.flip !== 'manual');
  }
  function measure() {
    if (!isPresent()) return;
    const rows = [];
    for (const section of paper.querySelectorAll('.sec')) {
      const bars = [...section.querySelectorAll('.bar')];
      let row;
      bars.forEach((bar, index) => {
        const rect = bar.getBoundingClientRect();
        const y = rect.top + window.scrollY;
        if (!row || Math.abs(row.barTop - y) > 3) {
          row = {
            top: index === 0 ? section.getBoundingClientRect().top + window.scrollY : y,
            barTop: y, bottom: rect.bottom + window.scrollY, ids: [],
          };
          rows.push(row);
        }
        row.ids.push(bar.dataset.barId);
        row.bottom = Math.max(row.bottom, rect.bottom + window.scrollY);
      });
    }
    const score = paper.querySelector('.paper');
    const scoreTop = score ? score.getBoundingClientRect().top + window.scrollY : 0;
    pages = paginateRows(rows, Math.max(160, window.innerHeight - inset() - 156), Math.min(scoreTop,inset()));
    pageMap = new Map(pages.flatMap((page, index) => page.ids.map((id) => [id, index])));
    pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
    refreshUi();
  }
  function turnPage(index, manual = false) {
    const page = pages[index];
    if (!page) return;
    if (manual) { held = true; stopMotion(); }
    pageIndex = index;
    window.scrollTo({ top: Math.max(0, index === 0 ? 0 : page.top - inset()), behavior: 'smooth' });
    refreshUi();
  }
  function hold() {
    if (!isPresent() || prefs.flip === 'manual') return;
    held = true; stopMotion(); refreshUi();
  }
  function onPosition(position) {
    current = position;
    if (!position || !isPresent() || !player.getState().playing) { stopMotion(); return; }
    const nextPage = pageMap.get(position.id);
    if (nextPage === undefined || !automatic() || document.querySelector('.modal-backdrop')) return;
    if (prefs.flip === 'page') {
      if (nextPage !== pageIndex) turnPage(nextPage);
      return;
    }
    pageIndex = nextPage; refreshUi();
    const bar = paper.querySelector('[data-bar-id="' + CSS.escape(position.id) + '"]');
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, (position.absoluteBeat - position.at) / position.beats));
    targetScroll = Math.max(0, rect.top + window.scrollY - inset() - (window.innerHeight - inset() - 156) * 0.28 + rect.height * progress * 0.35);
    if (frame) return;
    lastScroll = performance.now();
    const step = (now) => {
      if (!automatic() || !player.getState().playing || targetScroll === null) { stopMotion(); return; }
      const difference = targetScroll - window.scrollY;
      const maxStep = Math.max(1, (now - lastScroll) * 0.16);
      window.scrollBy(0, Math.sign(difference) * Math.min(Math.abs(difference), maxStep));
      lastScroll = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }
  function onBeat(beat) {
    clearPulse();
    const countdown = ui?.querySelector('.live-countdown');
    if (countdown) countdown.textContent = '';
    if (!beat) return;
    const beatGroup=shell.querySelector('.beat-dots');
    if(beatGroup){beatGroup.dataset.currentBeat=String(beat.beat+1);beatGroup.setAttribute('aria-label','当前第 '+(beat.beat+1)+' 拍');}
    if (prefs.visual) {
      const dots = shell.querySelectorAll('.beat-dot');
      dots[beat.beat % dots.length]?.classList.add('is-active');
      if (isPresent()) {
        shell.dataset.beatRange = prefs.range;
        shell.style.setProperty('--beat-strength', prefs.strength);
        shell.style.setProperty('--beat-color', prefs.color);
        paper.querySelector('[data-bar-id="' + CSS.escape(beat.id) + '"]')?.classList.add('beat-row');
        shell.classList.add('beat-pulse');
        flashTimer = setTimeout(clearPulse, Math.min(230, 60000 / getSong().bpm * 0.35));
      }
    }
    if (!countdown || !automatic() || prefs.flip !== 'page') return;
    const timeline = player.getTimeline();
    const at = timeline?.bars.findIndex((bar) => beat.at >= bar.at && beat.at < bar.at + bar.beats);
    if (at < 0 || !timeline) return;
    const currentPage = pageMap.get(beat.id);
    const boundary = timeline.bars.slice(at + 1).find((bar) => pageMap.get(bar.id) !== currentPage);
    if (!boundary) return;
    const remaining = Math.ceil(boundary.at - beat.at);
    if (remaining > 0 && remaining <= prefs.countdown) countdown.textContent = remaining + ' 拍后翻页';
  }
  function openSettings() {
    player.pause(); stopMotion();
    const visual = el('input', { type: 'checkbox', checked: prefs.visual, 'aria-label': '开启视觉节拍' });
    const silent = el('input', { type: 'checkbox', checked: prefs.silent, 'aria-label': '静音视觉节拍' });
    const practice = el('input', { type: 'checkbox', checked: prefs.practice, 'aria-label': '使用练习节奏翻谱' });
    const range = select({ value: prefs.range, ariaLabel: '视觉节拍范围', options: [
      {value:'dots',label:'灯点'}, {value:'edge',label:'屏幕边缘'}, {value:'row',label:'当前小节'}, {value:'screen',label:'全屏背景'},
    ]});
    const strength = input({ type:'range',min:2,max:35,step:1,value:Math.round(prefs.strength * 100),ariaLabel:'视觉节拍强度' });
    const amount = el('span', {class:'strength-value',text:strength.value+'%'});
    strength.addEventListener('input',()=>{amount.textContent=strength.value+'%';});
    const color = input({ type:'color',value:prefs.color,ariaLabel:'视觉节拍颜色' });
    const flip = select({value:prefs.flip,ariaLabel:'翻谱方式',options:[{value:'manual',label:'手动翻谱'},{value:'page',label:'按页自动翻谱'},{value:'follow',label:'缓慢跟随演奏'}]});
    const count = select({value:prefs.countdown,ariaLabel:'翻页提前提示',options:[1,2,3,4].map((n)=>({value:n,label:'提前 '+n+' 拍'}))});
    let handle;
    handle = openSheet({title:'演出设置',subtitle:'节拍提示与翻谱',body:el('div',{class:'compact-form'},[
      el('div',{class:'playback-switches'},[el('label',{},[visual,'视觉节拍']),el('label',{},[silent,'静音'])]),
      field({label:'提示范围',control:range}),field({label:'强度',control:el('div',{class:'strength-control'},[strength,amount])}),
      field({label:'提示颜色',control:color}),field({label:'翻谱方式',control:flip}),field({label:'翻页倒数',control:count}),
      getSong().timing==='practice'?el('label',{class:'practice-choice'},[practice,'使用练习节奏翻谱']):null,
      getSong().timing==='practice'?el('p',{class:'notice',text:'这首谱子的节奏为练习估算，自动翻谱将按当前拍数推进。'}):null,
    ]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('完成',{variant:'primary',onClick:()=>{
      prefs=normalizePerformancePrefs({visual:visual.checked,range:range.value,strength:Number(strength.value)/100,color:color.value,flip:flip.value,countdown:Number(count.value),silent:silent.checked,practice:practice.checked});
      try { localStorage.setItem(STORAGE_KEY,JSON.stringify(prefs)); } catch { toast('演出设置本次生效，设备未能保存。',{type:'warn'}); }
      player.stop(); held=false; clearPulse(); refreshUi(); handle.close(null);
    }})]});
  }
  function renderControls() {
    ui=el('div',{class:'live-page-controls'},[
      withIcon(button('',{class:'icon-button',ariaLabel:'上一页',data:{pageDirection:-1},onClick:()=>turnPage(pageIndex-1,true)}),'left'),
      el('span',{class:'live-page-count',text:'1 / 1'}),
      withIcon(button('',{class:'icon-button',ariaLabel:'下一页',data:{pageDirection:1},onClick:()=>turnPage(pageIndex+1,true)}),'right'),
      button('手动翻谱',{class:'live-flip-label',onClick:openSettings}),
      button('回到当前拍',{class:'follow-resume',onClick:()=>{held=false;onPosition(current);refreshUi();}}),
      el('span',{class:'live-countdown',role:'status','aria-live':'polite'}),
    ]);
    refreshUi();
    return ui;
  }
  window.addEventListener('wheel',hold,{passive:true});
  paper.addEventListener('touchstart',hold,{passive:true});
  return {
    renderControls, measure, onPosition, onBeat, openSettings,
    reset() { held=false; pageIndex=0; current=null; clearPulse(); stopMotion(); refreshUi(); },
    deactivate() { clearPulse(); stopMotion(); },
    playOptions() { return prefs.silent && isPresent() ? {track:'silent',metronome:false} : {track:player.getState().track==='silent'?'both':player.getState().track}; },
    turnPage(direction) { turnPage(pageIndex+direction,true); },
  };
}

import { createStore } from './store.js';
import { el, button, replaceChildren, captureFocus, restoreFocus, select } from './dom.js';
import { toast, openSheet, askText, confirmDialog } from './dialogs.js';
import { icon, withIcon } from './icons.js';
import { renderChart, buildWarnBarSet } from './chart.js';
import { renderSaveStatus, renderStorageBanner, renderRepairBanner, renderIssuesBanner, renderSongForm, renderTextPanel } from './panels.js';
import { openSectionSheet, openBarSheet, addSectionFlow } from './sheets.js';
import { loadPrefs, savePrefs, getThemeColors, getFontStack } from '../core/theme.js';
import { collectDurationIssues } from '../core/duration.js';
import * as edit from '../core/edit.js';
import { melodyExists, transposePitch } from '../core/music.js';
import { getBeatsPerBar } from '../core/constants.js';
import { createPlayer } from './player.js';
import { openChordEditor, openMelodyEditor } from './studio-editor.js';
import { renderLibrary, openImportSheet, openSongInfo, openTranspose, openAppearance, openSongManagement, openBackup, downloadEditable, openTextExport } from './studio-panels.js';
import { openScoreExport, buildScorePages } from './studio-export.js';
import { waitForMelodies } from './melody.js';
import { createPerformance } from './performance.js';
import { openAlignmentEditor } from './alignment-editor.js';
import { defaultAlignment, setBarAlignment, barNumber } from '../core/alignment.js';
import { metaIsSet } from '../core/song.js';
import { openChordDiagrams, waitForChordDiagrams } from './chord-diagrams.js';

export function createApp({root,store=createStore()}) {
  const top=el('header',{class:'app__bar'}),banners=el('div',{class:'app__banners'}),side=el('aside',{class:'app__side','aria-label':'我的谱库'}),workspace=el('div',{class:'score-workspace'}),toolbar=el('div',{class:'score-toolbar'}),paper=el('div',{class:'app__paper'}),playerEl=el('div',{class:'player-dock'}),bottom=el('nav',{class:'app__bottom','aria-label':'常用操作'});
  workspace.append(toolbar,paper);
  const shell=el('div',{class:'app qingpu single-workbench'},[top,banners,el('main',{class:'app__main'},[side,workspace]),playerEl,bottom]);root.replaceChildren(shell);
  let prefs=loadPrefs(),page='library',libraryView={filter:'all',search:'',sort:'recent'},importDraft='',drawer=null,lastStamp='',wakeLock=null,performanceView,writingSongId=null;
  let playbackState={playing:false,paused:false,position:'',loop:false,metronome:false};
  const player=createPlayer({onPosition:highlight,onBeat:(beat)=>performanceView?.onBeat(beat),onState:(state)=>{playbackState=state;updatePlayer();if(!state.playing)performanceView?.deactivate();}});
  performanceView=createPerformance({shell,paper,player,getSong:()=>store.getSong(),isPresent:()=>page==='present',top});
  const report=(result)=>toast(result.message,{type:'error'});
  const ctx={store,player,report,openAlignment:(sectionId,barIndex,selected)=>openAlignmentEditor(ctx,sectionId,barIndex,selected),selectBar:(sectionId,barIndex)=>selectBar(sectionId,barIndex),switchSong,newSong,copyCurrent:()=>{player.stop();store.duplicateSong();setMode('edit');},setMode,getPrefs:()=>({...prefs}),setPrefs,getLibraryView:()=>({...libraryView}),setLibraryView,getImportDraft:()=>importDraft,setImportDraft:(value)=>{importDraft=value;},print:printScore};

  function setPrefs(next){prefs={...prefs,...next};savePrefs(prefs);applyTheme();render('prefs');}
  function applyTheme(){for(const [key,value]of Object.entries(getThemeColors(prefs.theme)))document.documentElement.style.setProperty(`--${key.replace(/[A-Z]/g,(c)=>'-'+c.toLowerCase())}`,value);document.documentElement.style.setProperty('--score-font',getFontStack(prefs.font));shell.dataset.theme=prefs.theme;}
  function setLibraryView(next){libraryView={...libraryView,...next};renderLibraryOnly();}
  function renderLibraryOnly(){const focus=captureFocus(side);side.replaceChildren(renderLibrary(ctx));const ai=side.querySelector('.library-ai-card');ai?.append(el('span',{},[el('strong',{text:'智能导入曲谱'}),el('small',{text:'多张谱图识别 · 按小节拼接 · 逐字校正'})]),icon('right',20));restoreFocus(side,focus);}
  function setMode(mode){
    const changed=page!==mode;
    page=mode;
    if(mode==='edit')writingSongId=store.getSong().id;
    if(changed)performanceView.reset();
    if(mode!=='present')stopScrolling();
    if(changed)player.pause();
    const scoreMode=mode==='library'?'edit':mode;
    if(store.getMode()!==scoreMode)store.setMode(scoreMode);else render('page');
    applyWakeLock();
    if(changed)window.scrollTo({top:0,behavior:'instant'});
  }
  function switchSong(id){if(store.hasPendingTextDraft()){confirmDialog({title:'还有未应用的谱文',message:'切换前可以回到批量编辑保存这段谱文。',confirmText:'切换曲谱'}).then((confirmed)=>{if(confirmed)finishSwitch(id);});return;}finishSwitch(id);}
  function finishSwitch(id){player.stop();store.switchSong(id);if(page==='library')setMode('present');if(drawer){drawer.handle.close(null);drawer=null;}window.scrollTo({top:0,behavior:'instant'});}
  function newSong(){player.stop();store.createSong();setMode('edit');if(drawer){drawer.handle.close(null);drawer=null;}}
  function openWriting(){
    if(page==='library'){
      const previous=store.getLibrary().songs.find((song)=>song.id===writingSongId);
      const blank=store.getLibrary().songs.find((song)=>!song.title&&!song.sections.length&&!song.chordDiagrams?.length);
      if(previous||blank)store.switchSong((previous??blank).id);else return newSong();
    }
    setMode('edit');
  }
  function undo(){player.stop();store.undo();}
  function redo(){player.stop();store.redo();}

  function action(label,name,onClick,options={}){return withIcon(button(label,{...options,onClick}),name);}
  function renderTop(){
    const history=store.getHistoryInfo();
    const brand=el('div',{class:'brand-lockup'},[el('strong',{text:'轻谱'}),renderSaveStatus(ctx)]);
    replaceChildren(top,brand,el('div',{class:'top-actions'},[
      page==='edit'?action('','undo',undo,{class:'icon-button',ariaLabel:'撤销',disabled:!history.canUndo}):null,
      page==='edit'?action('','redo',redo,{class:'icon-button desktop-action',ariaLabel:'重做',disabled:!history.canRedo}):null,
      action('智能导入','upload',()=>openImportSheet(ctx),{class:'top-import'}),
      action('导出','download',()=>openScoreExport(ctx),{class:'top-export'}),
      action('','more',openMore,{class:'icon-button',ariaLabel:'更多功能'}),
    ]));
  }

  function setLines(lines){if(lines.some((line)=>line!=='chord')&&!metaIsSet(store.getSong(),'key'))return openSongInfo(ctx);const result=store.run('切换和弦显示',(song)=>edit.updateSongMeta(song,{layout:{displayLines:lines}}));if(!result.ok)report(result);}
  function renderToolbar(){
    const song=store.getSong(),mode=store.getMode(),lines=song.layout.displayLines??['chord'];
    const display=el('div',{class:'display-tabs',role:'group','aria-label':'和弦显示方式'},[['和弦名',['chord']],['级数',['degree']],['双行',['chord','degree']],['罗马',['roman']]].map(([label,value])=>button(label,{class:JSON.stringify(lines)===JSON.stringify(value)?'is-active':'',onClick:()=>setLines(value)})));
    const melodyButton=action('简谱','music',()=>{const result=store.run('切换简谱显示',(s)=>edit.updateSongMeta(s,{layout:{showMelody:!s.layout.showMelody}}));if(!result.ok)report(result);},{class:`toolbar-option${song.layout.showMelody?' is-active':''}`,ariaLabel:song.layout.showMelody?'隐藏简谱':'显示简谱'});
    replaceChildren(toolbar,el('div',{class:'score-context'},[
      el('div',{class:'score-mode-switch','aria-label':'写谱与看谱'},[['edit','写谱'],['present','看谱 / 演出']].map(([id,label])=>button(label,{class:page===id?'is-active':'',onClick:()=>setMode(id)}))),
      page==='edit'?button('追加谱页',{variant:'quiet',onClick:()=>openImportSheet(ctx,{append:true})}):null,
    ]),el('div',{class:'score-controls'},[
      display,melodyButton,action('和弦图','guitar',()=>openChordDiagrams(ctx),{class:'toolbar-option diagram-option'}),action('转调','guitar',()=>metaIsSet(song,'key')?openTranspose(ctx):openSongInfo(ctx),{class:'toolbar-option transpose-option'}),action('','palette',()=>openAppearance(ctx),{class:'icon-button',ariaLabel:'外观与排版'}),
    ]));
  }

  function renderPaper(){
    const focus=captureFocus(paper);
    const song=store.getSong(),mode=store.getMode(),issues=collectDurationIssues(song);
    const chart=renderChart(song,{mode,onDiagram:(index)=>openChordDiagrams(ctx,{index}),selection:store.getSelection(),warnBars:buildWarnBarSet(issues),availableWidth:Math.max(200,Math.min(720,paper.clientWidth||720)-64),onSection:(id)=>openSectionSheet(ctx,id),onBar:selectBar,onEvent:(sectionId,barIndex,eventIndex)=>{store.setSelection({sectionId,barIndex,eventIndex});openChordEditor(ctx,{sectionId,barIndex,eventIndex});},onMelody:(sectionId,barIndex)=>openMelodyEditor(ctx,sectionId,barIndex),onAlignment:ctx.openAlignment,onWordMove:(sectionId,barIndex,index,position)=>{
      const result=store.run('移动单字',(s)=>{const bar=s.sections.find((section)=>section.id===sectionId).bars[barIndex];const alignment=structuredClone(bar.alignment??defaultAlignment(bar,s));Object.assign(alignment.words[index],position);return setBarAlignment(s,sectionId,barIndex,alignment);});if(!result.ok)report(result);
    },onTextBlockMove:(sectionId,barIndex,textBlockId,pos)=>{const result=store.run('移动文字块',(s)=>edit.moveTextBlock(s,sectionId,barIndex,textBlockId,pos));if(!result.ok)report(result);}});
    if(mode==='edit'&&!song.sections.length)chart.querySelector('.paper__body').append(el('div',{class:'blank-score'},[icon('music',32),el('p',{text:'空白曲谱'}),el('small',{text:'填写歌曲信息，再添加段落；也可以直接智能导入。'})]));
    const add=mode==='edit'?el('div',{class:'score-add-actions'},[action('添加段落','plus',()=>addSectionFlow(ctx,null),{variant:'quiet'}),button('歌曲信息',{variant:'quiet',onClick:()=>openSongInfo(ctx)})]):null;
    replaceChildren(paper,chart,add,el('div',{class:'score-page-footer'},[el('span',{text:mode==='edit'?'点按歌词放大编辑，拖动单字调整位置':'轻谱 · 功能谱'}),el('span',{text:'A4 · 竖版'})]));
    const actual=chart.querySelector('.sec__grid')?.clientWidth;
    if(actual&&mode!=='preview'){
      const maxEvents=Math.max(1,...song.sections.flatMap((s)=>s.bars.map((b)=>b.events.length)));
      for(const grid of chart.querySelectorAll('.sec__grid')){
        const cols=[song.layout.barsPerRow,4,2,1].find((c)=>c<=song.layout.barsPerRow&&(actual-(c-1)*6)/c>=Math.max(110,maxEvents*44))??1;
        grid.style.setProperty('--cols',cols);
      }
    }
    const header=chart.querySelector('.paper__header');
    if(mode==='edit'){header.classList.add('is-editable');header.setAttribute('role','button');header.tabIndex=0;header.setAttribute('aria-label','编辑歌曲信息');header.addEventListener('click',()=>openSongInfo(ctx));header.addEventListener('keydown',(event)=>{if(event.key==='Enter')openSongInfo(ctx);});}
    if(song.importIssues?.length)paper.append(button(`有 ${song.importIssues.length} 处信息待核对`,{class:'import-issue-button',onClick:openImportIssues}));
    if(mode==='present')for(const bar of chart.querySelectorAll('[data-bar-id]'))bar.addEventListener('click',()=>{bar.scrollIntoView({block:'center',behavior:'smooth'});});
    Promise.all([waitForMelodies(chart),waitForChordDiagrams(chart)]).then(()=>{if(page==='present'&&paper.contains(chart))performanceView.measure();}).catch((error)=>toast(error.message,{type:'error'}));
    restoreFocus(paper,focus);
  }

  function selectBar(sectionId,barIndex){store.setSelection({sectionId,barIndex,eventIndex:null});
    let handle;
    handle=openSheet({title:`第 ${barNumber(store.getSong(),sectionId,barIndex)} 小节`,subtitle:'选择要做的操作',body:el('div',{class:'bar-action-grid'},[
      action('添加和弦','plus',()=>{handle.close(null);addChord(sectionId,barIndex);}),
      action('编辑简谱','music',()=>{handle.close(null);openMelodyEditor(ctx,sectionId,barIndex);}),
      action('逐字与简谱对齐','edit',()=>{handle.close(null);openAlignmentEditor(ctx,sectionId,barIndex);}),
      action('复制小节','copy',()=>{handle.close(null);const result=store.run('复制小节',(s)=>edit.duplicateBar(s,sectionId,barIndex));if(!result.ok)report(result);}),
      action('更多小节操作','more',()=>{handle.close(null);openBarSheet(ctx,{sectionId,barIndex});}),
    ]),actions:[button('关闭',{onClick:()=>handle.close(null)})]});
  }
  function addChord(sectionId,barIndex){
    const result=store.run('添加和弦',(song)=>{
      const bar=song.sections.find((s)=>s.id===sectionId).bars[barIndex];
      const total=bar.length??getBeatsPerBar(song.timeSignature);
      let base=song,beats=total;
      if(bar.events.length){const last=bar.events.at(-1);beats=last.beats/2;const res=edit.setEventBeats(song,sectionId,barIndex,bar.events.length-1,beats);if(!res.ok)return res;base=res.value;}
      return edit.addEvent(base,sectionId,barIndex,{kind:'chord',chord:{root:song.key.tonic,quality:song.key.mode==='minor'?'m':'maj',bass:null},beats});
    });if(!result.ok)return report(result);
    const bar=store.getSong().sections.find((s)=>s.id===sectionId).bars[barIndex];openChordEditor(ctx,{sectionId,barIndex,eventIndex:bar.events.length-1});
  }
  function openImportIssues(){
    const issues=store.getSong().importIssues??[];let handle;
    handle=openSheet({title:'核对识谱结果',subtitle:'对照原图，检查这些位置',body:el('div',{class:'issue-review'},issues.map((i)=>el('div',{},[el('strong',{text:i.location}),el('p',{text:i.message})]))),actions:[button('稍后核对',{onClick:()=>handle.close(null)}),button('已核对完成',{variant:'primary',onClick:()=>{store.run('完成识谱核对',(s)=>({ok:true,value:{...s,importIssues:[],updatedAt:new Date().toISOString()}}));handle.close(null);}})]});
  }

  function renderBottom(){
    replaceChildren(bottom,...[['library','谱库','library'],['edit','写谱','edit']].map(([id,label,name])=>{
      const active=page==='library'?id==='library':id==='edit';
      const b=action(label,name,()=>id==='edit'?openWriting():setMode(id),{class:'bottom__item'+(active?' is-active':''),ariaLabel:label});
      b.setAttribute('aria-current',active?'page':'false');return b;
    }));
  }
  function render(reason){
    if(reason==='text')return;
    if(reason==='save'){renderTop();return;}
    const song=store.getSong();const stamp=`${song.id}:${song.updatedAt}`;
    if(lastStamp&&lastStamp!==stamp){player.stop();performanceView.reset();}lastStamp=stamp;
    shell.dataset.mode=store.getMode();shell.dataset.page=page;
    side.hidden=page!=='library';workspace.hidden=page==='library';playerEl.hidden=page==='library'||!song.sections.length;
    renderTop();renderBottom();
    if(page==='library')renderLibraryOnly();else if(reason!=='organization'){renderToolbar();renderPaper();}
    workspace.querySelector('.stage-controls')?.remove();if(page==='present')stageControls();
    updatePlayer();
    const warnings=[renderStorageBanner(ctx),renderRepairBanner(ctx)];
    if(collectDurationIssues(song).length)warnings.push(button('有小节时值需要修正',{class:'duration-status',onClick:()=>{const handle=openSheet({title:'小节时值',body:renderIssuesBanner(ctx),actions:[]});}}));
    replaceChildren(banners,...warnings);
  }

  function updatePlayer(){
    const state=playbackState;
    const progress=playerEl.querySelector('.player-progress-fill');
    const song=store.getSong();
    const bpmSet=metaIsSet(song,'bpm'),tempoLabel=bpmSet?`${song.bpm} BPM`:'设置速度',songTempo=`${bpmSet}:${song.bpm}`;
    if(!playerEl.querySelector('.player-main')||playerEl.dataset.playing!==String(state.playing)||playerEl.dataset.paused!==String(state.paused)||playerEl.dataset.songId!==song.id||playerEl.dataset.songBpm!==songTempo||playerEl.dataset.page!==page){
      playerEl.dataset.playing=String(state.playing);playerEl.dataset.paused=String(state.paused);playerEl.dataset.songId=song.id;playerEl.dataset.songBpm=songTempo;playerEl.dataset.page=page;
      const play=action('',state.playing?'pause':'play',async()=>{try{if(!metaIsSet(store.getSong(),'bpm'))return openPlaybackSettings();if(state.playing)player.pause();else if(state.paused)player.resume();else {play.disabled=true;await player.play(store.getSong(),{bpm:store.getSong().bpm,...performanceView.playOptions()});}}catch(e){toast(e.message,{type:'error'});}finally{play.disabled=false;}},{class:'play-button',ariaLabel:state.playing?'暂停试听':state.paused?'继续试听':'播放和弦与旋律'});
      replaceChildren(playerEl,el('div',{class:'player-main'},[play,el('div',{class:'player-copy'},[el('strong',{text:page==='present'?'演奏节拍':'练习试听'}),el('span',{class:'player-position',text:state.position||(song.timing==='practice'?'练习节奏':tempoLabel)})]),action('','stop',()=>player.stop(),{class:'icon-button player-stop',ariaLabel:'停止试听'}),el('div',{class:'beat-dots','aria-label':'视觉拍点'},Array.from({length:getBeatsPerBar(song.timeSignature)},()=>el('span',{class:'beat-dot'}))),el('span',{class:'player-divider'}),action(tempoLabel,'timer',openPlaybackSettings,{class:'player-tempo'}),action('','repeat',()=>player.setOption('loop',!player.getState().loop),{class:`icon-button${state.loop?' is-active':''}`,ariaLabel:'循环播放'}),action('','settings',page==='present'?performanceView.openSettings:openPlaybackSettings,{class:'icon-button',ariaLabel:page==='present'?'演出设置':'试听设置'})]),el('div',{class:'player-progress'},[el('span',{class:'player-progress-fill'})]));
    }
    const label=playerEl.querySelector('.player-position');if(label)label.textContent=state.position||(song.timing==='practice'?'练习节奏':tempoLabel);
    playerEl.querySelector('[aria-label="循环播放"]')?.classList.toggle('is-active',state.loop);
  }
  function highlight(position){
    performanceView?.onPosition(position);
    for(const node of paper.querySelectorAll('.is-playing'))node.classList.remove('is-playing');
    const progress=playerEl.querySelector('.player-progress-fill');if(progress)progress.style.width=`${(position?.progress??0)*100}%`;
    if(!position)return;
    const bar=paper.querySelector(`[data-bar-id="${CSS.escape(position.id)}"]`);if(!bar)return;bar.classList.add('is-playing');
    if(position.eventIndex!==undefined)bar.querySelectorAll('.ev')[position.eventIndex]?.classList.add('is-playing');
    if(position.noteIndex!==undefined)bar.querySelector(`[data-note-index="${position.noteIndex}"]`)?.classList.add('is-playing');
  }
  function openPlaybackSettings(){
    const state=player.getState(),song=store.getSong();
    const bpm=el('input',{class:'input',type:'number',value:metaIsSet(song,'bpm')?song.bpm:'',placeholder:'填写 BPM',min:'30',max:'300','aria-label':'试听速度'});
    const part=select({value:state.part,ariaLabel:'试听段落',options:[{value:'',label:'整首歌'},...song.sections.map((s)=>({value:s.id,label:s.name}))]});
    const pattern=select({value:state.pattern,ariaLabel:'练习伴奏',options:[{value:'block',label:'和弦长音'},{value:'arpeggio',label:'轻柔分解'},{value:'strum',label:'轻扫和弦'}]});
    const track=select({value:state.track,ariaLabel:'试听内容',options:[{value:'both',label:'和弦 + 旋律'},{value:'chords',label:'只有和弦'},...(melodyExists(song)?[{value:'melody',label:'只有旋律'}]:[])]});
    const metro=el('input',{type:'checkbox',checked:state.metronome,'aria-label':'开启节拍器'}),loop=el('input',{type:'checkbox',checked:state.loop,'aria-label':'开启循环'}),volume=el('input',{class:'input',type:'range',value:state.volume,min:0,max:0.7,step:0.02,'aria-label':'试听音量'});
    let handle=openSheet({title:'练习试听',subtitle:song.timing==='practice'?'使用练习节奏，可在小节里调整':'跟着和弦与旋律一起练习',body:el('div',{class:'compact-form'},[el('label',{text:'速度 / BPM'}),bpm,el('label',{text:'播放范围'}),part,el('label',{text:'练习伴奏'}),pattern,el('label',{text:'试听内容'}),track,el('div',{class:'playback-switches'},[el('label',{},[metro,'节拍器']),el('label',{},[loop,'循环'])]),el('label',{text:'音量'}),volume]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('应用',{variant:'primary',onClick:()=>{const res=store.run('调整练习速度',(s)=>edit.updateSongMeta(s,{bpm:Number(bpm.value)}));if(!res.ok)return report(res);for(const [k,v]of Object.entries({part:part.value,pattern:pattern.value,track:track.value,metronome:metro.checked,loop:loop.checked,volume:Number(volume.value)}))player.setOption(k,v);playerEl.replaceChildren();updatePlayer();handle.close(null);}})]});
  }

  function openLibrary(){setMode('library');}
  function openMore(){let handle;const history=store.getHistoryInfo();handle=openSheet({title:'更多',body:el('div',{class:'more-grid'},[
    action('追加谱页','upload',()=>{handle.close(null);openImportSheet(ctx,{append:true});}),
    page==='present'?action('上一首','left',()=>{handle.close(null);nextSong(-1);}):null,page==='present'?action('下一首','right',()=>{handle.close(null);nextSong(1);}):null,
    action('新建曲谱','plus',()=>{handle.close(null);newSong();}),action('歌曲信息','file',()=>{handle.close(null);openSongInfo(ctx);}),action('AI 导入','sparkle',()=>{handle.close(null);openImportSheet(ctx);}),action('外观与排版','palette',()=>{handle.close(null);openAppearance(ctx);}),action('整体转调','guitar',()=>{handle.close(null);openTranspose(ctx);}),action('练习试听','play',()=>{handle.close(null);openPlaybackSettings();}),action('演出设置','stage',()=>{handle.close(null);performanceView.openSettings();}),action('导出 PDF / 图片','download',()=>{handle.close(null);openScoreExport(ctx);}),action('导出编辑文件','file',()=>{handle.close(null);downloadEditable(ctx);}),action('导出谱文','copy',()=>{handle.close(null);openTextExport(ctx);}),action('备份与恢复','library',()=>{handle.close(null);openBackup(ctx);}),action('管理当前曲谱','folder',()=>{handle.close(null);openSongManagement(ctx);}),action('撤销','undo',()=>{handle.close(null);undo();},{disabled:!history.canUndo}),action('重做','redo',()=>{handle.close(null);redo();},{disabled:!history.canRedo}),action('高级记谱设置','settings',()=>{handle.close(null);openSheet({title:'高级记谱设置',body:renderSongForm(ctx),actions:[]});}),action('批量编辑和弦','edit',()=>{handle.close(null);openSheet({title:'批量编辑和弦',body:renderTextPanel(ctx),actions:[]});}),
  ]),actions:[button('关闭',{onClick:()=>handle.close(null)})]});}

  function currentSongIds(){const id=libraryView.filter?.startsWith('setlist:')?libraryView.filter.slice(8):null;return id?store.getOrganization().setlists.find((l)=>l.id===id)?.songIds.filter((songId)=>store.songIdExists(songId))??[]:store.getLibrary().songs.map((s)=>s.id);}
  function nextSong(direction){const ids=currentSongIds(),index=ids.indexOf(store.getSong().id),id=ids[index+direction];if(id)switchSong(id);else toast(direction>0?'已经是最后一首':'已经是第一首',{duration:1800});}
  function stageControls(){if(page!=='present')return;const controls=el('div',{class:'stage-controls'},[performanceView.renderControls(),el('div',{class:'stage-song-controls'},[button('曲单',{onClick:openLibrary}),action('','fullscreen',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('浏览器暂不支持全屏，可以直接使用演出界面。',{type:'warn'});}},{class:'icon-button',ariaLabel:'全屏看谱'})])]);workspace.prepend(controls);}
  function stopScrolling(){performanceView?.deactivate();}
  async function applyWakeLock(){try{if(page==='present'&&!wakeLock&&navigator.wakeLock){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}else if(page!=='present'&&wakeLock){await wakeLock.release();wakeLock=null;}}catch{wakeLock=null;}}
  async function printScore(){const previous=page;setMode('preview');try{await document.fonts.ready;await Promise.all([waitForMelodies(paper),waitForChordDiagrams(paper)]);window.addEventListener('afterprint',()=>setMode(previous),{once:true});window.print();}catch(error){setMode(previous);toast(error.message,{type:'error'});}}

  document.addEventListener('keydown',(event)=>{const field=event.target.closest?.('input,textarea,select,[contenteditable]');if(field||document.querySelector('.modal-backdrop'))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}else if(page==='present'&&['ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();event.shiftKey?nextSong(1):performanceView.turnPage(1);}else if(page==='present'&&['ArrowLeft','ArrowUp'].includes(event.key)){event.preventDefault();event.shiftKey?nextSong(-1):performanceView.turnPage(-1);}else if(page==='present'&&event.key==='Escape')setMode('edit');});
  window.addEventListener('beforeunload',()=>store.flushSave());
  document.addEventListener('visibilitychange',()=>{if(document.hidden){player.pause();stopScrolling();}else applyWakeLock();});
  let resize;window.addEventListener('resize',()=>{clearTimeout(resize);resize=setTimeout(()=>render('resize'),120);});
  store.subscribe(render);
  applyTheme();render('init');
  window.__chordChart={store,getSong:()=>store.getSong(),summarize:()=>({title:store.getSong().title,sections:store.getSong().sections.length,bars:store.getSong().sections.reduce((n,s)=>n+s.bars.length,0)}),collectDurationIssues:()=>collectDurationIssues(store.getSong()),buildScorePages:()=>buildScorePages(store.getSong()),player,version:2};
  return {store,render};
}

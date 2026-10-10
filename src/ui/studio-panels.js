import { button, el, field, input, select, details, downloadText, formatRelativeTime } from './dom.js';
import { openSheet, askText, confirmDialog, pickFiles, toast } from './dialogs.js';
import { icon, withIcon } from './icons.js';
import * as edit from '../core/edit.js';
import { transposeSong, transposePitch, melodyExists } from '../core/music.js';
import { createLiveDemo } from '../data/live-song.js';
import { createId } from '../core/ids.js';
import { THEMES, FONT_STYLES } from '../core/theme.js';
import { LIMITS } from '../core/constants.js';
import { parseProject, serializeProject, suggestProjectFileName } from '../core/project.js';
import { parseImportedSong, buildAIImportPrompt, appendImportedSong, songToChordPro, songToABC } from '../core/import-score.js';
import { Note } from 'tonal';
import { metaIsSet } from '../core/song.js';

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = el('textarea', { class: 'visually-hidden' }); area.value = text; document.body.append(area); area.select();
    const copied = document.execCommand('copy'); area.remove();
    if (!copied) { await askText({ title: '复制这段文本', label: '文本', value: text, multiline: true, rows: 12, confirmText: '关闭' }); return false; }
  }
  toast('已复制', { type: 'success', duration: 1800 }); return true;
}

export function openImportSheet(ctx, options={}) {
  let handle,result=null,closed=false,revision=0;
  const initialSong=ctx.store.getSong();
  const nextNumber=(song)=>{const bars=song.sections.flatMap((s)=>s.bars);return (bars.at(-1)?.sourceNumber??bars.length)+1;};
  const destination=select({value:options.append?'append':'new',ariaLabel:'导入到哪里',options:[{value:'new',label:'生成一首新曲谱'},{value:'append',label:'追加到当前歌曲'}]});
  const start=input({type:'number',min:1,max:100000,value:options.append?nextNumber(initialSong):1,ariaLabel:'本批起始小节号'});
  const keepGoing=el('input',{type:'checkbox',checked:false,'aria-label':'导入后继续下一批'});
  const area=el('textarea',{class:'input import-text',rows:'9',placeholder:'粘贴一份或多份 AI 结果；可以把多个 JSON 代码块一起粘贴…','aria-label':'粘贴识谱结果',spellcheck:'false'});area.value=ctx.getImportDraft?.()??'';
  const status=el('div',{class:'import-preview','aria-live':'polite'});
  const targetName=el('p',{class:'field__hint'});
  const prompt=el('textarea',{class:'input import-text',rows:'9',readonly:true,'aria-label':'识谱提示词全文'});
  const promptText=()=>buildAIImportPrompt({title:destination.value==='append'?ctx.store.getSong().title:'',startBar:Number(start.value)||1});
  const refreshPrompt=()=>{prompt.value=promptText();targetName.textContent=destination.value==='append'?'接到「'+ctx.store.getSong().title+'」后面，当前应从第 '+nextNumber(ctx.store.getSong())+' 小节继续。':'连续编号会帮助检查多张图片是否重复或缺页。';};
  const invalidate=()=>{revision++;result=null;confirm.disabled=true;confirm.textContent=destination.value==='append'?'确认追加':'确认生成';check.textContent='检查并合并谱页';status.replaceChildren();ctx.setImportDraft?.(area.value);refreshPrompt();};
  const check=button('检查并合并谱页',{variant:'primary',onClick:async()=>{
    const source=area.value,stamp=revision,targetId=ctx.store.getSong().id;
    check.disabled=true;check.textContent='正在检查…';
    const parsed=await parseImportedSong(source,{existingSongIds:ctx.store.getLibrary().songs.map((s)=>s.id)});
    if(closed)return;check.disabled=false;
    if(stamp!==revision||source!==area.value){check.textContent='检查并合并谱页';return;}
    if(!parsed.ok){status.replaceChildren(el('p',{class:'field__error',text:parsed.message}));check.textContent='重新检查';return;}
    if(destination.value==='append'){
      const merged=appendImportedSong(ctx.store.getSong(),parsed.song,{numbered:parsed.numbered});
      if(!merged.ok){status.replaceChildren(el('p',{class:'field__error',text:merged.message}));check.textContent='重新检查';return;}
    }
    result={...parsed,readyText:source,targetId};
    const count=parsed.song.sections.reduce((sum,s)=>sum+s.bars.length,0);
    status.replaceChildren(el('strong',{text:parsed.song.title}),el('p',{text:`${parsed.parts} 份结果 · ${count} 小节${parsed.numbered?' · 第 '+parsed.startBar+'–'+parsed.endBar+' 小节':''}${melodyExists(parsed.song)?' · 含简谱及逐字对应':''}`}),...parsed.issues.slice(0,6).map((i)=>el('p',{class:'notice',text:i.location+'：'+i.message})));
    check.textContent='重新检查';confirm.textContent=destination.value==='append'?'确认追加':'确认生成';confirm.disabled=false;
  }});
  const confirm=button(options.append?'确认追加':'确认生成',{variant:'primary',disabled:true,onClick:()=>{
    if(!result?.ok||result.readyText!==area.value)return;
    if(ctx.store.hasPendingTextDraft())return toast('批量编辑还有未应用的谱文，请先保存后再导入。',{type:'error'});
    try{
      if(destination.value==='append'){
        if(result.targetId!==ctx.store.getSong().id)throw new Error('当前歌曲已变化，请重新检查。');
        const applied=ctx.store.run('追加 AI 谱页',(song)=>appendImportedSong(song,result.song,{numbered:result.numbered}));if(!applied.ok)throw new Error(applied.message);
      }else ctx.store.importSong(result.song);
    }catch(error){status.replaceChildren(el('p',{class:'field__error',text:error.message}));return;}
    area.value='';ctx.setImportDraft?.('');ctx.setMode('edit');toast('已保存「'+ctx.store.getSong().title+'」',{type:'success'});
    if(keepGoing.checked){destination.value='append';start.value=String(nextNumber(ctx.store.getSong()));area.value='';invalidate();status.append(el('p',{class:'notice',text:'已保存。复制更新后的提示词，继续识别下一批谱页。'}));area.focus();}
    else handle.close(null);
  }});
  destination.addEventListener('change',()=>{start.value=String(destination.value==='append'?nextNumber(ctx.store.getSong()):1);invalidate();});start.addEventListener('input',invalidate);area.addEventListener('input',invalidate);
  refreshPrompt();
  handle=openSheet({title:'智能导入',subtitle:'多张谱图，按小节接成一首歌',body:el('div',{class:'import-panel'},[
    el('div',{class:'import-steps'},[el('div',{},[el('span',{class:'step-number',text:'1'}),el('strong',{text:'交给 AI 识谱'}),el('p',{text:'提示词和多张谱图一起发送'})]),el('div',{},[el('span',{class:'step-number',text:'2'}),el('strong',{text:'粘贴全部结果'}),el('p',{text:'一次粘贴多份，或分批追加'})]),el('div',{},[el('span',{class:'step-number',text:'3'}),el('strong',{text:'检查与校正'}),el('p',{text:'按小节合并，逐字修正位置'})])]),
    el('div',{class:'field-pair'},[field({label:'导入方式',control:destination}),field({label:'起始小节号（给 AI）',control:start})]),targetName,
    withIcon(button('复制识谱提示词',{class:'copy-prompt',onClick:()=>copyText(promptText())}),'copy'),details('查看识谱提示词',prompt),area,status,
    el('label',{class:'practice-choice'},[keepGoing,'保存后继续粘贴下一批']),
    el('div',{class:'import-secondary'},[withIcon(button('选择谱文文件',{variant:'quiet',onClick:async()=>{
      const files=await pickFiles({accept:'.json,.txt,.cho,.chordpro,.chopro,.abc',multiple:true});if(!files.length)return;
      if(files.reduce((sum,f)=>sum+f.size,0)>1500000)return toast('文件过大，请分批追加。',{type:'error'});
      try{const texts=await Promise.all(files.map((f)=>f.text()));if(!closed){area.value=texts.length===1?texts[0]:texts.map((text)=>'```text\n'+text+'\n```').join('\n');invalidate();}}catch(e){toast('文件读取失败：'+e.message,{type:'error'});}
    }}),'file'),button('先试一首示例',{variant:'quiet',onClick:()=>{ctx.setImportDraft?.('');ctx.store.importSong(createLiveDemo());area.value='';handle.close(null);ctx.setMode('edit');}})]),
    el('p',{class:'notice',text:'识别结果保留连续小节号、反复记号和逐字音符对应；不确定的位置留给你放大修正。没有原谱节奏时保留练习节奏提示。'}),
  ]),actions:[check,confirm],onClose:()=>{closed=true;ctx.setImportDraft?.(area.value);}});
}

export function renderLibrary(ctx) {
  const view = ctx.getLibraryView();
  const organization = ctx.store.getOrganization();
  let songs = ctx.store.getLibrary().songs;
  const availableIds = new Set(songs.map((song) => song.id));
  const active = ctx.store.getSong().id;
  const selectFilter = (filter) => ctx.setLibraryView({ filter });
  if (view.filter === 'favorites') songs = songs.filter((s) => organization.favorites.includes(s.id));
  if (view.filter?.startsWith('folder:')) songs = songs.filter((s) => organization.assignments[s.id] === view.filter.slice(7));
  if (view.filter?.startsWith('setlist:')) {
    const ids = organization.setlists.find((l) => l.id === view.filter.slice(8))?.songIds ?? [];
    songs = ids.map((id) => songs.find((s) => s.id === id)).filter(Boolean);
  }
  const term = view.search.trim().toLocaleLowerCase();
  songs = songs.filter((s) => [s.title,s.artist,...(organization.tags[s.id] ?? [])].join(' ').toLocaleLowerCase().includes(term));
  if (!view.filter?.startsWith('setlist:')) songs = [...songs].sort((a,b) => view.sort === 'name' ? a.title.localeCompare(b.title,'zh-CN') : view.sort === 'key' ? a.key.tonic.localeCompare(b.key.tonic) : b.updatedAt.localeCompare(a.updatedAt));
  const search = input({ value: view.search, ariaLabel: '搜索曲谱', placeholder: '搜索歌名、歌手或标签', focusKey: 'library-search' });
  search.addEventListener('input', () => ctx.setLibraryView({ search: search.value }));
  const nav = (label, filter, name, count) => {
    const b = withIcon(button(label, { variant: 'quiet', class: `library-nav${view.filter === filter ? ' is-active' : ''}`, onClick: () => selectFilter(filter) }), name);
    if (count !== undefined) b.append(el('span', { class: 'nav-count', text: String(count) })); return b;
  };
  const items = songs.map((song, index) => {
    const favorite = organization.favorites.includes(song.id);
    const open = button('', { variant: 'quiet', class: `library-song${song.id === active ? ' is-active' : ''}`, ariaLabel: `打开曲谱 ${song.title || '空白草稿'}`, onClick: () => ctx.switchSong(song.id) });
    const meta=[metaIsSet(song,'key')?`${song.key.tonic}${song.key.mode==='minor'?'m':''}`:'',metaIsSet(song,'bpm')?`${song.bpm} BPM`:'',song.artist].filter(Boolean).join(' · ');
    open.append(el('span', { class: 'song-avatar' }, [view.filter?.startsWith('setlist:') ? String(index+1).padStart(2,'0') : icon('music',17)]), el('span', { class: 'song-summary' }, [el('strong', { text: song.title || '空白草稿' }), el('small', { text: meta || '待填写歌曲信息' })]));
    const star = withIcon(button('', { variant: 'quiet', class: `song-star${favorite ? ' is-favorite' : ''}`, ariaLabel: `${favorite ? '取消收藏' : '收藏'} ${song.title}`, onClick: () => ctx.store.organize((o) => { o.favorites = favorite ? o.favorites.filter((id) => id !== song.id) : [...o.favorites, song.id]; }) }), 'star',16);
    return el('div', { class: 'library-song-row' }, [open, star]);
  });
  if (view.filter === 'trash') return el('div', { class: 'studio-library' }, [nav('返回全部曲谱','all','left'), el('h3', { text: '回收站' }), ...organization.trash.map((item) => el('div', { class: 'trash-row' }, [el('span', {}, [el('strong', { text: item.song.title }),el('small', { text: formatRelativeTime(item.deletedAt) })]),button('恢复', { onClick: () => { const res=ctx.store.restoreSong(item.song.id); if(!res.ok)toast(res.message,{type:'error'}); } })])), !organization.trash.length ? el('p',{class:'library-empty',text:'回收站是空的'}) : null]);
  return el('div', { class: 'studio-library' }, [
    el('div', { class: 'library-heading' }, [el('h2', { text: '我的谱库' }), withIcon(button('', { class: 'icon-button', ariaLabel: '新建曲谱', onClick: () => ctx.newSong() }), 'plus')]),
    el('p',{class:'library-intro',text:'点开一首歌，直接看谱与演出。'}),
    withIcon(button('',{class:'library-ai-card',ariaLabel:'智能导入曲谱',onClick:()=>openImportSheet(ctx)}),'sparkle',26),
    el('div', { class: 'search-field' }, [icon('search',16),search]),
    el('div', { class: 'library-navigation' }, [nav('全部曲谱','all','library',availableIds.size),nav('我的收藏','favorites','star',organization.favorites.filter((id) => availableIds.has(id)).length)]),
    el('details',{class:'library-groups',open:view.filter?.startsWith('folder:')||view.filter?.startsWith('setlist:')},[
    el('summary',{text:'分类与演出曲单'}),
    el('div', { class: 'library-subheading' }, [el('span',{text:'文件夹'}),withIcon(button('',{class:'icon-button',ariaLabel:'新建文件夹',onClick:async()=>{const name=await askText({title:'新建文件夹',label:'文件夹名称',required:true,maxLength:40});if(name)ctx.store.organize((o)=>o.folders.push({id:crypto.randomUUID(),name}));}}),'plus',15)]),
    ...organization.folders.map((folder)=>nav(folder.name,`folder:${folder.id}`,'folder')),
    !organization.folders.length ? el('p',{class:'library-mini-hint',text:'按排练、演出或风格整理曲谱'}) : null,
    el('div',{class:'library-subheading'},[el('span',{text:'演出曲单'}),withIcon(button('',{class:'icon-button',ariaLabel:'新建演出曲单',onClick:async()=>{const name=await askText({title:'新建演出曲单',label:'曲单名称',value:'本次演出',required:true,maxLength:40});if(name)ctx.store.organize((o)=>o.setlists.push({id:crypto.randomUUID(),name,songIds:[]}));}}),'plus',15)]),
    ...organization.setlists.map((list)=>nav(list.name,`setlist:${list.id}`,'setlist',list.songIds.filter((id) => availableIds.has(id)).length)),
    ]),
    el('div',{class:'library-subheading library-sort'},[el('span',{text:view.filter==='favorites'?'收藏曲谱':'曲谱'}),select({value:view.sort,ariaLabel:'曲谱排序',options:[{value:'recent',label:'最近编辑'},{value:'name',label:'歌名'},{value:'key',label:'调号'}],onChange:(sort)=>ctx.setLibraryView({sort})})]),
    el('div',{class:'library-songs'},items.length ? items : [el('p',{class:'library-empty',text:term?'没有找到匹配的曲谱':'这里还没有曲谱'})]),
    el('div',{class:'library-foot'},[
      withIcon(button('AI 导入', {class:'library-import',onClick:()=>openImportSheet(ctx)}),'sparkle'),
      button('管理曲谱与曲单', {variant:'quiet',class:'library-manage',onClick:()=>openSongManagement(ctx)}),
      button('回收站',{variant:'quiet',class:'library-manage',onClick:()=>selectFilter('trash')}),
    ]),
  ]);
}

export function openSongInfo(ctx) {
  const song = ctx.store.getSong();
  const title = input({value:song.title,ariaLabel:'歌名',placeholder:'填写歌名',maxLength:120}),artist=input({value:song.artist,ariaLabel:'歌手或作者',placeholder:'填写作者或歌手'}),capo=input({value:song.capo??'',type:'number',min:0,max:12,ariaLabel:'变调夹品位',placeholder:'未设置'}),bpm=input({value:metaIsSet(song,'bpm')?song.bpm:'',type:'number',min:30,max:300,ariaLabel:'歌曲速度',placeholder:'未设置'});
  const tonic=select({value:metaIsSet(song,'key')?song.key.tonic:'',ariaLabel:'指型调',options:[{value:'',label:'未设置'},...['C','C#','Db','D','D#','Eb','E','F','F#','Gb','G','G#','Ab','A','A#','Bb','B'].map((v)=>({value:v,label:v}))]});
  const mode=select({value:metaIsSet(song,'key')?song.key.mode:'',ariaLabel:'调式',options:[{value:'',label:'未设置'},{value:'major',label:'大调'},{value:'minor',label:'小调'}]});
  const meter=select({value:metaIsSet(song,'timeSignature')?song.timeSignature:'',ariaLabel:'歌曲拍号',options:[{value:'',label:'未设置'},...['4/4','3/4','6/8'].map((v)=>({value:v,label:v}))]});
  tonic.addEventListener('change',()=>{if(!tonic.value)mode.value='';});
  const notes=el('textarea',{class:'input',rows:'3','aria-label':'演奏备注'});notes.value=song.notes;
  let handle;
  handle=openSheet({title:'歌曲信息',subtitle:'让现场需要的信息一眼可见',body:el('div',{class:'compact-form'},[
    field({label:'歌名',control:title}),field({label:'歌手 / 作者',control:artist}),
    el('div',{class:'field-pair'},[field({label:'指型调',control:tonic}),field({label:'调式',control:mode})]),
    el('div',{class:'field-pair'},[field({label:'变调夹 / 品',control:capo}),field({label:'速度 / BPM',control:bpm})]),field({label:'拍号',control:meter}),field({label:'演奏备注',control:notes}),
    el('p',{class:'notice',text:'修改调号用于说明和弦的调性；整体升降调请用谱面上方的“转调”。'}),
  ]),actions:[button('取消',{onClick:()=>handle.close(null)}),button('保存',{variant:'primary',onClick:()=>{
    if(Boolean(tonic.value)!==Boolean(mode.value))return ctx.report({message:'请同时选择调号和大调 / 小调，或都留空。'});
    const result=ctx.store.run('修改歌曲信息',(current)=>{
      const unsetMeta=[...(!title.value.trim()?['title']:[]),...(!tonic.value?['key']:[]),...(!bpm.value?['bpm']:[]),...(!meter.value?['timeSignature']:[])];
      const res=edit.updateSongMeta({...current,unsetMeta},{title:title.value.trim(),artist:artist.value,...(tonic.value?{key:{tonic:tonic.value,mode:mode.value}}:{}),...(capo.value?{capo:Number(capo.value)}:{}),...(bpm.value?{bpm:Number(bpm.value)}:{}),notes:notes.value});
      if(!res.ok)return res;
      if(!capo.value)delete res.value.capo;
      return meter.value?edit.setTimeSignature(res.value,meter.value):res;
    });if(!result.ok)return ctx.report(result);handle.close(null);
  }})]});
}

export function openTranspose(ctx) {
  const song=ctx.store.getSong();
  if(!metaIsSet(song,'key')){openSongInfo(ctx);return;}
  const choices=el('div',{class:'transpose-choices'});
  let handle;
  for(const shift of [-5,-4,-3,-2,-1,0,1,2,3,4,5,6]){
    const key=transposePitch(song.key.tonic,shift);
    choices.append(button(`${key}${song.key.mode==='minor'?'m':''}`,{class:shift===0?'is-active':'',title:`${shift>=0?'+':''}${shift} 半音`,onClick:()=>{if(shift){const result=ctx.store.run('整体转调',(s)=>transposeSong(s,shift));if(!result.ok)return ctx.report(result);}handle.close(null);}}));
  }
  handle=openSheet({title:'整体转调',subtitle:`当前 ${song.key.tonic}${song.key.mode==='minor'?' 小调':' 大调'} · 和弦与旋律一起移动`,body:choices,actions:[button('取消',{onClick:()=>handle.close(null)})]});
}

export function openAppearance(ctx) {
  const prefs=ctx.getPrefs(),song=ctx.store.getSong();
  let handle;
  const names={green:'浅绿',paper:'纸黄',blue:'白蓝',mono:'黑白',pure:'纯白'};
  const swatches=el('div',{class:'theme-swatches'},Object.entries(THEMES).map(([id,c])=>{
    const b=button(names[id]??id,{class:`theme-swatch${prefs.theme===id?' is-active':''}`,onClick:()=>{ctx.setPrefs({theme:id});for(const n of swatches.children)n.classList.toggle('is-active',n===b);}});
    b.prepend(el('span',{style:`background:${c.bg};border-color:${c.accent}`,class:'swatch-color'}));return b;
  }));
  const range=(name,value,prop,min=0.6,max=2)=>{const r=input({type:'range',value,min,max,step:0.05,ariaLabel:name});r.addEventListener('change',()=>{const res=ctx.store.run(`调整${name}`,(s)=>edit.updateSongMeta(s,{layout:{[prop]:Number(r.value)}}));if(!res.ok)ctx.report(res);});return field({label:name,control:r});};
  const font=select({value:prefs.font,ariaLabel:'谱面字体',options:Object.entries(FONT_STYLES).map(([v,f])=>({value:v,label:f.label})),onChange:(value)=>ctx.setPrefs({font:value})});
  const columns=select({value:song.layout.barsPerRow,ariaLabel:'A4每行小节数',options:[2,4,8].map((n)=>({value:n,label:`每行 ${n} 小节`})),onChange:(v)=>ctx.store.run('调整每行小节数',(s)=>edit.updateSongMeta(s,{layout:{barsPerRow:Number(v)}}))});
  handle=openSheet({title:'外观与排版',subtitle:'舒服地看谱，也整齐地打印',body:el('div',{class:'compact-form'},[
    el('label',{class:'field__label',text:'界面配色'}),swatches,field({label:'谱面字体',control:font}),field({label:'A4 排版',control:columns}),range('整体字号',song.layout.fontScale,'fontScale',LIMITS.fontScaleMin,LIMITS.fontScaleMax),range('歌词大小',song.layout.lyricScale??1,'lyricScale'),range('和弦大小',song.layout.chordScale??1,'chordScale'),
    el('fieldset',{class:'layout-visibility'},[el('legend',{text:'精简谱面'}),...[
      ['showLyrics','显示歌词',true],['showMeta','显示调号、拍号等信息',true],['showCues','显示演奏备注',true],['showBarNumbers','显示小节编号',true],['compact','紧凑排版',false],
    ].map(([prop,label,fallback])=>{const box=el('input',{type:'checkbox',checked:song.layout[prop]??fallback,'aria-label':label});box.addEventListener('change',()=>{const res=ctx.store.run('调整谱面信息',(s)=>edit.updateSongMeta(s,{layout:{[prop]:box.checked}}));if(!res.ok)ctx.report(res);});return el('label',{},[box,label]);})]),
    el('p',{class:'notice',text:'手机按屏幕宽度排版，A4 导出按这里的小节数排版。导出默认用白纸。'}),
  ]),actions:[button('完成',{variant:'primary',onClick:()=>handle.close(null)})]});
}

export function openSongManagement(ctx) {
  const song=ctx.store.getSong(),org=ctx.store.getOrganization();
  const folder=select({value:org.assignments[song.id]??'',ariaLabel:'曲谱文件夹',options:[{value:'',label:'不放入文件夹'},...org.folders.map((f)=>({value:f.id,label:f.name}))]});
  const tags=input({value:(org.tags[song.id]??[]).join('，'),ariaLabel:'曲谱标签',placeholder:'例如：民谣，排练，新歌'});
  const body=el('div',{class:'compact-form'},[field({label:'放入文件夹',control:folder}),field({label:'标签',control:tags})]);
  const saveMeta=()=>ctx.store.organize((o)=>{if(folder.value)o.assignments[song.id]=folder.value;else delete o.assignments[song.id];o.tags[song.id]=tags.value.split(/[,，]/).map((s)=>s.trim()).filter(Boolean);});
  body.append(el('h3',{class:'small-heading',text:'演出曲单'}));
  for(const list of org.setlists){
    const included=list.songIds.includes(song.id);
    body.append(el('div',{class:'setlist-choice'},[el('span',{text:list.name}),button(included?'从曲单移除':'加入曲单',{onClick:()=>{saveMeta();ctx.store.organize((o)=>{const target=o.setlists.find((l)=>l.id===list.id);target.songIds=included?target.songIds.filter((id)=>id!==song.id):[...target.songIds,song.id];});handle.close(null);toast(included?'已从曲单移除':'已加入演出曲单',{type:'success'});}})]));
  }
  const activeList=ctx.getLibraryView().filter?.startsWith('setlist:')?org.setlists.find((l)=>l.id===ctx.getLibraryView().filter.slice(8)):null;
  if(activeList){
    body.append(el('h3',{class:'small-heading',text:'调整演出顺序'}));
    activeList.songIds.forEach((id,index)=>{const title=ctx.store.getLibrary().songs.find((s)=>s.id===id)?.title??'已移除曲谱';body.append(el('div',{class:'setlist-order'},[el('span',{text:`${index+1}. ${title}`}),...[-1,1].map((direction)=>withIcon(button('',{class:'icon-button',ariaLabel:`${direction<0?'上移':'下移'} ${title}`,disabled:index+direction<0||index+direction>=activeList.songIds.length,onClick:()=>{ctx.store.organize((o)=>{const ids=o.setlists.find((l)=>l.id===activeList.id).songIds;[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];});handle.close(null);openSongManagement(ctx);}}),direction<0?'up':'down'))]));});
  }
  body.append(el('div',{class:'management-actions'},[
    withIcon(button('复制这首谱',{onClick:()=>{ctx.copyCurrent();handle.close(null);}}),'copy'),
    withIcon(button('移入回收站',{variant:'danger',onClick:async()=>{handle.close(null);const accepted=await confirmDialog({title:'移入回收站',message:`「${song.title}」可以在回收站恢复。`,confirmText:'移入回收站'});if(accepted){ctx.store.deleteSong(song.id);toast('已移入回收站',{type:'success'});}}}),'trash'),
  ]));
  let handle=openSheet({title:'管理曲谱',subtitle:song.title,body,actions:[button('取消',{onClick:()=>handle.close(null)}),button('保存分类',{variant:'primary',onClick:()=>{const res=saveMeta();if(!res.ok)return ctx.report(res);handle.close(null);}})]});
}

export function openBackup(ctx) {
  let handle;
  handle=openSheet({title:'备份与恢复',subtitle:'把谱库带到另一台设备',body:el('div',{class:'compact-form'},[
    el('p',{text:'备份包含所有曲谱、收藏、文件夹、演出曲单和回收站。'}),
    withIcon(button('下载整个谱库',{variant:'primary',onClick:()=>downloadText('轻谱-谱库备份.json',JSON.stringify({format:'qingpu-library',version:1,library:ctx.store.getLibrary()},null,2))}),'download'),
    withIcon(button('从备份恢复',{onClick:async()=>{const files=await pickFiles({accept:'.json'});if(!files.length)return;try{if(files[0].size>5000000)throw new Error('备份过大，请分批导入。');const payload=JSON.parse(await files[0].text());if(payload.format!=='qingpu-library'||payload.version!==1)throw new Error('这不是轻谱的谱库备份。');const res=ctx.store.restoreBackup(payload.library);if(!res.ok)throw new Error(res.message);handle.close(null);toast(`已恢复 ${res.count} 首曲谱，原有谱子也保留着。`,{type:'success'});}catch(e){toast(e.message,{type:'error'});}}}),'upload'),
  ]),actions:[button('关闭',{onClick:()=>handle.close(null)})]});
}

export function downloadEditable(ctx) {
  const song=ctx.store.getSong();downloadText(suggestProjectFileName(song),serializeProject(song));
}

export function openTextExport(ctx) {
  const song=ctx.store.getSong();
  const hasMelody=melodyExists(song);
  let text;try{text=hasMelody?songToABC(song):songToChordPro(song);}catch(error){ctx.report({message:error.message});return;}
  let handle;
  const area=el('textarea',{class:'input import-text',rows:'12','aria-label':'可复制谱文',readonly:true});area.value=text;
  handle=openSheet({title:'导出谱文',subtitle:hasMelody?'含旋律的 ABC 谱文':'和弦与歌词的 ChordPro 谱文',body:area,actions:[button('下载文本',{onClick:()=>downloadText(`${song.title}.${hasMelody?'abc':'cho'}`,text,'text/plain')}),withIcon(button('复制谱文',{variant:'primary',onClick:()=>copyText(text)}),'copy')]});
}

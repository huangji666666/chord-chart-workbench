import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSong, cloneSong, validateSongShape } from '../src/core/song.js';
import { defaultAlignment, setBarAlignment } from '../src/core/alignment.js';
import { parseImportedSong, appendImportedSong, AI_IMPORT_PROMPT, buildAIImportPrompt } from '../src/core/import-score.js';
import { duplicateSong, updateSongMeta, setEventLyric, duplicateBar } from '../src/core/edit.js';
import { transposeSong } from '../src/core/music.js';
import { buildTimeline } from '../src/ui/player.js';
import { serializeProject, parseProject } from '../src/core/project.js';

globalThis.self=globalThis;
const windowObject=new JSDOM('').window;
const packet=(number,text='微风轻唱')=>JSON.stringify({format:'qingpu-import',version:2,notation:'abc',hasMelody:true,timing:'exact',content:'X:1\nT:多页验证\nM:4/4\nL:1/4\nQ:1/4=76\nK:C\n%%capo 0\nP:主歌\n"C" E D "Am" C A, |\nw: '+Array.from(text).join(' '),measures:[{number,syllables:Array.from(text).map((text,i)=>({text,note:i+1}))}],issues:[]});

test('v2 逐字对应含休止的音符索引，一字多音不补字',async()=>{
  const p=JSON.parse(packet(1));p.content=p.content.replace('E D "Am" C A,','E z "Am" C A,');p.measures[0].syllables=[{text:'微',note:1},{text:'风',note:3},{text:'轻唱',note:4}];
  const result=await parseImportedSong(JSON.stringify(p),{windowObject});assert.equal(result.ok,true,result.message);
  const bar=result.song.sections[0].bars[0];
  assert.deepEqual(bar.alignment.words.map((w)=>w.noteIndex),[0,2,3,3]);
  assert.equal(bar.melody[1].pitch,null);assert.equal(bar.melody[1].lyric,'');
  assert.deepEqual(bar.lyrics.map((w)=>w?.text??null),['微','风轻唱']);
});

test('多份代码块按小节号合并，后续追加不破坏旧位置且 ID 不重复',async()=>{
  const batch='```json\n'+packet(2)+'\n```\n```json\n'+packet(1)+'\n```';
  const result=await parseImportedSong(batch,{windowObject});assert.equal(result.ok,true,result.message);assert.equal(result.parts,2);
  assert.deepEqual(result.song.sections[0].bars.map((b)=>b.sourceNumber),[1,2]);
  result.song.sections[0].bars[0].alignment.words[0].x=.23;
  const page=await parseImportedSong(packet(3),{windowObject});const merged=appendImportedSong(result.song,page.song,{numbered:true});
  assert.equal(merged.ok,true,merged.message);assert.equal(merged.value.sections[0].bars.length,3);
  assert.equal(merged.value.sections[0].bars[0].alignment.words[0].x,.23);assert.equal(result.song.sections[0].bars.length,2);
  assert.equal(validateSongShape(merged.value).ok,true);
  const adjacent=await parseImportedSong(packet(1)+'\n'+packet(2),{windowObject});assert.equal(adjacent.ok,true,adjacent.message);
});

test('重复、缺号、坏音符对应与半段 JSON 被拒绝，已有曲谱不变',async()=>{
  const first=await parseImportedSong(packet(1),{windowObject});
  for(const number of [1,3]){
    const next=await parseImportedSong(packet(number),{windowObject});assert.equal(appendImportedSong(first.song,next.song,{numbered:true}).ok,false);
    assert.equal((await parseImportedSong(packet(1)+'\n'+packet(number),{windowObject})).ok,false);
  }
  const invalid=JSON.parse(packet(1));invalid.measures[0].syllables[0].note=99;
  assert.equal((await parseImportedSong(JSON.stringify(invalid),{windowObject})).ok,false);
  assert.equal((await parseImportedSong(packet(1)+'\n{"format":', {windowObject})).ok,false);
  assert.equal(first.song.sections[0].bars.length,1);
});

test('只有和弦歌词时不制造旋律，逐字位置和练习节奏保留',async()=>{
  const value={format:'qingpu-import',version:2,notation:'abc',hasMelody:false,timing:'practice',content:'X:1\nT:无旋律\nM:4/4\nL:1/4\nK:C\n%%capo 0\n"C" z2 "Am" z2 |',measures:[{number:1,syllables:[{text:'微',note:null,x:.15},{text:'风',note:null,x:.42},{text:'轻',note:null,x:.6},{text:'唱',note:null,x:.85}]}],issues:[]};
  const parsed=await parseImportedSong(JSON.stringify(value),{windowObject});assert.equal(parsed.ok,true,parsed.message);
  assert.equal(parsed.song.timing,'practice');assert.equal(parsed.song.layout.showMelody,false);
  assert.equal(parsed.song.sections[0].bars[0].melody,undefined);
  assert.deepEqual(parsed.song.sections[0].bars[0].lyrics.map((l)=>l.text),['微风','轻唱']);
});

test('字、音符位置与对应关系经过克隆、转调、复制和工程往返仍保留',async()=>{
  const parsed=await parseImportedSong(packet(1),{windowObject});const song=parsed.song,section=song.sections[0],bar=section.bars[0];
  const alignment=defaultAlignment(bar,song);alignment.words[0].x=.23;alignment.words[0].y=.7;alignment.words[0].scale=1.4;alignment.words[0].noteIndex=2;alignment.words[0].free=true;alignment.notes[2].x=.61;
  const edited=setBarAlignment(song,section.id,0,alignment);assert.equal(edited.ok,true);
  const copy=cloneSong(edited.value);copy.sections[0].bars[0].alignment.words[0].x=.4;
  assert.equal(edited.value.sections[0].bars[0].alignment.words[0].x,.23);
  assert.equal(transposeSong(edited.value,2).value.sections[0].bars[0].alignment.notes[2].x,.61);
  const duplicate=duplicateSong(edited.value);assert.equal(validateSongShape(duplicate).ok,true);
  const project=parseProject(serializeProject(edited.value));assert.equal(project.ok,true,project.message);
  assert.deepEqual(project.value.sections[0].bars[0].alignment,alignment);
  alignment.words[0].x=9;assert.equal(setBarAlignment(song,section.id,0,alignment).ok,false);
});

test('反复起止和第一第二结尾用于真正的播放次序',()=>{
  const song=createSong({sections:[{name:'主歌',bars:[
    {repeatStart:true,events:[{kind:'chord',chord:{root:'C'},beats:4}]},
    {ending:1,repeatEnd:2,events:[{kind:'chord',chord:{root:'G'},beats:4}]},
    {ending:2,events:[{kind:'chord',chord:{root:'F'},beats:4}]},
  ]}]});
  assert.deepEqual(buildTimeline(song).bars.map((b)=>b.barIndex),[0,1,0,2]);
  assert.equal(buildTimeline(song).beats,16);
  assert.equal(validateSongShape(song).ok,true);
});

test('跨段落的反复仍按整首歌曲的起止范围播放，嵌套反复明确拒绝',()=>{
  const bar=(root,extras={})=>({events:[{kind:'chord',chord:{root},beats:4}],...extras});
  const song=createSong({sections:[{name:'主歌',bars:[bar('C',{repeatStart:true})]},{name:'副歌',bars:[bar('G',{repeatEnd:2})]}]});
  assert.deepEqual(buildTimeline(song).bars.map((b)=>b.sectionName),['主歌','副歌','主歌','副歌']);
  song.sections[1].bars[0].repeatStart=true;
  assert.equal(validateSongShape(song).ok,false);
});

test('复制反复起点的小节保留内容和对齐，避免复制控制记号产生嵌套',async()=>{
  const value=JSON.parse(packet(1));value.measures[0].repeatStart=true;
  const parsed=await parseImportedSong(JSON.stringify(value),{windowObject});
  const copy=duplicateBar(parsed.song,parsed.song.sections[0].id,0);assert.equal(copy.ok,true);
  assert.equal(copy.value.sections[0].bars[1].repeatStart,undefined);
  assert.deepEqual(copy.value.sections[0].bars[1].alignment,copy.value.sections[0].bars[0].alignment);
  assert.equal(validateSongShape(copy.value).ok,true);
});

test('ABC 反复小节不重复导入，显示与播放使用同一标记',async()=>{
  const parsed=await parseImportedSong('X:1\nT:反复\nM:4/4\nL:1/4\nK:C\n|: "C" C D E F | "G" G A B c :|',{windowObject});
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.song.sections[0].bars.length,2);
  assert.equal(parsed.song.sections[0].bars[0].repeatStart,true);assert.equal(parsed.song.sections[0].bars[1].repeatEnd,2);
  assert.equal(buildTimeline(parsed.song).bars.length,4);
});

test('空歌词格不挤掉下一个和弦的歌词，精简显示选项严格校验',()=>{
  const song=createSong({sections:[{name:'主歌',bars:[{events:[{kind:'chord',chord:{root:'C'},beats:2},{kind:'chord',chord:{root:'G'},beats:2}],lyrics:[null,{text:'微风'}]}]}]});
  assert.equal(song.sections[0].bars[0].lyrics[0],null);assert.equal(song.sections[0].bars[0].lyrics[1].text,'微风');
  assert.equal(updateSongMeta(song,{layout:{compact:true,showMeta:false,showLyrics:false}}).ok,true);
  assert.equal(updateSongMeta(song,{layout:{showLyrics:'false'}}).ok,false);
});

test('页面复制的提示词示例是合法 v2 JSON，追加提示词包含下一小节号',()=>{
  const sample=AI_IMPORT_PROMPT.split('完整原创语法示例：\n')[1].split('\n只处理')[0];
  const value=JSON.parse(sample);assert.equal(value.version,2);assert.equal(value.measures[0].syllables.length,4);
  assert.match(buildAIImportPrompt({title:'多页验证',startBar:9}),/第 9 小节/);
});

test('整格改词不会被旧音符歌词覆盖，自动对齐保留未对应的字',async()=>{
  const parsed=await parseImportedSong(packet(1),{windowObject});const song=parsed.song,section=song.sections[0];
  const result=setEventLyric(song,section.id,0,0,'柔光');assert.equal(result.ok,true);
  const bar=result.value.sections[0].bars[0];
  assert.equal(bar.alignment.words.filter((w)=>w.noteIndex===null).map((w)=>w.text).join(''),'柔光');
  assert.equal(defaultAlignment(bar,result.value).words.map((w)=>w.text).includes('柔'),true);
  assert.equal(bar.melody[0].lyric,'');
  assert.equal(bar.melody[2].lyric,'轻');
  assert.equal(validateSongShape(result.value).ok,true);
});

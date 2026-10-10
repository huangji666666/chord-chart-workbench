import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createBlankSong, createSong, cloneSong, validateSongShape, metaIsSet } from '../src/core/song.js';
import { createStore } from '../src/ui/store.js';
import { createMemoryStorage } from '../src/core/library.js';
import { updateSongMeta, setTimeSignature, duplicateSong } from '../src/core/edit.js';
import { serializeProject, parseProject } from '../src/core/project.js';
import { parseChordSymbol } from '../src/core/chord.js';
import { transposeSong } from '../src/core/music.js';
import { diagramCatalog, findDiagramChord, searchDiagramChords, svguitarShape } from '../src/core/chord-diagrams.js';
import { renderChart, eventDisplayLines } from '../src/ui/chart.js';
import { songToChordPro, songToABC } from '../src/core/import-score.js';

const database=JSON.parse(readFileSync(new URL('../node_modules/@tombatossals/chords-db/lib/guitar.json',import.meta.url),'utf8'));
const catalog=diagramCatalog(database);
const chord=(symbol)=>{const parsed=parseChordSymbol(symbol);assert.equal(parsed.ok,true);return parsed.value;};

test('新用户和新建曲谱使用真正的空白草稿，重开后保留未填写状态',()=>{
  const storage=createMemoryStorage(); const store=createStore({storage});
  assert.equal(store.getSong().title,'');assert.equal(store.getSong().artist,'');assert.deepEqual(store.getSong().sections,[]);
  assert.equal(metaIsSet(store.getSong(),'key'),false);assert.equal(validateSongShape(store.getSong()).ok,true);
  const original=createSong({title:'原有用户歌曲'});store.importSong(original);
  store.createSong();store.flushSave();
  const reopened=createStore({storage});assert.equal(reopened.getSong().title,'');assert.equal(metaIsSet(reopened.getSong(),'bpm'),false);
  assert.ok(reopened.getLibrary().songs.some((song)=>song.id===original.id&&song.title==='原有用户歌曲'));
});

test('填写部分元信息只确认对应字段，工程导入与复制保持草稿合法',()=>{
  const draft=createBlankSong();
  let result=updateSongMeta(draft,{title:'新歌',artist:'作者'});assert.equal(result.ok,true);
  assert.deepEqual(result.value.unsetMeta,['key','bpm','timeSignature']);
  result=updateSongMeta(result.value,{key:{tonic:'G',mode:'major'},bpm:76});
  result=setTimeSignature(result.value,'3/4');assert.deepEqual(result.value.unsetMeta,[]);
  assert.equal(validateSongShape(result.value).ok,true);
  assert.equal(parseProject(serializeProject(draft)).ok,true);
  assert.equal(validateSongShape(duplicateSong(draft)).ok,true);
  assert.equal(validateSongShape({...draft,unsetMeta:['garbage']}).ok,false);
  assert.equal(validateSongShape({...draft,unsetMeta:'title'}).ok,false);
});

test('数据库搜索识别等音、常用别名和真实斜杠指法，不替代未收录和弦',()=>{
  for(const symbol of ['C','Am','F#min','Gbmin','Bbmaj7','G/B','C/E'])assert.ok(findDiagramChord(catalog,chord(symbol)),symbol);
  assert.equal(searchDiagramChords(catalog,'Db')[0].chord.root,'C#');
  assert.equal(searchDiagramChords(catalog,'G/B')[0].symbol,'G/B');
  assert.equal(findDiagramChord(catalog,chord('Cmaj7/F#')),undefined);
  assert.ok(searchDiagramChords(catalog,'F').length<=16);
  const partial=svguitarShape(findDiagramChord(catalog,chord('F')).positions[1]);
  assert.deepEqual(partial.barres,[{fromString:5,toString:4,fret:1}]);
  assert.equal(partial.fingers[0][1],'x');assert.equal(partial.position,3);
});

test('和弦图保留大小与把位，独立克隆、工程往返、撤销和转调均生效',()=>{
  const song=createSong({title:'指法测试',chordDiagrams:[{chord:chord('F'),position:1,size:144}]});
  const copy=cloneSong(song);copy.chordDiagrams[0].chord.root='G';assert.equal(song.chordDiagrams[0].chord.root,'F');
  const duplicate=duplicateSong(song);duplicate.chordDiagrams[0].size=60;assert.equal(song.chordDiagrams[0].size,144);
  assert.deepEqual(parseProject(serializeProject(song)).value.chordDiagrams,song.chordDiagrams);
  const shifted=transposeSong(song,2).value;assert.equal(shifted.chordDiagrams[0].chord.root,'G');assert.equal(shifted.chordDiagrams[0].position,0);assert.equal(shifted.chordDiagrams[0].size,144);
  const store=createStore({storage:createMemoryStorage()});store.importSong(song);
  store.run('放大指法',(current)=>({ok:true,value:{...current,chordDiagrams:[{...current.chordDiagrams[0],size:180}]}}));
  store.undo();assert.equal(store.getSong().chordDiagrams[0].size,144);store.redo();assert.equal(store.getSong().chordDiagrams[0].size,180);
  assert.equal(validateSongShape({...song,chordDiagrams:[{...song.chordDiagrams[0],size:999}]}).ok,false);
  assert.equal(validateSongShape({...song,chordDiagrams:[null]}).ok,false);
});

test('空白信息在成品谱头不会出现默认 C 调或 90 BPM，未设调号不换算级数',()=>{
  const dom=new JSDOM('<!doctype html>');globalThis.document=dom.window.document;
  try {
    const song=createBlankSong();const chart=renderChart(song,{mode:'preview'});
    assert.equal(chart.querySelector('.paper__title').textContent,'');assert.equal(chart.querySelectorAll('.fact').length,0);
    const editor=renderChart(song,{mode:'edit'});assert.equal(editor.querySelector('.paper__title').textContent,'歌名');
    song.layout.displayLines=['degree'];const display=eventDisplayLines({kind:'chord',chord:chord('C')},song);
    assert.equal(display.lines[0].text,'C');assert.match(display.note,/填写/);
    assert.doesNotMatch(songToChordPro(song),/\{(?:key|tempo|time):/);
    assert.throws(()=>songToABC(song),/填写调号和拍号/);
  } finally {delete globalThis.document;dom.window.close();}
});

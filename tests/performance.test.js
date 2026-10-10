import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, buildBeatTimeline } from '../src/ui/player.js';
import { normalizePerformancePrefs, paginateRows } from '../src/ui/performance.js';
import { createSong } from '../src/core/song.js';

test('弱起与重复段的视觉强拍回到小节开头，6/8 每小节六个拍点', () => {
  const song=createSong({timeSignature:'6/8',capo:2,sections:[{name:'主歌',repeat:2,bars:[
    {type:'chords',length:1.5,events:[{kind:'chord',chord:{root:'C'},beats:1.5}]},
    {type:'chords',events:[{kind:'chord',chord:{root:'G'},beats:6}]},
  ]}]});
  const timeline=buildTimeline(song);
  const beats=buildBeatTimeline(timeline);
  assert.deepEqual(beats.filter((beat)=>beat.beat===0).map((beat)=>beat.at),[0,1.5,7.5,9]);
  assert.deepEqual(beats.filter((beat)=>beat.barNumber===2).map((beat)=>beat.at),[1.5,2.5,3.5,4.5,5.5,6.5]);
  assert.equal(timeline.beats,15);
  assert.ok(timeline.chords[0].pitches.includes(50),'capo 后的低音也跟随实际音高');
});

test('现场分页保留每一整行，谱头占用首屏的高度', () => {
  const rows=[
    {top:100,bottom:210,ids:['a','b']},
    {top:230,bottom:330,ids:['c','d']},
    {top:345,bottom:480,ids:['e','f']},
    {top:500,bottom:630,ids:['g']},
  ];
  const pages=paginateRows(rows,340,0);
  assert.deepEqual(pages.map((page)=>page.ids),[['a','b','c','d'],['e','f','g']]);
  assert.deepEqual(pages.flatMap((page)=>page.rows),rows);
  assert.equal(pages[1].top,345);
  assert.deepEqual(paginateRows([{top:0,bottom:900,ids:['oversized']}],300)[0].ids,['oversized']);
});

test('坏的演出偏好回到可用设置，颜色和强度受到限制', () => {
  const prefs=normalizePerformancePrefs({range:'invalid',color:'url(script)',strength:5,flip:'invalid',countdown:999});
  assert.equal(prefs.range,'dots');
  assert.equal(prefs.color,'#4a7c59');
  assert.equal(prefs.strength,.35);
  assert.equal(prefs.flip,'manual');
  assert.equal(prefs.countdown,3);
  assert.deepEqual(normalizePerformancePrefs({silent:true,flip:'follow'}).silent,true);
});

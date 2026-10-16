import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
function load(c,name){const m=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(script);const end=script.indexOf('\n}',m.index)+2;vm.runInContext(script.slice(m.index,end),c);}
function harness(api){
  const now=Date.parse('2026-10-07T09:00:00Z'),day=Date.parse('2026-10-07T00:00:00+08:00'),nodes=new Map(),notices=[],plays=[];
  const state={playRequestId:10,segmentRequestId:1,selectedCamera:'d2',playbackSource:'mediamtx',previewMode:'live',date:'2026-10-06'};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const c=vm.createContext({state,$,api,URLSearchParams,Date:class extends Date{static now(){return now;}},today:()=> '2026-10-07',dateStart:()=>day,segmentBounds:s=>({start:Date.parse(s.start),end:Date.parse(s.start)+s.duration*1000}),clearReplay(){state.playRequestId++;state.previewMode='replay';},clearMarkedRange(){state.cleared=true;},updatePlaybackContext(){},syncReplayToggle(){},setPlaybackNotice:t=>notices.push(t),setTimelineWindow:t=>{state.cursorMs=t;},wallTime:t=>new Date(t).toISOString(),playAt:async(start,{autoplay})=>{plays.push({start,autoplay});state.playRequestId++;state.playBounds={start,duration:10};}});
  load(c,'showLastRecordingFrame');load(c,'finishLastRecordingFrame');return {c,state,$,notices,plays,day,now};
}
test('offline live selects only today and seeks the latest available recording paused',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-06T15:00:00Z',duration:30},{start:'2026-10-07T08:59:00Z',duration:30},{start:'2026-10-07T08:00:00Z',duration:30}]}));
  await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.plays.length,1);assert.equal(h.plays[0].start,Date.parse('2026-10-07T08:59:20Z'));assert.equal(h.plays[0].autoplay,false);assert.equal(h.state.date,'2026-10-07');assert.equal(h.state.previewMode,'last-frame');assert.equal(h.state.cleared,true);
  let paused=0;Object.assign(h.$('replay-player'),{src:'same',currentSrc:'same',duration:10,seekable:{length:1,start:()=>0,end:()=>10},currentTime:0,readyState:2,seeking:false,pause(){paused++;}});
  h.c.finishLastRecordingFrame();assert.equal(h.$('replay-player').currentTime,9.999);h.c.finishLastRecordingFrame();assert.equal(paused,1);assert.match(h.notices.at(-1),/今日最后录像画面/);assert.equal(h.state.lastFramePending,null);
});
test('no recording today never substitutes a previous-day frame',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-06T10:00:00Z',duration:600}]}));await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.plays.length,0);assert.match(h.notices.at(-1),/今天也没有/);
});
test('late fallback cannot replace a newer channel or replay intent',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));const work=h.c.showLastRecordingFrame(10,'d2');h.state.playRequestId++;h.state.selectedCamera='d1';finish({segments:[{start:'2026-10-07T08:59:00Z',duration:30}]});await work;assert.equal(h.plays.length,0);assert.equal(h.state.selectedCamera,'d1');
});
test('a format retry resets the last-frame seek against the new source',()=>{
  const h=harness();h.state.previewMode='last-frame';h.state.playBounds={start:0,duration:10};h.state.lastFramePending={requestId:10,end:10000,seeking:true,src:'old'};
  Object.assign(h.$('replay-player'),{src:'new',currentSrc:'new',duration:8,seekable:{length:1,start:()=>0,end:()=>8},readyState:2,currentTime:0});h.c.finishLastRecordingFrame();assert.equal(h.$('replay-player').currentTime,7.999);assert.equal(h.state.lastFramePending.src,'new');
});

test('clearing live closes its reader and leaves a replay state that exposes reconnect',()=>{
  const h=harness(); let closed=0;h.state.mediaLive={close(){closed++;}};
  Object.assign(h.$('replay-player'),{srcObject:{},pause(){},removeAttribute(){},load(){}});
  h.c.stopHlsPreview=()=>{};load(h.c,'clearReplay');h.c.clearReplay();
  assert.equal(closed,1);assert.equal(h.state.mediaLive,null);assert.equal(h.state.previewMode,'replay');assert.equal(h.$('replay-player').srcObject,null);assert.equal(h.$('replay-player').hidden,true);
});

test('logout invalidates a live or pending last-frame preview before hiding the console',()=>{
  const state={mediaLive:{},playRequestId:1};let clears=0;
  const c=vm.createContext({interruptTimelineScrub(){},state,clearReplay(){clears++;state.mediaLive=null;state.playRequestId++;},uploadAccounts:{stop(){}},document:{body:{dataset:{view:'replay'}}},outputRequest: 0, stateRequest: 0, consoleSession: 0, outputDetail: null, settingsInline: null, outputFeed: null, outputFilter: null, outputPlayers:{destroy(){}},outputCards:new Map(),$:()=>({replaceChildren(){}}),activeDialog:null,configEditor:null,clearTimeout(){},clockTimer:null,setAuthMode(){},setConnection(){}});
  load(c,'loggedOut');c.loggedOut();assert.equal(clears,1);assert.equal(state.mediaLive,null);assert.equal(state.playRequestId,2);
});

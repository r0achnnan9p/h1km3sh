import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
function load(c,name){const m=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(script);const end=script.indexOf('\n}',m.index)+2;vm.runInContext(script.slice(m.index,end),c);}
function harness(api, overrides = {}){
  const now=Date.parse('2026-10-07T09:00:00Z'),day=Date.parse('2026-10-07T00:00:00+08:00'),nodes=new Map(),notices=[],plays=[];
  const state={playRequestId:10,segmentRequestId:1,selectedCamera:'d2',playbackSource:'mediamtx',previewMode:'live',date:'2026-10-06',inMs:Date.parse('2026-10-06T08:00:00Z'),outMs:Date.parse('2026-10-06T08:00:10Z'),...overrides};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const c=vm.createContext({state,$,api,cancelReplayHold(){},interruptTimelineScrub(){},URLSearchParams,Date:class extends Date{static now(){return now;}},today:()=> '2026-10-07',dateStart:date=>Date.parse(`${date}T00:00:00+08:00`),segmentBounds:s=>({start:Date.parse(s.start),end:Date.parse(s.start)+s.duration*1000}),clearReplay(){state.playRequestId++;state.previewMode='replay';},clearMarkedRange(){state.cleared=true;state.inMs=null;state.outMs=null;},updatePlaybackContext(){},syncReplayToggle(){},setPlaybackNotice:t=>notices.push(t),setTimelineWindow:t=>{state.cursorMs=t;},wallTime:t=>new Date(t).toISOString(),playAt:async(start,{autoplay})=>{plays.push({start,autoplay});state.playRequestId++;state.playBounds={start,duration:10};}});
  $('date-select').value=state.date;
  load(c,'showLastRecordingFrame');load(c,'finishLastRecordingFrame');return {c,state,$,notices,plays,day,now};
}
test('offline live on today seeks the latest available recording paused without clearing marks',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-06T15:00:00Z',duration:30},{start:'2026-10-07T08:59:00Z',duration:30},{start:'2026-10-07T08:00:00Z',duration:30}]}),{date:'2026-10-07'});
  await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.plays.length,1);assert.equal(h.plays[0].start,Date.parse('2026-10-07T08:59:20Z'));assert.equal(h.plays[0].autoplay,false);assert.equal(h.state.date,'2026-10-07');assert.equal(h.state.previewMode,'last-frame');assert.equal(h.state.cleared,undefined);
  let paused=0;Object.assign(h.$('replay-player'),{src:'same',currentSrc:'same',duration:10,seekable:{length:1,start:()=>0,end:()=>10},currentTime:0,readyState:2,seeking:false,pause(){paused++;}});
  h.c.finishLastRecordingFrame();assert.equal(h.$('replay-player').currentTime,9.999);h.c.finishLastRecordingFrame();assert.equal(paused,1);assert.match(h.notices.at(-1),/今日最后录像画面/);assert.equal(h.state.lastFramePending,null);
});
test('no recording today never substitutes a previous-day frame',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-06T10:00:00Z',duration:600}]}),{date:'2026-10-07'});await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.plays.length,0);assert.match(h.notices.at(-1),/今天也没有/);
});
function selection(h) { return { date:h.state.date, input:h.$('date-select').value, inMs:h.state.inMs, outMs:h.state.outMs }; }
const historicalSegments = [{start:'2026-10-06T08:59:00Z',duration:30}];

for (const [name,marks] of [['both marks',{}],['only an in point',{outMs:null}],['only an out point',{inMs:null}],['no marks',{inMs:null,outMs:null}]]) {
  test(`D1/D2 offline fallback preserves the historical date and ${name}`,async()=>{
    const urls=[];const h=harness(async url=>{urls.push(url);return {segments:historicalSegments};},marks);const before=selection(h);
    for (const camera of ['d1','d2','d1']) {
      h.state.selectedCamera=camera;h.state.playRequestId++;h.state.previewMode='live';
      await h.c.showLastRecordingFrame(h.state.playRequestId,camera);
      assert.deepEqual(selection(h),before);assert.equal(h.state.previewMode,'last-frame');
      assert.equal(h.plays.at(-1).start,Date.parse('2026-10-06T08:59:20Z'));assert.equal(h.plays.at(-1).autoplay,false);
      assert.equal(urls.at(-1),`/console/api/playback/${camera}/segments?date=2026-10-06`);
    }
    Object.assign(h.$('replay-player'),{src:'same',currentSrc:'same',duration:10,seekable:{length:1,start:()=>0,end:()=>10},currentTime:0,readyState:2,seeking:false,pause(){}});
    h.c.finishLastRecordingFrame();h.c.finishLastRecordingFrame();
    assert.match(h.notices.at(-1),/所选日期最后录像画面/);assert.deepEqual(selection(h),before);
  });
}

test('no recording on the selected historical date preserves selection without substituting today',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-07T08:59:00Z',duration:30}]}));const before=selection(h);
  await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.plays.length,0);assert.deepEqual(selection(h),before);assert.match(h.notices.at(-1),/所选日期也没有/);
});

test('a failed historical recording request preserves date and marks',async()=>{
  const h=harness(async()=>{throw new Error('recording lookup failed');});const before=selection(h);
  await assert.rejects(h.c.showLastRecordingFrame(10,'d2'),/recording lookup failed/);assert.equal(h.plays.length,0);assert.deepEqual(selection(h),before);
});

test('historical fallback clips a recording crossing midnight to the selected day',async()=>{
  const h=harness(async()=>({segments:[{start:'2026-10-06T15:59:55Z',duration:30}]}));
  await h.c.showLastRecordingFrame(10,'d2');assert.equal(h.state.lastFramePending.end,Date.parse('2026-10-07T00:00:00+08:00'));assert.equal(h.plays[0].start,Date.parse('2026-10-06T15:59:55Z'));
});

const newerIntents = {
  request:h=>{h.state.playRequestId++;},
  camera:h=>{h.state.selectedCamera='d1';},
  source:h=>{h.state.playbackSource='dvr';},
  date:h=>{h.state.date='2026-10-05';h.$('date-select').value=h.state.date;},
};
for (const [name,change] of Object.entries(newerIntents)) {
  test(`late recording lookup cannot replace a newer ${name} selection`,async()=>{
    let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));const work=h.c.showLastRecordingFrame(10,'d2');
    change(h);const before=selection(h);finish({segments:historicalSegments});await work;
    assert.equal(h.plays.length,0);assert.deepEqual(selection(h),before);
  });
  test(`late preview completion cannot mark a newer ${name} selection as last-frame`,async()=>{
    let finish;const h=harness(async()=>({segments:[...historicalSegments,{start:'2026-10-07T08:59:00Z',duration:30}]}));
    h.c.playAt=()=>{h.state.playRequestId++;return new Promise(resolve=>{finish=resolve;});};
    const work=h.c.showLastRecordingFrame(10,'d2');await new Promise(setImmediate);assert.equal(typeof finish,'function');
    change(h);const before=selection(h);finish();await work;
    assert.notEqual(h.state.previewMode,'last-frame');assert.equal(h.state.lastFramePending,undefined);assert.deepEqual(selection(h),before);
  });
}
test('a format retry resets the last-frame seek against the new source',()=>{
  const h=harness();h.state.previewMode='last-frame';h.state.playBounds={start:0,duration:10};h.state.lastFramePending={requestId:10,end:10000,seeking:true,src:'old'};
  Object.assign(h.$('replay-player'),{src:'new',currentSrc:'new',duration:8,seekable:{length:1,start:()=>0,end:()=>8},readyState:2,currentTime:0});h.c.finishLastRecordingFrame();assert.equal(h.$('replay-player').currentTime,7.999);assert.equal(h.state.lastFramePending.src,'new');
});

test('clearing live closes its reader and leaves a replay state that exposes reconnect',()=>{
  const h=harness();const before=selection(h); let closed=0;h.state.mediaLive={close(){closed++;}};
  Object.assign(h.$('replay-player'),{srcObject:{},pause(){},removeAttribute(){},load(){}});
  h.c.stopHlsPreview=()=>{};load(h.c,'clearReplay');h.c.clearReplay();
  assert.equal(closed,1);assert.equal(h.state.mediaLive,null);assert.equal(h.state.previewMode,'replay');assert.equal(h.$('replay-player').srcObject,null);assert.equal(h.$('replay-player').hidden,true);assert.deepEqual(selection(h),before);
});

test('logout invalidates a live or pending last-frame preview before hiding the console',()=>{
  const state={mediaLive:{},playRequestId:1};let clears=0;
  const c=vm.createContext({interruptTimelineScrub(){},cancelReplayHold(){},cancelExportSubmission(){},pendingTaskFocus:null,state,clearReplay(){clears++;state.mediaLive=null;state.playRequestId++;},uploadAccounts:{stop(){}},document:{body:{dataset:{view:'replay'}}},outputRequest: 0, stateRequest: 0, consoleSession: 0, outputDetail: null, settingsInline: null, outputFeed: null, outputFilter: null, outputPlayers:{destroy(){}},outputCards:new Map(),$:()=>({replaceChildren(){}}),activeDialog:null,configEditor:null,clearTimeout(){},clockTimer:null,setAuthMode(){},setConnection(){}});
  load(c,'loggedOut');c.loggedOut();assert.equal(clears,1);assert.equal(state.mediaLive,null);assert.equal(state.playRequestId,2);
});

import { findCoverageGap, countCoverageGaps } from '../public/playback-coverage.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { iconSvg, setButtonIcon } from '../public/ui-primitives.js';
const code = fs.readFileSync(new URL('../public/console.js', import.meta.url),'utf8');
class Element {
  style={}; children=[]; listeners={}; textContent=''; disabled=false; innerHTML=''; attrs={};
  classes=new Set(); classList={ add: name=>this.classes.add(name), remove: name=>this.classes.delete(name), contains: name=>this.classes.has(name), toggle: (name,on)=>on?this.classes.add(name):this.classes.delete(name) };
  setAttribute(key,value) { this.attrs[key]=value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  addEventListener(type,fn) { this.listeners[type]=fn; }
}
function harness() {
  const elements=new Map(), requests=[], navigations=[], timers=new Map(); let id=0, refreshes=0;
  const $=key=>{if(!elements.has(key)) elements.set(key,new Element()); return elements.get(key);};
  const state={ busy:false, playbackSource:'mediamtx', selectedCamera:'D2', inMs:10000, outMs:20000, activeTaskCount:7 };
  const context=vm.createContext({ $,state,iconSvg,setButtonIcon,document:{createElement:()=>new Element()}, leaveReplayFullscreen:async()=>true, navigate:view=>navigations.push(view), hasPlaybackSelection:()=>true, body:JSON.stringify, wallTime:ms=>'2026-10-01 12:00:'+String(ms/1000), api:async(url,options)=>{requests.push({url,payload:JSON.parse(options.body)});return {status:'queued'};}, refreshState:async()=>{refreshes++;}, updateSelection(){$('export-range').disabled=state.busy;}, setTimeout(fn){timers.set(++id,fn);return id;}, clearTimeout(key){timers.delete(key);} });
  vm.runInContext('let toastTimer;'+code.slice(code.indexOf('function notify('),code.indexOf('async function api(')),context);
  vm.runInContext(code.slice(code.indexOf("$('export-range').addEventListener('click'"),code.indexOf('function confirmIncompleteExport(')),context);
  return { $,state,context,requests,navigations,timers,refreshes:()=>refreshes,export:()=>$('export-range').listeners.click(),flush(){for(const fn of [...timers.values()])fn();timers.clear();} };
}
test('successful export stays on replay, uses original range and only explicit toast arrow opens tasks',async()=>{
  const h=harness(); await h.export();
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].payload.start,'2026-10-01 12:00:10'); assert.equal(h.requests[0].payload.end,'2026-10-01 12:00:20');
  assert.deepEqual(h.navigations,[]); assert.equal(h.state.activeTaskCount,7); assert.equal(h.refreshes(),1); assert.equal(h.state.busy,false);
  const toast=h.$('toast'); assert.equal(toast.children[1].children[1].textContent,'12:00:10 → 12:00:20');
  assert.equal(h.$('export-range').classList.contains('submitted'),true); assert.equal(h.$('export-range').attrs['aria-label'],'已提交');
  await toast.children[2].listeners.click(); assert.deepEqual(h.navigations,['tasks']);
  h.flush(); assert.equal(h.$('export-range').classList.contains('submitted'),false); assert.equal(h.$('export-range').attrs['aria-label'],'导出选中片段');
});
test('pending export prevents duplicate requests; failure preserves selection without success toast or navigation',async()=>{
  const h=harness();let reject;
  h.context.api=(url,options)=>{h.requests.push({url,options});return new Promise((resolve,failure)=>{reject=failure;});};
  const first=h.export();await h.export();assert.equal(h.requests.length,1);assert.equal(h.$('export-range').disabled,true);
  reject(new Error('fixture failure'));await first;
  assert.equal(h.$('toast').textContent,'fixture failure');assert.equal(h.$('toast').classList.contains('error'),true);assert.equal(h.$('export-range').classList.contains('submitted'),false);
  assert.deepEqual(h.navigations,[]);assert.equal(h.state.inMs,10000);assert.equal(h.state.outMs,20000);assert.equal(h.state.activeTaskCount,7);assert.equal(h.$('export-range').disabled,false);
});
test('upload success stays in library, flashes its visible trigger and links the submitted filename',async()=>{
  const h=harness(),actions=new Element(),sheet={actions,setPending(){},close(){this.closed=true;},error:new Element()};
  h.context.window={consoleSettings:{cloud189TargetPath:'/fixture'}};h.context.pendingUploads=new Set();h.context.openDialog=()=>sheet;
  h.context.addButton=(parent,label,cls,action)=>{const button=new Element();button.listeners.click=action;parent.append(button);return button;};
  vm.runInContext(code.slice(code.indexOf('async function upload('),code.indexOf('async function refreshOutputs(')),h.context);
  const trigger=new Element();await h.context.upload({id:'fixture-output',filename:'synthetic.mp4'},'cloud189',trigger);await actions.children[0].listeners.click();
  assert.equal(sheet.closed,true);assert.deepEqual(h.navigations,[]);assert.equal(trigger.classList.contains('submitted'),true);assert.equal(h.$('toast').children[1].children[1].textContent,'synthetic.mp4');
  assert.equal(h.requests[0].url,'/console/api/outputs/fixture-output/upload/cloud189');assert.equal(h.state.activeTaskCount,7);
});

test('export bar gap warning counts local intervals, clears stale counts and leaves server consent required',()=>{
  const h=harness();Object.assign(h.state,{inMs:0,outMs:100,segments:[{startMs:10,endMs:20},{startMs:18,endMs:40},{startMs:60,endMs:80}],playbackSource:'mediamtx'});
  Object.assign(h.context,{findCoverageGap,countCoverageGaps,updateBoundaryControls(){},formatClipDuration:String,dateStart:()=>0,timelineWindow:()=>({start:0,end:100,span:100}),timelinePercent:(value,start,span)=>(value-start)/span*100});
  vm.runInContext(code.slice(code.indexOf('function updateSelection('),code.indexOf('function clearReplay(')),h.context);
  h.context.updateSelection();assert.equal(h.$('selection-gap-warning').hidden,false);assert.equal(h.$('selection-gap-count').textContent,'3');assert.match(h.$('selection-gap-warning').attrs['aria-label'],/3 处录像缺口/);assert.equal(h.requests.length,0);assert.equal(h.$('export-range').disabled,false);
  h.state.segments=[{startMs:0,endMs:100}];h.context.updateSelection();assert.equal(h.$('selection-gap-warning').hidden,true);assert.equal(h.$('selection-gap-count').textContent,'0');
  h.state.segments=[];h.state.playbackSource='dvr';h.context.updateSelection();assert.equal(h.$('selection-gap-warning').hidden,true);
  h.state.playbackSource='mediamtx';h.state.outMs=null;h.context.updateSelection();assert.equal(h.$('selection-gap-warning').hidden,true);assert.equal(h.$('export-range').disabled,true);assert.equal(h.state.activeTaskCount,7);
});

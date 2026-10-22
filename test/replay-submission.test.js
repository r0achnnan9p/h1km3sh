import { listCoverageGaps } from '../public/playback-coverage.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { iconSvg, setButtonIcon } from '../public/ui-primitives.js';
const code = fs.readFileSync(new URL('../public/console.js', import.meta.url),'utf8');
class Element {
  style={}; children=[]; listeners={}; textContent=''; disabled=false; hidden=false; attrs={};
  classes=new Set(); classList={ add: name=>this.classes.add(name), remove: name=>this.classes.delete(name), contains: name=>this.classes.has(name), toggle: (name,on)=>on?this.classes.add(name):this.classes.delete(name) };
  get innerHTML() { return this.html || ''; }
  set innerHTML(value) { this.html=value; this.children=[]; this.textContent=''; }
  setAttribute(key,value) { this.attrs[key]=value; }
  getAttribute(key) { return this.attrs[key]; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  addEventListener(type,fn) { this.listeners[type]=fn; }
}
function harness() {
  const elements=new Map(), requests=[], navigations=[], timers=new Map(); let id=0, refreshes=0;
  const $=key=>{if(['selection-gap-warning','selection-gap-count'].includes(key)) return null;if(!elements.has(key)) { const element=new Element(); element.id=key; elements.set(key,element); } return elements.get(key);};
  const state={ busy:false, playbackSource:'mediamtx', selectedCamera:'D2', date:'2026-10-01', playbackSelectionVersion:1, configRevision:'fixture-revision', inMs:10000, outMs:20000, segments:[{startMs:10000,endMs:20000}], activeTaskCount:7 };
  const document={body:{dataset:{view:'replay'}},createElement:()=>new Element()};
  const context=vm.createContext({ $,state,iconSvg,setButtonIcon,listCoverageGaps,AbortController,consoleSession:1,exportSubmission:null,pendingTaskFocus:null,document,
    window:{matchMedia:()=>({matches:false})},taskFeeds:{exports:{resume(){},reveal(){return false;}},uploads:{resume(){},reveal(){return false;}}},
    leaveReplayFullscreen:async()=>true, navigate:view=>{navigations.push(view);document.body.dataset.view=view;}, body:JSON.stringify, wallTime:ms=>'2026-10-01 12:00:'+String(ms/1000), api:async(url,options)=>{requests.push({url,options,payload:JSON.parse(options.body)});return url.includes('/upload/')?{job:{id:'fixture-upload'},status:'queued'}:{taskId:'fixture-export',status:'queued'};}, refreshState:async()=>{refreshes++;}, updateSelection(){$('export-range').disabled=state.busy;}, setTimeout(fn){timers.set(++id,fn);return id;}, clearTimeout(key){timers.delete(key);} });
  vm.runInContext(code.slice(code.indexOf('function hasPlaybackSelection('),code.indexOf('function invalidatePlaybackSelection(')),context);
  vm.runInContext(code.slice(code.indexOf('function playbackContextKey('),code.indexOf('function updateSelection(')),context);
  vm.runInContext('let toastTimer;'+code.slice(code.indexOf('function notify('),code.indexOf('async function api(')),context);
  vm.runInContext(code.slice(code.indexOf("$('export-range').addEventListener('click'"),code.indexOf('function confirmIncompleteExport(')),context);
  vm.runInContext(code.slice(code.indexOf('function rememberSubmittedTask('),code.indexOf('function syncTaskLayout(')),context);
  return { $,state,context,requests,navigations,timers,refreshes:()=>refreshes,export:()=>$('export-range').listeners.click(),flush(){for(const fn of [...timers.values()])fn();timers.clear();} };
}
test('successful export stays on replay, uses original range and only explicit toast arrow opens tasks',async()=>{
  const h=harness(); await h.export();
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].payload.start,'2026-10-01 12:00:10'); assert.equal(h.requests[0].payload.end,'2026-10-01 12:00:20');
  assert.deepEqual(h.navigations,[]); assert.equal(h.state.activeTaskCount,7); assert.equal(h.refreshes(),1); assert.equal(h.state.busy,false);
  assert.equal(h.context.document.body.dataset.view,'replay'); assert.equal(h.context.exportSubmission,null);
  assert.equal(h.requests[0].options.signal.aborted,false); assert.equal(h.context.pendingTaskFocus.kind,'exports'); assert.equal(h.context.pendingTaskFocus.id,'fixture-export');
  const toast=h.$('toast'); assert.equal(toast.children[1].children[1].textContent,'12:00:10 → 12:00:20');
  assert.equal(h.$('export-range').classList.contains('submitted'),true); assert.equal(h.$('export-range').attrs['aria-label'],'已提交');
  assert.equal(h.$('export-range').children.includes('已提交'),true);
  await toast.children[2].listeners.click(); assert.deepEqual(h.navigations,['tasks']); assert.equal(h.$('task-tab-export').attrs['aria-selected'],'true');
  h.flush(); assert.equal(h.$('export-range').classList.contains('submitted'),false); assert.equal(h.$('export-range').attrs['aria-label'],'导出选中片段');
  assert.equal(h.$('export-range').children.includes('已提交'),false);assert.equal(h.$('export-range').children.includes('导出'),true);
});
test('pending export prevents duplicate requests; failure preserves selection without success toast or navigation',async()=>{
  const h=harness();let reject;
  h.context.api=(url,options)=>{h.requests.push({url,options});return new Promise((resolve,failure)=>{reject=failure;});};
  const first=h.export();await h.export();assert.equal(h.requests.length,1);assert.equal(h.$('export-range').disabled,true);
  reject(new Error('fixture failure'));await first;
  assert.equal(h.$('toast').textContent,'fixture failure');assert.equal(h.$('toast').classList.contains('error'),true);assert.equal(h.$('export-range').classList.contains('submitted'),false);
  assert.deepEqual(h.navigations,[]);assert.equal(h.state.inMs,10000);assert.equal(h.state.outMs,20000);assert.equal(h.state.activeTaskCount,7);assert.equal(h.$('export-range').disabled,false);
  assert.equal(h.context.exportSubmission,null);assert.equal(h.context.pendingTaskFocus,null);assert.equal(h.state.busy,false);
});
test('upload success stays in library, flashes its visible trigger and links the submitted filename',async()=>{
  const h=harness(),actions=new Element(),sheet={actions,setPending(){},close(){this.closed=true;},error:new Element()};
  h.context.document.body.dataset.view='library';
  h.context.window={consoleSettings:{cloud189TargetPath:'/fixture'}};h.context.pendingUploads=new Set();h.context.openDialog=()=>sheet;
  h.context.addButton=(parent,label,cls,action)=>{const button=new Element();button.listeners.click=action;parent.append(button);return button;};
  vm.runInContext(code.slice(code.indexOf('async function upload('),code.indexOf('async function refreshOutputs(')),h.context);
  const trigger=new Element();await h.context.upload({id:'fixture-output',filename:'synthetic.mp4'},'cloud189',trigger);await actions.children[0].listeners.click();
  assert.equal(sheet.closed,true);assert.deepEqual(h.navigations,[]);assert.equal(trigger.classList.contains('submitted'),true);assert.equal(h.$('toast').children[1].children[1].textContent,'synthetic.mp4');
  assert.equal(h.requests[0].url,'/console/api/outputs/fixture-output/upload/cloud189');assert.equal(h.state.activeTaskCount,7);
  assert.equal(h.context.document.body.dataset.view,'library');assert.equal(h.context.pendingTaskFocus.kind,'uploads');assert.equal(h.context.pendingTaskFocus.id,'fixture-upload');
  await h.$('toast').children[2].listeners.click();assert.deepEqual(h.navigations,['tasks']);assert.equal(h.$('task-tab-upload').attrs['aria-selected'],'true');
});

test('editing a range updates export readiness without scanning gaps until export confirmation is needed',()=>{
  const h=harness();let coverageReads=0;
  Object.assign(h.state,{inMs:0,outMs:100,segments:[{startMs:10,endMs:20},{startMs:18,endMs:40},{startMs:60,endMs:80}],playbackSource:'mediamtx'});
  Object.assign(h.context,{updateBoundaryControls(){},formatClipDuration:String,dateStart:()=>0,timelineWindow:()=>({start:0,end:100,span:100}),timelinePercent:(value,start,span)=>(value-start)/span*100,
    listCoverageGaps:(...args)=>{coverageReads++;return listCoverageGaps(...args);}});
  vm.runInContext(code.slice(code.indexOf('function updateSelection('),code.indexOf('function clearReplay(')),h.context);
  h.context.updateSelection();
  assert.equal(coverageReads,0);assert.equal(h.requests.length,0);assert.equal(h.$('export-range').disabled,false);
  const coverage=h.context.selectedGapCoverage();
  assert.equal(coverageReads,1);assert.equal(coverage.missingIntervals.length,3);assert.equal(coverage.missingSeconds,0.05);
  assert.deepEqual(Array.from(coverage.missingIntervals, interval=>interval.durationSeconds),[0.01,0.02,0.02]);
  h.state.segments=[{startMs:0,endMs:100}];h.context.updateSelection();
  assert.equal(coverageReads,1);assert.equal(h.$('export-range').disabled,false);
  h.state.segments=[];h.state.playbackSource='dvr';h.context.updateSelection();
  assert.equal(coverageReads,1);assert.equal(h.requests.length,0);
  h.state.playbackSource='mediamtx';h.state.outMs=null;h.context.updateSelection();
  assert.equal(coverageReads,1);assert.equal(h.$('export-range').disabled,true);assert.equal(h.state.activeTaskCount,7);
});

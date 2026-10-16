import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const markup = fs.readFileSync(new URL('../lib/status-dashboard.js', import.meta.url), 'utf8');
const option = (value, textContent, disabled = false) => ({ value, textContent, disabled, cloneNode() { return option(value, textContent, disabled); } });
function harness() {
 const nodes = Object.fromEntries(['playback-source', 'camera-select', 'dvr-channel', 'dvr-select', 'quick-source-select', 'quick-camera-select', 'playback-context', 'playback-context-date', 'date-select', 'player-source-label', 'go-live'].map(id => [id, {value:'',options:[],dataset:{},attrs:{},events:[],replaceChildren(...options){this.options=options;},setAttribute(key,value){this.attrs[key]=value;},dispatchEvent(event){this.events.push(event.type);},focus(){this.focused=true;},get selectedOptions(){return this.options.filter(o=>o.value===this.value);}}]));
 nodes['playback-source'].value='mediamtx'; nodes['date-select'].value='2026-10-01';
 nodes['camera-select'].options=[option('d1','D1'),option('d2','D2')]; nodes['camera-select'].value='d2';
 nodes['dvr-select'].options=[option('a','录像机 A'),option('b','录像机 B')];nodes['dvr-select'].value='a';
 nodes['dvr-channel'].options=[option('101','镜头 1'),option('201','镜头 2')];nodes['dvr-channel'].value='101';
 const state={date:'2026-10-01',playbackSource:'mediamtx',selectedCamera:'d2',inMs:1,outMs:2,segments:['old']};
 const document={body:{dataset:{view:'replay'}},createElement:()=>option('','')};
 const ctx=vm.createContext({$:id=>nodes[id],state,document,Event,hasPlaybackSelection:()=>true,today:()=>state.date});
 vm.runInContext(script.slice(script.indexOf('function updatePlaybackContext('),script.indexOf('function setupTouchControls(')),ctx);
 return {nodes,state,document,ctx,update:()=>ctx.updatePlaybackContext()};
}
test('top controls mirror one combined source/recorder and one camera picker',()=>{
 const {nodes,update}=harness();update();
 assert.deepEqual(Array.from(nodes['quick-source-select'].options,o=>o.value),['mediamtx','dvr:a','dvr:b']);
 assert.equal(nodes['quick-camera-select'].value,'d2'); assert.equal(nodes['quick-camera-select'].options.length,2);
 nodes['playback-source'].value='dvr';update();
 assert.equal(nodes['quick-source-select'].value,'dvr:a'); assert.equal(nodes['quick-camera-select'].value,'101');
 assert.equal(nodes['quick-camera-select'].options[1].textContent,'镜头 2');
 assert.equal(nodes['playback-context-date'].textContent,'10-01'); assert.match(nodes['playback-context'].attrs['aria-label'],/2026-10-01/);
});
test('direct source changes dispatch exactly the canonical source or recorder event',()=>{
 const h=harness();h.nodes['quick-source-select'].value='dvr:b';h.ctx.changeQuickPlaybackSource();
 assert.equal(h.nodes['playback-source'].value,'dvr');assert.equal(h.nodes['dvr-select'].value,'b');assert.deepEqual(h.nodes['playback-source'].events,['change']);
 h.nodes['quick-source-select'].value='dvr:a';h.ctx.changeQuickPlaybackSource();assert.deepEqual(h.nodes['dvr-select'].events,['change']);
 h.nodes['quick-source-select'].value='dvr:missing';h.ctx.changeQuickPlaybackSource();assert.equal(h.nodes['dvr-select'].value,'a');
 h.nodes['quick-source-select'].value='mediamtx';h.ctx.changeQuickPlaybackSource();assert.equal(h.nodes['playback-source'].value,'mediamtx');assert.equal(h.nodes['playback-source'].events.length,2);
});
test('date opens only its calendar; recovery focuses direct source controls with no long sheet',()=>{
 const h=harness();let calendar;h.ctx.openCalendar=value=>{calendar=value;};
 h.ctx.openPlaybackDate();assert.equal(calendar.value,'2026-10-01');assert.equal(calendar.description,'');
 calendar.onSelect('2026-09-30');assert.equal(h.nodes['date-select'].value,'2026-09-30');assert.deepEqual(h.nodes['date-select'].events,['change']);
 h.ctx.openPlaybackConfiguration();assert.equal(h.nodes['quick-source-select'].focused,true);
 assert.ok(!script.includes("openDialog('回放选择'"));
});
test('top camera picker disables when source has no available channels',()=>{
 const {nodes,update}=harness();nodes['camera-select'].disabled=true;update();assert.equal(nodes['quick-camera-select'].disabled,true);
 nodes['camera-select'].disabled=false;nodes['camera-select'].options=[];update();assert.equal(nodes['quick-camera-select'].disabled,true);
});
test('discovery replacement clears markers and stale coverage before loading its new source',async()=>{
 for(const source of ['mediamtx','dvr']){
  const h=harness();h.state.playbackSource=source;h.nodes['playback-source'].value=source;let loaded=0;
  Object.assign(h.ctx,{api:async()=>({}),fillCameras(){h.state.selectedCamera='d1';},fillDvrDevices(){h.nodes['dvr-select'].value='b';},clearMarkedRange(){h.state.inMs=h.state.outMs=null;},invalidatePlaybackSelection(){h.state.segments=[];},loadDvrChannels:async()=>{},loadSegments:async()=>{assert.equal(h.state.inMs,null);assert.equal(h.state.segments.length,0);loaded++;},setPlaybackNotice:message=>assert.fail(message)});
  await h.ctx.refreshPlaybackChoices();assert.equal(loaded,1);
 }
});
test('discovery cannot replace a newer selection or hidden replay view',async()=>{
 for(const mutate of [h=>{h.state.selectedCamera='d1';},h=>{h.document.body.dataset.view='settings';}]){
  const h=harness();let resolve;Object.assign(h.ctx,{api:()=>new Promise(done=>{resolve=done;}),fillCameras:()=>assert.fail('stale discovery applied'),fillDvrDevices:()=>assert.fail('stale discovery applied'),setPlaybackNotice:()=>assert.fail('stale error applied')});
  const pending=h.ctx.refreshPlaybackChoices();mutate(h);resolve({});await pending;
 }
});
test('source/camera/date are compact independent controls with preserved navigation accessibility',()=>{
 const nav=markup.slice(markup.indexOf('<nav class="mobile-nav"'),markup.indexOf('</nav>',markup.indexOf('<nav class="mobile-nav"')));
 for(const label of ['回放','成片','任务','设置']) {assert.ok(nav.includes(`aria-label="${label}"`));assert.ok(!nav.includes(`</span>${label}</button>`));}
 assert.ok(markup.includes('id="quick-camera-select" aria-label="切换镜头"'));
 assert.ok(markup.includes('id="quick-source-select" aria-label="选择录像来源和录像机"'));
 assert.ok(!markup.includes('id="playback-context-camera"'));
 const css=fs.readFileSync(new URL('../public/console.css',import.meta.url),'utf8');
 assert.match(css,/grid-template-columns: minmax\(0, 1.2fr\) minmax\(0, 1fr\) auto/);
 assert.match(css,/#quick-camera-select, #quick-source-select \{[^}]*min-height: 44px;[^}]*font-size: 16px/);
});

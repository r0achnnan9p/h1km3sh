import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { iconSvg, setButtonIcon } from '../public/ui-primitives.js';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
class Element {
  children=[]; attrs={}; listeners={}; classes=new Set();
  classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};
  append(...nodes) { for(const node of nodes) { if(node.parentElement) node.parentElement.children=node.parentElement.children.filter(child=>child!==node);node.parentElement=this;this.children.push(node); } }
  replaceChildren(...nodes) { for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes); }
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(type,fn){this.listeners[type]=fn;}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
}
function harness(mode='native') {
  const nodes=new Map(['view-replay','replay-overlays','replay-fullscreen','scrub-time-overlay','trim-magnifier','toast'].map(id=>[id,new Element()]));
  let interrupts=0;
  const body=new Element(),view=nodes.get('view-replay'),overlays=nodes.get('replay-overlays'),listeners={},navigation=[];
  body.dataset={view:'replay'};body.append(view,overlays);overlays.append(...['scrub-time-overlay','trim-magnifier','toast'].map(id=>nodes.get(id)));
  const document={body,querySelector:()=>null,querySelectorAll:()=>[],fullscreenElement:null,createElement:()=>new Element(),addEventListener(type,fn){listeners[type]=fn;},async exitFullscreen(){document.fullscreenElement=null;listeners.fullscreenchange?.();}};
  if(mode==='native')view.requestFullscreen=async()=>{document.fullscreenElement=view;listeners.fullscreenchange?.();};
  if(mode==='rejected')view.requestFullscreen=async()=>{throw Error('unavailable');};
  const context=vm.createContext({interruptTimelineScrub(){interrupts++;},document,$:id=>nodes.get(id),iconSvg,setButtonIcon,navigate:page=>navigation.push(page),setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext('let toastTimer;'+script.slice(script.indexOf('function notify('),script.indexOf('async function api(')),context);
  vm.runInContext(script.slice(script.indexOf('// Move shared overlays'),script.indexOf('// 断点只搬运')),context);
  Object.assign(context,{location:{hash:'#replay'},history:{pushState(_state,_title,hash){context.location.hash=hash;navigation.push(hash.slice(1));}},window:{scrollTo(){}},settingsInline:null,outputFeed:null,outputPlayers:{pauseAll(){}},activeDialog:null,clearReplay(){},refreshState:async()=>{},refreshOutputs:async()=>{},loadSettings:async()=>{},loadCache:async()=>{},loadConsoleConfig:async()=>{}});
  vm.runInContext(script.slice(script.indexOf('function navigate('),script.indexOf("\ndocument.querySelectorAll('[data-view]')")),context);
  return{interrupts:()=>interrupts,body,view,overlays,nodes,listeners,document,context,navigation,click:()=>nodes.get('replay-fullscreen').listeners.click()};
}
test('shared Trim/time/toast container is in the template and moves into native fullscreen then restores',async()=>{
  const html=statusDashboardPage();const container=html.slice(html.indexOf('id="replay-overlays"'));
  for(const id of ['scrub-time-overlay','trim-magnifier','toast']) assert.ok(container.includes(`id="${id}"`));
  const h=harness();
  for(let cycle=0;cycle<3;cycle++) {
    await h.click();assert.equal(h.document.fullscreenElement,h.view);assert.equal(h.overlays.parentElement,h.view);
    for(const id of ['scrub-time-overlay','trim-magnifier','toast'])assert.ok(h.view.contains(h.nodes.get(id)));
    assert.equal(h.nodes.get('replay-fullscreen').attrs['aria-label'],'退出全屏回放');
    await h.click();assert.equal(h.overlays.parentElement,h.body);assert.equal(h.document.fullscreenElement,null);assert.equal(h.body.children.filter(node=>node===h.overlays).length,1);
  }
});
test('unsupported or rejected native fullscreen uses CSS expansion with overlays inside and Escape restores',async()=>{
  for(const mode of ['unsupported','rejected']) {
    const h=harness(mode);await h.click();assert.equal(h.view.classList.contains('replay-expanded'),true);assert.equal(h.overlays.parentElement,h.view);
    h.listeners.keydown({key:'Escape'});assert.equal(h.view.classList.contains('replay-expanded'),false);assert.equal(h.overlays.parentElement,h.body);assert.equal(h.nodes.get('replay-fullscreen').attrs['aria-label'],'全屏回放');
    await h.click();await h.click();assert.equal(h.overlays.parentElement,h.body);
  }
});
test('native external exit restores overlays and toast arrow exits both fullscreen modes before navigation',async()=>{
  for(const mode of ['native','unsupported']) {
    const h=harness(mode);await h.click();h.context.notify('已提交',false,{icon:'download',range:'12:00:00 → 12:00:10'});
    const arrow=h.nodes.get('toast').children[2];assert.ok(h.view.contains(arrow));arrow.listeners.click();await settle();
    assert.deepEqual(h.navigation,['tasks']);assert.equal(h.overlays.parentElement,h.body);assert.equal(h.document.fullscreenElement,null);assert.equal(h.view.classList.contains('replay-expanded'),false);
  }
  const h=harness();await h.click();h.document.fullscreenElement=null;h.listeners.fullscreenchange();assert.equal(h.overlays.parentElement,h.body);
});
test('failed native exit keeps overlays in fullscreen and gives an error without navigating into hidden tasks',async()=>{
  const h=harness();await h.click();h.document.exitFullscreen=async()=>{throw Error('blocked');};
  h.context.notify('已提交',false,{range:'fixture range'});h.nodes.get('toast').children[2].listeners.click();await settle();
  assert.equal(h.overlays.parentElement,h.view);assert.deepEqual(h.navigation,[]);assert.equal(h.nodes.get('toast').classList.contains('error'),true);
});
test('rapid fullscreen clicks make one pending request and keep one overlay container',async()=>{
  const h=harness();let resolve,calls=0;h.view.requestFullscreen=()=>{calls++;return new Promise(done=>{resolve=()=>{h.document.fullscreenElement=h.view;done();};});};
  const first=h.click();await h.click();assert.equal(calls,1);resolve();await first;assert.equal(h.view.children.filter(node=>node===h.overlays).length,1);
});

test('route changes leave native/CSS fullscreen before hiding replay; rejected exit preserves replay',async()=>{
  for(const mode of ['native','unsupported']) {
    const h=harness(mode);h.document.body.dataset={view:'replay'};
    h.document.querySelectorAll=()=>[];
    Object.assign(h.context,{location:{hash:'#replay'},history:{pushState(){}},window:{scrollTo(){}},settingsInline:null,outputFeed:null,outputPlayers:{pauseAll(){}},activeDialog:null,clearReplay(){},refreshState:async()=>{}});
    vm.runInContext(script.slice(script.indexOf('function navigate('),script.indexOf("\ndocument.querySelectorAll('[data-view]')")),h.context);
    await h.click();h.context.navigate('tasks');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.document.body.dataset.view,'tasks');assert.equal(h.overlays.parentElement,h.body);assert.equal(h.document.fullscreenElement,null);
  }
  const h=harness();h.document.body.dataset={view:'replay'};h.document.querySelectorAll=()=>[];
  Object.assign(h.context,{location:{hash:'#replay'},history:{pushState(){}},window:{scrollTo(){}},settingsInline:null,outputFeed:null,outputPlayers:{pauseAll(){}},activeDialog:null,clearReplay(){},refreshState:async()=>{}});
  vm.runInContext(script.slice(script.indexOf('function navigate('),script.indexOf("\ndocument.querySelectorAll('[data-view]')")),h.context);
  await h.click();h.document.exitFullscreen=async()=>{throw Error('blocked');};h.context.navigate('tasks');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.document.body.dataset.view,'replay');assert.equal(h.overlays.parentElement,h.view);
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function delayEntry(h){const d=deferred();h.view.requestFullscreen=()=>d.promise;return{...d,resolve(){h.document.fullscreenElement=h.view;h.listeners.fullscreenchange();d.resolve();}};}
function delayExit(h){const d=deferred();let calls=0;h.document.exitFullscreen=()=>{calls++;return d.promise;};return{...d,resolve(){h.document.fullscreenElement=null;h.listeners.fullscreenchange();d.resolve();},calls:()=>calls};}
test('pending enter settled after navigation never expands a hidden replay or steals global notices',async()=>{
  for(const outcome of ['resolve','reject']) {
    const h=harness(),request=delayEntry(h),enter=h.click();
    h.context.navigate('tasks');assert.equal(h.body.dataset.view,'tasks');
    if(outcome==='resolve')request.resolve();else request.reject(Error('denied'));
    await enter;await settle();
    assert.equal(h.document.fullscreenElement,null);assert.equal(h.view.classList.contains('replay-expanded'),false);assert.equal(h.overlays.parentElement,h.body);
    h.context.notify('tasks notice');assert.ok(h.body.contains(h.nodes.get('toast'))&&!h.view.contains(h.nodes.get('toast')));
    h.context.navigate('settings');assert.equal(h.body.dataset.view,'settings');assert.equal(h.overlays.parentElement,h.body);
  }
});
test('Escape cancels a pending enter for both native success and rejected fallback, including route round trips',async()=>{
  for(const outcome of ['resolve','reject'])for(const roundTrip of [false,true]) {
    const h=harness(),request=delayEntry(h),enter=h.click();h.listeners.keydown({key:'Escape'});
    if(roundTrip){h.context.navigate('tasks');h.context.navigate('replay');}
    if(outcome==='resolve')request.resolve();else request.reject(Error('denied'));
    await enter;await settle();assert.equal(h.body.dataset.view,'replay');assert.equal(h.document.fullscreenElement,null);assert.equal(h.view.classList.contains('replay-expanded'),false);assert.equal(h.overlays.parentElement,h.body);
  }
});
test('a newer route or Back invalidates the old pending exit navigation, including rejected exits',async()=>{
  for(const newer of ['settings','replay'])for(const outcome of ['resolve','reject']) {
    const h=harness();await h.click();const exit=delayExit(h);h.context.navigate('tasks');
    h.context.location.hash='#'+newer;h.context.navigate(newer,false);assert.equal(exit.calls(),1);
    if(outcome==='resolve')exit.resolve();else exit.reject(Error('denied'));
    await settle();assert.equal(h.context.location.hash,'#'+newer);assert.ok(!h.navigation.includes('tasks'));
    assert.equal(h.body.dataset.view,outcome==='reject'?'replay':newer);
    if(outcome==='resolve')assert.equal(h.overlays.parentElement,h.body);
  }
});
test('toast navigation participates in the same generation and cannot overtake a newer route',async()=>{
  const h=harness();await h.click();const exit=delayExit(h);h.context.notify('submitted',false,{range:'synthetic'});h.nodes.get('toast').children[2].listeners.click();
  h.context.navigate('settings');exit.resolve();await settle();assert.equal(h.body.dataset.view,'settings');assert.deepEqual(h.navigation,['settings']);assert.equal(h.overlays.parentElement,h.body);
});

test('native and fallback fullscreen transitions interrupt timeline gestures before layout changes',async()=>{
  for(const mode of ['native','rejected','unsupported']){
    const h=harness(mode); await h.click(); assert.ok(h.interrupts()>0);
    const entered=h.interrupts(); await h.click(); assert.ok(h.interrupts()>entered);
  }
});

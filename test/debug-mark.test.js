import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../public/debug-mark.js', import.meta.url), 'utf8').replace('export ', '');
function harness(query = '', stored = false, storageFails = false) {
  const nodes = new Map(), data = new Map(stored ? [['debugMark','1']] : []), logs = [], listeners = {};
  let now = 0, reloads = 0;
  class Element {
    children = []; listeners = {}; style = {}; textContent = '';
    setAttribute(name,value) { this[name] = value; }
    append(...items) { this.children.push(...items); for (const item of items) if (item.id) nodes.set(item.id,item); }
    addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type = 'click') { for (const fn of this.listeners[type] || []) fn({}); }
    remove() { nodes.delete(this.id); for (const child of this.children) nodes.delete(child.id); this.removed = true; }
  }
  for (const id of ['selection-title','app-title','mark-in','mark-out']) nodes.set(id,new Element());
  const location = { href: 'https://fixture.invalid/review/?other=keep' + query + '#replay', reload() { reloads++; } };
  const history = { state: { keep: true }, replaceState(state, unused, url) { this.lastState = state; location.href = new URL(url,location.href).href; } };
  const storage = { getItem(key) { if (storageFails) throw Error('blocked'); return data.get(key) || null; }, setItem(key,value) { if (storageFails) throw Error('blocked'); data.set(key,value); }, removeItem(key) { if (storageFails) throw Error('blocked'); data.delete(key); } };
  const viewportListeners = {}; const viewport = { width:430,height:873,offsetLeft:0,offsetTop:0,scale:1,addEventListener(type,fn) {(viewportListeners[type] ||= []).push(fn);} };
  const content = new Element(); content.scrollTop = 0; content.getBoundingClientRect = () => ({x:0,y:0,width:430,height:932});
  const context = vm.createContext({ navigator:{standalone:true},getComputedStyle:()=>({height:'932px',getPropertyValue:name=>name==='--safe-top'?'59px':'34px'}), URL, Date: { now: () => now }, location, history, localStorage: storage, document: { documentElement:{clientWidth:430,clientHeight:932},querySelector:selector=>selector==='.workspace-main'?content:({getBoundingClientRect:()=>({x:12,y:765,width:406,height:64})}),body: { dataset:{view:'replay'},append(node) { nodes.set(node.id,node); } }, createElement: () => new Element() }, window: {matchMedia:()=>({matches:true}),requestAnimationFrame:fn=>fn(),innerWidth:430,innerHeight:932,screen:{width:430,height:932},scrollY:0,visualViewport:viewport,addEventListener(type,fn) { (listeners[type] ||= []).push(fn); } } });
  vm.runInContext(source,context);
  const state = { cursorMs: 123, inMs: 111, outMs: 222, selectedCamera: 'unchanged' };
  const control = context.setupDebugMark({ $: id => nodes.get(id), state, debugMark: (...args) => logs.push(args) });
  return { content, viewport, viewportListeners, listeners, nodes, data, location, history, logs, state, control, storage, get reloads() { return reloads; }, tap(count = 1, spacing = 100) { for (let i = 0; i < count; i++) { now += spacing; nodes.get('selection-title').fire(); } } };
}
test('query on/off is consumed once, preserves URL/history, and close remains closed on refresh', () => {
  for (const initial of [true,false]) {
    const h = harness(initial ? '&debugMark=1' : '&debugMark=0', !initial);
    assert.equal(h.control.isEnabled(),initial); assert.equal(h.location.href,'https://fixture.invalid/review/?other=keep#replay');
    assert.equal(h.history.lastState,h.history.state);
    if (!initial) h.tap(5);
    assert.ok(h.nodes.has('debug-mark-panel'));
    h.nodes.get('debug-mark-panel').children[1].fire();
    assert.equal(h.control.isEnabled(),false); assert.equal(h.data.has('debugMark'),false);
    assert.equal(harness('',h.data.has('debugMark')).control.isEnabled(),false); assert.equal(h.reloads,0);
  }
});
test('four clicks and expired clicks do not toggle; five clicks reset the counter for repeated cycles', () => {
  const h = harness(); h.tap(4); assert.equal(h.control.isEnabled(),false);
  h.tap(1,2600); assert.equal(h.control.isEnabled(),false); h.tap(4); assert.equal(h.control.isEnabled(),true);
  h.tap(1); assert.equal(h.control.isEnabled(),true); h.tap(4); assert.equal(h.control.isEnabled(),false);
  for (let i = 0; i < 3; i++) { h.tap(5); assert.equal(h.control.isEnabled(),true); h.nodes.get('mark-in').fire(); h.tap(5); assert.equal(h.control.isEnabled(),false); h.nodes.get('mark-in').fire(); }
  assert.equal(h.logs.length,3); assert.equal(h.nodes.get('mark-in').listeners.click.length,1); assert.equal(h.reloads,0);
  assert.deepEqual(h.state,{ cursorMs:123,inMs:111,outMs:222,selectedCamera:'unchanged' });
});
test('storage failure cannot prevent current-session opening or closing', () => {
  const h = harness('&debugMark=1',false,true); assert.equal(h.control.isEnabled(),true);
  h.nodes.get('debug-mark-panel').children[1].fire(); assert.equal(h.control.isEnabled(),false);
  h.tap(5); assert.equal(h.control.isEnabled(),true); h.tap(5); assert.equal(h.control.isEnabled(),false); assert.equal(h.reloads,0);
});
test('diagnostic log limit never replaces close button and closing stops console output', () => {
  const h = harness('&debugMark=1'), consoleLines = [];
  const script = fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
  const context = vm.createContext({ document: { getElementById: id => h.nodes.get(id) }, state: h.state, Date, console: { log: (...args) => consoleLines.push(args) } });
  vm.runInContext(script.slice(script.indexOf('function debugMark('),script.indexOf('function markPlaybackBoundary(')),context);
  for (let i = 0; i < 24; i++) context.debugMark('mark-click',{ boundary:'in', password:'must-not-log', url:'rtsp://private-fixture' });
  assert.equal(h.nodes.get('debug-mark-log').textContent.split('\n').length,16);
  const close = h.nodes.get('debug-mark-panel').children[1]; assert.equal(close['aria-label'],'关闭诊断面板'); close.fire();
  context.debugMark('mark-click'); assert.equal(consoleLines.length,24);
  assert.doesNotMatch(consoleLines.flat().join(' '), /must-not-log|password|rtsp:|https?:/);
});

test('empty HUD reserves the complete close target and keeps safe-area padding outside scrolling logs', () => {
  const h = harness('&debugMark=1'); const panel = h.nodes.get('debug-mark-panel'), [log, close] = panel.children;
  for (const text of ['', 'one line', Array(16).fill('line').join('\n')]) {
    log.textContent = text;
    assert.match(panel.style.cssText, /min-height:calc\(44px \+ env\(safe-area-inset-top/);
    assert.doesNotMatch(panel.style.cssText, /overflow:hidden/);
    assert.match(log.style.cssText, /max-height:34vh;overflow:auto/);
    assert.match(close.style.cssText, /width:44px;height:44px/);
    assert.match(close.style.cssText, /top:calc\(env\(safe-area-inset-top/);
  }
  close.fire(); assert.equal(h.control.isEnabled(), false);
});


test('viewport HUD shows local numeric geometry and updates offsets without changing playback or sending data', () => {
  const h=harness('&debugMark=1'), node=h.nodes.get('debug-mark-viewport');
  assert.match(node.textContent, /"displayStandalone":true/);
  assert.match(node.textContent, /"inner":\[430,932\]/);
  assert.match(node.textContent, /"visual":\[430,873,0,0,1\]/);
  assert.match(node.textContent, /"safe":\["59px","34px"\]/);
  h.content.scrollTop=125; h.content.fire('scroll');
  assert.match(node.textContent, /"contentScroll":125/);
  assert.match(node.textContent, /"content":\[0,0,430,932\]/);
  h.viewport.height=800; h.viewport.offsetTop=30;
  for(const fn of h.viewportListeners.scroll) fn();
  assert.match(node.textContent, /"visual":\[430,800,0,30,1\]/);
  assert.match(node.textContent, /previous /);
  for(const fn of h.viewportListeners.scroll) fn();
  assert.match(node.textContent, /previous /,'unchanged resize events retain the previous distinct geometry');
  assert.match(node.textContent, /"cssHeights":\{"vh":932,"dvh":932,"svh":932,"lvh":932\}/);
  h.nodes.get('debug-mark-panel').children[1].fire();
  assert.equal(h.nodes.has('debug-mark-viewport'),false);
  for(const fn of h.viewportListeners.resize) fn();
  assert.equal(h.data.has('debugMark'),false); assert.equal(h.reloads,0);
  assert.deepEqual(h.state,{cursorMs:123,inMs:111,outMs:222,selectedCamera:'unchanged'});
  assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
});


test('visible phone clock opens the existing HUD with five taps and never changes playback', () => {
  const h=harness();
  for(let i=0;i<4;i++) h.nodes.get('app-title').fire();
  assert.equal(h.control.isEnabled(),false);
  h.nodes.get('app-title').fire();
  assert.equal(h.control.isEnabled(),true);
  assert.ok(h.nodes.has('debug-mark-viewport'));
  assert.equal(h.reloads,0);
  assert.deepEqual(h.state,{cursorMs:123,inMs:111,outMs:222,selectedCamera:'unchanged'});
});

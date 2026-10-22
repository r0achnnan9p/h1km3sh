import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackChrome, createSlidingNavigation } from '../public/ui-primitives.js';

class Node {
  listeners = new Map(); attributes = new Map(); dataset = {}; values = new Map(); classes = new Set(); children = [];
  classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x), contains: x => this.classes.has(x) };
  style = { setProperty: (k,v) => this.values.set(k,v) };
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(x => x !== fn)); }
  emit(name, detail = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...detail }; for (const fn of this.listeners.get(name) || []) fn(event); return event; }
  contains(node) { return node === this || this.children.includes(node); }
  getAttribute(name) { return this.attributes.get(name); }
  setAttribute(name,value) { this.attributes.set(name,value); }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll() { return this.children; }
  closest() { return this.dataset.view ? this : null; }
  matches(selector) { return selector === ':focus-visible' && this.focusVisible === true; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
}
function chrome() {
  const container = new Node(), video = Object.assign(new Node(), { hidden: false, paused: false, ended: false, error: null, readyState: 4 });
  const document = Object.assign(new Node(), { activeElement: null }), timers = new Map(); let next = 0;
  const controller = createPlaybackChrome({ container, video, document, setTimer: callback => { timers.set(++next, callback); return next; }, clearTimer: id => timers.delete(id) });
  const tick = () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); };
  return { container, video, document, controller, timers, tick };
}
test('playback controls fade only after playable media is idle and pointer activity reveals them', () => {
  const h = chrome(); h.tick(); assert.ok(h.container.classList.contains('controls-idle'));
  h.container.emit('pointerdown'); assert.equal(h.container.classList.contains('controls-idle'), false);
  h.container.emit('pointermove'); assert.equal(h.timers.size, 1); h.tick(); assert.ok(h.container.classList.contains('controls-idle'));
  h.video.paused = true; h.video.emit('pause'); h.tick(); assert.equal(h.container.classList.contains('controls-idle'), false);
});
test('keyboard focus, unready media and errors keep actionable controls visible', () => {
  for (const setup of [h => { h.video.readyState = 0; }, h => { h.video.error = {}; }, h => { h.video.ended = true; }, h => { h.video.hidden = true; }, h => { h.document.activeElement = h.container; h.container.focusVisible = true; }]) {
    const h = chrome(); setup(h); h.tick(); assert.equal(h.container.classList.contains('controls-idle'), false); h.controller.destroy();
  }
});
test('buffering reveals faded controls and keeps them visible until playback resumes', () => {
  for (const event of ['waiting']) {
    const h = chrome(); h.tick(); assert.equal(h.container.classList.contains('controls-idle'), true);
    h.video.readyState = 2; h.video.emit(event);
    assert.equal(h.container.classList.contains('controls-idle'), false);
    h.tick(); assert.equal(h.container.classList.contains('controls-idle'), false);
    h.container.emit('pointermove'); h.tick(); assert.equal(h.container.classList.contains('controls-idle'), false);
    h.video.emit('playing'); h.tick(); assert.equal(h.container.classList.contains('controls-idle'), true);
    h.controller.destroy();
  }
});
test('a download stall with buffered playback does not permanently pin the controls', () => {
  const h = chrome(); h.tick(); h.video.emit('stalled');
  assert.equal(h.container.classList.contains('controls-idle'), false);
  h.tick(); assert.equal(h.container.classList.contains('controls-idle'), true);
  h.controller.destroy();
});
test('pointer focus does not permanently prevent the playback controls from fading', () => {
  const h = chrome(); h.document.activeElement = h.container; h.container.focusVisible = false;
  h.tick(); assert.equal(h.container.classList.contains('controls-idle'), true);
});
test('playback chrome cancels timers on backgrounding and removes every listener on destroy', () => {
  const h = chrome(); h.document.hidden = true; h.document.emit('visibilitychange'); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.emit('visibilitychange'); assert.equal(h.timers.size, 1);
  h.controller.destroy(); assert.equal(h.timers.size, 0); h.container.emit('pointerdown'); assert.equal(h.timers.size, 0);
});
function navigation() {
  const nav = new Node(), window = new Node(), calls = []; nav.rect = { left: 0, right: 400, top: 0, bottom: 64, width: 400 };
  nav.children = ['replay','library','tasks','settings'].map((view, i) => {
    const button = new Node(); button.dataset.view = view; button.rect = { left: i * 100 + 8, width: 84 }; button.setAttribute('aria-current', i ? 'false' : 'page'); return button;
  });
  const controller = createSlidingNavigation({ nav, window, now: () => 1000, activate(view) { calls.push(view); for (const b of nav.children) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); } });
  const event = (x, extra = {}) => ({ pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: 30, target: nav.children[0], ...extra });
  return { nav, window, calls, controller, event };
}
test('press-and-slide previews intermediate tabs and commits only the release target once', () => {
  const h = navigation(); h.nav.emit('pointerdown', h.event(40)); h.nav.emit('pointermove', h.event(250));
  assert.deepEqual(h.calls, []); assert.ok(h.nav.children[2].classList.contains('drag-target'));
  h.nav.emit('pointermove', h.event(350)); h.nav.emit('pointerup', h.event(350));
  assert.deepEqual(h.calls, ['settings']); assert.equal(h.nav.capture, null); assert.equal(h.nav.classList.contains('nav-dragging'), false);
  assert.equal(h.nav.emit('click', { detail: 1 }).stopped, true, 'synthetic pointer click cannot navigate twice');
  assert.notEqual(h.nav.emit('click', { detail: 0 }).stopped, true, 'keyboard activation remains available');
});
test('cancel, lost capture and release outside navigation do not switch tabs', () => {
  for (const finish of ['pointercancel','lostpointercapture','pointerup']) {
    const h = navigation(); h.nav.emit('pointerdown', h.event(30)); h.nav.emit(finish, h.event(500));
    assert.deepEqual(h.calls, []); assert.equal(h.nav.values.get('--nav-selection-left'), '8px');
  }
});
test('secondary contacts cannot replace an active tab gesture; destroy releases presentation hooks', () => {
  const h = navigation(); h.nav.emit('pointerdown', h.event(30)); h.nav.emit('pointermove', h.event(350, { pointerId: 2 }));
  h.nav.emit('pointerup', h.event(350, { pointerId: 2 })); assert.deepEqual(h.calls, []);
  h.nav.emit('pointerup', h.event(150)); assert.deepEqual(h.calls, ['library']);
  h.controller.destroy(); h.nav.emit('pointerdown', h.event(30)); h.nav.emit('pointerup', h.event(350)); assert.deepEqual(h.calls, ['library']);
});

test('gesture or open sheet prevents idle fade across the whole editor interaction root', () => {
  const container = new Node(), root = new Node(), video = Object.assign(new Node(), {hidden:false,paused:false,ended:false,error:null,readyState:4});
  const document = Object.assign(new Node(), {activeElement:null}); let busy = true, pending;
  const controller = createPlaybackChrome({container, interactionRoot:root, video, document, isBusy:()=>busy, setTimer:fn=>(pending=fn,1),clearTimer(){}});
  pending(); assert.equal(container.classList.contains('controls-idle'), false);
  busy = false; root.emit('pointerup'); pending(); assert.equal(container.classList.contains('controls-idle'), true);
  root.emit('pointerdown'); assert.equal(container.classList.contains('controls-idle'), false);
  root.children.push(root); document.activeElement=root; root.focusVisible=true; pending(); assert.equal(container.classList.contains('controls-idle'), false);
  controller.destroy();
});

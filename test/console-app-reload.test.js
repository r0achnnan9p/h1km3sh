import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';

const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.disabled = false; this.classList = { add() {} }; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); return true; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(selector.split(',').map(v => v.trim()).includes(node.tag) ? [node] : []), ...node.querySelectorAll(selector)]); }
  focus() {}
}
function harness() {
  const replaced = [], cancelled = [], controls = new Map();
  const html = statusDashboardPage('/camera');
  const reloadMarkup = [...html.matchAll(/<button[^>]*data-app-reload[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  const buttons = reloadMarkup.map(() => new Element('button'));
  const $ = id => { if (!controls.has(id)) controls.set(id, new Element()); return controls.get(id); };
  let now = 1800000000000;
  const context = vm.createContext({ $, Event, URL, Date: { now: () => now++ }, settingsInline: null, activeDialog: null,
    location: { href: 'https://example.test/camera/?mode=review&tag=a&tag=b&_reload=old#tasks', replace: url => replaced.push(url) },
    replayHoldButtons: [{ cancel: reason => cancelled.push(reason) }],
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }), innerWidth: 1440 },
    document: { createElement: tag => new Element(tag), querySelectorAll: selector => selector === '[data-app-reload]' ? buttons : [] },
    MutationObserver: class { observe() {} }, updateOutputSort() {}, openRangeEditor() {}, openPlaybackTimeEditor() {}, openPlaybackDate() {},
    changeQuickPlaybackSource() {}, refreshPlaybackChoices() {}, updatePlaybackContext() {},
    openDialog() { assert.fail('desktop settings must use the existing inline editor'); },
  });
  vm.runInContext(source.slice(source.indexOf('function cancelReplayHold('), source.indexOf('function tryBufferedReplaySeek(')), context);
  vm.runInContext(source.slice(source.indexOf('function reloadApplication('), source.indexOf('async function boot(')), context);
  vm.runInContext(source.slice(source.indexOf('function openSettingsContainer('), source.indexOf('function openSettingsPanel(')), context);
  return { context, replaced, cancelled, reloadMarkup, buttons };
}

test('all four page reload buttons share the application reload action and preserve route and existing query values', () => {
  const h = harness(); assert.equal(h.buttons.length, 4);
  h.context.setupTouchControls();
  for (const [index, button] of h.buttons.entries()) {
    assert.match(h.reloadMarkup[index], /aria-label="重新加载应用" title="重新加载应用"/);
    assert.equal(button.listeners.click.length, 1); assert.equal(button.listeners.click[0], h.context.reloadApplication);
    button.dispatchEvent(new Event('click'));
    const target = new URL(h.replaced[index]);
    assert.equal(target.origin, 'https://example.test'); assert.equal(target.pathname, '/camera/'); assert.equal(target.hash, '#tasks');
    assert.equal(target.searchParams.get('mode'), 'review'); assert.deepEqual(target.searchParams.getAll('tag'), ['a', 'b']);
    assert.deepEqual(target.searchParams.getAll('_reload'), [String(1800000000000 + index)]);
  }
  assert.deepEqual(h.cancelled, Array(4).fill('playback-changed'));
});

test('dirty inline settings block the first reload and require the existing explicit discard acknowledgement', () => {
  const h = harness(), sheet = h.context.openSettingsContainer('测试设置', '', { initialDirty: true });
  h.context.reloadApplication();
  assert.equal(h.replaced.length, 0); assert.equal(h.cancelled.length, 0); assert.equal(sheet.dialog.open, true);
  assert.match(sheet.error.textContent, /未保存.*再次选择/);
  h.context.reloadApplication();
  assert.equal(sheet.dialog.open, false); assert.equal(h.replaced.length, 1); assert.equal(h.cancelled.length, 1);
});

test('editing again clears a prior discard acknowledgement and saving can never be bypassed by repeated reload clicks', () => {
  const h = harness(), sheet = h.context.openSettingsContainer('测试设置', '', { initialDirty: true });
  h.context.reloadApplication(); sheet.dialog.dispatchEvent(new Event('input')); h.context.reloadApplication();
  assert.equal(h.replaced.length, 0); assert.equal(sheet.dialog.open, true);
  sheet.setPending(true);
  for (let i = 0; i < 3; i++) h.context.reloadApplication();
  assert.equal(h.replaced.length, 0); assert.match(sheet.error.textContent, /正在保存/); assert.equal(h.cancelled.length, 0);
});

test('clean inline settings close before the fresh document navigation', () => {
  const h = harness(), sheet = h.context.openSettingsContainer('测试设置');
  h.context.location.replace = url => { assert.equal(sheet.dialog.open, false); h.replaced.push(url); };
  h.context.reloadApplication(); assert.equal(h.replaced.length, 1);
});

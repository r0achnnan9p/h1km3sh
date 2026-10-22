import { iconSvg } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/touch-controls.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replaceAll('export ', '');
function harness({ showFails = false } = {}) {
  const closes = [], scrolls = [];
  let document;
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.props = new Map(); this.classes = new Set(); this.isConnected = true; this.disabled = false; this.style = { setProperty: (k,v) => this.props.set(k,v), getPropertyValue: k => this.props.get(k) || '', removeProperty: k => this.props.delete(k) }; this.classList = { add: k => this.classes.add(k), remove: k => this.classes.delete(k), contains: k => this.classes.has(k) }; }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches() { return false; }
    setAttribute() {}
    addEventListener(k,f) { (this.listeners[k] ||= []).push(f); }
    removeEventListener(k,f) { this.listeners[k] = (this.listeners[k] || []).filter(x => x !== f); }
    emit(k, target = this) { for (const f of this.listeners[k] || []) f({ target, preventDefault() {} }); }
    focus(options) { document.activeElement = this; this.focusOptions = options; }
    showModal() { if (showFails) throw new Error('modal unavailable'); this.open = true; }
    close() { if (this.open) { this.open = false; closes.push(() => this.emit('close')); } }
    querySelectorAll() { return this.children.flatMap(n => [n, ...n.querySelectorAll()]).filter(n => ['button','input'].includes(n.tag)); }
  }
  const root = new Node('html'); root.clientHeight = 873;
  const previous = new Node('button');
  document = { documentElement: root, body: new Node('body'), activeElement: previous, createElement: tag => new Node(tag), querySelector: () => previous };
  const window = { innerHeight: 932, scrollX: 0, scrollY: 150, scrollTo: (x,y) => scrolls.push([x,y]), addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ iconSvg, document, window, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(source, context);
  return { context, document, root, previous, closes, scrolls };
}
test('modal locks document scroll, focuses title, and restores original scroll and focus on close', () => {
  const h = harness(), sheet = h.context.openDialog('设置');
  assert.ok(h.root.classList.contains('dialog-scroll-locked')); assert.equal(h.root.style.getPropertyValue('--dialog-page-top'), '-150px');
  assert.equal(h.document.activeElement.tag, 'h2'); assert.equal(h.document.activeElement.tabIndex, -1);
  assert.equal(sheet.dialog.style.getPropertyValue('--dialog-viewport-height'), '932px');
  assert.equal(sheet.dialog.style.getPropertyValue('--dialog-keyboard-inset'), '0px', 'status-bar reporting difference is not a keyboard');
  sheet.close(); h.closes.shift()();
  assert.equal(h.root.classList.contains('dialog-scroll-locked'), false); assert.deepEqual(h.scrolls, [[0,150]]); assert.equal(h.document.activeElement, h.previous); assert.equal(h.previous.focusOptions.preventScroll, true);
});
test('late closing old dialog cannot unlock background or move focus out of replacement', () => {
  const h = harness(), first = h.context.openDialog('一'), second = h.context.openDialog('二');
  const focus = h.document.activeElement; assert.equal(first.dialog.open, false); assert.equal(second.dialog.open, true);
  h.closes.shift()(); assert.equal(h.document.activeElement, focus); assert.ok(h.root.classList.contains('dialog-scroll-locked')); assert.equal(h.scrolls.length, 0);
  second.close(); h.closes.shift()(); assert.equal(h.root.classList.contains('dialog-scroll-locked'), false); assert.equal(h.scrolls.length, 1);
});
test('dirty and pending dismissal keep modal and background lock until explicit safe close', () => {
  const h = harness(), sheet = h.context.openDialog('编辑');
  sheet.dialog.emit('input'); sheet.dialog.emit('cancel'); assert.equal(sheet.dialog.open, true); assert.match(sheet.error.textContent, /未保存/);
  sheet.setPending(true); sheet.dialog.emit('cancel'); assert.equal(sheet.dialog.open, true); assert.ok(h.root.classList.contains('dialog-scroll-locked'));
  sheet.setPending(false); sheet.dialog.emit('cancel'); h.closes.shift()(); assert.equal(h.root.classList.contains('dialog-scroll-locked'), false);
});
test('failed showModal does not leave page scroll locked', () => {
  const h = harness({ showFails: true }); assert.throws(() => h.context.openDialog('设置'), /modal unavailable/);
  assert.equal(h.root.classList.contains('dialog-scroll-locked'), false); assert.equal(h.document.body.children.length, 0); assert.equal(h.scrolls.length, 1);
});

test('a file picker cancel bubbling from an input cannot dismiss its settings dialog', () => {
  const h = harness(), sheet = h.context.openDialog('B站', '', { trackChanges: false });
  const file = h.document.createElement('input'); file.type = 'file'; sheet.content.append(file);
  sheet.dialog.emit('cancel', file);
  assert.equal(sheet.dialog.open, true); assert.equal(h.closes.length, 0);
  assert.ok(h.root.classList.contains('dialog-scroll-locked'));
  sheet.dialog.emit('cancel'); assert.equal(sheet.dialog.open, false);
});

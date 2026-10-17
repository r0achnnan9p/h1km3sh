import { setButtonIcon, createSettingsRow } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script = fs.readFileSync(new URL('../public/touch-controls.js', import.meta.url), 'utf8').replaceAll('export ', '') + '\n' + fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const context = vm.createContext({ setButtonIcon, createSettingsRow, Date, dateStart: value => new Date(`${value}T00:00:00+08:00`).getTime() });
vm.runInContext(script.slice(script.indexOf('function mp4Basename('), script.indexOf('function enhanceSelect(')), context);

test('rename trims whitespace, preserves existing MP4 extension and rejects paths/control characters', () => {
  assert.equal(context.normalizeMp4Name(' Match D2 '), 'Match D2.mp4');
  assert.equal(context.normalizeMp4Name('Match.MP4'), 'Match.mp4');
  assert.equal(context.normalizeMp4Name('Match.mp4.mp4'), 'Match.mp4');
  assert.equal(context.mp4Basename('粘贴名称.MP4'), '粘贴名称');
  assert.equal(context.mp4Basename('name.mp4version'), 'name.mp4version');
  for (const name of ['', '   ', '../file', 'folder/file', 'folder\\file', 'file\nname', '.', '..']) assert.throws(() => context.normalizeMp4Name(name));
});
test('custom calendar validates actual dates, leap years and exact keyboard format', () => {
  for (const date of ['2024-02-29', '2026-09-30', '2026-12-31']) assert.equal(context.isCalendarDate(date), true);
  for (const date of ['2026-02-29', '2026-09-31', '2026-13-01', '2026-1-1', '', 'anything']) assert.equal(context.isCalendarDate(date), false);
});
test('precise range accepts seconds and end-of-day without UTC conversion', () => {
  const midnight = Date.parse('2026-09-30T00:00:00+08:00');
  assert.equal(context.rangeTimeMs('20:10:19', '2026-09-30'), midnight + (20 * 3600 + 10 * 60 + 19) * 1000);
  assert.equal(context.rangeTimeMs('24:00', '2026-09-30', true), midnight + 86400000);
  assert.equal(context.rangeTimeMs('01:02', '2026-09-30'), midnight + 3720000);
  for (const value of ['24:00:01', '23:60', '24:01', '99:00', '1:00', '00:00:60']) assert.throws(() => context.rangeTimeMs(value, '2026-09-30', true));
  assert.throws(() => context.rangeTimeMs('24:00', '2026-09-30'));
});

class Element {
  listeners = {}; children = []; disabled = false; textContent = ''; value = ''; classList = { add() {}, remove() {} };
  append(...items) { this.children.push(...items); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() { this.focused = true; } select() { this.selected = true; } setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } setAttribute() {}
  click() { if (!this.disabled) return this.listeners.click?.({}); }
}
function renameHarness(api) {
  const sheet = { content: new Element(), actions: new Element(), error: new Element(), pending: false, closed: false, setPending(value) { this.pending = value; this.actions.children.forEach(button => { button.disabled = value; }); }, close() { this.closed = true; } };
  const notices = [];
  const context = vm.createContext({ setButtonIcon, createSettingsRow, openDialog: () => sheet, normalizeMp4Name: value => value.trim().replace(/(?:\.mp4)?$/i, '.mp4'), document: { createElement: () => new Element() }, api, body: JSON.stringify, renderOutputs() {}, refreshOutputs: async () => {}, notify: message => notices.push(message) });
  const buttonStart = script.lastIndexOf('function addButton(');
  vm.runInContext(script.slice(buttonStart, script.indexOf('function renderOutputs(', buttonStart)), context);
  vm.runInContext(script.slice(script.indexOf('function labelledInput('), script.indexOf('function mp4Basename(')), context);
  vm.runInContext(script.slice(script.indexOf('function renameOutput('), script.indexOf('function confirmAction(')), context);
  const file = { id: 'file-1', filename: 'old.mp4' }; context.renameOutput(file);
  return { file, sheet, input: sheet.content.children[0].children[1], save: sheet.actions.children[0], notices };
}
test('rename dialog saves exact API payload once and updates the visible file after success', async () => {
  const requests = []; let resolve;
  const h = renameHarness((url, options) => { requests.push([url, JSON.parse(options.body)]); return new Promise(done => { resolve = done; }); });
  h.input.value = 'new'; const first = h.save.click(); await h.save.click();
  assert.equal(h.sheet.pending, true); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], ['/console/api/outputs/file-1', { newName: 'new.mp4' }]);
  resolve({}); await first;
  assert.equal(h.file.filename, 'new.mp4'); assert.equal(h.sheet.closed, true); assert.match(h.notices[0], /已更新/);
});
test('failed rename leaves sheet open and typed name intact with actionable server error', async () => {
  const h = renameHarness(async () => { throw new Error('已有同名文件'); }); h.input.value = 'duplicate'; await h.save.click();
  assert.equal(h.sheet.closed, false); assert.equal(h.sheet.pending, false); assert.equal(h.save.disabled, false);
  assert.equal(h.input.value, 'duplicate'); assert.equal(h.sheet.error.textContent, '已有同名文件'); assert.equal(h.file.filename, 'old.mp4');
});
test('all console states share shell, responsive viewport, explicit range and search controls', () => {
  const html = statusDashboardPage('/zl-camera');
  for (const id of ['boot-view', 'auth-view', 'login-form', 'setup-form', 'view-replay', 'view-library', 'view-tasks', 'view-settings', 'edit-in', 'edit-out', 'output-search', 'connection-banner']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /viewport-fit=cover/); assert.doesNotMatch(script, /window\.(prompt|confirm)\(/);
  assert.match(script, /dialog\.showModal\(\)/); assert.match(script, /event\.isComposing/);
});
test('password visibility controls cannot steal submit loading and duplicate-click guards', () => {
  for (const id of ['login-form', 'setup-form', 'password-form']) {
    assert.ok(script.includes(`$('${id}').querySelector('button[type="submit"]')`));
    assert.equal(script.includes(`$('${id}').querySelector('button')`), false);
  }
});

test('numeric time input formats complete and partial typing while preserving caret digit position', () => {
  assert.equal(context.formatTimeDigits('201530').value, '20:15:30');
  assert.equal(context.formatTimeDigits('222200').value, '22:22:00');
  assert.equal(context.formatTimeDigits('2018').value, '20:18');
  assert.equal(context.formatTimeDigits('201').value, '20:1');
  assert.equal(context.formatTimeDigits('20:15:30', 4).caret, 4);
  assert.equal(context.formatTimeDigits('201530', 3).caret, 4);
  assert.equal(context.formatTimeDigits('').value, '');
  for (const value of ['2:15:30', '2015309', 'abc', '20:1:30']) assert.equal(context.formatTimeDigits(value).value, value);
});
test('numeric range validates incomplete values, out-of-range units, and end-of-day only for end', () => {
  const day = Date.parse('2026-09-30T00:00:00+08:00');
  assert.equal(context.rangeTimeMs('201530', '2026-09-30'), day + 72930000);
  assert.equal(context.rangeTimeMs('240000', '2026-09-30', true), day + 86400000);
  for (const text of ['201', '20153', '2015309', '2:15:30', '236000', '235960', '240001', '250000']) assert.throws(() => context.rangeTimeMs(text, '2026-09-30', true));
  assert.throws(() => context.rangeTimeMs('240000', '2026-09-30'));
});
test('time input supports selection replacement and deleting an auto-inserted separator', () => {
  const input = { value: '20:15:30', selectionStart: 3, selectionEnd: 3, listeners: {}, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, dispatchEvent(event) { this.listeners[event.type]?.(event); } };
  context.Event = Event; context.enhanceTimeInput(input);
  assert.equal(input.inputMode, 'numeric');
  let prevented = false; input.listeners.beforeinput({ inputType: 'deleteContentBackward', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(input.selectionStart, 1); assert.equal(input.value, '2:15:30');
  input.value = '20:15:30'; input.selectionStart = input.selectionEnd = 2; input.listeners.input({}); assert.equal(input.value, '20:15:30');
  input.value = '222200'; input.selectionStart = input.selectionEnd = 6; input.listeners.input({});
  assert.equal(input.value, '22:22:00'); assert.equal(input.selectionStart, 8);
});

test('digit-by-digit typing traverses both auto-inserted colons', () => { let value = ''; for (const digit of '201530') value = context.formatTimeDigits(value + digit).value; assert.equal(value, '20:15:30'); });


test('rename synchronously focuses and selects only the basename on opening', () => {
  const h = renameHarness(async () => ({}));
  assert.equal(h.input.value, 'old'); assert.equal(h.input.focused, true);
  assert.equal(h.input.selected, true); assert.equal(h.input.selectionStart, 0); assert.equal(h.input.selectionEnd, 3);
  h.input.value = 'new title'; assert.equal(h.input.selectionEnd, 3);
});
test('dialog follows keyboard visual viewport, preserves editing selection, and cleans listeners', () => {
  const listeners = new Map(), windowListeners = new Map(), dialogListeners = new Map(), frames = new Map();
  const viewport = { height: 800, offsetTop: 0, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const properties = {}, input = { matches: () => true, getBoundingClientRect: () => ({ top: 620, bottom: 666 }), selectionStart: 2, selectionEnd: 2 };
  const dialog = { style: { setProperty: (key, value) => { properties[key] = value; } }, contains: node => node === input, scrollTop: 0, getBoundingClientRect: () => ({ top: 500, bottom: 780 }), querySelector: () => ({ getBoundingClientRect: () => ({ top: 700 }) }), addEventListener: (key, fn) => dialogListeners.set(key, fn), removeEventListener: key => dialogListeners.delete(key) };
  const h = vm.createContext({ setButtonIcon, createSettingsRow, window: { visualViewport: viewport, innerHeight: 800, addEventListener: (key, fn) => windowListeners.set(key, fn), removeEventListener: key => windowListeners.delete(key) }, document: { activeElement: input }, requestAnimationFrame: fn => { frames.set(1, fn); return 1; }, cancelAnimationFrame: id => frames.delete(id) });
  vm.runInContext(script.slice(script.indexOf('function fitDialogViewport('), script.indexOf('function labelledInput(')), h);
  const cleanup = h.fitDialogViewport(dialog);
  viewport.height = 420; viewport.offsetTop = 20; listeners.get('resize')(); listeners.get('scroll')();
  assert.equal(frames.size, 1); frames.get(1)(); frames.clear();
  assert.equal(properties['--dialog-viewport-top'], '20px'); assert.equal(properties['--dialog-viewport-height'], '420px'); assert.equal(properties['--dialog-keyboard-inset'], '360px');
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 2);
  dialog.querySelector = () => ({ getBoundingClientRect: () => ({ top: 630 }) });
  dialogListeners.get('focusin')(); frames.get(1)(); frames.clear(); assert.equal(dialog.scrollTop, 48);
  dialogListeners.get('focusin')(); cleanup(); assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(windowListeners.size, 0); assert.equal(dialogListeners.size, 0);
});

test('keyboard avoidance also applies to desktop and landscape dialog centering', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /\.console-app \.app-dialog \{ position: fixed; inset: var\(--dialog-viewport-top, 0px\) 0 var\(--dialog-keyboard-inset, 0px\)/);
  assert.match(css, /max-height: calc\(var\(--dialog-viewport-height, 100dvh\) - 48px\)/);
});

test('library tools remove visible field labels and keep one-row search/icon sorting', () => {
  const html = statusDashboardPage(); const tools = html.slice(html.indexOf('<div class="library-tools"'), html.indexOf('<div class="library-summary"'));
  assert.match(tools, /aria-label="查找成片" placeholder="搜索"/);
  assert.match(tools, /aria-label="成片排序：最新在前，点击切换为最早在前"/); assert.doesNotMatch(tools, /<span>(查找成片|排序)<\/span>/);
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /\.library-tools \{[^}]*flex-wrap: nowrap/);
  assert.match(css, /\.ui-icon-button \{[^}]*min-height: 44px/);
});


test('rename copy is concise and shared dialog footer leaves the complete focus ring unpainted', () => {
  const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  const rename = source.slice(source.indexOf('function renameOutput('), source.indexOf('function confirmAction('));
  assert.match(rename, /openDialog\('改名'\)/); assert.match(rename, /addButton\(sheet.actions, '保存'/);
  assert.doesNotMatch(rename, /重命名成片|保存名称/);
  const css = fs.readFileSync(new URL('../public/touch-controls.css', import.meta.url), 'utf8');
  assert.match(css, /\.dialog-actions \{[^}]*margin-top: 8px; padding-top: 8px/);
  assert.match(css, /outline: 3px solid var\(--cyan\); outline-offset: 3px/);
  const consoleCss = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(consoleCss, /\.console-app \.dialog-actions \{[^}]*padding-top: 12px/);
  assert.doesNotMatch(consoleCss, /\.dialog-actions \{[^}]*margin-top: 0/);
});

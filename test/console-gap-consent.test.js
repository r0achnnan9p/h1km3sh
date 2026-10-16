import { formatClipDuration } from '../public/ui-primitives.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import vm from 'node:vm'; import fs from 'node:fs';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness() {
  const requests = []; const state = { busy: false, dvrs: [] }; const make = () => ({ children: [], append(node) { this.children.push(node); }, textContent: '' });
  const sheet = { content: make(), actions: make(), error: make(), close() { this.closed = true; }, setPending(value) { this.pending = value; } };
  const context = vm.createContext({ formatClipDuration, state, openDialog: (title, copy) => { sheet.title = title; sheet.copy = copy; return sheet; }, document: { createElement: make }, addButton(parent, label, cls, action) { const button = { textContent: label, click: action }; parent.append(button); return button; }, api: async (url, options) => { requests.push({ url, payload: JSON.parse(options.body) }); return { success: true }; }, body: JSON.stringify, notify() {}, navigate() {}, flashSubmitted() {}, $() { return {}; }, refreshState: async () => {}, updateSelection() {} });
  vm.runInContext(script.slice(script.indexOf('function confirmIncompleteExport('), script.indexOf('function prettyBytes(')), context);
  return { context, state, sheet, requests };
}
test('gap preflight opens contextual confirmation without submitting or guessing a DVR mapping', async () => {
  const h = harness(), payload = { source: 'mediamtx', camera: 'B', start: '2026-09-30 20:15:00', end: '2026-09-30 22:21:00', mode: 'copy' };
  h.context.confirmIncompleteExport({ missingIntervals: [{ start: '20:30:00', end: '20:31:00' }, { start: '21:00:00', end: '21:00:30' }], missingSeconds: 90 }, payload);
  assert.equal(h.requests.length, 0); assert.match(h.sheet.copy, /2 处缺口，共 1分30秒/); assert.equal(h.sheet.actions.children[1].disabled, true);
  await h.sheet.actions.children[0].click();
  assert.deepEqual(h.requests[0].payload, { ...payload, acceptGaps: true }); assert.equal(h.sheet.closed, true); assert.equal(h.state.busy, false);
});
test('accepted gap retry suppresses duplicate clicks and retains sheet on failure', async () => {
  const h = harness(); let reject;
  h.context.api = (url, options) => { h.requests.push({ url }); return new Promise((resolve, failure) => { reject = failure; }); };
  h.context.confirmIncompleteExport({ missingIntervals: [], missingSeconds: 1 }, { source: 'mediamtx', camera: 'A' });
  const first = h.sheet.actions.children[0].click(); await h.sheet.actions.children[0].click(); assert.equal(h.requests.length, 1);
  reject(new Error('模拟服务中断')); await first;
  assert.equal(h.sheet.closed, undefined); assert.equal(h.sheet.error.textContent, '模拟服务中断'); assert.equal(h.state.busy, false);
});
test('API wrapper preserves authoritative gap coverage and code for user confirmation', async () => {
  const coverage = { missingSeconds: 15, missingIntervals: [{ startMs: 1000, endMs: 16000 }] };
  const context = vm.createContext({ formatClipDuration, appPath: value => value, loggedOut() {}, fetch: async () => ({ status: 409, ok: false, headers: { get: () => 'application/json' }, json: async () => ({ error: '录像缺口', code: 'MEDIAMTX_GAPS', coverage }) }) });
  vm.runInContext(script.slice(script.indexOf('async function api('), script.indexOf('async function requestJson(')), context);
  await assert.rejects(context.api('/console/api/export'), error => error.code === 'MEDIAMTX_GAPS' && error.coverage === coverage && error.status === 409);
});

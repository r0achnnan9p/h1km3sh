import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.listeners = {}; this.disabled = false; this.value = ''; this.files = []; this.classes = new Set(); this.classList = { add: v => this.classes.add(v), remove: v => this.classes.delete(v) }; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  getAttribute(key) { return this[key] || ''; }
  removeAttribute(key) { delete this[key]; }
}
function fixture() {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = new Element(), readers = [], requests = []; let resolveSave, refreshes = 0;
  class FileReader extends Element { readAsDataURL(file) { this.file = file; readers.push(this); } }
  const c = vm.createContext({ $, document, FileReader, window: { consoleIntegrations: { bilibiliCoverAvailable: true } }, appPath: v => v, settingsCsrfToken: 'csrf', api: (url, options) => { requests.push({ url, options }); return new Promise(ok => { resolveSave = ok; }); }, loadSettings: async () => { refreshes++; } });
  vm.runInContext(script.slice(script.indexOf('let coverPreviewRequest'), script.indexOf('async function loadCache()')), c);
  const event = (files = [], types = ['Files']) => ({ dataTransfer: { files, types }, prevented: false, preventDefault() { this.prevented = true; } });
  const drop = files => { const e = event(files); $('cover-dropzone').listeners.drop(e); return e; };
  const load = reader => { reader.result = 'data:image/png;base64,fixture'; reader.listeners.load(); };
  return { $, c, document, readers, requests, event, drop, load, resolve: () => resolveSave({ cover: { present: true, source: 'managed' } }), refreshes: () => refreshes };
}
const png = { name: 'cover.png', type: 'image/png', size: 123 };
test('drop previews one image, never uploads until explicit save, and prevents duplicate saves', async () => {
  const f = fixture(); assert.equal(f.drop([png]).prevented, true);
  assert.equal(f.requests.length, 0); assert.equal(f.$('cover-save').disabled, true);
  f.load(f.readers[0]); assert.equal(f.$('cover-save').disabled, false); assert.match(f.$('cover-status').textContent, /尚未保存/);
  const pending = f.$('cover-form').listeners.submit(f.event());
  await f.$('cover-form').listeners.submit(f.event());
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.body, png); assert.equal(f.requests[0].options.headers['X-CSRF-Token'], 'csrf');
  f.drop([{ ...png, name: 'ignored.png' }]); assert.equal(f.readers.length, 1);
  f.resolve(); await pending; assert.equal(f.$('cover-save').disabled, true); assert.equal(f.$('bili-cover-file').disabled, false); assert.equal(f.refreshes(), 1);
});
test('picker and drop share validation, reject multi-file/type/size without network requests', () => {
  const f = fixture();
  for (const files of [[png, png], [{ ...png, type: 'image/svg+xml' }], [{ ...png, size: 5 * 1024 * 1024 + 1 }], [{ ...png, size: 0 }]]) {
    f.drop(files); assert.equal(f.$('cover-save').disabled, true); assert.ok(f.$('cover-message').textContent); assert.equal(f.requests.length, 0);
  }
  f.$('bili-cover-file').files = [png]; f.$('bili-cover-file').listeners.change(); f.load(f.readers[0]); assert.equal(f.$('cover-save').disabled, false);
});
test('new selection invalidates older reader, error disables save, and drag depth resets on drop', () => {
  const f = fixture(), zone = f.$('cover-dropzone');
  f.drop([png]); f.drop([{ ...png, name: 'new.png' }]); f.load(f.readers[0]); assert.equal(f.$('cover-save').disabled, true);
  f.readers[1].listeners.error(); assert.equal(f.$('cover-save').disabled, true); assert.match(f.$('cover-message').textContent, /无法读取/);
  zone.listeners.dragenter(f.event()); zone.listeners.dragenter(f.event()); zone.listeners.dragleave(f.event()); assert.equal(zone.classes.has('drag-over'), true);
  zone.listeners.drop(f.event([png])); assert.equal(zone.classes.has('drag-over'), false);
  const offTarget = f.event([png]); f.document.listeners.drop(offTarget); assert.equal(offTarget.prevented, true);
  const textDrag = f.event([], ['text/plain']); f.document.listeners.dragover(textDrag); assert.equal(textDrag.prevented, false);
});

test('cancel and same-file selection retain an unsaved cover and explain that nothing was changed', () => {
  const f = fixture(); f.drop([png]);
  f.$('bili-cover-file').listeners.cancel();
  assert.match(f.$('cover-message').textContent, /尚未保存/);
  f.load(f.readers[0]); assert.equal(f.$('cover-save').disabled, false);
  f.$('bili-cover-file').files = []; f.$('bili-cover-file').listeners.change();
  assert.equal(f.$('cover-save').disabled, false); assert.equal(f.requests.length, 0);
  assert.match(f.$('cover-message').textContent, /未更改选择/);
});
test('cancel without a pending cover leaves the server cover intact and makes no request', () => {
  const f = fixture(); f.c.renderUploadCover(); const src = f.$('cover-preview').src;
  f.$('bili-cover-file').listeners.cancel();
  assert.equal(f.$('cover-preview').src, src); assert.equal(f.requests.length, 0);
  assert.match(f.$('cover-message').textContent, /原封面保持不变/);
});

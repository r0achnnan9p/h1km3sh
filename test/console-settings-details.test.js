import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setButtonIcon } from '../public/ui-primitives.js';
// 设置二级视图：只用合成数据，不调用任何真实账号、设备、扫码或缓存接口。
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.parentNode = null; this.listeners = {}; this.dataset = {}; this.hidden = false; this.textContent = ''; this.classes = new Set(); this.classList = { add: name => this.classes.add(name) }; }
  append(...nodes) { for (const node of nodes) { node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); } }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  setAttribute() {}
  reset() {}
  async emit(type) { for (const handler of this.listeners[type] || []) await handler({}); }
  click() { return this.emit('click'); }
}
function harness({ api = async () => ({}), loadSettings = async () => {}, refreshAccounts = async () => {} } = {}) {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const rows = ['dvr', 'mediamtx', 'cloud189', 'bilibili', 'password'].map(key => Object.assign(new Node('button'), { dataset: { settingsOpen: key } }));
  const sheets = [], notices = [], requests = [], opened = [], refreshes = [];
  const openDialog = (title, description, options) => {
    const sheet = { title, options, dialog: new Node('dialog'), content: new Node(), actions: new Node(), error: { textContent: '' }, closed: false, pending: false, setPending(value) { this.pending = value; },
      close() { this.closed = true; return this.dialog.emit('close'); } };
    sheets.push(sheet); return sheet;
  };
  const context = vm.createContext({ settingsInline: null, window: { addEventListener() {} }, $, document: { querySelectorAll: selector => selector === '[data-settings-open]' ? rows : [], createElement: tag => new Node(tag) }, openDialog, setButtonIcon, uploadAccounts: { refresh: async () => { refreshes.push('accounts'); return refreshAccounts(); } }, loadSettings: async () => { refreshes.push('settings'); return loadSettings(); },
    openDvrSettings: () => opened.push('dvr'), openMediaMtxEditor: () => opened.push('mediamtx'), notify: message => notices.push(message), body: JSON.stringify,
    api: async (url, options) => { requests.push({ url, options }); return api(url, options); } });
  vm.runInContext(script.slice(script.indexOf('function prettyBytes('), script.indexOf('function addButton(')), context);
  vm.runInContext(script.slice(script.indexOf('function addButton('), script.indexOf('function addOutputIconButton(')), context);
  vm.runInContext(script.slice(script.indexOf('function confirmAction('), script.indexOf('function reauthenticateForUploads(')), context);
  vm.runInContext(script.slice(script.indexOf('async function loadCache('), script.indexOf('function openRangeEditor(')), context);
  const panels = Object.fromEntries(['settings-cloud189', 'settings-bilibili', 'password-card'].map(id => { const panel = $(id); $('settings-detail-store').append(panel); return [id, panel]; }));
  return { refreshes, $, rows, row: key => rows.find(item => item.dataset.settingsOpen === key), sheets, notices, requests, opened, panels, store: $('settings-detail-store'), context };
}
const GB = 1024 ** 3;
test('cache shows the size of complete caches only, with a trash action that needs a second confirmation', async () => {
  const h = harness({ api: async () => ({ files: [{ complete: true, size: GB }, { complete: true, size: GB / 2 }, { complete: false, size: 999 * GB }] }) });
  await h.context.loadCache(); assert.equal(h.$('cache-size').textContent, '1.50 GB');
  h.requests.length = 0; await h.$('clear-cache').click();
  assert.equal(h.requests.length, 0); assert.equal(h.sheets.length, 1); assert.equal(h.sheets[0].title, '清理完整缓存？');
  const [cancel, confirm] = h.sheets[0].actions.children; assert.deepEqual([cancel.textContent, confirm.textContent], ['取消', '清理缓存']);
  assert.equal(confirm.className, 'danger-button');
  await cancel.click(); assert.equal(h.sheets[0].closed, true); assert.equal(h.requests.length, 0);
});
test('confirmed cache clearing sends DELETE once and reports the result; a 409 keeps the sheet and shows the server message', async () => {
  let conflict = false;
  const h = harness({ api: async (url, options) => {
    if (options?.method === 'DELETE') { if (conflict) throw Object.assign(new Error('缓存正被导出任务使用'), { status: 409 }); return { deletedCount: 3, deletedSize: GB }; }
    return { files: [] };
  } });
  await h.$('clear-cache').click(); await h.sheets[0].actions.children[1].click();
  const deletes = h.requests.filter(item => item.options?.method === 'DELETE'); assert.equal(deletes.length, 1); assert.equal(deletes[0].url, '/console/api/cache'); assert.equal(deletes[0].options.body, '{}');
  assert.equal(h.sheets[0].closed, true); assert.deepEqual(h.notices, ['已清理 3 个完整缓存，释放 1.00 GB。']);
  conflict = true; await h.$('clear-cache').click(); await h.sheets[1].actions.children[1].click();
  assert.equal(h.sheets[1].closed, false); assert.equal(h.sheets[1].error.textContent, '缓存正被导出任务使用'); assert.equal(h.notices.length, 1);
});
test('each row opens its own detail; account and password panels are moved into the dialog and returned on close', async () => {
  const h = harness();
  await h.row('dvr').click(); await h.row('mediamtx').click(); assert.deepEqual(h.opened, ['dvr', 'mediamtx']); assert.equal(h.sheets.length, 0);
  await h.row('cloud189').click(); const cloud = h.sheets.at(-1);
  assert.equal(cloud.title, '189'); assert.equal(cloud.options.trackChanges, false); assert.ok(cloud.dialog.classes.has('settings-dialog'));
  assert.equal(h.panels['settings-cloud189'].parentNode, cloud.content); assert.equal(h.store.children.includes(h.panels['settings-cloud189']), false);
  await cloud.close(); assert.equal(h.panels['settings-cloud189'].parentNode, h.store);
  await h.row('bilibili').click(); assert.equal(h.sheets.at(-1).title, 'B站'); assert.equal(h.panels['settings-bilibili'].parentNode, h.sheets.at(-1).content);
  await h.sheets.at(-1).close(); assert.equal(h.panels['settings-bilibili'].parentNode, h.store);
  await h.row('password').click(); assert.equal(h.sheets.at(-1).title, '访问密码'); assert.equal(h.panels['password-card'].parentNode, h.sheets.at(-1).content);
  await h.sheets.at(-1).close(); assert.equal(h.panels['password-card'].parentNode, h.store);
});
test('manual upload-status refresh stays in both account details and only rereads settings and accounts', async () => {
  for (const key of ['cloud189', 'bilibili']) {
    const h = harness(); await h.row(key).click(); const sheet = h.sheets.at(-1);
    const refresh = sheet.actions.children.find(item => item.title === '重新检测上传状态'); assert.ok(refresh, key);
    await refresh.click(); assert.deepEqual(h.refreshes.sort(), ['accounts', 'settings']); assert.deepEqual(h.notices, []); assert.equal(sheet.content.children.find(node => node.className === 'settings-refresh-status').textContent, '上传状态已刷新。');
    assert.equal(h.requests.length, 0); assert.equal(refresh.disabled, false);
  }
  const failing = harness({ refreshAccounts: async () => { throw new Error('账号接口暂不可用'); } }); await failing.row('cloud189').click();
  await failing.sheets.at(-1).actions.children.find(item => item.title === '重新检测上传状态').click();
  assert.deepEqual(failing.notices, []); assert.equal(failing.sheets.at(-1).content.children.find(node => node.className === 'settings-refresh-status error').textContent, '账号接口暂不可用');
});


// Refresh has immediate feedback in the same top-layer dialog, not a covered toast.
test('manual refresh is single flight and reports pending status before the request finishes', async () => {
  let finish; const h = harness({ refreshAccounts: () => new Promise(resolve => { finish = resolve; }) });
  await h.row('cloud189').click(); const sheet = h.sheets.at(-1);
  const button = sheet.actions.children.find(node => node.title === '重新检测上传状态');
  const pending = button.click();
  assert.equal(button.disabled, true); assert.equal(sheet.content.children.find(node => node.className === 'settings-refresh-status').textContent, '正在刷新…');
  await button.click(); assert.deepEqual(h.refreshes.sort(), ['accounts','settings']);
  finish(); await pending; assert.equal(button.disabled, false);
});
test('closing the password dialog clears typed passwords from the parked form', async () => {
  const h = harness(); let resets = 0; h.$('password-form').reset = () => { resets++; };
  await h.row('password').click(); h.$('password-message').textContent = '错误'; await h.sheets.at(-1).close();
  assert.equal(resets, 1); assert.equal(h.$('password-message').textContent, ''); assert.equal(h.panels['password-card'].parentNode, h.store);
});
test('reopening a panel before the old dialog finishes closing keeps it in the new dialog', async () => {
  const h = harness();
  await h.row('cloud189').click(); const first = h.sheets.at(-1);
  await h.row('cloud189').click(); const second = h.sheets.at(-1);
  await first.dialog.emit('close');
  assert.equal(h.panels['settings-cloud189'].parentNode, second.content);
  await second.dialog.emit('close'); assert.equal(h.panels['settings-cloud189'].parentNode, h.store);
});
test('upload shortcuts and the home rows share one detail table', () => {
  assert.match(script, /const settingsDetails = \{\s*dvr: openDvrSettings,\s*mediamtx: openMediaMtxEditor,\s*cloud189:[^\n]*renderCloud189Settings[^\n]*\s*bilibili:[^\n]*renderBilibiliSettings[^\n]*\s*password:[^\n]*renderPasswordSettings/);
  assert.match(script, /function navigateToUploadSettings\(provider\) \{\s*navigate\('settings'\);\s*settingsDetails\[provider\]\(\);/);
});
test('server-managed password hides both the row and its panel; editable mode shows them', () => {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = vm.createContext({ $ });
  vm.runInContext(script.slice(script.indexOf('function renderPasswordMode('), script.indexOf('let settingsCsrfToken')), context);
  context.renderPasswordMode(true); assert.equal($('settings-open-password').hidden, true); assert.equal($('password-card').hidden, true); assert.equal($('password-form').hidden, true);
  context.renderPasswordMode(false); assert.equal($('settings-open-password').hidden, false); assert.equal($('password-card').hidden, false); assert.equal($('password-form').hidden, false);
});
test('settings styles use registered tokens only and keep rows finger-sized', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const rules = css.split(/\r?\n/).filter(line => /^\.settings-(group|item|detail|toolbar)/.test(line) || /^button\.settings-item/.test(line));
  assert.ok(rules.length > 10);
  for (const rule of rules) { assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b/i, rule); assert.doesNotMatch(rule, /rgba\((?!255,255,255,\.(?:04|06|08|10|12|14|16|18|20|22|28|35|55)\))/, rule); assert.doesNotMatch(rule, /var\(--[\w-]+,/, rule); }
  assert.match(css, /\.settings-item \{[^}]*min-height: 64px/); assert.match(css, /\.settings-item-action \{[^}]*width: 44px; height: 44px/);
});

import { iconSvg, setButtonIcon, createSettingsRow } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const touch = fs.readFileSync(new URL('../public/touch-controls.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
class Element {
  constructor(tag = '') { this.tag = tag; }
  listeners = {}; children = []; disabled = false; hidden = false; textContent = ''; _value = ''; dataset = {};
  classList = { add() {}, remove() {} };
  get value() { return this.tag === 'select' ? this._value || this.children[0]?.value || '' : this._value; }
  set value(value) { this._value = value; }
  get options() { return this.children; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; this._value = ''; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async emit(type) { for (const fn of this.listeners[type] || []) await fn({}); }
  focus() {} setAttribute() {} removeAttribute() {}
  click() { if (!this.disabled) return this.emit('click'); }
  querySelectorAll(selector) { const tags = selector.split(',').map(s => s.trim()); return this.children.flatMap(child => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]); }
}
const initial = () => ({ revision: 'r1', csrfToken: 'csrf-one', preparationOnly: false,
  dvrs: [{ id: 'a', name: 'DVR A', ip: '192.0.2.1', username: 'admin', httpPort: 80, rtspPort: 554, hasPassword: true }, { id: 'b', name: 'DVR B', ip: '192.0.2.2', username: 'admin', httpPort: 8080, rtspPort: 8554, hasPassword: true }],
  cameras: [{ id: 'field-1', name: 'Field', deviceId: 'a', channel: '101' }], mediamtx: { playbackUrl: 'http://media.test:9996' } });
function harness(request = async () => ({ ...initial(), revision: 'r2' })) {
  const elements = new Map(), sheets = [], requests = [], logouts = [];
  const state = { dvrChannelRequestId: 1, segmentRequestId: 1, dvrChannels: { b: '101' }, selectedChannel: '101', inMs: 1, outMs: 2, segments: [{}] };
  let resets = 0;
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ settingsInline: null, window: { addEventListener() {} }, iconSvg, setButtonIcon, createSettingsRow, $, state, clearMarkedRange() { state.inMs = state.outMs = null; }, invalidatePlaybackSelection() { state.segmentRequestId++; state.segments = []; resets++; }, updateSelection() {}, setPlaybackNotice() {}, document: { createElement: tag => new Element(tag) }, body: JSON.stringify, fillDvrDevices() {}, fillCameras() {}, notify() {}, loggedOut: message => logouts.push(message),
    requestJson: async (url, options) => { requests.push({ url, options }); return request(url, options); },
    openDialog: () => {
      const sheet = { dialog: new Element('dialog'), content: new Element(), actions: new Element(), error: new Element(), closed: false,
        setPending(value) { this.dialog.querySelectorAll('button,input').forEach(node => { node.disabled = value; }); }, close() { this.closed = true; this.dialog.emit('close'); } };
      sheet.dialog.append(sheet.content, sheet.actions); sheets.push(sheet); return sheet;
    },
  });
  vm.runInContext(script.slice(script.indexOf('function addButton('), script.indexOf('function renderOutputs(')), context);
  vm.runInContext(touch.slice(touch.indexOf('export function labelledInput('), touch.indexOf('export function mp4Basename(')).replace('export ', ''), context);
  vm.runInContext(script.slice(script.indexOf('function openSettingsContainer('), script.indexOf('function openSettingsPanel(')), context);
  vm.runInContext(script.slice(script.indexOf('// Configuration is fetched separately'), script.indexOf('function renderPasswordMode(')), context);
  context.acceptConsoleConfig(initial());
  return { context, $, state, resets: () => resets, sheets, requests, logouts, sheet: () => sheets.at(-1) };
}
const inputs = sheet => sheet.dialog.querySelectorAll('input');
const button = (sheet, label) => sheet.dialog.querySelectorAll('button').find(item => item.textContent === label);
const iconButton = (sheet, label) => sheet.dialog.querySelectorAll('button').find(item => item.title === label);
const configLists = sheet => sheet.content.children.filter(item => item.className === 'config-list');
test('config shell stays in settings and preparation mode locks source controls', () => {
  const html = statusDashboardPage(); assert.ok(html.indexOf('id="config-title"') > html.indexOf('id="view-settings"'));
  assert.match(html, /HIKCLIP_PREPARATION_ONLY/);
  const h = harness(); h.context.acceptConsoleConfig({ ...initial(), preparationOnly: true });
  assert.equal(h.$('config-preparation').hidden, false); assert.equal(h.requests.length, 0);
  h.context.openDvrSettings(); const dvr = h.sheet();
  assert.equal(iconButton(dvr, '添加录像机').disabled, true); assert.ok(configLists(dvr)[0].children.every(row => row.disabled));
  h.context.openMediaMtxEditor(); const mediamtx = h.sheet();
  assert.equal(iconButton(mediamtx, '手动补充通道').disabled, true); assert.equal(button(mediamtx, '保存地址').disabled, true);
  assert.equal(h.requests.length, 0);
});
test('edit never reads saved password and sends revision, CSRF and explicit ports; blank preserves password', async () => {
  const h = harness(); h.context.openDvrEditor({ ...initial().dvrs[0], password: 'MUST-NOT-READ' });
  const fields = inputs(h.sheet()); assert.equal(fields[3].type, 'password'); assert.equal(fields[3].value, '');
  fields[0].value = 'North'; await button(h.sheet(), '保存录像机').click();
  assert.equal(h.requests.length, 1); const request = h.requests[0], payload = JSON.parse(request.options.body);
  assert.equal(request.url, '/console/api/dvrs/a'); assert.equal(request.options.method, 'PATCH');
  assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-one'); assert.equal(payload.revision, 'r1');
  assert.equal(payload.httpPort, 80); assert.equal(payload.rtspPort, 554); assert.equal('password' in payload, false); assert.equal(h.sheet().closed, true);
});
test('create requires password and pending state prevents double submit', async () => {
  let resolve; const h = harness(() => new Promise(done => { resolve = done; })); h.context.openDvrEditor();
  const sheet = h.sheet(), fields = inputs(sheet); fields[0].value = 'New'; fields[1].value = '192.0.2.3'; fields[2].value = 'admin';
  await button(sheet, '保存录像机').click(); assert.equal(h.requests.length, 0);
  fields[3].value = 'typed-secret'; const save = button(sheet, '保存录像机'); const first = save.click(); await save.click(); assert.equal(h.requests.length, 1);
  resolve({ ...initial(), revision: 'r2' }); await first; assert.equal(fields[3].value, '');
});
test('stale revision keeps inputs and requires explicit refresh/review before retry', async () => {
  const h = harness(async (url) => { if (url === '/console/api/config') return { ...initial(), revision: 'r2' }; const error = new Error('配置已更新'); error.status = 409; throw error; });
  h.context.openDvrEditor(initial().dvrs[0]); const sheet = h.sheet(); inputs(sheet)[0].value = 'Unsaved';
  await button(sheet, '保存录像机').click(); assert.equal(sheet.closed, false); assert.equal(inputs(sheet)[0].value, 'Unsaved'); assert.equal(sheet.context.revision, 'r1');
  await button(sheet, '载入最新配置，保留输入').click(); assert.equal(sheet.context.revision, 'r2'); assert.equal(inputs(sheet)[0].value, 'Unsaved'); assert.match(sheet.error.textContent, /请核对/);
});
test('session expiry draft resume retains typed values and original revision without persisting storage', async () => {
  const h = harness(async () => { const error = new Error('expired'); error.status = 401; throw error; });
  h.context.openDvrEditor(initial().dvrs[0]); inputs(h.sheet())[0].value = 'Unsaved';
  const resume = vm.runInContext('configEditor.resume', h.context); await button(h.sheet(), '保存录像机').click(); assert.equal(h.logouts.length, 1);
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r9' }); resume(); assert.equal(inputs(h.sheet())[0].value, 'Unsaved'); assert.equal(h.sheet().context.revision, 'r1');
  assert.doesNotMatch(script.slice(script.indexOf('// Configuration is fetched separately'), script.indexOf('function renderPasswordMode(')), /localStorage|sessionStorage/);
});
test('camera picker scopes identical channel IDs by recorder and changing recorder clears old channel', async () => {
  const h = harness(async () => ({ channels: [{ id: '101', name: 'B camera' }] })); h.context.openCameraEditor(initial().cameras[0]);
  const sheet = h.sheet(), selects = sheet.dialog.querySelectorAll('select'); assert.equal(selects[0].value, 'a'); assert.equal(selects[1].value, '101');
  selects[0].value = 'b'; await selects[0].emit('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/console/api/dvrs/b/channels'); assert.equal(selects[1].value, '101');
  assert.equal(inputs(sheet)[2].readOnly, true);
});
test('camera save preserves other mappings and identifies DVR B channel 101 separately', async () => {
  const h = harness(); h.context.openCameraEditor(initial().cameras[0]); const sheet = h.sheet();
  const selects = sheet.dialog.querySelectorAll('select'); selects[0].value = 'b';
  await button(sheet, '保存映射').click(); const payload = JSON.parse(h.requests[0].options.body);
  assert.equal(payload.cameras[0].deviceId, 'b'); assert.equal(payload.cameras[0].channel, '101'); assert.equal(payload.cameras[0].id, 'field-1'); assert.equal('archivePath' in payload.cameras[0], false);
});
test('delete is explicit confirmation and busy/ref errors retain confirmation sheet', async () => {
  const h = harness(async () => { const e = new Error('仍被通道引用'); e.status = 409; throw e; }); h.context.openRecorderActions(initial().dvrs[0]);
  await button(h.sheet(), '删除录像机').click(); assert.equal(h.requests.length, 0);
  await button(h.sheet(), '确认删除').click(); assert.equal(h.requests[0].options.method, 'DELETE'); assert.equal(h.sheet().closed, false); assert.match(h.sheet().error.textContent, /引用/);
});
test('MediaMTX writes only playback URL; background config refresh never replaces open fields', async () => {
  const h = harness(); h.context.openMediaMtxEditor(); const sheet = h.sheet(); inputs(sheet)[0].value = 'http://new-media.test:9996';
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r2' }); assert.equal(inputs(sheet)[0].value, 'http://new-media.test:9996');
  await button(sheet, '保存地址').click(); assert.deepEqual(JSON.parse(h.requests[0].options.body), { playbackUrl: 'http://new-media.test:9996', revision: 'r1' });
});

test('changed configuration invalidates recorder channels, old coverage and marked export range without probing', () => {
  const h = harness(); const before = h.resets(); h.state.selectedChannel = '101'; h.state.dvrChannels = { b: '101' }; h.state.segments = [{ stale: true }]; h.state.inMs = 100; h.state.outMs = 200;
  const requestId = h.state.dvrChannelRequestId, segmentId = h.state.segmentRequestId;
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r2', dvrs: [initial().dvrs[0]] });
  assert.equal(h.state.selectedChannel, ''); assert.equal(Object.keys(h.state.dvrChannels).length, 0); assert.equal(h.state.segments.length, 0); assert.equal(h.state.inMs, null); assert.equal(h.state.outMs, null);
  assert.equal(h.state.dvrChannelRequestId, requestId + 1); assert.equal(h.state.segmentRequestId, segmentId + 1); assert.equal(h.$('dvr-channel').disabled, true); assert.equal(h.requests.length, 0);
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r2' }); assert.equal(h.resets(), before + 1);
});

test('changing saved host, username or ports requires re-entering a password before sending', async () => {
  for (const index of [1, 2, 4, 5]) {
    const h = harness(); h.context.openDvrEditor(initial().dvrs[0]); const fields = inputs(h.sheet()); fields[index].value = index >= 4 ? '9000' : 'changed';
    await button(h.sheet(), '保存录像机').click(); assert.equal(h.requests.length, 0); assert.match(h.sheet().error.textContent, /重新输入设备密码/);
  }
});

test('failed automatic DVR test exposes explicit force save, editing invalidates that consent', async () => {
  const h = harness(async (url, options) => { const payload = JSON.parse(options.body); if (!payload.forceSave) { const error = new Error('连接失败'); error.code = 'DVR_PROBE_FAILED'; error.forceSaveRequired = true; throw error; } return initial(); });
  h.context.openDvrEditor(); const sheet = h.sheet(), fields = inputs(sheet);
  ['New', '192.0.2.3', 'admin', 'test'].forEach((value, i) => { fields[i].value = value; });
  await button(sheet, '保存录像机').click(); assert.equal(sheet.closed, false);
  const force = button(sheet, '测试失败，仍然保存'); assert.equal(force.hidden, false);
  fields[1].value = '192.0.2.4'; await force.click(); assert.equal(h.requests.length, 1); assert.match(sheet.error.textContent, /重新测试/);
  await button(sheet, '保存录像机').click(); await force.click();
  assert.equal(JSON.parse(h.requests.at(-1).options.body).forceSave, true); assert.equal(sheet.closed, true);
});
test('camera snapshot posts only saved recorder/channel and revision, rendering bounded image response', async () => {
  const h = harness(async () => ({ imageDataUrl: 'data:image/jpeg;base64,YQ==' })); h.context.openCameraEditor(initial().cameras[0]);
  await button(h.sheet(), '查看实时画面').click();
  assert.equal(h.requests[0].url, '/console/api/dvrs/a/snapshot'); assert.deepEqual(JSON.parse(h.requests[0].options.body), { channel: '101', revision: 'r1' });
  const image = h.sheet().dialog.querySelectorAll('img')[0]; assert.equal(image.hidden, false); assert.match(image.src, /^data:image\/jpeg/);
});

test('automatic local channels work with no DVR and are optional rename overrides, not required mappings', async () => {
  const h = harness();
  const discovered = { id: 'd1', name: 'd1', archivePath: 'd1' };
  h.context.acceptConsoleConfig({ ...initial(), dvrs: [], cameras: [], channels: [discovered] });
  h.context.openMediaMtxEditor(); const detail = h.sheet();
  assert.equal(iconButton(detail, '手动补充通道').disabled, false);
  assert.equal(configLists(detail)[0].children.length, 1);
  h.context.openCameraEditor(discovered);
  const sheet = h.sheet(), fields = inputs(sheet), selects = sheet.dialog.querySelectorAll('select');
  assert.equal(fields[0].value, 'd1'); assert.equal(fields[1].value, 'd1'); assert.equal(fields[2].value, 'd1');
  assert.equal(selects[0].value, ''); assert.equal(h.requests.length, 0);
  fields[0].value = '前场'; await button(sheet, '保存映射').click();
  const payload = JSON.parse(h.requests[0].options.body);
  assert.deepEqual(payload.cameras, [{ id: 'd1', name: '前场', archivePath: 'd1' }]);
});
test('manual fallback needs only a path, automatically supplies name and ID, and never picks a DVR', async () => {
  const h = harness(); h.context.openCameraEditor();
  const sheet = h.sheet(), fields = inputs(sheet);
  fields[1].value = 'd3'; await button(sheet, '保存映射').click();
  const payload = JSON.parse(h.requests[0].options.body);
  assert.deepEqual(payload.cameras.at(-1), { id: 'd3', name: 'd3', archivePath: 'd3' });
  assert.deepEqual(payload.cameras[0], initial().cameras[0]);
});
test('clearing an optional DVR binding keeps the original stable ID and archive path', async () => {
  const h = harness(); h.context.openCameraEditor(initial().cameras[0]);
  const sheet = h.sheet(), selects = sheet.dialog.querySelectorAll('select');
  selects[0].value = ''; await selects[0].emit('change');
  await button(sheet, '保存映射').click();
  assert.deepEqual(JSON.parse(h.requests[0].options.body).cameras, [{ id: 'field-1', name: 'Field', archivePath: 'field-1' }]);
});

test('settings home groups sources and accounts as plain rows; playback address and long forms leave the main page', () => {
  const html = statusDashboardPage(), settingsView = html.slice(html.indexOf('id="view-settings"')), home = html.slice(html.indexOf('id="config-title"'), html.indexOf('id="settings-detail-store"'));
  assert.doesNotMatch(settingsView, /<h2[^>]*>录像来源<\/h2>|MediaMTX 与 DVR 通道自动读取|回放地址|MediaMTX 通道|天翼云盘|云盘/);
  for (const id of ['config-add-dvr', 'config-add-camera', 'config-edit-mediamtx', 'config-mediamtx-url', 'integration-refresh']) assert.ok(!html.includes(`id="${id}"`));
  const labels = [...home.matchAll(/class="settings-item-name">([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(labels, ['海康录像机', 'MediaMTX', '189', 'B站', '缓存', '密码', '退出登录']);
  assert.deepEqual([...home.matchAll(/<section class="settings-group" aria-label="([^"]+)"/g)].map(match => match[1]), ['来源', '上传账户', '缓存', '账户']);
  for (const key of ['dvr', 'mediamtx', 'cloud189', 'bilibili', 'password']) {
    const start = home.indexOf(`id="settings-open-${key}" type="button" data-settings-open="${key}"`), row = home.slice(start, home.indexOf('</button>', start));
    assert.ok(start > 0 && row.includes('<svg') && row.includes('settings-item-chevron'), key);
  }
  assert.match(home, /id="settings-status-cloud189" role="img"/);
  assert.doesNotMatch(home, /<form|<input|cover-preview|upload-account-/);
  assert.match(css, /\.settings-item \{[^}]*min-height: 64px/); assert.match(css, /\.settings-item-action \{[^}]*width: 44px; height: 44px/);
});
test('settings MediaMTX detail edits Playback URL and lists channels; DVR rows open recorder actions', async () => {
  const h = harness(); h.context.openMediaMtxEditor(); const sheet = h.sheet();
  assert.equal(inputs(sheet)[0].value, 'http://media.test:9996'); assert.equal(sheet.dialog.querySelectorAll('select').length, 0);
  const [list] = configLists(sheet); assert.equal(list.children.length, 1); assert.equal(list.children[0].children[0].textContent, 'Field · field-1');
  h.context.openDvrSettings(); const dvr = h.sheet(), [rows] = configLists(dvr);
  assert.deepEqual(rows.children.map(row => row.children[0].textContent), ['DVR A', 'DVR B']);
  await rows.children[0].click(); assert.ok(button(h.sheet(), '编辑连接设置')); assert.notEqual(h.sheet(), dvr);
  assert.equal(h.requests.length, 0);
});
test('source detail views deduplicate identifiers while preserving names, paths, bindings and connection errors', () => {
  const h = harness(), config = initial();
  config.channels = [{ id: 'd1', name: 'd1', archivePath: 'd1' }, { id: 'd2', name: '球场', archivePath: 'archive-d2', deviceId: 'a', channel: '201' }];
  h.context.acceptConsoleConfig(config);
  h.context.openMediaMtxEditor(); const [plain, linked] = configLists(h.sheet())[0].children;
  assert.equal(plain.children[0].textContent, 'd1'); assert.equal(plain.children[1].hidden, true);
  assert.equal(linked.children[0].textContent, '球场 · d2'); assert.equal(linked.children[1].textContent, '路径 archive-d2 · DVR A / 201');
  h.context.openDvrSettings(); const sheet = h.sheet();
  const dvr = configLists(sheet)[0].children[0]; assert.equal(dvr.children[1].textContent, '192.0.2.1'); assert.equal(dvr.children[2].hidden, true);
  vm.runInContext("recorderChecks.set('a', '测试失败'); renderConsoleConfig();", h.context);
  const failed = configLists(sheet)[0].children[0]; assert.equal(failed.children[2].textContent, '测试失败'); assert.equal(failed.children[2].hidden, false);
});
test('recorder connection settings: saved-connection test records success or failure and never starts playback', async () => {
  let fail = false;
  const h = harness(async url => { if (fail) throw Object.assign(new Error('设备无响应'), { status: 502 }); return { channels: [{ id: '101', name: 'Field' }] }; });
  h.context.openRecorderActions(initial().dvrs[0]); const sheet = h.sheet();
  assert.ok(button(sheet, '编辑连接设置')); assert.ok(button(sheet, '读取已保存录像机的通道')); assert.ok(button(sheet, '删除录像机'));
  await button(sheet, '测试已保存连接').click();
  assert.equal(h.requests[0].url, '/console/api/dvrs/a/test'); assert.equal(h.requests[0].options.headers['X-CSRF-Token'], 'csrf-one'); assert.equal(JSON.parse(h.requests[0].options.body).revision, 'r1');
  assert.equal(vm.runInContext("recorderChecks.get('a')", h.context), '连接正常'); assert.match(sheet.error.textContent, /未启动播放或导出/);
  fail = true; await button(sheet, '测试已保存连接').click();
  assert.equal(vm.runInContext("recorderChecks.get('a')", h.context), '测试失败'); assert.equal(sheet.error.textContent, '设备无响应');
  h.context.openDvrSettings(); assert.equal(configLists(h.sheet())[0].children[0].children[2].textContent, '测试失败');
});
test('source detail icon actions are labelled; refresh rereads config only', async () => {
  const h = harness(); h.context.openDvrSettings(); const sheet = h.sheet();
  for (const label of ['添加录像机', '重新读取来源配置']) { const control = iconButton(sheet, label); assert.ok(control, label); assert.equal(control.attributes?.['aria-label'] ?? label, label); }
  await iconButton(sheet, '重新读取来源配置').click();
  assert.deepEqual(h.requests.map(item => [item.url, item.options]), [['/console/api/config', undefined]]);
  h.context.openMediaMtxEditor(); assert.ok(iconButton(h.sheet(), '手动补充通道'));
});
test('MediaMTX detail tolerates an unread config, registers a draft only after the URL is edited, and can reread config', async () => {
  const h = harness(); vm.runInContext('consoleConfig = null', h.context);
  h.context.openMediaMtxEditor(); const sheet = h.sheet();
  assert.equal(inputs(sheet)[0].value, ''); assert.equal(button(sheet, '保存地址').disabled, true); assert.equal(iconButton(sheet, '手动补充通道').disabled, true);
  assert.equal(vm.runInContext('configEditor', h.context), null);
  h.context.acceptConsoleConfig(initial()); h.context.openMediaMtxEditor(); const second = h.sheet();
  assert.equal(vm.runInContext('configEditor', h.context), null); assert.equal(button(second, '保存地址').disabled, false);
  await inputs(second)[0].emit('input'); assert.equal(vm.runInContext('configEditor.sheet', h.context), second);
  await iconButton(second, '重新读取来源配置').click(); assert.equal(h.requests.at(-1).url, '/console/api/config');
});
test('open source views redraw on config changes and unregister on close without touching inputs', async () => {
  const h = harness(); h.context.openMediaMtxEditor(); const sheet = h.sheet(); inputs(sheet)[0].value = 'http://draft.test';
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r2', cameras: [], channels: [{ id: 'new-1', name: 'new-1' }, { id: 'new-2', name: 'new-2' }] });
  assert.equal(configLists(sheet)[0].children.length, 2); assert.equal(inputs(sheet)[0].value, 'http://draft.test');
  assert.equal(vm.runInContext('settingsViews.size', h.context), 1); sheet.close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(vm.runInContext('settingsViews.size', h.context), 0);
});
test('home rows show recorder and channel counts with a warning only when nothing is configured', () => {
  const h = harness(), row = key => ({ value: h.$(`settings-value-${key}`), status: h.$(`settings-status-${key}`) });
  assert.equal(row('dvr').value.textContent, '2'); assert.equal(row('dvr').status.hidden, true); assert.equal(row('mediamtx').value.textContent, '1');
  h.context.acceptConsoleConfig({ ...initial(), revision: 'r2', dvrs: [], cameras: [], mediamtx: {} });
  assert.equal(row('dvr').status.hidden, false); assert.match(row('dvr').status.innerHTML, /<svg/); assert.match(row('dvr').status.className, /warn/);
  assert.equal(row('mediamtx').status.hidden, false); assert.equal(row('mediamtx').value.textContent, '0');
});

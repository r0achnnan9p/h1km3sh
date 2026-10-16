import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { iconSvg, setButtonIcon, createSettingsRow } from '../public/ui-primitives.js';
// 真实的 openDialog / labelledInput（public/touch-controls.js）+ 真实的设置详情渲染函数，只有 DOM 与网络是合成的。
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const touch = fs.readFileSync(new URL('../public/touch-controls.js', import.meta.url), 'utf8');
class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.parentNode = null; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.className = ''; this.style = { setProperty() {} }; this.classList = { add: name => { this.className += ` ${name}`; } }; this.isConnected = true; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatchEvent(event) { for (const handler of this.listeners[event.type] || []) handler(event); return true; }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== handler); }
  async emit(type) { for (let node = this; node; node = node.parentNode) for (const handler of node.listeners[type] || []) await handler({ target: this }); }
  click() { return this.disabled ? undefined : this.emit('click'); }
  focus() {} select() {} setSelectionRange() {}
  querySelectorAll(selector) { const tags = selector.split(',').map(part => part.trim()); return this.children.flatMap(child => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]); }
  // 原生 <dialog>：close 同步派发 close 事件即可（真实浏览器是异步，不影响这里的顺序语义）。
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; return this.emit('close'); }
}
function harness(request, { desktop = false } = {}) {
  const body = new Node('body'), elements = new Map(), requests = [], logouts = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
  const state = { dvrChannelRequestId: 0, segmentRequestId: 0, dvrChannels: {}, selectedChannel: '', inMs: null, outMs: null, segments: [] };
  const document = { body, activeElement: null, createElement: tag => new Node(tag), querySelector: () => null };
  const context = vm.createContext({ settingsInline: null, Event, iconSvg, setButtonIcon, createSettingsRow, $, state, document, window: { innerWidth: desktop ? 1440 : 390, matchMedia: () => ({ matches: desktop }), innerHeight: 800, addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    clearMarkedRange() {}, invalidatePlaybackSelection() {}, updateSelection() {}, setPlaybackNotice() {}, fillDvrDevices() {}, fillCameras() {}, notify() {}, body: JSON.stringify, loggedOut: message => logouts.push(message),
    requestJson: async (url, options) => { requests.push({ url, options }); return request(url, options); } });
  vm.runInContext(touch.replace(/^import .*;$/gm, '').replaceAll('export ', ''), context);
  vm.runInContext(script.slice(script.indexOf('function openSettingsContainer('), script.indexOf('function openSettingsPanel(')), context);
  vm.runInContext(script.slice(script.indexOf('function addButton('), script.indexOf('function renderOutputs(')), context);
  vm.runInContext(script.slice(script.indexOf('// Configuration is fetched separately'), script.indexOf('function renderPasswordMode(')), context);
  // 与真实 loggedOut 相同的草稿挂起：登录失效时记下 configEditor.resume，并关闭当前弹层。
  vm.runInContext("var suspended = null; loggedOut = function (message) { logouts.push(message); if (configEditor) suspended = configEditor.resume; activeDialog?.close(); };", Object.assign(context, { logouts }));
  const dialogs = () => body.children.filter(node => node.tag === 'dialog' && node.open);
  return { context, $, body, requests, dialogs, logouts, resume: () => vm.runInContext('suspended', context)() };
}
const config = (revision = 'r1', playbackUrl = 'http://media.test:9996') => ({ revision, csrfToken: 'csrf-one', preparationOnly: false, dvrs: [], cameras: [{ id: 'field-1', name: 'Field', archivePath: 'field-1' }], channels: [{ id: 'field-1', name: 'Field', archivePath: 'field-1' }], mediamtx: { playbackUrl } });
const find = (dialog, test) => dialog.querySelectorAll('button, input').find(test);
const urlInput = dialog => dialog.querySelectorAll('input')[0];
const titleOf = dialog => dialog.children[0].children[0].textContent;
const addButtonOf = dialog => find(dialog, node => node.title === '手动补充通道');
const channelRow = dialog => find(dialog, node => node.tag === 'button' && node.className.includes('settings-row'));
const errorOf = dialog => dialog.children.find(node => node.className === 'dialog-error');

test('dirty MediaMTX URL survives add/channel clicks; only an explicit second click on the same entry discards it', async () => {
  const h = harness(async () => config());
  h.context.acceptConsoleConfig(config()); h.context.openMediaMtxEditor();
  let [detail] = h.dialogs(); assert.equal(titleOf(detail), 'MediaMTX'); assert.equal(urlInput(detail).value, 'http://media.test:9996');
  // 未改动：入口直接打开，不拦截。
  await addButtonOf(detail).click(); assert.equal(h.dialogs().length, 1); assert.equal(titleOf(h.dialogs()[0]), '手动补充通道'); assert.equal(detail.open, false);
  h.context.openMediaMtxEditor(); [detail] = h.dialogs();
  const input = urlInput(detail); input.value = 'http://draft.test:9996'; await input.emit('input');
  // 点击 + / 通道行：拦截，当前弹层与草稿保持不变，且没有发请求。
  await addButtonOf(detail).click(); assert.equal(h.dialogs().length, 1); assert.equal(h.dialogs()[0], detail); assert.equal(input.value, 'http://draft.test:9996'); assert.match(errorOf(detail).textContent, /尚未保存/);
  await channelRow(detail).click(); assert.equal(h.dialogs()[0], detail); assert.equal(titleOf(detail), 'MediaMTX');
  // “取消”= 不再点第二次：改回去后不再算脏，入口直接放行；草稿在此之前一直保留。
  assert.equal(input.value, 'http://draft.test:9996'); assert.equal(h.requests.length, 0);
  // 明确放弃：同一入口连续第二次点击才切换，旧弹层关闭。
  await channelRow(detail).click(); assert.equal(titleOf(h.dialogs()[0]), '通道名称与关联'); assert.equal(detail.open, false);
  await h.dialogs()[0].querySelectorAll('button')[0].click();
  h.context.openMediaMtxEditor(); assert.equal(urlInput(h.dialogs()[0]).value, 'http://media.test:9996');
  assert.equal(h.requests.length, 0);
});
test('editing again after the warning re-arms the guard; reverting to the saved URL is not dirty', async () => {
  const h = harness(async () => config());
  h.context.acceptConsoleConfig(config()); h.context.openMediaMtxEditor(); const [detail] = h.dialogs(), input = urlInput(detail);
  input.value = 'http://changed'; await input.emit('input'); await addButtonOf(detail).click(); assert.equal(h.dialogs()[0], detail);
  input.value = 'http://changed-more'; await input.emit('input'); await addButtonOf(detail).click(); assert.equal(h.dialogs()[0], detail, 'new edit needs a fresh warning');
  input.value = 'http://media.test:9996'; await input.emit('input'); await addButtonOf(detail).click(); assert.equal(titleOf(h.dialogs()[0]), '手动补充通道');
});
test('closing a dirty MediaMTX dialog still asks before discarding (real openDialog path)', async () => {
  const h = harness(async () => config());
  h.context.acceptConsoleConfig(config()); h.context.openMediaMtxEditor(); const [detail] = h.dialogs(), input = urlInput(detail);
  input.value = 'http://draft'; await input.emit('input');
  const closeButton = detail.children[0].children[1]; await closeButton.click();
  assert.equal(detail.open, true); assert.match(errorOf(detail).textContent, /未保存/); await closeButton.click(); assert.equal(detail.open, false);
});
test('config arriving late fills the same unedited sheet and the first save carries the loaded revision', async () => {
  const h = harness(async (url, options) => {
    if (JSON.parse(options.body).revision !== 'r7') throw Object.assign(new Error('配置已更新'), { status: 409 });
    return config('r8', JSON.parse(options.body).playbackUrl);
  });
  vm.runInContext('consoleConfig = null', h.context);
  h.context.openMediaMtxEditor(); const [detail] = h.dialogs(), input = urlInput(detail), save = find(detail, node => node.textContent === '保存地址');
  assert.equal(input.value, ''); assert.equal(save.disabled, true); assert.equal(vm.runInContext('configEditor', h.context), null);
  h.context.acceptConsoleConfig(config('r7', 'http://late.test:9996'));
  assert.equal(h.dialogs()[0], detail); assert.equal(input.value, 'http://late.test:9996'); assert.equal(save.disabled, false);
  input.value = 'http://new.test:9996'; await input.emit('input'); await save.click();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/console/api/mediamtx'); assert.deepEqual(JSON.parse(h.requests[0].options.body), { playbackUrl: 'http://new.test:9996', revision: 'r7' });
  assert.equal(h.requests[0].options.headers['X-CSRF-Token'], 'csrf-one'); assert.equal(detail.open, false);
});
test('an edited draft typed before config arrived keeps its text and still conflicts if the config changes again', async () => {
  const h = harness(async (url, options) => {
    if (JSON.parse(options.body).revision !== 'r8') throw Object.assign(new Error('配置已更新'), { status: 409 });
    return config('r9');
  });
  vm.runInContext('consoleConfig = null', h.context);
  h.context.openMediaMtxEditor(); const [detail] = h.dialogs(), input = urlInput(detail), save = find(detail, node => node.textContent === '保存地址');
  input.value = 'http://typed.test:9996'; await input.emit('input');
  h.context.acceptConsoleConfig(config('r7', 'http://late.test:9996'));
  assert.equal(input.value, 'http://typed.test:9996'); assert.equal(detail.open, true);
  h.context.acceptConsoleConfig(config('r8', 'http://other-session.test:9996')); // 之后另一会话改了配置
  assert.equal(input.value, 'http://typed.test:9996');
  await save.click();
  assert.equal(JSON.parse(h.requests[0].options.body).revision, 'r7', 'sheet revision is not silently advanced');
  assert.equal(detail.open, true); assert.match(errorOf(detail).textContent, /配置已更新/); assert.equal(input.value, 'http://typed.test:9996');
});
const unauthorized = () => Object.assign(new Error('登录已过期'), { status: 401 });
test('first-load 401 draft: re-login config r7 survives resume, so a save while the next GET is still slow uses r7', async () => {
  let phase = 'expired', releaseSlowGet;
  const h = harness(async (url, options) => {
    if (phase === 'expired') throw unauthorized();
    if (options?.method === 'PUT') { assert.equal(JSON.parse(options.body).revision, 'r7'); return config('r8', JSON.parse(options.body).playbackUrl); }
    if (phase === 'relogin') return config('r7', 'http://saved.test:9996');
    return new Promise(resolve => { releaseSlowGet = () => resolve(config('r7', 'http://saved.test:9996')); }); // 导航触发的 GET 很慢
  });
  vm.runInContext('consoleConfig = null', h.context);
  h.context.openMediaMtxEditor(); const first = h.dialogs()[0], typed = urlInput(first); typed.value = 'http://typed.test:9996'; await typed.emit('input');
  assert.equal(first.querySelectorAll('input').length > 0, true);
  await assert.rejects(h.context.loadConsoleConfig(), error => error.status === 401); // 首次读取 401 -> loggedOut -> 草稿被挂起
  assert.equal(first.open, false); assert.equal(h.logouts.length, 1);
  phase = 'relogin'; await h.context.loadConsoleConfig(); h.resume(); // start(): 先读到 r7，再恢复草稿
  const resumed = h.dialogs()[0]; assert.notEqual(resumed, first); assert.equal(urlInput(resumed).value, 'http://typed.test:9996');
  const sheet = vm.runInContext('configEditor.sheet', h.context); assert.equal(sheet.context.revision, 'r7', 'old undefined revision must not overwrite r7');
  phase = 'slow'; const navigation = h.context.loadConsoleConfig(); // 尚未返回
  await find(resumed, node => node.textContent === '保存地址').click();
  const put = h.requests.find(item => item.options?.method === 'PUT'); assert.ok(put); assert.deepEqual(JSON.parse(put.options.body), { playbackUrl: 'http://typed.test:9996', revision: 'r7' });
  assert.equal(resumed.open, false); assert.equal(h.requests.some(item => item.options?.method === 'PUT' && item.url !== '/console/api/mediamtx'), false);
  releaseSlowGet(); await navigation;
});
test('draft resume keeps an already valid old revision and never upgrades it, so a changed config still conflicts', async () => {
  let phase = 'expired';
  const h = harness(async (url, options) => {
    if (phase === 'expired') throw unauthorized();
    if (options?.method === 'PUT') { if (JSON.parse(options.body).revision !== 'r9') throw Object.assign(new Error('配置已更新'), { status: 409 }); return config('r10'); }
    return config('r9', 'http://other.test:9996');
  });
  h.context.acceptConsoleConfig(config('r5')); h.context.openMediaMtxEditor(); const first = h.dialogs()[0], typed = urlInput(first); typed.value = 'http://typed.test:9996'; await typed.emit('input');
  await find(first, node => node.textContent === '保存地址').click(); assert.equal(h.logouts.length, 1); assert.equal(first.open, false);
  phase = 'relogin'; await h.context.loadConsoleConfig(); h.resume();
  const resumed = h.dialogs()[0]; assert.equal(urlInput(resumed).value, 'http://typed.test:9996');
  assert.equal(vm.runInContext('configEditor.sheet', h.context).context.revision, 'r5', 'valid old revision is preserved, not auto-upgraded');
  await find(resumed, node => node.textContent === '保存地址').click();
  assert.equal(JSON.parse(h.requests.at(-1).options.body).revision, 'r5'); assert.equal(resumed.open, true); assert.match(errorOf(resumed).textContent, /配置已更新/); assert.equal(urlInput(resumed).value, 'http://typed.test:9996');
});


test('桌面复用设置渲染与保存上下文，切换前保护未保存字段及pending',async()=>{
 const h=harness(async()=>config(),{desktop:true});h.context.acceptConsoleConfig(config());
 const sheet=h.context.openMediaMtxEditor();assert.equal(h.dialogs().length,0);assert.equal(sheet.dialog.parentNode,h.$('settings-desktop-detail'));
 const input=sheet.dialog.querySelectorAll('input')[0];input.value='http://changed.test:9996';await input.emit('input');
 assert.equal(h.context.openDvrSettings(),null);assert.equal(input.value,'http://changed.test:9996');
 sheet.setPending(true);assert.equal(h.context.openDvrSettings(),null);sheet.setPending(false);
 const next=h.context.openDvrSettings();assert.ok(next);assert.equal(sheet.dialog.open,false);assert.equal(next.dialog.parentNode,h.$('settings-desktop-detail'));
});
test('桌面详情缩窄时移动原输入进原生弹层，关闭清理原容器',async()=>{
 const h=harness(async()=>config(),{desktop:true});h.context.acceptConsoleConfig(config());
 const sheet=h.context.openMediaMtxEditor(),input=sheet.dialog.querySelectorAll('input')[0];input.value='http://draft.test:9996';await input.emit('input');
 h.context.window.innerWidth=390;sheet.adapt();assert.equal(h.dialogs().length,1);assert.ok(h.dialogs()[0].querySelectorAll('input').includes(input));assert.equal(input.value,'http://draft.test:9996');
 const modal=h.dialogs()[0],close=modal.querySelectorAll('button').find(node=>node.className.includes('dialog-close'));
 await close.click();assert.equal(modal.open,true,'缩窄前已有草稿仍需明确放弃');await close.click();assert.equal(sheet.dialog.open,false);assert.equal(h.context.settingsInline,null);
});


test('pending详情缩窄后失败解锁，不能被外层模态覆盖回disabled',async()=>{
 const h=harness(async()=>config(),{desktop:true});h.context.acceptConsoleConfig(config());
 const sheet=h.context.openMediaMtxEditor(),input=sheet.dialog.querySelectorAll('input')[0];
 sheet.setPending(true);assert.equal(input.disabled,true);h.context.window.innerWidth=390;sheet.adapt();
 sheet.setPending(false);assert.equal(input.disabled,false);
 assert.ok(sheet.dialog.querySelectorAll('button').some(node=>!node.disabled));
});
test('缩窄不关闭正在编辑的原生子弹层，子弹层关闭后再移入父详情',async()=>{
 const h=harness(async()=>config(),{desktop:true});h.context.acceptConsoleConfig(config());
 const sheet=h.context.openMediaMtxEditor(),child=h.context.openDialog('子编辑器');
 h.context.window.innerWidth=390;sheet.adapt();assert.equal(child.dialog.open,true);assert.equal(h.dialogs().length,1);
 await child.close();assert.equal(h.dialogs().length,1);assert.notEqual(h.dialogs()[0],child.dialog);assert.equal(sheet.dialog.parentNode.parentNode,h.dialogs()[0]);
});


test('恢复的配置草稿在桌面立即离开时也必须先确认放弃',()=>{
 const h=harness(async()=>config(),{desktop:true});h.context.acceptConsoleConfig(config());
 const sheet=h.context.openMediaMtxEditor('http://restored.test:9996');
 assert.equal(sheet.requestClose('view:tasks'),false);assert.equal(sheet.dialog.open,true);
 assert.equal(sheet.requestClose('view:tasks'),true);assert.equal(sheet.dialog.open,false);
});

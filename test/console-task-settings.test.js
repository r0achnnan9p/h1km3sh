import { createTaskFeed } from '../public/task-presentation.js';
import { iconSvg } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
class Node {
  constructor(tag = '') { this.dataset = {}; this.scrollTop = 0; this.hidden = false; this.tag = tag; this.children = []; this.attributes = {}; this.classList = { toggle() {} }; }
  get firstChild() { return this.children[0]; }
  get outerHTML() { return this.tag + JSON.stringify(this.task || {}) + this.children.map(n => n.outerHTML).join(''); }
  contains() { return false; }
  querySelectorAll() { return []; }
  append(...nodes) { for(const node of nodes) { if(node.parent)node.remove(); this.children.push(node); node.parent=this; } }
  insertBefore(node,next) { if(node.parent)node.remove(); const i=next?this.children.indexOf(next):-1; if(i<0)this.children.push(node);else this.children.splice(i,0,node);node.parent=this; }
  remove() { if(this.parent) { const a=this.parent.children; a.splice(a.indexOf(this),1);this.parent=null; } }
  removeChild(node) { node.remove(); }
  addEventListener() {}
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function harness(state = { tasks: [], uploads: [] }) {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = vm.createContext({ state, pendingTaskFocus: null, $, document: { createElement: tag => new Node(tag), querySelectorAll: () => [] }, makeTaskCard(task, uploadTask) { const card = new Node('article'); card.task = task; card.uploadTask = uploadTask; return card; } });
  // These feed snapshots do not follow a local submission.
  vm.runInContext(script.slice(script.indexOf('function revealSubmittedTask('), script.indexOf('function openTaskPage(')), context);
  vm.runInContext(script.slice(script.indexOf('const statusLabels ='), script.indexOf('function makeTaskCard(')), context);
  const document = {createElement: tag => new Node(tag)};
  context.taskFeeds = { exports: createTaskFeed({list:$('task-list'),scroller:new Node(),sentinel:new Node(),makeCard:t=>context.makeTaskCard(t,false),createdAt:context.taskCreatedAt,document}), uploads:createTaskFeed({list:$('upload-list'),scroller:new Node(),sentinel:new Node(),makeCard:t=>context.makeTaskCard(t,true),createdAt:context.taskCreatedAt,document}) };
  return { context, $, state };
}
test('active and verification tasks precede stable dated history without mutating API arrays', () => {
  const stamp = Date.parse('2026-10-01T10:00:00Z');
  const tasks = [{ id: 'active', status: 'downloading', queuedAt: stamp - 1000 }, { id: 'completed', status: 'completed', queuedAt: stamp + 1000 }, { id: 'failed', status: 'error', queuedAt: stamp }, { id: 'cancelled', status: 'cancelled', queuedAt: stamp + 2000 }];
  const uploads = [{ id: 'uploading', status: 'uploading', createdAt: new Date(stamp).toISOString() }, { id: 'done', status: 'completed', createdAt: new Date(stamp + 1000).toISOString() }, { id: 'unknown', status: 'unknown', createdAt: new Date(stamp - 1000).toISOString() }];
  const h = harness({ tasks, uploads }); h.context.renderTasks();
  assert.deepEqual(h.$('task-list').children.filter(card=>card.task).map(card => card.task.id), ['active', 'cancelled', 'completed', 'failed']);
  assert.deepEqual(h.$('upload-list').children.filter(card=>card.task).map(card => card.task.id), ['unknown', 'uploading', 'done']);
  assert.ok([...h.$('task-list').children, ...h.$('upload-list').children].every(card => ['article','h3'].includes(card.tag)));
  assert.deepEqual(tasks.map(task => task.id), ['active', 'completed', 'failed', 'cancelled']);
  const before = h.$('task-list').children.filter(card=>card.task).map(card => card.task.id); tasks[0].status = 'completed'; tasks[0].completedAt = stamp + 90000; h.context.renderTasks();
  assert.deepEqual(h.$('task-list').children.filter(card=>card.task).map(card => card.task.id), ['cancelled','completed','failed','active']);
  const time = h.$('task-list').children.filter(card=>card.task)[1].children[0]; assert.equal(time.tag, 'time'); assert.equal(time.dateTime, '2026-10-01T10:00:01.000Z'); assert.match(time.textContent, /18:00/); assert.match(time.attributes['aria-label'], /创建于.*北京时间/);
  assert.doesNotMatch(script, /id="task-history"|historyExpanded|appendTaskGroups/);
});
test('creation time supports ISO, epoch seconds, milliseconds, legacy fields, invalid values and stable ties', () => {
  const h = harness(), expected = Date.parse('2026-10-01T10:00:00Z');
  for (const task of [{ createdAt: '2026-10-01T10:00:00Z' }, { createdAt: expected / 1000 }, { createdAt: String(expected) }, { queuedAt: expected, startedAt: expected + 1 }, { startTime: expected }, { createdAt: 'invalid', startedAt: expected }]) assert.equal(h.context.taskCreatedAt(task), expected);
  for (const task of [{}, { createdAt: 'invalid' }, { createdAt: Infinity }, { createdAt: -1 }, { createdAt: 1e20 }]) assert.equal(h.context.taskCreatedAt(task), 0);
  h.state.tasks = [{ id: 'older-unknown', status: 'completed' }, { id: 'dated', status: 'error', createdAt: expected }, { id: 'later-unknown', status: 'downloading' }]; h.context.renderTasks();
  assert.deepEqual(h.$('task-list').children.filter(card=>card.task).map(card => card.task.id), ['later-unknown', 'dated', 'older-unknown']);
  h.state.tasks = []; h.state.uploads = []; h.context.renderTasks(); assert.equal(h.$('task-list').children[0].textContent, '还没有任务'); assert.equal(h.$('upload-list').children[0].textContent, '还没有任务');
});
test('upload accounts form one group before cache; their detail panels keep every account and cover control', () => {
  const html = statusDashboardPage();
  const start = html.indexOf('<section class="settings-group" aria-label="上传账户"');
  const group = html.slice(start, html.indexOf('</section>', start));
  assert.ok(html.indexOf('id="settings-cache"') > start + group.length);
  assert.ok(group.indexOf('data-settings-open="cloud189"') < group.indexOf('data-settings-open="bilibili"'));
  assert.equal((group.match(/<button /g) || []).length, 2);
  assert.doesNotMatch(group, /DVR 下载缓存|扫码登录状态只保留|每次上传前由你确认|无需填写编号/);
  const store = html.slice(html.indexOf('id="settings-detail-store"'), html.indexOf('</section>', html.indexOf('id="settings-bilibili"')));
  for (const id of ['settings-cloud189', 'settings-bilibili', 'upload-account-cloud189', 'upload-account-bilibili', 'bili-fixed-settings', 'cover-save', 'bili-cover-file', 'cover-message', 'cloud-status', 'bili-status']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id); assert.ok(store.includes(`id="${id}"`), id);
  }
  assert.match(store, /id="settings-cloud189" tabindex="-1" aria-label="189"/);
  assert.match(store, /id="settings-bilibili" tabindex="-1" aria-label="B站"/);
  assert.match(store, /上传目录：\/H1kM3sh/); assert.match(store, /仅自己可见/);
  assert.match(css, /\.account-connection \{[^}]*padding: 0; border: 0; background: transparent/);
  assert.match(css, /\.primary-button, \.secondary-button, \.quiet-button[^}]*min-height: 44px/);
});
test('settings describe service readiness separately and retain actionable failures', () => {
  const h = harness(); h.context.window = {}; h.context.iconSvg = iconSvg;
  vm.runInContext(script.slice(script.indexOf('function setSettingsRow('), script.indexOf('function renderPasswordMode(')), h.context);
  vm.runInContext(script.slice(script.indexOf('function renderSettings('), script.indexOf('async function refreshSettingsAfterAccountChange(')), h.context);
  h.context.renderSettings({}, { cloud189Enabled: true, cloud189WorkerAvailable: true, cloud189BinaryAvailable: true, cloud189AuthState: 'verified', bilibiliEnabled: true, bilibiliWorkerAvailable: true, bilibiliBinaryAvailable: true, bilibiliCredentialsPresent: true, bilibiliCoverAvailable: true });
  assert.equal(h.$('cloud-pill').hidden, true); assert.equal(h.$('cloud-status').hidden, true); assert.equal(h.$('bili-pill').hidden, true); assert.equal(h.$('bili-status').hidden, true); assert.equal(h.$('bili-status').textContent, '');
  h.context.renderSettings({}, {}); assert.equal(h.$('cloud-pill').hidden, false); assert.equal(h.$('bili-pill').hidden, false); assert.match(h.$('cloud-status').textContent, /上传服务未运行/); assert.equal(h.$('cloud-status').hidden, false); assert.match(h.$('bili-status').textContent, /上传服务未运行/);
  h.context.renderSettings({}, { bilibiliWorkerAvailable: true, bilibiliBinaryAvailable: true, bilibiliCredentialsPresent: true }); assert.match(h.$('bili-status').textContent, /封面/);
  // Home rows carry a status icon plus a readable label: ready -> green check, otherwise amber warning.
  h.context.renderSettings({}, { cloud189Enabled: true, bilibiliEnabled: false });
  const cloud = h.$('settings-status-cloud189'), bili = h.$('settings-status-bilibili');
  assert.equal(cloud.className, 'settings-item-status ok'); assert.match(cloud.innerHTML, /<svg/); assert.equal(cloud.attributes['aria-label'], '189 已就绪');
  assert.equal(bili.className, 'settings-item-status warn'); assert.equal(bili.attributes['aria-label'], 'B站需要处理'); assert.equal(bili.hidden, false);
});

test('removed records leave the main timeline, remain recoverable, and completed tasks stay visible', () => {
 const h = harness({tasks:[], uploads:[{id:'removed',status:'unknown',archivedAt:'2026-10-01',createdAt:'2026-10-01T11:00:00Z'},{id:'done',status:'completed',createdAt:'2026-10-01T10:00:00Z'}]});
 h.context.renderTasks();const items=h.$('upload-list').children.filter(card=>card.tag!=='h3');
 assert.equal(items[0].task.id,'done');assert.equal(items[1].tag,'details');assert.equal(items[1].children[1].task.id,'removed');
 assert.equal(h.context.taskCreatedAt({createdAt:'2026-10-01T10:00:00Z',retryRequestedAt:'2026-10-01T11:00:00Z'}),Date.parse('2026-10-01T11:00:00Z'));
});

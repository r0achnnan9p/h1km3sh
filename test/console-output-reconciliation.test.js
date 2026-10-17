import { createOutputDownload } from '../public/output-download.js';
import { setButtonIcon, createSettingsRow, iconSvg } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCollectionFeed } from '../public/task-presentation.js';
import { createOutputPlayers } from '../public/output-player.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.value = ''; this.scrollTop = 0; this.inserts = 0; this.classList = { toggle() {}, add() {}, remove() {} }; }
  get parentNode() { return this.parent; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  insertBefore(node, reference) { this.inserts++; node.remove(); node.parent = this; if (!reference) this.children.push(node); else this.children.splice(this.children.indexOf(reference), 0, node); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'src') this.src = ''; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { return Promise.all([...this.listeners.get(type) || []].map(callback => callback({ type, target: this }))); }
  click() { return this.emit('click'); }
  querySelectorAll() { return []; }
  contains() { return false; }
  find(predicate) { return this.children.find(predicate) || this.children.map(child => child.find(predicate)).find(Boolean); }
}
class Video extends Element {
  constructor() { super('video'); this.paused = true; this.ended = false; this.duration = NaN; this.currentTime = 0; this.loads = 0; this.pauses = 0; this.src = ''; }
  load() { this.loads++; this.currentTime = 0; }
  play() { this.paused = false; this.emit('play'); this.emit('playing'); return Promise.resolve(); }
  pause() { this.pauses++; const wasPaused = this.paused; this.paused = true; if (!wasPaused) this.emit('pause'); }
}
function harness() {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = new Element(); document.body = { dataset: { view: 'library' } }; document.createElement = tag => tag === 'video' ? new Video() : new Element(tag);
  const state = { outputs: Array.from({ length: 4 }, (_, index) => ({ id: `file-${index}`, filename: `Match ${index}.mp4`, streamUrl: `/stream/${index}`, size: 1000 + index, modifiedAt: new Date(Date.now() - index * 60000).toISOString() })) };
  const outputPlayers = createOutputPlayers({ document }), outputCards = new Map();
  const context = vm.createContext({ exportSubmission: null, pendingTaskFocus: null, replayHoldButtons: [], interruptTimelineScrub() {}, createCollectionFeed, settingsInline: null, outputFeed: null, outputFilter: null, outputDetail: null, outputRequest: 0, stateRequest: 0, consoleSession: 0, createOutputDownload, appPath: value => value, notify() {}, iconSvg, setButtonIcon, createSettingsRow, document, $, state, outputPlayers, outputCards, window: { consoleIntegrations: {} }, uploadAccounts: { stop() {} }, configEditor: null, suspendedConfigEditor: null, activeDialog: null, clockTimer: null, clearTimeout, setAuthMode() {}, setConnection() {} });
  vm.runInContext(script.slice(script.indexOf('function prettyBytes('), script.indexOf('function navigateToUploadSettings(')), context);
  vm.runInContext(script.slice(script.indexOf('function loggedOut('), script.indexOf('async function start(')), context);
  vm.runInContext(script.slice(script.indexOf('function cancelExportSubmission('), script.indexOf('async function submitExportSelection(')), context);
  vm.runInContext(script.slice(script.indexOf('function cancelReplayHold('), script.indexOf('function tryBufferedReplaySeek(')), context);
  return { context, $, state, outputPlayers, outputCards };
}
test('repeated renders keep exactly one card per output and leave playing video attached', async () => {
  const h = harness(); h.context.renderOutputs(); const list = h.$('output-list'), cards = [...list.children], video = cards[0].find(node => node.tag === 'video');
  await cards[0].find(node => node.className === 'output-poster').click(); video.currentTime = 42; video.muted = false;
  const loads = video.loads, pauses = video.pauses, inserts = list.inserts;
  for (let repeat = 0; repeat < 8; repeat++) { h.state.outputs = h.state.outputs.map(file => ({ ...file })); h.context.renderOutputs(); }
  assert.equal(list.children.length, 4); assert.deepEqual(list.children, cards); assert.equal(h.$('library-summary').textContent, '4 个视频'); assert.equal(list.inserts, inserts);
  assert.equal(cards[0].find(node => node.tag === 'video'), video); assert.equal(video.paused, false); assert.equal(video.currentTime, 42); assert.equal(video.muted, false); assert.equal(video.loads, loads); assert.equal(video.pauses, pauses);
});
test('session reset removes disposed card shells and re-login builds four complete cards only', () => {
  const h = harness(); h.context.renderOutputs(); const oldCards = [...h.$('output-list').children];
  h.context.loggedOut(); assert.equal(h.$('output-list').children.length, 0); assert.equal(h.outputCards.size, 0); assert.ok(oldCards.every(card => !card.parent));
  h.context.renderOutputs(); h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 4); assert.ok(h.$('output-list').children.every(card => card.find(node => node.className === 'output-preview')));
});
test('reconciliation repairs orphaned duplicate articles from a prior session without accumulating empty states', () => {
  const h = harness(); h.context.renderOutputs(); const oldCards = [...h.$('output-list').children];
  // Reproduce the old logout bug: only player/map state was cleared, leaving article shells.
  h.outputPlayers.destroy(); h.outputCards.clear(); assert.equal(h.$('output-list').children.length, 4);
  h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 4); assert.ok(oldCards.every(card => !card.parent));
  const current = [...h.$('output-list').children]; const orphan = new Element('article'); orphan.className = 'output-card'; h.$('output-list').append(orphan);
  h.context.renderOutputs(); assert.deepEqual(h.$('output-list').children, current); assert.equal(orphan.parent, null);
  h.$('output-search').value = 'missing'; h.context.renderOutputs(); h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 1); assert.equal(h.$('output-list').children[0].className, 'empty-card');
  h.$('output-search').value = ''; h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 4);
});

test('upload and more are separate accessible SVG actions with separate menus and no extra step', async () => {
  const h = harness(), sheets = [];
  Object.assign(h.context, { appPath: value => '/prefix' + value, openDialog(title) { const sheet = { title, content: new Element(), closed: false, close() { this.closed = true; } }; sheets.push(sheet); return sheet; } });
  h.context.renderOutputs();
  const card = h.$('output-list').children[0];
  const upload = card.find(node => node.className.includes('output-icon-button output-upload'));
  const more = card.find(node => node.className.includes('output-icon-button output-more'));
  assert.ok(upload && more); assert.equal(upload.textContent, ''); assert.equal(more.textContent, '');
  assert.equal(upload.getAttribute('aria-label'), '上传成片'); assert.equal(upload.title, '上传成片');
  assert.equal(more.getAttribute('aria-label'), '更多操作'); assert.equal(more.title, '更多操作');
  assert.match(upload.innerHTML, /<svg.*aria-hidden="true"/); assert.match(more.innerHTML, /<circle/);
  await upload.click(); assert.equal(sheets[0].content.children.length, 2);
  assert.ok(sheets[0].content.children.every(node => /上传到/.test(node.textContent)));
  assert.match(sheets[0].content.children[0].textContent, /^上传到哔哩哔哩/);
  await more.click(); assert.deepEqual(sheets[1].content.children.map(node => node.textContent), ['删除成片']);
  const download = card.find(node => node.className.includes('output-download'));
  assert.equal(download.href, '/prefix/stream/0?download=1'); assert.equal(download.download, 'Match 0.mp4'); assert.equal(download.getAttribute('aria-label'), '下载成片');
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /\.ui-icon-button \{[^}]*min-height: 44px/);
});

test('desktop navigation is a narrow icon rail with accessible names and unchanged mobile navigation', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  const nav = html.slice(html.indexOf('<aside class="side-nav"'), html.indexOf('</aside>'));
  assert.ok(!nav.includes('工作空间')); assert.ok(!nav.includes('<strong>H1kM3sh'));
  for (const label of ['回放', '成片', '任务', '设置']) { assert.ok(nav.includes(`aria-label="${label}" title="${label}"`)); assert.ok(!nav.includes(`</span>${label}`)); }
  assert.match(nav, /id="output-count" hidden/);
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /--sidebar: 72px/); assert.doesNotMatch(css, /--sidebar: (218|184)px/);
  assert.match(html, /id="mobile-nav"/);
});


test('task headings stay compact and all phone orientations honor system safe areas once', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  const tasks = html.slice(html.indexOf('id="view-tasks"'), html.indexOf('id="view-settings"'));
  assert.match(tasks, /id="task-tab-export"[^>]*role="tab"/); assert.match(tasks, /id="task-tab-upload"[^>]*role="tab"/);
  assert.doesNotMatch(tasks, /最新任务在前|录像处理|平台上传/);
  assert.doesNotMatch(script, /暂无进行中 · 最近/);
  assert.match(html, /viewport-fit=cover/);
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 1023px\)/);
  assert.doesNotMatch(css, /workspace-header/);
  assert.match(css, /\.views \{ padding-top: calc\(10px \+ var\(--safe-top\) \+ var\(--status-bar-blur-gap\)\); \}/);
  assert.match(css, /--status-bar-blur-gap: 0px;/, "ordinary browser spacing remains unchanged");
  assert.match(css, /--safe-top: env\(safe-area-inset-top, 0px\)/, "the real safe inset is not inflated");
  assert.match(css, /max\(16px, var\(--safe-right\)\) 0 max\(16px, var\(--safe-left\)\)/);
});

test('time sort toggles newest/oldest directly, preserves search, and never opens a drawer', () => {
  const h = harness(); h.context.openDialog = () => assert.fail('sort must not open a dialog');
  h.context.renderOutputs(); const list = h.$('output-list'), ids = () => list.children.map(card => card.outputFile.id);
  assert.deepEqual(ids(), ['file-0', 'file-1', 'file-2', 'file-3']);
  h.context.updateOutputSort(); const down = h.$('output-sort').innerHTML;
  assert.equal(h.$('output-sort').getAttribute('aria-label'), '成片排序：最新在前，点击切换为最早在前');
  h.context.toggleOutputSort(); assert.deepEqual(ids(), ['file-3', 'file-2', 'file-1', 'file-0']);
  assert.equal(h.$('output-sort').getAttribute('aria-label'), '成片排序：最早在前，点击切换为最新在前');
  assert.notEqual(h.$('output-sort').innerHTML, down);
  h.$('output-search').value = 'Match 2'; h.context.renderOutputs(); h.context.toggleOutputSort();
  assert.deepEqual(ids(), ['file-2']); assert.equal(h.$('output-search').value, 'Match 2'); assert.equal(h.$('output-sort').innerHTML, down);
  assert.doesNotMatch(script, /enhanceSelect\(\$\('output-sort'\)/); assert.doesNotMatch(script, /sort === 'name'|sort === 'largest'/);
});


test('成片共享分页首屏20条、追加至125条，轮询不重置已加载数量', () => {
  const h = harness();
  h.state.outputs = Array.from({ length: 125 }, (_, i) => ({ id: `clip-${i}`, filename: `clip-${i}.mp4`, streamUrl: `/stream/${i}`, size: 100, modifiedAt: new Date(1800000000000 - i * 1000).toISOString() }));
  h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 20);
  for (let i = 0; i < 6; i++) h.context.outputFeed.loadMore();
  assert.equal(h.$('output-list').children.length, 125); assert.equal(h.$('output-sentinel').hidden, true);
  const first = h.$('output-list').children[0];
  h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 125); assert.equal(h.$('output-list').children[0], first);
  h.$('output-search').value = 'clip-12'; h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 6);
  h.$('output-search').value = ''; h.context.renderOutputs(); assert.equal(h.$('output-list').children.length, 20);
});


test('手机详情复用同一播放器，关闭后暂停归位，保留恢复和四个操作', async () => {
  const h = harness(), sheets = [];
  h.context.openDialog = title => {
    const dialog = new Element('dialog'), content = new Element(), actions = new Element();
    dialog.append(content, actions);
    const sheet = { title, dialog, content, actions, close: () => dialog.emit('close') }; sheets.push(sheet); return sheet;
  };
  h.state.outputs[0].renamePending = true;
  h.state.outputs[0].busyReason = 'verification';
  h.context.renderOutputs();
  const card = h.$('output-list').children[0], player = card.find(node => node.className === 'output-preview');
  const video = player.find(node => node.tag === 'video'); video.currentTime = 33;
  await card.find(node => node.className === 'output-name').click();
  assert.equal(sheets.length, 1); assert.equal(player.parent, sheets[0].content);
  const actionRow = sheets[0].content.find(node => node.className === 'output-detail-actions');
  assert.equal(actionRow.children.length, 4);
  assert.ok(sheets[0].content.find(node => node.textContent === '恢复改名'));
  assert.ok(sheets[0].content.find(node => node.textContent === '处理待核实的上传记录'));
  h.state.outputs[0] = { ...h.state.outputs[0], busy: true, busyReason: 'upload', uploads: { cloud189: { status: 'completed' }, bilibili: { status: 'uploading', progress: 21 } } };
  h.context.renderOutputs(); assert.equal(player.parent, sheets[0].content, '轮询不把播放节点移回列表');
  assert.equal(actionRow.children[1].disabled, true); assert.equal(actionRow.children[2].disabled, true); assert.equal(actionRow.children[3].disabled, true);
  assert.ok(sheets[0].content.find(node => node.title === 'B站：上传中'));
  await sheets[0].close(); assert.equal(player.parent, card); assert.equal(video.paused, true); assert.equal(video.currentTime, 33);
});

test('旧详情迟到close不会移走或暂停新详情播放器', async () => {
  const h = harness(), sheets = [];
  h.context.openDialog = title => {
    const dialog = new Element('dialog'), content = new Element(), actions = new Element(); dialog.append(content, actions);
    const sheet = { title, dialog, content, actions, close: () => {} }; sheets.push(sheet); return sheet;
  };
  h.context.renderOutputs(); h.context.openOutputDetails(h.state.outputs[0]);
  const player = sheets[0].content.children[0], video = player.find(node => node.tag === 'video');
  h.context.openOutputDetails(h.state.outputs[0]); await player.find(node => node.className === 'output-poster').click();
  const pauses = video.pauses;
  await sheets[0].dialog.emit('close');
  assert.equal(player.parent, sheets[1].content); assert.equal(video.pauses, pauses); assert.equal(video.paused, false);
});


test('成片上传状态使用明确服务标识，完成无多余勾号并保留失败与进行中反馈', () => {
  const h = harness(), compact = new Element(), details = new Element();
  const file = { uploads: { cloud189: { status: 'completed' }, bilibili: { status: 'completed' } } };
  h.context.renderOutputUploadStates(compact, file, true);
  h.context.renderOutputUploadStates(details, file);
  for (const [index, label, icon] of [[0, '189', iconSvg('cloud189', 'provider-wordmark')], [1, 'B站', iconSvg('tv')]]) {
    const row = compact.children[index];
    assert.equal(row.dataset.status, 'completed');
    assert.equal(row.innerHTML, icon, '已上传只显示绿色服务图标，不再追加勾号');
    assert.equal(row.getAttribute('aria-label'), `${label}：已上传`);
    assert.equal(row.title, `${label}：已上传`);
    assert.equal(details.children[index].children[0].textContent, `${label}：已上传`);
  }
  for (const status of ['none', 'queued', 'uploading', 'failed', 'unknown']) {
    file.uploads = { cloud189: { status, progress: 42 }, bilibili: { status: 'none' } };
    h.context.renderOutputUploadStates(compact, file, true);
    const row = compact.children[0];
    assert.equal(row.dataset.status, status);
    assert.equal(row.innerHTML, iconSvg('cloud189', 'provider-wordmark') + (['failed', 'unknown'].includes(status) ? iconSvg('warning') : ''));
    assert.doesNotMatch(row.title, /已上传/);
    if (status === 'uploading') {
      assert.equal(row.children[0].tag, 'progress');
      assert.equal(row.children[0].value, 42);
      assert.equal(row.children[0].getAttribute('aria-label'), '189上传进度');
    }
  }
});


test('session reset aborts pending submission, cancels held replay controls and discards the prior task reveal', () => {
  const h = harness(), controller = new AbortController(), reasons = [];
  const pending = { controller, silent: false };
  h.context.exportSubmission = pending; h.context.pendingTaskFocus = { kind: 'uploads', id: 'old-upload' };
  h.context.replayHoldButtons.push({ cancel: reason => reasons.push(reason) });
  h.context.loggedOut();
  assert.equal(controller.signal.aborted, true); assert.equal(pending.silent, true);
  assert.deepEqual(reasons, ['playback-changed']); assert.equal(h.context.pendingTaskFocus, null);
});

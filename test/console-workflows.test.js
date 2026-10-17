import { formatClipDuration } from '../public/ui-primitives.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Node {
  constructor(tag='') { this.tag=tag; this.children=[]; this.listeners={}; this.dataset={}; this.value=''; this.classList={add(){},remove(){},toggle(){}}; }
  append(...nodes) { for(const node of nodes){node.parentElement=this;this.children.push(node);} }
  replaceChildren(){this.children=[];}
  setAttribute(){} focus(){}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}
  get options(){return this.children;}
}
test('mark buttons sample actual video currentTime and reject an inverted endpoint',()=>{
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const state={date:'2026-09-30',playBounds:{start:100000,duration:600},followPlayback:true,cursorMs:101000,inMs:null,outMs:null};
  Object.assign($('replay-player'),{hidden:false,currentTime:15.4,readyState:4,currentSrc:'http://test/video',src:'http://test/video'});let changed=0;const notices=[];
  const c=vm.createContext({ formatClipDuration,$,state,clampTimelineCenter:ms=>Math.max(0,Math.min(86399999,ms)),timelineWindow:()=>({start:0,end:3600000,span:3600000}),timelineLimit:()=>86400000,renderTimeline(){},setTimelineWindow(){},dateStart:()=>0,boundaryLabel:String,updateCursor(){},updateSelection(){changed++;},notify:message=>notices.push(message)});
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('),script.indexOf("$('mark-in').addEventListener('click'")),c);
  c.markPlaybackBoundary('in');assert.equal(state.inMs,115000);assert.equal(changed,1);
  $('replay-player').currentTime=10;c.markPlaybackBoundary('out');assert.equal(state.outMs,null);assert.match(notices.at(-1),/晚于/);
  $('replay-player').currentTime=25;c.markPlaybackBoundary('out');assert.equal(state.outMs,125000);
  $('replay-player').currentTime=30;c.markPlaybackBoundary('in');assert.equal(state.inMs,115000);assert.equal(state.outMs,125000);assert.match(notices.at(-1),/原选段已保留/);
  $('replay-player').hidden=true;state.cursorMs=150000;c.markPlaybackBoundary('out');assert.equal(state.outMs,150000);
});
test('page headings provide context without redundant workspace or player headers', async () => {
  const {statusDashboardPage} = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  assert.doesNotMatch(html, /workspace-header|workspace-breadcrumb|workspace-status|current-view-title|video-heading|player-source-label|录像预览/);
  assert.match(html, /id="player-wrap"[\s\S]*id="go-live"[\s\S]*class="player-transport"/);
  assert.doesNotMatch(html, /video-tags|video-channel-label|video-date-label/);
  assert.doesNotMatch(html, /class="top-actions"|class="live-label"/);
  assert.equal((html.match(/id="logout"/g)||[]).length,1);
  assert.ok(html.indexOf('id="logout"') > html.indexOf('id="view-settings"'));
  assert.ok(!html.includes('id="connection"'));
  assert.ok(!html.includes('workspace-footer'));
  assert.doesNotMatch(html, /私人录像|受保护的私人空间|回放 · 剪辑 · 归档|录像时间以北京时间显示/);
  const reloads = [...html.matchAll(/<button[^>]*data-app-reload[^>]*>/g)];
  assert.equal(reloads.length, 4);
  for (const [button] of reloads) assert.match(button, /aria-label="重新加载应用" title="重新加载应用"/);
  assert.doesNotMatch(html, /id="refresh-(?:outputs|tasks|settings)"/);
  for(const id of ['boot-retry','login-form','settings-open-dvr','settings-open-mediamtx','clear-cache','connection-banner']) assert.ok(html.includes(`id="${id}"`));
});

test('rename recovery is pending-only, single-flight, preserves files on error and accepts fresh list on success', async()=>{
  let resolve, reject, requestCount=0, rendered=0, closed=0; const state={outputs:[{id:'old',filename:'old.mp4'}]};
  const sheet={content:new Node(),actions:new Node(),error:new Node(),setPending(value){this.pending=value;},close(){closed++;}};
  const requests=[];
  const c=vm.createContext({ formatClipDuration,state,document:{createElement:tag=>new Node(tag)},openDialog:()=>sheet,body:JSON.stringify,notify(){},renderOutputs(){rendered++;},api:(url,options)=>{requestCount++;requests.push({url,options});return new Promise((ok,bad)=>{resolve=ok;reject=bad;});}});
  vm.runInContext(script.slice(script.indexOf('function addButton('),script.indexOf('function renderOutputs(')),c);
  vm.runInContext(script.slice(script.indexOf('function recoverOutputRename('),script.indexOf('function renameOutput(')),c);
  c.recoverOutputRename({id:'running',busy:true});assert.equal(sheet.actions.children.length,0);
  c.recoverOutputRename({id:'old',filename:'old.mp4',renamePending:true,busy:true});const button=sheet.actions.children[0];
  const first=button.listeners.click[0]();button.listeners.click[0]();assert.equal(requestCount,1);assert.equal(sheet.pending,true);
  reject(new Error('任务正在使用'));await first;assert.equal(state.outputs[0].id,'old');assert.equal(rendered,0);assert.equal(closed,0);assert.match(sheet.error.textContent,/已保留/);
  const second=button.listeners.click[0]();resolve({success:true,outputs:[{id:'new',filename:'new.mp4',renamePending:false}]});await second;
  assert.equal(requests[1].url,'/console/api/outputs/old/recover-rename');assert.equal(requests[1].options.method,'POST');assert.equal(state.outputs[0].id,'new');assert.equal(rendered,1);assert.equal(closed,1);
});

test('API session expiry carries HTTP status so cached source data cannot mask logout', async () => {
  let loggedOut = 0;
  const c = vm.createContext({ formatClipDuration, appPath: path => path, fetch: async () => ({ status: 401 }), loggedOut() { loggedOut++; } });
  vm.runInContext(script.slice(script.indexOf('async function api('), script.indexOf('async function requestJson(')), c);
  await assert.rejects(c.api('/console/api/dvrs/a/channels'), error => error.status === 401);
  assert.equal(loggedOut, 1);
});
test('clear marks removes both endpoints and export overlay without changing playback or cursor', () => {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const state = { inMs: 100000, outMs: 200000, cursorMs: 150000, playBounds: { start: 90000, duration: 30 }, date: '2026-10-01', segments: [], playbackSource: 'mediamtx', busy: false, dragging: false, pendingScrub: null };
  let cancels = 0;
  const c = vm.createContext({ formatClipDuration, $, state, dateStart: () => 0, boundaryLabel: String, updateBoundaryControls() {}, findCoverageGap: () => null, hasPlaybackSelection: () => true, timelineWindow: () => ({ start: 0, end: 86400000, span: 86400000 }), timelinePercent: () => 1, notify() {}, cancelTimelineScrub() { cancels++; } });
  for (const id of ['range-overlay', 'overview-selection']) $(id).style = {};
  vm.runInContext(script.slice(script.indexOf('function clearMarkedRange('), script.indexOf("$('date-select').addEventListener('change'")), c);
  vm.runInContext(script.slice(script.indexOf('function updateSelection('), script.indexOf('function clearReplay(')), c);
  vm.runInContext(script.slice(script.indexOf("$('clear-marks').addEventListener('click'"), script.indexOf("$('skip-back').addEventListener('click'")), c);
  c.updateSelection(); assert.equal($('export-range').disabled, false);
  $('clear-marks').dispatchEvent(new Event('click'));
  assert.equal(state.inMs, null); assert.equal(state.outMs, null); assert.equal(state.cursorMs, 150000); assert.equal(state.playBounds.start, 90000);
  assert.equal($('range-overlay').hidden, true); assert.equal($('overview-selection').hidden, true); assert.equal($('export-range').disabled, true); assert.equal($('clear-marks').disabled, true); assert.equal(cancels, 0);
  state.inMs = 100000; state.dragging = true; state.dragPointerId = 7; state.pendingScrub = {}; $('clear-marks').dispatchEvent(new Event('click')); assert.equal(cancels, 1); assert.equal(state.inMs, null); assert.equal(state.pendingScrub, null);
});

test('account reauthentication is explicit and retains unsaved configuration and settings drafts', () => {
  const flow = script.slice(script.indexOf('function reauthenticateForUploads('), script.indexOf('function playbackChoiceLabel('));
  assert.match(flow, /退出并重新登录/); assert.match(flow, /未保存的平台设置已保留/);
  assert.doesNotMatch(flow, /dirtySettingFields\.(clear|delete)|suspendedConfigEditor\s*=|configEditor\s*=|location\.reload/);
  assert.match(flow, /addButton\(sheet.actions, '退出并重新登录'[\s\S]*await requestJson\('\/status\/logout'/);
});

test('cover previews respect the gateway image CSP and account errors preserve either API code spelling', () => {
  assert.match(script, /reader\.readAsDataURL\(file\)/);
  assert.doesNotMatch(script, /URL\.createObjectURL\(file\)/);
  assert.match(script, /error\.code = data\?\.code \|\| data\?\.errorCode/);
});

test('narrow screens hide redundant page titles while retaining headings, essential selectors and alerts', async () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const compact = css.slice(css.indexOf('/* Narrow screens use the bottom tabs'));
  assert.match(compact, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(css, /workspace-header/);
  assert.match(compact, /\.page-heading \{ display: block; min-height: 0; margin: 0; padding: 0/);
  assert.match(compact, /\.page-heading > \.replay-title \{[^}]*position: absolute; width: 1px; height: 1px/);
  assert.match(compact, /clip: rect\(0, 0, 0, 0\)/);
  assert.doesNotMatch(compact, /\.page-heading > div \{[^}]*display: none/);
  assert.match(compact, /\.replay-heading \.playback-context \{ min-height: 44px; width: 100%/);
  assert.doesNotMatch(compact, /grid-template-columns: auto minmax/);
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  for (const heading of ['回放', '成片', '任务', '设置']) assert.ok(html.includes(`<h1>${heading}</h1>`));
  assert.match(html, /id="connection-banner" role="status"/);
  assert.match(html, /id="playback-context"/);
});

test('upload setup shortcuts open the selected platform detail directly without changing settings drafts', async () => {
  const calls = [], draft = { value: 'unsaved title' };
  const c = vm.createContext({ formatClipDuration, navigate: view => calls.push(['navigate', view]), settingsDetails: { bilibili: () => calls.push(['detail', 'bilibili']), cloud189: () => calls.push(['detail', 'cloud189']) }, dirtySettingFields: new Set(['bili-prefix']), draft });
  vm.runInContext(script.slice(script.indexOf('function navigateToUploadSettings('), script.indexOf('const pendingUploads =')), c);
  c.navigateToUploadSettings('bilibili');
  assert.deepEqual(calls, [['navigate', 'settings'], ['detail', 'bilibili']]);
  calls.length = 0; c.navigateToUploadSettings('cloud189'); assert.deepEqual(calls, [['navigate', 'settings'], ['detail', 'cloud189']]); assert.equal(draft.value, 'unsaved title');
  assert.match(script, /else navigateToUploadSettings\(provider\)/);
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  for (const provider of ['bilibili', 'cloud189']) assert.match(html, new RegExp(`id="settings-${provider}" tabindex="-1" aria-label=`));
});

test('account changes refresh readiness without rewriting settings or upload authorization', async () => {
  let refreshed = 0;
  const c = vm.createContext({ formatClipDuration, loadSettings: async () => { refreshed++; } });
  vm.runInContext(script.slice(script.indexOf('async function refreshSettingsAfterAccountChange('), script.indexOf('async function loadSettings()')), c);
  await c.refreshSettingsAfterAccountChange('bilibili', { accountChanged: true });
  assert.equal(refreshed, 1);
});

test('settings show fixed football policy without numeric fields or global upload gate', async () => {
  const {statusDashboardPage} = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  for (const id of ['bili-season', 'bili-section', 'bili-prefix', 'bili-tags', 'managed-enabled', 'upload-policy-form', 'cloud-target', 'bili-enabled', 'cloud-enabled', 'cloud-form', 'bili-form']) assert.ok(!html.includes(`id="${id}"`));
  assert.match(html, /体育运动 · 足球 · 仅自己可见/);
  assert.doesNotMatch(html, /合集：足球 · 标签：足球 · 标题沿用文件名/);
  for (const id of ['cover-dropzone', 'bili-cover-file', 'cover-save']) assert.ok(html.includes(`id="${id}"`));
});

test('password card only appears for editable password mode', () => {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const c = vm.createContext({ formatClipDuration, $ });
  vm.runInContext(script.slice(script.indexOf('function renderPasswordMode('), script.indexOf("let settingsCsrfToken")), c);
  c.renderPasswordMode(true); assert.equal($('password-card').hidden, true);
  c.renderPasswordMode(false); assert.equal($('password-card').hidden, false); assert.equal($('password-form').hidden, false);
});

test('settings groups use one bounded column at desktop and mobile sizes', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /#view-settings\s*\{\s*max-width: 880px/);
  assert.match(css, /\.settings-groups\s*\{[^}]*display: grid; gap: 16px/);
  assert.doesNotMatch(css, /\.settings-groups\s*\{[^}]*repeat\(2/);
  assert.doesNotMatch(css, /\.workspace-footer/);
  assert.match(css, /padding-bottom: calc\(76px \+ var\(--safe-bottom\)\)/);
});

test('logout row sits in the account group and confirmation precedes every session mutation', async () => {
  let confirm, stops = 0, requests = 0, logouts = 0;
  const c = vm.createContext({ formatClipDuration, confirmAction: (title, description, label, action) => { confirm = action; },
    uploadAccounts: { async stop() { stops++; } }, api: async (url, options) => { assert.equal(url, '/status/logout'); assert.equal(options.method, 'POST'); requests++; },
    configEditor: {}, suspendedConfigEditor: {}, loggedOut() { logouts++; } });
  vm.runInContext(script.slice(script.indexOf('function requestLogout('), script.indexOf('function navigate(')), c);
  c.requestLogout(); assert.equal(requests, 0); assert.equal(stops, 0); assert.equal(logouts, 0);
  await confirm(); assert.equal(requests, 1); assert.equal(stops, 1); assert.equal(logouts, 1);
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  const account = html.slice(html.indexOf('<section class="settings-group" aria-label="账户"'), html.indexOf('id="settings-detail-store"'));
  assert.match(account, /id="logout"[^>]*aria-label="退出登录" title="退出登录"[^>]*hidden/); assert.match(account, /id="logout"[^>]*><span[^>]*><svg/);
  assert.equal((html.match(/id="logout"/g) || []).length, 1);
  assert.match(script, /\$\('logout'\)\.addEventListener\('click', requestLogout\)/);
});

test('installed iOS shell reserves an opaque status bar instead of obscuring content under a translucent bar', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js');
  const html = statusDashboardPage();
  assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black"/);
  assert.doesNotMatch(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
});

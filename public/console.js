import { createPrecisionTimeline } from './precision-timeline.js';
import { createOutputDownload } from './output-download.js';
import { iconSvg, setButtonIcon, createSettingsRow, formatClipDuration, createPlaybackChrome, createSlidingNavigation } from './ui-primitives.js';
import { createUploadAccounts } from './upload-accounts.js';
import { createOutputPlayers } from './output-player.js';
import { activeDialog, openDialog, labelledInput, normalizeMp4Name, rangeTimeMs, openCalendar, enhanceTimeInput } from './touch-controls.js';
import { setupDebugMark } from './debug-mark.js';
import { startMediaMtxLive } from './mediamtx-live-player.js';
import { findCoverageGap, countCoverageGaps, listCoverageGaps } from './playback-coverage.js';
import { bindPressRepeat } from './press-repeat.js';
import { taskProgressPresentation, taskStageLabel, taskProgressCaption, uploadProgressCaption, createTaskFeed, createCollectionFeed, createTransferSampler, fmtBps, formatTransferBytes, formatEta } from './task-presentation.js';

// iOS may ignore viewport scale limits; cancel only browser page-zoom gestures.
for (const event of ['gesturestart', 'gesturechange']) {
  document.addEventListener(event, e => e.preventDefault(), { passive: false });
}

const $ = id => document.getElementById(id);
// An installed iOS PWA can report dvh/innerHeight short by the status bar.
// Select the CSS large-viewport baseline, not a JS height or accumulated inset.
// Dialogs keep their separate visual-viewport fitting when a keyboard opens.
function syncStandaloneViewport() {
  const viewport = window.visualViewport;
  const enabled = navigator.standalone === true && window.innerWidth < 1024
    && !document.fullscreenElement && (viewport?.scale ?? 1) === 1;
  const root = document.documentElement;
  root.classList.toggle('standalone-viewport', enabled);
  // iOS home-screen WebViews may omit Version and freeze the OS token.
  // Unknown versions get bounded clearance; known pre-27 Safari stays unchanged.
  const version = /Version\/(\d+)/.exec(navigator.userAgent ?? '');
  root.classList.toggle('standalone-status-fade', enabled && (!version || Number(version[1]) >= 27));
}
let standaloneViewportFrame = null;
function scheduleStandaloneViewport() {
  if (standaloneViewportFrame !== null) return;
  standaloneViewportFrame = requestAnimationFrame(() => {
    standaloneViewportFrame = null;
    syncStandaloneViewport();
  });
}
syncStandaloneViewport();
for (const event of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(event, scheduleStandaloneViewport);
for (const event of ['resize', 'scroll']) window.visualViewport?.addEventListener(event, scheduleStandaloneViewport);
document.addEventListener('fullscreenchange', scheduleStandaloneViewport);

// Detail-window zoom steps (seconds); the span lives in state.timelineSpanSeconds.
const TIMELINE_SPANS = [30, 300, 3600, 86400];
const DEFAULT_TIMELINE_SPAN_SECONDS = 300;
const APP_BASE_PATH = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const appPath = value => `${APP_BASE_PATH}${value.startsWith('/') ? value : `/${value}`}`;
const state = { cameras: [], dvrs: [], segments: [], outputs: [], tasks: [], uploads: [], outputSort: 'newest', selectedCamera: '', selectedChannel: '', dvrChannels: {}, playbackSource: 'mediamtx', previewMode: 'replay', date: '', cursorMs: null, inMs: null, outMs: null, timelineSpanSeconds: DEFAULT_TIMELINE_SPAN_SECONDS, timelineStartMs: null, dragging: false, dragSource: '', dragPointerId: null, playRequestId: 0, segmentRequestId: 0, dvrChannelRequestId: 0, playbackAutoplay: false, playbackFormats: [], playFormat: '', playBounds: null, followPlayback: false, scrubFadeTimer: null, busy: false, source: null, lastTasks: '' };
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
let toastTimer, clockTimer;
const outputPlayers = createOutputPlayers({ resolveUrl: appPath, onNotice: notify, onPlay: () => $('replay-player').pause(), onOpen: (file, element) => {
  if (window.matchMedia('(max-width: 1023px)').matches && element.closest('.output-card')) { openOutputDetails(file); return true; }
  return false;
} });
const outputCards = new Map();
let outputFeed = null, outputFilter = null, outputDetail = null;
let outputRequest = 0, stateRequest = 0, consoleSession = 0;
let settingsInline = null;
let precisionTimeline = null;
let pendingTaskFocus = null, exportSubmission = null;
const replayHoldButtons = [];
const cloudVerificationPending = new Set();
const dvrHttpSamplePending = new Map();
const uploadAccounts = createUploadAccounts({ request: requestJson, resolveUrl: appPath, openDialog, onConnected: refreshSettingsAfterAccountChange, onNotice: notify, onReauthenticate: reauthenticateForUploads });

function today() { return shanghai.format(new Date()); }
function wallTime(ms, seconds = true) {
  const parts = Object.fromEntries(dateParts.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ''}`;
}
function dateStart(date) { return new Date(`${date}T00:00:00+08:00`).getTime(); }
function daySeconds(ms) { return Math.max(0, Math.min(86400, (ms - dateStart(state.date)) / 1000)); }
function notify(message, isError = false, submission = null) {
  const node = $('toast'); node.hidden = false; node.textContent = message; node.classList.toggle('error', isError); node.classList.add('show');
  node.classList.toggle('submission-toast', Boolean(submission));
  if (submission) {
    node.replaceChildren();
    const icon = document.createElement('span'); icon.className = 'toast-submission-icon'; icon.innerHTML = iconSvg(submission.icon || 'download') + iconSvg('check');
    const text = document.createElement('span'); text.className = 'toast-submission-copy';
    const caption = document.createElement('span'); caption.textContent = message;
    const range = document.createElement('span'); range.className = 'mono'; range.textContent = submission.range;
    text.append(caption, range);
    const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'toast-task-link'; setButtonIcon(arrow, 'chevron', '查看任务'); arrow.addEventListener('click', () => { clearTimeout(toastTimer); node.classList.remove('show'); node.hidden = true; openTaskPage(submission.kind); });
    const countdown = document.createElement('span'); countdown.className = 'toast-countdown'; countdown.setAttribute('aria-hidden', 'true');
    node.append(icon, text, arrow, countdown);
  }
  // 隐藏后的操作不留在焦点与辅助技术树中；键盘操作期间不撤掉提示。
  const dismiss = () => {
    if (node.contains?.(document.activeElement)) { toastTimer = setTimeout(dismiss, 1000); return; }
    node.classList.remove('show'); node.hidden = true;
  };
  clearTimeout(toastTimer); toastTimer = setTimeout(dismiss, submission ? 3000 : 3200);
}
async function api(url, options = {}) {
  const response = await fetch(appPath(url), { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  if (response.status === 401) { loggedOut('登录已过期，请重新登录。'); throw Object.assign(new Error('登录已过期，请重新登录。'), { status: 401 }); }
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) { const error = new Error(data?.error || `请求失败（${response.status}）`); error.code = data?.code || data?.errorCode; error.coverage = data?.coverage; error.status = response.status; throw error; }
  return data;
}
async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(appPath(url), { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  } catch {
    const error = new Error('暂时无法连接服务器，请检查网络后重试。'); error.status = 0; throw error;
  }
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`); error.status = response.status; error.code = data?.code || data?.errorCode; error.forceSaveRequired = data?.forceSaveRequired; throw error;
  }
  return data;
}
const body = value => JSON.stringify(value);
function setConnection(text, offline = false) {
  $('connection-banner').hidden = !offline;
}
function showBoot(message = '检查已保存的登录状态…', error = '') {
  $('boot-view').hidden = false; $('auth-view').hidden = true; $('console-shell').hidden = true;
  $('mobile-nav').hidden = true; $('logout').hidden = true;
  $('boot-copy').textContent = message;
  $('boot-loading').hidden = Boolean(error);
  $('boot-error').textContent = error; $('boot-error').hidden = !error;
  $('boot-retry').hidden = !error;
  setConnection(error ? '连接中断' : '正在连接', Boolean(error));
}
function showBootError(message, detail = '') {
  showBoot(message, detail || '连接失败，请检查网络后重试。');
}
function setAuthMode(configured) {
  $('boot-view').hidden = true;
  $('auth-view').hidden = false; $('console-shell').hidden = true; $('mobile-nav').hidden = true; $('logout').hidden = true;
  $('login-form').hidden = !configured; $('setup-form').hidden = configured; $('setup-note').hidden = configured;
  $('auth-title').textContent = configured ? '进入录像控制台' : '初始化访问密码';
  $('auth-copy').textContent = configured ? '查看回放、管理成片与上传任务。' : '先用服务器生成的一次性初始化码设置短密码。';
}
function loggedOut(message = '') {
  cancelExportSubmission(true); cancelReplayHold(); pendingTaskFocus = null;
  interruptTimelineScrub();
  if (state.mediaLive || state.lastFramePending || state.previewMode === 'last-frame') clearReplay();
  if (typeof uploadAccounts !== 'undefined') void uploadAccounts.stop();
  delete document.body.dataset.view;
  outputRequest++; stateRequest++; consoleSession++; outputDetail?.close(); outputDetail = null; outputPlayers.destroy(); outputCards.clear(); outputFeed?.clear(); outputFilter = null; $('output-list').replaceChildren();
  if (configEditor) suspendedConfigEditor = configEditor.resume;
  settingsInline?.close();
  activeDialog?.close();
  state.source?.close(); state.source = null; clearTimeout(clockTimer);
  setAuthMode(true); $('auth-error').textContent = message; setConnection('需要登录');
}

async function start(bootstrap = null) {
  showBoot('正在载入录像控制台…');
  try {
    if (!bootstrap) {
      const auth = await requestJson('/console/api/auth');
      if (!auth.configured) { setAuthMode(false); setConnection('等待初始化'); return; }
      bootstrap = await requestJson('/console/api/bootstrap');
    }
    $('boot-view').hidden = true; $('auth-view').hidden = true; $('console-shell').hidden = false; $('mobile-nav').hidden = false; $('logout').hidden = false;
    setConnection('服务在线');
    state.configRevision = bootstrap.configRevision || null;
    fillDvrDevices(bootstrap.dvrs || []);
    fillCameras(bootstrap.cameras || []);
    state.activeTaskCount = bootstrap.activeTaskCount;
    state.exportActiveTaskCount = bootstrap.exportActiveTaskCount; state.uploadActiveTaskCount = bootstrap.uploadActiveTaskCount;
    state.outputs = bootstrap.outputs || []; state.tasks = bootstrap.tasks || []; state.uploads = bootstrap.uploads || [];
    renderPasswordMode(bootstrap.passwordManaged === true);
    renderOutputs(); renderTasks(); renderSettings(bootstrap.settings || {}, bootstrap.integrations || {});
    loadCache().catch(() => {});
    connectEvents();
    loadSegments().catch(error => setPlaybackNotice(error.message, true));
    navigate(location.hash.slice(1) || 'replay', false);
    clock();
    if (suspendedConfigEditor) {
      await loadConsoleConfig(); const resume = suspendedConfigEditor; suspendedConfigEditor = null;
      navigate('settings'); resume();
    }
  } catch (error) {
    if (error.status === 401) { loggedOut('登录已过期，请重新登录。'); return; }
    showBootError('控制台暂时无法打开。', error.message);
  }
}
function clock() { clearTimeout(clockTimer); $('wall-clock').textContent = wallTime(Date.now()); clockTimer = setTimeout(clock, 1000); }

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('login-form').querySelector('button[type="submit"]'); if (button.disabled) return; button.disabled = true; $('auth-error').textContent = '';
  try {
    const result = await requestJson('/status/login', { method: 'POST', body: body({ password: $('login-password').value }) });
    $('login-password').value = ''; if (!result.success) throw new Error('登录失败'); await start();
  } catch (error) { setAuthMode(true); $('auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('setup-form').querySelector('button[type="submit"]'); if (button.disabled) return; button.disabled = true; $('auth-error').textContent = '';
  try {
    await api('/console/api/setup', { method: 'POST', body: body({ code: $('setup-code').value, password: $('setup-password').value }) });
    $('setup-code').value = ''; $('setup-password').value = ''; setAuthMode(true); $('auth-error').textContent = '密码已设置，请登录。';
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', requestLogout);
function requestLogout() {
  confirmAction('退出登录？', '下次使用需重新登录。', '退出登录', async () => {
    await uploadAccounts.stop(); await api('/status/logout', { method: 'POST' });
    suspendedConfigEditor = null; configEditor = null; loggedOut();
  });
}

function navigate(view, updateHistory = true) {
  if (!['replay', 'library', 'tasks', 'settings'].includes(view)) view = 'replay';
  if (view !== 'settings' && settingsInline && !settingsInline.requestClose(`view:${view}`)) {
    if (!updateHistory) history.replaceState(null, '', '#settings'); return;
  }
  const generation = navigate.generation = (navigate.generation || 0) + 1;
  const applyNavigation = () => {
    if (generation !== navigate.generation) return;
    const changedView = document.body.dataset.view !== view;
    document.body.dataset.view = view;
    if (updateHistory && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
    if (view !== 'replay') clearReplay();
    if (view !== 'library') outputPlayers.pauseAll();
    activeDialog?.close();
    document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === view));
    if (view === 'tasks' && typeof taskFeeds !== 'undefined') {
      if (pendingTaskFocus) selectTaskTab(pendingTaskFocus.kind === 'uploads');
      else ($('task-upload-panel').hidden ? taskFeeds.exports : taskFeeds.uploads).resume();
      revealSubmittedTask();
    }
    document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
    if (changedView) { window.scrollTo(0, 0); const scrollRoot = document.querySelector('.workspace-main'); if (scrollRoot) scrollRoot.scrollTop = 0; }
    if (typeof slidingNavigation !== 'undefined') slidingNavigation?.sync();
    if (view === 'library') { outputFeed?.resume(); }
    if (view === 'library') refreshOutputs().catch(error => notify(error.message, true));
    if (view === 'tasks') refreshState().catch(() => {});
    if (view === 'settings') { if (typeof uploadAccounts !== 'undefined') uploadAccounts.refresh().catch(() => {}); loadSettings().catch(() => {}); loadCache().catch(() => {}); loadConsoleConfig().catch(() => {}); }
  };
  if (view !== 'replay' && typeof cancelReplayFullscreenEntry === 'function') {
    cancelReplayFullscreenEntry();
    if (document.fullscreenElement === $('view-replay')) {
      void leaveReplayFullscreen().then(left => {
        if (generation !== navigate.generation) return;
        if (left) applyNavigation();
        else notify('无法退出全屏，请先退出全屏再切换页面。', true);
      });
      return;
    }
  }
  applyNavigation();
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
const slidingNavigation = createSlidingNavigation({ nav: document.querySelector('.mobile-nav'), activate: view => navigate(view) });
const playbackChrome = createPlaybackChrome({ container: $('player-wrap'), video: $('replay-player'), interactionRoot: $('view-replay'), isBusy: () => state.dragging || Boolean(state.holdSeek) || state.busy || Boolean(activeDialog?.open) });
document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); $('workspace-content').focus(); });
window.addEventListener('popstate', () => { if (!$('console-shell').hidden && location.hash.slice(1) !== document.body.dataset.view) navigate(location.hash.slice(1), false); });

function fillCameras(cameras) {
  state.cameras = cameras; const select = $('camera-select'); select.replaceChildren();
  if (!cameras.length) {
    state.selectedCamera = '';
    const option = document.createElement('option'); option.value = ''; option.textContent = '暂未发现录像通道'; select.append(option); select.disabled = true;
    setPlaybackNotice('尚未发现 MediaMTX 通道，请检查录像目录或 MediaMTX API 连接。', true); return;
  }
  select.disabled = false;
  cameras.forEach(camera => { const option = document.createElement('option'); option.value = camera.id; option.textContent = `${camera.name}${camera.name !== camera.id ? ` · ${camera.id}` : ''}`; select.append(option); });
  state.selectedCamera = cameras.some(camera => camera.id === state.selectedCamera) ? state.selectedCamera : cameras[0].id; select.value = state.selectedCamera;
}
$('camera-select').addEventListener('change', async () => {
  state.selectedCamera = $('camera-select').value;
  startLive();
  loadSegments({ preserveRange: true, keepLive: true }).catch(error => setPlaybackNotice(error.message, true));
});
$('date-select').value = today(); state.date = today();
function clearMarkedRange() { state.inMs = state.outMs = null; $('mark-in').classList.remove('active'); $('mark-out').classList.remove('active'); }
$('date-select').addEventListener('change', () => { state.date = $('date-select').value; $('next-day').disabled = state.date >= today(); clearMarkedRange(); loadSegments().catch(error => setPlaybackNotice(error.message, true)); });
$('retry-recordings').addEventListener('click', () => loadSegments({ preserveRange: true }).catch(error => setPlaybackNotice(error.message, true)));
$('load-recordings').addEventListener('click', () => loadSegments({ preserveRange: true }).catch(error => setPlaybackNotice(error.message, true)));

function fillDvrDevices(dvrs) {
  state.dvrs = dvrs;
  const select = $('dvr-select'), previousDevice = $('dvr-select').value; select.replaceChildren();
  for (const dvr of dvrs) {
    const option = document.createElement('option'); option.value = dvr.id;
    option.textContent = dvr.name || '海康录像机'; select.append(option);
  }
  if (dvrs.some(dvr => dvr.id === previousDevice)) select.value = previousDevice;
  select.disabled = !dvrs.length;
  const dvrOption = [...$('playback-source').options].find(option => option.value === 'dvr');
  if (dvrOption) dvrOption.disabled = !dvrs.length;
  $('dvr-help').textContent = dvrs.length ? '可选任一已配置录像机，再选择它的录像通道。' : '服务器尚未配置海康录像机。';
}

function hasPlaybackSelection() {
  return state.playbackSource === 'dvr'
    ? Boolean($('dvr-select').value && $('dvr-channel').value && !$('dvr-channel').disabled)
    : Boolean(state.selectedCamera);
}

function invalidatePlaybackSelection() {
  state.segmentRequestId++;
  clearReplay(); state.segments = []; state.cursorMs = null;
  renderTimeline();
}

async function loadDvrChannels(preferredChannel = '') {
  const select = $('dvr-channel'), deviceId = $('dvr-select').value, requestId = ++state.dvrChannelRequestId;
  preferredChannel ||= state.dvrChannels[deviceId] || '';
  select.replaceChildren(); select.disabled = true; state.selectedChannel = ''; updateSelection();
  if (!deviceId) { $('dvr-help').textContent = '服务器尚未配置海康录像机。'; return; }
  const loading = document.createElement('option'); loading.value = ''; loading.textContent = '正在读取通道…'; select.append(loading);
  $('dvr-help').textContent = '正在通过海康 ISAPI 查询录像机通道…';
  try {
    const cache = state.dvrChannelCache ||= {};
    const entry = cache[deviceId] ||= {};
    if (!entry.promise && (!entry.data || Date.now() - entry.updatedAt > 30_000)) {
      entry.promise = api(`/console/api/dvrs/${encodeURIComponent(deviceId)}/channels`).then(data => {
        entry.data = data; entry.updatedAt = Date.now(); entry.error = ''; return data;
      }).catch(error => {
        if (!entry.data || error.status === 401) throw error;
        entry.error = '暂时无法刷新，保留上次读取的通道。'; return entry.data;
      }).finally(() => { entry.promise = null; });
    }
    const data = await (entry.promise || entry.data);
    if (requestId !== state.dvrChannelRequestId) return;
    select.replaceChildren();
    (state.dvrSdkDevices ||= {})[deviceId] = data.playbackTransport === 'hcnetsdk';
    const channels = data.channels || [];
    if (!channels.length) {
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '没有可用通道'; select.append(empty);
      $('dvr-help').textContent = '录像机没有返回可用通道。'; return;
    }
    for (const channel of channels) {
      const option = document.createElement('option'); option.value = String(channel.id);
      const name = String(channel.name || '').trim();
      option.textContent = name && !/^\d+$/.test(name) ? name : `镜头${Math.max(1, Math.floor(Number(channel.id) / 100))}`; select.append(option);
    }
    select.value = channels.some(channel => String(channel.id) === String(preferredChannel)) ? String(preferredChannel) : String(channels[0].id);
    state.selectedChannel = select.value; state.dvrChannels[deviceId] = select.value; select.disabled = false; updateSelection();
    const dvr = state.dvrs.find(item => item.id === deviceId);
    $('dvr-help').textContent = entry.error || (data.playbackTransport === 'hcnetsdk'
      ? `${dvr?.name || '海康录像机'} · SDK 回放每段最多 30 秒，导出每次最多 1 小时；画面时间以录像时钟为准。`
      : `${dvr?.name || '海康录像机'} · ${channels.length} 个通道；选择后会查询 DVR 录像。`);
  } catch (error) {
    if (requestId !== state.dvrChannelRequestId) return;
    select.replaceChildren(); const failed = document.createElement('option'); failed.value = ''; failed.textContent = '通道读取失败'; select.append(failed);
    $('dvr-help').textContent = error.message; notify(error.message, true);
  }
}

$('playback-source').addEventListener('change', async () => {
  const version = state.playbackSelectionVersion = (state.playbackSelectionVersion || 0) + 1;
  state.playbackSource = $('playback-source').value;
  const isDvr = state.playbackSource === 'dvr';
  $('dvr-controls').hidden = !isDvr;
  $('mediamtx-channel-field').hidden = isDvr;
  $('playback-toolbar').classList.toggle('dvr-source', isDvr);
  invalidatePlaybackSelection();
  if (isDvr) {
    await loadDvrChannels();
    if (version !== state.playbackSelectionVersion) return;
    startDvrLive();
  } else startLive();
  loadSegments({ preserveRange: true, keepLive: true }).catch(error => setPlaybackNotice(error.message, true));
});
$('dvr-select').addEventListener('change', async () => {
  const version = state.playbackSelectionVersion = (state.playbackSelectionVersion || 0) + 1;
  invalidatePlaybackSelection(); await loadDvrChannels();
  if (version !== state.playbackSelectionVersion || state.playbackSource !== 'dvr') return;
  if ($('dvr-channel').value) {
    startDvrLive(); loadSegments({ preserveRange: true, keepLive: true }).catch(error => setPlaybackNotice(error.message, true));
  }
});
$('dvr-channel').addEventListener('change', () => {
  state.playbackSelectionVersion = (state.playbackSelectionVersion || 0) + 1;
  state.selectedChannel = $('dvr-channel').value;
  state.dvrChannels[$('dvr-select').value] = state.selectedChannel;
  startDvrLive(); loadSegments({ preserveRange: true, keepLive: true }).catch(error => setPlaybackNotice(error.message, true));
});

function segmentBounds(segment) { const start = Date.parse(segment.start); return { start, end: start + Number(segment.duration) * 1000 }; }
function timelineWindow() {
  const day = dateStart(state.date), span = (state.timelineSpanSeconds || 300) * 1000;
  // Pad the first/last half span so midnight and the latest second can still
  // sit under the fixed centre needle. Out-of-day/future padding is not seekable.
  const center = clampTimelineCenter((state.timelineStartMs ?? day - span / 2) + span / 2);
  const start = center - span / 2;
  return { start, end: start + span, span };
}
// Keep a full hour even just after midnight; future timestamps remain unselectable.
function timelineLimit() {
  const day = dateStart(state.date);
  return Math.max(day, Math.min(day + 86_400_000, Math.floor(Date.now() / 1000) * 1000));
}
function clampTimelineCenter(ms) {
  const day = dateStart(state.date);
  return Math.max(day, Math.min(timelineLimit(), day + 86_399_999, ms));
}
function timelinePercent(ms, start, span) { return Math.max(0, Math.min(100, (ms - start) / span * 100)); }
function renderOverview() {
  const day = dateStart(state.date), track = $('timeline-overview'), bands = $('overview-segments');
  bands.replaceChildren();
  for (const segment of state.segments) {
    const bounds = segmentBounds(segment), start = Math.max(day, bounds.start), end = Math.min(day + 86_400_000, bounds.end);
    if (end <= start) continue;
    const band = document.createElement('span'); band.className = 'overview-segment';
    band.style.left = `${timelinePercent(start, day, 86_400_000)}%`;
    band.style.width = `${Math.max((end - start) / 86_400_000 * 100, 0.12)}%`;
    band.title = `${wallTime(start)} — ${wallTime(end)}`; bands.append(band);
  }
  const window = timelineWindow(), viewport = $('overview-window');
  viewport.style.left = `${(window.start - day) / 86_400_000 * 100}%`;
  viewport.style.width = `${window.span / 86_400_000 * 100}%`;
  viewport.style.clipPath = `inset(0 ${Math.max(0, window.end - day - 86_400_000) / window.span * 100}% 0 ${Math.max(0, day - window.start) / window.span * 100}%)`;
  const selection = $('overview-selection');
  if (state.inMs === null || state.outMs === null || state.outMs <= state.inMs) selection.hidden = true;
  else {
    const start = Math.max(day, state.inMs), end = Math.min(day + 86_400_000, state.outMs);
    selection.hidden = end <= start;
    if (!selection.hidden) {
      selection.style.left = `${timelinePercent(start, day, 86_400_000)}%`;
      selection.style.width = `${(end - start) / 86_400_000 * 100}%`;
    }
  }
  const cursor = $('overview-cursor');
  cursor.hidden = state.previewMode === 'live' || state.cursorMs === null || state.cursorMs < day || state.cursorMs >= day + 86_400_000;
  if (!cursor.hidden) cursor.style.left = `${timelinePercent(state.cursorMs, day, 86_400_000)}%`;
  track.setAttribute('aria-valuenow', String(Math.round(daySeconds(state.cursorMs ?? day))));
  track.setAttribute('aria-valuetext', state.previewMode === 'live' ? '实时预览模式，时间轴用于选择录像' : state.cursorMs === null ? state.date : `${state.playBounds?.sdkTimingUnknown ? '请求 ' : ''}${wallTime(state.cursorMs)}`);
  $('overview-time-readout').textContent = state.previewMode === 'live' || state.cursorMs === null
    ? ''
    : `${state.playBounds?.sdkTimingUnknown ? '请求 ' : ''}${wallTime(state.cursorMs, false).slice(11)}`;
}
function updateTimelineLabels() {
  const { start, end, span } = timelineWindow(), middle = start + span / 2;
  $('timeline-start-label').textContent = `${start < dateStart(state.date) ? '前日 ' : ''}${wallTime(start, false).slice(11)}`;
  $('timeline-middle-label').textContent = wallTime(middle, false).slice(11);
  $('timeline-end-label').textContent = end === dateStart(state.date) + 86_400_000 ? '24:00' : `${end > dateStart(state.date) + 86_400_000 ? '次日 ' : ''}${wallTime(end, false).slice(11)}`;
  const ruler = $('timeline-ruler');
  if (ruler?.replaceChildren) {
    ruler.replaceChildren();
    const seconds = span / 1000, minor = seconds <= 30 ? 1 : seconds <= 300 ? 10 : seconds <= 3600 ? 120 : 3600;
    const major = seconds <= 30 ? 10 : seconds <= 300 ? 60 : seconds <= 3600 ? 600 : 14400;
    for (let ms = Math.ceil(start / (minor * 1000)) * minor * 1000; ms <= end; ms += minor * 1000) {
      const tick = document.createElement('span'); tick.className = 'ruler-tick'; tick.style.left = `${(ms - start) / span * 100}%`;
      const second = Math.round(ms / 1000); tick.classList.toggle('major', second % major === 0); tick.classList.toggle('medium', second % (major / 2) === 0);
      if (second % major === 0) tick.textContent = wallTime(ms).slice(11, seconds <= 30 ? 19 : 16);
      ruler.append(tick);
    }
  }
  const hasRecordings = state.segments.length > 0;
  $('transport-toggle').disabled = $('replay-player').hidden && !hasRecordings;
  $('skip-back').disabled = state.previewMode === 'live' || !hasRecordings;
  $('skip-forward').disabled = state.previewMode === 'live' || !hasRecordings;
  $('fine-back').disabled = $('fine-forward').disabled = state.previewMode === 'live' || !hasRecordings;
}
function setTimelineWindow(centerMs) {
  state.timelineStartMs = clampTimelineCenter(centerMs) - timelineWindow().span / 2;
  renderTimeline();
}
function setTimelineSpan(seconds) {
  if (!TIMELINE_SPANS.includes(seconds) || state.timelineSpanSeconds === seconds) return;
  const view = timelineWindow(), center = state.cursorMs ?? view.start + view.span / 2;
  state.timelineSpanSeconds = seconds;
  setTimelineWindow(center);
  syncTimelineZoomButtons();
}
function syncTimelineZoomButtons() {
  document.querySelectorAll('[data-timeline-span]').forEach(button => {
    const active = Number(button.dataset.timelineSpan) === state.timelineSpanSeconds;
    button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active);
  });
}
function renderTimeline() {
  const timeline = $('timeline'); timeline.querySelectorAll('.segment').forEach(node => node.remove());
  const empty = timeline.querySelector('.timeline-empty');
  const { start: viewStart, end: viewEnd, span } = timelineWindow();
  let visibleCount = 0;
  state.segments.forEach((segment, index) => {
    const { start, end } = segmentBounds(segment), clipStart = Math.max(start, viewStart), clipEnd = Math.min(end, viewEnd);
    if (clipEnd <= clipStart) return;
    visibleCount++;
    const block = document.createElement('button'); block.type = 'button'; block.className = 'segment'; block.dataset.index = String(index);
    block.style.left = `${timelinePercent(clipStart, viewStart, span)}%`; block.style.width = `${Math.max((clipEnd - clipStart) / span * 100, 0.8)}%`;
    block.title = `${wallTime(clipStart)} — ${wallTime(clipEnd)}`; block.setAttribute('aria-label', block.title);
    block.addEventListener('click', event => { if (event.detail === 0) { event.stopPropagation(); jumpToTimelineTime(clipStart, 'detail'); } }); timeline.append(block);
  });
  empty.textContent = !state.segments.length
    ? state.playbackSource === 'mediamtx' ? 'MediaMTX 这一天没有录像；可切换到「海康 DVR 回放」查询。' : '海康 DVR 这一天没有录像区段。'
    : '当前时间范围内没有录像；点上方全天概览切换时段';
  empty.hidden = visibleCount > 0;
  renderOverview(); updateTimelineLabels();
  updateCursor(); updateSelection();
  const sourceLabel = state.playbackSource === 'dvr'
    ? `${state.dvrs.find(dvr => dvr.id === $('dvr-select').value)?.name || '海康 DVR'} / ${$('dvr-channel').value || '通道未选'}`
    : `MediaMTX / ${state.selectedCamera || '通道未选'}`;
  $('segment-caption').textContent = state.segments.length
    ? `${state.segments.length} 段 · ${sourceLabel} · ${state.date}`
    : `无录像 · ${sourceLabel} · ${state.date}`;
}
async function loadSegments({ preserveRange = false, keepLive = false } = {}) {
  if (!state.date || (state.playbackSource !== 'dvr' && !state.selectedCamera)) return;
  if (state.playbackSource === 'dvr' && (!$('dvr-select').value || !$('dvr-channel').value)) {
    state.segmentRequestId++; clearReplay(); state.segments = []; state.cursorMs = null; renderTimeline();
    $('timeline').querySelector('.timeline-empty').textContent = '先选择录像机和通道'; $('timeline').querySelector('.timeline-empty').hidden = false;
    setPlaybackNotice('选择录像机和通道后，才能查询海康 DVR 录像。', true); return;
  }
  $('retry-recordings').hidden = true;
  const requestId = ++state.segmentRequestId;
  const preferredCursor = preserveRange ? state.inMs ?? state.cursorMs : null;
  if (!(keepLive && state.previewMode === 'live')) clearReplay();
  state.segments = []; state.cursorMs = null; state.timelineStartMs = dateStart(state.date);
  if (!preserveRange) clearMarkedRange();
  renderTimeline();
  $('timeline').querySelector('.timeline-empty').textContent = '正在读取录像区段…'; $('timeline').querySelector('.timeline-empty').hidden = false;
  const query = new URLSearchParams({ date: state.date });
  const path = state.playbackSource === 'dvr'
    ? `/console/api/dvrs/${encodeURIComponent($('dvr-select').value)}/segments?${new URLSearchParams({ date: state.date, channel: $('dvr-channel').value })}`
    : `/console/api/playback/${encodeURIComponent(state.selectedCamera)}/segments?${query}`;
  let data; const loadButton = $('load-recordings'); loadButton.disabled = true; loadButton.textContent = '正在查询…';
  try { data = await api(path); } catch (error) { if (requestId === state.segmentRequestId) { const empty = $('timeline').querySelector('.timeline-empty'); empty.textContent = '读取失败，请重试。'; empty.hidden = false; $('retry-recordings').hidden = false; } throw error; }
  finally { if (requestId === state.segmentRequestId) { loadButton.disabled = false; loadButton.textContent = '载入录像 ↻'; } }
  if (requestId !== state.segmentRequestId) return;
  state.segments = (data.segments || []).slice().sort((a, b) => segmentBounds(a).start - segmentBounds(b).start);
  const preferredSegment = preferredCursor === null ? null : state.segments.find(segment => {
    const bounds = segmentBounds(segment); return preferredCursor >= bounds.start && preferredCursor < bounds.end;
  });
  state.cursorMs = preferredSegment ? preferredCursor : state.segments.length ? segmentBounds(state.segments[0]).start : dateStart(state.date);
  if (state.cursorMs !== null) setTimelineWindow(state.cursorMs); else renderTimeline();
  const emptyNotice = !state.segments.length && typeof data.notice === 'string' ? data.notice : '';
  if (emptyNotice) $('timeline').querySelector('.timeline-empty').textContent = emptyNotice;
  setPlaybackNotice(emptyNotice || (state.segments.length
    ? ''
    : state.playbackSource === 'mediamtx' ? 'MediaMTX 这一天没有本地录像；切换「海康 DVR 回放」再查。' : '海康 DVR 这一天没有录像；可以换日期或通道。'),
  !state.segments.length);
}
function updateCursor() {
  const readout = $('timeline-current-time');
  if (readout) {
    readout.hidden = state.previewMode === 'live';
    readout.textContent = readout.hidden ? '' : state.cursorMs === null || !state.date ? '--:--:--' : wallTime(state.cursorMs).slice(11);
  }
  // Playback, keyboard seeks and window drags share one centred time. Marker
  // drags retain their grip mapping until release, then recenter as normal.
  if (state.previewMode !== 'live' && state.cursorMs !== null && state.date && !state.dragBoundary) {
    const start = clampTimelineCenter(state.cursorMs) - timelineWindow().span / 2;
    if (state.timelineStartMs !== start) { state.timelineStartMs = start; renderTimeline(); return; }
  }
  $('mark-in').disabled = $('mark-out').disabled = state.cursorMs === null || state.previewMode === 'live' || state.playBounds?.sdkTimingUnknown === true;
  const markHint = state.previewMode === 'live' ? '直播不能标记录像入出点' : state.playBounds?.sdkTimingUnknown ? 'SDK 无法按当前帧标记，请手填导出时间' : '';
  $('mark-in').title = markHint || '以当前播放位置设置入点'; $('mark-out').title = markHint || '以当前播放位置设置出点';
  syncPlaybackStatus();
  const cursor = $('time-cursor'), overviewCursor = $('overview-cursor');
  if (state.previewMode === 'live' || state.cursorMs === null || !state.date) {
    cursor.hidden = true; overviewCursor.hidden = true; $('overview-time-readout').textContent = '';
    document.querySelectorAll('.segment').forEach(block => block.classList.remove('selected'));
    $('timeline').setAttribute('aria-label', state.previewMode === 'live' ? '录像时间轴，选择时间回放' : '录像时间轴');
    $('timeline-overview').setAttribute('aria-valuetext', state.previewMode === 'live' ? '实时预览模式，时间轴用于选择录像' : state.date || '未选择日期');
    return;
  }
  cursor.classList.toggle('requested-time', state.playBounds?.sdkTimingUnknown === true);
  overviewCursor.classList.toggle('requested-time', state.playBounds?.sdkTimingUnknown === true);
  const window = timelineWindow(), day = dateStart(state.date);
  cursor.hidden = state.cursorMs < window.start || state.cursorMs > window.end;
  if (!cursor.hidden) cursor.style.left = `${timelinePercent(state.cursorMs, window.start, window.span)}%`;
  overviewCursor.hidden = state.cursorMs < day || state.cursorMs >= day + 86_400_000;
  if (!overviewCursor.hidden) overviewCursor.style.left = `${timelinePercent(state.cursorMs, day, 86_400_000)}%`;
  $('timeline').setAttribute('aria-label', `精细录像时间轴，拖动窗口，中心时间 ${state.playBounds?.sdkTimingUnknown ? '请求位置 ' : ''}${wallTime(state.cursorMs)}；左右键微调1秒，Shift加左右键微调10秒`);
  document.querySelectorAll('.segment').forEach(block => {
    const segment = state.segments[Number(block.dataset.index)];
    const active = segment && state.cursorMs >= segmentBounds(segment).start && state.cursorMs < segmentBounds(segment).end;
    block.classList.toggle('selected', Boolean(active));
  });
  $('timeline-overview').setAttribute('aria-valuenow', String(Math.round(daySeconds(state.cursorMs))));
  $('timeline-overview').setAttribute('aria-valuetext', `${state.playBounds?.sdkTimingUnknown ? '请求 ' : ''}${wallTime(state.cursorMs)}`);
  $('overview-time-readout').textContent = `${state.playBounds?.sdkTimingUnknown ? '请求 ' : ''}${wallTime(state.cursorMs, false).slice(11)}`;
  syncPlaybackStatus();
}
function boundaryLabel(ms) { return ms === null ? '未设置' : ms === dateStart(state.date) + 86_400_000 ? '24:00:00' : wallTime(ms).slice(11); }
function updateBoundaryControls() {
  const window = timelineWindow(), day = dateStart(state.date);
  for (const boundary of ['in', 'out']) {
    const ms = state[boundary === 'in' ? 'inMs' : 'outMs'];
    $(`boundary-${boundary}-time`).textContent = boundaryLabel(ms);
    const markTime = $(`mark-${boundary}-time`); if (markTime) markTime.textContent = ms === null ? '--:--:--' : boundaryLabel(ms);
    const handle = $(`boundary-${boundary}`); handle.hidden = ms === null || ms < window.start || ms > window.end;
    if (!handle.hidden) { handle.style.left = `${timelinePercent(ms, window.start, window.span)}%`; handle.setAttribute('aria-valuenow', String((ms - day) / 1000)); handle.setAttribute('aria-valuetext', boundaryLabel(ms)); }
  }
}
function focusBoundary(boundary) {
  const ms = state[boundary === 'in' ? 'inMs' : 'outMs'];
  if (ms === null) return;
  setTimelineWindow(ms);
  // Existing copy streams start near the requested boundary, not a frame-accurate seek.
  Promise.resolve(jumpToTimelineTime(ms, 'detail', { autoplay: !$('replay-player').hidden && !$('replay-player').paused })).catch(error => setPlaybackNotice(error.message, true));
}
function playbackContextKey() {
  return JSON.stringify([state.date, state.playbackSource, state.playbackSelectionVersion || 0, state.configRevision,
    state.playbackSource === 'dvr' ? [$('dvr-select').value, $('dvr-channel').value] : state.selectedCamera]);
}
function requirePlaybackContext(key) {
  if (key !== playbackContextKey()) throw new Error('日期或录像来源已改变，请重新打开时间编辑。');
}
function openBoundaryEditor(boundary) {
  const original = state[boundary === 'in' ? 'inMs' : 'outMs'];
  if (original === null) { openRangeEditor(); return; }
  const context = playbackContextKey(), date = state.date;
  const sheet = openDialog(boundary === 'in' ? '调整入点' : '调整出点', `${date} · 北京时间`);
  const input = enhanceTimeInput(labelledInput(sheet.content, '时间', boundaryLabel(original), { placeholder: '201530 → 20:15:30', maxLength: 8 }));
  const steps = document.createElement('div'); steps.className = 'boundary-steps'; sheet.content.append(steps);
  const read = () => { requirePlaybackContext(context); return rangeTimeMs(input.value, date, boundary === 'out'); };
  for (const seconds of [-10, -1, 1, 10]) addButton(steps, `${seconds > 0 ? '+' : '−'}${Math.abs(seconds)} 秒`, 'quiet-button', () => {
    try { input.value = boundaryLabel(clampBoundaryTime(read() + seconds * 1000, boundary)); sheet.error.textContent = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } catch (error) { sheet.error.textContent = error.message; }
  });
  if (state.cursorMs !== null) addButton(sheet.content, '用当前定位时间', 'quiet-button', () => { if (context !== playbackContextKey()) { sheet.error.textContent = '日期或录像来源已改变，请重新打开时间编辑。'; return; } input.value = boundaryLabel(clampBoundaryTime(state.cursorMs, boundary)); input.dispatchEvent(new Event('input', { bubbles: true })); });
  addButton(sheet.actions, '定位原时间', 'quiet-button', () => { if (context !== playbackContextKey()) { sheet.error.textContent = '日期或录像来源已改变，请重新打开时间编辑。'; return; } sheet.close(); focusBoundary(boundary); });
  addButton(sheet.actions, '应用并定位', 'primary-button', () => {
    try { const value = read(); if (clampBoundaryTime(value, boundary) !== value) throw new Error('开始必须早于结束，至少保留 1 秒。'); state[boundary === 'in' ? 'inMs' : 'outMs'] = value; updateSelection(); sheet.close(); focusBoundary(boundary); } catch (error) { sheet.error.textContent = error.message; }
  });
  input.focus(); input.select();
}
function updateSelection() {
  const overlay = $('range-overlay'); const inMs = state.inMs, outMs = state.outMs;
  updateBoundaryControls();
  $('clear-marks').disabled = inMs === null && outMs === null;
  $('selection-readout').textContent = inMs !== null && outMs !== null && outMs > inMs ? formatClipDuration(outMs - inMs) : '';
  $('selection-readout').hidden = !$('selection-readout').textContent;
  const valid = inMs !== null && outMs !== null && outMs > inMs;
  const duration = $('selection-duration'); if (duration) { const seconds = valid ? Math.round((outMs - inMs) / 1000) : 0; duration.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  const badge = $('selection-status');
  if (badge) { badge.textContent = valid ? '已选择' : inMs !== null || outMs !== null ? '待完成' : '未选择'; badge.classList.toggle('ready', valid); }
  const gap = valid ? findCoverageGap(state.segments, inMs, outMs) : null;
  const warning = $('selection-gap-warning');
  if (warning) {
    const count = gap && state.playbackSource === 'mediamtx' ? countCoverageGaps(state.segments, inMs, outMs) : 0;
    warning.hidden = count === 0; $('selection-gap-count').textContent = String(count);
    warning.disabled = state.busy;
    warning.setAttribute('aria-label', `查看 ${count} 处录像中断的时间范围`);
    warning.title = `查看 ${count} 处录像中断的时间范围`;
  }
  const exportButton = $('export-range'), selectionHelp = $('selection-help');
  exportButton.disabled = !valid || !hasPlaybackSelection() || state.busy;
  const cancel = $('cancel-export'); if (cancel) cancel.hidden = !state.busy;
  exportButton.title = valid ? '' : '请先设置有效的入点和出点';
  selectionHelp.classList.remove('warning');
  selectionHelp.textContent = state.playbackSource === 'dvr'
    ? !hasPlaybackSelection() ? '先选择录像机和通道。' : ''
    : !valid
    ? ''
    : gap
      ? '选段含录像中断。点击警告查看每段时间，确认后可导出已有录像。'
      : '';
  selectionHelp.hidden = !selectionHelp.textContent;
  if (inMs === null || outMs === null || outMs <= inMs) { overlay.hidden = true; $('overview-selection').hidden = true; return; }
  const window = timelineWindow(), start = Math.max(inMs, window.start), end = Math.min(outMs, window.end);
  overlay.hidden = end <= start;
  if (!overlay.hidden) { overlay.style.left = `${timelinePercent(start, window.start, window.span)}%`; overlay.style.width = `${(end - start) / window.span * 100}%`; }
  const day = dateStart(state.date), overviewStart = Math.max(inMs, day), overviewEnd = Math.min(outMs, day + 86_400_000);
  $('overview-selection').hidden = overviewEnd <= overviewStart;
  if (!$('overview-selection').hidden) {
    $('overview-selection').style.left = `${timelinePercent(overviewStart, day, 86_400_000)}%`;
    $('overview-selection').style.width = `${(overviewEnd - overviewStart) / 86_400_000 * 100}%`;
  }
}
function clearReplay() {
  cancelReplayHold();
  state.mediaLive?.close(); state.mediaLive = null;
  state.lastFramePending = null;
  stopHlsPreview();
  if (state.dragging || state.pendingScrub) interruptTimelineScrub();
  const video = $('replay-player');
  state.playRequestId++; state.pendingLocalSeek = null; state.previewMode = 'replay';
  state.previewFailed = false; state.playbackWaiting = false;
  state.playbackAutoplay = false; state.playbackFormats = []; state.playFormat = ''; state.playBounds = null; state.followPlayback = false;
  video.onerror = null;
  video.muted = true;
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load(); video.hidden = true;
  syncReplayToggle();
  $('player-placeholder').hidden = false;
}
function stopHlsPreview() {
  state.sdkPreparationController?.abort(); state.sdkPreparationController = null;
  if (!['hls', 'sdk'].includes(state.playFormat) || state.hlsStopped || !state.previewClientId) return;
  state.hlsStopped = true; clearHlsStart();
  const request = globalThis.fetch?.(appPath(state.playFormat === 'sdk' ? '/console/api/dvr-sdk-preview/stop' : '/console/api/dvr-preview/stop'), { method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: state.previewClientId, generation: ++state.previewRequestGeneration }) });
  request?.catch(() => {});
}
function clearHlsStart() {
  globalThis.clearTimeout?.(state.pendingHlsStart?.timer);
  state.pendingHlsStart = null;
}
function stopPausedHlsPreview() {
  const video = $('replay-player');
  if (!state.pendingHlsStart && state.playFormat === 'hls' && state.playbackAutoplay === false && video.paused && video.readyState >= 2
    && video.currentSrc === video.src && state.playBounds?.src === video.src) stopHlsPreview();
}
function syncPlaybackStatus() {
  const video = $('replay-player'), label = $('player-time-label');
  const live = state.previewMode === 'live';
  const failed = state.previewFailed || video.error;
  let text;
  if (video.hidden) text = '—';
  else if (failed) text = live ? '连接失败' : '回放失败';
  else if (video.ended) text = live ? '直播已结束' : '本段结束';
  else if (state.playbackWaiting || video.readyState < 2 || video.currentSrc !== video.src) text = live ? '连接中' : '载入中';
  else if (state.previewMode === 'last-frame') text = state.date === today() ? '今日最后录像画面' : '所选日期最后录像画面';
  else if (video.paused) text = live ? '直播已暂停' : '回放已暂停';
  else text = live ? '直播中' : state.playBounds?.sdkTimingUnknown ? '回放 · 以画面为准' : '回放中';
  label.setAttribute('aria-live', live || state.playBounds?.sdkTimingUnknown ? 'polite' : 'off');
  label.textContent = text; label.hidden = video.hidden;
  label.classList.toggle('is-live', Boolean(live && !video.hidden && !failed && !video.paused && !video.ended && !state.playbackWaiting && video.readyState >= 2 && video.currentSrc === video.src));
  label.title = state.playBounds?.sdkTimingUnknown ? '时间轴为请求位置；画面时间以录像时钟为准' : text;
  const status = $('video-status');
  if (status) {
    status.hidden = video.hidden; status.title = label.title;
    status.dataset.state = failed ? 'error' : video.ended ? 'ended' : state.playbackWaiting || video.readyState < 2 || video.currentSrc !== video.src ? 'waiting' : video.paused ? 'paused' : live ? 'live' : 'replay';
  }
}
function syncReplayToggle() {
  const video = $('replay-player'), button = $('playback-toggle');
  const visible = !video.hidden;
  $('skip-back').hidden = $('skip-forward').hidden = false;
  $('skip-back').disabled = $('skip-forward').disabled = state.previewMode === 'live' || !state.segments.length;
  $('fine-back').disabled = $('fine-forward').disabled = state.previewMode === 'live' || !state.segments.length;
  const live = $('go-live'); live.hidden = state.previewMode === 'live' && !state.previewFailed && !$('replay-player').error && !$('replay-player').ended; live.disabled = !hasPlaybackSelection();
  live.setAttribute('aria-pressed', String(state.previewMode === 'live'));
  const isPlaying = visible && !video.paused && !video.ended && !video.error && !state.previewFailed;
  button.hidden = !visible;
  button.setAttribute('aria-pressed', String(isPlaying));
  const playbackLabel = `${isPlaying ? '暂停' : '播放'}${state.previewMode === 'live' ? '直播' : '录像'}`;
  button.setAttribute('aria-label', playbackLabel); button.title = playbackLabel;
  $('playback-toggle-label').textContent = isPlaying ? '暂停' : '播放';
  const transport = $('transport-toggle');
  setButtonIcon(transport, isPlaying ? 'pause' : 'play', playbackLabel); transport.disabled = !visible && !state.segments.length; transport.setAttribute('aria-pressed', String(isPlaying));
  syncReplayMute(); syncPlaybackStatus();
}
function syncReplayMute() {
  const video = $('replay-player'), button = $('playback-mute');
  button.hidden = video.hidden;
  button.setAttribute('aria-pressed', String(!video.muted));
  setButtonIcon(button, video.muted ? 'volume-off' : 'volume-on', video.muted ? '开启声音' : '静音');
}
function toggleTransportPlayback() {
  if (!$('replay-player').hidden) return toggleReplayPlayback();
  if (!state.date || !state.segments.length) return;
  const point = state.cursorMs ?? segmentBounds(state.segments[0]).start;
  return Promise.resolve(jumpToTimelineTime(point, 'overview', { autoplay: true }))
    .catch(error => setPlaybackNotice(error.message, true));
}
function toggleReplayMute() {
  const video = $('replay-player');
  if (video.hidden) return;
  video.muted = !video.muted;
  syncReplayMute();
}
function selectTime(ms, play = false) {
  state.followPlayback = false; state.cursorMs = ms; updateCursor();
  if (play) playAt(ms).catch(error => setPlaybackNotice(error.message, true));
}
function startLive() {
  if (state.playbackSource === 'dvr') return startDvrLive();
  if (!hasPlaybackSelection()) return;
  clearReplay(); state.previewMode = 'live'; state.playFormat = 'webrtc'; state.playbackWaiting = true; state.playbackAutoplay = true;
  const requestId = state.playRequestId, camera = state.selectedCamera;
  const video = $('replay-player'); video.hidden = false; video.controls = false; video.muted = true; $('player-placeholder').hidden = true;
  setPlaybackNotice('正在连接直播…'); updateCursor(); syncReplayToggle();
  state.mediaLive = startMediaMtxLive({ video, url: appPath(`/console/api/playback/${encodeURIComponent(camera)}/live/whep`),
    onReady: () => { if (requestId !== state.playRequestId) return; state.playbackWaiting = false; setPlaybackNotice(''); syncReplayToggle(); },
    onUnavailable: () => { if (requestId === state.playRequestId) showLastRecordingFrame(requestId, camera).catch(error => { if (requestId === state.playRequestId) { clearReplay(); setPlaybackNotice(error.message, true); } }); },
  });
}
async function showLastRecordingFrame(requestId, camera) {
  const date = state.date;
  if (!date) return;
  const dayLabel = date === today() ? '今天' : '所选日期';
  setPlaybackNotice(`直播暂不可用，正在读取${dayLabel}最后的录像画面…`);
  const data = await api(`/console/api/playback/${encodeURIComponent(camera)}/segments?${new URLSearchParams({ date })}`);
  if (requestId !== state.playRequestId || state.playbackSource !== 'mediamtx' || camera !== state.selectedCamera || date !== state.date) return;
  const day = dateStart(date), now = Date.now();
  const segments = (data.segments || []).filter(row => { const b = segmentBounds(row); return Number.isFinite(b.start) && Number.isFinite(b.end) && b.start < Math.min(now, day + 86400000) && b.end > day; }).sort((a,b) => segmentBounds(a).end - segmentBounds(b).end);
  const last = segments.at(-1);
  if (!last) { clearReplay(); setPlaybackNotice(`当前没有直播，${dayLabel}也没有可用录像画面。`); return; }
  const bounds = segmentBounds(last), end = Math.min(bounds.end, now, day + 86400000), start = Math.max(bounds.start, day, end - 10000);
  if (end <= start) { clearReplay(); setPlaybackNotice(`${dayLabel}还没有可用录像画面。`); return; }
  state.segmentRequestId++; state.segments = segments;
  // A live-preview fallback must not replace the selected day or export marks.
  const preview = playAt(start, { autoplay: false, segmentOverride: last });
  const previewRequestId = state.playRequestId;
  await preview;
  if (previewRequestId !== state.playRequestId || state.playbackSource !== 'mediamtx' || camera !== state.selectedCamera || date !== state.date) return;
  state.previewMode = 'last-frame';
  state.lastFramePending = { requestId: previewRequestId, end, seeking: false };
  setPlaybackNotice(`直播暂不可用，正在定位${dayLabel}最后的录像画面…`); syncReplayToggle();
}
function finishLastRecordingFrame() {
  const pending = state.lastFramePending, video = $('replay-player'), bounds = state.playBounds;
  if (!pending || pending.requestId !== state.playRequestId || state.previewMode !== 'last-frame' || !bounds || video.currentSrc !== video.src || !video.seekable?.length) return;
  if (pending.src !== video.src) { pending.src = video.src; pending.seeking = false; }
  if (!pending.seeking) {
    const max = Math.min((pending.end - bounds.start) / 1000, Number.isFinite(video.duration) ? video.duration : Infinity, video.seekable.end(video.seekable.length - 1));
    const offset = Math.max(video.seekable.start(0), max - 0.001);
    if (!Number.isFinite(offset) || offset < 0) return;
    pending.seeking = true;
    try { video.currentTime = offset; } catch { pending.seeking = false; }
    return;
  }
  if (video.seeking || video.readyState < 2) return;
  video.pause(); state.followPlayback = false; state.playbackAutoplay = false;
  state.cursorMs = bounds.start + video.currentTime * 1000; state.lastFramePending = null;
  setTimelineWindow(state.cursorMs); syncReplayToggle();
  setPlaybackNotice(`直播暂不可用 · ${state.date === today() ? '今日' : '所选日期'}最后录像画面 ${wallTime(state.cursorMs)}`);
}
function startDvrLive() {
  if (state.playbackSource !== 'dvr' || !hasPlaybackSelection()) return;
  clearReplay(); state.previewMode = 'live'; state.pendingLocalSeek = null;
  const requestId = ++state.playRequestId, start = Date.now();
  state.playbackAutoplay = true; state.followPlayback = false;
  state.playBounds = { start, duration: 600, end: start + 600000, camera: state.selectedCamera, date: state.date };
  state.playbackFormats = prefersStandardMp4() ? ['hls', 'compat'] : ['fmp4', 'compat'];
  const video = $('replay-player'); video.hidden = false; video.controls = false; video.removeAttribute('controls'); video.playsInline = true;
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', ''); $('player-placeholder').hidden = true;
  updateCursor(); loadPlaybackFormat(requestId, start, 600); syncReplayToggle();
}
async function playAt(ms, { autoplay = true, segmentOverride = null } = {}) {
  state.mediaLive?.close(); state.mediaLive = null; state.lastFramePending = null;
  $('replay-player').srcObject = null;
  stopHlsPreview();
  state.previewMode = 'replay'; state.previewFailed = false; state.playbackWaiting = false;
  const segment = state.segments.find(item => { const b = segmentBounds(item); return (!segmentOverride || item === segmentOverride) && ms >= b.start && ms < b.end; });
  if (!segment) { clearReplay(); setPlaybackNotice('这个时间点没有录像。', true); return; }
  const requestId = ++state.playRequestId; state.pendingLocalSeek = null;
  const bounds = segmentBounds(segment), start = Math.max(ms, bounds.start), duration = Math.max(0.5, Math.min(21600, (bounds.end - start) / 1000));
  state.followPlayback = false;
  state.playbackAutoplay = autoplay;
  state.playBounds = { start, duration, end: start + duration * 1000, camera: state.selectedCamera, date: state.date };
  selectTime(start); $('replay-player').hidden = false; $('player-placeholder').hidden = true;
  const video = $('replay-player');
  video.controls = false; video.removeAttribute('controls'); video.playsInline = true;
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
  state.playbackFormats = state.playbackSource === 'dvr' && state.dvrSdkDevices?.[$('dvr-select').value] ? ['sdk'] : state.playbackSource === 'dvr' ? prefersStandardMp4() ? ['hls', 'fmp4', 'compat'] : ['fmp4', 'compat'] : prefersStandardMp4() ? ['mp4', 'fmp4'] : ['fmp4', 'mp4'];
  video.pause(); syncReplayToggle();
  loadPlaybackFormat(requestId, start, duration);
}
function prefersStandardMp4() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/(Chrome|CriOS|Edg|OPR|FxiOS|Firefox)/.test(ua);
  return ios || safari;
}
function loadPlaybackFormat(requestId, start, duration) {
  if (requestId !== state.playRequestId) return;
  const format = state.playbackFormats.shift();
  if (!format) {
    state.previewFailed = true; syncReplayToggle();
    setPlaybackNotice(state.playbackSource === 'dvr'
      ? state.previewMode === 'live' ? '实时预览失败，请检查设备连接或视频解码。' : '未能读取或解码 DVR 录像，请检查所选通道、录像时段和设备连接。'
      : 'MP4 与分片 MP4 都无法播放；可能是当前 Safari 设备不支持这段录像的编码或分辨率。', true);
    return;
  }
  // Only standard MP4 needs a completed seekable file. Keep each preparation
  // small; preserve the original requested end for automatic continuation.
  if (state.playbackSource === 'mediamtx' && format === 'mp4') duration = Math.min(30, duration);
  // Retain each historical HLS group from its selected origin through ENDLIST.
  // 120s at the encoder's 3Mb/s cap leaves room inside the 64MiB hard cache cap.
  if (format === 'hls' && state.previewMode !== 'live') duration = Math.min(120, duration);
  if (format === 'sdk') {
    if (duration < 1) { setPlaybackNotice('所选录像末尾不足 1 秒，请选择稍早的时间。', true); return; }
    duration = Math.min(30, Math.floor(duration));
  }
  if (['hls', 'sdk'].includes(state.playFormat)) stopHlsPreview();
  state.playBounds.duration = duration;
  state.playFormat = format;
  state.hlsStopped = false; clearHlsStart();
  state.previewClientId ||= globalThis.crypto?.randomUUID?.() || `preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  state.previewRequestGeneration = (state.previewRequestGeneration || 0) + 1;
  const previewRequest = { client: state.previewClientId, generation: String(state.previewRequestGeneration) };
  const params = new URLSearchParams({ start: new Date(start).toISOString(), duration: duration.toFixed(3), format });
  const url = state.playbackSource === 'dvr'
    ? state.previewMode === 'live'
      ? appPath(`/console/api/dvrs/${encodeURIComponent($('dvr-select').value)}/live?${new URLSearchParams({ channel: $('dvr-channel').value, format, ...previewRequest })}`)
      : appPath(`/console/api/dvrs/${encodeURIComponent($('dvr-select').value)}/stream?${new URLSearchParams({ channel: $('dvr-channel').value, start: new Date(start).toISOString(), duration: duration.toFixed(3), format, ...previewRequest })}`)
    : appPath(`/console/api/playback/${encodeURIComponent(state.selectedCamera)}/stream?${params}`);
  const video = $('replay-player');
  state.followPlayback = false;
  if (format === 'sdk') { prepareSdkPlayback(requestId, start, duration, previewRequest); return; }
  video.pause(); video.preload = format === 'hls' ? 'auto' : 'metadata'; video.src = url; video.load();
  const expectedSrc = video.src; state.playBounds.src = expectedSrc; state.pendingLocalSeek = null;
  if (format === 'hls') {
    const pending = state.pendingHlsStart = { requestId, src: expectedSrc, start, seekRequested: false };
    pending.timer = globalThis.setTimeout?.(() => {
      if (state.pendingHlsStart !== pending || requestId !== state.playRequestId || video.src !== expectedSrc || state.hlsStopped) return;
      clearHlsStart(); handlePlaybackError();
    // Live preparation may include 20s metadata + two serial 15s sources, then close/load overhead.
    }, state.previewMode === 'live' ? 75000 : 20000);
  }
  if (!state.playbackAutoplay) { syncReplayToggle(); setPlaybackNotice(state.previewMode === 'live' ? '实时预览已暂停。' : `已定位 ${wallTime(start)}，保持暂停。`); return; }
  if (format === 'hls') { setPlaybackNotice('正在准备手机兼容回放，首个分片到达后开始播放…'); return; }
  else if (state.playbackSource === 'dvr' && format === 'fmp4') setPlaybackNotice(state.previewMode === 'live' ? '正在连接实时画面…' : '正在载入 DVR 录像…');
  else if (format === 'fmp4' && state.playbackFormats.length) setPlaybackNotice('正在尝试兼容播放格式…');
  startLoadedPlayback(requestId, expectedSrc, start);
}
async function prepareSdkPlayback(requestId, start, duration, previewRequest) {
  const video = $('replay-player'), controller = new AbortController();
  state.sdkPreparationController = controller;
  video.pause(); video.removeAttribute('src'); video.load();
  state.playBounds.sdkTimingUnknown = true; updateCursor();
  $('mark-in').disabled = $('mark-out').disabled = true;
  setPlaybackNotice(`SDK 准备中 · ${duration} 秒`);
  try {
    const prepared = await api(`/console/api/dvrs/${encodeURIComponent($('dvr-select').value)}/stream?${new URLSearchParams({
      channel: $('dvr-channel').value, start: new Date(start).toISOString(), duration: String(duration), format: 'sdk', ...previewRequest,
    })}`, { signal: controller.signal });
    if (controller.signal.aborted || requestId !== state.playRequestId || state.playFormat !== 'sdk'
      || previewRequest.generation !== String(state.previewRequestGeneration)) return;
    if (!prepared?.success || !/^\/console\/api\/dvr-sdk-preview\/[a-f0-9-]{36}\/media\.mp4$/.test(prepared.mediaUrl || '')
      || !Number.isFinite(prepared.actualDurationSeconds) || prepared.actualDurationSeconds <= 0)
      throw new Error('SDK 预览返回了无效的片段信息。');
    state.playBounds.actualDurationSeconds = prepared.actualDurationSeconds;
    video.preload = 'auto'; video.src = appPath(prepared.mediaUrl); video.load();
    state.playBounds.src = video.src;
    setPlaybackNotice(sdkPlaybackNotice());
    if (state.playbackAutoplay) startLoadedPlayback(requestId, video.src, start);
    else syncReplayToggle();
  } catch (error) {
    if (!controller.signal.aborted && requestId === state.playRequestId) {
      state.playbackAutoplay = false; state.previewFailed = true; syncReplayToggle();
      setPlaybackNotice(error.message || 'SDK 预览失败，请重新选择时间重试。', true);
    }
  } finally { if (state.sdkPreparationController === controller) state.sdkPreparationController = null; }
}
function sdkPlaybackNotice() {
  const seconds = state.playBounds?.actualDurationSeconds;
  return `SDK${Number.isFinite(seconds) ? ` · ${seconds.toFixed(1)} 秒` : ''} · 以画面时钟为准；导出时间手填。`;
}
function startLoadedPlayback(requestId, expectedSrc, start) {
  const video = $('replay-player');
  try {
    video.play().then(() => {
      if (requestId === state.playRequestId && video.src === expectedSrc) setPlaybackNotice(state.playFormat === 'sdk' ? sdkPlaybackNotice() : state.previewMode === 'live' ? '正在实时预览。' : `正在播放 ${wallTime(start)}。`);
    }).catch(() => {
      if (requestId !== state.playRequestId || video.src !== expectedSrc) return;
      if (video.error) handlePlaybackError();
      else { state.playbackAutoplay = false; setPlaybackNotice(state.playFormat === 'sdk' ? `${sdkPlaybackNotice()} 点播放键开始。` : state.previewMode === 'live' ? '实时画面已载入，点播放键开始。' : `录像已载入 ${wallTime(start)}，点播放键开始。`); }
    });
  } catch { state.playbackAutoplay = false; setPlaybackNotice(state.playFormat === 'sdk' ? `${sdkPlaybackNotice()} 点播放键开始。` : state.previewMode === 'live' ? '实时画面已载入，点播放键开始。' : `录像已载入 ${wallTime(start)}，点播放键开始。`); }
}
// EXT-X-START is a hint to native HLS. Confirm the loaded historical origin
// before playing or freezing a paused frame; attempt at most one precise seek.
function finishHlsStart() {
  const video = $('replay-player'), pending = state.pendingHlsStart;
  if (!pending || pending.requestId !== state.playRequestId || pending.src !== video.src || video.currentSrc !== pending.src
    || state.playBounds?.src !== pending.src || state.playFormat !== 'hls' || state.hlsStopped || video.hidden
    || video.readyState < 2 || video.seeking) return;
  if (state.previewMode !== 'live' && (!Number.isFinite(video.currentTime) || Math.abs(video.currentTime) > 0.08)) {
    if (pending.seekRequested) { clearHlsStart(); handlePlaybackError(); return; }
    const ranges = video.seekable;
    if (!ranges?.length) return;
    if (ranges.start(0) > 0 || ranges.end(0) <= 0) { clearHlsStart(); handlePlaybackError(); return; }
    pending.seekRequested = true;
    try { video.currentTime = 0; }
    catch { clearHlsStart(); handlePlaybackError(); }
    return;
  }
  clearHlsStart();
  if (state.playbackAutoplay) startLoadedPlayback(pending.requestId, pending.src, pending.start);
  else stopPausedHlsPreview();
}
function handlePlaybackError() {
  const video = $('replay-player'), bounds = state.playBounds;
  if (state.playFormat === 'hls' && state.hlsStopped) return;
  if (video.hidden || !bounds || !state.playFormat || (video.currentSrc && video.currentSrc !== video.src)) return;
  let currentFormat = '';
  try { currentFormat = new URL(video.currentSrc, location.href).searchParams.get('format') || ''; } catch {}
  if (currentFormat && currentFormat !== state.playFormat) return;
  if (state.playbackFormats.length) {
    setPlaybackNotice(state.playbackSource === 'dvr' ? '正在切换兼容预览…' : `${state.playFormat === 'mp4' ? '标准 MP4' : '分片 MP4'}不兼容，正在尝试另一种格式…`);
    loadPlaybackFormat(state.playRequestId, bounds.start, bounds.duration);
    return;
  }
  state.previewFailed = true; syncReplayToggle();
  setPlaybackNotice(state.playbackSource === 'dvr'
    ? state.previewMode === 'live' ? '实时预览失败，请检查设备连接或视频解码。' : '未能读取或解码 DVR 录像，请检查所选通道、录像时段和设备连接。'
    : 'MP4 与分片 MP4 都无法播放；可能是当前 Safari 设备不支持这段录像的编码或分辨率。', true);
}
function continueReplay() {
  const video = $('replay-player'), bounds = state.playBounds;
  if (state.holdSeek) return;
  syncReplayToggle();
  if (bounds?.sdkTimingUnknown) {
    if (video.ended) { state.playbackAutoplay = false; state.followPlayback = false; syncReplayToggle(); setPlaybackNotice(`本段结束，请重新选时间。${sdkPlaybackNotice()}`); }
    return;
  }
  if (state.previewMode === 'live') {
    if (!video.hidden && video.ended && video.currentSrc === video.src) { state.followPlayback = false; state.playbackAutoplay = false; setPlaybackNotice('直播已结束，点“回到直播”重连。'); }
    return;
  }
  if (state.pendingHlsStart || state.dragging || state.pendingLocalSeek || !bounds
    || !state.followPlayback || state.playbackAutoplay === false || video.hidden || video.error || !video.ended || video.currentSrc !== video.src) return;
  // MP4's edit list anchors t=0 to the requested start, including a leading GOP.
  // An unexpectedly shorter response must not make us skip the unplayed tail.
  const played = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(bounds.duration, video.duration) : bounds.duration;
  const next = Math.min(bounds.end, bounds.start + played * 1000);
  if (next <= bounds.start || next >= bounds.end) return;
  playAt(next).catch(error => setPlaybackNotice(error.message, true));
}
function setPlaybackNotice(value, error = false) { $('playback-notice').textContent = value; $('playback-notice').classList.toggle('error', error); }
async function toggleReplayPlayback() {
  if (state.previewMode === 'last-frame') { state.previewMode = 'replay'; state.lastFramePending = null; }
  const video = $('replay-player');
  if (video.hidden) return;
  if (video.paused || video.ended) {
    if (state.playFormat === 'hls' && state.hlsStopped && state.playBounds) return state.previewMode === 'live' ? startDvrLive() : playAt(state.cursorMs ?? state.playBounds.start);
    state.playbackAutoplay = true;
    if (state.pendingHlsStart) { finishHlsStart(); syncReplayToggle(); return; }
    try { await video.play(); setPlaybackNotice(state.playFormat === 'sdk' ? sdkPlaybackNotice() : state.previewMode === 'live' ? '' : '正在播放录像。'); }
    catch { if (video.error) handlePlaybackError(); else setPlaybackNotice('播放没有启动，请再点一次播放键。', true); }
  } else {
    if (state.playFormat === 'hls') { syncPlaybackCursor(); stopHlsPreview(); }
    state.playbackAutoplay = false; video.pause();
  }
  syncReplayToggle();
}
function timeAtTimeline(event, overview = false, clamp = true) {
  const rect = $(overview ? 'timeline-overview' : 'timeline').getBoundingClientRect();
  const rawRatio = (event.clientX - rect.left) / rect.width;
  const ratio = clamp ? Math.max(0, Math.min(1, rawRatio)) : rawRatio;
  if (overview) return dateStart(state.date) + ratio * 86_400_000;
  const window = timelineWindow();
  return window.start + ratio * window.span;
}
function updateTimelineHover(event) {
  const marker = $('timeline-hover');
  if (!marker) return;
  if (window.innerWidth < 1024 || event.pointerType !== 'mouse' || event.buttons || state.dragging) { marker.hidden = true; return; }
  const rect = $('timeline').getBoundingClientRect();
  if (!(rect.width > 0)) { marker.hidden = true; return; }
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  marker.hidden = false; marker.style.left = `${ratio * 100}%`;
  marker.dataset.edge = ratio < .15 ? 'start' : ratio > .85 ? 'end' : 'middle';
  marker.firstElementChild.textContent = wallTime(timeAtTimeline(event)).slice(11);
}
$('timeline').addEventListener('pointerdown', event => beginTimelineScrub(event, 'detail'));
$('timeline').addEventListener('pointermove', updateTimelineHover);
$('timeline').addEventListener('pointerleave', () => { $('timeline-hover').hidden = true; });
$('timeline').addEventListener('pointerdown', () => { $('timeline-hover').hidden = true; });

$('timeline').addEventListener('pointermove', event => moveTimelineScrub(event, 'detail'));
$('timeline').addEventListener('pointerup', event => endTimelineScrub(event, 'detail'));
$('timeline').addEventListener('pointercancel', cancelTimelineScrub);
$('timeline').addEventListener('lostpointercapture', cancelTimelineScrub);
setupPrecisionTimeline();
function setupPrecisionTimeline() {
  let snapshot = null;
  const finish = () => { state.dragging = false; state.dragSource = ''; document.body.classList.remove('precision-scrubbing'); fadeScrubTime(); };
  precisionTimeline = createPrecisionTimeline({
    element: $('timeline-overview'),
    getTime: () => state.segments.length ? state.cursorMs ?? dateStart(state.date) : NaN,
    getBounds: () => ({ start: dateStart(state.date), end: Math.min(timelineLimit(), dateStart(state.date) + 86_399_000) }),
    getContext: () => JSON.stringify([consoleSession, state.playbackSource, state.selectedCamera, $('dvr-select').value, $('dvr-channel').value, state.date]),
    onStart: () => {
      snapshot = { ...scrubSnapshot(), timelineSpanSeconds: state.timelineSpanSeconds };
      state.dragging = true; state.dragSource = 'overview';
      const video = $('replay-player'); if (!video.hidden && !video.paused) video.pause();
    },
    onMove: ({ time, span, distance }) => {
      state.cursorMs = clampTimelineCenter(time); state.timelineSpanSeconds = span / 1000;
      document.body.classList.toggle('precision-scrubbing', distance > 40);
      setTimelineWindow(state.cursorMs); showScrubTime(state.cursorMs);
    },
    onCommit: async time => {
      state.timelineSpanSeconds = snapshot?.timelineSpanSeconds ?? DEFAULT_TIMELINE_SPAN_SECONDS;
      snapshot = null; finish(); await jumpToTimelineTime(time, 'overview', { autoplay: false });
    },
    onCancel: ({ restore }) => {
      if (restore && snapshot) Object.assign(state, snapshot);
      else if (snapshot) state.timelineSpanSeconds = snapshot.timelineSpanSeconds;
      snapshot = null; finish(); if (restore) renderTimeline();
    },
    onError: error => setPlaybackNotice(error.message, true),
  });
  window.addEventListener('resize', () => precisionTimeline.cancel());
  for (const id of ['playback-source', 'camera-select', 'dvr-select', 'dvr-channel', 'date-select']) $(id).addEventListener('change', () => precisionTimeline.cancel({ restore: false }));
}
function showScrubTime(ms, context = '') {
  const overlay = $('scrub-time-overlay'), fullTime = wallTime(ms);
  $('scrub-time-value').textContent = fullTime.slice(11);
  $('scrub-date-value').textContent = fullTime.slice(0, 10);
  clearTimeout(state.scrubFadeTimer); overlay.classList.add('visible');
  const magnifier = $('trim-magnifier');
  document.body.classList.toggle('trimming', Boolean(state.dragBoundary));
  document.body.dataset.trimBoundary = state.dragBoundary || '';
  if (magnifier) {
    magnifier.hidden = !state.dragBoundary;
    if (state.dragBoundary) {
      const rect = $('timeline').getBoundingClientRect();
      magnifier.style.left = `${Math.max(60, Math.min(window.innerWidth - 60, rect.left + timelinePercent(ms, timelineWindow().start, timelineWindow().span) / 100 * rect.width))}px`;
      magnifier.style.top = `${Math.max(8, rect.top - 124)}px`;
      $('trim-magnifier-time').textContent = boundaryLabel(ms);
      magnifier.style.setProperty('--trim-second', String(Math.round(ms / 1000) % 10));
      const seconds = $('trim-magnifier-seconds');
      if (seconds) seconds.textContent = [-4, -2, 0, 2, 4].map(offset => String((Math.round(ms / 1000) + offset + 60) % 60).padStart(2, '0')).join('  ');
    }
  }
}
function fadeScrubTime() {
  document.body.classList.remove('trimming');
  const magnifier = $('trim-magnifier'); if (magnifier) magnifier.hidden = true;
  clearTimeout(state.scrubFadeTimer);
  state.scrubFadeTimer = setTimeout(() => $('scrub-time-overlay').classList.remove('visible'), 420);
}
function scrubSnapshot() {
  return { cursorMs: state.cursorMs, inMs: state.inMs, outMs: state.outMs, timelineStartMs: state.timelineStartMs };
}
function beginTimelineScrub(event, source) {
  if (event.isPrimary === false || !state.segments.length || state.dragging || state.pendingScrub || (event.button !== undefined && event.button !== 0)) return;
  const boundary = event.target?.closest?.('[data-boundary]')?.dataset.boundary || '';
  const markedTime = state[boundary === 'in' ? 'inMs' : 'outMs'];
  const offsetMs = boundary && markedTime !== null ? timeAtTimeline(event, source === 'overview', false) - markedTime : 0;
  const view = timelineWindow(), center = view.start + view.span / 2;
  const overviewPoint = source === 'overview' ? timeAtTimeline(event, true, false) : center;
  const anchorCenter = source === 'overview' && (overviewPoint < view.start || overviewPoint > view.end) ? overviewPoint : center;
  const width = event.currentTarget.getBoundingClientRect?.().width || $(source === 'overview' ? 'timeline-overview' : 'timeline').getBoundingClientRect().width;
  const gesture = { anchorCenter, width, pointerId: event.pointerId, source, boundary, autoplay: !$('replay-player').hidden && !$('replay-player').paused, offsetMs, x: event.clientX, y: event.clientY, snapshot: scrubSnapshot() };
  if (event.pointerType === 'touch' || source === 'detail' && !boundary) { state.pendingScrub = gesture; return; }
  activateTimelineScrub(event, gesture);
}
function activateTimelineScrub(event, gesture) {
  state.pendingScrub = null; state.dragAutoplay = gesture.autoplay; state.dragging = true; state.dragSource = gesture.source; state.dragBoundary = gesture.boundary; state.dragPointerId = gesture.pointerId; state.scrubSnapshot = gesture.snapshot; state.dragOffsetMs = gesture.offsetMs; state.dragTarget = event.currentTarget; state.dragOriginX = gesture.x; state.dragOriginY = gesture.y; state.dragMoved = false; state.dragAnchorCenter = gesture.anchorCenter; state.dragWidth = gesture.width;
  const video = $('replay-player'); if (!video.hidden && !video.paused) video.pause();
  // A touch tap activates on pointerup, when capture may already be unavailable.
  if (event.type !== 'pointerup') { try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch {} }
  moveTimelineScrub(event, gesture.source);
}
function clampBoundaryTime(ms, boundary, inMs = state.inMs, outMs = state.outMs) {
  const day = dateStart(state.date), second = Math.round(ms / 1000) * 1000;
  const limit = timelineLimit();
  const minimum = boundary === 'out' && inMs !== null ? inMs + 1000 : day;
  const maximum = Math.min(limit, boundary === 'in' ? (outMs !== null ? outMs - 1000 : day + 86_399_000) : day + 86_400_000);
  return Math.max(day, Math.min(maximum, Math.max(minimum, second)));
}
function moveTimelineScrub(event, source) {
  const pending = state.pendingScrub;
  if (pending && pending.pointerId === event.pointerId && pending.source === source) {
    const dx = Math.abs(event.clientX - pending.x), dy = Math.abs(event.clientY - pending.y);
    if (dy > 8 && dy > dx) { state.pendingScrub = null; return; }
    if (dx < 8) return;
    activateTimelineScrub(event, pending); return;
  }
  if (!state.dragging || state.dragPointerId !== event.pointerId || state.dragSource !== source) return;
  state.dragClientX = event.clientX;
  if (Math.abs(event.clientX - state.dragOriginX) >= 8) state.dragMoved = true;
  const rawPoint = timeAtTimeline(event, source === 'overview', false) - (state.dragOffsetMs || 0);
  const window = source === 'overview' ? { start: dateStart(state.date), end: dateStart(state.date) + 86_400_000 } : timelineWindow();
  const point = Math.max(window.start, Math.min(window.end, timelineLimit(), rawPoint));
  if (state.dragBoundary) {
    const boundary = state.dragBoundary, ms = clampBoundaryTime(point, boundary);
    state[boundary === 'in' ? 'inMs' : 'outMs'] = ms; state.cursorMs = Math.min(ms, timelineLimit(), dateStart(state.date) + 86_399_999);
    updateCursor(); updateSelection(); showScrubTime(ms, boundary === 'in' ? '调整开始时间' : '调整结束时间');
  } else {
    // Move the window, never the needle: detail follows the dragged content,
    // overview follows the grabbed hour box without snapping its centre to a finger.
    const delta = (event.clientX - state.dragOriginX) / state.dragWidth;
    const center = state.dragAnchorCenter + delta * (source === 'overview' ? 86_400_000 : -timelineWindow().span);
    state.cursorMs = clampTimelineCenter(Math.round(center / 1000) * 1000);
    setTimelineWindow(state.cursorMs);
    showScrubTime(state.cursorMs);
  }
  if (source === 'detail' && state.dragBoundary && state.dragMoved && event.type !== 'pointerup') scheduleTimelinePan();
  event.preventDefault();
}
// The held pointer stays at the same timestamp-to-pixel mapping as the window moves.
// No video requests occur on animation frames: release commits exactly one seek.
function timelinePanVelocity(clientX, rect) {
  const edge = Math.min(64, rect.width * 0.12);
  const x = clientX - rect.left;
  const strength = x < edge ? -Math.min(1, (edge - x) / edge) : x > rect.width - edge ? Math.min(1, (x - rect.width + edge) / edge) : 0;
  // Up to a tenth of the visible window per second, scaled with the zoom level.
  return strength * Math.abs(strength) * timelineWindow().span / 10;
}
function stopTimelinePan() {
  if (state.panFrame != null) cancelAnimationFrame(state.panFrame);
  state.panFrame = null; state.panLastTime = null;
}
function scheduleTimelinePan() {
  if (state.panFrame != null || !state.dragging || state.dragSource !== 'detail' || !state.dragMoved || !state.dragBoundary) return;
  const velocity = timelinePanVelocity(state.dragClientX, $('timeline').getBoundingClientRect());
  if (!velocity) { state.panLastTime = null; return; }
  state.panFrame = requestAnimationFrame(advanceTimelinePan);
}
function advanceTimelinePan(now) {
  state.panFrame = null;
  if (!state.dragging || state.dragSource !== 'detail' || document.hidden) { stopTimelinePan(); return; }
  const elapsed = state.panLastTime == null ? 0 : Math.max(0, Math.min(50, now - state.panLastTime));
  state.panLastTime = now;
  const velocity = timelinePanVelocity(state.dragClientX, $('timeline').getBoundingClientRect());
  const window = timelineWindow(), day = dateStart(state.date);
  const start = Math.max(day, Math.min(Math.max(day, timelineLimit() - window.span), window.start + velocity * elapsed / 1000));
  // Do not scroll a constrained marker away past its opposite endpoint.
  const blocked = state.dragBoundary === 'in' && velocity > 0 && state.outMs !== null && state.inMs >= state.outMs - 1000
    || state.dragBoundary === 'out' && velocity < 0 && state.inMs !== null && state.outMs <= state.inMs + 1000;
  if (blocked || !velocity || elapsed && start === window.start) { stopTimelinePan(); return; }
  if (start !== window.start) {
    state.timelineStartMs = start;
    moveTimelineScrub({ clientX: state.dragClientX, pointerId: state.dragPointerId, type: 'panframe', preventDefault() {} }, 'detail');
    renderTimeline();
  }
  scheduleTimelinePan();
}
async function endTimelineScrub(event, source) {
  const pending = state.pendingScrub;
  if (pending && pending.pointerId === event.pointerId && pending.source === source) {
    const dx = Math.abs(event.clientX - pending.x), dy = Math.abs(event.clientY - pending.y);
    if (dy > 8 && dy > dx || source === 'detail' && !pending.boundary && dx < 8) { state.pendingScrub = null; return; }
    activateTimelineScrub(event, pending);
  }
  if (!state.dragging || state.dragPointerId !== event.pointerId || state.dragSource !== source) return;
  stopTimelinePan();
  // Release must not re-read pointerup coordinates: the last pointermove is what the user saw.
  moveTimelineScrub({ clientX: state.dragClientX ?? event.clientX, pointerId: event.pointerId, type: 'pointerup', preventDefault() {} }, source);
  const time = state.cursorMs, targetSource = state.dragSource, autoplay = state.dragBoundary ? state.dragAutoplay : true;
  state.dragging = false; state.dragSource = ''; state.dragBoundary = ''; state.dragPointerId = null; state.scrubSnapshot = null; state.dragOffsetMs = 0; state.dragTarget = null;
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  fadeScrubTime();
  try { await jumpToTimelineTime(time, targetSource, { autoplay }); } catch (error) { setPlaybackNotice(error.message, true); }
  event.preventDefault();
}
function cancelTimelineScrub(event) {
  // Transferring touch capture from a child handle emits a bubbling loss there.
  // Only loss of the timeline's own capture cancels the active drag.
  if (event.type === 'lostpointercapture' && event.target !== state.dragTarget) return;
  if (state.pendingScrub?.pointerId === event.pointerId) state.pendingScrub = null;
  if (!state.dragging || state.dragPointerId !== event.pointerId) return;
  stopTimelinePan();
  const target = state.dragTarget;
  if (state.scrubSnapshot) Object.assign(state, state.scrubSnapshot);
  state.dragging = false; state.dragSource = ''; state.dragBoundary = ''; state.dragPointerId = null; state.scrubSnapshot = null; state.dragOffsetMs = 0; state.dragTarget = null;
  if (target?.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
  renderTimeline(); fadeScrubTime(); setPlaybackNotice('已取消调整，保留原来的时间。');
}
function jumpToTimelineTime(ms, source = 'detail', options = {}) {
  const day = dateStart(state.date);
  debugMark('jump-start', { ms, source, jumpInFlight: state.jumpInFlight || 0 });
  ms = Math.max(day, Math.min(timelineLimit(), day + 86_400_000 - 1, ms));
  state.cursorMs = ms;
  setTimelineWindow(ms);
  const hasRecording = state.segments.some(segment => { const bounds = segmentBounds(segment); return ms >= bounds.start && ms < bounds.end; });
  if (hasRecording) {
    const playing = playAt(ms, options);
    if (playing && typeof playing.then === 'function') {
      state.jumpInFlight = (state.jumpInFlight || 0) + 1;
      const settle = () => { state.jumpInFlight--; debugMark('jump-settled', { ms }); };
      playing.then(settle, settle);
    }
    return playing;
  }
  debugMark('jump-no-recording', { ms });
  clearReplay(); setPlaybackNotice('这个时间点没有录像。', true);
}
function stepReplay(seconds) {
  if (state.previewMode === 'live') return;
  if (!state.date || !state.segments.length) return;
  syncPlaybackCursor();
  const video = $('replay-player'), autoplay = !video.hidden && (!video.paused || state.playbackAutoplay === true && !state.followPlayback);
  const day = dateStart(state.date), current = state.cursorMs ?? day;
  const next = Math.max(day, Math.min(day + 86_400_000 - 1, current + seconds * 1000));
  showScrubTime(next, `${seconds < 0 ? '后退' : '前进'} ${Math.abs(seconds)} 秒`); fadeScrubTime();
  if (tryBufferedReplaySeek(next, autoplay)) return;
  Promise.resolve(jumpToTimelineTime(next, 'detail', { autoplay })).catch(error => setPlaybackNotice(error.message, true));
}
function beginReplayHold() {
  if (state.previewMode === 'live' || !state.date || !state.segments.length) return null;
  syncPlaybackCursor();
  state.lastFramePending = null;
  if (state.previewMode === 'last-frame') state.previewMode = 'replay';
  const video = $('replay-player');
  const hold = { context: playbackContextKey(), requestId: state.playRequestId,
    cursorMs: state.cursorMs, timelineStartMs: state.timelineStartMs, targetMs: state.cursorMs ?? dateStart(state.date),
    autoplay: !video.hidden && (!video.paused || state.playbackAutoplay === true && !state.followPlayback) };
  state.holdSeek = hold;
  return hold;
}
function repeatReplayHold(hold, seconds) {
  if (!hold || state.holdSeek !== hold) return;
  if (hold.context !== playbackContextKey() || hold.requestId !== state.playRequestId) { cancelReplayHold(); return; }
  const day = dateStart(state.date);
  hold.targetMs = Math.max(day, Math.min(timelineLimit(), day + 86400000 - 1, hold.targetMs + seconds * 1000));
  state.cursorMs = hold.targetMs;
  setTimelineWindow(hold.targetMs);
  showScrubTime(hold.targetMs, seconds < 0 ? '连续后退' : '连续前进');
}
function commitReplayHold(hold) {
  if (!hold || state.holdSeek !== hold) return;
  state.holdSeek = null; fadeScrubTime();
  if (hold.context !== playbackContextKey() || hold.requestId !== state.playRequestId || document.body.dataset.view !== 'replay') return;
  if (tryBufferedReplaySeek(hold.targetMs, hold.autoplay)) return;
  Promise.resolve(jumpToTimelineTime(hold.targetMs, 'detail', { autoplay: hold.autoplay })).catch(error => setPlaybackNotice(error.message, true));
}
function abandonReplayHold(hold) {
  if (!hold || state.holdSeek !== hold) return;
  state.holdSeek = null;
  if (hold.context === playbackContextKey() && hold.requestId === state.playRequestId) {
    state.cursorMs = hold.cursorMs; state.timelineStartMs = hold.timelineStartMs; renderTimeline(); syncPlaybackCursor();
  }
  fadeScrubTime();
}
function cancelReplayHold() {
  for (const control of replayHoldButtons) control.cancel('playback-changed');
}
function tryBufferedReplaySeek(ms, autoplay) {
  const video = $('replay-player'), bounds = state.playBounds;
  if (state.playbackSource !== 'mediamtx' || !bounds || bounds.camera !== state.selectedCamera || bounds.date !== state.date
    || video.hidden || video.error || video.readyState < 2 || video.currentSrc !== video.src || bounds.src !== video.src
    || autoplay && (video.paused || !state.followPlayback && !state.pendingLocalSeek)) return false;
  const offset = (ms - bounds.start) / 1000;
  if (offset < 0 || offset >= bounds.duration || Number.isFinite(video.duration) && offset >= video.duration) return false;
  const contains = ranges => {
    for (let index = 0; index < (ranges?.length || 0); index++) if (offset >= ranges.start(index) && offset < ranges.end(index)) return true;
    return false;
  };
  if (state.playBounds?.sdkTimingUnknown) return false;
  const previousFollow = state.followPlayback, previousSeek = state.pendingLocalSeek;
  try {
    // Both are required: a seekable-but-unbuffered jump can restart a range
    // request/decoder, defeating this fast path and its exact clock mapping.
    if (!contains(video.buffered) || !contains(video.seekable)) return false;
    if (!video.seeking && Math.abs(video.currentTime - offset) < 0.001) {
      state.cursorMs = ms; state.playbackAutoplay = autoplay; updateCursor(); return true;
    }
    state.pendingLocalSeek = { requestId: state.playRequestId, src: video.src, camera: state.selectedCamera, date: state.date, ms, offset, autoplay };
    state.followPlayback = false;
    video.currentTime = offset;
  } catch { state.pendingLocalSeek = previousSeek; state.followPlayback = previousFollow; return false; }
  state.cursorMs = ms; state.playbackAutoplay = autoplay;
  if (!autoplay) video.pause();
  const view = timelineWindow();
  if (ms < view.start || ms > view.end) setTimelineWindow(ms); else updateCursor();
  syncReplayToggle();
  return true;
}
function finishBufferedReplaySeek() {
  const pending = state.pendingLocalSeek, video = $('replay-player');
  if (!pending || pending.requestId !== state.playRequestId || pending.src !== video.src || video.currentSrc !== video.src || video.seeking) return;
  state.pendingLocalSeek = null;
  if (state.playbackSource !== 'mediamtx' || pending.camera !== state.selectedCamera || pending.date !== state.date) return;
  if (state.holdSeek) {
    state.followPlayback = !video.error && Math.abs(video.currentTime - pending.offset) <= 0.25;
    return;
  }
  if (video.error || Math.abs(video.currentTime - pending.offset) > 0.25) {
    // A browser that cannot settle at the requested point uses the existing
    // source-loading path rather than displaying a falsely precise timestamp.
    Promise.resolve(playAt(pending.ms, { autoplay: state.playbackAutoplay === true })).catch(error => setPlaybackNotice(error.message, true));
    return;
  }
  state.followPlayback = true; state.cursorMs = pending.ms; updateCursor();
}
// Lifecycle interruption must never commit a preview or leave an animation running.
function interruptTimelineScrub() {
  precisionTimeline?.cancel();
  state.pendingScrub = null;
  if (state.dragging) cancelTimelineScrub({ pointerId: state.dragPointerId });
  else stopTimelinePan();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) interruptTimelineScrub(); });
window.addEventListener('blur', interruptTimelineScrub);
window.addEventListener('pagehide', () => { cancelReplayHold(); if (state.mediaLive) clearReplay(); else stopHlsPreview(); });
$('timeline').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || state.cursorMs === null) return;
  if (event.target !== $('timeline')) return;
  event.preventDefault(); if (event.repeat) return; const amount = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1); stepReplay(amount);
});
$('timeline-overview').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || state.cursorMs === null) return;
  event.preventDefault(); if (event.repeat) return; jumpToTimelineTime(state.cursorMs + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10_000 : 1000), 'overview');
});
$('go-live').addEventListener('click', startLive);
$('playback-toggle').addEventListener('click', toggleReplayPlayback);
$('transport-toggle').addEventListener('click', toggleTransportPlayback);
$('fine-back').addEventListener('click', () => stepReplay(-1));
$('fine-forward').addEventListener('click', () => stepReplay(1));
$('playback-mute').addEventListener('click', toggleReplayMute);
$('replay-player').addEventListener('volumechange', syncReplayMute);
for (const event of ['loadeddata', 'canplay', 'ended', 'emptied']) $('replay-player').addEventListener(event, syncPlaybackStatus);
$('replay-player').addEventListener('pause', () => { state.playbackWaiting = false; syncPlaybackStatus(); });
$('replay-player').addEventListener('waiting', () => { const video = $('replay-player'); if (!video.hidden && video.currentSrc === video.src && !video.paused && video.readyState < 3) state.playbackWaiting = true; syncPlaybackStatus(); });
$('replay-player').addEventListener('canplay', () => { const video = $('replay-player'); if (video.currentSrc === video.src && video.readyState >= 3) state.playbackWaiting = false; syncPlaybackStatus(); });
for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) $('replay-player').addEventListener(event, finishLastRecordingFrame);
$('replay-player').addEventListener('loadeddata', finishHlsStart);
$('replay-player').addEventListener('canplay', finishHlsStart);
$('replay-player').addEventListener('progress', finishHlsStart);
$('replay-player').addEventListener('durationchange', finishHlsStart);
$('replay-player').addEventListener('seeked', finishHlsStart);
$('replay-player').addEventListener('loadeddata', stopPausedHlsPreview);
$('replay-player').addEventListener('play', syncReplayToggle);
$('replay-player').addEventListener('playing', () => {
  const video = $('replay-player');
  if (!state.pendingHlsStart && !(state.playFormat === 'hls' && state.hlsStopped) && !video.hidden && !video.paused && !video.error && video.readyState >= 2 && video.currentSrc === video.src) { state.followPlayback = true; state.playbackWaiting = false; state.previewFailed = false; }
  syncPlaybackStatus();
});
$('replay-player').addEventListener('pause', syncReplayToggle);
$('replay-player').addEventListener('ended', continueReplay);
$('replay-player').addEventListener('seeked', finishBufferedReplaySeek);
$('replay-player').addEventListener('emptied', syncReplayToggle);
$('replay-player').addEventListener('error', () => {
  if ($('replay-player').error) handlePlaybackError();
});
for (const boundary of ['in', 'out']) {
  $(`edit-${boundary}`).addEventListener('click', () => openBoundaryEditor(boundary));
  $(`boundary-${boundary}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
    const key = boundary === 'in' ? 'inMs' : 'outMs'; if (state[key] === null) return;
    state[key] = clampBoundaryTime(state[key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10000 : 1000), boundary); updateSelection(); showScrubTime(state[key], boundary === 'in' ? '开始时间' : '结束时间'); fadeScrubTime();
  });
}
function syncPlaybackCursor() {
  const video = $('replay-player'), bounds = state.playBounds;
  // A picked time remains authoritative while a new stream is loading or fails.
  // Only a stream that actually started playing may advance the shared cursor.
  if (bounds?.sdkTimingUnknown || state.pendingHlsStart || state.previewMode === 'live' || (state.playFormat === 'hls' && state.hlsStopped) || state.dragging || state.holdSeek || state.pendingScrub || state.pendingLocalSeek || !state.followPlayback || !bounds || video.hidden || video.error || video.seeking || video.readyState < 2 || video.currentSrc !== video.src || !Number.isFinite(video.currentTime)) return;
  state.cursorMs = Math.min(bounds.start + Math.max(0, video.currentTime) * 1000, bounds.start + bounds.duration * 1000, dateStart(state.date) + 86400000);
  // Natural playback scrolls the hour under the fixed centre needle.
  const start = clampTimelineCenter(state.cursorMs) - timelineWindow().span / 2;
  if (state.timelineStartMs !== start) { state.timelineStartMs = start; renderTimeline(); }
  else updateCursor();
}
// Diagnostic for the double-tap-to-mark report. Enable with ?debugMark=1, localStorage.debugMark = '1',
// or five quick taps on the 选中片段 heading (works in a standalone PWA); output also goes to an on-screen panel.
function debugMark(event, detail = {}) {
  if (typeof document === 'undefined' || !document.getElementById('debug-mark-panel')) return;
  const fields = ['id', 'disabled', 'dragging', 'pendingScrub', 'boundary', 'inMs', 'outMs', 'followPlayback', 'ms', 'source', 'point', 'other', 'jumpInFlight'];
  const safeDetail = Object.fromEntries(Object.entries(detail).filter(([key]) => fields.includes(key)));
  const line = JSON.stringify({ event, t: Date.now() % 100000, cursorMs: state.cursorMs, jumpInFlight: state.jumpInFlight || 0, ...safeDetail });
  console.log('[debugMark]', line);
  const panel = document.getElementById('debug-mark-log');
  if (panel) panel.textContent = [line, ...panel.textContent.split('\n')].slice(0, 16).join('\n');
}
function markPlaybackBoundary(boundary) {
  debugMark('mark-click', { boundary, inMs: state.inMs, outMs: state.outMs, dragging: state.dragging, pendingScrub: Boolean(state.pendingScrub), followPlayback: state.followPlayback });
  if (state.playBounds?.sdkTimingUnknown) { setPlaybackNotice('SDK 无法按当前帧标记，请手填导出时间。', true); return; }
  if (state.previewMode === 'live') return;
  syncPlaybackCursor();
  const current = state.cursorMs;
  if (current === null || !Number.isFinite(current)) return;
  const point = Math.max(dateStart(state.date), Math.min(dateStart(state.date) + 86400000, Math.round(current / 1000) * 1000));
  if (boundary === 'in') {
    if (state.outMs !== null && point >= state.outMs) { debugMark('mark-rejected', { boundary, point, other: state.outMs }); notify('入点必须早于已有出点；原选段已保留。重新选段可先点「清除标记」。', true); return; }
    state.inMs = point;
  }
  else { if (state.inMs !== null && point <= state.inMs) { debugMark('mark-rejected', { boundary, point, other: state.inMs }); notify('结束点须晚于开始点，请在时间轴选择更晚的位置，或手动输入时间。', true); return; } state.outMs = point; }
  const view = timelineWindow();
  if (point < view.start || point > view.end) setTimelineWindow(point);
  debugMark('mark-applied', { boundary, point });
  $(`mark-${boundary}`).classList.add('active'); updateSelection();
}
$('mark-in').addEventListener('click', () => markPlaybackBoundary('in'));
$('mark-out').addEventListener('click', () => markPlaybackBoundary('out'));
$('clear-marks').addEventListener('click', () => {
  if (state.dragging) cancelTimelineScrub({ pointerId: state.dragPointerId });
  state.pendingScrub = null; clearMarkedRange(); updateSelection();
});
function changeReplayDay(delta) {
  const date = new Date(`${$('date-select').value}T12:00:00Z`); if (!Number.isFinite(date.getTime())) return;
  date.setUTCDate(date.getUTCDate() + delta); const value = date.toISOString().slice(0, 10);
  if (value > today()) return;
  $('date-select').value = value; $('date-select').dispatchEvent(new Event('change', { bubbles: true }));
  $('next-day').disabled = value >= today();
}
$('previous-day').addEventListener('click', () => changeReplayDay(-1));
$('next-day').addEventListener('click', () => changeReplayDay(1));
$('skip-back').addEventListener('click', () => stepReplay(-10));
$('skip-forward').addEventListener('click', () => stepReplay(10));
for (const [id, seconds] of [['skip-back', -10], ['skip-forward', 10]]) {
  replayHoldButtons.push(bindPressRepeat($(id), { onStart: beginReplayHold,
    onRepeat: hold => repeatReplayHold(hold, seconds), onCommit: commitReplayHold, onCancel: abandonReplayHold }));
}
for (const id of ['date-select', 'playback-source', 'camera-select', 'dvr-select', 'dvr-channel']) {
  $(id).addEventListener('change', cancelReplayHold, true);
}
$('replay-player').addEventListener('timeupdate', syncPlaybackCursor);
document.addEventListener('keydown', event => {
  const target = event.target;
  if (activeDialog?.open || event.defaultPrevented) return;
  if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return;
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (document.body.dataset.view === 'library' && event.code === 'Slash') {
    event.preventDefault(); if (!event.repeat) $('output-search').focus(); return;
  }
  if (document.body.dataset.view !== 'replay') return;
  const step = ['Comma', 'ArrowLeft'].includes(event.code) ? -10 : ['Period', 'ArrowRight'].includes(event.code) ? 10 : 0;
  const playback = event.code === 'Space' && !$('replay-player').hidden;
  const shortcuts = { KeyI: 'mark-in', KeyO: 'mark-out', KeyF: 'replay-fullscreen', KeyM: 'playback-mute', Escape: 'clear-marks' };
  const button = shortcuts[event.code];
  const span = { Digit1: 30, Digit2: 300, Digit3: 3600, Digit4: 86400 }[event.code];
  if (!step && !playback && !button && !span) return;
  // One physical press produces one action; focused timeline handlers take precedence.
  event.preventDefault(); if (event.repeat) return;
  if (step) stepReplay(step);
  else if (playback) toggleReplayPlayback();
  else if (span) setTimelineSpan(span);
  else if (event.code === 'Escape' && (document.fullscreenElement || $('view-replay').classList?.contains('replay-expanded')
    || (typeof replayFullscreenPending !== 'undefined' && replayFullscreenPending))) void leaveReplayFullscreen();
  else if (button && !$(button).disabled) $(button).click();
});
$('export-range').addEventListener('click', async () => {
  if (state.busy || !hasPlaybackSelection() || state.inMs === null || state.outMs === null || state.outMs <= state.inMs) return;
  const selection = captureExportSelection(), coverage = selectedGapCoverage();
  if (coverage.missingIntervals.length) { confirmIncompleteExport(coverage, selection); return; }
  await submitExportSelection(selection);
});
$('selection-gap-warning').addEventListener('click', () => {
  if (state.busy || !hasPlaybackSelection()) return;
  const coverage = selectedGapCoverage();
  if (coverage.missingIntervals.length) confirmIncompleteExport(coverage, captureExportSelection());
});
$('cancel-export').addEventListener('click', () => cancelExportSubmission());

function captureExportSelection() {
  const source = state.playbackSource === 'dvr'
    ? { source: 'hikvision', deviceId: $('dvr-select').value, channel: $('dvr-channel').value, dvrMethod: 'auto' }
    : { source: 'mediamtx', camera: state.selectedCamera, mode: 'copy' };
  return { context: playbackContextKey(), inMs: state.inMs, outMs: state.outMs,
    payload: { ...source, start: wallTime(state.inMs), end: wallTime(state.outMs) } };
}
function isExportSelectionCurrent(selection) {
  return selection.context === playbackContextKey() && selection.inMs === state.inMs && selection.outMs === state.outMs;
}
function selectedGapCoverage() {
  const gaps = state.playbackSource === 'mediamtx' ? listCoverageGaps(state.segments, state.inMs, state.outMs) : [];
  return { missingSeconds: gaps.reduce((total, gap) => total + (gap.end - gap.start) / 1000, 0),
    missingIntervals: gaps.map(gap => ({ start: wallTime(gap.start), end: wallTime(gap.end) })) };
}
function cancelExportSubmission(silent = false) {
  if (!exportSubmission) return;
  exportSubmission.silent = silent;
  exportSubmission.controller.abort();
}
async function submitExportSelection(selection, acceptGaps = false) {
  if (state.busy) return false;
  if (!isExportSelectionCurrent(selection)) { notify('日期、通道或入出点已改变，请重新确认当前选段。', true); return false; }
  const button = $('export-range'), pending = { controller: new AbortController(), session: consoleSession, silent: false, timedOut: false };
  exportSubmission = pending;
  state.busy = true; button.disabled = true; button.textContent = '正在核验…'; updateSelection();
  const timer = setTimeout(() => { pending.timedOut = true; pending.controller.abort(); }, 20000);
  let newCoverage;
  try {
    const payload = { ...selection.payload, ...(acceptGaps ? { acceptGaps: true } : {}) };
    const result = await api('/console/api/export', { method: 'POST', body: body(payload), signal: pending.controller.signal });
    if (pending.session !== consoleSession) return false;
    rememberSubmittedTask('exports', result.taskId);
    notify(result.reused ? '已复用录像' : acceptGaps ? '已提交，跳过录像中断' : '已提交导出', false,
      { icon: 'download', kind: 'exports', range: payload.start.slice(11) + ' → ' + payload.end.slice(11) });
    flashSubmitted(button); refreshState().catch(() => {});
    return true;
  } catch (error) {
    if (pending.session !== consoleSession || pending.silent) return false;
    if (pending.controller.signal.aborted) {
      notify(pending.timedOut ? '录像核验超时，请查看任务状态后重试。' : '已停止等待提交结果；已创建的任务可在任务页取消。', pending.timedOut);
      refreshState().catch(() => {});
    } else if (error.code === 'MEDIAMTX_GAPS') {
      if (isExportSelectionCurrent(selection) && document.body.dataset.view === 'replay') newCoverage = error.coverage;
      else notify('该选段含录像中断，请返回回放页查看并确认。', true);
    } else notify(error.code === 'MEDIAMTX_EMPTY' ? '所选时间没有可导出的 MediaMTX 录像，请更换时间或录像来源。' : error.message, true);
  } finally {
    clearTimeout(timer);
    if (exportSubmission === pending) exportSubmission = null;
    state.busy = false;
    if (!button.classList.contains('submitted')) setButtonIcon(button, 'download', '导出选中片段');
    updateSelection();
  }
  if (newCoverage) confirmIncompleteExport(newCoverage, selection);
  return false;
}
function flashSubmitted(button, icon = 'download', label = '导出选中片段') {
  clearTimeout(button.submittedTimer); setButtonIcon(button, 'check', '已提交'); button.classList.add('submitted');
  button.submittedTimer = setTimeout(() => { button.classList.remove('submitted'); setButtonIcon(button, icon, label); }, 1200);
}
function confirmIncompleteExport(coverage, selection) {
  const intervals = coverage?.missingIntervals || [];
  const sheet = openDialog('选段含录像中断', '以下时间没有录像。继续导出将跳过这些部分，只保留已有画面。', { trackChanges: false });
  const list = document.createElement('div'); list.className = 'gap-intervals'; list.setAttribute('aria-label', '录像中断时间范围');
  for (const interval of intervals) {
    const row = document.createElement('p');
    row.textContent = interval.start + ' → ' + interval.end;
    list.append(row);
  }
  sheet.content.append(list);
  addButton(sheet.actions, '取消', 'quiet-button', () => sheet.close());
  addButton(sheet.actions, '接受中断并导出', 'primary-button', async () => {
    if (!isExportSelectionCurrent(selection)) { sheet.error.textContent = '日期、通道或入出点已改变，请关闭后重新确认。'; return; }
    if (state.busy) return;
    sheet.close();
    await submitExportSelection(selection, true);
  });
}

function prettyBytes(value) {
  const size = Number(value) || 0; if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`; if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`; if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`; return `${size} B`;
}
function addButton(parent, label, className, action) { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', action); parent.append(button); return button; }
function addSettingsRefresh(parent, sheet, action, label, successMessage) {
  const status = document.createElement('p'); status.className = 'settings-refresh-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); sheet.content.append(status);
  const button = setButtonIcon(addButton(parent, '', 'quiet-button ui-icon-button', async () => {
    if (button.disabled) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true'); sheet.error.textContent = '';
    status.className = 'settings-refresh-status'; status.setAttribute('role', 'status'); status.textContent = '正在刷新…';
    try { await action(); status.textContent = successMessage; }
    catch (error) { status.className = 'settings-refresh-status error'; status.setAttribute('role', 'alert'); status.textContent = error.message; }
    finally { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
  }), 'refresh', label);
  return button;
}
function addOutputIconButton(parent, label, kind, action) {
  return setButtonIcon(addButton(parent, '', `quiet-button ui-icon-button output-icon-button output-${kind}`, action), kind, label);
}
function updateOutputSort() {
  const oldest = state.outputSort === 'oldest';
  const button = $('output-sort'); button.dataset.order = oldest ? 'oldest' : 'newest';
  setButtonIcon(button, oldest ? 'sort-oldest' : 'sort-newest', oldest ? '成片排序：最早在前，点击切换为最新在前' : '成片排序：最新在前，点击切换为最早在前');
}
function toggleOutputSort() {
  state.outputSort = state.outputSort === 'oldest' ? 'newest' : 'oldest';
  updateOutputSort(); renderOutputs();
}
function renderOutputs() {
  outputDetail?.update(state.outputs.find(file => file.id === outputDetail.id));
  const list = $('output-list'); $('output-count').textContent = String(state.outputs.length);
  const count = state.outputs.length, bytes = state.outputs.reduce((sum, file) => sum + Number(file.size || 0), 0);
  $('library-summary').textContent = `${count} 个视频`; $('library-size').textContent = prettyBytes(bytes);
  const query = ($('output-search')?.value || '').trim().toLocaleLowerCase();
  const oldestFirst = state.outputSort === 'oldest';
  const visible = state.outputs.filter(file => file.filename.toLocaleLowerCase().includes(query)).sort((a, b) => (new Date(b.modifiedAt) - new Date(a.modifiedAt)) * (oldestFirst ? -1 : 1));
  outputPlayers.retain(visible.map(file => file.id));
  const keep = new Set(visible.map(file => file.id));
  for (const [id, card] of outputCards) if (!keep.has(id)) { card.remove(); outputCards.delete(id); }
  if (!outputFeed) {
    list.replaceChildren();
    outputFeed = createCollectionFeed({ list, scroller: $('library-scroll'), sentinel: $('output-sentinel'), document,
      groupDates: false, decorateTime: false, compare: () => 0, makeCard: makeOutputCard,
      emptyText: '没有匹配的成片', isVisible: () => document.body.dataset.view === 'library' });
  }
  const filter = `${query}:${state.outputSort}`;
  if (outputFilter !== filter) { outputFeed.reset(); outputFilter = filter; }
  // A session reset or obsolete shell must not retain duplicate cards.
  if (!outputCards.size && list.children.length) outputFeed.clear();
  for (const node of [...list.children]) if (node.className === 'output-card' && ![...outputCards.values()].includes(node)) node.remove();
  outputFeed.update(visible);
}
function makeOutputCard(file) {
    let card = outputCards.get(file.id);
    if (!card) {
      card = document.createElement('article'); card.className = 'output-card';
      const top = document.createElement('div'); top.className = 'output-top'; const copy = document.createElement('div'); copy.className = 'output-copy';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'output-name'; name.addEventListener('click', () => openOutputDetails(card.outputFile)); copy.append(name);
      const meta = document.createElement('div'); meta.className = 'output-meta'; copy.append(meta);
      const statuses = document.createElement('div'); statuses.className = 'output-upload-statuses'; copy.append(statuses); top.append(copy);
      const pill = document.createElement('span'); pill.className = 'tag-pill'; top.append(pill);
      const actions = document.createElement('div'); actions.className = 'output-actions';
      const rename = addButton(actions, '改名', 'quiet-button', () => renameOutput(card.outputFile));
      const recoverUpload = addButton(actions, '处理上传记录', 'secondary-button', () => navigate('tasks'));
      const recoverRename = addButton(actions, '恢复改名', 'secondary-button', () => recoverOutputRename(card.outputFile));
      const uploadButton = addOutputIconButton(actions, '上传成片', 'upload', () => {
        const current = card.outputFile, sheet = openDialog('上传成片', current.filename);
        for (const [provider, label, enabled] of [['bilibili', '上传到哔哩哔哩', window.consoleIntegrations?.bilibiliEnabled], ['cloud189', '上传到天翼云盘', window.consoleIntegrations?.cloud189Enabled]]) {
          addButton(sheet.content, enabled ? label : `${label} · 去配置`, 'choice-option', () => { sheet.close(); if (enabled) upload(current, provider, uploadButton); else navigateToUploadSettings(provider); }).disabled = current.busy && !(provider === 'bilibili' && current.busyReason === 'verification');
        }
      });
      const download = createOutputDownload({ file, document, resolveUrl: appPath, openDialog: (...args) => openDialog(...args), onNotice: message => notify(message) });
      actions.append(download.element);
      addOutputIconButton(actions, '更多操作', 'more', () => {
        if (window.matchMedia?.('(max-width: 1023px)').matches) { openOutputDetails(card.outputFile); return; }
        const current = card.outputFile, sheet = openDialog('成片操作', current.filename);
        addButton(sheet.content, '删除成片', 'danger-button', () => { sheet.close(); confirmAction('删除成片？', `“${current.filename}”将永久删除，无法撤销。`, '永久删除', async () => { await api(`/console/api/outputs/${current.id}`, { method: 'DELETE' }); await refreshOutputs(); notify('成片已删除。'); }); }).disabled = current.busy;
      });
      card.append(outputPlayers.get(file), top, actions); card.outputRefs = { name, meta, statuses, pill, rename, recoverRename, recoverUpload, download }; outputCards.set(file.id, card);
    } else outputPlayers.get(file);
    card.outputFile = file;
    const { name, meta, statuses, pill, rename, recoverRename, recoverUpload, download } = card.outputRefs;
    renderOutputUploadStates(statuses, file, true);
    download.update(file);
    name.textContent = file.filename; name.title = file.filename; name.setAttribute('aria-label', `打开成片详情：${file.filename}`); meta.textContent = `${prettyBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    recoverRename.hidden = !file.renamePending;
    recoverUpload.hidden = file.busyReason !== 'verification';
    pill.textContent = file.renamePending ? '改名待恢复' : file.busyReason === 'verification' ? '上传待核实' : file.busyReason === 'recovery' ? '正在核对' : file.busyReason === 'upload' ? '上传中' : file.busy ? '处理中' : 'MP4'; pill.classList.toggle('busy', Boolean(file.busy)); rename.disabled = Boolean(file.busy);
    return card;

}

function renderOutputUploadStates(parent, file, compact = false) {
  const signature = JSON.stringify(file.uploads || {});
  if (parent.dataset.signature === signature) return;
  parent.dataset.signature = signature; parent.replaceChildren();
  for (const [provider, label, icon] of [['cloud189', '189', 'cloud189'], ['bilibili', 'B站', 'tv']]) {
    const fact = file.uploads?.[provider];
    const status = fact?.status || 'unknown';
    const labels = { none: '无记录', draft: '未提交', queued: '排队中', uploading: '上传中', completed: '已上传', failed: '失败', unknown: '待核实' };
    const row = document.createElement('span'); row.className = 'output-upload-state'; row.dataset.status = status;
    row.title = `${label}：${fact ? labels[status] || labels.unknown : '状态未读取'}`;
    row.setAttribute('aria-label', row.title);
    row.innerHTML = iconSvg(icon, provider === 'cloud189' ? 'provider-wordmark' : '') + (['failed', 'unknown'].includes(status) ? iconSvg('warning') : '');
    if (!compact) { const text = document.createElement('span'); text.textContent = row.title; row.append(text); }
    if (status === 'uploading') {
      const progress = document.createElement('progress'); progress.max = 100;
      if (Number.isFinite(fact?.progress)) progress.value = Math.min(100, Math.max(0, fact.progress));
      progress.setAttribute('aria-label', `${label}上传进度`); row.append(progress);
    }
    parent.append(row);
  }
}
function openOutputDetails(file) {
  let current = state.outputs.find(item => item.id === file.id);
  if (!current) { notify('成片已变化，请刷新列表。', true); return; }
  const sheet = openDialog('成片详情', '', { trackChanges: false });
  sheet.dialog.classList.add('output-detail');
  const player = outputPlayers.get(current); sheet.content.append(player);
  sheet.dialog.addEventListener('close', () => {
    if (outputDetail?.sheet === sheet) outputDetail = null;
    // 迟到的旧 close 只能处置仍由旧 sheet 持有的播放器。
    if (player.parentNode !== sheet.content) return;
    outputPlayers.pause(current.id);
    const card = outputCards.get(current.id);
    if (card && !card.contains(player)) card.insertBefore(player, card.firstChild || card.children[0] || null);
  }, { once: true });
  const heading = document.createElement('div'); heading.className = 'output-detail-heading';
  const name = document.createElement('h3'); name.textContent = current.filename; heading.append(name);
  const rename = addOutputIconButton(heading, '修改成片名称', 'edit', () => renameOutput(current)); rename.disabled = Boolean(current.busy);
  sheet.content.append(heading);
  const meta = document.createElement('p'); meta.className = 'output-meta';
  meta.textContent = `${prettyBytes(current.size)} · ${new Date(current.modifiedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`; sheet.content.append(meta);
  const statuses = document.createElement('div'); statuses.className = 'output-detail-statuses'; renderOutputUploadStates(statuses, current); sheet.content.append(statuses);
  const recover = addButton(sheet.content, '恢复改名', 'secondary-button', () => recoverOutputRename(current));
  const verify = addButton(sheet.content, '处理待核实的上传记录', 'secondary-button', () => { sheet.close(); navigate('tasks'); });
  const actions = document.createElement('div'); actions.className = 'output-detail-actions'; sheet.content.append(actions);
  const download = createOutputDownload({ file: current, document, resolveUrl: appPath, openDialog, onNotice: notify }); actions.append(download.element);
  const uploadButtons = new Map();
  for (const [provider, label, icon, enabled] of [['cloud189', '上传到189', 'cloud189', window.consoleIntegrations?.cloud189Enabled], ['bilibili', '上传到B站', 'tv', window.consoleIntegrations?.bilibiliEnabled]]) {
    const button = addOutputIconButton(actions, enabled ? label : `${label}：先配置账号`, icon, () => {
      sheet.close(); if (enabled) upload(current, provider, button); else navigateToUploadSettings(provider);
    });
    uploadButtons.set(provider, button);
    button.disabled = current.uploads?.[provider]?.status === 'completed' || Boolean(current.busy && !(provider === 'bilibili' && current.busyReason === 'verification'));
  }
  const remove = addOutputIconButton(actions, '删除成片', 'trash', () => {
    sheet.close(); confirmAction('删除成片？', `“${current.filename}”将永久删除，无法撤销。`, '永久删除', async () => {
      await api(`/console/api/outputs/${current.id}`, { method: 'DELETE' }); await refreshOutputs(); notify('成片已删除。');
    });
  });
  remove.classList.add('danger-button'); remove.disabled = Boolean(current.busy);
  const detail = { id: current.id, sheet, close: () => sheet.close(), update(next) {
    if (!next) { sheet.close(); return; }
    current = next; name.textContent = current.filename; download.update(current);
    renderOutputUploadStates(statuses, current); rename.disabled = remove.disabled = Boolean(current.busy);
    recover.hidden = !current.renamePending; verify.hidden = current.busyReason !== 'verification';
    for (const [provider, button] of uploadButtons) button.disabled = current.uploads?.[provider]?.status === 'completed'
      || Boolean(current.busy && !(provider === 'bilibili' && current.busyReason === 'verification'));
  } };
  outputDetail = detail; detail.update(current);
}

function navigateToUploadSettings(provider) {
  navigate('settings');
  settingsDetails[provider]();
}
const pendingUploads = new Set();
async function upload(file, provider, triggerButton = null) {
  const label = provider === 'bilibili' ? '哔哩哔哩' : '天翼云盘';
  if (provider === 'cloud189' && !window.consoleSettings?.cloud189TargetPath) { notify('先到设置里填写 189 上传目录。', true); navigateToUploadSettings('cloud189'); return; }
  const key = `${file.id}:${provider}`;
  if (pendingUploads.has(key)) return;
  const destination = provider === 'bilibili' ? '体育运动 · 足球 · 仅自己可见；足球合集 · 标签足球 · 标题无前缀；使用已保存封面' : window.consoleSettings.cloud189TargetPath;
  const sheet = openDialog(`上传到${label}`, `${file.filename}\n目标：${destination}`);
  const submit = addButton(sheet.actions, '确认加入队列', 'primary-button', async () => {
    if (pendingUploads.has(key)) return;
    pendingUploads.add(key); sheet.setPending(true); submit.textContent = '正在提交…';
    try {
      const result = await api(`/console/api/outputs/${file.id}/upload/${provider}`, { method: 'POST', body: body({}) });
      rememberSubmittedTask('uploads', result.job?.id);
      flashSubmitted(triggerButton || submit, 'upload', triggerButton ? '上传成片' : '确认加入队列'); sheet.close(); notify(`已加入${label}上传队列`, false, { icon: 'upload', kind: 'uploads', range: file.start && file.end ? file.start.slice(11) + ' → ' + file.end.slice(11) : file.filename });
      refreshState().catch(() => notify('已提交，状态暂未同步，请稍后刷新。', true));
    } catch (error) { sheet.setPending(false); submit.textContent = '确认加入队列'; sheet.error.textContent = error.message; }
    finally { pendingUploads.delete(key); }
  });
}

function acceptOutputs(next) {
  if (Array.isArray(next) && JSON.stringify(next) !== JSON.stringify(state.outputs)) { state.outputs = next; renderOutputs(); }
}
async function refreshOutputs() {
  const request = ++outputRequest; const data = await api('/console/api/outputs');
  if (request === outputRequest) acceptOutputs(data.outputs || []);
}
$('output-search').addEventListener('input', renderOutputs);
$('output-sort').addEventListener('click', toggleOutputSort);


const transferSampler = createTransferSampler();
const taskFeeds = {
  exports: createTaskFeed({ list: $('task-list'), scroller: $('task-export-panel'), sentinel: $('task-export-sentinel'), makeCard: task => presentTaskCard(task, false), createdAt: taskCreatedAt }),
  uploads: createTaskFeed({ list: $('upload-list'), scroller: $('task-upload-panel'), sentinel: $('task-upload-sentinel'), makeCard: task => presentTaskCard(task, true), createdAt: taskCreatedAt }),
};
function rememberSubmittedTask(kind, id) {
  if (!['exports', 'uploads'].includes(kind) || !id) return;
  pendingTaskFocus = { kind, id };
  if (document.body.dataset.view === 'tasks') selectTaskTab(kind === 'uploads');
}
function revealSubmittedTask() {
  const pending = pendingTaskFocus;
  if (!pending || document.body.dataset.view !== 'tasks') return;
  const panel = $(pending.kind === 'uploads' ? 'task-upload-panel' : 'task-export-panel');
  if (!panel.hidden && taskFeeds[pending.kind].reveal(pending.id)) pendingTaskFocus = null;
}
function openTaskPage(kind) {
  if (['exports', 'uploads'].includes(kind)) selectTaskTab(kind === 'uploads');
  navigate('tasks');
}
function selectTaskTab(upload, focus = false) {
  for (const [name, selected] of [['export', !upload], ['upload', upload]]) {
    const button = $('task-tab-' + name); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $('task-' + name + '-panel').hidden = window.matchMedia?.('(min-width: 1024px)').matches ? false : !selected; if (selected && focus) button.focus();
  }
  if (window.matchMedia?.('(min-width: 1024px)').matches) { taskFeeds.exports.resume(); taskFeeds.uploads.resume(); }
  else (upload ? taskFeeds.uploads : taskFeeds.exports).resume();
  revealSubmittedTask();
}
function syncTaskLayout() { selectTaskTab($('task-tab-upload').getAttribute('aria-selected') === 'true'); }
window.addEventListener('resize', syncTaskLayout);
syncTaskLayout();
for (const name of ['export', 'upload']) {
  const button = $('task-tab-' + name);
  button.addEventListener('click', () => selectTaskTab(name === 'upload'));
  button.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectTaskTab(event.key === 'End' || (event.key !== 'Home' && name === 'export'), true); } });
}
const statusLabels = { queued: '排队中', pending: '准备中', downloading: '正在导出', converting: '正在封装', uploading: '正在上传', completed: '已完成', error: '失败', cancelled: '已取消', stopping: '正在取消', unknown: '需要确认', reconciling: '正在核对恢复状态', 'needs-confirmation': '需要确认', draft: '草稿待确认' };
const finalStatuses = new Set(['completed', 'error', 'cancelled', 'unknown']);
function statusText(status) { return statusLabels[status] || '处理中'; }
function renderTasks() {
  // Counts use the complete server queues, independently of displayed history.
  const active = tasks => tasks.filter(task => ['queued', 'pending', 'downloading', 'converting', 'uploading', 'stopping', 'reconciling'].includes(task.status) && !task.archivedAt).length;
  const count = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const exports = count(state.exportActiveTaskCount, active(state.tasks)), uploads = count(state.uploadActiveTaskCount, active(state.uploads));
  const activeCount = count(state.activeTaskCount, exports + uploads);
  document.querySelectorAll('[data-task-count]').forEach(node => { node.textContent = String(activeCount); node.hidden = activeCount === 0; });
  for (const [id, value] of [['export-task-count', exports], ['upload-task-count', uploads]]) { const node = $(id); node.textContent = String(value); node.hidden = value === 0; }
  taskFeeds.exports.update(state.tasks); taskFeeds.uploads.update(state.uploads);
  revealSubmittedTask();
}
// Explicit retry starts a new attempt; ordinary completion never reorders a task.
function taskCreatedAt(task) {
  for (const value of [task.retryRequestedAt, task.createdAt, task.queuedAt, task.startTime, task.startedAt]) {
    if (value == null || value === '') continue;
    const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value));
    const time = numeric ? Number(value) : Date.parse(value);
    const ms = numeric && time < 1e12 ? time * 1000 : time;
    if (Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000) return ms;
  }
  return 0;
}
const removedRecordsExpanded = { uploads: false };
function appendTasksByTime(list, tasks, uploadTask) {
  let removed;
  // sort() is stable, preserving API order for legacy tasks without timestamps.
  for (const task of [...tasks].sort((left, right) => taskCreatedAt(right) - taskCreatedAt(left))) {
    const card = makeTaskCard(task, uploadTask), createdAt = taskCreatedAt(task);
    if (createdAt) {
      const time = document.createElement('time'); time.className = 'task-created-at'; time.dateTime = new Date(createdAt).toISOString();
      time.textContent = new Date(createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      time.title = `${task.retryRequestedAt ? '重试于' : '创建于'} ${new Date(createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`;
      time.setAttribute('aria-label', time.title); card.append(time);
    }
    if (uploadTask && task.archivedAt) {
      if (!removed) {
        removed = document.createElement('details'); removed.className = 'removed-records'; removed.open = removedRecordsExpanded.uploads;
        const summary = document.createElement('summary'); summary.textContent = `已移除记录 · ${tasks.filter(item => item.archivedAt).length}`; removed.append(summary);
        removed.addEventListener('toggle', () => { if (removed.isConnected) removedRecordsExpanded.uploads = removed.open; });
      }
      removed.append(card);
    } else list.append(card);
  }
  if (removed) list.append(removed);
}
function makeTaskCard(task, uploadTask) {
  if (!uploadTask && task.kind === 'dvr-http-sample') return makeDvrHttpSampleCard(task);
  const card = document.createElement('article'); card.className = 'task-card'; const head = document.createElement('div'); head.className = 'task-heading';
  const title = document.createElement('strong'); title.textContent = task.title || task.filename || `${task.camera || '录像任务'} ${task.kind || ''}`; head.append(title);
  const stateLabel = document.createElement('span'); stateLabel.className = `task-state${task.status === 'completed' ? ' done' : ['error', 'unknown'].includes(task.status) ? ' failed' : ''}`; stateLabel.textContent = task.archivedAt ? '已移除 · 结果待核实' : task.status === 'queued' && task.queuePosition ? `排队中 · 第 ${task.queuePosition} 位` : taskStageLabel(task) || statusText(task.status); head.append(stateLabel); card.append(head);
  const detail = document.createElement('p'); detail.className = 'task-detail'; detail.textContent = task.archivedAt ? '原上传结果已保留，成片可改名。恢复记录后可继续核实或重试。' : task.recoveryMessage || task.message || (task.status === 'draft' ? '投稿草稿尚未提交，不会开始上传。' : task.status === 'queued' ? '等待前面的任务完成后自动开始。' : [task.camera, task.start, task.end, task.targetPath].filter(Boolean).join(' · ') || (uploadTask ? task.filename : '任务正在运行')); card.append(detail);
  const progress = taskProgressPresentation(task);
  const diagnostic = task.failureDiagnostics;
  if (!uploadTask && task.status === 'error' && diagnostic && ['DESCRIBE', 'SETUP', 'PLAY'].includes(diagnostic.method)
      && Number.isInteger(diagnostic.rtspStatus) && diagnostic.rtspStatus >= 100 && diagnostic.rtspStatus <= 599) {
    const line = document.createElement('p'); line.className = 'task-detail task-diagnostic';
    const media = diagnostic.method === 'SETUP' ? diagnostic.setupMedia === 'video' ? '（视频）' : diagnostic.setupMedia === 'audio' ? '（音频）' : '' : '';
    const auth = diagnostic.method === 'DESCRIBE' && typeof diagnostic.authorizationSent === 'boolean'
      ? diagnostic.authorizationSent ? ' · 已发送认证' : ' · 未发送认证' : '';
    line.textContent = `RTSP ${diagnostic.method}${media} · ${diagnostic.rtspStatus}${auth}`; card.append(line);
    const recording = diagnostic.recording;
    if (recording && ['available', 'no_match', 'timeout', 'cancelled', 'authentication', 'unsupported', 'invalid', 'failed'].includes(recording.outcome)) {
      const search = document.createElement('p'); search.className = 'task-detail task-recording-diagnostic';
      const labels = { no_match: '未查到对应录像', timeout: '录像信息查询超时', cancelled: '录像信息查询已取消', authentication: '录像信息查询认证失败', unsupported: '录像信息查询不受支持', invalid: '录像信息无法解析', failed: '录像信息查询失败' };
      if (recording.outcome === 'available') {
        const first = Array.isArray(recording.recordings) ? recording.recordings[0] : null;
        const count = Number.isInteger(recording.matchCount) && recording.matchCount >= 0 && recording.matchCount <= 10000 ? recording.matchCount : 0;
        const range = { exact: '地址时间等于选段', covers: '地址时间覆盖选段', partial: '地址时间仅部分覆盖', outside: '地址时间不在选段', invalid: '地址时间无法判断' };
        search.textContent = `查询到 ${count} 段录像${first && Object.hasOwn(range, first.uriRange) ? ` · ${range[first.uriRange]}` : ''}${first && typeof first.hasName === 'boolean' ? first.hasName ? ' · 有文件标识' : ' · 无文件标识' : ''}`;
      } else search.textContent = labels[recording.outcome];
      card.append(search);
      const facts = document.createElement('p'); facts.className = 'task-detail task-recording-facts';
      const downloadByTime = recording.downloadByTime === 'supported' ? '支持' : recording.downloadByTime === 'unsupported' ? '不支持' : '未知';
      facts.textContent = `按时间下载：${downloadByTime}`;
      if (recording.outcome === 'available') {
        const first = Array.isArray(recording.recordings) ? recording.recordings[0] : null;
        // Never coerce diagnostic input into display text, including old saved tasks.
        const number = (value, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0
          && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value)) ? value : null;
        const duration = number(first?.durationSeconds), uriDuration = number(first?.uriDurationSeconds), size = number(first?.sizeBytes, true);
        const seconds = value => value === null ? '未知' : `${value} 秒`;
        facts.textContent = `首段时长：${seconds(duration)}${uriDuration === null || uriDuration !== duration ? ` · 地址时长：${seconds(uriDuration)}` : ''} · 大小：${size === null ? '未知' : `${size} B`} · ${facts.textContent}`;
      }
      card.append(facts);
    }
  }
  if (task.sdkMetadata?.transport === 'hcnetsdk' && Number.isFinite(task.sdkMetadata.actualDurationSeconds)) {
    const timing = document.createElement('p'); timing.className = 'task-detail task-sdk-timing';
    timing.textContent = `SDK 按时间取回 · 实际成片 ${task.sdkMetadata.actualDurationSeconds.toFixed(1)} 秒；关键帧起止尚未精确对齐，请核对画面时钟。`;
    card.append(timing);
  }
  if (progress.show) { const track = document.createElement('div'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', taskStageLabel(task) || statusText(task.status)); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); if (progress.hasPercent) track.setAttribute('aria-valuenow', String(progress.percent)); track.className = `progress-track${progress.indeterminate ? ' indeterminate' : progress.hasPercent ? '' : ' waiting'}`; if (progress.indeterminate) track.setAttribute('aria-valuetext', taskStageLabel(task) || (task.status === 'uploading' ? '等待上传进度回报' : '正在处理'));  const fill = document.createElement('div'); fill.className = 'progress-fill'; if (progress.hasPercent) fill.style.width = `${progress.percent}%`; track.append(fill); card.append(track); }
  const footer = document.createElement('div'); footer.className = `task-footer${task.provider === 'cloud189' && task.status === 'unknown' ? ' recovery-actions' : ''}`; const left = document.createElement('span'); left.textContent = ({ mediamtx: 'MediaMTX', hikvision: '录像机', cloud189: '189', bilibili: 'B站' })[task.source || task.provider] || task.kind || ''; const right = document.createElement('span');
  const speed = Number(task.speed ?? task.uploadSpeed); const updatedAt = Number(task.speedUpdatedAt || task.progressUpdatedAt || 0); const fresh = Date.now() - (updatedAt < 1e12 ? updatedAt * 1000 : updatedAt) < 6000; right.textContent = uploadTask ? uploadProgressCaption(task) : task.status === 'queued' || task.status === 'pending' || task.status === 'draft' ? '' : fresh && speed > 0 ? `${(speed * 8 / 1e6).toFixed(1)} Mbps` : task.stage ? taskProgressCaption(task) : progress.hasPercent ? `${Math.round(progress.percent)}%` : uploadTask && task.status === 'uploading' ? '进度不可用' : '';
  footer.append(left, right);
  if (!uploadTask && task.status === 'error' && task.source === 'hikvision' && task.dvrHttpSampleAvailable === true) {
    const explanation = document.createElement('p'); explanation.className = 'task-detail task-http-sample-warning';
    explanation.textContent = '最多读取 32 MB 或传输 20 秒，先到即停；可能包含所选十秒之外的画面。仅测试兼容性，不生成成片。'; card.append(explanation);
    const sample = document.createElement('button'); sample.type = 'button'; sample.className = 'quiet-button'; sample.textContent = '受限 HTTP 兼容测试';
    sample.disabled = dvrHttpSamplePending.has(task.taskId);
    sample.addEventListener('click', () => { if (sample.disabled) return; sample.disabled = true; return startDvrHttpSample(task); }); footer.append(sample);
  }
  if (!uploadTask && task.status === 'queued') {
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet-button'; cancel.textContent = '取消排队';
    cancel.addEventListener('click', async () => {
      if (cancel.disabled) return;
      cancel.disabled = true;
      try {
        await api('/console/api/export/stop', { method: 'POST', body: body({ taskId: task.taskId }) });
        await refreshState(); notify('已取消排队任务。');
      } catch (error) { cancel.disabled = false; notify(error.message, true); }
    });
    footer.append(cancel);
  }
  if (task.provider === 'cloud189' && task.status === 'unknown' && !task.archivedAt) {
    const verify = document.createElement('button'); verify.type = 'button'; verify.className = 'quiet-button';
    verify.disabled = cloudVerificationPending.has(task.id);
    verify.textContent = verify.disabled ? '正在核实…' : '核实结果';
    verify.addEventListener('click', async () => {
      if (cloudVerificationPending.has(task.id)) return;
      cloudVerificationPending.add(task.id); renderTasks();
      try {
        await loadSettings();
        const result = await api(`/console/api/uploads/cloud189/${encodeURIComponent(task.id)}/verify`,
          { method: 'POST', headers: { 'X-CSRF-Token': settingsCsrfToken }, body: body({}) });
        notify(result.message, !result.verified);
      } catch (error) { notify(error.message, true); }
      finally { cloudVerificationPending.delete(task.id); renderTasks(); await refreshState().catch(() => {}); }
    });
    footer.append(verify);
  }
  if (task.provider === 'cloud189' && task.status === 'unknown' && task.recoveryAvailable !== false) {
    for (const [action, label] of task.archivedAt ? [['restore', '恢复记录']] : [['retry', '重试上传'], ['archive', '移除记录']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet-button';
      button.textContent = label; button.disabled = cloudVerificationPending.has(task.id);
      button.addEventListener('click', () => {
        if (cloudVerificationPending.has(task.id)) return;
        const description = action === 'retry'
          ? `将检查原账号、原文件和云盘目标。确认目标目前无文件后重新入队；上次结果会保留。目标：${task.targetPath || ''}/${task.remoteFilename || task.filename || ''}`
          : action === 'archive' ? '保留成片和原上传结果，解除这条记录对改名的限制。之后可恢复记录再核实或重试。'
          : '恢复后可继续核实或重试云盘上传；核实前会重新保护原文件，暂不能改名。';
        confirmAction(`${label}？`, description, label, () => recoverCloudUpload(task, action));
      });
      footer.append(button);
    }
  }
  card.append(footer); return card;
}
function presentTaskCard(task, upload) {
  const card = makeTaskCard(task, upload);
  const caption = card.querySelector('.task-footer > span:nth-child(2)');
  if (caption) caption.textContent = ['downloading','uploading','converting','stopping','reconciling'].includes(task.status) ? '' : upload && Number.isFinite(task.totalBytes) ? formatTransferBytes(task.totalBytes) : caption.textContent;
  appendTransferPresentation(card, task, upload);
  if (!task.archivedAt && ['completed','cancelled','error'].includes(task.status) && task.kind !== 'dvr-http-sample') {
    card.classList.add('task-history');
    const status = document.createElement('span'); status.className = 'task-status-icon' + (task.status === 'error' ? ' failed' : ''); status.innerHTML = iconSvg(task.status === 'error' ? 'warning' : task.status === 'cancelled' ? 'clear' : 'check'); status.setAttribute('aria-label',statusText(task.status)); card.prepend(status);
    if (task.status === 'completed') card.querySelector('.task-detail')?.remove();
  }
  return card;
}
function appendTransferPresentation(card, task, upload) {
  const running = ['downloading', 'uploading', 'converting', 'stopping', 'reconciling'].includes(task.status);
  card.classList.toggle('task-working', running); card.classList.toggle('task-verification', upload && ['unknown', 'needs-confirmation'].includes(task.status) && !task.archivedAt);
  if (upload) { const target = document.createElement('span'); target.className = 'task-target'; target.innerHTML = iconSvg(task.provider === 'bilibili' ? 'tv' : 'cloud'); target.append(document.createTextNode(task.provider === 'bilibili' ? 'B站' : '189')); card.querySelector('.task-footer').prepend(target); }
  if (!running) return;
  const progress = taskProgressPresentation(task), sample = transferSampler.sample(task);
  const stats = document.createElement('div'); stats.className = 'task-transfer-stats mono';
  const size = document.createElement('span'); size.textContent = sample.bytes == null ? '已传大小待测' : (task.transferScope === 'file' ? '当前文件 ' : '') + formatTransferBytes(sample.bytes) + (sample.total == null ? '' : ' / ' + formatTransferBytes(sample.total));
  const percent = document.createElement('strong'); percent.className = 'task-percent'; percent.textContent = progress.hasPercent ? Math.round(progress.percent) + '%' : '—'; stats.append(size, percent);
  const line = document.createElement('div'); line.className = 'task-rate-line mono';
  const speed = document.createElement('span'); speed.textContent = sample.bps == null ? '速度待测' : fmtBps(sample.bps).v + ' ' + fmtBps(sample.bps).u;
  const eta = document.createElement('span'); eta.textContent = sample.eta == null ? '剩余 —' : '剩余 ' + formatEta(sample.eta);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 56 20'); svg.setAttribute('class', 'task-sparkline'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); const max = Math.max(1, ...sample.history); path.setAttribute('points', sample.history.map((v,i,a) => (a.length === 1 ? 28 : i * 56 / (a.length - 1)) + ',' + (18 - v / max * 16)).join(' ')); svg.append(path);
  line.append(speed, svg, eta); card.append(stats, line);
}
function makeDvrHttpSampleCard(task) {
  // A sample is a diagnostic, never a finished clip. Do not render task titles,
  // error/message fields, selectors, URLs or arbitrary probe output here.
  const card = document.createElement('article'); card.className = 'task-card';
  const head = document.createElement('div'); head.className = 'task-heading';
  const title = document.createElement('strong'); title.textContent = '受限 HTTP 兼容测试';
  const status = document.createElement('span'); status.className = 'task-state';
  const statusLabels = { queued: '测试排队中', pending: '准备测试', downloading: '正在读取样本', converting: '正在检测样本', stopping: '正在取消', completed: '测试结束', error: '测试失败', cancelled: '测试已取消' };
  status.textContent = typeof task.status === 'string' && Object.hasOwn(statusLabels, task.status) ? statusLabels[task.status] : '测试状态待确认';
  head.append(title, status); card.append(head);
  const detail = document.createElement('p'); detail.className = 'task-detail task-http-sample-warning';
  detail.textContent = '最多读取 32 MB 或传输 20 秒，先到即停；可能包含所选十秒之外的画面。仅测试兼容性，不生成成片，也不能证明已精确截取所选十秒。'; card.append(detail);
  const checkpoint = document.createElement('p'); checkpoint.className = 'task-detail task-http-sample-checkpoint';
  const attempted = Object.getOwnPropertyDescriptor(task, 'sampleMediaAttempted')?.value;
  checkpoint.textContent = attempted === false ? '媒体请求检查点：未进入，尚未发送媒体请求。'
    : attempted === true ? '媒体请求检查点：已进入媒体请求阶段，不代表已连接成功。' : '媒体请求检查点：未记录。';
  card.append(checkpoint);
  appendDvrHttpSampleReport(card, Object.getOwnPropertyDescriptor(task, 'samplePreflightReport')?.value, true);
  appendDvrHttpSampleReport(card, task.sampleReport);
  const footer = document.createElement('div'); footer.className = 'task-footer';
  const kind = document.createElement('span'); kind.textContent = 'HTTP 兼容性报告'; footer.append(kind);
  if (Object.getOwnPropertyDescriptor(task, 'sampleResumeAvailable')?.value === true) {
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'quiet-button'; resume.textContent = '继续未开始的测试';
    resume.disabled = dvrHttpSamplePending.has(task.taskId);
    resume.addEventListener('click', () => { if (resume.disabled) return; resume.disabled = true; return startDvrHttpSample(task); }); footer.append(resume);
  }
  if (['queued', 'pending', 'downloading', 'converting', 'stopping'].includes(task.status)) {
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet-button'; cancel.textContent = '取消测试'; cancel.disabled = task.status === 'stopping';
    cancel.addEventListener('click', async () => {
      if (cancel.disabled) return;
      cancel.disabled = true;
      try {
        await api('/console/api/export/stop', { method: 'POST', body: body({ taskId: task.taskId }) });
        await refreshState(); notify('已请求取消兼容测试。');
      } catch { cancel.disabled = false; notify('暂时无法取消兼容测试，请刷新状态后重试。', true); }
    });
    footer.append(cancel);
  }
  card.append(footer); return card;
}
function appendDvrHttpSampleReport(card, report, preflight = false) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return;
  const field = key => { const descriptor = Object.getOwnPropertyDescriptor(report, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null; };
  const label = (labels, value) => typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : '未知';
  const number = (value, min, max, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isSafeInteger(value)) ? value : null;
  const display = (value, suffix = '') => value === null ? '未知' : `${value}${suffix}`;
  const line = (className, text) => { const node = document.createElement('p'); node.className = `task-detail ${className}`; node.textContent = text; card.append(node); };
  const outcomes = { decoded: '已解码样本', undecodable: '样本无法解码', no_match: '未查到对应录像', invalid: '样本信息无效', authentication: '认证失败', http_error: 'HTTP 请求失败', timeout: '测试超时', cancelled: '已取消', failed: '测试失败', cleanup_failed: '样本清理失败' };
  if (preflight) {
    line('task-http-sample-preflight', `上次前检记录：${label(outcomes, field('outcome'))} · 已读取：${display(number(field('bytes'), 0, 32000000, true), ' B')}`);
    return;
  }
  const stops = { eof: '响应结束', byte_limit: '达到 32 MB 上限', time_limit: '达到 20 秒传输上限', cancelled: '用户取消', http_error: 'HTTP 请求失败', invalid_response: '响应无效', no_match: '未查到对应录像', invalid_recording: '录像信息无效', transport_error: '传输失败', probe_limit: '达到媒体探测上限', decode_limit: '达到解码上限' };
  const mediaTypes = { mpegps: 'MPEG-PS', mpegts: 'MPEG-TS', mp4: 'MP4', matroska: 'Matroska', avi: 'AVI', h264: 'H.264 裸流', hevc: 'H.265 / HEVC 裸流', mpegvideo: 'MPEG 视频' };
  const videoCodecs = { h264: 'H.264', hevc: 'H.265 / HEVC', mpeg1video: 'MPEG-1', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', mjpeg: 'MJPEG', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', rawvideo: '未压缩视频' };
  const audioCodecs = { aac: 'AAC', mp2: 'MP2', mp3: 'MP3', pcm_alaw: 'G.711 A-law', pcm_mulaw: 'G.711 μ-law', pcm_s16le: 'PCM 16-bit LE', pcm_s16be: 'PCM 16-bit BE', opus: 'Opus', vorbis: 'Vorbis', ac3: 'AC-3', eac3: 'E-AC-3', adpcm_ima_wav: 'IMA ADPCM' };
  line('task-http-sample-outcome', `测试结果：${label(outcomes, field('outcome'))} · 停止原因：${label(stops, field('stopReason'))}`);
  if (Object.hasOwn(report, 'phase') || Object.hasOwn(report, 'curlExitCode')) {
    const phases = { search: '录像查询', private_setup: '准备临时样本', checkpoint: '媒体请求检查点', transfer: 'HTTP 媒体请求', probe: '媒体探测', decode: '样本解码', cleanup: '临时样本清理' };
    line('task-http-sample-phase', `执行阶段：${label(phases, field('phase'))} · curl 退出码：${display(number(field('curlExitCode'), 0, 255, true))}`);
  }
  line('task-http-sample-transfer', `HTTP 状态：${display(number(field('httpStatus'), 100, 599, true))} · 已读取：${display(number(field('bytes'), 0, 32000000, true), ' B')} · 媒体类型：${label(mediaTypes, field('mediaType'))}`);
  line('task-http-sample-media', `视频：${label(videoCodecs, field('videoCodec'))} · 音频：${label(audioCodecs, field('audioCodec'))} · 分辨率：${display(number(field('width'), 1, 16384, true))} × ${display(number(field('height'), 1, 16384, true))} · 已解码帧数：${display(number(field('decodedFrames'), 0, 1000, true))}`);
  line('task-http-sample-timestamps', `样本相对时间戳：${display(number(field('firstPtsSeconds'), 0, 86400), ' 秒')} 至 ${display(number(field('lastPtsSeconds'), 0, 86400), ' 秒')}；不是录像墙钟时间，不能据此认定精确十秒成片。`);
}
async function startDvrHttpSample(task) {
  if (dvrHttpSamplePending.has(task.taskId)) return;
  dvrHttpSamplePending.set(task.taskId, 'submitting'); renderTasks();
  try {
    await loadSettings();
    await api(`/console/api/tasks/${encodeURIComponent(task.taskId)}/dvr-http-sample`,
      { method: 'POST', headers: { 'X-CSRF-Token': settingsCsrfToken }, body: body({}) });
    notify('受限兼容测试已提交，不会生成成片。');
  } catch { notify('兼容测试未能提交，请刷新任务状态后重试。', true); }
  finally {
    // A failed refresh is not evidence that the server did not accept the test.
    dvrHttpSamplePending.set(task.taskId, 'refresh');
    await refreshState().catch(() => {});
  }
}
function reconcileDvrHttpSamplePending() {
  for (const [taskId, phase] of dvrHttpSamplePending) if (phase === 'refresh') dvrHttpSamplePending.delete(taskId);
}
async function recoverCloudUpload(task, action) {
  if (cloudVerificationPending.has(task.id)) return;
  cloudVerificationPending.add(task.id); renderTasks();
  try {
    await loadSettings();
    const result = await api(`/console/api/uploads/cloud189/${encodeURIComponent(task.id)}/${action}`,
      { method: 'POST', headers: { 'X-CSRF-Token': settingsCsrfToken }, body: body(action === 'retry' ? { confirmRetry: true } : {}) });
    if (!result.applied) throw new Error(result.message);
    notify(result.message);
  } finally {
    cloudVerificationPending.delete(task.id); renderTasks();
    await refreshState().catch(() => {}); await refreshOutputs().catch(() => {});
  }
}
async function refreshState() {
  const session = consoleSession, request = ++stateRequest, outputVersion = ++outputRequest;
  const data = await api('/console/api/bootstrap');
  if (session !== consoleSession) return;
  if (outputVersion === outputRequest) acceptOutputs(data.outputs);
  if (request !== stateRequest) return;
  reconcileDvrHttpSamplePending();
  state.activeTaskCount = data.activeTaskCount; state.exportActiveTaskCount = data.exportActiveTaskCount; state.uploadActiveTaskCount = data.uploadActiveTaskCount; state.tasks = data.tasks || []; state.uploads = data.uploads || []; renderTasks();
  renderSettings(data.settings || {}, data.integrations || {});
  const snapshot = JSON.stringify([state.tasks.map(task => [task.taskId, task.status]), state.uploads.map(task => [task.id, task.status, task.progress])]);
  state.lastTasks = snapshot;
}
function connectEvents() {
  state.source?.close(); const source = new EventSource(appPath('/console/api/events')); state.source = source;
  source.addEventListener('update', event => { try {
    if (source !== state.source) return;
    stateRequest++;
    const data = JSON.parse(event.data), before = state.lastTasks;
    reconcileDvrHttpSamplePending();
    state.activeTaskCount = data.activeTaskCount; state.exportActiveTaskCount = data.exportActiveTaskCount; state.uploadActiveTaskCount = data.uploadActiveTaskCount; state.tasks = data.tasks || []; state.uploads = data.uploads || []; renderTasks(); renderSettings(data.settings || {}, data.integrations || {}); setConnection('实时同步');
    const snapshot = JSON.stringify([state.tasks.map(task => [task.taskId, task.status]), state.uploads.map(task => [task.id, task.status, task.progress])]);
    if (snapshot !== before) refreshOutputs().catch(() => {});
    state.lastTasks = snapshot;
  } catch {} });
  source.addEventListener('auth-expired', () => loggedOut('登录已过期，请重新登录。'));
  source.onerror = () => setConnection('正在重连', true);
}

// Configuration is fetched separately from SSE: live task updates never replace editor inputs.
let consoleConfig = null, configLoadId = 0, configEditor = null, suspendedConfigEditor = null;
const recorderChecks = new Map();
function acceptConsoleConfig(data) {
  // Bootstrap establishes the revision of the sources used by playback. A first
  // settings read preserves that selection only when the source snapshot matches.
  const changed = !state.configRevision || state.configRevision !== data.revision;
  const previousCamera = state.selectedCamera, previousDvr = $('dvr-select').value;
  state.configRevision = data.revision || null;
  if (changed || consoleConfig?.revision !== data.revision) recorderChecks.clear();
  consoleConfig = data;
  renderConsoleConfig();
  fillDvrDevices(data.dvrs || []); fillCameras(data.channels || data.cameras || []);
  const selectionChanged = state.playbackSource === 'dvr' ? previousDvr !== $('dvr-select').value : previousCamera !== state.selectedCamera;
  if (changed || selectionChanged) resetConfigurationPlayback();
}
function resetConfigurationPlayback() {
  // A removed DVR must never leave its channel/coverage paired with another DVR.
  state.dvrChannelRequestId++; state.dvrChannels = {}; state.dvrChannelCache = {}; state.selectedChannel = '';
  clearMarkedRange(); invalidatePlaybackSelection();
  const channel = $('dvr-channel'); channel.replaceChildren(); channel.disabled = true;
  const option = document.createElement('option'); option.value = ''; option.textContent = '重新选择录像机并读取通道'; channel.append(option);
  updateSelection(); setPlaybackNotice('录像来源配置已更新，请重新选择来源并载入录像。');
}
async function loadConsoleConfig() {
  const requestId = ++configLoadId;
  try {
    const data = await requestJson('/console/api/config');
    if (requestId === configLoadId) { acceptConsoleConfig(data); $('config-message').textContent = ''; }
    return data;
  } catch (error) {
    $('config-message').textContent = error.message;
    if (error.status === 401) loggedOut('登录已过期，重新登录后可继续未保存的配置。');
    throw error;
  }
}
// 已打开的来源二级视图 -> 重绘函数；配置变化（保存、SSE 之外的重读）时刷新其中的列表，不动输入框。
const settingsViews = new Map();
function renderConsoleConfig() {
  const config = consoleConfig, channels = config?.channels || config?.cameras || [];
  $('config-preparation').hidden = !config?.preparationOnly;
  setSettingsRow('dvr', { value: config ? String(config.dvrs?.length || 0) : '', tone: config && !config.dvrs?.length ? 'warn' : '', label: '还没有录像机' });
  setSettingsRow('mediamtx', { value: config ? String(channels.length) : '', tone: config && !config.mediamtx?.playbackUrl ? 'warn' : '', label: '未设置回放地址' });
  for (const redraw of settingsViews.values()) redraw();
}
function trackSettingsView(key, sheet, redraw) {
  settingsViews.set(key, redraw);
  sheet.dialog.addEventListener('close', () => { if (settingsViews.get(key) === redraw) settingsViews.delete(key); });
  redraw();
}
function configNotice(parent) {
  const notice = document.createElement('p'); notice.className = 'config-notice'; notice.setAttribute('role', 'status'); notice.textContent = $('config-preparation').textContent; parent.append(notice); return notice;
}
function configSheet(title, description, inline = false, initialDirty = false) {
  const sheet = inline ? openSettingsContainer(title, description, { initialDirty }) : openDialog(title, description, { initialDirty });
  if (!sheet) return null;
  sheet.dialog.classList.add('config-dialog');
  sheet.context = { revision: consoleConfig?.revision, pending: false };
  sheet.dialog.addEventListener('close', () => { if (configEditor?.sheet === sheet) configEditor = null; });
  return sheet;
}
function registerConfigDraft(sheet, resume) {
  configEditor = { sheet, resume: () => {
    resume();
    if (configEditor) {
      // 旧弹层从未拿到 revision（首次读取就 401）时，保留新弹层重新登录后取得的 revision；有效的旧 revision 原样沿用，不自动升级。
      if (sheet.context.revision != null) configEditor.sheet.context.revision = sheet.context.revision;
      configEditor.sheet.error.textContent = '未保存的输入已恢复。请核对后再保存。';
    }
  } };
}
function setConfigPending(sheet, pending) {
  sheet.context.pending = pending; sheet.setPending(pending);
  for (const select of sheet.dialog.querySelectorAll('select')) {
    if (pending) { select.dataset.wasDisabled = String(select.disabled); select.disabled = true; }
    else { select.disabled = select.dataset.wasDisabled === 'true'; delete select.dataset.wasDisabled; }
  }
}
async function configRequest(path, method, values, revision) {
  if (!consoleConfig || consoleConfig.preparationOnly) throw new Error('准备模式为只读；请在服务器本机完成配置开放后重试。');
  try {
    return await requestJson(`/console/api${path}`, { method, headers: { 'X-CSRF-Token': consoleConfig.csrfToken }, body: body({ ...values, revision }) });
  } catch (error) {
    if (error.status === 401) loggedOut('登录已过期，重新登录后可继续未保存的配置。');
    throw error;
  }
}
async function runConfigAction(sheet, action) {
  if (sheet.context.pending) return;
  setConfigPending(sheet, true); sheet.error.textContent = '';
  try { await action(); }
  catch (error) {
    sheet.error.textContent = error.status === 409 ? `${error.message}。输入已保留；请核对最新配置或等待任务结束后重试。` : error.message;
    if (error.status === 409 && !sheet.context.refreshButton) {
      sheet.context.refreshButton = addButton(sheet.actions, '载入最新配置，保留输入', 'quiet-button', async () => {
        if (sheet.context.pending) return;
        setConfigPending(sheet, true);
        try {
          const latest = await loadConsoleConfig(); sheet.context.revision = latest.revision;
          sheet.error.textContent = '最新配置已载入，输入未改变。请核对后再次保存；同一字段将以你的输入为准。';
        } catch (refreshError) { sheet.error.textContent = refreshError.message; }
        finally { setConfigPending(sheet, false); }
      });
    }
  } finally { setConfigPending(sheet, false); }
}
function fieldSelect(parent, label, options, value) {
  const wrap = document.createElement('label'); wrap.className = 'field';
  const caption = document.createElement('span'); caption.textContent = label;
  const select = document.createElement('select'); select.setAttribute('aria-label', label);
  for (const [id, text] of options) { const option = document.createElement('option'); option.value = id; option.textContent = text; select.append(option); }
  select.value = value; wrap.append(caption, select); parent.append(wrap); return select;
}
function openDvrEditor(dvr = null, draft = null) {
  const saved = dvr && consoleConfig.dvrs.find(item => item.id === dvr.id);
  const values = draft || saved || {};
  const sheet = configSheet(dvr ? '编辑录像机' : '添加录像机', dvr ? '凭据只发送到服务器保存。不会播放、导出或启动录像。' : '保存前自动测试连接。失败时可修改重试，或明确选择仍然保存。');
  const name = labelledInput(sheet.content, '名称', values.name || '', { maxLength: 100 });
  const ip = labelledInput(sheet.content, '主机地址', values.ip || '', { placeholder: '192.168.1.10，不含协议或端口', maxLength: 253 });
  const username = labelledInput(sheet.content, '用户名', values.username || '', { maxLength: 100 }); username.autocomplete = 'off';
  const password = labelledInput(sheet.content, dvr ? '新密码（留空保留）' : '设备密码', draft?.password || '', { maxLength: 256 }); password.type = 'password'; password.autocomplete = 'new-password';
  const help = document.createElement('p'); help.className = 'setting-help'; help.textContent = dvr ? '不会读取或回显已保存密码。修改主机、端口或用户名时，请重新输入设备密码。' : '密码是只写字段，保存后不会返回到浏览器。'; sheet.content.append(help);
  const advanced = document.createElement('details'); advanced.className = 'config-advanced';
  const summary = document.createElement('summary'); summary.textContent = '高级 · 连接端口'; advanced.append(summary); sheet.content.append(advanced);
  const httpPort = labelledInput(advanced, 'HTTP 端口', String(values.httpPort || 80), { maxLength: 5 });
  const rtspPort = labelledInput(advanced, 'RTSP 端口', String(values.rtspPort || 554), { maxLength: 5 });
  for (const input of [httpPort, rtspPort]) { input.type = 'number'; input.min = '1'; input.max = '65535'; input.inputMode = 'numeric'; }
  const snapshot = () => ({ name: name.value.trim(), ip: ip.value.trim(), username: username.value.trim(), password: password.value, httpPort: Number(httpPort.value), rtspPort: Number(rtspPort.value) });
  registerConfigDraft(sheet, () => openDvrEditor(dvr, snapshot()));
  let failedDraft = null;
  const force = addButton(sheet.actions, '测试失败，仍然保存', 'danger-button', () => saveRecorder(true)); force.hidden = true;
  sheet.content.addEventListener('input', () => { failedDraft = null; force.hidden = true; });
  const save = addButton(sheet.actions, '保存录像机', 'primary-button', () => saveRecorder(false));
  function saveRecorder(forceSave) { return runConfigAction(sheet, async () => {
    const data = snapshot();
    if (!data.name || !data.ip || !data.username || (!dvr && !data.password)) throw new Error('请填写名称、主机地址、用户名和设备密码。');
    if (![data.httpPort, data.rtspPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error('端口必须是 1–65535 之间的整数。');
    if (dvr && !data.password) {
      const baseline = consoleConfig.dvrs.find(item => item.id === dvr.id);
      if (baseline && ['ip', 'username', 'httpPort', 'rtspPort'].some(key => String(data[key]) !== String(baseline[key] ?? (key === 'httpPort' ? 80 : key === 'rtspPort' ? 554 : '')))) throw new Error('修改主机、端口或用户名时，请重新输入设备密码。');
      delete data.password;
    }
    if (forceSave && failedDraft !== body(data)) throw new Error('输入已改变，请先重新测试连接。');
    save.textContent = dvr ? '正在保存…' : forceSave ? '正在保存…' : '正在测试并保存…';
    try {
      const result = await configRequest(dvr ? `/dvrs/${encodeURIComponent(dvr.id)}` : '/dvrs', dvr ? 'PATCH' : 'POST', { ...data, ...(forceSave ? { forceSave: true } : {}) }, sheet.context.revision);
      password.value = ''; recorderChecks.delete(dvr?.id); acceptConsoleConfig(result); sheet.close(); notify(forceSave ? '录像机已保存，连接尚未验证。' : dvr ? '录像机已保存。' : '连接测试通过，录像机已保存。');
    } catch (error) {
      if (!dvr && error.forceSaveRequired && ['DVR_AUTH_FAILED', 'DVR_PROBE_FAILED'].includes(error.code)) {
        failedDraft = body(data); force.hidden = false;
        error.message += '。尚未保存；请检查地址和密码后重试，或点击“测试失败，仍然保存”。';
      }
      throw error;
    } finally { save.textContent = '保存录像机'; }
  }); } name.focus();
}
function openRecorderActions(dvr) {
  const sheet = configSheet(dvr.name, `${dvr.ip} · HTTP ${dvr.httpPort || 80} / RTSP ${dvr.rtspPort || 554}`);
  addButton(sheet.content, '编辑连接设置', 'choice-option', () => openDvrEditor(dvr));
  const showChannels = channels => {
    list.replaceChildren();
    for (const channel of channels || []) { const row = document.createElement('p'); row.textContent = `${channel.id} · ${channel.name || '未命名通道'}`; list.append(row); }
    if (!channels?.length) list.textContent = '没有返回通道。';
  };
  addButton(sheet.content, '测试已保存连接', 'choice-option', () => runConfigAction(sheet, async () => {
    try {
      const result = await configRequest(`/dvrs/${encodeURIComponent(dvr.id)}/test`, 'POST', {}, sheet.context.revision);
      recorderChecks.set(dvr.id, '连接正常'); renderConsoleConfig(); showChannels(result.channels); sheet.error.textContent = '连接正常，未启动播放或导出。';
    } catch (error) {
      if (![401, 409].includes(error.status)) { recorderChecks.set(dvr.id, '测试失败'); renderConsoleConfig(); }
      throw error;
    }
  }));
  addButton(sheet.content, '读取已保存录像机的通道', 'choice-option', () => runConfigAction(sheet, async () => {
    try { const result = await requestJson(`/console/api/dvrs/${encodeURIComponent(dvr.id)}/channels`); showChannels(result.channels); }
    catch (error) { if (error.status === 401) loggedOut('登录已过期，请重新登录。'); throw error; }
  }));
  const list = document.createElement('div'); list.className = 'config-channel-list'; list.setAttribute('aria-live', 'polite'); sheet.content.append(list);
  addButton(sheet.actions, '删除录像机', 'danger-button', () => openConfigDelete('删除录像机？', `${dvr.name}。存在通道引用或正在使用时，服务器会拒绝删除。`, `/dvrs/${encodeURIComponent(dvr.id)}`, 'DELETE', () => ({})));
}
function openConfigDelete(title, description, path, method, values) {
  const sheet = configSheet(title, description);
  addButton(sheet.actions, '取消', 'quiet-button', () => sheet.close());
  addButton(sheet.actions, '确认删除', 'danger-button', () => runConfigAction(sheet, async () => {
    const result = await configRequest(path, method, values(), sheet.context.revision); acceptConsoleConfig(result); sheet.close(); notify('已删除。');
  }));
}
function openCameraEditor(camera = null, draft = null) {
  const values = draft || camera || {};
  const savedCamera = camera && consoleConfig.cameras.some(item => item.id === camera.id);
  const sheet = configSheet(camera ? '通道名称与关联' : '手动补充通道', 'MediaMTX 通道会自动发现。这里只需修改显示名称，或按需关联 DVR；保存不会启动录像。');
  const name = labelledInput(sheet.content, '显示名称（可选）', values.name || '', { placeholder: '留空使用 MediaMTX 路径', maxLength: 100 });
  const archivePath = labelledInput(sheet.content, 'MediaMTX 路径', values.archivePath || '', { placeholder: camera ? `留空保留 ${camera.id}` : '例如 d1', maxLength: 64 });
  const advanced = document.createElement('details'); advanced.className = 'config-advanced';
  const summary = document.createElement('summary'); summary.textContent = '高级：稳定 ID 与 DVR 关联（可选）'; advanced.append(summary); sheet.content.append(advanced);
  const id = labelledInput(advanced, '稳定 ID', values.id || '', { placeholder: '自动使用路径，无需填写', maxLength: 64 }); id.readOnly = Boolean(camera);
  const dvr = fieldSelect(advanced, '关联录像机', [['', '不关联 DVR（仅 MediaMTX）'], ...consoleConfig.dvrs.map(item => [item.id, `${item.name} · ${item.ip}`])], values.deviceId || '');
  const channel = fieldSelect(advanced, '录像通道', values.channel ? [[String(values.channel), String(values.channel)]] : [['', '选择录像机后自动读取']], String(values.channel || ''));
  const preview = document.createElement('div'); preview.className = 'camera-preview';
  const picture = document.createElement('img'); picture.alt = '所选录像机通道的实时抓拍'; picture.hidden = true;
  const previewStatus = document.createElement('p'); previewStatus.textContent = '选择通道后，抓拍一张实时画面核对位置，再填写名称。'; previewStatus.setAttribute('role', 'status');
  preview.append(picture, previewStatus); advanced.append(preview);
  let snapshotRequestId = 0;
  const resetPreview = () => { snapshotRequestId++; picture.hidden = true; picture.removeAttribute('src'); previewStatus.textContent = '通道已更换，请获取实时画面核对。'; };
  const snapshotButton = addButton(preview, '查看实时画面', 'quiet-button', () => runConfigAction(sheet, async () => {
    if (!dvr.value || !channel.value) throw new Error('先选择录像机和通道。');
    const deviceId = dvr.value, selectedChannel = channel.value, requestId = ++snapshotRequestId;
    picture.hidden = true; previewStatus.textContent = '正在获取实时画面…';
    try {
      const result = await configRequest(`/dvrs/${encodeURIComponent(deviceId)}/snapshot`, 'POST', { channel: selectedChannel }, sheet.context.revision);
      if (requestId !== snapshotRequestId || deviceId !== dvr.value || selectedChannel !== channel.value) return;
      if (!/^data:image\/(jpeg|png);base64,/.test(result.imageDataUrl || '')) throw new Error('服务器未返回有效抓拍画面。');
      picture.src = result.imageDataUrl; picture.hidden = false; previewStatus.textContent = `通道 ${selectedChannel} · ${new Date().toLocaleTimeString('zh-CN')} 实时抓拍`;
    } catch (error) { previewStatus.textContent = '抓拍失败，可重试或继续手动配置。'; throw error; }
  }));
  picture.addEventListener('error', () => { picture.hidden = true; previewStatus.textContent = '画面无法显示，请重新抓拍。'; });
  channel.addEventListener('change', resetPreview); dvr.addEventListener('change', resetPreview);
  sheet.dialog.addEventListener('close', () => { snapshotRequestId++; picture.removeAttribute('src'); });
  let channelRequestId = 0, closed = false;
  sheet.dialog.addEventListener('close', () => { closed = true; channelRequestId++; });
  const readChannels = () => runConfigAction(sheet, async () => {
    const deviceId = dvr.value, requestId = ++channelRequestId, previous = channel.value;
    if (!deviceId) throw new Error('请先选择要关联的录像机。');
    try {
      const result = await requestJson(`/console/api/dvrs/${encodeURIComponent(deviceId)}/channels`);
      if (closed || requestId !== channelRequestId || deviceId !== dvr.value) return;
      resetPreview(); channel.replaceChildren();
      for (const item of result.channels || []) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = `${item.id} · ${item.name || '未命名通道'}`; channel.append(option); }
      if ([...channel.options].some(option => option.value === previous)) channel.value = previous;
      if (!channel.options.length) throw new Error('这台录像机没有返回通道。');
    } catch (error) { if (error.status === 401) loggedOut('登录已过期，重新登录后可继续通道配置。'); throw error; }
  });
  dvr.addEventListener('change', () => {
    channelRequestId++; channel.replaceChildren(); const option = document.createElement('option'); option.value = ''; option.textContent = dvr.value ? '正在读取通道…' : '未关联 DVR'; channel.append(option);
    if (dvr.value) readChannels();
  });
  addButton(advanced, '读取所选录像机通道', 'quiet-button', readChannels);
  const snapshot = () => ({ id: id.value.trim(), name: name.value.trim(), ...(dvr.value ? { deviceId: dvr.value, channel: channel.value } : {}), archivePath: archivePath.value.trim() });
  registerConfigDraft(sheet, () => openCameraEditor(camera, snapshot()));
  if (savedCamera) addButton(sheet.actions, '删除映射', 'danger-button', () => openConfigDelete('删除通道映射？', `${camera.name} · ${camera.id}。不会删除录像文件。`, '/cameras', 'PUT', () => ({ cameras: consoleConfig.cameras.filter(item => item.id !== camera.id) })));
  addButton(sheet.actions, '保存映射', 'primary-button', () => runConfigAction(sheet, async () => {
    const entry = snapshot();
    if (!entry.id) {
      entry.id = entry.archivePath;
      const taken = new Set((consoleConfig.channels || consoleConfig.cameras).flatMap(item => [item.id, item.name]));
      for (let suffix = 2; taken.has(entry.id); suffix++) entry.id = `${entry.archivePath.slice(0, 55)}-${suffix}`;
    }
    entry.name ||= entry.archivePath || entry.id;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)) throw new Error('请填写有效 MediaMTX 路径，只用字母、数字、短横线或下划线。');
    if (entry.archivePath && !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.archivePath)) throw new Error('MediaMTX 路径必须是单层目录名称。');
    if (!entry.deviceId && !entry.archivePath) entry.archivePath = entry.id;
    if (entry.deviceId && !entry.channel) throw new Error('请选择关联录像机的有效通道，或取消 DVR 关联。');
    if (!entry.archivePath) delete entry.archivePath;
    if (!savedCamera && consoleConfig.cameras.some(item => item.id === entry.id)) throw new Error('该 ID 已存在，请使用不同 ID。');
    if (savedCamera && !consoleConfig.cameras.some(item => item.id === camera.id)) throw new Error('该映射已被其他会话删除。请关闭后重新添加。');
    const cameras = savedCamera ? consoleConfig.cameras.map(item => item.id === camera.id ? entry : item) : [...consoleConfig.cameras, entry];
    const result = await configRequest('/cameras', 'PUT', { cameras }, sheet.context.revision); acceptConsoleConfig(result); sheet.close(); notify('通道映射已保存。');
  })); name.focus();
}
// 二级视图：每个视图一个渲染函数，参数是与 openDialog 返回值同形的容器（content / actions / error / dialog / close）。
// 手机装进底部弹层；桌面详情面板（第 7 部分）用同一函数装进右侧面板。
function renderDvrSettings(sheet) {
  const notice = configNotice(sheet.content);
  const bar = document.createElement('div'); bar.className = 'settings-toolbar';
  const add = setButtonIcon(addButton(bar, '', 'quiet-button ui-icon-button', () => openDvrEditor()), 'add', '添加录像机');
  const refresh = addSettingsRefresh(bar, sheet, loadConsoleConfig, '重新读取来源配置', '来源配置已刷新。');
  const list = document.createElement('div'); list.className = 'config-list';
  sheet.content.append(bar, list);
  trackSettingsView('dvr', sheet, () => {
    const config = consoleConfig, locked = !config || config.preparationOnly;
    notice.hidden = !config?.preparationOnly; add.disabled = locked;
    list.replaceChildren();
    for (const dvr of config?.dvrs || []) list.append(createSettingsRow({ document, title: dvr.name, detail: dvr.ip, status: recorderChecks.get(dvr.id) || '', disabled: locked, onClick: () => openRecorderActions(dvr) }));
    if (!config?.dvrs?.length) list.textContent = '还没有录像机';
  });
}
function openDvrSettings() {
  const sheet = configSheet('海康录像机', '', true); if (!sheet) return null; renderDvrSettings(sheet); return sheet;
}
function renderMediaMtxSettings(sheet, draft = null) {
  const notice = configNotice(sheet.content);
  const input = labelledInput(sheet.content, 'Playback URL', draft ?? consoleConfig?.mediamtx?.playbackUrl ?? '', { placeholder: 'http://mediamtx:9996', maxLength: 2048 }); input.inputMode = 'url';
  const help = document.createElement('p'); help.className = 'setting-help'; help.textContent = '只修改应用使用的回放服务地址，不修改录像根目录、SRT 或 MediaMTX 服务。'; sheet.content.append(help);
  // baseline 是输入框与服务器一致时的值；偏离它才算有未保存的修改。
  let baseline = consoleConfig?.mediamtx?.playbackUrl ?? '', armedDiscard = null;
  // 只有真的改过地址才登记草稿：未改动时会话过期不应恢复一个“未保存的输入”。
  let draftRegistered = false;
  input.addEventListener('input', () => { armedDiscard = null; if (!draftRegistered) { draftRegistered = true; registerConfigDraft(sheet, () => openMediaMtxEditor(input.value)); } });
  // 通道入口会替换当前弹层：地址有未保存修改时，同一入口第二次点击才算明确放弃。
  const guarded = (key, open) => () => {
    if (input.value !== baseline && armedDiscard !== key) { armedDiscard = key; sheet.error.textContent = '回放地址尚未保存，再次点击将放弃修改。'; return; }
    open();
  };
  if (draft !== null) { draftRegistered = true; registerConfigDraft(sheet, () => openMediaMtxEditor(input.value)); }
  const bar = document.createElement('div'); bar.className = 'settings-toolbar';
  const heading = document.createElement('h3'); heading.textContent = '通道'; bar.append(heading);
  const refresh = addSettingsRefresh(bar, sheet, loadConsoleConfig, '重新读取来源配置', '来源配置已刷新。');
  const add = setButtonIcon(addButton(bar, '', 'quiet-button ui-icon-button', guarded('add', () => openCameraEditor())), 'add', '手动补充通道');
  const list = document.createElement('div'); list.className = 'config-list';
  sheet.content.append(bar, list);
  const save = addButton(sheet.actions, '保存地址', 'primary-button', () => runConfigAction(sheet, async () => {
    const result = await configRequest('/mediamtx', 'PUT', { playbackUrl: input.value.trim() }, sheet.context.revision); acceptConsoleConfig(result); sheet.close(); notify('回放地址已保存。');
  }));
  trackSettingsView('mediamtx', sheet, () => {
    const config = consoleConfig, locked = !config || config.preparationOnly;
    notice.hidden = !config?.preparationOnly; add.disabled = locked; save.disabled = locked;
    // 配置在弹层打开后才到达：首次得到 revision 时补齐；未编辑的地址同步为服务器值，已编辑的输入原样保留。
    // 之后 revision 再变化不会自动采纳，保存时由服务器按 409 处理。
    if (config && sheet.context.revision == null) {
      sheet.context.revision = config.revision;
      if (input.value === baseline) input.value = baseline = config.mediamtx?.playbackUrl ?? '';
    }
    list.replaceChildren();
    for (const camera of config?.channels || config?.cameras || []) {
      const dvr = config.dvrs.find(item => item.id === camera.deviceId);
      const title = camera.name && camera.name !== camera.id ? `${camera.name} · ${camera.id}` : camera.id;
      const detail = [camera.archivePath && camera.archivePath !== camera.id ? `路径 ${camera.archivePath}` : '', camera.deviceId ? `${dvr?.name || camera.deviceId} / ${camera.channel}` : ''].filter(Boolean).join(' · ');
      list.append(createSettingsRow({ document, title, detail, disabled: locked, onClick: guarded(`camera:${camera.id}`, () => openCameraEditor(camera)) }));
    }
    if (!(config?.channels || config?.cameras)?.length) list.textContent = '暂无通道';
  });
}
function openMediaMtxEditor(draft = null) {
  const sheet = configSheet('MediaMTX', '', true, draft !== null); if (!sheet) return null; renderMediaMtxSettings(sheet, draft); return sheet;
}
// 设置首页一行的数值与状态图标（✓ 绿 / ⚠ 琥珀）；状态必须同时有图标和可读标签。
function setSettingsRow(key, { value = '', tone = '', label = '' } = {}) {
  const valueNode = $(`settings-value-${key}`), status = $(`settings-status-${key}`);
  if (valueNode) { valueNode.textContent = value; valueNode.hidden = !value; }
  if (status) {
    status.hidden = !tone; status.className = `settings-item-status ${tone}`.trim();
    status.innerHTML = tone ? iconSvg(tone === 'ok' ? 'check-circle' : 'warning') : '';
    status.setAttribute('aria-label', tone ? label || (tone === 'ok' ? '正常' : '需要处理') : '');
  }
}

function renderPasswordMode(managed) {
  $('settings-open-password').hidden = managed;
  $('password-card').hidden = managed;
  $('password-form').hidden = managed;
  $('password-help').textContent = managed
    ? '登录密码由服务器配置，修改后需重启服务。'
    : '更新后需重新登录。密码哈希保存在服务器。';
}

let settingsCsrfToken = '';
function renderSettings(settings, integrations) {
  window.consoleSettings = settings; window.consoleIntegrations = integrations;
  const enabled = integrations.cloud189Enabled;
  $('cloud-pill').textContent = '待配置'; $('cloud-pill').hidden = Boolean(integrations.cloud189WorkerAvailable && integrations.cloud189BinaryAvailable); $('cloud-pill').classList.toggle('ok', enabled);
  $('cloud-status').textContent = !integrations.cloud189WorkerAvailable ? '上传服务未运行，请连接账号后重新检测。' : !integrations.cloud189BinaryAvailable ? '上传组件未就绪。' : integrations.cloud189AuthState === 'verified' ? '' : '登录状态待验证，请连接账号或重新检测。';
  $('cloud-status').hidden = !$('cloud-status').textContent;
  $('bili-pill').textContent = '待配置'; $('bili-pill').hidden = Boolean(integrations.bilibiliWorkerAvailable && integrations.bilibiliBinaryAvailable); $('bili-pill').classList.toggle('ok', integrations.bilibiliEnabled);
  $('bili-status').textContent = !integrations.bilibiliWorkerAvailable ? '上传服务未运行，请连接账号后重新检测。' : !integrations.bilibiliBinaryAvailable ? '服务器未安装 biliup。' : !integrations.bilibiliCoverAvailable ? '请设置投稿封面。' : '';
  $('bili-status').hidden = !$('bili-status').textContent;
  setSettingsRow('cloud189', { tone: enabled ? 'ok' : 'warn', label: enabled ? '189 已就绪' : '189 需要处理' });
  setSettingsRow('bilibili', { tone: integrations.bilibiliEnabled ? 'ok' : 'warn', label: integrations.bilibiliEnabled ? 'B站已就绪' : 'B站需要处理' });
}
async function refreshSettingsAfterAccountChange() { await loadSettings(); }
async function loadSettings() { const data = await api('/console/api/settings'); settingsCsrfToken = data.csrfToken || ''; renderSettings(data.settings || {}, data.integrations || {}); renderUploadCover(data.cover); }
$('password-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('password-form').querySelector('button[type="submit"]'); if (submit.disabled) return; submit.disabled = true; const message = $('password-message'); message.textContent = ''; message.classList.remove('error');
  try { await api('/console/api/password', { method: 'POST', body: body({ oldPassword: $('current-password').value, password: $('new-password').value }) }); $('password-form').reset(); loggedOut('密码已更新，旧会话已失效，请用新密码重新登录。'); }
  catch (error) { message.textContent = error.message; message.classList.add('error'); }
  finally { submit.disabled = false; }
});
let coverPreviewRequest = 0, selectedCoverFile = null, coverReadPending = false, coverSaving = false;
function renderUploadCover(cover, fresh = false) {
  if (selectedCoverFile) return;
  cover ||= { present: window.consoleIntegrations?.bilibiliCoverAvailable === true, source: 'server' };
  const image = $('cover-preview');
  $('cover-status').textContent = cover.present ? '' : '尚未设置，请选择封面图片。';
  image.hidden = !cover.present;
  if (cover.present && (!image.getAttribute('src') || fresh)) image.src = appPath('/console/api/settings/bilibili-cover') + (fresh ? `?v=${Date.now()}` : '');
  if (!cover.present) image.removeAttribute('src');
}
function selectUploadCover(files) {
  if (coverSaving) return;
  const message = $('cover-message'), file = files?.[0];
  if (!files?.length) { reportCoverSelectionUnchanged(); return; }
  selectedCoverFile = null; coverReadPending = false;
  message.textContent = ''; message.classList.remove('error'); $('cover-save').disabled = true;
  const requestId = ++coverPreviewRequest;
  if (files.length !== 1 || !['image/png', 'image/jpeg'].includes(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
    $('bili-cover-file').value = ''; renderUploadCover(undefined, true);
    message.textContent = files.length !== 1 ? '一次只能选择一张封面图片。' : '请选择不超过 5 MB 的 PNG 或 JPEG 图片。';
    message.classList.add('error'); return;
  }
  selectedCoverFile = file; coverReadPending = true;
  $('cover-status').textContent = '正在读取新封面…';
  // Gateway CSP permits data images but intentionally rejects blob URLs.
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    if (requestId !== coverPreviewRequest || selectedCoverFile !== file) return;
    coverReadPending = false; $('cover-save').disabled = false;
    $('cover-preview').src = String(reader.result); $('cover-preview').hidden = false; $('cover-status').textContent = '新封面预览，尚未保存';
  });
  reader.addEventListener('error', () => {
    if (requestId !== coverPreviewRequest) return;
    selectedCoverFile = null; coverReadPending = false; $('bili-cover-file').value = ''; renderUploadCover(undefined, true);
    message.textContent = '图片无法读取，请重新选择。'; message.classList.add('error'); $('cover-save').disabled = true;
  });
  reader.readAsDataURL(file);
}
$('bili-cover-file').addEventListener('change', () => selectUploadCover($('bili-cover-file').files));
function reportCoverSelectionUnchanged() {
  if (coverSaving) return;
  const message = $('cover-message'); message.classList.remove('error');
  message.textContent = selectedCoverFile ? '未更改选择，当前新封面尚未保存。' : '未选择新图片，原封面保持不变。';
}
$('bili-cover-file').addEventListener('cancel', reportCoverSelectionUnchanged);
let coverDragDepth = 0;
const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
function clearCoverDrag() { coverDragDepth = 0; $('cover-dropzone').classList.remove('drag-over'); }
// Avoid navigating away (and losing drafts) if a file misses the dropzone.
document.addEventListener('dragover', event => { if (isFileDrag(event)) event.preventDefault(); });
document.addEventListener('drop', event => { if (isFileDrag(event)) { event.preventDefault(); clearCoverDrag(); } });
$('cover-dropzone').addEventListener('dragenter', event => {
  if (!isFileDrag(event)) return; event.preventDefault();
  if (!coverSaving) { coverDragDepth++; $('cover-dropzone').classList.add('drag-over'); }
});
$('cover-dropzone').addEventListener('dragover', event => {
  if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = coverSaving ? 'none' : 'copy';
});
$('cover-dropzone').addEventListener('dragleave', event => {
  if (!isFileDrag(event)) return; event.preventDefault();
  coverDragDepth = Math.max(0, coverDragDepth - 1); if (!coverDragDepth) clearCoverDrag();
});
$('cover-dropzone').addEventListener('drop', event => {
  if (!isFileDrag(event)) return; event.preventDefault(); clearCoverDrag();
  if (coverSaving) return;
  $('bili-cover-file').value = ''; selectUploadCover(event.dataTransfer.files);
});
$('cover-preview').addEventListener('error', () => { $('cover-preview').hidden = true; $('cover-status').textContent = '封面预览暂时无法读取，可以重新选择或保存图片。'; });
$('cover-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('cover-save'), file = selectedCoverFile; if (submit.disabled || !file || coverSaving || coverReadPending) return;
  coverSaving = true; clearCoverDrag(); submit.disabled = $('bili-cover-file').disabled = true; const message = $('cover-message'); message.textContent = '正在保存封面…'; message.classList.remove('error');
  try {
    const data = await api('/console/api/settings/bilibili-cover', { method: 'PUT', headers: { 'Content-Type': file.type, 'X-CSRF-Token': settingsCsrfToken }, body: file });
    $('bili-cover-file').value = ''; selectedCoverFile = null; coverPreviewRequest++;
    renderUploadCover(data.cover || { present: true, source: 'managed' }, true); message.textContent = '封面已保存。'; await loadSettings();
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
  finally { coverSaving = false; $('bili-cover-file').disabled = false; submit.disabled = !selectedCoverFile || coverReadPending; }
});
async function loadCache() {
  const data = await api('/console/api/cache'); const complete = (data.files || []).filter(item => item.complete);
  $('cache-size').textContent = prettyBytes(complete.reduce((sum, item) => sum + item.size, 0));
}
$('clear-cache').addEventListener('click', () => {
  confirmAction('清理完整缓存？', '未完成分片会保留，已完成成片不会删除。', '清理缓存', async () => {
    const result = await api('/console/api/cache', { method: 'DELETE', body: body({}) });
    notify(`已清理 ${result.deletedCount} 个完整缓存，释放 ${prettyBytes(result.deletedSize)}。`); await loadCache();
  });
});

// 账号 / 密码二级视图：内容节点平时待命在 #settings-detail-store，装进容器时原样搬入（保留 id、监听和草稿状态），
// 容器关闭后放回。同一时刻只会有一个容器持有它，openDialog 总是先关掉旧弹层。
function mountSettingsPanel(sheet, id) {
  const panel = $(id), store = $('settings-detail-store');
  sheet.content.append(panel);
  sheet.dialog.addEventListener('close', () => { if (panel.parentNode === sheet.content) store.append(panel); });
}
// 上传状态的手动恢复：只重读设置与账号状态（不发起账号验证），等同进入设置页时的自动刷新。
function addUploadRefresh(sheet) {
  return addSettingsRefresh(sheet.actions, sheet, () => Promise.all([loadSettings(), uploadAccounts.refresh()]), '重新检测上传状态', '上传状态已刷新。');
}
function renderCloud189Settings(sheet) { mountSettingsPanel(sheet, 'settings-cloud189'); addUploadRefresh(sheet); }
function renderBilibiliSettings(sheet) { mountSettingsPanel(sheet, 'settings-bilibili'); addUploadRefresh(sheet); }
// 密码输入不留在待命容器里：弹层关闭（含退出登录触发的关闭）就清空表单。
function renderPasswordSettings(sheet) {
  mountSettingsPanel(sheet, 'password-card');
  sheet.dialog.addEventListener('close', () => { $('password-form').reset(); $('password-message').textContent = ''; });
}
function openSettingsContainer(title, description = '', { trackChanges = true, initialDirty = false } = {}) {
  const host = $('settings-desktop-detail');
  if (!window.matchMedia?.('(min-width: 1024px)').matches || !host) return openDialog(title, description, { trackChanges, initialDirty });
  if (settingsInline && !settingsInline.requestClose(`settings:${title}`)) return null;
  const dialog = document.createElement('section'); dialog.className = 'settings-inline'; dialog.open = true;
  const heading = document.createElement('h2'); heading.textContent = title; heading.tabIndex = -1;
  const content = document.createElement('div'); content.className = 'dialog-body';
  if (description) { const note = document.createElement('p'); note.textContent = description; content.append(note); }
  const error = document.createElement('p'); error.className = 'dialog-error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  dialog.append(heading, content, error, actions); host.replaceChildren(dialog);
  let dirty = Boolean(initialDirty), armed = null, pending = false, closed = false, shell = null, waitingDialog = null;
  const disabled = new Map();
  const sheet = { dialog, content, error, actions,
    close() {
      if (closed) return; closed = true;
      if (settingsInline === sheet) settingsInline = null;
      dialog.open = false; dialog.dispatchEvent(new Event('close')); dialog.remove();
      if (shell?.dialog.open) shell.close();
    },
    requestClose(key) {
      if (pending) { error.textContent = '正在保存，请稍候。'; return false; }
      if (dirty && armed !== key) { armed = key; error.textContent = '有未保存的修改，再次选择将放弃修改。'; return false; }
      sheet.close(); return true;
    },
    setPending(value) {
      pending = value; dialog.setAttribute('aria-busy', String(value));
      if (!value) shell?.setPending(false);
      for (const node of dialog.querySelectorAll('button, input')) {
        if (value) { if (!disabled.has(node)) disabled.set(node, node.disabled); node.disabled = true; }
        else node.disabled = disabled.get(node) ?? node.disabled;
      }
      if (!value) disabled.clear(); else shell?.setPending(true);
    },
    adapt() {
      if (closed || shell || window.innerWidth >= 1024) return;
      if (activeDialog?.open) {
        if (waitingDialog !== activeDialog) {
          waitingDialog = activeDialog; waitingDialog.addEventListener('close', () => { waitingDialog = null; sheet.adapt(); }, { once: true });
        }
        return;
      }
      // 缩窄窗口时整块移入原生弹层，不重建输入、监听或版本校验上下文。
      shell = openDialog(title, '', { trackChanges, initialDirty: dirty }); shell.content.append(dialog);
      heading.hidden = true; shell.dialog.addEventListener('close', () => sheet.close());
      if (pending) shell.setPending(true);
    },
  };
  dialog.addEventListener('input', () => { if (trackChanges) { dirty = true; armed = null; } });
  settingsInline = sheet; heading.focus({ preventScroll: true }); return sheet;
}
window.addEventListener('resize', () => settingsInline?.adapt());
function openSettingsPanel(title, render) {
  const sheet = openSettingsContainer(title, '', { trackChanges: false }); if (!sheet) return null;
  sheet.dialog.classList.add('settings-dialog'); render(sheet); return sheet;
}
const settingsDetails = {
  dvr: openDvrSettings,
  mediamtx: openMediaMtxEditor,
  cloud189: () => openSettingsPanel('189', renderCloud189Settings),
  bilibili: () => openSettingsPanel('B站', renderBilibiliSettings),
  password: () => openSettingsPanel('访问密码', renderPasswordSettings),
};
for (const row of document.querySelectorAll('[data-settings-open]')) row.addEventListener('click', () => settingsDetails[row.dataset.settingsOpen]());

function openPlaybackTimeEditor() {
  const date = state.date, context = playbackContextKey();
  const sheet = openDialog('定位时间', date);
  const input = enhanceTimeInput(labelledInput(sheet.content, '播放位置', boundaryLabel(state.cursorMs ?? dateStart(date)), { placeholder: '2140 或 214025', maxLength: 8 }));
  input.setAttribute('aria-description', '北京时间，可输入 4 或 6 位数字；定位不会改变入点和出点。');
  addButton(sheet.actions, '编辑选段', 'secondary-button', () => { sheet.close(); openRangeEditor(); });
  addButton(sheet.actions, '定位', 'primary-button', async () => {
    try {
      requirePlaybackContext(context);
      const ms = rangeTimeMs(input.value, date);
      if (ms > timelineLimit()) throw new Error('所选时间尚未发生，请选择过去的时间。');
      // 复用时间轴的定位入口，保持导出边界与单路预览语义。
      sheet.setPending(true);
      await jumpToTimelineTime(ms, 'detail', { autoplay: false });
      sheet.close();
    } catch (error) { sheet.setPending(false); sheet.error.textContent = error.message; }
  });
  input.focus();
}
function openRangeEditor() {
  const date = state.date, context = playbackContextKey();
  const sheet = openDialog('编辑选段', date);
  const fields = document.createElement('div'); fields.className = 'time-fields'; sheet.content.append(fields);
  const initialStart = state.inMs ?? state.cursorMs ?? dateStart(state.date);
  const initialEnd = state.outMs ?? Math.min(initialStart + 60000, dateStart(state.date) + 86400000);
  const start = enhanceTimeInput(labelledInput(fields, '入点', boundaryLabel(initialStart), { placeholder: '2140 或 214025', maxLength: 8 }));
  const endValue = boundaryLabel(initialEnd);
  const end = enhanceTimeInput(labelledInput(fields, '出点', endValue, { placeholder: '2140 或 214035', maxLength: 8 }));
  start.setAttribute('aria-description', '北京时间，可输入 4 或 6 位数字，自动补冒号。');
  end.setAttribute('aria-description', '北京时间，可输入 4 或 6 位数字；240000 表示当天结束。');
  const summary = document.createElement('p'); summary.className = 'range-preview'; summary.setAttribute('aria-live', 'polite'); sheet.content.append(summary);
  const read = () => { requirePlaybackContext(context); const a = rangeTimeMs(start.value, date), b = rangeTimeMs(end.value, date, true); if (b <= a) throw new Error('结束时间必须晚于开始时间；跨日片段请按日期分开导出。'); return [a, b]; };
  const preview = () => { try { const [a, b] = read(); summary.textContent = formatClipDuration(b - a); } catch (error) { summary.textContent = error.message; } };
  start.addEventListener('input', preview); end.addEventListener('input', preview); preview();
  addButton(sheet.actions, '应用选段', 'primary-button', () => { try {
    [state.inMs, state.outMs] = read(); $('mark-in').classList.add('active'); $('mark-out').classList.add('active');
    // Keep the current viewport span: fit short selections, or show the start boundary
    // of longer ones without shortening the selected export range or seeking.
    setTimelineWindow(state.inMs + Math.min(state.outMs - state.inMs, timelineWindow().span) / 2);
    updateSelection(); sheet.close();
  } catch (error) { sheet.error.textContent = error.message; } });
  start.focus();
}
function recoverOutputRename(file) {
  if (!file.renamePending) return;
  const sheet = openDialog('恢复未完成的改名', `${file.filename}。将核对现有文件并恢复名称记录；若文件正被任务占用，请稍后重试。`);
  let pending = false;
  const recover = addButton(sheet.actions, '恢复改名', 'primary-button', async () => {
    if (pending) return; pending = true; sheet.setPending(true); sheet.error.textContent = ''; recover.textContent = '正在恢复…';
    try {
      const result = await api(`/console/api/outputs/${file.id}/recover-rename`, { method: 'POST', body: body({}) });
      if (!Array.isArray(result.outputs)) throw new Error('恢复结果暂未同步，请重试确认。');
      state.outputs = result.outputs; renderOutputs(); sheet.close(); notify('改名记录已恢复。');
    } catch (error) {
      sheet.error.textContent = `${error.message} 当前成片列表与画面已保留，可稍后重试。`;
      sheet.setPending(false); recover.textContent = '恢复改名';
    } finally { pending = false; }
  });
}
function renameOutput(file) {
  const sheet = openDialog('改名');
  const input = labelledInput(sheet.content, '名称', file.filename.replace(/(?:\.mp4)+$/i, ''), { maxLength: 240 });
  const save = addButton(sheet.actions, '保存', 'primary-button', async () => {
    let newName; try { newName = normalizeMp4Name(input.value); } catch (error) { sheet.error.textContent = error.message; return; }
    if (newName === file.filename) { sheet.close(); return; }
    sheet.error.textContent = ''; sheet.setPending(true); save.textContent = '正在保存…';
    try {
      await api(`/console/api/outputs/${file.id}`, { method: 'PUT', body: body({ newName }) });
      file.filename = newName; renderOutputs(); sheet.close(); notify('文件名已更新。');
      refreshOutputs().catch(() => notify('名称已保存，列表同步失败，请刷新列表。', true));
    } catch (error) { sheet.setPending(false); save.textContent = '保存'; sheet.error.textContent = error.message; input.focus(); refreshOutputs().catch(() => {}); }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); } });
  // Synchronous focus retains iOS keyboard activation; select only on opening.
  input.focus({ preventScroll: true }); input.select(); input.setSelectionRange(0, input.value.length);
}
function confirmAction(title, description, label, action) {
  const sheet = openDialog(title, description);
  addButton(sheet.actions, '取消', 'quiet-button', () => sheet.close());
  const confirm = addButton(sheet.actions, label, 'danger-button', async () => {
    sheet.setPending(true); confirm.textContent = '正在处理…';
    try { await action(); sheet.close(); } catch (error) { sheet.setPending(false); confirm.textContent = label; sheet.error.textContent = error.message; }
  });
}
function reauthenticateForUploads() {
  const sheet = openDialog('重新登录控制台', '连接上传账号前，需要重新登录一次。现有控制台会话仍可正常使用，未保存的平台设置会保留在此页面。', { trackChanges: false });
  addButton(sheet.actions, '暂不重新登录', 'quiet-button', () => sheet.close());
  const confirm = addButton(sheet.actions, '退出并重新登录', 'primary-button', async () => {
    if (confirm.disabled) return; sheet.setPending(true); sheet.error.textContent = '';
    try {
      await uploadAccounts.stop(); await requestJson('/status/logout', { method: 'POST' });
      sheet.close(); loggedOut('请重新登录后连接上传账号。未保存的平台设置已保留。');
    } catch (error) { sheet.setPending(false); sheet.error.textContent = error.message; }
  });
}
function updatePlaybackContext() {
  const dvr = $('playback-source').value === 'dvr';
  const sourcePicker = $('quick-source-select'), recorder = $('dvr-select');
  const sources = [{ value: 'mediamtx', textContent: 'MediaMTX', disabled: false }, ...[...recorder.options].filter(option => option.value).map(option => ({ value: `dvr:${option.value}`, textContent: option.textContent, disabled: option.disabled }))];
  const sourceSignature = sources.map(option => `${option.value}:${option.textContent}:${option.disabled}`).join('|');
  if (sourcePicker.dataset.options !== sourceSignature) {
    sourcePicker.replaceChildren(...sources.map(item => { const option = document.createElement('option'); Object.assign(option, item); return option; }));
    sourcePicker.dataset.options = sourceSignature;
  }
  sourcePicker.value = dvr ? `dvr:${recorder.value}` : 'mediamtx';
  const original = $(dvr ? 'dvr-channel' : 'camera-select'), quick = $('quick-camera-select');
  const signature = [...original.options].map(option => `${option.value}:${option.textContent}:${option.disabled}`).join('|');
  if (quick.dataset.options !== signature) {
    quick.replaceChildren(...[...original.options].map(option => option.cloneNode(true)));
    quick.dataset.options = signature;
  }
  quick.value = original.value; quick.disabled = original.disabled || !original.options.length;
  const date = $('date-select').value;
  $('playback-context-date').textContent = date ? date.slice(5) : '日期';
  $('playback-context').setAttribute('aria-label', date ? `选择日期，当前 ${date}` : '选择日期');
  $('playback-context').title = date || '选择日期';
  const live = $('go-live'); live.hidden = state.previewMode === 'live' && !state.previewFailed && !$('replay-player').error && !$('replay-player').ended; live.disabled = !hasPlaybackSelection(); live.setAttribute('aria-pressed', String(state.previewMode === 'live'));
}
function changeQuickPlaybackSource() {
  const value = $('quick-source-select').value, original = $('playback-source'), recorder = $('dvr-select');
  if (value === 'mediamtx') {
    if (original.value === 'mediamtx') return;
    original.value = 'mediamtx'; original.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (value.startsWith('dvr:')) {
    const id = value.slice(4);
    if (![...recorder.options].some(option => option.value === id && !option.disabled)) return;
    const previous = recorder.value; recorder.value = id;
    if (original.value !== 'dvr') { original.value = 'dvr'; original.dispatchEvent(new Event('change', { bubbles: true })); }
    else if (previous !== id) recorder.dispatchEvent(new Event('change', { bubbles: true }));
  }
  updatePlaybackContext();
}
async function refreshPlaybackChoices() {
  const key = () => [state.playbackSource, state.selectedCamera, $('dvr-select').value, $('dvr-channel').value, state.date].join('|');
  const selection = key(), requestId = state.playbackChoicesRequestId = (state.playbackChoicesRequestId || 0) + 1;
  try {
    const data = await api('/console/api/bootstrap');
    if (requestId !== state.playbackChoicesRequestId || document.body.dataset.view !== 'replay' || key() !== selection) return;
    const previousCamera = state.selectedCamera, previousDvr = $('dvr-select').value;
    fillCameras(data.cameras || []); fillDvrDevices(data.dvrs || []); updatePlaybackContext();
    if (state.playbackSource === 'dvr' && previousDvr !== $('dvr-select').value) {
      state.playbackSelectionVersion = (state.playbackSelectionVersion || 0) + 1;
      clearMarkedRange(); invalidatePlaybackSelection(); await loadDvrChannels(); await loadSegments();
    } else if (state.playbackSource !== 'dvr' && previousCamera !== state.selectedCamera) {
      state.playbackSelectionVersion = (state.playbackSelectionVersion || 0) + 1;
      clearMarkedRange(); invalidatePlaybackSelection(); await loadSegments();
    }
  } catch (error) {
    if (requestId === state.playbackChoicesRequestId && document.body.dataset.view === 'replay' && key() === selection) setPlaybackNotice(error.message, true);
  }
}
function openPlaybackDate() {
  return openCalendar({ value: $('date-select').value || state.date, today, description: '', onSelect: value => {
    $('date-select').value = value; $('date-select').dispatchEvent(new Event('change', { bubbles: true }));
  } });
}
function openPlaybackConfiguration() {
  // Existing recovery actions now point to the direct controls, never a second
  // copy of source/channel/date selectors in an oversized dialog.
  updatePlaybackContext();
  $('quick-source-select').scrollIntoView?.({ block: 'nearest' });
  $('quick-source-select').focus();
}

function reloadApplication() {
  if (settingsInline && !settingsInline.requestClose('reload-application')) return;
  cancelReplayHold();
  const target = new URL(location.href);
  target.searchParams.set('_reload', String(Date.now()));
  location.replace(target.href);
}
function setupTouchControls() {
  document.querySelectorAll('input[type="password"]').forEach(input => { const wrapper = document.createElement('div'); wrapper.className = 'password-control'; input.before(wrapper); wrapper.append(input); const toggle = addButton(wrapper, '显示', '', () => { const visible = input.type === 'password'; input.type = visible ? 'text' : 'password'; toggle.textContent = visible ? '隐藏' : '显示'; toggle.setAttribute('aria-pressed', String(visible)); }); toggle.setAttribute('aria-label', '显示或隐藏密码'); toggle.setAttribute('aria-pressed', 'false'); });
  updateOutputSort();
  $('edit-range').addEventListener('click', openRangeEditor);
  $('timeline-time-editor').addEventListener('click', openPlaybackTimeEditor);
  document.querySelectorAll('[data-app-reload]').forEach(button => button.addEventListener('click', reloadApplication));
  $('playback-context').addEventListener('click', openPlaybackDate);
  $('quick-source-select').addEventListener('change', changeQuickPlaybackSource);
  $('quick-source-select').addEventListener('focus', refreshPlaybackChoices);
  $('quick-camera-select').addEventListener('change', () => {
    const original = $(state.playbackSource === 'dvr' ? 'dvr-channel' : 'camera-select');
    if (original.disabled) return;
    original.value = $('quick-camera-select').value;
    original.dispatchEvent(new Event('change', { bubbles: true }));
    updatePlaybackContext();
  });
  ['playback-source', 'camera-select', 'dvr-select', 'dvr-channel'].forEach(id => $(id).addEventListener('change', updatePlaybackContext));
  new MutationObserver(updatePlaybackContext).observe($('playback-toolbar'), { childList: true, subtree: true, attributes: true });
  $('date-select').addEventListener('change', updatePlaybackContext); updatePlaybackContext();
}

async function boot() {
  $('date-select').value = state.date = today();
  showBoot('检查已保存的登录状态…');
  try {
    const auth = await requestJson('/console/api/auth');
    if (!auth.configured) { setAuthMode(false); setConnection('等待初始化'); }
    else {
      const bootstrap = await requestJson('/console/api/bootstrap');
      await start(bootstrap);
    }
  } catch (error) {
    if (error.status === 401) { loggedOut(''); return; }
    showBootError('暂时无法检查登录状态。', error.message);
  }
}
$('boot-retry').addEventListener('click', () => boot());
setupTouchControls();
setupDebugMark({ $, state, debugMark });
document.querySelectorAll('[data-timeline-span]').forEach(button => button.addEventListener('click', () => setTimelineSpan(Number(button.dataset.timelineSpan))));
syncTimelineZoomButtons();
boot();

// Move shared overlays into the fullscreen subtree; top-layer membership cannot be fixed with z-index.
const replayOverlayHome = $('replay-overlays')?.parentElement;
let syncDesktopReplayLayout = null;
let replayFullscreenPending = false, replayFullscreenGeneration = 0, replayFullscreenWanted = false, replayFullscreenExit = null;
function syncReplayFullscreen() {
  const view = $('view-replay'), overlays = $('replay-overlays');
  const active = document.body.dataset.view === 'replay';
  if (!active) view.classList.remove('replay-expanded');
  const expanded = active && (document.fullscreenElement === view || view.classList.contains('replay-expanded'));
  const parent = expanded ? view : replayOverlayHome;
  if (overlays && parent && overlays.parentElement !== parent) parent.append(overlays);
  $('replay-fullscreen')?.setAttribute('aria-label', expanded ? '退出全屏回放' : '全屏回放');
  syncDesktopReplayLayout?.();
}
function cancelReplayFullscreenEntry() {
  replayFullscreenGeneration++; replayFullscreenWanted = false;
  $('view-replay').classList.remove('replay-expanded'); syncReplayFullscreen();
}
function leaveReplayFullscreen() {
  interruptTimelineScrub();
  cancelReplayFullscreenEntry();
  if (replayFullscreenExit) return replayFullscreenExit;
  if (document.fullscreenElement !== $('view-replay')) return Promise.resolve(true);
  replayFullscreenExit = (async () => {
    try { await document.exitFullscreen(); return document.fullscreenElement !== $('view-replay'); }
    catch { return false; }
    finally { replayFullscreenExit = null; syncReplayFullscreen(); }
  })();
  return replayFullscreenExit;
}
$('replay-fullscreen')?.addEventListener('click', async () => {
  if (replayFullscreenPending || replayFullscreenExit || document.body.dataset.view !== 'replay') return;
  interruptTimelineScrub();
  replayFullscreenPending = true;
  const view = $('view-replay');
  const generation = ++replayFullscreenGeneration;
  try {
    if (document.fullscreenElement === view || view.classList.contains('replay-expanded')) await leaveReplayFullscreen();
    else {
      replayFullscreenWanted = true;
      if (view.requestFullscreen) {
        try { await view.requestFullscreen(); }
        catch { if (generation === replayFullscreenGeneration && document.body.dataset.view === 'replay') view.classList.add('replay-expanded'); }
      } else view.classList.add('replay-expanded');
      // A request can settle after navigation/Escape; never resurrect the old replay session.
      if (generation !== replayFullscreenGeneration || document.body.dataset.view !== 'replay') await leaveReplayFullscreen();
    }
  } finally { replayFullscreenPending = false; syncReplayFullscreen(); }
});
document.addEventListener('fullscreenchange', () => {
  interruptTimelineScrub();
  syncReplayFullscreen();
  if (document.fullscreenElement === $('view-replay') && (!replayFullscreenWanted || document.body.dataset.view !== 'replay')) void leaveReplayFullscreen();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !activeDialog?.open && !event.defaultPrevented) void leaveReplayFullscreen(); });

// 断点只搬运同一组控件，不创建第二份选择状态或 API 请求入口。
function setupDesktopReplayLayout() {
  const side = document.querySelector('#view-replay .selection-panel');
  const quick = document.querySelector('.playback-quick-controls');
  const marks = document.querySelector('#view-replay .mark-controls');
  const slot = document.createElement('div'); slot.className = 'desktop-replay-controls'; side.insertBefore(slot, side.firstChild);
  const placements = [quick, marks].map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
  const sync = () => {
    const view = $('view-replay');
    const desktop = window.innerWidth >= 1024 && document.fullscreenElement !== view && !view.classList.contains('replay-expanded');
    for (const entry of placements) {
      const parent = desktop ? slot : entry.parent;
      if (entry.node.parentNode !== parent) {
        if (desktop) parent.append(entry.node);
        else parent.insertBefore(entry.node, entry.next?.parentNode === parent ? entry.next : null);
      }
    }
    slot.hidden = !desktop;
  };
  syncDesktopReplayLayout = sync; window.addEventListener('resize', sync); sync();
}
setupDesktopReplayLayout();

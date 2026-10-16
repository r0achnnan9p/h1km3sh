import { iconSvg } from './ui-primitives.js';
import { activeDialog, enhanceSelect, enhanceDateInput, normalizeMp4Name } from './touch-controls.js';
import { taskProgressPresentation, taskProgressCaption } from './task-presentation.js';
import * as api from './api.js';
import { createTimeline } from './timeline.js';
import {
  DAY_SECONDS, secondsToTimeStr, timeStrToSeconds, formatHikTime,
  isoTimeToSeconds, formatFileSize, formatBitrate, todayLocalDate, toast, confirmDialog,
  promptDialog, containDialogFocus, esc,
} from './util.js';

const $ = (id) => document.getElementById(id);
const clamp = (s) => Math.max(0, Math.min(DAY_SECONDS - 1, Math.round(s)));

// --- Elements ---
const deviceSelect = $('deviceSelect');
const btnAddDevice = $('btnAddDevice');
const btnDeleteDevice = $('btnDeleteDevice');
const statusDot = $('statusDot');
const channelSelect = $('channelSelect');
const dateSelect = $('dateSelect');
const btnPrevDay = $('btnPrevDay');
const btnNextDay = $('btnNextDay');
const btnToday = $('btnToday');
const btnSettings = $('btnSettings');

const stageEmpty = $('stageEmpty');
const btnEmptyAdd = $('btnEmptyAdd');
const stageChip = $('stageChip');
const previewImage = $('previewImage');
const previewLoader = $('previewLoader');
const loaderText = previewLoader.querySelector('.loader-text');
const previewTimeOverlay = $('previewTimeOverlay');
const stageTime = $('stageTime');
const timelineNote = $('timelineNote');

const startTime = $('startTime');
const endTime = $('endTime');
const durationText = $('durationText');
const currentTimeText = $('currentTimeText');
const recInfoChip = $('recInfoChip');
const btnMarkIn = $('btnMarkIn');
const btnMarkOut = $('btnMarkOut');
const btnExport = $('btnExport');

const exportProgress = $('exportProgress');
const epFill = $('epFill');
const exportStatusText = $('exportStatusText');
const exportSpeedText = $('exportSpeedText');
const exportPercentage = $('exportPercentage');
const btnStopExport = $('btnStopExport');

const settingsDrawer = $('settingsDrawer');
const drawerBackdrop = $('drawerBackdrop');
const btnCloseDrawer = $('btnCloseDrawer');
const cacheSummaryText = $('cacheSummaryText');
const btnRefreshCache = $('btnRefreshCache');
const btnClearCache = $('btnClearCache');
const cacheFileList = $('cacheFileList');

const outputsSummaryText = $('outputsSummaryText');
const btnRefreshOutputs = $('btnRefreshOutputs');
const outputFileList = $('outputFileList');

const scheduleList = $('scheduleList');

const addDeviceDialog = $('addDeviceDialog');
const dialogIp = $('dialogIp');
const dialogUser = $('dialogUser');
const dialogPass = $('dialogPass');
const btnDialogCancel = $('btnDialogCancel');
const btnDialogConfirm = $('btnDialogConfirm');
const btnDialogTogglePass = $('btnDialogTogglePass');

const stage = $('stage');
const btnPlayPause = $('btnPlayPause');
const btnPlayOverlay = $('btnPlayOverlay');
const exportMethodSelect = $('exportMethodSelect');

const EXPORT_ICON = iconSvg('download', 'ic');
const PLAYBACK_WINDOW_SEC = 600; // 与 /api/preview-stream 默认窗口一致

// --- State ---
let timeline;
let currentDevice = null;
let deviceList = [];
let activeDeviceId = null;
let dayRecordings = [];
let playheadSec = 8 * 3600;
let previewTimeout = null;
let previewAbort = null;
let sseSource = null;
let isExporting = false;
let currentTaskId = null;
let playing = false;
let playbackTicker = null;
let playbackStartSec = 0;
let playbackStartWall = 0;
// 从「发起一次 seek（拖动/按键）」到「防抖真正触发重新拉流/抓帧」之间，
// playheadSec 是用户刚设置的目标值，播放中的位置估算 ticker 绝不能在这
// 期间用旧播放流算出的位置覆写它——否则连续按方向键时会被每 500ms 一次的
// ticker 回写冲掉，表现为“步进错乱”。seekTo 是所有 seek 路径（键盘、拖动
// 时间轴）的唯一入口，在此统一加锁即可覆盖所有场景。
let seekPending = false;

// --- Session persistence ---
// 状态存服务端（data/session.json）而不是 localStorage，换浏览器或换电脑访问同一个
// 实例看到的是同一份。日期同起止时间一并恢复；要跳回今天用「今天」按钮。
// 拖动选区会高频触发保存，必须防抖，否则每动一下都发一次 PUT。
const SESSION_SAVE_DEBOUNCE_MS = 500;
let sessionSaveTimer = null;

function saveSession() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    api.saveSession({
      date: dateSelect.value,
      startTime: startTime.value,
      endTime: endTime.value,
      channel: channelSelect.value,
      exportMethod: exportMethodSelect.value,
    }).catch(() => { /* 保存失败不打扰用户，下次操作会再存一次 */ });
  }, SESSION_SAVE_DEBOUNCE_MS);
}

// --- Connection status ---
function setStatus(state, info = '') {
  statusDot.className = 'status-dot status-' + state;
  const titles = { idle: '未连接', connecting: '连接中…', connected: '已连接 ' + info, error: '连接失败' };
  statusDot.title = titles[state] || '';
}

// --- Selection (in/out) ---
function getSelSecs() {
  return { inSec: timeStrToSeconds(startTime.value), outSec: timeStrToSeconds(endTime.value) };
}

function setSelection(inSec, outSec, { syncTimeline = true } = {}) {
  inSec = clamp(inSec);
  outSec = Math.max(inSec + 1, clamp(outSec));
  startTime.value = secondsToTimeStr(inSec);
  endTime.value = secondsToTimeStr(outSec);
  durationText.textContent = secondsToTimeStr(Math.max(0, outSec - inSec));
  if (syncTimeline && timeline) timeline.setSelection(inSec, outSec);
  updateRecChip(inSec, outSec);
}

function updateRecChip(inSec, outSec) {
  if (!dayRecordings.length) { recInfoChip.hidden = true; return; }
  const overlap = dayRecordings.filter((r) => r.endSec > inSec && r.startSec < outSec);
  recInfoChip.hidden = false;
  if (!overlap.length) { recInfoChip.textContent = '所选区间无录像'; return; }
  const size = overlap.reduce((s, r) => s + r.size, 0);
  recInfoChip.textContent = `${overlap.length} 段 · ${formatFileSize(size)}`;
}

// --- Seek / preview ---
//
// seekTo() 是所有 seek 交互（键盘方向键、拖动时间轴）唯一入口。playheadSec
// 在这里同步更新，真正的重新拉流/抓帧则防抖延迟执行；seekPending 在这段
// 等待期间挡住播放 ticker 的位置回写，见顶部变量声明处的说明。
function seekTo(sec, debounceMs = 400) {
  playheadSec = clamp(sec);
  seekPending = true;
  const timeStr = secondsToTimeStr(playheadSec);
  if (timeline) timeline.setPlayhead(playheadSec);
  stageTime.textContent = timeStr;
  currentTimeText.textContent = timeStr;

  previewTimeOverlay.hidden = false;
  previewTimeOverlay.textContent = timeStr;

  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    previewTimeOverlay.hidden = true;
    seekPending = false;
    if (playing) startPlayback(playheadSec);
    else updatePreview(playheadSec);
  }, debounceMs);
}

function showLoader(text = '加载中…') {
  stageEmpty.hidden = true;
  previewImage.hidden = true;
  previewLoader.hidden = false;
  loaderText.textContent = text;
}

function showImage(blob) {
  const url = URL.createObjectURL(blob);
  const prev = previewImage.src;
  previewImage.onload = () => {
    previewLoader.hidden = true;
    previewImage.hidden = false;
    stageTime.hidden = false;
    stageChip.hidden = false;
    stageChip.textContent = '回放';
    if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
  };
  previewImage.onerror = () => URL.revokeObjectURL(url);
  previewImage.src = url;
}

async function updatePreview(sec) {
  if (!currentDevice) return;
  const channel = channelSelect.value;
  const date = dateSelect.value;
  if (!channel || !date) return;

  if (previewAbort) previewAbort.abort();
  const ctl = new AbortController();
  previewAbort = ctl;

  const hikTime = formatHikTime(date, secondsToTimeStr(sec));
  const params = { ip: currentDevice.ip, user: currentDevice.user, pass: currentDevice.pass, channel, time: hikTime };

  showLoader();
  try {
    let blob = await api.fetchPreviewBlob('/api/preview', params, ctl.signal);
    if (!blob && !ctl.signal.aborted) {
      loaderText.textContent = '通过下载方式获取画面（较慢）…';
      blob = await api.fetchPreviewBlob('/api/preview-via-download', params, ctl.signal);
    }
    if (ctl.signal.aborted) return;
    if (blob) {
      showImage(blob);
    } else {
      previewLoader.hidden = true;
      toast('获取画面失败，请检查该时间点是否有录像', 'error');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    previewLoader.hidden = true;
    toast('预览失败: ' + err.message, 'error');
  }
}

// --- Playback (MJPEG live-ish replay via /api/preview-stream) ---

function stopPlaybackTicker() {
  if (playbackTicker) { clearInterval(playbackTicker); playbackTicker = null; }
}

function updatePlayButton() {
  const label = playing ? '暂停' : '播放';
  btnPlayPause.setAttribute('aria-label', label);
  btnPlayPause.classList.toggle('is-playing', playing);
  btnPlayOverlay.setAttribute('aria-label', label);
  [btnPlayPause, btnPlayOverlay].forEach((btn) => {
    btn.querySelector('.ic-play').hidden = playing;
    btn.querySelector('.ic-pause').hidden = !playing;
  });
}

function startPlayback(sec) {
  if (!currentDevice) return;
  const channel = channelSelect.value;
  const date = dateSelect.value;
  if (!channel || !date) return;

  stopPlaybackTicker();
  if (previewAbort) previewAbort.abort();

  sec = clamp(sec);
  playing = true;
  playbackStartSec = sec;
  playbackStartWall = Date.now();
  updatePlayButton();

  const hikTime = formatHikTime(date, secondsToTimeStr(sec));
  const qs = new URLSearchParams({
    ip: currentDevice.ip, user: currentDevice.user, pass: currentDevice.pass,
    channel, time: hikTime, duration: String(PLAYBACK_WINDOW_SEC), t: Date.now(),
  });

  showLoader('正在连接回放流…');
  previewImage.onload = () => {
    previewLoader.hidden = true;
    previewImage.hidden = false;
    stageTime.hidden = false;
    stageChip.hidden = false;
    stageChip.innerHTML = '<span class="live-badge">回放中 · 1X</span>';
  };
  previewImage.onerror = () => {
    if (!playing) return; // 我们主动断流触发的 error，忽略
    stopPlaybackTicker();
    playing = false;
    updatePlayButton();
    previewLoader.hidden = true;
    toast('回放流中断，请重试或检查该时间点是否有录像', 'error');
  };
  previewImage.src = '/api/preview-stream?' + qs.toString();

  // 播放位置估算（服务端按 1X 实时拉流）：驱动时间轴播放头与时间读数
  playbackTicker = setInterval(() => {
    const elapsed = (Date.now() - playbackStartWall) / 1000;
    const cur = playbackStartSec + elapsed;

    if (cur >= DAY_SECONDS - 1 || elapsed >= PLAYBACK_WINDOW_SEC - 2) {
      if (cur < DAY_SECONDS - 1) startPlayback(Math.floor(cur)); // 窗口将尽，无缝续播
      else pausePlayback();
      return;
    }
    if (!seekPending) {
      playheadSec = Math.floor(cur);
      const timeStr = secondsToTimeStr(playheadSec);
      if (timeline) timeline.setPlayhead(playheadSec);
      stageTime.textContent = timeStr;
      currentTimeText.textContent = timeStr;
    }
  }, 500);
}

function pausePlayback() {
  stopPlaybackTicker();
  if (playing) {
    const elapsed = (Date.now() - playbackStartWall) / 1000;
    playheadSec = clamp(playbackStartSec + elapsed);
    if (timeline) timeline.setPlayhead(playheadSec);
  }
  playing = false;
  previewImage.onload = null;
  previewImage.onerror = null;
  previewImage.removeAttribute('src');
  previewImage.hidden = true;
  updatePlayButton();
  updatePreview(playheadSec);
}

function togglePlayback() {
  if (!currentDevice) return;
  if (playing) pausePlayback();
  else startPlayback(playheadSec);
}

// --- Recordings (full day) ---
function recEndSec(startIso, endIso) {
  const s = isoTimeToSeconds(startIso);
  let e = isoTimeToSeconds(endIso);
  if (e <= s) e = DAY_SECONDS - 1; // crossed midnight
  return e;
}

async function loadDayRecordings() {
  dayRecordings = [];
  if (timeline) timeline.setRecordings([]);
  timelineNote.hidden = true;

  if (!currentDevice) return;
  const channel = channelSelect.value;
  const date = dateSelect.value;
  if (!channel || !date) return;

  const startHik = formatHikTime(date, '00:00:00');
  const endHik = formatHikTime(date, '23:59:59');
  try {
    const data = await api.getRecordings(currentDevice, channel, startHik, endHik);
    if (data.success && data.recordings && data.recordings.length) {
      dayRecordings = data.recordings.map((r) => ({
        startSec: isoTimeToSeconds(r.startTime),
        endSec: recEndSec(r.startTime, r.endTime),
        size: r.size || 0,
      }));
      timeline.setRecordings(dayRecordings);
    } else if (data.success === false && data.error) {
      // 别把「查询失败」伪装成「没录像」：NVR 超时/断连/凭据错都会走到这里，
      // 用户需要知道是网络问题而不是那天没录到东西
      timelineNote.textContent = '查询失败: ' + data.error;
      timelineNote.hidden = false;
    } else {
      timelineNote.textContent = '当天无录像';
      timelineNote.hidden = false;
    }
  } catch (err) {
    timelineNote.textContent = '查询失败: ' + (err?.message || String(err));
    timelineNote.hidden = false;
  }
  const { inSec, outSec } = getSelSecs();
  updateRecChip(inSec, outSec);
}

// --- Mark in / out ---
function markIn() {
  const inSec = playheadSec;
  let outSec = timeStrToSeconds(endTime.value);
  if (!endTime.value || outSec <= inSec) outSec = Math.min(DAY_SECONDS - 1, inSec + 300);
  setSelection(inSec, outSec);
  saveSession();
}

function markOut() {
  const outSec = playheadSec;
  const inSec = timeStrToSeconds(startTime.value);
  if (outSec <= inSec) { toast('出点必须晚于入点', 'error'); return; }
  setSelection(inSec, outSec);
  saveSession();
}

// --- Devices ---
function getSelectedDeviceFromList() {
  const id = deviceSelect.value;
  return id ? deviceList.find((d) => d.id === id) || null : null;
}

async function loadSavedDevices() {
  try {
    const data = await api.getDevices();
    if (data.success) { deviceList = data.devices || []; activeDeviceId = data.activeDeviceId; }
    else { deviceList = []; activeDeviceId = null; }
  } catch (err) {
    deviceList = []; activeDeviceId = null;
  }
  deviceSelect.innerHTML = '<option value="">选择设备…</option>';
  deviceList.forEach((dev) => {
    const o = document.createElement('option');
    o.value = dev.id;
    o.textContent = dev.name || `${dev.ip} (${dev.username})`;
    deviceSelect.appendChild(o);
  });
  if (activeDeviceId) deviceSelect.value = activeDeviceId;
}

function resetDisconnected() {
  if (playing) pausePlayback();
  currentDevice = null;
  setStatus('idle');
  channelSelect.innerHTML = '<option value="">通道</option>';
  channelSelect.disabled = true;
  btnExport.disabled = true;
  stageEmpty.hidden = false;
  previewImage.hidden = true;
  stageTime.hidden = true;
  stageChip.hidden = true;
  if (timeline) timeline.setEnabled(false);
  timelineNote.hidden = true;
  dayRecordings = [];
  if (timeline) timeline.setRecordings([]);
}

async function connectDevice(device, silent = false) {
  if (!device || !device.ip || !device.user || !device.pass) {
    if (!silent) toast('请填写完整设备信息', 'error');
    return;
  }
  setStatus('connecting');
  try {
    const data = await api.getChannels(device);
    if (data.success && data.channels && data.channels.length) {
      channelSelect.innerHTML = '';
      data.channels.forEach((ch) => {
        const o = document.createElement('option');
        o.value = ch.id;
        o.textContent = `通道 ${ch.id} · ${ch.name} · ${ch.resolution}`;
        channelSelect.appendChild(o);
      });
      channelSelect.disabled = false;
      currentDevice = device;
      setStatus('connected', device.ip);
      if (!silent) toast('已连接 ' + device.ip, 'success');

      if (window._restoreChannel) {
        const opt = channelSelect.querySelector(`option[value="${window._restoreChannel}"]`);
        if (opt) channelSelect.value = window._restoreChannel;
        window._restoreChannel = null;
      }

      stageEmpty.hidden = true;
      btnExport.disabled = false;
      timeline.setEnabled(true);
      await loadDayRecordings();
      seekTo(playheadSec, 0);
    } else {
      throw new Error(data.error || '未获取到通道，可能账号密码错误或设备不支持');
    }
  } catch (err) {
    if (!silent) { setStatus('error'); toast('连接失败: ' + err.message, 'error'); }
    else setStatus('idle');
    channelSelect.innerHTML = '<option value="">连接失败</option>';
    channelSelect.disabled = true;
    currentDevice = null;
  }
}

async function deleteSelectedDevice() {
  const id = deviceSelect.value;
  if (!id) return;
  const dev = getSelectedDeviceFromList();
  const ok = await confirmDialog(`确定删除设备「${dev?.name || dev?.ip || id}」？`, { danger: true, confirmText: '删除' });
  if (!ok) return;
  try {
    const data = await api.deleteDevice(id);
    if (!data.success) { toast('删除失败: ' + (data.error || '未知错误'), 'error'); return; }
  } catch (err) {
    toast('删除失败: ' + err.message, 'error'); return;
  }
  await loadSavedDevices();
  deviceSelect.value = '';
  resetDisconnected();
}

// --- Add device dialog ---
let releaseDeviceDialogFocus = null;
function showAddDeviceDialog() {
  dialogIp.value = '';
  dialogUser.value = 'admin';
  dialogPass.value = '';
  dialogPass.type = 'password';
  btnDialogTogglePass.querySelector('.icon-eye').hidden = false;
  btnDialogTogglePass.querySelector('.icon-eye-off').hidden = true;
  addDeviceDialog.hidden = false;
  $('deviceDialogError').textContent = '';
  releaseDeviceDialogFocus?.(); releaseDeviceDialogFocus = containDialogFocus(addDeviceDialog);
  setTimeout(() => dialogIp.focus(), 0);
}
function hideAddDeviceDialog() { if (btnDialogConfirm.disabled) return; addDeviceDialog.hidden = true; releaseDeviceDialogFocus?.(); releaseDeviceDialogFocus = null; }

async function confirmAddDevice() {
  if (btnDialogConfirm.disabled) return;
  const ip = (dialogIp.value || '').trim(), user = (dialogUser.value || '').trim(), pass = dialogPass.value || '';
  const message = $('deviceDialogError'); message.textContent = '';
  if (!ip || !user || !pass) { message.textContent = '请填写设备地址、用户名和密码。'; return; }
  btnDialogConfirm.disabled = true; btnDialogCancel.disabled = true; btnDialogConfirm.textContent = '正在保存…';
  try {
    const data = await api.addDevice(ip, user, pass);
    if (!data.success || !data.device) throw new Error(data.error || '服务器未保存设备，请重试。');
    await loadSavedDevices(); deviceSelect.value = data.device.id;
    await api.activateDevice(data.device.id); activeDeviceId = data.device.id;
    btnDialogConfirm.disabled = false; hideAddDeviceDialog();
    connectDevice({ ip, user, pass });
  } catch (err) { message.textContent = '保存设备失败：' + err.message; }
  finally { btnDialogConfirm.disabled = false; btnDialogCancel.disabled = false; btnDialogConfirm.textContent = '确认并连接'; }
}

// --- Export ---
function setExportLabel(text) { btnExport.innerHTML = EXPORT_ICON + ' ' + text; }

function setupSSE() {
  return new Promise((resolve) => {
    if (sseSource) sseSource.close();
    sseSource = api.openProgressStream();
    let opened = false;
    const done = () => { if (!opened) { opened = true; resolve(); } };
    sseSource.onopen = done;
    sseSource.onerror = done;
    sseSource.onmessage = (e) => handleProgress(JSON.parse(e.data));
  });
}

function handleProgress(data) {
  if (!data.status) return;
  exportStatusText.textContent = data.message || '';
  const presentation = taskProgressPresentation(data);
  exportPercentage.textContent = taskProgressCaption(data) || (presentation.indeterminate ? '处理中' : '');
  epFill.style.width = presentation.hasPercent ? presentation.percent + '%' : '0%';
  epFill.classList.toggle('indeterminate', presentation.indeterminate);
  const parts = [];
  if (data.speedX > 0) parts.push(data.speedX.toFixed(1) + 'x');
  if (data.speed > 0) parts.push(formatBitrate(data.speed));
  exportSpeedText.hidden = parts.length === 0;
  exportSpeedText.textContent = parts.join(' · ');
  if (data.status === 'completed' || data.status === 'error') {
    finishExport(data.status, data.message);
  }
}

function finishExport(status, message) {
  isExporting = false;
  currentTaskId = null;
  btnStopExport.hidden = true;
  exportSpeedText.hidden = true;
  btnExport.disabled = false;
  setExportLabel('导出片段');
  epFill.classList.remove('indeterminate');
  epFill.classList.toggle('done', status === 'completed');
  epFill.classList.toggle('error', status === 'error');
  if (status === 'completed') toast(message || '导出完成', 'success');
  else toast(message || '导出失败或已停止', 'error');
}

async function startExportFlow() {
  if (btnExport.disabled || isExporting) return;
  if (!currentDevice) { toast('请先连接设备', 'error'); return; }
  const channel = channelSelect.value;
  const date = dateSelect.value;
  if (![startTime.value, endTime.value].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))) { toast('请先修正入点和出点时间。', 'error'); return; }
  const { inSec, outSec } = getSelSecs();
  if (!channel || !date) { toast('请完整填写信息', 'error'); return; }
  if (outSec <= inSec) { toast('出点必须晚于入点', 'error'); return; }
  // 出点落在未来时录像还不存在，硬拉会把正在写入的分片下成半截（尺寸校验必然失败）
  const outAt = new Date(`${date}T00:00:00`);
  outAt.setSeconds(outSec);
  if (outAt.getTime() > Date.now()) {
    toast('出点晚于当前时间，该时段录像尚未产生', 'error');
    return;
  }

  const startHik = formatHikTime(date, secondsToTimeStr(inSec));
  const endHik = formatHikTime(date, secondsToTimeStr(outSec));

  // 导出前停掉预览回放，把 NVR 会话让给导出（回放会话池有限，见 rtsp-client.js 顶部说明）
  if (playing) pausePlayback();

  exportProgress.hidden = false;
  epFill.classList.remove('done', 'error');
  epFill.style.width = '0%';
  exportPercentage.textContent = '0%';
  exportStatusText.textContent = '查询录像文件…';

  btnExport.disabled = true;
  try {
    const info = await api.getRecordings(currentDevice, channel, startHik, endHik);
    if (!info.success || !info.fileCount) {
      exportStatusText.textContent = '该时间段无可用录像';
      toast('该时间段内无可用录像文件', 'error');
      return;
    }
    exportStatusText.textContent = `共 ${info.fileCount} 个文件 · ${formatFileSize(info.totalSize)}`;
  } catch (err) {
    exportStatusText.textContent = '查询失败';
    toast('查询录像文件失败: ' + err.message, 'error');
    return;
  } finally { btnExport.disabled = false; }

  isExporting = true;
  btnExport.disabled = true;
  setExportLabel('导出中…');
  btnStopExport.hidden = false;
  exportStatusText.textContent = '正在连接录像机…';

  await setupSSE();
  try {
    const data = await api.startExport({
      ip: currentDevice.ip, user: currentDevice.user, pass: currentDevice.pass,
      channel, startTime: startHik, endTime: endHik, method: exportMethodSelect.value,
    });
    if (!data.success) throw new Error(data.error || '导出请求失败');
    currentTaskId = data.taskId || null;
  } catch (err) {
    finishExport('error', '请求失败: ' + err.message);
  }
}

async function stopExportFlow() {
  if (!isExporting) return;
  try { await api.stopExport(currentTaskId); }
  catch (err) { toast('停止请求失败', 'error'); }
}

async function restoreActiveTaskStatus() {
  try {
    const data = await api.getStatus();
    if (data.success && Array.isArray(data.activeTasks) && data.activeTasks.length) {
      const task = data.activeTasks[0];
      exportProgress.hidden = false;
      exportStatusText.textContent = task.message || '任务进行中…';
      const presentation = taskProgressPresentation(task);
      exportPercentage.textContent = taskProgressCaption(task) || (presentation.indeterminate ? '处理中' : '');
      epFill.style.width = presentation.hasPercent ? presentation.percent + '%' : '0%';
      epFill.classList.toggle('indeterminate', presentation.indeterminate);
      if (task.status === 'completed') { epFill.classList.add('done'); }
      else if (task.status === 'error') { epFill.classList.add('error'); }
      else {
        isExporting = true;
        currentTaskId = task.taskId || null;
        btnExport.disabled = true;
        setExportLabel('导出中…');
        btnStopExport.hidden = false;
        if (!sseSource) setupSSE();
      }
    }
  } catch (err) { /* ignore */ }
}

// --- Cache ---
async function refreshCacheInfo() {
  try {
    btnRefreshCache.disabled = true;
    const data = await api.getCache();
    if (data.success) {
      const count = data.files.length;
      cacheSummaryText.textContent = count > 0
        ? `${count} 个缓存文件，共 ${formatFileSize(data.totalSize)}`
        : '无缓存文件';
      if (count > 0) {
        cacheFileList.hidden = false;
        cacheFileList.innerHTML = data.files.map((f) => `
          <div class="cache-file-item">
            <span class="cache-file-name" title="${f.filename}">${f.filename}</span>
            <span class="cache-file-size">${formatFileSize(f.size)}</span>
            <span class="cache-file-status ${f.complete ? 'complete' : 'partial'}">${f.complete ? '完整' : '部分'}</span>
          </div>`).join('');
      } else {
        cacheFileList.hidden = true;
        cacheFileList.innerHTML = '';
      }
    } else {
      cacheSummaryText.textContent = '获取缓存信息失败';
    }
  } catch (err) {
    cacheSummaryText.textContent = '错误: ' + err.message;
  } finally {
    btnRefreshCache.disabled = false;
  }
}

async function clearAllCache() {
  const ok = await confirmDialog('清理已完成的 DVR 缓存？未完成分片会保留，正在导出的任务会阻止清理。', { danger: true, confirmText: '清理完整缓存' });
  if (!ok) return;
  try {
    btnClearCache.disabled = true;
    const data = await api.clearCache();
    if (data.success) {
      cacheSummaryText.textContent = data.message || '完整缓存已清理，未完成分片已保留';
      cacheFileList.hidden = true;
      cacheFileList.innerHTML = '';
      toast(data.message || '完整缓存已清理，未完成分片已保留', 'success');
    } else {
      toast('清除缓存失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    toast('清除缓存失败: ' + err.message, 'error');
  } finally {
    btnClearCache.disabled = false;
  }
}

// --- Drawer ---
let releaseDrawerFocus = null;
function openDrawer() {
  settingsDrawer.inert = false;
  settingsDrawer.classList.add('open');
  releaseDrawerFocus?.(); releaseDrawerFocus = containDialogFocus(settingsDrawer);
  btnCloseDrawer.focus();
  settingsDrawer.setAttribute('aria-hidden', 'false');
  drawerBackdrop.hidden = false;
  switchDrawerTab(document.querySelector('.drawer-tab.active')?.dataset.tab || 'cache');
}
function closeDrawer() {
  settingsDrawer.classList.remove('open');
  settingsDrawer.setAttribute('aria-hidden', 'true');
  drawerBackdrop.hidden = true;
  releaseDrawerFocus?.(); releaseDrawerFocus = null; settingsDrawer.inert = true;
}

// --- Drawer tabs（缓存 / 成品 / 定时）---
function switchDrawerTab(tab) {
  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab); btn.setAttribute('aria-selected', String(btn.dataset.tab === tab)); btn.tabIndex = btn.dataset.tab === tab ? 0 : -1;
  });
  document.querySelectorAll('.drawer-pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== tab;
  });
  // 懒加载：切到对应 tab 才拉数据，避免打开抽屉时三个请求一起打
  if (tab === 'cache') refreshCacheInfo();
  else if (tab === 'outputs') loadOutputs();
  else if (tab === 'schedule') loadSchedules();
}

// --- Outputs（成品 MP4 列表 / 下载 / 重命名 / 删除）---
function outputRangeText(f) {
  if (!f.startTime || !f.endTime) return '';
  // ISO "2026-08-07T19:30:00Z" → "08-07 19:30 → 22:30"（跨天时结束段带日期）
  const fmt = (iso) => iso.replace('T', ' ').replace(/:\d{2}Z$/, '');
  const s = fmt(f.startTime).slice(5);
  const e = fmt(f.endTime).slice(5);
  return ` ${s} → ${e.slice(0, 5) === s.slice(0, 5) ? e.slice(6) : e}`;
}

function renderOutputs(files) {
  if (!files.length) {
    outputsSummaryText.textContent = '还没有导出过任何成品';
    outputFileList.hidden = true;
    outputFileList.innerHTML = '';
    return;
  }
  outputsSummaryText.textContent = `${files.length} 个成品（新的在前），共 ${formatFileSize(files.reduce((s, f) => s + f.size, 0))}`;
  outputFileList.hidden = false;
  outputFileList.innerHTML = files.map((f) => `
    <div class="output-file-item">
      <div class="output-file-main">
        <span class="output-file-name" title="${esc(f.filename)}">${esc(f.filename)}</span>
        <span class="output-file-meta">${formatFileSize(f.size)}${f.channel ? ' · 通道 ' + esc(f.channel) : ''}${outputRangeText(f)}${f.inProgress ? ' <span class="output-file-busy">导出中</span>' : ''}</span>
      </div>
      <div class="output-file-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(f.url)}" download>下载</a>
        <button class="btn btn-ghost btn-sm" data-act="rename" data-file="${encodeURIComponent(f.filename)}" ${f.inProgress ? 'disabled title="导出中，不能重命名"' : ''}>重命名</button>
        <button class="btn btn-danger btn-sm" data-act="delete" data-file="${encodeURIComponent(f.filename)}" ${f.inProgress ? 'disabled title="导出中，不能删除"' : ''}>删除</button>
      </div>
    </div>`).join('');

  outputFileList.querySelectorAll('[data-act="rename"]').forEach((btn) => {
    btn.addEventListener('click', () => renameOutputFlow(decodeURIComponent(btn.dataset.file)));
  });
  outputFileList.querySelectorAll('[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteOutputFlow(decodeURIComponent(btn.dataset.file)));
  });
}

async function loadOutputs() {
  btnRefreshOutputs.disabled = true;
  try {
    const data = await api.getOutputs(50);
    if (data.success) renderOutputs(data.files || []);
    else outputsSummaryText.textContent = '获取成品列表失败: ' + (data.error || '未知错误');
  } catch (err) {
    outputsSummaryText.textContent = '获取成品列表失败: ' + err.message;
  } finally {
    btnRefreshOutputs.disabled = false;
  }
}

async function renameOutputFlow(filename) {
  await promptDialog('重命名成片', {
    defaultValue: filename.replace(/(?:\.mp4)+$/i, ''), placeholder: '输入新名称', confirmText: '重命名',
    submit: async name => {
      const fullName = normalizeMp4Name(name);
      const data = await api.renameOutput(filename, fullName);
      if (!data.success) throw new Error(data.error || '重命名失败，请重试。');
      toast('已重命名为 ' + fullName, 'success'); loadOutputs();
    },
  });
}

async function deleteOutputFlow(filename) {
  const ok = await confirmDialog(`确定删除成品「${filename}」？此操作不可恢复。`, { danger: true, confirmText: '删除' });
  if (!ok) return;
  try {
    const data = await api.deleteOutput(filename);
    if (!data.success) { toast('删除失败: ' + (data.error || '未知错误'), 'error'); return; }
    toast('已删除', 'success');
    loadOutputs();
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

// --- Schedules（定时导出：开关 + 时段 + 通道 + runAt + 保留天数）---
function lastRunText(s) {
  if (!s.lastRun) return '从未触发';
  const statusMap = {
    started: '进行中',
    completed: '已完成',
    failed: '失败',
    seeded: '跳过',
  };
  // 手动取消的任务回写成 failed + message「导出已取消」——显示「已取消」比
  // 红字「失败」更贴近事实，用户不用猜
  const cancelled = s.lastRun.status === 'failed' && /取消/.test(s.lastRun.message || '');
  const status = cancelled ? '已取消' : (statusMap[s.lastRun.status] || s.lastRun.status);
  const at = s.lastRun.at ? new Date(s.lastRun.at) : null;
  const atStr = at ? `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : s.lastRun.date || '';
  const message = s.lastRun.message ? `（${s.lastRun.message}）` : '';
  return `${status} · ${atStr} ${message}`;
}

function renderSchedules(schedules) {
  if (!schedules.length) {
    scheduleList.innerHTML = '<div class="schedule-empty">没有配置定时计划</div>';
    return;
  }
  scheduleList.innerHTML = schedules.map((s) => `
    <div class="schedule-item" data-id="${esc(s.id)}">
      <div class="schedule-item-head">
        <label class="switch">
          <input type="checkbox" role="switch" aria-label="启用计划 ${esc(s.name || '未命名计划')}" class="schedule-enabled" ${s.enabled ? 'checked' : ''}>
          <span class="switch-slider"></span>
        </label>
        <span class="schedule-name">${esc(s.name || '未命名计划')}</span>
        <span class="schedule-status ${esc(s.lastRun?.status || '')}">${esc(lastRunText(s))}</span>
      </div>
      <div class="schedule-fields">
        <label class="schedule-field">通道
          <input type="text" class="mono schedule-channel" value="${esc(s.channel || '')}" placeholder="沿用界面所选">
        </label>
        <label class="schedule-field">开始
          <input type="text" placeholder="HH:MM" maxlength="8" class="mono schedule-start" value="${esc(s.startTime || '')}">
        </label>
        <label class="schedule-field">结束
          <input type="text" placeholder="HH:MM" maxlength="8" class="mono schedule-end" value="${esc(s.endTime || '')}">
        </label>
        <label class="schedule-field">触发
          <input type="text" placeholder="HH:MM" maxlength="8" class="mono schedule-runat" value="${esc(s.runAt || '')}">
        </label>
        <label class="schedule-field">保留(天)
          <input type="number" class="mono schedule-retention" min="1" max="365" value="${esc(s.retentionDays ?? 7)}">
        </label>
        <button class="btn btn-primary btn-sm schedule-save" type="button">保存</button>
      </div>
    </div>`).join('');

  scheduleList.querySelectorAll('.schedule-save').forEach((btn) => {
    btn.addEventListener('click', () => saveSchedule(btn.closest('.schedule-item')));
  });
}

async function loadSchedules() {
  try {
    const data = await api.getSchedules();
    if (data.success) renderSchedules(data.schedules || []);
    else scheduleList.innerHTML = `<div class="schedule-empty">读取失败: ${esc(data.error || '未知错误')}</div>`;
  } catch (err) {
    scheduleList.innerHTML = `<div class="schedule-empty">读取失败: ${esc(err.message)}</div>`;
  }
}

async function saveSchedule(item) {
  const submit = item.querySelector('.schedule-save'); if (submit.disabled) return;
  const id = item.dataset.id;
  const patch = {
    enabled: item.querySelector('.schedule-enabled').checked,
    channel: item.querySelector('.schedule-channel').value.trim() || null,
    startTime: item.querySelector('.schedule-start').value,
    endTime: item.querySelector('.schedule-end').value,
    runAt: item.querySelector('.schedule-runat').value,
    retentionDays: parseInt(item.querySelector('.schedule-retention').value, 10) || 7,
  };
  if (![patch.startTime, patch.endTime, patch.runAt].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))) {
    toast('开始、结束和触发时间请使用 HH:MM 格式。', 'error');
    return;
  }
  submit.disabled = true; submit.textContent = '正在保存…';
  try {
    const data = await api.updateSchedule(id, patch);
    if (!data.success) { toast('保存失败: ' + (data.error || '未知错误'), 'error'); return; }
    toast('定时计划已保存，即时生效', 'success');
    loadSchedules();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  } finally { submit.disabled = false; submit.textContent = '保存'; }
}

// --- Date helpers ---
function setDate(dateStr) { dateSelect.value = dateStr; dateSelect.dispatchEvent(new Event('controlsync')); }
function shiftDate(days) {
  const d = new Date(dateSelect.value + 'T00:00:00');
  d.setDate(d.getDate() + days);
  setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
}
async function onDateChanged() {
  await loadDayRecordings();
  seekTo(playheadSec, 0);
  saveSession();
}

// --- Event wiring ---
deviceSelect.addEventListener('change', async () => {
  const dev = getSelectedDeviceFromList();
  if (dev) {
    try { await api.activateDevice(dev.id); activeDeviceId = dev.id; } catch (e) { /* ignore */ }
    connectDevice({ ip: dev.ip, user: dev.username, pass: dev.password });
  } else {
    resetDisconnected();
  }
});
btnAddDevice.addEventListener('click', showAddDeviceDialog);
btnEmptyAdd.addEventListener('click', showAddDeviceDialog);
btnDeleteDevice.addEventListener('click', deleteSelectedDevice);
btnDialogCancel.addEventListener('click', hideAddDeviceDialog);
btnDialogConfirm.addEventListener('click', confirmAddDevice);
// Do not dismiss a device editor on an accidental backdrop tap.
[dialogIp, dialogUser, dialogPass].forEach((inp) => {
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmAddDevice(); }
    else if (e.key === 'Escape') { e.preventDefault(); hideAddDeviceDialog(); }
  });
});
btnDialogTogglePass.addEventListener('click', () => {
  const isPw = dialogPass.type === 'password';
  dialogPass.type = isPw ? 'text' : 'password';
  btnDialogTogglePass.querySelector('.icon-eye').hidden = isPw;
  btnDialogTogglePass.querySelector('.icon-eye-off').hidden = !isPw;
});

channelSelect.addEventListener('change', onDateChanged);
dateSelect.addEventListener('change', onDateChanged);
btnPrevDay.addEventListener('click', () => { shiftDate(-1); onDateChanged(); });
btnNextDay.addEventListener('click', () => { shiftDate(1); onDateChanged(); });
btnToday.addEventListener('click', () => { setDate(todayLocalDate()); onDateChanged(); });

[startTime, endTime].forEach((inp) => inp.addEventListener('change', () => {
  if (![startTime.value, endTime.value].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))) { inp.setAttribute('aria-invalid', 'true'); toast('请输入有效时间，格式 HH:MM:SS。', 'error'); return; }
  startTime.removeAttribute('aria-invalid'); endTime.removeAttribute('aria-invalid');
  let inSec = timeStrToSeconds(startTime.value);
  let outSec = timeStrToSeconds(endTime.value);
  if (outSec <= inSec) outSec = Math.min(DAY_SECONDS - 1, inSec + 1);
  setSelection(inSec, outSec);
  saveSession();
}));

btnMarkIn.addEventListener('click', markIn);
btnMarkOut.addEventListener('click', markOut);
btnExport.addEventListener('click', startExportFlow);
btnStopExport.addEventListener('click', stopExportFlow);
exportMethodSelect.addEventListener('change', saveSession);

btnPlayPause.addEventListener('click', togglePlayback);
btnPlayOverlay.addEventListener('click', togglePlayback);
stage.addEventListener('mouseenter', () => { if (currentDevice) btnPlayOverlay.hidden = false; });
stage.addEventListener('mouseleave', () => { btnPlayOverlay.hidden = true; });

btnSettings.addEventListener('click', openDrawer);
btnCloseDrawer.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);
btnRefreshCache.addEventListener('click', refreshCacheInfo);
btnClearCache.addEventListener('click', clearAllCache);
btnRefreshOutputs.addEventListener('click', loadOutputs);
$('refresh-schedules').addEventListener('click', async () => { const button = $('refresh-schedules'); button.disabled = true; try { await loadSchedules(); } finally { button.disabled = false; } });
document.querySelectorAll('.drawer-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchDrawerTab(btn.dataset.tab));
  btn.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const tabs = [...document.querySelectorAll('.drawer-tab')]; const next = tabs[(tabs.indexOf(btn) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; switchDrawerTab(next.dataset.tab); next.focus(); });
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || activeDialog?.open || document.querySelector('.dialog-overlay:not([hidden])')) return;
  if (settingsDrawer.classList.contains('open')) { if (e.key === 'Escape') closeDrawer(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

  if (e.key === '[') { e.preventDefault(); markIn(); return; }
  if (e.key === ']') { e.preventDefault(); markOut(); return; }
  if (e.key === 'Escape' && settingsDrawer.classList.contains('open')) { closeDrawer(); return; }
  if (e.key === ' ') { e.preventDefault(); togglePlayback(); return; }

  if (!currentDevice) return;
  let delta = 0;
  if (e.key === 'ArrowRight') delta = 10;
  else if (e.key === 'ArrowLeft') delta = -10;
  else if (e.key === 'ArrowDown') delta = 60;
  else if (e.key === 'ArrowUp') delta = -60;
  if (delta) { e.preventDefault(); seekTo(playheadSec + delta, 300); }
});

// --- Init ---
async function init() {
  setDate(todayLocalDate());
  startTime.value = '08:00:00';
  endTime.value = '08:05:00';

  let last = null;
  try {
    const res = await api.getSession();
    if (res.success) last = res.session;
  } catch (_) { /* 服务端拿不到就用上面的默认值，不挡住页面加载 */ }

  // 一次性迁移：旧版本把会话存在 localStorage，服务端还没有记录时搬过去
  const legacy = localStorage.getItem('dvrLastSession');
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      if (parsed?.date && !last?.date) {
        const res = await api.saveSession(parsed);
        if (res.success) last = res.session;
      }
    } catch (_) { /* 旧数据坏了就丢掉 */ }
    localStorage.removeItem('dvrLastSession');
  }

  if (last) {
    // 日期必须和起止时间一起恢复：只恢复时间而把日期重置成今天，会拼出用户从未
    // 选过的范围（旧时间 + 今天），结束时间还可能落在未来。
    if (last.date) setDate(last.date);
    if (last.startTime) startTime.value = last.startTime;
    if (last.endTime) endTime.value = last.endTime;
    if (last.channel) window._restoreChannel = last.channel;
    if (last.exportMethod) { exportMethodSelect.value = last.exportMethod; exportMethodSelect.dispatchEvent(new Event('controlsync')); }
  }
  playheadSec = timeStrToSeconds(startTime.value);
  updatePlayButton();

  timeline = createTimeline({
    container: $('timeline'),
    onSeek: (s) => seekTo(s),
    onSelectionChange: ({ inSec, outSec }) => { setSelection(inSec, outSec, { syncTimeline: false }); saveSession(); },
  });
  timeline.setSelection(timeStrToSeconds(startTime.value), timeStrToSeconds(endTime.value));
  timeline.setPlayhead(playheadSec);
  timeline.setEnabled(false);

  setSelection(timeStrToSeconds(startTime.value), timeStrToSeconds(endTime.value), { syncTimeline: false });
  stageTime.textContent = secondsToTimeStr(playheadSec);
  currentTimeText.textContent = secondsToTimeStr(playheadSec);

  await loadSavedDevices();
  restoreActiveTaskStatus();

  if (activeDeviceId) {
    const dev = deviceList.find((d) => d.id === activeDeviceId);
    if (dev) connectDevice({ ip: dev.ip, user: dev.username, pass: dev.password }, true);
  }
}

init();


[deviceSelect, channelSelect, exportMethodSelect].forEach(enhanceSelect);
enhanceDateInput(dateSelect, { today: todayLocalDate });

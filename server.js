import express from 'express';
import { mountConsoleConfig, configSnapshot, readPlaybackUrl, preparationGuard, consoleConfigJsonError } from './lib/console-config.js';
import { cameraSourceIdentity } from './lib/source-identity.js';
import { probeDevice, snapshotDevice } from './lib/device-probe.js';
import { deviceHttpOrigin, deviceEndpointIdentity, deviceCacheKey, normalizeDeviceEndpoint } from './lib/device-endpoint.js';
import { listenerConfig } from './lib/listener-config.js';
import { execFile } from 'child_process';
import { spawnExportProcess as spawn } from './lib/export-process-lock.js';
import { promisify } from 'util';
import path from 'path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'url';
import fs from 'fs';
import xml2js from 'xml2js';
import cors from 'cors';
import crypto from 'crypto';
import { ffmpegPath, ffprobePath } from './lib/ffmpeg-paths.js';
import { getLanAddresses } from './lib/lan-address.js';
import { runServiceCli } from './lib/service-manager.js';
import { writeRuntimeFile, registerRuntimeCleanup } from './lib/runtime-file.js';
import { runMp4DownloadPipeline, compactToIso } from './lib/mp4-download-pipeline.js';
import { searchRecordings } from './lib/recording-search.js';
import { runRtspClipExport, compactToMs, msToCompact } from './lib/rtsp-clip-export.js';
import { pullRtspRaw } from './lib/rtsp-client.js';
import { dvrExportError, dvrExportFailure, dvrRtspFailureDiagnostics, isDvrExportError } from './lib/dvr-export-errors.js';
import { resolvePreviewTrack } from './lib/record-tracks.js';
import { createDvrPreview, dvrRtspUrl } from './lib/dvr-preview-stream.js';
import { createDvrHlsPreview, DVR_HLS_MAX_SECONDS } from './lib/dvr-hls-preview.js';
import { sdkEnabled, sdkDownloadMp4, sanitizeSdkMetadata, killSdkProcessesNow } from './lib/dvr-sdk.js';
import { createDvrSdkPreview } from './lib/dvr-sdk-preview.js';
import { parseDvrChannels, mainDvrChannel } from './lib/dvr-channels.js';
import { getChannelFps } from './lib/stream-params.js';
import { setProgressStatusHook } from './lib/progress-reporter.js';
import { findRunningTask } from './lib/task-registry.js';
import { runMcpServer, createHikclipDispatcher } from './lib/mcp-server.js';
import { mountMcpHttp } from './lib/mcp-http.js';
import { createHikclipClient } from './lib/hikclip-client.js';
import { createScheduler } from './lib/scheduler.js';
import { getSchedules, getScheduleFilePath, updateSchedule, recordRun } from './lib/schedule-store.js';
import { mountOutputThumbnails } from './lib/output-thumbnails.js';
import { listOutputFiles, deleteOutputFile, isOutputFilename } from './lib/output-files.js';
import { listOutputLibrary, resolveLibraryOutput, deleteLibraryOutput, outputId, captureOutputSource, outputSourceUnchanged } from './lib/output-library.js';
import { listDvrCache, cleanCompletedDvrCache } from './lib/cache-cleaner.js';
import { createUploadQueue } from './lib/match-workflow.js';
import { mountCloud189Verification } from './lib/cloud189-verification.js';
import { createCloud189Queue } from './lib/cloud189-queue.js';
import { createUploadSettingsStore, readUploadIntegrations, uploadTitle, mountUploadSettings } from './lib/console-upload-settings.js';
import { createManagedUploadSupervisor, verifyManagedUploadTools, uploadAccountReady } from './lib/managed-upload-supervisor.js';
import { createUploadCoverStore, mountUploadCover } from './lib/upload-cover.js';
import { createUploadAccountManager, mountUploadAccounts, uploadAccountConfig } from './lib/upload-accounts.js';
import { createStatusPasswordStore } from './lib/status-password-store.js';
import { createMediaMtxPlayback } from './lib/mediamtx-playback.js';
import { createMediaMtxLive } from './lib/mediamtx-live.js';
import { mountMediaMtxLive } from './lib/mediamtx-live-routes.js';
import { createPlaybackPreviewCache, previewIdentity, servePreviewFile } from './lib/playback-preview.js';
import { dvrDateRange, normalizeDvrSegments } from './lib/dvr-playback.js';
import { prepareMatchJob } from './lib/match-job.js';
import { createMediaJobStore, mediaJobPage } from './lib/media-job-store.js';
import {
  getAllDevices,
  getDeviceById,
  getActiveDevice,
  addDevice,
  updateDevice,
  deleteDevice,
  activateDevice,
  getDataFilePath,
} from './lib/device-store.js';
import { getSession, saveSession, getSessionFilePath } from './lib/session-store.js';
import { cameraCatalog, getCamera, listCameras, resolveCamera } from './lib/camera-store.js';
import { mediaChannelDiscovery } from './lib/media-channel-discovery.js';
import { createMediaArchive } from './lib/media-archive.js';
import { allocateArtifact, artifactRoot, artifactWorkDir, cleanArtifactWork, isArtifactPath } from './lib/artifacts.js';
import { createExportRecoveryStore, acquireExportLease, EXPORT_TERMINAL, RECOVERED_TASK, resolveRecoveryDevice } from './lib/export-recovery.js';
import { createOutputRenameJournal } from './lib/output-rename-journal.js';
import { renameManagedOutputFile } from './lib/managed-output-rename.js';
import { publishExport, reconcilePublications } from './lib/export-publication.js';
import { createExportQueue } from './lib/export-queue.js';
import { CAMERA_JOB, TASK_RESERVATION, TASK_COMPLETION, prepareCameraJob } from './lib/camera-jobs.js';
import { prepareConsoleExport } from './lib/console-export.js';
import { createDvrHttpSampleControl, mountDvrHttpSample, DVR_HTTP_SAMPLE_TASK_ID } from './lib/dvr-http-sample-control.js';
import { runDvrHttpSample, sanitizeDvrHttpSample, cleanupInterruptedDvrHttpSamples } from './lib/dvr-http-sample.js';
import { toCompact, compactToDisplay } from './lib/hik-time.js';
import { readMcpToken, readStatusPasswordHash, readStatusSessionSeconds, publicBaseUrl, signDownload, createPublicGateway, DOWNLOAD_LINK_TTL_SECONDS } from './lib/mcp-security.js';
import { createCameraOAuth } from './lib/camera-oauth.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const mcpToken = readMcpToken();
const statusPasswordHash = readStatusPasswordHash();
const statusSessionSeconds = readStatusSessionSeconds();
const statusPasswordStore = createStatusPasswordStore({
  filePath: path.join(path.dirname(getDataFilePath()), 'public-console-auth.json'),
  initialHash: statusPasswordHash,
  loginPassword: process.env.HIKCLIP_LOGIN_PASSWORD || '',
  sessionSecret: mcpToken,
});
// Do not pass the console password to later spawned media/worker processes.
delete process.env.HIKCLIP_LOGIN_PASSWORD;
const configuredPublicUrl = publicBaseUrl();
const publicPort = process.env.HIKCLIP_PUBLIC_PORT ? Number(process.env.HIKCLIP_PUBLIC_PORT) : null;
if (publicPort !== null && (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535 || !mcpToken || !configuredPublicUrl)) {
  throw new Error('公网入口需要有效的 HIKCLIP_PUBLIC_PORT、MCP Token 与 HTTPS 公网地址。');
}
const downloadUrl = (url) => signDownload(url, { token: mcpToken, baseUrl: configuredPublicUrl });
app.use(cors());
app.use(express.json());
app.use(consoleConfigJsonError);
// Loopback native-deployment identity; the public gateway does not forward this route.
app.get('/api/runtime-health', (_req, res) => res.json({ pid: process.pid, release: process.env.HIKCLIP_RELEASE_SHA || null,
  preparationOnly: process.env.HIKCLIP_PREPARATION_ONLY === '1', recoveryReady: exportRecoveryBlocked === null }));
// Mount through Express so case/trailing-slash matching agrees with device routes.
app.use('/api/devices', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) && exportRecoveryBlocked) {
    return res.status(503).json({ success: false, error: exportRecoveryBlocked });
  }
  if (['POST', 'PUT'].includes(req.method.toUpperCase())) return preparationGuard(req, res, next);
  next();
});
const cameraOAuth = mcpToken && configuredPublicUrl ? createCameraOAuth({ baseUrl: configuredPublicUrl, loginToken: mcpToken,
  stateFile: path.join(path.dirname(getDataFilePath()), 'oauth-state.json') }) : null;
if (cameraOAuth) cameraOAuth.mount(app);
app.use(express.static(path.join(__dirname, 'public')));

// ===== Device Management API =====

// GET /api/devices — list all devices + activeDeviceId
app.get('/api/devices', (req, res) => {
  const { devices, activeDeviceId } = getAllDevices();
  res.json({ success: true, devices, activeDeviceId });
});

// GET /api/devices/active — get the currently active device (full info)
app.get('/api/devices/active', (req, res) => {
  const device = getActiveDevice();
  if (!device) {
    return res.json({ success: true, device: null });
  }
  res.json({ success: true, device });
});

// POST /api/devices — add a new device
app.post('/api/devices', (req, res) => {
  const { name, ip, username, password } = req.body;
  if (!ip || !username || !password) {
    return res.status(400).json({ success: false, error: 'ip, username, password 为必填' });
  }
  const device = addDevice({ name, ip, username, password });
  res.json({ success: true, device });
});

// PUT /api/devices/:id — update a device
app.put('/api/devices/:id', (req, res) => {
  const updated = updateDevice(req.params.id, req.body);
  if (!updated) {
    return res.status(404).json({ success: false, error: '设备不存在' });
  }
  res.json({ success: true, device: updated });
});

// DELETE /api/devices/:id — delete a device
app.delete('/api/devices/:id', (req, res) => {
  const deleted = deleteDevice(req.params.id);
  if (!deleted) {
    return res.status(404).json({ success: false, error: '设备不存在' });
  }
  res.json({ success: true });
});

// PUT /api/devices/:id/activate — set as active device
app.put('/api/devices/:id/activate', (req, res) => {
  const device = activateDevice(req.params.id);
  if (!device) {
    return res.status(404).json({ success: false, error: '设备不存在' });
  }
  res.json({ success: true, device });
});

// ===== End Device Management API =====

// ===== UI Session API =====
// 界面上次选到哪儿（日期/起止时间/通道/导出方式）。放服务端而不是浏览器
// localStorage，这样换浏览器或换电脑访问同一个实例看到的是同一份状态。

app.get('/api/session', (req, res) => {
  try {
    res.json({ success: true, session: getSession() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/session', (req, res) => {
  try {
    res.json({ success: true, session: saveSession(req.body || {}) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== End UI Session API =====

// Ensure downloads directory exists
const downloadsDir = path.resolve(process.env.HIKVISION_DOWNLOADS_DIR || path.join(__dirname, 'downloads'));
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}
let mediaPlayback = createMediaMtxPlayback({ baseUrl: readPlaybackUrl() });
const playbackPreviews = createPlaybackPreviewCache({ root: path.join(path.dirname(getDataFilePath()), 'playback-preview') });

// 成品 MP4 直接给出下载 URL（MCP 的 list_outputs 会把它回给使用者）。
// 只放行 .mp4：downloads/ 里还躺着几 GB 一个的 .hikraw 分片缓存，
// 那些是中间产物，没有理由让它们可以被整个局域网拖走。
app.use('/downloads', (req, res, next) => {
  if (!req.path.toLowerCase().endsWith('.mp4')) return res.status(404).end();
  next();
}, express.static(downloadsDir));

app.use('/artifacts', (req, res, next) => {
  if (!isArtifactPath(req.path.slice(1))) return res.status(404).end();
  next();
}, express.static(artifactRoot(), { dotfiles: 'deny', index: false }));

// Helper to run curl with digest auth
async function curlDigest(ip, user, pass, url) {
  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  // Use execFile with an argument array (no shell) so credentials/URLs containing
  // shell metacharacters can't break the command or be injected.
  // --connect-timeout 5 avoids hanging on unreachable devices.
  const args = [
    '--connect-timeout', '5', '--max-time', '10', '--max-filesize', '1048576',
    '-s',
    '--digest',
    '-u', `${user}:${pass}`,
    `${deviceHttpOrigin(ip)}${url}`,
  ];
  const { stdout } = await execFileAsync(curlCmd, args, { timeout: 11000, maxBuffer: 1048576 });
  return stdout;
}

// SSE Clients Map
let sseClients = [];

// 活跃任务映射表
const recoveryStore = createExportRecoveryStore();
const outputRenames = createOutputRenameJournal(downloadsDir);
// HTTP starts listening before discovery finishes. No write/export may enter
// until this instance has acquired the queue lease and loaded recovery state.
let exportRecoveryBlocked = '正在初始化录像来源与恢复队列，请稍后重试。';
let recoveryRetry = null;
const recoveryBlockerId = crypto.randomUUID();
const activeTasks = new Map();
let previewSettlement = Promise.resolve(), consoleDvrHls, consoleDvrSdk;
const exportQueue = createExportQueue({
  onCancel: task => recoveryStore.cancel(task),
  onState(task, status, queuePosition) {
    Object.assign(task, { status, queuePosition, progress: status === 'queued' ? null : 0,
      message: status === 'queued' ? `排队中，前方 ${queuePosition - 1} 个等待任务` : '任务已启动',
      speed: null, speedX: null, speedUpdatedAt: null });
    if (status !== 'queued') task.startedAt = Date.now();
    const data = JSON.stringify({ taskId: task.taskId, status, queuePosition, progress: task.progress, message: task.message });
    for (const client of sseClients) { try { client.res.write(`data: ${data}\n\n`); } catch {} }
    try { recoveryStore.update(task); }
    catch { task.persistenceError = true; task.controller?.abort(); console.error('导出状态无法保存，已停止任务；文件保留。'); }
    if (task.cameraJob) { try { mediaJobs.save(task); } catch { console.error('任务状态保存失败'); } }
    if (status !== 'queued') {
      consolePreviewGeneration++;
      const preview = activePreview || consoleDvrHls?.current || consoleDvrSdk?.current;
      if (preview) { previewSettlement = Promise.resolve(preview.stop('export starting')).catch(() => {}); }
    }
  },
  onSettled(task, error) {
    const current = activeTasks.get(task.taskId);
    if (!current) return;
    current.finalizing = true;
    current.queuePosition = null;
    const cancelled = task.controller?.signal.aborted && !task.persistenceError;
    if (current.kind === 'dvr-http-sample') {
      current.sampleReport = sanitizeDvrHttpSample(current.sampleReport);
      const cleanupFailed = current.sampleReport?.outcome === 'cleanup_failed';
      const status = cleanupFailed ? 'error' : cancelled ? 'cancelled' : error || current.persistenceError ? 'error' : 'completed';
      broadcastProgress(task.taskId, status, null, cleanupFailed ? '兼容测试已停止，但临时样本清理未完成；不会自动重试。' : cancelled ? '受限兼容测试已取消；临时样本已清理。'
        : status === 'error' ? '受限兼容测试已停止；不会自动重试或生成成片。' : '受限兼容测试结束；临时样本已清理，不是所选十秒的成片。');
      const settled = activeTasks.get(task.taskId); settled.controller = undefined;
      try { recoveryStore.update(settled); mediaJobs.save(settled); } catch { console.error('兼容测试结果保存失败；不会自动重试。'); }
      return;
    }
    if (error && !cancelled && !task.persistenceError && (current.source === 'hikvision' || isDvrExportError(error))) {
      Object.assign(current, dvrExportFailure(error));
    }
    broadcastProgress(task.taskId, cancelled ? 'cancelled' : error ? 'error' : 'completed', error || cancelled ? 0 : 100,
      task.persistenceError ? '恢复状态无法保存，任务已停止；现有文件已保留，请检查磁盘空间和权限' : cancelled ? '任务已取消' : error ? current.failureCode ? current.message : '导出失败，请检查录像覆盖和服务端配置' : current.coverage?.hasGaps ? `成片已生成（含缺口）：已按确认跳过 ${current.coverage.missingSeconds} 秒，可用录像覆盖 ${current.coverage.availableSeconds} 秒（复制模式边界以关键帧为准）` : '媒体产物已生成');
    activeTasks.get(task.taskId).controller = undefined;
    if (current.cameraJob) { try { mediaJobs.save(activeTasks.get(task.taskId)); } catch { console.error('任务状态保存失败'); } }
    if (cancelled) Object.assign(activeTasks.get(task.taskId), { status: 'cancelled', message: '任务已取消' });
    try { recoveryStore.update(activeTasks.get(task.taskId)); mediaJobs.save(activeTasks.get(task.taskId)); }
    catch { console.error('导出终态保存失败；成品已保留，下次启动会核对发布检查点。'); }
    recordTaskOutcome(activeTasks.get(task.taskId));
  },
});

// A read-only secondary instance must never mutate the active owner's files or uploads.
app.use((req, res, next) => {
  if (exportRecoveryBlocked && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    && /^\/(?:console\/)?api\/(?:outputs|export|cache|bilibili|cameras\/(?:clip|snapshot|timeline|match))(?:\/|$)/.test(req.path)) {
    return res.status(503).json({ success: false, error: exportRecoveryBlocked });
  }
  next();
});

function broadcastProgress(taskId, status, progress, message) {
  const current = activeTasks.get(taskId);
  if ((current?.cameraJob || (current?.managedExport && ['completed', 'error'].includes(status))) && !current.finalizing) {
    status = 'converting'; progress = null;
    message = current.controller?.signal.aborted ? '正在停止任务并清理素材' : '正在保存最终文件';
  }
  if (current?.controller?.signal.aborted && exportQueue.owns(taskId) && !current.finalizing) {
    status = 'stopping'; progress = current.progress; message = '正在停止任务并清理素材';
  }
  const data = JSON.stringify({ taskId, status, progress, message });
  sseClients.forEach(client => {
    try { client.res.write(`data: ${data}\n\n`); } catch {}
  });

  // 同步更新活跃任务状态，保留诸如 controller 等附加字段
  const existing = activeTasks.get(taskId);
  const isFinal = status === 'completed' || status === 'error' || status === 'cancelled';

  activeTasks.set(taskId, {
    ...existing,
    taskId,
    status,
    progress,
    message,
    ...(isFinal ? { stage: null, stagePercent: null, progressUnit: null, processedSeconds: null } : current?.cameraJob ? { stage: 'finalizing', stagePercent: null, progressUnit: null, processedSeconds: null } : {}),
    progressUpdatedAt: Date.now(),
    startTime: existing?.startTime || Date.now(),
    // filename 是删除/重命名保护用的：任务进行中时对应的成品文件不能被碰
    filename: existing?.filename,
    // 任务进行中保留 controller 引用；终态下清理以便 GC
    controller: isFinal && !exportQueue.owns(taskId) ? undefined : existing?.controller,
  });

  // 完成/失败的任务 5 分钟后自动清理
  if (isFinal) {
    const settledTask = activeTasks.get(taskId);
    setTimeout(() => { if (activeTasks.get(taskId) === settledTask && !exportQueue.owns(taskId)) activeTasks.delete(taskId); }, 5 * 60 * 1000).unref?.();
  }
}

// 管线内部（ProgressReporter）广播时同步更新 activeTasks，
// 保证页面刷新后 /api/status 返回实时进度
setProgressStatusHook((taskId, status, progress, message, speed, speedX, details = {}) => {
  const existing = activeTasks.get(taskId);
  if ((existing?.cameraJob || existing?.managedExport) && !existing.finalizing) {
    if (status === 'completed' || status === 'error') {
      status = 'converting'; progress = null;
      message = '正在保存最终文件';
      details = { stage: 'finalizing', stagePercent: null };
    } else if (!details.stage) {
      progress = Math.min(progress, 99);
      message = status === 'converting' ? '正在封装录像' : '正在下载录像';
    }
  }
  if (existing?.controller?.signal.aborted && exportQueue.owns(taskId) && !existing.finalizing) {
    status = 'stopping'; progress = existing.progress; message = '正在停止任务并清理素材';
  }
  const isFinal = status === 'completed' || status === 'error' || status === 'cancelled';
  activeTasks.set(taskId, {
    ...existing,
    taskId, status, progress, message,
    stage: null, stagePercent: null, progressUnit: null, processedSeconds: null,
    ...details,
    progressUpdatedAt: Date.now(),
    speed: Number.isFinite(speed) ? speed : null,
    speedX: Number.isFinite(speedX) ? speedX : null,
    speedUpdatedAt: Number.isFinite(speed) && speed >= 0 ? Date.now() : null,
    startTime: existing?.startTime || Date.now(),
    // 与 broadcastProgress 同步保留 filename（进行中文件保护，见 DELETE/PUT /api/outputs）
    filename: existing?.filename,
    controller: isFinal && !exportQueue.owns(taskId) ? undefined : existing?.controller,
  });
  if (existing?.managedExport) {
    const data = JSON.stringify({ taskId, status, progress, message, speed, speedX, ...details });
    for (const client of sseClients) { try { client.res.write(`data: ${data}\n\n`); } catch {} }
  }
  if (isFinal) setTimeout(() => { if (!exportQueue.owns(taskId)) activeTasks.delete(taskId); }, 5 * 60 * 1000).unref?.();
});

// Only settled pipeline outcomes update scheduled-run history.
function recordTaskOutcome({ taskId, status, message }) {
    // 定时任务的 lastRun 回写（技术债 #7 的最小改法）：scheduler.js 启动时只记
    // status:'started'，任务结束/失败在这里按 taskId 对上号补上最终结果，
    // 让「昨晚定时跑完没」有据可查，而不是只能翻服务日志。
    try {
      for (const schedule of getSchedules()) {
        if (schedule.lastRun?.taskId === taskId) {
          recordRun(schedule.id, {
            // date 必须保留触发那天的值：scheduler 靠它判断「今天跑没跑过」
            date: schedule.lastRun.date,
            status: status === 'completed' ? 'completed' : 'failed',
            taskId,
            filename: schedule.lastRun.filename,
            method: schedule.lastRun.method,
            message: message || (status === 'completed' ? '导出完成' : '导出失败'),
          });
        }
      }
    } catch (_) { /* lastRun 回写失败不影响导出本身 */ }
}

/** 当前正在跑的导出任务，没有则 null（单飞守卫用）。 */
function getRunningTask() {
  return (exportQueue.runningTask && activeTasks.get(exportQueue.runningTask.taskId)) || findRunningTask(activeTasks.values());
}

/**
 * 进行中任务的目标成品文件名集合。
 *
 * mp4download 的 concat 阶段和 rtspclip 的封装阶段都是直写最终文件名
 * （ch..._to_....mp4），此时文件已在 downloads/ 里逐渐长大，成品列表会
 * 看到它。删除/重命名这个 inode 会让导出任务在收尾检查时失败，且终态与
 * 实际文件状态不一致——这些文件必须受保护。
 */
function getInProgressOutputFilenames() {
  const names = new Set();
  for (const task of activeTasks.values()) {
    if (exportQueue.owns(task.taskId) || !EXPORT_TERMINAL.has(task.status)) {
      for (const filename of [task.filename, task.nativeFilename, ...(task.outputFilenames || []), ...(task.files || []).map(file => file.filename)]) {
        if (filename) names.add(filename);
      }
    }
  }
  return names;
}

// channel/海康 compact 时间格式校验。server 绑定 0.0.0.0，同网段其他设备
// 也能打到这些端点；channel/time 会被直接拼进 lib/rtsp-client.js 手写的
// RTSP 协议请求文本（原始 socket 写入，不经过任何库做转义），不校验格式
// 就等于允许 CRLF 注入到发给 NVR 的请求里。curl/ffmpeg 路径走的是数组参数
// 传参（execFile/spawn），不经过 shell，不受这个问题影响。
const CHANNEL_PATTERN = /^\d{1,8}$/;
const HIK_COMPACT_TIME_PATTERN = /^\d{8}T\d{6}Z$/;

// 1. Get Channels
app.get('/api/channels', async (req, res) => {
  const { ip, user, pass } = req.query;
  console.log(`[API] Fetching channels from ${ip}...`);
  
  if (!ip || !user || !pass) {
    return res.status(400).json({ success: false, error: 'Missing device credentials' });
  }

  try {
    const xml = await curlDigest(ip, user, pass, '/ISAPI/Streaming/channels');
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xml);
    
    let channels = [];
    const list = result.StreamingChannelList?.StreamingChannel;
    
    if (list) {
      const channelArray = Array.isArray(list) ? list : [list];
      channels = channelArray.map(ch => ({
        id: ch.id,
        name: ch.channelName || ch.id,
        resolution: ch.Video?.videoResolutionWidth ? `${ch.Video.videoResolutionWidth}x${ch.Video.videoResolutionHeight}` : 'Unknown'
      }));
    }
    
    res.json({ success: true, channels, playbackTransport: sdkEnabled(device) ? 'hcnetsdk' : 'rtsp' });
  } catch (error) {
    console.error('Error fetching channels:', error);
    let errorMsg = error.message;
    if (error.message.includes('timeout') || error.code === 28) {
      errorMsg = '连接超时，请检查服务器与录像机之间的网络连通性。';
    } else if (error.message.includes('401') || error.message.includes('digest')) {
      errorMsg = '认证失败，请检查用户名或密码。';
    }
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// 2. Preview Frame — RTSP playback seek
//
// Fetches a single JPEG frame for the requested historical time.
// Uses RTSP /Streaming/tracks/{ch}?starttime=...&endtime=... which is the only
// endpoint that actually seeks to a specific playback time on Hikvision NVRs.
// /Streaming/Channels/ silently ignores starttime and returns live, so we do
// NOT use it as a fallback — that would mislead the user into thinking they
// are looking at a historical frame.
//
// On failure this endpoint returns HTTP 503 with a JSON error so the client
// can transparently fall back to /api/preview-via-download.

app.get('/api/preview', (req, res) => {
  const { ip, user, pass, channel, time } = req.query; // time format: 20260509T210500Z
  console.log(`[API] Preview (RTSP) request: ${ip}, channel ${channel}, time ${time}`);

  if (!ip || !user || !pass || !channel || !time) {
    return res.status(400).json({ success: false, error: 'Missing device credentials, channel, or time' });
  }

  // Calculate end time (time + 2s) so the DVR has something to stream.
  const year = time.slice(0, 4);
  const month = time.slice(4, 6);
  const day = time.slice(6, 8);
  const hour = time.slice(9, 11);
  const minute = time.slice(11, 13);
  const second = time.slice(13, 15);

  const startDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  const endDate = new Date(startDate.getTime() + 2000);
  const endStr = endDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const rtspUrl = `rtsp://${user}:${pass}@${ip}:554/Streaming/tracks/${channel}/?starttime=${time}&endtime=${endStr}`;
  console.log(`[API] Preview RTSP URL: rtsp://${user}:***@${ip}:554/Streaming/tracks/${channel}/?starttime=${time}&endtime=${endStr}`);

  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-timeout', '8000000',
    '-i', rtspUrl,
    '-vframes', '1',
    '-q:v', '2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-'
  ];

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
  let hasData = false;
  const chunks = [];
  let stderr = '';

  ffmpeg.on('error', (err) => {
    console.error('[API] Preview ffmpeg spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'FFmpeg 启动失败: ' + err.message });
    }
  });

  ffmpeg.stdout.on('data', (chunk) => {
    hasData = true;
    chunks.push(chunk);
  });

  ffmpeg.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  ffmpeg.on('close', (code) => {
    if (code === 0 && hasData) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(Buffer.concat(chunks));
      }
      return;
    }
    // Extract a useful error line from ffmpeg stderr
    const errLine = (stderr.split('\n').find(l => /400|401|403|Bad Request|Unauthorized|Invalid|Error/.test(l)) || '').trim();
    console.log(`[API] Preview RTSP failed (code=${code}): ${errLine || '(no specific error)'}`);
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: 'RTSP seek failed',
        detail: errLine || `ffmpeg exited with code ${code}`,
      });
    }
  });
});

// 2b. Preview Frame — ISAPI HTTP download fallback
//
// For NVR firmware that rejects arbitrary RTSP seeks (observed on
// DS-7816NB-K2 V4.30), grab a short window via POST /ISAPI/ContentMgmt/download
// and decode a single frame locally with ffmpeg. The download is hard-capped
// at PREVIEW_DL_MAX_SECONDS real time; we only need one I-frame, not the whole
// segment, so we kill the curl process as soon as ffmpeg produces a frame.
const PREVIEW_DL_MAX_SECONDS = 8;

app.get('/api/preview-via-download', async (req, res) => {
  const { ip, user, pass, channel, time } = req.query;
  console.log(`[API] Preview (download) request: ${ip}, channel ${channel}, time ${time}`);

  if (!ip || !user || !pass || !channel || !time) {
    return res.status(400).json({ success: false, error: 'Missing device credentials, channel, or time' });
  }

  // Convert compact "20260509T210500Z" -> ISO "2026-05-09T21:05:00Z"
  const isoStart = `${time.slice(0,4)}-${time.slice(4,6)}-${time.slice(6,8)}T${time.slice(9,11)}:${time.slice(11,13)}:${time.slice(13,15)}Z`;
  const startMs = Date.parse(isoStart);
  if (Number.isNaN(startMs)) {
    return res.status(400).json({ success: false, error: 'Invalid time format' });
  }
  // Use a 10s window — the NVR streams real-time anyway; we kill it early.
  const isoEnd = new Date(startMs + 10 * 1000).toISOString().split('.')[0] + 'Z';

  // Step 1: search for the recording segment containing `time` so we can build
  // a proper playbackURI (some firmwares require the `name` parameter).
  let segment;
  try {
    const files = await searchRecordings(ip, user, pass, channel, isoStart, isoEnd, req.query.httpPort);
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, error: '该时间点无录像文件' });
    }
    segment = files[0];
  } catch (err) {
    console.error('[API] preview-via-download search failed:', err.message);
    return res.status(500).json({ success: false, error: '搜索录像失败: ' + err.message });
  }

  // Step 2: build the download request. We want the stream to START at `time`,
  // not at the segment start, so rewrite the playbackURI's starttime.
  const compactStart = time; // 20260509T210500Z
  const compactEnd = isoEnd.replace(/[-:]/g, '');
  const playbackURI = segment.playbackURI
    .replace(/starttime=[^&]+/, `starttime=${compactStart}`)
    .replace(/endtime=[^&]+/, `endtime=${compactEnd}`);

  const escapedURI = playbackURI.replace(/&/g, '&amp;');
  const xmlBody = `<downloadRequest><playbackURI>${escapedURI}</playbackURI></downloadRequest>`;
  const tempBodyFile = path.join(downloadsDir, `preview_body_${crypto.randomUUID()}.xml`);
  fs.writeFileSync(tempBodyFile, xmlBody, 'utf-8');

  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const curlArgs = [
    '--connect-timeout', '5',
    '--max-time', String(PREVIEW_DL_MAX_SECONDS),
    '-s',
    '--digest',
    '-u', `${user}:${pass}`,
    '-X', 'POST',
    '-H', 'Content-Type: application/xml',
    '--data-binary', `@${tempBodyFile}`,
    `${deviceHttpOrigin({ ip, httpPort: req.query.httpPort })}/ISAPI/ContentMgmt/download`,
  ];

  // Step 3: curl stdout -> ffmpeg stdin -> single JPEG frame
  // Hikvision ISAPI download returns MPEG-PS containing H.264 video + G.711
  // audio. We let ffmpeg auto-detect the format (don't pin with -f) so it
  // works across firmware variants.
  const curlProc = spawn(curlCmd, curlArgs);
  const ffmpegProc = spawn(ffmpegPath, [
    '-analyzeduration', '2000000',  // 2s is plenty to find the first I-frame
    '-probesize', '2000000',
    '-i', 'pipe:0',
    '-vframes', '1',
    '-q:v', '2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-',
  ]);

  let settled = false;
  const cleanup = () => {
    try { curlProc.kill('SIGKILL'); } catch (_) {}
    try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
    try { fs.unlinkSync(tempBodyFile); } catch (_) {}
  };

  curlProc.stdout.on('data', (chunk) => {
    if (!ffmpegProc.stdin.destroyed) {
      ffmpegProc.stdin.write(chunk);
    }
  });
  curlProc.stdout.on('end', () => {
    try { ffmpegProc.stdin.end(); } catch (_) {}
  });
  curlProc.stderr.on('data', () => {});
  curlProc.on('error', (err) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!res.headersSent) res.status(500).json({ success: false, error: 'curl 启动失败: ' + err.message });
  });

  const chunks = [];
  let ffStderr = '';
  ffmpegProc.stdout.on('data', (c) => chunks.push(c));
  ffmpegProc.stderr.on('data', (c) => { ffStderr += c.toString(); });
  ffmpegProc.stdin.on('error', () => {}); // Ignore EPIPE when we kill early

  ffmpegProc.on('close', (code) => {
    if (settled) return;
    settled = true;
    // Kill curl in case it's still streaming (we got our frame already)
    try { curlProc.kill('SIGKILL'); } catch (_) {}
    try { fs.unlinkSync(tempBodyFile); } catch (_) {}

    if (chunks.length > 0) {
      const jpeg = Buffer.concat(chunks);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(jpeg);
      }
      return;
    }
    const errLine = (ffStderr.split('\n').find(l => /Invalid|Error|unable/i.test(l)) || '').trim();
    console.log(`[API] preview-via-download ffmpeg code=${code}: ${errLine}`);
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: '下载方式获取帧失败',
        detail: errLine || `ffmpeg exited with code ${code}`,
      });
    }
  });

  // Safety: if nothing happens within the download budget + 3s, give up.
  setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: 'Preview download timed out' });
    }
  }, (PREVIEW_DL_MAX_SECONDS + 3) * 1000);

  // Clean up on client disconnect
  res.on('close', () => {
    if (!settled) {
      settled = true;
      cleanup();
    }
  });
});

// 2c. Preview Stream — 可播放的历史回放预览（MJPEG）
//
// 链路：自研 RTSP 客户端按 1X 实时拉裸 H.264（普通 PLAY，NVR 按回放速率派发）
//       → ffmpeg 解码缩放转 MJPEG → multipart/x-mixed-replace 推给 <img>。
// 全局同时只保留一路预览流（NVR 回放会话池有限且回收慢，实测多开会互相拖慢），
// 新请求到来或浏览器断开都会立即终止旧会话。
let activePreview = null;
let consolePreviewGeneration = 0;
function getConsoleDvrHls() {
  // Lazy creation happens only after the primary server has its export lease.
  return consoleDvrHls ||= createDvrHlsPreview({ root: path.join(path.dirname(getDataFilePath()), 'dvr-hls-preview'), ffmpegPath, spawn });
}
function getConsoleDvrSdk() {
  return consoleDvrSdk ||= createDvrSdkPreview({ root: path.join(path.dirname(getDataFilePath()), 'dvr-sdk-preview'),
    download: options => sdkDownloadMp4({ ...options, curlDigest }) });
}
function checkDvrPreviewGeneration(req) {
  if (req.query.client || req.query.generation) getConsoleDvrHls().accept(String(req.query.client || ''), req.query.generation);
}

app.get('/api/preview-stream', async (req, res) => {
  if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
  const { ip, user, pass, channel, time } = req.query;
  if (!ip || !user || !pass || !channel || !time) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  if (!CHANNEL_PATTERN.test(String(channel))) {
    return res.status(400).json({ success: false, error: 'Invalid channel' });
  }
  if (!HIK_COMPACT_TIME_PATTERN.test(String(time))) {
    return res.status(400).json({ success: false, error: 'Invalid time format' });
  }
  // 单次播放窗口上限 30 分钟，默认 10 分钟（到点自动停，防止挂机占用会话）
  const duration = Math.min(Math.max(parseInt(req.query.duration, 10) || 600, 10), 1800);

  const startMs = compactToMs(time);
  if (Number.isNaN(startMs)) {
    return res.status(400).json({ success: false, error: 'Invalid time format' });
  }
  const endCompact = msToCompact(startMs + duration * 1000);
  const generation = ++consolePreviewGeneration;

  // 录了子码流就用子码流（码率通常低一个数量级），没录则回落主码流。
  // 探测结果按设备缓存 5 分钟，不会每次预览都多打一次 ISAPI。
  const { track, isSubstream, fps: trackFps } = await resolvePreviewTrack(ip, user, pass, channel, req.query.httpPort);
  // 输入帧率决定 -re 的节流速度，取错会让播放整体偏快/偏慢。
  // 优先用录像 track 自报的帧率（实测 25fps），拿不到才去查通道的 maxFrameRate
  // ——后者在「全帧率」配置下报 0，只能回落默认值。
  const srcFps = trackFps || await getChannelFps(ip, user, pass, track, req.query.httpPort);

  if (res.destroyed) return;
  if (generation !== consolePreviewGeneration) return res.status(409).json({ success: false, error: 'Preview superseded' });

  console.log(`[API] Preview stream: ${ip} track${track}${isSubstream ? ' (substream)' : ''} @ ${time} (+${duration}s, ${srcFps}fps)`);

  // 停掉旧预览
  if (activePreview || consoleDvrHls?.current || consoleDvrSdk?.current) {
    const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk.current;
    await previous.stop('superseded');
  }
  if (generation !== consolePreviewGeneration || res.destroyed || getRunningTask()) return res.status(409).end();

  const controller = new AbortController();

  // MJPEG 转码：`-re` 按源帧率节流读取，让输出贴近真实速度——没有它时
  // ffmpeg 来多少吐多少，而 multipart 到达即显示，NVR 的突发就会变成
  // 画面忽快忽慢。节流带来的背压由 rtsp-client 的 pauseForBackpressure 承接。
  // 缩到最宽 1280（视网膜屏上 960 会被放大到糊）；-q:v 4 实测约 110KB/帧，
  // 满速 12fps 时下行约 10Mbps——局域网够用，公网访问需要下调。
  const ffmpeg = spawn(ffmpegPath, [
    '-loglevel', 'error',
    '-re', '-r', String(srcFps), '-f', 'h264', '-i', 'pipe:0',
    '-vf', "scale=w='min(1280,iw)':h=-2",
    '-r', '12',
    '-c:v', 'mjpeg', '-q:v', '4',
    '-f', 'mpjpeg', '-',
  ]);

  let stopped = false, resolveFfmpegClosed, resolvePullClosed;
  const ffmpegClosed = new Promise(resolve => { resolveFfmpegClosed = resolve; });
  const pullClosed = new Promise(resolve => { resolvePullClosed = resolve; });
  const settlement = Promise.all([ffmpegClosed, pullClosed]).then(() => {
    if (activePreview?.stop === stop) activePreview = null;
  });
  const stop = (reason) => {
    if (stopped) return settlement;
    stopped = true;
    controller.abort();
    try { ffmpeg.kill('SIGKILL'); } catch (_) {}
    console.log(`[API] Preview stream stopped (${reason})`);
    return settlement;
  };

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=ffmpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.on('error', (err) => {
    console.error('[API] Preview stream ffmpeg error:', err.message);
    stop('ffmpeg error');
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  ffmpeg.on('close', () => { resolveFfmpegClosed(); res.end(); stop('ffmpeg closed'); });

  // 1X 实时拉流（fastPull=false：预览就是要按实际速度播放）
  // idleTimeout 放宽到 20s：`-re` 节流时 socket 会被短暂 pause，10s 容易误判掉线
  pullRtspRaw({
    ip, user, pass,
    path: `/Streaming/tracks/${track}?starttime=${time}&endtime=${endCompact}`,
    outStream: ffmpeg.stdin,
    fastPull: false,
    idleTimeoutMs: 20000,
    signal: controller.signal,
  }).catch((err) => {
    if (!controller.signal.aborted) {
      console.log('[API] Preview stream pull ended');
    }
  }).finally(() => {
    // 拉流结束（正常/异常）后让 ffmpeg flush 掉缓冲即退出
    try { ffmpeg.stdin.end(); } catch (_) {}
    resolvePullClosed();
  });

  res.on('close', () => stop('client disconnected'));
  activePreview = { stop };
});

// 3. SSE Progress Endpoint
app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush the headers to establish SSE

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // Keepalive comment every 15s so proxies/browsers don't drop the idle connection
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    const idx = sseClients.findIndex(c => c.id === clientId); if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// 3.5 Active Tasks Status Endpoint
app.get('/api/status', (req, res) => {
  // Filter out the controller field — it's an internal AbortController and
  // not JSON-serializable in any meaningful way for clients.
  const { devices: credentialDevices } = getAllDevices();
  const tasks = Array.from(activeTasks.values()).map(({ controller, ...rest }) => {
    let message = String(rest.message || '');
    for (const device of credentialDevices) {
      for (const secret of [device.password, device.username]) {
        if (secret) message = message.replaceAll(secret, '[已隐藏]');
      }
    }
    return signedMediaTask({ ...rest, message });
  });
  res.json({
    success: true,
    activeTasks: tasks
  });
});

// 3.6 Stop Task Endpoint
app.post(['/api/export/stop', '/console/api/export/stop'], (req, res) => {
  const { taskId } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ success: false, error: 'Missing taskId' });
  }

  const task = activeTasks.get(taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  if (!exportQueue.cancel(taskId)) {
    return res.json({ success: true, message: 'Task already finished' });
  }
  if (exportQueue.owns(taskId)) {
    const current = activeTasks.get(taskId);
    Object.assign(current, { status: 'stopping', message: '正在停止任务并清理素材', speed: null, speedX: null });
    broadcastProgress(taskId, 'stopping', current.progress, current.message);
  }

  console.log(`[${taskId}] Task stopped by user`);
  res.json({ success: true, message: 'Task stopped' });
});

// 4. Export Video
/**
 * 启动一次导出。HTTP 路由和进程内的定时任务（lib/scheduler.js）共用这条入口，
 * 所以参数校验、单飞守卫、activeTasks 注册都放这里而不是放路由里。
 *
 * 不抛异常：校验失败返回 { ok: false, status, error }，由调用方决定怎么呈现。
 *
 * @returns {{ok:true,taskId:string,filename:string,method:string}|{ok:false,status:number,error:string,taskId?:string}}
 */
function reuseFinishedClip(existing) {
  const taskId = crypto.randomUUID();
  const task = { taskId, cameraJob: true, kind: 'clip', status: 'completed', progress: 100,
    message: existing.coverage?.hasGaps ? `复用含缺口成片：已跳过 ${existing.coverage.missingSeconds} 秒` : '复用已完成的录像', startTime: Date.now(), progressUrl: `/media-jobs/${taskId}`,
    filename: existing.filename, source: existing.source, strategy: existing.strategy,
    camera: existing.camera, sourceIdentity: existing.sourceIdentity, start: existing.start, end: existing.end, mode: existing.mode,
    size: existing.size, coverage: existing.coverage, acceptGaps: existing.acceptGaps, artifactUrl: existing.artifactUrl };
  activeTasks.set(taskId, task);
  mediaJobs.save(task);
  setTimeout(() => { if (!exportQueue.owns(taskId)) activeTasks.delete(taskId); }, 5 * 60 * 1000).unref?.();
  return { ok: true, taskId, operation: 'clip', filename: existing.filename,
    reused: true, progressUrl: signedMediaTask(task).progressUrl };
}

function startCameraJob(job, recovered) {
  if ([job.filename, ...(job.filenames || [])].filter(Boolean).some(filename => outputRenames.isBusy(filename))) return { ok: false, status: 409, error: '该文件名有未完成的改名记录，请先核对成片；不会覆盖或重新生成。' };
  if (recovered?.task.requestKey) job.requestKey = recovered.task.requestKey;
  const running = activeTasks.get(exportQueue.find(job.requestKey)?.taskId);
  if (running) {
    return { ok: true, taskId: running.taskId, operation: job.kind, status: running.status, queuePosition: running.queuePosition, progressUrl: signedMediaTask(running).progressUrl };
  }
  const reusedFiles = new Map();
  for (const request of recovered ? [] : job.requests || []) {
    if (!fs.existsSync(path.join(downloadsDir, request.filename))) continue;
    const file = mediaJobs.findFile(request, downloadsDir);
    if (!file) return { ok: false, status: 409, error: '已有同名录像，但起止时间或导出模式不同；不会覆盖，也不能当作这次的成品。' };
    reusedFiles.set(request.filename, file);
  }
  if (!recovered && job.kind === 'clip') {
    const existing = mediaJobs.findByRange({ camera: job.cameraId, sourceIdentity: job.sourceIdentity, start: job.start, end: job.end, mode: job.mode,
      acceptGaps: job.recoveryRequest?.args?.acceptGaps === true, requiredSource: job.recoveryRequest?.forceArchive ? 'mediamtx' : job.source === 'hikvision' ? 'hikvision' : undefined, expectedCoverage: job.initialPlan?.coverage }, downloadsDir,
      job.matchupSpecified ? job.filename : undefined);
    if (existing) return reuseFinishedClip(existing);
  }
  if (!recovered && job.filename && fs.existsSync(path.join(downloadsDir, job.filename))) return { ok: false, status: 409, error: '已有同名全场录像，请先改名或使用不同对阵名。' };
  const taskId = recovered?.task.taskId || crypto.randomUUID(), controller = new AbortController();
  const reservation = { taskId, controller };
  const task = { taskId, cameraJob: true, kind: job.kind, outputFilenames: job.filenames || [job.filename].filter(Boolean), requestKey: job.requestKey, queuedAt: recovered?.task.queuedAt || Date.now(), recovered: Boolean(recovered), files: [], total: job.filenames?.length,
    progressUrl: `/media-jobs/${taskId}`, camera: job.cameraId, source: job.source, sourceIdentity: job.sourceIdentity, start: job.start, end: job.end, filename: job.filename, status: 'queued', progress: null,
    message: '正在选择视频来源', startTime: Date.now(), controller };
  try { if (!recovered) recoveryStore.admit(task, job.recoveryRequest); }
  catch { return { ok: false, status: 503, error: '无法保存导出请求，请检查数据目录权限或磁盘空间；任务未启动。' }; }
  activeTasks.set(taskId, task);
  try { mediaJobs.save(task); } catch { console.error('媒体状态缓存保存失败；恢复队列记录仍已保存。'); }
  exportQueue.submit(activeTasks.get(taskId), async () => {
    await previewSettlement;
    if (controller.signal.aborted) throw new Error('任务已取消');
    if (recovered) {
      const published = await reconcilePublications({ record: recovered, store: recoveryStore, downloadsDir, signal: controller.signal });
      if (job.kind !== 'batch' && published.length) { Object.assign(activeTasks.get(taskId), published[0], { finalizing: true }); return; }
      for (const file of published) reusedFiles.set(file.filename, file);
      for (const file of recovered.task.files || []) {
        const current = mediaJobs.findFile(file, downloadsDir);
        if (current) reusedFiles.set(file.filename, current);
      }
    }
    if (job.filename && fs.existsSync(path.join(downloadsDir, job.filename))) throw new Error('已有同名录像，不能覆盖');
    const artifact = job.kind === 'batch' ? null : allocateArtifact(job.kind), work = artifactWorkDir();
    const outputFile = artifact ? path.join(work, path.basename(artifact.file)) : undefined;
    return Promise.resolve().then(() => job.execute({ signal: controller.signal, outputFile, reservation, reusedFiles, plan: job.initialPlan,
    onPlan(plan, filename) {
      const request = recoveryStore.get(taskId)?.request;
      if (!request) return;
      if (request.type === 'batch') request.jobs = request.jobs.map(item => item.filename === filename ? { ...item, plan } : item);
      else request.plan = plan;
      recoveryStore.request(taskId, request);
    },
    publishResult: details => publishExport({ ...details, store: recoveryStore, taskId, downloadsDir, signal: controller.signal }),
    onProgress(progress, message, speed, details = {}) {
      const task = activeTasks.get(taskId);
      if (!task || task.finalizing || controller.signal.aborted) return;
      task.status = 'converting'; task.progress = progress === null ? null : Math.max(0, Math.min(99, Number(progress) || 0));
      Object.assign(task, { stage: null, stagePercent: null, progressUnit: null, processedSeconds: null }, details, { progressUpdatedAt: Date.now() });
      task.message = message || '正在处理录像素材';
      task.speed = Number.isFinite(speed) && speed >= 0 ? speed : null;
      task.speedUpdatedAt = Number.isFinite(speed) && speed >= 0 ? Date.now() : null;
    },
    onFile(file, count, total) {
      const task = activeTasks.get(taskId);
      task.files.push(file); task.progress = 0; task.stage = null; task.stagePercent = null; task.processedSeconds = null; task.message = `已完成 ${count}/${total} 个镜头，继续处理其余镜头`; mediaJobs.save(task); recoveryStore.update(task);
    } }))
    .then(async (selected) => {
      if (controller.signal.aborted) throw new Error('任务已取消。');
      if (artifact) {
        const result = await publishExport({ store: recoveryStore, taskId, downloadsDir, key: job.filename || job.kind, artifact, outputFile, filename: job.filename, selected, signal: controller.signal });
        Object.assign(selected, result);
        delete selected.sourceOutput;
      }
      if (controller.signal.aborted) throw new Error('任务已取消。');
      Object.assign(activeTasks.get(taskId), { ...selected, ...(artifact ? { artifactUrl: artifact.url } : {}), finalizing: true });
      broadcastProgress(taskId, 'completed', 100, '媒体产物已生成');
      mediaJobs.save(activeTasks.get(taskId));
    }).catch(async (error) => {
      // Published artifacts survive interruptions; recovery checkpoints own reconciliation.
      const task = activeTasks.get(taskId);
      if (task) {
        task.finalizing = true;
        if (['MEDIAMTX_GAPS', 'MEDIAMTX_EMPTY'].includes(error.code)) Object.assign(task, { failureCode: error.code, coverage: error.coverage, message: error.message });
        else if (!controller.signal.aborted && (task.source === 'hikvision' || isDvrExportError(error))) Object.assign(task, dvrExportFailure(error));
      }
      broadcastProgress(taskId, 'error', 0, controller.signal.aborted ? '任务已取消' : task?.failureCode ? task.message : '媒体任务失败，请检查录像覆盖和服务端配置');
      if (task) mediaJobs.save(task);
      throw error;
    }).finally(() => {
      try { cleanArtifactWork(work); }
      catch { console.error('媒体临时目录清理失败，请检查文件权限。'); }
    });
  });
  return { ok: true, taskId, operation: job.kind, status: activeTasks.get(taskId).status, queuePosition: activeTasks.get(taskId).queuePosition, progressUrl: signedMediaTask(activeTasks.get(taskId)).progressUrl };
}

const mediaArchive = createMediaArchive();
const mediaJobs = createMediaJobStore();
function sourceConfigIdentity() {
  const configuredRoot = process.env.HIKVISION_ARCHIVE_DIR;
  let archiveRoot = configuredRoot ? path.resolve(configuredRoot) : '';
  if (archiveRoot) { try { archiveRoot = fs.realpathSync(archiveRoot); } catch {} }
  return { archiveRoot, playbackUrl: readPlaybackUrl() };
}
function cameraJobDependencies() {
  return {
    downloadsDir,
    resolveCamera, archive: mediaArchive, sourceConfigIdentity,
    async startHikvision({ camera, device, start, end, method, reservation }) {
      const deviceKey = crypto.createHash('sha256').update(device.id).digest('hex').slice(0, 16);
      reservation.outputDir = path.join(downloadsDir, `camera_${deviceKey}`);
      fs.mkdirSync(reservation.outputDir, { recursive: true });
      const result = startExportTask({
        ip: device.ip, httpPort: device.httpPort, rtspPort: device.rtspPort, deviceId: device.id, user: device.username, pass: device.password, channel: camera.channel,
        startTime: toCompact(start.slice(0, 10), start.slice(11)),
        endTime: toCompact(end.slice(0, 10), end.slice(11)), method,
        concurrency: method === 'rtspclip' ? 4 : undefined, [TASK_RESERVATION]: reservation,
      });
      if (!result.ok) throw new Error('海康导出无法启动。');
      return await result[TASK_COMPLETION];
    },
  };
}
function startCameraOperation(operation, body) {
  const dependencies = cameraJobDependencies();
  const job = operation === 'match' ? prepareMatchJob(body, dependencies) : prepareCameraJob(operation, body, dependencies);
  return startExportTask({ [CAMERA_JOB]: job });
}
function signedMediaTask(task) {
  const { controller, outputAlias, sourceOutput, failureDiagnostics, sdkMetadata, sampleReport, sampleMediaAttempted: _sampleMediaAttempted, sampleResumeAvailable: _sampleResumeAvailable, samplePreflightReport: _samplePreflightReport, ...safe } = task;
  const diagnostic = dvrRtspFailureDiagnostics(failureDiagnostics);
  const sampleRequest = task.kind === 'dvr-http-sample' ? recoveryStore.get(task.taskId)?.request : undefined;
  const sampleMediaAttempted = sampleRequest?.mediaAttempted;
  const isApprovedSample = task.kind === 'dvr-http-sample' && task.taskId === DVR_HTTP_SAMPLE_TASK_ID;
  const samplePreflightReport = isApprovedSample ? sanitizeDvrHttpSample(sampleRequest?.preflightAttempt) : undefined;
  return { ...safe, ...(sanitizeSdkMetadata(sdkMetadata) ? { sdkMetadata: sanitizeSdkMetadata(sdkMetadata) } : {}), sampleResumeAvailable: isApprovedSample && dvrHttpSampleControl.resumeAvailable(task.taskId) === true,
    ...(samplePreflightReport ? { samplePreflightReport } : {}), ...(typeof sampleMediaAttempted === 'boolean' ? { sampleMediaAttempted } : {}), ...(sanitizeDvrHttpSample(sampleReport) ? { sampleReport: sanitizeDvrHttpSample(sampleReport) } : {}), ...(task.artifactUrl ? { artifactUrl: downloadUrl(task.artifactUrl) } : {}),
    ...(diagnostic ? { failureDiagnostics: diagnostic } : {}),
    ...(task.progressUrl ? { progressUrl: signDownload(task.progressUrl, { token: mcpToken, baseUrl: configuredPublicUrl, ttl: DOWNLOAD_LINK_TTL_SECONDS }) } : {}),
    ...(task.files ? { files: task.files.map(({ outputAlias, sourceOutput, ...file }) => ({ ...file, artifactUrl: downloadUrl(file.artifactUrl) })) } : {}) };
}
app.get('/api/media-jobs/:id', (req, res) => {
  try { res.json({ success: true, task: signedMediaTask(activeTasks.get(req.params.id) || mediaJobs.read(req.params.id)) }); }
  catch { res.status(404).json({ success: false, error: '任务不存在。' }); }
});
app.get('/media-jobs/:id', (req, res) => {
  try {
    const task = signedMediaTask(activeTasks.get(req.params.id) || mediaJobs.read(req.params.id));
    if (req.query.format === 'json') return res.json(task);
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html').send(mediaJobPage());
  } catch { res.status(404).end(); }
});
const uploadQueue = createUploadQueue(downloadsDir, { getConnectionGeneration: () => process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED === '1' ? uploadAccounts.connectionGeneration('bilibili') : undefined });
const cloud189Queue = createCloud189Queue(downloadsDir, { getConnectionGeneration: () => process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED === '1' ? uploadAccounts.connectionGeneration('cloud189') : undefined });
const consoleSettingsFile = path.join(path.dirname(getDataFilePath()), 'public-console-settings.json');
const uploadSettingsStore = createUploadSettingsStore(consoleSettingsFile);
const readConsoleSettings = uploadSettingsStore.read;
const accountDataDir = path.dirname(getDataFilePath());
const uploadCover = createUploadCoverStore(path.join(accountDataDir, 'private', 'upload-accounts', 'cover'));
const managedUploadCapability = process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED === '1';
let verifiedUploadTools;
const accountToolAvailable = config => {
  if (!config.enabled || process.platform !== 'linux') return false;
  try { verifiedUploadTools ??= verifyManagedUploadTools(fs.realpathSync(__dirname)); return Object.values(verifiedUploadTools).includes(config.binary); } catch { return false; }
};
const managedUploads = createManagedUploadSupervisor({ releaseRoot: __dirname, dataDir: accountDataDir, downloadsDir, getState: () => {
  const settings = readConsoleSettings(), accounts = uploadAccounts.integrationState();
  return { preparationOnly: process.env.HIKCLIP_PREPARATION_ONLY === '1', recoveryReady: exportRecoveryBlocked === null,
    managedEnabled: managedUploadCapability,
    bilibili: { enabled: uploadAccountReady(accounts.bilibili), seasonId: settings.bilibiliSeasonId, sectionId: settings.bilibiliSectionId, coverPath: uploadCover.pathForWorker() },
    cloud189: { enabled: uploadAccountReady(accounts.cloud189) } };
} });
const uploadAccounts = createUploadAccountManager({
  ...uploadAccountConfig({ dataDir: path.dirname(getDataFilePath()), downloadsDir, releaseRoot: __dirname }),
  canWrite: () => exportRecoveryBlocked === null, available: accountToolAvailable, onAccountChange: async (provider, change) => {
    // An active account attempt makes readiness false. Await process-group exit
    // before credential promotion/quarantine; never revive another binding's jobs.
    if (change.phase === 'before_commit' && change.mode !== 'verify') await managedUploads.stopProvider(provider);
    return managedUploads.reconcile();
  },
});
managedUploads.start();
mountUploadAccounts(app, { manager: uploadAccounts });
mountCloud189Verification(app, { queue: cloud189Queue, verify: managedUploads.verifyCloud189, recover: managedUploads.recoverCloud189,
  canWrite: () => managedUploadCapability && exportRecoveryBlocked === null });
mountUploadCover(app, { store: uploadCover, canWrite: () => exportRecoveryBlocked === null, onChange: () => managedUploads.reconcile() });
// Native service termination also kills its cgroup; explicit cleanup covers foreground runs.
process.once('exit', () => { uploadAccounts.closeSync(); managedUploads.killNow(); consoleDvrHls?.killNow(); consoleDvrSdk?.killNow(); killSdkProcessesNow(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
  uploadAccounts.closeSync(); managedUploads.stop();
  // Preserve other shutdown handlers (runtime file, managed workers).
  if (process.listenerCount(signal) === 0) process.exit(0);
});
function consoleOutputs() {
  const files = listOutputLibrary(downloadsDir, { aliases: mediaJobs.outputAliases(), limit: null, inProgress: getInProgressOutputFilenames(),
    isBusy: filename => uploadQueue.isBusy(filename) || cloud189Queue.isBusy(filename) || outputRenames.isBusy(filename) })
    .map(file => ({ ...file, renamePending: outputRenames.isBusy(file.relativePath),
      busyReason: outputExportBusy(file.relativePath) ? 'export' : outputRenames.isBusy(file.relativePath) ? 'rename'
        : uploadQueue.isBusy(file.relativePath) ? 'upload' : cloud189Queue.busyReason(file.relativePath) }));
  const bilibili = uploadQueue.outputStates(files), cloud189 = cloud189Queue.outputStates(files);
  return files.map(file => ({ ...file, uploads: { bilibili: bilibili.get(file.id), cloud189: cloud189.get(file.id) } }));
}
function renameManagedOutput(id, newName) {
  if (exportRecoveryBlocked) throw new Error(exportRecoveryBlocked);
  return renameManagedOutputFile(downloadsDir, id, newName, {
    journal: outputRenames, onRename: renameOutputMetadata,
    isBusy: relativePath => outputExportBusy(relativePath)
      || uploadQueue.isBusy(relativePath) || cloud189Queue.isBusy(relativePath),
  });
}
function renameOutputMetadata(change) {
  cloud189Queue.renameOutput(change);
  mediaJobs.renameOutput(change, activeTasks.values());
  recoveryStore.renameOutput(change);
  for (const task of activeTasks.values()) recoveryStore.update(task);
}
function outputExportBusy(relativePath) {
  const active = getInProgressOutputFilenames();
  return active.has(relativePath) || active.has(path.basename(relativePath));
}
function outputBusy(file, { allowCloudUncertainty = false } = {}) {
  const cloudReason = cloud189Queue.busyReason(file.relativePath);
  return outputRenames.isBusy(file.relativePath) || outputExportBusy(file.relativePath) || uploadQueue.isBusy(file.relativePath)
    || (cloudReason !== null && !(allowCloudUncertainty && cloudReason === 'verification'));
}
function consoleUploadJobs() {
  return [...uploadQueue.list({ limit: 50 }).map(job => ({ ...job, provider: 'bilibili' })), ...cloud189Queue.list({ limit: 50 })]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 60);
}
function consoleIntegrations() {
  const settings = readConsoleSettings(), managed = managedUploads.status(), accounts = uploadAccounts.integrationState();
  const existing = readUploadIntegrations(downloadsDir, { enabled: managedUploadCapability ? true : process.env.HIKVISION_BILIUP_ENABLED === '1' });
  const allowed = provider => !managedUploadCapability || (uploadAccountReady(accounts[provider]) && managed[provider].running && managed[provider].state === 'running');
  return { ...existing, bilibiliEnabled: existing.bilibiliEnabled && allowed('bilibili'), cloud189Enabled: existing.cloud189Enabled && allowed('cloud189'),
    webLoginSupported: Object.values(accounts).some(account => account.available), managedUploads: managed,
    bilibiliAccountState: accounts.bilibili.state, cloud189AccountState: accounts.cloud189.state,
    bilibiliCollectionConfigured: settings.bilibiliSeasonId > 0 && settings.bilibiliSectionId > 0,
    bilibiliCoverAvailable: uploadCover.status().present };
}
function consoleDvrDevices() {
  return getAllDevices().devices.map((device, index) => ({
    id: device.id,
    name: device.name && device.name !== device.ip ? device.name : `录像机 ${index + 1}`,
  }));
}
function consoleCameras() {
  const dvrs = consoleDvrDevices(), dvrNames = new Map(dvrs.map(device => [device.id, device.name]));
  return cameraCatalog().map(camera => {
    return { id: camera.id, name: camera.name, dvrId: camera.deviceId || '', dvrName: dvrNames.get(camera.deviceId) || '', channel: camera.channel || '' };
  });
}
function consoleBootstrap() {
  const dashboard = getDashboardStatus();
  return { success: true, generatedAt: dashboard.generatedAt, configRevision: configSnapshot().revision, passwordManaged: statusPasswordStore.isManaged(), cameras: consoleCameras(), dvrs: consoleDvrDevices(), outputs: consoleOutputs(), uploads: consoleUploadJobs(),
    tasks: dashboard.tasks, activeTaskCount: dashboard.activeTaskCount, exportActiveTaskCount: dashboard.exportActiveTaskCount, uploadActiveTaskCount: dashboard.uploadActiveTaskCount, settings: readConsoleSettings(), integrations: consoleIntegrations() };
}
const dvrHttpSamplePrivateRoot = path.join(path.dirname(getDataFilePath()), 'dvr-http-sample-private');
const dvrHttpSampleControl = createDvrHttpSampleControl({ recoveryStore, activeTasks, exportQueue, mediaJobs, getDevice: getConsoleDvr,
  isReady: () => exportRecoveryBlocked === null, waitForPreview: () => previewSettlement,
  runSample: options => runDvrHttpSample({ ...options, ffmpegPath, ffprobePath, privateRoot: dvrHttpSamplePrivateRoot }) });
mountDvrHttpSample(app, { control: dvrHttpSampleControl, canWrite: () => exportRecoveryBlocked === null });
mountConsoleConfig(app, {
  testDevice: probeDevice,
  snapshotDevice,
  canWrite: () => exportRecoveryBlocked === null,
  onPlaybackChange: baseUrl => { mediaPlayback = createMediaMtxPlayback({ baseUrl }); },
  isBusy: deviceId => {
    if (exportRecoveryBlocked) return true;
    const references = request => !deviceId || request?.deviceId === deviceId || request?.jobs?.some(references);
    return [...activeTasks.values()].some(task => (exportQueue.owns(task.taskId) || !EXPORT_TERMINAL.has(task.status)) && (!deviceId || !recoveryStore.get(task.taskId) || references(recoveryStore.get(task.taskId).request)))
      || recoveryStore.load().some(record => record.corrupt || (!EXPORT_TERMINAL.has(record.task.status) && references(record.request)));
  },
});
app.get('/console/api/auth', (req, res) => res.json({ configured: statusPasswordStore.isConfigured() }));
app.get('/console/api/bootstrap', async (req, res) => {
  try { await mediaChannelDiscovery.refresh(); res.json(consoleBootstrap()); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/console/api/tasks', (req, res) => {
  try { res.json({ success: true, ...getDashboardStatus() }); }
  catch { res.status(500).json({ success: false, error: '无法读取任务状态。' }); }
});
app.post('/console/api/password', async (req, res) => {
  try {
    await statusPasswordStore.change(req.body?.oldPassword, req.body?.password);
    res.set('Set-Cookie', 'hikclip_status=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict').json({ success: true });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
mountUploadSettings(app, { store: uploadSettingsStore, integrations: consoleIntegrations, cover: () => uploadCover.status(),
  canWrite: () => !exportRecoveryBlocked, onChange: () => managedUploads.reconcile() });
app.get('/console/api/outputs', (req, res) => {
  try { res.json({ success: true, outputs: consoleOutputs() }); }
  catch { res.status(500).json({ success: false, error: '无法读取成片库。' }); }
});
mountOutputThumbnails(app, { root: downloadsDir, isReady: () => !exportRecoveryBlocked,
  isBusy: file => outputExportBusy(file.relativePath) || outputRenames.isBusy(file.relativePath) });
app.get('/console/api/outputs/:id/stream', (req, res) => {
  const file = resolveLibraryOutput(downloadsDir, req.params.id);
  if (!file) return res.status(404).end();
  const range = req.get('range');
  let start = 0, end = file.stats.size - 1, status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', `bytes */${file.stats.size}`).end();
    if (!match[1]) start = Math.max(0, file.stats.size - Number(match[2]));
    else start = Number(match[1]);
    if (match[2] && match[1]) end = Math.min(end, Number(match[2]));
    if (start > end || start >= file.stats.size) return res.status(416).set('Content-Range', `bytes */${file.stats.size}`).end();
    status = 206;
  }
  res.status(status).set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'Content-Length': String(end - start + 1), ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${file.stats.size}` } : {}) });
  fs.createReadStream(file.full, { start, end }).on('error', () => { if (!res.headersSent) res.status(500); res.end(); }).pipe(res);
});
app.post('/console/api/outputs/:id/recover-rename', (req, res) => {
  try {
    const file = resolveLibraryOutput(downloadsDir, req.params.id);
    if (!file) return res.status(404).json({ success: false, error: '成片不存在。' });
    if (exportRecoveryBlocked || outputExportBusy(file.relativePath)
      || uploadQueue.isBusy(file.relativePath) || cloud189Queue.isBusy(file.relativePath)) {
      return res.status(409).json({ success: false, error: '成片正在导出或上传，暂不能恢复改名。' });
    }
    const failures = outputRenames.recoverPath(file.relativePath, renameOutputMetadata, {
      isBusy: relativePath => outputExportBusy(relativePath)
        || uploadQueue.isBusy(relativePath) || cloud189Queue.isBusy(relativePath),
    });
    if (failures.length) return res.status(409).json({ success: false, error: failures[0] });
    res.json({ success: true, outputs: consoleOutputs() });
  } catch (error) { res.status(409).json({ success: false, error: error.message }); }
});
app.put('/console/api/outputs/:id', (req, res) => {
  try {
    const file = resolveLibraryOutput(downloadsDir, req.params.id);
    if (!file) return res.status(404).json({ success: false, error: '成片不存在。' });
    if (outputBusy(file)) {
      return res.status(409).json({ success: false, error: '文件正在导出或上传中，不能改名。' });
    }
    const result = renameManagedOutput(req.params.id, String(req.body?.newName || '').trim());
    if (!result) return res.status(404).json({ success: false, error: '成片不存在。' });
    res.json({ success: true, ...result });
  } catch (error) { res.status(['OUTPUT_EXISTS', 'OUTPUT_BUSY', 'OUTPUT_RENAME_PENDING'].includes(error.code) ? 409 : 400).json({ success: false, error: error.message }); }
});
app.delete('/console/api/outputs/:id', (req, res) => {
  try {
    const file = resolveLibraryOutput(downloadsDir, req.params.id);
    if (!file) return res.status(404).json({ success: false, error: '成片不存在。' });
    if (outputBusy(file)) {
      return res.status(409).json({ success: false, error: '文件正在导出或上传中，不能删除。' });
    }
    const deleted = deleteLibraryOutput(downloadsDir, req.params.id);
    res.json({ success: true, ...deleted });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.post('/console/api/outputs/:id/upload/bilibili', (req, res) => {
  try {
    if (!consoleIntegrations().bilibiliEnabled) throw new Error('服务器投稿 worker、程序、登录文件或封面尚未就绪；登录文件存在不代表账号有效。');
    const file = resolveLibraryOutput(downloadsDir, req.params.id);
    if (!file) return res.status(404).json({ success: false, error: '成片不存在。' });
    if (outputBusy(file, { allowCloudUncertainty: true })) return res.status(409).json({ success: false, error: '成片正在处理或上传中。' });
    const settings = readConsoleSettings();
    const title = uploadTitle(file.filename, settings);
    const draft = uploadQueue.prepare({ filename: file.relativePath, title, tid: 249, tags: ['足球'], onlySelf: true });
    const job = uploadQueue.submit(draft.id, true);
    res.status(202).json({ success: true, job });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.post('/console/api/outputs/:id/upload/cloud189', (req, res) => {
  try {
    if (!consoleIntegrations().cloud189Enabled) throw new Error('服务器端 cloudpan189-go 或登录态尚未就绪。');
    const file = resolveLibraryOutput(downloadsDir, req.params.id);
    if (!file) return res.status(404).json({ success: false, error: '成片不存在。' });
    if (outputBusy(file)) return res.status(409).json({ success: false, error: '成片正在处理或上传中。' });
    const settings = readConsoleSettings();
    const job = cloud189Queue.enqueue({ filename: file.relativePath, targetPath: settings.cloud189TargetPath });
    res.status(202).json({ success: true, job });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
mountMediaMtxLive(app, {
  transport: createMediaMtxLive({ baseUrl: process.env.HIKVISION_MEDIAMTX_WEBRTC_URL || 'http://127.0.0.1:8889' }),
  getCamera,
  async reservePreview(controller) {
    if (getRunningTask()) throw Object.assign(new Error('导出进行中，请稍后再预览。'), { status: 409 });
    const request = ++consolePreviewGeneration;
    const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk?.current;
    if (previous) await previous.stop('source changed');
    const isCurrent = () => !controller.signal.aborted && request === consolePreviewGeneration && !getRunningTask();
    if (!isCurrent()) throw Object.assign(new Error('预览已被较新的请求替换。'), { status: 409 });
    const pending = { stop() { controller.abort(); if (activePreview === pending) activePreview = null; } };
    activePreview = pending;
    return { isCurrent, attach: session => { activePreview = session; }, finish: session => { if (activePreview === session || activePreview === pending) activePreview = null; } };
  },
});
app.get('/console/api/playback/:camera/segments', async (req, res) => {
  try {
    const cameraId = req.params.camera;
    const camera = getCamera(cameraId);
    if (!camera) return res.status(404).json({ success: false, error: '摄像头不存在。' });
    const segments = await mediaPlayback.list(camera.archivePath || camera.id, req.query.date);
    res.json({ success: true, camera: cameraId, date: req.query.date, segments });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.get('/console/api/playback/:camera/stream', async (req, res) => {
  consolePreviewGeneration++;
  if (activePreview) activePreview.stop('source changed');
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  res.once('close', disconnected);
  try {
    const cameraId = req.params.camera;
    const camera = getCamera(cameraId);
    if (!camera) return res.status(404).json({ success: false, error: '摄像头不存在。' });
    const playback = mediaPlayback;
    if (req.query.format === 'mp4') {
      const sourceIdentity = cameraSourceIdentity(camera, camera.deviceId ? getDeviceById(camera.deviceId) : null, sourceConfigIdentity());
      const key = previewIdentity({ sourceIdentity, camera: cameraId, start: req.query.start, duration: req.query.duration });
      const lease = await playbackPreviews.acquire(key,
        signal => playback.get(camera.archivePath || camera.id, req.query.start, req.query.duration, { format: 'mp4', signal }),
        { signal: controller.signal });
      if (controller.signal.aborted) { lease.release(); return; }
      res.removeListener('close', disconnected);
      return servePreviewFile(req, res, lease);
    }
    const upstream = await playback.get(camera.archivePath || camera.id, req.query.start, req.query.duration,
      { format: req.query.format || 'fmp4', signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return res.status(502).json({ success: false, error: 'MediaMTX 暂时无法读取这段录像。' });
    }
    res.status(200).set({ 'Content-Type': upstream.headers.get('content-type') || 'video/mp4', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {}) });
    const stream = Readable.fromWeb(upstream.body);
    res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
    stream.on('error', () => { if (!res.headersSent) res.status(502); res.end(); }).pipe(res);
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) res.status(error.status || 400).json({ success: false, error: error.message });
  }
});
function getConsoleDvr(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) return null;
  return getDeviceById(id);
}
const consoleDvrChannels = new Map();
async function readConsoleDvrChannels(device) {
  const identity = crypto.createHash('sha256').update(JSON.stringify([device.id, device.ip, device.httpPort, device.username, device.password])).digest('hex');
  const cached = consoleDvrChannels.get(identity);
  if (cached && cached.until > Date.now()) return cached.promise;
  const promise = (async () => {
    const streams = await curlDigest(device, device.username, device.password, '/ISAPI/Streaming/channels');
    let names = '';
    try { names = await curlDigest(device, device.username, device.password, '/ISAPI/ContentMgmt/InputProxy/channels'); } catch {}
    return parseDvrChannels(streams, names);
  })();
  for (const [key, value] of consoleDvrChannels) if (value.until <= Date.now()) consoleDvrChannels.delete(key);
  if (consoleDvrChannels.size >= 64) consoleDvrChannels.delete(consoleDvrChannels.keys().next().value);
  consoleDvrChannels.set(identity, { until: Date.now() + 60000, promise });
  try { return await promise; } catch (error) { consoleDvrChannels.delete(identity); throw error; }
}
app.get('/console/api/dvrs/:id/channels', preparationGuard, async (req, res) => {
  try {
    const device = getConsoleDvr(req.params.id);
    if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
    const channels = await readConsoleDvrChannels(device);
    res.set('Cache-Control', 'private, no-store').json({ success: true, channels, playbackTransport: sdkEnabled(device) ? 'hcnetsdk' : 'rtsp' });
  } catch (error) {
    const message = String(error?.message || '');
    res.status(502).json({ success: false, error: /401|认证|digest/i.test(message) ? '录像机认证失败，请检查设备账号。' : /timeout|超时/i.test(message) ? '连接录像机超时。' : '读取镜头失败，请检查设备连接和权限。' });
  }
});
app.get('/console/api/dvrs/:id/segments', async (req, res) => {
  try {
    const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || '');
    if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
    if (!CHANNEL_PATTERN.test(channel)) return res.status(400).json({ success: false, error: '请选择有效的 DVR 通道。' });
    const range = dvrDateRange(req.query.date);
    const recordings = await searchRecordings(device, device.username, device.password, channel, range.start, range.end);
    const segments = normalizeDvrSegments(recordings, req.query.date);
    res.set('Cache-Control', 'private, no-store').json({ success: true, date: req.query.date, channel, segments });
  } catch (error) {
    const message = String(error?.message || '');
    const invalidDate = /日期格式|日期不存在/.test(message);
    res.status(invalidDate ? 400 : 502).json({ success: false, error: invalidDate ? message : /401|认证|digest/i.test(message) ? '录像机认证失败，请检查服务器中保存的设备账号。' : /timeout|超时/i.test(message) ? '查询录像超时，请检查服务器与 DVR 的网络。' : '查询 DVR 录像失败，请检查录像机连接和录像权限。' });
  }
});
app.get('/console/api/dvrs/:id/stream', async (req, res, next) => {
  if (req.query.format !== 'hls') return next();
  const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  try {
    if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
    const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || ''), start = String(req.query.start || '');
    const startMs = Date.parse(start), duration = Number(req.query.duration), client = String(req.query.client || '');
    if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
    if (!CHANNEL_PATTERN.test(channel) || Number(channel) < 1 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(start) || !Number.isFinite(startMs) || !Number.isFinite(duration) || duration < 0.5 || duration > DVR_HLS_MAX_SECONDS) return res.status(400).json({ success: false, error: '回放通道、时间或时长无效。' });
    const manager = getConsoleDvrHls(), generation = manager.accept(client, req.query.generation);
    const same = manager.current?.client === client && manager.current.generation === generation;
    const request = same ? consolePreviewGeneration : ++consolePreviewGeneration;
    if ((activePreview || consoleDvrHls?.current || consoleDvrSdk?.current) && !same) { const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk.current; await previous.stop('superseded'); }
    const session = await manager.begin({ url: dvrRtspUrl(device, mainDvrChannel(channel), { startMs, duration }), duration, client, generation,
      isCurrent: () => !controller.signal.aborted && request === consolePreviewGeneration && !getRunningTask(),
      onFinish: finished => { if (activePreview === finished) activePreview = null; } });
    if (request !== consolePreviewGeneration || controller.signal.aborted || getRunningTask()) { await session.stop('superseded'); if (!res.destroyed) res.status(409).end(); return; }
    activePreview = session;
    await session.wait(controller.signal);
    if (!controller.signal.aborted && !res.destroyed && request === consolePreviewGeneration) res.set('Cache-Control', 'private, no-store').redirect(302, `../../dvr-preview/${session.id}/index.m3u8`);
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) res.status([400, 409, 502, 503, 504].includes(error.status) ? error.status : 502).json({ success: false, error: error.status ? error.message : '无法准备 DVR HLS 兼容预览。' });
  } finally { res.removeListener('close', disconnected); }
});
app.get('/console/api/dvr-preview/:sessionId/:filename', (req, res) => consoleDvrHls ? consoleDvrHls.serve(req, res) : res.status(410).end());
app.post('/console/api/dvr-preview/stop', async (req, res) => {
  try { if (consoleDvrHls) await consoleDvrHls.stopClient(String(req.body?.client || ''), req.body?.generation); res.status(204).end(); }
  catch { res.status(409).json({ success: false, error: '预览已切换或请求无效。' }); }
});
// SDK preview is an explicit bounded preparation, followed by private range reads.
// It shares activePreview and the export queue's stop/settlement barrier.
app.get('/console/api/dvrs/:id/stream', async (req, res, next) => {
  if (req.query.format !== 'sdk') return next();
  const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  let session;
  try {
    if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
    const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || ''), start = String(req.query.start || '');
    const startMs = Date.parse(start), duration = Number(req.query.duration);
    if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
    if (!sdkEnabled(device)) return res.status(409).json({ success: false, error: '此录像机未启用 SDK 回放。' });
    if (!/^\d{1,6}01$/.test(channel) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(start)
      || !Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 19) !== start.slice(0, 19)
      || !Number.isFinite(duration) || duration < 1 || duration > 30)
      return res.status(400).json({ success: false, error: 'SDK 预览每段须为 1–30 秒，请选择有效的主码流通道。' });
    const manager = getConsoleDvrSdk(), client = String(req.query.client || ''), generation = Number(req.query.generation);
    const same = manager.current?.client === client && manager.current.generation === generation && !manager.current.finished;
    const request = same ? consolePreviewGeneration : consolePreviewGeneration + 1, previous = activePreview || consoleDvrHls?.current || consoleDvrSdk?.current;
    // begin validates generation synchronously before a stale request can stop a newer preview.
    session = manager.begin({ device, channel,
      startTime: msToCompact(startMs + 8 * 3600000), endTime: msToCompact(startMs + 8 * 3600000 + duration * 1000),
      client, generation,
      beforeDownload: () => previous && previous !== manager.current ? previous.stop('superseded') : Promise.resolve(),
      isCurrent: () => request === consolePreviewGeneration && !getRunningTask(),
      onFinish: finished => { if (activePreview === finished) activePreview = null; } });
    consolePreviewGeneration = request; activePreview = session;
    const prepared = await session.wait(controller.signal);
    if (controller.signal.aborted || request !== consolePreviewGeneration || getRunningTask()) { await session.stop('superseded'); if (!res.destroyed) res.status(409).end(); return; }
    res.set('Cache-Control', 'private, no-store').json({ success: true, ...prepared });
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) res.status([400, 409, 502, 503, 504].includes(error.status) ? error.status : 502)
      .json({ success: false, error: error.status ? error.message : 'SDK 预览失败，请检查安装、设备连接及回放权限。' });
  } finally { res.removeListener('close', disconnected); }
});
app.get('/console/api/dvr-sdk-preview/:sessionId/media.mp4', (req, res) => consoleDvrSdk ? consoleDvrSdk.serve(req, res) : res.status(410).end());
app.post('/console/api/dvr-sdk-preview/stop', async (req, res) => {
  if (exportRecoveryBlocked) return res.status(409).end();
  try { await getConsoleDvrSdk().stopClient(String(req.body?.client || ''), Number(req.body?.generation)); res.status(204).end(); }
  catch { res.status(409).json({ success: false, error: '预览已切换或请求无效。' }); }
});
app.get('/console/api/dvrs/:id/stream', async (req, res) => {
  if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
  try { checkDvrPreviewGeneration(req); } catch { return res.status(409).json({ success: false, error: '预览已切换。' }); }
  const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || ''), startText = String(req.query.start || '');
  const startMs = Date.parse(startText), duration = Number(req.query.duration);
  if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
  if (!CHANNEL_PATTERN.test(channel) || Number(channel) < 1) return res.status(400).json({ success: false, error: '请选择有效的 DVR 通道。' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startText) || !Number.isFinite(startMs) || !Number.isFinite(duration) || duration < 0.5 || duration > 21600) {
    return res.status(400).json({ success: false, error: '回放起始时间或时长无效。' });
  }
  const format = String(req.query.format || 'fmp4');
  if (!['fmp4', 'compat'].includes(format)) return res.status(400).json({ success: false, error: '无效的预览格式。' });
  const request = ++consolePreviewGeneration;
  if (activePreview || consoleDvrHls?.current || consoleDvrSdk?.current) { const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk.current; await previous.stop('superseded'); }
  if (request !== consolePreviewGeneration || res.destroyed || getRunningTask()) return res.status(409).end();
  const session = consoleDvrPreview({ res, urls: [dvrRtspUrl(device, mainDvrChannel(channel), { startMs, duration })], duration, format,
    onFinish: finished => { if (activePreview === finished) activePreview = null; } });
  if (!session.finished) activePreview = session;
});
const consoleDvrPreview = createDvrPreview({ ffmpegPath, spawn,
  onFailure: ({ reason, format, method, rtspStatus, category, exitCode, elapsedMs, outputBytes }) =>
    console.warn('[DVR preview]', JSON.stringify({ reason, format, method, rtspStatus, category, exitCode, elapsedMs, outputBytes })) });
app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res, next) => {
  if (req.query.format !== 'hls') return next();
  const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  try {
    if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
    const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || '');
    const duration = 600, client = String(req.query.client || '');
    if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
    if (!CHANNEL_PATTERN.test(channel) || Number(channel) < 1) return res.status(400).json({ success: false, error: '请选择有效的 DVR 通道。' });
    const manager = getConsoleDvrHls(), generation = manager.accept(client, req.query.generation);
    const same = manager.current?.client === client && manager.current.generation === generation;
    const request = same ? consolePreviewGeneration : ++consolePreviewGeneration;
    const main = mainDvrChannel(channel); let sub;
    if (req.query.stream !== 'main') {
      try { sub = (await readConsoleDvrChannels(device)).find(item => item.id === main)?.substreamId; } catch {}
    }
    if (controller.signal.aborted || request !== consolePreviewGeneration || getRunningTask()) { if (!res.destroyed) res.status(409).end(); return; }
    if ((activePreview || consoleDvrHls?.current || consoleDvrSdk?.current) && !same) { const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk.current; await previous.stop('superseded'); }
    const urls = [...new Set([sub, main].filter(Boolean))].map(track => dvrRtspUrl(device, track, { live: true }));
    const session = await manager.begin({ urls, duration, live: true, client, generation,
      isCurrent: () => request === consolePreviewGeneration && !getRunningTask(),
      onFinish: finished => { if (activePreview === finished) activePreview = null; } });
    if (request !== consolePreviewGeneration || getRunningTask()) { await session.stop('superseded'); if (!res.destroyed) res.status(409).end(); return; }
    activePreview = session;
    await session.wait(controller.signal);
    if (!controller.signal.aborted && !res.destroyed && request === consolePreviewGeneration) res.set('Cache-Control', 'private, no-store').redirect(302, `../../dvr-preview/${session.id}/index.m3u8`);
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) res.status([400, 409, 502, 503, 504].includes(error.status) ? error.status : 502).json({ success: false, error: error.status ? error.message : '无法准备 DVR HLS 兼容预览。' });
  } finally { res.removeListener('close', disconnected); }
});
app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res) => {
  if (exportRecoveryBlocked || getRunningTask()) return res.status(409).json({ success: false, error: '导出或恢复任务正在运行，请稍后预览。' });
  try { checkDvrPreviewGeneration(req); } catch { return res.status(409).json({ success: false, error: '预览已切换。' }); }
  const device = getConsoleDvr(req.params.id), channel = String(req.query.channel || ''), format = String(req.query.format || 'fmp4');
  if (!device) return res.status(404).json({ success: false, error: '录像机不存在。' });
  if (!CHANNEL_PATTERN.test(channel) || Number(channel) < 1 || !['fmp4', 'compat'].includes(format)) return res.status(400).json({ success: false, error: '镜头或预览格式无效。' });
  const generation = ++consolePreviewGeneration;
  const main = mainDvrChannel(channel);
  let sub = null;
  try { sub = (await readConsoleDvrChannels(device)).find(item => item.id === main)?.substreamId; } catch {}
  if (res.destroyed) return;
  if (generation !== consolePreviewGeneration) return res.status(409).json({ success: false, error: '预览已切换。' });
  const urls = [...new Set([req.query.stream !== 'main' && sub, main].filter(Boolean))].map(track => dvrRtspUrl(device, track, { live: true }));
  if (activePreview || consoleDvrHls?.current || consoleDvrSdk?.current) { const previous = activePreview || consoleDvrHls?.current || consoleDvrSdk.current; await previous.stop('superseded'); }
  if (generation !== consolePreviewGeneration || res.destroyed || getRunningTask()) return res.status(409).end();
  const session = consoleDvrPreview({ res, urls, duration: 600, format,
    onFinish: finished => { if (activePreview === finished) activePreview = null; } });
  if (!session.finished) activePreview = session;
});
app.post('/console/api/export', async (req, res) => {
  const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', disconnected); res.once('close', disconnected);
  try {
    const job = prepareConsoleExport(req.body, { ...cameraJobDependencies(), getDevice: getConsoleDvr, playback: mediaPlayback });
    job.initialPlan = await (job.preflight || job.plan)({ signal: controller.signal });
    if (controller.signal.aborted || res.destroyed) return;
    if (job.recoveryRequest) job.recoveryRequest.plan = job.initialPlan;
    const result = startExportTask({ [CAMERA_JOB]: job });
    res.status(result.ok ? 202 : result.status).json({ ...result, success: result.ok,
      status: result.reused ? 'completed' : activeTasks.get(result.taskId)?.status });
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) res.status(error.code === 'MEDIAMTX_GAPS' ? 409 : error.code === 'MEDIAMTX_EMPTY' ? 422 : [502, 504].includes(error.status) ? error.status : 400)
      .json({ success: false, error: error.message, ...(error.coverage ? { code: error.code, coverage: error.coverage } : {}) });
  } finally { req.removeListener('aborted', disconnected); res.removeListener('close', disconnected); }
});
app.get('/console/api/cache', (req, res) => {
  try {
    const files = listDvrCache(downloadsDir).map(({ filename, size, complete }) => ({ filename, size, complete }));
    res.json({ success: true, files, completeCount: files.filter(file => file.complete).length });
  } catch { res.status(500).json({ success: false, error: '无法读取 DVR 下载缓存。' }); }
});
app.delete('/console/api/cache', (req, res) => {
  try {
    const busy = Boolean(getRunningTask());
    if (busy) return res.status(409).json({ success: false, error: '导出任务正在运行，等任务结束后再清理缓存。' });
    const result = cleanCompletedDvrCache(downloadsDir);
    res.json({ success: true, ...result });
  } catch { res.status(500).json({ success: false, error: '清理缓存失败。' }); }
});
function getDashboardStatus() {
  const { devices = [] } = getAllDevices();
  const allTasks = Array.from(activeTasks.values());
  const unfinished = task => exportQueue.owns(task.taskId) || !['completed', 'error', 'cancelled'].includes(task.status);
  // Never truncate running/queued work: every waiting item must remain cancellable.
  const visibleTasks = [...allTasks.filter(unfinished), ...allTasks.filter(task => !unfinished(task)).slice(-30)];
  const tasks = visibleTasks.map(task => {
    const sampleRequest = task.kind === 'dvr-http-sample' ? recoveryStore.get(task.taskId)?.request : undefined;
    const sampleMediaAttempted = sampleRequest?.mediaAttempted;
    const isApprovedSample = task.kind === 'dvr-http-sample' && task.taskId === DVR_HTTP_SAMPLE_TASK_ID;
    let message = String(task.message || '');
    for (const device of devices) for (const secret of [device.password, device.username]) if (secret) message = message.replaceAll(secret, '[已隐藏]');
    return { taskId: task.taskId, kind: task.kind, status: task.status, queuePosition: task.queuePosition, progress: task.progress, message,
      stage: task.stage, stagePercent: task.stagePercent, progressUnit: task.progressUnit, processedSeconds: task.processedSeconds, progressUpdatedAt: task.progressUpdatedAt,
      recovered: task.recovered, startTime: task.startTime, queuedAt: task.queuedAt, startedAt: task.startedAt, filename: task.filename, camera: task.camera, start: task.start, end: task.end,
      source: task.source, sdkMetadata: sanitizeSdkMetadata(task.sdkMetadata), coverage: task.coverage, acceptGaps: task.acceptGaps, failureCode: task.failureCode,
      failureDiagnostics: dvrRtspFailureDiagnostics(task.failureDiagnostics),
      sampleMediaAttempted: typeof sampleMediaAttempted === 'boolean' ? sampleMediaAttempted : undefined,
      sampleResumeAvailable: isApprovedSample && dvrHttpSampleControl.resumeAvailable(task.taskId) === true,
      samplePreflightReport: isApprovedSample ? sanitizeDvrHttpSample(sampleRequest?.preflightAttempt) : undefined,
      dvrHttpSampleAvailable: dvrHttpSampleControl.available(task.taskId), sampleReport: sanitizeDvrHttpSample(task.sampleReport), total: task.total, completedCount: task.files?.length || 0,
      transferredBytes: task.transferredBytes, transferScope: task.transferScope, speed: task.speed, speedX: task.speedX, speedUpdatedAt: task.speedUpdatedAt };
  });
  const exportActiveTaskCount = allTasks.filter(unfinished).length;
  const uploadActiveTaskCount = uploadQueue.activeCount() + cloud189Queue.activeCount();
  return { generatedAt: new Date().toISOString(), tasks, activeTaskCount: exportActiveTaskCount + uploadActiveTaskCount, exportActiveTaskCount, uploadActiveTaskCount, uploads: consoleUploadJobs(), settings: readConsoleSettings(),
    integrations: consoleIntegrations() };
}
app.post('/api/bilibili/prepare', (req, res) => {
  try {
    if (!consoleIntegrations().bilibiliEnabled) throw new Error('服务器投稿 worker、程序、登录文件或封面尚未就绪；登录文件存在不代表账号有效。');
    if (getInProgressOutputFilenames().has(req.body?.filename)) throw new Error('视频尚未完成。');
    res.json({ success: true, job: uploadQueue.prepare({ ...req.body, tid: 249, tags: ['足球'], onlySelf: true }) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.post('/api/bilibili/submit', (req, res) => {
  try {
    if (!consoleIntegrations().bilibiliEnabled) return res.status(400).json({ success: false, error: '服务器投稿 worker、程序、登录文件或封面尚未就绪；登录文件存在不代表账号有效。' });
    res.json({ success: true, job: uploadQueue.submit(req.body?.id, req.body?.confirmed) });
  }
  catch { res.status(400).json({ success: false, error: '投稿任务无效或尚未确认。' }); }
});
app.get('/api/bilibili/status/:id', (req, res) => {
  try { res.json({ success: true, job: uploadQueue.get(req.params.id) }); }
  catch { res.status(404).json({ success: false, error: '投稿任务不存在。' }); }
});
app.get('/api/cameras', async (req, res) => {
  try { await mediaChannelDiscovery.refresh(); res.json({ success: true, cameras: listCameras() }); }
  catch { res.status(500).json({ success: false, error: '摄像头配置无效，请检查 cameras.json。' }); }
});
for (const operation of ['clip', 'snapshot', 'timeline', 'match']) {
  app.post(`/api/cameras/${operation}`, (req, res) => {
    try {
      const result = startCameraOperation(operation, req.body);
      res.status(result.ok ? 202 : result.status).json({ ...result, success: result.ok });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });
}

function startExportTask(options) {
  if (exportRecoveryBlocked) return { ok: false, status: 503, error: exportRecoveryBlocked };
  if (options[CAMERA_JOB]) return startCameraJob(options[CAMERA_JOB], options[RECOVERED_TASK]);
  const reservation = options[TASK_RESERVATION];
  const { ip, user, pass, channel, startTime, endTime, httpPort, rtspPort, deviceId } = options;
  try { normalizeDeviceEndpoint({ ip, httpPort, rtspPort }); } catch { return { ok: false, status: 400, error: '录像机地址或端口无效。' }; }
  const method = options.method || 'rtspclip';

  const concurrency = Math.max(1, Math.min(8, parseInt(options.concurrency, 10) || 4));

  console.log(`[API] Export request: ${ip}, channel ${channel}, from ${startTime} to ${endTime} (method=${method}, concurrency=${concurrency})`);

  if (!ip || !user || !pass || !channel || !startTime || !endTime) {
    return { ok: false, status: 400, error: 'Missing parameters' };
  }

  if (!['rtspclip', 'mp4download'].includes(method)) {
    return { ok: false, status: 400, error: 'Unsupported export method' };
  }
  if (!CHANNEL_PATTERN.test(String(channel))) {
    return { ok: false, status: 400, error: 'Invalid channel' };
  }
  if (!HIK_COMPACT_TIME_PATTERN.test(String(startTime)) || !HIK_COMPACT_TIME_PATTERN.test(String(endTime))) {
    return { ok: false, status: 400, error: 'Invalid time format' };
  }
  const validationStartMs = compactToMs(startTime);
  const validationEndMs = compactToMs(endTime);
  if (!Number.isFinite(validationStartMs) || !Number.isFinite(validationEndMs) || validationEndMs <= validationStartMs) {
    return { ok: false, status: 400, error: 'Invalid time range' };
  }
  // compactToMs 把「墙上时钟」按 UTC 解析（前端 formatHikTime 是直接给本地时间贴 Z，
  // 并不做时区换算），所以不能拿它和 Date.now() 直接比——当前时刻要按同样语义折算，
  // 否则非 UTC 时区下会把所有正常导出都拦掉。
  const now = new Date();
  const nowWallMs = Date.UTC(
    now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds()
  );
  if (validationEndMs > nowWallMs) {
    return { ok: false, status: 400, error: '结束时间不能晚于当前时间，请重新选择时间范围' };
  }

  // 旧 MCP export_clip 和 Web 导出也先查已完成的同区间录像，避免重复拉取数小时。
  if (!reservation && !options[RECOVERED_TASK]) {
    try {
      const mapped = cameraCatalog().filter(camera => camera.deviceId).map(camera => ({ camera, device: getDeviceById(camera.deviceId) })).find(({ camera, device }) =>
        device && String(camera.channel) === String(channel) && deviceEndpointIdentity(device) === deviceEndpointIdentity({ ip, httpPort, rtspPort }) && (!deviceId || device.id === deviceId) && device.username === user && device.password === pass);
      if (mapped) {
        const existing = mediaJobs.findByRange({ camera: mapped.camera.id, sourceIdentity: cameraSourceIdentity(mapped.camera, mapped.device, sourceConfigIdentity()),
          start: compactToDisplay(startTime), end: compactToDisplay(endTime), mode: 'copy' }, downloadsDir);
        if (existing) return reuseFinishedClip(existing);
      }
    } catch { /* 摄像头目录不可用时仍允许原有导出路径。 */ }
  }

  const baseFilename = `dvr${deviceCacheKey({ ip, httpPort, rtspPort, deviceId })}_ch${channel}_${startTime}_to_${endTime}`.replace(/[:]/g, '');
  const relativeOutput = path.relative(downloadsDir, path.join(reservation?.outputDir || downloadsDir, `${baseFilename}.mp4`));
  if (outputRenames.isBusy(relativeOutput)) return { ok: false, status: 409, error: '目标文件名有未完成的改名记录，暂不重新导出。' };
  if (!reservation) {
    const requestKey = crypto.createHash('sha256').update(JSON.stringify({ ip, httpPort, rtspPort, deviceId, user, pass, channel: String(channel), startTime, endTime, method, concurrency })).digest('hex');
    const duplicate = activeTasks.get(exportQueue.find(requestKey)?.taskId);
    if (duplicate) return { ok: true, taskId: duplicate.taskId, filename: duplicate.filename, method,
      status: duplicate.status, queuePosition: duplicate.queuePosition };
    const recovered = options[RECOVERED_TASK];
    const taskId = recovered?.task.taskId || crypto.randomUUID(), controller = new AbortController();
    const task = { taskId, managedExport: true, kind: 'clip', requestKey, controller, source: 'hikvision', channel: String(channel), start: compactToDisplay(startTime), end: compactToDisplay(endTime), queuedAt: recovered?.task.queuedAt || Date.now(), recovered: Boolean(recovered), filename: `${baseFilename}.mp4`, startTime: Date.now(), status: 'queued', progress: null };
    const device = getAllDevices().devices.find(device => deviceEndpointIdentity(device) === deviceEndpointIdentity({ ip, httpPort, rtspPort }) && (!deviceId || device.id === deviceId) && device.username === user && device.password === pass);
    const request = recovered?.request || { type: 'legacy', deviceId: device?.id, endpoint: deviceEndpointIdentity({ ip, httpPort, rtspPort }), options: { httpPort, rtspPort, deviceId, channel: String(channel), startTime, endTime, method, concurrency } };
    try { if (!recovered) recoveryStore.admit(task, request); }
    catch { return { ok: false, status: 503, error: '无法保存导出请求，请检查数据目录权限或磁盘空间；任务未启动。' }; }
    activeTasks.set(taskId, task);
    const completion = exportQueue.submit(task, async () => {
      await previewSettlement;
      if (controller.signal.aborted) throw new Error('任务已取消');
      if (recovered) {
        const published = await reconcilePublications({ record: recovered, store: recoveryStore, downloadsDir, signal: controller.signal });
        if (published.length) { Object.assign(activeTasks.get(taskId), published[0]); return; }
      }
      const outputDir = path.join(downloadsDir, `camera_${crypto.createHash('sha256').update(device?.id || ip).digest('hex').slice(0, 16)}`);
      fs.mkdirSync(outputDir, { recursive: true });
      const started = startExportTask({ ...options, [TASK_RESERVATION]: { taskId, controller, outputDir } });
      if (!started.ok) throw new Error(started.error);
      const native = await started[TASK_COMPLETION];
      controller.signal.throwIfAborted();
      const artifact = allocateArtifact('clip'), work = artifactWorkDir(), outputFile = path.join(work, path.basename(artifact.file));
      try {
        const sourceOutput = captureOutputSource(downloadsDir, native);
        await fs.promises.copyFile(native, outputFile, fs.constants.COPYFILE_FICLONE);
        const result = await publishExport({ store: recoveryStore, taskId, downloadsDir, key: task.filename, artifact, outputFile, filename: task.filename, selected: { source: 'hikvision', ...(outputSourceUnchanged(downloadsDir, sourceOutput) ? { sourceOutput } : {}) }, signal: controller.signal });
        Object.assign(activeTasks.get(taskId), result);
      } finally { cleanArtifactWork(work); }
    });
    return { ok: true, taskId, filename: task.filename, method, status: task.status, queuePosition: task.queuePosition, [TASK_COMPLETION]: completion };
  }
  if (!exportQueue.owns(reservation.taskId)) return { ok: false, status: 409, error: '无效的导出任务预约' };
  const taskId = reservation.taskId;
  activeTasks.get(taskId).nativeFilename = `${baseFilename}.mp4`;
  const result = { ok: true, taskId, filename: `${baseFilename}.mp4`, method };

  // Opted-in DVRs use the bounded SDK transport inside this same reservation.
  // Never fall back to HTTP whole-file download after an SDK failure.
  const sdkDevice = deviceId ? getDeviceById(deviceId) : null;
  if (sdkDevice && sdkEnabled(sdkDevice)) {
    if (deviceEndpointIdentity(sdkDevice) !== deviceEndpointIdentity({ ip, httpPort, rtspPort })
      || sdkDevice.username !== user || sdkDevice.password !== pass)
      return { ok: false, status: 409, error: '录像机配置已变化，请重新提交。' };
    const sdkFilename = `${baseFilename}_sdk_${crypto.randomUUID().slice(0, 8)}.mp4`;
    const outputFile = path.join(reservation.outputDir, sdkFilename);
    const task = activeTasks.get(taskId);
    task.nativeFilename = sdkFilename; result.filename = sdkFilename;
    Object.assign(task, { status: 'downloading', progress: null, message: '正在通过 SDK 按所选时间取回录像', transport: 'hcnetsdk' });
    result[TASK_COMPLETION] = sdkDownloadMp4({ device: sdkDevice, channel: String(channel), startTime, endTime,
      outputFile, signal: reservation.controller.signal, curlDigest,
      onProgress(_progress, message) { if (!reservation.controller.signal.aborted) broadcastProgress(taskId, 'downloading', null, message || '正在准备 SDK 录像'); },
    }).then(metadata => {
      const current = activeTasks.get(taskId);
      if (current) { current.sdkMetadata = sanitizeSdkMetadata(metadata); recoveryStore.update(current); }
      return outputFile;
    });
    return result;
  }

  // --- RTSP Clip Export（快速导出：Rate-Control:no 并发拉取 H.264 + AAC）---
  if (method === 'rtspclip') {
    console.log(`[${taskId}] Using RTSP clip export (fast, concurrent, video+audio)`);

    const controller = reservation?.controller || new AbortController();
    activeTasks.set(taskId, {
      ...activeTasks.get(taskId),
      taskId,
      status: 'downloading',
      progress: 0,
      message: '任务已启动',
      startTime: Date.now(),
      filename: activeTasks.get(taskId)?.cameraJob ? activeTasks.get(taskId).filename : result.filename,
      controller,
    });

    const rtspclipConcurrency = Math.max(1, Math.min(4, parseInt(options.concurrency, 10) || 2));

    const completion = runRtspClipExport({
      ip, httpPort, rtspPort, deviceId, user, pass, channel, startTime, endTime,
      taskId, sseClients: [],
      outputDir: reservation?.outputDir || downloadsDir,
      signal: controller.signal,
      concurrency: rtspclipConcurrency,
    });
    result[TASK_COMPLETION] = completion;
    completion
      .then((filePath) => {
        console.log(`[${taskId}] RTSP clip export completed: ${filePath}`);
      })
      .catch((err) => {
        if (err.message === '导出已取消' || controller.signal.aborted) {
          console.log(`[${taskId}] RTSP clip export aborted by user`);
        } else {
          console.error(`[${taskId}] RTSP clip export failed:`, err.message);
        }
      });
    return result;
  }

  // --- MP4 Download Pipeline (ISAPI HTTP direct download) ---
  if (method === 'mp4download') {
    console.log(`[${taskId}] Using MP4 download pipeline (ISAPI HTTP direct download)`);

    const controller = reservation?.controller || new AbortController();

    // Register the task in activeTasks immediately so /api/export/stop can
    // find it before the pipeline broadcasts its first progress update.
    // broadcastProgress() preserves this controller across status updates and
    // clears it on completed/error.
    activeTasks.set(taskId, {
      ...activeTasks.get(taskId),
      taskId,
      status: 'downloading',
      lastUpdated: Date.now(),
      progress: 0,
      message: '任务已启动',
      startTime: Date.now(),
      filename: activeTasks.get(taskId)?.cameraJob ? activeTasks.get(taskId).filename : result.filename,
      controller,
    });

    const completion = runMp4DownloadPipeline({
      ip, httpPort, rtspPort, deviceId,
      user,
      pass,
      channel,
      startTime,
      endTime,
      taskId,
      sseClients: [],
      outputDir: reservation?.outputDir || downloadsDir,
      signal: controller.signal,
    }).catch(error => { if (controller.signal.aborted || error.name === 'AbortError') throw error; throw dvrExportError(error.code); });
    result[TASK_COMPLETION] = completion;
    completion
      .then((filePath) => {
        console.log(`[${taskId}] MP4 download pipeline completed: ${filePath}`);
        broadcastProgress(taskId, 'completed', 100, `导出成功！文件保存为: ` + path.basename(filePath));
      })
      .catch((err) => {
        // AbortError is expected when the user clicks stop — don't log it
        // as an unexpected failure. The /api/export/stop handler has already
        // broadcast the "任务已停止" message.
        if (err.name === 'AbortError' || controller.signal.aborted) {
          console.log(`[${taskId}] MP4 download pipeline aborted by user`);
        } else {
          console.error(`[${taskId}] MP4 download pipeline failed:`, err.message);
          broadcastProgress(taskId, 'error', 0, `导出失败: ${err.message}`);
        }
      });
    return result;
  }

  return result;
}

app.post('/api/export', (req, res) => {
  const result = startExportTask(req.body || {});

  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      error: result.error,
      // 409 时带上正在跑的那个任务，前端/MCP 可以直接去查它的进度或停掉它
      ...(result.taskId ? { runningTaskId: result.taskId } : {}),
    });
  }

  res.json({
    success: true,
    message: result.reused ? 'Reused completed export' : result.status === 'queued' ? 'Export queued' : 'Export started',
    filename: result.filename,
    taskId: result.taskId,
    method: result.method,
    status: result.status || activeTasks.get(result.taskId)?.status,
    queuePosition: result.queuePosition ?? null,
    reused: result.reused === true,
  });
});

// 5. Recordings Search Endpoint
app.get('/api/recordings', async (req, res) => {
  const { ip, user, pass, channel, startTime, endTime } = req.query;
  console.log(`[API] Recordings search: ${ip}, channel ${channel}, from ${startTime} to ${endTime}`);

  if (!ip || !user || !pass || !channel || !startTime || !endTime) {
    return res.status(400).json({ success: false, error: 'Missing parameters: ip, user, pass, channel, startTime, endTime are required' });
  }

  try {
    // Convert compact format to ISO for the search function
    const isoStartTime = compactToIso(startTime);
    const isoEndTime = compactToIso(endTime);

    const recordings = await searchRecordings(ip, user, pass, channel, isoStartTime, isoEndTime, req.query.httpPort);

    const totalSize = recordings.reduce((sum, r) => sum + r.size, 0);

    res.json({
      success: true,
      recordings: recordings.map(r => ({
        startTime: r.startTime,
        endTime: r.endTime,
        size: r.size,
      })),
      totalSize,
      fileCount: recordings.length,
    });
  } catch (error) {
    console.error('Error searching recordings:', error);
    // 与 /api/channels 同款错误翻译：超时/认证失败直接告诉用户是什么问题，
    // 否则前端只会显示一段英文的 curl 报错，用户没法判断是网络还是凭据
    let errorMsg = error.message;
    if (error.message.includes('timeout') || error.code === 28) {
      errorMsg = '连接超时，请检查服务器与录像机之间的网络连通性。';
    } else if (/(^|\s)401(\s|$)/.test(error.message) || error.message.includes('digest')) {
      errorMsg = '认证失败，请检查用户名或密码。';
    }
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// 6. Cache Management Endpoints

// GET /api/cache - List cached .hikraw files
// GET /api/outputs — 已导出的成品 MP4 列表（新的在前）
app.get('/api/outputs', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const inProgress = getInProgressOutputFilenames();
    const files = listOutputFiles(downloadsDir, { limit }).map((f) => ({
      ...f,
      url: inProgress.has(f.filename) ? f.url : downloadUrl(f.url),
      // 导出进行中直写最终路径的半成品：前端显示徽标并禁用删除/重命名
      inProgress: inProgress.has(f.filename),
    }));
    res.json({ success: true, files });
  } catch (error) {
    console.error('Error listing outputs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/outputs/:filename — 删除成品 MP4
app.delete('/api/outputs/:filename', (req, res) => {
  try {
    if (outputRenames.isBusy(req.params.filename) || getInProgressOutputFilenames().has(req.params.filename) || uploadQueue.isBusy(req.params.filename) || cloud189Queue.isBusy(req.params.filename)) {
      return res.status(409).json({ success: false, error: '该文件正在导出或上传中，不能删除' });
    }
    const deleted = deleteOutputFile(downloadsDir, req.params.filename);
    if (!deleted) return res.status(404).json({ success: false, error: '文件不存在' });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PUT /api/outputs/:filename — 重命名成品 MP4（body: { newName }）
app.put('/api/outputs/:filename', (req, res) => {
  try {
    if (outputRenames.isBusy(req.params.filename) || getInProgressOutputFilenames().has(req.params.filename) || uploadQueue.isBusy(req.params.filename) || cloud189Queue.isBusy(req.params.filename)) {
      return res.status(409).json({ success: false, error: '该文件正在导出或上传中，不能重命名' });
    }
    const newName = req.body?.newName;
    if (typeof newName !== 'string' || !newName.trim()) {
      return res.status(400).json({ success: false, error: '缺少 newName' });
    }
    const renamed = renameManagedOutput(outputId(req.params.filename), newName.trim());
    if (!renamed) return res.status(404).json({ success: false, error: '文件不存在' });
    res.json({ success: true, ...renamed });
  } catch (error) {
    // 目标已存在给 409（前端可提示换名字），其余是参数错误
    const status = ['OUTPUT_EXISTS', 'OUTPUT_BUSY', 'OUTPUT_RENAME_PENDING'].includes(error.code) ? 409 : 400;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/schedules — 定时导出计划列表（含 lastRun 状态）
// 文件 data/schedules.json 本来就是接口，这里只是让 Web UI 能读——scheduler
// 每分钟重读文件，所以 Web UI 改配置也是实时生效，不用重启服务。
app.get('/api/schedules', (req, res) => {
  try {
    res.json({ success: true, schedules: getSchedules() });
  } catch (error) {
    console.error('Error listing schedules:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/schedules/:id — 更新计划字段（enabled / 时段 / runAt / channel / method / retentionDays）
app.put('/api/schedules/:id', (req, res) => {
  const fields = req.body || {};

  const CLOCK_PATTERN = /^(\d{1,2}):([0-5]\d)$/;
  const toMinutes = (v) => {
    const m = CLOCK_PATTERN.exec(String(v));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  for (const key of ['startTime', 'endTime', 'runAt']) {
    if (fields[key] === undefined) continue;
    const m = CLOCK_PATTERN.exec(String(fields[key]));
    // 格式对还不够，25:99 这种「长得像时间但不是时间」的值必须拦掉，
    // 否则 scheduler 的 isDue 会拿它做比较，计划永远不触发
    if (!m || Number(m[1]) > 23) {
      return res.status(400).json({ success: false, error: `${key} 格式应为 HH:MM（0–23:0–59）` });
    }
  }
  // 跨字段校验（只对本次请求同时提供的字段生效）：
  // 结束必须晚于开始，否则 durationSeconds ≤ 0，scheduler 每次触发都会失败；
  // 触发点不能在区间结束前——那时录像还没录完，导出必然被「结束时间晚于当前时间」拦下
  if (fields.startTime !== undefined && fields.endTime !== undefined
    && toMinutes(fields.endTime) <= toMinutes(fields.startTime)) {
    return res.status(400).json({ success: false, error: '结束时间必须晚于开始时间' });
  }
  if (fields.endTime !== undefined && fields.runAt !== undefined
    && toMinutes(fields.runAt) < toMinutes(fields.endTime)) {
    return res.status(400).json({ success: false, error: '触发时间应不早于结束时间（否则触发时录像还没录完）' });
  }
  if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled 必须是布尔值' });
  }
  if (fields.channel !== undefined && fields.channel !== null
    && !/^\d{1,8}$/.test(String(fields.channel))) {
    return res.status(400).json({ success: false, error: 'channel 格式不正确' });
  }
  if (fields.retentionDays !== undefined
    && (!Number.isInteger(fields.retentionDays) || fields.retentionDays < 1 || fields.retentionDays > 365)) {
    return res.status(400).json({ success: false, error: 'retentionDays 必须是 1–365 的整数' });
  }
  if (fields.method !== undefined && !['auto', 'rtspclip', 'mp4download'].includes(fields.method)) {
    return res.status(400).json({ success: false, error: 'method 可选 auto / rtspclip / mp4download' });
  }

  try {
    const updated = updateSchedule(req.params.id, fields);
    if (!updated) return res.status(404).json({ success: false, error: '计划不存在' });
    res.json({ success: true, schedule: updated });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/cache', (req, res) => {
  console.log('[API] Cache list request');

  try {
    const files = listDvrCache(downloadsDir).map(({ filename, relativePath, size, complete }) => {
      // Parse filename: ch{channel}_{startTime}_{endTime}.hikraw
      let channel = '';
      let startTime = '';
      let endTime = '';
      const match = filename.match(/^(?:dvr[a-f0-9]{24}_)?ch(\w+)_(\d{8}T\d{6}Z)_(\d{8}T\d{6}Z)\.hikraw$/);
      if (match) {
        channel = match[1];
        startTime = compactToIso(match[2]);
        endTime = compactToIso(match[3]);
      }

      return {
        filename,
        relativePath,
        size,
        channel,
        startTime,
        endTime,
        complete,
      };
    });

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    res.json({ success: true, files, totalSize });
  } catch (error) {
    console.error('Error listing cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/cache - Clear cached .hikraw files
app.delete('/api/cache', (req, res) => {
  try {
    const runningTask = getRunningTask();
    if (runningTask) return res.status(409).json({ success: false, error: '导出任务正在运行，等任务结束后再清理缓存。' });
    const { deletedCount, deletedSize } = cleanCompletedDvrCache(downloadsDir);
    console.log(`[API] Cache delete request: ${deletedCount} completed files`);
    res.json({
      success: true,
      deletedCount,
      deletedSize,
      message: `已删除 ${deletedCount} 个完整缓存，释放 ${Math.round(deletedSize / 1024 / 1024)} MB；未完成分片已保留`,
    });
  } catch (error) {
    console.error('Error deleting cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const httpConfig = listenerConfig();

/**
 * 挂上定时导出。计划存在 data/schedules.json，首次运行会写入一条默认计划
 * （每天 23:00 拉当晚 20:00–22:30），并把当天标记为已跑过——否则在 23:00
 * 之后才第一次启动服务的话会立刻触发一次 2.5 小时的导出。
 */
function restoreCameraJob(request) {
  const dependencies = cameraJobDependencies();
  if (request.type === 'batch') {
    const jobs = request.jobs.map(restoreCameraJob);
    return prepareMatchJob({ cameras: jobs.map(job => job.cameraId) }, { ...dependencies,
      resolveCamera: id => ({ camera: request.jobs.find(item => item.camera.id === id).camera }) }, jobs);
  }
  const localOnly = request.deviceId === undefined && request.camera?.deviceId === undefined && request.camera?.channel === undefined;
  if (request.type !== 'camera' || !request.camera || (!localOnly && !/^\d{1,8}$/.test(request.camera.channel))
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.camera.id) || request.camera.deviceId !== request.deviceId
    || (localOnly && (!request.camera.archivePath || request.endpoint !== undefined || request.forceDvr || !request.forceArchive || request.plan?.source === 'hikvision'))
    || (request.camera.archivePath !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(request.camera.archivePath))
    || (request.filename && !isOutputFilename(request.filename))
    || (request.plan && (!['mediamtx', 'hikvision'].includes(request.plan.source) || !['local', 'rtspclip', 'mp4download'].includes(request.plan.method)))) throw new Error('恢复来源记录无效。');
  const device = localOnly ? null : resolveRecoveryDevice(request, getDeviceById);
  const currentCamera = getCamera(request.camera.id);
  const currentDevice = currentCamera?.deviceId ? getDeviceById(currentCamera.deviceId) : null;
  if ((currentCamera && ((currentCamera.deviceId && !currentDevice) || cameraSourceIdentity(currentCamera, currentDevice, sourceConfigIdentity()) !== request.sourceIdentity))
    || (!currentCamera && !/^DVR-[a-f0-9]{16}-\d{1,8}$/.test(request.camera.id))) throw new Error('摄像头映射已变化，未自动恢复；请核对后重新导出。');
  return prepareCameraJob(request.operation, request.args, { ...dependencies, forceDvr: request.forceDvr, forceArchive: request.forceArchive,
    recoveryRequest: request, resolveCamera: () => ({ camera: request.camera, device }) });
}
function recoverExportTasks() {
  let records;
  try { acquireExportLease(); cleanupInterruptedDvrHttpSamples(dvrHttpSamplePrivateRoot); records = recoveryStore.load(); }
  catch (error) {
    if (error.code === 'LOCK_BUSY' && !recoveryRetry) recoveryRetry = setTimeout(() => { recoveryRetry = null; recoverExportTasks(); }, 3000);
    exportRecoveryBlocked = error.message || '无法读取导出恢复队列，请检查数据目录权限。';
    console.error('无法读取导出恢复队列；未启动自动恢复。');
    const taskId = recoveryBlockerId; activeTasks.set(taskId, { taskId, status: 'error', message: exportRecoveryBlocked }); return;
  }
  exportRecoveryBlocked = null;
  activeTasks.delete(recoveryBlockerId);
  try {
    const failures = outputRenames.recover(renameOutputMetadata);
    if (failures.length) { const taskId = crypto.randomUUID(); activeTasks.set(taskId, { taskId, status: 'error', message: failures[0] }); }
    records = recoveryStore.load();
  } catch (error) { const taskId = crypto.randomUUID(); activeTasks.set(taskId, { taskId, status: 'error', message: error.message }); }
  for (const record of records) {
    if (dvrHttpSampleControl.recoverInterrupted(record)) continue;
    const task = { ...record.task, recovered: true };
    if (record.corrupt || EXPORT_TERMINAL.has(task.status) || record.cancelRequested) {
      if (record.cancelRequested) Object.assign(task, { status: 'cancelled', message: '任务已取消' });
      activeTasks.set(task.taskId, task); continue;
    }
    try {
      let options;
      if (record.request.type === 'legacy') {
        const device = resolveRecoveryDevice(record.request, getDeviceById);
        options = { ...record.request.options, ip: device.ip, httpPort: device.httpPort, rtspPort: device.rtspPort, deviceId: device.id, user: device.username, pass: device.password };
      } else options = { [CAMERA_JOB]: restoreCameraJob(record.request) };
      const result = startExportTask({ ...options, [RECOVERED_TASK]: record });
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      Object.assign(task, { status: 'error', message: `无法自动恢复：${error.message}`, progress: 0 });
      activeTasks.set(task.taskId, task); recoveryStore.update(task);
      if (task.cameraJob) mediaJobs.save(task);
    }
  }
  startScheduler();
}

let schedulerInstance = null;
function startScheduler() {
  if (!httpConfig.schedulerEnabled) return null;
  if (schedulerInstance) return schedulerInstance;
  const scheduler = createScheduler({
    startExportTask,
    downloadsDir,
    getDevice: getActiveDevice,
    isTaskRecovering: taskId => activeTasks.has(taskId) && !EXPORT_TERMINAL.has(activeTasks.get(taskId).status),
    readSession: getSession,
  });

  try {
    const schedules = getSchedules();
    const enabled = schedules.filter((s) => s.enabled);
    if (enabled.length) {
      console.log('  定时导出:');
      for (const s of enabled) {
        const channel = s.channel ? `通道 ${s.channel}` : '通道跟随界面选择';
        console.log(`    ${s.runAt} → ${s.startTime}-${s.endTime}  ${channel}  保留 ${s.retentionDays} 天`);
      }
    } else {
      console.log('  定时导出: 无启用的计划');
    }
    console.log('');
  } catch (err) {
    console.error(`  读取定时计划失败：${err.message}`);
  }

  schedulerInstance = scheduler;
  scheduler.start();
  return scheduler;
}

/**
 * 挂上 MCP 的 HTTP 传输。给没法执行本地命令的客户端用（网页版、手机、别人的电脑）；
 * 能跑本地命令的仍然推荐 stdio（`server.js mcp`）。
 *
 * 工具处理器走的是同一个 hikclip-client，只不过 baseUrl 指回自己。多一跳环回 HTTP
 * 看着绕，但换来的是 HTTP 和 stdio 两条路共用一份代码，不会出现「网页版能用、
 * 命令行不能用」这种只在某一条路上才复现的问题。环回开销可以忽略。
 */
function mountMcpEndpoint(port) {
  const client = createHikclipClient({ baseUrl: `http://127.0.0.1:${port}` });
  const dispatcher = createHikclipDispatcher(client, {
    log: (msg) => console.log(`  [mcp-http] ${msg}`),
    oauth: Boolean(cameraOAuth),
  });
  return mountMcpHttp(app, dispatcher, '/mcp', { token: mcpToken, publicBaseUrl: configuredPublicUrl,
    verifyAccess: cameraOAuth?.verifyAccess,
    resourceMetadata: cameraOAuth ? `${configuredPublicUrl}/.well-known/oauth-protected-resource` : undefined });
}

function startServer(port, attemptsLeft) {
  const server = app.listen(port, httpConfig.host);

  server.once('listening', async () => {
    writeRuntimeFile({ port });
    console.log('');
    console.log('  H1kM3sh 已启动');
    console.log(`  ➜  本机:    http://localhost:${port}`);
    for (const addr of httpConfig.host === '0.0.0.0' ? getLanAddresses() : []) {
      console.log(`  ➜  局域网:  http://${addr}:${port}`);
    }
    console.log('');
    console.log(`  设备文件: ${getDataFilePath()}`);
    console.log(`  会话文件: ${getSessionFilePath()}`);
    console.log(`  计划文件: ${getScheduleFilePath()}`);
    console.log(`  下载目录: ${downloadsDir}`);
    console.log('');

    const mcpPath = mountMcpEndpoint(port);
    if (publicPort !== null) {
      const gateway = createPublicGateway(app, { token: mcpToken, baseUrl: configuredPublicUrl, statusPasswordHash, statusPasswordStore, statusSessionSeconds, getStatus: getDashboardStatus,
        onSessionEnd: sessionId => uploadAccounts.cancelSession(sessionId),
        oauth: cameraOAuth ? { verifyAccess: cameraOAuth.verifyAccess, paths: new Set([
          '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
          '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token',
        ]) } : undefined });
      const publicServer = gateway.listen(publicPort, process.env.HIKCLIP_PUBLIC_BIND || '127.0.0.1');
      publicServer.on('error', () => {
        console.error('公网入口启动失败，请检查端口是否占用。');
        server.close();
        process.exit(1);
      });
      console.log(`  公网受限入口: ${configuredPublicUrl}/mcp`);
    }
    console.log(`  MCP (HTTP): http://localhost:${port}${mcpPath}`);
    console.log(`  MCP (stdio): node server.js mcp`);
    console.log('');

    await mediaChannelDiscovery.refresh();
    recoverExportTasks();
    if (!exportRecoveryBlocked) startScheduler();
  });

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  端口 ${port} 已被占用，尝试 ${port + 1} ...`);
      startServer(port + 1, attemptsLeft - 1);
      return;
    }
    if (error.code === 'EADDRINUSE') {
      console.error(`启动失败：端口 ${port} 已被占用，已停止尝试。`);
    } else {
      console.error(`启动失败：${error.message}`);
    }
    process.exit(1);
  });
}

// `<入口> service <命令>` 走后台服务管理，不启服务器（便携包/SEA 也是靠这条路）
if (process.argv[2] === 'service') {
  runServiceCli(process.argv.slice(3)).then((code) => process.exit(code));
} else if (process.argv[2] === 'mcp') {
  // `<入口> mcp` 起 stdio MCP 服务，同样不启 HTTP 服务器——它是常驻服务的客户端，
  // 不是第二个服务端。stdout 归协议独占，所以这条路上不能有任何 console.log。
  runMcpServer()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`[hikclip-mcp] 启动失败：${err.message}\n`);
      process.exit(1);
    });
} else {
  registerRuntimeCleanup();
  startServer(httpConfig.port, httpConfig.attempts);
}

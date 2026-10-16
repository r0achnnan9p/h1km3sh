#!/usr/bin/env node
/** Local UI fixture only. Never imports server.js, device stores, workers or real credentials. */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fixtureConsoleSource } from './build-console-fixture.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutputThumbnails } from '../lib/output-thumbnails.js';
import { outputId } from '../lib/output-library.js';
import { statusDashboardPage } from '../lib/status-dashboard.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MEDIA = '/workspace/shared/prototype-assets/demo.mp4';
const FIXTURE_PASSWORD = 'fixture-demo';
const SYNTHETIC_COVER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const CSRF = 'fixture-csrf-not-a-real-token';
const DVR_ID = '00000000-0000-4000-8000-000000000001';
export const fixtureScenarios = ['sdk-unknown', 'normal', 'empty', 'error', 'auth', 'setup', 'recordings-empty', 'recordings-error', 'media-error', 'upload-error', 'config-error', 'config-conflict', 'preparation', 'slow', 'cloud-verify-success', 'cloud-verify-unknown', 'cloud-verify-pending', 'cloud-verify-error', 'cloud-recovery'];
const publicFiles = new Set(['precision-timeline.js', 'precision-scrub.js', 'ui-primitives.js', 'output-download.js', 'debug-mark.js', 'mediamtx-reader.js', 'mediamtx-live-player.js', 'site-v2.webmanifest', 'console-icon-v2.svg', 'console-icon-v2-192.png', 'console-icon-v2-512.png', 'apple-touch-icon-v2.png', 'console.js', 'console.css', 'touch-controls.js', 'touch-controls.css', 'output-player.js', 'playback-coverage.js', 'task-presentation.js', 'upload-accounts.js', 'console-icon.png', 'console-icon-v1.png', 'site.webmanifest', 'site-v1.webmanifest', 'fonts/jetbrains-mono.woff2']);
const dateToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const wallMs = value => Date.parse(String(value).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(value) ? '' : '+08:00'));
const success = (res, value = {}) => res.json({ success: true, ...value });
const failure = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });

function output(id, filename, minutesAgo = 0, extra = {}) {
  return { id, filename, size: 364148, modifiedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), streamUrl: `/console/api/outputs/${id}/stream`, thumbnailUrl: `/console/api/outputs/${id}/thumbnail`, busy: false, ...extra };
}
function initialState(scenario, { missingCover = false, readySettings = false, manyTasks = false } = {}) {
  const empty = scenario === 'empty', date = dateToday();
  const state = {
    scenario, configured: scenario !== 'setup', authenticated: !['auth', 'setup'].includes(scenario), revision: 1, conflictSent: false,
    dvrs: empty ? [] : [{ id: DVR_ID, name: '球场录像机 · 演示', ip: '192.0.2.10', httpPort: 80, rtspPort: 554, username: 'fixture-user', hasPassword: true }],
    cameras: empty ? [] : [
      { id: 'pitch-main', name: '主球场 · 全景', archivePath: 'pitch-main', deviceId: DVR_ID, channel: '101' },
      { id: 'pitch-east', name: '东侧球场', archivePath: 'pitch-east', deviceId: DVR_ID, channel: '201' },
      { id: 'entrance', name: '球场入口', archivePath: 'entrance' },
    ],
    playbackUrl: 'http://mediamtx.fixture.invalid:9996',
    outputs: empty ? [] : [
      output('fixture-output-1', `${date}_主球场_精彩片段.mp4`, 5),
      output('fixture-output-2', `${date}_东侧球场_完整训练.mp4`, 90, { size: 734003200 }),
      output('fixture-output-3', `${date}_场边机位_精彩进球与训练回顾_加长文件名测试.mp4`, 180, { size: 1073741824 }),
    ],
    tasks: empty ? [] : [
      { taskId: 'fixture-running', queuedAt: Date.now() - 20 * 60000, title: '主球场 · 上午训练', source: 'mediamtx', camera: '主球场', status: 'downloading', stage: 'downloading', stagePercent: 64, progressUnit: 'bytes', message: '演示任务 · 正在读取本地录像片段' },
      { taskId: 'fixture-queued', queuedAt: Date.now() - 5 * 60000, title: '东侧球场 · 精彩片段', source: 'hikvision', status: 'queued', queuePosition: 1 },
      { taskId: 'fixture-error', queuedAt: Date.now() - 15 * 60000, title: '入口录像 · 待重试', source: 'mediamtx', status: 'error', message: '演示错误：所选时间没有完整录像，请检查时间范围。' },
      { taskId: 'fixture-completed', queuedAt: Date.now() - 10 * 60000, title: '主球场 · 昨日训练', source: 'mediamtx', status: 'completed', message: '已保存到成片库。' },
    ],
    uploads: empty ? [] : [
      { id: '00000000-0000-4000-8000-000000000189', createdAt: new Date(Date.now() - 15 * 60000).toISOString(), filename: '演示_云盘结果待确认.mp4', provider: 'cloud189', status: 'unknown', uploadPhase: 'remote_started', targetPath: '/演示录像/结果核实', message: '演示：上传请求已发出，结果尚待确认；核实只检查模拟结果，不会重新上传。' },
      { id: '00000000-0000-4000-8000-000000000190', createdAt: new Date(Date.now() - 20 * 60000).toISOString(), filename: '主球场_精彩片段.mp4', provider: 'cloud189', targetPath: '/演示录像/训练', status: 'uploading', stage: 'uploading', stagePercent: 42, progressUnit: 'bytes', uploadedBytes: 440401920, totalBytes: 1048576000, message: '演示上传 · 不会传输任何数据' },
      { id: '00000000-0000-4000-8000-000000000191', createdAt: new Date(Date.now() - 5 * 60000).toISOString(), filename: '昨日_训练回顾.mp4', provider: 'bilibili', status: 'completed' },
    ],
    settings: { managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliSeasonId: 101, bilibiliSectionId: 201, cloud189TargetPath: '/H1kM3sh', bilibiliTitlePrefix: '', bilibiliExtraTags: [] },
    cover: { present: !missingCover, source: missingCover ? 'missing' : 'server' }, coverBytes: missingCover ? null : SYNTHETIC_COVER, coverType: 'image/png',
    integrations: { cloud189Enabled: true, cloud189WorkerAvailable: true, cloud189BinaryAvailable: true, cloud189AuthState: 'verified', bilibiliEnabled: readySettings && !missingCover, bilibiliWorkerAvailable: true, bilibiliBinaryAvailable: true, bilibiliCredentialsPresent: true, bilibiliCoverAvailable: !missingCover },
    cache: empty ? [] : [{ filename: 'fixture-complete.hikraw', size: 536870912, complete: true }, { filename: 'fixture-incomplete.hikraw', size: 67108864, complete: false }],
    clients: new Set(), timers: new Set(), actions: [], verificationPending: new Set(), verificationRequests: [],
  };
  if (scenario === 'cloud-recovery') {
    const file = state.outputs[0], job = state.uploads[0];
    Object.assign(job, { filename: file.filename, remoteFilename: file.filename, outputId: file.id, recoveryAvailable: true });
    Object.assign(file, { busy: true, busyReason: 'verification' });
  }
  if (manyTasks) { for (let i=0;i<125;i++) { state.tasks.push({taskId:'history-'+i,status:i%17===0?'error':'completed',title:'合成录像 '+i,camera:'D1',createdAt:Date.now()-i*3600000}); state.uploads.push({id:'upload-history-'+i,status:i%19===0?'error':'completed',provider:i%2?'cloud189':'bilibili',filename:'合成上传 '+i+'.mp4',createdAt:Date.now()-i*3600000}); } }
  Object.assign(state.tasks[0] || {}, {speed:2000000,speedUpdatedAt:Date.now(),transferredBytes:94000000});
  Object.assign(state.uploads[1] || {}, {uploadSpeed:1800000,progressUpdatedAt:Date.now()});
  if (manyTasks) {
    const pulse = () => { const job=state.tasks[0];Object.assign(job,{transferredBytes:(job.transferredBytes||0)+1000000,speed:1000000,speedUpdatedAt:Date.now(),progressUpdatedAt:Date.now()}); const upload=state.uploads[1];Object.assign(upload,{uploadedBytes:(upload.uploadedBytes||0)+1000000,uploadSpeed:1000000,progressUpdatedAt:Date.now()});emit(state);schedule(state,pulse,1000); };
    schedule(state,pulse,1000);
  }
  return state;
}
function bootstrap(state) {
  return { success: true, configRevision: `fixture-${state.revision}`, passwordManaged: false, cameras: state.cameras, dvrs: state.dvrs, outputs: state.outputs, tasks: state.tasks, uploads: state.uploads, activeTaskCount: [...state.tasks, ...state.uploads].filter(task => ['queued', 'pending', 'downloading', 'converting', 'uploading', 'stopping', 'reconciling'].includes(task.status) && !task.archivedAt).length, settings: state.settings, integrations: state.integrations, cover: state.cover };
}
function syncIntegrations(state) {
  state.integrations.bilibiliEnabled = (!state.settings.managedEnabled || state.settings.bilibiliEnabled) && state.settings.bilibiliSeasonId > 0 && state.settings.bilibiliSectionId > 0 && state.cover.present;
  state.integrations.cloud189Enabled = !state.settings.managedEnabled || state.settings.cloud189Enabled;
}
function config(state) {
  return { success: true, revision: `fixture-${state.revision}`, csrfToken: CSRF, preparationOnly: state.scenario === 'preparation', dvrs: state.dvrs, cameras: state.cameras, channels: state.cameras, mediamtx: { playbackUrl: state.playbackUrl } };
}
function emit(state) {
  const data = `event: update\ndata: ${JSON.stringify(bootstrap(state))}\n\n`;
  for (const client of state.clients) client.write(data);
}
function schedule(state, fn, delay) {
  const timer = setTimeout(() => { state.timers.delete(timer); fn(); }, delay);
  timer.unref(); state.timers.add(timer);
}
function segmentsFor(state, date) {
  if (['empty', 'recordings-empty'].includes(state.scenario)) return [];
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return [];
  return [[8 * 3600, 9 * 3600 + 20 * 60], [9 * 3600 + 24 * 60, 10 * 3600 + 50 * 60], [12 * 3600, 14 * 3600], [18 * 3600, 21 * 3600]].map(([a, b]) => ({ start: new Date(start + a * 1000).toISOString(), duration: b - a }));
}
function coverageFor(state, start, end) {
  const startMs = wallMs(start), endMs = wallMs(end), missingIntervals = []; let cursor = startMs;
  const wall = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const gap = (a, b) => missingIntervals.push({ start: wall(a), end: wall(b), startMs: a, endMs: b, durationSeconds: (b - a) / 1000 });
  for (const segment of segmentsFor(state, String(start).slice(0, 10))) {
    const a = Date.parse(segment.start), b = a + segment.duration * 1000;
    if (b <= startMs || a >= endMs) continue;
    if (a > cursor) gap(cursor, Math.min(a, endMs));
    cursor = Math.max(cursor, Math.min(b, endMs));
  }
  if (cursor < endMs) gap(cursor, endMs);
  const missingSeconds = missingIntervals.reduce((sum, gap) => sum + gap.durationSeconds, 0);
  const requestedSeconds = (endMs - startMs) / 1000, availableSeconds = requestedSeconds - missingSeconds;
  return { complete: missingSeconds === 0, hasGaps: missingSeconds > 0, hasFootage: availableSeconds > 0, missingIntervals, missingSeconds, requestedSeconds, availableSeconds };
}

/** All state is local memory; the only filesystem reads are public assets and the supplied synthetic MP4. */
export function createConsoleFixture({ mediaPath = MEDIA, taskStepMs = 1000, verificationDelayMs = 350, verificationPendingMs = 6000, scheduleExport = schedule } = {}) {
  const app = express(), sessions = new Map();
  const thumbnails = createOutputThumbnails({ root: path.dirname(path.resolve(mediaPath)) });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Console-Fixture': 'synthetic-in-memory-only', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    const origin = req.get('origin');
    if (!['GET', 'HEAD'].includes(req.method) && origin) {
      let sameHost = false;
      try { const source = new URL(origin); sameHost = ['http:', 'https:'].includes(source.protocol) && source.host === req.get('host'); } catch { /* Reject malformed origins. */ }
      // Host matching also works behind a separately authorized HTTPS reverse proxy.
      if (!sameHost) return failure(res, 403, 'Fixture accepts same-origin requests only.');
    }
    next();
  });
  app.use('/console/api/settings/bilibili-cover', express.raw({ type: ['image/png', 'image/jpeg'], limit: '5mb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    const cookie = /(?:^|;\s*)console_fixture=([a-f0-9-]+)/.exec(req.get('cookie') || '')?.[1];
    let id = cookie;
    if (!sessions.has(id) || (req.path === '/' && Object.hasOwn(req.query, 'fixture'))) {
      const scenario = fixtureScenarios.includes(req.query.fixture) ? req.query.fixture : 'normal';
      id = randomUUID(); sessions.set(id, initialState(scenario, { missingCover: req.query.cover === 'missing', manyTasks: req.query.tasks === 'many', readySettings: req.query.settings === 'ready' }));
      res.cookie('console_fixture', id, { httpOnly: true, sameSite: 'strict' });
    }
    req.fixture = sessions.get(id); next();
  });
  app.get('/', (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const safe = req.query.safeArea === 'iphone' ? ':root { --safe-top:59px; --safe-bottom:34px; }' : req.query.safeArea === 'landscape' ? ':root { --safe-top:0px; --safe-bottom:21px; --safe-left:59px; --safe-right:59px; }' : '';
    const qa=req.query.anchorqa==='1' ? '<div style="position:fixed;top:0;right:0;z-index:9999;background:#162536"><button data-anchor-action="insert" style="min-height:44px">合成插头</button><button data-anchor-action="complete" style="min-height:44px">合成完成</button><button data-anchor-action="delete" style="min-height:44px">合成删除</button></div><script src="/fixture-anchor.js"></script>' : '';
    res.type('html').send(statusDashboardPage().replace('</head>', '<style>' + safe + '</style></head>').replace('</body>',qa+'</body>'));
  });
  // Explicit synthetic telemetry control; no workers, filesystem writes or device calls.
  app.get('/fixture-anchor.js', (req,res)=>res.type('application/javascript').send("document.querySelectorAll('[data-anchor-action]').forEach(button=>button.addEventListener('click',()=>fetch('/__fixture__/anchor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.anchorAction})}).then(r=>r.json()).then(r=>button.title=JSON.stringify(r))));"));
  app.post('/__fixture__/anchor', (req,res) => {
    const state=req.fixture; state.actions.push({qa:req.body.action});
    if(req.body.action==='insert') state.tasks.unshift({taskId:'anchor-new',title:'锚点新增任务',status:'queued',createdAt:Date.now()});
    if(req.body.action==='complete') Object.assign(state.tasks.find(t=>t.taskId==='fixture-running') || state.tasks.find(t=>t.status==='downloading') || {},{status:'completed',message:''});
    if(req.body.action==='delete') state.tasks=state.tasks.filter(t=>t.taskId!=='anchor-new');
    emit(state);success(res);
  });
  app.post('/__fixture__/tick', (req, res) => {
    const job = req.fixture.tasks[0]; if (job) Object.assign(job,{transferredBytes:(job.transferredBytes||0)+1000000,speed:1000000,speedUpdatedAt:Date.now(),progressUpdatedAt:Date.now()});
    const upload=req.fixture.uploads[1];if(upload)Object.assign(upload,{uploadedBytes:(upload.uploadedBytes||0)+1000000,uploadSpeed:1000000,progressUpdatedAt:Date.now()});
    emit(req.fixture); success(res);
  });
  app.get('/__fixture__/info', (req, res) => success(res, { synthetic: true, scenario: req.fixture.scenario, scenarios: fixtureScenarios, loginPassword: FIXTURE_PASSWORD, setupCode: 'demo', mutations: req.fixture.actions, verification: { requests: req.fixture.verificationRequests, pendingIds: [...req.fixture.verificationPending] }, mediaAvailable: existsSync(mediaPath) }));
  app.use((req, res, next) => {
    const name = req.path.slice(1);
    if (['GET', 'HEAD'].includes(req.method) && name === 'console.js') return res.type('application/javascript').send(fixtureConsoleSource(readFileSync(path.join(ROOT, 'public/console.js'), 'utf8')));
    if (['GET', 'HEAD'].includes(req.method) && publicFiles.has(name)) return res.sendFile(path.join(ROOT, 'public', name), { dotfiles: 'allow' });
    next();
  });
  app.get('/console/api/auth', (req, res) => success(res, { configured: req.fixture.configured }));
  app.post('/status/login', (req, res) => {
    if (req.body?.password !== FIXTURE_PASSWORD) return failure(res, 401, '演示密码为 fixture-demo，请勿输入真实密码。');
    req.fixture.authenticated = true; success(res);
  });
  app.post('/status/logout', (req, res) => { req.fixture.authenticated = false; for (const client of req.fixture.clients) client.end(); success(res); });
  app.post('/console/api/setup', (req, res) => {
    if (req.body?.code !== 'demo' || req.body?.password !== FIXTURE_PASSWORD) return failure(res, 400, '演示初始化码为 demo，密码为 fixture-demo。');
    req.fixture.configured = true; success(res);
  });
  app.use('/console/api', (req, res, next) => req.fixture.authenticated ? next() : failure(res, 401, '演示登录已过期，请使用 fixture-demo 登录。'));
  app.use('/console/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) req.fixture.actions.push({ method: req.method, path: req.originalUrl, at: new Date().toISOString() });
    next();
  });
  app.get('/console/api/bootstrap', (req, res) => {
    if (req.fixture.scenario === 'error') return failure(res, 503, '演示：暂时无法连接录像服务，请稍后重试。');
    if (req.fixture.scenario === 'slow') return schedule(req.fixture, () => res.json(bootstrap(req.fixture)), 2500);
    res.json(bootstrap(req.fixture));
  });
  app.get('/console/api/tasks', (req, res) => success(res, { tasks: req.fixture.tasks, uploads: req.fixture.uploads, activeTaskCount: [...req.fixture.tasks, ...req.fixture.uploads].filter(task => ['queued', 'pending', 'downloading', 'converting', 'uploading', 'stopping', 'reconciling'].includes(task.status) && !task.archivedAt).length }));
  app.post('/console/api/uploads/cloud189/:id/verify', (req, res) => {
    const state = req.fixture;
    if (state.scenario === 'preparation') return failure(res, 409, '当前尚不能核实上传结果。');
    if (req.get('x-csrf-token') !== CSRF) return failure(res, 403, '请刷新设置后重试。');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(req.params.id) || !req.body || Array.isArray(req.body) || Object.keys(req.body).length) return failure(res, 400, '核实请求无效。');
    const job = state.uploads.find(item => item.id === req.params.id);
    if (!job || job.provider !== 'cloud189' || job.status !== 'unknown' || job.uploadPhase !== 'remote_started' || job.archivedAt) return failure(res, 409, '任务状态已改变，请刷新任务列表。');
    if (state.verificationPending.has(job.id)) return success(res, { verified: false, code: 'VERIFY_BUSY', message: '账号正在处理其他操作，请稍后核实。' });
    state.verificationPending.add(job.id); state.verificationRequests.push({ id: job.id, mode: state.scenario });
    // Only the response is delayed. No worker, account, source file or upload is used.
    schedule(state, () => {
      state.verificationPending.delete(job.id);
      if (!state.authenticated) return failure(res, 401, '登录已退出，请重新登录。');
      if (state.scenario === 'cloud-verify-error') return failure(res, 503, '演示：核实服务暂时不可用；原任务仍待确认，没有重新上传。', { code: 'VERIFY_UNAVAILABLE' });
      if (['cloud-verify-unknown', 'cloud-recovery'].includes(state.scenario)) return success(res, { verified: false, code: 'CLOUD_FILE_NOT_FOUND', message: '云盘尚未找到这个文件；原任务仍待确认，没有重新上传。' });
      Object.assign(job, { status: 'completed', message: '已核实云盘文件、大小与校验值，没有重新上传。' });
      emit(state);
      success(res, { verified: true, code: 'CLOUD_REMOTE_VERIFIED', message: job.message });
    }, state.scenario === 'cloud-verify-pending' ? verificationPendingMs : verificationDelayMs);
  });

  app.post('/console/api/uploads/cloud189/:id/:action', (req, res) => {
    const state = req.fixture, action = req.params.action;
    if (!['retry', 'archive', 'restore'].includes(action)) return failure(res, 404, '演示操作不存在。');
    if (state.scenario === 'preparation') return failure(res, 409, '当前尚不能恢复上传记录。');
    if (req.get('x-csrf-token') !== CSRF) return failure(res, 403, '请刷新设置后重试。');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(req.params.id)
        || !req.body || Array.isArray(req.body) || (action === 'retry' ? req.body.confirmRetry !== true || Object.keys(req.body).some(key => key !== 'confirmRetry') : Object.keys(req.body).length))
      return failure(res, 400, '恢复请求无效。');
    const job = state.uploads.find(item => item.id === req.params.id), file = state.outputs.find(item => item.id === job?.outputId);
    if (!job || job.status !== 'unknown' || job.uploadPhase !== 'remote_started' || (action === 'retry' && job.archivedAt)) return failure(res, 409, '任务状态已改变。');
    if (state.verificationPending.has(job.id)) return success(res, { applied: false, code: 'VERIFY_BUSY', message: '正在处理，请稍后。' });
    state.verificationPending.add(job.id); state.verificationRequests.push({ id: job.id, mode: state.scenario, action });
    schedule(state, () => {
      state.verificationPending.delete(job.id);
      if (!state.authenticated) return failure(res, 401, '登录已退出，请重新登录。');
      if (state.scenario === 'cloud-verify-error') return failure(res, 503, '演示恢复服务暂时不可用。');
      const code = { archive: 'CLOUD_RECORD_ARCHIVED', restore: 'CLOUD_RECORD_RESTORED', retry: 'CLOUD_RETRY_QUEUED' }[action];
      if (action === 'archive') { job.archivedAt = new Date().toISOString(); if (file) Object.assign(file, { busy: false, busyReason: null }); }
      if (action === 'restore') { delete job.archivedAt; if (file) Object.assign(file, { busy: true, busyReason: 'verification' }); }
      if (action === 'retry') {
        job.attemptHistory = [...(job.attemptHistory || []), { status: 'unknown', uploadPhase: 'remote_started' }];
        Object.assign(job, { status: 'queued', uploadPhase: 'preflight', retryCount: job.attemptHistory.length, retryRequestedAt: new Date().toISOString(), message: '演示：已确认原目标目前无文件，已重新排队；原结果保留。' });
        if (file) Object.assign(file, { busy: true, busyReason: 'upload' });
      }
      emit(state); success(res, { applied: true, code, message: action === 'archive' ? '演示：已归档记录，成片可改名。' : action === 'restore' ? '演示：已恢复记录。' : job.message });
    }, state.scenario === 'cloud-verify-pending' ? verificationPendingMs : verificationDelayMs);
  });

  app.get('/console/api/events', (req, res) => {
    const state = req.fixture;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    state.clients.add(res); res.write(`event: update\ndata: ${JSON.stringify(bootstrap(state))}\n\n`);
    const timer = setInterval(() => res.write(': fixture keepalive\n\n'), 15000); timer.unref();
    req.on('close', () => { clearInterval(timer); state.clients.delete(res); });
  });
  app.get(['/console/api/playback/:camera/segments', '/console/api/dvrs/:id/segments'], (req, res) => {
    if (req.fixture.scenario === 'recordings-error') return failure(res, 503, '演示：录像列表读取失败，请重试。');
    success(res, { camera: req.params.camera, date: req.query.date, segments: segmentsFor(req.fixture, req.query.date || dateToday()) });
  });
  app.get('/console/api/dvr-sdk-preview/:id/media.mp4',(req,res)=>res.type('video/mp4').sendFile(path.resolve(mediaPath), { dotfiles: 'allow' }));
  const stream = (req, res) => {
    if (req.query.format === 'sdk') return success(res,{mediaUrl:'/console/api/dvr-sdk-preview/00000000-0000-4000-8000-000000000002/media.mp4',actualDurationSeconds:12});
    if (req.fixture.scenario === 'slow') return schedule(req.fixture,()=>res.type('video/mp4').sendFile(path.resolve(mediaPath), { dotfiles: 'allow' }),8000);
    if (req.fixture.scenario === 'media-error') return failure(res, 503, '演示：视频暂时无法播放。');
    if (req.params.id && req.path.includes('/outputs/') && !req.fixture.outputs.some(item => item.id === req.params.id)) return failure(res, 404, '演示成片不存在。');
    if (!existsSync(mediaPath)) return failure(res, 503, 'Synthetic MP4 missing; set CONSOLE_FIXTURE_MEDIA to a synthetic file.');
    if (req.query.download === '1') res.attachment(req.fixture.outputs.find(item => item.id === req.params.id)?.filename || 'synthetic.mp4');
    res.type('video/mp4').sendFile(path.resolve(mediaPath), { dotfiles: 'allow' });
  };
  app.get(['/console/api/playback/:camera/stream', '/console/api/dvrs/:id/stream', '/console/api/dvrs/:id/live', '/console/api/outputs/:id/stream'], stream);
  app.get('/console/api/outputs/:id/thumbnail', async (req, res) => {
    if (!req.fixture.outputs.some(item => item.id === req.params.id)) return res.status(404).end();
    if (req.fixture.scenario === 'media-error') return res.status(503).end();
    try { res.type('image/jpeg').send(await thumbnails.get(outputId(path.basename(mediaPath)))); }
    catch (error) { res.status(error.status || 500).end(); }
  });
  app.get('/console/api/outputs', (req, res) => success(res, { outputs: req.fixture.outputs }));
  const findOutput = (req, res, next) => { req.output = req.fixture.outputs.find(item => item.id === req.params.id); if (!req.output) return failure(res, 404, '成片不存在。'); if (req.output.busy && !(req.params.provider === 'bilibili' && req.output.busyReason === 'verification')) return failure(res, 409, '成片正在处理或上传中。'); next(); };
  app.put('/console/api/outputs/:id', findOutput, (req, res) => {
    const name = String(req.body?.newName || '').trim();
    if (!name || /[\\/\x00-\x1f]/.test(name) || !/\.mp4$/i.test(name)) return failure(res, 400, '请填写有效的 MP4 文件名。');
    if (req.fixture.outputs.some(item => item !== req.output && item.filename === name)) return failure(res, 409, '已有同名成片。');
    req.fixture.uploads.filter(job => job.outputId === req.output.id && job.archivedAt).forEach(job => { job.filename = name; });
    req.output.filename = name; success(res, { filename: name }); emit(req.fixture);
  });
  app.delete('/console/api/outputs/:id', findOutput, (req, res) => { req.fixture.outputs = req.fixture.outputs.filter(item => item !== req.output); success(res); emit(req.fixture); });
  app.post('/console/api/outputs/:id/recover-rename', findOutput, (req, res) => { req.output.renamePending = false; success(res, { outputs: req.fixture.outputs }); });
  app.post('/console/api/outputs/:id/upload/:provider', findOutput, (req, res) => {
    if (!['bilibili', 'cloud189'].includes(req.params.provider)) return failure(res, 400, '未知的演示上传目标。');
    if (req.fixture.scenario === 'upload-error') return failure(res, 503, '演示：上传服务不可用，成片已保留。');
    if (req.fixture.settings.managedEnabled && !req.fixture.settings[`${req.params.provider}Enabled`]) return failure(res, 409, '请先启用此上传目标。');
    if (req.params.provider === 'bilibili' && !(req.fixture.settings.bilibiliSeasonId > 0 && req.fixture.settings.bilibiliSectionId > 0)) return failure(res, 409, '请填写正整数合集和章节 ID；演示不会验证 ID 所有权。');
    if (req.params.provider === 'bilibili' && !req.fixture.cover.present) return failure(res, 409, '请先设置 B 站封面。');
    const state = req.fixture, item = req.output;
    if (req.params.provider === 'cloud189' && state.uploads.some(existing => existing.provider === 'cloud189' && existing.status === 'unknown' && existing.outputId === item.id)) return failure(res, 409, '这份成片仍有待核实记录，请在任务页核实或重试。');
    const job = { id: randomUUID(), createdAt: new Date().toISOString(), filename: item.filename, provider: req.params.provider, status: 'queued', targetPath: state.settings.cloud189TargetPath };
    item.busy = true; state.uploads.unshift(job); res.status(202); success(res, { job }); emit(state);
    [25, 65, 100].forEach((percent, index) => schedule(state, () => {
      Object.assign(job, { status: percent === 100 ? 'completed' : 'uploading', stage: 'uploading', stagePercent: percent, progressUnit: 'bytes', uploadedBytes: Math.round(item.size * percent / 100), totalBytes: item.size, progressUpdatedAt: Date.now() });
      if (percent === 100) item.busy = false;
      emit(state);
    }, (index + 1) * taskStepMs));
  });
  app.post('/console/api/export', (req, res) => {
    const state = req.fixture, input = req.body || {}, start = wallMs(input.start || ''), end = wallMs(input.end || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return failure(res, 400, '结束时间必须晚于开始时间。');
    const coverage = coverageFor(state, input.start, input.end);
    if (input.source === 'mediamtx' && !coverage.availableSeconds) return failure(res, 409, '所选时间没有可导出的录像。', { code: 'MEDIAMTX_EMPTY', coverage });
    if (input.source === 'mediamtx' && coverage.missingSeconds > 0 && !input.acceptGaps) return failure(res, 409, '本地录像不完整。', { code: 'MEDIAMTX_GAPS', coverage });
    const task = { taskId: randomUUID(), queuedAt: Date.now(), title: `${input.camera || 'DVR'} · ${String(input.start).slice(11)}–${String(input.end).slice(11)}`, source: input.source, camera: input.camera || input.channel, start: input.start, end: input.end, status: 'queued', queuePosition: 1, message: '演示任务 · 仅模拟导出，不访问录像设备' };
    state.tasks.unshift(task); res.status(202); success(res, { taskId: task.taskId, status: task.status, queuePosition: 1 }); emit(state);
    [20, 65, 100].forEach((percent, index) => scheduleExport(state, () => {
      if (task.status === 'cancelled') return;
      Object.assign(task, { status: percent === 100 ? 'completed' : 'downloading', stage: 'downloading', stagePercent: percent, progressUnit: 'bytes' });
      if (percent === 100) { task.message = '演示导出已完成，已加入成片库。'; state.outputs.unshift(output(`fixture-${task.taskId}`, `${String(input.start).slice(0, 10)}_${input.camera || 'DVR'}_演示导出${coverage.missingSeconds ? '_含缺口' : ''}.mp4`)); }
      emit(state);
    }, (index + 1) * taskStepMs));
  });
  app.post('/console/api/export/stop', (req, res) => {
    const task = req.fixture.tasks.find(item => item.taskId === req.body?.taskId);
    if (!task) return failure(res, 404, '任务不存在。'); task.status = 'cancelled'; task.message = '已取消演示任务。'; success(res); emit(req.fixture);
  });
  app.get('/console/api/settings', (req, res) => success(res, { csrfToken: CSRF, settings: req.fixture.settings, integrations: req.fixture.integrations, cover: req.fixture.cover }));
  app.get('/console/api/settings/bilibili-cover', (req, res) => req.fixture.coverBytes ? res.type(req.fixture.coverType).send(req.fixture.coverBytes) : failure(res, 404, '演示封面尚未设置。'));
  app.put('/console/api/settings/bilibili-cover', (req, res) => {
    if (req.get('x-csrf-token') !== CSRF) return failure(res, 403, '请刷新设置后重试。');
    const type = req.get('content-type')?.split(';')[0], bytes = req.body;
    if (!['image/png', 'image/jpeg'].includes(type) || !Buffer.isBuffer(bytes)) return failure(res, 400, '封面只支持 PNG/JPEG。');
    const valid = type === 'image/png' ? [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid) return failure(res, 400, '图片格式与内容不匹配。');
    req.fixture.coverBytes = Buffer.from(bytes); req.fixture.coverType = type; req.fixture.cover = { present: true, source: 'managed' }; req.fixture.integrations.bilibiliCoverAvailable = true; syncIntegrations(req.fixture);
    success(res, { settings: req.fixture.settings, integrations: req.fixture.integrations, csrfToken: CSRF, cover: req.fixture.cover });
  });
  const accounts = ['bilibili', 'cloud189'].map(provider => ({ provider, state: 'unavailable', available: false, attempt: null, errorCode: 'SYNTHETIC_FIXTURE_NO_LOGIN' }));
  app.get('/console/api/upload-accounts', (req, res) => success(res, { accounts, csrfToken: CSRF }));
  app.all('/console/api/upload-accounts/:provider/:action', (req, res) => {
    const account = accounts.find(item => item.provider === req.params.provider);
    if (!account || !['start', 'status', 'qr', 'cancel', 'verify'].includes(req.params.action)) return failure(res, 404, '未知演示账号请求。');
    success(res, { account, message: '演示环境不提供真实二维码或账号登录。' });
  });
  app.put('/console/api/settings', (req, res) => {
    if (req.get('x-csrf-token') !== CSRF) return failure(res, 403, '安全校验失败，请重新加载设置。');
    for (const key of ['managedEnabled', 'bilibiliEnabled', 'cloud189Enabled']) if (Object.hasOwn(req.body, key) && typeof req.body[key] !== 'boolean') return failure(res, 400, '启用状态必须为布尔值。');
    for (const key of ['bilibiliSeasonId', 'bilibiliSectionId']) if (Object.hasOwn(req.body, key) && (!Number.isSafeInteger(req.body[key]) || req.body[key] < 0)) return failure(res, 400, '合集与章节 ID 必须为非负整数。');
    for (const [key, value] of Object.entries(req.body)) if (!Object.hasOwn(req.fixture.settings, key) || JSON.stringify(value) !== JSON.stringify(req.fixture.settings[key])) return failure(res, 400, '上传配置固定，请刷新页面。');
    syncIntegrations(req.fixture);
    success(res, { csrfToken: CSRF, settings: req.fixture.settings, integrations: req.fixture.integrations, cover: req.fixture.cover }); emit(req.fixture);
  });
  app.post('/console/api/password', (req, res) => {
    if (req.body?.oldPassword !== FIXTURE_PASSWORD || req.body?.password !== FIXTURE_PASSWORD) return failure(res, 400, '仅使用演示密码 fixture-demo；演示服务不保存密码。');
    req.fixture.authenticated = false; success(res);
  });
  app.get('/console/api/cache', (req, res) => success(res, { files: req.fixture.cache }));
  app.delete('/console/api/cache', (req, res) => {
    const complete = req.fixture.cache.filter(item => item.complete); req.fixture.cache = req.fixture.cache.filter(item => !item.complete);
    success(res, { deletedCount: complete.length, deletedSize: complete.reduce((sum, item) => sum + item.size, 0) });
  });
  app.get('/console/api/config', (req, res) => req.fixture.scenario === 'config-error' ? failure(res, 503, '演示：暂时无法读取配置，请稍后重试。') : res.json(config(req.fixture)));
  const channels = [{ id: '101', name: '主球场 · 全景' }, { id: '201', name: '东侧球场' }, { id: '301', name: '球场入口' }];
  app.get('/console/api/dvrs/:id/channels', (req, res) => success(res, { channels, playbackTransport: req.fixture.scenario === 'sdk-unknown' ? 'hcnetsdk' : undefined }));
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !/^\/console\/api\/(dvrs|cameras|mediamtx)(\/|$)/.test(req.path)) return next();
    const state = req.fixture;
    if (state.scenario === 'preparation') return failure(res, 409, '演示准备模式为只读。');
    if (req.get('x-csrf-token') !== CSRF) return failure(res, 403, '安全校验失败，请重新加载配置。');
    if (state.scenario === 'config-conflict' && !state.conflictSent) { state.conflictSent = true; state.revision++; }
    if (req.body?.revision !== `fixture-${state.revision}`) return failure(res, 409, '配置已改变，请重新加载后再保存。');
    next();
  });
  const saveConfig = (req, res) => { req.fixture.revision++; res.json(config(req.fixture)); };
  app.post('/console/api/dvrs', (req, res) => {
    const input = req.body; if (!input.name || !input.ip || !input.username || !input.password) return failure(res, 400, '请填写演示录像机信息。');
    req.fixture.dvrs.push({ id: randomUUID(), name: input.name, ip: input.ip, username: input.username, httpPort: input.httpPort || 80, rtspPort: input.rtspPort || 554, hasPassword: true }); saveConfig(req, res);
  });
  app.patch('/console/api/dvrs/:id', (req, res) => {
    const dvr = req.fixture.dvrs.find(item => item.id === req.params.id); if (!dvr) return failure(res, 404, '录像机不存在。');
    for (const key of ['name', 'ip', 'username', 'httpPort', 'rtspPort']) if (Object.hasOwn(req.body, key)) dvr[key] = req.body[key]; saveConfig(req, res);
  });
  app.delete('/console/api/dvrs/:id', (req, res) => {
    if (req.fixture.cameras.some(item => item.deviceId === req.params.id)) return failure(res, 409, '请先移除此录像机的摄像头映射。');
    req.fixture.dvrs = req.fixture.dvrs.filter(item => item.id !== req.params.id); saveConfig(req, res);
  });
  app.post('/console/api/dvrs/:id/test', (req, res) => success(res, { channels }));
  app.post('/console/api/dvrs/:id/snapshot', (req, res) => success(res, { imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }));
  app.put('/console/api/cameras', (req, res) => { if (!Array.isArray(req.body?.cameras)) return failure(res, 400, '摄像头列表无效。'); req.fixture.cameras = req.body.cameras.map(({ id, name, archivePath, deviceId, channel }) => ({ id, name, archivePath, deviceId, channel })); saveConfig(req, res); });
  app.put('/console/api/mediamtx', (req, res) => {
    let parsed; try { parsed = new URL(req.body?.playbackUrl); } catch { return failure(res, 400, 'Playback URL 无效。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return failure(res, 400, '请填写不含凭据的 HTTP(S) 地址。');
    req.fixture.playbackUrl = parsed.origin; saveConfig(req, res);
  });
  app.use((req, res) => failure(res, 404, 'Unknown fixture route; no production fallback is configured.'));
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); failure(res, error?.type === 'entity.too.large' ? 413 : 400, 'Invalid fixture request.'); });
  return { app, close() { for (const state of sessions.values()) { for (const timer of state.timers) clearTimeout(timer); for (const client of state.clients) client.end(); } sessions.clear(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CONSOLE_FIXTURE_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CONSOLE_FIXTURE_PORT must be an integer from 1 to 65535.');
  const fixture = createConsoleFixture({ mediaPath: process.env.CONSOLE_FIXTURE_MEDIA || MEDIA });
  const server = fixture.app.listen(port, '127.0.0.1', () => console.log(`Synthetic console fixture: http://127.0.0.1:${port}/?fixture=normal\nFake password: fixture-demo. Setup code: demo. No production operations; all mutations are memory-only.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { fixture.close(); server.close(); });
}

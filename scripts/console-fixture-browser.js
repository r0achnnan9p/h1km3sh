/* Synthetic browser-only QA runtime. Included only by build-console-fixture.js. */
(() => {
  'use strict';
  const scriptUrl = document.currentScript.src;
  const mediaUrl = new URL('./demo.mp4', scriptUrl).href;
  const thumbnailUrl = new URL('./demo-poster.jpg', scriptUrl).href;
  const modes = ['normal', 'empty', 'error', 'auth', 'setup', 'recordings-empty', 'recordings-error', 'media-error', 'upload-error', 'config-error', 'config-conflict', 'preparation', 'slow', 'cloud-verify-success', 'cloud-verify-unknown', 'cloud-verify-pending', 'cloud-verify-error', 'cloud-recovery'];
  const fixtureQuery = new URLSearchParams(location.search);
  const requested = fixtureQuery.get('fixture');
  const accountMode = fixtureQuery.get('accounts');
  const demoAccounts = ['demo', 'reauth', 'unauthorized', 'read-error'].includes(accountMode);
  const demoQrSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="350" viewBox="0 0 320 350"><rect width="320" height="350" rx="12" fill="white"/><defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><rect x="2" y="2" width="12" height="12" fill="#64748b"/><rect x="16" y="17" width="6" height="6" fill="#64748b"/></pattern></defs><rect x="40" y="28" width="240" height="240" fill="url(#dots)"/><rect x="78" y="101" width="164" height="87" rx="8" fill="white" stroke="#f59e0b" stroke-width="3"/><text x="160" y="135" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#92400e">DEMO ONLY</text><text x="160" y="164" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#92400e">NOT A LOGIN CODE</text><text x="160" y="300" text-anchor="middle" font-family="sans-serif" font-size="19" fill="#92400e">演示二维码，不可登录</text><text x="160" y="328" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#64748b">使用页面顶部演示控件切换状态</text></svg>';
  const demoQrUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demoQrSvg)}`;
  const readySettings = fixtureQuery.get('settings') === 'ready';
  let coverBlob = fixtureQuery.get('cover') === 'missing' ? null : new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0))], { type: 'image/png' });
  let coverObjectUrl = coverBlob ? URL.createObjectURL(coverBlob) : '';
  const mode = modes.includes(requested) ? requested : 'normal';
  const empty = mode === 'empty', csrf = 'synthetic-browser-fixture', dvrId = '00000000-0000-4000-8000-000000000001';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const id = () => crypto.randomUUID();
  const makeOutput = (key, name, extra = {}) => ({ id: key, filename: name, size: 355328, durationSeconds: 612.4, modifiedAt: new Date().toISOString(), streamUrl: `/console/api/outputs/${key}/stream`, thumbnailUrl: `/console/api/outputs/${key}/thumbnail`, busy: false, ...extra });
  const state = {
    authenticated: !['auth', 'setup'].includes(mode), configured: mode !== 'setup', revision: 1, conflictSent: false,
    cameras: empty ? [] : [{ id: 'pitch-main', name: '主球场 · 全景', archivePath: 'pitch-main', deviceId: dvrId, channel: '101' }, { id: 'pitch-east', name: '东侧球场', archivePath: 'pitch-east', deviceId: dvrId, channel: '201' }, { id: 'entrance', name: '球场入口', archivePath: 'entrance' }],
    dvrs: empty ? [] : [{ id: dvrId, name: '球场录像机 · 演示', ip: '192.0.2.10', httpPort: 80, rtspPort: 554, username: 'fixture-user', hasPassword: true }],
    outputs: empty ? [] : [makeOutput('demo-output-1', `${today}_主球场_精彩片段.mp4`), makeOutput('demo-output-2', `${today}_东侧球场_完整训练.mp4`, { size: 734003200, durationSeconds: 4325.8, modifiedAt: new Date(Date.now() - 3600000).toISOString() }), makeOutput('demo-output-3', `${today}_场边机位_精彩进球与训练回顾_加长文件名测试.mp4`, { size: 1073741824, durationSeconds: 58, modifiedAt: new Date(Date.now() - 86400000).toISOString() })],
    tasks: empty ? [] : [{ taskId: 'demo-running', queuedAt: Date.now() - 20 * 60000, title: '主球场 · 上午训练', source: 'mediamtx', status: 'downloading', stage: 'downloading', stagePercent: 64, progressUnit: 'bytes', message: '演示任务 · 正在读取本地录像片段' }, { taskId: 'demo-queued', queuedAt: Date.now() - 5 * 60000, title: '东侧球场 · 精彩片段', source: 'hikvision', status: 'queued', queuePosition: 1 }, { taskId: 'demo-error', queuedAt: Date.now() - 15 * 60000, title: '入口录像 · 待重试', status: 'error', source: 'mediamtx', message: '演示错误：所选时间没有完整录像，请检查时间范围。' }, { taskId: 'demo-complete', queuedAt: Date.now() - 10 * 60000, title: '昨日训练 · 完整回顾', source: 'mediamtx', status: 'completed', message: '已保存到成片库。' }],
    uploads: empty ? [] : [{ id: '00000000-0000-4000-8000-000000000189', createdAt: new Date(Date.now() - 15 * 60000).toISOString(), filename: '演示_云盘结果待确认.mp4', provider: 'cloud189', status: 'unknown', uploadPhase: 'remote_started', targetPath: '/演示录像/结果核实', message: '演示：上传请求已发出，结果尚待确认；核实只检查模拟结果，不会重新上传。' }, { id: '00000000-0000-4000-8000-000000000190', createdAt: new Date(Date.now() - 20 * 60000).toISOString(), filename: '主球场_精彩片段.mp4', provider: 'cloud189', status: 'uploading', stage: 'uploading', stagePercent: 42, progressUnit: 'bytes', uploadedBytes: 440401920, totalBytes: 1048576000, targetPath: '/演示录像/训练', message: '演示上传 · 不会传输数据' }, { id: '00000000-0000-4000-8000-000000000191', createdAt: new Date(Date.now() - 5 * 60000).toISOString(), filename: '昨日训练回顾.mp4', provider: 'bilibili', status: 'completed' }],
    settings: { managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliSeasonId: 101, bilibiliSectionId: 201, cloud189TargetPath: '/H1kM3sh', bilibiliTitlePrefix: '', bilibiliExtraTags: [] },
    cover: { present: Boolean(coverBlob), source: coverBlob ? 'server' : 'missing' },
    integrations: { cloud189Enabled: true, cloud189WorkerAvailable: true, cloud189BinaryAvailable: true, cloud189AuthState: 'verified', bilibiliEnabled: readySettings && Boolean(coverBlob), bilibiliWorkerAvailable: true, bilibiliBinaryAvailable: true, bilibiliCredentialsPresent: true, bilibiliCoverAvailable: Boolean(coverBlob) },
    accounts: ['bilibili', 'cloud189'].map(provider => ({ provider, state: demoAccounts ? 'disconnected' : 'unavailable', available: demoAccounts, credentialsPresent: accountMode === 'reauth', attempt: null, errorCode: demoAccounts ? null : 'SYNTHETIC_FIXTURE_NO_LOGIN', message: '演示二维码，不可登录。' })),
    cache: empty ? [] : [{ filename: 'demo-complete.hikraw', complete: true, size: 536870912 }, { filename: 'demo-partial.hikraw', complete: false, size: 67108864 }],
    playbackUrl: 'http://mediamtx.fixture.invalid:9996',
  };
  if (mode === 'cloud-recovery') {
    const file = state.outputs[0], job = state.uploads[0];
    Object.assign(job, { filename: file.filename, remoteFilename: file.filename, outputId: file.id, recoveryAvailable: true });
    Object.assign(file, { busy: true, busyReason: 'verification' });
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const syncIntegrations = () => {
    state.integrations.bilibiliEnabled = (!state.settings.managedEnabled || state.settings.bilibiliEnabled) && state.settings.bilibiliSeasonId > 0 && state.settings.bilibiliSectionId > 0 && state.cover.present;
    state.integrations.cloud189Enabled = !state.settings.managedEnabled || state.settings.cloud189Enabled;
  };
  const verificationPending = new Set();
  const verificationRequests = [];
  const clients = new Set();
  if (fixtureQuery.get('tasks') === 'many') { for (let i=0;i<125;i++) { state.tasks.push({taskId:'history-'+i, status:i%17===0?'error':'completed', title:'合成录像 '+i, camera:'D1', createdAt:Date.now()-i*3600000}); state.uploads.push({id:'upload-history-'+i, status:i%19===0?'error':'completed', provider:i%2?'cloud189':'bilibili', filename:'合成上传 '+i+'.mp4', createdAt:Date.now()-i*3600000}); } }
  const bootstrap = () => ({ success: true, configRevision: `fixture-${state.revision}`, passwordManaged: false, cameras: state.cameras, dvrs: state.dvrs, outputs: state.outputs, tasks: state.tasks, uploads: state.uploads, activeTaskCount: [...state.tasks, ...state.uploads].filter(task => ['queued', 'pending', 'downloading', 'converting', 'uploading', 'stopping', 'reconciling'].includes(task.status) && !task.archivedAt).length, settings: state.settings, integrations: state.integrations, cover: state.cover });
  const config = () => ({ success: true, revision: `fixture-${state.revision}`, csrfToken: csrf, preparationOnly: mode === 'preparation', dvrs: state.dvrs, cameras: state.cameras, channels: state.cameras, mediamtx: { playbackUrl: state.playbackUrl } });
  const emit = () => { for (const client of clients) client.dispatchEvent(new MessageEvent('update', { data: JSON.stringify(bootstrap()) })); };
  class FixtureEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { super(); this.url = String(url); this.readyState = 1; clients.add(this); setTimeout(() => { if (this.readyState === 1) { this.dispatchEvent(new Event('open')); emit(); } }, 0); }
    close() { this.readyState = 2; clients.delete(this); }
  }
  window.EventSource = FixtureEventSource;
  const realFetch = window.fetch.bind(window);
  const response = (body = {}, status = 200) => new Response(JSON.stringify({ success: status < 400, ...clone(body) }), { status, headers: { 'Content-Type': 'application/json', 'X-Console-Fixture': 'synthetic-browser-only' } });
  const error = (message, status = 400, extra = {}) => response({ error: message, ...extra }, status);
  const wallMs = value => Date.parse(String(value).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(value) ? '' : '+08:00'));
  const wall = value => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const segments = date => {
    if (['empty', 'recordings-empty'].includes(mode)) return [];
    const day = Date.parse(`${date}T00:00:00+08:00`); if (!Number.isFinite(day)) return [];
    return [[28800, 33600], [33840, 39000], [43200, 50400], [64800, 75600]].map(([a, b]) => ({ start: new Date(day + a * 1000).toISOString(), duration: b - a }));
  };
  const coverage = (start, end) => {
    let cursor = start; const missingIntervals = [];
    const gap = (a, b) => missingIntervals.push({ start: wall(a), end: wall(b), startMs: a, endMs: b, durationSeconds: (b - a) / 1000 });
    for (const segment of segments(wall(start).slice(0, 10))) { const a = Date.parse(segment.start), b = a + segment.duration * 1000; if (b <= start || a >= end) continue; if (a > cursor) gap(cursor, Math.min(a, end)); cursor = Math.max(cursor, Math.min(b, end)); }
    if (cursor < end) gap(cursor, end);
    const missingSeconds = missingIntervals.reduce((sum, item) => sum + item.durationSeconds, 0), requestedSeconds = (end - start) / 1000;
    return { complete: !missingSeconds, hasGaps: Boolean(missingSeconds), hasFootage: requestedSeconds > missingSeconds, requestedSeconds, missingSeconds, availableSeconds: requestedSeconds - missingSeconds, missingIntervals };
  };
  const completeLater = (task, kind, item) => [25, 65, 100].forEach((percent, index) => setTimeout(() => {
    if (task.status === 'cancelled') return;
    Object.assign(task, { status: percent === 100 ? 'completed' : kind === 'upload' ? 'uploading' : 'downloading', stage: kind === 'upload' ? 'uploading' : 'downloading', stagePercent: percent, progressUnit: 'bytes', progressUpdatedAt: Date.now() });
    if (kind === 'upload') { task.uploadedBytes = Math.round(item.size * percent / 100); task.totalBytes = item.size; if (percent === 100) item.busy = false; }
    else if (percent === 100) { state.outputs.unshift(makeOutput(`demo-${task.taskId}`, `${task.start.slice(0, 10)}_${task.camera || 'DVR'}_演示导出${task.hasGaps ? '_含缺口' : ''}.mp4`)); task.message = '演示导出已完成，已加入成片库。'; }
    emit();
  }, (index + 1) * 1000));
  const saveConfig = () => { state.revision++; return response(config()); };
  const channels = [{ id: '101', name: '主球场 · 全景' }, { id: '201', name: '东侧球场' }, { id: '301', name: '球场入口' }];
  async function mock(pathname, method, input, headers, query, rawBody) {
    if (pathname === '/status/login') { if (input.password !== 'fixture-demo') return error('演示密码为 fixture-demo，请勿输入真实密码。', 401); state.authenticated = true; return response(); }
    if (pathname === '/status/logout') { state.authenticated = false; return response(); }
    if (pathname === '/console/api/auth') return response({ configured: state.configured });
    if (pathname === '/console/api/setup') { if (input.code !== 'demo' || input.password !== 'fixture-demo') return error('演示初始化码为 demo，密码为 fixture-demo。'); state.configured = true; return response(); }
    if (!state.authenticated) return error('演示登录已过期，请使用 fixture-demo 登录。', 401);
    if (pathname === '/console/api/bootstrap') { if (mode === 'error') return error('演示：暂时无法连接录像服务，请稍后重试。', 503); if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 2500)); return response(bootstrap()); }
    if (pathname === '/console/api/tasks') return response({ tasks: state.tasks, uploads: state.uploads, activeTaskCount: [...state.tasks, ...state.uploads].filter(task => ['queued', 'pending', 'downloading', 'converting', 'uploading', 'stopping', 'reconciling'].includes(task.status) && !task.archivedAt).length });
    const verificationMatch = /^\/console\/api\/uploads\/cloud189\/([^/]+)\/verify$/.exec(pathname);
    if (verificationMatch && method === 'POST') {
      if (mode === 'preparation') return error('当前尚不能核实上传结果。', 409);
      if (headers.get('x-csrf-token') !== csrf) return error('请刷新设置后重试。', 403);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(verificationMatch[1]) || !input || Array.isArray(input) || Object.keys(input).length) return error('核实请求无效。');
      const job = state.uploads.find(item => item.id === verificationMatch[1]);
      if (!job || job.provider !== 'cloud189' || job.status !== 'unknown' || job.uploadPhase !== 'remote_started' || job.archivedAt) return error('任务状态已改变，请刷新任务列表。', 409);
      if (verificationPending.has(job.id)) return response({ verified: false, code: 'VERIFY_BUSY', message: '账号正在处理其他操作，请稍后核实。' });
      verificationPending.add(job.id); verificationRequests.push({ id: job.id, mode });
      // Delay the response, not an upload. The seeded job stays UNKNOWN until verified.
      await new Promise(resolve => setTimeout(resolve, mode === 'cloud-verify-pending' ? 6000 : 350));
      verificationPending.delete(job.id);
      if (!state.authenticated) return error('登录已退出，请重新登录。', 401);
      if (mode === 'cloud-verify-error') return error('演示：核实服务暂时不可用；原任务仍待确认，没有重新上传。', 503, { code: 'VERIFY_UNAVAILABLE' });
      if (['cloud-verify-unknown', 'cloud-recovery'].includes(mode)) return response({ verified: false, code: 'CLOUD_FILE_NOT_FOUND', message: '云盘尚未找到这个文件；原任务仍待确认，没有重新上传。' });
      Object.assign(job, { status: 'completed', message: '已核实云盘文件、大小与校验值，没有重新上传。' });
      emit();
      return response({ verified: true, code: 'CLOUD_REMOTE_VERIFIED', message: job.message });
    }

    const recoveryMatch = /^\/console\/api\/uploads\/cloud189\/([^/]+)\/(retry|archive|restore)$/.exec(pathname);
    if (recoveryMatch && method === 'POST') {
      const action = recoveryMatch[2];
      if (mode === 'preparation') return error('当前尚不能恢复上传记录。', 409);
      if (headers.get('x-csrf-token') !== csrf) return error('请刷新设置后重试。', 403);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(recoveryMatch[1])
          || !input || Array.isArray(input) || (action === 'retry' ? input.confirmRetry !== true || Object.keys(input).some(key => key !== 'confirmRetry') : Object.keys(input).length)) return error('恢复请求无效。');
      const job = state.uploads.find(item => item.id === recoveryMatch[1]), file = state.outputs.find(item => item.id === job?.outputId);
      if (!job || job.status !== 'unknown' || job.uploadPhase !== 'remote_started' || (action === 'retry' && job.archivedAt)) return error('任务状态已改变。', 409);
      if (verificationPending.has(job.id)) return response({ applied: false, code: 'VERIFY_BUSY', message: '正在处理，请稍后。' });
      verificationPending.add(job.id); verificationRequests.push({ id: job.id, mode, action });
      await new Promise(resolve => setTimeout(resolve, mode === 'cloud-verify-pending' ? 6000 : 350));
      verificationPending.delete(job.id);
      if (!state.authenticated) return error('登录已退出，请重新登录。', 401);
      if (mode === 'cloud-verify-error') return error('演示恢复服务暂时不可用。', 503);
      const code = { archive: 'CLOUD_RECORD_ARCHIVED', restore: 'CLOUD_RECORD_RESTORED', retry: 'CLOUD_RETRY_QUEUED' }[action];
      if (action === 'archive') { job.archivedAt = new Date().toISOString(); if (file) Object.assign(file, { busy: false, busyReason: null }); }
      if (action === 'restore') { delete job.archivedAt; if (file) Object.assign(file, { busy: true, busyReason: 'verification' }); }
      if (action === 'retry') {
        job.attemptHistory = [...(job.attemptHistory || []), { status: 'unknown', uploadPhase: 'remote_started' }];
        Object.assign(job, { status: 'queued', uploadPhase: 'preflight', retryCount: job.attemptHistory.length, retryRequestedAt: new Date().toISOString(), message: '演示：已确认原目标目前无文件，已重新排队；原结果保留。' });
        if (file) Object.assign(file, { busy: true, busyReason: 'upload' });
      }
      emit(); return response({ applied: true, code, message: action === 'archive' ? '演示：已归档记录，成片可改名。' : action === 'restore' ? '演示：已恢复记录。' : job.message });
    }

    if (/\/segments$/.test(pathname)) return mode === 'recordings-error' ? error('演示：录像列表读取失败，请重试。', 503) : response({ segments: segments(query.get('date') || today) });
    if (/\/channels$/.test(pathname)) return response({ channels });
    if (/\/(stream|live)$/.test(pathname)) return mode === 'media-error' ? error('演示视频不可用。', 503) : realFetch(mediaUrl);
    if (pathname === '/console/api/outputs' && method === 'GET') return response({ outputs: state.outputs });
    const outputMatch = /^\/console\/api\/outputs\/([^/]+)(?:\/(recover-rename|upload\/(bilibili|cloud189)))?$/.exec(pathname);
    if (outputMatch) {
      const file = state.outputs.find(item => item.id === decodeURIComponent(outputMatch[1]));
      if (!file) return error('演示成片不存在。', 404); if (file.busy && !(outputMatch[3] === 'bilibili' && file.busyReason === 'verification')) return error('成片正在处理或上传中。', 409);
      if (method === 'PUT') { const name = String(input.newName || '').trim(); if (!name || /[\\/\x00-\x1f]/.test(name) || !/\.mp4$/i.test(name)) return error('请填写有效的 MP4 文件名。'); if (state.outputs.some(item => item !== file && item.filename === name)) return error('已有同名成片。', 409); state.uploads.filter(job => job.outputId === file.id && job.archivedAt).forEach(job => { job.filename = name; }); file.filename = name; emit(); return response({ filename: name }); }
      if (method === 'DELETE') { state.outputs = state.outputs.filter(item => item !== file); emit(); return response(); }
      if (outputMatch[2] === 'recover-rename') { file.renamePending = false; return response({ outputs: state.outputs }); }
      if (outputMatch[3]) {
        if (mode === 'upload-error') return error('演示：上传服务不可用，成片已保留。', 503);
        if (state.settings.managedEnabled && !state.settings[`${outputMatch[3]}Enabled`]) return error('请先在设置中启用此上传目标。', 409);
        if (outputMatch[3] === 'bilibili' && !(state.settings.bilibiliSeasonId > 0 && state.settings.bilibiliSectionId > 0)) return error('请先填写正整数合集 ID 和章节 ID；演示不会验证 ID 所有权。', 409);
        if (outputMatch[3] === 'bilibili' && !state.cover.present) return error('请先设置 B 站封面。', 409);
        if (outputMatch[3] === 'cloud189' && state.uploads.some(existing => existing.provider === 'cloud189' && existing.status === 'unknown' && existing.outputId === file.id)) return error('这份成片仍有待核实记录，请在任务页核实或重试。', 409);
        const job = { id: id(), createdAt: new Date().toISOString(), filename: file.filename, provider: outputMatch[3], targetPath: state.settings.cloud189TargetPath, status: 'queued' }; state.uploads.unshift(job); file.busy = true; completeLater(job, 'upload', file); emit(); return response({ job }, 202);
      }
    }
    if (pathname === '/console/api/export/stop') { const task = state.tasks.find(item => item.taskId === input.taskId); if (!task) return error('任务不存在。', 404); task.status = 'cancelled'; task.message = '已取消演示任务。'; emit(); return response(); }
    if (pathname === '/console/api/export' && method === 'POST') {
      const start = wallMs(input.start || ''), end = wallMs(input.end || ''); if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return error('结束时间必须晚于开始时间。');
      const range = coverage(start, end);
      if (input.source === 'mediamtx' && !range.availableSeconds) return error('所选时间没有可导出的录像。', 409, { code: 'MEDIAMTX_EMPTY', coverage: range });
      if (input.source === 'mediamtx' && range.hasGaps && !input.acceptGaps) return error('本地录像不完整。', 409, { code: 'MEDIAMTX_GAPS', coverage: range });
      const task = { taskId: id(), queuedAt: Date.now(), title: `${input.camera || 'DVR'} · ${input.start.slice(11)}–${input.end.slice(11)}`, source: input.source, camera: input.camera || input.channel, start: input.start, end: input.end, hasGaps: range.hasGaps, status: 'queued', queuePosition: 1, message: '演示任务 · 不会读取设备' }; state.tasks.unshift(task); completeLater(task, 'export'); emit(); return response({ taskId: task.taskId, status: 'queued', queuePosition: 1 }, 202);
    }
    if (pathname === '/console/api/settings/bilibili-cover') {
      if (method === 'PUT') {
        if (headers.get('x-csrf-token') !== csrf) return error('请刷新设置后重试。', 403);
        const type = headers.get('content-type')?.split(';')[0];
        if (!['image/png', 'image/jpeg'].includes(type) || rawBody == null) return error('封面只支持 PNG/JPEG 图片。');
        const candidate = new Blob([rawBody], { type });
        if (candidate.size > 5 * 1024 * 1024) return error('封面不能超过 5 MiB。', 413);
        const bytes = new Uint8Array(await candidate.arrayBuffer());
        const valid = type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!valid) return error('图片格式与内容不匹配。');
        if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
        coverBlob = candidate; coverObjectUrl = URL.createObjectURL(coverBlob); state.cover = { present: true, source: 'managed' }; state.integrations.bilibiliCoverAvailable = true; syncIntegrations();
        return response({ settings: state.settings, integrations: state.integrations, csrfToken: csrf, cover: state.cover });
      }
      return coverBlob ? new Response(coverBlob, { headers: { 'Content-Type': coverBlob.type } }) : error('演示封面尚未设置。', 404);
    }
    if (pathname === '/console/api/settings') {
      if (method === 'PUT') {
        if (headers.get('x-csrf-token') !== csrf) return error('请刷新设置后重试。', 403);
        for (const key of ['managedEnabled', 'bilibiliEnabled', 'cloud189Enabled']) if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') return error('启用状态必须为布尔值。');
        for (const key of ['bilibiliSeasonId', 'bilibiliSectionId']) if (Object.hasOwn(input, key) && (!Number.isSafeInteger(input[key]) || input[key] < 0)) return error('合集与章节 ID 必须为非负整数。');
        for (const [key, value] of Object.entries(input)) if (!Object.hasOwn(state.settings, key) || JSON.stringify(value) !== JSON.stringify(state.settings[key])) return error('上传配置固定，请刷新页面。', 400);
        syncIntegrations();
        emit();
      }
      return response({ settings: state.settings, integrations: state.integrations, csrfToken: csrf, cover: state.cover });
    }
    if (pathname === '/console/api/cache') { if (method === 'DELETE') { const complete = state.cache.filter(item => item.complete); state.cache = state.cache.filter(item => !item.complete); return response({ deletedCount: complete.length, deletedSize: complete.reduce((sum, item) => sum + item.size, 0) }); } return response({ files: state.cache }); }
    if (pathname === '/console/api/password') { if (input.oldPassword !== 'fixture-demo' || input.password !== 'fixture-demo') return error('演示环境仅使用 fixture-demo，不会保存密码。'); state.authenticated = false; return response(); }
    if (pathname === '/console/api/upload-accounts') {
      if (accountMode === 'unauthorized') return error('请重新登录控制台。', 401, { errorCode: 'SESSION_REQUIRED' });
      if (accountMode === 'read-error') return error('演示账号状态暂时无法读取。', 503);
      return response({ accounts: state.accounts, csrfToken: csrf, reauthRequired: accountMode === 'reauth' });
    }
    const accountMatch = /^\/console\/api\/upload-accounts\/(bilibili|cloud189)\/(start|status|qr|cancel|verify|disconnect)$/.exec(pathname);
    if (accountMatch) {
      if (accountMode === 'unauthorized') return error('请重新登录控制台。', 401, { errorCode: 'SESSION_REQUIRED' });
      if (accountMode === 'reauth' && method !== 'GET') return error('请重新登录控制台。', 403, { errorCode: 'SESSION_REAUTH_REQUIRED' });
      const account = state.accounts.find(item => item.provider === accountMatch[1]), action = accountMatch[2];
      if (!demoAccounts) return response({ account, message: '演示环境不提供真实二维码或账号登录。' });
      if (action === 'qr') return new Response(demoQrSvg, { headers: { 'Content-Type': 'image/svg+xml', 'X-Console-Fixture': 'not-a-login-code' } });
      if (action === 'start') {
        if (account.credentialsPresent && input.replace !== true) return error('已有演示连接，请明确确认替换。', 409, { code: 'ACCOUNT_REPLACEMENT_REQUIRED' });
        account.state = 'waiting_scan'; account.errorCode = null;
        account.attempt = { id: id(), state: 'waiting_scan', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), qrReady: true };
      } else if (action === 'cancel') {
        if (account.attempt && input.attemptId === account.attempt.id) { account.state = 'cancelled'; account.attempt.state = 'cancelled'; account.attempt.qrReady = false; }
      } else if (action === 'verify' && !['waiting_scan', 'waiting_confirmation', 'verifying'].includes(account.state)) {
        account.state = 'verifying'; account.errorCode = null;
        account.attempt = { id: id(), state: 'verifying', operation: 'verify', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), qrReady: false };
      } else if (action === 'disconnect') {
        account.state = 'verifying'; account.attempt = { id: id(), state: 'verifying', operation: 'disconnect', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), qrReady: false };
        const attemptId = account.attempt.id;
        setTimeout(() => { if (account.attempt?.id === attemptId) { account.state = 'disconnected'; account.credentialsPresent = false; account.attempt.state = 'disconnected'; account.errorCode = null; } }, 800);
      }
      // Verification only reflects an explicitly simulated connection, never invents one.
      return response({ account, message: '演示二维码，不可登录。通过顶部演示控件手动切换状态。' });
    }
    if (pathname === '/console/api/config' && method === 'GET') return mode === 'config-error' ? error('演示：配置暂时无法读取。', 503) : response(config());
    if (/^\/console\/api\/(dvrs|cameras|mediamtx)(\/|$)/.test(pathname) && method !== 'GET') {
      if (mode === 'preparation') return error('演示准备模式为只读。', 409);
      if (headers.get('x-csrf-token') !== csrf) return error('请刷新配置后重试。', 403);
      if (mode === 'config-conflict' && !state.conflictSent) { state.conflictSent = true; state.revision++; }
      if (input.revision !== `fixture-${state.revision}`) return error('配置已改变，请重新加载后再保存。', 409);
      if (pathname.endsWith('/test')) return response({ channels });
      if (pathname.endsWith('/snapshot')) return response({ imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' });
      if (pathname === '/console/api/dvrs' && method === 'POST') { if (!input.name || !input.ip || !input.username || !input.password) return error('请填写演示录像机信息。'); state.dvrs.push({ id: id(), name: input.name, ip: input.ip, username: input.username, httpPort: input.httpPort || 80, rtspPort: input.rtspPort || 554, hasPassword: true }); return saveConfig(); }
      const dvrMatch = /^\/console\/api\/dvrs\/([^/]+)$/.exec(pathname);
      if (dvrMatch) { const dvr = state.dvrs.find(item => item.id === dvrMatch[1]); if (!dvr) return error('录像机不存在。', 404); if (method === 'DELETE') { if (state.cameras.some(item => item.deviceId === dvr.id)) return error('请先移除录像机的摄像头映射。', 409); state.dvrs = state.dvrs.filter(item => item !== dvr); } else for (const key of ['name', 'ip', 'username', 'httpPort', 'rtspPort']) if (Object.hasOwn(input, key)) dvr[key] = input[key]; return saveConfig(); }
      if (pathname === '/console/api/cameras') { if (!Array.isArray(input.cameras)) return error('摄像头列表无效。'); state.cameras = input.cameras.map(({ id, name, archivePath, deviceId, channel }) => ({ id, name, archivePath, deviceId, channel })); return saveConfig(); }
      if (pathname === '/console/api/mediamtx') { let url; try { url = new URL(input.playbackUrl); } catch { return error('回放地址无效。'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return error('请填写不含凭据的 HTTP(S) 地址。'); state.playbackUrl = url.origin; return saveConfig(); }
    }
    return error('未知演示请求；不会转发到生产服务。', 404);
  }
  window.fetch = async (request, options = {}) => {
    const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url, location.href);
    const match = url.pathname.match(/\/(console\/api(?:\/.*)?|status\/(?:login|logout))$/);
    if (!match) return realFetch(request, options);
    let input = {}; if (!url.pathname.endsWith('/settings/bilibili-cover')) { try { input = JSON.parse(options.body || '{}'); } catch { return error('演示请求格式无效。'); } }
    return mock(`/${match[1]}`, String(options.method || request.method || 'GET').toUpperCase(), input, new Headers(options.headers || request.headers), url.searchParams, options.body);
  };
  // Native video loads do not call window.fetch. Redirect only the fixture API paths.
  const rewriteMedia = value => /\/console\/api\/(playback|dvrs|outputs)\/[^/]+\/(stream|live)(?:\?|$)/.test(String(value)) ? (mode === 'media-error' ? new URL('./missing-fixture-video.mp4', scriptUrl).href : mediaUrl) : value;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (descriptor?.set) Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...descriptor, set(value) { descriptor.set.call(this, rewriteMedia(value)); } });
  const setAttribute = HTMLMediaElement.prototype.setAttribute;
  HTMLMediaElement.prototype.setAttribute = function(name, value) { return setAttribute.call(this, name, name.toLowerCase() === 'src' ? rewriteMedia(value) : value); };
  // Browser-managed downloads bypass fetch just like native video does.
  if (typeof HTMLAnchorElement !== 'undefined') {
    const href = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
    if (href?.set) Object.defineProperty(HTMLAnchorElement.prototype, 'href', { ...href, set(value) {
      href.set.call(this, /\/console\/api\/outputs\/[^/]+\/stream(?:\?|$)/.test(String(value)) ? mediaUrl : value);
    } });
  }
  const imageSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imageSource?.set) Object.defineProperty(HTMLImageElement.prototype, 'src', { ...imageSource, set(value) {
    const rewritten = /\/console\/api\/outputs\/[^/]+\/thumbnail(?:\?|$)/.test(String(value))
      ? (mode === 'media-error' ? new URL('./missing-fixture-thumbnail.jpg', scriptUrl).href : thumbnailUrl)
      : /\/console\/api\/upload-accounts\/(bilibili|cloud189)\/qr(?:\?|$)/.test(String(value)) ? demoQrUrl
      : /\/console\/api\/settings\/bilibili-cover(?:\?|$)/.test(String(value)) ? coverObjectUrl || new URL('./missing-fixture-cover.png', scriptUrl).href : value;
    imageSource.set.call(this, rewritten);
  } });
  if (demoAccounts) document.addEventListener('DOMContentLoaded', () => {
    const tools = document.createElement('aside'); tools.id = 'fixture-account-tools'; tools.setAttribute('aria-label', '演示账号状态控制');
    tools.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;padding:8px 12px;background:#fff7ed;border-bottom:1px solid #fed7aa;font:500 12px/1.5 system-ui,sans-serif;color:#9a3412';
    const note = document.createElement('strong'); note.textContent = '演示二维码，不可登录 · 手动模拟状态'; tools.append(note);
    const provider = document.createElement('select'); provider.setAttribute('aria-label', '演示账号平台');
    for (const [value, label] of [['bilibili', 'B 站'], ['cloud189', '天翼云盘']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; provider.append(option); }
    const status = document.createElement('select'); status.setAttribute('aria-label', '演示连接状态');
    for (const [value, label] of [['waiting_scan', '等待扫码'], ['waiting_confirmation', '等待手机确认'], ['verifying', '验证中'], ['connected', '连接成功（演示）'], ['expired', '二维码过期'], ['error', '连接失败'], ['needs_login', '登录失效']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; status.append(option); }
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = '应用演示状态';
    const feedback = document.createElement('span'); feedback.setAttribute('role', 'status');
    apply.addEventListener('click', () => {
      const account = state.accounts.find(item => item.provider === provider.value);
      if (!account.attempt) { feedback.textContent = '先在设置中生成演示二维码。'; return; }
      account.state = status.value; account.attempt.state = status.value; account.attempt.qrReady = ['waiting_scan', 'waiting_confirmation'].includes(status.value);
      account.errorCode = status.value === 'error' ? 'SYNTHETIC_LOGIN_FAILED' : null;
      if (status.value === 'connected') account.credentialsPresent = true;
      feedback.textContent = '演示状态已修改；账号面板会在下一次同步时显示。';
    });
    tools.append(provider, status, apply, feedback); document.getElementById('fixture-banner')?.after(tools);
    // A native modal makes the surrounding page inert. Keep review controls usable
    // by moving this fixture-only panel into the active account dialog.
    if (typeof MutationObserver !== 'undefined') {
      const placeTools = () => {
        const dialog = document.querySelector('dialog.account-dialog[open]');
        if (dialog && tools.parentElement !== dialog) dialog.append(tools);
        else if (!dialog && tools.previousElementSibling?.id !== 'fixture-banner') document.getElementById('fixture-banner')?.after(tools);
      };
      new MutationObserver(placeTools).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class'] });
      placeTools();
    }
  });
  window.__consoleFixture = Object.freeze({ synthetic: true, mode, scenarios: modes, inspect: () => clone(bootstrap()), inspectVerification: () => clone({ requests: verificationRequests, pendingIds: [...verificationPending] }) });
})();

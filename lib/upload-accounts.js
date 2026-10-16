/** Owner/session-scoped account linking. The HTTP surface never accepts credentials or file paths. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONSOLE_CONFIG_OWNER } from './console-config.js';
import { launchUploadAccountAdapter, readPrivateFile, validateCredentials, validateQrPng, fetchCloud189Qr, MAX_QR_BYTES } from './upload-account-adapter.js';

export const UPLOAD_ACCOUNT_PROVIDERS = ['bilibili', 'cloud189'];
export const UPLOAD_ACCOUNT_TTL_MS = 300_000;
const ACTIVE = new Set(['waiting_scan', 'waiting_confirmation', 'verifying']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MESSAGES = Object.freeze({
  PROVIDER_UNAVAILABLE: '服务器尚未启用此平台的扫码连接。', PROVIDER_BUSY: '此平台正在上传或验证，请稍后重试。',
  ATTEMPT_NOT_FOUND: '连接会话不存在，请重新开始。', ATTEMPT_EXPIRED: '二维码已过期，请重新连接。',
  QR_NOT_READY: '二维码正在生成，请稍候。', LOGIN_FAILED: '连接未完成，请重新扫码。', VERIFY_FAILED: '暂时无法验证连接，请稍后重试。',
  NEEDS_LOGIN: '登录已失效，请重新扫码连接。', INVALID_REQUEST: '连接请求格式无效。',
  RECOVERY_BLOCKED: '任务恢复尚未就绪，暂不能修改账号连接。', PREPARATION_ONLY: '当前为准备模式，尚未开放账号连接。',
  SESSION_REAUTH_REQUIRED: '请退出并重新登录一次，再连接上传账号；现有控制台会话仍可正常使用。',
  REPLACE_CONFIRMATION_REQUIRED: '已保存此平台的登录，请确认替换后再扫码。', SESSION_REQUIRED: '请从已登录的控制台操作账号连接。',
});
function fault(code, status = 400) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.LOGIN_FAILED), { code, status }); }
function ensureDirectory(directory) {
  // Reject symlinks all the way down; credential/QR reads must never escape through a parent link.
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const piece of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_DIRECTORY');
  }
  fs.chmodSync(absolute, 0o700);
}
function filePresent(file) {
  try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size > 0 && s.size <= 256 * 1024 && !(s.mode & 0o077); }
  catch { return false; }
}
function binaryAvailable(binary) {
  try { return path.isAbsolute(binary) && fs.statSync(binary).isFile() && (fs.accessSync(binary, fs.constants.X_OK), true); } catch { return false; }
}
export function uploadAccountConfig({ dataDir, downloadsDir, releaseRoot, env = process.env }) {
  const root = path.join(dataDir, 'private', 'upload-accounts');
  return { root, providers: Object.fromEntries(UPLOAD_ACCOUNT_PROVIDERS.map(provider => [provider, {
    enabled: (env.HIKCLIP_UPLOAD_ACCOUNT_LINKING_ENABLED ?? env.HIKCLIP_MANAGED_UPLOADS_ENABLED) === '1',
    binary: provider === 'bilibili' ? env.BILIUP_BINARY || (releaseRoot ? path.join(releaseRoot, 'upload-tools', 'biliup') : '') : env.CLOUD189_BINARY || (releaseRoot ? path.join(releaseRoot, 'upload-tools', 'cloud189') : ''),
    credentialFile: path.join(root, `${provider}.json`),
    lockFile: path.join(downloadsDir, provider === 'bilibili' ? 'biliup_work' : 'cloud189_work', 'provider.lock'),
  }])) };
}
export function createUploadAccountManager({ root, providers, launch = launchUploadAccountAdapter, fetchQr = fetchCloud189Qr,
  now = Date.now, canWrite = () => true, preparationOnly = () => process.env.HIKCLIP_PREPARATION_ONLY === '1', onAccountChange = () => {},
  available = config => config.enabled && binaryAvailable(config.binary) && binaryAvailable('/usr/bin/python3'), pollMs = 1000 } = {}) {
  const attempts = new Map(), accountStates = new Map();
  let closed = false;
  const configFor = provider => { if (!UPLOAD_ACCOUNT_PROVIDERS.includes(provider) || !providers?.[provider]) throw fault('INVALID_REQUEST'); return providers[provider]; };
  function checkWrite() {
    if (closed || !canWrite()) throw fault('RECOVERY_BLOCKED', 503);
    if (preparationOnly()) throw fault('PREPARATION_ONLY', 409);
  }
  function ownerKey(owner) {
    if (!owner || typeof owner.sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(owner.sessionId) || owner.isSessionActive?.() === false) throw fault('SESSION_REQUIRED', 401);
    return owner.sessionId;
  }
  function account(provider, owner, requestedId) {
    const config = configFor(provider), session = ownerKey(owner), attempt = attempts.get(provider);
    if (requestedId !== undefined && (!UUID.test(requestedId) || !attempt || attempt.id !== requestedId || attempt.sessionId !== session)) throw fault('ATTEMPT_NOT_FOUND', 404);
    const own = attempt?.sessionId === session ? attempt : null;
    const state = own ? own.state : accountStates.get(provider) || (available(config) ? 'disconnected' : 'unavailable');
    return { provider, state, available: Boolean(available(config)), credentialsPresent: filePresent(config.credentialFile),
      errorCode: own?.errorCode || null,
      attempt: own ? { id: own.id, state: own.state, createdAt: new Date(own.createdAt).toISOString(), expiresAt: new Date(own.expiresAt).toISOString(), qrReady: Boolean(own.qr && ACTIVE.has(own.state)) } : null };
  }
  function connectionGeneration(provider) {
    const config = configFor(provider);
    try {
      const value = JSON.parse(readPrivateFile(path.join(root, `${provider}.connection.json`), 256));
      return value.version === 1 && /^[a-f0-9]{32}$/.test(value.generation || '') && filePresent(config.credentialFile) ? value.generation : null;
    } catch { return null; }
  }
  function writeConnection(provider, generation) {
    const file = path.join(root, `${provider}.connection.json`), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, generation })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const parent = fs.openSync(root, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  function quarantineJobs(provider) {
    const directory = path.join(path.dirname(configFor(provider).lockFile), 'jobs');
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const file = path.join(directory, name), job = JSON.parse(readPrivateFile(file, 1024 * 1024));
      if (!['draft', 'queued', 'uploading', 'unknown'].includes(job.status)
        && !(job.status === 'completed' && ['pending', 'error'].includes(job.collectionStatus))) continue;
      job.errorCode = 'ACCOUNT_CHANGED';
      job.message = '账号已改变或未绑定，请重新确认并提交；原任务不会自动上传';
      if (job.status === 'completed') job.collectionStatus = 'error';
      else if (job.status === 'unknown' || job.uploadPhase === 'remote_started') job.status = 'unknown';
      else Object.assign(job, { status: 'error', uploadPhase: 'preflight', stage: null, stagePercent: null });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(job)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
      } finally { fs.rmSync(tmp, { force: true }); }
    }
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const isCurrent = attempt => !closed && attempts.get(attempt.provider) === attempt && ACTIVE.has(attempt.state)
    && now() < attempt.expiresAt && attempt.owner.isSessionActive?.() !== false;
  async function dispose(attempt) {
    if (attempt.disposal) return attempt.disposal;
    attempt.controller.abort(); attempt.qr = null;
    clearInterval(attempt.timer);
    attempt.disposal = (async () => {
      await attempt.handle?.stop();
      if (attempt.stageDir) fs.rmSync(attempt.stageDir, { recursive: true, force: true });
      attempt.handle = null;
    })();
    return attempt.disposal;
  }
  async function finish(attempt, state, errorCode = null) {
    if (!ACTIVE.has(attempt.state)) return;
    attempt.state = state; attempt.errorCode = errorCode;
    if (state === 'connected' || state === 'needs_login' || (state === 'disconnected' && attempt.mode === 'disconnect')) accountStates.set(attempt.provider, state);
    await dispose(attempt);
  }
  async function consume(attempt, event) {
    if (!isCurrent(attempt)) return;
    const config = configFor(attempt.provider);
    if (event.type === 'locked') {
      checkWrite();
      if (attempt.mode === 'verify') {
        let bytes;
        try { bytes = readPrivateFile(config.credentialFile); validateCredentials(attempt.provider, bytes); }
        catch { await finish(attempt, 'needs_login', 'NEEDS_LOGIN'); return; }
        fs.writeFileSync(attempt.credentialFile, bytes, { flag: 'wx', mode: 0o600 });
      } else if (attempt.mode === 'login' && attempt.provider === 'cloud189') {
        fs.writeFileSync(attempt.credentialFile, '{}', { flag: 'wx', mode: 0o600 });
      }
      attempt.handle.begin();
    } else if (event.type === 'state') {
      if (['waiting_scan', 'waiting_confirmation'].includes(event.state) && attempt.mode === 'login') attempt.state = event.state;
    } else if (event.type === 'qr' && attempt.mode === 'login' && !attempt.qrRequested) {
      attempt.qrRequested = true;
      const bytes = event.source === 'file' && attempt.provider === 'bilibili'
        ? readPrivateFile(path.join(attempt.stageDir, 'qrcode.png'), MAX_QR_BYTES)
        : event.source === 'url' && attempt.provider === 'cloud189' ? await fetchQr(event.url, { signal: attempt.controller.signal }) : null;
      if (!validateQrPng(bytes)) throw fault('LOGIN_FAILED');
      if (isCurrent(attempt)) attempt.qr = bytes;
    } else if (event.type === 'result') {
      if (!event.ok) {
        const code = Object.hasOwn(MESSAGES, event.code) ? event.code : attempt.mode === 'login' ? 'LOGIN_FAILED' : 'VERIFY_FAILED';
        await finish(attempt, code === 'NEEDS_LOGIN' ? 'needs_login' : 'error', code); return;
      }
      checkWrite();
      if (!isCurrent(attempt)) return;
      if (attempt.mode !== 'disconnect') validateCredentials(attempt.provider, readPrivateFile(attempt.credentialFile));
      // Stop this provider before changing its account. A refresh keeps its
      // binding, but a new QR connection must never revive an older queue.
      if (attempt.mode !== 'verify') {
        await onAccountChange(attempt.provider, { mode: attempt.mode, phase: 'before_commit' });
        checkWrite();
        if (!isCurrent(attempt)) return;
        quarantineJobs(attempt.provider);
        writeConnection(attempt.provider, null);
      }
      if (attempt.mode === 'disconnect') {
        // Only the fixed app-managed credential file is removed, never uploads/videos.
        if (fs.existsSync(config.credentialFile)) {
          const stat = fs.lstatSync(config.credentialFile);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fault('VERIFY_FAILED');
          fs.unlinkSync(config.credentialFile);
        }
      } else {
        const bytes = readPrivateFile(attempt.credentialFile); validateCredentials(attempt.provider, bytes);
        // Same filesystem, retained account flock, synchronous final generation check.
        if (!isCurrent(attempt)) return;
        const fd = fs.openSync(attempt.credentialFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(attempt.credentialFile, config.credentialFile);
        const promotedDirectory = fs.openSync(path.dirname(config.credentialFile), 'r');
        try { fs.fsyncSync(promotedDirectory); } finally { fs.closeSync(promotedDirectory); }
        if (attempt.mode === 'login') writeConnection(attempt.provider, crypto.randomBytes(16).toString('hex'));
      }
      const parent = fs.openSync(path.dirname(config.credentialFile), 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      attempt.handle.release();
      await finish(attempt, attempt.mode === 'disconnect' ? 'disconnected' : 'connected');
      try { await onAccountChange(attempt.provider, { mode: attempt.mode, phase: 'committed' }); } catch { /* Do not expose supervisor diagnostics. */ }
    }
  }
  async function begin(provider, owner, mode, { replace = false } = {}) {
    checkWrite(); const config = configFor(provider), sessionId = ownerKey(owner);
    if (owner.sessionVersion !== undefined && owner.sessionVersion !== 3) throw fault('SESSION_REAUTH_REQUIRED', 403);
    if (mode !== 'disconnect' && !available(config)) throw fault('PROVIDER_UNAVAILABLE', 503);
    const previous = attempts.get(provider);
    if (previous && ACTIVE.has(previous.state)) throw fault('PROVIDER_BUSY', 409);
    if (previous?.disposal) await previous.disposal;
    checkWrite(); ownerKey(owner);
    if (attempts.get(provider) !== previous || (previous && ACTIVE.has(previous.state))) throw fault('PROVIDER_BUSY', 409);
    if (mode === 'login' && filePresent(config.credentialFile) && replace !== true) throw fault('REPLACE_CONFIRMATION_REQUIRED', 409);
    if (mode === 'verify' && !filePresent(config.credentialFile)) { accountStates.set(provider, 'needs_login'); throw fault('NEEDS_LOGIN', 409); }
    ensureDirectory(root); ensureDirectory(path.join(root, 'attempts')); ensureDirectory(path.dirname(config.credentialFile)); ensureDirectory(path.dirname(config.lockFile));
    // Config is internal-only; reject accidental destinations outside the private account root.
    if (path.resolve(config.credentialFile) !== path.join(path.resolve(root), `${provider}.json`)) throw fault('PROVIDER_UNAVAILABLE', 503);
    const started = now(), id = crypto.randomUUID(), stageDir = fs.mkdtempSync(path.join(root, 'attempts', `${provider}-`));
    fs.chmodSync(stageDir, 0o700);
    const attempt = { id, provider, mode, owner, sessionId, state: mode === 'login' ? 'waiting_scan' : 'verifying',
      createdAt: started, expiresAt: started + UPLOAD_ACCOUNT_TTL_MS, stageDir, credentialFile: path.join(stageDir, 'credentials.json'),
      controller: new AbortController(), qr: null, errorCode: null, events: Promise.resolve() };
    attempts.set(provider, attempt);
    try {
      attempt.handle = launch({ provider, mode, binary: config.binary || '/usr/bin/false', stageDir,
        credentialFile: attempt.credentialFile, lockFile: config.lockFile,
        onEvent: event => { attempt.events = attempt.events.then(() => consume(attempt, event)).catch(() => finish(attempt, 'error', mode === 'login' ? 'LOGIN_FAILED' : 'VERIFY_FAILED')); } });
      attempt.handle.closed.then(() => {
        attempt.events = attempt.events.then(() => ACTIVE.has(attempt.state) ? finish(attempt, 'error', mode === 'login' ? 'LOGIN_FAILED' : 'VERIFY_FAILED') : undefined);
      });
      attempt.timer = setInterval(() => {
        if (now() >= attempt.expiresAt) void finish(attempt, 'expired', 'ATTEMPT_EXPIRED');
        else if (owner.isSessionActive?.() === false || !canWrite() || preparationOnly()) void finish(attempt, 'cancelled');
      }, pollMs);
      attempt.timer.unref?.();
    } catch { await finish(attempt, 'error', 'PROVIDER_UNAVAILABLE'); }
    return account(provider, owner);
  }
  return {
    connectionGeneration,
    list: owner => UPLOAD_ACCOUNT_PROVIDERS.map(provider => account(provider, owner)),
    status: account,
    start: (provider, owner, options) => begin(provider, owner, 'login', options),
    verify: (provider, owner) => begin(provider, owner, 'verify'),
    disconnect: (provider, owner) => begin(provider, owner, 'disconnect'),
    async cancel(provider, owner, id) {
      account(provider, owner, id);
      await finish(attempts.get(provider), 'cancelled');
      return account(provider, owner, id);
    },
    qr(provider, owner, id) {
      account(provider, owner, id); const attempt = attempts.get(provider);
      if (!ACTIVE.has(attempt.state) || now() >= attempt.expiresAt) throw fault('ATTEMPT_EXPIRED', 410);
      if (!attempt.qr) throw fault('QR_NOT_READY', 404);
      return attempt.qr;
    },
    async cancelSession(sessionId) { await Promise.all([...attempts.values()].filter(a => a.sessionId === sessionId).map(a => finish(a, 'cancelled'))); },
    integrationState() { return Object.fromEntries(UPLOAD_ACCOUNT_PROVIDERS.map(provider => [provider, {
      state: accountStates.get(provider) || (available(configFor(provider)) ? 'disconnected' : 'unavailable'),
      available: Boolean(available(configFor(provider))), credentialsPresent: filePresent(configFor(provider).credentialFile),
      bindingPresent: Boolean(connectionGeneration(provider)), busy: ACTIVE.has(attempts.get(provider)?.state),
    }])); },
    async close() { closed = true; await Promise.all([...attempts.values()].map(a => finish(a, 'cancelled'))); },
    closeSync() { closed = true; for (const a of attempts.values()) { a.state = 'cancelled'; clearInterval(a.timer); a.controller.abort(); a.handle?.killNow?.(); a.qr = null; if (a.stageDir) fs.rmSync(a.stageDir, { recursive: true, force: true }); } },
  };
}
export function mountUploadAccounts(app, { manager }) {
  const base = '/console/api/upload-accounts';
  app.use(base, (req, res, next) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    if (!req[CONSOLE_CONFIG_OWNER]?.sessionId) return res.status(401).json({ success: false, error: MESSAGES.SESSION_REQUIRED, errorCode: 'SESSION_REQUIRED' });
    if (!['GET', 'HEAD'].includes(req.method) && req[CONSOLE_CONFIG_OWNER].sessionVersion !== 3) return res.status(403).json({ success: false, error: MESSAGES.SESSION_REAUTH_REQUIRED, errorCode: 'SESSION_REAUTH_REQUIRED' });
    next();
  });
  const wrap = action => async (req, res) => {
    try { await action(req, res); }
    catch (error) { res.status(error.status || 500).json({ success: false, error: MESSAGES[error.code] || MESSAGES.LOGIN_FAILED, errorCode: Object.hasOwn(MESSAGES, error.code) ? error.code : 'LOGIN_FAILED' }); }
  };
  const owner = req => req[CONSOLE_CONFIG_OWNER];
  const checkBody = (req, keys = []) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => !keys.includes(k))) throw fault('INVALID_REQUEST');
  };
  const attemptId = req => {
    if (Object.keys(req.query).some(k => k !== 'attemptId') || typeof req.query.attemptId !== 'string' || !UUID.test(req.query.attemptId)) throw fault('INVALID_REQUEST');
    return req.query.attemptId;
  };
  app.get(base, wrap((req, res) => res.json({ success: true, accounts: manager.list(owner(req)), csrfToken: owner(req).csrfToken, reauthRequired: owner(req).sessionVersion !== 3 })));
  app.get(`${base}/:provider/status`, wrap((req, res) => res.json({ success: true, account: manager.status(req.params.provider, owner(req), attemptId(req)) })));
  app.get(`${base}/:provider/qr`, wrap((req, res) => res.type('png').send(manager.qr(req.params.provider, owner(req), attemptId(req)))));
  app.post(`${base}/:provider/start`, wrap(async (req, res) => {
    checkBody(req, ['replace']); if (Object.hasOwn(req.body, 'replace') && typeof req.body.replace !== 'boolean') throw fault('INVALID_REQUEST');
    res.json({ success: true, account: await manager.start(req.params.provider, owner(req), req.body) });
  }));
  for (const mode of ['verify', 'disconnect']) app.post(`${base}/:provider/${mode}`, wrap(async (req, res) => {
    checkBody(req); res.json({ success: true, account: await manager[mode](req.params.provider, owner(req)) });
  }));
  app.post(`${base}/:provider/cancel`, wrap(async (req, res) => {
    checkBody(req, ['attemptId']); if (typeof req.body.attemptId !== 'string' || !UUID.test(req.body.attemptId)) throw fault('INVALID_REQUEST');
    res.json({ success: true, account: await manager.cancel(req.params.provider, owner(req), req.body.attemptId) });
  }));
}

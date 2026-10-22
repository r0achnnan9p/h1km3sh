/** 公网入口的最小权限：MCP Bearer + 按路径、时效绑定的下载签名。 */
import fs from 'node:fs';
import { CONSOLE_CONFIG_OWNER } from './console-config.js';
import express from 'express';
import { createHash, createHmac, pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isArtifactPath } from './artifacts.js';
import { isOutputFilename } from './output-files.js';
import { statusDashboardPage } from './status-dashboard.js';

export const DOWNLOAD_LINK_TTL_SECONDS = 24 * 60 * 60;
const STATUS_PASSWORD_ITERATIONS = 210_000;
const STATUS_SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_STATUS_SESSION_SECONDS = 30 * 24 * 60 * 60;
const pbkdf2Async = promisify(pbkdf2);

export function readMcpToken(env = process.env) {
  const token = env.HIKCLIP_MCP_TOKEN_FILE ? fs.readFileSync(env.HIKCLIP_MCP_TOKEN_FILE, 'utf8').trim() : env.HIKCLIP_MCP_TOKEN || '';
  if (token && (token.length < 32 || /\s/.test(token))) throw new Error('MCP Token 必须至少 32 字符且不能包含空白。');
  return token;
}
export function readStatusPasswordHash(env = process.env) {
  const value = (env.HIKCLIP_STATUS_PASSWORD_HASH || '').trim();
  if (value && !/^pbkdf2:210000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(value)) {
    throw new Error('HIKCLIP_STATUS_PASSWORD_HASH 格式无效。请使用 createStatusPasswordHash() 生成。');
  }
  return value;
}
export function readStatusSessionSeconds(env = process.env) {
  const hours = env.HIKCLIP_STATUS_SESSION_HOURS;
  if (hours === undefined || hours === '') return STATUS_SESSION_SECONDS;
  if (!/^[1-9]\d*$/.test(String(hours)) || Number(hours) > MAX_STATUS_SESSION_SECONDS / 3600) {
    throw new Error('HIKCLIP_STATUS_SESSION_HOURS 必须为 1–720 的整数小时数（最多 30 天）。');
  }
  return Number(hours) * 3600;
}
export function createStatusPasswordHash(password, salt = randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('状态密码长度必须为 8–128 个字符。');
  const saltBytes = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  if (saltBytes.length !== 16) throw new Error('状态密码盐值必须为 16 字节。');
  const hash = pbkdf2Sync(password, saltBytes, STATUS_PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2:${STATUS_PASSWORD_ITERATIONS}:${saltBytes.toString('hex')}:${hash.toString('hex')}`;
}
export function publicBaseUrl(value = process.env.HIKCLIP_PUBLIC_BASE_URL) {
  if (!value) return '';
  const url = new URL(value);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (basePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath))) {
    throw new Error('HIKCLIP_PUBLIC_BASE_URL 必须为 HTTPS 地址；路径只能是简单的 URL 前缀。');
  }
  return `${url.origin}${basePath}`;
}
function equal(left, right) {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}
export function bearerValid(header, token) {
  return Boolean(token) && typeof header === 'string' && header.startsWith('Bearer ') && equal(header.slice(7), token);
}
export function createBearerAuth(token, { verifyAccess, resourceMetadata } = {}) {
  return (req, res, next) => {
    const header = req.get('authorization');
    if (!token || bearerValid(header, token) || (header?.startsWith('Bearer ') && verifyAccess?.(header.slice(7)))) return next();
    res.set('WWW-Authenticate', resourceMetadata ? `Bearer resource_metadata="${resourceMetadata}"` : 'Bearer').set('Cache-Control', 'no-store').status(401)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  };
}
export function isDownloadPath(value) {
  if (/^\/media-jobs\/[a-f0-9-]{36}$/.test(value)) return true;
  if (value.startsWith('/artifacts/')) return isArtifactPath(value.slice('/artifacts/'.length));
  if (!value.startsWith('/downloads/')) return false;
  try { return isOutputFilename(decodeURIComponent(value.slice('/downloads/'.length))); }
  catch { return false; }
}
function signature(pathname, expires, token) {
  return createHmac('sha256', token).update(`download\n${pathname}\n${expires}`).digest('hex');
}
export function signDownload(pathname, { token, baseUrl = '', now = Date.now(), ttl = DOWNLOAD_LINK_TTL_SECONDS } = {}) {
  if (!isDownloadPath(pathname)) throw new Error('无效的下载路径。');
  if (!token) return `${baseUrl}${pathname}`;
  const expires = String(Math.floor(now / 1000) + ttl);
  return `${baseUrl}${pathname}?expires=${expires}&signature=${signature(pathname, expires, token)}`;
}
export function verifyDownload(value, { token, now = Date.now() } = {}) {
  if (!token) return false;
  let url;
  try { url = new URL(value, 'http://local'); } catch { return false; }
  if (!isDownloadPath(url.pathname) || url.searchParams.getAll('expires').length !== 1 || url.searchParams.getAll('signature').length !== 1) return false;
  const expires = url.searchParams.get('expires'), provided = url.searchParams.get('signature');
  if (!/^\d{1,12}$/.test(expires) || Number(expires) <= Math.floor(now / 1000) || !/^[a-f0-9]{64}$/.test(provided)) return false;
  return equal(provided, signature(url.pathname, expires, token));
}
/** 同一进程的第二个监听入口，不开放 Web、API、设备列表或原始录像。 */
export function createPublicGateway(app, { token, baseUrl, oauth, statusPasswordHash = '', statusPasswordStore, statusSessionSeconds = STATUS_SESSION_SECONDS, getStatus, onSessionEnd } = {}) {
  if (!token || !baseUrl) throw new Error('公网入口必须配置 MCP Token 和 HIKCLIP_PUBLIC_BASE_URL。');
  if (statusPasswordHash && !/^pbkdf2:210000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(statusPasswordHash)) throw new Error('状态看板密码哈希格式无效。');
  if (!Number.isInteger(statusSessionSeconds) || statusSessionSeconds < 3600 || statusSessionSeconds > MAX_STATUS_SESSION_SECONDS) {
    throw new Error('控制台会话有效期必须为 1 小时到 30 天。');
  }
  baseUrl = publicBaseUrl(baseUrl);
  const gateway = express();
  const auth = createBearerAuth(token, { verifyAccess: oauth?.verifyAccess, resourceMetadata: oauth ? `${baseUrl}/.well-known/oauth-protected-resource` : undefined });
  const consoleBasePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const baseOrigin = new URL(baseUrl).origin;
  // 同域名的独立部署不能覆盖根站点 Cookie，也不能误读浏览器同时发送的旧会话。
  const sessionCookieName = consoleBasePath
    ? `hikclip_status_${createHash('sha256').update(consoleBasePath).digest('hex')}`
    : 'hikclip_status';
  const sessionCookiePath = consoleBasePath || '/';
  const getPasswordHash = () => statusPasswordStore?.getPasswordHash?.() || statusPasswordHash;
  const loginFailures = new Map();
  // Explicit logout revokes v3 nonces for this gateway process. This is not a
  // persistent session store: a service restart clears this in-memory denylist.
  const revokedSessionNonces = new Map();
  // Bind the configured lifetime too: reducing it must not let an old longer
  // session become valid again when its expiry approaches the shorter window.
  const sessionSignature = (expires, hash = getPasswordHash()) => createHmac('sha256', createHash('sha256').update(`${token}\n${hash}`).digest()).update(`status-v2\n${expires}\n${statusSessionSeconds}\n${consoleBasePath}`).digest('hex');
  const nonceSessionSignature = (expires, nonce, hash = getPasswordHash()) => createHmac('sha256', createHash('sha256').update(`${token}\n${hash}`).digest()).update(`status-v3\n${expires}\n${nonce}\n${statusSessionSeconds}\n${consoleBasePath}`).digest('hex');
  const sessionVersion = req => {
    const cookie = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${sessionCookieName}=`));
    const parts = (cookie?.slice(sessionCookieName.length + 1) || '').split('.');
    const [expires, middle, last] = parts, currentHash = getPasswordHash();
    if (!currentHash || !/^\d{10}$/.test(expires || '') || Number(expires) <= Math.floor(Date.now() / 1000)
      || Number(expires) > Math.floor(Date.now() / 1000) + statusSessionSeconds + 60) return null;
    // Previously remembered v2 sessions keep their original validity and expiry.
    // A new explicit login gets an independent random nonce for QR-attempt ownership.
    if (parts.length === 2 && /^[a-f0-9]{64}$/.test(middle || '') && equal(middle, sessionSignature(expires, currentHash))) return 2;
    if (parts.length === 3 && !revokedSessionNonces.has(middle) && /^[a-f0-9]{32}$/.test(middle || '') && /^[a-f0-9]{64}$/.test(last || '')
      && equal(last, nonceSessionSignature(expires, middle, currentHash))) return 3;
    return null;
  };
  const statusSessionValid = req => sessionVersion(req) !== null;
  const requireStatusSession = (req, res, next) => statusSessionValid(req)
    ? next()
    : res.status(401).json({ success: false, error: '需要先登录状态看板。' });
  const accountPathAllowed = req => (req.method === 'GET' && req.path === '/console/api/upload-accounts')
    || (req.method === 'GET' && /^\/console\/api\/upload-accounts\/(?:bilibili|cloud189)\/(?:status|qr)$/.test(req.path))
    || (req.method === 'POST' && /^\/console\/api\/upload-accounts\/(?:bilibili|cloud189)\/(?:start|cancel|verify|disconnect)$/.test(req.path));
  const configPathAllowed = req => accountPathAllowed(req) || (['GET', 'PUT'].includes(req.method) && req.path === '/console/api/settings/bilibili-cover') || (['GET', 'PUT'].includes(req.method) && req.path === '/console/api/settings')
    || (req.method === 'POST' && /^\/console\/api\/uploads\/cloud189\/[a-f0-9-]{36}\/(?:verify|retry|archive|restore)$/.test(req.path))
    || (req.method === 'POST' && /^\/console\/api\/tasks\/[a-f0-9-]{36}\/dvr-http-sample$/.test(req.path))
    || (req.method === 'GET' && req.path === '/console/api/config')
    || (req.method === 'POST' && req.path === '/console/api/dvrs')
    || (['PATCH', 'DELETE'].includes(req.method) && /^\/console\/api\/dvrs\/[a-f0-9-]{36}$/.test(req.path))
    || (req.method === 'POST' && /^\/console\/api\/dvrs\/[a-f0-9-]{36}\/(?:test|snapshot)$/.test(req.path))
    || (req.method === 'PUT' && ['/console/api/cameras', '/console/api/mediamtx'].includes(req.path));
  const csrfToken = req => createHmac('sha256', token).update(`console-config-csrf\n${consoleBasePath}\n${req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${sessionCookieName}=`)) || ''}`).digest('hex');
  const accountSessionId = req => createHmac('sha256', token).update(`upload-account-session\n${consoleBasePath}\n${req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${sessionCookieName}=`)) || ''}`).digest('hex');
  const consolePathAllowed = req => {
    if (configPathAllowed(req)) return true;
    const { method, path: pathname } = req;
    if (method === 'GET' && ['/console.js', '/precision-timeline.js', '/console.css', '/touch-controls.js', '/ui-primitives.js', '/touch-controls.css', '/output-player.js', '/output-download.js', '/playback-coverage.js', '/press-repeat.js', '/replay-controls.js', '/task-presentation.js', '/upload-accounts.js', '/debug-mark.js', '/mediamtx-reader.js', '/mediamtx-live-player.js', '/site-v2.webmanifest', '/console-icon-v2.svg', '/console-icon-v2-192.png', '/console-icon-v2-512.png', '/apple-touch-icon-v2.png'].includes(pathname)) return true;
    if (method === 'GET' && /^\/fonts\/(inter|jetbrains-mono)\.woff2$/.test(pathname)) return true;
    if (method === 'GET' && ['/console/api/auth', '/console/api/bootstrap', '/console/api/outputs', '/console/api/tasks', '/console/api/events', '/console/api/settings', '/console/api/cache'].includes(pathname)) return true;
    if (method === 'POST' && ['/console/api/setup', '/console/api/password', '/console/api/export', '/console/api/export/stop'].includes(pathname)) return true;
    if (method === 'PUT' && pathname === '/console/api/settings') return true;
    if (method === 'DELETE' && pathname === '/console/api/cache') return true;
    if (method === 'GET' && /^\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/(segments|stream)$/.test(pathname)) return true;
    if (method === 'GET' && /^\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/live\/options$/.test(pathname)) return true;
    if (method === 'POST' && /^\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/live\/whep$/.test(pathname)) return true;
    if (['PATCH', 'DELETE'].includes(method) && /^\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/live\/sessions\/[a-f0-9-]{36}$/.test(pathname)) return true;
    if (method === 'HEAD' && /^\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/stream$/.test(pathname)) return true;
    if (method === 'GET' && /^\/console\/api\/dvrs\/[a-f0-9-]{36}(\/(channels|segments|stream|live))$/.test(pathname)) return true;
    if (['GET', 'HEAD'].includes(method) && /^\/console\/api\/dvr-preview\/[a-f0-9-]{36}\/(?:index\.m3u8|segment-\d{6}\.ts)$/.test(pathname)) return true;
    if (method === 'POST' && pathname === '/console/api/dvr-preview/stop') return true;
    if (['GET', 'HEAD'].includes(method) && /^\/console\/api\/dvr-sdk-preview\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/media\.mp4$/.test(pathname)) return true;
    if (method === 'POST' && pathname === '/console/api/dvr-sdk-preview/stop') return true;
    if (method === 'GET' && /^\/console\/api\/outputs\/[A-Za-z0-9_-]{1,2048}\/(?:stream|thumbnail)$/.test(pathname)) return true;
    if (method === 'POST' && /^\/console\/api\/outputs\/[A-Za-z0-9_-]{1,2048}\/recover-rename$/.test(pathname)) return true;
    if (['PUT', 'DELETE'].includes(method) && /^\/console\/api\/outputs\/[A-Za-z0-9_-]{1,2048}$/.test(pathname)) return true;
    if (method === 'POST' && /^\/console\/api\/outputs\/[A-Za-z0-9_-]{1,2048}\/upload\/(bilibili|cloud189)$/.test(pathname)) return true;
    return false;
  };
  const sameOrigin = req => {
    try { return new URL(req.get('origin') || '').origin === baseOrigin; } catch { return false; }
  };
  const requireSameOrigin = (req, res) => {
    if (sameOrigin(req)) return true;
    res.status(403).json({ success: false, error: '来源校验失败，请从控制台页面发起请求。' });
    return false;
  };
  gateway.use((req, res, next) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    if (oauth && ['GET', 'POST'].includes(req.method) && oauth.paths.has(req.path)) return next();
    if (req.path === '/mcp') return auth(req, res, next);
    if (statusPasswordStore || statusPasswordHash) {
      if (req.method === 'GET' && req.path === '/') return next();
      if (req.method === 'GET' && (['/console.js', '/precision-timeline.js', '/console.css', '/touch-controls.js', '/ui-primitives.js', '/touch-controls.css', '/output-player.js', '/output-download.js', '/playback-coverage.js', '/press-repeat.js', '/replay-controls.js', '/task-presentation.js', '/upload-accounts.js', '/debug-mark.js', '/mediamtx-reader.js', '/mediamtx-live-player.js', '/site-v2.webmanifest', '/console-icon-v2.svg', '/console-icon-v2-192.png', '/console-icon-v2-512.png', '/apple-touch-icon-v2.png'].includes(req.path) || /^\/fonts\/(inter|jetbrains-mono)\.woff2$/.test(req.path))) return next();
      if (req.method === 'GET' && req.path === '/console/api/auth') return next();
      if (req.method === 'POST' && req.path === '/console/api/setup') return requireSameOrigin(req, res) ? next() : undefined;
      if (req.method === 'POST' && ['/status/login', '/status/logout'].includes(req.path)) return requireSameOrigin(req, res) ? next() : undefined;
      if (req.method === 'GET' && req.path === '/api/status/overview') return next();
      if (consolePathAllowed(req)) {
        if (!['GET', 'HEAD'].includes(req.method) && !requireSameOrigin(req, res)) return;
        return requireStatusSession(req, res, () => {
          if (configPathAllowed(req)) {
            const csrf = csrfToken(req);
            if (req.method !== 'GET' && !equal(req.get('x-csrf-token') || '', csrf)) return res.status(403).json({ success: false, error: '安全校验失败，请重新加载配置。' });
            req[CONSOLE_CONFIG_OWNER] = { csrfToken: csrf, sessionId: accountSessionId(req), sessionVersion: sessionVersion(req), isSessionActive: () => statusSessionValid(req) };
          }
          next();
        });
      }
    }
    if (['GET', 'HEAD'].includes(req.method) && isDownloadPath(req.path) &&
        (bearerValid(req.get('authorization'), token) || verifyDownload(req.originalUrl, { token }))) return next();
    return res.status(404).end();
  });
  if (statusPasswordStore || statusPasswordHash) {
    gateway.get('/', (req, res) => res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      .type('html').send(statusDashboardPage(consoleBasePath)));
    gateway.post('/status/login', express.json({ limit: '2kb' }), async (req, res) => {
      const now = Date.now(), key = req.get('cf-connecting-ip') || req.ip || req.socket.remoteAddress || 'unknown';
      for (const [address, record] of loginFailures) if (now - record.startedAt > 15 * 60 * 1000 && now >= record.lockedUntil) loginFailures.delete(address);
      let record = loginFailures.get(key);
      if (record?.lockedUntil > now) return res.set('Retry-After', String(Math.ceil((record.lockedUntil - now) / 1000))).status(429).json({ success: false, error: '尝试次数过多，请稍后再试。' });
      if (!record || now - record.startedAt > 15 * 60 * 1000) record = { count: 0, startedAt: now, lockedUntil: 0 };
      const password = req.body?.password, currentHash = getPasswordHash();
      const match = typeof password === 'string' && password.length <= 128 && /^pbkdf2:210000:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(currentHash);
      let valid = false;
      if (match) {
        const actual = await pbkdf2Async(password, Buffer.from(match[1], 'hex'), STATUS_PASSWORD_ITERATIONS, 32, 'sha256');
        valid = timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
      }
      if (!valid) {
        record.count++;
        if (record.count >= 5) record.lockedUntil = now + 15 * 60 * 1000;
        loginFailures.set(key, record);
        return res.status(record.lockedUntil > now ? 429 : 401).json({ success: false, error: record.lockedUntil > now ? '尝试次数过多，请 15 分钟后再试。' : '密码不正确。' });
      }
      loginFailures.delete(key);
      const expires = String(Math.floor(now / 1000) + statusSessionSeconds), nonce = randomBytes(16).toString('hex');
      res.set('Set-Cookie', `${sessionCookieName}=${expires}.${nonce}.${nonceSessionSignature(expires, nonce, currentHash)}; Path=${sessionCookiePath}; Max-Age=${statusSessionSeconds}; HttpOnly; Secure; SameSite=Strict`)
        .json({ success: true });
    });
    gateway.post('/status/logout', requireStatusSession, async (req, res) => {
      // Revoke BEFORE awaiting cancellation: a request whose body is still
      // arriving must fail its owner recheck instead of starting after logout.
      const cookie = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${sessionCookieName}=`));
      const [expires, nonce, signature] = (cookie?.slice(sessionCookieName.length + 1) || '').split('.');
      if (signature && sessionVersion(req) === 3) revokedSessionNonces.set(nonce, Number(expires));
      for (const [key, expiry] of revokedSessionNonces) if (expiry <= Math.floor(Date.now() / 1000)) revokedSessionNonces.delete(key);
      try { await onSessionEnd?.(accountSessionId(req)); } catch { return res.status(503).json({ success: false, error: '账号连接尚在清理，请重试退出。' }); }
      res.set('Set-Cookie', `${sessionCookieName}=; Path=${sessionCookiePath}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`).status(204).end();
    });
    gateway.post('/console/api/setup', express.json({ limit: '2kb' }), async (req, res) => {
      if (!statusPasswordStore) return res.status(409).json({ success: false, error: '服务器没有配置初始化码存储。' });
      try {
        await statusPasswordStore.initialize(req.body?.code, req.body?.password);
        res.json({ success: true });
      } catch (error) { res.status(400).json({ success: false, error: error.message }); }
    });
    gateway.get('/console/api/events', requireStatusSession, async (req, res) => {
      if (typeof getStatus !== 'function') return res.status(503).end();
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      let closed = false, previous = '', busy = false, lastPing = Date.now();
      const send = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          if (!statusSessionValid(req)) { res.write('event: auth-expired\ndata: {}\n\n'); res.end(); closed = true; return; }
          const data = await getStatus();
          const serialized = JSON.stringify(data);
          if (serialized !== previous) { res.write(`event: update\ndata: ${serialized}\n\n`); previous = serialized; lastPing = Date.now(); }
          else if (Date.now() - lastPing >= 15000) { res.write(': keepalive\n\n'); lastPing = Date.now(); }
        } catch { res.write(': temporary status failure\n\n'); }
        finally { busy = false; }
      };
      await send();
      const timer = setInterval(send, 1500);
      req.on('close', () => { closed = true; clearInterval(timer); });
    });
    gateway.get('/api/status/overview', requireStatusSession, async (req, res) => {
      if (typeof getStatus !== 'function') return res.status(503).json({ success: false, error: '状态数据源尚未配置。' });
      try { res.json({ success: true, ...(await getStatus()) }); }
      catch { res.status(503).json({ success: false, error: '暂时无法读取任务状态。' }); }
    });
  }
  gateway.use((req, res) => app(req, res));
  return gateway;
}

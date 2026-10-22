/** Fixed-protocol child adapter. Credentials and untrusted CLI output never reach HTTP. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import https from 'node:https';

export const MAX_QR_BYTES = 256 * 1024;
export const MAX_CREDENTIAL_BYTES = 256 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
export function validateQrPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 33 && bytes.length <= MAX_QR_BYTES
    && bytes.subarray(0, 8).equals(PNG) && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048
    && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048
    && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
}
function validateCloud189QrPayload(value) {
  // Legacy bare identifiers remain accepted. v0.7.0 currently emits a nested
  // provider login URL; validate that QR destination, not just the image host.
  if (/^[A-Za-z0-9_-]{1,512}$/.test(value)) return true;
  if (value.length > 512 || /[\x00-\x20\x7f]/.test(value)
    || !value.startsWith('https://open.e.189.cn/api/account/qrClinentLogin.do?')) return false;
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'open.e.189.cn' || url.port || url.username || url.password || url.hash
    || url.pathname !== '/api/account/qrClinentLogin.do') return false;
  const entries = [...url.searchParams];
  return entries.length === 1 && entries[0][0] === 'paras'
    && /^new_uuid=[A-Za-z0-9_-]{1,128}\|9317140619$/.test(entries[0][1]);
}
export function validateCloud189QrUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'open.e.189.cn' || url.port || url.username || url.password || url.hash
    || url.pathname !== '/api/logbox/oauth2/image.do') return null;
  const entries = [...url.searchParams];
  if (entries.length !== 2 || new Set(entries.map(([k]) => k)).size !== 2
    || !entries.every(([key, val]) => key === 'REQID' ? /^[A-Za-z0-9_-]{1,512}$/.test(val)
      : key === 'uuid' && validateCloud189QrPayload(val))) return null;
  // No URL canonicalization tricks, encoded host/path, or extra query fields.
  if (!value.startsWith('https://open.e.189.cn/api/logbox/oauth2/image.do?')) return null;
  return url.href;
}
export function fetchCloud189Qr(value, { signal, request = https.request } = {}) {
  const url = validateCloud189QrUrl(value);
  if (!url) return Promise.reject(new Error('INVALID_QR'));
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, headers: { Accept: 'image/png' } }, res => {
      // The provider currently labels its PNG bytes image/jpeg. Allow that
      // declared type only; byte-level PNG validation below still rejects JPEG.
      // Never follow redirects, even to another URL at the same provider.
      if (res.statusCode !== 200 || !/^image\/(?:png|jpeg)(?:;|$)/i.test(res.headers['content-type'] || '')
        || (res.headers['content-length'] && (!/^\d+$/.test(res.headers['content-length']) || Number(res.headers['content-length']) > MAX_QR_BYTES))) {
        res.destroy(); reject(new Error('INVALID_QR')); return;
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_QR_BYTES) { res.destroy(); reject(new Error('INVALID_QR')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('INVALID_QR')));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (!validateQrPng(bytes)) return reject(new Error('INVALID_QR'));
        resolve(bytes);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('QR_TIMEOUT')), 8000);
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => { clearTimeout(timer); reject(new Error('QR_UNAVAILABLE')); });
    req.end();
  });
}
export function readPrivateFile(file, max = MAX_CREDENTIAL_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || (stat.mode & 0o077)) throw new Error('INVALID_PRIVATE_FILE');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function validateCredentials(provider, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_CREDENTIAL_BYTES) throw new Error('INVALID_CREDENTIALS');
  const value = JSON.parse(bytes.toString('utf8'));
  const str = v => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x1f\x7f]/.test(v);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CREDENTIALS');
  if (provider === 'bilibili') {
    const token = value.token_info, cookies = value.cookie_info?.cookies;
    if (!token || !str(token.access_token) || !str(token.refresh_token) || !Number.isSafeInteger(token.mid) || token.mid <= 0
      || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 10 * 365 * 86400
      || !Array.isArray(cookies) || cookies.length > 100
      || !cookies.every(c => c && /^[A-Za-z0-9_-]{1,100}$/.test(c.name) && str(c.value) && !/[;\r\n]/.test(c.value))
      || !['SESSDATA', 'bili_jct'].every(name => cookies.filter(c => c.name === name).length === 1)) throw new Error('INVALID_CREDENTIALS');
  } else if (provider === 'cloud189') {
    // Fresh QR is token-only. Reject password-bearing legacy configurations entirely.
    if (Object.hasOwn(value, 'user') || Object.hasOwn(value, 'User') || !value.session || !str(value.session.sessionKey)
      || !str(value.session.sessionSecret) || value.session.sessionSecret.length < 16
      || !str(value.session.accessToken) || !str(value.session.refreshToken)) throw new Error('INVALID_CREDENTIALS');
  } else throw new Error('INVALID_PROVIDER');
  return value;
}
export function launchUploadAccountAdapter({ provider, mode, binary, stageDir, credentialFile, lockFile, onEvent,
  python = '/usr/bin/python3', spawnProcess = spawn }) {
  const helper = fileURLToPath(new URL('../scripts/upload-account-adapter.py', import.meta.url));
  const child = spawnProcess(python, ['-I', helper, provider, mode, binary, stageDir, credentialFile, lockFile], {
    cwd: stageDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    // Explicit allowlist; no inherited debug flags, application credentials, or auth state.
    env: { PATH: '/usr/bin:/bin', HOME: stageDir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm' },
  });
  let pending = '', outputBytes = 0, stopping, exited = false;
  const closed = new Promise(resolve => { child.once('close', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  const signalGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (groupAlive()) {
        signalGroup('SIGTERM');
        // A detached descendant can keep the group and flock alive after the
        // helper leader closes its pipes. Its close event is NOT group exit.
        await new Promise(resolve => {
          const deadline = setTimeout(() => { signalGroup('SIGKILL'); clearInterval(poll); resolve(); }, 1500);
          const poll = setInterval(() => {
            if (!groupAlive()) { clearTimeout(deadline); clearInterval(poll); resolve(); }
          }, 25);
        });
      }
      await closed;
    })();
    return stopping;
  };
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {}); // Never forward stderr, including Python diagnostics.
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 64 * 1024) { void stop(); return; }
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event?.type === 'locked') onEvent({ type: 'locked' });
        else if (event?.type === 'qr' && event.source === 'file' && provider === 'bilibili') onEvent({ type: 'qr', source: 'file' });
        else if (event?.type === 'qr' && event.source === 'url' && provider === 'cloud189' && validateCloud189QrUrl(event.url)) onEvent({ type: 'qr', source: 'url', url: event.url });
        else if (event?.type === 'state' && ['waiting_scan', 'waiting_confirmation', 'verifying'].includes(event.state)) onEvent({ type: 'state', state: event.state });
        else if (event?.type === 'result' && typeof event.ok === 'boolean') onEvent({ type: 'result', ok: event.ok,
          code: ['PROVIDER_BUSY', 'NEEDS_LOGIN', 'VERIFY_FAILED', 'LOGIN_FAILED', 'ADAPTER_UNAVAILABLE'].includes(event.code) ? event.code : null });
      } catch { /* Protocol errors are private and fail closed when the child exits. */ }
    }
  });
  return { closed, stop, begin: () => child.stdin.write('go\n'), release: () => child.stdin.end('release\n'),
    killNow: () => signalGroup('SIGKILL') };
}

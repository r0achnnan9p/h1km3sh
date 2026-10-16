import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createUploadAccountManager, mountUploadAccounts, UPLOAD_ACCOUNT_TTL_MS } from '../lib/upload-accounts.js';
import { fetchCloud189Qr, validateCloud189QrUrl, validateCredentials, validateQrPng, launchUploadAccountAdapter } from '../lib/upload-account-adapter.js';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
import { consoleConfigJsonError } from '../lib/console-config.js';

const OWNER = { sessionId: 'a'.repeat(64), csrfToken: 'csrf', isSessionActive: () => true };
const OTHER = { ...OWNER, sessionId: 'b'.repeat(64) };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1d8AAAAASUVORK5CYII=', 'base64');
const credentials = provider => provider === 'bilibili' ? { cookie_info: { cookies: [{ name: 'SESSDATA', value: 'secret-session' }, { name: 'bili_jct', value: 'secret-csrf' }] }, token_info: { access_token: 'secret-access', refresh_token: 'secret-refresh', mid: 12345, expires_in: 3600 }, sso: [], platform: 'BiliTV' }
  : { session: { sessionKey: 'secret-key', sessionSecret: '1234567890123456', accessToken: 'secret-access', refreshToken: 'secret-refresh' } };
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(fn, timeout = 3000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('test timeout'); await turn(); } }
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-account-test-')), root = path.join(directory, 'private', 'upload-accounts');
  const configs = Object.fromEntries(['bilibili', 'cloud189'].map(provider => [provider, { enabled: true, binary: '/fake/pinned-cli', credentialFile: path.join(root, `${provider}.json`), lockFile: path.join(directory, provider, 'provider.lock') }]));
  const launches = [];
  const launch = ctx => {
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    const handle = { ...ctx, closed, stopped: false, began: false, released: false,
      stop: async () => { handle.stopped = true; close(); }, release: () => { handle.released = true; }, begin: () => { handle.began = true; },
      emit: event => ctx.onEvent(event), killNow: () => close() };
    launches.push(handle); return handle;
  };
  const manager = createUploadAccountManager({ root, providers: configs, available: () => true, launch, pollMs: 5, ...options });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, configs, launches, manager };
}
async function succeed(handle, provider) {
  handle.emit({ type: 'locked' }); await turn();
  fs.writeFileSync(handle.credentialFile, JSON.stringify(credentials(provider)), { mode: 0o600 });
  handle.emit({ type: 'result', ok: true }); await turn();
}

test('QR links are exact-origin, exact-path, bounded and never arbitrary fetches', async () => {
  const good = 'https://open.e.189.cn/api/logbox/oauth2/image.do?REQID=abc-123&uuid=xyz_456';
  assert.equal(validateCloud189QrUrl(good), good);
  for (const url of [good.replace('https:', 'http:'), good.replace('open.e.189.cn', 'evil.example'), good.replace('open.e.189.cn', 'open.e.189.cn.evil'), good.replace('open.e.189.cn', 'user@open.e.189.cn'), good.replace('image.do', 'other'), good + '&uuid=x', good + '&target=x', good + '#x', good.replace('REQID=abc-123', 'REQID=http%3A%2F%2F127.0.0.1'), good.replace('open.e.189.cn', 'open.e.189.cn:8443')]) assert.equal(validateCloud189QrUrl(url), null);
  let called = false;
  await assert.rejects(fetchCloud189Qr('http://127.0.0.1/private', { request: () => { called = true; } }));
  assert.equal(called, false);
  assert.equal(validateQrPng(png), true);
  assert.equal(validateQrPng(png.subarray(0, 33)), false);
  assert.equal(validateQrPng(Buffer.from('<svg onload="alert(1)">')), false);
});

test('credential validation rejects passwords, missing tokens, forged cookie structures', () => {
  for (const provider of ['bilibili', 'cloud189']) assert.ok(validateCredentials(provider, Buffer.from(JSON.stringify(credentials(provider)))));
  for (const value of [{ ...credentials('cloud189'), user: { name: 'x', password: 'password' } }, { ...credentials('cloud189'), user: {} }, { session: { sessionKey: 'key', sessionSecret: 'too-short' } }]) assert.throws(() => validateCredentials('cloud189', Buffer.from(JSON.stringify(value))));
  const invalid = credentials('bilibili'); invalid.cookie_info.cookies[0].value = 'bad;other=secret';
  assert.throws(() => validateCredentials('bilibili', Buffer.from(JSON.stringify(invalid))));
});

test('successful login is private, atomic and session-bound, with one attempt per provider', async t => {
  const { manager, launches, configs, root } = fixture(t);
  const first = await manager.start('bilibili', OWNER), handle = launches[0];
  assert.equal(first.state, 'waiting_scan'); assert.equal(first.attempt.qrReady, false);
  await assert.rejects(manager.start('bilibili', OTHER), { code: 'PROVIDER_BUSY' });
  assert.equal(manager.list(OTHER)[0].attempt, null);
  assert.throws(() => manager.status('bilibili', OTHER, first.attempt.id), { code: 'ATTEMPT_NOT_FOUND' });
  handle.emit({ type: 'locked' }); await turn();
  fs.writeFileSync(path.join(handle.stageDir, 'qrcode.png'), png, { mode: 0o600 });
  handle.emit({ type: 'qr', source: 'file' }); await turn();
  assert.deepEqual(manager.qr('bilibili', OWNER, first.attempt.id), png);
  fs.writeFileSync(handle.credentialFile, JSON.stringify(credentials('bilibili')), { mode: 0o600 });
  handle.emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.status('bilibili', OWNER, first.attempt.id).state, 'connected');
  assert.equal(handle.stopped, true); assert.equal(handle.released, true);
  assert.equal(fs.existsSync(handle.stageDir), false);
  assert.equal(fs.statSync(configs.bilibili.credentialFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const response = JSON.stringify(manager.list(OWNER));
  for (const secret of ['secret', 'SESSDATA', 'token_info', root, 'qrcode.png']) assert.ok(!response.includes(secret));
  assert.throws(() => manager.qr('bilibili', OWNER, first.attempt.id), { status: 410 });
});

test('cancel and 300-second timeout prevent stale success from replacing credentials', async t => {
  let now = 1_800_000_000_000;
  const { manager, launches, configs } = fixture(t, { now: () => now });
  const first = await manager.start('cloud189', OWNER), stale = launches[0];
  assert.equal(Date.parse(first.attempt.expiresAt) - now, UPLOAD_ACCOUNT_TTL_MS);
  await manager.cancel('cloud189', OWNER, first.attempt.id);
  stale.emit({ type: 'result', ok: true }); await turn();
  assert.equal(fs.existsSync(configs.cloud189.credentialFile), false);
  const second = await manager.start('cloud189', OWNER), current = launches[1];
  assert.notEqual(second.attempt.id, first.attempt.id);
  stale.emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.status('cloud189', OWNER, second.attempt.id).state, 'waiting_scan');
  now += UPLOAD_ACCOUNT_TTL_MS;
  await until(() => manager.status('cloud189', OWNER, second.attempt.id).state === 'expired');
  assert.equal(current.stopped, true);
  assert.equal(fs.existsSync(current.stageDir), false);
});

test('old credential stays intact on failed replacement; explicit consent required', async t => {
  const { manager, launches, configs } = fixture(t);
  await manager.start('cloud189', OWNER); await succeed(launches[0], 'cloud189');
  const previous = fs.readFileSync(configs.cloud189.credentialFile);
  await assert.rejects(manager.start('cloud189', OWNER), { code: 'REPLACE_CONFIRMATION_REQUIRED' });
  await manager.start('cloud189', OWNER, { replace: true });
  launches[1].emit({ type: 'result', ok: false, code: 'LOGIN_FAILED' }); await turn();
  assert.deepEqual(fs.readFileSync(configs.cloud189.credentialFile), previous);
});

test('verification copies credentials only after flock, refresh is atomic and disconnect is scoped', async t => {
  const { manager, launches, configs, directory } = fixture(t);
  await manager.start('cloud189', OWNER); await succeed(launches[0], 'cloud189');
  const verify = await manager.verify('cloud189', OWNER), handle = launches[1];
  assert.equal(verify.state, 'verifying'); assert.equal(fs.existsSync(handle.credentialFile), false);
  handle.emit({ type: 'locked' }); await turn();
  assert.equal(handle.began, true);
  const refreshed = credentials('cloud189'); refreshed.session.accessToken = 'new-private-token';
  fs.writeFileSync(handle.credentialFile, JSON.stringify(refreshed));
  handle.emit({ type: 'result', ok: true }); await turn();
  assert.equal(JSON.parse(fs.readFileSync(configs.cloud189.credentialFile)).session.accessToken, 'new-private-token');
  const video = path.join(directory, 'keep.mp4'); fs.writeFileSync(video, 'video');
  const disconnected = await manager.disconnect('cloud189', OWNER); launches[2].emit({ type: 'locked' }); await turn();
  launches[2].emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.status('cloud189', OWNER, disconnected.attempt.id).state, 'disconnected');
  assert.equal(fs.existsSync(configs.cloud189.credentialFile), false); assert.equal(fs.readFileSync(video, 'utf8'), 'video');
});

test('preparation, recovery, revoked sessions and unavailable capabilities fail closed', async t => {
  for (const [option, code] of [[{ preparationOnly: () => true }, 'PREPARATION_ONLY'], [{ canWrite: () => false }, 'RECOVERY_BLOCKED'], [{ available: () => false }, 'PROVIDER_UNAVAILABLE']]) {
    const { manager, launches } = fixture(t, option); await assert.rejects(manager.start('bilibili', OWNER), { code }); assert.equal(launches.length, 0);
  }
  let active = true;
  const owner = { ...OWNER, isSessionActive: () => active };
  const { manager, launches } = fixture(t);
  await manager.start('bilibili', owner); active = false;
  await until(() => launches[0].stopped);
  assert.equal(fs.existsSync(launches[0].stageDir), false);
});

test('symlink credentials and invalid QR cannot be promoted', async t => {
  const { manager, launches, configs, directory } = fixture(t);
  await manager.start('bilibili', OWNER); const handle = launches[0];
  const outside = path.join(directory, 'outside'); fs.writeFileSync(outside, JSON.stringify(credentials('bilibili')), { mode: 0o600 });
  fs.symlinkSync(outside, handle.credentialFile);
  handle.emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.list(OWNER)[0].state, 'error'); assert.equal(fs.existsSync(configs.bilibili.credentialFile), false);
  await manager.start('bilibili', OWNER); const second = launches[1];
  fs.writeFileSync(path.join(second.stageDir, 'qrcode.png'), '<svg>bad</svg>', { mode: 0o600 });
  second.emit({ type: 'qr', source: 'file' }); await turn(); assert.equal(manager.list(OWNER)[0].state, 'error');
});

test('gateway applies owner, Origin, CSRF, endpoint allowlist and session logout cleanup', async t => {
  const { manager } = fixture(t);
  const app = express(); app.use(express.json({ limit: '2kb' })); app.use(consoleConfigJsonError); mountUploadAccounts(app, { manager });
  const origin = 'https://owner.example';
  const gateway = createPublicGateway(app, { token: 'test-token-abcdefghijklmnopqrstuvwxyz', baseUrl: origin, statusPasswordHash: createStatusPasswordHash('test-password'), onSessionEnd: id => manager.cancelSession(id) });
  const server = gateway.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = '/console/api/upload-accounts';
  assert.equal((await fetch(base + endpoint)).status, 401);
  const login = await fetch(base + '/status/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const listing = await (await fetch(base + endpoint, { headers: { cookie } })).json();
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': listing.csrfToken };
  const post = (suffix, extra = {}, body = '{}') => fetch(base + endpoint + suffix, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post('/bilibili/start', { 'x-csrf-token': '' })).status, 403);
  assert.equal((await post('/bilibili/start', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/bilibili/start', {}, '{"password":"must-not-be-echoed"}')).status, 400);
  const invalid = await post('/bilibili/start', {}, '{"secret":"private-unclosed');
  assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes('private-unclosed'));
  for (const route of ['/evil/start', '/bilibili/shell', '/bilibili/token']) assert.equal((await post(route)).status, 404);
  const start = await post('/bilibili/start'); assert.equal(start.status, 200);
  const { account } = await start.json();
  const status = await fetch(base + endpoint + '/bilibili/status?attemptId=' + account.attempt.id, { headers: { cookie } });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/status/logout', { method: 'POST', headers: { cookie, origin } })).status, 204);
  assert.equal((await fetch(base + endpoint + '/bilibili/status?attemptId=' + account.attempt.id, { headers: { cookie } })).status, 401);
  const direct = app.listen(0, '127.0.0.1'); await new Promise(resolve => direct.once('listening', resolve));
  t.after(() => { direct.closeAllConnections(); direct.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${direct.address().port}` + endpoint, { headers: { cookie } })).status, 401);
});

test('real Python wrapper executes only a local fake cloud CLI with private fresh config and sanitized output', async t => {
  let qrFetched = false;
  const { manager, directory, configs, root } = fixture(t, { launch: launchUploadAccountAdapter, fetchQr: async url => {
    assert.equal(new URL(new URL(url).searchParams.get('uuid')).searchParams.get('paras'), 'new_uuid=SYNTHETIC_ONLY|9317140619');
    qrFetched = true; return png;
  } });
  const binary = path.join(directory, 'fake-cloud189'); configs.cloud189.binary = binary;
  fs.writeFileSync(binary, '#!/usr/bin/python3\nimport os,json,sys\nassert "189_MODE" not in os.environ\nassert sys.argv[1] == "--config" and sys.argv[3] == "qrlogin"\nassert json.load(open(sys.argv[2])) == {}\nassert os.stat(sys.argv[2]).st_mode & 0o777 == 0o600\nprint("RAW_SECRET_DO_NOT_EXPOSE", file=sys.stderr, flush=True)\nprint("https://open.e.189.cn/api/logbox/oauth2/image.do?REQID=abc&uuid=https%3A%2F%2Fopen.e.189.cn%2Fapi%2Faccount%2FqrClinentLogin.do%3Fparas%3Dnew_uuid%253DSYNTHETIC_ONLY%257C9317140619", file=sys.stderr, flush=True)\njson.dump(' + JSON.stringify(credentials('cloud189')) + ',open(sys.argv[2],"w"))\n', { mode: 0o700 });
  const started = await manager.start('cloud189', OWNER);
  await until(() => manager.status('cloud189', OWNER, started.attempt.id).state === 'connected');
  assert.equal(fs.existsSync(configs.cloud189.credentialFile), true);
  await until(() => fs.readdirSync(path.join(root, 'attempts')).length === 0);
  assert.equal(qrFetched, true);
  assert.ok(!JSON.stringify(manager.list(OWNER)).includes('RAW_SECRET'));
});

test('PTY wrapper selects QR menu once and controls a fake bili CLI without invoking real auth', async t => {
  const { manager, directory, configs } = fixture(t, { launch: launchUploadAccountAdapter });
  const binary = path.join(directory, 'fake-biliup'); configs.bilibili.binary = binary;
  fs.writeFileSync(binary, '#!/usr/bin/python3\nimport os,json,sys,base64\nassert sys.argv[1] == "-u" and sys.argv[3:] == ["--rust-log","error","login"]\nassert os.isatty(0)\nprint("选择一种登录方式 账号密码 短信登录 扫码登录",flush=True)\nanswer=os.read(0,16)\nassert answer in (b"\\x1b[B\\n", b"\\x1b[B\\r")\nopen("qrcode.png","wb").write(base64.b64decode("' + png.toString('base64') + '"))\njson.dump(' + JSON.stringify(credentials('bilibili')) + ',open(sys.argv[2],"w"))\n', { mode: 0o700 });
  const started = await manager.start('bilibili', OWNER);
  await until(() => manager.status('bilibili', OWNER, started.attempt.id).state === 'connected');
  assert.equal(fs.existsSync(configs.bilibili.credentialFile), true);
});

test('same-second v3 logins isolate attempts; legacy v2 console still works but cannot link', async t => {
  const { createHash, createHmac } = await import('node:crypto');
  const { manager } = fixture(t);
  const app = express(); app.use(express.json()); mountUploadAccounts(app, { manager });
  app.get('/console/api/bootstrap', (_req, res) => res.json({ success: true }));
  const origin = 'https://owner.example', token = 'test-token-abcdefghijklmnopqrstuvwxyz', hash = createStatusPasswordHash('test-password');
  const issuedAt = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => issuedAt);
  const server = createPublicGateway(app, { token, baseUrl: origin, statusPasswordHash: hash }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = '/console/api/upload-accounts';
  const login = async () => (await fetch(base + '/status/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) })).headers.get('set-cookie').split(';')[0];
  const first = await login(), second = await login(); assert.notEqual(first, second);
  const firstValue = first.split('=')[1].split('.'), secondValue = second.split('=')[1].split('.');
  assert.equal(firstValue[0], secondValue[0]); assert.notEqual(firstValue[1], secondValue[1]); assert.match(firstValue[1], /^[a-f0-9]{32}$/);
  const listing = await (await fetch(base + endpoint, { headers: { cookie: first } })).json(); assert.equal(listing.reauthRequired, false);
  const started = await (await fetch(base + endpoint + '/bilibili/start', { method: 'POST', headers: { origin, cookie: first, 'x-csrf-token': listing.csrfToken, 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal((await fetch(base + endpoint + '/bilibili/status?attemptId=' + started.account.attempt.id, { headers: { cookie: second } })).status, 404);
  const expires = String(issuedAt / 1000 + 2592000);
  const signature = createHmac('sha256', createHash('sha256').update(`${token}\n${hash}`).digest()).update(`status-v2\n${expires}\n2592000\n`).digest('hex');
  const legacy = `hikclip_status=${expires}.${signature}`;
  const ordinary = await fetch(base + '/console/api/bootstrap', { headers: { cookie: legacy } }); assert.equal(ordinary.status, 200); assert.equal(ordinary.headers.get('set-cookie'), null);
  const oldListing = await (await fetch(base + endpoint, { headers: { cookie: legacy } })).json(); assert.equal(oldListing.reauthRequired, true);
  for (const action of ['start', 'verify', 'disconnect']) {
    const blocked = await fetch(base + endpoint + '/cloud189/' + action, { method: 'POST', headers: { origin, cookie: legacy, 'x-csrf-token': oldListing.csrfToken, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403); assert.equal((await blocked.json()).errorCode, 'SESSION_REAUTH_REQUIRED');
  }
  for (const value of [`${first}.extra`, `hikclip_status=${firstValue[0]}.${firstValue[2]}`, `hikclip_status=${firstValue[0]}.${'0'.repeat(32)}.${firstValue[2]}`, `hikclip_status=${firstValue[0]}..${firstValue[2]}`]) assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { cookie: value } })).status, 401);
});

test('slow admitted account, settings and cover writes cannot commit after logout', async t => {
  const http = await import('node:http');
  const { createUploadSettingsStore, mountUploadSettings } = await import('../lib/console-upload-settings.js');
  const { createUploadCoverStore, mountUploadCover } = await import('../lib/upload-cover.js');
  const { manager, launches, directory } = fixture(t);
  const settings = createUploadSettingsStore(path.join(directory, 'settings.json'));
  const cover = createUploadCoverStore(path.join(directory, 'cover'), { fallbackFile: '' });
  let admitted;
  const app = express(); app.use((req, res, next) => { if (admitted && ['POST', 'PUT'].includes(req.method)) admitted(); next(); });
  app.use(express.json()); mountUploadAccounts(app, { manager }); mountUploadSettings(app, { store: settings, integrations: () => ({}) }); mountUploadCover(app, { store: cover });
  const origin = 'https://owner.example';
  const server = createPublicGateway(app, { token: 'test-token-abcdefghijklmnopqrstuvwxyz', baseUrl: origin, statusPasswordHash: createStatusPasswordHash('test-password'), onSessionEnd: id => manager.cancelSession(id) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [route, method, type, body] of [
    ['/console/api/upload-accounts/bilibili/start', 'POST', 'application/json', Buffer.from('{}')],
    ['/console/api/settings', 'PUT', 'application/json', Buffer.from('{"managedEnabled":true,"cloud189Enabled":true}')],
    ['/console/api/settings/bilibili-cover', 'PUT', 'image/png', png],
  ]) {
    const login = await fetch(base + '/status/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"password":"test-password"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await (await fetch(base + '/console/api/upload-accounts', { headers: { cookie } })).json();
    const arrived = new Promise(resolve => { admitted = resolve; });
    let done;
    const response = new Promise(resolve => { done = resolve; });
    const req = http.request(base + route, { method, headers: { origin, cookie, 'x-csrf-token': csrfToken, 'content-type': type, 'content-length': body.length } }, res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.write(body.subarray(0, 1)); await arrived; admitted = null;
    assert.equal((await fetch(base + '/status/logout', { method: 'POST', headers: { origin, cookie } })).status, 204);
    req.end(body.subarray(1)); assert.equal(await response, 401, route);
  }
  assert.equal(launches.length, 0); assert.equal(settings.read().managedEnabled, true); assert.equal(cover.status().present, false);
});

test('an owner revoked while waiting for prior cleanup cannot start a replacement', async t => {
  let active = true;
  const owner = { ...OWNER, isSessionActive: () => active };
  const { manager, launches } = fixture(t);
  await manager.start('bilibili', owner);
  const originalStop = launches[0].stop; let release;
  const stopping = new Promise(resolve => { release = resolve; });
  launches[0].stop = async () => { await stopping; await originalStop(); };
  const cancel = manager.cancelSession(owner.sessionId);
  const replacement = manager.start('bilibili', owner);
  await turn(); active = false; release(); await cancel;
  await assert.rejects(replacement, { code: 'SESSION_REQUIRED' }); assert.equal(launches.length, 1);
});

test('each QR binding gets a new generation; refresh preserves it and failed replacement cannot invalidate it', async t => {
  const notifications = [];
  const { manager, launches } = fixture(t, { onAccountChange: (provider, change) => notifications.push([provider, change.mode, change.phase]) });
  await manager.start('cloud189', OWNER); await succeed(launches[0], 'cloud189');
  const first = manager.connectionGeneration('cloud189'); assert.match(first, /^[a-f0-9]{32}$/);
  await manager.verify('cloud189', OWNER); await succeed(launches[1], 'cloud189');
  assert.equal(manager.connectionGeneration('cloud189'), first);
  await manager.start('cloud189', OWNER, { replace: true });
  launches[2].emit({ type: 'locked' }); await turn(); fs.writeFileSync(launches[2].credentialFile, '{}'); launches[2].emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.connectionGeneration('cloud189'), first);
  await manager.start('cloud189', OWNER, { replace: true }); await succeed(launches[3], 'cloud189');
  assert.notEqual(manager.connectionGeneration('cloud189'), first);
  assert.deepEqual(notifications[0], ['cloud189', 'login', 'before_commit']);
  assert.ok(!notifications.some(([, mode, phase]) => mode === 'verify' && phase === 'before_commit'));
  await manager.disconnect('cloud189', OWNER); launches[4].emit({ type: 'locked' }); await turn(); launches[4].emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.connectionGeneration('cloud189'), null);
});

test('connection replacement quarantines pending jobs and interrupted promotion leaves no old eligible generation', async t => {
  const { manager, launches, root, configs } = fixture(t);
  await manager.start('cloud189', OWNER); await succeed(launches[0], 'cloud189');
  const oldGeneration = manager.connectionGeneration('cloud189');
  const jobs = path.join(path.dirname(configs.cloud189.lockFile), 'jobs'); fs.mkdirSync(jobs, { mode: 0o700 });
  const jobFile = path.join(jobs, '00000000-0000-4000-8000-000000000001.json');
  fs.writeFileSync(jobFile, JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', status: 'queued', connectionGeneration: oldGeneration }), { mode: 0o600 });
  await manager.start('cloud189', OWNER, { replace: true });
  const handle = launches[1]; handle.emit({ type: 'locked' }); await turn();
  const next = credentials('cloud189'); next.session.accessToken = 'new-account-token';
  fs.writeFileSync(handle.credentialFile, JSON.stringify(next));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, 'cloud189.connection.json') && JSON.parse(fs.readFileSync(from)).generation !== null) throw new Error('simulated failure after credential promotion');
    return rename(from, to);
  });
  handle.emit({ type: 'result', ok: true }); await turn();
  assert.equal(manager.connectionGeneration('cloud189'), null);
  assert.equal(JSON.parse(fs.readFileSync(configs.cloud189.credentialFile)).session.accessToken, 'new-account-token');
  const old = JSON.parse(fs.readFileSync(jobFile)); assert.equal(old.errorCode, 'ACCOUNT_CHANGED'); assert.equal(old.status, 'error'); assert.equal(old.connectionGeneration, oldGeneration);
  assert.match(old.message, /重新确认并提交/);
});

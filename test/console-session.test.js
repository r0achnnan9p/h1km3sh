import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createPublicGateway, createStatusPasswordHash, readStatusSessionSeconds } from '../lib/mcp-security.js';
import { createStatusPasswordStore } from '../lib/status-password-store.js';
import { CONSOLE_CONFIG_OWNER } from '../lib/console-config.js';

const token = 'test-only-console-session-token-1234567890123456';
const origin = 'https://session.example';
const basePath = '/h1km3sh';
const password = 'test-only-password';
const thirtyDays = 30 * 24 * 60 * 60;
const passwordHash = createStatusPasswordHash(password);

async function listen(options = {}) {
  const app = express();
  app.get('/console/api/bootstrap', (_req, res) => res.json({ ok: true }));
  app.get('/console/api/config', (req, res) => res.json(req[CONSOLE_CONFIG_OWNER]));
  app.put('/console/api/settings', (_req, res) => res.json({ ok: true }));
  const server = createPublicGateway(app, {
    token, baseUrl: origin + basePath, statusPasswordHash: passwordHash,
    getStatus: () => ({ tasks: [] }), ...options,
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    fetch: (route, options) => fetch(base + route, options),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function login(server) {
  const response = await server.fetch('/status/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  return { setCookie, cookie: setCookie.split(';', 1)[0] };
}

test('console session duration defaults to 30 days and is bounded to 1–720 integer hours', () => {
  assert.equal(readStatusSessionSeconds({}), thirtyDays);
  assert.equal(readStatusSessionSeconds({ HIKCLIP_STATUS_SESSION_HOURS: '' }), thirtyDays);
  for (const hours of [1, 12, 720]) assert.equal(readStatusSessionSeconds({ HIKCLIP_STATUS_SESSION_HOURS: String(hours) }), hours * 3600);
  for (const hours of ['0', '-1', '721', 'Infinity', '1.5', ' 12', '1e2', '0x10', '00', 'false', '999999999999999999999999']) {
    assert.throws(() => readStatusSessionSeconds({ HIKCLIP_STATUS_SESSION_HOURS: hours }), /1–720/);
  }
  for (const statusSessionSeconds of [0, 3599, thirtyDays + 1, Infinity, NaN, '3600', 3600.5]) {
    assert.throws(() => createPublicGateway(express(), { token, baseUrl: origin, statusSessionSeconds }), /1 小时到 30 天/);
  }
});

test('remembered cookie expires exactly 30 days after login, never slides, and retains CSRF protection', async t => {
  const issuedAt = 1_800_000_000_000;
  let now = issuedAt;
  t.mock.method(Date, 'now', () => now);
  const server = await listen();
  try {
    const { setCookie, cookie } = await login(server);
    assert.match(setCookie, /Path=\/h1km3sh; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(Number(cookie.split('=')[1].split('.')[0]), issuedAt / 1000 + thirtyDays);
    const headers = { Cookie: cookie };
    const config = await (await server.fetch('/console/api/config', { headers })).json();
    assert.match(config.csrfToken, /^[a-f0-9]{64}$/);
    assert.equal((await server.fetch('/console/api/settings', { method: 'PUT', headers: { ...headers, Origin: origin } })).status, 403);
    assert.equal((await server.fetch('/console/api/settings', { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example', 'x-csrf-token': config.csrfToken } })).status, 403);
    now += 12 * 60 * 60 * 1000 + 1000;
    const afterTwelveHours = await server.fetch('/console/api/bootstrap', { headers });
    assert.equal(afterTwelveHours.status, 200);
    assert.equal(afterTwelveHours.headers.get('set-cookie'), null);
    now = issuedAt + thirtyDays * 1000 - 1000;
    const stillValid = await server.fetch('/console/api/config', { headers });
    assert.equal(stillValid.status, 200);
    assert.equal((await stillValid.json()).csrfToken, config.csrfToken);
    assert.equal(stillValid.headers.get('set-cookie'), null);
    assert.equal((await server.fetch('/console/api/settings', { method: 'PUT', headers: { ...headers, Origin: origin, 'x-csrf-token': config.csrfToken } })).status, 200);
    now += 1000;
    assert.equal((await server.fetch('/console/api/bootstrap', { headers })).status, 401);
    assert.equal((await server.fetch('/console/api/config', { headers })).status, 401);
  } finally { await server.close(); }
});

test('shorter configured sessions expire at the configured absolute deadline', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const server = await listen({ statusSessionSeconds: readStatusSessionSeconds({ HIKCLIP_STATUS_SESSION_HOURS: '1' }) });
  try {
    const { setCookie, cookie } = await login(server);
    assert.match(setCookie, /Max-Age=3600;/);
    now += 3_599_000;
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 200);
    now += 1000;
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 401);
  } finally { await server.close(); }
});

test('remembered sessions reject malformed, tampered and overlong signed cookies', async () => {
  const server = await listen();
  try {
    const { cookie } = await login(server);
    const [name, value] = cookie.split('=');
    const [expires, signature] = value.split('.');
    const tooLate = String(Math.floor(Date.now() / 1000) + thirtyDays + 120);
    const excessiveSignature = createHmac('sha256', createHash('sha256').update(`${token}\n${passwordHash}`).digest())
      .update(`status-v2\n${tooLate}\n${thirtyDays}\n${basePath}`).digest('hex');
    for (const Cookie of ['', `${cookie}.extra`, `${name}=${Number(expires) + 1}.${signature}`, `${name}=${expires}.${'0'.repeat(64)}`, `${name}=${tooLate}.${excessiveSignature}`]) {
      assert.equal((await server.fetch('/console/api/bootstrap', { headers: { Cookie } })).status, 401);
    }
  } finally { await server.close(); }
});

test('environment-managed remembered session survives a new gateway and store; secret rotation revokes it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-session-restart-'));
  const filePath = path.join(root, 'absent-auth.json');
  const options = secret => ({ token: secret, statusPasswordStore: createStatusPasswordStore({ filePath, loginPassword: password, sessionSecret: secret }) });
  let server;
  try {
    server = await listen(options(token));
    const { cookie } = await login(server);
    const headers = { Cookie: cookie };
    const initialConfig = await (await server.fetch('/console/api/config', { headers })).json();
    await server.close();
    server = await listen(options(token));
    assert.equal((await server.fetch('/console/api/bootstrap', { headers })).status, 200);
    assert.equal((await (await server.fetch('/console/api/config', { headers })).json()).csrfToken, initialConfig.csrfToken);
    const logout = await server.fetch('/status/logout', { method: 'POST', headers: { ...headers, Origin: origin } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Path=\/h1km3sh; Max-Age=0; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal((await server.fetch('/console/api/bootstrap')).status, 401);
    await server.close();
    server = await listen(options(token + '-rotated'));
    assert.equal((await server.fetch('/console/api/bootstrap', { headers })).status, 401);
    assert.equal(fs.existsSync(filePath), false);
  } finally { if (server) await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('reducing session lifetime never resurrects an older longer-lived cookie near its original expiry', async t => {
  const issuedAt = 1_800_000_000_000;
  let now = issuedAt;
  t.mock.method(Date, 'now', () => now);
  let server = await listen();
  try {
    const { cookie: oldCookie } = await login(server);
    await server.close();
    server = await listen({ statusSessionSeconds: 12 * 60 * 60 });
    const oldHeaders = { Cookie: oldCookie };
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: oldHeaders })).status, 401);
    now = issuedAt + (thirtyDays - 30 * 60) * 1000;
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: oldHeaders })).status, 401);
    const { cookie: currentCookie, setCookie } = await login(server);
    assert.match(setCookie, /Max-Age=43200;/);
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: { Cookie: currentCookie } })).status, 200);
    now += 12 * 60 * 60 * 1000;
    assert.equal((await server.fetch('/console/api/bootstrap', { headers: { Cookie: currentCookie } })).status, 401);
  } finally { await server.close(); }
});

test('event stream closes when a remembered cookie reaches its absolute expiry', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const server = await listen();
  const abort = new AbortController();
  try {
    const { cookie } = await login(server);
    const stream = await server.fetch('/console/api/events', { headers: { Cookie: cookie }, signal: abort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: update/);
    now += thirtyDays * 1000;
    const expired = await reader.read();
    assert.match(new TextDecoder().decode(expired.value), /event: auth-expired/);
    assert.equal((await reader.read()).done, true);
  } finally { abort.abort(); await server.close(); }
});

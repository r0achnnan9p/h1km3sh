import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createPublicGateway } from '../lib/mcp-security.js';
import { createStatusPasswordHash } from '../lib/mcp-security.js';
import { createStatusPasswordStore, createStatusSetupCode, verifyStatusPassword } from '../lib/status-password-store.js';

test('公网短密码用一次性初始化码首次设置，改密后旧密码失效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-'));
  try {
    const filePath = path.join(root, 'data', 'public-console-auth.json');
    const setup = createStatusSetupCode(filePath);
    const store = createStatusPasswordStore({ filePath });
    assert.equal(store.isConfigured(), false);
    await assert.rejects(store.initialize('wrong', 'first-camera-pass'));
    await store.initialize(setup.code, 'first-camera-pass');
    assert.equal(store.isConfigured(), true);
    assert.equal(await verifyStatusPassword('first-camera-pass', store.getPasswordHash()), true);
    await assert.rejects(store.change('wrong-password', 'second-camera-pass'));
    await store.change('first-camera-pass', 'second-camera-pass');
    assert.equal(await verifyStatusPassword('first-camera-pass', store.getPasswordHash()), false);
    assert.equal(await verifyStatusPassword('second-camera-pass', store.getPasswordHash()), true);
    const saved = fs.readFileSync(filePath, 'utf8');
    assert.equal(saved.includes(setup.code), false);
    assert.equal(saved.includes('second-camera-pass'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('服务启动后生成的一次性初始化码可以立即使用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-late-setup-'));
  try {
    const filePath = path.join(root, 'data', 'public-console-auth.json');
    const store = createStatusPasswordStore({ filePath });
    const setup = createStatusSetupCode(filePath);
    await store.initialize(setup.code, 'fresh-camera-pass');
    assert.equal(store.isConfigured(), true);
    assert.equal(await verifyStatusPassword('fresh-camera-pass', store.getPasswordHash()), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('动态密码轮换立即使现有公网会话失效，未登录只能访问登录与静态资源', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-gateway-'));
  const filePath = path.join(root, 'public-console-auth.json');
  const setup = createStatusSetupCode(filePath), store = createStatusPasswordStore({ filePath });
  await store.initialize(setup.code, 'old-camera-pass');
  const app = express(); app.use(express.json()); app.get('/console.css', (_req, res) => res.type('text/css').send('body{}'));
  app.get('/console/api/bootstrap', (_req, res) => res.json({ success: true, privateData: true }));
  app.get('/api/devices', (_req, res) => res.json({ password: 'must-not-leak' }));
  app.post('/console/api/password', async (req, res) => { await store.change(req.body.oldPassword, req.body.password); res.json({ success: true }); });
  const server = createPublicGateway(app, { token: 'mcp-token-abcdefghijklmnopqrstuvwxyz-123456', baseUrl: 'https://hik.example.com', statusPasswordStore: store,
    getStatus: () => ({ tasks: [] }) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, origin = 'https://hik.example.com';
  try {
    assert.equal((await fetch(base + '/console.css')).status, 200);
    assert.equal((await fetch(base + '/console/api/bootstrap')).status, 401);
    assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { Origin: 'https://evil.example' } })).status, 401);
    assert.equal((await fetch(base + '/console/api/password', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/devices')).status, 404);
    const login = await fetch(base + '/status/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'old-camera-pass' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.deepEqual(await (await fetch(base + '/console/api/bootstrap', { headers: { Cookie: cookie } })).json(), { success: true, privateData: true });
    const rotate = await fetch(base + '/console/api/password', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: 'old-camera-pass', password: 'new-camera-pass' }) });
    assert.equal(rotate.status, 200);
    assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(base + '/console/api/bootstrap')).status, 401);
    assert.equal((await fetch(base + '/console/api/password', { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('遗留环境哈希在已有初始化状态文件时仍可用于首次登录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-legacy-'));
  try {
    const filePath = path.join(root, 'public-console-auth.json');
    createStatusSetupCode(filePath);
    const legacyHash = createStatusPasswordHash('legacy-camera-pass');
    const store = createStatusPasswordStore({ filePath, initialHash: legacyHash });
    assert.equal(store.isConfigured(), true);
    assert.equal(store.getPasswordHash(), legacyHash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('环境密码优先、只在内存哈希，保留文件密码且拒绝网页初始化/改密', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-env-'));
  try {
    const filePath = path.join(root, 'public-console-auth.json');
    const setup = createStatusSetupCode(filePath);
    const original = createStatusPasswordStore({ filePath });
    await original.initialize(setup.code, 'stored123');
    const saved = fs.readFileSync(filePath, 'utf8');
    const sessionSecret = 'test-only-existing-mcp-token-1234567890123456';
    const managed = createStatusPasswordStore({ filePath, loginPassword: 'test1234', sessionSecret });
    assert.equal(managed.isConfigured(), true);
    assert.equal(await verifyStatusPassword('test1234', managed.getPasswordHash()), true);
    assert.equal(await verifyStatusPassword('stored123', managed.getPasswordHash()), false);
    await assert.rejects(managed.initialize(setup.code, 'change123'), /HIKCLIP_LOGIN_PASSWORD.*重启/);
    await assert.rejects(managed.change('test1234', 'change123'), /HIKCLIP_LOGIN_PASSWORD.*重启/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), saved);
    assert.equal(createStatusPasswordStore({ filePath, loginPassword: '' }).getPasswordHash(), original.getPasswordHash());
    const restarted = createStatusPasswordStore({ filePath, loginPassword: 'test1234', sessionSecret });
    assert.equal(restarted.getPasswordHash(), managed.getPasswordHash());
    assert.notEqual(createStatusPasswordStore({ filePath, loginPassword: 'changed123', sessionSecret }).getPasswordHash(), managed.getPasswordHash());
    assert.notEqual(createStatusPasswordStore({ filePath, loginPassword: 'test1234', sessionSecret: sessionSecret + '-rotated' }).getPasswordHash(), managed.getPasswordHash());
    const ephemeral = createStatusPasswordStore({ filePath, loginPassword: 'test1234' });
    assert.notEqual(createStatusPasswordStore({ filePath, loginPassword: 'test1234' }).getPasswordHash(), ephemeral.getPasswordHash());
    const noFile = path.join(root, 'unwritten.json');
    assert.equal(createStatusPasswordStore({ filePath: noFile, loginPassword: '12345678' }).isConfigured(), true);
    assert.equal(createStatusPasswordStore({ filePath: noFile, loginPassword: 'abcdefgh' }).isConfigured(), true);
    assert.equal(fs.existsSync(noFile), false);
    for (const loginPassword of ['short12', 'x'.repeat(129), null, 12345678]) {
      assert.throws(() => createStatusPasswordStore({ filePath, loginPassword }), /8–128/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('环境密码登录保留限流、MCP隔离，同密码重启保留登录、改密后失效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-password-env-gateway-'));
  const filePath = path.join(root, 'auth.json');
  const sessionSecret = 'independent-mcp-token-1234567890123456';
  let store = createStatusPasswordStore({ filePath, loginPassword: 'test1234', sessionSecret });
  const app = express();
  app.get('/mcp', (_req, res) => res.json({ ok: true }));
  app.get('/console/api/bootstrap', (_req, res) => res.json({ ok: true }));
  const server = createPublicGateway(app, { token: 'independent-mcp-token-1234567890123456', baseUrl: 'https://hik.example.com',
    statusPasswordStore: { getPasswordHash: () => store.getPasswordHash() } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = password => fetch(base + '/status/login', { method: 'POST', headers: { Origin: 'https://hik.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  try {
    const signedIn = await login('test1234'); assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer test1234' } })).status, 401);
    assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer independent-mcp-token-1234567890123456' } })).status, 200);
    store = createStatusPasswordStore({ filePath, loginPassword: 'test1234', sessionSecret });
    assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 200);
    store = createStatusPasswordStore({ filePath, loginPassword: 'changed123', sessionSecret });
    assert.equal((await fetch(base + '/console/api/bootstrap', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await login('test1234')).status, 401);
    assert.equal((await login('changed123')).status, 200);
    for (let attempt = 1; attempt <= 5; attempt++) assert.equal((await login('wrong')).status, attempt === 5 ? 429 : 401);
    assert.equal((await login('changed123')).status, 429);
    assert.equal(fs.existsSync(filePath), false);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

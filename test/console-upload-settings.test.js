import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUploadSettingsStore, validateUploadSettings, readUploadIntegrations, uploadTitle } from '../lib/console-upload-settings.js';
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('settings migrate old defaults and preserve fields for partial updates', t => {
  const dir = fixture(t), file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ cloud189TargetPath: '/H1kM3sh' }));
  const store = createUploadSettingsStore(file);
  assert.deepEqual(store.read(), { cloud189TargetPath: '/H1kM3sh', bilibiliTitlePrefix: '', bilibiliExtraTags: [], managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliSeasonId: 1735361, bilibiliSectionId: 1992175 });
  store.update({ bilibiliTitlePrefix: '', bilibiliExtraTags: ['足球'] });
  assert.deepEqual(store.read(), { cloud189TargetPath: '/H1kM3sh', bilibiliTitlePrefix: '', bilibiliExtraTags: [], managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliSeasonId: 1735361, bilibiliSectionId: 1992175 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(uploadTitle('决赛.mp4', store.read()), '决赛');
  assert.equal([...uploadTitle('球'.repeat(100), store.read())].length, 80);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});
test('invalid and secret fields rejected; malformed on-disk config never overwritten', t => {
  for (const value of [{ cookie: 'secret' }, { bilibiliTitlePrefix: 'x\n' }, { bilibiliTitlePrefix: '字'.repeat(31) }, { cloud189TargetPath: '/../secret' }, { bilibiliExtraTags: ['x,y'] }, { onlySelf: false }, []]) assert.throws(() => validateUploadSettings(value));
  const dir = fixture(t), file = path.join(dir, 'settings.json'), store = createUploadSettingsStore(file);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => store.update({ bilibiliTitlePrefix: 'new' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});
test('worker observation is freshness bounded, strict boolean and sanitized; cookie presence is unverified', t => {
  const dir = fixture(t), now = 1_000_000;
  for (const folder of ['biliup_work', 'cloud189_work']) fs.mkdirSync(path.join(dir, folder));
  const write = (folder, value) => fs.writeFileSync(path.join(dir, folder, 'worker-status.json'), JSON.stringify(value));
  write('biliup_work', { checkedAt: 1000, binaryAvailable: true, credentialsPresent: true, coverAvailable: true, cookie: 'DO NOT RETURN' });
  write('cloud189_work', { checkedAt: 1000, binaryAvailable: true, authenticated: true, account: 'DO NOT RETURN' });
  const result = readUploadIntegrations(dir, { enabled: true, now });
  assert.equal(result.bilibiliEnabled, true); assert.equal(result.bilibiliAuthState, 'unverified');
  assert.equal(result.cloud189AuthState, 'verified'); assert.equal(result.webLoginSupported, false);
  assert.ok(!JSON.stringify(result).includes('DO NOT RETURN'));
  assert.equal(readUploadIntegrations(dir, { enabled: false, now }).bilibiliEnabled, false);
  for (const checkedAt of [850, 1006, '1000', null]) {
    write('biliup_work', { checkedAt, binaryAvailable: true, credentialsPresent: true, coverAvailable: true });
    assert.equal(readUploadIntegrations(dir, { enabled: true, now }).bilibiliEnabled, false);
  }
  write('cloud189_work', { checkedAt: 1000, binaryAvailable: 'true', authenticated: 'true' });
  assert.equal(readUploadIntegrations(dir, { now }).cloud189Enabled, false);
});

test('settings API requires owner cookie, same Origin and session CSRF; local direct access denied', async t => {
  const { default: express } = await import('express');
  const { mountUploadSettings } = await import('../lib/console-upload-settings.js');
  const { createPublicGateway, createStatusPasswordHash } = await import('../lib/mcp-security.js');
  const app = express(); app.use(express.json());
  const dir = fixture(t), store = createUploadSettingsStore(path.join(dir, 'settings.json'));
  mountUploadSettings(app, { store, integrations: () => ({ webLoginSupported: false }) });
  const origin = 'https://owner.example';
  const gateway = createPublicGateway(app, { token: 'a-test-token-at-least-32-characters-long', baseUrl: origin, statusPasswordHash: createStatusPasswordHash('test-password') });
  const server = gateway.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/console/api/settings')).status, 401);
  const login = await fetch(base + '/status/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const settings = await (await fetch(base + '/console/api/settings', { headers: { cookie } })).json();
  assert.ok(settings.csrfToken);
  const put = headers => fetch(base + '/console/api/settings', { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ bilibiliEnabled: true }) });
  assert.equal((await put({})).status, 403);
  assert.equal((await put({ 'x-csrf-token': settings.csrfToken, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await put({ 'x-csrf-token': settings.csrfToken })).status, 200);
  assert.equal(store.read().bilibiliEnabled, true);
  const direct = app.listen(0, '127.0.0.1'); await new Promise(resolve => direct.once('listening', resolve));
  t.after(() => { direct.closeAllConnections(); direct.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${direct.address().port}/console/api/settings`)).status, 401);
});

test('legacy settings migrate fixed football policy without creating jobs; stale requests cannot override it', t => {
  const file = path.join(fixture(t), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ managedEnabled: false, bilibiliEnabled: false, cloud189Enabled: false, bilibiliSeasonId: 0, bilibiliSectionId: 0, bilibiliTitlePrefix: '旧前缀', bilibiliExtraTags: ['集锦'] }));
  const store = createUploadSettingsStore(file), settings = store.read();
  assert.equal(settings.managedEnabled, true); assert.equal(settings.bilibiliEnabled, true); assert.equal(settings.cloud189Enabled, true);
  assert.equal(settings.bilibiliSeasonId, 1735361); assert.equal(settings.bilibiliSectionId, 1992175);
  assert.equal(settings.bilibiliTitlePrefix, ''); assert.deepEqual(settings.bilibiliExtraTags, []);
  assert.equal(uploadTitle('比赛.mp4', { bilibiliTitlePrefix: 'stale' }), '比赛');
  for (const input of [{ bilibiliSeasonId: 0 }, { bilibiliSectionId: 123 }, { bilibiliTitlePrefix: 'stale' }, { bilibiliExtraTags: ['集锦'] }, { managedEnabled: false }, { bilibiliEnabled: false }, { cloud189Enabled: false }, { cloud189TargetPath: '/other' }]) assert.throws(() => store.update(input));
  store.update({ cloud189TargetPath: '/H1kM3sh' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...settings, cloud189TargetPath: '/H1kM3sh' });
});

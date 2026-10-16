import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountPresentation, createUploadAccounts } from '../public/upload-accounts.js';
class Node {
  children = []; listeners = {}; hidden = false; disabled = false; textContent = ''; attributes = {};
  classList = { add() {}, toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this[key]; delete this.attributes[key]; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async emit(type) { for (const callback of this.listeners[type] || []) await callback({}); }
  async click() { if (!this.disabled) await this.emit('click'); }
}
function harness(request) {
  const roots = new Map(['bilibili', 'cloud189'].map(provider => [`upload-account-${provider}`, new Node()]));
  const document = { getElementById: id => roots.get(id), createElement: () => new Node() };
  const sheets = [], timers = new Map(); let timerId = 0, connections = 0, reauths = 0;
  const openDialog = () => { const sheet = { dialog: new Node(), content: new Node(), error: new Node(), actions: new Node(), setPending(value) { this.actions.children.forEach(node => { node.disabled = value; }); }, close() { this.dialog.emit('close'); } }; sheets.push(sheet); return sheet; };
  const client = createUploadAccounts({ document, request, openDialog, resolveUrl: path => '/camera' + path, onConnected: () => { connections++; }, onReauthenticate: () => { reauths++; }, schedule: fn => { timers.set(++timerId, fn); return timerId; }, cancelSchedule: id => timers.delete(id) });
  return { client, roots, sheets, timers, connections: () => connections, reauths: () => reauths, async tick() { const first = timers.entries().next().value; assert.ok(first); timers.delete(first[0]); await first[1](); } };
}
const account = (state = 'disconnected', overrides = {}) => ({ provider: 'bilibili', available: true, state, attempt: null, ...overrides });
const list = value => ({ csrfToken: 'fixture-token', accounts: [value, { provider: 'cloud189', available: false, state: 'unavailable' }] });
const attempt = state => account(state, { attempt: { id: 'test-attempt', qrReady: true } });

test('account status is based on verified state, never merely on an existing credential file', () => {
  assert.equal(accountPresentation(null).ready, false);
  assert.equal(accountPresentation(account('disconnected', { credentialsPresent: true })).ready, false);
  assert.equal(accountPresentation(account('connected')).ready, true);
  assert.equal(accountPresentation(account('waiting_scan')).active, true);
  assert.equal(accountPresentation(account('unavailable', { available: false })).unavailable, true);
});
test('reading account state never starts login and keeps unavailable providers disabled', async () => {
  const calls = []; const h = harness(async (path, options) => { calls.push([path, options]); return list(account()); });
  await h.client.refresh(); assert.deepEqual(calls, [['/console/api/upload-accounts', undefined]]);
  assert.equal(h.roots.get('upload-account-cloud189').children[2].children[0].disabled, true);
  h.client.show('bilibili'); assert.equal(calls.length, 1); assert.equal(h.sheets.length, 1);
});
test('explicit QR action uses CSRF and same-origin image; live refresh retains the active dialog', async () => {
  const calls = []; const h = harness(async (path, options) => { calls.push([path, options]); return path.endsWith('/start') ? { account: attempt('waiting_scan') } : list(account()); });
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0]; await sheet.actions.children[1].click();
  assert.equal(calls[1][0], '/console/api/upload-accounts/bilibili/start'); assert.equal(calls[1][1].headers['X-CSRF-Token'], 'fixture-token');
  const image = sheet.content.children[0].children[0]; assert.equal(image.src, '/camera/console/api/upload-accounts/bilibili/qr?attemptId=test-attempt');
  await h.client.refresh(); assert.equal(h.sheets.length, 1); assert.equal(image.hidden, false); assert.equal(h.timers.size, 1);
});
test('polling moves through phone confirmation to verified completion without fake success', async () => {
  let reads = 0; const h = harness(async path => path.endsWith('/start') ? { account: attempt('waiting_scan') } : path.includes('/status?') ? { account: attempt(++reads === 1 ? 'waiting_confirmation' : 'connected') } : list(account()));
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0]; await sheet.actions.children[1].click();
  assert.equal(h.connections(), 0); await h.tick(); assert.equal(h.connections(), 0); assert.equal(sheet.content.children[1].textContent, '请在手机上确认');
  await h.tick(); assert.equal(h.connections(), 1); assert.equal(h.timers.size, 0); assert.equal(sheet.actions.children[0].textContent, '完成');
});
test('expired QR disappears and offers a new attempt', async () => {
  const h = harness(async path => path.endsWith('/start') ? { account: attempt('waiting_scan') } : path.includes('/status?') ? { account: attempt('expired') } : list(account()));
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0]; await sheet.actions.children[1].click(); await h.tick();
  assert.equal(sheet.content.children[0].children[0].hidden, true); assert.equal(sheet.actions.children[1].hidden, false); assert.equal(sheet.actions.children[1].textContent, '重新生成二维码'); assert.equal(h.timers.size, 0);
});
test('closing or logging out cancels only the active attempt once and stops polling', async () => {
  const calls = []; const h = harness(async path => { calls.push(path); return path.endsWith('/start') ? { account: attempt('waiting_scan') } : path.endsWith('/cancel') ? { account: account('cancelled') } : list(account()); });
  await h.client.refresh(); h.client.show('bilibili'); await h.sheets[0].actions.children[1].click(); await h.client.stop();
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1); assert.equal(h.timers.size, 0); await h.client.stop(); assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1);
});
test('closing while start is in flight cancels the late response and never resurrects its QR', async () => {
  let resolve; const calls = []; const h = harness(async path => { calls.push(path); if (path.endsWith('/start')) return await new Promise(done => { resolve = done; }); return path.endsWith('/cancel') ? { account: account('cancelled') } : list(account()); });
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0]; const pending = sheet.actions.children[1].click(); sheet.close(); resolve({ account: attempt('waiting_scan') }); await pending;
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1); assert.equal(h.timers.size, 0); assert.equal(sheet.content.children[0].children[0].hidden, true);
});

test('reconnecting existing credentials sends replace only after its explicit QR confirmation', async () => {
  const calls = []; const h = harness(async (path, options) => { calls.push([path, options]); return path.endsWith('/start') ? { account: attempt('waiting_scan') } : list(account('connected', { credentialsPresent: true })); });
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0];
  assert.equal(calls.length, 1); assert.equal(sheet.actions.children[1].textContent, '确认替换并生成二维码');
  await sheet.actions.children[1].click(); assert.deepEqual(JSON.parse(calls[1][1].body), { replace: true });
});
test('disconnect requires a separate confirmation and then refreshes readiness', async () => {
  const calls = []; const h = harness(async (path, options) => { calls.push([path, options]); return path.endsWith('/disconnect') ? { account: account('disconnected') } : list(account('connected', { credentialsPresent: true })); });
  await h.client.refresh(); const disconnect = h.roots.get('upload-account-bilibili').children[2].children[2];
  assert.equal(disconnect.hidden, false); await disconnect.click(); assert.equal(calls.length, 1);
  await h.sheets[0].actions.children[1].click(); assert.equal(calls[1][0], '/console/api/upload-accounts/bilibili/disconnect'); assert.equal(h.connections(), 1); assert.equal(disconnect.hidden, true);
});

test('asynchronous verification waits for the terminal account state', async () => {
  const h = harness(async path => path.endsWith('/verify') ? { account: attempt('verifying') } : path.includes('/status?') ? { account: account('connected') } : list(account()));
  await h.client.refresh(); const verify = h.roots.get('upload-account-bilibili').children[2].children[1];
  const pending = verify.click(); await new Promise(setImmediate); assert.equal(verify.disabled, true); assert.equal(h.connections(), 0);
  await h.tick(); await pending; assert.equal(h.connections(), 1); assert.equal(verify.disabled, false);
});
test('asynchronous disconnect does not close its confirmation before deletion is confirmed', async () => {
  const h = harness(async path => path.endsWith('/disconnect') ? { account: attempt('verifying') } : path.includes('/status?') ? { account: account('disconnected') } : list(account('connected', { credentialsPresent: true })));
  await h.client.refresh(); await h.roots.get('upload-account-bilibili').children[2].children[2].click();
  const confirm = h.sheets[0].actions.children[1], pending = confirm.click(); await new Promise(setImmediate);
  assert.equal(confirm.disabled, true); assert.equal(h.connections(), 0); await h.tick(); await pending; assert.equal(h.connections(), 1);
});
test('logout cancels a background verification and prevents late polling', async () => {
  const calls = []; const h = harness(async path => { calls.push(path); return path.endsWith('/verify') ? { account: attempt('verifying') } : path.endsWith('/cancel') ? { account: account('cancelled') } : list(account()); });
  await h.client.refresh(); const pending = h.client.verifyAccount('bilibili'); await new Promise(setImmediate); assert.equal(h.timers.size, 1);
  await h.client.stop(); await pending; assert.equal(h.timers.size, 0); assert.equal(h.connections(), 0); assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1);
});

test('old remembered sessions show an explicit re-login entry without logging out or starting an attempt', async () => {
  const calls = []; const h = harness(async path => { calls.push(path); return { ...list(account()), reauthRequired: true }; });
  await h.client.refresh(); const root = h.roots.get('upload-account-bilibili');
  assert.equal(root.children[3].hidden, false); assert.match(root.children[3].children[0].textContent, /重新登录一次/);
  assert.equal(root.children[2].children[0].disabled, true); assert.equal(h.reauths(), 0); h.client.show('bilibili'); assert.equal(h.sheets.length, 0);
  await root.children[3].children[1].click(); assert.equal(h.reauths(), 1); assert.deepEqual(calls, ['/console/api/upload-accounts']);
});
test('a mutation requiring session upgrade retains its dialog and exposes a deliberate re-login action', async () => {
  const h = harness(async path => { if (path.endsWith('/start')) throw Object.assign(new Error('old session'), { code: 'SESSION_REAUTH_REQUIRED', status: 409 }); return list(account()); });
  await h.client.refresh(); h.client.show('bilibili'); const sheet = h.sheets[0]; await sheet.actions.children[1].click();
  assert.match(sheet.error.textContent, /未保存的平台设置会保留/); assert.equal(sheet.actions.children[1].disabled, true); assert.equal(h.reauths(), 0);
  assert.equal(sheet.actions.children[2].textContent, '前往重新登录'); await sheet.actions.children[2].click(); assert.equal(h.reauths(), 1);
});

test('existing unverified credentials and unreadable state never masquerade as disconnected', async () => {
  assert.equal(accountPresentation(account('disconnected', { credentialsPresent: true })).label, '登录待验证');
  assert.equal(accountPresentation(account('disconnected', { credentialsPresent: true })).ready, false);
  assert.equal(accountPresentation(null).label, '账号状态未知');
  const h = harness(async () => list(account('disconnected', { credentialsPresent: true }))); await h.client.refresh();
  const root = h.roots.get('upload-account-bilibili'); assert.equal(root.children[0].children[0].textContent, '登录待验证'); assert.equal(root.children[0].children.length, 1); assert.equal(root.children[2].children[2].hidden, false);
});
test('session upgrade replaces account status with explicit control-panel reauthentication', async () => {
  const h = harness(async () => ({ ...list(account('connected', { credentialsPresent: true })), reauthRequired: true })); await h.client.refresh();
  const root = h.roots.get('upload-account-bilibili'); assert.equal(root.children[0].children[0].textContent, '需重新登录控制台'); assert.equal(root.children[1].textContent, ''); assert.equal(root.children[3].hidden, false);
  assert.ok(root.children[2].children.every(button => button.disabled)); assert.equal(h.reauths(), 0);
});
test('401 account reads offer deliberate re-login while transient read errors show unknown', async () => {
  for (const status of [401, 503]) {
    const h = harness(async () => { throw Object.assign(new Error('read failed'), { status }); });
    await assert.rejects(h.client.refresh(), /read failed/); const root = h.roots.get('upload-account-bilibili');
    assert.equal(root.children[0].children[0].textContent, status === 401 ? '需重新登录控制台' : '账号状态未知'); assert.equal(root.children[3].hidden, status !== 401); assert.equal(h.reauths(), 0);
    if (status === 401) { assert.ok(root.children[2].children.every(button => button.disabled)); await root.children[3].children[1].click(); assert.equal(h.reauths(), 1); }
  }
});
test('failed refresh does not leave a previously connected account falsely marked current', async () => {
  let fail = false; const h = harness(async () => { if (fail) throw Object.assign(new Error('read failed'), { status: 503 }); return list(account('connected', { credentialsPresent: true })); });
  await h.client.refresh(); const root = h.roots.get('upload-account-bilibili'); assert.equal(root.children[0].children[0].textContent, '账号已连接'); fail = true;
  await assert.rejects(h.client.refresh()); assert.equal(root.children[0].children[0].textContent, '账号状态未知'); assert.match(root.children[1].textContent, /重新检测/); assert.equal(root.children[2].children[2].hidden, false);
});

test('normal disconnected account omits obvious instructions; verification stays an accessible icon', async () => {
  const h = harness(async () => list(account('disconnected'))); await h.client.refresh();
  const root = h.roots.get('upload-account-bilibili');
  assert.equal(root.children[0].children[0].textContent, '未连接'); assert.equal(root.children[1].textContent, '');
  const verify = root.children[2].children[1]; assert.equal(verify.textContent, ''); assert.match(verify.innerHTML, /<svg/); assert.equal(verify.attributes['aria-label'], '重新检测账号');
  for (const state of ['unknown', 'unverified', 'unavailable', 'needs_login', 'error']) assert.ok(accountPresentation(account(state)).detail);
});

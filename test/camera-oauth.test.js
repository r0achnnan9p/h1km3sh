import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { createCameraOAuth } from '../lib/camera-oauth.js';
import { createPublicGateway, publicBaseUrl } from '../lib/mcp-security.js';
import { mountMcpHttp } from '../lib/mcp-http.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('OAuth 重启后保留注册与授权，换密码失效；旧注册只有正确密码才恢复', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-oauth-'));
  const stateFile = path.join(directory, 'state.json');
  try {
    const first = createCameraOAuth({ baseUrl, loginToken, stateFile });
    const client = first.register({ redirect_uris: ['https://chat.example.com/callback'] });
    const params = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
    const tokens = exchange(first, params, new URL(first.approve(params, loginToken)).searchParams.get('code'));
    const restarted = createCameraOAuth({ baseUrl, loginToken, stateFile });
    assert.equal(restarted.verifyAccess(tokens.access_token), true);
    assert.ok(restarted.authorize(params));
    const next = restarted.exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
    const again = createCameraOAuth({ baseUrl, loginToken, stateFile });
    assert.equal(again.verifyAccess(next.access_token), true);
    assert.throws(() => again.exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }));
    assert.equal(createCameraOAuth({ baseUrl, loginToken: loginToken + '-rotated', stateFile }).verifyAccess(next.access_token), false);
    const lost = createCameraOAuth({ baseUrl, loginToken });
    assert.throws(() => lost.approve(params, 'wrong'));
    assert.throws(() => lost.authorize(params));
    assert.throws(() => lost.approve({ ...params, redirect_uri: 'http://chat.example.com/callback' }, loginToken));
    const code = new URL(lost.approve(params, loginToken)).searchParams.get('code');
    assert.equal(lost.verifyAccess(exchange(lost, params, code).access_token), true);
    assert.throws(() => lost.approve({ ...params, redirect_uri: 'https://evil.example/callback' }, loginToken));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const loginToken = 'test-oauth-login-password-abcdefghijklmnopqrstuvwxyz';
const baseUrl = 'https://hik.example.com';
const verifier = 'a'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
test('OAuth 公网地址规范化，拒绝可注入表单或元数据的配置', () => {
  for (const value of ['https://hik.example.com/h1km3sh\" onsubmit=\"x', 'https://hik.example.com/a%2Fb', 'https://hik.example.com/a//b', 'https://hik.example.com/h1km3sh?x=1']) {
    assert.throws(() => createCameraOAuth({ baseUrl: value, loginToken }));
  }
});

function fixture(now) {
  const oauth = createCameraOAuth({ baseUrl, loginToken, now });
  const client = oauth.register({ redirect_uris: ['https://chat.example.com/callback'] });
  const params = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'camera offline_access', state: 'client-state', resource: oauth.resource };
  return { oauth, params };
}
function exchange(oauth, params, code) {
  return oauth.exchange({ grant_type: 'authorization_code', client_id: params.client_id,
    redirect_uri: params.redirect_uri, code, code_verifier: verifier, resource: oauth.resource });
}

test('OAuth PKCE、回调与密码校验，一次性 code 与轮换 refresh', () => {
  const { oauth, params } = fixture();
  assert.throws(() => oauth.approve(params, 'wrong'));
  assert.throws(() => oauth.approve({ ...params, redirect_uri: 'https://evil.example' }, loginToken));
  assert.throws(() => oauth.approve({ ...params, code_challenge_method: 'plain' }, loginToken));
  const redirect = new URL(oauth.approve(params, loginToken));
  assert.equal(redirect.searchParams.get('state'), 'client-state');
  const code = redirect.searchParams.get('code');
  assert.throws(() => oauth.exchange({ grant_type: 'authorization_code', ...params, code, code_verifier: 'b'.repeat(43) }));
  const tokens = exchange(oauth, params, code);
  assert.equal(oauth.verifyAccess(tokens.access_token), true);
  assert.ok(!JSON.stringify(tokens).includes(loginToken));
  assert.throws(() => exchange(oauth, params, code));
  assert.throws(() => oauth.exchange({ grant_type: 'refresh_token', client_id: 'wrong', refresh_token: tokens.refresh_token }));
  const next = oauth.exchange({ grant_type: 'refresh_token', client_id: params.client_id, refresh_token: tokens.refresh_token });
  assert.equal(oauth.verifyAccess(next.access_token), true);
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.throws(() => oauth.exchange({ grant_type: 'refresh_token', client_id: params.client_id, refresh_token: tokens.refresh_token }));
});

test('OAuth 过期 code/access 拒绝，错误 resource、注册与权限范围拒绝', () => {
  let time = 1000;
  const { oauth, params } = fixture(() => time);
  const code = new URL(oauth.approve(params, loginToken)).searchParams.get('code');
  time += 61000;
  assert.throws(() => exchange(oauth, params, code));
  const next = new URL(oauth.approve(params, loginToken)).searchParams.get('code');
  const tokens = exchange(oauth, params, next);
  time += 3600001;
  assert.equal(oauth.verifyAccess(tokens.access_token), false);
  assert.throws(() => oauth.register({ redirect_uris: ['http://evil.example/callback'] }));
  assert.throws(() => oauth.register({ redirect_uris: ['https://user:password@evil.example/'] }));
  assert.throws(() => oauth.authorize({ ...params, resource: 'https://other.example/mcp' }));
  assert.throws(() => oauth.authorize({ ...params, scope: 'devices_password' }));
});

for (const prefix of ['', '/zl-camera', '/h1km3sh', '/nested/camera']) {
test(`真实 OAuth HTTP ${prefix || '/'}：发现、DCR、登录、code 交换、认证 MCP 和刷新`, async () => {
  const baseUrl = publicBaseUrl(`https://hik.example.com${prefix}/`);
  const app = express(); app.use(express.json());
  const oauth = createCameraOAuth({ baseUrl: `${baseUrl}/`, loginToken }); oauth.mount(app);
  mountMcpHttp(app, { handle: async () => ({ jsonrpc: '2.0', id: 1, result: {} }) }, '/mcp', {
    token: loginToken, verifyAccess: oauth.verifyAccess, resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
  });
  const paths = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token']);
  const proxy = express();
  // Model handle_path: strip exactly one external prefix before the restricted gateway.
  proxy.use(prefix || '/', createPublicGateway(app, { token: loginToken, baseUrl, oauth: { paths, verifyAccess: oauth.verifyAccess } }));
  const server = proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = origin + prefix;
  try {
    const discovery = await fetch(base + '/.well-known/oauth-protected-resource');
    const protectedResource = await discovery.json();
    assert.equal(protectedResource.resource, `${baseUrl}/mcp`);
    assert.deepEqual(protectedResource.authorization_servers, [baseUrl]);
    assert.deepEqual(protectedResource.scopes_supported, ['camera']);
    assert.deepEqual(await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json(), protectedResource);
    const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, baseUrl);
    for (const [key, suffix] of [['authorization_endpoint', 'authorize'], ['token_endpoint', 'token'], ['registration_endpoint', 'register']]) {
      assert.equal(metadata[key], `${baseUrl}/oauth/${suffix}`);
    }
    assert.deepEqual(metadata.scopes_supported, ['camera', 'offline_access']);
    const registration = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://chat.example.com/callback'] }) });
    const client = await registration.json();
    const params = { client_id: client.client_id, redirect_uri: 'https://chat.example.com/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: oauth.resource, state: `state"/><script>alert('x')</script>&`, scope: 'camera offline_access' };
    const consent = await fetch(base + '/oauth/authorize?' + new URLSearchParams(params));
    assert.equal(consent.status, 200);
    assert.ok(consent.headers.get('content-security-policy').includes("form-action 'self' https://chat.example.com;"));
    assert.ok(!consent.headers.get('content-security-policy').includes('*'));
    const html = await consent.text();
    assert.ok(!html.includes(loginToken));
    assert.ok(!html.includes(params.state));
    assert.ok(html.includes('state&quot;/&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;'));
    assert.ok(!html.includes('<script>'));
    const action = html.match(/<form method="post" action="([^"]+)"/)[1];
    assert.equal(action, `${prefix}/oauth/authorize`);
    const authorization = await fetch(origin + action, { method: 'POST', body: new URLSearchParams({ ...params, password: loginToken }), redirect: 'manual' });
    assert.equal(authorization.status, 303);
    assert.ok(authorization.headers.get('content-security-policy').includes("form-action 'self' https://chat.example.com;"));
    const callback = new URL(authorization.headers.get('location'));
    assert.equal(callback.origin + callback.pathname, params.redirect_uri);
    assert.equal(callback.searchParams.get('state'), params.state);
    const code = callback.searchParams.get('code');
    const tokenResponse = await fetch(base + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: params.client_id, redirect_uri: params.redirect_uri, code_verifier: verifier, code }) });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    const called = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(called.status, 200);
    const unauthorized = await fetch(base + '/mcp');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    const refresh = await fetch(base + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: params.client_id, refresh_token: tokens.refresh_token }) });
    assert.equal(refresh.status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


}

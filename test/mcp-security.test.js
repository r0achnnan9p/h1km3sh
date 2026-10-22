import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash, createHmac } from 'node:crypto';
import { readMcpToken, readStatusPasswordHash, createStatusPasswordHash, publicBaseUrl, signDownload, verifyDownload, createPublicGateway, bearerValid } from '../lib/mcp-security.js';
import { mountMcpHttp } from '../lib/mcp-http.js';

const token = 'test-only-mcp-token-abcdefghijklmnopqrstuvwxyz';
const pathname = '/artifacts/images/snapshot/12345678-1234-1234-1234-123456789abc.png';

test('Bearer 与公网配置校验，不接受短 Token 或非 HTTPS 地址', () => {
  assert.equal(readMcpToken({ HIKCLIP_MCP_TOKEN: token }), token);
  assert.throws(() => readMcpToken({ HIKCLIP_MCP_TOKEN: 'short' }));
  assert.equal(bearerValid(`Bearer ${token}`, token), true);
  for (const value of ['', 'Basic abc', `Bearer ${token}x`, `Bearer ${token} `]) assert.equal(bearerValid(value, token), false);
  assert.equal(publicBaseUrl('https://hik.example.com'), 'https://hik.example.com');
  assert.equal(publicBaseUrl('https://hik.example.com/zl-camera/'), 'https://hik.example.com/zl-camera');
  for (const value of ['http://hik.example.com', 'https://user:password@hik.example.com', 'https://hik.example.com/a%2Fb', 'https://hik.example.com/a//b']) assert.throws(() => publicBaseUrl(value));
  assert.throws(() => createPublicGateway(express(), {}));
});

test('签名绑定路径和有效期，拒绝篡改与重复参数，不把主 Token 放进 URL', () => {
  const url = signDownload(pathname, { token, now: 1000000, ttl: 60 });
  assert.ok(!url.includes(token));
  assert.equal(verifyDownload(url, { token, now: 1001000 }), true);
  assert.equal(verifyDownload(url, { token, now: 1060000 }), false);
  assert.equal(verifyDownload(url.replace('snapshot', 'timeline'), { token, now: 1001000 }), false);
  assert.equal(verifyDownload(url + '&expires=1060', { token, now: 1001000 }), false);
  assert.equal(verifyDownload(url, { token: 'wrong', now: 1001000 }), false);
  assert.throws(() => signDownload('/api/devices', { token }));
  assert.throws(() => signDownload('/downloads/../devices.json', { token }));
});

test('下载签名默认有效 24 小时', () => {
  const url = signDownload(pathname, { token, now: 0 });
  assert.equal(new URL(url, 'https://hik.example.com').searchParams.get('expires'), '86400');
  assert.equal(verifyDownload(url, { token, now: 86_399_000 }), true);
  assert.equal(verifyDownload(url, { token, now: 86_400_000 }), false);
});

test('状态看板短密码登录、会话鉴权与改密失效', async () => {
  const firstHash = createStatusPasswordHash('camera-8842');
  assert.equal(readStatusPasswordHash({ HIKCLIP_STATUS_PASSWORD_HASH: firstHash }), firstHash);
  assert.throws(() => createStatusPasswordHash('short'));
  const app = express();
  app.get('/api/devices', (req, res) => res.json({ password: 'private' }));
  const createServer = passwordHash => createPublicGateway(app, {
    token, baseUrl: 'https://hik.example.com/zl-camera', statusPasswordHash: passwordHash,
    getStatus: () => ({ tasks: [{ taskId: 'task-1' }] }),
  }).listen(0, '127.0.0.1');
  const firstServer = createServer(firstHash);
  await new Promise(resolve => firstServer.once('listening', resolve));
  const firstBase = `http://127.0.0.1:${firstServer.address().port}`;
  let secondServer;
  try {
    const response = await fetch(firstBase + '/');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /manifest-src 'self'/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    const dashboard = await response.text();
    assert.match(dashboard, /name="mobile-web-app-capable" content="yes"/);
    assert.match(dashboard, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(dashboard, /录像控制台/);
    assert.match(dashboard, /href="\/zl-camera\/console\.css"/);
    assert.match(dashboard, /src="\/zl-camera\/console\.js"/);
    assert.match(dashboard, /href="\/zl-camera\/touch-controls\.css"/);
    assert.doesNotMatch(dashboard, /<a class="brand"/);
    assert.equal((await fetch(firstBase + '/api/status/overview')).status, 401);
    assert.equal((await fetch(firstBase + '/status/login', { method: 'POST', headers: { Origin: 'https://hik.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-pass' }) })).status, 401);
    const login = await fetch(firstBase + '/status/login', { method: 'POST', headers: { Origin: 'https://hik.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'camera-8842' }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.deepEqual((await (await fetch(firstBase + '/api/status/overview', { headers: { Cookie: cookie } })).json()).tasks, [{ taskId: 'task-1' }]);
    assert.equal((await fetch(firstBase + '/api/devices', { headers: { Cookie: cookie, Authorization: 'Bearer test-only-mcp-token-abcdefghijklmnopqrstuvwxyz' } })).status, 404);

    secondServer = createServer(createStatusPasswordHash('camera-9926'));
    await new Promise(resolve => secondServer.once('listening', resolve));
    const secondBase = `http://127.0.0.1:${secondServer.address().port}`;
    assert.equal((await fetch(secondBase + '/api/status/overview', { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await Promise.all([firstServer, secondServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('真实公网受限入口：认证、Origin、下载与设备 API 隔离', async () => {
  const app = express();
  app.use(express.json());
  mountMcpHttp(app, { handle: async (message, context) => ({ jsonrpc: '2.0', id: message.id, result: context }) }, '/mcp', { token, publicBaseUrl: 'https://hik.example.com' });
  app.get('/api/devices', (req, res) => res.json({ password: 'must-never-be-public' }));
  app.get(pathname, (req, res) => res.send('image-fixture'));
  const server = createPublicGateway(app, { token, baseUrl: 'https://hik.example.com' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(base + '/mcp', { method })).status, 401);
    assert.equal((await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const response = await fetch(base + '/mcp', { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.publicBaseUrl, 'https://hik.example.com');
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status, 403);
    for (const route of ['/api/devices', '/', '/downloads/secret.hikraw', '/artifacts/.work/private.png']) {
      assert.equal((await fetch(base + route, { headers })).status, 404);
    }
    assert.equal((await fetch(base + pathname)).status, 404);
    const signed = signDownload(pathname, { token });
    assert.equal((await fetch(base + signed)).status, 200);
    assert.equal((await fetch(base + signed, { method: 'POST' })).status, 404);
    assert.equal((await fetch(base + signed.replace('signature=', 'signature=a'))).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('同域根站点和路径部署的会话名称、路径、签名与退出互相隔离', async () => {
  const prefixes = ['', '/zl-camera', '/h1km3sh', '/nested/camera'];
  // Deliberately share credentials to prove isolation does not depend on different passwords.
  const passwordHash = createStatusPasswordHash('shared-password');
  const proxy = express();
  for (const prefix of [...prefixes].reverse()) {
    proxy.use(prefix || '/', createPublicGateway(express(), {
      token, baseUrl: `https://hik.example.com${prefix}/`, statusPasswordHash: passwordHash,
      getStatus: () => ({ deployment: prefix || '/' }),
    }));
  }
  const server = proxy.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = [];
  const headers = { Origin: 'https://hik.example.com', 'Content-Type': 'application/json' };
  try {
    for (const prefix of prefixes) {
      const login = await fetch(base + prefix + '/status/login', {
        method: 'POST', headers, body: JSON.stringify({ password: 'shared-password' }),
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie');
      const parts = setCookie.split('; ');
      assert.ok(parts.includes(`Path=${prefix || '/'}`));
      assert.ok(parts.includes('HttpOnly'));
      assert.ok(parts.includes('Secure'));
      assert.ok(parts.includes('SameSite=Strict'));
      cookies.push(parts[0]);
    }
    assert.match(cookies[0], /^hikclip_status=/);
    const [rootExpires, rootNonce, rootSignature] = cookies[0].split('=')[1].split('.');
    const expectedSignature = createHmac('sha256', createHash('sha256').update(`${token}\n${passwordHash}`).digest())
      .update(`status-v3\n${rootExpires}\n${rootNonce}\n${30 * 24 * 60 * 60}\n`).digest('hex');
    assert.equal(rootSignature, expectedSignature);
    assert.equal(new Set(cookies.map(cookie => cookie.split('=')[0])).size, prefixes.length);
    for (const [index, prefix] of prefixes.entries()) {
      const endpoint = base + prefix + '/api/status/overview';
      // Browsers send the legacy root cookie too; either header order must work.
      for (const Cookie of [cookies.join('; '), [...cookies].reverse().join('; ')]) {
        const response = await fetch(endpoint, { headers: { Cookie } });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).deployment, prefix || '/');
      }
      for (const [otherIndex, otherCookie] of cookies.entries()) {
        if (otherIndex === index) continue;
        assert.equal((await fetch(endpoint, { headers: { Cookie: otherCookie } })).status, 401);
        const renamedCookie = cookies[index].split('=')[0] + '=' + otherCookie.split('=')[1];
        assert.equal((await fetch(endpoint, { headers: { Cookie: renamedCookie } })).status, 401);
      }
      const logout = await fetch(base + prefix + '/status/logout', {
        method: 'POST', headers: { ...headers, Cookie: cookies.join('; ') },
      });
      assert.equal(logout.status, 204);
      assert.equal(logout.headers.get('set-cookie'), `${cookies[index].split('=')[0]}=; Path=${prefix || '/'}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      // This logout leaves not-yet-logged-out deployments intact; prior v3
      // nonces remain revoked even when a stale browser sends their cookies.
      const remaining = cookies.filter((_, cookieIndex) => cookieIndex !== index).join('; ');
      assert.equal((await fetch(endpoint, { headers: { Cookie: remaining } })).status, 401);
      for (const [otherIndex, otherPrefix] of prefixes.entries()) {
        if (otherIndex === index) continue;
        assert.equal((await fetch(base + otherPrefix + '/api/status/overview', { headers: { Cookie: remaining } })).status, otherIndex < index ? 401 : 200);
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('MediaMTX WHEP signaling requires a console session, exact routes and same-origin mutations', async () => {
  const root = '/console/api/playback/d2/live', session = '11111111-1111-4111-8111-111111111111';
  const app = express(); app.get(`${root}/options`, (req,res)=>res.status(204).end());
  app.post(`${root}/whep`, (req,res)=>res.status(201).end());
  app.patch(`${root}/sessions/${session}`, (req,res)=>res.status(204).end());
  app.delete(`${root}/sessions/${session}`, (req,res)=>res.status(204).end());
  const server=createPublicGateway(app,{token,baseUrl:'https://hik.example.com',statusPasswordHash:createStatusPasswordHash('whep-test-password')}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`,Origin='https://hik.example.com';
  try {
    const cases=[['GET',`${root}/options`,204],['POST',`${root}/whep`,201],['PATCH',`${root}/sessions/${session}`,204],['DELETE',`${root}/sessions/${session}`,204]];
    for(const [method,path] of cases) assert.equal((await fetch(base+path,{method,headers:{Origin}})).status,401);
    const login=await fetch(base+'/status/login',{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:JSON.stringify({password:'whep-test-password'})});
    const Cookie=login.headers.get('set-cookie').split(';')[0];
    for(const [method,path,status] of cases){
      assert.equal((await fetch(base+path,{method,headers:{Cookie,Origin}})).status,status);
      if(method!=='GET')assert.equal((await fetch(base+path,{method,headers:{Cookie,Origin:'https://other.example'}})).status,403);
    }
    assert.equal((await fetch(base+root+'/sessions/bad',{method:'DELETE',headers:{Cookie,Origin}})).status,404);
    assert.equal((await fetch(base+root+'/whep',{method:'GET',headers:{Cookie}})).status,404);
    assert.equal((await fetch(base+'/api/devices',{headers:{Cookie}})).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('DVR live GET requires the same console session and exact recorder route as replay', async () => {
  const id = '11111111-1111-4111-8111-111111111111', route = `/console/api/dvrs/${id}/live`;
  const app = express(); app.get(route, (req, res) => res.json({ ok: true, channel: req.query.channel }));
  const server = createPublicGateway(app, { token, baseUrl: 'https://hik.example.com', statusPasswordHash: createStatusPasswordHash('live-test-password') }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + route + '?channel=301')).status, 401);
    assert.equal((await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    const login = await fetch(base + '/status/login', { method: 'POST', headers: { Origin: 'https://hik.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'live-test-password' }) });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + route + '?channel=301&format=compat', { headers: { Cookie } })).status, 200);
    assert.equal((await fetch(base + route, { method: 'POST', headers: { Cookie, Origin: 'https://hik.example.com' } })).status, 404);
    assert.equal((await fetch(base + '/console/api/dvrs/not-a-recorder/live', { headers: { Cookie } })).status, 404);
    assert.equal((await fetch(base + '/api/devices', { headers: { Cookie } })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

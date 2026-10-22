import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountCloud189Verification } from '../lib/cloud189-verification.js';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
import { CONSOLE_CONFIG_OWNER } from '../lib/console-config.js';
const id = '00000000-0000-4000-8000-000000000001';
const route = `/console/api/uploads/cloud189/${id}/verify`;
async function fixture(t) {
  let calls = 0, preparation = false, ready = true;
  const app = express(); app.use(express.json());
  mountCloud189Verification(app, { queue: { get: () => ({ id, provider: 'cloud189', status: 'unknown', uploadPhase: 'remote_started' }) },
    verify: async (selected, isActive) => { calls++; assert.equal(selected,id); assert.equal(isActive(),true); return {ok:true,code:'CLOUD_REMOTE_VERIFIED'}; },
    preparationOnly: () => preparation, canWrite: () => ready });
  app.get('/console/api/settings', (req,res) => res.json({csrfToken:req[CONSOLE_CONFIG_OWNER].csrfToken}));
  const origin = 'https://owner.example';
  const server = createPublicGateway(app,{token:'test-token-abcdefghijklmnopqrstuvwxyz',baseUrl:origin,statusPasswordHash:createStatusPasswordHash('test-password')}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/status/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'test-password'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const {csrfToken}=await (await fetch(base+'/console/api/settings',{headers:{cookie}})).json();
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
  return {base,headers,calls:()=>calls, prep:v=>preparation=v, ready:v=>ready=v};
}
test('verification uses authenticated gateway with Origin CSRF nonce and preparation/recovery guards',async t=>{
  const f=await fixture(t);
  for (const h of [{...f.headers,cookie:''},{...f.headers,origin:'https://evil.example'},{...f.headers,'x-csrf-token':''}]) {
    const r=await fetch(f.base+route,{method:'POST',headers:h,body:'{}'}); assert.ok([401,403].includes(r.status));
  }
  assert.equal(f.calls(),0);
  f.prep(true); assert.equal((await fetch(f.base+route,{method:'POST',headers:f.headers,body:'{}'})).status,409);
  f.prep(false);f.ready(false);assert.equal((await fetch(f.base+route,{method:'POST',headers:f.headers,body:'{}'})).status,409);f.ready(true);
  assert.equal((await fetch(f.base+route,{method:'POST',headers:f.headers,body:'{"path":"/arbitrary"}'})).status,400);
  const result=await (await fetch(f.base+route,{method:'POST',headers:f.headers,body:'{}'})).json();
  assert.equal(result.verified,true);assert.equal(f.calls(),1);
  await fetch(f.base+'/status/logout',{method:'POST',headers:f.headers});
  assert.equal((await fetch(f.base+route,{method:'POST',headers:f.headers,body:'{}'})).status,401);
  assert.equal(f.calls(),1);
});
test('public output only includes fixed messages and booleans, never raw provider text',async t=>{
  const app=express();app.use(express.json()); app.use((req,res,next)=>{req[CONSOLE_CONFIG_OWNER]={sessionVersion:3,isSessionActive:()=>true};next();});
  mountCloud189Verification(app,{queue:{get:()=>({provider:'cloud189',status:'unknown',uploadPhase:'remote_started'})},verify:async()=>({ok:true,code:'SECRET /private/path'})});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const result=await (await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
  assert.equal(result.verified,false);assert.equal(result.code,'VERIFY_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('recovery actions share V3 owner Origin CSRF and explicit retry confirmation guards', async t => {
  let active = true, recoveryCalls = [], job = { id, provider: 'cloud189', status: 'unknown', uploadPhase: 'remote_started' };
  const app = express(); app.use(express.json());
  mountCloud189Verification(app, { queue: { get: () => job }, verify: async () => ({ ok: false, code: 'CLOUD_FILE_NOT_FOUND' }),
    recover: async (action, selected, isActive) => { assert.equal(selected, id); assert.equal(isActive(), true); recoveryCalls.push(action); return { ok: true, code: ({ retry: 'CLOUD_RETRY_QUEUED', archive: 'CLOUD_RECORD_ARCHIVED', restore: 'CLOUD_RECORD_RESTORED' })[action] }; }, canWrite: () => active });
  app.get('/console/api/settings', (req, res) => res.json({ csrfToken: req[CONSOLE_CONFIG_OWNER].csrfToken }));
  const origin = 'https://owner.example';
  const server = createPublicGateway(app, { token: 'test-token-abcdefghijklmnopqrstuvwxyz', baseUrl: origin, statusPasswordHash: createStatusPasswordHash('test-password') }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/status/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await (await fetch(base + '/console/api/settings', { headers: { cookie } })).json();
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
  for (const action of ['retry', 'archive', 'restore']) {
    const url = `${base}/console/api/uploads/cloud189/${id}/${action}`, body = JSON.stringify(action === 'retry' ? { confirmRetry: true } : {});
    for (const h of [{ ...headers, cookie: '' }, { ...headers, origin: 'https://evil.example' }, { ...headers, 'x-csrf-token': '' }])
      assert.ok([401, 403].includes((await fetch(url, { method: 'POST', headers: h, body })).status));
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"filename":"arbitrary"}' })).status, 400);
    if (action === 'retry') assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
    active = false; assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 409); active = true;
    const result = await (await fetch(url, { method: 'POST', headers, body })).json();
    assert.equal(result.applied, true);
  }
  assert.deepEqual(recoveryCalls, ['retry', 'archive', 'restore']);
  job = { ...job, status: 'uploading' };
  assert.equal((await fetch(`${base}/console/api/uploads/cloud189/${id}/archive`, { method: 'POST', headers, body: '{}' })).status, 409);
  job = { ...job, status: 'unknown', archivedAt: '2026-10-01' };
  assert.equal((await fetch(`${base}/console/api/uploads/cloud189/${id}/retry`, { method: 'POST', headers, body: '{"confirmRetry":true}' })).status, 409);
  assert.deepEqual(recoveryCalls, ['retry', 'archive', 'restore']);
});

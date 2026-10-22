import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaMtxLive } from '../lib/mediamtx-live.js';
const id = '11111111-1111-4111-8111-111111111111';
test('WHEP confines every method to the configured server and closes a session exactly once', async () => {
  const calls = [];
  const live = createMediaMtxLive({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (options.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Link: '<stun:example.test>; rel="ice-server"' } });
    if (options.method === 'POST') return new Response('v=0\r\nanswer', { status: 201, headers: { Location: `/d2/whep/${id}` } });
    return new Response(null, { status: 204 });
  } });
  assert.match((await live.options('d2')).link, /ice-server/);
  const session = await live.open('d2', 'v=0\r\noffer'); assert.equal(session.answer, 'v=0\r\nanswer');
  await session.patch('a=ice-ufrag:test'); await session.stop(); await session.stop();
  assert.deepEqual(calls.map(c => c.method), ['OPTIONS','POST','PATCH','DELETE']); assert.ok(calls.every(c => c.url.startsWith('http://127.0.0.1:8889/d2/whep'))); assert.ok(calls.every(c => c.redirect === 'error'));
  await assert.rejects(session.patch('a=x'), /没有直播/);
});
test('invalid input and hostile upstream session locations never trigger followup requests', async () => {
  for (const location of [`https://other.test/d2/whep/${id}`, `/d1/whep/${id}`, `/d2/whep/${id}?token=x`, `/d2/whep/${id}#x`, '/admin/delete']) {
    let calls = 0;
    const live = createMediaMtxLive({ fetchImpl: async () => { calls++; return new Response('v=0', { status:201, headers:{Location:location} }); } });
    await assert.rejects(live.open('d2', 'v=0')); assert.equal(calls,1);
  }
  const live = createMediaMtxLive({ fetchImpl: () => { throw new Error('network must not run'); } });
  for (const name of ['../d2','http://other.test','d2?x=y','d2/other','']) await assert.rejects(live.open(name,'v=0'), /通道无效/);
  await assert.rejects(live.open('d2','bad'), /协商内容无效/);
});
test('offline and oversized answers fail boundedly', async () => {
  await assert.rejects(createMediaMtxLive({ fetchImpl: async () => new Response('',{status:404}) }).open('d2','v=0'), e => e.status === 404);
  await assert.rejects(createMediaMtxLive({maxBodyBytes:8,fetchImpl:async()=>new Response('x'.repeat(20),{status:201,headers:{Location:`/d2/whep/${id}`}})}).open('d2','v=0'),/过大/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHikclipClient } from '../lib/hikclip-client.js';
test('MCP HTTP client preserves the resolved recorder UUID and ports for opt-in SDK routing', async () => {
  const calls = [];
  const client = createHikclipClient({ baseUrl: 'http://127.0.0.1:30001', fetchImpl: async (url, options = {}) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ success: true, taskId: 'test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const device = { id: 'b88a6eb6-967c-47bd-b75f-1e61c85d873b', ip: '192.0.2.1', httpPort: 8080, rtspPort: 8554, username: 'fixture', password: 'fixture' };
  await client.startExport(device, { channel: '201', startTime: '20260101T100000Z', endTime: '20260101T100030Z', method: 'rtspclip' });
  const body = JSON.parse(calls.find(call => String(call.url).endsWith('/api/export')).options.body);
  assert.equal(body.deviceId, device.id); assert.equal(body.httpPort, 8080); assert.equal(body.rtspPort, 8554); assert.equal(body.channel, '201');
});

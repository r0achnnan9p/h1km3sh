import test from 'node:test';
import assert from 'node:assert/strict';
import { createDvrHttpSampleControl, mountDvrHttpSample } from '../lib/dvr-http-sample-control.js';
import { CONSOLE_CONFIG_OWNER } from '../lib/console-config.js';
import express from 'express';
test('source distribution never admits, resumes or recovers a private diagnostic', async () => {
  const dependencies = new Proxy({}, { get() { throw new Error('Must not access device, state or queue'); } });
  const control = createDvrHttpSampleControl(dependencies);
  assert.equal(control.available('any'), false);
  assert.equal(control.resumeAvailable('any'), false);
  assert.equal(control.recoverInterrupted({ task: {} }), false);
  for (const operation of ['start', 'resume']) {
    const result = await control[operation]('00000000-0000-4000-8000-000000000001');
    assert.equal(result.ok, false); assert.equal(result.status, 409);
    assert.match(result.error, /unavailable/); assert.equal(result.taskId, undefined);
  }
});
test('authenticated diagnostic request returns explicit unavailable error without a task', async t => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req[CONSOLE_CONFIG_OWNER] = { sessionVersion: 3, isSessionActive: () => true }; next(); });
  mountDvrHttpSample(app, { control: createDvrHttpSampleControl(), preparationOnly: () => false });
  const server = app.listen(0, '127.0.0.1'); t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/console/api/tasks/00000000-0000-4000-8000-000000000001/dvr-http-sample',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 409); const body = await response.json();
  assert.equal(body.success, false); assert.match(body.error, /unavailable/); assert.equal(body.taskId, undefined);
});

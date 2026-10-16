import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleFixture } from '../scripts/console-fixture.js';

async function start(t, scenario = 'normal', options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'console-fixture-test-'));
  const mediaPath = path.join(directory, 'synthetic.mp4');
  await writeFile(mediaPath, Buffer.from('synthetic-fixture-media-0123456789'));
  const fixture = createConsoleFixture({ mediaPath, taskStepMs: 25, verificationDelayMs: 25, verificationPendingMs: 100, ...options });
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  t.after(async () => { fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const json = async (...args) => (await request(...args)).json();
  const root = await request(`/?fixture=${scenario}`);
  return { request, json, root, base, cookie: () => cookie };
}

test('fixture serves real shell/assets and exposes only synthetic bootstrap state', async t => {
  const h = await start(t);
  assert.match(await h.root.text(), /id="console-shell"/);
  assert.equal(h.root.headers.get('x-console-fixture'), 'synthetic-in-memory-only');
  assert.match(await (await h.request('/console.js')).text(), /function connectEvents/);
  // 独立工作区位于 .codex 下时，白名单资源也必须能被正常加载。
  for (const asset of ['console.css', 'touch-controls.css', 'precision-timeline.js', 'precision-scrub.js']) {
    const response = await h.request(`/${asset}`);
    assert.equal(response.status, 200, `${asset} 应可加载`);
    assert.match(response.headers.get('content-type'), /css|javascript/);
  }
  const bootstrap = await h.json('/console/api/bootstrap');
  assert.equal(bootstrap.cameras.length, 3); assert.equal(bootstrap.outputs.length, 3);
  assert.equal(bootstrap.dvrs[0].ip, '192.0.2.10');
  assert.equal('password' in bootstrap.dvrs[0], false);
  assert.equal((await h.request('/api/devices')).status, 404);
  assert.equal((await h.request('/server.js')).status, 404);
  assert.equal((await h.request('/api/export', 'POST', {})).status, 404);
  const media = await h.request(bootstrap.outputs[0].streamUrl, 'GET', undefined, { Range: 'bytes=0-8' });
  assert.equal(media.status, 206); assert.equal(await media.text(), 'synthetic');
});

test('fixture scenarios expose empty, error, auth and recordings error contracts', async t => {
  const h = await start(t, 'empty');
  assert.equal((await h.json('/console/api/bootstrap')).outputs.length, 0);
  await h.request('/?fixture=error'); assert.equal((await h.request('/console/api/bootstrap')).status, 503);
  await h.request('/?fixture=auth'); assert.equal((await h.request('/console/api/bootstrap')).status, 401);
  assert.equal((await h.json('/console/api/auth')).configured, true);
  await h.request('/?fixture=setup'); assert.equal((await h.json('/console/api/auth')).configured, false);
  await h.request('/?fixture=recordings-error'); assert.equal((await h.request('/console/api/playback/pitch-main/segments?date=2026-10-01')).status, 503);
  await h.request('/?fixture=recordings-empty'); assert.equal((await h.json('/console/api/playback/pitch-main/segments?date=2026-10-01')).segments.length, 0);
});

test('fixture exports require gap consent, then complete into synthetic outputs', async t => {
  const h = await start(t), date = '2026-10-01';
  const ranges = await h.json(`/console/api/playback/pitch-main/segments?date=${date}`);
  assert.equal(ranges.segments.length, 4);
  const payload = { source: 'mediamtx', camera: 'pitch-main', start: `${date} 09:19:00`, end: `${date} 09:25:00` };
  const gap = await h.json('/console/api/export', 'POST', payload);
  assert.equal(gap.code, 'MEDIAMTX_GAPS'); assert.equal(gap.coverage.missingSeconds, 240);
  const submitted = await h.json('/console/api/export', 'POST', { ...payload, acceptGaps: true });
  assert.equal(submitted.status, 'queued');
  await new Promise(resolve => setTimeout(resolve, 110));
  const data = await h.json('/console/api/bootstrap');
  assert.equal(data.tasks.find(task => task.taskId === submitted.taskId).status, 'completed');
  assert.equal(data.outputs.length, 4); assert.match(data.outputs[0].filename, /含缺口/);
  assert.equal((await h.json('/console/api/export', 'POST', { ...payload, start: `${date} 01:00:00`, end: `${date} 01:01:00` })).code, 'MEDIAMTX_EMPTY');
});

test('fixture queue cancellation prevents export completion', async t => {
  const pending = [];
  const h = await start(t, 'normal', { scheduleExport: (_state, step) => pending.push(step) });
  const submitted = await h.json('/console/api/export', 'POST', { source: 'mediamtx', camera: 'pitch-main', start: '2026-10-01 08:00:00', end: '2026-10-01 08:01:00' });
  assert.equal(pending.length, 3);
  pending.shift()();
  const running = await h.json('/console/api/bootstrap');
  assert.equal(running.tasks.find(task => task.taskId === submitted.taskId).status, 'downloading');
  assert.equal((await h.json('/console/api/export/stop', 'POST', { taskId: submitted.taskId })).success, true);
  // Deliver all late progress/completion callbacks only after cancellation is admitted.
  for (const step of pending) step();
  const data = await h.json('/console/api/bootstrap');
  assert.equal(data.tasks.find(task => task.taskId === submitted.taskId).status, 'cancelled'); assert.equal(data.outputs.length, 3);
});

test('fixture rename/upload/delete mutate only the current in-memory session', async t => {
  const h = await start(t), endpoint = '/console/api/outputs/fixture-output-1';
  assert.equal((await h.request(endpoint, 'PUT', { newName: 'renamed.mp4' })).status, 200);
  assert.equal((await h.json('/console/api/outputs')).outputs[0].filename, 'renamed.mp4');
  const upload = await h.json(`${endpoint}/upload/cloud189`, 'POST', {});
  assert.equal((await h.request(endpoint, 'DELETE')).status, 409);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal((await h.json('/console/api/bootstrap')).uploads.find(item => item.id === upload.job.id).status, 'completed');
  assert.equal((await h.request(endpoint, 'DELETE')).status, 200);
  assert.equal((await h.json('/console/api/outputs')).outputs.length, 2);
  await h.request('/?fixture=normal'); assert.equal((await h.json('/console/api/outputs')).outputs.length, 3);
});

test('fixture config supports CSRF/revision conflict/settings/CRUD without retaining password fields', async t => {
  const h = await start(t, 'config-conflict');
  let config = await h.json('/console/api/config');
  const headers = { 'X-CSRF-Token': config.csrfToken };
  let response = await h.request('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl: 'http://fixture.invalid:9996' }, headers);
  assert.equal(response.status, 409);
  config = await h.json('/console/api/config');
  response = await h.request('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl: 'http://fixture.invalid:9996' }, headers);
  assert.equal(response.status, 200); config = await response.json();
  assert.equal(config.mediamtx.playbackUrl, 'http://fixture.invalid:9996');
  assert.equal((await h.request('/console/api/settings', 'PUT', { cloud189TargetPath: '/H1kM3sh' })).status, 403);
  const updated = await h.json('/console/api/settings', 'PUT', { cloud189TargetPath: '/H1kM3sh' }, headers);
  assert.equal(updated.settings.cloud189TargetPath, '/H1kM3sh');
  config = await h.json('/console/api/dvrs', 'POST', { revision: config.revision, name: 'Fixture B', ip: '192.0.2.11', username: 'fixture', password: 'synthetic-not-a-credential' }, headers);
  assert.equal(config.dvrs.length, 2); assert.equal(JSON.stringify(config).includes('synthetic-not-a-credential'), false);
  const dvr = config.dvrs.at(-1);
  config = await h.json(`/console/api/dvrs/${dvr.id}`, 'PATCH', { revision: config.revision, name: 'Fixture renamed' }, headers);
  assert.equal(config.dvrs.at(-1).name, 'Fixture renamed');
  config = await h.json(`/console/api/dvrs/${dvr.id}`, 'DELETE', { revision: config.revision }, headers);
  assert.equal(config.dvrs.length, 1);
  assert.equal(JSON.stringify(await h.json('/__fixture__/info')).includes('synthetic-not-a-credential'), false);
});

test('fixture SSE sends stable update events and mutation requests reject foreign origins', async t => {
  const h = await start(t);
  const controller = new AbortController();
  const response = await fetch(h.base + '/console/api/events', { headers: { Cookie: h.cookie() }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: update/); controller.abort();
  assert.equal((await h.request('/console/api/cache', 'DELETE', {}, { Origin: 'https://unrelated.invalid' })).status, 403);
  const clear = await h.json('/console/api/cache', 'DELETE', {}); assert.equal(clear.deletedCount, 1);
  assert.equal((await h.json('/console/api/cache')).files[0].complete, false);
});

test('server fixture supports managed settings and memory-only raw cover validation', async t => {
  const h = await start(t); await h.request('/?fixture=normal&cover=missing');
  const initial = await h.json('/console/api/settings'), headers = { 'X-CSRF-Token': initial.csrfToken };
  assert.equal(initial.settings.managedEnabled, true); assert.equal(initial.settings.bilibiliSeasonId, 101); assert.equal(initial.cover.present, false);
  assert.equal((await h.request('/console/api/outputs/fixture-output-1/upload/bilibili', 'POST', {})).status, 409);
  assert.equal((await h.request('/console/api/settings', 'PUT', { bilibiliSectionId: -1 }, headers)).status, 400);
  await h.json('/console/api/settings', 'PUT', { managedEnabled: true, bilibiliEnabled: true, bilibiliSeasonId: 101, bilibiliSectionId: 201 }, headers);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const endpoint = '/console/api/settings/bilibili-cover';
  assert.equal((await h.request(endpoint)).status, 404);
  const response = await fetch(h.base + endpoint, { method: 'PUT', headers: { Cookie: h.cookie(), ...headers, 'Content-Type': 'image/png' }, body: png });
  assert.equal(response.status, 200); const saved = await response.json(); assert.deepEqual(saved.cover, { present: true, source: 'managed' }); assert.equal(saved.integrations.bilibiliEnabled, true);
  assert.deepEqual(Buffer.from(await (await h.request(endpoint)).arrayBuffer()), png);
  assert.equal((await h.request('/console/api/outputs/fixture-output-1/upload/bilibili', 'POST', {})).status, 202);
});

test('local cloud verification fixtures preserve the original job and never simulate another upload', async t => {
  for (const [mode, expectedStatus, expectedCode, http] of [
    ['cloud-verify-success', 'completed', 'CLOUD_REMOTE_VERIFIED', 200],
    ['cloud-verify-unknown', 'unknown', 'CLOUD_FILE_NOT_FOUND', 200],
    ['cloud-verify-pending', 'completed', 'CLOUD_REMOTE_VERIFIED', 200],
    ['cloud-verify-error', 'unknown', 'VERIFY_UNAVAILABLE', 503],
  ]) {
    const h = await start(t, mode), before = await h.json('/console/api/bootstrap');
    const job = before.uploads.find(item => item.status === 'unknown');
    assert.match(job.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const endpoint = `/console/api/uploads/cloud189/${job.id}/verify`, headers = { 'X-CSRF-Token': (await h.json('/console/api/settings')).csrfToken };
    const response = await h.request(endpoint, 'POST', {}, headers), result = await response.json();
    assert.equal(response.status, http); assert.equal(result.code, expectedCode);
    const after = await h.json('/console/api/bootstrap');
    assert.equal(after.uploads.find(item => item.id === job.id).status, expectedStatus);
    assert.deepEqual(after.uploads.map(item => item.id), before.uploads.map(item => item.id));
    assert.deepEqual(after.outputs, before.outputs); assert.deepEqual(after.tasks, before.tasks);
    const info = await h.json('/__fixture__/info');
    assert.equal(info.verification.requests.length, 1); assert.deepEqual(info.verification.pendingIds, []);
    assert.deepEqual(info.mutations.map(item => item.path), [endpoint]);
    if (expectedStatus === 'completed') assert.equal((await h.request(endpoint, 'POST', {}, headers)).status, 409);
    else assert.equal((await h.request(endpoint, 'POST', {}, headers)).status, http);
  }
});

test('local cloud verification delay, duplicate, CSRF, body and session guards stay deterministic', async t => {
  const h = await start(t, 'cloud-verify-pending'), before = await h.json('/console/api/bootstrap');
  const job = before.uploads.find(item => item.status === 'unknown'), endpoint = `/console/api/uploads/cloud189/${job.id}/verify`;
  const headers = { 'X-CSRF-Token': (await h.json('/console/api/settings')).csrfToken };
  assert.equal((await h.request(endpoint, 'POST', {})).status, 403);
  assert.equal((await h.request(endpoint, 'POST', { extra: true }, headers)).status, 400);
  assert.equal((await h.request(endpoint, 'POST', [], headers)).status, 400);
  assert.equal((await h.request(endpoint.replace(job.id, 'invalid'), 'POST', {}, headers)).status, 400);
  const pending = h.request(endpoint, 'POST', {}, headers);
  // The first response remains pending while other requests are processed.
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await h.json('/console/api/bootstrap')).uploads.find(item => item.id === job.id).status, 'unknown');
  assert.equal((await h.json(endpoint, 'POST', {}, headers)).code, 'VERIFY_BUSY');
  assert.equal((await h.json('/__fixture__/info')).verification.requests.length, 1);
  await h.request('/status/logout', 'POST', {});
  assert.equal((await pending).status, 401);
  await h.request('/status/login', 'POST', { password: 'fixture-demo' });
  assert.equal((await h.json('/console/api/bootstrap')).uploads.find(item => item.id === job.id).status, 'unknown');
  await h.request('/?fixture=preparation');
  assert.equal((await h.request(endpoint, 'POST', {}, headers)).status, 409);
});

test('server fixture provides stable creation times for mixed-status chronological UI review', async t => {
  const h = await start(t), data = await h.json('/console/api/bootstrap');
  assert.deepEqual([...data.tasks].sort((a, b) => b.queuedAt - a.queuedAt).map(task => task.status), ['queued', 'completed', 'error', 'downloading']);
  assert.deepEqual([...data.uploads].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(task => task.status), ['completed', 'unknown', 'uploading']);
});

test('local synthetic cloud recovery releases rename and retains original remote result', async t => {
  const h = await start(t, 'cloud-recovery'), headers = { 'x-csrf-token': 'fixture-csrf-not-a-real-token' };
  const before = await h.json('/console/api/bootstrap'), job = before.uploads[0], file = before.outputs[0];
  const path = `/console/api/uploads/cloud189/${job.id}`;
  assert.equal(file.busyReason, 'verification');
  assert.equal((await h.request(path + '/retry', 'POST', {}, headers)).status, 400);
  assert.equal((await h.json(path + '/archive', 'POST', {}, headers)).applied, true);
  assert.equal((await h.json('/console/api/bootstrap')).outputs[0].busy, false);
  assert.equal((await h.request(`/console/api/outputs/${file.id}`, 'PUT', { newName: 'renamed.mp4' })).status, 200);
  assert.equal((await h.request(`/console/api/outputs/${file.id}/upload/cloud189`, 'POST', {})).status, 409);
  assert.equal((await h.json(path + '/restore', 'POST', {}, headers)).applied, true);
  const restored = await h.json('/console/api/bootstrap');
  assert.equal(restored.uploads[0].filename, 'renamed.mp4'); assert.equal(restored.uploads[0].remoteFilename, job.filename);
  assert.equal((await h.json(path + '/retry', 'POST', { confirmRetry: true }, headers)).applied, true);
  const after = await h.json('/console/api/bootstrap');
  assert.equal(after.uploads.length, before.uploads.length); assert.equal(after.uploads[0].status, 'queued');
  assert.equal(after.uploads[0].attemptHistory[0].status, 'unknown');
});


test('local DVR live preview and attachment downloads use only the synthetic fixture video', async t => {
  const h = await start(t), data = await h.json('/console/api/bootstrap');
  const live = await h.request(`/console/api/dvrs/${data.dvrs[0].id}/live?channel=101&format=compat`);
  assert.equal(live.status, 200); assert.match(await live.text(), /synthetic-fixture-media/);
  const download = await h.request(`${data.outputs[0].streamUrl}?download=1`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.match(await download.text(), /synthetic-fixture-media/);
});

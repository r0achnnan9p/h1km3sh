import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { cameraSourceIdentity } from '../lib/source-identity.js';
import { createMediaJobStore } from '../lib/media-job-store.js';
import { prepareCameraJob } from '../lib/camera-jobs.js';
import { prepareMatchJob } from '../lib/match-job.js';

const camera = { id: 'A', deviceId: 'dvr1', channel: '101', archivePath: 'A' };
const device = { id: 'dvr1', ip: '192.0.2.1', httpPort: 80, rtspPort: 554, password: 'FAKE-secret' };
const config = { archiveRoot: '/tmp/source-root', playbackUrl: 'http://127.0.0.1:9996' };
const args = { camera: 'A', start: '2020-01-01 00:00:00', end: '2020-01-01 00:01:00' };
const identity = cameraSourceIdentity(camera, device, config);
const dependencies = { resolveCamera: () => ({ camera, device }), sourceConfigIdentity: () => config, archive: {}, startHikvision: () => {}, downloadsDir: '/tmp' };

test('DVR-free source identities are stable and never collide with bound or remapped sources', () => {
  const local = { id: 'd1', name: 'Local', archivePath: 'd1' };
  const identity = cameraSourceIdentity(local, null, config);
  assert.equal(identity, cameraSourceIdentity({ ...local, name: 'Renamed' }, null, config));
  assert.notEqual(identity, cameraSourceIdentity(local, device, config));
  assert.notEqual(identity, cameraSourceIdentity({ ...local, archivePath: 'd2' }, null, config));
  // Pin the pre-change construction so existing DVR-bound caches remain reusable.
  const expected = crypto.createHash('sha256').update(JSON.stringify({ version: 1, camera: camera.id,
    deviceId: device.id, endpoint: '192.0.2.1|80|554', channel: camera.channel,
    archivePath: camera.archivePath, archiveRoot: config.archiveRoot, playbackUrl: `${config.playbackUrl}/` })).digest('hex');
  assert.equal(cameraSourceIdentity(camera, device, config), expected);
});

test('source identity covers mapping, stable DVR ID, endpoint ports, archive root and playback URL without credentials', () => {
  const variants = [
    cameraSourceIdentity({ ...camera, channel: '201' }, device, config),
    cameraSourceIdentity({ ...camera, archivePath: 'B' }, device, config),
    cameraSourceIdentity(camera, { ...device, id: 'dvr2' }, config),
    cameraSourceIdentity(camera, { ...device, ip: '192.0.2.2' }, config),
    cameraSourceIdentity(camera, { ...device, httpPort: 8080 }, config),
    cameraSourceIdentity(camera, { ...device, rtspPort: 8554 }, config),
    cameraSourceIdentity(camera, device, { ...config, archiveRoot: '/tmp/other-root' }),
    cameraSourceIdentity(camera, device, { ...config, playbackUrl: 'http://127.0.0.1:9997' }),
  ];
  for (const value of variants) assert.notEqual(value, identity);
  assert.equal(cameraSourceIdentity(camera, { ...device, username: 'new', password: 'rotated' }, config), identity);
  assert.equal(cameraSourceIdentity(camera, device, { ...config, playbackUrl: 'http://user:FAKE-secret@127.0.0.1:9996' }), identity);
  assert.match(identity, /^[a-f0-9]{64}$/);
});
test('camera and batch identities snapshot sources and recovery refuses missing/drifted provenance', () => {
  const job = prepareCameraJob('clip', args, dependencies);
  assert.equal(job.sourceIdentity, identity);
  assert.equal(job.recoveryRequest.sourceIdentity, identity);
  assert.ok(!JSON.stringify(job.recoveryRequest).includes('FAKE-secret'));
  assert.equal(prepareCameraJob('clip', args, { ...dependencies, recoveryRequest: job.recoveryRequest }).sourceIdentity, identity);
  assert.throws(() => prepareCameraJob('clip', args, { ...dependencies, recoveryRequest: { ...job.recoveryRequest, sourceIdentity: undefined } }), /来源配置/);
  assert.throws(() => prepareCameraJob('clip', args, { ...dependencies, recoveryRequest: job.recoveryRequest, resolveCamera: () => ({ camera: { ...camera, channel: '201' }, device }) }), /来源配置/);
  const remapped = { ...dependencies, resolveCamera: () => ({ camera, device: { ...device, id: 'dvr2' } }) };
  const nextJob = prepareCameraJob('clip', args, remapped);
  assert.notEqual(nextJob.sourceIdentity, job.sourceIdentity); assert.notEqual(nextJob.requestKey, job.requestKey);
  const batch = prepareMatchJob({ ...args, cameras: ['A'] }, dependencies);
  const nextBatch = prepareMatchJob({ ...args, cameras: ['A'] }, remapped);
  assert.equal(batch.requests[0].sourceIdentity, identity);
  assert.notEqual(batch.requestKey, nextBatch.requestKey);
});
test('completed single and batch files reuse only exact provenance; unknown historical outputs remain readable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMediaJobStore(path.join(root, 'jobs'));
  const file = { filename: 'clip.mp4', camera: 'A', start: args.start, end: args.end, mode: 'copy', size: 5, artifactUrl: '/artifact/clip.mp4', sourceIdentity: identity };
  fs.writeFileSync(path.join(root, file.filename), 'video');
  const taskId = crypto.randomUUID();
  store.save({ taskId, status: 'completed', kind: 'clip', ...file });
  assert.equal(store.read(taskId).sourceIdentity, identity);
  assert.equal(store.findByRange(file, root).sourceIdentity, identity);
  assert.equal(store.findByRange({ ...file, sourceIdentity: cameraSourceIdentity(camera, { ...device, id: 'dvr2' }, config) }, root), null);
  assert.equal(store.findByRange({ ...file, sourceIdentity: cameraSourceIdentity({ ...camera, archivePath: 'B' }, device, config) }, root), null);
  assert.equal(store.findByRange({ ...file, sourceIdentity: cameraSourceIdentity(camera, device, { ...config, playbackUrl: 'http://127.0.0.1:9997' }) }, root), null);
  assert.equal(store.findByRange({ ...file, sourceIdentity: undefined }, root), null);
  const batchId = crypto.randomUUID(); store.save({ taskId: batchId, status: 'completed', kind: 'batch', files: [file] });
  assert.equal(store.findFile(file, root).sourceIdentity, identity);
  assert.equal(store.findFile({ ...file, sourceIdentity: 'b'.repeat(64) }, root), null);
  assert.equal(store.findFile({ ...file, sourceIdentity: undefined }, root), null);
  const oldId = crypto.randomUUID(), { sourceIdentity, ...historical } = file;
  store.save({ taskId: oldId, status: 'completed', kind: 'clip', ...historical, filename: 'old.mp4' });
  fs.writeFileSync(path.join(root, 'old.mp4'), 'video');
  assert.equal(store.read(oldId).filename, 'old.mp4');
  assert.equal(store.findByRange(file, root, 'old.mp4'), null);
  assert.equal(fs.readFileSync(path.join(root, 'old.mp4'), 'utf8'), 'video');
});

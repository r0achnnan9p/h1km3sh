import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareConsoleExport } from '../lib/console-export.js';

const range = { start: '2026-01-01 10:00', end: '2026-01-01 10:01' };
const device = { id: 'recorder-one', ip: '192.0.2.1', username: 'fixture', password: 'private-fixture' };
function dependencies(overrides = {}) {
  return { getDevice: id => id === device.id ? device : null,
    resolveCamera: id => ({ camera: { id, channel: '101' }, device }),
    archive: { hasRecording: async () => ({ exists: true }) }, ...overrides };
}

test('DVR export uses selected recorder/channel without any MediaMTX camera or archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-export-'));
  try {
    const input = path.join(dir, 'in.mp4'), outputFile = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'fixture');
    let call;
    const job = prepareConsoleExport({ source: 'hikvision', deviceId: device.id, channel: '201', ...range }, dependencies({
      resolveCamera: () => { throw new Error('must not resolve an alias'); },
      archive: { hasRecording: () => { throw new Error('must not query MediaMTX'); } },
      startHikvision: async options => { call = options; return input; },
    }));
    const reservation = { taskId: 'queued-task' };
    const result = await job.execute({ signal: new AbortController().signal, outputFile, reservation });
    assert.equal(result.source, 'hikvision');
    assert.equal(call.camera.channel, '201');
    assert.equal(call.device, device);
    assert.equal(call.reservation, reservation);
    assert.equal(call.method, 'rtspclip');
    assert.equal(fs.readFileSync(outputFile, 'utf8'), 'fixture');
    assert.ok(!JSON.stringify({ requestKey: job.requestKey, cameraId: job.cameraId }).includes(device.password));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MediaMTX selection retains alias lookup and archive preference including existing clients', async () => {
  for (const source of [undefined, 'mediamtx']) {
    let alias;
    const job = prepareConsoleExport({ source, camera: 'D2', ...range }, dependencies({
      resolveCamera: id => { alias = id; return { camera: { id, channel: '201' }, device }; },
    }));
    assert.equal(alias, 'D2');
    assert.equal((await job.plan({})).source, 'mediamtx');
  }
});

test('DVR queue identity separates recorder, channel and source, retaining repeat-submit identity', () => {
  const args = { source: 'hikvision', deviceId: device.id, channel: '201', ...range };
  const first = prepareConsoleExport(args, dependencies());
  assert.equal(first.requestKey, prepareConsoleExport(args, dependencies()).requestKey);
  assert.notEqual(first.requestKey, prepareConsoleExport({ ...args, channel: '101' }, dependencies()).requestKey);
  assert.notEqual(first.requestKey, prepareConsoleExport({ ...args, deviceId: 'recorder-two' }, dependencies({ getDevice: id => ({ ...device, id }) })).requestKey);
  assert.notEqual(first.requestKey, prepareConsoleExport({ source: 'mediamtx', camera: 'D2', ...range }, dependencies()).requestKey);
});

test('source, recorder, channel and method validation happen before queue admission', () => {
  for (const changes of [{ source: 'unknown' }, { deviceId: 'missing' }, { channel: '201\r\n' }, { channel: '' }, { dvrMethod: 'bad' }]) {
    assert.throws(() => prepareConsoleExport({ source: 'hikvision', deviceId: device.id, channel: '201', ...range, ...changes }, dependencies()));
  }
});

test('selecting DVR without a configured recorder fails clearly without looking up a default', () => {
  assert.throws(() => prepareConsoleExport({ source: 'hikvision', ...range }, dependencies({ getDevice: () => assert.fail('must not select a default') })), /未配置.*DVR/);
});

test('automatic MediaMTX and DVR filenames use underscore ranges, full dates and unique suffixes', () => {
  for (const selection of [{ source: 'mediamtx', camera: 'D2' }, { source: 'hikvision', deviceId: device.id, channel: '201' }]) {
    const args = { ...selection, start: '2026-01-01 23:55:00', end: '2026-01-02 00:05:00' };
    const first = prepareConsoleExport(args, dependencies()), second = prepareConsoleExport(args, dependencies());
    assert.match(first.filename, /2026-01-01 23-55-00_2026-01-02 00-05-00 [a-f0-9]{8}\.mp4$/);
    assert.ok(!first.filename.includes('至')); assert.notEqual(first.filename, second.filename);
    assert.equal(first.recoveryRequest.filename, first.filename);
  }
});

test('opted-in SDK DVR rejects exports longer than one hour before admission without affecting other sources', () => {
  const id = 'b88a6eb6-967c-47bd-b75f-1e61c85d873b', sdkDevice = { ...device, id };
  const oldDir = process.env.HIKVISION_SDK_DIR, oldIds = process.env.HIKVISION_SDK_DEVICE_IDS;
  process.env.HIKVISION_SDK_DIR = '/opt/test-sdk'; process.env.HIKVISION_SDK_DEVICE_IDS = id;
  try {
    const deps = dependencies({ getDevice: value => value === id ? sdkDevice : device });
    const args = { source: 'hikvision', deviceId: id, channel: '201', start: '2026-01-01 10:00', end: '2026-01-01 11:00:01' };
    assert.throws(() => prepareConsoleExport(args, deps), /最多 1 小时/);
    assert.equal(prepareConsoleExport({ ...args, end: '2026-01-01 11:00:00' }, deps).source, 'hikvision');
    assert.equal(prepareConsoleExport({ ...args, deviceId: device.id }, deps).source, 'hikvision');
  } finally {
    if (oldDir === undefined) delete process.env.HIKVISION_SDK_DIR; else process.env.HIKVISION_SDK_DIR = oldDir;
    if (oldIds === undefined) delete process.env.HIKVISION_SDK_DEVICE_IDS; else process.env.HIKVISION_SDK_DEVICE_IDS = oldIds;
  }
});

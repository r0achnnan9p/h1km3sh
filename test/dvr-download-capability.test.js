/** Offline-only capability transport/schema/deadline regression tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectDvrRecordingDiagnostics, readDownloadCapabilities } from '../lib/dvr-recording-inspection.js';
import { sanitizeDvrRecordingDiagnostics } from '../lib/dvr-recording-diagnostics.js';
import { dvrExportError, dvrExportFailure } from '../lib/dvr-export-errors.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { createMediaJobStore } from '../lib/media-job-store.js';

const options = { ip: '192.0.2.41', httpPort: 8081, rtspPort: 8554, user: 'private-user', pass: 'private-password', channel: '201', startTime: '20261001T214026Z', endTime: '20261001T214036Z' };
const file = { channel: '201', startTime: '2026-10-01T21:40:00Z', endTime: '2026-10-01T21:41:00Z', size: 5242880, playbackURI: 'rtsp://192.0.2.41:8554/Streaming/tracks/201/?starttime=20261001T214000Z&endtime=20261001T214100Z&name=private-name&size=5242880' };
const secret = 'private-user private-password private-name rtsp://private-host/secret rawstderr SDP';
const safe = result => assert.doesNotMatch(JSON.stringify(result), /private-|rtsp:\/\/|rawstderr|SDP/);
const xml = value => `<DownloadAbility version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><isSupportDownloadbyTime>${value}</isSupportDownloadbyTime></DownloadAbility>`;
const response = async body => readDownloadCapabilities(options, { exec: async () => ({ stdout: body + '\n200' }) });

for (const [value, expected] of [['true', 'supported'], ['false', 'unsupported'], ['1', 'supported'], ['0', 'unsupported']]) {
  test(`exact DownloadAbility boolean ${value} yields ${expected}`, async () => assert.equal(await response(xml(value)), expected));
}

test('one fixed-origin GET uses no body/redirect/retry/config inheritance and caps bytes/time', async () => {
  let calls = 0;
  const controller = new AbortController();
  assert.equal(await readDownloadCapabilities({ ...options, signal: controller.signal, budgetMs: 120 }, { exec: async (command, args, settings) => {
    calls++; assert.ok(command === 'curl' || command === 'curl.exe');
    assert.equal(args[0], '--disable'); assert.equal(args.includes('--max-redirs'), false); assert.ok(args.includes('--no-location'));
    assert.equal(args[args.indexOf('-X') + 1], 'GET');
    assert.equal(args.at(-1), 'http://192.0.2.41:8081/ISAPI/ContentMgmt/download/capabilities');
    assert.equal(args[args.indexOf('--max-time') + 1], '0.12');
    for (const forbidden of ['-L', '--location', '--retry', '--data', '--data-binary', '-o']) assert.equal(args.includes(forbidden), false);
    assert.equal(settings.timeout, 120); assert.equal(settings.maxBuffer, 65536); assert.equal(settings.killSignal, 'SIGKILL'); assert.equal(settings.signal, controller.signal);
    return { stdout: xml('true') + '\n200' };
  } }), 'supported');
  assert.equal(calls, 1);
});

test('unknown/missing/conflicting schema, unsafe XML and oversized responses stay unknown', async () => {
  for (const body of [
    xml('true') + '<DownloadAbility>', xml('true') + '<Other>', xml('true') + '<DownloadAbility',
    xml('true') + 'junk', xml('true') + '<Other/>', xml('true') + '<', xml('true') + xml('false'),
    xml('true').replace('<isSupport', 'junk<isSupport'),
    '<DownloadAbility/>', '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>', xml('yes'), xml(secret),
    xml('true').replaceAll('isSupportDownloadbyTime', 'isSupportDownloadByTime'),
    xml('true').replaceAll('DownloadAbility', 'DeviceCap'),
    xml('true').replace('http://www.isapi.org/ver20/XMLSchema', 'https://private-host/schema'),
    xml('true').replace('</DownloadAbility>', '<isSupportDownloadbyTime>false</isSupportDownloadbyTime></DownloadAbility>'),
    xml('<value>true</value>'), '<DownloadAbility><nested><isSupportDownloadbyTime>true</isSupportDownloadbyTime></nested></DownloadAbility>',
    '<!DOCTYPE DownloadAbility [<!ENTITY secret "true">]>' + xml('&secret;'),
    '<DownloadAbility>' + 'x'.repeat(65536) + '</DownloadAbility>', 'not xml ' + secret,
  ]) assert.equal(await response(body), 'unknown');
});

test('redirect/auth/server/transport errors cannot produce support or expose payload', async () => {
  for (const status of [301, 302, 307, 401, 403, 404, 500]) {
    const result = await readDownloadCapabilities(options, { exec: async () => ({ stdout: xml('true') + secret + `\n${status}` }) });
    assert.equal(result, 'unknown'); safe(result);
  }
  for (const error of [new Error(secret), Object.assign(new Error(secret), { code: 28 }), Object.assign(new Error(secret), { killed: true })]) {
    assert.equal(await readDownloadCapabilities(options, { exec: async () => { throw error; } }), 'unknown');
  }
});

test('capability cancellation never starts an already-aborted transport or accepts late data', async () => {
  const controller = new AbortController(); controller.abort();
  assert.equal(await readDownloadCapabilities({ ...options, signal: controller.signal }, { exec: () => assert.fail('must not start') }), 'unknown');
  const later = new AbortController();
  assert.equal(await readDownloadCapabilities({ ...options, signal: later.signal }, { exec: async () => { later.abort(); return { stdout: xml('true') + '\n200' }; } }), 'unknown');
});

test('cache avoids search while exactly one capability check still runs with identical origin', async () => {
  let calls = 0;
  const result = await collectDvrRecordingDiagnostics(options, { lookup: () => [file], search: () => assert.fail('cache must be reused'), capabilities: async query => {
    calls++; assert.equal(query.ip, options.ip); assert.equal(query.httpPort, options.httpPort); assert.equal(query.user, options.user); assert.equal(query.pass, options.pass);
    return 'supported';
  } });
  assert.equal(calls, 1); assert.equal(result.source, 'cache'); assert.equal(result.outcome, 'available'); assert.equal(result.downloadByTime, 'supported'); safe(result);
});

test('search and capabilities start together and share one watchdog, retaining finished search', async () => {
  let searchStarted = false, capStarted = false, capAborted = false;
  const began = Date.now();
  const result = await collectDvrRecordingDiagnostics(options, { budgetMs: 45, lookup: () => null,
    search: async () => { searchStarted = true; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(capStarted, true); return { files: [file] }; },
    capabilities: ({ signal }) => { capStarted = true; assert.equal(searchStarted, true); signal.addEventListener('abort', () => { capAborted = true; }); return new Promise(() => {}); },
  });
  assert.equal(result.outcome, 'available'); assert.equal(result.downloadByTime, 'unknown'); assert.equal(capAborted, true);
  assert.ok(Date.now() - began < 500, 'must not append a second production five-second budget'); safe(result);
});

test('one deadline aborts both stuck readers; partial capability result survives search timeout', async () => {
  let aborted = 0;
  const stuck = ({ signal }) => { signal.addEventListener('abort', () => aborted++); return new Promise(() => {}); };
  const both = await collectDvrRecordingDiagnostics(options, { budgetMs: 20, lookup: () => null, search: stuck, capabilities: stuck });
  assert.equal(aborted, 2); assert.equal(both.outcome, 'timeout'); assert.equal(both.downloadByTime, 'unknown');
  const partial = await collectDvrRecordingDiagnostics(options, { budgetMs: 20, lookup: () => null, search: stuck, capabilities: async () => 'unsupported' });
  assert.equal(partial.outcome, 'timeout'); assert.equal(partial.downloadByTime, 'unsupported'); safe(partial);
});

test('cancel interrupts both readers and primary search failure remains independent of capability', async () => {
  const controller = new AbortController(); let started = 0, aborted = 0, ready;
  const allStarted = new Promise(resolve => { ready = resolve; });
  const stuck = ({ signal }) => { signal.addEventListener('abort', () => aborted++); if (++started === 2) ready(); return new Promise(() => {}); };
  const pending = collectDvrRecordingDiagnostics({ ...options, signal: controller.signal }, { lookup: () => null, search: stuck, capabilities: stuck });
  await allStarted; controller.abort(); const cancelled = await pending;
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.downloadByTime, 'unknown'); assert.equal(aborted, 2);
  const failed = await collectDvrRecordingDiagnostics(options, { lookup: () => null, search: async () => { throw Object.assign(new Error(secret), { code: 'AUTHENTICATION' }); }, capabilities: async () => 'supported' });
  assert.equal(failed.outcome, 'authentication'); assert.equal(failed.downloadByTime, 'supported'); safe(failed);
  const error = dvrExportError('DVR_RTSP_REJECTED', { method: 'DESCRIBE', rtspStatus: 400, recording: failed });
  assert.equal(dvrExportFailure(error).failureCode, 'DVR_RTSP_REJECTED'); assert.match(error.message, /录像机拒绝/);
});

test('unknown capability objects/getters remain closed and support fact survives durable stores', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-cap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recording = await collectDvrRecordingDiagnostics(options, { lookup: () => [file], capabilities: async () => 'supported' });
  for (const value of [secret, {}, ['supported'], Object.create({ toString: () => 'supported' })]) {
    const sanitized = sanitizeDvrRecordingDiagnostics({ ...recording, downloadByTime: value, raw: secret });
    assert.equal(sanitized.downloadByTime, undefined); safe(sanitized);
  }
  const accessor = Object.defineProperty({ ...recording }, 'downloadByTime', { get() { assert.fail('must not invoke getter'); } });
  assert.equal(sanitizeDvrRecordingDiagnostics(accessor).downloadByTime, undefined);
  const task = { taskId: crypto.randomUUID(), queuedAt: 10, status: 'error', source: 'hikvision', ...dvrExportFailure(dvrExportError('DVR_RTSP_REJECTED', { method: 'DESCRIBE', rtspStatus: 400, recording: { ...recording, raw: secret } })) };
  createExportRecoveryStore(path.join(root, 'queue')).admit(task, { type: 'camera', deviceId: 'fixture' });
  createMediaJobStore(path.join(root, 'media')).save(task);
  for (const actual of [createExportRecoveryStore(path.join(root, 'queue')).load()[0].task, createMediaJobStore(path.join(root, 'media')).read(task.taskId)]) {
    assert.equal(actual.failureDiagnostics.recording.downloadByTime, 'supported'); safe(actual);
  }
});

/** Offline transport fixtures only. No configured device, credential file, or service reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { runDvrHttpSample, sanitizeDvrHttpSample, cleanupInterruptedDvrHttpSamples,
  DVR_HTTP_SAMPLE_MAX_BYTES, DVR_HTTP_SAMPLE_TIMEOUT_MS } from '../lib/dvr-http-sample.js';

const device = { id: 'fixture-device', ip: '192.0.2.44', httpPort: 8080, rtspPort: 8554,
  username: 'private-user', password: 'private-password' };
const options = { device, channel: '201', startTime: '20261001T214026Z', endTime: '20261001T214036Z' };
const record = { startTime: '2026-10-01T21:40:20Z', endTime: '2026-10-01T21:40:50Z', channel: '201', size: 1_060_000_000,
  playbackURI: 'rtsp://192.0.2.44:8554/Streaming/tracks/201/?starttime=20261001T214020Z&endtime=20261001T214050Z&name=private-selector&size=1060000000' };
const payload = Buffer.concat([Buffer.from([0, 0, 1, 0xba]), Buffer.alloc(1020)]);
const header = (status = 200, extra = 'Content-Type: application/octet-stream\r\n') => Buffer.from(`HTTP/1.1 ${status} Fixture\r\n${extra}\r\n`);
const safe = value => assert.doesNotMatch(JSON.stringify(value), /private-|rtsp:\/\/|rawstderr|sample\.bin|request\.xml|SDP/);
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-sample-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const probeJson = JSON.stringify({ format: { format_name: 'mpeg' }, streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' },
] });
const frameHash = '#tb 0: 1/25\n' + [100, 101, 102].map(pts => `0, ${pts}, ${pts}, 1, 12, ${'a'.repeat(32)}\n`).join('');
function childFixture(script, { autoCloseOnKill = true } = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.closed = false;
  child.close = (code = 0) => {
    if (child.closed) return; child.closed = true;
    child.stdout.end(); child.stderr.end(); child.emit('close', code, child.kills.length ? 'SIGKILL' : null);
  };
  child.kill = signal => { child.kills.push(signal); if (autoCloseOnKill) setImmediate(() => child.close(null)); return true; };
  setImmediate(() => { if (!child.closed) script(child); });
  return child;
}
function harness(t, { chunks = [header(), payload], transferCode = 0, transferScript, probeScript,
  decodeScript, autoCloseOnKill = true, onSpawn } = {}) {
  const root = temp(t), calls = [], children = [], paths = [];
  const mockSpawn = (binary, args, opts) => {
    calls.push({ binary, args, opts }); onSpawn?.(binary, args, opts);
    let script;
    if (/curl(?:\.exe)?$/.test(binary)) {
      const request = args[args.indexOf('--data-binary') + 1].slice(1); paths.push(request, path.join(path.dirname(request), 'sample.bin'));
      script = transferScript || (child => { for (const chunk of chunks) { if (!child.stdout.destroyed) child.stdout.write(chunk); } child.close(transferCode); });
    } else if (/ffprobe$/.test(binary)) script = probeScript || (child => { child.stdout.write(probeJson); child.close(); });
    else script = decodeScript || (child => { child.stdout.write(frameHash); child.close(); });
    const child = childFixture(script, { autoCloseOnKill }); children.push(child); return child;
  };
  return { root, calls, children, paths,
    run: (changes = {}, deps = {}) => runDvrHttpSample({ ...options, privateRoot: root, ...changes },
      { lookup: () => [record], spawn: mockSpawn, ...deps }),
    cleaned() { assert.deepEqual(fs.readdirSync(root), []); for (const p of paths) assert.equal(fs.existsSync(p), false); },
  };
}

test('bounded, closed sample facts decode and expose no paths, selectors, credentials or raw logs', async t => {
  const h = harness(t); const result = await h.run();
  assert.deepEqual(result, { outcome: 'decoded', stopReason: 'eof', phase: 'decode', curlExitCode: 0, httpStatus: 200, bytes: payload.length,
    mediaType: 'mpegps', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080,
    decodedFrames: 3, firstPtsSeconds: 0, lastPtsSeconds: 0.08 });
  safe(result); h.cleaned(); assert.equal(h.calls.length, 3);
  assert.equal(DVR_HTTP_SAMPLE_MAX_BYTES, 32_000_000); assert.equal(DVR_HTTP_SAMPLE_TIMEOUT_MS, 20_000);
});

test('one fixed endpoint POST, original URI XML-escaped unchanged, private modes, no redirect/retry/resume', async t => {
  let before = 0, xml;
  const uri = record.playbackURI + '&opaque=<"\'>'; const file = { ...record, playbackURI: uri };
  const h = harness(t, { onSpawn(binary, args, opts) {
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    if (!/curl$/.test(binary)) return;
    assert.equal(before, 1); assert.equal(args[0], '--disable');
    for (const [flag, expected] of [['--retry', '0'], ['--proto', '=http'], ['--request', 'POST']]) assert.equal(args[args.indexOf(flag) + 1], expected);
    assert.equal(args.includes('--max-redirs'), false);
    assert.ok(args.includes('--no-location')); assert.ok(args.includes('--noproxy'));
    assert.equal(args.at(-1), 'http://192.0.2.44:8080/ISAPI/ContentMgmt/download');
    assert.equal(args.includes('-L'), false); assert.equal(args.includes('--location'), false);
    assert.equal(args.includes('--continue-at'), false); assert.equal(args.includes('--range'), false);
    const request = args[args.indexOf('--data-binary') + 1].slice(1); xml = fs.readFileSync(request, 'utf8');
    assert.equal(fs.statSync(request).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(request)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(path.dirname(request), 'sample.bin')).mode & 0o777, 0o600);
  } });
  assert.equal((await h.run({ beforeMedia: async () => { before++; } }, { lookup: () => [file] })).outcome, 'decoded');
  assert.equal(xml, `<downloadRequest><playbackURI>${uri.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</playbackURI></downloadRequest>`);
  h.cleaned();
});

test('a clipped search timeSpan and covering original URI are valid without rewriting selector times', async t => {
  const h = harness(t); const result = await h.run({}, { lookup: () => [{ ...record,
    startTime: '2026-10-01T21:40:26Z', endTime: '2026-10-01T21:40:36Z' }] });
  assert.equal(result.outcome, 'decoded'); assert.equal(h.calls.length, 3); h.cleaned();
});

test('cache miss uses exactly one exact-window first-page search before the single media attempt', async t => {
  const h = harness(t); let searches = 0;
  const result = await h.run({}, { lookup: () => null, search: async query => {
    searches++; assert.equal(query.startTime, '2026-10-01T21:40:26Z'); assert.equal(query.endTime, '2026-10-01T21:40:36Z');
    assert.equal(query.channel, '201'); assert.equal(query.httpPort, 8080); assert.ok(query.signal);
    return { files: [record], truncated: true };
  } });
  assert.equal(result.outcome, 'decoded'); assert.equal(searches, 1); h.cleaned();
});

test('default metadata search spawns/reaps through same process wrapper, never requests a second page', async t => {
  const root = temp(t); const calls = []; let searchPath;
  const result = await runDvrHttpSample({ ...options, privateRoot: root }, { lookup: () => null, spawn(binary, args) {
    calls.push(args); assert.match(args.at(-1), /\/ISAPI\/ContentMgmt\/search$/);
    assert.equal(args[0], '--disable'); assert.equal(args[args.indexOf('--noproxy') + 1], '*');
    assert.equal(args[args.indexOf('--proto') + 1], '=http');
    assert.ok(args.includes('--no-location')); assert.equal(args[args.indexOf('--retry') + 1], '0');
    searchPath = args[args.indexOf('--data-binary') + 1].slice(1);
    const xml = fs.readFileSync(searchPath, 'utf8');
    assert.match(xml, /<maxResults>40<\/maxResults>/); assert.match(xml, /<searchResultPostion>0<\/searchResultPostion>/);
    assert.match(xml, /<startTime>2026-10-01T21:40:26Z<\/startTime>/);
    return childFixture(child => { child.stdout.write('<CMSearchResult><responseStatus>true</responseStatus><numOfMatches>0</numOfMatches></CMSearchResult>\n200'); child.close(); });
  } });
  assert.equal(result.outcome, 'no_match'); assert.equal(calls.length, 1); assert.equal(fs.existsSync(searchPath), false);
  assert.equal(result.phase, 'search'); assert.equal(result.curlExitCode, 0); assert.equal(result.httpStatus, 200);
});

test('search curl exit 47 preserves its phase, exit and HTTP facts without starting media', async t => {
  const root = temp(t); let calls = 0;
  const result = await runDvrHttpSample({ ...options, privateRoot: root }, { lookup: () => null, spawn(binary, args) {
    calls++; assert.match(args.at(-1), /\/ISAPI\/ContentMgmt\/search$/);
    return childFixture(child => { child.stderr.write('private-user private-password rawstderr'); child.stdout.write('private-search-body\n401'); child.close(47); });
  } });
  assert.equal(result.outcome, 'failed'); assert.equal(result.stopReason, 'transport_error');
  assert.equal(result.phase, 'search'); assert.equal(result.curlExitCode, 47); assert.equal(result.httpStatus, 401);
  assert.equal(result.bytes, 0); assert.equal(calls, 1); safe(result); assert.deepEqual(fs.readdirSync(root), []);
});

for (const code of [7, 28]) test(`media curl exit ${code} before HTTP headers retains transport evidence`, async t => {
  const h = harness(t, { chunks: [], transferCode: code });
  const result = await h.run();
  assert.equal(result.outcome, code === 28 ? 'timeout' : 'failed');
  assert.equal(result.stopReason, code === 28 ? 'time_limit' : 'transport_error');
  assert.equal(result.phase, 'transfer'); assert.equal(result.curlExitCode, code);
  assert.equal(result.httpStatus, null); assert.equal(result.bytes, 0); assert.equal(h.calls.length, 1); safe(result); h.cleaned();
});

for (const operation of ['closeSync', 'readSync']) test(`local ${operation} failure retains completed transfer facts`, async t => {
  const h = harness(t), original = fs[operation]; let failed = false;
  const mocked = t.mock.method(fs, operation, (...args) => {
    if (!failed && h.paths.length && fs.fstatSync(args[0]).ino === fs.statSync(h.paths[1]).ino) {
      failed = true; throw new Error('private-path sample.bin rawstderr');
    }
    return original(...args);
  });
  const result = await h.run(); mocked.mock.restore();
  assert.equal(failed, true); assert.equal(result.outcome, 'failed'); assert.equal(result.stopReason, 'transport_error');
  assert.equal(result.phase, operation === 'closeSync' ? 'transfer' : 'probe'); assert.equal(result.curlExitCode, 0);
  assert.equal(result.httpStatus, 200); assert.equal(result.bytes, payload.length); safe(result); h.cleaned();
});

for (const [name, change] of [
  ['foreign host', { playbackURI: record.playbackURI.replace('192.0.2.44', '192.0.2.55') }],
  ['wrong RTSP port', { playbackURI: record.playbackURI.replace(':8554/', ':554/') }],
  ['wrong channel', { playbackURI: record.playbackURI.replace('/201/', '/101/') }],
  ['embedded credential', { playbackURI: record.playbackURI.replace('rtsp://', 'rtsp://private-user:private-password@') }],
  ['partial URI range', { playbackURI: record.playbackURI.replace('214020Z', '214030Z') }],
  ['duplicate URI time', { playbackURI: record.playbackURI + '&starttime=20261001T214020Z' }],
  ['dot segment path', { playbackURI: record.playbackURI.replace('/Streaming/', '/bad/../Streaming/') }],
  ['non RTSP scheme', { playbackURI: record.playbackURI.replace('rtsp:', 'http:') }],
  ['URI fragment', { playbackURI: record.playbackURI + '#private-secret' }],
]) test(`invalid selector (${name}) cannot consume approval or start HTTP media`, async t => {
  const h = harness(t); let before = 0;
  const result = await h.run({ beforeMedia: () => { before++; } }, { lookup: () => [{ ...record, ...change }] });
  assert.equal(result.outcome, 'invalid'); assert.equal(before, 0); assert.equal(h.calls.length, 0); safe(result); h.cleaned();
});

test('lying Content-Length cannot bypass exact active byte cap; oversized chunk is sliced once and child killed', async t => {
  let retained = null;
  const h = harness(t, { chunks: [header(200, 'Content-Length: 1\r\n'), Buffer.concat([payload, Buffer.alloc(200)])],
    onSpawn(binary, args) { if (/ffprobe$/.test(binary)) retained = fs.readFileSync(args.at(-1)); } });
  const result = await h.run({}, { maxBytes: 512 });
  assert.equal(result.bytes, 512); assert.equal(result.stopReason, 'byte_limit'); assert.equal(retained.length, 512);
  assert.deepEqual(retained, payload.subarray(0, 512)); assert.deepEqual(h.children[0].kills, ['SIGKILL']); h.cleaned();
});

test('chunked transfer ignores declared framing and bounds decoded curl body bytes across chunks', async t => {
  const h = harness(t, { chunks: [header(200, 'Transfer-Encoding: chunked\r\n'), payload.subarray(0, 600), payload.subarray(600)] });
  const result = await h.run({}, { maxBytes: 900 });
  assert.equal(result.bytes, 900); assert.equal(result.stopReason, 'byte_limit'); assert.equal(h.children[0].kills[0], 'SIGKILL'); h.cleaned();
});

test('strict decimal 32 MB hard ceiling cannot be increased by injected settings', async t => {
  const h = harness(t, { chunks: [header(), Buffer.concat([payload.subarray(0, 4), Buffer.alloc(32_000_010)])] });
  const result = await h.run({}, { maxBytes: 40_000_000 });
  assert.equal(result.bytes, 32_000_000); assert.equal(result.stopReason, 'byte_limit'); h.cleaned();
});

test('Digest challenge then success is one child and challenge headers are not sample bytes', async t => {
  const h = harness(t, { chunks: [header(401, 'WWW-Authenticate: Digest realm="private-realm", nonce="private-nonce"\r\nContent-Length: 17\r\n'), header(), payload] });
  const result = await h.run(); assert.equal(result.outcome, 'decoded'); assert.equal(result.httpStatus, 200);
  assert.equal(result.bytes, payload.length); assert.equal(h.calls.filter(call => /curl$/.test(call.binary)).length, 1); safe(result); h.cleaned();
});

for (const status of [301, 302, 307, 401, 403, 404, 500]) test(`HTTP ${status} never decodes, follows redirects, or retries`, async t => {
  const h = harness(t, { chunks: [header(status, 'Location: http://private-target/\r\n'), Buffer.from('private-error-body')], transferCode: 22 });
  const result = await h.run();
  assert.equal(result.outcome, status === 401 || status === 403 ? 'authentication' : 'http_error');
  assert.equal(result.bytes, 0); assert.equal(result.httpStatus, status); assert.equal(h.calls.length, 1); safe(result); h.cleaned();
});

test('a repeated Digest refusal is killed, never retried as a second media process', async t => {
  const h = harness(t, { chunks: [header(401), header(401), header(), payload] });
  const result = await h.run(); assert.equal(result.outcome, 'authentication'); assert.equal(result.httpStatus, 401);
  assert.equal(h.calls.length, 1); assert.equal(result.bytes, 0); assert.equal(h.children[0].kills[0], 'SIGKILL'); h.cleaned();
});

for (const chunks of [
  [Buffer.from('HTTP/1.1 secret rawstderr\r\n\r\n'), payload],
  [Buffer.from('HTTP/1.1 666 rawstderr\r\n\r\n'), payload],
  [Buffer.from('HTTP/1.1 200 OK\r\nX: ' + 'a'.repeat(40_000)), payload],
  [header(200, 'Content-Type: application/xml\r\n'), Buffer.from('<ResponseStatus>private-error</ResponseStatus>')],
  [header(), Buffer.from('<ResponseStatus>private-error</ResponseStatus>')],
  [header(), Buffer.from('{"error":"private-error"}')],
  [header(), Buffer.from('private-error-body')],
]) test('malformed HTTP or XML/JSON/error body is never passed to a decoder', async t => {
  const h = harness(t, { chunks }); const result = await h.run();
  assert.ok(['invalid', 'undecodable'].includes(result.outcome)); assert.equal(h.calls.length, 1); safe(result); h.cleaned();
});

test('header split boundaries preserve body and do not use Content-Length', async t => {
  const wire = Buffer.concat([header(), payload]);
  const h = harness(t, { chunks: [...wire].map(byte => Buffer.from([byte])) });
  const result = await h.run(); assert.equal(result.bytes, payload.length); assert.equal(result.outcome, 'decoded'); h.cleaned();
});

test('byte-limit result waits for curl close before decoding, cleanup or promise settlement', async t => {
  let curl, settled = false; const h = harness(t, { autoCloseOnKill: false, transferScript(child) { curl = child; child.stdout.write(header()); child.stdout.write(payload); } });
  const promise = h.run({}, { maxBytes: 512 }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(curl.kills, ['SIGKILL']); assert.equal(settled, false); assert.equal(h.calls.length, 1);
  assert.equal(fs.existsSync(h.paths[1]), true); curl.close(null);
  assert.equal((await promise).outcome, 'decoded'); h.cleaned();
});

test('timeout includes authentication wait and kills/reaps before promise resolves', async t => {
  let curl, settled = false; const h = harness(t, { autoCloseOnKill: false,
    transferScript(child) { curl = child; child.stdout.write(header(401)); } });
  const promise = h.run({}, { timeoutMs: 10 }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(curl.kills, ['SIGKILL']); assert.equal(settled, false); curl.close(null);
  const result = await promise; assert.equal(result.stopReason, 'time_limit'); assert.equal(result.bytes, 0); h.cleaned();
});

test('search consumes the same deadline; cancellation is awaited and never starts media', async t => {
  const h = harness(t); let aborted = false;
  const result = await h.run({}, { timeoutMs: 10, lookup: () => null, search: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; setTimeout(() => reject(Object.assign(new Error('private-search-error'), { code: 'CANCELLED' })), 5); });
  }) });
  assert.equal(aborted, true); assert.equal(result.outcome, 'timeout'); assert.equal(h.calls.length, 0); h.cleaned();
});

test('deadline or cancellation during durable beforeMedia never spawns late', async t => {
  for (const cancel of [false, true]) {
    const h = harness(t), controller = new AbortController(); let before = 0;
    const result = await h.run({ signal: controller.signal, beforeMedia: async () => {
      before++; if (cancel) controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
    } }, { timeoutMs: 10 });
    assert.equal(before, 1); assert.equal(result.outcome, cancel ? 'cancelled' : 'timeout'); assert.equal(h.calls.length, 0); h.cleaned();
  }
});

test('explicit cancellation kills immediately but retains files and queue lease until child close', async t => {
  let curl, settled = false; const controller = new AbortController();
  const h = harness(t, { autoCloseOnKill: false, transferScript(child) { curl = child; child.stdout.write(header()); child.stdout.write(payload); } });
  const promise = h.run({ signal: controller.signal }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(curl.kills, ['SIGKILL']); assert.equal(settled, false); assert.equal(fs.existsSync(h.paths[1]), true);
  curl.close(null); const result = await promise;
  assert.equal(result.outcome, 'cancelled'); assert.equal(h.calls.length, 1); h.cleaned();
});

test('already-cancelled input starts neither search nor process nor authorization consumption', async t => {
  const h = harness(t), controller = new AbortController(); controller.abort();
  const result = await h.run({ signal: controller.signal, beforeMedia: () => assert.fail('must not consume') }, { lookup: () => assert.fail('must not search') });
  assert.equal(result.outcome, 'cancelled'); assert.equal(h.calls.length, 0); h.cleaned();
});

test('probe/decode timeouts are bounded, reaped and privately cleaned', async t => {
  for (const phase of ['probe', 'decode']) {
    let stuck;
    const h = harness(t, { [`${phase}Script`]: child => { stuck = child; } });
    const result = await h.run({}, { probeTimeoutMs: 10, decodeTimeoutMs: 10 });
    assert.equal(result.stopReason, `${phase}_limit`); assert.equal(result.outcome, 'undecodable');
    assert.equal(result.phase, phase); assert.equal(result.curlExitCode, 0);
    assert.deepEqual(stuck.kills, ['SIGKILL']); assert.equal(stuck.closed, true); h.cleaned();
  }
});

test('cancel during decoder waits for decoder close and exposes no local input path or raw stderr', async t => {
  const controller = new AbortController(); let decoder, settled = false;
  const h = harness(t, { autoCloseOnKill: false, decodeScript(child) { decoder = child; child.stderr.write('private-path sample.bin rawstderr SDP'); } });
  const promise = h.run({ signal: controller.signal }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 15)); controller.abort();
  assert.equal(settled, false); assert.deepEqual(decoder.kills, ['SIGKILL']); decoder.close(null);
  const result = await promise; assert.equal(result.outcome, 'cancelled'); safe(result); h.cleaned();
});

test('decoder commands allow only local formats/protocols and bound pixels, threads, frames and output', async t => {
  const h = harness(t); await h.run();
  for (const call of h.calls.slice(1)) {
    assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(call.args[call.args.indexOf('-max_pixels') + 1], '16777216');
    assert.equal(call.args[call.args.indexOf('-threads') + 1], '1');
    assert.equal(call.args.includes('http'), false);
  }
  assert.equal(h.calls[2].args[h.calls[2].args.indexOf('-frames:v') + 1], '1000'); h.cleaned();
});

test('oversized/malicious probe output and unknown codecs never leak or reach decoding', async t => {
  for (const output of ['private-rawstderr', 'x'.repeat(100_000), JSON.stringify({ format: { format_name: '__proto__' },
    streams: [{ codec_type: 'video', codec_name: 'private-codec', width: 100_000, height: 100_000 }] })]) {
    const h = harness(t, { probeScript(child) { child.stdout.write(output); child.close(); } });
    const result = await h.run(); assert.equal(result.outcome, 'undecodable'); assert.equal(h.calls.length, 2); safe(result); h.cleaned();
  }
});

test('spawn and beforeMedia failures are closed and cleaned, never retried', async t => {
  for (const fail of ['spawn', 'before']) {
    const root = temp(t); let calls = 0;
    const result = await runDvrHttpSample({ ...options, privateRoot: root,
      beforeMedia: fail === 'before' ? () => { throw new Error('private-credential rawstderr'); } : undefined },
    { lookup: () => [record], spawn() { calls++; throw new Error('private-uri rawstderr'); } });
    assert.equal(result.outcome, 'failed'); assert.equal(calls, fail === 'spawn' ? 1 : 0); safe(result); assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(result.phase, fail === 'spawn' ? 'transfer' : 'checkpoint'); assert.equal(result.curlExitCode, null);
  }
});

test('sanitizer never invokes accessors/toJSON/coercion or admits unknown fields/enums', () => {
  const poison = () => assert.fail('must not invoke');
  const value = Object.create({ bytes: 10 });
  Object.assign(value, { outcome: 'decoded', stopReason: 'byte_limit', mediaType: 'private-media', videoCodec: 'private-video',
    audioCodec: 'private-audio', width: Infinity, height: 100_000, decodedFrames: 1001, firstPtsSeconds: -1,
    lastPtsSeconds: NaN, httpStatus: '200', rawstderr: 'private-password', toJSON: poison });
  Object.defineProperty(value, 'bytes', { get: poison });
  const result = sanitizeDvrHttpSample(value); safe(result);
  assert.equal(result.bytes, 0); assert.equal(result.httpStatus, null); assert.equal(result.mediaType, null);
  assert.equal(result.width, null); assert.equal(result.height, null); assert.equal(result.decodedFrames, 0);
  assert.equal(Object.hasOwn(result, 'toJSON'), false); assert.equal(Object.hasOwn(result, 'rawstderr'), false);
  assert.equal(sanitizeDvrHttpSample({ outcome: 'private-leak', stopReason: 'eof' }), undefined);
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); assert.equal(sanitizeDvrHttpSample(proxy), undefined);
});

test('optional phase and curl exit facts stay closed without changing legacy report shape', () => {
  const legacy = { outcome: 'failed', stopReason: 'transport_error' };
  const old = sanitizeDvrHttpSample(legacy);
  assert.equal(Object.hasOwn(old, 'phase'), false); assert.equal(Object.hasOwn(old, 'curlExitCode'), false);
  for (const phase of ['search', 'private_setup', 'checkpoint', 'transfer', 'probe', 'decode', 'cleanup']) {
    assert.equal(sanitizeDvrHttpSample({ ...legacy, phase, curlExitCode: 47 }).phase, phase);
  }
  for (const curlExitCode of [0, 47, 255, null]) {
    assert.equal(sanitizeDvrHttpSample({ ...legacy, phase: 'transfer', curlExitCode }).curlExitCode, curlExitCode);
  }
  const poison = () => assert.fail('must not invoke');
  const hostile = { toString: poison, valueOf: poison, toJSON: poison };
  for (const curlExitCode of [-1, 256, 1.5, Infinity, NaN, '47', hostile, Symbol('private-exit')]) {
    const result = sanitizeDvrHttpSample({ ...legacy, phase: 'private-phase', curlExitCode });
    assert.equal(result.curlExitCode, null); assert.equal(Object.hasOwn(result, 'phase'), false); safe(result);
  }
  const accessors = Object.create({ phase: 'search', curlExitCode: 47 });
  Object.assign(accessors, legacy);
  Object.defineProperties(accessors, { phase: { get: poison }, curlExitCode: { get: poison } });
  assert.deepEqual(sanitizeDvrHttpSample(accessors), old);
  assert.deepEqual(sanitizeDvrHttpSample({ ...legacy, phase: hostile }), old);
});

test('interrupted residue cleanup is dedicated-root-only and never follows symlinks', t => {
  const root = temp(t), outside = temp(t);
  fs.writeFileSync(path.join(outside, 'keep'), 'fixture');
  fs.mkdirSync(path.join(root, 'dvr-http-sample-abc123')); fs.writeFileSync(path.join(root, 'dvr-http-sample-abc123', 'sample.bin'), payload);
  fs.mkdirSync(path.join(root, 'unrelated')); fs.writeFileSync(path.join(root, 'dvr-http-sample-not-valid'), 'fixture');
  fs.symlinkSync(outside, path.join(root, 'dvr-http-sample-xyz789'), 'dir');
  cleanupInterruptedDvrHttpSamples(root);
  assert.deepEqual(fs.readdirSync(root).sort(), ['dvr-http-sample-not-valid', 'dvr-http-sample-xyz789', 'unrelated']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'fixture');
  cleanupInterruptedDvrHttpSamples(path.join(root, 'missing'));
  assert.throws(() => cleanupInterruptedDvrHttpSamples(path.join(root, 'dvr-http-sample-xyz789')), /Private sample cleanup failed/);
});

test('real locally-generated MPEG fixture is probed and decoded without any network access', async t => {
  const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
    && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!available) { t.skip('Local ffmpeg/ffprobe unavailable'); return; }
  const root = temp(t), fixture = path.join(root, 'fixture.mpg');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=25',
    '-t', '0.4', '-c:v', 'mpeg2video', '-threads', '1', '-f', 'mpeg', fixture], { timeout: 5000 });
  assert.equal(generated.status, 0); const media = fs.readFileSync(fixture); let curls = 0;
  const result = await runDvrHttpSample({ ...options, privateRoot: path.join(root, 'samples') }, {
    lookup: () => [record], spawn(binary, args, opts) {
      if (/curl(?:\.exe)?$/.test(binary)) { curls++; return childFixture(child => { child.stdout.write(header()); child.stdout.write(media); child.close(); }); }
      return spawn(binary, args, opts);
    },
  });
  assert.equal(curls, 1); assert.equal(result.outcome, 'decoded'); assert.equal(result.mediaType, 'mpegps');
  assert.equal(result.videoCodec, 'mpeg2video'); assert.equal(result.width, 64); assert.equal(result.height, 64);
  assert.equal(result.decodedFrames, 10); assert.equal(result.firstPtsSeconds, 0); assert.equal(result.lastPtsSeconds, 0.36);
  assert.deepEqual(fs.readdirSync(path.join(root, 'samples')), []); safe(result);
});


test('cleanup failure is explicit, preserves safe sample facts, and does not leak the filesystem error', async t => {
  const h = harness(t); const original = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (target, opts) => {
    if (/dvr-http-sample-[A-Za-z0-9]{6}$/.test(target)) throw new Error('private-directory rawstderr cleanup failed');
    return original(target, opts);
  });
  const result = await h.run(); mocked.mock.restore();
  assert.equal(result.outcome, 'cleanup_failed'); assert.equal(result.bytes, payload.length);
  assert.equal(result.phase, 'cleanup'); assert.equal(result.curlExitCode, 0); assert.equal(result.httpStatus, 200);
  assert.equal(result.decodedFrames, 3); assert.equal(result.stopReason, 'eof'); safe(result);
  assert.equal(fs.existsSync(h.paths[1]), true);
  cleanupInterruptedDvrHttpSamples(h.root); h.cleaned();
});

test('a synchronous durable gate cannot spawn after an expired absolute deadline', async t => {
  const h = harness(t);
  const result = await h.run({ beforeMedia: () => { const end = Date.now() + 15; while (Date.now() < end) {} } }, { timeoutMs: 10 });
  assert.equal(result.outcome, 'timeout'); assert.equal(h.calls.length, 0); h.cleaned();
});

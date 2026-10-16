import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as nativeSpawn, spawnSync } from 'node:child_process';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dvrExportFailure, sanitizeSdkPhase } from '../lib/dvr-export-errors.js';
import { createSdkAdapter, sanitizeSdkMetadata, killSdkProcessesNow } from '../lib/dvr-sdk.js';

const device = { id: 'b88a6eb6-967c-47bd-b75f-1e61c85d873b', ip: '192.0.2.1', username: 'private-user', password: 'private-secret' };
const env = { HIKVISION_SDK_DIR: '/opt/hik-sdk', HIKVISION_SDK_DEVICE_IDS: device.id, PATH: '/usr/bin', TZ: 'Asia/Shanghai', LD_LIBRARY_PATH: '/untrusted/inherited', PRIVATE_SECRET: 'do-not-inherit' };
const startTime = '20261001T123000Z', endTime = '20261001T123010Z';
const stream = (extra = '') => `<StreamingChannel><id>101</id><Video><videoInputChannelID>1</videoInputChannelID>${extra}</Video></StreamingChannel>`;
const protocols = content => `<AdminAccessProtocolList>${content}</AdminAccessProtocolList>`;
const protocol = (port = 8000, enabled = 'true') => `<AdminAccessProtocol><protocol>DEV_MANAGE</protocol><portNo>${port}</portNo><enabled>${enabled}</enabled></AdminAccessProtocol>`;
const curlDigest = async (_d, _u, _p, url) => url.endsWith('/101') ? stream() : protocols(protocol());
const options = { device, channel: '101', startTime, endTime, curlDigest };
const probeResult = duration => JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', duration: String(duration) }], format: { duration: String(duration) } });

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (binary, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    const call = { binary, args, opts, child, get input() { return input; } }; calls.push(call);
    child.stdin.on('finish', () => { Promise.resolve().then(() => handler(call, calls.length - 1)).catch(error => { child.emit('error', error); child.emit('close', 1); }); });
    return child;
  };
  return { spawn, calls };
}
function finish(call, data = '', code = 0) { call.child.stdout.write(data); call.child.emit('close', code); }
async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return { dir, outputFile: path.join(dir, 'result.mp4') }; }
function happyHandler({ duration = 10, resultPatch = {}, rawSize = 5 } = {}) {
  return async (call, index) => {
    if (index === 0) {
      const payload = JSON.parse(call.input); await fs.writeFile(payload.output, Buffer.alloc(rawSize));
      finish(call, JSON.stringify({ ok: true, bytes: rawSize, sdkChannel: 1, requestedStart: payload.start, requestedEnd: payload.end, ...resultPatch }));
    } else if (call.binary === 'probe') finish(call, probeResult(duration));
    else { if (!call.args.includes('null')) await fs.writeFile(call.args.at(-1), 'mp4'); finish(call); }
  };
}
const adapter = dependencies => createSdkAdapter({ env, ffmpeg: 'mpeg', ffprobe: 'probe', ...dependencies });

test('SDK opt-in uses explicit UUID and SDK directory only', () => {
  assert.equal(adapter().sdkEnabled(device), true);
  assert.equal(adapter({ env: {} }).sdkEnabled(device), false);
  assert.equal(adapter().sdkEnabled({ ...device, id: undefined, name: device.id }), false);
  assert.equal(adapter().sdkEnabled({ ...device, id: 'not-uuid' }), false);
  assert.equal(adapter({ env: { ...env, HIKVISION_SDK_DEVICE_IDS: '' } }).sdkEnabled(device), false);
});

test('discovery binds exact main-stream ID to numeric input and management port', async () => {
  assert.deepEqual(await adapter().inspectSdkChannel(device, '101', { curlDigest }), { channel: '101', inputChannel: 1, port: 8000 });
  for (const channel of ['102', '1', '101\r\n', '0101']) {
    await assert.rejects(adapter().inspectSdkChannel(device, channel, { curlDigest }), { code: 'DVR_SDK_INVALID_REQUEST' });
  }
  for (const xml of [stream('<videoInputChannelID>2</videoInputChannelID>'), stream().replace('<id>101', '<id>201'), stream().replace('>1</videoInput', '>bad</videoInput')]) {
    await assert.rejects(adapter().inspectSdkChannel(device, '101', { curlDigest: async (_d, _u, _p, url) => url.endsWith('/101') ? xml : protocols(protocol()) }), { code: 'DVR_SDK_UNAVAILABLE' });
  }
  for (const xml of [protocols(protocol() + protocol()), protocols(protocol(8000, 'false')), protocols(protocol(65536)), '<bad/>']) {
    await assert.rejects(adapter().inspectSdkChannel(device, '101', { curlDigest: async (_d, _u, _p, url) => url.endsWith('/101') ? stream() : xml }), { code: 'DVR_SDK_UNAVAILABLE' });
  }
});

test('export is bounded, credentials go only on worker stdin, metadata does not promise exact timing', async t => {
  const { dir, outputFile } = await fixture(t);
  const fake = fakeSpawn(happyHandler());
  const result = await adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile });
  assert.equal(result.actualDurationSeconds, 10);
  assert.equal(result.timingAccuracy, 'unverified-keyframe');
  assert.equal(await fs.readFile(outputFile, 'utf8'), 'mp4');
  assert.deepEqual(await fs.readdir(dir), ['result.mp4']);
  assert.equal(fake.calls.length, 5);
  const worker = fake.calls[0], payload = JSON.parse(worker.input);
  assert.equal(payload.password, device.password);
  assert.equal(payload.port, 8000); assert.equal(payload.inputChannel, 1);
  assert.equal(payload.start, startTime); assert.equal(payload.maxBytes, 64 * 1024 * 1024);
  for (const call of fake.calls) {
    assert.ok(!JSON.stringify(call.args).includes(device.password));
    assert.ok(!JSON.stringify(call.opts).includes(device.password));
    assert.equal(call.opts.env.PRIVATE_SECRET, undefined);
    assert.equal(call.opts.env.TZ, 'Asia/Shanghai');
    assert.equal(call.opts.env.HIKVISION_SDK_DEVICE_IDS, undefined);
    assert.equal(call.opts.env.HIKVISION_SDK_DIR, undefined);
  }
  const conversion = fake.calls.find(c => c.binary === 'mpeg');
  assert.ok(conversion.args.includes('copy')); assert.ok(conversion.args.includes('aac'));
  assert.ok(!conversion.args.includes('-t')); assert.ok(!conversion.args.includes('-ss'));
});

test('range limits and calendar validation reject before any network/process work', async () => {
  const sdk = adapter({ spawn: () => assert.fail('spawn must not run') });
  for (const patch of [{ endTime: '20261001T143000Z' }, { startTime: '20260230T123000Z' }, { preview: true, endTime: '20261001T123031Z' }, { endTime: startTime }]) {
    await assert.rejects(sdk.sdkDownloadMp4({ ...options, ...patch, curlDigest: () => assert.fail('network must not run') }), { code: 'DVR_SDK_INVALID_REQUEST' });
  }
});

test('preview transcodes bounded 720p H264; rejects final duration mismatch', async t => {
  const { outputFile } = await fixture(t);
  const fake = fakeSpawn(happyHandler());
  await adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile, preview: true });
  const args = fake.calls.find(c => c.binary === 'mpeg').args;
  assert.ok(args.includes('libx264')); assert.ok(args.some(a => a.includes('min(720,ih)')));
});

test('bad worker/media response is sanitized and incomplete output/private raw removed', async t => {
  const { dir, outputFile } = await fixture(t);
  for (const fixtureOptions of [{ duration: 600 }, { resultPatch: { ok: false, code: device.password } }, { rawSize: 0 }, { resultPatch: { requestedStart: endTime } }]) {
    const fake = fakeSpawn(happyHandler(fixtureOptions));
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => !error.message.includes(device.password));
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('existing output is preserved on reservation failure', async t => {
  const { outputFile } = await fixture(t); await fs.writeFile(outputFile, 'existing');
  await assert.rejects(adapter().sdkDownloadMp4({ ...options, outputFile }), { code: 'DVR_SDK_FAILED' });
  assert.equal(await fs.readFile(outputFile, 'utf8'), 'existing');
});

test('cancellation waits for native close before cleaning or settling, escalates TERM to KILL', async t => {
  const { dir, outputFile } = await fixture(t);
  const control = new AbortController(); let workerStarted;
  const started = new Promise(resolve => { workerStarted = resolve; });
  const fake = fakeSpawn(async call => { workerStarted(call); });
  let settled = false;
  const promise = adapter({ spawn: fake.spawn, killGraceMs: 5 }).sdkDownloadMp4({ ...options, outputFile, signal: control.signal }).finally(() => { settled = true; });
  const rejection = assert.rejects(promise, error => error.reason === 'SDK_CANCELLED');
  const call = await started; control.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok((await fs.readdir(dir)).some(f => f.startsWith('.hik-sdk-')));
  call.child.emit('close', null); await rejection;
  assert.deepEqual(await fs.readdir(dir), []);
});

test('metadata sanitizer excludes untrusted diagnostics and rejects accessor fields', () => {
  const value = { requestedStart: startTime, requestedEnd: endTime, actualDurationSeconds: 10, transport: 'hcnetsdk', timingAccuracy: 'unverified-keyframe', password: device.password, osdTimes: ['secret'] };
  assert.deepEqual(Object.keys(sanitizeSdkMetadata(value)), ['requestedStart', 'requestedEnd', 'actualDurationSeconds', 'timingAccuracy', 'transport']);
  assert.equal(sanitizeSdkMetadata({ ...value, actualDurationSeconds: NaN }), undefined);
  assert.equal(sanitizeSdkMetadata({ ...value, get requestedStart() { assert.fail('getter'); } }), undefined);
});

test('probe watchdog waits for process close; final probe can reject otherwise valid conversion', async t => {
  const { outputFile, dir } = await fixture(t);
  let probeStarted;
  const started = new Promise(resolve => { probeStarted = resolve; });
  const handler = happyHandler();
  const fake = fakeSpawn(async (call, index) => { if (index === 1) probeStarted(call); else await handler(call, index); });
  let settled = false;
  const promise = adapter({ spawn: fake.spawn, probeTimeoutMs: 5, killGraceMs: 5 }).sdkDownloadMp4({ ...options, outputFile }).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, { code: 'DVR_SDK_PROCESS_TIMEOUT' });
  const call = await started;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false); assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
  call.child.emit('close', null); await rejected; assert.deepEqual(await fs.readdir(dir), []);
  const mismatch = fakeSpawn(async (call, index) => { if (index === 3) finish(call, probeResult(1000)); else await handler(call, index); });
  await assert.rejects(adapter({ spawn: mismatch.spawn }).sdkDownloadMp4({ ...options, outputFile }), { code: 'DVR_SDK_VERIFY_FAILED' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('discovery accepts namespaced XML and omitted enabled, rejects ambiguous enablement', async () => {
  const xml = protocols(protocol()).replace('<enabled>true</enabled>', '');
  const result = await adapter().inspectSdkChannel(device, '101', { curlDigest: async (_d, _u, _p, url) => url.endsWith('/101') ? stream().replace('<StreamingChannel>', '<StreamingChannel xmlns="urn:hikvision">') : xml });
  assert.equal(result.port, 8000);
  await assert.rejects(adapter().inspectSdkChannel(device, '101', { curlDigest: async (_d, _u, _p, url) => url.endsWith('/101') ? stream() : xml.replace('</AdminAccessProtocol>', '<enabled>true</enabled><enabled>false</enabled></AdminAccessProtocol>') }), { code: 'DVR_SDK_UNAVAILABLE' });
});

test('worker failures distinguish download timeout and byte cap without reflecting native diagnostics', async t => {
  const { outputFile, dir } = await fixture(t);
  for (const [code, expected] of [['timeout', 'DVR_SDK_DOWNLOAD_TIMEOUT'], ['byte_limit', 'DVR_SDK_BYTE_LIMIT'], ['extra_volume', 'DVR_SDK_MULTIPART'],
    ['/native/private/path', 'DVR_SDK_FAILED']]) {
    const fake = fakeSpawn(call => finish(call, JSON.stringify({ ok: false, code, sdkCode: device.password }), 1));
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
      assert.equal(error.code, expected);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private-secret|native\/private/);
      assert.equal(error.stage, undefined);
      return true;
    });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('worker success JSON cannot override nonzero or signal exit status', async t => {
  const { outputFile, dir } = await fixture(t);
  for (const exitCode of [1, 139, null]) {
    const fake = fakeSpawn(call => {
      const p = JSON.parse(call.input);
      finish(call, JSON.stringify({ ok: true, bytes: 5, sdkChannel: 1, requestedStart: p.start, requestedEnd: p.end }), exitCode);
    });
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), { code: 'DVR_SDK_FAILED' });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('final tracks must retain audio as AAC and have comparable finite durations', async t => {
  const { outputFile, dir } = await fixture(t);
  const source = JSON.parse(probeResult(10));
  source.streams.push({ codec_type: 'audio', codec_name: 'pcm_alaw', duration: '10' });
  const valid = JSON.parse(probeResult(10));
  valid.streams.push({ codec_type: 'audio', codec_name: 'aac', duration: '10' });
  const variants = [
    JSON.parse(probeResult(10)),
    { ...valid, streams: [valid.streams[0], { ...valid.streams[1], codec_name: 'pcm_alaw' }] },
    { ...valid, streams: [valid.streams[0], { ...valid.streams[1], duration: '1' }] },
    { ...valid, streams: [valid.streams[0], { ...valid.streams[1], duration: 'N/A' }] },
    { ...valid, streams: [{ ...valid.streams[0], codec_name: 'hevc' }, valid.streams[1]] },
    { ...valid, streams: [{ ...valid.streams[0], duration: 'N/A' }, valid.streams[1]] },
  ];
  for (const finalProbe of variants) {
    const handler = happyHandler();
    const fake = fakeSpawn(async (call, index) => {
      if (index === 1) finish(call, JSON.stringify(source));
      else if (index === 3) finish(call, JSON.stringify(finalProbe));
      else await handler(call, index);
    });
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile, preview: true }), { code: 'DVR_SDK_VERIFY_FAILED' });
    assert.deepEqual(await fs.readdir(dir), []);
  }
  const handler = happyHandler();
  const fake = fakeSpawn(async (call, index) => {
    if (index === 1) finish(call, JSON.stringify(source));
    else if (index === 3) finish(call, JSON.stringify(valid));
    else await handler(call, index);
  });
  await adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile });
  assert.ok(fake.calls[4].args.includes('-xerror'));
  assert.ok(fake.calls[4].args.includes('0:a:0?'));
  assert.ok(fake.calls[4].args.includes('null'));
});

test('full decode failure removes otherwise valid output', async t => {
  const { outputFile, dir } = await fixture(t);
  const handler = happyHandler();
  const fake = fakeSpawn(async (call, index) => {
    if (index === 4) finish(call, '', 1);
    else await handler(call, index);
  });
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), { code: 'DVR_SDK_VERIFY_FAILED' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('real installed media tools verify H264 and AAC after copy and preview transcoding', async t => {
  for (const binary of [ffmpegPath, ffprobePath]) {
    const result = spawnSync(binary, ['-version'], { stdio: 'ignore', timeout: 5000 });
    if (result.status !== 0) return t.skip('Media tools not installed');
  }
  const { dir } = await fixture(t);
  const sourceFile = path.join(dir, 'synthetic.ps');
  const generated = spawnSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=44100', '-t', '3', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'mp2', '-f', 'mpegts', sourceFile], { stdio: 'ignore', timeout: 10_000 });
  if (generated.status !== 0) return t.skip('Synthetic media encoder not available');
  for (const preview of [false, true]) {
    const fake = fakeSpawn(async call => {
      const p = JSON.parse(call.input); await fs.copyFile(sourceFile, p.output);
      finish(call, JSON.stringify({ ok: true, bytes: (await fs.stat(p.output)).size, sdkChannel: 33, requestedStart: p.start, requestedEnd: p.end }));
    });
    const sdk = adapter({ ffmpeg: ffmpegPath, ffprobe: ffprobePath, spawn: (binary, args, opts) => binary === 'python3' ? fake.spawn(binary, args, opts) : nativeSpawn(binary, args, opts) });
    const outputFile = path.join(dir, `final-${preview}.mp4`);
    const result = await sdk.sdkDownloadMp4({ ...options, endTime: '20261001T123003Z', preview, outputFile });
    assert.ok(Math.abs(result.actualDurationSeconds - 3) < 0.1);
    const inspected = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', outputFile], { encoding: 'utf8', timeout: 5000 });
    assert.equal(inspected.status, 0);
    const tracks = JSON.parse(inspected.stdout).streams;
    assert.equal(tracks.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(tracks.find(s => s.codec_type === 'audio').codec_name, 'aac');
  }
});


test('emergency shutdown synchronously kills live children and forgets closed handles', async t => {
  const { outputFile } = await fixture(t);
  let workerStarted;
  const started = new Promise(resolve => { workerStarted = resolve; });
  const fake = fakeSpawn(call => workerStarted(call));
  const promise = adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile });
  const rejected = assert.rejects(promise, { code: 'DVR_SDK_FAILED' });
  const call = await started;
  killSdkProcessesNow();
  assert.deepEqual(call.child.kills, ['SIGKILL']);
  call.child.emit('close', null);
  await rejected;
  killSdkProcessesNow();
  assert.deepEqual(call.child.kills, ['SIGKILL']);
});

test('only the native worker receives the explicit absolute SDK library search directory', async t => {
  const { outputFile } = await fixture(t), fake = fakeSpawn(happyHandler());
  await adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile });
  assert.equal(fake.calls[0].opts.env.LD_LIBRARY_PATH, env.HIKVISION_SDK_DIR);
  for (const call of fake.calls.slice(1)) assert.equal(call.opts.env.LD_LIBRARY_PATH, undefined);
  assert.equal(adapter({ env: { ...env, HIKVISION_SDK_DIR: './relative' } }).sdkEnabled(device), false);
});


test('every native watchdog classifies its stage and still waits for close before cleanup', async t => {
  for (const [index, settings, expected] of [
    [0, { workerTimeoutMs: 1 }, 'DVR_SDK_DOWNLOAD_TIMEOUT'],
    [1, { probeTimeoutMs: 5 }, 'DVR_SDK_PROCESS_TIMEOUT'],
    [2, { convertTimeoutMs: 5 }, 'DVR_SDK_PROCESS_TIMEOUT'],
    [3, { probeTimeoutMs: 5 }, 'DVR_SDK_PROCESS_TIMEOUT'],
    [4, { decodeTimeoutMs: 5 }, 'DVR_SDK_PROCESS_TIMEOUT'],
  ]) {
    await t.test(`pipeline process ${index}`, async t => {
      const { outputFile, dir } = await fixture(t);
      const happy = happyHandler();
      let stopped;
      const terminated = new Promise(resolve => { stopped = resolve; });
      const fake = fakeSpawn(async (call, current) => {
        if (current !== index) return happy(call, current);
        call.child.kill = signal => { call.child.kills.push(signal); if (signal === 'SIGKILL') stopped(call); return true; };
      });
      let settled = false;
      const promise = adapter({ spawn: fake.spawn, killGraceMs: 5, ...settings })
        .sdkDownloadMp4({ ...options, outputFile }).finally(() => { settled = true; });
      const rejected = assert.rejects(promise, { code: expected });
      const call = await terminated;
      assert.equal(settled, false);
      assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
      assert.ok((await fs.readdir(dir)).some(name => name.startsWith('.hik-sdk-')));
      call.child.emit('close', null);
      await rejected;
      assert.equal(fake.calls.length, index + 1);
      assert.deepEqual(await fs.readdir(dir), []);
    });
  }
});

test('an unset TZ is not synthesized for native processes', async t => {
  const { outputFile } = await fixture(t);
  const fake = fakeSpawn(happyHandler());
  await adapter({ spawn: fake.spawn, env: { ...env, TZ: undefined } }).sdkDownloadMp4({ ...options, outputFile });
  for (const call of fake.calls) assert.equal(Object.hasOwn(call.opts.env, 'TZ'), false);
});


test('worker phase framing accepts chunk boundaries and legacy terminal objects', async t => {
  const { outputFile, dir } = await fixture(t);
  for (const phase of ['load', 'init_config', 'init', 'login', 'get_file', 'play_start', 'wait', 'osd', 'stop', 'logout', 'cleanup']) {
    const output = `"init"\n${JSON.stringify(phase)}\n${JSON.stringify({ ok: false, code: 'timeout', failurePhase: phase })}\n`;
    const fake = fakeSpawn(call => {
      for (const byte of Buffer.from(output)) call.child.stdout.write(Buffer.from([byte]));
      call.child.emit('close', 1);
    });
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
      assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
      assert.equal(error.sdkFailurePhase, phase);
      assert.equal(error.sdkPhase, undefined);
      const failure = dvrExportFailure(error);
      assert.match(failure.message, /记录的超时步骤/);
      assert.deepEqual(Object.keys(failure), ['failureCode', 'message']);
      return true;
    });
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('worker protocol fails closed on malicious frames, terminal tails, and aggregate overflow', async t => {
  const { outputFile, dir } = await fixture(t);
  const terminal = '{"ok":false,"code":"timeout"}';
  for (const output of [
    '"/private/native/secret"\n', '"__proto__"\n', 'null\n', '[]\n', '42\n', '\n',
    '{"phase":"cleanup","password":"secret"}\n',
    '{"ok":false,"code":"timeout","failurePhase":"/secret/path"}\n',
    '{"ok":false,"code":"timeout","failurePhase":"__proto__"}\n',
    '{"ok":false,"code":"timeout","failurePhase":{"secret":1}}\n',
    '{"ok":true,"failurePhase":"cleanup"}\n',
    '{"ok":false,"code":"byte_limit","failurePhase":"cleanup"}\n', '{"ok":false,"code":"timeout","extra":"secret"}\n',
    `${terminal}\n"cleanup"\n`, `${terminal}\n${terminal}\n`, `${terminal}\nx`, `${terminal}\n\n`,
    'native diagnostic text\n', '"cleanup', '"cleanup"\n', 'x'.repeat(65537),
  ]) {
    const fake = fakeSpawn(call => finish(call, output, 1));
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
      assert.equal(error.code, 'DVR_SDK_FAILED');
      assert.equal(error.sdkPhase, undefined);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|native\/|secret/);
      return true;
    });
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(fake.calls.length, 1);
  }
});

test('watchdog retains the last validated cleanup phase after TERM but still waits for close', async t => {
  const { outputFile, dir } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const fake = fakeSpawn(call => {
    call.child.stdout.write('"wait"\n');
    call.child.kill = signal => {
      call.child.kills.push(signal);
      if (signal === 'SIGTERM') call.child.stdout.write('"stop"\n"logout"\n"cleanup"\n');
      return true;
    };
    started(call);
  });
  let settled = false;
  const promise = adapter({ spawn: fake.spawn, workerTimeoutMs: 1, killGraceMs: 5 })
    .sdkDownloadMp4({ ...options, outputFile }).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
    assert.equal(error.sdkPhase, 'cleanup');
    assert.match(dvrExportFailure(error).message, /清理 SDK/);
    return true;
  });
  const call = await ready;
  t.mock.timers.tick(5001); t.mock.timers.tick(5);
  assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  assert.ok((await fs.readdir(dir)).some(name => name.startsWith('.hik-sdk-')));
  call.child.emit('close', null);
  await rejected;
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cancellation wins over a phase-tagged worker timeout', async t => {
  const { outputFile, dir } = await fixture(t);
  const control = new AbortController();
  const fake = fakeSpawn(call => {
    call.child.stdout.write('"cleanup"\n');
    control.abort();
    finish(call, '{"ok":false,"code":"timeout","failurePhase":"wait"}\n', 1);
  });
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile, signal: control.signal }), error => {
    assert.equal(error.reason, 'SDK_CANCELLED');
    assert.equal(error.sdkPhase, undefined); assert.equal(error.sdkFailurePhase, undefined);
    return true;
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('maximum worker phase and OSD report fit the unchanged cumulative stdout cap', async t => {
  const { outputFile } = await fixture(t);
  const phases = '"osd"\n"wait"\n'.repeat(1801) + '"stop"\n"logout"\n"cleanup"\n';
  const output = phases + JSON.stringify({ ok: false, code: 'timeout', failurePhase: 'wait', osdTimes: Array(1801).fill('99991231T235959Z') }) + '\n';
  assert.ok(Buffer.byteLength(output) < 59000);
  const fake = fakeSpawn(call => { for (let i = 0; i < output.length; i += 13) call.child.stdout.write(output.slice(i, i + 13)); call.child.emit('close', 1); });
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), { code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkFailurePhase: 'wait' });
});


test('completed timeout freezes wait failure even after successful cleanup phases', async t => {
  const { outputFile, dir } = await fixture(t);
  const fake = fakeSpawn(call => finish(call,
    '"wait"\n"stop"\n"logout"\n"cleanup"\n{"ok":false,"code":"timeout","failurePhase":"wait"}\n', 1));
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
    assert.equal(error.sdkFailurePhase, 'wait'); assert.equal(error.sdkPhase, undefined);
    assert.match(dvrExportFailure(error).message, /记录的超时步骤：等待录像数据/);
    assert.doesNotMatch(dvrExportFailure(error).message, /清理 SDK/);
    return true;
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('a legacy complete timeout without failurePhase cannot blame later cleanup phases', async t => {
  const { outputFile } = await fixture(t);
  const fake = fakeSpawn(call => finish(call, '"wait"\n"cleanup"\n{"ok":false,"code":"timeout"}\n', 1));
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
    assert.equal(error.sdkFailurePhase, undefined); assert.equal(error.sdkPhase, undefined);
    assert.equal(dvrExportFailure(error).message, dvrExportFailure({ code: error.code }).message);
    return true;
  });
});


test('worker wait timeout followed by cleanup hang uses last active phase when killed without terminal', async t => {
  const { outputFile, dir } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const fake = fakeSpawn(call => {
    // Python already hit its own wait deadline and entered teardown, but has
    // not returned the final object carrying the frozen failurePhase.
    call.child.stdout.write('"wait"\n"stop"\n"logout"\n"cleanup"\n');
    started(call);
  });
  let settled = false;
  const promise = adapter({ spawn: fake.spawn, workerTimeoutMs: 1, killGraceMs: 5 })
    .sdkDownloadMp4({ ...options, outputFile }).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
    assert.equal(error.sdkFailurePhase, undefined); assert.equal(error.sdkPhase, 'cleanup');
    assert.match(dvrExportFailure(error).message, /停止前最后记录的步骤：清理 SDK/);
    return true;
  });
  const call = await ready;
  t.mock.timers.tick(5001); t.mock.timers.tick(5);
  assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  assert.ok((await fs.readdir(dir)).some(name => name.startsWith('.hik-sdk-')));
  call.child.emit('close', null); await rejected;
  assert.deepEqual(await fs.readdir(dir), []);
});

test('timeout terminal returned during TERM grace takes precedence over cleanup activity', async t => {
  const { outputFile } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const fake = fakeSpawn(call => {
    call.child.stdout.write('"wait"\n');
    call.child.kill = signal => {
      call.child.kills.push(signal);
      if (signal === 'SIGTERM') call.child.stdout.write('"cleanup"\n{"ok":false,"code":"timeout","failurePhase":"wait"}\n');
      return true;
    };
    started(call);
  });
  const promise = adapter({ spawn: fake.spawn, workerTimeoutMs: 1, killGraceMs: 5 }).sdkDownloadMp4({ ...options, outputFile });
  const rejected = assert.rejects(promise, error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT');
    assert.equal(error.sdkFailurePhase, 'wait'); assert.equal(error.sdkPhase, undefined);
    assert.match(dvrExportFailure(error).message, /记录的超时步骤：等待录像数据/);
    return true;
  });
  const call = await ready;
  t.mock.timers.tick(5001); call.child.emit('close', 1);
  await rejected;
  assert.deepEqual(call.child.kills, ['SIGTERM']);
});


for (const cancelled of [false, true]) test(`invalid worker stream after watchdog TERM erases terminal evidence${cancelled ? ' while cancellation wins' : ''}`, async t => {
  const terminal = '{"ok":false,"code":"timeout","failurePhase":"wait"}\n';
  const cases = [
    ['malformed after terminal', [terminal, 'INVALID\n']],
    ['phase after terminal', [terminal, '"cleanup"\n']],
    ['overflow after terminal', [terminal, 'x'.repeat(65537)]],
    ['malformed before terminal', ['INVALID\n', terminal]],
    ['partial terminal at close', ['{"ok":false,"code":"timeout","failurePhase":']],
  ];
  for (const [name, chunks] of cases) await t.test(name, async t => {
    const { outputFile, dir } = await fixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const control = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const fake = fakeSpawn(call => {
      call.child.stdout.write('"wait"\n');
      call.child.kill = signal => {
        call.child.kills.push(signal);
        if (signal === 'SIGTERM') {
          call.child.stdout.write('"cleanup"\n');
          for (const chunk of chunks) call.child.stdout.write(chunk);
        }
        return true;
      };
      started(call);
    });
    let settled = false;
    const promise = adapter({ spawn: fake.spawn, workerTimeoutMs: 1, killGraceMs: 5 })
      .sdkDownloadMp4({ ...options, outputFile, signal: control.signal }).finally(() => { settled = true; });
    const rejected = assert.rejects(promise, error => {
      assert.equal(error.reason, cancelled ? 'SDK_CANCELLED' : 'SDK_DOWNLOAD');
      assert.equal(error.code, 'DVR_SDK_FAILED');
      assert.equal(error.sdkPhase, undefined); assert.equal(error.sdkFailurePhase, undefined);
      assert.equal(dvrExportFailure(error).message, dvrExportFailure({ code: 'DVR_SDK_FAILED' }).message);
      assert.doesNotMatch(error.message + JSON.stringify(error), /INVALID|failurePhase|cleanup|sdkPhase/);
      return true;
    });
    const call = await ready;
    t.mock.timers.tick(5001);
    if (cancelled) control.abort();
    t.mock.timers.tick(5);
    assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(settled, false);
    assert.ok((await fs.readdir(dir)).some(name => name.startsWith('.hik-sdk-')));
    call.child.emit('close', null); await rejected;
    assert.deepEqual(await fs.readdir(dir), []);
  });
});


for (const [index, stdout, exitCode, stage, observedSeconds, label] of [
  [1, '{broken', 0, 'probe', undefined, 'SDK 原始录像探测失败'],
  [1, probeResult(32.172), 0, 'probe', 32.172, 'SDK 原始录像探测失败'],
  [2, '', 1, 'remux', 10, 'SDK MP4 封装失败'],
  [3, '{broken', 0, 'verify', undefined, 'SDK 成品参数校验失败'],
  [3, probeResult(4.1254), 0, 'verify', 4.125, 'SDK 成品参数校验失败'],
  [4, '', 1, 'decode', 10, 'SDK 成品完整解码失败'],
]) test(`SDK media failure ${stage} preserves only measured numbers at process ${index}`, async t => {
  const { outputFile, dir } = await fixture(t);
  const happy = happyHandler();
  const fake = fakeSpawn(async (call, current) => current === index ? finish(call, stdout, exitCode) : happy(call, current));
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
    assert.equal(error.code, stage === 'remux' ? 'DVR_SDK_FAILED' : 'DVR_SDK_VERIFY_FAILED');
    assert.deepEqual(error.sdkEvidence, { stage, requestedSeconds: 10, ...(observedSeconds === undefined ? {} : { observedSeconds }), rawBytes: 5 });
    const failure = dvrExportFailure(error);
    assert.ok(failure.message.startsWith(label));
    assert.match(failure.message, /请求 10 秒/); assert.match(failure.message, /原始录像 5 字节/);
    if (observedSeconds === undefined) assert.doesNotMatch(failure.message, /(?:原始|成品)探测 \d/);
    else assert.ok(failure.message.includes(`${['probe', 'remux'].includes(stage) ? '原始探测' : '成品探测'} ${observedSeconds} 秒`));
    assert.deepEqual(Object.keys(failure), ['failureCode', 'message']);
    assert.doesNotMatch(JSON.stringify(failure), /private|recording\.ps|sdkEvidence|codec/);
    return true;
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('unknown, coerced, nonpositive, or out-of-bound probe durations are omitted, never reported as zero', async t => {
  const { outputFile } = await fixture(t);
  for (const durationValue of [undefined, null, '', 'N/A', 'private-path', true, false, [], {}, '0', '-1', '90000', 90000]) {
    const happy = happyHandler();
    const fake = fakeSpawn(async (call, index) => index === 1 ? finish(call, JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264' }], format: { duration: durationValue },
    })) : happy(call, index));
    await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
      assert.equal(error.code, 'DVR_SDK_VERIFY_FAILED');
      assert.equal(error.sdkEvidence.observedSeconds, undefined);
      assert.doesNotMatch(dvrExportFailure(error).message, /(?:原始|成品)探测 \d|private|N\/A/);
      return true;
    });
  }
});

test('worker timeout measures private raw size only after close, before removing it', async t => {
  const { outputFile, dir } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const fake = fakeSpawn(async call => {
    const payload = JSON.parse(call.input);
    await fs.writeFile(payload.output, 'part');
    call.child.stdout.write('"wait"\n');
    started({ call, raw: payload.output });
  });
  let settled = false;
  const promise = adapter({ spawn: fake.spawn, workerTimeoutMs: 1, killGraceMs: 5 })
    .sdkDownloadMp4({ ...options, outputFile }).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT'); assert.equal(error.sdkPhase, 'wait');
    assert.deepEqual(error.sdkEvidence, { rawBytes: 9 });
    const failure = dvrExportFailure(error);
    assert.match(failure.message, /停止前最后记录的步骤：等待录像数据/);
    assert.match(failure.message, /停止后原始录像 9 字节/);
    assert.deepEqual(Object.keys(failure), ['failureCode', 'message']);
    return true;
  });
  const { call, raw } = await ready;
  t.mock.timers.tick(5001); t.mock.timers.tick(5);
  assert.equal(settled, false); assert.deepEqual(call.child.kills, ['SIGTERM', 'SIGKILL']);
  await fs.appendFile(raw, 'later'); // Any observation before close would see only four bytes.
  call.child.emit('close', null); await rejected;
  assert.deepEqual(await fs.readdir(dir), []);
});

for (const kind of ['missing', 'empty', 'directory', 'symlink', 'partial']) test(`closed worker timeout raw evidence: ${kind}`, async t => {
  const { outputFile, dir } = await fixture(t);
  const fake = fakeSpawn(async call => {
    const payload = JSON.parse(call.input);
    if (kind === 'empty') await fs.writeFile(payload.output, '');
    if (kind === 'partial') await fs.writeFile(payload.output, 'partial');
    if (kind === 'directory') await fs.mkdir(payload.output);
    if (kind === 'symlink') await fs.symlink(outputFile, payload.output);
    finish(call, '"cleanup"\n{"ok":false,"code":"timeout","failurePhase":"wait"}\n', 1);
  });
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile }), error => {
    assert.equal(error.code, 'DVR_SDK_DOWNLOAD_TIMEOUT'); assert.equal(error.sdkFailurePhase, 'wait');
    const expected = kind === 'empty' ? 0 : kind === 'partial' ? 7 : undefined;
    assert.deepEqual(error.sdkEvidence, expected === undefined ? undefined : { rawBytes: expected });
    const message = dvrExportFailure(error).message;
    assert.match(message, /记录的超时步骤：等待录像数据/);
    if (expected === undefined) assert.doesNotMatch(message, /字节/);
    else assert.ok(message.includes(`停止后原始录像 ${expected} 字节`));
    return true;
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cancellation strips media measurements even when raw data exists', async t => {
  const { outputFile, dir } = await fixture(t);
  const control = new AbortController();
  const fake = fakeSpawn(async call => {
    const payload = JSON.parse(call.input); await fs.writeFile(payload.output, 'partial');
    control.abort(); finish(call, '{"ok":false,"code":"timeout","failurePhase":"wait"}\n', 1);
  });
  await assert.rejects(adapter({ spawn: fake.spawn }).sdkDownloadMp4({ ...options, outputFile, signal: control.signal }), error => {
    assert.equal(error.reason, 'SDK_CANCELLED'); assert.equal(error.sdkEvidence, undefined);
    assert.equal(error.sdkPhase, undefined); assert.equal(error.sdkFailurePhase, undefined);
    return true;
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

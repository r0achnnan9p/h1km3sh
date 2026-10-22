import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { createDvrPreview, dvrRtspUrl, dvrPreviewArgs, hasMediaFragment, previewFailure, previewDiagnostics } from '../lib/dvr-preview-stream.js';
import { mainDvrChannel, parseDvrChannels } from '../lib/dvr-channels.js';

const box = (type, bytes = Buffer.alloc(0)) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + bytes.length); head.write(type, 4); return Buffer.concat([head, bytes]); };
const init = Buffer.concat([box('ftyp'), box('moov')]);
const media = Buffer.concat([box('moof'), box('mdat', Buffer.from([1, 2, 3]))]);
const device = { ip: '192.0.2.10', rtspPort: 8554, username: 'user@name', password: 'test:/?#' };

test('DVR preview keeps the selected recording channel and uses a separate live path', () => {
  const url = dvrRtspUrl(device, '301', { startMs: Date.parse('2026-10-01T13:43:49Z'), duration: 8 });
  assert.match(url, /^rtsp:\/\/user%40name:test%3A%2F%3F%23@192\.0\.2\.10:8554\/Streaming\/tracks\/301\?/);
  assert.match(url, /starttime=20261001T214349Z&endtime=20261001T214357Z$/);
  assert.match(dvrRtspUrl(device, '302', { live: true }), /\/Streaming\/Channels\/302$/);
  assert.equal(mainDvrChannel('302'), '301'); assert.equal(mainDvrChannel('1002'), '1001');
  assert.throws(() => dvrRtspUrl(device, '../301', { live: true }));
});
test('RTSP owns codec discovery and timestamps; compatibility preview is bounded H264', () => {
  const copy = dvrPreviewArgs('rtsp://example/301', 8);
  assert.equal(copy.includes('h264'), false); assert.equal(copy[copy.indexOf('-c:v') + 1], 'copy');
  assert.equal(copy[copy.indexOf('-rtsp_transport') + 1], 'tcp');
  const compat = dvrPreviewArgs('rtsp://example/301', 8, 'compat');
  assert.equal(compat[compat.indexOf('-c:v') + 1], 'libx264');
  assert.match(compat[compat.indexOf('-vf') + 1], /1280.*720/);
  assert.equal(compat[compat.indexOf('-threads') + 1], '2');
  assert.throws(() => dvrPreviewArgs('rtsp://example/301', 8, 'invalid'));
});
test('init MP4 alone cannot commit a successful playback response', () => {
  assert.equal(hasMediaFragment(Buffer.alloc(0)), false);
  assert.equal(hasMediaFragment(init), false);
  assert.equal(hasMediaFragment(Buffer.concat([init, box('moof')])), false);
  const playable = Buffer.concat([init, media]);
  for (let length = 0; length < playable.length - 2; length++) assert.equal(hasMediaFragment(playable.subarray(0, length)), false);
  assert.equal(hasMediaFragment(playable), true);
  const invalid = Buffer.from(playable); invalid.writeUInt32BE(1); assert.equal(hasMediaFragment(invalid), false);
});
test('channel list contains one named entry per camera, with optional live substream', async () => {
  const streams = '<StreamingChannelList><StreamingChannel><id>101</id><channelName>101</channelName><Video><videoCodecType>H.265</videoCodecType></Video></StreamingChannel><StreamingChannel><id>102</id></StreamingChannel><StreamingChannel><id>201</id><channelName>西侧</channelName></StreamingChannel><StreamingChannel><id>301</id></StreamingChannel></StreamingChannelList>';
  const names = '<InputProxyChannelList><InputProxyChannel><id>1</id><name>主球场</name></InputProxyChannel></InputProxyChannelList>';
  const channels = await parseDvrChannels(streams, names);
  assert.deepEqual(channels.map(c => [c.id, c.name, c.substreamId]), [['101', '主球场', '102'], ['201', '西侧', null], ['301', '镜头 3', null]]);
  assert.equal(channels[0].codec, 'H.265');
  assert.equal((await parseDvrChannels(streams, '<invalid'))[0].name, '镜头 1');
});
function child() {
  const process = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.signals = [];
  process.exitCode = null; process.signalCode = null;
  process.kill = signal => { process.signals.push(signal); process.signalCode = signal; queueMicrotask(() => process.emit('close', null)); };
  process.complete = code => { process.exitCode = code; process.emit('close', code); };
  return process;
}
async function withPreview(t, run, options = {}) {
  const children = [], failures = [], sessions = [];
  const preview = createDvrPreview({ ffmpegPath: 'fixture-ffmpeg', spawn: () => { const p = child(); children.push(p); setImmediate(() => run(p, children.length)); return p; }, onFailure: event => failures.push(event), ...options });
  const app = express(); app.get('/', (req, res) => { sessions.push(preview({ res, urls: ['rtsp://fake/sub', 'rtsp://fake/main'], duration: 1 })); });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { for (const session of sessions) session.stop('test end'); server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  return { response, children, failures, sessions };
}
test('zero-byte and init-only failures are JSON 502, never empty 200 or leaked credentials', async t => {
  const result = await withPreview(t, (p, attempt) => {
    if (attempt === 2) p.stdout.write(init);
    p.stderr.write('rtsp://user:secret@host/stream: 401 Unauthorized'); p.complete(1);
  });
  assert.equal(result.response.status, 502);
  assert.match(result.response.headers.get('content-type'), /application\/json/);
  const payload = await result.response.json(); assert.match(payload.error, /认证/);
  assert.doesNotMatch(JSON.stringify(payload) + JSON.stringify(result.failures), /secret|rtsp:\/\//);
  assert.equal(result.children.length, 2);
});
test('live substream failure can fall back before headers; valid fragmented bytes stream once', async t => {
  const result = await withPreview(t, (p, attempt) => {
    p.stdout.write(init);
    if (attempt === 1) { p.complete(1); return; }
    p.stdout.write(media.subarray(0, 11)); p.stdout.write(media.subarray(11)); p.complete(0);
  });
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type'), /video\/mp4/);
  assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), Buffer.concat([init, media]));
  assert.equal(result.children.length, 2); assert.equal(result.sessions[0].finished, true);
});
test('first-media watchdog terminates bounded attempts without returning init-only video', async t => {
  const result = await withPreview(t, p => p.stdout.write(init), { firstFrameTimeoutMs: 10 });
  assert.equal(result.response.status, 504); assert.equal(result.children.length, 2);
  assert.equal(result.children.every(p => p.signals.includes('SIGTERM')), true);
});
test('failure classification only returns fixed safe messages', () => {
  for (const text of ['Connection refused rtsp://a:b@x', '404 Not Found rtsp://a:b@x', 'unknown rtsp://a:b@x']) assert.doesNotMatch(previewFailure(text), /rtsp|a:b/);
});

test('DVR live request checks its generation after metadata and before replacing a preview', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const live = source.slice(source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res) => {"), source.indexOf("app.post('/console/api/export'"));
  const claim = live.indexOf('const generation = ++consolePreviewGeneration');
  const metadata = live.indexOf('await readConsoleDvrChannels');
  const guard = live.indexOf('generation !== consolePreviewGeneration');
  const stop = live.indexOf("await previous.stop('superseded')");
  assert.ok(claim >= 0 && claim < metadata && metadata < guard && guard < stop);
  assert.match(source.slice(source.indexOf("app.get('/console/api/dvrs/:id/stream'"), source.indexOf('const consoleDvrPreview =')), /\+\+consolePreviewGeneration/);
  assert.match(live, /Number\(channel\) < 1/);
});

test('real HEVC input produces bounded browser-compatible H264 fragments', { timeout: 45000 }, async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { ffmpegPath, ffprobePath } = await import('../lib/ffmpeg-paths.js');
  const run = promisify(execFile), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dvr-compat-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'hevc.mp4'), target = path.join(dir, 'compat.mp4');
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1600x900:rate=10', '-t', '0.4', '-an', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p', '-y', source]);
  const full = dvrPreviewArgs('rtsp://fixture', 0.4, 'compat');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, ...full.slice(full.indexOf('-i') + 2)];
  args[args.length - 1] = target;
  await run(ffmpegPath, args);
  assert.equal(hasMediaFragment(await fs.readFile(target)), true);
  const { stdout } = await run(ffprobePath, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_read_frames', '-of', 'json', target]);
  const stream = JSON.parse(stdout).streams[0];
  assert.equal(stream.codec_name, 'h264'); assert.equal(stream.width, 1280); assert.equal(stream.height, 720);
  assert.equal(stream.pix_fmt, 'yuv420p'); assert.equal(Number(stream.nb_read_frames), 4);
});

test('diagnostics contain only bounded numbers and closed vocabulary, never source text', () => {
  const text = 'rtsp://private-user:private-password@private-host/secret?starttime=secret SDP secret method SETUP failed: 454 Session Not Found';
  const result = previewDiagnostics(text, { reason: 'no media', format: 'compat', exitCode: 1, elapsedMs: 125, outputBytes: 48 });
  assert.deepEqual(result, { reason: 'no media', format: 'compat', method: 'SETUP', rtspStatus: 454, category: 'not_found', exitCode: 1, elapsedMs: 125, outputBytes: 48 });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|rtsp:\/\/|SDP/);
  const invalid = previewDiagnostics(text, { reason: text, format: text, exitCode: text, elapsedMs: Infinity, outputBytes: -1 });
  assert.equal(invalid.reason, 'unknown'); assert.equal(invalid.format, 'unknown'); assert.equal(invalid.exitCode, null);
  assert.equal(invalid.elapsedMs, 0); assert.equal(invalid.outputBytes, 0);
});

test('failed attempts report their own exit code and bytes once, including substream fallback', async t => {
  const result = await withPreview(t, (p, attempt) => {
    p.stdout.write(init); p.stderr.write('method SETUP failed: 461 Unsupported Transport rtsp://private:secret@host'); p.complete(attempt);
  });
  await result.response.json();
  assert.equal(result.failures.length, 2);
  for (let i = 0; i < 2; i++) {
    const event = result.failures[i];
    assert.equal(event.exitCode, i + 1); assert.equal(event.outputBytes, init.length);
    assert.equal(event.method, 'SETUP'); assert.equal(event.rtspStatus, 461); assert.equal(event.category, 'transport');
    assert.ok(event.elapsedMs >= 0); assert.doesNotMatch(JSON.stringify(event), /private|secret|rtsp:\/\//);
  }
});

test('real FFmpeg negotiates only video even when the DVR advertises a failing audio track', { timeout: 15000 }, async t => {
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { ffmpegPath } = await import('../lib/ffmpeg-paths.js');
  const methods = [], setups = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // FFmpeg may reset the mock connection after its PLAY rejection.
    let pending = '';
    socket.on('data', data => {
      pending += data.toString();
      while (pending.includes('\r\n\r\n')) {
        const end = pending.indexOf('\r\n\r\n'), request = pending.slice(0, end); pending = pending.slice(end + 4);
        const [method, url] = request.split(' '); methods.push(method);
        const cseq = request.match(/CSeq: (\d+)/i)?.[1] || '1';
        let status = '200 OK', headers = '', body = '';
        if (method === 'OPTIONS') headers = 'Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n';
        if (method === 'DESCRIBE') {
          body = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=synthetic\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\nm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:trackID=1\r\n';
          headers = `Content-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1:${server.address().port}/recording/\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
        }
        if (method === 'SETUP') {
          setups.push(url);
          if (url.includes('trackID=1')) status = '461 Unsupported Transport';
          else headers = 'Session: synthetic\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n';
        }
        // End without media after negotiation; the test inspects actual SETUP requests.
        if (method === 'PLAY') status = '454 Session Not Found';
        socket.write(`RTSP/1.0 ${status}\r\nCSeq: ${cseq}\r\n${headers}\r\n${body}`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  t.after(() => { child?.kill('SIGKILL'); for (const socket of sockets) socket.destroy(); server.close(); });
  const args = dvrPreviewArgs(`rtsp://127.0.0.1:${server.address().port}/recording`, 1);
  assert.ok(args.indexOf('-allowed_media_types') < args.indexOf('-i'));
  child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.notEqual(code, 0); assert.ok(methods.includes('PLAY'), stderr);
  assert.equal(setups.length, 1); assert.match(setups[0], /trackID=0$/);
});

class PreviewResponse extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writableEnded = false; }
  status(value) { this.statusCode = value; return this; }
  type() { return this; }
  set() { return this; }
  write() { return true; }
  json(value) { this.body = value; this.writableEnded = true; return this; }
  end() { this.writableEnded = true; return this; }
}
function heldChild() {
  const process = child();
  // Sending a signal is not proof that either the process or its stdio closed.
  process.kill = signal => { process.signals.push(signal); return true; };
  return process;
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('preview stop returns one teardown promise and retains ownership until actual child close', async t => {
  const process = heldChild(), response = new PreviewResponse(); let finishes = 0;
  const preview = createDvrPreview({ ffmpegPath: 'fixture', spawn: () => process });
  const session = preview({ res: response, urls: ['rtsp://fixture/main'], duration: 30, onFinish: () => { finishes++; } });
  t.after(async () => { process.complete(0); await session.stop(); });
  const stopped = session.stop('superseded'); let settled = false; stopped.then(() => { settled = true; });
  assert.equal(session.stop('repeat'), stopped); assert.equal(session.finished, true);
  assert.deepEqual(process.signals, ['SIGTERM']);
  await nextTurn(); assert.equal(settled, false); assert.equal(finishes, 0);
  process.complete(null); await stopped;
  assert.equal(settled, true); assert.equal(finishes, 1);
});

test('preview fallback waits for prior close instead of overlapping recorder sessions', async t => {
  const children = [], response = new PreviewResponse();
  const preview = createDvrPreview({ ffmpegPath: 'fixture', maxInitialBytes: 1,
    spawn: () => { const process = heldChild(); children.push(process); return process; } });
  const session = preview({ res: response, urls: ['rtsp://fixture/sub', 'rtsp://fixture/main'], duration: 30 });
  t.after(async () => { const stopped = session.stop(); for (const process of children) process.complete(0); await stopped; });
  children[0].stdout.write(init); await nextTurn();
  assert.deepEqual(children[0].signals, ['SIGTERM']); assert.equal(children.length, 1);
  children[0].complete(null); await nextTurn(); assert.equal(children.length, 2);
  const stopped = session.stop(); children[1].complete(null); await stopped;
});

test('canceling while fallback teardown waits stops the old handle and never spawns the fallback', async t => {
  const children = [], response = new PreviewResponse(); let finishes = 0;
  const preview = createDvrPreview({ ffmpegPath: 'fixture', maxInitialBytes: 1,
    spawn: () => { const process = heldChild(); children.push(process); return process; } });
  const session = preview({ res: response, urls: ['rtsp://fixture/sub', 'rtsp://fixture/main'], duration: 30, onFinish: () => { finishes++; } });
  t.after(async () => { for (const process of children) process.complete(0); await session.stop(); });
  children[0].stdout.write(init); const stopped = session.stop(); let settled = false; stopped.then(() => { settled = true; });
  await nextTurn(); assert.equal(finishes, 0); assert.equal(settled, false); assert.equal(children.length, 1);
  children[0].complete(null); await stopped; await nextTurn();
  assert.equal(children.length, 1); assert.equal(finishes, 1); assert.equal(settled, true);
});

test('actual fMP4 preview teardown gates SDK preparation, including an abandoned fallback handle', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { createDvrSdkPreview } = await import('../lib/dvr-sdk-preview.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-preview-sdk-'));
  const children = []; let downloads = 0, finishes = 0;
  const preview = createDvrPreview({ ffmpegPath: 'fixture', maxInitialBytes: 1,
    spawn: () => { const process = heldChild(); children.push(process); return process; } });
  const old = preview({ res: new PreviewResponse(), urls: ['rtsp://fixture/sub', 'rtsp://fixture/main'], duration: 30, onFinish: () => { finishes++; } });
  const manager = createDvrSdkPreview({ root, download: async ({ outputFile }) => {
    downloads++; fs.writeFileSync(outputFile, Buffer.concat([init, box('mdat', Buffer.from('fixture'))]));
    return { actualDurationSeconds: 30 };
  } });
  t.after(async () => { for (const process of children) process.complete(0); await old.stop(); await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Trigger fallback first: the active child reference is gone, but the actual
  // process is still alive and must remain part of stop's settlement barrier.
  children[0].stdout.write(init);
  const sdk = manager.begin({ device: { id: 'fixture' }, channel: '101', startTime: '20261001T120000Z', endTime: '20261001T120030Z',
    client: 'actual-route', generation: 1, beforeDownload: () => old.stop('SDK superseded') });
  await nextTurn(); assert.equal(downloads, 0); assert.equal(finishes, 0); assert.equal(children.length, 1);
  children[0].complete(null); await sdk.wait();
  assert.equal(downloads, 1); assert.equal(finishes, 1); assert.equal(children.length, 1);
});

test('preview TERM escalation still waits for close before releasing teardown', async t => {
  const process = heldChild(); let finishes = 0;
  const preview = createDvrPreview({ ffmpegPath: 'fixture', spawn: () => process, killGraceMs: 5 });
  const session = preview({ res: new PreviewResponse(), urls: ['rtsp://fixture/main'], duration: 30, onFinish: () => { finishes++; } });
  t.after(async () => { process.complete(0); await session.stop(); });
  const stopped = session.stop(); let settled = false; stopped.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false); assert.equal(finishes, 0);
  process.complete(null); await stopped; assert.equal(finishes, 1);
});

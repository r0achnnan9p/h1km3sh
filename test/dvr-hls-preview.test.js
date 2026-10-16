import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import express from 'express';
import vm from 'node:vm';
import { createDvrHlsPreview, dvrHlsArgs, historicalHlsPlaylist, liveHlsPlaylist, DVR_HLS_MAX_SECONDS, DVR_LIVE_HLS_MAX_SECONDS } from '../lib/dvr-hls-preview.js';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = { url: 'rtsp://private-user:private-password@fixture.invalid/recording', duration: 10, client: 'fixture-client', generation: 1 };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-hls-')), directory = path.join(root, 'sessions');
  const children = [];
  const fakeSpawn = (_binary, args) => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.signals = []; child.directory = path.dirname(args.at(-1));
    child.close = code => { if (!child.closed) { child.closed = true; child.emit('close', code); } };
    child.kill = signal => { child.signals.push(signal); if (!child.holdClose) setImmediate(() => child.close(null)); };
    child.publish = (number = 0) => {
      const name = `segment-${String(number).padStart(6, '0')}.ts`;
      fs.writeFileSync(path.join(child.directory, name), Buffer.from([0x47, 1, 2, 3]));
      fs.writeFileSync(path.join(child.directory, 'index.m3u8'), `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\n${name}\n`);
    };
    children.push(child); return child;
  };
  const manager = createDvrHlsPreview({ root: directory, ffmpegPath: 'fixture', spawn: fakeSpawn, pollMs: 5, killGraceMs: 20, ...options });
  t.after(async () => { for (const child of children) { child.holdClose = false; if (child.signals.length) child.close(null); } await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, manager, children };
}

test('HLS encoder has 2s independently decodable 720p H264 segments and finite resource settings', () => {
  const args = dvrHlsArgs('rtsp://fixture', 120, '/private/session');
  for (const [option, value] of [['-hls_time', '2'], ['-hls_list_size', '0'], ['-hls_playlist_type', 'event'], ['-r', '25'], ['-g', '50'], ['-level:v', '3.1'], ['-c:v', 'libx264'], ['-t', '120']]) assert.equal(args[args.indexOf(option) + 1], value);
  assert.equal(args[args.indexOf('-hls_flags') + 1], 'independent_segments+temp_file');
  assert.ok(!args.includes('-hls_delete_threshold')); assert.equal(DVR_HLS_MAX_SECONDS, 120);
  assert.equal(args[args.indexOf('-maxrate') + 1], '3M'); assert.equal(args[args.indexOf('-bufsize') + 1], '6M');
  assert.ok(args.indexOf('-re') >= 0 && args.indexOf('-re') < args.indexOf('-i'));
  assert.match(args[args.indexOf('-vf') + 1], /1280.*720/); assert.equal(args[args.indexOf('-allowed_media_types') + 1], 'video');
  assert.ok(args.includes('-an')); assert.equal(args[args.lastIndexOf('-threads') + 1], '2');
  for (const duration of [0, 0.49, 120.001, 600, Infinity, NaN]) assert.throws(() => dvrHlsArgs('fixture', duration, '/private'));
});

test('historical playlist pins the preferred origin and rejects sliding or contradictory indexes', () => {
  const source = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nsegment-000000.ts\n';
  const output = historicalHlsPlaylist(source).toString();
  assert.equal(output, source.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'));
  assert.equal((output.match(/#EXT-X-START:/g) || []).length, 1);
  for (const invalid of [source.replace('SEQUENCE:0', 'SEQUENCE:1'), source.replace('TYPE:EVENT', 'TYPE:VOD'), source.replace('#EXTM3U', 'invalid'), output]) assert.throws(() => historicalHlsPlaylist(invalid));
});

test('same request coalesces; one cancelled waiter cannot stop another; stop waits for process close', async t => {
  const { manager, children, directory } = fixture(t);
  const session = await manager.begin(request), same = await manager.begin(request); assert.equal(same, session); assert.equal(children.length, 1);
  const a = new AbortController(), b = new AbortController();
  const aw = session.wait(a.signal), bw = session.wait(b.signal); a.abort(); await assert.rejects(aw, { name: 'AbortError' });
  assert.equal(children[0].signals.length, 0); children[0].publish(); await bw;
  children[0].holdClose = true; let stopped = false;
  const stopping = session.stop('test').then(() => { stopped = true; }); await tick(); assert.equal(stopped, false);
  children[0].close(null); await stopping; assert.equal(manager.current, null); assert.deepEqual(fs.readdirSync(directory), []);
});

test('rapid source changes never spawn stale work or let an old stop reclaim the new session', async t => {
  const { manager, children } = fixture(t);
  await manager.begin(request); children[0].holdClose = true;
  const second = manager.begin({ ...request, generation: 2 }).catch(error => error);
  const third = manager.begin({ ...request, generation: 3 }); await tick(); assert.equal(children.length, 1);
  children[0].close(null); assert.equal((await second).status, 409);
  const latest = await third; assert.equal(children.length, 2); assert.equal(latest.generation, 3);
  await assert.rejects(manager.stopClient(request.client, 2), error => error.status === 409);
  await assert.rejects(manager.begin({ ...request, generation: 1 }), error => error.status === 409);
  assert.equal(manager.current, latest); assert.equal(children[1].signals.length, 0);
  await manager.stopClient('different-client', 100); assert.equal(manager.current, latest);
  await manager.stopClient(request.client, 4); assert.equal(manager.current, null);
});

test('last initial-client cancellation closes FFmpeg and removes its incomplete files', async t => {
  const { manager, children, directory } = fixture(t), signal = new AbortController();
  const session = await manager.begin(request), waiting = session.wait(signal.signal); signal.abort();
  await assert.rejects(waiting, { name: 'AbortError' }); await session.stop('wait cleanup');
  assert.ok(children[0].closed); assert.deepEqual(fs.readdirSync(directory), []);
});

test('foreground server exit force-stops the preview and removes private fragments synchronously', async t => {
  const { manager, children, directory } = fixture(t); await manager.begin(request);
  children[0].publish(); children[0].holdClose = true;
  const closed = manager.killNow();
  assert.ok(children[0].signals.includes('SIGKILL')); assert.deepEqual(fs.readdirSync(directory), []);
  children[0].close(null); await closed; assert.equal(manager.current, null);
});

for (const scenario of ['first-timeout', 'viewer-idle', 'file-limit', 'total-limit', 'duration-limit']) test(`HLS hard bound: ${scenario}`, async t => {
  let now = 1000;
  const { manager, children, directory } = fixture(t, { now: () => now, firstSegmentTimeoutMs: 20, idleTimeoutMs: 30,
    maxSegmentBytes: scenario === 'file-limit' ? 20 : 1000, maxBytes: scenario === 'total-limit' ? 10 : 2000, wallGraceMs: 0 });
  const session = await manager.begin({ ...request, duration: scenario === 'duration-limit' ? 0.5 : 10 });
  if (scenario === 'viewer-idle') { children[0].publish(); await session.wait(); now += 40; }
  if (scenario === 'first-timeout') now += 25;
  if (scenario === 'file-limit') fs.writeFileSync(path.join(session.directory, 'segment-000000.ts.tmp'), Buffer.alloc(21));
  if (scenario === 'total-limit') children[0].publish();
  for (let tries = 0; tries < 100 && !session.finished; tries++) await delay(10);
  assert.equal(session.finished, true); await session.stop('settle');
  assert.ok(children[0].closed); assert.deepEqual(fs.readdirSync(directory), []);
});

test('RTSP process failure returns a fixed message, never credentials, SDP or stderr', async t => {
  const { manager, children } = fixture(t), session = await manager.begin(request);
  children[0].stderr.write('method PLAY failed: 401 rtsp://private-user:private-password@fixture.invalid a=rtpmap');
  children[0].close(1);
  await assert.rejects(session.wait(), error => /认证失败/.test(error.message) && !/private-|rtsp:\/\/|rtpmap/.test(error.message));
});

test('EVENT HLS paces at 1x and retains its historical origin beyond the former rolling window with authenticated Range', { timeout: 35000 }, async t => {
  const processes = [];
  const f = fixture(t, { ffmpegPath, spawn: (binary, args, settings) => {
    const pacing = args.slice(0, args.indexOf('-i')).includes('-re') ? ['-re'] : [];
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...pacing, '-i', path.join(f.root, 'source.mp4'), ...args.slice(args.indexOf('-i') + 2)], settings);
    processes.push(child); return child;
  } });
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '20', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-y', path.join(f.root, 'source.mp4')]);
  const started = Date.now(), session = await f.manager.begin({ ...request, duration: 18 }); await session.wait();
  const firstMs = Date.now() - started;
  console.log(`[DVR HLS 1x fixture] requestedSeconds=18 firstSegmentMs=${firstMs}`);
  assert.ok(firstMs >= 1500 && firstMs < 6500); assert.equal(processes[0].exitCode, null, 'playback starts while input is still arriving');
  const app = express(); app.use(express.json()); app.get('/console/api/dvr-preview/:sessionId/:filename', f.manager.serve);
  app.post('/console/api/dvr-preview/stop', async (req, res) => { await f.manager.stopClient(req.body.client, req.body.generation); res.status(204).end(); });
  const origin = 'https://fixture.example', gateway = createPublicGateway(app, { token: 'fixture-hls-token-abcdefghijklmnopqrstuvwxyz', baseUrl: origin, statusPasswordHash: createStatusPasswordHash('fixture-password') });
  const server = gateway.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, prefix = `/console/api/dvr-preview/${session.id}`;
  assert.equal((await fetch(`${base}${prefix}/index.m3u8`)).status, 401);
  assert.equal((await fetch(`${base}${prefix}/segment-000000.ts`)).status, 401);
  const login = await fetch(`${base}/status/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(`${base}/console/api/dvr-preview/stop`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ client: request.client, generation: 2 }) })).status, 403);
  assert.equal((await fetch(`${base}/console/api/dvr-preview/stop`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ client: request.client, generation: 2 }) })).status, 401);
  const first = await fetch(`${base}${prefix}/index.m3u8`, { headers }); assert.equal(first.status, 200); assert.match(first.headers.get('content-type'), /mpegurl/);
  const playlist = await first.text(); assert.doesNotMatch(playlist, /private-|rtsp:\/\/|fixture\.invalid/);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:EVENT\b/);
  assert.match(playlist, /#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\b/);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0\b/); assert.match(playlist, /segment-000000\.ts/);
  const playlistHead = await fetch(`${base}${prefix}/index.m3u8`, { headers, method: 'HEAD' });
  assert.equal(playlistHead.status, 200); assert.ok(Number(playlistHead.headers.get('content-length')) >= Buffer.byteLength(playlist));
  const playlistRange = await fetch(`${base}${prefix}/index.m3u8`, { headers: { ...headers, Range: 'bytes=8-48' } });
  assert.equal(playlistRange.status, 206); assert.equal(await playlistRange.text(), playlist.slice(8, 49));
  assert.equal(playlistRange.headers.get('content-length'), '41');
  assert.equal((await fetch(`${base}${prefix}/index.m3u8`, { headers: { ...headers, Range: 'bytes=999999999-' } })).status, 416);
  const ifRange = await fetch(`${base}${prefix}/index.m3u8`, { headers: { ...headers, Range: 'bytes=0-7', 'If-Range': '"old-index"' } });
  assert.equal(ifRange.status, 200); assert.match(await ifRange.text(), /#EXT-X-START:TIME-OFFSET=0,PRECISE=YES/);
  const segmentName = playlist.split(/\r?\n/).find(line => /^segment-\d{6}\.ts$/.test(line)); assert.ok(segmentName);
  const segmentUrl = `${base}${prefix}/${segmentName}`;
  const full = await fetch(segmentUrl, { headers }); assert.equal(full.status, 200); assert.equal(Buffer.from(await full.arrayBuffer())[0], 0x47);
  const partial = await fetch(segmentUrl, { headers: { ...headers, Range: 'bytes=0-187' } }); assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 188);
  assert.equal((await fetch(segmentUrl, { headers, method: 'HEAD' })).status, 200);
  assert.equal((await fetch(segmentUrl, { headers: { ...headers, Range: 'bytes=999999999-' } })).status, 416);
  for (const name of ['private.json', 'segment-000000.ts.tmp', '%2e%2e%2fdevices.json']) assert.equal((await fetch(`${base}${prefix}/${name}`, { headers })).status, 404);
  assert.equal((await fetch(`${base}${prefix}/`, { headers })).status, 404);
  await delay(12400);
  const later = await (await fetch(`${base}${prefix}/index.m3u8`, { headers })).text(); assert.notEqual(later, playlist); assert.match(later, /segment-000006\.ts/);
  assert.match(later, /#EXT-X-MEDIA-SEQUENCE:0\b/); assert.match(later, /segment-000000\.ts/);
  assert.equal((await fetch(segmentUrl, { headers })).status, 200, 'historical first segment remains available after 12 seconds');
  const metadata = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,start_time:format=start_time', '-of', 'json', path.join(session.directory, segmentName)], { encoding: 'utf8' }));
  assert.ok(metadata.streams.some(stream => stream.codec_name === 'h264' && stream.width <= 1280 && stream.height <= 720));
  console.log(`[DVR HLS first PTS] seconds=${metadata.format.start_time}`);
  assert.equal(Number(metadata.format.start_time), 0, 'MPEG-TS must not add its usual 1.4s timeline offset');
  let complete = later;
  while (!complete.includes('#EXT-X-ENDLIST') && Date.now() - started < 28000) {
    await delay(500);
    const response = await fetch(`${base}${prefix}/index.m3u8`, { headers }); assert.equal(response.status, 200);
    complete = await response.text();
    assert.match(complete, /#EXT-X-MEDIA-SEQUENCE:0\b/); assert.match(complete, /segment-000000\.ts/);
    assert.equal((complete.match(/#EXT-X-START:/g) || []).length, 1);
  }
  assert.match(complete, /#EXT-X-ENDLIST/);
  const segments = complete.split(/\r?\n/).filter(line => /^segment-\d{6}\.ts$/.test(line));
  assert.equal(segments.length, 9, 'all 18 seconds survive the former six-segment rolling window');
  assert.ok(segments.every(name => fs.existsSync(path.join(session.directory, name))));
  assert.equal((await fetch(segmentUrl, { headers })).status, 200, 'the original fragment remains available after ENDLIST');
  assert.equal(f.manager.current, session, 'normal encoder exit retains media until idle/stop cleanup');
  fs.symlinkSync(path.join(f.root, 'source.mp4'), path.join(session.directory, 'segment-999999.ts'));
  assert.ok([404, 410].includes((await fetch(`${base}${prefix}/segment-999999.ts`, { headers })).status));
  await session.stop('test complete'); assert.ok(processes[0].exitCode !== null || processes[0].signalCode !== null);
  assert.deepEqual(fs.readdirSync(f.directory), []); assert.equal((await fetch(segmentUrl, { headers })).status, 410);
});

test('full 120-second EVENT retains all segments through ENDLIST with stable PTS inside 64MiB', { timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-hls-event-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Accelerated packaging test, distinct from the real-time first-segment test.
  const args = dvrHlsArgs('rtsp://fixture.invalid/source', 120, root);
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', ...args.slice(args.indexOf('-i') + 2)], { timeout: 50000 });
  const playlist = historicalHlsPlaylist(fs.readFileSync(path.join(root, 'index.m3u8'), 'utf8')).toString();
  const segments = playlist.split('\n').filter(line => /^segment-\d{6}\.ts$/.test(line));
  assert.equal(segments.length, 60); assert.equal(segments[0], 'segment-000000.ts'); assert.match(playlist, /#EXT-X-ENDLIST/); assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:EVENT\b/);
  assert.match(playlist, /#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\b/);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0\b/);
  for (const [name, expected] of [[segments[0], 0], [segments[9], 18], [segments.at(-1), 118]]) {
    const pts = Number(execFileSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=start_time', '-of', 'default=nw=1:nk=1', path.join(root, name)], { encoding: 'utf8' }).trim());
    assert.equal(pts, expected);
  }
  const bytes = fs.readdirSync(root).reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0);
  console.log(`[DVR HLS EVENT capacity] durationSeconds=120 segments=${segments.length} totalBytes=${bytes} capBytes=67108864`);
  assert.ok(bytes < 64 * 1024 * 1024); assert.ok(segments.every(name => fs.statSync(path.join(root, name)).size <= 8 * 1024 * 1024));
});

test('HLS HTTP preparation accepts up to 120 seconds and rejects oversized groups before starting work', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const begin = source.indexOf("app.get('/console/api/dvrs/:id/stream', async (req, res, next) => {");
  const end = source.indexOf("app.get('/console/api/dvr-preview/:sessionId/:filename'", begin);
  let handler, calls = [];
  const manager = { accept: () => 1, current: null, begin: async args => { calls.push(args); return { id: 'fixture-session', wait: async () => {}, stop: async () => {} }; } };
  const context = vm.createContext({ app: { get(_path, fn) { handler = fn; } }, AbortController, DVR_HLS_MAX_SECONDS,
    exportRecoveryBlocked: false, getRunningTask: () => null, getConsoleDvr: () => ({ id: 'fixture' }),
    CHANNEL_PATTERN: /^\d+$/, getConsoleDvrHls: () => manager, consolePreviewGeneration: 0, activePreview: null, consoleDvrHls: null, consoleDvrSdk: null,
    dvrRtspUrl(_device, channel, { duration }) { return `rtsp://fixture.invalid/${channel}?duration=${duration}`; }, mainDvrChannel: x => x });
  vm.runInContext(source.slice(begin, end), context);
  const app = express(); app.get('/preview', handler);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/preview?format=hls&channel=201&start=2026-09-30T12:00:00.000Z&client=fixture-client&generation=1`;
    for (const duration of ['0', '0.49', '120.001', '600', 'NaN', 'Infinity', '']) {
      const response = await fetch(`${base}&duration=${duration}`, { redirect: 'manual' }); assert.equal(response.status, 400, duration); assert.equal(calls.length, 0);
    }
    for (const duration of [0.5, 2, 119.999, 120]) {
      const response = await fetch(`${base}&duration=${duration}`, { redirect: 'manual' }); assert.equal(response.status, 302, String(duration));
      assert.match(response.headers.get('location'), /dvr-preview\/fixture-session\/index\.m3u8$/); assert.equal(calls.at(-1).duration, duration);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test('live HLS uses a bounded sliding window without historical origin hints', () => {
  const args = dvrHlsArgs('rtsp://fixture', 600, '/private/session', { live: true });
  assert.equal(args[args.indexOf('-hls_list_size') + 1], '6');
  assert.equal(args[args.indexOf('-hls_delete_threshold') + 1], '2');
  assert.match(args[args.indexOf('-hls_flags') + 1], /delete_segments/);
  assert.ok(!args.includes('-hls_playlist_type')); assert.ok(!args.includes('-re'));
  assert.equal(DVR_LIVE_HLS_MAX_SECONDS, 600);
  assert.throws(() => dvrHlsArgs('rtsp://fixture', 601, '/private', { live: true }));
  const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2,\nsegment-000005.ts\n';
  assert.equal(liveHlsPlaylist(playlist).toString(), playlist);
  assert.throws(() => historicalHlsPlaylist(playlist));
  assert.throws(() => liveHlsPlaylist(playlist + '#EXT-X-START:TIME-OFFSET=0\n'));
});

test('live and historical HLS share one manager and await old process shutdown', async t => {
  const { manager, children } = fixture(t);
  const old = await manager.begin(request); children[0].holdClose = true;
  const live = manager.begin({ ...request, generation: 2, live: true, duration: 600 });
  await tick(); assert.equal(children.length, 1);
  children[0].close(null); const next = await live;
  assert.equal(old.finished, true); assert.equal(next.live, true); assert.equal(children.length, 2);
  fs.writeFileSync(path.join(next.directory, 'segment-000008.ts'), Buffer.from([0x47, 1, 2]));
  fs.writeFileSync(path.join(next.directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:8\n#EXTINF:2,\nsegment-000008.ts\n');
  await next.wait(); assert.equal(manager.current, next);
});

test('offline live HLS rolls segments, is H264 720p-compatible, and each segment decodes', { timeout: 30000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-live-hls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = dvrHlsArgs('rtsp://fixture.invalid', 30, root, { live: true });
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', ...args.slice(args.indexOf('-i') + 2)], { timeout: 25000 });
  const text = liveHlsPlaylist(fs.readFileSync(path.join(root, 'index.m3u8'), 'utf8')).toString();
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:9\b/); assert.doesNotMatch(text, /#EXT-X-START|PLAYLIST-TYPE/);
  const names = text.split('\n').filter(line => /^segment-\d{6}\.ts$/.test(line));
  assert.equal(names.length, 6); assert.ok(!fs.existsSync(path.join(root, 'segment-000000.ts')));
  assert.ok(fs.readdirSync(root).filter(x => x.endsWith('.ts')).length <= 8);
  for (const name of names) execFileSync(ffmpegPath, ['-v', 'error', '-xerror', '-i', path.join(root, name), '-f', 'null', '-'], { timeout: 5000 });
  const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, names[0])], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].codec_name, 'h264'); assert.ok(['Main', 'Constrained Baseline'].includes(probe.streams[0].profile));
  assert.equal(probe.streams[0].level, 31); assert.equal(probe.streams[0].pix_fmt, 'yuv420p');
});

test('live HLS route chooses live RTSP and 600 second cap, preserving prefixed relative redirects', async t => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const begin = source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res, next) => {");
  const end = source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res) => {", begin);
  let handler, calls = [];
  const manager = { accept: () => 1, current: null, begin: async args => { calls.push(args); return { id: 'fixture-session', wait: async () => {}, stop: async () => {} }; } };
  const context = vm.createContext({ app: { get(_path, _guard, fn) { handler = fn; } }, preparationGuard() {}, AbortController,
    exportRecoveryBlocked: false, getRunningTask: () => null, getConsoleDvr: () => ({ id: 'fixture' }),
    CHANNEL_PATTERN: /^\d+$/, getConsoleDvrHls: () => manager, consolePreviewGeneration: 0, activePreview: null, consoleDvrHls: null, consoleDvrSdk: null,
    readConsoleDvrChannels: async () => [{ id: '201', substreamId: '202' }],
    dvrRtspUrl(_device, channel, { live }) { assert.equal(live, true); return `rtsp://fixture.invalid/${channel}`; }, mainDvrChannel: x => x });
  vm.runInContext(source.slice(begin, end), context);
  const app = express(); app.get('/prefix/console/api/dvrs/fixture/live', handler);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/prefix/console/api/dvrs/fixture/live`;
  assert.equal((await fetch(`${base}?format=hls&channel=bad`, { redirect: 'manual' })).status, 400); assert.equal(calls.length, 0);
  const response = await fetch(`${base}?format=hls&channel=201&client=fixture-client&generation=1`, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(calls[0].live, true); assert.equal(calls[0].duration, 600);
  assert.deepEqual(Array.from(calls[0].urls), ['rtsp://fixture.invalid/202', 'rtsp://fixture.invalid/201']);
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/prefix/console/api/dvr-preview/fixture-session/index.m3u8');
});


const liveRequest = { ...request, live: true, duration: 600, urls: ['rtsp://fixture/sub', 'rtsp://fixture/main'] };
function publishLive(child) {
  child.publish();
  const file = path.join(child.directory, 'index.m3u8');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('#EXT-X-PLAYLIST-TYPE:EVENT\n', ''));
}
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } assert.fail('fixture condition did not settle'); }

test('live HLS sub timeout awaits close before main and keeps coalesced second waiter alive', async t => {
  let now = 1000;
  const { manager, children } = fixture(t, { now: () => now, firstSegmentTimeoutMs: 20 });
  const session = await manager.begin(liveRequest), first = new AbortController(), second = new AbortController();
  const a = session.wait(first.signal), b = session.wait(second.signal);
  first.abort(); await assert.rejects(a, { name: 'AbortError' });
  children[0].holdClose = true; now += 25; await until(() => children[0].signals.includes('SIGTERM'));
  assert.equal(children.length, 1); children[0].close(null); assert.equal(children.length, 2);
  publishLive(children[1]); await b; assert.equal(session.finished, false); assert.equal(manager.current, session);
});

test('live HLS errors try two unique sources only and never publish failed media', async t => {
  const { manager, children } = fixture(t);
  const session = await manager.begin({ ...liveRequest, urls: [...liveRequest.urls, liveRequest.urls[1]] });
  const waiting = session.wait(); children[0].close(1); assert.equal(children.length, 2);
  children[1].close(1); await assert.rejects(waiting); await session.stop();
  assert.equal(children.length, 2); assert.equal(manager.current, null);
});

for (const reason of ['cancel', 'generation', 'export']) test(`live HLS never starts fallback after ${reason} during held close`, async t => {
  let now = 1000, current = true;
  const { manager, children } = fixture(t, { now: () => now, firstSegmentTimeoutMs: 20 });
  const session = await manager.begin({ ...liveRequest, isCurrent: () => current }), signal = new AbortController();
  const waiting = session.wait(signal.signal); waiting.catch(() => {});
  children[0].holdClose = true; now += 25; await until(() => children[0].signals.includes('SIGTERM'));
  if (reason === 'cancel') signal.abort();
  if (reason === 'generation') manager.accept(request.client, 2);
  if (reason === 'export') current = false;
  children[0].close(null); await assert.rejects(waiting); await session.stop(); assert.equal(children.length, 1);
});

test('live HLS HTTP first waiter disconnect does not cancel shared fallback for the second', async t => {
  const f = fixture(t), source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const begin = source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res, next) => {");
  const end = source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard, async (req, res) => {", begin);
  let handler;
  const context = vm.createContext({ app: { get(_path, _guard, fn) { handler = fn; } }, preparationGuard() {}, AbortController,
    exportRecoveryBlocked: false, getRunningTask: () => null, getConsoleDvr: () => ({ id: 'fixture' }),
    CHANNEL_PATTERN: /^\d+$/, getConsoleDvrHls: () => f.manager, consolePreviewGeneration: 0, activePreview: null, consoleDvrHls: f.manager, consoleDvrSdk: null,
    readConsoleDvrChannels: async () => [{ id: '201', substreamId: '202' }],
    dvrRtspUrl: (_device, channel) => `rtsp://fixture.invalid/${channel}`, mainDvrChannel: x => x });
  vm.runInContext(source.slice(begin, end), context);
  const app = express(); app.get('/live', handler);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/live?format=hls&channel=201&client=fixture-client&generation=1`;
  const abort = new AbortController(), first = fetch(url, { redirect: 'manual', signal: abort.signal }); first.catch(() => {});
  await until(() => f.children.length === 1);
  const session = f.manager.current; let waits = 0; const originalWait = session.wait;
  session.wait = (...args) => { waits++; return originalWait(...args); };
  const second = fetch(url, { redirect: 'manual' }); await until(() => waits === 1);
  abort.abort(); await assert.rejects(first); await delay(20);
  f.children[0].close(1); assert.equal(f.children.length, 2); publishLive(f.children[1]);
  assert.equal((await second).status, 302); assert.equal(f.manager.current, session); assert.equal(session.finished, false);
});

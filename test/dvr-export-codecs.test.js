/** In-memory RTSP only: these tests never use a recorder or device configuration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullRtspRaw } from '../lib/rtsp-client.js';
import { dvrExportError } from '../lib/dvr-export-errors.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const aac = ['m=audio 0 RTP/AVP 104', 'a=rtpmap:104 MPEG4-GENERIC/16000', 'a=control:trackID=audio', 'a=fmtp:104 config=1408;SizeLength=13;IndexLength=3;IndexDeltaLength=3;'];
const frame = (channel, payload, payloadType = 96) => {
  const rtp = Buffer.alloc(12 + payload.length); rtp[0] = 0x80; rtp[1] = 0x80 | payloadType; rtp.writeUInt32BE(9000, 4); payload.copy(rtp, 12);
  const header = Buffer.from([0x24, channel, 0, 0]); header.writeUInt16BE(rtp.length, 2);
  return Buffer.concat([header, rtp]);
};

function recorder(t, { codec = 'H264', audio = [], holdPlay = false, holdClose = false, responseStatus = 200 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-codec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = new EventEmitter(), requests = [];
  let closed = false, play;
  const playing = new Promise(resolve => { play = resolve; });
  const close = () => { if (!closed) { closed = true; socket.emit('close'); } };
  socket.setTimeout = socket.setNoDelay = socket.pause = socket.resume = () => {};
  socket.destroy = () => { if (!holdClose) close(); };
  socket.write = request => {
    const [method, url] = request.split(' '); requests.push({ method, url });
    if (method === 'TEARDOWN') { if (!holdClose) setImmediate(close); return true; }
    const body = method === 'DESCRIBE' ? ['v=0', 'm=video 0 RTP/AVP 96', `a=rtpmap:96 ${codec}/90000`, 'a=control:trackID=video', ...audio].join('\r\n') : '';
    setImmediate(() => {
      socket.emit('data', Buffer.from(`RTSP/1.0 ${responseStatus} fixture-status\r\nSession: fixture\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
      if (method === 'PLAY') {
        play();
        if (!holdPlay) {
          if (audio.length) socket.emit('data', frame(2, Buffer.from([0, 16, 0, 40, 1, 2, 3, 4, 5]), 104));
          socket.emit('data', frame(0, Buffer.from([0x65, 1, 2, 3])));
        }
      }
    });
    return true;
  };
  const controller = new AbortController();
  const videoPath = path.join(root, 'fixture.h264'), audioPath = path.join(root, 'fixture.aac');
  const result = pullRtspRaw({ ip: 'fixture.invalid', user: 'fixture', pass: 'fixture', path: '/Streaming/tracks/201',
    outPath: videoPath, audioOutPath: audioPath, signal: controller.signal, maxFrames: 1, connectTimeoutMs: 1000, maxWallMs: 2000,
    createConnection: () => { setImmediate(() => socket.emit('connect')); return socket; } });
  return { result, requests, controller, playing, close, videoPath, audioPath };
}

test('H264 without an audio track succeeds video-only and never SETUPs audio', async t => {
  const f = recorder(t), result = await f.result;
  assert.equal(result.frames, 1); assert.equal(result.audioFrames, 0);
  assert.equal(result.meta.audio.codec, null);
  assert.deepEqual(f.requests.map(r => r.method), ['DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN']);
  assert.match(f.requests[1].url, /trackID=video$/);
  assert.equal(fs.statSync(f.audioPath).size, 0);
  assert.equal(fs.readFileSync(f.videoPath).toString('hex'), '0000000165010203');
});

test('H264 AAC still negotiates both tracks and retains audio', async t => {
  const f = recorder(t, { audio: aac }), result = await f.result;
  assert.equal(result.frames, 1); assert.equal(result.audioFrames, 1);
  assert.equal(result.meta.audio.codec, 'MPEG4-GENERIC');
  assert.deepEqual(f.requests.filter(r => r.method === 'SETUP').map(r => r.url.split('/').pop()), ['trackID=video', 'trackID=audio']);
  assert.equal(fs.readFileSync(f.audioPath)[0], 0xff); assert.equal(fs.statSync(f.audioPath).size, 12);
});

for (const codec of ['H265', 'HEVC', 'JPEG', 'private-password@fixture.invalid']) test(`unsupported video codec ${codec.split('@')[0]} fails before RTP negotiation`, async t => {
  const f = recorder(t, { codec, audio: aac });
  await assert.rejects(f.result, error => {
    assert.equal(error.code, 'DVR_VIDEO_CODEC_UNSUPPORTED');
    assert.equal(error.message, dvrExportError(error.code).message);
    assert.doesNotMatch(error.message, /private-password|fixture\.invalid|rtsp:\/\/|a=rtpmap/); return true;
  });
  assert.deepEqual(f.requests.map(r => r.method), ['DESCRIBE']);
  assert.equal(fs.statSync(f.videoPath).size, 0); assert.equal(fs.statSync(f.audioPath).size, 0);
});

for (const codec of ['PCMA', 'PCMU', 'G726', 'private-password@fixture.invalid']) test(`unsupported audio codec ${codec.split('@')[0]} does not silently drop sound`, async t => {
  const f = recorder(t, { audio: ['m=audio 0 RTP/AVP 8', `a=rtpmap:8 ${codec}/8000`, 'a=control:trackID=audio'] });
  await assert.rejects(f.result, error => {
    assert.equal(error.code, 'DVR_AUDIO_CODEC_UNSUPPORTED'); assert.equal(error.message, dvrExportError(error.code).message); return true;
  });
  assert.deepEqual(f.requests.map(r => r.method), ['DESCRIBE']);
  assert.equal(fs.statSync(f.videoPath).size, 0);
});

for (const audio of [
  ['m=audio 0 RTP/AVP 104', 'a=control:trackID=audio'],
  aac.filter(line => !line.startsWith('a=fmtp:')),
  aac.map(line => line.startsWith('a=fmtp:') ? 'a=fmtp:104 config=not-hex-private-password;' : line),
]) test('advertised malformed audio is not mistaken for absent audio', async t => {
  const f = recorder(t, { audio });
  await assert.rejects(f.result, error => error.code === 'DVR_AUDIO_INVALID' && error.message === dvrExportError(error.code).message);
  assert.deepEqual(f.requests.map(r => r.method), ['DESCRIBE']);
});

test('cancelling video-only RTSP sends TEARDOWN and waits for actual TCP closure', async t => {
  const f = recorder(t, { holdPlay: true, holdClose: true });
  let settled = false;
  const result = f.result.catch(error => error).finally(() => { settled = true; });
  await f.playing; f.controller.abort(); await tick();
  assert.equal(f.requests.filter(r => r.method === 'TEARDOWN').length, 1);
  assert.equal(settled, false);
  f.close(); assert.match((await result).message, /Download aborted/);
});

test('RTSP status failure exposes only its fixed classification', async t => {
  const f = recorder(t, { responseStatus: 404 });
  await assert.rejects(f.result, error => error.code === 'DVR_NOT_FOUND' && !error.message.includes('fixture-status'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { normalizeDeviceEndpoint, deviceHttpOrigin, deviceRtspAuthority, deviceEndpointIdentity, deviceCacheKey } from '../lib/device-endpoint.js';
import { searchRecordings } from '../lib/recording-search.js';
import { listRecordTracks, clearRecordTrackCache } from '../lib/record-tracks.js';
import { getChannelFps, clearStreamParamCache } from '../lib/stream-params.js';
import { downloadFiles, getCacheFilePath } from '../lib/file-downloader.js';
import { pullRtspRaw } from '../lib/rtsp-client.js';
import { resolveRecoveryDevice, cameraRecoveryRequest } from '../lib/export-recovery.js';

const recording = { channel: '101', startTime: '2020-01-01T00:00:00Z', endTime: '2020-01-01T00:01:00Z', size: 5, playbackURI: 'rtsp://recorder/Streaming/tracks/101' };
test('addresses are host-only, ports are independent, safe legacy HTTP authorities remain readable', () => {
  assert.deepEqual(normalizeDeviceEndpoint('DVR.example:8080'), { ip: 'dvr.example', httpPort: 8080, rtspPort: 554 });
  assert.equal(deviceHttpOrigin({ ip: '::1', httpPort: 8081 }), 'http://[::1]:8081');
  assert.equal(deviceRtspAuthority({ ip: '[::1]:8081', rtspPort: 8554 }), '[::1]:8554');
  for (const ip of ['user@host', 'http://host', 'host/path', 'host?x', 'host#x', 'host\n', 'host:80\r\nX:1', '-x', 'host\\path', '[no-ipv6]', 'host:0']) assert.throws(() => normalizeDeviceEndpoint(ip));
  for (const port of [0, 65536, 1.2, null, '', '80.0', '-1', true]) {
    assert.throws(() => normalizeDeviceEndpoint({ ip: 'host', httpPort: port }));
    assert.throws(() => normalizeDeviceEndpoint({ ip: 'host', rtspPort: port }));
  }
  assert.throws(() => normalizeDeviceEndpoint({ ip: 'host:81', httpPort: 82 }));
});
test('cache identity separates DVR IDs and both ports for the same channel/time', () => {
  const a = { deviceId: 'a', ip: '127.0.0.1', httpPort: 8080, rtspPort: 8554 };
  const keys = [a, { ...a, deviceId: 'b' }, { ...a, httpPort: 8081 }, { ...a, rtspPort: 8555 }].map(endpoint => getCacheFilePath('/tmp', recording, endpoint));
  assert.equal(new Set(keys).size, 4);
  assert.equal(deviceCacheKey(a), deviceCacheKey({ ...a, password: 'secret' }));
});
async function mockHttp(t, fps, content) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); req.resume();
    res.setHeader('Content-Type', 'application/xml');
    if (req.url.endsWith('/record/tracks')) res.end(`<TrackList><Track><id>101</id><Description>framerate=${fps} fps</Description></Track></TrackList>`);
    else if (req.url.endsWith('/Streaming/channels/101')) res.end(`<Video><maxFrameRate>${fps * 100}</maxFrameRate></Video>`);
    else if (req.url.endsWith('/search')) res.end('<CMSearchResult><responseStatus>true</responseStatus><responseStatusStrg>OK</responseStatusStrg><numOfMatches>0</numOfMatches></CMSearchResult>');
    else if (req.url.endsWith('/download')) res.end(content);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { ip: '127.0.0.1', httpPort: server.address().port, rtspPort: 8554, requests };
}
test('ISAPI search, stream lookup, tracks, and download honor two mock DVR HTTP ports without cache mixing', async t => {
  const a = await mockHttp(t, 12, 'AAAAA'), b = await mockHttp(t, 25, 'BBBBB');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-endpoints-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  clearRecordTrackCache(); clearStreamParamCache();
  assert.equal((await listRecordTracks(a, 'u', 'p')).get('101').fps, 12);
  assert.equal((await listRecordTracks(b, 'u', 'p')).get('101').fps, 25);
  assert.equal(await getChannelFps(a, 'u', 'p', '101'), 12);
  assert.equal(await getChannelFps(b.ip, 'u', 'p', '101', b.httpPort), 25);
  await assert.rejects(searchRecordings(a.ip, 'u', 'p', '101', recording.startTime, recording.endTime, a.httpPort), /无可用录像/);
  assert.ok(a.requests.some(url => url.endsWith('/search')));
  for (const [device, expected] of [[a, 'AAAAA'], [b, 'BBBBB']]) {
    const result = await downloadFiles({ ...device, user: 'u', pass: 'p', recordingFiles: [recording], outputDir: dir });
    assert.equal(result[0].skipped, false); assert.equal(fs.readFileSync(result[0].filePath, 'utf8'), expected);
    const before = device.requests.length;
    const again = await downloadFiles({ ...device, user: 'u', pass: 'p', recordingFiles: [recording], outputDir: dir });
    assert.equal(again[0].skipped, true);
    assert.equal(device.requests.length, before);
  }
  assert.ok(a.requests.some(url => url.endsWith('/download')));
  assert.ok(b.requests.some(url => url.endsWith('/download')));
});
test('RTSP connects to configured RTSP port independently of legacy HTTP port', async t => {
  let request;
  const server = net.createServer(socket => socket.once('data', data => {
    request = data.toString(); socket.end('RTSP/1.0 404 Not Found\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rtspPort = server.address().port;
  await assert.rejects(pullRtspRaw({ ip: '127.0.0.1:8080', rtspPort, user: 'u', pass: 'p', path: '/Streaming/tracks/101', outStream: new PassThrough(), connectTimeoutMs: 1000 }), /404/);
  assert.ok(request.startsWith(`DESCRIBE rtsp://127.0.0.1:${rtspPort}/Streaming/tracks/101 RTSP/1.0`));
});
test('recovery rejects port drift and supports old default-port snapshots', () => {
  const device = { id: 'a', ip: '192.0.2.1', httpPort: 8080, rtspPort: 8554 };
  const request = cameraRecoveryRequest('clip', {}, { id: 'camera', channel: '101' }, device, true, 'clip.mp4');
  assert.equal(request.endpoint, deviceEndpointIdentity(device));
  assert.equal(resolveRecoveryDevice(request, () => device), device);
  assert.throws(() => resolveRecoveryDevice(request, () => ({ ...device, httpPort: 8081 })));
  assert.throws(() => resolveRecoveryDevice(request, () => ({ ...device, rtspPort: 8555 })));
  assert.ok(resolveRecoveryDevice({ deviceId: 'old', endpoint: '192.0.2.1' }, () => ({ id: 'old', ip: '192.0.2.1' })));
  assert.throws(() => resolveRecoveryDevice({ deviceId: 'old', endpoint: '192.0.2.1' }, () => device));
});

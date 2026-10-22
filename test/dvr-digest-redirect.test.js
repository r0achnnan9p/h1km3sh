/** Real curl against synthetic loopback fixtures only. No device/config/service reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchRecordingPage, readDownloadCapabilities } from '../lib/dvr-recording-inspection.js';
import { runDvrHttpSample, DVR_HTTP_SAMPLE_MAX_BYTES, DVR_HTTP_SAMPLE_TIMEOUT_MS } from '../lib/dvr-http-sample.js';

const execute = promisify(execFile);
const USER = 'loopback-fixture-user', PASS = 'loopback-fixture-password';
const REALM = 'loopback-fixture', NONCE = 'fixed-loopback-nonce';
const SEARCH = '/ISAPI/ContentMgmt/search';
const CAPABILITIES = '/ISAPI/ContentMgmt/download/capabilities';
const MEDIA = '/ISAPI/ContentMgmt/download';
const TARGET = '/must-never-follow';
const times = { startTime: '2026-10-01T21:40:26Z', endTime: '2026-10-01T21:40:36Z' };
const playbackURI = 'rtsp://127.0.0.1:8554/Streaming/tracks/201/?starttime=20261001T214020Z&endtime=20261001T214050Z&size=16384';
const searchXml = `<CMSearchResult><responseStatus>true</responseStatus><numOfMatches>1</numOfMatches><totalMatches>1</totalMatches><matchList><searchMatchItem><timeSpan><startTime>2026-10-01T21:40:20Z</startTime><endTime>2026-10-01T21:40:50Z</endTime></timeSpan><mediaSegmentDescriptor><playbackURI>${playbackURI.replace(/&/g, '&amp;')}</playbackURI></mediaSegmentDescriptor></searchMatchItem></matchList></CMSearchResult>`;
const capabilityXml = '<DownloadAbility xmlns="http://www.isapi.org/ver20/XMLSchema"><isSupportDownloadbyTime>true</isSupportDownloadbyTime></DownloadAbility>';
const md5 = value => createHash('md5').update(value).digest('hex');

function validDigest(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Digest ')) return false;
  const fields = {};
  for (const item of header.slice(7).matchAll(/(\w+)=(?:"([^"\\]*)"|([^,\s]+))/g)) fields[item[1]] = item[2] ?? item[3];
  if (fields.username !== USER || fields.realm !== REALM || fields.nonce !== NONCE
    || fields.uri !== req.url || fields.qop !== 'auth' || !fields.cnonce || fields.nc !== '00000001') return false;
  const ha1 = md5(`${USER}:${REALM}:${PASS}`), ha2 = md5(`${req.method}:${req.url}`);
  return fields.response === md5(`${ha1}:${NONCE}:${fields.nc}:${fields.cnonce}:auth:${ha2}`);
}

async function fixture(t, { redirects = [], challenge = true, body = Buffer.alloc(4096, 0x78) } = {}) {
  const requests = [], calls = [], retained = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-digest-loopback-'));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const authenticated = validDigest(req);
      requests.push({ method: req.method, url: req.url, authenticated, body: Buffer.concat(chunks).toString('utf8') });
      // This route deliberately succeeds so following a Location is observable.
      if (req.url === TARGET) { res.writeHead(200); res.end('redirect target was reached'); return; }
      if (challenge && !authenticated) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${NONCE}", algorithm=MD5, qop="auth"`,
          'Content-Type': 'text/plain' });
        res.end('Digest challenge body must not become sample bytes'); return;
      }
      if (redirects.includes(req.url)) {
        res.writeHead(302, { Location: `${origin}${TARGET}`, 'Content-Type': 'application/octet-stream' });
        res.end('redirect response must not become sample bytes'); return;
      }
      if (req.url === SEARCH) { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(searchXml); return; }
      if (req.url === CAPABILITIES) { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(capabilityXml); return; }
      if (req.url === MEDIA) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(body); return; }
      res.writeHead(404); res.end();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const query = { ip: '127.0.0.1', httpPort: port, rtspPort: 8554, user: USER, pass: PASS, channel: '201', ...times };
  // Do not allow ambient proxy configuration to move even fixture credentials
  // off loopback. Product arguments are otherwise passed to installed curl intact.
  const env = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
  function check(binary, args) {
    assert.match(binary, /^curl(?:\.exe)?$/);
    const url = new URL(args.at(-1));
    assert.equal(url.origin, origin);
    assert.ok([SEARCH, CAPABILITIES, MEDIA].includes(url.pathname));
    assert.equal(args[0], '--disable');
    assert.equal(args.includes('--location'), false);
    assert.equal(args.includes('-L'), false);
    const maxTime = Number(args[args.indexOf('--max-time') + 1]);
    assert.ok(maxTime > 0 && maxTime <= (url.pathname === MEDIA ? 20 : 5));
    calls.push({ url: url.pathname, args });
  }
  const exec = async (binary, args, options) => {
    check(binary, args);
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    assert.equal(options.maxBuffer, args.at(-1).endsWith(CAPABILITIES) ? 64 * 1024 : 1024 * 1024);
    return execute(binary, args, { ...options, env });
  };
  const realSpawn = (binary, args, options) => {
    check(binary, args); // A non-media fixture must never launch ffprobe/ffmpeg.
    const child = spawn(binary, args, { ...options, env });
    if (args.at(-1) === `${origin}${MEDIA}`) {
      const request = args[args.indexOf('--data-binary') + 1].slice(1);
      child.once('close', () => retained.push(fs.readFileSync(path.join(path.dirname(request), 'sample.bin'))));
    }
    return child;
  };
  let beforeMedia = 0;
  return { query, requests, calls, retained, root, exec,
    sample: deps => runDvrHttpSample({ device: { ip: query.ip, httpPort: port, rtspPort: 8554, username: USER, password: PASS },
      channel: '201', ...times, privateRoot: root, beforeMedia: () => { beforeMedia++; } },
    { lookup: () => null, spawn: realSpawn, ...deps }),
    get beforeMedia() { return beforeMedia; },
    authenticatedPair(route, method) {
      const hits = requests.filter(request => request.url === route);
      assert.equal(hits.length, 2, `${route} must make exactly its Digest challenge and authenticated request`);
      assert.deepEqual(hits.map(hit => hit.authenticated), [false, true]);
      assert.deepEqual(hits.map(hit => hit.method), [method, method]);
      return hits[1];
    },
    noRedirectTarget() {
      assert.equal(requests.filter(request => request.url === TARGET).length, 0);
      for (const { args } of calls) {
        assert.ok(args.includes('--no-location'));
        assert.equal(args.includes('--max-redirs'), false, 'Digest authentication must not share a zero redirect budget');
      }
    },
    cleaned() { assert.deepEqual(fs.readdirSync(root), []); },
  };
}

test('installed curl completes real Digest 401 to 200 for recording search and capabilities', async t => {
  const f = await fixture(t);
  const search = await searchRecordingPage(f.query, { exec: f.exec });
  assert.equal(search.files.length, 1); assert.equal(search.files[0].playbackURI, playbackURI);
  assert.equal(search.files[0].channel, '201'); assert.equal(search.truncated, false);
  const request = f.authenticatedPair(SEARCH, 'POST');
  assert.match(request.body, /<maxResults>40<\/maxResults>/);
  assert.match(request.body, /<searchResultPostion>0<\/searchResultPostion>/);
  assert.equal(await readDownloadCapabilities(f.query, { exec: f.exec }), 'supported');
  f.authenticatedPair(CAPABILITIES, 'GET');
  assert.equal(f.calls.length, 2); f.noRedirectTarget();
});

for (const [name, maxBytes, expectedBytes, stopReason] of [
  ['EOF', 8192, 4096, 'eof'], ['byte cap', 1024, 1024, 'byte_limit'],
]) test(`installed curl authenticates search and media; ${name} retains only final 200 body bytes`, async t => {
  const f = await fixture(t);
  const report = await f.sample({ maxBytes });
  assert.equal(report.outcome, 'undecodable'); assert.equal(report.httpStatus, 200);
  assert.equal(report.bytes, expectedBytes); assert.equal(report.stopReason, stopReason);
  assert.equal(report.decodedFrames, 0); assert.equal(f.beforeMedia, 1);
  f.authenticatedPair(SEARCH, 'POST');
  assert.match(f.authenticatedPair(MEDIA, 'POST').body, /<downloadRequest><playbackURI>/);
  assert.equal(f.calls.length, 2, 'one real curl child for search and one for media');
  assert.deepEqual(f.retained, [Buffer.alloc(expectedBytes, 0x78)]);
  assert.equal(DVR_HTTP_SAMPLE_MAX_BYTES, 32_000_000); assert.equal(DVR_HTTP_SAMPLE_TIMEOUT_MS, 20_000);
  f.noRedirectTarget(); f.cleaned();
});

for (const challenge of [false, true]) test(`metadata 302 is never followed${challenge ? ' after Digest authentication' : ''}`, async t => {
  const f = await fixture(t, { redirects: [SEARCH, CAPABILITIES], challenge });
  await assert.rejects(searchRecordingPage(f.query, { exec: f.exec }), error => error.code === 'FAILED');
  assert.equal(await readDownloadCapabilities(f.query, { exec: f.exec }), 'unknown');
  if (challenge) { f.authenticatedPair(SEARCH, 'POST'); f.authenticatedPair(CAPABILITIES, 'GET'); }
  else assert.equal(f.requests.length, 2);
  assert.equal(f.requests.filter(request => request.url === MEDIA).length, 0);
  assert.equal(f.calls.length, 2); f.noRedirectTarget();
});

test('sample search Digest to 302 cannot consume approval or attempt media', async t => {
  const f = await fixture(t, { redirects: [SEARCH] });
  const report = await f.sample();
  assert.equal(report.outcome, 'failed'); assert.equal(report.bytes, 0);
  assert.equal(f.beforeMedia, 0); f.authenticatedPair(SEARCH, 'POST');
  assert.equal(f.requests.filter(request => request.url === MEDIA).length, 0);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.retained, []);
  f.noRedirectTarget(); f.cleaned();
});

test('successful authenticated search cannot enable following the media Digest to 302 redirect', async t => {
  const f = await fixture(t, { redirects: [MEDIA] });
  const report = await f.sample();
  assert.equal(report.outcome, 'http_error'); assert.equal(report.httpStatus, 302);
  assert.equal(report.bytes, 0); assert.equal(report.stopReason, 'http_error');
  assert.equal(f.beforeMedia, 1); assert.equal(f.calls.length, 2);
  f.authenticatedPair(SEARCH, 'POST'); f.authenticatedPair(MEDIA, 'POST');
  assert.deepEqual(f.retained, [Buffer.alloc(0)]); f.noRedirectTarget(); f.cleaned();
});

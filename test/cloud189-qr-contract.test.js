import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchCloud189Qr, validateCloud189QrUrl } from '../lib/upload-account-adapter.js';
const nested = 'https://open.e.189.cn/api/account/qrClinentLogin.do?paras=new_uuid%3DSYNTHETIC_ONLY%7C9317140619';
const outer = payload => 'https://open.e.189.cn/api/logbox/oauth2/image.do?' + new URLSearchParams({ REQID: 'test-only', uuid: payload });

test('cloud189 accepts the exact nested provider QR target without rewriting its bytes', () => {
  assert.equal(validateCloud189QrUrl(outer(nested)), outer(nested));
});
test('cloud189 rejects nested QR phishing, altered app, duplicate fields and encoded control tricks', () => {
  for (const payload of [
    nested.replace('https:', 'http:'), nested.replace('open.e.189.cn', 'evil.example'),
    nested.replace('open.e.189.cn', 'open.e.189.cn.evil.example'), nested.replace('open.e.189.cn', 'user@open.e.189.cn'),
    nested.replace('open.e.189.cn', 'open.e.189.cn:443'), nested.replace('qrClinentLogin.do', 'other.do'),
    nested.replace('9317140619', '8025431004'), nested + '&paras=x', nested + '&target=x', nested + '#fragment',
    encodeURIComponent(nested), nested.replace('%3D', '%253D'), nested.replace('%7C', '%257C'),
    nested.replace('SYNTHETIC_ONLY', 'a'.repeat(129)), nested.replace('SYNTHETIC_ONLY', ''),
    nested.replace('SYNTHETIC_ONLY', 'x%26target%3Dy'), nested.replace('SYNTHETIC_ONLY', 'x%2Fy'),
    ...['\n', '\r', '\t', ' ', '\x7f'].flatMap(char => [
      nested.replace('open.e', 'open' + char + '.e'), nested.replace('/api/', '/api/' + char),
      nested.replace('SYNTHETIC_ONLY', 'x' + char + 'y'),
      nested.replace('SYNTHETIC_ONLY', 'x' + encodeURIComponent(char) + 'y'),
    ]),
  ]) assert.equal(validateCloud189QrUrl(outer(payload)), null);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1d8AAAAASUVORK5CYII=', 'base64');
function imageRequest(bytes, type, status = 200) {
  return (url, options, callback) => {
    assert.equal(url, outer(nested));
    assert.equal(options.method, 'GET');
    const request = new EventEmitter();
    request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
    request.end = () => {
      const response = Readable.from([bytes]);
      response.statusCode = status;
      response.headers = { 'content-type': type, 'content-length': String(bytes.length) };
      response.once('close', () => request.emit('close'));
      callback(response);
    };
    return request;
  };
}
test('cloud189 accepts real PNG bytes under provider JPEG MIME but does not accept JPEG or nonimage responses', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/jpeg; charset=binary']) {
    assert.deepEqual(await fetchCloud189Qr(outer(nested), { request: imageRequest(png, type) }), png);
  }
  for (const [bytes, type, status] of [
    [Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'), 'image/jpeg', 200],
    [Buffer.from('<svg onload="alert(1)">'), 'image/jpeg', 200],
    [png, 'text/html', 200], [png, 'image/gif', 200], [png, 'image/svg+xml', 200],
    [png, 'image/png', 302], [png.subarray(0, png.length - 12), 'image/jpeg', 200],
    [Buffer.alloc(256 * 1024 + 1), 'image/jpeg', 200],
  ]) await assert.rejects(fetchCloud189Qr(outer(nested), { request: imageRequest(bytes, type, status) }));
  const oversizedDimensions = Buffer.from(png); oversizedDimensions.writeUInt32BE(2049, 16);
  await assert.rejects(fetchCloud189Qr(outer(nested), { request: imageRequest(oversizedDimensions, 'image/jpeg') }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDvrRecordings, sanitizeDvrRecordingDiagnostics } from '../lib/dvr-recording-diagnostics.js';

const startTime = '2026-10-01T21:40:26Z', endTime = '2026-10-01T21:40:36Z';
const startCompact = '20261001T214026Z', endCompact = '20261001T214036Z';
const query = `starttime=${startCompact}&endtime=${endCompact}`;
const playbackURI = `rtsp://recorder.example/Streaming/tracks/201/?${query}&name=private-file-name&size=500`;
const file = (changes = {}) => ({ startTime, endTime, playbackURI, size: 500, channel: '201', ...changes });
const summarize = (changes = {}) => summarizeDvrRecordings({ files: [file()], channel: '201', ip: 'recorder.example', startTime, endTime, ...changes });
const record = (changes = {}) => summarize(changes).recordings[0];
const withUri = uri => record({ files: [file({ playbackURI: uri })] });
const recordKeys = ['durationSeconds', 'uriDurationSeconds', 'sizeBytes', 'pathStyle', 'trailingSlash', 'channelMatches', 'sameHost', 'sameRtspPort', 'embeddedCredentials', 'hasName', 'hasSize', 'unknownQueryKeys', 'uriRange', 'uriMatchesSearchRange'].sort();

test('summary exposes closed facts while leaving raw device records untouched', () => {
  const files = Object.freeze([Object.freeze(file())]);
  const result = summarize({ files });
  assert.deepEqual(Object.keys(result).sort(), ['outcome', 'source', 'matchCount', 'truncated', 'recordings'].sort());
  assert.equal(result.outcome, 'available');
  assert.equal(result.source, 'search');
  assert.equal(result.matchCount, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.recordings[0]).sort(), recordKeys);
  assert.deepEqual(result.recordings[0], {
    durationSeconds: 10, sizeBytes: 500, uriDurationSeconds: 10, pathStyle: 'tracks', trailingSlash: true,
    channelMatches: true, sameHost: true, sameRtspPort: true, embeddedCredentials: false,
    hasName: true, hasSize: true, unknownQueryKeys: 0, uriRange: 'exact', uriMatchesSearchRange: true,
  });
  assert.equal(files[0].playbackURI, playbackURI);
  assert.deepEqual(sanitizeDvrRecordingDiagnostics(result), result);
});

test('endpoint comparison uses configured RTSP port independently of legacy HTTP port', () => {
  assert.equal(record({ ip: 'RECORDER.EXAMPLE:8080' }).sameHost, true);
  assert.equal(record({ ip: 'RECORDER.EXAMPLE:8080' }).sameRtspPort, true);
  assert.equal(record({ rtspPort: '8554' }).sameRtspPort, false);
  const changed = `rtsp://RECORDER.EXAMPLE:8554/Streaming/tracks/201?${query}`;
  assert.equal(record({ rtspPort: 8554, files: [file({ playbackURI: changed })] }).sameRtspPort, true);
  assert.equal(withUri(playbackURI.replace('recorder.example', 'other.example')).sameHost, false);
  assert.equal(withUri(playbackURI.replace('recorder.example', 'recorder.example:554')).sameRtspPort, true);
  const ipv6 = record({ ip: '[0:0:0:0:0:0:0:1]:8080', files: [file({ playbackURI: `rtsp://[::1]/Streaming/tracks/201?${query}` })] });
  assert.equal(ipv6.sameHost, true);
  for (const changes of [{ ip: 'host/path' }, { ip: {} }, { rtspPort: null }, { rtspPort: {} }, { rtspPort: 65536 }]) {
    assert.equal(record(changes).sameHost, null);
    assert.equal(record(changes).sameRtspPort, null);
  }
});

test('path styles and channel comparison use the original URI path, never file.channel', () => {
  const isapi = withUri(playbackURI.replace('/Streaming/', '/ISAPI/Streaming/'));
  assert.equal(isapi.pathStyle, 'isapi_tracks');
  assert.equal(isapi.channelMatches, true);
  assert.equal(withUri(playbackURI.replace('/201/', '/201')).trailingSlash, false);
  assert.equal(record({ files: [file({ channel: '999' })] }).channelMatches, true);
  assert.equal(record({ files: [file({ playbackURI: playbackURI.replace('/201/', '/999/'), channel: '201' })] }).channelMatches, false);
  assert.equal(record({ channel: 201 }).channelMatches, true);
  assert.equal(record({ channel: { toString() { throw Error('must not coerce'); } } }).channelMatches, null);
  for (const path of ['/Streaming/channels/201', '/Streaming/tracks/%32%30%31', '/Streaming/x/../tracks/201', '/Streaming/tracks/201/file-secret']) {
    const facts = withUri(`rtsp://recorder.example${path}?${query}`);
    assert.equal(facts.pathStyle, 'other');
    assert.equal(facts.channelMatches, null);
  }
});

test('query selectors are presence-only and unknown entries are counted including duplicates', () => {
  const facts = withUri(`rtsp://private-user:private-password@recorder.example/Streaming/tracks/201?${query}&name=&name=private-file&size=&size=1&secret=x&secret=y&other=z`);
  assert.equal(facts.embeddedCredentials, true);
  assert.equal(facts.hasName, true);
  assert.equal(facts.hasSize, true);
  assert.equal(facts.unknownQueryKeys, 3);
  assert.equal(facts.uriRange, 'exact');
  assert.equal(withUri(`rtsp://recorder.example/Streaming/tracks/201?${query}`).hasName, false);
  assert.equal(withUri(`rtsp://recorder.example/Streaming/tracks/201?${query}`).hasSize, false);
  assert.equal(withUri(`rtsp://recorder.example/Streaming/tracks/201?${query}&${'x=1&'.repeat(200)}`).unknownQueryKeys, 128);
  for (const duplicate of [`&starttime=${startCompact}`, `&endtime=${endCompact}`, '&starttime=private-selector']) {
    const ambiguous = withUri(`rtsp://recorder.example/Streaming/tracks/201?${query}${duplicate}`);
    assert.equal(ambiguous.uriRange, 'invalid');
    assert.equal(ambiguous.uriMatchesSearchRange, null);
    assert.equal(ambiguous.uriDurationSeconds, null);
  }
});

test('URI relationships distinguish requested clip coverage and search-file agreement', () => {
  for (const [start, end, relation, duration] of [
    [startCompact, endCompact, 'exact', 10],
    ['20261001T214000Z', '20261001T214100Z', 'covers', 60],
    ['20261001T214020Z', '20261001T214030Z', 'partial', 10],
    ['20261001T214028Z', '20261001T214030Z', 'partial', 2],
    ['20261001T214030Z', '20261001T214040Z', 'partial', 10],
    ['20261001T214000Z', startCompact, 'outside', 26],
    [endCompact, '20261001T214100Z', 'outside', 24],
    [startTime, endTime, 'exact', 10],
  ]) {
    const facts = withUri(`rtsp://recorder.example/Streaming/tracks/201?starttime=${start}&endtime=${end}`);
    assert.equal(facts.uriRange, relation);
    assert.equal(facts.uriDurationSeconds, duration);
    assert.equal(facts.uriMatchesSearchRange, relation === 'exact');
  }
  const larger = file({ startTime: '2026-10-01T21:40:00Z', endTime: '2026-10-01T21:41:00Z', playbackURI: `rtsp://recorder.example/Streaming/tracks/201?starttime=20261001T214000Z&endtime=20261001T214100Z` });
  const facts = record({ files: [larger] });
  assert.equal(facts.durationSeconds, 60);
  assert.equal(facts.uriRange, 'covers');
  assert.equal(facts.uriMatchesSearchRange, true);
});

test('invalid calendar dates, missing/ambiguous endpoints, offsets and zero/reverse intervals are rejected', () => {
  for (const invalid of ['20260230T214026Z', '20261001T244026Z', '20261001T214060Z', '2026-10-01T21:40:26+08:00', '2026-10-01T21:40:26.000Z', 'private-selector', endCompact, '20261001T214100Z']) {
    const facts = withUri(`rtsp://recorder.example/Streaming/tracks/201?starttime=${encodeURIComponent(invalid)}&endtime=${endCompact}`);
    assert.equal(facts.uriRange, 'invalid');
    assert.equal(facts.uriDurationSeconds, null);
    assert.equal(facts.uriMatchesSearchRange, null);
  }
  assert.equal(withUri('rtsp://recorder.example/Streaming/tracks/201').uriRange, 'invalid');
  for (const invalid of [null, {}, '2026-02-30T21:40:26Z', '2026-10-01T21:40:26+00:00', endTime]) assert.equal(summarize({ startTime: invalid }).outcome, 'invalid');
  const midnight = record({ startTime: '2024-02-29T23:59:55Z', endTime: '2024-03-01T00:00:05Z', files: [file({ startTime: '2024-02-29T23:59:55Z', endTime: '2024-03-01T00:00:05Z', playbackURI: 'rtsp://recorder.example/Streaming/tracks/201?starttime=20240229T235955Z&endtime=20240301T000005Z' })] });
  assert.equal(midnight.durationSeconds, 10);
  assert.equal(midnight.uriDurationSeconds, 10);
  assert.equal(midnight.uriRange, 'exact');
});

test('only overlapping valid search records count, with bounded output and explicit truncation', () => {
  assert.equal(summarize({ files: [] }).outcome, 'no_match');
  assert.equal(summarize({ files: [file({ endTime: startTime, startTime: '2026-10-01T21:40:00Z' })] }).outcome, 'no_match');
  assert.equal(summarize({ files: [file({ startTime: endTime, endTime: '2026-10-01T21:41:00Z' })] }).outcome, 'no_match');
  assert.equal(summarize({ files: [file({ startTime: 'invalid' })] }).outcome, 'invalid');
  const multiple = summarize({ files: Array.from({ length: 5 }, () => file()), source: 'cache' });
  assert.equal(multiple.source, 'cache');
  assert.equal(multiple.matchCount, 5);
  assert.equal(multiple.recordings.length, 3);
  assert.equal(multiple.truncated, true);
  assert.equal(summarize({ truncated: true }).truncated, true);
  assert.equal(summarize({ truncated: 'true' }).truncated, false);
  assert.equal(summarize({ files: [file(), ...Array.from({ length: 3 }, () => file({ startTime: '2026-10-01T21:39:00Z', endTime: '2026-10-01T21:40:00Z' }))] }).truncated, true);
  const bounded = summarize({ files: new Array(10_001).fill(file()) });
  assert.equal(bounded.matchCount, 10_000);
  assert.equal(bounded.recordings.length, 3);
  assert.equal(bounded.truncated, true);
});

test('hostile URIs and values never invoke coercion or expose endpoint details', () => {
  const hostile = { toString() { throw Error('must not coerce'); }, toJSON() { throw Error('must not serialize'); } };
  for (const uri of [hostile, null, '', 'https://recorder.example/Streaming/tracks/201', '//recorder.example/path', 'rtsp://recorder.example:0/path', 'rtsp://recorder.example:65536/path', 'rtsp://recorder.example:/path', 'rtsp://recorder.example/\npath', 'rtsp://recorder.example\\private/path', 'rtsp://user@user@recorder.example/path', 'rtsp://recorder.example/path#private', 'rtsp://recorder.example/%zz', `rtsp://recorder.example/${'x'.repeat(8192)}`]) {
    const facts = withUri(uri);
    assert.equal(facts.pathStyle, 'invalid');
    assert.equal(facts.sameHost, null);
    assert.equal(facts.embeddedCredentials, null);
  }
  for (const size of [hostile, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, '500']) assert.equal(record({ files: [file({ size })] }).sizeBytes, null);
  const secrets = ['private-user', 'private-password', 'private-file-name', 'private-selector', 'a=rtpmap', 'recorder.example', startCompact, endCompact];
  const result = summarize({ files: [file({ playbackURI: `${playbackURI.replace('rtsp://', 'rtsp://private-user:private-password@')}&private-selector=a%3Drtpmap`, user: 'private-user', pass: 'private-password', headers: 'private-selector', sdp: 'a=rtpmap' })] });
  const serialized = JSON.stringify(result);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `must exclude ${secret}`);
});

test('summary ignores inherited/accessor properties and survives throwing/revoked proxies', () => {
  let reads = 0;
  const getter = { get() { reads++; throw Error('must not invoke getter'); }, enumerable: true };
  const badFile = Object.defineProperty(file(), 'playbackURI', getter);
  assert.equal(record({ files: [badFile] }).pathStyle, 'invalid');
  const badFiles = [file()];
  Object.defineProperty(badFiles, '0', getter);
  assert.equal(summarize({ files: badFiles }).outcome, 'invalid');
  assert.equal(summarizeDvrRecordings(Object.create({ files: [file()], startTime, endTime })).outcome, 'invalid');
  assert.equal(summarize({ files: [Object.create(file())] }).outcome, 'invalid');
  assert.equal(summarizeDvrRecordings(Object.defineProperty({ startTime, endTime }, 'files', getter)).outcome, 'invalid');
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(summarizeDvrRecordings(revoked.proxy).outcome, 'invalid');
  assert.equal(summarize({ files: new Proxy([], { getOwnPropertyDescriptor() { throw Error('invalid proxy'); } }) }).outcome, 'invalid');
  assert.equal(reads, 0);
});

test('sanitizer accepts only closed outcomes and own data, strips serializers/prototype injection', () => {
  for (const outcome of ['available', 'no_match', 'timeout', 'cancelled', 'authentication', 'unsupported', 'invalid', 'failed']) {
    assert.equal(sanitizeDvrRecordingDiagnostics({ outcome }).outcome, outcome);
  }
  for (const invalid of [undefined, null, [], 'private', {}, { outcome: 'private' }, Object.create({ outcome: 'available' })]) assert.equal(sanitizeDvrRecordingDiagnostics(invalid), undefined);
  let reads = 0;
  const getter = { get() { reads++; throw Error('must not read'); }, enumerable: true };
  const source = Object.assign(Object.create({ source: 'cache', ip: 'private-ip' }), summarize());
  delete source.source;
  Object.defineProperty(source, 'toJSON', getter);
  Object.defineProperty(source, 'password', getter);
  Object.defineProperty(source.recordings[0], 'sameHost', getter);
  Object.defineProperty(source.recordings[0], 'toJSON', getter);
  Object.defineProperty(source, '__proto__', { value: { polluted: true }, enumerable: true });
  source.recordings[0].playbackURI = playbackURI;
  const sanitized = sanitizeDvrRecordingDiagnostics(source);
  assert.equal(sanitized.source, 'search');
  assert.equal(sanitized.recordings[0].sameHost, null);
  assert.equal(JSON.stringify(sanitized).includes('rtsp'), false);
  assert.equal(Object.hasOwn(sanitized, '__proto__'), false);
  assert.equal(Object.hasOwn(sanitized, 'toJSON'), false);
  assert.deepEqual(Object.keys(sanitized.recordings[0]).sort(), recordKeys);
  assert.equal(reads, 0);
});

test('sanitizer bounds numeric fields and arrays without invoking iterators or getters', () => {
  const badRecord = {
    durationSeconds: Infinity, uriDurationSeconds: -1, sizeBytes: Number.MAX_SAFE_INTEGER + 1,
    pathStyle: 'private-path', trailingSlash: 1, channelMatches: 'true', sameHost: {}, sameRtspPort: 0,
    embeddedCredentials: 'false', hasName: {}, hasSize: 'true', unknownQueryKeys: 900,
    uriRange: 'private-selector', uriMatchesSearchRange: 'true',
  };
  const input = { outcome: 'available', source: 'private-source', matchCount: 50_000, recordings: [badRecord, badRecord, badRecord, badRecord] };
  input.recordings[Symbol.iterator] = () => { throw Error('must not iterate untrusted array'); };
  const output = sanitizeDvrRecordingDiagnostics(input);
  assert.equal(output.matchCount, 10_000);
  assert.equal(output.recordings.length, 3);
  assert.equal(output.truncated, true);
  assert.equal(output.source, 'search');
  assert.equal(sanitizeDvrRecordingDiagnostics({ outcome: 'available', matchCount: 4, recordings: [record(), record(), record()] }).truncated, true);
  assert.deepEqual(output.recordings[0], {
    durationSeconds: null, uriDurationSeconds: null, sizeBytes: null, pathStyle: 'invalid', trailingSlash: null,
    channelMatches: null, sameHost: null, sameRtspPort: null, embeddedCredentials: null,
    hasName: false, hasSize: false, unknownQueryKeys: 128, uriRange: 'invalid', uriMatchesSearchRange: null,
  });
  for (const matchCount of [-1, 1.5, Infinity, '2', {}]) assert.equal(sanitizeDvrRecordingDiagnostics({ outcome: 'available', matchCount }).matchCount, 0);
  const inherited = Object.create(record());
  const clean = sanitizeDvrRecordingDiagnostics({ outcome: 'available', recordings: [inherited] }).recordings[0];
  assert.equal(clean.durationSeconds, null);
  assert.equal(clean.pathStyle, 'invalid');
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(sanitizeDvrRecordingDiagnostics(revoked.proxy), undefined);
});

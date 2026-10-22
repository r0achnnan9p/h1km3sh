import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createMediaChannelDiscovery, mediaChannelDiscovery } from '../lib/media-channel-discovery.js';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-discovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function list(names, { itemCount = names.length, pageCount = names.length ? 1 : 0 } = {}) {
  return Response.json({ itemCount, pageCount, items: names.map(name => ({ name })) });
}

test('local discovery is immediate, single-level, read-only, and excludes symlinks and invalid names', t => {
  const root = temporaryRoot(t);
  for (const name of ['D2', 'd1', 'front-door_3', '.hidden', 'bad name', 'x'.repeat(65)]) fs.mkdirSync(path.join(root, name));
  fs.mkdirSync(path.join(root, 'd1', 'nested'));
  fs.writeFileSync(path.join(root, 'not_a_directory'), 'file');
  fs.symlinkSync(path.join(root, 'd1'), path.join(root, 'linked'), 'dir');
  let calls = 0;
  const discovery = createMediaChannelDiscovery({ root, fetchImpl: () => { calls++; throw Error(); } });
  const before = fs.readdirSync(root);
  assert.deepEqual(discovery.paths(), ['D2', 'd1', 'front-door_3']);
  discovery.paths().push('injected');
  assert.deepEqual(discovery.paths(), ['D2', 'd1', 'front-door_3']);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(calls, 0);
  assert.equal(typeof mediaChannelDiscovery.refresh, 'function');
});

test('filesystem scan is bounded, nonthrowing, and follows current root configuration', t => {
  const parent = temporaryRoot(t), first = path.join(parent, 'first'), second = path.join(parent, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(first, `d${i}`));
  fs.mkdirSync(path.join(second, 'other'));
  const env = { HIKVISION_ARCHIVE_DIR: first };
  const discovery = createMediaChannelDiscovery({ env, apiUrl: null, maxEntries: 2 });
  assert.equal(discovery.paths().length, 2);
  assert.equal(discovery.diagnostics().archive, 'limit');
  env.HIKVISION_ARCHIVE_DIR = second;
  assert.deepEqual(discovery.paths(), ['other']);
  env.HIKVISION_ARCHIVE_DIR = path.join(parent, 'missing');
  assert.deepEqual(discovery.paths(), []);
  assert.equal(discovery.diagnostics().archive, 'unavailable');
  env.HIKVISION_ARCHIVE_DIR = '\0bad';
  assert.deepEqual(discovery.paths(), []);
  assert.equal(discovery.diagnostics().archive, 'invalid-config');
  delete env.HIKVISION_ARCHIVE_DIR;
  assert.equal(discovery.diagnostics().archive, 'disabled');
});

test('temporary archive unavailability preserves its catalog until a successful scan or source change', t => {
  const parent = temporaryRoot(t), root = path.join(parent, 'mounted'), offline = path.join(parent, 'offline');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'known'));
  const env = { HIKVISION_ARCHIVE_DIR: root };
  const discovery = createMediaChannelDiscovery({ env, apiUrl: null });
  assert.deepEqual(discovery.paths(), ['known']);
  fs.renameSync(root, offline);
  assert.deepEqual(discovery.paths(), ['known']);
  assert.equal(discovery.diagnostics().archive, 'unavailable');
  fs.mkdirSync(root);
  assert.deepEqual(discovery.paths(), []);
  assert.equal(discovery.diagnostics().archive, 'ok');
  fs.mkdirSync(path.join(root, 'new'));
  assert.deepEqual(discovery.paths(), ['new']);
  env.HIKVISION_ARCHIVE_DIR = path.join(parent, 'different-unavailable-source');
  assert.deepEqual(discovery.paths(), []);
});

test('v3 API lists merge paginated paths, recording-only paths and local folders safely', async t => {
  const root = temporaryRoot(t); fs.mkdirSync(path.join(root, 'local'));
  const seen = [];
  const discovery = createMediaChannelDiscovery({ root, apiUrl: 'http://mediamtx.example:9997', pageSize: 2, fetchImpl: async (value, options) => {
    const url = new URL(value); seen.push({ url, options });
    if (url.pathname === '/v3/recordings/list') return list(['recorded', 'shared']);
    if (url.searchParams.get('page') === '0') return list(['live', 'shared'], { pageCount: 2, itemCount: 4 });
    return list(['../secret', 'nested/path'], { pageCount: 2, itemCount: 4 });
  } });
  const result = await discovery.refresh();
  assert.deepEqual(result.paths, ['live', 'local', 'recorded', 'shared']);
  assert.deepEqual(result.diagnostics, { archive: 'ok', paths: 'ok', recordings: 'ok' });
  assert.equal(seen.length, 3);
  for (const { url, options } of seen) {
    assert.equal(url.origin, 'http://mediamtx.example:9997');
    assert.equal(url.searchParams.get('itemsPerPage'), '2');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
  }
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.paths)); assert.ok(Object.isFrozen(result.diagnostics));
});

test('API origin is explicit or loopback only, never inferred from a remote Playback URL', async () => {
  const seen = [], env = { HIKVISION_MEDIAMTX_PLAYBACK_URL: 'https://remote.example:9996' };
  const discovery = createMediaChannelDiscovery({ env, fetchImpl: async value => { seen.push(new URL(value).origin); return list([]); } });
  await discovery.refresh();
  assert.deepEqual(seen, ['http://127.0.0.1:9997', 'http://127.0.0.1:9997']);
  env.HIKVISION_MEDIAMTX_API_URL = 'https://api.example:11443';
  await discovery.refresh();
  assert.deepEqual(seen.slice(2), ['https://api.example:11443', 'https://api.example:11443']);
});

test('explicit empty API disables network discovery, clears old API paths, and keeps local folders', async t => {
  const root = temporaryRoot(t); fs.mkdirSync(path.join(root, 'fixture-local'));
  const env = { HIKVISION_ARCHIVE_DIR: root }; let calls = 0;
  const discovery = createMediaChannelDiscovery({ env, fetchImpl: async url => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:9997'); calls++;
    return list(['host-production-channel']);
  } });
  assert.deepEqual((await discovery.refresh()).paths, ['fixture-local', 'host-production-channel']);
  assert.equal(calls, 2);
  env.HIKVISION_MEDIAMTX_API_URL = '';
  assert.deepEqual((await discovery.refresh()).paths, ['fixture-local']);
  assert.equal(discovery.diagnostics().paths, 'disabled'); assert.equal(discovery.diagnostics().recordings, 'disabled');
  assert.equal(calls, 2, 'empty must never fall back to the host MediaMTX API');
  await discovery.refresh(); assert.equal(calls, 2);
  const explicit = createMediaChannelDiscovery({ root, apiUrl: '', fetchImpl: () => assert.fail('factory opt-out must not fetch') });
  assert.deepEqual((await explicit.refresh()).paths, ['fixture-local']);
});

test('invalid explicit control URLs never trigger fallback or expose credentials', async () => {
  for (const apiUrl of ['http://user:password@remote.example:9997', 'https://remote.example?token=secret',
    'https://remote.example/#secret', 'https://remote.example/path', 'file:///secret', 'not a url']) {
    let calls = 0;
    const discovery = createMediaChannelDiscovery({ root: null, env: { HIKVISION_MEDIAMTX_API_URL: apiUrl },
      fetchImpl: async () => { calls++; throw Error('credentials must not escape'); } });
    const result = await discovery.refresh();
    assert.equal(calls, 0); assert.deepEqual(result.paths, []);
    assert.equal(result.diagnostics.paths, 'invalid-config');
    assert.equal(JSON.stringify(result).includes(apiUrl), false);
  }
});

test('temporary endpoint failures keep independent last-known-good catalogs; success can remove paths', async () => {
  let mode = 'initial';
  const discovery = createMediaChannelDiscovery({ env: {}, fetchImpl: async value => {
    const endpoint = new URL(value).pathname;
    if (mode === 'offline') throw Error('upstream password=secret');
    if (mode === 'partial' && endpoint.includes('/paths/')) return new Response('secret error', { status: 503 });
    if (mode === 'initial') return list([endpoint.includes('/paths/') ? 'live' : 'old_recording']);
    return list(mode === 'partial' ? ['new_recording'] : []);
  } });
  assert.deepEqual((await discovery.refresh()).paths, ['live', 'old_recording']);
  mode = 'offline';
  const failed = await discovery.refresh();
  assert.deepEqual(failed.paths, ['live', 'old_recording']);
  assert.equal(failed.diagnostics.paths, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  mode = 'partial';
  assert.deepEqual((await discovery.refresh()).paths, ['live', 'new_recording']);
  mode = 'empty';
  assert.deepEqual((await discovery.refresh()).paths, []);
});

test('changing API or archive root immediately clears old API entries even during failure', async t => {
  const root = temporaryRoot(t), env = { HIKVISION_MEDIAMTX_API_URL: 'http://first.example' };
  let online = true;
  const discovery = createMediaChannelDiscovery({ env, fetchImpl: async () => {
    if (!online) throw Error('offline');
    return list(['old_source']);
  } });
  await discovery.refresh();
  online = false; env.HIKVISION_MEDIAMTX_API_URL = 'http://second.example';
  assert.deepEqual(discovery.paths(), []);
  assert.deepEqual((await discovery.refresh()).paths, []);
  online = true; await discovery.refresh();
  assert.deepEqual(discovery.paths(), ['old_source']);
  online = false; env.HIKVISION_ARCHIVE_DIR = root;
  assert.deepEqual(discovery.paths(), []);
  assert.deepEqual((await discovery.refresh()).paths, []);
});

test('concurrent refreshes coalesce and late results from an old source never repopulate the catalog', async () => {
  const env = { HIKVISION_MEDIAMTX_API_URL: 'http://first.example' }, pending = [];
  let calls = 0;
  const discovery = createMediaChannelDiscovery({ env, fetchImpl: value => {
    calls++;
    if (new URL(value).hostname === 'first.example') return new Promise(resolve => pending.push(resolve));
    return Promise.resolve(list(['new_source']));
  } });
  const first = discovery.refresh();
  assert.equal(first, discovery.refresh()); assert.equal(calls, 2);
  env.HIKVISION_MEDIAMTX_API_URL = 'http://second.example';
  const second = discovery.refresh();
  assert.notEqual(first, second);
  await second;
  for (const resolve of pending) resolve(list(['old_source']));
  await first;
  assert.deepEqual(discovery.paths(), ['new_source']);
  assert.equal(calls, 4);
});

test('a source change during a refresh is detected even without a paths() call', async () => {
  const env = { HIKVISION_MEDIAMTX_API_URL: 'http://old.example' }, pending = [];
  const discovery = createMediaChannelDiscovery({ env, fetchImpl: () => new Promise(resolve => pending.push(resolve)) });
  const refresh = discovery.refresh();
  env.HIKVISION_MEDIAMTX_API_URL = 'http://new.example';
  for (const resolve of pending) resolve(list(['old']));
  assert.deepEqual((await refresh).paths, []);
  assert.deepEqual(discovery.paths(), []);
});

test('malformed and oversized responses preserve the complete cached catalog', async () => {
  for (const badResponse of [
    () => new Response('{bad json'),
    () => Response.json({ pageCount: 1, itemCount: 1, items: [null] }),
    () => Response.json({ pageCount: -1, itemCount: 0, items: [] }),
    () => Response.json({ pageCount: 1, itemCount: 1, items: 'bad' }),
    () => Response.json({ pageCount: 0, itemCount: 1, items: [] }),
    () => Response.json({ pageCount: 1, itemCount: 2, items: [{ name: 'partial' }] }),
    () => new Response(' '.repeat(512)),
  ]) {
    let good = true;
    const discovery = createMediaChannelDiscovery({ env: {}, maxBodyBytes: 128, fetchImpl: async () => good ? list(['known']) : badResponse() });
    await discovery.refresh(); good = false;
    const result = await discovery.refresh();
    assert.deepEqual(result.paths, ['known']);
    assert.ok(['invalid-response', 'limit'].includes(result.diagnostics.paths));
  }
});

test('pagination, entry count and aggregate body limits reject partial new catalogs', async () => {
  let mode = 'good', calls = 0;
  const discovery = createMediaChannelDiscovery({ env: {}, maxPages: 2, pageSize: 1, maxEntries: 2, maxBodyBytes: 128, fetchImpl: async value => {
    calls++;
    if (mode === 'good') return list(['known']);
    if (mode === 'pages') return list(['new'], { pageCount: 3, itemCount: 3 });
    if (mode === 'entries') return list(['new'], { pageCount: 1, itemCount: 3 });
    if (mode === 'late-failure' && new URL(value).searchParams.get('page') === '1') throw Error('failed second page');
    return list(['x'.repeat(40)], { pageCount: 2, itemCount: 2 });
  } });
  await discovery.refresh();
  for (mode of ['pages', 'entries', 'late-failure', 'aggregate-body']) {
    calls = 0;
    const result = await discovery.refresh();
    assert.deepEqual(result.paths, ['known']);
    assert.ok(calls <= 4);
    assert.notEqual(result.diagnostics.paths, 'ok');
  }
});

test('one deadline covers stalled headers and body reads', async t => {
  const sockets = new Set();
  let mode = 'good';
  const server = http.createServer((_req, res) => {
    if (mode === 'headers') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'body') return res.write('{');
    res.end(JSON.stringify({ pageCount: 1, itemCount: 1, items: [{ name: 'known' }] }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  // Seed last-known-good data deterministically. A cold localhost connection
  // under the full parallel suite must not consume the short deadline intended
  // for the stalled-header/body checks below. Those still use actual HTTP.
  const discovery = createMediaChannelDiscovery({ root: null, apiUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100,
    fetchImpl: (...args) => mode === 'good' ? Promise.resolve(list(['known'])) : fetch(...args) });
  assert.deepEqual((await discovery.refresh()).paths, ['known']);
  for (mode of ['headers', 'body']) {
    const start = Date.now(), result = await discovery.refresh();
    assert.ok(Date.now() - start < 2000);
    assert.deepEqual(result.paths, ['known']);
    assert.equal(result.diagnostics.paths, 'timeout');
    assert.equal(result.diagnostics.recordings, 'timeout');
  }
});

test('real HTTP redirects are refused and never reach the redirected target', async t => {
  let targetRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/credentials') { targetRequests++; res.end('{}'); return; }
    res.writeHead(302, { location: '/credentials' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const discovery = createMediaChannelDiscovery({ root: null, apiUrl: `http://127.0.0.1:${server.address().port}` });
  const result = await discovery.refresh();
  assert.deepEqual(result.paths, []);
  assert.equal(result.diagnostics.paths, 'unavailable');
  assert.equal(targetRequests, 0);
});

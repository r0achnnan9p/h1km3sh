import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegPath } from '../lib/ffmpeg-paths.js';
import { versionFixtureAssets, fixtureConsoleSource } from '../scripts/build-console-fixture.js';

const runtime = await readFile(new URL('../scripts/console-fixture-browser.js', import.meta.url), 'utf8');
function harness(t, mode = 'normal', query = '') {
  const calls = [], timers = new Set();
  class Media { get src() { return this._src; } set src(value) { this._src = value; } setAttribute(name, value) { this[name] = value; } }
  class Anchor { get href() { return this._href; } set href(value) { this._href = value; } }
  class Image { get src() { return this._src; } set src(value) { this._src = value; } }
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; }
    get value() { return this._value ?? (this.tag === 'select' ? this.children[0]?.value : '') ?? ''; }
    set value(value) { this._value = value; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {} addEventListener(type, listener) { this.listeners[type] = listener; }
    after(node) { this.afterNode = node; }
  }
  const banner = new Element('aside'), domListeners = {};
  const document = { currentScript: { src: 'https://fixture.invalid/review/fixture-runtime.js' }, addEventListener(type, listener) { domListeners[type] = listener; }, createElement(tag) { return new Element(tag); }, getElementById(name) { return name === 'fixture-banner' ? banner : null; } };
  const context = vm.createContext({ URL, URLSearchParams, Headers, Response, Request, Blob, atob, EventTarget, MessageEvent, Event, Date, Intl, HTMLMediaElement: Media, HTMLImageElement: Image, HTMLAnchorElement: Anchor, crypto: { randomUUID }, document, location: { search: `?fixture=${mode}${query}`, href: `https://fixture.invalid/review/?fixture=${mode}${query}` }, fetch: async (url) => { calls.push(String(url)); return new Response('synthetic'); },
    setTimeout(fn, delay) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.min(delay, 30)); timers.add(timer); return timer; },
  });
  context.window = context;
  vm.runInContext(runtime, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const request = (url, method = 'GET', body, headers = {}) => context.fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = async (...args) => (await request(...args)).json();
  return { context, calls, request, json, Media, Image, Anchor, banner, domListeners };
}

test('static fixture bootstrap, SSE and native video all stay synthetic under a path prefix', async t => {
  const h = harness(t), data = await h.json('/review/console/api/bootstrap');
  assert.equal(data.outputs.length, 3); assert.equal(data.cameras.length, 3);
  for (const output of data.outputs) {
    assert.match(output.thumbnailUrl, /\/thumbnail$/);
    const image = new h.Image(); image.src = `/review${output.thumbnailUrl}`;
    assert.equal(image.src, 'https://fixture.invalid/review/demo-poster.jpg');
  }
  const source = new h.context.EventSource('/review/console/api/events');
  const update = await new Promise(resolve => source.addEventListener('update', event => resolve(JSON.parse(event.data))));
  source.close(); assert.equal(update.tasks.length, 4);
  const video = new h.Media(); video.src = '/review/console/api/playback/pitch-main/stream?format=mp4';
  assert.equal(video.src, 'https://fixture.invalid/review/demo.mp4');
  video.setAttribute('src', data.outputs[0].streamUrl); assert.equal(video.src, 'https://fixture.invalid/review/demo.mp4');
  assert.equal((await h.request('/review/console/api/unknown')).status, 404); assert.deepEqual(h.calls, []);
});

test('static fixture scenarios cover error, empty, auth, media and unavailable account states', async t => {
  assert.equal((await harness(t, 'empty').json('/console/api/bootstrap')).outputs.length, 0);
  assert.equal((await harness(t, 'error').request('/console/api/bootstrap')).status, 503);
  assert.equal((await harness(t, 'auth').request('/console/api/bootstrap')).status, 401);
  assert.equal((await harness(t, 'setup').json('/console/api/auth')).configured, false);
  assert.equal((await harness(t, 'recordings-error').request('/console/api/playback/a/segments')).status, 503);
  const media = harness(t, 'media-error'), video = new media.Media(); video.src = '/console/api/outputs/demo-output-1/stream'; assert.match(video.src, /missing-fixture-video/);
  const h = harness(t), accounts = await h.json('/console/api/upload-accounts');
  assert.equal(accounts.accounts.length, 2);
  assert.ok(accounts.accounts.every(account => account.state === 'unavailable' && !account.available && !account.attempt));
  const start = await h.json('/console/api/upload-accounts/bilibili/start', 'POST', {});
  assert.equal(start.account.state, 'unavailable'); assert.deepEqual(h.calls, []);
});

test('static fixture export gaps, completion, uploads, rename and deletion mutate tab memory only', async t => {
  const h = harness(t), payload = { source: 'mediamtx', camera: 'pitch-main', start: '2026-10-01 09:19:00', end: '2026-10-01 09:25:00' };
  const gap = await h.json('/console/api/export', 'POST', payload); assert.equal(gap.code, 'MEDIAMTX_GAPS'); assert.equal(gap.coverage.missingSeconds, 240);
  const job = await h.json('/console/api/export', 'POST', { ...payload, acceptGaps: true });
  await new Promise(resolve => setTimeout(resolve, 65));
  const completed = await h.json('/console/api/bootstrap'); assert.equal(completed.tasks.find(task => task.taskId === job.taskId).status, 'completed'); assert.equal(completed.outputs.length, 4);
  assert.ok(completed.outputs.every(output => output.thumbnailUrl?.endsWith('/thumbnail')));
  const output = completed.outputs[0], endpoint = `/console/api/outputs/${output.id}`;
  assert.equal((await h.request(endpoint, 'PUT', { newName: 'renamed.mp4' })).status, 200);
  const uploaded = await h.json(`${endpoint}/upload/cloud189`, 'POST', {}); assert.equal((await h.request(endpoint, 'DELETE')).status, 409);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal((await h.json('/console/api/bootstrap')).uploads.find(item => item.id === uploaded.job.id).status, 'completed');
  assert.equal((await h.request(endpoint, 'DELETE')).status, 200); assert.equal((await h.json('/console/api/outputs')).outputs.length, 3);
  assert.deepEqual(h.calls, []);
});

test('static fixture config and settings preserve the production JSON contract without network calls', async t => {
  const h = harness(t, 'config-conflict'); let config = await h.json('/console/api/config');
  const headers = { 'X-CSRF-Token': config.csrfToken };
  assert.equal((await h.request('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl: 'http://fixture.invalid:9996' }, headers)).status, 409);
  config = await h.json('/console/api/config');
  config = await h.json('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl: 'http://fixture.invalid:9996' }, headers);
  assert.equal(config.mediamtx.playbackUrl, 'http://fixture.invalid:9996');
  const settings = await h.json('/console/api/settings', 'PUT', { cloud189TargetPath: '/H1kM3sh' }, headers); assert.equal(settings.settings.cloud189TargetPath, '/H1kM3sh');
  assert.deepEqual(h.calls, []);
});

test('opt-in QR demo requires explicit manual states and never signs in or invents verification', async t => {
  const h = harness(t, 'normal', '&accounts=demo'); h.domListeners.DOMContentLoaded();
  const controls = h.banner.afterNode, status = controls.children[2], apply = controls.children[3];
  assert.match(controls.children[0].textContent, /演示二维码，不可登录/);
  let account = (await h.json('/console/api/upload-accounts')).accounts[0];
  assert.equal(account.state, 'disconnected'); assert.equal(account.available, true);
  const endpoint = '/console/api/upload-accounts/bilibili';
  account = (await h.json(`${endpoint}/start`, 'POST', {})).account;
  assert.equal(account.state, 'waiting_scan'); assert.equal(account.attempt.qrReady, true);
  assert.equal((await h.json(`${endpoint}/verify`, 'POST', {})).account.state, 'waiting_scan');
  const image = new h.Image(); image.src = `${endpoint}/qr?attemptId=${account.attempt.id}`;
  assert.match(decodeURIComponent(image.src), /演示二维码，不可登录/);
  const qr = await h.request(`${endpoint}/qr?attemptId=${account.attempt.id}`); assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  status.value = 'waiting_confirmation'; apply.listeners.click();
  assert.equal((await h.json(`${endpoint}/status?attemptId=${account.attempt.id}`)).account.state, 'waiting_confirmation');
  status.value = 'connected'; apply.listeners.click();
  account = (await h.json(`${endpoint}/status?attemptId=${account.attempt.id}`)).account;
  assert.equal(account.state, 'connected'); assert.equal(account.credentialsPresent, true);
  account = (await h.json(`${endpoint}/verify`, 'POST', {})).account;
  assert.equal(account.state, 'verifying'); assert.equal(account.attempt.operation, 'verify');
  status.value = 'connected'; apply.listeners.click();
  assert.equal((await h.request(`${endpoint}/start`, 'POST', {})).status, 409);
  account = (await h.json(`${endpoint}/start`, 'POST', { replace: true })).account;
  assert.equal(account.state, 'waiting_scan');
  account = (await h.json(`${endpoint}/cancel`, 'POST', { attemptId: account.attempt.id })).account;
  assert.equal(account.state, 'cancelled');
  account = (await h.json(`${endpoint}/disconnect`, 'POST', {})).account;
  assert.equal(account.state, 'verifying'); assert.equal(account.attempt.operation, 'disconnect');
  await new Promise(resolve => setTimeout(resolve, 65));
  account = (await h.json(`${endpoint}/status?attemptId=${account.attempt.id}`)).account;
  assert.equal(account.state, 'disconnected'); assert.equal(account.credentialsPresent, false);
  assert.deepEqual(h.calls, []);
});

test('static builder preserves real HTML/assets and injects its isolated runtime before console.js', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'static-console-fixture-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const media = path.join(directory, 'synthetic.mp4');
  await promisify(execFile)(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-t', '1', '-threads', '1', '-c:v', 'mpeg4', media]);
  const target = path.join(directory, 'dist');
  await promisify(execFile)(process.execPath, [new URL('../scripts/build-console-fixture.js', import.meta.url).pathname, target], { env: { ...process.env, CONSOLE_FIXTURE_MEDIA: media } });
  const html = await readFile(path.join(target, 'index.html'), 'utf8');
  assert.match(html, /id="console-shell"/); assert.match(html, /id="fixture-banner"/);
  assert.ok(html.indexOf('fixture-runtime.js') < html.indexOf('src="./console.js?'));
  const references = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:css|js)(?:\?[^"#]*)?(?:#[^"]*)?)"/g)].map(match => match[1]);
  assert.equal(references.length, 4);
  assert.ok(references.every(reference => /\?v=[a-f0-9]{20}$/.test(reference)));
  assert.deepEqual(await readFile(path.join(target, 'demo.mp4')), await readFile(media));
  const poster = await readFile(path.join(target, 'demo-poster.jpg'));
  assert.equal(poster.subarray(0, 2).toString('hex'), 'ffd8'); assert.ok(poster.length > 1000 && poster.length < 512 * 1024);
  assert.match(await readFile(path.join(target, 'fixture-runtime.js'), 'utf8'), /demo-poster\.jpg\?v=[a-f0-9]{20}/);
  const consoleSource = await readFile(path.join(target, 'console.js'), 'utf8');
  assert.equal(consoleSource.replace(/\?v=[a-f0-9]{20}/g, ''), fixtureConsoleSource(await readFile(new URL('../public/console.js', import.meta.url), 'utf8')));
  const imports = [...consoleSource.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(imports.length >= 5);
  assert.ok(imports.every(reference => /\?v=[a-f0-9]{20}$/.test(reference)));
  assert.equal(await readFile(path.join(target, 'console.css'), 'utf8'), await readFile(new URL('../public/console.css', import.meta.url), 'utf8'));

  async function snapshot(relative = '') {
    const files = {};
    for (const entry of await readdir(path.join(target, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(files, await snapshot(name));
      else {
        const content = await readFile(path.join(target, name));
        if (name === 'fixture-info.json') { const info = JSON.parse(content); delete info.generatedAt; files[name] = info; }
        else files[name] = content;
      }
    }
    return files;
  }
  const before = await snapshot();
  await promisify(execFile)(process.execPath, [new URL('../scripts/build-console-fixture.js', import.meta.url).pathname, target], { env: { ...process.env, CONSOLE_FIXTURE_MEDIA: media } });
  assert.deepEqual(await snapshot(), before, 'identical builds are byte-stable except generatedAt metadata');
});

test('static versioning rewrites static, side-effect, re-export and literal dynamic imports transitively', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fixture-versions-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'nested'));
  const source = [
    "import { value } from './nested/dependency.js?mode=demo#named';",
    "import './side-effect.js';",
    "export { value as forwarded } from './nested/dependency.js';",
    "export * from './side-effect.js';",
    "const lazy = () => import( /* literal dynamic URL */ './nested/dependency.js');",
    'const templated = () => import(`./side-effect.js`);',
    "// import './not-a-dependency.js';",
    'const text = "import(\'./not-a-dependency.js\')";',
    "const regex = /import\\(['\"]fake/;",
    "import 'external-package';",
    "import 'https://cdn.invalid/external.js';",
  ].join('\n');
  const html = '<link href="./style.css?theme=light#top"><script type="module" src="./main.js"></script><script src="https://cdn.invalid/external.js"></script>';
  async function build(dependency) {
    await writeFile(path.join(directory, 'main.js'), source);
    await writeFile(path.join(directory, 'side-effect.js'), "import './main.js';"); // Cycles use the same content-derived bundle version.
    await writeFile(path.join(directory, 'nested/dependency.js'), `export const value = ${dependency};`);
    await writeFile(path.join(directory, 'style.css'), 'body { color: black; }');
    const result = await versionFixtureAssets(directory, html);
    return { html: result, main: await readFile(path.join(directory, 'main.js'), 'utf8'), sideEffect: await readFile(path.join(directory, 'side-effect.js'), 'utf8') };
  }
  const first = await build(1), version = /[?&]v=([a-f0-9]{20})/.exec(first.html)[1];
  assert.match(first.html, new RegExp(`style\\.css\\?theme=light&v=${version}#top`));
  assert.match(first.main, new RegExp(`dependency\\.js\\?mode=demo&v=${version}#named`));
  assert.equal((first.main.match(new RegExp(`v=${version}`, 'g')) || []).length, 6);
  assert.match(first.sideEffect, new RegExp(`main\\.js\\?v=${version}`));
  assert.match(first.main, /\/\/ import '\.\/not-a-dependency\.js';/);
  assert.ok(first.main.includes('const text = "import(\'./not-a-dependency.js\')";'));
  assert.ok(first.main.includes("import 'external-package';"));
  assert.ok(first.main.includes("import 'https://cdn.invalid/external.js';"));
  assert.ok(first.html.includes('src="https://cdn.invalid/external.js"'));
  assert.deepEqual(await build(1), first);
  const changed = await build(2), nextVersion = /[?&]v=([a-f0-9]{20})/.exec(changed.html)[1];
  assert.notEqual(nextVersion, version, 'a dependency-only edit invalidates the importer URL');
  assert.match(changed.html, new RegExp(`main\\.js\\?v=${nextVersion}`));
  assert.match(changed.sideEffect, new RegExp(`main\\.js\\?v=${nextVersion}`));
});

test('static versioning fails closed for missing modules and computed dynamic imports', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fixture-import-errors-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'main.js'), "import './missing.js';");
  await assert.rejects(versionFixtureAssets(directory, '<script src="./main.js"></script>'), /Missing local fixture asset/);
  await writeFile(path.join(directory, 'main.js'), 'const lazy = name => import(name);');
  await assert.rejects(versionFixtureAssets(directory, '<script src="./main.js"></script>'), /computed dynamic imports/);
});

test('static versioning covers CSS imports and CSS URLs, preserving font URLs and comments', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fixture-css-versions-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'main.css'), '@import "./nested.css" screen;\n@import url(./nested.css?theme=light);\n@font-face { src: url("./fonts/demo.woff2"); }\n/* @import "./missing.css"; */');
  await writeFile(path.join(directory, 'nested.css'), 'body { color: black; }');
  const html = await versionFixtureAssets(directory, '<link href="./main.css">');
  const version = /[?&]v=([a-f0-9]{20})/.exec(html)[1];
  const css = await readFile(path.join(directory, 'main.css'), 'utf8');
  assert.ok(css.includes(`@import "./nested.css?v=${version}" screen`));
  assert.ok(css.includes(`@import url(./nested.css?theme=light&v=${version})`));
  assert.ok(css.includes('url("./fonts/demo.woff2")'));
  assert.ok(css.includes('/* @import "./missing.css"; */'));
  await writeFile(path.join(directory, 'main.css'), '@import "./missing.css";');
  await assert.rejects(versionFixtureAssets(directory, '<link href="./main.css">'), /Missing local fixture asset/);
});

test('static managed settings gate upload and raw cover stays a local Blob', async t => {
  const h = harness(t, 'normal', '&cover=missing'), endpoint = '/console/api/settings/bilibili-cover';
  const initial = await h.json('/console/api/settings'), headers = { 'X-CSRF-Token': initial.csrfToken };
  assert.equal(initial.settings.managedEnabled, true); assert.equal(initial.settings.bilibiliEnabled, true); assert.equal(initial.settings.bilibiliSeasonId, 101);
  assert.deepEqual(initial.cover, { present: false, source: 'missing' });
  assert.equal((await h.request(endpoint)).status, 404);
  assert.equal((await h.request('/console/api/outputs/demo-output-1/upload/bilibili', 'POST', {})).status, 409);
  assert.equal((await h.request('/console/api/settings', 'PUT', { bilibiliSeasonId: -1 }, headers)).status, 400);
  await h.json('/console/api/settings', 'PUT', { managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliSeasonId: 101, bilibiliSectionId: 201 }, headers);
  assert.equal(initial.settings.cloud189Enabled, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const raw = (body, type = 'image/png', includeCsrf = true) => h.context.fetch(endpoint, { method: 'PUT', headers: { ...(includeCsrf ? headers : {}), 'Content-Type': type }, body });
  assert.equal((await raw(png, 'image/png', false)).status, 403);
  assert.equal((await raw(png, 'text/plain')).status, 400);
  assert.equal((await raw(new Uint8Array(5 * 1024 * 1024 + 1))).status, 413);
  const saved = await (await raw(png)).json(); assert.deepEqual(saved.cover, { present: true, source: 'managed' }); assert.equal(saved.integrations.bilibiliEnabled, true);
  const image = new h.Image(); image.src = `${endpoint}?v=2`; assert.match(image.src, /^blob:/);
  const downloaded = await h.request(endpoint); assert.equal(downloaded.headers.get('content-type'), 'image/png'); assert.equal((await downloaded.arrayBuffer()).byteLength, png.length);
  assert.equal((await h.request('/console/api/outputs/demo-output-1/upload/bilibili', 'POST', {})).status, 202);
  assert.deepEqual(h.calls, []);
});

test('static cloud verification scenarios reconcile one UUID job without enqueueing uploads or using the network', async t => {
  for (const [mode, status, verified, code, http] of [
    ['cloud-verify-success', 'completed', true, 'CLOUD_REMOTE_VERIFIED', 200],
    ['cloud-verify-unknown', 'unknown', false, 'CLOUD_FILE_NOT_FOUND', 200],
    ['cloud-verify-pending', 'completed', true, 'CLOUD_REMOTE_VERIFIED', 200],
    ['cloud-verify-error', 'unknown', undefined, 'VERIFY_UNAVAILABLE', 503],
  ]) {
    const h = harness(t, mode), before = await h.json('/console/api/bootstrap');
    const job = before.uploads.find(item => item.status === 'unknown');
    assert.match(job.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(job.uploadPhase, 'remote_started');
    const settings = await h.json('/console/api/settings');
    const headers = { 'X-CSRF-Token': settings.csrfToken }, endpoint = `/review/console/api/uploads/cloud189/${job.id}/verify`;
    const pending = h.request(endpoint, 'POST', {}, headers);
    assert.equal((await h.json('/console/api/bootstrap')).uploads.find(item => item.id === job.id).status, 'unknown');
    assert.equal(h.context.__consoleFixture.inspectVerification().pendingIds.length, 1);
    const duplicate = await h.json(endpoint, 'POST', {}, headers);
    assert.equal(duplicate.code, 'VERIFY_BUSY');
    const response = await pending, result = await response.json();
    assert.equal(response.status, http); assert.equal(result.verified, verified); assert.equal(result.code, code);
    assert.match(result.message || result.error, /没有重新上传/);
    const after = await h.json('/console/api/bootstrap');
    assert.equal(after.uploads.find(item => item.id === job.id).status, status);
    assert.deepEqual(after.uploads.map(item => item.id), before.uploads.map(item => item.id));
    assert.deepEqual(after.uploads.filter(item => item.id !== job.id), before.uploads.filter(item => item.id !== job.id));
    assert.deepEqual(after.outputs, before.outputs); assert.deepEqual(after.tasks, before.tasks);
    assert.equal(h.context.__consoleFixture.inspectVerification().requests.length, 1);
    assert.equal(h.context.__consoleFixture.inspectVerification().pendingIds.length, 0);
    if (verified) assert.equal((await h.request(endpoint, 'POST', {}, headers)).status, 409);
    else assert.equal((await h.request(endpoint, 'POST', {}, headers)).status, http);
    assert.deepEqual(h.calls, []);
  }
});

test('static cloud verification rejects invalid, unauthorized and interrupted requests', async t => {
  const h = harness(t), state = await h.json('/console/api/bootstrap'), job = state.uploads.find(item => item.status === 'unknown');
  const endpoint = `/console/api/uploads/cloud189/${job.id}/verify`, headers = { 'X-CSRF-Token': (await h.json('/console/api/settings')).csrfToken };
  assert.equal((await h.request(endpoint, 'POST', {})).status, 403);
  assert.equal((await h.request(endpoint, 'POST', { filename: 'not-allowed.mp4' }, headers)).status, 400);
  assert.equal((await h.request(endpoint, 'POST', [], headers)).status, 400);
  assert.equal((await h.request(endpoint.replace(job.id, 'not-a-uuid'), 'POST', {}, headers)).status, 400);
  assert.equal((await h.request(endpoint.replace(job.id, state.uploads.find(item => item.provider === 'bilibili').id), 'POST', {}, headers)).status, 409);
  assert.equal(h.context.__consoleFixture.inspectVerification().requests.length, 0);
  const pending = h.request(endpoint, 'POST', {}, headers);
  await h.request('/status/logout', 'POST', {});
  assert.equal((await pending).status, 401);
  assert.equal(h.context.__consoleFixture.inspect().uploads.find(item => item.id === job.id).status, 'unknown');
  assert.deepEqual(h.calls, []);
  const preparation = harness(t, 'preparation');
  assert.equal((await preparation.request(endpoint, 'POST', {}, headers)).status, 409);
});

test('synthetic tasks carry creation times that exercise status-independent chronological order', async t => {
  const h = harness(t), data = await h.json('/console/api/bootstrap');
  const tasks = [...data.tasks].sort((a, b) => b.queuedAt - a.queuedAt);
  assert.deepEqual(tasks.map(task => task.status), ['queued', 'completed', 'error', 'downloading']);
  const uploads = [...data.uploads].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  assert.deepEqual(uploads.map(task => task.status), ['completed', 'unknown', 'uploading']);
  assert.deepEqual(h.calls, []);
});
test('synthetic account read failures and old sessions are explicit and cannot start a login', async t => {
  for (const [mode, status] of [['reauth', 200], ['unauthorized', 401], ['read-error', 503]]) {
    const h = harness(t, 'normal', `&accounts=${mode}`), result = await h.request('/console/api/upload-accounts');
    assert.equal(result.status, status);
    if (mode === 'reauth') {
      const data = await result.json(); assert.equal(data.reauthRequired, true); assert.ok(data.accounts.every(account => account.credentialsPresent));
      const denied = await h.request('/console/api/upload-accounts/bilibili/start', 'POST', { replace: true }, { 'X-CSRF-Token': data.csrfToken });
      assert.equal(denied.status, 403); assert.equal((await denied.json()).errorCode, 'SESSION_REAUTH_REQUIRED');
    }
    assert.deepEqual(h.calls, []);
  }
});

test('synthetic cloud recovery archives, renames, restores and queues one explicit new attempt', async t => {
  const h = harness(t, 'cloud-recovery'), headers = { 'x-csrf-token': 'synthetic-browser-fixture' };
  const before = await h.json('/review/console/api/bootstrap'), original = before.uploads[0], file = before.outputs[0];
  const path = `/review/console/api/uploads/cloud189/${original.id}`;
  assert.equal(file.busyReason, 'verification');
  assert.equal((await h.request(path + '/retry', 'POST', {}, headers)).status, 400);
  assert.equal((await h.request(path + '/archive', 'POST', {})).status, 403);
  assert.equal((await h.json(path + '/archive', 'POST', {}, headers)).applied, true);
  assert.equal((await h.json('/review/console/api/bootstrap')).outputs[0].busy, false);
  assert.equal((await h.request(`/review/console/api/outputs/${file.id}`, 'PUT', { newName: 'renamed.mp4' })).status, 200);
  assert.equal((await h.request(`/review/console/api/outputs/${file.id}/upload/cloud189`, 'POST', {})).status, 409);
  assert.equal((await h.json(path + '/restore', 'POST', {}, headers)).applied, true);
  const restored = await h.json('/review/console/api/bootstrap');
  assert.equal(restored.uploads[0].filename, 'renamed.mp4'); assert.equal(restored.uploads[0].remoteFilename, original.filename);
  assert.equal((await h.json(path + '/retry', 'POST', { confirmRetry: true }, headers)).applied, true);
  const after = await h.json('/review/console/api/bootstrap');
  assert.equal(after.uploads.length, before.uploads.length); assert.equal(after.uploads[0].status, 'queued');
  assert.equal(after.uploads[0].attemptHistory[0].status, 'unknown'); assert.deepEqual(h.calls, []);
});


test('static DVR live and native output downloads remain synthetic with no real recorder access', async t => {
  const h = harness(t), video = new h.Media();
  video.src = '/review/console/api/dvrs/demo/live?channel=301&format=compat'; assert.match(video.src, /demo\.mp4$/);
  const download = new h.Anchor(); download.href = '/review/console/api/outputs/demo-output-1/stream?download=1'; assert.match(download.href, /demo\.mp4$/);
  download.href = 'https://example.com/document'; assert.equal(download.href, 'https://example.com/document');
  assert.equal((await h.request('/review/console/api/dvrs/demo/live?channel=301&format=fmp4')).status, 200);
  assert.ok(h.calls.every(url => url.endsWith('/demo.mp4')));
});

test('fixture date starts yesterday without changing production today or future bounds', async () => {
  const source = await readFile(new URL('../public/console.js', import.meta.url), 'utf8');
  const fixture = fixtureConsoleSource(source);
  assert.equal((fixture.match(/state.date = shanghai.format\(new Date\(Date.now\(\) - 86400000\)\)/g) || []).length, 2);
  assert.match(source, /state.date = today\(\)/);
  assert.ok(fixture.includes('function today() { return shanghai.format(new Date()); }'));
  const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(shanghai.format(new Date(Date.parse('2026-10-01T16:01:00Z') - 86400000)), '2026-10-01');
});

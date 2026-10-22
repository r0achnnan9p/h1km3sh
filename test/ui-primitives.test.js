import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconSvg, setButtonIcon, createSettingsRow, formatClipDuration } from '../public/ui-primitives.js';
class Element {
  children = []; attributes = {}; listeners = {};
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
}
test('shared icons use a closed SVG vocabulary and one accessible button label', () => {
  for (const icon of ['upload', 'more', 'add', 'edit', 'sort-newest', 'sort-oldest', 'search', 'logout', 'refresh', 'reload', 'chevron', 'dvr', 'mediamtx', 'cloud189', 'disk', 'trash', 'key', 'check-circle']) {
    const node = setButtonIcon(new Element(), icon, '操作');
    assert.match(node.innerHTML, /^<svg[^>]*aria-hidden="true"/); assert.equal(node.attributes['aria-label'], '操作'); assert.equal(node.title, '操作');
  }
  assert.throws(() => iconSvg('<script>'), /Unknown/); assert.throws(() => iconSvg('toString'), /Unknown/);
});
test('shared settings rows keep user content as plain text and preserve status/disabled behavior', () => {
  let clicks = 0; const document = { createElement: () => new Element() };
  const row = createSettingsRow({ document, title: '<img onerror=evil>', detail: '192.0.2.1', status: '测试失败', disabled: true, onClick: () => clicks++ });
  assert.equal(row.children[0].textContent, '<img onerror=evil>'); assert.equal(row.children[0].innerHTML, undefined);
  assert.equal(row.children[1].hidden, false); assert.equal(row.children[2].textContent, '测试失败'); assert.equal(row.disabled, true);
  const compact = createSettingsRow({ document, title: 'd1', onClick: () => clicks++ });
  assert.ok(compact.className.includes('config-summary-compact')); assert.equal(compact.children[1].hidden, true); assert.equal(compact.children[2].hidden, true);
  compact.listeners.click(); assert.equal(clicks, 1);
});


test('settings rows expose one button with a decorative chevron beside optional status', () => {
  const document = { createElement: tag => Object.assign(new Element(), { tag }) };
  for (const status of ['', '连接正常', '测试失败']) {
    const row = createSettingsRow({ document, title: '录像机', detail: '192.0.2.1', status, onClick() {} });
    assert.equal(row.tag, 'button'); assert.ok(row.children.every(node => node.tag !== 'button'));
    assert.equal(row.children[0].textContent, '录像机'); assert.equal(row.children[1].textContent, '192.0.2.1');
    assert.equal(row.children[2].textContent, status);
    const cue = row.children[3]; assert.equal(cue.className, 'settings-row-chevron'); assert.equal(cue.attributes['aria-hidden'], 'true');
    assert.equal(cue.innerHTML, iconSvg('chevron'));
  }
});

test('brand, favicon, Apple touch and PWA manifest share the selected v2 icon', async () => {
  const fs = await import('node:fs'); const { statusDashboardPage } = await import('../lib/status-dashboard.js');
  const html = statusDashboardPage('/camera');
  assert.equal(html.match(/<title>([^<]+)<\/title>/)?.[1], 'H1kM3sh');
  assert.match(html, /class="workspace-logo" src="\/camera\/console-icon-v2\.svg"/);
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/camera\/console-icon-v2\.svg"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/camera\/apple-touch-icon-v2\.png"/);
  assert.match(html, /href="\/camera\/site-v2\.webmanifest"/); assert.doesNotMatch(html, /class="workspace-logo"[^>]*>h</);
  const manifest = JSON.parse(fs.readFileSync(new URL('../public/site-v2.webmanifest', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512', 'any']);
  const install = JSON.parse(fs.readFileSync(new URL('../public/site-v2.webmanifest', import.meta.url), 'utf8'));
  assert.equal(install.name, 'H1kM3sh'); assert.equal(install.short_name, 'H1kM3sh');
  for (const icon of manifest.icons) assert.ok(!icon.purpose || icon.purpose === 'any');
  for (const [name, size] of [['console-icon-v2-192.png', 192], ['console-icon-v2-512.png', 512], ['apple-touch-icon-v2.png', 180]]) {
    const bytes = fs.readFileSync(new URL('../public/' + name, import.meta.url));
    assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
  }
});


test('clip durations omit zero units while retaining seconds and hours precisely', () => {
  for (const [ms, text] of [[10000, '10秒'], [60000, '1分'], [65000, '1分5秒'], [3600000, '1小时'], [3610000, '1小时10秒'], [3661000, '1小时1分1秒']]) assert.equal(formatClipDuration(ms), text);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
test('PWA zoom fallback cancels native zoom gestures without intercepting pointer, touch or scroll events', () => {
  const handlers = new Map();
  vm.runInNewContext(script.slice(script.indexOf('// iOS may ignore'), script.indexOf('const $ =')), { document: { addEventListener(name, fn, options) { assert.equal(options.passive, false); handlers.set(name, fn); } } });
  assert.deepEqual([...handlers.keys()], ['gesturestart', 'gesturechange']);
  for (const fn of handlers.values()) { let prevented = false; fn({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); }
});
test('navigation badge follows server active tasks and hides after completion, excluding errors, drafts and archived uploads', () => {
  const badges = [{}, {}], lists = { 'task-list': { replaceChildren() {}, append() {} }, 'upload-list': { replaceChildren() {}, append() {} } };
  const state = { tasks: [{ status: 'queued' }, { status: 'downloading' }, { status: 'error' }, { status: 'completed' }], uploads: [{ status: 'uploading' }, { status: 'draft' }, { status: 'unknown' }, { status: 'uploading', archivedAt: 1 }] };
  const context = { state, $: id => lists[id] || (lists[id] = {}), document: { querySelectorAll: () => badges, createElement: () => ({}) }, taskFeeds: { exports: { update() {} }, uploads: { update() {} } } };
  vm.createContext(context); vm.runInContext(script.slice(script.indexOf('function renderTasks()'), script.indexOf('// Explicit retry')), context);
  context.renderTasks(); for (const node of badges) { assert.equal(node.textContent, '3'); assert.equal(node.hidden, false); }
  state.tasks = []; state.uploads = []; context.renderTasks(); for (const node of badges) { assert.equal(node.textContent, '0'); assert.equal(node.hidden, true); }
});

test('dark shell selected and hover states retain readable semantic foregrounds', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /\.console-app \.calendar-day\.selected \{[^}]*color: var\(--on-accent\)/);
  assert.match(css, /\.boundary-editor:hover \{[^}]*background: var\(--surface2\)/);
  assert.match(css, /\.skip-link \{[^}]*color: var\(--on-accent\)/);
  const luminance = hex => { const channels = hex.match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; };
  const token = name => css.match(new RegExp('--' + name + ': #([a-f0-9]{6})'))[1];
  const contrast = (a, b) => { const values = [luminance(token(a)), luminance(token(b))].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); };
  assert.ok(contrast('accent', 'on-accent') >= 4.5);
  assert.ok(contrast('text', 'surface2') >= 4.5);
});

test('numeric font is bundled locally and unused Inter is removed', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /font-family: 'JetBrains Mono'; src: url\('\.\/fonts\/jetbrains-mono\.woff2'\)/);
  assert.doesNotMatch(css, /font-family: Inter|fonts\/inter\.woff2|--font: Inter/);
  assert.equal(fs.readFileSync(new URL('../public/fonts/jetbrains-mono.woff2', import.meta.url)).subarray(0, 4).toString(), 'wOF2');
  assert.equal(fs.existsSync(new URL('../public/fonts/inter.woff2', import.meta.url)), false);
});
test('bottom navigation has four named icon buttons and one server-derived task badge', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js');
  const html = statusDashboardPage(); const nav = html.slice(html.indexOf('<nav class="mobile-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="mobile-nav"')));
  const buttons = [...nav.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map(item => item[1]), ['回放', '成片', '任务', '设置']);
  for (const button of buttons) assert.match(button[2], /<svg /);
  assert.equal((nav.match(/data-task-count/g) || []).length, 1);
});

test('authoritative count survives truncated history and becomes hidden when server reports zero', () => {
  const badge = {}, state = { activeTaskCount: 51, tasks: [{ status: 'completed' }], uploads: [] };
  const list = { replaceChildren() {}, append() {} };
  const context = { state, $: () => list, document: { querySelectorAll: () => [badge], createElement: () => ({}) }, taskFeeds: { exports: { update() {} }, uploads: { update() {} } } };
  vm.createContext(context); vm.runInContext(script.slice(script.indexOf('function renderTasks()'), script.indexOf('// Explicit retry')), context);
  context.renderTasks(); assert.equal(badge.textContent, '51'); assert.equal(badge.hidden, false);
  state.activeTaskCount = 0; context.renderTasks(); assert.equal(badge.textContent, '0'); assert.equal(badge.hidden, true);
});
test('active navigation tint never overrides the semantic task badge, including opaque fallback', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.mobile-nav button\.active > span \{/);
  assert.match(css, /\.mobile-nav button\.active > span:not\(\.nav-task-count\)/);
  assert.match(css, /\.nav-task-count \{[^}]*background: var\(--accent\); color: var\(--on-accent\)/);
});

test('mobile nav contains touch drags while replay content and timeline keep their own scroll gestures', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /\.mobile-nav \{[^}]*position: fixed[^}]*touch-action: none/);
  assert.match(css, /\.mobile-nav \{[^}]*var\(--safe-bottom\)/);
  assert.match(css, /\.views \{[^}]*var\(--safe-top\)/);
  assert.match(css, /\.timeline \{[^}]*touch-action: pan-y/);
  assert.match(css, /\.boundary-handle \{[^}]*touch-action: pan-y/);
  assert.doesNotMatch(css, /(?:^|\})\s*(?:html|body|\.console-shell)\s*\{[^}]*touch-action:\s*none/);
  const html = statusDashboardPage();
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">/);
  assert.match(html, /id="quick-source-select"/);
  assert.match(html, /id="quick-camera-select"/);
});

test('bottom navigation remains native button click behavior after touch cancellation or drag-out', () => {
  const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  const html = statusDashboardPage();
  const nav = html.slice(html.indexOf('<nav class="mobile-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="mobile-nav"')));
  assert.equal((nav.match(/<button(?=[^>]*type="button")(?=[^>]*data-view=)[^>]*>/g) || []).length, 4);
  assert.match(script, /querySelectorAll\('\[data-view\]'\)\.forEach\(button => button\.addEventListener\('click', \(\) => navigate\(button\.dataset\.view\)\)\)/);
  assert.doesNotMatch(script, /data-view[^\n]*addEventListener\('(pointerdown|pointermove|pointerup|pointercancel|touchstart|touchmove)/);
});

// 用最小层叠解析器计算“有效 touch-action”（沿祖先取交集），验证手势归属而不依赖真机。
function effectiveTouchAction(css, chain) {
  const rules = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, order = 0;
  while ((m = re.exec(flat))) {
    const decl = /(?:^|;)\s*touch-action:\s*([a-z -]+?)\s*(?:;|$)/.exec(m[2]);
    if (!decl) continue;
    for (const raw of m[1].replace(/@media[^{]*$/, '').split(',')) {
      const sel = raw.trim().replace(/^.*\}\s*/, '');
      const simple = /^([a-z]*)((?:\.[\w-]+)*)(\[role="[\w-]+"\])?$/.exec(sel);
      if (!simple) continue;
      rules.push({ tag: simple[1], classes: simple[2].split('.').filter(Boolean), role: simple[3] && simple[3].slice(7, -2), value: decl[1], order: order++,
        spec: (simple[1] ? 1 : 0) + simple[2].split('.').filter(Boolean).length * 10 + (simple[3] ? 10 : 0) });
    }
  }
  let panX = true, panY = true;
  for (const el of chain) {
    const hits = rules.filter(r => (!r.tag || r.tag === el.tag) && r.classes.every(c => (el.classes || []).includes(c)) && (!r.role || r.role === el.role));
    hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
    const value = hits.at(-1)?.value;
    if (!value || value === 'auto') continue;
    if (value === 'none') { panX = false; panY = false; }
    else if (value === 'pan-y') panX = false;
    else if (value === 'pan-x') panY = false;
  }
  return { panX, panY };
}

test('touch gesture ownership: nav-origin drags never pan the page, content-origin drags still scroll', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const root = [{ tag: 'html' }, { tag: 'body' }, { tag: 'div', classes: ['console-shell'] }];
  const nav = [...root, { tag: 'nav', classes: ['mobile-nav'] }];
  assert.deepEqual(effectiveTouchAction(css, nav), { panX: false, panY: false });
  assert.deepEqual(effectiveTouchAction(css, [...nav, { tag: 'button' }]), { panX: false, panY: false });
  const views = [...root, { tag: 'main', classes: ['views'] }, { tag: 'section', classes: ['view'] }];
  assert.deepEqual(effectiveTouchAction(css, [...views, { tag: 'div', classes: ['task-scroll'] }]), { panX: true, panY: true });
  assert.deepEqual(effectiveTouchAction(css, [...views, { tag: 'button' }]), { panX: true, panY: true });
  const timeline = [...views, { tag: 'div', classes: ['timeline'] }];
  assert.deepEqual(effectiveTouchAction(css, timeline), { panX: false, panY: true });
  assert.deepEqual(effectiveTouchAction(css, [...timeline, { tag: 'button', classes: ['boundary-handle'] }]), { panX: false, panY: true });
});

test('console script never preventDefaults touchmove/touchstart globally', () => {
  const src = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /addEventListener\(\s*['"]touch(?:move|start)['"][^)]*preventDefault/);
  // 缩放兜底只拦截 gesturestart/gesturechange，不碰 touch 与滚动事件
  assert.match(src, /for \(const event of \['gesturestart', 'gesturechange'\]\) \{\s*document\.addEventListener\(event, e => e\.preventDefault\(\), \{ passive: false \}\);/);
});

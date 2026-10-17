import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
const source = script.slice(script.indexOf('function syncStandaloneViewport()'), script.indexOf('let standaloneViewportFrame'));
function harness() {
  const classes = new Set();
  // No style setter or screen dimensions: layout is CSS-owned, never a cached JS height.
  const root = { clientHeight: 873, classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } } };
  const window = { innerWidth: 430, innerHeight: 873, visualViewport: { height: 873, offsetTop: 0, scale: 1 } };
  const document = { documentElement: root, fullscreenElement: null }, navigator = { standalone: true };
  const context = vm.createContext({ window, document, navigator });
  vm.runInContext(source, context);
  const sync = () => { context.syncStandaloneViewport(); return classes.has('standalone-viewport'); };
  return { window, document, navigator, root, sync };
}

test('iOS standalone chooses CSS large viewport despite a 59px-short cold-start report', () => {
  const h = harness();
  assert.equal(h.sync(), true);
  for (const height of [932, 873, 800, 873, 932]) {
    h.window.innerHeight = h.window.visualViewport.height = height;
    assert.equal(h.sync(), true, 'report changes cannot replace the CSS baseline');
  }
  assert.match(css, /:root\s*\{\s*--app-viewport-height: 100dvh;/);
  assert.match(css, /html\.standalone-viewport \{ --app-viewport-height: 100vh; \}/);
  assert.match(css, /@supports \(height: 100lvh\)\s*\{\s*html\.standalone-viewport \{ --app-viewport-height: 100lvh; \}/);
  assert.doesNotMatch(source, /screen\.|innerHeight|clientHeight|setProperty|safe-top/);
});

test('keyboard height/offset does not shrink or move the app; dialogs keep visual fitting', () => {
  const h = harness();
  for (const [height, offsetTop] of [[873, 0], [520, 0], [480, 80], [873, 0]]) {
    Object.assign(h.window.visualViewport, { height, offsetTop });
    assert.equal(h.sync(), true);
  }
  const touch = fs.readFileSync(new URL('../public/touch-controls.js', import.meta.url), 'utf8');
  assert.match(touch, /export function fitDialogViewport\(dialog\)/);
  assert.match(touch, /dialog\.style\.setProperty\('--dialog-viewport-height'/);
  assert.match(css, /var\(--dialog-viewport-height, 100dvh\)/);
  assert.doesNotMatch(script + css, /--standalone-viewport-(?:height|inset)/);
});

test('all narrow iPhone orientations share the baseline, not just widths below 760', () => {
  const h = harness();
  for (const width of [320, 375, 390, 430, 700, 844, 932, 1023]) {
    h.window.innerWidth = width;
    assert.equal(h.sync(), true, 'width ' + width);
  }
  h.window.innerWidth = 1024;
  assert.equal(h.sync(), false);
  h.window.innerWidth = 430;
  assert.equal(h.sync(), true);
});

test('browser tabs, Windows installed PWAs, desktop, native fullscreen and zoom opt out', () => {
  for (const disable of [h => { h.navigator.standalone = false; }, h => { delete h.navigator.standalone; }, h => { h.window.innerWidth = 1440; }, h => { h.document.fullscreenElement = {}; }, h => { h.window.visualViewport.scale = 2; }]) {
    const h = harness(); assert.equal(h.sync(), true); disable(h); assert.equal(h.sync(), false);
  }
  const h = harness(); h.window.visualViewport = undefined;
  assert.equal(h.sync(), true, 'CSS baseline also works without VisualViewport');
});

test('shell and all layout panes share height; safe-area padding is not a shell offset', () => {
  const shell = css.match(/\.standalone-viewport \.console-shell\s*\{([^}]+)\}/)?.[1];
  const expanded = css.match(/\.standalone-viewport \.precision-layout #view-replay\.focus-replay\.replay-expanded\s*\{([^}]+)\}/)?.[1];
  for (const pane of [shell, expanded]) {
    assert.ok(pane);
    assert.match(pane, /position:\s*absolute;\s*inset:\s*0 0 auto;\s*height:\s*var\(--app-viewport-height\);/);
    assert.doesNotMatch(pane, /--safe-|--status-bar-blur-gap|padding|transform/, 'safe areas belong to content, never another shell offset');
  }
  assert.match(css, /body\.precision-layout\[data-view='replay'\] \.workspace-main\s*\{\s*height:\s*var\(--app-viewport-height\);/);
  for (const line of css.split('\n').filter(line => line.includes('100dvh'))) {
    assert.ok(line.includes('--app-viewport-height: 100dvh') || line.includes('.app-dialog'), 'unshared app viewport: ' + line);
  }
  assert.match(css, /\.precision-layout \.mobile-nav \{[^}]*bottom:0; height:calc\(64px \+ var\(--safe-bottom\)\)/);
});

test('status-bar sampling strip is a real, decorative, fixed solid edge, not a blur mask', () => {
  const html = statusDashboardPage();
  assert.match(html, /<body[^>]*>\s*<div class="status-bar-background" aria-hidden="true"><\/div>/);
  assert.match(css, /\.status-bar-background \{ display: none; \}/);
  const rule = css.match(/\.standalone-viewport \.status-bar-background \{([^}]+)\}/)[1];
  assert.match(rule, /position: fixed; inset: 0 0 auto/);
  assert.match(rule, /height: max\(6px, var\(--safe-top\)\); background: var\(--bg\)/);
  assert.match(rule, /pointer-events: none; z-index: var\(--z-nav\)/);
  assert.doesNotMatch(rule, /filter|mask|opacity|transform|padding/);
});

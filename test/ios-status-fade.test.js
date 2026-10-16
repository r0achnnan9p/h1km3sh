import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
const source = script.slice(script.indexOf('function syncStandaloneViewport()'), script.indexOf('let standaloneViewportFrame'));

function flags({ standalone = true, userAgent = 'Version/27.0 Mobile Safari/604.1', width = 430, fullscreen = false, scale = 1 } = {}) {
  const classes = new Map();
  const context = vm.createContext({
    navigator: { standalone, userAgent },
    window: { innerWidth: width, visualViewport: { scale } },
    document: { fullscreenElement: fullscreen ? {} : null, documentElement: { classList: { toggle(name, enabled) { classes.set(name, enabled); } } } },
  });
  vm.runInContext(source, context);
  context.syncStandaloneViewport();
  return Object.fromEntries(classes);
}

test('iOS 27 installed PWA enables bounded status-fade clearance without changing viewport selection', () => {
  const result = flags();
  assert.equal(result['standalone-viewport'], true);
  assert.equal(result['standalone-status-fade'], true);
});

test('ordinary tabs, desktop and native fullscreen opt out of status-fade clearance', () => {
  for (const options of [{ standalone: false }, { standalone: undefined, width: 1440 }, { width: 1024 }, { fullscreen: true }, { scale: 2 }]) {
    assert.equal(flags(options)['standalone-status-fade'], false, JSON.stringify(options));
  }
});

test('known older Safari stays unchanged; frozen OS tokens are not used as the real version', () => {
  assert.equal(flags({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/26.4 Mobile Safari/604.1' })['standalone-status-fade'], false);
  assert.equal(flags({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.0 Mobile Safari/604.1' })['standalone-status-fade'], true);
});

test('installed web views without Version use bounded clearance instead of assuming an old iOS', () => {
  for (const userAgent of ['', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148']) {
    assert.equal(flags({ userAgent })['standalone-status-fade'], true);
    assert.equal(flags({ userAgent, standalone: false })['standalone-status-fade'], false);
  }
});

test('clearance defaults to zero, is capped by an existing spacing token and follows the real top inset', () => {
  assert.match(css, /--status-bar-blur-gap:\s*0px;/);
  assert.match(css, /html\.standalone-status-fade\s*\{\s*--status-bar-blur-gap:\s*clamp\(0px,\s*var\(--safe-top\),\s*var\(--space-5\)\);\s*\}/);
  assert.match(css, /--space-5:\s*20px/);
  assert.doesNotMatch(source, /screen\.|innerHeight|setProperty/);
});

test('top padding and bounded pane heights account for the same clearance exactly once', () => {
  assert.match(css, /padding:calc\(max\(12px,var\(--safe-top\)\) \+ var\(--status-bar-blur-gap\)\) 16px calc\(68px \+ var\(--safe-bottom\)\)/);
  assert.match(css, /padding-top:calc\(max\(8px,var\(--safe-top\)\) \+ var\(--status-bar-blur-gap\)\)/);
  assert.match(css, /min-height:calc\(var\(--app-viewport-height\) - max\(12px,var\(--safe-top\)\) - var\(--status-bar-blur-gap\) - var\(--safe-bottom\) - 108px\)/);
  const paneHeights = css.match(/height:calc\(var\(--app-viewport-height\) - max\(12px,var\(--safe-top\)\) - var\(--status-bar-blur-gap\) - var\(--safe-bottom\) - 88px\)/g);
  assert.equal(paneHeights?.length, 2, 'both library and tasks use the same available height');
  assert.match(css, /bottom:0; height:calc\(64px \+ var\(--safe-bottom\)\)/, 'bottom rail geometry is unchanged');
});

test('diagnostic text and close target also stay below the system fade without altering the safe-area reading', () => {
  const debug = fs.readFileSync(new URL('../public/debug-mark.js', import.meta.url), 'utf8');
  assert.match(debug, /padding:calc\(4px \+ env\(safe-area-inset-top,0px\) \+ var\(--status-bar-blur-gap,0px\)\)/);
  assert.match(debug, /top:calc\(env\(safe-area-inset-top,0px\) \+ var\(--status-bar-blur-gap,0px\)\)/);
  assert.doesNotMatch(debug, /setProperty\(['"]--safe-top/);
});

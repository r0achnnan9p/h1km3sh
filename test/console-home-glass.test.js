import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

test('选段提示只在还不能导出时出现，并区分缺哪一端', () => {
  const body = script.slice(script.indexOf('function replaySelectionCue('), script.indexOf('const cue = replaySelectionCue'));
  const context = {};
  vm.runInContext(`${body}\nglobalThis.replaySelectionCue = replaySelectionCue;`, vm.createContext(context));
  const cue = (input) => context.replaySelectionCue(input);
  const expectCue = (input, text, tone) => { const got = cue(input); assert.equal(got.text, text); assert.equal(got.tone, tone); };
  expectCue({}, '先标记入点，再标记出点。', '');
  expectCue({ needsChannel: true, inMs: 1, outMs: 2 }, '先选择录像机和通道。', '');
  expectCue({ outMs: 2_000 }, '再标记入点即可导出。', '');
  expectCue({ inMs: 1_000 }, '再标记出点即可导出。', '');
  expectCue({ inMs: 5_000, outMs: 5_000 }, '出点需要晚于入点。', 'warning');
  expectCue({ inMs: 1_000, outMs: 2_000 }, '', 'ready');
});

test('画面占位状态沿用现有标题，不另造一套文案', () => {
  const body = script.slice(script.indexOf('function updatePreviewPlaceholder('), script.indexOf('function segmentBounds('));
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: {} }); return nodes.get(id); };
  const context = { $, globalThis: {} };
  vm.runInContext(`${body}\nglobalThis.updatePreviewPlaceholder = updatePreviewPlaceholder;`, vm.createContext(context));
  const paint = title => { context.updatePreviewPlaceholder(title, ''); return $('player-placeholder').dataset.state; };
  assert.equal(paint('正在查询录像'), 'loading');
  assert.equal(paint('录像列表读取失败'), 'error');
  assert.equal(paint('这一天没有录像'), 'empty');
  assert.equal(paint('尚未发现镜头'), 'empty');
  assert.equal(paint('录像已就绪'), 'ready');
});

test('浮在画面上的回放控制使用遮罩且不模糊，日期弹层让出安全区', () => {
  assert.match(css, /--material-scrim:\s*rgba\(5,6,15,\.88\)/);
  assert.match(css, /--glass:\s*rgba\(186,214,247,\.12\)/);
  assert.match(css, /--cta:\s*#ffffff/);
  assert.match(css, /#export-range \{[^}]*background:var\(--cta\); border-radius:var\(--radius-pill\)/);
  const header = '@media (orientation: landscape) and (max-height: 540px) and (min-width: 568px) and (max-width: 1023px) {';
  const landscape = css.slice(css.lastIndexOf(header));
  const block = landscape.slice(0, landscape.indexOf('\n@media'));
  assert.match(block, /\.replay-control-panel \{[^}]*background: var\(--material-scrim\)[^}]*backdrop-filter: none/);
  assert.match(block, /\.player-placeholder \{[^}]*justify-content: flex-start/);
  assert.match(block, /\.app-dialog \{[^}]*var\(--safe-left\)[^}]*var\(--safe-bottom\)/);
  assert.match(block, /\.app-dialog:has\(\.calendar-control\) \{[^}]*var\(--safe-left\)/);
  assert.match(block, /\.app-dialog:has\(\.calendar-control\) \{[^}]*top: calc\(var\(--dialog-viewport-top, 0px\) \+ max\(var\(--space-2\), var\(--safe-top\)\)\)[^}]*height: calc\(min\(var\(--app-viewport-height\), var\(--dialog-viewport-height,/);
  assert.match(block, /\.app-dialog:has\(\.calendar-control\) > \.dialog-body \{[^}]*overflow-y: auto/);
  assert.match(block, /\.calendar-grid \{[^}]*overflow-y: auto/);
  assert.match(css, /#export-range:disabled:not\(\[aria-busy='true'\]\)/);
  assert.match(css, /max-width: 1023px\) and \(prefers-reduced-transparency: reduce\) \{\s*\.precision-layout #view-replay\.focus-replay \.replay-topbar,\s*\.precision-layout #view-replay\.focus-replay \.replay-control-panel \{ background: var\(--surface\)/);
});

test('动效集中在 token，时间尺不被动效拖慢，减少动效时停掉位移和循环', () => {
  assert.match(css, /--motion-distance:\s*6px/);
  assert.match(css, /--motion-press:\s*\.97/);
  assert.match(css, /--ease-release:\s*cubic-bezier\(\.16,1\.04,\.32,1\)/);
  assert.match(css, /button:not\(:disabled\):active \{ transform: scale\(var\(--motion-press\)\); \}/);
  assert.match(css, /button:disabled \{ transform: none; \}/);
  assert.doesNotMatch(css, /transition:\s*all\b/);
  assert.match(css, /\.view\.active \{ animation: motion-view var\(--dur\) var\(--ease\) both; \}/);
  assert.match(css, /\.app-dialog\[open\]::backdrop \{ animation: motion-fade var\(--dur\) var\(--ease\) both; \}/);
  assert.match(css, /\.overview-cursor,\.overview-selection,\.time-cursor,\.range-overlay[^}]*transition: none; animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after, \*::backdrop \{ animation: none !important; transition: none !important;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.player-placeholder\[data-state='loading'\] \.preview-emblem \{ animation: none; \}\s*button:not\(:disabled\):active \{ transform: none; \}/);
});

test('桌面设置单独滚动，降低透明度盖过顶栏玻璃', () => {
  assert.match(css, /body\.precision-layout\[data-view='settings'\] \.workspace-main \{ overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; \}/);
  assert.match(css, /body\.precision-layout\[data-view='replay'\] \.workspace-main \{[^}]*overflow:hidden/);
  const glass = css.lastIndexOf('background: var(--glass); box-shadow: none;');
  const reduce = css.lastIndexOf('@media (min-width: 1024px) and (prefers-reduced-transparency: reduce)');
  assert.ok(glass > 0 && reduce > glass, '降低透明度写在桌面顶栏玻璃之后');
  assert.match(css.slice(reduce), /\.precision-layout \.side-nav \{ background: var\(--surface\); -webkit-backdrop-filter: none; backdrop-filter: none; \}/);
});

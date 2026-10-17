import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const prefix = '.precision-layout #view-replay.focus-replay';
// These guard the shared CSS contract. Actual viewport geometry is verified in
// a browser; a synthetic pixel budget cannot stand in for iPhone safe areas.
function selectors(header) {
  const result = []; let start = 0, depth = 0;
  for (let i = 0; i < header.length; i++) {
    if ('(['.includes(header[i])) depth++;
    else if (')]'.includes(header[i])) depth--;
    else if (header[i] === ',' && depth === 0) { result.push(header.slice(start, i).trim()); start = i + 1; }
  }
  result.push(header.slice(start).trim()); return result;
}
function parseRules(source, conditions = []) {
  const rules = []; let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor); if (open < 0) break;
    const header = source.slice(cursor, open).trim(); let end = open + 1, depth = 1;
    while (depth && end < source.length) { if (source[end] === '{') depth++; else if (source[end] === '}') depth--; end++; }
    const body = source.slice(open + 1, end - 1);
    if (header.startsWith('@media') || header.startsWith('@supports')) rules.push(...parseRules(body, [...conditions, header]));
    else {
      const style = Object.fromEntries(body.split(';').filter(value => value.includes(':')).map(value => {
        const split = value.indexOf(':'); return [value.slice(0, split).trim(), value.slice(split + 1).trim()];
      }));
      for (const selector of selectors(header)) rules.push({ selector, conditions, style });
    }
    cursor = end;
  }
  return rules;
}
const rules = parseRules(css);
const style = selector => Object.assign({}, ...rules.filter(rule => rule.selector === selector && rule.conditions.length === 0).map(rule => rule.style));
const pixels = value => value?.startsWith('var(') ? parseFloat(style(':root')[value.slice(4, -1)]) : parseFloat(value);

test('replay reserves the existing app viewport for a shrinking video and reachable controls', () => {
  const shell = style("body.precision-layout[data-view='replay'] .workspace-main");
  const view = style(prefix + '.active');
  const editor = style(prefix + ' .replay-editor');
  const video = style(prefix + ' .video-card');
  assert.equal(shell.height, 'var(--app-viewport-height)');
  assert.equal(view['min-height'], '0'); assert.equal(view['overflow-y'], 'auto');
  assert.equal(editor['min-height'], '0'); assert.equal(editor['flex-direction'], 'column');
  assert.match(video.flex, /\b1\b/); assert.ok(pixels(video['min-height']) < 100);
  assert.equal(style(prefix + ' .player-wrap video')['object-fit'], 'contain');
  const collapsed = style(prefix + "[data-chrome-overlay='false'][data-chrome-idle='true'] :is(.replay-topbar,.replay-control-panel)");
  assert.equal(collapsed.display, 'none', 'manual hiding in normal layouts returns control space to the flexible video');
  assert.doesNotMatch(css, /(?:height|min-height|max-height):\s*(?:430|932)px/);
});

test('date, transport, time windows and split boundary actions retain finger-sized hit targets', () => {
  for (const selector of [' .replay-date-controls > button', ' .transport-buttons > button', ' .replay-media-tools > button', ' .timeline-window-switch > button', ' .mark-field > button', ' .replay-actions > button']) {
    const button = style(prefix + selector);
    assert.ok(pixels(button['min-height']) >= 44, selector + ' touch height');
  }
  const dateIcon = style(prefix + ' .replay-date-controls > button svg');
  assert.ok(pixels(dateIcon.width) >= 24); assert.ok(pixels(dateIcon.height) >= 24);
  assert.equal(style(prefix + ' .replay-actions').position, 'static');
  assert.equal(style(prefix + ' .mark-controls').position, 'static');
  assert.doesNotMatch(css, /data-replay-mode|\.replay-mode-switch/);
  assert.equal(style(prefix + ' .replay-selection-editor').display, 'grid');
});

test('landscape and fullscreen hide the whole chrome together and keep keyboard wake available', () => {
  const idle = rules.filter(rule => rule.selector.includes('focus-replay') && rule.selector.includes("[data-chrome-idle='true']") && !rule.selector.includes("[data-chrome-overlay='false']"));
  assert.ok(idle.some(rule => rule.selector.includes(':fullscreen')));
  assert.ok(idle.some(rule => rule.conditions.some(condition => condition.includes('orientation:landscape'))));
  for (const rule of idle) {
    assert.match(rule.selector, /:is\(\.replay-topbar,\.replay-control-panel\)/);
    assert.equal(rule.style.opacity, '0'); assert.equal(rule.style['pointer-events'], 'none');
    assert.notEqual(rule.style.display, 'none'); assert.notEqual(rule.style.visibility, 'hidden');
  }
  const wake = rules.filter(rule => rule.selector.includes('focus-replay') && rule.selector.includes(':has(:focus-visible)'));
  assert.ok(wake.length >= 2);
  for (const rule of wake) { assert.equal(rule.style.opacity, '1'); assert.equal(rule.style['pointer-events'], 'auto'); }
  assert.equal(style(prefix + ' .replay-control-panel > :is(.timeline-section,.replay-selection-editor)')['flex-shrink'], '0',
    'bounded error-state docks scroll intact sections instead of shrinking their fixed grid rows into each other');
  const overlays = rules.filter(rule => rule.selector.endsWith(' .replay-control-panel') && rule.style.position === 'absolute');
  assert.ok(overlays.length >= 2);
  for (const { style: dock } of overlays) {
    assert.match(dock.left, /var\(--safe-left\)/); assert.match(dock.right, /var\(--safe-right\)/);
    assert.match(dock.bottom, /var\(--safe-bottom\)/); assert.match(dock['max-height'], /100%.*safe-top.*safe-bottom/);
    assert.equal(dock['overflow-y'], 'auto');
  }
});

test('narrow layouts can wrap dates and selection actions without hiding essential controls', () => {
  const narrow = rules.filter(rule => rule.conditions.some(condition => /max-width:399px/.test(condition)));
  assert.equal(narrow.find(rule => rule.selector === prefix + ' .replay-date-controls')?.style['grid-column'], '1/-1');
  assert.ok(narrow.some(rule => rule.selector.includes('.replay-actions:has(') && rule.style['flex-wrap'] === 'wrap'));
  const portrait = rules.filter(rule => rule.conditions.some(condition => condition.includes('(max-width:567px)')));
  assert.ok(portrait.some(rule => rule.selector === prefix + ' .replay-actions' && rule.style['grid-column'] === '1'));
  const overlayRules = rules.filter(rule => rule.conditions.some(condition => condition.includes('max-height:540px')) && rule.selector.includes('focus-replay'));
  assert.ok(overlayRules.length > 0);
  for (const rule of overlayRules) {
    const widths = rule.conditions.flatMap(condition => [...condition.matchAll(/max-width:\s*(\d+)px/g)].map(match => Number(match[1])));
    assert.ok(widths.some(width => width <= 1023), 'phone-only overlay rules cannot match desktop widths');
  }
  assert.equal(style('.precision-layout .app-reload').background, 'transparent');
  assert.ok(pixels(style('.precision-layout .app-reload')['min-height']) >= 44);
  assert.doesNotMatch(css, /\.app-header\s+\.app-reload\s*\{[^}]*background:/);
});

test('the single time ruler clips data proportionally and keeps edge labels inside the track', () => {
  const track = style(prefix + ' .precision-track-host .timeline-overview');
  assert.ok(pixels(track['min-height']) >= 44);
  assert.equal(track.overflow, 'hidden');
  assert.equal(track['touch-action'], 'pan-y', 'vertical swipes can scroll short screens while horizontal ruler drags remain owned');
  const interval = style(prefix + ' :is(.overview-segment,.overview-gap,.overview-outside)');
  assert.equal(interval['min-width'], '0', 'short recordings and gaps must not be inflated');
  assert.equal(interval['pointer-events'], 'none');
  assert.equal(style(".precision-layout .overview-tick small[data-edge='start']").transform, 'none');
  assert.equal(style(".precision-layout .overview-tick small[data-edge='end']").transform, 'translateX(-100%)');
  assert.doesNotMatch(css, /\.precision-scrubbing[^{}]*\{[^}]*(?:opacity:1|opacity:0)/,
    'no pointer gesture swaps in the legacy second time ruler');
});

test('portrait compacts media tools with four windows while the smallest layout keeps full-width choices', () => {
  const portrait = rules.filter(rule => rule.conditions.some(condition => condition.includes('(max-width:567px)')));
  const rule = suffix => portrait.find(item => item.selector === prefix + suffix)?.style;
  assert.equal(rule(' .replay-toolbar').display, 'contents');
  assert.equal(rule(' .transport-buttons')['grid-row'], '1');
  assert.equal(rule(' .timeline-time-editor')['grid-row'], '1');
  assert.equal(rule(' .replay-media-tools')['grid-row'], '3');
  assert.equal(rule(' .timeline-window-switch')['grid-row'], '3');
  const optionWidth = (pixels(rule(' .timeline-window-switch').width) - 2) / 4;
  assert.ok(optionWidth >= 44, 'all four choices retain full touch width');
  const tiny = rules.filter(item => item.conditions.some(condition => condition.includes('max-width:374px')));
  const tinyWindow = tiny.find(item => item.selector === prefix + ' .timeline-window-switch').style;
  assert.equal(tinyWindow.width, '100%'); assert.equal(tinyWindow['grid-column'], '1/-1');
  assert.equal(tinyWindow['grid-row'], '4');
  const tinyTrack = tiny.find(item => item.selector === prefix + ' .precision-track-host').style;
  assert.equal(tinyTrack['grid-row'], '3');
});

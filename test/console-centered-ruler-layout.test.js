import test from 'node:test';
import assert from 'node:assert/strict';
import { statusDashboardPage } from '../lib/status-dashboard.js';

function replayElements() {
  const page = statusDashboardPage();
  const html = page.slice(page.indexOf('<section class="view active focus-replay"'), page.indexOf('<section class="view" id="view-library"'));
  const nodes = [], stack = [];
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'source']);
  for (const match of html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*?)>/gi)) {
    const [, closing, tag, raw] = match;
    if (closing) { const index = stack.findLastIndex(node => node.tag === tag); if (index >= 0) stack.length = index; continue; }
    const attrs = Object.fromEntries([...raw.matchAll(/([\w:-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    for (const name of ['hidden', 'inert']) if (new RegExp('(?:^|\\s)' + name + '(?:\\s|$)').test(raw)) attrs[name] = true;
    const node = { tag, attrs, parent: stack.at(-1) || null }; nodes.push(node);
    if (!voidTags.has(tag)) stack.push(node);
  }
  const byId = id => { const matches = nodes.filter(node => node.attrs.id === id); assert.equal(matches.length, 1, id); return matches[0]; };
  const suppressed = node => { for (let current = node; current; current = current.parent) if (current.attrs.hidden || current.attrs.inert) return true; return false; };
  return { html, nodes, byId, suppressed };
}

test('one visible whole-second ruler owns all four directly selectable time windows', () => {
  const h = replayElements();
  const sliders = h.nodes.filter(node => node.attrs.role === 'slider' && !h.suppressed(node));
  assert.deepEqual(sliders.map(node => node.attrs.id), ['timeline-overview']);
  assert.equal(sliders[0].attrs.tabindex, '0');
  assert.equal(sliders[0].attrs['aria-valuemax'], '86399');
  assert.equal(h.byId('overview-ruler').attrs.class, 'overview-ruler');
  const options = h.nodes.filter(node => 'data-timeline-span' in node.attrs);
  assert.deepEqual(options.map(node => node.attrs['data-timeline-span']), ['86400', '3600', '300', '30']);
  assert.deepEqual(options.map(node => node.attrs['aria-pressed']), ['true', 'false', 'false', 'false']);
  for (const option of options) { assert.equal(h.suppressed(option), false); assert.equal(option.attrs['aria-controls'], 'timeline-overview'); }
  assert.doesNotMatch(h.html, /replay-mode-watch|replay-mode-select|data-replay-mode|远离轨道/);
});

test('legacy references cannot expose a second interactive timeline or boundary handles', () => {
  const h = replayElements();
  for (const id of ['timeline', 'boundary-in', 'boundary-out']) {
    const node = h.byId(id);
    assert.equal(h.suppressed(node), true, id + ' remains only a hidden compatibility reference');
    assert.equal(node.attrs.tabindex, '-1');
  }
  assert.equal(h.byId('timeline').parent.attrs.inert, true);
  assert.equal(h.byId('timeline').parent.attrs.hidden, true);
  assert.equal(h.byId('overview-window').attrs.hidden, true);
  assert.equal(h.byId('timeline-hover').parent.attrs.id, 'timeline-overview');
});

test('explicit marks, manual time, transport and export remain independent accessible actions', () => {
  const h = replayElements();
  for (const id of ['timeline-time-editor', 'mark-in', 'mark-out', 'edit-in', 'edit-out', 'clear-marks', 'export-range', 'transport-toggle', 'skip-back', 'skip-forward', 'previous-day', 'playback-context', 'next-day', 'replay-fullscreen']) {
    const node = h.byId(id);
    assert.equal(node.tag, 'button', id);
    assert.equal(h.suppressed(node), false, id);
    assert.ok(node.attrs['aria-label'], id + ' is named');
  }
  assert.match(h.html, /id="mark-in"[^>]*>[\s\S]*?<span>设为入点<\/span>/);
  assert.match(h.html, /id="mark-out"[^>]*>[\s\S]*?<span>设为出点<\/span>/);
  for (const id of ['skip-back', 'skip-forward']) assert.match(h.byId(id).attrs['aria-label'], /10 秒/);
});

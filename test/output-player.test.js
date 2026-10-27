import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutputPlayers } from '../public/output-player.js';

class Element {
  constructor(tagName = 'document') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.hidden = false; this.disabled = false; this.className = ''; this.textContent = '';
  }
  append(...children) {
    for (const child of children) { child.remove(); child.parent = this; this.children.push(child); }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'src') this.src = ''; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { return Promise.all([...this.listeners.get(type) || []].map(callback => callback({ type, target: this }))); }
  click() { if (!this.disabled) return this.emit('click'); }
  focus() { this.focused = true; }
  find(predicate) { return this.children.find(predicate) || this.children.map(child => child.find(predicate)).find(Boolean); }
}
class Video extends Element {
  constructor() {
    super('video'); this.paused = true; this.ended = false; this.duration = NaN; this.currentTime = 0; this.src = '';
    this.loads = 0; this.plays = 0; this.pauses = 0;
  }
  load() { this.loads++; this.duration = NaN; this.currentTime = 0; this.ended = false; }
  play() {
    this.plays++;
    if (this.playBehavior) return this.playBehavior();
    this.paused = false; this.emit('play'); this.emit('playing'); return Promise.resolve();
  }
  pause() {
    this.pauses++; const wasPaused = this.paused; this.paused = true;
    if (!wasPaused) this.emit('pause');
  }
}
const file = (id, overrides = {}) => ({ id, filename: `Match ${id}.mp4`, streamUrl: `/console/api/outputs/${id}/stream`, ...overrides });
function harness(options = {}) {
  const document = new Element(); const notices = [], played = [];
  document.createElement = tag => tag === 'video' ? new Video() : new Element(tag);
  const players = createOutputPlayers({ document, resolveUrl: url => `/prefix${url}`, onNotice: message => notices.push(message), onPlay: video => played.push(video), ...options });
  const node = id => {
    const element = players.get(file(id));
    return {
      element,
      video: element.find(node => node.tagName === 'VIDEO'),
      poster: element.find(node => node.className === 'output-poster'),
      toolbar: element.find(node => node.className === 'output-player-controls'),
      toggle: element.find(node => node.className.includes('output-play-toggle')),
      back: element.find(node => node.getAttribute('aria-label') === '后退 10 秒'),
      forward: element.find(node => node.getAttribute('aria-label') === '前进 10 秒'),
      collapse: element.find(node => node.className.includes('output-collapse')),
      retry: element.find(node => node.className.includes('output-player-retry')),
      status: element.find(node => node.className === 'output-player-status'),
      time: element.find(node => node.className === 'output-player-time'),
      duration: element.find(node => String(node.className).includes('output-duration')),
      fullscreen: element.find(node => node.textContent === '全屏'),
    };
  };
  return { document, players, notices, played, node };
}

test('poster has one text-free play affordance and keeps its accessible name', async () => {
  const h = harness(), p = h.node('single');
  assert.equal(p.poster.children.length, 2);
  assert.equal(p.poster.children.filter(node => node.tagName === 'BUTTON').length, 0);
  assert.equal(p.poster.children[1].textContent, '');
  assert.equal(p.poster.getAttribute('aria-label'), '播放成片：Match single.mp4');
  assert.equal(p.status.textContent, '');
  const caption = p.element.find(node => node.className === 'output-player-caption');
  assert.equal(caption.hidden, true);
  await p.poster.click(); assert.equal(caption.hidden, false);
  await p.collapse.click(); assert.equal(caption.hidden, true);
});

test('finished-video cards are lazy, video-first, and retain native controls', async () => {
  const h = harness(), p = h.node('first');
  assert.equal(p.video.src, ''); assert.equal(p.video.loads, 0); assert.equal(p.video.hidden, true);
  assert.equal(p.poster.hidden, false); assert.equal(p.toolbar.hidden, true);
  assert.equal(p.video.controls, true); assert.equal(p.video.playsInline, true); assert.equal(p.video.preload, 'none');
  assert.equal(p.poster.getAttribute('aria-expanded'), 'false');
  assert.equal(p.element.children[0].className, 'output-preview-surface');
  await p.poster.click();
  assert.equal(p.video.src, '/prefix/console/api/outputs/first/stream'); assert.equal(p.video.loads, 1);
  assert.equal(p.video.hidden, false); assert.equal(p.poster.hidden, true); assert.equal(p.toolbar.hidden, false);
  assert.equal(p.element.dataset.state, 'playing'); assert.equal(p.toggle.textContent, '暂停');
  await p.collapse.click();
  assert.equal(p.video.paused, true); assert.equal(p.video.hidden, true); assert.equal(p.poster.focused, true);
  await p.poster.click(); assert.equal(p.video.loads, 1);
});

test('finished videos show the listed duration before the lazy video metadata loads', async () => {
  const h = harness(), p = h.node('known');
  assert.equal(p.video.src, '');
  assert.equal(p.duration.textContent, '--:--');
  h.players.get(file('known', { durationSeconds: 125.8 }));
  assert.equal(p.duration.textContent, '02:05');
  await p.poster.click();
  assert.equal(p.duration.textContent, '02:05');
  p.video.duration = 95; await p.video.emit('loadedmetadata');
  assert.equal(p.duration.textContent, '01:35');
  assert.equal(p.time.textContent, '00:00 / 01:35');
  h.players.get(file('known', { durationSeconds: 60 }));
  assert.equal(p.duration.textContent, '01:35');
  h.players.get(file('known', { durationSeconds: 60, streamUrl: '/changed/stream' }));
  assert.equal(p.duration.textContent, '01:00');
});

test('large seek controls wait for metadata and clamp both ends without autoplaying', async () => {
  const h = harness(), p = h.node('first');
  assert.equal(p.back.disabled, true); await p.poster.click(); assert.equal(p.forward.disabled, true);
  p.video.duration = 95; await p.video.emit('loadedmetadata');
  assert.equal(p.forward.disabled, false); await p.toggle.click();
  p.video.currentTime = 4; await p.back.click(); assert.equal(p.video.currentTime, 0);
  p.video.currentTime = 90; await p.forward.click(); assert.equal(p.video.currentTime, 95);
  assert.equal(p.video.paused, true); assert.equal(p.time.textContent, '01:35 / 01:35');
  p.video.duration = Infinity; await p.video.emit('durationchange'); assert.equal(p.forward.disabled, true);
});

test('custom and native playback both pause other finished videos', async () => {
  const h = harness(), first = h.node('first'), second = h.node('second');
  await first.poster.click(); await second.poster.click();
  assert.equal(first.video.paused, true); assert.equal(second.video.paused, false);
  first.video.paused = false; await first.video.emit('play');
  assert.equal(second.video.paused, true); assert.equal(first.toggle.textContent, '暂停');
  h.players.pauseAll(); assert.equal(first.video.paused, true);
});

test('loading, buffering, media errors and retry are visible and recover in place', async () => {
  const h = harness(), p = h.node('first'); let resolve;
  p.video.playBehavior = () => { p.video.paused = false; p.video.emit('play'); return new Promise(done => { resolve = done; }); };
  const started = p.poster.click();
  assert.equal(p.element.dataset.state, 'loading'); assert.equal(p.element.getAttribute('aria-busy'), 'true');
  await p.video.emit('waiting'); assert.equal(p.status.textContent, '正在缓冲…');
  p.video.currentTime = 25; await p.video.emit('error');
  assert.equal(p.element.dataset.state, 'error'); assert.equal(p.retry.hidden, false); assert.equal(p.back.disabled, true);
  resolve(); await started;
  assert.equal(p.element.dataset.state, 'error'); assert.equal(p.video.paused, true);
  p.video.playBehavior = null; await p.retry.click();
  assert.equal(p.video.loads, 2); assert.equal(p.retry.hidden, true);
  p.video.duration = 120; await p.video.emit('loadedmetadata'); assert.equal(p.video.currentTime, 25);
  assert.equal(p.element.dataset.state, 'playing');
});

test('autoplay rejection leaves a visible native fallback without an unhandled rejection', async () => {
  const h = harness(), p = h.node('first');
  p.video.playBehavior = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await p.poster.click();
  assert.equal(p.element.dataset.state, 'paused'); assert.equal(p.video.hidden, false); assert.equal(p.video.controls, true);
  assert.match(p.status.textContent, /视频播放器中的播放键/); assert.equal(p.toggle.textContent, '播放');
  p.video.playBehavior = null; await p.toggle.click(); assert.equal(p.element.dataset.state, 'playing');
});

test('collapsing or removing during a pending play cannot resurrect hidden playback', async () => {
  const h = harness(), p = h.node('first'); let resolve;
  p.video.playBehavior = () => new Promise(done => { resolve = done; });
  const pending = p.poster.click(); await p.collapse.click();
  p.video.paused = false; resolve(); await pending;
  assert.equal(p.video.paused, true); assert.equal(p.video.hidden, true); assert.equal(p.element.dataset.expanded, 'false');
  const next = p.poster.click(); h.players.retain([]); p.video.paused = false; resolve(); await next;
  assert.equal(p.video.paused, true); assert.equal(p.video.src, '');
  assert.equal(h.document.listeners.get('fullscreenchange').size, 0);
});

test('refreshing an unchanged ID reuses its video and playhead; changed URLs reset safely', async () => {
  const h = harness(), p = h.node('first'); await p.poster.click(); p.video.currentTime = 42;
  const beforePauses = p.video.pauses;
  assert.equal(h.players.get(file('first', { filename: 'New title.mp4' })), p.element);
  assert.equal(p.video.currentTime, 42); assert.equal(p.video.pauses, beforePauses); assert.equal(p.video.loads, 1);
  assert.equal(p.video.getAttribute('aria-label'), 'New title.mp4');
  h.players.get(file('first', { streamUrl: '/changed/stream' }));
  assert.equal(p.video.paused, true); assert.equal(p.video.src, ''); assert.equal(p.video.hidden, true);
  await p.poster.click(); assert.equal(p.video.src, '/prefix/changed/stream');
});

test('standard fullscreen, iOS fullscreen and a rejected request all have safe outcomes', async () => {
  const h = harness(), p = h.node('first');
  p.element.requestFullscreen = async () => { h.document.fullscreenElement = p.element; await h.document.emit('fullscreenchange'); };
  h.document.exitFullscreen = async () => { h.document.fullscreenElement = null; await h.document.emit('fullscreenchange'); };
  await p.fullscreen.click(); assert.equal(p.fullscreen.textContent, '退出全屏');
  await p.fullscreen.click(); assert.equal(p.fullscreen.textContent, '全屏');
  delete p.element.requestFullscreen; let nativeCalls = 0;
  p.video.webkitEnterFullscreen = () => { nativeCalls++; };
  await p.fullscreen.click(); assert.equal(nativeCalls, 1);
  p.element.requestFullscreen = async () => { throw new Error('unsupported'); };
  await p.fullscreen.click(); assert.match(h.notices[0], /视频播放器中的全屏按钮/);
  delete p.element.requestFullscreen; delete p.video.webkitEnterFullscreen;
  await p.fullscreen.click(); assert.equal(h.notices.length, 2);
});

test('ended videos replay from zero and releasing unused entries cleans up resources', async () => {
  const h = harness(), first = h.node('first'), second = h.node('second'); await first.poster.click();
  first.video.duration = 90; first.video.currentTime = 90; first.video.paused = true; first.video.ended = true;
  await first.video.emit('ended'); assert.equal(first.toggle.textContent, '重播');
  await first.toggle.click(); assert.equal(first.video.currentTime, 0);
  h.players.retain(['first']); assert.equal(second.video.loads, 1);
  assert.equal(h.players.get(file('first')), first.element);
  assert.equal(h.document.listeners.get('fullscreenchange').size, 1);
  h.players.destroy(); assert.equal(first.video.src, ''); assert.equal(first.video.paused, true);
  assert.equal(h.document.listeners.get('fullscreenchange').size, 0);
});


test('all output cards default muted and retain explicit unmute through refresh, seek and retry', async () => {
  const h = harness(), p = h.node('first'), second = h.node('second');
  for (const player of [p, second]) { assert.equal(player.video.defaultMuted, true); assert.equal(player.video.muted, true); }
  await p.poster.click(); p.video.muted = false;
  h.players.get(file('first', { filename: 'Updated title.mp4' })); assert.equal(p.video.muted, false);
  p.video.duration = 100; await p.video.emit('loadedmetadata'); await p.forward.click(); assert.equal(p.video.muted, false);
  await p.retry.click(); assert.equal(p.video.muted, false);
  h.players.get(file('first', { streamUrl: '/different/stream' })); assert.equal(p.video.muted, true);
  assert.equal(second.video.muted, true);
});

test('real stills load lazily without attaching a video source; refresh and failures stay playable', async () => {
  const h = harness(); const data = file('still', { thumbnailUrl: '/still?v=1' });
  const element = h.players.get(data), thumbnail = element.find(node => node.tagName === 'IMG');
  const video = element.find(node => node.tagName === 'VIDEO');
  assert.equal(thumbnail.loading, 'lazy'); assert.equal(thumbnail.src, '/prefix/still?v=1');
  assert.equal(video.src, ''); assert.equal(video.loads, 0); assert.equal(video.muted, true);
  await thumbnail.emit('load'); assert.equal(thumbnail.dataset.loaded, 'true');
  h.players.get(data); assert.equal(thumbnail.dataset.loaded, 'true');
  h.players.get({ ...data, thumbnailUrl: '/still?v=2' }); assert.equal(thumbnail.dataset.loaded, 'false');
  await thumbnail.emit('error'); assert.equal(thumbnail.dataset.loaded, 'false');
  assert.equal(element.find(node => node.className === 'output-poster-copy'), undefined);
  assert.equal(element.find(node => node.className === 'output-poster').getAttribute('aria-label'), '播放成片：Match still.mp4');
  await element.find(node => node.className === 'output-poster').click(); assert.equal(video.loads, 1);
});

test('collapse exits fullscreen before hiding controls and keeps exit available on failure', async () => {
  const h = harness(), p = h.node('collapse'); await p.poster.click();
  h.document.fullscreenElement = p.element; let exits = 0;
  h.document.exitFullscreen = async () => { exits++; assert.equal(p.element.dataset.expanded, 'true'); h.document.fullscreenElement = null; await h.document.emit('fullscreenchange'); };
  await p.collapse.click(); assert.equal(exits, 1); assert.equal(p.element.dataset.expanded, 'false'); assert.equal(p.video.paused, true);
  await p.poster.click(); h.document.fullscreenElement = p.element;
  h.document.exitFullscreen = async () => { throw new Error('denied'); };
  await p.collapse.click(); assert.equal(p.element.dataset.expanded, 'true'); assert.equal(p.collapse.disabled, false); assert.equal(p.video.paused, true); assert.match(h.notices.at(-1), /退出全屏/);
});
test('collapse invokes the native iOS fullscreen exit before hiding video', async () => {
  const h=harness(),p=h.node('ios');await p.poster.click();let exits=0;
  p.video.webkitDisplayingFullscreen=true;p.video.webkitExitFullscreen=()=>{exits++;p.video.webkitDisplayingFullscreen=false;};
  await p.collapse.click();assert.equal(exits,1);assert.equal(p.element.dataset.expanded,'false');
});

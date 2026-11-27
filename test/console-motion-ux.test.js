import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { iconSvg, setButtonIcon } from '../public/ui-primitives.js';
import { createReplayControls } from '../public/replay-controls.js';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : Boolean(force);
    if (next) this.set.add(name); else this.set.delete(name);
    return next;
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {
      props: {},
      setProperty(k, v) { this.props[k] = v; },
      removeProperty(k) { delete this.props[k]; },
    };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.offsetWidth = 100;
    this._hovered = false;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) {
    const e = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() {},
      ...event,
    };
    for (const fn of [...(this.listeners.get(type) || [])]) fn(e);
    return e;
  }
  contains(node) {
    if (!node) return false;
    return this === node || this.children.some(c => c.contains?.(node));
  }
  closest() { return null; }
  matches(selector) {
    if (selector === ':hover') return this._hovered;
    return false;
  }
  querySelector() { return null; }
  click() { this.emit('click', { detail: 1 }); }
}

function createFakeClock(start = 1_700_000_000_000) {
  let now = start, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, delay), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let next = null;
        for (const [id, entry] of timers) {
          if (entry.at <= target && (!next || entry.at < next.entry.at)) next = { id, entry };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.entry.at;
        next.entry.fn();
      }
      now = target;
    },
    get pending() { return timers.size; },
  };
}

test('P1: 双击普通态画面只进入沉浸全屏，不触发播放/暂停与 DVR HLS stop/start 副作用', () => {
  const clock = createFakeClock();
  const nodes = new Map([
    'view-replay', 'replay-control-panel', 'player-wrap', 'replay-player',
    'playback-tap-hud', 'replay-fullscreen', 'date-select', 'playback-source',
    'camera-select', 'dvr-select', 'dvr-channel',
  ].map(id => [id, new FakeElement()]));
  const view = nodes.get('view-replay');
  const topbar = new FakeElement();
  view.querySelector = sel => sel === '.replay-topbar' ? topbar : null;
  view.dataset.chromeOverlay = 'false';

  const wrap = nodes.get('player-wrap');
  const video = nodes.get('replay-player');
  video.hidden = false;
  video.paused = false;
  video.ended = false;
  wrap.append(video);

  let fullscreenClicks = 0, toggles = 0, hlsStops = 0, hlsStarts = 0;
  nodes.get('replay-fullscreen').addEventListener('click', () => { fullscreenClicks++; });

  const document = {
    body: { dataset: { view: 'replay' } },
    activeElement: null,
    hidden: false,
    addEventListener() {},
  };
  const window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
  };

  const context = vm.createContext({
    HTMLElement: FakeElement,
    document,
    window,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    $: id => nodes.get(id),
    iconSvg,
    createReplayControls,
    state: { dragging: false, holdSeek: null, playFormat: 'hls', hlsStopped: false, playBounds: { start: 0 } },
    activeDialog: null,
    syncReplayControls() {},
    toggleReplayPlayback() {
      toggles++;
      if (!video.paused) { hlsStops++; video.paused = true; }
      else { hlsStarts++; video.paused = false; }
    },
  });

  const start = script.indexOf('function setupReplayControls()');
  const end = script.indexOf('\nconst replayControls = setupReplayControls();');
  vm.runInContext(`${script.slice(start, end)}\nconst replayControls = setupReplayControls();`, context);

  // 1) 播放中的 DVR HLS：双击画面（click detail=1 -> 180ms 后 click detail=2 + dblclick）
  wrap.emit('click', { target: video, detail: 1 });
  clock.advance(180);
  wrap.emit('click', { target: video, detail: 2 });
  wrap.emit('dblclick', { target: video, detail: 2 });
  clock.advance(500);
  assert.equal(fullscreenClicks, 1, '双击应进入沉浸全屏');
  assert.equal(toggles, 0, '双击全屏不能触发播放/暂停切换');
  assert.equal(hlsStops, 0, '双击全屏不能触发 DVR HLS stop');
  assert.equal(hlsStarts, 0, '双击全屏不能触发 DVR HLS 重新启动');
  assert.equal(video.paused, false, '播放状态保持不变');

  // 2) 暂停态：双击画面进入沉浸全屏同样不误启动播放
  video.paused = true;
  wrap.emit('click', { target: video, detail: 1 });
  clock.advance(160);
  wrap.emit('click', { target: video, detail: 2 });
  wrap.emit('dblclick', { target: video, detail: 2 });
  clock.advance(500);
  assert.equal(fullscreenClicks, 2);
  assert.equal(toggles, 0, '暂停态双击不能误启动播放');
  assert.equal(video.paused, true);

  // 3) 280ms 之外（350ms）收到浏览器派发的 click(detail=2) + dblclick：不误进全屏，按两次独立单击处理
  video.paused = false;
  wrap.emit('click', { target: video, detail: 1 });
  clock.advance(350); // 超过 280ms，首击已提交暂停
  assert.equal(toggles, 1);
  assert.equal(video.paused, true);
  wrap.emit('click', { target: video, detail: 2 });
  wrap.emit('dblclick', { target: video, detail: 2 });
  assert.equal(fullscreenClicks, 2, '超窗后的原生 dblclick 不能在已提交单击后再进入全屏');
  clock.advance(280);
  assert.equal(toggles, 2, '第二击作为新的独立单击恢复播放');
  assert.equal(video.paused, false);

  // 暂停初始态同样在 350ms 慢双击下不误进全屏
  video.paused = true;
  wrap.emit('click', { target: video, detail: 1 });
  clock.advance(350);
  assert.equal(video.paused, false);
  wrap.emit('click', { target: video, detail: 2 });
  wrap.emit('dblclick', { target: video, detail: 2 });
  assert.equal(fullscreenClicks, 2, '暂停态超窗慢双击也不能再触发全屏');
  clock.advance(280);
  assert.equal(video.paused, true);

  // 4) 正常单击画面：经过区分窗口后正常切换播放/暂停并展示居中反馈
  const prevToggles = toggles;
  wrap.emit('click', { target: video, detail: 1 });
  assert.equal(toggles, prevToggles, '单击在确认窗口前暂不提交');
  clock.advance(280);
  assert.equal(toggles, prevToggles + 1, '单击在确认窗口后提交一次播放/暂停');
  assert.equal(nodes.get('playback-tap-hud').hidden, false);
  assert.equal(video.paused, false);
  clock.advance(500);
  assert.equal(nodes.get('playback-tap-hud').hidden, true);
});

test('P2: 时间尺边界处 HUD 只累加裁剪后的实际位移，零位移不累加', () => {
  const clock = createFakeClock();
  const nodes = new Map([
    'seek-hud', 'seek-hud-icon', 'seek-hud-value', 'replay-player',
  ].map(id => [id, new FakeElement()]));
  const video = nodes.get('replay-player');
  video.hidden = false; video.paused = true;

  const day = Date.parse('2026-11-27T00:00:00+08:00');
  const limit = day + 3600_000; // 01:00:00 上界
  const state = {
    previewMode: 'replay',
    date: '2026-11-27',
    segments: [{ start: day, end: limit }],
    cursorMs: limit - 2000, // 距上界仅 2 秒
    timelineStartMs: day,
    playRequestId: 1,
    holdSeek: null,
  };

  const context = vm.createContext({
    document: { body: { dataset: { view: 'replay' } } },
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    $: id => nodes.get(id),
    iconSvg,
    state,
    dateStart: () => day,
    timelineLimit: () => limit,
    playbackContextKey: () => 'ctx',
    syncPlaybackCursor() {},
    showScrubTime() {},
    fadeScrubTime() {},
    setTimelineWindow() {},
    renderTimeline() {},
    cancelReplayHold() {},
    tryBufferedReplaySeek: next => { state.cursorMs = next; return true; },
    jumpToTimelineTime: next => { state.cursorMs = next; },
    setPlaybackNotice() {},
  });

  const start = script.indexOf('let seekHudState =');
  const end = script.indexOf('\nfunction tryBufferedReplaySeek(');
  vm.runInContext(script.slice(start, end), context);

  // 单击：距上界 2 秒连续两次 +10 秒，游标移 2 秒，HUD 只显示 +2s
  context.stepReplay(10);
  assert.equal(state.cursorMs, limit);
  assert.equal(nodes.get('seek-hud-value').textContent, '+2s');
  clock.advance(100);
  context.stepReplay(10); // 已在边界，位移为 0
  assert.equal(state.cursorMs, limit);
  assert.equal(nodes.get('seek-hud-value').textContent, '+2s', '零位移不能继续累加 HUD');

  // 长按：距上界 5 秒连续三次 +10 秒，HUD 停在 +5s 不再增长
  clock.advance(1000);
  state.cursorMs = limit - 5000;
  const hold = context.beginReplayHold();
  context.repeatReplayHold(hold, 10);
  assert.equal(state.cursorMs, limit);
  assert.equal(nodes.get('seek-hud-value').textContent, '+5s');
  context.repeatReplayHold(hold, 10);
  context.repeatReplayHold(hold, 10);
  assert.equal(nodes.get('seek-hud-value').textContent, '+5s', '到边界后继续长按不能增长数字');
  context.commitReplayHold(hold);

  // 下界：距 00:00:00 仅 3 秒后退 -10 秒，HUD 显示 -3s
  clock.advance(1000);
  state.cursorMs = day + 3000;
  context.stepReplay(-10);
  assert.equal(state.cursorMs, day);
  assert.equal(nodes.get('seek-hud-value').textContent, '-3s');
  clock.advance(100);
  context.stepReplay(-10);
  assert.equal(nodes.get('seek-hud-value').textContent, '-3s');
});

test('P3: Toast 悬停与键盘聚焦同步暂停剩余时长与倒计时状态，移开后走完剩余时间', () => {
  const clock = createFakeClock();
  const toast = new FakeElement();
  const document = {
    activeElement: null,
    createElement: tag => new FakeElement(tag),
  };

  const context = vm.createContext({
    document,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    $: id => id === 'toast' ? toast : null,
    iconSvg,
    setButtonIcon,
    openTaskPage() {},
  });

  const start = script.indexOf('function notify(');
  const end = script.indexOf('\nasync function api(');
  vm.runInContext(`let toastTimer;\n${script.slice(start, end)}`, context);

  // 1) 第 1 秒悬停、第 2 秒移开：剩 2 秒，第 3 秒仍在显示，第 4 秒精准关闭
  context.notify('已加入导出队列', false, { kind: 'exports', range: '08:00:00–08:01:00' });
  assert.equal(toast.hidden, false);
  assert.equal(toast.classList.contains('toast-paused'), false);

  clock.advance(1000); // 已走 1s，剩 2s
  toast._hovered = true;
  toast.emit('pointerenter');
  assert.equal(toast.classList.contains('toast-paused'), true);

  clock.advance(1000); // 悬停 1s，时间来到 2s，但剩余仍为 2s
  toast._hovered = false;
  toast.emit('pointerleave');
  assert.equal(toast.classList.contains('toast-paused'), false);

  clock.advance(1500); // 时间来到 3.5s（移开后 1.5s），应仍显示
  assert.equal(toast.hidden, false, '移开后未走完剩余 2s 前不应提前关闭');

  clock.advance(500); // 移开后满 2s，精准关闭
  assert.equal(toast.hidden, true, '走完剩余 2s 后应关闭');

  // 2) 键盘聚焦暂停：悬停移开但焦点仍在内部时继续暂停，焦点移出后再走完剩余时长
  context.notify('已加入上传队列', false, { kind: 'uploads', range: 'demo.mp4' });
  const linkButton = toast.children.find(c => c.className === 'toast-task-link');
  clock.advance(1200); // 剩 1800ms
  toast._hovered = true;
  toast.emit('pointerenter');
  document.activeElement = linkButton;
  toast.emit('focusin');
  clock.advance(2000);
  toast._hovered = false;
  toast.emit('pointerleave');
  assert.equal(toast.classList.contains('toast-paused'), true, '焦点仍在内时保持暂停');
  clock.advance(2000);
  assert.equal(toast.hidden, false, '聚焦期间不关闭');

  document.activeElement = null;
  toast.emit('focusout', { relatedTarget: null });
  assert.equal(toast.classList.contains('toast-paused'), false);
  clock.advance(1700);
  assert.equal(toast.hidden, false);
  clock.advance(100);
  assert.equal(toast.hidden, true, '焦点移出后走完剩余 1800ms 精准关闭');
});

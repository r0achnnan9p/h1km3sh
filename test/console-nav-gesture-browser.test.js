// 真实浏览器手势回归：用本地合成 fixture（127.0.0.1、仅内存）+ Chrome DevTools Protocol 合成 touch/key 序列。
// 不连接真实设备、账号或视频流。找不到 Chromium 系浏览器时相关用例显式 skip（不做假模拟），skip 即表示未验证。
// 边界：这里验证的是 Chromium 对 touch-action 的实现，不是 iOS Safari；iOS 真机仍需单独验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createConsoleFixture } from '../scripts/console-fixture.js';
import express from 'express';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome = candidates.find(file => fs.existsSync(file));
const needChrome = !chrome && '未找到 Chrome/Edge（可设置 CHROME_PATH）；该用例未验证';
// 单条用例的整体期限，避免挂死的浏览器阻塞 node --test。
const CASE_TIMEOUT = 120_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// 资源栈：取得一个就登记一个，按相反顺序清理；某项清理失败不影响其余项，最后汇总抛出。
function createResources() {
  const stack = [];
  return {
    add(label, fn) { stack.push({ label, fn }); },
    async closeAll() {
      const errors = [];
      while (stack.length) {
        const { label, fn } = stack.pop();
        try { await fn(); } catch (error) { errors.push(`${label}: ${error.message}`); }
      }
      if (errors.length) throw new Error(`资源清理失败：${errors.join('；')}`);
    },
  };
}

// CDP 请求层：每个请求有期限；连接关闭/出错时拒绝并清掉全部 pending。
function createCdp(ws, { requestTimeout = 15_000 } = {}) {
  let id = 0, closed = null;
  const pending = new Map();
  const failAll = error => {
    closed ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  ws.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    const entry = message.id && pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  ws.addEventListener('close', () => failAll(new Error('CDP WebSocket 已关闭')));
  ws.addEventListener('error', () => failAll(new Error('CDP WebSocket 出错')));
  const send = (method, params = {}, timeout = requestTimeout) => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP ${method} 超时（${timeout}ms）`)); }, timeout);
    pending.set(key, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: key, method, params })); } catch (error) { clearTimeout(timer); pending.delete(key); reject(error); }
  });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  };
  return { send, evaluate, pendingCount: () => pending.size };
}

const exitedNow = child => child.exitCode !== null || child.signalCode !== null;
async function waitExit(exited, ms) {
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([exited.then(() => true), limit]).finally(() => clearTimeout(timer));
}
// 先请求浏览器自行关闭，再 terminate，最后强杀；每一步都等待真实 exit 事件。
async function stopChild(child, exited, holder) {
  if (exitedNow(child)) return;
  try { if (holder.cdp) await holder.cdp.send('Browser.close', {}, 2000); } catch { /* 连接可能已断，继续升级 */ }
  if (await waitExit(exited, 3000)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill();
  if (await waitExit(exited, 3000)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
  if (!(await waitExit(exited, 5000))) throw new Error(`浏览器进程 ${child.pid} 未能退出`);
}
async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  try { ws.close(); } catch { return; }
  await withTimeout(closed, 3000, 'WebSocket 关闭');
}
const removeDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// 启动浏览器。任何阶段失败都在本函数内清理已取得的 profile/子进程/WebSocket 后再抛出；成功后把清理登记到 res。
// fault(stage, ctx) 仅供回归测试注入故障。
async function launch(res, { chromePath = chrome, args = [], fault, launchTimeout = 20_000, connectTimeout = 10_000, requestTimeout } = {}) {
  const own = createResources(), holder = {};
  try {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-gesture-'));
    own.add('profile', () => removeDir(profile));
    const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...args, 'about:blank'], { stdio: 'ignore' });
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    own.add('browser process', () => stopChild(child, exited, holder));
    const ctx = { child, profile, ws: null };
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + launchTimeout;
    let port;
    for (;;) {
      if (spawnError) throw new Error(`浏览器无法启动：${spawnError.message}`);
      if (exitedNow(child)) throw new Error(`浏览器在启动阶段退出（code=${child.exitCode}, signal=${child.signalCode}）`);
      if (fs.existsSync(portFile)) { port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]); if (Number.isInteger(port) && port > 0) break; }
      if (Date.now() > deadline) throw new Error(`浏览器启动超时（${launchTimeout}ms）`);
      await sleep(50);
    }
    await fault?.('child', ctx);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ctx.ws = ws;
    own.add('websocket', async () => { try { await stopChild(child, exited, holder); } finally { await closeSocket(ws); } });
    await withTimeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
      ws.addEventListener('close', () => reject(new Error('CDP WebSocket 在连接阶段关闭')), { once: true });
    }), connectTimeout, 'CDP WebSocket 连接');
    const cdp = createCdp(ws, { requestTimeout });
    holder.cdp = cdp;
    await fault?.('websocket', ctx);
    res.add('browser', () => own.closeAll());
    return { send: cdp.send, evaluate: cdp.evaluate, pendingCount: cdp.pendingCount, child, profile, ws, exited };
  } catch (error) {
    try { await own.closeAll(); } catch (cleanup) { error.message += `；另外 ${cleanup.message}`; }
    throw error;
  }
}

async function startFixture(res, { cssOverride } = {}) {
  const fixture = createConsoleFixture({ taskStepMs: 60_000 });
  res.add('fixture', () => fixture.close());
  const app = cssOverride ? express().get('/console.css', (req, res) => res.type('css').send(cssOverride)).use(fixture.app) : fixture.app;
  const server = await withTimeout(new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject); }), 10_000, 'fixture 监听');
  res.add('fixture server', () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }));
  return server;
}

const touch = (b, type, points) => b.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
// 合成一次拖动：starts 为各指起点，dx/dy 为总位移，steps 步，每步间隔让合成器有时间决定是否接管滚动。
async function drag(b, starts, dx, dy, { steps = 12 } = {}) {
  await touch(b, 'touchStart', starts);
  for (let i = 1; i <= steps; i++) { await touch(b, 'touchMove', starts.map(p => ({ x: p.x + dx * i / steps, y: p.y + dy * i / steps }))); await sleep(16); }
  await touch(b, 'touchEnd', []);
  await sleep(250);
}
const tap = async (b, point) => { await touch(b, 'touchStart', [point]); await sleep(40); await touch(b, 'touchEnd', []); await sleep(200); };
const scrollY = b => b.evaluate('Math.round(window.scrollY)');
const contentScrollY = b => b.evaluate("Math.round(document.querySelector('.workspace-main').scrollTop)");
const center = (b, selector) => b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const navState = b => b.evaluate(`({ clicks: __nav.clicks, view: document.querySelector('.mobile-nav button.active')?.dataset.view, scrollY: Math.round(scrollY), contentY: Math.round(document.querySelector('.workspace-main').scrollTop) })`);
// 导航起点的拖动：逐次保存拖动前的 click 数与激活视图，拖动后断言没有误点击、没有切换、背景没滚。
async function navDrag(b, label, starts, dx, dy, options) {
  const before = await navState(b);
  await drag(b, starts, dx, dy, options);
  const after = await navState(b);
  assert.equal(after.clicks, before.clicks, `${label}：不应产生 click`);
  assert.equal(after.view, before.view, `${label}：激活视图不应变化`);
  assert.equal(after.scrollY, before.scrollY, `${label}：背景不应滚动`);
  assert.equal(after.contentY, before.contentY, `${label}：导航不能带动内容滚动`);
}

async function setup(t, { forceAuto = false } = {}) {
  const res = createResources();
  t.after(() => res.closeAll()); // 先登记，之后任一步 await 失败也会清理已取得的资源
  const server = await startFixture(res);
  const b = await launch(res);
  await b.send('Page.enable'); await b.send('Runtime.enable');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 520, deviceScaleFactor: 2, mobile: true });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?fixture=normal#replay` });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { ready = await b.evaluate(`!!document.querySelector('.mobile-nav button[data-view]') && document.readyState === 'complete'`); if (!ready) await sleep(100); }
  assert.ok(ready, '页面应在期限内加载完成');
  await sleep(600);
  if (forceAuto) await b.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '.mobile-nav, .mobile-nav * { touch-action: auto !important; }'; document.head.append(s); })()`);
  await b.evaluate(`window.__nav = { cancel: 0, up: 0, clicks: 0 }; const nav = document.querySelector('.mobile-nav'); nav.addEventListener('pointercancel', () => __nav.cancel++); nav.addEventListener('pointerup', () => __nav.up++); nav.addEventListener('click', () => __nav.clicks++);`);
  const metrics = await b.evaluate(`({ scrollHeight: document.querySelector('.workspace-main').scrollHeight, inner: document.querySelector('.workspace-main').clientHeight, nav: getComputedStyle(document.querySelector('.mobile-nav')).display })`);
  assert.equal(metrics.nav, 'grid', '窄屏下必须显示底部导航');
  assert.ok(metrics.scrollHeight > metrics.inner + 80, `前置条件：页面必须可滚动才能测试背景 pan（scrollHeight=${metrics.scrollHeight}, inner=${metrics.inner}）`);
  return b;
}
const navButton = view => `.mobile-nav button[data-view="${view}"]`;
const activeView = b => b.evaluate(`document.querySelector('.mobile-nav button.active')?.dataset.view`);

test('对照：内容区起点的触摸拖动仍然滚动页面', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  await drag(b, [{ x: 195, y: 330 }], 0, -200);
  assert.ok(await contentScrollY(b) > 40, '内容区拖动应带动页面滚动');
  assert.equal(await scrollY(b), 0, '根页面不能跟随内容拖动');
});

test('从导航起点的拖动不滚动背景、不误点击：短拖、长距离、下拉、拖出按钮后松手、双指', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  const nav = await center(b, navButton('library'));
  const other = await center(b, navButton('settings'));
  await navDrag(b, '短拖', [nav], 0, -150);
  await navDrag(b, '长距离拖动', [nav], 0, -450, { steps: 40 });
  await navDrag(b, '向下拖动', [nav], 0, 200);
  await navDrag(b, '拖出按钮后松手', [nav], 0, -300);
  await navDrag(b, '双指', [nav, other], 0, -250);
  await drag(b, [{ x: 195, y: 330 }], 0, -200);
  assert.ok(await contentScrollY(b) > 40, '之后内容区拖动仍能滚动（导航未造成永久锁定）');
});

test('原生点击与键盘：触摸点按、Enter、Space 都能切换视图，且不丢 pointer 事件', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  const views = await b.evaluate(`[...document.querySelectorAll('.mobile-nav button[data-view]')].map(x => x.dataset.view)`);
  assert.equal(views.length, 4);
  await tap(b, await center(b, navButton(views[3])));
  assert.equal(await activeView(b), views[3], '触摸松开应切换到目标页');
  assert.equal(await b.evaluate('__nav.clicks'), 0, '兼容 click 已抑制，不能重复激活');
  for (const [view, key, code, text] of [[views[1], 'Enter', 'Enter', '\r'], [views[2], ' ', 'Space', ' ']]) {
    await b.evaluate(`document.querySelector(${JSON.stringify(navButton(view))}).focus()`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
    await sleep(200);
    assert.equal(await activeView(b), view, `${code} 应激活聚焦的导航按钮`);
  }
  const { cancel, up } = await b.evaluate('__nav');
  assert.equal(cancel, 0, '正常点按不应产生 pointercancel');
  assert.ok(up >= 1);
});

test('导航即使允许原生平移，也不能滚动兄弟内容区或根页面', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t, { forceAuto: true });
  await drag(b, [await center(b, navButton('library'))], 0, -200);
  assert.equal(await scrollY(b), 0);
  assert.equal(await contentScrollY(b), 0);
});

// ---- 测试基础设施自身的回归：超时/断连/清理 ----
class FakeSocket extends EventTarget {
  static CLOSED = 3;
  readyState = 1; sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('基础设施：WebSocket 断开时所有 pending 请求在有限时间内拒绝并清空', async () => {
  const ws = new FakeSocket(), cdp = createCdp(ws, { requestTimeout: 60_000 });
  const first = cdp.send('A'), second = cdp.send('B');
  assert.equal(cdp.pendingCount(), 2);
  const started = Date.now();
  ws.close();
  await assert.rejects(first, /已关闭/); await assert.rejects(second, /已关闭/);
  assert.ok(Date.now() - started < 1000, 'pending 应立即拒绝，而不是等待 60s 请求期限');
  assert.equal(cdp.pendingCount(), 0);
  await assert.rejects(cdp.send('C'), /已关闭/, '断开后的新请求直接拒绝');
});

test('基础设施：WebSocket error 拒绝 pending；请求超时会删除 map 项', async () => {
  const ws = new FakeSocket(), cdp = createCdp(ws, { requestTimeout: 60_000 });
  const slow = cdp.send('Slow', {}, 50);
  await assert.rejects(slow, /超时/);
  assert.equal(cdp.pendingCount(), 0, '超时后不应残留 pending');
  const pending = cdp.send('B');
  ws.dispatchEvent(new Event('error'));
  await assert.rejects(pending, /出错/);
  assert.equal(cdp.pendingCount(), 0);
});

test('基础设施：资源清理逆序执行，单项失败不阻断其余项，并汇总报错', async () => {
  const order = [], res = createResources();
  res.add('first', () => order.push('first'));
  res.add('broken', () => { throw new Error('boom'); });
  res.add('last', () => order.push('last'));
  await assert.rejects(res.closeAll(), /broken: boom/);
  assert.deepEqual(order, ['last', 'first']);
});

test('基础设施：浏览器无法启动或启动即退出时有限时间内失败，并清理 profile', async t => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('nav-gesture-')));
  const leaked = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('nav-gesture-') && !before.has(name));
  const res = createResources();
  t.after(() => res.closeAll());
  await assert.rejects(withTimeout(launch(res, { chromePath: path.join(os.tmpdir(), 'no-such-browser-binary.exe') }), 15_000, 'launch(不存在的浏览器)'), /无法启动|启动阶段退出/);
  // node 遇到未知选项会立即以非零码退出，模拟异常退出
  await assert.rejects(withTimeout(launch(res, { chromePath: process.execPath }), 15_000, 'launch(立即退出)'), /启动阶段退出/);
  assert.deepEqual(leaked(), [], '失败的 launch 不应遗留 profile 目录');
});

test('基础设施：launch 部分初始化失败（子进程已起/WebSocket 已连）时清理子进程、socket、profile 与 fixture server', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  for (const stage of ['child', 'websocket']) {
    const res = createResources();
    t.after(() => res.closeAll()); // closeAll 会清空资源栈，与下面的显式关闭重复调用是安全的
    let seen;
    const server = await startFixture(res);
    const port = server.address().port;
    await assert.rejects(launch(res, { fault: (current, ctx) => { if (current === stage) { seen = ctx; throw new Error(`注入故障:${stage}`); } } }), new RegExp(`注入故障:${stage}`));
    assert.ok(exitedNow(seen.child), `${stage}：Chrome 子进程应已退出`);
    assert.equal(fs.existsSync(seen.profile), false, `${stage}：profile 应已删除`);
    if (seen.ws) assert.equal(seen.ws.readyState, WebSocket.CLOSED, `${stage}：WebSocket 应已关闭`);
    await res.closeAll();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }), `${stage}：fixture server 应已关闭`);
  }
});

test('基础设施：浏览器异常退出时 pending CDP 请求有限时间内拒绝，清理后进程与 profile 均已消失', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const res = createResources();
  t.after(() => res.closeAll());
  const b = await launch(res, { requestTimeout: 60_000 });
  await b.send('Runtime.enable');
  const hanging = b.evaluate('new Promise(() => {})'); // 永不返回，模拟被浏览器吞掉的请求
  hanging.catch(() => {});
  await sleep(200);
  assert.equal(b.pendingCount(), 1);
  const started = Date.now();
  b.child.kill(); // 突然终止浏览器，WebSocket 随之断开
  await assert.rejects(withTimeout(hanging, 15_000, '断连后 pending 拒绝'), /已关闭|出错/);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(b.pendingCount(), 0);
  await res.closeAll();
  assert.ok(exitedNow(b.child), '浏览器进程应已退出');
  assert.equal(fs.existsSync(b.profile), false, 'profile 应已删除');
});

test('standalone viewport geometry remains visible during resize and stable during routes, dates and video states', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const res = createResources();
  t.after(() => res.closeAll());
  const server = await startFixture(res), b = await launch(res);
  const errors = [];
  b.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  await b.send('Page.enable'); await b.send('Runtime.enable');
  // Model a full backing screen whose layout viewport temporarily loses the
  // status-bar inset. These are synthetic dimensions, not an iPhone emulator.
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const apply = () => {
      if (!document.documentElement) return;
      document.documentElement.style.setProperty('--safe-top', '59px');
      document.documentElement.style.setProperty('--safe-bottom', '34px');
      observer.disconnect();
    };
    const observer = new MutationObserver(apply); observer.observe(document, { childList: true, subtree: true }); apply();
  ` });
  const device = async (width, height, screenHeight = 932) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight, deviceScaleFactor: 1, mobile: true });
    await sleep(100);
  };
  const geometry = () => b.evaluate(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
    return { innerHeight, clientHeight:document.documentElement.clientHeight, screenHeight:screen.height, scrollY,
      visualHeight:visualViewport.height, scale:visualViewport.scale, offsetTop:visualViewport.offsetTop,
      buttons:[...document.querySelectorAll('.mobile-nav button')].map(button => {const r=button.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}), safeBottom:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0,
      nav:rect('.mobile-nav'), video:rect('#player-wrap'), header:rect('.replay-heading'),
      timeline:rect('.timeline-section'), export:rect('.selection-panel') };
  })()`);
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (await b.evaluate(`document.body.dataset.view === 'replay' && !document.getElementById('console-shell').hidden`)) return;
      await sleep(100);
    }
    throw new Error('Fixture did not become ready');
  };
  const stable = (before, after, label, elements = ['nav', 'video', 'header', 'timeline', 'export']) => {
    for (const element of elements) {
      assert.deepEqual(after[element], before[element], label + ': ' + element);
    }
    assert.equal(after.scale, 1, label + ': page scale');
    assert.equal(after.scrollY, 0, label + ': page scroll');
  };
  const visible = (g, label) => {
    const top=g.offsetTop, bottom=top+g.visualHeight;
    assert.ok(g.nav.y >= top, label + ': nav top visible');
    assert.ok(g.nav.y+g.nav.height <= bottom+0.5, label + ': 通栏底条包含安全区且不超出屏幕');
    assert.equal(g.nav.height,64+g.safeBottom,label + ': 安全区只增加底条背景高度');
    assert.equal(g.nav.x,0,label + ': 底条从屏幕左缘开始');
    for(const button of g.buttons) {
      assert.ok(button.width >= 44 && button.height >= 44, label + ': complete 44px target');
      assert.ok(button.y >= top && button.y+button.height <= bottom-g.safeBottom, label + ': 按钮完整显示且避开底部安全区');
    }
  };
  await device(430, 873);
  await b.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?fixture=normal#replay` });
  await ready(); await sleep(200);
  await b.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  for(let i=0;i<5;i++) await tap(b, await center(b, '#app-title'));
  await sleep(100);
  assert.equal(await b.evaluate(`!!document.getElementById('debug-mark-viewport')`),true,'five real touch taps on the app title open viewport HUD without occupying the time editor');
  // Counterfactual: preserve the original CSS to prove the reported signature
  // is caused by viewport geometry even with no date/range/route change.
  await b.evaluate(`const control = document.createElement('style'); control.id = 'geometry-control'; control.textContent =
    '.mobile-nav { top:auto !important; height:64px !important; padding:8px !important; bottom:calc(10px + var(--safe-bottom)) !important; }' +
    '#view-replay .player-wrap { height:clamp(150px,calc(100dvh - var(--safe-top) - var(--safe-bottom) - 620px),300px) !important; }'; document.head.append(control);`);
  const oldShort = await geometry(); await device(430, 932); const oldFull = await geometry();
  assert.equal(oldFull.nav.y - oldShort.nav.y, 59, 'original nav follows the status-bar-sized viewport change');
  assert.equal(oldFull.video.height - oldShort.video.height, 59, 'original video grows by the same amount');
  await b.evaluate(`document.getElementById('geometry-control').remove()`);
  const evidence = [{ state:'original-short', ...oldShort }, { state:'original-full', ...oldFull }];
  for (const width of [320, 375, 390, 430]) {
    await device(width, 873);
    const before = await geometry();
    visible(before, width + ': short');
    assert.equal(before.nav.y + before.nav.height, 873);
    await device(width, 932);
    const full = await geometry(); visible(full, width + ': full');
    assert.equal(full.nav.y - before.nav.y, 59, 'real visible area growth moves nav to its new safe edge');
    assert.equal(full.video.height, before.video.height, 'video keeps its aspect ratio instead of shrinking for controls or height reports');
    await device(width, 873); stable(before, await geometry(), width + ': restore short');
    for (const view of ['library', 'tasks', 'settings', 'replay']) {
      await b.evaluate(`document.querySelector('.mobile-nav button[data-view="${view}"]').click()`); await sleep(100);
      assert.deepEqual((await geometry()).nav, before.nav, width + ': route ' + view);
    }
    stable(before, await geometry(), width + ': replay return');
    for (const span of [300, 86400]) {
      await b.evaluate(`document.querySelector('[data-timeline-span="${span}"]').click()`); await sleep(100);
      stable(before, await geometry(), width + ': timeline span ' + span);
    }
    for (const date of ['2026-10-07', '2026-10-06']) {
      await b.evaluate(`(() => { const input = document.getElementById('date-select'); input.value = '${date}'; input.dispatchEvent(new Event('change', { bubbles:true })); })()`);
      await sleep(100); stable(before, await geometry(), width + ': date ' + date);
    }
    evidence.push({ state:'fixed-' + width, ...await geometry() });
  }
  const beforeVideo = await geometry();
  await b.evaluate(`(async () => {
    const video = document.getElementById('replay-player'), canvas = document.createElement('canvas'); canvas.width=160; canvas.height=90;
    const stream = canvas.captureStream(0); video.srcObject=stream; video.muted=true; video.hidden=false;
    canvas.getContext('2d').fillRect(0,0,160,90); stream.getVideoTracks()[0].requestFrame(); void video.play().catch(() => {});
  })()`);
  for(let i=0;i<40 && await b.evaluate(`document.getElementById('replay-player').videoWidth`) !== 160;i++) await sleep(50);
  assert.equal(await b.evaluate(`document.getElementById('replay-player').videoWidth`), 160, 'synthetic video metadata really loaded');
  // Playback controls legitimately appear when media loads; the viewport anchors must stay put.
  stable(beforeVideo, await geometry(), 'loaded synthetic video', ['nav','video','header']);
  assert.equal((await geometry()).timeline.y, beforeVideo.timeline.y);
  await b.evaluate(`const video=document.getElementById('replay-player'); video.srcObject.getTracks().forEach(track=>track.stop()); video.srcObject=null; video.removeAttribute('src'); video.load();`);
  await sleep(100); stable(beforeVideo, await geometry(), 'empty video', ['nav','video','header']);
  await device(430, 800);
  visible(await geometry(), '800px real resize');
  assert.equal((await geometry()).nav.y + 64 + 34, 800, 'an unrelated height resize is not frozen');
  // Synthetic visual-only resize and offset: layout stays 932px. The actual
  // visualViewport fields are overridden solely to exercise offset handling.
  await device(430, 932);
  for (const [height, offsetTop] of [[873,0], [800,30], [700,80]]) {
    await b.evaluate(`Object.defineProperties(visualViewport,{height:{configurable:true,value:${height}},offsetTop:{configurable:true,value:${offsetTop}}});visualViewport.dispatchEvent(new Event('scroll'));`);
    await sleep(100); const g=await geometry();
    assert.equal(g.nav.y+g.nav.height, 932, 'keyboard visual reports cannot add status-bar padding to shell navigation');
    const snapshot=await b.evaluate(`JSON.parse(document.getElementById('debug-mark-viewport').textContent.split('\\n')[0].slice(9))`);
    assert.equal(snapshot.visual[1],height,'real browser HUD shows visual height');
    assert.equal(snapshot.visual[3],offsetTop,'real browser HUD shows offset');
    assert.equal(snapshot.nav[1],g.nav.y,'HUD measures nav after layout frame');
    evidence.push({state:'visual-offset-'+offsetTop,...g});
  }
  await b.evaluate(`delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));`);
  await sleep(100); visible(await geometry(), 'visual viewport restored');
  // Model inconsistent JS viewport reports while the CSS viewport stays fixed.
  // This verifies removal of double compensation, not iOS rendering itself.
  await device(430, 932);
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="library"]').click();document.querySelector('.mobile-nav button[data-view="replay"]').click()`);
  await sleep(100); const layoutBound = await geometry();
  await b.evaluate(`window.__originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')`);
  await b.evaluate(`Object.defineProperty(document.documentElement,'clientHeight',{configurable:true,value:873});Object.defineProperty(window,'innerHeight',{configurable:true,value:873});Object.defineProperty(visualViewport,'height',{configurable:true,value:873});window.dispatchEvent(new Event('resize'));`);
  try {
    await sleep(100); stable(layoutBound, await geometry(), 'short reported viewport with fixed shell');
    await b.evaluate(`Object.defineProperty(window,'innerHeight',{configurable:true,value:932});Object.defineProperty(visualViewport,'height',{configurable:true,value:932});window.dispatchEvent(new Event('resize'));`);
    await sleep(100); stable(layoutBound, await geometry(), 'expanded report without extra nav inset');
    for (const view of ['library', 'tasks', 'settings', 'replay']) {
      await b.evaluate(`document.querySelector('.mobile-nav button[data-view="${view}"]').click()`); await sleep(100);
      assert.deepEqual((await geometry()).nav, layoutBound.nav, 'fixed-shell route '+view);
    }
  } finally {
    await b.evaluate(`Object.defineProperty(window,'innerHeight',window.__originalInnerHeight);delete window.__originalInnerHeight;delete document.documentElement.clientHeight;delete visualViewport.height;window.dispatchEvent(new Event('resize'))`);
  }
  await device(430, 932);
  for(const [safeTop,safeBottom] of [[0,0],[20,21],[59,34]]) {
    await b.evaluate(`document.documentElement.style.setProperty('--safe-top','${safeTop}px');document.documentElement.style.setProperty('--safe-bottom','${safeBottom}px');`);
    await sleep(100); visible(await geometry(),'safe area '+safeTop+'/'+safeBottom);
  }
  await b.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await b.evaluate(`document.querySelector('.views').style.minHeight='1800px'`);
  await drag(b,[{x:215,y:730}],0,-250);
  assert.ok(await b.evaluate(`document.querySelector('.workspace-main').scrollTop>40`),'standalone content-origin gesture scrolls the inner workspace');
  assert.equal(await b.evaluate(`document.querySelector('.mobile-nav').offsetParent.id`), 'console-shell', 'installed navigation is actually anchored to the fixed shell');
  assert.equal(await scrollY(b),0,'the outer page stays fixed');
  visible(await geometry(),'after content scroll');
  await b.evaluate(`document.querySelector('.views').style.minHeight='';document.querySelector('.workspace-main').scrollTop=0;window.scrollTo(0,0)`);
  await device(700,430,430);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.mobile-nav')).display`),'none','existing immersive replay landscape still hides nav');
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="library"]').click()`); await sleep(100);
  visible(await geometry(),'library mobile landscape');
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="replay"]').click()`); await sleep(100);
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-viewport')`),true,'narrow landscape also follows visible nav bounds');
  await device(430,932);
  await b.send('Runtime.evaluate',{expression:`document.getElementById('replay-fullscreen').click()`,userGesture:true,awaitPromise:true});
  await sleep(100);
  for(let i=0;i<40 && !await b.evaluate(`!!document.fullscreenElement`);i++) await sleep(50);
  assert.equal(await b.evaluate(`!!document.fullscreenElement`),true,'browser really entered fullscreen');
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-viewport')`),false,'native fullscreen releases viewport override');
  await b.evaluate(`document.exitFullscreen()`); await sleep(100);
  visible(await geometry(),'fullscreen exit');
  await device(932, 430, 430);
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-viewport')`), true, 'wide iPhone landscape retains the standalone height baseline');
  await device(430, 932);
  await b.evaluate(`Object.defineProperty(navigator,'standalone',{configurable:true,value:false}); window.dispatchEvent(new Event('resize'));`);
  await device(430, 873);
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-viewport')`), false, 'ordinary Safari remains on native viewport geometry');
  assert.equal((await geometry()).nav.y + 64 + 34, 873);
  for (const width of [1024, 1440, 1920]) {
    await device(width, 1080, 1080);
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.mobile-nav')).display`), 'none', 'desktop retains its own navigation');
    assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-viewport')`), false);
  }
  assert.deepEqual(errors, [], 'fixture has no uncaught browser exceptions');
  t.diagnostic(JSON.stringify({ engine:'Chromium; synthetic standalone geometry, not iOS acceptance', evidence }));
});


test('settings modal scrolls its content without moving the page and restores focus and scroll after close', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="settings"]').click(); document.getElementById('view-settings').style.minHeight='2000px'; document.querySelector('.workspace-main').scrollTop=150`);
  await sleep(200);
  const originalY = await contentScrollY(b); assert.ok(originalY > 100, 'fixture page must have a scroll position to preserve');
  await b.evaluate(`document.getElementById('settings-open-bilibili').focus({preventScroll:true})`);
  await tap(b, await center(b, '#settings-open-bilibili'));
  const opened = await b.evaluate(`(() => { const d=document.querySelector('dialog[open]'); return {open:!!d,locked:document.documentElement.classList.contains('dialog-scroll-locked'),focus:document.activeElement.tagName,footer:getComputedStyle(d.querySelector('.dialog-actions')).backgroundColor,closeBorder:getComputedStyle(d.querySelector('.dialog-close')).borderTopWidth,refreshBackground:getComputedStyle(d.querySelector('.dialog-actions .ui-icon-button')).backgroundColor}; })()`);
  assert.deepEqual(opened, { open: true, locked: true, focus: 'H2', footer: 'rgba(0, 0, 0, 0)', closeBorder: '0px', refreshBackground: 'rgba(0, 0, 0, 0)' });
  await b.evaluate(`(() => {const n=document.createElement('div');n.style.height='1200px';n.textContent='合成长内容';document.querySelector('dialog[open] .dialog-body').prepend(n);})()`);
  const backgroundY = await contentScrollY(b);
  await drag(b, [{ x: 4, y: 600 }], 0, -160); assert.equal(await contentScrollY(b), backgroundY, 'dragging outside the modal must not pan background');
  await drag(b, [{ x: 200, y: 600 }], 0, -200);
  assert.ok(await b.evaluate(`document.querySelector('dialog[open]').scrollTop > 20`), 'content drag must scroll the dialog');
  assert.equal(await contentScrollY(b), backgroundY);
  await b.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await b.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await sleep(200);
  assert.equal(await contentScrollY(b), originalY);
  assert.equal(await scrollY(b), 0, 'document remains stationary');
  assert.deepEqual(await b.evaluate(`({open:!!document.querySelector('dialog[open]'),locked:document.documentElement.classList.contains('dialog-scroll-locked'),focus:document.activeElement.id})`), {open:false,locked:false,focus:'settings-open-bilibili'});
});

test('transport SVGs retain visible strokes and 26px size across the responsive cascade', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  for (const [width,height] of [[320,740],[430,932],[667,375],[1440,900]]) {
    await b.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<1024});
    for (const playing of [false,true]) {
      const icons = await b.evaluate(`(() => {
        const toggle=document.getElementById('playback-toggle');toggle.hidden=false;toggle.setAttribute('aria-pressed','${playing}');
        return ['skip-back','playback-toggle','skip-forward'].map(id => {
          const button=document.getElementById(id);button.hidden=false;
          const svg=button.querySelector(id==='playback-toggle' ? '${playing ? '.pause-mark' : '.play-mark'} svg' : 'svg');
          const r=svg.getBoundingClientRect(),s=getComputedStyle(svg.querySelector('path'));
          return {id,width:r.width,height:r.height,stroke:s.stroke,fill:s.fill,strokeWidth:parseFloat(s.strokeWidth)};
        });
      })()`);
      for(const icon of icons) {
        assert.equal(icon.width,26,`${width} ${icon.id} width`);assert.equal(icon.height,26);
        assert.ok(icon.stroke !== 'none' && icon.strokeWidth >= 1.8 || icon.fill !== 'none', '描边或填充图标必须实际可见');
      }
    }
  }
});

test('one held touch slides the navigation indicator and activates only its final tab', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t), first = await center(b, navButton('replay')), last = await center(b, navButton('settings'));
  const before = await scrollY(b);
  await touch(b, 'touchStart', [first]);
  for (let step = 1; step <= 8; step++) { await touch(b, 'touchMove', [{ x:first.x+(last.x-first.x)*step/8, y:first.y }]); await sleep(30); }
  assert.equal(await activeView(b), 'replay', 'moving the highlight must not repeatedly open intermediate pages');
  assert.equal(await b.evaluate(`document.querySelector('.mobile-nav .drag-target')?.dataset.view`), 'settings');
  await touch(b, 'touchEnd', []); await sleep(200);
  assert.equal(await activeView(b), 'settings'); assert.equal(await scrollY(b), before);
  assert.equal(await b.evaluate('__nav.clicks'), 0);
});

test('file-picker cancellation stays inside the account sheet and the close icon is visibly sized', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="settings"]').click();document.getElementById('settings-open-bilibili').click()`);
  await b.evaluate(`document.getElementById('bili-cover-file').dispatchEvent(new Event('cancel',{bubbles:true}))`);
  await b.evaluate(`window.dispatchEvent(new PopStateEvent('popstate'))`);
  assert.equal(await b.evaluate(`document.querySelector('dialog[open]')?.querySelector('#settings-bilibili')!==null`), true);
  assert.match(await b.evaluate(`document.getElementById('cover-message').textContent`), /原封面保持不变/);
  await b.evaluate(`(() => {const c=document.createElement('canvas');c.width=c.height=2;const bytes=Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'synthetic.png',{type:'image/png'}));const input=document.getElementById('bili-cover-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(let i=0;i<40 && await b.evaluate(`document.getElementById('cover-save').disabled`);i++)await sleep(50);
  assert.equal(await b.evaluate(`!!document.querySelector('dialog[open]') && !document.getElementById('cover-save').disabled`),true,'a selected synthetic image stays in the sheet as an unsaved preview');
  const icon = await b.evaluate(`(() => {const r=document.querySelector('dialog[open] .dialog-close svg').getBoundingClientRect();return [r.width,r.height];})()`);
  assert.deepEqual(icon, [26,26]);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('dialog[open] .dialog-close')).backgroundColor`),'rgba(0, 0, 0, 0)');
  await b.evaluate(`document.querySelector('dialog[open] .dialog-close').click()`);
  assert.equal(await b.evaluate(`!!document.querySelector('dialog[open]')`), false);
});

test('video buttons overlay four corners without reserving picture space and fade/reveal accessibly', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  await b.send('Emulation.setDeviceMetricsOverride',{width:430,height:932,deviceScaleFactor:1,mobile:true});
  await b.send('Runtime.evaluate',{expression:`(() => {const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvas.getContext('2d').fillRect(0,0,640,360);window.__syntheticStream=canvas.captureStream(10);const v=document.getElementById('replay-player');v.hidden=false;v.srcObject=__syntheticStream;return v.play();})()`,userGesture:true,awaitPromise:true});
  for(let i=0;i<50&&!await b.evaluate(`document.getElementById('replay-player').readyState>=2`);i++)await sleep(100);
  const geometry = await b.evaluate(`(() => {const p=document.getElementById('player-wrap'),r=p.getBoundingClientRect(),v=document.getElementById('replay-player').getBoundingClientRect();return {ratio:r.width/r.height,video:[v.width,v.height],box:[r.width,r.height],controls:['go-live','playback-mute','playback-toggle','replay-fullscreen'].map(id=>{const e=document.getElementById(id),b=e.getBoundingClientRect();return {id,position:getComputedStyle(e).position,x:b.left-r.left,y:b.top-r.top,w:b.width,h:b.height};})};})()`);
  assert.ok(Math.abs(geometry.ratio-16/9)<0.02);assert.deepEqual(geometry.video,geometry.box);
  for(const c of geometry.controls){assert.equal(c.position,'absolute');assert.ok(c.w>=44&&c.h>=44);}
  const [live,mute,toggle,full]=geometry.controls;
  assert.ok(toggle.x<=12&&toggle.y<=12);assert.ok(live.x>=geometry.box[0]-60&&live.y<=12);
  assert.ok(mute.x<=12&&mute.y>=geometry.box[1]-60);assert.ok(full.x>=geometry.box[0]-60&&full.y>=geometry.box[1]-60);
  await sleep(2700);
  assert.equal(await b.evaluate(`getComputedStyle(document.getElementById('playback-toggle')).opacity`),'0');
  await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:200,y:200});await sleep(300);
  assert.equal(await b.evaluate(`getComputedStyle(document.getElementById('playback-toggle')).opacity`),'1');
  await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await b.evaluate(`document.getElementById('playback-toggle').focus()`);await sleep(2700);
  assert.equal(await b.evaluate(`getComputedStyle(document.getElementById('playback-toggle')).opacity`),'1','keyboard focus keeps controls visible');
  await b.evaluate(`__syntheticStream.getTracks().forEach(track=>track.stop());const v=document.getElementById('replay-player');v.pause();v.srcObject=null;`);
});

test('landscape corner controls retain safe-area clearance and unobstructed hit targets', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  for (const [width, height, side, bottom] of [[568,320,0,0],[667,375,0,0],[700,430,0,0],[844,390,59,21]]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    for (const expanded of [false,true]) {
    await b.evaluate(`document.getElementById('view-replay').classList.toggle('replay-expanded',${expanded})`);
    const evidence = await b.evaluate(`(() => {
      const root=document.documentElement;
      root.style.setProperty('--safe-left','${side}px');root.style.setProperty('--safe-right','${side}px');root.style.setProperty('--safe-bottom','${bottom}px');
      document.getElementById('player-wrap').classList.remove('controls-idle');
      return ['go-live','playback-mute','playback-toggle','replay-fullscreen'].map(id => {
        const button=document.getElementById(id);button.hidden=false;
        const r=button.getBoundingClientRect();
        const hits=[8,24,40].flatMap(x=>[8,24,40].map(y=>button.contains(document.elementFromPoint(r.left+x,r.top+y))));
        return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hits};
      });
    })()`);
    for (const button of evidence) {
      assert.equal(button.width,48); assert.equal(button.height,48);
      assert.ok(button.left>=Math.max(44,side)-1 && button.right<=width-Math.max(44,side)+1, `${width}: ${button.id} safe sides`);
      assert.ok(button.top>=0 && button.bottom<=height-bottom+1, `${width}: ${button.id} safe bottom`);
      assert.ok(button.hits.every(Boolean), `${width} expanded=${expanded}: ${button.id} hit target is unobstructed ${JSON.stringify(button)}`);
    }
    }
    await b.evaluate(`document.getElementById('view-replay').classList.remove('replay-expanded')`);
  }
});

test('very narrow landscape keeps the scrollable layout instead of crushing timeline targets', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  for (const width of [320,375,430,461,500,567]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 240, deviceScaleFactor: 1, mobile: true });
    const result = await b.evaluate(`(() => {
      const p=document.getElementById('player-wrap').getBoundingClientRect();
      const timeline=document.querySelector('.timeline-section').getBoundingClientRect();
      return {timelineBelow:timeline.top>=p.bottom,nav:getComputedStyle(document.querySelector('.mobile-nav')).display,
        targets:['mark-in','mark-out','export-range'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,width:r.width,height:r.height};})};
    })()`);
    assert.equal(result.timelineBelow,true,`${width}: compact landscape scrolls normally`);
    assert.notEqual(result.nav,'none');
    for (const target of result.targets) assert.ok(target.width>=44 && target.height>=44,`${width}: ${target.id} touch target`);
  }
});

test('narrow browser tabs retain identical rail geometry with and without a content scrollbar', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const b = await setup(t);
  for (const width of [320,375,390,430,759,760]) {
    // Desktop scrollbars at a narrow width reproduce the non-overlay case;
    // mobile emulation alone can hide this regression behind overlay scrollbars.
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    const results = [];
    for (const view of ['settings','library','tasks','replay']) {
      await b.evaluate(`document.querySelector('.mobile-nav button[data-view="${view}"]').click()`);
      for (const scrollable of [false,true]) {
        results.push(await b.evaluate(`(() => {
          const main=document.querySelector('.workspace-main');
          main.style.overflowY='${scrollable ? 'scroll' : 'hidden'}';
          main.style.scrollbarGutter='${scrollable ? 'stable' : 'auto'}';
          const nav=document.getElementById('mobile-nav'),r=nav.getBoundingClientRect();
          return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height,
            contentWidth:main.clientWidth,shellBackground:getComputedStyle(document.getElementById('console-shell')).backgroundImage,shellAttachment:getComputedStyle(document.getElementById('console-shell')).backgroundAttachment,
            shell:nav.offsetParent?.id,rootScroll:document.scrollingElement.scrollHeight>innerHeight+1,
            buttons:[...nav.querySelectorAll('button')].map(e=>{const b=e.getBoundingClientRect();return [b.left,b.width];})};
        })()`));
      }
    }
    assert.ok(results[0].contentWidth>results[1].contentWidth, 'classic scrollbar must actually consume content width');
    for (const result of results) {
      assert.equal(result.shell,'console-shell');
      assert.equal(result.shellBackground,'none','Precision 原型使用稳定的深色底');
      assert.ok(result.shellAttachment.split(',').every(value=>value.trim()==='scroll')); 
      assert.equal(result.rootScroll,false, `${width}: only the content container may scroll`);
      for (const key of ['left','right','top','width','height']) assert.ok(Math.abs(result[key]-results[0][key])<0.5, `${width}: ${key} remains stable`);
      assert.deepEqual(result.buttons,results[0].buttons, `${width}: tab hit targets do not resize or shift`);
    }
    await b.evaluate(`(() => {const main=document.querySelector('.workspace-main');main.style.removeProperty('overflow-y');main.style.removeProperty('scrollbar-gutter');})()`);
  }
});


// Model the measured iOS discrepancy in CSS as well as JS. Chromium itself
// cannot reproduce iOS compositor clipping or prove the system blur is gone.
test('iOS cold-start regression: short dynamic/fixed viewport still fills the large viewport on all four pages', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const res = createResources(); t.after(() => res.closeAll());
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const shortFixed = '.console-shell { position: fixed; inset: 0;';
  assert.ok(css.includes(shortFixed), 'fixture must instrument the actual fixed-shell rule');
  const syntheticCss = css.replaceAll('100dvh', '873px').replace(shortFixed, '.console-shell { position: fixed; inset: 0 0 59px;');
  const server = await startFixture(res, { cssOverride: syntheticCss }), b = await launch(res);
  await b.send('Page.enable'); await b.send('Runtime.enable');
  await b.send('Emulation.setDeviceMetricsOverride', { width:430, height:932, deviceScaleFactor:1, mobile:true });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(navigator,'standalone',{configurable:true,value:true});
    Object.defineProperty(window,'innerHeight',{configurable:true,value:873});
    Object.defineProperty(visualViewport,'height',{configurable:true,value:873});
    const apply = () => {
      if(!document.documentElement) return;
      document.documentElement.style.setProperty('--safe-top','59px');
      document.documentElement.style.setProperty('--safe-bottom','34px');
      observer.disconnect();
    };
    const observer = new MutationObserver(apply); observer.observe(document,{childList:true,subtree:true}); apply();
  ` });
  await b.send('Page.navigate', { url:`http://127.0.0.1:${server.address().port}/?fixture=normal#replay` });
  for(let i=0;i<100 && !await b.evaluate(`document.body.dataset.view==='replay' && !document.getElementById('console-shell').hidden`);i++) await sleep(100);
  assert.equal(await b.evaluate(`document.body.dataset.view`), 'replay');
  const geometry = () => b.evaluate(`(() => {
    const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    const strip=document.querySelector('.status-bar-background'), style=getComputedStyle(strip);
    return {view:document.body.dataset.view,innerHeight,visualHeight:visualViewport.height,scrollY,
      shell:rect('.console-shell'),nav:rect('.mobile-nav'),strip:rect('.status-bar-background'),
      stripStyle:{position:style.position,background:style.backgroundColor,pointerEvents:style.pointerEvents,filter:style.filter},
      appHeight:getComputedStyle(document.documentElement).getPropertyValue('--app-viewport-height').trim(),
      buttons:[...document.querySelectorAll('.mobile-nav button')].map(e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height,bottom:r.bottom,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})};
  })()`);
  const capture = async name => {
    if(!process.env.H1KM3SH_QA_ARTIFACT_DIR) return;
    fs.mkdirSync(process.env.H1KM3SH_QA_ARTIFACT_DIR,{recursive:true});
    const shot=await b.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(process.env.H1KM3SH_QA_ARTIFACT_DIR,name+'.png'),Buffer.from(shot.data,'base64'));
  };
  // Removing only the iOS class restores the old under-filled shell: 873+59=932.
  await b.evaluate(`document.documentElement.classList.remove('standalone-viewport')`);
  const before=await geometry(); assert.equal(before.shell.height,873); assert.equal(before.nav.bottom,873);
  await capture('ios27-before-synthetic');
  await b.evaluate(`window.dispatchEvent(new Event('resize'))`); await sleep(100);
  const evidence=[];
  for(const view of ['replay','library','tasks','settings']) {
    await b.evaluate(`document.querySelector('.mobile-nav button[data-view="${view}"]').click()`); await sleep(100);
    const g=await geometry(); evidence.push(g);
    assert.equal(g.innerHeight,873); assert.equal(g.visualHeight,873);
    assert.equal(g.appHeight,'100lvh'); assert.equal(g.shell.height,932);
    assert.equal(g.shell.y,0); assert.equal(g.nav.bottom,932); assert.equal(g.nav.height,98);
    assert.equal(g.scrollY,0);
    assert.deepEqual(g.strip,{x:0,y:0,width:430,height:59,bottom:59});
    assert.deepEqual(g.stripStyle,{position:'fixed',background:'rgb(7, 13, 20)',pointerEvents:'none',filter:'none'});
    for(const button of g.buttons) {
      assert.ok(button.width>=44 && button.height>=44 && button.bottom<=898 && button.hit,'full button target above the one 34px safety inset');
    }
    await capture('ios27-after-'+view+'-synthetic');
  }
  // Keyboard sheets keep the visual viewport contract; the full app underneath
  // is not permanently shortened by focus, keyboard changes, or dismissal.
  await b.evaluate(`document.getElementById('settings-open-bilibili').click()`); await sleep(100);
  assert.equal(await b.evaluate(`!!document.querySelector('dialog[open]')`),true);
  for(const [height,offsetTop] of [[520,0],[480,80],[873,0]]) {
    await b.evaluate(`Object.defineProperties(visualViewport,{height:{configurable:true,value:${height}},offsetTop:{configurable:true,value:${offsetTop}}});visualViewport.dispatchEvent(new Event('resize'))`); await sleep(100);
    const sheet=await b.evaluate(`(() => {const d=document.querySelector('dialog[open]');return {height:d.style.getPropertyValue('--dialog-viewport-height'),bottom:d.getBoundingClientRect().bottom};})()`);
    assert.equal(sheet.height,height+'px');
    assert.ok(sheet.bottom<=height+offsetTop+59+1,'sheet cannot move below the emulated keyboard');
    assert.equal((await geometry()).shell.height,932);
  }
  await b.evaluate(`document.querySelector('dialog[open]').close()`); await sleep(100);
  assert.equal((await geometry()).nav.bottom,932); assert.equal((await geometry()).scrollY,0);
  await b.evaluate(`window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('orientationchange'))`); await sleep(100);
  assert.equal((await geometry()).nav.bottom,932,'resume/rotation events do not reapply short JS heights');
  // CSS fullscreen fallback must use the same full-height shell on iOS.
  await b.evaluate(`document.querySelector('.mobile-nav button[data-view="replay"]').click();document.getElementById('view-replay').classList.add('replay-expanded')`); await sleep(100);
  assert.equal(await b.evaluate(`document.getElementById('view-replay').getBoundingClientRect().height`),932);
  await b.evaluate(`document.getElementById('view-replay').classList.remove('replay-expanded')`);
  t.diagnostic(JSON.stringify({engine:'Chromium synthetic CSS/JS mismatch; iOS system blur and real keyboard pending device acceptance',before,evidence}));
});


// This tests clearance and unchanged bottom geometry, not iOS compositor blur.
test('status-fade clearance moves four headings but never moves the shell or bottom rail', { skip: needChrome, timeout: CASE_TIMEOUT }, async t => {
  const res = createResources(); t.after(() => res.closeAll());
  const server = await startFixture(res), b = await launch(res);
  await b.send('Page.enable'); await b.send('Runtime.enable');
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator,'standalone',{configurable:true,value:true});` });
  await b.send('Emulation.setDeviceMetricsOverride', {width:430,height:932,deviceScaleFactor:1,mobile:true});
  await b.send('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/?fixture=normal#replay`});
  for(let i=0;i<100 && !await b.evaluate(`document.body.dataset.view==='replay'`);i++) await sleep(100);
  assert.equal(await b.evaluate(`document.body.dataset.view`),'replay');
  const geometry = () => b.evaluate(`(() => {
    const view=document.body.dataset.view, box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    return {view,heading:box(view==='replay'?'#app-title':'#view-'+view+' .page-heading'),pane:box('#view-'+view),nav:box('.mobile-nav'),shell:box('.console-shell'),padding:parseFloat(getComputedStyle(document.querySelector('.views')).paddingTop),scrollY,overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  const evidence=[];
  for(const [width,height] of [[320,740],[375,812],[390,844],[430,932]]) {
    await b.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    await b.evaluate(`document.documentElement.style.setProperty('--safe-top','59px');document.documentElement.style.setProperty('--safe-bottom','34px');window.dispatchEvent(new Event('resize'))`); await sleep(100);
    for(const view of ['replay','library','tasks','settings']) {
      await b.evaluate(`document.querySelector('.mobile-nav button[data-view="${view}"]').click();document.documentElement.style.setProperty('--status-bar-blur-gap','0px')`); await sleep(100);
      const before=await geometry();
      await b.evaluate(`document.documentElement.style.removeProperty('--status-bar-blur-gap')`); await sleep(100);
      const after=await geometry();
      assert.equal(after.heading.y-before.heading.y,20,width+' '+view+' heading clearance');
      assert.equal(after.padding-before.padding,20);
      assert.deepEqual(after.shell,before.shell); assert.deepEqual(after.nav,before.nav);
      assert.equal(after.nav.bottom,height); assert.equal(after.nav.height,98);
      if(view==='library'||view==='tasks') assert.equal(after.pane.bottom,before.pane.bottom,'bounded list bottom stays fixed');
      assert.equal(after.scrollY,0);assert.equal(after.overflow,false);
      evidence.push({width,height,view,headingY:after.heading.y,navBottom:after.nav.bottom,paneBottom:after.pane.bottom});
    }
  }
  await b.send('Emulation.setDeviceMetricsOverride',{width:932,height:430,deviceScaleFactor:1,mobile:true});
  await b.evaluate(`document.documentElement.style.setProperty('--safe-top','0px');document.documentElement.style.setProperty('--safe-bottom','21px');document.querySelector('.mobile-nav button[data-view="library"]').click();window.dispatchEvent(new Event('resize'))`); await sleep(100);
  const landscape=await geometry();
  await b.evaluate(`document.documentElement.style.setProperty('--status-bar-blur-gap','0px')`);await sleep(100);
  assert.deepEqual(await geometry(),landscape,'zero top inset needs zero additional landscape space');
  await b.evaluate(`document.documentElement.style.removeProperty('--status-bar-blur-gap');Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Version/26.4 Mobile Safari/604.1'});window.dispatchEvent(new Event('resize'))`);await sleep(100);
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-status-fade')`),false);
  await b.evaluate(`delete navigator.userAgent;Object.defineProperty(navigator,'standalone',{configurable:true,value:false});window.dispatchEvent(new Event('resize'))`);await sleep(100);
  assert.equal(await b.evaluate(`document.documentElement.classList.contains('standalone-status-fade')`),false);
  t.diagnostic(JSON.stringify({engine:'Chromium; system blur still needs real iOS acceptance',evidence}));
});

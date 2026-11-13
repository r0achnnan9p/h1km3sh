import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMedia } from '../lib/media-archive.js';

// 轮询真实子进程状态，不能被媒体看门狗使用的模拟时钟推进。
const realSetTimeout = globalThis.setTimeout;
const delay = ms => new Promise(resolve => realSetTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function microtasks() {
  for (let index = 0; index < 3; index++) await Promise.resolve();
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-archive-process-'));
  const ready = path.join(directory, 'ready.json'), terminated = path.join(directory, 'terminated');
  let media, pid, settled = false;
  t.after(async () => {
    if (!pid && fs.existsSync(ready)) pid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    if (media) await media.catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('media-archive-process-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const waitFor = async file => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(file)) {
      assert.equal(settled, false, '子进程就绪前媒体任务不应结束');
      assert.ok(Date.now() < deadline, '等待真实子进程状态超时');
      await delay(10);
    }
  };
  return {
    start(options, ignoreTerm = false) {
      const code = `const fs = require('node:fs');
        ${ignoreTerm ? `process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(terminated)}, 'received'));` : ''}
        setInterval(() => {}, 1000);
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));`;
      media = runMedia(process.execPath, ['-e', code], options);
      media.then(() => { settled = true; }, () => { settled = true; });
      return media;
    },
    async ready() {
      await waitFor(ready);
      pid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
      assert.ok(alive(pid), '测试子进程必须实际运行');
      return pid;
    },
    waitForTerm: () => waitFor(terminated),
    get settled() { return settled; },
  };
}

test('媒体探测在指定上限发送 SIGKILL，等待子进程回收后才返回错误', { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kill = t.mock.method(ChildProcess.prototype, 'kill');
  const controller = new AbortController(), f = fixture(t);
  const media = f.start({ signal: controller.signal, timeoutMs: 20_000 });
  const pid = await f.ready();
  t.mock.timers.tick(19_999);
  await microtasks();
  assert.ok(alive(pid));
  assert.equal(kill.mock.calls.length, 0, '达到上限前不能终止探测');
  t.mock.timers.tick(1);
  await microtasks();
  assert.equal(f.settled, false, '发出 SIGKILL 不能提前结算，必须等待 close');
  assert.deepEqual(kill.mock.calls.map(call => call.arguments[0]), ['SIGKILL']);
  await assert.rejects(media, /媒体处理失败/);
  assert.equal(alive(pid), false, '返回错误时子进程必须已经回收');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  t.mock.timers.tick(15 * 60 * 1000);
  assert.equal(kill.mock.calls.length, 1, '结束后取消或推进旧时钟不能再次发送信号');
});

test('取消媒体处理等待 close，正常退出后清理升级和超时定时器', { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kill = t.mock.method(ChildProcess.prototype, 'kill');
  const controller = new AbortController(), f = fixture(t);
  const media = f.start({ signal: controller.signal });
  const pid = await f.ready();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await microtasks();
  assert.equal(f.settled, false, '取消请求也必须等待 close 后结算');
  assert.deepEqual(kill.mock.calls.map(call => call.arguments[0]), ['SIGTERM']);
  await assert.rejects(media, /任务已取消/);
  assert.equal(alive(pid), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(15 * 60 * 1000);
  assert.deepEqual(kill.mock.calls.map(call => call.arguments[0]), ['SIGTERM'], 'close 必须清理升级和总超时定时器');
});

test('忽略 SIGTERM 的媒体进程在取消宽限结束后升级 SIGKILL 并回收', {
  timeout: 15_000,
  skip: process.platform === 'win32' ? 'Windows 的 SIGTERM 会直接终止进程，无法模拟忽略该信号' : false,
}, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kill = t.mock.method(ChildProcess.prototype, 'kill');
  const controller = new AbortController(), f = fixture(t);
  const media = f.start({ signal: controller.signal }, true);
  const pid = await f.ready();
  controller.abort();
  await f.waitForTerm();
  t.mock.timers.tick(999);
  await microtasks();
  assert.ok(alive(pid));
  assert.equal(f.settled, false);
  assert.deepEqual(kill.mock.calls.map(call => call.arguments[0]), ['SIGTERM']);
  t.mock.timers.tick(1);
  await microtasks();
  assert.equal(f.settled, false, '升级 SIGKILL 后仍须等待 close');
  await assert.rejects(media, /任务已取消/);
  assert.equal(alive(pid), false);
  assert.deepEqual(kill.mock.calls.map(call => call.arguments[0]), ['SIGTERM', 'SIGKILL']);
});

test('预先取消的媒体任务直接拒绝且不启动子进程', async t => {
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runMedia(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), /任务已取消/);
  assert.equal(spawn.mock.calls.length, 0, '预先取消不得产生待回收的子进程');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

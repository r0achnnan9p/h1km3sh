import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAll, CancellationError } from '../lib/download-manager.js';
import { runRtspClipExport } from '../lib/rtsp-clip-export.js';
import { pullRtspRaw } from '../lib/rtsp-client.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const segment = { startTime: '20260930T000000Z', endTime: '20260930T000100Z' };

for (const mode of ['cancel', 'failure']) {
  it(`download manager waits for sibling close after ${mode}`, async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'export-stop-'));
    const controller = new AbortController();
    let survivor;
    const signals = [];
    let settled = false;
    try {
      const result = downloadAll({
        ip: 'unused', user: 'unused', pass: 'unused', channel: '101',
        segments: [segment, segment], concurrency: 2, codec: 'h264',
        outputDir, baseFilename: 'test', signal: controller.signal,
        delay: async () => {},
        spawn: (_command, args) => {
          const proc = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.exitCode = null;
          proc.killed = false;
          proc.kill = signal => { proc.killed = true; signals.push(signal); return true; };
          const first = args.some(arg => arg.endsWith('_seg000.h264'));
          if (mode === 'failure' && first) setImmediate(() => proc.emit('close', 1));
          else if (!survivor) survivor = proc;
          else if (mode === 'cancel') proc.kill = () => { setImmediate(() => proc.emit('close', null)); return true; };
          return proc;
        },
      }).then(() => { settled = true; }, err => { settled = true; return err; });
      if (mode === 'cancel') controller.abort();
      for (let i = 0; i < 10; i++) await tick();
      assert.ok(signals.includes('SIGTERM'));
      assert.equal(settled, false, 'sending SIGTERM is not process exit');
      survivor.emit('close', null);
      const error = await result;
      assert.ok(error instanceof Error);
      if (mode === 'cancel') assert.ok(error instanceof CancellationError);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
}

it('RTSP export aborts sibling pulls and waits for their cleanup', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'export-pulls-'));
  let finishSibling;
  let siblingAborted = false;
  let settled = false;
  let calls = 0;
  try {
    const result = runRtspClipExport({
      ip: 'unused', user: 'unused', pass: 'unused', channel: '101',
      ...{ startTime: segment.startTime, endTime: segment.endTime },
      outputDir, concurrency: 2, taskId: 'mock', sseClients: [],
      pullSegment: ({ signal }) => {
        if (calls++ === 0) return Promise.reject(new Error('first pull failed'));
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { siblingAborted = true; });
          finishSibling = () => reject(new Error('sibling stopped'));
        });
      },
    }).then(() => { settled = true; }, err => { settled = true; return err; });
    await tick();
    assert.equal(siblingAborted, true);
    assert.equal(settled, false);
    finishSibling();
    assert.equal((await result).code, 'DVR_EXPORT_FAILED', 'unknown source errors are not reflected to callers');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

it('RTSP pull waits for TCP close after output flush on abort', async () => {
  const controller = new AbortController();
  const socket = new EventEmitter();
  socket.write = () => true;
  socket.destroy = () => {};
  let settled = false;
  const result = pullRtspRaw({
    ip: 'unused', user: 'unused', pass: 'unused', path: '/unused',
    outStream: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    signal: controller.signal, createConnection: () => socket,
  }).then(() => { settled = true; }, err => { settled = true; return err; });
  controller.abort();
  await tick();
  assert.equal(settled, false);
  socket.emit('close');
  assert.match((await result).message, /Download aborted/);
});

it('an already cancelled RTSP pull never opens a socket', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pullRtspRaw({
    ip: 'unused', path: '/unused', signal: controller.signal,
    createConnection() { assert.fail('must not connect after cancellation'); },
  }), /Download aborted/);
});

it('RTSP export waits for every pull when the user cancels', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'export-abort-'));
  const controller = new AbortController();
  const finish = [];
  let abortedPulls = 0;
  let settled = false;
  try {
    const result = runRtspClipExport({
      ip: 'unused', user: 'unused', pass: 'unused', channel: '101', ...segment,
      outputDir, concurrency: 2, taskId: 'mock-cancel', sseClients: [], signal: controller.signal,
      pullSegment: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => abortedPulls++);
        finish.push(() => reject(new Error('Download aborted')));
      }),
    }).then(() => { settled = true; }, err => { settled = true; return err; });
    await tick();
    controller.abort();
    assert.equal(abortedPulls, 2);
    finish[0]();
    await tick();
    assert.equal(settled, false);
    finish[1]();
    assert.match((await result).message, /导出已取消/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

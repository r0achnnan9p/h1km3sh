import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseVideoStrategy, createVideoResolver } from '../lib/video-resolver.js';

test('策略边界：本地优先，300 秒 RTSP，301 秒完整下载', () => {
  assert.equal(chooseVideoStrategy({ durationSeconds: 3600, hasLocalArchive: true }).source, 'mediamtx');
  assert.equal(chooseVideoStrategy({ durationSeconds: 300 }).strategy, 'rtsp');
  assert.equal(chooseVideoStrategy({ durationSeconds: 301 }).strategy, 'file-download');
  for (const durationSeconds of [0, -1, NaN, Infinity]) assert.throws(() => chooseVideoStrategy({ durationSeconds }));
});

for (const [exists, end, expected] of [
  [true, '2026-09-24 21:20', 'local-cut'], [false, '2026-09-24 21:20', 'rtsp'],
  [false, '2026-09-24 21:20:01', 'file-download'],
]) {
  test(`resolver 执行正确来源：${expected}`, async () => {
    const calls = [];
    const resolver = createVideoResolver({
      archive: { hasRecording: async () => ({ exists }), cutClip: async (...args) => { calls.push(['local', ...args]); return 'local.mp4'; } },
      startHikvision: async (options) => { calls.push(['hikvision', options]); return 'remote.mp4'; },
    });
    const camera = { id: 'door', channel: '101' }, device = { id: 'dvr' };
    const result = await resolver.resolveClip({ camera, device, start: '2026-09-24 21:15', end });
    assert.equal(result.strategy, expected);
    assert.equal(calls.length, 1);
    if (!exists) {
      assert.equal(calls[0][1].camera, camera);
      assert.equal(calls[0][1].device, device);
      assert.equal(calls[0][1].method, expected === 'rtsp' ? 'rtspclip' : 'mp4download');
    }
  });
}

test('时间无效或本地执行失败不悄悄切源，不产生第二个任务', async () => {
  let calls = 0;
  const resolver = createVideoResolver({
    archive: { hasRecording: async () => ({ exists: true }), cutClip: async () => { throw new Error('fixture error'); } },
    startHikvision: async () => { calls++; },
  });
  await assert.rejects(resolver.resolveClip({ camera: {}, start: 'bad', end: 'bad' }), /时间必须/);
  await assert.rejects(resolver.resolveClip({ camera: {}, start: '2026-09-24 21:15', end: '2026-09-24 21:16' }), /fixture error/);
  assert.equal(calls, 0);
});

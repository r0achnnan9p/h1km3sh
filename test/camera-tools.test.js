import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../lib/mcp-server.js';
import { prepareCameraJob } from '../lib/camera-jobs.js';

test('新 MCP 工具只传摄像头别名与墙钟，过滤目录额外字段', async () => {
  const calls = [];
  const handlers = createToolHandlers({
    getStatus: async () => ({ activeTasks: [{ taskId: 'fixture', status: 'completed', artifactUrl: '/artifacts/images/snapshot/fixture.png' }] }),
    listCameras: async () => ({ cameras: [{ id: 'door', name: '门口', password: 'secret', ip: '192.0.2.1', channel: '101' }] }),
    startCameraJob: async (operation, args) => { calls.push([operation, args]); return { taskId: 'fixture' }; },
  });
  assert.deepEqual(JSON.parse(await handlers.list_cameras()), { cameras: [{ id: 'door', name: '门口' }] });
  await handlers.get_snapshot({ camera: '门口', datetime: '2026-09-24 21:15', password: 'secret' });
  await handlers.get_video_clip({ camera: 'door', start: '2026-09-24 21:15', end: '2026-09-24 21:16' });
  await handlers.create_timeline_sheet({ camera: '门口', date: '2026-09-24', start: '20:00', interval: 60, count: 36 });
  assert.deepEqual(calls.map(([operation]) => operation), ['snapshot', 'clip', 'timeline']);
  assert.ok(!JSON.stringify(calls).includes('secret'));
  await assert.rejects(handlers.get_snapshot({ datetime: '2026-09-24T21:15:00Z' }));
  await assert.rejects(handlers.create_timeline_sheet({ camera: 'door', date: '2026-09-24', start: '20:00', count: 37 }));
  assert.equal(calls.length, 3);
});

for (const operation of ['snapshot', 'timeline']) {
  test(`${operation} 本地缺失时复用同一个海康任务素材`, async () => {
    const calls = [];
    const args = operation === 'snapshot' ? { camera: 'door', datetime: '2026-09-24 20:00' }
      : { camera: 'door', date: '2026-09-24', start: '20:00', count: 36, interval: 60 };
    const reservation = { taskId: 'one-task' };
    const job = prepareCameraJob(operation, args, {
      resolveCamera: () => ({ camera: { channel: '101' }, device: { id: 'dvr', ip: '192.0.2.1' } }),
      archive: { hasRecording: async () => ({ exists: false }), snapshotFromClip: async (...args) => calls.push(args),
        createTimelineSheet: async (...args) => calls.push(args) },
      startHikvision: async (options) => { calls.push(options); return 'fixture.mp4'; },
    });
    const selected = await job.execute({ signal: new AbortController().signal, outputFile: 'out.png', reservation });
    assert.equal(selected.source, 'hikvision');
    assert.equal(calls[0].reservation, reservation);
    assert.equal(calls[0].method, operation === 'snapshot' ? 'rtspclip' : 'mp4download');
    assert.equal(calls.length, 2);
  });
}


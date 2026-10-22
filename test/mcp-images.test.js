import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHikclipDispatcher, createToolHandlers } from '../lib/mcp-server.js';

test('截图和缩略图结果仅含完整真实链接，不含嵌图或图片内容', async () => {
  const url = 'https://camera.example/artifacts/images/snapshot/12345678-1234-1234-1234-123456789abc.png?expires=123&signature=abc';
  const dispatcher = createHikclipDispatcher({ startCameraJob: async () => ({ taskId: 'job' }),
    getStatus: async () => ({ activeTasks: [{ taskId: 'job', status: 'completed', source: 'mediamtx', artifactUrl: url }] }),
    resolveBaseUrl: async () => 'http://localhost' });
  for (const [name, args] of [['get_snapshot', { camera: 'D2', datetime: '2026-09-27 20:10' }],
    ['create_timeline_sheet', { camera: 'D2', date: '2026-09-27', start: '22:00', count: 3 }], ['get_export_status', { taskId: 'job' }]]) {
    const response = await dispatcher.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.artifactUrl, url);
    assert.ok(response.result.content.every(item => item.type === 'text'));
    assert.ok(response.result.content[0].text.includes(`[查看原图](${url})`));
    assert.ok(!response.result.content[0].text.includes('!['));
    assert.equal(response.result.content[0].text, response.result.structuredContent.ready_reply);
    assert.equal(response.result.structuredContent.displayMode, 'link-only');
  }
});

test('缩略图在同一次工具调用内等待完成，返回图片结果而非只交任务号', async () => {
  let polls = 0;
  const handlers = createToolHandlers({
    startCameraJob: async () => ({ taskId: 'sheet' }),
    getStatus: async () => ({ activeTasks: [{ taskId: 'sheet', status: ++polls < 3 ? 'downloading' : 'completed',
      artifactUrl: polls >= 3 ? 'https://camera.example/artifacts/images/timeline/12345678-1234-1234-1234-123456789abc.png?expires=123&signature=abc' : undefined }] }),
  }, { waitMs: 100, pollMs: 1 });
  const result = await handlers.create_timeline_sheet({ camera: 'D2', date: '2026-09-27', start: '22:00', count: 3 });
  assert.equal(result.structuredContent.status, 'completed');
  assert.equal(polls, 3);
  assert.ok(result.structuredContent.artifactUrl.includes('signature=abc'));
});

test('等待超时保留同一任务并要求自动继续查询；真实失败立即返回', async () => {
  const args = { camera: 'D2', date: '2026-09-27', start: '22:00', count: 3 };
  const client = { startCameraJob: async () => ({ taskId: 'same-job' }),
    getStatus: async () => ({ activeTasks: [{ taskId: 'same-job', status: 'downloading' }] }) };
  const result = await createToolHandlers(client, { waitMs: 5, pollMs: 1 }).create_timeline_sheet(args);
  assert.equal(result.structuredContent.taskId, 'same-job');
  assert.equal(result.structuredContent.status, 'downloading');
  assert.equal(result.structuredContent.next_action.tool, 'get_export_status');
  assert.equal(result.structuredContent.next_action.automatic, true);
  client.getStatus = async () => ({ activeTasks: [{ taskId: 'same-job', status: 'error', message: '录像缺失' }] });
  await assert.rejects(createToolHandlers(client).create_timeline_sheet(args), /录像缺失/);
});

test('双镜头只完成一路时明确提示未全部完成，不把链接当成全场交付', async () => {
  const url = 'https://camera.example/artifacts/videos/clips/12345678-1234-1234-1234-123456789abc.mp4?expires=123&signature=abc';
  const handlers = createToolHandlers({
    startCameraJob: async () => ({ taskId: 'in-flight' }),
    getStatus: async () => ({ activeTasks: [{ taskId: 'in-flight', kind: 'batch', status: 'downloading', total: 2,
      files: [{ filename: '天行者 队内 D2.mp4', camera: 'D2', artifactUrl: url }] }] }),
  }, { waitMs: 5, pollMs: 1 });
  const result = await handlers.get_match_videos({ cameras: ['D1', 'D2'], start: '2026-09-27 20:20:00', end: '2026-09-27 22:22:00', matchup: '天行者 队内' });
  assert.equal(result.structuredContent.status, 'downloading');
  assert.equal(result.structuredContent.allReady, false);
  assert.equal(result.structuredContent.completedCount, 1);
  assert.match(result.structuredContent.ready_reply, /任务尚未全部完成.*已完成 1\/2/);
  assert.match(result.structuredContent.ready_reply, /以下仅为已完成的镜头/);
  assert.equal(result.structuredContent.next_action.automatic, true);
});

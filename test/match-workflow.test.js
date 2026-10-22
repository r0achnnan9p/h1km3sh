import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchFilename, createUploadQueue } from '../lib/match-workflow.js';
import { createToolHandlers, TOOL_DEFINITIONS } from '../lib/mcp-server.js';

test('中文对阵补齐摄像头日期，拒绝目录注入及无效日期', () => {
  assert.equal(matchFilename('天行者 vs 九块九', 'D2', '2026-09-27'), '天行者 vs 九块九 D2 2026-09-27.mp4');
  for (const value of ['../secret', 'a\\b', 'a\n', '']) assert.throws(() => matchFilename(value, 'D2', '2026-09-27'));
  assert.throws(() => matchFilename('足球', 'D2', '2026-02-30'));
});

test('投稿先准备草稿，明确授权后排队，重复提交不再发布；队列可跨进程恢复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-queue-'));
  try {
    fs.writeFileSync(path.join(root, '足球 D2.mp4'), 'fixture');
    const queue = createUploadQueue(root);
    const args = { filename: '足球 D2.mp4', title: '足球', tid: 249, tags: ['足球'], onlySelf: false };
    const draft = queue.prepare(args);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.sourceIdentity.size, 7);
    assert.equal(typeof draft.sourceIdentity.ino, 'string');
    assert.equal(queue.isBusy(args.filename), false);
    assert.throws(() => queue.submit(draft.id, false));
    assert.equal(queue.submit(draft.id, true).status, 'queued');
    assert.equal(queue.get(draft.id).uploadPhase, 'queued');
    assert.equal(queue.isBusy(args.filename), true);
    assert.deepEqual(queue.submit(draft.id, true), createUploadQueue(root).get(draft.id));
    assert.throws(() => queue.prepare({ ...args, filename: '../secret.mp4' }));
    assert.throws(() => queue.prepare({ ...args, onlySelf: undefined }));
    assert.throws(() => queue.prepare({ ...args, tags: ['足球,别的'] }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP 默认足球分区与标签，投稿写工具声明外部动作', async () => {
  const requests = [];
  const handlers = createToolHandlers({ request: async (...args) => { requests.push(args); return { success: true }; } });
  await handlers.prepare_bilibili_upload({ filename: '天行者 vs 九块九 D2 2026-09-27.mp4', onlySelf: false });
  assert.equal(requests[0][1].body.tid, 249);
  assert.deepEqual(requests[0][1].body.tags, ['足球']);
  assert.equal(requests[0][1].body.onlySelf, true);
  assert.equal(requests[0][1].body.title, '天行者 vs 九块九 D2 2026-09-27');
  assert.ok(TOOL_DEFINITIONS.some(t => t.name === 'submit_bilibili_upload'));
});


test('upload telemetry survives the private queue to dashboard without source-size estimates or private output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-progress-'));
  try {
    fs.writeFileSync(path.join(root, '足球 D2.mp4'), 'fixture');
    const queue = createUploadQueue(root);
    const draft = queue.prepare({ filename: '足球 D2.mp4', title: '足球', tid: 249, tags: ['足球'], onlySelf: true });
    const jobFile = path.join(root, 'biliup_work', 'jobs', `${draft.id}.json`);
    const transfer = { uploadPhase: 'remote_started', stage: 'uploading', stagePercent: 50, progress: 50,
      progressUnit: 'bytes', totalBytes: 2 * 1024 ** 2, uploadedBytes: 1024 ** 2,
      uploadSpeed: 512 * 1024, progressUpdatedAt: Date.now() };
    for (const metrics of [transfer, { ...transfer, totalBytes: null, stagePercent: null, progress: null },
      { ...transfer, stage: 'submitting', stagePercent: null, progress: null, uploadSpeed: null }]) {
      fs.writeFileSync(jobFile, JSON.stringify({ ...draft, status: 'uploading', ...metrics, rawOutput: 'never expose', cookie: 'never expose' }));
      const listed = queue.list()[0];
      for (const [key, value] of Object.entries(metrics)) assert.equal(listed[key], value, key);
      assert.equal(listed.status, 'uploading');
      assert.equal(queue.isBusy(draft.filename), true);
      assert.equal(listed.rawOutput, undefined);
      assert.equal(listed.cookie, undefined);
      assert.equal(listed.sourceIdentity, undefined);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

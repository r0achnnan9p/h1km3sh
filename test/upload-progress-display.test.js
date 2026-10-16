import test from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressPresentation, taskStageLabel, uploadProgressCaption } from '../public/task-presentation.js';
const now = 1_800_000_000_000;
const transfer = { provider: 'bilibili', status: 'uploading', stage: 'uploading', progressUnit: 'bytes', stagePercent: 50,
  progress: 50, uploadedBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3, uploadSpeed: 8 * 1024 ** 2, progressUpdatedAt: now - 1000 };
test('fresh upload shows measured percentage, transferred bytes and speed together', () => {
  assert.equal(taskStageLabel(transfer), '传输文件');
  const text = uploadProgressCaption(transfer, now);
  assert.match(text, /文件上传 50%/); assert.match(text, /1\.0 GiB \/ 2\.0 GiB/); assert.match(text, /8\.0 MiB\/s/);
  assert.equal(taskProgressPresentation(transfer).percent, 50);
});
test('true zero and full transfer percentages are shown without fake 99 percent caps', () => {
  assert.deepEqual(taskProgressPresentation({ ...transfer, stagePercent: 0 }), { show: true, hasPercent: true, percent: 0, indeterminate: false });
  assert.equal(taskProgressPresentation({ ...transfer, stagePercent: 100 }).percent, 100);
});
test('unknown CLI total never produces an inferred percentage or fake total', () => {
  const task = { ...transfer, stagePercent: null, progress: null, totalBytes: null };
  assert.equal(taskProgressPresentation(task).hasPercent, false);
  assert.match(uploadProgressCaption(task, now), /已传 1\.0 GiB/);
  assert.doesNotMatch(uploadProgressCaption(task, now), /%|2\.0 GiB/);
});
test('submitting is independent from transfer progress and never appears stuck at 99 percent', () => {
  const task = { ...transfer, stage: 'submitting', stagePercent: 99, progress: 99 };
  assert.equal(taskStageLabel(task), '提交稿件');
  assert.deepEqual(taskProgressPresentation(task), { show: true, hasPercent: false, percent: 0, indeterminate: true });
  assert.match(uploadProgressCaption(task, now), /等待稿件确认/);
  assert.doesNotMatch(uploadProgressCaption(task, now), /99%|MiB\/s/);
});
test('stale telemetry retains last measured bytes but drops stale speed and labels age', () => {
  const text = uploadProgressCaption({ ...transfer, progressUpdatedAt: now - 20_000 }, now);
  assert.match(text, /文件上传 50%/); assert.match(text, /20 秒前更新/); assert.doesNotMatch(text, /MiB\/s/);
  assert.match(uploadProgressCaption({ ...transfer, progressUpdatedAt: (now - 20_000) / 1000 }, now), /20 秒前更新/);
});
test('preparing, queued, unknown and completed states do not imply active transfer', () => {
  assert.equal(taskProgressPresentation({ ...transfer, stage: 'preparing' }).show, false);
  assert.equal(uploadProgressCaption({ ...transfer, stage: 'preparing' }), '检查文件与登录状态');
  assert.equal(uploadProgressCaption({ ...transfer, status: 'queued' }), '');
  assert.equal(taskProgressPresentation({ ...transfer, status: 'unknown' }).show, false);
  assert.equal(uploadProgressCaption({ ...transfer, status: 'unknown' }), '');
  assert.equal(uploadProgressCaption({ ...transfer, status: 'completed' }), '稿件已提交');
});

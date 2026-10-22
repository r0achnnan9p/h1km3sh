import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressPresentation } from '../public/task-presentation.js';

test('草稿、队列等待和准备阶段不显示会动的假进度条', () => {
  for (const status of ['draft', 'queued', 'pending']) {
    assert.deepEqual(taskProgressPresentation({ status }), { show: false, hasPercent: false, percent: 0, indeterminate: false });
  }
});

test('确实运行的导出或上传显示真实进度或不定进度', () => {
  assert.deepEqual(taskProgressPresentation({ status: 'downloading', progress: 18 }), { show: true, hasPercent: true, percent: 18, indeterminate: false });
  assert.deepEqual(taskProgressPresentation({ status: 'uploading' }), { show: true, hasPercent: false, percent: 0, indeterminate: true });
  assert.equal(taskProgressPresentation({ status: 'converting', progress: 100 }).percent, 99);
  assert.equal(taskProgressPresentation({ status: 'completed', progress: 100 }).show, false);
});


test('stage-local evidence overrides stale overall percentage', async () => {
  const { taskStageLabel, taskProgressCaption } = await import('../public/task-presentation.js');
  const task = { status: 'converting', progress: 93, stage: 'concatenating', stagePercent: null, processedSeconds: 24.2, progressUpdatedAt: 1000 };
  assert.deepEqual(taskProgressPresentation(task), { show: true, hasPercent: false, percent: 0, indeterminate: true });
  assert.equal(taskStageLabel(task), '拼接 MP4');
  assert.equal(taskProgressCaption(task, 6000), '进度待测 · 已处理 24 秒 · 5 秒前更新');
  assert.equal(taskStageLabel({ ...task, status: 'completed' }), '');
  assert.equal(taskProgressCaption({ ...task, status: 'completed' }), '100%');
  assert.equal(taskProgressCaption({ ...task, status: 'queued' }), '');
  assert.match(taskProgressCaption({ ...task, stage: 'trimming', stagePercent: 50, progressUnit: 'files' }, 6000), /^文件完成 50%/);
});

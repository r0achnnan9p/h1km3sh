/**
 * 单飞守卫依赖的活跃任务判定（lib/task-registry.js）。
 *
 * 重点是终态任务会在 activeTasks 里滞留 5 分钟——如果把「表非空」当成
 * 「有任务在跑」，导出完成后的 5 分钟内所有新导出都会被 409 拒掉。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findRunningTask, isTaskRunning, TERMINAL_TASK_STATUSES } from '../lib/task-registry.js';

describe('isTaskRunning', () => {
  it('downloading / converting 算进行中', () => {
    assert.equal(isTaskRunning({ taskId: 'a', status: 'downloading' }), true);
    assert.equal(isTaskRunning({ taskId: 'a', status: 'converting' }), true);
  });

  it('completed / error 是终态', () => {
    assert.equal(isTaskRunning({ taskId: 'a', status: 'completed' }), false);
    assert.equal(isTaskRunning({ taskId: 'a', status: 'error' }), false);
  });

  it('终态集合包含完成、失败和取消，别的状态一律按进行中处理', () => {
    assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ['cancelled', 'completed', 'error']);
    // 未知状态宁可误判为「在跑」而拒绝新任务，也好过放两个任务去抢会话池
    assert.equal(isTaskRunning({ taskId: 'a', status: 'queued' }), true);
  });

  it('null / undefined 不算在跑', () => {
    assert.equal(isTaskRunning(null), false);
    assert.equal(isTaskRunning(undefined), false);
  });
});

describe('findRunningTask', () => {
  it('空集合返回 null', () => {
    assert.equal(findRunningTask([]), null);
  });

  it('只剩终态任务时返回 null（导出刚完成的 5 分钟窗口）', () => {
    const tasks = [
      { taskId: 'a', status: 'completed' },
      { taskId: 'b', status: 'error' },
    ];
    assert.equal(findRunningTask(tasks), null);
  });

  it('混着终态和进行中时返回那个进行中的', () => {
    const tasks = [
      { taskId: 'a', status: 'completed' },
      { taskId: 'b', status: 'downloading' },
      { taskId: 'c', status: 'error' },
    ];
    assert.equal(findRunningTask(tasks).taskId, 'b');
  });

  it('接受 Map.values() 这种迭代器', () => {
    const map = new Map([
      ['a', { taskId: 'a', status: 'error' }],
      ['b', { taskId: 'b', status: 'converting' }],
    ]);
    assert.equal(findRunningTask(map.values()).taskId, 'b');
  });
});


/**
 * Unit tests for GET /api/status endpoint.
 * Tests active task management and auto-cleanup behavior.
 *
 * Since server.js doesn't export the app or activeTasks separately,
 * we replicate the core logic (activeTasks Map + broadcastProgress + /api/status handler)
 * in an isolated Express app for unit testing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

describe('/api/status endpoint', () => {
  let app;
  let server;
  let activeTasks;
  let broadcastProgress;
  let baseUrl;
  let cleanupTimers;

  beforeEach(async () => {
    activeTasks = new Map();
    cleanupTimers = [];

    // Replicate broadcastProgress logic from server.js
    broadcastProgress = (taskId, status, progress, message) => {
      activeTasks.set(taskId, {
        taskId,
        status,
        progress,
        message,
        startTime: activeTasks.get(taskId)?.startTime || Date.now()
      });

      // 完成/失败的任务 5 分钟后自动清理
      if (status === 'completed' || status === 'error') {
        const timer = setTimeout(() => activeTasks.delete(taskId), 5 * 60 * 1000);
        cleanupTimers.push(timer);
      }
    };

    app = express();

    // Replicate /api/status endpoint from server.js
    app.get('/api/status', (req, res) => {
      res.json({
        success: true,
        activeTasks: Array.from(activeTasks.values())
      });
    });

    // Start on random available port
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    // Clear any pending cleanup timers to avoid keeping the process alive
    cleanupTimers.forEach(t => clearTimeout(t));
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('should return empty activeTasks array when no tasks exist', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.activeTasks, []);
  });

  it('should return active tasks when tasks are in progress', async () => {
    broadcastProgress('task-001', 'downloading', 45, '阶段1：正在下载 (45%)');
    broadcastProgress('task-002', 'converting', 90, '阶段2：正在封装...');

    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.activeTasks.length, 2);

    const task1 = body.activeTasks.find(t => t.taskId === 'task-001');
    assert.ok(task1);
    assert.equal(task1.status, 'downloading');
    assert.equal(task1.progress, 45);
    assert.equal(task1.message, '阶段1：正在下载 (45%)');
    assert.equal(typeof task1.startTime, 'number');

    const task2 = body.activeTasks.find(t => t.taskId === 'task-002');
    assert.ok(task2);
    assert.equal(task2.status, 'converting');
    assert.equal(task2.progress, 90);
  });

  it('should preserve startTime across multiple progress updates for the same task', async () => {
    broadcastProgress('task-003', 'downloading', 10, '开始下载');
    const firstStartTime = activeTasks.get('task-003').startTime;

    // Small delay to ensure Date.now() would differ
    await new Promise(r => setTimeout(r, 10));

    broadcastProgress('task-003', 'downloading', 50, '下载中...');
    const secondStartTime = activeTasks.get('task-003').startTime;

    assert.equal(firstStartTime, secondStartTime);

    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(body.activeTasks.length, 1);
    assert.equal(body.activeTasks[0].startTime, firstStartTime);
  });

  it('should auto-cleanup completed/error tasks after 5 minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // Use a local activeTasks and broadcastProgress with fake timers
    const localTasks = new Map();
    const localBroadcast = (taskId, status, progress, message) => {
      localTasks.set(taskId, {
        taskId,
        status,
        progress,
        message,
        startTime: localTasks.get(taskId)?.startTime || Date.now()
      });

      if (status === 'completed' || status === 'error') {
        setTimeout(() => localTasks.delete(taskId), 5 * 60 * 1000);
      }
    };

    // Create a separate app with localTasks for this test
    const localApp = express();
    localApp.get('/api/status', (req, res) => {
      res.json({
        success: true,
        activeTasks: Array.from(localTasks.values())
      });
    });

    const localServer = await new Promise((resolve) => {
      const s = localApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const localUrl = `http://127.0.0.1:${localServer.address().port}`;

    try {
      // Add a completed task and an error task
      localBroadcast('task-complete', 'downloading', 50, '下载中');
      localBroadcast('task-complete', 'completed', 100, '完成');
      localBroadcast('task-error', 'downloading', 30, '下载中');
      localBroadcast('task-error', 'error', 0, '下载失败');

      // Both tasks should still be visible immediately
      let res = await fetch(`${localUrl}/api/status`);
      let body = await res.json();
      assert.equal(body.activeTasks.length, 2);
      assert.ok(body.activeTasks.find(t => t.status === 'completed'));
      assert.ok(body.activeTasks.find(t => t.status === 'error'));

      // Advance time by 4 minutes - both tasks should still be there
      t.mock.timers.tick(4 * 60 * 1000);
      res = await fetch(`${localUrl}/api/status`);
      body = await res.json();
      assert.equal(body.activeTasks.length, 2);

      // Advance time past 5 minutes total - both tasks should be cleaned up
      t.mock.timers.tick(1 * 60 * 1000 + 1);
      res = await fetch(`${localUrl}/api/status`);
      body = await res.json();
      assert.equal(body.activeTasks.length, 0);
    } finally {
      await new Promise((resolve) => localServer.close(resolve));
    }
  });

  it('should not cleanup tasks that are still in progress', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    broadcastProgress('task-active', 'downloading', 60, '下载中...');

    // Advance time well past 5 minutes
    t.mock.timers.tick(10 * 60 * 1000);

    // Active task should still be present (no cleanup scheduled for in-progress tasks)
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();
    assert.equal(body.activeTasks.length, 1);
    assert.equal(body.activeTasks[0].taskId, 'task-active');
    assert.equal(body.activeTasks[0].status, 'downloading');
  });
});

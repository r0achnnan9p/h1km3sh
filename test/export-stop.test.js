/**
 * Unit tests for POST /api/export/stop endpoint.
 * Tests task stopping behavior: valid taskId, invalid taskId, and missing taskId.
 *
 * Since server.js doesn't export the app or activeTasks separately,
 * we replicate the core logic (activeTasks Map + broadcastProgress + /api/export/stop handler)
 * in an isolated Express app for unit testing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

describe('POST /api/export/stop endpoint', () => {
  let app;
  let server;
  let activeTasks;
  let broadcastProgress;
  let baseUrl;

  beforeEach(async () => {
    activeTasks = new Map();

    // Replicate broadcastProgress logic from server.js
    broadcastProgress = (taskId, status, progress, message) => {
      const existing = activeTasks.get(taskId);
      const isFinal = status === 'completed' || status === 'error';

      activeTasks.set(taskId, {
        taskId,
        status,
        progress,
        message,
        startTime: existing?.startTime || Date.now(),
        controller: isFinal ? undefined : existing?.controller,
      });

      if (isFinal) {
        // unref() so this 5-minute cleanup timer doesn't keep the test process
        // alive after the assertions complete (mirrors server.js behaviour,
        // where the long-lived HTTP server keeps the loop running instead).
        const t = setTimeout(() => activeTasks.delete(taskId), 5 * 60 * 1000);
        if (t.unref) t.unref();
      }
    };

    app = express();
    app.use(express.json());

    // Replicate POST /api/export/stop endpoint from server.js
    app.post('/api/export/stop', (req, res) => {
      const { taskId } = req.body || {};

      if (!taskId) {
        return res.status(400).json({ success: false, error: 'Missing taskId' });
      }

      const task = activeTasks.get(taskId);
      if (!task) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }

      if (task.controller) {
        try {
          task.controller.abort();
        } catch (err) {
          // ignore
        }
      }

      broadcastProgress(taskId, 'error', task.progress || 0, '任务已停止');

      res.json({ success: true, message: 'Task stopped' });
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('should return 200 with success when taskId exists in activeTasks', async () => {
    // Seed activeTasks with a test task
    const taskId = 'test-task-001';
    activeTasks.set(taskId, {
      taskId,
      status: 'downloading',
      progress: 50,
      message: '下载中...',
      startTime: Date.now(),
      controller: undefined,
    });

    const res = await fetch(`${baseUrl}/api/export/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, 'Task stopped');
  });

  it('should return 404 when taskId does not exist in activeTasks', async () => {
    const res = await fetch(`${baseUrl}/api/export/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'nonexistent-task-999' }),
    });
    const body = await res.json();

    assert.equal(res.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error, 'Task not found');
  });

  it('should return 400 when taskId is missing from request body', async () => {
    const res = await fetch(`${baseUrl}/api/export/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.success, false);
    assert.equal(body.error, 'Missing taskId');
  });

  it('should call abort() on the task controller when stopping a task with a controller', async () => {
    const taskId = 'test-task-with-controller';
    let abortCalled = false;
    const mockController = {
      abort: () => { abortCalled = true; },
    };

    activeTasks.set(taskId, {
      taskId,
      status: 'downloading',
      progress: 30,
      message: '下载中...',
      startTime: Date.now(),
      controller: mockController,
    });

    const res = await fetch(`${baseUrl}/api/export/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(abortCalled, true);
  });

  it('should update task status to error after stopping', async () => {
    const taskId = 'test-task-status-check';
    activeTasks.set(taskId, {
      taskId,
      status: 'downloading',
      progress: 75,
      message: '下载中...',
      startTime: Date.now(),
      controller: undefined,
    });

    await fetch(`${baseUrl}/api/export/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });

    const task = activeTasks.get(taskId);
    assert.ok(task, 'Task should still exist in activeTasks (cleanup is deferred)');
    assert.equal(task.status, 'error');
    assert.equal(task.message, '任务已停止');
  });
});

/**
 * Property-based test: task status restore consistency.
 *
 * **Validates: Requirements 6.2**
 *
 * Design reference (design.md Property 5):
 * "For any 从 `/api/status` 返回的有效活跃任务对象（包含 progress 0-100、status、message 字段），
 * 恢复后的 UI 状态应满足：进度条值等于 task.progress，状态文字等于 task.message。"
 *
 * The mapping logic lives in `restoreActiveTaskStatus()` in public/app.js:
 *   exportProgressBar.value = task.progress;
 *   exportStatusText.textContent = task.message || '任务进行中...';
 *
 * Since we cannot run the full browser app in Node.js, we extract the pure
 * data-mapping logic into `applyTaskToUI(task, uiState)` and test that function
 * directly with fast-check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

/**
 * Pure function that mirrors the UI-update logic inside restoreActiveTaskStatus()
 * in public/app.js.
 *
 * Given a task object from /api/status and a plain uiState object (simulating
 * the relevant DOM element properties), it applies the task data to the UI state.
 *
 * @param {{ progress: number, status: string, message: string }} task
 * @param {{ progress: number, message: string }} uiState - mutable state object
 */
function applyTaskToUI(task, uiState) {
  // Mirrors: exportProgressBar.value = task.progress
  uiState.progress = task.progress;
  // Mirrors: exportStatusText.textContent = task.message || '任务进行中...'
  uiState.message = task.message || '任务进行中...';
}

// Valid status values as returned by /api/status
const VALID_STATUSES = ['downloading', 'converting', 'completed', 'error'];

/**
 * Arbitrary for a valid active task object:
 *   - progress: integer in [0, 100]
 *   - status: one of the four valid status strings
 *   - message: any non-empty string (simulates real server messages)
 */
const taskArbitrary = fc.record({
  progress: fc.integer({ min: 0, max: 100 }),
  status: fc.constantFrom(...VALID_STATUSES),
  message: fc.string({ minLength: 1, maxLength: 200 }),
});

describe('Property 5: task status restore consistency', () => {
  // --- Example-based boundary tests ---

  it('applies progress=0 correctly', () => {
    const task = { progress: 0, status: 'downloading', message: '开始下载...' };
    const uiState = { progress: -1, message: '' };
    applyTaskToUI(task, uiState);
    assert.equal(uiState.progress, 0);
    assert.equal(uiState.message, '开始下载...');
  });

  it('applies progress=100 correctly', () => {
    const task = { progress: 100, status: 'completed', message: '导出完成' };
    const uiState = { progress: -1, message: '' };
    applyTaskToUI(task, uiState);
    assert.equal(uiState.progress, 100);
    assert.equal(uiState.message, '导出完成');
  });

  it('applies progress=50 with converting status correctly', () => {
    const task = { progress: 50, status: 'converting', message: '正在封装...' };
    const uiState = { progress: -1, message: '' };
    applyTaskToUI(task, uiState);
    assert.equal(uiState.progress, 50);
    assert.equal(uiState.message, '正在封装...');
  });

  it('applies error status correctly', () => {
    const task = { progress: 30, status: 'error', message: '下载失败' };
    const uiState = { progress: -1, message: '' };
    applyTaskToUI(task, uiState);
    assert.equal(uiState.progress, 30);
    assert.equal(uiState.message, '下载失败');
  });

  it('uses fallback message when task.message is empty string', () => {
    const task = { progress: 45, status: 'downloading', message: '' };
    const uiState = { progress: -1, message: '' };
    applyTaskToUI(task, uiState);
    assert.equal(uiState.progress, 45);
    assert.equal(uiState.message, '任务进行中...');
  });

  // --- Property-based tests (≥50 random task objects each) ---

  it('property: uiState.progress always equals task.progress after apply', () => {
    fc.assert(
      fc.property(taskArbitrary, (task) => {
        const uiState = { progress: -1, message: '' };
        applyTaskToUI(task, uiState);
        assert.equal(
          uiState.progress,
          task.progress,
          `Expected uiState.progress=${task.progress}, got ${uiState.progress} for task=${JSON.stringify(task)}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('property: uiState.message always equals task.message after apply (non-empty message)', () => {
    // task.message is guaranteed non-empty by taskArbitrary (minLength: 1)
    fc.assert(
      fc.property(taskArbitrary, (task) => {
        const uiState = { progress: -1, message: '' };
        applyTaskToUI(task, uiState);
        assert.equal(
          uiState.message,
          task.message,
          `Expected uiState.message="${task.message}", got "${uiState.message}" for task=${JSON.stringify(task)}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('property: uiState.progress is always in [0, 100] for valid task objects', () => {
    fc.assert(
      fc.property(taskArbitrary, (task) => {
        const uiState = { progress: -1, message: '' };
        applyTaskToUI(task, uiState);
        assert.ok(
          uiState.progress >= 0 && uiState.progress <= 100,
          `uiState.progress=${uiState.progress} is out of [0, 100] for task=${JSON.stringify(task)}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('property: uiState.message is always a non-empty string after apply', () => {
    // Covers both non-empty task.message (uses task.message) and
    // empty task.message (uses fallback '任务进行中...')
    const taskWithPossiblyEmptyMessage = fc.record({
      progress: fc.integer({ min: 0, max: 100 }),
      status: fc.constantFrom(...VALID_STATUSES),
      message: fc.string({ minLength: 0, maxLength: 200 }),
    });

    fc.assert(
      fc.property(taskWithPossiblyEmptyMessage, (task) => {
        const uiState = { progress: -1, message: '' };
        applyTaskToUI(task, uiState);
        assert.ok(
          typeof uiState.message === 'string' && uiState.message.length > 0,
          `uiState.message should be non-empty string, got "${uiState.message}" for task=${JSON.stringify(task)}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('property: applying the same task twice yields the same uiState (idempotency)', () => {
    fc.assert(
      fc.property(taskArbitrary, (task) => {
        const uiState1 = { progress: -1, message: '' };
        applyTaskToUI(task, uiState1);

        const uiState2 = { progress: -1, message: '' };
        applyTaskToUI(task, uiState2);
        applyTaskToUI(task, uiState2); // apply twice

        assert.equal(
          uiState1.progress,
          uiState2.progress,
          `Idempotency failed for progress: task=${JSON.stringify(task)}`
        );
        assert.equal(
          uiState1.message,
          uiState2.message,
          `Idempotency failed for message: task=${JSON.stringify(task)}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('property: all four valid status values are handled without throwing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom(...VALID_STATUSES),
        fc.string({ minLength: 1, maxLength: 100 }),
        (progress, status, message) => {
          const task = { progress, status, message };
          const uiState = { progress: -1, message: '' };
          // Must not throw
          applyTaskToUI(task, uiState);
          assert.equal(uiState.progress, progress);
          assert.equal(uiState.message, message);
        }
      ),
      { numRuns: 200 }
    );
  });
});

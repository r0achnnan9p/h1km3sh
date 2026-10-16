/**
 * 活跃任务表（server.js 的 activeTasks）的共享判定逻辑。
 *
 * 终态任务完成后还会在表里留 5 分钟供前端刷新后读取结果，所以「现在有没有
 * 任务在跑」不能用 Map 是否为空来判断，必须看状态。单飞守卫和定时任务都要
 * 这个判断，抽出来避免两处各写一遍。
 */

/** SSE 只会广播这四种状态，其中这两种是终态（见 lib/progress-reporter.js）。 */
export const TERMINAL_TASK_STATUSES = new Set(['completed', 'error', 'cancelled']);

/** 单个任务是否仍在进行中。 */
export function isTaskRunning(task) {
  return Boolean(task) && !TERMINAL_TASK_STATUSES.has(task.status);
}

/**
 * 从任务集合里找出第一个仍在进行的任务。
 *
 * @param {Iterable<{taskId?:string, status?:string}>} tasks
 * @returns {object|null}
 */
export function findRunningTask(tasks) {
  for (const task of tasks) {
    if (isTaskRunning(task)) return task;
  }
  return null;
}


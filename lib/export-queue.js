/** One process-wide FIFO lease. Only settlement of execute releases ownership. */
export function createExportQueue({ onState = () => {}, onSettled = () => {}, onCancel = () => {} } = {}) {
  const waiting = [];
  let running = null;
  const entries = new Map();
  function positions() {
    waiting.forEach((entry, index) => onState(entry.task, 'queued', index + 1));
  }
  function drain() {
    if (running || !waiting.length) return;
    const entry = waiting.shift();
    running = entry;
    onState(entry.task, 'downloading', null);
    positions();
    Promise.resolve().then(() => entry.execute()).then(
      value => settle(entry, null, value), error => settle(entry, error),
    );
  }
  function settle(entry, error, value) {
    try { onSettled(entry.task, error, value); }
    catch (settlementError) { error ||= settlementError; }
    finally {
      entries.delete(entry.task.taskId);
      running = null;
      if (error) entry.reject(error); else entry.resolve(value);
      drain();
    }
  }
  return {
    find(requestKey) {
      if (!requestKey) return null;
      return [...entries.values()].find(entry => entry.task.requestKey === requestKey)?.task || null;
    },
    owns(taskId) { return running?.task.taskId === taskId; },
    get runningTask() { return running?.task || null; },
    submit(task, execute) {
      let resolve, reject;
      const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
      // HTTP callers only need task ids; cancellation must not create an unhandled rejection.
      completion.catch(() => {});
      const entry = { task, execute, resolve, reject, completion };
      entries.set(task.taskId, entry);
      waiting.push(entry);
      positions();
      drain();
      return completion;
    },
    cancel(taskId) {
      const entry = entries.get(taskId);
      if (!entry) return false;
      onCancel(entry.task); // Persist intent before aborting or acknowledging cancellation.
      entry.task.controller?.abort();
      const index = waiting.indexOf(entry);
      if (index >= 0) {
        waiting.splice(index, 1);
        entries.delete(taskId);
        const error = new Error('任务已取消');
        onSettled(entry.task, error);
        entry.reject(error);
        positions();
      }
      // Running tasks retain the lease until their actual pipeline and cleanup settle.
      return true;
    },
  };
}

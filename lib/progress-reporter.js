/**
 * Progress Reporter Module
 *
 * Aggregates progress from all pipeline stages and broadcasts updates via SSE.
 * Calculates weighted progress across phases: download (85%), trim (5%),
 * concatenate (3%), remux (7%).
 *
 * Phase weights:
 *   downloading:    85%
 *   trimming:        5%
 *   concatenating:   3%
 *   remuxing:        7%
 */

/** Phase weight configuration (must sum to 100) */
const PHASE_WEIGHTS = {
  segmenting: 0,
  downloading: 85,
  trimming: 5,
  concatenating: 3,
  remuxing: 7,
};

/** Map internal phase names to SSE status values compatible with the frontend */
const PHASE_STATUS_MAP = {
  segmenting: 'downloading',
  downloading: 'downloading',
  trimming: 'converting',
  concatenating: 'converting',
  remuxing: 'converting',
};

/** Phase labels for human-readable messages */
const PHASE_LABELS = {
  segmenting: '分段中',
  downloading: '下载中',
  trimming: '裁剪中',
  concatenating: '拼接中',
  remuxing: '封装中',
};

/**
 * 全局任务状态钩子：每次广播时同步回调（server.js 用它更新 activeTasks，
 * 使页面刷新后 /api/status 能拿到实时进度，而不是任务启动时的旧值）。
 */
let globalStatusHook = null;

/** @param {(taskId:string, status:string, progress:number, message:string) => void} fn */
export function setProgressStatusHook(fn) {
  globalStatusHook = fn;
}

export class ProgressReporter {
  /**
   * @param {string} taskId - Unique task identifier
   * @param {Array<{id: number, res: import('http').ServerResponse}>} sseClients - SSE client connections
   */
  constructor(taskId, sseClients) {
    this.taskId = taskId;
    this.sseClients = sseClients;
  }

  /**
   * Report progress by broadcasting an SSE event to all connected clients.
   *
   * @param {object} update - ProgressUpdate object
   * @param {string} update.phase - "segmenting" | "downloading" | "trimming" | "concatenating" | "remuxing"
   * @param {number} update.overallPercent - 0-100 progress within the current phase
   * @param {number} update.segmentsCompleted - Number of segments finished
   * @param {number} update.segmentsTotal - Total number of segments
   * @param {number[]} update.segmentsInProgress - Indices of segments currently being processed
   * @param {{segment: number, attempt: number}} [update.currentRetry] - Retry info if a segment is retrying
   * @param {string} update.message - Human-readable status message
   */
  reportProgress(update) {
    const progress = update.stage ? null : this._calculateOverallProgress(update);
    const message = this._formatMessage(update);
    const status = update.stage ? (['searching', 'downloading', 'cache'].includes(update.stage) ? 'downloading' : 'converting') : PHASE_STATUS_MAP[update.phase] || 'downloading';

    this._broadcast(status, progress, message, update.speed ?? null, update.speedX ?? null, update.stage ? {
      stage: update.stage,
      stagePercent: Number.isFinite(update.stagePercent) ? Math.max(0, Math.min(100, update.stagePercent)) : null,
      progressUnit: update.progressUnit || null,
      processedSeconds: Number.isFinite(update.processedSeconds) ? update.processedSeconds : null,
      transferredBytes: Number.isFinite(update.transferredBytes) && update.transferredBytes >= 0 ? update.transferredBytes : null,
      transferScope: update.transferScope === 'file' ? 'file' : null,
      progressUpdatedAt: Date.now(),
    } : {});
  }

  /**
   * Report a completion event.
   * @param {string} filename - The output filename
   */
  reportComplete(filename) {
    this._broadcast('completed', 100, `导出成功！文件保存为: ${filename}`);
  }

  /**
   * Report an error event.
   * @param {string} errorMessage - Error description
   */
  reportError(errorMessage) {
    this._broadcast('error', 0, errorMessage);
  }

  /**
   * Calculate the overall weighted progress percentage (0-100).
   *
   * Progress model:
   *   total = sum of completed phase weights + current phase partial progress
   *
   * For the download phase specifically:
   *   download progress = overallPercent passed in (which should be
   *   Σ(received bytes) / Σ(estimated bytes) × 100)
   *   weighted contribution = downloadProgress × 0.85
   *
   * @param {object} update
   * @returns {number} Overall progress 0-100, rounded to integer
   */
  _calculateOverallProgress(update) {
    const phaseOrder = ['segmenting', 'downloading', 'trimming', 'concatenating', 'remuxing'];
    const currentPhaseIndex = phaseOrder.indexOf(update.phase);

    // Sum weights of all completed phases
    let completedWeight = 0;
    for (let i = 0; i < currentPhaseIndex; i++) {
      completedWeight += PHASE_WEIGHTS[phaseOrder[i]];
    }

    // Add partial progress of current phase
    const currentPhaseWeight = PHASE_WEIGHTS[update.phase] || 0;
    const phaseProgress = Math.max(0, Math.min(100, update.overallPercent));
    const currentContribution = (phaseProgress / 100) * currentPhaseWeight;

    const overall = Math.round(Math.max(0, Math.min(100, completedWeight + currentContribution)));
    return overall;
  }

  /**
   * Format a human-readable message from the progress update.
   * Includes phase label, segment status, and retry info.
   *
   * @param {object} update
   * @returns {string}
   */
  _formatMessage(update) {
    const stageLabels = { searching: '搜索录像', cache: '复用缓存', downloading: '下载中', trimming: '裁剪中', remuxing: '封装中', concatenating: '拼接中', finalizing: '整理成品' };
    const phaseLabel = stageLabels[update.stage] || PHASE_LABELS[update.phase] || update.phase;
    const parts = [];

    parts.push(phaseLabel);

    // Segment completion status
    if (update.segmentsTotal > 0) {
      parts.push(`(${update.segmentsCompleted}/${update.segmentsTotal} 完成)`);

      // In-progress segment indices
      if (update.segmentsInProgress && update.segmentsInProgress.length > 0) {
        parts.push(`进行中: [${update.segmentsInProgress.join(', ')}]`);
      }
    }

    // Retry information
    if (update.currentRetry) {
      parts.push(`片段 ${update.currentRetry.segment} 重试第 ${update.currentRetry.attempt} 次`);
    }

    // Append custom message if provided and different from phase label
    if (update.message && update.message !== phaseLabel) {
      parts.push(`- ${update.message}`);
    }

    return parts.join(' ');
  }

  /**
   * Broadcast an SSE message to all connected clients.
   * Format is compatible with the existing frontend onmessage handler.
   *
   * @param {string} status
   * @param {number} progress
   * @param {string} message
   * @param {number|null} [speed=null] - Download speed in bytes/sec, or null if not applicable
   * @param {number|null} [speedX=null] - Realtime multiplier (rtsp clip export only), or null
   */
  _broadcast(status, progress, message, speed = null, speedX = null, details = {}) {
    const data = JSON.stringify({
      taskId: this.taskId,
      status,
      progress,
      message,
      speed,
      speedX,
      ...details,
    });

    this.sseClients.forEach(client => {
      try { client.res.write(`data: ${data}\n\n`); } catch { /* disconnected client */ }
    });

    if (globalStatusHook) {
      try { globalStatusHook(this.taskId, status, progress, message, speed, speedX, details); } catch (_) {}
    }
  }
}

/**
 * Calculate aggregate download progress from per-segment byte tracking.
 *
 * @param {Array<{received: number, estimated: number}>} segmentBytes - Per-segment byte info
 * @returns {number} Download phase progress as percentage (0-100)
 */
export function calculateDownloadProgress(segmentBytes) {
  if (!segmentBytes || segmentBytes.length === 0) return 0;

  const totalReceived = segmentBytes.reduce((sum, s) => sum + (s.received || 0), 0);
  const totalEstimated = segmentBytes.reduce((sum, s) => sum + (s.estimated || 0), 0);

  if (totalEstimated <= 0) return 0;

  const progress = (totalReceived / totalEstimated) * 100;
  return Math.max(0, Math.min(100, progress));
}


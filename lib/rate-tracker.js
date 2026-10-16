/**
 * 传输速率跟踪器（滑动窗口）
 *
 * 两条导出链路共用：mp4 下载链路按当前文件累计字节上报，rtsp 拉流链路按各分段
 * 累计字节汇总上报。
 *
 * 传入的计数允许中途归零——mp4 链路切到下一个文件时 `bytesReceived` 会从 0 重新
 * 计起，直接做差会算出负速率。内部用 carried 累加重置前的历史值来规避。
 */

const DEFAULT_WINDOW_MS = 3000;

/**
 * @param {object} [options]
 * @param {number} [options.windowMs=3000] - 滑动窗口长度，越大读数越平滑
 */
export function createRateTracker({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  /** @type {Array<{t: number, total: number}>} */
  const samples = [];
  let carried = 0;
  let lastRaw = 0;

  /** @returns {number} 字节/秒；样本不足时为 0 */
  const rate = () => {
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (last.total - first.total) / dt);
  };

  return {
    /**
     * @param {number} raw - 当前累计字节数；小于上次值时视为计数器已重置
     * @param {number} [now=Date.now()] - 采样时刻，便于测试注入
     * @returns {number} 当前速率（字节/秒）
     */
    update(raw, now = Date.now()) {
      const n = Number(raw) || 0;
      if (n < lastRaw) carried += lastRaw;
      lastRaw = n;
      samples.push({ t: now, total: carried + n });
      // 至少保留首尾两个样本，否则无法作差
      while (samples.length > 2 && now - samples[0].t > windowMs) samples.shift();
      return rate();
    },
    rate,
  };
}

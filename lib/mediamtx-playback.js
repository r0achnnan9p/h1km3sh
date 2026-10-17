/** MediaMTX Playback API 的服务端适配；调用方必须传入服务器配置的摄像头 ID。 */
import { wallRange } from './camera-time.js';

const PLAYBACK_WALL_OFFSET_MS = 8 * 60 * 60 * 1000; // Same Asia/Shanghai contract as the day timeline.
function validatedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式必须为 YYYY-MM-DD。');
  const [year, month, day] = value.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value) throw new Error('日期不存在。');
  return value;
}

export function createMediaMtxPlayback({ baseUrl = 'http://127.0.0.1:9996', fetchImpl = fetch, timeoutMs = 15_000, maxBodyBytes = 2 * 1024 * 1024 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('MediaMTX Playback 地址必须是纯 HTTP(S) 服务根地址。');
  }
  async function request(url, readJson = false, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, redirect: 'error' });
      if (!readJson) return response;
      if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status }; }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('MediaMTX 回放目录响应无效。');
      let bytes = 0; const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBodyBytes) { controller.abort(); throw new Error('MediaMTX 回放目录响应过大。'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      let rows; try { rows = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('MediaMTX 回放目录响应无效。'); }
      return { ok: true, status: response.status, json: async () => rows };
    }
    finally { clearTimeout(timer); }
  }
  async function listWindow(cameraId, start, end, { signal, maxDuration = Infinity } = {}) {
    if (typeof cameraId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cameraId)) throw new Error('摄像头编号无效。');
    const url = new URL('/list', base); url.search = new URLSearchParams({ path: cameraId, start, end }).toString();
    const response = await request(url, true, signal);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`MediaMTX 回放目录查询失败（${response.status}）。`);
    let rows;
    try { rows = await response.json(); } catch { throw new Error('MediaMTX 回放目录响应无效。'); }
    if (!Array.isArray(rows)) throw new Error('MediaMTX 回放目录响应不是列表。');
    const windowStart = Date.parse(start), windowEnd = Date.parse(end);
    return rows.flatMap(row => {
      const startMs = Date.parse(row?.start), duration = Number(row?.duration), endMs = startMs + duration * 1000;
      if (!Number.isFinite(startMs) || !Number.isFinite(duration) || !Number.isFinite(endMs) || duration <= 0 || duration > maxDuration) return [];
      const clippedStart = Math.max(startMs, windowStart), clippedEnd = Math.min(endMs, windowEnd);
      if (clippedEnd <= clippedStart) return [];
      return [{ start: new Date(clippedStart).toISOString(), duration: (clippedEnd - clippedStart) / 1000 }];
    }).sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  }
  return {
    async list(cameraId, date, { signal } = {}) {
      const safeDate = validatedDate(date);
      const start = `${safeDate}T00:00:00+08:00`;
      const next = new Date(Date.parse(start) + 86_400_000);
      const nextDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(next);
      return listWindow(cameraId, start, `${nextDate}T00:00:00+08:00`, { signal, maxDuration: 86_400 });
    },
    /** Fast catalog preflight, expressed on the same wall-clock axis as archive filenames. */
    async listRange(cameraId, start, end, { signal } = {}) {
      const { startMs, endMs } = wallRange(start, end);
      try {
        const rows = await listWindow(cameraId,
          new Date(startMs - PLAYBACK_WALL_OFFSET_MS).toISOString(),
          new Date(endMs - PLAYBACK_WALL_OFFSET_MS).toISOString(), { signal });
        return rows.map(row => {
          const startMs = Date.parse(row.start) + PLAYBACK_WALL_OFFSET_MS;
          return { startMs, endMs: startMs + row.duration * 1000 };
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const timeout = error.name === 'AbortError' || error.name === 'TimeoutError';
        throw Object.assign(new Error(timeout ? 'MediaMTX 录像目录查询超时，请稍后重试。' : '无法核验 MediaMTX 录像目录，请稍后重试。'), { status: timeout ? 504 : 502 });
      }
    },
    async get(cameraId, start, duration, { format = 'fmp4', signal } = {}) {
      if (typeof cameraId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cameraId)) throw new Error('摄像头编号无效。');
      const startMs = Date.parse(start), seconds = Number(duration);
      if (!Number.isFinite(startMs) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 21_600) throw new Error('回放时间或时长无效。');
      if (!['fmp4', 'mp4'].includes(format)) throw new Error('回放格式必须为 fmp4 或 mp4。');
      const url = new URL('/get', base);
      url.search = new URLSearchParams({ path: cameraId, start: new Date(startMs).toISOString(), duration: String(seconds), format }).toString();
      return request(url, false, signal);
    },
  };
}


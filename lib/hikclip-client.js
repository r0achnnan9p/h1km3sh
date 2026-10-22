/**
 * 常驻 HTTP 服务的客户端，给 MCP 进程用。
 *
 * MCP 是独立进程，如果它自己 import 导出链路去拉流，就会和常驻服务各持一份
 * activeTasks，互相看不见——两边同时导出会抢 NVR 的回放会话池（池子小、回收
 * 分钟级，见 AGENTS.md），双双严重降速且谁也拦不住谁。所以 MCP 一律把动作
 * 转发给常驻服务，任务状态只有一份。
 *
 * 端口发现顺序：
 *   1. HIKCLIP_BASE_URL 环境变量（跨机部署或非常规端口时用）
 *   2. <dataDir>/service/runtime.json 里的 port —— 服务启动时写的，
 *      端口会自动顺延，这是唯一可靠的来源
 *   3. 从 30001 起顺序探测 10 个端口
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';

const DEFAULT_PORT = 30001;
const PORT_SCAN_ATTEMPTS = 10;
const DEFAULT_TIMEOUT_MS = 20000;

/** 服务写运行时信息的位置（与 lib/service-utils.js 的约定一致）。 */
export function runtimeFilePath() {
  return process.env.HIKVISION_RUNTIME_FILE || path.join(resolveDataDir(), 'service', 'runtime.json');
}

/** 从 runtime.json 读端口，读不到返回 null。 */
export function readRuntimePort(filePath = runtimeFilePath()) {
  try {
    const info = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const port = Number(info?.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

class HikclipError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'HikclipError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export { HikclipError };

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number|null} [deps.readPort]
 * @param {string} [deps.baseUrl] 直接钉死 baseUrl（测试或显式配置）
 */
export function createHikclipClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const readPort = deps.readPort || (() => readRuntimePort());
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const configuredBaseUrl = deps.baseUrl || process.env.HIKCLIP_BASE_URL || null;

  let cachedBaseUrl = configuredBaseUrl ? normalizeBaseUrl(configuredBaseUrl) : null;

  function normalizeBaseUrl(value) {
    const trimmed = String(value).trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  async function alive(baseUrl) {
    try {
      const res = await withTimeout((signal) => fetchImpl(`${baseUrl}/api/status`, { signal }), 2000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function withTimeout(run, ms = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 解析出可用的 baseUrl；解析结果会缓存，请求失败时由 request() 作废。 */
  async function resolveBaseUrl() {
    if (cachedBaseUrl) return cachedBaseUrl;

    const candidates = [];
    const runtimePort = readPort();
    if (runtimePort) candidates.push(`http://127.0.0.1:${runtimePort}`);
    for (let i = 0; i < PORT_SCAN_ATTEMPTS; i++) {
      const url = `http://127.0.0.1:${DEFAULT_PORT + i}`;
      if (!candidates.includes(url)) candidates.push(url);
    }

    for (const candidate of candidates) {
      if (await alive(candidate)) {
        cachedBaseUrl = candidate;
        return candidate;
      }
    }

    throw new HikclipError(
      `找不到正在运行的录像提取服务（试过 ${candidates[0]} 等 ${candidates.length} 个地址）。` +
      `请确认服务已启动（service:status 可查），或设置 HIKCLIP_BASE_URL 指向它。`
    );
  }

  async function request(pathname, { method = 'GET', query, body } = {}) {
    const baseUrl = await resolveBaseUrl();

    let url = `${baseUrl}${pathname}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    let res;
    try {
      res = await withTimeout((signal) => fetchImpl(url, {
        method,
        signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }));
    } catch (err) {
      // 服务可能重启换了端口，作废缓存让下一次重新发现
      if (!configuredBaseUrl) cachedBaseUrl = null;
      throw new HikclipError(`请求 ${pathname} 失败：${err.message}`, { cause: err });
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      throw new HikclipError(`${pathname} 返回的不是 JSON（HTTP ${res.status}）`, { status: res.status, cause: err });
    }

    if (!res.ok || payload?.success === false) {
      let error = String(payload?.error || `${pathname} 失败（HTTP ${res.status}）`);
      for (const secret of [query?.pass, query?.user, body?.pass, body?.user]) {
        if (secret) error = error.replaceAll(secret, '[已隐藏]');
      }
      throw new HikclipError(error, { status: res.status });
    }

    return payload;
  }

  return {
    resolveBaseUrl,
    request,

    listCameras() { return request('/api/cameras'); },
    startCameraJob(operation, args) {
      if (!['clip', 'snapshot', 'timeline', 'match'].includes(operation)) throw new HikclipError('未知摄像头操作。');
      return request(`/api/cameras/${operation}`, { method: 'POST', body: args });
    },

    /** 当前激活设备（含密码——只在本进程内用于拼请求，绝不能回给模型）。 */
    async getActiveDevice() {
      const { device } = await request('/api/devices/active');
      if (!device) {
        throw new HikclipError('还没有配置录像机。请先在 Web 界面顶栏点「+」添加设备并激活。');
      }
      return device;
    },

    listChannels(device) {
      return request('/api/channels', {
        query: { ip: device.ip, user: device.username, pass: device.password },
      });
    },

    listRecordings(device, { channel, startTime, endTime }) {
      return request('/api/recordings', {
        query: { ip: device.ip, user: device.username, pass: device.password, channel, startTime, endTime },
      });
    },

    startExport(device, { channel, startTime, endTime, method }) {
      return request('/api/export', {
        method: 'POST',
        body: {
          ip: device.ip, httpPort: device.httpPort, rtspPort: device.rtspPort, deviceId: device.id, user: device.username, pass: device.password,
          channel, startTime, endTime, method,
        },
      });
    },

    getStatus() {
      return request('/api/status');
    },

    stopExport(taskId) {
      return request('/api/export/stop', { method: 'POST', body: { taskId } });
    },

    listOutputs(limit) {
      return request('/api/outputs', { query: { limit } });
    },
  };
}

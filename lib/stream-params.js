import { deviceHttpOrigin, deviceEndpointIdentity } from './device-endpoint.js';
/**
 * Stream Parameter Lookup
 *
 * 查询通道的编码参数（ISAPI GET /ISAPI/Streaming/channels/{track}）。
 * 目前只用到帧率：预览用 `-re` 按帧率节流，帧率取错会让播放整体偏快或偏慢，
 * 偏慢还会持续给 RTSP socket 施加背压。
 *
 * 海康 maxFrameRate 是 fps×100（2000 = 20fps）；0 表示「不限制/全帧率」，
 * 此时只能回落到默认值。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_PREVIEW_FPS = 20;

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // `${ip}/${track}` -> { fps: number, expiresAt: number }

/**
 * 从通道配置 XML 里取帧率。单独导出以便测试。
 *
 * @param {string} xmlString
 * @returns {number|null} fps；缺失或为 0（不限制）时返回 null
 */
export function parseMaxFrameRate(xmlString) {
  const m = /<maxFrameRate>(\d+)<\/maxFrameRate>/.exec(xmlString || '');
  if (!m) return null;
  const fps = parseInt(m[1], 10) / 100;
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) return null;
  return fps;
}

/**
 * 查询某 track 的帧率，失败或设备未限制帧率时返回 DEFAULT_PREVIEW_FPS。
 *
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @param {string} track - 如 "201" / "202"
 * @returns {Promise<number>}
 */
export async function getChannelFps(ip, user, pass, track, httpPort) {
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  const key = `${deviceEndpointIdentity(endpoint)}/${track}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.fps;

  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  let fps = DEFAULT_PREVIEW_FPS;
  try {
    const { stdout } = await execFileAsync(curlCmd, [
      '--connect-timeout', '5',
      '-s',
      '--digest',
      '-u', `${user}:${pass}`,
      `${deviceHttpOrigin(endpoint)}/ISAPI/Streaming/channels/${track}`,
    ], { timeout: 15000 });
    fps = parseMaxFrameRate(stdout) || DEFAULT_PREVIEW_FPS;
  } catch (_) {
    // 查不到就用默认值
  }

  cache.set(key, { fps, expiresAt: Date.now() + CACHE_TTL_MS });
  return fps;
}

/** 测试用：清空缓存 */
export function clearStreamParamCache() {
  cache.clear();
}


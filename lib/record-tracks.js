import { deviceHttpOrigin, deviceEndpointIdentity } from './device-endpoint.js';
/**
 * Record Track Discovery
 *
 * 查询 NVR 上实际存在录像 track 的列表（ISAPI GET /ISAPI/ContentMgmt/record/tracks），
 * 用于判断某通道是否录了子码流。
 *
 * 海康 trackID 约定：通道 N 的主码流 = N*100+1，子码流 = N*100+2。
 * 只有开启「双码流录像」的设备才会有 N*100+2 这个 track——没开时对该 track
 * 发搜索请求，设备直接返回 badXmlContent（实测 DS-7808N-Q1 V4.82.100）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import xml2js from 'xml2js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // ip -> { tracks: Map<string, {fps}>, expiresAt: number }

/**
 * 从 Track 的 Description 里取帧率。设备实测给的是：
 *   "trackType=standard,contentType=video,codecType=H.264-BP,
 *    resolution=3200x1800,framerate=25.0 fps,bitrate=8192 kbps"
 * 比 Streaming/channels 的 maxFrameRate 可靠——后者在「全帧率」时报 0。
 *
 * @param {string} description
 * @returns {number|null}
 */
export function parseTrackFrameRate(description) {
  const m = /framerate=([\d.]+)\s*fps/i.exec(description || '');
  if (!m) return null;
  const fps = parseFloat(m[1]);
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) return null;
  return fps;
}

/**
 * 解析 record/tracks 响应，取出每个 track 的 id 与帧率。
 * 单独导出以便测试。
 *
 * @param {string} xmlString
 * @returns {Promise<Map<string, { fps: number|null }>>}
 */
export async function parseRecordTracks(xmlString) {
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlString);

  const list = result?.TrackList?.Track;
  if (!list) return new Map();

  const items = Array.isArray(list) ? list : [list];
  const out = new Map();
  for (const t of items) {
    if (!t || t.id == null) continue;
    out.set(String(t.id), { fps: parseTrackFrameRate(t.Description) });
  }
  return out;
}

/**
 * 列出设备上存在的录像 track 及其帧率（带 5 分钟内存缓存）。
 * 查询失败时返回空表——调用方按「无法确认」处理，回落到主码流。
 *
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @returns {Promise<Map<string, { fps: number|null }>>}
 */
export async function listRecordTracks(ip, user, pass, httpPort) {
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  const key = deviceEndpointIdentity(endpoint);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.tracks;

  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  let tracks = new Map();
  try {
    const { stdout } = await execFileAsync(curlCmd, [
      '--connect-timeout', '5',
      '-s',
      '--digest',
      '-u', `${user}:${pass}`,
      `${deviceHttpOrigin(endpoint)}/ISAPI/ContentMgmt/record/tracks`,
    ], { timeout: 15000 });
    tracks = await parseRecordTracks(stdout);
  } catch (_) {
    // 探测失败不算错误，调用方回落到主码流
  }

  cache.set(key, { tracks, expiresAt: Date.now() + CACHE_TTL_MS });
  return tracks;
}

/**
 * 由主码流 track 推出同通道的子码流 track。
 *
 * @param {string} channel - 如 "201"
 * @returns {string|null} 如 "202"；channel 不像主码流 track 时返回 null
 */
export function substreamTrackOf(channel) {
  const n = Number(channel);
  if (!Number.isInteger(n) || n < 100 || n % 100 !== 1) return null;
  return String(n + 1);
}

/**
 * 选择预览该用哪个 track：子码流录了就用子码流（码率通常低一个数量级），
 * 否则用传入的主码流 track。同时带回该 track 的帧率（拿不到时为 null，
 * 调用方需自行回落）。
 *
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @param {string} channel
 * @returns {Promise<{ track: string, isSubstream: boolean, fps: number|null }>}
 */
export async function resolvePreviewTrack(ip, user, pass, channel, httpPort) {
  const main = String(channel);
  const sub = substreamTrackOf(channel);
  if (!sub) return { track: main, isSubstream: false, fps: null };

  const tracks = await listRecordTracks(ip, user, pass, httpPort);
  if (tracks.has(sub)) {
    return { track: sub, isSubstream: true, fps: tracks.get(sub).fps };
  }
  return { track: main, isSubstream: false, fps: tracks.get(main)?.fps ?? null };
}

/** 测试用：清空缓存 */
export function clearRecordTrackCache() {
  cache.clear();
}


import { deviceHttpOrigin } from './device-endpoint.js';
/**
 * Recording Search Module
 *
 * Searches DVR recordings via ISAPI POST /ISAPI/ContentMgmt/search.
 * Uses curl with --digest for HTTP Digest Authentication.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import xml2js from 'xml2js';

const execFileAsync = promisify(execFile);

// Short-lived, server-only reuse of searches already requested by the console.
// Never persisted, exposed, or used to redirect a connection.
const recentSearches = new Map();
const SEARCH_CACHE_TTL_MS = 60_000;
function searchCacheKey({ ip, httpPort, user, pass, channel }) {
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  return createHash('sha256').update(JSON.stringify([deviceHttpOrigin(endpoint), user, pass, String(channel)])).digest('hex');
}
function pruneSearchCache(now) {
  for (const [key, value] of recentSearches) if (now - value.savedAt >= SEARCH_CACHE_TTL_MS) recentSearches.delete(key);
}
export function rememberRecordingSearch(options, files, now = Date.now()) {
  if (!Array.isArray(files) || files.length > 512 || files.some(file => typeof file?.playbackURI !== 'string' || file.playbackURI.length > 8192)) return;
  const startMs = Date.parse(options.startTime), endMs = Date.parse(options.endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
  pruneSearchCache(now);
  const key = searchCacheKey(options);
  if (!recentSearches.has(key) && recentSearches.size >= 16) recentSearches.delete(recentSearches.keys().next().value);
  recentSearches.set(key, { savedAt: now, startMs, endMs, files: files.map(file => ({ playbackURI: file.playbackURI,
    startTime: file.startTime, endTime: file.endTime, size: file.size, channel: file.channel })) });
}
export function cachedRecordingSearch(options, now = Date.now()) {
  pruneSearchCache(now);
  const cached = recentSearches.get(searchCacheKey(options));
  const startMs = Date.parse(options.startTime), endMs = Date.parse(options.endTime);
  if (!cached || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
      || cached.startMs > startMs || cached.endMs < endMs) return null;
  return cached.files.map(file => ({ ...file }));
}


/**
 * @typedef {Object} RecordingFile
 * @property {string} playbackURI - DVR 返回的完整 playbackURI
 * @property {string} startTime - ISO 格式: "2026-05-07T17:58:17Z"
 * @property {string} endTime - ISO 格式: "2026-05-07T18:13:47Z"
 * @property {number} size - 文件大小（字节），从 playbackURI 的 size 参数提取
 * @property {string} channel - 通道号，如 "201"
 */

/**
 * Build the XML request body for ISAPI ContentMgmt/search.
 *
 * @param {string} searchID - UUID for this search session
 * @param {string} trackID - Channel/track ID (e.g. "201")
 * @param {string} startTime - ISO start time
 * @param {string} endTime - ISO end time
 * @param {number} maxResults - Max results per page
 * @param {number} searchResultPosition - Pagination offset (0-based)
 * @returns {string} XML request body
 */
export function buildSearchXml(searchID, trackID, startTime, endTime, maxResults, searchResultPosition) {
  return `<CMSearchDescription><searchID>${searchID}</searchID><trackList><trackID>${trackID}</trackID></trackList><timeSpanList><timeSpan><startTime>${startTime}</startTime><endTime>${endTime}</endTime></timeSpan></timeSpanList><maxResults>${maxResults}</maxResults><searchResultPostion>${searchResultPosition}</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
}

/**
 * Extract the `size` parameter from a playbackURI string.
 *
 * @param {string} uri - playbackURI like "rtsp://ip/Streaming/tracks/201/?starttime=...&size=929491916"
 * @returns {number} File size in bytes, or 0 if not found
 */
export function extractSizeFromURI(uri) {
  const match = uri.match(/[?&]size=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse ISAPI search response XML and extract recording file information.
 * Exported separately for independent testing.
 *
 * @param {string} xmlString - Raw XML response from ISAPI search
 * @param {string} channel - Channel ID to attach to results
 * @returns {Promise<{ files: RecordingFile[], numOfMatches: number, totalMatches: number }>}
 */
export async function parseSearchResponse(xmlString, channel) {
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlString);

  const searchResult = result.CMSearchResult;
  if (!searchResult) {
    throw new Error('Invalid search response: missing CMSearchResult');
  }

  const responseStatus = searchResult.responseStatus;
  if (responseStatus === 'false' || responseStatus === 'NO MATCHES') {
    return { files: [], numOfMatches: 0, totalMatches: 0 };
  }

  const numOfMatches = parseInt(searchResult.numOfMatches || '0', 10);
  const totalMatches = parseInt(searchResult.totalMatches || numOfMatches.toString(), 10);

  if (numOfMatches === 0) {
    return { files: [], numOfMatches: 0, totalMatches };
  }

  const matchList = searchResult.matchList;
  if (!matchList || !matchList.searchMatchItem) {
    return { files: [], numOfMatches: 0, totalMatches };
  }

  const items = Array.isArray(matchList.searchMatchItem)
    ? matchList.searchMatchItem
    : [matchList.searchMatchItem];

  const files = items.map(item => {
    const timeSpan = item.timeSpan || {};
    const mediaDesc = item.mediaSegmentDescriptor || {};
    const playbackURI = mediaDesc.playbackURI || item.playbackURI || '';
    const startTime = timeSpan.startTime || '';
    const endTime = timeSpan.endTime || '';
    const size = extractSizeFromURI(playbackURI);

    return {
      playbackURI,
      startTime,
      endTime,
      size,
      channel: channel || '',
    };
  });

  return { files, numOfMatches, totalMatches };
}

/**
 * Search DVR recordings for a given time range.
 * Supports pagination (maxResults=40 per page).
 * Returns results sorted by startTime ascending.
 *
 * @param {string} ip - DVR IP address
 * @param {string} user - Username
 * @param {string} pass - Password
 * @param {string} channel - Channel/track ID (e.g. "201")
 * @param {string} startTime - ISO start time (e.g. "2026-05-07T00:00:00Z")
 * @param {string} endTime - ISO end time (e.g. "2026-05-07T23:59:59Z")
 * @returns {Promise<RecordingFile[]>} Recording files sorted by startTime ascending
 * @throws {Error} Descriptive error on failure
 */
export async function searchRecordings(ip, user, pass, channel, startTime, endTime, httpPort) {
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  const origin = deviceHttpOrigin(endpoint);
  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const searchID = randomUUID();
  const maxResults = 40;
  let searchResultPosition = 0;
  let allFiles = [];
  let totalMatches = Infinity; // Will be set from first response

  while (allFiles.length < totalMatches) {
    const xmlBody = buildSearchXml(searchID, channel, startTime, endTime, maxResults, searchResultPosition);

    // Write XML body to a temp file for curl --data-binary @file
    const tempFile = join(tmpdir(), `isapi_search_${randomUUID()}.xml`);
    writeFileSync(tempFile, xmlBody, 'utf-8');

    let stdout;
    try {
      const args = [
        '--connect-timeout', '5',
        '-s',
        '--digest',
        '-u', `${user}:${pass}`,
        '-X', 'POST',
        '-H', 'Content-Type: application/xml',
        '--data-binary', `@${tempFile}`,
        `${origin}/ISAPI/ContentMgmt/search`,
      ];

      const result = await execFileAsync(curlCmd, args, { timeout: 15000 });
      stdout = result.stdout;
    } catch (err) {
      // Clean up temp file
      try { unlinkSync(tempFile); } catch (_) {}

      // Classify error
      if (err.killed || err.signal === 'SIGTERM') {
        throw new Error('连接超时，请检查网络连通性');
      }
      if (err.code === 'ETIMEDOUT' || err.code === 28) {
        throw new Error('连接超时，请检查网络连通性');
      }
      throw new Error('搜索请求失败，请检查设备连接和凭据');
    } finally {
      // Clean up temp file
      try { unlinkSync(tempFile); } catch (_) {}
    }

    // Check for HTTP error responses in the raw output
    if (!stdout || stdout.trim() === '') {
      throw new Error('搜索请求返回空响应');
    }

    // Check for error responses - only when the response is a ResponseStatus XML (not a CMSearchResult)
    // We must be careful not to match substrings in playbackURI (e.g., name=00000000404000000)
    if (stdout.includes('<ResponseStatus') || stdout.includes('<statusCode>')) {
      if (stdout.includes('<subStatusCode>notSupport</subStatusCode>') || stdout.includes('<statusCode>5</statusCode>')) {
        throw new Error('该设备不支持录像文件直接下载（ISAPI ContentMgmt/search 返回 notSupport），请使用 RTSP 方式');
      }
      if (stdout.includes('<statusCode>4</statusCode>') || stdout.includes('<statusString>Unauthorized</statusString>')) {
        throw new Error('认证失败，请检查用户名或密码');
      }
      if (stdout.includes('<statusCode>6</statusCode>')) {
        throw new Error('搜索请求 XML 格式错误（badXmlContent）');
      }
    }

    // Parse the XML response
    let parsed;
    try {
      parsed = await parseSearchResponse(stdout, channel);
    } catch (parseErr) {
      throw new Error(`解析搜索响应失败: ${parseErr.message}`);
    }

    // Update totalMatches from first response
    if (totalMatches === Infinity) {
      totalMatches = parsed.totalMatches;
    }

    // No matches at all
    if (parsed.numOfMatches === 0 && allFiles.length === 0) {
      throw new Error('该时间段内无可用录像');
    }

    // No more results in this page (end of pagination)
    if (parsed.numOfMatches === 0 || parsed.files.length === 0) {
      break;
    }

    allFiles = allFiles.concat(parsed.files);
    searchResultPosition += parsed.files.length;

    // If we got fewer results than maxResults, we've reached the end
    if (parsed.files.length < maxResults) {
      break;
    }
  }

  // Sort by startTime ascending
  allFiles.sort((a, b) => {
    if (a.startTime < b.startTime) return -1;
    if (a.startTime > b.startTime) return 1;
    return 0;
  });

  rememberRecordingSearch({ ip, httpPort, user, pass, channel, startTime, endTime }, allFiles);
  return allFiles;
}


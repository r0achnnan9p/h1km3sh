/**
 * Closed, URL-free recording facts for failed DVR exports. This module never
 * connects to a device, follows playbackURI, or changes the original records.
 */
import { normalizeDeviceEndpoint } from './device-endpoint.js';
import { compactToMs } from './hik-time.js';

const MAX_RECORDINGS = 3;
const MAX_MATCHES = 10_000;
const MAX_URI_LENGTH = 8192;
const MAX_QUERY_KEYS = 128;
const OUTCOMES = new Set(['available', 'no_match', 'timeout', 'cancelled', 'authentication', 'unsupported', 'invalid', 'failed']);
const PATH_STYLES = new Set(['tracks', 'isapi_tracks', 'other', 'invalid']);
const URI_RANGES = new Set(['exact', 'covers', 'partial', 'outside', 'invalid']);
const QUERY_KEYS = new Set(['starttime', 'endtime', 'name', 'size']);

function isObject(value) {
  return value !== null && typeof value === 'object';
}

// No spread, destructuring, array iteration, getters, coercion or serializers
// from untrusted input. A revoked/throwing proxy is simply invalid input.
function own(value, key) {
  if (!isObject(value)) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

function isArray(value) {
  try { return Array.isArray(value); } catch { return false; }
}

function count(value, limit) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, limit) : 0;
}

function numberOrNull(value, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value)) ? value : null;
}

const booleanOrNull = value => typeof value === 'boolean' ? value : null;

// Literal Z is recorder-local wall time. It is only a common arithmetic axis,
// never an instruction to convert to/from the server's or recorder's timezone.
function wallTime(value, allowCompact = false) {
  if (typeof value !== 'string') return null;
  let iso = value, milliseconds;
  if (allowCompact && /^\d{8}T\d{6}Z$/.test(value)) {
    iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    milliseconds = compactToMs(value);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
    milliseconds = Date.parse(value);
  }
  // Date.parse accepts some impossible calendar dates by rolling them forward.
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== iso.replace(/Z$/, '.000Z')) return null;
  return milliseconds;
}

function timeRange(start, end, allowCompact = false) {
  const from = wallTime(start, allowCompact), to = wallTime(end, allowCompact);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

const overlaps = (a, b) => a.from < b.to && a.to > b.from;
const sameRange = (a, b) => a.from === b.from && a.to === b.to;

function rangeRelation(uri, requested) {
  if (!uri || !requested) return 'invalid';
  if (sameRange(uri, requested)) return 'exact';
  if (uri.from <= requested.from && uri.to >= requested.to) return 'covers';
  return overlaps(uri, requested) ? 'partial' : 'outside';
}

function channelId(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function endpoint(ip, rtspPort) {
  if (typeof ip !== 'string' || ip.length > 300
    || !(rtspPort === undefined || typeof rtspPort === 'number' || typeof rtspPort === 'string')
    || (typeof rtspPort === 'string' && rtspPort.length > 16)) return null;
  try { return normalizeDeviceEndpoint({ ip, rtspPort }); } catch { return null; }
}

function sameHost(a, b) {
  // normalizeDeviceEndpoint validates/lowercases names; URL canonicalizes only
  // equivalent IPv6 spellings here. Neither operation performs DNS or I/O.
  const canonical = ip => ip.includes(':') ? new URL(`rtsp://[${ip}]/`).hostname : ip;
  return canonical(a.ip) === canonical(b.ip);
}

function emptyUriFacts() {
  return {
    uriDurationSeconds: null, pathStyle: 'invalid', trailingSlash: null,
    channelMatches: null, sameHost: null, sameRtspPort: null,
    embeddedCredentials: null, hasName: false, hasSize: false,
    unknownQueryKeys: 0, uriRange: 'invalid', uriMatchesSearchRange: null,
  };
}

function uriFacts(value, requestedChannel, configured, requested, searched) {
  const facts = emptyUriFacts();
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH
    || /[\s\x00-\x1f\x7f\\]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return facts;
  // Read the original path, rather than URL's dot-segment-normalized path. Do
  // not turn an unusual device selector into a seemingly standard track path.
  const parts = /^rtsp:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(value);
  if (!parts) return facts;
  const authority = parts[1], path = parts[2] || '';
  if ((authority.match(/@/g) || []).length > 1 || authority.endsWith(':')) return facts;
  let parsed, returned;
  try {
    parsed = new URL(value);
    returned = endpoint(parsed.hostname, parsed.port === '' ? undefined : parsed.port);
  } catch { return facts; }
  if (!returned) return facts;

  const track = /^\/(ISAPI\/)?Streaming\/tracks\/(\d{1,16})(\/)?$/.exec(path);
  facts.pathStyle = track ? (track[1] ? 'isapi_tracks' : 'tracks') : 'other';
  facts.trailingSlash = path.endsWith('/');
  facts.channelMatches = track && requestedChannel !== null ? track[2] === requestedChannel : null;
  facts.sameHost = configured ? sameHost(returned, configured) : null;
  facts.sameRtspPort = configured ? returned.rtspPort === configured.rtspPort : null;
  facts.embeddedCredentials = authority.includes('@');

  const query = new URLSearchParams(parts[3] || '');
  let start, end, starts = 0, ends = 0;
  for (const [key, value] of query) {
    if (key === 'name') facts.hasName = true;
    if (key === 'size') facts.hasSize = true;
    if (!QUERY_KEYS.has(key)) facts.unknownQueryKeys = Math.min(MAX_QUERY_KEYS, facts.unknownQueryKeys + 1);
    if (key === 'starttime') { start = value; starts++; }
    if (key === 'endtime') { end = value; ends++; }
  }
  // Duplicate endpoints are ambiguous, even if their values happen to agree.
  const uri = starts === 1 && ends === 1 ? timeRange(start, end, true) : null;
  facts.uriDurationSeconds = uri ? (uri.to - uri.from) / 1000 : null;
  facts.uriRange = rangeRelation(uri, requested);
  facts.uriMatchesSearchRange = uri && searched ? sameRange(uri, searched) : null;
  return facts;
}

/**
 * Summarize overlapping search records, keeping their playbackURI private.
 * Requested/search times support exact second-resolution wall-clock ISO with
 * literal Z. URI times additionally support Hikvision compact wall-clock form.
 * matchCount is capped at 10,000 inspected records; truncated signals bounds.
 */
export function summarizeDvrRecordings(value) {
  const files = own(value, 'files');
  const source = own(value, 'source') === 'cache' ? 'cache' : 'search';
  const summary = { outcome: 'invalid', source, matchCount: 0, truncated: own(value, 'truncated') === true, recordings: [] };
  const requested = timeRange(own(value, 'startTime'), own(value, 'endTime'));
  if (!requested || !isArray(files)) return summary;
  const length = own(files, 'length');
  if (!Number.isSafeInteger(length) || length < 0) return summary;
  summary.truncated ||= length > MAX_RECORDINGS;
  const configured = endpoint(own(value, 'ip'), own(value, 'rtspPort'));
  const requestedChannel = channelId(own(value, 'channel'));
  let invalidRecord = false;
  for (let i = 0; i < Math.min(length, MAX_MATCHES); i++) {
    const file = own(files, String(i));
    const searched = timeRange(own(file, 'startTime'), own(file, 'endTime'));
    if (!searched) { invalidRecord = true; continue; }
    if (!overlaps(searched, requested)) continue;
    summary.matchCount++;
    if (summary.recordings.length >= MAX_RECORDINGS) continue;
    summary.recordings.push({
      durationSeconds: (searched.to - searched.from) / 1000,
      sizeBytes: numberOrNull(own(file, 'size'), true),
      ...uriFacts(own(file, 'playbackURI'), requestedChannel, configured, requested, searched),
    });
  }
  summary.outcome = summary.matchCount > 0 ? 'available' : (invalidRecord || length > MAX_MATCHES ? 'invalid' : 'no_match');
  return summary;
}

function sanitizeRecording(value) {
  if (!isObject(value) || isArray(value)) return null;
  const pathStyle = own(value, 'pathStyle'), uriRange = own(value, 'uriRange');
  return {
    durationSeconds: numberOrNull(own(value, 'durationSeconds')),
    uriDurationSeconds: numberOrNull(own(value, 'uriDurationSeconds')),
    sizeBytes: numberOrNull(own(value, 'sizeBytes'), true),
    pathStyle: PATH_STYLES.has(pathStyle) ? pathStyle : 'invalid',
    trailingSlash: booleanOrNull(own(value, 'trailingSlash')),
    channelMatches: booleanOrNull(own(value, 'channelMatches')),
    sameHost: booleanOrNull(own(value, 'sameHost')),
    sameRtspPort: booleanOrNull(own(value, 'sameRtspPort')),
    embeddedCredentials: booleanOrNull(own(value, 'embeddedCredentials')),
    hasName: own(value, 'hasName') === true,
    hasSize: own(value, 'hasSize') === true,
    unknownQueryKeys: count(own(value, 'unknownQueryKeys'), MAX_QUERY_KEYS),
    uriRange: URI_RANGES.has(uriRange) ? uriRange : 'invalid',
    uriMatchesSearchRange: booleanOrNull(own(value, 'uriMatchesSearchRange')),
  };
}

/** Copy only bounded public data properties. Invalid envelopes are omitted. */
export function sanitizeDvrRecordingDiagnostics(value) {
  if (!isObject(value) || isArray(value)) return undefined;
  const outcome = own(value, 'outcome');
  if (!OUTCOMES.has(outcome)) return undefined;
  const input = own(value, 'recordings'), length = isArray(input) ? own(input, 'length') : 0;
  const recordings = [];
  for (let i = 0; i < Math.min(count(length, MAX_RECORDINGS), MAX_RECORDINGS); i++) {
    const recording = sanitizeRecording(own(input, String(i)));
    if (recording) recordings.push(recording);
  }
  const rawCount = own(value, 'matchCount');
  const downloadByTime = own(value, 'downloadByTime');
  return {
    ...(['supported', 'unsupported', 'unknown'].includes(downloadByTime) ? { downloadByTime } : {}),
    outcome,
    source: own(value, 'source') === 'cache' ? 'cache' : 'search',
    matchCount: count(rawCount, MAX_MATCHES),
    truncated: own(value, 'truncated') === true || (Number.isSafeInteger(length) && length > MAX_RECORDINGS)
      || (Number.isSafeInteger(rawCount) && rawCount > MAX_RECORDINGS),
    recordings,
  };
}

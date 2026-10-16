/** One explicitly authorized, private, bounded HTTP compatibility sample.
 * This is not an export or a proof of the selected wall-clock interval.
 * The caller owns queue admission and the durable, one-shot authorization gate.
 */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnExportProcess } from './export-process-lock.js';
import { deviceHttpOrigin, normalizeDeviceEndpoint } from './device-endpoint.js';
import { cachedRecordingSearch } from './recording-search.js';
import { searchRecordingPage } from './dvr-recording-inspection.js';
import { summarizeDvrRecordings } from './dvr-recording-diagnostics.js';

export const DVR_HTTP_SAMPLE_MAX_BYTES = 32_000_000;
export const DVR_HTTP_SAMPLE_TIMEOUT_MS = 20_000;
const HEADER_LIMIT = 32_768;
const FRAME_LIMIT = 1000;
const OUTCOMES = new Set(['decoded', 'undecodable', 'no_match', 'invalid', 'authentication', 'http_error', 'timeout', 'cancelled', 'failed', 'cleanup_failed']);
const STOPS = new Set(['eof', 'byte_limit', 'time_limit', 'cancelled', 'http_error', 'invalid_response', 'no_match', 'invalid_recording', 'transport_error', 'probe_limit', 'decode_limit']);
const PHASES = new Set(['search', 'private_setup', 'checkpoint', 'transfer', 'probe', 'decode', 'cleanup']);
const MEDIA = new Set(['mpegps', 'mpegts', 'mp4', 'matroska', 'avi', 'h264', 'hevc', 'mpegvideo']);
const VIDEO = new Set(['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4', 'mjpeg', 'vp8', 'vp9', 'av1', 'rawvideo']);
const AUDIO = new Set(['aac', 'mp2', 'mp3', 'pcm_alaw', 'pcm_mulaw', 'pcm_s16le', 'pcm_s16be', 'opus', 'vorbis', 'ac3', 'eac3', 'adpcm_ima_wav']);
function own(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
const bounded = (value, min, max, integer = true) => typeof value === 'number' && Number.isFinite(value)
  && value >= min && value <= max && (!integer || Number.isSafeInteger(value)) ? value : null;
const choice = (set, value) => set.has(value) ? value : null;
const blank = (outcome = 'failed', stopReason = 'transport_error') => ({ outcome, stopReason, httpStatus: null,
  bytes: 0, mediaType: null, videoCodec: null, audioCodec: null, width: null, height: null,
  decodedFrames: 0, firstPtsSeconds: null, lastPtsSeconds: null });

/** Never invokes getters, coercion, toJSON, or copies arbitrary input fields. */
export function sanitizeDvrHttpSample(value) {
  const outcome = own(value, 'outcome'), stopReason = own(value, 'stopReason');
  if (!OUTCOMES.has(outcome) || !STOPS.has(stopReason)) return undefined;
  const phase = own(value, 'phase'), curlExitCode = own(value, 'curlExitCode');
  return { outcome, stopReason,
    ...(PHASES.has(phase) ? { phase } : {}),
    ...(curlExitCode !== undefined ? { curlExitCode: bounded(curlExitCode, 0, 255) } : {}),
    httpStatus: bounded(own(value, 'httpStatus'), 100, 599),
    bytes: bounded(own(value, 'bytes'), 0, DVR_HTTP_SAMPLE_MAX_BYTES) ?? 0,
    mediaType: choice(MEDIA, own(value, 'mediaType')),
    videoCodec: choice(VIDEO, own(value, 'videoCodec')),
    audioCodec: choice(AUDIO, own(value, 'audioCodec')),
    width: bounded(own(value, 'width'), 1, 16_384), height: bounded(own(value, 'height'), 1, 16_384),
    decodedFrames: bounded(own(value, 'decodedFrames'), 0, FRAME_LIMIT) ?? 0,
    firstPtsSeconds: bounded(own(value, 'firstPtsSeconds'), 0, 86_400, false),
    lastPtsSeconds: bounded(own(value, 'lastPtsSeconds'), 0, 86_400, false),
  };
}
function wall(value) {
  if (typeof value !== 'string') return null;
  let iso = value;
  if (/^\d{8}T\d{6}Z$/.test(value)) iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso.replace('Z', '.000Z') ? { iso, ms } : null;
}
function resolveRecording(files, query) {
  if (!Array.isArray(files) || files.length > 512) return { invalid: true };
  let invalid = false;
  for (const file of files) {
    const from = wall(own(file, 'startTime')), to = wall(own(file, 'endTime'));
    if (!from || !to || to.ms <= from.ms) { invalid = true; continue; }
    if (from.ms > Date.parse(query.startTime) || to.ms < Date.parse(query.endTime)) continue;
    const facts = summarizeDvrRecordings({ ...query, files: [file] }).recordings[0];
    if (facts?.sameHost !== true || facts.sameRtspPort !== true || facts.channelMatches !== true
      || facts.embeddedCredentials !== false || !['tracks', 'isapi_tracks'].includes(facts.pathStyle)
      || !['exact', 'covers'].includes(facts.uriRange)) { invalid = true; continue; }
    return { uri: own(file, 'playbackURI') };
  }
  return { invalid };
}
const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const limit = (value, fallback) => Number.isInteger(value) && value > 0 && value <= fallback ? value : fallback;
const kill = child => { try { child.kill('SIGKILL'); } catch {} };

/** Bounded local/search subprocess: always waits for close, including abort/error. */
function captured(binary, args, { spawn, signal, timeoutMs, maxBytes = 65_536, onLine } = {}) {
  if (signal?.aborted) return Promise.resolve({ reason: 'cancelled', code: null, stdout: '' });
  return new Promise(resolve => {
    let child, reason, timer, size = 0, chunks = [], pending = '', settled = false;
    const stop = why => { if (!reason) reason = why; if (child) { kill(child); child.stdout?.destroy(); } };
    const abort = () => stop('cancelled');
    const finish = code => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (onLine && pending && !reason) onLine(pending);
      resolve({ reason, code, stdout: onLine ? '' : Buffer.concat(chunks).toString('utf8') });
    };
    try { child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { resolve({ reason: 'error', code: null, stdout: '' }); return; }
    child.once('error', () => { reason ||= 'error'; });
    child.once('close', finish);
    child.stderr?.on('data', () => {}); // Raw diagnostics never leave the child boundary.
    child.stdout.on('error', () => stop('error'));
    child.stdout.on('data', chunk => {
      if (reason) return;
      size += chunk.length;
      if (size > maxBytes) { stop('limit'); return; }
      if (!onLine) chunks.push(Buffer.from(chunk));
      else {
        pending += chunk.toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          onLine(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
        if (pending.length > 8192) stop('limit');
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal?.aborted) abort();
  });
}

/** Parse curl --include output. Curl suppresses the body of its Digest challenge.
 * Header bytes are bounded separately; Content-Length is deliberately ignored.
 */
function transfer({ spawn, args, signal, fd, maxBytes }) {
  return new Promise(resolve => {
    let child, settled = false, reason, code, bytes = 0, status = null, contentType = null;
    let header = Buffer.alloc(0), headerBytes = 0, headers = true, blocks = 0;
    const stop = why => {
      if (!reason) reason = why;
      if (child) { kill(child); child.stdout?.destroy(); }
    };
    const abort = () => stop('cancelled');
    const finish = exitCode => {
      if (settled) return; settled = true; code = exitCode;
      signal?.removeEventListener('abort', abort);
      if (!reason) {
        if (status === 401 || status === 403) reason = 'http_error';
        else if (code !== 0) reason = code === 28 ? 'time_limit' : 'transport_error';
        else if (headers || status !== 200) reason = 'invalid_response';
        else reason = 'eof';
      }
      resolve({ reason, code, bytes, status, contentType });
    };
    try { child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args,
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { resolve({ reason: 'transport_error', code: null, bytes, status, contentType }); return; }
    child.once('error', () => { reason ||= 'transport_error'; });
    child.once('close', finish);
    child.stderr?.on('data', () => {});
    child.stdout.on('error', () => stop('transport_error'));
    child.stdout.on('data', chunk => {
      if (reason) return;
      let rest = chunk;
      while (headers && rest.length && !reason) {
        // Append only through the next header terminator; never concatenate a
        // potentially huge media chunk into the bounded header buffer.
        const room = HEADER_LIMIT - headerBytes;
        const take = Math.min(rest.length, room);
        if (take <= 0) { stop('invalid_response'); return; }
        const candidate = Buffer.concat([header, rest.subarray(0, take)]);
        const end = candidate.indexOf('\r\n\r\n');
        if (end < 0) {
          header = candidate; headerBytes += take; rest = rest.subarray(take);
          if (headerBytes >= HEADER_LIMIT) stop('invalid_response');
          continue;
        }
        const consumed = end + 4 - header.length;
        headerBytes += consumed; rest = rest.subarray(consumed);
        const lines = candidate.subarray(0, end).toString('latin1').split('\r\n'); header = Buffer.alloc(0);
        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e]*)?$/.exec(lines.shift());
        if (!match || ++blocks > 4 || lines.some(line => !/^[!#$%&'*+.^_`|~\w-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))) { stop('invalid_response'); return; }
        status = Number(match[1]);
        const types = lines.filter(line => /^content-type:/i.test(line));
        if (types.length > 1) { stop('invalid_response'); return; }
        contentType = types.length ? types[0].slice(types[0].indexOf(':') + 1).trim().split(';')[0].toLowerCase() : null;
        if (status === 401 && blocks > 1) { stop('http_error'); return; }
        if (status === 100 || status === 401) continue;
        if (status !== 200) { stop('http_error'); return; }
        headers = false;
        if (contentType && (/^text\//.test(contentType) || /(?:xml|json|html)/.test(contentType))) { stop('invalid_response'); return; }
      }
      if (!headers && rest.length && !reason) {
        const accepted = rest.subarray(0, maxBytes - bytes);
        try {
          let offset = 0;
          while (offset < accepted.length) offset += fs.writeSync(fd, accepted, offset, accepted.length - offset);
        } catch { stop('transport_error'); return; }
        bytes += accepted.length;
        if (bytes >= maxBytes) stop('byte_limit');
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function looksLikeMedia(file) {
  const fd = fs.openSync(file, 'r');
  const prefix = Buffer.alloc(1024); let count;
  try { count = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
  const p = prefix.subarray(0, count);
  if (p.length < 4 || /^[\s\uFEFF]*[<{\[]/.test(p.toString('utf8', 0, Math.min(128, count)))) return false;
  if (p.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true;
  if (p.toString('ascii', 0, 4) === 'RIFF' && p.toString('ascii', 8, 12) === 'AVI ') return true;
  if (['ftyp', 'styp', 'moov', 'mdat', 'wide', 'free'].includes(p.toString('ascii', 4, 8))) return true;
  if ((p[0] === 0x47 && p[188] === 0x47) || (p[4] === 0x47 && p[196] === 0x47)) return true;
  return p[0] === 0 && p[1] === 0 && (p[2] === 1 || (p[2] === 0 && p[3] === 1));
}
function mediaName(name) {
  const formats = { mpeg: 'mpegps', mpegts: 'mpegts', 'mov,mp4,m4a,3gp,3g2,mj2': 'mp4', mov: 'mp4', mp4: 'mp4',
    'matroska,webm': 'matroska', matroska: 'matroska', avi: 'avi', h264: 'h264', hevc: 'hevc', mpegvideo: 'mpegvideo' };
  return Object.hasOwn(formats, name) ? formats[name] : null;
}
const localInput = ['-max_alloc', '67108864', '-max_pixels', '16777216', '-threads', '1', '-protocol_whitelist', 'file',
  '-format_whitelist', 'mpeg,mpegts,mov,matroska,webm,avi,h264,hevc,mpegvideo', '-probesize', '1000000', '-analyzeduration', '1000000'];
async function decode(file, report, options, deps) {
  report.phase = 'probe';
  if (!looksLikeMedia(file)) { report.outcome = 'undecodable'; return; }
  const common = { spawn: deps.spawn, signal: options.signal };
  const probe = await captured(options.ffprobePath || 'ffprobe', ['-v', 'error', ...localInput,
    '-show_entries', 'format=format_name:stream=codec_type,codec_name,width,height', '-of', 'json', file],
  { ...common, timeoutMs: limit(deps.probeTimeoutMs, 5000) });
  if (options.signal?.aborted) { report.outcome = 'cancelled'; report.stopReason = 'cancelled'; return; }
  if (probe.reason || probe.code !== 0) {
    report.outcome = 'undecodable'; if (probe.reason === 'timeout' || probe.reason === 'limit') report.stopReason = 'probe_limit'; return;
  }
  let info;
  try { info = JSON.parse(probe.stdout); } catch { report.outcome = 'undecodable'; return; }
  const streams = Array.isArray(info?.streams) ? info.streams.slice(0, 32) : [];
  const video = streams.find(stream => stream?.codec_type === 'video');
  const audio = streams.find(stream => stream?.codec_type === 'audio');
  report.mediaType = mediaName(info?.format?.format_name);
  report.videoCodec = choice(VIDEO, video?.codec_name); report.audioCodec = choice(AUDIO, audio?.codec_name);
  report.width = bounded(video?.width, 1, 16_384); report.height = bounded(video?.height, 1, 16_384);
  // Bound decoded pixel work as well as compressed input and wall-clock time.
  if (!report.mediaType || !report.videoCodec || !report.width || !report.height || report.width * report.height > 16_777_216) {
    report.outcome = 'undecodable'; return;
  }
  let timeBase = null, first = null, last = null;
  report.phase = 'decode';
  const decoded = await captured(options.ffmpegPath || 'ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error',
    ...localInput, '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn', '-threads', '1', '-frames:v', String(FRAME_LIMIT),
    '-fps_mode', 'passthrough', '-f', 'framehash', '-hash', 'md5', '-'], {
    ...common, timeoutMs: limit(deps.decodeTimeoutMs, 10_000), maxBytes: 256_000,
    onLine: line => {
      const tb = /^#tb 0: (\d+)\/(\d+)$/.exec(line.trim());
      if (tb && Number(tb[2]) > 0) timeBase = Number(tb[1]) / Number(tb[2]);
      const frame = /^0,\s*(-?\d+),\s*(-?\d+),\s*\d+,\s*\d+,\s*[0-9a-f]{32}\s*$/.exec(line);
      if (!frame || report.decodedFrames >= FRAME_LIMIT) return;
      report.decodedFrames++;
      const pts = Number(frame[2]) * timeBase;
      if (timeBase !== null && Number.isFinite(pts)) { if (first === null) first = pts; last = pts; }
    },
  });
  if (options.signal?.aborted) { report.outcome = 'cancelled'; report.stopReason = 'cancelled'; return; }
  report.outcome = report.decodedFrames > 0 ? 'decoded' : 'undecodable';
  if (decoded.reason === 'timeout' || decoded.reason === 'limit') report.stopReason = 'decode_limit';
  if (first !== null && last !== null && last >= first && last - first <= 86_400) {
    report.firstPtsSeconds = 0; report.lastPtsSeconds = Math.round((last - first) * 1e6) / 1e6;
  }
}

/** Called only after the shared kernel lease has been acquired. The supplied
 * root is dedicated to samples; neither arbitrary tmp entries nor symlinks are
 * followed or removed. A missing root is normal on first startup.
 */
export function cleanupInterruptedDvrHttpSamples(privateRoot) {
  try {
    const root = fs.lstatSync(privateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid private sample directory');
    for (const entry of fs.readdirSync(privateRoot, { withFileTypes: true })) {
      if (!/^dvr-http-sample-[A-Za-z0-9]{6}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(privateRoot, entry.name), stat = fs.lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Private sample cleanup failed');
  }
}

/** Optional deps are for isolated fixtures. Their limits can only lower bounds.
 * A supplied search must honor AbortSignal and settle only after its I/O closes.
 * beforeMedia durably consumes authorization; it is awaited once, immediately
 * before the only media curl spawn. No redirects, retry, resume, or fallback.
 */
export async function runDvrHttpSample(options, dependencies = {}) {
  const deps = { spawn: spawnExportProcess, lookup: cachedRecordingSearch, ...dependencies };
  const report = blank();
  if (options?.signal?.aborted) return blank('cancelled', 'cancelled');
  let endpoint, query;
  try {
    endpoint = normalizeDeviceEndpoint(options.device);
    const start = wall(options.startTime), end = wall(options.endTime);
    const user = own(options.device, 'username') ?? own(options.device, 'user');
    const pass = own(options.device, 'password') ?? own(options.device, 'pass');
    if (!start || !end || end.ms <= start.ms || typeof options.channel !== 'string' || !/^\d{1,8}$/.test(options.channel)
      || typeof user !== 'string' || typeof pass !== 'string'
      || /[\x00\r\n]/.test(user + pass)) return blank('invalid', 'invalid_recording');
    query = { ...endpoint, user, pass, channel: options.channel,
      startTime: start.iso, endTime: end.iso };
  } catch { return blank('invalid', 'invalid_recording'); }
  report.phase = 'search'; report.curlExitCode = null;
  const finish = (outcome, stopReason) => {
    report.outcome = outcome; report.stopReason = stopReason;
    return sanitizeDvrHttpSample(report);
  };
  const controller = new AbortController();
  const timeoutMs = limit(deps.timeoutMs, DVR_HTTP_SAMPLE_TIMEOUT_MS), started = Date.now();
  let timedOut = false, searchCurlObserved = false, temp, fd, timer;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (options.signal?.aborted) controller.abort();
  try {
    let files;
    try { files = deps.lookup(query); } catch { files = null; }
    if (!Array.isArray(files)) {
      const search = deps.search || (searchOptions => searchRecordingPage(searchOptions, {
        exec: async (binary, args, execOptions) => {
          const boundedArgs = [args[0], '--noproxy', '*', '--proto', '=http', '--no-location', '--retry', '0', ...args.slice(1)];
          const result = await captured(binary, boundedArgs, { spawn: deps.spawn, signal: execOptions.signal,
            timeoutMs: Math.min(execOptions.timeout, Math.max(1, timeoutMs - (Date.now() - started))), maxBytes: execOptions.maxBuffer });
          searchCurlObserved = true; report.curlExitCode = bounded(result.code, 0, 255);
          const status = /\n([1-5]\d{2})$/.exec(result.stdout);
          if (status) report.httpStatus = Number(status[1]);
          if (result.reason || result.code !== 0) throw Object.assign(new Error('Search failed'),
            { code: result.reason === 'cancelled' ? 'CANCELLED' : result.reason === 'timeout' || result.code === 28 ? 28 : 'FAILED' });
          return { stdout: result.stdout };
        },
      }));
      files = (await search({ ...query, signal: controller.signal })).files;
    }
    if (controller.signal.aborted || Date.now() - started >= timeoutMs) return finish(options.signal?.aborted ? 'cancelled' : 'timeout', options.signal?.aborted ? 'cancelled' : 'time_limit');
    const recording = resolveRecording(files, query);
    if (!recording.uri) return finish(recording.invalid ? 'invalid' : 'no_match', recording.invalid ? 'invalid_recording' : 'no_match');
    report.phase = 'private_setup';
    const privateRoot = options.privateRoot || deps.tmpRoot || tmpdir();
    if (options.privateRoot) {
      fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(privateRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid private sample directory');
      fs.chmodSync(privateRoot, 0o700);
    }
    temp = fs.mkdtempSync(join(privateRoot, 'dvr-http-sample-')); fs.chmodSync(temp, 0o700);
    const request = join(temp, 'request.xml'), sample = join(temp, 'sample.bin');
    fs.writeFileSync(request, `<downloadRequest><playbackURI>${xmlEscape(recording.uri)}</playbackURI></downloadRequest>`, { mode: 0o600, flag: 'wx' });
    fd = fs.openSync(sample, 'wx', 0o600);
    report.phase = 'checkpoint';
    if (options.beforeMedia) await options.beforeMedia();
    if (controller.signal.aborted || Date.now() - started >= timeoutMs) return finish(options.signal?.aborted ? 'cancelled' : 'timeout', options.signal?.aborted ? 'cancelled' : 'time_limit');
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    // --max-redirs 0 also blocks curl's Digest authentication follow-up.
    // --no-location keeps HTTP redirects disabled without blocking that handshake.
    const args = ['--disable', '--no-location', '--retry', '0', '--proto', '=http', '--noproxy', '*',
      '--http1.1', '--connect-timeout', String(Math.min(2000, remaining) / 1000), '--max-time', String(remaining / 1000),
      '--silent', '--digest', '--user', `${query.user}:${query.pass}`, '--request', 'POST', '--header', 'Content-Type: application/xml',
      '--data-binary', `@${request}`, '--include', '--fail', '--no-buffer', '--output', '-', `${deviceHttpOrigin(endpoint)}/ISAPI/ContentMgmt/download`];
    report.phase = 'transfer';
    const result = await transfer({ spawn: deps.spawn, args, signal: controller.signal, fd, maxBytes: limit(deps.maxBytes, DVR_HTTP_SAMPLE_MAX_BYTES) });
    clearTimeout(timer); timer = undefined;
    report.bytes = result.bytes; report.httpStatus = result.status;
    report.curlExitCode = bounded(result.code, 0, 255);
    report.stopReason = options.signal?.aborted ? 'cancelled' : timedOut ? 'time_limit' : result.reason;
    fs.closeSync(fd); fd = undefined;
    if (options.signal?.aborted) { report.outcome = 'cancelled'; return sanitizeDvrHttpSample(report); }
    if (result.status === 401 || result.status === 403) report.outcome = 'authentication';
    else if (result.reason === 'http_error') report.outcome = 'http_error';
    else if (result.reason === 'invalid_response') report.outcome = 'invalid';
    else if (!['eof', 'byte_limit', 'time_limit'].includes(report.stopReason)) report.outcome = 'failed';
    else if (result.bytes === 0) report.outcome = report.stopReason === 'time_limit' ? 'timeout' : 'undecodable';
    else await decode(sample, report, options, deps);
    return sanitizeDvrHttpSample(report);
  } catch (error) {
    const code = own(error, 'code');
    if (report.phase === 'search' && !searchCurlObserved && bounded(code, 0, 255) !== null) report.curlExitCode = code;
    if (options.signal?.aborted) return finish('cancelled', 'cancelled');
    if (timedOut || code === 28) return finish('timeout', 'time_limit');
    if (code === 'AUTHENTICATION') return finish('authentication', 'http_error');
    if (code === 'INVALID') return finish('invalid', 'invalid_recording');
    return finish('failed', 'transport_error');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (temp) {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch {
        report.phase = 'cleanup'; report.outcome = 'cleanup_failed'; return sanitizeDvrHttpSample(report);
      }
    }
  }
}

/** Opt-in HCNetSDK by-time downloads. The caller owns the shared export/preview gate.
 * No duration or OSD observation is proof of exact wall-clock alignment.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xml2js from 'xml2js';
import { compactToMs, msToCompact } from './hik-time.js';
import { normalizeDeviceEndpoint } from './device-endpoint.js';
import { spawnExportProcess } from './export-process-lock.js';
import { sanitizeSdkPhase, sanitizeSdkFailureEvidence } from './dvr-export-errors.js';
import { ffmpegPath, ffprobePath } from './ffmpeg-paths.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIB = 1024 * 1024;
// Synchronous shutdown fallback; regular cancellation still waits for close.
const liveProcesses = new Set();
export function killSdkProcessesNow() {
  for (const child of liveProcesses) { try { child.kill('SIGKILL'); } catch {} }
}

const WORKER = fileURLToPath(new URL('../scripts/hik-sdk-download.py', import.meta.url));
const messages = {
  SDK_DISABLED: 'HCNetSDK is not enabled for this recorder.',
  SDK_CHANNEL: 'HCNetSDK requires an unambiguous main-stream input channel.',
  SDK_DISCOVERY: 'Could not verify the recorder SDK channel and enabled management port.',
  SDK_RANGE: 'HCNetSDK requires valid local recorder times, at most one hour for export or 30 seconds for preview.',
  SDK_DOWNLOAD: 'HCNetSDK download failed. Check SDK compatibility and recorder access.',
  SDK_MEDIA: 'HCNetSDK returned unsupported, incomplete, or out-of-range media.',
  SDK_CONVERT: 'HCNetSDK MP4 conversion failed.',
  SDK_TIMEOUT: 'HCNetSDK processing timed out.',
  SDK_DOWNLOAD_TIMEOUT: 'HCNetSDK download timed out.',
  SDK_BYTE_LIMIT: 'HCNetSDK download reached the byte limit.',
  SDK_MULTIPART: 'HCNetSDK generated multiple output files.',
  SDK_PROCESS_TIMEOUT: 'HCNetSDK media processing timed out.',
  SDK_CANCELLED: 'HCNetSDK processing cancelled.',
  SDK_OUTPUT: 'Could not create a private HCNetSDK output.',
};
const PUBLIC_CODES = { SDK_DISABLED: 'DVR_SDK_UNAVAILABLE', SDK_CHANNEL: 'DVR_SDK_INVALID_REQUEST',
  SDK_DISCOVERY: 'DVR_SDK_UNAVAILABLE', SDK_RANGE: 'DVR_SDK_INVALID_REQUEST', SDK_DOWNLOAD: 'DVR_SDK_FAILED',
  SDK_MEDIA: 'DVR_SDK_VERIFY_FAILED', SDK_CONVERT: 'DVR_SDK_FAILED', SDK_TIMEOUT: 'DVR_SDK_PROCESS_TIMEOUT',
  SDK_DOWNLOAD_TIMEOUT: 'DVR_SDK_DOWNLOAD_TIMEOUT', SDK_BYTE_LIMIT: 'DVR_SDK_BYTE_LIMIT', SDK_MULTIPART: 'DVR_SDK_MULTIPART',
  SDK_PROCESS_TIMEOUT: 'DVR_SDK_PROCESS_TIMEOUT',
  SDK_CANCELLED: 'DVR_SDK_FAILED', SDK_OUTPUT: 'DVR_SDK_FAILED' };
const fail = (reason, sdkPhase, sdkFailurePhase) => Object.assign(new Error(messages[reason]), { code: PUBLIC_CODES[reason], reason,
  ...(['SDK_TIMEOUT', 'SDK_DOWNLOAD_TIMEOUT'].includes(reason)
    ? sanitizeSdkPhase(sdkFailurePhase) ? { sdkFailurePhase } : sanitizeSdkPhase(sdkPhase) ? { sdkPhase } : {}
    : {}) });
const single = value => Array.isArray(value) && value.length === 1 ? value[0] : undefined;
const scalar = value => { const v = single(value); return typeof v === 'string' ? v : undefined; };
const numeric = value => typeof value === 'string' && /^[1-9]\d{0,7}$/.test(value) ? Number(value) : null;
const aborted = signal => { if (signal?.aborted) throw fail('SDK_CANCELLED'); };
function wall(value) {
  if (typeof value !== 'string' || !/^\d{8}T\d{6}Z$/.test(value)) return NaN;
  const ms = compactToMs(value);
  return Number.isFinite(ms) && msToCompact(ms) === value ? ms : NaN;
}
function cleanEnvironment(env) {
  // Preserve recorder wall-clock semantics, without inheriting arbitrary credentials.
  return Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
}

/** Every cancellation/error waits for close before releasing the caller's gate. */
function capture(spawn, binary, args, { signal, timeoutMs, input, env, killGraceMs = 1000, errorCode = 'SDK_DOWNLOAD', allowFailureStdout = false }) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let child, timeout, escalation, reason, bytes = 0, chunks = [];
    let pending = Buffer.alloc(0), outcome, sdkPhase, protocolFailed = false;
    const resultKeys = new Set(['ok', 'code', 'sdkCode', 'bytes', 'sdkChannel', 'requestedStart', 'requestedEnd', 'osdTimes', 'failurePhase']);
    const frame = line => {
      if (outcome !== undefined || line.length === 0) throw fail(errorCode);
      const value = JSON.parse(line.toString('utf8'));
      if (typeof value === 'string') {
        if (!sanitizeSdkPhase(value)) throw fail(errorCode);
        sdkPhase = value;
      } else if (value && !Array.isArray(value) && typeof value.ok === 'boolean'
        && Object.keys(value).every(key => resultKeys.has(key))
        && (!Object.hasOwn(value, 'failurePhase') || (value.ok === false && value.code === 'timeout'
          && sanitizeSdkPhase(value.failurePhase)))) outcome = value;
      else throw fail(errorCode);
    };
    const invalidateProtocol = () => {
      protocolFailed = true; outcome = undefined; sdkPhase = undefined; pending = Buffer.alloc(0);
      // A malformed stream cannot retain earlier terminal/phase evidence, even
      // if the watchdog already fired. Cancellation alone has higher priority.
      if (reason && reason !== 'SDK_CANCELLED') reason = errorCode;
    };
    const workerData = data => {
      pending = Buffer.concat([pending, data]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        frame(pending.subarray(0, newline)); pending = pending.subarray(newline + 1);
      }
      if (outcome !== undefined && pending.length) throw fail(errorCode);
    };
    const stop = code => {
      if (reason) return;
      reason = code;
      try { child.kill('SIGTERM'); } catch {}
      escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, killGraceMs);
    };
    const abort = () => stop('SDK_CANCELLED');
    try { child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env }); }
    catch { reject(fail(errorCode)); return; }
    liveProcesses.add(child);
    child.once('error', () => stop(errorCode));
    child.once('close', code => {
      liveProcesses.delete(child);
      clearTimeout(timeout); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      if (allowFailureStdout && !protocolFailed) {
        try {
          if (pending.length) frame(pending); // Legacy single-result fixtures may omit a newline.
          if (outcome === undefined) reason ||= errorCode;
        } catch { invalidateProtocol(); }
      }
      if (protocolFailed && reason !== 'SDK_CANCELLED') reason = errorCode;
      const terminalTimeout = outcome?.ok === false && outcome.code === 'timeout';
      if (reason || (code !== 0 && !allowFailureStdout)) reject(fail(reason || errorCode,
        terminalTimeout ? undefined : sdkPhase, terminalTimeout ? outcome.failurePhase : undefined));
      else resolve(allowFailureStdout ? { outcome, exitCode: code, sdkPhase } : Buffer.concat(chunks).toString('utf8'));
    });
    child.stdout.on('error', () => stop(errorCode));
    child.stdout.on('data', data => {
      // Continue bounded phase parsing after TERM: final native cleanup can hang too.
      if (protocolFailed || (reason && !allowFailureStdout)) return;
      bytes += data.length;
      if (bytes > 65_536) { invalidateProtocol(); stop(errorCode); return; }
      if (allowFailureStdout) {
        try { workerData(data); }
        catch { invalidateProtocol(); stop(errorCode); }
      } else chunks.push(Buffer.from(data));
    });
    child.stdin.on('error', () => stop(errorCode));
    timeout = setTimeout(() => stop('SDK_TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { child.stdin.end(input || ''); } catch { stop(errorCode); }
  });
}

/** Closed metadata boundary: no filenames, native diagnostics, OSD or credentials. */
export function sanitizeSdkMetadata(value) {
  if (!value || typeof value !== 'object') return undefined;
  const own = key => { try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
  const requestedStart = own('requestedStart'), requestedEnd = own('requestedEnd');
  const actualDurationSeconds = own('actualDurationSeconds');
  if (!Number.isFinite(wall(requestedStart)) || !Number.isFinite(wall(requestedEnd))
    || wall(requestedEnd) <= wall(requestedStart) || wall(requestedEnd) - wall(requestedStart) > 3600_000
    || typeof actualDurationSeconds !== 'number' || !Number.isFinite(actualDurationSeconds)
    || actualDurationSeconds <= 0 || actualDurationSeconds > 3610
    || own('timingAccuracy') !== 'unverified-keyframe' || own('transport') !== 'hcnetsdk') return undefined;
  return { requestedStart, requestedEnd, actualDurationSeconds, timingAccuracy: 'unverified-keyframe', transport: 'hcnetsdk' };
}

/** Dependencies are injectable for offline protocol/lifecycle tests. */
export function createSdkAdapter({ spawn = spawnExportProcess, env = process.env,
  workerPath = WORKER, pythonPath = 'python3', ffmpeg = ffmpegPath, ffprobe = ffprobePath,
  killGraceMs = 1000, workerTimeoutMs, probeTimeoutMs = 30_000, convertTimeoutMs, decodeTimeoutMs } = {}) {
  function sdkEnabled(device) {
    const id = device?.id || device?.deviceId;
    return typeof env.HIKVISION_SDK_DIR === 'string' && path.isAbsolute(env.HIKVISION_SDK_DIR)
      && typeof id === 'string' && UUID.test(id)
      && String(env.HIKVISION_SDK_DEVICE_IDS || '').split(',').map(v => v.trim().toLowerCase()).filter(v => UUID.test(v)).includes(id.toLowerCase());
  }
  async function inspectSdkChannel(device, channel, { curlDigest, signal } = {}) {
    if (!sdkEnabled(device)) throw fail('SDK_DISABLED');
    const id = String(channel);
    if (!/^[1-9]\d{0,5}01$/.test(id) || Number(id) % 100 !== 1) throw fail('SDK_CHANNEL');
    if (typeof curlDigest !== 'function') throw fail('SDK_DISCOVERY');
    aborted(signal);
    try {
      const parser = new xml2js.Parser({ explicitArray: true, tagNameProcessors: [xml2js.processors.stripPrefix] });
      const stream = await curlDigest(device, device.username, device.password, `/ISAPI/Streaming/channels/${id}`);
      aborted(signal);
      if (typeof stream !== 'string' || stream.length > 256_000 || /<!DOCTYPE|<!ENTITY/i.test(stream)) throw fail('SDK_DISCOVERY');
      const parsed = await parser.parseStringPromise(stream);
      const entry = parsed.StreamingChannel;
      if (!entry || scalar(entry.id) !== id) throw fail('SDK_DISCOVERY');
      const video = single(entry.Video), inputChannel = numeric(scalar(video?.videoInputChannelID));
      if (!inputChannel) throw fail('SDK_DISCOVERY');
      const access = await curlDigest(device, device.username, device.password, '/ISAPI/Security/adminAccesses');
      aborted(signal);
      if (typeof access !== 'string' || access.length > 256_000 || /<!DOCTYPE|<!ENTITY/i.test(access)) throw fail('SDK_DISCOVERY');
      const management = await parser.parseStringPromise(access);
      const protocols = management.AdminAccessProtocolList?.AdminAccessProtocol;
      if (!Array.isArray(protocols)) throw fail('SDK_DISCOVERY');
      const sdkPorts = protocols.filter(p => ['SDK', 'DEV_MANAGE'].includes(scalar(p.protocol)));
      if (sdkPorts.length !== 1) throw fail('SDK_DISCOVERY');
      const sdk = sdkPorts[0], port = numeric(scalar(sdk.portNo));
      if ((sdk.enabled !== undefined && scalar(sdk.enabled) !== 'true') || !port || port > 65535) throw fail('SDK_DISCOVERY');
      return { channel: id, inputChannel, port };
    } catch (error) { if (signal?.aborted || error?.reason === 'SDK_CANCELLED') throw fail('SDK_CANCELLED'); throw fail('SDK_DISCOVERY'); }
  }
  async function sdkDownloadMp4({ device, channel, startTime, endTime, outputFile, signal, onProgress, preview = false, curlDigest }) {
    if (!sdkEnabled(device)) throw fail('SDK_DISABLED');
    const duration = (wall(endTime) - wall(startTime)) / 1000;
    if (!Number.isFinite(duration) || duration <= 0 || duration > (preview ? 30 : 3600)) throw fail('SDK_RANGE');
    aborted(signal);
    let work, rawFile, observedSeconds, createdOutput = false, stage = 'discovery';
    // Stage is internal and comes only from the fixed pipeline calls below.
    const progress = nextStage => { stage = nextStage; try { onProgress?.(null, { discovery: '正在核对 SDK 通道与端口', download: '正在通过 SDK 按所选时间取回录像', probe: '正在检查 SDK 录像', remux: '正在封装 MP4 并转换声音', verify: '正在核对成片时长与编码', decode: '正在逐帧核验成片视频与声音' }[stage]); } catch {} };
    const common = { signal, env: cleanEnvironment(env), killGraceMs };
    const probe = async (file, source) => {
      observedSeconds = undefined; // A failed final probe must not reuse the raw duration.
      const stdout = await capture(spawn, ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mpeg,mpegts,mov,h264,hevc', '-show_entries', 'format=duration:stream=codec_type,codec_name,duration', '-of', 'json', file], { ...common, timeoutMs: probeTimeoutMs, errorCode: 'SDK_MEDIA' });
      let data;
      try { data = JSON.parse(stdout); } catch { throw fail('SDK_MEDIA'); }
      if (!Array.isArray(data.streams)) throw fail('SDK_MEDIA');
      const video = data.streams.find(s => s.codec_type === 'video');
      const audio = data.streams.find(s => s.codec_type === 'audio');
      const durationValue = data.format?.duration ?? video?.duration;
      const seconds = Number(durationValue);
      if (typeof durationValue === 'number' || (typeof durationValue === 'string' && /^\d+(?:\.\d+)?$/.test(durationValue))) {
        observedSeconds = sanitizeSdkFailureEvidence({ observedSeconds: seconds })?.observedSeconds;
      }
      const tolerance = Math.min(10, Math.max(2, duration * 0.1));
      if (!video || !Number.isFinite(seconds) || seconds <= 0 || Math.abs(seconds - duration) > tolerance || (!preview && video.codec_name !== 'h264')) throw fail('SDK_MEDIA');
      const videoSeconds = Number(video?.duration), audioSeconds = Number(audio?.duration);
      if (source) {
        if (video.codec_name !== 'h264' || !Number.isFinite(videoSeconds) || videoSeconds <= 0
          || Math.abs(videoSeconds - seconds) > tolerance) throw fail('SDK_MEDIA');
        if (source.hasAudio && (!audio || audio.codec_name !== 'aac' || !Number.isFinite(audioSeconds)
          || audioSeconds <= 0 || Math.abs(audioSeconds - videoSeconds) > tolerance
          || (Number.isFinite(source.audioSeconds) && Math.abs(audioSeconds - source.audioSeconds) > tolerance))) throw fail('SDK_MEDIA');
        if (!source.hasAudio && audio) throw fail('SDK_MEDIA');
      }
      return { seconds, videoSeconds, hasAudio: !!audio, audioSeconds };
    };
    try {
      progress('discovery');
      const mapping = await inspectSdkChannel(device, channel, { curlDigest, signal });
      const endpoint = normalizeDeviceEndpoint(device);
      aborted(signal);
      if (typeof outputFile !== 'string' || !outputFile) throw fail('SDK_OUTPUT');
      // Never overwrite or remove a pre-existing user output.
      outputFile = path.resolve(outputFile);
      const reservation = await fs.open(outputFile, 'wx', 0o600); createdOutput = true; await reservation.close();
      work = await fs.mkdtemp(path.join(path.dirname(outputFile), '.hik-sdk-'));
      await fs.chmod(work, 0o700);
      const raw = path.join(work, 'recording.ps'), converted = path.join(work, 'output.mp4');
      rawFile = raw;
      const maxBytes = Math.min(2 * 1024 * MIB, Math.max(64 * MIB, Math.ceil(duration * 2 * MIB)));
      const timeoutMs = workerTimeoutMs ?? Math.min(30 * 60_000, Math.max(60_000, duration * 3000));
      progress('download');
      const result = await capture(spawn, pythonPath, [workerPath], { ...common, env: { ...common.env, LD_LIBRARY_PATH: env.HIKVISION_SDK_DIR }, timeoutMs: timeoutMs + 5000, allowFailureStdout: true,
        input: JSON.stringify({ sdkDir: env.HIKVISION_SDK_DIR, host: endpoint.ip, port: mapping.port,
          username: device.username, password: device.password, inputChannel: mapping.inputChannel,
          start: startTime, end: endTime, output: raw, maxBytes, timeoutSeconds: Math.ceil(timeoutMs / 1000) }) });
      const outcome = result.outcome;
      if (outcome.ok !== true) {
        if (outcome.code === 'timeout') throw fail('SDK_DOWNLOAD_TIMEOUT', undefined, outcome.failurePhase);
        if (outcome.code === 'byte_limit') throw fail('SDK_BYTE_LIMIT');
        if (outcome.code === 'extra_volume') throw fail('SDK_MULTIPART');
        if (['invalid_config', 'unsupported_channel_map'].includes(outcome.code)) throw fail('SDK_CHANNEL');
        if (outcome.code === 'sdk_unavailable') throw fail('SDK_DISABLED');
        throw fail('SDK_DOWNLOAD');
      }
      if (result.exitCode !== 0) throw fail('SDK_DOWNLOAD');
      if (outcome.requestedStart !== startTime || outcome.requestedEnd !== endTime || !Number.isInteger(outcome.sdkChannel) || outcome.sdkChannel < 1) throw fail('SDK_DOWNLOAD');
      progress('probe');
      const stat = await fs.lstat(raw);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || outcome.bytes !== stat.size) throw fail('SDK_MEDIA');
      const source = await probe(raw);
      progress('remux');
      const codec = preview ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy'];
      await capture(spawn, ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mpeg,mpegts,mov,h264,hevc', '-i', raw,
        '-map', '0:v:0', '-map', '0:a:0?', ...codec, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-fs', String(maxBytes), '-y', converted],
      { ...common, timeoutMs: convertTimeoutMs ?? Math.max(60_000, duration * 2000), errorCode: 'SDK_CONVERT' });
      progress('verify'); const finalMedia = await probe(converted, source);
      const actualDurationSeconds = finalMedia.seconds;
      const finalStat = await fs.lstat(converted);
      if (!finalStat.isFile() || finalStat.size < 1 || finalStat.size >= maxBytes) throw fail('SDK_MEDIA');
      progress('decode');
      // Decode every selected video/audio packet, with no network or output file.
      // A successful remux alone does not establish that copied H264 is playable.
      await capture(spawn, ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-err_detect', 'explode',
        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-i', converted,
        '-map', '0:v:0', '-map', '0:a:0?', '-max_error_rate', '0', '-f', 'null', '-'],
      { ...common, timeoutMs: decodeTimeoutMs ?? Math.min(30 * 60_000, Math.max(60_000, duration * 1000)), errorCode: 'SDK_MEDIA' });
      aborted(signal);
      await fs.rename(converted, outputFile);
      await fs.rm(work, { recursive: true, force: true }); work = null;
      aborted(signal);
      return { requestedStart: startTime, requestedEnd: endTime, requestedDurationSeconds: duration,
        actualDurationSeconds, timingAccuracy: 'unverified-keyframe', transport: 'hcnetsdk',
        sdkChannel: outcome.sdkChannel, bytes: finalStat.size };
    } catch (error) {
      // capture() has already waited for native close. Observe only this task's
      // private regular file before deleting it; no content or path is exposed.
      let rawBytes;
      if (!signal?.aborted && rawFile && ['SDK_MEDIA', 'SDK_CONVERT', 'SDK_TIMEOUT', 'SDK_DOWNLOAD_TIMEOUT'].includes(error?.reason)) {
        try {
          const stat = await fs.lstat(rawFile);
          if (stat.isFile()) rawBytes = sanitizeSdkFailureEvidence({ rawBytes: stat.size })?.rawBytes;
        } catch { /* Missing/unreadable/non-file output remains unknown. */ }
      }
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      if (createdOutput) await fs.rm(outputFile, { force: true }).catch(() => {});
      const reason = error?.reason === 'SDK_TIMEOUT'
        ? stage === 'download' ? 'SDK_DOWNLOAD_TIMEOUT' : 'SDK_PROCESS_TIMEOUT'
        : Object.hasOwn(messages, error?.reason) ? error.reason : 'SDK_OUTPUT';
      const failure = fail(signal?.aborted ? 'SDK_CANCELLED' : reason, error?.sdkPhase, error?.sdkFailurePhase);
      if (!signal?.aborted) {
        const sdkEvidence = ['SDK_MEDIA', 'SDK_CONVERT'].includes(reason)
          ? sanitizeSdkFailureEvidence({ stage, requestedSeconds: duration, observedSeconds, rawBytes })
          : ['SDK_DOWNLOAD_TIMEOUT', 'SDK_PROCESS_TIMEOUT'].includes(reason) ? sanitizeSdkFailureEvidence({ rawBytes }) : undefined;
        if (sdkEvidence) failure.sdkEvidence = sdkEvidence;
      }
      throw failure;
    }
  }
  return { sdkEnabled, inspectSdkChannel, sdkDownloadMp4 };
}
const adapter = createSdkAdapter();
export const sdkEnabled = adapter.sdkEnabled;
export const inspectSdkChannel = adapter.inspectSdkChannel;
export const sdkDownloadMp4 = adapter.sdkDownloadMp4;

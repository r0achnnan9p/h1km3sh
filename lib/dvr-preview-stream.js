import { spawn as spawnProcess } from 'node:child_process';
import { deviceRtspAuthority } from './device-endpoint.js';

const compact = ms => new Date(ms + 8 * 3600000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function dvrRtspUrl(device, channel, { startMs, duration, live = false } = {}) {
  if (!/^\d{1,8}$/.test(String(channel))) throw new Error('Invalid DVR channel');
  const auth = `${encodeURIComponent(device.username)}:${encodeURIComponent(device.password)}`;
  const base = `rtsp://${auth}@${deviceRtspAuthority(device)}/Streaming/${live ? 'Channels' : 'tracks'}/${channel}`;
  return live ? base : `${base}?starttime=${compact(startMs)}&endtime=${compact(startMs + duration * 1000)}`;
}

export function dvrPreviewArgs(url, duration, format = 'fmp4') {
  if (!['fmp4', 'compat'].includes(format)) throw new Error('Invalid preview format');
  const output = format === 'compat'
    ? ['-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-bf', '0', '-g', '30', '-threads', '2']
    : ['-c:v', 'copy'];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-fflags', '+genpts', '-threads', '2', '-allowed_media_types', 'video', '-i', url,
    '-t', String(duration), '-map', '0:v:0', '-an', ...output, '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'];
}

// An MP4 init segment is not a playable video. Wait for an actual media fragment
// before committing HTTP 200; failed RTSP/codec setup must remain a JSON error.
export function hasMediaFragment(buffer) {
  let offset = 0, fragment = false;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset), header = 8;
    const kind = buffer.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buffer.length) return false;
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(large); header = 16;
    }
    if (size !== 0 && size < header) return false;
    if (kind === 'mdat' && fragment && (size === 0 || size > header) && buffer.length > offset + header) return true;
    if (!size || offset + size > buffer.length) return false;
    if (kind === 'moof') fragment = true;
    offset += size;
  }
  return false;
}

export function previewFailure(stderr) {
  if (/401|unauthorized|authentication failed/i.test(stderr)) return '录像机取流认证失败，请检查设备账号权限。';
  if (/timed? ?out|connection refused|network is unreachable|no route/i.test(stderr)) return '连接录像机取流超时或被拒绝，请检查 RTSP 连接。';
  if (/404|not found|no such file/i.test(stderr)) return '录像机没有返回这个通道或时间段的画面。';
  return '录像机没有返回可播放画面，请重试或切换兼容预览。';
}

// Never return free-form FFmpeg text: it can contain RTSP credentials and SDP.
export function previewDiagnostics(stderr, { reason, format, exitCode, elapsedMs, outputBytes } = {}) {
  const failure = String(stderr || '').match(/method (OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER) failed:\s*([1-5]\d{2})\b/i);
  const category = /401|unauthorized|authentication failed/i.test(stderr) ? 'authentication'
    : /timed? ?out/i.test(stderr) ? 'timeout'
    : /connection refused|network is unreachable|no route/i.test(stderr) ? 'connection'
    : /404|not found|no such file/i.test(stderr) ? 'not_found'
    : /461|unsupported transport/i.test(stderr) ? 'transport'
    : /invalid data|could not find codec parameters|decod/i.test(stderr) ? 'decode'
    : /unknown encoder|encoder.*not found/i.test(stderr) ? 'encoder'
    : /could not write header|muxer|non monoton/i.test(stderr) ? 'mux'
    : failure ? 'rtsp' : 'unknown';
  const reasons = ['spawn failed', 'no media', 'first frame timeout', 'idle timeout', 'initial buffer limit', 'duration limit', 'stream ended', 'invalid request'];
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { reason: reasons.includes(reason) ? reason : 'unknown', format: ['fmp4', 'compat'].includes(format) ? format : 'unknown',
    method: failure?.[1].toUpperCase() || null, rtspStatus: failure ? Number(failure[2]) : null, category,
    exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
    elapsedMs: count(elapsedMs), outputBytes: count(outputBytes) };
}

export function createDvrPreview({ ffmpegPath, spawn = spawnProcess, firstFrameTimeoutMs = 20000, idleTimeoutMs = 20000, maxInitialBytes = 8 * 1024 * 1024, killGraceMs = 500, onFailure = () => {} } = {}) {
  return function startPreview({ res, urls, duration, format = 'fmp4', onFinish = () => {} }) {
    let child, finished = false, started = false, initial = Buffer.alloc(0), stderr = '', attempt = 0;
    const processes = new Map();
    let resolveTeardown, notified = false;
    const teardown = new Promise(resolve => { resolveTeardown = resolve; });
    let firstTimer, idleTimer, totalTimer, attemptStartedAt = Date.now(), outputBytes = 0, exitCode = null, reported = false;
    const report = reason => {
      if (reported) return;
      reported = true;
      try { onFailure(previewDiagnostics(stderr, { reason, format, exitCode, elapsedMs: Math.max(0, Date.now() - attemptStartedAt), outputBytes })); } catch { /* Observers cannot interrupt teardown. */ }
    };
    const session = { get finished() { return finished; }, stop: reason => finish(reason || 'cancelled', null) };
    const clearTimers = () => { clearTimeout(firstTimer); clearTimeout(idleTimer); clearTimeout(totalTimer); };
    function settleTeardown() {
      if (!finished || processes.size || notified) return;
      notified = true;
      try { onFinish(session); } catch { /* Observers cannot retain the gate. */ }
      resolveTeardown();
    }
    const kill = process => {
      const record = processes.get(process);
      if (!record || record.stopping) return;
      record.stopping = true;
      if (process.exitCode == null && process.signalCode == null) {
        try { process.kill('SIGTERM'); } catch {}
        record.timer = setTimeout(() => {
          if (!processes.has(process)) return;
          try { if (process.exitCode == null && process.signalCode == null) process.kill('SIGKILL'); } catch {}
        }, killGraceMs);
        record.timer.unref?.();
      }
    };
    function finish(reason, error, status = 502) {
      if (finished) return teardown;
      finished = true; clearTimers();
      // A failed fallback attempt may still own a process while child is null.
      // Keep every handle until close, including processes already sent TERM.
      for (const process of processes.keys()) kill(process);
      res.removeListener('close', disconnected);
      if (error) report(reason);
      if (!res.destroyed && !res.writableEnded) {
        if (!started && error) res.status(status).type('application/json').json({ success: false, error });
        else if (reason !== 'client disconnected') res.end();
      }
      settleTeardown();
      return teardown;
    }
    function disconnected() { finish('client disconnected', null); }
    function failAttempt(reason, message, status = 502) {
      if (finished) return;
      clearTimeout(firstTimer); clearTimeout(idleTimer);
      report(reason);
      const previous = child, closed = processes.get(previous)?.closed; child = null; kill(previous);
      if (!started && attempt < urls.length) {
        // The recorder's small playback pool cannot tolerate overlapping fallback
        // attempts. Cancellation while this barrier waits must suppress launch.
        Promise.resolve(closed).then(() => { if (!finished) launch(); });
        return;
      }
      finish(reason, message, status);
    }
    const idle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => failAttempt('idle timeout', '录像机取流中断，请重试。', 504), idleTimeoutMs); idleTimer.unref?.();
    };
    function write(chunk) {
      if (!res.write(chunk)) {
        const current = child; current?.stdout.pause();
        res.once('drain', () => { if (!finished && child === current) current.stdout.resume(); });
      }
    }
    function launch() {
      if (finished) return;
      initial = Buffer.alloc(0); stderr = ''; outputBytes = 0; exitCode = null; reported = false; attemptStartedAt = Date.now();
      let current;
      try { current = spawn(ffmpegPath, dvrPreviewArgs(urls[attempt++], duration, format), { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { failAttempt('spawn failed', '服务器无法启动录像预览。'); return; }
      child = current;
      let resolveClosed;
      const record = { closed: new Promise(resolve => { resolveClosed = resolve; }), stopping: false, timer: null };
      processes.set(current, record);
      firstTimer = setTimeout(() => failAttempt('first frame timeout', '录像机未及时返回画面，请重试。', 504), firstFrameTimeoutMs); firstTimer.unref?.();
      current.stderr.on('data', data => { if (child === current) stderr = (stderr + String(data)).slice(-8192); });
      current.stdout.on('data', chunk => {
        if (finished || child !== current) return;
        outputBytes += chunk.length;
        idle();
        if (!started) {
          if (initial.length + chunk.length > maxInitialBytes) { failAttempt('initial buffer limit', '录像预览初始化过大，请切换兼容预览。'); return; }
          initial = Buffer.concat([initial, chunk]);
          if (!hasMediaFragment(initial)) return;
          started = true; clearTimeout(firstTimer);
          res.status(200).set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Connection': 'close' });
          write(initial); initial = Buffer.alloc(0);
        } else write(chunk);
      });
      current.on('error', () => { if (child === current) failAttempt('spawn failed', '服务器无法启动录像预览。'); });
      current.once('close', code => {
        clearTimeout(record.timer); processes.delete(current); resolveClosed(); settleTeardown();
        if (finished || child !== current) return;
        exitCode = code;
        if (!started) failAttempt('no media', previewFailure(stderr));
        else { if (code !== 0) report('stream ended'); finish(code === 0 ? 'complete' : 'stream ended', null); }
      });
    }
    res.once('close', disconnected);
    totalTimer = setTimeout(() => finish('duration limit', started ? null : '录像预览超时。', 504), (duration + 45) * 1000); totalTimer.unref?.();
    if (res.destroyed || !urls?.length) finish('invalid request', '没有可用的录像地址。', 400); else launch();
    return session;
  };
}

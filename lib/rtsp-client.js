import { normalizeDeviceEndpoint, deviceRtspAuthority } from './device-endpoint.js';
import { dvrExportError } from './dvr-export-errors.js';
/**
 * 极简 RTSP 回放拉流客户端（海康 NVR 专用）
 *
 * 为什么不用 ffmpeg：
 *   海康 NVR 的 RTSP 回放默认按 ~1X 实时速率派发（"Rate-Control"），
 *   ffmpeg 无法发送 live555 扩展头 `Rate-Control: no`。实测（DS-7808N-Q1
 *   V4.82.100）带上该头后空闲时单路速率最高约 ~4X；高负载时仍会降速。
 *
 * 实现范围（刻意保持最小）：
 *   - RTSP over TCP + interleaved RTP（TCP 模式无丢包无重排，解包器可以很简单）
 *   - HTTP Digest 认证（含 qop=auth 变体）
 *   - 按需 SETUP 视频 + AAC 音频 track
 *   - RTP H.264 depacketize：单 NAL / STAP-A / FU-A → Annex-B 裸流
 *   - 帧计数用 RTP marker bit（每帧最后一个包 marker=1，海康固件遵守）
 *   - 长会话每 30s 发 GET_PARAMETER keepalive（海康会话超时 60s）
 *
 * 结束条件：数据空闲超时（NVR 发完窗口后不关会话）/ 达到 maxFrames / abort。
 * 无论如何退出都尽力发送 TEARDOWN —— NVR 的回放会话池资源有限且回收慢，
 * 不发 TEARDOWN 会导致后续会话被限速（实测踩坑）。
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';

const START_CODE = Buffer.from([0, 0, 0, 1]);

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * 构造 Digest Authorization 头。
 * @param {object} chal - { realm, nonce, qop }
 */
function digestAuth(method, uri, user, pass, chal, nc) {
  const ha1 = md5(`${user}:${chal.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  if (chal.qop && /(^|,)\s*auth\s*(,|$)/.test(chal.qop)) {
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ncStr = String(nc).padStart(8, '0');
    const response = md5(`${ha1}:${chal.nonce}:${ncStr}:${cnonce}:auth:${ha2}`);
    return `Digest username="${user}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", qop=auth, nc=${ncStr}, cnonce="${cnonce}", response="${response}"`;
  }
  const response = md5(`${ha1}:${chal.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", response="${response}"`;
}

/**
 * RTP H.264 解包器：TCP interleaved 保证有序无丢包，仅需处理
 * 单 NAL(1-23) / STAP-A(24) / FU-A(28) 三种封装。
 */
class H264Depacketizer {
  /**
   * @param {(buf: Buffer) => void} onData - Annex-B 数据输出
   * @param {(rtpTs: number) => void} onFrame - 每完整帧（marker bit）回调，携带该帧 RTP 时间戳
   */
  constructor(onData, onFrame) {
    this.onData = onData;
    this.onFrame = onFrame;
    this.fuBuffer = null; // FU-A 重组中的 NAL
  }

  /** @param {Buffer} packet - 完整 RTP 包 */
  feed(packet) {
    if (packet.length < 12) return;
    const b0 = packet[0];
    const version = b0 >> 6;
    if (version !== 2) return;
    const hasPadding = !!(b0 & 0x20);
    const hasExtension = !!(b0 & 0x10);
    const csrcCount = b0 & 0x0f;
    const marker = !!(packet[1] & 0x80);
    const rtpTs = packet.readUInt32BE(4);

    let offset = 12 + csrcCount * 4;
    if (hasExtension) {
      if (packet.length < offset + 4) return;
      const extLen = packet.readUInt16BE(offset + 2);
      offset += 4 + extLen * 4;
    }
    let end = packet.length;
    if (hasPadding) {
      const pad = packet[end - 1];
      if (pad > 0 && end - pad > offset) end -= pad;
    }
    if (end <= offset) return;

    const payload = packet.subarray(offset, end);
    this._handleNal(payload);

    if (marker && this.onFrame) this.onFrame(rtpTs);
  }

  _handleNal(payload) {
    const nalType = payload[0] & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      // 单 NAL 单元
      this.onData(Buffer.concat([START_CODE, payload]));
    } else if (nalType === 24) {
      // STAP-A: [1B header][2B size][NAL]...
      let off = 1;
      while (off + 2 <= payload.length) {
        const size = payload.readUInt16BE(off);
        off += 2;
        if (off + size > payload.length) break;
        this.onData(Buffer.concat([START_CODE, payload.subarray(off, off + size)]));
        off += size;
      }
    } else if (nalType === 28) {
      // FU-A: [FU indicator][FU header][fragment...]
      if (payload.length < 2) return;
      const fuHeader = payload[1];
      const isStart = !!(fuHeader & 0x80);
      const isEnd = !!(fuHeader & 0x40);
      const origType = fuHeader & 0x1f;

      if (isStart) {
        const nalHeader = (payload[0] & 0xe0) | origType;
        this.fuBuffer = [Buffer.from([nalHeader]), payload.subarray(2)];
      } else if (this.fuBuffer) {
        this.fuBuffer.push(payload.subarray(2));
      } else {
        return; // 中间包但没有起始包（TCP 下不应发生）
      }

      if (isEnd && this.fuBuffer) {
        this.onData(Buffer.concat([START_CODE, ...this.fuBuffer]));
        this.fuBuffer = null;
      }
    }
    // 其他类型（STAP-B/MTAP/FU-B）海康不使用，忽略
  }
}

/** 解析 RTP 公共头，返回 payload、marker 和时间戳。 */
function parseRtpPacket(packet) {
  if (packet.length < 12 || packet[0] >> 6 !== 2) return null;
  const hasPadding = !!(packet[0] & 0x20);
  const hasExtension = !!(packet[0] & 0x10);
  const csrcCount = packet[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (packet.length < offset) return null;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (hasPadding) {
    const padding = packet[end - 1];
    if (!padding || end - padding < offset) return null;
    end -= padding;
  }
  if (end <= offset) return null;
  return {
    marker: !!(packet[1] & 0x80),
    timestamp: packet.readUInt32BE(4),
    payload: packet.subarray(offset, end),
  };
}

function readBits(buffer, bitOffset, bitLength) {
  if (bitOffset + bitLength > buffer.length * 8) {
    throw new Error('readBits: 读取范围超出缓冲区长度');
  }
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const pos = bitOffset + i;
    value = (value << 1) | ((buffer[pos >> 3] >> (7 - (pos & 7))) & 1);
  }
  return value >>> 0;
}

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 从 SDP config（AudioSpecificConfig）读取 AAC 对象类型、采样率和声道。 */
export function parseAudioSpecificConfig(configHex) {
  const config = Buffer.from(configHex || '', 'hex');
  if (config.length < 2) throw new Error('AAC AudioSpecificConfig 无效');
  let bit = 0;
  let objectType = readBits(config, bit, 5); bit += 5;
  if (objectType === 31) {
    objectType = 32 + readBits(config, bit, 6); bit += 6;
  }
  const sampleRateIndex = readBits(config, bit, 4); bit += 4;
  let sampleRate;
  if (sampleRateIndex === 15) {
    sampleRate = readBits(config, bit, 24); bit += 24;
  } else {
    sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
  }
  const channelConfig = readBits(config, bit, 4);
  if (!sampleRate || !channelConfig) throw new Error('不支持的 AAC 采样率或声道配置');
  return { objectType, sampleRateIndex, sampleRate, channelConfig };
}

/** 为一个原始 AAC Access Unit 生成 7 字节 ADTS 头。 */
export function buildAdtsHeader(payloadLength, config) {
  const frameLength = payloadLength + 7;
  if (frameLength > 0x1fff) throw new Error('AAC 帧超过 ADTS 长度上限');
  const profile = Math.max(0, Math.min(3, config.objectType - 1));
  const sf = config.sampleRateIndex;
  const ch = config.channelConfig;
  return Buffer.from([
    0xff, 0xf1,
    (profile << 6) | (sf << 2) | (ch >> 2),
    ((ch & 3) << 6) | (frameLength >> 11),
    (frameLength >> 3) & 0xff,
    ((frameLength & 7) << 5) | 0x1f,
    0xfc,
  ]);
}

/** RFC 3640 MPEG4-GENERIC / AAC-hbr RTP 解包器。 */
export class AacDepacketizer {
  constructor(options) {
    this.onData = options.onData;
    this.onAu = options.onAu;
    this.sizeLength = options.sizeLength ?? 13;
    this.indexLength = options.indexLength ?? 3;
    this.indexDeltaLength = options.indexDeltaLength ?? 3;
    this.clockRate = options.clockRate;
    this.config = options.config;
    this.tsStep = Math.round(1024 * this.clockRate / this.config.sampleRate);
    this.fragment = null;
    // sizeLength 决定 feed() 里 AU-header 解析循环每轮的最小前进量；
    // 若设备 fmtp 给出 0（畸形/非常规 SDP），该循环会永不终止地把
    // headers 数组撑爆，属于拒绝服务风险。SDP 来自设备但仍是网络输入，
    // 值得在构造期直接拒绝而不是指望调用方校验。
    if (!(this.sizeLength > 0)) {
      throw new Error(`AAC fmtp sizeLength 无效: ${options.sizeLength}`);
    }
  }

  feed(packet) {
    const rtp = parseRtpPacket(packet);
    if (!rtp || rtp.payload.length < 2) return;
    const headerBits = rtp.payload.readUInt16BE(0);
    const headerBytes = Math.ceil(headerBits / 8);
    if (!headerBits || rtp.payload.length < 2 + headerBytes) return;
    const headerData = rtp.payload.subarray(2, 2 + headerBytes);
    const headers = [];
    let bit = 0;
    while (bit + this.sizeLength <= headerBits) {
      const size = readBits(headerData, bit, this.sizeLength);
      bit += this.sizeLength;
      const indexBits = headers.length === 0 ? this.indexLength : this.indexDeltaLength;
      if (bit + indexBits > headerBits) break;
      bit += indexBits;
      headers.push({ size });
    }
    if (headers.length === 0) return;

    let dataOffset = 2 + headerBytes;
    for (let i = 0; i < headers.length; i++) {
      const expected = headers[i].size;
      const available = rtp.payload.length - dataOffset;
      const take = Math.min(expected, available);
      const chunk = rtp.payload.subarray(dataOffset, dataOffset + take);
      dataOffset += take;
      const ts = (rtp.timestamp + i * this.tsStep) >>> 0;

      if (take === expected) {
        this._emit(chunk, ts);
      } else if (headers.length === 1 && take > 0) {
        if (!this.fragment || this.fragment.timestamp !== rtp.timestamp || this.fragment.expected !== expected) {
          this.fragment = { timestamp: rtp.timestamp, expected, chunks: [], length: 0 };
        }
        this.fragment.chunks.push(chunk);
        this.fragment.length += chunk.length;
        if (this.fragment.length >= expected) {
          const au = Buffer.concat(this.fragment.chunks, this.fragment.length).subarray(0, expected);
          const fragmentTs = this.fragment.timestamp;
          this.fragment = null;
          this._emit(au, fragmentTs);
        }
      }
    }
  }

  _emit(au, timestamp) {
    this.onData(Buffer.concat([buildAdtsHeader(au.length, this.config), au]));
    if (this.onAu) this.onAu(timestamp);
  }
}

function parseFmtp(line) {
  const params = {};
  const value = line.replace(/^a=fmtp:\d+\s*/i, '');
  for (const item of value.split(';')) {
    const eq = item.indexOf('=');
    if (eq > 0) params[item.slice(0, eq).trim().toLowerCase()] = item.slice(eq + 1).trim();
  }
  return params;
}

/** 提取 SDP 中的视频与 AAC 轨道参数。 */
export function parseSdpTracks(sdp) {
  const tracks = {};
  const sections = sdp.split(/(?=^m=)/m);
  for (const section of sections) {
    const media = section.match(/^m=(video|audio)\s+\d+\s+RTP\/AVP\s+(\d+)/m);
    if (!media) continue;
    const kind = media[1];
    const payloadType = Number(media[2]);
    const control = section.match(/^a=control:(\S+)/m)?.[1];
    const rtpmap = section.match(new RegExp(`^a=rtpmap:${payloadType}\\s+([^/\\s]+)/(\\d+)(?:/(\\d+))?`, 'mi'));
    if (!control || !rtpmap) continue;
    const fmtpLine = section.match(new RegExp(`^a=fmtp:${payloadType}\\s+(.+)$`, 'mi'))?.[0];
    tracks[kind] = {
      kind, payloadType, control,
      codec: rtpmap[1].toUpperCase(),
      clockRate: Number(rtpmap[2]),
      channels: rtpmap[3] ? Number(rtpmap[3]) : null,
      fmtp: fmtpLine ? parseFmtp(fmtpLine) : {},
    };
  }
  return tracks;
}

/**
 * 从 RTSP 回放地址拉取裸 H.264 流写入文件。
 *
 * @param {object} options
 * @param {string} options.ip
 * @param {number} [options.port=554]
 * @param {string} options.user
 * @param {string} options.pass
 * @param {string} options.path - 如 "/Streaming/tracks/101?starttime=...&endtime=..."
 * @param {string} [options.outPath] - 输出 Annex-B 裸流文件（与 outStream 二选一）
 * @param {import('stream').Writable} [options.outStream] - 输出可写流（如 ffmpeg stdin）；结束时会被 end()
 * @param {string} [options.audioOutPath] - 可选 ADTS AAC 输出；提供时才 SETUP 音频轨
 * @param {boolean} [options.fastPull=true] - 发送 Rate-Control: no（NVR 全速发送）
 * @param {number} [options.maxFrames=Infinity] - 收满帧数即停
 * @param {number} [options.idleTimeoutMs=15000] - 数据空闲超时（NVR 发完窗口后不关
 *   会话只能靠它退出；注意 NVR 高负载时发流会断续，太短会把慢发误判为发完）
 * @param {number} [options.maxWallMs=0] - 总时长上限（毫秒，0=不限制），防止会话挂死
 * @param {number} [options.connectTimeoutMs=10000]
 * @param {boolean} [options.captureFrameOffsets=false] - 记录每帧结束字节偏移（仅分段接缝对齐使用）
 * @param {AbortSignal} [options.signal]
 * @param {(frames: number, bytes: number) => void} [options.onProgress]
 * @returns {Promise<{frames: number, bytes: number, meta: {
 *   firstFrameTs: number|null,  // 首帧 RTP 时间戳
 *   lastFrameTs: number|null,   // 末帧 RTP 时间戳
 *   tsDeltaMode: number|null,   // 帧间 RTP 时间戳差的众数（90kHz 时钟；90000/该值=fps）
 *   clockRate: number,          // RTP 时钟频率（视频恒为 90000）
 * }}>}
 */
export function pullRtspRaw(options) {
  const {
    ip, port: legacyPort, rtspPort, user, pass, path: urlPath, outPath, outStream, audioOutPath,
    fastPull = true, maxFrames = Infinity,
    idleTimeoutMs = 15000, maxWallMs = 0, connectTimeoutMs = 10000,
    captureFrameOffsets = false, signal, onProgress,
    createConnection = net.createConnection, // test seam; production uses TCP
  } = options;

  if (signal?.aborted) return Promise.reject(new Error('Download aborted'));
  const endpoint = normalizeDeviceEndpoint({ ip, rtspPort: rtspPort ?? legacyPort });
  const port = endpoint.rtspPort;
  const url = `rtsp://${deviceRtspAuthority(endpoint)}${urlPath}`;

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: endpoint.ip, port, timeout: connectTimeoutMs });
    const socketClosed = new Promise(resolve => sock.once('close', resolve));
    const out = outStream || createWriteStream(outPath);
    const audioOut = audioOutPath ? createWriteStream(audioOutPath) : null;
    // 输出端出错（如 ffmpeg 提前退出）不应导致进程崩溃
    out.on('error', () => {});
    audioOut?.on('error', () => {});

    let cseq = 1;
    let session = null;
    let authChallenge = null;
    let authNc = 0;
    let digestChallengeSeen = false, describeAuthorizationSent = false, describeRequests = 0;
    let frames = 0;
    let bytes = 0;
    let audioFrames = 0;
    let audioBytes = 0;
    let settled = false;
    let idleTimer = null;
    let keepaliveTimer = null;
    let phase = 'connect'; // connect → describe → setup → play → streaming
    let pendingResolve = null; // 当前等待响应的 { method, cb }
    let sdpTracks = null;
    let setupQueue = [];
    let activeSetup = null;
    let audioDepack = null;

    // RTP 时序元数据（用于上层精确推导 fps 与接缝对齐）
    let firstFrameTs = null;
    let lastFrameTs = null;
    const tsDeltaCounts = new Map(); // 帧间 TS 差 → 出现次数（取众数得帧间隔）
    const frameEndBytes = captureFrameOffsets ? [] : null;
    let firstAudioTs = null;
    let lastAudioTs = null;
    const audioTsDeltaCounts = new Map();
    let endReason = null; // 'idle' | 'max-frames' | 'wall-cap' | 'closed' | 'abort'
    let wallTimer = null;

    // --- 收尾 ---
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      clearInterval(keepaliveTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // 尽力 TEARDOWN：NVR 会话池回收慢，不发会拖慢后续会话
      try {
        if (session) {
          sock.write(buildRequest('TEARDOWN', url, {}));
        }
      } catch (_) {}
      // 给 TEARDOWN 一点发送时间再断开
      const teardownTimer = setTimeout(() => { try { sock.destroy(); } catch (_) {} }, 200);
      socketClosed.then(() => clearTimeout(teardownTimer));
      // 帧间隔众数
      let tsDeltaMode = null;
      let bestCount = 0;
      for (const [delta, count] of tsDeltaCounts) {
        if (count > bestCount) { bestCount = count; tsDeltaMode = delta; }
      }
      let audioTsDeltaMode = null;
      bestCount = 0;
      for (const [delta, count] of audioTsDeltaCounts) {
        if (count > bestCount) { bestCount = count; audioTsDeltaMode = delta; }
      }
      const audioTrack = sdpTracks?.audio;
      const audioConfig = audioTrack?.audioConfig || null;
      const meta = {
        firstFrameTs, lastFrameTs, tsDeltaMode,
        clockRate: sdpTracks?.video?.clockRate || 90000,
        frameEndBytes,
        endReason,
        audio: audioOut ? {
          firstFrameTs: firstAudioTs,
          lastFrameTs: lastAudioTs,
          tsDeltaMode: audioTsDeltaMode,
          clockRate: audioTrack?.clockRate || null,
          sampleRate: audioConfig?.sampleRate || null,
          channels: audioConfig?.channelConfig || null,
          codec: audioTrack?.codec || null,
        } : null,
      };

      const outputs = [out, audioOut].filter(Boolean);
      let remaining = outputs.length;
      const done = () => {
        remaining--;
        if (remaining > 0) return;
        // Keep the export slot through the TEARDOWN grace period and TCP close.
        socketClosed.then(() => {
          if (err) reject(err);
          else resolve({ frames, bytes, audioFrames, audioBytes, meta });
        });
      };
      for (const stream of outputs) {
        try { stream.end(done); } catch (_) { done(); }
      }
    };

    const onAbort = () => { endReason = 'abort'; finish(new Error('Download aborted')); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // 总时长上限（防止 NVR 慢速滴流导致会话无限挂着）
    if (maxWallMs > 0) {
      wallTimer = setTimeout(() => {
        endReason = 'wall-cap';
        finish(null);
      }, maxWallMs);
    }

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // 流阶段的空闲超时是正常结束（NVR 发完窗口）；握手阶段则是错误
        if (phase === 'streaming') {
          endReason = endReason || 'idle';
          finish(null);
        } else {
          finish(dvrExportError('DVR_RTSP_TIMEOUT'));
        }
      }, phase === 'streaming' ? idleTimeoutMs : connectTimeoutMs);
    };

    // --- 请求构造 ---
    const buildRequest = (method, reqUrl, extraHeaders) => {
      if (method === 'DESCRIBE') { describeRequests++; describeAuthorizationSent = Boolean(authChallenge); }
      let req = `${method} ${reqUrl} RTSP/1.0\r\nCSeq: ${cseq++}\r\nUser-Agent: hik-extractor\r\n`;
      if (authChallenge) {
        authNc++;
        // Digest 的 uri 必须与当前请求行一致；SETUP 使用独立 track URL。
        req += `Authorization: ${digestAuth(method, reqUrl, user, pass, authChallenge, authNc)}\r\n`;
      }
      if (session) req += `Session: ${session}\r\n`;
      for (const [k, v] of Object.entries(extraHeaders || {})) {
        req += `${k}: ${v}\r\n`;
      }
      return req + '\r\n';
    };

    // backpressure：video/audio 任一输出流写不动都暂停 socket，
    // 必须等*全部*当前受阻的流都 drain 完才能恢复读取——否则先 drain 的
    // 那一路会抢先 resume()，另一路仍在积压时继续被灌数据，
    // 起不到限流作用（两路都用同一个 socket，独立监听 drain 各自
    // resume 曾经就是这个问题）。
    const backpressured = new Set();
    const pauseForBackpressure = (stream) => {
      if (backpressured.has(stream)) return;
      backpressured.add(stream);
      sock.pause();
      stream.once('drain', () => {
        backpressured.delete(stream);
        if (backpressured.size === 0) { try { sock.resume(); } catch (_) {} }
      });
    };

    // --- 解包器 ---
    const depack = new H264Depacketizer(
      (nalBuf) => {
        bytes += nalBuf.length;
        if (!out.write(nalBuf) && !out.destroyed) pauseForBackpressure(out);
      },
      (rtpTs) => {
        if (firstFrameTs === null) {
          firstFrameTs = rtpTs;
        } else {
          // 32 位无符号回绕安全的差值（帧间隔远小于 2^31）
          const delta = (rtpTs - lastFrameTs) >>> 0;
          if (delta > 0 && delta < 90000) { // 只统计 <1s 的正常帧间隔
            tsDeltaCounts.set(delta, (tsDeltaCounts.get(delta) || 0) + 1);
          }
        }
        lastFrameTs = rtpTs;
        frames++;
        if (frameEndBytes) frameEndBytes.push(bytes);
        if (onProgress && frames % 20 === 0) onProgress(frames, bytes);
        if (frames >= maxFrames) {
          endReason = 'max-frames';
          finish(null);
        }
      }
    );

    const writeAudio = (adts) => {
      audioBytes += adts.length;
      if (!audioOut.write(adts) && !audioOut.destroyed) pauseForBackpressure(audioOut);
    };

    const trackAudioFrame = (rtpTs) => {
      if (firstAudioTs === null) {
        firstAudioTs = rtpTs;
      } else {
        const delta = (rtpTs - lastAudioTs) >>> 0;
        const clockRate = sdpTracks?.audio?.clockRate || 0;
        if (delta > 0 && (!clockRate || delta < clockRate)) {
          audioTsDeltaCounts.set(delta, (audioTsDeltaCounts.get(delta) || 0) + 1);
        }
      }
      lastAudioTs = rtpTs;
      audioFrames++;
    };

    // --- 流解析状态机：interleaved 帧与 RTSP 文本响应混流 ---
    let buf = Buffer.alloc(0);

    const parseBuffer = () => {
      while (buf.length > 0) {
        if (buf[0] === 0x24) { // '$' interleaved frame
          if (buf.length < 4) return;
          const channel = buf[1];
          const len = buf.readUInt16BE(2);
          if (buf.length < 4 + len) return;
          const payload = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          if (channel === 0) { // channel 0 = 视频 RTP（SETUP interleaved=0-1）
            depack.feed(payload);
          } else if (channel === 2 && audioDepack) {
            audioDepack.feed(payload);
          }
          // channel 1/3 = RTCP，忽略
        } else {
          // RTSP 文本响应
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd < 0) {
            // 防御：若缓冲已很大还没有头结束标记，说明流错位
            if (buf.length > 65536) return finish(dvrExportError('DVR_STREAM_INVALID'));
            return;
          }
          const headerText = buf.subarray(0, headerEnd).toString();
          const clMatch = headerText.match(/Content-Length:\s*(\d+)/i);
          const bodyLen = clMatch ? parseInt(clMatch[1], 10) : 0;
          const total = headerEnd + 4 + bodyLen;
          if (buf.length < total) return;
          const body = buf.subarray(headerEnd + 4, total).toString();
          buf = buf.subarray(total);
          handleResponse(headerText, body);
        }
      }
    };

    const handleResponse = (headerText, body) => {
      const statusLine = headerText.split('\r\n')[0];
      const statusCode = parseInt(statusLine.split(' ')[1], 10);

      // keepalive 响应等无主响应直接忽略
      if (!pendingResolve) return;
      const { method, cb } = pendingResolve;
      const rejectResponse = code => finish(dvrExportError(code, {
        method, rtspStatus: statusCode, setupMedia: method === 'SETUP' ? activeSetup?.kind : null,
        ...(method === 'DESCRIBE' ? { digestChallengeSeen, authorizationSent: describeAuthorizationSent, describeRequests } : {}),
      }));

      // 401 → 提取 challenge 重试一次
      if (statusCode === 401 && !authChallenge) {
        const m = headerText.match(/WWW-Authenticate:\s*Digest\s+([^\r\n]+)/i);
        if (!m) return rejectResponse('DVR_AUTH_FAILED');
        digestChallengeSeen = true;
        const params = {};
        for (const pm of m[1].matchAll(/(\w+)="([^"]*)"|(\w+)=([^,\s]+)/g)) {
          params[pm[1] || pm[3]] = pm[2] !== undefined ? pm[2] : pm[4];
        }
        if (!params.realm || !params.nonce) return rejectResponse('DVR_AUTH_FAILED');
        authChallenge = { realm: params.realm, nonce: params.nonce, qop: params.qop };
        // 重发同一请求
        const retryHeaders = pendingResolve.retryHeaders || {};
        const retryUrl = pendingResolve.retryUrl || url;
        pendingResolve = { method, cb, retryHeaders, retryUrl };
        sock.write(buildRequest(method, retryUrl, retryHeaders));
        resetIdle();
        return;
      }

      if (statusCode === 401) return rejectResponse('DVR_AUTH_FAILED');
      if (statusCode !== 200) return rejectResponse(statusCode === 404 ? 'DVR_NOT_FOUND' : 'DVR_RTSP_REJECTED');

      pendingResolve = null;
      cb(headerText, body);
    };

    // --- 握手流程 ---
    const doDescribe = () => {
      phase = 'describe';
      const headers = { Accept: 'application/sdp' };
      pendingResolve = { method: 'DESCRIBE', cb: onDescribed, retryHeaders: headers, retryUrl: url };
      sock.write(buildRequest('DESCRIBE', url, headers));
      resetIdle();
    };

    const onDescribed = (headerText, sdp) => {
      sdpTracks = parseSdpTracks(sdp);
      if (!sdpTracks.video?.control) return finish(dvrExportError('DVR_NO_VIDEO'));
      // The raw export pipeline and its seam alignment are H.264-specific.
      // Reject HEVC/other codecs before SETUP instead of corrupting their RTP.
      if (sdpTracks.video.codec !== 'H264') return finish(dvrExportError('DVR_VIDEO_CODEC_UNSUPPORTED'));

      const resolveTrackUrl = (control) => {
        if (control.startsWith('rtsp://')) return control;
        const [base, query] = url.split('?');
        return `${base.replace(/\/$/, '')}/${control}${query ? '?' + query : ''}`;
      };

      setupQueue = [{
        kind: 'video',
        url: resolveTrackUrl(sdpTracks.video.control),
        transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
      }];

      if (audioOut) {
        const audio = sdpTracks.audio;
        // An absent track is valid video-only footage. An advertised but
        // malformed/unsupported track must not silently lose the recording's sound.
        if (!audio && /^m=audio\s/m.test(sdp)) return finish(dvrExportError('DVR_AUDIO_INVALID'));
        if (audio) {
          if (audio.codec !== 'MPEG4-GENERIC') return finish(dvrExportError('DVR_AUDIO_CODEC_UNSUPPORTED'));
          if (!audio.fmtp.config) return finish(dvrExportError('DVR_AUDIO_INVALID'));
          try {
            audio.audioConfig = parseAudioSpecificConfig(audio.fmtp.config);
            audioDepack = new AacDepacketizer({
              onData: writeAudio,
              onAu: trackAudioFrame,
              sizeLength: Number(audio.fmtp.sizelength || 13),
              indexLength: Number(audio.fmtp.indexlength || 3),
              indexDeltaLength: Number(audio.fmtp.indexdeltalength || 3),
              clockRate: audio.clockRate,
              config: audio.audioConfig,
            });
          } catch {
            return finish(dvrExportError('DVR_AUDIO_INVALID'));
          }
          setupQueue.push({
            kind: 'audio',
            url: resolveTrackUrl(audio.control),
            transport: 'RTP/AVP/TCP;unicast;interleaved=2-3',
          });
        }
      }

      setupNext();
    };

    const setupNext = () => {
      activeSetup = setupQueue.shift() || null;
      if (!activeSetup) return doPlay();

      phase = 'setup';
      const headers = { Transport: activeSetup.transport };
      pendingResolve = { method: 'SETUP', cb: onSetup, retryHeaders: headers, retryUrl: activeSetup.url };
      sock.write(buildRequest('SETUP', activeSetup.url, headers));
      resetIdle();
    };

    const onSetup = (headerText) => {
      const sm = headerText.match(/Session:\s*([^;\r\n]+)/);
      if (sm) session = sm[1].trim();
      setupNext();
    };

    const doPlay = () => {
      phase = 'play';
      const headers = { Range: 'npt=0.000-' };
      if (fastPull) headers['Rate-Control'] = 'no';
      pendingResolve = { method: 'PLAY', cb: onPlaying, retryHeaders: headers, retryUrl: url };
      sock.write(buildRequest('PLAY', url, headers));
      resetIdle();
    };

    const onPlaying = () => {
      phase = 'streaming';
      resetIdle();
      // 会话 keepalive（海康超时 60s）；响应会被 handleResponse 忽略（无 pending 时）
      keepaliveTimer = setInterval(() => {
        try { sock.write(buildRequest('GET_PARAMETER', url, {})); } catch (_) {}
      }, 30000);
    };

    // --- socket 事件 ---
    sock.on('connect', () => {
      if (settled) return;
      sock.setTimeout(0);
      sock.setNoDelay(true);
      doDescribe();
    });
    sock.on('timeout', () => finish(dvrExportError('DVR_RTSP_TIMEOUT')));
    sock.on('error', () => finish(dvrExportError('DVR_CONNECTION_FAILED')));
    sock.on('close', () => {
      // NVR 主动断开：流阶段视为正常结束
      if (phase === 'streaming') {
        endReason = endReason || 'closed';
        finish(null);
      } else {
        finish(dvrExportError('DVR_CONNECTION_FAILED'));
      }
    });
    sock.on('data', (chunk) => {
      if (settled) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      if (phase === 'streaming') resetIdle();
      try {
        parseBuffer();
      } catch {
        finish(dvrExportError('DVR_STREAM_INVALID'));
      }
    });
  });
}

import { sanitizeDvrRecordingDiagnostics } from './dvr-recording-diagnostics.js';
/** Public DVR failures are a closed vocabulary. Never reflect device/FFmpeg text. */
const messages = Object.freeze({
  DVR_SDK_UNAVAILABLE: 'SDK 回放尚未配置或无法加载，请检查服务器安装。',
  DVR_SDK_INVALID_REQUEST: 'SDK 按时段导出仅支持有效主码流及 1 小时以内的时间段。',
  DVR_SDK_FAILED: 'SDK 取回录像失败，请检查设备连接和回放权限。',
  DVR_SDK_DOWNLOAD_TIMEOUT: 'SDK 取回录像超时，任务已停止，请检查设备连接和录像覆盖。',
  DVR_SDK_MULTIPART: 'SDK 产生额外输出文件，未按单文件发布，请缩短时段或检查 SDK 输出。',
  DVR_SDK_BYTE_LIMIT: 'SDK 取回录像达到大小上限，任务已停止。',
  DVR_SDK_PROCESS_TIMEOUT: 'SDK 录像的媒体检查或转换超时，任务已停止。',
  DVR_SDK_LIMIT: 'SDK 取流达到时间或大小上限，任务已停止。',
  DVR_SDK_VERIFY_FAILED: 'SDK 返回的录像未通过完整性检查，未发布成片。',
  DVR_AUTH_FAILED: '录像机取流认证失败，请检查设备账号及回放权限。',
  DVR_CONNECTION_FAILED: '无法连接录像机取流服务，请检查 RTSP 连接。',
  DVR_RTSP_TIMEOUT: '录像机未及时返回录像数据，请稍后重试。',
  DVR_RTSP_REJECTED: '录像机拒绝了回放请求，请检查通道、录像时间及回放权限。',
  DVR_NOT_FOUND: '录像机没有返回所选通道或时间段的录像（RTSP 404）。',
  DVR_NO_VIDEO: '录像机回放未提供可用的视频轨。',
  DVR_VIDEO_CODEC_UNSUPPORTED: '快速导出暂不支持该视频编码，目前仅支持 H.264。',
  DVR_AUDIO_CODEC_UNSUPPORTED: '快速导出暂不支持该音频编码，目前仅支持 AAC；为保留声音，任务已停止。',
  DVR_AUDIO_INVALID: '录像机返回的音频参数无法解析，任务已停止以避免丢失声音。',
  DVR_STREAM_INVALID: '录像机返回的取流数据无法解析，请重试。',
  DVR_NO_DATA: '所选时间段未获取到录像数据，请检查录像覆盖。',
  DVR_VIDEO_INCOMPLETE: '获取的视频不足以覆盖所选时间段，请重试或重新核对录像覆盖。',
  DVR_AUDIO_INCOMPLETE: '获取的声音不足以覆盖所选时间段，任务已停止以避免音画不完整。',
  DVR_MUX_FAILED: '录像已取回，但 MP4 封装失败，请检查服务端媒体工具及存储空间。',
  DVR_VERIFY_FAILED: '导出文件未通过完整性校验，请重试或检查服务端媒体工具。',
  DVR_EXPORT_FAILED: 'DVR 导出失败，请检查录像覆盖和服务端配置。',
});

// Worker protocol vocabulary: no device text, native paths, or diagnostics.
const sdkPhases = Object.freeze({
  load: '加载 SDK', init_config: '配置 SDK', init: '初始化 SDK', login: '登录录像机',
  get_file: '创建按时段下载', play_start: '启动录像传输', wait: '等待录像数据',
  osd: '查询录像时间', stop: '停止下载会话', logout: '退出录像机登录', cleanup: '清理 SDK',
});
export function sanitizeSdkPhase(value) {
  return typeof value === 'string' && Object.hasOwn(sdkPhases, value) ? value : undefined;
}

const sdkMediaSteps = Object.freeze({
  probe: 'SDK 原始录像探测失败', remux: 'SDK MP4 封装失败',
  verify: 'SDK 成品参数校验失败', decode: 'SDK 成品完整解码失败',
});
/** Own finite numeric observations only; never turn a missing measurement into zero. */
export function sanitizeSdkFailureEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const read = key => { try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
  const safe = {}, stage = read('stage'), requestedSeconds = read('requestedSeconds');
  const observedSeconds = read('observedSeconds'), rawBytes = read('rawBytes');
  if (typeof stage === 'string' && Object.hasOwn(sdkMediaSteps, stage)) safe.stage = stage;
  if (Number.isInteger(requestedSeconds) && requestedSeconds >= 1 && requestedSeconds <= 3600) safe.requestedSeconds = requestedSeconds;
  if (typeof observedSeconds === 'number' && Number.isFinite(observedSeconds)
    && observedSeconds >= 0.001 && observedSeconds <= 86400) safe.observedSeconds = Number(observedSeconds.toFixed(3));
  if (Number.isSafeInteger(rawBytes) && rawBytes >= 0 && rawBytes <= 2 * 1024 ** 3) safe.rawBytes = rawBytes;
  return Object.keys(safe).length ? safe : undefined;
}

export function isDvrExportError(error) {
  return typeof error?.code === 'string' && Object.hasOwn(messages, error.code);
}

/** A closed, URL-free snapshot of the terminal RTSP reply. Never copy source objects. */
export function dvrRtspFailureDiagnostics(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  // Own data properties only: ignore accessors, prototypes and custom serializers.
  const read = key => Object.getOwnPropertyDescriptor(details, key)?.value;
  const method = read('method'), rtspStatus = read('rtspStatus'), setupMedia = read('setupMedia');
  if (!['DESCRIBE', 'SETUP', 'PLAY'].includes(method)
      || !Number.isInteger(rtspStatus) || rtspStatus < 100 || rtspStatus > 599) return undefined;
  const safe = { method, rtspStatus, setupMedia: method === 'SETUP' && ['video', 'audio'].includes(setupMedia) ? setupMedia : null };
  if (method === 'DESCRIBE') {
    for (const key of ['digestChallengeSeen', 'authorizationSent']) if (typeof read(key) === 'boolean') safe[key] = read(key);
    const count = read('describeRequests');
    if (Number.isInteger(count) && count >= 1 && count <= 2) safe.describeRequests = count;
    const recording = sanitizeDvrRecordingDiagnostics(read('recording'));
    if (recording) safe.recording = recording;
  }
  return safe;
}

export function dvrExportFailure(error) {
  const code = isDvrExportError(error) ? error.code : 'DVR_EXPORT_FAILED';
  const failureDiagnostics = isDvrExportError(error) ? dvrRtspFailureDiagnostics(error.failureDiagnostics) : undefined;
  const sdkFailurePhase = code === 'DVR_SDK_DOWNLOAD_TIMEOUT'
    ? sanitizeSdkPhase(Object.getOwnPropertyDescriptor(error, 'sdkFailurePhase')?.value) : undefined;
  const sdkPhase = code === 'DVR_SDK_DOWNLOAD_TIMEOUT'
    ? sanitizeSdkPhase(Object.getOwnPropertyDescriptor(error, 'sdkPhase')?.value) : undefined;
  let message = sdkFailurePhase ? `SDK 处理超时，记录的超时步骤：${sdkPhases[sdkFailurePhase]}。任务已停止。`
    : sdkPhase ? `SDK 处理超时，停止前最后记录的步骤：${sdkPhases[sdkPhase]}。任务已停止。` : messages[code];
  const sdkEvidence = ['DVR_SDK_VERIFY_FAILED', 'DVR_SDK_FAILED', 'DVR_SDK_DOWNLOAD_TIMEOUT', 'DVR_SDK_PROCESS_TIMEOUT'].includes(code)
    ? sanitizeSdkFailureEvidence(Object.getOwnPropertyDescriptor(error, 'sdkEvidence')?.value) : undefined;
  const mediaStage = sdkEvidence?.stage;
  if ((code === 'DVR_SDK_VERIFY_FAILED' && ['probe', 'verify', 'decode'].includes(mediaStage))
    || (code === 'DVR_SDK_FAILED' && mediaStage === 'remux')) {
    const details = [];
    if (sdkEvidence.requestedSeconds !== undefined) details.push(`请求 ${sdkEvidence.requestedSeconds} 秒`);
    if (sdkEvidence.observedSeconds !== undefined) details.push(`${['probe', 'remux'].includes(mediaStage) ? '原始探测' : '成品探测'} ${sdkEvidence.observedSeconds} 秒`);
    if (sdkEvidence.rawBytes !== undefined) details.push(`原始录像 ${sdkEvidence.rawBytes} 字节`);
    message = `${sdkMediaSteps[mediaStage]}，未发布成片。${details.length ? details.join('；') + '。' : ''}`;
  } else if (['DVR_SDK_DOWNLOAD_TIMEOUT', 'DVR_SDK_PROCESS_TIMEOUT'].includes(code) && sdkEvidence?.rawBytes !== undefined) {
    message += ` 停止后原始录像 ${sdkEvidence.rawBytes} 字节。`;
  }
  return { failureCode: code, message, ...(failureDiagnostics ? { failureDiagnostics } : {}) };
}

export function dvrExportError(code, diagnostics) {
  const failure = dvrExportFailure({ code, failureDiagnostics: diagnostics });
  return Object.assign(new Error(failure.message), { code: failure.failureCode,
    ...(failure.failureDiagnostics ? { failureDiagnostics: failure.failureDiagnostics } : {}) });
}

import { cameraSourceIdentity, validSourceIdentity } from './source-identity.js';
import { deviceEndpointIdentity } from './device-endpoint.js';
/** Symbol 参数只能由服务端传递，HTTP JSON 不能绕过任务守卫。 */
import fs from 'node:fs';
import { cameraRecoveryRequest } from './export-recovery.js';
import crypto from 'node:crypto';
import { wallTime, wallRange, displayWall } from './camera-time.js';
import { createVideoResolver, chooseVideoStrategy } from './video-resolver.js';
import { matchFilename } from './match-workflow.js';
import { captureOutputSource, outputSourceUnchanged } from './output-library.js';

export const CAMERA_JOB = Symbol('camera-job');
export const TASK_RESERVATION = Symbol('task-reservation');
export const TASK_COMPLETION = Symbol('task-completion');

export function prepareCameraJob(operation, args, { resolveCamera, archive, startHikvision, downloadsDir, forceDvr = false, forceArchive = false, recoveryRequest, sourceConfigIdentity }) {
  forceArchive ||= recoveryRequest?.forceArchive === true;
  if (!args || typeof args !== 'object' || typeof args.camera !== 'string') throw new Error('camera 是必填的摄像头别名。');
  const { camera, device } = resolveCamera(args.camera);
  if (forceDvr && !device) throw new Error('此通道未配置 DVR；请选择 MediaMTX，或先关联录像机及通道。');
  // An unbound path is local-only. Missing footage must never reach a default DVR.
  forceArchive ||= !device;
  const sourceIdentity = cameraSourceIdentity(camera, device, typeof sourceConfigIdentity === 'function' ? sourceConfigIdentity() : sourceConfigIdentity);
  if (recoveryRequest && (!validSourceIdentity(recoveryRequest.sourceIdentity) || recoveryRequest.sourceIdentity !== sourceIdentity)) throw new Error('录像来源配置已变化，未自动恢复；请核对配置后重新导出。');
  const resolver = createVideoResolver({ archive, startHikvision });
  let startMs, endMs, interval, count;
  const kind = { clip: 'clip', snapshot: 'snapshot', timeline: 'timeline' }[operation];
  if (!kind) throw new Error('未知摄像头操作。');
  if (kind === 'clip') ({ startMs, endMs } = wallRange(args.start, args.end));
  if (kind === 'snapshot') { startMs = wallTime(args.datetime); endMs = startMs + 2000; }
  if (kind === 'timeline') {
    startMs = wallTime(`${args.date} ${args.start}`);
    interval = args.interval ?? 60; count = args.count ?? 36;
    if (!Number.isInteger(interval) || interval < 1 || interval > 3600 || !Number.isInteger(count) || count < 1 || count > 36) {
      throw new Error('interval 必须为 1–3600 秒，count 必须为 1–36。');
    }
    endMs = startMs + ((count - 1) * interval + 2) * 1000;
  }
  if (args.acceptGaps !== undefined && typeof args.acceptGaps !== 'boolean') throw new Error('acceptGaps 必须为布尔值。');
  const acceptGaps = args.acceptGaps === true;
  if (acceptGaps && (kind !== 'clip' || !forceArchive || forceDvr)) throw new Error('仅 MediaMTX 视频导出可以接受录像缺口。');
  if (forceDvr && forceArchive) throw new Error('导出来源冲突。');
  if (args.dvrMethod !== undefined && !['auto', 'rtspclip', 'mp4download'].includes(args.dvrMethod)) throw new Error('无效 DVR 导出方式。');
  const planClip = async options => {
    const plan = forceDvr
      ? chooseVideoStrategy({ durationSeconds: (endMs - startMs) / 1000 })
      : await resolver.planClip({ ...options, forceArchive, acceptGaps });
    return plan.source === 'hikvision' && args.dvrMethod && args.dvrMethod !== 'auto'
      ? { ...plan, method: args.dvrMethod, strategy: args.dvrMethod === 'rtspclip' ? 'rtsp' : 'file-download' } : plan;
  };
  const now = new Date();
  const nowWall = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  if (endMs > nowWall) throw new Error('请求区间不能晚于当前时间。');
  const start = displayWall(startMs), end = displayWall(endMs);
  const mode = args.mode ?? (kind === 'clip' ? 'copy' : 'precise');
  if (!['copy', 'precise'].includes(mode)) throw new Error('mode 必须为 copy 或 precise。');
  const filename = recoveryRequest?.filename || (kind !== 'clip' ? undefined : args.matchup !== undefined
    ? matchFilename(args.matchup, camera.id, start.slice(0, 10))
    : `${camera.id} ${start.replaceAll(':', '-')}_${end.replaceAll(':', '-')} ${crypto.randomUUID().slice(0, 8)}.mp4`);
  return {
    kind,
    sourceIdentity,
    forceArchive,
    acceptGaps,
    recoveryRequest: recoveryRequest || { ...cameraRecoveryRequest(operation, args, camera, device, forceDvr, filename, forceArchive), sourceIdentity },
    filename,
    cameraId: camera.id,
    start,
    end,
    mode,
    matchupSpecified: args.matchup !== undefined,
    requestKey: kind === 'clip' ? JSON.stringify({ sourceIdentity, camera: camera.id, ...(device ? { deviceId: device.id, endpoint: deviceEndpointIdentity(device), channel: String(camera.channel) } : {}), start, end, mode, forceArchive, acceptGaps, filename: args.matchup !== undefined ? filename : undefined }) : undefined,
    plan: ({ signal }) => recoveryRequest?.plan || planClip({ camera, start, end, signal }),
    async execute({ signal, outputFile, reservation, plan, onProgress, onPlan }) {
      // 注入上下文后仍只调用常驻 startExportTask，不另起导出状态。
      const hikvision = (options) => {
        if (!device) throw new Error('此通道未配置 DVR，不能回退到录像机。');
        return startHikvision({ ...options, reservation });
      };
      const scoped = createVideoResolver({ archive, startHikvision: hikvision });
      const selected = recoveryRequest?.plan || plan || await planClip({ camera, start, end, signal });
      if (forceArchive && selected.source !== 'mediamtx') throw new Error('MediaMTX 导出不能切换到 DVR。');
      onPlan?.(selected);
      let sourceOutput, coverage;
      if (kind === 'clip') {
        const resolved = await scoped.resolveClip({ camera, device, start, end, signal, outputFile, plan: selected, mode, onProgress, forceArchive, acceptGaps, onCoverage: value => { coverage = value; } });
        if (selected.source === 'hikvision') {
          signal?.throwIfAborted();
          onProgress?.(null, '正在保存最终文件…', null, { stage: 'finalizing', stagePercent: null });
          // DVR 成品可能有数 GB；同步复制会阻塞 HTTP / SSE / 服务健康检查。
          // 等复制真正结束后再检查取消，避免外层提前清理仍在写入的临时文件。
          const source = captureOutputSource(downloadsDir, resolved.result);
          // CoW 文件系统可共享磁盘块；不支持时 Node 自动回退普通异步复制。
          // 不能硬链接来源：同区间重导可能覆盖原 inode，损坏已交付的成品。
          await fs.promises.copyFile(resolved.result, outputFile, fs.constants.COPYFILE_FICLONE);
          signal?.throwIfAborted();
          if (outputSourceUnchanged(downloadsDir, source)) sourceOutput = source;
        }
      } else if (selected.source === 'mediamtx') {
        if (kind === 'snapshot') await archive.getSnapshot(camera, args.datetime, { signal, outputFile });
        else await archive.createTimelineSheet(camera, { date: args.date, start: args.start, interval, count }, { signal, outputFile });
      } else {
        const method = chooseVideoStrategy({ durationSeconds: (endMs - startMs) / 1000 }).method;
        const file = await hikvision({ camera, device, start, end, method, signal });
        if (kind === 'snapshot') await archive.snapshotFromClip(file, args.datetime, outputFile, { signal });
        else await archive.createTimelineSheet(camera, { date: args.date, start: args.start, interval, count }, { signal, outputFile, inputFile: file });
      }
      return { sourceIdentity, source: selected.source, strategy: selected.source === 'mediamtx' && kind === 'clip' ? `local-${mode}` : selected.strategy,
        camera: camera.id, start, end, mode: kind === 'clip' ? mode : undefined,
        ...(kind === 'clip' && selected.source === 'mediamtx' ? { acceptGaps, coverage: coverage || selected.coverage } : {}), ...(sourceOutput ? { sourceOutput } : {}) };
    },
  };
}

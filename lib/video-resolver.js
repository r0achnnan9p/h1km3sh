/** 摄像头新入口采用 5 分钟规则；旧 export_clip 的策略保持不变。 */
import { requireArchiveCoverage } from './media-archive.js';
import { wallRange } from './camera-time.js';

export function chooseVideoStrategy({ durationSeconds, hasLocalArchive = false }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('无效的视频时长。');
  if (hasLocalArchive) return { source: 'mediamtx', strategy: 'local-cut', method: 'local' };
  return durationSeconds <= 300
    ? { source: 'hikvision', strategy: 'rtsp', method: 'rtspclip' }
    : { source: 'hikvision', strategy: 'file-download', method: 'mp4download' };
}

/** 由常驻服务注入现有导出入口，不在 MCP 进程里启动管线。 */
export function createVideoResolver({ archive, startHikvision }) {
  return {
    async planClip({ camera, start, end, signal, forceArchive = false, acceptGaps = false }) {
      const range = wallRange(start, end);
      const recording = await archive.hasRecording(camera, start, end, { signal });
      if (forceArchive) {
        // Older injected adapters can still describe complete coverage; never invent gap details.
        const coverage = recording.coverage || (recording.exists ? { complete: true, hasGaps: false, hasFootage: true,
          missingIntervals: [], missingSeconds: 0, requestedSeconds: range.durationSeconds, availableSeconds: range.durationSeconds } : null);
        if (!coverage) throw new Error('MediaMTX 录像覆盖信息不可用，请检查录像目录。');
        requireArchiveCoverage(coverage, acceptGaps);
        return { ...chooseVideoStrategy({ durationSeconds: range.durationSeconds, hasLocalArchive: true }), coverage, acceptGaps };
      }
      return chooseVideoStrategy({ durationSeconds: range.durationSeconds, hasLocalArchive: recording.exists });
    },
    async resolveClip({ camera, device, start, end, signal, outputFile, plan, mode, onProgress, forceArchive = false, acceptGaps = false, onCoverage }) {
      const selected = plan || await this.planClip({ camera, start, end, signal, forceArchive, acceptGaps });
      if (forceArchive && selected.source !== 'mediamtx') throw new Error('MediaMTX 导出不能切换到 DVR。');
      if (selected.source === 'hikvision' && !device) throw new Error('此通道未配置 DVR，不能回退到录像机。');
      const result = selected.source === 'mediamtx'
        ? await archive.cutClip(camera, start, end, { signal, outputFile, mode, onProgress, acceptGaps, onCoverage })
        : await startHikvision({ camera, device, start, end, method: selected.method, signal });
      return { ...selected, result };
    },
  };
}

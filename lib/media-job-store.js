import { sanitizeSdkMetadata } from './dvr-sdk.js';
import { validSourceIdentity } from './source-identity.js';
/** 只持久化媒体结果白名单，任务列表回收后仍可交付文件，不保存设备凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { renameOutputAlias } from './output-library.js';
import { dvrRtspFailureDiagnostics } from './dvr-export-errors.js';
import { sanitizeDvrHttpSample } from './dvr-http-sample.js';
export { mediaJobPage } from './media-job-page.js';

/** 更新单个任务快照；保留不相干字段，并仅迁移身份匹配的来源关联。 */
export function renameMediaTaskOutput(task, change) {
  const updateFile = file => {
    if (!file || typeof file !== 'object') return file;
    const outputAlias = renameOutputAlias(file.outputAlias, change);
    const renamed = file.filename === change.source.relativePath && file.size === change.source.identity.size;
    if (!renamed && outputAlias === file.outputAlias) return file;
    return { ...file, ...(renamed ? { filename: change.target.relativePath } : {}),
      ...(outputAlias !== file.outputAlias ? { outputAlias } : {}) };
  };
  let next = task.status === 'completed' ? updateFile(task) : task;
  if (Array.isArray(task.files)) {
    const files = task.files.map(updateFile);
    if (files.some((file, index) => file !== task.files[index])) next = { ...next, files };
  }
  return next;
}

export function createMediaJobStore(root = path.join(resolveDataDir(), 'media-jobs')) {
  const target = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效媒体任务编号。');
    return path.join(root, `${id}.json`);
  };
  const write = (file, task) => {
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(task)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    try { const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  };
  return {
    save(task) {
      const safe = Object.fromEntries(['taskId', 'status', 'kind', 'message', 'startTime', 'queuedAt', 'startedAt', 'queuePosition', 'progress', 'artifactUrl', 'filename', 'files', 'progressUrl', 'total', 'source', 'sourceIdentity', 'strategy', 'camera', 'start', 'end', 'mode', 'size', 'outputAlias', 'coverage', 'acceptGaps', 'failureCode'].map(k => [k, task[k]]));
      const sdkMetadata = sanitizeSdkMetadata(task.sdkMetadata);
    if (sdkMetadata) safe.sdkMetadata = sdkMetadata;
    const failureDiagnostics = dvrRtspFailureDiagnostics(task.failureDiagnostics);
      if (failureDiagnostics) safe.failureDiagnostics = failureDiagnostics;
      const sampleReport = sanitizeDvrHttpSample(task.sampleReport);
      if (sampleReport) safe.sampleReport = sampleReport;
      fs.mkdirSync(root, { recursive: true });
      write(target(task.taskId), safe);
    },
    read(id) {
      const task = JSON.parse(fs.readFileSync(target(id), 'utf8'));
      if (!['completed', 'error', 'cancelled'].includes(task.status)) return { ...task, status: 'error', message: '服务曾重启，任务已中断；已完成的文件仍可下载。' };
      return task;
    },
    /** 跟随已验证的文件改名更新交付索引；UUID 产物 URL 与上传历史完全不变。 */
    renameOutput(change, activeTasks = []) {
      // 先同步在内存中的结果，防止稍后的任务保存把旧名字/来源重新写回磁盘。
      for (const task of activeTasks) {
        const updated = renameMediaTaskOutput(task, change);
        if (updated === task) continue;
        // 批任务执行器也持有已发布 file 对象；保留引用，避免最终回调写回旧名。
        if (Array.isArray(task.files) && updated.files !== task.files) {
          updated.files = task.files.map((file, index) => {
            if (updated.files[index] !== file) Object.assign(file, updated.files[index]);
            return file;
          });
        }
        Object.assign(task, updated);
      }
      let names;
      try { names = fs.readdirSync(root); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const failures = [];
      for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        try {
          const file = path.join(root, name);
          let task;
          try { task = JSON.parse(fs.readFileSync(file, 'utf8')); }
          catch (error) { if (error instanceof SyntaxError) continue; throw error; }
          if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
          const updated = renameMediaTaskOutput(task, change);
          if (updated !== task) write(file, updated);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, '部分媒体任务记录未能更新');
    },
    outputAliases() {
      let names;
      try { names = fs.readdirSync(root); } catch { return []; }
      return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          // 部分成功的多镜头任务也有已发布成品；历史任务没有来源证据时不猜测。
          return [...(Array.isArray(task.files) ? task.files.map(file => file.outputAlias).filter(Boolean) : []),
            ...(task.status === 'completed' && task.outputAlias ? [task.outputAlias] : [])];
        } catch { return []; }
      });
    },
    findFile({ filename, camera, start, end, mode, sourceIdentity }, downloadsDir) {
      if (!validSourceIdentity(sourceIdentity)) return null;
      const output = path.join(downloadsDir, filename);
      let size;
      try { const stat = fs.statSync(output); if (!stat.isFile()) return null; size = stat.size; }
      catch { return null; }
      if (!fs.existsSync(root)) return null;
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          const found = task.files?.find(file => file.sourceIdentity === sourceIdentity && file.filename === filename && file.camera === camera && file.start === start && file.end === end && file.mode === mode && file.size === size);
          if (found) return found;
        } catch { /* 跳过损坏的历史任务，不猜测文件内容。 */ }
      }
      return null;
    },
    findByRange({ camera, start, end, mode, acceptGaps = false, requiredSource, expectedCoverage, sourceIdentity }, downloadsDir, filename) {
      if (!validSourceIdentity(sourceIdentity)) return null;
      if (!fs.existsSync(root)) return null;
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          const candidates = [...(task.files || [])];
          if (task.status === 'completed' && task.kind === 'clip' && task.filename && task.artifactUrl) candidates.push(task);
          for (const file of candidates) {
            if (file.sourceIdentity !== sourceIdentity || file.camera !== camera || file.start !== start || file.end !== end || file.mode !== mode || (filename && file.filename !== filename)) continue;
            if (requiredSource && file.source !== requiredSource) continue;
            if (file.coverage?.hasGaps && !acceptGaps) continue;
            if (file.coverage?.hasGaps && expectedCoverage) {
              const gaps = coverage => JSON.stringify((coverage.missingIntervals || []).map(gap => [gap.startMs ?? gap.start, gap.endMs ?? gap.end]));
              if (!expectedCoverage.hasGaps || gaps(file.coverage) !== gaps(expectedCoverage)) continue;
            }
            const output = path.join(downloadsDir, file.filename);
            const stat = fs.statSync(output);
            if (stat.isFile() && stat.size === file.size) return file;
          }
        } catch { /* 缺失文件或损坏任务不能被误当作成品。 */ }
      }
      return null;
    },
  };
}

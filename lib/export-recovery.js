import { sanitizeSdkMetadata } from './dvr-sdk.js';
import { deviceEndpointIdentity } from './device-endpoint.js';
/** Durable admission/checkpoints for the single export queue. Never stores credentials. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireKernelExportLease } from './export-process-lock.js';
import { renameMediaTaskOutput } from './media-job-store.js';
import { resolveDataDir } from './data-dir.js';
import { dvrRtspFailureDiagnostics } from './dvr-export-errors.js';
import { sanitizeDvrHttpSample } from './dvr-http-sample.js';

const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
export const RECOVERED_TASK = Symbol('recovered-export');
export const EXPORT_TERMINAL = new Set(['completed', 'error', 'cancelled']);
const fields = ['taskId', 'cameraJob', 'kind', 'requestKey', 'queuedAt', 'startedAt', 'startTime', 'filename', 'camera', 'source', 'sourceIdentity', 'start', 'end', 'mode', 'channel', 'total', 'files', 'status', 'message', 'progress', 'progressUrl', 'artifactUrl', 'size', 'outputAlias', 'recovered', 'outputFilenames', 'coverage', 'acceptGaps', 'failureCode'];
export function createExportRecoveryStore(root = path.join(resolveDataDir(), 'export-queue')) {
  const records = new Map();
  let sequence = 0;
  function save(record) {
    if (!/^[a-f0-9-]{36}$/.test(record.task?.taskId || '')) throw new Error('无效恢复任务编号。');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, `${record.task.taskId}.json`), temp = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      // A crash must not lose the newly admitted/cancelled task after returning success.
      try { const dir = fs.openSync(root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
      records.set(record.task.taskId, record);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    return record;
  }
  const snapshot = task => {
    const safe = Object.fromEntries(fields.filter(key => task[key] !== undefined).map(key => [key, structuredClone(task[key])]));
    const sdkMetadata = sanitizeSdkMetadata(task.sdkMetadata);
    if (sdkMetadata) safe.sdkMetadata = sdkMetadata;
    const failureDiagnostics = dvrRtspFailureDiagnostics(task.failureDiagnostics);
    if (failureDiagnostics) safe.failureDiagnostics = failureDiagnostics;
    const sampleReport = sanitizeDvrHttpSample(task.sampleReport);
    if (sampleReport) safe.sampleReport = sampleReport;
    return safe;
  };
  return {
    get: id => records.get(id),
    request(id, request) { const record = records.get(id); if (record) save({ ...record, request }); },
    admit(task, request) { return save({ version: 1, order: ++sequence, task: snapshot(task), request, publications: [] }); },
    update(task) { const record = records.get(task.taskId); if (record) save({ ...record, task: snapshot(task) }); },
    renameOutput(change) {
      for (const record of records.values()) {
        const task = renameMediaTaskOutput(record.task, change);
        if (task !== record.task) save({ ...record, task });
      }
    },
    cancel(task) { const record = records.get(task.taskId); if (record) save({ ...record, cancelRequested: true, task: { ...snapshot(task), status: 'cancelled', message: '任务已取消' } }); },
    publication(id, publication) {
      const record = records.get(id); if (!record) return;
      const publications = record.publications.filter(item => item.key !== publication.key);
      save({ ...record, publications: [...publications, publication] });
    },
    load() {
      let names; try { names = fs.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
        const taskId = name.slice(0, -5);
        try {
          const record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          if (record.version !== 1 || record.task?.taskId !== taskId || !Number.isFinite(record.task.queuedAt) || !record.request || !Array.isArray(record.publications)) throw new Error();
          sequence = Math.max(sequence, Number(record.order) || 0); records.set(taskId, record); return record;
        } catch {
          // Keep original corrupt bytes for diagnosis. Never infer source or replay it.
          return { corrupt: true, task: { taskId, status: 'error', message: '恢复记录损坏，未自动重新导出；原有文件已保留。', queuedAt: 0 } };
        }
      }).sort((a, b) => (a.order ?? a.task.queuedAt) - (b.order ?? b.task.queuedAt) || a.task.taskId.localeCompare(b.task.taskId));
    },
  };
}

export function cameraRecoveryRequest(operation, args, camera, device, forceDvr, filename, forceArchive = false) {
  const allowed = ['camera', 'start', 'end', 'datetime', 'date', 'interval', 'count', 'mode', 'matchup', 'dvrMethod', 'acceptGaps'];
  return { type: 'camera', operation, args: Object.fromEntries(allowed.filter(key => args[key] !== undefined).map(key => [key, args[key]])),
    camera: { id: camera.id, name: camera.name, ...(device ? { deviceId: camera.deviceId, channel: String(camera.channel) } : {}), archivePath: camera.archivePath },
    ...(device ? { deviceId: device.id, endpoint: deviceEndpointIdentity(device) } : {}), forceDvr, forceArchive, filename };
}
export function resolveRecoveryDevice(request, getDevice) {
  const device = getDevice(request.deviceId);
  if (!device || deviceEndpointIdentity(device) !== (request.endpoint?.includes('|') ? request.endpoint : deviceEndpointIdentity(request.endpoint))) throw new Error('原录像机已删除或地址发生变化，未自动切换来源；请检查配置后重新导出。');
  return device;
}

/** Refuse a second live server on the same data directory. Stale-owner reclamation is serialized. */
export function acquireExportLease(root = path.join(resolveDataDir(), 'export-queue')) {
  try { return acquireKernelExportLease(root); }
  catch (error) {
    // Native Linux deployments must use a cross-container kernel lock. On other
    // platforms preserve normal operation, but never replay an unclean running queue.
    if (error.code !== 'LOCK_UNAVAILABLE' || process.platform === 'linux') throw error;
    const unfinished = fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).some(name => {
      try { const record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); return !EXPORT_TERMINAL.has(record.task?.status); } catch { return true; }
    });
    if (unfinished) throw new Error('此平台缺少进程级文件锁，中断任务未自动重放；请先确认旧媒体进程已退出并安装 flock。');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, '.owner.json'), reclaim = path.join(root, '.reclaim');
  const owner = { pid: process.pid, startedAt: PROCESS_STARTED_AT, token: crypto.randomUUID() };
  function write() {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  try { write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { fs.mkdirSync(reclaim); }
    catch { throw new Error('另一个实例正在核对恢复队列，请稍后重启此实例。'); }
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('恢复队列所有者记录不可读，未自动接管；请检查运行实例和数据目录。'); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw new Error('恢复队列所有者记录无效，未自动接管。');
      let alive = previous.pid !== process.pid || previous.startedAt === PROCESS_STARTED_AT;
      if (alive) { try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; } }
      if (alive) throw new Error('另一个服务实例仍持有导出队列，本实例不会重复恢复或启动导出。');
      fs.unlinkSync(file); write();
    } finally { fs.rmdirSync(reclaim); }
  }
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return () => { process.removeListener('exit', release); release(); };
}

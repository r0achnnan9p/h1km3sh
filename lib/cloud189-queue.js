import { readOutputUploadStates } from './output-upload-status.js';
import { countActiveUploadJobs } from './console-task-counts.js';
/** 天翼云盘上传任务队列；worker 通过被忽略的 downloads/cloud189_work/job 文件运行。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isOutputFilename } from './output-files.js';

const CAMERA_DIR = /^camera_[a-f0-9]{16}$/;
const REMOTE_PATH = /^\/(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\p{L}\p{N} _./()（）-]{1,300}$/u;

function safeFilename(value) {
  if (isOutputFilename(value)) return value;
  const parts = typeof value === 'string' ? value.split(/[\\/]/) : [];
  return parts.length === 2 && CAMERA_DIR.test(parts[0]) && isOutputFilename(parts[1]) ? path.join(...parts) : null;
}
export function normalizeCloud189TargetPath(value) {
  if (typeof value !== 'string' || value.trim().startsWith('//') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('请先设置有效的天翼云盘目标目录。');
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (normalized === '/' || !REMOTE_PATH.test(normalized) || normalized.split('/').includes('..')) throw new Error('天翼云盘目标目录格式无效。');
  return normalized;
}

export function createCloud189Queue(downloadsDir, { getConnectionGeneration = () => undefined } = {}) {
  const directory = path.join(downloadsDir, 'cloud189_work', 'jobs');
  const root = path.resolve(downloadsDir);
  const recovering = new Set();
  const jobFile = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效云盘任务编号。');
    return path.join(directory, `${id}.json`);
  };
  function save(job) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = jobFile(job.id), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(job, null, 2), 'utf8');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
      try {
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function get(id) { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); }
  function list({ limit = 50 } = {}) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        return [{ id: job.id, provider: 'cloud189', status: job.status, filename: job.sourceFilename || job.filename, remoteFilename: path.basename(job.filename || ''), size: job.size,
          targetPath: job.targetPath, message: job.message, archivedAt: job.archivedAt,
          verificationCode: job.verificationCode, lastVerificationAt: job.lastVerificationAt, retryCount: job.retryCount || 0, retryRequestedAt: job.retryRequestedAt,
          recoveryAvailable: job.status === 'unknown' && job.uploadPhase === 'remote_started', createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt }];
      } catch { return []; }
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, Math.max(1, Math.min(100, limit)));
  }
  return {
    activeCount: () => countActiveUploadJobs(directory),
    outputStates: files => readOutputUploadStates(downloadsDir, directory, files),
    list,
    get,
    async runRecovery(id, action) {
      if (recovering.has(id)) return { ok: false, code: 'VERIFY_BUSY' };
      recovering.add(id);
      try { return await action(); } finally { recovering.delete(id); }
    },
    renameOutput({ source, target }) {
      if (!fs.existsSync(directory)) return;
      for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        let job;
        try { job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
        if (!job.archivedAt || job.status !== 'unknown' || (job.sourceFilename || job.filename) !== source.relativePath) continue;
        const identity = job.sourceIdentity;
        if (!identity || !['dev', 'ino', 'size', 'mtimeMs'].every(key => String(identity[key]) === String(key === 'mtimeMs' ? Math.trunc(source.identity[key]) : source.identity[key]))) continue;
        // Remote destination and the prior outcome stay unchanged. Only the
        // local source link follows an identity-proven managed rename.
        job.sourceFilename = target.relativePath;
        save(job);
      }
    },
    busyReason(filename) {
      if (!fs.existsSync(directory)) return null;
      const wanted = safeFilename(filename);
      if (!wanted) return null;
      let reason = null;
      // Do not classify an unresolved result as an active byte transfer. Keep
      // the source protected until an owner archives it under actual locks.
      for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        try {
          const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
          if ((job.sourceFilename || job.filename) !== wanted) continue;
          if (recovering.has(job.id)) return 'recovery';
          if (job.archivedAt) continue;
          if (['queued', 'uploading'].includes(job.status)) return 'upload';
          if (job.status === 'unknown') reason = 'verification';
        } catch {}
      }
      return reason;
    },
    isBusy(filename) { return this.busyReason(filename) !== null; },
    enqueue({ filename, targetPath }) {
      const relative = safeFilename(filename);
      if (!relative) throw new Error('请选择成片库中已完成的 MP4。');
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) throw new Error('无效视频路径。');
      let stat;
      try {
        const parent = fs.lstatSync(path.dirname(target));
        stat = fs.lstatSync(target);
        if (parent.isSymbolicLink()) throw new Error();
      } catch { throw new Error('成品不存在或不可访问。'); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('视频文件不存在或尚未完成。');
      const generation = getConnectionGeneration();
      if (generation !== undefined && !/^[a-f0-9]{32}$/.test(generation || '')) throw new Error('请重新连接账号，再明确提交此视频。');
      const identity = fs.lstatSync(target, { bigint: true });
      const sourceIdentity = { size: Number(identity.size), mtimeMs: Number(identity.mtimeMs), ino: String(identity.ino), dev: String(identity.dev) };
      // Archiving releases the local inode, never the uncertain remote outcome.
      // A rename must not silently bypass the duplicate guard for the same source.
      for (const name of fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)) : []) {
        let previous;
        try { previous = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
        if (!['queued', 'uploading', 'unknown'].includes(previous.status)) continue;
        const sameSource = previous.sourceIdentity && ['dev', 'ino', 'size', 'mtimeMs'].every(key => previous.sourceIdentity[key] === sourceIdentity[key]);
        if ((previous.sourceFilename || previous.filename) === relative || sameSource) {
          throw Object.assign(new Error(previous.status === 'unknown'
            ? '这份成片仍有待核实的云盘记录。请在任务页核实或重试；归档和改名不会消除重复上传风险。'
            : '这份成片已在云盘上传队列中，请勿重复提交。'), { code: 'CLOUD_UPLOAD_UNRESOLVED' });
        }
      }
      const job = { id: crypto.randomUUID(), provider: 'cloud189', ...(generation === undefined ? {} : { connectionGeneration: generation }), status: 'queued', uploadPhase: 'queued', sourceIdentity, filename: relative,
        size: stat.size, targetPath: normalizeCloud189TargetPath(targetPath), createdAt: new Date().toISOString(),
        message: '等待天翼云盘 worker 接手；进度以 CLI 可确认的数据为准' };
      save(job);
      return job;
    },
  };
}


import { readOutputUploadStates } from './output-upload-status.js';
import { countActiveUploadJobs } from './console-task-counts.js';
/** 全场命名与投稿草稿；媒体、登录凭据和队列均在被忽略的运行目录内。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isOutputFilename } from './output-files.js';
import { wallTime } from './camera-time.js';

export function matchFilename(matchup, camera, date) {
  if (typeof matchup !== 'string' || !matchup.trim() || matchup.trim().length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(matchup)) throw new Error('对阵名称不能为空，且不能包含文件路径或特殊字符。');
  if (!/^[\w-]{1,64}$/.test(camera)) throw new Error('无效摄像头编号。');
  wallTime(`${date} 00:00:00`);
  return `${matchup.trim()} ${camera} ${date}.mp4`;
}

export function createUploadQueue(downloadsDir, { getConnectionGeneration = () => undefined } = {}) {
  const directory = path.join(downloadsDir, 'biliup_work', 'jobs');
  function file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效投稿任务编号。');
    return path.join(directory, `${id}.json`);
  }
  function save(job) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file(job.id)}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(job, null, 2), 'utf8');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file(job.id));
      try {
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function get(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
  return {
    activeCount: () => countActiveUploadJobs(directory),
    outputStates: files => readOutputUploadStates(downloadsDir, directory, files),
    get,
    list({ limit = 12 } = {}) {
      if (!fs.existsSync(directory)) return [];
      return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
        try {
          const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
          return [{ id: job.id, status: job.status, filename: job.filename, title: job.title, message: job.message,
            createdAt: job.createdAt, bvid: job.bvid, collectionName: job.collectionName,
            collectionStatus: job.collectionStatus, size: job.size, progress: job.progress,
            uploadPhase: job.uploadPhase, stage: job.stage, stagePercent: job.stagePercent,
            progressUnit: job.progressUnit, totalBytes: job.totalBytes, uploadedBytes: job.uploadedBytes, uploadSpeed: job.uploadSpeed, progressUpdatedAt: job.progressUpdatedAt }];
        } catch { return []; }
      }).sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
        .slice(0, Math.max(1, Math.min(50, limit)));
    },
    isBusy(filename) {
      if (!fs.existsSync(directory)) return false;
      return fs.readdirSync(directory).filter(n => n.endsWith('.json')).some(n => {
        try { const job = JSON.parse(fs.readFileSync(path.join(directory, n), 'utf8'));
          return job.filename === filename && ['queued', 'uploading', 'unknown'].includes(job.status);
        } catch { return false; }
      });
    },
    prepare(args) {
      const { filename, title, tid, tags, onlySelf } = args;
      const relative = safeOutputPath(filename);
      if (!relative) throw new Error('请选择成片库中已完成的 MP4。');
      const target = path.resolve(downloadsDir, relative);
      if (!target.startsWith(path.resolve(downloadsDir) + path.sep)) throw new Error('无效视频路径。');
      let stat;
      try {
        const rootStat = fs.lstatSync(downloadsDir);
        const parentStat = path.dirname(target) === path.resolve(downloadsDir) ? rootStat : fs.lstatSync(path.dirname(target));
        stat = fs.lstatSync(target);
        if (parentStat.isSymbolicLink()) throw new Error();
      } catch { throw new Error('成品不存在，请用成片库选择已完成的视频。'); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('视频文件不存在或尚未完成。');
      if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\x00-\x1f]/.test(title)) throw new Error('投稿标题必须为 1–80 字。');
      if (!Number.isInteger(tid) || tid < 1 || tid > 10000) throw new Error('必须指定投稿分区编号。');
      if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10 || tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 20 || /[,\x00-\x1f]/.test(t))) throw new Error('请提供 1–10 个标签，每个不超过 20 字。');
      if (typeof onlySelf !== 'boolean') throw new Error('请明确公开或仅自己可见。');
      const generation = getConnectionGeneration();
      if (generation !== undefined && !/^[a-f0-9]{32}$/.test(generation || '')) throw new Error('请重新连接账号，再明确提交此视频。');
      const identity = fs.lstatSync(target, { bigint: true });
      const sourceIdentity = { size: Number(identity.size), mtimeMs: Number(identity.mtimeMs), ino: String(identity.ino), dev: String(identity.dev) };
      const job = { id: crypto.randomUUID(), status: 'draft', sourceIdentity, filename: relative, size: stat.size, title: title.trim(), tid,
        tags: tags.map(t => t.trim()), onlySelf, collectionName: '足球', ...(generation === undefined ? {} : { connectionGeneration: generation }), createdAt: new Date().toISOString() };
      save(job); return job;
    },
    submit(id, confirmed) {
      if (confirmed !== true) throw new Error('用户确认投稿标题、分区、标签和可见性后才能提交。');
      const job = get(id);
      if (job.status !== 'draft') return job; // 重复调用不重复投稿。
      const generation = getConnectionGeneration();
      if (generation !== undefined && (!generation || job.connectionGeneration !== generation)) throw new Error('账号连接已改变，请重新准备并确认投稿。');
      job.status = 'queued'; job.uploadPhase = 'queued'; save(job); return job;
    },
  };
}

function safeOutputPath(filename) {
  if (typeof filename !== 'string' || /[\x00-\x1f]/.test(filename)) return null;
  if (isOutputFilename(filename)) return filename;
  const match = /^(camera_[a-f0-9]{16})[\\/]([^\\/]+)$/i.exec(filename);
  if (!match || !isOutputFilename(match[2])) return null;
  return path.join(match[1], match[2]);
}


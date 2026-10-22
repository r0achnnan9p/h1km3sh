/** 仅把仍指向当前文件身份的队列事实投影为成片状态，不猜文件名对应关系。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveLibraryOutput } from './output-library.js';

export function readOutputUploadStates(root, directory, files) {
  let jobs = [], unreadable = false;
  try {
    for (const name of fs.readdirSync(directory).filter(value => /^[a-f0-9-]{36}\.json$/.test(value))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (!job || typeof job !== 'object' || Array.isArray(job)) { unreadable = true; continue; }
        jobs.push(job);
      }
      catch { unreadable = true; }
    }
  } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const result = new Map();
  for (const file of files) {
    const current = resolveLibraryOutput(root, file.id);
    if (!current) { result.set(file.id, { status: 'unknown' }); continue; }
    const matching = jobs.filter(job => {
      const id = job.sourceIdentity;
      return id && ['dev', 'ino', 'size', 'mtimeMs'].every(key => String(id[key]) === String(key === 'mtimeMs' ? Math.trunc(current.stats[key]) : current.stats[key]));
    });
    // 未决请求优先，不能被之前一次成功记录掩盖；归档不抹去远端结果未知。
    const job = matching.find(item => ['unknown', 'queued', 'uploading'].includes(item.status)) || matching[0];
    if (!job) {
      const legacy = jobs.some(item => (item.sourceFilename || item.filename) === current.relativePath);
      result.set(file.id, { status: legacy || unreadable ? 'unknown' : 'none' }); continue;
    }
    if (unreadable && job.status === 'completed') { result.set(file.id, { status: 'unknown' }); continue; }
    const status = ['queued', 'uploading', 'completed', 'failed', 'unknown', 'draft'].includes(job.status) ? job.status : 'unknown';
    const value = { status };
    // 只有已记录且有效的真实百分比才显示；189 无证据时保持不定进度。
    if (status === 'uploading' && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 100) value.progress = job.progress;
    result.set(file.id, value);
  }
  return result;
}

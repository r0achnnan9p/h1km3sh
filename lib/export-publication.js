/** Crash-safe final publication. A complete artifact is renamed atomically before its named link is exposed. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactRoot, isArtifactPath } from './artifacts.js';
import { isOutputFilename } from './output-files.js';
import { createOutputAlias } from './output-library.js';

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function identity(stat) { return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs'].map(key => [key, stat[key]])); }
function sameIdentity(stat, expected) { return expected && ['dev', 'ino', 'size', 'mtimeMs'].every(key => Number.isFinite(expected[key]) && stat[key] === expected[key]); }
async function sameContents(named, file, stat) {
  const target = regular(named);
  return Boolean(target && target.size === stat.size && (sameIdentity(target, identity(stat)) || await digest(named) === await digest(file)));
}
function syncDirectory(directory) {
  try { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
}
function regular(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 ? stat : null; } catch { return null; }
}
export async function publishExport({ store, taskId, downloadsDir, key, artifact, outputFile, filename, selected, size: expectedSize, identity: expectedIdentity, replay = false, signal }) {
  const relative = artifact.url?.replace(/^\/artifacts\//, '');
  if (!isArtifactPath(relative) || (filename && !isOutputFilename(filename))) throw new Error('恢复成品路径无效。');
  const file = path.join(artifactRoot(), relative);
  const existing = regular(file), prepared = outputFile && regular(outputFile);
  if (!existing && !prepared) return null; // Crash before artifact completion: regenerate only this item.
  const size = (existing || prepared).size;
  if (replay && (!Number.isFinite(expectedSize) || size !== expectedSize || !sameIdentity(existing || prepared, expectedIdentity))) throw new Error('恢复成品身份或大小与完成记录不符，已保留原文件，未重复导出。');
  // Flush complete bytes before recording durable publication intent.
  const fd = fs.openSync(existing ? file : outputFile, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (existing && !replay) throw new Error('媒体产物路径已存在，未覆盖原文件。');
  const publication = { key, artifact: { url: artifact.url }, filename, selected, size, identity: identity(existing || prepared) };
  store.publication(taskId, publication); // Durable intent before any publish operation.
  if (!existing) { fs.linkSync(outputFile, file); fs.unlinkSync(outputFile); syncDirectory(path.dirname(file)); }
  signal?.throwIfAborted();
  if (filename) {
    const named = path.join(downloadsDir, filename);
    try { fs.linkSync(file, named); }
    catch (error) {
      if (error.code === 'EXDEV') {
        // Never expose a partially copied .mp4, and never overwrite a collided destination.
        const temporary = path.join(downloadsDir, `.publish-${taskId}-${crypto.randomUUID()}.tmp`);
        try {
          await fs.promises.copyFile(file, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          signal?.throwIfAborted();
          const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.linkSync(temporary, named);
        } catch (copyError) {
          if (copyError.code !== 'EEXIST' || !replay || !await sameContents(named, file, existing || prepared)) throw copyError;
        } finally { await fs.promises.unlink(temporary).catch(() => {}); }
      } else if (error.code !== 'EEXIST' || !replay || !await sameContents(named, file, existing || prepared)) throw error;
    }
  }
  if (filename) syncDirectory(downloadsDir);
  const outputAlias = filename ? createOutputAlias(downloadsDir, selected.sourceOutput, filename) : null;
  const { sourceOutput, ...metadata } = selected;
  const result = { ...metadata, ...(filename ? { filename } : {}), artifactUrl: artifact.url, size,
    ...(outputAlias ? { outputAlias } : {}) };
  store.publication(taskId, { ...publication, result });
  return result;
}
export async function reconcilePublications({ record, store, downloadsDir, signal }) {
  const results = [];
  for (const publication of record.publications) {
    const result = await publishExport({ ...publication, store, taskId: record.task.taskId, downloadsDir, replay: true, signal });
    if (result) results.push(result);
  }
  return results;
}

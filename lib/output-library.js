/** 受保护录像控制台使用的成片库，只允许顶层与 camera_<设备哈希>/ 下的 MP4。 */
import fs from 'node:fs';
import path from 'node:path';
import { isOutputFilename, renameOutputFile } from './output-files.js';

import { thumbnailVersion } from './output-thumbnail-version.js';

const CAMERA_DIR = /^camera_[a-f0-9]{16}$/;

function decodeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(id)) return null;
  try {
    const relative = Buffer.from(id, 'base64url').toString('utf8');
    if (Buffer.from(relative).toString('base64url') !== id) return null;
    const parts = relative.split(/[\\/]/);
    if (parts.length === 1 && isOutputFilename(parts[0])) return relative;
    if (parts.length === 2 && CAMERA_DIR.test(parts[0]) && isOutputFilename(parts[1])) return relative;
    return null;
  } catch { return null; }
}

function safeFile(root, relative) {
  const full = path.resolve(root, relative);
  const base = path.resolve(root);
  if (!full.startsWith(base + path.sep)) return null;
  try {
    const parent = path.dirname(full);
    if (parent !== base) {
      const parentStats = fs.lstatSync(parent);
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || path.dirname(parent) !== base || !CAMERA_DIR.test(path.basename(parent))) return null;
    }
    const stats = fs.lstatSync(full);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) return null;
    return { full, stats };
  } catch { return null; }
}

export function outputId(relativePath) { return Buffer.from(relativePath).toString('base64url'); }

export function resolveLibraryOutput(root, id) {
  const relative = decodeId(id);
  if (!relative) return null;
  const result = safeFile(root, relative);
  return result ? { ...result, relativePath: relative, filename: path.basename(relative), directory: path.dirname(path.resolve(root, relative)) } : null;
}

const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
function fileIdentity(stats) {
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, stats[field]]));
}
function sameIdentity(left, right) {
  return Boolean(left && right && IDENTITY_FIELDS.every(field => Number.isFinite(left[field]) && left[field] === right[field]));
}

/** 只记录真实复制过的成品来源；不能按文件名、大小或相似时间段猜测两份录像相同。 */
export function captureOutputSource(root, file) {
  if (typeof root !== 'string' || typeof file !== 'string') return null;
  const relativePath = path.relative(root, file);
  const source = resolveLibraryOutput(root, outputId(relativePath));
  return source ? { relativePath, identity: fileIdentity(source.stats) } : null;
}

export function outputSourceUnchanged(root, source) {
  if (!source || typeof source.relativePath !== 'string') return false;
  const file = resolveLibraryOutput(root, outputId(source.relativePath));
  return Boolean(file && sameIdentity(source.identity, fileIdentity(file.stats)));
}

/** 在友好名发布完成后记录双方身份，外部覆盖、改名、删除时失效并保守地重新显示。 */
export function createOutputAlias(root, source, filename) {
  if (!isOutputFilename(filename) || !outputSourceUnchanged(root, source)) return null;
  const parts = source.relativePath.split(/[\\/]/);
  if (parts.length !== 2 || !CAMERA_DIR.test(parts[0])) return null;
  const target = captureOutputSource(root, path.join(root, filename));
  if (!target || source.identity.size !== target.identity.size) return null;
  return { source, target };
}

export function listOutputLibrary(root, { limit = 100, inProgress = new Set(), isBusy = () => false, aliases = [] } = {}) {
  const candidates = [];
  const identities = new Map();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const dirs = [root, ...entries.filter(entry => entry.isDirectory() && CAMERA_DIR.test(entry.name)).map(entry => path.join(root, entry.name))];
  for (const directory of dirs) {
    let files;
    try { files = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !isOutputFilename(entry.name)) continue;
      const relativePath = path.relative(root, path.join(directory, entry.name));
      const result = safeFile(root, relativePath);
      if (!result) continue;
      const busy = inProgress.has(relativePath) || inProgress.has(entry.name) || isBusy(relativePath) || isBusy(entry.name);
      identities.set(relativePath, fileIdentity(result.stats));
      candidates.push({ id: outputId(relativePath), filename: entry.name, relativePath,
        thumbnailUrl: busy ? null : `/console/api/outputs/${outputId(relativePath)}/thumbnail?v=${thumbnailVersion({ relativePath, stats: result.stats })}`,
        size: result.stats.size, modifiedAt: result.stats.mtime.toISOString(), busy,
        streamUrl: `/console/api/outputs/${outputId(relativePath)}/stream` });
    }
  }
  const byPath = new Map(candidates.map(file => [file.relativePath, file]));
  const hidden = new Set();
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const source = alias?.source, target = alias?.target;
    const sourceFile = byPath.get(source?.relativePath), targetFile = byPath.get(target?.relativePath);
    const parts = typeof source?.relativePath === 'string' ? source.relativePath.split(/[\\/]/) : [];
    // 只隐藏受管目录里的内部来源；上传/写入中的文件始终可见，直接下载 ID 不变。
    if (!sourceFile || !targetFile || sourceFile.busy || targetFile.busy || parts.length !== 2 || !CAMERA_DIR.test(parts[0])
      || !isOutputFilename(target.relativePath) || source.identity?.size !== target.identity?.size) continue;
    if (sameIdentity(source.identity, identities.get(source.relativePath)) && sameIdentity(target.identity, identities.get(target.relativePath))) {
      hidden.add(source.relativePath);
    }
  }
  const visible = candidates.filter(file => !hidden.has(file.relativePath)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
  // 受保护控制台读取完整元数据并按 20 行渐进呈现；其他调用保持原有数量上限。
  return limit === null ? visible : visible.slice(0, Math.max(1, Math.min(200, limit)));
}

/** 只有身份仍与改名前相符的关联才能跟随改名；过期元数据不能因此重新变成证据。 */
export function renameOutputAlias(alias, { source, target }) {
  if (!alias || !source || !target) return alias;
  const update = reference => reference?.relativePath === source.relativePath && sameIdentity(reference.identity, source.identity)
    ? target : reference;
  const nextSource = update(alias.source), nextTarget = update(alias.target);
  return nextSource === alias.source && nextTarget === alias.target ? alias : { ...alias, source: nextSource, target: nextTarget };
}

/** onRename 只更新本地索引；失败时文件已改名，不得尝试删除/覆盖录像来回滚。 */
export function renameLibraryOutput(root, id, newName, { onRename } = {}) {
  const source = resolveLibraryOutput(root, id);
  if (!source) return null;
  if (!isOutputFilename(newName)) throw new Error('新文件名不合法：只允许简单的 .mp4 文件名。');
  const target = path.join(source.directory, newName);
  const result = { relativePath: path.relative(root, target), filename: newName };
  if (newName === source.filename) return result;
  if (!renameOutputFile(source.directory, source.filename, newName)) return null;
  try {
    try { const fd = fs.openSync(source.directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
    const renamed = captureOutputSource(root, target);
    const before = { relativePath: source.relativePath, identity: fileIdentity(source.stats) };
    // link/unlink 会更新 ctime；其余身份和内容相关字段必须保持不变。
    if (!renamed || !['dev', 'ino', 'size', 'mtimeMs'].every(field => before.identity[field] === renamed.identity[field])) {
      throw new Error('改名后的文件身份无法确认');
    }
    onRename?.({ source: before, target: renamed });
  } catch (cause) {
    const error = new Error(`文件已改名为 ${newName}，但任务记录更新失败；录像文件已保留，请刷新检查成片列表。`, { cause });
    error.code = 'OUTPUT_METADATA_FAILED';
    error.renamed = result;
    throw error;
  }
  return result;
}

export function deleteLibraryOutput(root, id) {
  const file = resolveLibraryOutput(root, id);
  if (!file) return null;
  fs.unlinkSync(file.full);
  return { filename: file.filename, size: file.stats.size };
}

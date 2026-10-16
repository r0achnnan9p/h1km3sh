/** Synchronous transaction boundary: no queue admission can interleave these steps. */
import path from 'node:path';
import { normalizeOutputName } from './output-files.js';
import { captureOutputSource, outputId, renameLibraryOutput, resolveLibraryOutput } from './output-library.js';

export function renameManagedOutputFile(root, id, requestedName, { journal, isBusy = () => false, onRename } = {}) {
  const source = resolveLibraryOutput(root, id);
  if (!source) return null;
  const newName = normalizeOutputName(requestedName);
  const relativePath = path.join(path.dirname(source.relativePath), newName);
  const result = { filename: newName, relativePath };
  if ([source.relativePath, relativePath].some(name => journal.isBusy(name) || isBusy(name))) {
    throw Object.assign(new Error('原文件或目标文件正在导出、上传或等待改名核对，请稍后重试。'), { code: 'OUTPUT_BUSY' });
  }
  if (newName === source.filename) return result;
  const before = captureOutputSource(root, source.full);
  const intent = journal.begin(before, relativePath);
  try {
    const renamed = renameLibraryOutput(root, id, newName, { onRename });
    if (!renamed) throw new Error('原文件已不在原位置，未删除任何录像。');
    journal.finish(intent);
    return renamed;
  } catch (error) {
    if (error.code === 'OUTPUT_EXISTS') { journal.finish(intent); throw error; }
    // EXDEV / unsupported hardlinks / permission / disk errors before mutation
    // must not leave a valid original permanently locked by an empty intent.
    if (journal.cancelUnstarted(intent)) throw error;
    // An unlink can succeed before reporting an I/O error. Reconcile only this
    // transaction, verifying both identities, then update all delivery references.
    // Persistent failures retain the intent and both video paths for safe recovery.
    const failures = journal.recover(onRename, { onlyId: intent });
    if (!failures.length && !journal.isBusy(relativePath) && resolveLibraryOutput(root, outputId(relativePath))) return result;
    const partial = new Error('改名尚未完成，录像已保留；原文件和目标文件暂时锁定，请检查存储权限或稍后重试恢复。', { cause: error });
    partial.code = 'OUTPUT_RENAME_PENDING';
    partial.renamed = result;
    throw partial;
  }
}

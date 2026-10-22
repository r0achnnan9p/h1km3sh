/** A narrow write-ahead intent for filename + delivery-index changes. Never guesses content. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDir } from './data-dir.js';
import { captureOutputSource, outputId, resolveLibraryOutput } from './output-library.js';

const sameFile = (actual, expected) => actual && expected && ['dev', 'ino', 'size', 'mtimeMs'].every(key => Number.isFinite(expected[key]) && actual[key] === expected[key]);
export function createOutputRenameJournal(downloadsDir, file = path.join(resolveDataDir(), 'output-renames.json')) {
  let intents = [], unreadable = false;
  function load() {
    try { const next = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(next)) throw new Error(); intents = next; unreadable = false; }
    catch (error) { if (error.code === 'ENOENT') { intents = []; unreadable = false; } else { unreadable = true; throw new Error('改名恢复记录不可读，未猜测或删除任何录像。'); } }
  }
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      intents = next;
      syncDirectory(path.dirname(file));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function syncDirectory(directory) {
    try { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  }
  function finish(id) { save(intents.filter(intent => intent.id !== id)); }
  return {
    begin(source, targetRelativePath) {
      load();
      const intent = { id: crypto.randomUUID(), source, targetRelativePath };
      save([...intents, intent]); return intent.id;
    },
    finish,
    // Only abandon an intent when no destination exists, and the original video is
    // still precisely the one admitted. Never infer this from file size alone.
    cancelUnstarted(id) {
      const intent = intents.find(item => item.id === id);
      if (!intent) return true;
      const original = resolveLibraryOutput(downloadsDir, outputId(intent.source?.relativePath || ''));
      if (!original || !sameFile(original.stats, intent.source.identity)) return false;
      const destination = path.resolve(downloadsDir, intent.targetRelativePath);
      if (path.dirname(destination) !== original.directory) return false;
      try { fs.lstatSync(destination); return false; }
      catch (error) { if (error.code !== 'ENOENT') return false; }
      finish(id); return true;
    },
    recoverPath(relativePath, onRename, { isBusy = () => false } = {}) {
      load();
      const matches = intents.filter(intent => intent.source?.relativePath === relativePath || intent.targetRelativePath === relativePath);
      return matches.flatMap(intent => {
        if ([intent.source?.relativePath, intent.targetRelativePath].some(isBusy)) return ['成片正在导出或上传，暂不能恢复改名。'];
        if (this.cancelUnstarted(intent.id)) return [];
        return this.recover(onRename, { onlyId: intent.id });
      });
    },
    isBusy(relativePath) { return unreadable || intents.some(intent => intent.source?.relativePath === relativePath || intent.targetRelativePath === relativePath); },
    recover(onRename, { onlyId } = {}) {
      load(); const failures = [];
      for (const intent of [...intents]) {
        if (onlyId && intent.id !== onlyId) continue;
        try {
          const original = resolveLibraryOutput(downloadsDir, outputId(intent.source?.relativePath || ''));
          let target = resolveLibraryOutput(downloadsDir, outputId(intent.targetRelativePath || ''));
          // Resolve/validate target's parent through the verified source (or target).
          const sourceName = path.basename(intent.source?.relativePath || ''), newName = path.basename(intent.targetRelativePath || '');
          const base = original || target;
          if (!base || path.dirname(intent.source.relativePath) !== path.dirname(intent.targetRelativePath)
            || !sourceName.toLowerCase().endsWith('.mp4') || !newName.toLowerCase().endsWith('.mp4')) throw new Error();
          const destination = path.join(base.directory, newName);
          if (target && !sameFile(target.stats, intent.source.identity)) throw new Error();
          if (original && !sameFile(original.stats, intent.source.identity)) throw new Error();
          if (!target) { fs.linkSync(original.full, destination); target = resolveLibraryOutput(downloadsDir, outputId(intent.targetRelativePath)); }
          if (!target || !sameFile(target.stats, intent.source.identity)) throw new Error();
          if (original && original.full !== target.full) fs.unlinkSync(original.full);
          syncDirectory(base.directory);
          const change = { source: intent.source, target: captureOutputSource(downloadsDir, destination) };
          if (!change.target || !sameFile(change.target.identity, intent.source.identity)) throw new Error();
          onRename(change); finish(intent.id);
        } catch { failures.push('部分文件改名尚待核对，相关录像已保留且暂时锁定；请检查文件和数据目录。'); }
      }
      return failures;
    },
  };
}

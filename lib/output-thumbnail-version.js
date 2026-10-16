import { createHash } from 'node:crypto';
export function thumbnailVersion(file) {
  return createHash('sha256').update(JSON.stringify([file.relativePath, ...['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => file.stats[key])])).digest('hex').slice(0, 24);
}

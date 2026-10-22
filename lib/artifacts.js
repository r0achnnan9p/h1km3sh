/** 仅交付已完成的生成文件，临时文件放在独立目录。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from './data-dir.js';

const GROUPS = { snapshot: ['images/snapshot', '.png'], timeline: ['images/timeline', '.png'], clip: ['videos/clips', '.mp4'] };
export function artifactRoot() {
  return path.resolve(process.env.HIKVISION_ARTIFACT_DIR || path.join(resolveDataDir(), 'artifacts'));
}
export function allocateArtifact(kind) {
  const group = GROUPS[kind];
  if (!group) throw new Error('不支持的输出类型。');
  const relative = `${group[0]}/${randomUUID()}${group[1]}`;
  const file = path.join(artifactRoot(), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { file, relative, url: `/artifacts/${relative}` };
}
export function artifactWorkDir() {
  const root = path.join(artifactRoot(), '.work');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'job-'));
}
export function cleanArtifactWork(directory) {
  const root = path.join(artifactRoot(), '.work');
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('job-')) {
    throw new Error('无效的临时目录。');
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
export function isArtifactPath(relative) {
  return /^(images\/(snapshot|timeline)\/[a-f0-9-]{36}\.png|videos\/clips\/[a-f0-9-]{36}\.mp4)$/.test(relative);
}

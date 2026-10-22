/** Small, bounded image-only cover store. Browser input never chooses a filesystem path. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { CONSOLE_CONFIG_OWNER } from './console-config.js';

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
export function validateCoverImage(bytes, claimedType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_COVER_BYTES) throw new Error('INVALID_COVER');
  let width, height, type;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(8) === 13 && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); type = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    type = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('INVALID_COVER');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('INVALID_COVER');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('INVALID_COVER');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('INVALID_COVER');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!type || (claimedType && claimedType !== type) || !width || !height || width > 8192 || height > 8192 || width * height > 25_000_000) throw new Error('INVALID_COVER');
  return { type, width, height };
}
function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > MAX_COVER_BYTES || s.size < 24) throw new Error('INVALID_COVER');
    const bytes = fs.readFileSync(fd); return { bytes, ...validateCoverImage(bytes) };
  } finally { fs.closeSync(fd); }
}
export function createUploadCoverStore(root, { fallbackFile = process.env.BILIUP_COVER_FILE || '' } = {}) {
  const metadata = path.join(root, 'cover.json');
  const managed = () => {
    const fd = fs.openSync(metadata, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > 128) throw new Error('INVALID_COVER');
      const type = JSON.parse(fs.readFileSync(fd, 'utf8')).type;
      if (!['image/png', 'image/jpeg'].includes(type)) throw new Error('INVALID_COVER');
      return path.join(root, type === 'image/png' ? 'cover.png' : 'cover.jpg');
    } finally { fs.closeSync(fd); }
  };
  function pathForWorker() {
    try { const file = managed(); readFile(file); return file; } catch {}
    if (fallbackFile) { try { readFile(fallbackFile); return fallbackFile; } catch {} }
    return '';
  }
  function status() {
    try { readFile(managed()); return { present: true, source: 'managed' }; } catch {}
    if (fallbackFile) { try { readFile(fallbackFile); return { present: true, source: 'server' }; } catch {} }
    return { present: false, source: 'missing' };
  }
  return {
    status, pathForWorker,
    read() { const file = pathForWorker(); if (!file) throw new Error('MISSING_COVER'); return readFile(file); },
    save(bytes, type) {
      const image = validateCoverImage(bytes, type);
      let current = path.parse(path.resolve(root)).root;
      for (const part of path.resolve(root).slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_COVER');
      }
      fs.chmodSync(root, 0o700);
      const file = path.join(root, image.type === 'image/png' ? 'cover.png' : 'cover.jpg');
      const tmp = path.join(root, `.${crypto.randomUUID()}.tmp`), metaTmp = tmp + '.json';
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const metaFd = fs.openSync(metaTmp, 'wx', 0o600);
        try { fs.writeFileSync(metaFd, JSON.stringify({ type: image.type })); fs.fsyncSync(metaFd); } finally { fs.closeSync(metaFd); }
        fs.renameSync(tmp, file); fs.renameSync(metaTmp, metadata);
        const parent = fs.openSync(root, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } finally { fs.rmSync(tmp, { force: true }); fs.rmSync(metaTmp, { force: true }); }
      return status();
    },
  };
}
export function mountUploadCover(app, { store, canWrite = () => true, preparationOnly = () => process.env.HIKCLIP_PREPARATION_ONLY === '1', onChange = () => {} }) {
  const endpoint = '/console/api/settings/bilibili-cover';
  app.use(endpoint, (req, res, next) => {
    res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    if (!req[CONSOLE_CONFIG_OWNER]) return res.status(401).json({ success: false, error: '请从已登录的控制台配置封面。' });
    next();
  });
  app.get(endpoint, (req, res) => {
    try { const value = store.read(); res.type(value.type).send(value.bytes); }
    catch { res.status(404).json({ success: false, error: '尚未设置有效封面。' }); }
  });
  app.put(endpoint, (req, res, next) => {
    if (preparationOnly()) return res.status(409).json({ success: false, error: '当前为准备模式，尚未开放封面设置。' });
    if (!canWrite()) return res.status(503).json({ success: false, error: '任务恢复尚未就绪，请稍后设置封面。' });
    next();
  }, express.raw({ type: ['image/png', 'image/jpeg'], limit: MAX_COVER_BYTES }), async (req, res) => {
    try {
      if (req[CONSOLE_CONFIG_OWNER]?.isSessionActive?.() === false) return res.status(401).json({ success: false, error: '登录已退出，请重新登录后设置封面。' });
      if (preparationOnly()) return res.status(409).json({ success: false, error: '当前为准备模式，尚未开放封面设置。' });
      if (!canWrite()) return res.status(503).json({ success: false, error: '任务恢复尚未就绪，请稍后设置封面。' });
      const cover = store.save(req.body, req.get('content-type')?.split(';')[0]); await onChange();
      res.json({ success: true, cover });
    } catch { res.status(400).json({ success: false, error: '封面必须是 5 MiB 以内的有效 PNG/JPEG，最长边不超过 8192 像素。' }); }
  });
  app.use(endpoint, (error, req, res, next) => {
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ success: false, error: '封面无法读取或超过 5 MiB。' });
  });
}

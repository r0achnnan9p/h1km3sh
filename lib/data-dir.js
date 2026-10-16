/**
 * 持久化数据目录解析（devices.json / session.json 共用）。
 *
 *   - 普通运行（node server.js / 便携包）: <project>/data/
 *   - 单文件可执行程序（SEA .exe）:        <exe 所在目录>/data/
 *   - 环境变量 HIKVISION_DATA_DIR 可覆盖
 */

import path from 'path';
import { fileURLToPath } from 'url';
import * as sea from 'node:sea';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SEA 里打包代码的 __dirname 指向虚拟布局，照常用 "../data"（它假设自己在 lib/
 * 子目录下）会解析到错误位置，因此改为锚定在 exe 旁边，与 downloads/ 的处理一致。
 */
export function resolveDataDir() {
  if (process.env.HIKVISION_DATA_DIR) {
    return path.resolve(process.env.HIKVISION_DATA_DIR);
  }
  let isSea = false;
  try { isSea = sea.isSea(); } catch { /* node:sea not available */ }
  if (isSea) {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return path.join(__dirname, '..', 'data');
}

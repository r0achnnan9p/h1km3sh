/**
 * 导出方式选择器（#exportMethodSelect）行为测试。
 *
 * 早期版本导出方式是写死的 mp4download（见 AGENTS.md 技术债 #5 提到的历史包袱），
 * 现在是 index.html 里的真实 <select>，默认选中 rtspclip（HTML 中第一个
 * option，浏览器原生行为，无需 JS 显式设置）。这里直接解析 index.html 验证
 * 结构，而不是复刻一份 JS 逻辑——避免测试和实现各自演化到不一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractSelectOptionValues(selectId) {
  const selectMatch = html.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(selectMatch, `#${selectId} not found in index.html`);
  return Array.from(selectMatch[1].matchAll(/<option value="([^"]*)"/g)).map((m) => m[1]);
}

describe('导出方式选择器 (#exportMethodSelect)', () => {
  it('暴露 rtspclip 与 mp4download 两个选项', () => {
    const values = extractSelectOptionValues('exportMethodSelect');
    assert.deepEqual(values, ['rtspclip', 'mp4download']);
  });

  it('rtspclip 是第一个 option（浏览器原生默认选中）', () => {
    const values = extractSelectOptionValues('exportMethodSelect');
    assert.equal(values[0], 'rtspclip');
  });

  it('两个选项都没有显式 selected 属性覆盖默认行为', () => {
    const selectMatch = html.match(/<select id="exportMethodSelect"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(!/selected/.test(selectMatch[1]), '不应有显式 selected，否则可能不是 rtspclip 默认');
  });
});

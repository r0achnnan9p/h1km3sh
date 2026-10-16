/**
 * 按时长自动选导出方式（lib/export-method.js）。
 *
 * 注意跟 test/export-method.test.js 区分：那个测的是前端 <select> 的选项结构，
 * 这个测的是服务端/MCP 侧的自动选择规则。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickExportMethod,
  resolveExportMethod,
  METHOD_THRESHOLD_SECONDS,
  EXPORT_METHODS,
} from '../lib/export-method.js';

describe('pickExportMethod', () => {
  it('不足 1 小时用 rtspclip', () => {
    assert.equal(pickExportMethod(30).method, 'rtspclip');
    assert.equal(pickExportMethod(600).method, 'rtspclip');
    assert.equal(pickExportMethod(METHOD_THRESHOLD_SECONDS - 1).method, 'rtspclip');
  });

  it('整 1 小时开始用 mp4download（边界含在长的一侧）', () => {
    assert.equal(pickExportMethod(METHOD_THRESHOLD_SECONDS).method, 'mp4download');
    assert.equal(pickExportMethod(METHOD_THRESHOLD_SECONDS + 1).method, 'mp4download');
  });

  it('每天 20:00–22:30 那趟走 mp4download（分片缓存留给后续重导复用）', () => {
    const daily = pickExportMethod(2.5 * 3600);
    assert.equal(daily.method, 'mp4download');
    assert.match(daily.reason, /缓存复用|断点续传/);
  });

  it('开球提前后重导 19:30–22:30 仍然走 mp4download，才能命中缓存', () => {
    assert.equal(pickExportMethod(3 * 3600).method, 'mp4download');
  });

  it('理由里带上分钟数，好让 MCP 如实转述', () => {
    assert.match(pickExportMethod(1800).reason, /30 分钟/);
    assert.match(pickExportMethod(9000).reason, /150 分钟/);
  });

  it('时长非法时抛错', () => {
    assert.throws(() => pickExportMethod(0), /Invalid duration/);
    assert.throws(() => pickExportMethod(-5), /Invalid duration/);
    assert.throws(() => pickExportMethod(NaN), /Invalid duration/);
    assert.throws(() => pickExportMethod(undefined), /Invalid duration/);
  });
});

describe('resolveExportMethod', () => {
  it('缺省和 auto 都走自动选择', () => {
    for (const requested of [undefined, null, '', 'auto']) {
      const resolved = resolveExportMethod(requested, 9000);
      assert.equal(resolved.method, 'mp4download');
      assert.equal(resolved.auto, true);
    }
  });

  it('显式指定时原样采用，并标记为非自动', () => {
    // 2.5 小时按规则本该是 mp4download，显式要 rtspclip 就给 rtspclip
    const resolved = resolveExportMethod('rtspclip', 9000);
    assert.equal(resolved.method, 'rtspclip');
    assert.equal(resolved.auto, false);
    assert.match(resolved.reason, /显式指定/);
  });

  it('两个合法方式都能显式指定', () => {
    for (const method of EXPORT_METHODS) {
      assert.equal(resolveExportMethod(method, 600).method, method);
    }
  });

  it('不认识的方式抛错并列出可选值', () => {
    assert.throws(() => resolveExportMethod('rtsp', 600), /Unsupported export method/);
    assert.throws(() => resolveExportMethod('magic', 600), /rtspclip \/ mp4download/);
  });
});

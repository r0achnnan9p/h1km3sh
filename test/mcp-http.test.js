/**
 * MCP 的 HTTP 传输（lib/mcp-http.js）。
 *
 * 最要紧的是 Origin 校验：服务绑 0.0.0.0、没有鉴权、`app.use(cors())` 放行所有来源，
 * 没有这道校验的话，你在浏览器里打开的任意网页都能 fetch 到这个端点并读到响应。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isOriginAllowed, createMcpHttpHandler, mountMcpHttp } from '../lib/mcp-http.js';

describe('isOriginAllowed', () => {
  it('没有 Origin 头就放行 —— 真正的 MCP 客户端不是浏览器', () => {
    assert.equal(isOriginAllowed(undefined, 'box:30001'), true);
    assert.equal(isOriginAllowed('', 'box:30001'), true);
  });

  it('环回地址放行', () => {
    assert.equal(isOriginAllowed('http://localhost:3000', 'box:30001'), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:8080', 'box:30001'), true);
    assert.equal(isOriginAllowed('http://[::1]:5173', 'box:30001'), true);
  });

  it('同源放行（含端口）', () => {
    assert.equal(isOriginAllowed('http://box:30001', 'box:30001'), true);
    assert.equal(isOriginAllowed('http://192.168.50.10:30001', '192.168.50.10:30001'), true);
  });

  it('端口不同就不算同源', () => {
    assert.equal(isOriginAllowed('http://box:8080', 'box:30001'), false);
  });

  it('外部站点一律拒绝 —— 这正是要防的 DNS rebinding', () => {
    assert.equal(isOriginAllowed('https://evil.example.com', 'box:30001'), false);
    assert.equal(isOriginAllowed('http://box.evil.com', 'box:30001'), false);
  });

  it('非法 Origin 拒绝', () => {
    assert.equal(isOriginAllowed('null', 'box:30001'), false);
    assert.equal(isOriginAllowed('not a url', 'box:30001'), false);
  });

  it('Host 缺失时只认环回地址', () => {
    assert.equal(isOriginAllowed('http://box:30001', undefined), false);
    assert.equal(isOriginAllowed('http://localhost:3000', undefined), true);
  });
});

describe('MCP HTTP 端点', () => {
  let server;
  let baseUrl;

  const dispatcher = {
    async handle(message) {
      if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
      if (message.method === 'notifications/initialized') return null;
      if (message.method === 'explode') throw new Error('处理器炸了');
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } };
    },
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    mountMcpHttp(app, dispatcher);

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  const post = (body, headers = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('单条请求回单条响应', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: {} });
  });

  it('纯通知回 202 且没有 body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });

  it('批量请求回数组', async () => {
    const res = await post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.deepEqual(body.map((r) => r.id), [1, 2]);
  });

  it('批量里混着通知时只回需要回复的那些', async () => {
    const res = await post([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ]);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 7);
  });

  it('整批都是通知时回 202', async () => {
    const res = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    assert.equal(res.status, 202);
  });

  it('分发器抛错时回 JSON-RPC internalError，不是 500', async () => {
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'explode' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error.code, -32603);
    assert.match(body.error.message, /炸了/);
  });

  it('body 不是对象时回 400', async () => {
    assert.equal((await post('nope')).status, 400);
    assert.equal((await post([])).status, 400);
    assert.equal((await post([null])).status, 400);
  });

  it('外部 Origin 被 403 挡住', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example.com' });
    assert.equal(res.status, 403);
  });

  it('环回 Origin 放行', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:5173' });
    assert.equal(res.status, 200);
  });

  it('没有 Origin 头放行', async () => {
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  });

  it('GET 回 405 并声明只支持 POST', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  it('DELETE 回 405 —— 无会话可终止', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });
});

describe('createMcpHttpHandler', () => {
  it('可以脱离 Express 单独构造', () => {
    const handler = createMcpHttpHandler({ handle: async () => null });
    assert.equal(typeof handler, 'function');
  });
});

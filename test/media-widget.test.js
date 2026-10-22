import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MEDIA_WIDGET_URI, mediaWidgetResource } from '../lib/media-widget.js';
import { createHikclipDispatcher } from '../lib/mcp-server.js';

test('状态查询等待进行中的媒体完成再返回链接', async () => {
  let calls = 0;
  const artifactUrl = 'https://camera.example/artifacts/videos/clips/12345678-1234-1234-1234-123456789abc.mp4?expires=123&signature=abc';
  const dispatcher = createHikclipDispatcher({ getStatus: async () => ({ activeTasks: [{ taskId: 'job', cameraJob: true,
    status: ++calls === 1 ? 'processing' : 'completed', ...(calls > 1 ? { artifactUrl } : {}) }] }), resolveBaseUrl: async () => 'http://localhost' });
  const response = await dispatcher.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_export_status', arguments: { taskId: 'job' } } });
  assert.equal(calls, 2);
  assert.equal(response.result.structuredContent.status, 'completed');
  assert.equal(response.result.structuredContent.artifactUrl, artifactUrl);
});

test('录像工具直接返回真实 MP4 结构化结果而非截图替代', async () => {
  const artifactUrl = 'https://camera.example/artifacts/videos/clips/12345678-1234-1234-1234-123456789abc.mp4?expires=123&signature=abc';
  let operation;
  const dispatcher = createHikclipDispatcher({ startCameraJob: async (value) => { operation = value; return { taskId: 'video-job' }; },
    getStatus: async () => ({ activeTasks: [{ taskId: 'video-job', status: 'completed', source: 'mediamtx', artifactUrl }] }) });
  const response = await dispatcher.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_video_clip',
    arguments: { camera: 'D2', start: '2026-09-27 20:20:00', end: '2026-09-27 20:21:00' } } });
  assert.equal(operation, 'clip');
  assert.equal(response.result.structuredContent.kind, 'video');
  assert.equal(response.result.structuredContent.artifactUrl, artifactUrl);
  assert.ok(!response.result.content.some(item => item.type === 'image'));
});

test('媒体组件通过 MCP 发现和读取，视频与图片工具声明模板与权限', async () => {
  const dispatcher = createHikclipDispatcher({}, { oauth: true });
  const request = (method, params) => dispatcher.handle({ jsonrpc: '2.0', id: 1, method, params }, { publicBaseUrl: 'https://camera.example' });
  const init = await request('initialize', {});
  assert.ok(init.result.capabilities.resources);
  const listed = await request('tools/list');
  for (const name of ['get_video_clip', 'get_export_status']) {
    const tool = listed.result.tools.find(item => item.name === name);
    assert.equal(tool._meta.ui.resourceUri, MEDIA_WIDGET_URI);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.securitySchemes[0].type, 'oauth2');
  }
  const resource = await request('resources/read', { uri: MEDIA_WIDGET_URI });
  assert.deepEqual(resource.result.contents[0]._meta.ui.csp.resourceDomains, ['https://camera.example']);
  assert.ok((await request('resources/read', { uri: 'file:///secret' })).error);
});

test('组件接收图片与视频结果，保留签名，拒绝外部地址，未完成调用状态工具', async () => {
  const resource = mediaWidgetResource('https://camera.example');
  const script = resource.text.match(/<script>([\s\S]*)<\/script>/)[1];
  const listeners = {}, posts = [], nodes = {};
  let poll;
  for (const id of ['status', 'media', 'link']) nodes[id] = { replaceChildren() { this.children = []; }, append(node) { this.children.push(node); }, children: [] };
  const parent = { postMessage(message) { posts.push(message); } };
  const window = { parent, addEventListener(name, fn) { listeners[name] = fn; } };
  vm.runInNewContext(script, { window, document: { getElementById: id => nodes[id], body: { scrollHeight: 400 }, createElement: name => ({ tagName: name.toUpperCase() }) },
    URL, setTimeout: fn => { poll = fn; }, clearTimeout() {} });
  const send = data => listeners.message({ source: parent, data: { jsonrpc: '2.0', ...data } });
  send({ id: posts[0].id, result: {} });
  await Promise.resolve();
  for (const relative of ['images/snapshot/12345678-1234-1234-1234-123456789abc.png', 'videos/clips/12345678-1234-1234-1234-123456789abc.mp4']) {
    const artifactUrl = `https://camera.example/artifacts/${relative}?expires=123&signature=abc`;
    send({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'completed', artifactUrl } } });
    if (relative.endsWith('mp4')) assert.equal(nodes.media.children[0].src, artifactUrl);
    assert.equal(nodes.link.href, artifactUrl);
    if (relative.endsWith('mp4')) {
      const video = nodes.media.children[0];
      assert.equal(video.tagName, 'VIDEO'); assert.equal(video.defaultMuted, true); assert.equal(video.muted, true);
      video.muted = false;
      send({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'completed', artifactUrl } } });
      assert.equal(nodes.media.children[0], video); assert.equal(video.muted, false);
    }
    else assert.equal(nodes.media.children.length, 0);
  }
  send({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'completed', artifactUrl: 'https://evil.example/file' } } });
  assert.equal(nodes.status.textContent, '媒体地址不受信任');
  send({ method: 'ui/notifications/tool-result', params: { structuredContent: { taskId: 'job', status: 'processing' } } });
  poll();
  const call = posts.find(item => item.method === 'tools/call');
  assert.equal(call.params.name, 'get_export_status');
  assert.equal(call.params.arguments.taskId, 'job');
});

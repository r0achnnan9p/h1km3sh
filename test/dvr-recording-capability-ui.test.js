/** UI-only fixtures; never connect to a device or start an export. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener() {}
}
const context = vm.createContext({
  document: { createElement: tag => new Element(tag) }, Date,
  taskStageLabel: () => '', statusText: () => '失败',
  taskProgressPresentation: () => ({ show: false }), taskProgressCaption: () => '', uploadProgressCaption: () => '',
});
vm.runInContext(script.slice(script.indexOf('function makeTaskCard('), script.indexOf('async function recoverCloudUpload(')), context);

const record = { durationSeconds: 10, uriDurationSeconds: 30, sizeBytes: 123456, uriRange: 'covers', hasName: true };
const envelope = { outcome: 'available', matchCount: 1, recordings: [record], downloadByTime: 'supported' };
function card(recording = envelope, task = {}, uploadTask = false) {
  return context.makeTaskCard({ status: 'error', filename: 'synthetic.mp4',
    failureDiagnostics: { method: 'DESCRIBE', rtspStatus: 400, authorizationSent: true, recording }, ...task,
  }, uploadTask);
}
const facts = value => value.children.find(node => node.className === 'task-detail task-recording-facts')?.textContent;
const secret = 'private-password rtsp://private-host/private-selector <script>raw-device-output</script>';
const assertSafe = value => assert.doesNotMatch(JSON.stringify(value), /private-|rtsp:\/\/|<script>|raw-device-output/);

test('failed task preserves prior diagnostic lines and displays first recording facts', () => {
  const rendered = card({ ...envelope, recordings: [record, { durationSeconds: 999, uriDurationSeconds: 999, sizeBytes: 999 }] });
  assert.equal(rendered.children.find(node => node.className === 'task-detail task-diagnostic').textContent, 'RTSP DESCRIBE · 400 · 已发送认证');
  assert.equal(rendered.children.find(node => node.className === 'task-detail task-recording-diagnostic').textContent, '查询到 1 段录像 · 地址时间覆盖选段 · 有文件标识');
  assert.equal(facts(rendered), '首段时长：10 秒 · 地址时长：30 秒 · 大小：123456 B · 按时间下载：支持');
  assert.doesNotMatch(facts(rendered), /999/);
});

test('matching URI duration is omitted while zero and fractional seconds remain valid', () => {
  assert.equal(facts(card({ ...envelope, recordings: [{ durationSeconds: 0, uriDurationSeconds: 0, sizeBytes: 0 }] })),
    '首段时长：0 秒 · 大小：0 B · 按时间下载：支持');
  assert.equal(facts(card({ ...envelope, recordings: [{ durationSeconds: 10.5, uriDurationSeconds: 10.5, sizeBytes: 10 }] })),
    '首段时长：10.5 秒 · 大小：10 B · 按时间下载：支持');
});

test('old saved tasks and absent recordings display unknown numeric facts and capability', () => {
  for (const recordings of [undefined, null, [], [{}], [null], ['legacy'], {}]) {
    const rendered = card({ outcome: 'available', matchCount: 1, recordings });
    assert.equal(facts(rendered), '首段时长：未知 · 地址时长：未知 · 大小：未知 · 按时间下载：未知');
  }
  assert.equal(facts(card({ ...envelope, recordings: [{ durationSeconds: 10, sizeBytes: 20 }] })),
    '首段时长：10 秒 · 地址时长：未知 · 大小：20 B · 按时间下载：支持');
});

test('download-by-time labels use a closed enum for available and unsuccessful search outcomes', () => {
  for (const [downloadByTime, label] of [['supported', '支持'], ['unsupported', '不支持'], ['unknown', '未知'], [undefined, '未知']]) {
    assert.ok(facts(card({ ...envelope, downloadByTime })).endsWith(`按时间下载：${label}`));
    assert.equal(facts(card({ outcome: 'no_match', recordings: [], downloadByTime })), `按时间下载：${label}`);
  }
});

test('numeric facts reject nonfinite, negative, oversized and coercible values without reflecting raw data', () => {
  const hostile = { toString() { throw new Error('must not stringify'); }, valueOf() { throw new Error('must not coerce'); }, raw: secret };
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '123', secret, {}, hostile, [123], true, 1n, Symbol(secret)]) {
    const rendered = card({ ...envelope, recordings: [{ durationSeconds: value, uriDurationSeconds: value, sizeBytes: value, playbackURI: secret }] });
    assert.equal(facts(rendered), '首段时长：未知 · 地址时长：未知 · 大小：未知 · 按时间下载：支持');
    assertSafe(rendered);
  }
  assert.equal(facts(card({ ...envelope, recordings: [{ ...record, sizeBytes: 1.5 }] })),
    '首段时长：10 秒 · 地址时长：30 秒 · 大小：未知 · 按时间下载：支持');
  assert.equal(facts(card({ ...envelope, recordings: [{ durationSeconds: Number.MAX_SAFE_INTEGER, uriDurationSeconds: Number.MAX_SAFE_INTEGER, sizeBytes: Number.MAX_SAFE_INTEGER }] })),
    `首段时长：${Number.MAX_SAFE_INTEGER} 秒 · 大小：${Number.MAX_SAFE_INTEGER} B · 按时间下载：支持`);
});

test('malicious capability strings and objects become unknown without coercion or raw-field leaks', () => {
  const hostile = { toString() { throw new Error('must not stringify'); }, valueOf() { throw new Error('must not coerce'); }, raw: secret };
  for (const downloadByTime of [secret, 'SUPPORTED', 'constructor', '__proto__', '', null, true, 1, NaN, {}, hostile, ['supported'], Symbol(secret)]) {
    const rendered = card({ ...envelope, downloadByTime, playbackURI: secret, raw: secret });
    assert.ok(facts(rendered).endsWith('按时间下载：未知'));
    assertSafe(rendered);
  }
});

test('new diagnostics remain limited to failed DVR task cards with recognized diagnostic envelopes', () => {
  assert.equal(facts(card(envelope, { status: 'completed' })), undefined);
  assert.equal(facts(card(envelope, {}, true)), undefined);
  assert.equal(facts(card({ ...envelope, outcome: secret })), undefined);
  assert.equal(facts(card(undefined, { failureDiagnostics: undefined })), undefined);
});

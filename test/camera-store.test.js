import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let directory, store, devices, first, second;
const previousDataDir = process.env.HIKVISION_DATA_DIR;
const previousArchiveDir = process.env.HIKVISION_ARCHIVE_DIR;
const previousApiUrl = process.env.HIKVISION_MEDIAMTX_API_URL;
const secret = 'camera-test-private-password';

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-store-test-'));
  process.env.HIKVISION_DATA_DIR = directory;
  process.env.HIKVISION_ARCHIVE_DIR = path.join(directory, 'archive');
  process.env.HIKVISION_MEDIAMTX_API_URL = '';
  devices = await import('../lib/device-store.js');
  store = await import('../lib/camera-store.js');
});

after(() => {
  if (previousDataDir === undefined) delete process.env.HIKVISION_DATA_DIR;
  else process.env.HIKVISION_DATA_DIR = previousDataDir;
  if (previousArchiveDir === undefined) delete process.env.HIKVISION_ARCHIVE_DIR;
  else process.env.HIKVISION_ARCHIVE_DIR = previousArchiveDir;
  if (previousApiUrl === undefined) delete process.env.HIKVISION_MEDIAMTX_API_URL;
  else process.env.HIKVISION_MEDIAMTX_API_URL = previousApiUrl;
  // 测试目录由 mkdtemp 创建，校验边界后仅清理该目录。
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('camera-store-test-'));
  fs.rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(devices.getDataFilePath(), { force: true });
  fs.rmSync(store.getCameraDataFilePath(), { force: true });
  first = devices.addDevice({ name: 'DVR1', ip: '192.0.2.1', username: 'admin', password: secret });
  second = devices.addDevice({ name: 'DVR2', ip: '192.0.2.2', username: 'admin', password: secret });
});

function cameras() {
  return [
    { id: 'door', name: '门口', deviceId: first.id, channel: 101 },
    { id: 'yard', name: '院子', deviceId: first.id, channel: '201' },
    { id: 'garage', name: '车库', deviceId: second.id, channel: '301' },
  ];
}

test('未配置时返回空目录，不生成猜测的别名', () => {
  assert.deepEqual(store.listCameras(), []);
  assert.equal(store.getCamera('door'), null);
});

test('两台 DVR 的别名正确解析各自通道，不改变激活设备', () => {
  store.saveCameras(cameras());
  const door = store.resolveCamera('门口');
  assert.equal(door.camera.channel, '101');
  assert.equal(door.device.id, first.id);
  assert.equal(door.device.password, secret);
  assert.equal(store.resolveCamera('yard').camera.channel, '201');
  const garage = store.resolveCamera('garage');
  assert.equal(garage.camera.channel, '301');
  assert.equal(garage.device.id, second.id);
  assert.equal(devices.getActiveDevice().id, first.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.getCameraDataFilePath(), 'utf8')).cameras,
    cameras().map((camera) => ({ ...camera, channel: String(camera.channel) })));
});

test('对外目录只返回 ID 和名称，配置不复制 DVR 凭据', () => {
  const list = store.saveCameras(cameras());
  assert.deepEqual(list, [
    { id: 'door', name: '门口' }, { id: 'yard', name: '院子' }, { id: 'garage', name: '车库' },
  ]);
  for (const value of [JSON.stringify(list), fs.readFileSync(store.getCameraDataFilePath(), 'utf8')]) {
    assert.ok(!value.includes(secret));
    assert.ok(!value.includes(first.ip));
    assert.ok(!value.includes('password'));
  }
});

test('配置重复名称、ID 或跨名称的 ID 时拒绝写入，原目录保留', () => {
  store.saveCameras(cameras());
  for (const patch of [{ id: 'door' }, { name: '门口' }, { name: 'door' }]) {
    const next = cameras();
    Object.assign(next[1], patch);
    assert.throws(() => store.saveCameras(next), /重复/);
    assert.equal(store.listCameras().length, 3);
  }
});

test('拒绝凭据字段、协议注入、路径形式 ID 和无效配置', () => {
  for (const patch of [
    { password: secret }, { ip: first.ip }, { username: 'admin' },
    { channel: '101\r\nPLAY' }, { channel: {} }, { channel: '123456789' },
    { id: '../door' }, { name: ' 门口' }, { deviceId: '' },
  ]) {
    assert.throws(() => store.saveCameras([{ ...cameras()[0], ...patch }]));
  }
  for (const invalid of [null, {}, [null], [[]]]) {
    assert.throws(() => store.saveCameras(invalid));
  }
  assert.deepEqual(store.listCameras(), []);
});

test('未知摄像头和失效 DVR 明确报错，不回退到当前设备', () => {
  store.saveCameras(cameras());
  assert.throws(() => store.resolveCamera('missing'), /摄像头不存在/);
  devices.deleteDevice(second.id);
  assert.throws(() => store.resolveCamera('车库'), /DVR 已不存在/);
  assert.equal(store.resolveCamera('门口').device.id, first.id);
  assert.throws(() => store.saveCameras(cameras()), /DVR 不存在/);
});

test('损坏 JSON 和非法磁盘配置明确报错，不带出原始内容', () => {
  const file = store.getCameraDataFilePath();
  fs.writeFileSync(file, `{"password":"${secret}"`);
  assert.throws(() => store.listCameras(), (error) => {
    assert.match(error.message, /不是有效 JSON/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  fs.writeFileSync(file, JSON.stringify({ cameras: [{ ...cameras()[0], password: secret }] }));
  assert.throws(() => store.listCameras(), /不能包含凭据/);
  fs.writeFileSync(file, JSON.stringify({ cameras: cameras(), password: secret }));
  assert.throws(() => store.listCameras(), /根对象/);
});

test('可以清空目录，临时写入文件不残留', () => {
  store.saveCameras(cameras());
  assert.deepEqual(store.saveCameras([]), []);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')), []);
});

test('MediaMTX-only mappings need no DVR, never resolve the active DVR, and preserve explicit IDs', () => {
  const local = { id: 'local-camera', name: '本地前场', archivePath: 'd1' };
  store.saveCameras([local]);
  assert.deepEqual(store.resolveCamera('本地前场'), { camera: local, device: null });
  assert.equal(devices.getActiveDevice().id, first.id);
  assert.deepEqual(store.readCameras(), [local]);
  for (const patch of [{ deviceId: first.id }, { channel: '101' }, { deviceId: null }, { archivePath: '../d1' }]) {
    assert.throws(() => store.validateCameras([{ ...local, ...patch }]));
  }
  assert.throws(() => store.validateCameras([{ id: 'empty', name: 'empty' }]), /MediaMTX/);
});

test('automatic paths merge by archive path, preserve saved aliases, and avoid alias/ID collisions', () => {
  const saved = [{ id: 'D1', name: '前场', deviceId: first.id, channel: '101', archivePath: 'd1' }];
  const result = store.cameraCatalog(saved, ['d2', 'd1', 'd2', 'D1']);
  assert.deepEqual(result[0], saved[0]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.find(camera => camera.archivePath === 'd2'), { id: 'd2', name: 'd2', archivePath: 'd2' });
  const collision = result.find(camera => camera.archivePath === 'D1');
  assert.match(collision.id, /^mtx-[a-f0-9]{32}$/); assert.notEqual(collision.name, 'D1');
  assert.deepEqual(store.cameraCatalog(saved, ['D1', 'd1', 'd2']), result);
});

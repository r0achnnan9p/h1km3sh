/**
 * lib/device-store.js —— 设备增删改查与激活设备一致性测试
 *
 * 覆盖 addDevice/deleteDevice/updateDevice/activateDevice/getDeviceById/getActiveDevice
 * 这套服务端真实实现（data/devices.json 持久化，取代早期浏览器 localStorage 方案）。
 * 通过 HIKVISION_DATA_DIR 环境变量把数据目录指向临时目录，避免读写开发机真实的
 * data/devices.json。device-store.js 在模块加载时就地解析数据目录常量，因此必须先
 * 设置环境变量，再用动态 import() 加载模块，静态 import 会在环境变量生效前执行。
 *
 * Property 2（沿用旧测试的分组习惯，非引用外部规格文档）：
 * - ADD: 新增任意合法设备后，该设备应出现在列表中且字段与入参一致
 * - DELETE: 删除列表中任意设备后，该设备应从列表消失且长度减一，其余设备保持不变
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fc from 'fast-check';

describe('lib/device-store.js', () => {
  let tmpDir;
  let deviceStore;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-test-'));
    process.env.HIKVISION_DATA_DIR = tmpDir;
    deviceStore = await import('../lib/device-store.js');
  });

  after(() => {
    delete process.env.HIKVISION_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function resetStore() {
    fs.rmSync(deviceStore.getDataFilePath(), { force: true });
  }

  beforeEach(() => {
    resetStore();
  });

  const nonEmptyString = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);
  const deviceFieldsArb = fc.record({
    name: fc.option(nonEmptyString, { nil: undefined }),
    ip: fc.ipV4(),
    username: nonEmptyString,
    password: nonEmptyString,
  });
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  describe('getDataFilePath', () => {
    it('返回临时数据目录下的 devices.json 路径', () => {
      const p = deviceStore.getDataFilePath();
      assert.ok(p.startsWith(tmpDir));
      assert.equal(path.basename(p), 'devices.json');
    });
  });

  describe('addDevice: 新增设备', () => {
    it('property: 新增后设备出现在列表中，字段与入参一致（50 次随机用例）', () => {
      fc.assert(
        fc.property(deviceFieldsArb, (fields) => {
          resetStore();
          const created = deviceStore.addDevice(fields);

          assert.equal(created.ip, fields.ip);
          assert.equal(created.username, fields.username);
          assert.equal(created.password, fields.password);
          assert.equal(created.name, fields.name || fields.ip);
          assert.match(created.id, UUID_RE);
          assert.ok(created.createdAt);

          const { devices } = deviceStore.getAllDevices();
          assert.ok(devices.some((d) => d.id === created.id));
          assert.deepEqual(deviceStore.getDeviceById(created.id), created);
        }),
        { numRuns: 50 }
      );
    });

    it('第一台设备会被自动设为激活设备', () => {
      const created = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      assert.equal(deviceStore.getAllDevices().activeDeviceId, created.id);
      assert.deepEqual(deviceStore.getActiveDevice(), created);
    });

    it('第二台及以后新增的设备不会改变已有的激活设备', () => {
      const first = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      deviceStore.addDevice({ ip: '10.0.0.2', username: 'admin', password: 'pass' });
      assert.equal(deviceStore.getAllDevices().activeDeviceId, first.id);
    });

    it('未提供 name 时回退为 ip', () => {
      const created = deviceStore.addDevice({ ip: '192.168.1.1', username: 'admin', password: 'pass' });
      assert.equal(created.name, '192.168.1.1');
    });

    it('property: 新增设备后已有设备保持不变，列表长度加一（30 次随机用例）', () => {
      fc.assert(
        fc.property(
          fc.array(deviceFieldsArb, { minLength: 1, maxLength: 5 }),
          deviceFieldsArb,
          (existingFields, extraFields) => {
            resetStore();
            const existing = existingFields.map((f) => deviceStore.addDevice(f));
            const beforeCount = deviceStore.getAllDevices().devices.length;

            const created = deviceStore.addDevice(extraFields);

            const after = deviceStore.getAllDevices().devices;
            assert.equal(after.length, beforeCount + 1);
            for (const dev of existing) {
              assert.ok(after.some((d) => d.id === dev.id), `已有设备 ${dev.id} 应仍在列表中`);
            }
            assert.ok(after.some((d) => d.id === created.id));
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('deleteDevice: 删除设备', () => {
    it('property: 删除后设备从列表消失，长度减一（50 次随机用例）', () => {
      fc.assert(
        fc.property(
          fc.array(deviceFieldsArb, { minLength: 1, maxLength: 8 }),
          fc.nat(),
          (fieldsList, rawIndex) => {
            resetStore();
            const created = fieldsList.map((f) => deviceStore.addDevice(f));
            const target = created[rawIndex % created.length];
            const beforeCount = deviceStore.getAllDevices().devices.length;

            const result = deviceStore.deleteDevice(target.id);

            assert.equal(result, true);
            const after = deviceStore.getAllDevices().devices;
            assert.equal(after.length, beforeCount - 1);
            assert.ok(!after.some((d) => d.id === target.id));
            assert.equal(deviceStore.getDeviceById(target.id), null);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('property: 删除保留其余设备且相对顺序不变（50 次随机用例）', () => {
      fc.assert(
        fc.property(
          fc.array(deviceFieldsArb, { minLength: 1, maxLength: 8 }),
          fc.nat(),
          (fieldsList, rawIndex) => {
            resetStore();
            const created = fieldsList.map((f) => deviceStore.addDevice(f));
            const idx = rawIndex % created.length;
            const expectedRemainingIds = created.filter((_, i) => i !== idx).map((d) => d.id);

            deviceStore.deleteDevice(created[idx].id);

            const afterIds = deviceStore.getAllDevices().devices.map((d) => d.id);
            assert.deepEqual(afterIds, expectedRemainingIds);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('删除不存在的 id 返回 false 且不影响现有列表', () => {
      const created = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      const result = deviceStore.deleteDevice('non-existent-id');
      assert.equal(result, false);
      assert.equal(deviceStore.getAllDevices().devices.length, 1);
      assert.deepEqual(deviceStore.getDeviceById(created.id), created);
    });

    it('删除当前激活设备后，激活设备重新指向剩余列表中的第一个', () => {
      const first = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      const second = deviceStore.addDevice({ ip: '10.0.0.2', username: 'admin', password: 'pass' });
      deviceStore.deleteDevice(first.id); // first 是自动激活的设备
      assert.equal(deviceStore.getAllDevices().activeDeviceId, second.id);
    });

    it('删除最后一个设备后，激活设备变为 null', () => {
      const only = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      deviceStore.deleteDevice(only.id);
      const { activeDeviceId, devices } = deviceStore.getAllDevices();
      assert.equal(activeDeviceId, null);
      assert.equal(devices.length, 0);
      assert.equal(deviceStore.getActiveDevice(), null);
    });
  });

  describe('updateDevice: 更新设备', () => {
    it('只更新允许的字段并写入 updatedAt，id 等其余字段不受影响', () => {
      const created = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      const updated = deviceStore.updateDevice(created.id, {
        name: '新名字',
        password: 'newpass',
        id: 'hacked-id',
      });

      assert.equal(updated.id, created.id);
      assert.equal(updated.name, '新名字');
      assert.equal(updated.password, 'newpass');
      assert.equal(updated.ip, created.ip);
      assert.ok(updated.updatedAt);
    });

    it('更新不存在的设备返回 null', () => {
      const result = deviceStore.updateDevice('non-existent-id', { name: 'x' });
      assert.equal(result, null);
    });
  });

  describe('activateDevice: 切换激活设备', () => {
    it('激活存在的设备会更新 activeDeviceId', () => {
      deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      const second = deviceStore.addDevice({ ip: '10.0.0.2', username: 'admin', password: 'pass' });

      const activated = deviceStore.activateDevice(second.id);

      assert.deepEqual(activated, second);
      assert.equal(deviceStore.getAllDevices().activeDeviceId, second.id);
      assert.deepEqual(deviceStore.getActiveDevice(), second);
    });

    it('激活不存在的设备返回 null 且不改变原激活设备', () => {
      const first = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
      const result = deviceStore.activateDevice('non-existent-id');
      assert.equal(result, null);
      assert.equal(deviceStore.getAllDevices().activeDeviceId, first.id);
    });
  });

  describe('endpoint storage safety', () => {
    it('normalizes legacy endpoints without rewriting bytes on read', () => {
      const raw = JSON.stringify({ devices: [{ id: 'legacy', ip: '192.0.2.1:8080', password: 'secret' }], activeDeviceId: 'legacy' });
      fs.writeFileSync(deviceStore.getDataFilePath(), raw);
      const device = deviceStore.getActiveDevice();
      assert.equal(device.ip, '192.0.2.1'); assert.equal(device.httpPort, 8080); assert.equal(device.rtspPort, 554);
      assert.equal(fs.readFileSync(deviceStore.getDataFilePath(), 'utf8'), raw);
    });
    it('preserves passwords on omitted/blank updates and saves private atomic files', () => {
      const device = deviceStore.addDevice({ ip: '192.0.2.1', password: 'secret', httpPort: 8080, rtspPort: 8554 }, { autoActivate: false });
      assert.equal(deviceStore.getActiveDevice(), null);
      assert.equal(deviceStore.updateDevice(device.id, { name: 'Updated', password: '' }).password, 'secret');
      assert.equal(deviceStore.updateDevice(device.id, { httpPort: 8081 }).password, 'secret');
      assert.equal(deviceStore.getDeviceById(device.id).rtspPort, 8554);
      assert.equal(fs.statSync(deviceStore.getDataFilePath()).mode & 0o777, 0o600);
      assert.equal(fs.readdirSync(tmpDir).some(name => name.endsWith('.tmp')), false);
    });
    it('secure deletion clears active selection without silently switching recorders', () => {
      const first = deviceStore.addDevice({ ip: '192.0.2.1' });
      const second = deviceStore.addDevice({ ip: '192.0.2.2' });
      assert.equal(deviceStore.deleteDevice(first.id, { autoActivate: false }), true);
      assert.equal(deviceStore.getActiveDevice(), null);
      assert.ok(deviceStore.getDeviceById(second.id));
    });
    it('rejects invalid endpoint mutations before writing', () => {
      const device = deviceStore.addDevice({ ip: '192.0.2.1', password: 'secret' });
      const raw = fs.readFileSync(deviceStore.getDataFilePath(), 'utf8');
      assert.throws(() => deviceStore.updateDevice(device.id, { rtspPort: 65536 }));
      assert.throws(() => deviceStore.updateDevice(device.id, { ip: 'host/path' }));
      assert.throws(() => deviceStore.updateDevice(device.id, { username: { password: 'secret' } }));
      assert.equal(fs.readFileSync(deviceStore.getDataFilePath(), 'utf8'), raw);
    });
    it('fails closed on corrupt JSON and shape, preserving original bytes', () => {
      for (const raw of ['{broken', '{}', '{"devices":{}}', '{"devices":[{"id":"a","ip":"bad/path"}]}', '{"devices":[{"id":"a","ip":"host","name":{"password":"secret"}}]}']) {
        fs.writeFileSync(deviceStore.getDataFilePath(), raw);
        assert.throws(() => deviceStore.getAllDevices(), /original file preserved/);
        assert.throws(() => deviceStore.addDevice({ ip: '192.0.2.1' }), /original file preserved/);
        assert.throws(() => deviceStore.deleteDevice('a'), /original file preserved/);
        assert.equal(fs.readFileSync(deviceStore.getDataFilePath(), 'utf8'), raw);
      }
    });
  });

  describe('空列表边界', () => {
    it('getDeviceById 在空列表中返回 null', () => {
      assert.equal(deviceStore.getDeviceById('any-id'), null);
    });

    it('未设置 activeDeviceId 时 getActiveDevice 返回 null', () => {
      assert.equal(deviceStore.getActiveDevice(), null);
    });
  });
});


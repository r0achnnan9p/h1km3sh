/**
 * public/app.js —— loadSavedDevices() 设备下拉框渲染逻辑测试
 *
 * loadSavedDevices() 定义在 app.js 顶层作用域内，依赖模块级 DOM 元素引用，无法直接
 * import 执行，因此把其中的纯渲染算法原样抽出来测试（做法与 test/task-restore.test.js
 * 对 restoreActiveTaskStatus() 的处理一致）。真实实现（public/app.js）：
 *   deviceSelect.innerHTML = '<option value="">选择设备…</option>';
 *   deviceList.forEach(dev => {
 *     option.value = dev.id;
 *     option.textContent = dev.name || `${dev.ip} (${dev.username})`;
 *   });
 *   if (activeDeviceId) deviceSelect.value = activeDeviceId;
 *
 * 用一个轻量 <select>/<option> mock 验证渲染结果，不引入 jsdom；设备数据来自真实的
 * lib/device-store.js（临时数据目录，见 device-crud.test.js 的隔离方式），确保渲染逻辑
 * 吃到的是服务端真实返回的数据形状（option.value 为服务端分配的 UUID，字段名是
 * username 而非旧版的 user）。
 *
 * Property 1（沿用旧测试的分组习惯，非引用外部规格文档）：
 * 对任意设备数组，渲染后下拉框应恰好有 (数组长度 + 1) 个 option（含占位符），
 * 且每个设备 option 都能正确对应到其 id 与显示文本。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

const INDEX_HTML_PATH = fileURLToPath(new URL('../public/index.html', import.meta.url));

// ---------------------------------------------------------------------------
// 轻量 <select>/<option> mock（不依赖 jsdom）
// ---------------------------------------------------------------------------

function createMockOption() {
  return { value: '', textContent: '' };
}

function createMockSelect() {
  const children = [];
  let selectedValue = '';
  return {
    set innerHTML(html) {
      children.length = 0;
      const matches = html.match(/<option value="([^"]*)">([\s\S]*?)<\/option>/g) || [];
      for (const optHtml of matches) {
        const valueMatch = optHtml.match(/value="([^"]*)"/);
        const textMatch = optHtml.match(/>([^<]*)<\/option>/);
        const opt = createMockOption();
        opt.value = valueMatch ? valueMatch[1] : '';
        opt.textContent = textMatch ? textMatch[1] : '';
        children.push(opt);
      }
      selectedValue = children[0] ? children[0].value : '';
    },
    appendChild(child) {
      children.push(child);
    },
    get options() {
      return children;
    },
    get value() {
      return selectedValue;
    },
    set value(v) {
      // 模拟原生 <select>.value 语义：找不到匹配 option 时选中状态清空（而不是保持旧值）
      selectedValue = children.some((c) => c.value === v) ? v : '';
    },
  };
}

/**
 * 原样镜像 public/app.js 中 loadSavedDevices() 的渲染部分（不含 api.getDevices()
 * 网络请求与 try/catch —— 那部分需要 mock fetch，超出渲染逻辑测试范围）。
 */
function renderDeviceSelect(select, { devices, activeDeviceId }) {
  select.innerHTML = '<option value="">选择设备…</option>';
  devices.forEach((dev) => {
    const option = createMockOption();
    option.value = dev.id;
    option.textContent = dev.name || `${dev.ip} (${dev.username})`;
    select.appendChild(option);
  });
  if (activeDeviceId) select.value = activeDeviceId;
}

// ---------------------------------------------------------------------------
// index.html 静态结构
// ---------------------------------------------------------------------------

describe('index.html: 设备选择器初始结构', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');

  it('存在 id 为 deviceSelect 的 <select>，初始内容为占位符 option', () => {
    assert.match(html, /<select id="deviceSelect"[^>]*>\s*<option value="">选择设备…<\/option>\s*<\/select>/);
  });

  it('设备工具条包含新增设备 / 删除设备按钮', () => {
    assert.match(html, /id="btnAddDevice"/);
    assert.match(html, /id="btnDeleteDevice"/);
  });
});

// ---------------------------------------------------------------------------
// 渲染逻辑 + lib/device-store.js 真实数据形状
// ---------------------------------------------------------------------------

describe('loadSavedDevices() 渲染逻辑', () => {
  let tmpDir;
  let deviceStore;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-list-render-test-'));
    process.env.HIKVISION_DATA_DIR = tmpDir;
    deviceStore = await import('../lib/device-store.js');
  });

  after(() => {
    delete process.env.HIKVISION_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(deviceStore.getDataFilePath(), { force: true });
  });

  it('空设备列表 → 只剩占位符 option', () => {
    const select = createMockSelect();
    renderDeviceSelect(select, { devices: [], activeDeviceId: null });

    assert.equal(select.options.length, 1);
    assert.equal(select.options[0].value, '');
    assert.equal(select.options[0].textContent, '选择设备…');
  });

  it('使用 device-store.js 真实产出的设备数据渲染：option.value 为服务端 UUID', () => {
    // addDevice() 在创建时就用 name = name || ip 兜底了，所以未传 name 的设备
    // 拿到的 dev.name 也一定是非空的 ip ——这里同时验证这一点。
    deviceStore.addDevice({ name: '前台 NVR', ip: '192.168.1.10', username: 'admin', password: 'pass1' });
    deviceStore.addDevice({ ip: '192.168.1.11', username: 'operator', password: 'pass2' });

    const { devices, activeDeviceId } = deviceStore.getAllDevices();
    const select = createMockSelect();
    renderDeviceSelect(select, { devices, activeDeviceId });

    assert.equal(select.options.length, devices.length + 1);
    assert.equal(select.options[1].value, devices[0].id);
    assert.equal(select.options[1].textContent, '前台 NVR');
    assert.equal(select.options[2].value, devices[1].id);
    assert.equal(devices[1].name, '192.168.1.11');
    assert.equal(select.options[2].textContent, '192.168.1.11');
  });

  it('name 被显式清空后（如直接编辑 devices.json），渲染回退到 "ip (username)"', () => {
    const created = deviceStore.addDevice({ ip: '192.168.1.11', username: 'operator', password: 'pass2' });
    deviceStore.updateDevice(created.id, { name: '' });

    const { devices, activeDeviceId } = deviceStore.getAllDevices();
    const select = createMockSelect();
    renderDeviceSelect(select, { devices, activeDeviceId });

    assert.equal(select.options[1].textContent, '192.168.1.11 (operator)');
  });

  it('activeDeviceId 命中某个设备时，渲染后 select.value 等于该 id', () => {
    const first = deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
    deviceStore.addDevice({ ip: '10.0.0.2', username: 'admin', password: 'pass' });
    deviceStore.activateDevice(first.id);

    const { devices, activeDeviceId } = deviceStore.getAllDevices();
    const select = createMockSelect();
    renderDeviceSelect(select, { devices, activeDeviceId });

    assert.equal(select.value, first.id);
  });

  it('activeDeviceId 为 null 时，渲染后 select.value 保持占位符（空字符串）', () => {
    deviceStore.addDevice({ ip: '10.0.0.1', username: 'admin', password: 'pass' });
    const { devices } = deviceStore.getAllDevices();

    const select = createMockSelect();
    renderDeviceSelect(select, { devices, activeDeviceId: null });

    assert.equal(select.value, '');
  });

  // -------------------------------------------------------------------------
  // Property 1: 对任意设备数组，option 数量与内容均正确对应
  // -------------------------------------------------------------------------

  const nonEmptyString = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);
  const deviceFieldsArb = fc.record({
    name: fc.option(nonEmptyString, { nil: undefined }),
    ip: fc.ipV4(),
    username: nonEmptyString,
    password: nonEmptyString,
  });

  it('property: option 数量恒为设备数 + 1，每个设备 option 的 value/文本均正确对应（30 次随机用例）', () => {
    fc.assert(
      fc.property(fc.array(deviceFieldsArb, { minLength: 0, maxLength: 10 }), (fieldsList) => {
        fs.rmSync(deviceStore.getDataFilePath(), { force: true });
        const devices = fieldsList.map((f) => deviceStore.addDevice(f));

        const select = createMockSelect();
        renderDeviceSelect(select, { devices, activeDeviceId: null });

        assert.equal(select.options.length, devices.length + 1);
        assert.equal(select.options[0].textContent, '选择设备…');

        devices.forEach((dev, i) => {
          const opt = select.options[i + 1];
          assert.equal(opt.value, dev.id);
          assert.equal(opt.textContent, dev.name || `${dev.ip} (${dev.username})`);
        });
      }),
      { numRuns: 30 }
    );
  });
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness(addDevice) {
  const nodes = { dialogIp: { value: '192.0.2.1' }, dialogUser: { value: 'operator' }, dialogPass: { value: ' password ' }, btnDialogConfirm: { disabled: false }, btnDialogCancel: { disabled: false }, deviceSelect: { value: '' } };
  const message = { textContent: '' }, calls = [];
  const context = vm.createContext({ ...nodes, $: () => message, api: { addDevice, activateDevice: async id => calls.push(['activate', id]) }, loadSavedDevices: async () => calls.push(['load']), hideAddDeviceDialog: () => calls.push(['hide']), connectDevice: params => calls.push(['connect', params]) });
  vm.runInContext(script.slice(script.indexOf('async function confirmAddDevice('), script.indexOf('// --- Export ---')), context);
  return { context, nodes, message, calls };
}
test('LAN device save failure keeps the editor and never connects an unsaved device', async () => {
  for (const addDevice of [async () => { throw new Error('network failed'); }, async () => ({ success: false, error: 'invalid address' })]) {
    const h = harness(addDevice); await h.context.confirmAddDevice();
    assert.match(h.message.textContent, /保存设备失败/); assert.deepEqual(h.calls, []);
    assert.equal(h.nodes.btnDialogConfirm.disabled, false); assert.equal(h.nodes.dialogIp.value, '192.0.2.1');
  }
});
test('LAN device save suppresses duplicate submissions and preserves password whitespace', async () => {
  let resolve; const requests = []; const h = harness((...args) => { requests.push(args); return new Promise(done => { resolve = done; }); });
  const first = h.context.confirmAddDevice(); await h.context.confirmAddDevice(); assert.equal(requests.length, 1); assert.equal(requests[0][2], ' password ');
  resolve({ success: true, device: { id: 'dvr-1' } }); await first;
  assert.equal(h.nodes.deviceSelect.value, 'dvr-1'); assert.deepEqual(h.calls.map(call => call[0]), ['load', 'activate', 'hide', 'connect']);
  assert.equal(h.nodes.btnDialogConfirm.disabled, false);
});
test('both consoles use shared selection sheets; legacy dialogs are labelled and feedback is announced', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const util = fs.readFileSync(new URL('../public/util.js', import.meta.url), 'utf8');
  assert.match(script, /enhanceDateInput\(dateSelect/); assert.match(script, /\[deviceSelect, channelSelect, exportMethodSelect\]\.forEach\(enhanceSelect\)/);
  assert.match(html, /id="deviceDialogError" class="dialog-error" role="alert"/);
  assert.match(html, /id="settingsDrawer" role="dialog"/);
  assert.match(util, /containDialogFocus/); assert.match(util, /if \(submit\) await submit\(value\)/);
  assert.doesNotMatch(util, /else if \(e.key === 'Enter'\) close\(true\)/);
});

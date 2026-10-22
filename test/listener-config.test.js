import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenerConfig } from '../lib/listener-config.js';

test('legacy listener defaults remain compatible', () => {
  assert.deepEqual(listenerConfig({}), { host: '0.0.0.0', port: 30001, attempts: 20, schedulerEnabled: true });
});
test('production and native preparation fail closed on occupied ports', () => {
  assert.equal(listenerConfig({ NODE_ENV: 'production' }).attempts, 0);
  assert.deepEqual(listenerConfig({ HIKCLIP_BIND: '127.0.0.1', PORT: '30001', HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_SCHEDULER_ENABLED: '0' }),
    { host: '127.0.0.1', port: 30001, attempts: 0, schedulerEnabled: false });
  assert.equal(listenerConfig({ PORT: '65535' }).attempts, 0);
});
test('explicit development override and invalid deployment configuration', () => {
  assert.equal(listenerConfig({ NODE_ENV: 'production', HIKCLIP_PORT_FALLBACK: '1' }).attempts, 20);
  for (const env of [{ PORT: '0' }, { PORT: '65536' }, { PORT: 'abc' }, { PORT: '2.1' }, { HIKCLIP_BIND: '::1' },
    { HIKCLIP_PORT_FALLBACK: 'yes' }, { HIKCLIP_SCHEDULER_ENABLED: 'false' }]) assert.throws(() => listenerConfig(env));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native systemd unit uses the documented Node 24 installation entrypoint', () => {
  const unit = fs.readFileSync(new URL('../deploy/native/app.service.in', import.meta.url), 'utf8');
  const documentation = fs.readFileSync(new URL('../docs/native-staging.md', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node scripts\/native-start\.js$/m);
  assert.doesNotMatch(unit, /^ExecStart=\/usr\/bin\/node\b/m);
  assert.ok(documentation.includes('`/usr/local/bin/node` → `/opt/nodejs/current/bin/node`'));
  assert.ok(documentation.includes('`/usr/local/bin/node --version`'));
});


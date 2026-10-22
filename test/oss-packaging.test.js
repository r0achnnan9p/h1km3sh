import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('repository license, package metadata and bundled font license are present', () => {
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].license, 'MIT');
  assert.match(read('public/fonts/OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
});

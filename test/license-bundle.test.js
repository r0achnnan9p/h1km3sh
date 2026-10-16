import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('source license bundle includes complete notices and resolving local links', () => {
 for (const file of ['licenses/README.md','licenses/third-party-notices.md','docs/third-party-notices.md']) {
  const url=new URL('../'+file,import.meta.url),text=fs.readFileSync(url,'utf8');let count=0;
  for(const [,link]of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
   if(/^[a-z]+:/.test(link))continue;
   assert.ok(fs.existsSync(new URL(link,url)),file+' -> '+link);count++;
  }
  assert.ok(count>0);
 }
 for(const file of ['licenses/mediamtx-reader.LICENSE','licenses/radix-icons-LICENSE.txt'])assert.match(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),/Permission is hereby granted/);
 assert.match(fs.readFileSync(new URL('../licenses/jetbrains-mono-OFL.txt',import.meta.url),'utf8'),/SIL OPEN FONT LICENSE Version 1\.1/);
});

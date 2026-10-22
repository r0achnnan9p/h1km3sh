import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';

const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
function moduleGraph(entry, seen=new Set()) {
  if(seen.has(entry)) return seen;
  seen.add(entry);
  const content=fs.readFileSync(path.join(publicRoot,entry),'utf8');
  for(const match of content.matchAll(/(?:import|export)\s[^;\n]*?from\s*['"](\.[^'"]+)['"]/g)) {
    const next=path.posix.normalize(path.posix.join(path.posix.dirname(entry),match[1]));
    assert.ok(!next.startsWith('../')); moduleGraph(next,seen);
  }
  return seen;
}
test('public login page can load the complete actual console ES module graph without a session',async()=>{
  const app=express();app.use(express.static(publicRoot));
  app.get('/console/api/bootstrap',(_req,res)=>res.json({private:true}));
  const server=createPublicGateway(app,{token:'synthetic-public-module-test-token-123456789',baseUrl:'https://hik.example.com/h1km3sh',statusPasswordHash:createStatusPasswordHash('synthetic-only-password'),getStatus:()=>({tasks:[]})}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const files=moduleGraph('console.js');
    assert.ok(files.has('precision-timeline.js'),'include the active ruler module');
    assert.ok(files.has('mediamtx-reader.js'),'follow the transitive import from mediamtx-live-player.js');
    for(const file of files){const response=await fetch(`${base}/${file}`);assert.equal(response.status,200,file);assert.match(response.headers.get('content-type'),/javascript/);assert.equal(await response.text(),fs.readFileSync(path.join(publicRoot,file),'utf8'));}
    assert.equal((await fetch(base+'/console/api/bootstrap')).status,401);
    assert.notEqual((await fetch(base+'/app.js')).status,200);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

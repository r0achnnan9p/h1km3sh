import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountMediaMtxLive } from '../lib/mediamtx-live-routes.js';
async function harness(t,{delayed=false}={}){
  const app=express();let generation=0,attached=null,release,stopped=0,reserved=0;
  const peer=()=>({answer:'v=0\r\nanswer',etag:'"test"',patch:async()=>{},stop:async()=>{stopped++;}});
  mountMediaMtxLive(app,{getCamera:id=>['d1','d2'].includes(id)?{id,archivePath:id}:null,transport:{options:async()=>({link:'<stun:example.test>; rel="ice-server"'}),open:async()=>delayed?new Promise(resolve=>{release=()=>resolve(peer());}):peer()},reservePreview:async()=>{reserved++;const mine=++generation;return {isCurrent:()=>generation===mine,attach:s=>{attached=s;},finish:s=>{if(attached===s)attached=null;}};}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  return {base:`http://127.0.0.1:${server.address().port}`,get attached(){return attached;},get stopped(){return stopped;},get reserved(){return reserved;},get release(){return release;},supersede(){generation++;}};
}
test('WHEP routes bind session to one known camera and clean up through shared preview lease',async t=>{
  const h=await harness(t),path='/console/api/playback/d2/live/';
  const options=await fetch(h.base+path+'options');assert.equal(options.status,204);assert.match(options.headers.get('link'),/ice-server/);
  const post=await fetch(h.base+path+'whep',{method:'POST',headers:{'Content-Type':'application/sdp'},body:'v=0\r\noffer'});assert.equal(post.status,201);assert.ok(h.attached);
  const session=new URL(post.headers.get('location'),h.base+path+'whep');assert.match(session.pathname,/\/live\/sessions\/[a-f0-9-]{36}$/);
  assert.equal((await fetch(session,{method:'PATCH',headers:{'Content-Type':'application/trickle-ice-sdpfrag'},body:'a=x'})).status,204);
  assert.equal((await fetch(session.href.replace('/d2/','/d1/'),{method:'DELETE'})).status,404);assert.equal(h.stopped,0);
  await h.attached.stop('export started');assert.equal(h.attached,null);assert.equal(h.stopped,1);
  assert.equal((await fetch(session,{method:'DELETE'})).status,404);
});
test('unknown cameras and malformed offers do not reserve or stop any existing preview',async t=>{
  const h=await harness(t);for(const [camera,body,status] of [['missing','v=0',404],['d2','bad',400]]){
    const r=await fetch(`${h.base}/console/api/playback/${camera}/live/whep`,{method:'POST',headers:{'Content-Type':'application/sdp'},body});assert.equal(r.status,status);
  }assert.equal(h.reserved,0);
});
test('a late offer cannot replace a newer source or export reservation',async t=>{
  const h=await harness(t,{delayed:true});const work=fetch(`${h.base}/console/api/playback/d2/live/whep`,{method:'POST',headers:{'Content-Type':'application/sdp'},body:'v=0'});
  for(let i=0;i<100&&!h.release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(h.release);h.supersede();h.release();assert.equal((await work).status,409);assert.equal(h.attached,null);assert.equal(h.stopped,1);
});

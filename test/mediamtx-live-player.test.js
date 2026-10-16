import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/mediamtx-live-player.js', import.meta.url),'utf8').replace(/^import .*\n/,'').replace('export function','function');
const location = new URL('https://test.example/h1km3sh/');
const id='11111111-1111-4111-8111-111111111111';
function harness(fetchImpl = async () => new Response(null,{status:204}), { fakeClock = false } = {}) {
  let clock = 0, tick;
  const Clock = class extends Date { static now() { return clock; } };
  const listeners = new Map(), calls = []; let conf, closed=0, ready=0, unavailable=0;
  const video={srcObject:null,videoWidth:1920,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k),play:async()=>{}};
  class Reader {constructor(c){conf=c;}close(){closed++;}}
  const c=vm.createContext({URL,location,Response,AbortController,setTimeout,clearTimeout,setInterval: fakeClock ? fn => { tick = fn; return 1; } : setInterval, clearInterval: fakeClock ? () => {} : clearInterval, Date: fakeClock ? Clock : Date, MediaMTXWebRTCReader:Reader,fetch:fetchImpl});vm.runInContext(source,c);
  const player=c.startMediaMtxLive({video,url:'/h1km3sh/console/api/playback/d2/live/whep',onReady:()=>ready++,onUnavailable:()=>unavailable++,fetchImpl:async(u,o)=>{calls.push([String(u),o]);return fetchImpl(u,o);}});
  return {video,player,calls,listeners,advance(ms) { clock += ms; tick(); },get conf(){return conf;},get closed(){return closed;},get ready(){return ready;},get unavailable(){return unavailable;}};
}
test('same-origin options translation, session cleanup, and late tracks cannot replace a newer video', async()=>{
  const h=harness(async(u,o)=>o.method==='POST'?new Response('v=0',{status:201,headers:{Location:`sessions/${id}`} }):new Response(null,{status:204}));
  await h.conf.fetch(h.conf.url,{method:'OPTIONS'}); assert.equal(h.calls[0][0],'https://test.example/h1km3sh/console/api/playback/d2/live/options'); assert.equal(h.calls[0][1].method,'GET');
  await h.conf.fetch(h.conf.url,{method:'POST'});
  const stream={}; h.conf.onTrack({streams:[stream]}); assert.equal(h.video.srcObject,stream);
  h.listeners.get('playing')(); assert.equal(h.ready,1);
  const newer={}; h.video.srcObject=newer;h.player.close();h.player.close();await Promise.resolve();
  assert.equal(h.closed,1);assert.equal(h.video.srcObject,newer);assert.equal(h.calls.filter(x=>x[1].method==='DELETE').length,1);
  h.conf.onTrack({streams:[{}]});assert.equal(h.video.srcObject,newer);assert.equal(h.unavailable,0);
});
test('reader failure falls back once and prevents library retry',()=>{
  const h=harness();h.conf.onError('offline');h.conf.onError('again');assert.equal(h.unavailable,1);assert.equal(h.closed,1);
});
test('hostile session location is rejected before any followup request',async()=>{
  const h=harness(async()=>new Response('v=0',{status:201,headers:{Location:`https://other.test/sessions/${id}`}}));
  await assert.rejects(h.conf.fetch(h.conf.url,{method:'POST'}),/地址无效/);h.player.close();assert.equal(h.calls.length,1);
});
test('a POST response arriving after close is deleted rather than adopted',async()=>{
  let finish;const h=harness((u,o)=>o.method==='POST'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(new Response(null,{status:204})));
  const request=h.conf.fetch(h.conf.url,{method:'POST'});h.player.close();finish(new Response('v=0',{status:201,headers:{Location:`sessions/${id}`}}));
  await assert.rejects(request,/closed/);assert.equal(h.calls.filter(x=>x[1].method==='DELETE').length,1);assert.equal(h.video.srcObject,null);
});

test('decoded-frame stall falls back, while a user pause does not',()=>{
  const h=harness(undefined,{fakeClock:true}); h.video.currentTime=1; h.video.paused=false; h.conf.onTrack({streams:[{}]});h.listeners.get('playing')();
  h.advance(1000);h.video.paused=true;h.advance(20000);assert.equal(h.unavailable,0);
  h.video.paused=false;h.video.currentTime=2;h.advance(1000);h.advance(9000);assert.equal(h.unavailable,0);h.advance(1000);assert.equal(h.unavailable,1);
});

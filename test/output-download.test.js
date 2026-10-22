import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutputDownload, readShareFile, SHARE_BYTE_LIMIT } from '../public/output-download.js';
class Node {
  children=[];listeners={};attributes={};disabled=false;textContent='';
  append(...nodes){this.children.push(...nodes);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,fn){this.listeners[key]=fn;}
  click(event={}){if(!this.disabled)return this.listeners.click?.({preventDefault(){},...event});}
}
const tick=()=>new Promise(done=>setImmediate(done));
function harness({size=10,shareable=true,touch=true,fetchImpl=async()=>new Response(new Uint8Array(10),{headers:{'content-type':'video/mp4'}})}={}){
 const sheets=[],shares=[],requests=[],notices=[];const document={createElement:()=>new Node()};
 const navigator={maxTouchPoints:touch?1:0,canShare:()=>shareable,share:data=>{shares.push(data);return Promise.resolve();}};
 const file={filename:'sample.mp4',size,streamUrl:'/stream/one'};
 const button=createOutputDownload({file,document,navigator,resolveUrl:x=>'/app'+x,onNotice:text=>notices.push(text),fetch:(...args)=>{requests.push(args);return fetchImpl(...args);},openDialog(){const sheet={content:new Node(),actions:new Node(),dialog:new Node(),error:new Node(),closed:false,close(){this.closed=true;this.dialog.listeners.close?.();}};sheets.push(sheet);return sheet;}});
 return {button,sheets,shares,requests,notices,navigator};
}
test('multi-GB and desktop files use browser download without fetching bytes or opening a dialog',()=>{
 for(const options of [{size:6.08*1024**3},{touch:false},{shareable:false}]){
  const h=harness(options);h.button.element.click({preventDefault:()=>assert.fail('direct download must remain native')});
  assert.equal(h.requests.length,0);assert.equal(h.sheets.length,0);assert.equal(h.button.element.href,'/app/stream/one?download=1');assert.equal(h.button.element.download,'sample.mp4');
  if(options.touch===false) assert.deepEqual(h.notices,[]);
 }
});
test('small touch video prepares bounded file but invokes share only on a fresh second click',async()=>{
 const h=harness();let prevented=false;h.button.element.click({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(h.shares.length,0);assert.equal(h.requests.length,1);
 const sheet=h.sheets[0],share=sheet.actions.children[1];assert.equal(share.disabled,true);
 await tick();assert.equal(share.disabled,false);assert.equal(h.shares.length,0);
 const result=share.click();assert.equal(h.shares.length,1,'share is invoked synchronously in the second click');await result;
 assert.equal(h.shares[0].files[0].name,'sample.mp4');assert.equal(h.shares[0].files[0].size,10);assert.equal(sheet.closed,true);
});
test('closing preparation aborts its fetch and a late response cannot enable sharing',async()=>{
 let finish;const h=harness({fetchImpl:()=>new Promise(done=>{finish=done;})});h.button.element.click();const sheet=h.sheets[0];sheet.close();
 assert.equal(h.requests[0][1].signal.aborted,true);
 finish(new Response(new Uint8Array(4),{headers:{'content-type':'video/mp4'}}));await tick();assert.equal(sheet.actions.children[1].disabled,true);assert.equal(h.shares.length,0);
});
test('declared and streamed size caps reject before retaining an oversized file',async()=>{
 let cancelled=false;const huge={ok:true,headers:new Headers({'content-type':'video/mp4','content-length':String(SHARE_BYTE_LIMIT+1)}),body:{cancel:async()=>{cancelled=true;},getReader:()=>assert.fail('declared oversize must not be read')}};
 await assert.rejects(readShareFile(huge,'x.mp4'),/视频较大/);assert.equal(cancelled,true);
 let reads=0,cancels=0;const response={ok:true,headers:new Headers({'content-type':'video/mp4'}),body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(6)};},cancel:async()=>{cancels++;},releaseLock(){}})}};
 await assert.rejects(readShareFile(response,'x.mp4',{limit:10}),/视频较大/);assert.equal(reads,2);assert.equal(cancels,1);
});
test('missing stream support, failed HTTP, login HTML and empty video do not become shared video',async()=>{
 for(const response of [new Response('error',{status:401}),new Response('<html>login</html>',{headers:{'content-type':'text/html'}}),new Response('',{headers:{'content-type':'video/mp4'}}),{ok:true,headers:new Headers({'content-type':'video/mp4'}),body:null}])await assert.rejects(readShareFile(response,'x.mp4'));
});
test('share cancellation remains retryable and direct download survives preparation failure',async()=>{
 const h=harness();h.navigator.share=()=>Promise.reject(Object.assign(new Error('cancel'),{name:'AbortError'}));h.button.element.click();await tick();const sheet=h.sheets[0];await sheet.actions.children[1].click();
 assert.equal(sheet.closed,false);assert.equal(sheet.actions.children[1].disabled,false);assert.equal(sheet.error.textContent,'');
 const failed=harness({fetchImpl:async()=>{throw new Error('offline');}});failed.button.element.click();await tick();const other=failed.sheets[0];assert.match(other.error.textContent,/offline/);assert.equal(other.actions.children[0].download,'sample.mp4');assert.equal(other.actions.children[0].href,'/app/stream/one?download=1');
});
test('updated file identity changes the independent download link and modifier clicks remain native',()=>{
 const h=harness();h.button.update({filename:'renamed.mp4',size:12,streamUrl:'/stream/two'});
 assert.equal(h.button.element.download,'renamed.mp4');assert.equal(h.button.element.href,'/app/stream/two?download=1');
 h.button.element.click({ctrlKey:true,preventDefault:()=>assert.fail('modified link stays native')});assert.equal(h.requests.length,0);
});

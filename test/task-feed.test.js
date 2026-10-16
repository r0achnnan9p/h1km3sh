import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateTracker } from '../lib/rate-tracker.js';
import { fmtBps, formatEta, createTransferSampler, createTaskFeed } from '../public/task-presentation.js';
test('decimal bit speed promotes at the rounded boundary and keeps three significant digits', () => {
 for (const [n,v,u] of [[0,'0.00','bps'],[9.994,'9.99','bps'],[9.995,'10.0','bps'],[99.95,'100','bps'],[999,'999','bps'],[999.5,'1.00','Kbps'],[1000,'1.00','Kbps'],[999499,'999','Kbps'],[999500,'1.00','Mbps'],[1e9,'1.00','Gbps']]) assert.deepEqual(fmtBps(n),{v,u});
});
test('one byte window ignores duplicate/future evidence, ages out and resets retries', () => {
 const sampler=createTransferSampler(),now=1800000000000;
 const task={id:'u',status:'uploading',stage:'uploading',uploadedBytes:1000,totalBytes:10000,uploadSpeed:1000,progressUpdatedAt:now};
 assert.equal(sampler.sample(task,now).bps,null);sampler.sample(task,now);
 task.progressUpdatedAt+=1000;task.uploadSpeed=3000;task.uploadedBytes=4000;
 let sample=sampler.sample(task,now+1000);assert.equal(sample.bps,24000);assert.equal(sample.eta,2);assert.equal(sample.history.length,1);
 assert.equal(sampler.sample(task,now+8000).bps,null);
 task.retryRequestedAt=now+9000;task.progressUpdatedAt=now+9000;task.uploadedBytes=0;assert.equal(sampler.sample(task,now+9000).bps,null);
 task.stage='submitting';assert.equal(sampler.sample(task,now+9000).eta,null);
 const future={...task,stage:'uploading',progressUpdatedAt:now+100000};assert.equal(sampler.sample(future,now).bps,null);
});
test('RateTracker to sampler does not double smooth; transfer stop becomes zero inside five seconds', () => {
 const tracker=createRateTracker(),sampler=createTransferSampler(),now=1800000000000;let sample;
 for(let ms=0;ms<=12000;ms+=500){const bytes=Math.min(ms/1000,6)*1e6;const speed=tracker.update(bytes,now+ms);
  if(ms%1500===0) sample=sampler.sample({id:'tracker',status:'downloading',transferredBytes:bytes,progressUpdatedAt:now+ms,speedUpdatedAt:now+ms,speed},now+ms);
 }
 assert.equal(sample.bps,0);assert.equal(sample.eta,null);
 const fallback=createTransferSampler();assert.equal(fallback.sample({id:'rate',status:'downloading',speed:1e6,speedUpdatedAt:now},now).bps,8e6);
 assert.equal(fallback.sample({id:'rate',status:'downloading',speed:0,speedUpdatedAt:now+1500},now+1500).bps,0);
 assert.equal(fallback.sample({id:'189',status:'uploading',progressUpdatedAt:now},now).bps,null);
});
test('byte deltas use server timestamps and unknown totals never invent ETA', () => {
 const sampler=createTransferSampler(),now=1800000000000,task={id:'delta',status:'downloading',transferredBytes:1000,progressUpdatedAt:now};
 assert.equal(sampler.sample(task,now).bps,null); task.transferredBytes=4000;task.progressUpdatedAt+=1000;
 const sample=sampler.sample(task,now+1000);assert.equal(sample.bps,24000);assert.equal(sample.eta,null);
 task.transferredBytes=1;task.progressUpdatedAt+=1000;assert.equal(sampler.sample(task,now+2000).bps,null);
});
class Element {
 children=[];dataset={};events={};hidden=false;scrollTop=0;className='';_text='';
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
 set textContent(value){this._text=value;this.children=[];}
 get outerHTML(){return this.className+this.textContent+this.children.map(n=>n.outerHTML).join('');}
 get firstChild(){return this.children[0];}
 append(node){if(node.parent)node.remove();this.children.push(node);node.parent=this;}
 insertBefore(node,next){if(node.parent)node.remove();const i=next?this.children.indexOf(next):-1;if(i<0)this.children.push(node);else this.children.splice(i,0,node);node.parent=this;}
 remove(){if(this.parent){const a=this.parent.children;a.splice(a.indexOf(this),1);this.parent=null;}}
 removeChild(node){node.remove();}
 addEventListener(name,fn){this.events[name]=fn;}
 setAttribute(){}
 contains(){return false;}
 querySelectorAll(){return [];}
}
test('125 tasks paginate by 20; stable IDs, SSE scroll, loaded count and hidden-tab scroll survive', () => {
 const original=globalThis.document;globalThis.document={createElement:()=>new Element(),activeElement:null};
 try{
  const list=new Element(),scroller=new Element(),sentinel=new Element();
  const feed=createTaskFeed({list,scroller,sentinel,createdAt:t=>t.createdAt,makeCard:t=>{const card=new Element();const text=new Element();text.textContent=t.title;card.append(text);return card;}});
  const tasks=Array.from({length:125},(_,i)=>({id:'t'+i,title:'task '+i,status:i===124?'unknown':i===123?'downloading':'completed',createdAt:1800000000000-i*1000}));
  feed.update(tasks);assert.equal(feed.loadedCount,20);assert.equal(list.children[0].dataset.taskId,'t124');assert.equal(list.children[1].dataset.taskId,'t123');
  const stable=list.children[1];feed.loadMore();feed.loadMore();assert.equal(feed.loadedCount,60);scroller.scrollTop=940;scroller.events.scroll();
  feed.update(tasks.map(t=>({...t,title:t.id==='t123'?'changed':t.title})));assert.equal(feed.loadedCount,60);assert.equal(scroller.scrollTop,940);assert.equal(list.children[1],stable);assert.equal(stable.firstChild.textContent,'changed');assert.equal(stable.children.length,2);
  scroller.hidden=true;scroller.scrollTop=0;feed.update(tasks);feed.loadMore();assert.equal(feed.loadedCount,60);
  scroller.hidden=false;feed.resume();assert.equal(scroller.scrollTop,940);
  for(let i=0;i<5;i++)feed.loadMore();assert.equal(feed.loadedCount,125);assert.equal(sentinel.hidden,true);
  feed.update([]);assert.equal(feed.loadedCount,0);assert.equal(list.children.length,1);
 }finally{globalThis.document=original;}
});

test('ETA display consumes seconds, preserving minute and second boundaries', () => { assert.equal(formatEta(9),'0:09');assert.equal(formatEta(538),'8:58');assert.equal(formatEta(60),'1:00');assert.equal(formatEta(59.1),'1:00');assert.equal(formatEta(null),'—'); });

class LayoutElement extends Element {
 get height(){return this.tag==='details'?this.children.slice(0,this.open?undefined:1).reduce((sum,e)=>sum+e.height,0):this.className==='working'?200:this.className==='task-date-heading'?20:64;}
 get hiddenByDetails(){let p=this.parent;while(p){if(p.tag==='details'&&!p.open)return true;p=p.parent;}return false;}
 getClientRects(){return this.offscreen||this.hiddenByDetails?[]:[this.getBoundingClientRect()];}
 getBoundingClientRect(){if(this.hiddenByDetails)return {top:0,bottom:0};if(this.isScroller)return {top:100,bottom:400};const parent=this.parent;const top=parent?parent.getBoundingClientRect().top+parent.children.slice(0,parent.children.indexOf(this)).reduce((n,e)=>n+e.height,0):100-(this.scroller?.scrollTop||0);return{top,bottom:top+this.height};}
 querySelectorAll(selector){return selector==='[data-task-id]'?this.children.flatMap(e=>[...(e.dataset.taskId?[e]:[]),...e.querySelectorAll(selector)]):[];}
}
test('visible task ID and offset survive insert, completion shrink/reorder, deletion and offscreen SSE',()=>{
 const doc={createElement:()=>new LayoutElement(),activeElement:null},list=new LayoutElement(),scroller=new LayoutElement(),sentinel=new LayoutElement();scroller.isScroller=true;list.scroller=scroller;
 const feed=createTaskFeed({list,scroller,sentinel,document:doc,createdAt:t=>t.createdAt,makeCard:t=>{const e=new LayoutElement();e.className=t.status==='downloading'?'working':'history';e.textContent=t.id;return e;}});
 let tasks=Array.from({length:30},(_,i)=>({id:'t'+i,status:i<3?'downloading':'completed',createdAt:1800000000000-i*1000}));feed.update(tasks);feed.loadMore();scroller.scrollTop=700;scroller.events.scroll();
 const cards=()=>list.querySelectorAll('[data-task-id]');const anchor=cards().find(e=>e.getBoundingClientRect().bottom>100);const id=anchor.dataset.taskId,offset=anchor.getBoundingClientRect().top-100;
 const check=()=>assert.equal(cards().find(e=>e.dataset.taskId===id).getBoundingClientRect().top-100,offset);
 tasks.unshift({id:'new',status:'queued',createdAt:1800000001000});feed.update(tasks);check();
 tasks=tasks.map(t=>t.id==='t0'?{...t,status:'completed'}:t);feed.update(tasks);check();
 tasks=tasks.filter(t=>t.id!=='new');feed.update(tasks);check();
 scroller.offscreen=true;scroller.scrollTop=0;tasks.unshift({id:'hidden-new',status:'queued',createdAt:1800000002000});feed.update(tasks);feed.loadMore();assert.equal(feed.loadedCount,31);
 scroller.offscreen=false;feed.resume();check();
 tasks=tasks.filter(t=>t.id!==id);feed.update(tasks);assert.ok(Number.isFinite(scroller.scrollTop));
});

test('file-scoped counters reuse reset backend rate when SSE misses the zero counter',()=>{
 const sampler=createTransferSampler(),now=1800000000000;
 const task={id:'multi-file',startedAt:now-10000,status:'downloading',transferScope:'file',transferredBytes:9000000,speed:1000000,speedUpdatedAt:now,progressUpdatedAt:now};
 assert.equal(sampler.sample(task,now).bps,8000000);
 // B's first observed counter exceeds A's last: a task-byte delta would be wrong.
 Object.assign(task,{transferredBytes:10000000,speed:10000000,speedUpdatedAt:now+1600,progressUpdatedAt:now+1600});
 assert.equal(sampler.sample(task,now+1600).bps,80000000);
});
test('archiving visible unknown tasks skips closed details anchors without expanding loaded history',()=>{
 const doc={createElement:tag=>Object.assign(new LayoutElement(),{tag}),activeElement:null},list=new LayoutElement(),scroller=new LayoutElement(),sentinel=new LayoutElement();scroller.isScroller=true;list.scroller=scroller;scroller.clientHeight=300;Object.defineProperty(scroller,'scrollHeight',{get:()=>list.children.reduce((sum,e)=>sum+e.height,0)});
 const feed=createTaskFeed({list,scroller,sentinel,document:doc,createdAt:t=>t.createdAt,makeCard:t=>{const e=new LayoutElement();e.textContent=t.id;return e;}});
 let tasks=Array.from({length:50},(_,i)=>({id:'t'+i,status:'unknown',createdAt:1800000000000-i*1000}));feed.update(tasks);feed.loadMore();scroller.scrollTop=320;scroller.events.scroll();
 const card=id=>list.querySelectorAll('[data-task-id]').find(e=>e.dataset.taskId===id),offset=id=>card(id).getBoundingClientRect().top-100;
 const nextOffset=offset('t6');tasks=tasks.map(t=>t.id==='t5'?{...t,archivedAt:1800000001000}:t);feed.update(tasks);assert.equal(feed.loadedCount,40);assert.equal(offset('t6'),nextOffset);assert.equal(card('t5'),undefined);
 feed.loadMore();assert.equal(feed.loadedCount,50);assert.deepEqual(card('t5').getClientRects(),[]);
 scroller.scrollTop=320;scroller.events.scroll();const secondOffset=offset('t7');tasks=tasks.map(t=>t.id==='t6'?{...t,archivedAt:1800000002000}:t);feed.update(tasks);assert.equal(offset('t7'),secondOffset);assert.deepEqual(card('t6').getBoundingClientRect(),{top:0,bottom:0});
 tasks=tasks.map(t=>({...t,archivedAt:1800000003000}));feed.update(tasks);assert.equal(scroller.scrollTop,0);
});

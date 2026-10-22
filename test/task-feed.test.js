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
 addEventListener(name,fn){const previous=this.events[name];this.events[name]=previous?event=>{previous(event);fn(event);}:fn;}
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
test('MediaMTX converting reports its live backend rate while DVR trimming stays unknown',()=>{
 const sampler=createTransferSampler(),now=1800000000000;
 const media={id:'media-cut',status:'converting',speed:5e6,speedUpdatedAt:now,progressUpdatedAt:now};
 assert.equal(sampler.sample(media,now).bps,4e7);
 assert.equal(sampler.sample(media,now+7000).bps,null,'stale rate ages out like any other transfer');
 const trim={id:'dvr-trim',status:'converting',progressUpdatedAt:now};
 assert.equal(sampler.sample(trim,now).bps,null);
 const zero={id:'media-zero',status:'converting',speed:0,speedUpdatedAt:now};
 assert.equal(sampler.sample(zero,now).bps,null,'zero is not evidence of an active cut');
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


function revealHarness(items) {
 const doc={createElement:tag=>Object.assign(new LayoutElement(),{tag}),activeElement:null};
 const list=new LayoutElement(),scroller=new LayoutElement(),sentinel=new LayoutElement();
 scroller.isScroller=true;list.scroller=scroller;scroller.clientHeight=300;
 Object.defineProperty(scroller,'scrollHeight',{get:()=>list.children.reduce((sum,e)=>sum+e.height,0)+44});
 const feed=createTaskFeed({list,scroller,sentinel,document:doc,createdAt:t=>t.createdAt,makeCard:t=>{
  const card=new LayoutElement();card.className=t.status==='downloading'?'working':'history';card.textContent=t.id||t.taskId;return card;
 }});
 feed.update(items);
 const card=id=>list.querySelectorAll('[data-task-id]').find(e=>e.dataset.taskId===id);
 const offset=id=>card(id).getBoundingClientRect().top-scroller.getBoundingClientRect().top;
 const anchor=()=>list.querySelectorAll('[data-task-id]').find(e=>e.getBoundingClientRect().bottom>scroller.getBoundingClientRect().top);
 return {feed,list,scroller,sentinel,card,offset,anchor};
}

test('explicit task reveal waits for visible data and survives late SSE without retaining the old scroll anchor',async()=>{
 let items=Array.from({length:85},(_,i)=>({id:'history-'+i,status:'completed',createdAt:1800000000000-i*1000}));
 const h=revealHarness(items);h.feed.loadMore();h.feed.loadMore();h.scroller.scrollTop=900;h.scroller.events.scroll();
 const oldId=h.anchor().dataset.taskId,oldOffset=h.offset(oldId),oldCard=h.card(oldId);
 assert.equal(h.feed.reveal('submitted'),false,'an API acknowledgement can precede the task snapshot');
 assert.equal(h.scroller.scrollTop,900);assert.equal(h.feed.loadedCount,60);
 h.scroller.hidden=true;h.scroller.scrollTop=0;
 await Promise.resolve().then(()=>{items=[{id:'submitted',status:'queued',createdAt:1800000001000},...items];h.feed.update(items);});
 assert.equal(h.feed.reveal('submitted'),false,'a hidden tab must retain the pending reveal');
 h.scroller.hidden=false;h.feed.resume();assert.equal(h.offset(oldId),oldOffset);
 assert.equal(h.feed.reveal('submitted'),true);assert.equal(h.offset('submitted'),0);assert.equal(h.feed.loadedCount,60);
 assert.equal(h.card(oldId),oldCard,'revealing does not rebuild existing task roots');
 await Promise.resolve().then(()=>{items=[{id:'attention',status:'unknown',createdAt:1800000002000},...items];h.feed.update(items);});
 assert.equal(h.offset('submitted'),0,'late SSE must preserve the new task anchor instead of restoring history');
 h.scroller.hidden=true;h.scroller.scrollTop=0;await Promise.resolve().then(()=>h.feed.update(items));
 h.scroller.hidden=false;h.feed.resume();assert.equal(h.offset('submitted'),0);
 h.scroller.scrollTop=600;h.scroller.events.scroll();const nextId=h.anchor().dataset.taskId,nextOffset=h.offset(nextId);
 await Promise.resolve().then(()=>{items=[{id:'later',status:'queued',createdAt:1800000003000},...items];h.feed.update(items);});
 assert.equal(h.offset(nextId),nextOffset,'later user browsing keeps ordinary SSE anchor behavior');
 assert.ok(h.offset('submitted')<0,'the one-shot reveal does not keep pulling the user back');
});

test('revealing a reused historical task loads through its card without discarding already loaded history',()=>{
 const items=Array.from({length:85},(_,i)=>({id:'history-'+i,status:'completed',createdAt:1800000000000-i*1000}));
 const h=revealHarness(items);h.feed.loadMore();const retained=h.card('history-4');
 assert.equal(h.card('history-70'),undefined);
 assert.equal(h.feed.reveal('history-70'),true);assert.equal(h.feed.loadedCount,80);
 assert.equal(h.offset('history-70'),0);assert.equal(h.card('history-4'),retained);assert.equal(h.sentinel.hidden,false);
 assert.equal(h.feed.reveal('history-0'),true);assert.equal(h.feed.loadedCount,80);assert.equal(h.offset('history-0'),0);
 const scroll=h.scroller.scrollTop;assert.equal(h.feed.reveal('missing'),false);assert.equal(h.scroller.scrollTop,scroll);assert.equal(h.feed.loadedCount,80);
});

test('explicit archived-task reveal expands its group and clamps scrolling so the card remains visible',()=>{
 const items=Array.from({length:44},(_,i)=>({id:'history-'+i,status:'completed',createdAt:1800000000000-i*1000}));
 items.push({taskId:'archived-target',status:'completed',archivedAt:1800000001000,createdAt:1799999000000});
 const h=revealHarness(items);
 assert.equal(h.feed.reveal('archived-target'),true);assert.equal(h.feed.loadedCount,45);
 assert.equal(h.card('archived-target').parent.tag,'details');assert.equal(h.card('archived-target').parent.open,true);
 const bounds=h.scroller.getBoundingClientRect(),rect=h.card('archived-target').getBoundingClientRect();
 assert.ok(rect.top>=bounds.top);assert.ok(rect.bottom<=bounds.bottom-44,'card stays above the bottom fade');
 assert.equal(h.scroller.scrollTop,h.scroller.scrollHeight-h.scroller.clientHeight);
 h.feed.update(items);assert.equal(h.card('archived-target').parent.open,true);
});

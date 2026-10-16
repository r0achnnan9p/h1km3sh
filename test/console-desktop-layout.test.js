import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
class Node {
 children=[];parentNode=null;hidden=false;classes=new Set();
 classList={contains:name=>this.classes.has(name)};
 get firstChild(){return this.children[0]||null;}
 get nextSibling(){const a=this.parentNode?.children||[];return a[a.indexOf(this)+1]||null;}
 append(node){this.insertBefore(node,null);}
 insertBefore(node,next){if(node.parentNode)node.parentNode.children=node.parentNode.children.filter(n=>n!==node);node.parentNode=this;const i=next?this.children.indexOf(next):-1;if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
}
test('同一来源和标记控件在桌面/手机及两种全屏往返，身份和位置不丢失',()=>{
 const side=new Node(),quick=new Node(),marks=new Node(),header=new Node(),timeline=new Node(),after=new Node(),view=new Node();
 header.append(quick);timeline.append(marks);timeline.append(after);
 const window={innerWidth:1440,addEventListener(){}};
 const document={fullscreenElement:null,createElement:()=>new Node(),querySelector:selector=>selector.includes('selection-panel')?side:selector.includes('quick')?quick:marks};
 const c=vm.createContext({window,document,$:()=>view,syncDesktopReplayLayout:null});
 vm.runInContext(source.slice(source.indexOf('function setupDesktopReplayLayout()')),c);
 const slot=side.firstChild;assert.equal(quick.parentNode,slot);assert.equal(marks.parentNode,slot);
 for(const fullscreen of ['native','css']){
  if(fullscreen==='native')document.fullscreenElement=view;else view.classes.add('replay-expanded');
  c.syncDesktopReplayLayout();assert.equal(quick.parentNode,header);assert.equal(marks.parentNode,timeline);assert.equal(marks.nextSibling,after);
  document.fullscreenElement=null;view.classes.clear();c.syncDesktopReplayLayout();assert.equal(marks.parentNode,slot);
 }
 window.innerWidth=390;c.syncDesktopReplayLayout();assert.equal(marks.parentNode,timeline);assert.equal(slot.hidden,true);
 window.innerWidth=1920;c.syncDesktopReplayLayout();assert.equal(slot.children.length,2);assert.equal(side.children.length,1);
});

test('手机矮横屏布局不会覆盖宽度1024以上的桌面网格',()=>{
 const css=fs.readFileSync(new URL('../public/console.css',import.meta.url),'utf8');
 const queries=[...css.matchAll(/@media[^{}]*max-height:\s*540px[^{}]*\{/g)].map(match=>match[0]);
 assert.ok(queries.length>0);
 for(const query of queries)assert.match(query,/max-width:\s*1023px/);
});

test('桌面悬停时间只显示鼠标位置，不改变播放选择，触屏与拖动隐藏',()=>{
 const marker={hidden:true,style:{},dataset:{},firstElementChild:{textContent:''}};
 const state={dragging:false,cursorMs:42};const window={innerWidth:1440};
 const c=vm.createContext({state,window,$:id=>id==='timeline-hover'?marker:{getBoundingClientRect:()=>({left:100,width:400})},wallTime:()=> '2026-10-08 12:34:56',timeAtTimeline:()=>123});
 vm.runInContext(source.slice(source.indexOf('function updateTimelineHover('),source.indexOf("$('timeline').addEventListener('pointerdown'")),c);
 c.updateTimelineHover({pointerType:'mouse',buttons:0,clientX:300});assert.equal(marker.hidden,false);assert.equal(marker.style.left,'50%');assert.equal(marker.firstElementChild.textContent,'12:34:56');assert.equal(state.cursorMs,42);
 c.updateTimelineHover({pointerType:'mouse',buttons:0,clientX:100});assert.equal(marker.dataset.edge,'start');
 c.updateTimelineHover({pointerType:'mouse',buttons:0,clientX:500});assert.equal(marker.dataset.edge,'end');
 c.updateTimelineHover({pointerType:'touch',buttons:0,clientX:300});assert.equal(marker.hidden,true);
 state.dragging=true;c.updateTimelineHover({pointerType:'mouse',buttons:0,clientX:300});assert.equal(marker.hidden,true);
 state.dragging=false;window.innerWidth=390;c.updateTimelineHover({pointerType:'mouse',buttons:0,clientX:300});assert.equal(marker.hidden,true);
});

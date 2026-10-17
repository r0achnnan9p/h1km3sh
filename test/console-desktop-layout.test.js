import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
import { createReplayControls } from '../public/replay-controls.js';
const source=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
// Parse only element ancestry from the server-rendered shell; browser geometry is
// verified separately. This catches duplicated controls and accidental reparenting.
function replayMarkup() {
 const html=statusDashboardPage(), nodes=[], stack=[];
 const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
 for(const match of html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*?)>/gi)){
  const [,closing,tag,attributes]=match;
  if(closing){const index=stack.findLastIndex(node=>node.tag===tag);if(index>=0)stack.length=index;continue;}
  const attrs=Object.fromEntries([...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map(item=>[item[1],item[2]]));
  const node={tag,attrs,parent:stack.at(-1)||null};nodes.push(node);
  if(!voidTags.has(tag)&&!attributes.trimEnd().endsWith('/'))stack.push(node);
 }
 const byId=id=>{const matches=nodes.filter(node=>node.attrs.id===id);assert.equal(matches.length,1,id+' must have one control');return matches[0];};
 const within=(node,ancestor)=>{for(let current=node;current;current=current.parent)if(current===ancestor)return true;return false;};
 const byClass=name=>nodes.find(node=>(node.attrs.class||'').split(/\s+/).includes(name));
 return{byId,byClass,within};
}

test('桌面和手机共用页头来源与选段面板，所有标记和编辑入口保持唯一',()=>{
 const h=replayMarkup(), view=h.byId('view-replay'), topbar=h.byClass('replay-topbar');
 const panel=h.byId('replay-control-panel'), editor=h.byClass('replay-editor'), selection=h.byId('replay-selection-editor');
 assert.equal(view.attrs['data-replay-mode'],'select');
 assert.ok(h.within(topbar,view));assert.ok(h.within(panel,editor));assert.ok(h.within(selection,panel));
 for(const id of ['quick-source-select','quick-camera-select','previous-day','playback-context','next-day']){
  assert.ok(h.within(h.byId(id),topbar),id+' stays in the header');
  assert.equal(h.within(h.byId(id),selection),false);
 }
 for(const id of ['mark-in','mark-out','edit-in','edit-out','clear-marks','export-range']){
  const control=h.byId(id);assert.equal(control.tag,'button');assert.ok(h.within(control,selection),id+' stays with the selected range');
 }
 for(const id of ['timeline-overview','transport-toggle','skip-back','skip-forward','replay-mode-watch','replay-mode-select'])assert.ok(h.within(h.byId(id),panel));
});

class Target {
 listeners=new Map();
 addEventListener(type,listener,options){const entries=this.listeners.get(type)||[];entries.push({listener,capture:options===true||options?.capture===true});this.listeners.set(type,entries);}
 emit(type,properties={}){
  const event={type,target:this,button:0,isPrimary:true,pointerId:1,detail:1,defaultPrevented:false,stopped:false,
   preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...properties};
  const entries=[...(this.listeners.get(type)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture));
  for(const {listener} of entries){listener(event);if(event.stopped)break;}
  return event;
 }
}
class Element extends Target {
 constructor(tag='div'){super();this.tagName=tag;this.dataset={};this.attrs=new Map();this.classes=new Set();this.hidden=false;this.inert=false;this.parentNode=null;}
 classList={contains:name=>this.classes.has(name),add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};
 setAttribute(name,value){this.attrs.set(name,value);}
 getAttribute(name){return this.attrs.get(name)??null;}
 removeAttribute(name){this.attrs.delete(name);}
 contains(node){for(let current=node;current;current=current.parentNode)if(current===this)return true;return false;}
 matches(selector){return selector===':focus-visible'?Boolean(this.focusVisible):selector.split(',').map(value=>value.trim()).includes(this.tagName);}
}
function replayPresentation({width=932,height=430}={}){
 const ids=['view-replay','replay-control-panel','replay-selection-editor','replay-mode-watch','replay-mode-select',
  'date-select','playback-source','camera-select','dvr-select','dvr-channel','mark-in','mark-out','export-range','replay-player'];
 const nodes=new Map(ids.map(id=>[id,new Element(id.startsWith('replay-mode-')||['mark-in','mark-out','export-range'].includes(id)?'button':'div')]));
 const get=id=>{assert.ok(nodes.has(id),id);return nodes.get(id);};
 const view=get('view-replay'),panel=get('replay-control-panel'),editor=get('replay-selection-editor'),topbar=new Element();
 topbar.parentNode=view;panel.parentNode=view;editor.parentNode=panel;
 for(const id of ['replay-mode-watch','replay-mode-select'])get(id).parentNode=panel;
 for(const id of ['mark-in','mark-out','export-range'])get(id).parentNode=editor;
 view.querySelector=selector=>{assert.equal(selector,'.replay-topbar');return topbar;};
 const window=Object.assign(new Target(),{innerWidth:width,innerHeight:height});
 window.matchMedia=query=>({matches:[['max-width',window.innerWidth,(a,b)=>a<=b],['min-width',window.innerWidth,(a,b)=>a>=b],['max-height',window.innerHeight,(a,b)=>a<=b]]
  .every(([name,value,compare])=>{const bound=query.match(new RegExp(name+':\\s*(\\d+)px'));return !bound||compare(value,Number(bound[1]));})
  &&(!query.includes('orientation: landscape')||window.innerWidth>window.innerHeight)});
 const document=Object.assign(new Target(),{body:{dataset:{view:'replay'}},hidden:false,fullscreenElement:null,activeElement:null});
 const state={inMs:60000,outMs:180000,cursorMs:90000,dragging:false,holdSeek:null,busy:false};
 const video=get('replay-player');video.currentTime=90;video.paused=true;
 video.play=video.pause=()=>assert.fail('presentation changes must not control playback');
 let now=0,next=0;const timers=new Map();
 const setTimer=(callback,delay)=>{const id=++next;timers.set(id,{callback,at:now+delay});return id;};
 const advance=milliseconds=>{const end=now+milliseconds;for(;;){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].callback();}now=end;};
 const context=vm.createContext({window,document,state,$:get,activeDialog:null,HTMLElement:Element,
  createReplayControls:options=>createReplayControls({...options,setTimer,clearTimer:id=>timers.delete(id)})});
 const begin=source.indexOf('function setupReplayControls()'),end=source.indexOf("document.querySelector('.skip-link')",begin);
 assert.ok(begin>=0&&end>begin,'replay presentation wiring is available');
 vm.runInContext(source.slice(begin,end)+'\nglobalThis.controls = replayControls;',context);
 context.syncReplayControls();
 const snapshot=()=>JSON.stringify({inMs:state.inMs,outMs:state.outMs,cursorMs:state.cursorMs,position:video.currentTime,paused:video.paused});
 const click=id=>{const target=get(id),event=view.emit('click',{target});if(!event.stopped)target.emit('click');return event;};
 const tap=id=>{const target=get(id),down=view.emit('pointerdown',{target}),up=window.emit('pointerup',{target}),event=click(id);return{down,up,event};};
 return{get,view,panel,editor,topbar,window,document,state,context,timers,advance,snapshot,click,tap};
}

test('实际观看/选段按钮只改变面板和无障碍状态，保留播放位置与入出点',()=>{
 const h=replayPresentation(),before=h.snapshot();
 h.click('replay-mode-watch');
 assert.equal(h.view.dataset.replayMode,'watch');assert.equal(h.editor.hidden,true);
 assert.equal(h.get('replay-mode-watch').getAttribute('aria-pressed'),'true');
 assert.equal(h.get('replay-mode-select').getAttribute('aria-pressed'),'false');
 h.click('replay-mode-select');
 assert.equal(h.view.dataset.replayMode,'select');assert.equal(h.editor.hidden,false);
 assert.equal(h.get('replay-mode-select').getAttribute('aria-pressed'),'true');
 assert.equal(h.snapshot(),before);
});

test('iPhone14PM横屏和两种全屏自动隐藏整个操作面，竖屏与常规桌面保留可见控件',()=>{
 for(const [width,height,idle] of [[430,932,false],[932,430,true],[1440,430,false],[1440,900,false],[960,700,false]]){
  const h=replayPresentation({width,height}),before=h.snapshot();h.advance(2500);
  assert.equal(h.view.dataset.chromeIdle,String(idle),`${width}x${height}`);
  assert.equal(h.panel.inert,idle);assert.equal(h.topbar.inert,idle);
  assert.equal(h.editor.hidden,false,'select mode still contains mark buttons while its parent hides');
  assert.equal(h.snapshot(),before);
 }
 for(const fullscreen of ['native','css']){
  const h=replayPresentation({width:1440,height:900}),before=h.snapshot();
  const parents=[h.editor.parentNode,h.panel.parentNode,h.topbar.parentNode];
  if(fullscreen==='native')h.document.fullscreenElement=h.view;else h.view.classList.add('replay-expanded');
  h.context.syncReplayControls();h.advance(2500);assert.equal(h.panel.inert,true);
  h.document.fullscreenElement=null;h.view.classList.remove('replay-expanded');h.context.syncReplayControls();
  assert.equal(h.panel.inert,false);assert.equal(h.topbar.inert,false);assert.equal(h.timers.size,0);
  assert.deepEqual([h.editor.parentNode,h.panel.parentNode,h.topbar.parentNode],parents);
  assert.equal(h.snapshot(),before);
 }
});

test('真实捕获路由阻止唤醒触摸误导出，键盘可解除inert并保护当前输入',()=>{
 const h=replayPresentation();let exports=0;h.get('export-range').addEventListener('click',()=>exports++);
 h.advance(2500);const first=h.tap('export-range');
 assert.ok(first.down.defaultPrevented&&first.up.defaultPrevented&&first.event.defaultPrevented);assert.equal(exports,0);
 h.tap('export-range');assert.equal(exports,1);
 h.advance(2500);assert.equal(h.panel.inert,true);
 h.document.emit('keydown',{key:'Tab',detail:0});assert.equal(h.panel.inert,false);assert.equal(h.topbar.inert,false);
 const input=new Element('input');h.document.activeElement=input;
 h.advance(5000);assert.equal(h.panel.inert,false,'editable focus protects the panel');
 h.document.activeElement=h.get('replay-mode-select');h.document.activeElement.focusVisible=true;
 h.advance(5000);assert.equal(h.panel.inert,false,'keyboard focus protects its target');
 h.document.activeElement=null;h.context.activeDialog={open:true};
 h.advance(5000);assert.equal(h.panel.inert,false,'an open modal protects the panel');
 h.context.activeDialog=null;h.advance(2500);assert.equal(h.panel.inert,true);
});

test('离页和后台事件清理隐藏计时，恢复页面后重新计时且不改变选段',()=>{
 const h=replayPresentation(),before=h.snapshot();h.advance(2000);
 h.window.emit('pagehide');assert.equal(h.timers.size,0);assert.equal(h.panel.inert,false);
 h.advance(5000);h.window.emit('pageshow');h.advance(2499);assert.equal(h.panel.inert,false);
 h.advance(1);assert.equal(h.panel.inert,true);
 h.document.hidden=true;h.document.emit('visibilitychange');assert.equal(h.timers.size,0);assert.equal(h.panel.inert,false);
 h.document.body.dataset.view='tasks';h.document.hidden=false;h.document.emit('visibilitychange');
 h.advance(5000);assert.equal(h.timers.size,0);assert.equal(h.panel.inert,false);assert.equal(h.snapshot(),before);
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

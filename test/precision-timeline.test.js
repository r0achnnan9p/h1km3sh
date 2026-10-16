import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrecisionTimeline} from '../public/precision-timeline.js';
function fixture(){
 const listeners={};let context='D2/day1',time=43200000;const events=[],commits=[];
 const element={clientWidth:360,addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){},getBoundingClientRect:()=>({left:10,width:360}),setPointerCapture(){},hasPointerCapture:()=>false};
 const api=createPrecisionTimeline({element,getTime:()=>time,getBounds:()=>({start:0,end:86399000}),getContext:()=>context,onStart:()=>events.push('start'),onMove:data=>{time=data.time;events.push(data);},onCommit:value=>commits.push(value),onCancel:data=>events.push(data)});
 const emit=(name,data={})=>listeners[name]({pointerId:1,button:0,isPrimary:true,clientX:190,clientY:400,preventDefault(){},...data});
 return {api,emit,events,commits,setContext:value=>context=value};
}
test('拉远后移动12px精调1秒，释放位置不覆盖最后预览且只提交一次',async()=>{
 const h=fixture();h.emit('pointerdown');h.emit('pointermove',{clientY:100});h.emit('pointermove',{clientX:202,clientY:100});h.emit('pointerup',{clientX:350,clientY:400});await Promise.resolve();assert.deepEqual(h.commits,[43201000]);h.emit('lostpointercapture');assert.equal(h.commits.length,1);
});
test('换通道取消且不把旧位置恢复到新通道',async()=>{const h=fixture();h.emit('pointerdown');h.setContext('D1/day1');h.emit('pointermove');await Promise.resolve();assert.equal(h.events.at(-1).restore,false);assert.equal(h.commits.length,0);});
test('取消手势恢复原位置，不发播放提交',()=>{const h=fixture();h.emit('pointerdown');h.emit('pointermove',{clientX:200});h.emit('pointercancel');assert.equal(h.events.at(-1).time,43200000);assert.equal(h.events.at(-1).restore,true);assert.equal(h.commits.length,0);});
test('点按用按下位置，忽略多指',async()=>{const h=fixture();h.emit('pointerdown',{clientX:100});h.emit('pointerdown',{pointerId:2,clientX:350});h.emit('pointerup',{clientX:300});await Promise.resolve();assert.deepEqual(h.commits,[21600000]);});

test('释放到提交微任务之间上下文改变仍不得播放旧时间',async()=>{const h=fixture();h.emit('pointerdown');h.emit('pointerup');h.setContext('D1/day2');await Promise.resolve();assert.equal(h.commits.length,0);assert.equal(h.events.at(-1).restore,false);});

test('1px抖动不改变当前时间，点按松手预览并提交按下位置',async()=>{const h=fixture();h.emit('pointerdown',{clientX:100});const preview=h.events.at(-1).time;h.emit('pointermove',{clientX:101});assert.equal(h.events.at(-1).time,preview);h.emit('pointerup',{clientX:300});await Promise.resolve();assert.equal(h.events.at(-1).time,21600000);assert.deepEqual(h.commits,[21600000]);});

test('从其他时间位置按下后仅纵向拉远，整个手势保留原时间',async()=>{
 const h=fixture();h.emit('pointerdown',{clientX:100});assert.equal(h.events.at(-1).time,43200000);
 h.emit('pointermove',{clientX:100,clientY:100});assert.equal(h.events.at(-1).time,43200000);
 h.emit('pointerup',{clientX:350,clientY:400});await Promise.resolve();assert.deepEqual(h.commits,[43200000]);
});

test('从其他时间位置先拉远再横移，以原时间精调而非跳到按下位置',async()=>{
 const h=fixture();h.emit('pointerdown',{clientX:100});h.emit('pointermove',{clientX:100,clientY:100});
 h.emit('pointermove',{clientX:112,clientY:100});h.emit('pointerup');await Promise.resolve();assert.deepEqual(h.commits,[43201000]);
});
test('释放后提交前cancel或destroy必须阻止旧提交',async()=>{for(const method of ['cancel','destroy']){const h=fixture();h.emit('pointerdown');h.emit('pointerup');h.api[method]();await Promise.resolve();assert.equal(h.commits.length,0);assert.equal(h.events.at(-1).restore,true);}});

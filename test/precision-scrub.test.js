import test from 'node:test';
import assert from 'node:assert/strict';
import {precisionGain, precisionSpan, precisionDelta} from '../public/precision-scrub.js';
test('全天粗拖到30秒精调，增益单调且有界',()=>{
 assert.equal(precisionSpan(0),86400000);assert.equal(precisionSpan(300),30000);
 let last=1;for(let y=0;y<=300;y++){const gain=precisionGain(y);assert.ok(gain<=last&&gain>=1/2880);last=gain;}
});
test('只拉远不改变时间，左右等量运动可逆',()=>{
 for(const distance of [0,24,50,100,150,240]){assert.equal(precisionDelta(0,398,distance),0);assert.equal(precisionDelta(12,398,distance)+precisionDelta(-12,398,distance),0);}
 assert.equal(precisionDelta(12,360,300),1000);
});

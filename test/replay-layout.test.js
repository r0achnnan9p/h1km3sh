import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const css=fs.readFileSync(new URL('../public/console.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
// Static cascade checks for the concrete landscape selectors; this does not simulate a browser.
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match,index)=>match[1].split(',').map(selector=>({selector:selector.trim(),index,style:Object.fromEntries(match[2].split(';').filter(item=>item.includes(':')).map(item=>{const split=item.indexOf(':');return[item.slice(0,split).trim(),item.slice(split+1).trim()];}))})));
const specificity=selector=>(selector.match(/#[\w-]+/g)||[]).length*100+(selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)||[]).length*10;
function computed(selectors){return Object.assign({},...rules.filter(rule=>selectors.includes(rule.selector)).sort((a,b)=>specificity(a.selector)-specificity(b.selector)||a.index-b.index).map(rule=>rule.style));}
test('landscape idle and trimming rods share the exact endpoint centre for both 44px handles',()=>{
  for(const boundary of ['in','out']) {
    const selectors=['.boundary-handle::before','#view-replay .boundary-handle::before'];
    if(boundary==='out')selectors.push('.boundary-handle.end::before','#view-replay .boundary-handle.end::before');
    const idle=computed(selectors),active=computed([...selectors,`body.trimming[data-trim-boundary="${boundary}"] #boundary-${boundary}::before`,`body.trimming[data-trim-boundary="${boundary}"] #view-replay #boundary-${boundary}::before`]);
    const origin=boundary==='in'?-44:0;
    assert.equal(origin+parseFloat(idle.left)+parseFloat(idle.width)/2,0);
    assert.equal(origin+parseFloat(active.left)+parseFloat(active.width)/2,0);
    assert.equal(parseFloat(idle.width),10);assert.equal(parseFloat(active.width),16);
  }
});
test('landscape edge hit boxes stay inside both 44px safe areas and the 140px panel content height',()=>{
  const scroll=computed(['.timeline-scroll','#view-replay .timeline-scroll']);
  const panel=computed(['.timeline-section','#view-replay .timeline-section']);
  assert.equal(scroll['margin-top'],'0');assert.equal(scroll['padding-inline'],'44px');
  assert.equal(panel.height,'140px');assert.equal(panel.padding,'8px 12px');assert.equal(panel['grid-template-rows'],'56px 66px');
  const viewportWidth=760,safe=44,border=1,paddingX=12,paddingY=8,handleWidth=44,handleHeight=64;
  const firstBoundary=safe+border+paddingX+parseFloat(scroll['padding-inline']);
  const lastBoundary=viewportWidth-safe-border-paddingX-parseFloat(scroll['padding-inline']);
  assert.ok(firstBoundary-handleWidth>=safe);assert.ok(lastBoundary+handleWidth<=viewportWidth-safe);
  const rowStart=border+paddingY+56+parseFloat(scroll['margin-top']);
  assert.ok(rowStart+66<=140-border-paddingY);assert.ok(rowStart+handleHeight<=140-border-paddingY);
  const nearStart=firstBoundary,nearEnd=firstBoundary+.8;
  assert.ok(nearStart<=nearEnd);assert.ok(nearStart-handleWidth<nearStart&&nearEnd<nearEnd+handleWidth);
});
test('landscape flex transport ordering is back ten, play, forward ten',()=>{
  assert.equal(computed(['#skip-back','#view-replay #skip-back']).order,'0');
  assert.equal(computed(['#playback-toggle','#view-replay #playback-toggle']).order,'1');
  assert.equal(computed(['#skip-forward','#view-replay #skip-forward']).order,'2');
});

test('landscape gap count has its own bounded grid slot, separate from mark-out and the export button',()=>{
  const panelRules=rules.filter(r=>r.selector==='#view-replay .timeline-section');
  const rangeRules=rules.filter(r=>r.selector==='#view-replay .range-controls');
  assert.equal(computed(['.clip-gap','#view-replay .clip-gap']).position,'static');
  assert.equal(computed(['.clip-gap','#view-replay .clip-gap'])['grid-column'],'1');
  assert.equal(computed(['#view-replay #export-range'])['grid-column'],'2');
  assert.equal(computed(['#view-replay .mark-controls'])['grid-column'],'1');
  assert.equal(computed(['#view-replay #selection-gap-count']).overflow,'hidden');
  // Narrow windows now use the normal scrolling layout; immersive mode starts at 568px.
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 540px\) and \(min-width: 568px\)/);
  assert.match(css, /@media \(orientation: portrait\), \(min-height: 541px\), \(max-width: 567px\)/);
  for(const width of [568,667,760]) {
    const gapSlot=64,exportSlot=56,columnGap=8,rangeWidth=gapSlot+columnGap+exportSlot,sideLane=44+48+8;
    assert.ok(panelRules.some(r=>r.style['grid-template-columns']==='minmax(0,1fr) '+rangeWidth+'px'));
    assert.ok(rangeRules.some(r=>r.style['grid-template-columns']===gapSlot+'px 56px'&&r.style.width===rangeWidth+'px'));
    const panelContent=width-2*sideLane-2*1-2*12,markWidth=panelContent-columnGap-rangeWidth,buttonWidth=(markWidth-6)/2;
    // Explicit upper bounds for an eight-character time and four-digit count, using a conservative 0.65em monospace budget per glyph.
    const markTimeWidth=8*12*.65,iconWidth=16,markGap=3;
    assert.ok(buttonWidth>=44,'mark hit target fits at '+width);
    assert.ok(buttonWidth>=markTimeWidth+iconWidth+markGap+8,'mark time fits at '+width);
    for(const digits of [1,4])assert.ok(gapSlot>=18+4+digits*12*.65);
    const rangeStart=sideLane+1+12+markWidth+columnGap;
    assert.ok(rangeStart>=sideLane+1+12+markWidth+8);assert.ok(rangeStart+rangeWidth<=width-sideLane-1-12);
  }
});

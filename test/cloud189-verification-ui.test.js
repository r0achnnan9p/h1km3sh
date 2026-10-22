import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/console.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function makeTaskCard('),source.indexOf('\nasync function refreshState()',source.indexOf('function makeTaskCard(')));
function element(tag) {return {tag,children:[],events:{},append(...nodes){this.children.push(...nodes);},addEventListener(name,callback){this.events[name]=callback;},setAttribute(){},style:{}};}
const buttons=card=>card.children.flatMap(node=>node.children||[]).filter(node=>node.tag==='button');
test('verify button is cloud unknown-only, blocks repeated clicks and re-enables after network failure',async()=>{
  let requests=0,renders=0,release;
  const pending=new Set(),messages=[];
  const sandbox={document:{createElement:element},cloudVerificationPending:pending,taskStageLabel:()=>'',statusText:s=>s,taskProgressPresentation:()=>({show:false}),uploadProgressCaption:()=>'',renderTasks:()=>renders++,loadSettings:async()=>{},settingsCsrfToken:'fixture-csrf',body:JSON.stringify,
    api:async(url,options)=>{requests++;assert.match(url,/\/uploads\/cloud189\/uuid\/verify$/);assert.equal(options.headers['X-CSRF-Token'],'fixture-csrf');await new Promise(r=>release=r);throw new Error('network');},notify:(...args)=>messages.push(args),refreshState:async()=>{throw new Error('offline');}};
  vm.createContext(sandbox);vm.runInContext(fn+'\nthis.makeTaskCard=makeTaskCard;',sandbox);
  for (const task of [{provider:'bilibili',status:'unknown'},{provider:'cloud189',status:'completed'},{provider:'cloud189',status:'uploading'}]) assert.equal(buttons(sandbox.makeTaskCard(task,true)).length,0);
  const task={id:'uuid',provider:'cloud189',status:'unknown'};
  const button=buttons(sandbox.makeTaskCard(task,true))[0];assert.equal(button.textContent,'核实结果');
  const click=button.events.click();await Promise.resolve();await Promise.resolve();
  assert.equal(buttons(sandbox.makeTaskCard(task,true))[0].disabled,true);
  await button.events.click();assert.equal(requests,1);release();await click;
  assert.equal(pending.size,0);assert.equal(buttons(sandbox.makeTaskCard(task,true))[0].disabled,false);assert.equal(messages[0][0],'network');assert.ok(renders>=2);
});

test('retry/archive require explicit confirmation and archived cards offer restore only', async () => {
  let confirmation, calls = 0;
  const sandbox = { document: { createElement: element }, cloudVerificationPending: new Set(), taskStageLabel: () => '', statusText: s => s,
    taskProgressPresentation: () => ({ show: false }), uploadProgressCaption: () => '', renderTasks: () => {}, loadSettings: async () => {}, settingsCsrfToken: 'csrf', body: JSON.stringify,
    confirmAction: (...args) => confirmation = args, notify: () => {}, refreshState: async () => {}, refreshOutputs: async () => {},
    api: async (url, options) => { calls++; assert.match(url, /\/retry$/); assert.deepEqual(JSON.parse(options.body), { confirmRetry: true }); return { applied: true, message: 'queued' }; } };
  vm.createContext(sandbox); vm.runInContext(fn + '\nthis.makeTaskCard=makeTaskCard;', sandbox);
  const task = { id: 'uuid', provider: 'cloud189', status: 'unknown', recoveryAvailable: true, targetPath: '/football', filename: 'fixture.mp4' };
  const card = sandbox.makeTaskCard(task, true);
  assert.deepEqual(buttons(card).map(button => button.textContent), ['核实结果', '重试上传', '移除记录']);
  buttons(card)[1].events.click(); assert.equal(calls, 0); assert.match(confirmation[1], /确认目标目前无文件/);
  await confirmation[3](); assert.equal(calls, 1);
  assert.deepEqual(buttons(sandbox.makeTaskCard({ ...task, archivedAt: '2026-10-01' }, true)).map(button => button.textContent), ['恢复记录']);
  assert.deepEqual(buttons(sandbox.makeTaskCard({ ...task, recoveryAvailable: false }, true)).map(button => button.textContent), ['核实结果']);
});

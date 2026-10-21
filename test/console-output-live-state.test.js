import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness() {
  const callbacks = new Map(), accepted = []; let refreshes = 0;
  const context = vm.createContext({
    state: { tasks: [], uploads: [], lastTasks: '' }, outputRequest: 0, stateRequest: 0, consoleSession: 0,
    api: async () => ({ generatedAt: new Date(Date.now() - 3_600_000).toISOString(), tasks: [], uploads: [{ id: 'u', status: 'queued' }], outputs: [{ id: 'f', uploads: { bilibili: { status: 'queued' } } }] }),
    acceptOutputs: data => accepted.push(data), refreshOutputs: async () => { refreshes++; },
    reconcileDvrHttpSamplePending() {}, renderTasks() {}, renderSettings() {}, setConnection() {}, loggedOut() {}, appPath: value => value,
    EventSource: class { addEventListener(name, fn) { callbacks.set(name, fn); } close() {} },
  });
  vm.runInContext(code.slice(code.indexOf('async function refreshState()'), code.indexOf('// Configuration is fetched separately')),context);
  return { context, accepted, count: () => refreshes, update: (uploads, generatedAt) => callbacks.get('update')({ data: JSON.stringify({ generatedAt, tasks: [], uploads }) }) };
}
test('bootstrap直接接收成片事实，首次上传无需历史 completed 才同步',async()=>{
 const h=harness();await h.context.refreshState();assert.equal(h.accepted[0][0].uploads.bilibili.status,'queued');
 assert.ok(h.context.state.serverClockOffset < -3_500_000 && h.context.state.serverClockOffset > -3_700_000,'bootstrap aligns the browser clock to the server snapshot');
 h.context.connectEvents();
 for(const status of ['queued','uploading','failed','unknown']) h.update([{id:'u',status}]);
 assert.equal(h.count(),3,'queued与bootstrap相同，其余三个状态都会刷新');
});
test('同一上传状态的真实进度变化刷新，重复SSE不重复刷新',()=>{
 const h=harness();h.context.connectEvents();
 h.update([{id:'u',status:'uploading',progress:1}]); h.update([{id:'u',status:'uploading',progress:2}]); h.update([{id:'u',status:'uploading',progress:2}]);
 assert.equal(h.count(),2);
});
test('SSE snapshot aligns the browser clock without touching task data',()=>{
 const h=harness();h.context.connectEvents();
 h.update([{id:'u',status:'uploading'}], new Date(Date.now() - 7_200_000).toISOString());
 assert.ok(h.context.state.serverClockOffset < -7_100_000 && h.context.state.serverClockOffset > -7_300_000,'SSE aligns the browser clock to its snapshot time');
 assert.equal(h.context.state.uploads[0].id,'u');
});


test('迟到的bootstrap不覆盖新outputs，也不能在退出后回填',async()=>{
 const h=harness();let resolve;
 h.context.api=()=>new Promise(ok=>{resolve=ok;});
 const old=h.context.refreshState();h.context.outputRequest++;
 resolve({outputs:[{id:'old'}]});await old;assert.equal(h.accepted.length,0);
 const after=h.context.refreshState();h.context.consoleSession++;h.context.outputRequest++;h.context.stateRequest++;
 resolve({outputs:[{id:'private'}]});await after;assert.equal(h.accepted.length,0);
});


test('重复SSE淘汰旧任务快照时仍接收独立成片响应',async()=>{
 const h=harness();h.context.connectEvents();
 h.update([{id:'u',status:'queued'}]);
 let resolve;h.context.api=()=>new Promise(ok=>{resolve=ok;});
 const pending=h.context.refreshState();h.update([{id:'u',status:'queued'}]);
 resolve({outputs:[{id:'fresh'}],tasks:[],uploads:[]});await pending;
 assert.equal(h.accepted.length,1);assert.equal(h.accepted[0][0].id,'fresh');
});

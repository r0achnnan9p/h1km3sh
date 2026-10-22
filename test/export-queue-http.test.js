/** Real HTTP server + test-only ESM pipeline substitute. No recorder or upload access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('HTTP export FIFO shares legacy and console DVR admission, deduplication and cancellation', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-http-'));
  let child;
  try {
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    const id = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(data, 'devices.json'), JSON.stringify({ activeDeviceId: id, devices: [
      { id, name: 'fixture', ip: '192.0.2.20', username: 'fixture', password: 'fixture-secret' },
    ] }));
    const real = pathToFileURL(path.join(root, 'lib/rtsp-clip-export.js')).href;
    const mock = path.join(dir, 'mock.mjs');
    fs.writeFileSync(mock, `export { compactToMs, msToCompact } from ${JSON.stringify(real + '?actual')};
      import fs from 'node:fs'; import path from 'node:path';
      import { ProgressReporter } from ${JSON.stringify(pathToFileURL(path.join(root, 'lib/progress-reporter.js')).href)};
      const root = ${JSON.stringify(dir)};
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      let active = false;
      export async function runRtspClipExport(options) {
        const { taskId, channel, signal, outputDir } = options;
        if (active) throw new Error('overlapping pipelines'); active = true;
        const log = value => fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(value)+'\\n');
        log({ event:'start', taskId, channel });
        if (channel === '401') new ProgressReporter(taskId, options.sseClients).reportProgress({ phase:'concatenating', stage:'concatenating', stagePercent:null, processedSeconds:42, message:'拼接测试片段' });
        try {
          while (!signal.aborted && !fs.existsSync(path.join(root, taskId))) await delay(10);
          if (signal.aborted) {
            // The first cancellation is held until the test has observed the
            // queue. Fixed sleeps race slow HTTP under the full parallel suite.
            if (String(channel) === '101') while (!fs.existsSync(path.join(root, taskId + '.cancel-release'))) await delay(10);
            throw new Error('cancelled');
          }
          if (fs.readFileSync(path.join(root, taskId), 'utf8') === 'fail') throw new Error('fixture failure');
          fs.mkdirSync(outputDir, {recursive:true});
          const file=path.join(outputDir, taskId+'.mp4'); fs.writeFileSync(file, 'fixture'); return file;
        } finally { log({event:'close', taskId}); active=false; }
      }`);
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(loader, `export async function resolve(specifier, context, next) {
      const resolved = await next(specifier, context);
      return resolved.url === ${JSON.stringify(real)} ? { url:${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit:true } : resolved;
    }`);
    const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const launch = (extraEnv = {}) => spawn(process.execPath, ['--loader', loader, 'server.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0',
      HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_DATA_DIR: data,
      HIKVISION_DOWNLOADS_DIR: path.join(dir, 'downloads'), HIKVISION_ARTIFACT_DIR: path.join(dir, 'artifacts'),
      HIKVISION_ARCHIVE_DIR: path.join(dir, 'archive'), HIKVISION_MEDIAMTX_API_URL: '', HIKVISION_MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:0',
      HIKVISION_RUNTIME_FILE: path.join(dir, 'runtime.json'), HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '',
      HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKCLIP_BASE_URL: '', HIKCLIP_PUBLIC_BIND: '127.0.0.1',
      HIKVISION_BILIUP_ENABLED: '0',
      HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '', ...extraEnv,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child = launch();
    let logs=''; child.stdout.on('data', x => { logs+=x; }); child.stderr.on('data', x => { logs+=x; });
    const base = `http://127.0.0.1:${port}`;
    const request = async (url, body) => {
      const r=await fetch(base+url, body ? {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
      return {status:r.status, ...(await r.json())};
    };
    async function until(check) { for(let i=0;i<500;i++){const result=await check(); if(result)return result; if(child.exitCode!==null)throw new Error(logs);await delay(10);}throw new Error('condition timeout: '+logs); }
    await until(async () => { try {return (await request('/api/runtime-health')).recoveryReady === true;}catch{return false;} });
    const args={ip:'192.0.2.20',user:'fixture',pass:'fixture-secret',channel:'101',startTime:'20260101T100000Z',endTime:'20260101T100100Z'};
    const a=await request('/api/export', args);
    const b=await request('/api/export', {...args,channel:'201'});
    const c=await request('/console/api/export', {source:'hikvision',deviceId:id,channel:'301',start:'2026-01-01 10:00',end:'2026-01-01 10:01'});
    assert.equal(b.status, 'queued'); assert.equal(c.status, 'queued'); assert.equal(c.queuePosition,2);
    assert.equal((await request('/api/export',{...args,channel:'201'})).taskId,b.taskId);
    const task = async id => (await request('/api/status')).activeTasks.find(t=>t.taskId===id);
    assert.equal((await task(b.taskId)).progress,null);
    await request('/console/api/export/stop',{taskId:b.taskId});
    assert.equal((await task(c.taskId)).queuePosition,1);
    await request('/api/export/stop',{taskId:a.taskId});
    assert.equal((await task(c.taskId)).status,'queued');
    fs.writeFileSync(path.join(dir, a.taskId + '.cancel-release'), 'release');
    await until(async()=> (await task(c.taskId)).status==='downloading');
    fs.writeFileSync(path.join(dir,c.taskId),'fail');
    await until(async()=> (await task(c.taskId)).status==='error');
    const d=await request('/console/api/export',{source:'hikvision',deviceId:id,channel:'401',start:'2026-01-01 10:00',end:'2026-01-01 10:01'});
    await until(()=>fs.readFileSync(path.join(dir,'calls'),'utf8').includes(d.taskId));
    const stageTask = await task(d.taskId);
    assert.equal(stageTask.stage, 'concatenating');
    assert.equal(stageTask.status, 'converting');
    assert.equal(stageTask.progress, null);
    assert.equal(stageTask.stagePercent, null);
    assert.match(stageTask.message, /拼接测试片段/);
    const stageDashboard = (await request('/console/api/tasks')).tasks.find(t => t.taskId === d.taskId);
    assert.equal(stageDashboard.processedSeconds, 42);
    assert.equal(stageDashboard.stage, 'concatenating');
    assert.ok(stageDashboard.progressUpdatedAt > 0);
    fs.writeFileSync(path.join(dir,d.taskId),'ok');
    await until(async()=> (await task(d.taskId)).status==='completed');
    assert.equal((await task(d.taskId)).stage, null);
    assert.equal((await task(d.taskId)).progress, 100);
    const calls=fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(c=>[c.event,c.taskId]),[['start',a.taskId],['close',a.taskId],['start',c.taskId],['close',c.taskId],['start',d.taskId],['close',d.taskId]]);
    assert.deepEqual(calls.filter(c=>c.event==='start').map(c=>c.channel),['101','301','401']);
    // A second HTTP instance cannot mutate files while the first holds the queue lease.
    const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
    const secondaryPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const secondary = launch({ PORT: String(secondaryPort), HIKVISION_RUNTIME_FILE: path.join(dir, 'secondary-runtime.json') });
    secondary.stdout.resume(); secondary.stderr.resume();
    try {
      const secondaryBase = `http://127.0.0.1:${secondaryPort}`;
      await until(async () => { try { return (await (await fetch(secondaryBase + '/api/status')).json()).activeTasks.some(task => /仍持有/.test(task.message)); } catch { return false; } });
      assert.equal((await (await fetch(secondaryBase + '/api/runtime-health')).json()).recoveryReady, false);
      const filename = (await task(d.taskId)).filename, outputId = Buffer.from(filename).toString('base64url');
      for (const [url, method, payload] of [
        [`/console/api/outputs/${outputId}`, 'PUT', { newName: 'must-not-rename.mp4' }],
        [`/console/api/outputs/${outputId}`, 'DELETE'],
        [`/console/api/outputs/${outputId}/upload/bilibili`, 'POST', {}],
        [`/api/outputs/${encodeURIComponent(filename)}`, 'DELETE'],
      ]) {
        const response = await fetch(secondaryBase + url, { method, headers: { 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
        assert.equal(response.status, 503);
      }
      assert.equal(fs.existsSync(path.join(dir, 'downloads', filename)), true);
    } finally { const stopped = once(secondary, 'exit'); secondary.kill('SIGTERM'); await stopped; }
    const many=[];
    for(let i=0;i<32;i++) many.push(await request('/api/export',{...args,channel:String(501+i)}));
    const dashboard=await request('/console/api/tasks');
    for(const item of many) assert.ok(dashboard.tasks.some(t=>t.taskId===item.taskId), 'all queued/running jobs stay visible beyond history limit');
    for(const item of many) await request('/api/export/stop',{taskId:item.taskId});
    await until(async () => (await task(many[0].taskId)).status === 'cancelled');
    const running = await request('/api/export', { ...args, channel: '901' });
    const queued = await request('/console/api/export', { source: 'hikvision', deviceId: id, channel: '902', start: '2026-01-01 10:00', end: '2026-01-01 10:01' });
    await until(() => fs.readFileSync(path.join(dir, 'calls'), 'utf8').includes(running.taskId));
    const settings = JSON.parse(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'));
    settings.activeDeviceId = null; fs.writeFileSync(path.join(data, 'devices.json'), JSON.stringify(settings));
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    child = launch(); child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
    await until(async () => { try { return (await request('/api/runtime-health')).recoveryReady === true; } catch { return false; } });
    await until(async () => { try { return (await task(running.taskId))?.recovered; } catch { return false; } });
    assert.equal((await task(queued.taskId)).status, 'queued');
    assert.equal((await task(a.taskId)).status, 'cancelled');
    assert.equal((await task(d.taskId)).status, 'completed');
    fs.writeFileSync(path.join(dir, running.taskId), 'ok');
    await until(async () => (await task(running.taskId)).status === 'completed');
    await until(() => fs.readFileSync(path.join(dir, 'calls'), 'utf8').includes(queued.taskId));
    fs.writeFileSync(path.join(dir, queued.taskId), 'ok');
    await until(async () => (await task(queued.taskId)).status === 'completed');
    const restartedCalls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.event === 'start');
    assert.deepEqual(restartedCalls.filter(call => call.taskId === running.taskId).map(call => call.channel), ['901', '901']);
    assert.deepEqual(restartedCalls.filter(call => call.taskId === queued.taskId).map(call => call.channel), ['902']);
    assert.equal(restartedCalls.filter(call => call.taskId === d.taskId).length, 1, 'completed exports must not replay');
    assert.equal(restartedCalls.filter(call => call.taskId === b.taskId).length, 0, 'cancelled waiting exports must not replay');

  } finally {
    if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

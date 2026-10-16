import { sanitizeSdkMetadata } from '../lib/dvr-sdk.js';
/** Existing owner gateway and durable projections for the one approved sample. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createExportQueue } from '../lib/export-queue.js';
import { mountDvrHttpSample, DVR_HTTP_SAMPLE_TASK_ID } from '../lib/dvr-http-sample-control.js';
import { CONSOLE_CONFIG_OWNER, consoleConfigJsonError } from '../lib/console-config.js';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { createMediaJobStore } from '../lib/media-job-store.js';
import { sanitizeDvrHttpSample } from '../lib/dvr-http-sample.js';

const id='00000000-0000-4000-8000-000000000001';
const route=`/console/api/tasks/${id}/dvr-http-sample`;
const secret='private-password rtsp://private-user:private-password@private-host/private-name rawstderr SDP';
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/private-|rtsp:\/\/|rawstderr|SDP/);

test('sample action retains active owner, Origin, CSRF, preparation and recovery protections',async t=>{
 let calls=0, resumes=0, preparation=false, ready=true;
 const app=express();app.use(express.json());app.use(consoleConfigJsonError);
 mountDvrHttpSample(app,{control:{start:source=>{calls++;assert.equal(source,id);return {ok:true,taskId:DVR_HTTP_SAMPLE_TASK_ID,status:'queued'};},resume:sampleId=>{resumes++;assert.equal(sampleId,DVR_HTTP_SAMPLE_TASK_ID);return {ok:true,taskId:DVR_HTTP_SAMPLE_TASK_ID};}},preparationOnly:()=>preparation,canWrite:()=>ready});
 app.get('/console/api/settings',(req,res)=>res.json({csrfToken:req[CONSOLE_CONFIG_OWNER].csrfToken}));
 const origin='https://owner.example';
 const server=createPublicGateway(app,{token:'test-token-abcdefghijklmnopqrstuvwxyz',baseUrl:origin,statusPasswordHash:createStatusPasswordHash('test-password')}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(base+'/status/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const {csrfToken}=await(await fetch(base+'/console/api/settings',{headers:{cookie}})).json();
 const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
 const resumeRoute=`/console/api/tasks/${DVR_HTTP_SAMPLE_TASK_ID}/dvr-http-sample`;
 for(const currentRoute of [route,resumeRoute]) for(const changed of [{cookie:''},{origin:'https://evil.example'},{'x-csrf-token':''}]) {
  const r=await fetch(base+currentRoute,{method:'POST',headers:{...headers,...changed},body:'{}'});assert.ok([401,403].includes(r.status));
 }
 assert.equal(calls,0);assert.equal(resumes,0);
 preparation=true;for(const currentRoute of [route,resumeRoute]) assert.equal((await fetch(base+currentRoute,{method:'POST',headers,body:'{}'})).status,409);preparation=false;
 ready=false;for(const currentRoute of [route,resumeRoute]) assert.equal((await fetch(base+currentRoute,{method:'POST',headers,body:'{}'})).status,409);ready=true;
 for(const currentRoute of [route,resumeRoute]) assert.equal((await fetch(base+currentRoute,{method:'POST',headers,body:JSON.stringify({url:secret,deviceId:'arbitrary',maxBytes:1e9})})).status,400);
 assert.equal(calls,0);
 const malformed=await fetch(base+route,{method:'POST',headers,body:'{'+secret});assert.equal(malformed.status,400);safe(await malformed.json());
 const accepted=await fetch(base+route,{method:'POST',headers,body:'{}'});assert.equal(accepted.status,202);safe(await accepted.json());assert.equal(calls,1);
 const resumed=await fetch(base+resumeRoute,{method:'POST',headers,body:'{}'});assert.equal(resumed.status,202);safe(await resumed.json());assert.equal(resumes,1);assert.equal(calls,1);
 await fetch(base+'/status/logout',{method:'POST',headers});
 for(const currentRoute of [route,resumeRoute]) assert.equal((await fetch(base+currentRoute,{method:'POST',headers,body:'{}'})).status,401);assert.equal(calls,1);assert.equal(resumes,1);
});

test('both durable stores retain only closed sample facts, no URLs or custom serializers',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sample-stores-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const report={outcome:'decoded',stopReason:'byte_limit',httpStatus:200,bytes:32000000,mediaType:'mpegps',videoCodec:'h264',audioCodec:'aac',width:1920,height:1080,decodedFrames:12,firstPtsSeconds:0,lastPtsSeconds:0.44,uri:secret,stderr:secret,toJSON:()=>secret};
 const task={taskId:crypto.randomUUID(),kind:'dvr-http-sample',status:'completed',queuedAt:1,source:'hikvision',sampleReport:report};
 const recovery=createExportRecoveryStore(path.join(root,'queue')),media=createMediaJobStore(path.join(root,'media'));
 recovery.admit(task,{type:'dvr-http-sample',sourceTaskId:id});media.save(task);
 for(const actual of [createExportRecoveryStore(path.join(root,'queue')).load()[0].task,createMediaJobStore(path.join(root,'media')).read(task.taskId)]) {
  assert.deepEqual(actual.sampleReport,sanitizeDvrHttpSample(report));safe(actual);assert.equal(actual.artifactUrl,undefined);assert.equal(actual.filename,undefined);
 }
});

test('server wiring preserves single queue, dedicated settlement, projection and no-replay recovery hook',()=>{
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(source,/createDvrHttpSampleControl\(\{ recoveryStore, activeTasks, exportQueue, mediaJobs/);
 assert.match(source,/waitForPreview: \(\) => previewSettlement/);
 assert.match(source,/if \(current.kind === 'dvr-http-sample'\)/);
 assert.match(source,/dvrHttpSampleAvailable: dvrHttpSampleControl.available\(task.taskId\)/);
 assert.match(source,/sampleReport: sanitizeDvrHttpSample\(task.sampleReport\)/);
 const recovery=source.slice(source.indexOf('function recoverExportTasks()'));
 assert.ok(recovery.indexOf('dvrHttpSampleControl.recoverInterrupted(record)')<recovery.indexOf('EXPORT_TERMINAL.has(task.status)'));
});


test('actual sample settlement preserves report and never claims cleanup success on failure',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sample-settlement-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const start=source.indexOf('const activeTasks = new Map();'),end=source.indexOf('// A read-only secondary instance',start);
 const recoveryStore=createExportRecoveryStore(path.join(root,'queue')),mediaJobs=createMediaJobStore(path.join(root,'media'));
 const context=vm.createContext({sanitizeSdkMetadata, createExportQueue,recoveryStore,mediaJobs,sanitizeDvrHttpSample,console});
 vm.runInContext(`let sseClients=[];let consolePreviewGeneration=0;let activePreview=null;
  ${source.slice(start,end)}
  function broadcastProgress(taskId,status,progress,message){Object.assign(activeTasks.get(taskId),{status,progress,message});}
  globalThis.h={activeTasks,exportQueue};`,context);
 for(const [outcome,cancelled,expected] of [['decoded',false,'completed'],['cleanup_failed',false,'error'],['cleanup_failed',true,'error']]) {
  const controller=new AbortController();
  const task={taskId:crypto.randomUUID(),kind:'dvr-http-sample',cameraJob:true,source:'hikvision',status:'queued',queuedAt:1,controller};
  context.h.activeTasks.set(task.taskId,task);recoveryStore.admit(task,{type:'dvr-http-sample'});
  await context.h.exportQueue.submit(task,async()=>{task.sampleReport={outcome,stopReason:'byte_limit',httpStatus:200,bytes:32,decodedFrames:1};if(cancelled)controller.abort();});
  const saved=mediaJobs.read(task.taskId);
  assert.equal(saved.status,expected);assert.equal(saved.sampleReport.outcome,outcome);safe(saved);
  if(outcome==='cleanup_failed'){assert.match(saved.message,/清理未完成/);assert.doesNotMatch(saved.message,/已清理/);}
  else assert.match(saved.message,/不是所选十秒/);
 }
});

test('dashboard and signed task expose only the existing durable checkpoint without writing or restarting work', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sample-checkpoint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const recoveryStore=createExportRecoveryStore(path.join(root,'queue'));
 const task={taskId:crypto.randomUUID(),kind:'dvr-http-sample',source:'hikvision',status:'completed',queuedAt:1,sampleMediaAttempted:secret};
 recoveryStore.admit(task,{type:'dvr-http-sample',mediaAttempted:false});
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const slice=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
 const context=vm.createContext({sanitizeSdkMetadata, recoveryStore,activeTasks:new Map([[task.taskId,task]]),exportQueue:{owns:()=>false},
  getAllDevices:()=>({devices:[]}),consoleUploadJobs:()=>[],uploadQueue:{activeCount:()=>0},cloud189Queue:{activeCount:()=>0},readConsoleSettings:()=>({}),consoleIntegrations:()=>({}),
  dvrRtspFailureDiagnostics:()=>undefined,dvrHttpSampleControl:{available:()=>false,resumeAvailable:()=>false},sanitizeDvrHttpSample,DVR_HTTP_SAMPLE_TASK_ID});
 vm.runInContext(`${slice('function getDashboardStatus()',"app.post('/api/bilibili/prepare'")}
 ${slice('function signedMediaTask(',"app.get('/api/media-jobs/:id'")}
 globalThis.project={getDashboardStatus,signedMediaTask};`,context);
 for(const value of [false,true,undefined,secret]) {
  recoveryStore.request(task.taskId,{type:'dvr-http-sample',mediaAttempted:value});
  const file=path.join(root,'queue',task.taskId+'.json'),before=fs.readFileSync(file,'utf8');
  for(const actual of [context.project.getDashboardStatus().tasks[0],context.project.signedMediaTask(task)]) {
   assert.equal(actual.sampleMediaAttempted,typeof value==='boolean'?value:undefined);safe(actual);
  }
  assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});


function projectionHarness(task, recoveryStore, resumeAvailable = () => false) {
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const slice=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
 const context=vm.createContext({sanitizeSdkMetadata, recoveryStore,activeTasks:new Map([[task.taskId,task]]),exportQueue:{owns:()=>false},
  getAllDevices:()=>({devices:[]}),consoleUploadJobs:()=>[],uploadQueue:{activeCount:()=>0},cloud189Queue:{activeCount:()=>0},readConsoleSettings:()=>({}),consoleIntegrations:()=>({}),
  dvrRtspFailureDiagnostics:()=>undefined,dvrHttpSampleControl:{available:()=>false,resumeAvailable},sanitizeDvrHttpSample,DVR_HTTP_SAMPLE_TASK_ID});
 vm.runInContext(`${slice('function getDashboardStatus()',"app.post('/api/bilibili/prepare'")}
 ${slice('function signedMediaTask(',"app.get('/api/media-jobs/:id'")}
 globalThis.project={getDashboardStatus,signedMediaTask};`,context);
 return () => [context.project.getDashboardStatus().tasks[0],context.project.signedMediaTask(task)];
}

test('resume projections trust only fixed-task controller booleans and sanitized durable history', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sample-resume-projection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const recoveryStore=createExportRecoveryStore(path.join(root,'queue'));
 const task={taskId:DVR_HTTP_SAMPLE_TASK_ID,kind:'dvr-http-sample',status:'completed',queuedAt:1,
  sampleResumeAvailable:secret,samplePreflightReport:{outcome:secret,uri:secret}};
 const history={outcome:'failed',stopReason:'transport_error',httpStatus:null,bytes:0,uri:secret,headers:secret,error:secret};
 recoveryStore.admit(task,{type:'dvr-http-sample',mediaAttempted:false,preflightAttempt:history,preflightResumeConsumed:true});
 let availability=false,calls=0;
 const project=projectionHarness(task,recoveryStore,taskId=>{calls++;assert.equal(taskId,DVR_HTTP_SAMPLE_TASK_ID);return availability;});
 const file=path.join(root,'queue',task.taskId+'.json'),before=fs.readFileSync(file,'utf8');
 for(const value of [false,true,undefined,null,0,1,'true',secret,{},[]]) {
  availability=value;
  for(const actual of project()) {
   assert.equal(actual.sampleResumeAvailable,value===true);
   assert.equal(actual.sampleMediaAttempted,false);
   assert.deepEqual(actual.samplePreflightReport,sanitizeDvrHttpSample(history));
   assert.equal(actual.preflightResumeConsumed,undefined);safe(actual);
  }
 }
 assert.equal(calls,20);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('non-sample and wrong-ID projections never consult resume or expose fabricated history', () => {
 for(const task of [{taskId:id,kind:'dvr-http-sample'},{taskId:DVR_HTTP_SAMPLE_TASK_ID,kind:'camera'},{taskId:id}]) {
  Object.assign(task,{status:'completed',sampleResumeAvailable:true,samplePreflightReport:secret});
  const project=projectionHarness(task,{get:()=>({request:{preflightAttempt:{outcome:'failed',stopReason:'transport_error',bytes:0}}})},()=>{throw new Error('must not consult resume');});
  for(const actual of project()) {assert.equal(actual.sampleResumeAvailable,false);assert.equal(actual.samplePreflightReport,undefined);safe(actual);}
 }
});

test('preflight projections never reflect hostile strings, accessors, inherited fields or serializers', () => {
 const task={taskId:DVR_HTTP_SAMPLE_TASK_ID,kind:'dvr-http-sample',status:'completed'};
 const report={outcome:'failed',stopReason:'transport_error',bytes:0};
 const accessors=Object.defineProperties({},Object.fromEntries(Object.keys(report).map(key=>[key,{get(){throw new Error('must not invoke getter');}}])));
 for(const preflightAttempt of [undefined,null,false,secret,[],Object.create(report),accessors,{...report,outcome:secret},
  {...report,bytes:secret,httpStatus:secret,phase:secret,curlExitCode:secret,toJSON(){throw new Error('must not serialize');},url:secret,headers:secret,error:secret}]) {
  const request=Object.freeze({preflightAttempt});
  for(const actual of projectionHarness(task,{get:()=>({request})})()) {
   assert.deepEqual(actual.samplePreflightReport,sanitizeDvrHttpSample(preflightAttempt));safe(actual);
  }
 }
});

test('an old terminal cleanup cannot delete a resumed task with the same ID while queued', () => {
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const start=source.indexOf('function broadcastProgress('),end=source.indexOf('setProgressStatusHook(',start);
 const activeTasks=new Map(),timers=[];let owns=false;
 const context=vm.createContext({sanitizeSdkMetadata, activeTasks,exportQueue:{owns:()=>owns},sseClients:[],setTimeout:callback=>{timers.push(callback);return {unref(){}};}});
 vm.runInContext(`${source.slice(start,end)}globalThis.broadcast=broadcastProgress;`,context);
 activeTasks.set(DVR_HTTP_SAMPLE_TASK_ID,{taskId:DVR_HTTP_SAMPLE_TASK_ID,status:'completed'});
 context.broadcast(DVR_HTTP_SAMPLE_TASK_ID,'completed',100,'done');
 const resumed={taskId:DVR_HTTP_SAMPLE_TASK_ID,status:'queued'};
 activeTasks.set(DVR_HTTP_SAMPLE_TASK_ID,resumed);
 timers.shift()();assert.equal(activeTasks.get(DVR_HTTP_SAMPLE_TASK_ID),resumed);
 context.broadcast(DVR_HTTP_SAMPLE_TASK_ID,'completed',100,'done');
 owns=true;timers[0]();assert.ok(activeTasks.has(DVR_HTTP_SAMPLE_TASK_ID));
 owns=false;timers.shift()();assert.equal(activeTasks.has(DVR_HTTP_SAMPLE_TASK_ID),false);
});

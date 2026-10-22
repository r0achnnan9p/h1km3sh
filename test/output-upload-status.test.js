import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOutputUploadStates } from '../lib/output-upload-status.js';
import { listOutputLibrary } from '../lib/output-library.js';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-upload-status-')), directory = path.join(root, 'jobs');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(directory);
  const file = path.join(root, 'clip.mp4'); fs.writeFileSync(file, 'content');
  const stat = fs.statSync(file, { bigint: true });
  const sourceIdentity = { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
  let sequence = 0;
  const add = job => { const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`; fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify({createdAt:`2026-10-08T00:00:${String(sequence).padStart(2,'0')}Z`,...job})); };
  const states = () => [...readOutputUploadStates(root,directory,listOutputLibrary(root)).values()];
  return {root,directory,file,sourceIdentity,add,states};
}
test('完成状态需当前身份，覆盖同名文件不沿用旧成功', t => {
 const h=setup(t);assert.deepEqual(h.states(),[{status:'none'}]);
 h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'completed'});assert.deepEqual(h.states(),[{status:'completed'}]);
 fs.unlinkSync(h.file);fs.writeFileSync(h.file,'new content');assert.deepEqual(h.states(),[{status:'unknown'}]);
});
test('受管改名保持同一inode时识别记录，无身份旧记录只给未知',t=>{
 const h=setup(t);h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'completed'});
 fs.renameSync(h.file,path.join(h.root,'renamed.mp4'));assert.deepEqual(h.states(),[{status:'completed'}]);
 h.add({filename:'renamed.mp4',status:'completed'});assert.deepEqual(h.states(),[{status:'completed'}]);
 fs.writeFileSync(path.join(h.root,'legacy.mp4'),'legacy');h.add({filename:'legacy.mp4',status:'completed'});assert.equal(h.states().filter(s=>s.status==='unknown').length,1);
});
test('未决请求和真实百分比优先，归档未知不伪装成功',t=>{
 const h=setup(t);h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'completed'});
 h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'uploading',progress:27.5});assert.deepEqual(h.states(),[{status:'uploading',progress:27.5}]);
 h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'unknown',archivedAt:'now'});assert.deepEqual(h.states(),[{status:'unknown'}]);
});
test('坏记录或无百分比不提供假成功/进度，不输出队列私有字段',t=>{
 const h=setup(t);h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'uploading',progress:'99',targetPath:'private',message:'private'});
 assert.deepEqual(h.states(),[{status:'uploading'}]);
 const files=fs.readdirSync(h.directory);fs.writeFileSync(path.join(h.directory,files[0]),'{');assert.deepEqual(h.states(),[{status:'unknown'}]);
});


test('合法 JSON 的 null/数组/标量坏记录不会拖垮成片库', t => {
  const h=setup(t);
  h.add({filename:'clip.mp4',sourceIdentity:h.sourceIdentity,status:'completed'});
  const corrupt=path.join(h.directory,'11111111-1111-4111-8111-111111111111.json');
  for(const value of ['null','[]','1','"invalid"']) {
    fs.writeFileSync(corrupt,value); assert.deepEqual(h.states(),[{status:'unknown'}]);
  }
});

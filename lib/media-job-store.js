import { sanitizeSdkMetadata } from './dvr-sdk.js';
import { validSourceIdentity } from './source-identity.js';
/** 只持久化媒体结果白名单，任务列表回收后仍可交付文件，不保存设备凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { renameOutputAlias } from './output-library.js';
import { dvrRtspFailureDiagnostics } from './dvr-export-errors.js';
import { sanitizeDvrHttpSample } from './dvr-http-sample.js';
import { standaloneTheme } from './standalone-ui.js';

/** 更新单个任务快照；保留不相干字段，并仅迁移身份匹配的来源关联。 */
export function renameMediaTaskOutput(task, change) {
  const updateFile = file => {
    if (!file || typeof file !== 'object') return file;
    const outputAlias = renameOutputAlias(file.outputAlias, change);
    const renamed = file.filename === change.source.relativePath && file.size === change.source.identity.size;
    if (!renamed && outputAlias === file.outputAlias) return file;
    return { ...file, ...(renamed ? { filename: change.target.relativePath } : {}),
      ...(outputAlias !== file.outputAlias ? { outputAlias } : {}) };
  };
  let next = task.status === 'completed' ? updateFile(task) : task;
  if (Array.isArray(task.files)) {
    const files = task.files.map(updateFile);
    if (files.some((file, index) => file !== task.files[index])) next = { ...next, files };
  }
  return next;
}

export function createMediaJobStore(root = path.join(resolveDataDir(), 'media-jobs')) {
  const target = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效媒体任务编号。');
    return path.join(root, `${id}.json`);
  };
  const write = (file, task) => {
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(task)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    try { const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  };
  return {
    save(task) {
      const safe = Object.fromEntries(['taskId', 'status', 'kind', 'message', 'startTime', 'queuedAt', 'startedAt', 'queuePosition', 'progress', 'artifactUrl', 'filename', 'files', 'progressUrl', 'total', 'source', 'sourceIdentity', 'strategy', 'camera', 'start', 'end', 'mode', 'size', 'outputAlias', 'coverage', 'acceptGaps', 'failureCode'].map(k => [k, task[k]]));
      const sdkMetadata = sanitizeSdkMetadata(task.sdkMetadata);
    if (sdkMetadata) safe.sdkMetadata = sdkMetadata;
    const failureDiagnostics = dvrRtspFailureDiagnostics(task.failureDiagnostics);
      if (failureDiagnostics) safe.failureDiagnostics = failureDiagnostics;
      const sampleReport = sanitizeDvrHttpSample(task.sampleReport);
      if (sampleReport) safe.sampleReport = sampleReport;
      fs.mkdirSync(root, { recursive: true });
      write(target(task.taskId), safe);
    },
    read(id) {
      const task = JSON.parse(fs.readFileSync(target(id), 'utf8'));
      if (!['completed', 'error', 'cancelled'].includes(task.status)) return { ...task, status: 'error', message: '服务曾重启，任务已中断；已完成的文件仍可下载。' };
      return task;
    },
    /** 跟随已验证的文件改名更新交付索引；UUID 产物 URL 与上传历史完全不变。 */
    renameOutput(change, activeTasks = []) {
      // 先同步在内存中的结果，防止稍后的任务保存把旧名字/来源重新写回磁盘。
      for (const task of activeTasks) {
        const updated = renameMediaTaskOutput(task, change);
        if (updated === task) continue;
        // 批任务执行器也持有已发布 file 对象；保留引用，避免最终回调写回旧名。
        if (Array.isArray(task.files) && updated.files !== task.files) {
          updated.files = task.files.map((file, index) => {
            if (updated.files[index] !== file) Object.assign(file, updated.files[index]);
            return file;
          });
        }
        Object.assign(task, updated);
      }
      let names;
      try { names = fs.readdirSync(root); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const failures = [];
      for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        try {
          const file = path.join(root, name);
          let task;
          try { task = JSON.parse(fs.readFileSync(file, 'utf8')); }
          catch (error) { if (error instanceof SyntaxError) continue; throw error; }
          if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
          const updated = renameMediaTaskOutput(task, change);
          if (updated !== task) write(file, updated);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, '部分媒体任务记录未能更新');
    },
    outputAliases() {
      let names;
      try { names = fs.readdirSync(root); } catch { return []; }
      return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          // 部分成功的多镜头任务也有已发布成品；历史任务没有来源证据时不猜测。
          return [...(Array.isArray(task.files) ? task.files.map(file => file.outputAlias).filter(Boolean) : []),
            ...(task.status === 'completed' && task.outputAlias ? [task.outputAlias] : [])];
        } catch { return []; }
      });
    },
    findFile({ filename, camera, start, end, mode, sourceIdentity }, downloadsDir) {
      if (!validSourceIdentity(sourceIdentity)) return null;
      const output = path.join(downloadsDir, filename);
      let size;
      try { const stat = fs.statSync(output); if (!stat.isFile()) return null; size = stat.size; }
      catch { return null; }
      if (!fs.existsSync(root)) return null;
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          const found = task.files?.find(file => file.sourceIdentity === sourceIdentity && file.filename === filename && file.camera === camera && file.start === start && file.end === end && file.mode === mode && file.size === size);
          if (found) return found;
        } catch { /* 跳过损坏的历史任务，不猜测文件内容。 */ }
      }
      return null;
    },
    findByRange({ camera, start, end, mode, acceptGaps = false, requiredSource, expectedCoverage, sourceIdentity }, downloadsDir, filename) {
      if (!validSourceIdentity(sourceIdentity)) return null;
      if (!fs.existsSync(root)) return null;
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          const candidates = [...(task.files || [])];
          if (task.status === 'completed' && task.kind === 'clip' && task.filename && task.artifactUrl) candidates.push(task);
          for (const file of candidates) {
            if (file.sourceIdentity !== sourceIdentity || file.camera !== camera || file.start !== start || file.end !== end || file.mode !== mode || (filename && file.filename !== filename)) continue;
            if (requiredSource && file.source !== requiredSource) continue;
            if (file.coverage?.hasGaps && !acceptGaps) continue;
            if (file.coverage?.hasGaps && expectedCoverage) {
              const gaps = coverage => JSON.stringify((coverage.missingIntervals || []).map(gap => [gap.startMs ?? gap.start, gap.endMs ?? gap.end]));
              if (!expectedCoverage.hasGaps || gaps(file.coverage) !== gaps(expectedCoverage)) continue;
            }
            const output = path.join(downloadsDir, file.filename);
            const stat = fs.statSync(output);
            if (stat.isFile() && stat.size === file.size) return file;
          }
        } catch { /* 缺失文件或损坏任务不能被误当作成品。 */ }
      }
      return null;
    },
  };
}

export function mediaJobPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>录像任务</title>
  <style>
    ${standaloneTheme}
    main {
      display: grid; align-content: start; gap: 1.25rem; max-width: 90rem; margin: auto;
      padding: max(clamp(1.25rem, 3vw, 3rem), env(safe-area-inset-top)) max(clamp(1rem, 4vw, 3rem), env(safe-area-inset-right)) max(2rem, env(safe-area-inset-bottom)) max(clamp(1rem, 4vw, 3rem), env(safe-area-inset-left));
    }
    header { display: flex; align-items: end; justify-content: space-between; flex-wrap: wrap; gap: .5rem 1rem; }
    h1 { font-size: clamp(1.5rem, 4vw, 2.125rem); line-height: 1.2; }
    .live, .state-line { display: inline-flex; align-items: center; gap: .5rem; font-size: .875rem; }
    .live { color: var(--muted); }
    .live-dot, .state-mark { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: var(--accent); flex: none; }
    .live.done .live-dot, .work.completed .state-mark, .work.completed .progress-fill { background: var(--green); }
    .live.failed .live-dot, .work.error .state-mark, .work.cancelled .state-mark { background: var(--coral); }
    .work, .files { min-width: 0; align-self: start; padding: clamp(1rem, 3vw, 2rem); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; }
    .state-line { color: var(--muted); }
    .work h2 { margin-top: .5rem; font-size: clamp(1.25rem, 3vw, 1.75rem); line-height: 1.35; overflow-wrap: anywhere; }
    .progress-block { margin-top: 1.5rem; }
    .progress-track { height: 6px; overflow: hidden; border-radius: 4px; background: var(--surface2); }
    .progress-fill { height: 100%; width: 0; border-radius: inherit; background: var(--accent); transition: width .3s ease; }
    .progress-track.indeterminate .progress-fill { width: 34%; animation: travel 1.35s ease-in-out infinite; }
    .progress-caption, .files-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .25rem 1rem; }
    .progress-caption { margin-top: .625rem; font-size: .875rem; color: var(--muted); }
    #percent { color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
    #message { margin-top: .75rem; font-size: .875rem; color: var(--muted); overflow-wrap: anywhere; }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: .875rem; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    .fact { min-width: 0; }
    .fact:last-child { grid-column: 1 / -1; }
    .fact dt, #file-count, .file-meta, .foot { color: var(--muted); font-size: .8125rem; }
    .fact dd { margin-top: .125rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .files h2 { font-size: 1.125rem; }
    #file-list { list-style: none; margin: 1rem 0 0; padding: 0; border-top: 1px solid var(--line); }
    .file-row + .file-row { border-top: 1px solid var(--line); }
    .file-link { display: grid; grid-template-columns: 2.5rem minmax(0,1fr); align-items: center; gap: 0 .75rem; min-height: 56px; padding: .75rem 0; border-radius: 6px; text-decoration: none; }
    .file-link:hover .file-name { text-decoration: underline; }
    .file-type { grid-row: span 2; display: grid; place-items: center; aspect-ratio: 1; border-radius: 12px; background: var(--surface2); color: var(--muted); font: 600 .75rem var(--mono); }
    .file-copy, .file-name, .file-meta { min-width: 0; display: block; overflow-wrap: anywhere; }
    .file-name { color: var(--text); font-weight: 650; line-height: 1.4; }
    .file-action { grid-column: 2; color: var(--accent); font-size: .875rem; }
    .empty { padding-top: 1rem; color: var(--muted); }
    @keyframes travel { from { transform: translateX(-110%); } to { transform: translateX(320%); } }
    @media (min-width: 64rem) {
      main { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
      header, .foot { grid-column: 1 / -1; }
      .file-link { grid-template-columns: 2.5rem minmax(0,1fr) auto; }
      .file-type { grid-row: auto; }
      .file-action { grid-column: auto; }
    }
    @media (prefers-reduced-motion: reduce) {
      .progress-fill { transition: none; }
      .progress-track.indeterminate .progress-fill { animation: none; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>录像任务</h1>
      <span class="live" id="live"><i class="live-dot" aria-hidden="true"></i><span id="live-text">正在连接</span></span>
    </header>
    <section class="work" id="work" aria-labelledby="task-title">
      <div class="state-line"><i class="state-mark" aria-hidden="true"></i><span id="state">正在查询任务</span></div>
      <h2 id="task-title">正在准备录像</h2>
      <div class="progress-block">
        <div class="progress-track indeterminate" id="track" role="progressbar" aria-label="录像处理进度" aria-valuemin="0" aria-valuemax="100" aria-valuetext="正在处理中">
          <div class="progress-fill" id="fill"></div>
        </div>
        <div class="progress-caption"><span id="progress-label">正在读取进度</span><span id="percent">处理中</span></div>
      </div>
      <p id="message" aria-live="polite">正在连接任务状态…</p>
      <dl class="facts">
        <div class="fact"><dt>镜头</dt><dd id="camera">读取中</dd></div>
        <div class="fact"><dt>录像来源</dt><dd id="source">读取中</dd></div>
        <div class="fact"><dt>时间范围</dt><dd id="time">读取中</dd></div>
      </dl>
    </section>
    <section class="files" aria-labelledby="files-title">
      <div class="files-head"><h2 id="files-title">可用文件</h2><span id="file-count">等待生成</span></div>
      <ul id="file-list"><li class="empty" id="empty">任务开始后，已完成的镜头会显示在这里。</li></ul>
    </section>
    <p class="foot" id="updated">任务状态每 3 秒自动更新</p>
  </main>
  <script>
    const el=id=>document.getElementById(id);
    const stateNames={queued:'排队中',pending:'排队中',downloading:'正在导出',converting:'正在封装',completed:'已完成',error:'导出失败',cancelled:'已取消'};
    const stageNames={searching:'搜索录像',cache:'复用缓存',downloading:'下载录像',trimming:'裁剪片段',remuxing:'封装片段',concatenating:'拼接 MP4',finalizing:'保存成品'};
    const terminal=new Set(['completed','error','cancelled']);
    const formatTime=value=>{if(!value)return '';const text=String(value).replace('T',' ').replace(/Z$/,'');return text.length>16?text.slice(0,19):text;};
    function formatSize(bytes){
      if(!Number.isFinite(bytes)||bytes<=0)return '';
      if(bytes<1024*1024)return (bytes/1024).toFixed(0)+' KB';
      if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(1)+' MB';
      return (bytes/1024/1024/1024).toFixed(2)+' GB';
    }
    function render(task){
      const files=Array.isArray(task.files)?task.files:[];
      const count=files.length,total=Number(task.total)||0,status=task.status||'downloading',done=terminal.has(status);
      const current=task.stage?(task.stagePercent==null?NaN:Number(task.stagePercent)):Number(task.progress);
      let percent=null;
      if(status==='completed')percent=100;
      else if(task.stage)percent=Number.isFinite(current)?Math.max(0,Math.min(100,current)):null;
      else if(total>0)percent=Math.min(99,Math.max(0,(count+((Number.isFinite(current)&&current>0)?current/100:0))/total*100));
      else if(Number.isFinite(current)&&current>0)percent=Math.min(99,Math.max(0,current));
      const queued=status==='queued'||status==='pending';
      const indeterminate=!done&&!queued&&(percent===null||percent===0);
      const track=el('track');
      track.hidden=queued;
      track.classList.toggle('indeterminate',indeterminate);
      el('fill').style.width=indeterminate?'':(percent||0)+'%';
      if(indeterminate){track.removeAttribute('aria-valuenow');track.setAttribute('aria-valuetext','正在处理中');}
      else{track.setAttribute('aria-valuenow',String(Math.round(percent||0)));track.setAttribute('aria-valuetext',Math.round(percent||0)+'%');}
      el('state').textContent=queued?'排队中':(!done&&stageNames[task.stage])||stateNames[status]||'正在处理';
      el('percent').textContent=queued?(task.queuePosition?'第 '+task.queuePosition+' 位':'等待执行'):done?(status==='completed'?'完成':status==='cancelled'?'已取消':'失败'):indeterminate?'处理中':Math.round(percent||0)+'%';
      el('progress-label').textContent=total?'已完成 '+count+' / '+total+' 个镜头':(status==='completed'?'文件已经就绪':task.stage?(task.progressUnit==='files'?'本阶段文件完成进度':'当前阶段 · '+(stageNames[task.stage]||'处理中')):'当前任务进度');
      const details=[];
      if(task.message&&task.message!==el('state').textContent)details.push(task.message);
      if(!done&&task.progressUpdatedAt)details.push(Math.max(0,Math.floor((Date.now()-task.progressUpdatedAt)/1000))+' 秒前更新');
      el('message').textContent=details.join(' · ');el('message').hidden=!details.length;
      const first=files[0]||{};
      const title=task.filename||first.filename||(task.kind==='batch'?'多镜头录像':task.camera?task.camera+' 录像':'录像导出');
      el('task-title').textContent=title;
      const start=formatTime(task.start||first.start),end=formatTime(task.end||first.end);
      const cameras=[...new Set(files.map(file=>file.camera).filter(Boolean))];
      el('camera').textContent=task.camera||cameras.join('、')||(total?total+' 个镜头':'—');
      el('source').textContent=task.source==='mediamtx'?'本地录像':task.source==='dvr'?'录像机':task.source||'—';
      el('time').textContent=start&&end?start+' 至 '+(start.slice(0,10)===end.slice(0,10)?end.slice(11):end):'—';
      const live=el('live');
      live.classList.toggle('done',status==='completed');live.classList.toggle('failed',status==='error'||status==='cancelled');
      el('live-text').textContent=done?(status==='completed'?'任务已结束':'需要检查'): '每 3 秒自动更新';
      el('work').classList.toggle('completed',status==='completed');el('work').classList.toggle('error',status==='error');el('work').classList.toggle('cancelled',status==='cancelled');
      const items=files.length?files:(task.artifactUrl?[{filename:task.filename||'查看结果',artifactUrl:task.artifactUrl}]:[]);
      el('file-count').textContent=total?count+' / '+total+' 个镜头已就绪':items.length?items.length+' 个文件':done?'0 个文件':'等待生成';
      const list=el('file-list');
      const focused=document.activeElement;
      const focusPath=list.contains(focused)&&focused.tagName==='A'?focused.pathname:null;
      list.replaceChildren();
      if(!items.length){const empty=document.createElement('li');empty.className='empty';empty.textContent=status==='error'?'当前没有可下载的成片。检查录像覆盖后可以重新发起导出。':status==='cancelled'?'任务已停止。已完成的镜头会保留在此处。':'任务开始后，已完成的镜头会显示在这里。';list.append(empty);}
      for(const file of items){
        if(!file.artifactUrl)continue;
        const row=document.createElement('li');row.className='file-row';
        const link=document.createElement('a');link.className='file-link';link.href=file.artifactUrl;
        const type=document.createElement('span');type.className='file-type';type.textContent=(file.filename||'文件').split('.').pop().slice(0,5).toUpperCase();
        const copy=document.createElement('span');copy.className='file-copy';
        const name=document.createElement('span');name.className='file-name';name.textContent=file.filename||'下载文件';
        const meta=document.createElement('span');meta.className='file-meta';meta.textContent=[file.camera,formatSize(file.size)].filter(Boolean).join(' · ');
        const action=document.createElement('span');action.className='file-action';action.textContent='打开文件';
        copy.append(name,meta);link.append(type,copy,action);row.append(link);list.append(row);
      }
      if(focusPath)[...list.querySelectorAll('a')].find(link=>link.pathname===focusPath)?.focus({preventScroll:true});
      el('updated').textContent='最近更新 '+new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
      if(!done)setTimeout(refresh,3000);
    }
    async function refresh(){
      try{const url=new URL(location.href);url.searchParams.set('format','json');const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('status');render(await response.json());}
      catch{el('state').textContent='暂时无法更新';el('message').hidden=false;el('message').textContent='请检查网络连接，5 秒后将自动重试。';el('live').classList.add('failed');el('live-text').textContent='连接中断';setTimeout(refresh,5000);}
    }
    refresh();
  </script>
</body>
</html>`;
}

import { sanitizeSdkMetadata } from './dvr-sdk.js';
import { validSourceIdentity } from './source-identity.js';
/** 只持久化媒体结果白名单，任务列表回收后仍可交付文件，不保存设备凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { renameOutputAlias } from './output-library.js';
import { dvrRtspFailureDiagnostics } from './dvr-export-errors.js';
import { sanitizeDvrHttpSample } from './dvr-http-sample.js';

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
  <meta name="color-scheme" content="light">
  <title>录像任务</title>
  <style>
    :root{color-scheme:light;--paper:#edf1ee;--ink:#1c2b2d;--pine:#19483d;--amber:#f0b34d;--muted:#718078;--line:#d4ddd7;--red:#a94237}
    *{box-sizing:border-box}
    body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    main{width:min(820px,100%);margin:0 auto;padding:clamp(22px,5vw,52px) clamp(16px,4vw,30px) 48px}
    header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 22px}
    h1{margin:0;font-size:clamp(23px,5vw,30px);font-weight:680;letter-spacing:-.035em;line-height:1.2}
    .live{display:inline-flex;align-items:center;gap:9px;color:var(--muted);font-size:13px;white-space:nowrap}
    .live-dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 4px #f0b34d28}
    .live.done .live-dot{background:var(--pine);box-shadow:0 0 0 4px #19483d20}
    .live.failed .live-dot{background:var(--red);box-shadow:0 0 0 4px #a9423720}
    .work{overflow:hidden;border-radius:18px;background:var(--pine);color:#f5f7f4;padding:clamp(22px,5vw,36px);box-shadow:0 12px 30px #17372b12}
    .state-line{display:flex;align-items:center;gap:10px;color:#d3dfd8;font-size:14px}
    .state-mark{width:8px;height:8px;border-radius:50%;background:var(--amber);flex:none}
    .work.completed .state-mark{background:#8bc1a3}
    .work.error .state-mark,.work.cancelled .state-mark{background:#f0907f}
    h2{margin:10px 0 3px;font-size:clamp(20px,4vw,27px);font-weight:620;letter-spacing:-.025em;line-height:1.32;overflow-wrap:anywhere}
    .range{min-height:25px;color:#c3d2ca;font-size:14px;overflow-wrap:anywhere}
    .progress-block{margin-top:27px}
    .progress-track{height:12px;overflow:hidden;border-radius:20px;background:#ffffff24}
    .progress-fill{height:100%;width:0;border-radius:inherit;background:var(--amber);transition:width .35s ease}
    .progress-track.indeterminate .progress-fill{width:34%;animation:travel 1.35s ease-in-out infinite}
    .progress-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;color:#e0e9e3;font-size:14px}
    #percent{flex:none;color:#fff;font-variant-numeric:tabular-nums;font-weight:650}
    #message{margin:18px 0 0;color:#d6e1da;font-size:14px;overflow-wrap:anywhere}
    .facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:20px 0 0;padding-top:18px;border-top:1px solid #ffffff28;gap:16px}
    .fact{min-width:0}
    .fact dt{color:#aebfb5;font-size:12px}
    .fact dd{margin:3px 0 0;color:#f7f8f6;font-size:14px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    .files{margin-top:32px}
    .files-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
    h3{margin:0;font-size:17px;font-weight:650}
    #file-count{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
    #file-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
    .file-row{min-width:0;border-bottom:1px solid var(--line)}
    .file-link{display:grid;grid-template-columns:46px minmax(0,1fr) auto;align-items:center;gap:13px;min-height:76px;padding:12px 4px;color:inherit;text-decoration:none}
    .file-link:hover .file-name{color:var(--pine)}
    .file-link:focus-visible{outline:3px solid var(--amber);outline-offset:2px;border-radius:6px}
    .file-type{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#dce6df;color:var(--pine);font-size:10px;font-weight:750;letter-spacing:.03em}
    .file-copy{min-width:0}
    .file-name{display:block;font-weight:620;line-height:1.35;overflow-wrap:anywhere;transition:color .15s ease}
    .file-meta{display:block;margin-top:3px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
    .file-action{color:var(--pine);font-size:13px;font-weight:650;white-space:nowrap}
    .empty{padding:18px 2px;color:var(--muted);font-size:14px}
    .foot{margin:25px 0 0;color:var(--muted);font-size:12px}
    @keyframes travel{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
    @media(max-width:540px){main{padding-top:22px}.live{font-size:12px}.facts{grid-template-columns:1fr 1fr;gap:14px 10px}.facts .fact:last-child:nth-child(odd){grid-column:1/-1}.file-link{grid-template-columns:40px minmax(0,1fr);gap:11px;min-height:70px}.file-type{width:38px;height:38px}.file-action{grid-column:2;margin-top:-7px;font-size:12px}.progress-block{margin-top:22px}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
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
      <div class="range" id="range"></div>
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
      <div class="files-head"><h3 id="files-title">可用文件</h3><span id="file-count">等待生成</span></div>
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
    function render(task){
      const files=Array.isArray(task.files)?task.files:[];
      const count=files.length,total=Number(task.total)||0,status=task.status||'downloading',done=terminal.has(status);
      const current=task.stage?(task.stagePercent==null?NaN:Number(task.stagePercent)):Number(task.progress);
      let percent=null;
      if(status==='completed')percent=100;
      else if(task.stage)percent=Number.isFinite(current)?Math.max(0,Math.min(100,current)):null;
      else if(total>0)percent=Math.min(99,Math.max(0,(count+((Number.isFinite(current)&&current>0)?current/100:0))/total*100));
      else if(Number.isFinite(current)&&current>0)percent=Math.min(99,Math.max(0,current));
      const queued=status==='queued';
      const indeterminate=!done&&!queued&&(percent===null||percent===0);
      const track=el('track');
      track.hidden=queued;
      track.classList.toggle('indeterminate',indeterminate);
      el('fill').style.width=(indeterminate?0:(percent||0))+'%';
      if(indeterminate){track.removeAttribute('aria-valuenow');track.setAttribute('aria-valuetext','正在处理中');}
      else{track.setAttribute('aria-valuenow',String(Math.round(percent||0)));track.setAttribute('aria-valuetext',Math.round(percent||0)+'%');}
      el('state').textContent=queued?'排队中':(!done&&stageNames[task.stage])||stateNames[status]||'正在处理';
      el('percent').textContent=queued?(task.queuePosition?'第 '+task.queuePosition+' 位':'等待执行'):done?(status==='completed'?'完成':status==='cancelled'?'已取消':'失败'):indeterminate?'处理中':Math.round(percent||0)+'%';
      el('progress-label').textContent=total?'已完成 '+count+' / '+total+' 个镜头':(status==='completed'?'文件已经就绪':task.stage?(task.progressUnit==='files'?'本阶段文件完成进度':'当前阶段 · '+(stageNames[task.stage]||'处理中')):'当前任务进度');
      el('message').textContent=(task.message||stateNames[status]||'正在处理')+(!done&&task.progressUpdatedAt?' · '+Math.max(0,Math.floor((Date.now()-task.progressUpdatedAt)/1000))+' 秒前更新':'');
      const first=files[0]||{};
      const title=task.filename||first.filename||(task.kind==='batch'?'多镜头录像':task.camera?task.camera+' 录像':'录像导出');
      el('task-title').textContent=title;
      const start=formatTime(task.start||first.start),end=formatTime(task.end||first.end);
      el('range').textContent=start&&end?start+' 至 '+end:'';
      const cameras=[...new Set(files.map(file=>file.camera).filter(Boolean))];
      el('camera').textContent=task.camera||cameras.join('、')||(total?total+' 个镜头':'—');
      el('source').textContent=task.source==='mediamtx'?'本地录像':task.source==='dvr'?'录像机':task.source||'—';
      el('time').textContent=start&&end?start.slice(0,16)+' 至 '+end.slice(11,19):'—';
      const live=el('live');
      live.classList.toggle('done',status==='completed');live.classList.toggle('failed',status==='error'||status==='cancelled');
      el('live-text').textContent=done?(status==='completed'?'任务已结束':'需要检查'): '每 3 秒自动更新';
      el('work').classList.toggle('completed',status==='completed');el('work').classList.toggle('error',status==='error');el('work').classList.toggle('cancelled',status==='cancelled');
      el('file-count').textContent=total?count+' / '+total+' 个镜头已就绪':count?count+' 个文件':'等待生成';
      const items=files.length?files:(task.artifactUrl?[{filename:task.filename||'查看结果',artifactUrl:task.artifactUrl}]:[]);
      const list=el('file-list');list.replaceChildren();
      if(!items.length){const empty=document.createElement('li');empty.className='empty';empty.textContent=status==='error'?'当前没有可下载的成片。检查录像覆盖后可以重新发起导出。':status==='cancelled'?'任务已停止。已完成的镜头会保留在此处。':'任务开始后，已完成的镜头会显示在这里。';list.append(empty);}
      for(const file of items){
        if(!file.artifactUrl)continue;
        const row=document.createElement('li');row.className='file-row';
        const link=document.createElement('a');link.className='file-link';link.href=file.artifactUrl;
        const type=document.createElement('span');type.className='file-type';type.textContent=(file.filename||'文件').split('.').pop().slice(0,5).toUpperCase();
        const copy=document.createElement('span');copy.className='file-copy';
        const name=document.createElement('span');name.className='file-name';name.textContent=file.filename||'下载文件';
        const meta=document.createElement('span');meta.className='file-meta';meta.textContent=[file.camera,file.size?(file.size/1024/1024/1024).toFixed(2)+' GB':null].filter(Boolean).join(' · ');
        const action=document.createElement('span');action.className='file-action';action.textContent='打开文件';
        copy.append(name,meta);link.append(type,copy,action);row.append(link);list.append(row);
      }
      el('updated').textContent='最近更新 '+new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())+' · 任务状态每 3 秒自动更新';
      if(!done)setTimeout(refresh,3000);
    }
    async function refresh(){
      try{const url=new URL(location.href);url.searchParams.set('format','json');const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('status');render(await response.json());}
      catch{el('state').textContent='暂时无法更新';el('message').textContent='请检查网络连接后重新打开此结果页。';el('live').classList.add('failed');el('live-text').textContent='连接中断';setTimeout(refresh,5000);}
    }
    refresh();
  </script>
</body>
</html>`;
}

import { standaloneTheme } from './standalone-ui.js';

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
    .live.done .live-dot, .work.completed .state-mark { background: var(--green); }
    .live.failed .live-dot, .work.error .state-mark, .work.cancelled .state-mark { background: var(--coral); }
    .work, .files { min-width: 0; align-self: start; padding: clamp(1rem, 3vw, 2rem); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; }
    .state-line { color: var(--muted); }
    .work h2 { margin-top: .5rem; font-size: clamp(1.25rem, 3vw, 1.75rem); line-height: 1.35; overflow-wrap: anywhere; }
    .progress-block { margin-top: 1.5rem; }
    progress { display: block; width: 100%; accent-color: var(--accent); }
    .work.completed progress { accent-color: var(--green); }
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
    @media (min-width: 64rem) {
      main { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
      header, .foot { grid-column: 1 / -1; }
      .file-link { grid-template-columns: 2.5rem minmax(0,1fr) auto; }
      .file-type { grid-row: auto; }
      .file-action { grid-column: auto; }
    }
    @media (prefers-reduced-motion: reduce) {
      progress:indeterminate { opacity: 0; }
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
      <div class="state-line"><i class="state-mark" aria-hidden="true"></i><span id="state" role="status">正在查询任务</span></div>
      <h2 id="task-title">正在准备录像</h2>
      <div class="progress-block">
        <progress id="track" max="100" aria-label="录像处理进度"></progress>
        <div class="progress-caption"><span id="progress-label">正在读取进度</span><span id="percent">处理中</span></div>
      </div>
      <p id="message">正在连接任务状态…</p>
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
    const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let timer, fetching = false, finished = false;
    const formatTime=value=>{if(!value)return '';const text=String(value).replace('T',' ').replace(/Z$/,'');return text.length>16?text.slice(0,19):text;};
    function formatSize(bytes){
      if(!Number.isFinite(bytes)||bytes<=0)return '';
      if(bytes<1024*1024)return (bytes/1024).toFixed(0)+' KB';
      if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(1)+' MB';
      return (bytes/1024/1024/1024).toFixed(2)+' GB';
    }
    const fileRows = new Map();
    const empty = el('empty');

    function renderFiles(files, status) {
      const list = el('file-list');
      const visible = new Set();
      const focused = document.activeElement;
      let index = 0;
      for (const file of files) {
        if (!file.artifactUrl) continue;
        let url;
        try { url = new URL(file.artifactUrl, location.href); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        // Signed URLs can rotate on every poll. The artifact path stays stable.
        const key = url.origin + url.pathname;
        if (visible.has(key)) continue;
        visible.add(key);
        let row = fileRows.get(key);
        if (!row) {
          row = document.createElement('li');
          row.className = 'file-row';
          row.innerHTML = '<a class="file-link"><span class="file-type"></span><span class="file-copy"><span class="file-name"></span><span class="file-meta"></span></span><span class="file-action">打开文件</span></a>';
          fileRows.set(key, row);
        }
        const anchor = row.firstElementChild;
        anchor.href = url.href;
        const filename = file.filename || '下载文件';
        const values = [
          ['.file-type', (file.filename || '文件').split('.').pop().slice(0, 5).toUpperCase()],
          ['.file-name', filename],
          ['.file-meta', [file.camera, formatSize(file.size)].filter(Boolean).join(' · ')],
        ];
        for (const [selector, value] of values) {
          const field = row.querySelector(selector);
          if (field.textContent !== value) field.textContent = value;
        }
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
        index++;
      }
      for (const [key, row] of fileRows) {
        if (!visible.has(key)) {
          row.remove();
          fileRows.delete(key);
        }
      }
      if (visible.size) empty.remove();
      else {
        empty.textContent = status === 'error' ? '当前没有可下载的成片。检查录像覆盖后可以重新发起导出。'
          : status === 'cancelled' ? '任务已停止。已完成的镜头会保留在此处。'
          : '任务开始后，已完成的镜头会显示在这里。';
        if (!empty.isConnected) list.append(empty);
      }
      if (list.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
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
      track.hidden=queued || (done && status !== 'completed' && percent === null);
      if (indeterminate) track.removeAttribute('value');
      else track.value = percent || 0;
      const stateText = queued ? '排队中' : (!done && stageNames[task.stage]) || stateNames[status] || '正在处理';
      if (el('state').textContent !== stateText) el('state').textContent = stateText;
      el('percent').textContent=queued?(task.queuePosition?'第 '+task.queuePosition+' 位':'等待执行'):done?(status==='completed'?'完成':status==='cancelled'?'已取消':'失败'):indeterminate?'处理中':Math.round(percent||0)+'%';
      el('progress-label').textContent=total?'已完成 '+count+' / '+total+' 个镜头':(status==='completed'?'文件已经就绪':task.stage?(task.progressUnit==='files'?'本阶段文件完成进度':'当前阶段 · '+(stageNames[task.stage]||'处理中')):'当前任务进度');
      const details=[];
      if(task.message&&task.message!==el('state').textContent)details.push(task.message);
      if(!done&&task.progressUpdatedAt)details.push(Math.max(0,Math.floor((Date.now()-task.progressUpdatedAt)/1000))+' 秒前更新');
      const message = details.join(' · ');
      if (el('message').textContent !== message) el('message').textContent = message;
      el('message').hidden = !message;
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
      renderFiles(items, status);
      el('updated').textContent = '最近更新 ' + clock.format(new Date());
      finished = done;
    }

    async function refresh() {
      if (document.hidden || fetching || finished) return;
      fetching = true;
      let delay = 3000;
      try {
        const url = new URL(location.href);
        url.searchParams.set('format', 'json');
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('status');
        render(await response.json());
      } catch {
        el('state').textContent = '暂时无法更新';
        el('message').hidden = false;
        el('message').textContent = '请检查网络连接，5 秒后将自动重试。';
        el('live').classList.add('failed');
        el('live-text').textContent = '连接中断';
        delay = 5000;
      } finally {
        fetching = false;
        if (!document.hidden && !finished) timer = setTimeout(refresh, delay);
      }
    }
    document.addEventListener('visibilitychange', () => {
      clearTimeout(timer);
      if (!document.hidden) refresh();
    });
    refresh();
  </script>
</body>
</html>`;
}

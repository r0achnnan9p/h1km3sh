// Keep these nodes attached when refreshing the library so a playing video is not restarted.
export function createOutputPlayers({ document = globalThis.document, resolveUrl = value => value, onNotice = () => {}, onPlay = () => {}, onOpen = null } = {}) {
  const entries = new Map();
  const pauseAll = except => { for (const entry of entries.values()) if (entry.element !== except) entry.pause(); };

  function create(file) {
    let currentFile = file;
    let source = resolveUrl(file.streamUrl), expanded = false, loaded = false, disposed = false;
    let wantsPlay = false, request = 0, phase = 'idle', resumeAt = 0;
    const listeners = [];
    const element = document.createElement('section'); element.className = 'output-preview';
    const surface = document.createElement('div'); surface.className = 'output-preview-surface';
    const video = document.createElement('video'); video.className = 'output-player';
    video.controls = true; video.playsInline = true; video.preload = 'none'; video.hidden = true;
    video.defaultMuted = true; video.muted = true;
    video.setAttribute('webkit-playsinline', '');
    const poster = document.createElement('button'); poster.type = 'button'; poster.className = 'output-poster';
    const thumbnail = document.createElement('img'); thumbnail.className = 'output-thumbnail';
    thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.decoding = 'async'; thumbnail.dataset.loaded = 'false';
    let thumbnailSource = '';
    const icon = document.createElement('span'); icon.className = 'output-poster-icon'; icon.setAttribute('aria-hidden', 'true');
    poster.append(thumbnail, icon);
    const duration = document.createElement('span'); duration.className = 'output-duration mono'; duration.textContent = '--:--';
    surface.append(video, poster, duration);
    const toolbar = document.createElement('div'); toolbar.className = 'output-player-controls'; toolbar.hidden = true;
    toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '成片播放控制');
    function listen(target, type, handler) { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)); }
    function button(label, className, action) {
      const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label;
      listen(node, 'click', action); toolbar.append(node); return node;
    }
    const toggle = button('播放', 'primary-button output-play-toggle', () => wantsPlay || !video.paused ? pause() : play());
    const backward = button('−10 秒', 'quiet-button', () => seek(-10)); backward.setAttribute('aria-label', '后退 10 秒');
    const forward = button('+10 秒', 'quiet-button', () => seek(10)); forward.setAttribute('aria-label', '前进 10 秒');
    const fullscreen = button('全屏', 'quiet-button', async () => {
      try {
        if (document.fullscreenElement === element && document.exitFullscreen) await document.exitFullscreen();
        else if (element.requestFullscreen) await element.requestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else onNotice('请使用视频播放器中的全屏按钮。');
      } catch { onNotice('暂时无法进入全屏，可使用视频播放器中的全屏按钮。'); }
    });
    const collapse = button('收起', 'quiet-button output-collapse', async () => {
      if (collapse.disabled) return;
      collapse.disabled = true; pause();
      try {
        // Keep controls visible until fullscreen exits; hiding them first strands
        // the user on a fullscreen poster with no visible exit action.
        if (document.fullscreenElement === element && document.exitFullscreen) await document.exitFullscreen();
        else if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen();
        if (!disposed) { expanded = false; render(); poster.focus(); }
      } catch { onNotice('请先退出全屏，再收起视频。'); }
      finally { collapse.disabled = false; }
    });
    const caption = document.createElement('div'); caption.className = 'output-player-caption';
    const time = document.createElement('span'); time.className = 'output-player-time';
    const status = document.createElement('span'); status.className = 'output-player-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'quiet-button output-player-retry'; retry.textContent = '重试播放'; retry.hidden = true;
    caption.append(time, status, retry); element.append(surface, toolbar, caption);

    function setPhase(next, message = '') {
      phase = next;
      status.textContent = message || ({ idle: '', loading: '正在载入视频…', playing: '正在播放', paused: '已暂停', ended: '播放结束', error: '视频暂时无法播放，请重试。' }[next]);
      render();
    }
    function render() {
      duration.textContent = Number.isFinite(video.duration) ? formatTime(video.duration) : '--:--';
      element.dataset.state = phase; element.dataset.expanded = String(expanded);
      element.setAttribute('aria-busy', String(phase === 'loading'));
      video.hidden = !expanded; poster.hidden = expanded; toolbar.hidden = !expanded;
      poster.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = wantsPlay || !video.paused ? '暂停' : video.ended ? '重播' : '播放';
      toggle.setAttribute('aria-label', `${toggle.textContent}成片`);
      backward.disabled = forward.disabled = !loaded || !Number.isFinite(video.duration) || video.duration <= 0 || phase === 'error';
      retry.hidden = phase !== 'error'; time.hidden = !expanded;
      caption.hidden = !expanded && phase !== 'error';
      time.textContent = `${formatTime(video.currentTime)} / ${Number.isFinite(video.duration) ? formatTime(video.duration) : '--:--'}`;
      fullscreen.textContent = document.fullscreenElement === element ? '退出全屏' : '全屏';
      collapse.setAttribute('aria-label', '收起并暂停成片');
    }
    function pause() {
      wantsPlay = false; request++;
      video.pause();
      if (!disposed && phase !== 'error') setPhase(loaded ? 'paused' : 'idle');
    }
    function ensureSource() {
      if (loaded) return;
      loaded = true; video.src = source; video.load();
    }
    async function play() {
      if (disposed) return;
      expanded = true; wantsPlay = true;
      const current = ++request;
      pauseAll(element); onPlay(video);
      setPhase('loading');
      try {
        ensureSource();
        if (video.ended) video.currentTime = 0;
        await video.play();
        if (disposed || !wantsPlay) { video.pause(); return; }
        if (current === request && !video.paused) setPhase('playing');
      } catch (error) {
        if (disposed || current !== request || !wantsPlay) return;
        wantsPlay = false;
        if (error?.name === 'NotAllowedError') setPhase('paused', '请点视频播放器中的播放键继续。');
        else if (error?.name === 'AbortError') setPhase('paused', '播放已中断，请再次播放。');
        else setPhase('error');
      }
    }
    function seek(seconds) {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !loaded || phase === 'error') return;
      try { video.currentTime = Math.max(0, Math.min(video.duration, (Number(video.currentTime) || 0) + seconds)); render(); }
      catch { onNotice('视频尚未准备好，请稍后再跳转。'); }
    }
    listen(thumbnail, 'load', () => { thumbnail.dataset.loaded = 'true'; });
    listen(thumbnail, 'error', () => { thumbnail.dataset.loaded = 'false'; });
    listen(poster, 'click', () => onOpen?.(currentFile, element) === true ? undefined : play());
    listen(retry, 'click', () => {
      resumeAt = Math.max(0, Number(video.currentTime) || 0);
      loaded = false; play();
    });
    listen(video, 'play', () => { wantsPlay = true; pauseAll(element); onPlay(video); render(); });
    listen(video, 'playing', () => { if (!video.paused) { wantsPlay = true; setPhase('playing'); } });
    listen(video, 'pause', () => {
      if (!video.paused) return;
      wantsPlay = false; request++;
      if (phase !== 'error') setPhase(video.ended ? 'ended' : loaded ? 'paused' : 'idle');
    });
    listen(video, 'waiting', () => { if (wantsPlay && !video.paused) setPhase('loading', '正在缓冲…'); });
    listen(video, 'loadedmetadata', () => {
      if (resumeAt > 0 && Number.isFinite(video.duration)) {
        try { video.currentTime = Math.min(resumeAt, video.duration); } catch { /* Native controls remain usable if this file cannot seek yet. */ }
        resumeAt = 0;
      }
      render();
    });
    for (const event of ['durationchange', 'timeupdate']) listen(video, event, render);
    listen(video, 'ended', () => { wantsPlay = false; request++; setPhase('ended'); });
    listen(video, 'error', () => { wantsPlay = false; request++; video.pause(); setPhase('error'); });
    listen(document, 'fullscreenchange', render);
    function update(next) {
      currentFile = next;
      const nextThumbnail = next.thumbnailUrl ? resolveUrl(next.thumbnailUrl) : '';
      if (thumbnailSource !== nextThumbnail) {
        thumbnailSource = nextThumbnail; thumbnail.dataset.loaded = 'false';
        if (nextThumbnail) thumbnail.src = nextThumbnail; else thumbnail.removeAttribute('src');
      }
      const nextSource = resolveUrl(next.streamUrl);
      if (source !== nextSource) {
        pause(); source = nextSource; loaded = false; resumeAt = 0; expanded = false;
        video.muted = true;
        video.removeAttribute('src'); video.load(); setPhase('idle');
      }
      element.setAttribute('aria-label', `${next.filename} · 成片预览`);
      video.setAttribute('aria-label', next.filename);
      poster.setAttribute('aria-label', `播放成片：${next.filename}`);
    }
    function destroy() {
      disposed = true; wantsPlay = false; request++;
      for (const remove of listeners) remove();
      thumbnail.removeAttribute('src'); video.pause(); video.removeAttribute('src'); video.load(); element.remove();
    }
    update(file); setPhase('idle');
    return { element, pause, update, destroy };
  }
  return {
    get(file) {
      const key = String(file.id);
      if (!entries.has(key)) entries.set(key, create(file));
      else entries.get(key).update(file);
      return entries.get(key).element;
    },
    retain(ids) {
      const keep = new Set(Array.from(ids, String));
      for (const [id, entry] of entries) if (!keep.has(id)) { entry.destroy(); entries.delete(id); }
    },
    pause(id) { entries.get(String(id))?.pause(); },
    pauseAll() { pauseAll(); },
    destroy() { for (const entry of entries.values()) entry.destroy(); entries.clear(); },
  };
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

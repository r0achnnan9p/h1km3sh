import { iconSvg } from '../public/ui-primitives.js';
/** 公网受保护录像控制台的 HTML 外壳；交互脚本与样式通过独立白名单路径加载。 */
// 设置首页的一行：图标 + 名称 + 数值 + 状态图标 + 右箭头；点击由 console.js 按 data-settings-open 打开二级视图。
const settingsItem = (key, icon, label, { hidden = false } = {}) => `<button class="settings-item" id="settings-open-${key}" type="button" data-settings-open="${key}"${hidden ? ' hidden' : ''}><span class="settings-item-icon" aria-hidden="true">${iconSvg(icon)}</span><span class="settings-item-name">${label}</span><span class="settings-item-value mono" id="settings-value-${key}" hidden></span><span class="settings-item-status" id="settings-status-${key}" role="img" hidden></span><span class="settings-item-chevron" aria-hidden="true">${iconSvg('chevron')}</span></button>`;
const appReloadButton = () => `<button class="quiet-button ui-icon-button app-reload" type="button" data-app-reload aria-label="重新加载应用" title="重新加载应用">${iconSvg('reload')}</button>`;
export function statusDashboardPage(basePath = '') {
  const appPath = value => `${basePath}${value.startsWith('/') ? value : `/${value}`}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <meta name="theme-color" content="#070d14">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="H1kM3sh">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <link rel="apple-touch-icon" sizes="180x180" href="${appPath('/apple-touch-icon-v2.png')}">
  <link rel="icon" type="image/png" sizes="192x192" href="${appPath('/console-icon-v2-192.png')}">
  <link rel="icon" type="image/svg+xml" href="${appPath('/console-icon-v2.svg')}">
  <link rel="manifest" href="${appPath('/site-v2.webmanifest')}">
  <title>H1kM3sh</title>
  <link rel="stylesheet" href="${appPath('/touch-controls.css')}">
  <link rel="stylesheet" href="${appPath('/console.css')}">
  <script type="module" src="${appPath('/console.js')}"></script>
</head>
<body class="console-app precision-layout">
  <div class="status-bar-background" aria-hidden="true"></div>
  <a class="skip-link" href="#workspace-content">跳到内容</a>
  <main>
    <section class="auth-wrap" id="boot-view" role="status" aria-live="polite">
      <div class="auth-card boot-card">
        <h1>正在打开控制台</h1>
        <p class="auth-copy" id="boot-copy">检查已保存的登录状态…</p>
        <div class="boot-loading" id="boot-loading"><span class="boot-spinner" aria-hidden="true"></span><span>正在安全连接</span></div>
        <p class="auth-error" id="boot-error" hidden></p>
        <button class="secondary-button full" id="boot-retry" type="button" hidden>重新连接</button>
      </div>
    </section>

    <section class="auth-wrap" id="auth-view" hidden>
      <div class="auth-card">
        <div class="auth-emblem" aria-hidden="true"><img src="${appPath('/console-icon-v2.svg')}" width="48" height="48" alt=""></div><p class="auth-eyebrow">H1kM3sh</p>
        <h1 id="auth-title">进入录像控制台</h1>
        <p class="auth-copy" id="auth-copy">查看回放、管理成片与上传任务。</p>
        <form id="login-form" hidden>
          <label for="login-password">访问密码</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required placeholder="输入控制台密码">
          <button class="primary-button full" type="submit">解锁控制台 <span>↗</span></button>
        </form>
        <form id="setup-form" hidden>
          <label for="setup-code">一次性初始化码</label>
          <input id="setup-code" name="code" type="password" autocomplete="one-time-code" required placeholder="在服务器命令行生成">
          <label for="setup-password">设置新密码</label>
          <input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="至少 8 个字符">
          <button class="primary-button full" type="submit">设定密码 <span>↗</span></button>
        </form>
        <p class="auth-error" id="auth-error" aria-live="polite"></p>
        <p class="auth-foot" id="setup-note" hidden>初始化码由服务器本机命令生成，有效期 30 分钟，只能使用一次。</p>
      </div>
    </section>

    <div class="console-shell" id="console-shell" hidden>
      <aside class="side-nav" aria-label="控制台导航">
        <a class="workspace-brand" href="#replay" aria-label="H1kM3sh" title="H1kM3sh"><img class="workspace-logo" src="${appPath('/console-icon-v2.svg')}" width="34" height="34" alt="" aria-hidden="true"></a>
        <button class="nav-item active" data-view="replay" type="button" aria-label="回放" title="回放"><span class="nav-icon" aria-hidden="true">${iconSvg('nav-replay')}</span></button>
        <button class="nav-item" data-view="library" type="button" aria-label="成片" title="成片"><span class="nav-icon" aria-hidden="true">${iconSvg('nav-library')}</span><span class="nav-count" id="output-count" hidden>0</span></button>
        <button class="nav-item" data-view="tasks" type="button" aria-label="任务" title="任务"><span class="nav-icon" aria-hidden="true">${iconSvg('nav-tasks')}</span><span class="nav-task-count" data-task-count hidden aria-hidden="true">0</span></button>
        <button class="nav-item" data-view="settings" type="button" aria-label="设置" title="设置"><span class="nav-icon" aria-hidden="true">${iconSvg('nav-settings')}</span></button>

      </aside>

      <div class="workspace-main">
      <div class="views" id="workspace-content" tabindex="-1"><header class="app-header" id="app-title"><span>H1kM3sh</span>${appReloadButton()}</header><div class="connection-banner" id="connection-banner" role="status" hidden>连接中断，正在自动重连。显示的是上次收到的状态。</div>
        <section class="view active focus-replay" id="view-replay" data-panel="replay" data-replay-mode="select" data-chrome-idle="false">
          <div class="page-heading replay-heading replay-topbar">
            <span class="date-clock" id="wall-clock" hidden>--:--:--</span>
            <div class="playback-quick-controls">
              <select id="quick-source-select" aria-label="选择录像来源和录像机"></select>
              <select id="quick-camera-select" aria-label="切换镜头"></select>
              <div class="replay-date-controls">
                <button class="quiet-button day-step previous" id="previous-day" type="button" aria-label="前一天" title="前一天">${iconSvg('chevron')}</button>
                <button class="playback-context" id="playback-context" type="button" aria-haspopup="dialog" aria-label="选择日期">${iconSvg('calendar')}<span id="playback-context-date">日期</span></button>
                <button class="quiet-button day-step" id="next-day" type="button" disabled aria-label="后一天" title="后一天">${iconSvg('chevron')}</button>
              </div>
            </div>
          </div>
          <div class="legacy-replay-toolbar" id="playback-toolbar" hidden inert>
            <label class="field compact source-field"><span>回放来源</span><select id="playback-source" aria-label="选择录像来源"><option value="mediamtx">MediaMTX</option><option value="dvr">海康 DVR 回放</option></select></label>
            <label class="field compact date-field"><span>日期</span><input id="date-select" type="date" aria-label="选择回放日期"></label>
            <label class="field compact" id="mediamtx-channel-field"><span>通道</span><select id="camera-select" aria-label="选择 MediaMTX 通道"></select></label>
            <button class="quiet-button refresh-button" id="load-recordings" type="button">载入录像 <span>↻</span></button>
            <div class="dvr-controls" id="dvr-controls" hidden>
              <label class="field compact"><span>录像机</span><select id="dvr-select" aria-label="选择海康录像机"></select></label>
              <label class="field compact"><span>通道</span><select id="dvr-channel" aria-label="选择 DVR 通道"></select></label>
              <p id="dvr-help" role="status" aria-live="polite">选择录像机和通道后查询海康录像。</p>
            </div>
          </div>
          <div class="player-panel replay-workspace">
            <div class="replay-editor">
              <div class="video-card panel">
                <div class="player-wrap" id="player-wrap">
              <div class="video-status" id="video-status" hidden><span data-state="live" aria-hidden="true">${iconSvg('mediamtx')}</span><span data-state="replay" aria-hidden="true">${iconSvg('play')}</span><span data-state="paused" aria-hidden="true">${iconSvg('pause')}</span><span data-state="waiting" aria-hidden="true">${iconSvg('refresh')}</span><span data-state="ended" aria-hidden="true">${iconSvg('pause')}</span><span data-state="error" aria-hidden="true">${iconSvg('warning')}</span><span class="sr-only" id="player-time-label" role="status">—</span></div>
                  <button class="player-toggle legacy-playback-toggle" id="playback-toggle" type="button" aria-label="播放" aria-pressed="false" tabindex="-1" hidden inert>
                    <span class="play-mark">${iconSvg('play')}</span><span class="pause-mark">${iconSvg('pause')}</span><span id="playback-toggle-label" class="sr-only">播放</span>
                  </button>
                  <video id="replay-player" muted playsinline webkit-playsinline preload="metadata" hidden></video>
                  <div class="player-placeholder" id="player-placeholder" aria-hidden="true"></div>
                </div>
              </div>
              <div class="replay-control-panel" id="replay-control-panel">
                <div class="timeline-section panel">
                  <div class="replay-toolbar" id="replay-transport">
                    <div class="transport-buttons">
                      <button class="quiet-button" id="skip-back" type="button" aria-label="后退 10 秒，长按连续后退" title="后退 10 秒，长按连续后退">${iconSvg('skip-back')}</button>
                      <button class="quiet-button" id="transport-toggle" type="button" aria-label="播放回放" aria-pressed="false" title="播放回放">${iconSvg('play')}</button>
                      <button class="quiet-button" id="skip-forward" type="button" aria-label="前进 10 秒，长按连续前进" title="前进 10 秒，长按连续前进">${iconSvg('skip-forward')}</button>
                    </div>
                    <button id="timeline-time-editor" class="timeline-time-editor" type="button" aria-label="输入精确定位时间" title="输入精确定位时间"><time id="timeline-current-time" class="mono">--:--:--</time></button>
                    <div class="replay-media-tools">
                      <button id="go-live" class="quiet-button" type="button" aria-label="回到直播" title="回到直播" aria-pressed="false" hidden>${iconSvg('live-edge')}</button>
                      <button class="quiet-button" id="playback-mute" type="button" aria-label="开启声音" aria-pressed="false" title="开启声音" hidden>${iconSvg('volume-off')}</button>
                      <button id="replay-fullscreen" class="quiet-button" type="button" aria-label="全屏回放" title="全屏回放">${iconSvg('fullscreen')}</button>
                    </div>
                  </div>
                  <div class="legacy-timeline-metadata" hidden inert>
                    <div class="timeline-zoom" role="group" aria-label="时间轴缩放"><button class="quiet-button zoom-button" type="button" data-timeline-span="30" aria-pressed="false">30s</button><button class="quiet-button zoom-button" type="button" data-timeline-span="300" aria-pressed="false">5m</button><button class="quiet-button zoom-button" type="button" data-timeline-span="3600" aria-pressed="false">1h</button><button class="quiet-button zoom-button" type="button" data-timeline-span="86400" aria-pressed="false">24h</button></div>
                    <span id="segment-caption">选择日期与通道</span><span id="overview-time-readout"></span>
                    <button id="fine-back" type="button" tabindex="-1" aria-label="后退 1 秒">${iconSvg('chevron')}</button><button id="fine-forward" type="button" tabindex="-1" aria-label="前进 1 秒">${iconSvg('chevron')}</button>
                  </div>
              <div class="precision-track-host"><div class="overview-scroll"><div class="timeline-overview" id="timeline-overview" role="slider" aria-label="全天录像概览；拖动定位，远离轨道可精调，左右键微调1秒，Shift微调10秒" aria-valuemin="0" aria-valuemax="86400" tabindex="0">
                <div class="overview-ruler" aria-hidden="true">${Array.from({ length: 49 }, (_, i) => `<span class="overview-tick${i % 12 === 0 ? ' major' : i % 2 === 0 ? ' hour' : ''}" style="left:${i / 48 * 100}%">${i % 12 === 0 ? `<small>${String(i / 2).padStart(2, '0')}</small>` : ''}</span>`).join('')}</div>
                <div class="overview-segments" id="overview-segments"></div>
                <div class="overview-selection" id="overview-selection" hidden></div>
                <div class="overview-window" id="overview-window"></div>
                <div class="overview-cursor" id="overview-cursor" hidden></div>
              </div></div>
              <div class="timeline-scroll" inert aria-hidden="true"><div class="timeline" id="timeline" role="group" aria-label="精细录像时间轴；拖动时间窗口，中心为所选时间，左右键微调1秒，Shift加左右键微调10秒" tabindex="0"><div id="timeline-ruler" class="timeline-ruler" aria-hidden="true"></div><div id="timeline-hover" class="timeline-hover" aria-hidden="true" hidden><span></span></div><div class="timeline-empty">尚未载入录像</div><div class="time-cursor" id="time-cursor" hidden></div><div class="range-overlay" id="range-overlay" hidden></div><button class="boundary-handle" id="boundary-in" data-boundary="in" type="button" role="slider" aria-label="开始时间；左右键微调1秒，Shift微调10秒" aria-valuemin="0" aria-valuemax="86400" hidden><span>${iconSvg('mark-in')}</span></button><button class="boundary-handle end" id="boundary-out" data-boundary="out" type="button" role="slider" aria-label="结束时间；左右键微调1秒，Shift微调10秒" aria-valuemin="0" aria-valuemax="86400" hidden><span>${iconSvg('mark-out')}</span></button></div></div>

              </div><div class="time-labels"><span id="timeline-start-label">00:00</span><span id="timeline-middle-label">03:00</span><span id="timeline-end-label">06:00</span></div>
                  <div class="replay-mode-switch" role="group" aria-label="回放操作模式">
                    <button id="replay-mode-watch" type="button" aria-pressed="false" aria-controls="replay-selection-editor">观看</button>
                    <button id="replay-mode-select" type="button" aria-pressed="true" aria-controls="replay-selection-editor">选段</button>
                  </div>
                  <button class="quiet-button" id="retry-recordings" type="button" hidden>重试载入录像</button><p class="notice-line" id="playback-notice" aria-live="polite"></p>
                </div>
                <div class="selection-panel panel replay-selection-editor" id="replay-selection-editor" role="group" aria-label="选段与导出">
                  <div class="mark-controls">
                    <div class="mark-field">
                      <button class="secondary-button" id="mark-in" type="button" aria-label="设置入点，将当前位置标记为入点">${iconSvg('mark-in')}<span>入点</span><span id="mark-in-time" class="sr-only">--:--:--</span></button>
                      <button id="edit-in" class="boundary-editor" type="button" aria-label="输入入点时间" title="输入入点时间" aria-haspopup="dialog"><span id="boundary-in-time" class="mono">--:--:--</span></button>
                    </div>
                    <div class="mark-field">
                      <button class="secondary-button" id="mark-out" type="button" aria-label="设置出点，将当前位置标记为出点">${iconSvg('mark-out')}<span>出点</span><span id="mark-out-time" class="sr-only">--:--:--</span></button>
                      <button id="edit-out" class="boundary-editor" type="button" aria-label="输入出点时间" title="输入出点时间" aria-haspopup="dialog"><span id="boundary-out-time" class="mono">--:--:--</span></button>
                    </div>
                  </div>
                  <div hidden><span id="selection-status">未选择</span><span id="selection-readout"></span></div>
                  <p class="selection-help" id="selection-help" role="status" aria-live="polite" hidden></p>
                  <div class="replay-actions range-controls">
                    <span class="clip-duration" aria-label="选段持续时间">${iconSvg('clock')}<span id="selection-duration" class="mono">0:00</span></span>
                    <button class="quiet-button" id="clear-marks" type="button" aria-label="清除入点和出点" disabled>${iconSvg('clear')}<span>清除</span></button>
                    <button class="quiet-button" id="cancel-export" type="button" aria-label="取消提交等待" hidden>取消</button>
                    <button class="primary-button" id="export-range" type="button" aria-describedby="selection-help" aria-label="导出选中片段" disabled>${iconSvg('download')}<span>导出</span></button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="view" id="view-library" data-panel="library">
          <div class="page-heading"><div><h1>成片</h1></div>${appReloadButton()}</div>
          <div class="library-tools"><label class="field library-search">${iconSvg('search')}<input id="output-search" type="search" aria-label="查找成片" placeholder="搜索" autocomplete="off"></label><div class="field library-sort"><button id="output-sort" class="quiet-button ui-icon-button" type="button" data-order="newest" aria-label="成片排序：最新在前，点击切换为最早在前" title="成片排序：最新在前，点击切换为最早在前">${iconSvg('sort-newest')}</button></div></div><div class="library-summary"><span id="library-summary">读取本地已完成视频</span><span class="mono" id="library-size"></span></div>
          <div class="library-scroll" id="library-scroll"><div class="output-grid" id="output-list"><div class="empty-card">正在读取成片…</div></div><div class="task-feed-sentinel" id="output-sentinel" aria-hidden="true" hidden></div></div>
        </section>

        <section class="view" id="view-tasks" data-panel="tasks">
          <div class="page-heading"><div><h1>任务</h1></div>${appReloadButton()}</div>
          <div class="task-tabs glass" role="tablist" aria-label="任务类型">
            <button type="button" id="task-tab-export" role="tab" aria-selected="true" aria-controls="task-export-panel">${iconSvg('download')}<span>导出</span><span id="export-task-count" class="task-tab-count" hidden>0</span></button>
            <button type="button" id="task-tab-upload" role="tab" aria-selected="false" aria-controls="task-upload-panel" tabindex="-1">${iconSvg('cloud')}<span>上传</span><span id="upload-task-count" class="task-tab-count" hidden>0</span></button>
          </div>
          <div class="task-panels">
            <div id="task-export-panel" class="task-scroll" role="tabpanel" aria-labelledby="task-tab-export" tabindex="0"><h2 class="desktop-task-title">导出</h2><div class="task-list" id="task-list"></div><div class="task-sentinel" id="task-export-sentinel"></div></div>
            <div id="task-upload-panel" class="task-scroll" role="tabpanel" aria-labelledby="task-tab-upload" tabindex="0" hidden><h2 class="desktop-task-title">上传</h2><div class="task-list" id="upload-list"></div><div class="task-sentinel" id="task-upload-sentinel"></div></div>
          </div>
        </section>

        <section class="view" id="view-settings" data-panel="settings">
          <div class="page-heading settings-heading"><div><h1>设置</h1></div>${appReloadButton()}</div>
          <p id="config-preparation" class="config-notice" role="status" hidden>当前为准备模式，只读查看。请在服务器本机将 HIKCLIP_PREPARATION_ONLY 设为 0 后开放配置；此页面不会修改环境配置。</p>
          <p id="config-message" class="inline-message" role="status" aria-live="polite"></p>
          <div class="settings-groups" id="config-title">
            <h2 class="settings-group-label">来源</h2><section class="settings-group" aria-label="来源">
              ${settingsItem('dvr', 'dvr', '海康录像机')}
              ${settingsItem('mediamtx', 'mediamtx', 'MediaMTX')}
            </section>
            <h2 class="settings-group-label">上传账户</h2><section class="settings-group" aria-label="上传账户">
              ${settingsItem('cloud189', 'cloud189', '189')}
              ${settingsItem('bilibili', 'tv', 'B站')}
            </section>
            <h2 class="settings-group-label">存储</h2><section class="settings-group" aria-label="缓存">
              <div class="settings-item settings-item-static" id="settings-cache"><span class="settings-item-icon" aria-hidden="true">${iconSvg('disk')}</span><span class="settings-item-name">缓存</span><span class="settings-item-value mono" id="cache-size">—</span><button class="settings-item-action" id="clear-cache" type="button" aria-label="清理完整缓存" title="清理完整缓存">${iconSvg('trash')}</button></div>
            </section>
            <h2 class="settings-group-label">安全</h2><section class="settings-group" aria-label="账户">
              ${settingsItem('password', 'key', '密码', { hidden: true })}
              <button class="settings-item settings-item-danger" id="logout" type="button" aria-label="退出登录" title="退出登录" hidden><span class="settings-item-icon" aria-hidden="true">${iconSvg('logout')}</span><span class="settings-item-name">退出登录</span></button>
            </section>
          </div>

          <section id="settings-desktop-detail" class="settings-desktop-detail" aria-label="设置详情"></section>

          <!-- 二级视图的内容在这里待命：打开时由 console.js 整体搬进 openDialog，关闭后放回，id 与事件监听保持不变。 -->
          <div id="settings-detail-store" hidden>
            <section class="settings-detail" id="password-card" aria-label="访问密码" hidden>
              <p class="setting-help" id="password-help">更新后需重新登录。密码哈希保存在服务器。</p>
              <form class="settings-form" id="password-form"><label>当前密码<input id="current-password" type="password" autocomplete="current-password" required></label><label>新密码<input id="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label><button class="secondary-button" type="submit">更新密码</button><span class="inline-message" id="password-message"></span></form>
            </section>
            <article class="settings-detail" id="settings-cloud189" tabindex="-1" aria-label="189">
              <div class="setting-head"><div><p id="cloud-status" role="status">正在检测…</p></div><span class="status-pill" id="cloud-pill">检测中</span></div>
              <div class="account-connection" id="upload-account-cloud189"></div>
              <p class="setting-help" id="cloud-target-path">上传目录：/H1kM3sh</p>
            </article>
            <article class="settings-detail integrations" id="settings-bilibili" tabindex="-1" aria-label="B站">
              <div class="setting-head"><div><p id="bili-status" role="status">正在检测…</p></div><span class="status-pill" id="bili-pill">检测中</span></div>
              <div class="account-connection" id="upload-account-bilibili"></div>
              <p class="setting-help" id="bili-fixed-settings">体育运动 · 足球 · 仅自己可见</p>
              <div class="cover-setting"><h3>默认封面</h3><p class="setting-help" id="cover-status">正在读取封面…</p><img id="cover-preview" alt="默认投稿封面预览" hidden>
                <form class="settings-form" id="cover-form"><div id="cover-dropzone" class="cover-dropzone"><p id="cover-drop-help">拖入图片，或选择文件</p><label>选择封面图片<input id="bili-cover-file" type="file" accept="image/png,image/jpeg" aria-describedby="cover-drop-help"></label></div><p class="setting-help">PNG / JPEG，最大 5 MB</p><button class="secondary-button" id="cover-save" type="submit" disabled>上传并保存封面</button><span class="inline-message" id="cover-message" role="status" aria-live="polite"></span></form>
              </div>
            </article>
          </div>
        </section>

      </div></div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="控制台导航" hidden>
    <button class="active" data-view="replay" type="button" aria-label="回放" title="回放"><span aria-hidden="true">${iconSvg('nav-replay')}</span></button><button data-view="library" type="button" aria-label="成片" title="成片"><span aria-hidden="true">${iconSvg('nav-library')}</span></button><button data-view="tasks" type="button" aria-label="任务" title="任务"><span aria-hidden="true">${iconSvg('nav-tasks')}</span><span class="nav-task-count" data-task-count hidden aria-hidden="true">0</span></button><button data-view="settings" type="button" aria-label="设置" title="设置"><span aria-hidden="true">${iconSvg('nav-settings')}</span></button>
  </nav>
    </div>
  </main>
  <div id="replay-overlays">
  <div class="scrub-time-overlay" id="scrub-time-overlay" aria-hidden="true" aria-live="off">
    <time class="scrub-time-value" id="scrub-time-value">00:00:00</time>
    <span class="scrub-date-value" id="scrub-date-value">拖动时间轴定位</span>
  </div>
  <div id="trim-magnifier" class="trim-magnifier glass-prompt" hidden aria-hidden="true"><div class="magnifier-ruler"></div><span id="trim-magnifier-seconds" class="magnifier-seconds mono"></span><time id="trim-magnifier-time" class="mono"></time></div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
</body>
</html>`;
}


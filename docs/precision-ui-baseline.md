# Precision UI implementation baseline — 2026-10-08

## Approved source and scope

This document records the interaction baseline. It is not proof of production playback, accessibility or device QA.

Implement in the existing vanilla console. Do not import the prototype's React
phone simulator, generated pitch poster, synthetic tasks/accounts, timers or API
substitutes. Preserve real MediaMTX/DVR playback, single export pipeline, queue
idempotency, credentials boundaries, upload state reconciliation and recovery.

## Interaction decisions

- Standalone PWA is primary on iPhone and desktop. iPhone 14 Pro Max home must fit
  video, timeline, marks, transport, export and navigation after real safe insets.
- Keep all four application routes: replay, library, tasks, settings.
- One persistent 24-hour overview, no persistent 30s/5m/1h/24h button group.
- Touch captures on the timeline only. Horizontal movement coarsely selects a
  time. Vertical distance decreases horizontal gain and reveals a local ruler,
  down to a 30-second span. Vertical-only motion must not move time.
- Release commits the last visible position once. Cancel/visibility loss/source
  change restores or invalidates the gesture; never issue a second media request
  from pointerup coordinates. Do not request a new DVR stream for every move.
- Precise time-entry remains available; fullscreen has single-second adjustment.
  Selecting a second is not a promise of frame accuracy from every DVR codec.
- No visible dragging instruction, speed/mode labels. Keep time numbers, ticks,
  visual feedback and accessible labels.
- Transport order: previous-day icon, double-left-chevron (10 seconds),
  play/pause, double-right-chevron (10 seconds), next-day icon. No visible10.
- Separate in/out controls with clear boundaries and selected feedback.
- Return-to-live has a latest-position icon, appears only outside live mode.
- Fullscreen expands the player and overlays controls; landscape keeps timeline
  and marks accessible. Controls fade only when idle, never during a gesture,
  keyboard focus, open sheet or pending operation.
- Held-touch navigation previews the selection and activates on valid release.
  Reduced-motion users get no nonessential transitions.

## Acceptance

Q team: Codex luna6 high, Product Design UX Audit, and Design QA against captured
approved source where available. No screenshots means blocked, not passed.
Real iPhone standalone cold start, keyboard, portrait/landscape and native-video
API differences require explicit device evidence. Automatic geometry tests and
synthetic browser fixtures do not replace a real video seek/export check.

Existing Parts6–8 work remains uncommitted and must be reconciled and reviewed as
one explicit candidate. No compatibility or migration assumptions from OA apply.

## Implementation checkpoint (2026-10-08)

- Main transport stays in five fixed columns across live/loading/replay states.
  Seek buttons are disabled in live mode; the central button can start a selected
  recording even before a video source is attached. Date buttons use the existing
  date-change handler and never advance past today.
- Fullscreen uses the existing video and timeline nodes, not a second player.
  Native and CSS-fallback entry/exit cancel active or queued scrub commits.
  Fullscreen replaces day stepping with single-second stepping. In/out remains
  available in the shared overlay. The image itself retains its aspect ratio.
- Controls reveal on editor pointer activity. Gestures, open sheets, pending work
  and keyboard focus prevent idle fade. Reduced-motion disables the transition.
- Short fullscreen windows may scroll inside the control panel when error/retry
  content needs more height; the player and application background remain fixed.
- Browser startup is blocked in the current cloud shell (Chromium SIGABRT).
  Static CSS review and Node checks do not establish device geometry or visual QA.

## 浏览器对照与施工检查点（2026-10-09）

- 本轮在 Windows 的独立工作树从 `e39b3d76dd1fbdde317749fe5283094dd59c5995` 施工；不覆盖原工作目录的并行改动。前一检查点的 cloud shell 浏览器限制是历史记录，本轮已实际访问 Chrome 原型及内置浏览器的线上、本地页面。
- `docs/design/*.png` 在该基线中缺失。本轮视觉证据来自已登录交互原型截图，不能把文档中的 PNG 引用当作已取得的视觉稿。线上已登录页面用于发现现状差距，不作为视觉目标；其部署 SHA 未确认。
- 手机回放顺序为时间、全天刻度/录像段、五项传输、入出点、时长/清除/导出。视频内四角为播放、最新位置、声音和全屏。点时间打开精确定位，可继续进入已有选段编辑；定位不清除已有标记。
- 垂直离开时间轴仅显示精调标尺，保留原时间；横向超过阈值才调整，释放只提交最后可见时间一次。诊断 HUD 的五连点改到产品标题，避免占用时间输入入口。
- 用户指出底部 Tab 条仍不一致后，按原型改为手机贴底通栏：背景承接安全区、无外侧间隙或外圆角，选中项为圆角矩形与下划线。四项使用从已观察原型提取的 Radix 图标，保留现有拖动释放切页、键盘和任务角标行为。复用已登记 Token，不新增颜色、圆角或阴影 Token。
- 手机成片、设置、历史任务使用透明分隔行，任务页签使用下划线；活动任务、真实错误、待核实与配置弹层保留现有业务状态。桌面按已有整屏规格施工，原型没有桌面视觉。
- 本地浏览器用合成视频验证交互；不把演示任务、账户、录像段移入生产。真 iPhone 独立 PWA、原生视频与 NVR 精确定位/导出仍需设备验证。历史本地验收证据不包含在本源码快照中；请自行执行并记录验证。

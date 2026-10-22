# AGENTS.md

本文件是编码代理在本仓库工作的**入口 + 铁律**，刻意保持精简。架构细节、真机实测结论和已知技术债按任务读取 [docs/developer-reference.md](docs/developer-reference.md)，不要把按需参考重新堆回根指令。

## 项目

海康威视 DVR/NVR 录像精准提取工具。Express 后端 + 原生单页前端，通过海康 ISAPI / RTSP 拉取指定时间段录像并导出 MP4，支持时间轴预览、Mark In/Out、缓存复用、断点续传、实时进度、定时导出和 MCP 接入。

## 工作方式与范围

- 先读当前代码、真实 diff、测试和运行结果，再下结论；文档描述与代码冲突时先核实事实，不把旧说明当实现真相。
- 以用户本次要求为任务边界。`docs/developer-reference.md` 的 Known Tech Debt 只是背景，**不自动授权顺手清理**；局部修复不要扩成无关重构。
- 查根因时可以沿真实依赖链读取相关 API、模块、测试和文档；读取范围扩大不等于实现范围自动扩大。
- 不用“构建成功”“单测通过”替代真实运行态或真机行为的验证；无法执行某项必要验证时如实保留待验证范围。

## 常用入口

```bash
npm ci --omit=optional --ignore-scripts # 安装源码依赖；系统媒体工具另装
npm test             # 全量 node --test
node server.js       # HTTP 服务，默认 0.0.0.0:30001；占用时自动顺延
node server.js mcp   # stdio MCP；它是常驻 HTTP 服务的客户端，不另起导出服务
```

构建、后台服务和跨平台发包不是每个任务都需要的入口，按下面导航读取对应文档后再执行。

## 按任务读取

| 任务 | 先读 |
|---|---|
| 导出、预览、录像搜索、设备、任务状态、定时任务、缓存、成品管理、内部模块边界 | [docs/developer-reference.md](docs/developer-reference.md) |
| MCP 工具、stdio / HTTP 传输、定时导出与 MCP 的边界 | [docs/mcp.md](docs/mcp.md)；需要设计依据时再读 [docs/mcp-plan.md](docs/mcp-plan.md) |
| 摄像头别名、MediaMTX、自动选源、OAuth/Bearer、签名下载与公网 Tunnel | [docs/camera-mcp.md](docs/camera-mcp.md) |
| 开机自启、service install/start/stop/status/logs | [docs/background-service.md](docs/background-service.md) |
| 便携包、SEA、跨平台构建 | [docs/cross-build.md](docs/cross-build.md)；Windows 细节见 [docs/build-windows-exe.md](docs/build-windows-exe.md) |
| Web UI 视觉和交互 | **必读** [设计系统](docs/design-system.md)，再按页面读 [各屏规格](docs/ui-glass-spec.md)。`docs/ui-principles.md` 与 `.kiro/steering/ui-design.md` 只是指向这两份文件的摘要 |

## 核心铁律

1. **所有导出必须汇聚到同一份任务状态和单飞守卫。** `startExportTask()` 是 HTTP 导出和进程内 scheduler 的共同编排入口；NVR 回放会话池小且回收慢，同时跑多个导出会互相抢会话。不要另造绕开 `activeTasks` 的导出入口。
2. **MCP 不是第二套导出后端。** stdio MCP 和 HTTP MCP 共用 dispatcher，动作转发给常驻服务的 `/api/*`；不要在 MCP 进程中直接 import 导出管线，否则会产生第二份任务状态和并发失控。
3. **stdio MCP 的 stdout 被协议独占。** 普通日志必须去 stderr；任何新增启动横幅或 `console.log` 都要确认不会污染 stdio JSON-RPC。
4. **设备凭据目前是“可信局域网”模型，不是鉴权模型。** `device-store.js` 是 `data/devices.json` 的唯一读写入口；Web API 仍会把设备完整信息给前端，操作接口仍直接接收 `ip/user/pass`。不要在局部改动中假装已经完成凭据隔离，也不要把当前服务直接暴露到公网。
5. **海康时间是本地墙钟语义。** 协议字符串形如 `YYYYMMDDTHHmmssZ`，这里的 `Z` 不能按普通 UTC 语义想当然处理。时间转换复用 `lib/hik-time.js`；进程的 `TZ` 必须与 NVR 系统时区一致。
6. **RTSP 文本协议输入必须先校验。** `channel` 和 compact 时间会进入手写 RTSP 请求；保持 `server.js` 的格式校验，避免 CR/LF 等内容注入协议文本。
7. **回放会话必须尽力 TEARDOWN。** 导出和预览结束、取消、异常时都要保留会话清理；高频开关或泄漏会话会让后续回放/下载明显限速。
8. **不要用 `Streaming/channels.maxFrameRate` 当真实录像帧率。** 当前设备“全帧率”配置下该值不可靠；优先以 `record/tracks` 的 `Description` 为权威来源，并保留现有回落链。
9. **预览与导出会争用 NVR 资源。** 全局只保留一路预览；启动导出前停止预览的行为不要绕过。
10. **自动导出方式的目的包括缓存复用。** `auto` 下短于 1 小时走 `rtspclip`，长任务走 `mp4download`；扩展时段重导并复用 `.hikraw`，不要为了“省一次导出”去拼接两个成品 MP4。
11. **成品和中间缓存是两类文件。** `/downloads` 只托管 `.mp4`；`.hikraw`、`.done`、裸流属于内部中间产物，不要扩大静态暴露面。进行中的最终 MP4 也受删除/重命名保护。
12. **scheduler 不走 MCP。** 它在常驻服务进程内定时触发 `startExportTask()`；计划由 `data/schedules.json` 持久化，Web 通过 `/api/schedules` GET/PUT 修改，scheduler 每分钟重读，因此修改无需重启。

### RTSP 回放行为

`server.js` 中仍有注释引用本标题。具体的会话池、`Rate-Control: no`、GOP、真实帧率与设备适用范围统一维护在 [docs/developer-reference.md#预览与-rtsp-真机结论](docs/developer-reference.md#预览与-rtsp-真机结论)，根入口不再复制整段实测记录。

`server.js` 另有“技术债 #7”的历史注释，它指旧 `AGENTS.md` 中“scheduler 只记录 `started`、不跟踪终态”的条目；该问题已在当前 `main` 修复。不要把这句历史编号误解为 `docs/developer-reference.md` 当前 Known Tech Debt 列表的第 7 项。

## 验证

- 修改纯逻辑：先跑能覆盖改动的定向测试，再跑 `npm test`；若只改文档，可做静态一致性检查，不强行跑整套功能测试。
- 修改 Web UI：除相关测试外，实际启动服务验证目标交互、错误态和浏览器 console；构建/语法检查不能替代页面运行态。
- 修改 Web UI 样式：只能使用 `docs/design-system.md` 登记的 Token 与组件；不新增未登记的颜色、圆角、阴影、字体或弹窗样式，确需新增先改设计系统文档并征得用户同意。手机验证 320/375/390/430 宽及横屏，桌面验证 1024/1440/1920 宽且必须铺满整屏。
- 修改 RTSP、ISAPI、时间、会话池、预览或导出性能行为：单测之外需要对应 NVR / 录像素材验证。没有真机条件时明确说明哪条设备行为仍待验证。
- 修改后台服务：至少验证当前可用平台；Windows/macOS/Linux 中未实际跑过的平台必须明确标记，不能用一端结果宣称三端完成。
- 修改便携包 / SEA：运行与目标改动对应的构建验证，并核对 ffmpeg/ffprobe、数据目录和时区假设。

## 部署与安全边界

- 当前服务监听 `0.0.0.0` 且默认无鉴权，这是**可信局域网**部署下的有意取舍；`/api/devices` 涉及明文设备密码，`/downloads` 中的 MP4 也可被同网段访问。
- 如任务要面向公网或不可信网络部署，必须把“补鉴权 + 凭据只留服务端 + 下载授权”作为独立安全改造评估，不能只加一层表面路由检查就宣称安全。
- 便携包 / SEA 不保证自带 ffmpeg；目标环境必须能解析 `ffmpeg` / `ffprobe`，或安装可选的 static 依赖。本源码分发不包含容器部署入口；系统工具由操作人安装。

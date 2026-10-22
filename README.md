# H1kM3sh

[English](README.en.md) | [MediaMTX 源码快速开始](docs/oss-quickstart.md)

H1kM3sh 是用于 MediaMTX 录像和海康 DVR/NVR 的网页回放、时间轴选段、MP4 导出与 MCP 控制台。本开源候选直接使用 **Node.js 24 从源码运行**；不提供容器部署、自动发布或预编译程序。项目不负责录制流，也不是 MediaMTX 官方管理面板。

## 依赖与系统边界

- 安装 Node.js 24 和 npm。源码依赖安装见下文；不自动安装系统工具。
- 安装系统 FFmpeg 与 ffprobe，并加入 PATH。按使用功能需要 H.264 编码、AAC 与 drawtext；中文缩略图还需可读字体，可设置 HIKVISION_FONT_FILE。
- 海康 ISAPI/RTSP 路径需要系统 curl；可选上传 worker、账号适配器、SDK 工具需要 Python 3，并各自另装已审阅的上游工具。
- Linux 导出自动恢复需要 util-linux 的 flock。没有 flock 的平台不应依赖未完成任务自动重放；Windows/macOS 的完整恢复和后台服务行为仍需平台验收。
- HCNetSDK 是可选、另行授权的 Linux x86-64 功能，需要符合许可的厂商库、显式录像机 UUID、有效运行时 profile 与真实设备验收。源码不含 SDK 二进制，普通源码启动不会自动启用它。见 [SDK 说明](docs/hik-sdk.md)。
- 应用时区必须与录像机墙钟一致；部署前显式选择 TZ，不要把海康时间字段的 Z 当成普通 UTC。

离线测试和本机启动不证明真实录像机、iOS PWA、媒体精度、生产权限或所有平台已通过验收。

## 安装与首次启动

取得维护者确认的源码快照，在其目录执行：

~~~sh
node --version
ffmpeg -version
ffprobe -version
npm ci --omit=optional --ignore-scripts

# macOS / Linux：第一次仅启用回环入口，关闭调度和自动来源发现。
HIKCLIP_BIND=127.0.0.1 HIKCLIP_PORT_FALLBACK=0 HIKCLIP_SCHEDULER_ENABLED=0 HIKVISION_MEDIAMTX_API_URL='' node server.js
~~~

Windows PowerShell：

~~~powershell
$env:HIKCLIP_BIND = '127.0.0.1'
$env:HIKCLIP_PORT_FALLBACK = '0'
$env:HIKCLIP_SCHEDULER_ENABLED = '0'
$env:HIKVISION_MEDIAMTX_API_URL = ''
node server.js
~~~

30001 只提供 API 和静态模块，根路径 `/` 返回 404。网页控制台需要按“安全访问与控制台”配置独立的 30002 受保护网关后访问。首次无设备/录像属于正常状态；退出使用 Ctrl+C。data/ 保存设备凭据和状态，downloads/ 保存导出文件，均应保持私有并禁止提交。需要自定义目录或 MediaMTX 来源时，按 [源码快速开始](docs/oss-quickstart.md) 逐项配置。Node.js 24 可用 node --env-file=自己的私有配置文件 server.js 读取配置；不要假定应用自动加载 .env。

## 安全访问与控制台

**30001 是未鉴权的内部 API，包含设备凭据与下载能力，且不再提供网页入口。保持 HIKCLIP_BIND=127.0.0.1，绝不反代、端口转发或公开此端口。** 不设置绑定地址时，通用启动默认仍为 0.0.0.0。

手机、另一台电脑或外部访问使用独立的 **30002 受保护网关和 HTTPS**。需要显式配置 HIKCLIP_PUBLIC_PORT、HIKCLIP_PUBLIC_BIND、真实 HTTPS 的 HIKCLIP_PUBLIC_BASE_URL、独立的 MCP token 文件和网页登录密码。密码可在自己的私有环境文件设置 HIKCLIP_LOGIN_PASSWORD（8–128字符），或由本机 npm run setup:status-password 完成初始化；不要把密码或设置码发到聊天、issue 或日志。反代仅接入30002，并限制其网络可达范围。详细配置与认证边界见 [网关/MCP](docs/camera-mcp.md)、[安全政策](SECURITY.md)。

登录保护控制台后，在设置添加自己的 DVR 或 MediaMTX 来源，再按日期查看录像覆盖、手动选择时间范围并导出。MediaMTX 与 DVR 来源分别判断，不会任意换设备填补缺口；回放和导出共享任务队列及设备资源。预览位置、请求范围和成片边界不是逐帧精度保证；录制缺口、关键帧与设备固件会影响结果。可选 SDK 回放请求最多30秒，导出请求最多1小时；失败不会静默切换传输。私人一次性 HTTP 诊断不在此源码分发范围内。

本地上传工具安装和账号连接是独立可选操作；源码启动不授权上传。见 [托管上传](docs/managed-uploads.md)、[账号连接](docs/upload-account-linking.md)。

## 本地检查与文档

~~~sh
npm test -- --test-concurrency=2
~~~

报告实际失败、跳过和未测平台，不用离线测试代替设备/媒体验收。可选 [无网页 CLI](tools/hikvision-cli/README.md) 需要显式配置录像机与私有目录。进一步说明见 [开发参考](docs/developer-reference.md)、[后台服务](docs/background-service.md)、[隔离原生 profile](docs/native-staging.md) 和 [贡献指南](CONTRIBUTING.md)。

## 许可

原创 H1kM3sh 代码使用 [MIT](LICENSE)，第三方组件、字体和可选工具各自保留许可，见 [第三方说明](docs/third-party-notices.md)。可选 ffmpeg-static 在锁文件中标记 GPL-3.0-or-later；默认安装跳过可选二进制包与安装脚本。不能将全部依赖、系统 FFmpeg 或未来二进制称为 MIT。源码不包含真实录像、凭据或厂商 SDK。本项目与 MediaMTX、Hikvision 厂商无关联。

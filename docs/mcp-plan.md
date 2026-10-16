# MCP 入口实施计划

> 状态：已定稿，2026-08-07 开工。落地后本文档保留作为设计依据，日常使用说明见 `docs/mcp.md`。

## 背景与目标

日常需求是「每天 20:00–22:30 的录像，23:00 自动拉回来拼好，本地播放时掐头去尾」。
偶发需求是「今天 19:30 就开球了，帮我把范围扩到 19:30 开始」——这一半适合用自然语言驱动。

因此要做两件互相独立的事：

1. **常规时段自动导出** —— 确定性任务，交给服务自己的定时器，不依赖 AI。
2. **临时调整时段** —— 通过 MCP 暴露给 AI，自然语言 → 参数。

> 明确不做：把定时任务挂到 MCP 上。MCP 是被动协议，需要 AI 客户端在 23:00 那一刻活着并主动调用，
> 把每天雷打不动的需求交给不确定的执行者是错配。

## 架构

服务常驻 `operator@recorder.example.com`，MCP 入口加在**同一个仓库**里，作为 `server.js` 的第三条子命令
（与既有的 `service` 子命令并列，便携包/SEA 自动生效）。

关键约束：**MCP 进程不直接 import `lib/*` 跑导出**，而是把导出动作转发给常驻服务的 HTTP API。

原因：`node server.js mcp` 是独立进程，若它自己跑导出，它和常驻 HTTP 服务各持一份 `activeTasks`，
互相不可见。两边同时导出会争抢 NVR 的回放会话池（池子小、回收分钟级，见 `AGENTS.md`「RTSP 回放行为」），
双双严重降速且无法互相拦截。走 HTTP 后任务状态只有一份，Web UI / 定时器 / MCP 三条路汇到同一个 `activeTasks`。

```
Mac: Claude Code ──ssh──▶ box: node server.js mcp ──HTTP──▶ box: 常驻 server.js ──▶ NVR
                                                                    ▲
                                                          in-process scheduler
```

baseUrl 发现顺序：`HIKCLIP_BASE_URL` 环境变量 → `data/service/runtime.json` 里的 `port`
（端口会自动顺延，这是唯一可靠来源）→ 探测 30001..30010。

## 导出方式策略

| 时长 | 方式 | 理由 |
| --- | --- | --- |
| < 1 小时 | `rtspclip` | 快，`Rate-Control: no` 全速拉流，无需下整个录像文件 |
| ≥ 1 小时 | `mp4download` | 有 `.hikraw` 分片缓存与断点续传，长任务更稳，且能被后续重导复用 |

这条规则让「扩展时段」自然闭环：

- 每天 20:00–22:30（2.5h）走 `mp4download`，`.hikraw` 分片留在本地
- 开球提前后重导 19:30–22:30（3h）仍走 `mp4download`，**20:00 之后的部分直接命中缓存**，
  只需新下 19:30–20:00 覆盖到的那个录像文件

缓存文件名是 `ch{channel}_{start}_{end}.hikraw`，其中 start/end 是 NVR 上录像文件**自身**的边界，
不是请求区间的边界，所以重叠区间天然命中，无需额外做区间对齐。

因此**不做「把两段成品 MP4 拼起来」**：扩展时段就是换参数重导一次，走的是已经跑熟的路径，
拼成品要求两段编码参数完全一致、时间戳连续，出问题极难排查。

实现：`lib/export-method.js` 的 `pickExportMethod(durationSec)` → `{ method, reason }`，阈值 3600 秒。
MCP 与 scheduler 共用；`/api/export` 现有的 `|| 'rtspclip'` 默认值保持不变，避免影响 Web UI 行为。

## 分阶段

### 阶段 0 · 前置重构

1. 把 `/api/export` 路由体里的任务编排抽成 `startExportTask({...})`，返回 `{ taskId, filename }`；
   路由退化成「校验 + 调用」。scheduler 之后在进程内直接调它，不自己 HTTP 打回来。
2. **单飞守卫**：`startExportTask()` 里检查 `activeTasks`，已有进行中的任务就拒绝。
   这是对现有行为的改变——Web UI 此前可以并发开多个导出，之后会收到 HTTP 409。
   已确认采纳：会话池本来就撑不住并发，与其让两个任务互相拖死，不如明确拒绝。
3. 加 `GET /api/outputs`（列 `downloads/*.mp4`：文件名、大小、时间范围、mtime）
   并 `express.static` 托管 `/downloads`。现在没有任何接口能拿到成品列表，MCP 需要它回报结果。

### 阶段 1 · 导出方式自动选择

`lib/export-method.js` + 单元测试。

### 阶段 2 · MCP 入口

- `lib/hikclip-client.js` —— baseUrl 发现 + 各接口 fetch 封装
- `lib/mcp-server.js` —— stdio MCP 服务端，工具面如下
- `server.js` 增加 `process.argv[2] === 'mcp'` 分支

| 工具 | 说明 |
| --- | --- |
| `list_channels` | 通道列表 |
| `list_recordings(date)` | 当天哪些时段真有录像，避免拉到空段 |
| `export_clip(date, start, end, channel?, method?)` | 时间收 `"19:30"` 这种人话格式；返回 taskId + 选中的 method + 选择理由 |
| `get_export_status(taskId?)` | 省略 taskId 时返回全部任务 |
| `cancel_export(taskId)` | 取消 |
| `list_outputs(limit?)` | 成品列表（含可下载 URL） |

两条硬性要求：

- **设备密码绝不进工具返回值**。设备解析在 MCP 进程内部完成，凭据不进模型上下文。
- **时间参数按本地墙钟语义**，服务端负责转成海康紧凑格式。不让模型自己拼
  `20260807T193000Z`，更不让它做时区换算——本项目全程是「本地墙钟直接贴 Z 不换算」。

依赖选型：优先用官方 `@modelcontextprotocol/sdk`（协议版本协商不值得自己维护），
但必须验证 esbuild 能干净打包——便携包与 SEA 都以 `server.js` 为入口，SDK 若有动态 require 会炸。
打不进去就退回手写 stdio JSON-RPC（约 150 行）。

### 阶段 3 · 定时任务与保留策略

- `lib/schedule-store.js` —— `data/schedules.json`，原子写（照 `device-store.js` 的 tmp + rename）
- `lib/scheduler.js` —— 每分钟 tick，本地时间跨过 `runAt` 且当天未跑过就触发；
  启动时做一次补跑（box 半夜没开机的情况）；结果写回 `lastRun`
- **不新增 `/api/schedules` 端点**：scheduler 每 tick 重读文件，MCP 进程直接用 `schedule-store`
  读写同一个文件，省掉 4 个路由

配置形如：

```json
{
  "id": "...",
  "enabled": true,
  "channel": "101",
  "startTime": "20:00",
  "endTime": "22:30",
  "runAt": "23:00",
  "method": "auto",
  "retentionDays": 7
}
```

**保留策略必须做**：主码流 8192 kbps × 2.5h ≈ 9 GB/天的 `.hikraw`，加上成品 MP4 约 18 GB/天，
一个月就能把盘写满。定时任务结束后按 `retentionDays`（定为 **7 天**）清理 `downloads/` 里过期的
`.hikraw`（连同 `.done`）与 `.mp4`。

### 阶段 4 · 测试与文档

- 测试：`export-method`、`schedule-store`、`scheduler`（注入假时钟）、MCP 工具的参数校验与时间转换
- `docs/mcp.md` 使用说明
- 更新 `AGENTS.md`：第三条入口、scheduler、保留策略

## Mac 侧配置

```bash
claude mcp add hikclip -- ssh operator@recorder.example.com /usr/bin/node /absolute/path/h1km3sh/server.js mcp
```

ssh 非交互 shell 的 PATH 通常不含 nvm 装的 node，**必须写 node 绝对路径**
（与 `service-*.js` 里写死绝对路径是同一个坑）。

## 已定决策

1. 单飞守卫：**加**。Web UI 并发导出会返回 409。
2. 成品交付：`downloads/` 已在 box 上做了共享，MCP 额外回一个
   `http://box:<port>/downloads/xxx.mp4` 链接作为备选。
3. 保留天数：**7 天**。

## 不变的前提

服务无鉴权、明文返回设备密码，是可信局域网部署下的有意取舍（见 `AGENTS.md`「部署假设」）。
本次改动不改变这一点，别把这个端口暴露到公网。

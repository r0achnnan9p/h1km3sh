# mediamtx-sheet — 分片抽帧拼图

已配置的 MediaMTX 实例把 RTSP 流按 ~600s 落盘成 fMP4 分片（`/dvr/<ch>/<DATE>_HH-MM-SS-<us>.mp4`，通道 D1/D2 即目录 `d1`/`d2`）。本工具按时间窗选片 → 等间隔抽 N 帧 → 拼成一张 contact sheet，用来**快速判断某段录像里有没有画面、比赛从哪一刻开始**，不用一遍遍拖播放器。

## 用法

```bash
# 在自己的录像主机运行（需 ffmpeg）
bash tools/mediamtx-sheet/mediamtx-sheet.sh d2 2026-08-26 20:00:00 20:24:00 5 5 /tmp/sheets/d2_2000.png
# 入参: <ch> <date> <start> <end> [cols=5] [rows=5] [outpng]

# 默认输出到 /tmp/sheets/<ch>_<start>-<end>.png，列行默认 5x5
bash tools/mediamtx-sheet/mediamtx-sheet.sh d2 2026-08-26 22:20:00 22:24:00
```

输出图片保留在运行脚本的主机；请使用自己审阅的传输方式取回。

## 输出

- N = cols×rows 格（默认 25 格），等间隔覆盖 `[start, end]` 整窗。
- 脚本末尾打印每格对应的真实起始时间与时长间隔，便于反推"从第几格起有画面"→ 换算时分秒喂给 clip。
- 帧不足会复制末帧补齐，过多则截断，保证正好 N 格。

## 典型场景

1. 想合成某晚某通道的完整录像前，先跑一张覆盖可疑时间窗的 sheet，肉眼确认起止画面（避免裁到黑屏/无信号）。
2. 配合 `lib/rtsp-clip-export.js` 的精准剪辑：sheet 定位起点后，直接给 mediamtx 分片做 concat（零转码 `-c copy`）。

## 依赖

- `ffmpeg`/`ffprobe`（按自己的系统安装）。
- 变量可覆盖：`DVR_ROOT`（默认 `/dvr`）、`SEGDUR`（默认 600，分片时长）。

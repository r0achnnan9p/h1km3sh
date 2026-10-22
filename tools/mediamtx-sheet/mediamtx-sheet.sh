#!/usr/bin/env bash
# mediamtx-sheet.sh — 把 mediamtx 落盘的 fMP4 分片，按时间窗抽帧拼成 contact sheet，
# 用于"快速判断某段时间录像里有没有画面/比赛从哪开始"，省得一遍遍拖播放器。
#
# 约定（由操作人配置的录像目录布局）：
#   分片目录: /dvr/<ch>/<YYYY-MM-DD>_HH-MM-SS-<us>.mp4   例: /dvr/d2/2026-08-26_20-00-11-265421.mp4
#   每片时长: ~600s（mediamtx 默认 recordSegmentDuration）
#
# 用法:
#   mediamtx-sheet.sh <ch> <date> <start HH:MM:SS> <end HH:MM:SS> [cols] [rows] [outpng]
#   默认 cols=5 rows=5
#   例:
#     mediamtx-sheet.sh d2 2026-08-26 20:00:00 20:24:00
#     mediamtx-sheet.sh d2 2026-08-26 22:20:00 22:24:00 5 5 /tmp/sheets/d2_2220.png
#
# 依赖: ffmpeg/ffprobe（在运行主机安装）
# 输出: PNG contact sheet，N=cols*rows 格，等间隔覆盖 [start,end] 整窗。
# 末尾打印每格真实起始时间与时长间隔，便于反推"从第几格起有画面"→ 换算时分秒喂给 clip。
set -euo pipefail

DVR_ROOT="${DVR_ROOT:-/dvr}"
CH="$1"; DATE="$2"; START="$3"; END="$4"
COLS="${5:-5}"; ROWS="${6:-5}"
OUT="${7:-/tmp/sheets/${CH}_${START%%:*}${START:3:2}-${END%%:*}${END:3:2}.png}"
DIR="$DVR_ROOT/$CH"
SEGDUR="${SEGDUR:-600}"

[ -d "$DIR" ] || { echo "NO SUCH DIR: $DIR" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
FR="$OUT.frames"; rm -rf "$FR"; mkdir -p "$FR"

WSTART=$(date -d "$DATE $START" +%s)
WEND=$(date -d "$DATE $END" +%s)
SPAN=$((WEND-WSTART)); [ "$SPAN" -gt 0 ] || { echo "BAD SPAN (end<=start)" >&2; exit 3; }
N=$((COLS*ROWS))

# 选与窗口重叠的分片（segstart<=WEND 且 segend>=WSTART）
LIST=$(mktemp)
for f in "$DIR"/"$DATE"_*.mp4; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .mp4)
  ts=${base#"$DATE"_}
  h=${ts:0:2}; m=${ts:3:2}; s=${ts:6:2}
  segstart=$(date -d "$DATE $h:$m:$s" +%s)
  segend=$((segstart+SEGDUR))
  if [ "$segstart" -le "$WEND" ] && [ "$segend" -ge "$WSTART" ]; then
    echo "file '$f'" >> "$LIST"
  fi
done
sel=$(grep -c . "$LIST" 2>/dev/null || echo 0)
echo "选片 $sel 个"
[ "$sel" -gt 0 ] || { echo "窗口内无分片" >&2; rm -f "$LIST"; exit 4; }

# ⚠️ 关键坑（2026-08-28 实测）：concat 流起点 = 第一个被选分片起点（可能早于窗口起点，
# 因为重叠判定会把窗口前的片也选进来），抽帧必须从 OFFSET=WSTART-首片起点 开始，
# 不能 -ss 0——否则每格实际画面比标注早偏移（实测偏移 476s = 7m56s，误导用户确认开球时间）
FIRST_SEG=$(head -1 "$LIST" | sed "s|file '||; s|'$||" | xargs basename)
FS_HH=$(echo "$FIRST_SEG" | cut -d_ -f2 | cut -d- -f1)
FS_MM=$(echo "$FIRST_SEG" | cut -d_ -f2 | cut -d- -f2)
FS_SS=$(echo "$FIRST_SEG" | cut -d_ -f2 | cut -d- -f3)
FS_START=$(date -d "$DATE $FS_HH:$FS_MM:$FS_SS" +%s)
OFFSET=$((WSTART-FS_START))
[ "$OFFSET" -ge 0 ] || { echo "窗口起点早于首片起点，无法抽帧" >&2; rm -f "$LIST"; exit 5; }
echo "首片 $FIRST_SEG 起点=$FS_HH:$FS_MM:$FS_SS, OFFSET=${OFFSET}s（窗口起点-首片起点）"

FPS=$(awk "BEGIN{printf \"%.6f\", $N/$SPAN}")
echo "抽 $N 帧 (${COLS}x${ROWS}), fps=$FPS, 覆盖 ${SPAN}s"
# -skip_frame nokey: 只解关键帧（GOP=1s），2h 窗口从 14 万帧降到 ~7200 帧，E5 老机从 15+ 分钟压到 1 分钟内
ffmpeg -y -skip_frame nokey -f concat -safe 0 -i "$LIST" -ss "$OFFSET" -t "$SPAN" \
  -vf "fps=$FPS,scale=320:180" -frames:v "$N" -vsync vfr "$FR/frame_%04d.png" 2>/dev/null

shopt -s nullglob
frames=("$FR"/frame_*.png)
cnt=${#frames[@]}
if [ "$cnt" -lt "$N" ]; then
  last="${frames[$((cnt-1))]}"
  for ((i=cnt; i<N; i++)); do cp "$last" "$FR/frame_$(printf %04d $((i+1))).png"; done
  echo "帧不足，补至 $N (原 $cnt)"
elif [ "$cnt" -gt "$N" ]; then
  for ((i=N; i<cnt; i++)); do rm -f "$FR/frame_$(printf %04d $((i+1))).png"; done
  echo "帧过多，截至 $N (原 $cnt)"
fi

ffmpeg -y -i "$FR/frame_%04d.png" -filter_complex "tile=${COLS}x${ROWS}" "$OUT" 2>/dev/null
rm -f "$LIST"; rm -rf "$FR"
echo "WROTE $OUT ($(du -h "$OUT" | cut -f1))"
echo "每格对应真实时间: $(date -d "@$WSTART" +%H:%M:%S) 起, 间隔 $(awk "BEGIN{printf \"%.1f\", $SPAN/$N}")s"

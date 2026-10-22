#!/usr/bin/env python3
"""Small, headless Hikvision DVR exporter.

Configure the recorder and local directories explicitly. An optional SSH SOCKS
tunnel can reach a recorder through an operator-selected jump host.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable


COMPACT_RE = re.compile(r"^\d{8}T\d{6}Z$")
CLOCK_RE = re.compile(r"^\d{2}:\d{2}(?::\d{2})?$")
SIZE_RE = re.compile(r"[?&]size=(\d+)")


class ExportError(RuntimeError):
    pass


def compact_time(date_text: str, clock_text: str) -> str:
    """Convert local wall-clock date/time to Hikvision's compact format."""
    try:
        date = dt.datetime.strptime(date_text, "%Y-%m-%d").date()
        clock = dt.datetime.strptime(clock_text, "%H:%M:%S" if clock_text.count(":") == 2 else "%H:%M").time()
    except ValueError as exc:
        raise ValueError(f"日期或时间格式错误: {date_text} {clock_text}") from exc
    value = dt.datetime.combine(date, clock)
    return value.strftime("%Y%m%dT%H%M%SZ")


def iso_time(compact: str) -> str:
    if not COMPACT_RE.fullmatch(compact):
        raise ValueError(f"非法海康时间: {compact}")
    return f"{compact[0:4]}-{compact[4:6]}-{compact[6:8]}T{compact[9:11]}:{compact[11:13]}:{compact[13:15]}Z"


def parse_iso(value: str) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ExportError(f"海康返回了非法时间: {value}") from exc


def build_search_xml(
    search_id: str,
    track_id: str,
    start_time: str,
    end_time: str,
    max_results: int,
    position: int,
    *,
    track_tag: str = "trackList",
    declaration: bool = False,
    namespace: bool = False,
) -> str:
    """Build one CMSearchDescription request.

    Hikvision firmware is annoyingly inconsistent: the documented schema uses
    trackIDList, while many NVRs accept the historical trackList spelling.
    The default intentionally matches the existing extractor; search() retries
    the documented spelling if a device rejects it.
    """
    root_attrs = " version=\"1.0\" xmlns=\"http://www.hikvision.com/ver20/XMLSchema\"" if namespace else ""
    root = (
        f"<CMSearchDescription{root_attrs}>"
        f"<searchID>{search_id}</searchID>"
        f"<{track_tag}><trackID>{track_id}</trackID></{track_tag}>"
        f"<timeSpanList><timeSpan><startTime>{start_time}</startTime>"
        f"<endTime>{end_time}</endTime></timeSpan></timeSpanList>"
        f"<maxResults>{max_results}</maxResults>"
        f"<searchResultPostion>{position}</searchResultPostion>"
        f"<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>"
        "</CMSearchDescription>"
    )
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>" if declaration else "") + root


def build_download_xml(playback_uri: str) -> str:
    escaped = html.escape(playback_uri, quote=False)
    return f"<downloadRequest><playbackURI>{escaped}</playbackURI></downloadRequest>"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _first_element(node: ET.Element, name: str) -> ET.Element | None:
    for child in node.iter():
        if _local_name(child.tag) == name:
            return child
    return None


def _text(node: ET.Element | None, name: str, default: str = "") -> str:
    if node is None:
        return default
    found = _first_element(node, name)
    return (found.text or "").strip() if found is not None else default


def extract_size(playback_uri: str) -> int:
    match = SIZE_RE.search(playback_uri)
    return int(match.group(1)) if match else 0


def parse_search_response(xml_text: str, channel: str) -> list[dict]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ExportError(f"解析海康搜索响应失败: {exc}") from exc

    root_name = _local_name(root.tag)
    if root_name == "ResponseStatus":
        code = _text(root, "statusCode", "?")
        status = _text(root, "statusString", "未知错误")
        detail = _text(root, "subStatusString", "")
        raise ExportError(f"海康搜索拒绝请求: {code} {status}{(' - ' + detail) if detail else ''}")
    if root_name != "CMSearchResult":
        raise ExportError(f"海康返回了意外根节点: {root_name}")

    response_status = _text(root, "responseStatus", "true").lower()
    if response_status in {"false", "no matches"}:
        return []

    results: list[dict] = []
    for item in root.iter():
        if _local_name(item.tag) != "searchMatchItem":
            continue
        start = _text(item, "startTime")
        end = _text(item, "endTime")
        uri = _text(item, "playbackURI")
        if not start or not end or not uri:
            continue
        results.append(
            {
                "playbackURI": uri,
                "startTime": start,
                "endTime": end,
                "size": extract_size(uri),
                "channel": channel,
            }
        )
    return results


def filter_overlapping(files: Iterable[dict], start_time: str, end_time: str) -> list[dict]:
    start = parse_iso(start_time)
    end = parse_iso(end_time)
    selected = []
    for item in files:
        file_start = parse_iso(item["startTime"])
        file_end = parse_iso(item["endTime"])
        if file_end > start and file_start < end:
            selected.append(item)
    return sorted(selected, key=lambda item: item["startTime"])


def output_filename(title: str, date_text: str) -> str:
    title = title.strip()
    if not title or title in {".", ".."} or "/" in title or "\\" in title or "\x00" in title:
        raise ValueError("标题不能为空，且不能包含路径分隔符")
    return f"{title} {date_text}.mp4"


def _run(args: list[str], *, timeout: float | None = None, input_text: str | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise ExportError(f"找不到命令: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ExportError(f"命令超时: {args[0]}") from exc


class HikvisionClient:
    def __init__(self, ip: str, user: str, password: str, proxy_port: int | None, netrc_path: Path):
        self.ip = ip
        self.user = user
        self.password = password
        self.proxy_port = proxy_port
        self.netrc_path = netrc_path

    def _curl(self, endpoint: str, body_path: Path | None = None, output_path: Path | None = None, timeout: float | None = None) -> str:
        args = [
            "curl",
            "--http1.0",
            "--connect-timeout",
            "10",
            "--digest",
            "--netrc-file",
            str(self.netrc_path),
            "-sS",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/xml",
            "-H",
            "Expect:",
        ]
        if body_path is not None:
            args += ["--data-binary", f"@{body_path}"]
        if output_path is not None:
            args += ["-o", str(output_path)]
        if self.proxy_port is not None:
            args += ["--socks5-hostname", f"127.0.0.1:{self.proxy_port}"]
        args.append(f"http://{self.ip}{endpoint}")
        result = _run(args, timeout=timeout)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
            raise ExportError(f"海康 API 请求失败（curl {result.returncode}）: {' '.join(detail)}")
        return result.stdout

    def search(self, channel: str, start_iso: str, end_iso: str, work_dir: Path) -> list[dict]:
        variants = [
            dict(track_tag="trackList", declaration=False, namespace=False),
            dict(track_tag="trackIDList", declaration=False, namespace=False),
            dict(track_tag="trackList", declaration=True, namespace=True),
            dict(track_tag="trackIDList", declaration=True, namespace=True),
        ]
        last_error: Exception | None = None
        for variant in variants:
            all_files: list[dict] = []
            search_id = str(uuid.uuid4())
            position = 0
            try:
                while True:
                    xml = build_search_xml(search_id, channel, start_iso, end_iso, 40, position, **variant)
                    body = work_dir / f"search_{position}.xml"
                    body.write_text(xml, encoding="utf-8")
                    response = self._curl("/ISAPI/ContentMgmt/search", body_path=body, timeout=60)
                    body.unlink(missing_ok=True)
                    page = parse_search_response(response, channel)
                    if not page:
                        break
                    all_files.extend(page)
                    position += len(page)
                    if len(page) < 40:
                        break
                if all_files:
                    return filter_overlapping(all_files, start_iso, end_iso)
                return []
            except ExportError as exc:
                last_error = exc
                for path in work_dir.glob("search_*.xml"):
                    path.unlink(missing_ok=True)
                continue
        raise ExportError(str(last_error) if last_error else "海康搜索失败")

    def download(self, recording: dict, output_path: Path) -> None:
        body = output_path.with_suffix(output_path.suffix + ".xml")
        body.write_text(build_download_xml(recording["playbackURI"]), encoding="utf-8")
        try:
            result = self._curl(
                "/ISAPI/ContentMgmt/download",
                body_path=body,
                output_path=output_path,
                timeout=None,
            )
        finally:
            body.unlink(missing_ok=True)
        if output_path.stat().st_size <= 0:
            raise ExportError("海康下载返回空文件")


@contextmanager
def socks_tunnel(jump: str | None, jump_user: str, jump_key: str | None, port: int, known_hosts: str | None):
    if not jump:
        yield None
        return
    args = [
        "ssh",
        "-i",
        jump_key or str(Path.home() / ".ssh/id_ed25519"),
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
        "-D",
        f"127.0.0.1:{port}",
    ]
    if known_hosts:
        args += ["-o", f"UserKnownHostsFile={known_hosts}", "-o", "StrictHostKeyChecking=yes"]
    args.append(f"{jump_user}@{jump}")
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                error = (proc.stderr.read() if proc.stderr else "").strip()
                raise ExportError(f"到 n1 的 SOCKS 隧道启动失败: {error or proc.returncode}")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise ExportError("到 n1 的 SOCKS 隧道启动超时")
        yield port
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def _probe_duration(path: Path) -> float:
    result = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        timeout=120,
    )
    if result.returncode != 0:
        raise ExportError(f"ffprobe 无法读取 {path.name}: {(result.stderr or '').strip()[-400:]}")
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise ExportError(f"ffprobe 返回了非法时长: {path.name}") from exc


def expand_for_keyframe(requested_ss: float, keyframe_ss: float, duration: float) -> tuple[float, float]:
    """Move a stream-copy trim to the previous I-frame without moving its end."""
    if keyframe_ss >= requested_ss:
        return requested_ss, duration
    delta = requested_ss - keyframe_ss
    return keyframe_ss, duration + delta


def _find_previous_keyframe(path: Path, requested_ss: float) -> float | None:
    """Return the nearest keyframe at or before an input-side seek position."""
    start_probe = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=start_time", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        timeout=120,
    )
    if start_probe.returncode != 0:
        return None
    try:
        origin = float(start_probe.stdout.strip())
    except ValueError:
        return None

    window_start = max(0.0, requested_ss - 6.0)
    result = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-read_intervals",
            f"{origin + window_start:.3f}%+12",
            "-skip_frame",
            "nokey",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "csv=p=0",
            str(path),
        ],
        timeout=180,
    )
    if result.returncode != 0:
        return None
    candidates = []
    for line in result.stdout.splitlines():
        try:
            absolute = float(line.strip().split(",", 1)[0])
        except ValueError:
            continue
        relative = absolute - origin
        if relative <= requested_ss + 0.05:
            candidates.append(relative)
    return max(candidates) if candidates else None


def _ffmpeg_remux_or_trim(input_path: Path, output_path: Path, ss: float, duration: float | None) -> None:
    common = ["ffmpeg", "-v", "error"]
    if ss > 0.01:
        common += ["-ss", f"{ss:.3f}"]
    common += ["-i", str(input_path)]
    if duration is not None and duration > 0.01:
        common += ["-t", f"{duration:.3f}"]
    common += ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", str(output_path)]
    result = _run(common, timeout=1800)
    if result.returncode == 0:
        return
    # A few Hikvision firmwares return an audio stream that FFmpeg cannot AAC
    # encode.  Keep the video lossless and retry without audio instead of
    # throwing away an otherwise valid recording.
    output_path.unlink(missing_ok=True)
    audio_index = common.index("-c:a")
    movflags_index = common.index("-movflags")
    no_audio = common[:audio_index] + ["-an"] + common[movflags_index:]
    retry = _run(no_audio, timeout=1800)
    if retry.returncode != 0:
        detail = (retry.stderr or result.stderr or "").strip()[-800:]
        raise ExportError(f"FFmpeg 处理失败: {detail}")


def _concat(trimmed: list[Path], output_path: Path, list_path: Path) -> None:
    if len(trimmed) == 1:
        _ffmpeg_remux_or_trim(trimmed[0], output_path, 0, None)
        return
    lines = []
    for path in trimmed:
        escaped = str(path.resolve()).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = _run(
        ["ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", "-movflags", "+faststart", "-y", str(output_path)],
        timeout=2400,
    )
    if result.returncode != 0:
        raise ExportError(f"FFmpeg 拼接失败: {(result.stderr or '').strip()[-800:]}")


def _validate_coverage(files: list[dict], user_start: dt.datetime, user_end: dt.datetime) -> None:
    if not files:
        raise ExportError("该时间段内无可用录像")
    previous_end = user_start
    for item in files:
        start = parse_iso(item["startTime"])
        end = parse_iso(item["endTime"])
        if start > previous_end + dt.timedelta(seconds=5):
            raise ExportError(f"录像存在缺口: {previous_end.isoformat()} ~ {start.isoformat()}")
        previous_end = max(previous_end, end)
    if previous_end < user_end - dt.timedelta(seconds=5):
        raise ExportError(f"录像尾部不足: 只覆盖到 {previous_end.isoformat()}，目标是 {user_end.isoformat()}")


def export_recording(client: HikvisionClient, recordings: list[dict], channel: str, start_iso: str, end_iso: str, title: str, date_text: str, cache_dir: Path, work_dir: Path, output_dir: Path, force: bool) -> Path:
    user_start = parse_iso(start_iso)
    user_end = parse_iso(end_iso)
    _validate_coverage(recordings, user_start, user_end)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_filename(title, date_text)
    if output_path.exists() and not force:
        raise ExportError(f"目标文件已存在，拒绝覆盖: {output_path}")

    expected_bytes = sum(max(0, int(item.get("size", 0))) for item in recordings)
    free_bytes = shutil.disk_usage(output_dir).free
    if expected_bytes and free_bytes < expected_bytes + 2 * 1024**3:
        raise ExportError(f"/dvr 可用空间不足: 需要至少约 {expected_bytes / 1024**3:.1f} GiB，当前 {free_bytes / 1024**3:.1f} GiB")

    downloaded: list[tuple[dict, Path]] = []
    for index, item in enumerate(recordings, 1):
        start_compact = item["startTime"].replace("-", "").replace(":", "")
        end_compact = item["endTime"].replace("-", "").replace(":", "")
        raw = cache_dir / f"ch{channel}_{start_compact}_{end_compact}.hikraw"
        done = raw.with_suffix(raw.suffix + ".done")
        expected = int(item.get("size", 0) or 0)
        if raw.exists() and done.exists() and (not expected or raw.stat().st_size >= expected):
            print(f"[cache] {index}/{len(recordings)} {raw.name}", flush=True)
        else:
            for attempt in range(1, 4):
                raw.unlink(missing_ok=True)
                done.unlink(missing_ok=True)
                part = raw.with_suffix(raw.suffix + ".part")
                part.unlink(missing_ok=True)
                print(f"[download] {index}/{len(recordings)} attempt={attempt} {raw.name}", flush=True)
                try:
                    client.download(item, part)
                    size = part.stat().st_size
                    if expected and size < expected:
                        raise ExportError(f"文件不完整: 期望至少 {expected} bytes，实际 {size} bytes")
                    os.replace(part, raw)
                    done.write_text("", encoding="utf-8")
                    break
                except Exception:
                    part.unlink(missing_ok=True)
                    if attempt == 3:
                        raise
                    time.sleep(2)
        downloaded.append((item, raw))

    run_dir = work_dir / f"{date_text}_{channel}_{uuid.uuid4().hex[:10]}"
    run_dir.mkdir(parents=True, exist_ok=False)
    trimmed: list[Path] = []
    try:
        for index, (item, raw) in enumerate(downloaded):
            actual = _probe_duration(raw)
            file_start = parse_iso(item["startTime"])
            file_end = parse_iso(item["endTime"])
            reported = max(0.0, (file_end - file_start).total_seconds())
            ss = max(0.0, (user_start - file_start).total_seconds())
            to = min(actual, (user_end - file_start).total_seconds())
            if actual > reported + 5 and index == 0:
                extra = actual - reported
                ss += extra
                to = min(actual, to + extra)
            if actual > reported + 5 and index == len(downloaded) - 1 and user_end >= file_end - dt.timedelta(seconds=1):
                to = min(to, reported)
            duration = max(0.0, to - ss)
            if duration <= 0.01:
                continue
            if index == 0 and ss > 0.01:
                keyframe_ss = _find_previous_keyframe(raw, ss)
                if keyframe_ss is not None and keyframe_ss < ss - 0.01:
                    old_ss = ss
                    ss, duration = expand_for_keyframe(ss, keyframe_ss, duration)
                    print(f"[trim] 首段回退到前一 I 帧: {old_ss:.3f}s -> {ss:.3f}s", flush=True)
            trimmed_path = run_dir / f"{index:04d}.mp4"
            print(f"[trim] {index + 1}/{len(downloaded)} ss={ss:.2f}s duration={duration:.2f}s", flush=True)
            _ffmpeg_remux_or_trim(raw, trimmed_path, ss, duration)
            trimmed.append(trimmed_path)
        if not trimmed:
            raise ExportError("裁剪后没有有效视频")
        list_path = run_dir / "concat.txt"
        print(f"[concat] {len(trimmed)} 个片段 → {output_path.name}", flush=True)
        _concat(trimmed, output_path, list_path)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)

    return output_path


def read_password(path: str | None, env_name: str) -> str:
    if path:
        password_path = Path(path)
        if password_path.exists():
            value = password_path.read_text(encoding="utf-8").strip()
            if value:
                return value
    value = os.environ.get(env_name, "").strip()
    if value:
        return value
    raise ExportError(f"没有找到海康密码：请配置 {path or env_name}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="无 WebUI 海康录像导出器")
    parser.add_argument("date", help="YYYY-MM-DD，按录像机墙钟")
    parser.add_argument("start", help="HH:MM 或 HH:MM:SS")
    parser.add_argument("end", help="HH:MM 或 HH:MM:SS")
    parser.add_argument("channel", help="海康通道，例如 201")
    parser.add_argument("title", help="输出标题，例如 灵气闪耀")
    parser.add_argument("--ip", required=True, help="Recorder address (required)")
    parser.add_argument("--user", required=True, help="Recorder account (required)")
    parser.add_argument("--password-file", help="Private local password file; otherwise use --password-env")
    parser.add_argument("--password-env", default="HIKVISION_PASSWORD")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--jump", help="Optional SSH jump host; no tunnel by default")
    parser.add_argument("--jump-user", help="Required with --jump")
    parser.add_argument("--jump-key", help="Required with --jump")
    parser.add_argument("--known-hosts", help="Required with --jump; strict host-key verification")
    parser.add_argument("--proxy-port", type=int, default=18080)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-jump", action="store_true")
    args = parser.parse_args(argv)
    if args.jump and not args.no_jump and not all((args.jump_user, args.jump_key, args.known_hosts)):
        parser.error("--jump requires --jump-user, --jump-key and --known-hosts")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        start_compact = compact_time(args.date, args.start)
        end_compact = compact_time(args.date, args.end)
        start_iso = iso_time(start_compact)
        end_iso = iso_time(end_compact)
        if parse_iso(end_iso) <= parse_iso(start_iso):
            raise ExportError("结束时间必须晚于开始时间")
        if not re.fullmatch(r"\d{1,8}", args.channel):
            raise ExportError("通道必须是数字")
        password = read_password(args.password_file, args.password_env)
        output_dir = Path(args.output_dir)
        cache_dir = Path(args.cache_dir)
        work_dir = Path(args.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        netrc = work_dir / f".netrc_{os.getpid()}"
        netrc.write_text(f"machine {args.ip}\nlogin {args.user}\npassword {password}\n", encoding="utf-8")
        netrc.chmod(0o600)
        try:
            jump = None if args.no_jump else args.jump
            with socks_tunnel(jump, args.jump_user, args.jump_key, args.proxy_port, args.known_hosts) as proxy_port:
                client = HikvisionClient(args.ip, args.user, password, proxy_port, netrc)
                query_dir = work_dir / "query"
                query_dir.mkdir(parents=True, exist_ok=True)
                print(f"[search] {args.date} {args.start}-{args.end}, channel={args.channel}", flush=True)
                recordings = client.search(args.channel, start_iso, end_iso, query_dir)
                recordings = filter_overlapping(recordings, start_iso, end_iso)
                print(f"[search] 找到 {len(recordings)} 个录像片段", flush=True)
                for item in recordings:
                    print(f"  {item['startTime']} ~ {item['endTime']} ({item.get('size', 0) / 1024**2:.0f} MiB)", flush=True)
                path = export_recording(client, recordings, args.channel, start_iso, end_iso, args.title, args.date, cache_dir, work_dir, output_dir, args.force)
        finally:
            netrc.unlink(missing_ok=True)
        result = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size,start_time", "-of", "default=noprint_wrappers=1", str(path)], timeout=120)
        if result.returncode != 0:
            raise ExportError(f"成品 ffprobe 验收失败: {(result.stderr or '').strip()}")
        print(f"[done] {path}", flush=True)
        print(result.stdout.strip(), flush=True)
        return 0
    except (ExportError, ValueError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

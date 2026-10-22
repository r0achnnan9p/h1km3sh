#!/usr/bin/env python3
"""主机执行 Rust biliup；与 MCP 服务通过私有文件队列通信，不开放端口。"""
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from upload_worker_state import connection_matches, PreflightUnavailable, account_lock, named_lock, claim_job, save, source_matches, subprocess_claim, timestamp, wait_before_upload

ROOT = Path(os.environ['HIKVISION_DOWNLOADS_DIR']).resolve()
JOBS = ROOT / 'biliup_work' / 'jobs'
BINARY = os.environ['BILIUP_BINARY']
COOKIE = os.environ['BILIUP_COOKIE_FILE']
COVER = os.environ.get('BILIUP_COVER_FILE', '/opt/biliup/assets/bilibili_default_cover.png')
SEASON_ID = int(os.environ.get('BILIUP_SEASON_ID', '0'))
SECTION_ID = int(os.environ.get('BILIUP_SECTION_ID', '0'))
ANSI_ESCAPE = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
FRAME_BOUNDARY = re.compile(rb'[\r\n]|\x1b\[[0-?]*[ -/]*[ABCDEFGHJKSTf]')
SIZE_VALUE = r'([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B)(?![A-Za-z])'
SIZE_PAIR = re.compile(SIZE_VALUE + r'\s*/\s*(?:' + SIZE_VALUE + r'|\?|unknown)', re.I)
UPLOAD_SPEED = re.compile(SIZE_VALUE + r'/s(?![A-Za-z])', re.I)
UPLOADED_WITHOUT_TOTAL = re.compile(SIZE_VALUE + r'\s*\(', re.I)
UPLOAD_COMPLETED = re.compile(r'(?:^|\s)Upload completed: .+ => cost [0-9.]+s, [0-9.]+ MB/s\.', re.I)


def safe_failure(result):
    """仅保存固定诊断类别，绝不持久化 biliup 的原始输出。"""
    output = (result.stdout + result.stderr).decode('utf-8', errors='replace').lower()
    if any(word in output for word in ('read-only file system', 'permission denied', 'os error 30', 'os error 13')):
        return 'filesystem', '投稿进程没有写入 Cookie 或缓存的权限'
    if any(word in output for word in ('not logged in', 'login expired', 'cookie expired', 'token expired',
                                        'unauthorized', '未登录', '登录失效', '请重新登录', '账号过期')):
        return 'auth', '登录凭据可能失效'
    if any(word in output for word in ('cover', '封面')):
        return 'cover', '封面参数或图片被拒绝'
    if any(word in output for word in ('tid', '分区', 'tag', '标签', '参数错误')):
        return 'metadata', '分区、标签或投稿参数被拒绝'
    if any(word in output for word in ('too many', 'rate limit', '频繁', '限流')):
        return 'rate_limit', '平台限制了请求频率'
    if any(word in output for word in ('timeout', 'timed out', 'connection', '网络', 'dns')):
        return 'network', '连接或网络超时'
    return 'cli_error', f'biliupR 退出码 {result.returncode}，原因未识别'


# Fixed allowlist only: exception strings, HTTP bodies and CLI output may contain
# credentials. Never persist them, even for preflight diagnostics.
PREFLIGHT_FAILURES = {
    '无效视频路径': ('source_path', '视频路径校验失败，请从成片库重新选择视频'),
    '成品已改名、删除或修改，请重新准备投稿': ('source_changed', '视频文件已改名、删除或修改，请从成片库重新选择视频'),
    '投稿标签无效': ('tags', '投稿标签格式无效'),
    '投稿标签过多': ('tags', '投稿标签超过平台限制'),
    '足球合集和小节尚未配置': ('collection_configuration', '足球合集或小节尚未配置'),
    '登录账号身份无法确认': ('credential_identity', '登录凭据中的账号身份无法确认，请重新连接账号'),
    '登录账号身份不一致': ('identity_mismatch', '登录账号身份不一致，请重新连接账号'),
    '缺少合集操作所需的 Cookie': ('credential_fields', '登录凭据缺少合集校验所需字段，请重新连接账号'),
    '无法核实账号的合集列表': ('collection_schema', '平台返回的合集列表格式无法确认'),
    '合集信息不明确': ('collection_ambiguous', '平台返回了重复的目标合集信息'),
    '当前账号没有配置的足球合集权限，请连接拥有足球合集的账号': ('collection_missing', '当前账号的合集列表中没有配置的足球合集，请核对账号和合集设置'),
    '配置的合集名称不是足球，请检查服务器的足球合集配置': ('collection_name', '配置的合集名称不是足球，请核对合集设置'),
    '足球合集不属于当前登录账号': ('collection_owner', '足球合集不属于当前登录账号'),
    '合集尚未处于可用状态': ('collection_state', '足球合集尚未处于可用状态'),
    '合集小节列表无法确认': ('section_schema', '平台返回的合集小节列表格式无法确认'),
    '小节不属于此合集或不可用': ('section_membership', '配置的小节不属于此合集或不可用'),
    '合集小节关系未确认': ('section_relationship', '平台未确认配置的小节与合集的关系'),
    '合集响应过大': ('collection_response', '平台的合集校验响应超出限制'),
    '合集响应格式无效': ('collection_response', '平台的合集校验响应格式无法确认'),
}


def preflight_failure(error, component):
    known = PREFLIGHT_FAILURES.get(str(error))
    if known:
        return 'preflight_' + known[0], known[1]
    if isinstance(error, urllib.error.HTTPError):
        return 'preflight_http', '平台拒绝了账号或合集校验请求，请核对账号权限后重试'
    if isinstance(error, (TimeoutError, urllib.error.URLError)):
        return 'preflight_network', '账号或合集校验网络请求失败，请稍后重试'
    if isinstance(error, (PermissionError, FileNotFoundError)):
        return 'preflight_local_access', '投稿所需的本地文件不存在或不可访问'
    if isinstance(error, RuntimeError) and re.fullmatch(r'合集接口返回错误码 -?\d+', str(error)):
        return 'preflight_platform', '平台返回账号或合集校验错误，请核对账号和合集设置'
    detail = {'source': '视频文件校验失败', 'cover': '封面文件校验失败',
              'tags': '投稿标签校验失败', 'collection': '账号或足球合集校验失败'}.get(component, '投稿启动前校验失败')
    return 'preflight_' + (component if component in ('source', 'cover', 'tags', 'collection') else 'other'), detail


def byte_count(value, unit):
    unit = unit.upper()
    if unit == 'B':
        return int(float(value))
    prefix = unit[0]
    base = 1024 if 'I' in unit else 1000
    return int(float(value) * (base ** ('KMGTPE'.index(prefix) + 1)))


def progress_update(raw):
    """Only return structured telemetry; raw output can contain credentials.

    The CLI humanizes sizes, so these are measured, rounded transfer values,
    never an estimated overall submission percentage.
    """
    line = ANSI_ESCAPE.sub(b'', raw).decode('utf-8', errors='replace')
    if UPLOAD_COMPLETED.search(line):
        return dict(stage='submitting', stagePercent=None, progress=None,
                    uploadSpeed=None, message='视频数据已传完，正在提交稿件')
    pair = SIZE_PAIR.search(line)
    speed = UPLOAD_SPEED.search(line)
    without_total = UPLOADED_WITHOUT_TOTAL.search(line) if speed else None
    if not pair and not without_total:
        return None
    match = pair or without_total
    uploaded = byte_count(match.group(1), match.group(2))
    total = byte_count(pair.group(3), pair.group(4)) if pair and pair.group(3) else None
    total = total or None  # A zero/unknown CLI length is not the local file size.
    percent = min(100, round(uploaded / total * 100, 1)) if total else None
    return dict(stage='uploading', stagePercent=percent, progress=percent,
                progressUnit='bytes', uploadedBytes=uploaded, totalBytes=total,
                uploadSpeed=byte_count(speed.group(1), speed.group(2)) if speed else None,
                message='正在传输视频数据')


class UploadProgress:
    """Frame PTY redraws and stream logs, retaining at most one bounded line."""
    def __init__(self, file, job):
        self.file, self.job = file, job
        self.pending = {'stdout': bytearray(), 'stderr': bytearray()}
        self.last_seen = {'stdout': None, 'stderr': None}
        self.last_saved = 0.0
        self.dirty = False

    def parse(self, raw, stream, complete=False):
        # indicatif writes a complete frame without a newline. Wait for its
        # closing speed/ETA parenthesis, not for the next redraw or process exit.
        clean = ANSI_ESCAPE.sub(b'', raw).rstrip()
        if not complete and not clean.endswith(b')'):
            return
        if not clean or clean == self.last_seen[stream]:
            return
        self.last_seen[stream] = clean
        update = progress_update(clean)
        if update is None:
            return
        # stdout completion logs and the final stderr draw may arrive in either
        # order. Never regress a confirmed post-transfer stage back to uploading.
        if self.job.get('stage') == 'submitting' and update['stage'] == 'uploading':
            return
        stage_changed = self.job.get('stage') != update['stage']
        self.job.update(update, progressUpdatedAt=int(time.time() * 1000))
        self.dirty = True
        self.flush(force=stage_changed)

    def feed(self, stream, chunk):
        pending = self.pending[stream]
        pending.extend(chunk)
        while True:
            boundary = FRAME_BOUNDARY.search(pending)
            if boundary is None:
                break
            self.parse(bytes(pending[:boundary.start()]), stream, complete=True)
            del pending[:boundary.end()]
            self.last_seen[stream] = None
        if len(pending) > 65536:
            del pending[:-65536]
        self.parse(bytes(pending), stream)

    def flush(self, force=False):
        now = time.monotonic()
        if self.dirty and (force or now - self.last_saved >= 1):
            save(self.file, self.job)
            self.last_saved, self.dirty = now, False

    def finish(self):
        for stream, pending in self.pending.items():
            self.parse(bytes(pending), stream, complete=True)
        self.flush(force=True)


def run_upload(args, file, job):
    """用伪终端接收 biliupR 的真实进度条，只保存字节数和速率。"""
    if os.name != 'posix':
        return subprocess.run(args, capture_output=True, timeout=8 * 3600, **subprocess_claim())
    import errno
    import fcntl
    import pty
    import selectors
    import struct
    import termios

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
    # indicatif hides progress for a missing/dumb terminal even with a PTY.
    # Keep every configured variable; only supply a usable TERM for this child.
    environment = os.environ.copy()
    if environment.get('TERM') in (None, '', 'dumb'):
        environment['TERM'] = 'xterm'
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=slave, env=environment, **subprocess_claim())
    except OSError as error:
        os.close(master)
        os.close(slave)
        raise PreflightUnavailable('投稿程序尚不可用') from error
    except Exception:
        os.close(master)
        os.close(slave)
        raise
    os.close(slave)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, 'stderr')
    selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
    captured = {'stdout': bytearray(), 'stderr': bytearray()}
    progress = UploadProgress(file, job)
    started = time.monotonic()

    def append_tail(target, data):
        target.extend(data)
        if len(target) > 4 * 1024 * 1024:
            del target[:-4 * 1024 * 1024]

    try:
        while selector.get_map():
            for key, _ in selector.select(timeout=0.5):
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if key.data == 'stderr' and error.errno == errno.EIO:
                        chunk = b''
                    else:
                        raise
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                append_tail(captured[key.data], chunk)
                progress.feed(key.data, chunk)
            progress.flush()
            if time.monotonic() - started >= 8 * 3600:
                process.kill()
                process.wait()
                raise TimeoutError('biliupR 上传超过 8 小时。')
        progress.finish()
        try:
            returncode = process.wait(timeout=max(1, 8 * 3600 - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise TimeoutError('biliupR 上传超过 8 小时。')
        return subprocess.CompletedProcess(args, returncode,
            bytes(captured['stdout']), bytes(captured['stderr']))
    finally:
        selector.close()
        process.stdout.close()
        os.close(master)


def bilibili_request(path, method='GET', payload=None):
    cookies = json.loads(Path(COOKIE).read_text(encoding='utf-8'))['cookie_info']['cookies']
    values = {item['name']: item['value'] for item in cookies}
    if 'SESSDATA' not in values or 'bili_jct' not in values:
        raise ValueError('缺少合集操作所需的 Cookie')
    headers = {
        'Cookie': '; '.join(f'{name}={value}' for name, value in values.items()),
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://member.bilibili.com/platform/upload-manager/ep',
    }
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        path += ('&' if '?' in path else '?') + urllib.parse.urlencode({'csrf': values['bili_jct']})
    # Only this fixed read-only identity path is sent to the account API.
    origin = 'https://api.bilibili.com' if path == '/x/space/myinfo' and method == 'GET' and payload is None else 'https://member.bilibili.com'
    request = urllib.request.Request(origin + path,
                                     data=data, headers=headers, method=method)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError('合集响应过大')
        result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError('合集响应格式无效')
    if result.get('code') != 0:
        raise RuntimeError(f'合集接口返回错误码 {result.get("code")}')
    return result.get('data') or {}


def collection_preflight():
    """Conservative read-only identity/ownership/eligibility before any upload.

    The section endpoint alone is insufficient: it can expose other users'
    sections. Ownership and actual season/section state remain mandatory.
    The official creator frontend uses `checkin` for optional viewer check-in
    settings, not upload eligibility. Do not mistake it for collection review.
    # Evidence: official creativecenter-v3.608.087b8a68.js, handleCheckin /
    # getCheckinStatus / onEpEditClick (2026-10-01); sha256 ff5bef6a162cdaa4.
    No mutation is used as a probe.
    """
    if type(SEASON_ID) is not int or type(SECTION_ID) is not int or SEASON_ID <= 0 or SECTION_ID <= 0:
        raise ValueError('足球合集和小节尚未配置')
    credentials = json.loads(Path(COOKIE).read_text(encoding='utf-8'))
    expected_mid = (credentials.get('token_info') or {}).get('mid')
    if type(expected_mid) is not int or expected_mid <= 0:
        raise ValueError('登录账号身份无法确认')
    identity = bilibili_request('/x/space/myinfo')
    if type(identity.get('mid')) is not int or identity['mid'] != expected_mid:
        raise ValueError('登录账号身份不一致')
    found = None
    for page in range(1, 11):  # Bounded management-list search, never public guesses.
        listing = bilibili_request(f'/x2/creative/web/seasons?pn={page}&ps=50')
        seasons, total = listing.get('seasons'), listing.get('total')
        if not isinstance(seasons, list) or len(seasons) > 50 or type(total) is not int or total < 0:
            raise ValueError('无法核实账号的合集列表')
        matches = [item for item in seasons if isinstance(item, dict) and isinstance(item.get('season'), dict)
                   and item['season'].get('id') == SEASON_ID]
        if len(matches) > 1:
            raise ValueError('合集信息不明确')
        if matches:
            found = matches[0]
            break
        if not seasons or page * 50 >= total:
            break
    if found is None:
        raise ValueError('当前账号没有配置的足球合集权限，请连接拥有足球合集的账号')
    season = found['season']
    if season.get('title') != '足球':
        raise ValueError('配置的合集名称不是足球，请检查服务器的足球合集配置')
    if type(season.get('mid')) is not int or season['mid'] != expected_mid:
        raise ValueError('足球合集不属于当前登录账号')
    if any(type(season.get(key)) is not int or season[key] != 0 for key in ('state', 'forbid')):
        raise ValueError('合集尚未处于可用状态')
    sections = (found.get('sections') or {}).get('sections')
    if not isinstance(sections, list):
        raise ValueError('合集小节列表无法确认')
    matches = [item for item in sections if isinstance(item, dict) and item.get('id') == SECTION_ID]
    if len(matches) != 1 or matches[0].get('seasonId') != SEASON_ID or type(matches[0].get('state')) is not int or matches[0]['state'] != 0:
        raise ValueError('小节不属于此合集或不可用')
    details = bilibili_request(f'/x2/creative/web/season/section?id={SECTION_ID}')
    section = details.get('section') or {}
    if section.get('id') != SECTION_ID or section.get('seasonId') != SEASON_ID or type(section.get('state')) is not int or section['state'] != 0:
        raise ValueError('合集小节关系未确认')
    return details


def ensure_football_collection(bvid, title):
    if SEASON_ID <= 0 or SECTION_ID <= 0:
        raise ValueError('足球合集 ID 未配置')
    path = f'/x2/creative/web/season/section?id={SECTION_ID}'
    section = collection_preflight()
    if any(item.get('bvid') == bvid for item in section.get('episodes') or []):
        return
    result = subprocess.run([BINARY, '-u', COOKIE, 'show', bvid], capture_output=True, timeout=30, **subprocess_claim())
    if result.returncode != 0:
        raise RuntimeError('无法读取已投稿视频信息')
    output = result.stdout.decode('utf-8', errors='replace')
    details = json.loads(output[output.find('{'):output.rfind('}') + 1])
    aid = details['archive']['aid']
    videos = details['videos']
    if details['archive']['bvid'] != bvid or len(videos) != 1:
        raise ValueError('投稿视频信息与任务不一致')
    bilibili_request('/x2/creative/web/season/section/episodes/add', method='POST', payload={
        'sectionId': SECTION_ID,
        'episodes': [{'aid': aid, 'cid': videos[0]['cid'], 'title': title, 'charging_pay': 0}],
    })
    if not any(item.get('bvid') == bvid for item in bilibili_request(path).get('episodes') or []):
        raise RuntimeError('合集接口返回成功，但未查到该视频')


def upload(file, job):
    job['preflightComponent'] = 'source'
    filename = job['filename']
    relative = Path(filename)
    allowed = (len(relative.parts) == 1 or
               (len(relative.parts) == 2 and re.fullmatch(r'camera_[a-f0-9]{16}', relative.parts[0])))
    video = ROOT / relative
    if not allowed or relative.is_absolute() or '..' in relative.parts or not filename.lower().endswith('.mp4') or video.is_symlink() or video.resolve().parent not in (ROOT, *(p for p in ROOT.glob('camera_*') if p.is_dir() and not p.is_symlink())):
        raise ValueError('无效视频路径')
    if not video.is_file() or not source_matches(video, job):
        raise ValueError('成品已改名、删除或修改，请重新准备投稿')
    job['preflightComponent'] = 'cover'
    if not COVER or not Path(COVER).is_file():
        raise PreflightUnavailable('固定封面文件未配置或不存在')
    job['preflightComponent'] = 'tags'
    tags = job.get('tags', ['足球'])
    if (not isinstance(tags, list) or not 1 <= len(tags) <= 10
            or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 20
                   or re.search(r'[,\x00-\x1f\x7f]', tag) for tag in tags)):
        raise ValueError('投稿标签无效')
    tags = list(dict.fromkeys(['足球'] + [tag.strip() for tag in tags if tag.strip() != '足球']))
    if len(tags) > 10:
        raise ValueError('投稿标签过多')
    # This must succeed before the remote_started checkpoint and CLI launch.
    job['preflightComponent'] = 'collection'
    collection_preflight()
    job.pop('preflightComponent', None)
    # 与本机既有 bili_upload.sh 使用同一投稿接口；网页 Cookie 可正常列稿件。
    args = [BINARY, '-u', COOKIE, 'upload', '--submit', 'web', '--copyright', '1',
            '--title', job['title'], '--tid', '249', '--tag', ','.join(tags), '--cover', COVER,
            '--is-only-self', '1', str(video)]
    # 原始日志可能包含登录响应，只在内存里解析稿件号，不保存或返回给模型。
    # Persist the ambiguity boundary before the CLI can touch the platform.
    job.update(uploadPhase='remote_started', startedAt=timestamp(), stage='preparing',
               stagePercent=None, progress=None, progressUnit='bytes', totalBytes=None,
               uploadedBytes=None, uploadSpeed=None, progressUpdatedAt=int(time.time() * 1000),
               message='正在连接投稿平台，等待上传进度')
    save(file, job)
    result = run_upload(args, file, job)
    if result.returncode != 0:
        code, detail = safe_failure(result)
        job.update(errorCode=code, errorDetail=detail, exitCode=result.returncode)
        raise RuntimeError(detail)
    text = result.stdout.decode('utf-8', errors='replace') + result.stderr.decode('utf-8', errors='replace')
    bvid = re.search(r'BV[0-9A-Za-z]{10}', text)
    job.update(progress=100 if bvid else None, stage=None, stagePercent=None,
               uploadSpeed=None, progressUpdatedAt=int(time.time() * 1000),
               status='completed' if bvid else 'unknown', message='已投稿，等待平台审核' if bvid else '命令已结束，但没有确认到稿件号，请检查平台稿件后再决定是否重试', bvid=bvid.group(0) if bvid else None)
    if bvid:
        job.update(uploadPhase='submitted', completedAt=timestamp(), collectionStatus='pending')
        save(file, job)  # 先持久化 BV 号；后续合集操作失败也绝不能重传视频。
        try:
            ensure_football_collection(bvid.group(0), job['title'])
            job.update(collectionStatus='completed', collectionName='足球', message='已投稿并加入足球合集，等待平台审核')
        except Exception:
            job.update(collectionStatus='error', message='视频已投稿，但加入足球合集未确认；请检查合集，不要重新上传视频')


def valid_bvid(value):
    return isinstance(value, str) and bool(re.fullmatch(r'BV[0-9A-Za-z]{10}', value))


def verify_submission(job):
    """Verify a recorded ID, never search by a potentially duplicated title."""
    result = subprocess.run([BINARY, '-u', COOKIE, 'show', job['bvid']],
                            capture_output=True, timeout=30, **subprocess_claim())
    if result.returncode != 0:
        return False
    output = result.stdout.decode('utf-8', errors='replace')
    details = json.loads(output[output.find('{'):output.rfind('}') + 1])
    archive = details.get('archive') or {}
    return (archive.get('bvid') == job['bvid'] and archive.get('title') == job.get('title')
            and len(details.get('videos') or []) == 1)


def recover_job(file, job):
    """Called only while holding the job lock; terminal history is preserved."""
    if job.get('status') not in ('queued', 'uploading', 'unknown'):
        return
    legacy_claim = file.with_suffix('.claim').exists()
    interrupted = job.get('status') == 'uploading' or legacy_claim
    if valid_bvid(job.get('bvid')):
        if time.time() < job.get('reconcileAt', 0):
            return
        try:
            verified = verify_submission(job)
        except Exception:
            verified = False
        if verified:
            job.update(status='completed', uploadPhase='submitted', stage=None, stagePercent=None, progress=100,
                       uploadSpeed=None, collectionStatus=job.get('collectionStatus') or 'pending',
                       message='已核实已投稿稿件，恢复后续合集处理', recoveredAt=timestamp())
        else:
            job.update(status='unknown', message='已有稿件号，等待核实平台结果；不会重新上传', reconcileAt=time.time() + 60)
        save(file, job)
        return
    # Only our explicit preflight checkpoint, or a pristine legacy queue item,
    # proves the CLI never ran. Old claims/unknown states are not such proof.
    if job.get('uploadPhase') == 'preflight' and not legacy_claim:
        if job.get('status') != 'queued':
            job.update(status='queued', message='已恢复尚未开始上传的任务，等待自动重试', recoveredAt=timestamp())
            save(file, job)
    elif interrupted or job.get('uploadPhase') not in (None, 'queued', 'preflight'):
        if job.get('status') != 'unknown':
            job.update(status='unknown', message='上传进程中断，平台结果待核实；不会自动重复投稿')
            save(file, job)


def recover_collection(file, job):
    if (job.get('status') != 'completed' or not valid_bvid(job.get('bvid'))
            or job.get('collectionStatus') not in ('pending', 'error')
            or time.time() < job.get('collectionRetryAt', 0)):
        return
    try:
        # This checks membership before adding; never uploads the video again.
        ensure_football_collection(job['bvid'], job['title'])
        job.update(collectionStatus='completed', collectionName='足球', message='已投稿并加入足球合集，等待平台审核')
        job.pop('collectionRetryAt', None)
    except Exception:
        job.update(collectionStatus='pending', collectionRetryAt=time.time() + 60,
                   message='视频已投稿，稍后自动核实并恢复足球合集；不会重新上传视频')
    save(file, job)


def process_queue():
    for file in sorted(JOBS.glob('*.json')):
        try:
            with account_lock(JOBS.parent) as account_available, claim_job(file) as claimed:
                if not account_available or not claimed:
                    continue
                job = json.loads(file.read_text(encoding='utf-8'))
                if not connection_matches(file, job):
                    continue
                recover_job(file, job)
                recover_collection(file, job)
                if job.get('status') != 'queued' or time.time() < job.get('retryAt', 0):
                    continue
                job.update(status='uploading', uploadPhase='preflight', stage='preparing', stagePercent=None,
                           progress=None, uploadSpeed=None, message='正在检查投稿文件')
                save(file, job)
                try:
                    upload(file, job)
                except PreflightUnavailable:
                    wait_before_upload(file, job, '本地封面、投稿程序或目录暂不可用，稍后自动重试')
                    continue
                except Exception as error:
                    if job.get('uploadPhase') == 'preflight':
                        code, detail = preflight_failure(error, job.get('preflightComponent'))
                        job.update(errorCode=code, errorDetail=detail)
                    elif not job.get('errorCode'):
                        job.update(errorCode=type(error).__name__, errorDetail='本地校验或执行失败')
                    if valid_bvid(job.get('bvid')) and job.get('uploadPhase') == 'submitted':
                        # A checkpoint/collection failure cannot erase a known
                        # successful submission and authorize a second upload.
                        job.update(status='completed', collectionStatus=job.get('collectionStatus') or 'pending',
                                   message='视频已投稿，等待恢复后续合集处理；不会重新上传视频')
                    else:
                        ambiguous = job.get('uploadPhase') == 'remote_started'
                        job.update(status='unknown' if ambiguous else 'error', message=(
                            '投稿过程已启动但结果未确认；请检查平台稿件，不会自动重复投稿' if ambiguous
                            else job.get('errorDetail', '投稿启动前校验失败') + '；没有启动上传'))
                if job.get('status') in ('error', 'unknown'):
                    job.update(stage=None, stagePercent=None, uploadSpeed=None)
                save(file, job)
        except Exception:
            # Never log queue contents, raw CLI output or cookies.
            print('投稿队列处理失败，请检查任务文件与目录权限', flush=True)


def publish_worker_status():
    """Only local prerequisite checks; never read/return cookie contents or run login."""
    binary = shutil.which(BINARY)
    cookie = Path(COOKIE)
    value = dict(checkedAt=time.time(), binaryAvailable=bool(binary),
                 credentialsPresent=cookie.is_file() and os.access(cookie, os.R_OK) and cookie.stat().st_size > 0,
                 coverAvailable=bool(COVER and Path(COVER).is_file()))
    temporary = JOBS.parent / ('worker-status.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle)
        os.replace(temporary, JOBS.parent / 'worker-status.json')
    finally:
        temporary.unlink(missing_ok=True)


def heartbeat():
    while True:
        try:
            publish_worker_status()
        except Exception:
            # Observations expire closed; never log local credential paths.
            pass
        time.sleep(15)


def main():
    JOBS.mkdir(parents=True, exist_ok=True, mode=0o700)
    with named_lock(JOBS.parent / 'worker.lock') as owned:
        if not owned:
            raise SystemExit('Uploader worker already active')
        threading.Thread(target=heartbeat, daemon=True).start()
        while True:
            process_queue()
            time.sleep(3)


if __name__ == "__main__":
    main()

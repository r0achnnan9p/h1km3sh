#!/usr/bin/env python3
"""主机执行 cloudpan189-go；队列只保存成片相对路径和目标目录。"""
import json
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid

from upload_worker_state import connection_matches, account_lock, named_lock, claim_job, save, source_matches, subprocess_claim, timestamp, wait_before_upload

ROOT = Path(os.environ['HIKVISION_DOWNLOADS_DIR']).resolve()
WORK = ROOT / 'cloud189_work'
JOBS = WORK / 'jobs'
BINARY = os.environ.get('CLOUD189_BINARY', 'cloudpan189-go')
BACKEND = os.environ.get('CLOUD189_BACKEND', 'tickstep')
CONFIG = os.environ.get('CLOUD189_CONFIG_FILE', '')
CAMERA_DIR = re.compile(r'camera_[a-f0-9]{16}$')
REMOTE_DIR = re.compile(r'/[\w\u3400-\u9fff _./()（）-]{1,300}$')


def safe_video(relative, expected_size):
    candidate = Path(relative)
    if candidate.is_absolute() or '..' in candidate.parts or len(candidate.parts) not in (1, 2):
        return None
    if len(candidate.parts) == 2 and not CAMERA_DIR.fullmatch(candidate.parts[0]):
        return None
    if not candidate.name.lower().endswith('.mp4'):
        return None
    unresolved = ROOT / candidate
    try:
        unresolved_stat = unresolved.lstat()
        parent_stat = unresolved.parent.lstat()
        video = unresolved.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    if stat.S_ISLNK(unresolved_stat.st_mode) or not stat.S_ISREG(unresolved_stat.st_mode) or stat.S_ISLNK(parent_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode):
        return None
    if video.parent not in (ROOT, *(p.resolve() for p in ROOT.glob('camera_*') if p.is_dir() and not p.is_symlink())):
        return None
    try:
        video_stat = video.stat()
    except OSError:
        return None
    if not video.is_file() or video_stat.st_size != expected_size:
        return None
    return video


def safe_target(value):
    if (not isinstance(value, str) or not value.startswith('/') or value.startswith('//')
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        return False
    pure = PurePosixPath(value)
    return '..' not in pure.parts and str(pure) == value and bool(REMOTE_DIR.fullmatch(value))


def atomic_status(value):
    WORK.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = WORK / ('worker-status.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.chmod(temporary, 0o600)
    os.replace(temporary, WORK / 'worker-status.json')



class CloudCommandError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def run_json(binary, arguments, timeout=30):
    """Only fixed cloud189 commands; neither raw output nor config is published."""
    if not CONFIG or not Path(CONFIG).is_absolute():
        raise ValueError('Private cloud config unavailable')
    result = subprocess.run([binary, '--config', CONFIG, '--json', *arguments],
                            stdin=subprocess.DEVNULL, capture_output=True,
                            timeout=timeout, check=False, **subprocess_claim())
    if result.returncode != 0:
        # Upstream emits its error object on stderr, not stdout. Never persist
        # raw errors: they can contain signed URLs, headers, or private paths.
        raise CloudCommandError('CLOUD_CLI_FAILED')
    if not isinstance(result.stdout, bytes) or len(result.stdout) > 1024 * 1024:
        raise CloudCommandError('CLOUD_RESULT_TOO_LARGE')
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise CloudCommandError('CLOUD_RESULT_INVALID_JSON') from None


def valid_directory(value, target):
    return (isinstance(value, dict) and value.get('path') == target
            and value.get('name') == PurePosixPath(target).name
            and value.get('is_dir') is True and isinstance(value.get('file_id'), str)
            and bool(re.fullmatch(r'[0-9]{1,40}', value['file_id'])))


def ensure_managed_target(binary, target):
    parent = run_json(binary, ['stat', target])
    if parent is None and target == '/H1kM3sh':
        # User-approved fixed upload destination only. mkdir has no stdout JSON
        # on success in v0.7.0. Never interpret login/network failure as absence.
        # A failed mkdir can mean a concurrent creator won; stat remains authority.
        result = subprocess.run([binary, '--config', CONFIG, '--json', 'mkdir', '/H1kM3sh'],
                                stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=30, check=False, **subprocess_claim())
        parent = run_json(binary, ['stat', target])
        if not valid_directory(parent, target):
            raise CloudCommandError('CLOUD_TARGET_CREATE_UNVERIFIED')
    return parent


def remote_path(job):
    return str(PurePosixPath(job['targetPath']) / Path(job['filename']).name)


def file_checksum(video):
    digest = hashlib.md5()
    with video.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def valid_entry(value, destination, size, checksum):
    return (isinstance(value, dict) and value.get('path') == destination
            and value.get('name') == PurePosixPath(destination).name
            and value.get('is_dir') is False and type(value.get('size')) is int
            and value['size'] == size and isinstance(value.get('file_id'), str)
            and bool(re.fullmatch(r'[0-9]{1,40}', value['file_id']))
            and isinstance(value.get('checksum'), str)
            and bool(re.fullmatch(r'[a-fA-F0-9]{32}', value['checksum']))
            and value['checksum'].lower() == checksum)


def confirmed_managed_receipt(job):
    receipt = job.get('uploadReceipt')
    if not isinstance(receipt, dict) or not isinstance(job.get('filename'), str):
        return False
    return (receipt.get('provider') == 'cloud189' and receipt.get('backend') == 'gowsp-0.7.0'
            and ((receipt.get('outcome') == 'remote_verified' and receipt.get('exitCode') == 0)
                 or (receipt.get('outcome') == 'remote_reconciled' and receipt.get('exitCode') is None))
            and receipt.get('filename') == job.get('filename')
            and receipt.get('size') == job.get('size') and type(job.get('size')) is int
            and job['size'] > 0 and safe_target(job.get('targetPath'))
            and receipt.get('targetPath') == job.get('targetPath')
            and isinstance(receipt.get('checksum'), str)
            and bool(re.fullmatch(r'[a-f0-9]{32}', receipt['checksum']))
            and valid_entry(receipt.get('remote'), remote_path(job), job['size'], receipt['checksum']))


def run_managed_job(file, job, binary, video, target):
    destination = remote_path(job)
    try:
        checksum = file_checksum(video)
        if not source_matches(video, job):
            raise ValueError('Source changed while checksumming')
        parent = ensure_managed_target(binary, target)
        if parent is None:
            job.update(status='error', uploadPhase='preflight', errorCode='CLOUD_TARGET_MISSING',
                       message='云盘目标目录不存在，没有开始上传')
            save(file, job)
            return
        if not valid_directory(parent, target):
            job.update(status='error', uploadPhase='preflight', errorCode='CLOUD_TARGET_INVALID',
                       message='云盘目标不是有效目录，没有开始上传')
            save(file, job)
            return
        existing = run_json(binary, ['stat', destination])
        if not source_matches(video, job):
            raise ValueError('Source changed during preflight')
        if existing is not None:
            job.update(status='error', uploadPhase='preflight',
                       message='目标已有同名内容，尚未上传；请选择其他名称或目录，不会覆盖')
            save(file, job)
            return
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired, RuntimeError):
        wait_before_upload(file, job, '上传账号或目标检查暂不可用，没有开始上传')
        return
    except Exception:
        job.update(status='error', uploadPhase='preflight', message='上传前校验失败，没有开始上传')
        save(file, job)
        return
    # Persist ambiguity BEFORE launching any command that can upload bytes.
    job.update(status='uploading', uploadPhase='remote_started', startedAt=timestamp(),
               message='正在上传到天翼云盘；等待平台文件校验')
    save(file, job)
    try:
        uploaded = run_json(binary, ['up', '--input', str(video), '--path', destination,
                                    '--policy', 'skip'], timeout=8 * 60 * 60)
        if not source_matches(video, job) or not valid_entry(uploaded, destination, job['size'], checksum):
            raise ValueError('Unverified upload result')
        verified = run_json(binary, ['stat', destination])
        if not valid_entry(verified, destination, job['size'], checksum) or verified['file_id'] != uploaded['file_id']:
            raise ValueError('Remote verification mismatch')
    except CloudCommandError as error:
        job.update(status='unknown', errorCode=error.code,
                   message='云盘程序执行或结果解析失败，结果待核实；不会自动重传')
    except (FileNotFoundError, PermissionError):
        # This block also covers the post-upload stat; conservatively preserve ambiguity.
        job.update(status='unknown', message='上传执行或校验中断，结果待核实；不会自动重传')
    except Exception:
        job.update(status='unknown', message='上传结果尚未核实，请检查云盘；不会自动重传')
    else:
        # Store only an allowlisted receipt, never a complete provider response.
        remote = {key: verified[key] for key in ('path', 'name', 'size', 'is_dir', 'file_id', 'checksum')}
        remote['checksum'] = remote['checksum'].lower()
        job.update(status='completed', uploadPhase='completed', completedAt=timestamp(),
                   uploadReceipt={'provider': 'cloud189', 'backend': 'gowsp-0.7.0',
                                  'outcome': 'remote_verified', 'exitCode': 0,
                                  'filename': job['filename'], 'size': job['size'],
                                  'targetPath': target, 'checksum': checksum, 'remote': remote},
                   message='已核实云盘文件、大小与校验值')
    save(file, job)



def verify_managed_job(job_id, binary, *, retry=False):
    """Owner reconciliation, or an explicitly confirmed retry after fresh absence.

    This helper never uploads. The default only verifies; retry=True may enqueue
    a new attempt after preserving the original unknown result in its history.
    Caller must be the authenticated app flow, and must use the pinned binary,
    private config, and mandatory connection-generation environment. No arbitrary
    source/config/target arguments are accepted. Returns only fixed status codes.
    """
    if (BACKEND != 'gowsp' or os.environ.get('HIKCLIP_UPLOAD_GENERATION_REQUIRED') != '1'
            or not isinstance(job_id, str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', job_id)):
        return {'ok': False, 'code': 'VERIFY_NOT_AVAILABLE'}
    file = JOBS / (job_id + '.json')
    try:
        if file.is_symlink() or not file.is_file():
            return {'ok': False, 'code': 'VERIFY_NOT_AVAILABLE'}
        with account_lock(WORK) as available, claim_job(file) as claimed:
            if not available or not claimed:
                return {'ok': False, 'code': 'VERIFY_BUSY'}
            job = json.loads(file.read_text(encoding='utf-8'))
            if job.get('provider') != 'cloud189' or job.get('id') != job_id or job.get('status') != 'unknown' or job.get('uploadPhase') != 'remote_started' or job.get('archivedAt'):
                return {'ok': False, 'code': 'VERIFY_NOT_ELIGIBLE'}
            if not connection_matches(file, job):
                return {'ok': False, 'code': 'ACCOUNT_CHANGED'}
            video = safe_video(job.get('sourceFilename', job.get('filename', '')), job.get('size'))
            target = job.get('targetPath')
            if (video is None or not isinstance(job.get('sourceIdentity'), dict)
                    or not safe_target(target) or not source_matches(video, job)):
                return {'ok': False, 'code': 'VERIFY_SOURCE_CHANGED'}
            checksum = file_checksum(video)
            if not source_matches(video, job):
                return {'ok': False, 'code': 'VERIFY_SOURCE_CHANGED'}
            destination = remote_path(job)
            verified = run_json(binary, ['stat', destination])
            if verified is None:
                parent = run_json(binary, ['stat', target])
                if parent is not None and not valid_directory(parent, target):
                    return {'ok': False, 'code': 'VERIFY_UNAVAILABLE'}
                code = 'CLOUD_TARGET_MISSING' if parent is None else 'CLOUD_FILE_NOT_FOUND'
                # Absence now never proves a past upload did not occur. A fresh,
                # explicit owner retry may start a NEW attempt, retaining that
                # original unknown outcome rather than inventing past failure.
                job.update(lastVerificationAt=timestamp(), verificationCode=code)
                if retry:
                    if parent is None and target != '/H1kM3sh':
                        save(file, job)
                        return {'ok': False, 'code': code}
                    if run_json(binary, ['stat', destination]) is not None:
                        return {'ok': False, 'code': 'CLOUD_REMOTE_MISMATCH'}
                    if not source_matches(video, job):
                        return {'ok': False, 'code': 'VERIFY_SOURCE_CHANGED'}
                    if not connection_matches(file, job):
                        return {'ok': False, 'code': 'ACCOUNT_CHANGED'}
                    history = job.get('attemptHistory', [])
                    if not isinstance(history, list) or len(history) >= 100:
                        return {'ok': False, 'code': 'VERIFY_NOT_ELIGIBLE'}
                    prior = {key: job[key] for key in ('status', 'uploadPhase', 'createdAt', 'startedAt',
                        'completedAt', 'message', 'errorCode', 'verificationCode', 'lastVerificationAt',
                        'uploadReceipt', 'archivedAt') if key in job}
                    prior['endedBy'] = 'owner_retry_after_remote_absence'
                    prior['recordedAt'] = timestamp()
                    job['attemptHistory'] = [*history, prior]
                    for key in ('startedAt', 'completedAt', 'errorCode', 'uploadReceipt', 'archivedAt',
                                'retryAt', 'preflightAttempts', 'archiveReason'):
                        job.pop(key, None)
                    job.update(status='queued', uploadPhase='preflight', retryCount=len(history) + 1,
                               retryRequestedAt=timestamp(), message='已确认原目标目前无文件，等待重新上传；上次结果仍保留为待确认')
                    save(file, job)
                    return {'ok': True, 'code': 'CLOUD_RETRY_QUEUED'}
                save(file, job)
                return {'ok': False, 'code': code}
            if not valid_entry(verified, destination, job['size'], checksum):
                return {'ok': False, 'code': 'CLOUD_REMOTE_MISMATCH'}
            second = run_json(binary, ['stat', destination])
            if (not source_matches(video, job) or not valid_entry(second, destination, job['size'], checksum)
                    or second['file_id'] != verified['file_id']):
                return {'ok': False, 'code': 'CLOUD_REMOTE_MISMATCH'}
            remote = {key: second[key] for key in ('path', 'name', 'size', 'is_dir', 'file_id', 'checksum')}
            remote['checksum'] = remote['checksum'].lower()
            # exitCode is intentionally null: the original CLI outcome is unknown.
            # Keep distinct verification provenance, never invent exit-code evidence.
            job.pop('archivedAt', None)
            job.pop('archiveReason', None)
            job.update(status='completed', uploadPhase='completed', completedAt=timestamp(),
                       verificationCode='CLOUD_REMOTE_VERIFIED', lastVerificationAt=timestamp(),
                       uploadReceipt={'provider': 'cloud189', 'backend': 'gowsp-0.7.0',
                           'outcome': 'remote_reconciled', 'exitCode': None,
                           'filename': job['filename'], 'size': job['size'],
                           'targetPath': target, 'checksum': checksum, 'remote': remote},
                       message='已只读核实云盘文件、大小与校验值；未重新上传')
            job.pop('errorCode', None)
            save(file, job)
            return {'ok': True, 'code': 'CLOUD_REMOTE_VERIFIED'}
    except Exception:
        return {'ok': False, 'code': 'VERIFY_UNAVAILABLE'}


def archive_managed_job(job_id, *, restore=False):
    """Reversible owner dismissal, with no provider call or status rewriting.

    Taking BOTH the provider and job locks proves no inherited upload command is
    still using the source. Never delete lock files or infer staleness from age.
    """
    if (os.environ.get('HIKCLIP_UPLOAD_GENERATION_REQUIRED') != '1'
            or not isinstance(job_id, str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', job_id)):
        return {'ok': False, 'code': 'VERIFY_NOT_AVAILABLE'}
    file = JOBS / (job_id + '.json')
    try:
        if file.is_symlink() or not file.is_file():
            return {'ok': False, 'code': 'VERIFY_NOT_AVAILABLE'}
        with account_lock(WORK) as available, claim_job(file) as claimed:
            if not available or not claimed:
                return {'ok': False, 'code': 'VERIFY_BUSY'}
            job = json.loads(file.read_text(encoding='utf-8'))
            if (job.get('provider') != 'cloud189' or job.get('id') != job_id
                    or job.get('status') != 'unknown' or job.get('uploadPhase') != 'remote_started'):
                return {'ok': False, 'code': 'VERIFY_NOT_ELIGIBLE'}
            if restore:
                job.pop('archivedAt', None)
                job.pop('archiveReason', None)
            else:
                job.setdefault('archivedAt', timestamp())
                job['archiveReason'] = 'owner_dismissed'
            save(file, job)
            return {'ok': True, 'code': 'CLOUD_RECORD_RESTORED' if restore else 'CLOUD_RECORD_ARCHIVED'}
    except Exception:
        return {'ok': False, 'code': 'VERIFY_UNAVAILABLE'}


def login_ready(binary):
    if BACKEND == 'gowsp':
        try:
            with account_lock(WORK) as available:
                if not available:
                    return False
                value = run_json(binary, ['df', '/'], timeout=15)
                return (isinstance(value, dict) and value.get('ok') is True
                        and all(isinstance(value.get(k), int) and not isinstance(value[k], bool)
                                and value[k] >= 0 for k in ('capacity', 'available')))
        except Exception:
            return False
    try:
        result = subprocess.run([binary, 'who'], capture_output=True, timeout=15, check=False)
        output = (result.stdout + result.stderr).decode('utf-8', errors='replace').strip().lower()
        unauthenticated = ('未登录', '请先登录', 'not logged', 'no account', 'no user', '登录后')
        return result.returncode == 0 and bool(output) and not any(term in output for term in unauthenticated)
    except Exception:
        return False


def run_job(file, job, binary):
    filename = job.get('sourceFilename', job.get('filename', ''))
    video = safe_video(filename, job.get('size'))
    target = job.get('targetPath')
    if video is None or not source_matches(video, job) or not safe_target(target):
        job.update(status='error', uploadPhase='preflight', message='视频或目标目录校验失败，没有启动上传')
        save(file, job)
        return
    if BACKEND == 'gowsp':
        return run_managed_job(file, job, binary, video, target)
    job.update(status='uploading', uploadPhase='remote_started', startedAt=timestamp(),
               message='正在上传到天翼云盘；CLI 未提供可确认的字节进度')
    save(file, job)
    try:
        result = subprocess.run([binary, 'upload', str(video), target], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=8 * 60 * 60, check=False, **subprocess_claim())
    except (FileNotFoundError, PermissionError):
        wait_before_upload(file, job, '服务器上传程序暂不可用，没有启动上传，稍后自动重试')
        return
    except subprocess.TimeoutExpired:
        job.update(status='unknown', message='CLI 运行超时，上传结果待核实；请先检查云盘，避免重复上传')
    except Exception:
        job.update(status='unknown', message='CLI 执行异常，上传结果待核实；请先检查云盘，避免重复上传')
    else:
        if result.returncode == 0:
            job.update(status='completed', uploadPhase='completed', completedAt=timestamp(),
                       uploadReceipt={'provider': 'cloud189', 'outcome': 'cli_success', 'exitCode': 0,
                                      'filename': filename, 'size': job['size'], 'targetPath': target},
                       message='CLI 已完成上传')
        else:
            job.update(status='unknown', message='CLI 返回失败，云盘结果待核实；请先检查云盘，避免重复上传')
    save(file, job)


def confirmed_receipt(job):
    receipt = job.get('uploadReceipt')
    if BACKEND == 'gowsp':
        return confirmed_managed_receipt(job)
    return (isinstance(job.get('filename'), str) and bool(job['filename'])
            and isinstance(job.get('size'), int) and not isinstance(job['size'], bool) and job['size'] > 0
            and safe_target(job.get('targetPath'))
            and isinstance(receipt, dict) and receipt.get('provider') == 'cloud189'
            and receipt.get('outcome') == 'cli_success' and receipt.get('exitCode') == 0
            and receipt.get('filename') == job.get('filename') and receipt.get('size') == job.get('size')
            and receipt.get('targetPath') == job.get('targetPath'))


def recover_job(file, job):
    if job.get('status') not in ('queued', 'uploading', 'unknown'):
        return
    legacy_claim = file.with_suffix('.claim').exists()
    interrupted = job.get('status') == 'uploading' or legacy_claim
    if confirmed_receipt(job):
        job.update(status='completed', uploadPhase='completed', recoveredAt=timestamp(), message='已核实 CLI 上传完成记录')
        save(file, job)
    elif job.get('uploadPhase') == 'preflight' and not legacy_claim:
        if job.get('status') != 'queued':
            job.update(status='queued', recoveredAt=timestamp(), message='已恢复尚未开始上传的任务，等待自动重试')
            save(file, job)
    elif interrupted or job.get('uploadPhase') not in (None, 'queued', 'preflight'):
        if job.get('status') != 'unknown':
            job.update(status='unknown', message='上传进程中断，云盘结果待核实；不会自动重复上传')
            save(file, job)


def process_queue(binary, authenticated):
    for file in sorted(JOBS.glob('*.json')):
        try:
            with account_lock(WORK) as account_available, claim_job(file) as claimed:
                if not account_available or not claimed:
                    continue
                job = json.loads(file.read_text(encoding='utf-8'))
                if job.get('archivedAt'):
                    continue
                if not connection_matches(file, job):
                    continue
                recover_job(file, job)
                if job.get('status') != 'queued' or time.time() < job.get('retryAt', 0):
                    continue
                if not binary or not authenticated:
                    wait_before_upload(file, job, '上传程序或服务器登录态尚未就绪，等待就绪后自动上传')
                    continue
                job.update(status='uploading', uploadPhase='preflight', message='正在检查云盘上传文件')
                save(file, job)
                run_job(file, job, binary)
        except Exception:
            print('天翼云盘队列处理失败，请检查任务文件与目录权限', flush=True)


def worker_loop():
    JOBS.mkdir(parents=True, exist_ok=True, mode=0o700)
    last_auth_check = 0
    authenticated = False
    binary = None
    while True:
        now = time.time()
        if now - last_auth_check >= 60:
            binary = shutil.which(BINARY) or (BINARY if Path(BINARY).is_file() and os.access(BINARY, os.X_OK) else None)
            authenticated = bool(binary and login_ready(binary))
            last_auth_check = now
        atomic_status({'binaryAvailable': bool(binary), 'authenticated': authenticated, 'checkedAt': now})
        process_queue(binary, authenticated)
        time.sleep(3)


def main():
    with named_lock(WORK / 'worker.lock') as owned:
        if not owned:
            raise SystemExit('Uploader worker already active')
        worker_loop()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] in ('--verify-job', '--retry-job', '--archive-job', '--restore-job'):
        # Existing app service invokes with its pinned binary and private env.
        result = (archive_managed_job(sys.argv[2], restore=sys.argv[1] == '--restore-job')
                  if sys.argv[1] in ('--archive-job', '--restore-job')
                  else verify_managed_job(sys.argv[2], BINARY, retry=sys.argv[1] == '--retry-job'))
        print(json.dumps(result), flush=True)
        raise SystemExit(0 if result['ok'] else 2)
    if len(sys.argv) != 1:
        raise SystemExit('Unsupported operation')
    main()

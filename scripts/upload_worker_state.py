"""Durable upload checkpoints and process-scoped claims shared by host workers.

A claim is an advisory lock, not a stale-file marker. On POSIX the uploading
child inherits it, so a replacement worker cannot replay a still-running CLI.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import time
import uuid

_active_claim = None
_extra_claims = []


class PreflightUnavailable(Exception):
    """An upload prerequisite failed before the remote process started."""



def save(file, job):
    file = Path(file)
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(job, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        if os.name == 'posix':
            descriptor = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def claim_job(file):
    global _active_claim
    descriptor = os.open(Path(file).with_suffix('.lock'), os.O_RDWR | os.O_CREAT, 0o600)
    locked = False
    previous = _active_claim
    try:
        if os.name == 'posix':
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except BlockingIOError:
                pass
        elif os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'0')
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                locked = True
            except OSError:
                pass
        else:
            raise RuntimeError('Upload queue recovery requires advisory file locks')
        if locked:
            _active_claim = descriptor
        yield locked
    finally:
        _active_claim = previous
        # Do not unlink the lock inode, or explicitly unlock the shared open
        # file description: a CLI orphaned by a worker failure may still own it.
        os.close(descriptor)


def subprocess_claim():
    descriptors = tuple(([ _active_claim ] if _active_claim is not None else []) + _extra_claims)
    return {'pass_fds': descriptors} if descriptors and os.name == 'posix' else {}


def timestamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def source_matches(video, job):
    try:
        stat = video.stat()
    except OSError:
        return False
    if stat.st_size != job.get('size'):
        return False
    identity = job.get('sourceIdentity')
    if identity is None:  # Existing queues only stored file size.
        return True
    return (isinstance(identity, dict)
            and identity.get('size') == stat.st_size
            and identity.get('mtimeMs') == stat.st_mtime_ns // 1_000_000
            and identity.get('ino') == str(stat.st_ino)
            and identity.get('dev') == str(stat.st_dev))


def wait_before_upload(file, job, message):
    """Only call when the upload CLI is known not to have started."""
    attempts = job.get('preflightAttempts', 0) + 1
    job.update(status='queued', uploadPhase='preflight', preflightAttempts=attempts,
               retryAt=time.time() + min(300, 3 * (2 ** min(attempts, 7))), message=message)
    save(file, job)


@contextmanager
def named_lock(path, inherit=True):
    """Nonblocking shared lock inode; children keep it through a parent crash."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for component in (path, *path.parents):
        if component.is_symlink():
            raise RuntimeError('Refusing symlink in worker lock')
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    locked = False
    try:
        if os.name != 'posix':
            raise RuntimeError('Managed workers require POSIX locks')
        import fcntl
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError:
            pass
        if locked and inherit:
            _extra_claims.append(descriptor)
        yield locked
    finally:
        if locked and inherit:
            _extra_claims.remove(descriptor)
        # Never unlock or unlink: orphaned CLI still shares this description.
        os.close(descriptor)


@contextmanager
def account_lock(work):
    with named_lock(Path(work) / 'provider.lock') as locked:
        yield locked


def connection_matches(file, job):
    """Managed queues cannot migrate silently to a different QR-authorized account.

    Called while provider + job locks are held, BEFORE any remote recovery,
    collection operation or upload. Legacy unmanaged workers keep their contract.
    """
    if os.environ.get('HIKCLIP_UPLOAD_GENERATION_REQUIRED') != '1':
        return True
    pending_collection = job.get('status') == 'completed' and job.get('collectionStatus') in ('pending', 'error')
    if job.get('status') not in ('queued', 'uploading', 'unknown') and not pending_collection:
        return False  # Preserve finished history and prior terminal errors.
    generation = None
    try:
        import re
        import stat
        path = os.environ['HIKCLIP_UPLOAD_CONNECTION_FILE']
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 256 or info.st_mode & 0o077:
                raise ValueError('private binding')
            data = json.loads(os.read(fd, 257))
            if data.get('version') == 1 and re.fullmatch(r'[a-f0-9]{32}', data.get('generation') or ''):
                generation = data['generation']
        finally:
            os.close(fd)
    except Exception:
        pass
    if generation is not None and job.get('connectionGeneration') == generation:
        return True
    if job.get('errorCode') != 'ACCOUNT_CHANGED':
        job.update(errorCode='ACCOUNT_CHANGED', message='账号已改变或未绑定，请重新确认并提交；原任务不会自动上传')
        if job.get('status') == 'completed':
            if job.get('collectionStatus') in ('pending', 'error'):
                job['collectionStatus'] = 'error'
        elif job.get('status') == 'unknown' or job.get('uploadPhase') == 'remote_started':
            job['status'] = 'unknown'
        else:
            job.update(status='error', uploadPhase='preflight', stage=None, stagePercent=None)
        save(file, job)
    return False

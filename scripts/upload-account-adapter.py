#!/usr/bin/env python3
"""Pinned, QR-only CLI adapter. stdout is a small sanitized event protocol.

No raw subprocess output is logged or returned. A retained flock covers the
entire login/verification and the parent's atomic credential promotion. The
CLI inherits it so an orphan cannot race a replacement upload/login process.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import termios
import time
import urllib.error
import urllib.request

os.umask(0o077)
# A crashed Node parent must not leave an authentication CLI polling alone.
if sys.platform.startswith('linux'):
    import ctypes
    ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM)
    if os.getppid() == 1:
        sys.exit(1)
MAX_OUTPUT = 256 * 1024
MAX_FILE = 256 * 1024
DEADLINE = time.monotonic() + 300
child = None
cancelled = False


def emit(kind, **fields):
    print(json.dumps(dict(type=kind, **fields), separators=(',', ':')), flush=True)


def stop(_signal, _frame):
    global cancelled
    cancelled = True
    if child is not None and child.poll() is None:
        child.terminate()


for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop)


def read_json(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_size > MAX_FILE or meta.st_mode & 0o077:
            raise ValueError('private file')
        with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def verify_bilibili(file):
    value = read_json(file)
    cookies = value['cookie_info']['cookies']
    headers = {'Cookie': '; '.join(c['name'] + '=' + c['value'] for c in cookies),
               'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/'}
    req = urllib.request.Request('https://api.bilibili.com/x/space/myinfo', headers=headers)
    # Redirects must not forward the Cookie header to another origin.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
        body = response.read(MAX_OUTPUT + 1)
        if len(body) > MAX_OUTPUT:
            return False, 'VERIFY_FAILED'
        info = json.loads(body)
    if info.get('code') in (-101, -111, -400):
        return False, 'NEEDS_LOGIN'
    if info.get('code') != 0 or info.get('data', {}).get('mid') != value['token_info']['mid']:
        return False, 'VERIFY_FAILED'
    return True, None


def execute(provider, mode, binary, stage, credential, lock):
    global child
    if mode == 'disconnect':
        return True, None
    if mode == 'verify' and provider == 'bilibili':
        return verify_bilibili(credential)
    master = slave = None
    if provider == 'bilibili':
        # Node launches this helper as a session leader. The helper owns the
        # controlling tty; its CLI stays in the SAME killable process group.
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        args = [binary, '-u', credential, '--rust-log', 'error', 'login']
        child = subprocess.Popen(args, cwd=stage, stdin=slave, stdout=slave, stderr=slave, pass_fds=(lock,))
        os.close(slave)
    else:
        args = [binary, '--config', credential]
        args += ['qrlogin'] if mode == 'login' else ['--json', 'df', '/']
        child = subprocess.Popen(args, cwd=stage, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, pass_fds=(lock,))
    selector = selectors.DefaultSelector()
    if master is not None:
        selector.register(master, selectors.EVENT_READ, 'pty')
    else:
        selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    decoders = {kind: codecs.getincrementaldecoder('utf-8')(errors='ignore') for kind in ('pty', 'stdout', 'stderr')}
    recent = ''
    qr_line = ''
    stdout = bytearray()
    stderr = bytearray()
    count = 0
    menu_sent = qr_sent = False
    try:
        while child.poll() is None or selector.get_map():
            if cancelled or time.monotonic() >= DEADLINE:
                return False, 'LOGIN_FAILED' if mode == 'login' else 'VERIFY_FAILED'
            for key, _ in selector.select(0.1):
                try:
                    data = os.read(key.fd, 4096)
                except OSError:
                    data = b''
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                count += len(data)
                if count > MAX_OUTPUT:
                    return False, 'LOGIN_FAILED' if mode == 'login' else 'VERIFY_FAILED'
                text = decoders[key.data].decode(data)
                recent = (recent + text)[-8192:]
                if mode == 'verify' and key.data == 'stdout':
                    stdout.extend(data)
                if mode == 'verify' and key.data == 'stderr':
                    stderr.extend(data)
                if provider == 'bilibili' and not menu_sent and all(label in recent for label in ('选择一种登录方式', '短信登录', '扫码登录')):
                    # v1.2.2 default index 1 is SMS. Exactly one Down + Enter selects QR.
                    os.write(master, b'\x1b[B\r')
                    menu_sent = True
                if provider == 'cloud189' and mode == 'login' and key.data == 'stderr':
                    qr_line = (qr_line + text)[-8192:]
                    while '\n' in qr_line:
                        line, qr_line = qr_line.split('\n', 1)
                        match = re.search(r'https://open\.e\.189\.cn/api/logbox/oauth2/image\.do\?[^\s\x1b]+', line)
                        if match and not qr_sent:
                            emit('qr', source='url', url=match.group(0))
                            qr_sent = True
                    if 'unconfirmed' in recent:
                        emit('state', state='waiting_confirmation')
            if provider == 'bilibili' and menu_sent and not qr_sent and (Path(stage) / 'qrcode.png').is_file():
                # Wait until writing has finished; PNG validation also occurs in Node.
                png = Path(stage) / 'qrcode.png'
                if png.stat().st_size <= MAX_FILE and png.stat().st_size >= 45 and png.read_bytes().endswith(bytes.fromhex('0000000049454e44ae426082')):
                    emit('qr', source='file')
                    qr_sent = True
        code = child.wait(timeout=1)
        if code != 0:
            if mode == 'verify' and provider == 'cloud189':
                try:
                    error = json.loads(stderr).get('error', '')
                    if isinstance(error, str) and any(marker in error for marker in ('请先登录', '登录会话无效，请重新登录', '扫码不支持自动重新登录', 'InvalidSignature', 'InvalidSessionKey', 'InvalidAccessToken')):
                        return False, 'NEEDS_LOGIN'
                except Exception:
                    pass
            return False, 'LOGIN_FAILED' if mode == 'login' else 'VERIFY_FAILED'
        if mode == 'verify':
            result = json.loads(stdout)
            valid = result.get('ok') is True and all(isinstance(result.get(key), (int, float)) and not isinstance(result.get(key), bool) and result[key] >= 0 for key in ('capacity', 'available'))
            return valid, None if valid else 'VERIFY_FAILED'
        return True, None
    finally:
        selector.close()
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=1)
        if master is not None:
            # Closing our controlling tty sends SIGHUP to its session leader.
            # The CLI has already been reaped; this is not a user cancellation.
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            os.close(master)


def main():
    if len(sys.argv) != 7:
        return 2
    provider, mode, binary, stage, credential, lock_file = sys.argv[1:]
    if provider not in ('bilibili', 'cloud189') or mode not in ('login', 'verify', 'disconnect'):
        return 2
    if not all(os.path.isabs(v) for v in (binary, stage, credential, lock_file)):
        return 2
    lock = os.open(lock_file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            return 2
        os.fchmod(lock, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit('result', ok=False, code='PROVIDER_BUSY')
            return 1
        emit('locked')
        ready = selectors.DefaultSelector()
        ready.register(sys.stdin, selectors.EVENT_READ)
        try:
            while not cancelled and time.monotonic() < DEADLINE:
                if ready.select(0.1):
                    if sys.stdin.readline(32).strip() != 'go':
                        return 1
                    break
            else:
                return 1
        finally:
            ready.close()
        try:
            ok, code = execute(provider, mode, binary, stage, credential, lock)
        except Exception:
            ok, code = False, 'LOGIN_FAILED' if mode == 'login' else 'VERIFY_FAILED'
        if cancelled:
            return 1
        emit('result', ok=ok, code=code)
        # Retain the account lock until parent validates/promotes or terminates.
        selector = selectors.DefaultSelector()
        selector.register(sys.stdin, selectors.EVENT_READ)
        try:
            while not cancelled and time.monotonic() < DEADLINE:
                if selector.select(0.1):
                    sys.stdin.readline(32)
                    break
        finally:
            selector.close()
        return 0 if ok else 1
    finally:
        os.close(lock)


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Download one bounded DVR wall-clock range using an isolated native SDK."""
import ctypes as C
import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import sys
import time


class NET_DVR_TIME(C.Structure):
    _fields_ = [
        ('dwYear', C.c_uint32),
        ('dwMonth', C.c_uint32),
        ('dwDay', C.c_uint32),
        ('dwHour', C.c_uint32),
        ('dwMinute', C.c_uint32),
        ('dwSecond', C.c_uint32)
    ]


class NET_DVR_DEVICEINFO_V30(C.Structure):
    _fields_ = [
        ('sSerialNumber', C.c_uint8 * 48),
        ('byAlarmInPortNum', C.c_uint8),
        ('byAlarmOutPortNum', C.c_uint8),
        ('byDiskNum', C.c_uint8),
        ('byDVRType', C.c_uint8),
        ('byChanNum', C.c_uint8),
        ('byStartChan', C.c_uint8),
        ('byAudioChanNum', C.c_uint8),
        ('byIPChanNum', C.c_uint8),
        ('byZeroChanNum', C.c_uint8),
        ('byMainProto', C.c_uint8),
        ('bySubProto', C.c_uint8),
        ('bySupport', C.c_uint8),
        ('bySupport1', C.c_uint8),
        ('bySupport2', C.c_uint8),
        ('wDevType', C.c_uint16),
        ('bySupport3', C.c_uint8),
        ('byMultiStreamProto', C.c_uint8),
        ('byStartDChan', C.c_uint8),
        ('byStartDTalkChan', C.c_uint8),
        ('byHighDChanNum', C.c_uint8),
        ('bySupport4', C.c_uint8),
        ('byLanguageType', C.c_uint8),
        ('byVoiceInChanNum', C.c_uint8),
        ('byStartVoiceInChanNo', C.c_uint8),
        ('bySupport5', C.c_uint8),
        ('bySupport6', C.c_uint8),
        ('byMirrorChanNum', C.c_uint8),
        ('wStartMirrorChanNo', C.c_uint16),
        ('bySupport7', C.c_uint8),
        ('byRes2', C.c_uint8)
    ]


class NET_DVR_PLAYCOND(C.Structure):
    _fields_ = [
        ('dwChannel', C.c_uint32),
        ('struStartTime', NET_DVR_TIME),
        ('struStopTime', NET_DVR_TIME),
        ('byDrawFrame', C.c_uint8),
        ('byStreamType', C.c_uint8),
        ('byStreamID', C.c_uint8 * 32),
        ('byCourseFile', C.c_uint8),
        ('byDownload', C.c_uint8),
        ('byOptimalStreamType', C.c_uint8),
        ('byVODFileType', C.c_uint8),
        ('byRes', C.c_uint8 * 26)
    ]


class NET_DVR_LOCAL_SDK_PATH(C.Structure):
    _fields_ = [
        ('sPath', C.c_char * 256),
        ('byRes', C.c_uint8 * 128)
    ]

# HCNetSDK Linux V6.1.9 ABI, isolated from the HTTP process. Vendor libraries
# must be provisioned separately. Compact Z timestamps are DVR wall-clock values.

MAX_INPUT = 16384
MAX_BYTES = 8 * 1024 ** 3
PHASES = frozenset(('load', 'init_config', 'init', 'login', 'get_file', 'play_start',
                    'wait', 'osd', 'stop', 'logout', 'cleanup'))


class WorkerError(Exception):
    def __init__(self, code, sdk_code=None):
        self.code, self.sdk_code = code, sdk_code
        super().__init__(code)


def compact(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{8}T\d{6}Z', value):
        raise WorkerError('invalid_config')
    try:
        return dt.datetime.strptime(value, '%Y%m%dT%H%M%SZ')
    except ValueError:
        raise WorkerError('invalid_config') from None


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise WorkerError('invalid_config')
    return value


def validate(config):
    keys = {'sdkDir', 'host', 'port', 'username', 'password', 'inputChannel',
            'start', 'end', 'output', 'maxBytes', 'timeoutSeconds'}
    if not isinstance(config, dict) or set(config) != keys:
        raise WorkerError('invalid_config')
    config = config.copy()
    for key, maximum in [('sdkDir', 255), ('output', 255), ('host', 128),
                         ('username', 63), ('password', 63)]:
        value = config[key]
        if (not isinstance(value, str) or not value or '\x00' in value
                or any(ord(c) < 32 or ord(c) == 127 for c in value)
                or len(value.encode('utf-8')) > maximum):
            raise WorkerError('invalid_config')
    host = config['host']
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r'(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host):
            raise WorkerError('invalid_config') from None
        if any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
               for label in host.split('.')):
            raise WorkerError('invalid_config')
    for key, low, high in [('port', 1, 65535), ('inputChannel', 1, 65535),
                           ('maxBytes', 1, MAX_BYTES), ('timeoutSeconds', 1, 3600)]:
        integer(config[key], low, high)
    if not 0 < (compact(config['end']) - compact(config['start'])).total_seconds() <= 86400:
        raise WorkerError('invalid_config')
    for key in ('sdkDir', 'output'):
        if not Path(config[key]).is_absolute():
            raise WorkerError('invalid_config')
    return config


def channel_number(info, ordinal):
    count = int(info.byIPChanNum) + 256 * int(info.byHighDChanNum)
    if info.byChanNum or info.byStartDChan < 1 or not 1 <= ordinal <= count:
        raise WorkerError('unsupported_channel_map')
    return int(info.byStartDChan) + ordinal - 1


def sdk_time(value):
    date = compact(value)
    return NET_DVR_TIME(date.year, date.month, date.day, date.hour, date.minute, date.second)


def osd_time(value):
    try:
        date = dt.datetime(*(int(getattr(value, key)) for key, _ in NET_DVR_TIME._fields_))
        return date.strftime('%Y%m%dT%H%M%SZ')
    except ValueError:
        return None


def prepare_paths(config):
    sdk_dir = Path(config['sdkDir']).resolve(strict=True)
    output = Path(config['output'])
    directory = output.parent.resolve(strict=True)
    info = directory.stat()
    # Parent supplies a fresh task-private directory; reject links and existing
    # files before allowing the native SDK to open an output path.
    if (not sdk_dir.is_dir() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid() or info.st_mode & 0o077
            or any(directory.iterdir()) or output.exists() or output.is_symlink()):
        raise WorkerError('unsafe_output')
    for name in ('libhcnetsdk.so', 'libcrypto.so.1.1', 'libssl.so.1.1'):
        if not (sdk_dir / name).is_file():
            raise WorkerError('sdk_unavailable')
    if len(os.fsencode(sdk_dir)) > 255:
        raise WorkerError('invalid_config')
    return sdk_dir, directory / output.name


def directory_bytes(directory, expected_output=None):
    def traversal_error(_error):
        raise WorkerError('unsafe_output')

    total = 0
    for base, dirs, files in os.walk(directory, followlinks=False, onerror=traversal_error):
        for name in dirs + files:
            info = (Path(base) / name).lstat()
            if stat.S_ISLNK(info.st_mode):
                raise WorkerError('unsafe_output')
            if stat.S_ISREG(info.st_mode):
                # GetFileByTime_V40 may split at 1024 MB. This directory started
                # empty and logging is disabled: no other file can be accepted
                # as harmless, regardless of suffix, extension, size or case.
                if expected_output is not None and Path(base) / name != expected_output:
                    raise WorkerError('extra_volume')
                total += info.st_size
            elif not stat.S_ISDIR(info.st_mode):
                raise WorkerError('unsafe_output')
    return total


def bind_sdk(sdk):
    signatures = {
        'NET_DVR_GetLastError': ([], C.c_uint32),
        'NET_DVR_Init': ([], C.c_int32), 'NET_DVR_Cleanup': ([], C.c_int32),
        'NET_DVR_SetSDKInitCfg': ([C.c_int, C.c_void_p], C.c_int32),
        'NET_DVR_SetConnectTime': ([C.c_uint32, C.c_uint32], C.c_int32),
        'NET_DVR_SetRecvTimeOut': ([C.c_uint32], C.c_int32),
        'NET_DVR_SetReconnect': ([C.c_uint32, C.c_int], C.c_int32),
        'NET_DVR_Login_V30': ([C.c_char_p, C.c_uint16, C.c_char_p, C.c_char_p,
                              C.POINTER(NET_DVR_DEVICEINFO_V30)], C.c_int32),
        'NET_DVR_Logout': ([C.c_int32], C.c_int32),
        'NET_DVR_GetFileByTime_V40': ([C.c_int32, C.c_char_p, C.POINTER(NET_DVR_PLAYCOND)], C.c_int32),
        'NET_DVR_PlayBackControl_V40': ([C.c_int32, C.c_uint32, C.c_void_p, C.c_uint32,
                                       C.c_void_p, C.POINTER(C.c_uint32)], C.c_int32),
        'NET_DVR_GetDownloadPos': ([C.c_int32], C.c_int32),
        'NET_DVR_StopGetFile': ([C.c_int32], C.c_int32),
        'NET_DVR_GetPlayBackOsdTime': ([C.c_int32, C.POINTER(NET_DVR_TIME)], C.c_int32),
    }
    for name, (args, result) in signatures.items():
        function = getattr(sdk, name)
        function.argtypes, function.restype = args, result
    return sdk


def download(config, report, loader=C.CDLL, phase=None):
    sdk = None
    login = handle = -1
    initialized = False
    sdk_dir, output = prepare_paths(config)
    deadline = time.monotonic() + config['timeoutSeconds']
    old_cwd = os.getcwd()
    last_phase = None

    def mark(value):
        nonlocal last_phase
        if value not in PHASES or value == last_phase:
            return
        last_phase = value
        if phase is not None:
            try:
                phase(value)
            except OSError:
                # A closed supervisor pipe must not prevent native teardown.
                pass

    def checked(result):
        if not result:
            raise WorkerError('sdk_error', int(sdk.NET_DVR_GetLastError()))

    def bounds(single_output=False):
        if time.monotonic() >= deadline:
            raise WorkerError('timeout')
        total = directory_bytes(output.parent, output if single_output else None)
        if total >= config['maxBytes']:
            raise WorkerError('byte_limit')
        return total

    try:
        if tuple(C.sizeof(t) for t in (NET_DVR_TIME, NET_DVR_DEVICEINFO_V30,
                                       NET_DVR_PLAYCOND, NET_DVR_LOCAL_SDK_PATH)) != (24, 80, 116, 384):
            raise WorkerError('unsupported_abi')
        os.chdir(output.parent)
        mark('load')
        sdk = bind_sdk(loader(str(sdk_dir / 'libhcnetsdk.so')))
        mark('init_config')
        sdk_path = NET_DVR_LOCAL_SDK_PATH()
        sdk_path.sPath = os.fsencode(sdk_dir)
        checked(sdk.NET_DVR_SetSDKInitCfg(2, C.byref(sdk_path)))
        # Keep both native path buffers alive through Init and final cleanup.
        crypto_path = C.create_string_buffer(os.fsencode(sdk_dir / 'libcrypto.so.1.1'))
        ssl_path = C.create_string_buffer(os.fsencode(sdk_dir / 'libssl.so.1.1'))
        checked(sdk.NET_DVR_SetSDKInitCfg(3, crypto_path))
        checked(sdk.NET_DVR_SetSDKInitCfg(4, ssl_path))
        mark('init')
        checked(sdk.NET_DVR_Init())
        initialized = True
        checked(sdk.NET_DVR_SetConnectTime(3000, 1))
        checked(sdk.NET_DVR_SetRecvTimeOut(5000))
        checked(sdk.NET_DVR_SetReconnect(10000, 0))
        info = NET_DVR_DEVICEINFO_V30()
        mark('login')
        login = sdk.NET_DVR_Login_V30(config['host'].encode(), config['port'],
                                    config['username'].encode(), config['password'].encode(), C.byref(info))
        if login < 0:
            raise WorkerError('sdk_error', int(sdk.NET_DVR_GetLastError()))
        report['sdkChannel'] = channel_number(info, config['inputChannel'])
        bounds()
        condition = NET_DVR_PLAYCOND()
        condition.dwChannel = report['sdkChannel']
        condition.struStartTime = sdk_time(config['start'])
        condition.struStopTime = sdk_time(config['end'])
        condition.byDownload = 1  # Time range, never a recording-file download.
        mark('get_file')
        handle = sdk.NET_DVR_GetFileByTime_V40(login, os.fsencode(output), C.byref(condition))
        if handle < 0:
            raise WorkerError('sdk_error', int(sdk.NET_DVR_GetLastError()))
        mark('play_start')
        checked(sdk.NET_DVR_PlayBackControl_V40(handle, 1, None, 0, None, None))
        last_osd = -1.0
        while True:
            mark('wait')
            bounds()
            position = sdk.NET_DVR_GetDownloadPos(handle)
            if position < 0 or position > 100:
                raise WorkerError('sdk_error', int(sdk.NET_DVR_GetLastError()))
            # Completion goes straight to teardown, as in the validated probe.
            # Optional OSD sampling must not add a native call after completion.
            if position == 100:
                break
            now = time.monotonic()
            if now - last_osd >= 2:
                value = NET_DVR_TIME()
                mark('osd')
                if sdk.NET_DVR_GetPlayBackOsdTime(handle, C.byref(value)):
                    stamp = osd_time(value)
                    if stamp and (not report['osdTimes'] or stamp != report['osdTimes'][-1]):
                        report['osdTimes'].append(stamp)
                last_osd = now
                mark('wait')
            time.sleep(0.1)
        mark('stop')
        checked(sdk.NET_DVR_StopGetFile(handle))
        handle = -1
        bounds()
        if not output.is_file() or output.stat().st_size == 0:
            raise WorkerError('empty_output')
        report['bytes'] = output.stat().st_size
        mark('logout')
        checked(sdk.NET_DVR_Logout(login))
        login = -1
        mark('cleanup')
        checked(sdk.NET_DVR_Cleanup())
        initialized = False
        # Inspect only after StopGetFile and native cleanup have settled writes.
        bounds(single_output=True)
    except WorkerError as error:
        if error.code == 'timeout' and last_phase in PHASES:
            # Freeze the failure site before finally emits its cleanup phases.
            report['failurePhase'] = last_phase
        raise
    finally:
        # The Node supervisor supplies the hard watchdog if vendor code hangs.
        if sdk is not None:
            for phase_name, function, args in (('stop', sdk.NET_DVR_StopGetFile, (handle,)) if handle >= 0 else ('stop', None, ()),
                                               ('logout', sdk.NET_DVR_Logout, (login,)) if login >= 0 else ('logout', None, ()),
                                               ('cleanup', sdk.NET_DVR_Cleanup, ()) if initialized else ('cleanup', None, ())):
                if function:
                    try:
                        mark(phase_name)
                        function(*args)
                    except BaseException:
                        pass
        os.chdir(old_cwd)
        if output.is_file() and not output.is_symlink():
            report['bytes'] = output.stat().st_size


def main():
    safe_stdout = os.dup(1)
    os.set_inheritable(safe_stdout, False)
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 1)
    os.dup2(null, 2)
    os.close(null)
    report = dict(ok=False, code='internal_error', sdkCode=None, bytes=0,
                  sdkChannel=None, requestedStart=None, requestedEnd=None, osdTimes=[])

    def stop(signum, _frame):
        raise WorkerError('byte_limit' if signum == signal.SIGXFSZ else
                          'timeout' if signum == signal.SIGALRM else 'cancelled')

    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT, signal.SIGXFSZ):
            signal.signal(sig, stop)
        signal.alarm(10)  # Includes bounded stdin reading before any native load.
        if len(sys.argv) != 1 or sys.platform != 'linux':
            raise WorkerError('invalid_config')
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise WorkerError('invalid_config')
        try:
            config = validate(json.loads(raw))
        except (ValueError, UnicodeError, TypeError):
            raise WorkerError('invalid_config') from None
        report.update(requestedStart=config['start'], requestedEnd=config['end'])
        resource.setrlimit(resource.RLIMIT_FSIZE, (config['maxBytes'], config['maxBytes']))
        signal.alarm(config['timeoutSeconds'])
        # Compact phase strings keep the 3600s worker budget plus final OSD
        # report under the supervisor's unchanged 64 KiB aggregate stdout cap.
        download(config, report, phase=lambda value: os.write(safe_stdout, (json.dumps(value) + '\n').encode()))
        report.update(ok=True, code='completed')
    except WorkerError as error:
        report.update(code=error.code, sdkCode=error.sdk_code)
    except (OSError, AttributeError):
        report['code'] = 'sdk_unavailable'
    except BaseException:
        report['code'] = 'internal_error'
    finally:
        signal.alarm(0)
        os.write(safe_stdout, (json.dumps(report, separators=(',', ':')) + '\n').encode())
        os.close(safe_stdout)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

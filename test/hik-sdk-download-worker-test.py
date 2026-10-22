"""Offline contracts for the isolated HCNetSDK worker; never contacts a device."""
import ctypes as C
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import textwrap
import sys
import tempfile
import unittest
import weakref
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / 'scripts' / 'hik-sdk-download.py'
spec = importlib.util.spec_from_file_location('hik_sdk_worker', SCRIPT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def config(root):
    return dict(sdkDir=str(root / 'sdk'), host='192.0.2.1', port=8000,
                username='admin', password='SECRET_PASSWORD', inputChannel=2,
                start='20261001T213845Z', end='20261001T213910Z',
                output=str(root / 'output' / 'clip.ps'), maxBytes=1024,
                timeoutSeconds=5)


class FakeSDK:
    def __init__(self, cfg, analog=0, progress=None, fail=None, extra=False,
                 extra_files=(), extra_stage='NET_DVR_StopGetFile'):
        self.cfg, self.analog = cfg, analog
        self.progress = iter(progress or [0, 100])
        self.fail, self.extra = fail, extra
        self.calls = []
        self.extra_files, self.extra_stage = extra_files, extra_stage

    def __getattr__(self, name):
        def call(*args):
            self.calls.append(name)
            if name == self.extra_stage:
                for filename in self.extra_files:
                    target = Path(self.cfg['output']).parent / filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(b'x')
            if name == 'NET_DVR_GetLastError':
                return 23
            if name == self.fail:
                return -1 if name in ('NET_DVR_Login_V30', 'NET_DVR_GetFileByTime_V40') else 0
            if name == 'NET_DVR_Login_V30':
                info = args[-1]._obj
                info.byStartDChan, info.byIPChanNum, info.byChanNum = 33, 8, self.analog
                return 0  # Zero is a valid login handle.
            if name == 'NET_DVR_GetFileByTime_V40':
                condition = args[-1]._obj
                assert condition.dwChannel == 34
                assert condition.byDownload == 1
                assert worker.osd_time(condition.struStartTime) == self.cfg['start']
                assert worker.osd_time(condition.struStopTime) == self.cfg['end']
                Path(os.fsdecode(args[1])).write_bytes(b'video')
                if self.extra:
                    Path('native-extra').write_bytes(b'x' * self.cfg['maxBytes'])
                return 0  # Zero is also a valid download handle.
            if name == 'NET_DVR_GetDownloadPos':
                return next(self.progress)
            if name == 'NET_DVR_GetPlayBackOsdTime':
                # OSD differs intentionally: the worker must not claim alignment.
                value = args[-1]._obj
                original = worker.sdk_time('20261001T213843Z')
                C.memmove(C.addressof(value), C.addressof(original), C.sizeof(original))
            return 1
        return call


class WorkerTests(unittest.TestCase):
    def result(self, text):
        frames = [json.loads(line) for line in text.splitlines()]
        self.assertGreaterEqual(len(frames), 1)
        for phase in frames[:-1]:
            self.assertIsInstance(phase, str)
            self.assertIn(phase, worker.PHASES)
        self.assertIsInstance(frames[-1], dict)
        return frames[-1]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg = config(self.root)
        (self.root / 'sdk').mkdir()
        (self.root / 'output').mkdir(mode=0o700)
        for name in ('libhcnetsdk.so', 'libcrypto.so.1.1', 'libssl.so.1.1'):
            (self.root / 'sdk' / name).touch()
        self.report = dict(bytes=0, sdkChannel=None, osdTimes=[])

    def run_fake(self, sdk):
        with patch.object(worker, 'bind_sdk', side_effect=lambda value: value), \
                patch.object(worker.time, 'sleep'):
            worker.download(worker.validate(self.cfg), self.report, loader=lambda path: sdk)

    def test_abi(self):
        self.assertEqual([C.sizeof(t) for t in (worker.NET_DVR_TIME, worker.NET_DVR_DEVICEINFO_V30,
                                               worker.NET_DVR_PLAYCOND, worker.NET_DVR_LOCAL_SDK_PATH)],
                         [24, 80, 116, 384])
        self.assertEqual(worker.NET_DVR_DEVICEINFO_V30.byStartDChan.offset, 66)

    def test_config_is_strict_and_preserves_wall_time(self):
        self.assertEqual(worker.validate(self.cfg)['start'], '20261001T213845Z')
        invalid = [('port', True), ('port', 65536), ('inputChannel', 0),
                   ('maxBytes', worker.MAX_BYTES + 1), ('timeoutSeconds', 0),
                   ('host', 'host\r\nINJECT'), ('host', 'bad..host'),
                   ('username', 'x' * 64), ('password', 'a\0b'),
                   ('output', 'relative.ps'), ('start', '20260230T120000Z'),
                   ('start', '2026-10-01T21:38:45Z'), ('end', self.cfg['start']),
                   ('end', '20261003T213910Z')]
        for key, value in invalid:
            with self.subTest(key=key, value=value), self.assertRaises(worker.WorkerError):
                worker.validate(dict(self.cfg, **{key: value}))
        with self.assertRaises(worker.WorkerError):
            worker.validate(dict(self.cfg, unexpected=True))

    def test_mapping_rejects_hybrids_and_bad_ordinals(self):
        info = worker.NET_DVR_DEVICEINFO_V30()
        info.byStartDChan, info.byIPChanNum = 33, 8
        self.assertEqual(worker.channel_number(info, 2), 34)
        info.byHighDChanNum = 1
        self.assertEqual(worker.channel_number(info, 264), 296)
        for ordinal in (0, 265):
            with self.assertRaises(worker.WorkerError):
                worker.channel_number(info, ordinal)
        info.byChanNum = 1
        with self.assertRaises(worker.WorkerError):
            worker.channel_number(info, 2)

    def test_success_cleanup_and_unmodified_osd(self):
        sdk = FakeSDK(self.cfg)
        self.run_fake(sdk)
        self.assertEqual(self.report, dict(bytes=5, sdkChannel=34, osdTimes=['20261001T213843Z']))
        self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'])
        self.assertNotIn('NET_DVR_GetFileByName', sdk.calls)

    def test_rejects_every_additional_volume_after_native_cleanup(self):
        variants = [('clip_1.ps',), ('clip.ps_1',), ('CLIP_1.PS',),
                    ('clip_1.mp4',), ('clip_001.ps',), ('clip.ps.1',),
                    ('clip_1.ps', 'clip_2.ps'), ('nested/clip_1.ps',),
                    ('unrecognized-volume',), ('native.log',)]
        for stage in ('NET_DVR_StopGetFile', 'NET_DVR_Cleanup'):
            for names in variants:
                with self.subTest(stage=stage, names=names):
                    sdk = FakeSDK(self.cfg, extra_files=names, extra_stage=stage)
                    cwd = os.getcwd()
                    with self.assertRaises(worker.WorkerError) as caught:
                        self.run_fake(sdk)
                    self.assertEqual(caught.exception.code, 'extra_volume')
                    self.assertIsNone(caught.exception.sdk_code)
                    self.assertEqual(str(caught.exception), 'extra_volume')
                    self.assertEqual(os.getcwd(), cwd)
                    self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile',
                                                    'NET_DVR_Logout', 'NET_DVR_Cleanup'])
                    for name in ('NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'):
                        self.assertEqual(sdk.calls.count(name), 1)
                    # Removal remains the supervisor's responsibility, after close.
                    for path in sorted((self.root / 'output').rglob('*'), reverse=True):
                        path.rmdir() if path.is_dir() else path.unlink()

    def test_directory_traversal_errors_fail_closed(self):
        original_scandir = os.scandir
        output = Path(self.cfg['output'])
        output.write_bytes(b'video')
        nested = output.parent / 'nested'
        nested.mkdir()
        (nested / 'clip_1.ps').write_bytes(b'x')

        def scan(path):
            if Path(path) == nested:
                raise PermissionError('SECRET_PATH')
            return original_scandir(path)

        with patch.object(worker.os, 'scandir', side_effect=scan):
            with self.assertRaisesRegex(worker.WorkerError, '^unsafe_output$'):
                worker.directory_bytes(output.parent, expected_output=output)

    def test_empty_extra_volume_is_rejected_too(self):
        output = Path(self.cfg['output'])
        output.write_bytes(b'video')
        output.with_name('clip_1.ps').touch()
        with self.assertRaisesRegex(worker.WorkerError, '^extra_volume$'):
            worker.directory_bytes(output.parent, expected_output=output)

    def test_extra_volume_subprocess_report_is_closed_and_sanitized(self):
        code = textwrap.dedent("""
            import ctypes, runpy
            tests = runpy.run_path(%r)
            cfg = tests['config'](tests['Path'](%r))
            sdk = tests['FakeSDK'](cfg, extra_files=('SECRET_PASSWORD_1.ps',))
            ctypes.CDLL = lambda path: sdk
            runpy.run_path(%r, run_name='__main__')
        """) % (str(Path(__file__).resolve()), str(self.root), str(SCRIPT))
        result = subprocess.run([sys.executable, '-c', code], input=json.dumps(self.cfg),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        self.assertNotIn('SECRET', result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        report = self.result(result.stdout)
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'extra_volume')
        self.assertIsNone(report['sdkCode'])

    def test_hybrid_logs_out_without_download(self):
        sdk = FakeSDK(self.cfg, analog=1)
        with self.assertRaisesRegex(worker.WorkerError, 'unsupported_channel_map'):
            self.run_fake(sdk)
        self.assertEqual(sdk.calls[-2:], ['NET_DVR_Logout', 'NET_DVR_Cleanup'])
        self.assertNotIn('NET_DVR_GetFileByTime_V40', sdk.calls)

    def test_download_error_cleans_every_handle(self):
        sdk = FakeSDK(self.cfg, progress=[200])
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_fake(sdk)
        self.assertEqual(caught.exception.sdk_code, 23)
        self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'])

    def test_total_directory_cap_includes_auxiliary_files(self):
        sdk = FakeSDK(self.cfg, extra=True)
        with self.assertRaisesRegex(worker.WorkerError, 'byte_limit'):
            self.run_fake(sdk)
        self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'])

    def test_deadline_exits_and_releases_session(self):
        sdk = FakeSDK(self.cfg)
        with patch.object(worker.time, 'monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(worker.WorkerError, 'timeout'):
                self.run_fake(sdk)
        self.assertEqual(sdk.calls[-2:], ['NET_DVR_Logout', 'NET_DVR_Cleanup'])

    def test_native_descriptors_are_suppressed_and_core_disabled(self):
        # Simulate a vendor loader writing directly to native descriptors, then
        # fail. The subprocess also verifies the hard process resource limits.
        code = textwrap.dedent("""
            import ctypes, os, resource, runpy
            def load(path):
                assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
                assert resource.getrlimit(resource.RLIMIT_FSIZE) == (1024, 1024)
                os.write(1, b'SECRET_NATIVE_STDOUT')
                os.write(2, b'SECRET_NATIVE_STDERR')
                raise OSError('SECRET_PATH')
            ctypes.CDLL = load
            runpy.run_path(%r, run_name='__main__')
        """) % str(SCRIPT)
        result = subprocess.run([sys.executable, '-c', code], input=json.dumps(self.cfg),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        self.assertNotIn('SECRET', result.stdout)
        self.assertEqual(self.result(result.stdout)['code'], 'sdk_unavailable')

    def test_refuses_existing_or_nonprivate_output_directory(self):
        (self.root / 'output' / 'existing').touch()
        with self.assertRaisesRegex(worker.WorkerError, 'unsafe_output'):
            worker.prepare_paths(self.cfg)
        (self.root / 'output' / 'existing').unlink()
        (self.root / 'output').chmod(0o755)
        with self.assertRaisesRegex(worker.WorkerError, 'unsafe_output'):
            worker.prepare_paths(self.cfg)

    def test_signal_cancellation_is_sanitized(self):
        code = textwrap.dedent("""
            import ctypes, os, runpy, signal
            def load(path):
                os.kill(os.getpid(), signal.SIGTERM)
            ctypes.CDLL = load
            runpy.run_path(%r, run_name='__main__')
        """) % str(SCRIPT)
        result = subprocess.run([sys.executable, '-c', code], input=json.dumps(self.cfg),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        self.assertEqual(self.result(result.stdout)['code'], 'cancelled')

    def test_init_path_buffers_survive_until_native_cleanup(self):
        for failure in (None, 'NET_DVR_GetFileByTime_V40'):
            with self.subTest(failure=failure):
                buffers = {}
                observed = []
                owner = self

                class LifetimeSDK(FakeSDK):
                    def __getattr__(self, name):
                        original = super().__getattr__(name)

                        def call(*args):
                            if name == 'NET_DVR_SetSDKInitCfg' and args[0] in (3, 4):
                                # Never keep the buffer itself alive in this fake.
                                buffers[args[0]] = weakref.ref(args[1])
                            if name in ('NET_DVR_Init', 'NET_DVR_Login_V30',
                                        'NET_DVR_GetFileByTime_V40', 'NET_DVR_StopGetFile',
                                        'NET_DVR_Logout', 'NET_DVR_Cleanup'):
                                observed.append(name)
                                owner.assertEqual(set(buffers), {3, 4})
                                for kind, reference in buffers.items():
                                    owner.assertIsNotNone(reference(), (name, kind))
                                    suffix = b'libcrypto.so.1.1' if kind == 3 else b'libssl.so.1.1'
                                    owner.assertTrue(reference().value.endswith(suffix))
                            return original(*args)
                        return call

                sdk = LifetimeSDK(self.cfg, fail=failure)
                if failure:
                    with self.assertRaises(worker.WorkerError):
                        self.run_fake(sdk)
                else:
                    self.run_fake(sdk)
                self.assertIn('NET_DVR_Init', observed)
                self.assertEqual(observed[-1], 'NET_DVR_Cleanup')
                output = Path(self.cfg['output'])
                if output.exists():
                    output.unlink()

    def test_completed_download_never_calls_optional_osd(self):
        for positions in ([100], [0, 100]):
            with self.subTest(positions=positions):
                completed = False
                owner = self

                class CompletionSDK(FakeSDK):
                    def __getattr__(self, name):
                        original = super().__getattr__(name)

                        def call(*args):
                            nonlocal completed
                            if name == 'NET_DVR_GetPlayBackOsdTime':
                                owner.assertFalse(completed, 'OSD called after completion')
                            value = original(*args)
                            if name == 'NET_DVR_GetDownloadPos' and value == 100:
                                completed = True
                            return value
                        return call

                sdk = CompletionSDK(self.cfg, progress=positions)
                self.run_fake(sdk)
                self.assertTrue(completed)
                self.assertEqual(sdk.calls.count('NET_DVR_GetPlayBackOsdTime'), len(positions) - 1)
                self.assertEqual(sdk.calls[-4:], ['NET_DVR_GetDownloadPos', 'NET_DVR_StopGetFile',
                                                'NET_DVR_Logout', 'NET_DVR_Cleanup'])
                self.assertEqual(self.report['bytes'], 5)
                Path(self.cfg['output']).unlink()

    def test_phase_sequence_is_closed_and_cleanup_is_observable(self):
        phases = []
        sdk = FakeSDK(self.cfg)
        with patch.object(worker, 'bind_sdk', side_effect=lambda value: value), \
                patch.object(worker.time, 'sleep'):
            worker.download(worker.validate(self.cfg), self.report,
                            loader=lambda path: sdk, phase=phases.append)
        self.assertEqual(phases, ['load', 'init_config', 'init', 'login', 'get_file',
                                  'play_start', 'wait', 'osd', 'wait', 'stop', 'logout', 'cleanup'])
        self.assertTrue(all(phase in worker.PHASES for phase in phases))

    def test_wait_timeout_freezes_failure_phase_before_successful_teardown(self):
        phases = []
        sdk = FakeSDK(self.cfg)
        with patch.object(worker, 'bind_sdk', side_effect=lambda value: value), \
                patch.object(worker.time, 'sleep'), \
                patch.object(worker.time, 'monotonic', side_effect=[0, 0, 6]):
            with self.assertRaisesRegex(worker.WorkerError, '^timeout$'):
                worker.download(worker.validate(self.cfg), self.report,
                                loader=lambda path: sdk, phase=phases.append)
        self.assertEqual(self.report['failurePhase'], 'wait')
        self.assertEqual(phases[-4:], ['wait', 'stop', 'logout', 'cleanup'])
        self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'])

    def test_osd_timeout_freezes_failure_phase_before_successful_teardown(self):
        phases = []
        class TimeoutSDK(FakeSDK):
            def __getattr__(self, name):
                if name == 'NET_DVR_GetPlayBackOsdTime':
                    def timeout(*args):
                        raise worker.WorkerError('timeout')
                    return timeout
                return super().__getattr__(name)
        sdk = TimeoutSDK(self.cfg)
        with patch.object(worker, 'bind_sdk', side_effect=lambda value: value), \
                patch.object(worker.time, 'sleep'):
            with self.assertRaisesRegex(worker.WorkerError, '^timeout$'):
                worker.download(worker.validate(self.cfg), self.report,
                                loader=lambda path: sdk, phase=phases.append)
        self.assertEqual(self.report['failurePhase'], 'osd')
        self.assertEqual(phases[-4:], ['osd', 'stop', 'logout', 'cleanup'])

    def test_phase_pipe_failure_does_not_skip_teardown(self):
        sdk = FakeSDK(self.cfg)
        def broken_pipe(_phase):
            raise BrokenPipeError('PRIVATE_NATIVE_TEXT')
        with patch.object(worker, 'bind_sdk', side_effect=lambda value: value), \
                patch.object(worker.time, 'sleep'):
            worker.download(worker.validate(self.cfg), self.report,
                            loader=lambda path: sdk, phase=broken_pipe)
        self.assertEqual(sdk.calls[-3:], ['NET_DVR_StopGetFile', 'NET_DVR_Logout', 'NET_DVR_Cleanup'])

    def test_wait_timeout_then_cleanup_hang_reports_active_phase_before_supervisor_kill(self):
        code = textwrap.dedent("""
            import ctypes, runpy, signal, time
            tests = runpy.run_path(%r)
            cfg = tests['config'](tests['Path'](%r))
            class HungSDK(tests['FakeSDK']):
                def __getattr__(self, name):
                    if name == 'NET_DVR_GetDownloadPos':
                        return lambda *args: __import__('os').kill(__import__('os').getpid(), signal.SIGALRM)
                    if name != 'NET_DVR_Cleanup':
                        return super().__getattr__(name)
                    def hang(*args):
                        signal.signal(signal.SIGTERM, signal.SIG_IGN)
                        signal.signal(signal.SIGALRM, signal.SIG_IGN)
                        while True:
                            time.sleep(1)
                    return hang
            sdk = HungSDK(cfg)
            ctypes.CDLL = lambda path: sdk
            runpy.run_path(%r, run_name='__main__')
        """) % (str(Path(__file__).resolve()), str(self.root), str(SCRIPT))
        child = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                child.communicate(json.dumps(self.cfg), timeout=1)
            child.terminate()
            with self.assertRaises(subprocess.TimeoutExpired):
                child.communicate(timeout=0.1)
            child.kill()
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(stderr, '')
            frames = [json.loads(line) for line in stdout.splitlines()]
            self.assertEqual(frames[-3:], ['stop', 'logout', 'cleanup'])
            self.assertTrue(all(isinstance(value, str) and value in worker.PHASES for value in frames))
            self.assertNotIn('SECRET', stdout)
            self.assertNotIn(str(self.root), stdout)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    def test_phase_and_osd_output_fit_maximum_worker_budget(self):
        # Last OSD time updates before the call; sampling cannot run more often
        # than once per two monotonic seconds inside a 3600-second deadline.
        pairs = 3600 // 2 + 1
        phases = ['load', 'init_config', 'init', 'login', 'get_file', 'play_start', 'wait']
        phases += ['osd', 'wait'] * pairs
        phases += ['stop', 'logout', 'cleanup'] * 2  # Include failed cleanup retries.
        report = dict(ok=False, code='unsupported_channel_map', sdkCode=2**32 - 1,
                      bytes=worker.MAX_BYTES, sdkChannel=65535,
                      requestedStart='99991231T235959Z', requestedEnd='99991231T235959Z',
                      osdTimes=['99991231T235959Z'] * pairs, failurePhase='play_start')
        output = ''.join(json.dumps(phase) + '\n' for phase in phases)
        output += json.dumps(report, separators=(',', ':')) + '\n'
        self.assertLess(len(output.encode()), 59000)
        self.assertLess(len(output.encode()), 65536)

    def test_subprocess_errors_are_sanitized_single_json(self):
        for payload in (dict(self.cfg, password='SECRET_PASSWORD\0bad'), self.cfg):
            result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload),
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, '')
            self.assertNotIn('SECRET_PASSWORD', result.stdout)
            self.assertNotIn(str(self.root), result.stdout)
            self.assertFalse(self.result(result.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()

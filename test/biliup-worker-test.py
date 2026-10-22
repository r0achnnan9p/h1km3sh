"""离线验证实际 worker 参数、失败和不确定状态，不投稿。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import textwrap
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))


class WorkerTests(unittest.TestCase):
    def test_worker_status_and_custom_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cover = root / 'cover.png'; cover.write_bytes(b'cover')
            cookie = root / 'cookie.json'; cookie.write_text('SECRET_COOKIE')
            os.environ.update(HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup', BILIUP_COOKIE_FILE=str(cookie), BILIUP_COVER_FILE=str(cover))
            spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
            worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
            worker.JOBS.mkdir(parents=True)
            with patch.object(worker.shutil, 'which', return_value='/fixture/biliup'):
                worker.publish_worker_status()
            raw = (worker.JOBS.parent / 'worker-status.json').read_text()
            self.assertNotIn('SECRET_COOKIE', raw)
            self.assertNotIn('authenticated', raw)
            self.assertTrue(json.loads(raw)['credentialsPresent'])
            self.assertEqual((worker.JOBS.parent / 'worker-status.json').stat().st_mode & 0o777, 0o600)
            (root / 'video.mp4').write_bytes(b'fixture')
            job = dict(filename='video.mp4', size=7, title='前缀 标题', tags=['足球', '集锦'])
            with patch.object(worker, 'collection_preflight'), patch.object(worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'BV1234567890', b'')) as run, patch.object(worker, 'save'), patch.object(worker, 'ensure_football_collection'):
                worker.upload(None, job)
                args = run.call_args.args[0]
                self.assertEqual(args[args.index('--tag') + 1], '足球,集锦')
                self.assertEqual(args[args.index('--title') + 1], '前缀 标题')
            with patch.object(worker, 'collection_preflight'), patch.object(worker, 'run_upload') as run:
                job['tags'] = ['bad,tag']
                with self.assertRaises(ValueError):
                    worker.upload(None, job)
                run.assert_not_called()

    def test_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            cover = Path(directory) / 'cover.png'
            cover.write_bytes(b'cover')
            os.environ.update(HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup', BILIUP_COOKIE_FILE='private-cookie', BILIUP_COVER_FILE=str(cover))
            spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            filename = '天行者 vs 九块九 D2 2026-09-27.mp4'
            (Path(directory) / filename).write_bytes(b'fixture')
            job = dict(filename=filename, size=7, title='天行者 vs 九块九', tid=249, tags=['足球'], onlySelf=False)
            with patch.object(worker, 'collection_preflight'), patch.object(worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'BV1234567890', b'')) as run, \
                 patch.object(worker, 'save'), patch.object(worker, 'ensure_football_collection') as add:
                worker.upload(None, job)
                args = run.call_args.args[0]
                self.assertEqual(args[args.index('--tid')+1], '249')
                self.assertEqual(args[args.index('--submit')+1], 'web')
                self.assertEqual(args[args.index('--tag')+1], '足球')
                self.assertEqual(args[args.index('--is-only-self')+1], '1')
                self.assertEqual(args[args.index('--cover')+1], str(cover))
                self.assertEqual(args[-1], str(Path(directory) / filename))
                self.assertEqual(job['status'], 'completed')
                self.assertEqual(job['collectionStatus'], 'completed')
                add.assert_called_once_with('BV1234567890', job['title'])
                self.assertNotIn('private-cookie', str(job))
            with patch.object(worker, 'collection_preflight'), patch.object(worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'', b'')), patch.object(worker, 'save'):
                worker.upload(None, job)
                self.assertEqual(job['status'], 'unknown')
            with patch.object(worker, 'collection_preflight'), patch.object(worker, 'run_upload', return_value=subprocess.CompletedProcess([], 1, b'private-cookie', b'')), patch.object(worker, 'save'):
                with self.assertRaises(RuntimeError):
                    worker.upload(None, job)
                self.assertEqual(job['errorCode'], 'cli_error')
                self.assertEqual(job['exitCode'], 1)
                self.assertNotIn('private-cookie', str(job))
            self.assertEqual(worker.safe_failure(subprocess.CompletedProcess([], 1, b'login expired', b'')),
                             ('auth', '登录凭据可能失效'))
            self.assertEqual(worker.safe_failure(subprocess.CompletedProcess([], 1, b'open cookies file: Read-only file system (os error 30)', b'')),
                             ('filesystem', '投稿进程没有写入 Cookie 或缓存的权限'))
            self.assertEqual(worker.safe_failure(subprocess.CompletedProcess([], 2, b'', b'cover invalid')),
                             ('cover', '封面参数或图片被拒绝'))
            self.assertEqual(worker.safe_failure(subprocess.CompletedProcess([], 3, b'secret=abc', b'')),
                             ('cli_error', 'biliupR 退出码 3，原因未识别'))
            job['filename'] = '../private.mp4'
            with self.assertRaises(ValueError):
                worker.upload(None, job)

    @unittest.skipUnless(os.name == 'posix', 'PTY upload branch is POSIX-only')
    def test_pty_term_fallback_preserves_the_full_child_and_parent_environment(self):
        class StopAfterSpawn(Exception):
            pass

        with tempfile.TemporaryDirectory() as directory:
            base = dict(HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup',
                        BILIUP_COOKIE_FILE='private-cookie', HOME='/fixture/home',
                        PATH='/fixture/bin', CUSTOM_SETTING='keep exactly', EMPTY_SETTING='')
            with patch.dict(os.environ, base, clear=True):
                spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
                worker = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(worker)
                for term in (None, '', 'dumb', 'xterm-256color', 'vt100', 'DUMB'):
                    with self.subTest(term=term), patch.dict(os.environ, base, clear=True):
                        if term is not None:
                            os.environ['TERM'] = term
                        original = dict(os.environ)
                        expected = {**original, 'TERM': 'xterm'} if term in (None, '', 'dumb') else original
                        with patch('pty.openpty', return_value=(51, 52)), patch('fcntl.ioctl'), \
                             patch.object(worker.os, 'close') as close, \
                             patch.object(worker.subprocess, 'Popen', side_effect=StopAfterSpawn) as popen:
                            with self.assertRaises(StopAfterSpawn):
                                worker.run_upload(['fixture-biliup', 'upload'], None, {})
                        self.assertEqual(popen.call_args.kwargs['env'], expected)
                        self.assertIsNot(popen.call_args.kwargs['env'], os.environ)
                        self.assertEqual(popen.call_args.kwargs['stderr'], 52)
                        self.assertEqual(dict(os.environ), original, 'must not modify the worker environment')
                        self.assertEqual([call.args[0] for call in close.call_args_list], [51, 52])

    def test_non_pty_upload_does_not_override_environment(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,
                HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup', BILIUP_COOKIE_FILE='private-cookie', TERM='dumb'):
            spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            result = subprocess.CompletedProcess([], 0, b'', b'')
            original = dict(os.environ)
            with patch.object(worker.os, 'name', 'nt'), patch.object(worker.subprocess, 'run', return_value=result) as run:
                self.assertIs(worker.run_upload(['fixture-biliup', 'upload'], None, {}), result)
            self.assertNotIn('env', run.call_args.kwargs)
            self.assertEqual(dict(os.environ), original)

    def test_collection_skips_existing_video(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ.update(HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup',
                              BILIUP_COOKIE_FILE='private-cookie')
            spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            worker.SEASON_ID, worker.SECTION_ID = 1735361, 1992175
            section = {'section': {'seasonId': 1735361}, 'episodes': [{'bvid': 'BV1234567890'}]}
            with patch.object(worker, 'collection_preflight', return_value=section) as request, \
                 patch.object(worker.subprocess, 'run') as run:
                worker.ensure_football_collection('BV1234567890', '测试')
                request.assert_called_once()
                run.assert_not_called()

    def test_collection_adds_and_verifies(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ.update(HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='fixture-biliup',
                              BILIUP_COOKIE_FILE='private-cookie')
            spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            worker.SEASON_ID, worker.SECTION_ID = 1735361, 1992175
            absent = {'section': {'seasonId': 1735361}, 'episodes': []}
            present = {'section': {'seasonId': 1735361}, 'episodes': [{'bvid': 'BV1234567890'}]}
            details = {'archive': {'aid': 42, 'bvid': 'BV1234567890'}, 'videos': [{'cid': 99}]}
            completed = subprocess.CompletedProcess([], 0, json.dumps(details).encode(), b'')
            with patch.object(worker, 'collection_preflight', return_value=absent), patch.object(worker, 'bilibili_request', side_effect=[{}, present]) as request, \
                 patch.object(worker.subprocess, 'run', return_value=completed):
                worker.ensure_football_collection('BV1234567890', '测试')
                self.assertEqual(request.call_args_list[0].kwargs['payload']['episodes'][0],
                                 {'aid': 42, 'cid': 99, 'title': '测试', 'charging_pay': 0})


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.environment = patch.dict(os.environ, HIKVISION_DOWNLOADS_DIR=str(self.root),
            BILIUP_BINARY='fixture-biliup', BILIUP_COOKIE_FILE='never-read-cookie', TERM='dumb')
        self.environment.start()
        self.addCleanup(self.environment.stop)
        spec = importlib.util.spec_from_file_location('progress_worker', Path(__file__).parents[1] / 'scripts' / 'biliup-worker.py')
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.file = self.root / 'job.json'
        self.job = dict(size=8 * 1024 * 1024, status='uploading', uploadPhase='remote_started', stage='preparing')
        self.worker.save(self.file, self.job)
        self.guard = patch.object(self.worker.urllib.request, 'urlopen', side_effect=AssertionError('No network in tests'))
        self.guard.start()
        self.addCleanup(self.guard.stop)

    def test_units_binary_decimal_and_ansi(self):
        for raw, uploaded, total, speed, percent in [
            (b'1.50 MiB/3.00 MiB (512.00 KiB/s, 3s)', 1572864, 3145728, 524288, 50),
            (b'1.5 MB / 3 MB (250 kB/s, 6s)', 1500000, 3000000, 250000, 50),
            (b'128 B/512 B (64 B/s, 6s)', 128, 512, 64, 25),
            (b'0 B/1 GiB (0 B/s, 0s)', 0, 1073741824, 0, 0),
            (b'2 GiB/1 GiB (1 GiB/s, 0s)', 2147483648, 1073741824, 1073741824, 100),
            (b'\x1b[32m1.00 MiB\x1b[0m/\x1b[1m2.00 MiB\x1b[0m (1.00 MiB/s, 1s)', 1048576, 2097152, 1048576, 50),
        ]:
            with self.subTest(raw=raw):
                result = self.worker.progress_update(raw)
                self.assertEqual((result['uploadedBytes'], result['totalBytes'], result['uploadSpeed'], result['stagePercent']),
                                 (uploaded, total, speed, percent))
                self.assertEqual(result['stage'], 'uploading')
                self.assertEqual(result['progress'], percent)

    def test_unknown_total_stays_unknown(self):
        for raw in (b'1 MiB/0 B (1 MiB/s, 0s)', b'1 MiB/? (1 MiB/s, 0s)',
                    b'1 MiB/unknown (1 MiB/s, 0s)', b'1 MiB (1 MiB/s, 0s)'):
            with self.subTest(raw=raw):
                result = self.worker.progress_update(raw)
                self.assertIsNone(result['totalBytes'])
                self.assertIsNone(result['stagePercent'])
                self.assertIsNone(result['progress'])
                self.assertEqual(result['uploadedBytes'], 1048576)
        self.assertIsNone(self.worker.progress_update(b'login token=secret; connection established'))
        self.assertIsNone(self.worker.progress_update(b'50%'))

    def test_split_frames_cursor_redraw_and_no_newline(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        frames = [b'\x1b[3', b'2mspinner\x1b[0m [00:00:01] [##--] 1.00 M',
                  b'iB/2.00 MiB (512.00 Ki', b'B/s, 2s)', b'   ']
        for chunk in frames:
            progress.feed('stderr', chunk)
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['stagePercent'], 50)
        self.assertEqual(saved['uploadSpeed'], 524288)
        self.assertGreater(saved['progressUpdatedAt'], 10 ** 12)
        progress.feed('stderr', b'\x1b[2K\x1b[1Gspinner [00:00:02] [####] 2.00 MiB/2.00 MiB (1 MiB/s, 0s)')
        progress.finish()
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['stagePercent'], 100)
        self.assertEqual(saved['uploadPhase'], 'remote_started')
        self.assertEqual(saved['status'], 'uploading')
        self.assertNotIn('spinner', self.file.read_text())

    def test_padding_and_poll_flush_do_not_refresh_stalled_measurement(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        with patch.object(self.worker.time, 'time', return_value=1000):
            progress.feed('stderr', b'1 MiB/2 MiB (1 MiB/s, 1s)')
        with patch.object(self.worker.time, 'time', return_value=2000):
            progress.feed('stderr', b'   ')
            progress.flush(force=True)
            progress.finish()
        self.assertEqual(self.job['progressUpdatedAt'], 1000000)

    def test_throttled_update_flushes_even_when_output_stops(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        with patch.object(self.worker.time, 'monotonic', return_value=10):
            progress.feed('stderr', b'1 MB/4 MB (1 MB/s, 3s)\r')
        with patch.object(self.worker.time, 'monotonic', return_value=10.1):
            progress.feed('stderr', b'2 MB/4 MB (1 MB/s, 2s)\r')
        self.assertEqual(json.loads(self.file.read_text())['progress'], 25)
        with patch.object(self.worker.time, 'monotonic', return_value=11.1):
            progress.flush()
        self.assertEqual(json.loads(self.file.read_text())['progress'], 50)
        self.assertFalse(progress.dirty)

    def test_submitting_log_is_immediate_and_late_stderr_cannot_regress_stage(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        progress.feed('stderr', b'2 MiB/2 MiB (1 MiB/s, 0s)\r')
        progress.feed('stdout', b'2026-09-30T09:00:00.000Z INFO biliup_cli::uploader: Upload completed: fixture.mp4 => cost 2.00s, 1.00 MB/s.\n')
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['stage'], 'submitting')
        self.assertEqual(saved['totalBytes'], 2097152)
        self.assertIsNone(saved['stagePercent'])
        self.assertIsNone(saved['progress'])
        self.assertIsNone(saved['uploadSpeed'])
        progress.feed('stderr', b'1 MiB/2 MiB (1 MiB/s, 1s)\r')
        progress.finish()
        self.assertEqual(json.loads(self.file.read_text())['stage'], 'submitting')
        self.assertEqual(self.job['uploadPhase'], 'remote_started')

    def test_missing_speed_does_not_keep_stale_measurement(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        progress.feed('stderr', b'1 MiB/2 MiB (1 MiB/s, 1s)\r')
        progress.feed('stderr', b'1.5 MiB/2 MiB\r')
        progress.finish()
        self.assertIsNone(json.loads(self.file.read_text())['uploadSpeed'])

    def test_terminal_buffers_are_bounded_and_streams_do_not_mix(self):
        progress = self.worker.UploadProgress(self.file, self.job)
        progress.feed('stdout', b'x' * 100000)
        self.assertLessEqual(len(progress.pending['stdout']), 65536)
        progress.feed('stderr', b'1 MiB/2 MiB (1 MiB/s, 1s)')
        self.assertEqual(json.loads(self.file.read_text())['progress'], 50)
        self.assertNotIn('x' * 20, self.file.read_text())

    @unittest.skipUnless(os.name == 'posix', 'Uses the real POSIX PTY and selector')
    def test_real_pty_persists_live_frame_then_publication_before_child_exits(self):
        code = textwrap.dedent(r"""
            import json, os, sys, time
            assert os.isatty(2), 'fixture must use a real terminal'
            assert os.environ['TERM'] == 'xterm'
            def wait_for(check):
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    with open(sys.argv[1]) as f:
                        job = json.load(f)
                    if check(job):
                        return job
                    time.sleep(.01)
                raise AssertionError('worker failed to persist live telemetry')
            os.write(2, b'\x1b[32mspinner\x1b[0m [00:00:01] [##--] 1.00 MiB/2.00 MiB (1.00 MiB/s, 1s)')
            first = wait_for(lambda j: j.get('stagePercent') == 50)
            assert first['uploadedBytes'] == 1048576 and first['totalBytes'] == 2097152
            assert first['uploadSpeed'] == 1048576
            os.write(2, b'\r\x1b[2Kspinner [00:00:02] [###-] 1.50 MiB/2.00 MiB (512 KiB/s, 1s)')
            wait_for(lambda j: j.get('stagePercent') == 75)  # No further output: periodic flush is required.
            os.write(1, b'2026-09-30T09:00:00Z INFO biliup_cli::uploader: Upload completed: fixture.mp4 => cost 2.00s, 1.00 MB/s.\n')
            publishing = wait_for(lambda j: j.get('stage') == 'submitting')
            assert publishing['status'] == 'uploading' and publishing['uploadPhase'] == 'remote_started'
            assert publishing['progress'] is None and publishing['stagePercent'] is None
            assert publishing['uploadSpeed'] is None
            os.write(1, b'BV1234567890\n')
        """)
        result = self.worker.run_upload([sys.executable, '-c', code, str(self.file)], self.file, self.job)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assertIn(b'BV1234567890', result.stdout)
        self.assertEqual(json.loads(self.file.read_text())['stage'], 'submitting')
        self.assertEqual(os.environ['TERM'], 'dumb')
        self.assertNotIn('BV1234567890', self.file.read_text(), 'progress does not invent a publication receipt')

    @unittest.skipUnless(os.name == 'posix', 'Uses the real POSIX PTY and selector')
    def test_fast_real_process_flushes_latest_progress_on_exit(self):
        code = "import os; os.write(2, b'1 MB/4 MB (1 MB/s, 3s)\\r2 MB/4 MB (1 MB/s, 2s)\\r')"
        result = self.worker.run_upload([sys.executable, '-c', code], self.file, self.job)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(self.file.read_text())['progress'], 50)

    def test_zero_exit_without_bvid_never_invents_completed_telemetry(self):
        (self.root / 'video.mp4').write_bytes(b'fixture')
        cover = self.root / 'cover.png'; cover.write_bytes(b'cover')
        self.worker.COVER = str(cover)
        job = dict(filename='video.mp4', size=7, title='fixture')
        with patch.object(self.worker, 'collection_preflight'), patch.object(self.worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            self.worker.upload(self.file, job)
        self.assertEqual(job['status'], 'unknown')
        self.assertIsNone(job['progress'])
        self.assertIsNone(job['totalBytes'])
        self.assertIsNone(job['uploadedBytes'])
        self.assertEqual(job['uploadPhase'], 'remote_started')


if __name__ == '__main__':
    unittest.main()


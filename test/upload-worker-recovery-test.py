"""Offline restart, no-replay and claim ownership checks; no platform requests."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import upload_worker_state as state


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.video = self.root / 'fixture.mp4'
        self.video.write_bytes(b'fixture')
        self.cover = self.root / 'cover.png'
        self.cover.write_bytes(b'cover')
        environment = patch.dict(os.environ, HIKVISION_DOWNLOADS_DIR=str(self.root),
                                 BILIUP_BINARY='fixture-biliup', BILIUP_COOKIE_FILE='never-read-cookie',
                                 BILIUP_COVER_FILE=str(self.cover))
        environment.start()
        self.addCleanup(environment.stop)
        self.workers = {}
        for provider, filename in [('bilibili', 'biliup-worker.py'), ('cloud189', 'cloud189-worker.py')]:
            spec = importlib.util.spec_from_file_location(provider, SCRIPTS / filename)
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            worker.JOBS.mkdir(parents=True)
            self.workers[provider] = worker
        # These tests isolate recovery. Collection eligibility has a separate
        # fail-closed suite; never let a recovery fixture invoke the network.
        preflight = patch.object(self.workers['bilibili'], 'collection_preflight', return_value={})
        preflight.start()
        self.addCleanup(preflight.stop)
        # Every network edge is forbidden unless a test explicitly supplies a mock.
        guard = patch.object(self.workers['bilibili'].urllib.request, 'build_opener', side_effect=AssertionError('No network in tests'))
        guard.start()
        self.addCleanup(guard.stop)

    def job(self, provider, **changes):
        worker = self.workers[provider]
        value = dict(id='00000000-0000-0000-0000-000000000001', filename='fixture.mp4',
                     size=7, status='queued', title='fixture', targetPath='/足球录像')
        value.update(changes)
        file = worker.JOBS / (value['id'] + '.json')
        state.save(file, value)
        return worker, file, value

    def cycle(self, provider):
        worker = self.workers[provider]
        if provider == 'bilibili':
            worker.process_queue()
        else:
            worker.process_queue('fixture-cloud189', True)

    def mock_success(self, provider):
        worker = self.workers[provider]
        if provider == 'bilibili':
            return patch.object(worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'BV1234567890', b''))
        return patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0))

    def test_queued_and_interrupted_preflight_resume_once(self):
        for provider in self.workers:
            for status, phase in [('queued', 'queued'), ('uploading', 'preflight')]:
                with self.subTest(provider=provider, status=status):
                    worker, file, _ = self.job(provider, status=status, uploadPhase=phase)
                    with self.mock_success(provider) as upload, patch.object(self.workers['bilibili'], 'ensure_football_collection'):
                        self.cycle(provider)
                        saved = json.loads(file.read_text())
                        self.assertEqual(saved['status'], 'completed')
                        self.assertEqual(saved['id'], file.stem)
                        completed = file.read_bytes()
                        self.cycle(provider)
                        self.assertEqual(file.read_bytes(), completed)
                        upload.assert_called_once()

    def test_ambiguous_remote_or_legacy_claim_never_replayed(self):
        cases = [('uploading', 'remote_started', False), ('uploading', None, False),
                 ('unknown', None, False), ('queued', None, True), ('uploading', 'queued', True),
                 ('queued', 'preflight', True)]
        for provider in self.workers:
            for status, phase, legacy in cases:
                with self.subTest(provider=provider, status=status, phase=phase, legacy=legacy):
                    worker, file, _ = self.job(provider, status=status, uploadPhase=phase)
                    file.with_suffix('.claim').unlink(missing_ok=True)
                    if legacy:
                        file.with_suffix('.claim').write_bytes(b'')
                    with self.mock_success(provider) as upload:
                        self.cycle(provider)
                        self.cycle(provider)
                        self.assertEqual(json.loads(file.read_text())['status'], 'unknown')
                        upload.assert_not_called()

    def test_cloud_auth_unavailable_stays_queued_and_resumes(self):
        worker, file, _ = self.job('cloud189')
        with patch.object(worker.subprocess, 'run') as run:
            worker.process_queue(None, False)
            saved = json.loads(file.read_text())
            self.assertEqual(saved['status'], 'queued')
            self.assertEqual(saved['uploadPhase'], 'preflight')
            self.assertGreater(saved['retryAt'], 0)
            run.assert_not_called()
        saved['retryAt'] = 0
        state.save(file, saved)
        with self.mock_success('cloud189') as run:
            self.cycle('cloud189')
            self.assertEqual(json.loads(file.read_text())['status'], 'completed')
            run.assert_called_once()

    def test_bilibili_missing_cover_retries_without_remote_upload(self):
        worker, file, _ = self.job('bilibili')
        self.cover.unlink()
        with patch.object(worker, 'run_upload') as run:
            self.cycle('bilibili')
            saved = json.loads(file.read_text())
            self.assertEqual(saved['status'], 'queued')
            self.assertEqual(saved['uploadPhase'], 'preflight')
            run.assert_not_called()

    def test_spawn_failure_is_retryable_but_post_spawn_failure_is_not(self):
        for provider in self.workers:
            worker, file, _ = self.job(provider)
            target = patch.object(worker.subprocess, 'Popen', side_effect=FileNotFoundError()) if provider == 'bilibili' else patch.object(worker.subprocess, 'run', side_effect=FileNotFoundError())
            with target:
                self.cycle(provider)
                saved = json.loads(file.read_text())
                self.assertEqual(saved['status'], 'queued')
                self.assertEqual(saved['uploadPhase'], 'preflight')
            self.job(provider)
            target = patch.object(worker, 'run_upload', side_effect=PermissionError('progress persistence failed')) if provider == 'bilibili' else patch.object(worker.subprocess, 'run', side_effect=RuntimeError('ambiguous failure'))
            with target:
                self.cycle(provider)
                self.assertEqual(json.loads(file.read_text())['status'], 'unknown')

    def test_source_replacement_same_size_is_not_uploaded(self):
        for provider in self.workers:
            stat = self.video.stat()
            identity = dict(size=7, mtimeMs=stat.st_mtime_ns // 1_000_000, ino=str(stat.st_ino), dev=str(stat.st_dev))
            worker, file, _ = self.job(provider, uploadPhase='preflight', status='uploading', sourceIdentity=identity)
            replacement = self.root / 'replacement.mp4'
            replacement.write_bytes(b'changed')
            replacement.replace(self.video)
            with self.mock_success(provider) as upload:
                self.cycle(provider)
                self.assertEqual(json.loads(file.read_text())['status'], 'error')
                upload.assert_not_called()

    def test_cloud_path_checks_and_checkpoint_precedes_remote_execution(self):
        worker, file, _ = self.job('cloud189')
        self.assertEqual(worker.safe_video('fixture.mp4', 7), self.video)
        self.assertIsNone(worker.safe_video('../fixture.mp4', 7))
        link = self.root / 'link.mp4'
        link.symlink_to(self.video)
        self.assertIsNone(worker.safe_video('link.mp4', 7))
        def execute(*args, **kwargs):
            self.assertEqual(json.loads(file.read_text())['uploadPhase'], 'remote_started')
            self.assertTrue(kwargs.get('pass_fds'))
            return subprocess.CompletedProcess([], 0)
        with patch.object(worker.subprocess, 'run', side_effect=execute):
            self.cycle('cloud189')
        saved = json.loads(file.read_text())
        self.assertTrue(worker.confirmed_receipt(saved))
        saved.update(status='uploading')
        state.save(file, saved)
        with patch.object(worker.subprocess, 'run') as run:
            self.cycle('cloud189')
            self.assertEqual(json.loads(file.read_text())['status'], 'completed')
            run.assert_not_called()

    def test_cloud_mismatched_receipt_never_counts_as_completion(self):
        worker, file, job = self.job('cloud189', status='uploading', uploadPhase='remote_started',
            uploadReceipt=dict(provider='cloud189', outcome='cli_success', exitCode=0, filename='other.mp4', size=7, targetPath='/足球录像'))
        with patch.object(worker.subprocess, 'run') as run:
            self.cycle('cloud189')
            self.assertEqual(json.loads(file.read_text())['status'], 'unknown')
            run.assert_not_called()

    def test_bilibili_recorded_id_is_verified_without_reupload(self):
        worker, file, _ = self.job('bilibili', status='uploading', uploadPhase='remote_started', bvid='BV1234567890')
        details = dict(archive=dict(bvid='BV1234567890', title='fixture'), videos=[dict(cid=1)])
        with patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(details).encode(), b'')) as show, \
             patch.object(worker, 'run_upload') as upload, patch.object(worker, 'ensure_football_collection') as collection:
            self.cycle('bilibili')
            saved = json.loads(file.read_text())
            self.assertEqual(saved['status'], 'completed')
            self.assertEqual(saved['collectionStatus'], 'completed')
            self.assertEqual(show.call_args.args[0][-2:], ['show', 'BV1234567890'])
            upload.assert_not_called()
            collection.assert_called_once()

    def test_bilibili_unverified_id_stays_unknown_with_verification_backoff(self):
        worker, file, _ = self.job('bilibili', status='unknown', bvid='BV1234567890')
        with patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')) as show, \
             patch.object(worker, 'run_upload') as upload:
            self.cycle('bilibili')
            self.cycle('bilibili')
            self.assertEqual(json.loads(file.read_text())['status'], 'unknown')
            show.assert_called_once()
            upload.assert_not_called()

    def test_bilibili_pending_collection_recovers_independently(self):
        worker, file, _ = self.job('bilibili', status='completed', bvid='BV1234567890', collectionStatus='pending')
        with patch.object(worker, 'run_upload') as upload, patch.object(worker, 'ensure_football_collection', side_effect=RuntimeError()) as collection:
            self.cycle('bilibili')
            self.cycle('bilibili')
            saved = json.loads(file.read_text())
            self.assertEqual(saved['status'], 'completed')
            self.assertEqual(saved['collectionStatus'], 'pending')
            collection.assert_called_once()
            upload.assert_not_called()
        saved['collectionRetryAt'] = 0
        state.save(file, saved)
        with patch.object(worker, 'run_upload') as upload, patch.object(worker, 'ensure_football_collection'):
            self.cycle('bilibili')
            self.assertEqual(json.loads(file.read_text())['collectionStatus'], 'completed')
            upload.assert_not_called()

    def test_partial_cloud_receipt_does_not_confirm_an_upload(self):
        worker = self.workers['cloud189']
        for receipt in [None, {}, {'provider': 'cloud189', 'outcome': 'cli_success', 'exitCode': 0}]:
            self.assertFalse(worker.confirmed_receipt({'uploadReceipt': receipt}))

    def test_successful_bilibili_id_survives_a_checkpoint_failure(self):
        worker, file, _ = self.job('bilibili')
        failed = False
        def save_with_one_failure(file, job):
            nonlocal failed
            if job.get('uploadPhase') == 'submitted' and not failed:
                failed = True
                raise OSError('simulated persistence failure after successful remote response')
            state.save(file, job)
        with self.mock_success('bilibili') as upload, patch.object(worker, 'save', side_effect=save_with_one_failure), \
             patch.object(worker, 'ensure_football_collection') as collection:
            self.cycle('bilibili')
            saved = json.loads(file.read_text())
            self.assertEqual(saved['status'], 'completed')
            self.assertEqual(saved['bvid'], 'BV1234567890')
            self.cycle('bilibili')
            upload.assert_called_once()
            collection.assert_called_once()

    def test_remote_checkpoint_failure_never_starts_cli(self):
        for provider in self.workers:
            worker, file, _ = self.job(provider)
            def fail_remote_checkpoint(file, job):
                if job.get('uploadPhase') == 'remote_started':
                    raise OSError('checkpoint cannot be persisted')
                state.save(file, job)
            with self.mock_success(provider) as upload, patch.object(worker, 'save', side_effect=fail_remote_checkpoint):
                self.cycle(provider)
                upload.assert_not_called()
                self.assertEqual(json.loads(file.read_text())['uploadPhase'], 'preflight')

    def test_cloud_failure_after_remote_attempt_stays_unknown(self):
        for result in [subprocess.CompletedProcess([], 2), subprocess.TimeoutExpired('fixture', 1)]:
            worker, file, _ = self.job('cloud189')
            options = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with patch.object(worker.subprocess, 'run', **options) as upload:
                self.cycle('cloud189')
                self.cycle('cloud189')
                self.assertEqual(json.loads(file.read_text())['status'], 'unknown')
                upload.assert_called_once()

    def test_terminal_history_is_not_rewritten(self):
        for provider in self.workers:
            for status in ('draft', 'completed', 'error', 'cancelled'):
                worker, file, _ = self.job(provider, status=status, historical='preserve me')
                before = file.read_bytes()
                with self.mock_success(provider) as upload:
                    self.cycle(provider)
                    self.assertEqual(file.read_bytes(), before)
                    upload.assert_not_called()

    def test_existing_claim_blocks_concurrent_workers_and_surviving_cli(self):
        worker, file, _ = self.job('cloud189', status='uploading', uploadPhase='preflight')
        with state.claim_job(file) as held:
            self.assertTrue(held)
            with patch.object(worker.subprocess, 'run') as run:
                self.cycle('cloud189')
                self.assertEqual(json.loads(file.read_text())['status'], 'uploading')
                run.assert_not_called()
            child = subprocess.Popen([sys.executable, '-c', "import sys; print('ready', flush=True); sys.stdin.read()"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, **state.subprocess_claim())
            self.assertEqual(child.stdout.readline(), b'ready\n')
        try:
            with state.claim_job(file) as held:
                self.assertFalse(held, 'CLI child must keep its claim after the parent closes its descriptor')
        finally:
            child.stdin.close()
            child.wait(timeout=10)
            child.stdout.close()
        with state.claim_job(file) as held:
            self.assertTrue(held)
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()

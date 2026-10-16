"""No real binary, login, or network request is allowed in this test suite."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import upload_worker_state as state

class ManagedCloudTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root/'fixture.mp4'; self.video.write_bytes(b'fixture')
        env = patch.dict(os.environ, HIKVISION_DOWNLOADS_DIR=str(self.root), CLOUD189_BACKEND='gowsp',
                         CLOUD189_CONFIG_FILE=str(self.root/'private/config.json'))
        env.start(); self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location('managed_cloud', ROOT/'scripts/cloud189-worker.py')
        self.worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.worker)
        self.worker.JOBS.mkdir(parents=True)
        self.file = self.worker.JOBS/'00000000-0000-0000-0000-000000000001.json'
        stat = self.video.stat()
        self.job = dict(id=self.file.stem, filename='fixture.mp4', size=7, status='queued', uploadPhase='queued',
                        targetPath='/football', sourceIdentity=dict(size=7, mtimeMs=stat.st_mtime_ns//1000000,
                        ino=str(stat.st_ino), dev=str(stat.st_dev)))
        state.save(self.file, self.job)
        self.parent = dict(path='/football', name='football', is_dir=True, file_id='20')
        self.entry = dict(path='/football/fixture.mp4', name='fixture.mp4', size=7, is_dir=False,
                          file_id='123', checksum=hashlib.md5(b'fixture').hexdigest())

    def saved(self): return json.loads(self.file.read_text())
    def cycle(self): self.worker.process_queue('/pinned/cloud189', True)

    def test_exact_machine_arguments_and_verified_receipt(self):
        def execute(args, **options):
            self.assertEqual(args[:4], ['/pinned/cloud189', '--config', self.worker.CONFIG, '--json'])
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            self.assertGreaterEqual(len(options['pass_fds']), 2, 'job and provider operation locks are inherited')
            if args[4] == 'up':
                self.assertEqual(self.saved()['uploadPhase'], 'remote_started')
                self.assertEqual(args[5:], ['--input', str(self.video), '--path', '/football/fixture.mp4', '--policy', 'skip'])
            value = self.parent if execute.calls == 0 else None if execute.calls == 1 else self.entry
            execute.calls += 1
            return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
        execute.calls = 0
        with patch.object(self.worker.subprocess, 'run', side_effect=execute) as run:
            self.cycle(); self.assertEqual(run.call_count, 4)
            saved = self.saved(); self.assertEqual(saved['status'], 'completed')
            self.assertTrue(self.worker.confirmed_receipt(saved))
            self.cycle(); self.assertEqual(run.call_count, 4)

    def test_same_size_collision_is_rejected_without_upload(self):
        with patch.object(self.worker, 'run_json', side_effect=[self.parent, self.entry]) as run:
            self.cycle(); self.assertEqual(self.saved()['status'], 'error')
            self.assertEqual(self.saved()['uploadPhase'], 'preflight'); self.assertEqual(run.call_count, 2)

    def test_missing_checksum_wrong_id_and_mismatch_stay_unknown_without_replay(self):
        for uploaded, verified in [({**self.entry, 'checksum': ''}, self.entry),
                                    (self.entry, {**self.entry, 'file_id': 'other'}),
                                    (self.entry, {**self.entry, 'checksum': '0'*32}),
                                    (self.entry, None)]:
            state.save(self.file, self.job)
            with patch.object(self.worker, 'run_json', side_effect=[self.parent, None, uploaded, verified]) as run:
                self.cycle(); calls = run.call_count
                self.assertEqual(self.saved()['status'], 'unknown'); self.cycle()
                self.assertEqual(run.call_count, calls)

    def test_post_upload_timeout_stays_unknown(self):
        with patch.object(self.worker, 'run_json', side_effect=[self.parent, None, subprocess.TimeoutExpired('mock', 1)]) as run:
            self.cycle(); self.assertEqual(self.saved()['status'], 'unknown')
            self.cycle(); self.assertEqual(run.call_count, 3)

    def test_preflight_network_failure_can_retry_without_remote_attempt(self):
        with patch.object(self.worker, 'run_json', side_effect=RuntimeError('private output')) as run:
            self.cycle(); saved = self.saved(); self.assertEqual(saved['status'], 'queued')
            self.assertEqual(saved['uploadPhase'], 'preflight'); run.assert_called_once()
            self.assertNotIn('private output', self.file.read_text())

    def test_locked_account_defers_all_operations(self):
        with state.account_lock(self.worker.WORK) as owned:
            self.assertTrue(owned)
            with patch.object(self.worker, 'run_json') as run:
                self.cycle(); run.assert_not_called()
                self.assertEqual(self.saved()['status'], 'queued')
                self.assertFalse(self.worker.login_ready('/pinned/cloud189'))

    def test_df_requires_positive_typed_success(self):
        for value, expected in [(dict(ok=True, capacity=10, available=5), True),
                                (dict(ok=True, capacity=True, available=5), False),
                                (dict(ok=False), False), (None, False)]:
            with patch.object(self.worker, 'run_json', return_value=value):
                self.assertEqual(self.worker.login_ready('/pinned/cloud189'), expected)

    def test_remote_checkpoint_failure_never_launches_upload(self):
        def save(file, value):
            if value.get('uploadPhase') == 'remote_started': raise OSError('fixture')
            state.save(file, value)
        with patch.object(self.worker, 'run_json', side_effect=[self.parent, None]) as run, patch.object(self.worker, 'save', side_effect=save):
            self.cycle(); self.assertEqual(run.call_count, 2)
            self.assertEqual(self.saved()['uploadPhase'], 'preflight')

    def test_both_locks_survive_parent_close_until_cli_exits(self):
        with state.named_lock(self.worker.WORK/'worker.lock') as singleton, state.account_lock(self.worker.WORK) as operation, state.claim_job(self.file) as job:
            self.assertTrue(singleton and operation and job)
            child = subprocess.Popen([sys.executable, '-c', "import sys; print('ready', flush=True); sys.stdin.read()"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, **state.subprocess_claim())
            self.assertEqual(child.stdout.readline(), b'ready\n')
        try:
            with state.named_lock(self.worker.WORK/'worker.lock') as singleton, state.account_lock(self.worker.WORK) as operation:
                self.assertFalse(singleton); self.assertFalse(operation)
        finally:
            child.stdin.close(); child.wait(timeout=5); child.stdout.close()
        with state.named_lock(self.worker.WORK/'worker.lock') as singleton, state.account_lock(self.worker.WORK) as operation:
            self.assertTrue(singleton and operation)

    def prepare_unknown(self):
        self.job.update(provider='cloud189', status='unknown', uploadPhase='remote_started', connectionGeneration='a'*32)
        state.save(self.file, self.job)
        binding = self.root/'connection.json'
        binding.write_text(json.dumps(dict(version=1, generation='a'*32))); binding.chmod(0o600)
        env = patch.dict(os.environ, HIKCLIP_UPLOAD_GENERATION_REQUIRED='1', HIKCLIP_UPLOAD_CONNECTION_FILE=str(binding))
        env.start(); self.addCleanup(env.stop)

    def test_missing_fixed_target_created_then_verified_before_upload(self):
        self.job['targetPath'] = '/H1kM3sh'; state.save(self.file, self.job)
        parent = dict(path='/H1kM3sh', name='H1kM3sh', is_dir=True, file_id='20')
        entry = {**self.entry, 'path': '/H1kM3sh/fixture.mp4'}
        calls = []
        def execute(args, **options):
            calls.append(args[4:])
            index = len(calls)
            if args[4] == 'mkdir':
                self.assertEqual(args[5:], ['/H1kM3sh'])
                self.assertEqual(self.saved()['uploadPhase'], 'preflight')
                return subprocess.CompletedProcess(args, 0, b'', b'')
            value = {1: None, 3: parent, 4: None, 5: entry, 6: entry}[index]
            return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
        with patch.object(self.worker.subprocess, 'run', side_effect=execute):
            self.cycle()
        self.assertEqual([x[0] for x in calls], ['stat','mkdir','stat','stat','up','stat'])
        self.assertEqual(self.saved()['status'], 'completed')

    def test_auth_failure_never_creates_target(self):
        self.job['targetPath']='/H1kM3sh'; state.save(self.file, self.job)
        with patch.object(self.worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'{"ok":false,"error":"private-token"}')) as run:
            self.cycle(); run.assert_called_once()
            self.assertEqual(run.call_args.args[0][-2:], ['stat','/H1kM3sh'])
        self.assertEqual(self.saved()['status'],'queued')
        self.assertNotIn('private-token', self.file.read_text())

    def test_other_missing_target_never_creates_directory(self):
        with patch.object(self.worker, 'run_json', return_value=None) as run, patch.object(self.worker.subprocess, 'run') as raw:
            self.cycle(); run.assert_called_once(); raw.assert_not_called()
        self.assertEqual(self.saved()['errorCode'], 'CLOUD_TARGET_MISSING')

    def test_existing_file_or_invalid_parent_never_uploads(self):
        for parent in [{**self.parent,'is_dir':False},{**self.parent,'file_id':''},{**self.parent,'path':'/other'}]:
            state.save(self.file,self.job)
            with patch.object(self.worker,'run_json',return_value=parent) as run:
                self.cycle(); run.assert_called_once()
            self.assertEqual(self.saved()['errorCode'],'CLOUD_TARGET_INVALID')

    def test_readonly_reconcile_success_requires_two_exact_stats(self):
        self.prepare_unknown()
        with patch.object(self.worker,'run_json',side_effect=[self.entry,self.entry]) as run:
            result=self.worker.verify_managed_job(self.file.stem,'/pinned/cloud189')
            self.assertTrue(result['ok'])
            self.assertEqual([c.args[1] for c in run.call_args_list], [['stat','/football/fixture.mp4']]*2)
        self.assertEqual(self.saved()['status'],'completed')
        self.assertIsNone(self.saved()['uploadReceipt']['exitCode'])
        self.assertTrue(self.worker.confirmed_receipt(self.saved()))

    def test_readonly_absence_or_mismatch_never_requeues(self):
        for responses in [[None,None], [None,self.parent], [{**self.entry,'checksum':'0'*32}], [self.entry,{**self.entry,'file_id':'999'}]]:
            self.prepare_unknown()
            with patch.object(self.worker,'run_json',side_effect=responses) as run:
                result=self.worker.verify_managed_job(self.file.stem,'/pinned/cloud189')
                self.assertFalse(result['ok'])
                self.assertTrue(all(c.args[1][0]=='stat' for c in run.call_args_list))
                self.assertEqual(self.saved()['status'],'unknown')
                self.cycle(); self.assertEqual(run.call_count,len(responses))

    def test_reconcile_generation_source_and_lock_fail_closed(self):
        self.prepare_unknown()
        with state.account_lock(self.worker.WORK):
            with patch.object(self.worker,'run_json') as run:
                self.assertEqual(self.worker.verify_managed_job(self.file.stem,'/pinned/cloud189')['code'],'VERIFY_BUSY')
                run.assert_not_called()
        self.video.write_bytes(b'changed')
        with patch.object(self.worker,'run_json') as run:
            self.assertEqual(self.worker.verify_managed_job(self.file.stem,'/pinned/cloud189')['code'],'VERIFY_SOURCE_CHANGED')
            run.assert_not_called()
        self.job['connectionGeneration']='b'*32; state.save(self.file,self.job)
        with patch.object(self.worker,'run_json') as run:
            self.assertEqual(self.worker.verify_managed_job(self.file.stem,'/pinned/cloud189')['code'],'ACCOUNT_CHANGED')
            run.assert_not_called()

    def test_cli_stdout_and_stderr_are_not_interchangeable(self):
        with patch.object(self.worker.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'',json.dumps(self.entry).encode())):
            with self.assertRaises(self.worker.CloudCommandError) as failure:
                self.worker.run_json('/pinned/cloud189',['stat','/football/fixture.mp4'])
            self.assertEqual(failure.exception.code,'CLOUD_RESULT_INVALID_JSON')
        with patch.object(self.worker.subprocess,'run',return_value=subprocess.CompletedProcess([],1,json.dumps(self.entry).encode(),b'{"ok":false,"error":"private"}')):
            with self.assertRaises(self.worker.CloudCommandError) as failure:
                self.worker.run_json('/pinned/cloud189',['stat','/football/fixture.mp4'])
            self.assertEqual(failure.exception.code,'CLOUD_CLI_FAILED')

    def test_archive_releases_only_idle_unknown_and_preserves_outcome(self):
        self.prepare_unknown()
        with patch.object(self.worker, 'run_json') as run:
            result = self.worker.archive_managed_job(self.file.stem)
            self.assertEqual(result, dict(ok=True, code='CLOUD_RECORD_ARCHIVED'))
            saved = self.saved()
            self.assertEqual(saved['status'], 'unknown')
            self.assertEqual(saved['uploadPhase'], 'remote_started')
            self.assertTrue(saved['archivedAt'])
            self.cycle()
            run.assert_not_called()
            self.assertEqual(self.saved(), saved)
            self.assertEqual(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189')['code'], 'VERIFY_NOT_ELIGIBLE')
            self.assertEqual(self.worker.archive_managed_job(self.file.stem, restore=True)['code'], 'CLOUD_RECORD_RESTORED')
            self.assertNotIn('archivedAt', self.saved())

    def test_archive_does_not_require_old_account_but_refuses_active_locks(self):
        self.prepare_unknown()
        self.job['connectionGeneration'] = 'b'*32; state.save(self.file, self.job)
        for lock in (state.account_lock(self.worker.WORK), state.claim_job(self.file)):
            with lock as owned:
                self.assertTrue(owned)
                self.assertEqual(self.worker.archive_managed_job(self.file.stem)['code'], 'VERIFY_BUSY')
                self.assertNotIn('archivedAt', self.saved())
        with patch.object(self.worker, 'run_json') as run:
            self.assertTrue(self.worker.archive_managed_job(self.file.stem)['ok'])
            run.assert_not_called()

    def test_archive_never_clears_uploading_or_queued_state(self):
        self.prepare_unknown()
        for status in ('uploading', 'queued', 'completed'):
            self.job['status'] = status; state.save(self.file, self.job)
            self.assertEqual(self.worker.archive_managed_job(self.file.stem)['code'], 'VERIFY_NOT_ELIGIBLE')
            self.assertEqual(self.saved()['status'], status)
            self.assertNotIn('archivedAt', self.saved())

    def test_explicit_retry_rechecks_absence_preserves_original_and_only_queues(self):
        self.prepare_unknown()
        self.job.update(errorCode='CLOUD_RESULT_INVALID_JSON', message='original unknown', startedAt='2026-01-01T00:00:00Z')
        state.save(self.file, self.job)
        with patch.object(self.worker, 'run_json', side_effect=[None, self.parent, None]) as run:
            self.assertEqual(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True), dict(ok=True, code='CLOUD_RETRY_QUEUED'))
            self.assertEqual([c.args[1][0] for c in run.call_args_list], ['stat']*3)
        saved = self.saved()
        self.assertEqual(saved['status'], 'queued')
        self.assertEqual(saved['uploadPhase'], 'preflight')
        self.assertEqual(saved['retryCount'], 1)
        self.assertNotIn('startedAt', saved)
        self.assertNotIn('errorCode', saved)
        self.assertEqual(saved['attemptHistory'][0]['status'], 'unknown')
        self.assertEqual(saved['attemptHistory'][0]['errorCode'], 'CLOUD_RESULT_INVALID_JSON')
        self.assertEqual(saved['attemptHistory'][0]['message'], 'original unknown')
        with patch.object(self.worker, 'run_json') as run:
            self.assertEqual(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)['code'], 'VERIFY_NOT_ELIGIBLE')
            run.assert_not_called()

    def test_retry_never_requeues_on_invalid_parent_collision_source_or_account_change(self):
        for values in [[None, {'unexpected':'private'}], [None, self.parent, self.entry], [None, None], [self.entry, {**self.entry, 'file_id':'999'}]]:
            self.prepare_unknown()
            with patch.object(self.worker, 'run_json', side_effect=values):
                result = self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)
                self.assertFalse(result['ok'])
                self.assertEqual(self.saved()['status'], 'unknown')
                self.assertNotIn('attemptHistory', self.saved())
        self.prepare_unknown()
        def changed(*args):
            self.video.write_bytes(b'changed')
            return self.parent if args[1][-1] == '/football' else None
        with patch.object(self.worker, 'run_json', side_effect=changed):
            self.assertEqual(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)['code'], 'VERIFY_SOURCE_CHANGED')
            self.assertEqual(self.saved()['status'], 'unknown')

    def test_retry_matching_remote_reconciles_without_new_attempt(self):
        self.prepare_unknown()
        with patch.object(self.worker, 'run_json', side_effect=[self.entry, self.entry]) as run:
            self.assertEqual(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)['code'], 'CLOUD_REMOTE_VERIFIED')
            self.assertTrue(all(c.args[1][0] == 'stat' for c in run.call_args_list))
        self.assertEqual(self.saved()['status'], 'completed')
        self.assertNotIn('attemptHistory', self.saved())

    def test_renamed_local_source_retains_original_remote_destination(self):
        self.prepare_unknown()
        renamed = self.root/'renamed.mp4'; self.video.rename(renamed)
        self.job['sourceFilename'] = 'renamed.mp4'; state.save(self.file, self.job)
        with patch.object(self.worker, 'run_json', side_effect=[None, self.parent, None]) as run:
            self.assertTrue(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)['ok'])
            self.assertEqual(run.call_args_list[0].args[1], ['stat', '/football/fixture.mp4'])
        self.video = renamed
        with patch.object(self.worker, 'run_json', side_effect=[self.parent, None, self.entry, self.entry]) as run:
            self.cycle()
            self.assertEqual(run.call_args_list[2].args[1], ['up', '--input', str(renamed), '--path', '/football/fixture.mp4', '--policy', 'skip'])
        self.assertEqual(self.saved()['status'], 'completed')

    def test_retry_fixed_default_missing_target_requires_repeated_absence(self):
        self.prepare_unknown()
        self.job['targetPath']='/H1kM3sh'; state.save(self.file, self.job)
        with patch.object(self.worker, 'run_json', side_effect=[None, None, None]) as run:
            self.assertTrue(self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)['ok'])
            self.assertTrue(all(c.args[1][0] == 'stat' for c in run.call_args_list))
        self.assertEqual(self.saved()['status'], 'queued')

    def test_archive_refuses_inherited_live_cli_locks_after_worker_exits(self):
        self.prepare_unknown()
        with state.account_lock(self.worker.WORK), state.claim_job(self.file):
            child = subprocess.Popen([sys.executable, '-c', "import sys; print('ready', flush=True); sys.stdin.read()"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, **state.subprocess_claim())
            self.assertEqual(child.stdout.readline(), b'ready\n')
        try:
            self.assertEqual(self.worker.archive_managed_job(self.file.stem)['code'], 'VERIFY_BUSY')
            self.assertNotIn('archivedAt', self.saved())
        finally:
            child.stdin.close(); child.wait(timeout=5); child.stdout.close()
        self.assertTrue(self.worker.archive_managed_job(self.file.stem)['ok'])

    def test_explicit_retry_never_changes_account_binding(self):
        self.prepare_unknown()
        self.job['connectionGeneration'] = 'b'*32; state.save(self.file, self.job)
        with patch.object(self.worker, 'run_json') as run:
            result = self.worker.verify_managed_job(self.file.stem, '/pinned/cloud189', retry=True)
            self.assertEqual(result['code'], 'ACCOUNT_CHANGED')
            self.assertEqual(self.saved()['status'], 'unknown')
            self.assertEqual(self.saved()['connectionGeneration'], 'b'*32)
            self.assertNotIn('attemptHistory', self.saved())
            run.assert_not_called()

if __name__ == '__main__': unittest.main()

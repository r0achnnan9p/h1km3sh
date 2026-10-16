"""Read-only collection eligibility is required before a remote upload starts."""
import copy
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


class CollectionPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cookie = self.root / 'cookie.json'
        self.cookie.write_text(json.dumps({'token_info': {'mid': 123}}))
        self.video = self.root / 'fixture.mp4'
        self.video.write_bytes(b'video')
        self.cover = self.root / 'cover.png'
        self.cover.write_bytes(b'cover')
        env = patch.dict(os.environ, HIKVISION_DOWNLOADS_DIR=str(self.root), BILIUP_COOKIE_FILE=str(self.cookie),
                         BILIUP_BINARY='/never-executed', BILIUP_COVER_FILE=str(self.cover), BILIUP_SEASON_ID='10', BILIUP_SECTION_ID='20')
        env.start(); self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location('bili_preflight', SCRIPTS / 'biliup-worker.py')
        self.worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.worker)
        self.worker.JOBS.mkdir(parents=True)
        self.job = dict(id='fixture', filename='fixture.mp4', size=5, status='uploading', uploadPhase='preflight', title='fixture')
        self.file = self.worker.JOBS / 'fixture.json'
        self.listing = {'total': 1, 'seasons': [{'season': {'id': 10, 'title': '足球', 'mid': 123, 'state': 0, 'forbid': 0},
                         'checkin': {'status': 0, 'season_status': 1}, 'sections': {'sections': [{'id': 20, 'seasonId': 10, 'state': 0}]}}]}
        self.details = {'section': {'id': 20, 'seasonId': 10, 'state': 0}, 'episodes': []}
        self.calls = []

    def request(self, endpoint, method='GET', payload=None):
        self.calls.append((endpoint, method, payload))
        self.assertEqual(method, 'GET'); self.assertIsNone(payload)
        if endpoint == '/x/space/myinfo': return {'mid': 123}
        if endpoint.startswith('/x2/creative/web/seasons?'): return self.listing
        return self.details

    def fail_before_upload(self):
        with patch.object(self.worker, 'bilibili_request', side_effect=self.request), patch.object(self.worker, 'run_upload') as upload:
            with self.assertRaises(ValueError): self.worker.upload(self.file, self.job)
            upload.assert_not_called()
            self.assertEqual(self.job['uploadPhase'], 'preflight')
            self.assertFalse(self.file.exists())

    def test_matching_owned_approved_collection_checked_before_upload(self):
        def run(*args):
            self.assertEqual(len(self.calls), 3)
            self.assertEqual(self.job['uploadPhase'], 'remote_started')
            return subprocess.CompletedProcess([], 0, b'no-confirmed-bvid', b'')
        with patch.object(self.worker, 'bilibili_request', side_effect=self.request), patch.object(self.worker, 'run_upload', side_effect=run) as upload:
            self.worker.upload(self.file, self.job); upload.assert_called_once()

    def test_optional_viewer_checkin_is_not_upload_eligibility(self):
        # Official creator UI uses these fields for 打卡设置, not video upload.
        for checkin in [None, {}, {'status': 0, 'season_status': 0},
                        {'status': 1, 'season_status': 1}, {'status': 2, 'season_status': -1}]:
            with self.subTest(checkin=checkin):
                self.listing['seasons'][0]['checkin'] = checkin
                self.job['uploadPhase'] = 'preflight'
                with patch.object(self.worker, 'bilibili_request', side_effect=self.request), patch.object(self.worker, 'run_upload', return_value=subprocess.CompletedProcess([], 0, b'no-confirmed-bvid', b'')) as upload:
                    self.worker.upload(self.file, self.job)
                    upload.assert_called_once()
        self.listing['seasons'][0].pop('checkin')
        with patch.object(self.worker, 'bilibili_request', side_effect=self.request):
            self.assertEqual(self.worker.collection_preflight(), self.details)

    def test_wrong_or_missing_collection_name_never_uploads(self):
        for title in ['篮球', '', None]:
            self.listing['seasons'][0]['season']['title'] = title
            self.fail_before_upload()

    def test_mismatched_section_never_uploads(self):
        self.details['section']['seasonId'] = 999; self.fail_before_upload()

    def test_foreign_owner_never_uploads(self):
        self.listing['seasons'][0]['season']['mid'] = 456; self.fail_before_upload()

    def test_missing_target_never_uploads(self):
        self.listing['seasons'] = []; self.fail_before_upload()

    def test_forbidden_or_unreviewed_or_unknown_fields_fail_closed(self):
        baseline = copy.deepcopy(self.listing)
        for owner, key, value in [('season', 'forbid', 1), ('season', 'state', -6), ('season', 'state', None), ('season', 'forbid', None)]:
            with self.subTest(key=key):
                self.listing = copy.deepcopy(baseline); self.listing['seasons'][0][owner][key] = value; self.fail_before_upload()

    def test_identity_mismatch_never_uploads(self):
        self.cookie.write_text(json.dumps({'token_info': {'mid': 456}})); self.fail_before_upload()

    def test_network_failure_never_crosses_remote_boundary(self):
        with patch.object(self.worker, 'bilibili_request', side_effect=TimeoutError()), patch.object(self.worker, 'run_upload') as upload:
            with self.assertRaises(TimeoutError): self.worker.upload(self.file, self.job)
            upload.assert_not_called(); self.assertEqual(self.job['uploadPhase'], 'preflight')

    def test_pagination_is_bounded(self):
        self.listing = {'total': 10000, 'seasons': [{'season': {'id': 999}}] * 50}
        self.fail_before_upload(); self.assertEqual(len(self.calls), 11)

    def test_preflight_diagnostics_are_fixed_and_safe(self):
        code, detail = self.worker.preflight_failure(ValueError('合集小节关系未确认'), 'collection')
        self.assertEqual(code, 'preflight_section_relationship')
        self.assertIn('小节', detail)
        for error in [ValueError('SECRET_COOKIE'), RuntimeError('SECRET_COOKIE'), KeyError('SECRET_COOKIE')]:
            code, detail = self.worker.preflight_failure(error, 'collection')
            self.assertEqual(code, 'preflight_collection')
            self.assertNotIn('SECRET', detail)
        self.assertEqual(self.worker.preflight_failure(TimeoutError('SECRET'), 'collection')[0], 'preflight_network')

    def test_queue_reports_collection_gate_without_starting_upload(self):
        self.job['status'] = 'queued'
        self.file.write_text(json.dumps(self.job))
        self.details['section']['seasonId'] = 999
        with patch.object(self.worker, 'bilibili_request', side_effect=self.request), patch.object(self.worker, 'run_upload') as upload:
            self.worker.process_queue()
            upload.assert_not_called()
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['status'], 'error')
        self.assertEqual(saved['uploadPhase'], 'preflight')
        self.assertEqual(saved['errorCode'], 'preflight_section_relationship')
        self.assertIn('小节', saved['message'])
        self.assertIn('没有启动上传', saved['message'])
        # A terminal rejected job is not replayed on a second queue pass.
        with patch.object(self.worker, 'upload') as upload:
            self.worker.process_queue()
            upload.assert_not_called()


if __name__ == '__main__': unittest.main()

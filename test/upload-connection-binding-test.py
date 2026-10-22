"""No real providers: prove account replacement never retargets queued jobs."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
SCRIPTS = Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import upload_worker_state as state

class BindingTests(unittest.TestCase):
    def test_managed_workers_check_before_recovery_or_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); binding = root / 'connection.json'
            binding.write_text(json.dumps({'version': 1, 'generation': 'b' * 32})); binding.chmod(0o600)
            with patch.dict(os.environ, HIKVISION_DOWNLOADS_DIR=directory, BILIUP_BINARY='/not-executed', BILIUP_COOKIE_FILE='/not-read',
                            HIKCLIP_UPLOAD_GENERATION_REQUIRED='1', HIKCLIP_UPLOAD_CONNECTION_FILE=str(binding)):
                for name in ('biliup', 'cloud189'):
                    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '-worker.py'))
                    worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker); worker.JOBS.mkdir(parents=True)
                    for generation in (None, 'a' * 32):
                        file = worker.JOBS / 'job.json'; job = {'id': 'job', 'status': 'queued', 'uploadPhase': 'queued'}
                        if generation: job['connectionGeneration'] = generation
                        state.save(file, job)
                        with patch.object(worker, 'recover_job') as recover:
                            worker.process_queue() if name == 'biliup' else worker.process_queue('/not-executed', True)
                            recover.assert_not_called()
                        self.assertEqual(json.loads(file.read_text())['errorCode'], 'ACCOUNT_CHANGED')
                    matching = {'id': 'job', 'status': 'queued', 'connectionGeneration': 'b' * 32}
                    self.assertTrue(state.connection_matches(file, matching))
                    binding.write_text('{invalid'); binding.chmod(0o600)
                    self.assertFalse(state.connection_matches(file, matching))
                    binding.write_text(json.dumps({'version': 1, 'generation': 'b' * 32})); binding.chmod(0o600)

if __name__ == '__main__': unittest.main()

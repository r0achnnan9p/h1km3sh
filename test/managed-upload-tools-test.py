import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-upload-tools.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def archive(self, name='fixture/biliup', symlink=False):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            info = tarfile.TarInfo(name)
            if symlink:
                info.type = tarfile.SYMTYPE; info.linkname = '/etc/passwd'
                archive.addfile(info)
            else:
                info.size = 7; archive.addfile(info, io.BytesIO(b'fixture'))
        return data.getvalue()

    def test_exact_member_and_hash_only(self):
        data = self.archive(); pin = dict(member='fixture/biliup', archiveSha256=hashlib.sha256(data).hexdigest())
        self.assertEqual(installer.extract_binary(data, pin), b'fixture')
        with self.assertRaises(RuntimeError): installer.extract_binary(data, {**pin, 'archiveSha256': '0'*64})
        with self.assertRaises(RuntimeError): installer.extract_binary(data, {**pin, 'member': '../other'})
        link = self.archive(symlink=True)
        with self.assertRaises(RuntimeError): installer.extract_binary(link, {**pin, 'archiveSha256': hashlib.sha256(link).hexdigest()})

    def test_packaging_never_executes_and_refuses_replacement(self):
        data = self.archive(); pin = dict(filename='biliup', member='fixture/biliup', version='test', url='fixture', archiveSha256=hashlib.sha256(data).hexdigest())
        pins = dict(profile='managed-uploads-v1', platform='linux-x64', tools={'bilibili': pin})
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'upload-tools'
            manifest = installer.install(target, pins, fetch=lambda _: data)
            self.assertEqual((target/'biliup').read_bytes(), b'fixture')
            self.assertEqual((target/'biliup').stat().st_mode & 0o777, 0o755)
            self.assertEqual(manifest['tools']['bilibili']['fileSha256'], hashlib.sha256(b'fixture').hexdigest())
            with self.assertRaises(RuntimeError): installer.install(target, pins, fetch=lambda _: data)
            link = Path(directory)/'link'; link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(RuntimeError): installer.install(link/'nested', pins, fetch=lambda _: data)

if __name__ == '__main__': unittest.main()

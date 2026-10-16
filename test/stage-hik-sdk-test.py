import importlib.util
import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('stage_sdk', Path(__file__).resolve().parents[1] / 'scripts/stage-hik-sdk.py')
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)
ID = '11111111-2222-4333-8444-555555555555'


def archive(extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        z.writestr(sdk.LIB_PREFIX + 'libhcnetsdk.so', b'fixture library')
        z.writestr(sdk.LIB_PREFIX + 'HCNetSDKCom/fixture.so', b'component')
        z.writestr('EN-HCNetSDKV6.1.9.4_build20220412_linux64/demo/unused', b'not copied')
        if extra:
            z.writestr(*extra)
    return stream.getvalue()


class Packaging(unittest.TestCase):
    def test_extract_only_libraries(self):
        with tempfile.TemporaryDirectory() as d:
            sdk.extract_libraries(archive(), Path(d))
            self.assertEqual(sorted(str(p.relative_to(d)) for p in Path(d).rglob('*') if p.is_file()), ['HCNetSDKCom/fixture.so', 'libhcnetsdk.so'])

    def test_unsafe_paths(self):
        for name in [sdk.LIB_PREFIX + '../escape', '/tmp/escape', sdk.LIB_PREFIX + 'x\\escape', sdk.LIB_PREFIX + './escape']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(ValueError):
                    sdk.extract_libraries(archive((name, b'bad')), Path(d))

    def test_symlink_member(self):
        entry = zipfile.ZipInfo(sdk.LIB_PREFIX + 'link')
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        with tempfile.TemporaryDirectory() as d, self.assertRaises(ValueError):
            sdk.extract_libraries(archive((entry, b'/etc/passwd')), Path(d))

    def test_archive_pin_and_scope(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); source = root / 'vendor.zip'; source.write_bytes(archive())
            destination = root / 'hik-sdk'
            with self.assertRaises(ValueError):
                sdk.stage(source, destination, [ID])
            self.assertFalse(destination.exists())
            data = source.read_bytes()
            with patch.object(sdk, 'ARCHIVE_SIZE', len(data)):
                with self.assertRaises(ValueError):
                    sdk.stage(source, destination, [ID])
            self.assertFalse(destination.exists())
            with patch.object(sdk, 'ARCHIVE_SIZE', len(data)), patch.object(sdk, 'ARCHIVE_SHA256', hashlib.sha256(data).hexdigest()):
                for ids in [[], ['*'], [ID, ID], ['192.0.2.23']]:
                    with self.assertRaises(ValueError):
                        sdk.stage(source, destination, ids)
                sdk.stage(source, destination, [ID])
                self.assertEqual(json.loads((destination / 'manifest.json').read_text())['deviceIds'], [ID])
                with self.assertRaises(ValueError):
                    sdk.stage(source, destination, [ID])

    def test_destination_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / 'actual').mkdir(); (root / 'link').symlink_to(root / 'actual')
            with self.assertRaises(ValueError):
                sdk.stage(root / 'vendor.zip', root / 'link/hik-sdk', [ID])


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Stage the licensed, pinned SDK from an existing local archive; never download or execute it."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import tempfile
import zipfile

ARCHIVE_SIZE = 68211785
ARCHIVE_SHA256 = '964bd4d4e470aa6865c2c50d8c149753452a1853a070cbd435f91fb19c1e6d35'
LIB_PREFIX = 'EN-HCNetSDKV6.1.9.4_build20220412_linux64/lib/'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
MAX_EXTRACTED = 512 * 1024 * 1024


def no_symlinks(path):
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('Symlink paths are forbidden')


def extract_libraries(data, destination):
    """Extract only ordinary files in the pinned lib subtree, without ZipFile.extract."""
    seen = set()
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            name = entry.filename
            parts = name.rstrip('/').split('/')
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if '\\' in name or name.startswith('/') or any(p in ('', '.', '..') for p in parts):
                raise ValueError('Unsafe archive path')
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('Archive links and special files are forbidden')
            if not name.startswith(LIB_PREFIX):
                continue
            relative = name[len(LIB_PREFIX):].rstrip('/')
            if not relative:
                continue
            if relative in seen:
                raise ValueError('Duplicate library archive member')
            seen.add(relative)
            target = destination.joinpath(*PurePosixPath(relative).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
                continue
            total += entry.file_size
            if total > MAX_EXTRACTED:
                raise ValueError('Library subtree exceeds size limit')
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
    if not (destination / 'libhcnetsdk.so').is_file():
        raise ValueError('Required SDK library missing')


def stage(archive_path, destination, device_ids):
    archive_path, destination = Path(archive_path), Path(destination)
    if not archive_path.is_absolute() or not destination.is_absolute() or '..' in destination.parts:
        raise ValueError('Archive and destination must be explicit absolute paths')
    no_symlinks(archive_path)
    no_symlinks(destination)
    if destination.name != 'hik-sdk' or destination.exists() or not destination.parent.is_dir():
        raise ValueError('Destination must be a new hik-sdk directory in an existing release stage')
    if not device_ids or len(device_ids) > 64 or len(set(device_ids)) != len(device_ids) or any(not UUID.fullmatch(x) for x in device_ids):
        raise ValueError('Explicit unique lowercase device UUIDs are required')
    with archive_path.open('rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('Archive must be an ordinary file')
        data = source.read(ARCHIVE_SIZE + 1)
    if len(data) != ARCHIVE_SIZE or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError('SDK archive size or SHA256 mismatch')
    temporary = Path(tempfile.mkdtemp(prefix='.hik-sdk-', dir=destination.parent))
    try:
        (temporary / 'lib').mkdir(mode=0o755)
        extract_libraries(data, temporary / 'lib')
        manifest = {'profile': 'hik-sdk-v1', 'platform': 'linux-x64',
                    'archiveSha256': ARCHIVE_SHA256, 'deviceIds': device_ids}
        (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (temporary / 'manifest.json').chmod(0o644)
        temporary.chmod(0o755)
        if destination.exists() or destination.is_symlink():
            raise ValueError('Destination appeared during staging')
        temporary.rename(destination)
        return manifest
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--device-id', action='append', required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise ValueError('Run as the non-root release runner')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise ValueError('Only Linux x86_64 is approved')
    stage(args.archive, args.destination, args.device_id)
    print('Pinned SDK staged for explicit device UUIDs; no device or service contacted.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile):
        raise SystemExit('SDK staging failed: check archive pin, explicit device UUIDs and new release destination.')

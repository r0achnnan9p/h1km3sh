#!/usr/bin/env python3
"""Runner-only pinned release packaging. Does not execute tools or access accounts."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.parse
import urllib.request

MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXECUTABLE = 512 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def no_symlinks(path):
    for component in (path, *path.parents):
        if component.is_symlink():
            raise RuntimeError('Refusing symlink in managed tool destination')


def fetch_archive(url):
    if not url.startswith('https://github.com/'):
        raise RuntimeError('Unapproved release origin')
    class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            parsed = urllib.parse.urlsplit(newurl)
            if parsed.scheme != 'https' or parsed.username or parsed.password:
                raise RuntimeError('Refusing insecure release redirect')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(url, timeout=120) as response:
        data = response.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise RuntimeError('Release archive exceeds size limit')
    return data


def extract_binary(data, pin):
    if sha256(data) != pin['archiveSha256']:
        raise RuntimeError('Release SHA256 mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        matches = [item for item in archive.getmembers() if item.name == pin['member']]
        if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size <= MAX_EXECUTABLE:
            raise RuntimeError('Missing, duplicate, or unsafe executable member')
        with archive.extractfile(matches[0]) as source:
            binary = source.read(MAX_EXECUTABLE + 1)
        if len(binary) != matches[0].size:
            raise RuntimeError('Invalid executable size')
    return binary


def install(destination, pins, fetch=fetch_archive):
    destination = Path(destination)
    if not destination.is_absolute():
        raise RuntimeError('Destination must be absolute')
    no_symlinks(destination)
    if destination.exists():
        raise RuntimeError('Destination already exists; no replacement permitted')
    if not destination.parent.is_dir():
        raise RuntimeError('Release parent must already exist')
    stage = Path(tempfile.mkdtemp(prefix='.upload-tools-', dir=destination.parent))
    manifest = {'profile': pins['profile'], 'platform': pins['platform'], 'tools': {}}
    try:
        for provider, pin in pins['tools'].items():
            if pin['filename'] not in ('biliup', 'cloud189'):
                raise RuntimeError('Unapproved executable name')
            binary = extract_binary(fetch(pin['url']), pin)
            target = stage / pin['filename']
            with target.open('xb') as output:
                output.write(binary)
                output.flush()
                os.fsync(output.fileno())
            target.chmod(0o755)
            manifest['tools'][provider] = {'filename': pin['filename'], 'version': pin['version'],
                'archiveSha256': pin['archiveSha256'], 'fileSha256': sha256(binary), 'url': pin['url']}
        notices = ROOT / 'config' / 'upload-tool-notices'
        if notices.is_dir():
            shutil.copytree(notices, stage / 'notices')
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'manifest.json').chmod(0o644)
        stage.chmod(0o755)
        stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('Run as the non-root release runner')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise RuntimeError('Only Linux x86_64 tools are approved for this profile')
    pins = json.loads((ROOT / 'config' / 'upload-tools-pins.json').read_text())
    install(args.destination, pins)
    print('Packaged pinned uploader tools; no binaries executed, accounts accessed, or services started.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Managed uploader packaging failed; release was not installed. Check pinned source, hashes, and destination permissions.')

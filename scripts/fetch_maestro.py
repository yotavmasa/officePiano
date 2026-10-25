#!/usr/bin/env python3
"""Download the MAESTRO v3.0.0 MIDI files (Google Magenta, CC BY-NC-SA 4.0) once into data/catalogs/maestro.

Usage: .venv/bin/python scripts/fetch_maestro.py
"""
import hashlib
from pathlib import Path, PurePosixPath
import shutil
import sys
import urllib.request
import zipfile

URL = 'https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0-midi.zip'
SHA256 = '70470ee253295c8d2c71e6d9d4a815189e35c89624b76d22fce5a019d5dde12c'
SIZE = 58416533
ROOT = Path(__file__).resolve().parents[1]
CATALOGS = ROOT / 'data' / 'catalogs'
TARGET = CATALOGS / 'maestro'
INDEX = 'maestro-v3.0.0.csv'


def download(path):
    digest, done = hashlib.sha256(), 0
    request = urllib.request.Request(URL, headers={'User-Agent': 'PianoRemote/2.0'})
    with urllib.request.urlopen(request, timeout=60) as response, path.open('wb') as file:
        if response.geturl() != URL:
            raise SystemExit('The download was redirected unexpectedly; stopping.')
        while chunk := response.read(1 << 20):
            done += len(chunk)
            if done > SIZE:
                raise SystemExit('The download is larger than expected; stopping.')
            digest.update(chunk)
            file.write(chunk)
            print(f'\rDownloading MAESTRO… {done * 100 // SIZE}%', end='', flush=True)
    print()
    if done != SIZE or digest.hexdigest() != SHA256:
        raise SystemExit('The download did not match the published checksum; nothing was installed.')


def extract(archive, destination):
    count = 0
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            parts = PurePosixPath(member.filename).parts
            if member.is_dir() or len(parts) < 2 or parts[0] != 'maestro-v3.0.0':
                continue
            relative = PurePosixPath(*parts[1:])
            if relative.is_absolute() or '..' in relative.parts or not (relative.suffix.lower() in ('.mid', '.midi') or relative.name == INDEX):
                continue
            output = destination.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, output.open('wb') as file:
                shutil.copyfileobj(source, file)
            count += 1
    if not (destination / INDEX).is_file():
        raise SystemExit('The archive had no MAESTRO index; nothing was installed.')
    return count


def main():
    if (TARGET / INDEX).is_file():
        print(f'MAESTRO is already installed in {TARGET}.')
        return
    CATALOGS.mkdir(parents=True, exist_ok=True)
    archive, staging = CATALOGS / 'maestro-v3.0.0-midi.zip.part', CATALOGS / 'maestro.part'
    try:
        download(archive)
        shutil.rmtree(staging, ignore_errors=True)
        count = extract(archive, staging)
        staging.rename(TARGET)
        print(f'Installed {count} MAESTRO files in {TARGET}.')
        print('MAESTRO by Google Magenta is licensed CC BY-NC-SA 4.0: https://magenta.withgoogle.com/datasets/maestro')
    finally:
        archive.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Install the optional official OMR runtime inside this checkout (Apple Silicon Mac)."""
import hashlib
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DMG_URL = 'https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-macosx-arm64.dmg'
DMG_SHA256 = '17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6'
OCR_SHA256 = 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047'
OCR_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/eng.traineddata'

def download(url, destination, expected):
    with urllib.request.urlopen(url, timeout=60) as response, destination.open('wb') as output:
        shutil.copyfileobj(response, output)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        raise RuntimeError('The download checksum changed. Verify the official source before updating the expected checksum.')

def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('This optional installer targets Apple Silicon macOS. See tools/SOURCES.txt for other Audiveris platforms.')
    tools = ROOT / 'tools'
    tools.mkdir(exist_ok=True)
    build = ROOT / '.build'
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=build) as directory:
        temporary = Path(directory)
        if not (tools / 'Audiveris.app').exists():
            print('Downloading official Audiveris with its Java runtime…')
            dmg = temporary / 'audiveris.dmg'
            download(DMG_URL, dmg, DMG_SHA256)
            mount = temporary / 'mount'
            result = subprocess.run(['hdiutil', 'attach', str(dmg), '-nobrowse', '-readonly', '-mountpoint', str(mount), '-plist'], capture_output=True, check=True)
            plistlib.loads(result.stdout)
            try:
                shutil.copytree(mount / 'Audiveris.app', tools / 'Audiveris.app', symlinks=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
        model = tools / 'tessdata' / 'eng.traineddata'
        if not model.exists():
            print('Downloading the official English OCR model…')
            model.parent.mkdir(exist_ok=True)
            saved = temporary / 'eng.traineddata'
            download(OCR_URL, saved, OCR_SHA256)
            saved.replace(model)
    print('Local sheet recognition tools are ready.')

if __name__ == '__main__':
    main()

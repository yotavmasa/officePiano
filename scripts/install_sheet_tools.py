#!/usr/bin/env python3
"""Install local Audiveris/OCR tools on Apple Silicon or 64-bit Raspberry Pi OS."""
import hashlib
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DMG_URL = 'https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-macosx-arm64.dmg'
DMG_SHA256 = '17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6'
OCR_SHA256 = 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047'
OCR_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/c2b2e0df86272ce11be323f23f96cf656565ed41/eng.traineddata'
SOURCE_COMMIT = '9e1e55cd2746037d059345881c53e6a6754bffbd'
JDK_URL = 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_aarch64_linux_hotspot_25.0.4.1_1.tar.gz'
JDK_SHA256 = '69df11a02cfa3ef7d7ca645e03edce6778ec090e100f6ae2b42097865730ac52'

def download(url, destination, expected):
    with urllib.request.urlopen(url, timeout=60) as response, destination.open('wb') as output:
        shutil.copyfileobj(response, output)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        raise RuntimeError('The download checksum changed. Verify the official source before updating the expected checksum.')

def install_linux(tools, build, temporary):
    # The official 5.11.0 release has no Linux ARM64 package; build its pinned sources.
    java = tools / 'java25'
    if not (java / 'bin/java').is_file():
        print('Downloading official Temurin 25 ARM64 JDK…')
        archive = temporary / 'java.tar.gz'
        download(JDK_URL, archive, JDK_SHA256)
        unpacked = temporary / 'java'
        unpacked.mkdir()
        with tarfile.open(archive) as saved:
            saved.extractall(unpacked, filter='data')
        roots = list(unpacked.iterdir())
        if len(roots) != 1 or not (roots[0] / 'bin/java').is_file():
            raise RuntimeError('The official Java archive has an unexpected layout.')
        roots[0].replace(java)
    destination = tools / 'audiveris'
    if (destination / 'lib/audiveris.jar').is_file():
        return
    source = build / 'audiveris-5.11.0'
    if not source.exists():
        subprocess.run(['git', 'clone', '--depth', '1', '--branch', '5.11.0', 'https://github.com/Audiveris/audiveris.git', str(source)], check=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != SOURCE_COMMIT:
        raise RuntimeError('Audiveris source does not match the pinned 5.11.0 commit.')
    environment = dict(os.environ, JAVA_HOME=str(java), GRADLE_USER_HOME=str(build / 'gradle'))
    environment['PATH'] = str(java / 'bin') + os.pathsep + environment.get('PATH', '')
    print('Building Audiveris for Linux ARM64. The first build downloads its dependencies…')
    subprocess.run(['sh', './gradlew', '--no-daemon', '--max-workers=2', '-Dorg.gradle.jvmargs=-Xmx1536m', '-PtargetOS=linux-arm64', ':app:installDist'], cwd=source, env=environment, check=True)
    distributions = [folder for folder in (source / 'app/build/install').iterdir() if (folder / 'lib/audiveris.jar').is_file()]
    if len(distributions) != 1:
        raise RuntimeError('Audiveris build did not produce its runnable distribution.')
    staged = temporary / 'audiveris'
    shutil.copytree(distributions[0], staged, symlinks=True)
    license_file = source / 'LICENSE'
    if license_file.is_file():
        shutil.copy2(license_file, staged / 'LICENSE')
    if destination.exists():
        shutil.rmtree(destination)
    staged.replace(destination)


def main():
    system, machine = platform.system(), platform.machine()
    if (system, machine) not in [('Darwin', 'arm64'), ('Linux', 'aarch64'), ('Linux', 'arm64')]:
        raise SystemExit('Use an Apple Silicon Mac or 64-bit Debian/Raspberry Pi OS (ARM64).')
    tools = ROOT / 'tools'
    tools.mkdir(exist_ok=True)
    build = ROOT / '.build'
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=build) as directory:
        temporary = Path(directory)
        if system == 'Linux':
            install_linux(tools, build, temporary)
        elif not (tools / 'Audiveris.app').exists():
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

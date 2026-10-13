#!/bin/sh
# Local runtimes; only Debian hardware prerequisites use the system package manager.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
WITH_SHEETS=0
DRY_RUN=0
TARGET=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-sheets) WITH_SHEETS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --platform) shift; TARGET=${1:?Missing platform} ;;
    --help|-h) echo 'Usage: scripts/install.sh [--with-sheets] [--dry-run [--platform macos-arm64|linux-arm64]]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "$TARGET" ] && [ "$DRY_RUN" != 1 ]; then
  echo '--platform is only allowed with --dry-run.' >&2; exit 1
fi
if [ -z "$TARGET" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) TARGET=macos-arm64 ;;
    Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
    *) echo 'Use an Apple Silicon Mac or 64-bit Debian/Raspberry Pi OS (ARM64).' >&2; exit 1 ;;
  esac
fi
case "$TARGET" in
  macos-arm64)
    UV_ARCH=aarch64-apple-darwin
    UV_SHA=a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6
    NODE_FILE=node-v22.23.3-darwin-arm64.tar.gz
    NODE_SHA=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
  linux-arm64)
    UV_ARCH=aarch64-unknown-linux-gnu
    UV_SHA=3ccfb6af6e242433eb552f7d9676abd5412c6595c497e990d9c8cb7b5bd4d2c3
    NODE_FILE=node-v22.23.3-linux-arm64.tar.xz
    NODE_SHA=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;;
  *) echo "Unsupported platform: $TARGET" >&2; exit 1 ;;
esac
if [ "$DRY_RUN" = 1 ]; then
  echo "Platform: $TARGET"
  if [ "$TARGET" = linux-arm64 ]; then
    echo 'apt: Python venv, compiler, ALSA/JACK development libraries, BlueZ, curl, certificates, git, xz'
    [ "$WITH_SHEETS" != 1 ] || echo 'apt: headless Java native prerequisites (X11/fontconfig/libgomp)'
  else
    echo 'Check Xcode Command Line Tools; compile native/midi.swift with Swift'
  fi
  echo 'Install checksum-verified local uv 0.13.0 and Node.js 22.23.3'
  echo 'Install managed Python 3.11; create .venv; install requirements.txt'
  echo 'Run npm ci and production UI build'
  [ "$WITH_SHEETS" != 1 ] || echo 'Install optional Audiveris 5.11.0 and OCR model (Linux ARM64 builds pinned source with local JDK 25)'
  echo 'Launch: .venv/bin/python server.py'
  exit 0
fi
if [ "$TARGET" = linux-arm64 ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo 'This Linux installer requires Debian/Raspberry Pi OS and apt-get.' >&2; exit 1
  fi
  SUDO=''
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo 'sudo is required to install Linux hardware prerequisites.' >&2; exit 1; }
    SUDO=sudo
  fi
  $SUDO apt-get update
  $SUDO apt-get install -y python3 python3-venv build-essential pkg-config libasound2-dev libjack-jackd2-dev bluez curl ca-certificates git xz-utils
  if [ "$WITH_SHEETS" = 1 ]; then
    $SUDO apt-get install -y libx11-6 libxext6 libxrender1 libxtst6 libxi6 libfreetype6 fontconfig libgomp1
  fi
else
  if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
    echo 'Install Xcode Command Line Tools with xcode-select --install, then run this installer again.' >&2; exit 1
  fi
fi
mkdir -p tools .build
TEMP=$(mktemp -d "$ROOT/.build/install.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
verify() {
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$1" | cut -d ' ' -f 1)
  else
    ACTUAL=$(shasum -a 256 "$1" | cut -d ' ' -f 1)
  fi
  [ "$ACTUAL" = "$2" ] || { echo "Checksum mismatch: $1" >&2; exit 1; }
}
if [ ! -x tools/uv/uv ]; then
  curl --fail --location --retry 3 "https://github.com/astral-sh/uv/releases/download/0.13.0/uv-$UV_ARCH.tar.gz" -o "$TEMP/uv.tar.gz"
  verify "$TEMP/uv.tar.gz" "$UV_SHA"
  tar -xzf "$TEMP/uv.tar.gz" -C "$TEMP"
  mkdir -p tools/uv
  cp "$TEMP/uv-$UV_ARCH/uv" tools/uv/uv
fi
if [ ! -x tools/node/bin/node ] || [ "$(tools/node/bin/node --version)" != v22.23.3 ]; then
  curl --fail --location --retry 3 "https://nodejs.org/dist/v22.23.3/$NODE_FILE" -o "$TEMP/$NODE_FILE"
  verify "$TEMP/$NODE_FILE" "$NODE_SHA"
  mkdir "$TEMP/node"
  tar -xf "$TEMP/$NODE_FILE" -C "$TEMP/node" --strip-components=1
  rm -rf tools/node
  mv "$TEMP/node" tools/node
fi
export UV_PYTHON_INSTALL_DIR="$ROOT/tools/python"
export UV_CACHE_DIR="$ROOT/.build/uv-cache"
export PATH="$ROOT/tools/node/bin:$PATH"
# Pin the interpreter family so Debian Python upgrades do not invalidate local wheels.
tools/uv/uv python install 3.11
if [ ! -x .venv/bin/python ]; then
  tools/uv/uv venv --python 3.11 --seed .venv
fi
tools/uv/uv pip install --python .venv/bin/python -r requirements.txt
npm ci --prefix web
npm run build --prefix web
if [ "$TARGET" = macos-arm64 ]; then
  sh scripts/build_native.sh
else
  echo 'Linux uses the ALSA/Bluetooth MIDI bridge; no Swift executable is installed.'
fi
if [ "$WITH_SHEETS" = 1 ]; then
  .venv/bin/python scripts/install_sheet_tools.py
fi
printf '\nReady. Start Office Piano with:\n  .venv/bin/python server.py\n'

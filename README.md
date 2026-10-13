# Office Piano

A local piano library and Wi-Fi remote for PianoDisc Prodigy II. React/Vite provides the interface; FastAPI controls a Mac native MIDI bridge or a Linux ALSA/Bluetooth bridge. Music and sheet originals stay on the piano computer.

## Install

From the checkout, run:

```sh
./scripts/install.sh --with-sheets
.venv/bin/python server.py
```

Omit `--with-sheets` if you only need MIDI files and discovery. The installer supports Apple Silicon macOS and 64-bit Debian/Raspberry Pi OS on ARM64. It downloads checksum-verified local uv/Node runtimes, installs managed Python 3.11 in `tools/`, creates `.venv`, installs Python packages, and builds the frontend. Mac builds the Swift bridge; Linux installs ALSA/BlueZ prerequisites with `sudo` and uses the Python MIDI bridge. On Mac, Apple's command-line developer tools must already be installed (`xcode-select --install`).

Optional sheet recognition installs official Audiveris and English OCR. Mac uses its bundled Java runtime; Linux ARM64 builds pinned Audiveris sources with a local Java 25 runtime. The first Linux build needs network access, disk space, time, and several GB of RAM. A Pi 4/5 with at least 4 GB RAM is the intended test target. The Linux recipe and protocol tests are checked; actual Raspberry Pi installation and piano hardware remain unverified.

Preview the Linux install plan without changing your machine:

```sh
./scripts/install.sh --dry-run --platform linux-arm64 --with-sheets
```

The app opens locally and prints a private Wi-Fi link. Use the complete link, including its `#` key, on other devices. Keep the piano computer awake. On Mac, connect Prodigy2 MIDI in Audio MIDI Setup → MIDI Studio → Bluetooth, or use USB. On Linux, choose an ALSA/USB output or the discovered Bluetooth piano, then connect it through the app; a Bluetooth advertisement is not treated as ready until its MIDI connection succeeds. Keep the piano disconnected from competing apps. A headless Pi user needs normal BlueZ/ALSA access; check OS Bluetooth permissions if connection fails.

`Start Piano Remote.command` remains the Mac launcher and prefers `.venv`. Local `vendor/` dependencies support the existing desktop bundle; a virtual environment takes precedence so copied Mac binaries never override Linux packages. Never copy `.venv`, `vendor/`, or installed runtimes across operating systems: rerun the installer on the destination.

### Manual setup

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --prefix web
npm run build --prefix web
# Mac only
scripts/build_native.sh
# Optional OMR (see installer for Linux system prerequisites)
.venv/bin/python scripts/install_sheet_tools.py
.venv/bin/python server.py
```

Manual setup supports Python 3.9–3.13 and Node 22.12+. Linux also needs the ALSA/BlueZ/compiler prerequisites installed by `install.sh`.

## Use

- **Player**: queue, volume, tempo-aware timeline seeking, and playback sound settings. Songs leave the queue when they finish; saved originals remain in the library.
- **All songs**: upload multiple MIDI files, search, edit names/artists/albums, favorites, and saved collections.
- **Sheet music**: upload PDFs/images/MusicXML. Name each piece and select its pages to split a book into songs. Originals remain downloadable. Recognition can miss notes or repeats; review the result. A lead sheet provides written notes, not a complete piano recording.
- **Discover**: search BitMidi, FreeMidi, or both. Piano-only files are marked; mixed MIDI is also playable.
- Drag the grip to reorder queue/library songs with dnd-kit. For keyboard sorting, press Space on a grip, move with the arrow keys, then press Space to drop or Escape to cancel. Library order is saved separately for each collection.
- Original/Piano-only/Smart/manual part choices are saved with each song. Smart is an experimental deterministic reduction. MIDI dynamics, musical interpretation, and physical volume need listening checks on the piano.
- Album artwork is matched conservatively, with piano art as fallback; Spotify opens a search for the matched or edited artist/album.

## Code

```text
backend/    FastAPI, library, queue, discovery, adaptation, artwork, sheet conversion
native/     Swift Mac bridge and Python ALSA/BLE Linux bridge
web/        React/Vite UI and assets
scripts/    Native build and optional OMR tool installer
tests/      Isolated API and music/state checks
server.py   Local launcher
```

`data/` contains the database, original files, sheet jobs, trash, and private access key. It is excluded from Git. Back it up separately if needed. Installed `vendor/`, Audiveris/OCR tools, and generated `ui-dist/`/native executable are excluded too. Optional tool sources/licenses are documented in `tools/SOURCES.txt`.

## Development checks

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests
npm run build --prefix web
# Mac only: native compile and optional integration check
scripts/build_native.sh
# Creates only a virtual MIDI destination: creates only a virtual MIDI destination
.venv/bin/python scripts/check_native.py
```

Tests use fake or isolated devices and temporary libraries. They do not verify audible performance on the physical piano. During development, `npm run dev --prefix web` proxies APIs to the local server; open the development URL with the same `#` key from the printed remote link.

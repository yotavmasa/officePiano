# Office Piano

A local piano library and office Wi-Fi remote for a Mac connected to a PianoDisc Prodigy II. React/Vite provides the interface; FastAPI controls a native macOS MIDI bridge. Music and sheet originals stay on the Mac.

## Setup on an Apple Silicon Mac

Use Python 3.9 or newer, Node 22.12+ and Apple's command-line developer tools (`xcode-select --install`).

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --prefix web
npm run build --prefix web
scripts/build_native.sh
# Optional PDF/photo sheet recognition (downloads official Audiveris + English OCR)
.venv/bin/python scripts/install_sheet_tools.py
.venv/bin/python server.py
```

The app opens locally and prints a private Wi-Fi link. Use that complete link, including its `#` key, on other devices. Keep the Mac awake and connected to the piano. Connect Prodigy2 MIDI in Audio MIDI Setup → MIDI Studio → Bluetooth, or use USB. `Start Piano Remote.command` starts the local copy; it prefers `.venv` when available.

The existing desktop bundle can also use installed dependencies in `vendor/`. That directory is local and ignored by Git; a fresh checkout uses the environment installed above. Other platforms cannot drive this macOS native bridge. The optional sheet installer is specifically for Apple Silicon macOS.

## Use

- **Player**: queue, volume, tempo-aware timeline seeking, and playback sound settings. Songs leave the queue when they finish; saved originals remain in the library.
- **All songs**: upload multiple MIDI files, search, edit names/artists/albums, favorites, and saved collections.
- **Sheet music**: upload PDFs/images/MusicXML. Name each piece and select its pages to split a book into songs. Originals remain downloadable. Recognition can miss notes or repeats; review the result. A lead sheet provides written notes, not a complete piano recording.
- **Discover**: search BitMidi, FreeMidi, or both. Piano-only files are marked; mixed MIDI is also playable.
- Drag the grip to reorder queue/library songs; arrow keys on a grip also work. Library order is saved separately for each collection.
- Original/Piano-only/Smart/manual part choices are saved with each song. Smart is an experimental deterministic reduction. MIDI dynamics, musical interpretation, and physical volume need listening checks on the piano.
- Album artwork is matched conservatively, with piano art as fallback; Spotify opens a search for the matched or edited artist/album.

## Code

```text
backend/    FastAPI, library, queue, discovery, adaptation, artwork, sheet conversion
native/     Swift MIDI bridge
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
scripts/build_native.sh
# Optional macOS integration check: creates only a virtual MIDI destination
.venv/bin/python scripts/check_native.py
```

Tests use fake or isolated devices and temporary libraries. They do not verify audible performance on the physical piano. During development, `npm run dev --prefix web` proxies APIs to the local server; open the development URL with the same `#` key from the printed remote link.

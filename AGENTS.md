# Office Piano

Applies to this entire repository. Prefer the smallest complete fix; preserve working behavior and avoid speculative layers.

## Map and commands
- `web/`: React/Vite UI. `backend/`: FastAPI API, SQLite library, queue, discovery, MIDI adaptation, sheet jobs, artwork.
- `native/midi.swift`: macOS CoreMIDI/AudioToolbox/Bluetooth bridge; `native/midi` is a generated executable.
- `server.py`: launcher. `scripts/`: reproducible build/tool setup. `tests/`: isolated Python tests.
- `data/`: private local state, original MIDI/PDF/images, jobs, SQLite, and LAN access key. Never commit or print its key.
- Setup/run/build commands are in README.md. Run `python3 -m unittest discover -s tests` from repository root; use the configured environment for dependencies.
- After UI edits, run `npm run build --prefix web` and inspect desktop/mobile behavior. After native edits, run `scripts/build_native.sh` and use a virtual MIDI destination for tests.

## Behavior to preserve
- Player is the first page/navigation item; startup waits for a song and never autoplays.
- Uploads save originals without starting music, replacing the current song, or adding queue entries.
- Finished songs leave the queue and the next plays. Pause/Stop/disconnect retain queued songs. Reordering preserves the current item, including duplicate IDs.
- Queue and library order persist; filtered dragging preserves hidden songs. Collection order is independent of global order.
- Mixed-instrument MIDI is allowed and marked. Preserve originals; adaptation produces a temporary playback copy.
- Original/Piano/Smart/custom parts are saved per song. Smart is experimental; never claim equivalence to a professional arrangement.
- Volume uses CC7/CC39; do not silently reintroduce velocity scaling. Bluetooth reconnect never autoplays. Panic releases pedals/keys before stop and seek.
- Seeking uses tempo-aware seconds and preserves playing/paused state. Validate song identity to reject stale requests.
- Sheet music has a separate tab. Keep source files; named PDF page ranges become separate songs. Lead sheets do not contain full recorded arrangements. Surface recognition/repeat warnings.
- Artist/album are editable. Infer only from clear metadata/filenames or conservative cover matches; manual edits win over automatic lookup.
- Mobile navigation floats at the bottom with accessible icon labels; drag handles must support touch and keyboard.

## Boundaries and verification
- LAN APIs require the bearer key. Only actual loopback peers with loopback Host receive bootstrap; do not trust forwarded headers.
- Bound uploads (MIDI 8 MB, sheets 20 MB), validate MIDI/XML/page ranges, and keep downloads scoped to known records.
- Discovery/artwork/network/OMR must not block the MIDI lock or FastAPI event loop. Recognition runs sequentially in a background worker.
- Do not send messages, publish data, or push unrelated/private files. `data/`, vendor/runtime installs, and build products stay ignored.
- Test meaningful state transitions and failures; never trigger the physical piano as an incidental automated check.
- Before restarting the user's server, explain that playback may stop; inspect running conversion jobs and preserve their work.
- Report exactly what was tested. Acoustic sound quality requires the user's listening test.

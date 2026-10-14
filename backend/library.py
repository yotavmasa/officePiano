"""Piano-only MIDI validation and a durable, local music library."""
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import struct
import threading
import tempfile
import unicodedata
import time
import uuid

MAX_MIDI = 8 * 1024 * 1024


def filename_artist(name):
    value = re.sub(r'(?i)\.midi?$', '', str(name)).replace('_', ' ')
    pieces = re.split(r'\s+[-–—]\s+', value, maxsplit=1)
    return pieces[0].strip()[:200] if len(pieces) == 2 and all(piece.strip() for piece in pieces) else ''


def parse_midi(data, piano_only=True):
    """Check Standard MIDI and return piano notes, range, and tempo-aware duration.

    MIDI describes instruments, not audio: unlabelled channels default to GM piano.
    """
    if not isinstance(data, bytes) or not 14 <= len(data) <= MAX_MIDI:
        raise ValueError('Choose a standard MIDI file smaller than 8 MB.')
    if data[:4] != b'MThd':
        raise ValueError('Choose a standard .mid or .midi file.')
    header_size = int.from_bytes(data[4:8], 'big')
    if header_size < 6 or 8 + header_size > len(data):
        raise ValueError('The MIDI header is incomplete.')
    fmt, tracks, division = struct.unpack('>HHH', data[8:14])
    if fmt not in (0, 1) or not 1 <= tracks <= 256 or (fmt == 0 and tracks != 1):
        raise ValueError('Use a standard format 0 or 1 MIDI file.')
    if not division or division & 0x8000:
        raise ValueError('This MIDI timing format is not supported.')
    offset = 8 + header_size
    events = []
    tags = {}
    reasons = []

    def incompatible(message):
        if piano_only:
            raise ValueError(message)
        if message not in reasons:
            reasons.append(message)

    end_tick = 0
    event_count = 0
    for track_index in range(tracks):
        if offset + 8 > len(data) or data[offset:offset + 4] != b'MTrk':
            raise ValueError('The MIDI track is missing or incomplete.')
        length = int.from_bytes(data[offset + 4:offset + 8], 'big')
        offset += 8
        end = offset + length
        if end > len(data):
            raise ValueError('The MIDI track is incomplete.')
        pos, tick, running, finished = offset, 0, None, False
        def vlq():
            nonlocal pos
            value = 0
            for _ in range(4):
                if pos >= end:
                    raise ValueError('The MIDI event is incomplete.')
                byte = data[pos]; pos += 1
                value = (value << 7) | (byte & 127)
                if not byte & 128:
                    return value
            raise ValueError('The MIDI event has an invalid length.')
        while pos < end:
            event_count += 1
            if event_count > 500000:
                raise ValueError('This MIDI file contains too many events.')
            tick += vlq()
            if pos >= end:
                raise ValueError('The MIDI event is incomplete.')
            status = data[pos]
            if status & 128:
                pos += 1
                if status < 0xf0:
                    running = status
                else:
                    running = None
            elif running is not None:
                status = running
            else:
                raise ValueError('The MIDI file has invalid running status.')
            if status in (0xf0, 0xf7):
                size = vlq()
                if pos + size > end:
                    raise ValueError('The MIDI device command is incomplete.')
                pos += size
                incompatible('This file contains device commands (SysEx). Choose a plain piano MIDI file.')
                continue
            if status == 0xff:
                if pos >= end:
                    raise ValueError('The MIDI metadata is incomplete.')
                kind = data[pos]; pos += 1
                size = vlq()
                if pos + size > end:
                    raise ValueError('The MIDI metadata is incomplete.')
                payload = data[pos:pos + size]; pos += size
                if kind in (1, 2, 3) and size <= 2048:
                    text = payload.decode('utf-8', errors='replace')
                    for key in ('artist', 'album'):
                        match = re.search(r'(?im)^\s*' + key + r'\s*[:=]\s*([^\r\n]{1,200})', text)
                        if match:
                            tags.setdefault(key + '_hint', match[1].strip())
                if kind == 0x51:
                    if size != 3 or not int.from_bytes(payload, 'big'):
                        raise ValueError('The MIDI tempo is invalid.')
                    events.append((tick, 0, track_index, event_count, 'tempo', int.from_bytes(payload, 'big')))
                if kind == 0x2f:
                    if size != 0 or pos != end:
                        raise ValueError('The MIDI end-of-track marker is invalid.')
                    finished = True
                    break
            elif 0x80 <= status <= 0xef:
                command, channel = status & 0xf0, status & 15
                size = 1 if command in (0xc0, 0xd0) else 2
                if pos + size > end or any(byte & 128 for byte in data[pos:pos + size]):
                    raise ValueError('The MIDI channel event is invalid.')
                values = data[pos:pos + size]; pos += size
                if command == 0xc0:
                    events.append((tick, 1, track_index, event_count, 'program', (channel, values[0])))
                elif command == 0x90 and values[1]:
                    events.append((tick, 2, track_index, event_count, 'note', (channel, values[0])))
            else:
                raise ValueError('The MIDI file contains unsupported system messages.')
        if not finished:
            raise ValueError('The MIDI track has no end marker.')
        end_tick = max(end_tick, tick)
        offset = end
    if offset != len(data):
        raise ValueError('The MIDI file contains unexpected trailing data.')
    nonpiano_ticks = {(event[0], event[5][0]) for event in events
                      if event[4] == 'program' and event[5][1] not in (0, 1)}
    programs = [0] * 16
    explicit = [False] * 16
    notes = []
    unlabelled = False
    tempo, last_tick, duration = 500000, 0, 0.0
    # Across tracks, a program set at the same tick applies before a sounded note.
    for tick, _, _, _, kind, value in sorted(events):
        duration += (tick - last_tick) * tempo / division / 1000000
        last_tick = tick
        if kind == 'tempo':
            tempo = value
        elif kind == 'program':
            channel, program = value
            programs[channel], explicit[channel] = program, True
        else:
            channel, note = value
            if channel == 9:
                incompatible('This song includes drums. Choose a piano-only MIDI file.')
            if programs[channel] not in (0, 1) or (tick, channel) in nonpiano_ticks:
                incompatible('This song includes other instruments. Choose a piano-only MIDI file.')
            if not 21 <= note <= 108:
                incompatible('This song has notes outside the 88-key piano range.')
            unlabelled |= not explicit[channel]
            notes.append(note)
    duration += (end_tick - last_tick) * tempo / division / 1000000
    if not notes:
        raise ValueError('This MIDI file contains no playable piano notes.')
    return {**tags, 'notes': len(notes), 'duration': round(duration, 2), 'key_min': min(notes),
            'key_max': max(notes), 'piano_only': not reasons, 'compatibility_reason': ' '.join(reasons),
            'verification': ('Contains other instruments or device commands' if reasons else
                             'GM piano assumed for unlabelled channels' if unlabelled else 'GM piano programs verified')}


class Library:
    def __init__(self, root):
        folder = Path(root) / 'data'
        folder.mkdir(parents=True, exist_ok=True)
        self.saved_folder = folder / 'songs'
        self.saved_folder.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(folder / 'library.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS songs (
                id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                source_url TEXT NOT NULL, midi BLOB NOT NULL, metadata TEXT NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS memberships (
                song_id TEXT REFERENCES songs(id) ON DELETE CASCADE,
                library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
                PRIMARY KEY(song_id,library_id));
            CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        if 'deleted' not in [column[1] for column in self.db.execute('PRAGMA table_info(songs)')]:
            self.db.execute('ALTER TABLE songs ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
        if 'source_kind' not in [column[1] for column in self.db.execute('PRAGMA table_info(songs)')]:
            self.db.execute("ALTER TABLE songs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'midi'")
        song_columns = [column[1] for column in self.db.execute('PRAGMA table_info(songs)')]
        if 'artist' not in song_columns:
            self.db.execute("ALTER TABLE songs ADD COLUMN artist TEXT NOT NULL DEFAULT ''")
            for row in self.db.execute('SELECT id,name FROM songs').fetchall():
                self.db.execute('UPDATE songs SET artist=? WHERE id=?', (filename_artist(row['name']), row['id']))
        if 'album' not in song_columns:
            self.db.execute("ALTER TABLE songs ADD COLUMN album TEXT NOT NULL DEFAULT ''")
        if 'metadata_edited' not in song_columns:
            self.db.execute('ALTER TABLE songs ADD COLUMN metadata_edited INTEGER NOT NULL DEFAULT 0')
        if 'order_position' not in [column[1] for column in self.db.execute('PRAGMA table_info(songs)')]:
            self.db.execute('ALTER TABLE songs ADD COLUMN order_position INTEGER NOT NULL DEFAULT 0')
        if 'order_position' not in [column[1] for column in self.db.execute('PRAGMA table_info(memberships)')]:
            self.db.execute('ALTER TABLE memberships ADD COLUMN order_position INTEGER NOT NULL DEFAULT 0')
        self.db.commit()
        for row in self.db.execute('SELECT id,name,midi FROM songs WHERE deleted=0'):
            self._export(row)

    @staticmethod
    def _name(name):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
            raise ValueError('Enter a name between 1 and 200 characters.')
        return name.strip()

    @staticmethod
    def _file_name(row):
        name = re.sub(r'(?i)\.midi?$', '', row['name'])
        name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
        name = re.sub(r'[^A-Za-z0-9 _-]+', ' ', name)
        name = re.sub(r'\s+', ' ', name).strip(' _-')[:90].strip() or 'Piano song'
        return f"{name} - {row['id'][:16]}.mid"

    def _export(self, row):
        destination = self.saved_folder / self._file_name(row)
        if destination.exists():
            return
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.saved_folder, prefix='.saving-', delete=False) as file:
                temporary = Path(file.name)
                file.write(row['midi'])
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, destination)
        except OSError as exc:
            raise ValueError('Could not save the MIDI file. Check the music folder is writable and has free space.') from exc
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()

    def _song(self, row):
        result = dict(row)
        result.pop('midi', None); result.pop('digest', None); result.pop('deleted', None)
        result.update(json.loads(result.pop('metadata')))
        result['favorite'] = bool(result['favorite'])
        result.setdefault('piano_only', True)
        result.setdefault('compatibility_reason', '')
        result['duration_seconds'] = result['duration']
        result['file_name'] = self._file_name(row)
        result['library_ids'] = [r[0] for r in self.db.execute('SELECT library_id FROM memberships WHERE song_id=?', (result['id'],))]
        return result

    def snapshot(self):
        with self.lock:
            songs = [self._song(row) for row in self.db.execute('SELECT id,name,source_url,metadata,favorite,created,source_kind,artist,album,metadata_edited FROM songs WHERE deleted=0 ORDER BY order_position,created DESC')]
            libraries = [dict(row) for row in self.db.execute('SELECT * FROM libraries ORDER BY created')]
            for item in libraries:
                item['song_ids'] = [row[0] for row in self.db.execute('SELECT m.song_id FROM memberships m JOIN songs s ON s.id=m.song_id WHERE m.library_id=? AND s.deleted=0 ORDER BY m.order_position,s.order_position,s.created DESC', (item['id'],))]
            return {'songs': songs, 'libraries': libraries}

    def add(self, data, name, source_url='', source_kind='midi'):
        if source_kind not in ('midi', 'sheet'):
            raise ValueError('Invalid song origin.')
        metadata = parse_midi(data, piano_only=False)
        name = self._name(name)
        if not isinstance(source_url, str) or len(source_url) > 2048:
            raise ValueError('The song source is invalid.')
        digest = hashlib.sha256(data).hexdigest()
        with self.lock, self.db:
            row = self.db.execute('SELECT * FROM songs WHERE digest=?', (digest,)).fetchone()
            if row:
                if row['deleted']:
                    self._restore(row)
                if source_kind == 'sheet' and row['source_kind'] != 'sheet':
                    self.db.execute("UPDATE songs SET source_kind='sheet' WHERE id=?", (row['id'],))
                    row = self.db.execute('SELECT * FROM songs WHERE id=?', (row['id'],)).fetchone()
                self._export(row)
                return self._song(row)
            song_id = uuid.uuid4().hex
            self.db.execute('INSERT INTO songs(id,digest,name,source_url,midi,metadata,created,source_kind,order_position,artist,album) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                            (song_id, digest, name, source_url, data, json.dumps(metadata), time.time(), source_kind, self.db.execute('SELECT COALESCE(MIN(order_position),0)-1 FROM songs').fetchone()[0], metadata.get('artist_hint', '') or filename_artist(name), metadata.get('album_hint', '')))
            row = self.db.execute('SELECT * FROM songs WHERE id=?', (song_id,)).fetchone()
            self._export(row)
            return self._song(row)

    def select(self, song_id):
        if not isinstance(song_id, str):
            raise ValueError('Choose a saved song.')
        with self.lock:
            row = self.db.execute('SELECT * FROM songs WHERE id=? AND deleted=0', (song_id,)).fetchone()
            if not row:
                raise ValueError('This song is no longer in your library.')
            return bytes(row['midi']), self._song(row)

    def playable(self, song_id):
        data, song = self.select(song_id)
        parse_midi(data, piano_only=False)
        return data, song

    def _restore(self, row):
        source = self.saved_folder.parent / 'trash' / self._file_name(row)
        target = self.saved_folder / self._file_name(row)
        if source.exists() and not target.exists():
            os.replace(source, target)
        self._export(row)
        self.db.execute('UPDATE songs SET deleted=0 WHERE id=?', (row['id'],))

    def mutate(self, request):
        if not isinstance(request, dict):
            raise ValueError('Invalid library command.')
        action = request.get('action')
        with self.lock, self.db:
            if action == 'create':
                name = self._name(request.get('name'))
                try:
                    self.db.execute('INSERT INTO libraries VALUES(?,?,?)', (uuid.uuid4().hex, name, time.time()))
                except sqlite3.IntegrityError:
                    raise ValueError('A library with that name already exists.') from None
            elif action == 'reorder':
                identity = request.get('library_id', '')
                ordered = request.get('song_ids')
                if not isinstance(identity, str) or not isinstance(ordered, list) or len(ordered) > 10000 or any(not isinstance(song, str) for song in ordered):
                    raise ValueError('Choose a valid song order.')
                if identity:
                    if not self.db.execute('SELECT 1 FROM libraries WHERE id=?', (identity,)).fetchone():
                        raise ValueError('Choose an existing library.')
                    existing = [row[0] for row in self.db.execute('SELECT m.song_id FROM memberships m JOIN songs s ON s.id=m.song_id WHERE m.library_id=? AND s.deleted=0', (identity,))]
                else:
                    existing = [row[0] for row in self.db.execute('SELECT id FROM songs WHERE deleted=0')]
                if len(ordered) != len(existing) or set(ordered) != set(existing):
                    raise ValueError('The song list changed. Refresh and try reordering again.')
                for position, song in enumerate(ordered):
                    if identity:
                        self.db.execute('UPDATE memberships SET order_position=? WHERE library_id=? AND song_id=?', (position, identity, song))
                    else:
                        self.db.execute('UPDATE songs SET order_position=? WHERE id=?', (position, song))
            elif action in ('rename_song', 'edit_song'):
                identity = request.get('song_id')
                name = self._name(request.get('name'))
                if not isinstance(identity, str):
                    raise ValueError('Choose a saved song.')
                row = self.db.execute('SELECT * FROM songs WHERE id=? AND deleted=0', (identity,)).fetchone()
                if not row:
                    raise ValueError('Choose a saved song.')
                if action == 'edit_song':
                    artist, album = request.get('artist', ''), request.get('album', '')
                    if any(not isinstance(value, str) or len(value.strip()) > 200 for value in (artist, album)):
                        raise ValueError('Artist and album must be at most 200 characters.')
                    artist, album = artist.strip(), album.strip()
                old_path = self.saved_folder / self._file_name(row)
                renamed = dict(row, name=name)
                new_path = self.saved_folder / self._file_name(renamed)
                try:
                    if old_path != new_path and old_path.exists():
                        os.replace(old_path, new_path)
                    else:
                        self._export(renamed)
                except OSError as exc:
                    raise ValueError('Could not rename the saved file. Check the music folder is writable.') from exc
                self.db.execute('UPDATE songs SET name=? WHERE id=?', (name, identity))
                if action == 'edit_song':
                    self.db.execute('UPDATE songs SET artist=?,album=?,metadata_edited=1 WHERE id=?', (artist, album, identity))
            elif action == 'rename':
                identity = request.get('library_id')
                name = self._name(request.get('name'))
                if not isinstance(identity, str) or not self.db.execute('SELECT 1 FROM libraries WHERE id=?', (identity,)).fetchone():
                    raise ValueError('Choose an existing library.')
                try:
                    self.db.execute('UPDATE libraries SET name=? WHERE id=?', (name, identity))
                except sqlite3.IntegrityError:
                    raise ValueError('A library with that name already exists.') from None
            elif action in ('delete', 'restore'):
                song_id = request.get('song_id')
                if not isinstance(song_id, str):
                    raise ValueError('Choose a saved song.')
                row = self.db.execute('SELECT * FROM songs WHERE id=?', (song_id,)).fetchone()
                if not row:
                    raise ValueError('This song is no longer in your library.')
                if action == 'restore':
                    self._restore(row)
                elif not row['deleted']:
                    trash = self.saved_folder.parent / 'trash'
                    trash.mkdir(exist_ok=True)
                    source = self.saved_folder / self._file_name(row)
                    if source.exists():
                        os.replace(source, trash / source.name)
                    self.db.execute('UPDATE songs SET deleted=1 WHERE id=?', (song_id,))
            elif action in ('favorite', 'assign'):
                song_id = request.get('song_id')
                if not isinstance(song_id, str) or not self.db.execute('SELECT 1 FROM songs WHERE id=? AND deleted=0', (song_id,)).fetchone():
                    raise ValueError('Choose a saved song.')
                if action == 'favorite':
                    value = request.get('favorite', request.get('value'))
                    if not isinstance(value, bool):
                        raise ValueError('Choose whether to favorite this song.')
                    self.db.execute('UPDATE songs SET favorite=? WHERE id=?', (int(value), song_id))
                else:
                    library_id = request.get('library_id')
                    if not isinstance(library_id, str) or not self.db.execute('SELECT 1 FROM libraries WHERE id=?', (library_id,)).fetchone():
                        raise ValueError('Choose an existing library.')
                    value = request.get('assigned', request.get('value', True))
                    if not isinstance(value, bool):
                        raise ValueError('Choose whether to add this song to the library.')
                    if value:
                        self.db.execute('INSERT OR IGNORE INTO memberships(song_id,library_id,order_position) VALUES(?,?,?)', (song_id, library_id, self.db.execute('SELECT COALESCE(MAX(order_position),-1)+1 FROM memberships WHERE library_id=?', (library_id,)).fetchone()[0]))
                    else:
                        self.db.execute('DELETE FROM memberships WHERE song_id=? AND library_id=?', (song_id, library_id))
            else:
                raise ValueError('Invalid library command.')
        return self.snapshot()

    def fill_metadata(self, identity, artist='', album=''):
        if any(not isinstance(value, str) or len(value) > 200 for value in (artist, album)):
            return
        with self.lock, self.db:
            self.db.execute("UPDATE songs SET artist=CASE WHEN artist='' THEN ? ELSE artist END, album=CASE WHEN album='' THEN ? ELSE album END WHERE id=? AND metadata_edited=0", (artist.strip(), album.strip(), identity))

    def get_setting(self, name, default=None):
        with self.lock:
            row = self.db.execute('SELECT value FROM settings WHERE name=?', (name,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_setting(self, name, value):
        if name not in ('preferred_device', 'volume', 'queue', 'adaptation'):
            raise ValueError('Invalid saved setting.')
        if name == 'preferred_device' and (not isinstance(value, str) or len(value) > 500):
            raise ValueError('Invalid piano device.')
        if name == 'volume' and (type(value) not in (int, float) or not 0 <= value <= 100):
            raise ValueError('Choose a volume between 0 and 100.')
        if name == 'queue':
            if (not isinstance(value, dict) or not isinstance(value.get('song_ids'), list)
                    or len(value['song_ids']) > 500 or any(not isinstance(song_id, str) for song_id in value['song_ids'])
                    or type(value.get('index')) is not int or not 0 <= value['index'] < max(1, len(value['song_ids']))):
                raise ValueError('Invalid saved queue.')
        if name == 'adaptation':
            if (not isinstance(value, dict) or value.get('mode') not in ('original', 'no_drums', 'piano', 'smart')
                    or not isinstance(value.get('songs'), dict) or len(value['songs']) > 1000):
                raise ValueError('Invalid playback sound setting.')
            for identity, saved in value['songs'].items():
                parts = saved if isinstance(saved, list) else saved.get('parts') if isinstance(saved, dict) else None
                mode = 'custom' if isinstance(saved, list) else saved.get('mode') if isinstance(saved, dict) else None
                if (not isinstance(identity, str) or not 1 <= len(identity) <= 100
                        or mode not in ('original', 'no_drums', 'piano', 'smart', 'custom')
                        or not isinstance(parts, list) or len(parts) > 256
                        or mode == 'custom' and not parts
                        or mode != 'custom' and parts
                        or any(not isinstance(part, str) or not part.isascii()
                            or not part.isdecimal() or len(part) > 6 for part in parts)):
                    raise ValueError('Invalid saved song playback setting.')
        with self.lock, self.db:
            self.db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', (name, json.dumps(value)))

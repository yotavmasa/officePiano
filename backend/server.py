#!/usr/bin/env python3
"""A local, persistent piano library and Wi-Fi remote."""
import hmac
import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import json
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
if sys.prefix == sys.base_prefix:
    sys.path.insert(0, str(ROOT / 'vendor'))
from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.exceptions import HTTPException
import uvicorn
from .library import Library, MAX_MIDI
from . import discovery
from .playback import Playback

from . import adaptation
from . import artwork
from . import sheets
UI_ROOT = ROOT / 'ui-dist'
KEY_FILE = ROOT / 'data' / 'remote-key'
TOKEN = KEY_FILE.read_text().strip() if KEY_FILE.exists() else secrets.token_urlsafe(24)
LOCK = threading.RLock()
NAME = ''
SONG_ID = ''
ADAPTATION_REPORT = {}
ARTWORK = {}
ARTWORK_SONG_ID = ''
ARTWORK_LAST_REQUEST = 0.0
ARTWORK_WORKER = ThreadPoolExecutor(max_workers=1)
ENGINE = None
LIBRARY = None
QUEUE = None
SHEETS = None
REMOTE = ''
MAX_UPLOAD = MAX_MIDI
ONLINE = {}
ONLINE_TIMEOUT = 90


def online_count(client_id='', now=None):
    now = time.monotonic() if now is None else now
    for key, seen in list(ONLINE.items()):
        if now - seen >= ONLINE_TIMEOUT:
            del ONLINE[key]
    if 16 <= len(client_id) <= 64 and all(c in '0123456789abcdef-' for c in client_id):
        if client_id in ONLINE or len(ONLINE) < 1024:
            ONLINE[client_id] = now
    return len(ONLINE)


def midi(request):
    ENGINE.stdin.write(json.dumps(request) + '\n')
    ENGINE.stdin.flush()
    line = ENGINE.stdout.readline()
    if not line:
        raise RuntimeError('MIDI player closed. Restart Piano Remote.')
    return json.loads(line)


def device_match(device, name):
    def normalized(text):
        return str(text).lower().replace(' bluetooth', '').replace(' midi', '').strip()
    return bool(name) and (device['name'] == name or normalized(device.get('stableName', device['name'])) == normalized(name))


def state():
    result = midi({'action': 'status'})
    preferred = LIBRARY.get_setting('preferred_device', '')
    result.update(name=NAME, song_id=SONG_ID, platform=sys.platform, adaptation=sound_state(), artwork=ARTWORK if SONG_ID and ARTWORK_SONG_ID == SONG_ID else {}, remote=REMOTE, online_count=online_count(), library=LIBRARY.snapshot(),
                  queue=QUEUE.snapshot() if QUEUE else {'song_ids': [], 'index': 0, 'running': False},
                  saved_folder=str(LIBRARY.saved_folder), device_name=preferred,
                  connection={'preferred_name': preferred,
                              'connected': any(device_match(d, preferred) and d.get('connected', True) for d in result.get('devices', []))})
    return result


def schedule_artwork(song):
    global ARTWORK, ARTWORK_SONG_ID
    if ENGINE is None or ARTWORK_SONG_ID == song['id']:
        return
    ARTWORK, ARTWORK_SONG_ID = {}, song['id']
    def lookup():
        global ARTWORK, ARTWORK_LAST_REQUEST
        with LOCK:
            if SONG_ID != song['id']:
                return
        time.sleep(max(0, 3 - (time.monotonic() - ARTWORK_LAST_REQUEST)))
        with LOCK:
            if SONG_ID != song['id']:
                return
        ARTWORK_LAST_REQUEST = time.monotonic()
        try:
            found = artwork.lookup(song)
        except Exception:
            found = {}
        with LOCK:
            if SONG_ID == song['id']:
                ARTWORK = found
                LIBRARY.fill_metadata(song['id'], found.get('artist', ''), found.get('album', ''))
    ARTWORK_WORKER.submit(lookup)


def sound_config():
    return LIBRARY.get_setting('adaptation', {'mode': 'original', 'songs': {}})


def sound_settings(song_id, config=None):
    config = sound_config() if config is None else config
    saved = config.get('songs', {}).get(song_id)
    if isinstance(saved, list):  # Keep existing manual selections.
        saved = {'mode': 'custom', 'parts': saved}
    return {'mode': saved['mode'] if saved else config.get('mode', 'original'),
            'parts': saved.get('parts', []) if saved else [], 'saved_for_song': bool(saved),
            'default_mode': config.get('mode', 'original')}


def load_prepared(song, data, report):
    global NAME, SONG_ID, ADAPTATION_REPORT
    with tempfile.NamedTemporaryFile(suffix='.mid') as file:
        file.write(data); file.flush()
        result = midi({'action': 'load', 'path': file.name})
    if not result.get('ok'):
        raise ValueError(result.get('error', 'This MIDI could not be loaded.'))
    if QUEUE:
        QUEUE.running = False
        QUEUE.error = ''
    NAME, SONG_ID, ADAPTATION_REPORT = song['name'], song['id'], report
    schedule_artwork(song)
    return song


def load_song(song_id):
    data, song = LIBRARY.playable(song_id)
    prepared, report = adaptation.render(data, sound_settings(song_id))
    return load_prepared(song, prepared, report)


def sound_state(song_id=None, analyse=False):
    song_id = SONG_ID if song_id is None else song_id
    result = {'ok': True, 'song_id': song_id, 'expected_song_id': SONG_ID, 'settings': sound_settings(song_id),
              'report': ADAPTATION_REPORT if song_id and song_id == SONG_ID else {}}
    if analyse:
        result['analysis'] = adaptation.analyse(LIBRARY.playable(song_id)[0]) if song_id else {'parts': [], 'recommended_parts': [], 'has_piano': False}
    return result


def change_sound(request):
    song_id = request.get('song_id', '')
    expected = request.get('expected_song_id', song_id)
    if not isinstance(song_id, str) or expected != SONG_ID:
        raise ValueError('The current song changed. Reopen Playback sound and try again.')
    mode = request.get('mode')
    if mode not in ('original', 'piano', 'smart', 'custom'):
        raise ValueError('Choose a playback sound option.')
    config = sound_config()
    config.setdefault('songs', {})
    if mode == 'custom':
        parts = request.get('parts')
        if not song_id or not isinstance(parts, list) or not 1 <= len(parts) <= 256 or any(not isinstance(part, str) for part in parts):
            raise ValueError('Select at least one non-drum part for this song.')
        config['songs'][song_id] = {'mode': mode, 'parts': list(dict.fromkeys(parts))}
    elif song_id:
        config['songs'][song_id] = {'mode': mode, 'parts': []}
    else:
        config['mode'] = mode
    if len(config['songs']) > 1000:
        raise ValueError('Too many saved manual selections. Choose a default playback mode.')
    if song_id:
        original, song = LIBRARY.playable(song_id)
        prepared, report = adaptation.render(original, sound_settings(song_id, config))
        load_prepared(song, prepared, report)
    LIBRARY.set_setting('adaptation', config)
    return sound_state()


class RequestHandler:
    """Keep the existing API response contract while FastAPI owns HTTP transport."""
    def __init__(self, request, body=b''):
        self.headers = dict(request.headers)
        self.path = request.url.path + ('?' + request.url.query if request.url.query else '')
        self.client_address = (request.client.host if request.client else '', 0)
        self.body = body

    def reply(self, code, data, kind='application/json', filename=None):
        if kind == 'application/json':
            data = json.dumps(data).encode()
        headers = {'Content-Type': kind, 'Cache-Control': 'no-store',
                   'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                   'X-Frame-Options': 'DENY'}
        if filename:
            headers['Content-Disposition'] = 'attachment; filename="' + filename + '"'
        return Response(data, status_code=code, headers=headers)

    def authorized(self):
        supplied = self.headers.get('authorization', '')
        return supplied.isascii() and hmac.compare_digest(supplied, 'Bearer ' + TOKEN)

    def get(self):
        request = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(request.query)
        if request.path == '/':
            entry = UI_ROOT / 'index.html'
            html = entry.read_text()
            host = urllib.parse.urlsplit('//' + self.headers.get('host', '')).hostname
            if self.client_address[0] in ('127.0.0.1', '::1') and host in ('127.0.0.1', 'localhost', '::1'):
                bootstrap = '<script>window.__localPianoKey=' + json.dumps(TOKEN) + ';</script>'
                html = html.replace('</head>', bootstrap + '</head>', 1)
            return self.reply(200, html.encode(), 'text/html; charset=utf-8')
        if request.path.startswith('/assets/'):
            asset = (UI_ROOT / urllib.parse.unquote(request.path).lstrip('/')).resolve()
            try:
                asset.relative_to((UI_ROOT / 'assets').resolve())
            except ValueError:
                return self.reply(404, {'error': 'Not found'})
            if not asset.is_file():
                return self.reply(404, {'error': 'Not found'})
            kind = mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
            return self.reply(200, asset.read_bytes(), kind)
        if not self.authorized():
            return self.reply(401, {'error': 'Open the complete remote link from the Mac, including its # key.'})
        try:
            if request.path == '/api/sheets':
                return self.reply(200, dict(ok=True, **SHEETS.snapshot()))
            if request.path == '/api/sheets/source':
                path, name = SHEETS.source(query.get('id', [''])[0])
                safe_name = ''.join(c for c in name if c.isascii() and (c.isalnum() or c in ' ._-'))[:200] or 'sheet.pdf'
                return self.reply(200, path.read_bytes(), mimetypes.guess_type(name)[0] or 'application/octet-stream', safe_name)
            if request.path == '/api/search':
                result = discovery.search(query.get('q', [''])[0], int(query.get('page', ['1'])[0]), query.get('source', ['bitmidi'])[0])
                return self.reply(200, result)
            with LOCK:
                if request.path == '/api/status':
                    online_count(self.headers.get('x-piano-client', ''))
                    result = state()
                elif request.path == '/api/adaptation':
                    result = sound_state(query.get('song_id', [SONG_ID])[0], analyse=True)
                elif request.path == '/api/song-file':
                    data, song = LIBRARY.select(query.get('song_id', [''])[0])
                    return self.reply(200, data, 'audio/midi', song['file_name'])
                else:
                    return self.reply(404, {'error': 'Not found'})
            return self.reply(200, result)
        except (ValueError, socket.timeout) as exc:
            return self.reply(400, {'error': str(exc)})
        except Exception as exc:
            return self.reply(500, {'error': str(exc)})

    def post(self):
        global NAME, SONG_ID, ARTWORK_SONG_ID
        if not self.authorized():
            return self.reply(401, {'error': 'Access key required'})
        try:
            data = self.body
            if self.path == '/api/sheets/upload':
                name = urllib.parse.unquote(self.headers.get('x-filename', 'Sheet music.pdf'))[:200]
                item = SHEETS.submit(data, name)
                result = dict(ok=True, item=item, **SHEETS.snapshot())
            elif self.path == '/api/upload':
                name = urllib.parse.unquote(self.headers.get('x-filename', 'Uploaded MIDI'))[:200]
                with LOCK:
                    song = LIBRARY.add(data, name)
                    result = dict(ok=True, song=song, library=LIBRARY.snapshot())
            else:
                request = json.loads(data)
                if not isinstance(request, dict):
                    raise ValueError('Invalid request')
                if self.path == '/api/sheets/retry':
                    SHEETS.retry(request.get('id'))
                    result = dict(ok=True, **SHEETS.snapshot())
                elif self.path == '/api/sheets/convert':
                    SHEETS.convert_book(request.get('id'), request.get('pieces'))
                    result = dict(ok=True, **SHEETS.snapshot())
                elif self.path == '/api/import':
                    midi_data, metadata = discovery.download(request.get('url'))
                    with LOCK:
                        song = LIBRARY.add(midi_data, metadata['name'], metadata['url'])
                        result = dict(ok=True, song=song, library=LIBRARY.snapshot())
                else:
                    with LOCK:
                        if self.path == '/api/control':
                            if request.get('action') not in ('play', 'pause', 'stop', 'volume', 'seek'):
                                raise ValueError('Invalid playback command')
                            if request.get('action') == 'seek' and (not SONG_ID or request.get('song_id') != SONG_ID):
                                raise ValueError('The song changed. Try the timeline again.')
                            if request.get('action') == 'play' and not request.get('device'):
                                preferred = LIBRARY.get_setting('preferred_device', '')
                                for device in midi({'action': 'status'}).get('devices', []):
                                    if device_match(device, preferred):
                                        request['device'] = device['id']; break
                            if QUEUE and request.get('action') in ('play', 'pause', 'stop'):
                                result = QUEUE.control(request['action'], request)
                            else:
                                result = midi(request)
                            if result.get('ok') and request.get('action') == 'volume':
                                LIBRARY.set_setting('volume', result['volume'])
                        elif self.path == '/api/queue':
                            if not QUEUE:
                                raise ValueError('Restart the app to enable the queue.')
                            result = dict(ok=True, queue=QUEUE.mutate(request))
                        elif self.path in ('/api/connect', '/api/reconnect'):
                            name = request.get('name')
                            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
                                raise ValueError('Choose the piano you want to remember.')
                            if self.path == '/api/reconnect' and QUEUE:
                                QUEUE.control('stop')
                            result = midi({'action': 'reconnect' if self.path == '/api/reconnect' else 'connect', 'name': name.strip()})
                            if result.get('ok'):
                                LIBRARY.set_setting('preferred_device', name.strip())
                        elif self.path == '/api/adaptation':
                            result = change_sound(request)
                        elif self.path == '/api/select':
                            song = load_song(request.get('song_id'))
                            result = dict(ok=True, song=song)
                        elif self.path == '/api/library':
                            library = LIBRARY.mutate(request)
                            if request.get('action') in ('rename_song', 'edit_song') and request.get('song_id') == SONG_ID:
                                renamed = next(song for song in library['songs'] if song['id'] == SONG_ID)
                                NAME = renamed['name']
                                ARTWORK_SONG_ID = ''
                                schedule_artwork(renamed)
                            if request.get('action') == 'delete':
                                identity = request.get('song_id')
                                if QUEUE:
                                    QUEUE.forget(identity)
                                elif SONG_ID == identity:
                                    midi({'action': 'stop'})
                                if SONG_ID == identity:
                                    NAME, SONG_ID = '', ''
                            result = dict(ok=True, library=library)
                        else:
                            return self.reply(404, {'error': 'Not found'})
            return self.reply(200 if result.get('ok') else 400, result)
        except (ValueError, socket.timeout) as exc:
            return self.reply(400, {'error': str(exc)})
        except Exception as exc:
            return self.reply(500, {'error': str(exc)})


def start_services(port=52863):
    global ENGINE, REMOTE, LIBRARY, QUEUE, SHEETS
    LIBRARY = Library(ROOT)
    SHEETS = sheets.SheetStore(ROOT / 'data', LIBRARY)
    if not KEY_FILE.exists():
        KEY_FILE.write_text(TOKEN)
        KEY_FILE.chmod(0o600)
    engine_command = ([str(ROOT / 'native/midi')] if sys.platform == 'darwin' else
                      [sys.executable, str(ROOT / 'native/midi_linux.py')])
    ENGINE = subprocess.Popen(engine_command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    ip = socket.gethostname() + '.local'
    if sys.platform == 'darwin':
        for interface in ('en0', 'en1'):
            result = subprocess.run(['ipconfig', 'getifaddr', interface], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                ip = result.stdout.strip(); break
    else:
        result = subprocess.run(['hostname', '-I'], capture_output=True, text=True)
        if result.returncode == 0:
            addresses = [address for address in result.stdout.split() if ':' not in address and not address.startswith('127.')]
            if addresses:
                ip = addresses[0]
    REMOTE = f'http://{ip}:{port}/#' + TOKEN
    local = f'http://127.0.0.1:{port}/#' + TOKEN
    current = midi({'action': 'status'})
    preferred = LIBRARY.get_setting('preferred_device', '')
    if not preferred:
        candidates = [d['name'] for d in current.get('devices', []) if 'prodigy' in d['name'].lower()]
        if len(candidates) == 1:
            preferred = candidates[0]
            LIBRARY.set_setting('preferred_device', preferred)
    if preferred:
        midi({'action': 'connect', 'name': preferred})
    midi({'action': 'volume', 'value': int(LIBRARY.get_setting('volume', 20))})
    QUEUE = Playback(LIBRARY, midi, load_song, lambda: SONG_ID)
    queue_shutdown = threading.Event()
    def advance_queue():
        while not queue_shutdown.wait(0.4):
            with LOCK:
                QUEUE.tick()
    threading.Thread(target=advance_queue, daemon=True).start()
    awake = subprocess.Popen(['caffeinate', '-i', '-w', str(os.getpid())]) if sys.platform == 'darwin' else None
    print('\nPiano Remote is running. Keep this window open.\n')
    print('Office Wi-Fi remote link:\n' + REMOTE + '\n')
    print('Saved MIDI folder:\n' + str(LIBRARY.saved_folder) + '\n')
    print('Close this window or press Control-C to stop.\n', flush=True)
    if os.environ.get('PIANO_REMOTE_NO_OPEN') != '1':
        webbrowser.open(local)
    return queue_shutdown, awake


def stop_services(resources):
    queue_shutdown, awake = resources
    queue_shutdown.set()
    SHEETS.shutdown()
    ARTWORK_WORKER.shutdown(wait=False, cancel_futures=True)
    with LOCK:
        if ENGINE.poll() is None:
            try:
                midi({'action': 'stop'})
                ENGINE.stdin.close()
                ENGINE.wait(timeout=3)
            except Exception:
                ENGINE.kill()
    if awake is not None:
        awake.terminate()


def create_app(startup=True, port=52863):
    @asynccontextmanager
    async def lifespan(app):
        resources = await run_in_threadpool(start_services, port) if startup else None
        try:
            yield
        finally:
            if resources is not None:
                await run_in_threadpool(stop_services, resources)

    application = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @application.exception_handler(HTTPException)
    async def http_error(request, error):
        return RequestHandler(request).reply(error.status_code, {'error': str(error.detail)})

    @application.get('/{path:path}')
    def get(request: Request, path: str):
        return RequestHandler(request).get()

    @application.post('/{path:path}')
    async def post(request: Request, path: str):
        responder = RequestHandler(request)
        if not responder.authorized():
            return responder.reply(401, {'error': 'Access key required'})
        limit = 20 * 1024 * 1024 if request.url.path == '/api/sheets/upload' else MAX_UPLOAD
        too_large = {'error': 'Choose a sheet file smaller than 20 MB.' if request.url.path == '/api/sheets/upload' else 'Choose a MIDI file smaller than 8 MB.'}
        try:
            declared = request.headers.get('content-length')
            if declared is not None:
                declared = int(declared)
                if not 0 < declared <= limit:
                    return responder.reply(413, too_large)
            async def read_body():
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        return None
                    chunks.append(chunk)
                return b''.join(chunks)
            body = await asyncio.wait_for(read_body(), timeout=20)
            if body is None or not body:
                return responder.reply(413, too_large)
            if declared is not None and len(body) != declared:
                raise ValueError('Upload interrupted')
            responder.body = body
            return await run_in_threadpool(responder.post)
        except (ValueError, asyncio.TimeoutError, ClientDisconnect) as exc:
            return responder.reply(400, {'error': str(exc) or 'Upload interrupted'})

    return application


app = create_app()


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(('0.0.0.0', 52863))
    except OSError:
        listener.bind(('0.0.0.0', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    config = uvicorn.Config(create_app(port=port), log_level='warning', proxy_headers=False)
    try:
        uvicorn.Server(config).run(sockets=[listener])
    finally:
        listener.close()


if __name__ == '__main__':
    main()

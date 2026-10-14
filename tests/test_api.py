"""Transport checks use an isolated library and fake MIDI; never touch the office piano."""
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'vendor'))
from fastapi.testclient import TestClient
from backend import server
from backend.library import Library
from backend.playback import Playback
from backend.sheets import SheetStore
from pypdf import PdfWriter


def fixture_midi():
    track = bytes.fromhex('00c00000903c4030803c0000ff2f00')
    return b'MThd' + struct.pack('>IHHH', 6, 0, 1, 96) + b'MTrk' + struct.pack('>I', len(track)) + track


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.commands = []
        self.playing = False
        self.loaded = False
        self.volume = 20
        def midi(command):
            self.commands.append(dict(command))
            action = command['action']
            if action == 'load':
                self.loaded = True
                self.playing = False
            elif action == 'play':
                self.playing = True
            elif action in ('pause', 'stop'):
                self.playing = False
            elif action == 'volume':
                self.volume = command['value']
            return {'ok': True, 'devices': [], 'playing': self.playing, 'loaded': self.loaded,
                    'volume': self.volume, 'duration': 1, 'position': 0}
        library = Library(self.folder)
        sheets = SheetStore(self.folder / 'data', library)
        self.patches = [patch.object(server, name, value) for name, value in {
            'LIBRARY': library, 'SHEETS': sheets, 'ENGINE': None, 'SONG_ID': '', 'NAME': '',
            'ADAPTATION_REPORT': {}, 'ARTWORK': {}, 'ARTWORK_SONG_ID': '', 'ONLINE': {},
            'TOKEN': 'test-access-key', 'midi': midi,
        }.items()]
        for item in self.patches:
            item.start()
        server.QUEUE = Playback(library, midi, server.load_song, lambda: server.SONG_ID, server.clear_finished_player)
        self.client = TestClient(server.create_app(startup=False), base_url='http://localhost', client=('127.0.0.1', 12345))
        self.client.__enter__()
        self.auth = {'Authorization': 'Bearer test-access-key'}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        server.SHEETS.shutdown()
        server.SHEETS.analysis_worker.shutdown(wait=True)
        server.SHEETS.worker.shutdown(wait=True)
        server.QUEUE = None
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def upload(self):
        result = self.client.post('/api/upload', headers=dict(self.auth, **{'X-Filename': 'Test.mid'}), content=fixture_midi())
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()['song']

    def test_upload_into_library_preserves_player_and_queue(self):
        created = self.client.post('/api/library', headers=self.auth, json={'action': 'create', 'name': 'Upload destination'})
        self.assertEqual(created.status_code, 200, created.text)
        destination = created.json()['library']['libraries'][0]['id']
        existing = self.upload()
        self.client.post('/api/queue', headers=self.auth, json={'action': 'add', 'song_id': existing['id']})
        before = self.client.get('/api/status', headers=self.auth).json()
        saved_ids = []
        for pitch in (62, 64):
            midi = fixture_midi().replace(bytes.fromhex('903c40'), bytes([0x90, pitch, 64])).replace(bytes.fromhex('803c00'), bytes([0x80, pitch, 0]))
            result = self.client.post('/api/upload', headers=dict(self.auth, **{'X-Filename': f'Upload-{pitch}.mid', 'X-Library-Id': destination}), content=midi)
            self.assertEqual(result.status_code, 200, result.text)
            saved_ids.append(result.json()['song']['id'])
        snapshot = result.json()['library']
        self.assertEqual(snapshot['libraries'][0]['song_ids'], saved_ids)
        after = self.client.get('/api/status', headers=self.auth).json()
        self.assertEqual(after['queue'], before['queue'])
        self.assertEqual(after['song_id'], before['song_id'])
        self.assertEqual(after['playing'], before['playing'])

    def test_missing_upload_library_does_not_save_file(self):
        result = self.client.post('/api/upload', headers=dict(self.auth, **{'X-Library-Id': 'removed-library'}), content=fixture_midi())
        self.assertEqual(result.status_code, 400)
        self.assertEqual(server.LIBRARY.snapshot()['songs'], [])

    def test_finished_empty_queue_clears_song_and_timeline(self):
        song = self.upload()
        server.load_song(song['id'])
        server.QUEUE.mutate({'action': 'add', 'song_id': song['id']})
        server.QUEUE.running, server.QUEUE.device_id = True, 12
        with patch.object(server.QUEUE, 'send', return_value={'ok': True, 'playing': False, 'devices': [{'id': 12}]}), patch.object(server, 'ARTWORK', {'url': 'old-cover'}), patch.object(server, 'ARTWORK_SONG_ID', song['id']):
            server.QUEUE.tick()
            status = self.client.get('/api/status', headers=self.auth).json()
            self.assertEqual(status['name'], '')
            self.assertEqual(status['song_id'], '')
            self.assertEqual(status['seconds'], 0)
            self.assertEqual(status['duration_seconds'], 0)
            self.assertFalse(status['loaded'])
            self.assertEqual(status['artwork'], {})
            self.assertEqual(status['queue']['song_ids'], [])

    def test_local_bootstrap_and_remote_host_do_not_leak_key(self):
        local = self.client.get('/')
        self.assertEqual(local.status_code, 200)
        self.assertIn('window.__localPianoKey="test-access-key"', local.text)
        remote = self.client.get('/', headers={'Host': '192.168.40.24'})
        self.assertNotIn('test-access-key', remote.text)
        spoofed = self.client.get('/', headers={'Host': '192.168.40.24', 'X-Forwarded-For': '127.0.0.1'})
        self.assertNotIn('test-access-key', spoofed.text)
        self.assertEqual(local.headers['x-frame-options'], 'DENY')
        self.assertEqual(local.headers['cache-control'], 'no-store')
        self.assertEqual(local.headers['referrer-policy'], 'no-referrer')

    def test_remote_peer_cannot_bootstrap_with_local_host(self):
        with TestClient(server.create_app(startup=False), base_url='http://localhost', client=('192.168.40.5', 1)) as remote:
            result = remote.get('/', headers={'X-Forwarded-For': '127.0.0.1'})
            self.assertNotIn('test-access-key', result.text)

    def test_api_authorization_and_unknown_routes(self):
        self.assertEqual(self.client.get('/api/status').status_code, 401)
        self.assertEqual(self.client.post('/api/upload', content=fixture_midi()).status_code, 401)
        self.assertEqual(self.client.get('/api/unknown', headers=self.auth).status_code, 404)
        self.assertEqual(self.client.post('/api/unknown', headers=self.auth, json={}).status_code, 404)
        result = self.client.put('/api/status', headers=self.auth)
        self.assertEqual(result.status_code, 405)
        self.assertIn('error', result.json())

    def test_assets_are_public_and_cannot_escape_directory(self):
        asset = next((server.UI_ROOT / 'assets').glob('*.css'))
        response = self.client.get('/assets/' + asset.name)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers['content-type'].startswith('text/css'))
        self.assertEqual(self.client.get('/assets/%2e%2e/server.py').status_code, 404)
        self.assertEqual(self.client.get('/assets/%2e%2e/%2e%2e/data/remote-key').status_code, 404)

    def test_upload_preserves_queue_and_player(self):
        song = self.upload()
        self.assertEqual(self.commands, [])
        self.assertFalse(self.playing)
        self.assertEqual(server.QUEUE.snapshot()['song_ids'], [])
        self.assertEqual(server.SONG_ID, '')
        self.assertEqual(song['name'], 'Test.mid')

    def test_original_midi_download_keeps_headers_and_bytes(self):
        song = self.upload()
        result = self.client.get('/api/song-file', headers=self.auth, params={'song_id': song['id']})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, fixture_midi())
        self.assertEqual(result.headers['content-type'], 'audio/midi')
        self.assertIn('attachment;', result.headers['content-disposition'])
        self.assertEqual(result.headers['x-content-type-options'], 'nosniff')

    def test_upload_limits_empty_invalid_length_and_streaming_body(self):
        for path, size in (('/api/upload', 8 * 1024 * 1024 + 1), ('/api/sheets/upload', 20 * 1024 * 1024 + 1)):
            result = self.client.post(path, headers=dict(self.auth, **{'Content-Length': str(size)}), content=b'a')
            self.assertEqual(result.status_code, 413)
        self.assertEqual(self.client.post('/api/upload', headers=self.auth, content=b'').status_code, 413)
        self.assertEqual(self.client.post('/api/upload', headers=dict(self.auth, **{'Content-Length': 'nope'}), content=b'a').status_code, 400)
        self.assertEqual(self.client.post('/api/upload', headers=dict(self.auth, **{'Content-Length': '3'}), content=b'a').status_code, 400)
        result = self.client.post('/api/upload', headers=self.auth, content=iter([b'x' * (4 * 1024 * 1024), b'x' * (4 * 1024 * 1024 + 1)]))
        self.assertEqual(result.status_code, 413)

    def test_invalid_json_and_object_shape(self):
        for payload in (b'bad json', b'[]', b'null'):
            result = self.client.post('/api/control', headers=self.auth, content=payload)
            self.assertEqual(result.status_code, 400, result.text)
            self.assertIn('error', result.json())

    def test_status_online_count_and_preferred_device_connect(self):
        headers = dict(self.auth, **{'X-Piano-Client': 'a' * 32})
        result = self.client.get('/api/status', headers=headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['online_count'], 1)
        self.assertIn('queue', result.json())
        result = self.client.post('/api/connect', headers=self.auth, json={'name': 'Prodigy II'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(server.LIBRARY.get_setting('preferred_device'), 'Prodigy II')
        self.assertEqual(self.commands[-1]['action'], 'connect')

    def test_song_select_adaptation_save_seek_and_queue(self):
        song = self.upload()
        selected = self.client.post('/api/select', headers=self.auth, json={'song_id': song['id']})
        self.assertEqual(selected.status_code, 200, selected.text)
        self.assertEqual(server.SONG_ID, song['id'])
        sound = self.client.get('/api/adaptation', headers=self.auth, params={'song_id': song['id']})
        self.assertEqual(sound.status_code, 200, sound.text)
        self.assertTrue(sound.json()['analysis']['parts'])
        saved = self.client.post('/api/adaptation', headers=self.auth, json={'song_id': song['id'], 'expected_song_id': song['id'], 'mode': 'original', 'parts': []})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(self.client.post('/api/control', headers=self.auth, json={'action': 'seek', 'song_id': 'wrong', 'position': 0}).status_code, 400)
        self.assertEqual(self.client.post('/api/control', headers=self.auth, json={'action': 'seek', 'song_id': song['id'], 'position': .1}).status_code, 200)
        queued = self.client.post('/api/queue', headers=self.auth, json={'action': 'add', 'song_id': song['id']})
        self.assertEqual(queued.status_code, 200, queued.text)
        self.assertEqual(queued.json()['queue']['song_ids'], [song['id']])

    def test_library_rename_and_discovery_import(self):
        song = self.upload()
        result = self.client.post('/api/library', headers=self.auth, json={'action': 'rename_song', 'song_id': song['id'], 'name': 'My title'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['library']['songs'][0]['name'], 'My title')
        with patch.object(server.discovery, 'search', return_value={'ok': True, 'songs': []}) as search:
            result = self.client.get('/api/search?q=hello&page=2&source=both', headers=self.auth)
            self.assertEqual(result.status_code, 200)
            search.assert_called_once_with('hello', 2, 'both')
        with patch.object(server.discovery, 'download', return_value=(fixture_midi(), {'name': 'Import.mid', 'url': 'https://bitmidi.com/test'})):
            result = self.client.post('/api/import', headers=self.auth, json={'url': 'https://bitmidi.com/test'})
            self.assertEqual(result.status_code, 200, result.text)

    def test_lifespan_initializes_and_stops_services_once(self):
        sentinel = object()
        with patch.object(server, 'start_services', return_value=sentinel) as start, patch.object(server, 'stop_services') as stop:
            with TestClient(server.create_app(port=45678)) as client:
                self.assertEqual(client.get('/api/status', headers=self.auth).status_code, 200)
                start.assert_called_once_with(45678)
                stop.assert_not_called()
            stop.assert_called_once_with(sentinel)

    def test_slow_discovery_does_not_block_player_status(self):
        entered, release = threading.Event(), threading.Event()
        def search(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Status request was blocked by discovery')
            return {'ok': True, 'songs': []}
        with patch.object(server.discovery, 'search', side_effect=search), ThreadPoolExecutor(max_workers=1) as worker:
            future = worker.submit(self.client.get, '/api/search?q=hello', headers=self.auth)
            self.assertTrue(entered.wait(2))
            try:
                self.assertEqual(self.client.get('/api/status', headers=self.auth).status_code, 200)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=2).status_code, 200)

    def test_sheet_upload_list_download_convert_and_retry(self):
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        buffer = io.BytesIO()
        writer.write(buffer)
        result = self.client.post('/api/sheets/upload', headers=dict(self.auth, **{'X-Filename': 'Book.pdf'}), content=buffer.getvalue())
        self.assertEqual(result.status_code, 200, result.text)
        identity = result.json()['item']['id']
        self.assertEqual(result.json()['item']['status'], 'needs_pages')
        self.assertEqual(self.client.get('/api/sheets', headers=self.auth).status_code, 200)
        source = self.client.get('/api/sheets/source', headers=self.auth, params={'id': identity})
        self.assertEqual(source.content, buffer.getvalue())
        self.assertTrue(source.headers['content-type'].startswith('application/pdf'))
        self.assertIn('Book.pdf', source.headers['content-disposition'])
        with patch.object(server.SHEETS, 'convert_book') as convert:
            result = self.client.post('/api/sheets/convert', headers=self.auth, json={'id': identity, 'pieces': [{'name': 'Piece', 'pages': '1'}]})
            self.assertEqual(result.status_code, 200)
            convert.assert_called_once()
        with patch.object(server.SHEETS, 'retry') as retry:
            result = self.client.post('/api/sheets/retry', headers=self.auth, json={'id': identity})
            self.assertEqual(result.status_code, 200)
            retry.assert_called_once_with(identity)
        self.assertEqual(self.commands, [])

    def test_book_browser_authentication_and_preview_transport(self):
        for path in ('/api/sheets/book?id=book', '/api/sheets/preview?id=book&page=1'):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post('/api/sheets/analyse', json={'id': 'book'}).status_code, 401)
        book = {'id': 'book', 'analysis_status': 'ready', 'candidates': []}
        with patch.object(server.SHEETS, 'book', return_value=book), patch.object(server.SHEETS, 'analyse_book', return_value=book):
            self.assertEqual(self.client.get('/api/sheets/book?id=book', headers=self.auth).json()['book'], book)
            self.assertEqual(self.client.post('/api/sheets/analyse', headers=self.auth, json={'id': 'book'}).json()['book'], book)
        with patch.object(server.SHEETS, 'page_preview', return_value=b'\x89PNG\r\n\x1a\n') as render:
            result = self.client.get('/api/sheets/preview?id=book&page=2', headers=self.auth)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers['content-type'], 'image/png')
            self.assertEqual(result.headers['cache-control'], 'no-store')
            render.assert_called_once_with('book', 2)
            self.assertEqual(self.client.get('/api/sheets/preview?id=book&page=nope', headers=self.auth).status_code, 400)
        self.assertEqual(self.commands, [])

    def test_recognized_score_download_requires_authentication(self):
        self.assertEqual(self.client.get('/api/sheets/score?song_id=a').status_code, 401)
        with patch.object(server.SHEETS, 'recognized_score', return_value=(b'<score-partwise/>', 'Song.musicxml')) as export:
            result = self.client.get('/api/sheets/score?song_id=a', headers=self.auth)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.content, b'<score-partwise/>')
            self.assertIn('application/vnd.recordare.musicxml+xml', result.headers['content-type'])
            self.assertIn('Song.musicxml', result.headers['content-disposition'])
            export.assert_called_once_with('a')

    def test_slow_book_preview_does_not_block_player(self):
        entered, release = threading.Event(), threading.Event()
        def preview(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Player status was blocked by book preview')
            return b'PNG'
        with patch.object(server.SHEETS, 'page_preview', side_effect=preview), ThreadPoolExecutor(max_workers=1) as worker:
            future = worker.submit(self.client.get, '/api/sheets/preview?id=book&page=1', headers=self.auth)
            self.assertTrue(entered.wait(2))
            try:
                self.assertEqual(self.client.get('/api/status', headers=self.auth).status_code, 200)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=2).status_code, 200)

    def test_sheet_delete_restore_are_authenticated_and_preserve_player(self):
        for action in ('delete', 'restore'):
            self.assertEqual(self.client.post('/api/sheets/' + action, json={'id': 'book'}).status_code, 401)
            with patch.object(server.SHEETS, action) as change:
                response = self.client.post('/api/sheets/' + action, headers=self.auth, json={'id': 'book'})
                self.assertEqual(response.status_code, 200, response.text)
                change.assert_called_once_with('book')
                self.assertIn('items', response.json())
        self.assertEqual(self.client.post('/api/sheets/delete', headers=self.auth, json={'id': 'missing'}).status_code, 400)
        self.assertEqual(self.commands, [])
        self.assertEqual(server.QUEUE.snapshot()['song_ids'], [])


if __name__ == '__main__':
    unittest.main()

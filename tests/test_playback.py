import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))
from backend.playback import Playback


class FakeLibrary:
    def __init__(self):
        self.settings = {'preferred_device': 'Prodigy2 MIDI Bluetooth'}
        self.songs = {'A', 'B', 'C'}
        self.incompatible = set()

    def select(self, song_id):
        if not isinstance(song_id, str) or song_id not in self.songs:
            raise ValueError('Choose a saved song.')
        return b'midi', {'id': song_id}

    def playable(self, song_id):
        data, song = self.select(song_id)
        return data, song

    def get_setting(self, name, default=None):
        return self.settings.get(name, default)

    def set_setting(self, name, value):
        self.settings[name] = {key: list(item) if isinstance(item, list) else item for key, item in value.items()}


class FakeEngine:
    def __init__(self):
        self.song = ''
        self.playing, self.paused = False, False
        self.devices = [{'id': 12, 'name': 'Prodigy2 MIDI Bluetooth', 'stableName': 'Prodigy2'}]
        self.calls, self.loads = [], []
        self.fail_load = ''
        self.delivery_error = ''

    def send(self, request):
        self.calls.append(dict(request))
        action = request['action']
        if action == 'play':
            self.playing, self.paused = True, False
        elif action == 'pause':
            self.playing, self.paused = False, True
        elif action == 'stop':
            self.playing, self.paused = False, False
        return {'ok': True, 'playing': self.playing, 'paused': self.paused, 'devices': self.devices, 'playback_error': self.delivery_error}

    def load(self, song_id):
        if song_id == self.fail_load:
            raise ValueError('Load failed')
        self.loads.append(song_id)
        self.song = song_id
        return {'id': song_id}


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.library, self.engine = FakeLibrary(), FakeEngine()
        self.player = self.make_player()
        self.player.mutate({'action': 'replace', 'song_ids': ['A', 'B', 'C']})

    def make_player(self):
        return Playback(self.library, self.engine.send, self.engine.load, lambda: self.engine.song)

    def test_automatic_advance_and_final_completion(self):
        self.player.control('play')
        self.assertEqual(self.engine.loads, ['A'])
        self.player.tick()
        self.assertEqual(self.engine.loads, ['A'])
        self.engine.playing = False
        self.player.tick()
        self.assertEqual(self.engine.loads, ['A', 'B'])
        self.assertEqual(self.player.snapshot()['index'], 0)
        self.assertEqual(self.player.song_ids, ['B', 'C'])
        self.engine.playing = False
        self.player.tick()
        self.assertEqual(self.engine.loads, ['A', 'B', 'C'])
        self.engine.playing = False
        self.player.tick()
        self.assertFalse(self.player.running)
        self.assertEqual(self.player.index, 0)
        self.assertEqual(self.player.song_ids, [])
        self.assertEqual(self.library.settings['queue']['song_ids'], [])

    def test_finish_removes_only_current_entry_and_keeps_saved_song(self):
        self.player.mutate({'action':'replace','song_ids':['A','B','B','C']})
        self.player.control('play',{'index':1})
        self.engine.playing=False
        self.player.tick()
        self.assertEqual(self.player.song_ids,['A','B','C'])
        self.assertEqual(self.player.index,1)
        self.assertTrue(self.player.running)
        self.assertEqual(self.library.songs,{'A','B','C'})
        self.player.control('play',{'index':2})
        self.engine.playing=False
        self.player.tick()
        self.assertEqual(self.player.song_ids,['A','B'])
        self.assertFalse(self.player.running)
        restored=self.make_player()
        self.assertEqual(restored.song_ids,['A','B'])

    def test_move_rejects_stale_queue_and_preserves_current_song(self):
        self.player.control('play', {'index':1})
        before=self.player.snapshot()
        with self.assertRaises(ValueError): self.player.mutate({'action':'move','from':0,'to':1,'expected_song_ids':['A','B']})
        self.assertEqual(self.player.snapshot(),before)
        self.player.mutate({'action':'move','from':1,'to':0,'expected_song_ids':['A','B','C']})
        self.assertEqual(self.player.song_ids,['B','A','C'])
        self.assertEqual(self.player.index,0)
        self.assertTrue(self.player.running)
        self.assertEqual(self.engine.song,'B')

    def test_pause_resume_and_stop_do_not_advance(self):
        self.player.control('play')
        self.player.control('pause')
        self.player.tick()
        self.assertEqual(self.player.index, 0)
        self.player.control('play')
        self.assertEqual(self.engine.loads, ['A'])
        self.player.control('stop')
        self.player.tick()
        self.assertFalse(self.player.running)
        self.assertEqual(self.player.index, 0)

    def test_invalid_target_or_device_does_not_stop_current_song(self):
        self.player.control('play')
        self.engine.calls.clear()
        for request in ({'song_id': 'missing'}, {'song_id': ''}, {'song_id': None}, {'index': -1}, {'index': 99}, {'index': True}, {'index': 1, 'device': 100}):
            with self.assertRaises(ValueError):
                self.player.control('play', request)
        self.assertTrue(self.engine.playing)
        self.assertFalse(any(call['action'] == 'stop' for call in self.engine.calls))
        self.assertEqual(self.engine.loads, ['A'])

    def test_restart_restores_queue_without_autoplay(self):
        self.player.control('play', {'index': 1})
        self.engine.calls.clear()
        restored = self.make_player()
        self.assertEqual(restored.song_ids, ['A', 'B', 'C'])
        self.assertEqual(restored.index, 1)
        self.assertFalse(restored.running)
        restored.tick()
        self.assertEqual(self.engine.calls, [])

    def test_disconnect_stops_and_reconnection_does_not_autoplay(self):
        self.player.control('play')
        self.engine.devices = []
        self.player.tick()
        self.assertFalse(self.player.running)
        self.assertIn('disconnected', self.player.error)
        self.engine.devices = [{'id': 50, 'stableName': 'Prodigy2'}]
        self.player.tick()
        self.assertFalse(self.engine.playing)
        self.player.control('play')
        self.assertEqual(self.player.device_id, 50)
        self.assertTrue(self.player.running)

    def test_remove_and_move_keep_current_entry_identity(self):
        self.player.control('play', {'index': 1})
        self.player.mutate({'action': 'move', 'from': 0, 'to': 2})
        self.assertEqual(self.player.song_ids, ['B', 'C', 'A'])
        self.assertEqual(self.player.index, 0)
        self.assertTrue(self.player.running)
        self.player.mutate({'action': 'move', 'from': 0, 'to': 1})
        self.assertEqual(self.player.index, 1)
        self.player.mutate({'action': 'remove', 'index': 0})
        self.assertEqual(self.player.index, 0)
        self.assertTrue(self.player.running)
        self.player.mutate({'action': 'remove', 'index': 0})
        self.assertFalse(self.player.running)
        self.assertFalse(self.engine.playing)
        self.assertEqual(self.player.song_ids, ['A'])

    def test_duplicates_and_bounds(self):
        self.player.mutate({'action': 'replace', 'song_ids': ['A', 'A', 'B']})
        self.player.control('play', {'index': 1})
        self.player.mutate({'action': 'move', 'from': 0, 'to': 2})
        self.assertEqual(self.player.index, 0)
        self.assertEqual(self.player.song_ids, ['A', 'B', 'A'])
        with self.assertRaises(ValueError):
            self.player.mutate({'action': 'replace', 'song_ids': ['A'] * 501})
        self.assertTrue(self.player.running)
        self.player.mutate({'action': 'clear'})
        self.assertEqual(self.player.song_ids, [])
        self.assertFalse(self.player.running)
        self.player.control('play', {'song_id': 'C'})
        self.assertEqual(self.player.song_ids, ['C'])

    def test_tick_load_failure_is_visible_and_does_not_repeat(self):
        self.player.control('play')
        self.engine.fail_load = 'B'
        self.engine.playing = False
        self.player.tick()
        self.assertFalse(self.player.running)
        self.assertEqual(self.player.error, 'Load failed')
        count = len(self.engine.calls)
        self.player.tick()
        self.assertEqual(len(self.engine.calls), count)

    def test_saved_mixed_midi_is_allowed_for_queue_and_playback(self):
        self.library.songs.add('Mixed')
        self.library.incompatible.add('Mixed')
        self.player.control('play')
        self.player.mutate({'action': 'add', 'song_id': 'Mixed'})
        self.assertEqual(self.player.song_ids, ['A', 'B', 'C', 'Mixed'])
        self.player.mutate({'action': 'replace', 'song_ids': ['A', 'Mixed']})
        self.player.mutate({'action': 'play', 'song_id': 'Mixed'})
        self.assertEqual(self.engine.song, 'Mixed')
        self.assertTrue(self.engine.playing)
        self.library.settings['queue'] = {'song_ids': ['A', 'Mixed', 'B'], 'index': 1}
        restored = self.make_player()
        self.assertEqual(restored.song_ids, ['A', 'Mixed', 'B'])
        self.assertEqual(restored.index, 1)
        self.assertFalse(restored.running)

    def test_delivery_failure_stops_without_advancing(self):
        self.player.control('play')
        self.engine.delivery_error = 'MIDI delivery failed'
        self.engine.playing = False
        self.player.tick()
        self.assertFalse(self.player.running)
        self.assertEqual(self.player.index, 0)
        self.assertEqual(self.player.error, 'MIDI delivery failed')
        self.assertEqual(self.engine.loads, ['A'])

    def test_explicit_next_previous(self):
        self.player.mutate({'action': 'next'})
        self.assertEqual(self.engine.song, 'B')
        self.player.mutate({'action': 'previous'})
        self.assertEqual(self.engine.song, 'A')
        with self.assertRaises(ValueError):
            self.player.mutate({'action': 'previous'})


if __name__ == '__main__':
    unittest.main()

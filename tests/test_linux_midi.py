"""Deterministic Linux transport tests without ALSA, Bluetooth hardware or a piano."""
import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'vendor')]
import mido
spec = importlib.util.spec_from_file_location('midi_linux', ROOT / 'native/midi_linux.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Port:
    def __init__(self):
        self.messages, self.closed, self.fail = [], False, False
    def send(self, message):
        if self.fail:
            raise OSError('USB cable disconnected')
        self.messages.append(message.copy())
    def close(self):
        self.closed = True


class Backend:
    def __init__(self):
        self.names = ['Prodigy:Prodigy MIDI 24:0']
        self.ports = []
    def get_output_names(self):
        return list(self.names)
    def open_output(self, name):
        port = Port()
        self.ports.append(port)
        return port


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.backend, self.now = Backend(), 0.0
        self.engine = bridge.MidiEngine(backend=self.backend, clock=lambda: self.now, start_thread=False)
        self.identity = self.engine.devices()[0]['id']
        file = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        file.tracks.append(track)
        track.extend([mido.MetaMessage('set_tempo', tempo=500000),
                      mido.Message('program_change', program=0),
                      mido.Message('control_change', control=7, value=127),
                      mido.Message('sysex', data=[0x7d, 1, 2]),
                      mido.Message('note_on', note=60, velocity=37),
                      mido.Message('note_off', note=60, time=480),
                      mido.MetaMessage('set_tempo', tempo=1000000),
                      mido.Message('note_on', note=64, velocity=81, time=480),
                      mido.Message('note_off', note=64, time=480),
                      mido.MetaMessage('end_of_track')])
        self.path = Path(self.temp.name) / 'test.mid'
        file.save(self.path)
        self.assertTrue(self.engine.command({'action': 'load', 'path': str(self.path)})['ok'])

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def play(self):
        result = self.engine.command({'action': 'play', 'device': self.identity})
        self.assertTrue(result['ok'], result)
        return self.backend.ports[-1]

    def test_repeated_play_is_idempotent_and_invalid_input_keeps_playing(self):
        port = self.play()
        self.now = .2
        self.assertAlmostEqual(self.engine.command({'action': 'play', 'device': self.identity})['seconds'], .2)
        self.assertFalse(self.engine.command({'action': 'volume', 'value': 101})['ok'])
        self.assertTrue(self.engine.status()['playing'])
        self.assertFalse(self.engine.command({'action': 'seek', 'seconds': -1})['ok'])
        self.assertTrue(self.engine.status()['playing'])

    def test_seek_and_resume_retrigger_held_note_with_original_velocity(self):
        port = self.play()
        self.engine.tick()
        self.engine.command({'action': 'seek', 'seconds': .2})
        self.assertEqual([(msg.note, msg.velocity) for msg in port.messages if msg.type == 'note_on'], [(60, 37), (60, 37)])
        self.engine.command({'action': 'pause'})
        before = len(port.messages)
        self.engine.command({'action': 'seek', 'seconds': .3})
        self.assertFalse(any(msg.type == 'note_on' for msg in port.messages[before:]))
        self.engine.command({'action': 'play', 'device': self.identity})
        self.assertEqual([msg.velocity for msg in port.messages if msg.type == 'note_on'], [37, 37, 37])

    def test_tempo_duration_and_original_velocities(self):
        self.assertEqual(self.engine.status()['duration_seconds'], 2.5)
        self.assertEqual(self.engine.status()['length'], 3)
        port = self.play()
        self.engine.tick()
        notes = [msg for msg in port.messages if msg.type == 'note_on']
        self.assertEqual([(msg.note, msg.velocity) for msg in notes], [(60, 37)])
        self.now = .49
        self.engine.tick()
        self.assertFalse(any(msg.type == 'note_off' and msg.note == 60 for msg in port.messages))
        self.now = .5
        self.engine.tick()
        self.assertTrue(any(msg.type == 'note_off' and msg.note == 60 for msg in port.messages))
        self.now = 1.5
        self.engine.tick()
        self.assertAlmostEqual(self.engine.status()['beat'], 2)
        self.assertEqual([msg.velocity for msg in port.messages if msg.type == 'note_on'], [37, 81])

    def test_sysex_stripped_and_file_volume_overridden(self):
        port = self.play()
        self.engine.tick()
        self.assertFalse(any(msg.type == 'sysex' for msg in port.messages))
        self.assertTrue(all(msg.value == 25 for msg in port.messages if msg.type == 'control_change' and msg.control == 7))
        self.assertTrue(any(msg.type == 'control_change' and msg.control == 39 and msg.value == 0 for msg in port.messages))

    def test_pause_stop_release_keys_and_do_not_finish_song(self):
        port = self.play()
        self.engine.tick()
        self.now = .2
        result = self.engine.command({'action': 'pause'})
        self.assertFalse(result['playing'])
        self.assertTrue(result['paused'])
        self.assertAlmostEqual(result['seconds'], .2)
        self.assertTrue(any(msg.type == 'note_off' and msg.note == 60 for msg in port.messages))
        self.engine.command({'action': 'stop'})
        self.assertEqual(self.engine.status()['seconds'], 0)
        self.assertFalse(self.engine.status()['paused'])

    def test_seek_preserves_playing_and_paused_states(self):
        self.play()
        result = self.engine.command({'action': 'seek', 'seconds': 1.7})
        self.assertTrue(result['playing'])
        self.assertAlmostEqual(result['seconds'], 1.7)
        self.engine.command({'action': 'pause'})
        result = self.engine.command({'action': 'seek', 'seconds': .3})
        self.assertTrue(result['paused'])
        self.assertFalse(result['playing'])
        self.assertAlmostEqual(result['seconds'], .3)
        for value in (-1, float('nan'), True, 'a'):
            self.assertFalse(self.engine.command({'action': 'seek', 'seconds': value})['ok'])

    def test_natural_finish_resets_position_and_releases_notes(self):
        self.play()
        self.engine.tick()
        self.now = 3
        self.engine.tick()
        result = self.engine.status()
        self.assertFalse(result['playing'])
        self.assertFalse(result['paused'])
        self.assertEqual(result['seconds'], 0)
        self.assertEqual(result['playback_error'], '')

    def test_write_failure_stops_playback_and_reports_error(self):
        port = self.play()
        port.fail = True
        self.engine.tick()
        result = self.engine.status()
        self.assertFalse(result['playing'])
        self.assertIn('disconnected', result['playback_error'])

    def test_removed_device_stops_without_auto_play(self):
        self.play()
        self.backend.names = []
        result = self.engine.status()
        self.assertFalse(result['playing'])
        self.assertIn('disconnected', result['playback_error'])
        self.backend.names = ['Prodigy:Prodigy MIDI 99:1']
        self.assertEqual(self.engine.devices()[0]['id'], self.identity)
        self.assertFalse(self.engine.status()['playing'])
        self.assertTrue(self.backend.ports[0].closed)
        self.assertTrue(self.engine.command({'action': 'play', 'device': self.identity})['ok'])
        self.assertEqual(len(self.backend.ports), 2)

    def test_connect_reconnect_is_quiet_and_stable_port_names(self):
        result = self.engine.command({'action': 'connect', 'name': 'Prodigy:Prodigy MIDI'})
        self.assertTrue(result['ok'])
        self.assertFalse(result['playing'])
        self.play()
        result = self.engine.command({'action': 'reconnect', 'name': 'Prodigy:Prodigy MIDI'})
        self.assertFalse(result['playing'])
        self.assertEqual(result['seconds'], 0)

    def test_mute_suppresses_note_on_without_scaling(self):
        port = self.play()
        self.assertTrue(self.engine.command({'action': 'volume', 'value': 0})['ok'])
        self.engine.tick()
        self.assertFalse(any(msg.type == 'note_on' and msg.velocity for msg in port.messages))
        self.assertFalse(self.engine.command({'action': 'volume', 'value': 101})['ok'])


class BluetoothTests(unittest.TestCase):
    def test_packet_timestamp_wrap_and_safe_payload_size(self):
        messages = [mido.Message('note_on', channel=2, note=60 + i, velocity=45) for i in range(12)]
        packets = bridge.ble_packets(messages, 8191)
        self.assertTrue(all(len(packet) <= 20 and packet[0] == 0xbf for packet in packets))
        self.assertEqual(packets[0][1:5], bytes([0xff, 0x92, 60, 45]))
        self.assertEqual(bridge.ble_packets(messages[:1], 8192)[0], bytes([0x80, 0x80, 0x92, 60, 45]))
        self.assertEqual(bridge.ble_packets([mido.Message('sysex', data=[1, 2])], 0), [])

    def test_ble_connect_discovers_characteristic_and_writes_packets(self):
        device = types.SimpleNamespace(address='AA:BB:CC:DD:EE:FF', name='Prodigy2')
        adv = types.SimpleNamespace(local_name='Prodigy2', service_uuids=[bridge.MIDI_SERVICE])
        characteristic = types.SimpleNamespace(properties=['read', 'notify', 'write-without-response'])
        class Scanner:
            @classmethod
            async def discover(cls, **kwargs):
                return {device.address: (device, adv)}
        clients = []
        class Client:
            def __init__(self, found, **kwargs):
                self.is_connected = False
                self.services = types.SimpleNamespace(get_characteristic=lambda uuid: characteristic if uuid == bridge.MIDI_CHARACTERISTIC else None)
                self.writes, self.notified = [], False
                self.disconnected_callback = kwargs['disconnected_callback']
                clients.append(self)
            async def connect(self):
                self.is_connected = True
            async def disconnect(self):
                self.is_connected = False
            async def start_notify(self, found, callback):
                self.notified = True
            async def read_gatt_char(self, found):
                return b''
            async def write_gatt_char(self, uuid, packet, response):
                self.writes.append((uuid, packet, response))
        fake = types.SimpleNamespace(BleakClient=Client, BleakScanner=Scanner)
        with patch.dict(sys.modules, {'bleak': fake}):
            bluetooth = bridge.BluetoothMidi()
            try:
                bluetooth.connect('Prodigy2 MIDI')
                for _ in range(100):
                    if bluetooth.snapshot()[1]['state'] == 'connected':
                        break
                    time.sleep(.01)
                devices, state = bluetooth.snapshot()
                self.assertEqual(state['state'], 'connected', state)
                self.assertTrue(devices[0]['connected'])
                self.assertTrue(clients[-1].notified)
                bluetooth.send_many([mido.Message('note_on', note=60, velocity=45)])
                self.assertEqual(clients[-1].writes[0][0], bridge.MIDI_CHARACTERISTIC)
                self.assertFalse(clients[-1].writes[0][2])
                self.assertEqual(clients[-1].writes[0][1][-3:], bytes([0x90, 60, 45]))
                clients[-1].is_connected = False
                clients[-1].disconnected_callback(clients[-1])
                self.assertFalse(bluetooth.snapshot()[0][0]['connected'])
                bluetooth.last_scan = float('-inf')
                bluetooth.scan()
                for _ in range(100):
                    if bluetooth.snapshot()[1]['state'] == 'connected':
                        break
                    time.sleep(.01)
                self.assertEqual(bluetooth.snapshot()[1]['state'], 'connected')
                self.assertEqual(len(clients), 2)
            finally:
                bluetooth.close()


if __name__ == '__main__':
    unittest.main()

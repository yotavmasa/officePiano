#!/usr/bin/env python3
"""JSON MIDI bridge for Raspberry Pi: ALSA/USB output and direct BLE MIDI."""
import asyncio
import bisect
import json
import math
from pathlib import Path
import re
import sys
import threading
import time
import zlib

ROOT = Path(__file__).resolve().parent.parent
if sys.platform == 'darwin' and sys.prefix == sys.base_prefix:
    sys.path.insert(0, str(ROOT / 'vendor'))
import mido

MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700'
MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3'


def stable_name(name):
    return re.sub(r'\s+\d+:\d+$', '', str(name)).strip()


def normalized(name):
    return stable_name(name).lower().replace(' bluetooth', '').replace(' midi', '').strip()


def device_id(kind, name):
    return (zlib.crc32((kind + ':' + name).encode()) & 0x7fffffff) or 1


def ble_packets(messages, milliseconds):
    """BLE MIDI 13-bit timestamps; conservative 20-byte ATT payloads, full status bytes."""
    timestamp = int(milliseconds) & 0x1fff
    header, low = 0x80 | (timestamp >> 7), 0x80 | (timestamp & 0x7f)
    packets, packet = [], bytearray([header])
    for message in messages:
        if message.is_meta or message.type == 'sysex':
            continue
        event = bytes([low] + message.bytes())
        if len(packet) + len(event) > 20:
            packets.append(bytes(packet))
            packet = bytearray([header])
        packet.extend(event)
    if len(packet) > 1:
        packets.append(bytes(packet))
    return packets


class BluetoothMidi:
    def __init__(self):
        self.lock = threading.RLock()
        self.devices = {}
        self.client = None
        self.selected = None
        self.preferred = ''
        self.state, self.message = 'idle', 'Scanning for Bluetooth MIDI pianos…'
        self.loop = asyncio.new_event_loop()
        self.closed = False
        self.task = None
        self.generation = 0
        self.last_scan = float('-inf')
        self.thread = threading.Thread(target=self._run, daemon=True, name='ble-midi')
        self.thread.start()
        self.scan()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()
        pending = asyncio.all_tasks(self.loop)
        for task in pending:
            task.cancel()
        if pending:
            self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self.loop.close()

    def _submit(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop)

    def scan(self):
        with self.lock:
            if self.closed or self.state == 'connected' or self.task and not self.task.done() or time.monotonic() - self.last_scan < 15:
                return
            self.last_scan = time.monotonic()
            self.task = self._submit(self._scan())

    async def _scan(self):
        try:
            from bleak import BleakScanner
            found = await BleakScanner.discover(timeout=5, return_adv=True)
            with self.lock:
                self.devices = {address: (device, adv.local_name or device.name or address)
                                for address, (device, adv) in found.items()
                                if MIDI_SERVICE in [uuid.lower() for uuid in adv.service_uuids]}
                if self.state not in ('connected', 'connecting'):
                    self.message = 'Choose a Bluetooth MIDI piano.' if self.devices else 'No Bluetooth MIDI piano found. Turn the piano on, then refresh.'
            with self.lock:
                preferred = self.preferred
                retry = preferred and self.state not in ('connected', 'connecting') and any(normalized(name) == normalized(preferred) for _, name in self.devices.values())
                if retry:
                    self.generation += 1
                    generation = self.generation
                    self.state, self.message = 'connecting', 'Restoring the piano Bluetooth connection…'
            if retry:
                await self._connect(preferred, generation)
        except Exception as error:
            with self.lock:
                if self.state != 'connected':
                    self.state, self.message = 'unavailable', 'Bluetooth scan failed: ' + str(error)

    def snapshot(self):
        with self.lock:
            devices = [{'id': device_id('ble', address), 'name': name, 'stableName': name,
                        'connected': self.state == 'connected' and self.selected == address, 'transport': 'bluetooth'}
                       for address, (_, name) in self.devices.items()]
            return devices, {'state': self.state, 'message': self.message, 'preferred': self.preferred}

    def connect(self, name):
        with self.lock:
            self.preferred = name
            self.generation += 1
            generation = self.generation
            self.state, self.message = 'connecting', 'Connecting to ' + name + '…'
            if self.task and not self.task.done():
                self.task.cancel()
            self.task = self._submit(self._connect(name, generation))

    async def _connect(self, name, generation):
        client = None
        try:
            from bleak import BleakClient, BleakScanner
            if self.client:
                await self.client.disconnect()
                self.client = None
            with self.lock:
                matches = [(address, device) for address, (device, found_name) in self.devices.items()
                           if normalized(found_name) == normalized(name)]
            if len(matches) != 1:
                found = await BleakScanner.discover(timeout=6, return_adv=True)
                with self.lock:
                    self.devices = {address: (device, adv.local_name or device.name or address)
                                    for address, (device, adv) in found.items()
                                    if MIDI_SERVICE in [uuid.lower() for uuid in adv.service_uuids]}
                    matches = [(address, device) for address, (device, found_name) in self.devices.items()
                               if normalized(found_name) == normalized(name)]
            if len(matches) != 1:
                raise ValueError('Piano not found or name is ambiguous. Refresh devices and choose the piano.')
            address, device = matches[0]
            def disconnected(_):
                with self.lock:
                    if self.generation == generation:
                        self.state, self.message = 'disconnected', 'Bluetooth piano disconnected. Reconnect it, then press Play.'
            client = BleakClient(device, disconnected_callback=disconnected, timeout=15)
            await client.connect()
            characteristic = client.services.get_characteristic(MIDI_CHARACTERISTIC)
            if characteristic is None or not {'write-without-response', 'notify'}.issubset(characteristic.properties):
                raise ValueError('The piano does not expose a writable Bluetooth MIDI characteristic.')
            # BLE MIDI requires notification subscription even for an output-only central.
            await client.start_notify(characteristic, lambda _sender, _data: None)
            if 'read' in characteristic.properties:
                await client.read_gatt_char(characteristic)
            with self.lock:
                if generation != self.generation:
                    await client.disconnect()
                    return
                self.client, self.selected = client, address
                self.state, self.message = 'connected', 'Bluetooth MIDI connected. Press Play to start.'
        except asyncio.CancelledError:
            if client and client.is_connected:
                await client.disconnect()
            raise
        except Exception as error:
            if client and client.is_connected:
                await client.disconnect()
            with self.lock:
                if generation == self.generation:
                    self.state, self.message = 'error', 'Bluetooth connection failed: ' + str(error)

    def send_many(self, messages):
        async def send():
            if not self.client or not self.client.is_connected:
                raise ValueError('Bluetooth piano disconnected. Reconnect it, then press Play.')
            for packet in ble_packets(messages, time.monotonic() * 1000):
                await self.client.write_gatt_char(MIDI_CHARACTERISTIC, packet, response=False)
        future = self._submit(send())
        try:
            future.result(timeout=3)
        except Exception as error:
            future.cancel()
            with self.lock:
                self.state, self.message = 'error', 'Bluetooth MIDI delivery failed: ' + (str(error) or 'write timed out')
            raise

    def connected(self, identity):
        with self.lock:
            return self.state == 'connected' and self.selected is not None and identity == device_id('ble', self.selected)

    def close(self):
        with self.lock:
            self.closed = True
            if self.task:
                self.task.cancel()
        async def disconnect():
            if self.client and self.client.is_connected:
                await self.client.disconnect()
        try:
            self._submit(disconnect()).result(timeout=3)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=3)


class MidiEngine:
    def __init__(self, backend=None, bluetooth=None, clock=time.monotonic, start_thread=True):
        self.backend = backend or mido.Backend('mido.backends.rtmidi/LINUX_ALSA')
        self.bluetooth = bluetooth
        self.clock = clock
        self.lock = threading.RLock()
        self.port = None
        self.selected = None
        self.events, self.times, self.beat_events = [], [], [(0.0, 0.0, 500000)]
        self.duration, self.length, self.seconds = 0.0, 0.0, 0.0
        self.started = 0.0
        self.index = 0
        self.loaded, self.playing, self.paused = False, False, False
        self.volume = 20
        self.error, self.device_error = '', ''
        self.active_notes = set()
        self.shutdown_event = threading.Event()
        if start_thread:
            threading.Thread(target=self._schedule, daemon=True, name='midi-playback').start()

    def devices(self):
        result = []
        try:
            names = self.backend.get_output_names()
            self.device_error = ''
            for name in names:
                stable = stable_name(name)
                result.append({'id': device_id('alsa', stable), 'name': name, 'stableName': stable, 'connected': True, 'transport': 'usb'})
        except Exception as error:
            self.device_error = 'ALSA MIDI unavailable: ' + str(error)
        if self.bluetooth:
            result.extend(self.bluetooth.snapshot()[0])
        return result

    def _position(self):
        return min(self.duration, max(0.0, self.clock() - self.started)) if self.playing else self.seconds

    def _beat(self, seconds):
        times = [item[0] for item in self.beat_events]
        index = max(0, bisect.bisect_right(times, seconds) - 1)
        stamp, beat, tempo = self.beat_events[index]
        return min(self.length, beat + (seconds - stamp) * 1000000 / tempo)

    def status(self):
        with self.lock:
            devices = self.devices()
            if self.playing and not any(item['id'] == self.selected and item.get('connected', True) for item in devices):
                self._failed('Piano disconnected. Reconnect it, then press Play.')
                if self.port:
                    try:
                        self.port.close()
                    except Exception:
                        pass
                    self.port = None
                self.selected = None
            bluetooth = self.bluetooth.snapshot()[1] if self.bluetooth else {'state': 'unavailable', 'message': 'Bluetooth MIDI support is not installed. Use USB or install bleak.'}
            if self.device_error and bluetooth['state'] == 'unavailable':
                bluetooth = dict(bluetooth, message=bluetooth['message'] + ' ' + self.device_error)
            seconds = self._position()
            return {'ok': True, 'playing': self.playing, 'paused': self.paused, 'seconds': seconds,
                    'duration_seconds': self.duration, 'beat': self._beat(seconds), 'length': self.length,
                    'devices': devices, 'volume': self.volume, 'bluetooth': bluetooth, 'playback_error': self.error}

    def _failed(self, error):
        self.seconds = self._position()
        self.playing, self.paused = False, False
        self.error = str(error) or 'MIDI delivery failed. Reconnect the piano, then press Play.'

    def _send(self, messages):
        if not messages or self.selected is None:
            return
        try:
            if self.port:
                for message in messages:
                    self.port.send(message)
            elif self.bluetooth and self.bluetooth.connected(self.selected):
                self.bluetooth.send_many(messages)
            else:
                raise ValueError('Piano disconnected. Reconnect it, then press Play.')
        except Exception as error:
            self._failed(error)
            raise
        for message in messages:
            if message.type == 'note_on' and message.velocity:
                self.active_notes.add((message.channel, message.note))
            elif message.type in ('note_on', 'note_off'):
                self.active_notes.discard((message.channel, message.note))

    def _panic(self):
        messages = [mido.Message('note_off', channel=channel, note=note, velocity=0) for channel, note in sorted(self.active_notes)]
        for channel in range(16):
            messages += [mido.Message('control_change', channel=channel, control=control, value=0) for control in (64, 66, 67, 120, 123)]
        try:
            self._send(messages)
        except Exception as error:
            self.error = str(error)
        self.active_notes.clear()

    def _volume(self):
        value = (self.volume * 127 + 50) // 100
        messages = []
        for channel in range(16):
            messages += [mido.Message('control_change', channel=channel, control=7, value=value), mido.Message('control_change', channel=channel, control=39, value=0)]
        self._send(messages)

    def _choose(self, identity):
        if type(identity) is not int:
            raise ValueError('Choose a connected piano.')
        matches = [item for item in self.devices() if item['id'] == identity]
        if len(matches) > 1:
            raise ValueError('More than one MIDI port has this name. Disconnect the unused device first.')
        device = matches[0] if matches else None
        if not device or not device.get('connected', True):
            raise ValueError('Piano disconnected. Connect it, then press Play.')
        if self.selected == identity:
            return
        self.seconds = self.seconds if self.paused else 0.0
        self.playing = False
        self._panic()
        if self.port:
            self.port.close()
            self.port = None
        self.selected = identity
        if device['transport'] == 'usb':
            self.port = self.backend.open_output(device['name'])
        self.error = ''

    def _restore_controls(self, seconds):
        last = {}
        for stamp, message in self.events:
            if stamp >= seconds:
                break
            if message.type in ('program_change', 'control_change', 'pitchwheel', 'aftertouch'):
                key = (message.type, message.channel, getattr(message, 'control', None))
                last[key] = message
        self._send([self._message(message) for message in last.values()])
        self._volume()

    def _restore_notes(self, seconds):
        if self.volume == 0:
            return
        held = {}
        for stamp, message in self.events:
            if stamp >= seconds:
                break
            if message.type == 'note_on' and message.velocity:
                held[(message.channel, message.note)] = message
            elif message.type in ('note_on', 'note_off'):
                held.pop((message.channel, message.note), None)
        self._send([message.copy(time=0) for message in held.values()])

    def _message(self, message):
        if message.type == 'control_change' and message.control in (7, 39):
            return message.copy(value=(self.volume * 127 + 50) // 100 if message.control == 7 else 0)
        return message.copy(time=0)

    def tick(self):
        with self.lock:
            if not self.playing:
                return
            now = self._position()
            due = []
            while self.index < len(self.events) and self.events[self.index][0] <= now:
                _, message = self.events[self.index]
                self.index += 1
                if not (self.volume == 0 and message.type == 'note_on' and message.velocity):
                    due.append(self._message(message))
            try:
                self._send(due)
                if now >= self.duration:
                    self._panic()
                    self.playing, self.paused, self.seconds = False, False, 0.0
                    self.index = 0
            except Exception as error:
                self._failed(error)

    def _schedule(self):
        while not self.shutdown_event.wait(.002):
            self.tick()

    def command(self, request):
        with self.lock:
            try:
                if not isinstance(request, dict):
                    raise ValueError('Invalid request')
                action = request.get('action')
                if action == 'load':
                    path = request.get('path')
                    if not isinstance(path, str):
                        raise ValueError('Choose a MIDI file first.')
                    file = mido.MidiFile(path)
                    if file.type == 2:
                        raise ValueError('Asynchronous MIDI tracks are not supported.')
                    events, tempo, seconds, beat = [], 500000, 0.0, 0.0
                    beat_events = [(0.0, 0.0, tempo)]
                    for message in mido.merge_tracks(file.tracks):
                        seconds += mido.tick2second(message.time, file.ticks_per_beat, tempo)
                        beat += message.time / file.ticks_per_beat
                        if message.type == 'set_tempo':
                            tempo = message.tempo
                            beat_events.append((seconds, beat, tempo))
                        elif not message.is_meta and message.type != 'sysex':
                            events.append((seconds, message.copy(time=0)))
                    self.playing = False
                    self._panic()
                    self.events, self.times, self.beat_events = events, [stamp for stamp, _ in events], beat_events
                    self.duration, self.length, self.seconds, self.index = seconds, beat, 0.0, 0
                    self.loaded, self.paused, self.error = True, False, ''
                elif action in ('connect', 'reconnect'):
                    name = request.get('name')
                    if not isinstance(name, str) or not name.strip():
                        raise ValueError('Choose the piano first.')
                    self.playing = False
                    self._panic()
                    self.seconds, self.paused = 0.0, False
                    if self.port:
                        self.port.close()
                        self.port = None
                    self.selected = None
                    matches = [item for item in self.devices() if item['transport'] == 'usb' and normalized(item['stableName']) == normalized(name)]
                    if len(matches) == 1:
                        self._choose(matches[0]['id'])
                    elif self.bluetooth:
                        self.bluetooth.connect(name.strip())
                    else:
                        raise ValueError('Piano not found. Attach USB MIDI or install Bluetooth MIDI support.')
                elif action == 'play':
                    if not self.loaded:
                        raise ValueError('Choose a MIDI file first.')
                    self._choose(request.get('device', self.selected))
                    if self.playing:
                        return self.status()
                    if self.seconds >= self.duration:
                        self.seconds = 0.0
                    self.index = bisect.bisect_left(self.times, self.seconds)
                    self._restore_controls(self.seconds)
                    self._restore_notes(self.seconds)
                    self.started = self.clock() - self.seconds
                    self.playing, self.paused, self.error = True, False, ''
                elif action == 'seek':
                    seconds = request.get('seconds')
                    if not self.loaded or isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0:
                        raise ValueError('Choose a valid song time.')
                    playing = self.playing
                    self.playing = False
                    self._panic()
                    self.seconds = min(self.duration, float(seconds))
                    self.index = bisect.bisect_left(self.times, self.seconds)
                    if playing:
                        self._restore_controls(self.seconds)
                        self._restore_notes(self.seconds)
                    self.started = self.clock() - self.seconds
                    self.playing, self.paused = playing, not playing
                elif action == 'pause':
                    if self.playing:
                        self.seconds = self._position()
                        self.playing, self.paused = False, True
                        self._panic()
                elif action == 'stop':
                    self.playing, self.paused, self.seconds, self.index = False, False, 0.0, 0
                    self._panic()
                elif action == 'volume':
                    value = request.get('value')
                    if type(value) is not int or not 0 <= value <= 100:
                        raise ValueError('Volume must be between 0 and 100.')
                    if request.get('device'):
                        self._choose(request['device'])
                    self.volume = value
                    self._volume()
                    if value == 0:
                        self._panic()
                elif action == 'note':
                    pitch, velocity, on = request.get('pitch'), request.get('velocity'), request.get('on')
                    if type(pitch) is not int or not 21 <= pitch <= 108 or type(velocity) is not int or not 1 <= velocity <= 127 or type(on) is not bool:
                        raise ValueError('Choose a valid piano key.')
                    if self.playing:
                        raise ValueError('Pause the song to play keys on the piano.')
                    self._choose(request.get('device'))
                    if not on:
                        self._send([mido.Message('note_off', note=pitch, velocity=0)])
                    elif self.volume:
                        self._send([mido.Message('note_on', note=pitch, velocity=velocity)])
                elif action == 'status':
                    if self.bluetooth:
                        self.bluetooth.scan()
                else:
                    raise ValueError('Invalid MIDI command.')
                return self.status()
            except Exception as error:
                return {'ok': False, 'error': str(error)}

    def close(self):
        self.shutdown_event.set()
        with self.lock:
            self.playing = False
            self._panic()
            if self.port:
                self.port.close()
        if self.bluetooth:
            self.bluetooth.close()


def main():
    bluetooth = None
    try:
        import bleak
        bluetooth = BluetoothMidi()
    except ImportError:
        pass
    engine = MidiEngine(bluetooth=bluetooth)
    try:
        for line in sys.stdin:
            try:
                result = engine.command(json.loads(line))
            except Exception as error:
                result = {'ok': False, 'error': str(error)}
            print(json.dumps(result), flush=True)
    finally:
        engine.close()


if __name__ == '__main__':
    main()

"""A persistent queue; the server serializes calls with its MIDI player lock."""


class Playback:
    MAX_QUEUE = 500

    def __init__(self, library, send, load, current_song):
        self.library, self.send, self.load, self.current_song = library, send, load, current_song
        self.song_ids, self.index = [], 0
        self.running, self.device_id, self.error = False, None, ''
        saved = library.get_setting('queue', {})
        if isinstance(saved, dict) and isinstance(saved.get('song_ids'), list):
            original_index = saved.get('index', 0)
            if type(original_index) is not int:
                original_index = 0
            for position, song_id in enumerate(saved['song_ids'][:self.MAX_QUEUE]):
                try:
                    library.playable(song_id)
                except ValueError:
                    continue
                if position < original_index:
                    self.index += 1
                self.song_ids.append(song_id)
            self.index = min(self.index, max(0, len(self.song_ids) - 1))

    def snapshot(self):
        return {'song_ids': list(self.song_ids), 'index': self.index,
                'current_song_id': self.song_ids[self.index] if self.song_ids else '',
                'running': self.running, 'error': self.error}

    def _save(self):
        self.library.set_setting('queue', {'song_ids': self.song_ids, 'index': self.index})

    def _send(self, request):
        result = self.send(request)
        if not isinstance(result, dict) or not result.get('ok'):
            raise ValueError(result.get('error', 'The piano command failed.') if isinstance(result, dict) else 'The piano command failed.')
        return result

    @staticmethod
    def _normalized(name):
        return str(name).lower().replace(' bluetooth', '').replace(' midi', '').strip()

    def _device(self, status, requested=None):
        devices = status.get('devices', [])
        if requested is not None:
            if type(requested) is not int:
                raise ValueError('Choose a connected piano.')
            for device in devices:
                if device.get('id') == requested:
                    return requested
        else:
            preferred = self._normalized(self.library.get_setting('preferred_device', ''))
            if preferred:
                for device in devices:
                    if self._normalized(device.get('stableName', device.get('name', ''))) == preferred:
                        return device['id']
        raise ValueError('Your piano is disconnected. Connect it before playing the queue.')

    def _position(self, value):
        if type(value) is not int or not 0 <= value < len(self.song_ids):
            raise ValueError('Choose a song in the queue.')
        return value

    def _start(self, index, device=None):
        index = self._position(index)
        song_id = self.song_ids[index]
        self.library.playable(song_id)
        status = self._send({'action': 'status'})
        selected_device = self._device(status, device)
        # Device validation precedes stop/load so a bad selection cannot interrupt music.
        if self.current_song() != song_id or index != self.index:
            self.running = False
            self._send({'action': 'stop'})
            self.load(song_id)
        self.running = False
        result = self._send({'action': 'play', 'device': selected_device})
        self.index, self.device_id, self.running, self.error = index, selected_device, True, ''
        self._save()
        return result

    def control(self, action, request=None):
        request = request or {}
        if action == 'play':
            if 'song_id' in request:
                self.library.playable(request['song_id'])
            song_id = request.get('song_id')
            if song_id is None and not self.song_ids:
                song_id = self.current_song()
            if song_id:
                self.library.playable(song_id)
                if song_id in self.song_ids:
                    index = self.song_ids.index(song_id)
                else:
                    if len(self.song_ids) >= self.MAX_QUEUE:
                        raise ValueError('The queue can hold up to 500 songs.')
                    # Check the device before appending a new song to the saved queue.
                    status = self._send({'action': 'status'})
                    self._device(status, request.get('device'))
                    self.song_ids.append(song_id)
                    index = len(self.song_ids) - 1
            else:
                index = request.get('index', self.index)
            return self._start(index, request.get('device'))
        if action not in ('pause', 'stop'):
            raise ValueError('Invalid queue playback command.')
        result = self._send({'action': action})
        self.running, self.error = False, ''
        return result

    def mutate(self, request):
        if not isinstance(request, dict):
            raise ValueError('Invalid queue command.')
        action = request.get('action')
        if action == 'play':
            self.control('play', request)
        elif action == 'add':
            song_id = request.get('song_id')
            self.library.playable(song_id)
            if len(self.song_ids) >= self.MAX_QUEUE:
                raise ValueError('The queue can hold up to 500 songs.')
            self.song_ids.append(song_id)
            self._save()
        elif action in ('next', 'previous'):
            target = self.index + (1 if action == 'next' else -1)
            if not 0 <= target < len(self.song_ids):
                raise ValueError('There is no next song.' if action == 'next' else 'There is no previous song.')
            self._start(target, request.get('device'))
        elif action == 'replace':
            songs = request.get('song_ids')
            if not isinstance(songs, list) or len(songs) > self.MAX_QUEUE:
                raise ValueError('Choose a queue of up to 500 saved songs.')
            for song_id in songs:
                self.library.playable(song_id)
            self.control('stop')
            self.song_ids, self.index = list(songs), 0
            self._save()
        elif action == 'clear':
            self.control('stop')
            self.song_ids, self.index = [], 0
            self._save()
        elif action == 'remove':
            position = self._position(request.get('index'))
            if position == self.index:
                self.control('stop')
            self.song_ids.pop(position)
            if position < self.index:
                self.index -= 1
            self.index = min(self.index, max(0, len(self.song_ids) - 1))
            self._save()
        elif action == 'move':
            if 'expected_song_ids' in request and request['expected_song_ids'] != self.song_ids:
                raise ValueError('The queue changed. Try moving the song again.')
            origin = self._position(request.get('from'))
            target = self._position(request.get('to'))
            song_id = self.song_ids.pop(origin)
            self.song_ids.insert(target, song_id)
            if self.index == origin:
                self.index = target
            elif origin < self.index <= target:
                self.index -= 1
            elif target <= self.index < origin:
                self.index += 1
            self._save()
        else:
            raise ValueError('Invalid queue command.')
        return self.snapshot()

    def forget(self, song_id):
        if self.current_song() == song_id:
            self.control('stop')
        removed_before = sum(identity == song_id for identity in self.song_ids[:self.index])
        self.song_ids = [identity for identity in self.song_ids if identity != song_id]
        self.index = min(max(0, self.index - removed_before), max(0, len(self.song_ids) - 1))
        self._save()

    def tick(self):
        if not self.running:
            return
        try:
            status = self._send({'action': 'status'})
            if status.get('playback_error'):
                self.running = False
                self.error = status['playback_error']
                self._send({'action': 'stop'})
                return
            if not any(device.get('id') == self.device_id for device in status.get('devices', [])):
                self.running = False
                self.error = 'Piano disconnected. Reconnect, then press Play to continue.'
                self._send({'action': 'stop'})
                return
            if self.current_song() != self.song_ids[self.index]:
                self.running = False
                return
            if status.get('paused'):
                self.running = False
            elif not status.get('playing'):
                self.running = False
                has_next = self.index + 1 < len(self.song_ids)
                self.song_ids.pop(self.index)
                self.index = min(self.index, max(0, len(self.song_ids) - 1))
                self._save()
                if has_next:
                    self._start(self.index, self.device_id)
        except Exception as exc:
            self.running = False
            self.error = str(exc) or 'The queue could not continue. Press Play to retry.'

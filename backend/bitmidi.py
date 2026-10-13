"""BitMidi's public API, with piano-only validation before showing results."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from .library import MAX_MIDI, parse_midi

BASE = 'https://bitmidi.com'
CACHE = OrderedDict()
SEARCH_CACHE = OrderedDict()
LOCK = threading.RLock()


def allowed_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ('bitmidi.com', 'www.bitmidi.com') or parts.port not in (None, 443) or parts.username or parts.password:
        raise ValueError('Choose a song from bitmidi.com.')
    return parts


class BitMidiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        allowed_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit=2 * 1024 * 1024):
    allowed_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'PianoRemote/2.0 (local piano-only MIDI player)'})
    try:
        with urllib.request.build_opener(BitMidiRedirect).open(request, timeout=12) as response:
            data = response.read(limit + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ValueError('BitMidi is unavailable right now. Try again, or upload a MIDI file.') from exc
    if len(data) > limit:
        raise ValueError('This BitMidi file is too large.')
    return data


def api(route, **params):
    try:
        result = json.loads(fetch(BASE + '/api/midi/' + route + '?' + urllib.parse.urlencode(params)))['result']
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (KeyError, TypeError, json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError('BitMidi returned an unexpected response. Try again later.') from exc


def slug_from_url(url):
    if not isinstance(url, str) or len(url) > 1000:
        raise ValueError('Choose a valid BitMidi song.')
    parts = allowed_url(url)
    if parts.query or parts.fragment or not re.fullmatch(r'/[a-z0-9][a-z0-9-]{0,400}', parts.path):
        raise ValueError('Choose a BitMidi song page, not an external download URL.')
    return parts.path[1:]


def checked_song(item, piano_only=True):
    slug = item.get('slug')
    name = item.get('name')
    identity = item.get('id')
    if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,400}', slug) or not isinstance(name, str) or not name.strip() or type(identity) is not int or identity <= 0:
        raise ValueError('BitMidi returned an invalid song.')
    with LOCK:
        if slug in CACHE:
            CACHE.move_to_end(slug)
            cached = CACHE[slug]
            if piano_only and cached[1]['piano_only'] is not True:
                raise ValueError(cached[1].get('reason', 'This MIDI is not piano-only.'))
            return cached
    data = fetch(BASE + '/uploads/' + str(identity) + '.mid', MAX_MIDI)
    metadata = parse_midi(data, piano_only=piano_only)
    song = {'name': name[:200], 'url': BASE + '/' + slug, 'piano_only': metadata.get('piano_only', True), 'reason': metadata.get('compatibility_reason', ''),
            'notes': metadata['notes'], 'duration_seconds': metadata['duration'],
            'verification': metadata['verification']}
    with LOCK:
        CACHE[slug] = (data, song)
        while len(CACHE) > 24 or sum(len(entry[0]) for entry in CACHE.values()) > 32 * 1024 * 1024:
            CACHE.popitem(last=False)
    return data, song


def search(query, page=1):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 120:
        raise ValueError('Enter a song, artist, or composer to search.')
    if type(page) is not int or not 1 <= page <= 1000:
        raise ValueError('Choose a valid results page.')
    key = (query.strip().lower(), page)
    with LOCK:
        cached = SEARCH_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
    result = api('search', q=query.strip(), page=page - 1, pageSize=12)
    items = result.get('results', [])
    if not isinstance(items, list):
        raise ValueError('BitMidi returned an unexpected search response.')
    items = items[:12]
    def inspect(item):
        if not isinstance(item, dict):
            return None
        slug, name = item.get('slug'), item.get('name')
        if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,400}', slug) or not isinstance(name, str):
            return None
        candidate = {'name': name[:200], 'url': BASE + '/' + slug, 'piano_only': None}
        try:
            return checked_song(item)[1]
        except ValueError as exc:
            candidate['reason'] = str(exc)
            if 'unavailable' not in str(exc).lower():
                candidate['piano_only'] = False
            return candidate
    with ThreadPoolExecutor(max_workers=4) as workers:
        songs = [song for song in workers.map(inspect, items) if song]
    output = {'ok': True, 'results': songs, 'page': page,
              'has_more': page < int(result.get('pageTotal', 0)),
              'checked': len(items), 'skipped': sum(song['piano_only'] is not True for song in songs)}
    with LOCK:
        SEARCH_CACHE[key] = (time.monotonic(), output)
        while len(SEARCH_CACHE) > 30:
            SEARCH_CACHE.popitem(last=False)
    return output


def download(url):
    slug = slug_from_url(url)
    with LOCK:
        if slug in CACHE:
            CACHE.move_to_end(slug)
            return CACHE[slug]
    result = api('get', slug=slug).get('result')
    if not isinstance(result, dict) or result.get('slug') != slug:
        raise ValueError('This BitMidi song was not found.')
    return checked_song(result, piano_only=False)

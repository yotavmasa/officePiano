"""Conservative cover lookup from Apple's public iTunes Search API."""
from collections import OrderedDict
import json
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API = 'https://itunes.apple.com/search'
CACHE = OrderedDict()
QUERY_CACHE = OrderedDict()
REQUEST_LOCK = threading.Lock()
LAST_REQUEST = 0.0
LOCK = threading.RLock()
MAX_JSON = 1024 * 1024
TTL = 24 * 60 * 60


def _clean(value):
    if not isinstance(value, str):
        return ''
    value = urllib.parse.unquote(value[:1000])
    value = re.sub(r'(?i)\.midi?$', '', value.strip())
    value = re.sub(r'(?i)^download3-[0-9]+-', '', value)
    value = re.sub(r'^(?:0[0-9]{1,2}[ ._-]+|[0-9]{1,3}[._-]+)\s*', '', value)
    value = re.sub(r'([A-Z])([A-Z][a-z])', r'\1 \2', value)
    value = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', value)
    value = ' '.join(re.sub(r'[_-]+', ' ', value).split())
    had_format = False
    while True:
        previous = value
        value, removed = re.subn(r'(?i)\s+(?:GM|GS|XG|MID|MIDI)(?:\s*[0-9]{1,3})?$', '', value)
        had_format |= bool(removed)
        value = re.sub(r'\s*\([0-9]{1,3}\)\s*$', '', value)
        value = re.sub(r'(?i)(?:\s+|(?<=[A-Za-z]))v[0-9]{1,3}$', '', value)
        value = re.sub(r'(?i)\s+(?:version|ver)\s*[0-9]{1,3}$', '', value)
        value = value.strip()
        if value == previous:
            break
    if had_format:
        value = re.sub(r'(?<=[A-Za-z])(?:\s*)[0-9]{1,3}$', '', value).strip()
    return value


def _tokens(value):
    value = unicodedata.normalize('NFKD', _clean(value)).casefold()
    value = ''.join(letter for letter in value if not unicodedata.combining(letter))
    return [token for token in re.findall(r'[^\W_]+', value) if token not in ('the', 'a', 'an')]


def _identity(song):
    if not isinstance(song, dict):
        return '', '', []
    title = _clean(song.get('name', ''))[:200]
    expected = _tokens(title)
    explicit_artist = _clean(song.get('artist', ''))
    artist = _tokens(explicit_artist)
    if explicit_artist:
        raw = str(song.get('name', '')).replace('_', ' ')
        prefix = re.split(r'\s+[-–—]\s+', raw, maxsplit=1)
        if len(prefix) == 2 and _tokens(prefix[0]) == artist:
            title = _clean(prefix[1])[:200]
            expected = _tokens(title)
    source = song.get('source_url', '')
    if not artist and isinstance(source, str):
        try:
            parsed = urllib.parse.urlsplit(source)
        except ValueError:
            parsed = None
        if parsed and parsed.hostname in ('freemidi.org', 'www.freemidi.org', 'bitmidi.com', 'www.bitmidi.com'):
            slug = parsed.path.rsplit('/', 1)[-1]
            valid = (re.fullmatch(r'download3-[0-9]+-[A-Za-z0-9-]+', slug) if parsed.hostname.endswith('freemidi.org')
                     else re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,400}', slug))
            if valid:
                slug_tokens = _tokens(slug)
                if expected and slug_tokens[:len(expected)] == expected:
                    artist = slug_tokens[len(expected):]
                elif expected and slug_tokens[-len(expected):] == expected:
                    artist = slug_tokens[:-len(expected)]
                while artist and (artist[0] in ('gm', 'gs', 'xg') or re.fullmatch(r'(?:[0-9]{1,3}|v[0-9]{1,3})', artist[0])):
                    artist.pop(0)
    term = ' '.join([title, ' '.join(artist), _clean(song.get('album', ''))]).strip()
    return term[:240], title, artist



def _queries(song):
    term, title, artist = _identity(song)
    variants = [term]
    source = song.get('source_url', '') if isinstance(song, dict) else ''
    if isinstance(source, str):
        try:
            parsed = urllib.parse.urlsplit(source)
        except ValueError:
            parsed = None
        if parsed and parsed.hostname in ('freemidi.org', 'www.freemidi.org', 'bitmidi.com', 'www.bitmidi.com'):
            slug = parsed.path.rsplit('/', 1)[-1]
            candidate = _clean(slug)
            # Use only a source slug sharing the song title, never arbitrary guesses.
            expected, found = set(_tokens(title)), set(_tokens(candidate))
            if expected and len(expected & found) / len(expected) >= .65:
                variants.append(candidate)
    variants.append(title)
    unique = OrderedDict()
    for variant in variants:
        if variant.strip():
            unique.setdefault(variant.casefold(), variant[:240])
    return list(unique.values())[:3], title, artist


def high_resolution_url(url):
    if not artwork_url(url):
        return ''
    parsed = urllib.parse.urlsplit(url)
    path = re.sub(r'/(?:100x100|60x60)bb\.(jpg|png)$', r'/600x600bb.\1', parsed.path, flags=re.I)
    return parsed._replace(path=path).geturl()


def artwork_url(url):
    if not isinstance(url, str) or len(url) > 3000:
        return False
    try:
        parsed = urllib.parse.urlsplit(url)
        return bool(parsed.scheme == 'https' and re.fullmatch(r'is[0-9]+(?:-ssl)?\.mzstatic\.com', parsed.hostname or '')
                    and parsed.port in (None, 443) and not parsed.username and not parsed.password
                    and parsed.path.startswith('/image/') and not parsed.fragment)
    except ValueError:
        return False


def _store_url(url):
    if not isinstance(url, str) or len(url) > 3000:
        return ''
    try:
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme == 'https' and parsed.hostname in ('itunes.apple.com', 'music.apple.com')
                and parsed.port in (None, 443) and not parsed.username and not parsed.password and not parsed.fragment):
            return url
    except ValueError:
        pass
    return ''


def _allowed_api(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'itunes.apple.com' or parsed.path != '/search'
            or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment):
        raise ValueError('Unexpected Apple search URL.')


class AppleRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _allowed_api(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _search(term):
    url = API + '?' + urllib.parse.urlencode({'term': term, 'media': 'music', 'entity': 'song', 'limit': 10, 'country': 'US'})
    request = urllib.request.Request(url, headers={'User-Agent': 'PianoRemote/2.0', 'Accept': 'application/json'})
    global LAST_REQUEST
    with REQUEST_LOCK:
        delay = 3 - (time.monotonic() - LAST_REQUEST) if LAST_REQUEST else 0
        if delay > 0:
            time.sleep(delay)
        LAST_REQUEST = time.monotonic()
        with urllib.request.build_opener(AppleRedirect()).open(request, timeout=5) as response:
            _allowed_api(response.geturl())
            data = response.read(MAX_JSON + 1)
    if len(data) > MAX_JSON:
        raise ValueError('Apple search response is too large.')
    result = json.loads(data)
    if not isinstance(result, dict) or not isinstance(result.get('results'), list):
        raise ValueError('Unexpected Apple search response.')
    return result['results'][:10]



def candidates(term):
    """Songs matching a typed search, for a person to choose from; nothing is applied automatically."""
    if not isinstance(term, str) or not term.strip() or len(term) > 120:
        raise ValueError('Search for a song title or artist (up to 120 characters).')
    try:
        items = _cached_search(term.strip())
    except (ValueError, TypeError, UnicodeError, urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('Apple Music search is unavailable. Check the internet connection and try again.') from None
    results = []
    for item in items:
        if not isinstance(item, dict) or item.get('kind') != 'song':
            continue
        title, artist, album = item.get('trackName'), item.get('artistName'), item.get('collectionName')
        url = item.get('artworkUrl100', item.get('artworkUrl60', ''))
        if not all(isinstance(value, str) and value.strip() for value in (title, artist)):
            continue
        results.append({'title': title[:200], 'artist': artist[:200], 'album': album[:200] if isinstance(album, str) else '',
                        'artwork': high_resolution_url(url) if artwork_url(url) else '',
                        'store_url': _store_url(item.get('trackViewUrl')) or _store_url(item.get('collectionViewUrl'))})
    return results


def _cached_search(term):
    key = term.casefold()
    now = time.monotonic()
    with LOCK:
        cached = QUERY_CACHE.get(key)
        if cached and now - cached[0] < TTL:
            QUERY_CACHE.move_to_end(key)
            return cached[1]
    result = _search(term)
    with LOCK:
        QUERY_CACHE[key] = (now, result)
        while len(QUERY_CACHE) > 128:
            QUERY_CACHE.popitem(last=False)
    return result


def _match(item, title, artist_hint):
    if not isinstance(item, dict) or item.get('kind') != 'song':
        return None
    track, artist, album = item.get('trackName'), item.get('artistName'), item.get('collectionName')
    if not all(isinstance(value, str) and value.strip() for value in (track, artist, album)):
        return None
    url = item.get('artworkUrl100', item.get('artworkUrl60', ''))
    store = _store_url(item.get('trackViewUrl')) or _store_url(item.get('collectionViewUrl'))
    if not artwork_url(url) or not store:
        return None
    expected, found, artist_tokens = set(_tokens(title)), set(_tokens(track)), set(_tokens(artist))
    if not expected or not found:
        return None
    overlap = expected & found
    # Require nearly the whole title, allowing a filename's artist prefix/suffix.
    if len(overlap) / len(found) < .8:
        return None
    remaining = expected - found
    if remaining and not remaining.issubset(artist_tokens):
        return None
    if artist_hint and not set(artist_hint).issubset(artist_tokens):
        return None
    score = len(overlap) / len(found) + len(overlap) / len(expected) + bool(artist_hint or remaining)
    return score, {'url': high_resolution_url(url), 'title': track[:200], 'artist': artist[:200], 'album': album[:200],
                   'source': 'Apple iTunes', 'store_url': store}


def lookup(song):
    return _lookup(song)[0]


def recognize(song):
    """Return (match, reachable); an empty match with reachable=False means try again later."""
    found, reachable = _lookup(song)
    if found:
        found = dict(found, title=clean_title(found['title']))
    return found, reachable


def clean_title(title):
    # Store titles carry release notes that are not part of the song's name.
    title = re.sub(r'(?i)\s+-\s+(?:[0-9]{4}\s+)?(?:remaster(?:ed)?|live|single|radio edit|mono|stereo)\b.*$', '', title)
    title = re.sub(r'(?i)\s*[(\[](?:[0-9]{4}\s+)?(?:remaster(?:ed)?|live|single version|radio edit|mono|stereo)[^)\]]*[)\]]', '', title)
    return title.strip()[:200]


def _lookup(song):
    queries, title, artist_hint = _queries(song)
    if not queries or not _tokens(title):
        return {}, True
    key = tuple(query.casefold() for query in queries)
    now = time.monotonic()
    with LOCK:
        cached = CACHE.get(key)
        if cached and now - cached[0] < cached[1]:
            CACHE.move_to_end(key)
            return dict(cached[2]), cached[1] != 300
    try:
        result = {}
        for query in queries:
            matches = [match for item in _cached_search(query) if (match := _match(item, title, artist_hint))]
            # Unknown performers with the same title are ambiguous; keep the fallback.
            performers = {tuple(_tokens(match[1]['artist'])) for match in matches}
            if matches and (artist_hint or len(performers) == 1):
                result = max(matches, key=lambda match: match[0])[1]
                break
            if len(performers) > 1 and not artist_hint:
                break
        expiry = TTL
    except (ValueError, TypeError, UnicodeError, urllib.error.URLError, TimeoutError, OSError):
        result, expiry = {}, 300
    with LOCK:
        CACHE[key] = (now, expiry, dict(result))
        while len(CACHE) > 128:
            CACHE.popitem(last=False)
    return dict(result), expiry != 300

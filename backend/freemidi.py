"""FreeMidi public song pages, using the site's anonymous download session."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import http.cookiejar
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from .library import MAX_MIDI, parse_midi

BASE = 'https://freemidi.org'
CACHE = OrderedDict()
SEARCH_CACHE = OrderedDict()
RESULTS_CACHE = OrderedDict()
LOCK = threading.RLock()
PAGE_SIZE = 12
MAX_ARTISTS = 6
MAX_CATALOG_PAGES = 24
MAX_MATCHES = 1000
ARTIST_PATH = re.compile(r'/artist-([1-9][0-9]{0,8})-[A-Za-z0-9][A-Za-z0-9-]{0,350}')
SONG_PATH = re.compile(r'/download3-([1-9][0-9]{0,8})-[A-Za-z0-9][A-Za-z0-9-]{0,350}')


def allowed_url(url):
    if not isinstance(url, str) or len(url) > 1200:
        raise ValueError('Choose a song from freemidi.org.')
    try:
        parts = urllib.parse.urlsplit(url)
        valid = (parts.scheme == 'https' and parts.hostname in ('freemidi.org', 'www.freemidi.org')
                 and parts.port in (None, 443) and not parts.username and not parts.password)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('Choose a song from freemidi.org.')
    return parts


class FreeMidiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        allowed_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def session():
    return urllib.request.build_opener(FreeMidiRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def fetch(url, limit=2 * 1024 * 1024, opener=None, referer=None):
    allowed_url(url)
    headers = {'User-Agent': 'PianoRemote/2.0 (local MIDI player)'}
    if referer:
        allowed_url(referer)
        headers['Referer'] = referer
    try:
        with (opener or session()).open(urllib.request.Request(url, headers=headers), timeout=8) as response:
            allowed_url(response.geturl())
            data = response.read(limit + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ValueError('FreeMidi is unavailable right now. Try again, or upload a MIDI file.') from exc
    if len(data) > limit:
        raise ValueError('This FreeMidi file is too large.')
    return data


def song_url(url):
    parts = allowed_url(url)
    match = SONG_PATH.fullmatch(parts.path)
    if parts.query or parts.fragment or not match:
        raise ValueError('Choose a FreeMidi song page, not a download or external URL.')
    return BASE + parts.path, match.group(1)


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.anchor, self.heading, self.in_heading = [], None, [], False
        self.section, self.section_heading, self.in_section_heading = '', [], False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.anchor = {'href': attrs.get('href', ''), 'title': attrs.get('title', ''),
                           'id': attrs.get('id', ''), 'text': [], 'section': self.section}
        elif tag == 'h1':
            self.in_heading = True
        elif tag == 'h2':
            self.section_heading, self.in_section_heading = [], True

    def handle_data(self, text):
        if self.anchor is not None:
            self.anchor['text'].append(text)
        if self.in_heading:
            self.heading.append(text)
        if self.in_section_heading:
            self.section_heading.append(text)

    def handle_endtag(self, tag):
        if tag == 'a' and self.anchor is not None:
            self.anchor['text'] = ' '.join(' '.join(self.anchor['text']).split())
            self.links.append(self.anchor)
            self.anchor = None
        elif tag == 'h1':
            self.in_heading = False
        elif tag == 'h2':
            self.section = ' '.join(' '.join(self.section_heading).split()).lower()
            self.in_section_heading = False


def read_page(data):
    page = Page()
    page.feed(data.decode('utf-8', errors='replace'))
    return page


def search_links(data):
    results = OrderedDict()
    for link in read_page(data).links:
        try:
            url, identity = song_url(urllib.parse.urljoin(BASE + '/', link['href']))
        except ValueError:
            continue
        name = (link['title'] or link['text']).strip()
        if name and identity not in results:
            results[identity] = {'name': name[:200], 'url': url}
        if len(results) >= MAX_MATCHES:
            break
    return list(results.values())



def artist_links(data):
    artists = OrderedDict()
    for link in read_page(data).links:
        if link['section'] != 'categories' or not link['text']:
            continue
        url = urllib.parse.urljoin(BASE + '/', link['href'])
        try:
            parts = allowed_url(url)
        except ValueError:
            continue
        match = ARTIST_PATH.fullmatch(parts.path)
        if match and not parts.query and not parts.fragment and match.group(1) not in artists:
            artists[match.group(1)] = {'name': link['text'][:200], 'url': BASE + parts.path}
    return list(artists.values())


def catalog_links(data, artist_url):
    path = allowed_url(artist_url).path
    pages = OrderedDict()
    for link in read_page(data).links:
        url = urllib.parse.urljoin(artist_url, link['href'])
        try:
            parts = allowed_url(url)
        except ValueError:
            continue
        if not parts.query and not parts.fragment and re.fullmatch(re.escape(path) + r'-P-[0-9]{1,4}', parts.path):
            pages[BASE + parts.path] = None
    return list(pages)


def collect_matches(query):
    data = fetch(BASE + '/search?' + urllib.parse.urlencode({'q': query}))
    merged = OrderedDict((song_url(item['url'])[1], item) for item in search_links(data))
    artists = artist_links(data)
    warnings = []
    if len(artists) > MAX_ARTISTS:
        warnings.append(f'FreeMidi matched more than {MAX_ARTISTS} artists. Narrow your search for additional catalogs.')
    remaining = [MAX_CATALOG_PAGES]
    budget_lock = threading.Lock()
    def artist_catalog(artist):
        pending, visited, songs, errors = [artist['url']], set(), [], []
        while pending:
            url = pending.pop(0)
            if url in visited:
                continue
            visited.add(url)
            with budget_lock:
                if not remaining[0]:
                    errors.append('FreeMidi catalog search reached its page limit. Narrow your search for more songs.')
                    break
                remaining[0] -= 1
            try:
                page = fetch(url)
            except ValueError as exc:
                errors.append(f"Could not read part of {artist['name']}'s FreeMidi catalog: {exc}")
                continue
            songs.extend(search_links(page))
            for next_url in catalog_links(page, artist['url']):
                if next_url not in visited and next_url not in pending:
                    pending.append(next_url)
        return songs, errors
    with ThreadPoolExecutor(max_workers=4) as workers:
        for songs, errors in workers.map(artist_catalog, artists[:MAX_ARTISTS]):
            warnings.extend(errors)
            for item in songs:
                identity = song_url(item['url'])[1]
                if identity not in merged:
                    if len(merged) >= MAX_MATCHES:
                        warnings.append(f'FreeMidi search is limited to {MAX_MATCHES} matches. Narrow your search for more songs.')
                        break
                    merged[identity] = item
    return list(merged.values()), list(dict.fromkeys(warnings))


def download(url):
    url, identity = song_url(url)
    with LOCK:
        if url in CACHE:
            CACHE.move_to_end(url)
            return CACHE[url]
    opener = session()
    page = read_page(fetch(url, opener=opener))
    link = next((link for link in page.links if link['id'] == 'downloadmidi'), None)
    if not link:
        raise ValueError('FreeMidi did not provide a download link. Open the song page if it requires verification.')
    target = urllib.parse.urljoin(url, link['href'])
    parts = allowed_url(target)
    if parts.path != '/getter-' + identity or parts.query or parts.fragment:
        raise ValueError('FreeMidi returned an unexpected download link.')
    # The detail page establishes the site's normal anonymous cookie session.
    data = fetch(target, MAX_MIDI, opener=opener, referer=url)
    if data[:4] != b'MThd':
        raise ValueError('FreeMidi did not provide a MIDI file. Open the song page if it requires verification.')
    metadata = parse_midi(data, piano_only=False)
    name = (link['title'] or ' '.join(page.heading)).strip()
    name = re.sub(r'(?i)\s+midi$', '', name).strip()
    if not name:
        raise ValueError('FreeMidi returned a song without a name.')
    song = {'name': name[:200], 'url': url, 'piano_only': metadata['piano_only'],
            'reason': metadata['compatibility_reason'], 'notes': metadata['notes'],
            'duration_seconds': metadata['duration'], 'verification': metadata['verification']}
    with LOCK:
        CACHE[url] = (data, song)
        while len(CACHE) > 24 or sum(len(entry[0]) for entry in CACHE.values()) > 32 * 1024 * 1024:
            CACHE.popitem(last=False)
    return data, song


def search(query, page=1):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 120:
        raise ValueError('Enter a song, artist, or composer to search.')
    if type(page) is not int or not 1 <= page <= 1000:
        raise ValueError('Choose a valid results page.')
    query = query.strip()
    key = (query.lower(), page)
    with LOCK:
        cached = SEARCH_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            SEARCH_CACHE.move_to_end(key)
            return cached[1]
        cached_links = RESULTS_CACHE.get(query.lower())
    if cached_links and time.monotonic() - cached_links[0] < 300:
        links, warnings = cached_links[1], cached_links[2]
    else:
        links, warnings = collect_matches(query)
        if not any(warning.startswith('Could not read part of ') for warning in warnings):
            with LOCK:
                RESULTS_CACHE[query.lower()] = (time.monotonic(), links, warnings)
                while len(RESULTS_CACHE) > 30:
                    RESULTS_CACHE.popitem(last=False)
    items = links[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]
    def inspect(item):
        try:
            return download(item['url'])[1]
        except ValueError as exc:
            return dict(item, piano_only=None, reason=str(exc))
    with ThreadPoolExecutor(max_workers=4) as workers:
        songs = list(workers.map(inspect, items))
    result = {'ok': True, 'results': songs, 'page': page, 'has_more': page * PAGE_SIZE < len(links),
              'checked': len(items), 'skipped': sum(song['piano_only'] is not True for song in songs),
              'total_matches': len(links), 'warnings': warnings}
    if not any(warning.startswith('Could not read part of ') for warning in warnings):
        with LOCK:
            SEARCH_CACHE[key] = (time.monotonic(), result)
            while len(SEARCH_CACHE) > 30:
                SEARCH_CACHE.popitem(last=False)
    return result

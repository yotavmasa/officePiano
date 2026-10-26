"""zzaj: jazz standards with lead sheets and MIDI backing tracks, by the author of zzaj.web.fc2.com.

The score index is one table (title, composer, key, style, MIDI); it is read once an hour and searched
locally. Files are fetched only when a song is saved, to keep the load on a personal site low.
"""
import html
import re
import threading
import urllib.parse
from .catalogs import STOPWORDS, Catalog, token_match, words
from .library import MAX_MIDI, parse_midi

SITE = Catalog('zzaj', 'https://zzaj.web.fc2.com', '/score/index.html')
INDEX = SITE.base + SITE.index
LOCK = threading.Lock()
FILES = {}


def _text(cell):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', cell)).split())


def songs():
    """Rows of the score table that link a MIDI file in /score/."""
    found = {}
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', SITE.page(INDEX), re.S | re.I):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.S | re.I)
        if len(cells) < 9:
            continue
        midi = re.search(r"href=['\"]([^'\"]+\.midi?)['\"]", cells[8], re.I)
        title = _text(cells[1])
        if not midi or not title:
            continue
        url = urllib.parse.urljoin(INDEX, midi.group(1))
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'zzaj.web.fc2.com' or not re.fullmatch(r'/score/[A-Za-z0-9_.-]+\.midi?', parsed.path):
            continue
        found[url] = {'title': title[:160], 'composer': _text(cells[5])[:120], 'key': _text(cells[6])[:40], 'style': _text(cells[7])[:40]}
    return found


def _name(song):
    return f"{song['title']} — {song['composer']}" if song['composer'] else song['title']


def search(query, page=1):
    tokens = words(query)
    required = [token for token in tokens if token not in STOPWORDS] or tokens
    found = [(url, song) for url, song in songs().items()
             if token_match(required, ' '.join((song['title'], song['composer'], song['style'])))]
    found.sort(key=lambda item: (not token_match(required, item[1]['title']), item[1]['title'].casefold()))
    batch = [{'name': _name(song), 'url': url, 'piano_only': None} for url, song in found[(page - 1) * 12:page * 12]]
    return {'results': batch, 'has_more': page * 12 < len(found), 'total_matches': len(found),
            'notes': ['Backing tracks with bass and drums; drums are left out by default. Files are checked when saved.']}


def download(url):
    song = songs().get(url) if isinstance(url, str) and len(url) <= 1000 else None
    if not song:
        raise ValueError('Choose a song from zzaj.')
    with LOCK:
        cached = FILES.get(url)
    if cached:
        return cached
    data = SITE.fetch(url, MAX_MIDI)
    metadata = parse_midi(data, piano_only=False)
    result = (data, {'name': _name(song), 'url': url, 'piano_only': metadata['piano_only'],
                     'reason': metadata.get('compatibility_reason', ''), 'notes': metadata['notes'],
                     'duration_seconds': metadata['duration'], 'verification': metadata['verification']})
    with LOCK:
        FILES[url] = result
        while len(FILES) > 12:
            FILES.pop(next(iter(FILES)))
    return result

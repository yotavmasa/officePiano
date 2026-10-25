"""MAESTRO: recorded Disklavier competition performances, searched from a local copy of the dataset.

Google Magenta, CC BY-NC-SA 4.0. scripts/fetch_maestro.py downloads it once into data/catalogs/maestro.
"""
import csv
from pathlib import Path
import threading
import urllib.parse
from .catalogs import STOPWORDS, token_match, words
from .library import MAX_MIDI, parse_midi

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / 'data' / 'catalogs' / 'maestro'
INDEX = 'maestro-v3.0.0.csv'
PAGE = 'https://magenta.withgoogle.com/datasets/maestro'
HOSTS = ('magenta.withgoogle.com',)
LOCK = threading.Lock()
ENTRIES = {'path': None, 'mtime': None, 'rows': []}


def available():
    return (FOLDER / INDEX).is_file()


def _rows():
    path = FOLDER / INDEX
    if not path.is_file():
        raise ValueError('MAESTRO isn’t installed on this computer yet. Run scripts/fetch_maestro.py once.')
    mtime = path.stat().st_mtime
    with LOCK:
        if ENTRIES['path'] != path or ENTRIES['mtime'] != mtime:
            with path.open(newline='', encoding='utf-8') as file:
                rows = [{'composer': row['canonical_composer'].strip(), 'title': row['canonical_title'].strip(),
                         'year': row['year'].strip(), 'file': row['midi_filename'].strip(),
                         'duration': float(row['duration'] or 0)} for row in csv.DictReader(file)]
            ENTRIES.update(path=path, mtime=mtime, rows=[row for row in rows if row['file'].lower().endswith(('.mid', '.midi'))])
        return ENTRIES['rows']


def _url(file):
    return PAGE + '#' + urllib.parse.quote(file)


def _local(url):
    """The stored file for a MAESTRO result URL, only if it is listed in the index."""
    if not isinstance(url, str) or len(url) > 1000:
        raise ValueError('Choose a MAESTRO result.')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.path != '/datasets/maestro' or parsed.query:
        raise ValueError('Choose a MAESTRO result.')
    file = urllib.parse.unquote(parsed.fragment)
    row = next((row for row in _rows() if row['file'] == file), None)
    path = (FOLDER / file).resolve()
    if not row or not path.is_relative_to(FOLDER.resolve()) or not path.is_file():
        raise ValueError('That MAESTRO performance is not available on this computer.')
    return row, path


def _name(row):
    return f"{row['composer']} — {row['title']}"[:240]


def _performance(row):
    # Many works were played several times, sometimes in the same year; the length tells recordings apart.
    seconds = int(row['duration'])
    return f"{row['year']} performance, {seconds // 60}:{seconds % 60:02d}"


def search(query, page=1):
    tokens = words(query)
    required = [token for token in tokens if token not in STOPWORDS] or tokens
    rows = _rows()
    found = [row for row in rows if token_match(required, _name(row))]
    # Title matches first, then by piece and year so performances of one work sit together.
    found.sort(key=lambda row: (not token_match(required, row['title']), row['composer'], row['title'], row['year']))
    counts = {}
    for row in found:
        counts[_name(row)] = counts.get(_name(row), 0) + 1
    batch = []
    for row in found[(page - 1) * 12:page * 12]:
        name = _name(row) + (f" ({_performance(row)})" if counts[_name(row)] > 1 else '')
        result = {'name': name, 'url': _url(row['file']), 'piano_only': None, 'duration_seconds': round(row['duration'], 2)}
        try:
            metadata = parse_midi(_local(result['url'])[1].read_bytes(), piano_only=False)
            result.update(piano_only=metadata['piano_only'], reason=metadata.get('compatibility_reason', ''))
        except (ValueError, OSError):
            pass
        batch.append(result)
    return {'results': batch, 'has_more': page * 12 < len(found), 'total_matches': len(found),
            'warnings': ['Recorded performances from the MAESTRO dataset by Google Magenta (CC BY-NC-SA 4.0).']}


def download(url):
    row, path = _local(url)
    if path.stat().st_size > MAX_MIDI:
        raise ValueError('That MAESTRO file is larger than 8 MB.')
    data = path.read_bytes()
    metadata = parse_midi(data, piano_only=False)
    name = _name(row) + f" ({_performance(row)})"
    return data, {'name': name, 'url': url, 'piano_only': metadata['piano_only'], 'reason': metadata.get('compatibility_reason', ''),
                  'notes': metadata['notes'], 'duration_seconds': metadata['duration'], 'verification': metadata['verification']}

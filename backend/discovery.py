"""Search MIDI catalogs independently so one unavailable site does not hide the other."""
from concurrent.futures import ThreadPoolExecutor
from itertools import zip_longest
import urllib.parse
from . import bitmidi
from . import freemidi
from .catalogs import bushgrafts, kunstderfuge
from . import maestro
from . import zzaj

PROVIDERS = {'bitmidi': bitmidi, 'freemidi': freemidi, 'bushgrafts': bushgrafts, 'kunstderfuge': kunstderfuge, 'maestro': maestro, 'zzaj': zzaj}
LABELS = {'bitmidi': 'BitMidi', 'freemidi': 'FreeMidi', 'bushgrafts': 'Bushgrafts', 'kunstderfuge': 'Kunst der Fuge', 'maestro': 'MAESTRO', 'zzaj': 'zzaj'}


def search(query, page=1, source='bitmidi'):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 120:
        raise ValueError('Enter a song, artist, or composer to search.')
    if type(page) is not int or not 1 <= page <= 1000:
        raise ValueError('Choose a valid results page.')
    # One source, 'both', 'all', or a comma-separated selection such as 'bitmidi,kunstderfuge'.
    # 'all' skips MAESTRO until its local copy is installed; choosing it explicitly explains how to install it.
    names = [name for name in PROVIDERS if name != 'maestro' or maestro.available()] if source == 'all' else ['bitmidi', 'freemidi'] if source == 'both' else list(dict.fromkeys(source.split(','))) if isinstance(source, str) else []
    if not names or len(names) > len(PROVIDERS) or any(name not in PROVIDERS for name in names):
        raise ValueError('Choose at least one MIDI source.')
    def fetch(name):
        try:
            result = PROVIDERS[name].search(query, page)
            return name, result, ''
        except ValueError as exc:
            return name, None, LABELS[name] + ': ' + str(exc)
    with ThreadPoolExecutor(max_workers=len(names)) as workers:
        found = list(workers.map(fetch, names))
    warnings = [error for _, _, error in found if error]
    successes = [(name, result) for name, result, _ in found if result is not None]
    warnings.extend(LABELS[name] + ': ' + warning for name, result in successes for warning in result.get('warnings', []))
    if not successes:
        raise ValueError(' '.join(warnings))
    batches = [[dict(item, source=name, source_name=LABELS[name]) for item in result['results']] for name, result in successes]
    results = [item for group in zip_longest(*batches) for item in group if item is not None]
    return {'ok': True, 'results': results, 'page': page, 'source': source,
            'sources': [name for name, _ in successes], 'warnings': warnings,
            'total_matches': sum(result['total_matches'] for _, result in successes) if all(type(result.get('total_matches')) is int for _, result in successes) else None,
            'checked': sum(result.get('checked', 0) for _, result in successes),
            'has_more': any(result.get('has_more') for _, result in successes)}


def download(url):
    if not isinstance(url, str) or len(url) > 1000:
        raise ValueError('Choose a valid MIDI song page.')
    host = urllib.parse.urlsplit(url).hostname
    if host in ('bitmidi.com', 'www.bitmidi.com'):
        return bitmidi.download(url)
    if host in ('freemidi.org', 'www.freemidi.org'):
        return freemidi.download(url)
    if host in ('bushgrafts.com', 'www.bushgrafts.com'):
        return bushgrafts.download(url)
    if host in ('kunstderfuge.com', 'www.kunstderfuge.com'):
        return kunstderfuge.download(url)
    if host in maestro.HOSTS:
        return maestro.download(url)
    if host == 'zzaj.web.fc2.com':
        return zzaj.download(url)
    raise ValueError('Choose a song from one of the supported MIDI sources.')

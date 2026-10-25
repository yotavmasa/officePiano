"""Public jazz/classical catalogs; MIDI downloads stay within each source site."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import http.cookiejar
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from .library import MAX_MIDI, parse_midi

USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'


def words(value):
    return re.findall(r'[a-z0-9]+', unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower())


# Small words that appear in many titles and composer names; they never decide a match on their own.
STOPWORDS = {'a', 'an', 'and', 'the', 'of', 'in', 'on', 'for', 'de', 'la', 'le', 'les', 'du', 'des', 'di', 'da', 'del',
             'der', 'die', 'das', 'und', 'et', 'en', 'no', 'nr', 'op'}


def stem(word):
    # Treat sonata/sonate, nocturne/nocturnes and fugue/fugues alike.
    return word if len(word) <= 4 or word.isdigit() else word.rstrip('aeiouys') or word


def token_match(tokens, text):
    """Every query word starts some word in the text, comparing stems so partial words also match."""
    found = [stem(word) for word in words(text)]
    return all(any(word.startswith(stem(token)) for word in found) for token in tokens)


class Links(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.links, self.current, self.inside = [], None, False
        self.lead, self.heading, self.linked = [], '', False
        self.feed(html)
        self.finish()

    def finish(self):
        if self.current:
            self.current['text'] = ' '.join(' '.join(self.current['text']).split())
            self.current['after'] = ' '.join(' '.join(self.current['after']).split())
            self.links.append(self.current)
        self.current, self.inside = None, False

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.finish()
            if not self.linked:
                self.heading, self.linked = ' '.join(' '.join(self.lead).split()), True
            self.current = {'href': dict(attrs).get('href', ''), 'text': [], 'after': [], 'heading': self.heading}
            self.inside = True
        elif tag == 'br':
            self.finish()
        elif tag == 'p':
            self.finish()
            self.lead, self.heading, self.linked = [], '', False

    def handle_endtag(self, tag):
        if tag == 'a':
            self.inside = False
        elif tag in ('p', 'li', 'td'):
            self.finish()

    def handle_data(self, text):
        if self.current:
            self.current['text' if self.inside else 'after'].append(text)
        elif not self.linked:
            self.lead.append(text)


class Catalog:
    def __init__(self, name, base, index, classical=False):
        self.name, self.base, self.index, self.classical = name, base, index, classical
        self.domain = urllib.parse.urlsplit(base).hostname.removeprefix('www.')
        self.lock = threading.RLock()
        self.pages, self.files, self.names = {}, OrderedDict(), OrderedDict()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), self.redirects())

    def allowed(self, url):
        try:
            p = urllib.parse.urlsplit(url)
            valid = (p.scheme == 'https' and p.hostname in (self.domain, 'www.' + self.domain)
                     and p.port in (None, 443) and not p.username and not p.password)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('Choose a song from ' + self.name + '.')
        return p

    def redirects(self):
        catalog = self
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                catalog.allowed(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        return Redirect()

    def fetch(self, url, limit=2 * 1024 * 1024):
        self.allowed(url)
        try:
            request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with self.opener.open(request, timeout=10) as response:
                self.allowed(response.geturl())
                data = response.read(limit + 1)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise ValueError(self.name + ' is unavailable right now.') from exc
        if len(data) > limit:
            raise ValueError('This file is too large.')
        return data

    def page(self, url):
        with self.lock:
            cached = self.pages.get(url)
            if cached and time.monotonic() - cached[0] < 3600:
                return cached[1]
        data = self.fetch(url)
        try:
            html = data.decode('utf-8')
        except UnicodeDecodeError:
            html = data.decode('cp1252', errors='replace')
        with self.lock:
            self.pages[url] = (time.monotonic(), html)
        return html

    def songs(self, html, page, composer=''):
        found = {}
        for link in Links(html).links:
            url = urllib.parse.urljoin(page, link['href'])
            try:
                p = self.allowed(url)
            except ValueError:
                continue
            if self.classical:
                file = urllib.parse.parse_qs(p.query).get('file', [''])[0]
                if p.path != '/-/midi.asp' or not file.lower().endswith(('.mid', '.midi')):
                    continue
                title = link['after'].strip(' |') or file.rsplit('/', 1)[-1].replace('_', ' ')
                heading = link.get('heading', '').strip(' |')
                if heading and heading not in title:
                    title = heading + ' — ' + title
                credit = re.search(r'\((?:n?c)\)([^/()]+?)\.midi?$', file, re.I)
                version = ' '.join(part for part in (('Piano roll' if file.lower().startswith('rolls/') else ''),
                                                     (credit.group(1).replace('_', ' ').title() if credit and credit.group(1).lower() != 'unknown' else '')) if part)
            else:
                if not p.path.lower().endswith(('.mid', '.midi')):
                    continue
                title, version = link['text'], ''
            found[url] = {'name': (composer + ' — ' if composer else '') + title[:200], 'url': url, 'piano_only': None, 'version': version, 'title': title}
        with self.lock:
            for url, song in found.items():
                self.names[url] = song['name']
            while len(self.names) > 30000:
                self.names.popitem(last=False)
        return list(found.values())

    def search(self, query, page=1):
        tokens = words(query)
        warnings = []
        if self.classical:
            html = self.page(self.base + self.index)
            section = html.split('name="Composers"', 1)[-1].split('name="Specials"', 1)[0]
            pages = {}
            for link in Links(section).links:
                href = urllib.parse.urldefrag(link['href'])[0]
                if re.fullmatch(r'[a-z0-9/-]+\.htm', href) and link['text']:
                    pages[urllib.parse.urljoin(self.base + '/', href)] = link['text']
            composers = {urllib.parse.urlsplit(url).path[1:-4]: name for url, name in pages.items()
                         if '/' not in urllib.parse.urlsplit(url).path[1:]}
            for url, name in list(pages.items()):
                directory = urllib.parse.urlsplit(url).path.strip('/').split('/')[0]
                if directory in composers:
                    pages[url] = composers[directory] + ' — ' + name
            if len(pages) > 250:
                raise ValueError('The classical catalog changed; please try again later.')
            content = [t for t in tokens if t not in STOPWORDS and (len(t) > 2 or t.isdigit())] or tokens
            matched = {url: name for url, name in pages.items() if any(t in words(name) for t in content if not t.isdigit())}
            # Composer queries need only that composer's pages; title queries scan the catalog.
            targets = matched or pages
            def load(item):
                url, composer = item
                try:
                    return self.songs(self.page(url), url, composer), ''
                except ValueError as exc:
                    return [], str(exc)
            with ThreadPoolExecutor(max_workers=6) as workers:
                batches = list(workers.map(load, targets.items()))
            candidates = [song for batch, _ in batches for song in batch]
            if any(error for _, error in batches):
                warnings.append('Some composer pages could not be read; these results may be incomplete.')
            warnings.append('Classical files are checked when saved. The site’s download limits may apply.')
        else:
            candidates = self.songs(self.page(self.base + self.index), self.base + self.index)
        required = [t for t in tokens if t not in STOPWORDS] or tokens
        unique = {s['url']: s for s in candidates if token_match(required, s['name'])}
        # Title matches first, then piano works before organ, transcriptions and ensemble arrangements.
        def rank(song):
            in_title = token_match(required, song.get('title', song['name']))
            secondary = any(word in words(song['name']) for word in ('organ', 'transcriptions', 'orchestral', 'chamber', 'arrangements'))
            return (not in_title, secondary)
        matches_found = sorted(unique.values(), key=rank)
        # Several recordings of one piece get their version noted so they can be told apart.
        counts = {}
        for song in matches_found:
            counts[song['name']] = counts.get(song['name'], 0) + 1
        for song in matches_found:
            if counts[song['name']] > 1 and song.get('version'):
                song['name'] = f"{song['name']} ({song['version']})"[:240]
        matches = matches_found
        batch = matches[(page - 1) * 12:page * 12]
        if not self.classical:
            def inspect(song):
                try:
                    return self.download(song['url'], song['name'])[1]
                except ValueError as exc:
                    return dict(song, reason=str(exc))
            with ThreadPoolExecutor(max_workers=4) as workers:
                batch = list(workers.map(inspect, batch))
        return {'results': batch, 'has_more': page * 12 < len(matches), 'total_matches': len(matches), 'warnings': warnings}

    def download(self, url, name=None):
        p = self.allowed(url)
        file = urllib.parse.parse_qs(p.query).get('file', [''])[0]
        if self.classical:
            valid = p.path == '/-/midi.asp' and file.lower().endswith(('.mid', '.midi')) and set(urllib.parse.parse_qs(p.query)) == {'file'}
        else:
            valid = p.path.startswith('/jazz/') and p.path.lower().endswith(('.mid', '.midi')) and not p.query
        if not valid or p.fragment or '..' in urllib.parse.unquote(p.path + file) or len(url) > 1000:
            raise ValueError('Choose a MIDI result from ' + self.name + '.')
        with self.lock:
            if url in self.files:
                self.files.move_to_end(url)
                return self.files[url]
        data = self.fetch(url, MAX_MIDI)
        if self.classical and not data.startswith(b'MThd'):
            html = data.decode('utf-8', errors='replace')
            link = re.search(r'window\.location\.href\s*=\s*"(https://(?:www\.)?kunstderfuge\.com/-/mid\.files/[^"\s]+\.midi?)"', html, re.I)
            if not link:
                raise ValueError('Kunst der Fuge requires a visit to the site or has reached its download limit. Use the source link, then upload the MIDI.')
            self.allowed(link[1])
            time.sleep(5)  # Follow the public preparation page's countdown.
            data = self.fetch(link[1], MAX_MIDI)
        metadata = parse_midi(data, piano_only=False)
        with self.lock:
            title = name or self.names.get(url) or urllib.parse.unquote(file or p.path).rsplit('/', 1)[-1]
        song = {'name': title, 'url': url,
                'piano_only': metadata['piano_only'], 'reason': metadata.get('compatibility_reason', ''),
                'notes': metadata['notes'], 'duration_seconds': metadata['duration'], 'verification': metadata['verification']}
        with self.lock:
            self.files[url] = (data, song)
            while len(self.files) > 24 or sum(len(v[0]) for v in self.files.values()) > 32 * 1024 * 1024:
                self.files.popitem(last=False)
        return data, song


bushgrafts = Catalog('Bushgrafts', 'https://bushgrafts.com', '/midi/')
kunstderfuge = Catalog('Kunst der Fuge', 'https://www.kunstderfuge.com', '/midi.htm', classical=True)

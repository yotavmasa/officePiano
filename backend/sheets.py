"""Local sheet recognition jobs; originals and book page selections stay on this Mac."""
import io
import json
import os
import re
import subprocess
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 20 * 1024 * 1024


def xml_score(data):
    # music21 accepts local file references: only pass the inspected score XML.
    if len(data) > MAX_BYTES:
        raise ValueError('MusicXML is too large.')
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ValueError('Save the MusicXML score using UTF-8 encoding.') from None
    if '\x00' in text or re.search(r'<!\s*(DOCTYPE|ENTITY)', text, re.I):
        raise ValueError('MusicXML contains unsupported declarations.')
    import xml.etree.ElementTree as ET
    root = ET.fromstring(data)
    if root.tag not in ('score-partwise', 'score-timewise'):
        raise ValueError('Choose a MusicXML score.')
    return data


def score_bytes(path, generated=False):
    data = Path(path).read_bytes()
    if data.startswith(b'PK'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > 256 or sum(x.file_size for x in infos) > MAX_BYTES:
                raise ValueError('The compressed score is too large.')
            scores = [x for x in infos if x.filename.lower().endswith(('.xml', '.musicxml')) and not x.filename.startswith('META-INF/')]
            if len(scores) != 1:
                raise ValueError('The compressed score must contain one MusicXML score.')
            data = archive.read(scores[0])
    if generated:
        data = re.sub(br'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML [^"]+" "http://www.musicxml.org/dtds/partwise.dtd">', b'', data)
    return xml_score(data)


def page_numbers(value, count):
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError('Enter pages such as 1-3 or 1, 4-6.')
    numbers = []
    for segment in value.split(','):
        match = re.fullmatch(r'\s*(\d+)(?:\s*-\s*(\d+))?\s*', segment)
        if not match:
            raise ValueError('Enter pages such as 1-3 or 1, 4-6.')
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= count:
            raise ValueError('Pages must be inside this book.')
        numbers.extend(range(start, end + 1))
    if len(set(numbers)) != len(numbers):
        raise ValueError('A song cannot use the same page twice.')
    return sorted(numbers)


def write_score_midi(score, destination):
    from music21 import repeat, stream
    try:
        score.write('midi', fp=str(destination))
        return ''
    except repeat.ExpanderException:
        # OMR can lose a repeat boundary; retain written notes rather than inventing repeats.
        written = stream.Score()
        for part in score.parts:
            written.insert(0, part.flatten())
        written.write('midi', fp=str(destination))
        return 'Repeat markings could not be resolved. This MIDI plays the written notes once; repeats need review.'


class SheetStore:
    def __init__(self, root, library):
        self.folder = Path(root).resolve() / 'sheets'
        self.folder.mkdir(parents=True, exist_ok=True)
        self.library = library
        self.lock = threading.RLock()
        self.state = self.folder / 'index.json'
        self.items = json.loads(self.state.read_text()) if self.state.exists() else []
        self.process = None
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='sheet-conversion')
        self.app = ROOT / 'tools/Audiveris.app/Contents'
        for item in self.items:
            if item['status'] in ('queued', 'converting'):
                item.update(status='error', error='Conversion was interrupted. Upload or select the pages again.')
        self._save()

    def _save(self):
        temporary = self.state.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.items, ensure_ascii=False))
        os.replace(temporary, self.state)

    def snapshot(self):
        with self.lock:
            return {'items': [dict(x) for x in reversed(self.items)], 'available': (self.app / 'runtime/Contents/Home/bin/java').is_file()}

    def _item(self, identity):
        item = next((x for x in self.items if x['id'] == identity), None)
        if item is None:
            raise ValueError('This sheet is no longer available.')
        return item

    def source(self, identity):
        with self.lock:
            item = self._item(identity)
            parent = self._item(item.get('book_id', identity))
            return self.folder / parent['id'] / ('source' + parent['extension']), parent['filename']

    def submit(self, data, name, pieces=None):
        if not data or len(data) > MAX_BYTES:
            raise ValueError('Choose a sheet file smaller than 20 MB.')
        name = str(name).replace('\\', '/').rsplit('/', 1)[-1].strip()[:200]
        ext = Path(name).suffix.lower()
        if ext == '.pdf' and data.startswith(b'%PDF-'):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise ValueError('Password-protected PDFs are not supported.')
            count = len(reader.pages)
            if not 1 <= count <= 500:
                raise ValueError('Choose a PDF with 1 to 500 pages.')
            status = 'needs_pages'
        elif ext == '.png' and data.startswith(b'\x89PNG\r\n\x1a\n') or ext in ('.jpg', '.jpeg') and data.startswith(b'\xff\xd8\xff'):
            from PIL import Image
            with Image.open(io.BytesIO(data)) as image:
                if image.width * image.height > 40_000_000:
                    raise ValueError('The sheet image is too large. Use a scan under 40 megapixels.')
                image.verify()
            count, status = 1, 'queued'
        elif ext in ('.xml', '.musicxml', '.mxl'):
            count, status = 1, 'queued'
        else:
            raise ValueError('Upload a PDF, PNG, JPG or MusicXML score.')
        identity = uuid.uuid4().hex
        folder = self.folder / identity
        folder.mkdir()
        path = folder / ('source' + ext)
        path.write_bytes(data)
        if ext in ('.xml', '.musicxml', '.mxl'):
            try:
                score_bytes(path)
            except Exception:
                path.unlink()
                folder.rmdir()
                raise
        item = {'id': identity, 'name': Path(name).stem or 'Sheet music', 'filename': name, 'extension': ext, 'page_count': count, 'status': status, 'created': time.time(), 'song_id': None, 'error': ''}
        with self.lock:
            self.items.append(item)
            self._save()
        if status == 'queued':
            self.worker.submit(self._convert, identity)
        elif pieces:
            self.convert_book(identity, pieces)
        return dict(item)

    def convert_book(self, identity, pieces):
        with self.lock:
            book = self._item(identity)
            if book['extension'] != '.pdf' or book.get('book_id'):
                raise ValueError('Choose a PDF book.')
            if not isinstance(pieces, list) or not 1 <= len(pieces) <= 50:
                raise ValueError('Add between 1 and 50 songs from this book.')
            validated, used = [], set()
            for piece in pieces:
                name = piece.get('name') if isinstance(piece, dict) else None
                if not isinstance(name, str) or not name.strip() or len(name) > 200:
                    raise ValueError('Give each song a name of up to 200 characters.')
                pages = page_numbers(piece.get('pages'), book['page_count'])
                if used.intersection(pages):
                    raise ValueError('Selected songs must use different pages.')
                used.update(pages)
                validated.append((name.strip(), pages))
            children = []
            for name, pages in validated:
                item = {'id': uuid.uuid4().hex, 'name': name, 'filename': book['filename'], 'extension': '.pdf', 'page_count': len(pages), 'pages': pages, 'book_id': identity, 'status': 'queued', 'created': time.time(), 'song_id': None, 'error': ''}
                self.items.append(item)
                children.append(item)
            self._save()
        for item in children:
            self.worker.submit(self._convert, item['id'])
        return {'items': [dict(x) for x in children]}

    def retry(self, identity):
        with self.lock:
            item = self._item(identity)
            if item['status'] != 'error':
                raise ValueError('Only failed conversions can be tried again.')
            item.update(status='queued', error='')
            self._save()
            result = dict(item)
        self.worker.submit(self._convert, identity)
        return result

    def _convert(self, identity):
        with self.lock:
            item = self._item(identity)
            item.update(status='converting', error='')
            self._save()
        try:
            source, _ = self.source(identity)
            destination = self.folder / identity
            destination.mkdir(exist_ok=True)
            if item['extension'] in ('.xml', '.musicxml', '.mxl'):
                xml = score_bytes(source)
            else:
                java = self.app / 'runtime/Contents/Home/bin/java'
                if not java.is_file():
                    raise ValueError('Audiveris is not installed in the app tools folder.')
                command = [str(java), '-Xmx2G', '-Djava.awt.headless=true', '-Duser.home=' + str(self.folder / 'runtime'), '--enable-native-access=ALL-UNNAMED', '--add-exports=java.desktop/sun.awt.image=ALL-UNNAMED', '-cp', str(self.app / 'app/*'), 'Audiveris', '-batch', '-transcribe', '-export', '-output', str(destination)]
                if item.get('pages'):
                    command += ['-sheets'] + [str(x) for x in item['pages']]
                command += ['--', str(source)]
                with (destination / 'conversion.log').open('wb') as log:
                    environment = dict(os.environ, TESSDATA_PREFIX=str(ROOT / 'tools/tessdata'))
                    with self.lock:
                        self.process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=str(destination), env=environment)
                        process = self.process
                    try:
                        returncode = process.wait(timeout=600)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                        raise
                    finally:
                        with self.lock:
                            self.process = None
                scores = sorted(destination.rglob('*.mxl')) + sorted(destination.rglob('*.musicxml'))
                if returncode or len(scores) != 1:
                    raise ValueError('The notes could not be read as one song. Try a clearer scan or fewer pages.')
                xml = score_bytes(scores[0], generated=True)
            from music21 import converter, instrument
            score = converter.parseData(xml.decode('utf-8-sig'), format='musicxml')
            if not list(score.recurse().notes):
                raise ValueError('No playable notes were found. Try a clearer scan.')
            for part in score.parts:
                for existing in list(part.recurse().getElementsByClass(instrument.Instrument)):
                    existing.activeSite.remove(existing)
                part.insert(0, instrument.Piano())
            midi_path = destination / 'converted.mid'
            warning = write_score_midi(score, midi_path)
            song = self.library.add(midi_path.read_bytes(), item['name'] + '.mid', source_kind='sheet')
            with self.lock:
                item.update(status='ready', song_id=song['id'], error='', warning=warning)
                self._save()
        except Exception as error:
            message = 'Recognition took too long. Try fewer pages.' if isinstance(error, subprocess.TimeoutExpired) else str(error)
            with self.lock:
                item.update(status='error', error=message[:400] or 'Unable to convert this sheet.')
                self._save()

    def shutdown(self):
        with self.lock:
            if self.process is not None:
                self.process.terminate()
        self.worker.shutdown(wait=False, cancel_futures=True)

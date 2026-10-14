"""Local sheet recognition jobs; originals and book page selections stay on this Mac."""
import io
import hashlib
import json
import os
import platform
import shutil
import re
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 20 * 1024 * 1024



def audiveris_runtime(root=ROOT, system=None):
    tools = Path(root) / 'tools'
    if (system or platform.system()) == 'Darwin':
        contents = tools / 'Audiveris.app/Contents'
        java = contents / 'runtime/Contents/Home/bin/java'
        jars = contents / 'app'
    else:
        jars = tools / 'audiveris/lib'
        java = tools / 'java25/bin/java'
        if not java.is_file():
            java_home = os.environ.get('JAVA_HOME')
            external = Path(java_home) / 'bin/java' if java_home else Path(shutil.which('java') or '/not-installed/java')
            java = external
    if java.is_file() and jars.is_dir() and any(jars.glob('*.jar')):
        return java, jars
    return None


def audiveris_command(source, destination, pages, runtime_home, root=ROOT, system=None, recognition='standard'):
    if recognition not in ('standard', 'jazz'):
        raise ValueError('Choose standard or jazz print recognition.')
    runtime = audiveris_runtime(root, system)
    if runtime is None:
        raise ValueError('Audiveris is not installed. Run scripts/install.sh --with-sheets on the piano computer.')
    java, jars = runtime
    command = [str(java), '-Xmx2G', '-Djava.awt.headless=true', '-Duser.home=' + str(runtime_home), '--enable-native-access=ALL-UNNAMED', '--add-exports=java.desktop/sun.awt.image=ALL-UNNAMED', '-cp', str(jars / '*'), 'Audiveris', '-batch', '-transcribe', '-export', '-output', str(destination)]
    command += ['-constant', 'org.audiveris.omr.ui.symbol.MusicFont.defaultMusicFamily=' + ('FinaleJazz' if recognition == 'jazz' else 'Bravura')]
    if pages:
        command += ['-sheets'] + [str(number) for number in pages]
    return command + ['--', str(source)]


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


def recognition_warning(log):
    messages = []
    if 'no correct rhythm' in log:
        messages.append('Recognition reported unresolved rhythms. Check the timing before playing.')
    if 'No timeOffset' in log:
        messages.append('Some notes or rests could not be placed in time and may be missing.')
    return ' '.join(messages)


class SheetStore:
    def __init__(self, root, library):
        self.folder = Path(root).resolve() / 'sheets'
        self.folder.mkdir(parents=True, exist_ok=True)
        self.library = library
        self.lock = threading.RLock()
        self.state = self.folder / 'index.json'
        self.items = json.loads(self.state.read_text()) if self.state.exists() else []
        self.process = None
        self.analysis_process = None
        self.analysis_closed = False
        self.analysis_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='book-analysis')
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='sheet-conversion')
        for item in self.items:
            if item['status'] in ('queued', 'converting'):
                item.update(status='error', error='Conversion was interrupted. Upload or select the pages again.')
            if item.get('analysis_status') in ('queued', 'analyzing'):
                item.update(analysis_status='error', analysis_error='Book analysis was interrupted. Analyze it again.')
            log = self.folder / item['id'] / 'conversion.log'
            if item['status'] == 'ready' and log.is_file():
                warning = recognition_warning(log.read_text(errors='replace'))
                if warning and warning not in item.get('warning', ''):
                    item['warning'] = ' '.join(filter(None, [item.get('warning'), warning]))
        self._merge_duplicate_books()
        self._save()

    def _merge_duplicate_books(self):
        originals = {}
        for item in self.items:
            if item.get('book_id') or item.get('deleted_by') or item['extension'] != '.pdf':
                continue
            source = self.folder / item['id'] / 'source.pdf'
            if not source.is_file():
                continue
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            item['source_hash'] = digest
            previous = originals.get(digest)
            if previous is None:
                originals[digest] = item
                continue
            for child in self.items:
                if child.get('book_id') == item['id']:
                    child['book_id'] = previous['id']
            if previous.get('analysis_status') != 'ready' and item.get('analysis_status') == 'ready':
                for key in ('analysis_status', 'analysis_progress', 'analysis_error', 'analysis_warnings', 'candidates', 'music_pages', 'skipped_pages', 'recognition_hint'):
                    if key in item:
                        previous[key] = item[key]
            item['deleted_by'] = item['id']

    def _save(self):
        temporary = self.state.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.items, ensure_ascii=False))
        os.replace(temporary, self.state)

    def snapshot(self):
        with self.lock:
            return {'items': [dict(x, can_delete=not self._busy_group(x['id'])) for x in reversed(self.items) if not x.get('deleted_by')],
                    'song_sources': [{'song_id': item['song_id'], 'source_id': item.get('book_id', item['id']),
                                      'pages': item.get('pages', []), 'warning': item.get('warning', ''),
                                      'item_id': item['id'], 'recognition': item.get('recognition', 'standard')}
                                     for item in self.items if item.get('song_id')],
                    'available': audiveris_runtime() is not None}

    def _item(self, identity, include_deleted=False):
        item = next((x for x in self.items if x['id'] == identity), None)
        if item is None or item.get('deleted_by') and not include_deleted:
            raise ValueError('This sheet is no longer available.')
        return item

    def _group(self, identity):
        return [item for item in self.items if item['id'] == identity or item.get('book_id') == identity]

    def _busy_group(self, identity):
        return any(item['status'] in ('queued', 'converting') or item.get('analysis_status') in ('queued', 'analyzing')
                   for item in self._group(identity) if not item.get('deleted_by'))

    def delete(self, identity):
        with self.lock:
            self._item(identity)
            if self._busy_group(identity):
                raise ValueError('Wait for this file to finish processing before deleting it.')
            for item in self._group(identity):
                if not item.get('deleted_by'):
                    item['deleted_by'] = identity
            self._save()

    def restore(self, identity):
        with self.lock:
            item = self._item(identity, include_deleted=True)
            if item.get('deleted_by') != identity:
                raise ValueError('This file cannot be restored separately.')
            if item.get('book_id'):
                self._item(item['book_id'])
            for member in self.items:
                if member.get('deleted_by') == identity:
                    del member['deleted_by']
            self._save()

    def source(self, identity):
        with self.lock:
            item = self._item(identity)
            parent = self._item(item.get('book_id', identity))
            return self.folder / parent['id'] / ('source' + parent['extension']), parent['filename']

    def recognized_score(self, song_id):
        with self.lock:
            item = next((item for item in self.items if item.get('song_id') == song_id), None)
            if item is None:
                raise ValueError('No recognized score is available for this song.')
            _, song = self.library.select(song_id)
            destination = self.folder / item['id']
            if item['extension'] in ('.xml', '.musicxml', '.mxl'):
                parent = self._item(item.get('book_id', item['id']), include_deleted=True)
                source = self.folder / parent['id'] / ('source' + parent['extension'])
                xml = score_bytes(source)
            else:
                scores = sorted(destination.rglob('*.mxl')) + sorted(destination.rglob('*.musicxml'))
                if len(scores) != 1:
                    raise ValueError('The recognized score is no longer available.')
                xml = score_bytes(scores[0], generated=True)
            return xml, Path(song['name']).stem + '.musicxml'

    def _book(self, identity):
        item = self._item(identity)
        parent = self._item(item.get('book_id', identity))
        if parent['extension'] != '.pdf':
            raise ValueError('Choose a PDF book.')
        return parent

    def book(self, identity):
        with self.lock:
            return dict(self._book(identity))

    def analyse_book(self, identity):
        with self.lock:
            book = self._book(identity)
            if self.analysis_closed:
                raise ValueError('Book analysis is stopping. Restart the app.')
            if book.get('analysis_status') in ('queued', 'analyzing', 'ready'):
                return dict(book)
            book.update(analysis_status='queued', analysis_progress={'done': 0, 'total': book['page_count']},
                        analysis_error='', candidates=[], music_pages=[], skipped_pages=[], analysis_warnings=[])
            self._save()
            result = dict(book)
        self.analysis_worker.submit(self._analyse, book['id'])
        return result

    def _analyse(self, identity):
        timer = None
        process = None
        try:
            with self.lock:
                if self.analysis_closed:
                    return
                book = self._book(identity)
                book['analysis_status'] = 'analyzing'
                self._save()
            source, _ = self.source(identity)
            command = [sys.executable, '-m', 'backend.book_analysis', 'analyse', str(source), str(ROOT / 'tools/tessdata')]
            # PyMuPDF explicitly does not support multithreading. Only the child touches PDFs.
            with (self.folder / identity / 'analysis.log').open('wb') as log:
                with self.lock:
                    if self.analysis_closed:
                        return
                    process = subprocess.Popen(command, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=log, text=True)
                    self.analysis_process = process
                timer = threading.Timer(300, process.kill)
                timer.daemon = True
                timer.start()
                result, error = None, ''
                for line in process.stdout:
                    message = json.loads(line)
                    if 'progress' in message:
                        with self.lock:
                            book['analysis_progress'] = message['progress']
                            self._save()
                    elif 'result' in message:
                        result = message['result']
                    elif 'error' in message:
                        error = message['error']
                code = process.wait()
            if code or result is None:
                raise ValueError(error or 'Book analysis did not finish. Try again or choose the pages manually.')
            with self.lock:
                book.update(result, analysis_status='ready', analysis_error='')
                self._save()
        except Exception as error:
            with self.lock:
                book = self._book(identity)
                book.update(analysis_status='error', analysis_error=str(error)[:400] or 'Unable to analyze this book.')
                self._save()
        finally:
            if timer:
                timer.cancel()
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()
            with self.lock:
                self.analysis_process = None

    def page_preview(self, identity, page):
        with self.lock:
            book = dict(self._book(identity))
            if type(page) is not int or not 1 <= page <= book['page_count']:
                raise ValueError('Choose a page inside this book.')
        source, _ = self.source(book['id'])
        folder = self.folder / book['id'] / 'previews'
        folder.mkdir(exist_ok=True)
        target = folder / (str(page) + '.png')
        if target.is_file():
            return target.read_bytes()
        try:
            result = subprocess.run([sys.executable, '-m', 'backend.book_analysis', 'preview', str(source), str(page)],
                                    cwd=str(ROOT), capture_output=True, timeout=20)
        except subprocess.TimeoutExpired:
            raise ValueError('Page preview took too long. Download the original PDF to inspect it.') from None
        if result.returncode or not result.stdout.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('This page could not be previewed. Download the original PDF to inspect it.')
        # Cache only a few rendered pages per book, never an entire 500-page volume.
        with self.lock:
            for old in sorted(folder.glob('*.png'), key=lambda path: path.stat().st_mtime)[:-11]:
                old.unlink(missing_ok=True)
            temporary = folder / (str(page) + '-' + uuid.uuid4().hex + '.tmp')
            temporary.write_bytes(result.stdout)
            os.replace(temporary, target)
        return result.stdout

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
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            for existing in self.items:
                if existing.get('book_id') or existing.get('deleted_by') or existing['extension'] != ext:
                    continue
                if not existing.get('source_hash'):
                    original = self.folder / existing['id'] / ('source' + ext)
                    if original.is_file():
                        existing['source_hash'] = hashlib.sha256(original.read_bytes()).hexdigest()
                if existing.get('source_hash') == digest:
                    if pieces:
                        self.convert_book(existing['id'], pieces)
                    return dict(existing, reused=True)
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
            item = {'id': identity, 'name': Path(name).stem or 'Sheet music', 'filename': name, 'extension': ext, 'page_count': count, 'status': status, 'created': time.time(), 'song_id': None, 'error': '', 'source_hash': digest}
            self.items.append(item)
            self._save()
        if status == 'queued':
            self.worker.submit(self._convert, identity)
        else:
            self.analyse_book(identity)
            if pieces:
                self.convert_book(identity, pieces)
        return dict(item)

    def convert_book(self, identity, pieces, recognition=None):
        with self.lock:
            book = self._item(identity)
            if book['extension'] != '.pdf' or book.get('book_id'):
                raise ValueError('Choose a PDF book.')
            recognition = recognition or 'standard'
            if recognition not in ('standard', 'jazz'):
                raise ValueError('Choose standard or jazz print recognition.')
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
                item = {'id': uuid.uuid4().hex, 'name': name, 'filename': book['filename'], 'extension': '.pdf', 'page_count': len(pages), 'pages': pages, 'book_id': identity, 'status': 'queued', 'created': time.time(), 'song_id': None, 'error': '', 'recognition': recognition}
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
                command = audiveris_command(source, destination, item.get('pages'), self.folder / 'runtime', recognition=item.get('recognition', 'standard'))
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
            log = destination / 'conversion.log'
            if log.is_file():
                warning = ' '.join(filter(None, [warning, recognition_warning(log.read_text(errors='replace'))]))
            from music21 import harmony
            if list(score.recurse().getElementsByClass(harmony.ChordSymbol)):
                warning = ' '.join(filter(None, [warning, 'This lead sheet contains chord names. MIDI follows the written notes; full accompaniment is not generated.']))
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
            self.analysis_closed = True
            if self.analysis_process is not None:
                self.analysis_process.terminate()
            if self.process is not None:
                self.process.terminate()
        self.analysis_worker.shutdown(wait=False, cancel_futures=True)
        self.worker.shutdown(wait=False, cancel_futures=True)

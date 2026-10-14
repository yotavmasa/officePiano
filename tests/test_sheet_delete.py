"""Sheet removal keeps originals and converted songs, and supports undo."""
import io
import sys
import struct
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if sys.prefix == sys.base_prefix:
    sys.path.insert(0, str(ROOT / 'vendor'))
from pypdf import PdfWriter

from backend.library import Library
from backend.sheets import SheetStore, recognition_warning


class SheetDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Library(self.temp.name)
        self.store = SheetStore(Path(self.temp.name) / 'data', self.library)
        self.store.items = [
            {'id': 'book', 'name': 'Book', 'filename': 'Book.pdf', 'extension': '.pdf', 'status': 'needs_pages', 'page_count': 3},
            {'id': 'first', 'book_id': 'book', 'name': 'First', 'status': 'ready', 'song_id': 'saved-midi'},
            {'id': 'second', 'book_id': 'book', 'name': 'Second', 'status': 'error'},
        ]
        folder = self.store.folder / 'book'
        folder.mkdir()
        self.original = folder / 'source.pdf'
        self.original.write_bytes(b'original PDF bytes')
        self.store._save()

    def tearDown(self):
        self.store.shutdown()
        self.store.analysis_worker.shutdown(wait=True)
        self.store.worker.shutdown(wait=True)
        self.library.db.close()
        self.temp.cleanup()

    def test_book_removal_and_restore_keep_original_and_song_identity(self):
        self.store.delete('book')
        self.assertEqual(self.store.snapshot()['items'], [])
        self.assertEqual(self.original.read_bytes(), b'original PDF bytes')
        with self.assertRaises(ValueError):
            self.store.source('book')
        with self.assertRaises(ValueError):
            self.store.book('first')
        with self.assertRaises(ValueError):
            self.store.restore('first')
        self.store.restore('book')
        self.assertEqual(len(self.store.snapshot()['items']), 3)
        self.assertEqual(self.store._item('first')['song_id'], 'saved-midi')
        self.assertEqual(self.store.source('first')[0], self.original)

    def test_previous_child_deletion_is_not_undone_with_book(self):
        self.store.delete('second')
        self.store.delete('book')
        self.store.restore('book')
        self.assertEqual({item['id'] for item in self.store.snapshot()['items']}, {'book', 'first'})
        self.store.restore('second')
        self.assertEqual(len(self.store.snapshot()['items']), 3)
        self.store.delete('book')
        reopened = SheetStore(Path(self.temp.name) / 'data', self.library)
        try:
            self.assertEqual(reopened.snapshot()['items'], [])
            reopened.restore('book')
            self.assertEqual(len(reopened.snapshot()['items']), 3)
        finally:
            reopened.shutdown()
            reopened.analysis_worker.shutdown(wait=True)
            reopened.worker.shutdown(wait=True)

    def test_duplicate_book_migration_keeps_conversion_entries(self):
        duplicate = dict(self.store._item('book'), id='duplicate')
        self.store.items.extend([duplicate, {'id': 'third', 'book_id': 'duplicate', 'name': 'Third', 'status': 'ready', 'song_id': 'other-midi'}])
        folder = self.store.folder / 'duplicate'
        folder.mkdir()
        (folder / 'source.pdf').write_bytes(self.original.read_bytes())
        self.store._save()
        reopened = SheetStore(Path(self.temp.name) / 'data', self.library)
        try:
            books = [item for item in reopened.snapshot()['items'] if not item.get('book_id')]
            self.assertEqual([item['id'] for item in books], ['book'])
            self.assertEqual(reopened._item('third')['book_id'], 'book')
            self.assertEqual(reopened._item('third')['song_id'], 'other-midi')
            self.assertTrue((folder / 'source.pdf').is_file())
        finally:
            reopened.shutdown()
            reopened.analysis_worker.shutdown(wait=True)
            reopened.worker.shutdown(wait=True)

    def test_identical_uploads_reuse_one_record_even_concurrently(self):
        writer = PdfWriter()
        writer.add_blank_page(612, 792)
        output = io.BytesIO()
        writer.write(output)
        data = output.getvalue()
        with patch.object(self.store, 'analyse_book'), ThreadPoolExecutor(max_workers=2) as worker:
            uploads = list(worker.map(lambda name: self.store.submit(data, name), ['First.pdf', 'Renamed.pdf']))
        self.assertEqual(uploads[0]['id'], uploads[1]['id'])
        self.assertEqual(sum(bool(item.get('reused')) for item in uploads), 1)
        self.store.delete(uploads[0]['id'])
        with patch.object(self.store, 'analyse_book'):
            restored_upload = self.store.submit(data, 'First.pdf')
        self.assertNotEqual(restored_upload['id'], uploads[0]['id'])

    def test_grouping_retains_sources_after_entry_removal(self):
        self.store.delete('first')
        source = next(source for source in self.store.snapshot()['song_sources'] if source['song_id'] == 'saved-midi')
        self.assertEqual(source['source_id'], 'book')
        self.assertNotIn('first', [item['id'] for item in self.store.snapshot()['items']])

    def test_recognition_style_is_validated_and_saved(self):
        with patch.object(self.store.worker, 'submit'):
            children = self.store.convert_book('book', [{'name': 'Jazz piece', 'pages': '1'}], 'jazz')['items']
        self.assertEqual(children[0]['recognition'], 'jazz')
        with self.assertRaises(ValueError):
            self.store.convert_book('book', [{'name': 'Bad', 'pages': '2'}], 'unknown')

    def test_editable_score_stays_available_when_source_is_removed(self):
        track = bytes.fromhex('00c00000903c4030803c0000ff2f00')
        midi = b'MThd' + struct.pack('>IHHH', 6, 0, 1, 96) + b'MTrk' + struct.pack('>I', len(track)) + track
        song = self.library.add(midi, 'Score.mid', source_kind='sheet')
        item = {'id': 'xml', 'name': 'Score', 'filename': 'Score.musicxml', 'extension': '.musicxml', 'status': 'ready', 'song_id': song['id']}
        self.store.items.append(item)
        folder = self.store.folder / 'xml'
        folder.mkdir()
        xml = b'<score-partwise version="4.0"><part-list/></score-partwise>'
        (folder / 'source.musicxml').write_bytes(xml)
        self.assertEqual(self.store.recognized_score(song['id'])[0], xml)
        self.store.delete('xml')
        self.assertEqual(self.store.recognized_score(song['id']), (xml, 'Score.musicxml'))
        with self.assertRaises(ValueError):
            self.store.recognized_score('missing')

    def test_rhythm_failures_are_reported_without_claiming_correctness(self):
        self.assertEqual(recognition_warning('Successfully converted'), '')
        warning = recognition_warning('MeasureStack#1 no correct rhythm\nNo timeOffset for HeadChordInter')
        self.assertIn('unresolved rhythms', warning)
        self.assertIn('may be missing', warning)

    def test_busy_book_rejects_removal_without_changes(self):
        for field, value in (('status', 'queued'), ('status', 'converting'), ('analysis_status', 'analyzing')):
            item = self.store._item('first')
            previous = item.get(field)
            item[field] = value
            book = next(item for item in self.store.snapshot()['items'] if item['id'] == 'book')
            self.assertFalse(book['can_delete'])
            with self.assertRaisesRegex(ValueError, 'finish processing'):
                self.store.delete('book')
            self.assertEqual(len(self.store.snapshot()['items']), 3)
            if previous is None:
                del item[field]
            else:
                item[field] = previous
        with self.assertRaises(ValueError):
            self.store.delete('../unknown')

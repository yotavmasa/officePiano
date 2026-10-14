"""Book detection is a review step and never adds or queues MIDI automatically."""
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'vendor')]
import pymupdf
from PIL import Image
from backend import book_analysis
from backend.library import Library
from backend.sheets import SheetStore


def staff(page, title='', number=1):
    if title:
        page.insert_textbox(pymupdf.Rect(80, 20, 520, 65), title, fontsize=18, align=1)
    page.insert_text((25, 35), str(number), fontsize=10)
    for top in (110, 240):
        for line in range(5):
            page.draw_line(pymupdf.Point(45, top + line * 6), pymupdf.Point(550, top + line * 6), width=.65)
        for x in (110, 190, 270, 350):
            page.draw_circle(pymupdf.Point(x, top + 12), 3, fill=(0, 0, 0))
            page.draw_line(pymupdf.Point(x + 3, top + 12), pymupdf.Point(x + 3, top - 10))


def fixture(path, raster=False):
    with pymupdf.open() as document:
        cover = document.new_page(width=600, height=780)
        cover.insert_text((100, 100), 'Music Book', fontsize=28)
        contents = document.new_page(width=600, height=780)
        contents.insert_text((60, 70), 'Contents', fontsize=18)
        contents.insert_text((60, 120), '1612.....................3\nSecond Song..............5', fontsize=13)
        staff(document.new_page(width=600, height=780), '1612', 3)
        staff(document.new_page(width=600, height=780), '', 4)
        staff(document.new_page(width=600, height=780), 'Second Song', 5)
        if raster:
            with pymupdf.open() as scanned:
                for page in document:
                    target = scanned.new_page(width=page.rect.width, height=page.rect.height)
                    target.insert_image(target.rect, pixmap=page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)))
                scanned.save(path)
        else:
            document.save(path)


class AnalysisTests(unittest.TestCase):
    def test_vector_book_groups_continuations_and_ignores_cover_contents(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'book.pdf'
            fixture(path)
            progress = []
            result = book_analysis.analyse(path, progress=lambda done, total: progress.append((done, total)))
            self.assertEqual(result['skipped_pages'], [1, 2])
            self.assertEqual(result['music_pages'], [3, 4, 5])
            self.assertEqual([(item['title'], item['pages']) for item in result['candidates']], [('1612', [3, 4]), ('Second Song', [5])])
            self.assertTrue(all(item['confidence'] == 'high' for item in result['candidates']))
            self.assertEqual(progress[-1], (5, 5))
            self.assertEqual(result['candidates'], book_analysis.analyse(path)['candidates'])

    def test_staff_detection_on_scanned_pages_without_ocr_is_reviewable(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'scan.pdf'
            fixture(path, raster=True)
            result = book_analysis.analyse(path)
            self.assertEqual(result['skipped_pages'], [1, 2])
            self.assertEqual(result['music_pages'], [3, 4, 5])
            self.assertTrue(result['candidates'])
            self.assertTrue(all(item['confidence'] == 'review' for item in result['candidates']))

    def test_scanned_heading_ocr_when_local_model_is_available(self):
        tessdata = ROOT / 'tools/tessdata'
        if not (tessdata / 'eng.traineddata').is_file():
            self.skipTest('Optional local English OCR model is not installed.')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'scan.pdf'
            fixture(path, raster=True)
            result = book_analysis.analyse(path, tessdata=tessdata)
            self.assertEqual([(item['title'], item['pages']) for item in result['candidates']], [('1612', [3, 4]), ('Second Song', [5])])
            self.assertTrue(all(item['confidence'] == 'review' for item in result['candidates']))

    def test_contents_parser_is_bounded_for_positioned_music_text(self):
        start = time.monotonic()
        self.assertEqual(book_analysis.toc_entries('notes' + ' ' * 10000 + '25'), [])
        self.assertLess(time.monotonic() - start, .2)
        self.assertEqual(book_analysis.toc_entries('1612.......4\nAnimal Spirits.......6'), [('1612', 4), ('Animal Spirits', 6)])
        self.assertEqual(book_analysis.clean_title('Christmas in L.A.'), 'Christmas in L.A.')

    def test_preview_is_png_bounded_and_validates_page(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'book.pdf'
            fixture(path)
            png = book_analysis.preview(path, 3)
            with Image.open(io.BytesIO(png)) as image:
                self.assertEqual(image.format, 'PNG')
                self.assertLessEqual(max(image.size), 1400)
            for page in (0, 6, True, '3'):
                with self.assertRaises(ValueError):
                    book_analysis.preview(path, page)

    def test_uploaded_book_analyzes_in_child_and_does_not_add_midi(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'fixture.pdf'
            fixture(path)
            library = Library(root)
            store = SheetStore(root / 'data', library)
            try:
                book = store.submit(path.read_bytes(), 'Book.pdf')
                with patch.object(store.analysis_worker, 'submit') as schedule:
                    store.analyse_book(book['id'])
                    schedule.assert_not_called()
                for _ in range(100):
                    current = store.book(book['id'])
                    if current.get('analysis_status') in ('ready', 'error'):
                        break
                    time.sleep(.02)
                self.assertEqual(current['analysis_status'], 'ready', current)
                self.assertEqual(current['status'], 'needs_pages')
                self.assertEqual(len(current['candidates']), 2)
                self.assertEqual(library.snapshot()['songs'], [])
                self.assertEqual(store.source(book['id'])[0].read_bytes(), path.read_bytes())
                preview = store.page_preview(book['id'], 3)
                self.assertEqual(preview, store.page_preview(book['id'], 3))
                with self.assertRaises(ValueError):
                    store.page_preview(book['id'], 0)
            finally:
                store.shutdown()
                store.analysis_worker.shutdown(wait=True)
                store.worker.shutdown(wait=True)
                library.db.close()
            reopened_library = Library(root)
            reopened = SheetStore(root / 'data', reopened_library)
            try:
                self.assertEqual(reopened.book(book['id'])['candidates'], current['candidates'])
            finally:
                reopened.shutdown()
                reopened.analysis_worker.shutdown(wait=True)
                reopened.worker.shutdown(wait=True)
                reopened_library.db.close()

    def test_actual_user_book_when_available(self):
        supplied = os.environ.get('PIANO_TEST_BOOK')
        if not supplied:
            self.skipTest('Set PIANO_TEST_BOOK to run the optional local reference-book check.')
        path = Path(supplied)
        if not path.is_file():
            self.skipTest('The optional local reference book is unavailable.')
        result = book_analysis.analyse(path)
        self.assertEqual(result['skipped_pages'], [1, 2, 3])
        self.assertEqual(result['music_pages'], list(range(4, 26)))
        self.assertEqual(len(result['candidates']), 13)
        self.assertEqual([(item['title'], item['pages']) for item in result['candidates'][:3]], [('1612', [4, 5]), ('Animal Spirits', [6, 7]), ('Aunt Leslie', [8])])
        self.assertEqual(result['candidates'][-1]['pages'], [24, 25])


if __name__ == '__main__':
    unittest.main()

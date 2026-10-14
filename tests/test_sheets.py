import io,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'vendor')]
from backend.sheets import SheetStore,page_numbers,xml_score,write_score_midi
from backend.library import Library,parse_midi
from pypdf import PdfWriter
from music21 import stream,note,repeat

class SheetTests(unittest.TestCase):
    def test_two_named_book_songs_share_original_and_have_separate_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            library=Library(folder);store=SheetStore(Path(folder)/'data',library)
            try:
                writer=PdfWriter();writer.add_blank_page(612,792);writer.add_blank_page(612,792)
                output=io.BytesIO();writer.write(output);source=output.getvalue()
                book=store.submit(source,'Two songs.pdf')
                self.assertEqual(book['page_count'],2)
                self.assertEqual(store.source(book['id'])[0].read_bytes(),source)
                def convert(identity):
                    with store.lock:
                        item=store._item(identity)
                        score=stream.Stream();score.append(note.Note('C4' if item['pages']==[1] else 'E4'))
                        path=Path(folder)/(identity+'.mid');score.write('midi',fp=str(path))
                        song=library.add(path.read_bytes(),item['name'],source_kind='sheet')
                        item.update(status='ready',song_id=song['id']);store._save()
                store._convert=convert
                children=store.convert_book(book['id'],[{'name':'First','pages':'1'},{'name':'Second','pages':'2'}])['items']
                for _ in range(100):
                    if all(store._item(x['id'])['status']=='ready' for x in children):break
                    time.sleep(.02)
                result=[store._item(x['id']) for x in children]
                self.assertTrue(all(item['status']=='ready' for item in result))
                self.assertEqual(len({item['song_id'] for item in result}),2)
                self.assertTrue(all(song['source_kind']=='sheet' for song in library.snapshot()['songs']))
                with self.assertRaises(ValueError):store.convert_book(book['id'],[{'name':'A','pages':'1-2'},{'name':'B','pages':'2'}])
                for pages in ('0','3','1,1','2-1'):
                    with self.assertRaises(ValueError):page_numbers(pages,2)
                for data in (b'<!DOCTYPE x><score-partwise/>',b'<!ENTITY x "a"><score-partwise/>'):
                    with self.assertRaises(ValueError):xml_score(data)
            finally:
                store.shutdown();store.worker.shutdown(wait=True);store.analysis_worker.shutdown(wait=True);library.db.close()
    def test_bad_repeats_keep_written_notes_and_return_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            score=stream.Score();part=stream.Part();part.append(note.Note('C4'));part.append(note.Note('E4'));score.insert(0,part)
            path=Path(directory)/'converted.mid'
            with patch.object(score,'write',side_effect=repeat.ExpanderException('bad repeats')):
                warning=write_score_midi(score,path)
            self.assertIn('written notes once',warning)
            self.assertEqual(parse_midi(path.read_bytes(),piano_only=False)['notes'],2)

if __name__=='__main__':unittest.main()

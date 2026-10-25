import sys
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'vendor')]
import mido
import io
import json
from backend.library import Library
from backend import artwork

def midi(note, tags=False):
    score=mido.MidiFile();track=mido.MidiTrack();score.tracks.append(track)
    if tags:track.append(mido.MetaMessage('text',text='Artist: Tagged Artist\nAlbum: Tagged Album'))
    track.extend([mido.Message('note_on',note=note,velocity=64),mido.Message('note_off',note=note,time=480)])
    out=io.BytesIO();score.save(file=out);return out.getvalue()

class MetadataOrderTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.lib=Library(self.temp.name)
    def tearDown(self):
        self.lib.db.close();self.temp.cleanup()
    def test_metadata_inference_edits_and_cover_do_not_overwrite_manual_choice(self):
        song=self.lib.add(midi(60),'Billy_Joel_-_Piano_Man.mid')
        self.assertEqual(song['artist'],'Billy Joel')
        tagged=self.lib.add(midi(61,True),'Other.mid')
        self.assertEqual((tagged['artist'],tagged['album']),('Tagged Artist','Tagged Album'))
        self.lib.fill_metadata(song['id'],'Billy Joel','The Stranger')
        self.assertEqual(self.lib.select(song['id'])[1]['album'],'The Stranger')
        self.lib.mutate({'action':'edit_song','song_id':song['id'],'name':'Piano Man','artist':'Billy Joel','album':''})
        self.lib.fill_metadata(song['id'],'Other Artist','Wrong Album')
        edited=self.lib.select(song['id'])[1]
        self.assertEqual((edited['name'],edited['artist'],edited['album']),('Piano Man','Billy Joel',''))
        self.assertEqual(self.lib.select(song['id'])[0],midi(60))
        with self.assertRaises(ValueError):self.lib.mutate({'action':'edit_song','song_id':song['id'],'name':'Name','artist':'a'*201,'album':''})
        self.assertEqual(self.lib.select(song['id'])[1]['name'],'Piano Man')
        _,title,artist=artwork._identity({'name':'Billy Joel - Piano Man.mid','artist':'Billy Joel','album':'Piano Man'})
        self.assertEqual(title,'Piano Man');self.assertEqual(artist,['billy','joel'])
    def test_collection_order_is_independent_and_persists(self):
        songs=[self.lib.add(midi(n),str(n)) for n in (60,61,62)]
        ordered=[song['id'] for song in songs]
        self.lib.mutate({'action':'reorder','song_ids':ordered})
        identity=self.lib.mutate({'action':'create','name':'Jazz'})['libraries'][0]['id']
        for song in songs:self.lib.mutate({'action':'assign','song_id':song['id'],'library_id':identity})
        self.lib.mutate({'action':'reorder','library_id':identity,'song_ids':ordered[::-1]})
        self.assertEqual([s['id'] for s in self.lib.snapshot()['songs']],ordered)
        self.assertEqual(self.lib.snapshot()['libraries'][0]['song_ids'],ordered[::-1])
        with self.assertRaises(ValueError):self.lib.mutate({'action':'reorder','library_id':identity,'song_ids':ordered[:-1]})
        self.lib.db.close();self.lib=Library(self.temp.name)
        self.assertEqual(self.lib.snapshot()['libraries'][0]['song_ids'],ordered[::-1])

if __name__=='__main__':unittest.main()


class ChannelCountTests(unittest.TestCase):
    def test_counts_channels_with_notes_and_backfills_older_songs(self):
        score=mido.MidiFile();track=mido.MidiTrack();score.tracks.append(track)
        track.extend([mido.Message('program_change',channel=3,program=40),
                      mido.Message('note_on',channel=0,note=60,velocity=64),mido.Message('note_on',channel=1,note=64,velocity=64),
                      mido.Message('note_on',channel=9,note=36,velocity=64),mido.Message('note_off',channel=0,note=60,time=480),
                      mido.Message('note_off',channel=1,note=64),mido.Message('note_off',channel=9,note=36)])
        out=io.BytesIO();score.save(file=out)
        with tempfile.TemporaryDirectory() as folder:
            lib=Library(folder)
            song=lib.add(out.getvalue(),'Band.mid')
            self.assertEqual(song['channels'],3)
            self.assertEqual(lib.add(midi(60),'Solo.mid')['channels'],1)
            with lib.db:
                for row in lib.db.execute('SELECT id,metadata FROM songs').fetchall():
                    metadata=json.loads(row['metadata']);metadata.pop('channels')
                    lib.db.execute('UPDATE songs SET metadata=? WHERE id=?',(json.dumps(metadata),row['id']))
            lib.db.close()
            reopened=Library(folder)
            self.assertEqual(sorted(item['channels'] for item in reopened.snapshot()['songs']),[1,3])
            reopened.db.close()


class LibraryDeleteTests(unittest.TestCase):
    def test_deleting_a_library_keeps_its_songs(self):
        with tempfile.TemporaryDirectory() as folder:
            lib=Library(folder)
            song=lib.add(midi(60),'Kept.mid')
            identity=lib.mutate({'action':'create','name':'Jazz'})['libraries'][0]['id']
            lib.mutate({'action':'assign','song_id':song['id'],'library_id':identity})
            with self.assertRaises(ValueError):lib.mutate({'action':'delete_library','library_id':'missing'})
            result=lib.mutate({'action':'delete_library','library_id':identity})
            self.assertEqual(result['libraries'],[])
            self.assertEqual([item['id'] for item in result['songs']],[song['id']])
            self.assertEqual(result['songs'][0]['library_ids'],[])
            lib.db.close()


class RecognitionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.lib=Library(self.temp.name)
        artwork.CACHE.clear();artwork.QUERY_CACHE.clear()
    def tearDown(self):
        self.lib.db.close();self.temp.cleanup();artwork.CACHE.clear();artwork.QUERY_CACHE.clear()

    def test_confident_match_renames_once_and_keeps_manual_edits(self):
        song=self.lib.add(midi(60),'tee-time-vulfpeck-tee-time.mid')
        edited=self.lib.add(midi(61),'Edited.mid')
        self.lib.mutate({'action':'edit_song','song_id':edited['id'],'name':'My name','artist':'','album':''})
        self.assertEqual(self.lib.pending_recognition()['id'],song['id'])
        found={'title':'Tee Time','artist':'Vulfpeck','album':'Mr. Finish Line','source':'Apple iTunes','url':'https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg'}
        renamed=self.lib.apply_recognition(song['id'],found)
        self.assertEqual((renamed['name'],renamed['artist'],renamed['album']),('Tee Time','Vulfpeck','Mr. Finish Line'))
        self.assertEqual(renamed['recognition']['original_name'],'tee-time-vulfpeck-tee-time.mid')
        self.assertEqual(renamed['recognition']['artwork'],found['url'])
        self.assertTrue((Path(self.temp.name)/'data'/'songs'/self.lib.select(song['id'])[1]['file_name']).exists())
        self.assertIsNone(self.lib.apply_recognition(song['id'],{'title':'Other'}))
        self.assertEqual(self.lib.select(song['id'])[1]['name'],'Tee Time')
        self.assertIsNone(self.lib.pending_recognition())
        self.assertIsNone(self.lib.apply_recognition(edited['id'],found))
        self.assertEqual(self.lib.select(edited['id'])[1]['name'],'My name')

    def test_no_match_is_recorded_without_changes(self):
        song=self.lib.add(midi(60),'beethoven_symphony_5.mid')
        self.assertIsNone(self.lib.apply_recognition(song['id'],{}))
        self.assertEqual(self.lib.select(song['id'])[1]['name'],'beethoven_symphony_5.mid')
        self.assertIsNone(self.lib.pending_recognition())

    def test_recognize_cleans_titles_and_reports_unreachable_search(self):
        item={'kind':'song','trackName':'Tee Time','artistName':'Vulfpeck','collectionName':'Mr. Finish Line',
              'artworkUrl100':'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg','trackViewUrl':'https://music.apple.com/us/album/x/1?i=2'}
        original=artwork._search
        try:
            artwork._search=lambda term:[item]
            found,reachable=artwork.recognize({'name':'tee-time-vulfpeck-tee-time.mid'})
            self.assertTrue(reachable)
            self.assertEqual((found['title'],found['artist']),('Tee Time','Vulfpeck'))
            self.assertEqual(artwork.clean_title('Let It Be - Remastered 2009'),'Let It Be')
            self.assertEqual(artwork.clean_title('Piano Man (2011 Remaster)'),'Piano Man')
            self.assertEqual(artwork.clean_title('Live and Let Die'),'Live and Let Die')
            artwork.CACHE.clear();artwork.QUERY_CACHE.clear()
            def offline(term):raise OSError('offline')
            artwork._search=offline
            self.assertEqual(artwork.recognize({'name':'tee-time-vulfpeck-tee-time.mid'}),({},False))
        finally:
            artwork._search=original


class ManualItunesTests(unittest.TestCase):
    def test_edit_details_saves_a_chosen_cover_as_a_manual_edit(self):
        with tempfile.TemporaryDirectory() as folder:
            lib=Library(folder)
            song=lib.add(midi(60),'thoughts-on-ray-vibrations-woody-goss.mid')
            cover='https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg'
            with self.assertRaises(ValueError):lib.mutate({'action':'edit_song','song_id':song['id'],'name':'X','artist':'','album':'','artwork':5})
            result=lib.mutate({'action':'edit_song','song_id':song['id'],'name':'Thoughts on Ray','artist':'Woody Goss','album':'Rainbow Beach','artwork':cover})
            saved=next(item for item in result['songs'] if item['id']==song['id'])
            self.assertEqual((saved['name'],saved['artist'],saved['album'],saved['metadata_edited']),('Thoughts on Ray','Woody Goss','Rainbow Beach',1))
            self.assertEqual((saved['recognition']['artwork'],saved['recognition']['original_name']),(cover,'thoughts-on-ray-vibrations-woody-goss.mid'))
            removed=lib.mutate({'action':'edit_song','song_id':song['id'],'name':'Thoughts on Ray','artist':'Woody Goss','album':'','artwork':''})
            again=next(item for item in removed['songs'] if item['id']==song['id'])
            self.assertEqual((again['recognition']['artwork'],again['recognition']['original_name']),('','thoughts-on-ray-vibrations-woody-goss.mid'))
            kept=lib.mutate({'action':'edit_song','song_id':song['id'],'name':'Thoughts','artist':'','album':''})
            self.assertEqual(next(item for item in kept['songs'] if item['id']==song['id'])['recognition']['artwork'],'')
            self.assertIsNone(lib.pending_recognition())
            lib.db.close()

    def test_candidates_list_choices_and_report_outages(self):
        item={'kind':'song','trackName':'Tee Time','artistName':'Vulfpeck','collectionName':'Mr. Finish Line',
              'artworkUrl100':'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg','trackViewUrl':'https://music.apple.com/us/album/x/1?i=2'}
        original=artwork._search
        artwork.QUERY_CACHE.clear()
        try:
            artwork._search=lambda term:[item,{'kind':'podcast'}]
            results=artwork.candidates('tee time')
            self.assertEqual([(r['title'],r['artist'],r['artwork'].endswith('600x600bb.jpg')) for r in results],[('Tee Time','Vulfpeck',True)])
            with self.assertRaises(ValueError):artwork.candidates('x'*121)
            artwork.QUERY_CACHE.clear()
            def offline(term):raise OSError('offline')
            artwork._search=offline
            with self.assertRaises(ValueError):artwork.candidates('tee time')
        finally:
            artwork._search=original;artwork.QUERY_CACHE.clear()

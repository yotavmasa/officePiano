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

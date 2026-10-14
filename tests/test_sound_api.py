import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT/'vendor'))
import mido
from backend import server
from backend.library import Library

def fixture(program=40):
    score=mido.MidiFile(); track=mido.MidiTrack(); score.tracks.append(track)
    track.extend([mido.Message('program_change',program=program),mido.Message('note_on',note=65,velocity=64),mido.Message('note_off',note=65,time=480)])
    drum=mido.MidiTrack(); score.tracks.append(drum)
    drum.extend([mido.Message('note_on',channel=9,note=36,velocity=90),mido.Message('note_off',channel=9,note=36,time=240)])
    output=io.BytesIO(); score.save(file=output); return output.getvalue()

class SoundTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.library=Library(self.temp.name)
        self.a=self.library.add(fixture(), 'Strings.mid'); self.b=self.library.add(fixture(0),'Piano.mid')
        self.calls=[]; self.loaded=None
        def send(request):
            self.calls.append(request)
            if request['action']=='load': self.loaded=Path(request['path']).read_bytes()
            return {'ok':True,'playing':False}
        self.patches=[patch.object(server,'LIBRARY',self.library),patch.object(server,'midi',send),patch.object(server,'QUEUE',None),patch.object(server,'SONG_ID',''),patch.object(server,'NAME',''),patch.object(server,'ADAPTATION_REPORT',{})]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.library.db.close();self.temp.cleanup()
    def change(self,song,mode,parts=None):
        return server.change_sound({'song_id':song,'expected_song_id':server.SONG_ID,'mode':mode,'parts':parts or []})
    def test_save_only_keeps_current_song_and_does_not_send_midi(self):
        server.load_song(self.b['id'])
        report = dict(server.ADAPTATION_REPORT)
        self.calls.clear()
        result = server.change_sound({'song_id': self.a['id'], 'expected_song_id': 'earlier-song', 'mode': 'smart', 'apply_now': False})
        self.assertTrue(result['ok'])
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'smart')
        self.assertEqual(server.SONG_ID, self.b['id'])
        self.assertEqual(server.ADAPTATION_REPORT, report)
        self.assertEqual(self.calls, [])
        server.load_song(self.a['id'])
        self.assertEqual(server.ADAPTATION_REPORT['mode'], 'smart')

    def test_save_only_current_song_does_not_reload_it(self):
        server.load_song(self.a['id'])
        self.calls.clear()
        server.change_sound({'song_id': self.a['id'], 'mode': 'custom', 'parts': ['0'], 'apply_now': False})
        self.assertEqual(self.calls, [])
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'custom')

    def test_choose_smart_saved_song_without_starting_music(self):
        original=self.library.select(self.a['id'])[0]
        result=self.change(self.a['id'],'smart')
        self.assertEqual(result['settings']['mode'],'smart')
        self.assertEqual([call['action'] for call in self.calls],['load'])
        notes=[message for track in mido.MidiFile(file=io.BytesIO(self.loaded)).tracks for message in track if message.type=='note_on' and message.velocity>0]
        self.assertEqual([message.note for message in notes],[65]); self.assertTrue(all(message.channel!=9 for message in notes))
        self.assertEqual(self.library.select(self.a['id'])[0],original)
        self.assertEqual(server.SONG_ID,self.a['id'])
    def test_custom_is_per_song_and_default_is_preserved(self):
        self.change(self.a['id'],'smart'); self.change(self.a['id'],'custom',['0'])
        self.assertEqual(server.sound_settings(self.a['id'])['mode'],'custom')
        self.assertEqual(server.sound_settings(self.b['id'])['mode'],'no_drums')
        server.load_song(self.b['id'])
        self.assertEqual(server.ADAPTATION_REPORT['mode'],'no_drums')
        server.load_song(self.a['id'])
        self.assertEqual(server.ADAPTATION_REPORT['mode'],'custom')
    def test_each_mode_is_saved_per_song_after_reload(self):
        self.change(self.a['id'], 'smart')
        self.change(self.b['id'], 'piano')
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'smart')
        server.load_song(self.a['id'])
        self.assertEqual(server.ADAPTATION_REPORT['mode'], 'smart')
        self.change(self.a['id'], 'original')
        server.load_song(self.b['id'])
        self.assertEqual(server.ADAPTATION_REPORT['mode'], 'piano')
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'original')
        self.change('', 'smart')
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'original')
        self.assertEqual(server.sound_settings(self.b['id'])['mode'], 'piano')
        reopened=Library(self.temp.name)
        self.assertEqual(reopened.get_setting('adaptation'), self.library.get_setting('adaptation'))
        reopened.db.close()

    def test_legacy_manual_selection_remains_available(self):
        self.library.set_setting('adaptation', {'mode':'smart','songs':{self.a['id']:['0']}})
        self.assertEqual(server.sound_settings(self.a['id'])['mode'], 'custom')
        self.assertEqual(server.sound_settings(self.a['id'])['parts'], ['0'])

    def test_rename_preserves_membership_and_rejects_duplicates(self):
        snap=self.library.mutate({'action':'create','name':'Jazz'})
        identity=snap['libraries'][0]['id']
        self.library.mutate({'action':'assign','song_id':self.a['id'],'library_id':identity})
        snap=self.library.mutate({'action':'rename','library_id':identity,'name':'Evening'})
        self.assertEqual(snap['libraries'][0]['name'], 'Evening')
        self.assertIn(identity,next(song for song in snap['songs'] if song['id']==self.a['id'])['library_ids'])
        self.library.mutate({'action':'create','name':'Morning'})
        with self.assertRaises(ValueError): self.library.mutate({'action':'rename','library_id':identity,'name':'Morning'})
        with self.assertRaises(ValueError): self.library.mutate({'action':'rename','library_id':'missing','name':'No'})

    def test_rename_song_preserves_identity_bytes_settings_and_membership(self):
        original=self.library.select(self.a['id'])[0]
        self.change(self.a['id'],'smart')
        old_path=self.library.saved_folder / self.a['file_name']
        snap=self.library.mutate({'action':'create','name':'Test'})
        folder=snap['libraries'][0]['id']
        self.library.mutate({'action':'assign','song_id':self.a['id'],'library_id':folder})
        self.library.mutate({'action':'favorite','song_id':self.a['id'],'value':True})
        self.library.set_setting('queue',{'song_ids':[self.a['id']],'index':0})
        snap=self.library.mutate({'action':'rename_song','song_id':self.a['id'],'name':'New Song'})
        song=next(song for song in snap['songs'] if song['id']==self.a['id'])
        self.assertEqual(song['name'],'New Song')
        self.assertTrue(song['favorite']);self.assertIn(folder,song['library_ids'])
        self.assertFalse(old_path.exists())
        self.assertEqual((self.library.saved_folder/song['file_name']).read_bytes(),original)
        self.assertEqual(self.library.select(self.a['id'])[0],original)
        self.assertEqual(server.sound_settings(self.a['id'])['mode'],'smart')
        self.assertEqual(self.library.get_setting('queue')['song_ids'],[self.a['id']])
        self.library.mutate({'action':'delete','song_id':self.a['id']})
        self.library.mutate({'action':'restore','song_id':self.a['id']})
        self.assertTrue((self.library.saved_folder/song['file_name']).exists())
        for name in ['', ' '*3, 'x'*201, None]:
            with self.assertRaises(ValueError):self.library.mutate({'action':'rename_song','song_id':self.a['id'],'name':name})
        with self.assertRaises(ValueError):self.library.mutate({'action':'rename_song','song_id':'missing','name':'New'})

    def test_piano_failure_does_not_load_or_save(self):
        with self.assertRaises(ValueError):self.change(self.a['id'],'piano')
        self.assertEqual(self.calls,[]);self.assertEqual(server.SONG_ID,'')
        self.assertEqual(server.sound_config()['mode'],'no_drums')
    def test_stale_dialog_and_drum_selection_rejected(self):
        with self.assertRaises(ValueError):server.change_sound({'song_id':self.a['id'],'expected_song_id':'stale','mode':'smart'})
        with self.assertRaises(ValueError):self.change(self.a['id'],'custom',['1'])
        self.assertEqual(self.calls,[])
    def test_original_exact_bytes_and_analysis(self):
        self.change(self.a['id'],'original')
        self.assertEqual(self.loaded,self.library.select(self.a['id'])[0])
        result=server.sound_state(self.a['id'],analyse=True)
        json.dumps(result)
        self.assertEqual(len(result['analysis']['parts']),2)
        self.assertFalse(result['analysis']['has_piano'])
    def test_electric_piano_is_a_piano_part(self):
        song=self.library.add(fixture(2),'Electric piano.mid')
        analysis=server.sound_state(song['id'],analyse=True)['analysis']
        self.assertTrue(analysis['has_piano'])
        result=self.change(song['id'],'piano')
        self.assertEqual(result['report']['selected_names'],['Electric Grand Piano'])

    def test_default_mode_can_be_saved_without_song(self):
        self.change('','smart')
        self.assertEqual(self.library.get_setting('adaptation')['mode'],'smart')
        self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()

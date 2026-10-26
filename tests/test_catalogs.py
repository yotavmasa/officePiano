import unittest
from unittest.mock import patch
from backend.catalogs import Catalog, close, token_match
from backend import discovery


class CatalogTests(unittest.TestCase):
    def test_jazz_titles_and_case_insensitive_extension(self):
        site = Catalog('Jazz', 'https://bushgrafts.com', '/midi/')
        html = '<a href="/jazz/take.MID">Autumn Leaves – take 1</a> [M]<br><a href="https://evil.test/other.mid">Bad</a>'
        songs = site.songs(html, site.base + '/midi/')
        self.assertEqual(len(songs), 1)
        self.assertEqual(songs[0]['name'], 'Autumn Leaves – take 1')

    def test_classical_names_are_after_download_link(self):
        site = Catalog('Classical', 'https://www.kunstderfuge.com', '/midi.htm', True)
        songs = site.songs('<p><a href="/-/midi.asp?file=chopin/a.mid">MIDI</a> | Nocturne No. 1<br><a href="/-/midi.asp?file=chopin/b.mid">MIDI</a> | Ballade</p>', site.base + '/chopin.htm', 'Chopin')
        self.assertEqual([s['name'] for s in songs], ['Chopin — Nocturne No. 1', 'Chopin — Ballade'])

    def test_classical_search_does_not_consume_downloads(self):
        site = Catalog('Classical', 'https://www.kunstderfuge.com', '/midi.htm', True)
        pages = {'/midi.htm': '<a name="Composers"></a><a href="chopin.htm">Chopin</a><a name="Specials"></a>', '/chopin.htm': '<a href="/-/midi.asp?file=chopin/a.mid">MIDI</a> | Nocturne<br>'}
        with patch.object(site, 'page', side_effect=lambda url: pages[url.replace(site.base, '')]), patch.object(site, 'download') as download:
            result = site.search('Chopin nocturne')
        self.assertEqual(result['total_matches'], 1)
        self.assertIsNone(result['results'][0]['piano_only'])
        download.assert_not_called()

    def test_classical_search_finds_movements_by_work_name_stems_and_labels_versions(self):
        site = Catalog('Classical', 'https://www.kunstderfuge.com', '/midi.htm', True)
        sonatas = ('<p class="midi">Sonate No. 14 in c sharp minor, Op. 27 No. 2 \'Moonlight\'<br>'
                   '<a href="/-/midi.asp?file=rolls/beethoven/s14_1_(nc)smythe.mid">MIDI</a> | 1. Adagio sostenuto</p>'
                   '<p class="midi"><a href="/-/midi.asp?file=beethoven/s14_(c)oguri.mid">MIDI</a> | Sonate No. 14, Op. 27 No. 2</p>'
                   '<p class="midi"><a href="/-/midi.asp?file=beethoven/s14_(c)hisamori.mid">MIDI</a> | Sonate No. 14, Op. 27 No. 2</p>'
                   '<p class="midi">Organ<br><a href="/-/midi.asp?file=beethoven/organ_sonata_(c)x.mid">MIDI</a> | Sonata arrangement</p>')
        pages = {'/midi.htm': '<a name="Composers"></a><a href="beethoven.htm">Beethoven</a><a href="debussy.htm">De Bussy</a><a name="Specials"></a>',
                 '/beethoven.htm': sonatas, '/debussy.htm': ''}
        with patch.object(site, 'page', side_effect=lambda url: pages[url.replace(site.base, '')]):
            moonlight = site.search('moonlight sonata')
            sonata = site.search('beethoven sonata')
            stopword = site.search('de moonlight')
        self.assertEqual([s['name'] for s in moonlight['results']], ["Beethoven — Sonate No. 14 in c sharp minor, Op. 27 No. 2 'Moonlight' — 1. Adagio sostenuto"])
        self.assertEqual([s['name'] for s in sonata['results']][:3], ["Beethoven — Sonate No. 14 in c sharp minor, Op. 27 No. 2 'Moonlight' — 1. Adagio sostenuto",
                                                                      'Beethoven — Sonate No. 14, Op. 27 No. 2 (Oguri)', 'Beethoven — Sonate No. 14, Op. 27 No. 2 (Hisamori)'])
        self.assertTrue(sonata['results'][-1]['name'].startswith('Beethoven — Organ'))
        self.assertEqual(stopword['total_matches'], 1)

    def test_search_tolerates_small_typos_but_not_unrelated_words(self):
        for typo, word in [('lizst', 'liszt'), ('chopn', 'chopin'), ('mozrt', 'mozart'), ('beethovn', 'beethoven')]:
            with self.subTest(typo=typo):
                self.assertTrue(close(typo, word))
        for typo, word in [('noct', 'not'), ('sonata', 'sinfonia'), ('11', '12')]:
            with self.subTest(typo=typo):
                self.assertFalse(close(typo, word))
        self.assertTrue(token_match(['noct'], 'Nocturne Op. 9'))
        site = Catalog('Classical', 'https://www.kunstderfuge.com', '/midi.htm', True)
        pages = {'/midi.htm': '<a name="Composers"></a><a href="liszt.htm">Liszt</a><a href="chopin.htm">Chopin</a><a name="Specials"></a>',
                 '/liszt.htm': '<p><a href="/-/midi.asp?file=liszt/a.mid">MIDI</a> | Liebestraum No. 3</p>', '/chopin.htm': ''}
        with patch.object(site, 'page', side_effect=lambda url: pages[url.replace(site.base, '')]) as page:
            result = site.search('lizst liebestraum')
        self.assertEqual([s['name'] for s in result['results']], ['Liszt — Liebestraum No. 3'])
        self.assertNotIn(site.base + '/chopin.htm', [call.args[0] for call in page.call_args_list])

    def test_rejects_external_redirects_and_non_midi_imports(self):
        site = Catalog('Jazz', 'https://bushgrafts.com', '/midi/')
        for url in ['https://bushgrafts.com.evil.test/jazz/a.mid', 'https://user@bushgrafts.com/jazz/a.mid', 'http://bushgrafts.com/jazz/a.mid', 'https://bushgrafts.com/jazz/../a.mid', 'https://bushgrafts.com/admin']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                site.download(url)
        with self.assertRaises(ValueError):
            site.redirects().redirect_request(None, None, 302, '', {}, 'https://127.0.0.1/a.mid')

    def test_composer_search_includes_named_subcatalogs(self):
        site = Catalog('Classical', 'https://www.kunstderfuge.com', '/midi.htm', True)
        pages = {'/midi.htm': '<a name="Composers"></a><a href="bach.htm">Bach</a><a href="bach/organ.htm#fugues">Organ</a><a name="Specials"></a>',
                 '/bach.htm': '', '/bach/organ.htm': '<a href="/-/midi.asp?file=bach/a.mid">MIDI</a> | Fugue<br>'}
        with patch.object(site, 'page', side_effect=lambda url: pages[url.replace(site.base, '')]):
            result = site.search('Bach fugue')
        self.assertEqual(result['total_matches'], 1)
        self.assertIn('Bach', result['results'][0]['name'])

    def test_all_sources_and_legacy_both(self):
        result = {'results': [], 'has_more': False}
        with patch.object(discovery.maestro, 'available', return_value=False), patch.object(discovery.zzaj, 'search', return_value=result), patch.object(discovery.bitmidi, 'search', return_value=result), patch.object(discovery.freemidi, 'search', return_value=result), patch.object(discovery.bushgrafts, 'search', return_value=result) as jazz, patch.object(discovery.kunstderfuge, 'search', return_value=result) as classical:
            self.assertEqual(len(discovery.search('test', source='all')['sources']), 5)
            jazz.reset_mock(); classical.reset_mock()
            self.assertEqual(len(discovery.search('test', source='both')['sources']), 2)
            jazz.assert_not_called(); classical.assert_not_called()
            jazz.reset_mock(); classical.reset_mock()
            self.assertEqual(discovery.search('test', source='bushgrafts,kunstderfuge')['sources'], ['bushgrafts', 'kunstderfuge'])
            for bad in ('', 'bitmidi,nope', ','):
                with self.subTest(source=bad), self.assertRaises(ValueError):
                    discovery.search('test', source=bad)

    def test_source_notes_are_separate_from_warnings(self):
        noted = {'results': [], 'has_more': False, 'notes': ['Drums are left out by default.'], 'warnings': ['Some pages could not be read.']}
        with patch.object(discovery.zzaj, 'search', return_value=noted), patch.object(discovery.bitmidi, 'search', side_effect=ValueError('Offline.')):
            found = discovery.search('test', source='zzaj,bitmidi')
        self.assertEqual((found['notes'], found['warnings']),
                         ([{'source': 'zzaj', 'source_name': 'zzaj', 'text': 'Drums are left out by default.'}], ['BitMidi: Offline.', 'zzaj: Some pages could not be read.']))


if __name__ == '__main__':
    unittest.main()


class MaestroTests(unittest.TestCase):
    def setUp(self):
        import io, tempfile
        from pathlib import Path
        import mido
        from backend import maestro
        self.maestro = maestro
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name) / 'maestro'
        (folder / '2018').mkdir(parents=True)
        def midi(note):
            score = mido.MidiFile(); track = mido.MidiTrack(); score.tracks.append(track)
            track.extend([mido.Message('note_on', note=note, velocity=64), mido.Message('note_off', note=note, time=480)])
            out = io.BytesIO(); score.save(file=out); return out.getvalue()
        (folder / '2018' / 'a.midi').write_bytes(midi(60))
        (folder / '2018' / 'b.midi').write_bytes(midi(62))
        (folder / '2018' / 'c.midi').write_bytes(midi(64))
        (folder / 'maestro-v3.0.0.csv').write_text('canonical_composer,canonical_title,split,year,midi_filename,audio_filename,duration\n'
            'Franz Liszt,La Campanella,train,2018,2018/a.midi,,301.5\n'
            'Franz Liszt,La Campanella,train,2018,2018/b.midi,,288.0\n'
            'Frédéric Chopin,Ballade No. 1,train,2018,2018/c.midi,,560.0\n', encoding='utf-8')
        self.patch = patch.object(maestro, 'FOLDER', folder)
        self.patch.start()
        maestro.ENTRIES.update(path=None, mtime=None, rows=[])

    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()
        self.maestro.ENTRIES.update(path=None, mtime=None, rows=[])

    def test_search_labels_performances_and_downloads_locally(self):
        result = self.maestro.search('lizst campanella')
        self.assertEqual([r['name'] for r in result['results']], ['Franz Liszt — La Campanella (2018 performance, 5:01)', 'Franz Liszt — La Campanella (2018 performance, 4:48)'])
        self.assertTrue(all(r['piano_only'] for r in result['results']))
        data, song = self.maestro.download(result['results'][0]['url'])
        self.assertTrue(data.startswith(b'MThd'))
        self.assertEqual(song['name'], 'Franz Liszt — La Campanella (2018 performance, 5:01)')
        self.assertEqual(self.maestro.search('chopin')['results'][0]['name'], 'Frédéric Chopin — Ballade No. 1')

    def test_only_listed_local_files_can_be_downloaded(self):
        for url in ['https://magenta.withgoogle.com/datasets/maestro#../maestro-v3.0.0.csv', 'https://magenta.withgoogle.com/datasets/maestro#2018/missing.midi',
                    'http://magenta.withgoogle.com/datasets/maestro#2018/a.midi', 'https://evil.test/datasets/maestro#2018/a.midi',
                    'https://magenta.withgoogle.com/datasets/maestro?x=1#2018/a.midi']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.maestro.download(url)

    def test_all_sources_skip_maestro_until_installed(self):
        empty = {'results': [], 'has_more': False}
        with patch.object(self.maestro, 'available', return_value=False), patch.object(discovery.bitmidi, 'search', return_value=empty), \
             patch.object(discovery.freemidi, 'search', return_value=empty), patch.object(discovery.bushgrafts, 'search', return_value=empty), \
             patch.object(discovery.kunstderfuge, 'search', return_value=empty), patch.object(discovery.zzaj, 'search', return_value=empty):
            self.assertNotIn('maestro', discovery.search('test', source='all')['sources'])
            with patch.object(self.maestro, 'FOLDER', self.maestro.FOLDER / 'missing'):
                with self.assertRaises(ValueError):
                    discovery.search('test', source='maestro')


class ZzajTests(unittest.TestCase):
    PAGE = ("<table><tr><th>i</th><th>song</th></tr>"
            "<tr><td>A</td><td>After The Rain</td><td><a href='AfterTheRainC.pdf'>lead sheet</a></td><td></td><td></td>"
            "<td>John Coltrane</td><td>Ab Major</td><td>Ballad</td><td><a href='AfterTheRain.mid' target='_blank'>midi</a></td><td></td></tr>"
            "<tr><td>A</td><td>Agua De Beber</td><td></td><td></td><td></td><td>Antonio Carlos Jobim</td><td>A minor</td><td>Latin</td>"
            "<td><a href='AguaDeBeber.mid'>midi</a></td></tr>"
            "<tr><td>B</td><td>No Midi Here</td><td></td><td></td><td></td><td>Someone</td><td>C</td><td>Swing</td><td> </td></tr>"
            "<tr><td>C</td><td>Elsewhere</td><td></td><td></td><td></td><td>X</td><td>C</td><td>Swing</td><td><a href='https://evil.test/x.mid'>midi</a></td></tr></table>")

    def setUp(self):
        from backend import zzaj
        self.zzaj = zzaj
        zzaj.FILES.clear()
        self.page = patch.object(zzaj.SITE, 'page', return_value=self.PAGE)
        self.page.start()

    def tearDown(self):
        self.page.stop(); self.zzaj.FILES.clear()

    def test_reads_only_listed_midi_rows_and_searches_them(self):
        self.assertEqual([song['title'] for song in self.zzaj.songs().values()], ['After The Rain', 'Agua De Beber'])
        self.assertEqual([r['name'] for r in self.zzaj.search('coltrane')['results']], ['After The Rain — John Coltrane'])
        self.assertEqual([r['name'] for r in self.zzaj.search('jobmi agua')['results']], ['Agua De Beber — Antonio Carlos Jobim'])
        self.assertEqual(self.zzaj.search('monk')['results'], [])
        self.assertEqual(self.zzaj.search('latin')['total_matches'], 1)

    def test_downloads_only_indexed_files(self):
        import io, mido
        score = mido.MidiFile(); track = mido.MidiTrack(); score.tracks.append(track)
        track.extend([mido.Message('note_on', note=60, velocity=64), mido.Message('note_off', note=60, time=480)])
        out = io.BytesIO(); score.save(file=out)
        with patch.object(self.zzaj.SITE, 'fetch', return_value=out.getvalue()) as fetch:
            data, song = self.zzaj.download('https://zzaj.web.fc2.com/score/AfterTheRain.mid')
            self.zzaj.download('https://zzaj.web.fc2.com/score/AfterTheRain.mid')
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(song['name'], 'After The Rain — John Coltrane')
        for url in ['https://zzaj.web.fc2.com/score/NotListed.mid', 'https://evil.test/x.mid', 'http://zzaj.web.fc2.com/score/AfterTheRain.mid']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.zzaj.download(url)

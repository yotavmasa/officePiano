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
        with patch.object(discovery.bitmidi, 'search', return_value=result), patch.object(discovery.freemidi, 'search', return_value=result), patch.object(discovery.bushgrafts, 'search', return_value=result) as jazz, patch.object(discovery.kunstderfuge, 'search', return_value=result) as classical:
            self.assertEqual(len(discovery.search('test', source='all')['sources']), 4)
            jazz.reset_mock(); classical.reset_mock()
            self.assertEqual(len(discovery.search('test', source='both')['sources']), 2)
            jazz.assert_not_called(); classical.assert_not_called()
            jazz.reset_mock(); classical.reset_mock()
            self.assertEqual(discovery.search('test', source='bushgrafts,kunstderfuge')['sources'], ['bushgrafts', 'kunstderfuge'])
            for bad in ('', 'bitmidi,nope', ','):
                with self.subTest(source=bad), self.assertRaises(ValueError):
                    discovery.search('test', source=bad)


if __name__ == '__main__':
    unittest.main()

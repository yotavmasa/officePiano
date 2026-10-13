from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import artwork

ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music/album/100x100bb.jpg'
ITEM = {'kind': 'song', 'trackName': 'Hotel California', 'artistName': 'Eagles', 'collectionName': 'Hotel California',
        'artworkUrl100': ART, 'trackViewUrl': 'https://music.apple.com/us/album/hotel-california/123?i=456'}
SONG = {'name': 'Hotel California.mid', 'source_url': 'https://freemidi.org/download3-2896-hotel-california-eagles'}


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        artwork.CACHE.clear(); artwork.QUERY_CACHE.clear(); artwork.LAST_REQUEST = 0.0

    def test_query_normalizes_filename_and_free_midi_artist(self):
        term, title, artist = artwork._identity(SONG)
        self.assertEqual((term, title, artist), ('Hotel California eagles', 'Hotel California', ['eagles']))
        self.assertEqual(artwork._clean('download3-2896-hotel-california-eagles.midi'), 'hotel california eagles')
        self.assertEqual(artwork._clean('Fur_Elise (2).MID'), 'Fur Elise')
        self.assertEqual(artwork._identity({'name': '1984.mid'})[1], '1984')

    def test_camel_case_version_tags_and_sequence_noise(self):
        cases = {'LadyMadonna.mid': 'Lady Madonna', 'BlueBossa1GM.mid': 'Blue Bossa',
                 '01_LadyMadonna_v2.midi': 'Lady Madonna', '7-Hotel_California_version2.mid': 'Hotel California',
                 '99 Luftballons.mid': '99 Luftballons', 'Route66.mid': 'Route66', 'U2.mid': 'U2'}
        for filename, expected in cases.items():
            self.assertEqual(artwork._clean(filename), expected, filename)
        source = {'name': 'LadyMadonna.mid', 'source_url': 'https://freemidi.org/download3-1-lady-madonna-beatles'}
        self.assertEqual(artwork._identity(source), ('Lady Madonna beatles', 'Lady Madonna', ['beatles']))
        self.assertEqual(artwork._queries(source)[0], ['Lady Madonna beatles', 'Lady Madonna'])

    def test_source_query_variant_can_find_a_clean_filename_match(self):
        song = {'name': 'LadyMadonna.mid', 'source_url': 'https://bitmidi.com/beatles-lady-madonna-mid'}
        item = dict(ITEM, trackName='Lady Madonna', artistName='The Beatles')
        with patch.object(artwork, '_search', side_effect=[[], [item]]) as search:
            result = artwork.lookup(song)
        self.assertEqual(result['artist'], 'The Beatles')
        self.assertEqual([call.args[0] for call in search.call_args_list], ['Lady Madonna beatles', 'beatles lady madonna'])

    def test_bitmidi_artist_slug_resolves_otherwise_ambiguous_title(self):
        song = {'name': 'LadyMadonna.mid', 'source_url': 'https://bitmidi.com/beatles-lady-madonna-mid'}
        beatles = dict(ITEM, trackName='Lady Madonna', artistName='The Beatles')
        cover = dict(beatles, artistName='Unrelated performer')
        with patch.object(artwork, '_search', return_value=[cover, beatles]):
            self.assertEqual(artwork.lookup(song)['artist'], 'The Beatles')

    def test_title_only_variant_keeps_known_artist_requirement(self):
        with patch.object(artwork, '_search', side_effect=[[], [dict(ITEM, artistName='Other band')]]) as search:
            self.assertEqual(artwork.lookup(SONG), {})
        self.assertEqual(search.call_count, 2)
        artwork.CACHE.clear(); artwork.QUERY_CACHE.clear()
        with patch.object(artwork, '_search', side_effect=[[], [ITEM]]):
            self.assertEqual(artwork.lookup(SONG)['artist'], 'Eagles')

    def test_long_artist_filename_is_not_mistaken_for_a_bad_title(self):
        item = dict(ITEM, trackName='September', artistName='Earth, Wind & Fire')
        with patch.object(artwork, '_search', return_value=[item]):
            result = artwork.lookup({'name': 'Earth_Wind_Fire-September.mid'})
        self.assertEqual(result['artist'], 'Earth, Wind & Fire')

    def test_high_resolution_rewrites_only_known_safe_cdn_paths(self):
        self.assertEqual(artwork.high_resolution_url(ART), ART.replace('100x100', '600x600'))
        self.assertEqual(artwork.high_resolution_url(ART.replace('100x100', '60x60')), ART.replace('100x100', '600x600'))
        query = ART + '?size=100x100bb.jpg'
        self.assertEqual(artwork.high_resolution_url(query), ART.replace('100x100', '600x600') + '?size=100x100bb.jpg')
        self.assertEqual(artwork.high_resolution_url('https://evil.example/image/100x100bb.jpg'), '')
        untouched = ART.replace('100x100bb.jpg', 'cover-original.jpg')
        self.assertEqual(artwork.high_resolution_url(untouched), untouched)

    def test_negative_query_cache_prevents_repeated_real_searches(self):
        song = {'name': 'LadyMadonna.mid', 'source_url': 'https://bitmidi.com/beatles-lady-madonna-mid'}
        with patch.object(artwork, '_search', return_value=[]) as search:
            self.assertEqual(artwork.lookup(song), {})
            artwork.CACHE.clear()
            self.assertEqual(artwork.lookup(song), {})
            self.assertEqual(search.call_count, 3)
        self.assertLessEqual(len(artwork.QUERY_CACHE), 128)

    def test_matching_title_and_artist_returns_linked_cover_and_caches(self):
        with patch.object(artwork, '_search', return_value=[ITEM]) as search:
            result = artwork.lookup(SONG)
            self.assertEqual(result['url'], ART.replace('100x100', '600x600'))
            self.assertEqual(result['artist'], 'Eagles')
            self.assertEqual(result['source'], 'Apple iTunes')
            self.assertIn('store_url', result)
            self.assertEqual(artwork.lookup(SONG), result)
            self.assertEqual(search.call_count, 1)

    def test_unrelated_title_or_wrong_artist_is_rejected(self):
        for item in (dict(ITEM, trackName='California Dreamin'), dict(ITEM, artistName='Other band'), dict(ITEM, kind='music-video')):
            artwork.CACHE.clear(); artwork.QUERY_CACHE.clear(); artwork.LAST_REQUEST = 0.0
            with patch.object(artwork, '_search', return_value=[item]):
                self.assertEqual(artwork.lookup(SONG), {})

    def test_ambiguous_title_without_artist_uses_fallback(self):
        with patch.object(artwork, '_search', return_value=[ITEM, dict(ITEM, artistName='Different performer')]):
            self.assertEqual(artwork.lookup({'name': 'Hotel California.mid'}), {})
        artwork.CACHE.clear(); artwork.QUERY_CACHE.clear(); artwork.LAST_REQUEST = 0.0
        with patch.object(artwork, '_search', return_value=[ITEM]):
            self.assertEqual(artwork.lookup({'name': 'Eagles - Hotel California.mid'})['artist'], 'Eagles')

    def test_artwork_host_and_store_link_allowlists(self):
        self.assertTrue(artwork.artwork_url(ART))
        bad = ['http://is1-ssl.mzstatic.com/image/cover.jpg', 'https://is1-ssl.mzstatic.com.evil.example/image/a',
               'https://mzstatic.com/image/a', 'https://evil.mzstatic.com/image/a',
               'https://user@is1.mzstatic.com/image/a', 'https://is1.mzstatic.com:444/image/a',
               'https://is1.mzstatic.com/image/a#fragment']
        for url in bad:
            self.assertFalse(artwork.artwork_url(url), url)
        with patch.object(artwork, '_search', return_value=[dict(ITEM, trackViewUrl='https://evil.example/store')]):
            self.assertEqual(artwork.lookup(SONG), {})
        with self.assertRaises(ValueError):
            artwork.AppleRedirect().redirect_request(urllib.request.Request(artwork.API), None, 302, 'Found', {}, 'https://evil.example/search')

    def test_network_and_malformed_response_fallback(self):
        for error in (urllib.error.URLError('offline'), ValueError('malformed JSON'), TimeoutError('timeout')):
            artwork.CACHE.clear(); artwork.QUERY_CACHE.clear(); artwork.LAST_REQUEST = 0.0
            with patch.object(artwork, '_search', side_effect=error):
                self.assertEqual(artwork.lookup(SONG), {})
        self.assertEqual(artwork.lookup({'name': ''}), {})

    def test_real_api_requests_are_paced(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return artwork.API
            def read(self, limit): return b'{"results": []}'
        artwork.LAST_REQUEST = 10.0
        with patch.object(artwork.time, 'monotonic', side_effect=[11.0, 13.0]), patch.object(artwork.time, 'sleep') as sleep, patch.object(artwork.urllib.request, 'build_opener') as factory:
            factory.return_value.open.return_value = Response()
            self.assertEqual(artwork._search('Song'), [])
        sleep.assert_called_once_with(2.0)
        self.assertEqual(artwork.LAST_REQUEST, 13.0)

    def test_bounded_json_read_and_timeout(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return artwork.API
            def read(self, limit): return b'x' * limit
        with patch.object(artwork.urllib.request, 'build_opener') as factory:
            factory.return_value.open.return_value = Response()
            with self.assertRaisesRegex(ValueError, 'too large'):
                artwork._search('Song')
            self.assertEqual(factory.return_value.open.call_args.kwargs['timeout'], 5)


if __name__ == '__main__':
    unittest.main()

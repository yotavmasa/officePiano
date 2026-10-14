import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'vendor')]
import mido
import pretty_midi
from backend import adaptation
from backend.library import parse_midi


def fixture(parts):
    score = mido.MidiFile(ticks_per_beat=480)
    score.tracks.append(mido.MidiTrack([
        mido.MetaMessage('set_tempo', tempo=500000),
        mido.MetaMessage('set_tempo', tempo=1000000, time=480),
        mido.MetaMessage('end_of_track', time=480),
    ]))
    for channel, program, name, notes, pedal in parts:
        track = mido.MidiTrack([mido.MetaMessage('track_name', name=name), mido.Message('program_change', program=program, channel=channel)])
        events = []
        if pedal:
            events += [(0, mido.Message('control_change', channel=channel, control=64, value=127)),
                       (960, mido.Message('control_change', channel=channel, control=64, value=0))]
        for pitch, start, end, velocity in notes:
            events += [(start, mido.Message('note_on', channel=channel, note=pitch, velocity=velocity)),
                       (end, mido.Message('note_off', channel=channel, note=pitch, velocity=0))]
        previous = 0
        for tick, event in sorted(events, key=lambda item: item[0]):
            track.append(event.copy(time=tick - previous)); previous = tick
        track.append(mido.MetaMessage('end_of_track'))
        score.tracks.append(track)
    buffer = io.BytesIO(); score.save(file=buffer)
    return buffer.getvalue()


PIANO_PART = (0, 0, 'Piano', [(60, 0, 480, 72), (62, 480, 720, 31)], True)
BASS_PART = (1, 32, 'Bass', [(40, 0, 960, 55)], False)
MELODY_PART = (2, 56, 'Melody', [(80, 0, 480, 44)], False)
DRUM_PART = (9, 0, 'Drums', [(38, 0, 480, 90)], False)


def parsed(data):
    return pretty_midi.PrettyMIDI(io.BytesIO(data))


def note_values(music):
    return sorted((note.pitch, round(note.start, 5), round(note.end, 5), note.velocity)
                  for instrument in music.instruments for note in instrument.notes)


class AdaptationTests(unittest.TestCase):
    def test_smart_joins_overlapping_keys_but_keeps_separate_repeated_attacks(self):
        first = (0, 0, 'Left', [(60, 0, 480, 50), (60, 960, 1200, 40)], False)
        second = (1, 0, 'Right', [(60, 240, 960, 70), (64, 0, 480, 44)], False)
        result, report = adaptation.render(fixture([first, second]), {'mode': 'smart'})
        self.assertEqual(note_values(parsed(result)), [(60, 0, 1.5, 50), (60, 1.5, 2., 40), (64, 0, .5, 44)])
        self.assertEqual(report['merged_notes'], 1)
        self.assertEqual(len(parsed(result).instruments), 1)

    def test_smart_shifts_a_part_consistently_at_piano_range_boundary(self):
        part = (0, 0, 'High phrase', [(107, 0, 480, 50), (109, 480, 960, 60)], False)
        result, report = adaptation.render(fixture([part]), {'mode': 'smart'})
        self.assertEqual([n[0] for n in note_values(parsed(result))], [95, 97])
        self.assertEqual(report['shifted_notes'], 2)

    def test_three_channel_overlap_keeps_first_note_on_and_last_note_off(self):
        channels = [(0, 0, 'First', [(60, 0, 480, 50)], False),
                    (1, 0, 'Middle', [(60, 240, 960, 70)], False),
                    (2, 0, 'Last', [(60, 720, 1200, 80)], False)]
        result, report = adaptation.render(fixture(channels), {'mode': 'smart'})
        self.assertEqual(note_values(parsed(result)), [(60, 0, 2.0, 50)])
        events = [e for t in mido.MidiFile(file=io.BytesIO(result)).tracks for e in t if e.type in ('note_on', 'note_off') and e.note == 60]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].type, 'note_on')
        self.assertEqual(events[0].velocity, 50)
        self.assertTrue(events[1].type == 'note_off' or events[1].velocity == 0)
        self.assertEqual(report['merged_notes'], 2)

    def test_smart_preserves_repeated_attacks_inside_another_voice_hold(self):
        held = (0, 0, 'Harmony', [(60, 0, 960, 50)], False)
        melody = (1, 0, 'Melody', [(60, 240, 480, 70), (60, 600, 720, 80)], False)
        result, report = adaptation.render(fixture([held, melody]), {'mode': 'smart'})
        notes = parsed(result).instruments[0].notes
        self.assertEqual(len(notes), 3)
        self.assertAlmostEqual(notes[0].start, 0)
        self.assertAlmostEqual(notes[-1].end, 1.5)
        self.assertEqual([round(n.start, 3) for n in notes], [0, .25, .75])
        self.assertTrue(all(a.end < b.start for a, b in zip(notes, notes[1:])))
        self.assertEqual([n.velocity for n in notes], [50, 70, 80])

    def test_smart_low_outlier_does_not_transpose_an_entire_part(self):
        pitches = [12] + list(range(60, 80))
        part = (0, 0, 'Piano', [(p, i * 480, (i + 1) * 480, 60) for i, p in enumerate(pitches)], False)
        result, report = adaptation.render(fixture([part]), {'mode': 'smart'})
        self.assertEqual([n.pitch for n in parsed(result).instruments[0].notes], pitches[1:])
        self.assertEqual(report['shifted_notes'], 0)
        self.assertEqual(report['out_of_range_notes'], 1)

    def test_merged_pedal_does_not_release_while_another_channel_holds_it(self):
        class Part:
            def __init__(self, controls):
                self.control_changes = controls
        first = Part([pretty_midi.ControlChange(64, 127, 0), pretty_midi.ControlChange(64, 0, 1)])
        second = Part([pretty_midi.ControlChange(64, 127, .5), pretty_midi.ControlChange(64, 0, 1.5)])
        controls = adaptation._merge_pedals(pretty_midi, [first, second])
        self.assertEqual([(c.number, c.value, c.time) for c in controls], [(64, 127, 0), (64, 0, 1.5)])

    def test_no_drums_preserves_all_other_events_at_their_original_ticks(self):
        score = mido.MidiFile(file=io.BytesIO(fixture([PIANO_PART, BASS_PART, MELODY_PART, DRUM_PART])))
        # A mixed track makes preserving delta times essential when drum events disappear.
        score.tracks.append(mido.MidiTrack([mido.Message('note_on', channel=9, note=36, velocity=90, time=120), mido.Message('note_on', channel=3, note=12, velocity=31, time=120), mido.Message('note_off', channel=9, note=36, time=120), mido.Message('note_off', channel=3, note=12, time=120), mido.MetaMessage('end_of_track')]))
        buffer = io.BytesIO(); score.save(file=buffer)
        source = buffer.getvalue()
        rendered, report = adaptation.render(source, {'mode': 'no_drums'})
        result = mido.MidiFile(file=io.BytesIO(rendered))
        def events(track):
            tick, output = 0, []
            for event in track:
                tick += event.time
                if getattr(event, 'channel', None) != 9:
                    output.append((tick, event.copy(time=0)))
            return output
        self.assertEqual([events(t) for t in score.tracks], [events(t) for t in result.tracks])
        self.assertFalse(any(getattr(e, 'channel', None) == 9 for t in result.tracks for e in t))
        self.assertEqual(report['removed_notes'], 2)
        self.assertEqual(report['shifted_notes'], 0)
        self.assertEqual(source, buffer.getvalue())

    def test_no_drums_rejects_a_drum_only_song(self):
        with self.assertRaisesRegex(ValueError, 'no notes outside'):
            adaptation.render(fixture([DRUM_PART]), {'mode': 'no_drums'})

    def test_analysis_and_piano_selection_are_stable(self):
        data = fixture([PIANO_PART, BASS_PART, MELODY_PART, DRUM_PART])
        first = adaptation.analyse(data)
        self.assertEqual(first, adaptation.analyse(data))
        self.assertTrue(first['has_piano'])
        self.assertEqual(first['recommended_parts'], [first['parts'][0]['id']])
        self.assertEqual(first['parts'][0]['instrument'], 'Acoustic Grand Piano')
        self.assertTrue(first['parts'][3]['is_drum'])

    def test_original_bytes_are_exact_and_source_is_immutable(self):
        data = fixture([PIANO_PART, BASS_PART, DRUM_PART]); source = bytes(data)
        result, report = adaptation.render(data, {'mode': 'original'})
        self.assertIs(result, data)
        self.assertTrue(report['original'])
        adaptation.render(data, {'mode': 'smart'})
        self.assertEqual(data, source)

    def test_piano_preserves_tempo_velocity_timing_and_pedals(self):
        data = fixture([PIANO_PART, BASS_PART, MELODY_PART, DRUM_PART])
        result, report = adaptation.render(data, {'mode': 'piano'})
        music = parsed(result)
        self.assertEqual(note_values(music), [(60, 0., .5, 72), (62, .5, 1., 31)])
        self.assertEqual(list(music.get_tempo_changes()[0]), [0., .5])
        self.assertEqual(list(music.get_tempo_changes()[1]), [120., 60.])
        self.assertEqual([(c.number, c.value, c.time) for c in music.instruments[0].control_changes], [(64, 127, 0.), (64, 0, 1.5)])
        self.assertEqual(report['removed_notes'], 3)
        self.assertAlmostEqual(report['duration_seconds'], mido.MidiFile(file=io.BytesIO(result)).length)
        self.assertTrue(parse_midi(result)['piano_only'])

    def test_no_piano_never_silently_falls_back(self):
        data = fixture([BASS_PART, MELODY_PART, DRUM_PART])
        self.assertFalse(adaptation.analyse(data)['has_piano'])
        with self.assertRaisesRegex(ValueError, 'Smart or Custom'):
            adaptation.render(data, {'mode': 'piano'})
        result, report = adaptation.render(data, {'mode': 'smart'})
        self.assertEqual(report['selected_names'], ['Melody', 'Bass'])
        self.assertEqual(note_values(parsed(result)), [(40, 0., 1.5, 55), (80, 0., .5, 44)])
        self.assertIn('rule-based', report['notice'])

    def test_custom_parts_and_octave_folding_keep_dynamics(self):
        data = fixture([PIANO_PART, (1, 32, 'Low bass', [(12, 0, 480, 9), (120, 480, 960, 115)], False), DRUM_PART])
        parts = adaptation.analyse(data)['parts']
        bass_id = next(part['id'] for part in parts if part['name'] == 'Low bass')
        result, report = adaptation.render(data, {'mode': 'custom', 'parts': [bass_id, bass_id]})
        self.assertEqual(report['selected_parts'], [bass_id])
        self.assertEqual(report['shifted_notes'], 2)
        self.assertEqual(note_values(parsed(result)), [(24, 0., .5, 9), (108, .5, 1.5, 115)])
        self.assertEqual(parsed(result).instruments[0].program, 0)
        self.assertTrue(parse_midi(result)['piano_only'])
        drum_id = next(part['id'] for part in parts if part['is_drum'])
        for selected in ([], [drum_id], ['missing'], [1]):
            with self.assertRaises(ValueError):
                adaptation.render(data, {'mode': 'custom', 'parts': selected})

    def test_smart_keeps_all_piano_parts_and_one_pedal_source(self):
        bright = (1, 1, 'Bright piano', [(64, 0, 480, 45)], False)
        data = fixture([PIANO_PART, bright, BASS_PART])
        result, report = adaptation.render(data, {'mode': 'smart'})
        self.assertEqual(report['selected_names'], ['Piano', 'Bright piano'])
        self.assertEqual(len(parsed(result).instruments[0].notes), 3)
        self.assertEqual(len(parsed(result).instruments[0].control_changes), 2)

    def test_smart_dense_chords_keep_all_notes(self):
        notes = [(pitch, 0, 960, pitch - 20) for pitch in range(50, 60)]
        data = fixture([(0, 0, 'Dense piano', notes, False)])
        result, report = adaptation.render(data, {'mode': 'smart'})
        values = note_values(parsed(result))
        self.assertEqual(len(values), 10)
        self.assertEqual(report['removed_notes'], 0)
        self.assertIn(50, [note[0] for note in values]); self.assertIn(59, [note[0] for note in values])
        self.assertTrue(all(start == 0 and end == 1.5 and velocity == pitch - 20 for pitch, start, end, velocity in values))
        piano, _ = adaptation.render(data, {'mode': 'piano'})
        self.assertEqual(len(parsed(piano).instruments[0].notes), 10)

    def test_smart_long_overlap_does_not_extend_note_ends(self):
        notes = [(pitch, 0, 960, 40) for pitch in range(50, 58)]
        notes += [(80, 240, 480, 70), (81, 960, 1440, 71)]
        data = fixture([(0, 0, 'Piano', notes, False)])
        result, report = adaptation.render(data, {'mode': 'smart'})
        values = note_values(parsed(result))
        self.assertEqual(report['removed_notes'], 0)
        self.assertIn(80, [note[0] for note in values])
        self.assertEqual([note for note in values if note[0] == 81], [(81, 1.5, 2.5, 71)])
        self.assertTrue(all(end == 1.5 for pitch, _, end, _ in values if pitch < 80))
        self.assertAlmostEqual(report['duration_seconds'], 2.5, places=2)

    def test_tempo_on_an_instrument_track_is_preserved(self):
        data = fixture([PIANO_PART])
        score = mido.MidiFile(file=io.BytesIO(data))
        score.tracks[1] = mido.MidiTrack([
            mido.Message('program_change', channel=0, program=0),
            mido.Message('note_on', channel=0, note=60, velocity=40),
            mido.MetaMessage('set_tempo', tempo=1000000, time=240),
            mido.Message('note_off', channel=0, note=60, velocity=0, time=240),
            mido.MetaMessage('end_of_track'),
        ])
        buffer = io.BytesIO(); score.save(file=buffer)
        data = buffer.getvalue()
        rendered, _ = adaptation.render(data, {'mode': 'piano'})
        self.assertEqual(note_values(parsed(rendered)), [(60, 0., .75, 40)])
        self.assertEqual(adaptation.render(data, {'mode': 'original'})[0], data)

    def test_adapted_output_omits_sysex_and_volume_commands(self):
        score = mido.MidiFile(file=io.BytesIO(fixture([PIANO_PART])))
        score.tracks[0].insert(0, mido.Message('sysex', data=(0x7d, 1)))
        score.tracks[1].insert(0, mido.Message('control_change', channel=0, control=7, value=1))
        buffer = io.BytesIO(); score.save(file=buffer); source = buffer.getvalue()
        rendered, _ = adaptation.render(source, {'mode': 'piano'})
        events = [event for track in mido.MidiFile(file=io.BytesIO(rendered)).tracks for event in track]
        self.assertFalse(any(event.type == 'sysex' for event in events))
        self.assertFalse(any(event.type == 'control_change' and event.control == 7 for event in events))
        self.assertEqual([note[-1] for note in note_values(parsed(rendered))], [72, 31])
        self.assertEqual(adaptation.render(source, {'mode': 'original'})[0], source)

    def test_only_drums_or_invalid_settings_fail_clearly(self):
        data = fixture([DRUM_PART])
        with self.assertRaisesRegex(ValueError, 'no melodic parts'):
            adaptation.render(data, {'mode': 'smart'})
        for settings in (None, {}, {'mode': 'bad'}):
            with self.assertRaises(ValueError):
                adaptation.render(data, settings)
        with self.assertRaises(ValueError):
            adaptation.analyse(b'invalid')


if __name__ == '__main__':
    unittest.main()

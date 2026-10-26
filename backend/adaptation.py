"""Experimental, deterministic MIDI part selection; originals stay untouched."""
from bisect import bisect_left
import heapq
import io
from itertools import groupby
import math
from pathlib import Path
import random
import statistics
import sys
import zlib
from .library import parse_midi

VENDOR = Path(__file__).resolve().parent.parent / 'vendor'
if sys.prefix == sys.base_prefix and str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

LABELS = {'original': 'Original MIDI', 'no_drums': 'All parts except drums', 'piano': 'Piano tracks',
          'smart': 'Smart piano (experimental)', 'custom': 'Custom parts (experimental)'}


def _read(data):
    parse_midi(data, piano_only=False)
    try:
        import mido
        import pretty_midi
        score = mido.MidiFile(file=io.BytesIO(data))
        extra_tempos = []
        for track_index, track in enumerate(score.tracks[1:], 1):
            tick, previous, remaining = 0, 0, mido.MidiTrack()
            for event_index, event in enumerate(track):
                tick += event.time
                if event.type == 'set_tempo':
                    extra_tempos.append((tick, track_index, event_index, event))
                else:
                    remaining.append(event.copy(time=tick - previous)); previous = tick
            score.tracks[track_index] = remaining
        if extra_tempos:
            tick, events = 0, []
            for event_index, event in enumerate(score.tracks[0]):
                tick += event.time
                if event.type != 'end_of_track':
                    events.append((tick, 0, event_index, event))
            end_tick = max(tick, max(event[0] for event in extra_tempos))
            track, previous = mido.MidiTrack(), 0
            for tick, _, _, event in sorted(events + extra_tempos, key=lambda item: item[:3]):
                track.append(event.copy(time=tick - previous)); previous = tick
            track.append(mido.MetaMessage('end_of_track', time=end_tick - previous))
            score.tracks[0] = track
        return pretty_midi, pretty_midi.PrettyMIDI(mido_object=score)
    except Exception as exc:
        raise ValueError('This MIDI cannot be analysed for piano adaptation. Try Original mode or a different file.') from exc


def _parts(pretty, music):
    parts = []
    for index, instrument in enumerate(music.instruments):
        description = 'Drums' if instrument.is_drum else pretty.program_to_instrument_name(instrument.program)
        name = ' '.join(instrument.name.split())[:120] or description
        parts.append({'id': str(index), 'name': name, 'instrument': description,
                      'program': int(instrument.program), 'is_drum': bool(instrument.is_drum),
                      'notes': len(instrument.notes)})
    return parts


def _recommended(music):
    usable = [index for index, instrument in enumerate(music.instruments) if instrument.notes and not instrument.is_drum]
    piano = [index for index in usable if music.instruments[index].program in range(8)]
    if piano:
        return [str(index) for index in piano]
    bass = [index for index in usable if 32 <= music.instruments[index].program <= 39]
    melodic = [index for index in usable if index not in bass]
    if not melodic:
        melodic = usable
    if not melodic:
        return []
    melody = max(melodic, key=lambda index: (statistics.median(note.pitch for note in music.instruments[index].notes),
                                            len(music.instruments[index].notes)))
    selected = [melody]
    if bass:
        low = max(bass, key=lambda index: len(music.instruments[index].notes))
        if low not in selected:
            selected.append(low)
    return [str(index) for index in selected]


def analyse(data):
    pretty, music = _read(data)
    parts = _parts(pretty, music)
    return {'parts': parts, 'recommended_parts': _recommended(music),
            'has_piano': any(part['program'] in range(8) and not part['is_drum'] and part['notes'] for part in parts)}


def _fold(pitch):
    while pitch < 21:
        pitch += 12
    while pitch > 108:
        pitch -= 12
    return pitch


def _part_shift(instrument):
    pitches = [note.pitch for note in instrument.notes]
    if not pitches:
        return 0
    # A small tail of invalid keys must not transpose an otherwise playable part.
    if sum(21 <= pitch <= 108 for pitch in pitches) >= .9 * len(pitches):
        return 0
    shifts = [shift for shift in range(-108, 109, 12) if min(pitches) + shift >= 21 and max(pitches) + shift <= 108]
    return min(shifts, key=abs) if shifts else 0


def _merge_overlap(notes, voices=None):
    """One physical key cannot sustain overlapping copies on separate channels."""
    merged, count = [], 0
    for pitch, group in groupby(sorted(notes, key=lambda note: (note.pitch, note.start, note.end)), key=lambda note: note.pitch):
        clusters, cluster, end = [], [], 0
        for note in group:
            if cluster and note.start >= end - 1e-9:
                clusters.append(cluster)
                cluster, end = [], 0
            cluster.append(note)
            end = max(end, note.end)
        if cluster:
            clusters.append(cluster)
        for cluster in clusters:
            starts = {}
            if voices:
                for note in cluster:
                    starts.setdefault(voices[id(note)], set()).add(note.start)
            repeated = any(len(onsets) > 1 for onsets in starts.values())
            if repeated:
                attacks = []
                for _, simultaneous in groupby(cluster, key=lambda note: note.start):
                    attacks.append(max(simultaneous, key=lambda note: note.velocity))
                final_release = max(note.end for note in cluster)
                for index, note in enumerate(attacks):
                    if index + 1 < len(attacks):
                        next_start = attacks[index + 1].start
                        gap = min(.008, (next_start - note.start) / 2)
                        note.end = next_start - gap
                    else:
                        note.end = final_release
                merged.extend(attacks)
                count += len(cluster) - len(attacks)
            else:
                first = cluster[0]
                first.velocity = max(note.velocity for note in cluster if abs(note.start - first.start) < 1e-9)
                first.end = max(note.end for note in cluster)
                merged.append(first)
                count += len(cluster) - 1
    return sorted(merged, key=lambda note: (note.start, note.pitch)), count


def _merge_pedals(pretty, instruments):
    events = sorted((control.time, index, order, control.number, control.value)
                    for index, instrument in enumerate(instruments) for order, control in enumerate(instrument.control_changes)
                    if control.number in (64, 66, 67))
    states, previous, output = {}, {}, []
    for timestamp, group in groupby(events, key=lambda event: event[0]):
        changed = set()
        for _, index, _, number, value in group:
            states[index, number] = value
            changed.add(number)
        for number in sorted(changed):
            value = max(states.get((index, number), 0) for index in range(len(instruments)))
            if value != previous.get(number, 0):
                output.append(pretty.ControlChange(number, value, timestamp))
                previous[number] = value
    return output


def _expressive(notes, music, seed):
    """Rule-based dynamics: melody emphasis, metric accents, phrase arcs, duration weight and small jitter."""
    if not notes:
        return
    # Skyline melody: the highest attack at an onset that is not under a higher held note.
    order = sorted(range(len(notes)), key=lambda index: notes[index].start)
    melody, active, position = set(), [], 0
    while position < len(order):
        onset, group = notes[order[position]].start, []
        while position < len(order) and notes[order[position]].start - onset < .03:
            group.append(order[position]); position += 1
        while active and active[0][1] <= onset + .03:
            heapq.heappop(active)
        highest = max(notes[index].pitch for index in group)
        if not active or highest >= -active[0][0]:
            melody.update(index for index in group if notes[index].pitch == highest)
        for index in group:
            heapq.heappush(active, (-notes[index].pitch, notes[index].end))
    line = sorted((notes[index].start, notes[index].pitch) for index in melody)
    times = [start for start, _ in line]
    sums = [0]
    for _, pitch in line:
        sums.append(sums[-1] + pitch)

    def contour(moment, width):
        low, high = bisect_left(times, moment - width), bisect_left(times, moment + width)
        return (sums[high] - sums[low]) / (high - low) if high > low else None

    beats, downbeats = list(music.get_beats()), list(music.get_downbeats())

    def near(grid, moment, tolerance=.04):
        index = bisect_left(grid, moment)
        return any(0 <= candidate < len(grid) and abs(grid[candidate] - moment) <= tolerance for candidate in (index - 1, index))

    typical = statistics.median(max(note.end - note.start, .01) for note in notes)
    jitter = random.Random(seed)
    for index, note in enumerate(notes):
        shift = 8 if index in melody else -6
        shift += 5 if near(downbeats, note.start) else 1 if near(beats, note.start) else -3
        short, wide = contour(note.start, 1.5), contour(note.start, 6)
        if short is not None and wide is not None:
            shift += max(-8, min(8, .8 * (short - wide)))
        shift += max(-4, min(5, 3 * math.log2(max(note.end - note.start, .01) / typical)))
        shift += jitter.randint(-4, 4)
        note.velocity = max(1, min(127, round(note.velocity + shift)))


def render(data, settings):
    if not isinstance(settings, dict) or settings.get('mode') not in LABELS:
        raise ValueError('Choose a playback sound option.')
    mode = settings['mode']
    if mode == 'original':
        parse_midi(data, piano_only=False)
        return data, {'mode': mode, 'label': LABELS[mode], 'selected_parts': [], 'selected_names': [],
                      'removed_notes': 0, 'shifted_notes': 0, 'notice': 'Original MIDI is unchanged.', 'original': True}
    pretty, music = _read(data)
    parts = _parts(pretty, music)
    if mode == 'no_drums':
        selected = [part['id'] for part in parts if not part['is_drum'] and part['notes']]
        if not selected:
            raise ValueError('This MIDI has no notes outside the drum channel. Choose another song or Original MIDI.')
    elif mode == 'piano':
        selected = [part['id'] for part in parts if part['program'] in range(8) and not part['is_drum'] and part['notes']]
        if not selected:
            raise ValueError('This MIDI has no piano or keyboard part. Choose Smart or Custom to adapt other instruments.')
    elif mode == 'smart':
        selected = _recommended(music)
    else:
        selected = settings.get('parts')
        if not isinstance(selected, list) or not selected or any(not isinstance(identity, str) for identity in selected):
            raise ValueError('Select at least one non-drum part for Custom adaptation.')
        selected = list(dict.fromkeys(selected))
        known = {part['id']: part for part in parts}
        if any(identity not in known for identity in selected):
            raise ValueError('Choose parts listed for this MIDI file.')
        if any(known[identity]['is_drum'] for identity in selected):
            raise ValueError('Drum parts cannot be converted into piano notes. Select non-drum parts.')
    if not selected:
        raise ValueError('This MIDI has no melodic parts to adapt. Choose a different song.')
    instruments = [music.instruments[int(identity)] for identity in selected]
    total_notes = sum(len(instrument.notes) for instrument in music.instruments)
    shifts = {id(instrument): _part_shift(instrument) if mode == 'smart' else 0 for instrument in instruments}
    notes, voices, shifted, outside = [], {}, set(), 0
    for index, instrument in enumerate(instruments):
        for note in instrument.notes:
            pitch = note.pitch + shifts[id(instrument)]
            if mode == 'smart' and not 21 <= pitch <= 108:
                outside += 1
                continue
            copy = pretty.Note(velocity=note.velocity, pitch=_fold(pitch), start=note.start, end=note.end)
            notes.append(copy)
            voices[id(copy)] = index
            if copy.pitch != note.pitch:
                shifted.add(id(copy))
    merged_notes = 0
    if mode in ('no_drums', 'smart', 'custom'):
        notes, merged_notes = _merge_overlap(notes, voices if mode in ('no_drums', 'smart') else None)
    if not notes:
        raise ValueError('The selected parts have no playable notes. Select another part.')
    expressive = settings.get('expressive') is True
    if expressive:
        _expressive(notes, music, zlib.crc32(data))
    shifted_notes = sum(id(note) in shifted for note in notes)
    output = pretty.Instrument(program=0, is_drum=False, name='Adapted piano')
    output.notes = notes
    pedal_source = max(instruments, key=lambda instrument: len(instrument.notes))
    output.control_changes = [pretty.ControlChange(number=control.number, value=control.value, time=control.time)
                              for control in pedal_source.control_changes if control.number in (64, 66, 67)]
    if mode in ('no_drums', 'smart', 'custom'):
        output.control_changes = _merge_pedals(pretty, instruments)
    soft_pedal = settings.get('soft_pedal') is True
    if soft_pedal:
        # Re-press at every attack so the pedal is down again right after a seek or resume.
        output.control_changes = [control for control in output.control_changes if control.number != 67]
        output.control_changes += [pretty.ControlChange(number=67, value=127, time=start) for start in sorted({note.start for note in notes})]
        output.control_changes.append(pretty.ControlChange(number=67, value=0, time=max(note.end for note in notes)))
    # Retain the parsed score's tempo and signatures instead of building a new clock.
    music.instruments = [output]
    buffer = io.BytesIO()
    music.write(buffer)
    rendered = buffer.getvalue()
    parse_midi(rendered)
    import mido
    duration = mido.MidiFile(file=io.BytesIO(rendered)).length
    selected_names = [parts[int(identity)]['name'] for identity in selected]
    removed_notes = total_notes - len(notes)
    kept = 'timing' if expressive else 'timing and original velocities'
    notice = f'Retained notes keep their {kept}. Pedals come from the selected part with the most notes.'
    if mode == 'no_drums':
        notice = f'Every part except the drum channel (10) plays on one piano track. Notes keep their {kept}; pedals are merged across parts.'
    elif mode in ('smart', 'custom'):
        notice = f'Experimental rule-based adaptation. Retained attacks keep their {kept}. Pedals are merged across the selected parts; a pedal releases when all parts release it.'
    if merged_notes:
        notice += f' {merged_notes} overlapping copies of the same key were joined to prevent early note releases.'
    if mode in ('no_drums', 'smart'):
        notice += ' Repeated attacks within a part are preserved with an 8 ms release gap inside overlapping holds. Mostly playable parts keep their original register; no polyphony cap is applied.'
    if expressive:
        notice += ' Expressive playback reshapes velocities by rule: louder melody, metric accents, phrase arcs following the melody, weight for longer notes and slight variation.'
    if soft_pedal:
        notice += ' Extra quiet holds the soft pedal for the whole song instead of following the MIDI file.'
    if outside:
        notice += f' {outside} notes outside the piano range were left out rather than moving the whole part.'
    if shifted_notes:
        notice += f' {shifted_notes} notes were shifted by octaves to fit the 88-key range.'
    return rendered, {'mode': mode, 'label': LABELS[mode], 'selected_parts': selected,
                      'selected_names': selected_names, 'removed_notes': removed_notes,
                      'shifted_notes': shifted_notes, 'merged_notes': merged_notes, 'out_of_range_notes': outside, 'notice': notice, 'duration_seconds': duration, 'original': False, 'expressive': expressive, 'soft_pedal': soft_pedal}

"""Experimental, deterministic MIDI part selection; originals stay untouched."""
import io
from itertools import groupby
from pathlib import Path
import statistics
import sys
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
    shifts = [shift for shift in range(-108, 109, 12) if min(pitches) + shift >= 21 and max(pitches) + shift <= 108]
    return min(shifts, key=abs) if shifts else 0


def _merge_overlap(notes):
    """One physical key cannot sustain overlapping copies on separate channels."""
    merged, count = [], 0
    for note in sorted(notes, key=lambda note: (note.pitch, note.start, note.end)):
        if merged and merged[-1].pitch == note.pitch and note.start < merged[-1].end - 1e-9:
            previous = merged[-1]
            if abs(previous.start - note.start) < 1e-9:
                previous.velocity = max(previous.velocity, note.velocity)
            previous.end = max(previous.end, note.end)
            count += 1
        else:
            merged.append(note)
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


def render(data, settings):
    if not isinstance(settings, dict) or settings.get('mode') not in LABELS:
        raise ValueError('Choose a playback sound option.')
    mode = settings['mode']
    if mode == 'original':
        parse_midi(data, piano_only=False)
        return data, {'mode': mode, 'label': LABELS[mode], 'selected_parts': [], 'selected_names': [],
                      'removed_notes': 0, 'shifted_notes': 0, 'notice': 'Original MIDI is unchanged.', 'original': True}
    if mode == 'no_drums':
        import mido
        parse_midi(data, piano_only=False)
        score = mido.MidiFile(file=io.BytesIO(data))
        removed, kept = 0, 0
        for index, track in enumerate(score.tracks):
            output, pending = mido.MidiTrack(), 0
            for message in track:
                pending += message.time
                if getattr(message, 'channel', None) == 9:
                    removed += int(message.type == 'note_on' and message.velocity > 0)
                    continue
                kept += int(message.type == 'note_on' and message.velocity > 0)
                output.append(message.copy(time=pending))
                pending = 0
            if pending:
                output.append(mido.MetaMessage('end_of_track', time=pending))
            score.tracks[index] = output
        if not kept:
            raise ValueError('This MIDI has no notes outside the drum channel. Choose another song or Original MIDI.')
        buffer = io.BytesIO()
        score.save(file=buffer)
        rendered = buffer.getvalue()
        metadata = parse_midi(rendered, piano_only=False)
        return rendered, {'mode': mode, 'label': LABELS[mode], 'selected_parts': [], 'selected_names': [],
                          'removed_notes': removed, 'shifted_notes': 0, 'duration_seconds': metadata['duration'],
                          'notice': 'All instrument parts are preserved except the standard MIDI drum channel (10). Timing, notes, velocities, and pedals stay unchanged.', 'original': False}
    pretty, music = _read(data)
    parts = _parts(pretty, music)
    if mode == 'piano':
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
    original_notes = [note for instrument in instruments for note in instrument.notes]
    shifts = {id(instrument): _part_shift(instrument) if mode == 'smart' else 0 for instrument in instruments}
    notes = [pretty.Note(velocity=note.velocity, pitch=_fold(note.pitch + shifts[id(instrument)]), start=note.start, end=note.end)
             for instrument in instruments for note in instrument.notes]
    shifted = {id(copy) for source, copy in zip(original_notes, notes) if source.pitch != copy.pitch}
    merged_notes = 0
    if mode in ('smart', 'custom'):
        notes, merged_notes = _merge_overlap(notes)
    if not notes:
        raise ValueError('The selected parts have no playable notes. Select another part.')
    shifted_notes = sum(id(note) in shifted for note in notes)
    output = pretty.Instrument(program=0, is_drum=False, name='Adapted piano')
    output.notes = notes
    pedal_source = max(instruments, key=lambda instrument: len(instrument.notes))
    output.control_changes = [pretty.ControlChange(number=control.number, value=control.value, time=control.time)
                              for control in pedal_source.control_changes if control.number in (64, 66, 67)]
    if mode in ('smart', 'custom'):
        output.control_changes = _merge_pedals(pretty, instruments)
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
    notice = 'Retained notes keep their timing and original velocities. Pedals come from the selected part with the most notes.'
    if mode in ('smart', 'custom'):
        notice = 'Experimental rule-based adaptation. Retained attacks keep their timing and velocities. Pedals are merged across the selected parts; a pedal releases when all parts release it.'
    if merged_notes:
        notice += f' {merged_notes} overlapping copies of the same key were joined to prevent early note releases.'
    if mode == 'smart':
        notice += ' Each part uses a consistent octave shift when its full range fits the piano.'
        notice += ' All notes in the selected parts are kept; no polyphony cap is applied.'
    if shifted_notes:
        notice += f' {shifted_notes} out-of-range notes were moved by octaves into the 88-key range.'
    return rendered, {'mode': mode, 'label': LABELS[mode], 'selected_parts': selected,
                      'selected_names': selected_names, 'removed_notes': removed_notes,
                      'shifted_notes': shifted_notes, 'merged_notes': merged_notes, 'notice': notice, 'duration_seconds': duration, 'original': False}

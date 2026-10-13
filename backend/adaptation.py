"""Experimental, deterministic MIDI part selection; originals stay untouched."""
import heapq
import io
from itertools import groupby
from pathlib import Path
import statistics
import sys
from .library import parse_midi

VENDOR = Path(__file__).resolve().parent.parent / 'vendor'
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

LABELS = {'original': 'Original MIDI', 'piano': 'Piano tracks',
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


def _limit_overlap(notes, maximum=8):
    """Keep complete notes; prefer high/low chord edges when onset times match."""
    held, kept = [], []
    for start, group in groupby(sorted(notes, key=lambda note: note.start), key=lambda note: note.start):
        while held and held[0] <= start + 1e-9:
            heapq.heappop(held)
        chord = sorted(group, key=lambda note: note.pitch)
        prioritized = []
        low, high = 0, len(chord) - 1
        while low <= high:
            prioritized.append(chord[high]); high -= 1
            if low <= high:
                prioritized.append(chord[low]); low += 1
        for note in prioritized:
            if len(held) < maximum:
                kept.append(note)
                heapq.heappush(held, note.end)
    return sorted(kept, key=lambda note: (note.start, note.pitch))


def render(data, settings):
    if not isinstance(settings, dict) or settings.get('mode') not in LABELS:
        raise ValueError('Choose Original, Piano, Smart, or Custom adaptation.')
    mode = settings['mode']
    if mode == 'original':
        parse_midi(data, piano_only=False)
        return data, {'mode': mode, 'label': LABELS[mode], 'selected_parts': [], 'selected_names': [],
                      'removed_notes': 0, 'shifted_notes': 0, 'notice': 'Original MIDI is unchanged.', 'original': True}
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
    notes = [pretty.Note(velocity=note.velocity, pitch=_fold(note.pitch), start=note.start, end=note.end)
             for note in original_notes]
    shifted = {id(copy) for source, copy in zip(original_notes, notes) if source.pitch != copy.pitch}
    if mode == 'smart':
        notes = _limit_overlap(notes)
    if not notes:
        raise ValueError('The selected parts have no playable notes. Select another part.')
    shifted_notes = sum(id(note) in shifted for note in notes)
    output = pretty.Instrument(program=0, is_drum=False, name='Adapted piano')
    output.notes = notes
    pedal_source = max(instruments, key=lambda instrument: len(instrument.notes))
    output.control_changes = [pretty.ControlChange(number=control.number, value=control.value, time=control.time)
                              for control in pedal_source.control_changes if control.number in (64, 66, 67)]
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
    notice = 'Timing, note lengths, and original velocities are preserved. Pedals come from the selected part with the most notes.'
    if mode in ('smart', 'custom'):
        notice = 'Experimental rule-based adaptation. ' + notice
    if mode == 'smart':
        notice += ' Complete excess notes are omitted to keep at most eight held notes; no notes are added.'
    if shifted_notes:
        notice += f' {shifted_notes} out-of-range notes were moved by octaves into the 88-key range.'
    return rendered, {'mode': mode, 'label': LABELS[mode], 'selected_parts': selected,
                      'selected_names': selected_names, 'removed_notes': removed_notes,
                      'shifted_notes': shifted_notes, 'notice': notice, 'duration_seconds': duration, 'original': False}

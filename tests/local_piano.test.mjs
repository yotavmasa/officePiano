import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LocalPiano, noteIndexAt, parseMidi, pedalReleaseTime, pianoVoice } from '../web/localPiano.mjs';

const { Midi } = createRequire(new URL('../web/package.json', import.meta.url))('@tonejs/midi');

function midiBytes(build) {
  const midi = new Midi();
  midi.header.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 960, bpm: 60 }];
  midi.header.update();
  build(midi);
  return midi.toArray();
}

function fakeContext() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  const context = {
    currentTime: 0,
    state: 'running',
    destination: node(),
    starts: [],
    stops: [],
    createGain: () => ({ ...node(), gain: param() }),
    createDynamicsCompressor: node,
    createOscillator: () => {
      const oscillator = {
        ...node(),
        type: 'sine',
        frequency: param(),
        start(at) { if (oscillator.type === 'triangle') context.starts.push(Math.round(at * 1000) / 1000); },
        stop(at) { if (oscillator.type === 'triangle') context.stops.push(Math.round(at * 1000) / 1000); },
      };
      return oscillator;
    },
    resume() {},
    close() {},
  };
  return context;
}

test('notes follow the tempo map, keep velocity, and skip percussion', () => {
  const bytes = midiBytes(midi => {
    const piano = midi.addTrack();
    piano.channel = 0;
    piano.addNote({ midi: 64, ticks: 1440, durationTicks: 480, velocity: 64 / 127 });
    piano.addNote({ midi: 60, ticks: 0, durationTicks: 480, velocity: 1 });
    piano.addNote({ midi: 67, ticks: 960, durationTicks: 240, velocity: 95 / 127 });
    const drums = midi.addTrack();
    drums.channel = 9;
    drums.addNote({ midi: 36, ticks: 0, durationTicks: 120, velocity: 1 });
  });
  const result = parseMidi(bytes.buffer);
  assert.deepEqual(result, {
    notes: [
      { start: 0, duration: 0.5, pitch: 60, velocity: 127 },
      { start: 1, duration: 0.5, pitch: 67, velocity: 95 },
      { start: 2, duration: 1, pitch: 64, velocity: 64 },
    ],
    duration: 3,
  });
});

test('sustain pedal holds released notes until the pedal lifts', () => {
  const bytes = midiBytes(midi => {
    const piano = midi.addTrack();
    piano.channel = 0;
    piano.addCC({ number: 64, value: 1, ticks: 0 });
    piano.addNote({ midi: 60, ticks: 0, durationTicks: 240, velocity: 1 });
    piano.addCC({ number: 64, value: 0, ticks: 960 });
    piano.addNote({ midi: 62, ticks: 960, durationTicks: 240, velocity: 1 });
  });
  const result = parseMidi(bytes).notes.map(note => [note.pitch, note.start, note.duration]);
  assert.deepEqual(result, [[60, 0, 1], [62, 1, 0.5]]);
});

test('unreadable files explain the problem', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4])), { message: 'This MIDI file could not be read.' });
});

for (const [name, changes, noteEnd, expected] of [
  ['no pedal', [], 1, 1],
  ['pedal up before note ends', [{ time: 0, value: 1 }, { time: 0.5, value: 0 }], 1, 1],
  ['pedal held until a later lift', [{ time: 0, value: 1 }, { time: 2, value: 0 }], 1, 2],
  ['half-pedal values stay down', [{ time: 0, value: 1 }, { time: 1.5, value: 0.7 }, { time: 3, value: 0.1 }], 1, 3],
  ['pedal pressed after note ends', [{ time: 2, value: 1 }, { time: 3, value: 0 }], 1, 1],
  ['pedal never lifted', [{ time: 0, value: 1 }], 1, 1],
]) {
  test(`pedal release: ${name}`, () => {
    assert.equal(pedalReleaseTime(changes, noteEnd), expected);
  });
}

for (const [seconds, expected] of [[-1, 0], [0, 0], [0.25, 1], [0.5, 1], [2, 3], [9, 4]]) {
  test(`playback resumes at the first note from ${seconds}s`, () => {
    const notes = [0, 0.5, 0.5, 2].map(start => ({ start }));
    assert.equal(noteIndexAt(notes, seconds), expected);
  });
}

test('piano voice is tuned to A440 and decays faster in the treble', () => {
  const low = pianoVoice(21, 127);
  const concert = pianoVoice(69, 127);
  const high = pianoVoice(108, 64);
  assert.deepEqual(
    { concert: concert.frequency, peak: concert.peak, lowDecaysSlower: low.decay > high.decay, quieterWhenSofter: high.peak < concert.peak },
    { concert: 440, peak: 0.3, lowDecaysSlower: true, quieterWhenSofter: true },
  );
});

test('scheduler plays ahead, pauses, seeks, and reports the end', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const context = fakeContext();
    let ended = 0;
    const piano = new LocalPiano({ createContext: () => context, onEnd: () => { ended += 1; } });
    piano.load({ notes: [0, 0.5, 2, 3].map(start => ({ start, duration: 0.5, pitch: 60, velocity: 100 })), duration: 3.5 });
    piano.play();
    const firstWindow = [...context.starts];
    context.currentTime = 1.5;
    mock.timers.tick(100);
    const secondWindow = [...context.starts];
    piano.pause();
    const pausedAt = Math.round(piano.position * 1000) / 1000;
    const silencedVoices = context.stops.filter(at => at === 1.55).length;
    piano.seek(2.9);
    piano.play();
    context.currentTime = 5;
    mock.timers.tick(100);
    assert.deepEqual(
      { firstWindow, secondWindow, pausedAt, silencedVoices, allStarts: context.starts, ended, state: piano.state, position: piano.position },
      { firstWindow: [0.05, 0.55], secondWindow: [0.05, 0.55, 2.05], pausedAt: 1.45, silencedVoices: 3, allStarts: [0.05, 0.55, 2.05, 1.65], ended: 1, state: 'stopped', position: 3.5 },
    );
  } finally {
    mock.timers.reset();
  }
});

test('playback can start partway through a song', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const context = fakeContext();
    const piano = new LocalPiano({ createContext: () => context });
    piano.load({ notes: [0, 1, 2, 3].map(start => ({ start, duration: 0.5, pitch: 60, velocity: 100 })), duration: 3.5 });
    piano.seek(1.5);
    const waiting = { state: piano.state, position: piano.position, starts: context.starts.length };
    piano.play();
    piano.stop();
    assert.deepEqual({ waiting, starts: context.starts }, { waiting: { state: 'stopped', position: 1.5, starts: 0 }, starts: [0.55] });
  } finally {
    mock.timers.reset();
  }
});

test('press holds a key until release and replaces a repeated press', () => {
  const context = fakeContext();
  const piano = new LocalPiano({ createContext: () => context });
  piano.press(60, 100);
  assert.equal(piano.held.size, 1);
  assert.equal(context.starts.length, 1);
  piano.press(60, 80);
  assert.equal(piano.held.size, 1);
  assert.equal(context.starts.length, 2);
  context.currentTime = 1;
  piano.release(60);
  piano.release(61);
  assert.equal(piano.held.size, 0);
  assert.ok(context.stops.some(time => time > 1 && time < 2));
});

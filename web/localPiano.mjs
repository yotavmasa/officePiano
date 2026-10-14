import * as tonejsMidi from '@tonejs/midi';

const { Midi } = tonejsMidi.default ?? tonejsMidi;
const DRUM_CHANNEL = 9;
const LOOKAHEAD_SECONDS = 1;
const SCHEDULE_INTERVAL_MS = 100;
const START_DELAY_SECONDS = 0.05;
const RELEASE_SECONDS = 0.08;

const pedalDown = change => change.value >= 0.5;

export function pedalReleaseTime(pedalChanges, noteEnd) {
  let low = 0;
  let high = pedalChanges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pedalChanges[middle].time <= noteEnd) low = middle + 1; else high = middle;
  }
  if (low === 0 || !pedalDown(pedalChanges[low - 1])) return noteEnd;
  for (let index = low; index < pedalChanges.length; index += 1) {
    if (!pedalDown(pedalChanges[index])) return pedalChanges[index].time;
  }
  return noteEnd;
}

export function parseMidi(buffer) {
  let midi;
  try { midi = new Midi(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)); }
  catch { throw Error('This MIDI file could not be read.'); }
  const notes = [];
  for (const track of midi.tracks) {
    if (track.channel === DRUM_CHANNEL || track.instrument.percussion) continue;
    const pedal = [...(track.controlChanges[64] || [])].sort((a, b) => a.time - b.time);
    for (const note of track.notes) {
      const end = pedalReleaseTime(pedal, note.time + note.duration);
      notes.push({ start: note.time, duration: end - note.time, pitch: note.midi, velocity: Math.round(note.velocity * 127) });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const duration = notes.reduce((longest, note) => Math.max(longest, note.start + note.duration), 0);
  return { notes, duration };
}

export function noteIndexAt(notes, seconds) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle].start < seconds) low = middle + 1; else high = middle;
  }
  return low;
}

export function pianoVoice(pitch, velocity) {
  const frequency = 440 * 2 ** ((pitch - 69) / 12);
  const peak = 0.3 * (velocity / 127) ** 1.5;
  const decay = Math.min(1.6, Math.max(0.25, 1.6 - (pitch - 21) * 0.016));
  return { frequency, peak, decay };
}

function defaultAudioContext() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw Error('This browser cannot play audio.');
  return new AudioContextClass();
}

export class LocalPiano {
  constructor({ onEnd = () => {}, createContext = defaultAudioContext } = {}) {
    this.onEnd = onEnd;
    this.createContext = createContext;
    this.context = null;
    this.output = null;
    this.notes = [];
    this.duration = 0;
    this.offset = 0;
    this.state = 'stopped';
    this.volume = 0.8;
    this.voices = new Set();
    this.timer = null;
    this.nextIndex = 0;
    this.startedAt = 0;
    this.startOffset = 0;
  }

  unlock() {
    if (!this.context) {
      this.context = this.createContext();
      const compressor = this.context.createDynamicsCompressor();
      this.output = this.context.createGain();
      this.output.gain.value = this.volume;
      this.output.connect(compressor);
      compressor.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume();
  }

  load({ notes, duration }) {
    this.halt();
    this.notes = notes;
    this.duration = duration;
    this.offset = 0;
    this.state = 'stopped';
  }

  get position() {
    if (this.state !== 'playing') return this.offset;
    return Math.min(this.duration, Math.max(0, this.startOffset + this.context.currentTime - this.startedAt));
  }

  play() {
    if (this.state === 'playing' || !this.notes.length) return;
    this.unlock();
    if (this.offset >= this.duration) this.offset = 0;
    this.startOffset = this.offset;
    this.startedAt = this.context.currentTime + START_DELAY_SECONDS;
    this.nextIndex = noteIndexAt(this.notes, this.offset);
    this.state = 'playing';
    this.schedule();
    this.timer = setInterval(() => this.schedule(), SCHEDULE_INTERVAL_MS);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.offset = this.position;
    this.halt();
    this.state = 'paused';
  }

  stop() {
    this.halt();
    this.offset = 0;
    this.state = 'stopped';
  }

  seek(seconds) {
    const resume = this.state === 'playing';
    this.halt();
    this.offset = Math.min(this.duration, Math.max(0, Number(seconds) || 0));
    if (resume) {
      this.state = 'paused';
      this.play();
    }
  }

  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.output) this.output.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
  }

  close() {
    this.halt();
    this.state = 'stopped';
    this.context?.close?.();
    this.context = null;
    this.output = null;
  }

  schedule() {
    const now = this.context.currentTime;
    const songNow = this.startOffset + now - this.startedAt;
    if (songNow >= this.duration) {
      this.halt();
      this.offset = this.duration;
      this.state = 'stopped';
      this.onEnd();
      return;
    }
    const horizon = songNow + LOOKAHEAD_SECONDS;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].start < horizon) {
      const note = this.notes[this.nextIndex++];
      this.voice(note, this.startedAt + note.start - this.startOffset);
    }
  }

  voice(note, requestedStart) {
    const context = this.context;
    const start = Math.max(requestedStart, context.currentTime);
    const { frequency, peak, decay } = pianoVoice(note.pitch, note.velocity);
    const release = start + Math.max(0.03, note.duration);
    const silent = Math.min(release, start + decay * 6) + RELEASE_SECONDS * 5;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + 0.005);
    envelope.gain.setTargetAtTime(0, start + 0.005, decay);
    envelope.gain.setTargetAtTime(0, release, RELEASE_SECONDS);
    envelope.connect(this.output);
    const fundamental = context.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = frequency;
    fundamental.connect(envelope);
    const overtone = context.createOscillator();
    const overtoneLevel = context.createGain();
    overtone.type = 'sine';
    overtone.frequency.value = frequency * 2;
    overtoneLevel.gain.value = 0.25;
    overtone.connect(overtoneLevel);
    overtoneLevel.connect(envelope);
    const voice = { envelope, oscillators: [fundamental, overtone] };
    this.voices.add(voice);
    fundamental.onended = () => {
      this.voices.delete(voice);
      envelope.disconnect();
    };
    for (const oscillator of voice.oscillators) {
      oscillator.start(start);
      oscillator.stop(silent);
    }
  }

  halt() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const voice of this.voices) {
      voice.envelope.gain.cancelScheduledValues(now);
      voice.envelope.gain.setTargetAtTime(0, now, 0.01);
      for (const oscillator of voice.oscillators) {
        try { oscillator.stop(now + 0.05); } catch {}
      }
    }
    this.voices.clear();
  }
}

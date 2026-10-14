export const LOWEST_PITCH = 21;
export const HIGHEST_PITCH = 108;
const BLACK = new Set([1, 3, 6, 8, 10]);
const WHITE_KEYS = 52;
const BLACK_WIDTH = 0.6;

export const isBlackKey = pitch => BLACK.has(pitch % 12);

export function keyLayout(width) {
  const white = width / WHITE_KEYS;
  const keys = new Map();
  let whiteIndex = 0;
  for (let pitch = LOWEST_PITCH; pitch <= HIGHEST_PITCH; pitch += 1) {
    if (isBlackKey(pitch)) {
      keys.set(pitch, { x: whiteIndex * white - white * BLACK_WIDTH / 2, width: white * BLACK_WIDTH, black: true });
    } else {
      keys.set(pitch, { x: whiteIndex * white, width: white, black: false });
      whiteIndex += 1;
    }
  }
  return keys;
}

export function longestNote(notes) {
  return notes.reduce((longest, note) => Math.max(longest, note.duration), 0);
}

function firstStartAtOrAfter(notes, seconds) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle].start < seconds) low = middle + 1; else high = middle;
  }
  return low;
}

// Notes sorted by start that overlap [now, now + ahead]. `longest` bounds how far back a sounding note can start.
export function visibleNotes(notes, now, ahead, longest = longestNote(notes)) {
  const visible = [];
  const end = now + ahead;
  for (let index = firstStartAtOrAfter(notes, now - longest); index < notes.length && notes[index].start < end; index += 1) {
    const note = notes[index];
    if (note.start + note.duration > now) visible.push(note);
  }
  return visible;
}

// Extrapolates a polled position between updates while playing, without running past the song.
export function songClock({ seconds = 0, playing = false, at = 0, duration = Infinity }, now) {
  if (!playing) return seconds;
  return Math.min(duration, seconds + Math.max(0, now - at) / 1000);
}

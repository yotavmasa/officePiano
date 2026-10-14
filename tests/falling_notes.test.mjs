import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGHEST_PITCH, LOWEST_PITCH, isBlackKey, keyLayout, longestNote, songClock, visibleNotes } from '../web/fallingNotes.mjs';

test('keyLayout spans 88 keys across the full width with black keys between white keys', () => {
  const keys = keyLayout(520);
  assert.equal(keys.size, 88);
  assert.equal([...keys.values()].filter(key => !key.black).length, 52);
  assert.deepEqual(keys.get(LOWEST_PITCH), { x: 0, width: 10, black: false });
  const top = keys.get(HIGHEST_PITCH);
  assert.equal(top.x + top.width, 520);
  const sharp = keys.get(22);
  assert.ok(sharp.black && sharp.x > 0 && sharp.x + sharp.width < keys.get(23).x + keys.get(23).width);
  assert.equal(isBlackKey(61), true);
  assert.equal(isBlackKey(60), false);
});

test('visibleNotes includes long notes still sounding and excludes finished or distant notes', () => {
  const notes = [
    { start: 0, duration: 10, pitch: 60 },
    { start: 1, duration: 1, pitch: 62 },
    { start: 4.5, duration: 1, pitch: 64 },
    { start: 6, duration: 1, pitch: 65 },
    { start: 9, duration: 1, pitch: 67 },
  ];
  const longest = longestNote(notes);
  assert.equal(longest, 10);
  assert.deepEqual(visibleNotes(notes, 5, 3, longest).map(note => note.pitch), [60, 64, 65]);
  assert.deepEqual(visibleNotes(notes, 5, 3).map(note => note.pitch), [60, 64, 65]);
  assert.deepEqual(visibleNotes([], 5, 3), []);
});

test('songClock extrapolates only while playing and stops at the song end', () => {
  assert.equal(songClock({ seconds: 12, playing: false, at: 1000 }, 5000), 12);
  assert.equal(songClock({ seconds: 12, playing: true, at: 1000 }, 2500), 13.5);
  assert.equal(songClock({ seconds: 12, playing: true, at: 1000, duration: 13 }, 9000), 13);
  assert.equal(songClock({ seconds: 12, playing: true, at: 3000 }, 2000), 12);
});

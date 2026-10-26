import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyQueueAction, readDeviceQueue } from '../web/deviceQueue.mjs';

const apply = (song_ids, index, request) => applyQueueAction({ song_ids, index }, request);

test('adding appends or inserts, keeping the current song current', () => {
  assert.deepEqual(apply(['A'], 0, { action: 'add', song_id: 'B' }).queue, { song_ids: ['A', 'B'], index: 0 });
  assert.deepEqual(apply(['A', 'B'], 1, { action: 'add', song_id: 'C', index: 0, expected_song_ids: ['A', 'B'] }).queue, { song_ids: ['C', 'A', 'B'], index: 2 });
  assert.throws(() => apply(['A', 'B'], 1, { action: 'add', song_id: 'C', index: 0, expected_song_ids: ['A'] }), /queue changed/);
  assert.throws(() => apply([], 0, { action: 'add' }), /saved song/);
});

test('playing a song replaces only the Now playing slot', () => {
  assert.deepEqual(apply(['A', 'B', 'C'], 0, { action: 'replace_current', song_id: 'D' }), { queue: { song_ids: ['D', 'B', 'C'], index: 0 }, stop: false });
  assert.deepEqual(apply(['A', 'B'], 1, { action: 'replace_current', song_id: 'D', index: 1, expected_song_ids: ['A', 'B'] }).queue, { song_ids: ['A', 'D'], index: 1 });
  assert.deepEqual(apply([], 0, { action: 'replace_current', song_id: 'D' }).queue, { song_ids: ['D'], index: 0 });
});

test('finishing removes the song and the next one becomes current', () => {
  assert.deepEqual(apply(['A', 'B', 'C'], 0, { action: 'finish', index: 0, song_id: 'A' }).queue, { song_ids: ['B', 'C'], index: 0 });
  assert.deepEqual(apply(['A'], 0, { action: 'finish', index: 0, song_id: 'A' }).queue, { song_ids: [], index: 0 });
  assert.throws(() => apply(['A', 'B'], 0, { action: 'finish', index: 0, song_id: 'B' }), /finished song was left/);
});

test('removing, clearing or replacing the playing song asks to stop playback', () => {
  assert.deepEqual(apply(['A', 'B', 'C'], 1, { action: 'remove', index: 1 }), { queue: { song_ids: ['A', 'C'], index: 1 }, stop: true });
  assert.deepEqual(apply(['A', 'B', 'C'], 2, { action: 'remove', index: 0 }), { queue: { song_ids: ['B', 'C'], index: 1 }, stop: false });
  assert.deepEqual(apply(['A', 'B', 'C'], 0, { action: 'clear_after', index: 0, expected_song_ids: ['A', 'B', 'C'] }), { queue: { song_ids: ['A'], index: 0 }, stop: false });
  assert.equal(apply(['A', 'B'], 0, { action: 'clear' }).stop, true);
  assert.deepEqual(apply(['A'], 0, { action: 'replace', song_ids: ['X', 'Y'] }), { queue: { song_ids: ['X', 'Y'], index: 0 }, stop: true });
});

test('moving keeps the current song current, including duplicates', () => {
  assert.deepEqual(apply(['A', 'B', 'C'], 0, { action: 'move', from: 0, to: 2 }).queue, { song_ids: ['B', 'C', 'A'], index: 2 });
  assert.deepEqual(apply(['A', 'B', 'B'], 1, { action: 'move', from: 2, to: 0 }).queue, { song_ids: ['B', 'A', 'B'], index: 2 });
  assert.throws(() => apply(['A', 'B'], 0, { action: 'move', from: 0, to: 5 }), /Choose a song/);
});

test('a saved queue is read defensively', () => {
  assert.deepEqual(readDeviceQueue('{"song_ids":["A","B",3],"index":9}'), { song_ids: ['A', 'B'], index: 1 });
  assert.deepEqual(readDeviceQueue('not json'), { song_ids: [], index: 0 });
  assert.deepEqual(readDeviceQueue(''), { song_ids: [], index: 0 });
});

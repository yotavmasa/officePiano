import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSheetSongs } from '../web/sheetGroups.mjs';

test('songs stay under their book in saved order and appear only once', () => {
  const items = [{ id: 'book', extension: '.pdf', page_count: 20 }, { id: 'other', extension: '.pdf', page_count: 2 }];
  const sources = [{ song_id: 'a', source_id: 'book' }, { song_id: 'b', source_id: 'book' }, { song_id: 'a', source_id: 'other' }];
  const result = groupSheetSongs(items, sources, [{ id: 'b' }, { id: 'a' }, { id: 'loose' }]);
  assert.deepEqual(result.books[0].songs.map(song => song.id), ['b', 'a']);
  assert.equal(result.books[1].songs.length, 0);
  assert.deepEqual(result.looseSongs.map(song => song.id), ['loose']);
});

test('songs from removed books and single pages stay available separately', () => {
  const result = groupSheetSongs([{ id: 'page', extension: '.pdf', page_count: 1 }],
    [{ song_id: 'a', source_id: 'removed' }, { song_id: 'b', source_id: 'page' }], [{ id: 'a' }, { id: 'b' }]);
  assert.equal(result.books.length, 0);
  assert.equal(result.looseSongs.length, 2);
});

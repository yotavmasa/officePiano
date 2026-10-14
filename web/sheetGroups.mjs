export function groupSheetSongs(items, sources, songs) {
  const books = items.filter(item => !item.book_id && item.extension === '.pdf' && item.page_count > 1)
    .map(book => ({ book, songs: [] }));
  const byId = new Map(books.map(group => [group.book.id, group]));
  const assignment = new Map();
  for (const source of sources) {
    if (byId.has(source.source_id) && !assignment.has(source.song_id)) assignment.set(source.song_id, source.source_id);
  }
  const looseSongs = [];
  for (const song of songs) {
    const group = byId.get(assignment.get(song.id));
    if (group) group.songs.push(song); else looseSongs.push(song);
  }
  return { books, looseSongs };
}

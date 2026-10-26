// A queue kept in this browser for playback on this device. Mirrors the piano queue's rules in backend/playback.py
// so the same queue panel and actions work for both; `stop` asks the caller to stop this device's playback.
const MAX_QUEUE = 500;

export const EMPTY_QUEUE = { song_ids: [], index: 0 };

export function readDeviceQueue(saved) {
  try {
    const value = JSON.parse(saved || '');
    const ids = Array.isArray(value?.song_ids) ? value.song_ids.filter(id => typeof id === 'string').slice(0, MAX_QUEUE) : [];
    const index = Number.isInteger(value?.index) ? Math.min(Math.max(0, value.index), Math.max(0, ids.length - 1)) : 0;
    return { song_ids: ids, index };
  } catch {
    return EMPTY_QUEUE;
  }
}

export function applyQueueAction(queue, request) {
  const ids = [...queue.song_ids];
  let index = queue.index;
  let stop = false;
  const position = value => {
    if (!Number.isInteger(value) || value < 0 || value >= ids.length) throw Error('Choose a song in the queue.');
    return value;
  };
  const expect = message => {
    if ('expected_song_ids' in request && JSON.stringify(request.expected_song_ids) !== JSON.stringify(queue.song_ids)) throw Error(message);
  };
  const song = () => {
    if (typeof request.song_id !== 'string' || !request.song_id) throw Error('Choose a saved song.');
    return request.song_id;
  };
  switch (request.action) {
    case 'add': {
      const id = song();
      if (ids.length >= MAX_QUEUE) throw Error('The queue can hold up to 500 songs.');
      if (!('index' in request)) ids.push(id);
      else {
        expect('The queue changed. Try adding the song again.');
        const at = request.index;
        if (!Number.isInteger(at) || at < 0 || at > ids.length) throw Error('Choose a place in the queue.');
        if (ids.length && at <= index) index += 1;
        ids.splice(at, 0, id);
      }
      break;
    }
    case 'replace': {
      const songs = request.song_ids;
      if (!Array.isArray(songs) || songs.length > MAX_QUEUE || songs.some(id => typeof id !== 'string')) throw Error('Choose a queue of up to 500 saved songs.');
      ids.splice(0, ids.length, ...songs);
      index = 0;
      stop = true;
      break;
    }
    case 'clear':
      ids.length = 0;
      index = 0;
      stop = true;
      break;
    case 'clear_after': {
      expect('The queue changed. Try clearing it again.');
      const at = position(request.index);
      if (index > at) { stop = true; index = at; }
      ids.length = at + 1;
      break;
    }
    case 'select':
      index = position(request.index);
      break;
    case 'finish': {
      const at = position(request.index);
      if (request.song_id !== ids[at]) throw Error('The queue changed. The finished song was left in place.');
      ids.splice(at, 1);
      index = Math.min(at, Math.max(0, ids.length - 1));
      break;
    }
    case 'remove': {
      const at = position(request.index);
      if (at === index) stop = true;
      ids.splice(at, 1);
      if (at < index) index -= 1;
      index = Math.min(index, Math.max(0, ids.length - 1));
      break;
    }
    case 'move': {
      expect('The queue changed. Try moving the song again.');
      const from = position(request.from);
      const to = position(request.to);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      if (index === from) index = to;
      else if (from < index && index <= to) index -= 1;
      else if (to <= index && index < from) index += 1;
      break;
    }
    case 'replace_current': {
      const id = song();
      expect('The queue changed. Try playing the song again.');
      if (!ids.length) { ids.push(id); index = 0; }
      else ids['index' in request ? position(request.index) : index] = id;
      break;
    }
    default:
      throw Error('Invalid queue command.');
  }
  return { queue: { song_ids: ids, index }, stop };
}

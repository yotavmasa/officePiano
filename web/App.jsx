import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { SortableList, SortableItem } from './SortableList.jsx';
import { groupSheetSongs } from './sheetGroups.mjs';
import SheetBookDialog, { analysisProgressText } from './SheetBookDialog.jsx';

const storage = {
  get(name) { try { return localStorage.getItem(name) || ''; } catch { return ''; } },
  set(name, value) { try { localStorage.setItem(name, value); } catch {} },
};

function browserId() {
  const saved = storage.get('piano-client-id');
  if (/^[a-f0-9-]{16,64}$/.test(saved)) return saved;
  const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  storage.set('piano-client-id', id);
  return id;
}

function initialKey() {
  let key = location.hash.slice(1) || window.__localPianoKey || '';
  if (!key) {
    try { key = sessionStorage.getItem('piano-key') || ''; } catch {}
    key = key || storage.get('piano-key') || '';
  }
  if (key) {
    storage.set('piano-key', key);
    try { sessionStorage.setItem('piano-key', key); } catch {}
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return key;
}

const time = seconds => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const songTitle = name => String(name || '').replace(/\.midi?$/i, '');
function reorderedSongIds(fullIds, visibleIds, from, to) {
  const ordered = [...visibleIds];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const visible = new Set(visibleIds);
  let position = 0;
  return fullIds.map(id => visible.has(id) ? ordered[position++] : id);
}

const safeSource = source => {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && ['bitmidi.com', 'www.bitmidi.com', 'freemidi.org', 'www.freemidi.org', 'bushgrafts.com', 'www.bushgrafts.com', 'kunstderfuge.com', 'www.kunstderfuge.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
};

const sourceDescriptions = {
  all: 'All four catalogs: popular songs, jazz piano performances, and classical music.',
  both: 'BitMidi and FreeMidi: popular songs, games, and mixed-instrument arrangements.',
  bitmidi: 'BitMidi: popular songs and game music.',
  freemidi: 'FreeMidi: songs across many artists and genres.',
  bushgrafts: 'Bushgrafts: Doug McKenzie’s jazz piano performances, including solo, duet, and trio recordings.',
  kunstderfuge: 'Kunst der Fuge: classical music by composer, including piano works and other instruments. Download limits may apply.',
};
const sourceLabels = { bitmidi: 'BitMidi', freemidi: 'FreeMidi', bushgrafts: 'Bushgrafts', kunstderfuge: 'Kunst der Fuge' };
const providerName = source => {
  try {
    const host = new URL(source).hostname.replace(/^www\./, '');
    return sourceLabels[{ 'bitmidi.com': 'bitmidi', 'freemidi.org': 'freemidi', 'bushgrafts.com': 'bushgrafts', 'kunstderfuge.com': 'kunstderfuge' }[host]] || 'MIDI source';
  } catch { return sourceLabels[source] || 'MIDI source'; }
};

function Icon({ name, style }) {
  const paths = {
    piano: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 12v8m8-8v8M6 4v8h4V4m4 0v8h4V4" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    edit: <><path d="m4 16 12-12 4 4-12 12-5 1Z M14 6l4 4" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    heart: <path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 6l-1-1.2a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    note: <><path d="M9 17V5l11-2v12M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
    play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
    pause: <path d="M8 5v14m8-14v14" strokeWidth="4" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    volume: <path d="M11 4 6 8H3v8h3l5 4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />,
    upload: <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
    arrow: <path d="m9 6 6 6-6 6" />,
    grip: <><circle cx="9" cy="5" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="19" r="1" /></>,
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z M12 5v15" /></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    wifi: <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0" /><circle cx="12" cy="20" r=".5" fill="currentColor" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    link: <path d="m10 14 4-4m-5 1L7 13a4 4 0 0 0 6 6l2-2m0-6 2-2a4 4 0 0 0-6-6l-2 2" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" style={style}>{paths[name] || paths.note}</svg>;
}

function IconButton({ icon, label, onClick, disabled = false, active = false, style }) {
  return <button className={active ? 'favorited' : ''} onClick={onClick} disabled={disabled} title={label} aria-label={label}><Icon name={icon} style={style} /></button>;
}

function Dialog({ title, onClose, children, closeDisabled = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }}>
    <div className="dialog-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" disabled={closeDisabled} onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function EmptyState({ icon = 'note', title, description, button, onClick }) {
  return <div className="empty"><Icon name={icon} /><h3>{title}</h3><p>{description}</p>{button && <button className="btn light" onClick={onClick}>{button}</button>}</div>;
}

function SearchResult({ result, libraries, busy, onSave, notice }) {
  const [destination, setDestination] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const destinationId = useId();
  const piano = result.piano_only === true;
  const source = safeSource(result.url);
  const provider = providerName(result.url || result.source);

  async function save(event) {
    event.preventDefault();
    if (busy || saving) return;
    setAttempted(true);
    setSaving(true);
    const success = await onSave(result, destination);
    setSaving(false);
    if (success) {
      setSaved(true);
      setOpen(false);
    }
  }

  return <>
    <div className="song-row">
      <div className="mini-art"><Icon name="note" /></div>
      <div className="song-info result-info">
        <div className="song-name" title={result.name}>{result.name}</div>
        <div className="song-sub result-source">{provider}{result.source === 'bushgrafts' ? ' · Jazz piano' : result.source === 'kunstderfuge' ? ' · Classical' : ''}</div>
        <span className={`result-badge ${piano ? '' : result.piano_only === false ? 'other' : 'unchecked'}`}>
          {piano ? 'Piano only' : result.piano_only === false ? 'Other MIDI' : 'Not checked'}
        </span>
        {result.reason && <div className="search-reason" title={result.reason}>{result.reason.replace(/Choose a piano-only MIDI file\./g, '').trim()}</div>}
        {source && <><br /><a className="source-link" href={source} target="_blank" rel="noopener noreferrer">View on {provider}</a></>}
      </div>
      <button className="btn light small result-save" disabled={busy} onClick={() => { setAttempted(false); setOpen(true); }}>
        {saved ? 'Saved ✓' : 'Save song'}
      </button>
    </div>
    {open && <Dialog title="Save song" closeDisabled={saving} onClose={() => { if (!saving) setOpen(false); }}>
      <form onSubmit={save}>
        <p className="dialog-hint save-song-name">{result.name}</p>
        <label className="dialog-label" htmlFor={destinationId}>Save to</label>
        <select id={destinationId} className="field" value={destination} disabled={saving} onChange={event => setDestination(event.target.value)}>
          <option value="">All songs</option>
          {libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
        </select>
        <p className="dialog-hint">Saved locally and available in your Player.</p>
        {attempted && notice && !notice.success && <p className="message visible" role="alert">{notice.text}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn light" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn" disabled={busy || saving}>{saving ? <><span className="spinner" /> Saving</> : 'Save song'}</button>
        </div>
      </form>
    </Dialog>}
  </>;
}

function App() {
  const [key] = useState(initialKey);
  const [clientId] = useState(browserId);
  const [view, setView] = useState(() => new URLSearchParams(location.search).get('view') || 'player');
  const [status, setStatus] = useState(null);
  const [library, setLibrary] = useState({ songs: [], libraries: [] });
  const [preferred, setPreferred] = useState(() => storage.get('piano-device-name'));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [adaptationData, setAdaptationData] = useState(null);
  const [adaptationMode, setAdaptationMode] = useState('original');
  const [adaptationParts, setAdaptationParts] = useState([]);
  const [adaptationLoading, setAdaptationLoading] = useState(false);
  const [adaptationError, setAdaptationError] = useState('');
  const [adaptationAttempted, setAdaptationAttempted] = useState(false);
  const [adaptationSongId, setAdaptationSongId] = useState('');
  const [adaptationExpectedSongId, setAdaptationExpectedSongId] = useState('');
  const [libraryName, setLibraryName] = useState('');
  const [songArtist, setSongArtist] = useState('');
  const [songAlbum, setSongAlbum] = useState('');
  const [filter, setFilter] = useState('');
  const [seekPreview, setSeekPreview] = useState(null);
  const [volume, setVolume] = useState(100);
  const [query, setQuery] = useState('');
  const [searchSource, setSearchSource] = useState(() => {
    const saved = storage.get('piano-search-source');
    return ['bitmidi', 'freemidi', 'bushgrafts', 'kunstderfuge', 'both', 'all'].includes(saved) ? saved : 'all';
  });
  const [searchData, setSearchData] = useState({ results: [], page: 0, query: '', hasMore: false, checked: 0, searched: false, source: searchSource, warnings: [] });
  const [searching, setSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [failedArtwork, setFailedArtwork] = useState('');
  const [loadedArtwork, setLoadedArtwork] = useState('');
  const fileInput = useRef(null);
  const sheetInput = useRef(null);
  const [sheets, setSheets] = useState({ items: [], available: null });
  const [sheetError, setSheetError] = useState('');
  const [sheetPieces, setSheetPieces] = useState([]);
  const [splitError, setSplitError] = useState('');
  const dragRef = useRef(null);
  const orderState = useRef(null);
  const runTask = useRef(null);
  const busyRef = useRef(false);
  const refreshing = useRef(false);
  const volumeDragging = useRef(false);
  const connectSent = useRef('');
  const searchController = useRef(null);
  const searchGeneration = useRef(0);
  const adaptationRequest = useRef(0);

  const announce = useCallback((text, success = false) => setNotice(text ? { text, success } : null), []);
  const acceptLibrary = useCallback(data => {
    if (Array.isArray(data?.songs) && Array.isArray(data?.libraries)) setLibrary(data);
  }, []);
  const api = useCallback(async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
    let data;
    try { data = await response.json(); } catch { throw Error('The piano app could not respond. Make sure it is running on your Mac.'); }
    if (!response.ok || data.ok === false) throw Error(data.error || 'Connection failed');
    return data;
  }, [key, clientId]);
  const post = useCallback((path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), [api]);
  const fetchSheetPreview = useCallback(async (id, page, signal) => {
    const response = await fetch(`/api/sheets/preview?id=${encodeURIComponent(id)}&page=${page}`, { signal, headers: { Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
    if (!response.ok) {
      let detail;
      try { detail = await response.json(); } catch {}
      throw Error(detail?.error || 'The page preview could not load.');
    }
    if (!response.headers.get('Content-Type')?.startsWith('image/png')) throw Error('The preview was not an image.');
    return response.blob();
  }, [key, clientId]);


  useEffect(() => {
    if (status?.playback_error || status?.queue?.error) announce(status.playback_error || status.queue.error);
  }, [status?.playback_error, status?.queue?.error, announce]);

  const refresh = useCallback(async () => {
    if (busyRef.current || refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await api('/api/status');
      setStatus(next);
      acceptLibrary(next.library);
      setConnectionError(false);
      if (!volumeDragging.current) setVolume(next.volume ?? 100);
    } catch (error) {
      setConnectionError(true);
      announce(error.message);
    } finally { refreshing.current = false; }
  }, [api, acceptLibrary, announce]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => { clearInterval(interval); searchController.current?.abort(); };
  }, [refresh]);

  const refreshSheets = useCallback(async () => {
    try {
      const data = await api('/api/sheets');
      setSheets(data);
      setSheetError('');
      acceptLibrary((await api('/api/status')).library);
    } catch (error) { setSheetError(error.message); }
  }, [api, acceptLibrary]);
  useEffect(() => {
    if (view !== 'sheets') return;
    let fetching = false;
    const poll = async () => {
      if (document.hidden || fetching) return;
      fetching = true;
      try { await refreshSheets(); } finally { fetching = false; }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [view, refreshSheets]);

  const navigate = useCallback(next => {
    setView(next);
    setFilter('');
    const url = new URL(location.href);
    url.searchParams.set('view', next);
    history.replaceState(null, '', url.pathname + url.search);
  }, []);
  useEffect(() => {
    if (status && !['player', 'all', 'favorites', 'discover', 'sheets'].includes(view) && !library.libraries.some(item => item.id === view)) navigate('player');
  }, [status, view, library.libraries, navigate]);

  const devices = status?.devices || [];
  const wanted = preferred || status?.connection?.preferred_name || status?.device_name || '';
  const normalizedDevice = value => String(value || '').replace(/ bluetooth| midi/gi, '').trim().toLowerCase();
  const readyDevices = devices.filter(item => item.connected !== false);
  const matches = wanted ? readyDevices.filter(item => normalizedDevice(item.name) === normalizedDevice(wanted) || normalizedDevice(item.stableName) === normalizedDevice(wanted)) : readyDevices.filter(item => /prodigy|pianodisc/i.test(item.name));
  const device = matches.length === 1 ? matches[0] : null;
  const deviceName = device?.stableName || device?.name || '';
  useEffect(() => {
    const name = deviceName || wanted;
    if (!name) return;
    if (deviceName && preferred !== deviceName) {
      setPreferred(deviceName);
      storage.set('piano-device-name', deviceName);
    }
    if (status?.connection?.preferred_name === name || connectSent.current === name) return;
    connectSent.current = name;
    post('/api/connect', { name }).catch(error => { connectSent.current = ''; announce(error.message); });
  }, [deviceName, wanted, preferred, status?.connection?.preferred_name, post, announce]);

  async function run(task, success = '') {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    announce('');
    try {
      const data = await task();
      acceptLibrary(data?.library);
      if (success) announce(success, true);
      return data;
    } catch (error) { announce(error.message || String(error)); return null; }
    finally { busyRef.current = false; setBusy(false); await refresh(); }
  }

  runTask.current = run;

  function requireDevice() {
    if (!device || connectionError) throw Error('Connect your piano before playing. Open the connection button at the top.');
    return Number(device.id);
  }
  async function queueAction(action, payload = {}, success = '', showPlayer = false) {
    const result = await run(() => {
      const data = { action, ...payload };
      if (action === 'play') data.device = requireDevice();
      return post('/api/queue', data);
    }, success);
    if (result && showPlayer) navigate('player');
    return result;
  }
  const control = action => run(() => post('/api/control', { action, device: Number(device?.id || 0) }));
  const queue = status?.queue || { song_ids: [], index: -1 };
  const queueIds = queue.song_ids || [];
  const queueIndex = Number.isInteger(queue.index) ? queue.index : -1;
  const playing = !!status?.playing;
  const current = library.songs.find(song => song.id === status?.song_id);
  const artworkUrl = status?.name && typeof status?.artwork?.url === 'string' ? status.artwork.url : '';
  const spotifyArtist = current?.artist || status?.artwork?.artist;
  const spotifyTitle = current?.album || status?.artwork?.album || status?.artwork?.title || (current?.artist || current?.album ? songTitle(current.name) : '');
  const spotifyLink = spotifyTitle ? `https://open.spotify.com/search/${encodeURIComponent([spotifyArtist, spotifyTitle].filter(Boolean).join(' '))}` : null;
  const canLoadArtwork = !!artworkUrl && failedArtwork !== artworkUrl;
  const showArtwork = canLoadArtwork && loadedArtwork === artworkUrl;
  useEffect(() => { setFailedArtwork(''); }, [artworkUrl]);
  const playable = !!device && !connectionError;
  useEffect(() => { setSeekPreview(null); }, [status?.song_id]);
  const preparedDuration = status?.adaptation?.report?.duration_seconds;
  const duration = status?.duration_seconds > 0 ? status.duration_seconds : typeof preparedDuration === 'number' && Number.isFinite(preparedDuration)
    ? Math.max(0, preparedDuration)
    : current?.duration_seconds || status?.duration_seconds || 0;
  const elapsed = seekPreview && seekPreview.songId === status?.song_id ? seekPreview.seconds : status?.seconds || 0;
  async function seekTo(value) {
    const selected = seekPreview;
    if (!selected) return;
    setSeekPreview(null);
    await run(() => post('/api/control', { action: 'seek', seconds: Number(value), song_id: selected.songId }));
  }
  const selectedLibrary = library.libraries.find(item => item.id === view);
  const savedOrder = selectedLibrary?.song_ids || library.songs.map(song => song.id);
  const savedSongs = library.songs.filter(song => (view === 'all' && song.source_kind !== 'sheet' || view === 'sheets' && song.source_kind === 'sheet' || view === 'favorites' && song.favorite || (song.library_ids || []).includes(view)) && [song.name, song.artist, song.album].filter(Boolean).join(' ').toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => savedOrder.indexOf(a.id) - savedOrder.indexOf(b.id));
  const sheetGroups = groupSheetSongs(sheets.items, sheets.song_sources || sheets.items.filter(item => item.song_id).map(item => ({ song_id: item.song_id, source_id: item.book_id || item.id })), savedSongs);
  const listedSongs = view === 'sheets' ? sheetGroups.looseSongs : savedSongs;
  const bookIds = new Set(sheetGroups.books.map(group => group.book.id));
  orderState.current = { queueIds, visibleIds: savedSongs.map(song => song.id), fullIds: savedOrder, libraryId: selectedLibrary?.id || '', view, groups: Object.fromEntries([...sheetGroups.books.map(group => [group.book.id, group.songs.map(song => song.id)]), ['loose', sheetGroups.looseSongs.map(song => song.id)]]) };

  const queueEntryIds = queueIds.map((id, index) => `${id}-${queueIds.slice(0, index).filter(queuedId => queuedId === id).length}`);
  function startReorder(kind, from, groupId) {
    dragRef.current = { ...orderState.current, kind, from, groupId, visibleIds: groupId ? orderState.current.groups[groupId] : orderState.current.visibleIds };
  }
  function finishReorder(to) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) return commitReorder({ ...drag, to });
  }
  function cancelReorder() { dragRef.current = null; }

  async function commitReorder(drag) {
    const now = orderState.current;
    if (busyRef.current || !drag || drag.from === drag.to) return;
    const originalIds = drag.kind === 'queue' ? drag.queueIds : drag.visibleIds;
    const currentIds = drag.kind === 'queue' ? now.queueIds : drag.groupId ? now.groups[drag.groupId] : now.visibleIds;
    if (now.view !== drag.view || JSON.stringify(originalIds) !== JSON.stringify(currentIds)) {
      announce('The song list changed. Try moving the song again.');
      return;
    }
    if (drag.kind === 'queue') {
      await runTask.current(() => post('/api/queue', { action: 'move', from: drag.from, to: drag.to, expected_song_ids: originalIds }));
    } else {
      const fullOrder = reorderedSongIds(now.fullIds, originalIds, drag.from, drag.to);
      await runTask.current(() => post('/api/library', { action: 'reorder', library_id: now.libraryId, song_ids: fullOrder }));
    }
  }

  const assignedSong = library.songs.find(song => song.id === dialog?.songId);

  async function upload(event) {
    const input = event.target;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const result = await run(async () => {
      const failures = [];
      const warnings = [];
      let saved = 0;
      for (const file of files) {
        try {
          if (!/\.midi?$/i.test(file.name)) throw Error('Choose a .mid or .midi file.');
          if (file.size > 8388608) throw Error('File is larger than 8 MB.');
          const data = await api('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
            body: file,
          });
          acceptLibrary(data.library);
          saved += 1;
          if (data.warning) warnings.push(`${file.name}: ${data.warning}`);
        } catch (error) {
          failures.push(`${file.name}: ${error.message || 'Could not save this file.'}`);
        }
      }
      return { ok: true, saved, failures, warnings };
    });
    if (result) {
      let summary = `Saved ${result.saved} ${result.saved === 1 ? 'song' : 'songs'}.`;
      if (result.failures.length) summary += ` Could not save: ${result.failures.join('; ')}`;
      if (result.warnings.length) summary += ` ${result.warnings.join('; ')}`;
      announce(summary, !result.failures.length && !result.warnings.length);
    }
    input.value = '';
  }

  async function uploadSheets(event) {
    const input = event.target;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const result = await run(async () => {
      const failures = [];
      let saved = 0, reused = 0;
      for (const file of files) {
        try {
          if (!/\.(pdf|png|jpe?g|xml|musicxml|mxl)$/i.test(file.name)) throw Error('Choose a PDF, PNG, JPEG, or MusicXML score.');
          if (file.size > 20 * 1024 * 1024) throw Error('File is larger than 20 MB.');
          const upload = await api('/api/sheets/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
          if (upload.item?.reused) reused += 1; else saved += 1;
        } catch (error) { failures.push(`${file.name}: ${error.message}`); }
      }
      await refreshSheets();
      return { saved, reused, failures };
    });
    if (result) announce(`Uploaded ${result.saved} ${result.saved === 1 ? 'file' : 'files'}.${result.reused ? ` ${result.reused} already saved; reused existing files.` : ''}${result.failures.length ? ` ${result.failures.join('; ')}` : ' Browse your PDF to review suggested songs; images and MusicXML convert as one song.'}`, !result.failures.length);
    input.value = '';
  }

  function openSheetSplit(item) {
    setSheetPieces([{ name: songTitle(item.name).replace(/\.(pdf|png|jpe?g)$/i, ''), pages: (Array.isArray(item.pages) ? item.pages.join(',') : item.pages) || (item.page_count > 1 ? '' : '1') }]);
    setSplitError('');
    setDialog({ type: 'sheet_split', item: item.book_id ? sheets.items.find(parent => parent.id === item.book_id) || item : item });
  }

  async function convertSheet(event) {
    event.preventDefault();
    setSplitError('');
    const pieces = sheetPieces.map(piece => ({ name: piece.name.trim(), pages: piece.pages.trim() }));
    if (pieces.some(piece => !piece.name || !/^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/.test(piece.pages))) {
      setSplitError('Give every song a name and pages, for example 1-3 or 1,3-5.');
      return;
    }
    const result = await run(() => post('/api/sheets/convert', { id: dialog.item.id, pieces }));
    if (result) { setDialog(null); await refreshSheets(); announce('Conversion started. Your songs will appear here when ready.', true); }
  }

  async function downloadSheet(item) {
    try {
      const response = await fetch(`/api/sheets/source?id=${encodeURIComponent(item.id)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
      if (!response.ok) throw Error('Could not download the original sheet music.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = item.filename || item.file_name || item.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { announce(error.message); }
  }

  async function downloadRecognizedScore(song) {
    try {
      const response = await fetch(`/api/sheets/score?song_id=${encodeURIComponent(song.id)}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) { const data = await response.json(); throw Error(data.error || 'Could not download this score.'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${songTitle(song.name)}.musicxml`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { announce(error.message); }
  }

  async function download(song) {
    try {
      const response = await fetch(`/api/song-file?song_id=${encodeURIComponent(song.id)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
      if (!response.ok) {
        const data = await response.json();
        throw Error(data.error || 'Could not download MIDI.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = song.file_name || `${songTitle(song.name)}.mid`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { announce(error.message); }
  }

  async function search(more = false) {
    const text = more ? searchData.query : query.trim();
    const source = more ? searchData.source : searchSource;
    if (!text) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const generation = ++searchGeneration.current;
    setSearching(true);
    announce('');
    try {
      const page = more ? searchData.page + 1 : 1;
      const data = await api(`/api/search?q=${encodeURIComponent(text)}&page=${page}&source=${encodeURIComponent(source)}`, { signal: controller.signal });
      if (generation !== searchGeneration.current) return;
      setSearchData(previous => ({ results: more ? previous.results.concat(data.results || []) : data.results || [], page, query: text, hasMore: !!data.has_more, checked: data.checked || 0, totalMatches: data.total_matches, searched: true, source, warnings: Array.isArray(data.warnings) ? data.warnings : [] }));
    } catch (error) {
      if (error.name !== 'AbortError' && generation === searchGeneration.current) announce(error.message);
    } finally { if (generation === searchGeneration.current) setSearching(false); }
  }

  function chooseSearchSource(source) {
    searchController.current?.abort();
    searchGeneration.current += 1;
    setSearching(false);
    setSearchSource(source);
    storage.set('piano-search-source', source);
    setSearchData({ results: [], page: 0, query: '', hasMore: false, checked: 0, searched: false, source, warnings: [] });
  }

  async function saveResult(result, libraryId) {
    const destination = library.libraries.find(item => item.id === libraryId);
    return run(async () => {
      const imported = await post('/api/import', { url: result.url });
      acceptLibrary(imported.library);
      if (libraryId) {
        const assigned = await post('/api/library', { action: 'assign', song_id: imported.song.id, library_id: libraryId, value: true });
        imported.library = assigned.library;
      }
      return imported;
    }, destination ? `Saved to ${destination.name}.` : 'Saved to All songs.');
  }

  async function openAdaptation(requestedSongId) {
    const songId = typeof requestedSongId === 'string' ? requestedSongId : status?.song_id || '';
    setAdaptationExpectedSongId(status?.song_id || '');
    const request = ++adaptationRequest.current;
    setAdaptationSongId(songId);
    setAdaptationData(null);
    setAdaptationLoading(true);
    setAdaptationError('');
    setAdaptationAttempted(false);
    setAdaptationMode(status?.adaptation?.settings?.mode || 'original');
    setAdaptationParts([]);
    setDialog({ type: 'adaptation' });
    try {
      const data = await api(`/api/adaptation?song_id=${encodeURIComponent(songId)}`);
      if (request !== adaptationRequest.current) return;
      setAdaptationData(data);
      if (typeof data.expected_song_id === 'string') setAdaptationExpectedSongId(data.expected_song_id);
      setAdaptationMode(data.settings?.mode || 'original');
      const eligible = (data.analysis?.parts || []).filter(part => !part.is_drum).map(part => part.id);
      const chosen = Array.isArray(data.settings?.parts) && data.settings.parts.length ? data.settings.parts : data.analysis?.recommended_parts || [];
      setAdaptationParts(chosen.filter(id => eligible.includes(id)));
    } catch (error) {
      if (request === adaptationRequest.current) setAdaptationError(error.message);
    } finally {
      if (request === adaptationRequest.current) setAdaptationLoading(false);
    }
  }

  async function applyAdaptation() {
    if (adaptationMode === 'custom' && !adaptationParts.length) {
      setAdaptationError('Choose at least one part to play.');
      return;
    }
    setAdaptationError('');
    setAdaptationAttempted(true);
    const result = await run(() => post('/api/adaptation', {
      song_id: adaptationSongId,
      expected_song_id: adaptationExpectedSongId,
      mode: adaptationMode,
      parts: adaptationMode === 'custom' ? adaptationParts : [],
    }), 'Playback sound saved. Press Play when ready.');
    if (result) {
      setDialog(null);
      navigate('player');
    }
  }

  async function saveVolume(value) {
    try {
      await post('/api/control', { action: 'volume', value, device: Number(device?.id || 0) });
      announce('');
    } catch (error) { announce(error.message); }
    finally { volumeDragging.current = false; refresh(); }
  }

  const soundSettings = status?.adaptation?.settings || { mode: 'original' };
  const soundReport = status?.adaptation?.report;
  const soundLabels = { original: 'Original MIDI', piano: 'Piano parts only', smart: 'Smart piano', custom: 'Choose parts' };
  const adaptationSong = library.songs.find(song => song.id === adaptationSongId);
  const analysedParts = adaptationData?.analysis?.parts || [];
  const hasPianoParts = !!adaptationData?.analysis?.has_piano;

  function renderSheetFile(item, book = false) {
    return <article className="sheet-file" key={item.id}>
          <div className="sheet-file-info"><Icon name="book" /><div>{book && <span className="sheet-book-kicker">Sheet music book</span>}<strong>{item.name}</strong><p className="section-note">{item.page_count ? `${item.page_count} ${item.page_count === 1 ? 'page' : 'pages'} · ` : ''}{({ needs_pages: 'Choose pages for your songs', queued: 'Waiting to convert', converting: 'Reading the notes…', ready: 'Converted', error: 'Conversion needs attention' })[item.status] || item.status}{item.pages ? ` · Pages ${Array.isArray(item.pages) ? item.pages.join(', ') : item.pages}` : ''}</p>{['queued', 'analyzing'].includes(item.analysis_status) && <p className="section-note" role="status">Finding songs… {analysisProgressText(item.analysis_progress, item.page_count)}</p>}{item.error && <p className="sheet-file-error">{item.error}</p>}{item.warning && <p className="sheet-file-warning">{item.warning}</p>}</div></div>
          <div className="sheet-file-actions"><button className="btn light small" disabled={busy} onClick={() => downloadSheet(item)}><Icon name="download" />Original</button>{item.extension === '.pdf' && !item.book_id && <><button className="btn small" disabled={busy} onClick={() => { announce(''); setDialog({ type: 'sheet_book', item }); }}>Browse songs</button><button className="btn light small" disabled={busy} onClick={() => { announce(''); openSheetSplit(item); }}>Split into songs</button></>}{item.status === 'error' && <button className="btn small" disabled={busy} onClick={async () => { const result = await run(() => post('/api/sheets/retry', { id: item.id })); if (result) await refreshSheets(); }}>Try again</button>}<button className="btn light small" disabled={busy || item.can_delete === false} aria-label={`Delete sheet file: ${item.name}`} title={item.can_delete === false ? 'Wait for processing to finish' : 'Delete uploaded file'} onClick={() => setDialog({ type: 'delete_sheet', item })}><Icon name="trash" />Delete</button>{['queued', 'converting'].includes(item.status) && <span className="spinner" aria-label="Converting" />}</div>
        </article>;
  }

  function renderSavedSongs(songs, groupId) {
    return <SortableList items={songs.map(song => song.id)} getLabel={id => songTitle(library.songs.find(song => song.id === id)?.name)} onStart={from => startReorder('songs', from, groupId)} onEnd={finishReorder} onCancel={cancelReorder}>
        <div className="song-list">{!songs.length ? <EmptyState icon={filter ? 'search' : view === 'favorites' ? 'heart' : 'note'} title={filter ? 'No matching pieces' : view === 'favorites' ? 'Keep your favorites close' : 'Make room for a little music.'} description={filter ? 'Try another title.' : view === 'favorites' ? 'Tap the heart beside a saved song to keep it here.' : view === 'sheets' ? 'Upload sheet music above. Converted pieces will appear here.' : 'Upload a MIDI file, or find a new piece in Discover.'} button={filter || view === 'favorites' || view === 'sheets' ? null : 'Discover music'} onClick={() => navigate('discover')} /> : <><div className="list-labels"><span /><span>Piece</span><span className="type-label">Instrument</span><span>Time</span><span style={{ textAlign: 'right' }}>Make it yours</span></div>{songs.map((song, index) => {
          const piano = song.piano_only === true;
          return <SortableItem key={song.id} id={song.id} disabled={busy || songs.length < 2}>{({ rowProps, handleProps }) => <div {...rowProps} className={`song-row ${status?.song_id === song.id ? 'is-current' : ''}`}><div className="mini-art"><button className="sort-handle" disabled={busy || songs.length < 2} aria-label={`Reorder song: ${song.name}`} title="Drag to reorder, or press Space then arrow keys" {...handleProps}><Icon name="grip" /></button></div><div className="song-info"><button className="song-name song-name-button" title={`Choose playback sound for ${song.name}`} aria-label={`Choose playback sound for ${song.name}`} disabled={busy} onClick={() => openAdaptation(song.id)}>{songTitle(song.name)}</button>{(song.artist || song.album) && <div className="song-record">{[song.artist, song.album].filter(Boolean).join(' · ')}</div>}<div className="song-sub">{piano ? 'Piano only' : 'Other MIDI'} · {song.source_url ? `From ${providerName(song.source_url)}` : song.source_kind === 'sheet' ? 'From sheet music' : 'Uploaded'} · Saved locally</div>{groupId && (sheets.song_sources || []).filter(source => source.song_id === song.id && source.source_id === groupId).slice(0, 1).map(source => <div key={source.song_id}>{source.pages?.length > 0 && <p className="sheet-song-pages">PDF {source.pages.length === 1 ? 'page' : 'pages'} {source.pages.join(', ')}</p>}{source.warning && <p className="sheet-file-warning">{source.warning}</p>}</div>)}</div><span className={`piano-badge ${piano ? '' : 'candidate'}`}>{piano ? 'Piano only' : 'Other MIDI'}</span><span className="duration">{time(song.duration_seconds)}</span><div className="row-actions"><IconButton icon="heart" active={song.favorite} disabled={busy} label={`${song.favorite ? 'Remove from' : 'Add to'} favorites: ${song.name}`} onClick={() => run(() => post('/api/library', { action: 'favorite', song_id: song.id, value: !song.favorite }))} /><IconButton icon="folder" label={`Choose libraries for ${song.name}`} onClick={() => setDialog({ type: 'assign', songId: song.id })} /><IconButton icon="download" label={`Download MIDI: ${song.name}`} onClick={() => download(song)} />{song.source_kind === 'sheet' && <IconButton icon="book" label={`Download editable score: ${song.name}`} onClick={() => downloadRecognizedScore(song)} />}<IconButton icon="edit" label={`Edit song: ${song.name}`} disabled={busy} onClick={() => { setLibraryName(songTitle(song.name)); setSongArtist(song.artist || ''); setSongAlbum(song.album || ''); setDialog({ type: 'rename_song', songId: song.id }); }} /><IconButton icon="trash" label={`Delete song: ${song.name}`} disabled={busy} onClick={() => setDialog({ type: 'delete', songId: song.id })} /><IconButton icon="plus" label={`Add to queue: ${song.name}`} disabled={busy} onClick={() => queueAction('add', { song_id: song.id }, 'Added to the Player queue.')} /><IconButton icon="play" label={`Play ${song.name}`} disabled={busy} onClick={() => queueAction('play', { song_id: song.id }, '', true)} /></div></div>}</SortableItem>;
        })}</>}</div></SortableList>;
  }

  const viewTitle = view === 'sheets' ? 'Songs from sheet music' : view === 'favorites' ? 'Your favorites' : selectedLibrary?.name || 'All songs';
  const viewNote = view === 'sheets' ? 'Converted on this Mac. Review the notes before playing.' : view === 'favorites' ? 'The pieces you come back to.' : selectedLibrary ? 'A collection made for your room.' : 'Good music, always within reach.';

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Icon name="piano" /></span>Office Piano</div>
      <nav className="nav" aria-label="Music">
        {[['player', 'Player', 'play', queueIds.length], ['all', 'All songs', 'grid', library.songs.filter(song => song.source_kind !== 'sheet').length], ['sheets', 'Sheet music', 'book', library.songs.filter(song => song.source_kind === 'sheet').length], ['favorites', 'Favorites', 'heart', library.songs.filter(song => song.favorite).length], ['discover', 'Discover', 'search']].map(([id, label, icon, count]) => <button key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} />{label}{count !== undefined && <span className="count">{count}</span>}</button>)}
      </nav>
      <div className="collections"><div className="side-heading"><span className="eyebrow">Your libraries</span><button className="icon-button" aria-label="Create library" title="Create library" onClick={() => { setLibraryName(''); setDialog({ type: 'create' }); }}><Icon name="plus" /></button></div>
        <nav className="nav library-nav" aria-label="Libraries">{library.libraries.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name="folder" /><span className="name">{item.name}</span><span className="count">{library.songs.filter(song => (song.library_ids || []).includes(item.id)).length}</span></button>)}</nav>
      </div>
      <div className="side-note"><Icon name="piano" /> A little music for the room.<br />PianoDisc · Prodigy II</div>
    </aside>
    <main className="main">
      <header className="topbar"><span className="breadcrumb">YOUR ROOM, SET TO MUSIC</span><div className="topbar-status"><span className={`online-count ${connectionError ? 'offline' : ''}`} title="Browsers connected to this piano app. Closed browsers disappear within 90 seconds."><span className="online-dot" />{connectionError ? 'Offline' : status ? `${status.online_count ?? 1} online` : 'Connecting…'}</span><button className={`connection ${playable ? 'connected' : ''}`} title="Piano connection settings" onClick={() => { setDialog({ type: 'connection' }); refresh(); }}><span className="dot" /><span className="label">{connectionError ? 'Piano computer unavailable' : device?.name || (wanted ? 'Waiting for your piano' : status ? 'Connect your piano' : 'Connecting to your Mac…')}</span><Icon name="arrow" /></button></div></header>
      <div className="intro"><div><span className="eyebrow">{view === 'player' ? 'Your room, set to music' : view === 'discover' ? 'Find your next favorite' : 'Make yourself at home'}</span><h1>{view === 'player' ? 'Player' : view === 'discover' ? 'Discover' : view === 'sheets' ? 'Sheet music' : 'Your music'}</h1><p className="subtitle">{view === 'player' ? 'Choose a song or build a queue.' : view === 'discover' ? 'Search MIDI sites and save songs to your library.' : view === 'sheets' ? 'Turn printed notes into songs for your piano.' : 'Saved songs, favorites, and your libraries.'}</p></div>{view === 'all' && <button className="btn light" onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="upload" />Upload MIDI</button>}{view === 'sheets' && <button className="btn light" onClick={() => sheetInput.current?.click()} disabled={busy}><Icon name="upload" />Upload sheet music</button>}<input ref={sheetInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.musicxml,.mxl" multiple onChange={uploadSheets} hidden /><input ref={fileInput} type="file" accept=".mid,.midi" multiple onChange={upload} hidden /></div>
      {notice && <div className={`message visible ${notice.success ? 'success' : ''}`} role={notice.success ? 'status' : 'alert'} aria-live="polite">{notice.text}{notice.undoSheetId && <button className="btn light small" style={{ marginLeft: 12 }} onClick={async () => { const result = await run(() => post('/api/sheets/restore', { id: notice.undoSheetId }), 'File restored.'); if (result) await refreshSheets(); }}>Undo</button>}{notice.undoSongId && <button className="btn light small" style={{ marginLeft: 12 }} onClick={() => run(() => post('/api/library', { action: 'restore', song_id: notice.undoSongId }), 'Song restored.')}>Undo</button>}</div>}

      {view === 'player' && <section aria-label="Player">
        <section className="player" aria-label="Piano player"><div className={`art ${showArtwork ? 'has-cover' : ''}`} aria-hidden={showArtwork || spotifyLink ? undefined : true}>{canLoadArtwork && <img className={`album-cover ${showArtwork ? 'is-ready' : ''}`} src={artworkUrl} alt="" onLoad={() => setLoadedArtwork(artworkUrl)} onError={() => setFailedArtwork(artworkUrl)} />}{!showArtwork && <div className="keys">{[true, true, false, true, true, true, false].map((black, index) => <i className={black ? 'black' : ''} key={index} />)}</div>}{spotifyLink && <a className="spotify-cover-link" href={spotifyLink} target="_blank" rel="noopener noreferrer" aria-label="Find this album on Spotify" title="Find this album on Spotify"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760"/><path d="M5 8c5-1.7 10-1.2 14 1M6 12c4-1.3 8-1 12 1M7 16c3-.8 6-.5 9 1" fill="none" stroke="#121d16" strokeWidth="1.7" strokeLinecap="round"/></svg>Spotify ↗</span></a>}</div><div className="player-content"><div className="eyebrow"><span className="playing-pulse" /><span>{playing ? 'Now playing' : status?.paused ? 'Paused' : 'Ready when you are'}</span></div><h2 className="song-title">{status?.name ? songTitle(status.name) : 'Waiting for a song'}</h2>{(current?.artist || current?.album) && <p className="player-record">{[current.artist, current.album].filter(Boolean).join(' · ')}</p>}<p className="song-meta">{status?.name ? `${current?.piano_only === true ? 'Piano only' : 'Other MIDI'} · ${current?.source_url ? `From your ${providerName(current.source_url)} collection` : current?.source_kind === 'sheet' ? 'From your sheet music' : 'From your saved music'}` : 'Choose a piece from your music to get started.'}</p><div className="progress-row"><span>{time(elapsed)}</span><input className="song-timeline" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(duration || 1, elapsed)} aria-label="Song timeline" aria-valuetext={`${time(elapsed)} of ${time(duration)}`} disabled={busy || !status?.song_id || !duration} onChange={event => setSeekPreview({ songId: status.song_id, seconds: Number(event.target.value) })} onPointerUp={event => seekTo(event.currentTarget.value)} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) seekTo(event.currentTarget.value); }} onBlur={event => seekTo(event.currentTarget.value)} /><span>{time(duration)}</span></div>
          <div className="player-bottom"><div className="controls"><button className="icon-button" aria-label="Previous song" title="Previous song" disabled={busy || queueIndex <= 0} onClick={() => queueAction('previous')}><Icon name="arrow" style={{ transform: 'rotate(180deg)' }} /></button><button className="play-button" aria-label={status?.paused ? 'Resume' : 'Play'} title={status?.paused ? 'Resume' : 'Play'} disabled={busy || !playable || playing || (!status?.name && !queueIds.length)} onClick={() => queueAction('play', status?.song_id && queueIds[queueIndex] !== status.song_id ? { song_id: status.song_id } : {})}><Icon name="play" /></button><button className="icon-button" aria-label="Pause" title="Pause" disabled={busy || !playing} onClick={() => control('pause')}><Icon name="pause" /></button><button className="icon-button" aria-label="Next song" title="Next song" disabled={busy || !queueIds.length || queueIndex >= queueIds.length - 1} onClick={() => queueAction('next')}><Icon name="arrow" /></button><button className="icon-button" aria-label="Stop and release keys" title="Stop & release keys" onClick={() => control('stop')} disabled={busy}><Icon name="stop" /></button></div>
            <div className="volume-wrap"><label htmlFor="volume" aria-label="Piano volume"><Icon name="volume" /></label><input id="volume" type="range" min="0" max="100" value={volume} aria-label="Piano volume" onChange={event => { volumeDragging.current = true; setVolume(Number(event.target.value)); }} onPointerUp={event => saveVolume(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) saveVolume(Number(event.currentTarget.value)); }} onBlur={event => { if (volumeDragging.current) saveVolume(Number(event.currentTarget.value)); }} /><output htmlFor="volume">{volume}%</output></div>
          </div></div></section>
        <button className="adaptation-card" onClick={openAdaptation} disabled={busy} aria-label="Change playback sound">
          <span className="adaptation-card-icon"><Icon name="piano" /></span>
          <span className="adaptation-card-content">
            <span className="adaptation-card-title">Playback sound {soundSettings.mode === 'smart' && <span className="experimental-badge">Experimental</span>}</span>
            <span className="adaptation-card-label">{soundReport?.label || soundLabels[soundSettings.mode] || 'Original MIDI'}</span>
            {soundReport?.notice && <span className="adaptation-card-note">{soundReport.notice}</span>}
          </span>
          <Icon name="arrow" />
        </button>
        <div className="content-heading queue-header"><div><h2>Your queue</h2><p className="section-note">{queueIds.length ? `${queueIds.length} ${queueIds.length === 1 ? 'piece' : 'pieces'} · Plays in order. Reorder to set the mood.` : 'Add songs from your music or queue a whole library.'}</p></div><div className="queue-tools"><button className="btn small" disabled={busy || !queueIds.length || !playable || playing} onClick={() => queueAction('play')}><Icon name="play" />Play queue</button><button className="btn light small" disabled={busy || !queueIds.length} onClick={() => queueAction('clear')}>Clear queue</button></div></div>
        <SortableList items={queueEntryIds} getLabel={entry => songTitle(library.songs.find(song => song.id === queueIds[queueEntryIds.indexOf(entry)])?.name)} onStart={from => startReorder('queue', from)} onEnd={finishReorder} onCancel={cancelReorder}>
        <div className="song-list" role="list" aria-label="Song queue">{!queueIds.length ? <EmptyState title="Your next song starts here." description="Add a few favorites or queue an entire library. Nothing starts until you press play." button="Browse your music" onClick={() => navigate('all')} /> : queueIds.map((id, index) => {
          const song = library.songs.find(item => item.id === id);
          const entryKey = `${id}-${queueIds.slice(0, index).filter(queuedId => queuedId === id).length}`;
          if (!song) return null;
          return <SortableItem key={entryKey} id={entryKey} disabled={busy || queueIds.length < 2}>{({ rowProps, handleProps }) => <div {...rowProps} className={`queue-row ${index === queueIndex ? 'is-current' : ''}`} role="listitem"><span className="queue-number"><button className="sort-handle" disabled={busy || queueIds.length < 2} aria-label={`Reorder queued song: ${song.name}`} title="Drag to reorder, or press Space then arrow keys" {...handleProps}><Icon name="grip" /></button>{String(index + 1).padStart(2, '0')}</span><div className="song-info"><div className="song-name" title={song.name}>{songTitle(song.name)}</div><div className="queue-status">{index === queueIndex ? playing ? 'Now playing' : 'Selected' : queueIndex >= 0 && index < queueIndex ? 'Earlier in queue' : 'Up next'} · {song.piano_only === true ? 'Piano only' : 'Other MIDI'}</div></div><span className="duration">{time(song.duration_seconds)}</span><div className="row-actions"><IconButton icon="arrow" style={{ transform: 'rotate(-90deg)' }} label={`Move up: ${song.name}`} disabled={busy || index === 0} onClick={() => queueAction('move', { from: index, to: index - 1 })} /><IconButton icon="arrow" style={{ transform: 'rotate(90deg)' }} label={`Move down: ${song.name}`} disabled={busy || index === queueIds.length - 1} onClick={() => queueAction('move', { from: index, to: index + 1 })} /><IconButton icon="play" label={`Play queued song: ${song.name}`} disabled={busy || !playable} onClick={() => queueAction('play', { index })} /><IconButton icon="close" label={`Remove from queue: ${song.name}`} disabled={busy} onClick={() => queueAction('remove', { index })} /></div></div>}</SortableItem>;
        })}</div></SortableList>
      </section>}

      {view === 'sheets' && <section className="sheet-import" aria-label="Sheet music files">
        <div className="sheet-explainer"><span className="mini-art"><Icon name="book" /></span><div><h2>A page, a piece, or a whole book</h2><p>Upload a PDF, a clear photo, or a MusicXML score. Browse a book to find suggested songs and preview their pages. Choose what to add, and adjust names or pages when needed.</p><p className="section-note">Recognition can miss notes, rhythm, or repeats. Check the converted song before playing; nothing is added to your queue automatically.</p></div></div>
        {sheets.available === false && <p className="message visible" role="status">Printed-sheet recognition is not available on this Mac yet. MusicXML scores can still convert. Your uploaded originals stay saved here.</p>}
        {sheetError && <p className="message visible" role="alert">{sheetError}</p>}
        <div className="sheet-browse-toolbar"><label className="search"><Icon name="search" /><input type="search" placeholder="Find a song in your books…" aria-label="Filter saved songs" value={filter} onChange={event => setFilter(event.target.value)} /></label><button className="btn light small" disabled={busy || !savedSongs.length} onClick={() => queueAction('replace', { song_ids: savedSongs.map(song => song.id) }, 'Queue ready. Press play when you want music.', true)}>Queue these songs</button></div>
        <div className="sheet-books">{sheetGroups.books.map(({ book, songs }) => <article className="sheet-book" key={book.id} aria-label={`Book: ${book.name}`}>
          <div className="sheet-book-heading"><div className="sheet-book-cover" aria-hidden="true"><Icon name="book" /><span>SHEET<br />MUSIC</span></div>{renderSheetFile(book, true)}</div>
          <section className="sheet-book-songs" aria-label={`Songs from ${book.name}`}><div className="sheet-book-song-heading"><h3>From this book</h3><span>{songs.length} {songs.length === 1 ? 'saved song' : 'saved songs'}</span></div>
            {!!songs.length && renderSavedSongs(songs, book.id)}
            {!songs.length && <p className="sheet-book-empty">{filter ? 'No songs match your search in this book.' : 'Browse songs above, then choose the pieces you want to add.'}</p>}
            {sheets.items.filter(item => item.book_id === book.id && (!item.song_id || !library.songs.some(song => song.id === item.song_id))).map(item => renderSheetFile(item))}
          </section>
        </article>)}</div>
        <div className="sheet-files">{sheets.items.filter(item => !bookIds.has(item.id) && !bookIds.has(item.book_id) && (item.warning || !item.book_id || !item.song_id || !library.songs.some(song => song.id === item.song_id))).map(item => renderSheetFile(item))}</div>
      </section>}

      {view !== 'player' && view !== 'discover' && (view !== 'sheets' || listedSongs.length > 0 || !sheets.items.length) && <section aria-label="Saved music">
        <div className="content-heading"><div><h2>{view === 'sheets' && sheetGroups.books.length ? 'Other sheet songs' : viewTitle}</h2><p className="section-note">{viewNote}</p></div><div className="saved-heading-tools">{view !== 'sheets' && <>{selectedLibrary && <button className="btn light small" onClick={() => { setLibraryName(selectedLibrary.name); setDialog({ type: 'rename', libraryId: selectedLibrary.id }); }}>Rename library</button>}<label className="search"><Icon name="search" /><input type="search" placeholder="Find a saved song…" aria-label="Filter saved songs" value={filter} onChange={event => setFilter(event.target.value)} /></label><button className="btn light small" disabled={busy || !savedSongs.length} title={`Queue ${savedSongs.length} songs`} onClick={() => queueAction('replace', { song_ids: savedSongs.map(song => song.id) }, 'Queue ready. Press play when you want music.', true)}>{selectedLibrary ? 'Queue library' : 'Queue these songs'}</button></>}</div></div>
        {renderSavedSongs(listedSongs, view === 'sheets' ? 'loose' : undefined)}
      </section>}

      {view === 'discover' && <section aria-label="Discover music"><div className="discover-toolbar"><label className="source-chooser"><span>Source</span><select value={searchSource} onChange={event => chooseSearchSource(event.target.value)}><option value="all">All sites</option><option value="both">BitMidi + FreeMidi</option><option value="bitmidi">BitMidi</option><option value="freemidi">FreeMidi</option><option value="bushgrafts">Bushgrafts · Jazz</option><option value="kunstderfuge">Kunst der Fuge · Classical</option></select></label><form className="search" onSubmit={event => { event.preventDefault(); search(); }}><Icon name="search" /><input type="search" placeholder="Search a song, composer, or artist…" aria-label="Search MIDI sites" required maxLength="120" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn" type="submit">{searching ? <><span className="spinner" />Checking</> : 'Search'}</button></form></div><p className="discovery-note" aria-live="polite">{sourceDescriptions[searchSource]}</p><p className="discovery-note">Search shows all matches. <strong>Piano-only</strong> files are marked; other MIDI can also play on the piano.</p><div className="search-warnings" role="status">{searchData.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><p className="section-note" style={{ margin: '0 0 14px' }} aria-live="polite">{searching ? 'Searching catalogs… This can take a moment.' : searchData.searched ? `${searchData.results.length}${Number.isInteger(searchData.totalMatches) ? ` of ${searchData.totalMatches}` : ''} songs shown · ${searchData.results.filter(result => result.piano_only === true).length} piano-only${searchData.hasMore ? ' · More available below' : ''}` : ''}</p><div className="song-list results">{searchData.results.length ? searchData.results.map((result, index) => <SearchResult key={`${result.url}-${index}`} result={result} libraries={library.libraries} busy={busy} onSave={saveResult} notice={notice} />) : searchData.searched ? <EmptyState title="No songs found in this batch." description="Try the next results, or search another title or composer." /> : <EmptyState icon="search" title="Find a song" description="Try a song title, artist, or composer." />}</div>{searchData.hasMore && <button className="btn light load-more" disabled={searching} onClick={() => search(true)}>Load more songs</button>}</section>}

      <footer className="footer"><span>Songs saved on the piano computer. Download a copy anytime.</span><button onClick={() => { setCopied(false); setDialog({ type: 'remote' }); }}><Icon name="wifi" />Control over Wi-Fi</button></footer>
    </main>
    <nav className="mobile-dock" aria-label="Main navigation">
      {[['player', 'Player', 'play'], ['all', 'All songs', 'grid'], ['sheets', 'Sheet music', 'book'], ['favorites', 'Favorites', 'heart'], ['discover', 'Discover', 'search']].map(([id, label, icon]) =>
        <button key={id} className={view === id ? 'active' : ''} aria-label={label} title={label} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} /></button>
      )}
    </nav>

    {dialog?.type === 'delete_sheet' && <Dialog title="Delete this file?" onClose={() => setDialog(null)}><p className="dialog-hint">{dialog.item.name}</p><p className="dialog-hint">This removes the uploaded file and its conversion entries from this page. Songs already saved in your library stay available. The original is kept locally so you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={async () => { const item = dialog.item; const result = await run(() => post('/api/sheets/delete', { id: item.id })); if (result) { setDialog(null); await refreshSheets(); setNotice({ text: 'File removed.', success: true, undoSheetId: item.id }); } }}>Delete file</button></div></Dialog>}

    {dialog?.type === 'sheet_book' && <SheetBookDialog key={dialog.item.id} item={dialog.item} api={api} fetchPreview={fetchSheetPreview} available={sheets.available} onClose={() => setDialog(null)} onConvert={async (pieces, recognition) => {
      await post('/api/sheets/convert', { id: dialog.item.id, pieces, recognition });
      await refreshSheets();
      setDialog(null);
      announce('Your selected songs are converting. They will appear in Sheet music when ready.', true);
    }} />}

    {dialog?.type === 'sheet_split' && <Dialog title="Split into songs" closeDisabled={busy} onClose={() => setDialog(null)}><form onSubmit={convertSheet}>
      <p className="dialog-hint">{dialog.item.name} · {dialog.item.page_count || 1} pages. Add one row per song, with all its pages together. Page numbers refer to PDF pages, starting at 1.</p>
      <div className="sheet-pieces">{sheetPieces.map((piece, index) => <div className="sheet-piece" key={index}>
        <label><span className="dialog-label">Song {index + 1}</span><input className="field" aria-label={`Song ${index + 1} name`} required maxLength="200" value={piece.name} disabled={busy} onChange={event => setSheetPieces(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} /></label>
        <label><span className="dialog-label">Pages</span><input className="field" aria-label={`Song ${index + 1} pages`} required placeholder="1-3" value={piece.pages} disabled={busy} onChange={event => setSheetPieces(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, pages: event.target.value } : row))} /></label>
        <button type="button" className="icon-button" aria-label={`Remove song ${index + 1}`} disabled={busy || sheetPieces.length === 1} onClick={() => setSheetPieces(previous => previous.filter((_, rowIndex) => rowIndex !== index))}><Icon name="close" /></button>
      </div>)}</div>
      <button type="button" className="btn light small" disabled={busy || sheetPieces.length >= 50} onClick={() => setSheetPieces(previous => [...previous, { name: '', pages: '' }])}><Icon name="plus" />Add another song</button>
      <p className="dialog-hint">Use a range such as 1-3, or separate pages such as 1,3-5. Song boundaries are chosen by you. Originals remain saved locally.</p>
      {(splitError || notice && !notice.success) && <p className="message visible" role="alert">{splitError || notice.text}</p>}
      <div className="dialog-actions"><button type="button" className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy || sheets.available !== true}>{busy ? 'Starting…' : `Convert ${sheetPieces.length === 1 ? 'song' : `${sheetPieces.length} songs`}`}</button></div>
    </form></Dialog>}

    {dialog?.type === 'adaptation' && <Dialog title="Playback sound" closeDisabled={busy} onClose={() => { adaptationRequest.current += 1; setDialog(null); }}>
      {adaptationSong && <p className="adaptation-selected-song">{songTitle(adaptationSong.name)}</p>}
      <p className="dialog-hint">Choose which MIDI parts reach the piano. Saved songs and downloaded files keep their original notes.</p>
      {adaptationLoading ? <p className="dialog-hint" role="status"><span className="spinner" /> Checking song parts…</p> : <>
        <fieldset className="adaptation-modes">
          <legend className="dialog-label">Play this way</legend>
          {[
            ['original', 'Original MIDI', 'All parts, as they are in the file.'],
            ['piano', 'Piano parts only', 'Keep parts marked as piano; leave the other instruments out.'],
            ['smart', 'Smart piano · Experimental', 'Use simple MIDI part rules to choose a smaller set of parts. No AI rewriting.'],
            ['custom', 'Choose parts', 'Pick the parts you want to hear in this song.'],
          ].map(([mode, title, detail]) => {
            const disabled = busy || mode === 'custom' && !adaptationSongId || mode === 'piano' && !!adaptationSongId && !hasPianoParts;
            return <label key={mode} className={`adaptation-mode ${disabled ? 'unavailable' : ''}`}>
              <input type="radio" name="adaptationMode" value={mode} checked={adaptationMode === mode} disabled={disabled} onChange={() => { setAdaptationMode(mode); setAdaptationError(''); }} />
              <span><strong>{title}</strong><small>{detail}</small></span>
            </label>;
          })}
        </fieldset>
        {!adaptationSongId && <p className="dialog-hint">This becomes the playback setting for the next song. Load a song to choose individual parts.</p>}
        {!!adaptationSongId && !hasPianoParts && <p className="dialog-hint">This song has no parts marked as piano. Try Smart piano or choose parts yourself.</p>}
        {adaptationMode === 'smart' && adaptationData?.analysis?.recommended_parts?.length > 0 && <p className="dialog-hint">Suggested parts: {analysedParts.filter(part => adaptationData.analysis.recommended_parts.includes(part.id)).map(part => part.name || part.instrument || `Part ${part.id}`).join(', ')}.</p>}
        {adaptationMode === 'custom' && <div className="adaptation-parts" aria-label="Song parts">
          {analysedParts.map(part => <label key={part.id} className={`adaptation-part ${part.is_drum ? 'unavailable' : ''}`}>
            <input type="checkbox" checked={!part.is_drum && adaptationParts.includes(part.id)} disabled={busy || part.is_drum} onChange={event => { const selected = event.target.checked; setAdaptationParts(previous => selected ? [...new Set([...previous, part.id])] : previous.filter(id => id !== part.id)); setAdaptationError(''); }} />
            <span><strong>{part.name || `Part ${part.id}`}</strong><small>{part.instrument || 'MIDI part'} · {part.notes || 0} notes{part.is_drum ? ' · Percussion excluded' : ''}</small></span>
          </label>)}
        </div>}
      </>}
      {(adaptationError || adaptationAttempted && notice && !notice.success) && <p className="message visible" role="alert">{adaptationError || notice.text}</p>}
      <p className="dialog-hint">All playback choices are saved for this song and restored whenever it plays. With no song selected, you set the default for songs without saved settings.</p><p className="adaptation-stop-note">Applying a change stops playback. Press Play afterward.</p>
      <div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => { adaptationRequest.current += 1; setDialog(null); }}>Cancel</button><button className="btn" disabled={busy || adaptationLoading || !adaptationData || adaptationMode === 'custom' && (!adaptationSongId || !adaptationParts.length) || adaptationMode === 'piano' && !!adaptationSongId && !hasPianoParts} onClick={applyAdaptation}>Apply sound</button></div>
    </Dialog>}

    {dialog?.type === 'connection' && <Dialog title="Your piano" onClose={() => setDialog(null)}><label htmlFor="device" className="dialog-label">MIDI connection</label><select id="device" className="field" value={device ? String(device.id) : ''} onChange={event => {
      const chosen = devices.find(item => String(item.id) === event.target.value);
      if (chosen) { const name = chosen.stableName || chosen.name; setPreferred(name); storage.set('piano-device-name', name); }
    }}><option value="">{devices.length ? 'Choose your piano…' : 'No MIDI piano connected'}</option>{devices.map(item => <option key={item.id} value={String(item.id)}>{item.name}</option>)}</select><div className="dialog-actions"><button className="btn light small" onClick={refresh}>Refresh devices</button><button className="btn small" disabled={busy || !wanted} onClick={() => run(() => post('/api/reconnect', { name: wanted }), 'Reconnecting your piano. Press Play once it is connected.')}>Reconnect piano</button></div><p className="dialog-hint" style={{ marginTop: 18 }}>We remember your piano and reconnect when its MIDI connection returns. Playback starts only when you press play.</p><p className="dialog-hint">If another app used the piano, disconnect it there first, then press Reconnect piano. {status?.platform === 'linux' ? 'On Raspberry Pi, choose your piano from the device list and press Reconnect piano. Keep it disconnected from other apps, or use USB.' : 'On your Mac, open Audio MIDI Setup → MIDI Studio → Bluetooth, then connect to Prodigy2 MIDI. Keep the Mac connected, or use USB.'}</p><p className="dialog-hint">{preferred ? `Remembered piano: ${preferred}. ` : ''}{status?.bluetooth?.message || ''}</p><div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {['create', 'rename'].includes(dialog?.type) && <Dialog title={dialog.type === 'rename' ? 'Rename library' : 'A library of your own'} onClose={() => setDialog(null)}><form onSubmit={async event => {
      event.preventDefault();
      const name = libraryName.trim();
      if (!name) return;
      const result = await run(() => post('/api/library', { action: dialog.type === 'rename' ? 'rename' : 'create', name, library_id: dialog.libraryId }));
      if (result) setDialog(null);
    }}><label htmlFor="libraryName" className="dialog-label">Library name</label><input id="libraryName" className="field" placeholder="Quiet mornings" required maxLength="80" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus /><p className="dialog-hint">Bring your favorite pieces together for any mood.</p><div className="dialog-actions"><button type="button" className="btn light" onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>{dialog.type === 'rename' ? 'Save name' : 'Create library'}</button></div></form></Dialog>}
    {dialog?.type === 'assign' && <Dialog title="Save to a library" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p>{library.libraries.length ? library.libraries.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy} checked={(assignedSong?.library_ids || []).includes(item.id)} onChange={event => run(() => post('/api/library', { action: 'assign', song_id: assignedSong.id, library_id: item.id, value: event.target.checked }))} /><span>{item.name}</span></label>) : <p className="dialog-hint">Create a library with the + button in the sidebar first.</p>}<div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {dialog?.type === 'rename_song' && <Dialog title="Edit song" closeDisabled={busy} onClose={() => setDialog(null)}><form onSubmit={async event => {
      event.preventDefault();
      const result = await run(() => post('/api/library', { action: 'edit_song', song_id: dialog.songId, name: libraryName.trim(), artist: songArtist.trim(), album: songAlbum.trim() }), 'Song updated.');
      if (result) setDialog(null);
    }}><label htmlFor="songName" className="dialog-label">Song name</label><input id="songName" className="field" required maxLength="200" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus /><div className="song-edit-fields"><label htmlFor="songArtist" className="dialog-label">Artist</label><input id="songArtist" className="field" maxLength="200" placeholder="Artist or composer" value={songArtist} disabled={busy} onChange={event => setSongArtist(event.target.value)} /><label htmlFor="songAlbum" className="dialog-label">Album</label><input id="songAlbum" className="field" maxLength="200" placeholder="Album title (optional)" value={songAlbum} disabled={busy} onChange={event => setSongAlbum(event.target.value)} /></div><p className="dialog-hint">Artist and album help find the right cover and Spotify result. Your libraries, queue, favorites, and saved playback settings stay with this song.</p><div className="dialog-actions"><button type="button" className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy || !libraryName.trim()}>Save changes</button></div></form></Dialog>}
    {dialog?.type === 'delete' && <Dialog title="Remove this song?" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p><p className="dialog-hint">This removes the song from All songs, favorites, libraries, and the queue. If it is playing, playback stops. The MIDI is moved to the app’s trash folder, and you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={async () => { const song = assignedSong; const result = await run(() => post('/api/library', { action: 'delete', song_id: song.id })); if (result) { setDialog(null); setNotice({ text: 'Song removed.', success: true, undoSongId: song.id }); } }}>Remove song</button></div></Dialog>}
    {dialog?.type === 'remote' && <Dialog title="Music, from anywhere in the room." onClose={() => setDialog(null)}><p className="dialog-hint">Open this private link on a phone or another computer on the same office Wi-Fi. The piano computer sends the music and must stay awake.</p><a className="dialog-hint" style={{ display: 'block' }} href={status?.remote || '#'}>{status?.remote || 'Waiting for the piano connection…'}</a><div className="dialog-actions"><button className="btn" onClick={async () => {
      try { if (!status?.remote) throw Error(); await navigator.clipboard.writeText(status.remote); setCopied(true); }
      catch { announce('Select and copy the private link in the Wi-Fi dialog.'); }
    }}><Icon name="link" />{copied ? 'Copied ✓' : 'Copy remote link'}</button></div></Dialog>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

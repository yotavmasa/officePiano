import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './styles.css';
import { SortableList, SortableItem } from './SortableList.jsx';
import { groupSheetSongs } from './sheetGroups.mjs';
import SheetBookDialog, { analysisProgressText } from './SheetBookDialog.jsx';
import { useLocalListener } from './useLocalListener.mjs';
import { parseMidi } from './localPiano.mjs';
import { songClock } from './fallingNotes.mjs';
import FallingNotes from './FallingNotes.jsx';

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

const WIDE_QUEUE = '(min-width: 1280px)';
// Animates a layout change with the View Transitions API where available. The change runs exactly
// once even when the browser skips the transition, for example when another one starts first.
function withViewTransition(apply) {
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return apply();
  let applied = false;
  const run = () => { if (!applied) { applied = true; flushSync(apply); } };
  const transition = document.startViewTransition(run);
  transition.ready.catch(run);
  transition.finished.catch(() => {});
}
const SONG_DRAG_TYPE = 'application/x-office-piano-song';
const SEEK_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
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
    next: <><path d="m6 5 10 7-10 7Z" fill="currentColor" /><path d="M18 5v14" /></>,
    previous: <><path d="m18 5-10 7 10 7Z" fill="currentColor" /><path d="M6 5v14" /></>,
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
    queue: <path d="M4 6h12M4 12h12M4 18h8m8-3v6l-4-3Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    link: <path d="m10 14 4-4m-5 1L7 13a4 4 0 0 0 6 6l2-2m0-6 2-2a4 4 0 0 0-6-6l-2 2" />,
    devices: <><rect x="3" y="3" width="11" height="18" rx="2" /><circle cx="8.5" cy="14" r="3" /><path d="M8.5 7h.01M17 7h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3" /></>,
    laptop: <path d="M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1ZM2 19h20" />,
    phone: <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17h2" /></>,
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

function DeviceOptions({ current, others, playing, onChoose, emptyNote }) {
  return <>
    <div className="device-current">
      <span className="device-current-icon"><Icon name={current.icon} /></span>
      <span className="device-text"><span className="device-kicker">Current device</span><strong>{playing && <span className="equalizer" aria-hidden="true"><i /><i /><i /></span>}{current.name}</strong><small>{current.detail}</small></span>
    </div>
    <p className="device-menu-heading">Select another device</p>
    {others.map(item => <button type="button" key={item.id} className="device-option" onClick={() => onChoose(item)}>
      <span className="device-option-icon"><Icon name={item.icon} /></span>
      <span className="device-text"><strong>{item.name}</strong><small>{item.detail}</small></span>
    </button>)}
    {emptyNote && <p className="device-empty">{emptyNote}</p>}
  </>;
}

function DevicePicker({ current, others, playing, onChoose, onSettings, emptyNote, local = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return <div className="device-picker" ref={ref}>
    <button type="button" className={`device-picker-button ${open ? 'is-open' : ''} ${local ? 'is-local' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId} aria-label={`Playing on ${current.name}. Connect to a device`} title="Connect to a device" onClick={() => setOpen(value => !value)}><Icon name="devices" /></button>
    {open && <div className="device-menu" id={menuId} role="dialog" aria-label="Connect to a device">
      <DeviceOptions current={current} others={others} playing={playing} emptyNote={emptyNote} onChoose={item => { setOpen(false); onChoose(item); }} />
      <button type="button" className="device-settings" onClick={() => { setOpen(false); onSettings(); }}>Piano connection settings</button>
    </div>}
  </div>;
}

function ContextMenu({ x, y, label, items, onClose }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    const menu = ref.current;
    const box = menu.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, innerHeight - box.height - 8)) });
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = event => { if (!menu.contains(event.target)) onClose(); };
    const close = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [x, y, onClose]);
  function keyDown(event) {
    const entries = [...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = entries.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); onClose(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); entries[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); entries.at(-1)?.focus(); }
  }
  return <div ref={ref} className="context-menu" role="menu" aria-label={label} style={position} onKeyDown={keyDown} onContextMenu={event => event.preventDefault()}>
    {items.filter(Boolean).map(item => item.separator
      ? <div key={item.key} className="context-menu-separator" role="separator" />
      : <button key={item.label} type="button" role="menuitem" className={item.danger ? 'is-danger' : ''} disabled={item.disabled} onClick={() => { onClose(true); item.onSelect(); }}><Icon name={item.icon} />{item.label}</button>)}
  </div>;
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
  const [selected, setSelected] = useState([]);
  const [logoMissing, setLogoMissing] = useState(false);
  const [queueSelected, setQueueSelected] = useState([]);
  const [songMenu, setSongMenu] = useState(null);
  const menuReturn = useRef(null);
  const [adaptationData, setAdaptationData] = useState(null);
  const [adaptationMode, setAdaptationMode] = useState('no_drums');
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
  const fetchSongFile = useCallback(async songId => {
    const response = await fetch(`/api/song-file?song_id=${encodeURIComponent(songId)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch {}
      throw Error(data?.error || 'Could not load this song.');
    }
    return response.arrayBuffer();
  }, [key, clientId]);
  const [output, setOutput] = useState(() => storage.get('piano-output') === 'device' ? 'device' : 'piano');
  const [localIndex, setLocalIndex] = useState(null);
  const advanceLocal = useRef(null);
  const parsedSongs = useRef(new Map());
  const loadSongNotes = useCallback(songId => {
    const cache = parsedSongs.current;
    if (!cache.has(songId)) {
      cache.set(songId, fetchSongFile(songId).then(parseMidi).catch(error => { cache.delete(songId); throw error; }));
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return cache.get(songId);
  }, [fetchSongFile]);
  const local = useLocalListener(loadSongNotes, () => advanceLocal.current?.());
  const [showNotes, setShowNotes] = useState(() => storage.get('piano-falling-notes') === 'on');
  const pianoClock = useRef({ seconds: 0, playing: false, at: 0 });
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueDocked, setQueueDocked] = useState(() => storage.get('piano-queue-panel') !== 'hidden');
  const [wideQueue, setWideQueue] = useState(() => window.matchMedia(WIDE_QUEUE).matches);
  const [draggingSong, setDraggingSong] = useState('');
  const [queueDrop, setQueueDrop] = useState(null);
  const [libraryDrop, setLibraryDrop] = useState('');
  const songDragBlocked = useRef(false);
  const queueClose = useRef(null);
  const queueTrigger = useRef(null);
  useEffect(() => {
    const media = window.matchMedia(WIDE_QUEUE);
    const change = () => setWideQueue(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => { setQueueOpen(false); }, [view, wideQueue]);
  useEffect(() => { setSelected([]); setSongMenu(null); }, [view]);
  useEffect(() => {
    if (!queueOpen) return;
    queueClose.current?.focus();
    const escape = event => { if (event.key === 'Escape') setQueueOpen(false); };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      const focused = document.activeElement;
      if (!focused || focused === document.body || document.getElementById('queue-panel')?.contains(focused)) queueTrigger.current?.focus();
    };
  }, [queueOpen]);
  async function listenHere(song, index = null, startAt = 0) {
    announce('');
    setLocalIndex(index);
    try { await local.listen(song, startAt); }
    catch (error) { announce(error.message || 'This song could not play on this device.'); }
  }

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

  const viewRef = useRef(view);
  viewRef.current = view;
  const navigate = useCallback(next => {
    const apply = () => { setView(next); setFilter(''); };
    if (next !== viewRef.current) withViewTransition(apply); else apply();
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
  // Piano key presses go out one at a time so a release never overtakes its press.
  const pianoKeys = useRef(Promise.resolve());
  function sendPianoKey(pitch, velocity, on) {
    pianoKeys.current = pianoKeys.current.then(async () => {
      try { await post('/api/control', { action: 'note', pitch, velocity, on, device: requireDevice() }); }
      catch (error) { if (on) announce(error.message || 'The piano could not play that key.'); }
    });
  }
  const pressKey = (pitch, velocity) => onDevice ? local.press(pitch, velocity) : sendPianoKey(pitch, velocity, true);
  const releaseKey = pitch => onDevice ? local.release(pitch) : sendPianoKey(pitch, 1, false);
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
  const selectedIndex = status?.song_id ? (queueIds[queueIndex] === status.song_id ? queueIndex : queueIds.indexOf(status.song_id)) : queueIds.length ? Math.max(0, queueIndex) : -1;
  const selectedSong = current || library.songs.find(song => song.id === queueIds[selectedIndex]);
  const onDevice = output === 'device';
  const deviceSong = local.song ? library.songs.find(song => song.id === local.song.id) || local.song : selectedSong;
  const deviceIndex = local.song ? (queueIds[localIndex] === local.song.id ? localIndex : queueIds.indexOf(local.song.id)) : selectedIndex;
  const playerSong = onDevice ? deviceSong : current;
  const playerName = onDevice ? deviceSong?.name || '' : status?.name || '';
  const playerSongId = onDevice ? deviceSong?.id || '' : status?.song_id || '';
  const activeIndex = onDevice ? deviceIndex : queueIndex;
  const isPlaying = onDevice ? local.state === 'playing' : playing;
  const isPaused = onDevice ? local.state === 'paused' : !!status?.paused;
  const songAt = index => library.songs.find(song => song.id === queueIds[index]);
  advanceLocal.current = () => {
    const next = deviceIndex + 1;
    if (onDevice && deviceIndex >= 0 && songAt(next)) listenHere(songAt(next), next);
  };
  const artworkMatches = !onDevice || playerSongId === status?.song_id;
  const artworkUrl = artworkMatches && status?.name && typeof status?.artwork?.url === 'string' ? status.artwork.url : '';
  const playerArtwork = artworkMatches ? status?.artwork : null;
  const spotifyArtist = playerSong?.artist || playerArtwork?.artist;
  const spotifyTitle = playerSong?.album || playerArtwork?.album || playerArtwork?.title || (playerSong?.artist || playerSong?.album ? songTitle(playerSong.name) : '');
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
  const playerDuration = onDevice ? local.duration || deviceSong?.duration_seconds || 0 : duration;
  const playerElapsed = seekPreview && seekPreview.output === output && seekPreview.songId === playerSongId ? seekPreview.seconds : onDevice ? local.position : status?.seconds || 0;
  const canSeek = onDevice ? local.state !== 'stopped' && !!playerDuration : !busy && !!status?.song_id && !!duration;
  const canPlay = onDevice ? !local.loading && !!deviceSong : !busy && playable && !playing && (!!status?.name || !!queueIds.length);
  const canPrevious = onDevice ? !local.loading && deviceIndex > 0 : !busy && queueIndex > 0;
  const canNext = onDevice ? !local.loading && deviceIndex >= 0 && deviceIndex < queueIds.length - 1 : !busy && !!queueIds.length && queueIndex < queueIds.length - 1;
  const previewSeek = seconds => setSeekPreview({ output, songId: playerSongId, seconds });
  useEffect(() => {
    pianoClock.current = { seconds: status?.seconds || 0, playing: !!status?.playing && !status?.paused, at: performance.now() };
  }, [status]);
  const notesPlaying = isPlaying && !(seekPreview && seekPreview.output === output);
  const notesTime = () => {
    if (seekPreview && seekPreview.output === output && seekPreview.songId === playerSongId) return seekPreview.seconds;
    if (onDevice) return local.song?.id === playerSongId ? local.now() : 0;
    return status?.song_id === playerSongId ? songClock({ ...pianoClock.current, duration: playerDuration || Infinity }, performance.now()) : 0;
  };
  function toggleNotes() {
    withViewTransition(() => setShowNotes(value => {
      storage.set('piano-falling-notes', value ? 'off' : 'on');
      return !value;
    }));
  }
  async function seekTo(value) {
    const selected = seekPreview;
    if (!selected) return;
    setSeekPreview(null);
    if (selected.output === 'device') {
      if (local.song?.id === selected.songId) local.seek(Number(value));
      return;
    }
    await run(() => post('/api/control', { action: 'seek', seconds: Number(value), song_id: selected.songId }));
  }
  function playerPlay() {
    if (!onDevice) return queueAction('play', status?.song_id && queueIds[queueIndex] !== status.song_id ? { song_id: status.song_id } : {});
    if (local.state === 'paused') return local.resume();
    if (deviceSong) return listenHere(deviceSong, deviceIndex >= 0 ? deviceIndex : null);
  }
  const playerPause = () => onDevice ? local.pause() : control('pause');
  const playerStop = () => onDevice ? local.stop() : control('stop');
  function playerSkip(step) {
    if (!onDevice) return queueAction(step > 0 ? 'next' : 'previous');
    const target = deviceIndex + step;
    if (songAt(target)) listenHere(songAt(target), target);
  }
  function playQueued(index) {
    if (onDevice) return songAt(index) && listenHere(songAt(index), index);
    return queueAction('play', { index });
  }
  async function playSong(song, { showPlayer = true } = {}) {
    if (!onDevice) return queueAction('play', { song_id: song.id }, '', showPlayer);
    let index = queueIds.indexOf(song.id);
    if (index < 0) {
      // Match piano playback: a song from outside the queue joins its end so it shows as Now playing.
      const result = await queueAction('add', { song_id: song.id });
      if (!result) return;
      index = result.queue.song_ids.length - 1;
    }
    if (showPlayer) navigate('player');
    await listenHere(song, index);
  }
  async function chooseOutput(next) {
    if (next === output) return;
    setOutput(next);
    storage.set('piano-output', next);
    setSeekPreview(null);
    if (next === 'device') {
      if (playing && current) {
        listenHere(current, selectedIndex >= 0 ? selectedIndex : null, status?.seconds || 0);
        await control('pause');
      }
      return;
    }
    const transfer = local.state === 'playing' && deviceSong ? { song: deviceSong, index: deviceIndex, at: local.position } : null;
    local.stop();
    if (!transfer) return;
    if (!playable) {
      announce('Connect your piano to continue playing there.');
      return;
    }
    const started = await queueAction('play', transfer.index >= 0 ? { index: transfer.index } : { song_id: transfer.song.id });
    if (started && transfer.at > 1) await run(() => post('/api/control', { action: 'seek', seconds: transfer.at, song_id: transfer.song.id }));
  }
  const thisDevice = /iPhone|Android.+Mobile/i.test(navigator.userAgent) ? { name: 'This phone', icon: 'phone' }
    : /iPad|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent) ? { name: 'This tablet', icon: 'phone' }
    : { name: 'This computer', icon: 'laptop' };
  const localEntry = { id: 'device', kind: 'device', name: thisDevice.name, icon: thisDevice.icon, detail: 'Speakers or headphones' };
  const discoveredPianos = devices.map(item => ({ id: `midi:${item.id}`, kind: 'piano', name: item.name, stableName: item.stableName || item.name, icon: 'piano', detail: item.id === device?.id && !connectionError ? 'Connected' : item.connected === false ? 'Bluetooth · select to connect' : 'MIDI piano' }));
  const pianoEntries = device ? discoveredPianos : [{ id: 'piano', kind: 'piano', icon: 'piano', name: connectionError ? 'Office piano' : wanted || 'Office piano', stableName: wanted, detail: connectionError ? 'Piano computer unavailable' : 'Not connected' }, ...discoveredPianos];
  const currentEntry = onDevice ? localEntry : {
    id: device ? `midi:${device.id}` : 'piano', kind: 'piano', icon: 'piano',
    name: connectionError ? 'Office piano' : device?.name || wanted || 'Office piano',
    detail: connectionError ? 'Piano computer unavailable' : playable ? 'Connected' : wanted ? 'Waiting for connection' : 'No piano selected',
  };
  const otherEntries = [...(onDevice ? [] : [localEntry]), ...pianoEntries.filter(item => item.id !== currentEntry.id)];
  const noPianoNote = discoveredPianos.length ? '' : connectionError ? 'The piano computer is unavailable.' : 'No piano found. Turn it on, or check the piano connection settings.';
  function chooseDevice(entry) {
    if (entry.kind === 'device') return chooseOutput('device');
    if (entry.stableName) {
      setPreferred(entry.stableName);
      storage.set('piano-device-name', entry.stableName);
    }
    chooseOutput('piano');
  }
  const openConnection = () => { setDialog({ type: 'connection' }); refresh(); };
  const pickerProps = { current: currentEntry, others: otherEntries, playing: isPlaying, onChoose: chooseDevice, onSettings: openConnection, emptyNote: noPianoNote, local: onDevice };
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
    const destination = selectedLibrary;
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
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), ...(destination ? { 'X-Library-Id': destination.id } : {}) },
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
      let summary = `Saved ${result.saved} ${result.saved === 1 ? 'song' : 'songs'}${destination ? ` to ${destination.name}` : ''}.`;
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

  async function openAdaptation(requestedSongId, { applyNow = view === 'player' } = {}) {
    const songId = typeof requestedSongId === 'string' ? requestedSongId : status?.song_id || '';
    setAdaptationExpectedSongId(status?.song_id || '');
    const request = ++adaptationRequest.current;
    setAdaptationSongId(songId);
    setAdaptationData(null);
    setAdaptationLoading(true);
    setAdaptationError('');
    setAdaptationAttempted(false);
    setAdaptationMode(status?.adaptation?.settings?.mode || 'no_drums');
    setAdaptationParts([]);
    setDialog({ type: 'adaptation', applyNow });
    try {
      const data = await api(`/api/adaptation?song_id=${encodeURIComponent(songId)}`);
      if (request !== adaptationRequest.current) return;
      setAdaptationData(data);
      if (typeof data.expected_song_id === 'string') setAdaptationExpectedSongId(data.expected_song_id);
      setAdaptationMode(data.settings?.mode || 'no_drums');
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
      apply_now: dialog?.applyNow === true,
      mode: adaptationMode,
      parts: adaptationMode === 'custom' ? adaptationParts : [],
    }), dialog?.applyNow ? 'Playback sound saved. Press Play when ready.' : 'Playback settings saved to this song.');
    if (result) {
      setDialog(null);
    }
  }

  async function saveVolume(value) {
    try {
      await post('/api/control', { action: 'volume', value, device: Number(device?.id || 0) });
      announce('');
    } catch (error) { announce(error.message); }
    finally { volumeDragging.current = false; refresh(); }
  }

  const soundSettings = status?.adaptation?.settings || { mode: 'no_drums' };
  const soundReport = status?.adaptation?.report;
  const soundLabels = { no_drums: 'All parts except drums', original: 'Original MIDI', piano: 'Piano parts only', smart: 'Smart piano', custom: 'Choose parts' };
  const soundName = soundReport?.label || soundLabels[soundSettings.mode] || 'Original MIDI';
  const adaptationSong = library.songs.find(song => song.id === adaptationSongId);
  const analysedParts = adaptationData?.analysis?.parts || [];
  const hasPianoParts = !!adaptationData?.analysis?.has_piano;

  function renderSheetFile(item, book = false) {
    return <article className="sheet-file" key={item.id}>
          <div className="sheet-file-info"><Icon name="book" /><div>{book && <span className="sheet-book-kicker">Sheet music book</span>}<strong>{item.name}</strong><p className="section-note">{item.page_count ? `${item.page_count} ${item.page_count === 1 ? 'page' : 'pages'} · ` : ''}{({ needs_pages: 'Choose pages for your songs', queued: 'Waiting to convert', converting: 'Reading the notes…', ready: 'Converted', error: 'Conversion needs attention' })[item.status] || item.status}{item.pages ? ` · Pages ${Array.isArray(item.pages) ? item.pages.join(', ') : item.pages}` : ''}</p>{['queued', 'analyzing'].includes(item.analysis_status) && <p className="section-note" role="status">Finding songs… {analysisProgressText(item.analysis_progress, item.page_count)}</p>}{item.error && <p className="sheet-file-error">{item.error}</p>}{item.warning && <p className="sheet-file-warning">{item.warning}</p>}</div></div>
          <div className="sheet-file-actions"><button className="btn light small" disabled={busy} onClick={() => downloadSheet(item)}><Icon name="download" />Original</button>{item.extension === '.pdf' && !item.book_id && <><button className="btn small" disabled={busy} onClick={() => { announce(''); setDialog({ type: 'sheet_book', item }); }}>Browse songs</button><button className="btn light small" disabled={busy} onClick={() => { announce(''); openSheetSplit(item); }}>Split into songs</button></>}{item.status === 'error' && <button className="btn small" disabled={busy} onClick={async () => { const result = await run(() => post('/api/sheets/retry', { id: item.id })); if (result) await refreshSheets(); }}>Try again</button>}<button className="btn light small" disabled={busy || item.can_delete === false} aria-label={`Delete sheet file: ${item.name}`} title={item.can_delete === false ? 'Wait for processing to finish' : 'Delete uploaded file'} onClick={() => setDialog({ type: 'delete_sheet', item })}><Icon name="trash" />Delete</button>{['queued', 'converting'].includes(item.status) && <span className="spinner" aria-label="Converting" />}</div>
        </article>;
  }

  function addToLibrary(songId, libraryId) {
    const song = library.songs.find(item => item.id === songId);
    const destination = library.libraries.find(item => item.id === libraryId);
    if (!song || !destination) return;
    if ((song.library_ids || []).includes(libraryId)) return announce(`Already in ${destination.name}.`, true);
    run(() => post('/api/library', { action: 'assign', song_id: songId, library_id: libraryId, value: true }), `Added to ${destination.name}.`);
  }
  function queueTargetAt(point) {
    const stack = document.elementsFromPoint(point.x, point.y);
    const libraryButton = stack.find(element => element.closest?.('[data-library-id]'))?.closest('[data-library-id]');
    if (libraryButton) return { library: libraryButton.dataset.libraryId };
    if (!showQueuePanel) return null;
    if (stack.some(element => element.closest?.('.mini-player-queue'))) return { button: true };
    const inside = stack.find(element => element.closest?.('#queue-panel'));
    return inside ? queueDropTarget({ target: inside, clientY: point.y }) : null;
  }
  const songQueueDrag = {
    isOutside: point => !!queueTargetAt(point),
    onOutsideMove: point => {
      const target = queueTargetAt(point);
      if (target?.button && !queueVisible) setQueueVisible(true, { animate: false });
      if ((target?.library || '') !== libraryDrop) setLibraryDrop(target?.library || '');
      const next = target && !target.button && !target.library ? target : null;
      if (next?.index !== queueDrop?.index || next?.row !== queueDrop?.row) setQueueDrop(next);
    },
    onDropOutside: (point, songId) => {
      const target = queueTargetAt(point);
      setQueueDrop(null);
      setLibraryDrop('');
      if (target?.library) return addToLibrary(songId, target.library);
      if (target) queueAction('add', target.button ? { song_id: songId } : { song_id: songId, index: target.index, expected_song_ids: queueIds }, 'Added to the queue.');
    },
    outsideHint: 'Drop to add it here',
  };

  const selectedIds = selected.filter(id => library.songs.some(song => song.id === id));
  const selectedSongs = selectedIds.map(id => library.songs.find(song => song.id === id));
  function toggleSelected(songId) {
    setSelected(previous => previous.includes(songId) ? previous.filter(id => id !== songId) : [...previous, songId]);
  }
  function songRowClick(event, song) {
    if (event.target.closest('button, input, label, a') || songMenu) return;
    if (event.metaKey || event.ctrlKey) return toggleSelected(song.id);
    if (onDevice ? local.loading : busy) return;
    playSong(song, { showPlayer: false });
  }
  const closeSongMenu = useCallback(returnFocus => {
    setSongMenu(null);
    if (returnFocus === true) menuReturn.current?.focus?.();
  }, []);
  function openSongMenu(song, x, y, trigger) {
    menuReturn.current = trigger;
    setSongMenu({ songId: song.id, x, y });
  }
  async function eachSong(songIds, request, success) {
    return run(async () => {
      let data = null;
      for (const songId of songIds) data = await request(songId);
      return data;
    }, success);
  }
  const countSongs = count => `${count} ${count === 1 ? 'song' : 'songs'}`;
  const addSongsToQueue = songIds => eachSong(songIds, songId => post('/api/queue', { action: 'add', song_id: songId }), `Added ${countSongs(songIds.length)} to the queue.`);
  const favoriteSongs = (songIds, value) => eachSong(songIds, songId => post('/api/library', { action: 'favorite', song_id: songId, value }), value ? `Added ${countSongs(songIds.length)} to favorites.` : `Removed ${countSongs(songIds.length)} from favorites.`);
  async function addSongsToLibrary(songIds, item) {
    const missing = songIds.filter(songId => !(library.songs.find(song => song.id === songId)?.library_ids || []).includes(item.id));
    if (!missing.length) return announce(`Already in ${item.name}.`, true);
    const result = await eachSong(missing, songId => post('/api/library', { action: 'assign', song_id: songId, library_id: item.id, value: true }), `Added ${countSongs(missing.length)} to ${item.name}.`);
    if (result) setDialog(null);
  }
  async function deleteSongs(songIds) {
    const result = await eachSong(songIds, songId => post('/api/library', { action: 'delete', song_id: songId }));
    if (!result) return;
    setDialog(null);
    setSelected(previous => previous.filter(id => !songIds.includes(id)));
    setNotice({ text: songIds.length === 1 ? 'Song removed.' : `${countSongs(songIds.length)} removed.`, success: true, undoSongIds: songIds });
  }
  function songMenuItems(song) {
    const many = selectedIds.length > 1 && selectedIds.includes(song.id);
    if (many) {
      const ids = selectedIds;
      const allFavorite = selectedSongs.every(item => item.favorite);
      return [
        { label: `Add ${countSongs(ids.length)} to queue`, icon: 'plus', disabled: busy, onSelect: () => addSongsToQueue(ids) },
        { label: allFavorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => favoriteSongs(ids, !allFavorite) },
        { label: 'Add to library…', icon: 'folder', disabled: busy, onSelect: () => setDialog({ type: 'bulk_assign', songIds: ids }) },
        { separator: true, key: 'danger' },
        { label: `Delete ${countSongs(ids.length)}…`, icon: 'trash', danger: true, disabled: busy, onSelect: () => setDialog({ type: 'bulk_delete', songIds: ids }) },
      ];
    }
    return [
      { label: 'Play', icon: 'play', disabled: onDevice ? local.loading : busy, onSelect: () => playSong(song, { showPlayer: false }) },
      { label: 'Add to queue', icon: 'plus', disabled: busy, onSelect: () => queueAction('add', { song_id: song.id }, 'Added to the Player queue.') },
      { label: song.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => run(() => post('/api/library', { action: 'favorite', song_id: song.id, value: !song.favorite })) },
      { label: 'Add to library…', icon: 'folder', onSelect: () => setDialog({ type: 'assign', songId: song.id }) },
      { separator: true, key: 'settings' },
      { label: 'Playback sound…', icon: 'piano', disabled: busy, onSelect: () => openAdaptation(song.id) },
      { label: 'Edit details…', icon: 'edit', disabled: busy, onSelect: () => { setLibraryName(songTitle(song.name)); setSongArtist(song.artist || ''); setSongAlbum(song.album || ''); setDialog({ type: 'rename_song', songId: song.id }); } },
      { label: 'Download MIDI', icon: 'download', onSelect: () => download(song) },
      song.source_kind === 'sheet' && { label: 'Download editable score', icon: 'book', onSelect: () => downloadRecognizedScore(song) },
      { separator: true, key: 'danger' },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: busy, onSelect: () => setDialog({ type: 'delete', songId: song.id }) },
    ];
  }
  const menuSong = songMenu && library.songs.find(song => song.id === songMenu.songId) && (songMenu.kind !== 'queue' || queueIds[songMenu.index] === songMenu.songId) ? library.songs.find(song => song.id === songMenu.songId) : null;

  function renderSavedSongs(songs, groupId) {
    const endSongDrag = () => { setDraggingSong(''); setQueueDrop(null); setLibraryDrop(''); };
    return <SortableList items={songs.map(song => song.id)} getLabel={id => songTitle(library.songs.find(song => song.id === id)?.name)} onStart={from => { startReorder('songs', from, groupId); setDraggingSong(songs[from]?.id || ''); }} onEnd={to => { endSongDrag(); return finishReorder(to); }} onCancel={() => { endSongDrag(); cancelReorder(); }} {...songQueueDrag}>
        <div className="song-list">{!songs.length ? <EmptyState icon={filter ? 'search' : view === 'favorites' ? 'heart' : 'note'} title={filter ? 'No matching pieces' : view === 'favorites' ? 'Keep your favorites close' : 'Make room for a little music.'} description={filter ? 'Try another title.' : view === 'favorites' ? 'Tap the heart beside a saved song to keep it here.' : view === 'sheets' ? 'Upload sheet music above. Converted pieces will appear here.' : 'Upload a MIDI file, or find a new piece in Discover.'} button={filter || view === 'favorites' || view === 'sheets' ? null : 'Discover music'} onClick={() => navigate('discover')} /> : <><div className="list-labels saved-labels"><label className="song-check" title="Select all"><input type="checkbox" aria-label="Select all songs in this list" checked={songs.every(song => selectedIds.includes(song.id))} ref={element => { if (element) element.indeterminate = songs.some(song => selectedIds.includes(song.id)) && !songs.every(song => selectedIds.includes(song.id)); }} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...songs.map(song => song.id)])] : previous.filter(id => !songs.some(song => song.id === id)))} /></label><span /><span>Piece</span><span className="type-label">Instrument</span><span>Time</span><span /></div>{songs.map((song, index) => {
          const piano = song.piano_only === true;
          return <SortableItem key={song.id} id={song.id} disabled={busy || songs.length < 2}>{({ rowProps, handleProps }) => <div {...rowProps} {...songDragProps(song)} className={`song-row saved-song ${playerSongId === song.id ? 'is-current' : ''} ${draggingSong === song.id ? 'is-queue-dragging' : ''} ${selectedIds.includes(song.id) ? 'is-selected' : ''}`} onClick={event => songRowClick(event, song)} onContextMenu={event => { event.preventDefault(); openSongMenu(song, event.clientX, event.clientY, event.currentTarget.querySelector('.song-more')); }}><label className="song-check" title={`Select ${song.name}`}><input type="checkbox" checked={selectedIds.includes(song.id)} aria-label={`Select ${song.name}`} onChange={() => toggleSelected(song.id)} /></label><div className="mini-art"><button className="sort-handle" disabled={busy || songs.length < 2} aria-label={`Reorder song: ${song.name}`} title="Drag to reorder, or press Space then arrow keys" {...handleProps}><Icon name="grip" /></button><span className="song-row-icon" aria-hidden="true"><Icon name="note" /></span></div><div className="song-info"><button className="song-name song-name-button" title={`Play ${song.name}`} aria-label={`Play ${song.name}`} disabled={onDevice ? local.loading : busy} onClick={() => playSong(song, { showPlayer: false })}>{songTitle(song.name)}</button>{(song.artist || song.album) && <div className="song-record">{[song.artist, song.album].filter(Boolean).join(' · ')}</div>}<div className="song-sub">{piano ? 'Piano only' : 'Other MIDI'} · {song.source_url ? `From ${providerName(song.source_url)}` : song.source_kind === 'sheet' ? 'From sheet music' : 'Uploaded'} · Saved locally</div>{groupId && (sheets.song_sources || []).filter(source => source.song_id === song.id && source.source_id === groupId).slice(0, 1).map(source => <div key={source.song_id}>{source.pages?.length > 0 && <p className="sheet-song-pages">PDF {source.pages.length === 1 ? 'page' : 'pages'} {source.pages.join(', ')}</p>}{source.warning && <p className="sheet-file-warning">{source.warning}</p>}</div>)}</div><span className={`piano-badge ${piano ? '' : 'candidate'}`}>{piano ? 'Piano only' : 'Other MIDI'}</span><span className="duration">{time(song.duration_seconds)}</span><button type="button" className="song-more" aria-label={`More actions for ${song.name}`} title="More actions" aria-haspopup="menu" aria-expanded={songMenu?.songId === song.id} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openSongMenu(song, box.right - 200, box.bottom + 4, event.currentTarget); }}><Icon name="more" /></button></div>}</SortableItem>;
        })}</>}</div></SortableList>;
  }

  const hasCurrent = activeIndex >= 0 && !!songAt(activeIndex);
  const nowLabel = 'Now playing';
  const queueSections = [
    { key: 'next', title: 'Next up', start: hasCurrent ? activeIndex + 1 : 0, end: queueIds.length },
    { key: 'earlier', title: 'Earlier in queue', start: 0, end: hasCurrent ? activeIndex : 0 },
  ].filter(section => section.end > section.start);
  const queueRow = (index, section = null, rowProps = {}, handleProps = {}) => {
    const song = songAt(index);
    const isCurrent = !section;
    const drop = queueDrop?.row === index ? queueDrop.after ? 'drop-after' : 'drop-before' : '';
    const entry = queueEntryIds[index];
    const picked = queueSelectedKeys.includes(entry);
    return <div {...rowProps} className={`queue-row ${isCurrent ? 'is-current' : ''} ${picked ? 'is-selected' : ''} ${drop}`} role="listitem" data-queue-index={index} data-queue-current={isCurrent ? 'true' : undefined} onClick={event => queueRowClick(event, index, isCurrent)} onContextMenu={event => { event.preventDefault(); openQueueMenu(index, event.clientX, event.clientY, event.currentTarget.querySelector('.song-more')); }}>
      <span className="queue-number">{isCurrent
        ? isPlaying ? <span className="equalizer" aria-hidden="true"><i /><i /><i /></span> : <Icon name={isPaused ? 'pause' : 'play'} />
        : <><button className="sort-handle" disabled={busy || section.end - section.start < 2} aria-label={`Reorder queued song: ${song.name}`} title="Drag to reorder, or press Space then arrow keys" {...handleProps}><Icon name="grip" /></button><span className="queue-position">{String(index - section.start + 1).padStart(2, '0')}</span></>}</span>
      <div className="song-info"><div className="song-name" title={song.name}>{songTitle(song.name)}</div><div className="queue-status">{[song.artist, song.piano_only === true ? 'Piano only' : 'Other MIDI'].filter(Boolean).join(' · ')}</div></div>
      <span className="duration">{time(song.duration_seconds)}</span>
      <button type="button" className="song-more" aria-label={`More actions for queued song: ${song.name}`} title="More actions" aria-haspopup="menu" aria-expanded={songMenu?.kind === 'queue' && songMenu.index === index} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openQueueMenu(index, box.right - 200, box.bottom + 4, event.currentTarget); }}><Icon name="more" /></button>
    </div>;
  };
  const queueSelectedKeys = queueSelected.filter(entry => queueEntryIds.includes(entry));
  const queueSelectedIndexes = queueSelectedKeys.map(entry => queueEntryIds.indexOf(entry));
  const queueSelectedSongs = [...new Set(queueSelectedIndexes.map(index => queueIds[index]))];
  function toggleQueueSelected(entry) {
    setQueueSelected(previous => previous.includes(entry) ? previous.filter(item => item !== entry) : [...previous, entry]);
  }
  const canPlayQueued = onDevice ? !local.loading : !busy && playable;
  function queueRowClick(event, index, isCurrent) {
    if (event.target.closest('button, input, label, a') || songMenu) return;
    if (event.metaKey || event.ctrlKey) return toggleQueueSelected(queueEntryIds[index]);
    if (!canPlayQueued || isCurrent && isPlaying) return;
    if (isCurrent && isPaused) return playerPlay();
    playQueued(index);
  }
  function openQueueMenu(index, x, y, trigger) {
    menuReturn.current = trigger;
    setSongMenu({ kind: 'queue', index, songId: queueIds[index], x, y });
  }
  async function removeQueued(indexes) {
    const ordered = [...new Set(indexes)].sort((a, b) => b - a);
    const result = await eachSong(ordered, index => post('/api/queue', { action: 'remove', index }), ordered.length > 1 ? `Removed ${countSongs(ordered.length)} from the queue.` : '');
    if (result) setQueueSelected([]);
  }
  function queueMenuItems(index) {
    const song = songAt(index);
    const entry = queueEntryIds[index];
    if (queueSelectedKeys.length > 1 && queueSelectedKeys.includes(entry)) {
      const allFavorite = queueSelectedSongs.every(id => library.songs.find(item => item.id === id)?.favorite);
      return [
        { label: `Remove ${countSongs(queueSelectedKeys.length)} from queue`, icon: 'close', disabled: busy, onSelect: () => removeQueued(queueSelectedIndexes) },
        { label: allFavorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => favoriteSongs(queueSelectedSongs, !allFavorite) },
        { label: 'Add to library…', icon: 'folder', disabled: busy, onSelect: () => setDialog({ type: 'bulk_assign', songIds: queueSelectedSongs }) },
      ];
    }
    return [
      { label: index === activeIndex && isPaused ? 'Resume' : 'Play', icon: 'play', disabled: !canPlayQueued || index === activeIndex && isPlaying, onSelect: () => index === activeIndex && isPaused ? playerPlay() : playQueued(index) },
      { label: 'Remove from queue', icon: 'close', disabled: busy, onSelect: () => queueAction('remove', { index }) },
      { separator: true, key: 'song' },
      { label: song.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => run(() => post('/api/library', { action: 'favorite', song_id: song.id, value: !song.favorite })) },
      { label: 'Add to library…', icon: 'folder', onSelect: () => setDialog({ type: 'assign', songId: song.id }) },
      { label: 'Playback sound…', icon: 'piano', disabled: busy, onSelect: () => openAdaptation(song.id) },
      { label: 'Download MIDI', icon: 'download', onSelect: () => download(song) },
    ];
  }
  const queueLibraryDrag = {
    isOutside: point => !!queueTargetAt(point)?.library,
    onOutsideMove: point => { const target = queueTargetAt(point)?.library || ''; if (target !== libraryDrop) setLibraryDrop(target); },
    onDropOutside: (point, entry) => {
      const target = queueTargetAt(point)?.library;
      setLibraryDrop('');
      if (target) addToLibrary(queueIds[queueEntryIds.indexOf(entry)], target);
    },
    outsideHint: 'Drop to add it here',
  };
  const queueContent = <>
        <div className="content-heading queue-header"><div><h2>Your queue</h2>{queueIds.length > 0 && <p className="section-note">{queueIds.length} {queueIds.length === 1 ? 'piece' : 'pieces'}</p>}</div><div className="queue-tools"><button className="btn small" disabled={!queueIds.length || (onDevice ? local.loading : busy || !playable || playing)} onClick={() => onDevice ? playQueued(0) : queueAction('play')}><Icon name="play" />Play queue</button><button className="btn light small" disabled={busy || !queueIds.length} onClick={() => queueAction('clear')}>Clear queue</button></div></div>
        {queueSelectedKeys.length > 0 && <div className="queue-bulk" role="toolbar" aria-label="Selected queued songs"><strong>{countSongs(queueSelectedKeys.length)} selected</strong><div className="bulk-actions"><button className="btn light small" disabled={busy} onClick={() => removeQueued(queueSelectedIndexes)}><Icon name="close" />Remove</button><button className="btn light small" disabled={busy} onClick={() => favoriteSongs(queueSelectedSongs, !queueSelectedSongs.every(id => library.songs.find(item => item.id === id)?.favorite))}><Icon name="heart" />{queueSelectedSongs.every(id => library.songs.find(item => item.id === id)?.favorite) ? 'Unfavorite' : 'Favorite'}</button><button className="btn light small" disabled={busy} onClick={() => setDialog({ type: 'bulk_assign', songIds: queueSelectedSongs })}><Icon name="folder" />Library</button><button className="btn light small" onClick={() => setQueueSelected([])}>Clear</button></div></div>}
        {!queueIds.length ? <div className="song-list" role="list" aria-label="Song queue"><EmptyState title="Your next song starts here." description="Add a few favorites or queue an entire library. Nothing starts until you press play." button="Browse your music" onClick={() => navigate('all')} /></div> : <>
          {hasCurrent && <div className="queue-section"><h3 className="queue-section-title">{nowLabel}</h3><div className="song-list queue-now" role="list" aria-label={nowLabel}>{queueRow(activeIndex)}</div></div>}
          {queueSections.map(section => {
            const entries = queueEntryIds.slice(section.start, section.end);
            return <div className="queue-section" key={section.key}><h3 className="queue-section-title">{section.title}</h3>
              <SortableList items={entries} getLabel={entry => songTitle(songAt(queueEntryIds.indexOf(entry))?.name)} onStart={from => startReorder('queue', from + section.start)} onEnd={to => { setLibraryDrop(''); return finishReorder(to + section.start); }} onCancel={() => { setLibraryDrop(''); cancelReorder(); }} {...queueLibraryDrag}>
                <div className="song-list" role="list" aria-label={section.title}>{entries.map((entry, offset) => songAt(section.start + offset) && <SortableItem key={entry} id={entry} disabled={busy || entries.length < 2}>{({ rowProps, handleProps }) => queueRow(section.start + offset, section, rowProps, handleProps)}</SortableItem>)}</div>
              </SortableList></div>;
          })}
        </>}
  </>;
  // With falling notes open on a wide Player page, the queue moves to the side panel to make room.
  const queueBeside = view === 'player' && showNotes && wideQueue;
  const showQueuePanel = view !== 'player' || queueBeside;
  const queueIsDocked = showQueuePanel && wideQueue && (queueDocked || queueBeside);
  const queueVisible = queueIsDocked || showQueuePanel && queueOpen;
  // Docking the panel reflows the page, so clicks animate it; drags open it instantly.
  function setQueueVisible(visible, { animate = true } = {}) {
    if (!wideQueue) return setQueueOpen(visible);
    storage.set('piano-queue-panel', visible ? 'shown' : 'hidden');
    if (animate) withViewTransition(() => setQueueDocked(visible)); else setQueueDocked(visible);
  }
  const songDragProps = song => ({
    draggable: !busy,
    onPointerDownCapture: event => { songDragBlocked.current = !!event.target.closest('.sort-handle, input, textarea'); },
    onDragStart: event => {
      if (songDragBlocked.current) return event.preventDefault();
      event.dataTransfer.setData(SONG_DRAG_TYPE, song.id);
      event.dataTransfer.setData('text/plain', songTitle(song.name));
      event.dataTransfer.effectAllowed = 'copy';
      setDraggingSong(song.id);
    },
    onDragEnd: () => { setDraggingSong(''); setQueueDrop(null); setLibraryDrop(''); },
  });
  const carriesSong = event => event.dataTransfer?.types?.includes(SONG_DRAG_TYPE);
  const libraryDropProps = libraryId => ({
    'data-library-id': libraryId,
    onDragOver: event => {
      if (!carriesSong(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (libraryDrop !== libraryId) setLibraryDrop(libraryId);
    },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setLibraryDrop(''); },
    onDrop: event => {
      if (!carriesSong(event)) return;
      event.preventDefault();
      setLibraryDrop('');
      setDraggingSong('');
      addToLibrary(event.dataTransfer.getData(SONG_DRAG_TYPE), libraryId);
    },
  });
  function queueDropTarget(event) {
    const row = event.target.closest?.('[data-queue-index]');
    if (!row) return { index: queueIds.length, row: -1, after: false };
    const index = Number(row.dataset.queueIndex);
    if (row.dataset.queueCurrent) return { index: index + 1, row: index, after: true };
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    return { index: after ? index + 1 : index, row: index, after };
  }
  const queueDropProps = {
    onDragOver: event => {
      if (!carriesSong(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      const target = queueDropTarget(event);
      if (target.index !== queueDrop?.index || target.row !== queueDrop?.row) setQueueDrop(target);
    },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setQueueDrop(null); },
    onDrop: event => {
      if (!carriesSong(event)) return;
      event.preventDefault();
      const songId = event.dataTransfer.getData(SONG_DRAG_TYPE);
      const { index } = queueDropTarget(event);
      setQueueDrop(null);
      setDraggingSong('');
      if (songId) queueAction('add', { song_id: songId, index, expected_song_ids: queueIds }, 'Added to the queue.');
    },
  };

  const viewTitle = view === 'sheets' ? 'Songs from sheet music' : view === 'favorites' ? 'Your favorites' : selectedLibrary?.name || 'All songs';
  const viewNote = view === 'sheets' ? 'Converted on this Mac. Review the notes before playing.' : '';

  return <div className={`shell ${view !== 'player' ? 'with-mini-player' : ''} ${queueIsDocked ? 'queue-docked' : ''} ${view !== 'player' && view !== 'discover' && selectedIds.length ? 'has-bulk-bar' : ''}`}>
    <aside className="sidebar">
      <div className="brand">{logoMissing ? <><span className="brand-mark"><Icon name="piano" /></span>Office Piano</> : <div><img className="brand-logo" src="/assets/brand/cymphony-logo-full-purple.svg" alt="Cymphony" onError={() => setLogoMissing(true)} /><span className="brand-name">Office Piano</span></div>}</div>
      <nav className="nav" aria-label="Music">
        {[['player', 'Player', 'play', queueIds.length], ['all', 'All songs', 'grid', library.songs.filter(song => song.source_kind !== 'sheet').length], ['favorites', 'Favorites', 'heart', library.songs.filter(song => song.favorite).length], ['discover', 'Discover', 'search'], ['sheets', 'Sheet music', 'book', library.songs.filter(song => song.source_kind === 'sheet').length]].map(([id, label, icon, count]) => <button key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} />{label}{id === 'sheets' && <span className="nav-wip">WIP</span>}{count !== undefined && <span className="count">{count}</span>}</button>)}
      </nav>
      <div className="collections"><div className="side-heading"><span className="eyebrow">Your libraries</span><button className="icon-button" aria-label="Create library" title="Create library" onClick={() => { setLibraryName(''); setDialog({ type: 'create' }); }}><Icon name="plus" /></button></div>
        <nav className="nav library-nav" aria-label="Libraries">{library.libraries.map(item => <button key={item.id} {...libraryDropProps(item.id)} className={`${view === item.id ? 'active' : ''} ${draggingSong ? 'is-drop-ready' : ''} ${libraryDrop === item.id ? 'is-drop-target' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name="folder" /><span className="name">{item.name}</span><span className="count">{library.songs.filter(song => (song.library_ids || []).includes(item.id)).length}</span></button>)}</nav>
      </div>
      <div className="side-note"><Icon name="piano" /> A little music for the room.<br />PianoDisc · Prodigy II</div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="topbar-status"><span className={`online-count ${connectionError ? 'offline' : ''}`} title="Browsers connected to this piano app. Closed browsers disappear within 90 seconds."><span className="online-dot" />{connectionError ? 'Offline' : status ? `${status.online_count ?? 1} online` : 'Connecting…'}</span><button className={`connection ${onDevice || playable ? 'connected' : ''}`} title="Connect to a device" onClick={openConnection}><span className="dot" /><span className="label">{onDevice ? `Playing on ${thisDevice.name}` : connectionError ? 'Piano computer unavailable' : device?.name || (wanted ? 'Waiting for your piano' : status ? 'Connect your piano' : 'Connecting to your Mac…')}</span><Icon name="arrow" /></button></div></header>
      <div className="intro"><div><h1>{view === 'player' ? 'Player' : view === 'discover' ? 'Discover' : view === 'sheets' ? 'Sheet music' : 'Your music'}</h1></div>{(view === 'all' || selectedLibrary) && <button className="btn light" onClick={() => fileInput.current?.click()} disabled={busy} title={selectedLibrary ? `Upload MIDI to ${selectedLibrary.name}` : 'Upload MIDI to All songs'}><Icon name="upload" />Upload MIDI</button>}{view === 'sheets' && <button className="btn light" onClick={() => sheetInput.current?.click()} disabled={busy}><Icon name="upload" />Upload sheet music</button>}<input ref={sheetInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.musicxml,.mxl" multiple onChange={uploadSheets} hidden /><input ref={fileInput} type="file" accept=".mid,.midi" multiple onChange={upload} hidden /></div>
      {notice && <div className={`message visible ${notice.success ? 'success' : ''}`} role={notice.success ? 'status' : 'alert'} aria-live="polite">{notice.text}{notice.undoSheetId && <button className="btn light small" style={{ marginLeft: 12 }} onClick={async () => { const result = await run(() => post('/api/sheets/restore', { id: notice.undoSheetId }), 'File restored.'); if (result) await refreshSheets(); }}>Undo</button>}{notice.undoSongIds && <button className="btn light small" style={{ marginLeft: 12 }} onClick={() => eachSong(notice.undoSongIds, songId => post('/api/library', { action: 'restore', song_id: songId }), notice.undoSongIds.length === 1 ? 'Song restored.' : `${countSongs(notice.undoSongIds.length)} restored.`)}>Undo</button>}</div>}

      {view === 'player' && <section aria-label="Player">
        <section className="player" aria-label="Piano player"><div className={`art ${showArtwork ? 'has-cover' : ''}`} aria-hidden={showArtwork || spotifyLink ? undefined : true}>{canLoadArtwork && <img className={`album-cover ${showArtwork ? 'is-ready' : ''}`} src={artworkUrl} alt="" onLoad={() => setLoadedArtwork(artworkUrl)} onError={() => setFailedArtwork(artworkUrl)} />}{!showArtwork && <div className="keys">{[true, true, false, true, true, true, false].map((black, index) => <i className={black ? 'black' : ''} key={index} />)}</div>}{spotifyLink && <a className="spotify-cover-link" href={spotifyLink} target="_blank" rel="noopener noreferrer" aria-label="Find this album on Spotify" title="Find this album on Spotify"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760" stroke="none"/><path d="M5 8c5-1.7 10-1.2 14 1M6 12c4-1.3 8-1 12 1M7 16c3-.8 6-.5 9 1" fill="none" stroke="#121d16" strokeWidth="1.7" strokeLinecap="round"/></svg>Spotify ↗</span></a>}</div><div className="player-content"><div className="eyebrow"><span className="playing-pulse" /><span>{onDevice && local.loading ? 'Loading…' : isPlaying ? 'Now playing' : isPaused ? 'Paused' : 'Ready when you are'}</span></div><h2 className="song-title">{playerName ? songTitle(playerName) : 'Waiting for a song'}</h2>{(playerSong?.artist || playerSong?.album) && <p className="player-record">{[playerSong.artist, playerSong.album].filter(Boolean).join(' · ')}</p>}{playerName && <p className="song-meta">{[playerSong?.piano_only === true ? 'Piano only' : 'Other MIDI', playerSong?.source_url ? providerName(playerSong.source_url) : playerSong?.source_kind === 'sheet' ? 'Sheet music' : ''].filter(Boolean).join(' · ')}</p>}<div className="progress-row"><span>{time(playerElapsed)}</span><input className="song-timeline" type="range" min="0" max={playerDuration || 1} step="0.1" value={Math.min(playerDuration || 1, playerElapsed)} aria-label="Song timeline" aria-valuetext={`${time(playerElapsed)} of ${time(playerDuration)}`} disabled={!canSeek} onChange={event => previewSeek(Number(event.target.value))} onPointerUp={event => seekTo(event.currentTarget.value)} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) seekTo(event.currentTarget.value); }} onBlur={event => seekTo(event.currentTarget.value)} /><span>{time(playerDuration)}</span></div>
          <div className="player-bottom"><div className="controls"><button className="icon-button" aria-label="Previous song" title="Previous song" disabled={!canPrevious} onClick={() => playerSkip(-1)}><Icon name="previous" /></button><button className="play-button" aria-label={isPaused ? 'Resume' : 'Play'} title={isPaused ? 'Resume' : 'Play'} disabled={!canPlay || isPlaying} onClick={playerPlay}>{onDevice && local.loading ? <span className="spinner" /> : <Icon name="play" />}</button><button className="icon-button" aria-label="Pause" title="Pause" disabled={onDevice ? !isPlaying : busy || !playing} onClick={playerPause}><Icon name="pause" /></button><button className="icon-button" aria-label="Next song" title="Next song" disabled={!canNext} onClick={() => playerSkip(1)}><Icon name="next" /></button><button className="icon-button" aria-label={onDevice ? 'Stop' : 'Stop and release keys'} title={onDevice ? 'Stop' : 'Stop & release keys'} onClick={playerStop} disabled={onDevice ? local.state === 'stopped' && !local.loading : busy}><Icon name="stop" /></button></div>
            <div className="player-tools"><button type="button" className="sound-button" onClick={openAdaptation} disabled={busy} aria-label={`Playback sound: ${soundName}. Change playback sound`} title="Change playback sound"><Icon name="piano" /><span className="sound-button-label">{soundName}</span>{soundSettings.mode === 'smart' && <span className="experimental-badge">Experimental</span>}</button><DevicePicker {...pickerProps} />{onDevice
              ? <div className="volume-wrap"><label htmlFor="volume" aria-label="Volume on this device"><Icon name="volume" /></label><input id="volume" type="range" min="0" max="100" value={local.volume} aria-label="Volume on this device" onChange={event => local.setVolume(Number(event.target.value))} /><output htmlFor="volume">{local.volume}%</output></div>
              : <div className="volume-wrap"><label htmlFor="volume" aria-label="Piano volume"><Icon name="volume" /></label><input id="volume" type="range" min="0" max="100" value={volume} aria-label="Piano volume" onChange={event => { volumeDragging.current = true; setVolume(Number(event.target.value)); }} onPointerUp={event => saveVolume(Number(event.currentTarget.value))} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) saveVolume(Number(event.currentTarget.value)); }} onBlur={event => { if (volumeDragging.current) saveVolume(Number(event.currentTarget.value)); }} /><output htmlFor="volume">{volume}%</output></div>}</div>
          </div>
          <p className={`playing-on ${onDevice ? 'is-local' : ''}`}><Icon name={currentEntry.icon} />Playing on {currentEntry.name}{onDevice && ' · simple piano sound, the piano stays silent'}</p></div></section>
        <section className={`notes-panel ${showNotes ? 'is-open' : ''}`} aria-labelledby="notes-heading">
          <div className="notes-panel-header"><div><h2 id="notes-heading">Falling notes</h2><p className="section-note">Notes from the original file, without drums. Press the keys to play along.</p></div><button type="button" className="btn small" aria-expanded={showNotes} aria-controls="falling-notes" onClick={toggleNotes}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div id="falling-notes"><FallingNotes songId={playerSongId} loadSong={loadSongNotes} getTime={notesTime} playing={notesPlaying} position={playerElapsed} onPress={pressKey} onRelease={releaseKey} /></div>}
        </section>
        {!queueBeside && <div className="queue-block">{queueContent}</div>}
      </section>}

      {view === 'sheets' && <section className="sheet-import" aria-label="Sheet music files">
        <div className="sheet-explainer"><span className="mini-art"><Icon name="book" /></span><div><h2>A page, a piece, or a whole book</h2><p>Upload a PDF, a clear photo, or a MusicXML score.</p><p className="section-note">Recognition can miss notes, rhythm, or repeats. Check converted songs before playing.</p></div></div>
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

      {view !== 'player' && view !== 'discover' && selectedIds.length > 0 && <div className="bulk-bar" role="toolbar" aria-label="Selected songs">
        <strong>{countSongs(selectedIds.length)} selected</strong>
        <div className="bulk-actions">
          <button className="btn light small" disabled={busy} onClick={() => addSongsToQueue(selectedIds)}><Icon name="plus" />Add to queue</button>
          <button className="btn light small" disabled={busy} onClick={() => favoriteSongs(selectedIds, !selectedSongs.every(song => song.favorite))}><Icon name="heart" />{selectedSongs.every(song => song.favorite) ? 'Remove from favorites' : 'Add to favorites'}</button>
          <button className="btn light small" disabled={busy} onClick={() => setDialog({ type: 'bulk_assign', songIds: selectedIds })}><Icon name="folder" />Add to library</button>
          <button className="btn light small bulk-delete" disabled={busy} onClick={() => setDialog({ type: 'bulk_delete', songIds: selectedIds })}><Icon name="trash" />Delete</button>
          <button className="btn light small" onClick={() => setSelected([])}>Clear</button>
        </div>
      </div>}
      {view !== 'player' && view !== 'discover' && (view !== 'sheets' || listedSongs.length > 0 || !sheets.items.length) && <section aria-label="Saved music">
        <div className="content-heading"><div><h2>{view === 'sheets' && sheetGroups.books.length ? 'Other sheet songs' : viewTitle}</h2>{viewNote && <p className="section-note">{viewNote}</p>}</div><div className="saved-heading-tools">{view !== 'sheets' && <>{selectedLibrary && <button className="btn light small" onClick={() => { setLibraryName(selectedLibrary.name); setDialog({ type: 'rename', libraryId: selectedLibrary.id }); }}>Rename library</button>}<label className="search"><Icon name="search" /><input type="search" placeholder="Find a saved song…" aria-label="Filter saved songs" value={filter} onChange={event => setFilter(event.target.value)} /></label><button className="btn light small" disabled={busy || !savedSongs.length} title={`Queue ${savedSongs.length} songs`} onClick={() => queueAction('replace', { song_ids: savedSongs.map(song => song.id) }, 'Queue ready. Press play when you want music.', true)}>{selectedLibrary ? 'Queue library' : 'Queue these songs'}</button></>}</div></div>
        {renderSavedSongs(listedSongs, view === 'sheets' ? 'loose' : undefined)}
      </section>}

      {view === 'discover' && <section aria-label="Discover music"><div className="discover-toolbar"><label className="source-chooser"><span>Source</span><select value={searchSource} onChange={event => chooseSearchSource(event.target.value)}><option value="all">All sites</option><option value="both">BitMidi + FreeMidi</option><option value="bitmidi">BitMidi</option><option value="freemidi">FreeMidi</option><option value="bushgrafts">Bushgrafts · Jazz</option><option value="kunstderfuge">Kunst der Fuge · Classical</option></select></label><form className="search" onSubmit={event => { event.preventDefault(); search(); }}><Icon name="search" /><input type="search" placeholder="Search a song, composer, or artist…" aria-label="Search MIDI sites" required maxLength="120" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn" type="submit">{searching ? <><span className="spinner" />Checking</> : 'Search'}</button></form></div><p className="discovery-note" aria-live="polite">{sourceDescriptions[searchSource]}</p><div className="search-warnings" role="status">{searchData.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><p className="section-note" style={{ margin: '0 0 14px' }} aria-live="polite">{searching ? 'Searching catalogs… This can take a moment.' : searchData.searched ? `${searchData.results.length}${Number.isInteger(searchData.totalMatches) ? ` of ${searchData.totalMatches}` : ''} songs shown · ${searchData.results.filter(result => result.piano_only === true).length} piano-only${searchData.hasMore ? ' · More available below' : ''}` : ''}</p><div className="song-list results">{searchData.results.length ? searchData.results.map((result, index) => <SearchResult key={`${result.url}-${index}`} result={result} libraries={library.libraries} busy={busy} onSave={saveResult} notice={notice} />) : searchData.searched ? <EmptyState title="No songs found in this batch." description="Try the next results, or search another title or composer." /> : <EmptyState icon="search" title="Find a song" description="Try a song title, artist, or composer." />}</div>{searchData.hasMore && <button className="btn light load-more" disabled={searching} onClick={() => search(true)}>Load more songs</button>}</section>}

      <footer className="footer"><span /><button onClick={() => { setCopied(false); setDialog({ type: 'remote' }); }}><Icon name="wifi" />Control over Wi-Fi</button></footer>
    </main>
    {queueVisible && <aside className={`queue-panel ${queueIsDocked ? '' : 'is-open'} ${draggingSong ? 'is-drop-ready' : ''} ${queueDrop ? 'is-drop-target' : ''}`} id="queue-panel" aria-label="Queue" {...queueDropProps}>
      {!queueBeside && <button type="button" ref={queueClose} className="icon-button queue-panel-close" aria-label="Close queue" title="Close queue" onClick={() => setQueueVisible(false)}><Icon name="close" /></button>}
      {queueContent}
    </aside>}
    {queueVisible && !queueIsDocked && <div className="queue-backdrop" aria-hidden="true" onClick={() => setQueueOpen(false)} />}
    {view !== 'player' && <section className="mini-player" aria-label="Mini player">
      <button className="mini-player-song" onClick={() => navigate('player')} aria-label="Open full player">
        <span className="mini-player-art">{canLoadArtwork ? <img src={artworkUrl} alt="" onLoad={() => setLoadedArtwork(artworkUrl)} onError={() => setFailedArtwork(artworkUrl)} /> : <Icon name="piano" />}</span>
        <span className="mini-player-title"><strong>{playerName ? songTitle(playerName) : 'Waiting for a song'}</strong>{onDevice ? <small className="mini-playing-on">Playing on {currentEntry.name}</small> : <small>{playerSong?.artist || (isPlaying ? 'Now playing' : isPaused ? 'Paused' : 'Open player')}</small>}</span>
      </button>
      <div className="mini-player-progress"><span>{time(playerElapsed)}</span><input className="song-timeline" type="range" min="0" max={playerDuration || 1} step="0.1" value={Math.min(playerDuration || 1, playerElapsed)} aria-label="Mini player timeline" aria-valuetext={`${time(playerElapsed)} of ${time(playerDuration)}`} disabled={!canSeek} onChange={event => previewSeek(Number(event.target.value))} onPointerUp={event => seekTo(event.currentTarget.value)} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) seekTo(event.currentTarget.value); }} onBlur={event => seekTo(event.currentTarget.value)} /><span>{time(playerDuration)}</span></div>
      <div className="mini-player-controls">
        <button type="button" className="device-picker-button mini-player-sound" onClick={() => openAdaptation(undefined, { applyNow: true })} disabled={busy} aria-label={`Playback sound: ${soundName}. Change playback sound`} title={`Playback sound: ${soundName}`}><Icon name="piano" /></button>
        <button type="button" ref={queueTrigger} className={`device-picker-button mini-player-queue ${queueVisible ? 'is-open' : ''}`} aria-label={`${queueVisible ? 'Hide' : 'Show'} queue, ${queueIds.length} ${queueIds.length === 1 ? 'song' : 'songs'}`} title={queueVisible ? 'Hide queue' : 'Show queue'} aria-expanded={queueVisible} aria-controls="queue-panel" onClick={() => setQueueVisible(!queueVisible)} onDragEnter={event => { if (carriesSong(event)) setQueueVisible(true, { animate: false }); }}><Icon name="queue" />{queueIds.length > 0 && <span className="queue-count" aria-hidden="true">{queueIds.length}</span>}</button>
        <DevicePicker {...pickerProps} />
        <button className="mini-player-play" aria-label={isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'} disabled={isPlaying ? !onDevice && busy : !canPlay} onClick={() => isPlaying ? playerPause() : playerPlay()}>{onDevice && local.loading ? <span className="spinner" /> : <Icon name={isPlaying ? 'pause' : 'play'} />}</button>
        {canNext && <button className="icon-button" aria-label="Next song" title="Next song" onClick={() => playerSkip(1)}><Icon name="next" /></button>}
      </div>
    </section>}
    <nav className="mobile-dock" aria-label="Main navigation">
      {[['player', 'Player', 'play'], ['all', 'All songs', 'grid'], ['favorites', 'Favorites', 'heart'], ['discover', 'Discover', 'search'], ['sheets', 'Sheet music', 'book']].map(([id, label, icon]) =>
        <button key={id} className={view === id ? 'active' : ''} aria-label={label} title={label} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} />{id === 'sheets' && <span className="nav-wip">WIP</span>}</button>
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
      {soundReport?.notice && adaptationSongId && adaptationSongId === status?.song_id && <p className="adaptation-report">{soundReport.notice}</p>}
      <p className="dialog-hint">Choose which MIDI parts reach the piano. Saved songs and downloaded files keep their original notes.</p>
      {adaptationLoading ? <p className="dialog-hint" role="status"><span className="spinner" /> Checking song parts…</p> : <>
        <fieldset className="adaptation-modes">
          <legend className="dialog-label">Play this way</legend>
          {[
            ['no_drums', 'All parts except drums · Default', 'Play every instrument part except drums. Keep the original notes, timing, and dynamics.'],
            ['original', 'Original MIDI', 'All parts, including drums, as they are in the file.'],
            ['piano', 'Piano parts only', 'Keep parts marked as piano; leave the other instruments out.'],
            ['smart', 'Smart piano · Experimental', 'Choose suitable parts and merge their notes into one piano track. Experimental.'],
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
      <p className="dialog-hint">All playback choices are saved for this song and restored whenever it plays. With no song selected, you set the default for songs without saved settings.</p><p className="adaptation-stop-note">{dialog.applyNow ? 'Applying a change stops playback. Press Play afterward.' : 'Saves to this song for its next playback. The current player keeps playing.'}</p>
      <div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => { adaptationRequest.current += 1; setDialog(null); }}>Cancel</button><button className="btn" disabled={busy || adaptationLoading || !adaptationData || adaptationMode === 'custom' && (!adaptationSongId || !adaptationParts.length) || adaptationMode === 'piano' && !!adaptationSongId && !hasPianoParts} onClick={applyAdaptation}>{dialog.applyNow ? 'Apply sound' : 'Save settings'}</button></div>
    </Dialog>}

    {dialog?.type === 'connection' && <Dialog title="Connect to a device" onClose={() => setDialog(null)}><div className="device-dialog-list"><DeviceOptions current={currentEntry} others={otherEntries} playing={isPlaying} emptyNote={noPianoNote} onChoose={chooseDevice} /></div><div className="dialog-actions"><button className="btn light small" onClick={refresh}>Refresh devices</button><button className="btn small" disabled={busy || !wanted} onClick={() => run(() => post('/api/reconnect', { name: wanted }), 'Reconnecting your piano. Press Play once it is connected.')}>Reconnect piano</button></div><p className="dialog-hint" style={{ marginTop: 18 }}>We remember your piano and reconnect when its MIDI connection returns. Playback starts only when you press play.</p><p className="dialog-hint">If another app used the piano, disconnect it there first, then press Reconnect piano. {status?.platform === 'linux' ? 'On Raspberry Pi, choose your piano from the device list and press Reconnect piano. Keep it disconnected from other apps, or use USB.' : 'On your Mac, open Audio MIDI Setup → MIDI Studio → Bluetooth, then connect to Prodigy2 MIDI. Keep the Mac connected, or use USB.'}</p><p className="dialog-hint">{preferred ? `Remembered piano: ${preferred}. ` : ''}{status?.bluetooth?.message || ''}</p><div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {['create', 'rename'].includes(dialog?.type) && <Dialog title={dialog.type === 'rename' ? 'Rename library' : 'A library of your own'} onClose={() => setDialog(null)}><form onSubmit={async event => {
      event.preventDefault();
      const name = libraryName.trim();
      if (!name) return;
      const result = await run(() => post('/api/library', { action: dialog.type === 'rename' ? 'rename' : 'create', name, library_id: dialog.libraryId }));
      if (result) setDialog(null);
    }}><label htmlFor="libraryName" className="dialog-label">Library name</label><input id="libraryName" className="field" placeholder="Quiet mornings" required maxLength="80" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus /><div className="dialog-actions"><button type="button" className="btn light" onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>{dialog.type === 'rename' ? 'Save name' : 'Create library'}</button></div></form></Dialog>}
    {dialog?.type === 'assign' && <Dialog title="Save to a library" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p>{library.libraries.length ? library.libraries.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy} checked={(assignedSong?.library_ids || []).includes(item.id)} onChange={event => run(() => post('/api/library', { action: 'assign', song_id: assignedSong.id, library_id: item.id, value: event.target.checked }))} /><span>{item.name}</span></label>) : <p className="dialog-hint">Create a library with the + button in the sidebar first.</p>}<div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {dialog?.type === 'rename_song' && <Dialog title="Edit song" closeDisabled={busy} onClose={() => setDialog(null)}><form onSubmit={async event => {
      event.preventDefault();
      const result = await run(() => post('/api/library', { action: 'edit_song', song_id: dialog.songId, name: libraryName.trim(), artist: songArtist.trim(), album: songAlbum.trim() }), 'Song updated.');
      if (result) setDialog(null);
    }}><label htmlFor="songName" className="dialog-label">Song name</label><input id="songName" className="field" required maxLength="200" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus /><div className="song-edit-fields"><label htmlFor="songArtist" className="dialog-label">Artist</label><input id="songArtist" className="field" maxLength="200" placeholder="Artist or composer" value={songArtist} disabled={busy} onChange={event => setSongArtist(event.target.value)} /><label htmlFor="songAlbum" className="dialog-label">Album</label><input id="songAlbum" className="field" maxLength="200" placeholder="Album title (optional)" value={songAlbum} disabled={busy} onChange={event => setSongAlbum(event.target.value)} /></div><p className="dialog-hint">Artist and album help find the right cover and Spotify result. Your libraries, queue, favorites, and saved playback settings stay with this song.</p><div className="dialog-actions"><button type="button" className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy || !libraryName.trim()}>Save changes</button></div></form></Dialog>}
    {dialog?.type === 'delete' && <Dialog title="Remove this song?" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p><p className="dialog-hint">This removes the song from All songs, favorites, libraries, and the queue. If it is playing, playback stops. The MIDI is moved to the app’s trash folder, and you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={async () => { const song = assignedSong; const result = await run(() => post('/api/library', { action: 'delete', song_id: song.id })); if (result) { setDialog(null); setNotice({ text: 'Song removed.', success: true, undoSongIds: [song.id] }); } }}>Remove song</button></div></Dialog>}
    {dialog?.type === 'bulk_delete' && <Dialog title={`Remove ${countSongs(dialog.songIds.length)}?`} onClose={() => setDialog(null)}><p className="dialog-hint">This removes them from All songs, favorites, libraries, and the queue. If one is playing, playback stops. The MIDI files are moved to the app’s trash folder, and you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => deleteSongs(dialog.songIds)}>Remove {countSongs(dialog.songIds.length)}</button></div></Dialog>}
    {dialog?.type === 'bulk_assign' && <Dialog title="Add to a library" onClose={() => setDialog(null)}><p className="dialog-hint">{countSongs(dialog.songIds.length)} selected</p>{library.libraries.length ? <div className="bulk-library-list">{library.libraries.map(item => <button key={item.id} type="button" className="bulk-library" disabled={busy} onClick={() => addSongsToLibrary(dialog.songIds, item)}><Icon name="folder" /><span>{item.name}</span></button>)}</div> : <p className="dialog-hint">Create a library with the + button in the sidebar first.</p>}<div className="dialog-actions"><button className="btn light" onClick={() => setDialog(null)}>Cancel</button></div></Dialog>}
    {menuSong && <ContextMenu x={songMenu.x} y={songMenu.y} label={`Actions for ${menuSong.name}`} items={songMenu.kind === 'queue' ? queueMenuItems(songMenu.index) : songMenuItems(menuSong)} onClose={closeSongMenu} />}
    {dialog?.type === 'remote' && <Dialog title="Music, from anywhere in the room." onClose={() => setDialog(null)}><p className="dialog-hint">Open this private link on a phone or another computer on the same office Wi-Fi. The piano computer sends the music and must stay awake.</p><a className="dialog-hint" style={{ display: 'block' }} href={status?.remote || '#'}>{status?.remote || 'Waiting for the piano connection…'}</a><div className="dialog-actions"><button className="btn" onClick={async () => {
      try { if (!status?.remote) throw Error(); await navigator.clipboard.writeText(status.remote); setCopied(true); }
      catch { announce('Select and copy the private link in the Wi-Fi dialog.'); }
    }}><Icon name="link" />{copied ? 'Copied ✓' : 'Copy remote link'}</button></div></Dialog>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource/dm-sans/300.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-mono/400.css';
import './styles.css';
import { SortableList, SortableItem } from './SortableList.jsx';
import { groupSheetSongs } from './sheetGroups.mjs';
import { applyQueueAction, readDeviceQueue } from './deviceQueue.mjs';
import SheetBookDialog, { analysisProgressText } from './SheetBookDialog.jsx';
import { useLocalListener } from './useLocalListener.mjs';
import { parseMidi } from './localPiano.mjs';
import { songClock, syncClock } from './fallingNotes.mjs';
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
    return url.protocol === 'https:' && ['bitmidi.com', 'www.bitmidi.com', 'freemidi.org', 'www.freemidi.org', 'bushgrafts.com', 'www.bushgrafts.com', 'kunstderfuge.com', 'www.kunstderfuge.com', 'magenta.withgoogle.com', 'zzaj.web.fc2.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
};

const sourceDescriptions = {
  all: 'All four catalogs: popular songs, jazz piano performances, and classical music.',
  both: 'BitMidi and FreeMidi: popular songs, games, and mixed-instrument arrangements.',
  bitmidi: 'BitMidi: popular songs and game music.',
  freemidi: 'FreeMidi: songs across many artists and genres.',
  bushgrafts: 'Bushgrafts: Doug McKenzie’s jazz piano performances, including solo, duet, and trio recordings.',
  kunstderfuge: 'Kunst der Fuge: classical music by composer, including piano works and other instruments. Download limits may apply.',
  maestro: 'MAESTRO: about 1,300 concert performances recorded on Yamaha Disklavier pianos, stored on this computer. By Google Magenta, CC BY-NC-SA 4.0.',
  zzaj: 'zzaj: about 100 jazz standards and originals as backing tracks with piano, bass, and a lead line, from the zzaj lead-sheet collection (zzaj.web.fc2.com).',
};
const sourceLabels = { bitmidi: 'BitMidi', freemidi: 'FreeMidi', bushgrafts: 'Bushgrafts', kunstderfuge: 'Kunst der Fuge', maestro: 'MAESTRO', zzaj: 'zzaj' };
const sourceKinds = { bushgrafts: 'Jazz', kunstderfuge: 'Classical', maestro: 'Classical performances', zzaj: 'Jazz standards' };
const SOURCE_IDS = ['bitmidi', 'freemidi', 'bushgrafts', 'kunstderfuge', 'maestro', 'zzaj'];
// Selections saved when these were every source; new sources join them.
const LEGACY_ALL_SOURCES = ['bitmidi,freemidi,bushgrafts,kunstderfuge', 'bitmidi,freemidi,bushgrafts,kunstderfuge,maestro'];
const providerName = source => {
  try {
    const host = new URL(source).hostname.replace(/^www\./, '');
    return sourceLabels[{ 'bitmidi.com': 'bitmidi', 'freemidi.org': 'freemidi', 'bushgrafts.com': 'bushgrafts', 'kunstderfuge.com': 'kunstderfuge', 'magenta.withgoogle.com': 'maestro', 'zzaj.web.fc2.com': 'zzaj' }[host]] || 'MIDI source';
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
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z M12 5v15" /></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    wifi: <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0" /><circle cx="12" cy="20" r=".5" fill="currentColor" /></>,
    next: <><path d="m6 5 10 7-10 7Z" fill="currentColor" /><path d="M18 5v14" /></>,
    previous: <><path d="m18 5-10 7 10 7Z" fill="currentColor" /><path d="M6 5v14" /></>,
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
    queue: <path d="M4 6h12M4 12h12M4 18h8m8-3v6l-4-3Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    devices: <><rect x="3" y="3" width="11" height="18" rx="2" /><circle cx="8.5" cy="14" r="3" /><path d="M8.5 7h.01M17 7h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3" /></>,
    laptop: <path d="M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1ZM2 19h20" />,
    quiet: <><path d="M20.2 3.8a6 6 0 0 0-8.5 0L5 10.5V19h8.5l6.7-6.7a6 6 0 0 0 0-8.5Z" /><path d="M16 8 2 22M17.5 15H9" /></>,
    expressive: <path d="M3 18c3 0 4-12 7-12s3 9 5 9 2-5 6-5" />,
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
    <div className="dialog-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" title="Close" disabled={closeDisabled} onClick={onClose}><Icon name="close" /></button></div>
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

function DevicePicker({ current, others, playing, onChoose, onSettings, emptyNote }) {
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
    <button type="button" className={`device-picker-button ${open ? 'is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId} aria-label={`Playing on ${current.name}. Connect to a device`} title="Connect to a device" onClick={() => setOpen(value => !value)}><Icon name="devices" /></button>
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

function NewLibraryRow({ busy, onCreate }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) return <button type="button" className="bulk-library new-library" disabled={busy} onClick={() => setOpen(true)}><Icon name="plus" /><span>New playlist</span></button>;
  const submit = async () => { if (name.trim() && await onCreate(name.trim())) { setName(''); setOpen(false); } };
  return <div className="new-library-form">
    <input className="field" aria-label="New playlist name" placeholder="Playlist name" maxLength="80" value={name} disabled={busy} autoFocus onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
    <button type="button" className="btn" disabled={busy || !name.trim()} onClick={submit}>Create</button>
  </div>;
}

function EmptyState({ icon = 'note', title, description, button, onClick }) {
  return <div className="empty"><Icon name={icon} /><h3>{title}</h3><p>{description}</p>{button && <button className="btn light" onClick={onClick}>{button}</button>}</div>;
}

const NEW_PLAYLIST = '__new_playlist__';

function SearchResult({ result, libraries, busy, onSave, notice }) {
  const [destination, setDestination] = useState('');
  const [newPlaylist, setNewPlaylist] = useState('');
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
    const success = await onSave(result, destination === NEW_PLAYLIST ? { newPlaylist: newPlaylist.trim() } : { libraryId: destination });
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
          <option value={NEW_PLAYLIST}>New playlist…</option>
        </select>
        {destination === NEW_PLAYLIST && <><label className="dialog-label" htmlFor={`${destinationId}-name`}>Playlist name</label><input id={`${destinationId}-name`} className="field" required maxLength="80" placeholder="Quiet mornings" value={newPlaylist} disabled={saving} autoFocus onChange={event => setNewPlaylist(event.target.value)} /></>}
        <p className="dialog-hint">Next, you can add the artist, album, and cover.</p>
        {attempted && notice && !notice.success && <p className="message visible" role="alert">{notice.text}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn light" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn" disabled={busy || saving || destination === NEW_PLAYLIST && !newPlaylist.trim()}>{saving ? <><span className="spinner" /> Saving</> : 'Save song'}</button>
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
  const [brokenCovers, setBrokenCovers] = useState(() => new Set());
  const [itunes, setItunes] = useState({ query: '', results: null, loading: false, error: '', chosen: -1 });
  const [songCover, setSongCover] = useState('');
  const itunesRequest = useRef(0);
  // Covers saved by automatic recognition, at Apple's small size for list rows.
  const coverFor = song => !brokenCovers.has(song.id) && typeof song.recognition?.artwork === 'string' ? song.recognition.artwork.replace(/\/600x600bb\.(jpg|png)$/i, '/100x100bb.$1') : '';
  const [betaOpen, setBetaOpen] = useState(() => storage.get('piano-beta-open') === 'on');
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
  // Ticked catalogs, sent as one comma-separated source; older single choices carry over.
  const [searchSources, setSearchSources] = useState(() => {
    const saved = storage.get('piano-search-sources') || storage.get('piano-search-source');
    const list = saved === 'all' || !saved || LEGACY_ALL_SOURCES.includes(saved) ? SOURCE_IDS : saved === 'both' ? ['bitmidi', 'freemidi'] : saved.split(',').filter(id => SOURCE_IDS.includes(id));
    return list.length ? list : SOURCE_IDS;
  });
  const searchSource = searchSources.length === SOURCE_IDS.length ? 'all' : searchSources.join(',');
  const [searchData, setSearchData] = useState({ results: [], page: 0, query: '', hasMore: false, checked: 0, searched: false, source: searchSource, warnings: [], notes: [] });
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
  // Messages close themselves: confirmations after 5 s, errors and undo offers after 10 s, paused while hovered.
  const [noticePaused, setNoticePaused] = useState(false);
  useEffect(() => {
    if (!notice) return setNoticePaused(false);
    if (noticePaused) return;
    const lingers = !notice.success || notice.undoSongIds || notice.undoSheetId || notice.undoPlaylist;
    const timer = setTimeout(() => setNotice(null), lingers ? 10000 : 5000);
    return () => clearTimeout(timer);
  }, [notice, noticePaused]);
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
    const response = await fetch(`/api/song-playback?song_id=${encodeURIComponent(songId)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Piano-Client': clientId } });
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch {}
      throw Error(data?.error || 'Could not load this song.');
    }
    return response.arrayBuffer();
  }, [key, clientId]);
  const [output, setOutput] = useState(() => storage.get('piano-output') === 'device' ? 'device' : 'piano');
  const [deviceQueue, setDeviceQueue] = useState(() => readDeviceQueue(storage.get('piano-device-queue')));
  const deviceQueueRef = useRef(deviceQueue);
  const advanceLocal = useRef(null);
  // Device playback and falling notes use the song's playback sound, like the piano.
  const parsedSongs = useRef(new Map());
  const [soundVersion, setSoundVersion] = useState(0);
  const loadSongNotes = useCallback(songId => {
    const cache = parsedSongs.current;
    if (!cache.has(songId)) {
      cache.set(songId, fetchSongFile(songId).then(parseMidi).catch(error => { cache.delete(songId); throw error; }));
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return cache.get(songId);
  }, [fetchSongFile, soundVersion]);
  const local = useLocalListener(loadSongNotes, () => advanceLocal.current?.());
  const [showNotes, setShowNotes] = useState(() => storage.get('piano-falling-notes') === 'on');
  const pianoClock = useRef({ seconds: 0, playing: false, at: 0, rate: 1, songId: '' });
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueDocked, setQueueDocked] = useState(() => storage.get('piano-queue-panel') !== 'hidden');
  const [wideQueue, setWideQueue] = useState(() => window.matchMedia(WIDE_QUEUE).matches);
  const [draggingSong, setDraggingSong] = useState('');
  const [queueDrop, setQueueDrop] = useState(null);
  const [libraryDrop, setLibraryDrop] = useState('');
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
    if (index !== null && deviceQueueRef.current.song_ids[index] === song.id) changeDeviceQueue({ action: 'select', index });
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
    // The search field morphs between song lists and Discover; the wider version stays visible while it resizes.
    const hasSongSearch = page => !['player', 'discover', 'sheets'].includes(page);
    document.documentElement.dataset.searchMorph = next === 'discover' && hasSongSearch(viewRef.current) ? 'grow' : viewRef.current === 'discover' && hasSongSearch(next) ? 'shrink' : '';
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
  function changeDeviceQueue(request) {
    const { queue: next, stop } = applyQueueAction(deviceQueueRef.current, request);
    deviceQueueRef.current = next;
    setDeviceQueue(next);
    storage.set('piano-device-queue', JSON.stringify(next));
    if (stop) local.stop();
    return { ok: true, queue: next };
  }
  // This device keeps its own queue, so listening here never changes what the piano plays next.
  const queuePost = (data, target = output) => target === 'device' ? Promise.resolve().then(() => changeDeviceQueue(data)) : post('/api/queue', data);
  async function queueAction(action, payload = {}, success = '', showPlayer = false, target = output) {
    const result = await run(() => {
      const data = { action, ...payload };
      if (action === 'play') data.device = requireDevice();
      return queuePost(data, target);
    }, success);
    if (result && showPlayer) navigate('player');
    return result;
  }
  const control = action => run(() => post('/api/control', { action, device: Number(device?.id || 0) }));
  const onDevice = output === 'device';
  const queue = onDevice ? deviceQueue : status?.queue || { song_ids: [], index: -1 };
  const queueIds = queue.song_ids || [];
  const queueIndex = Number.isInteger(queue.index) ? queue.index : -1;
  const playing = !!status?.playing;
  const current = library.songs.find(song => song.id === status?.song_id);
  const deviceIndex = deviceQueue.song_ids.length ? deviceQueue.index : -1;
  const deviceSong = local.song ? library.songs.find(song => song.id === local.song.id) || local.song : library.songs.find(song => song.id === deviceQueue.song_ids[deviceIndex]);
  const playerSong = onDevice ? deviceSong : current;
  const playerName = onDevice ? deviceSong?.name || '' : status?.name || '';
  const playerSongId = onDevice ? deviceSong?.id || '' : status?.song_id || '';
  const activeIndex = onDevice ? deviceIndex : queueIndex;
  const isPlaying = onDevice ? local.state === 'playing' : playing;
  const isPaused = onDevice ? local.state === 'paused' : !!status?.paused;
  const songAt = index => library.songs.find(song => song.id === queueIds[index]);
  advanceLocal.current = async () => {
    if (!onDevice || deviceIndex < 0 || !songAt(deviceIndex)) return;
    const finished = deviceIndex;
    const next = songAt(finished + 1);
    try {
      changeDeviceQueue({ action: 'finish', index: finished, song_id: queueIds[finished] });
    } catch (error) {
      announce(error.message);
      return;
    }
    if (next) await listenHere(next, finished);
    refresh();
  };
  const artworkMatches = !onDevice || playerSongId === status?.song_id;
  const savedCover = typeof playerSong?.recognition?.artwork === 'string' ? playerSong.recognition.artwork : '';
  const artworkUrl = savedCover || (artworkMatches && status?.name && typeof status?.artwork?.url === 'string' ? status.artwork.url : '');
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
    const previous = pianoClock.current;
    const reported = { seconds: status?.seconds || 0, playing: !!status?.playing && !status?.paused };
    const synced = previous.songId === status?.song_id ? syncClock(previous, reported, performance.now()) : { ...reported, at: performance.now(), rate: 1 };
    pianoClock.current = { ...synced, songId: status?.song_id };
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
  const spaceToggle = useRef(null);
  spaceToggle.current = () => {
    if (isPlaying) { if (onDevice || !busy) playerPause(); }
    else if (canPlay) playerPlay();
  };
  useEffect(() => {
    // Space toggles playback unless a field, control or dialog should receive it.
    const keyDown = event => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.target.closest?.('input, textarea, select, button, a, [contenteditable], [role="button"], [role="slider"], [role="menu"], [role="dialog"], dialog')) return;
      event.preventDefault();
      spaceToggle.current();
    };
    document.addEventListener('keydown', keyDown);
    return () => document.removeEventListener('keydown', keyDown);
  }, []);
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
    let index = queueIds.length ? deviceIndex : -1;
    if (index < 0 || queueIds[index] !== song.id) {
      // Match piano playback: the song takes the Now playing slot and the rest of the queue stays.
      const result = await queueAction('replace_current', index >= 0 ? { song_id: song.id, index, expected_song_ids: queueIds } : { song_id: song.id });
      if (!result) return;
      if (index < 0) index = result.queue.index;
    }
    if (showPlayer) navigate('player');
    await listenHere(song, index);
  }
  function chooseOutput(next) {
    if (next === output) return;
    // Someone may be listening to the piano, so ask before taking its song away.
    if (next === 'device' && playing && current) return setDialog({ type: 'take_song' });
    return switchOutput(next);
  }
  async function switchOutput(next, takeSong = false) {
    setOutput(next);
    storage.set('piano-output', next);
    setSeekPreview(null);
    if (next === 'device') {
      if (!takeSong || !current) return;
      const song = current, at = status?.seconds || 0;
      const placed = await queueAction('replace_current', { song_id: song.id }, '', false, 'device');
      if (!placed || !await control('pause')) return;
      await listenHere(song, placed.queue.index, at);
      return;
    }
    // Leaving this computer stops its playback; the piano never starts on its own.
    local.stop();
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
  const pickerProps = { current: currentEntry, others: otherEntries, playing: isPlaying, onChoose: chooseDevice, onSettings: openConnection, emptyNote: noPianoNote };
  const selectedLibrary = library.libraries.find(item => item.id === view);
  const sidebarLibraries = [...library.libraries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
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
    // Show the new order right away so the row stays where it was dropped; refresh() restores the saved order if the request fails.
    if (drag.kind === 'queue') {
      const songIds = reorderedSongIds(originalIds, originalIds, drag.from, drag.to);
      if (output !== 'device') setStatus(previous => previous && { ...previous, queue: { ...previous.queue, song_ids: songIds } });
      await runTask.current(() => queuePost({ action: 'move', from: drag.from, to: drag.to, expected_song_ids: originalIds }));
    } else {
      const fullOrder = reorderedSongIds(now.fullIds, originalIds, drag.from, drag.to);
      setLibrary(previous => now.libraryId
        ? { ...previous, libraries: previous.libraries.map(item => item.id === now.libraryId ? { ...item, song_ids: fullOrder } : item) }
        : { ...previous, songs: fullOrder.map(id => previous.songs.find(song => song.id === id)).filter(Boolean) });
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
      const songs = [];
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
          if (data.song) songs.push(data.song);
          if (data.warning) warnings.push(`${file.name}: ${data.warning}`);
        } catch (error) {
          failures.push(`${file.name}: ${error.message || 'Could not save this file.'}`);
        }
      }
      return { ok: true, saved, failures, warnings, songs };
    });
    if (result) {
      let summary = `Saved ${result.saved} ${result.saved === 1 ? 'song' : 'songs'}${destination ? ` to ${destination.name}` : ''}.`;
      if (result.failures.length) summary += ` Could not save: ${result.failures.join('; ')}`;
      if (result.warnings.length) summary += ` ${result.warnings.join('; ')}`;
      announce(summary, !result.failures.length && !result.warnings.length);
      if (result.songs.length) startEditDetails(result.songs);
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
      setSearchData(previous => ({ results: more ? previous.results.concat(data.results || []) : data.results || [], page, query: text, hasMore: !!data.has_more, checked: data.checked || 0, totalMatches: data.total_matches, searched: true, source, warnings: Array.isArray(data.warnings) ? data.warnings : [], notes: Array.isArray(data.notes) ? data.notes : [] }));
    } catch (error) {
      if (error.name !== 'AbortError' && generation === searchGeneration.current) announce(error.message);
    } finally { if (generation === searchGeneration.current) setSearching(false); }
  }

  function toggleSearchSource(id) {
    const next = searchSources.includes(id) ? searchSources.filter(item => item !== id) : SOURCE_IDS.filter(item => item === id || searchSources.includes(item));
    if (!next.length) return;
    searchController.current?.abort();
    searchGeneration.current += 1;
    setSearching(false);
    setSearchSources(next);
    storage.set('piano-search-sources', next.join(','));
    const source = next.length === SOURCE_IDS.length ? 'all' : next.join(',');
    setSearchData({ results: [], page: 0, query: '', hasMore: false, checked: 0, searched: false, source, warnings: [], notes: [] });
  }

  async function saveResult(result, { libraryId = '', newPlaylist = '' }) {
    const existing = library.libraries.find(item => item.id === libraryId);
    const saved = await run(async () => {
      const imported = await post('/api/import', { url: result.url });
      acceptLibrary(imported.library);
      let targetId = existing?.id || '';
      if (newPlaylist) {
        const created = await post('/api/library', { action: 'create', name: newPlaylist });
        acceptLibrary(created.library);
        targetId = created.library?.libraries?.find(item => item.name === newPlaylist)?.id || '';
        if (!targetId) throw Error('The new playlist could not be found.');
      }
      if (targetId) {
        const assigned = await post('/api/library', { action: 'assign', song_id: imported.song.id, library_id: targetId, value: true });
        imported.library = assigned.library;
      }
      return imported;
    }, newPlaylist ? `Saved to ${newPlaylist}.` : existing ? `Saved to ${existing.name}.` : 'Saved to All songs.');
    const song = saved?.library?.songs?.find(item => item.id === saved.song?.id);
    if (song) startEditDetails([song]);
    return !!saved;
  }

  async function openAdaptation(requestedSongId, { applyNow = view === 'player' } = {}) {
    // The player's buttons edit the song it shows; on this computer that song isn't loaded on the piano,
    // so the server only saves the setting and this device stops its playback when it's applied.
    const fromPlayer = typeof requestedSongId !== 'string';
    const songId = fromPlayer ? (onDevice ? deviceSong?.id : status?.song_id) || '' : requestedSongId;
    const stopsDevice = fromPlayer && onDevice && applyNow;
    setAdaptationExpectedSongId(status?.song_id || '');
    const request = ++adaptationRequest.current;
    setAdaptationSongId(songId);
    setAdaptationData(null);
    setAdaptationLoading(true);
    setAdaptationError('');
    setAdaptationAttempted(false);
    setAdaptationMode(status?.adaptation?.settings?.mode || 'no_drums');
    setAdaptationParts([]);
    setDialog({ type: 'adaptation', applyNow: applyNow && !stopsDevice, stopsDevice });
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
      parsedSongs.current.clear();
      local.forget();
      setSoundVersion(version => version + 1);
      if (dialog?.stopsDevice && local.song?.id === adaptationSongId) local.stop();
    }
  }

  async function togglePlaybackOption(path, key) {
    const enabled = !soundSettings[key];
    const result = await run(() => post(path, { enabled, expected_song_id: status?.song_id || '' }));
    if (!result) return;
    parsedSongs.current.clear();
    setSoundVersion(version => version + 1);
    // This device plays its own rendered copy; swap it in at the same place.
    try { await local.reload(); } catch (error) { local.stop(); announce(error.message); }
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
    if (stack.some(element => element.closest?.('.mini-player-queue'))) return { button: true };
    const inside = stack.find(element => element.closest?.('#queue-panel'));
    return inside ? queueDropTarget({ target: inside, clientY: point.y }) : null;
  }
  const selectedIds = selected.filter(id => library.songs.some(song => song.id === id));
  // Dragging one of several checked songs carries all of them, in list order.
  const draggedSongIds = songId => selectedIds.length > 1 && selectedIds.includes(songId) ? [...selectedIds].sort((a, b) => savedOrder.indexOf(a) - savedOrder.indexOf(b)) : [songId];
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
      const songIds = draggedSongIds(songId);
      if (target?.library) {
        const destination = library.libraries.find(item => item.id === target.library);
        return songIds.length > 1 ? destination && addSongsToLibrary(songIds, destination) : addToLibrary(songId, target.library);
      }
      if (!target) return;
      const expected = queueIds;
      eachSong(songIds.map((id, offset) => ({ id, offset })), ({ id, offset }) => queuePost(target.button ? { action: 'add', song_id: id }
        : offset ? { action: 'add', song_id: id, index: target.index + offset } : { action: 'add', song_id: id, index: target.index, expected_song_ids: expected }),
      songIds.length > 1 ? `Added ${countSongs(songIds.length)} to the queue.` : 'Added to the queue.');
    },
    outsideHint: draggingSong && draggedSongIds(draggingSong).length > 1 ? `Drop to add ${draggedSongIds(draggingSong).length} songs here` : 'Drop to add it here',
  };

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
  const addSongsToQueue = songIds => eachSong(songIds, songId => queuePost({ action: 'add', song_id: songId }), `Added ${countSongs(songIds.length)} to the queue.`);
  const favoriteSongs = (songIds, value) => eachSong(songIds, songId => post('/api/library', { action: 'favorite', song_id: songId, value }), value ? `Added ${countSongs(songIds.length)} to favorites.` : `Removed ${countSongs(songIds.length)} from favorites.`);
  async function addSongsToLibrary(songIds, item) {
    const missing = songIds.filter(songId => !(library.songs.find(song => song.id === songId)?.library_ids || []).includes(item.id));
    if (!missing.length) return announce(`Already in ${item.name}.`, true);
    const result = await eachSong(missing, songId => post('/api/library', { action: 'assign', song_id: songId, library_id: item.id, value: true }), `Added ${countSongs(missing.length)} to ${item.name}.`);
    if (result) setDialog(null);
  }
  async function removeFromLibrary(songIds, item) {
    const order = [...item.song_ids];
    const result = await eachSong(songIds, songId => post('/api/library', { action: 'assign', song_id: songId, library_id: item.id, value: false }));
    if (!result) return;
    setSelected(previous => previous.filter(id => !songIds.includes(id)));
    setNotice({ text: `Removed ${countSongs(songIds.length)} from ${item.name}.`, success: true, undoPlaylist: { item, songIds, order } });
  }
  async function undoRemoveFromLibrary({ item, songIds, order }) {
    await run(async () => {
      let data = null;
      for (const songId of songIds) data = await post('/api/library', { action: 'assign', song_id: songId, library_id: item.id, value: true });
      // Put the songs back where they were; anything added since keeps its place after them.
      const current = data.library.libraries.find(entry => entry.id === item.id)?.song_ids || [];
      const restored = [...order.filter(id => current.includes(id)), ...current.filter(id => !order.includes(id))];
      return post('/api/library', { action: 'reorder', library_id: item.id, song_ids: restored });
    }, `Restored ${countSongs(songIds.length)} to ${item.name}.`);
  }
  async function createLibraryWith(name, songIds) {
    return run(async () => {
      let data = await post('/api/library', { action: 'create', name });
      const created = data.library?.libraries?.find(item => item.name === name);
      if (!created) throw Error('The new playlist could not be found.');
      for (const songId of songIds) data = await post('/api/library', { action: 'assign', song_id: songId, library_id: created.id, value: true });
      return data;
    }, songIds.length ? `Created ${name} with ${countSongs(songIds.length)}.` : `Created ${name}.`);
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
        { label: 'Add to playlist…', icon: 'folder', disabled: busy, onSelect: () => setDialog({ type: 'bulk_assign', songIds: ids }) },
        selectedLibrary && { label: `Remove ${countSongs(ids.length)} from ${selectedLibrary.name}`, icon: 'close', disabled: busy, onSelect: () => removeFromLibrary(ids, selectedLibrary) },
        { separator: true, key: 'danger' },
        { label: `Delete ${countSongs(ids.length)}…`, icon: 'trash', danger: true, disabled: busy, onSelect: () => setDialog({ type: 'bulk_delete', songIds: ids }) },
      ];
    }
    return [
      { label: 'Play', icon: 'play', disabled: onDevice ? local.loading : busy, onSelect: () => playSong(song, { showPlayer: false }) },
      { label: 'Add to queue', icon: 'plus', disabled: busy, onSelect: () => queueAction('add', { song_id: song.id }, 'Added to the Player queue.') },
      { label: song.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => run(() => post('/api/library', { action: 'favorite', song_id: song.id, value: !song.favorite })) },
      { label: 'Add to playlist…', icon: 'folder', onSelect: () => setDialog({ type: 'assign', songId: song.id }) },
      selectedLibrary && { label: `Remove from ${selectedLibrary.name}`, icon: 'close', disabled: busy, onSelect: () => removeFromLibrary([song.id], selectedLibrary) },
      { separator: true, key: 'settings' },
      { label: 'Playback sound…', icon: 'piano', disabled: busy, onSelect: () => openAdaptation(song.id) },
      { label: 'Edit details…', icon: 'edit', disabled: busy, onSelect: () => startEditDetails([song]) },
      { label: 'Download MIDI', icon: 'download', onSelect: () => download(song) },
      song.source_kind === 'sheet' && { label: 'Download editable score', icon: 'book', onSelect: () => downloadRecognizedScore(song) },
      { separator: true, key: 'danger' },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: busy, onSelect: () => setDialog({ type: 'delete', songId: song.id }) },
    ];
  }
  const librarySongIds = item => item.song_ids.filter(id => library.songs.some(song => song.id === id));
  async function playSongIds(ids) {
    const result = await queueAction('replace', { song_ids: ids });
    if (!result) return;
    const first = library.songs.find(song => song.id === ids[0]);
    if (onDevice) return listenHere(first, 0);
    return queueAction('play', { index: 0 });
  }
  function libraryMenuItems(item) {
    const ids = librarySongIds(item);
    return [
      { label: 'Play', icon: 'play', disabled: !ids.length || (onDevice ? local.loading : busy), onSelect: () => playSongIds(ids) },
      { label: 'Add to queue', icon: 'plus', disabled: !ids.length || busy, onSelect: () => addSongsToQueue(ids) },
      { label: 'Open', icon: 'folder', onSelect: () => navigate(item.id) },
      { separator: true, key: 'manage' },
      { label: 'Rename…', icon: 'edit', disabled: busy, onSelect: () => { setLibraryName(item.name); setDialog({ type: 'rename', libraryId: item.id }); } },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: busy, onSelect: () => setDialog({ type: 'delete_library', libraryId: item.id }) },
    ];
  }
  function openLibraryMenu(event, item) {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const keyboard = !event.clientX && !event.clientY;
    menuReturn.current = event.currentTarget;
    setSongMenu({ kind: 'library', libraryId: item.id, x: keyboard ? box.left + 24 : event.clientX, y: keyboard ? box.bottom : event.clientY });
  }
  async function deleteLibrary(item) {
    const result = await run(() => post('/api/library', { action: 'delete_library', library_id: item.id }), `Deleted ${item.name}. Its songs are still in All songs.`);
    if (!result) return;
    setDialog(null);
    if (view === item.id) navigate('all');
  }
  const menuLibrary = songMenu?.kind === 'library' ? library.libraries.find(item => item.id === songMenu.libraryId) : null;
  async function searchItunes(query) {
    const request = ++itunesRequest.current;
    setItunes(previous => ({ ...previous, query, loading: true, error: '' }));
    try {
      const data = await api(`/api/itunes-search?q=${encodeURIComponent(query)}`);
      if (request === itunesRequest.current) setItunes({ query, results: data.results, loading: false, error: '', chosen: -1 });
    } catch (error) {
      if (request === itunesRequest.current) setItunes({ query, results: null, loading: false, error: error.message, chosen: -1 });
    }
  }
  // Edit details: the search fills the form; nothing is saved until Save.
  // Uploads open it for each new song in turn; Save or Cancel moves to the next.
  const pendingEdits = useRef([]);
  function startEditDetails(songs) {
    pendingEdits.current = songs.slice(1).map((song, index) => ({ song, step: index + 2, total: songs.length }));
    openEditDetails(songs[0], 1, songs.length);
  }
  function closeEditDetails() {
    itunesRequest.current += 1;
    const next = pendingEdits.current.shift();
    if (next) openEditDetails(next.song, next.step, next.total); else setDialog(null);
  }
  function openEditDetails(song, step = 1, total = 1) {
    itunesRequest.current += 1;
    setLibraryName(songTitle(song.name));
    setSongArtist(song.artist || '');
    setSongAlbum(song.album || '');
    setSongCover(typeof song.recognition?.artwork === 'string' ? song.recognition.artwork : '');
    setItunes({ query: [songTitle(song.name).replace(/[_-]+/g, ' '), song.artist].filter(Boolean).join(' ').slice(0, 120), results: null, loading: false, error: '', chosen: -1 });
    setDialog({ type: 'rename_song', songId: song.id, step, total });
  }
  function chooseResult(result, index) {
    setLibraryName(result.title);
    setSongArtist(result.artist);
    setSongAlbum(result.album);
    setSongCover(result.artwork);
    setItunes(previous => ({ ...previous, chosen: index }));
  }
  const menuSong = songMenu && library.songs.find(song => song.id === songMenu.songId) && (songMenu.kind !== 'queue' || queueIds[songMenu.index] === songMenu.songId) ? library.songs.find(song => song.id === songMenu.songId) : null;

  function renderSavedSongs(songs, groupId) {
    const endSongDrag = () => { setDraggingSong(''); setQueueDrop(null); setLibraryDrop(''); };
    return <SortableList items={songs.map(song => song.id)} getLabel={id => songTitle(library.songs.find(song => song.id === id)?.name)} onStart={from => { startReorder('songs', from, groupId); setDraggingSong(songs[from]?.id || ''); }} onEnd={to => { endSongDrag(); return finishReorder(to); }} onCancel={() => { endSongDrag(); cancelReorder(); }} {...songQueueDrag}>
        <div className="song-list">{!songs.length ? <EmptyState icon={filter ? 'search' : view === 'favorites' ? 'heart' : 'note'} title={filter ? 'No matching pieces' : view === 'favorites' ? 'Keep your favorites close' : 'Make room for a little music.'} description={filter ? 'Try another title.' : view === 'favorites' ? 'Tap the heart beside a saved song to keep it here.' : view === 'sheets' ? 'Upload sheet music above. Converted pieces will appear here.' : 'Upload a MIDI file, or find a new piece in Discover.'} button={filter || view === 'favorites' || view === 'sheets' ? null : 'Discover music'} onClick={() => navigate('discover')} /> : <><div className="list-labels saved-labels"><label className="song-check" title="Select all"><input type="checkbox" aria-label="Select all songs in this list" checked={songs.every(song => selectedIds.includes(song.id))} ref={element => { if (element) element.indeterminate = songs.some(song => selectedIds.includes(song.id)) && !songs.every(song => selectedIds.includes(song.id)); }} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...songs.map(song => song.id)])] : previous.filter(id => !songs.some(song => song.id === id)))} /></label><span /><span>Piece</span><span className="channels-label">Channels</span><span>Time</span><span /></div>{songs.map((song, index) => {
          return <SortableItem key={song.id} id={song.id} disabled={busy}>{rowProps => <div {...rowProps} className={`song-row saved-song ${playerSongId === song.id ? 'is-current' : ''} ${draggingSong === song.id ? 'is-queue-dragging' : ''} ${selectedIds.includes(song.id) ? 'is-selected' : ''}`} onClick={event => songRowClick(event, song)} onContextMenu={event => { event.preventDefault(); openSongMenu(song, event.clientX, event.clientY, event.currentTarget.querySelector('.song-more')); }}><label className="song-check" title={`Select ${song.name}`}><input type="checkbox" checked={selectedIds.includes(song.id)} aria-label={`Select ${song.name}`} onChange={() => toggleSelected(song.id)} /></label><div className="mini-art">{coverFor(song) ? <img className="song-row-icon song-row-cover" src={coverFor(song)} alt="" loading="lazy" onError={() => setBrokenCovers(previous => new Set(previous).add(song.id))} /> : <span className="song-row-icon" aria-hidden="true"><Icon name="note" /></span>}</div><div className="song-info"><button className="song-name song-name-button" title={`Play ${song.name}`} aria-label={`Play ${song.name}`} disabled={onDevice ? local.loading : busy} onClick={() => playSong(song, { showPlayer: false })}>{songTitle(song.name)}</button><div className="song-record">{(song.artist || song.album) && <span className="song-record-text">{[song.artist, song.album].filter(Boolean).join(' · ')}</span>}<span className="song-source">{song.source_url ? `From ${providerName(song.source_url)}` : song.source_kind === 'sheet' ? 'From sheet music' : 'Uploaded'}</span></div>{groupId && (sheets.song_sources || []).filter(source => source.song_id === song.id && source.source_id === groupId).slice(0, 1).map(source => <div key={source.song_id}>{source.pages?.length > 0 && <p className="sheet-song-pages">PDF {source.pages.length === 1 ? 'page' : 'pages'} {source.pages.join(', ')}</p>}{source.warning && <p className="sheet-file-warning">{source.warning}</p>}</div>)}</div><span className="channels" title="MIDI channels that play notes">{song.channels ?? '–'}</span><span className="duration">{time(song.duration_seconds)}</span><button type="button" className="song-more" aria-label={`More actions for ${song.name}`} title="More actions" aria-haspopup="menu" aria-expanded={songMenu?.songId === song.id} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openSongMenu(song, box.right - 200, box.bottom + 4, event.currentTarget); }}><Icon name="more" /></button></div>}</SortableItem>;
        })}</>}</div></SortableList>;
  }

  const hasCurrent = activeIndex >= 0 && !!songAt(activeIndex);
  const nowLabel = 'Now playing';
  const queueSections = [
    { key: 'next', title: 'Next in queue', start: hasCurrent ? activeIndex + 1 : 0, end: queueIds.length },
  ].filter(section => section.end > section.start);
  const queueShown = (hasCurrent ? 1 : 0) + queueSections.reduce((total, section) => total + queueIds.slice(section.start, section.end).filter((_, offset) => songAt(section.start + offset)).length, 0);
  const queueRow = (index, section = null, rowProps = {}) => {
    const song = songAt(index);
    const isCurrent = !section;
    const drop = queueDrop?.row === index ? queueDrop.after ? 'drop-after' : 'drop-before' : '';
    const entry = queueEntryIds[index];
    const picked = queueSelectedKeys.includes(entry);
    return <div {...rowProps} className={`queue-row ${isCurrent ? 'is-current' : ''} ${picked ? 'is-selected' : ''} ${drop}`} role="listitem" data-queue-index={index} data-queue-current={isCurrent ? 'true' : undefined} onClick={event => queueRowClick(event, index, isCurrent)} onContextMenu={event => { event.preventDefault(); openQueueMenu(index, event.clientX, event.clientY, event.currentTarget.querySelector('.song-more')); }}>
      <span className="queue-art">{coverFor(song) ? <img src={coverFor(song)} alt="" loading="lazy" onError={() => setBrokenCovers(previous => new Set(previous).add(song.id))} /> : <Icon name="note" />}{isCurrent && isPlaying && <span className="queue-art-playing"><span className="equalizer" aria-hidden="true"><i /><i /><i /></span></span>}</span>
      <div className="song-info"><div className="song-name" title={song.name}>{songTitle(song.name)}</div><div className="queue-status">{song.artist}</div></div>
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
    const result = await eachSong(ordered, index => queuePost({ action: 'remove', index }), ordered.length > 1 ? `Removed ${countSongs(ordered.length)} from the queue.` : '');
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
        { label: 'Add to playlist…', icon: 'folder', disabled: busy, onSelect: () => setDialog({ type: 'bulk_assign', songIds: queueSelectedSongs }) },
      ];
    }
    return [
      { label: index === activeIndex && isPaused ? 'Resume' : 'Play', icon: 'play', disabled: !canPlayQueued || index === activeIndex && isPlaying, onSelect: () => index === activeIndex && isPaused ? playerPlay() : playQueued(index) },
      { label: 'Remove from queue', icon: 'close', disabled: busy, onSelect: () => queueAction('remove', { index }) },
      { separator: true, key: 'song' },
      { label: song.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', disabled: busy, onSelect: () => run(() => post('/api/library', { action: 'favorite', song_id: song.id, value: !song.favorite })) },
      { label: 'Add to playlist…', icon: 'folder', onSelect: () => setDialog({ type: 'assign', songId: song.id }) },
      { label: 'Playback sound…', icon: 'piano', disabled: busy, onSelect: () => openAdaptation(song.id) },
      { label: 'Edit details…', icon: 'edit', disabled: busy, onSelect: () => startEditDetails([song]) },
      { label: 'Download MIDI', icon: 'download', onSelect: () => download(song) },
    ];
  }
  const queueLibraryDrag = {
    isOutside: point => !!queueTargetAt(point)?.library,
    onOutsideMove: point => { const target = queueTargetAt(point)?.library || ''; if (target !== libraryDrop) setLibraryDrop(target); },
    onDropOutside: (point, entry) => {
      const target = queueTargetAt(point)?.library;
      setLibraryDrop('');
      if (!target) return;
      const destination = library.libraries.find(item => item.id === target);
      if (queueSelectedKeys.length > 1 && queueSelectedKeys.includes(entry)) return destination && addSongsToLibrary(queueSelectedSongs, destination);
      addToLibrary(queueIds[queueEntryIds.indexOf(entry)], target);
    },
    outsideHint: 'Drop to add it here',
  };
  const queueContent = <>
        <div className="content-heading queue-header"><h2>{onDevice ? `Your queue on ${thisDevice.name.toLowerCase()}` : 'Piano queue'}</h2></div>
        {queueSelectedKeys.length > 0 && <div className="queue-bulk" role="toolbar" aria-label="Selected queued songs"><strong>{countSongs(queueSelectedKeys.length)} selected</strong><div className="bulk-actions"><button className="btn light small" disabled={busy} onClick={() => removeQueued(queueSelectedIndexes)}><Icon name="close" />Remove</button><button className="btn light small" disabled={busy} onClick={() => favoriteSongs(queueSelectedSongs, !queueSelectedSongs.every(id => library.songs.find(item => item.id === id)?.favorite))}><Icon name="heart" />{queueSelectedSongs.every(id => library.songs.find(item => item.id === id)?.favorite) ? 'Unfavorite' : 'Favorite'}</button><button className="btn light small" disabled={busy} onClick={() => setDialog({ type: 'bulk_assign', songIds: queueSelectedSongs })}><Icon name="folder" />Playlist</button><button className="btn light small" onClick={() => setQueueSelected([])}>Clear</button></div></div>}
        {!queueIds.length ? <div className="song-list" role="list" aria-label="Song queue"><EmptyState title="Your next song starts here." description={onDevice ? `Songs queued here play only on ${thisDevice.name.toLowerCase()}. The piano keeps its own queue.` : 'Add a few favorites or queue an entire playlist. Nothing starts until you press play.'} button="Browse your music" onClick={() => navigate('all')} /></div> : <>
          {hasCurrent && <div className="queue-section"><h3 className="queue-section-title">{nowLabel}</h3><div className="song-list queue-now" role="list" aria-label={nowLabel}>{queueRow(activeIndex)}</div></div>}
          {queueSections.map(section => {
            const entries = queueEntryIds.slice(section.start, section.end);
            return <div className="queue-section" key={section.key}><div className="queue-section-head"><h3 className="queue-section-title">{section.title}</h3><button type="button" className="queue-clear" disabled={busy} onClick={() => hasCurrent ? queueAction('clear_after', { index: activeIndex, expected_song_ids: queueIds }) : queueAction('clear')}>Clear queue</button></div>
              <SortableList items={entries} getLabel={entry => songTitle(songAt(queueEntryIds.indexOf(entry))?.name)} onStart={from => startReorder('queue', from + section.start)} onEnd={to => { setLibraryDrop(''); return finishReorder(to + section.start); }} onCancel={() => { setLibraryDrop(''); cancelReorder(); }} {...queueLibraryDrag}>
                <div className="song-list" role="list" aria-label={section.title}>{entries.map((entry, offset) => songAt(section.start + offset) && <SortableItem key={entry} id={entry} disabled={busy}>{rowProps => queueRow(section.start + offset, section, rowProps)}</SortableItem>)}</div>
              </SortableList></div>;
          })}
        </>}
  </>;
  // With falling notes open on a wide Player page, the notes fill the rest of the window.
  const notesFit = view === 'player' && showNotes && wideQueue;
  const betaVisible = betaOpen || view === 'sheets';
  const queueIsDocked = wideQueue && queueDocked;
  const queueVisible = queueIsDocked || queueOpen;
  // Docking the panel reflows the page, so clicks animate it; drags open it instantly.
  function setQueueVisible(visible, { animate = true } = {}) {
    if (!wideQueue) return setQueueOpen(visible);
    storage.set('piano-queue-panel', visible ? 'shown' : 'hidden');
    if (animate) withViewTransition(() => setQueueDocked(visible)); else setQueueDocked(visible);
  }
  // The full and mini players share one queue toggle, so the panel stays open or closed across pages.
  const expressiveClass = `expressive-button ${soundSettings.expressive ? 'is-on' : ''}`;
  const expressiveToggle = { type: 'button', onClick: () => togglePlaybackOption('/api/expression', 'expressive'), disabled: busy || soundSettings.mode === 'original', 'aria-pressed': !!soundSettings.expressive, 'aria-label': 'Expressive playback',
    title: soundSettings.mode === 'original' ? 'Original MIDI plays unchanged. Choose another playback sound to use expressive dynamics.' : 'Expressive dynamics: louder melody, metric accents, phrase arcs, longer notes weighted, slight variation' };
  const softPedalClass = `expressive-button ${soundSettings.soft_pedal ? 'is-on' : ''}`;
  const softPedalToggle = { type: 'button', onClick: () => togglePlaybackOption('/api/soft-pedal', 'soft_pedal'), disabled: busy || soundSettings.mode === 'original', 'aria-pressed': !!soundSettings.soft_pedal, 'aria-label': 'Extra quiet',
    title: soundSettings.mode === 'original' ? 'Original MIDI plays unchanged. Choose another playback sound to use Extra quiet.' : soundSettings.soft_pedal ? 'Extra quiet is on: the soft pedal is held for the whole song. Turn off to follow the MIDI file.' : 'Extra quiet: hold the soft pedal for the whole song. Now following the MIDI file.' };
  const queueButton = <button type="button" ref={queueTrigger} className="device-picker-button mini-player-queue" aria-label={`${queueVisible ? 'Hide' : 'Show'} queue, ${queueShown} ${queueShown === 1 ? 'song' : 'songs'}`} title={queueVisible ? 'Hide queue' : 'Show queue'} aria-expanded={queueVisible} aria-controls="queue-panel" onClick={() => setQueueVisible(!queueVisible)} onDragEnter={event => { if (carriesSong(event)) setQueueVisible(true, { animate: false }); }}><Icon name="queue" />{queueShown > 0 && <span className="queue-count" aria-hidden="true">{queueShown}</span>}</button>;
  // Only one player is shown at a time, so both can render the same volume control.
  const volumeControl = onDevice
              ? <div className="volume-wrap"><label htmlFor="volume" aria-label="Volume on this device"><Icon name="volume" /></label><input id="volume" type="range" min="0" max="100" value={local.volume} aria-label="Volume on this device" onChange={event => local.setVolume(Number(event.target.value))} /><output htmlFor="volume">{local.volume}%</output></div>
              : <div className="volume-wrap"><label htmlFor="volume" aria-label="Piano volume"><Icon name="volume" /></label><input id="volume" type="range" min="0" max="100" value={volume} aria-label="Piano volume" onChange={event => { volumeDragging.current = true; setVolume(Number(event.target.value)); }} onPointerUp={event => saveVolume(Number(event.currentTarget.value))} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) saveVolume(Number(event.currentTarget.value)); }} onBlur={event => { if (volumeDragging.current) saveVolume(Number(event.currentTarget.value)); }} /><output htmlFor="volume">{volume}%</output></div>;
  function queueDropTarget(event) {
    const row = event.target.closest?.('[data-queue-index]');
    if (!row) return { index: queueIds.length, row: -1, after: false };
    const index = Number(row.dataset.queueIndex);
    if (row.dataset.queueCurrent) return { index: index + 1, row: index, after: true };
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    return { index: after ? index + 1 : index, row: index, after };
  }

  // Online count and piano connection: in the sidebar on desktop, in the top bar on phones.
  const connectionStatus = <><span className={`online-count ${connectionError ? 'offline' : ''}`} title="Browsers connected to this piano app. Closed browsers disappear within 90 seconds."><span className="online-dot" />{connectionError ? 'Offline' : status ? `${status.online_count ?? 1} online` : 'Connecting…'}</span><button className={`connection ${onDevice || playable ? 'connected' : ''}`} title="Connect to a device" onClick={openConnection}><span className="dot" /><span className="label">{onDevice ? `Playing on ${thisDevice.name}` : connectionError ? 'Piano computer unavailable' : device?.name || (wanted ? 'Waiting for your piano' : status ? 'Connect your piano' : 'Connecting to your Mac…')}</span><Icon name="arrow" /></button></>;
  const viewTitle = view === 'sheets' ? 'Songs from sheet music' : view === 'favorites' ? 'Your favorites' : selectedLibrary?.name || 'All songs';
  const viewNote = view === 'sheets' ? 'Converted on this Mac. Review the notes before playing.' : '';

  return <div className={`shell ${view !== 'player' ? 'with-mini-player' : ''} ${queueIsDocked ? 'queue-docked' : ''} ${view !== 'player' && view !== 'discover' && selectedIds.length ? 'has-bulk-bar' : ''}`}>
    <aside className="sidebar">
      <div className="brand">{logoMissing ? <><span className="brand-mark"><Icon name="piano" /></span>Office Piano</> : <div><img className="brand-logo" src="/assets/brand/cymphony-logo-full-purple.svg" alt="Cymphony" onError={() => setLogoMissing(true)} /><span className="brand-name">Office Piano</span></div>}</div>
      <nav className="nav" aria-label="Music">
        {[['player', 'Player', 'play', queueShown], ['all', 'All songs', 'grid', library.songs.filter(song => song.source_kind !== 'sheet').length], ['favorites', 'Favorites', 'heart', library.songs.filter(song => song.favorite).length], ['discover', 'Discover', 'search']].map(([id, label, icon, count]) => <button key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} />{label}{count !== undefined && <span className="count">{count}</span>}</button>)}
      </nav>
      <div className="collections"><div className="side-heading"><span className="eyebrow">Playlists</span><button className="icon-button" aria-label="Create playlist" title="Create playlist" onClick={() => { setLibraryName(''); setDialog({ type: 'create' }); }}><Icon name="plus" /></button></div>
        <nav className="nav library-nav" aria-label="Playlists">{sidebarLibraries.map(item => <button key={item.id} data-library-id={item.id} onContextMenu={event => openLibraryMenu(event, item)} aria-haspopup="menu" className={`${view === item.id ? 'active' : ''} ${draggingSong ? 'is-drop-ready' : ''} ${libraryDrop === item.id ? 'is-drop-target' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)} onMouseEnter={event => { const name = event.currentTarget.querySelector('.name'); event.currentTarget.title = name.scrollWidth > name.clientWidth ? item.name : ''; }}><Icon name="folder" /><span className="name">{item.name}</span><span className="count">{library.songs.filter(song => (song.library_ids || []).includes(item.id)).length}</span></button>)}</nav>
      </div>
      <div className="collections wip-section"><div className="side-heading"><button type="button" className="side-toggle" aria-expanded={betaVisible} aria-controls="beta-features" onClick={() => setBetaOpen(open => { storage.set('piano-beta-open', open ? 'off' : 'on'); return !open; })}><span className="eyebrow">Beta features</span><Icon name="arrow" style={{ transform: betaVisible ? 'rotate(90deg)' : 'none' }} /></button></div>
        {betaVisible && <nav className="nav library-nav" id="beta-features" aria-label="Beta features"><button className={view === 'sheets' ? 'active' : ''} aria-current={view === 'sheets' ? 'page' : undefined} onClick={() => navigate('sheets')}><Icon name="book" /><span className="name">Sheet music</span><span className="count">{library.songs.filter(song => song.source_kind === 'sheet').length}</span></button></nav>}
      </div>
      <div className="side-status">{connectionStatus}<button type="button" className="side-wifi" onClick={() => { setCopied(false); setDialog({ type: 'remote' }); }}><Icon name="wifi" />Control over Wi-Fi</button></div>
    </aside>
    <main className={`main ${notesFit ? 'main-fit' : ''}`}>
      <header className="topbar"><div className="topbar-status">{connectionStatus}<button type="button" className="icon-button" aria-label="Control over Wi-Fi" title="Control over Wi-Fi" onClick={() => { setCopied(false); setDialog({ type: 'remote' }); }}><Icon name="wifi" /></button></div></header>
      <div className="intro"><div><h1>{view === 'player' ? 'Player' : view === 'discover' ? 'Discover' : view === 'sheets' ? 'Sheet music' : 'Your music'}</h1></div>{(view === 'all' || selectedLibrary) && <button className="btn light" onClick={() => fileInput.current?.click()} disabled={busy} title={selectedLibrary ? `Upload MIDI to ${selectedLibrary.name}` : 'Upload MIDI to All songs'}><Icon name="upload" />Upload MIDI</button>}{view === 'sheets' && <button className="btn light" onClick={() => sheetInput.current?.click()} disabled={busy}><Icon name="upload" />Upload sheet music</button>}<input ref={sheetInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.musicxml,.mxl" multiple onChange={uploadSheets} hidden /><input ref={fileInput} type="file" accept=".mid,.midi" multiple onChange={upload} hidden /></div>
      {notice && <div className={`message visible top-notice ${notice.success ? 'success' : ''}`} role={notice.success ? 'status' : 'alert'} aria-live="polite" onMouseEnter={() => setNoticePaused(true)} onMouseLeave={() => setNoticePaused(false)} onFocus={() => setNoticePaused(true)} onBlur={() => setNoticePaused(false)}><span className="top-notice-text">{notice.text}{notice.undoSheetId && <button className="btn light small" style={{ marginLeft: 12 }} onClick={async () => { const result = await run(() => post('/api/sheets/restore', { id: notice.undoSheetId }), 'File restored.'); if (result) await refreshSheets(); }}>Undo</button>}{notice.undoSongIds && <button className="btn light small" style={{ marginLeft: 12 }} onClick={() => eachSong(notice.undoSongIds, songId => post('/api/library', { action: 'restore', song_id: songId }), notice.undoSongIds.length === 1 ? 'Song restored.' : `${countSongs(notice.undoSongIds.length)} restored.`)}>Undo</button>}{notice.undoPlaylist && <button className="btn light small" style={{ marginLeft: 12 }} disabled={busy} onClick={async () => { const undo = notice.undoPlaylist; setNotice(null); await undoRemoveFromLibrary(undo); }}>Undo</button>}</span><button type="button" className="top-notice-close" aria-label="Dismiss message" title="Dismiss" onClick={() => setNotice(null)}><Icon name="close" /></button></div>}

      {view === 'player' && <section aria-label="Player" className={notesFit ? 'player-fit' : undefined}>
        <section className="player" aria-label="Piano player"><div className="art-column"><div className={`art ${showArtwork ? 'has-cover' : ''}`} aria-hidden="true">{canLoadArtwork && <img className={`album-cover ${showArtwork ? 'is-ready' : ''}`} src={artworkUrl} alt="" onLoad={() => setLoadedArtwork(artworkUrl)} onError={() => setFailedArtwork(artworkUrl)} />}{!showArtwork && <div className="keys">{[true, true, false, true, true, true, false].map((black, index) => <i className={black ? 'black' : ''} key={index} />)}</div>}</div>{spotifyLink && <a className="spotify-cover-link" href={spotifyLink} target="_blank" rel="noopener noreferrer" aria-label="Find this album on Spotify" title="Find this album on Spotify"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760" stroke="none"/><path d="M5 8c5-1.7 10-1.2 14 1M6 12c4-1.3 8-1 12 1M7 16c3-.8 6-.5 9 1" fill="none" stroke="#121d16" strokeWidth="1.7" strokeLinecap="round"/></svg>Spotify ↗</span></a>}</div><div className="player-content"><div className="eyebrow"><span className="playing-pulse" /><span>{onDevice && local.loading ? 'Loading…' : isPlaying ? 'Now playing' : isPaused ? 'Paused' : 'Ready when you are'}</span></div><h2 className="song-title">{playerName ? songTitle(playerName) : 'Waiting for a song'}</h2><p className="player-record">{[playerSong?.artist, playerSong?.album].filter(Boolean).join(' · ') || '\u00a0'}</p><p className="song-meta">{playerName ? [playerSong?.piano_only === true ? 'Piano only' : 'Other MIDI', playerSong?.source_url ? providerName(playerSong.source_url) : playerSong?.source_kind === 'sheet' ? 'Sheet music' : ''].filter(Boolean).join(' · ') : '\u00a0'}</p><div className="progress-row"><span>{time(playerElapsed)}</span><input className="song-timeline" type="range" min="0" max={playerDuration || 1} step="0.1" value={Math.min(playerDuration || 1, playerElapsed)} aria-label="Song timeline" aria-valuetext={`${time(playerElapsed)} of ${time(playerDuration)}`} disabled={!canSeek} onChange={event => previewSeek(Number(event.target.value))} onPointerUp={event => seekTo(event.currentTarget.value)} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) seekTo(event.currentTarget.value); }} onBlur={event => seekTo(event.currentTarget.value)} /><span>{time(playerDuration)}</span></div>
          <div className="player-bottom"><div className="controls"><button className="icon-button" aria-label="Previous song" title="Previous song" disabled={!canPrevious} onClick={() => playerSkip(-1)}><Icon name="previous" /></button><button className="play-button" aria-label={isPaused ? 'Resume' : 'Play'} title={isPaused ? 'Resume' : 'Play'} disabled={!canPlay || isPlaying} onClick={playerPlay}>{onDevice && local.loading ? <span className="spinner" /> : <Icon name="play" />}</button><button className="icon-button" aria-label="Pause" title="Pause" disabled={onDevice ? !isPlaying : busy || !playing} onClick={playerPause}><Icon name="pause" /></button><button className="icon-button" aria-label="Next song" title="Next song" disabled={!canNext} onClick={() => playerSkip(1)}><Icon name="next" /></button><button className="icon-button" aria-label={onDevice ? 'Stop' : 'Stop and release keys'} title={onDevice ? 'Stop' : 'Stop & release keys'} onClick={playerStop} disabled={onDevice ? local.state === 'stopped' && !local.loading : busy}><Icon name="stop" /></button></div>
            <div className="player-tools"><button type="button" className="sound-button" onClick={openAdaptation} disabled={busy} aria-label={`Playback sound: ${soundName}. Change playback sound`} title="Change playback sound"><Icon name="piano" /><span className="sound-button-label">{soundName}</span>{soundSettings.mode === 'smart' && <span className="experimental-badge">Experimental</span>}</button><button className={`sound-button ${expressiveClass}`} {...expressiveToggle}><Icon name="expressive" /></button><button className={`sound-button ${softPedalClass}`} {...softPedalToggle}><Icon name="quiet" /></button>{queueButton}<DevicePicker {...pickerProps} />{volumeControl}</div>
          </div>
          <p className={`playing-on ${onDevice ? 'is-local' : ''}`}><Icon name={currentEntry.icon} />Playing on {currentEntry.name}{onDevice && ' · The piano stays silent'}</p></div></section>
        <section className={`notes-panel ${showNotes ? 'is-open' : ''}`} aria-labelledby="notes-heading">
          <div className="notes-panel-header"><div><h2 id="notes-heading">Falling notes</h2><p className="section-note">Notes as the song plays, without drums. Press the keys to play along.</p></div><button type="button" className="btn small" aria-expanded={showNotes} aria-controls="falling-notes" onClick={toggleNotes}>{showNotes ? 'Hide' : 'Show'}</button></div>
          {showNotes && <div id="falling-notes"><FallingNotes songId={playerSongId} loadSong={loadSongNotes} getTime={notesTime} playing={notesPlaying} position={playerElapsed} onPress={pressKey} onRelease={releaseKey} /></div>}
        </section>
      </section>}

      {view === 'sheets' && <section className="sheet-import" aria-label="Sheet music files">
        <div className="sheet-explainer"><span className="mini-art"><Icon name="book" /></span><div><h2>A page, a piece, or a whole book</h2><p>Upload a PDF, a clear photo, or a MusicXML score.</p><p className="section-note">Recognition can miss notes, rhythm, or repeats. Check converted songs before playing.</p></div></div>
        {sheets.available === false && <p className="message visible" role="status">Printed-sheet recognition is not available on this Mac yet. MusicXML scores can still convert. Your uploaded originals stay saved here.</p>}
        {sheetError && <p className="message visible" role="alert">{sheetError}</p>}
        <div className="sheet-browse-toolbar"><label className="search"><Icon name="search" /><input type="search" placeholder="Find a song in your books…" aria-label="Filter saved songs" value={filter} onChange={event => setFilter(event.target.value)} /></label></div>
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
          <button className="btn light small" disabled={busy} onClick={() => setDialog({ type: 'bulk_assign', songIds: selectedIds })}><Icon name="folder" />Add to playlist</button>
          {selectedLibrary && <button className="btn light small" disabled={busy} onClick={() => removeFromLibrary(selectedIds, selectedLibrary)}><Icon name="close" />Remove from playlist</button>}
          <button className="btn light small bulk-delete" disabled={busy} onClick={() => setDialog({ type: 'bulk_delete', songIds: selectedIds })}><Icon name="trash" />Delete</button>
          <button className="btn light small" onClick={() => setSelected([])}>Clear</button>
        </div>
      </div>}
      {view !== 'player' && view !== 'discover' && (view !== 'sheets' || listedSongs.length > 0 || !sheets.items.length) && <section aria-label="Saved music">
        <div className="content-heading"><div><div className="heading-title"><h2>{view === 'sheets' && sheetGroups.books.length ? 'Other sheet songs' : viewTitle}</h2>{selectedLibrary && <button type="button" className="icon-button playlist-rename" aria-label="Rename playlist" title="Rename playlist" disabled={busy} onClick={() => { setLibraryName(selectedLibrary.name); setDialog({ type: 'rename', libraryId: selectedLibrary.id }); }}><Icon name="edit" /></button>}</div>{viewNote && <p className="section-note">{viewNote}</p>}</div><div className="saved-heading-tools">{view !== 'sheets' && <><label className="search"><Icon name="search" /><input type="search" placeholder="Find a saved song…" aria-label="Filter saved songs" value={filter} onChange={event => setFilter(event.target.value)} /></label><button type="button" className="playlist-play" aria-label={`Play ${viewTitle}`} title={`Play ${viewTitle}`} disabled={!savedSongs.length || (onDevice ? local.loading : busy)} onClick={() => playSongIds(savedSongs.map(song => song.id))}><Icon name="play" /></button></>}</div></div>
        {renderSavedSongs(listedSongs, view === 'sheets' ? 'loose' : undefined)}
      </section>}

      {view === 'discover' && <section aria-label="Discover music"><div className="discover-toolbar"><form className="search" onSubmit={event => { event.preventDefault(); search(); }}><Icon name="search" /><input type="search" placeholder="Search a song, composer, or artist…" aria-label="Search MIDI sites" required maxLength="120" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn" type="submit">{searching ? <><span className="spinner" />Checking</> : 'Search'}</button></form></div><fieldset className="source-list"><legend>Sources</legend><div className="source-options">{SOURCE_IDS.map(id => <label key={id} className={`source-option ${searchSources.includes(id) ? 'is-on' : ''}`} title={searchSources.length === 1 && searchSources.includes(id) ? `${sourceDescriptions[id]} At least one source stays selected.` : sourceDescriptions[id]}><input type="checkbox" checked={searchSources.includes(id)} onChange={() => toggleSearchSource(id)} /><span>{sourceLabels[id]}{sourceKinds[id] && <small> · {sourceKinds[id]}</small>}</span></label>)}</div></fieldset><div className="search-warnings" role="status">{searchData.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>{searchData.notes.length > 0 && <ul className="search-notes">{searchData.notes.map((note, index) => <li key={index}><strong>{note.source_name}</strong> {note.text}</li>)}</ul>}<p className="section-note" style={{ margin: '0 0 14px' }} aria-live="polite">{searching ? 'Searching catalogs… This can take a moment.' : searchData.searched ? `${searchData.results.length}${Number.isInteger(searchData.totalMatches) ? ` of ${searchData.totalMatches}` : ''} songs shown · ${searchData.results.filter(result => result.piano_only === true).length} piano-only${searchData.hasMore ? ' · More available below' : ''}` : ''}</p><div className="song-list results">{searchData.results.length ? searchData.results.map((result, index) => <SearchResult key={`${result.url}-${index}`} result={result} libraries={library.libraries} busy={busy} onSave={saveResult} notice={notice} />) : searchData.searched ? <EmptyState title="No songs found in this batch." description="Try the next results, or search another title or composer." /> : <EmptyState icon="search" title="Find a song" description="Try a song title, artist, or composer." />}</div>{searchData.hasMore && <button className="btn light load-more" disabled={searching} onClick={() => search(true)}>Load more songs</button>}</section>}

    </main>
    {queueVisible && <aside className={`queue-panel ${queueIsDocked ? '' : 'is-open'} ${draggingSong ? 'is-drop-ready' : ''} ${queueDrop ? 'is-drop-target' : ''}`} id="queue-panel" aria-label="Queue">
      <button type="button" ref={queueClose} className="icon-button queue-panel-close" aria-label="Close queue" title="Close queue" onClick={() => setQueueVisible(false)}><Icon name="close" /></button>
      {queueContent}
    </aside>}
    {queueVisible && !queueIsDocked && <div className="queue-backdrop" aria-hidden="true" onClick={() => setQueueOpen(false)} />}
    {view !== 'player' && <section className="mini-player" aria-label="Mini player">
      <button className="mini-player-song" onClick={() => navigate('player')} aria-label="Open full player">
        <span className="mini-player-art">{canLoadArtwork ? <img src={artworkUrl} alt="" onLoad={() => setLoadedArtwork(artworkUrl)} onError={() => setFailedArtwork(artworkUrl)} /> : <Icon name="piano" />}</span>
        <span className="mini-player-title"><strong>{playerName ? songTitle(playerName) : 'Waiting for a song'}</strong>{onDevice ? <small className="mini-playing-on">Playing on {currentEntry.name}</small> : <small>{playerSong?.artist || (isPlaying ? 'Now playing' : isPaused ? 'Paused' : 'Open player')}</small>}</span>
      </button>
      <div className="mini-player-center">
        <div className="mini-player-controls">
          <button className="icon-button" aria-label="Previous song" title="Previous song" disabled={!canPrevious} onClick={() => playerSkip(-1)}><Icon name="previous" /></button>
          <button className="mini-player-play" aria-label={isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'} title={isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'} disabled={isPlaying ? !onDevice && busy : !canPlay} onClick={() => isPlaying ? playerPause() : playerPlay()}>{onDevice && local.loading ? <span className="spinner" /> : <Icon name={isPlaying ? 'pause' : 'play'} />}</button>
          <button className="icon-button" aria-label="Next song" title="Next song" disabled={!canNext} onClick={() => playerSkip(1)}><Icon name="next" /></button>
        </div>
        <div className="mini-player-progress"><span>{time(playerElapsed)}</span><input className="song-timeline" type="range" min="0" max={playerDuration || 1} step="0.1" value={Math.min(playerDuration || 1, playerElapsed)} aria-label="Mini player timeline" aria-valuetext={`${time(playerElapsed)} of ${time(playerDuration)}`} disabled={!canSeek} onChange={event => previewSeek(Number(event.target.value))} onPointerUp={event => seekTo(event.currentTarget.value)} onKeyUp={event => { if (SEEK_KEYS.includes(event.key)) seekTo(event.currentTarget.value); }} onBlur={event => seekTo(event.currentTarget.value)} /><span>{time(playerDuration)}</span></div>
      </div>
      <div className="mini-player-actions">
        <button type="button" className="device-picker-button mini-player-sound" onClick={() => openAdaptation(undefined, { applyNow: true })} disabled={busy} aria-label={`Playback sound: ${soundName}. Change playback sound`} title={`Playback sound: ${soundName}`}><Icon name="piano" /></button>
        <button className={`device-picker-button ${expressiveClass}`} {...expressiveToggle}><Icon name="expressive" /></button>
        <button className={`device-picker-button ${softPedalClass}`} {...softPedalToggle}><Icon name="quiet" /></button>
        {queueButton}
        <DevicePicker {...pickerProps} />
        <div className="mini-player-volume">{volumeControl}</div>
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
        <button type="button" className="icon-button" aria-label={`Remove song ${index + 1}`} title="Remove this song" disabled={busy || sheetPieces.length === 1} onClick={() => setSheetPieces(previous => previous.filter((_, rowIndex) => rowIndex !== index))}><Icon name="close" /></button>
      </div>)}</div>
      <button type="button" className="btn light small" disabled={busy || sheetPieces.length >= 50} onClick={() => setSheetPieces(previous => [...previous, { name: '', pages: '' }])}><Icon name="plus" />Add another song</button>
      <p className="dialog-hint">Use a range such as 1-3, or separate pages such as 1,3-5. Song boundaries are chosen by you. Originals remain saved locally.</p>
      {(splitError || notice && !notice.success) && <p className="message visible" role="alert">{splitError || notice.text}</p>}
      <div className="dialog-actions"><button type="button" className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy || sheets.available !== true}>{busy ? 'Starting…' : `Convert ${sheetPieces.length === 1 ? 'song' : `${sheetPieces.length} songs`}`}</button></div>
    </form></Dialog>}

    {dialog?.type === 'adaptation' && <Dialog title="Playback sound" closeDisabled={busy} onClose={() => { adaptationRequest.current += 1; setDialog(null); }}>
      {adaptationSong && <p className="adaptation-selected-song">{songTitle(adaptationSong.name)}</p>}
      {soundReport?.notice && adaptationSongId && adaptationSongId === status?.song_id && <p className="adaptation-report">{soundReport.notice}</p>}
      <p className="dialog-hint">Choose which parts play, on the piano and on this computer. The original file is never changed.</p>
      {adaptationLoading ? <p className="dialog-hint" role="status"><span className="spinner" /> Checking song parts…</p> : <>
        <fieldset className="adaptation-modes">
          <legend className="dialog-label">Play this way</legend>
          {[
            ['no_drums', 'All parts except drums', 'Play every instrument part except drums on the piano. Keep the original notes, timing, and dynamics.'],
            ['original', 'Original MIDI · All parts', 'Including drums, exactly as in the file. This computer can’t play drum sounds.'],
            ['piano', 'Piano parts only', 'Keep parts marked as piano; leave the other instruments out.'],
            ['smart', 'Smart piano · Experimental', 'Choose suitable parts and merge their notes into one piano track. Experimental.'],
            ['custom', 'Choose parts', 'Pick the parts you want to hear in this song.'],
          ].map(([mode, title, detail]) => {
            const reason = mode === 'custom' && !adaptationSongId ? 'Load a song to choose its parts.' : mode === 'piano' && !!adaptationSongId && !hasPianoParts ? 'This song has no parts marked as piano.' : '';
            const disabled = busy || !!reason;
            return <label key={mode} className={`adaptation-mode ${disabled ? 'unavailable' : ''}`} data-reason={reason || undefined} aria-description={reason || undefined}>
              <input type="radio" name="adaptationMode" value={mode} checked={adaptationMode === mode} disabled={disabled} onChange={() => { setAdaptationMode(mode); setAdaptationError(''); }} />
              <span><strong>{title}{mode === (adaptationData?.settings?.default_mode || status?.adaptation?.settings?.default_mode || 'no_drums') && ' · Default'}</strong><small>{detail}</small></span>
            </label>;
          })}
        </fieldset>
        {!adaptationSongId && <p className="dialog-hint">No song is loaded, so this sets the default. Load a song to choose its parts.</p>}
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
      <p className="adaptation-stop-note">{`${adaptationSongId ? 'Saved for this song. ' : ''}${dialog.applyNow || dialog.stopsDevice ? 'Applying stops playback.' : 'Takes effect the next time it plays.'}`}</p>
      <div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => { adaptationRequest.current += 1; setDialog(null); }}>Cancel</button><button className="btn" disabled={busy || adaptationLoading || !adaptationData || adaptationMode === 'custom' && (!adaptationSongId || !adaptationParts.length) || adaptationMode === 'piano' && !!adaptationSongId && !hasPianoParts} onClick={applyAdaptation}>{dialog.applyNow ? 'Apply sound' : 'Save settings'}</button></div>
    </Dialog>}

    {dialog?.type === 'take_song' && <Dialog title={`Play on ${thisDevice.name.toLowerCase()}`} onClose={() => setDialog(null)}><p className="dialog-hint">The piano is playing {songTitle(current?.name || 'a song')}. Take it with you, or let the piano keep playing while you listen to your own queue here.</p><div className="dialog-actions"><button className="btn light" onClick={() => { setDialog(null); switchOutput('device'); }}>Let the piano keep playing</button><button className="btn" onClick={() => { setDialog(null); switchOutput('device', true); }}>Take the song and pause the piano</button></div></Dialog>}
    {dialog?.type === 'connection' && <Dialog title="Connect to a device" onClose={() => setDialog(null)}><div className="device-dialog-list"><DeviceOptions current={currentEntry} others={otherEntries} playing={isPlaying} emptyNote={noPianoNote} onChoose={chooseDevice} /></div><div className="dialog-actions"><button className="btn light small" onClick={refresh}>Refresh devices</button><button className="btn small" disabled={busy || !wanted} onClick={() => run(() => post('/api/reconnect', { name: wanted }), 'Reconnecting your piano. Press Play once it is connected.')}>Reconnect piano</button></div><p className="dialog-hint" style={{ marginTop: 18 }}>We remember your piano and reconnect when its MIDI connection returns. Playback starts only when you press play.</p><p className="dialog-hint">If another app used the piano, disconnect it there first, then press Reconnect piano. {status?.platform === 'linux' ? 'On Raspberry Pi, choose your piano from the device list and press Reconnect piano. Keep it disconnected from other apps, or use USB.' : 'On your Mac, open Audio MIDI Setup → MIDI Studio → Bluetooth, then connect to Prodigy2 MIDI. Keep the Mac connected, or use USB.'}</p><p className="dialog-hint">{preferred ? `Remembered piano: ${preferred}. ` : ''}{status?.bluetooth?.message || ''}</p><div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {['create', 'rename'].includes(dialog?.type) && <Dialog title={dialog.type === 'rename' ? 'Rename playlist' : 'A playlist of your own'} onClose={() => setDialog(null)}><form onSubmit={async event => {
      event.preventDefault();
      const name = libraryName.trim();
      if (!name) return;
      const result = await run(() => post('/api/library', { action: dialog.type === 'rename' ? 'rename' : 'create', name, library_id: dialog.libraryId }));
      if (result) setDialog(null);
    }}><label htmlFor="libraryName" className="dialog-label">Playlist name</label><input id="libraryName" className="field" placeholder="Quiet mornings" required maxLength="80" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus /><div className="dialog-actions"><button type="button" className="btn light" onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>{dialog.type === 'rename' ? 'Save name' : 'Create playlist'}</button></div></form></Dialog>}
    {dialog?.type === 'assign' && <Dialog title="Save to a playlist" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p>{library.libraries.length ? library.libraries.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy} checked={(assignedSong?.library_ids || []).includes(item.id)} onChange={event => run(() => post('/api/library', { action: 'assign', song_id: assignedSong.id, library_id: item.id, value: event.target.checked }))} /><span>{item.name}</span></label>) : null}<NewLibraryRow busy={busy} onCreate={name => createLibraryWith(name, [assignedSong.id])} /><div className="dialog-actions"><button className="btn" onClick={() => setDialog(null)}>Done</button></div></Dialog>}
    {dialog?.type === 'rename_song' && <Dialog key={dialog.songId} title="Edit details" closeDisabled={busy} onClose={closeEditDetails}><form onSubmit={async event => {
      event.preventDefault();
      const original = typeof assignedSong?.recognition?.artwork === 'string' ? assignedSong.recognition.artwork : '';
      const result = await run(() => post('/api/library', { action: 'edit_song', song_id: dialog.songId, name: libraryName.trim(), artist: songArtist.trim(), album: songAlbum.trim(), ...(songCover !== original ? { artwork: songCover } : {}) }), 'Song updated.');
      if (result) closeEditDetails();
    }}>
      {dialog.total > 1 && <p className="dialog-hint">Song {dialog.step} of {dialog.total}</p>}
      <div className="edit-details-head">
        <span className="edit-details-cover">{songCover ? <img src={songCover.replace(/\/600x600bb\.(jpg|png)$/i, '/100x100bb.$1')} alt="" /> : <Icon name="note" />}</span>
        <div className="edit-details-fields">
          <label htmlFor="songName" className="dialog-label">Song name</label><input id="songName" className="field" required maxLength="200" value={libraryName} onChange={event => setLibraryName(event.target.value)} autoFocus />
          <div className="song-edit-fields"><label htmlFor="songArtist" className="dialog-label">Artist</label><input id="songArtist" className="field" maxLength="200" placeholder="Artist or composer" value={songArtist} disabled={busy} onChange={event => setSongArtist(event.target.value)} /><label htmlFor="songAlbum" className="dialog-label">Album</label><input id="songAlbum" className="field" maxLength="200" placeholder="Album title (optional)" value={songAlbum} disabled={busy} onChange={event => setSongAlbum(event.target.value)} /></div>
        </div>
      </div>
      {songCover && <button type="button" className="edit-details-remove" onClick={() => { setSongCover(''); setItunes(previous => ({ ...previous, chosen: -1 })); }}>Remove cover</button>}
      <div className="edit-details-search">
        <label htmlFor="songSearch" className="dialog-label">Find song info</label>
        <div className="itunes-search">
          <input id="songSearch" className="field" type="search" maxLength="120" value={itunes.query} onChange={event => setItunes(previous => ({ ...previous, query: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (itunes.query.trim()) searchItunes(itunes.query.trim()); } }} />
          <button className="btn light" type="button" disabled={itunes.loading || !itunes.query.trim()} onClick={() => searchItunes(itunes.query.trim())}>Search</button>
        </div>
        {itunes.loading ? <p className="dialog-hint" role="status"><span className="spinner" /> Searching…</p>
          : itunes.error ? <p className="message visible" role="alert">{itunes.error}</p>
          : itunes.results && !itunes.results.length ? <p className="dialog-hint">No songs found. Try fewer or different words.</p>
          : itunes.results && <div className="itunes-results" role="list">{itunes.results.map((result, index) => <button key={index} type="button" role="listitem" aria-pressed={itunes.chosen === index} className={`itunes-result ${itunes.chosen === index ? 'is-chosen' : ''}`} onClick={() => chooseResult(result, index)}>
              {result.artwork ? <img src={result.artwork.replace(/\/600x600bb\.(jpg|png)$/i, '/100x100bb.$1')} alt="" /> : <span className="itunes-cover-empty"><Icon name="note" /></span>}
              <span><strong>{result.title}</strong><small>{[result.artist, result.album].filter(Boolean).join(' · ')}</small></span>
            </button>)}</div>}
      </div>
      {assignedSong?.recognition?.original_name && <p className="dialog-hint">Original file name: {assignedSong.recognition.original_name}</p>}
      <div className="dialog-actions"><button type="button" className="btn light" disabled={busy} onClick={closeEditDetails}>{dialog.step < dialog.total ? 'Skip' : 'Cancel'}</button><button className="btn" disabled={busy || !libraryName.trim()}>{dialog.step < dialog.total ? 'Save and next' : 'Save'}</button></div>
    </form></Dialog>}
    {dialog?.type === 'delete' && <Dialog title="Remove this song?" onClose={() => setDialog(null)}><p className="dialog-hint">{assignedSong?.name}</p><p className="dialog-hint">This removes the song from All songs, favorites, playlists, and the queue. If it is playing, playback stops. The MIDI is moved to the app’s trash folder, and you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={async () => { const song = assignedSong; const result = await run(() => post('/api/library', { action: 'delete', song_id: song.id })); if (result) { setDialog(null); setNotice({ text: 'Song removed.', success: true, undoSongIds: [song.id] }); } }}>Remove song</button></div></Dialog>}
    {dialog?.type === 'bulk_delete' && <Dialog title={`Remove ${countSongs(dialog.songIds.length)}?`} onClose={() => setDialog(null)}><p className="dialog-hint">This removes them from All songs, favorites, playlists, and the queue. If one is playing, playback stops. The MIDI files are moved to the app’s trash folder, and you can undo.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => deleteSongs(dialog.songIds)}>Remove {countSongs(dialog.songIds.length)}</button></div></Dialog>}
    {dialog?.type === 'delete_library' && (() => { const item = library.libraries.find(entry => entry.id === dialog.libraryId); return item && <Dialog title="Delete this playlist?" onClose={() => setDialog(null)}><p className="dialog-hint">{item.name}</p><p className="dialog-hint">The playlist is removed. Its songs stay in All songs, favorites, and the queue.</p><div className="dialog-actions"><button className="btn light" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => deleteLibrary(item)}>Delete playlist</button></div></Dialog>; })()}
    {dialog?.type === 'bulk_assign' && <Dialog title="Add to a playlist" onClose={() => setDialog(null)}><p className="dialog-hint">{countSongs(dialog.songIds.length)} selected</p>{library.libraries.length ? <div className="bulk-library-list">{library.libraries.map(item => <button key={item.id} type="button" className="bulk-library" disabled={busy} onClick={() => addSongsToLibrary(dialog.songIds, item)}><Icon name="folder" /><span>{item.name}</span></button>)}<NewLibraryRow busy={busy} onCreate={async name => { const done = await createLibraryWith(name, dialog.songIds); if (done) setDialog(null); return done; }} /></div> : <div className="bulk-library-list"><NewLibraryRow busy={busy} onCreate={async name => { const done = await createLibraryWith(name, dialog.songIds); if (done) setDialog(null); return done; }} /></div>}<div className="dialog-actions"><button className="btn light" onClick={() => setDialog(null)}>Cancel</button></div></Dialog>}
    {menuLibrary && <ContextMenu x={songMenu.x} y={songMenu.y} label={`Actions for ${menuLibrary.name}`} items={libraryMenuItems(menuLibrary)} onClose={closeSongMenu} />}
    {menuSong && <ContextMenu x={songMenu.x} y={songMenu.y} label={`Actions for ${menuSong.name}`} items={songMenu.kind === 'queue' ? queueMenuItems(songMenu.index) : songMenuItems(menuSong)} onClose={closeSongMenu} />}
    {dialog?.type === 'remote' && <Dialog title="Music, from anywhere in the room." onClose={() => setDialog(null)}><p className="dialog-hint">Open this private link on a phone or another computer on the same office Wi-Fi. The piano computer sends the music and must stay awake.</p><a className="dialog-hint" style={{ display: 'block' }} href={status?.remote || '#'}>{status?.remote || 'Waiting for the piano connection…'}</a><div className="dialog-actions"><button className="btn" onClick={async () => {
      try { if (!status?.remote) throw Error(); await navigator.clipboard.writeText(status.remote); setCopied(true); }
      catch { announce('Select and copy the private link in the Wi-Fi dialog.'); }
    }}><Icon name="link" />{copied ? 'Copied ✓' : 'Copy remote link'}</button></div></Dialog>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

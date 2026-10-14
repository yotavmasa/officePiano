import React, { useEffect, useRef, useState } from 'react';

export function piecePages(value, count) {
  const pages = [];
  if (!value || value.length > 200) return null;
  for (const segment of value.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(segment);
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > count) return null;
    for (let page = start; page <= end; page += 1) pages.push(page);
  }
  return new Set(pages).size === pages.length ? pages : null;
}

export function analysisProgressText(progress, total) {
  const done = typeof progress === 'object' && progress ? progress.done : progress;
  const pages = typeof progress === 'object' && progress ? progress.total || total : total;
  return Number.isFinite(done) ? `${done}/${pages} pages` : '';
}

export function pageRangeText(pages) {
  const ranges = [];
  for (let index = 0; index < pages.length; index += 1) {
    const start = pages[index];
    while (index + 1 < pages.length && pages[index + 1] === pages[index] + 1) index += 1;
    ranges.push(start === pages[index] ? String(start) : `${start}-${pages[index]}`);
  }
  return ranges.join(', ');
}

export default function SheetBookDialog({ item, api, fetchPreview, onClose, onConvert, available }) {
  const dialog = useRef(null);
  const cache = useRef(new Map());
  const initialized = useRef(false);
  const [book, setBook] = useState(null);
  const [pieces, setPieces] = useState([]);
  const [selected, setSelected] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const active = pieces.find(piece => piece.id === activeId);
  const activePages = active ? piecePages(active.pageText, book?.page_count || item.page_count) || active.pages : [];
  const page = activePages[Math.min(pageIndex, Math.max(0, activePages.length - 1))];
  const working = ['queued', 'analyzing'].includes(book?.analysis_status);

  useEffect(() => {
    dialog.current.showModal();
    return () => {
      if (dialog.current?.open) dialog.current.close();
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let fetching = false;
    let started = false;
    async function poll() {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        let data = await api(`/api/sheets/book?id=${encodeURIComponent(item.id)}`);
        if (!started) {
          started = true;
          if (!['ready', 'queued', 'analyzing'].includes(data.book.analysis_status)) {
            await api('/api/sheets/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
            data = await api(`/api/sheets/book?id=${encodeURIComponent(item.id)}`);
          }
        }
        if (cancelled) return;
        setBook(data.book);
        setError('');
        if (data.book.analysis_status === 'ready' && !initialized.current) {
          initialized.current = true;
          const candidates = (data.book.candidates || []).map(piece => ({ ...piece, pageText: pageRangeText(piece.pages), name: piece.title || 'Untitled piece' }));
          setPieces(candidates);
          setActiveId(candidates[0]?.id || '');
          setPageIndex(0);
        }
      } catch (failure) { if (!cancelled) setError(failure.message); }
      finally { fetching = false; }
    }
    poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [item.id, api]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreview('');
    setPreviewError('');
    if (!page) { setPreviewLoading(false); return () => controller.abort(); }
    const saved = cache.current.get(page);
    if (saved) { setPreview(saved); setPreviewLoading(false); return () => controller.abort(); }
    setPreviewLoading(true);
    fetchPreview(item.id, page, controller.signal).then(blob => {
      if (cancelled) return;
      const url = URL.createObjectURL(blob);
      cache.current.set(page, url);
      while (cache.current.size > 8) {
        const oldest = cache.current.keys().next().value;
        URL.revokeObjectURL(cache.current.get(oldest));
        cache.current.delete(oldest);
      }
      setPreview(url);
    }).catch(failure => {
      if (!cancelled && failure.name !== 'AbortError') setPreviewError(failure.message);
    }).finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [item.id, page, fetchPreview]);

  async function retry() {
    setRetrying(true);
    setError('');
    try {
      await api('/api/sheets/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
      initialized.current = false;
      setSelected([]);
      setPieces([]);
      setBook((await api(`/api/sheets/book?id=${encodeURIComponent(item.id)}`)).book);
    } catch (failure) { setError(failure.message); }
    finally { setRetrying(false); }
  }

  async function addSelected() {
    setError('');
    const chosen = pieces.filter(piece => selected.includes(piece.id));
    const used = new Set();
    for (const piece of chosen) {
      const pages = piecePages(piece.pageText, book.page_count);
      if (!piece.name.trim() || !pages) { setError(`Check the name and pages for ${piece.name || 'this song'}. Use pages such as 4-6 or 4,6.`); return; }
      if (pages.some(page => used.has(page))) { setError('Selected songs share a page. Adjust their page ranges before adding.'); return; }
      pages.forEach(page => used.add(page));
    }
    if (!chosen.length || chosen.length > 50) { setError('Choose between 1 and 50 songs.'); return; }
    setSaving(true);
    try { await onConvert(chosen.map(piece => ({ name: piece.name.trim(), pages: piece.pageText }))); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }

  function editPiece(id, field, value) {
    setPieces(previous => previous.map(piece => piece.id === id ? { ...piece, [field]: value } : piece));
  }

  return <dialog ref={dialog} className="sheet-book-dialog" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="dialog-head"><div><h2>Browse songs</h2><p className="section-note">{item.name} · {book?.page_count || item.page_count} pages</p></div><button className="icon-button" aria-label="Close dialog" disabled={saving} onClick={onClose}>×</button></div>
    <p className="dialog-hint">Detected suggestions—review the pages before adding. Click a song to preview its sheet music; choose the songs you want to convert.</p>
    {working && <p className="sheet-analysis-progress" role="status"><span className="spinner" />Finding songs… {analysisProgressText(book.analysis_progress, book.page_count)}</p>}
    {!book && !error && <p className="dialog-hint" role="status">Opening the book…</p>}
    {book?.analysis_status === 'error' && <div className="message visible" role="alert"><p>{book.analysis_error || 'Could not find the songs. Try again, or use manual page selection.'}</p><button className="btn light small" disabled={retrying} onClick={retry}>Try finding songs again</button></div>}
    {book?.analysis_status === 'ready' && <>
      <p className="section-note">{pieces.length} suggested {pieces.length === 1 ? 'song' : 'songs'} · {(book.music_pages || []).length} music pages · {Math.max(0, book.page_count - (book.music_pages || []).length)} pages skipped</p>
      {(book.analysis_warnings || []).map((warning, index) => <p key={index} className="message visible" role="status">{warning}</p>)}
    </>}
    {book?.analysis_status === 'ready' && <div className="sheet-book-layout">
      <div className="sheet-candidates" aria-label="Suggested songs">{pieces.length ? pieces.map(piece => <article key={piece.id} className={`sheet-candidate ${piece.id === activeId ? 'active' : ''}`}>
        <div className="sheet-candidate-head"><input type="checkbox" checked={selected.includes(piece.id)} aria-label={`Add ${piece.name}`} disabled={saving || !selected.includes(piece.id) && selected.length >= 50} onChange={event => setSelected(previous => event.target.checked ? [...previous, piece.id] : previous.filter(id => id !== piece.id))} /><button type="button" className="sheet-candidate-title" onClick={() => { setActiveId(piece.id); setPageIndex(0); }} aria-pressed={piece.id === activeId}>{piece.name}</button></div>
        {piece.confidence !== 'high' && <span className="sheet-review-badge">Review pages</span>}{piece.reason && <p className="section-note">{piece.reason}</p>}
        <div className="sheet-candidate-fields"><label><span>Song name</span><input className="field" maxLength="200" value={piece.name} disabled={saving} onChange={event => editPiece(piece.id, 'name', event.target.value)} /></label><label><span>PDF pages</span><input className="field" value={piece.pageText} maxLength="200" disabled={saving} onChange={event => { editPiece(piece.id, 'pageText', event.target.value); if (piece.id === activeId) setPageIndex(0); }} /></label></div>
      </article>) : <p className="dialog-hint">No songs were suggested. Close this view and choose pages manually with Split into songs.</p>}</div>
      <section className="sheet-book-preview" aria-label="Sheet page preview"><div className="sheet-preview-controls"><button className="btn light small" disabled={!page || pageIndex <= 0} onClick={() => setPageIndex(previous => previous - 1)} aria-label="Previous sheet page">←</button><span>{page ? `Page ${page} · ${active?.name}` : 'Choose a song to preview'}</span><button className="btn light small" disabled={!page || pageIndex >= activePages.length - 1} onClick={() => setPageIndex(previous => previous + 1)} aria-label="Next sheet page">→</button></div><button className="sheet-zoom" type="button" disabled={!preview} onClick={() => setZoomed(previous => !previous)}>{zoomed ? 'Fit page' : 'Zoom in'}</button><div className={`sheet-page-image ${zoomed ? 'zoomed' : ''}`}>{previewLoading && <p role="status"><span className="spinner" />Loading page…</p>}{previewError && <p className="message visible" role="alert">{previewError}</p>}{preview && <img src={preview} alt={`Sheet music page ${page} from ${item.name}`} />}</div></section>
    </div>}
    {available === false && <p className="dialog-hint">Song suggestions and previews are available. Install the sheet recognition tools on the piano computer to convert them.</p>}
    {error && <p className="message visible" role="alert">{error}</p>}
    <div className="dialog-actions"><span className="sheet-selected-count" aria-live="polite">{selected.length} selected</span><button className="btn light" disabled={saving} onClick={onClose}>Close</button><button className="btn" disabled={saving || !selected.length || available !== true || book?.analysis_status !== 'ready'} onClick={addSelected}>{saving ? 'Starting conversion…' : `Add ${selected.length === 1 ? 'selected song' : 'selected songs'}`}</button></div>
  </dialog>;
}

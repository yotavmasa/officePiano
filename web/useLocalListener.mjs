import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalPiano } from './localPiano.mjs';

const VOLUME_KEY = 'piano-local-volume';

function savedVolume() {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(value) && localStorage.getItem(VOLUME_KEY) !== null ? Math.min(100, Math.max(0, value)) : 80;
  } catch { return 80; }
}

export function useLocalListener(loadSong, onEnd) {
  const engine = useRef(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const loaded = useRef({ id: '', parsed: null });
  const request = useRef(0);
  const [state, setState] = useState('stopped');
  const [song, setSong] = useState(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [volume, setVolumeValue] = useState(savedVolume);

  const piano = useCallback(() => {
    if (!engine.current) {
      engine.current = new LocalPiano({ onEnd: () => { setState('stopped'); setPosition(0); ended.current?.(); } });
      engine.current.setVolume(volume / 100);
    }
    engine.current.unlock();
    return engine.current;
  }, [volume]);

  useEffect(() => () => engine.current?.close(), []);

  useEffect(() => {
    if (state !== 'playing') return;
    const interval = setInterval(() => setPosition(engine.current.position), 250);
    return () => clearInterval(interval);
  }, [state]);

  const listen = useCallback(async (target, startAt = 0) => {
    const player = piano();
    const id = ++request.current;
    player.stop();
    setState('stopped');
    setPosition(0);
    setSong({ id: target.id, name: target.name });
    if (loaded.current.id !== target.id) {
      setLoading(true);
      try {
        const parsed = await loadSong(target.id);
        if (id !== request.current) return;
        if (!parsed.notes.length) throw Error('This song has no notes to play on this device.');
        loaded.current = { id: target.id, parsed };
      } catch (error) {
        if (id === request.current) setSong(null);
        throw error;
      } finally {
        if (id === request.current) setLoading(false);
      }
    }
    player.load(loaded.current.parsed);
    player.seek(startAt);
    setDuration(loaded.current.parsed.duration);
    setPosition(player.position);
    player.play();
    setState('playing');
  }, [piano, loadSong]);

  const pause = useCallback(() => {
    engine.current?.pause();
    setPosition(engine.current?.position || 0);
    setState(engine.current?.state || 'stopped');
  }, []);

  const resume = useCallback(() => {
    piano().play();
    setState('playing');
  }, [piano]);

  const stop = useCallback(() => {
    request.current += 1;
    engine.current?.stop();
    setLoading(false);
    setPosition(0);
    setState('stopped');
  }, []);

  const seek = useCallback(seconds => {
    engine.current?.seek(seconds);
    setPosition(engine.current?.position || 0);
  }, []);

  const setVolume = useCallback(value => {
    setVolumeValue(value);
    engine.current?.setVolume(value / 100);
    try { localStorage.setItem(VOLUME_KEY, String(value)); } catch {}
  }, []);

  const now = useCallback(() => engine.current?.position ?? 0, []);
  // Drops the loaded song so the next listen fetches its current playback sound.
  const forget = useCallback(() => { loaded.current = { id: '', parsed: null }; }, []);
  // Swaps in the song's current playback sound at the same place, keeping play or pause.
  const reload = useCallback(async () => {
    const player = engine.current, id = loaded.current.id;
    if (!player || !id) return forget();
    const ticket = ++request.current;
    const parsed = await loadSong(id);
    if (ticket !== request.current) return;
    const previous = player.state, at = player.position;
    player.load(parsed);
    loaded.current = { id, parsed };
    if (previous !== 'stopped') player.seek(at);
    if (previous === 'playing') player.play();
    setDuration(parsed.duration);
    setPosition(player.position);
    setState(previous);
  }, [loadSong, forget]);
  const press = useCallback((pitch, velocity) => piano().press(pitch, velocity), [piano]);
  const release = useCallback(pitch => engine.current?.release(pitch), []);

  return { state, song, position, duration, loading, volume, listen, pause, resume, stop, seek, setVolume, now, press, release, forget, reload };
}

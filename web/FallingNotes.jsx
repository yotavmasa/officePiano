import { useEffect, useRef, useState } from 'react';
import { HIGHEST_PITCH, LOWEST_PITCH, isBlackKey, keyLayout, longestNote, visibleNotes } from './fallingNotes.mjs';

const AHEAD_SECONDS = 3;
const COLORS = { background: '#5151ca', guide: '#ffffff14', hit: '#55ffa2', white: '#c8c8f5', black: '#ff8dff', key: '#ffffff', keyEdge: '#c8c8f5', blackKey: '#13163b', lit: '#55ffa2' };

const keyboardHeight = height => Math.min(84, Math.max(40, height * 0.22));

// Finds the key under a point in CSS pixels; black keys sit on top of white keys.
function keyAt(canvas, x, y) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const keyHeight = keyboardHeight(height);
  const roll = height - keyHeight;
  if (y < roll || y > height || x < 0 || x > width) return null;
  const keys = [...keyLayout(width)];
  const depth = (y - roll) / keyHeight;
  const black = depth < 0.6 && keys.find(([, key]) => key.black && x >= key.x && x < key.x + key.width);
  const match = black || keys.find(([, key]) => !key.black && x >= key.x && x < key.x + key.width);
  if (!match) return null;
  const [pitch, key] = match;
  const along = Math.min(1, depth / (key.black ? 0.6 : 1));
  return { pitch, velocity: Math.round(45 + 82 * along) };
}

function draw(canvas, notes, longest, now, pressed = new Set()) {
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const keyHeight = keyboardHeight(height);
  const roll = height - keyHeight;
  const keys = keyLayout(width);
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = COLORS.guide;
  for (let pitch = LOWEST_PITCH; pitch <= HIGHEST_PITCH; pitch += 1) {
    if (pitch % 12 === 0) context.fillRect(keys.get(pitch).x, 0, 1, roll);
  }
  const lit = new Set(pressed);
  const visible = notes ? visibleNotes(notes, now, AHEAD_SECONDS, longest) : [];
  for (const black of [false, true]) {
    context.fillStyle = black ? COLORS.black : COLORS.white;
    for (const note of visible) {
      const key = keys.get(note.pitch);
      if (!key || key.black !== black) continue;
      if (note.start <= now) lit.add(note.pitch);
      const bottom = roll - (note.start - now) / AHEAD_SECONDS * roll;
      const top = roll - (note.start + note.duration - now) / AHEAD_SECONDS * roll;
      const y = Math.max(0, top);
      const barHeight = Math.min(roll, bottom) - y;
      if (barHeight <= 0) continue;
      context.globalAlpha = 0.55 + 0.45 * (note.velocity / 127);
      context.beginPath();
      context.roundRect(key.x + 1, y, Math.max(1, key.width - 2), Math.max(2, barHeight), Math.min(3, key.width / 3));
      context.fill();
    }
  }
  context.globalAlpha = 1;
  context.fillStyle = COLORS.hit;
  context.fillRect(0, roll - 1, width, 2);
  for (const [pitch, key] of keys) {
    if (key.black) continue;
    context.fillStyle = lit.has(pitch) ? COLORS.lit : COLORS.key;
    context.fillRect(key.x + 0.5, roll + 1, key.width - 1, keyHeight - 4);
    context.fillStyle = COLORS.keyEdge;
    context.fillRect(key.x + 0.5, height - 3, key.width - 1, 3);
  }
  for (const [pitch, key] of keys) {
    if (!key.black) continue;
    context.fillStyle = lit.has(pitch) ? COLORS.lit : COLORS.blackKey;
    context.fillRect(key.x, roll + 1, key.width, keyHeight * 0.6);
  }
}

export default function FallingNotes({ songId, loadSong, getTime, playing, position, onPress, onRelease }) {
  const canvasRef = useRef(null);
  const pointers = useRef(new Map());
  const pressed = useRef(new Set());
  const redraw = useRef(() => {});
  const timeRef = useRef(getTime);
  timeRef.current = getTime;
  const [song, setSong] = useState({ id: '', notes: null, longest: 0, error: '' });

  useEffect(() => {
    if (!songId) return setSong({ id: '', notes: null, longest: 0, error: '' });
    let current = true;
    setSong({ id: songId, notes: null, longest: 0, error: '' });
    loadSong(songId).then(
      parsed => { if (current) setSong({ id: songId, notes: parsed.notes, longest: longestNote(parsed.notes), error: '' }); },
      error => { if (current) setSong({ id: songId, notes: null, longest: 0, error: error.message || 'Could not load the notes for this song.' }); },
    );
    return () => { current = false; };
  }, [songId, loadSong]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const render = () => draw(canvas, song.notes, song.longest, timeRef.current(), pressed.current);
    redraw.current = render;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * ratio);
      canvas.height = Math.round(canvas.clientHeight * ratio);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (!playing) return () => observer.disconnect();
    let frame = requestAnimationFrame(function loop() { render(); frame = requestAnimationFrame(loop); });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [song, playing]);

  useEffect(() => {
    if (!playing) draw(canvasRef.current, song.notes, song.longest, timeRef.current(), pressed.current);
  }, [position, playing, song]);

  const handlers = useRef({});
  handlers.current = { onPress, onRelease };
  function hold(pointerId, key) {
    const previous = pointers.current.get(pointerId);
    if (previous?.pitch === key?.pitch) return;
    if (previous) {
      pointers.current.delete(pointerId);
      if (![...pointers.current.values()].some(item => item.pitch === previous.pitch)) {
        pressed.current.delete(previous.pitch);
        handlers.current.onRelease?.(previous.pitch);
      }
    }
    if (key) {
      pointers.current.set(pointerId, key);
      if (!pressed.current.has(key.pitch)) {
        pressed.current.add(key.pitch);
        handlers.current.onPress?.(key.pitch, key.velocity);
      }
    }
    if (!playing) redraw.current();
  }
  const point = event => {
    const box = event.currentTarget.getBoundingClientRect();
    return keyAt(event.currentTarget, event.clientX - box.left, event.clientY - box.top);
  };
  useEffect(() => () => {
    for (const pitch of pressed.current) handlers.current.onRelease?.(pitch);
    pressed.current.clear();
    pointers.current.clear();
  }, []);

  const message = !songId ? 'Choose a song to see its notes.' : song.error || (!song.notes ? 'Loading notes…' : !song.notes.length ? 'This song has no piano notes to show.' : '');
  return <div className="falling-notes">
    <canvas ref={canvasRef} aria-hidden="true"
      onPointerDown={event => { const key = point(event); if (!key) return; event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch {} hold(event.pointerId, key); }}
      onPointerMove={event => { if (pointers.current.has(event.pointerId)) hold(event.pointerId, point(event)); }}
      onPointerUp={event => hold(event.pointerId, null)}
      onPointerCancel={event => hold(event.pointerId, null)}
      onLostPointerCapture={event => hold(event.pointerId, null)} />
    {message && <p className="falling-notes-message" role={song.error ? 'alert' : undefined}>{message}</p>}
  </div>;
}

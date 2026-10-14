import { useEffect, useRef, useState } from 'react';
import { HIGHEST_PITCH, LOWEST_PITCH, isBlackKey, keyLayout, longestNote, visibleNotes } from './fallingNotes.mjs';

const AHEAD_SECONDS = 3;
const COLORS = { background: '#1d342c', guide: '#ffffff0d', hit: '#d8e4bc55', white: '#d8e4bc', black: '#9fbf8a', key: '#e9eedb', keyEdge: '#c8d3b9', blackKey: '#213c32', lit: '#b9d48f' };

function draw(canvas, notes, longest, now) {
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const keyHeight = Math.min(84, Math.max(40, height * 0.22));
  const roll = height - keyHeight;
  const keys = keyLayout(width);
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = COLORS.guide;
  for (let pitch = LOWEST_PITCH; pitch <= HIGHEST_PITCH; pitch += 1) {
    if (pitch % 12 === 0) context.fillRect(keys.get(pitch).x, 0, 1, roll);
  }
  const lit = new Set();
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

export default function FallingNotes({ songId, loadSong, getTime, playing, position }) {
  const canvasRef = useRef(null);
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
    const render = () => draw(canvas, song.notes, song.longest, timeRef.current());
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
    if (!playing) draw(canvasRef.current, song.notes, song.longest, timeRef.current());
  }, [position, playing, song]);

  const message = !songId ? 'Choose a song to see its notes.' : song.error || (!song.notes ? 'Loading notes…' : !song.notes.length ? 'This song has no piano notes to show.' : '');
  return <div className="falling-notes">
    <canvas ref={canvasRef} aria-hidden="true" />
    {message && <p className="falling-notes-message" role={song.error ? 'alert' : undefined}>{message}</p>}
  </div>;
}

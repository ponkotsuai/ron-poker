// Game feel: cut-ins, banners, flying chips, screen shake and synthesized sound.
// Everything is drawn with DOM/CSS/SVG and the Web Audio API; there are no asset files.

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let layer = null;
let busyUntil = 0;

function fxLayer() {
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fx';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Resolves when the current cut-in has finished. */
export function idle() {
  return wait(Math.max(0, busyUntil - Date.now()));
}

// ---- ink brush stroke --------------------------------------------------------
// A wide stroke with ragged, dry-brush edges (turbulence displacement), plus a few drops.

let strokeN = 0;
function inkSplash(color) {
  const id = `rough${strokeN++}`;
  const seed = Math.floor(Math.random() * 1000);
  let drops = '';
  for (let i = 0; i < 9; i++) {
    const x = 40 + Math.random() * 920;
    const top = Math.random() < 0.5;
    const y = top ? 18 - Math.random() * 14 : 182 + Math.random() * 14;
    drops += `<ellipse cx="${x}" cy="${y}" rx="${3 + Math.random() * 9}" ry="${2 + Math.random() * 5}"/>`;
  }
  return `<svg class="ink" viewBox="0 0 1000 200" preserveAspectRatio="none" fill="${color}">
    <defs><filter id="${id}" x="-5%" y="-30%" width="110%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves="3" seed="${seed}"/>
      <feDisplacementMap in="SourceGraphic" scale="46"/>
    </filter></defs>
    <g filter="url(#${id})"><rect x="0" y="34" width="1000" height="132" rx="40"/>${drops}</g></svg>`;
}

function rays() {
  let s = '';
  for (let i = 0; i < 18; i++) s += `<polygon points="50,50 ${50 + 70 * Math.cos(i / 18 * 2 * Math.PI)},${50 + 70 * Math.sin(i / 18 * 2 * Math.PI)} ${50 + 70 * Math.cos((i + 0.45) / 18 * 2 * Math.PI)},${50 + 70 * Math.sin((i + 0.45) / 18 * 2 * Math.PI)}"/>`;
  return `<svg class="rays" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">${s}</svg>`;
}

/**
 * Big brush-script announcement.
 * kind: 'ron' | 'tsumo' | 'riichi' | 'yakuman'
 * opts: { title, kanji, sub, who, tone: 'gold'|'red', portrait }
 */
export function cutIn(kind, opts = {}) {
  const dur = reduceMotion ? 900 : kind === 'riichi' ? 1100 : kind === 'yakuman' ? 2600 : 1700;
  busyUntil = Math.max(busyUntil, Date.now() + dur);
  const el = document.createElement('div');
  el.className = `cutin cutin-${kind}`;
  el.innerHTML = `
    ${kind === 'riichi' ? '' : rays()}
    <div class="band">${inkSplash(kind === 'riichi' ? 'var(--fx-ink-red)' : 'var(--fx-ink)')}
      ${opts.portrait ? `<div class="portrait">${opts.portrait}</div>` : ''}
      <div class="words">
        ${opts.who ? `<span class="who">${opts.who}</span>` : ''}
        <span class="title">${opts.title}</span>
        ${opts.kanji ? `<span class="kanji">${opts.kanji}</span>` : ''}
        ${opts.sub ? `<span class="sub">${opts.sub}</span>` : ''}
      </div>
    </div>`;
  fxLayer().appendChild(el);
  if (kind !== 'riichi' && !reduceMotion) shake(kind === 'yakuman' ? 14 : 8);
  setTimeout(() => el.classList.add('out'), dur - 280);
  setTimeout(() => el.remove(), dur);
  return idle();
}

/** A short ribbon across the table, e.g. "Hand 3". */
export function banner(text, sub = '') {
  const el = document.createElement('div');
  el.className = 'banner';
  el.innerHTML = `<span class="b-text">${text}</span>${sub ? `<span class="b-sub">${sub}</span>` : ''}`;
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), reduceMotion ? 700 : 1500);
}

export function shake(px = 8) {
  if (reduceMotion) return;
  const root = document.querySelector('.table');
  if (!root) return;
  root.animate([
    { transform: 'translate(0,0)' },
    { transform: `translate(${-px}px, ${px / 2}px)` },
    { transform: `translate(${px}px, ${-px / 2}px)` },
    { transform: `translate(${-px / 2}px, ${px / 3}px)` },
    { transform: 'translate(0,0)' },
  ], { duration: 420, easing: 'ease-out' });
}

/** Chips fly from one element to another. */
export function coins(fromEl, toEl, amount) {
  if (!fromEl || !toEl || amount <= 0) return;
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const n = Math.min(14, 3 + Math.round(amount / 2));
  for (let i = 0; i < n; i++) {
    const c = document.createElement('span');
    c.className = 'chip-fly';
    fxLayer().appendChild(c);
    const x0 = a.left + a.width / 2 + (Math.random() - 0.5) * 40;
    const y0 = a.top + a.height / 2 + (Math.random() - 0.5) * 20;
    const x1 = b.left + b.width / 2 + (Math.random() - 0.5) * 30;
    const y1 = b.top + b.height / 2 + (Math.random() - 0.5) * 16;
    const lift = 60 + Math.random() * 60;
    const delay = i * 45;
    const anim = c.animate([
      { transform: `translate(${x0}px, ${y0}px) scale(0.6)`, opacity: 0 },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) scale(1.1) rotate(180deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${x1}px, ${y1}px) scale(0.8) rotate(360deg)`, opacity: 0.9 },
    ], { duration: reduceMotion ? 1 : 750, delay, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
    anim.onfinish = () => c.remove();
    if (i % 3 === 0) setTimeout(() => sound('coin'), delay + 650);
  }
}

// ---- sound ------------------------------------------------------------------
// Short synthesized effects; nothing plays until the player has interacted with the page.

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('ronpoker.muted') === '1'; } catch { /* default on */ }

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('ronpoker.muted', m ? '1' : '0'); } catch { /* ignore */ }
}

function audio() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(ac, { freq, type = 'sine', at = 0, dur = 0.2, gain = 0.2, slide = null }) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ac.currentTime + at);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, ac.currentTime + at + dur);
  g.gain.setValueAtTime(0.0001, ac.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + at);
  o.stop(ac.currentTime + at + dur + 0.05);
}

function noise(ac, { at = 0, dur = 0.08, gain = 0.25, freq = 2000, q = 1 }) {
  const buf = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * dur)), ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ac.destination);
  src.start(ac.currentTime + at);
}

export function sound(name) {
  const ac = audio();
  if (!ac) return;
  switch (name) {
    case 'tile': // a tile clacking on felt
      noise(ac, { dur: 0.05, gain: 0.5, freq: 2600, q: 2 });
      tone(ac, { freq: 900, type: 'triangle', dur: 0.05, gain: 0.08 });
      break;
    case 'draw':
      noise(ac, { dur: 0.12, gain: 0.15, freq: 5000, q: 0.7 });
      break;
    case 'deal':
      for (let i = 0; i < 4; i++) noise(ac, { at: i * 0.07, dur: 0.06, gain: 0.3, freq: 2200 + i * 200, q: 2 });
      break;
    case 'riichi': // wooden clack + rising tone
      noise(ac, { dur: 0.06, gain: 0.6, freq: 1200, q: 4 });
      tone(ac, { freq: 440, type: 'triangle', at: 0.05, dur: 0.35, gain: 0.18, slide: 880 });
      break;
    case 'ron': // taiko hit + bright chord
      tone(ac, { freq: 90, type: 'sine', dur: 0.5, gain: 0.7, slide: 45 });
      noise(ac, { dur: 0.15, gain: 0.4, freq: 300, q: 0.8 });
      [523, 659, 784, 1046].forEach((f, i) => tone(ac, { freq: f, type: 'triangle', at: 0.08 + i * 0.05, dur: 0.6, gain: 0.12 }));
      break;
    case 'tsumo':
      tone(ac, { freq: 110, type: 'sine', dur: 0.4, gain: 0.5, slide: 55 });
      [587, 740, 880, 1175].forEach((f, i) => tone(ac, { freq: f, type: 'triangle', at: 0.06 + i * 0.06, dur: 0.6, gain: 0.12 }));
      break;
    case 'yakuman':
      tone(ac, { freq: 70, type: 'sine', dur: 1.2, gain: 0.8, slide: 35 });
      [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(ac, { freq: f, type: 'sawtooth', at: 0.1 + i * 0.09, dur: 1.2, gain: 0.05 }));
      break;
    case 'coin':
      tone(ac, { freq: 1800 + Math.random() * 400, type: 'square', dur: 0.08, gain: 0.04 });
      tone(ac, { freq: 2600, type: 'sine', at: 0.03, dur: 0.12, gain: 0.05 });
      break;
    case 'turn':
      tone(ac, { freq: 660, type: 'sine', dur: 0.12, gain: 0.08 });
      break;
    case 'gameEnd':
      [392, 494, 587, 784].forEach((f, i) => tone(ac, { freq: f, type: 'triangle', at: i * 0.12, dur: 0.5, gain: 0.12 }));
      break;
    default:
  }
}

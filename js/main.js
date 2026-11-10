// Browser UI: one human seat against three AI seats.

import { Game, RIICHI_MIN } from './game.js';
import { AIController, PERSONALITIES, moodOf } from './ai.js';
import { isTenpai, BASE_POINTS, CAT_KEYS, START_POINTS } from './engine.js';
import { t, getLang, setLang } from './i18n.js';
import * as chain from './chain.js';
import * as fx from './fx.js';
import { CHARACTERS, CHARACTER_IDS, characterOf, portraitUrl } from './characters.js';

const NEAR_PER_POINT = 0.1;
// Set at build time. The chat preview cannot reach NEAR, so it offers practice mode only.
const PREVIEW = typeof __PREVIEW__ !== 'undefined' && __PREVIEW__;
const LIVE_URL = 'https://ponkotsuai.github.io/ron-poker/';
const HUMAN = 0;
// Turn order is 0 → 1 → 2 → 3. Seat 1 sits to your right, 2 across, 3 to your left.
// Seats are always shown from your point of view: you are seat 0.
const EXPR_MS = 4500;

const $ = sel => document.querySelector(sel);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---- state -------------------------------------------------------------

const ui = {
  game: null,
  log: [],
  bubbles: {},
  moods: {},
  pending: null, // { type: 'discard'|'tsumo'|'ron', resolve, ... }
  selected: null,
  lastDiscard: null,
  thinking: null,
  title: true, // the title screen sits over everything until you press Play
  overlay: null, // intro | result | final | rules | chain | settings | ranking | null
  once: {}, // one-shot animations: { key: { v, at } }, honoured for a moment after they are set
  seats: null, // set below once your character is known
  expr: {}, // seat → { e: 'joy'|'angry'|'sad'|'fun', until } short reactions on the avatars
  overlayBefore: null,
  result: null,
  resolveOverlay: null,
};

// ---- nickname ----

function loadNick() {
  try { return localStorage.getItem('ronpoker.nick') || ''; } catch { return ''; }
}
function saveNick(n) {
  try { localStorage.setItem('ronpoker.nick', n); } catch { /* ignore */ }
}
ui.nick = loadNick();

// ---- characters ----

function loadChar() {
  try { const c = localStorage.getItem('ronpoker.char'); return CHARACTERS[c] ? c : 'nia'; } catch { return 'nia'; }
}
function saveChar(c) {
  try { localStorage.setItem('ronpoker.char', c); } catch { /* ignore */ }
}
ui.char = loadChar();

// Practice: you plus three computer players drawn from the rest of the cast.
function practiceSeats() {
  const rest = CHARACTER_IDS.filter(id => id !== ui.char);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [{ kind: 'human', character: ui.char }, ...rest.slice(0, 3).map(id => ({ kind: 'ai', id }))];
}
ui.practice = practiceSeats();
ui.seats = ui.practice;

const lang = () => (getLang() === 'ja' ? 'ja' : 'en');
const charName = id => CHARACTERS[characterOf(id)].name[lang()];
const charStyle = id => CHARACTERS[characterOf(id)].style[lang()];
const charBio = id => CHARACTERS[characterOf(id)].bio[lang()];

function seatInfo(seat) {
  return ui.seats[seat] || ui.practice[seat];
}

function seatChar(seat) {
  if (seat === HUMAN) return ui.char;
  const s = seatInfo(seat);
  return characterOf(s.character || s.id);
}

// A short reaction (win, deal-in, riichi); otherwise the face follows the score.
function setExpr(seat, e, ms = EXPR_MS) {
  ui.expr[seat] = { e, until: Date.now() + ms };
  setTimeout(() => { if (!ui.overlay || ui.overlay === 'result') render(); }, ms + 30);
}

function seatExpr(seat) {
  const x = ui.expr[seat];
  if (x && x.until > Date.now()) return x.e;
  const g = ui.game;
  if (!g) return 'main';
  const mood = moodOf(g.points[seat], START_POINTS);
  return mood === 'survival' ? 'sad' : mood === 'comfortable' ? 'fun' : 'main';
}

function avatar(seat, cls = '') {
  return `<img class="face ${cls}" src="${portraitUrl(seatChar(seat), seatExpr(seat))}" alt="" draggable="false">`;
}

function setOnce(key, v) { ui.once[key] = { v, at: Date.now() }; }
function once(key) {
  const o = ui.once[key];
  return o && Date.now() - o.at < 350 ? o.v : undefined;
}

function seatName(seat) {
  if (seat === HUMAN) return ui.nick ? escapeHtml(ui.nick) : t('you');
  const s = seatInfo(seat);
  if (s.kind === 'ai') return charName(s.character || s.id);
  return escapeHtml(s.name || '?');
}

function cardLabel(c) {
  if (c.joker) return 'JOKER';
  const r = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.r] || String(c.r);
  return r + { s: '♠', h: '♥', d: '♦', c: '♣' }[c.s];
}

function pushLog(text, kind = '') {
  ui.log.unshift({ text, kind, id: Math.random() });
  ui.log.length = Math.min(ui.log.length, 80);
}

function think(seat, key, params = {}) {
  const p = { ...params };
  if (p.hand) p.hand = t(`hands.${p.hand}`);
  if (p.target) p.target = t(`hands.${p.target}`);
  if (p.card) p.card = cardLabel({ r: parseRank(p.card), s: p.card.slice(-1), joker: false });
  ui.bubbles[seat] = { key, params: p, at: Date.now() };
  const [open, close] = getLang() === 'ja' ? ['「', '」'] : [': “', '”'];
  pushLog(`${seatName(seat)}${open}${t(key, p)}${close}`, 'think');
}

function parseRank(id) {
  return Number(id.slice(0, -1));
}

// ---- controllers -------------------------------------------------------

class HumanController {
  chooseTsumo(view, ev) {
    return new Promise(resolve => {
      ui.pending = { type: 'tsumo', ev, resolve };
      render();
    });
  }

  chooseRon(view, tile, ev, from) {
    return new Promise(resolve => {
      ui.pending = { type: 'ron', ev, tile, from, resolve };
      render();
    });
  }

  chooseDiscard(view) {
    return new Promise(resolve => {
      ui.selected = null;
      ui.pending = { type: 'discard', resolve };
      render();
    });
  }

  async beforeAutoDiscard() {
    render();
    await sleep(reduceMotion ? 300 : 900);
  }
}

// Game speed (practice): how long the computer players take per move. Online tables are paced
// by the referee.
const SPEEDS = { slow: 1.6, normal: 1, fast: 0.55 };
function loadSpeed() {
  try { const v = localStorage.getItem('ronpoker.speed'); return SPEEDS[v] ? v : 'normal'; } catch { return 'normal'; }
}
ui.speed = loadSpeed();
const pace = ms => Math.round(ms * SPEEDS[ui.speed]);

class PacedAI {
  constructor(seat, ai) { this.seat = seat; this.ai = ai; }

  async wrap(fn, ms) {
    ui.thinking = this.seat;
    render();
    await sleep(reduceMotion ? 150 : ms);
    const out = await fn();
    ui.thinking = null;
    return out;
  }

  chooseTsumo(view, ev) { return this.wrap(() => this.ai.chooseTsumo(view, ev), pace(800)); }
  chooseRon(view, tile, ev, from) { return this.wrap(() => this.ai.chooseRon(view, tile, ev, from), pace(800)); }
  chooseDiscard(view) { return this.wrap(() => this.ai.chooseDiscard(view), pace(1300)); }
  beforeAutoDiscard() { return this.wrap(() => null, pace(1000)); }
}

// ---- game wiring -------------------------------------------------------

function newGame(seed = (Math.random() * 2 ** 32) >>> 0) {
  const seats = [0, 1, 2, 3].map(seat => {
    if (seat === HUMAN) return { name: 'you', controller: new HumanController() };
    const id = ui.seats[seat].id;
    const ai = new AIController({
      personality: PERSONALITIES[id],
      startPoints: START_POINTS,
      think: (key, params) => think(seat, key, params),
    });
    return { name: id, controller: new PacedAI(seat, ai) };
  });
  ui.log = [];
  ui.bubbles = {};
  ui.moods = {};
  ui.expr = {};
  ui.lastDiscard = null;
  ui.chat = {};
  ui.game = new Game({ seats, seed, onEvent, afterHand: showResult });
  return ui.game;
}

function onEvent(type, e) {
  const g = ui.game;
  if (type === 'handStart') {
    ui.lastDiscard = null;
    if (e.handNo === 0) fx.preloadVoices([0, 1, 2, 3].map(seatChar));
    setOnce('deal', true);
    fx.banner(t('handBanner', { n: e.handNo + 1 }), t('handBannerSub', { n: e.handNo + 1, total: g.totalHands }));
    fx.sound('deal');
    pushLog(t('logHandStart', { n: e.handNo + 1, total: g.totalHands, dealer: seatName(e.dealer) }), 'sep');
    for (const seat of [1, 2, 3]) {
      if (ui.seats[seat]?.kind !== 'ai') continue;
      const mood = moodOf(g.points[seat], START_POINTS);
      if (mood !== (ui.moods[seat] || 'steady') && mood !== 'steady') {
        think(seat, `thinkMood.${mood}`, { points: g.points[seat] });
      }
      ui.moods[seat] = mood;
    }
  }
  if (type === 'draw' && e.seat === HUMAN) {
    setOnce('drawn', true);
    fx.sound('draw');
  }
  if (type === 'discard') {
    ui.lastDiscard = { seat: e.seat, id: e.card.id };
    setOnce('land', `${e.seat}:${e.card.id}`);
    fx.sound('tile');
    if (e.riichi) {
      setOnce('stick', e.seat);
      setOnce('pot', true);
      setExpr(e.seat, 'fun');
      fx.idle().then(() => fx.coins(seatEl(e.seat), $('.compass'), 1));
      fx.sound('riichi');
      fx.voice(seatChar(e.seat), 'riichi');
      fx.cutIn('riichi', { title: 'リーチ', kanji: '立直', who: seatName(e.seat), portrait: portraitImg(e.seat, 'fun') });
    }
    const key = e.riichi ? 'logRiichi' : 'logDiscard';
    pushLog(t(key, { name: seatName(e.seat), card: cardLabel(e.card) }), e.riichi ? 'riichi' : '');
  }
  if (type === 'win') {
    const params = { name: seatName(e.winner), hand: t(`hands.${e.ev.key}`), points: e.ev.points };
    const big = e.ev.cat >= 8;
    const total = e.ev.points * (e.type === 'ron' ? 3 : 1);
    fx.sound(big ? 'yakuman' : e.type);
    fx.voice(seatChar(e.winner), e.type);
    setExpr(e.winner, 'joy', 7000);
    if (e.type === 'ron') setExpr(e.loser, 'angry', 7000);
    else for (const x of e.transfers || []) if (x.from !== e.winner) setExpr(x.from, 'sad', 7000);
    fx.cutIn(big ? 'yakuman' : e.type, {
      portrait: portraitImg(e.winner, 'joy'),
      title: big ? '役満' : e.type === 'ron' ? 'ロン' : 'ツモ',
      kanji: big ? t(`hands.${e.ev.key}`) : e.type === 'ron' ? '栄和' : '自摸',
      who: seatName(e.winner),
      sub: `${t(`hands.${e.ev.key}`)}${e.ev.jokers ? ` × JOKER ${e.ev.mult}` : ''}　${total}${t('pts')}`,
    });
    // chips fly from whoever paid to the winner once the cut-in clears
    fx.idle().then(() => {
      for (const x of e.transfers || []) fx.coins(seatEl(x.from), seatEl(x.to), x.amount);
      if (e.potWon) fx.coins($('.compass'), seatEl(e.winner), e.potWon);
    });
    if (e.type === 'ron') pushLog(t('logRon', { ...params, loser: seatName(e.loser) }), 'win');
    else pushLog(t('logTsumo', params), 'win');
  }
  if (type === 'fold') {
    setOnce('pot', true);
    setExpr(e.seat, 'sad', 4000);
    fx.coins(seatEl(e.seat), $('.compass'), e.amount || 1);
    fx.banner(t('foldBanner', { name: seatName(e.seat) }), t('foldBannerSub'));
    pushLog(t('logFold', { name: seatName(e.seat) }), '');
  }
  if (type === 'foldWin') {
    setExpr(e.winner, 'joy', 7000);
    fx.sound('gameEnd');
    fx.banner(t('foldWinBanner'), t('foldWinSub', { name: seatName(e.winner), n: e.potWon }));
    fx.coins($('.compass'), seatEl(e.winner), e.potWon);
    pushLog(t('foldWinSub', { name: seatName(e.winner), n: e.potWon }), 'win');
  }
  if (type === 'exhausted') {
    pushLog(t('logExhausted'), 'sep');
    fx.banner('流局', t('resultExhausted'));
  }
  if (type === 'gameEnd') fx.sound('gameEnd');
  render();
}

function portraitImg(seat, e) {
  return `<img src="${portraitUrl(seatChar(seat), e)}" alt="">`;
}

function seatEl(seat) {
  return $(`#np-${seat}`);
}

// ---- first-game guide (practice only) ----
// Nia explains each thing the first time it happens. Ends after the first hand, or on Skip.
function loadTut() {
  try { return localStorage.getItem('ronpoker.guide') !== 'done'; } catch { return true; }
}
ui.tut = { on: loadTut(), seen: new Set(), current: null };

function endTut() {
  ui.tut.on = false;
  ui.tut.current = null;
  try { localStorage.setItem('ronpoker.guide', 'done'); } catch { /* ignore */ }
}

function tutTips() {
  const g = ui.game;
  const p = ui.pending;
  const me = g.players[HUMAN];
  const marks = p?.type === 'discard' && me.hand.some((_, i) => isTenpai(me.hand.filter((__, j) => j !== i)));
  const riichiSeat = [1, 2, 3].find(s => g.players[s].riichi);
  return [
    ['goal', true, {}],
    ['ron', p?.type === 'ron', {}],
    ['tsumo', p?.type === 'tsumo', {}],
    ['riichi', marks && !me.riichi, {}],
    ['discard', p?.type === 'discard' && !me.riichi, {}],
    ['oppRiichi', riichiSeat != null, { name: riichiSeat != null ? seatName(riichiSeat) : '' }],
  ];
}

function guide() {
  const g = ui.game;
  if (!ui.tut.on || ui.chain || !g || g.over) { return ''; }
  const tips = tutTips();
  const cur = ui.tut.current && tips.find(([k]) => k === ui.tut.current);
  // A tip about an action goes away once you have done it.
  if (cur && !cur[1] && !['goal', 'oppRiichi'].includes(cur[0])) { ui.tut.seen.add(cur[0]); ui.tut.current = null; }
  const next = tips.find(([k, cond]) => cond && !ui.tut.seen.has(k));
  // Urgent tips (your turn, a win) replace a waiting one.
  if (next && (!ui.tut.current || tips.findIndex(([k]) => k === next[0]) < tips.findIndex(([k]) => k === ui.tut.current))) ui.tut.current = next[0];
  const show = tips.find(([k]) => k === ui.tut.current);
  if (!show) return '';
  const fresh = ui.tut.lastShown !== show[0];
  ui.tut.lastShown = show[0];
  return `
    <aside class="guide ${fresh ? 'pop' : ''}" role="note">
      <img src="${portraitUrl('nia', 'joy')}" alt="" draggable="false">
      <div>
        <p class="g-who">${t('guideWho')}</p>
        <p>${t(`tut.${show[0]}`, show[2])}</p>
        <div class="g-btns">
          <button type="button" class="act gold" data-act="tutOk">${t('guideOk')}</button>
          <button type="button" class="act ghost" data-act="tutSkip">${t('guideSkip')}</button>
        </div>
      </div>
    </aside>`;
}

async function showResult(record) {
  // let the cut-in and the flying chips play before the result sheet covers the table
  await fx.idle();
  if (record.type !== 'exhausted') await sleep(reduceMotion ? 100 : 900);
  if (ui.tut.on && !ui.chain) endTut(); // the first hand is the lesson
  return new Promise(resolve => {
    ui.result = record;
    ui.overlay = 'result';
    ui.resolveOverlay = resolve;
    render();
    $('#overlay .primary')?.focus();
  });
}

async function startGame() {
  ui.chain = null;
  ui.practice = practiceSeats();
  ui.seats = ui.practice;
  const g = newGame();
  ui.overlay = null;
  render();
  await g.play();
  ui.overlay = 'final';
  render();
}

// ---- on-chain mode -----------------------------------------------------
// The referee service runs the game; this page mirrors its state and sends your moves.

function chainStep(key, data = {}) {
  const c = ui.chain;
  if (!c) return;
  const params = { ...data };
  if (params.who) params.who = charName(params.who);
  if (params.by) params.by = charName(params.by);
  if (params.name) params.name = escapeHtml(params.name);
  c.steps.push({ key, params, hash: data.hash || null });
  pushLog(t(key, params), 'chain');
  render();
}

async function refreshBankrolls() {
  const c = ui.chain;
  if (!c) return;
  const ids = { ...(c.agents || {}) };
  if (c.human) ids.human = c.human;
  for (const [k, id] of Object.entries(ids)) {
    try { c.bankrolls[k] = await chain.bankrollOf(id); } catch { /* keep last */ }
  }
  render();
}

function chainFail(e) {
  console.error(e);
  if (!ui.chain) return;
  ui.chain.error = String(e?.message || e).slice(0, 200);
  ui.chain.busy = false;
  render();
}

// ---- seat rotation ----
// The referee numbers seats 0-3 for the table. Here you are always seat 0 (bottom).

function toLocal(seat) {
  const you = ui.chain?.you ?? 0;
  return seat == null ? seat : (seat - you + 4) % 4;
}
function rotate(arr) {
  const you = ui.chain?.you ?? 0;
  return arr ? [0, 1, 2, 3].map(i => arr[(i + you) % 4]) : arr;
}
function localRecord(r) {
  if (!r) return r;
  return {
    ...r,
    winner: toLocal(r.winner), loser: toLocal(r.loser), points: rotate(r.points),
    transfers: (r.transfers || []).map(x => ({ ...x, from: toLocal(x.from), to: toLocal(x.to) })),
    potFrom: (r.potFrom || []).map(x => ({ ...x, from: toLocal(x.from) })),
    refunds: (r.refunds || []).map(x => ({ ...x, to: toLocal(x.to) })),
  };
}
function localEvent(type, e) {
  if (type === 'handStart') return { ...e, dealer: toLocal(e.dealer) };
  if (type === 'draw' || type === 'discard' || type === 'fold') return { ...e, seat: toLocal(e.seat) };
  if (type === 'win' || type === 'exhausted' || type === 'foldWin') return localRecord(e);
  if (type === 'gameEnd') return { ...e, points: rotate(e.points) };
  return e;
}

// A stand-in for the local Game object, built from the referee's snapshots.
function mirrorGame(s) {
  return {
    remote: true,
    handNo: s.handNo, totalHands: s.totalHands, dealer: toLocal(s.dealer), turn: toLocal(s.turn), over: s.over,
    points: rotate(s.points), wall: { length: s.wallCount }, seed: s.seedHash, pot: s.pot || 0,
    players: rotate(s.players).map(p => ({ ...p, seat: toLocal(p.seat), hand: p.hand || Array.from({ length: p.handCount }, () => null) })),
  };
}

// Each connection is tied to the game it was opened for; messages from an older game are ignored.
function listen(state) {
  return chain.connectReferee(m => onRefereeMessage(m, state), () => onRefereeClose(state));
}

function onRefereeMessage(m, state) {
  const c = ui.chain;
  if (!c || c !== state) return;
  switch (m.t) {
    case 'hello':
      c.agents = m.agents;
      c.busy = false;
      if (c.phase === 'needPay' || c.phase === 'joining') {
        // Back from the background: the referee sends the table again if it is still open.
        if (m.restored !== 'table') { c.phase = 'lobby'; c.lobby = { mode: 'idle' }; c.tableId = null; c.session = null; c.error = t('tableGone'); }
      } else {
        c.phase = 'lobby';
        if (m.restored !== 'room') c.lobby = { mode: 'idle' };
      }
      refreshBankrolls();
      render();
      break;
    case 'lobby':
      c.lobby = m;
      if (m.mode !== 'idle') c.error = null;
      render();
      break;
    case 'step':
      chainStep(m.key, m.params);
      if (m.key === 'chainGameOn') refreshBankrolls();
      break;
    case 'opened': {
      refreshBankrolls();
      const again = c.tableId === m.tableId;
      c.tableId = m.tableId;
      c.you = m.seat;
      ui.seats = rotate(m.seats);
      c.lobby = null;
      if (again && c.session) {
        // We paid while the connection was down: tell the referee now.
        c.phase = 'joining';
        if (!m.paid) c.conn.send({ t: 'paid', ...chain.signSeat(c.session, c.tableId, c.human) });
        render();
        break;
      }
      if (again && c.phase === 'joining') { render(); break; } // still in the wallet
      c.phase = 'needPay';
      c.busy = false;
      if (!again) chainStep('chainHumanPay'); else render();
      break;
    }
    case 'state':
      ui.game = mirrorGame(m.game);
      if (c.phase !== 'playing' && !m.game.over) { c.phase = 'playing'; ui.overlay = null; }
      render();
      break;
    case 'event':
      if (m.type === 'handStart' && ui.overlay === 'result') { ui.overlay = null; ui.resolveOverlay = null; }
      // The referee played for you when the clock ran out.
      if (ui.pending && (m.type !== 'discard' || toLocal(m.e.seat) === HUMAN) && m.type !== 'draw') { ui.pending = null; ui.selected = null; }
      if (m.type === 'gameEnd') {
        c.phase = 'settling';
        c.busy = true;
        ui.overlay = 'final';
        chainStep('chainSettling');
      }
      onEvent(m.type, localEvent(m.type, m.e));
      break;
    case 'chat':
      showChat(toLocal(m.seat), m.stamp ? { stamp: m.stamp } : { text: String(m.text || '') });
      break;
    case 'think':
      ui.thinking = null;
      think(toLocal(m.seat), m.key, m.params);
      render();
      break;
    case 'thinking':
      ui.thinking = toLocal(m.seat);
      render();
      break;
    case 'prompt':
      ui.thinking = null;
      if (m.kind === 'next') {
        if (m.record) showResult(localRecord(m.record)).then(() => c.conn.send({ t: 'decide', kind: 'next', value: true }));
      } else if (m.kind) {
        ui.selected = null;
        ui.pending = {
          type: m.kind, ev: m.ev, tile: m.tile, from: toLocal(m.from),
          resolve: value => c.conn.send({ t: 'decide', kind: m.kind, value }),
          deadline: m.ms ? Date.now() + m.ms : null, ms: m.ms,
        };
        if (m.ms > 6000) {
          const p = ui.pending;
          setTimeout(() => { if (ui.pending === p) { fx.sound('turn'); render(); } }, m.ms - 5000);
        }
        render();
      }
      break;
    case 'settled':
      c.settled = m;
      c.phase = 'settled';
      c.busy = false;
      ui.overlay = 'final';
      chainStep('chainSettled', { id: m.tableId, hash: m.hash });
      refreshBankrolls();
      break;
    case 'aborted':
      chainStep(m.reason === 'notEveryonePaid' ? 'chainNotEveryonePaid' : 'chainAborted', { id: m.tableId, hash: m.hash });
      c.phase = 'aborted';
      c.busy = false;
      ui.overlay = 'chain';
      render();
      break;
    case 'error':
      if (c.phase === 'playing') ui.overlay = 'chain';
      chainFail(new Error(m.message));
      break;
    default:
  }
}

// Phones suspend a page in the background (switching to a chat app to send the room code, or
// to the wallet to pay), which drops the connection. Reconnect as soon as the page is back:
// the referee keeps your room, your unpaid seat and your game for a while.
function onRefereeClose(state) {
  const c = ui.chain;
  if (!c || c !== state || c.phase === 'settled' || c.phase === 'aborted' || c.closing || c.phase === 'connecting') return;
  c.offline = true;
  c.tries = 0;
  render();
  setTimeout(() => reconnect(c), 800);
}

function reconnect(c) {
  if (ui.chain !== c || c.closing || !c.offline || c.reconnecting) return;
  if (document.visibilityState === 'hidden') return; // tried again when the page is shown
  c.reconnecting = true;
  const conn = listen(c);
  conn.ready.then(() => {
    c.conn = conn;
    c.offline = false;
    c.reconnecting = false;
    if (c.phase === 'playing' && c.session && c.tableId != null) {
      // Pick the game up where it is. Meanwhile the referee has played safe moves for you.
      conn.send({ t: 'resume', tableId: c.tableId, account: c.human, ...chain.signSeat(c.session, c.tableId, c.human) });
    } else {
      conn.send({ t: 'hello', account: c.human, nickname: ui.nick, character: ui.char });
    }
    render();
  }).catch(() => {
    c.reconnecting = false;
    c.tries = (c.tries || 0) + 1;
    if (c.tries > 20) { c.offline = false; chainFail(new Error(t('refereeLost'))); return; }
    render();
    setTimeout(() => reconnect(c), Math.min(8000, 1000 * c.tries));
  });
}

document.addEventListener('visibilitychange', () => {
  const c = ui.chain;
  if (document.visibilityState !== 'visible' || !c) return;
  if (c.offline) reconnect(c);
  else if (c.conn && c.conn.ws.readyState > 1) onRefereeClose(c);
});

// Step 1 (click): connect the wallet and reach the referee's lobby.
async function startChainGame() {
  if (ui.chain?.conn) { ui.chain.closing = true; ui.chain.conn.close(); }
  ui.chain = { phase: 'connecting', human: null, you: 0, tableId: null, session: null, agents: null, lobby: null, steps: [], bankrolls: {}, error: null, busy: true, settled: null, conn: null };
  ui.overlay = 'chain';
  render();
  try {
    chainStep('chainConnecting');
    const human = (await chain.currentAccount()) || (await chain.connectWallet());
    if (!human) throw new Error(t('noAccount'));
    ui.chain.human = human;
    chainStep('chainConnected', { account: human });
    chainStep('chainReferee');
    const conn = listen(ui.chain);
    ui.chain.conn = conn;
    await conn.ready;
    conn.send({ t: 'hello', account: human, nickname: ui.nick, character: ui.char });
  } catch (e) { chainFail(e); }
}

// Step 2: find a table, either by random match or in a room with friends.
function lobbyAction(act) {
  const c = ui.chain;
  if (c?.offline) { reconnect(c); return; }
  if (!c?.conn || c.conn.ws.readyState !== 1) { startChainGame(); return; }
  c.error = null;
  if (act === 'quick') c.conn.send({ t: 'quick' });
  if (act === 'createRoom') c.conn.send({ t: 'createRoom' });
  if (act === 'joinRoom') {
    const code = ($('#roomCode')?.value || '').trim().toUpperCase();
    if (code.length !== 4) { c.error = t('roomCodeHint'); render(); return; }
    c.conn.send({ t: 'joinRoom', code });
  }
  if (act === 'startRoom') c.conn.send({ t: 'startRoom' });
  if (act === 'leaveLobby') c.conn.send({ t: 'leave' });
  if (act === 'backToLobby') {
    c.phase = 'lobby';
    c.lobby = { mode: 'idle' };
    c.steps = c.steps.slice(0, 3);
    c.tableId = null;
    c.settled = null;
    ui.seats = ui.practice;
    ui.overlay = 'chain';
  }
  render();
}

// Step 3 (click): pay the buy-in in Meteor. When every human has paid, the referee deals.
async function payBuyIn() {
  const c = ui.chain;
  c.error = null;
  c.busy = true;
  c.phase = 'joining';
  render();
  try {
    let bankroll = 0n;
    try { bankroll = await chain.bankrollOf(c.human); } catch { /* pay in full */ }
    const { session, hash } = await chain.payBuyIn(c.tableId, bankroll);
    c.session = session;
    chainStep('chainHumanPaid', { hash });
    c.conn.send({ t: 'paid', ...chain.signSeat(session, c.tableId, c.human) });
  } catch (e) {
    c.phase = 'needPay';
    chainFail(e);
  }
}

async function cashOut() {
  try {
    ui.chain.busy = true;
    render();
    await chain.withdrawAll();
    chainStep('chainWithdrawn', {});
  } catch (e) {
    ui.chain.error = String(e?.message || e).slice(0, 200);
  }
  ui.chain.busy = false;
  await refreshBankrolls();
}

function chainSteps() {
  const c = ui.chain;
  if (!c) return '';
  return `<ol class="steps">${c.steps.map(s => `<li>${t(s.key, s.params)}${s.hash ? ` <a href="${chain.explorerTx(s.hash)}" target="_blank" rel="noopener">${t('viewTx')}</a>` : ''}</li>`).join('')}
    ${c.busy ? `<li class="busy"><span class="dots"><i></i><i></i><i></i></span></li>` : ''}</ol>
    ${c.error ? `<p class="error">${t('chainError', { msg: escapeHtml(c.error) })}</p>` : ''}`;
}

function lobbyPanel() {
  const c = ui.chain;
  const l = c.lobby || { mode: 'idle' };
  const members = (list, away = []) => `<ul class="members">${list.map((n, i) => `<li class="${away[i] ? 'away' : ''}">${escapeHtml(n)}${away[i] ? ` <small>${t('memberAway')}</small>` : ''}</li>`).join('')}${Array.from({ length: 4 - list.length }, () => `<li class="empty">${t('emptySeat')}</li>`).join('')}</ul>`;
  if (l.mode === 'queue') {
    return `<div class="lobby">
      <p>${t('queueWaiting', { seconds: l.seconds })}</p>
      ${members(l.members)}
      <div class="row"><button type="button" class="act" data-act="leaveLobby">${t('cancel')}</button></div>
    </div>`;
  }
  if (l.mode === 'starting') {
    return `<div class="lobby">
      <p>${t('tableStarting')}</p>
      ${members(l.members)}
      <p class="busy"><span class="dots"><i></i><i></i><i></i></span></p>
    </div>`;
  }
  if (l.mode === 'room') {
    return `<div class="lobby">
      <p class="label">${t('roomCode')}</p>
      <p class="code" aria-label="${t('roomCode')}">${escapeHtml(l.code)}</p>
      <div class="row share-row">
        <button type="button" class="act" data-act="copyCode">${c.copied ? t('copied') : t('copyCode')}</button>
        ${navigator.share ? `<button type="button" class="act" data-act="shareCode">${t('shareCode')}</button>` : ''}
      </div>
      <p class="note">${t('roomShare')} ${t('roomStays')}</p>
      ${members(l.members, l.away)}
      <div class="row">
        ${l.host ? `<button type="button" class="act gold primary" data-act="startRoom">${t('startRoom', { n: l.members.length })}</button>` : `<p class="note">${t('waitHost')}</p>`}
        <button type="button" class="act" data-act="leaveLobby">${t('leaveRoom')}</button>
      </div>
    </div>`;
  }
  const bank = c.bankrolls.human;
  return `<div class="lobby">
    <p>${t('lobbyIntro')}</p>
    ${bank != null ? `<p class="note">${t('lobbyBankroll', { near: chain.yoctoToNear(bank) })}</p>` : ''}
    <div class="row"><button type="button" class="act gold primary" data-act="quick">${t('quickMatch')}</button>
      <button type="button" class="act" data-act="createRoom">${t('createRoom')}</button></div>
    <div class="row join">
      <label for="roomCode" class="label">${t('roomCode')}</label>
      <input id="roomCode" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD">
      <button type="button" class="act" data-act="joinRoom">${t('joinRoom')}</button>
    </div>
    ${l.mode === 'closed' ? `<p class="note">${t('roomClosed')}</p>` : ''}
  </div>`;
}

function chainOverlay() {
  const c = ui.chain;
  const showSteps = c.phase !== 'lobby';
  return `
    <div class="sheet chain">
      <p class="eyebrow">NEAR testnet · <a href="${chain.explorerAccount(chain.CONTRACT_ID)}" target="_blank" rel="noopener">${chain.CONTRACT_ID}</a></p>
      <h2>${c.phase === 'lobby' ? t('lobbyTitle') : t('chainTitle')}</h2>
      ${c.offline ? `<p class="offline"><span class="dots"><i></i><i></i><i></i></span> ${t('reconnecting')}</p>` : ''}
      ${c.phase === 'lobby' ? lobbyPanel() : ''}
      ${c.phase === 'needPay' || c.phase === 'joining' ? `<p class="note">${t('tableSeats')}: ${[0, 1, 2, 3].map(seatName).join(' · ')}</p>` : ''}
      ${showSteps ? chainSteps() : c.error ? `<p class="error">${t('chainError', { msg: escapeHtml(c.error) })}</p>` : ''}
      ${c.phase === 'needPay' && !c.busy ? `<div class="row"><button type="button" class="act gold primary" data-act="payBuyIn">${(c.bankrolls.human ?? 0n) >= chain.BUY_IN_YOCTO ? t('payFromBankroll') : t('payBuyIn')}</button></div>
        ${(c.bankrolls.human ?? 0n) >= chain.BUY_IN_YOCTO ? `<p class="note">${t('payFromBankrollNote', { near: chain.yoctoToNear(c.bankrolls.human) })}</p>` : ''}` : ''}
      ${c.phase === 'aborted' ? `<div class="row"><button type="button" class="act gold primary" data-act="backToLobby">${t('backToLobby')}</button></div>` : ''}
      ${c.error && !['needPay', 'lobby'].includes(c.phase) ? `<div class="row"><button type="button" class="act gold primary" data-act="startChain">${t('retry')}</button><button type="button" class="act" data-act="backToIntro">${t('close')}</button></div>` : ''}
      ${c.phase === 'lobby' ? `<div class="row"><button type="button" class="act ghost" data-act="backToIntro">${t('backToMenu')}</button></div>` : ''}
    </div>`;
}

// ---- rendering ---------------------------------------------------------

function tile(c, opts = {}) {
  const cls = ['tile'];
  if (opts.size) cls.push(opts.size);
  if (opts.back) {
    cls.push('back');
    return `<span class="${cls.join(' ')}" aria-hidden="true"></span>`;
  }
  if (c.joker) cls.push('joker');
  else if (c.s === 'h' || c.s === 'd') cls.push('red');
  if (opts.sideways) cls.push('sideways');
  if (opts.fresh) cls.push('fresh');
  if (opts.land) cls.push('land');
  if (opts.drawnIn) cls.push('drawn-in');
  if (opts.selected) cls.push('selected');
  if (opts.win) cls.push('win');
  if (opts.ronTarget) cls.push('ron-target');
  if (opts.ronIn) cls.push('ron-in');
  const inner = c.joker
    ? `<span class="j-word">JOKER</span><span class="j-mult">×2</span>`
    : `<span class="rank">${cardLabel(c).slice(0, -1)}</span><span class="suit">${cardLabel(c).slice(-1)}</span>`;
  const mark = opts.mark ? `<span class="mark" title="Riichi">R</span>` : '';
  if (opts.button) {
    return `<button type="button" class="${cls.join(' ')}" data-index="${opts.index}" aria-label="${cardLabel(c)}${opts.mark ? ' (riichi)' : ''}">${inner}${mark}</button>`;
  }
  return `<span class="${cls.join(' ')}" aria-label="${cardLabel(c)}">${inner}${mark}</span>`;
}

// ---- the table ---------------------------------------------------------
// A fixed 1280×720 stage, scaled to the window. Everything around the centre is placed by
// turning one layout (the one in front of you) to face each seat: 0 you, 1 right, 2 across, 3 left.

const STAGE_W = 1280;
const STAGE_H = 720;
const C = { x: 640, y: 300 };
const ROT = [0, -90, 180, 90];
const PLATE = [
  { left: 24, top: 600 },
  { left: 968, top: 206 },
  { left: 776, top: 66 },
  { left: 42, top: 206 },
];
const BUBBLE_MS = 7000;

// A box `w` wide whose top edge sits `d` below the centre, turned to face `seat`.
function around(seat, w, d) {
  return `left:${C.x - w / 2}px;top:${C.y + d}px;width:${w}px;transform-origin:${w / 2}px ${-d}px;transform:rotate(${ROT[seat]}deg)`;
}

function river(p, seat, turn) {
  const tiles = p.discards.map((c, i) => tile(c, {
    size: 'xs',
    sideways: p.riichiAt === i,
    fresh: ui.lastDiscard && ui.lastDiscard.seat === seat && ui.lastDiscard.id === c.id,
    land: once('land') === `${seat}:${c.id}`,
    ronTarget: ui.pending?.type === 'ron' && ui.pending.from === seat && ui.pending.tile.id === c.id,
  })).join('');
  return `<div class="river ${turn ? 'turn' : ''}" style="${around(seat, 240, 118)}" aria-label="${seatName(seat)}">${tiles}</div>`;
}

function backs(p, seat) {
  return `<div class="backs ${p.folded ? 'folded' : ''}" style="${around(seat, 220, seat === 2 ? 234 : 244)}" aria-hidden="true">${p.hand.map(() => tile(null, { back: true, size: 'bk' })).join('')}</div>`;
}

function riichiStick(on, seat) {
  return on ? `<span class="stick ${once('stick') === seat ? 'new' : ''}" title="Riichi"><span></span></span>` : '';
}

function speech(seat) {
  const info = seatInfo(seat);
  const c = ui.chat[seat];
  const cAge = c ? Date.now() - c.at : Infinity;
  // A player's own message wins over an AI's running commentary.
  if (cAge <= BUBBLE_MS) {
    return `<p class="speech chat" style="animation-delay:-${cAge}ms">${c.stamp ? t(`stamps.${c.stamp}`) : escapeHtml(c.text)}</p>`;
  }
  if (info.kind !== 'ai') return '';
  if (ui.thinking === seat) return `<p class="speech thinking"><span class="dots"><i></i><i></i><i></i></span></p>`;
  const b = ui.bubbles[seat];
  if (!b) return '';
  const age = Date.now() - b.at;
  if (age > BUBBLE_MS) return '';
  return `<p class="speech" style="animation-delay:-${age}ms">${t(b.key, b.params)}</p>`;
}

// ---- table talk ----
// Free text (40 characters) or a stamp. Stamps travel as keys, so everyone reads them in
// their own language. Online the referee passes messages to the others at the table.
const STAMPS = ['hi', 'nice', 'gg', 'oops', 'close', 'moon', 'rug', 'thanks'];
ui.chat = {};

function showChat(seat, msg) {
  ui.chat[seat] = { ...msg, at: Date.now() };
  if (seat !== HUMAN) fx.sound('turn');
  render();
  setTimeout(render, BUBBLE_MS + 50);
}

function sendChat(msg) {
  const c = ui.chain;
  if (c) {
    if (c.conn && c.phase === 'playing') c.conn.send({ t: 'chat', ...msg });
  } else if (ui.game) {
    showChat(HUMAN, msg);
  }
}

function chatOpen(open) {
  const box = $('#chatbox');
  box.hidden = !open;
  $('#chatBtn').setAttribute('aria-expanded', String(open));
  if (open) $('#chatInput').focus({ preventScroll: true });
}

function nameplate(seat) {
  const g = ui.game;
  const info = seatInfo(seat);
  const isAI = info.kind === 'ai';
  const p = g ? g.players[seat] : { riichi: false };
  const pts = g ? g.points[seat] : START_POINTS;
  const mood = moodOf(pts, START_POINTS);
  const active = g && !g.over && g.turn === seat;
  const dealer = g && g.dealer === seat;
  const wallet = isAI && ui.chain && ui.chain.bankrolls[info.id] != null
    ? `<span class="wallet" title="${ui.chain.agents?.[info.id] || ''}">${t('bankroll')} ${chain.yoctoToNear(ui.chain.bankrolls[info.id], 1)} NEAR</span>` : '';
  const sub = seat === HUMAN ? charName(ui.char) : isAI ? charStyle(info.character || info.id) : info.character ? charName(info.character) : t('humanTag');
  const { left, top } = PLATE[seat];
  return `
    <section class="np s${seat} ${active ? 'active' : ''} ${p.riichi ? 'in-riichi' : ''} ${p.folded ? 'folded' : ''} ${ui.pending?.type === 'ron' && ui.pending.from === seat ? 'ron-from' : ''}" id="np-${seat}" style="left:${left}px;top:${top}px" aria-label="${seatName(seat)}">
      <span class="avatar ${isAI ? '' : 'human'}">${avatar(seat)}</span>
      <div class="np-body">
        <p class="np-name"><span class="nm">${seatName(seat)}</span>${dealer ? `<span class="dealer">${t('dealer')}</span>` : ''}</p>
        ${sub ? `<p class="np-sub">${sub}${isAI && mood !== 'steady' ? ` <span class="mood ${mood}">${t(`moods.${mood}`)}</span>` : ''}</p>` : ''}
        <p class="np-pts"><b>${pts}</b><small>${t('pts')}</small><span class="near">${(pts * NEAR_PER_POINT).toFixed(1)} NEAR</span></p>
        ${wallet}
      </div>
      ${riichiStick(p.riichi, seat)}
      ${speech(seat)}
    </section>`;
}

function compass() {
  const g = ui.game;
  const total = g ? g.totalHands : 8;
  const handNo = g ? Math.min(g.handNo + 1, total) : 1;
  const wall = g ? g.wall.length : 38;
  const pot = !g ? 0 : typeof g.potTotal === 'function' ? g.potTotal() : g.pot || 0; // points bet this hand
  const turnSeat = g && !g.over ? g.turn : null;
  const pips = Array.from({ length: total }, (_, i) => `<i class="${i < handNo - 1 ? 'done' : i === handNo - 1 ? 'now' : ''}"></i>`).join('');
  const edges = [0, 1, 2, 3].map(seat => `
    <div class="edge ${turnSeat === seat ? 'turn' : ''}" style="transform:rotate(${ROT[seat]}deg)">
      <span class="e-pts">${g && g.dealer === seat ? `<i class="e-dealer">${t('dealerShort')}</i>` : ''}${g ? g.points[seat] : START_POINTS}</span>
      <span class="lamp"></span>
    </div>`).join('');
  return `
    <div class="compass" style="left:${C.x - 110}px;top:${C.y - 110}px">
      ${edges}
      <div class="c-mid">
        <span class="c-hand">${t('handBanner', { n: handNo })}</span>
        <span class="pips" aria-hidden="true">${pips}</span>
        <span class="c-wall"><span class="stack" aria-hidden="true"><i></i><i></i><i></i></span>${t('left', { n: wall })}</span>
        ${pot ? `<span class="c-pot ${once('pot') ? 'bump' : ''}" title="${t('potTitle')}"><i class="chip-ico" aria-hidden="true"></i>${t('pot', { n: pot })}</span>` : ''}
      </div>
    </div>`;
}

// Fold: open once someone else has declared riichi, unless you declared yourself.
function canFoldNow(g) {
  const me = g.players[HUMAN];
  return !me.riichi && !me.folded && g.points[HUMAN] > 0 && g.players.some(o => o.seat !== HUMAN && o.riichi && !o.folded);
}

function statusText() {
  const g = ui.game;
  if (!g) return '';
  if (ui.pending?.type === 'discard') return ui.selected != null ? t('selected', { card: cardLabel(g.players[HUMAN].hand[ui.selected]) }) : t('pickTile');
  if (ui.pending?.type === 'tsumo') return t('canTsumo', { hand: t(`hands.${ui.pending.ev.key}`), points: ui.pending.ev.points });
  if (ui.pending?.type === 'ron') return t('canRon', { name: seatName(ui.pending.from), card: cardLabel(ui.pending.tile), hand: t(`hands.${ui.pending.ev.key}`), points: ui.pending.ev.points });
  if (g.players[HUMAN].folded) return t('youFolded');
  if (g.players[HUMAN].riichi && g.turn === HUMAN) return t('riichiLocked');
  if (ui.thinking != null) return t('waitingFor', { name: seatName(ui.thinking) });
  return '';
}

// Everything on the felt except your hand: centre panel, the four rivers, the opponents'
// face-down cards and every player's nameplate.
function board() {
  const g = ui.game;
  const empty = { discards: [], riichiAt: -1, hand: [1, 2, 3, 4], riichi: false };
  const P = seat => (g ? g.players[seat] : empty);
  const turnSeat = g && !g.over ? g.turn : null;
  return `
    ${compass()}
    ${[0, 1, 2, 3].map(seat => river(P(seat), seat, turnSeat === seat)).join('')}
    ${[1, 2, 3].map(seat => backs(P(seat), seat)).join('')}
    ${[0, 1, 2, 3].map(nameplate).join('')}`;
}

function myArea() {
  const g = ui.game;
  const me = g ? g.players[HUMAN] : { hand: [], discards: [], riichi: false };
  const pending = ui.pending;
  const discarding = pending?.type === 'discard';
  const hand = me.hand.map((c, index) => ({ c, index }));
  const drawn = g && g.turn === HUMAN && hand.length === 5 ? hand.pop() : null;
  hand.sort((a, b) => (a.c.r - b.c.r) || a.c.s.localeCompare(b.c.s));
  const marks = {};
  if (discarding) {
    for (let i = 0; i < me.hand.length; i++) marks[i] = isTenpai(me.hand.filter((_, j) => j !== i));
  }
  const winSet = pending && pending.type !== 'discard';
  const render1 = ({ c, index }) => tile(c, {
    size: 'lg',
    button: discarding,
    index,
    selected: ui.selected === index,
    mark: discarding && marks[index],
    win: winSet,
  });
  let actions = '';
  if (discarding) {
    const sel = ui.selected;
    const enough = g.points[HUMAN] >= RIICHI_MIN;
    const canRiichi = sel != null && marks[sel] && enough;
    const fold = canFoldNow(g)
      ? `<button type="button" class="act big fold ${ui.foldArmed ? 'armed' : ''}" data-act="fold">${ui.foldArmed ? t('foldConfirm') : t('fold')}</button>` : '';
    actions = `
      ${fold}
      <button type="button" class="act big" data-act="discard" ${sel == null ? 'disabled' : ''}>${t('discard')}</button>
      <button type="button" class="act big gold" data-act="riichi" ${canRiichi ? '' : 'disabled'} title="${enough ? t('riichiBetHint') : t('riichiNeedPoints')}">${t('riichiDiscard')}</button>`;
  } else if (pending?.type === 'tsumo') {
    actions = `
      ${me.riichi ? '' : `<button type="button" class="act big" data-act="no">${t('keepGoing')}</button>`}
      <button type="button" class="act big gold call" data-act="yes">${t('tsumo')}</button>`;
  } else if (pending?.type === 'ron') {
    actions = `
      <button type="button" class="act big" data-act="no">${t('pass')}</button>
      <button type="button" class="act big gold call" data-act="yes">${t('ron')}</button>`;
  }
  const ronTile = pending?.type === 'ron' ? `<span class="plus">+</span>${tile(pending.tile, { size: 'lg', win: true, ronIn: true })}` : '';
  const status = statusText();
  return `
    ${status ? `<p class="status" role="status">${status}</p>` : '<p class="status empty" role="status"></p>'}
    <div class="hand ${once('deal') ? 'deal' : ''} ${g && !g.over && g.turn === HUMAN ? 'my-turn' : ''} ${me.folded ? 'me-folded' : ''}" role="group" aria-label="hand">
      ${hand.map(render1).join('')}
      ${drawn ? `<span class="gap"></span>${tile(drawn.c, { size: 'lg', button: discarding, index: drawn.index, selected: ui.selected === drawn.index, mark: discarding && marks[drawn.index], win: winSet, drawnIn: once('drawn') })}` : ''}
      ${ronTile}
    </div>
    <div class="actions">${actions}${turnClock()}</div>
    ${guide()}`;
}

// Online only: how long you have left before the referee plays the safe move for you.
function turnClock() {
  const p = ui.pending;
  if (!p || !p.deadline || !p.ms) return '';
  const left = p.deadline - Date.now();
  if (left <= 0) return '';
  return `<div class="clock ${left < 5000 ? 'urgent' : ''}" role="timer" aria-label="${t('timeLeft', { s: Math.ceil(left / 1000) })}">
    <i style="animation-duration:${p.ms}ms;animation-delay:-${p.ms - left}ms"></i></div>`;
}

// When you can ron, point at the card in the discards that completes your hand and draw
// a line from it to your hand. Only your screen shows this: nobody else knows until you call.
function ronHint() {
  document.getElementById('ronHint')?.remove();
  const p = ui.pending;
  if (!p || p.type !== 'ron' || !ui.game) return;
  const stage = $('#stage');
  const target = $('#board .tile.ron-target');
  const mine = $('#mine .tile.ron-in');
  if (!target || !mine) return;
  const sr = stage.getBoundingClientRect();
  const k = sr.width / STAGE_W;
  const centre = el => {
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - sr.left) / k, y: (r.top + r.height / 2 - sr.top) / k, h: r.height / k };
  };
  const a = centre(target);
  const b = centre(mine);
  const mid = { x: (a.x + b.x) / 2 + (b.x > a.x ? -60 : 60), y: Math.min(a.y, b.y) - 40 };
  const fresh = ui.ronShown !== p;
  ui.ronShown = p;
  const el = document.createElement('div');
  el.id = 'ronHint';
  el.className = `ron-hint ${fresh ? 'fresh' : ''}`;
  el.innerHTML = `
    <svg viewBox="0 0 ${STAGE_W} ${STAGE_H}" aria-hidden="true">
      <path class="beam" d="M${a.x},${a.y} Q${mid.x},${mid.y} ${b.x},${b.y - b.h / 2 - 8}"/>
      <circle class="ring" cx="${a.x}" cy="${a.y}" r="${a.h * 0.75}"/>
    </svg>
    <span class="ron-tag" style="left:${a.x}px;top:${a.y - a.h / 2 - 12}px">${t('ronHere')}</span>
    ${fresh ? '<span class="ron-flash"></span>' : ''}`;
  $('.table').appendChild(el);
  if (fresh) fx.sound('chance');
}

function fitStage() {
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  document.documentElement.style.setProperty('--s', String(s));
}
window.addEventListener('resize', fitStage);
fitStage();

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function scoreTable() {
  return `<table class="scores"><tbody>${Object.entries(BASE_POINTS).map(([cat, pts]) => `
    <tr><td>${t(`hands.${CAT_KEYS[cat]}`)}</td><td class="num">${pts}</td></tr>`).join('')}
    <tr class="jk"><td>JOKER</td><td class="num">×2</td></tr></tbody></table>`;
}

function introOverlay() {
  return `
    <div class="sheet intro">
      <button type="button" class="act ghost to-title" data-act="toTitle">← ${t('title')}</button>
      <div class="sheet-tools">
        <button type="button" class="act ghost" data-act="rules">${t('rules')}</button>
        <button type="button" class="act ghost" data-act="lang" lang="${getLang() === 'ja' ? 'en' : 'ja'}">${t('lang')}</button>
      </div>
      <p class="eyebrow">NEAR HACKATHON · testnet</p>
      <h1 class="logo">RON<span>POKER</span></h1>
      <p class="tagline">${t('tagline')}</p>
      <p class="label">${t('pickCharacter')}</p>
      <div class="picker" role="radiogroup" aria-label="${t('pickCharacter')}">
        ${CHARACTER_IDS.map(id => `<button type="button" class="pick ${id === ui.char ? 'on' : ''}" data-act="pick" data-char="${id}" role="radio" aria-checked="${id === ui.char}" title="${charName(id)}"><img src="${portraitUrl(id)}" alt="${charName(id)}" draggable="false"></button>`).join('')}
      </div>
      <div class="picked">
        <img src="${portraitUrl(ui.char, 'joy')}" alt="" draggable="false">
        <p><b>${charName(ui.char)}</b><br><span class="cpu-tag">${t('asCpu')}</span> <em>${charStyle(ui.char)}</em> — ${charBio(ui.char)}</p>
      </div>
      <p class="pick-note">${t('pickNote')}</p>
      <div class="nick-row">
        <label for="nick" class="label">${t('nickname')}</label>
        <input id="nick" class="nick-input" maxlength="12" autocomplete="nickname" placeholder="${t('nicknamePlaceholder')}" value="${escapeHtml(ui.nick)}">
      </div>
      <p class="note">${t('startNote')}</p>
      ${PREVIEW ? `<p class="note">${t('previewNote')} <a href="${LIVE_URL}" target="_blank" rel="noopener">${LIVE_URL}</a></p>` : ''}
      <div class="row">
        ${PREVIEW ? '' : `<button type="button" class="act gold primary" data-act="startChain">${t('playChain')}</button>`}
        <button type="button" class="act ${PREVIEW ? 'gold primary' : ''}" data-act="start">${t('playPractice')}</button>
        <button type="button" class="act ghost" data-act="rules">${t('rules')}</button>
      </div>
    </div>`;
}

function resultOverlay() {
  const r = ui.result;
  const g = ui.game;
  if (r.type === 'exhausted') {
    return `<div class="sheet result"><p class="eyebrow">${t('hand')} ${r.handNo + 1}</p><h2>${t('resultExhausted')}</h2>
      <p>${t('logExhausted')}${(r.refunds || []).some(x => x.amount) ? ` ${t('potRefunded')}` : ''}</p><ul class="standings">${standings(g.points, 'hand', handDeltas(r))}</ul><div class="row"><button type="button" class="act gold primary" data-act="next">${t('nextHand')}</button></div></div>`;
  }
  if (r.type === 'foldWin') {
    return `<div class="sheet result"><p class="eyebrow">${t('hand')} ${r.handNo + 1} · ${t('foldWinBanner')}</p><h2>${t('foldWinSub', { name: seatName(r.winner), n: r.potWon })}</h2>
      <p>${t('foldWinWhy')}</p><ul class="standings">${standings(g.points, 'hand', handDeltas(r))}</ul><div class="row"><button type="button" class="act gold primary" data-act="next">${t('nextHand')}</button></div></div>`;
  }
  const lines = r.transfers.filter(x => x.amount > 0).map(x => `<li>${t('paid', { from: seatName(x.from), to: seatName(x.to), amount: x.amount })}</li>`).join('');
  return `
    <div class="sheet result">
      <p class="eyebrow">${t('hand')} ${r.handNo + 1} · ${r.type === 'ron' ? t('resultRon') : t('resultTsumo')}</p>
      <h2>${seatName(r.winner)} — ${t(`hands.${r.ev.key}`)}</h2>
      <div class="hand show">${r.hand.map(c => tile(c, { size: 'md', win: true })).join('')}</div>
      <p class="calc"><span>${r.ev.base}</span>${r.ev.jokers ? ` × <span class="gold-text">${t('jokerBonus', { mult: r.ev.mult })}</span>` : ''}
        ${r.type === 'ron' ? ' × 3' : ''} = <b>${r.ev.points * (r.type === 'ron' ? 3 : 1)}${t('pts')}</b>${r.type === 'tsumo' ? ` <small>(${t('everyonePays')})</small>` : ''}</p>
      <ul class="transfers">${lines}${r.potWon ? `<li>${t('potWon', { name: seatName(r.winner), n: r.potWon })}</li>` : ''}</ul>
      <ul class="standings">${standings(g.points, 'hand', handDeltas(r))}</ul>
      <div class="row"><button type="button" class="act gold primary" data-act="next">${t('nextHand')}</button></div>
    </div>`;
}

// What each seat gained or lost this hand: payments, plus the bets and fold fees on the table
// (taken by the winner, or handed back after a draw).
function handDeltas(record) {
  const d = [0, 0, 0, 0];
  for (const x of record.transfers || []) { d[x.from] -= x.amount; d[x.to] += x.amount; }
  if (record.winner != null) for (const x of record.potFrom || []) { d[x.from] -= x.amount; d[record.winner] += x.amount; }
  return d;
}

function signed(n) {
  return `${n > 0 ? '+' : ''}${n}`;
}

// mode 'hand': points now and the change in this hand. mode 'final': points, net vs buy-in, NEAR payout.
function standings(points, mode, deltas = null) {
  const final = mode === 'final';
  const head = `<li class="head"><span></span><span></span><span class="num">${t('colPoints')}</span>
    <span class="num">${final ? t('colNet') : t('colThisHand')}</span>${final ? `<span class="num">${t('payout')}</span>` : ''}</li>`;
  const rows = [0, 1, 2, 3]
    .map(seat => ({ seat, pts: points[seat] }))
    .sort((a, b) => b.pts - a.pts)
    .map(({ seat, pts }, i) => {
      const diff = final ? pts - START_POINTS : deltas[seat];
      const near = (pts * NEAR_PER_POINT).toFixed(1);
      return `<li class="${seat === HUMAN ? 'me' : ''}"><span class="place">${i + 1}</span><span class="nm">${avatar(seat, 'mini')}${seatName(seat)}</span>
        <span class="num">${pts}${t('pts')}</span><span class="num diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff === 0 ? '±0' : signed(diff)}</span>
        ${final ? `<span class="num near">${near} NEAR</span>` : ''}</li>`;
    }).join('');
  return head + rows;
}

function finalOverlay() {
  const g = ui.game;
  return `
    <div class="sheet final">
      <p class="eyebrow">${t('payout')}</p>
      <h2>${t('finalTitle')}</h2>
      <ul class="standings">${standings(g.points, 'final')}</ul>
      ${ui.chain ? chainSteps() : `<p class="note">${t('seed')}: <code>${g.seed}</code></p>`}
      ${ui.chain && ui.chain.settled && ui.chain.bankrolls.human > 0n ? `<p>${t('yourBankroll', { near: chain.yoctoToNear(ui.chain.bankrolls.human) })}</p>` : ''}
      <div class="row">
        ${ui.chain && ui.chain.settled && ui.chain.bankrolls.human > 0n && !ui.chain.busy ? `<button type="button" class="act gold" data-act="cashOut">${t('cashOut')}</button>` : ''}
        ${ui.chain?.busy ? '' : `<button type="button" class="act ${ui.chain ? '' : 'gold'} primary" data-act="${ui.chain ? 'backToLobby' : 'start'}">${t('playAgain')}</button>`}
        ${ui.chain?.busy ? '' : `<button type="button" class="act" data-act="backToIntro">${t('backToMenu')}</button>`}
      </div>
    </div>`;
}

// ---- title screen ----
// The artwork carries its own buttons; transparent hotspots sit on top of them.
// Positions are in pixels of the 1536×1024 image.
const TITLE_BUTTONS = [
  { act: 'titlePlay', key: 'titlePlay', box: [505, 750, 530, 125], cls: 'play' },
  { act: 'settings', key: 'settings', box: [338, 902, 255, 70] },
  { act: 'ranking', key: 'ranking', box: [612, 902, 288, 70] },
  { act: 'wallet', key: 'wallet', box: [920, 902, 275, 70] },
];

function titleScreen() {
  const pct = (v, of) => `${(v / of * 100).toFixed(2)}%`;
  return `
    <div class="title-bg" aria-hidden="true" style="background-image:url(assets/title.webp)"></div>
    <div class="title-art">
      <img src="assets/title.webp" alt="Ron Poker" draggable="false">
      <h1 class="sr-only">Ron Poker</h1>
      ${TITLE_BUTTONS.map(b => `<button type="button" class="hot ${b.cls || ''}" data-act="${b.act}" aria-label="${t(b.key)}"
        style="left:${pct(b.box[0], 1536)};top:${pct(b.box[1], 1024)};width:${pct(b.box[2], 1536)};height:${pct(b.box[3], 1024)}"></button>`).join('')}
    </div>`;
}

function settingsOverlay() {
  const ja = getLang() === 'ja';
  return `
    <div class="sheet settings">
      <h2>${t('settings')}</h2>
      <div class="set-row"><span class="label">${t('language')}</span>
        <div class="seg"><button type="button" class="act ${ja ? '' : 'gold'}" data-act="setLang" data-lang="en">English</button><button type="button" class="act ${ja ? 'gold' : ''}" data-act="setLang" data-lang="ja">日本語</button></div></div>
      <div class="set-row"><span class="label">${t('speed')}</span>
        <div class="seg">${Object.keys(SPEEDS).map(k => `<button type="button" class="act ${ui.speed === k ? 'gold' : ''}" data-act="setSpeed" data-speed="${k}">${t(`speeds.${k}`)}</button>`).join('')}</div></div>
      <div class="set-row"><span class="label">${t('sound')}</span>
        <div class="seg"><button type="button" class="act ${fx.isMuted() ? '' : 'gold'}" data-act="setSound" data-on="1">ON</button><button type="button" class="act ${fx.isMuted() ? 'gold' : ''}" data-act="setSound" data-on="0">OFF</button></div></div>
      <div class="set-row"><span class="label">${t('guideSetting')}</span>
        <div class="seg"><button type="button" class="act ${ui.tut.on ? 'gold' : ''}" data-act="setGuide" data-on="1">ON</button><button type="button" class="act ${ui.tut.on ? '' : 'gold'}" data-act="setGuide" data-on="0">OFF</button></div></div>
      <div class="set-row"><span class="label">${t('music')}</span>
        <div class="seg"><button type="button" class="act ${fx.isMusicOn() ? 'gold' : ''}" data-act="setMusic" data-on="1">ON</button><button type="button" class="act ${fx.isMusicOn() ? '' : 'gold'}" data-act="setMusic" data-on="0">OFF</button></div></div>
      <p class="credits">${t('credits')}</p>
      <div class="row">
        <button type="button" class="act" data-act="rules">${t('rules')}</button>
        <button type="button" class="act gold primary" data-act="closeSheet">${t('close')}</button>
      </div>
    </div>`;
}

// Ranking: total NEAR won or lost across every settled testnet table, read from the contract
// by the referee. Practice games do not count.
function shortAccount(a) {
  return a.length > 13 ? `${a.slice(0, 5)}…${a.slice(-5)}` : a;
}

async function openRanking() {
  ui.overlay = 'ranking';
  ui.ranking = { status: PREVIEW ? 'preview' : 'loading' };
  render();
  if (PREVIEW) return;
  try {
    const [res, me] = await Promise.all([fetch(`${chain.REFEREE_URL}/leaderboard`), chain.currentAccount().catch(() => null)]);
    if (!res.ok) throw new Error(String(res.status));
    ui.ranking = { status: 'ok', me, ...(await res.json()) };
  } catch {
    ui.ranking = { status: 'error' };
  }
  if (ui.overlay === 'ranking') render();
}

function rankingOverlay() {
  const r = ui.ranking || { status: 'loading' };
  let body = '';
  if (r.status === 'loading') body = `<p class="busy"><span class="dots"><i></i><i></i><i></i></span> ${t('rankingLoading')}</p>`;
  else if (r.status === 'preview') body = `<p class="note">${t('rankingPreview')} <a href="${LIVE_URL}" target="_blank" rel="noopener">${LIVE_URL}</a></p>`;
  else if (r.status === 'error') body = `<p class="note">${t('rankingError')}</p>`;
  else if (!r.rows.length) body = `<p class="note">${t('rankingEmpty')}</p>`;
  else {
    const near = y => {
      const v = Number(BigInt(y) / 10n ** 21n) / 1000;
      return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;
    };
    body = `
      <div class="rank-wrap"><table class="rank">
        <thead><tr><th>#</th><th>${t('rankPlayer')}</th><th class="num">${t('rankNet')}</th><th class="num">${t('rankGames')}</th><th class="num">${t('rankFirsts')}</th><th class="num">${t('rankAvg')}</th></tr></thead>
        <tbody>${r.rows.map((x, i) => `
          <tr class="${x.account === r.me ? 'me' : ''} ${i < 3 ? `top top${i + 1}` : ''}">
            <td class="pos">${i + 1}</td>
            <td class="who" title="${escapeHtml(x.account)}">${x.ai ? `<span class="ai-tag">AI</span>` : ''}${x.name ? escapeHtml(x.name) : shortAccount(x.account)}${x.account === r.me ? ` <span class="you-tag">${t('you')}</span>` : ''}</td>
            <td class="num net ${BigInt(x.net) > 0n ? 'up' : BigInt(x.net) < 0n ? 'down' : ''}">${near(x.net)} <small>NEAR</small></td>
            <td class="num">${x.games}</td>
            <td class="num">${x.firsts}</td>
            <td class="num">${x.avgRank.toFixed(2)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="note">${t('rankingNote', { tables: r.tables })}</p>`;
  }
  return `
    <div class="sheet ranking">
      <h2>${t('ranking')}</h2>
      <p class="note">${t('rankingIntro')}</p>
      ${body}
      <div class="row"><button type="button" class="act gold primary" data-act="closeSheet">${t('close')}</button></div>
    </div>`;
}

function rulesOverlay() {
  return `
    <div class="sheet rules">
      <h2>${t('rulesTitle')}</h2>
      <ol>${t('rulesBody').map(x => `<li>${x}</li>`).join('')}</ol>
      <h3>${t('scoreTable')}</h3>
      ${scoreTable()}
      <div class="row"><button type="button" class="act primary" data-act="closeRules">${t('close')}</button></div>
    </div>`;
}

function render() {
  document.documentElement.lang = getLang();
  $('#lang').textContent = t('lang');
  $('#rulesBtn').textContent = t('rules');
  $('#board').innerHTML = board();
  $('#mine').innerHTML = myArea();
  ronHint();
  $('#rotateHint').textContent = t('rotateHint');
  document.body.classList.toggle('at-table', !ui.title && !ui.overlay);
  const ov = $('#overlay');
  const title = $('#title');
  if (title.hidden === ui.title || title.dataset.lang !== getLang()) {
    title.hidden = !ui.title;
    title.innerHTML = ui.title ? titleScreen() : '';
    title.dataset.lang = ui.title ? getLang() : '';
  }
  const view = { intro: introOverlay, result: resultOverlay, final: finalOverlay, rules: rulesOverlay, chain: chainOverlay, settings: settingsOverlay, ranking: rankingOverlay }[ui.overlay];
  ov.hidden = !view;
  ov.innerHTML = view ? view() : '';
  $('#soundBtn').textContent = fx.isMuted() ? t('soundOff') : t('soundOn');
  const canChat = !!ui.game && !ui.game.over && !ui.title && (!ui.chain || ui.chain.phase === 'playing');
  $('#chatBtn').hidden = !canChat;
  $('#chatBtn').textContent = t('chat');
  if (!canChat && !$('#chatbox').hidden) chatOpen(false);
  const stamps = $('#stamps');
  if (stamps.dataset.lang !== getLang()) {
    stamps.dataset.lang = getLang();
    stamps.innerHTML = STAMPS.map(k => `<button type="button" class="stamp" data-stamp="${k}">${t(`stamps.${k}`)}</button>`).join('');
    $('#chatInput').placeholder = t('chatPlaceholder');
    $('#chatSend').textContent = t('chatSend');
  }
}

// ---- input -------------------------------------------------------------

function resolvePending(value) {
  const p = ui.pending;
  if (!p) return;
  ui.foldArmed = false;
  ui.pending = null;
  ui.selected = null;
  p.resolve(value);
  render();
}

document.addEventListener('click', ev => {
  fx.startMusic();
  const tileBtn = ev.target.closest('button.tile[data-index]');
  if (tileBtn && ui.pending?.type === 'discard') {
    const i = Number(tileBtn.dataset.index);
    if (ui.selected === i) resolvePending({ index: i, riichi: false });
    else { ui.selected = i; render(); }
    return;
  }
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'start') startGame();
  if (act === 'startChain') startChainGame();
  if (act === 'cashOut') cashOut();
  if (act === 'payBuyIn') payBuyIn();
  if (['quick', 'createRoom', 'joinRoom', 'startRoom', 'leaveLobby', 'backToLobby'].includes(act)) lobbyAction(act);
  if (act === 'backToIntro') { ui.overlay = 'intro'; render(); }
  if (act === 'titlePlay') { ui.title = false; ui.overlay = 'intro'; fx.sound('draw'); render(); }
  if (act === 'toTitle') { ui.title = true; ui.overlay = null; render(); }
  if (act === 'settings') { ui.overlay = act; render(); }
  if (act === 'ranking') openRanking();
  if (act === 'closeSheet') { ui.overlay = ui.title ? null : 'intro'; render(); }
  if (act === 'setSpeed') {
    ui.speed = ev.target.closest('[data-speed]').dataset.speed;
    try { localStorage.setItem('ronpoker.speed', ui.speed); } catch { /* ignore */ }
    render();
  }
  if (act === 'setLang') { setLang(ev.target.closest('[data-lang]').dataset.lang); render(); }
  if (act === 'copyCode' || act === 'shareCode') {
    const code = ui.chain?.lobby?.code;
    if (code) {
      const text = t('shareText', { code, url: LIVE_URL });
      if (act === 'shareCode' && navigator.share) navigator.share({ title: 'Ron Poker', text }).catch(() => {});
      else {
        const done = () => { ui.chain.copied = true; render(); setTimeout(() => { if (ui.chain) { ui.chain.copied = false; render(); } }, 1800); };
        (navigator.clipboard?.writeText(text) || Promise.reject()).then(done).catch(() => { window.prompt?.(t('copyCode'), text); });
      }
    }
  }
  if (act === 'tutOk') { if (ui.tut.current) ui.tut.seen.add(ui.tut.current); ui.tut.current = null; render(); }
  if (act === 'tutSkip') { endTut(); render(); }
  if (act === 'setGuide') {
    const on = ev.target.closest('[data-on]').dataset.on === '1';
    if (on) { ui.tut = { on: true, seen: new Set(), current: null }; try { localStorage.removeItem('ronpoker.guide'); } catch { /* ignore */ } } else endTut();
    render();
  }
  if (act === 'setMusic') { fx.setMusic(ev.target.closest('[data-on]').dataset.on === '1'); render(); }
  if (act === 'setSound') { fx.setMuted(ev.target.closest('[data-on]').dataset.on !== '1'); if (!fx.isMuted()) fx.sound('coin'); render(); }
  if (act === 'wallet') {
    if (PREVIEW) { ui.title = false; ui.overlay = 'intro'; render(); }
    else { ui.title = false; startChainGame(); }
  }
  if (act === 'rules') { ui.overlayBefore = ui.overlay; ui.overlay = 'rules'; render(); }
  if (act === 'lang') { setLang(getLang() === 'ja' ? 'en' : 'ja'); render(); }
  if (act === 'pick') {
    ui.char = ev.target.closest('[data-char]').dataset.char;
    saveChar(ui.char);
    ui.practice = practiceSeats();
    if (!ui.game) ui.seats = ui.practice;
    fx.sound('turn');
    render();
  }
  if (act === 'closeRules') { ui.overlay = ui.overlayBefore; ui.overlayBefore = null; render(); }
  if (act === 'next') { ui.overlay = null; const r = ui.resolveOverlay; ui.resolveOverlay = null; render(); r?.(); }
  if (act === 'fold' && ui.pending?.type === 'discard') {
    // Two taps, so a stray tap does not throw the hand away.
    clearTimeout(ui.foldTimer);
    if (!ui.foldArmed) {
      ui.foldArmed = true;
      render();
      ui.foldTimer = setTimeout(() => { ui.foldArmed = false; render(); }, 3000);
    } else {
      resolvePending({ fold: true });
    }
  }
  if (act === 'discard' && ui.selected != null) resolvePending({ index: ui.selected, riichi: false });
  if (act === 'riichi' && ui.selected != null) resolvePending({ index: ui.selected, riichi: true });
  if (act === 'yes') resolvePending(true);
  if (act === 'no') resolvePending(false);
});

document.addEventListener('input', ev => {
  if (ev.target.id === 'nick') {
    ui.nick = ev.target.value.replace(/[\u0000-\u001f<>&"'`]/g, '').slice(0, 12);
    saveNick(ui.nick);
  }
});

$('#chatBtn').addEventListener('click', () => chatOpen($('#chatbox').hidden));
$('#stamps').addEventListener('click', ev => {
  const b = ev.target.closest('[data-stamp]');
  if (!b) return;
  sendChat({ stamp: b.dataset.stamp });
  chatOpen(false);
});
$('#chatForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const input = $('#chatInput');
  const text = input.value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  if (!text) return;
  sendChat({ text });
  input.value = '';
  chatOpen(false);
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#chatbox').hidden) chatOpen(false); });

$('#soundBtn').addEventListener('click', () => {
  fx.setMuted(!fx.isMuted());
  if (!fx.isMuted()) fx.sound('coin');
  render();
});

$('#lang').addEventListener('click', () => {
  setLang(getLang() === 'ja' ? 'en' : 'ja');
  render();
});
$('#rulesBtn').addEventListener('click', () => {
  if (ui.overlay === 'rules') return;
  ui.overlayBefore = ui.overlay;
  ui.overlay = 'rules';
  render();
});

render();
if (!PREVIEW) chain.warmUp();

// Developer hook: with #debug in the address, expose the chain helpers for manual testing.
if (!PREVIEW && location.hash === '#debug') window.ronDebug = { chain, ui };

// Browser UI: one human seat against three AI seats.

import { Game } from './game.js';
import { AIController, PERSONALITIES, moodOf } from './ai.js';
import { isTenpai, BASE_POINTS, CAT_KEYS, START_POINTS } from './engine.js';
import { t, getLang, setLang } from './i18n.js';
import * as chain from './chain.js';
import * as fx from './fx.js';

const NEAR_PER_POINT = 0.1;
// Set at build time. The chat preview cannot reach NEAR, so it offers practice mode only.
const PREVIEW = typeof __PREVIEW__ !== 'undefined' && __PREVIEW__;
const LIVE_URL = 'https://ponkotsuai.github.io/ron-poker/';
const HUMAN = 0;
// Turn order is 0 → 1 → 2 → 3. Seat 1 sits to your right, 2 across, 3 to your left.
// Seats are always shown from your point of view: you are seat 0.
const AI_IDS = ['tanuki', 'tsuru', 'kitsune'];
const PRACTICE_SEATS = [{ kind: 'human' }, ...AI_IDS.map(id => ({ kind: 'ai', id }))];
const GLYPH = { tanuki: '狸', tsuru: '鶴', kitsune: '狐' };

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
  overlay: 'intro', // intro | result | final | rules | chain | null
  once: {}, // one-shot animations: { key: { v, at } }, honoured for a moment after they are set
  seats: PRACTICE_SEATS,
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

function setOnce(key, v) { ui.once[key] = { v, at: Date.now() }; }
function once(key) {
  const o = ui.once[key];
  return o && Date.now() - o.at < 350 ? o.v : undefined;
}

function seatName(seat) {
  if (seat === HUMAN) return ui.nick ? escapeHtml(ui.nick) : t('you');
  const s = ui.seats[seat] || PRACTICE_SEATS[seat];
  if (s.kind === 'ai') return t(`names.${s.id}`);
  return escapeHtml(s.name || '?');
}

function seatGlyph(seat) {
  const s = ui.seats[seat] || PRACTICE_SEATS[seat];
  if (s.kind === 'ai') return GLYPH[s.id];
  return escapeHtml((s.name || '?').slice(0, 1).toUpperCase());
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

  chooseTsumo(view, ev) { return this.wrap(() => this.ai.chooseTsumo(view, ev), 450); }
  chooseRon(view, tile, ev, from) { return this.wrap(() => this.ai.chooseRon(view, tile, ev, from), 450); }
  chooseDiscard(view) { return this.wrap(() => this.ai.chooseDiscard(view), 750); }
  beforeAutoDiscard() { return this.wrap(() => null, 550); }
}

// ---- game wiring -------------------------------------------------------

function newGame(seed = (Math.random() * 2 ** 32) >>> 0) {
  const seats = [0, 1, 2, 3].map(seat => {
    if (seat === HUMAN) return { name: 'you', controller: new HumanController() };
    const id = AI_IDS[seat - 1];
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
  ui.lastDiscard = null;
  ui.game = new Game({ seats, seed, onEvent, afterHand: showResult });
  return ui.game;
}

function onEvent(type, e) {
  const g = ui.game;
  if (type === 'handStart') {
    ui.lastDiscard = null;
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
      fx.sound('riichi');
      fx.cutIn('riichi', { title: 'リーチ', kanji: '立直', who: seatName(e.seat) });
    }
    const key = e.riichi ? 'logRiichi' : 'logDiscard';
    pushLog(t(key, { name: seatName(e.seat), card: cardLabel(e.card) }), e.riichi ? 'riichi' : '');
  }
  if (type === 'win') {
    const params = { name: seatName(e.winner), hand: t(`hands.${e.ev.key}`), points: e.ev.points };
    const big = e.ev.cat >= 8;
    const total = e.ev.points * (e.type === 'ron' ? 3 : 1);
    fx.sound(big ? 'yakuman' : e.type);
    fx.cutIn(big ? 'yakuman' : e.type, {
      title: big ? '役満' : e.type === 'ron' ? 'ロン' : 'ツモ',
      kanji: big ? t(`hands.${e.ev.key}`) : e.type === 'ron' ? '栄和' : '自摸',
      who: seatName(e.winner),
      sub: `${t(`hands.${e.ev.key}`)}${e.ev.jokers ? ` × JOKER ${e.ev.mult}` : ''}　${total}${t('pts')}`,
    });
    // chips fly from whoever paid to the winner once the cut-in clears
    fx.idle().then(() => {
      for (const x of e.transfers || []) fx.coins(seatEl(x.from), seatEl(x.to), x.amount);
    });
    if (e.type === 'ron') pushLog(t('logRon', { ...params, loser: seatName(e.loser) }), 'win');
    else pushLog(t('logTsumo', params), 'win');
  }
  if (type === 'exhausted') {
    pushLog(t('logExhausted'), 'sep');
    fx.banner('流局', t('resultExhausted'));
  }
  if (type === 'gameEnd') fx.sound('gameEnd');
  render();
}

function seatEl(seat) {
  return $(['#mine', '#seat-right', '#seat-top', '#seat-left'][seat]);
}

async function showResult(record) {
  // let the cut-in and the flying chips play before the result sheet covers the table
  await fx.idle();
  if (record.type !== 'exhausted') await sleep(reduceMotion ? 100 : 900);
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
  ui.seats = PRACTICE_SEATS;
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
  if (params.who) params.who = t(`names.${params.who}`);
  if (params.by) params.by = t(`names.${params.by}`);
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
  };
}
function localEvent(type, e) {
  if (type === 'handStart') return { ...e, dealer: toLocal(e.dealer) };
  if (type === 'draw' || type === 'discard') return { ...e, seat: toLocal(e.seat) };
  if (type === 'win' || type === 'exhausted') return localRecord(e);
  if (type === 'gameEnd') return { ...e, points: rotate(e.points) };
  return e;
}

// A stand-in for the local Game object, built from the referee's snapshots.
function mirrorGame(s) {
  return {
    remote: true,
    handNo: s.handNo, totalHands: s.totalHands, dealer: toLocal(s.dealer), turn: toLocal(s.turn), over: s.over,
    points: rotate(s.points), wall: { length: s.wallCount }, seed: s.seedHash,
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
      c.phase = 'lobby';
      c.busy = false;
      c.lobby = { mode: 'idle' };
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
    case 'opened':
      refreshBankrolls();
      c.tableId = m.tableId;
      c.you = m.seat;
      ui.seats = rotate(m.seats);
      c.phase = 'needPay';
      c.busy = false;
      c.lobby = null;
      chainStep('chainHumanPay');
      break;
    case 'state':
      ui.game = mirrorGame(m.game);
      if (c.phase !== 'playing' && !m.game.over) { c.phase = 'playing'; ui.overlay = null; }
      render();
      break;
    case 'event':
      if (m.type === 'handStart' && ui.overlay === 'result') { ui.overlay = null; ui.resolveOverlay = null; }
      if (m.type === 'gameEnd') {
        c.phase = 'settling';
        c.busy = true;
        ui.overlay = 'final';
        chainStep('chainSettling');
      }
      onEvent(m.type, localEvent(m.type, m.e));
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
        };
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

function onRefereeClose(state) {
  const c = ui.chain;
  if (!c || c !== state || c.phase === 'settled' || c.phase === 'aborted' || c.closing) return;
  if (c.phase === 'playing' && c.session && c.tableId != null) {
    // Reconnect and pick the game up where it is. Until then the referee plays safe moves for you.
    setTimeout(() => {
      c.conn = listen(c);
      c.conn.ready.then(() => c.conn.send({ t: 'resume', tableId: c.tableId, account: c.human, ...chain.signSeat(c.session, c.tableId, c.human) }))
        .catch(chainFail);
    }, 1500);
  } else {
    chainFail(new Error(t('refereeLost')));
  }
}

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
    conn.send({ t: 'hello', account: human, nickname: ui.nick });
  } catch (e) { chainFail(e); }
}

// Step 2: find a table, either by random match or in a room with friends.
function lobbyAction(act) {
  const c = ui.chain;
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
    ui.seats = PRACTICE_SEATS;
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
  const members = list => `<ul class="members">${list.map(n => `<li>${escapeHtml(n)}</li>`).join('')}${Array.from({ length: 4 - list.length }, () => `<li class="empty">${t('emptySeat')}</li>`).join('')}</ul>`;
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
      <p class="note">${t('roomShare')}</p>
      ${members(l.members)}
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
  const inner = c.joker
    ? `<span class="j-word">JOKER</span><span class="j-mult">×2</span>`
    : `<span class="rank">${cardLabel(c).slice(0, -1)}</span><span class="suit">${cardLabel(c).slice(-1)}</span>`;
  const mark = opts.mark ? `<span class="mark" title="Riichi">R</span>` : '';
  if (opts.button) {
    return `<button type="button" class="${cls.join(' ')}" data-index="${opts.index}" aria-label="${cardLabel(c)}${opts.mark ? ' (riichi)' : ''}">${inner}${mark}</button>`;
  }
  return `<span class="${cls.join(' ')}" aria-label="${cardLabel(c)}">${inner}${mark}</span>`;
}

function river(p, seat) {
  return p.discards.map((c, i) => tile(c, {
    size: 'xs',
    sideways: p.riichiAt === i,
    fresh: ui.lastDiscard && ui.lastDiscard.seat === seat && ui.lastDiscard.id === c.id,
    land: once('land') === `${seat}:${c.id}`,
  })).join('');
}

function riichiStick(on, seat) {
  return on ? `<span class="stick ${once('stick') === seat ? 'new' : ''}" title="Riichi"><span></span></span>` : '';
}

function opponentPanel(seat, side) {
  const g = ui.game;
  const info = ui.seats[seat] || PRACTICE_SEATS[seat];
  const isAI = info.kind === 'ai';
  const id = info.id;
  const p = g ? g.players[seat] : { hand: [1, 2, 3, 4], discards: [], riichi: false };
  const pts = g ? g.points[seat] : START_POINTS;
  const mood = moodOf(pts, START_POINTS);
  const bubble = ui.bubbles[seat];
  const bubbleText = bubble ? t(bubble.key, bubble.params) : isAI ? t(`bios.${id}`) : t('humanPlayer');
  const isDealer = g && g.dealer === seat;
  const active = g && !g.over && g.turn === seat;
  return `
    <section class="seat opp ${side} ${active ? 'active' : ''} ${p.riichi ? 'in-riichi' : ''}" aria-label="${seatName(seat)}">
      <header class="seat-head">
        <span class="glyph ${isAI ? '' : 'human'}">${seatGlyph(seat)}</span>
        <span class="who">
          <span class="name">${seatName(seat)}${isDealer ? `<span class="dealer">${t('dealer')}</span>` : ''}</span>
          <span class="style">${isAI ? t(`styles.${id}`) : t('humanTag')}</span>
        </span>
      </header>
      <div class="purse">
        <span class="pts">${pts}<small>${t('pts')}</small></span>
        <span class="near">${(pts * NEAR_PER_POINT).toFixed(1)} NEAR</span>
        ${isAI ? `<span class="mood ${mood}">${t(`moods.${mood}`)}</span>` : ''}
        ${isAI && ui.chain && ui.chain.bankrolls[id] != null ? `<span class="wallet" title="${ui.chain.agents?.[id] || ''}">${t('bankroll')} ${chain.yoctoToNear(ui.chain.bankrolls[id], 1)} NEAR</span>` : ''}
        ${riichiStick(p.riichi, seat)}
      </div>
      <p class="bubble ${ui.thinking === seat ? 'thinking' : ''}">${ui.thinking === seat ? '<span class="dots"><i></i><i></i><i></i></span>' : bubbleText}</p>
      <div class="backs">${p.hand.map(() => tile(null, { back: true, size: 'xxs' })).join('')}</div>
    </section>`;
}

function statusText() {
  const g = ui.game;
  if (!g) return '';
  if (ui.pending?.type === 'discard') return ui.selected != null ? t('selected', { card: cardLabel(g.players[HUMAN].hand[ui.selected]) }) : t('pickTile');
  if (ui.pending?.type === 'tsumo') return t('canTsumo', { hand: t(`hands.${ui.pending.ev.key}`), points: ui.pending.ev.points });
  if (ui.pending?.type === 'ron') return t('canRon', { name: seatName(ui.pending.from), card: cardLabel(ui.pending.tile), hand: t(`hands.${ui.pending.ev.key}`), points: ui.pending.ev.points });
  if (g.players[HUMAN].riichi && g.turn === HUMAN) return t('riichiLocked');
  if (ui.thinking != null) return t('waitingFor', { name: seatName(ui.thinking) });
  return '';
}

// The board in the middle: each player's discards sit on their own side, like a mahjong table.
function board() {
  const g = ui.game;
  const handNo = g ? Math.min(g.handNo + 1, g.totalHands) : 1;
  const total = g ? g.totalHands : 8;
  const wall = g ? g.wall.length : 38;
  const empty = { discards: [], riichiAt: -1 };
  const r = seat => river(g ? g.players[seat] : empty, seat);
  const turnSeat = g && !g.over ? g.turn : null;
  const pips = Array.from({ length: total }, (_, i) => `<i class="${i < handNo - 1 ? 'done' : i === handNo - 1 ? 'now' : ''}"></i>`).join('');
  const dealer = g ? g.dealer : 0;
  return `
    <div class="board">
      <div class="river r-top ${turnSeat === 2 ? 'turn' : ''}" aria-label="${seatName(2)}">${r(2)}</div>
      <div class="river r-left ${turnSeat === 3 ? 'turn' : ''}" aria-label="${seatName(3)}">${r(3)}</div>
      <div class="core">
        <span class="label">${t('hand')}</span>
        <span class="big">${handNo}<small>/${total}</small></span>
        <span class="pips" aria-hidden="true">${pips}</span>
        <span class="wallcount"><span class="stack" aria-hidden="true"><i></i><i></i><i></i></span><span class="label">${t('wall')}</span> <span class="num">${wall}</span></span>
        <span class="dealer-tag">${t('dealer')}: ${seatName(dealer)}</span>
      </div>
      <div class="river r-right ${turnSeat === 1 ? 'turn' : ''}" aria-label="${seatName(1)}">${r(1)}</div>
      <div class="river r-me ${turnSeat === HUMAN ? 'turn' : ''}" aria-label="${t('you')}">${r(HUMAN)}</div>
    </div>`;
}

function myArea() {
  const g = ui.game;
  const me = g ? g.players[HUMAN] : { hand: [], discards: [], riichi: false };
  const pts = g ? g.points[HUMAN] : START_POINTS;
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
    const canRiichi = sel != null && marks[sel];
    actions = `
      <button type="button" class="act" data-act="discard" ${sel == null ? 'disabled' : ''}>${t('discard')}</button>
      <button type="button" class="act gold" data-act="riichi" ${canRiichi ? '' : 'disabled'}>${t('riichiDiscard')}</button>`;
  } else if (pending?.type === 'tsumo') {
    actions = `
      <button type="button" class="act gold" data-act="yes">${t('tsumo')}</button>
      ${me.riichi ? '' : `<button type="button" class="act" data-act="no">${t('keepGoing')}</button>`}`;
  } else if (pending?.type === 'ron') {
    actions = `
      <button type="button" class="act gold" data-act="yes">${t('ron')}</button>
      <button type="button" class="act" data-act="no">${t('pass')}</button>`;
  }
  const ronTile = pending?.type === 'ron' ? `<span class="plus">+</span>${tile(pending.tile, { size: 'lg', win: true })}` : '';
  const isDealer = g && g.dealer === HUMAN;
  return `
    <section class="seat me ${g && !g.over && g.turn === HUMAN ? 'active' : ''} ${me.riichi ? 'in-riichi' : ''}" aria-label="${t('you')}">
      <p class="status" role="status">${statusText()}</p>
      <div class="me-row">
        <div class="purse">
          <span class="name">${t('you')}${isDealer ? `<span class="dealer">${t('dealer')}</span>` : ''}</span>
          <span class="pts">${pts}<small>${t('pts')}</small></span>
          <span class="near">${(pts * NEAR_PER_POINT).toFixed(1)} NEAR</span>
          ${riichiStick(me.riichi, HUMAN)}
        </div>
        <div class="hand ${once('deal') ? 'deal' : ''}" role="group" aria-label="hand">
          ${hand.map(render1).join('')}
          ${drawn ? `<span class="gap"></span>${tile(drawn.c, { size: 'lg', button: discarding, index: drawn.index, selected: ui.selected === drawn.index, mark: discarding && marks[drawn.index], win: winSet, drawnIn: once('drawn') })}` : ''}
          ${ronTile}
        </div>
      </div>
      <div class="actions">${actions}</div>
    </section>`;
}

function logPanel() {
  return ui.log.map(e => `<li class="${e.kind}">${escapeHtml(e.text)}</li>`).join('');
}

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
      <p class="eyebrow">NEAR HACKATHON · testnet</p>
      <h1 class="logo">RON<span>POKER</span></h1>
      <p class="tagline">${t('tagline')}</p>
      <ul class="rivals">
        ${[1, 2, 3].map(seat => {
          const id = AI_IDS[seat - 1];
          return `<li><span class="glyph">${GLYPH[id]}</span><span><b>${t(`names.${id}`)}</b> <em>${t(`styles.${id}`)}</em><br>${t(`bios.${id}`)}</span></li>`;
        }).join('')}
      </ul>
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
      <p>${t('logExhausted')}</p><ul class="standings">${standings(g.points, 'hand', handDeltas(r))}</ul><div class="row"><button type="button" class="act gold primary" data-act="next">${t('nextHand')}</button></div></div>`;
  }
  const lines = r.transfers.filter(x => x.amount > 0).map(x => `<li>${t('paid', { from: seatName(x.from), to: seatName(x.to), amount: x.amount })}</li>`).join('');
  return `
    <div class="sheet result">
      <p class="eyebrow">${t('hand')} ${r.handNo + 1} · ${r.type === 'ron' ? t('resultRon') : t('resultTsumo')}</p>
      <h2>${seatName(r.winner)} — ${t(`hands.${r.ev.key}`)}</h2>
      <div class="hand show">${r.hand.map(c => tile(c, { size: 'lg', win: true })).join('')}</div>
      <p class="calc"><span>${r.ev.base}</span>${r.ev.jokers ? ` × <span class="gold-text">${t('jokerBonus', { mult: r.ev.mult })}</span>` : ''}
        ${r.type === 'ron' ? ' × 3' : ''} = <b>${r.ev.points * (r.type === 'ron' ? 3 : 1)}${t('pts')}</b>${r.type === 'tsumo' ? ` <small>(${t('everyonePays')})</small>` : ''}</p>
      <ul class="transfers">${lines}</ul>
      <ul class="standings">${standings(g.points, 'hand', handDeltas(r))}</ul>
      <div class="row"><button type="button" class="act gold primary" data-act="next">${t('nextHand')}</button></div>
    </div>`;
}

function handDeltas(record) {
  const d = [0, 0, 0, 0];
  for (const x of record.transfers || []) { d[x.from] -= x.amount; d[x.to] += x.amount; }
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
      return `<li class="${seat === HUMAN ? 'me' : ''}"><span class="place">${i + 1}</span><span class="nm">${seatName(seat)}</span>
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
  $('#seat-top').innerHTML = opponentPanel(2, 'top');
  $('#seat-left').innerHTML = opponentPanel(3, 'side');
  $('#seat-right').innerHTML = opponentPanel(1, 'side');
  $('#board').innerHTML = board();
  $('#mine').innerHTML = myArea();
  $('#log').innerHTML = logPanel();
  const ov = $('#overlay');
  const view = { intro: introOverlay, result: resultOverlay, final: finalOverlay, rules: rulesOverlay, chain: chainOverlay }[ui.overlay];
  ov.hidden = !view;
  ov.innerHTML = view ? view() : '';
  $('#soundBtn').textContent = fx.isMuted() ? t('soundOff') : t('soundOn');
}

// ---- input -------------------------------------------------------------

function resolvePending(value) {
  const p = ui.pending;
  if (!p) return;
  ui.pending = null;
  ui.selected = null;
  p.resolve(value);
  render();
}

document.addEventListener('click', ev => {
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
  if (act === 'rules') { ui.overlayBefore = ui.overlay; ui.overlay = 'rules'; render(); }
  if (act === 'closeRules') { ui.overlay = ui.overlayBefore; ui.overlayBefore = null; render(); }
  if (act === 'next') { ui.overlay = null; const r = ui.resolveOverlay; ui.resolveOverlay = null; render(); r?.(); }
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

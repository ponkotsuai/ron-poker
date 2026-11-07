// Ron Poker referee service.
//
// The referee runs the lobby (random match and rooms), deals the cards, keeps every hand
// hidden, fills empty seats with AI players, accepts each human's moves over a WebSocket,
// and reports the final points to the table contract, which pays out at once.
// Players never have to sign off on the result.
//
// Run: MASTER_SECRET=... CONTRACT_ID=... node server/index.mjs

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from '../js/game.js';
import { AIController, PERSONALITIES } from '../js/ai.js';
import { CHARACTERS, CHARACTER_IDS } from '../js/characters.js';
import { START_POINTS } from '../js/engine.js';
// OFFLINE=1 swaps in an in-memory chain for local tests.
const near = await import(process.env.OFFLINE ? './near-offline.mjs' : './near.mjs');
const {
  NEAR, deriveKey, ensureAccount, hasKey, signerAccount, call, view, addPlayKey, balanceOf,
  verifySignature, sha256Hex,
} = near;

const PORT = Number(process.env.PORT || 8787);
const CONTRACT_ID = process.env.CONTRACT_ID || 'ronpoker2.testnet';
let SECRET = process.env.MASTER_SECRET;
if (!SECRET) {
  SECRET = randomBytes(32).toString('hex');
  console.warn('MASTER_SECRET is not set: using a throwaway secret (accounts change on every restart).');
}
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://ponkotsuai.github.io,http://localhost:8765').split(',');
const AI_IDS = ['tanuki', 'tsuru', 'kitsune'];
const AI_METHODS = ['join', 'abort'];
const BUY_IN = 3n * NEAR;
const AI_TOP_UP = 6n * NEAR;
// A human who does not answer in time plays the safe default: throw the card just drawn,
// or take the win. The browser shows the clock.
const DECISION_MS = { discard: 25_000, tsumo: 12_000, ron: 12_000 };
const RESULT_MS = 25_000; // how long the hand result stays up if a human does not press next
const QUEUE_MS = Number(process.env.QUEUE_MS || 15_000); // random match: wait this long for people, then fill with AIs
const PAY_MS = Number(process.env.PAY_MS || 120_000); // every human must pay the buy-in within this time
const ROOM_IDLE_MS = 15 * 60_000;
const AI_DELAY = process.env.FAST ? { discard: 0, tsumo: 0, ron: 0, auto: 0 } : { discard: 1300, tsumo: 800, ron: 800, auto: 1000 };

// ---- identities -----------------------------------------------------------

const refereeKey = deriveKey(SECRET, 'referee');
const referee = { accountId: process.env.REFEREE_ID || `ronref-${refereeKey.tag}.testnet`, key: refereeKey };
const agents = Object.fromEntries(AI_IDS.map(id => {
  const sponsor = deriveKey(SECRET, `ai:${id}:sponsor`);
  const play = deriveKey(SECRET, `ai:${id}:play:${CONTRACT_ID}`);
  return [id, { id, accountId: `${id}-${sponsor.tag}.testnet`, sponsor, play }];
}));

const status = { ready: false, error: null, contractReferee: null, bankrolls: {} };

async function bootstrap() {
  try {
    await ensureAccount(referee.accountId, referee.key.publicKey);
    for (const a of Object.values(agents)) {
      await ensureAccount(a.accountId, a.sponsor.publicKey);
      if (!(await hasKey(a.accountId, a.play.publicKey))) {
        const sponsor = signerAccount(a.accountId, a.sponsor.secretKey);
        await addPlayKey(sponsor, a.play.publicKey, CONTRACT_ID, AI_METHODS, NEAR);
      }
    }
    const cfg = await view(CONTRACT_ID, 'get_config').catch(() => null);
    status.contractReferee = cfg ? cfg[4] : null;
    if (cfg) for (const a of Object.values(agents)) await topUp(a);
    status.ready = !!cfg && status.contractReferee === referee.accountId;
    status.error = status.ready ? null : cfg ? `contract referee is ${status.contractReferee}` : `contract ${CONTRACT_ID} not found`;
  } catch (e) {
    status.error = String(e.message || e);
  }
  console.log('bootstrap', JSON.stringify({ referee: referee.accountId, ready: status.ready, error: status.error }));
}

async function topUp(agent) {
  const bank = BigInt(await view(CONTRACT_ID, 'bankroll_of', { account_id: agent.accountId }));
  if (bank < BUY_IN) {
    const spendable = (await balanceOf(agent.accountId)) - NEAR / 2n;
    const amount = spendable < AI_TOP_UP ? spendable : AI_TOP_UP;
    if (amount >= BUY_IN) {
      const sponsor = signerAccount(agent.accountId, agent.sponsor.secretKey);
      await call(sponsor, CONTRACT_ID, 'deposit', {}, amount);
    }
  }
  status.bankrolls[agent.id] = String(await view(CONTRACT_ID, 'bankroll_of', { account_id: agent.accountId }));
}

// Keep the AI bankrolls topped up in the background so opening a table never waits on it.
let refreshing = null;
function refreshBankrolls() {
  if (refreshing || !status.ready) return refreshing;
  refreshing = (async () => {
    for (const a of Object.values(agents)) { try { await topUp(a); } catch (e) { console.error('top-up', a.id, e.message); } }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
setInterval(refreshBankrolls, 3 * 60_000);

// ---- players, lobby, tables ----------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tables = new Map(); // chain table id -> Table
const rooms = new Map(); // room code -> Room
let queue = []; // players waiting for a random match
let queueTimer = null;
let queueDeadline = 0;

function cleanNickname(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 12);
  return s || null;
}

class Player {
  constructor(ws) {
    this.ws = ws;
    this.account = null;
    this.nickname = null;
    this.character = null;
    this.table = null;
    this.room = null;
    this.seat = null;
    this.inQueue = false;
  }
  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  connected() { return !!this.ws && this.ws.readyState === 1; }
  get name() { return this.nickname || this.account; }
}

// ---- random match ----

function broadcastQueue() {
  const left = Math.max(0, Math.ceil((queueDeadline - Date.now()) / 1000));
  for (const p of queue) p.send({ t: 'lobby', mode: 'queue', members: queue.map(q => q.name), seconds: left });
}

function joinQueue(p) {
  if (p.table || p.room || p.inQueue) throw new Error('already waiting or playing');
  if (queue.some(q => q.account === p.account)) throw new Error('this account is already waiting');
  p.inQueue = true;
  queue.push(p);
  if (queue.length === 1) {
    queueDeadline = Date.now() + QUEUE_MS;
    clearInterval(queueTimer);
    queueTimer = setInterval(() => {
      queue = queue.filter(q => q.connected());
      if (!queue.length) { clearInterval(queueTimer); return; }
      if (Date.now() >= queueDeadline) flushQueue(); else broadcastQueue();
    }, 1000);
  }
  if (queue.length >= 4) flushQueue(); else broadcastQueue();
}

function leaveQueue(p) {
  queue = queue.filter(q => q !== p);
  p.inQueue = false;
  broadcastQueue();
}

function flushQueue() {
  const humans = queue.splice(0, 4);
  humans.forEach(p => { p.inQueue = false; p.send({ t: 'lobby', mode: 'starting', members: humans.map(h => h.name) }); });
  if (!queue.length) clearInterval(queueTimer);
  else { queueDeadline = Date.now() + QUEUE_MS; broadcastQueue(); }
  if (humans.length) startTable(humans).catch(e => humans.forEach(p => p.send({ t: 'error', message: String(e.message || e) })));
}

// ---- rooms ----

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from(randomBytes(4), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!rooms.has(code)) return code;
  }
}

class Room {
  constructor(host) {
    this.code = newCode();
    this.host = host;
    this.members = [host];
    this.touched = Date.now();
    rooms.set(this.code, this);
  }
  broadcast() {
    this.members = this.members.filter(m => m.connected());
    if (!this.members.length) { rooms.delete(this.code); return; }
    if (!this.members.includes(this.host)) this.host = this.members[0];
    for (const m of this.members) {
      m.send({ t: 'lobby', mode: 'room', code: this.code, host: m === this.host, members: this.members.map(x => x.name) });
    }
  }
}

function createRoom(p) {
  if (p.table || p.room || p.inQueue) throw new Error('already waiting or playing');
  const r = new Room(p);
  p.room = r;
  r.broadcast();
}

function joinRoom(p, code) {
  if (p.table || p.room || p.inQueue) throw new Error('already waiting or playing');
  const r = rooms.get(String(code || '').toUpperCase().trim());
  if (!r) throw new Error('room not found');
  r.members = r.members.filter(m => m.connected());
  if (r.members.length >= 4) throw new Error('room is full');
  if (r.members.some(m => m.account === p.account)) throw new Error('this account is already in the room');
  r.members.push(p);
  r.touched = Date.now();
  p.room = r;
  r.broadcast();
}

function leaveRoom(p) {
  const r = p.room;
  if (!r) return;
  r.members = r.members.filter(m => m !== p);
  p.room = null;
  r.broadcast();
}

function startRoom(p) {
  const r = p.room;
  if (!r || r.host !== p) throw new Error('only the host can start');
  const humans = r.members.filter(m => m.connected());
  rooms.delete(r.code);
  humans.forEach(m => { m.room = null; m.send({ t: 'lobby', mode: 'starting', members: humans.map(h => h.name) }); });
  startTable(humans).catch(e => humans.forEach(m => m.send({ t: 'error', message: String(e.message || e) })));
}

setInterval(() => {
  for (const [code, r] of rooms) if (Date.now() - r.touched > ROOM_IDLE_MS) { rooms.delete(code); r.members.forEach(m => { m.room = null; m.send({ t: 'lobby', mode: 'closed' }); }); }
}, 60_000);

// ---- tables ----

async function startTable(humans) {
  if (!status.ready) await bootstrap();
  if (!status.ready) throw new Error(`referee not ready: ${status.error}`);
  const table = new Table(humans);
  await table.open();
}

class Table {
  constructor(humans) {
    this.humans = humans; // seats 0..n-1
    this.aiIds = AI_IDS.slice(0, 4 - humans.length); // seats n..3
    // Each AI account plays as a character nobody at the table has picked, in that character's style.
    const free = CHARACTER_IDS.filter(c => !humans.some(p => p.character === c)).sort(() => Math.random() - 0.5);
    this.aiChars = Object.fromEntries(this.aiIds.map((id, i) => [id, free[i]]));
    this.id = null;
    this.seed = null;
    this.game = null;
    this.paidSeats = new Set();
    this.waiting = new Map(); // seat -> { kind, fallback, resolve, timer }
    this.closed = false;
    humans.forEach((p, i) => { p.table = this; p.seat = i; });
  }

  seatInfo() {
    return [
      ...this.humans.map(p => ({ kind: 'human', name: p.name, account: p.account, character: p.character })),
      ...this.aiIds.map(id => ({ kind: 'ai', id, character: this.aiChars[id], account: agents[id].accountId })),
    ];
  }

  broadcast(msg) { this.humans.forEach(p => p.send(msg)); }
  step(key, params = {}) { this.broadcast({ t: 'step', key, params }); }
  anyoneHere() { return this.humans.some(p => p.connected()); }

  // 1. Open the table on chain (seed committed) and ask every human to pay.
  async open() {
    const t0 = Date.now();
    // Bankrolls are topped up in the background; only top up here if one is short.
    for (const id of this.aiIds) {
      if (BigInt(status.bankrolls[id] || 0) < BUY_IN) await topUp(agents[id]);
      if (BigInt(status.bankrolls[id] || 0) < BUY_IN) throw new Error('the AI players are out of testnet NEAR; try again later');
    }
    const seed = randomBytes(16).toString('hex');
    const hash = sha256Hex(seed);
    this.seed = { seed, hash, number: parseInt(hash.slice(0, 8), 16) };
    const seats = this.seatInfo();
    const ref = signerAccount(referee.accountId, referee.key.secretKey);
    const r = await call(ref, CONTRACT_ID, 'create_table', { players: seats.map(s => s.account), seed_hash: hash });
    this.id = r.value;
    tables.set(this.id, this);
    this.step('chainTableOpened', { id: this.id, hash: r.hash });
    for (const p of this.humans) p.send({ t: 'opened', tableId: this.id, seat: p.seat, seats, seedHash: hash });
    this.payTimer = setTimeout(() => this.abort('notEveryonePaid'), PAY_MS);
    console.log(`table ${this.id} opened in ${Date.now() - t0} ms for ${this.humans.length} human(s)`);
    status.lastOpenMs = Date.now() - t0;
  }

  // 2. A human paid with their wallet; check it on chain. When everyone has, the AIs pay and we deal.
  async paid(p, { publicKey, signature }) {
    const t = await view(CONTRACT_ID, 'get_table', { table_id: this.id });
    if (!t || t.players[p.seat] !== p.account) throw new Error('not your seat');
    if (!t.joined[p.seat]) throw new Error('the buy-in has not arrived yet');
    if (t.session_keys[p.seat] !== publicKey) throw new Error('session key does not match the one paid with');
    if (!verifySignature(publicKey, `ronpoker:${this.id}:${p.account}`, signature)) throw new Error('bad signature');
    if (this.paidSeats.has(p.seat)) return;
    this.paidSeats.add(p.seat);
    this.step('chainPlayerPaid', { name: p.name });
    if (this.paidSeats.size < this.humans.length || this.started) return;
    this.started = true;
    clearTimeout(this.payTimer);
    for (const id of this.aiIds) {
      const a = agents[id];
      const r = await call(signerAccount(a.accountId, a.play.secretKey), CONTRACT_ID, 'join', { table_id: this.id });
      this.step('chainAiJoined', { who: this.aiChars[id], hash: r.hash });
    }
    this.step('chainGameOn', { id: this.id });
    this.play().catch(e => this.fail(e));
  }

  async abort(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.payTimer);
    try {
      const ref = signerAccount(referee.accountId, referee.key.secretKey);
      const r = await call(ref, CONTRACT_ID, 'abort', { table_id: this.id });
      this.broadcast({ t: 'aborted', tableId: this.id, reason, hash: r.hash });
    } catch (e) {
      this.broadcast({ t: 'aborted', tableId: this.id, reason });
    }
    this.release();
  }

  // Ask one human; play the safe default if they do not answer in time or are gone.
  ask(seat, kind, payload, fallback) {
    const p = this.humans[seat];
    return new Promise(resolve => {
      const done = v => {
        const w = this.waiting.get(seat);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiting.delete(seat);
        resolve(v);
      };
      const ms = p.connected() ? (kind === 'next' ? RESULT_MS : DECISION_MS[kind] || 25_000) : 1200;
      this.waiting.set(seat, { kind, fallback, payload, resolve: done, timer: setTimeout(() => done(fallback), ms) });
      this.snapshot(p);
      p.send({ t: 'prompt', kind, ms: kind === 'next' ? undefined : ms, ...payload });
    });
  }

  answer(p, kind, value) {
    const w = this.waiting.get(p.seat);
    if (!w || w.kind !== kind) return;
    if (kind === 'discard') {
      const n = this.game.players[p.seat].hand.length;
      if (!value || !Number.isInteger(value.index) || value.index < 0 || value.index >= n) return;
      w.resolve({ index: value.index, riichi: !!value.riichi });
    } else {
      w.resolve(!!value);
    }
  }

  dropped(p) {
    const w = this.waiting.get(p.seat);
    if (w) w.resolve(w.fallback);
  }

  // Each human sees only their own hand.
  snapshot(p) {
    const g = this.game;
    if (!g) return;
    p.send({
      t: 'state',
      game: {
        you: p.seat, handNo: g.handNo, totalHands: g.totalHands, dealer: g.dealer, turn: g.turn, wallCount: g.wall.length,
        points: g.points, over: g.over, seedHash: this.seed.hash,
        players: g.players.map(pl => ({
          seat: pl.seat, discards: pl.discards, riichi: pl.riichi, riichiAt: pl.riichiAt,
          handCount: pl.hand.length, hand: pl.seat === p.seat ? pl.hand : null,
        })),
      },
    });
  }

  snapshotAll() { this.humans.forEach(p => this.snapshot(p)); }

  // 3. Play. The referee drives the game; humans only answer prompts.
  async play() {
    const pace = ms => sleep(this.anyoneHere() ? ms : 20);
    const seats = this.humans.map((p, seat) => ({
      name: p.name,
      controller: {
        chooseTsumo: (v, ev) => this.ask(seat, 'tsumo', { ev }, true),
        chooseRon: (v, tile, ev, from) => this.ask(seat, 'ron', { ev, tile, from }, true),
        chooseDiscard: v => this.ask(seat, 'discard', {}, { index: v.me.hand.length - 1, riichi: false }),
        beforeAutoDiscard: async () => { this.snapshotAll(); await pace(AI_DELAY.auto); },
      },
    }));
    this.aiIds.forEach((id, i) => {
      const seat = this.humans.length + i;
      const ai = new AIController({
        personality: PERSONALITIES[this.aiChars[id]], startPoints: START_POINTS,
        think: (key, params) => this.broadcast({ t: 'think', seat, key, params }),
      });
      const paced = (kind, fn) => async (...args) => {
        this.broadcast({ t: 'thinking', seat });
        await pace(AI_DELAY[kind]);
        return fn(...args);
      };
      seats.push({
        name: id,
        controller: {
          chooseDiscard: paced('discard', v => ai.chooseDiscard(v)),
          chooseTsumo: paced('tsumo', (v, ev) => ai.chooseTsumo(v, ev)),
          chooseRon: paced('ron', (v, tile, ev, from) => ai.chooseRon(v, tile, ev, from)),
          beforeAutoDiscard: async () => { this.broadcast({ t: 'thinking', seat }); await pace(AI_DELAY.auto); },
        },
      });
    });
    this.game = new Game({
      seats,
      seed: this.seed.number,
      onEvent: (type, e) => { this.broadcast({ t: 'event', type, e }); this.snapshotAll(); },
      afterHand: async record => {
        await Promise.all(this.humans.map((p, seat) => this.ask(seat, 'next', { record }, true)));
      },
    });
    this.snapshotAll();
    const points = await this.game.play();
    await this.settle(points);
  }

  // 4. Report the result. The contract pays out by points immediately.
  async settle(points) {
    const ref = signerAccount(referee.accountId, referee.key.secretKey);
    const r = await call(ref, CONTRACT_ID, 'settle', { table_id: this.id, points, seed: this.seed.seed });
    this.closed = true;
    this.broadcast({ t: 'settled', tableId: this.id, points, payouts: r.value, hash: r.hash, seed: this.seed.seed });
    board.updated = 0; // the ranking picks this table up on its next read
    this.release();
  }

  async fail(e) {
    console.error('table', this.id, e);
    this.broadcast({ t: 'error', message: String(e.message || e).slice(0, 200) });
    await this.abort('error');
  }

  release() {
    this.humans.forEach(p => { if (p.table === this) p.table = null; });
    refreshBankrolls();
    setTimeout(() => tables.delete(this.id), 60_000);
  }
}

// ---- ranking --------------------------------------------------------------------
// Built from the contract alone: every settled table's players and final points.
// Nicknames are not on chain; the referee remembers the ones players used since it started.

const nicknames = new Map();
const board = { scanned: 0, open: new Set(), stats: new Map(), updated: 0, busy: null };

function addSettled(t) {
  const pts = t.final_points;
  if (!pts) return;
  const buyIn = BigInt(t.buy_in || BUY_IN);
  const perPoint = buyIn / BigInt(t.start_points || START_POINTS);
  t.players.forEach((acc, i) => {
    const s = board.stats.get(acc) || { games: 0, net: 0n, firsts: 0, rankSum: 0 };
    const rank = 1 + pts.filter(p => p > pts[i]).length;
    s.games += 1;
    s.net += BigInt(pts[i]) * perPoint - buyIn;
    s.rankSum += rank;
    if (rank === 1) s.firsts += 1;
    board.stats.set(acc, s);
  });
}

async function updateBoard() {
  if (board.busy) return board.busy;
  board.busy = (async () => {
    const cfg = await view(CONTRACT_ID, 'get_config');
    const next = Number(cfg[3]);
    const ids = [...board.open];
    for (let id = board.scanned; id < next; id++) ids.push(id);
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8);
      const got = await Promise.all(batch.map(id => view(CONTRACT_ID, 'get_table', { table_id: id }).catch(() => undefined)));
      batch.forEach((id, k) => {
        const t = got[k];
        if (t === undefined) { board.open.add(id); return; } // RPC hiccup: try again next time
        board.open.delete(id);
        if (!t) return;
        if (t.status === 'Settled') addSettled(t);
        else if (t.status === 'Waiting' || t.status === 'Playing') board.open.add(id);
      });
    }
    board.scanned = Math.max(board.scanned, next);
    board.updated = Date.now();
  })().finally(() => { board.busy = null; });
  return board.busy;
}

async function leaderboard() {
  if (Date.now() - board.updated > 30_000) await updateBoard();
  const aiAccounts = Object.fromEntries(Object.values(agents).map((a, i) => [a.accountId, i + 1]));
  const rows = [...board.stats.entries()].map(([account, s]) => ({
    account,
    name: nicknames.get(account) || null,
    ai: aiAccounts[account] || null,
    games: s.games,
    net: s.net.toString(),
    firsts: s.firsts,
    avgRank: +(s.rankSum / s.games).toFixed(2),
  }));
  rows.sort((a, b) => (BigInt(b.net) > BigInt(a.net) ? 1 : BigInt(b.net) < BigInt(a.net) ? -1 : a.avgRank - b.avgRank));
  return { updated: board.updated, tables: board.scanned, rows: rows.slice(0, 100) };
}

// ---- server -------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (process.env.OFFLINE && req.url.startsWith('/test/')) {
    // Stand-in wallet for local UI tests on the in-memory chain.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/test/bankroll')) {
      const account = new URL(req.url, 'http://x').searchParams.get('account');
      view(CONTRACT_ID, 'bankroll_of', { account_id: account }).then(v => res.end(String(v)));
      return;
    }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { tableId, account, sessionKey } = JSON.parse(body);
        near.joinTable(account, tableId, sessionKey, 3n * NEAR);
        res.end('ok');
      } catch (e) { res.statusCode = 400; res.end(String(e.message)); }
    });
    return;
  }
  if (req.url.startsWith('/leaderboard')) {
    res.setHeader('Content-Type', 'application/json');
    leaderboard().then(b => res.end(JSON.stringify(b)), e => { res.statusCode = 503; res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (req.url.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, ready: status.ready, error: status.error, contract: CONTRACT_ID,
      referee: referee.accountId, contractReferee: status.contractReferee,
      agents: Object.fromEntries(Object.values(agents).map(a => [a.id, { account: a.accountId, bankroll: status.bankrolls[a.id] || null }])),
      tables: [...tables.values()].filter(t => !t.closed).length, waiting: queue.length, rooms: rooms.size,
      lastOpenMs: status.lastOpenMs || null,
    }));
    return;
  }
  res.statusCode = 404;
  res.end('Ron Poker referee. Connect over WebSocket at /ws.');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) { ws.close(1008, 'origin not allowed'); return; }
  let player = new Player(ws);
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.t === 'hello') {
        if (!status.ready) await bootstrap();
        if (!status.ready) throw new Error(`referee not ready: ${status.error}`);
        if (typeof msg.account !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(msg.account)) throw new Error('bad account');
        player.account = msg.account;
        player.nickname = cleanNickname(msg.nickname);
        player.character = Object.hasOwn(CHARACTERS, msg.character) ? msg.character : null;
        if (player.nickname) nicknames.set(player.account, player.nickname);
        player.send({ t: 'hello', referee: referee.accountId, contract: CONTRACT_ID, agents: Object.fromEntries(Object.values(agents).map(a => [a.id, a.accountId])) });
      } else if (msg.t === 'resume') {
        const t = tables.get(msg.tableId);
        if (!t || t.closed) throw new Error('no game to resume');
        const seat = t.humans.findIndex(p => p.account === msg.account);
        if (seat < 0) throw new Error('not at this table');
        const onChain = await view(CONTRACT_ID, 'get_table', { table_id: msg.tableId });
        if (!verifySignature(onChain.session_keys[seat], `ronpoker:${msg.tableId}:${msg.account}`, msg.signature)) throw new Error('bad signature');
        const p = t.humans[seat];
        p.ws = ws;
        player = p;
        t.snapshot(p);
        const w = t.waiting.get(seat);
        if (w) p.send({ t: 'prompt', kind: w.kind, ...w.payload });
      } else if (!player.account) {
        throw new Error('say hello first');
      } else if (msg.t === 'quick') {
        joinQueue(player);
      } else if (msg.t === 'createRoom') {
        createRoom(player);
      } else if (msg.t === 'joinRoom') {
        joinRoom(player, msg.code);
      } else if (msg.t === 'startRoom') {
        startRoom(player);
      } else if (msg.t === 'leave') {
        leaveQueue(player);
        leaveRoom(player);
        player.send({ t: 'lobby', mode: 'idle' });
      } else if (msg.t === 'paid') {
        if (!player.table) throw new Error('no table');
        await player.table.paid(player, msg);
      } else if (msg.t === 'decide') {
        if (player.table) player.table.answer(player, msg.kind, msg.value);
      }
    } catch (e) {
      player.send({ t: 'error', message: String(e.message || e).slice(0, 200) });
    }
  });
  ws.on('close', () => {
    if (player.inQueue) leaveQueue(player);
    if (player.room) leaveRoom(player);
    // A game keeps going: the absent player's moves are played safely and the table still settles.
    if (player.table && player.ws === ws) player.table.dropped(player);
  });
});

server.listen(PORT, () => {
  console.log(`referee listening on ${PORT}, contract ${CONTRACT_ID}, referee ${referee.accountId}`);
  bootstrap();
});

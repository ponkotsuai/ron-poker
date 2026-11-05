// Ron Poker referee service.
//
// The referee deals the cards, keeps every hand hidden, runs the three AI players,
// accepts the human's moves over a WebSocket, and reports the final points to the
// table contract, which pays out at once. Players never have to sign off on the result.
//
// Run: MASTER_SECRET=... CONTRACT_ID=... node server/index.mjs

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from '../js/game.js';
import { AIController, PERSONALITIES } from '../js/ai.js';
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
const DECISION_MS = 60_000; // a human who does not answer in time plays the safe default
const RESULT_MS = 25_000; // how long the hand result stays up if the human does not press next
const AI_DELAY = process.env.FAST ? { discard: 0, tsumo: 0, ron: 0, auto: 0 } : { discard: 800, tsumo: 500, ron: 500, auto: 600 };

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

// ---- sessions ---------------------------------------------------------------

const sessions = new Map(); // tableId -> Session
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Session {
  constructor(ws, account) {
    this.ws = ws;
    this.account = account;
    this.tableId = null;
    this.seed = null;
    this.game = null;
    this.waiting = null; // { kind, resolve, timer }
    this.closed = false;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  step(key, params = {}) {
    this.send({ t: 'step', key, params });
  }

  connected() {
    return this.ws && this.ws.readyState === 1;
  }

  // Ask the human; fall back to `fallback` on timeout or disconnect.
  ask(kind, payload, fallback) {
    return new Promise(resolve => {
      const done = v => {
        if (!this.waiting) return;
        clearTimeout(this.waiting.timer);
        this.waiting = null;
        resolve(v);
      };
      const ms = this.connected() ? (kind === 'next' ? RESULT_MS : DECISION_MS) : 1200;
      this.waiting = { kind, fallback, resolve: done, timer: setTimeout(() => done(fallback), ms) };
      this.snapshot();
      this.send({ t: 'prompt', kind, ...payload });
    });
  }

  answer(kind, value) {
    const w = this.waiting;
    if (!w || w.kind !== kind) return;
    if (kind === 'discard') {
      const n = this.game.players[0].hand.length;
      if (!value || !Number.isInteger(value.index) || value.index < 0 || value.index >= n) return;
      w.resolve({ index: value.index, riichi: !!value.riichi });
    } else {
      w.resolve(!!value);
    }
  }

  snapshot() {
    const g = this.game;
    if (!g) return;
    this.send({
      t: 'state',
      game: {
        handNo: g.handNo, totalHands: g.totalHands, dealer: g.dealer, turn: g.turn, wallCount: g.wall.length,
        points: g.points, over: g.over, seedHash: this.seed.hash,
        players: g.players.map(p => ({
          seat: p.seat, name: p.name, discards: p.discards, riichi: p.riichi, riichiAt: p.riichiAt,
          handCount: p.hand.length, hand: p.seat === 0 ? p.hand : null,
        })),
      },
    });
  }

  // 1. Open a table for this player and the three AIs. Seed is committed now.
  async open() {
    for (const a of Object.values(agents)) await topUp(a);
    const seed = randomBytes(16).toString('hex');
    this.seed = { seed, hash: sha256Hex(seed) };
    this.seed.number = parseInt(this.seed.hash.slice(0, 8), 16);
    const players = [this.account, ...AI_IDS.map(id => agents[id].accountId)];
    const ref = signerAccount(referee.accountId, referee.key.secretKey);
    const r = await call(ref, CONTRACT_ID, 'create_table', { players, seed_hash: this.seed.hash });
    this.tableId = r.value;
    sessions.set(this.tableId, this);
    this.step('chainTableOpened', { id: this.tableId, hash: r.hash });
    this.send({ t: 'opened', tableId: this.tableId, seedHash: this.seed.hash, players });
  }

  // 2. The human has paid with their wallet; prove the seat with the session key, then the AIs pay.
  async paid({ publicKey, signature }) {
    const table = await view(CONTRACT_ID, 'get_table', { table_id: this.tableId });
    if (!table || table.players[0] !== this.account) throw new Error('not your table');
    if (!table.joined[0]) throw new Error('the buy-in has not arrived yet');
    if (table.session_keys[0] !== publicKey) throw new Error('session key does not match the one paid with');
    if (!verifySignature(publicKey, `ronpoker:${this.tableId}:${this.account}`, signature)) throw new Error('bad signature');
    for (let i = 1; i < 4; i++) {
      if (table.joined[i]) continue;
      const a = agents[AI_IDS[i - 1]];
      const r = await call(signerAccount(a.accountId, a.play.secretKey), CONTRACT_ID, 'join', { table_id: this.tableId });
      this.step('chainAiJoined', { who: a.id, hash: r.hash });
    }
    this.step('chainGameOn', { id: this.tableId });
    this.play().catch(e => this.fail(e));
  }

  // 3. Play eight hands. The referee drives everything; the human only answers prompts.
  async play() {
    const human = {
      chooseTsumo: (v, ev) => this.ask('tsumo', { ev }, true),
      chooseRon: (v, tile, ev, from) => this.ask('ron', { ev, tile, from }, true),
      chooseDiscard: v => this.ask('discard', {}, { index: v.me.hand.length - 1, riichi: false }),
      beforeAutoDiscard: async () => { this.snapshot(); await sleep(this.connected() ? AI_DELAY.auto : 50); },
    };
    const seats = [{ name: 'you', controller: human }];
    AI_IDS.forEach((id, i) => {
      const seat = i + 1;
      const ai = new AIController({
        personality: PERSONALITIES[id], startPoints: START_POINTS,
        think: (key, params) => this.send({ t: 'think', seat, key, params }),
      });
      const paced = kind => async (...args) => {
        this.send({ t: 'thinking', seat });
        await sleep(this.connected() ? AI_DELAY[kind] : 30);
        return ai[{ discard: 'chooseDiscard', tsumo: 'chooseTsumo', ron: 'chooseRon' }[kind]](...args);
      };
      seats.push({
        name: id,
        controller: {
          chooseDiscard: paced('discard'), chooseTsumo: paced('tsumo'), chooseRon: paced('ron'),
          beforeAutoDiscard: async () => { this.send({ t: 'thinking', seat }); await sleep(this.connected() ? AI_DELAY.auto : 30); },
        },
      });
    });
    this.game = new Game({
      seats,
      seed: this.seed.number,
      onEvent: (type, e) => { this.send({ t: 'event', type, e }); this.snapshot(); },
      afterHand: async record => { await this.ask('next', { record }, true); },
    });
    this.snapshot();
    const points = await this.game.play();
    await this.settle(points);
  }

  // 4. Report the result. The contract pays out by points immediately.
  async settle(points) {
    const ref = signerAccount(referee.accountId, referee.key.secretKey);
    const r = await call(ref, CONTRACT_ID, 'settle', { table_id: this.tableId, points, seed: this.seed.seed });
    this.send({ t: 'settled', tableId: this.tableId, points, payouts: r.value, hash: r.hash, seed: this.seed.seed });
    this.finish();
  }

  async fail(e) {
    console.error('table', this.tableId, e);
    this.send({ t: 'error', message: String(e.message || e).slice(0, 200) });
    if (this.tableId != null) {
      try {
        const ref = signerAccount(referee.accountId, referee.key.secretKey);
        const r = await call(ref, CONTRACT_ID, 'abort', { table_id: this.tableId });
        this.send({ t: 'aborted', tableId: this.tableId, hash: r.hash });
      } catch { /* already closed */ }
    }
    this.finish();
  }

  finish() {
    this.closed = true;
    if (this.tableId != null) setTimeout(() => sessions.delete(this.tableId), 60_000);
  }
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
  if (req.url.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, ready: status.ready, error: status.error, contract: CONTRACT_ID,
      referee: referee.accountId, contractReferee: status.contractReferee,
      agents: Object.fromEntries(Object.values(agents).map(a => [a.id, { account: a.accountId, bankroll: status.bankrolls[a.id] || null }])),
      tables: sessions.size,
    }));
    return;
  }
  res.statusCode = 404;
  res.end('Ron Poker referee. Connect over WebSocket at /ws.');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) { ws.close(1008, 'origin not allowed'); return; }
  let session = null;
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.t === 'hello') {
        if (!status.ready) await bootstrap();
        if (!status.ready) throw new Error(`referee not ready: ${status.error}`);
        if (typeof msg.account !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(msg.account)) throw new Error('bad account');
        session = new Session(ws, msg.account);
        ws.send(JSON.stringify({ t: 'hello', referee: referee.accountId, contract: CONTRACT_ID, agents: Object.fromEntries(Object.values(agents).map(a => [a.id, a.accountId])) }));
      } else if (msg.t === 'resume') {
        const s = sessions.get(msg.tableId);
        if (!s || s.closed || s.account !== msg.account) throw new Error('no game to resume');
        const table = await view(CONTRACT_ID, 'get_table', { table_id: msg.tableId });
        if (!verifySignature(table.session_keys[0], `ronpoker:${msg.tableId}:${msg.account}`, msg.signature)) throw new Error('bad signature');
        s.ws = ws;
        session = s;
        s.snapshot();
        if (s.waiting) s.send({ t: 'prompt', kind: s.waiting.kind });
      } else if (!session) {
        throw new Error('say hello first');
      } else if (msg.t === 'open') {
        if (session.tableId != null) throw new Error('table already open');
        await session.open();
      } else if (msg.t === 'paid') {
        await session.paid(msg);
      } else if (msg.t === 'decide') {
        session.answer(msg.kind, msg.value);
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', message: String(e.message || e).slice(0, 200) }));
    }
  });
  ws.on('close', () => {
    // The game keeps going: the absent player's moves are played automatically and the table settles.
    if (session && session.ws === ws && session.waiting) session.waiting.resolve(session.waiting.fallback);
  });
});

server.listen(PORT, () => {
  console.log(`referee listening on ${PORT}, contract ${CONTRACT_ID}, referee ${referee.accountId}`);
  bootstrap();
});

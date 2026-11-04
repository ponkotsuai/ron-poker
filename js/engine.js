// Ron Poker rules engine. Pure functions, no DOM. Rulebook v0.1.

export const SUITS = ['s', 'h', 'd', 'c'];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const CAT = {
  TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8, ROYAL: 9,
};
export const CAT_KEYS = {
  3: 'trips', 4: 'straight', 5: 'flush', 6: 'fullHouse', 7: 'quads', 8: 'straightFlush', 9: 'royal',
};
export const BASE_POINTS = { 3: 1, 4: 2, 5: 3, 6: 4, 7: 10, 8: 20, 9: 50 };

export const START_POINTS = 30;
export const HANDS_PER_GAME = 8;
export const HAND_SIZE = 4;
export const RON_MULTIPLIER = 3;

// ---- cards -------------------------------------------------------------

export function card(r, s) {
  return { id: `${r}${s}`, r, s, joker: false };
}
export function joker(n) {
  return { id: `J${n}`, r: 0, s: 'j', joker: true };
}
export function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(card(r, s));
  d.push(joker(1), joker(2));
  return d;
}

// Seedable RNG (mulberry32) so a shuffle can be reproduced from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- hand evaluation ---------------------------------------------------

// Standard poker category of exactly 5 natural cards (no jokers). Returns 0-9.
function pokerCategory(cards) {
  const rs = cards.map(c => c.r).sort((a, b) => a - b);
  const counts = {};
  for (const r of rs) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.values(counts).sort((a, b) => b - a);
  const flush = cards.every(c => c.s === cards[0].s);
  const uniq = [...new Set(rs)];
  let straight = false;
  let high = 0;
  if (uniq.length === 5) {
    if (uniq[4] - uniq[0] === 4) { straight = true; high = uniq[4]; }
    else if (uniq.join() === '2,3,4,5,14') { straight = true; high = 5; }
  }
  if (straight && flush) return high === 14 ? CAT.ROYAL : CAT.STRAIGHT_FLUSH;
  if (groups[0] === 4) return CAT.QUADS;
  if (groups[0] === 3 && groups[1] === 2) return CAT.FULL_HOUSE;
  if (flush) return CAT.FLUSH;
  if (straight) return CAT.STRAIGHT;
  if (groups[0] === 3) return CAT.TRIPS;
  if (groups[0] === 2 && groups[1] === 2) return 2;
  if (groups[0] === 2) return 1;
  return 0;
}

// Evaluate a 5-card hand. Jokers are not wild: they are score multipliers.
//  - no joker: any poker hand of trips or better wins
//  - 1 joker: the other 4 cards must hold trips or quads
//  - 2 jokers: the other 3 cards must be the same rank (trips)
// Returns null when the hand does not win, else { cat, key, base, jokers, mult, points }.
export function evaluate(cards) {
  if (cards.length !== 5) return null;
  const jokers = cards.filter(c => c.joker).length;
  const naturals = cards.filter(c => !c.joker);
  let cat = 0;
  if (jokers === 0) {
    cat = pokerCategory(naturals);
  } else {
    const counts = {};
    for (const c of naturals) counts[c.r] = (counts[c.r] || 0) + 1;
    const top = Math.max(0, ...Object.values(counts));
    if (jokers === 1) cat = top === 4 ? CAT.QUADS : top === 3 ? CAT.TRIPS : 0;
    else if (jokers === 2) cat = top === 3 ? CAT.TRIPS : 0;
  }
  if (cat < CAT.TRIPS) return null;
  const base = BASE_POINTS[cat];
  const mult = 2 ** jokers;
  return { cat, key: CAT_KEYS[cat], base, jokers, mult, points: base * mult };
}

// Natural cards (from `pool`, default the whole 52) that would complete a 4-card hand.
export function waitingCards(hand4, pool = null) {
  const candidates = pool || makeDeck().filter(c => !c.joker);
  const held = new Set(hand4.map(c => c.id));
  const out = [];
  for (const c of candidates) {
    if (c.joker || held.has(c.id)) continue;
    const ev = evaluate([...hand4, c]);
    if (ev) out.push({ card: c, ev });
  }
  return out;
}

// Tenpai (ready): at least one natural card completes the hand.
export function isTenpai(hand4) {
  return waitingCards(hand4).length > 0;
}

// Ranks a player has discarded this hand (furiten check). Jokers are ignored.
export function discardedRanks(discards) {
  return new Set(discards.filter(c => !c.joker).map(c => c.r));
}

// Can `player` call ron on `tile`? Only riichi players, never on a joker, never furiten.
export function canRon(player, tile) {
  if (!player.riichi || tile.joker) return null;
  if (discardedRanks(player.discards).has(tile.r)) return null;
  return evaluate([...player.hand, tile]);
}

// ---- payments ----------------------------------------------------------

// Returns a list of { from, to, amount } transfers. Payers never go below zero.
export function payments({ winner, loser, points, playerPoints }) {
  const out = [];
  if (loser != null) {
    const amount = Math.min(points * RON_MULTIPLIER, playerPoints[loser]);
    out.push({ from: loser, to: winner, amount });
  } else {
    for (let i = 0; i < playerPoints.length; i++) {
      if (i === winner) continue;
      out.push({ from: i, to: winner, amount: Math.min(points, playerPoints[i]) });
    }
  }
  return out;
}

export function applyPayments(playerPoints, transfers) {
  const p = playerPoints.slice();
  for (const t of transfers) { p[t.from] -= t.amount; p[t.to] += t.amount; }
  return p;
}

// Order in which seats may claim a discard: starting with the discarder's next seat.
export function ronOrder(discarder, seats = 4) {
  const o = [];
  for (let k = 1; k < seats; k++) o.push((discarder + k) % seats);
  return o;
}

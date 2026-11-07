// AI players. Each AI plays with its own bankroll in mind:
// its personality sets a baseline, and its current points shift it into a mood.

import { CHARACTERS, CHARACTER_IDS, AI_SKIN } from './characters.js';
import { makeDeck, evaluate, waitingCards, discardedRanks, CAT_KEYS } from './engine.js';

// One playing style per character, plus the referee's AI accounts under their old names.
export const PERSONALITIES = Object.fromEntries([
  ...CHARACTER_IDS.map(id => [id, { id, ...CHARACTERS[id].play }]),
  ...Object.entries(AI_SKIN).map(([acc, id]) => [acc, { id, ...CHARACTERS[id].play }]),
]);

export function moodOf(points, start) {
  if (points <= start * 0.4) return 'survival';
  if (points >= start * 1.4) return 'comfortable';
  return 'steady';
}

// Personality adjusted by mood. The adaptive fox reacts twice as hard.
export function temperament(personality, points, start) {
  const mood = moodOf(points, start);
  const k = personality.adaptive ? 2 : 1;
  let { greed, risk, keepJoker } = personality;
  if (mood === 'survival') { greed *= 1 - 0.25 * k; risk *= 1 + 0.5 * k; keepJoker *= 0.5; }
  if (mood === 'comfortable') { greed *= 1 + 0.15 * k; risk *= 1 - 0.2 * k; keepJoker = Math.min(1, keepJoker * 1.2); }
  return { mood, greed: Math.max(0.4, greed), risk: Math.max(0.1, risk), keepJoker };
}

const FULL = makeDeck();

// Character quirks on top of the numbers:
//   ronOnly     never wins on its own draw; only takes points straight from another player
//   minCat      ignores wins below this hand category (see CAT_KEYS)
//   neverJoker  never throws a joker away by choice
const counts = (p, ev) => !!ev && ev.cat >= (p.minCat || 0);

function unseenFor(view) {
  const seen = new Set(view.me.hand.map(c => c.id));
  for (const p of view.players) for (const c of p.discards) seen.add(c.id);
  return FULL.filter(c => !seen.has(c.id));
}

function key(cards) {
  return cards.map(c => c.id).sort().join(',');
}

// Expected weighted win value of one more draw from a 4-card hand.
function oneStep(h4, unseen, greed, cache, p) {
  const k = key(h4);
  if (cache.has(k)) return cache.get(k);
  let s = 0;
  for (const c of unseen) {
    const ev = evaluate([...h4, c]);
    if (counts(p, ev)) s += Math.pow(ev.points, greed);
  }
  const v = s / Math.max(1, unseen.length);
  cache.set(k, v);
  return v;
}

// Two-step lookahead: win now, or improve and win on the following draws.
function handValue(h4, unseen, greed, drawsLeft, cache, p) {
  let s = 0;
  const future = Math.min(3, Math.max(0, drawsLeft - 1));
  for (const c of unseen) {
    const five = [...h4, c];
    const ev = evaluate(five);
    if (counts(p, ev)) { s += Math.pow(ev.points, greed); continue; }
    if (future === 0) continue;
    let best = 0;
    for (let i = 0; i < 5; i++) {
      const next = five.filter((_, j) => j !== i);
      const v = oneStep(next, unseen.filter(u => u.id !== c.id), greed, cache, p);
      if (v > best) best = v;
    }
    s += best * future * 0.8;
  }
  return s / Math.max(1, unseen.length);
}

// Chance-weighted loss of throwing `tile` into riichi opponents.
function danger(tile, view) {
  if (tile.joker) return 0;
  let d = 0;
  for (const p of view.players) {
    if (p.seat === view.seat || !p.riichi) continue;
    if (discardedRanks(p.discards).has(tile.r)) continue; // furiten: safe
    d += 0.15 * 6; // ~15% hit chance, ~6 points lost on an average ron
  }
  return d;
}

function targetOf(h4, p = {}) {
  const waits = waitingCards(h4).filter(w => counts(p, w.ev));
  if (waits.length) return CAT_KEYS[Math.max(...waits.map(w => w.ev.cat))];
  const nat = h4.filter(c => !c.joker);
  const byRank = {};
  const bySuit = {};
  for (const c of nat) { byRank[c.r] = (byRank[c.r] || 0) + 1; bySuit[c.s] = (bySuit[c.s] || 0) + 1; }
  if (Math.max(0, ...Object.values(bySuit)) >= 3) return 'flush';
  if (Math.max(0, ...Object.values(byRank)) >= 2) return (p.minCat || 0) > 3 ? 'fullHouse' : 'trips';
  return 'straight';
}

export class AIController {
  constructor({ personality, think = () => {}, startPoints = 30 }) {
    this.p = personality;
    this.think = think; // (key, params) => void
    this.start = startPoints;
  }

  temper(view) {
    return temperament(this.p, view.points[view.seat], this.start);
  }

  async chooseTsumo(view, ev) {
    if (this.p.ronOnly) { this.think('thinkNoTsumo', {}); return false; }
    if (!counts(this.p, ev)) { this.think('thinkTooSmall', { hand: ev.key }); return false; }
    this.think('thinkTsumo', { hand: ev.key, points: ev.points });
    return true;
  }

  async chooseRon(view, tile, ev) {
    if (!counts(this.p, ev)) { this.think('thinkTooSmall', { hand: ev.key }); return false; }
    this.think(this.p.ronOnly ? 'thinkRug' : 'thinkRon', { hand: ev.key, points: ev.points });
    return true;
  }

  async chooseDiscard(view) {
    const t = this.temper(view);
    const hand = view.me.hand;
    const unseen = unseenFor(view);
    const drawsLeft = Math.floor(view.wallCount / 4) + 1;
    const cache = new Map();
    const hasJoker = hand.some(c => c.joker);
    const threatened = view.players.some(p => p.seat !== view.seat && p.riichi);

    const options = hand.map((tile, index) => {
      const rest = hand.filter((_, i) => i !== index);
      const value = handValue(rest, unseen, t.greed, drawsLeft, cache, this.p) * 4;
      let score = value - t.risk * danger(tile, view);
      if (tile.joker) {
        // Keeping a joker is worth something beyond the math: a shot at double points.
        score -= t.keepJoker * 0.6;
        if (threatened) score += (1 - t.keepJoker) * 1.2;
        if (this.p.neverJoker) score = -Infinity;
      }
      return { index, tile, rest, value, score, danger: danger(tile, view) };
    });
    options.sort((a, b) => b.score - a.score);
    const best = options[0];
    const greedyBest = options.slice().sort((a, b) => b.value - a.value)[0];

    // Riichi when ready, unless a greedy player is holding out for a bigger hand early on.
    const waits = waitingCards(best.rest, unseen).filter(w => counts(this.p, w.ev));
    let riichi = waits.length > 0;
    const topWait = waits.reduce((m, w) => Math.max(m, w.ev.points), 0);
    if (riichi && t.greed > 1.3 && topWait <= 1 && view.wallCount > 22 && !this.p.ronOnly) riichi = false;

    if (riichi) {
      this.think('thinkRiichi', { waits: new Set(waits.map(w => w.card.r)).size, points: topWait });
    } else if (best.tile.joker && threatened) {
      this.think('thinkJokerShield', {});
    } else if (threatened && best.index !== greedyBest.index && best.danger === 0) {
      this.think('thinkSafe', { card: best.tile.id });
    } else if (hasJoker && !best.tile.joker) {
      this.think('thinkKeepJoker', {});
    } else if (waits.length === 0 && Math.random() < 0.45) {
      this.think('thinkBuild', { target: targetOf(best.rest, this.p) });
    }
    return { index: best.index, riichi };
  }
}

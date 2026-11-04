import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  card, joker, evaluate, waitingCards, isTenpai, canRon, payments, applyPayments, ronOrder, makeDeck,
} from '../js/engine.js';

const c = (r, s) => card(r, s);
const J1 = joker(1);
const J2 = joker(2);

test('deck has 54 unique cards', () => {
  const d = makeDeck();
  assert.equal(d.length, 54);
  assert.equal(new Set(d.map(x => x.id)).size, 54);
});

test('hands below three of a kind do not win', () => {
  assert.equal(evaluate([c(2, 's'), c(5, 'h'), c(9, 'd'), c(11, 'c'), c(13, 's')]), null);
  assert.equal(evaluate([c(2, 's'), c(2, 'h'), c(9, 'd'), c(11, 'c'), c(13, 's')]), null);
  assert.equal(evaluate([c(2, 's'), c(2, 'h'), c(9, 'd'), c(9, 'c'), c(13, 's')]), null);
});

test('poker categories and base points', () => {
  const cases = [
    [[c(7, 's'), c(7, 'h'), c(7, 'd'), c(2, 'c'), c(9, 's')], 'trips', 1],
    [[c(5, 's'), c(6, 'h'), c(7, 'd'), c(8, 'c'), c(9, 's')], 'straight', 2],
    [[c(14, 's'), c(2, 'h'), c(3, 'd'), c(4, 'c'), c(5, 's')], 'straight', 2],
    [[c(2, 'h'), c(6, 'h'), c(9, 'h'), c(11, 'h'), c(13, 'h')], 'flush', 3],
    [[c(4, 's'), c(4, 'h'), c(4, 'd'), c(9, 'c'), c(9, 's')], 'fullHouse', 4],
    [[c(8, 's'), c(8, 'h'), c(8, 'd'), c(8, 'c'), c(3, 's')], 'quads', 10],
    [[c(5, 'd'), c(6, 'd'), c(7, 'd'), c(8, 'd'), c(9, 'd')], 'straightFlush', 20],
    [[c(10, 'c'), c(11, 'c'), c(12, 'c'), c(13, 'c'), c(14, 'c')], 'royal', 50],
  ];
  for (const [hand, key, pts] of cases) {
    const ev = evaluate(hand);
    assert.ok(ev, key);
    assert.equal(ev.key, key);
    assert.equal(ev.points, pts);
  }
});

test('Q-K-A-2-3 is not a straight', () => {
  assert.equal(evaluate([c(12, 's'), c(13, 'h'), c(14, 'd'), c(2, 'c'), c(3, 's')]), null);
});

test('jokers are multipliers, not wild cards', () => {
  // joker + trips = trips x2
  let ev = evaluate([J1, c(7, 's'), c(7, 'h'), c(7, 'd'), c(2, 'c')]);
  assert.equal(ev.key, 'trips');
  assert.equal(ev.points, 2);
  // joker + quads = quads x2
  ev = evaluate([J1, c(7, 's'), c(7, 'h'), c(7, 'd'), c(7, 'c')]);
  assert.equal(ev.key, 'quads');
  assert.equal(ev.points, 20);
  // joker does not complete a pair into trips
  assert.equal(evaluate([J1, c(7, 's'), c(7, 'h'), c(2, 'd'), c(9, 'c')]), null);
  // joker never makes a straight or flush
  assert.equal(evaluate([J1, c(5, 'h'), c(6, 'h'), c(7, 'h'), c(8, 'h')]), null);
  // two jokers + trips = trips x4
  ev = evaluate([J1, J2, c(9, 's'), c(9, 'h'), c(9, 'd')]);
  assert.equal(ev.points, 4);
  assert.equal(evaluate([J1, J2, c(9, 's'), c(9, 'h'), c(3, 'd')]), null);
});

test('waiting cards and tenpai', () => {
  // 2,2,3,3 waits on any 2 or 3 for a full house
  const waits = waitingCards([c(2, 's'), c(2, 'h'), c(3, 's'), c(3, 'h')]);
  assert.deepEqual(new Set(waits.map(w => w.card.r)), new Set([2, 3]));
  assert.ok(waits.every(w => w.ev.key === 'fullHouse'));
  assert.equal(isTenpai([c(2, 's'), c(5, 'h'), c(9, 'd'), c(13, 'c')]), false);
  assert.equal(isTenpai([J1, c(7, 's'), c(7, 'h'), c(2, 'd')]), true);
});

test('ron needs riichi, no furiten, and never on a joker', () => {
  const hand = [c(2, 's'), c(2, 'h'), c(3, 's'), c(3, 'h')];
  const p = { hand, discards: [], riichi: false };
  assert.equal(canRon(p, c(2, 'd')), null);
  p.riichi = true;
  assert.equal(canRon(p, c(2, 'd')).key, 'fullHouse');
  assert.equal(canRon(p, J1), null);
  p.discards = [c(3, 'c')];
  assert.equal(canRon(p, c(3, 'd')), null, 'furiten on 3');
  assert.ok(canRon(p, c(2, 'd')), '2 is still fine');
});

test('payments: ron x3 from discarder, tsumo x1 from each, capped at balance', () => {
  let t = payments({ winner: 0, loser: 2, points: 4, playerPoints: [30, 30, 30, 30] });
  assert.deepEqual(t, [{ from: 2, to: 0, amount: 12 }]);
  t = payments({ winner: 1, loser: null, points: 3, playerPoints: [30, 30, 30, 2] });
  assert.deepEqual(t.map(x => x.amount), [3, 3, 2]);
  assert.deepEqual(applyPayments([30, 30, 30, 2], t), [27, 38, 27, 0]);
  t = payments({ winner: 0, loser: 1, points: 50, playerPoints: [30, 30, 30, 30] });
  assert.equal(t[0].amount, 30);
});

test('ron priority starts at the discarder\'s next seat', () => {
  assert.deepEqual(ronOrder(2), [3, 0, 1]);
});

// Game flow: a table of 4 seats playing HANDS_PER_GAME hands.
// Seats are driven by controllers (human UI or AI) through three async decisions.

import {
  makeDeck, shuffle, rng, evaluate, canRon, isTenpai, payments, applyPayments, ronOrder,
  START_POINTS, HANDS_PER_GAME, HAND_SIZE,
} from './engine.js';

export const BET = 1; // a riichi bet and a fold fee
export const RIICHI_MIN = 2; // you need more than the bet to declare riichi, so it can never knock you out

export class Game {
  constructor({ seats, seed = Date.now(), startPoints = START_POINTS, hands = HANDS_PER_GAME, onEvent = () => {}, afterHand = null }) {
    this.afterHand = afterHand; // optional async (record) => void, e.g. to show a result screen
    this.seats = seats; // [{ name, controller }]
    this.seed = seed >>> 0;
    this.rand = rng(this.seed);
    this.totalHands = hands;
    this.points = seats.map(() => startPoints);
    this.startPoints = startPoints;
    this.handNo = 0;
    this.dealer = 0;
    this.history = [];
    this.emit = onEvent;
    this.players = seats.map((s, i) => ({ seat: i, name: s.name, hand: [], discards: [], riichi: false, riichiAt: -1, folded: false }));
    this.pot = []; // points on the table this hand: riichi bets and fold fees, { from, amount, kind }
    this.wall = [];
    this.turn = 0;
    this.over = false;
  }

  // A read-only snapshot for a given seat (hides other hands).
  view(seat) {
    return {
      seat,
      handNo: this.handNo,
      totalHands: this.totalHands,
      dealer: this.dealer,
      wallCount: this.wall.length,
      points: this.points.slice(),
      startPoints: this.startPoints,
      me: this.players[seat],
      pot: this.potTotal(),
      canFold: this.canFold(seat),
      canRiichi: this.points[seat] >= RIICHI_MIN,
      players: this.players.map(p => ({
        seat: p.seat, name: p.name, discards: p.discards.slice(), riichi: p.riichi, folded: p.folded, handCount: p.hand.length,
      })),
    };
  }

  potTotal() { return this.pot.reduce((a, x) => a + x.amount, 0); }

  // You may fold once someone else has declared riichi, unless you declared yourself.
  canFold(seat) {
    const p = this.players[seat];
    return !p.riichi && !p.folded && this.points[seat] > 0 && this.players.some(o => o.seat !== seat && o.riichi && !o.folded);
  }

  // Put points on the table (taken off your score now, paid to the winner, or back on a draw).
  bet(seat, kind) {
    const amount = Math.min(BET, this.points[seat]);
    this.points[seat] -= amount;
    this.pot.push({ from: seat, amount, kind });
    return amount;
  }

  async play() {
    this.emit('gameStart', {});
    while (this.handNo < this.totalHands && !this.over) {
      const record = await this.playHand();
      if (this.afterHand) await this.afterHand(record);
      this.handNo += 1;
      this.dealer = (this.dealer + 1) % 4;
      if (this.points.some(p => p <= 0)) this.over = true;
    }
    this.over = true;
    this.emit('gameEnd', { points: this.points.slice(), history: this.history });
    return this.points;
  }

  async playHand() {
    const deck = shuffle(makeDeck(), this.rand);
    for (const p of this.players) {
      p.hand = deck.splice(0, HAND_SIZE);
      p.discards = [];
      p.riichi = false;
      p.riichiAt = -1;
      p.folded = false;
    }
    this.pot = [];
    this.wall = deck;
    this.turn = this.dealer;
    this.emit('handStart', { handNo: this.handNo, dealer: this.dealer });

    while (this.wall.length > 0) {
      const seat = this.turn;
      const p = this.players[seat];
      const ctrl = this.seats[seat].controller;
      if (p.folded) { this.turn = (seat + 1) % 4; continue; }
      const drawn = this.wall.pop();
      p.hand.push(drawn);
      this.emit('draw', { seat, card: drawn });

      // Tsumo?
      const ev = evaluate(p.hand);
      if (ev && await ctrl.chooseTsumo(this.view(seat), ev)) {
        return this.settle({ winner: seat, loser: null, ev, tile: drawn });
      }

      // Discard (riichi players must throw what they drew).
      let index;
      let declare = false;
      if (p.riichi) {
        if (ctrl.beforeAutoDiscard) await ctrl.beforeAutoDiscard(this.view(seat));
        index = p.hand.length - 1;
      } else {
        const choice = await ctrl.chooseDiscard(this.view(seat));
        if (choice.fold && this.canFold(seat)) {
          // Fold: pay the fee, put the drawn card aside face down, sit out the rest of the hand.
          p.folded = true;
          p.hand.pop();
          const amount = this.bet(seat, 'fold');
          this.emit('fold', { seat, amount, pot: this.potTotal() });
          const live = this.players.filter(o => !o.folded);
          if (live.length === 1) return this.settle({ winner: live[0].seat, loser: null, ev: null, tile: null, foldWin: true });
          this.turn = (seat + 1) % 4;
          continue;
        }
        index = choice.index;
        const rest = p.hand.filter((_, i) => i !== index);
        declare = !!choice.riichi && isTenpai(rest) && this.points[seat] >= RIICHI_MIN;
      }
      const [tile] = p.hand.splice(index, 1);
      p.discards.push(tile);
      if (declare) { p.riichi = true; p.riichiAt = p.discards.length - 1; this.bet(seat, 'riichi'); }
      this.emit('discard', { seat, card: tile, riichi: declare, pot: this.potTotal() });

      // Ron, in seat order after the discarder.
      for (const other of ronOrder(seat)) {
        const op = this.players[other];
        if (op.folded) continue;
        const rev = canRon(op, tile);
        if (rev && await this.seats[other].controller.chooseRon(this.view(other), tile, rev, seat)) {
          op.hand.push(tile);
          p.discards.pop();
          return this.settle({ winner: other, loser: seat, ev: rev, tile });
        }
      }
      this.turn = (seat + 1) % 4;
    }

    // A draw: everyone gets back what they put on the table.
    const refunds = this.pot.map(x => ({ from: null, to: x.from, amount: x.amount, kind: x.kind }));
    for (const x of this.pot) this.points[x.from] += x.amount;
    this.pot = [];
    const record = { handNo: this.handNo, type: 'exhausted', transfers: [], refunds, points: this.points.slice() };
    this.history.push(record);
    this.emit('exhausted', record);
    return record;
  }

  settle({ winner, loser, ev, tile, foldWin = false }) {
    // Folded players still pay a tsumo; they only escape a ron.
    const transfers = ev ? payments({ winner, loser, points: ev.points, playerPoints: this.points }) : [];
    this.points = applyPayments(this.points, transfers);
    // The winner also takes everything on the table (riichi bets and fold fees).
    const potWon = this.potTotal();
    const potFrom = this.pot.map(x => ({ from: x.from, amount: x.amount, kind: x.kind }));
    this.points[winner] += potWon;
    this.pot = [];
    const record = {
      handNo: this.handNo,
      type: foldWin ? 'foldWin' : loser == null ? 'tsumo' : 'ron',
      winner, loser, ev, tile,
      hand: foldWin ? [] : this.players[winner].hand.slice(), // nobody sees a hand that was never shown
      transfers,
      potWon, potFrom,
      points: this.points.slice(),
    };
    this.history.push(record);
    this.emit(foldWin ? 'foldWin' : 'win', record);
    return record;
  }
}

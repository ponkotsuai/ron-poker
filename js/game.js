// Game flow: a table of 4 seats playing HANDS_PER_GAME hands.
// Seats are driven by controllers (human UI or AI) through three async decisions.

import {
  makeDeck, shuffle, rng, evaluate, canRon, isTenpai, payments, applyPayments, ronOrder,
  START_POINTS, HANDS_PER_GAME, HAND_SIZE,
} from './engine.js';

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
    this.players = seats.map((s, i) => ({ seat: i, name: s.name, hand: [], discards: [], riichi: false, riichiAt: -1 }));
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
      players: this.players.map(p => ({
        seat: p.seat, name: p.name, discards: p.discards.slice(), riichi: p.riichi, handCount: p.hand.length,
      })),
    };
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
    }
    this.wall = deck;
    this.turn = this.dealer;
    this.emit('handStart', { handNo: this.handNo, dealer: this.dealer });

    while (this.wall.length > 0) {
      const seat = this.turn;
      const p = this.players[seat];
      const ctrl = this.seats[seat].controller;
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
        index = choice.index;
        const rest = p.hand.filter((_, i) => i !== index);
        declare = !!choice.riichi && isTenpai(rest);
      }
      const [tile] = p.hand.splice(index, 1);
      p.discards.push(tile);
      if (declare) { p.riichi = true; p.riichiAt = p.discards.length - 1; }
      this.emit('discard', { seat, card: tile, riichi: declare });

      // Ron, in seat order after the discarder.
      for (const other of ronOrder(seat)) {
        const op = this.players[other];
        const rev = canRon(op, tile);
        if (rev && await this.seats[other].controller.chooseRon(this.view(other), tile, rev, seat)) {
          op.hand.push(tile);
          p.discards.pop();
          return this.settle({ winner: other, loser: seat, ev: rev, tile });
        }
      }
      this.turn = (seat + 1) % 4;
    }

    const record = { handNo: this.handNo, type: 'exhausted', transfers: [], points: this.points.slice() };
    this.history.push(record);
    this.emit('exhausted', record);
    return record;
  }

  settle({ winner, loser, ev, tile }) {
    const transfers = payments({ winner, loser, points: ev.points, playerPoints: this.points });
    this.points = applyPayments(this.points, transfers);
    const record = {
      handNo: this.handNo,
      type: loser == null ? 'tsumo' : 'ron',
      winner, loser, ev, tile,
      hand: this.players[winner].hand.slice(),
      transfers,
      points: this.points.slice(),
    };
    this.history.push(record);
    this.emit('win', record);
    return record;
  }
}

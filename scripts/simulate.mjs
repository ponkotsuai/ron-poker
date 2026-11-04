// Headless: run full games with 4 AIs to check balance and speed.
import { Game } from '../js/game.js';
import { AIController, PERSONALITIES } from '../js/ai.js';

const games = Number(process.argv[2] || 50);
const ids = ['tanuki', 'tsuru', 'kitsune', 'kitsune'];
const totals = [0, 0, 0, 0];
const kinds = {};
const thoughts = {};
let hands = 0;
let exhausted = 0;
let jokerWins = 0;
let wins = 0;
let draws = 0;
const t0 = Date.now();
for (let g = 0; g < games; g++) {
  const seats = ids.map((id, i) => ({
    name: `${id}${i}`,
    controller: new AIController({ personality: PERSONALITIES[id], think: k => { thoughts[k] = (thoughts[k] || 0) + 1; } }),
  }));
  const game = new Game({
    seats, seed: g + 1,
    onEvent: (type, e) => {
      if (type === 'draw') draws++;
      if (type === 'win') { kinds[e.ev.key] = (kinds[e.ev.key] || 0) + 1; wins++; if (e.ev.jokers) jokerWins++; }
      if (type === 'exhausted') exhausted++;
      if (type === 'handStart') hands++;
    },
  });
  const pts = await game.play();
  pts.forEach((p, i) => { totals[i] += p; });
}
const ms = Date.now() - t0;
console.log(`${games} games, ${hands} hands, ${(ms / hands).toFixed(1)} ms/hand`);
console.log('avg final points by seat', ids.map((id, i) => `${id}:${(totals[i] / games).toFixed(1)}`).join(' '));
console.log('avg rounds per hand', (draws / hands / 4).toFixed(2), 'exhausted', exhausted, 'joker wins', `${(jokerWins / wins * 100).toFixed(1)}%`);
console.log('hands won', Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, `${(v / wins * 100).toFixed(1)}%`])));
console.log('thoughts', thoughts);

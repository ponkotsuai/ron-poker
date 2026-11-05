// Random match with one human: after the wait, AIs fill the table, the game is played,
// and the result settles on chain with no player signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startReferee, bot } from './helpers.mjs';

test('random match: one human plus three AIs, settled by the referee', { timeout: 240_000 }, async () => {
  const offline = await startReferee(18787, 'test-secret');
  const alice = bot(18787, offline, 'alice.testnet', { plan: (send, m) => { if (m.t === 'hello') send({ t: 'quick' }); } });
  const me = await alice.done;
  assert.equal(me.end.t, 'settled');
  assert.equal(me.end.points.reduce((a, b) => a + b, 0), 120);
  const t = offline.chain.tables[me.end.tableId];
  assert.equal(t.status, 'Settled');
  assert.equal(t.players.filter(p => p.startsWith('alice')).length, 1);
  assert.equal(offline.chain.bankrolls.get('alice.testnet'), BigInt(me.end.points[0]) * offline.NEAR / 10n);
  assert.ok(me.msgs.some(m => m.t === 'lobby' && m.mode === 'queue'));
  process.exit(0);
});

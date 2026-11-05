// A player who disconnects mid-game cannot stall the payout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startReferee, bot, waitFor } from './helpers.mjs';

test('table settles even if the human walks away', { timeout: 240_000 }, async () => {
  const offline = await startReferee(18788, 'test-secret-2');
  const bob = bot(18788, offline, 'bob.testnet', { leaveAtFirstPrompt: true, plan: (send, m) => { if (m.t === 'hello') send({ t: 'quick' }); } });
  const me = await bob.done;
  await waitFor(() => offline.chain.tables[me.tableId]?.status === 'Settled');
  assert.equal(offline.chain.tables[me.tableId].final_points.reduce((a, b) => a + b, 0), 120);
  process.exit(0);
});

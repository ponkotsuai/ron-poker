// End-to-end: a scripted human plays a full game against the referee on an in-memory chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { KeyPair } from 'near-api-js';

process.env.OFFLINE = '1';
process.env.PORT = '18787';
process.env.MASTER_SECRET = 'test-secret';
process.env.CONTRACT_ID = 'ronpoker-test.testnet';
process.env.FAST = '1';

test('a full game settles on chain with no player signatures', { timeout: 240_000 }, async () => {
  const offline = await import('../server/near-offline.mjs');
  const { deriveKey } = offline;
  offline.chain.setReferee(`ronref-${deriveKey('test-secret', 'referee').tag}.testnet`);
  await import('../server/index.mjs');
  await new Promise(r => setTimeout(r, 300));

  const human = 'alice.testnet';
  const session = KeyPair.fromRandom('ed25519');
  const ws = new WebSocket('ws://localhost:18787/ws');
  const seen = { prompts: 0, hands: 0, steps: [] };
  const result = await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', account: human })));
    let hand = [];
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'error') reject(new Error(m.message));
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'open' }));
      if (m.t === 'step') seen.steps.push(m.key);
      if (m.t === 'opened') {
        // what Meteor Wallet would do: pay the buy-in with the session key
        offline.joinTable(human, m.tableId, session.getPublicKey().toString(), 3n * offline.NEAR);
        const signature = Buffer.from(session.sign(new TextEncoder().encode(`ronpoker:${m.tableId}:${human}`)).signature).toString('base64');
        ws.send(JSON.stringify({ t: 'paid', publicKey: session.getPublicKey().toString(), signature }));
      }
      if (m.t === 'state') hand = m.game.players[0].hand;
      if (m.t === 'prompt') {
        seen.prompts++;
        if (m.kind === 'discard') ws.send(JSON.stringify({ t: 'decide', kind: 'discard', value: { index: hand.length - 1, riichi: true } }));
        else if (m.kind === 'next') { seen.hands++; ws.send(JSON.stringify({ t: 'decide', kind: 'next', value: true })); }
        else ws.send(JSON.stringify({ t: 'decide', kind: m.kind, value: true }));
      }
      if (m.t === 'settled') resolve(m);
    });
  });
  ws.close();
  assert.equal(result.points.reduce((a, b) => a + b, 0), 120);
  assert.equal(offline.chain.tables[result.tableId].status, 'Settled');
  assert.ok(seen.prompts > 5, 'human was asked to play');
  assert.ok(seen.hands >= 1);
  assert.ok(seen.steps.includes('chainGameOn'));
  // the human's payout landed in their bankroll without them signing anything
  assert.equal(offline.chain.bankrolls.get(human), BigInt(result.points[0]) * offline.NEAR / 10n);
  process.exit(0);
});

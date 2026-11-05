// A player who disconnects mid-game cannot stall the payout: the referee plays their seat
// with safe defaults and settles the table anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { KeyPair } from 'near-api-js';

process.env.OFFLINE = '1';
process.env.PORT = '18788';
process.env.MASTER_SECRET = 'test-secret-2';
process.env.CONTRACT_ID = 'ronpoker-test.testnet';
process.env.FAST = '1';

test('table settles even if the human walks away', { timeout: 240_000 }, async () => {
  const offline = await import('../server/near-offline.mjs');
  offline.chain.setReferee(`ronref-${offline.deriveKey('test-secret-2', 'referee').tag}.testnet`);
  await import('../server/index.mjs');
  await new Promise(r => setTimeout(r, 300));
  const human = 'bob.testnet';
  const session = KeyPair.fromRandom('ed25519');
  const ws = new WebSocket('ws://localhost:18788/ws');
  const tableId = await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', account: human })));
    let id = null;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'error') reject(new Error(m.message));
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'open' }));
      if (m.t === 'opened') {
        id = m.tableId;
        offline.joinTable(human, id, session.getPublicKey().toString(), 3n * offline.NEAR);
        const signature = Buffer.from(session.sign(new TextEncoder().encode(`ronpoker:${id}:${human}`)).signature).toString('base64');
        ws.send(JSON.stringify({ t: 'paid', publicKey: session.getPublicKey().toString(), signature }));
      }
      if (m.t === 'prompt') { ws.close(); resolve(id); } // leave at the first decision
    });
  });
  for (let i = 0; i < 400 && offline.chain.tables[tableId].status !== 'Settled'; i++) await new Promise(r => setTimeout(r, 250));
  const t = offline.chain.tables[tableId];
  assert.equal(t.status, 'Settled');
  assert.equal(t.final_points.reduce((a, b) => a + b, 0), 120);
  process.exit(0);
});

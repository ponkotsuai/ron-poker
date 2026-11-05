// Two friends in a room: the host starts, both pay, two AIs fill in, and the table settles.
// A third table where one human never pays is cancelled and refunded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startReferee, bot } from './helpers.mjs';

process.env.PAY_MS = '3000';

test('room with two humans plays to settlement; unpaid table is refunded', { timeout: 240_000 }, async () => {
  const offline = await startReferee(18789, 'test-secret-3');
  let code = null;
  const host = bot(18789, offline, 'carol.testnet', {
    nickname: 'キャロル',
    plan: (send, m) => {
      if (m.t === 'hello') send({ t: 'createRoom' });
      if (m.t === 'lobby' && m.mode === 'room') { code = m.code; if (m.members.length === 2) send({ t: 'startRoom' }); }
    },
  });
  while (!code) await new Promise(r => setTimeout(r, 50));
  const guest = bot(18789, offline, 'dave.testnet', { plan: (send, m) => { if (m.t === 'hello') send({ t: 'joinRoom', code }); } });
  const [h, g] = await Promise.all([host.done, guest.done]);
  assert.equal(h.end.t, 'settled');
  assert.equal(h.end.tableId, g.end.tableId);
  const t = offline.chain.tables[h.end.tableId];
  assert.deepEqual(t.players.slice(0, 2), ['carol.testnet', 'dave.testnet']);
  assert.equal(t.status, 'Settled');
  assert.deepEqual([h.seat, g.seat], [0, 1]);
  // both humans saw the same final points
  assert.deepEqual(h.end.points, g.end.points);

  // a room where the guest never pays: refunded after PAY_MS
  let code2 = null;
  const host2 = bot(18789, offline, 'erin.testnet', {
    tolerateErrors: true,
    plan: (send, m) => {
      if (m.t === 'hello') send({ t: 'createRoom' });
      if (m.t === 'lobby' && m.mode === 'room') { code2 = m.code; if (m.members.length === 2) send({ t: 'startRoom' }); }
    },
  });
  while (!code2) await new Promise(r => setTimeout(r, 50));
  const lazy = bot(18789, offline, 'frank.testnet', { neverPay: true, tolerateErrors: true, plan: (send, m) => { if (m.t === 'hello') send({ t: 'joinRoom', code: code2 }); } });
  const [e] = await Promise.all([host2.done, lazy.done]);
  assert.equal(e.end.t, 'aborted');
  assert.equal(offline.chain.tables[e.end.tableId].status, 'Aborted');
  assert.equal(offline.chain.bankrolls.get('erin.testnet'), 3n * offline.NEAR); // refunded into bankroll
  process.exit(0);
});

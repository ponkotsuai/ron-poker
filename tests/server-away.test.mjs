// Phones drop the connection when the browser goes to the background. A player who comes back
// keeps their room (and host role) and their unpaid seat, and the table still settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startReferee, bot, waitFor } from './helpers.mjs';

process.env.PAY_MS = '20000';
const PORT = 18791;

function raw(account, onMsg) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.on('open', () => send({ t: 'hello', account, nickname: account.split('.')[0] }));
  ws.on('message', d => onMsg(JSON.parse(d), send, ws));
  return ws;
}

test('room host and an unpaid guest survive going to the background', { timeout: 240_000 }, async () => {
  const offline = await startReferee(PORT, 'test-secret-away');

  // 1. The host creates a room, then the phone goes to the background (connection closes).
  let code = null;
  const hostWs = raw('gina.testnet', (m, send) => {
    if (m.t === 'hello') send({ t: 'createRoom' });
    if (m.t === 'lobby' && m.mode === 'room') code = m.code;
  });
  await waitFor(() => code, 10_000);
  hostWs.close();
  await new Promise(r => setTimeout(r, 300));

  // 2. A friend joins with the code while the host is away. The friend's phone also goes to the
  //    background right after the table opens, before paying.
  let guestSawAway = false;
  let guestOpened = false;
  const guestWs = raw('hank.testnet', (m, send, ws) => {
    if (m.t === 'hello') send({ t: 'joinRoom', code });
    if (m.t === 'lobby' && m.mode === 'room' && m.away?.[0]) guestSawAway = true;
    if (m.t === 'opened') { guestOpened = true; ws.close(); }
  });
  await waitFor(() => guestSawAway, 10_000);

  // 3. The host comes back: still in the room, still the host, and starts the table.
  let restored = null;
  const host = bot(PORT, offline, 'gina.testnet', {
    plan: (send, m) => {
      if (m.t === 'hello') restored = m.restored;
      if (m.t === 'lobby' && m.mode === 'room' && m.host && m.members.length === 2 && !m.away.some(Boolean)) send({ t: 'startRoom' });
    },
  });
  await waitFor(() => restored, 10_000);
  assert.equal(restored, 'room');
  await waitFor(() => guestOpened, 30_000);
  assert.equal(guestWs.readyState > 1 || guestWs.readyState === 2, true);

  // 4. The friend comes back, gets the table again, pays, and the game settles for both.
  let guestRestored = null;
  const guest = bot(PORT, offline, 'hank.testnet', { plan: (send, m) => { if (m.t === 'hello') guestRestored = m.restored; } });
  const [h, g] = await Promise.all([host.done, guest.done]);
  assert.equal(guestRestored, 'table');
  assert.equal(h.end.t, 'settled');
  assert.equal(g.end.t, 'settled');
  assert.equal(h.end.tableId, g.end.tableId);
  assert.deepEqual(offline.chain.tables[h.end.tableId].players.slice(0, 2), ['gina.testnet', 'hank.testnet']);
  process.exit(0);
});

// Table talk: a text and a stamp from one human reach everyone at the table, cleaned and rate-limited.
// (The gap between messages is shortened for the test.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startReferee, bot, waitFor } from './helpers.mjs';

const PORT = 18792;
process.env.CHAT_GAP_MS = '150';

test('chat reaches the table', { timeout: 240_000 }, async () => {
  const offline = await startReferee(PORT, 'test-secret-chat');
  let code = null;
  let said = false;
  const host = bot(PORT, offline, 'ivan.testnet', {
    plan: (send, m) => {
      if (m.t === 'hello') send({ t: 'createRoom' });
      if (m.t === 'lobby' && m.mode === 'room') { code = m.code; if (m.members.length === 2) send({ t: 'startRoom' }); }
      if (m.t === 'state' && !said) {
        said = true;
        send({ t: 'chat', text: 'よろしく<b>\u0007' + 'x'.repeat(60) });
        send({ t: 'chat', stamp: 'gg' }); // too soon: dropped
        setTimeout(() => send({ t: 'chat', stamp: 'gg' }), 200);
        setTimeout(() => send({ t: 'chat', stamp: 'nope' }), 400);
      }
    },
  });
  await waitFor(() => code, 10_000);
  const guest = bot(PORT, offline, 'judy.testnet', { plan: (send, m) => { if (m.t === 'hello') send({ t: 'joinRoom', code }); } });
  await waitFor(() => guest.msgs.filter(m => m.t === 'chat').length >= 2, 30_000).catch(e => { console.log('GUEST', guest.msgs.map(m => m.t).slice(0, 40).join(','), 'HOST', host.msgs.filter(m => m.t === 'error').map(m => m.message)); throw e; });
  await new Promise(r => setTimeout(r, 600));
  const chats = guest.msgs.filter(m => m.t === 'chat');
  assert.equal(chats.length, 2); // the early repeat and the unknown stamp are dropped
  assert.equal(chats[0].seat, 0);
  assert.equal(chats[0].text, 'よろしく<b>' + 'x'.repeat(33)); // control chars dropped, 40 characters max
  assert.equal(chats[1].stamp, 'gg');
  await Promise.all([host.done, guest.done]);
  process.exit(0);
});

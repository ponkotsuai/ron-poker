// Scripted players for referee tests on the in-memory chain.
import WebSocket from 'ws';
import { KeyPair } from 'near-api-js';

export async function startReferee(port, secret) {
  process.env.OFFLINE = '1';
  process.env.PORT = String(port);
  process.env.MASTER_SECRET = secret;
  process.env.CONTRACT_ID = 'ronpoker-test.testnet';
  process.env.FAST = '1';
  process.env.QUEUE_MS ||= '1500';
  const offline = await import('../server/near-offline.mjs');
  offline.chain.setReferee(`ronref-${offline.deriveKey(secret, 'referee').tag}.testnet`);
  await import('../server/index.mjs');
  await new Promise(r => setTimeout(r, 300));
  return offline;
}

/**
 * A bot human. `plan(send, m, me)` may react to lobby messages; game prompts are answered
 * automatically unless `leaveAtFirstPrompt` or `neverPay` is set.
 */
export function bot(port, offline, account, opts = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const session = KeyPair.fromRandom('ed25519');
  const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const me = { account, ws, send, msgs: [], hand: [], seat: null };
  me.done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => send({ t: 'hello', account, nickname: opts.nickname || account.split('.')[0] }));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      me.msgs.push(m);
      if (m.t === 'error' && !opts.tolerateErrors) reject(new Error(`${account}: ${m.message}`));
      if (opts.plan) opts.plan(send, m, me);
      if (m.t === 'opened') {
        me.seat = m.seat;
        me.tableId = m.tableId;
        if (opts.neverPay) return;
        offline.joinTable(account, m.tableId, session.getPublicKey().toString(), 3n * offline.NEAR);
        const signature = Buffer.from(session.sign(new TextEncoder().encode(`ronpoker:${m.tableId}:${account}`)).signature).toString('base64');
        send({ t: 'paid', publicKey: session.getPublicKey().toString(), signature });
      }
      if (m.t === 'state') me.hand = m.game.players[m.game.you].hand;
      if (m.t === 'prompt') {
        if (opts.leaveAtFirstPrompt) { ws.close(); resolve(me); return; }
        if (m.kind === 'discard') send({ t: 'decide', kind: 'discard', value: { index: me.hand.length - 1, riichi: true } });
        else send({ t: 'decide', kind: m.kind, value: true });
      }
      if (m.t === 'settled' || m.t === 'aborted') { me.end = m; ws.close(); resolve(me); }
    });
  });
  return me;
}

export async function waitFor(fn, ms = 120_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 100));
  }
}

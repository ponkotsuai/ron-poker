// In-memory stand-in for near.mjs, used by OFFLINE=1 tests. Mimics the table contract's rules.
import * as real from './near.mjs';

export const { NEAR, deriveKey, verifySignature, sha256Hex } = real;
const accounts = new Set();
const bankrolls = new Map();
const tables = [];
let referee = null;
export const chain = { tables, bankrolls, setReferee: r => { referee = r; } };

export async function ensureAccount(id) { accounts.add(id); return true; }
export async function hasKey() { return true; }
export async function addPlayKey() { return {}; }
export async function balanceOf() { return 10n * NEAR; }
export function signerAccount(accountId) { return { accountId }; }

export async function view(contract, method, args = {}) {
  if (method === 'get_config') return ['3000000000000000000000000', 30, 3600e9, tables.length, referee, 'owner.testnet'];
  if (method === 'bankroll_of') return String(bankrolls.get(args.account_id) || 0n);
  if (method === 'get_table') return tables[args.table_id] ? structuredClone(tables[args.table_id]) : null;
  throw new Error(`view ${method}`);
}

export async function call(account, contract, method, args, deposit = 0n) {
  const who = account.accountId;
  const hash = `tx${Math.random().toString(36).slice(2, 8)}`;
  if (method === 'deposit') { bankrolls.set(who, (bankrolls.get(who) || 0n) + deposit); return { hash, value: null }; }
  if (method === 'create_table') {
    if (who !== referee) throw new Error('only the referee');
    tables.push({ id: tables.length, players: args.players, joined: [false, false, false, false], session_keys: [null, null, null, null], seed_hash: args.seed_hash, status: 'Waiting' });
    return { hash, value: tables.length - 1 };
  }
  if (method === 'join') return { hash, value: joinTable(who, args.table_id, args.session_key, deposit) };
  if (method === 'settle') {
    const t = tables[args.table_id];
    if (who !== referee || t.status !== 'Playing') throw new Error('cannot settle');
    if (args.points.reduce((a, b) => a + b, 0) !== 120) throw new Error('points must add up');
    if (sha256Hex(args.seed) !== t.seed_hash) throw new Error('seed mismatch');
    const payouts = args.points.map(p => BigInt(p) * NEAR / 10n);
    t.players.forEach((p, i) => bankrolls.set(p, (bankrolls.get(p) || 0n) + payouts[i]));
    t.status = 'Settled';
    t.final_points = args.points;
    return { hash, value: payouts.map(String) };
  }
  if (method === 'abort') {
    const t = tables[args.table_id];
    t.players.forEach((p, i) => { if (t.joined[i]) bankrolls.set(p, (bankrolls.get(p) || 0n) + 3n * NEAR); });
    t.status = 'Aborted';
    return { hash, value: 'Aborted' };
  }
  throw new Error(`call ${method}`);
}

export function joinTable(who, id, sessionKey, deposit = 0n) {
  const t = tables[id];
  const seat = t.players.indexOf(who);
  if (seat < 0 || t.joined[seat] || t.status !== 'Waiting') throw new Error('cannot join');
  const bank = (bankrolls.get(who) || 0n) + deposit;
  if (bank < 3n * NEAR) throw new Error('bankroll too small');
  bankrolls.set(who, bank - 3n * NEAR);
  t.joined[seat] = true;
  if (sessionKey) t.session_keys[seat] = sessionKey;
  if (t.joined.every(Boolean)) t.status = 'Playing';
  return t.status;
}

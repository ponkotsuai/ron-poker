// On-chain table flow on NEAR testnet.
//  - The human connects Meteor Wallet and signs: join (3 NEAR buy-in), submit_result, withdraw.
//  - Each AI signs its own calls with its own function-call key: create_table, join, submit_result.
// Nobody holds the pot: the contract pays out only when all four scoresheets match.

import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { actionCreators } from '@near-js/transactions';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { NETWORK, RPC_URL, EXPLORER, CONTRACT_ID, BUY_IN_YOCTO, AI_ACCOUNTS } from './config.js';

const GAS = 30_000_000_000_000n;
const provider = new JsonRpcProvider({ url: RPC_URL });
let selector = null;

export const explorerTx = hash => `${EXPLORER}/txns/${hash}`;
export const explorerAccount = id => `${EXPLORER}/address/${id}`;

export function aiReady() {
  return Object.values(AI_ACCOUNTS).every(a => a.key);
}

export async function view(method, args = {}) {
  return provider.callFunction({ contractId: CONTRACT_ID, method, args, finality: 'optimistic' });
}

export async function bankrollOf(accountId) {
  const v = await view('bankroll_of', { account_id: accountId });
  return BigInt(v);
}

export function yoctoToNear(y, digits = 2) {
  const n = Number(BigInt(y) / 10n ** 20n) / 10000;
  return n.toFixed(digits);
}

// ---- human wallet ------------------------------------------------------

async function getSelector() {
  if (!selector) {
    selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet()] });
  }
  return selector;
}

export async function currentAccount() {
  const s = await getSelector();
  const acc = s.store.getState().accounts.find(a => a.active) || s.store.getState().accounts[0];
  return acc ? acc.accountId : null;
}

export async function connectWallet() {
  const s = await getSelector();
  const wallet = await s.wallet('meteor-wallet');
  const accounts = await wallet.signIn({ contractId: CONTRACT_ID, methodNames: ['submit_result', 'abort'] });
  return accounts[0]?.accountId || currentAccount();
}

export async function disconnectWallet() {
  const s = await getSelector();
  const wallet = await s.wallet();
  await wallet.signOut();
}

async function humanCall(method, args, deposit = 0n) {
  const s = await getSelector();
  const wallet = await s.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [actionCreators.functionCall(method, args, GAS, deposit)],
  });
  return outcome;
}

// ---- AI agents ---------------------------------------------------------

function aiAccount(id) {
  const a = AI_ACCOUNTS[id];
  return new Account(a.accountId, provider, KeyPairSigner.fromSecretKey(a.key));
}

async function aiCall(id, method, args) {
  const account = aiAccount(id);
  const outcome = await account.callFunctionRaw({ contractId: CONTRACT_ID, methodName: method, args, gas: GAS });
  return { outcome, hash: outcome.transaction.hash, value: decodeReturn(outcome) };
}

function decodeReturn(outcome) {
  const b64 = outcome?.status?.SuccessValue;
  if (!b64) return null;
  try { return JSON.parse(atob(b64)); } catch { return null; }
}

// ---- table flow --------------------------------------------------------

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The deal is fixed by a seed committed on chain before any card is dealt.
export async function newSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const seed = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await sha256Hex(seed);
  return { seed, hash, number: parseInt(hash.slice(0, 8), 16) };
}

/**
 * Open a table, have the AIs pay in from their bankrolls, then ask the human to pay.
 * `onStep(key, data)` reports progress for the table log.
 */
export async function openTable({ human, seats, seedHash, onStep }) {
  // seats: ['human', 'tanuki', 'tsuru', 'kitsune'] in seat order
  const players = seats.map(s => (s === 'human' ? human : AI_ACCOUNTS[s].accountId));
  const opener = seats.find(s => s !== 'human');
  const created = await aiCall(opener, 'create_table', { players, seed_hash: seedHash });
  const tableId = created.value;
  onStep('chainTableOpened', { id: tableId, by: opener, hash: created.hash });
  for (const s of seats) {
    if (s === 'human') continue;
    const joined = await aiCall(s, 'join', { table_id: tableId });
    onStep('chainAiJoined', { who: s, hash: joined.hash });
  }
  onStep('chainHumanPay', {});
  const outcome = await humanCall('join', { table_id: tableId }, BUY_IN_YOCTO);
  const table = await view('get_table', { table_id: tableId });
  if (table.status !== 'Playing') throw new Error(`table ${tableId} is ${table.status}`);
  onStep('chainGameOn', { id: tableId, hash: outcome?.transaction?.hash });
  return { tableId, players };
}

/** Every player submits the same final points and reveals the seed. */
export async function settleTable({ tableId, seats, points, seed, onStep }) {
  for (const s of seats) {
    if (s === 'human') continue;
    const r = await aiCall(s, 'submit_result', { table_id: tableId, points, seed });
    onStep('chainAiSigned', { who: s, hash: r.hash });
  }
  onStep('chainHumanSign', {});
  const outcome = await humanCall('submit_result', { table_id: tableId, points, seed });
  const table = await view('get_table', { table_id: tableId });
  onStep('chainSettled', { id: tableId, status: table.status, hash: outcome?.transaction?.hash });
  return table;
}

export async function withdrawAll() {
  return humanCall('withdraw', {}, 1n);
}

export async function abortTable(tableId) {
  return humanCall('abort', { table_id: tableId });
}

export { CONTRACT_ID, AI_ACCOUNTS };

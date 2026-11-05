// On-chain table flow on NEAR testnet.
//  - The human connects Meteor Wallet and signs: join (3 NEAR buy-in), submit_result, withdraw.
//  - Each AI has its own testnet account and plays with a function-call key that can only
//    create/join tables and sign scoresheets on the table contract. It cannot move or withdraw NEAR.
//  - The AI accounts are created in this browser on first play (you are their sponsor).
//    Their keys are kept in this browser's storage and never sent anywhere.
// Nobody holds the pot: the contract pays out only when all four scoresheets match.

import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { actionCreators } from '@near-js/transactions';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import {
  NETWORK, RPC_URLS, EXPLORER, CONTRACT_ID, BUY_IN_YOCTO, FAUCET_URL, AI_BANKROLL_YOCTO, AI_METHODS, AI_GAS_ALLOWANCE_YOCTO,
} from './config.js';

const GAS = 30_000_000_000_000n;
// Several public testnet RPC endpoints; if one is rate-limited or down, the next one is used.
const provider = new FailoverRpcProvider(RPC_URLS.map(url => new JsonRpcProvider({ url }, { retries: 2, backoff: 1.5, wait: 300 })));
let selector = null;

export const explorerTx = hash => `${EXPLORER}/txns/${hash}`;
export const explorerAccount = id => `${EXPLORER}/address/${id}`;

const AGENTS_KEY = 'ronpoker.agents.v1';
const AI_IDS = ['tanuki', 'tsuru', 'kitsune'];
// { tanuki: { accountId, sponsorKey, playKey }, ... } — sponsorKey is full access (funding only),
// playKey is the restricted key the AI plays with.
export const AI_ACCOUNTS = {};

function loadAgents() {
  try {
    const saved = JSON.parse(localStorage.getItem(AGENTS_KEY) || '{}');
    for (const id of AI_IDS) if (saved[id]) AI_ACCOUNTS[id] = saved[id];
  } catch { /* storage unavailable: agents are created fresh */ }
}
function saveAgents() {
  try { localStorage.setItem(AGENTS_KEY, JSON.stringify(AI_ACCOUNTS)); } catch { /* ignore */ }
}
loadAgents();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function accountExists(accountId) {
  try { await provider.viewAccount({ accountId, finality: 'final' }); return true; } catch { return false; }
}

/**
 * Make sure each AI has a funded testnet account, a restricted playing key, and at least one buy-in
 * in its bankroll. Creates missing agents through the testnet faucet.
 */
export async function setupAgents(onStep) {
  for (const id of AI_IDS) {
    let agent = AI_ACCOUNTS[id];
    if (!agent || !(await accountExists(agent.accountId))) {
      const sponsor = KeyPair.fromRandom('ed25519');
      const accountId = `${id}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}.testnet`;
      const r = await fetch(FAUCET_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: sponsor.getPublicKey().toString() }),
      });
      if (!r.ok) throw new Error(`testnet faucet refused ${accountId} (${r.status})`);
      agent = { accountId, sponsorKey: sponsor.toString(), playKey: null };
      AI_ACCOUNTS[id] = agent;
      saveAgents();
      for (let i = 0; i < 10 && !(await accountExists(accountId)); i++) await sleep(1000);
      onStep('chainAgentCreated', { who: id, account: accountId });
    }
    const sponsorAccount = new Account(agent.accountId, provider, KeyPairSigner.fromSecretKey(agent.sponsorKey));
    if (!agent.playKey) {
      const play = KeyPair.fromRandom('ed25519');
      await sponsorAccount.addFunctionCallAccessKey({
        publicKey: play.getPublicKey(), contractId: CONTRACT_ID, methodNames: AI_METHODS, allowance: AI_GAS_ALLOWANCE_YOCTO,
      });
      agent.playKey = play.toString();
      saveAgents();
      onStep('chainAgentKey', { who: id });
    }
    if ((await bankrollOf(agent.accountId)) < BUY_IN_YOCTO) {
      const r = await sponsorAccount.callFunctionRaw({
        contractId: CONTRACT_ID, methodName: 'deposit', args: {}, deposit: AI_BANKROLL_YOCTO, gas: GAS,
      });
      onStep('chainAgentFunded', { who: id, hash: r.transaction.hash });
    }
  }
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

let selectorPromise = null;
let walletInstance = null;
function getSelector() {
  if (!selectorPromise) {
    selectorPromise = setupWalletSelector({
      network: { networkId: NETWORK, nodeUrl: RPC_URLS[0], helperUrl: '', explorerUrl: EXPLORER, indexerUrl: '' },
      modules: [setupMeteorWallet()],
    }).then(s => { selector = s; return s; });
  }
  return selectorPromise;
}
// Start loading the wallet library right away, so a later button press can open
// the wallet's approval window immediately (browsers only allow popups right after a click).
export function warmUp() {
  getSelector().then(async s => {
    if (s.store.getState().accounts.length) walletInstance = await s.wallet();
  }).catch(() => {});
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
  walletInstance = wallet;
  return accounts[0]?.accountId || currentAccount();
}

export async function disconnectWallet() {
  const s = await getSelector();
  const wallet = await s.wallet();
  await wallet.signOut();
}

// Call this directly from a click handler: Meteor opens a popup to approve the transaction.
async function humanCall(method, args, deposit = 0n) {
  const wallet = walletInstance || (walletInstance = await (await getSelector()).wallet());
  const outcome = await wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [actionCreators.functionCall(method, args, GAS, deposit)],
  });
  return outcome;
}

// ---- AI agents ---------------------------------------------------------

// The AI plays with its restricted key only.
function aiAccount(id) {
  const a = AI_ACCOUNTS[id];
  return new Account(a.accountId, provider, KeyPairSigner.fromSecretKey(a.playKey));
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
 * Step 1 (no wallet popup): an AI opens the table and commits the seed.
 * The AIs pay only after the human has paid, so nobody's buy-in waits on an absent player.
 */
export async function openTable({ human, seats, seedHash, onStep }) {
  // seats: ['human', 'tanuki', 'tsuru', 'kitsune'] in seat order
  const players = seats.map(s => (s === 'human' ? human : AI_ACCOUNTS[s].accountId));
  const opener = seats.find(s => s !== 'human');
  const created = await aiCall(opener, 'create_table', { players, seed_hash: seedHash });
  const tableId = created.value;
  onStep('chainTableOpened', { id: tableId, by: opener, hash: created.hash });
  return { tableId, players };
}

/** Step 2 (click → wallet popup): the human pays the buy-in. */
export async function humanJoin(tableId) {
  const outcome = await humanCall('join', { table_id: tableId }, BUY_IN_YOCTO);
  return outcome?.transaction?.hash || null;
}

/** Step 3: each AI pays from its own bankroll. Resolves when the table is in play. */
export async function aiJoinAll({ tableId, seats, onStep }) {
  let table = await view('get_table', { table_id: tableId });
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (s === 'human' || table.joined[i]) continue;
    const joined = await aiCall(s, 'join', { table_id: tableId });
    onStep('chainAiJoined', { who: s, hash: joined.hash });
  }
  table = await view('get_table', { table_id: tableId });
  if (table.status !== 'Playing') throw new Error(`table ${tableId} is ${table.status}`);
  onStep('chainGameOn', { id: tableId });
  return table;
}

export async function getTable(tableId) {
  return view('get_table', { table_id: tableId });
}

/** Final step (click): the human signs first, then each AI signs the same scoresheet. */
export async function settleTable({ tableId, seats, points, seed, onStep }) {
  const table0 = await view('get_table', { table_id: tableId });
  const humanSeat = seats.indexOf('human');
  let hash = null;
  if (!table0.submissions[humanSeat]) {
    const outcome = await humanCall('submit_result', { table_id: tableId, points, seed });
    hash = outcome?.transaction?.hash || null;
  }
  onStep('chainHumanSigned', { hash });
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (s === 'human' || table0.submissions[i]) continue;
    const r = await aiCall(s, 'submit_result', { table_id: tableId, points, seed });
    onStep('chainAiSigned', { who: s, hash: r.hash });
  }
  const table = await view('get_table', { table_id: tableId });
  if (table.status === 'Settled') onStep('chainSettled', { id: tableId });
  return table;
}

/**
 * Refund tables this browser's AIs left waiting (for example after a closed wallet window).
 * An AI may abort a waiting table at any time; the contract refunds every paid buy-in.
 */
export async function cleanupStaleTables(onStep, keep = null) {
  const [, , timeoutNs, next] = await view('get_config');
  const mine = new Map(Object.entries(AI_ACCOUNTS).map(([k, v]) => [v.accountId, k]));
  const now = BigInt(Date.now()) * 1_000_000n;
  for (let id = Math.max(0, next - 30); id < next; id++) {
    if (id === keep) continue;
    const t = await view('get_table', { table_id: id });
    if (!t) continue;
    const aiSeat = t.players.findIndex(p => mine.has(p));
    if (aiSeat < 0) continue;
    const expired = t.status === 'Playing' && now >= BigInt(t.started_at_ns) + BigInt(timeoutNs);
    if (t.status === 'Waiting' || expired) {
      try {
        const r = await aiCall(mine.get(t.players[aiSeat]), 'abort', { table_id: id });
        onStep('chainRefunded', { id, hash: r.hash });
      } catch { /* someone else closed it first */ }
    }
  }
}

export async function withdrawAll() {
  return humanCall('withdraw', {}, 1n);
}

export async function abortTable(tableId) {
  return humanCall('abort', { table_id: tableId });
}

export { CONTRACT_ID };

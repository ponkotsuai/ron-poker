// Browser side of the on-chain mode.
//  - Your wallet (Meteor) pays the buy-in and, later, cashes out your bankroll.
//  - Everything else happens on the referee service: it deals, runs the AI players
//    (each with its own testnet wallet), and reports the result to the table contract,
//    which pays out by points at once. You never have to sign the result.
//  - When you pay, you also register a one-off session key. Your browser signs with it
//    to prove to the referee that it plays your seat.

import { FailoverRpcProvider, JsonRpcProvider, KeyPair } from 'near-api-js';
import { actionCreators } from '@near-js/transactions';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { NETWORK, RPC_URLS, EXPLORER, CONTRACT_ID, BUY_IN_YOCTO, REFEREE_URL, TEST_MODE } from './config.js';

const GAS = 50_000_000_000_000n;
// Local tests only (see config.js): a stand-in wallet account.
const TEST_ACCOUNT = TEST_MODE ? (new URLSearchParams(location.search).get('testAccount') || 'tester.testnet') : null;
const provider = new FailoverRpcProvider(RPC_URLS.map(url => new JsonRpcProvider({ url }, { retries: 2, backoff: 1.5, wait: 300 })));

export const explorerTx = hash => `${EXPLORER}/txns/${hash}`;
export const explorerAccount = id => `${EXPLORER}/address/${id}`;
export { CONTRACT_ID, REFEREE_URL };

export async function view(method, args = {}) {
  return provider.callFunction({ contractId: CONTRACT_ID, method, args, finality: 'optimistic' });
}

export async function bankrollOf(accountId) {
  if (TEST_MODE) return BigInt(await (await fetch(`${REFEREE_URL}/test/bankroll?account=${accountId}`)).text());
  return BigInt(await view('bankroll_of', { account_id: accountId }));
}

export function yoctoToNear(y, digits = 2) {
  const n = Number(BigInt(y) / 10n ** 20n) / 10000;
  return n.toFixed(digits);
}

// ---- wallet --------------------------------------------------------------

let selectorPromise = null;
let walletInstance = null;
function getSelector() {
  if (!selectorPromise) {
    selectorPromise = setupWalletSelector({
      network: { networkId: NETWORK, nodeUrl: RPC_URLS[0], helperUrl: '', explorerUrl: EXPLORER, indexerUrl: '' },
      modules: [setupMeteorWallet()],
    });
  }
  return selectorPromise;
}

// Load the wallet library early, so a button press can open Meteor's approval window
// immediately (browsers only allow popups right after a click). Also wakes the referee.
export function warmUp() {
  if (TEST_MODE) return;
  getSelector().then(async s => {
    if (s.store.getState().accounts.length) walletInstance = await s.wallet();
  }).catch(() => {});
  fetch(`${REFEREE_URL}/health`).catch(() => {});
}

export async function currentAccount() {
  if (TEST_MODE) return TEST_ACCOUNT;
  const s = await getSelector();
  const acc = s.store.getState().accounts.find(a => a.active) || s.store.getState().accounts[0];
  return acc ? acc.accountId : null;
}

export async function connectWallet() {
  const s = await getSelector();
  const wallet = await s.wallet('meteor-wallet');
  const accounts = await wallet.signIn({ contractId: CONTRACT_ID, methodNames: [] });
  walletInstance = wallet;
  return accounts[0]?.accountId || currentAccount();
}

// Call straight from a click handler.
async function humanCall(method, args, deposit = 0n) {
  const wallet = walletInstance || (walletInstance = await (await getSelector()).wallet());
  return wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [actionCreators.functionCall(method, args, GAS, deposit)],
  });
}

/** Pay the 3 NEAR buy-in and register a fresh session key for this table. */
export async function payBuyIn(tableId) {
  const session = KeyPair.fromRandom('ed25519');
  if (TEST_MODE) {
    await fetch(`${REFEREE_URL}/test/join`, { method: 'POST', body: JSON.stringify({ tableId, account: TEST_ACCOUNT, sessionKey: session.getPublicKey().toString() }) });
    return { session, hash: null };
  }
  const outcome = await humanCall('join', { table_id: tableId, session_key: session.getPublicKey().toString() }, BUY_IN_YOCTO);
  return { session, hash: outcome?.transaction?.hash || null };
}

export function signSeat(session, tableId, account) {
  const sig = session.sign(new TextEncoder().encode(`ronpoker:${tableId}:${account}`)).signature;
  return { publicKey: session.getPublicKey().toString(), signature: btoa(String.fromCharCode(...sig)) };
}

export async function withdrawAll() {
  return humanCall('withdraw', {}, 1n);
}

// ---- referee connection ----------------------------------------------------

/** Open a WebSocket to the referee. `onMessage(msg)` gets every server message. */
export function connectReferee(onMessage, onClose) {
  const ws = new WebSocket(`${REFEREE_URL.replace(/^http/, 'ws')}/ws`);
  ws.onmessage = ev => { try { onMessage(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
  ws.onclose = () => onClose && onClose();
  const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('could not reach the referee service'));
  });
  return { ws, send, ready, close: () => ws.close() };
}

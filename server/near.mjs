// NEAR access for the referee service: deterministic keys, accounts, and contract calls.
//
// Every key is derived from one secret (MASTER_SECRET), which the host generates and keeps.
// Nothing secret is stored in the repository. From it come:
//  - the referee account: opens tables and reports results (it holds no player money)
//  - for each AI: a sponsor key (full access, only used to top up its bankroll)
//    and a play key (function-call only: create/join tables; cannot move NEAR)

import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey } from 'near-api-js';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';

// Never let a stalled RPC connection hang a table: every request gives up after 12 s
// and the failover provider moves on to the next endpoint.
const baseFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => baseFetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(12_000) });

export const NEAR = 10n ** 24n;
const GAS = 50_000_000_000_000n;

export const RPC_URLS = (process.env.RPC_URLS || 'https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org').split(',');
export const FAUCET_URL = process.env.FAUCET_URL || 'https://helper.nearprotocol.com/account';
export const provider = new FailoverRpcProvider(RPC_URLS.map(url => new JsonRpcProvider({ url }, { retries: 2, backoff: 1.5, wait: 400 })));

export function deriveKey(secret, label) {
  const seed = createHash('sha256').update(`${secret}:${label}`).digest();
  const pub = ed25519.getPublicKey(seed);
  const ext = new Uint8Array(64);
  ext.set(seed);
  ext.set(pub, 32);
  const keyPair = KeyPair.fromString(`ed25519:${bs58.encode(ext)}`);
  return { keyPair, secretKey: keyPair.toString(), publicKey: keyPair.getPublicKey().toString(), tag: Buffer.from(pub).toString('hex').slice(0, 10) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function accountExists(accountId) {
  try { await provider.viewAccount({ accountId, finality: 'final' }); return true; } catch { return false; }
}

export async function balanceOf(accountId) {
  const a = await provider.viewAccount({ accountId, finality: 'final' });
  return BigInt(a.amount);
}

/** Create a funded testnet account for this public key through the testnet faucet. */
export async function ensureAccount(accountId, publicKey) {
  if (await accountExists(accountId)) return false;
  const r = await fetch(FAUCET_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  if (!r.ok) throw new Error(`faucet refused ${accountId}: ${r.status} ${(await r.text()).slice(0, 120)}`);
  for (let i = 0; i < 20 && !(await accountExists(accountId)); i++) await sleep(1000);
  return true;
}

export async function hasKey(accountId, publicKey) {
  const list = await provider.viewAccessKeyList({ accountId, finality: 'final' });
  return list.keys.some(k => k.public_key === publicKey);
}

// One transaction at a time per signer, so concurrent tables never reuse a nonce.
const queues = new Map();
function serial(accountId, fn) {
  const prev = queues.get(accountId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(accountId, next);
  return next;
}

export function signerAccount(accountId, secretKey) {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey));
}

export async function call(account, contractId, methodName, args, deposit = 0n) {
  return serial(account.accountId, async () => {
    // Wait only until the call has executed (about a second), not for full finality.
    const outcome = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas: GAS, waitUntil: 'EXECUTED_OPTIMISTIC' });
    const b64 = outcome?.status?.SuccessValue;
    let value = null;
    if (b64) { try { value = JSON.parse(Buffer.from(b64, 'base64').toString()); } catch { /* not json */ } }
    if (outcome?.status?.Failure) throw new Error(`${methodName} failed: ${JSON.stringify(outcome.status.Failure).slice(0, 200)}`);
    return { hash: outcome.transaction.hash, value };
  });
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args, finality: 'optimistic' });
}

export async function addPlayKey(sponsor, publicKey, contractId, methodNames, allowance) {
  return serial(sponsor.accountId, () => sponsor.addFunctionCallAccessKey({ publicKey, contractId, methodNames, allowance }));
}

export function verifySignature(publicKey, message, signatureB64) {
  try {
    return PublicKey.fromString(publicKey).verify(new TextEncoder().encode(message), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

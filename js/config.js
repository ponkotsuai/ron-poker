// Testnet deployment. No keys live here: the referee service holds its own keys and the AI wallets.

export const NETWORK = 'testnet';
// Public testnet RPC endpoints, tried in order (all allow browser requests).
export const RPC_URLS = [
  'https://test.rpc.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://rpc.testnet.fastnear.com',
  'https://rpc.testnet.near.org',
];
export const EXPLORER = 'https://testnet.nearblocks.io';
export const CONTRACT_ID = 'ronpoker-5a0mg.testnet';
// The referee service (deals, runs the AI players, reports results to the contract).
const DEFAULT_REFEREE = 'https://ron-poker-referee.onrender.com';
// Local testing only: ?referee=http://localhost:PORT points the page at a local referee
// running on an in-memory chain, with a stand-in wallet.
const override = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('referee') : null;
export const TEST_MODE = !!override && /^http:\/\/localhost:\d+$/.test(override);
export const REFEREE_URL = TEST_MODE ? override : DEFAULT_REFEREE;
export const BUY_IN_YOCTO = 3n * 10n ** 24n; // 3 NEAR = 30 points

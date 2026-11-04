// Testnet deployment of the table contract.
// AI agent wallets are not configured here: each player's browser creates its own three AI accounts
// on first play, and their keys never leave that browser (see js/chain.js, setupAgents).

export const NETWORK = 'testnet';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const CONTRACT_ID = 'ronpoker-jir3s.testnet';
export const BUY_IN_YOCTO = 3n * 10n ** 24n; // 3 NEAR = 30 points
// Testnet faucet endpoint that creates a funded account for a given public key.
export const FAUCET_URL = 'https://helper.nearprotocol.com/account';
// What each AI puts into its bankroll when its wallet is opened (two buy-ins).
export const AI_BANKROLL_YOCTO = 6n * 10n ** 24n;
// The AI's playing key can call only these methods, and only on the table contract.
export const AI_METHODS = ['create_table', 'join', 'submit_result', 'abort'];
export const AI_GAS_ALLOWANCE_YOCTO = 10n ** 24n; // 1 NEAR of gas, then the key stops working

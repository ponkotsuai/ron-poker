// Testnet deployment. AI keys are function-call access keys: they can only call
// create_table / join / submit_result / abort on the table contract, with a small gas allowance.
// They cannot transfer NEAR or withdraw a bankroll (withdraw needs a full-access key).

export const NETWORK = 'testnet';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const CONTRACT_ID = 'ronpoker-jir3s.testnet';
export const BUY_IN_YOCTO = 3n * 10n ** 24n; // 3 NEAR = 30 points

export const AI_ACCOUNTS = {
  tanuki: { accountId: 'tanuki-jir3s.testnet', key: '' },
  tsuru: { accountId: 'tsuru-jir3s.testnet', key: '' },
  kitsune: { accountId: 'kitsune-jir3s.testnet', key: '' },
};

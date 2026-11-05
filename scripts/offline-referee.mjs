// Start a referee on an in-memory chain for local UI testing.
process.env.OFFLINE = '1';
process.env.MASTER_SECRET ||= 'local-ui-test';
process.env.CONTRACT_ID ||= 'ronpoker-local.testnet';
const offline = await import('../server/near-offline.mjs');
offline.chain.setReferee(`ronref-${offline.deriveKey(process.env.MASTER_SECRET, 'referee').tag}.testnet`);
await import('../server/index.mjs');

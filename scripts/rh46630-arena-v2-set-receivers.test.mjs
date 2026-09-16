import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARENA_WAR_POOL_TREASURY_V2,
  CURRENT_STAGE_PROTOCOL_REVENUE_VAULT,
  CURRENT_STAGE_TREASURY_ROUTER,
  GREEN_FACTORY,
  POSTGRAD_LEAGUE_TREASURY_V2,
  WAR_POOL_OWNER,
  assertSupportedChainId,
  receiverSummary,
  runReceiverUpdate,
} from './rh46630-arena-v2-set-receivers.mjs';

const OTHER_PROTOCOL_RECEIVER = '0x000000000000000000000000000000000000dEaD';

function baseState(overrides = {}) {
  return {
    chainId: 46630,
    factory: GREEN_FACTORY,
    factoryOwner: WAR_POOL_OWNER,
    factoryRuntimeHash: '0xeef9fc549717aa70bb357d0aa22ee96ef86f00b2d9b6bd4a54a1cd1b6bf0776f',
    treasuryRouter: CURRENT_STAGE_TREASURY_ROUTER,
    treasuryRouterRuntimeHash: '0x753c301638e1aa741261e4afedd4836954183ae3b116e66e87f528e2aa1704f4',
    discoveredProtocolVault: CURRENT_STAGE_PROTOCOL_REVENUE_VAULT,
    protocolRevenueVaultRuntimeHash: '0x94f992f07f7c26bb7152939e39321a5bd475f137fdbe24f92bf02f7a854f507a',
    warPool: ARENA_WAR_POOL_TREASURY_V2,
    warPoolOwner: WAR_POOL_OWNER,
    warPoolRuntimeHash: '0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d',
    currentProtocolReceiver: OTHER_PROTOCOL_RECEIVER,
    currentPostGradLeagueTreasury: POSTGRAD_LEAGUE_TREASURY_V2,
    ...overrides,
  };
}

test('dry-run is the default and names the GREEN ProtocolRevenueVault', () => {
  const summary = receiverSummary(baseState(), {});
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.liveRequested, false);
  assert.equal(summary.sendRequired, false);
  assert.equal(summary.proposed.protocolReceiver, CURRENT_STAGE_PROTOCOL_REVENUE_VAULT);
  assert.equal(summary.proposed.postGradLeagueTreasury, POSTGRAD_LEAGUE_TREASURY_V2);
  assert.equal(summary.matches.protocolReceiver, false);
  assert.equal(summary.matches.postGradLeagueTreasury, true);
});

test('production Robinhood chain 4663 throws', () => {
  assert.throws(() => assertSupportedChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => receiverSummary(baseState({ chainId: 4663 }), {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing RH46630_ARENA_SET_RECEIVERS flag never sends', async () => {
  let sends = 0;
  let signerLoads = 0;
  let reportWrites = 0;

  const result = await runReceiverUpdate({
    env: {},
    readState: async () => baseState(),
    loadSigner: async () => {
      signerLoads += 1;
      return { address: WAR_POOL_OWNER };
    },
    sendSetReceivers: async () => {
      sends += 1;
      return { txHash: '0x1' };
    },
    writeReport: async () => {
      reportWrites += 1;
    },
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.sent, false);
  assert.equal(signerLoads, 0);
  assert.equal(sends, 0);
  assert.equal(reportWrites, 0);
});

test('live gate requires the exact war-pool owner before any send', async () => {
  let sends = 0;
  await assert.rejects(
    runReceiverUpdate({
      env: { RH46630_ARENA_SET_RECEIVERS: '1' },
      readState: async () => baseState(),
      loadSigner: async () => ({ address: '0x0000000000000000000000000000000000000001' }),
      sendSetReceivers: async () => {
        sends += 1;
        return { txHash: '0x1' };
      },
    }),
    /WAR_POOL_OWNER_SIGNER_REQUIRED/,
  );
  assert.equal(sends, 0);
});

test('live gate is a no-op when both receivers already match', async () => {
  let sends = 0;
  const result = await runReceiverUpdate({
    env: { RH46630_ARENA_SET_RECEIVERS: '1' },
    readState: async () => baseState({ currentProtocolReceiver: CURRENT_STAGE_PROTOCOL_REVENUE_VAULT }),
    loadSigner: async () => ({ address: WAR_POOL_OWNER }),
    sendSetReceivers: async () => {
      sends += 1;
      return { txHash: '0x1' };
    },
  });
  assert.equal(result.matches.all, true);
  assert.equal(result.sent, false);
  assert.equal(sends, 0);
});

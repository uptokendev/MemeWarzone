import assert from "node:assert/strict";
import test from "node:test";

// env.ts reads process.env once at import, so every value the tests rely on is
// set here, before the first dynamic import. Each chain gets a distinct sentinel
// so a DogeOS lookup that falls through to BSC (or Robinhood) is visible.
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const DOGEOS = 6281971;
const RPC = {
  56: "https://bsc-56.rpc.invalid",
  97: "https://bsc-97.rpc.invalid",
  46630: "https://rh-46630.rpc.invalid",
  4663: "https://rh-4663.rpc.invalid",
  [DOGEOS]: "https://rpc.testnet.dogeos.com",
} as const;
const START = { 56: 5600, 97: 9700, 46630: 46630_00, 4663: 4663_00, [DOGEOS]: 628_1971 } as const;
const DOGEOS_FACTORY = "0x00000000000000000000000000000000d0d0e051";
const DOGEOS_SUPPORTED = "0x00000000000000000000000000000000d0d0e052";
const DOGEOS_ROUTER = "0x00000000000000000000000000000000d0d0e053";
const BSC_GENERIC_FACTORY = "0x00000000000000000000000000000000b5cb5c01";
const BSC_GENERIC_VOTE_TREASURY = "0x00000000000000000000000000000000b5cb5c02";

Object.assign(process.env, {
  BSC_RPC_HTTP_56: RPC[56],
  BSC_RPC_HTTP_97: RPC[97],
  ROBINHOOD_RPC_HTTP_46630: RPC[46630],
  ROBINHOOD_RPC_HTTP_4663: RPC[4663],
  DOGEOS_RPC_HTTP_6281971: RPC[DOGEOS],
  FACTORY_START_BLOCK_56: String(START[56]),
  FACTORY_START_BLOCK_97: String(START[97]),
  FACTORY_START_BLOCK_46630: String(START[46630]),
  FACTORY_START_BLOCK_4663: String(START[4663]),
  FACTORY_START_BLOCK_6281971: String(START[DOGEOS]),
  // Generic (unsuffixed) names that 56/97 fall back to. DogeOS must never pick them up.
  FACTORY_ADDRESS: BSC_GENERIC_FACTORY,
  VOTE_TREASURY_ADDRESS: BSC_GENERIC_VOTE_TREASURY,
  FACTORY_ADDRESS_6281971: DOGEOS_FACTORY,
  SUPPORTED_FACTORY_ADDRESSES_6281971: `${DOGEOS_FACTORY},${DOGEOS_SUPPORTED}`,
  SUPPORTED_FACTORY_START_BLOCKS_6281971: `${START[DOGEOS]},${START[DOGEOS] + 1}`,
  ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971: DOGEOS_ROUTER,
  // Vote treasury stays empty for DogeOS until sub-project 3, even if someone sets these.
  VOTE_TREASURY_ADDRESS_6281971: "0x00000000000000000000000000000000d0d0e0ff",
  VOTE_TREASURY_START_BLOCK_6281971: "999",
});

const { ENV } = await import("../env.js");
const chains = await import("../evmIndexerChains.js");
const { bscRpcUrls, isEvmCurveChain } = await import("../canonicalCandleMaterializer.js");
const history = await import("../ensureCampaignTradeHistory.js");
const { factoryStartBlockForChain } = await import("../emptyTradeCursorRewind.js");
const { isCurrentMarketChain } = await import("../marketIdentity.js");
const { rpcUrlForChain } = await import("../marketApi.js");

function withEnv<T>(patch: Partial<typeof ENV>, fn: () => T): T {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) saved[key] = (ENV as any)[key];
  Object.assign(ENV, patch);
  try {
    return fn();
  } finally {
    Object.assign(ENV, saved);
  }
}

test("6281971 is a known EVM indexer chain but not in the hard-coded ACTIVE list", () => {
  assert.deepEqual([...chains.KNOWN_EVM_INDEXER_CHAIN_IDS], [56, 97, 4663, 46630, DOGEOS]);
  assert.equal(chains.isKnownEvmIndexerChainId(DOGEOS), true);
  assert.deepEqual([...chains.ACTIVE_EVM_INDEXER_CHAIN_IDS], [56, 97], "ACTIVE list unchanged");
  assert.equal(chains.isActiveEvmIndexerChainId(DOGEOS), false);
});

test("env: DogeOS block reads only its own per-chain names; vote treasury stays empty", () => {
  assert.equal(ENV.DOGEOS_RPC_HTTP_6281971, RPC[DOGEOS]);
  assert.equal(ENV.FACTORY_ADDRESS_6281971, DOGEOS_FACTORY, "never the generic BSC FACTORY_ADDRESS");
  assert.deepEqual(ENV.SUPPORTED_FACTORY_ADDRESSES_6281971, [DOGEOS_FACTORY, DOGEOS_SUPPORTED]);
  assert.deepEqual(ENV.SUPPORTED_FACTORY_START_BLOCKS_6281971, [START[DOGEOS], START[DOGEOS] + 1]);
  assert.equal(ENV.FACTORY_START_BLOCK_6281971, START[DOGEOS]);
  assert.equal(ENV.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971, DOGEOS_ROUTER);
  assert.equal(ENV.VOTE_TREASURY_ADDRESS_6281971, "");
  assert.equal(ENV.VOTE_TREASURY_START_BLOCK_6281971, 0);
  // Existing chains read what they read before.
  assert.equal(ENV.FACTORY_ADDRESS_97, BSC_GENERIC_FACTORY);
  assert.equal(ENV.VOTE_TREASURY_ADDRESS_56, BSC_GENERIC_VOTE_TREASURY);
  assert.equal(ENV.FACTORY_ADDRESS_46630, "");
  assert.equal(ENV.ROBINHOOD_RPC_HTTP_46630, RPC[46630]);
});

test("CHAINS: a 6281971 entry exists only when its RPC is configured; existing entries unchanged", () => {
  const existing = [
    {
      chainId: 56,
      rpcHttp: RPC[56],
      factoryAddress: BSC_GENERIC_FACTORY,
      factoryStartBlock: START[56],
      voteTreasuryAddress: BSC_GENERIC_VOTE_TREASURY,
      voteTreasuryStartBlock: undefined,
    },
    {
      chainId: 97,
      rpcHttp: RPC[97],
      factoryAddress: BSC_GENERIC_FACTORY,
      factoryStartBlock: START[97],
      voteTreasuryAddress: BSC_GENERIC_VOTE_TREASURY,
      voteTreasuryStartBlock: undefined,
    },
    {
      chainId: 46630,
      rpcHttp: RPC[46630],
      factoryAddress: undefined,
      factoryStartBlock: START[46630],
      voteTreasuryAddress: undefined,
      voteTreasuryStartBlock: undefined,
    },
    {
      chainId: 4663,
      rpcHttp: RPC[4663],
      factoryAddress: undefined,
      factoryStartBlock: START[4663],
      voteTreasuryAddress: undefined,
      voteTreasuryStartBlock: undefined,
    },
  ];
  const dogeos = {
    chainId: DOGEOS,
    rpcHttp: RPC[DOGEOS],
    factoryAddress: DOGEOS_FACTORY,
    factoryStartBlock: START[DOGEOS],
    voteTreasuryAddress: undefined,
    voteTreasuryStartBlock: undefined,
  };

  assert.deepEqual(chains.buildIndexerChainList(ENV), [...existing, dogeos]);
  assert.deepEqual(chains.buildIndexerChainList({ ...ENV, DOGEOS_RPC_HTTP_6281971: "" }), existing);
  assert.deepEqual(
    chains.buildIndexerChainList({ ...ENV, DOGEOS_RPC_HTTP_6281971: "https://YOUR_KEY.example" }),
    existing,
    "placeholder RPC is filtered the same way as every other chain",
  );
});

test("graduated market and V3 branches: 6281971 is V3 with WDOGE; Robinhood and BNB unchanged", () => {
  assert.deepEqual(chains.graduatedMarketFor(DOGEOS), { venue: "v3", quoteAsset: "WDOGE" });
  assert.deepEqual(chains.graduatedMarketFor(46630), { venue: "v3", quoteAsset: "WETH" });
  assert.deepEqual(chains.graduatedMarketFor(4663), { venue: "v3", quoteAsset: "WETH" });
  assert.deepEqual(chains.graduatedMarketFor(56), { venue: "topaz", quoteAsset: "WBNB" });
  assert.deepEqual(chains.graduatedMarketFor(97), { venue: "topaz", quoteAsset: "WBNB" });

  assert.equal(chains.isV3GraduationIndexerChainId(DOGEOS), true);
  assert.equal(chains.isV3GraduationIndexerChainId(46630), true);
  assert.equal(chains.isV3GraduationIndexerChainId(4663), true);
  assert.equal(chains.isV3GraduationIndexerChainId(56), false);
  assert.equal(chains.isV3GraduationIndexerChainId(97), false);
  assert.equal(chains.isV3GraduationIndexerChainId(101), false);
});

test("curve RPC (canonicalCandleMaterializer.bscRpcUrls): DogeOS RPC or nothing, never BSC", () => {
  assert.deepEqual(bscRpcUrls(DOGEOS), [RPC[DOGEOS]]);
  withEnv({ DOGEOS_RPC_HTTP_6281971: "" }, () => {
    assert.deepEqual(bscRpcUrls(DOGEOS), [], "no DogeOS RPC must not fall back to BSC_RPC_HTTP_97");
  });
  assert.deepEqual(bscRpcUrls(56), [RPC[56]]);
  assert.deepEqual(bscRpcUrls(97), [RPC[97]]);
  assert.deepEqual(bscRpcUrls(46630), [RPC[46630]]);
  assert.deepEqual(bscRpcUrls(4663), [RPC[4663]]);
  assert.equal(isEvmCurveChain(DOGEOS), true);
  for (const id of [56, 97, 46630, 4663]) assert.equal(isEvmCurveChain(id), true);
  assert.equal(isEvmCurveChain(101), false);
});

test("trade-history backfill: RPC and factory start block are DogeOS or empty, never BSC", () => {
  assert.deepEqual(history.rpcUrlsFor(DOGEOS), [RPC[DOGEOS]]);
  withEnv({ DOGEOS_RPC_HTTP_6281971: "" }, () => {
    assert.deepEqual(history.rpcUrlsFor(DOGEOS), []);
  });
  assert.deepEqual(history.rpcUrlsFor(56), [RPC[56]]);
  assert.deepEqual(history.rpcUrlsFor(97), [RPC[97]]);
  assert.deepEqual(history.rpcUrlsFor(46630), [RPC[46630]]);
  assert.deepEqual(history.rpcUrlsFor(4663), [RPC[4663]]);

  assert.equal(history.historyFactoryStartBlock(DOGEOS), START[DOGEOS]);
  withEnv({ FACTORY_START_BLOCK_6281971: 0 }, () => {
    assert.equal(history.historyFactoryStartBlock(DOGEOS), 0, "unset DogeOS start must not borrow the BSC 97 start");
  });
  assert.equal(history.historyFactoryStartBlock(56), START[56]);
  assert.equal(history.historyFactoryStartBlock(97), START[97]);
});

test("trade-history tip window: 6281971 takes the explicit fast-chain window (2,500-block chunks <= 10k cap)", () => {
  const dogeos = history.historyTipWindow(DOGEOS);
  assert.deepEqual(dogeos, history.historyTipWindow(46630));
  assert.equal(dogeos.logChunkSize, 2_500);
  assert.ok(dogeos.logChunkSize <= 10_000);
  assert.ok(dogeos.tipBlocks >= 200_000);
  assert.equal(history.historyTipWindow(56).logChunkSize, undefined, "BSC unchanged");
  assert.equal(history.historyTipWindow(97).logChunkSize, undefined, "BSC unchanged");
});

test("empty-trade cursor rewind: factory start block is DogeOS or 0, never BSC 97", () => {
  assert.equal(factoryStartBlockForChain(DOGEOS), START[DOGEOS]);
  withEnv({ FACTORY_START_BLOCK_6281971: 0 }, () => {
    assert.equal(factoryStartBlockForChain(DOGEOS), 0);
  });
  assert.equal(factoryStartBlockForChain(56), START[56]);
  assert.equal(factoryStartBlockForChain(97), START[97]);
  assert.equal(factoryStartBlockForChain(46630), START[46630]);
  assert.equal(factoryStartBlockForChain(4663), START[4663]);
});

test("market identity accepts 6281971; Topaz market repair never reads DogeOS through a BSC RPC", () => {
  assert.equal(isCurrentMarketChain(DOGEOS), true);
  for (const id of [56, 97, 101, 4663, 46630]) assert.equal(isCurrentMarketChain(id), true);
  assert.equal(isCurrentMarketChain(102), false);

  assert.equal(rpcUrlForChain(DOGEOS), "", "Topaz-only repair: DogeOS gets no RPC, not BSC 97");
  assert.equal(rpcUrlForChain(56), RPC[56]);
  assert.equal(rpcUrlForChain(97), RPC[97]);
});

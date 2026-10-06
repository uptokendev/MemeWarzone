// Rebuilds the stored finance chain reads (financeSnapshots.js). Run by
// `npm run cron:finance-snapshots` every 5 minutes (Coolify scheduled task on
// the API service) and by POST /api/admin/finance/snapshots/refresh.
//
// Per mainnet, in this order:
//   fee routing (30 days)   balances, wiring, operator cap, inflows
//   payouts (30 days)       built from that fresh fee routing: vaults, creator
//                           fee vaults and claimables, arena pools, operator fill
//   indexer LP read         the LP fees the Summary and Status pages use
//   API LP read             the LP fees the Revenue page adds (api/dashboard/lp-fees.js)
//   UP vote fee receiver    BNB and Robinhood only
//   DBC pools               Solana only: Meteora DBC fee counters, migration
//                           fee and DAMM partner position (financeDbcPools.js)
//   import swap fees        new 0.5% fee transfers from the chain into
//                           finance_import_swap_fees (financeImportSwapFees.js)
// Plus SOL, BNB and ETH spot and the ECB rates. Chains run in parallel; one
// failing step is reported and keeps the last good snapshot.
//
// Read-only towards the chain (view calls). The only writes are the snapshot
// rows and the import swap fee rows.

import { feeRoutingAllNetworks, feeRoutingDays, refreshFeeRoutingSnapshot } from "./financeFeeRouting.js";
import { payoutsDays, refreshPayoutsSnapshot } from "./financePayouts.js";
import { refreshUpvoteApprovalSnapshot } from "./financeRevenueLanes.js";
import { snapshotCacheFor, snapshotKeys } from "./financeSnapshots.js";
import { freshPriceService } from "./financePrices.js";
import { defaultEurUsdSource } from "./financeAccountingFx.js";
import { ingestImportSwapFees } from "./financeImportSwapFees.js";
import { DBC_POOLS_SNAPSHOT_KEY, refreshDbcPoolsSnapshot } from "./financeDbcPools.js";

function message(error) {
  return String(error?.message || error || "failed").slice(0, 300);
}

async function step(results, key, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    results.push({ key, ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    results.push({ key, ok: false, ms: Date.now() - started, error: message(error) });
    return null;
  }
}

/**
 * @param {object} options
 * @param {{query: Function}} options.db
 * @param {number[]|null} [options.chainIds]  null = all mainnets
 * @param {(network) => Promise<object>} [options.readIndexerLp]  the live indexer LP read
 * @param {{key: Function, build: Function}} [options.readApiLpFees]  the API LP read (api/dashboard/lp-fees.js)
 * @param {(months) => Promise<object>} [options.buildSummary]  the Summary build (stored as summary:<months>)
 * @param {number} [options.timeoutMs]  stop waiting after this long (the rebuilds still finish and store)
 * @param {((args) => Promise<object>)|null} [options.ingestImportSwaps]  the import swap fee scan; null skips it
 */
export async function refreshFinanceSnapshots({ db, chainIds = null, readIndexerLp = null, readApiLpFees = null, buildSummary = null, summaryMonths = [12], timeoutMs = 0, prices = freshPriceService(), fx = defaultEurUsdSource(), ingestImportSwaps = ingestImportSwapFees, refreshDbcPools = refreshDbcPoolsSnapshot } = {}) {
  const started = Date.now();
  const results = [];
  const networks = feeRoutingAllNetworks().filter((n) => !chainIds || chainIds.includes(n.chainId));
  const feeDays = feeRoutingDays(undefined);
  const payDays = payoutsDays(undefined);
  const cache = snapshotCacheFor(db);

  const work = Promise.all([
    step(results, "prices:spot", async () => {
      for (const asset of ["SOL", "BNB", "ETH"]) if (!(await prices.spot(asset))) throw new Error(`No ${asset} spot price.`);
    }),
    step(results, "fx:ecb", async () => {
      if (!(await fx.rate())) throw new Error("No ECB rate.");
    }),
    ...networks.map(async (network) => {
      // Import swap fees first: the Summary built below counts them.
      if (ingestImportSwaps) await step(results, `import-swap-fees:${network.chainId}`, () => ingestImportSwaps({ db, chainId: network.chainId }));
      const feeRouting = await step(results, snapshotKeys.feeRouting(network, feeDays), () => refreshFeeRoutingSnapshot({ network, days: feeDays, db, prices }));
      await step(results, snapshotKeys.payouts(network, payDays), () => refreshPayoutsSnapshot({ network, days: payDays, db, prices, ...(feeRouting && payDays === feeDays ? { feeRouting } : {}) }));
      if (readIndexerLp) {
        const lpNetwork = { chainId: network.chainId, chain: network.chain, environment: network.environment, ...(network.cluster ? { cluster: network.cluster } : {}) };
        await step(results, snapshotKeys.indexerLp(lpNetwork), () => cache.refresh(snapshotKeys.indexerLp(lpNetwork), "indexer-lp", () => readIndexerLp(lpNetwork)));
      }
      if (readApiLpFees) {
        // The API's own LP read the Revenue page asks for (?snapshot=1), 50 coins.
        const q = { chainId: String(network.chainId), limit: "50", ...(network.chain === "solana" ? { environment: network.environment, solanaCluster: network.cluster } : {}) };
        const key = readApiLpFees.key(q);
        if (key) await step(results, key, () => cache.refresh(key, "api-lp-fees", () => readApiLpFees.build(q)));
      }
      if (network.chain !== "solana") {
        await step(results, snapshotKeys.upvoteApproval(network), () => refreshUpvoteApprovalSnapshot(db, network));
      } else if (refreshDbcPools) {
        await step(results, DBC_POOLS_SNAPSHOT_KEY, () => refreshDbcPools(db));
      }
    }),
  ]).then(async () => {
    // The Summary page in one row, built from the fresh chain reads above. It
    // also stores any new Binance hourly closes the revenue valuation needed.
    if (!buildSummary) return;
    for (const months of summaryMonths) {
      await step(results, snapshotKeys.summary(months), () => cache.refresh(snapshotKeys.summary(months), "summary", () => buildSummary(months)));
    }
  });

  let timedOut = false;
  if (timeoutMs > 0) {
    let timer;
    await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
    clearTimeout(timer);
  } else {
    await work;
  }
  return {
    startedAt: new Date(started).toISOString(),
    ms: Date.now() - started,
    timedOut,
    steps: [...results],
    failed: results.filter((r) => !r.ok).length,
  };
}

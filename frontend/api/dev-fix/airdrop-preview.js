/**
 * Read-only weekly airdrop preview. Never writes ledger/claimable rows.
 * GET /api/airdrops/preview?chainId=101
 */
import { pool } from "../../server/db.js";
import { badMethod, getQuery, json } from "../../server/http.js";
import { epochWindow } from "../../scripts/weekly-airdrop/config.mjs";
import {
  creatorCandidates,
  exclusionSets,
  traderCandidates,
} from "../../scripts/weekly-airdrop/candidates.mjs";

function isSolana(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function isRobinhood(chainId) {
  return Number(chainId) === 4663 || Number(chainId) === 46630;
}

function splitByWeight(poolRaw, items) {
  const pool = BigInt(poolRaw || "0");
  if (pool <= 0n || !items.length) {
    return items.map((item) => ({ ...item, estimatedShareRaw: "0" }));
  }
  const weights = items.map((item) => {
    const n = Number(item.finalWeight || 0);
    return Number.isFinite(n) && n > 0 ? n : 0.1;
  });
  const total = weights.reduce((sum, n) => sum + n, 0);
  if (!(total > 0)) return items.map((item) => ({ ...item, estimatedShareRaw: "0" }));
  let used = 0n;
  return items.map((item, index) => {
    const share =
      index === items.length - 1
        ? pool - used
        : (pool * BigInt(Math.round(weights[index] * 1_000_000))) / BigInt(Math.round(total * 1_000_000) || 1);
    used += share;
    return { ...item, estimatedShareRaw: share.toString() };
  });
}

export async function airdropPreview(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  const chainId = Number(q.chainId || 56);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return json(res, 400, { error: "Invalid chainId" });
  }

  const solana = isSolana(chainId);
  const robinhood = isRobinhood(chainId);
  const tokenSymbol = solana ? "SOL" : robinhood ? "ETH" : "BNB";
  const window = epochWindow();
  const empty = {
    ok: true,
    claimsOpen: false,
    chainId,
    tokenSymbol,
    epoch: {
      id: window.epochId,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    estimatedPoolRaw: "0",
    traders: [],
    creators: [],
    traderCount: 0,
    creatorCount: 0,
    note: "Read-only preview. Not a funded pot. Claims stay closed.",
  };

  if (!pool) return json(res, 200, empty);

  try {
    const exclusions = await exclusionSets(pool, {
      chainId,
      start: window.start,
      end: window.end,
    }).catch(() => ({ all: new Set(), securityCount: 0, totalCount: 0 }));

    const [traders, creators, volume] = await Promise.all([
      traderCandidates(pool, { chainId, start: window.start, end: window.end, exclusions }).catch(() => []),
      creatorCandidates(pool, { chainId, start: window.start, end: window.end, exclusions }).catch(() => []),
      pool
        .query(
          `select coalesce(sum(bnb_amount_raw), 0)::numeric as volume_raw, count(*)::int as trade_count
             from public.curve_trades
            where chain_id = $1 and block_time >= $2 and block_time < $3`,
          [chainId, window.start, window.end],
        )
        .catch(() => ({ rows: [{ volume_raw: "0", trade_count: 0 }] })),
    ]);

    const volumeRaw = BigInt(String(volume.rows?.[0]?.volume_raw || "0").split(".")[0] || "0");
    const estimatedPoolRaw = (volumeRaw * 50n) / 10_000n;
    const traderPool = estimatedPoolRaw / 2n;
    const creatorPool = estimatedPoolRaw - traderPool;
    const topTraders = traders
      .slice()
      .sort((a, b) => Number(b.finalWeight || 0) - Number(a.finalWeight || 0))
      .slice(0, 20);
    const topCreators = creators
      .slice()
      .sort((a, b) => Number(b.finalWeight || 0) - Number(a.finalWeight || 0))
      .slice(0, 20);

    return json(res, 200, {
      ...empty,
      estimatedPoolRaw: estimatedPoolRaw.toString(),
      tradeCount: Number(volume.rows?.[0]?.trade_count || 0),
      traders: splitByWeight(traderPool, topTraders).map((item) => ({
        walletAddress: item.walletAddress,
        program: "airdrop_trader",
        tradeCount: item.tradeCount || 0,
        activeDays: item.activeDays || 0,
        campaignCount: item.campaignCount || 0,
        volumeRaw: item.totalVolumeRaw,
        estimatedShareRaw: item.estimatedShareRaw,
        finalWeight: item.finalWeight,
      })),
      creators: splitByWeight(creatorPool, topCreators).map((item) => ({
        walletAddress: item.walletAddress,
        program: "airdrop_creator",
        uniqueBuyers: item.uniqueBuyers || 0,
        eligibleCampaignCount: item.eligibleCampaignCount || 0,
        volumeRaw: item.totalVolumeRaw,
        estimatedShareRaw: item.estimatedShareRaw,
        finalWeight: item.finalWeight,
      })),
      traderCount: traders.length,
      creatorCount: creators.length,
      note:
        estimatedPoolRaw > 0n
          ? `Read-only preview from ${volume.rows?.[0]?.trade_count || 0} bonding trades this epoch. Not funded. Claims stay closed.`
          : empty.note,
    });
  } catch (error) {
    console.error("[airdrop-preview]", error);
    return json(res, 200, { ...empty, warning: String(error?.message || error) });
  }
}

export default airdropPreview;

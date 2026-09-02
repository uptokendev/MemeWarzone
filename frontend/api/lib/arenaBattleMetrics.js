import { canonicalTokenKey } from "./arenaLeagueScoreMath.js";
import { BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";
import { calculateBattlePoints } from "./arenaBattlePoints.js";
import { getArenaMarketSnapshot, nativeRawToUsd, resolveNativeUsdPrice } from "./arenaMarketSnapshot.js";
import {
  battleVolumeWindow,
  computeEligibleBattleVolume,
  clusterIdFor,
  volumeAuditRows,
} from "./arenaBattleVolume.js";

const BASELINE_INSERT_SQL = `
INSERT INTO public.arena_battle_metrics (
  battle_id, token_id, side, scoring_version,
  start_mcap_usd, start_holders, start_liquidity_usd,
  baseline_timestamp, baseline_market_data_updated_at,
  baseline_data_source, baseline_healthy,
  current_mcap_usd, current_holders, current_liquidity_usd,
  market_data_updated_at, data_lag_seconds, data_source, data_healthy
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
ON CONFLICT (battle_id, side) DO NOTHING
`;

const BASELINE_COLUMNS = `
  battle_id, token_id, side, scoring_version,
  start_mcap_usd, start_holders, start_liquidity_usd,
  baseline_timestamp, baseline_market_data_updated_at,
  baseline_data_source, baseline_healthy,
  current_mcap_usd, current_holders, current_liquidity_usd,
  market_data_updated_at, data_lag_seconds, data_source, data_healthy
`;

async function defaultQuery(text, params) {
  const { pool } = await import("../../server/db.js");
  return pool.query(text, params);
}

function ident(value) {
  return canonicalTokenKey(value);
}

function asIso(value, fallback = null) {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function combatantSides(row) {
  return [
    { side: "left", tokenId: ident(row.challenger_token || row.challengerToken) },
    { side: "right", tokenId: ident(row.defender_token || row.defenderToken) },
  ].filter((item) => item.tokenId);
}

function baselineParams({ battleId, tokenId, side, snapshot, baselineTimestamp }) {
  const updatedAt = asIso(snapshot?.updatedAt || snapshot?.marketDataUpdatedAt, null);
  return [
    battleId,
    tokenId,
    side,
    snapshot?.scoringVersion || BATTLE_POINTS_V2,
    numOrNull(snapshot?.marketCapUsd),
    intOrNull(snapshot?.holders),
    numOrNull(snapshot?.liquidityUsd),
    baselineTimestamp,
    updatedAt,
    snapshot?.dataSource || "none",
    snapshot?.healthy === true,
    numOrNull(snapshot?.marketCapUsd),
    intOrNull(snapshot?.holders),
    numOrNull(snapshot?.liquidityUsd),
    updatedAt,
    numOrNull(snapshot?.dataLagSeconds),
    snapshot?.dataSource || "none",
    snapshot?.healthy === true,
  ];
}

/**
 * Captures both combatants in one INSERT statement so a database failure cannot
 * leave a one-sided baseline. The authoritative baseline timestamp is the
 * battle's immutable started_at, never callback wall-clock time.
 */
export async function captureLiveBaselines(row, deps = {}) {
  if (!row || String(row.state || "") !== "live") return { captured: false, reason: "not_live" };
  const query = deps.query || defaultQuery;
  const chainId = Number(row.chain_id ?? row.chainId);
  const battleId = String(row.id);
  const baselineTimestamp = asIso(row.started_at || row.startedAt, null);
  if (!baselineTimestamp) throw new Error(`Live battle ${battleId} is missing authoritative started_at`);

  const sides = combatantSides(row);
  if (sides.length !== 2) throw new Error(`Live battle ${battleId} must have exactly two combatants`);

  // Fetch both snapshots before any baseline write. If either adapter fails, no
  // partial baseline row is persisted.
  const prepared = [];
  for (const { side, tokenId } of sides) {
    const snapshot = deps.snapshots?.[side]
      || (deps.getSnapshot
        ? await deps.getSnapshot(chainId, tokenId)
        : await getArenaMarketSnapshot(chainId, tokenId, { query }));
    prepared.push({ side, tokenId, snapshot });
  }

  const params = prepared.flatMap(({ side, tokenId, snapshot }) =>
    baselineParams({ battleId, tokenId, side, snapshot, baselineTimestamp }));
  const first = Array.from({ length: 18 }, (_, index) => `$${index + 1}`).join(",");
  const second = Array.from({ length: 18 }, (_, index) => `$${index + 19}`).join(",");
  const sql = `insert into public.arena_battle_metrics (${BASELINE_COLUMNS}) values (${first}),(${second}) on conflict (battle_id, side) do nothing`;
  const inserted = await query(sql, params);

  return {
    captured: true,
    battleId,
    baselineTimestamp,
    insertedRows: inserted?.rowCount || 0,
    results: prepared.map(({ side, tokenId, snapshot }) => ({
      side,
      tokenId,
      healthy: snapshot?.healthy === true,
    })),
  };
}

export async function loadBattleMetrics(battleId, deps = {}) {
  const query = deps.query || defaultQuery;
  const result = await query(
    `select * from public.arena_battle_metrics where battle_id = $1 order by side asc`,
    [battleId],
  );
  return result.rows || [];
}

export async function replaceBattleVolumeAudit({ battleId, tokenId, rows }, deps = {}) {
  const query = deps.query || defaultQuery;
  await query(
    `delete from public.arena_battle_volume_audit where battle_id = $1 and token_id = $2`,
    [battleId, tokenId],
  );
  for (const row of rows) {
    await query(
      `insert into public.arena_battle_volume_audit (
          battle_id, token_id, side, wallet, cluster_id, tx_hash, log_index, block_time,
          native_amount, usd_amount, usd_counted, side_kind, source,
          quote_asset_type, quote_token_address, valuation_source,
          included, exclude_reason, raw_cluster_usd, counted_cluster_usd
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        row.battle_id,
        row.token_id,
        row.side,
        row.wallet,
        row.cluster_id,
        row.tx_hash,
        row.log_index,
        row.block_time,
        row.native_amount,
        row.usd_amount,
        row.usd_counted,
        row.side_kind,
        row.source,
        row.quote_asset_type,
        row.quote_token_address,
        row.valuation_source,
        row.included,
        row.exclude_reason,
        row.raw_cluster_usd,
        row.counted_cluster_usd,
      ],
    );
  }
}

export async function updateBattleMetricScores(battleId, side, patch, deps = {}) {
  const query = deps.query || defaultQuery;
  await query(
    `update public.arena_battle_metrics set
        current_mcap_usd = $3,
        current_holders = $4,
        current_liquidity_usd = $5,
        market_data_updated_at = $6,
        data_lag_seconds = $7,
        data_source = $8,
        data_healthy = $9,
        eligible_battle_volume_usd = $10,
        volume_raw_usd = $11,
        volume_excluded_usd = $12,
        volume_capped_usd = $13,
        mcap_points = $14,
        holder_points = $15,
        volume_points = $16,
        battle_points = $17,
        metrics_updated_at = now()
      where battle_id = $1 and side = $2`,
    [
      battleId,
      side,
      patch.currentMcapUsd,
      patch.currentHolders,
      patch.currentLiquidityUsd,
      patch.marketDataUpdatedAt,
      patch.dataLagSeconds,
      patch.dataSource,
      patch.dataHealthy,
      patch.eligibleUsd,
      patch.rawUsd,
      patch.excludedUsd,
      patch.cappedUsd,
      patch.mcapPoints,
      patch.holderPoints,
      patch.volumePoints,
      patch.battlePoints,
    ],
  );
}

export async function loadVolumeContext(chainId, identity, wallets, deps = {}) {
  const query = deps.query || defaultQuery;
  const creatorWallets = new Set();
  const creatorClusterIds = new Set();
  const fundedWallets = new Set();
  const restrictedWallets = new Set();
  const restrictedClusters = new Set();
  const washWallets = new Set();
  const washClusters = new Set();
  const clusterByWallet = new Map();

  if (identity?.creatorAddress) creatorWallets.add(ident(identity.creatorAddress));
  if (identity?.feeRecipientAddress) creatorWallets.add(ident(identity.feeRecipientAddress));

  const uniqueWallets = [...new Set((wallets || []).map(ident).filter(Boolean))];
  if (uniqueWallets.length) {
    try {
      const risk = await query(
        `select wallet_address, cluster_id, restricted
           from public.wallet_risk_profiles
          where lower(wallet_address) = any($1::text[])`,
        [uniqueWallets.map((w) => w.toLowerCase())],
      );
      for (const row of risk.rows || []) {
        const wallet = ident(row.wallet_address);
        if (row.cluster_id) clusterByWallet.set(wallet, String(row.cluster_id));
        if (row.restricted) restrictedWallets.add(wallet);
      }
    } catch {
      // Optional risk tables may be absent in isolated tests or some chains.
    }
    try {
      const members = await query(
        `select cluster_id, wallet_address
           from public.cluster_members
          where lower(wallet_address) = any($1::text[])`,
        [uniqueWallets.map((w) => w.toLowerCase())],
      );
      for (const row of members.rows || []) {
        const wallet = ident(row.wallet_address);
        if (row.cluster_id && !clusterByWallet.has(wallet)) clusterByWallet.set(wallet, String(row.cluster_id));
      }
    } catch {
      // optional
    }
  }

  const creatorList = [...creatorWallets];
  if (creatorList.length) {
    try {
      const creatorRisk = await query(
        `select wallet_address, cluster_id, restricted
           from public.wallet_risk_profiles
          where lower(wallet_address) = any($1::text[])`,
        [creatorList.map((w) => w.toLowerCase())],
      );
      for (const row of creatorRisk.rows || []) {
        if (row.cluster_id) creatorClusterIds.add(String(row.cluster_id));
        if (row.restricted) restrictedWallets.add(ident(row.wallet_address));
      }
    } catch {
      // optional
    }
    try {
      const creatorMembers = await query(
        `select cluster_id, wallet_address
           from public.cluster_members
          where lower(wallet_address) = any($1::text[])
             or cluster_id = any($2::text[])`,
        [creatorList.map((w) => w.toLowerCase()), [...creatorClusterIds]],
      );
      for (const row of creatorMembers.rows || []) {
        if (row.cluster_id) creatorClusterIds.add(String(row.cluster_id));
        creatorWallets.add(ident(row.wallet_address));
      }
    } catch {
      // optional
    }
    try {
      const funded = await query(
        `select funded_wallet
           from public.creator_funding_edges
          where chain_id = $1
            and lower(creator_wallet) = any($2::text[])`,
        [chainId, creatorList.map((w) => w.toLowerCase())],
      );
      for (const row of funded.rows || []) fundedWallets.add(ident(row.funded_wallet));
    } catch {
      // optional on chains where creator funding edges are not indexed yet
    }
  }

  if (creatorClusterIds.size) {
    try {
      const restricted = await query(
        `select cluster_id, restricted
           from public.wallet_clusters
          where cluster_id = any($1::text[])`,
        [[...creatorClusterIds]],
      );
      for (const row of restricted.rows || []) {
        if (row.restricted) restrictedClusters.add(String(row.cluster_id));
      }
    } catch {
      // optional
    }
  }

  return {
    clusterByWallet,
    creatorWallets,
    creatorClusterIds,
    fundedWallets,
    restrictedWallets,
    restrictedClusters,
    washWallets,
    washClusters,
  };
}

function normalizeTradeUsd(row, chainId, nativeUsd) {
  const explicitUsd = numOrNull(row.volumeUsd ?? row.volume_usd);
  if (explicitUsd !== null && explicitUsd > 0) {
    return { usdAmount: explicitUsd, valuationHealthy: true, valuationSource: "explicit_volume_usd" };
  }

  const quoteAssetType = String(row.quoteAssetType || row.quote_asset_type || "WRAPPED_NATIVE").toUpperCase();
  if (quoteAssetType === "STOCK_TOKEN") {
    return { usdAmount: null, valuationHealthy: false, valuationSource: "stock_quote_usd_missing" };
  }

  const raw = row.nativeAmountRaw ?? row.native_amount_raw ?? row.quoteAmountRaw ?? row.quote_amount_raw;
  const converted = nativeRawToUsd(chainId, raw, nativeUsd);
  return converted !== null && converted > 0
    ? { usdAmount: converted, valuationHealthy: true, valuationSource: "native_quote_fx" }
    : { usdAmount: null, valuationHealthy: false, valuationSource: "native_quote_usd_missing" };
}

export async function loadBattleWindowTrades({ chainId, campaignAddress, tokenAddress, liveAt, finishAt }, deps = {}) {
  const query = deps.query || defaultQuery;
  const nativeUsd = deps.nativeUsd || await resolveNativeUsdPrice(chainId, deps.resolveNativeUsd);
  const result = await query(
    `select "campaignAddress", "tokenAddress", "pairAddress", source, side, wallet, recipient,
            "nativeAmountRaw", "quoteAmountRaw", "quoteAssetType", "quoteTokenAddress",
            "volumeUsd", "referencePriceUsd", "referencePriceUpdatedAt",
            "txHash", "logIndex", "blockTime", status
       from public.market_trades_v
      where "chainId" = $1
        and "blockTime" >= $2
        and "blockTime" < $3
        and status = 'confirmed'
        and (
          ($4::text is not null and lower("campaignAddress") = lower($4))
          or ($5::text is not null and lower(coalesce("tokenAddress", '')) = lower($5))
        )`,
    [chainId, liveAt, finishAt, campaignAddress || null, tokenAddress || null],
  );
  return (result.rows || []).map((row) => {
    const valuation = normalizeTradeUsd(row, chainId, nativeUsd);
    return {
      wallet: row.wallet,
      recipient: row.recipient,
      side: row.side,
      usdAmount: valuation.usdAmount,
      valuationHealthy: valuation.valuationHealthy,
      valuationSource: valuation.valuationSource,
      nativeAmount: row.nativeAmountRaw ?? null,
      quoteAssetType: row.quoteAssetType || null,
      quoteTokenAddress: row.quoteTokenAddress || null,
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockTime: row.blockTime,
      status: row.status,
      source: row.source,
    };
  });
}

export async function refreshCombatantVolumeAndPoints({
  row,
  metricsRow,
  snapshot,
  trades,
  volumeContext,
  now = new Date(),
}, deps = {}) {
  const query = deps.query || defaultQuery;
  const window = battleVolumeWindow(row, metricsRow, now);
  const result = computeEligibleBattleVolume({
    trades,
    liveAt: window.liveAt,
    finishAt: window.finishAt,
    ...volumeContext,
  });
  const scored = calculateBattlePoints({
    baseline: {
      startMcapUsd: metricsRow.start_mcap_usd,
      startHolders: metricsRow.start_holders,
      startLiquidityUsd: metricsRow.start_liquidity_usd,
      baselineTimestamp: metricsRow.baseline_timestamp,
      marketDataUpdatedAt: metricsRow.baseline_market_data_updated_at,
    },
    current: {
      marketCapUsd: snapshot?.marketCapUsd,
      holders: snapshot?.holders,
      liquidityUsd: snapshot?.liquidityUsd,
      updatedAt: snapshot?.updatedAt,
      healthy: snapshot?.healthy,
      dataLagSeconds: snapshot?.dataLagSeconds,
      reason: snapshot?.reason,
      reasons: snapshot?.reasons,
    },
    eligibleVolume: {
      usd: result.eligibleUsd,
      rawUsd: result.rawUsd,
      cappedUsd: result.cappedUsd,
      clusters: result.clusters,
    },
    now,
  });
  const audit = volumeAuditRows({
    battleId: metricsRow.battle_id,
    tokenId: metricsRow.token_id,
    side: metricsRow.side,
    result,
  });
  await replaceBattleVolumeAudit({
    battleId: metricsRow.battle_id,
    tokenId: metricsRow.token_id,
    rows: audit,
  }, { query });
  await updateBattleMetricScores(metricsRow.battle_id, metricsRow.side, {
    currentMcapUsd: snapshot?.marketCapUsd ?? null,
    currentHolders: intOrNull(snapshot?.holders),
    currentLiquidityUsd: snapshot?.liquidityUsd ?? null,
    marketDataUpdatedAt: snapshot?.updatedAt || null,
    dataLagSeconds: snapshot?.dataLagSeconds ?? scored.dataHealth.dataLagSeconds,
    dataSource: snapshot?.dataSource || metricsRow.data_source,
    dataHealthy: scored.dataHealth.healthy,
    eligibleUsd: result.eligibleUsd,
    rawUsd: result.rawUsd,
    excludedUsd: result.excludedUsd,
    cappedUsd: result.cappedUsd,
    mcapPoints: scored.mcap.points,
    holderPoints: scored.holders.points,
    volumePoints: scored.volume.points,
    battlePoints: scored.totalPoints,
  }, { query });
  return { result, scored, window };
}

export { BASELINE_INSERT_SQL, clusterIdFor, battleVolumeWindow };

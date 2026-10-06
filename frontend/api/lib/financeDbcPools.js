// Meteora DBC pools for LP Harvest: what each DBC coin holds for us, read-only.
//
// A DBC coin is not a launchpad campaign and has no locked launchpad LP, so the
// launchpad LP read (indexer lpFeesRoutes.ts) never lists it. This read shows,
// per DBC pool:
//   before migration  the partner and creator trading-fee counters still on the
//                     pool (claimable now), what the indexer already claimed
//                     and routed (dbc_fee_accruals), and the partner migration
//                     fee the pool will pay at graduation (config: 22% of the
//                     threshold, 10% of it ours).
//   after migration   the keeper job (withdraw / compensate / route) and the
//                     collector's DAMM v2 partner position: unclaimed LP fees.
//
// Nothing here sends a transaction. Claiming is done by the indexer workers:
// partner trading fees by dbc-fee (dbcFeeClaimer.ts + dbcFeeRouter.ts), the
// migration fee and DAMM LP fees by dbc-grad (dbcGraduationKeeper.ts). There is
// no manual DBC harvest route, so LP Harvest lists these pools without a button.
//
// Stored as a finance snapshot (dbc-pools:101:mainnet-beta), rebuilt by
// cron:finance-snapshots; requests read the row.

import { publicHiddenWhere } from "./publicHiddenSql.js";
import { snapshotCacheFor } from "./financeSnapshots.js";
import { solanaRpcUrls } from "./financeFeeRouting.js";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DBC_POOLS_LIMIT = 200;
export const DBC_POOLS_SNAPSHOT_KEY = "dbc-pools:101:mainnet-beta";

// Same bits as realtime-indexer/src/dbc/dbcGraduationState.ts.
const CREATOR_WITHDRAW_BIT = 0b010;
const PARTNER_WITHDRAW_BIT = 0b100;

export const DBC_POOLS_SQL = `
  select c.campaign_address as pool,
         c.token_address as mint,
         c.name,
         c.symbol,
         c.creator_address,
         c.created_at,
         c.graduated_at_chain,
         c.meta #>> '{dbc,config}' as config,
         c.meta #>> '{dbc,quoteMint}' as quote_mint,
         c.meta #>> '{dbc,quoteSymbol}' as quote_symbol,
         c.meta #>> '{dbc,quoteDecimals}' as quote_decimals,
         c.meta #>> '{dbc,feeChoice}' as fee_choice,
         c.meta #>> '{dbc,migration,pool}' as migrated_pool,
         (${publicHiddenWhere("c")}) as test_coin,
         j.step as job_step,
         j.status as job_status,
         j.damm_pool as job_damm_pool,
         j.partner_fee::text as job_partner_fee,
         j.compensation::text as job_compensation,
         j.shortfall::text as job_shortfall,
         j.lp_claimed::text as job_lp_claimed,
         j.blocked_reason as job_blocked_reason,
         a.trades,
         a.collector_total,
         a.referral_total,
         a.protocol_total,
         a.unrouted,
         a.last_at
    from public.campaigns c
    left join public.dbc_graduation_jobs j on j.pool = c.campaign_address
    left join lateral (
      select count(*)::int as trades,
             coalesce(sum(d.collector_amount), 0)::text as collector_total,
             coalesce(sum(d.referral_fee), 0)::text as referral_total,
             coalesce(sum(d.protocol), 0)::text as protocol_total,
             count(*) filter (where d.status <> 'routed')::int as unrouted,
             max(d.created_at) as last_at
        from public.dbc_fee_accruals d
       where d.pool = c.campaign_address
    ) a on true
   where c.chain_id = 101
     and coalesce(c.launch_type, 'launchpad') = 'dbc'
     and c.campaign_address is not null
   order by c.created_at desc
   limit $1`;

function raw(value) {
  if (value == null) return "0";
  const text = typeof value === "bigint" ? value.toString() : String(value?.toString?.() ?? value).split(".")[0];
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, "") : "0";
}

export function atomicDisplay(value, decimals) {
  const text = raw(value);
  if (!decimals) return text;
  const padded = text.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function key(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

function num(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value ?? 0);
}

/**
 * Partner share of the migration fee from the config, with the keeper's
 * rounding (dbcGraduationSplit.ts expectedPartnerMigrationFee): the pool keeps
 * ceil(threshold x (100 - fee%) / 100); the creator gets floor(fee x creator% / 100).
 */
export function expectedMigrationSplit(threshold, feePct = 22, creatorPct = 90) {
  const t = BigInt(raw(threshold));
  const pct = BigInt(feePct);
  const intoPool = (t * (100n - pct) + 99n) / 100n;
  const fee = t - intoPool;
  const creator = (fee * BigInt(creatorPct)) / 100n;
  return { fee, creator, partner: fee - creator };
}

let coderPromise = null;
/** The DBC SDK's account coder (bytes only; the placeholder connection is never used). */
async function dbcCoder() {
  coderPromise ||= (async () => {
    const { Connection } = await import("@solana/web3.js");
    const { DynamicBondingCurveClient } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    return new DynamicBondingCurveClient(new Connection("http://127.0.0.1:8899"), "confirmed").state.program.coder.accounts;
  })();
  return coderPromise;
}

/** The fee and migration fields of a DBC virtual pool. */
export function poolFieldsFrom(decoded) {
  const p = decoded?.poolState ?? decoded ?? {};
  const pick = (a, b) => p[a] ?? p[b];
  return {
    config: key(pick("config", "config")),
    creator: key(pick("creator", "creator")),
    baseMint: key(pick("baseMint", "base_mint")),
    quoteReserve: raw(pick("quoteReserve", "quote_reserve")),
    partnerQuoteFee: raw(pick("partnerQuoteFee", "partner_quote_fee")),
    partnerBaseFee: raw(pick("partnerBaseFee", "partner_base_fee")),
    creatorQuoteFee: raw(pick("creatorQuoteFee", "creator_quote_fee")),
    creatorBaseFee: raw(pick("creatorBaseFee", "creator_base_fee")),
    isMigrated: num(pick("isMigrated", "is_migrated")) === 1,
    migrationFeeWithdrawStatus: num(pick("migrationFeeWithdrawStatus", "migration_fee_withdraw_status")),
  };
}

/** The partner and migration fields of a DBC pool config. */
export function configFieldsFrom(decoded) {
  const c = decoded?.poolConfig ?? decoded ?? {};
  const pick = (a, b) => c[a] ?? c[b];
  return {
    quoteMint: key(pick("quoteMint", "quote_mint")),
    feeClaimer: key(pick("feeClaimer", "fee_claimer")),
    leftoverReceiver: key(pick("leftoverReceiver", "leftover_receiver")),
    migrationQuoteThreshold: raw(pick("migrationQuoteThreshold", "migration_quote_threshold")),
    migrationFeePercentage: num(pick("migrationFeePercentage", "migration_fee_percentage")),
    creatorMigrationFeePercentage: num(pick("creatorMigrationFeePercentage", "creator_migration_fee_percentage")),
    creatorTradingFeePercentage: num(pick("creatorTradingFeePercentage", "creator_trading_fee_percentage")),
  };
}

async function rpcCall(urls, method, params, fetchImpl) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body && body.result !== undefined) return body.result;
      lastError = new Error(body?.error?.message || `HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Solana RPC configured.");
}

/** getMultipleAccounts in batches of 100: Map address -> {owner, bytes} | null. */
export async function readDbcAccounts(addresses, { urls, fetchImpl = fetch } = {}) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const result = await rpcCall(urls, "getMultipleAccounts", [batch, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
    const values = Array.isArray(result?.value) ? result.value : [];
    batch.forEach((address, index) => {
      const value = values[index];
      const data = value?.data?.[0];
      out.set(address, data ? { owner: String(value.owner || ""), bytes: Buffer.from(data, "base64") } : null);
    });
  }
  return out;
}

/**
 * The collector's DAMM v2 position on a migrated pool: unclaimed LP fees in the
 * quote and the coin. Read-only (cp-amm view helpers).
 */
async function defaultReadDammPartner({ dammPool, owner, quoteMint, urls }) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { CpAmm, getUnClaimLpFee } = await import("@meteora-ag/cp-amm-sdk");
  const cpAmm = new CpAmm(new Connection(urls[0], "confirmed"));
  const poolPk = new PublicKey(dammPool);
  const positions = await cpAmm.getUserPositionByPool(poolPk, new PublicKey(owner));
  if (!positions.length) return { position: null, unclaimedQuote: "0", unclaimedBase: "0" };
  const state = await cpAmm.fetchPoolState(poolPk);
  const quoteIsA = state.tokenAMint.toBase58() === quoteMint;
  let quote = 0n;
  let base = 0n;
  for (const pos of positions) {
    const fee = getUnClaimLpFee(state, pos.positionState);
    quote += BigInt(raw(quoteIsA ? fee.feeTokenA : fee.feeTokenB));
    base += BigInt(raw(quoteIsA ? fee.feeTokenB : fee.feeTokenA));
  }
  return { position: key(positions[0].position), unclaimedQuote: quote.toString(), unclaimedBase: base.toString() };
}

function stageOf(row, chain) {
  if (chain?.isMigrated || row.graduated_at_chain || row.migrated_pool) return "migrated";
  return "curve";
}

function jobView(row) {
  if (!row.job_step) return null;
  return {
    step: row.job_step,
    status: row.job_status || null,
    partnerFee: row.job_partner_fee ?? null,
    compensation: row.job_compensation ?? null,
    shortfall: row.job_shortfall ?? null,
    lpClaimed: row.job_lp_claimed ?? null,
    blockedReason: row.job_blocked_reason || null,
  };
}

/**
 * One item per DBC pool. Pure: takes the DB rows and the decoded chain reads.
 * @param {object[]} rows       DBC_POOLS_SQL rows
 * @param {Map} pools           pool address -> poolFieldsFrom(...) | {error}
 * @param {Map} configs         config address -> configFieldsFrom(...) | {error}
 * @param {Map} damm            pool address -> DAMM partner read | {error}
 * @param {string} collector    expected partner (DBC_FEE_COLLECTOR), "" when unset
 */
export function dbcPoolItems(rows, { pools = new Map(), configs = new Map(), damm = new Map(), collector = "" } = {}) {
  return rows.map((row) => {
    const chain = pools.get(row.pool) || null;
    const configAddress = chain?.config || row.config || "";
    const config = configAddress ? configs.get(configAddress) || null : null;
    const quoteMint = config?.quoteMint || row.quote_mint || WSOL_MINT;
    const quoteDecimals = Number.isInteger(Number(row.quote_decimals)) && row.quote_decimals != null ? Number(row.quote_decimals) : (quoteMint === WSOL_MINT ? 9 : 6);
    const quoteSymbol = row.quote_symbol || (quoteMint === WSOL_MINT ? "SOL" : "QUOTE");
    const q = (v) => (v == null ? null : atomicDisplay(v, quoteDecimals));
    const stage = stageOf(row, chain?.error ? null : chain);
    const errors = [];
    if (!chain) errors.push("Pool account not found on chain.");
    else if (chain.error) errors.push(`Pool read failed: ${chain.error}`);
    if (config?.error) errors.push(`Config read failed: ${config.error}`);

    const item = {
      pool: row.pool,
      mint: row.mint || chain?.baseMint || null,
      name: row.name || null,
      symbol: row.symbol || null,
      creatorAddress: row.creator_address || chain?.creator || null,
      testCoin: row.test_coin === true,
      stage,
      feeChoice: row.fee_choice || null,
      quote: { mint: quoteMint, symbol: quoteSymbol, decimals: quoteDecimals },
      config: configAddress || null,
      partner: config && !config.error ? config.feeClaimer || null : null,
      partnerIsCollector: config && !config.error && collector ? config.feeClaimer === collector : null,
      recorded: {
        trades: Number(row.trades || 0),
        collectorClaimed: q(row.collector_total ?? "0"),
        referral: q(row.referral_total ?? "0"),
        protocol: q(row.protocol_total ?? "0"),
        unrouted: Number(row.unrouted || 0),
        lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      },
      unclaimed: null,
      migrationFee: null,
      migration: null,
      damm: null,
      errors,
    };

    if (chain && !chain.error) {
      item.unclaimed = {
        partnerQuote: q(chain.partnerQuoteFee),
        partnerBase: chain.partnerBaseFee,
        creatorQuote: q(chain.creatorQuoteFee),
        creatorBase: chain.creatorBaseFee,
        partnerQuoteRaw: chain.partnerQuoteFee,
        creatorQuoteRaw: chain.creatorQuoteFee,
      };
    }
    if (config && !config.error && BigInt(config.migrationQuoteThreshold || "0") > 0n) {
      const split = expectedMigrationSplit(config.migrationQuoteThreshold, config.migrationFeePercentage || 22, config.creatorMigrationFeePercentage || 90);
      const threshold = BigInt(config.migrationQuoteThreshold);
      const reserve = chain && !chain.error ? BigInt(chain.quoteReserve) : null;
      item.migrationFee = {
        threshold: q(threshold),
        quoteReserve: reserve == null ? null : q(reserve),
        progressPct: reserve == null ? null : Math.min(100, Number((reserve * 10000n) / threshold) / 100),
        feePct: config.migrationFeePercentage,
        creatorPct: config.creatorMigrationFeePercentage,
        total: q(split.fee),
        creator: q(split.creator),
        partner: q(split.partner),
        partnerRaw: split.partner.toString(),
        partnerWithdrawn: chain && !chain.error ? (chain.migrationFeeWithdrawStatus & PARTNER_WITHDRAW_BIT) !== 0 : null,
        creatorWithdrawn: chain && !chain.error ? (chain.migrationFeeWithdrawStatus & CREATOR_WITHDRAW_BIT) !== 0 : null,
      };
    }
    const job = jobView(row);
    if (job) {
      item.migration = {
        ...job,
        partnerFee: job.partnerFee == null ? null : q(job.partnerFee),
        compensation: job.compensation == null ? null : q(job.compensation),
        shortfall: job.shortfall == null ? null : q(job.shortfall),
        lpClaimed: job.lpClaimed == null ? null : q(job.lpClaimed),
        dammPool: row.job_damm_pool || row.migrated_pool || null,
      };
    }
    const dammRead = damm.get(row.pool);
    if (dammRead) {
      item.damm = dammRead.error
        ? { pool: row.job_damm_pool || row.migrated_pool || null, error: dammRead.error }
        : {
            pool: row.job_damm_pool || row.migrated_pool || null,
            position: dammRead.position,
            unclaimedQuote: q(dammRead.unclaimedQuote),
            unclaimedBase: dammRead.unclaimedBase,
            unclaimedQuoteRaw: dammRead.unclaimedQuote,
          };
      if (dammRead.error) errors.push(`DAMM v2 read failed: ${dammRead.error}`);
    }
    return item;
  });
}

/** SOL totals over real (not test) coins on a SOL quote. */
export function dbcPoolTotals(items) {
  const sum = (pick) => items
    .filter((i) => !i.testCoin && i.quote.mint === WSOL_MINT)
    .reduce((acc, i) => acc + BigInt(pick(i) || "0"), 0n);
  return {
    asset: "SOL",
    partnerUnclaimed: atomicDisplay(sum((i) => i.unclaimed?.partnerQuoteRaw), 9),
    creatorUnclaimed: atomicDisplay(sum((i) => i.unclaimed?.creatorQuoteRaw), 9),
    dammPartnerUnclaimed: atomicDisplay(sum((i) => i.damm?.unclaimedQuoteRaw), 9),
    migrationFeePartnerPending: atomicDisplay(sum((i) => (i.stage === "curve" ? i.migrationFee?.partnerRaw : "0")), 9),
  };
}

export const DBC_POOLS_NOTES = Object.freeze([
  "Read-only. Partner trading fees are claimed by the indexer dbc-fee worker and re-split to the treasury vaults (dbcFeeClaimer.ts, dbcFeeRouter.ts); after migration the collector's DAMM v2 LP fees are claimed hourly by the dbc-grad worker (runDbcLpClaimsOnce). There is no manual harvest for DBC pools.",
  "Partner unclaimed: Meteora's partner counter on the pool (80% of the trading fee, less the creator's 7% of it). Creator unclaimed: the creator's own counter, claimed by the creator.",
  "Migration fee: 22% of the threshold at graduation, 90% creator / 10% partner. The partner 10% first pays the creator Meteora's 0.2% liquidity cut (D7), then the finalize split; the protocol remainder is revenue lane DBC migration fee (partner share).",
  "Test coins (hidden from public listings) are listed apart and left out of the totals.",
]);

/**
 * Builds the DBC pool read. `readAccounts` and `readDammPartner` are injected
 * in tests; by default they call the Solana RPC (view calls only).
 */
export async function buildDbcPools({
  db,
  env = process.env,
  urls = solanaRpcUrls(env),
  fetchImpl = fetch,
  readAccounts = (addresses) => readDbcAccounts(addresses, { urls, fetchImpl }),
  readDammPartner = (input) => defaultReadDammPartner({ ...input, urls }),
  decodePool = null,
  decodeConfig = null,
  limit = DBC_POOLS_LIMIT,
  now = () => new Date(),
} = {}) {
  const { rows } = await db.query(DBC_POOLS_SQL, [limit]);
  const collector = String(env.DBC_FEE_COLLECTOR || "").trim();
  const coder = decodePool && decodeConfig ? null : await dbcCoder();
  const asPool = decodePool || ((bytes) => poolFieldsFrom(coder.decode("virtualPool", bytes)));
  const asConfig = decodeConfig || ((bytes) => configFieldsFrom(coder.decode("poolConfig", bytes)));

  const pools = new Map();
  const configs = new Map();
  const damm = new Map();
  let chainError = null;
  try {
    const poolAccounts = await readAccounts(rows.map((r) => r.pool));
    for (const row of rows) {
      const account = poolAccounts.get(row.pool);
      if (!account) continue;
      if (account.owner && account.owner !== DBC_PROGRAM_ID) { pools.set(row.pool, { error: `owner ${account.owner} is not the DBC program` }); continue; }
      try { pools.set(row.pool, asPool(account.bytes)); } catch (error) { pools.set(row.pool, { error: String(error?.message || error).slice(0, 200) }); }
    }
    const configAddresses = [...new Set(rows.map((r) => pools.get(r.pool)?.config || r.config).filter(Boolean))];
    if (configAddresses.length) {
      const configAccounts = await readAccounts(configAddresses);
      for (const address of configAddresses) {
        const account = configAccounts.get(address);
        if (!account) { configs.set(address, { error: "config account not found" }); continue; }
        if (account.owner && account.owner !== DBC_PROGRAM_ID) { configs.set(address, { error: `owner ${account.owner} is not the DBC program` }); continue; }
        try { configs.set(address, asConfig(account.bytes)); } catch (error) { configs.set(address, { error: String(error?.message || error).slice(0, 200) }); }
      }
    }
  } catch (error) {
    chainError = String(error?.message || error).slice(0, 300);
  }

  for (const row of rows) {
    const chain = pools.get(row.pool);
    const dammPool = row.job_damm_pool || row.migrated_pool;
    if (!dammPool || !(chain?.isMigrated || row.graduated_at_chain)) continue;
    const config = configs.get(chain?.config || row.config);
    const owner = (config && !config.error && config.feeClaimer) || collector;
    if (!owner) { damm.set(row.pool, { error: "partner (fee claimer) unknown: config unread and DBC_FEE_COLLECTOR unset" }); continue; }
    try {
      damm.set(row.pool, await readDammPartner({ dammPool, owner, quoteMint: (config && !config.error && config.quoteMint) || row.quote_mint || WSOL_MINT }));
    } catch (error) {
      damm.set(row.pool, { error: String(error?.message || error).slice(0, 200) });
    }
  }

  const items = dbcPoolItems(rows, { pools: chainError ? new Map(rows.map((r) => [r.pool, { error: chainError }])) : pools, configs, damm, collector });
  return {
    ok: true,
    chainId: 101,
    environment: "production",
    cluster: "mainnet-beta",
    launchType: "dbc",
    programId: DBC_PROGRAM_ID,
    collector: collector || null,
    harvest: { available: false, reason: "Claimed automatically by the indexer dbc-fee and dbc-grad workers; no manual DBC harvest route exists." },
    totals: dbcPoolTotals(items),
    items,
    notes: [...DBC_POOLS_NOTES],
    ...(chainError ? { chainError } : {}),
    limit,
    truncated: rows.length >= limit,
    updatedAt: now().toISOString(),
  };
}

/** The stored DBC pool read (cron:finance-snapshots keeps it fresh). */
export function readDbcPoolsSnapshot(db, build = () => buildDbcPools({ db })) {
  return snapshotCacheFor(db).get(DBC_POOLS_SNAPSHOT_KEY, "dbc-pools", build);
}

/** Rebuilds the stored DBC pool read now (cron). */
export function refreshDbcPoolsSnapshot(db, build = () => buildDbcPools({ db })) {
  return snapshotCacheFor(db).refresh(DBC_POOLS_SNAPSHOT_KEY, "dbc-pools", build);
}

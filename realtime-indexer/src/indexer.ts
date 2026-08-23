import { ethers } from "ethers";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { LAUNCH_FACTORY_ABI, LAUNCH_CAMPAIGN_ABI, TREASURY_ROUTER_ABI, UP_VOTE_TREASURY_ABI } from "./abis.js";
import { TIMEFRAMES, bucketStart, TF } from "./timeframes.js";
import { publishTrade, publishCandle, publishStats, publishLeague } from "./ably.js";
import { createLeagueFeedPublisher } from "./leagueFeed.js";
import { recordCampaignCreatedActivity, recordTradeActivity } from "./rewards/attribution.js";
import { upsertRewardEvent } from "./rewards/ingest.js";
import { createStaticJsonRpcProvider, createWorkingProvider, parseRpcList } from "./rpcProvider.js";
import { bnbCurveState, parseRawTokenAmount } from "./bnbCurvePricing.js";
import { campaignScanChunks } from "./campaignScanChunks.js";
import { checkMilestones } from "./milestones.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const leagueFeed = createLeagueFeedPublisher({ pool, flushMs: 500 });
leagueFeed.start();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDec18(x: bigint): number {
  return Number(ethers.formatUnits(x, 18));
}

function isRateLimitError(e: any): boolean {
  const msg = String(e?.shortMessage || e?.message || "").toLowerCase();
  // ethers v6 often wraps provider/network failures like this
  if (msg.includes("could not coalesce")) return true;
  if (msg.includes("missing response")) return true;
  if (msg.includes("failed to fetch")) return true;
  if (msg.includes("network error")) return true;

  if (msg.includes("rate limit")) return true;

  // ethers v6 BAD_DATA wrapping JSON-RPC batch errors
  const v = e?.value;
  if (Array.isArray(v) && v[0]?.error?.code === -32005) return true;
  const infoV = e?.info?.value;
  if (Array.isArray(infoV) && infoV[0]?.error?.code === -32005) return true;
  const inner = e?.error;
  if (inner?.code === -32005) return true;
  return false;
}

function isPrunedHistoryError(e: any): boolean {
  // Seen on some providers (e.g., Allnodes) for old eth_getLogs ranges
  const code = e?.error?.code ?? e?.code;
  if (code === -32701) return true;
  const msg = String(e?.shortMessage || e?.message || e?.error?.message || "").toLowerCase();
  if (msg.includes("history has been pruned")) return true;
  if (msg.includes("pruned")) return true;
  return false;
}

function isRpcTransportError(e: any): boolean {
  const msg = String(e?.shortMessage || e?.message || "").toLowerCase();

  // ethers v6 sometimes wraps provider/network issues as "could not coalesce error"
  // (often caused by transient gateway failures or malformed JSON-RPC responses)
  if (msg.includes("could not coalesce")) return true;
  if (msg.includes("missing response")) return true;
  if (msg.includes("failed to fetch")) return true;

  // Common transient gateway/network failures from public RPCs
  if (msg.includes("service unavailable") || msg.includes("503")) return true;
  if (msg.includes("bad gateway") || msg.includes("502")) return true;
  if (msg.includes("gateway timeout") || msg.includes("504")) return true;
  if (msg.includes("overflow")) return true;

  // TLS/connection problems (Railway/Node networking)
  if (msg.includes("handshake failure")) return true;
  if (msg.includes("eproto")) return true;
  if (msg.includes("econnreset") || msg.includes("connection reset")) return true;
  if (msg.includes("etimedout") || msg.includes("timeout")) return true;

  // Ethers sometimes nests these
  const code = String(e?.code || "");
  if (code === "SERVER_ERROR") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Activity feed helpers
// ---------------------------------------------------------------------------

type CampaignInfo = {
  tokenAddress: string | null;
  name: string | null;
  symbol: string | null;
};

const CAMPAIGN_CACHE = new Map<string, CampaignInfo>();
let activityWritesDisabled = false;

function cacheCampaignInfo(chainId: number, campaign: string, info: CampaignInfo) {
  const key = `${chainId}:${campaign.toLowerCase()}`;
  CAMPAIGN_CACHE.set(key, info);
}

async function getCampaignInfo(chainId: number, campaign: string): Promise<CampaignInfo | null> {
  const key = `${chainId}:${campaign.toLowerCase()}`;
  const cached = CAMPAIGN_CACHE.get(key);
  if (cached) return cached;

  try {
    const r = await pool.query(
      `select token_address, name, symbol
       from public.campaigns
       where chain_id=$1 and campaign_address=$2`,
      [chainId, campaign.toLowerCase()]
    );
    const row = r.rows?.[0];
    const info: CampaignInfo = {
      tokenAddress: row?.token_address ?? null,
      name: row?.name ?? null,
      symbol: row?.symbol ?? null,
    };
    cacheCampaignInfo(chainId, campaign, info);
    return info;
  } catch {
    return null;
  }
}

async function insertActivityEvent(row: {
  chainId: number;
  eventType: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  actor: string;
  campaign?: string | null;
  token?: string | null;
  amountInWei?: bigint | null;
  amountOutWei?: bigint | null;
  costWei?: bigint | null;
  payoutWei?: bigint | null;
  meta?: Record<string, any> | null;
}) {
  if (activityWritesDisabled) return;

  try {
    await pool.query(
      `insert into public.activity_events(
         chain_id,event_type,tx_hash,log_index,block_number,block_time,
         actor_address,campaign_address,token_address,
         amount_in_wei,amount_out_wei,cost_wei,payout_wei,meta
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (chain_id,tx_hash,log_index) do nothing`,
      [
        row.chainId,
        row.eventType,
        row.txHash.toLowerCase(),
        row.logIndex,
        row.blockNumber,
        row.blockTime,
        row.actor.toLowerCase(),
        row.campaign ? row.campaign.toLowerCase() : null,
        row.token ? row.token.toLowerCase() : null,
        row.amountInWei ? row.amountInWei.toString() : null,
        row.amountOutWei ? row.amountOutWei.toString() : null,
        row.costWei ? row.costWei.toString() : null,
        row.payoutWei ? row.payoutWei.toString() : null,
        row.meta ? JSON.stringify(row.meta) : "{}",
      ]
    );
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes("activity_events") || msg.includes("relation")) {
      // Disable further writes to avoid spamming logs if migration is missing.
      activityWritesDisabled = true;
      console.warn("[activity_events] disabled (table missing or invalid).", msg);
      return;
    }
    console.warn("[activity_events] insert failed", msg);
  }
}

async function getLogsSafe(
  provider: ethers.JsonRpcProvider,
  filter: any,
  depth = 0,
  opts: { skipDelay?: boolean; softFail?: boolean } = {}
): Promise<ethers.Log[]> {
  if (!opts.skipDelay && ENV.INDEXER_LOG_CALL_DELAY_MS > 0 && depth === 0) {
    await sleep(ENV.INDEXER_LOG_CALL_DELAY_MS + Math.floor(Math.random() * 100));
  }

  try {
    return await provider.getLogs(filter);
  } catch (e: any) {
    // Pruned history should not be retried on the SAME provider.
    if (isPrunedHistoryError(e)) {
      if (opts.softFail) return [];
      throw e;
    }

    // Some public RPCs fail eth_getLogs with transport-layer issues.
    // Treat those as transient so we can split ranges / retry.
    if (!isRateLimitError(e) && !isRpcTransportError(e)) {
      if (opts.softFail) return [];
      throw e;
    }

    const from = typeof filter?.fromBlock === "number" ? filter.fromBlock : null;
    const to = typeof filter?.toBlock === "number" ? filter.toBlock : null;

    // If the range is large, split it (dramatically reduces eth_getLogs load on public RPCs)
    if (from !== null && to !== null) {
      const span = to - from + 1;
      // Cap split depth — depth 12 with retries burned multi-minute passes with zero progress.
      if (span > ENV.MIN_LOG_CHUNK_SIZE && depth < 6) {
        const mid = Math.floor((from + to) / 2);
        const left = await getLogsSafe(provider, { ...filter, fromBlock: from, toBlock: mid }, depth + 1, opts);
        const right = await getLogsSafe(provider, { ...filter, fromBlock: mid + 1, toBlock: to }, depth + 1, opts);
        return left.concat(right);
      }
    }

    // Bounded retries. Soft-fail (tip/history chunk) returns [] so the cursor can advance.
    let delay = 400;
    const maxAttempts = opts.softFail ? 2 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(delay + Math.floor(Math.random() * 200));
      try {
        return await provider.getLogs(filter);
      } catch (e2: any) {
        if (isPrunedHistoryError(e2)) {
          if (opts.softFail) return [];
          throw e2;
        }
        if (!isRateLimitError(e2) && !isRpcTransportError(e2)) {
          if (opts.softFail) return [];
          throw e2;
        }
      }
      delay = Math.min(4_000, delay * 2);
    }

    if (opts.softFail) {
      console.warn("[indexer] getLogs soft-fail; skipping chunk", {
        from: filter?.fromBlock,
        to: filter?.toBlock,
        err: String(e?.shortMessage || e?.message || e),
      });
      return [];
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

type ChainCfg = {
  chainId: number;
  rpcHttp: string; // comma-separated list
  factoryAddress?: string;
  factoryStartBlock?: number;
  voteTreasuryAddress?: string;
  voteTreasuryStartBlock?: number;
};

const CHAINS: ChainCfg[] = [
  {
    chainId: 56,
    rpcHttp: ENV.BSC_RPC_HTTP_56,
    factoryAddress: ENV.FACTORY_ADDRESS_56 || undefined,
    factoryStartBlock: ENV.FACTORY_START_BLOCK_56 || undefined,
    voteTreasuryAddress: ENV.VOTE_TREASURY_ADDRESS_56 || undefined,
    voteTreasuryStartBlock: ENV.VOTE_TREASURY_START_BLOCK_56 || undefined
  },
  {
    chainId: 97,
    rpcHttp: ENV.BSC_RPC_HTTP_97,
    factoryAddress: ENV.FACTORY_ADDRESS_97 || undefined,
    factoryStartBlock: ENV.FACTORY_START_BLOCK_97 || undefined,
    voteTreasuryAddress: ENV.VOTE_TREASURY_ADDRESS_97 || undefined,
    voteTreasuryStartBlock: ENV.VOTE_TREASURY_START_BLOCK_97 || undefined
  }
].filter((chain) => Boolean(chain.rpcHttp));

// ---------------------------------------------------------------------------
// DB state
// ---------------------------------------------------------------------------

async function getState(chainId: number, cursor: string): Promise<number> {
  const r = await pool.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [chainId, cursor]
  );
  if (!r.rowCount) return 0;
  return Number(r.rows[0].last_indexed_block);
}

/** If a campaign cursor is millions of blocks behind, tip-scan still works but
 *  the normal history pass stays wedged on an Aug-old window and never publishes
 *  live fills. Jump the cursor to the recent tip so catch-up is finite. */
async function snapStaleCampaignCursor(
  chainId: number,
  campaign: string,
  head: number,
  tipBlocks: number,
): Promise<void> {
  const cursor = `campaign:${String(campaign || "").toLowerCase()}`;
  const last = await getState(chainId, cursor);
  if (head <= 0) return;
  // New campaign only: start near tip. Never jump an existing cursor over a gap —
  // that is how live buys between last-indexed and head-20k disappeared.
  if (last > 0) return;
  const next = Math.max(0, head - Math.max(3_000, tipBlocks));
  await setStateMax(chainId, cursor, next);
}

async function setStateMax(chainId: number, cursor: string, nextBlock: number) {
  // Do NOT allow the state to move backwards (repair jobs may scan earlier windows)
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
           updated_at=now()`,
    [chainId, cursor, nextBlock]
  );
}

async function upsertCampaign(
  chainId: number,
  factoryAddress: string | null,
  campaign: string,
  token: string,
  creator: string,
  name: string,
  symbol: string,
  createdBlock: number,
  createdAtChain: Date | null = null,
  logoURI: string | null = null
) {
  const normalizedCampaign = campaign.toLowerCase();
  const existed = await pool.query(
    `select 1 from public.campaigns where chain_id=$1 and campaign_address=$2 limit 1`,
    [chainId, normalizedCampaign]
  );

  // NOTE: campaigns lives in the *indexer* DB.
  // It is used for discovery + scanning and is separate from user-profile tables.
  // Current schema expects creator_address to be NOT NULL.
  await pool.query(
    `insert into public.campaigns(
        chain_id,factory_address,campaign_address,token_address,creator_address,name,symbol,created_block,created_at_chain,logo_uri,is_active
     )
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
     on conflict (chain_id,campaign_address) do update
       set token_address=coalesce(excluded.token_address, public.campaigns.token_address),
           factory_address=coalesce(public.campaigns.factory_address, excluded.factory_address),
           creator_address=coalesce(excluded.creator_address, public.campaigns.creator_address),
           name=coalesce(excluded.name, public.campaigns.name),
           symbol=coalesce(excluded.symbol, public.campaigns.symbol),
           logo_uri=coalesce(nullif(public.campaigns.logo_uri, ''), nullif(excluded.logo_uri, '')),
           created_block=(
             case
               -- Treat 0 as "unknown" (older migrations used DEFAULT 0).
               when public.campaigns.created_block is null or public.campaigns.created_block=0 then excluded.created_block
               when excluded.created_block is null or excluded.created_block=0 then public.campaigns.created_block
               else least(public.campaigns.created_block, excluded.created_block)
             end
           ),
           created_at_chain=(
             case
               when public.campaigns.created_at_chain is null then excluded.created_at_chain
               else public.campaigns.created_at_chain
             end
           ),
           is_active=true,
           updated_at=now()`,
    [
      chainId,
      (factoryAddress ? factoryAddress.toLowerCase() : null),
      normalizedCampaign,
      token.toLowerCase(),
      creator.toLowerCase(),
      name,
      symbol,
      createdBlock,
      createdAtChain,
      logoURI
    ]
  );

  if (!existed.rowCount) {
    try {
      await recordCampaignCreatedActivity(creator, createdAtChain ?? new Date());
    } catch (e) {
      console.warn("[phase2-attribution] campaign activity mark failed", { chainId, campaign: normalizedCampaign, creator }, e);
    }
  }

  cacheCampaignInfo(chainId, campaign, {
    tokenAddress: token ? token.toLowerCase() : null,
    name: name || null,
    symbol: symbol || null,
  });
}

async function setCampaignGraduated(
  chainId: number,
  campaign: string,
  graduatedBlock: number,
  graduatedAt: Date,
  txHash: string
) {
  await pool.query(
    `update public.campaigns
       set is_active=false,
           graduated_block=$3,
           graduated_at_chain=$4,
           meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('graduatedTx', $5),
           updated_at=now()
     where chain_id=$1 and campaign_address=$2`,
    [chainId, campaign.toLowerCase(), graduatedBlock, graduatedAt, txHash.toLowerCase()]
  );
}

async function setCampaignFeeRecipient(
  chainId: number,
  campaign: string,
  feeRecipient: string
) {
  await pool.query(
    `update public.campaigns
       set fee_recipient_address=coalesce(fee_recipient_address, $3),
           updated_at=now()
     where chain_id=$1 and campaign_address=$2`,
    [chainId, campaign.toLowerCase(), feeRecipient.toLowerCase()]
  );
}


async function listActiveCampaigns(
  chainId: number,
  factoryAddress?: string,
  campaignAddress?: string
): Promise<Array<{ campaign: string; createdBlock: number; tradeCount: number }>> {
  const normalizedFactory = factoryAddress ? factoryAddress.toLowerCase() : "";
  const normalizedCampaign = campaignAddress ? campaignAddress.toLowerCase() : "";
  const r = await pool.query(
    `select
       c.campaign_address,
       coalesce(c.created_block, 0) as created_block,
       (select count(*)::int from public.curve_trades t
         where t.chain_id=c.chain_id and t.campaign_address=c.campaign_address) as trade_count
     from public.campaigns c
     where c.chain_id=$1
       and c.is_active=true
       and ($2::text = '' or lower(c.factory_address) = $2)
       and ($3::text = '' or lower(c.campaign_address) = $3)
     order by coalesce(c.created_at_chain, c.updated_at, now()) desc`,
    [chainId, normalizedFactory, normalizedCampaign]
  );
  return r.rows.map((x) => ({
    campaign: String(x.campaign_address),
    createdBlock: Number(x.created_block || 0),
    tradeCount: Number(x.trade_count || 0),
  }));
}

async function listScannableCampaigns(
  chainId: number,
  campaignAddress?: string
): Promise<Array<{ campaign: string; createdBlock: number; tradeCount: number }>> {
  // Campaign contracts are durable even when the launch factory changes.
  // Factory addresses are discovery sources, not liveness filters. Filtering
  // campaign scans by the currently configured factory silently strands legacy
  // campaigns: their buys/sells still work on-chain, but charts, leagues, and
  // War Room metrics stop updating.
  return listActiveCampaigns(chainId, undefined, campaignAddress);
}

async function insertTrade(row: {
  chainId: number;
  campaign: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  side: "buy" | "sell";
  wallet: string;
  tokenRaw: bigint;
  bnbRaw: bigint;
}) {
  const tokenAmount = toDec18(row.tokenRaw);
  const bnbAmount = toDec18(row.bnbRaw);
  const priceBnb = tokenAmount > 0 ? bnbAmount / tokenAmount : null;

  const inserted = await pool.query(
    `insert into public.curve_trades(
        chain_id,campaign_address,tx_hash,log_index,block_number,block_time,
        side,wallet,token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (chain_id,tx_hash,log_index) do update set
       block_number = excluded.block_number,
       block_time = excluded.block_time,
       side = excluded.side,
       wallet = excluded.wallet,
       token_amount_raw = excluded.token_amount_raw,
       bnb_amount_raw = excluded.bnb_amount_raw,
       token_amount = excluded.token_amount,
       bnb_amount = excluded.bnb_amount,
       price_bnb = excluded.price_bnb
     where public.curve_trades.block_time is distinct from excluded.block_time
        or public.curve_trades.token_amount_raw is distinct from excluded.token_amount_raw
        or public.curve_trades.bnb_amount_raw is distinct from excluded.bnb_amount_raw
        or public.curve_trades.side is distinct from excluded.side
     returning (xmax = 0) as is_insert`,
    [
      row.chainId,
      row.campaign.toLowerCase(),
      row.txHash.toLowerCase(),
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      row.side,
      row.wallet.toLowerCase(),
      row.tokenRaw.toString(),
      row.bnbRaw.toString(),
      tokenAmount,
      bnbAmount,
      priceBnb
    ]
  );

  const isInsert = Boolean(inserted.rows[0]?.is_insert);
  if (isInsert) {
    try {
      await recordTradeActivity(row.wallet, row.blockTime);
    } catch (e) {
      console.warn("[phase2-attribution] trade activity mark failed", { chainId: row.chainId, campaign: row.campaign, wallet: row.wallet }, e);
    }
  }

  await touchCampaignActivity(row.chainId, row.campaign, row.blockTime);
  await checkMilestones(pool, row.chainId, row.campaign);

  return { inserted: isInsert, tokenAmount, bnbAmount, priceBnb };
}

async function insertVote(row: {
  chainId: number;
  campaign: string;
  voter: string;
  asset: string; // address(0) for native BNB
  amountRaw: bigint;
  meta: string; // bytes32 hex
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
}) {
  await pool.query(
    `insert into public.votes(
        chain_id,campaign_address,voter_address,asset_address,amount_raw,
        tx_hash,log_index,block_number,block_timestamp,meta,status
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed')
     on conflict (chain_id,tx_hash,log_index) do nothing`,
    [
      row.chainId,
      row.campaign.toLowerCase(),
      row.voter.toLowerCase(),
      row.asset.toLowerCase(),
      row.amountRaw.toString(),
      row.txHash.toLowerCase(),
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      row.meta.toLowerCase()
    ]
  );

  await touchCampaignActivity(row.chainId, row.campaign, row.blockTime);
}


async function touchCampaignActivity(chainId: number, campaign: string, at: Date) {
  const addr = campaign.toLowerCase();
  await pool.query(
    `insert into public.campaign_activity (chain_id, campaign_address, last_activity_at, updated_at)
     values ($1, $2, $3, now())
     on conflict (chain_id, campaign_address) do update set
       last_activity_at = greatest(excluded.last_activity_at, coalesce(public.campaign_activity.last_activity_at, to_timestamp(0))),
       updated_at = now()`,
    [chainId, addr, at]
  );

  // Realtime: propagate activity so home grids can re-sort instantly.
  try {
    leagueFeed.queueActivity(chainId, addr, Math.floor(at.getTime() / 1000));
  } catch {
    // best-effort
  }
}

async function patchVoteAggregates(chainId: number, campaign: string) {
  // Recompute aggregates for a single campaign. This is intentionally simple for v1.
  // If vote volume grows, we can switch to bucketed incremental aggregates.
  const r = await pool.query(
    `with v as (
       select
         count(*) filter (where block_timestamp >= now() - interval '1 hour') as votes_1h,
         count(*) filter (where block_timestamp >= now() - interval '24 hours') as votes_24h,
         count(*) filter (where block_timestamp >= now() - interval '7 days') as votes_7d,
         count(*) as votes_all_time,
         count(*) filter (
           where block_timestamp >= now() - interval '24 hours'
         ) as b0,
         count(*) filter (
           where block_timestamp < now() - interval '24 hours'
             and block_timestamp >= now() - interval '48 hours'
         ) as b1,
         count(*) filter (
           where block_timestamp < now() - interval '48 hours'
             and block_timestamp >= now() - interval '72 hours'
         ) as b2,
         max(block_timestamp) as last_vote_at
       from public.votes
       where chain_id=$1 and campaign_address=$2 and status='confirmed'
     )
     select
       coalesce(votes_1h,0)::int as votes_1h,
       coalesce(votes_24h,0)::int as votes_24h,
       coalesce(votes_7d,0)::int as votes_7d,
       coalesce(votes_all_time,0)::int as votes_all_time,
       (coalesce(b0,0) * 1.0 + coalesce(b1,0) * 0.5 + coalesce(b2,0) * 0.25) as trending_score,
       last_vote_at
     from v`,
    [chainId, campaign.toLowerCase()]
  );

  const x = r.rows[0] || {
    votes_1h: 0,
    votes_24h: 0,
    votes_7d: 0,
    votes_all_time: 0,
    trending_score: 0,
    last_vote_at: null
  };

  await pool.query(
    `insert into public.vote_aggregates(
        chain_id,campaign_address,
        votes_1h,votes_24h,votes_7d,votes_all_time,trending_score,
        last_vote_at,updated_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (chain_id,campaign_address) do update set
       votes_1h=excluded.votes_1h,
       votes_24h=excluded.votes_24h,
       votes_7d=excluded.votes_7d,
       votes_all_time=excluded.votes_all_time,
       trending_score=excluded.trending_score,
       last_vote_at=excluded.last_vote_at,
       updated_at=now()`,
    [
      chainId,
      campaign.toLowerCase(),
      Number(x.votes_1h || 0),
      Number(x.votes_24h || 0),
      Number(x.votes_7d || 0),
      Number(x.votes_all_time || 0),
      Number(x.trending_score || 0),
      x.last_vote_at
    ]
  );
  // Realtime publish is best-effort; never let it break indexing progress.
  try {
    leagueFeed.queueVotes(chainId, campaign, {
      votes24h: Number(x.votes_24h || 0),
      votesAllTime: Number(x.votes_all_time || 0),
      trendingScore: String(x.trending_score || 0)
    });
  } catch (e: any) {
    console.warn("leagueFeed.queueVotes failed", {
      chainId,
      campaign: campaign.toLowerCase(),
      err: e?.message || e
    });
  }
}

async function upsertCandle(
  chainId: number,
  campaign: string,
  tf: TF,
  bucketSec: number,
  price: number,
  volBnb: number,
  blockNumber = 0,
  logIndex = 0,
) {
  const bucketTs = new Date(bucketSec * 1000);

  await pool.query(
    `insert into public.token_candles(
        chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
        last_block_number,last_log_index
     ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,$7,$8)
     on conflict (chain_id,campaign_address,timeframe,bucket_start) do update set
       h = greatest(public.token_candles.h, excluded.h),
       l = least(public.token_candles.l, excluded.l),
       c = case
             when excluded.last_block_number > coalesce(public.token_candles.last_block_number, 0)
               or (
                 excluded.last_block_number = coalesce(public.token_candles.last_block_number, 0)
                 and excluded.last_log_index > coalesce(public.token_candles.last_log_index, 0)
               )
             then excluded.c
             else public.token_candles.c
           end,
       last_block_number = greatest(coalesce(public.token_candles.last_block_number, 0), excluded.last_block_number),
       last_log_index = case
             when excluded.last_block_number > coalesce(public.token_candles.last_block_number, 0)
             then excluded.last_log_index
             when excluded.last_block_number = coalesce(public.token_candles.last_block_number, 0)
              and excluded.last_log_index > coalesce(public.token_candles.last_log_index, 0)
             then excluded.last_log_index
             else public.token_candles.last_log_index
           end,
       volume_bnb = public.token_candles.volume_bnb + excluded.volume_bnb,
       trades_count = public.token_candles.trades_count + 1,
       updated_at = now()`,
    [chainId, campaign.toLowerCase(), tf, bucketTs, price, volBnb, blockNumber, logIndex]
  );

  // Lightweight realtime patch (authoritative values come from REST)
  await publishCandle(chainId, campaign, {
    type: "candle_upsert",
    tf,
    bucket: bucketSec,
    c: String(price),
    v: String(volBnb)
  });
}

const BNB_CURVE_PARAM_ABI = [
  "function basePrice() view returns (uint256)",
  "function priceSlope() view returns (uint256)",
];
const BNB_CURVE_PARAM_TTL_MS = 5 * 60 * 1000;
const bnbCurveParamCache = new Map<string, { base: bigint; slope: bigint; at: number }>();

async function loadBnbCurveParams(chainId: number, campaign: string): Promise<{ base: bigint; slope: bigint } | null> {
  const key = `${chainId}:${campaign.toLowerCase()}`;
  const cached = bnbCurveParamCache.get(key);
  if (cached && Date.now() - cached.at < BNB_CURVE_PARAM_TTL_MS) {
    return { base: cached.base, slope: cached.slope };
  }
  const urls = parseRpcList(chainId === 56 ? ENV.BSC_RPC_HTTP_56 : ENV.BSC_RPC_HTTP_97);
  if (!urls.length) return null;
  try {
    const { provider } = await createWorkingProvider(urls, chainId, {
      timeoutMs: 8_000,
      label: `bnb-curve-params-${chainId}`,
    });
    const contract = new ethers.Contract(campaign, BNB_CURVE_PARAM_ABI, provider) as any;
    const [basePriceRaw, priceSlopeRaw] = await Promise.all([
      contract.basePrice() as Promise<bigint>,
      contract.priceSlope() as Promise<bigint>,
    ]);
    const next = { base: BigInt(basePriceRaw), slope: BigInt(priceSlopeRaw), at: Date.now() };
    bnbCurveParamCache.set(key, next);
    return next;
  } catch (error) {
    console.warn("[indexer] BNB curve params unavailable", {
      chainId,
      campaign,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}



async function patchStats(chainId: number, campaign: string) {
  const r = await pool.query(
    `with t as (
       select price_bnb, block_time, bnb_amount
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
       order by block_number desc, log_index desc
       limit 1
     ),
     v as (
       select coalesce(sum(bnb_amount),0) as vol24h
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
         and block_time >= now() - interval '24 hours'
     )
     select
       (select price_bnb from t) as last_price_bnb,
       (select vol24h from v) as vol24h_bnb`,
    [chainId, campaign.toLowerCase()]
  );

  const fillPrice: number | null = r.rows[0]?.last_price_bnb != null ? Number(r.rows[0].last_price_bnb) : null;
  const vol24h: number = Number(r.rows[0]?.vol24h_bnb ?? 0);

  const soldRes = await pool.query(
    `select
       (coalesce(sum(case when side='buy' then token_amount_raw::numeric else 0 end),0) -
        coalesce(sum(case when side='sell' then token_amount_raw::numeric else 0 end),0)
       )::text as sold_raw
     from public.curve_trades
     where chain_id=$1 and campaign_address=$2`,
    [chainId, campaign.toLowerCase()]
  );

  const soldRaw = parseRawTokenAmount(soldRes.rows[0]?.sold_raw);
  const params = await loadBnbCurveParams(chainId, campaign);
  const curve = params ? bnbCurveState(params.base, params.slope, soldRaw) : null;
  // Current token price is curve marginal spot. Fill VWAP stays on
  // curve_trades.price_bnb and is never used to derive marketcap_bnb.
  const lastPrice: number | null =
    curve && curve.spotNative > 0
      ? curve.spotNative
      : (fillPrice != null && Number.isFinite(fillPrice) ? fillPrice : null);
  const sold: number = curve ? curve.soldWhole : Number(soldRaw) / 1e18;
  const marketcap: number | null = curve && curve.mcapNative > 0 ? curve.mcapNative : null;

  await pool.query(
    `insert into public.token_stats(
        chain_id,campaign_address,last_price_bnb,sold_tokens,marketcap_bnb,vol_24h_bnb,updated_at
     ) values($1,$2,$3,$4,$5,$6,now())
     on conflict (chain_id,campaign_address) do update set
       last_price_bnb=excluded.last_price_bnb,
       sold_tokens=excluded.sold_tokens,
       marketcap_bnb=excluded.marketcap_bnb,
       vol_24h_bnb=excluded.vol_24h_bnb,
       updated_at=now()`,
    [chainId, campaign.toLowerCase(), lastPrice, sold, marketcap, vol24h]
  );

  await publishStats(chainId, campaign, {
    type: "stats_patch",
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h)
  });

  leagueFeed.queueStats(chainId, campaign, {
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h)
  });

}

let bnbCanonicalMcapRefresh: Promise<{ campaigns: number; ok: number; failed: number }> | null = null;

/** Rewrite BNB token_stats to spot × sold without waiting for the next trade. */
export async function refreshBnbCanonicalMarketcaps() {
  if (bnbCanonicalMcapRefresh) return bnbCanonicalMcapRefresh;
  bnbCanonicalMcapRefresh = (async () => {
    const rows = await pool.query(
      `select chain_id, campaign_address from public.token_stats where chain_id in (56, 97)
       union
       select distinct chain_id, campaign_address from public.curve_trades where chain_id in (56, 97)`,
    );
    let ok = 0;
    let failed = 0;
    for (const row of rows.rows) {
      try {
        await patchStats(Number(row.chain_id), String(row.campaign_address));
        ok += 1;
      } catch (error) {
        failed += 1;
        console.warn("[indexer] BNB canonical mcap refresh failed", {
          chainId: row.chain_id,
          campaign: row.campaign_address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    console.log("[indexer] BNB canonical mcap refresh", {
      campaigns: rows.rows.length,
      ok,
      failed,
    });
    return { campaigns: rows.rows.length, ok, failed };
  })();
  try {
    return await bnbCanonicalMcapRefresh;
  } catch (error) {
    bnbCanonicalMcapRefresh = null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// On-chain scans
// ---------------------------------------------------------------------------

async function scanFactoryRange(
  provider: ethers.JsonRpcProvider,
  chain: ChainCfg,
  fromBlock: number,
  toBlock: number
) {
  if (!chain.factoryAddress) return;

  const iface = new ethers.Interface(LAUNCH_FACTORY_ABI);
  const eventFrag = iface.getEvent("CampaignCreated");
  if (!eventFrag) throw new Error("Event CampaignCreated not found in LAUNCH_FACTORY_ABI");
  const topic0 = eventFrag.topicHash;

  const cursor = "factory";
  const step = ENV.LOG_CHUNK_SIZE;

  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = Math.min(toBlock, start + step - 1);

    const logs = await getLogsSafe(provider, {
      address: chain.factoryAddress,
      fromBlock: start,
      toBlock: end,
      topics: [topic0]
    });

    // Best-effort: store created_at_chain using block timestamp
    const blkNums = Array.from(new Set(logs.map((l) => l.blockNumber)));
    const blockTimes = new Map<number, Date>();
    for (const bn of blkNums) {
      const b = await provider.getBlock(bn);
      blockTimes.set(bn, new Date(Number(b?.timestamp || 0) * 1000));
    }

    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const campaign = String((parsed.args as any).campaign);
      const token = String((parsed.args as any).token);
      const creator = String((parsed.args as any).creator);
      const name = String((parsed.args as any).name);
      const symbol = String((parsed.args as any).symbol);
      const blockTime = blockTimes.get(log.blockNumber) || null;
      await upsertCampaign(
        chain.chainId,
        chain.factoryAddress ?? null,
        campaign,
        token,
        creator,
        name,
        symbol,
        log.blockNumber,
        blockTime,
        null
      );

      // Realtime: announce newly created campaigns so Home "New" can insert instantly.
      // Keep payload minimal; UI can hydrate logoURI from chain later.
      try {
        await publishLeague(chain.chainId, "campaign_created", {
          type: "campaign_created",
          chainId: chain.chainId,
          ts: Math.floor(Date.now() / 1000),
          item: {
            campaignAddress: String(campaign).toLowerCase(),
            tokenAddress: String(token).toLowerCase(),
            creatorAddress: String(creator).toLowerCase(),
            name,
            symbol,
            createdAtChain: blockTime ? blockTime.toISOString() : null,
            blockNumber: log.blockNumber,
          },
        });
      } catch {
        // best-effort
      }

      if (log.transactionHash) {
        await insertActivityEvent({
          chainId: chain.chainId,
          eventType: "CREATE_CAMPAIGN",
          txHash: log.transactionHash,
          logIndex: log.index ?? 0,
          blockNumber: log.blockNumber,
          blockTime: blockTime || new Date(0),
          actor: creator,
          campaign,
          token,
          meta: {
            name,
            symbol,
            factory: chain.factoryAddress ? chain.factoryAddress.toLowerCase() : null,
          },
        });
      }
    }

    await setStateMax(chain.chainId, cursor, end + 1);
  }
}

async function scanVoteTreasuryRange(
  provider: ethers.JsonRpcProvider,
  chain: ChainCfg,
  fromBlock: number,
  toBlock: number
) {
  if (!chain.voteTreasuryAddress) return;

  const iface = new ethers.Interface(UP_VOTE_TREASURY_ABI);
  const eventFrag = iface.getEvent("VoteCast");
  if (!eventFrag) throw new Error("Event VoteCast not found in UP_VOTE_TREASURY_ABI");
  const topic0 = eventFrag.topicHash;

  const cursor = "votes";
  const step = ENV.LOG_CHUNK_SIZE;

  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = Math.min(toBlock, start + step - 1);

    const logs = await getLogsSafe(provider, {
      address: chain.voteTreasuryAddress,
      fromBlock: start,
      toBlock: end,
      topics: [topic0]
    });

    if (logs.length) {
      const blkNums = Array.from(new Set(logs.map((l) => l.blockNumber)));
      const blockTimes = new Map<number, Date>();
      for (const bn of blkNums) {
        const b = await provider.getBlock(bn);
        blockTimes.set(bn, new Date(Number(b?.timestamp || 0) * 1000));
      }

      const touched = new Set<string>();
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;

        const campaign = String((parsed.args as any).campaign);
        const voter = String((parsed.args as any).voter);
        const asset = String((parsed.args as any).asset);
        const amountPaid = (parsed.args as any).amountPaid as bigint;
        const meta = String((parsed.args as any).meta);

        await insertVote({
          chainId: chain.chainId,
          campaign,
          voter,
          asset,
          amountRaw: amountPaid,
          meta,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          blockTime: blockTimes.get(log.blockNumber) || new Date(0)
        });

        await insertActivityEvent({
          chainId: chain.chainId,
          eventType: "UPVOTE",
          txHash: log.transactionHash,
          logIndex: log.index ?? 0,
          blockNumber: log.blockNumber,
          blockTime: blockTimes.get(log.blockNumber) || new Date(0),
          actor: voter,
          campaign,
          amountInWei: amountPaid,
          meta: {
            asset: asset?.toLowerCase?.() ?? asset,
            meta,
          },
        });

        touched.add(campaign.toLowerCase());
      }

      for (const c of touched) {
        try {
          await patchVoteAggregates(chain.chainId, c);
        } catch (e: any) {
          // If aggregates fail, we still want the ledger + cursor to keep moving.
          // Otherwise Featured freezes forever.
          console.error("patchVoteAggregates failed", {
            chainId: chain.chainId,
            campaign: c,
            err: e?.message || e,
          });
        }
      }
    }

    // Cursor progression must not depend on aggregates or realtime publishing.
    await setStateMax(chain.chainId, cursor, end + 1);
  }
}


// ---------------------------------------------------------------------------
// Robust campaign discovery
// ---------------------------------------------------------------------------
//
// Some public RPCs can occasionally return incomplete eth_getLogs results.
// If that happens during the factory scan, we may miss a CampaignCreated event
// but still advance the factory cursor, causing the indexer to never learn about
// that campaign (and therefore never index its trades).
//
// To make discovery deterministic, we also periodically pull the factory's
// on-chain campaign registry (campaignsCount/getCampaign) and upsert any missing
// rows into public.campaigns.
//
async function resolveTreasuryRouterAddress(
  provider: ethers.JsonRpcProvider,
  chain: ChainCfg
): Promise<string | null> {
  if (!chain.factoryAddress) return null;

  try {
    const factory = new ethers.Contract(chain.factoryAddress, LAUNCH_FACTORY_ABI, provider);
    const router = String(await factory.router());
    return /^0x[a-fA-F0-9]{40}$/.test(router) ? router.toLowerCase() : null;
  } catch (e) {
    console.warn("resolveTreasuryRouterAddress failed", { chainId: chain.chainId }, e);
    return null;
  }
}

async function scanRouterRange(
  provider: ethers.JsonRpcProvider,
  chain: ChainCfg,
  routerAddress: string,
  fromBlock: number,
  toBlock: number
) {
  const iface = new ethers.Interface(TREASURY_ROUTER_ABI);
  const routeFrag = iface.getEvent("RouteExecuted");
  if (!routeFrag) throw new Error("Event RouteExecuted not found in TREASURY_ROUTER_ABI");
  const routeTopic = routeFrag.topicHash;

  const cursor = "rewards-router";
  const step = ENV.LOG_CHUNK_SIZE;

  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = Math.min(toBlock, start + step - 1);

    const logs = await getLogsSafe(provider, {
      address: routerAddress,
      fromBlock: start,
      toBlock: end,
      topics: [routeTopic]
    });

    if (logs.length) {
      const blockNums = Array.from(new Set(logs.map((l) => l.blockNumber)));
      const blockTimes = new Map<number, Date>();
      for (const bn of blockNums) {
        const b = await provider.getBlock(bn);
        blockTimes.set(bn, new Date(Number(b?.timestamp || 0) * 1000));
      }

      logs.sort((a, b) => a.blockNumber - b.blockNumber || ((a.index ?? 0) - (b.index ?? 0)));

      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;

        const kind = Number((parsed.args as any).kind);
        const profile = Number((parsed.args as any).profile);
        const amountIn = (parsed.args as any).amountIn as bigint;
        const leagueAmount = (parsed.args as any).leagueAmount as bigint;
        const recruiterAmount = (parsed.args as any).recruiterAmount as bigint;
        const airdropAmount = (parsed.args as any).airdropAmount as bigint;
        const squadAmount = (parsed.args as any).squadAmount as bigint;
        const protocolAmount = (parsed.args as any).protocolAmount as bigint;

        await upsertRewardEvent({
          chainId: chain.chainId,
          txHash: log.transactionHash,
          logIndex: log.index ?? 0,
          blockNumber: log.blockNumber,
          occurredAt: blockTimes.get(log.blockNumber) || new Date(0),
          routeKind: kind === 1 ? "finalize" : "trade",
          routeProfile: profile === 2 ? "og_linked" : profile === 1 ? "standard_unlinked" : "standard_linked",
          leagueAmount,
          recruiterAmount,
          airdropAmount,
          squadAmount,
          protocolAmount,
          rawAmount: amountIn,
          sourceContract: routerAddress,
          sourceEvent: "RouteExecuted",
        });
      }
    }

    await setStateMax(chain.chainId, cursor, end + 1);
  }
}

async function syncFactoryCampaignsByCall(
  provider: ethers.JsonRpcProvider,
  chain: ChainCfg
) {
  if (!chain.factoryAddress) return;

  const factory = new ethers.Contract(chain.factoryAddress, LAUNCH_FACTORY_ABI, provider);

  let countBn: bigint;
  try {
    countBn = (await factory.campaignsCount()) as bigint;
  } catch (e) {
    console.warn("syncFactoryCampaignsByCall: campaignsCount failed", { chainId: chain.chainId }, e);
    return;
  }

  const count = Number(countBn);
  if (!Number.isFinite(count) || count <= 0) return;

  // Build a set of known campaigns (lowercased)
  const r = await pool.query(
    `select lower(campaign_address) as campaign
       from public.campaigns
      where chain_id=$1`,
    [chain.chainId]
  );
  const known = new Set<string>(r.rows.map((x) => String(x.campaign)));

  for (let i = 0; i < count; i++) {
    let info: any;
    try {
      info = await factory.getCampaign(i);
    } catch (e) {
      // Skip invalid ids rather than failing the whole sync
      continue;
    }

    const campaign = String(info?.campaign ?? info?.[0] ?? "").trim();
    if (!campaign || campaign === ethers.ZeroAddress) continue;

    const key = campaign.toLowerCase();

    const token = String(info?.token ?? info?.[1] ?? "").trim();
    const creator = String(info?.creator ?? info?.[2] ?? "").trim();
    const name = String(info?.name ?? info?.[3] ?? "").trim();
    const symbol = String(info?.symbol ?? info?.[4] ?? "").trim();
    const logoURI = String(info?.logoURI ?? info?.logoUri ?? info?.[5] ?? "").trim();

    const createdAtRaw = info?.createdAt ?? info?.[9];
    const createdAtSec = createdAtRaw !== undefined && createdAtRaw !== null ? Number(createdAtRaw) : 0;
    const createdAt = createdAtSec > 0 ? new Date(createdAtSec * 1000) : null;

    await upsertCampaign(chain.chainId, chain.factoryAddress ?? null, campaign, token, creator, name, symbol, 0, createdAt, logoURI || null);
    const wasKnown = known.has(key);
    known.add(key);

    console.log(wasKnown ? "Refreshed campaign via factory registry" : "Discovered missing campaign via factory registry", {
      chainId: chain.chainId,
      id: i,
      campaign: key
    });
  }
}

async function scanCampaignRange(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  campaign: string,
  fromBlock: number,
  toBlock: number,
  opts: { advanceCursor?: boolean; label?: string; tradesOnly?: boolean; deadlineMs?: number } = {}
) {
  const advanceCursor = opts.advanceCursor !== false;
  const tradesOnly = opts.tradesOnly === true || opts.label === "tip";
  const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);

  const buyFrag = iface.getEvent("TokensPurchased");
  const sellFrag = iface.getEvent("TokensSold");
  const finFrag = iface.getEvent("CampaignFinalized");
  if (!buyFrag || !sellFrag || !finFrag) throw new Error("Missing TokensPurchased/TokensSold/CampaignFinalized in LAUNCH_CAMPAIGN_ABI");

  const buyTopic = buyFrag.topicHash;
  const sellTopic = sellFrag.topicHash;
  const finTopic = finFrag.topicHash;

  const cursor = `campaign:${campaign.toLowerCase()}`;
  // Tip scans stay small/fast so every campaign gets live trades each tick.
  const step = tradesOnly
    ? Math.max(50, Math.min(ENV.LOG_CHUNK_SIZE, 500))
    : Math.max(50, ENV.LOG_CHUNK_SIZE);
  const blockTimeCache = new Map<number, number>();
  const campaignInfo = await getCampaignInfo(chainId, campaign);
  const tokenAddr = campaignInfo?.tokenAddress ?? null;
  let insertedTotal = 0;
  const startedAt = Date.now();

  // Best-effort: hydrate campaign feeRecipient for anti-abuse checks (Largest Buys).
  // Skip on tip scans — latency-sensitive path for live TokenDetails trades.
  if (!tradesOnly) {
    try {
      const rr = await pool.query(
        `select fee_recipient_address from public.campaigns where chain_id=$1 and campaign_address=$2`,
        [chainId, campaign.toLowerCase()]
      );
      const existing = rr.rows?.[0]?.fee_recipient_address ? String(rr.rows[0].fee_recipient_address) : "";
      if (!existing) {
        const c = new ethers.Contract(campaign, LAUNCH_CAMPAIGN_ABI, provider);
        const fr = String(await c.feeRecipient());
        if (/^0x[a-fA-F0-9]{40}$/.test(fr)) {
          await setCampaignFeeRecipient(chainId, campaign, fr);
        }
      }
    } catch {
      // ignore
    }
  }

  const chunks = campaignScanChunks(fromBlock, toBlock, step, tradesOnly);
  for (const chunk of chunks) {
    const start = chunk.start;
    const end = chunk.end;
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
      console.warn("[indexer] campaign scan hit pass deadline", {
        chainId,
        campaign: campaign.toLowerCase(),
        label: opts.label || "history",
        atBlock: start,
        toBlock,
        newestFirst: tradesOnly,
      });
      break;
    }

    // Tip may skip a dead chunk (advanceCursor is false there). History must
    // not: a soft-fail + cursor bump is how WIC lost the 2-day fills.
    let logs: ethers.Log[];
    if (tradesOnly) {
      const buyLogs = await getLogsSafe(
        provider,
        { address: campaign, fromBlock: start, toBlock: end, topics: [buyTopic] },
        0,
        { skipDelay: true, softFail: true }
      );
      const sellLogs = await getLogsSafe(
        provider,
        { address: campaign, fromBlock: start, toBlock: end, topics: [sellTopic] },
        0,
        { skipDelay: true, softFail: true }
      );
      logs = buyLogs.concat(sellLogs);
    } else {
      logs = await getLogsSafe(
        provider,
        {
          address: campaign,
          fromBlock: start,
          toBlock: end,
          topics: [[buyTopic, sellTopic, finTopic]],
        },
        0,
        { softFail: false }
      );
    }

    logs.sort((a, b) => a.blockNumber - b.blockNumber || ((a.index ?? 0) - (b.index ?? 0)));

    for (const log of logs) {
      const txHash = log.transactionHash;
      if (!txHash) continue;

      let tsSec = blockTimeCache.get(log.blockNumber);
      if (!tsSec) {
        const blk = await provider.getBlock(log.blockNumber);
        tsSec = Number(blk?.timestamp ?? Math.floor(Date.now() / 1000));
        blockTimeCache.set(log.blockNumber, tsSec);
      }

      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const name = parsed.name;
      const logIndex = log.index ?? 0;

      if (name === "TokensPurchased") {
        const buyer = String((parsed.args as any).buyer);
        const amountOut = (parsed.args as any).amountOut as bigint;
        const cost = (parsed.args as any).cost as bigint;

        const { inserted, tokenAmount, bnbAmount, priceBnb } = await insertTrade({
          chainId,
          campaign,
          txHash,
          logIndex,
          blockNumber: log.blockNumber,
          blockTime: new Date(tsSec * 1000),
          side: "buy",
          wallet: buyer,
          tokenRaw: amountOut,
          bnbRaw: cost
        });

        if (inserted) {
          insertedTotal += 1;
          leagueFeed.queueRaisedDelta(chainId, campaign, bnbAmount);
          // Do not await Ably — a slow realtime fanout must not block trade DB writes.
          void publishTrade(chainId, campaign, {
            type: "trade",
            chainId,
            token: campaign.toLowerCase(),
            txHash,
            logIndex,
            side: "buy",
            wallet: buyer.toLowerCase(),
            tokenAmountRaw: amountOut.toString(),
            bnbAmountRaw: cost.toString(),
            tokenAmount: String(tokenAmount),
            bnbAmount: String(bnbAmount),
            priceBnb: priceBnb !== null ? String(priceBnb) : null,
            ts: tsSec,
            blockNumber: log.blockNumber
          }).catch(() => undefined);

          void insertActivityEvent({
            chainId,
            eventType: "BUY",
            txHash,
            logIndex,
            blockNumber: log.blockNumber,
            blockTime: new Date(tsSec * 1000),
            actor: buyer,
            campaign,
            token: tokenAddr,
            amountInWei: cost,
            amountOutWei: amountOut,
            costWei: cost,
            meta: { priceBnb },
          }).catch(() => undefined);

          if (priceBnb !== null) {
            for (const tf of TIMEFRAMES) {
              const b = bucketStart(tsSec, tf);
              await upsertCandle(chainId, campaign, tf, b, priceBnb, bnbAmount, log.blockNumber, logIndex);
            }
          }
        }
      } else if (name === "TokensSold") {
        const seller = String((parsed.args as any).seller);
        const amountIn = (parsed.args as any).amountIn as bigint;
        const payout = (parsed.args as any).payout as bigint;

        const { inserted, tokenAmount, bnbAmount, priceBnb } = await insertTrade({
          chainId,
          campaign,
          txHash,
          logIndex,
          blockNumber: log.blockNumber,
          blockTime: new Date(tsSec * 1000),
          side: "sell",
          wallet: seller,
          tokenRaw: amountIn,
          bnbRaw: payout
        });

        if (inserted) {
          insertedTotal += 1;
          // Home feed progress: sells subtract from raisedTotalBnb
          leagueFeed.queueRaisedDelta(chainId, campaign, -bnbAmount);

          void publishTrade(chainId, campaign, {
            type: "trade",
            chainId,
            token: campaign.toLowerCase(),
            txHash,
            logIndex,
            side: "sell",
            wallet: seller.toLowerCase(),
            tokenAmountRaw: amountIn.toString(),
            bnbAmountRaw: payout.toString(),
            tokenAmount: String(tokenAmount),
            bnbAmount: String(bnbAmount),
            priceBnb: priceBnb !== null ? String(priceBnb) : null,
            ts: tsSec,
            blockNumber: log.blockNumber
          }).catch(() => undefined);

          void insertActivityEvent({
            chainId,
            eventType: "SELL",
            txHash,
            logIndex,
            blockNumber: log.blockNumber,
            blockTime: new Date(tsSec * 1000),
            actor: seller,
            campaign,
            token: tokenAddr,
            amountInWei: amountIn,
            amountOutWei: payout,
            payoutWei: payout,
            meta: { priceBnb },
          }).catch(() => undefined);

          if (priceBnb !== null) {
            for (const tf of TIMEFRAMES) {
              const b = bucketStart(tsSec, tf);
              await upsertCandle(chainId, campaign, tf, b, priceBnb, bnbAmount, log.blockNumber, logIndex);
            }
          }
        }
      } else if (name === "CampaignFinalized") {
        const caller = String((parsed.args as any).caller ?? "");
        const liquidityTokens = (parsed.args as any).liquidityTokens as bigint;
        const liquidityBnb = (parsed.args as any).liquidityBnb as bigint;
        const protocolFee = (parsed.args as any).protocolFee as bigint;
        const creatorPayout = (parsed.args as any).creatorPayout as bigint;

        await insertActivityEvent({
          chainId,
          eventType: "FINALIZE",
          txHash,
          logIndex,
          blockNumber: log.blockNumber,
          blockTime: new Date(tsSec * 1000),
          actor: caller || campaign,
          campaign,
          token: tokenAddr,
          meta: {
            liquidityTokens: liquidityTokens?.toString?.() ?? null,
            liquidityBnb: liquidityBnb?.toString?.() ?? null,
            protocolFee: protocolFee?.toString?.() ?? null,
            creatorPayout: creatorPayout?.toString?.() ?? null,
          },
        });

        // Graduation marker for league categories
        await setCampaignGraduated(chainId, campaign, log.blockNumber, new Date(tsSec * 1000), txHash);
        leagueFeed.queueGraduation(chainId, campaign, new Date(tsSec * 1000).toISOString());
      }
    }

    if (advanceCursor) {
      await setStateMax(chainId, cursor, end + 1);
    }
    if (logs.length > 0) await patchStats(chainId, campaign);
  }

  if (insertedTotal > 0 || opts.label) {
    console.log("[indexer] campaign scan done", {
      chainId,
      campaign: campaign.toLowerCase(),
      label: opts.label || "history",
      fromBlock,
      toBlock,
      inserted: insertedTotal,
      advanceCursor,
      durationMs: Date.now() - startedAt,
    });
  }
}

function parseTradeLog(
  iface: ethers.Interface,
  log: ethers.Log
): null | {
  side: "buy" | "sell";
  wallet: string;
  tokenRaw: bigint;
  bnbRaw: bigint;
} {
  const parsed = iface.parseLog(log);
  if (!parsed) return null;

  if (parsed.name === "TokensPurchased") {
    return {
      side: "buy",
      wallet: String((parsed.args as any).buyer),
      tokenRaw: (parsed.args as any).amountOut as bigint,
      bnbRaw: (parsed.args as any).cost as bigint,
    };
  }

  if (parsed.name === "TokensSold") {
    return {
      side: "sell",
      wallet: String((parsed.args as any).seller),
      tokenRaw: (parsed.args as any).amountIn as bigint,
      bnbRaw: (parsed.args as any).payout as bigint,
    };
  }

  return null;
}

function providerForChain(chain: ChainCfg): ethers.JsonRpcProvider {
  const rpcList = parseRpcList(chain.rpcHttp);
  if (rpcList.length === 0) {
    throw new Error(`No RPC URLs configured for chain ${chain.chainId}`);
  }
  return createStaticJsonRpcProvider(rpcList[0], chain.chainId, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
}

export async function ingestCampaignTransaction(input: {
  chainId: number;
  campaignAddress: string;
  txHash: string;
}) {
  const chain = CHAINS.find((c) => c.chainId === Number(input.chainId));
  if (!chain) throw new Error(`Unsupported chainId: ${input.chainId}`);

  const campaign = String(input.campaignAddress || "").trim().toLowerCase();
  const txHash = String(input.txHash || "").trim().toLowerCase();
  if (!ethers.isAddress(campaign)) throw new Error("Invalid campaign address");
  if (!/^0x[a-f0-9]{64}$/i.test(txHash)) throw new Error("Invalid tx hash");

  const known = await listScannableCampaigns(chain.chainId, campaign);
  if (!known.length) {
    throw new Error("Campaign is not known or active in the indexer database");
  }

  const provider = providerForChain(chain);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction receipt not found");
  if (receipt.status === 0) throw new Error("Transaction reverted; nothing to ingest");

  const block = await provider.getBlock(receipt.blockNumber);
  const tsSec = Number(block?.timestamp ?? Math.floor(Date.now() / 1000));
  const blockTime = new Date(tsSec * 1000);
  const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
  const campaignInfo = await getCampaignInfo(chain.chainId, campaign);
  const tokenAddr = campaignInfo?.tokenAddress ?? null;
  const ingested: Array<{
    side: "buy" | "sell";
    wallet: string;
    tokenAmount: string;
    bnbAmount: string;
    priceBnb: string | null;
    txHash: string;
    logIndex: number;
    blockNumber: number;
  }> = [];

  for (const log of receipt.logs) {
    if (String(log.address || "").toLowerCase() !== campaign) continue;

    let trade: ReturnType<typeof parseTradeLog>;
    try {
      trade = parseTradeLog(iface, log);
    } catch {
      continue;
    }
    if (!trade) continue;

    const logIndex = Number(log.index ?? 0);
    const { inserted, tokenAmount, bnbAmount, priceBnb } = await insertTrade({
      chainId: chain.chainId,
      campaign,
      txHash,
      logIndex,
      blockNumber: Number(receipt.blockNumber),
      blockTime,
      side: trade.side,
      wallet: trade.wallet,
      tokenRaw: trade.tokenRaw,
      bnbRaw: trade.bnbRaw,
    });

    if (inserted) {
      leagueFeed.queueRaisedDelta(
        chain.chainId,
        campaign,
        trade.side === "sell" ? -bnbAmount : bnbAmount,
      );

      await publishTrade(chain.chainId, campaign, {
        type: "trade",
        chainId: chain.chainId,
        token: campaign,
        txHash,
        logIndex,
        side: trade.side,
        wallet: trade.wallet.toLowerCase(),
        tokenAmountRaw: trade.tokenRaw.toString(),
        bnbAmountRaw: trade.bnbRaw.toString(),
        tokenAmount: String(tokenAmount),
        bnbAmount: String(bnbAmount),
        priceBnb: priceBnb !== null ? String(priceBnb) : null,
        ts: tsSec,
        blockNumber: Number(receipt.blockNumber)
      });

      await insertActivityEvent({
        chainId: chain.chainId,
        eventType: trade.side === "sell" ? "SELL" : "BUY",
        txHash,
        logIndex,
        blockNumber: Number(receipt.blockNumber),
        blockTime,
        actor: trade.wallet,
        campaign,
        token: tokenAddr,
        amountInWei: trade.side === "sell" ? trade.tokenRaw : trade.bnbRaw,
        amountOutWei: trade.side === "sell" ? trade.bnbRaw : trade.tokenRaw,
        costWei: trade.side === "buy" ? trade.bnbRaw : null,
        payoutWei: trade.side === "sell" ? trade.bnbRaw : null,
        meta: { priceBnb },
      });

      if (priceBnb !== null) {
        for (const tf of TIMEFRAMES) {
          const b = bucketStart(tsSec, tf);
          await upsertCandle(chain.chainId, campaign, tf, b, priceBnb, bnbAmount, Number(receipt.blockNumber), logIndex);
        }
      }
    }

    ingested.push({
      side: trade.side,
      wallet: trade.wallet.toLowerCase(),
      tokenAmount: String(tokenAmount),
      bnbAmount: String(bnbAmount),
      priceBnb: priceBnb !== null ? String(priceBnb) : null,
      txHash,
      logIndex,
      blockNumber: Number(receipt.blockNumber),
    });
  }

  if (ingested.length > 0) {
    await patchStats(chain.chainId, campaign);
  }

  return {
    ok: true,
    chainId: chain.chainId,
    campaign,
    txHash,
    blockNumber: Number(receipt.blockNumber),
    ingestedCount: ingested.length,
    trades: ingested,
  };
}

function computeStartBlock(chain: ChainCfg, headTarget: number, existingState: number): number {
  // Priority:
  //  1) If state is already set, use it
  //  2) Else use configured factoryStartBlock (if set)
  //  3) Else fallback to headTarget - lookback
  if (existingState > 0) return existingState;
  if ((chain.factoryStartBlock ?? 0) > 0) return Number(chain.factoryStartBlock);
  return Math.max(0, headTarget - ENV.FACTORY_LOOKBACK_BLOCKS);
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export async function runIndexerOnce() {
  // Always-on trade loop: campaigns only. Factory discovery has its own interval
  // (factoryDiscovery.ts). Even INDEXER_NORMAL_SCOPE=core used to mean
  // "factory+campaigns" and starved tip scans on every tick — map core → campaigns.
  // Explicit full/factory still available for repair/ops.
  const scope = ENV.INDEXER_NORMAL_SCOPE === "full"
    ? "full"
    : ENV.INDEXER_NORMAL_SCOPE === "factory"
    ? "factory"
    : "campaigns";

  // Hard wall-clock budget so a slow getLogs cannot hold the loop lock forever.
  // Tip phase runs first inside this budget.
  const deadlineMs = Date.now() + Math.max(20_000, Math.min(ENV.INDEXER_STALE_AFTER_MS - 5_000, 75_000));

  await runIndexerCore({
    mode: "normal",
    lookbackBlocks: ENV.FACTORY_LOOKBACK_BLOCKS,
    rewindBlocks: 0,
    scope,
    deadlineMs,
  });
}

/**
 * Fast concurrent path: only recent TokensPurchased/TokensSold for active campaigns.
 * Uses publicnode first (recent eth_getLogs works there) with a hard deadline so it
 * never contends with the slow history backfill lock.
 */
export async function runTipScanOnce() {
  // Cap tip-only at 20k so the concurrent loop stays under ~20s on publicnode.
  const tipScanBlocks = Math.max(3_000, Math.min(ENV.INDEXER_TIP_SCAN_BLOCKS || 20_000, 20_000));
  const deadlineMs = Date.now() + 25_000;

  for (const chain of CHAINS) {
    if (Date.now() >= deadlineMs) break;
    const rpcList = parseRpcList(chain.rpcHttp);
    const tipRpcList = Array.from(
      new Set([
        ...(chain.chainId === 97 ? ["https://bsc-testnet.publicnode.com"] : []),
        ...rpcList,
      ])
    );
    if (!tipRpcList.length) continue;

    let head = 0;
    let headProvider: ethers.JsonRpcProvider | null = null;
    for (const url of tipRpcList) {
      try {
        const p = createStaticJsonRpcProvider(url, chain.chainId, { timeoutMs: 8_000 });
        head = await p.getBlockNumber();
        headProvider = p;
        break;
      } catch {
        // try next
      }
    }
    if (!headProvider || head <= 0) continue;

    const target = Math.max(0, head - ENV.CONFIRMATIONS);
    const tipFrom = Math.max(0, target - tipScanBlocks);
    let campaigns: Array<{ campaign: string; createdBlock: number; tradeCount: number }> = [];
    try {
      campaigns = await listScannableCampaigns(chain.chainId);
    } catch (e) {
      console.error("[indexer] tip-only list campaigns failed", e);
      continue;
    }

    console.log("[indexer] tip-only pass", {
      chainId: chain.chainId,
      campaigns: campaigns.length,
      tipFrom,
      target,
    });

    for (const c of campaigns) {
      if (Date.now() >= deadlineMs) break;
      await snapStaleCampaignCursor(chain.chainId, c.campaign, head, tipScanBlocks);
      const campaignDeadline = Math.min(deadlineMs, Date.now() + 7_000);
      for (const tipUrl of tipRpcList) {
        try {
          const tipProvider = createStaticJsonRpcProvider(tipUrl, chain.chainId, { timeoutMs: 8_000 });
          await scanCampaignRange(tipProvider, chain.chainId, c.campaign, tipFrom, target, {
            advanceCursor: false,
            label: "tip-only",
            tradesOnly: true,
            deadlineMs: campaignDeadline,
          });
          break;
        } catch (err) {
          console.warn("[indexer] tip-only endpoint failed", {
            campaign: c.campaign.toLowerCase(),
            err: String((err as any)?.message || err),
          });
        }
      }
    }
  }
}

// Runs a bounded repair window: rewinds per-cursor state and replays recent logs.
export async function runRepairOnce() {
  await runIndexerCore({
    mode: "repair",
    lookbackBlocks: ENV.REPAIR_LOOKBACK_BLOCKS,
    rewindBlocks: ENV.REPAIR_REWIND_BLOCKS,
    scope: "full"
  });
}

// Focused recovery for TokenDetails chart/trade data. This skips factory/vote/
// reward-route event scans and only repairs LaunchCampaign trade/finalize logs
// for campaigns already discovered in the DB.
export async function runTradeRepairOnce(campaignAddress?: string, range?: { fromBlock?: number; toBlock?: number }) {
  await runIndexerCore({
    mode: "repair",
    lookbackBlocks: ENV.REPAIR_LOOKBACK_BLOCKS,
    rewindBlocks: ENV.REPAIR_REWIND_BLOCKS,
    scope: "campaigns",
    campaignAddress,
    forceCampaignStart: Boolean(campaignAddress),
    fromBlock: range?.fromBlock,
    toBlock: range?.toBlock
  });
}

// Lightweight operator recovery: refresh factory-created campaigns without
// waiting behind expensive per-campaign log scans. This is safe to run when the
// full scanner is wedged on an RPC range because it only performs factory calls
// and a bounded factory event scan.
export async function runDiscoveryOnce() {
  await runIndexerCore({
    mode: "normal",
    lookbackBlocks: ENV.FACTORY_LOOKBACK_BLOCKS,
    rewindBlocks: 0,
    scope: "factory"
  });
}

type IndexerScope = "full" | "core" | "factory" | "campaigns";

async function runIndexerCore(opts: {
  mode: "normal" | "repair";
  lookbackBlocks: number;
  rewindBlocks: number;
  scope: IndexerScope;
  campaignAddress?: string;
  forceCampaignStart?: boolean;
  fromBlock?: number;
  toBlock?: number;
  deadlineMs?: number;
}) {
  const deadlineMs = Number(opts.deadlineMs || 0);
  const pastDeadline = () => deadlineMs > 0 && Date.now() >= deadlineMs;

  for (const chain of CHAINS) {
    if (pastDeadline()) {
      console.warn("[indexer] pass deadline before chain work", { chainId: chain.chainId });
      break;
    }
    const rpcList = parseRpcList(chain.rpcHttp);
    if (rpcList.length === 0) {
      console.error("No RPC URLs configured for chain", chain.chainId);
      continue;
    }

    let rpcIdx = 0;

    const makeProvider = () =>
      createStaticJsonRpcProvider(rpcList[rpcIdx], chain.chainId, {
        // Bound timeouts so a dead free-tier URL cannot pile AggregateError / TIMEOUT loops.
        timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
      });

    const rotate = () => {
      rpcIdx = (rpcIdx + 1) % rpcList.length;
    };

    const withProviderRetry = async <T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T> => {
      let lastErr: any;

      // Try up to 2 full rotations when multiple endpoints exist. With a
      // single endpoint, do not "rotate" back into the same rate-limited URL.
      const maxAttempts = rpcList.length > 1 ? rpcList.length * 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const p = makeProvider();
        const url = rpcList[rpcIdx];

        try {
          return await fn(p);
        } catch (e: any) {
          lastErr = e;

          if (isRateLimitError(e) || isRpcTransportError(e) || isPrunedHistoryError(e)) {
            console.warn(rpcList.length > 1 ? "RPC error; rotating endpoint" : "RPC error; single endpoint exhausted", {
              chainId: chain.chainId,
              rpc: url,
              err: e?.shortMessage || e?.message || e
            });

            if (attempt + 1 < maxAttempts) {
              rotate();
              await sleep(500 + Math.floor(Math.random() * 500));
              continue;
            }
          }

          // Non-transient error: bubble up
          throw e;
        }
      }

      throw lastErr;
    };

    // Compute scanning head for this pass
    const head = await withProviderRetry((p) => p.getBlockNumber());
    const requestedToBlock = Number(opts.toBlock || 0);
    const target = requestedToBlock > 0
      ? Math.min(requestedToBlock, Math.max(0, head - ENV.CONFIRMATIONS))
      : Math.max(0, head - ENV.CONFIRMATIONS);
    const deploymentFloor = Number(chain.factoryStartBlock || 0);
    if (deploymentFloor > 0 && target < deploymentFloor) {
      console.warn("Indexer RPC head is behind configured factory start block; skipping scans", {
        chainId: chain.chainId,
        head,
        target,
        factoryStartBlock: deploymentFloor,
        factoryAddress: chain.factoryAddress ? chain.factoryAddress.toLowerCase() : null
      });
      continue;
    }

    if (opts.scope !== "campaigns") {
      // ---------------- Factory scan ----------------
      try {
        // Deterministic discovery: pull campaigns directly from the factory registry
        await withProviderRetry((p) => syncFactoryCampaignsByCall(p, chain));

        if (opts.scope === "full") {
          const cursor = "factory";
          const state = await getState(chain.chainId, cursor);
          const baselineStart = computeStartBlock(chain, target, state);
          const windowStart = Math.max(0, target - opts.lookbackBlocks);
          const from = opts.mode === "repair"
            ? Math.max(windowStart, Math.max(0, state - opts.rewindBlocks))
            : Math.max(baselineStart, windowStart);

          await withProviderRetry((p) => scanFactoryRange(p, chain, from, target));
        }
      } catch (e) {
        console.error("scanFactory error (all RPCs failed)", { chainId: chain.chainId }, e);
      }

      if (opts.scope === "factory") {
        continue;
      }
    }

    // ---------------- VoteTreasury scan ----------------
    // Featured row ranks by vote_aggregates. Votes must run on every trade-capable
    // pass (campaigns/core/full), not only INDEXER_NORMAL_SCOPE=full — otherwise
    // upvotes succeed on-chain but never appear in Featured (DDT clean-slate case).
    // (scope===factory already continued above.)
    try {
      if (chain.voteTreasuryAddress) {
        const state = await getState(chain.chainId, "votes");
        const tipBlocks = Math.max(3_000, ENV.INDEXER_TIP_SCAN_BLOCKS || 20_000);
        const histBlocks = Math.max(
          5_000,
          Math.min(opts.lookbackBlocks || 20_000, ENV.INDEXER_CAMPAIGN_BLOCKS_PER_PASS || 8_000),
        );
        const startHint = chain.voteTreasuryStartBlock || 0;

        // Always re-scan a tip window every normal pass (idempotent inserts).
        // Flaky public RPCs can return empty eth_getLogs while the votes cursor
        // still advances — without overlap rescan, upvotes never enter Featured
        // (WIC VoteCast at tip missed while only DDT stayed in vote_aggregates).
        if (opts.mode === "normal") {
          const tipFrom = Math.max(0, target - tipBlocks);
          try {
            await withProviderRetry((p) => scanVoteTreasuryRange(p, chain, tipFrom, target));
          } catch (tipVoteErr) {
            console.warn("[indexer] vote tip scan failed", {
              chainId: chain.chainId,
              err: String((tipVoteErr as any)?.message || tipVoteErr),
            });
          }
        }

        let from = opts.mode === "repair"
          ? Math.max(0, Math.max(0, state - opts.rewindBlocks))
          : state > 0
            ? state
            : (startHint > 0 ? startHint : Math.max(0, target - tipBlocks));

        // Bound work per pass so votes cannot monopolize the lock.
        let passTarget = target;
        if (opts.mode === "normal") {
          passTarget = Math.min(target, from + histBlocks - 1);
        } else {
          const windowStart = Math.max(0, target - opts.lookbackBlocks);
          from = Math.max(windowStart, from);
        }

        if (from <= passTarget) {
          await withProviderRetry((p) => scanVoteTreasuryRange(p, chain, from, passTarget));
        }
      }
    } catch (e) {
      console.error("scanVoteTreasury error (all RPCs failed)", { chainId: chain.chainId }, e);
    }

    // ---------------- Campaign scans ----------------
    let campaigns: Array<{ campaign: string; createdBlock: number; tradeCount: number }> = [];
    try {
      campaigns = await listScannableCampaigns(chain.chainId, opts.campaignAddress);
    } catch (e) {
      console.error("listActiveCampaigns error", { chainId: chain.chainId }, e);
      continue;
    }

    const blocksPerPass = Math.max(500, ENV.INDEXER_CAMPAIGN_BLOCKS_PER_PASS || 8000);
    const tipScanBlocks = Math.max(0, ENV.INDEXER_TIP_SCAN_BLOCKS || 0);

    // Prefer empty-history campaigns first so AWTT/WIC rewinds are not starved by
    // TTA catch-up after every tip pass.
    campaigns = [...campaigns].sort((a, b) => {
      if (a.tradeCount === 0 && b.tradeCount > 0) return -1;
      if (a.tradeCount > 0 && b.tradeCount === 0) return 1;
      return 0;
    });

    console.log("[indexer] campaign pass", {
      chainId: chain.chainId,
      mode: opts.mode,
      scope: opts.scope,
      campaigns: campaigns.length,
      emptyHistory: campaigns.filter((c) => c.tradeCount === 0).length,
      target,
      blocksPerPass,
      tipScanBlocks,
    });

    // Phase A — tip scan ALL campaigns first so a slow history backfill on AWTT/WIC
    // cannot starve TTA (or any other) live trades for the whole stale window.
    // Prefer a public recent-log RPC as first tip endpoint: BlockPI often rate-limits
    // eth_getLogs while publicnode still serves the last few thousand blocks.
    if (opts.mode === "normal" && tipScanBlocks > 0) {
      const tipFrom = Math.max(0, target - tipScanBlocks);
      const tipRpcList = Array.from(
        new Set([
          ...(chain.chainId === 97 ? ["https://bsc-testnet.publicnode.com"] : []),
          ...rpcList,
        ])
      );
      for (const c of campaigns) {
        if (pastDeadline()) {
          console.warn("[indexer] pass deadline during tip phase", { chainId: chain.chainId });
          break;
        }
        const campaign = c.campaign;
        await snapStaleCampaignCursor(chain.chainId, campaign, target, tipScanBlocks);
        const campaignDeadline = Math.min(deadlineMs || Date.now() + 7_000, Date.now() + 7_000);
        let tipOk = false;
        for (const tipUrl of tipRpcList) {
          try {
            const tipProvider = createStaticJsonRpcProvider(tipUrl, chain.chainId, {
              timeoutMs: Math.min(ENV.RPC_REQUEST_TIMEOUT_MS, 15_000),
            });
            await scanCampaignRange(tipProvider, chain.chainId, campaign, tipFrom, target, {
              advanceCursor: false,
              label: "tip",
              tradesOnly: true,
              deadlineMs: campaignDeadline,
            });
            tipOk = true;
            break;
          } catch (tipErr) {
            console.warn("[indexer] tip scan endpoint failed", {
              chainId: chain.chainId,
              campaign: campaign.toLowerCase(),
              rpc: tipUrl.replace(/\/v1\/rpc\/.*/, "/v1/rpc/…"),
              err: String((tipErr as any)?.message || tipErr),
            });
          }
        }
        if (!tipOk) {
          console.warn("[indexer] tip scan failed all endpoints", {
            chainId: chain.chainId,
            campaign: campaign.toLowerCase(),
          });
        }
      }
    }

    // Phase B — historical catch-up (bounded per campaign).
    for (const c of campaigns) {
      if (pastDeadline()) {
        console.warn("[indexer] pass deadline during history phase", { chainId: chain.chainId });
        break;
      }
      const campaign = c.campaign;
      try {
        const cursor = `campaign:${campaign.toLowerCase()}`;
        let state = await getState(chain.chainId, cursor);
        const windowStart = Math.max(0, target - opts.lookbackBlocks);

        // Prefer a deterministic start block when we have no state yet.
        // This prevents "newly discovered" campaigns from missing older trades
        // that fall outside the rolling lookback window.
        const campaignStart = c.createdBlock && c.createdBlock > 0
          ? c.createdBlock
          : (chain.factoryStartBlock || 0);

        // Empty trade history + cursor far past created_block means getLogs advanced
        // without inserting (cleanup / prune / bad range). Rewind so bonding history
        // is re-scanned (AWTT/WIC after dual-factory cleanup).
        if (
          opts.mode === "normal" &&
          c.tradeCount === 0 &&
          campaignStart > 0 &&
          state > campaignStart + 100
        ) {
          const rewound = Math.max(0, campaignStart - 1);
          console.warn("[indexer] rewinding empty-trade cursor to created_block", {
            chainId: chain.chainId,
            campaign: campaign.toLowerCase(),
            from: state,
            to: rewound,
            campaignStart,
          });
          // setStateMax is max-only; force lower value for empty-history recovery.
          await pool.query(
            `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
             values ($1,$2,$3)
             on conflict (chain_id,cursor) do update
               set last_indexed_block = least(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
                   updated_at = now()`,
            [chain.chainId, cursor, rewound],
          );
          state = rewound;
        }

        // Historical catch-up. Critical rule: once we have a campaign cursor at or
        // after created_block, NEVER clamp forward to windowStart — that skips the
        // bonding window (WIC/AWTT) after cleanup rewinds. Cap range per pass so
        // one campaign cannot hold the global lock for 20+ minutes.
        let from: number;
        if (opts.mode === "repair") {
          from = opts.forceCampaignStart && campaignStart > 0
            ? Math.min(Math.max(0, state - opts.rewindBlocks), campaignStart)
            : Math.max(windowStart, Math.max(0, state - opts.rewindBlocks));
          if (opts.forceCampaignStart && campaignStart > 0) {
            from = Math.min(from, campaignStart);
          }
        } else if (state > 0) {
          // Continuous catch-up from cursor. Do not jump to windowStart.
          from = state;
          // Safety: if cursor is absurdly far below any known floor (corrupt),
          // re-seed at campaignStart / windowStart rather than replaying millions.
          const floor = campaignStart > 0 ? campaignStart : windowStart;
          if (floor > 0 && state + 1 < floor - 5) {
            from = floor;
          }
        } else {
          from = campaignStart > 0 ? campaignStart : windowStart;
        }

        const requestedFromBlock = Number(opts.fromBlock || 0);
        if (requestedFromBlock > 0) {
          from = Math.max(0, requestedFromBlock);
        }

        // Bound normal-mode work so every active campaign is visited each tick.
        // Campaigns that already have trades but lag the tip get a larger catch-up
        // window so TTA-style gaps close in one or two passes.
        let passTarget = target;
        if (opts.mode === "normal" && !requestedToBlock) {
          const lag = Math.max(0, target - from);
          const catchUp =
            c.tradeCount > 0 && lag > blocksPerPass
              ? Math.min(25_000, Math.max(blocksPerPass, Math.floor(lag / 2)))
              : blocksPerPass;
          passTarget = Math.min(target, from + catchUp - 1);
        }

        if (from > passTarget) {
          // Already caught up for this tip (or empty range).
          continue;
        }

        await withProviderRetry((p) =>
          scanCampaignRange(p, chain.chainId, campaign, from, passTarget, {
            advanceCursor: true,
            label: "history",
            deadlineMs: deadlineMs || undefined,
          })
        );
      } catch (e) {
        console.error("scanCampaign error (all RPCs failed)", { chainId: chain.chainId, campaign }, e);
      }
    }

    // ---------------- Reward routing scan ----------------
    if (opts.scope === "full") {
      try {
        const routerAddress = await withProviderRetry((p) => resolveTreasuryRouterAddress(p, chain));
        if (routerAddress) {
          const cursor = "rewards-router";
          const state = await getState(chain.chainId, cursor);
          const baselineStart = computeStartBlock(chain, target, state);
          const windowStart = Math.max(0, target - opts.lookbackBlocks);
          const from = opts.mode === "repair"
            ? Math.max(windowStart, Math.max(0, state - opts.rewindBlocks))
            : Math.max(baselineStart, windowStart);

          await withProviderRetry((p) => scanRouterRange(p, chain, routerAddress, from, target));
        }
      } catch (e) {
        console.error("scanRewardRoutes error (all RPCs failed)", { chainId: chain.chainId }, e);
      }
    }
  }
}

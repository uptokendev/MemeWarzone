/**
 * Generation selection and persistence for the EVM launch generation (factory 6 / campaign 5).
 *
 * Selection is per factory: a campaign is generation 5 when its factory answers CAMPAIGN_GENERATION() >= 5
 * (old mainnet factories answer 3/4, and a factory that does not answer is treated as old). The result is
 * written to campaigns.factory_generation / campaign_generation (migration 20260930_000001) so the
 * site and the keeper read it without RPC. EVM_GEN5_FACTORIES_<chainId> (comma list) forces the choice
 * for named factories without a call (gen-6: factory 6 / campaign 5); EVM_GEN7_FACTORIES_<chainId> does the
 * same for gen-7 factories (factory 7 / campaign 6), which otherwise answer 7 / 6 from their constants.
 *
 * Every generation-5 campaign event lands once in evm_campaign_events (idempotent on
 * chain/tx/log). evm_campaign_gen5_state is recomputed from those rows, never incremented, so a
 * rescan or a crash between two writes cannot double count a repair step or an escrow claim.
 */
import { ethers } from "ethers";
import { GEN5_CAMPAIGN_ABI, GEN5_CAMPAIGN_GENERATION, GEN6_FACTORY_ABI } from "./evmGen5Abi.js";
import { EVM_GEN7_CAMPAIGN_GENERATION, EVM_GEN7_FACTORY_GENERATION } from "./evmGen7Curve.js";
import type { Gen5TradeAnnotation } from "./evmGen5Trade.js";

export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type CampaignGenerationInfo = {
  campaign: string;
  factory: string | null;
  factoryGeneration: number | null;
  campaignGeneration: number | null;
  gen5: boolean;
  creator: string | null;
  launchAt: bigint | null;
  baseFeeBps: bigint | null;
};

const GENERATION_CACHE = new Map<string, CampaignGenerationInfo>();
const FACTORY_CACHE = new Map<string, { factoryGeneration: number | null; campaignGeneration: number | null }>();

export function clearGenerationCaches() {
  GENERATION_CACHE.clear();
  FACTORY_CACHE.clear();
}

function lower(value: unknown): string | null {
  const s = String(value ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

export function forcedGen5Factories(chainId: number, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = String(env[`EVM_GEN5_FACTORIES_${chainId}`] || "");
  return new Set(raw.split(",").map((a) => lower(a)).filter((a): a is string => Boolean(a)));
}

/** EVM_GEN7_FACTORIES_<chainId>: gen-7 factories named without a call (factory 7 / campaign 6). */
export function forcedGen7Factories(chainId: number, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = String(env[`EVM_GEN7_FACTORIES_${chainId}`] || "");
  return new Set(raw.split(",").map((a) => lower(a)).filter((a): a is string => Boolean(a)));
}

export function isGen5Generation(campaignGeneration: number | null | undefined): boolean {
  return Number(campaignGeneration || 0) >= GEN5_CAMPAIGN_GENERATION;
}

async function readFactoryGeneration(
  provider: ethers.Provider,
  factory: string,
): Promise<{ factoryGeneration: number | null; campaignGeneration: number | null }> {
  const cached = FACTORY_CACHE.get(factory);
  if (cached) return cached;
  const c = new ethers.Contract(factory, GEN6_FACTORY_ABI, provider) as any;
  let result: { factoryGeneration: number | null; campaignGeneration: number | null };
  try {
    const [f, cg] = await Promise.all([c.FACTORY_GENERATION(), c.CAMPAIGN_GENERATION()]);
    result = { factoryGeneration: Number(f), campaignGeneration: Number(cg) };
  } catch {
    // A factory without the constants predates generation numbering: old generation.
    result = { factoryGeneration: null, campaignGeneration: null };
  }
  FACTORY_CACHE.set(factory, result);
  return result;
}

/**
 * Resolve (and persist) the generation of one campaign. Returns the cached row when known. Any RPC
 * failure other than a missing constant throws, so the caller retries on the next pass instead of
 * indexing a generation-5 coin with the old rules.
 */
export async function resolveCampaignGeneration(
  db: Queryable,
  provider: ethers.Provider,
  chainId: number,
  campaignAddress: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CampaignGenerationInfo> {
  const campaign = campaignAddress.toLowerCase();
  const key = `${chainId}:${campaign}`;
  const hit = GENERATION_CACHE.get(key);
  if (hit) return hit;

  const r = await db.query(
    `select factory_address, creator_address, factory_generation, campaign_generation
       from public.campaigns where chain_id = $1 and campaign_address = $2`,
    [chainId, campaign],
  );
  const row = r.rows[0] || {};
  let factory = lower(row.factory_address);
  let factoryGeneration: number | null = row.factory_generation != null ? Number(row.factory_generation) : null;
  let campaignGeneration: number | null = row.campaign_generation != null ? Number(row.campaign_generation) : null;
  const campaignContract = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;

  if (campaignGeneration === null) {
    if (!factory) factory = lower(await campaignContract.factory());
    if (factory && forcedGen7Factories(chainId, env).has(factory)) {
      factoryGeneration = EVM_GEN7_FACTORY_GENERATION;
      campaignGeneration = EVM_GEN7_CAMPAIGN_GENERATION;
    } else if (factory && forcedGen5Factories(chainId, env).has(factory)) {
      factoryGeneration = 6;
      campaignGeneration = GEN5_CAMPAIGN_GENERATION;
    } else if (factory) {
      const g = await readFactoryGeneration(provider, factory);
      factoryGeneration = g.factoryGeneration;
      campaignGeneration = g.campaignGeneration;
    }
    if (campaignGeneration !== null) {
      await db.query(
        `update public.campaigns
            set factory_generation = coalesce(factory_generation, $3),
                campaign_generation = coalesce(campaign_generation, $4),
                factory_address = coalesce(factory_address, $5),
                updated_at = now()
          where chain_id = $1 and campaign_address = $2`,
        [chainId, campaign, factoryGeneration, campaignGeneration, factory],
      );
    }
  }

  const gen5 = isGen5Generation(campaignGeneration);
  let launchAt: bigint | null = null;
  let baseFeeBps: bigint | null = null;
  let creator = lower(row.creator_address);
  if (gen5) {
    const [la, fee, cr] = await Promise.all([
      campaignContract.launchAt(),
      campaignContract.protocolFeeBps(),
      creator ? Promise.resolve(creator) : campaignContract.creator(),
    ]);
    launchAt = BigInt(la);
    baseFeeBps = BigInt(fee);
    creator = lower(cr);
    await ensureGen5StateRow(db, provider, chainId, campaign, factory, factoryGeneration, campaignGeneration);
  }

  const info: CampaignGenerationInfo = {
    campaign,
    factory,
    factoryGeneration,
    campaignGeneration,
    gen5,
    creator,
    launchAt,
    baseFeeBps,
  };
  GENERATION_CACHE.set(key, info);
  return info;
}

/** First sight of a gen-5 campaign: the state row, its quote binding and the creator's fee choice. */
async function ensureGen5StateRow(
  db: Queryable,
  provider: ethers.Provider,
  chainId: number,
  campaign: string,
  factory: string | null,
  factoryGeneration: number | null,
  campaignGeneration: number | null,
) {
  let quoteToken: string | null = null;
  let feeVault: string | null = null;
  let feeChoice: number | null = null;
  let feeCreatorPct: number | null = null;
  try {
    const c = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, provider) as any;
    const q = lower(await c.graduationQuoteToken());
    quoteToken = q && q !== ethers.ZeroAddress.toLowerCase() ? q : null;
  } catch {
    // best effort; StockGraduationConfigured also sets it
  }
  if (factory) {
    try {
      const f = new ethers.Contract(factory, GEN6_FACTORY_ABI, provider) as any;
      const choice = await f.campaignFeeChoice(campaign);
      feeVault = lower(choice.vault ?? choice[0]);
      feeChoice = Number(choice.choice ?? choice[1]);
      feeCreatorPct = Number(choice.creatorPct ?? choice[2]);
    } catch {
      // best effort; CampaignFeeChoiceSet / the vault's CampaignChoiceSet also set it
    }
  }
  await db.query(
    `insert into public.evm_campaign_gen5_state(
        chain_id, campaign_address, factory_address, factory_generation, campaign_generation,
        quote_token, fee_vault, fee_choice, fee_creator_pct
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (chain_id, campaign_address) do update set
        factory_address = coalesce(public.evm_campaign_gen5_state.factory_address, excluded.factory_address),
        factory_generation = coalesce(public.evm_campaign_gen5_state.factory_generation, excluded.factory_generation),
        campaign_generation = coalesce(public.evm_campaign_gen5_state.campaign_generation, excluded.campaign_generation),
        quote_token = coalesce(public.evm_campaign_gen5_state.quote_token, excluded.quote_token),
        fee_vault = coalesce(public.evm_campaign_gen5_state.fee_vault, excluded.fee_vault),
        fee_choice = coalesce(public.evm_campaign_gen5_state.fee_choice, excluded.fee_choice),
        fee_creator_pct = coalesce(public.evm_campaign_gen5_state.fee_creator_pct, excluded.fee_creator_pct),
        updated_at = now()`,
    [chainId, campaign, factory, factoryGeneration, campaignGeneration, quoteToken, feeVault, feeChoice, feeCreatorPct],
  );
}

export function serializeEventArgs(fragment: ethers.EventFragment, args: ethers.Result): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  fragment.inputs.forEach((input, i) => {
    const value = args[i];
    const name = input.name || String(i);
    if (typeof value === "bigint") out[name] = value.toString();
    else if (typeof value === "boolean") out[name] = value;
    else if (typeof value === "string") out[name] = /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : value;
    else out[name] = String(value);
  });
  return out;
}

export type EvmContractKind = "campaign" | "factory" | "router" | "creator_vault" | "lp_locker";

export type EvmEventRow = {
  chainId: number;
  contractAddress: string;
  contractKind: EvmContractKind;
  campaignAddress: string | null;
  eventName: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date | null;
  args: Record<string, string | boolean>;
};

/** Insert once; returns true when the row is new. */
export async function recordEvmEvent(db: Queryable, row: EvmEventRow): Promise<boolean> {
  const r = await db.query(
    `insert into public.evm_campaign_events(
        chain_id, contract_address, contract_kind, campaign_address, event_name,
        tx_hash, log_index, block_number, block_time, args
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [
      row.chainId,
      row.contractAddress.toLowerCase(),
      row.contractKind,
      row.campaignAddress ? row.campaignAddress.toLowerCase() : null,
      row.eventName,
      row.txHash.toLowerCase(),
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      JSON.stringify(row.args),
    ],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

/** Writes the gen-5 trade fields onto the curve_trades row the indexer just upserted. */
export async function annotateCurveTrade(
  db: Queryable,
  chainId: number,
  txHash: string,
  logIndex: number,
  a: Gen5TradeAnnotation,
): Promise<void> {
  await db.query(
    `update public.curve_trades
        set fee_raw = $4, fee_bps = $5, gross_raw = $6, creator_buy_kind = $7, league_excluded = $8
      where chain_id = $1 and tx_hash = $2 and log_index = $3`,
    [
      chainId,
      txHash.toLowerCase(),
      logIndex,
      a.feeRaw !== null ? a.feeRaw.toString() : null,
      a.feeBps,
      a.grossRaw !== null ? a.grossRaw.toString() : null,
      a.creatorBuyKind,
      a.leagueExcluded,
    ],
  );
}

export async function setGen5FeeChoice(
  db: Queryable,
  chainId: number,
  campaign: string,
  choice: { vault: string | null; choice: number; creatorPct: number },
): Promise<void> {
  await db.query(
    `insert into public.evm_campaign_gen5_state(chain_id, campaign_address, fee_vault, fee_choice, fee_creator_pct)
     values ($1,$2,$3,$4,$5)
     on conflict (chain_id, campaign_address) do update set
        fee_vault = coalesce(excluded.fee_vault, public.evm_campaign_gen5_state.fee_vault),
        fee_choice = excluded.fee_choice,
        fee_creator_pct = excluded.fee_creator_pct,
        updated_at = now()`,
    [chainId, campaign.toLowerCase(), choice.vault ? choice.vault.toLowerCase() : null, choice.choice, choice.creatorPct],
  );
}

/**
 * Recompute a campaign's gen-5 state from its event rows. Idempotent: every figure is a sum or the
 * latest row, so running it twice, or after a rescan, gives the same answer.
 */
export const REFRESH_GEN5_STATE_SQL = `
with ev as (
  select * from public.evm_campaign_events
   where chain_id = $1 and campaign_address = $2 and contract_kind = 'campaign'
),
pend as (select * from ev where event_name = 'GraduationPending' order by block_number desc, log_index desc limit 1),
grad as (select * from ev where event_name = 'Graduated' order by block_number desc, log_index desc limit 1),
fb as (select * from ev where event_name = 'NativeFallbackCommitted' order by block_number desc, log_index desc limit 1),
fbuy as (select * from ev where event_name = 'CreatorFirstBuy' order by block_number, log_index limit 1),
stock as (select * from ev where event_name = 'StockGraduationConfigured' order by block_number desc, log_index desc limit 1),
agg as (
  select
    count(*) filter (where event_name = 'PoolRepairStep')::int as repair_steps,
    coalesce(sum((args->>'memeSold')::numeric) filter (where event_name = 'PoolRepairStep'), 0) as repair_meme_sold,
    coalesce(sum((args->>'proceeds')::numeric) filter (where event_name = 'PoolRepairStep'), 0) as repair_proceeds,
    coalesce(sum((args->>'amount')::numeric) filter (where event_name = 'ProtocolGraduationFeeEscrowed'), 0) as fee_escrowed,
    coalesce(sum((args->>'amount')::numeric) filter (where event_name = 'ProtocolGraduationFeeFlushed'), 0) as fee_flushed,
    coalesce(sum((args->>'nativeAmount')::numeric) filter (where event_name = 'CreatorGraduationClaimed'), 0) as grad_claimed_native,
    coalesce(sum((args->>'quoteAmount')::numeric) filter (where event_name = 'CreatorGraduationClaimed'), 0) as grad_claimed_quote,
    coalesce(sum((args->>'amount')::numeric) filter (where event_name = 'CreatorBuyEscrowed'), 0) as escrow_total,
    coalesce(sum((args->>'amount')::numeric) filter (where event_name = 'CreatorEscrowClaimed'), 0) as escrow_claimed,
    max(block_number) as last_block
  from ev
)
insert into public.evm_campaign_gen5_state as s (
  chain_id, campaign_address, graduation_stage,
  pending_trigger, pending_since, pending_block, pending_raise_raw, pending_native_target_raw, pending_last_price_raw,
  graduated_pool, graduated_block, graduated_at, graduated_tx,
  graduation_raise_raw, protocol_share_raw, creator_share_raw, pool_native_raw, meme_used_raw, meme_burned_raw,
  curve_price_raw, start_price_raw, repaired,
  repair_steps, repair_meme_sold_raw, repair_proceeds_raw,
  native_fallback, native_fallback_adapter, fallback_quote_held_raw, fallback_quote_meme_sold_raw,
  protocol_fee_escrowed_raw, protocol_fee_flushed_raw,
  creator_graduation_claimed_native_raw, creator_graduation_claimed_quote_raw,
  creator_first_buy_tokens_raw, creator_first_buy_cost_raw, creator_first_buy_fee_raw,
  escrow_total_raw, escrow_claimed_raw, quote_token, last_event_block, updated_at
)
select
  $1, $2,
  case when exists (select 1 from grad) then 'graduated' when exists (select 1 from pend) then 'pending' else 'trading' end,
  (select (args->>'trigger')::smallint from pend),
  (select block_time from pend),
  (select block_number from pend),
  (select (args->>'raise')::numeric from pend),
  (select (args->>'nativeTarget')::numeric from pend),
  (select (args->>'lastPrice')::numeric from pend),
  (select args->>'pool' from grad),
  (select block_number from grad),
  (select block_time from grad),
  (select tx_hash from grad),
  (select (args->>'raise')::numeric from grad),
  (select (args->>'protocolShare')::numeric from grad),
  (select (args->>'creatorShare')::numeric from grad),
  (select (args->>'poolNative')::numeric from grad),
  (select (args->>'memeUsed')::numeric from grad),
  (select (args->>'memeBurned')::numeric from grad),
  (select (args->>'curvePrice')::numeric from grad),
  (select (args->>'startPrice')::numeric from grad),
  (select (args->>'repaired')::boolean from grad),
  agg.repair_steps, agg.repair_meme_sold, agg.repair_proceeds,
  exists (select 1 from fb),
  (select args->>'nativeAdapter' from fb),
  (select (args->>'quoteHeldToCreator')::numeric from fb),
  (select (args->>'quoteRepairMemeSold')::numeric from fb),
  agg.fee_escrowed, agg.fee_flushed,
  agg.grad_claimed_native, agg.grad_claimed_quote,
  (select (args->>'amountOut')::numeric from fbuy),
  (select (args->>'costNoFee')::numeric from fbuy),
  (select (args->>'fee')::numeric from fbuy),
  agg.escrow_total, agg.escrow_claimed,
  coalesce((select args->>'quoteToken' from stock), (select args->>'quoteToken' from fb)),
  agg.last_block, now()
from agg
on conflict (chain_id, campaign_address) do update set
  graduation_stage = excluded.graduation_stage,
  pending_trigger = excluded.pending_trigger,
  pending_since = excluded.pending_since,
  pending_block = excluded.pending_block,
  pending_raise_raw = excluded.pending_raise_raw,
  pending_native_target_raw = excluded.pending_native_target_raw,
  pending_last_price_raw = excluded.pending_last_price_raw,
  graduated_pool = excluded.graduated_pool,
  graduated_block = excluded.graduated_block,
  graduated_at = excluded.graduated_at,
  graduated_tx = excluded.graduated_tx,
  graduation_raise_raw = excluded.graduation_raise_raw,
  protocol_share_raw = excluded.protocol_share_raw,
  creator_share_raw = excluded.creator_share_raw,
  pool_native_raw = excluded.pool_native_raw,
  meme_used_raw = excluded.meme_used_raw,
  meme_burned_raw = excluded.meme_burned_raw,
  curve_price_raw = excluded.curve_price_raw,
  start_price_raw = excluded.start_price_raw,
  repaired = excluded.repaired,
  repair_steps = excluded.repair_steps,
  repair_meme_sold_raw = excluded.repair_meme_sold_raw,
  repair_proceeds_raw = excluded.repair_proceeds_raw,
  native_fallback = excluded.native_fallback,
  native_fallback_adapter = excluded.native_fallback_adapter,
  fallback_quote_held_raw = excluded.fallback_quote_held_raw,
  fallback_quote_meme_sold_raw = excluded.fallback_quote_meme_sold_raw,
  protocol_fee_escrowed_raw = excluded.protocol_fee_escrowed_raw,
  protocol_fee_flushed_raw = excluded.protocol_fee_flushed_raw,
  creator_graduation_claimed_native_raw = excluded.creator_graduation_claimed_native_raw,
  creator_graduation_claimed_quote_raw = excluded.creator_graduation_claimed_quote_raw,
  creator_first_buy_tokens_raw = excluded.creator_first_buy_tokens_raw,
  creator_first_buy_cost_raw = excluded.creator_first_buy_cost_raw,
  creator_first_buy_fee_raw = excluded.creator_first_buy_fee_raw,
  escrow_total_raw = excluded.escrow_total_raw,
  escrow_claimed_raw = excluded.escrow_claimed_raw,
  quote_token = coalesce(excluded.quote_token, s.quote_token),
  last_event_block = excluded.last_event_block,
  updated_at = now()`;

export async function refreshGen5State(db: Queryable, chainId: number, campaign: string): Promise<void> {
  await db.query(REFRESH_GEN5_STATE_SQL, [chainId, campaign.toLowerCase()]);
}

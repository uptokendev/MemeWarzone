/**
 * DBC graduation keeper: locker → migrate → mark → withdraw → D7 compensate
 * → kind-1 route → done. LP claims are a separate hourly schedule over
 * graduated pools. Sign, store sending + signature + lastValidBlockHeight,
 * then send. Resolve pending with getTransaction then getSignatureStatuses
 * + getBlockHeight. Never reset a send that may have landed. Walk every
 * pool each pass. Update by id.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  deriveBaseKeyForLocker,
  deriveDammV2PoolAddress,
  deriveEscrow,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getTokenProgram, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { notifyCampaignGraduated } from "../campaignLifecycleNotifications.js";
import { ensureWeeklyEpoch } from "../rewards/epochs.js";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import {
  buildRouteTransfers,
  collectorNeed,
  heldCreatorPoolSum,
  nativeDelta,
  rewardVaults,
} from "./dbcFeeRouter.js";
import { quoteVaultOutflow } from "./dbcFeeClaimer.js";
import { profileFromLink, type DbcFeeProfile } from "./dbcFeeSplit.js";
import {
  compensationDue,
  expectedPartnerMigrationFee,
  finalizeAfterCompensation,
  finalizeRouteTotals,
  isPlatformFeeChoice,
  splitPlatformLpFees,
  type DbcFinalizeSlices,
} from "./dbcGraduationSplit.js";
import {
  jobFromRow,
  nextGraduationStep,
  readConfigSnapshot,
  readPoolSnapshot,
  solanaGraduationMeta,
  VIRTUAL_POOL_DISCRIMINATOR,
  type GraduationStep,
} from "./dbcGraduationState.js";
import { isNativeQuoteMint, quoteDecimalsFromMeta, quoteMintFromMeta, quoteTokenProgram } from "./dbcQuoteNative.js";
import { splitSolFromQuoteSwap, quoteRoutedTotal } from "./dbcQuoteSolSplit.js";
import { swapClaimedQuoteIfNeeded, type SwapQuoteFn } from "./dbcQuoteToSolSwap.js";
import { buildD7CompensationIxs } from "./dbcQuoteTransfers.js";
import { stockQuoteRefusal } from "./dbcStockQuoteCheck.js";

export { VIRTUAL_POOL_DISCRIMINATOR };

export const SOLANA_CHAIN_ID = 101;
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DBC_QUOTE_MINT = "So11111111111111111111111111111111111111112";

function quoteMintPk(mint?: string | null) {
  const raw = String(mint || "").trim();
  return new PublicKey(raw || DBC_QUOTE_MINT);
}

async function campaignQuoteMint(db: Queryable, pool: string) {
  const { rows } = await db.query(
    `select meta from public.campaigns where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, pool],
  );
  const meta = rows[0]?.meta || {};
  return quoteMintPk(quoteMintFromMeta(meta));
}

async function quoteMintFromPool(client: DynamicBondingCurveClient, pool: { config: string }) {
  // No fallback to SOL: for a USDC-bound coin that would derive the wrong DAMM pool. A failed read
  // throws, and the resolver leaves the job pending for the next pass.
  const wrap: any = await client.state.getPoolConfig(new PublicKey(pool.config));
  const inner = wrap?.poolConfig ?? wrap;
  const mint = inner?.quoteMint?.toBase58?.() || inner?.quoteMint || inner?.quote_mint;
  if (!mint) throw new Error(`pool config ${pool.config} has no quote mint`);
  return quoteMintPk(mint);
}
export const DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6;
const BACKOFF_SECONDS = [30, 60, 120, 300];
const DEFAULT_LP_CLAIM_MIN_LAMPORTS = 10_000n;

export function lpClaimMinLamports(): bigint {
  const raw = String(process.env.DBC_LP_CLAIM_MIN_LAMPORTS || "").trim();
  if (!raw) return DEFAULT_LP_CLAIM_MIN_LAMPORTS;
  try {
    const value = BigInt(raw);
    return value < 0n ? DEFAULT_LP_CLAIM_MIN_LAMPORTS : value;
  } catch {
    return DEFAULT_LP_CLAIM_MIN_LAMPORTS;
  }
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

const LINK_SQL = `
select r.is_og
  from public.wallet_recruiter_links l
  join public.recruiters r on r.id = l.recruiter_id
 where l.wallet_address = $1
   and l.linked_at <= $2
   and (l.detached_at is null or l.detached_at > $2)
 order by l.linked_at desc, l.id desc
 limit 1`;

function dammConfigPk(): PublicKey {
  return new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
}

export function deriveLockerEscrow(pool: PublicKey): PublicKey {
  return deriveEscrow(deriveBaseKeyForLocker(pool));
}

async function creatorProfile(db: Queryable, creator: string, at: Date): Promise<DbcFeeProfile> {
  const { rows } = await db.query(LINK_SQL, [creator, at]);
  return profileFromLink(rows[0] || null);
}

async function getTx(connection: Connection, signature: string) {
  return connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
}

function unwrapPool(wrap: any) {
  return wrap?.poolState ?? wrap;
}

function unwrapConfig(wrap: any) {
  return wrap?.poolConfig ?? wrap;
}

async function updateJob(db: Queryable, id: string | number, sql: string, params: unknown[] = []) {
  await db.query(sql, [id, ...params]);
}

function backoffSeconds(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] || 300;
}

export async function resolvePendingGraduation(input: {
  db: Queryable;
  connection: Connection;
  client?: DynamicBondingCurveClient;
  collector?: Keypair;
}): Promise<{ resolved: number; waiting: number }> {
  const pending = await input.db.query(
    `select * from public.dbc_graduation_jobs where status = 'sending' order by id`,
  );
  let resolved = 0;
  let waiting = 0;
  const client = input.client || new DynamicBondingCurveClient(input.connection as any, "confirmed");
  for (const row of pending.rows) {
    const signature = String(row.signature || "");
    const lastValid = Number(row.last_valid_block_height || 0);
    if (!signature) {
      waiting += 1;
      continue;
    }
    const confirmed = await getTx(input.connection, signature);
    const outcome = confirmed
      ? (confirmed.meta?.err ? "failed" : "landed")
      : await resolveSignature(input.connection, signature, lastValid);
    if (outcome === "pending") {
      waiting += 1;
      continue;
    }
    if (outcome === "failed" || outcome === "expired") {
      await updateJob(
        input.db,
        row.id,
        `update public.dbc_graduation_jobs
            set status = 'ready', signature = null, last_valid_block_height = null,
                attempt = attempt + 1, backoff_until = now() + make_interval(secs => $2),
                updated_at = now()
          where id = $1`,
        [backoffSeconds(Number(row.attempt || 0))],
      );
      resolved += 1;
      continue;
    }
    if (!confirmed) {
      waiting += 1;
      continue;
    }
    await applyLandedJob({
      db: input.db,
      connection: input.connection,
      client,
      row,
      confirmed,
      signature,
      collector: input.collector,
    });
    resolved += 1;
  }
  return { resolved, waiting };
}

async function applyLandedJob(input: {
  db: Queryable;
  connection: Connection;
  client: DynamicBondingCurveClient;
  row: any;
  confirmed: any;
  signature: string;
  collector?: Keypair;
}) {
  const step = String(input.row.step);
  const poolPk = new PublicKey(String(input.row.pool));
  const slot = Number(input.confirmed.slot || 0);
  if (step === "locker") {
    const locker = deriveLockerEscrow(poolPk).toBase58();
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'migrate', locker = $2, signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
      [locker],
    );
    return;
  }
  if (step === "migrate") {
    const wrap = await input.client.state.getPool(poolPk);
    const pool = readPoolSnapshot(unwrapPool(wrap));
    const quoteMint = await quoteMintFromPool(input.client, pool!);
    const dammPool = deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool!.baseMint), quoteMint).toBase58();
    const cpAmm = new CpAmm(input.connection as any);
    let first: string | null = null;
    let second: string | null = null;
    try {
      const creatorPos = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), new PublicKey(pool!.creator));
      first = creatorPos[0]?.position?.toBase58?.() || null;
    } catch {
      first = null;
    }
    try {
      const partnerOwner = input.collector?.publicKey || null;
      if (partnerOwner) {
        const partnerPos = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), partnerOwner);
        second = partnerPos.find((p: { position?: { toBase58?: () => string } }) => p.position?.toBase58?.() !== first)?.position?.toBase58?.()
          || partnerPos[0]?.position?.toBase58?.()
          || null;
      }
    } catch {
      second = null;
    }
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'mark', damm_pool = $2, first_position_nft = coalesce($3, first_position_nft),
              second_position_nft = coalesce($4, second_position_nft), signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
      [dammPool, first, second],
    );
    void slot;
    return;
  }
  if (step === "withdraw") {
    const wrap = await input.client.state.getPool(poolPk);
    const pool = readPoolSnapshot(unwrapPool(wrap));
    const claimed = quoteVaultOutflow(input.confirmed, pool!.quoteVault);
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'compensate', partner_fee = $2, signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
      [claimed.toString()],
    );
    return;
  }
  if (step === "compensate") {
    const paid = BigInt(String(input.row.compensation || "0"));
    await input.db.query(
      `insert into public.dbc_graduation_compensations
         (pool, creator, lamports, quote_cut, base_cut, base_as_sol, total_due, shortfall, remaining_for_route, tx)
       values ($1,$2,$3,'0','0','0',$3,$4,'0',$5)
       on conflict (pool) do update set tx = excluded.tx, lamports = excluded.lamports`,
      [input.row.pool, String(input.row.creator || ""), paid.toString(), String(input.row.shortfall || "0"), input.signature],
    );
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'route', signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
    );
    return;
  }
  if (step === "route") {
    const partnerFee = input.row.partner_fee != null
      ? BigInt(String(input.row.partner_fee))
      : 0n;
    const paid = BigInt(String(input.row.compensation || "0"));
    const profile = await creatorProfile(input.db, String(input.row.creator || ""), new Date());
    const slices = finalizeAfterCompensation(partnerFee < 0n ? 0n : partnerFee, profile, paid).slices;
    await insertFinalizeRewardEvent({
      db: input.db,
      job: input.row,
      slices,
      signature: input.signature,
      slot: Number(input.confirmed.slot || 0),
      remaining: slices.remaining,
    });
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'done', step = 'done', signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
    );
    return;
  }
}

async function campaignFeeChoice(db: Queryable, pool: string): Promise<string> {
  const { rows } = await db.query(
    `select meta from public.campaigns where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, pool],
  );
  return String(rows[0]?.meta?.dbc?.feeChoice || rows[0]?.meta?.dbc?.fee_choice || "keep");
}

export function lpClaimRows(claimed: bigint, transferred: bigint, platform: boolean) {
  const creatorPool = platform ? splitPlatformLpFees(claimed).creatorPool : 0n;
  const protocolShare = claimed - creatorPool;
  const leftover = protocolShare - transferred;
  if (leftover < 0n) {
    throw new Error(`LP protocol transfer ${transferred.toString()} exceeds the protocol share ${protocolShare.toString()}`);
  }
  return { creatorPool, transferred, leftover };
}

async function insertLpAccruals(input: {
  db: Queryable;
  job: any;
  claimed: bigint;
  transferred: bigint;
  platform: boolean;
  signature: string;
  leftoverAlreadySol?: boolean;
  /** Bound quote only: the creator pot in quote units; `claimed` is then our share in SOL. */
  creatorPoolQuote?: bigint;
}) {
  const rows = lpClaimRows(input.claimed, input.transferred, input.platform);
  if (input.creatorPoolQuote != null) rows.creatorPool = input.creatorPoolQuote;
  const profile = await creatorProfile(input.db, String(input.job.creator || ""), new Date());
  const insert = async (
    logIndex: number,
    protocol: bigint,
    creatorPool: bigint,
    status: string,
    routeSig: string | null,
    solReceived: bigint | null,
  ) => {
    const total = protocol + creatorPool;
    if (total <= 0n) return;
    await input.db.query(
      `insert into public.dbc_fee_accruals (
         pool, tx_hash, log_index, trader, profile, fee_total,
         trading_fee, protocol_fee, referral_fee, collector_amount,
         league_weekly, league_monthly, recruiter, squad, airdrop, protocol, creator_pool, status, route_signature, sol_received
       ) values ($1,$2,$3,$4,$5,$6,$6,0,0,$6,0,0,0,0,0,$7,$8,$9,$10,$11)
       on conflict (tx_hash, log_index) do nothing`,
      [
        String(input.job.pool), input.signature, logIndex, String(input.job.creator || ""), profile,
        total.toString(), protocol.toString(), creatorPool.toString(), status, routeSig,
        solReceived != null ? solReceived.toString() : null,
      ],
    );
  };
  // Row 0: what this transaction routed to protocol_vault, plus the creator pool it keeps on the collector.
  await insert(0, rows.transferred, rows.creatorPool, "routed", input.signature, null);
  // Row 1: protocol share still on the collector. After a bound-quote swap this leftover is already SOL.
  if (rows.leftover > 0n) {
    await insert(1, rows.leftover, 0n, "claimed", null, input.leftoverAlreadySol ? rows.leftover : null);
  }
}

async function blockIfCollectorShort(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  jobId: string | number;
  tx: Transaction;
  spend: bigint;
}): Promise<boolean> {
  const have = BigInt(await input.connection.getBalance(input.collector.publicKey, "confirmed"));
  const rent = BigInt(await input.connection.getMinimumBalanceForRentExemption(0));
  if (!input.tx.recentBlockhash) {
    const latest = await input.connection.getLatestBlockhash("confirmed");
    input.tx.feePayer = input.collector.publicKey;
    input.tx.recentBlockhash = latest.blockhash;
  }
  input.tx.feePayer = input.collector.publicKey;
  const feeMsg = await input.connection.getFeeForMessage(input.tx.compileMessage(), "confirmed");
  const fee = BigInt(feeMsg?.value ?? 5_000);
  const held = await heldCreatorPoolSum(input.db);
  const need = collectorNeed(input.spend, held, rent, fee);
  if (have >= need) return false;
  await updateJob(
    input.db,
    input.jobId,
    `update public.dbc_graduation_jobs
        set status = 'blocked', blocked_reason = $2, updated_at = now()
      where id = $1`,
    [`collector short have ${have.toString()} need ${need.toString()}`],
  );
  return true;
}

async function signStoreSend(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  jobId: string | number;
  tx: Transaction;
  extraSigners?: Keypair[];
}): Promise<{ signature: string; skipped: string | null }> {
  const latest = await input.connection.getLatestBlockhash("confirmed");
  input.tx.feePayer = input.collector.publicKey;
  input.tx.recentBlockhash = latest.blockhash;
  const signers = [input.collector, ...(input.extraSigners || [])];
  input.tx.partialSign(...signers);
  const serialized = input.tx.serialize();
  let signature = bs58Encode(serialized.subarray(1, 65));
  await updateJob(
    input.db,
    input.jobId,
    `update public.dbc_graduation_jobs
        set status = 'sending', signature = $2, last_valid_block_height = $3, updated_at = now()
      where id = $1`,
    [signature, latest.lastValidBlockHeight],
  );
  try {
    const sent = await input.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    if (sent && sent !== signature) {
      await updateJob(
        input.db,
        input.jobId,
        `update public.dbc_graduation_jobs set signature = $2, updated_at = now() where id = $1`,
        [sent],
      );
      signature = sent;
    }
    const confirmation = await input.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) {
      await updateJob(
        input.db,
        input.jobId,
        `update public.dbc_graduation_jobs
            set status = 'ready', signature = null, last_valid_block_height = null,
                attempt = attempt + 1, backoff_until = now() + make_interval(secs => $2), updated_at = now()
          where id = $1`,
        [backoffSeconds(1)],
      );
      return { signature, skipped: "failed-on-chain" };
    }
  } catch (error) {
    console.warn("[dbc-grad] send/confirm error; left pending for the resolver", {
      signature,
      error: String(error instanceof Error ? error.message : error),
    });
    return { signature, skipped: "sending" };
  }
  return { signature, skipped: "sending" };
}

export async function upsertGraduationJob(db: Queryable, input: {
  pool: string;
  campaign?: string | null;
  mint?: string | null;
  config?: string | null;
  creator?: string | null;
}) {
  await db.query(
    `insert into public.dbc_graduation_jobs (pool, campaign, mint, config, creator, step, status)
     values ($1,$2,$3,$4,$5,'locker','ready')
     on conflict (pool) do update set
       campaign = coalesce(excluded.campaign, public.dbc_graduation_jobs.campaign),
       mint = coalesce(excluded.mint, public.dbc_graduation_jobs.mint),
       config = coalesce(excluded.config, public.dbc_graduation_jobs.config),
       creator = coalesce(excluded.creator, public.dbc_graduation_jobs.creator),
       updated_at = now()`,
    [input.pool, input.campaign || input.pool, input.mint || null, input.config || null, input.creator || null],
  );
}

async function loadJob(db: Queryable, pool: string) {
  const { rows } = await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool]);
  return rows[0] || null;
}

async function dammVaultAmounts(connection: Connection, dammPool: string, quoteMint = DBC_QUOTE_MINT) {
  const cpAmm = new CpAmm(connection as any);
  const state = await cpAmm.fetchPoolState(new PublicKey(dammPool));
  const tokenA = BigInt((await connection.getTokenAccountBalance(state.tokenAVault)).value.amount);
  const tokenB = BigInt((await connection.getTokenAccountBalance(state.tokenBVault)).value.amount);
  const quotePk = quoteMintPk(quoteMint);
  const quoteIsB = state.tokenBMint.equals(quotePk);
  return {
    quote: quoteIsB ? tokenB : tokenA,
    base: quoteIsB ? tokenA : tokenB,
    state,
    quoteVault: quoteIsB ? state.tokenBVault : state.tokenAVault,
  };
}

async function markCampaignGraduated(input: {
  db: Queryable;
  connection: Connection;
  job: any;
  slot: number;
  quoteMint?: string;
}) {
  const meta = solanaGraduationMeta({
    dammPool: String(input.job.damm_pool || ""),
    slot: input.slot,
    quoteMint: String(input.quoteMint || DBC_QUOTE_MINT),
    locker: input.job.locker,
    firstPositionNft: input.job.first_position_nft,
    secondPositionNft: input.job.second_position_nft,
  });
  const campaign = String(input.job.campaign || input.job.pool);
  await input.db.query(
    `update public.campaigns
        set graduated_at_chain = coalesce(graduated_at_chain, now()),
            graduated_block = coalesce(graduated_block, $3),
            is_active = false,
            launched = true,
            bonding_active = false,
            meta = coalesce(meta, '{}'::jsonb)
              || jsonb_build_object('solanaGraduation', $4::jsonb)
              || jsonb_build_object('dbc', coalesce(meta->'dbc','{}'::jsonb) || jsonb_build_object('migration', $5::jsonb)),
            updated_at = now()
      where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, campaign, input.slot, JSON.stringify(meta.solanaGraduation), JSON.stringify(meta.dbcMigration)],
  );
  await notifyCampaignGraduated(input.db as any, {
    chainId: SOLANA_CHAIN_ID,
    campaignAddress: campaign,
    market: { venue: "meteora-damm-v2", pair: String(input.job.damm_pool || ""), quoteAsset: "SOL" },
    graduatedAt: new Date(),
  });
  await updateJob(
    input.db,
    input.job.id,
    `update public.dbc_graduation_jobs
        set status = 'ready', step = 'withdraw', updated_at = now()
      where id = $1`,
  );
}

async function insertFinalizeRewardEvent(input: {
  db: Queryable;
  job: any;
  slices: DbcFinalizeSlices;
  signature: string;
  slot: number;
  remaining: bigint;
}) {
  const at = new Date();
  const epoch = await ensureWeeklyEpoch(SOLANA_CHAIN_ID, at, input.db as any);
  const metadata = {
    weeklyLeagueLamports: "0",
    monthlyLeagueLamports: "0",
    remaining: input.remaining.toString(),
    recruiter: input.slices.recruiter.toString(),
    squad: input.slices.squad.toString(),
    airdrop: input.slices.airdrop.toString(),
    protocol: input.slices.protocol.toString(),
    partnerFee: String(input.job.partner_fee || "0"),
    compensation: String(input.job.compensation || "0"),
  };
  JSON.stringify(metadata);
  await input.db.query(
    `insert into public.reward_events(
       chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id,
       wallet_address, campaign_address, route_kind, route_profile,
       league_amount, recruiter_amount, airdrop_amount, squad_amount, protocol_amount, raw_amount,
       source_contract, source_event, matched_activity_source, metadata, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'finalize',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,now(),now())
     on conflict (chain_id, tx_hash, log_index) do update set
       route_kind = excluded.route_kind,
       route_profile = excluded.route_profile,
       recruiter_amount = excluded.recruiter_amount,
       airdrop_amount = excluded.airdrop_amount,
       squad_amount = excluded.squad_amount,
       protocol_amount = excluded.protocol_amount,
       raw_amount = excluded.raw_amount,
       matched_activity_source = excluded.matched_activity_source,
       metadata = excluded.metadata,
       updated_at = now()
     where public.reward_events.matched_activity_source = 'dbc_graduation'`,
    [
      SOLANA_CHAIN_ID,
      input.signature,
      0,
      input.slot,
      at,
      epoch.id,
      String(input.job.creator || ""),
      String(input.job.campaign || input.job.pool),
      input.slices.profile,
      "0",
      input.slices.recruiter.toString(),
      input.slices.airdrop.toString(),
      input.slices.squad.toString(),
      input.slices.protocol.toString(),
      input.remaining.toString(),
      DBC_PROGRAM_ID,
      "DbcGraduation",
      "dbc_graduation",
      JSON.stringify(metadata),
    ],
  );
}

export async function advanceGraduationJob(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  pool: string;
  send: boolean;
  client?: DynamicBondingCurveClient;
  swapQuote?: SwapQuoteFn;
}): Promise<{ pool: string; step: GraduationStep | string; signature: string | null; skipped: string | null }> {
  const client = input.client || new DynamicBondingCurveClient(input.connection as any, "confirmed");
  const poolPk = new PublicKey(input.pool);
  const wrap = await client.state.getPool(poolPk);
  const poolState = unwrapPool(wrap);
  const pool = readPoolSnapshot(poolState);
  if (!pool) return { pool: input.pool, step: "not_complete", signature: null, skipped: "pool-unreadable" };
  const cfgWrap = await client.state.getPoolConfig(new PublicKey(pool.config));
  const config = readConfigSnapshot(unwrapConfig(cfgWrap));
  if (!config) return { pool: input.pool, step: "not_complete", signature: null, skipped: "config-unreadable" };

  await upsertGraduationJob(input.db, {
    pool: input.pool,
    campaign: input.pool,
    mint: pool.baseMint,
    config: pool.config,
    creator: pool.creator,
  });
  let job = await loadJob(input.db, input.pool);
  const campaign = await input.db.query(
    `select graduated_at_chain, meta from public.campaigns where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, input.pool],
  );
  const marked = Boolean(campaign.rows[0]?.graduated_at_chain);
  const compensationRow = await input.db.query(
    `select tx from public.dbc_graduation_compensations where pool = $1`,
    [input.pool],
  );
  const jobSnap = jobFromRow(job);
  jobSnap.compensationPaid = jobSnap.compensationPaid || Boolean(compensationRow.rows[0]?.tx);
  if (marked) jobSnap.marked = true;
  const step = nextGraduationStep(pool, config, jobSnap);
  if (step === "not_complete") return { pool: input.pool, step, signature: null, skipped: "not-complete" };
  if (step === "done") {
    await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set status = 'done', step = 'done', updated_at = now() where id = $1`);
    return { pool: input.pool, step, signature: null, skipped: "done" };
  }
  if (job.status === "blocked") return { pool: input.pool, step, signature: null, skipped: "blocked" };
  if (job.status === "sending") return { pool: input.pool, step, signature: job.signature, skipped: "sending-in-flight" };
  if (job.backoff_until && new Date(job.backoff_until).getTime() > Date.now()) {
    return { pool: input.pool, step, signature: null, skipped: "backoff" };
  }

  if (step === "mark") {
    const slot = await input.connection.getSlot("confirmed");
    if (!job.damm_pool) {
      const dammPool = deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool.baseMint), quoteMintPk(config.quoteMint)).toBase58();
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set damm_pool = $2 where id = $1`, [dammPool]);
      job = await loadJob(input.db, input.pool);
    }
    await markCampaignGraduated({ db: input.db, connection: input.connection, job, slot, quoteMint: config.quoteMint });
    return { pool: input.pool, step, signature: null, skipped: null };
  }

  if (!input.send) return { pool: input.pool, step, signature: null, skipped: "dry-run" };

  await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = $2, updated_at = now() where id = $1`, [step]);
  job = await loadJob(input.db, input.pool);

  if (step === "locker") {
    const tx = await client.migration.createLocker({ payer: input.collector.publicKey, pool: poolPk });
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx: tx as any });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "migrate") {
    const refusal = await stockQuoteRefusal(
      input.connection,
      String(config.quoteMint),
      await quoteTokenProgram(input.connection as any, String(config.quoteMint)),
    );
    if (refusal) {
      // A pause can lift; a hook or fee needs a person. Either way retry hourly and say why.
      await updateJob(
        input.db,
        job.id,
        `update public.dbc_graduation_jobs
            set blocked_reason = $2, backoff_until = now() + interval '1 hour', updated_at = now()
          where id = $1`,
        [refusal.reason],
      );
      return { pool: input.pool, step, signature: null, skipped: `quote-${refusal.code}` };
    }
    if (job.blocked_reason) {
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set blocked_reason = null, updated_at = now() where id = $1`);
    }
    const res = await client.migration.migrateToDammV2({
      payer: input.collector.publicKey,
      pool: poolPk,
      dammConfig: dammConfigPk(),
    });
    const sent = await signStoreSend({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      jobId: job.id,
      tx: res.transaction as any,
      extraSigners: [res.firstPositionNftKeypair as any, res.secondPositionNftKeypair as any],
    });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "withdraw") {
    const tx = await client.partner.partnerWithdrawMigrationFee({ pool: poolPk, sender: input.collector.publicKey });
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx: tx as any });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "compensate") {
    const dammPool = String(job.damm_pool || deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool.baseMint), quoteMintPk(config.quoteMint)).toBase58());
    const vaults = await dammVaultAmounts(input.connection, dammPool, config.quoteMint);
    const due = compensationDue({
      protocolMigrationQuoteFeeAmount: pool.protocolMigrationQuoteFeeAmount,
      protocolMigrationBaseFeeAmount: pool.protocolMigrationBaseFeeAmount,
      dammQuoteVault: vaults.quote,
      dammBaseVault: vaults.base,
    });
    const partnerFee = job.partner_fee != null
      ? BigInt(String(job.partner_fee))
      : expectedPartnerMigrationFee(config.migrationQuoteThreshold);
    const profile = await creatorProfile(input.db, pool.creator, new Date());
    const applied = finalizeAfterCompensation(partnerFee, profile, due.due);
    await updateJob(
      input.db,
      job.id,
      `update public.dbc_graduation_jobs
          set damm_pool = $2, compensation = $3, shortfall = $4, partner_fee = coalesce(partner_fee, $5), updated_at = now()
        where id = $1`,
      [dammPool, applied.paid.toString(), applied.shortfall.toString(), partnerFee.toString()],
    );
    await input.db.query(
      `insert into public.dbc_graduation_compensations
         (pool, creator, lamports, quote_cut, base_cut, base_as_sol, total_due, shortfall, remaining_for_route, tx)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)
       on conflict (pool) do update set
         lamports = excluded.lamports,
         quote_cut = excluded.quote_cut,
         base_cut = excluded.base_cut,
         base_as_sol = excluded.base_as_sol,
         total_due = excluded.total_due,
         shortfall = excluded.shortfall,
         remaining_for_route = excluded.remaining_for_route`,
      [
        input.pool, pool.creator, applied.paid.toString(), due.quoteCut.toString(), due.baseCut.toString(),
        due.baseAsSol.toString(), due.due.toString(), applied.shortfall.toString(), applied.slices.remaining.toString(),
      ],
    );
    job = await loadJob(input.db, input.pool);
    if (applied.paid <= 0n) {
      await input.db.query(
        `update public.dbc_graduation_compensations set tx = 'none' where pool = $1 and tx is null`,
        [input.pool],
      );
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'route', status = 'ready', updated_at = now() where id = $1`);
      return { pool: input.pool, step, signature: null, skipped: "nothing-to-compensate" };
    }
    const quoteMint = String(config.quoteMint || DBC_QUOTE_MINT);
    let decimals = quoteDecimalsFromMeta(campaign.rows[0]?.meta, isNativeQuoteMint(quoteMint) ? 9 : 6);
    const quoteProgram = await quoteTokenProgram(input.connection as any, quoteMint);
    if (!isNativeQuoteMint(quoteMint)) {
      try {
        decimals = (await getMint(input.connection as any, quoteMintPk(quoteMint), "confirmed", quoteProgram)).decimals;
      } catch {
        // campaign meta / 6
      }
      const ata = getAssociatedTokenAddressSync(quoteMintPk(quoteMint), input.collector.publicKey, false, quoteProgram);
      const bal = await input.connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
      const haveTok = bal ? BigInt(bal.value.amount) : 0n;
      if (haveTok < applied.paid) {
        await updateJob(
          input.db,
          job.id,
          `update public.dbc_graduation_jobs
              set status = 'blocked', blocked_reason = $2, updated_at = now()
            where id = $1`,
          [`collector short of quote have ${haveTok.toString()} need ${applied.paid.toString()}`],
        );
        return { pool: input.pool, step, signature: null, skipped: "collector-short" };
      }
    }
    const tx = new Transaction();
    for (const ix of buildD7CompensationIxs({
      collector: input.collector.publicKey,
      creator: new PublicKey(pool.creator),
      quoteMint,
      amount: applied.paid,
      decimals,
      tokenProgram: quoteProgram,
    })) tx.add(ix);
    const blocked = await blockIfCollectorShort({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      jobId: job.id,
      tx,
      spend: isNativeQuoteMint(quoteMint) ? applied.paid : 0n,
    });
    if (blocked) return { pool: input.pool, step, signature: null, skipped: "collector-short" };
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx: tx as any });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "route") {
    const partnerFee = job.partner_fee != null
      ? BigInt(String(job.partner_fee))
      : expectedPartnerMigrationFee(config.migrationQuoteThreshold);
    const paid = BigInt(String(job.compensation || "0"));
    const profile = await creatorProfile(input.db, pool.creator, new Date());
    const applied = finalizeAfterCompensation(partnerFee, profile, paid);
    const slices = applied.slices;
    if (slices.remaining <= 0n) {
      await insertFinalizeRewardEvent({
        db: input.db, job, slices, signature: `dbc-grad-${input.pool}`, slot: 0, remaining: 0n,
      });
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'done', status = 'done', updated_at = now() where id = $1`);
      return { pool: input.pool, step, signature: null, skipped: "nothing-to-route" };
    }
    const quoteMint = String(config.quoteMint || DBC_QUOTE_MINT);
    let totals = finalizeRouteTotals(slices);
    if (!isNativeQuoteMint(quoteMint) && slices.remaining > 0n) {
      const swapped = await swapClaimedQuoteIfNeeded({
        db: input.db,
        connection: input.connection,
        collector: input.collector,
        quoteMint,
        quoteIn: slices.remaining,
        send: input.send,
        swapQuote: input.swapQuote,
        key: `grad:${input.pool}`,
      });
      if (swapped.skipped === "impact-cap" || swapped.skipped === "sending" || swapped.skipped === "failed-on-chain") {
        return { pool: input.pool, step, signature: null, skipped: swapped.skipped };
      }
      if (swapped.solOut <= 0n) {
        await insertFinalizeRewardEvent({
          db: input.db, job, slices, signature: `dbc-grad-${input.pool}`, slot: 0, remaining: 0n,
        });
        await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'done', status = 'done', updated_at = now() where id = $1`);
        return { pool: input.pool, step, signature: null, skipped: "nothing-to-route" };
      }
      const sol = splitSolFromQuoteSwap({
        leagueWeekly: 0n,
        leagueMonthly: 0n,
        recruiter: slices.recruiter,
        squad: slices.squad,
        airdrop: slices.airdrop,
        protocol: slices.protocol,
        creatorPool: 0n,
      }, swapped.solOut);
      totals = {
        leagueWeekly: 0n,
        leagueMonthly: 0n,
        recruiter: sol.recruiter,
        squad: sol.squad,
        airdrop: sol.airdrop,
        protocol: sol.protocol,
        creatorPool: 0n,
        routed: quoteRoutedTotal(sol),
      };
    }
    const vaults = rewardVaults();
    const built = buildRouteTransfers({ collector: input.collector.publicKey, totals, vaults });
    const latest = await input.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = input.collector.publicKey;
    tx.recentBlockhash = latest.blockhash;
    for (const ix of built.instructions) tx.add(ix);
    const blocked = await blockIfCollectorShort({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      jobId: job.id,
      tx,
      spend: totals.routed,
    });
    if (blocked) return { pool: input.pool, step, signature: null, skipped: "collector-short" };
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx: tx as any });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  return { pool: input.pool, step, signature: null, skipped: "unhandled" };
}

export async function listOpenGraduationPools(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `select campaign_address as pool
       from public.campaigns
      where chain_id = $1
        and coalesce(launch_type, 'launchpad') = 'dbc'
        and campaign_address is not null
        and graduated_at_chain is null
      union
      select pool
        from public.dbc_graduation_jobs
       where status in ('ready', 'sending', 'blocked')
         and step <> 'done'`,
    [SOLANA_CHAIN_ID],
  );
  return rows.map((row: { pool: string }) => String(row.pool));
}

export async function listWatchPools(db: Queryable): Promise<string[]> {
  return listOpenGraduationPools(db);
}

export async function scanCompleteDbcPools(db: Queryable): Promise<string[]> {
  return listOpenGraduationPools(db);
}

const dbcAccountCoder = new BorshCoder(
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dynamicBondingCurve.idl.json"), "utf8")) as Idl,
);
const ACCOUNT_BATCH = 100;

async function readAccountsBatched(connection: Connection, addresses: string[]) {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < addresses.length; i += ACCOUNT_BATCH) {
    const chunk = addresses.slice(i, i + ACCOUNT_BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), "confirmed");
    infos.forEach((info, index) => {
      if (info?.data) out.set(chunk[index], Buffer.from(info.data));
    });
  }
  return out;
}

function toBig(value: unknown): bigint {
  if (value == null) return 0n;
  return BigInt(String((value as { toString(): string }).toString()));
}

function toKey(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const withBase58 = value as { toBase58?: () => string };
  return typeof withBase58.toBase58 === "function" ? withBase58.toBase58() : String(value);
}

function field(obj: any, camel: string, snake: string) {
  return obj?.[camel] ?? obj?.[snake];
}

export type PoolProgress = { isMigrated: number; quoteReserve: bigint; threshold: bigint | null };

/** One batched read of every pool and its config (100 accounts per call). */
export async function readPoolProgressBatched(connection: Connection, pools: string[]): Promise<Map<string, PoolProgress>> {
  const poolData = await readAccountsBatched(connection, pools);
  const decoded = new Map<string, { config: string; quoteReserve: bigint; isMigrated: number }>();
  for (const [address, data] of poolData) {
    try {
      const decodedPool = dbcAccountCoder.accounts.decode("VirtualPool", data) as any;
      // The IDL wraps the pool fields in pool_state (the SDK's getPool does the same).
      const pool = decodedPool?.pool_state ?? decodedPool?.poolState ?? decodedPool;
      decoded.set(address, {
        config: toKey(field(pool, "config", "config")),
        quoteReserve: toBig(field(pool, "quoteReserve", "quote_reserve")),
        isMigrated: Number(field(pool, "isMigrated", "is_migrated") ?? 0),
      });
    } catch (error) {
      console.warn("[dbc-grad] pool account not decodable", address, error instanceof Error ? error.message : String(error));
    }
  }
  const configs = [...new Set([...decoded.values()].map((row) => row.config).filter(Boolean))];
  const configData = await readAccountsBatched(connection, configs);
  const thresholds = new Map<string, bigint>();
  for (const [address, data] of configData) {
    try {
      const config = dbcAccountCoder.accounts.decode("PoolConfig", data) as any;
      thresholds.set(address, toBig(field(config, "migrationQuoteThreshold", "migration_quote_threshold")));
    } catch (error) {
      console.warn("[dbc-grad] config account not decodable", address, error instanceof Error ? error.message : String(error));
    }
  }
  const out = new Map<string, PoolProgress>();
  for (const [address, row] of decoded) {
    out.set(address, { isMigrated: row.isMigrated, quoteReserve: row.quoteReserve, threshold: thresholds.get(row.config) ?? null });
  }
  return out;
}

/**
 * Which open pools need the step logic this pass: complete curves, migrated pools, and jobs already
 * past the locker step. The rest are skipped without per-pool reads.
 */
export async function poolsNeedingWork(
  db: Queryable,
  connection: Connection,
  pools: string[],
  readProgress: (connection: Connection, pools: string[]) => Promise<Map<string, PoolProgress>> = readPoolProgressBatched,
): Promise<string[]> {
  if (!pools.length) return [];
  const started = await db.query(
    `select pool from public.dbc_graduation_jobs where step <> 'locker' and step <> 'done'`,
  );
  const inFlight = new Set(started.rows.map((row: { pool: string }) => String(row.pool)));
  const progress = await readProgress(connection, pools);
  return pools.filter((address) => {
    if (inFlight.has(address)) return true;
    const pool = progress.get(address);
    if (!pool) return false;
    if (pool.isMigrated === 1) return true;
    return pool.threshold != null && pool.threshold > 0n && pool.quoteReserve >= pool.threshold;
  });
}

export async function runDbcGraduationOnce(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  pool?: string;
  client?: DynamicBondingCurveClient;
  swapQuote?: SwapQuoteFn;
  readProgress?: (connection: Connection, pools: string[]) => Promise<Map<string, PoolProgress>>;
}): Promise<{
  pending: { resolved: number; waiting: number };
  advanced: Array<{ pool: string; step: string; signature: string | null; skipped: string | null }>;
}> {
  const pending = await resolvePendingGraduation({
    db: input.db,
    connection: input.connection,
    client: input.client,
    collector: input.collector,
  });
  const pools = input.pool
    ? [input.pool]
    : await poolsNeedingWork(input.db, input.connection, await listOpenGraduationPools(input.db), input.readProgress);
  const advanced = [];
  for (const pool of pools) {
    const result = await advanceGraduationJob({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      pool,
      send: input.send,
      client: input.client,
      swapQuote: input.swapQuote,
    });
    if (result.skipped === "not-complete") continue;
    advanced.push(result);
  }
  return { pending, advanced };
}

async function applyLandedLpClaim(input: {
  db: Queryable;
  connection: Connection;
  row: any;
  confirmed: any;
  signature: string;
  collector?: Keypair;
  send?: boolean;
  swapQuote?: SwapQuoteFn;
}) {
  let claimed = 0n;
  let quoteMint = DBC_QUOTE_MINT;
  const dammPool = String(input.row.damm_pool || "");
  if (dammPool) {
    try {
      const cpAmm = new CpAmm(input.connection as any);
      const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
      const quotePk = await campaignQuoteMint(input.db, String(input.row.pool));
      quoteMint = quotePk.toBase58();
      const quoteVault = dpool.tokenBMint.equals(quotePk) ? dpool.tokenBVault : dpool.tokenAVault;
      claimed = quoteVaultOutflow(input.confirmed, quoteVault.toBase58());
    } catch {
      const vaults = rewardVaults();
      const protocolDelta = nativeDelta(input.confirmed, vaults.protocol.toBase58());
      claimed = protocolDelta > 0n ? protocolDelta : 0n;
    }
  }
  const choice = await campaignFeeChoice(input.db, String(input.row.pool));
  const platform = isPlatformFeeChoice(choice);
  // Bound quote: swap the whole claim to SOL first (D19 creator_pool is then SOL).
  // Native: the protocol share may already have been transferred in the claim tx.
  let transferred = (() => {
    const delta = nativeDelta(input.confirmed, rewardVaults().protocol.toBase58());
    return delta > 0n ? delta : 0n;
  })();
  let leftoverAlreadySol = false;
  let boundCreatorPool: bigint | null = null;
  let boundClaimedQuote = 0n;
  if (claimed > 0n && !isNativeQuoteMint(quoteMint) && input.collector) {
    // Bound quote: the coin's creator pot stays in the quote, like its trade-fee pot (both are one
    // ledger in quote units, paid out by step 5b in the quote). Only our share becomes SOL.
    const claimedQuote = claimed;
    const split = platform ? splitPlatformLpFees(claimed) : { creatorPool: 0n, protocol: claimed };
    let protocolSol = 0n;
    if (split.protocol > 0n) {
      const swapped = await swapClaimedQuoteIfNeeded({
        db: input.db,
        connection: input.connection,
        collector: input.collector,
        quoteMint,
        quoteIn: split.protocol,
        send: input.send !== false,
        swapQuote: input.swapQuote,
        key: `lp:${input.signature}`,
      });
      if (swapped.skipped === "impact-cap" || swapped.skipped === "failed-on-chain" || swapped.skipped === "sending") {
        // Leave lp_signature set: the next pass resumes this same keyed swap.
        return;
      }
      protocolSol = swapped.solOut;
    }
    boundCreatorPool = split.creatorPool;
    boundClaimedQuote = claimedQuote;
    claimed = protocolSol;
    transferred = 0n;
    leftoverAlreadySol = true;
  }
  if (boundCreatorPool != null) {
    await insertLpAccruals({
      db: input.db,
      job: input.row,
      claimed,
      transferred,
      platform: false,
      signature: input.signature,
      leftoverAlreadySol,
      creatorPoolQuote: boundCreatorPool,
    });
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set lp_claimed = coalesce(lp_claimed,0) + $2,
              lp_signature = null, lp_last_valid_block_height = null, updated_at = now()
        where id = $1`,
      [boundClaimedQuote.toString()], // lp_claimed is in the pool's quote units
    );
    return;
  }
  if (claimed > 0n) {
    await insertLpAccruals({
      db: input.db,
      job: input.row,
      claimed,
      transferred,
      platform,
      signature: input.signature,
      leftoverAlreadySol,
    });
  }
  await updateJob(
    input.db,
    input.row.id,
    `update public.dbc_graduation_jobs
        set lp_claimed = coalesce(lp_claimed,0) + $2,
            lp_signature = null, lp_last_valid_block_height = null, updated_at = now()
      where id = $1`,
    [claimed.toString()],
  );
}

async function signStoreSendLp(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  jobId: string | number;
  tx: Transaction;
}): Promise<{ signature: string; skipped: string | null }> {
  const latest = await input.connection.getLatestBlockhash("confirmed");
  input.tx.feePayer = input.collector.publicKey;
  input.tx.recentBlockhash = latest.blockhash;
  input.tx.partialSign(input.collector);
  const serialized = input.tx.serialize();
  let signature = bs58Encode(serialized.subarray(1, 65));
  await updateJob(
    input.db,
    input.jobId,
    `update public.dbc_graduation_jobs
        set lp_signature = $2, lp_last_valid_block_height = $3, updated_at = now()
      where id = $1`,
    [signature, latest.lastValidBlockHeight],
  );
  try {
    const sent = await input.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    if (sent && sent !== signature) {
      await updateJob(
        input.db,
        input.jobId,
        `update public.dbc_graduation_jobs set lp_signature = $2, updated_at = now() where id = $1`,
        [sent],
      );
      signature = sent;
    }
    const confirmation = await input.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) {
      await updateJob(
        input.db,
        input.jobId,
        `update public.dbc_graduation_jobs
            set lp_signature = null, lp_last_valid_block_height = null, updated_at = now()
          where id = $1`,
      );
      return { signature, skipped: "failed-on-chain" };
    }
  } catch (error) {
    console.warn("[dbc-grad] LP send/confirm error; left pending for the resolver", {
      signature,
      error: String(error instanceof Error ? error.message : error),
    });
    return { signature, skipped: "sending" };
  }
  return { signature, skipped: "sending" };
}

export async function resolvePendingLpClaims(input: {
  db: Queryable;
  connection: Connection;
  collector?: Keypair;
  send?: boolean;
  swapQuote?: SwapQuoteFn;
}): Promise<{ resolved: number; waiting: number }> {
  const pending = await input.db.query(
    `select * from public.dbc_graduation_jobs where lp_signature is not null order by id`,
  );
  let resolved = 0;
  let waiting = 0;
  for (const row of pending.rows) {
    const signature = String(row.lp_signature || "");
    const lastValid = Number(row.lp_last_valid_block_height || 0);
    if (!signature) {
      waiting += 1;
      continue;
    }
    const confirmed = await getTx(input.connection, signature);
    const outcome = confirmed
      ? (confirmed.meta?.err ? "failed" : "landed")
      : await resolveSignature(input.connection, signature, lastValid);
    if (outcome === "pending") {
      waiting += 1;
      continue;
    }
    if (outcome === "failed" || outcome === "expired") {
      await updateJob(
        input.db,
        row.id,
        `update public.dbc_graduation_jobs
            set lp_signature = null, lp_last_valid_block_height = null, updated_at = now()
          where id = $1`,
      );
      resolved += 1;
      continue;
    }
    if (!confirmed) {
      waiting += 1;
      continue;
    }
    await applyLandedLpClaim({
      db: input.db,
      connection: input.connection,
      row,
      confirmed,
      signature,
      collector: input.collector,
      send: input.send,
      swapQuote: input.swapQuote,
    });
    resolved += 1;
  }
  return { resolved, waiting };
}

export async function runDbcLpClaimsOnce(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  pool?: string;
  swapQuote?: SwapQuoteFn;
}): Promise<{
  pending: { resolved: number; waiting: number };
  advanced: Array<{ pool: string; skipped: string | null; signature: string | null; owed?: string }>;
}> {
  const pending = await resolvePendingLpClaims({
    db: input.db,
    connection: input.connection,
    collector: input.collector,
    send: input.send,
    swapQuote: input.swapQuote,
  });
  const min = lpClaimMinLamports();
  const jobs = input.pool
    ? await input.db.query(
        `select * from public.dbc_graduation_jobs where pool = $1 and damm_pool is not null`,
        [input.pool],
      )
    : await input.db.query(
        `select * from public.dbc_graduation_jobs
          where status = 'done' and damm_pool is not null
          order by id`,
      );
  const advanced = [];
  for (const job of jobs.rows) {
    if (job.lp_signature) {
      advanced.push({ pool: String(job.pool), skipped: "lp-sending", signature: String(job.lp_signature) });
      continue;
    }
    const dammPool = String(job.damm_pool || "");
    if (!dammPool) {
      advanced.push({ pool: String(job.pool), skipped: "no-damm-pool", signature: null });
      continue;
    }
    const cpAmm = new CpAmm(input.connection as any);
    const positions = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), input.collector.publicKey);
    if (!positions.length) {
      advanced.push({ pool: String(job.pool), skipped: "no-partner-position", signature: null });
      continue;
    }
    const pos = positions[0];
    const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
    let owed = 0n;
    try {
      const unclaimed = getUnClaimLpFee(dpool, pos.positionState);
      const quotePk = await campaignQuoteMint(input.db, String(job.pool));
      owed = BigInt(String(unclaimed?.feeTokenB || (unclaimed as any)?.feeQuote || 0));
      if (dpool.tokenAMint.equals(quotePk)) owed = BigInt(String(unclaimed?.feeTokenA || 0));
    } catch {
      owed = 0n;
    }
    if (owed < min) {
      advanced.push({ pool: String(job.pool), skipped: "below-threshold", signature: null, owed: owed.toString() });
      continue;
    }
    if (!input.send) {
      advanced.push({ pool: String(job.pool), skipped: "dry-run", signature: null, owed: owed.toString() });
      continue;
    }
    const claimTx: Transaction = (await cpAmm.claimPositionFee({
      owner: input.collector.publicKey,
      position: pos.position,
      pool: new PublicKey(dammPool),
      positionNftAccount: pos.positionNftAccount,
      tokenAMint: dpool.tokenAMint,
      tokenBMint: dpool.tokenBMint,
      tokenAVault: dpool.tokenAVault,
      tokenBVault: dpool.tokenBVault,
      tokenAProgram: getTokenProgram(dpool.tokenAFlag),
      tokenBProgram: getTokenProgram(dpool.tokenBFlag),
      feePayer: input.collector.publicKey,
    })) as any;
    const protocol = rewardVaults().protocol;
    const platform = isPlatformFeeChoice(await campaignFeeChoice(input.db, String(job.pool)));
    const quotePk = await campaignQuoteMint(input.db, String(job.pool));
    const protocolLamports = platform ? splitPlatformLpFees(owed).protocol : owed;
    if (protocolLamports > 0n && isNativeQuoteMint(quotePk.toBase58())) {
      claimTx.add(SystemProgram.transfer({
        fromPubkey: input.collector.publicKey,
        toPubkey: protocol,
        lamports: Number(protocolLamports),
      }));
    }
    const sent = await signStoreSendLp({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      jobId: job.id,
      tx: claimTx,
    });
    advanced.push({ pool: String(job.pool), skipped: sent.skipped, signature: sent.signature, owed: owed.toString() });
  }
  return { pending, advanced };
}

/**
 * DBC graduation keeper: locker → migrate → partner withdraw → D7 compensate
 * → kind-1 route → mark graduated → partner LP to protocol_vault.
 * Sign, store sending + signature + lastValidBlockHeight, then send.
 * Resolve pending with getTransaction then getSignatureStatuses + getBlockHeight.
 * Never reset a send that may have landed. One pool at a time. Update by id.
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
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { notifyCampaignGraduated } from "../campaignLifecycleNotifications.js";
import { ensureWeeklyEpoch } from "../rewards/epochs.js";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import {
  buildRouteTransfers,
  collectorNeed,
  nativeDelta,
  rewardVaults,
} from "./dbcFeeRouter.js";
import { quoteVaultOutflow } from "./dbcFeeClaimer.js";
import { profileFromLink, type DbcFeeProfile } from "./dbcFeeSplit.js";
import {
  compensationDue,
  expectedPartnerMigrationFee,
  finalizeRouteTotals,
  isPlatformFeeChoice,
  payCompensation,
  splitDbcFinalizeFee,
  splitPlatformLpFees,
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

export { VIRTUAL_POOL_DISCRIMINATOR };

export const SOLANA_CHAIN_ID = 101;
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DBC_QUOTE_MINT = "So11111111111111111111111111111111111111112";
export const DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6;
const BACKOFF_SECONDS = [30, 60, 120, 300];

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
}): Promise<{ resolved: number; waiting: number }> {
  const pending = await input.db.query(
    `select * from public.dbc_graduation_jobs where status = 'sending' order by id`,
  );
  let resolved = 0;
  let waiting = 0;
  const client = input.client || new DynamicBondingCurveClient(input.connection, "confirmed");
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
    await applyLandedJob({ db: input.db, connection: input.connection, client, row, confirmed, signature });
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
    const dammPool = deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool!.baseMint), NATIVE_MINT).toBase58();
    const cpAmm = new CpAmm(input.connection);
    let first: string | null = null;
    let second: string | null = null;
    try {
      const creatorPos = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), new PublicKey(pool!.creator));
      first = creatorPos[0]?.position?.toBase58?.() || null;
    } catch {
      first = null;
    }
    try {
      const partnerOwner = String(input.row.creator || pool!.creator);
      const partnerPos = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), new PublicKey(partnerOwner));
      second = partnerPos.find((p: { position?: { toBase58?: () => string } }) => p.position?.toBase58?.() !== first)?.position?.toBase58?.()
        || partnerPos[0]?.position?.toBase58?.()
        || null;
    } catch {
      second = null;
    }
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'withdraw', damm_pool = $2, first_position_nft = coalesce($3, first_position_nft),
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
    const remainingRow = await input.db.query(
      `select remaining_for_route from public.dbc_graduation_compensations where pool = $1`,
      [input.row.pool],
    );
    const remaining = BigInt(String(remainingRow.rows[0]?.remaining_for_route || "0"));
    const profile = await creatorProfile(input.db, String(input.row.creator || ""), new Date());
    const slices = splitDbcFinalizeFee(remaining < 0n ? 0n : remaining, profile);
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
          set status = 'ready', step = 'mark', signature = null,
              last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
    );
    return;
  }
  if (step === "lp") {
    let claimed = 0n;
    const dammPool = String(input.row.damm_pool || "");
    if (dammPool) {
      try {
        const cpAmm = new CpAmm(input.connection);
        const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
        const quoteVault = dpool.tokenBMint.equals(NATIVE_MINT) ? dpool.tokenBVault : dpool.tokenAVault;
        claimed = quoteVaultOutflow(input.confirmed, quoteVault.toBase58());
      } catch {
        const vaults = rewardVaults();
        const protocolDelta = nativeDelta(input.confirmed, vaults.protocol.toBase58());
        claimed = protocolDelta > 0n ? protocolDelta : 0n;
      }
    }
    const choice = await campaignFeeChoice(input.db, String(input.row.pool));
    if (isPlatformFeeChoice(choice) && claimed > 0n) {
      await insertPlatformLpAccrual({
        db: input.db,
        job: input.row,
        claimed,
        signature: input.signature,
      });
    }
    await updateJob(
      input.db,
      input.row.id,
      `update public.dbc_graduation_jobs
          set status = 'ready', step = 'lp', lp_claimed = coalesce(lp_claimed,0) + $2,
              signature = null, last_valid_block_height = null, attempt = 0, backoff_until = null, updated_at = now()
        where id = $1`,
      [claimed.toString()],
    );
  }
}

async function campaignFeeChoice(db: Queryable, pool: string): Promise<string> {
  const { rows } = await db.query(
    `select meta from public.campaigns where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, pool],
  );
  return String(rows[0]?.meta?.dbc?.feeChoice || rows[0]?.meta?.dbc?.fee_choice || "keep");
}

async function insertPlatformLpAccrual(input: {
  db: Queryable;
  job: any;
  claimed: bigint;
  signature: string;
}) {
  const split = splitPlatformLpFees(input.claimed);
  const profile = await creatorProfile(input.db, String(input.job.creator || ""), new Date());
  await input.db.query(
    `insert into public.dbc_fee_accruals (
       pool, tx_hash, log_index, trader, profile, fee_total,
       trading_fee, protocol_fee, referral_fee, collector_amount,
       league_weekly, league_monthly, recruiter, squad, airdrop, protocol, creator_pool, status, route_signature
     ) values ($1,$2,0,$3,$4,$5,$5,0,0,$5,0,0,0,0,0,$6,$7,'routed',$2)
     on conflict (tx_hash, log_index) do nothing`,
    [
      String(input.job.pool),
      input.signature,
      String(input.job.creator || ""),
      profile,
      input.claimed.toString(),
      split.protocol.toString(),
      split.creatorPool.toString(),
    ],
  );
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

async function dammVaultAmounts(connection: Connection, dammPool: string) {
  const cpAmm = new CpAmm(connection);
  const state = await cpAmm.fetchPoolState(new PublicKey(dammPool));
  const tokenA = BigInt((await connection.getTokenAccountBalance(state.tokenAVault)).value.amount);
  const tokenB = BigInt((await connection.getTokenAccountBalance(state.tokenBVault)).value.amount);
  const quoteIsB = state.tokenBMint.equals(NATIVE_MINT);
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
}) {
  const meta = solanaGraduationMeta({
    dammPool: String(input.job.damm_pool || ""),
    slot: input.slot,
    quoteMint: DBC_QUOTE_MINT,
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
        set status = 'ready', step = 'lp', updated_at = now()
      where id = $1`,
  );
}

async function insertFinalizeRewardEvent(input: {
  db: Queryable;
  job: any;
  slices: ReturnType<typeof splitDbcFinalizeFee>;
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
}): Promise<{ pool: string; step: GraduationStep | string; signature: string | null; skipped: string | null }> {
  const client = input.client || new DynamicBondingCurveClient(input.connection, "confirmed");
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
  if (job.status === "sending") return { pool: input.pool, step, signature: job.signature, skipped: "sending-in-flight" };
  if (job.backoff_until && new Date(job.backoff_until).getTime() > Date.now()) {
    return { pool: input.pool, step, signature: null, skipped: "backoff" };
  }

  if (step === "mark") {
    const slot = await input.connection.getSlot("confirmed");
    if (!job.damm_pool) {
      const dammPool = deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool.baseMint), NATIVE_MINT).toBase58();
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set damm_pool = $2 where id = $1`, [dammPool]);
      job = await loadJob(input.db, input.pool);
    }
    await markCampaignGraduated({ db: input.db, connection: input.connection, job, slot });
    return { pool: input.pool, step, signature: null, skipped: null };
  }

  if (!input.send) return { pool: input.pool, step, signature: null, skipped: "dry-run" };

  await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = $2, updated_at = now() where id = $1`, [step]);
  job = await loadJob(input.db, input.pool);

  if (step === "locker") {
    const tx = await client.migration.createLocker({ payer: input.collector.publicKey, pool: poolPk });
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "migrate") {
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
      tx: res.transaction,
      extraSigners: [res.firstPositionNftKeypair, res.secondPositionNftKeypair],
    });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "withdraw") {
    const tx = await client.partner.partnerWithdrawMigrationFee({ pool: poolPk, sender: input.collector.publicKey });
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "compensate") {
    const dammPool = String(job.damm_pool || deriveDammV2PoolAddress(dammConfigPk(), new PublicKey(pool.baseMint), NATIVE_MINT).toBase58());
    const vaults = await dammVaultAmounts(input.connection, dammPool);
    const due = compensationDue({
      protocolMigrationQuoteFeeAmount: pool.protocolMigrationQuoteFeeAmount,
      protocolMigrationBaseFeeAmount: pool.protocolMigrationBaseFeeAmount,
      dammQuoteVault: vaults.quote,
      dammBaseVault: vaults.base,
    });
    const partnerFee = job.partner_fee != null
      ? BigInt(String(job.partner_fee))
      : expectedPartnerMigrationFee(config.migrationQuoteThreshold);
    const pay = payCompensation(due.due, partnerFee);
    await updateJob(
      input.db,
      job.id,
      `update public.dbc_graduation_jobs
          set damm_pool = $2, compensation = $3, shortfall = $4, partner_fee = coalesce(partner_fee, $5), updated_at = now()
        where id = $1`,
      [dammPool, pay.paid.toString(), pay.shortfall.toString(), partnerFee.toString()],
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
        input.pool, pool.creator, pay.paid.toString(), due.quoteCut.toString(), due.baseCut.toString(),
        due.baseAsSol.toString(), due.due.toString(), pay.shortfall.toString(), pay.remaining.toString(),
      ],
    );
    job = await loadJob(input.db, input.pool);
    if (pay.paid <= 0n) {
      await input.db.query(
        `update public.dbc_graduation_compensations set tx = 'none' where pool = $1 and tx is null`,
        [input.pool],
      );
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'route', status = 'ready', updated_at = now() where id = $1`);
      return { pool: input.pool, step, signature: null, skipped: "nothing-to-compensate" };
    }
    const tx = new Transaction();
    tx.add(SystemProgram.transfer({
      fromPubkey: input.collector.publicKey,
      toPubkey: new PublicKey(pool.creator),
      lamports: Number(pay.paid),
    }));
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "route") {
    const compensation = await input.db.query(
      `select remaining_for_route, total_due, lamports, shortfall from public.dbc_graduation_compensations where pool = $1`,
      [input.pool],
    );
    const remaining = compensation.rows[0]
      ? BigInt(String(compensation.rows[0].remaining_for_route || "0"))
      : expectedPartnerMigrationFee(config.migrationQuoteThreshold) - BigInt(String(job.compensation || "0"));
    const profile = await creatorProfile(input.db, pool.creator, new Date());
    const slices = splitDbcFinalizeFee(remaining < 0n ? 0n : remaining, profile);
    if (slices.remaining <= 0n) {
      await insertFinalizeRewardEvent({
        db: input.db, job, slices, signature: `dbc-grad-${input.pool}`, slot: 0, remaining: 0n,
      });
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'mark', status = 'ready', updated_at = now() where id = $1`);
      return { pool: input.pool, step, signature: null, skipped: "nothing-to-route" };
    }
    const totals = finalizeRouteTotals(slices);
    const vaults = rewardVaults();
    const built = buildRouteTransfers({ collector: input.collector.publicKey, totals, vaults });
    const have = BigInt(await input.connection.getBalance(input.collector.publicKey, "confirmed"));
    const rent = BigInt(await input.connection.getMinimumBalanceForRentExemption(0));
    const latest = await input.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = input.collector.publicKey;
    tx.recentBlockhash = latest.blockhash;
    for (const ix of built.instructions) tx.add(ix);
    const feeMsg = await input.connection.getFeeForMessage(tx.compileMessage(), "confirmed");
    const fee = BigInt(feeMsg?.value ?? 5_000);
    const need = collectorNeed(totals.routed, 0n, rent, fee);
    if (have < need) {
      await updateJob(
        input.db,
        job.id,
        `update public.dbc_graduation_jobs
            set status = 'blocked', blocked_reason = $2, updated_at = now()
          where id = $1`,
        [`collector short have ${have.toString()} need ${need.toString()}`],
      );
      return { pool: input.pool, step, signature: null, skipped: "collector-short" };
    }
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  if (step === "lp") {
    const dammPool = String(job.damm_pool || "");
    if (!dammPool) return { pool: input.pool, step, signature: null, skipped: "no-damm-pool" };
    const cpAmm = new CpAmm(input.connection);
    const positions = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), input.collector.publicKey);
    if (!positions.length) {
      await updateJob(input.db, job.id, `update public.dbc_graduation_jobs set step = 'lp', status = 'ready', updated_at = now() where id = $1`);
      return { pool: input.pool, step, signature: null, skipped: "no-partner-position" };
    }
    const pos = positions[0];
    const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
    let owed = 0n;
    try {
      const unclaimed = getUnClaimLpFee(dpool, pos.positionState);
      owed = BigInt(String(unclaimed?.feeTokenB || unclaimed?.feeQuote || 0));
      if (dpool.tokenAMint.equals(NATIVE_MINT)) owed = BigInt(String(unclaimed?.feeTokenA || 0));
    } catch {
      owed = 1n;
    }
    if (owed <= 0n) return { pool: input.pool, step, signature: null, skipped: "no-lp-fees" };
    const claimTx: Transaction = await cpAmm.claimPositionFee({
      owner: input.collector.publicKey,
      position: pos.position,
      pool: new PublicKey(dammPool),
      positionNftAccount: pos.positionNftAccount,
      tokenAMint: dpool.tokenAMint,
      tokenBMint: dpool.tokenBMint,
      tokenAVault: dpool.tokenAVault,
      tokenBVault: dpool.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      feePayer: input.collector.publicKey,
    });
    const protocol = rewardVaults().protocol;
    const platform = isPlatformFeeChoice(await campaignFeeChoice(input.db, input.pool));
    const protocolLamports = platform ? splitPlatformLpFees(owed).protocol : owed;
    if (protocolLamports > 0n) {
      claimTx.add(SystemProgram.transfer({
        fromPubkey: input.collector.publicKey,
        toPubkey: protocol,
        lamports: Number(protocolLamports),
      }));
    }
    const sent = await signStoreSend({ db: input.db, connection: input.connection, collector: input.collector, jobId: job.id, tx: claimTx });
    return { pool: input.pool, step, signature: sent.signature, skipped: sent.skipped };
  }

  return { pool: input.pool, step, signature: null, skipped: "unhandled" };
}

export async function scanCompleteDbcPools(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `select campaign_address
       from public.campaigns
      where chain_id = $1
        and coalesce(launch_type, 'launchpad') = 'dbc'
        and campaign_address is not null`,
    [SOLANA_CHAIN_ID],
  );
  const jobs = await db.query(`select pool from public.dbc_graduation_jobs where status <> 'done'`);
  const set = new Set<string>();
  for (const row of rows) set.add(String(row.campaign_address));
  for (const row of jobs.rows) set.add(String(row.pool));
  return [...set];
}

export async function runDbcGraduationOnce(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  pool?: string;
  client?: DynamicBondingCurveClient;
}): Promise<{
  pending: { resolved: number; waiting: number };
  advanced: Array<{ pool: string; step: string; signature: string | null; skipped: string | null }>;
}> {
  const pending = await resolvePendingGraduation({ db: input.db, connection: input.connection, client: input.client });
  const still = await input.db.query(
    `select pool from public.dbc_graduation_jobs where status = 'sending' limit 1`,
  );
  if ((still.rowCount ?? still.rows.length) > 0) {
    return { pending, advanced: [{ pool: String(still.rows[0].pool), step: "sending", signature: null, skipped: "sending-in-flight" }] };
  }
  const pools = input.pool ? [input.pool] : await scanCompleteDbcPools(input.db);
  const advanced = [];
  for (const pool of pools) {
    const result = await advanceGraduationJob({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      pool,
      send: input.send,
      client: input.client,
    });
    if (result.skipped === "not-complete") continue;
    advanced.push(result);
    break;
  }
  return { pending, advanced };
}

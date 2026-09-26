/**
 * Recruiter earnings, credited per trade on every chain (2026-09-26). Until now nothing wrote
 * recruiter_reward_ledger: the chain routed each linked trade's recruiter slice into the recruiter
 * vault and no recruiter was ever credited.
 *
 * Source: public.reward_events -- the chain's own per-trade slices (EVM RouteExecuted via the router
 * scan, Solana FeeSlicesAccrued/Routed via rewards/solanaRewardEvents.ts). The credited amount is
 * exactly recruiter_amount, never an estimate, so the ledger can never promise more than the vault
 * received.
 *
 * Attribution (who earned it), matching the decision that signed the trade's route profile:
 *   - EVM trade: route_authorization_log for that wallet + campaign at or before the trade (the
 *     recruiter the API signed for), else the wallet's recruiter link.
 *   - Solana trade: the wallet's recruiter link (the rule resolveRouteProfile signs with).
 *   - Finalize (graduation): the campaign creator's recruiter link.
 * Link preference: active at the trade time, then the most recent link.
 *
 * Idempotency: one recruiter_fee_events row per on-chain slice (source_chain, "<tx>:<log_index>").
 * A slice nobody can be attributed to is recorded with recruiter_id null and retried on every run;
 * it is never dropped and never given to someone else.
 */
import { pool } from "../db.js";

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const RECRUITER_CHAIN_OF: Record<number, { chain: "bnb" | "solana" | "robinhood"; token: "BNB" | "SOL" | "ETH"; evm: boolean }> = {
  56: { chain: "bnb", token: "BNB", evm: true },
  97: { chain: "bnb", token: "BNB", evm: true },
  4663: { chain: "robinhood", token: "ETH", evm: true },
  46630: { chain: "robinhood", token: "ETH", evm: true },
  101: { chain: "solana", token: "SOL", evm: false },
  102: { chain: "solana", token: "SOL", evm: false },
};

export function sliceKey(txHash: string, logIndex: number) {
  return `${txHash}:${logIndex}`;
}

type RewardEventRow = {
  chain_id: number;
  tx_hash: string;
  log_index: number;
  occurred_at: Date;
  wallet_address: string | null;
  campaign_address: string | null;
  route_kind: "trade" | "finalize";
  route_profile: string;
  raw_amount: string;
  recruiter_amount: string;
};

async function linkedRecruiter(db: Db, wallet: string, evm: boolean, at: Date): Promise<number | null> {
  const { rows } = await db.query(
    `select l.recruiter_id
       from public.wallet_recruiter_links l
      where ${evm ? "lower(l.wallet_address) = lower($1)" : "l.wallet_address = $1"}
      order by (l.is_active and l.linked_at <= $2 and (l.detached_at is null or l.detached_at > $2)) desc,
               l.linked_at desc
      limit 1`,
    [wallet, at],
  );
  return rows[0]?.recruiter_id != null ? Number(rows[0].recruiter_id) : null;
}

async function authorizedRecruiter(db: Db, row: RewardEventRow, wallet: string): Promise<number | null> {
  const { rows } = await db.query(
    `select recruiter_id
       from public.route_authorization_log
      where chain_id = $1 and lower(wallet_address) = lower($2)
        and ($3::text is null or lower(campaign_address) = lower($3))
        and recruiter_id is not null and created_at <= $4
      order by created_at desc
      limit 1`,
    [row.chain_id, wallet, row.campaign_address, row.occurred_at],
  );
  return rows[0]?.recruiter_id != null ? Number(rows[0].recruiter_id) : null;
}

async function creatorOf(db: Db, chainId: number, campaign: string | null): Promise<string | null> {
  if (!campaign) return null;
  const { rows } = await db.query(
    `select creator_address from public.campaigns where chain_id = $1 and (campaign_address = $2 or lower(campaign_address) = lower($2)) limit 1`,
    [chainId, campaign],
  );
  return rows[0]?.creator_address || null;
}

export async function resolveEarningRecruiter(db: Db, row: RewardEventRow): Promise<{ recruiterId: number | null; wallet: string | null; source: string }> {
  const spec = RECRUITER_CHAIN_OF[row.chain_id];
  if (row.route_kind === "finalize") {
    const creator = await creatorOf(db, row.chain_id, row.campaign_address);
    if (!creator) return { recruiterId: null, wallet: null, source: "finalize_creator_unknown" };
    return { recruiterId: await linkedRecruiter(db, creator, spec.evm, row.occurred_at), wallet: creator, source: "finalize_creator_link" };
  }
  // The router event can be recorded before its trade is indexed; the trade row names the wallet.
  let wallet = row.wallet_address;
  if (!wallet) {
    const { rows } = await db.query(
      `select wallet from public.curve_trades where chain_id = $1 and lower(tx_hash) = lower($2) and wallet is not null order by log_index limit 1`,
      [row.chain_id, row.tx_hash],
    );
    wallet = rows[0]?.wallet || null;
  }
  if (!wallet) return { recruiterId: null, wallet: null, source: "trade_wallet_unknown" };
  if (spec.evm) {
    const signed = await authorizedRecruiter(db, row, wallet);
    if (signed != null) return { recruiterId: signed, wallet, source: "route_authorization_log" };
  }
  return { recruiterId: await linkedRecruiter(db, wallet, spec.evm, row.occurred_at), wallet, source: "wallet_recruiter_link" };
}

/** recruiters.id (bigint, links) -> recruiter_accounts.recruiter_id (uuid, payouts), by code. */
async function recruiterAccountId(db: Db, recruiterId: number): Promise<string | null> {
  const { rows } = await db.query(`select id, wallet_address, code, display_name from public.recruiters where id = $1`, [recruiterId]);
  const recruiter = rows[0];
  if (!recruiter?.code) return null;
  const upsert = await db.query(
    `insert into public.recruiter_accounts (signup_wallet, code, display_name, status, updated_at)
     values ($1, $2, $3, 'active', now())
     on conflict (code) do update set updated_at = public.recruiter_accounts.updated_at
     returning recruiter_id`,
    [recruiter.wallet_address, recruiter.code, recruiter.display_name || recruiter.code],
  );
  return upsert.rows[0]?.recruiter_id || null;
}

export type CreditSummary = { scanned: number; credited: number; creditedRaw: Record<string, string>; unattributed: number; unattributedRaw: Record<string, string>; retried: number };

export async function creditRecruiterEarnings(opts: { chainIds: number[]; dryRun?: boolean; limit?: number; db?: typeof pool }): Promise<CreditSummary> {
  const db = opts.db ?? pool;
  if (!db) throw new Error("DATABASE_URL is required");
  const summary: CreditSummary = { scanned: 0, credited: 0, creditedRaw: {}, unattributed: 0, unattributedRaw: {}, retried: 0 };
  const add = (bucket: Record<string, string>, chain: string, amount: string) => {
    bucket[chain] = (BigInt(bucket[chain] || "0") + BigInt(amount)).toString();
  };

  // New slices, plus earlier ones that could not be attributed yet.
  const { rows } = await db.query(
    `select re.chain_id, re.tx_hash, re.log_index, re.occurred_at, re.wallet_address, re.campaign_address,
            re.route_kind, re.route_profile, re.raw_amount::text, re.recruiter_amount::text,
            f.id as fee_event_id
       from public.reward_events re
       left join public.recruiter_fee_events f
         on f.source_chain = case when re.chain_id in (56, 97) then 'bnb' when re.chain_id in (4663, 46630) then 'robinhood' else 'solana' end
        and f.tx_hash = re.tx_hash || ':' || re.log_index
      where re.chain_id = any($1::int[])
        and re.recruiter_amount > 0
        and (f.id is null or f.recruiter_id is null)
      order by re.occurred_at asc
      limit $2`,
    [opts.chainIds, Math.max(1, opts.limit ?? 5000)],
  );

  for (const row of rows as Array<RewardEventRow & { fee_event_id: string | null }>) {
    summary.scanned += 1;
    const spec = RECRUITER_CHAIN_OF[row.chain_id];
    if (!spec) continue;
    const who = await resolveEarningRecruiter(db, row);
    const accountId = who.recruiterId != null ? await recruiterAccountIdReadOnly(db, who.recruiterId, opts.dryRun) : null;
    const metadata = {
      chainId: row.chain_id, txHash: row.tx_hash, logIndex: row.log_index, routeKind: row.route_kind,
      routeProfile: row.route_profile, campaign: row.campaign_address, earningWallet: who.wallet,
      linksRecruiterId: who.recruiterId, attribution: who.source, occurredAt: new Date(row.occurred_at).toISOString(),
    };
    if (!accountId) {
      summary.unattributed += 1;
      add(summary.unattributedRaw, spec.chain, row.recruiter_amount);
      if (!opts.dryRun && !row.fee_event_id) {
        await db.query(
          `insert into public.recruiter_fee_events (recruiter_id, trader_wallet, source_chain, fee_token, raw_fee_amount, recruiter_share_raw, tx_hash, finality_status, claim_status, metadata)
           values (null, $1, $2, $3, $4::numeric, $5::numeric, $6, 'confirmed', 'pending', $7::jsonb)
           on conflict (source_chain, tx_hash) do nothing`,
          [who.wallet, spec.chain, spec.token, row.raw_amount, row.recruiter_amount, sliceKey(row.tx_hash, row.log_index), JSON.stringify(metadata)],
        );
      }
      continue;
    }
    summary.credited += 1;
    if (row.fee_event_id) summary.retried += 1;
    add(summary.creditedRaw, spec.chain, row.recruiter_amount);
    if (opts.dryRun) continue;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const fee = await client.query(
        `insert into public.recruiter_fee_events (recruiter_id, trader_wallet, source_chain, fee_token, raw_fee_amount, recruiter_share_raw, tx_hash, finality_status, claim_status, metadata)
         values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, 'confirmed', 'claimable', $8::jsonb)
         on conflict (source_chain, tx_hash) do update
           set recruiter_id = excluded.recruiter_id, claim_status = 'claimable', metadata = excluded.metadata, updated_at = now()
           where public.recruiter_fee_events.recruiter_id is null
         returning id`,
        [accountId, who.wallet, spec.chain, spec.token, row.raw_amount, row.recruiter_amount, sliceKey(row.tx_hash, row.log_index), JSON.stringify(metadata)],
      );
      if (fee.rows[0]?.id) {
        await client.query(
          `insert into public.recruiter_reward_ledger (recruiter_id, chain, token, amount_raw, status, source_event_id, chain_id, metadata)
           values ($1, $2, $3, $4::numeric, 'claimable', $5, $6, $7::jsonb)`,
          [accountId, spec.chain, spec.token, row.recruiter_amount, fee.rows[0].id, row.chain_id, JSON.stringify({ ...metadata, purpose: "recruiter_trade_share" })],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return summary;
}

/** In a dry run, resolve the account without creating one. */
async function recruiterAccountIdReadOnly(db: Db, recruiterId: number, dryRun?: boolean): Promise<string | null> {
  if (!dryRun) return recruiterAccountId(db, recruiterId);
  const { rows } = await db.query(
    `select coalesce(a.recruiter_id::text, 'new:' || r.code) as id
       from public.recruiters r left join public.recruiter_accounts a on a.code = r.code
      where r.id = $1 and r.code is not null`,
    [recruiterId],
  );
  return rows[0]?.id || null;
}

// Major War League payouts (founder decisions 2026-10-02): every finished MWL month and every closed
// Quarterly Championship is paid poker-style to the winning coins' owners.
//
//   period 'mwl_monthly', category 'mwl'          pot = 60% of the league shares (ledger.monthly_raw)
//   period 'quarterly',   category 'championship' pot = 40% (ledger.quarterly_raw)
//
// A payout takes every not-yet-assigned ledger row of its period and earlier, so a share that
// arrived after its month was paid is carried into the next payout, never lost. Winners go into
// league_epoch_winners (the table the pre-grad leagues use, under these new periods) with NO expiry:
// an MWL prize stays claimable for as long as it takes. From there the existing root publishers post
// them (Solana mwl_vault; EVM dedicated TreasuryVaultV2 vaults) and the Claims page lists them.
//
// Recipient = the coin's creator (graduated launch) or its verified import owner. A coin without a
// valid owner wallet on that chain, or owned by one of our own wallets, is skipped and the next coin
// moves up. If nobody can be paid (no pot, no eligible owner, or a Solana prize below the minimum)
// the period is recorded as rolled_over and its money stays unassigned for the next one.
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";

import { pokerPaidPlaces, pokerPlacesAboveMinimum, pokerSplitRaw, solanaMinPayoutLamports } from "../../shared/pokerPayout.mjs";
import { isOwnerWallet, ownerWalletIndex } from "../../shared/ownerWallets.mjs";
import { publicHiddenWhere } from "./publicHiddenSql.js";

export const MWL_PAYOUT_CHAIN_IDS = Object.freeze([56, 101, 4663, 97, 46630]);
export const MWL_CATEGORY = Object.freeze({ mwl_monthly: "mwl", quarterly: "championship" });
const SOLANA_CHAIN_ID = 101;

/** A wallet that can sign a claim on this chain, normalized; null otherwise. */
export function payoutWalletFor(chainId, wallet) {
  const raw = String(wallet || "").trim();
  if (!raw) return null;
  if (Number(chainId) === SOLANA_CHAIN_ID) {
    try {
      const key = new PublicKey(raw);
      return PublicKey.isOnCurve(key.toBytes()) ? key.toBase58() : null;
    } catch {
      return null;
    }
  }
  try {
    const address = ethers.getAddress(raw.toLowerCase());
    return address === ethers.ZeroAddress ? null : address;
  } catch {
    return null;
  }
}

/**
 * Poker split of `pot` over `standings` (ordered by final rank, each with a resolved `wallet`).
 * Coins without a wallet, owned by one of our own wallets (shared/ownerWallets.mjs, founder
 * 2026-10-05), or hidden test coins (campaigns.meta.publicHidden, `hidden: true`, founder 2026-10-05)
 * are skipped and the next one moves up; the field shrinks by the same count. On Solana
 * a place below the minimum payout is not paid on its own (the claim receipt rent would exceed it).
 */
export function planMwlPayout({ chainId, period, pot, standings, solanaMin = solanaMinPayoutLamports(), owners = ownerWalletIndex() }) {
  const total = BigInt(pot);
  const eligible = (standings || []).filter((row) => row.wallet && Number(row.points) > 0 && !row.hidden && !isOwnerWallet(row.wallet, owners));
  if (total <= 0n) return { status: "rolled_over", reason: "no-pot", winners: [] };
  if (!eligible.length) return { status: "rolled_over", reason: "no-eligible-owner", winners: [] };
  let places = pokerPaidPlaces(eligible.length, period);
  if (Number(chainId) === SOLANA_CHAIN_ID) places = pokerPlacesAboveMinimum(total, places, solanaMin);
  if (places <= 0) return { status: "rolled_over", reason: "below-minimum", winners: [] };
  const shares = pokerSplitRaw(total, places);
  return {
    status: "paid",
    winners: shares.map((amount, index) => ({ rank: index + 1, amount, ...eligible[index] })),
  };
}

function monthStart(year, month) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1));
}

/** Periods that are over (past the grace) and have no payout run yet, oldest first. */
async function duePeriods(db, chainIds, graceMs, now) {
  const cutoff = new Date(now.getTime() - graceMs).toISOString();
  const months = await db.query(
    `select s.id as source_id, s.chain_id, s.year, s.month
       from public.arena_league_seasons s
      where s.chain_id = any($1::int[]) and s.month is not null and s.finalized_at is not null
        and s.finalized_at <= $2
        and not exists (
          select 1 from public.arena_mwl_payout_runs r
           where r.chain_id = s.chain_id and r.period = 'mwl_monthly'
             and r.epoch_start = make_timestamptz(s.year, s.month, 1, 0, 0, 0, 'UTC'))
      order by s.year, s.month`,
    [chainIds, cutoff],
  );
  const quarters = await db.query(
    `select e.id as source_id, e.chain_id, e.year, e.quarter, e.opens_at, e.closes_at
       from public.arena_championship_epochs e
      where e.chain_id = any($1::int[]) and e.state = 'closed' and coalesce(e.closed_at, e.closes_at) <= $2
        and not exists (
          select 1 from public.arena_mwl_payout_runs r
           where r.chain_id = e.chain_id and r.period = 'quarterly' and r.epoch_start = e.opens_at)
      order by e.closes_at`,
    [chainIds, cutoff],
  );
  return [
    ...months.rows.map((row) => {
      const start = monthStart(row.year, row.month);
      return {
        period: "mwl_monthly",
        chainId: Number(row.chain_id),
        sourceId: String(row.source_id),
        epochStart: start,
        epochEnd: monthStart(row.month === 12 ? Number(row.year) + 1 : row.year, row.month === 12 ? 1 : Number(row.month) + 1),
        key: `${row.year}-${String(row.month).padStart(2, "0")}`,
      };
    }),
    ...quarters.rows.map((row) => ({
      period: "quarterly",
      chainId: Number(row.chain_id),
      sourceId: String(row.source_id),
      epochStart: new Date(row.opens_at),
      epochEnd: new Date(row.closes_at),
      key: `${row.year}-Q${row.quarter}`,
    })),
  ];
}

/** Frozen final standings of the period, best first. */
async function standingsFor(db, due) {
  if (due.period === "mwl_monthly") {
    const r = await db.query(
      `select token_address, token_name, symbol, final_rank, mwl_points as points
         from public.arena_championship_mwl_results where season_id = $1 order by final_rank asc`,
      [due.sourceId],
    );
    return r.rows;
  }
  const r = await db.query(
    `select token_address, token_name, symbol, final_rank, total_points as points
       from public.arena_championship_final_standings where epoch_id = $1 order by final_rank asc`,
    [due.sourceId],
  );
  return r.rows;
}

/** The coin's owner: creator of a graduated launch, else the verified import owner. */
async function ownerWallet(db, chainId, token) {
  const native = await db.query(
    `select creator_address from public.campaigns
      where chain_id = $1 and (token_address = $2 or lower(coalesce(token_address::text,'')) = lower($2))
        and graduated_at_chain is not null and creator_address is not null
      order by created_block desc nulls last limit 1`,
    [chainId, token],
  );
  if (native.rows[0]?.creator_address) return String(native.rows[0].creator_address);
  const imported = await db.query(
    `select owner_wallet from public.arena_token_imports
      where chain_id = $1 and (token_address = $2 or lower(token_address) = lower($2)) and status = 'passed'
        and owner_wallet is not null
      order by updated_at desc nulls last limit 1`,
    [chainId, token],
  );
  return imported.rows[0]?.owner_wallet ? String(imported.rows[0].owner_wallet) : null;
}

/** True when the coin is one of our hidden test coins (any launch of it on this chain). */
async function hiddenTestCoin(db, chainId, token) {
  const result = await db.query(
    `select 1 from public.campaigns
      where chain_id = $1 and (token_address = $2 or lower(coalesce(token_address::text,'')) = lower($2))
        and ${publicHiddenWhere()}
      limit 1`,
    [chainId, token],
  );
  return (result.rows?.length ?? 0) > 0;
}

/** Pays one period inside one transaction. Returns the run that was recorded. */
export async function payMwlPeriod(client, due, { solanaMin } = {}) {
  const column = due.period === "mwl_monthly" ? "monthly" : "quarterly";
  const keyColumn = due.period === "mwl_monthly" ? "month_key" : "quarter_key";
  await client.query("begin");
  try {
    // Every unassigned share of this period and earlier (late arrivals included), locked.
    const ledger = await client.query(
      `select id, ${column}_raw as amount from public.arena_league_share_ledger
        where chain_id = $1 and ${column}_payout_epoch is null and ${keyColumn} <= $2
        for update`,
      [due.chainId, due.key],
    );
    const pot = ledger.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const standings = [];
    for (const row of await standingsFor(client, due)) {
      standings.push({
        tokenAddress: String(row.token_address),
        tokenName: String(row.token_name || ""),
        symbol: String(row.symbol || ""),
        finalRank: Number(row.final_rank),
        points: Number(row.points || 0),
        wallet: payoutWalletFor(due.chainId, await ownerWallet(client, due.chainId, String(row.token_address))),
        hidden: await hiddenTestCoin(client, due.chainId, String(row.token_address)),
      });
    }
    const plan = planMwlPayout({ chainId: due.chainId, period: due.period, pot, standings, solanaMin });
    let paid = 0n;
    if (plan.status === "paid") {
      for (const w of plan.winners) {
        await client.query(
          `insert into public.league_epoch_winners
             (chain_id, period, epoch_start, epoch_end, category, rank, recipient_address, amount_raw, payload, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)`,
          [due.chainId, due.period, due.epochStart.toISOString(), due.epochEnd.toISOString(), MWL_CATEGORY[due.period], w.rank, w.wallet, w.amount.toString(),
            JSON.stringify({ tokenAddress: w.tokenAddress, tokenName: w.tokenName, symbol: w.symbol, points: w.points, finalRank: w.finalRank, source: due.sourceId })],
        );
        paid += w.amount;
      }
      await client.query(
        `update public.arena_league_share_ledger set ${column}_payout_epoch = $2 where id = any($1::bigint[])`,
        [ledger.rows.map((row) => row.id), due.epochStart.toISOString()],
      );
    }
    await client.query(
      `insert into public.arena_mwl_payout_runs (chain_id, period, epoch_start, source_id, status, pot_raw, paid_raw, winners, reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [due.chainId, due.period, due.epochStart.toISOString(), due.sourceId, plan.status, pot.toString(), paid.toString(), plan.winners.length, plan.reason || null],
    );
    await client.query("commit");
    return { ...due, status: plan.status, reason: plan.reason || null, pot, paid, winners: plan.winners.length };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/** One pass over every chain. Each period is its own transaction; one failure does not stop others. */
export async function runMwlPayouts({ pool, now = new Date(), graceMs = Number(process.env.ARENA_MWL_PAYOUT_GRACE_MS || 6 * 3_600_000), chainIds = MWL_PAYOUT_CHAIN_IDS } = {}) {
  const outcomes = [];
  for (const due of await duePeriods(pool, chainIds, graceMs, now)) {
    const client = await pool.connect();
    try {
      outcomes.push(await payMwlPeriod(client, due));
    } catch (error) {
      outcomes.push({ ...due, status: "failed", reason: error?.message || String(error) });
    } finally {
      client.release();
    }
  }
  return outcomes;
}

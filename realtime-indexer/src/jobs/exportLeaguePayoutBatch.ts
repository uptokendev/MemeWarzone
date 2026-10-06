// Force IPv4-first DNS resolution to avoid ENETUNREACH on IPv6-only answers
// in some hosted environments (e.g., Railway).
import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import { pool } from "../db.js";
import { leagueHoldMatchSql, moderationHoldsAvailable } from "../rewards/moderationHolds.js";

// Exports a payout batch for league prizes that were CLAIMED (off-chain signature)
// but not yet marked as PAID (multisig execution recorded in league_epoch_payouts).
//
// This is designed for a human operator to:
// 1) Run this job
// 2) Execute the resulting payouts from the TreasuryVault multisig/Safe
// 3) Call POST /api/leaguePayouts to record txHash + payouts (so UI pools update)

const CHAIN_IDS = String(process.env.LEAGUE_EVM_PAYOUT_CHAIN_IDS || "56")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => value === 56 || value === 97);

async function runForChain(chainId: number) {
  // Moderation (B7): a held or voided prize is never exported for a multisig payout.
  const notHeld = (await moderationHoldsAvailable(pool as any))
    ? `AND NOT EXISTS (SELECT 1 FROM public.moderation_holds h WHERE ${leagueHoldMatchSql("h", "w")})`
    : "";
  const { rows } = await pool.query(
    `
    SELECT
      w.chain_id,
      w.period,
      w.epoch_start AS "epochStart",
      w.category,
      w.rank,
      lower(w.recipient_address) AS recipient,
      w.amount_raw AS "amountRaw",
      c.claimed_at AS "claimedAt"
    FROM public.league_epoch_winners w
    INNER JOIN public.league_epoch_claims c
      ON c.chain_id = w.chain_id
     AND c.period = w.period
     AND c.epoch_start = w.epoch_start
     AND c.category = w.category
     AND c.rank = w.rank
    LEFT JOIN public.league_epoch_payouts p
      ON p.chain_id = w.chain_id
     AND p.period = w.period
     AND p.epoch_start = w.epoch_start
     AND p.category = w.category
     AND p.rank = w.rank
    WHERE w.chain_id = $1
      AND p.paid_at IS NULL
      AND (w.expires_at IS NULL OR w.expires_at > now())
      ${notHeld}
    ORDER BY w.period DESC, w.epoch_start DESC, w.category ASC, w.rank ASC;
    `,
    [chainId]
  );

  const byEpoch: Record<string, any> = {};
  for (const r of rows) {
    const key = `${r.period}:${new Date(r.epochStart).toISOString()}`;
    if (!byEpoch[key]) {
      byEpoch[key] = {
        chainId,
        period: r.period,
        epochStart: new Date(r.epochStart).toISOString(),
        payouts: [] as any[],
        totalRaw: "0",
      };
    }
    byEpoch[key].payouts.push({
      category: r.category,
      rank: Number(r.rank),
      recipient: String(r.recipient),
      amountRaw: String(r.amountRaw),
      claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null,
    });
  }

  for (const k of Object.keys(byEpoch)) {
    const batch = byEpoch[k];
    let sum = 0n;
    for (const p of batch.payouts) sum += BigInt(String(p.amountRaw ?? "0"));
    batch.totalRaw = sum.toString();
  }

  return Object.values(byEpoch);
}

async function main() {
  const all: any[] = [];
  for (const chainId of CHAIN_IDS) {
    try {
      const batches = await runForChain(chainId);
      if (batches.length) all.push(...batches);
    } catch (e) {
      // Ignore chains that aren't configured in this DB.
      console.error(`[exportLeaguePayoutBatch] chain ${chainId} failed`, e);
    }
  }

  // Print JSON for easy copy/paste into Safe UI / scripts.
  // Also useful as input to POST /api/leaguePayouts (after tx execution).
  console.log(JSON.stringify({ computedAt: new Date().toISOString(), batches: all }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("[exportLeaguePayoutBatch] fatal", e);
  process.exit(1);
});

import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import { pool } from "../db.js";
import { mergeRecruiterEntitlements } from "../rewards/recruiterMerkle.js";

function startOfUtcWeekMonday(d = new Date()) {
  const today0 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const daysSinceMonday = (today0.getUTCDay() + 6) % 7;
  return new Date(today0.getTime() - daysSinceMonday * 86400_000);
}

async function main() {
  const thisWeekStart = startOfUtcWeekMonday();
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 86400_000);
  const { rows: winners } = await pool.query(
    `select chain_id, category, rank, recipient_address, amount_raw::text as amount_raw
       from public.league_epoch_winners
      where period='weekly' and epoch_start=$1::timestamptz
      order by chain_id, category, rank`,
    [lastWeekStart.toISOString()],
  ).catch(() => ({ rows: [] }));

  const { rows: portal } = await pool.query(
    `select w.wallet_address, coalesce(sum(l.amount_raw),0)::text as amount_raw
       from public.recruiter_reward_ledger l
       join public.recruiter_payout_wallets w
         on w.recruiter_id = l.recruiter_id and w.chain='solana' and w.verified_at is not null
      where l.chain='solana' and l.status in ('claimable','retriable') and l.claim_id is null
      group by w.wallet_address`,
  ).catch(() => ({ rows: [] }));

  const { rows: phase2 } = await pool.query(
    `select wallet_address, claimable_amount::text as amount_raw
       from public.recruiter_claimable_settlements
      where chain_id=101`,
  ).catch(() => ({ rows: [] }));

  const recipients = mergeRecruiterEntitlements(
    phase2.rows.map((row) => ({ walletAddress: row.wallet_address, amountLamports: String(row.amount_raw || "0"), source: "phase2" })),
    portal.rows.map((row) => ({ walletAddress: row.wallet_address, amountLamports: String(row.amount_raw || "0"), source: "portal" })),
  );
  const totalLamports = recipients.reduce((sum, row) => sum + BigInt(row.amountLamports), 0n).toString();
  const duplicateWallets = recipients.filter((row, index, all) => all.findIndex((other) => other.walletAddress === row.walletAddress) !== index);

  console.log(JSON.stringify({
    epochStart: lastWeekStart.toISOString(),
    epochEnd: thisWeekStart.toISOString(),
    leagueWinners: winners,
    recruiterRecipients: recipients,
    recruiterTotalLamports: totalLamports,
    duplicateWallets,
    defaults: {
      LEAGUE_CHAINS: process.env.LEAGUE_CHAINS || "56,101",
      REWARD_CHAINS: process.env.REWARD_CHAINS || process.env.LEAGUE_CHAINS || "56,101",
    },
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[reportPreviousEpoch] failed", error);
    process.exit(1);
  });

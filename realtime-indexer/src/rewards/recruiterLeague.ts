/**
 * Recruiter League as a prize league (founder, 2026-09-26: "just like any other" -- funded from the
 * league fee, poker payout, claimable in the League rewards card on every chain).
 *
 * One universal all-chains ranking per epoch, the board's weights (frontend/api/leagueRecruiterScore.js):
 *   score = links*1 + squad creators*3 + squad traders*2 + referredVolume*0.05 + earned*1
 * with volume and earnings normalized to a BNB-equivalent through USD. Differences from the old board,
 * kept identical in frontend/api/leagueRecruiter.js:
 *   - referred volume is the traded amount on every chain (curve_trades); the board used the routed
 *     FEE as BNB/Robinhood "volume" and the full trade on Solana, a ~50x skew between chains;
 *   - earnings are the chain's own recruiter slices (reward_events), never an estimate;
 *   - USD prices are captured once at settlement and stored with the winners, so a finalized epoch
 *     never re-ranks with the market.
 * Qualified field: active recruiters whose network traded in the epoch (like every other league, a
 * place is earned in the epoch). Per chain, a recruiter is paid at a wallet valid on that chain; one
 * with no such wallet is not in that chain's field (a wrong-format recipient would block the epoch).
 */
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type NativeUsd = { bnbUsd: number; solUsd: number; ethUsd: number };

export type RecruiterStanding = {
  recruiterId: number;
  code: string | null;
  displayName: string | null;
  signupWallet: string | null;
  metadata: any;
  linkedWalletCount: number;
  linkedCreatorsCount: number;
  linkedTradersCount: number;
  referredVolumeUsd: number;
  epochEarnedUsd: number;
  weightedScore: number;
};

const MAINNET = { bnb: 56, robinhood: 4663, solana: 101 };

function weights() {
  const w = (name: string, fallback: number) => {
    const n = Number(process.env[`RECRUITER_LEADERBOARD_WEIGHT_${name}`]);
    return Number.isFinite(n) ? n : fallback;
  };
  return { links: w("LINKED_WALLETS", 1), creators: w("LINKED_CREATORS", 3), traders: w("LINKED_TRADERS", 2), volume: w("ROUTED_VOLUME_BNB", 0.05), earned: w("TOTAL_EARNED_BNB", 1) };
}

const native = (raw: unknown, decimals: number) => Number(String(raw ?? "0")) / 10 ** decimals;

export async function recruiterLeagueStandings(db: Db, startIso: string, endIso: string, prices: NativeUsd): Promise<RecruiterStanding[]> {
  const { rows } = await db.query(
    `WITH active_links AS (
       SELECT l.recruiter_id, l.wallet_address FROM public.wallet_recruiter_links l
        WHERE l.is_active AND l.linked_at <= $2::timestamptz AND (l.detached_at IS NULL OR l.detached_at > $2::timestamptz)
     ), active_squad AS (
       SELECT s.recruiter_id, s.wallet_address, lower(coalesce(s.member_role, '')) AS role FROM public.wallet_squad_memberships s
        WHERE s.is_active AND s.joined_at <= $2::timestamptz
     ), volume_wallets AS (
       SELECT recruiter_id, wallet_address FROM active_links UNION SELECT recruiter_id, wallet_address FROM active_squad
     ), link_stats AS (
       SELECT recruiter_id, count(DISTINCT wallet_address)::int AS n FROM active_links GROUP BY 1
     ), squad_stats AS (
       SELECT recruiter_id,
              count(DISTINCT wallet_address) FILTER (WHERE role IN ('creator','both'))::int AS creators,
              count(DISTINCT wallet_address) FILTER (WHERE role IN ('trader','both'))::int AS traders
         FROM active_squad GROUP BY 1
     ), volume AS (
       SELECT w.recruiter_id, t.chain_id, sum(t.bnb_amount_raw::numeric) AS raw
         FROM public.curve_trades t
         JOIN volume_wallets w
           ON (t.chain_id = $3 AND w.wallet_address = t.wallet) OR (t.chain_id <> $3 AND lower(w.wallet_address) = lower(t.wallet))
        WHERE t.chain_id = ANY($4::int[]) AND t.block_time >= $1::timestamptz AND t.block_time < $2::timestamptz
        GROUP BY 1, 2
     ), earned AS (
       SELECT w.recruiter_id, re.chain_id, sum(re.recruiter_amount) AS raw
         FROM public.reward_events re
         JOIN volume_wallets w
           ON re.route_kind = 'trade' AND re.wallet_address IS NOT NULL
          AND ((re.chain_id = $3 AND w.wallet_address = re.wallet_address) OR (re.chain_id <> $3 AND lower(w.wallet_address) = lower(re.wallet_address)))
        WHERE re.chain_id = ANY($4::int[]) AND re.occurred_at >= $1::timestamptz AND re.occurred_at < $2::timestamptz
        GROUP BY 1, 2
       UNION ALL
       SELECT w.recruiter_id, re.chain_id, sum(re.recruiter_amount)
         FROM public.reward_events re
         JOIN public.campaigns c ON re.route_kind = 'finalize' AND c.chain_id = re.chain_id AND lower(c.campaign_address) = lower(re.campaign_address)
         JOIN volume_wallets w
           ON (re.chain_id = $3 AND w.wallet_address = c.creator_address) OR (re.chain_id <> $3 AND lower(w.wallet_address) = lower(c.creator_address))
        WHERE re.chain_id = ANY($4::int[]) AND re.occurred_at >= $1::timestamptz AND re.occurred_at < $2::timestamptz
        GROUP BY 1, 2
     ), active AS (
       SELECT DISTINCT recruiter_id FROM volume WHERE raw > 0
     )
     SELECT r.id AS recruiter_id, r.code, r.display_name, r.wallet_address, r.metadata,
            coalesce(ls.n, 0) AS links, coalesce(ss.creators, 0) AS creators, coalesce(ss.traders, 0) AS traders,
            coalesce((SELECT jsonb_object_agg(v.chain_id::text, v.raw::text) FROM volume v WHERE v.recruiter_id = r.id), '{}'::jsonb) AS volume,
            coalesce((SELECT jsonb_object_agg(e.chain_id::text, e.total::text) FROM (SELECT chain_id, sum(raw) AS total FROM earned WHERE recruiter_id = r.id GROUP BY 1) e), '{}'::jsonb) AS earned
       FROM active a
       JOIN public.recruiters r ON r.id = a.recruiter_id
       LEFT JOIN link_stats ls ON ls.recruiter_id = r.id
       LEFT JOIN squad_stats ss ON ss.recruiter_id = r.id
      WHERE r.status = 'active'`,
    [startIso, endIso, MAINNET.solana, [MAINNET.bnb, MAINNET.robinhood, MAINNET.solana]],
  );

  const w = weights();
  const norm = prices.bnbUsd || prices.ethUsd || prices.solUsd;
  if (!(norm > 0)) throw new Error("recruiter league needs a native/USD price to rank across chains");
  const usd = (by: Record<string, string>) =>
    native(by[String(MAINNET.bnb)], 18) * prices.bnbUsd + native(by[String(MAINNET.robinhood)], 18) * prices.ethUsd + native(by[String(MAINNET.solana)], 9) * prices.solUsd;

  return rows
    .map((row) => {
      const referredVolumeUsd = usd(row.volume || {});
      const epochEarnedUsd = usd(row.earned || {});
      const weightedScore =
        Number(row.links) * w.links + Number(row.creators) * w.creators + Number(row.traders) * w.traders +
        (referredVolumeUsd / norm) * w.volume + (epochEarnedUsd / norm) * w.earned;
      return {
        recruiterId: Number(row.recruiter_id),
        code: row.code || null,
        displayName: row.display_name || null,
        signupWallet: row.wallet_address || null,
        metadata: row.metadata || {},
        linkedWalletCount: Number(row.links),
        linkedCreatorsCount: Number(row.creators),
        linkedTradersCount: Number(row.traders),
        referredVolumeUsd,
        epochEarnedUsd,
        weightedScore,
      };
    })
    .sort((a, b) =>
      b.weightedScore - a.weightedScore ||
      b.referredVolumeUsd - a.referredVolumeUsd ||
      b.linkedWalletCount - a.linkedWalletCount ||
      a.recruiterId - b.recruiterId);
}

function validSolana(value: unknown): string | null {
  const raw = String(value || "").trim();
  // A signup key stored lowercased (before 2026-07-08) is still "valid" base58 but a different key.
  if (!raw || raw === raw.toLowerCase()) return null;
  try { return new PublicKey(raw).toBase58() === raw ? raw : null; } catch { return null; }
}

function validEvm(value: unknown): string | null {
  const raw = String(value || "").trim();
  return ethers.isAddress(raw) ? raw.toLowerCase() : null;
}

/** The wallet that receives this recruiter's prize on `chainId`, or null if none is valid there. */
export async function recruiterPrizeRecipient(db: Db, standing: RecruiterStanding, chainId: number): Promise<string | null> {
  const solana = chainId === 101 || chainId === 102;
  const payoutChains = solana ? ["solana"] : chainId === 4663 || chainId === 46630 ? ["robinhood", "bnb"] : ["bnb"];
  if (standing.code) {
    const { rows } = await db.query(
      `select w.wallet_address, w.chain from public.recruiter_payout_wallets w
         join public.recruiter_accounts a on a.recruiter_id = w.recruiter_id
        where a.code = $1 and w.chain = any($2::text[]) and w.verified_at is not null
        order by array_position($2::text[], w.chain), w.verified_at desc`,
      [standing.code, payoutChains],
    );
    for (const row of rows) {
      const wallet = solana ? validSolana(row.wallet_address) : validEvm(row.wallet_address);
      if (wallet) return wallet;
    }
  }
  const signup = standing.metadata?.signup || {};
  if (solana) return validSolana(signup.solanaWalletAddress) || validSolana(standing.signupWallet);
  return validEvm(signup.bnbWalletAddress) || validEvm(signup.evmWalletAddress) || validEvm(standing.signupWallet);
}

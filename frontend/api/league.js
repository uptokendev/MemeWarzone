import crypto from "crypto";
import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, json, readJson } from "../server/http.js";
import { persistFinalizedCategory, readFinalizedCategory } from "./lib/finalizeLeagueEpoch.js";
import {
  buildMerkleProof as buildSolanaMerkleProof,
  buildMerkleRoot as buildSolanaMerkleRoot,
  categoryHashBytes,
  deriveLeagueClaimPda,
  deriveLeagueEpochPda,
  deriveRewardsVaults,
  leagueLeaf,
  periodCode as solanaPeriodCode,
} from "./solanaLeagueMerkle.js";

// League categories (LOCKED):
// - perfect_run (monthly only)
// - fastest_finish
// - biggest_hit
// - top_earner (bonding curve trader PnL)
// - crowd_favorite
const CATEGORY_SET = new Set([
  "perfect_run",
  "fastest_finish",
  "biggest_hit",
  "top_earner",
  "crowd_favorite",
  "recruiter_league",
]);

// Accept old period spellings for backward compatibility.
const PERIOD_SET = new Set(["weekly", "monthly", "all", "all_time", "alltime"]);

function isSolanaLeagueChain(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  const raw = String(value || "").trim();
  let n = 0n;
  for (const char of raw) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    n = n * 58n + BigInt(index);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let out = hex === "00" ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leading = 0;
  for (const char of raw) {
    if (char !== "1") break;
    leading += 1;
  }
  if (leading) out = Buffer.concat([Buffer.alloc(leading), out]);
  return out;
}

function verifySolanaLeagueSignature(address, message, signature) {
  try {
    const publicKeyBytes = base58Decode(address);
    if (publicKeyBytes.length !== 32) return false;
    let signatureBytes;
    const sig = String(signature || "").trim();
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(sig) && sig.length >= 64) {
      signatureBytes = base58Decode(sig);
    } else {
      signatureBytes = Buffer.from(sig, "base64");
    }
    if (signatureBytes.length !== 64) return false;
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

function walletsEqual(a, b, solana) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  return solana ? left === right : left.toLowerCase() === right.toLowerCase();
}

function sqlWalletNeq(left, right, solana) {
  return solana ? `(${left} IS DISTINCT FROM ${right})` : `(lower(${left}) <> lower(${right}))`;
}

function sqlDistinctWallet(expr, solana) {
  return solana ? `COUNT(DISTINCT ${expr})` : `COUNT(DISTINCT lower(${expr}))`;
}

function sqlWalletGroup(expr, solana) {
  return solana ? expr : `lower(${expr})`;
}

function clampInt(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function normPeriod(periodRaw) {
  const p = String(periodRaw || "weekly").toLowerCase().trim();
  if (p === "weekly") return "weekly";
  if (p === "monthly") return "monthly";
  return "all_time";
}

// ---------------------------
// Fixed epochs (UTC, locked)
// ---------------------------
// Weekly: Monday 00:00 UTC → next Monday 00:00 UTC
// Monthly: 1st 00:00 UTC → next 1st 00:00 UTC
// For live epoch: rangeEnd = now
// For past epoch: rangeEnd = epochEnd

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function getWeeklyEpochUtc(epochOffset) {
  const now = new Date();
  const today0 = startOfUtcDay(now);
  // JS: 0=Sun..6=Sat. We want Monday-based.
  const dow = today0.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ... Sun=6
  const thisMonday0 = new Date(today0.getTime() - daysSinceMonday * 86400_000);
  const epochStart = new Date(thisMonday0.getTime() - epochOffset * 7 * 86400_000);
  const epochEnd = new Date(epochStart.getTime() + 7 * 86400_000);
  const isLive = epochOffset === 0;
  const rangeEnd = isLive ? now : epochEnd;
  return {
    period: "weekly",
    epochOffset,
    epochStart,
    epochEnd,
    rangeEnd,
    isLive
  };
}

function getMonthlyEpochUtc(epochOffset) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonthStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const epochStart = new Date(Date.UTC(y, m - epochOffset, 1, 0, 0, 0, 0));
  const epochEnd = new Date(Date.UTC(epochStart.getUTCFullYear(), epochStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  // If epochOffset is 0, use thisMonthStart for clarity, but the computed epochStart already matches.
  const isLive = epochOffset === 0;
  const rangeEnd = isLive ? now : epochEnd;
  return {
    period: "monthly",
    epochOffset,
    epochStart,
    epochEnd,
    rangeEnd,
    isLive
  };
}

function getEpoch(periodNorm, epochOffset) {
  if (periodNorm === "weekly") return getWeeklyEpochUtc(epochOffset);
  if (periodNorm === "monthly") return getMonthlyEpochUtc(epochOffset);
  return {
    period: "all_time",
    epochOffset: 0,
    epochStart: null,
    epochEnd: null,
    rangeEnd: null,
    isLive: false
  };
}

// ---------------------------
// Prize pool (league fee only)
// ---------------------------
const DEFAULT_PROTOCOL_FEE_BPS = 200; // 2%
const DEFAULT_LEAGUE_FEE_BPS = 75; // 0.75% slice of gross (carved out of the 2% protocol fee)
const PRIZE_TTL_MS = 60 * 60 * 1000;
const PRIZE_SPLIT_BPS = [4000, 2500, 1500, 1200, 800]; // 40/25/15/12/8

// Split the League fee stream between weekly and monthly prize budgets.
// Weekly budget is paid to 4 categories (1 winner each). Monthly budget is paid to 5 categories (top 5 each).
const DEFAULT_WEEKLY_PRIZE_BUDGET_BPS = 3000; // 30%
const DEFAULT_MONTHLY_PRIZE_BUDGET_BPS = 7000; // 70%

function readBps(name, def) {
  const raw = process?.env?.[name];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return def;
  return Math.trunc(n);
}

function prizeEligibleCategories(periodNorm) {
  if (periodNorm === "weekly") return ["fastest_finish", "biggest_hit", "top_earner", "crowd_favorite"]; // 4
  if (periodNorm === "monthly") return ["perfect_run", "fastest_finish", "biggest_hit", "top_earner", "crowd_favorite"]; // 5
  return null;
}

const prizeCache = new Map(); // key: `${chainId}:${period}` -> { computedAtMs, data }

// Epoch stats cache (cheap, but avoid 5x duplicate queries from the hub)
const statsCache = new Map(); // key: `${chainId}:${periodNorm}:${epochStartIso ?? ''}:${rangeEndIso ?? ''}` -> { computedAtMs, data }

async function getEpochStats(chainId, periodNorm, epochStartIso, rangeEndIso) {
  if (!(periodNorm === "weekly" || periodNorm === "monthly")) return null;

  const key = `${chainId}:${periodNorm}:${epochStartIso ?? ""}:${rangeEndIso ?? ""}`;
  const now = Date.now();
  const cached = statsCache.get(key);
  if (cached && now - cached.computedAtMs < PRIZE_TTL_MS) return cached.data;

  const { rows } = await pool.query(
    `select count(*)::bigint as n
       from public.campaigns c
      where c.chain_id = $1
        and ($2::timestamptz is null or c.created_at_chain >= $2::timestamptz)
        and ($3::timestamptz is null or c.created_at_chain < $3::timestamptz)`,
    [chainId, epochStartIso ?? null, rangeEndIso ?? null]
  );

  const data = {
    campaignsCreated: Number(rows?.[0]?.n ?? 0),
  };

  statsCache.set(key, { computedAtMs: now, data });
  return data;
}

// ---------------------------
// Claims (signature + nonce)
// ---------------------------

function buildClaimMessage({ chainId, recipient, period, epochStart, category, rank, nonce }) {
  const addr = isSolanaLeagueChain(chainId) ? String(recipient).trim() : String(recipient).toLowerCase();
  return [
    "MemeWarzone League",
    "Action: LEAGUE_CLAIM",
    `ChainId: ${chainId}`,
    `Recipient: ${addr}`,
    `Period: ${period}`,
    `EpochStart: ${epochStart}`,
    `Category: ${category}`,
    `Rank: ${rank}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

async function consumeNonce(chainId, address, nonce) {
  // (legacy) - left for reference
  return consumeNonceWithClient(pool, chainId, address, nonce);
}

async function consumeNonceWithClient(client, chainId, address, nonce) {
  const { rows } = await client.query(
    `SELECT nonce, expires_at, used_at
       FROM auth_nonces
      WHERE chain_id = $1 AND address = $2
      LIMIT 1
      FOR UPDATE`,
    [chainId, address]
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found");
  if (row.used_at) throw new Error("Nonce already used");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch");

  await client.query(
    `UPDATE auth_nonces SET used_at = NOW() WHERE chain_id = $1 AND address = $2`,
    [chainId, address]
  );
}

function getRpcUrl(chainId) {
  const perChain = String(process.env[`BSC_RPC_HTTP_${chainId}`] || "").trim();
  if (perChain) return perChain;
  const fallback = String(process.env.BSC_RPC_HTTP || "").trim();
  if (fallback) return fallback;
  throw new Error(`Missing RPC env (BSC_RPC_HTTP_${chainId})`);
}

function getTreasuryVaultV2Address(chainId) {
  const perChain = String(process.env[`TREASURY_VAULT_V2_ADDRESS_${chainId}`] || "").trim();
  if (perChain) return perChain;
  const fallback = String(process.env.TREASURY_VAULT_V2_ADDRESS || "").trim();
  if (fallback) return fallback;
  throw new Error(`Missing TreasuryVaultV2 env (TREASURY_VAULT_V2_ADDRESS_${chainId})`);
}

function getOperatorPk() {
  const pk = String(process.env.LEAGUE_PAYOUT_OPERATOR_PK || "").trim();
  if (!pk) throw new Error("Missing LEAGUE_PAYOUT_OPERATOR_PK");
  return pk;
}


// ---------------------------
// Merkle claims (user-paid gas)
// ---------------------------

function periodCode(period) {
  return period === "weekly" ? 1 : 2;
}

// Deterministic epochId used across:
// - root publishing (rootPoster)
// - proof generation (backend)
// - on-chain claim() calls (frontend)
function computeEpochId(chainId, period, epochStartSec) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const enc = coder.encode(["uint32", "uint8", "uint64"], [chainId, periodCode(period), BigInt(epochStartSec)]);
  const h = ethers.keccak256(enc);
  return BigInt(h);
}

function categoryHashFromString(category) {
  // bytes32 category id: keccak256(utf8(category))
  return ethers.keccak256(ethers.toUtf8Bytes(String(category)));
}

function leafHash({ epochId, categoryHash, rank, recipient, amountRaw }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const enc = coder.encode(
    ["uint256", "bytes32", "uint8", "address", "uint256"],
    [epochId, categoryHash, rank, recipient, BigInt(amountRaw)]
  );
  return ethers.keccak256(enc);
}

function hashPair(a, b) {
  // OpenZeppelin MerkleProof uses a sorted pair hash.
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  const [x, y] = aa <= bb ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

function buildMerkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) return ethers.ZeroHash;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i]; // duplicate last if odd
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return layer[0];
}

function buildMerkleProof(leaves, leafIndex) {
  if (!Array.isArray(leaves) || leaves.length === 0) return [];
  let idx = leafIndex;
  let layer = leaves.slice();
  const proof = [];
  while (layer.length > 1) {
    const isRight = idx % 2 === 1;
    const pairIndex = isRight ? idx - 1 : idx + 1;
    const sibling = pairIndex < layer.length ? layer[pairIndex] : layer[idx];
    proof.push(sibling);

    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

async function sendOnchainPayout({ chainId, vaultAddress, recipient, amountRaw }) {
  const rpc = getRpcUrl(chainId);
  // ethers v6: always pin network — bare JsonRpcProvider(url) spam-logs detect-network retries.
  const network = ethers.Network.from(Number(chainId));
  const provider = new ethers.JsonRpcProvider(rpc, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  });
  const wallet = new ethers.Wallet(getOperatorPk(), provider);

  const abi = [
    "function payout(address payable to, uint256 amount) external",
  ];
  const vault = new ethers.Contract(vaultAddress, abi, wallet);
  const tx = await vault.payout(recipient, amountRaw);
  return { txHash: tx.hash };
}

function splitPotRaw(potRawBigInt) {
  const pot = BigInt(potRawBigInt);
  const payouts = PRIZE_SPLIT_BPS.map((bps) => (pot * BigInt(bps)) / 10000n);
  const sum = payouts.reduce((a, b) => a + b, 0n);
  // Push rounding dust to #1 so totals reconcile.
  payouts[0] = payouts[0] + (pot - sum);
  return payouts.map((x) => x.toString());
}

async function computeTotalLeagueFeeRawInRange(chainId, startIso, endIso, protocolFeeBps, leagueFeeBps) {
  // IMPORTANT:
  // curve_trades.bnb_amount_raw is:
  // - buy: total paid = gross + floor(gross * protocolFeeBps / 10000)
  // - sell: net payout = gross - floor(gross * protocolFeeBps / 10000)
  // We invert to gross using an integer-safe candidate +/- 2 wei check, then compute:
  // league_fee = floor(gross * leagueFeeBps / 10000)
  const { rows } = await pool.query(
    `
    WITH trades AS (
      SELECT
        t.side,
        t.bnb_amount_raw::numeric AS amt
      FROM public.curve_trades t
      WHERE t.chain_id = $1
        AND ($2::timestamptz IS NULL OR t.block_time >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR t.block_time < $3::timestamptz)
    ),
    base AS (
      SELECT
        side,
        amt,
        floor((amt * 10000) / (10000 + $4)) AS buy_g0,
        ceiling((amt * 10000) / (10000 - $4)) AS sell_g0
      FROM trades
    ),
    calc AS (
      SELECT
        side,
        CASE
          WHEN side = 'buy' THEN (
            CASE
              WHEN (buy_g0 + floor((buy_g0 * $4) / 10000)) = amt THEN buy_g0
              WHEN ((buy_g0 + 1) + floor(((buy_g0 + 1) * $4) / 10000)) = amt THEN buy_g0 + 1
              WHEN ((buy_g0 + 2) + floor(((buy_g0 + 2) * $4) / 10000)) = amt THEN buy_g0 + 2
              WHEN (greatest(buy_g0 - 1, 0) + floor((greatest(buy_g0 - 1, 0) * $4) / 10000)) = amt THEN greatest(buy_g0 - 1, 0)
              WHEN (greatest(buy_g0 - 2, 0) + floor((greatest(buy_g0 - 2, 0) * $4) / 10000)) = amt THEN greatest(buy_g0 - 2, 0)
              ELSE buy_g0
            END
          )
          ELSE (
            CASE
              WHEN (sell_g0 - floor((sell_g0 * $4) / 10000)) = amt THEN sell_g0
              WHEN (greatest(sell_g0 - 1, 0) - floor((greatest(sell_g0 - 1, 0) * $4) / 10000)) = amt THEN greatest(sell_g0 - 1, 0)
              WHEN (greatest(sell_g0 - 2, 0) - floor((greatest(sell_g0 - 2, 0) * $4) / 10000)) = amt THEN greatest(sell_g0 - 2, 0)
              WHEN ((sell_g0 + 1) - floor(((sell_g0 + 1) * $4) / 10000)) = amt THEN sell_g0 + 1
              WHEN ((sell_g0 + 2) - floor(((sell_g0 + 2) * $4) / 10000)) = amt THEN sell_g0 + 2
              ELSE sell_g0
            END
          )
        END AS gross
      FROM base
    ),
    fees AS (
      SELECT floor((gross * $5) / 10000) AS league_fee
      FROM calc
    )
    SELECT COALESCE(sum(league_fee), 0)::numeric(78, 0) AS total_league_fee_raw
    FROM fees;
    `,
    [chainId, startIso ?? null, endIso ?? null, protocolFeeBps, leagueFeeBps]
  );

  const v = rows?.[0]?.total_league_fee_raw;
  // Always return integer string.
  return String(v ?? "0");
}

async function getPrizeMeta(chainId, periodNorm, epochStartIso, rangeEndIso) {
  const eligible = prizeEligibleCategories(periodNorm);
  if (!eligible) return null;

  // Keyed by epoch start so we never bleed between epochs on warm instances.
  const key = `${chainId}:${periodNorm}:${epochStartIso ?? ""}`;
  const now = Date.now();
  const cached = prizeCache.get(key);
  if (cached && now - cached.computedAtMs < PRIZE_TTL_MS) return cached.data;

  const protocolFeeBps = readBps("PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS);
  const leagueFeeBps = readBps("LEAGUE_FEE_BPS", DEFAULT_LEAGUE_FEE_BPS);

  const totalLeagueFeeRaw = await computeTotalLeagueFeeRawInRange(
    chainId,
    epochStartIso ?? null,
    rangeEndIso ?? null,
    protocolFeeBps,
    leagueFeeBps
  );
  const total = BigInt(totalLeagueFeeRaw);

  const weeklyBudgetBps = readBps("WEEKLY_PRIZE_BUDGET_BPS", DEFAULT_WEEKLY_PRIZE_BUDGET_BPS);
  const monthlyBudgetBps = readBps("MONTHLY_PRIZE_BUDGET_BPS", DEFAULT_MONTHLY_PRIZE_BUDGET_BPS);
  const budgetBps = periodNorm === "weekly" ? weeklyBudgetBps : periodNorm === "monthly" ? monthlyBudgetBps : 10_000;
  const budget = (total * BigInt(budgetBps)) / 10_000n;

  const leagueCount = eligible.length;
  const base = leagueCount > 0 ? budget / BigInt(leagueCount) : 0n;
  const rem = leagueCount > 0 ? budget % BigInt(leagueCount) : 0n;

  const byCategory = {};
  for (let i = 0; i < eligible.length; i++) {
    const cat = eligible[i];
    const pot = base + (BigInt(i) < rem ? 1n : 0n); // spread dust evenly (<= 1 wei difference)
    byCategory[cat] = {
      potRaw: pot.toString(),
      payoutsRaw: splitPotRaw(pot)
    };
  }

  // Add per-category rollover amount for this epoch (if present).
  // Rollovers are a ledger of funds carried into this epoch from:
  // - expired, unclaimed prizes (swept into next epoch)
  // - no-clear-winner outcomes (e.g., ties / Perfect Run edge cases)
  if (epochStartIso) {
    try {
      const { rows: rrows } = await pool.query(
        `select category, coalesce(sum(amount_raw::numeric), 0)::numeric(78,0) as amount_raw
           from public.league_rollovers
          where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz
          group by category`,
        [chainId, periodNorm, epochStartIso]
      );

      for (const rr of rrows) {
        const cat = String(rr.category || "");
        if (!byCategory[cat]) continue;
        const rollover = BigInt(String(rr.amount_raw ?? "0"));
        if (rollover <= 0n) continue;

        const basePot = BigInt(byCategory[cat].potRaw);
        const nextPot = basePot + rollover;
        byCategory[cat] = {
          ...byCategory[cat],
          rolloverRaw: rollover.toString(),
          potRaw: nextPot.toString(),
          payoutsRaw: splitPotRaw(nextPot)
        };
      }
    } catch {
      // If the rollover table isn't deployed yet, ignore (backward compatible).
    }

    // Subtract payouts already executed for this epoch (so UI can show *available* pools).
    // This makes the displayed pools reconcile with the on-chain vault balance *after payouts*.
    try {
      const { rows: prows } = await pool.query(
        `select category, coalesce(sum(amount_raw), 0)::numeric(78,0) as paid_raw
           from public.league_epoch_payouts
          where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz
          group by category`,
        [chainId, periodNorm, epochStartIso]
      );

      for (const pr of prows) {
        const cat = String(pr.category || "");
        if (!byCategory[cat]) continue;
        const paid = BigInt(String(pr.paid_raw ?? "0"));
        if (paid <= 0n) continue;

        const potNow = BigInt(String(byCategory[cat].potRaw ?? "0"));
        const available = potNow > paid ? (potNow - paid) : 0n;
        byCategory[cat] = {
          ...byCategory[cat],
          paidRaw: paid.toString(),
          availablePotRaw: available.toString(),
          availablePayoutsRaw: splitPotRaw(available)
        };
      }
    } catch {
      // If payouts table isn't deployed yet, treat as zero paid.
    }

    // Ensure available fields exist even when no payouts were recorded.
    for (const cat of Object.keys(byCategory)) {
      const x = byCategory[cat];
      if (x && typeof x.availablePotRaw === "undefined") {
        const potNow = BigInt(String(x.potRaw ?? "0"));
        byCategory[cat] = {
          ...x,
          paidRaw: String(x.paidRaw ?? "0"),
          availablePotRaw: potNow.toString(),
          availablePayoutsRaw: splitPotRaw(potNow)
        };
      }
    }
  }

  const data = {
    basis: "league_fee_only",
    period: periodNorm,
    cutoff: epochStartIso,
    rangeEnd: rangeEndIso,
    computedAt: new Date(now).toISOString(),
    protocolFeeBps,
    leagueFeeBps,
    totalLeagueFeeRaw: total.toString(),
    leagueCount,
    winners: 5,
    splitBps: PRIZE_SPLIT_BPS,
    byCategory
  };

  prizeCache.set(key, { computedAtMs: now, data });
  return data;
}

export default async function handler(req, res) {
  // POST = claim a finalized prize (Profile -> Rewards)
  if (req.method === "POST") {
    try {
      const b = await readJson(req);
      const action = String(b.action ?? "").toLowerCase().trim();
      if (!(action === "claim" || action === "record")) return json(res, 400, { error: "Invalid action" });

      const chainId = Number(b.chainId);
      const period = String(b.period ?? "").toLowerCase().trim();
      const epochStart = String(b.epochStart ?? "").trim();
      const category = String(b.category ?? "").toLowerCase().trim();
      const rank = Number(b.rank);
      const rawRecipient = String(b.recipient ?? b.address ?? "").trim();
      const solanaClaim = isSolanaLeagueChain(chainId);
      const recipient = solanaClaim ? rawRecipient : rawRecipient.toLowerCase();
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");

      const txHash = String(b.txHash ?? "").trim();

      if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
      if (solanaClaim ? !isSolanaAddress(recipient) : !isAddress(recipient)) {
        return json(res, 400, { error: "Invalid recipient" });
      }
      if (!(period === "weekly" || period === "monthly")) return json(res, 400, { error: "Invalid period" });
      if (!CATEGORY_SET.has(category)) return json(res, 400, { error: "Invalid category" });
      if (!Number.isFinite(rank) || rank < 1 || rank > 5) return json(res, 400, { error: "Invalid rank" });
      if (!epochStart) return json(res, 400, { error: "epochStart missing" });
      if (!nonce) return json(res, 400, { error: "Nonce missing" });
      if (!signature) return json(res, 400, { error: "Signature missing" });
      if (action === "record") {
        const evmTx = /^0x[0-9a-fA-F]{64}$/.test(txHash);
        const solTx = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(txHash);
        if (!txHash || (solanaClaim ? !solTx : !evmTx)) return json(res, 400, { error: "Invalid txHash" });
      }
      if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

      const msg = buildClaimMessage({ chainId, recipient, period, epochStart, category, rank, nonce });
      if (solanaClaim) {
        const ok = verifySolanaLeagueSignature(recipient, msg, signature);
        if (!ok) return json(res, 401, { error: "Invalid signature" });
      } else {
        const recovered = ethers.verifyMessage(msg, signature).toLowerCase();
        if (recovered !== recipient) return json(res, 401, { error: "Invalid signature" });
      }

      if (!solanaClaim) {
        const vaultAddress = getTreasuryVaultV2Address(chainId);
        if (!isAddress(vaultAddress)) return json(res, 500, { error: "Server misconfigured: bad TreasuryVaultV2 address" });
      }
      const vaultAddress = solanaClaim ? deriveRewardsVaults().leagueVault : getTreasuryVaultV2Address(chainId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Lock per winner slot so we can safely enforce "pay once".
        const lockKey = `${chainId}:${period}:${epochStart}:${category}:${rank}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

        // Nonce must match the *recipient* (wallet) signing the claim.
        await consumeNonceWithClient(client, chainId, recipient, nonce);

        // Winner must exist, and must belong to recipient.
        const { rows: wrows } = await client.query(
          `SELECT epoch_end AS "epochEnd", expires_at AS "expiresAt", recipient_address AS "recipientAddress", amount_raw AS "amountRaw"
             FROM league_epoch_winners
            WHERE chain_id = $1
              AND period = $2
              AND epoch_start = $3::timestamptz
              AND category = $4
              AND rank = $5
            LIMIT 1`,
          [chainId, period, epochStart, category, rank]
        );
        const w = wrows[0];
        if (!w) {
          await client.query("ROLLBACK");
          return json(res, 404, { error: "Winner not found" });
        }
        if (!walletsEqual(w.recipientAddress, recipient, solanaClaim)) {
          await client.query("ROLLBACK");
          return json(res, 403, { error: "Not the winner" });
        }

        // Only allow claims after epoch end.
        const epochEndMs = w.epochEnd ? new Date(w.epochEnd).getTime() : 0;
        if (epochEndMs && Date.now() < epochEndMs) {
          await client.query("ROLLBACK");
          return json(res, 400, { error: "Epoch not finalized" });
        }

        // Enforce claim expiry (default: 90 days after epoch_end)
        const expiresMs = w.expiresAt ? new Date(w.expiresAt).getTime() : 0;
        if (expiresMs && Date.now() > expiresMs) {
          await client.query("ROLLBACK");
          return json(res, 410, { error: "Claim expired" });
        }

        // If already paid, return existing tx (idempotent claim).
        const { rows: prows } = await client.query(
          `SELECT tx_hash AS "txHash", paid_at AS "paidAt"
             FROM league_epoch_payouts
            WHERE chain_id = $1 AND period = $2 AND epoch_start = $3::timestamptz AND category = $4 AND rank = $5
            LIMIT 1`,
          [chainId, period, epochStart, category, rank]
        );
        const already = prows[0];
        if (already?.txHash) {
          // Ensure we still record the claim for UX/history.
          await client.query(
            `INSERT INTO league_epoch_claims (chain_id, period, epoch_start, category, rank, recipient_address, signature)
             VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)
             ON CONFLICT (chain_id, period, epoch_start, category, rank)
             DO NOTHING`,
            [chainId, period, epochStart, category, rank, recipient, signature]
          );
          await client.query("COMMIT");
          return json(res, 200, { ok: true, claimedAt: already.paidAt ? new Date(already.paidAt).toISOString() : null, amountRaw: w.amountRaw, txHash: already.txHash });
        }


        // Merkle-claim flow:
        // - action=claim  -> return proof payload; user sends on-chain claim() and pays gas
        // - action=record -> after tx is mined, record the txHash so rewards are suppressed
        if (action === "claim") {
          const epochStartSec = Math.floor(new Date(epochStart).getTime() / 1000);
          const eid = computeEpochId(chainId, period, epochStartSec);
          const catHash = categoryHashFromString(category);

          // Build the merkle set from all winners for this epoch.
          const { rows: arows } = await client.query(
            `SELECT category, rank, recipient_address AS "recipientAddress", amount_raw AS "amountRaw"
               FROM league_epoch_winners
              WHERE chain_id = $1 AND period = $2 AND epoch_start = $3::timestamptz
              ORDER BY category ASC, rank ASC, recipient_address ASC`,
            [chainId, period, epochStart]
          );

          if (!arows?.length) {
            await client.query("ROLLBACK");
            return json(res, 500, { error: "No winners for epoch" });
          }

          const leaves = [];
          let leafIndex = -1;
          let epochTotal = 0n;

          for (let i = 0; i < arows.length; i++) {
            const row = arows[i];
            const rowCat = String(row.category || "").toLowerCase().trim();
            const rowRank = Number(row.rank);
            const rowRecipient = solanaClaim
              ? String(row.recipientAddress || "").trim()
              : String(row.recipientAddress || "").toLowerCase();
            const rowAmt = BigInt(String(row.amountRaw));
            epochTotal += rowAmt;

            const rowLeaf = solanaClaim
              ? leagueLeaf({
                  epochStartSec,
                  period,
                  category: rowCat,
                  rank: rowRank,
                  recipient: rowRecipient,
                  amountRaw: rowAmt,
                })
              : leafHash({
                  epochId: eid,
                  categoryHash: categoryHashFromString(rowCat),
                  rank: rowRank,
                  recipient: rowRecipient,
                  amountRaw: rowAmt,
                });

            leaves.push(rowLeaf);

            if (rowCat === category && rowRank === rank && walletsEqual(rowRecipient, recipient, solanaClaim)) {
              leafIndex = i;
            }
          }

          if (leafIndex < 0) {
            await client.query("ROLLBACK");
            return json(res, 500, { error: "Leaf not found (winner mismatch)" });
          }

          const root = solanaClaim ? buildSolanaMerkleRoot(leaves) : buildMerkleRoot(leaves);
          const proof = solanaClaim ? buildSolanaMerkleProof(leaves, leafIndex) : buildMerkleProof(leaves, leafIndex);

          // Record the claim request for UX/audit, but do NOT mark paid here.
          await client.query(
            `INSERT INTO league_epoch_claims (chain_id, period, epoch_start, category, rank, recipient_address, signature)
             VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)
             ON CONFLICT (chain_id, period, epoch_start, category, rank)
             DO NOTHING`,
            [chainId, period, epochStart, category, rank, recipient, signature]
          );

          await client.query("COMMIT");
          if (solanaClaim) {
            const vaults = deriveRewardsVaults();
            return json(res, 200, {
              ok: true,
              mode: "solana_treasury",
              programId: vaults.programId,
              vaultAddress: vaults.leagueVault,
              configAddress: vaults.config,
              epochAddress: deriveLeagueEpochPda(period, epochStartSec),
              claimReceiptAddress: deriveLeagueClaimPda(period, epochStartSec, category, rank),
              periodCode: solanaPeriodCode(period),
              epochStartSec,
              epochTotal: epochTotal.toString(),
              root,
              categoryHash: `0x${categoryHashBytes(category).toString("hex")}`,
              recipient,
              rank,
              amountRaw: String(w.amountRaw),
              proof,
            });
          }
          return json(res, 200, {
            ok: true,
            mode: "merkle",
            vaultAddress,
            epochId: eid.toString(),
            epochTotal: epochTotal.toString(),
            root,
            categoryHash: catHash,
            recipient,
            rank,
            amountRaw: String(w.amountRaw),
            proof,
          });
        }

        // action === "record"
        // Record the txHash after the user successfully claimed on-chain.
        await client.query(
          `INSERT INTO league_epoch_claims (chain_id, period, epoch_start, category, rank, recipient_address, signature)
           VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)
           ON CONFLICT (chain_id, period, epoch_start, category, rank)
           DO NOTHING`,
          [chainId, period, epochStart, category, rank, recipient, signature]
        );

        await client.query(
          `INSERT INTO league_epoch_payouts (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
           VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8)
           ON CONFLICT (chain_id, period, epoch_start, category, rank)
           DO UPDATE SET tx_hash = excluded.tx_hash, paid_at = now(), recipient_address = excluded.recipient_address, amount_raw = excluded.amount_raw`,
          [chainId, period, epochStart, category, rank, recipient, String(w.amountRaw), txHash]
        );

        const { rows: crows } = await client.query(
          `SELECT claimed_at AS "claimedAt"
             FROM league_epoch_claims
            WHERE chain_id = $1 AND period = $2 AND epoch_start = $3::timestamptz AND category = $4 AND rank = $5
            LIMIT 1`,
          [chainId, period, epochStart, category, rank]
        );
        const claimedAt = crows?.[0]?.claimedAt ? new Date(crows[0].claimedAt).toISOString() : null;

        await client.query("COMMIT");
        return json(res, 200, { ok: true, claimedAt, amountRaw: w.amountRaw, txHash });
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      const msg = String(e?.message ?? "");
      const isAuth = /nonce|signature/i.test(msg);
      console.error("[api/league claim]", e);
      return json(res, isAuth ? 401 : 500, { error: isAuth ? msg : "Server error" });
    }
  }

  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId ?? 56);
    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

    const category = String(q.category ?? "").toLowerCase().trim();
    if (!CATEGORY_SET.has(category)) return json(res, 400, { error: "Invalid category" });

    // Recruiter standings live in a dedicated handler (squad-size weighted score).
    if (category === "recruiter_league") {
      const { default: leagueRecruiter } = await import("./leagueRecruiter.js");
      return leagueRecruiter(req, res);
    }

    const periodRaw = String(q.period ?? "weekly").toLowerCase().trim();
    if (!PERIOD_SET.has(periodRaw)) return json(res, 400, { error: "Invalid period" });

    const periodNorm = normPeriod(periodRaw);
    const epochOffset =
      periodNorm === "weekly"
        ? clampInt(q.epochOffset ?? 0, 0, 2, 0)
        : periodNorm === "monthly"
          ? clampInt(q.epochOffset ?? 0, 0, 1, 0)
          : 0;

    const epoch = getEpoch(periodNorm, epochOffset);
    const epochStartIso = epoch?.epochStart ? epoch.epochStart.toISOString() : null;
    const epochEndIso = epoch?.epochEnd ? epoch.epochEnd.toISOString() : null;
    const rangeEndIso = epoch?.rangeEnd ? epoch.rangeEnd.toISOString() : null;

    const limit = clampInt(q.limit ?? 10, 1, 50, 10);

    // Prize meta is computed once per chain/period per warm instance (and TTL = 1h).
    // This prevents recomputing fee totals on every category request.
    const prizeMeta = await getPrizeMeta(chainId, periodNorm, epochStartIso, rangeEndIso);

    // Hub stats (cached for 1h)
    const stats = await getEpochStats(chainId, periodNorm, epochStartIso, rangeEndIso);
    const prizeForCategory = prizeMeta?.byCategory?.[category]
      ? {
          basis: prizeMeta.basis,
          period: prizeMeta.period,
          cutoff: prizeMeta.cutoff,
          rangeEnd: prizeMeta.rangeEnd,
          computedAt: prizeMeta.computedAt,
          totalLeagueFeeRaw: prizeMeta.totalLeagueFeeRaw,
          leagueCount: prizeMeta.leagueCount,
          winners: prizeMeta.winners,
          splitBps: prizeMeta.splitBps,
          potRaw: prizeMeta.byCategory[category].potRaw,
          payoutsRaw: prizeMeta.byCategory[category].payoutsRaw,
          rolloverRaw: prizeMeta.byCategory[category].rolloverRaw,
          paidRaw: prizeMeta.byCategory[category].paidRaw,
          availablePotRaw: prizeMeta.byCategory[category].availablePotRaw,
          availablePayoutsRaw: prizeMeta.byCategory[category].availablePayoutsRaw
        }
      : undefined;

    const epochMeta =
      periodNorm === "weekly" || periodNorm === "monthly"
        ? {
            period: periodNorm,
            epochOffset,
            epochStart: epochStartIso,
            epochEnd: epochEndIso,
            rangeEnd: rangeEndIso,
            status: epoch.isLive ? "live" : "finalized"
          }
        : undefined;

    if (!epoch.isLive && epochStartIso) {
      const frozen = await readFinalizedCategory(pool, {
        chainId,
        period: periodNorm,
        epochStartIso,
        category,
      });
      if (frozen?.items?.length) {
        return json(res, 200, {
          items: frozen.items,
          prize: prizeForCategory,
          epoch: { ...epochMeta, status: "finalized", source: frozen.source },
          stats,
          finalized: true,
        });
      }
    }

    const finishStandings = async (items, extra = {}) => {
      const allowPageWrite = String(process.env.LEAGUE_PAGE_WRITE_WINNERS || "").trim() === "1";
      if (!epoch.isLive && epochStartIso && allowPageWrite) {
        const persistPrize = {
          ...(prizeForCategory || {}),
          protocolFeeBps: prizeMeta?.protocolFeeBps,
          leagueFeeBps: prizeMeta?.leagueFeeBps,
          totalLeagueFeeRaw: prizeMeta?.totalLeagueFeeRaw,
          leagueCount: prizeMeta?.leagueCount,
        };
        await persistFinalizedCategory(pool, {
          chainId,
          period: periodNorm,
          epochStartIso,
          epochEndIso,
          category,
          rows: items,
          prize: persistPrize,
        });
        const frozen = await readFinalizedCategory(pool, {
          chainId,
          period: periodNorm,
          epochStartIso,
          category,
        });
        if (frozen?.items?.length) {
          return json(res, 200, {
            items: frozen.items,
            prize: prizeForCategory,
            epoch: { ...epochMeta, status: "finalized", source: frozen.source },
            stats,
            finalized: true,
            ...extra,
          });
        }
      }
      return json(res, 200, {
        items,
        prize: prizeForCategory,
        epoch: epoch.isLive ? epochMeta : { ...epochMeta, status: "pending_finalization", source: "live_estimate" },
        stats,
        finalized: false,
        ...extra,
        warning:
          extra.warning ||
          (!epoch.isLive
            ? "Previous-week standings are estimates until cron:finalize-epoch-winners writes league_epoch_winners."
            : undefined),
      });
    };

    // -------------------------------------------------
    // Fastest Finish
    // -------------------------------------------------
    if (category === "fastest_finish") {
      const params = [chainId, epochStartIso, rangeEndIso, limit];
      // Mainnet keeps the 25 unique non-creator buyer bar. Testnet (97) uses 0 so a real
      // graduation still ranks even when only creator/few wallets participated.
      const minUniqueBuyers = chainId === 97 || isSolanaLeagueChain(chainId) ? 0 : 25;

      const { rows } = await pool.query(
        `
        WITH grads AS (
          SELECT
            c.chain_id,
            c.campaign_address,
            c.token_address,
            c.name,
            c.symbol,
            c.logo_uri,
            c.creator_address,
            c.created_at_chain,
            c.graduated_at_chain,
            c.created_block,
            c.graduated_block,
            EXTRACT(EPOCH FROM (c.graduated_at_chain - c.created_at_chain))::bigint AS duration_seconds,
            (
              SELECT ${sqlDistinctWallet("t.wallet", isSolanaLeagueChain(chainId))}
              FROM curve_trades t
              WHERE t.chain_id = c.chain_id
                AND t.campaign_address = c.campaign_address
                AND t.side = 'buy'
                AND (c.created_block IS NULL OR t.block_number >= c.created_block)
                AND (c.graduated_block IS NULL OR c.graduated_block = 0 OR t.block_number <= c.graduated_block)
                AND (
                  c.creator_address IS NULL
                  OR ${sqlWalletNeq("t.wallet", "c.creator_address", isSolanaLeagueChain(chainId))}
                )
            ) AS unique_buyers
          FROM campaigns c
          WHERE c.chain_id = $1
            AND c.created_at_chain IS NOT NULL
            AND c.graduated_at_chain IS NOT NULL
            -- Prefer graduated_block when present, but do not drop grads that only have graduated_at_chain.
            AND ($2::timestamptz IS NULL OR c.graduated_at_chain >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR c.graduated_at_chain < $3::timestamptz)
        )
        SELECT *
        FROM grads
        WHERE unique_buyers >= $5::int
        ORDER BY duration_seconds ASC NULLS LAST, graduated_at_chain ASC
        LIMIT $4
        `,
        [...params, minUniqueBuyers]
      );

      return finishStandings(rows);
    }

    // -------------------------------------------------
    // Perfect Run (monthly only)
    // -------------------------------------------------
    if (category === "perfect_run") {
      // Locked rule: monthly only. If caller asks weekly/all-time, respond empty.
      if (periodNorm !== "monthly") {
        return json(res, 200, { items: [], warning: "perfect_run is monthly only", prize: prizeForCategory, epoch: epochMeta, stats });
      }

      const params = [chainId, epochStartIso, rangeEndIso, limit];

      const { rows } = await pool.query(
        `
        WITH qualified AS (
          SELECT
            c.chain_id,
            c.campaign_address,
            c.name,
            c.symbol,
            c.logo_uri,
            c.creator_address,
            c.created_at_chain,
            c.graduated_at_chain,
            c.created_block,
            c.graduated_block,
            EXTRACT(EPOCH FROM (c.graduated_at_chain - c.created_at_chain))::bigint AS duration_seconds,
            0::int AS sells_count,
            (
              SELECT COUNT(DISTINCT t.wallet)
              FROM curve_trades t
              WHERE t.chain_id = c.chain_id
                AND t.campaign_address = c.campaign_address
                AND t.side = 'buy'
                AND t.block_number >= c.created_block
                AND (c.graduated_block IS NULL OR t.block_number <= c.graduated_block)
                AND (c.creator_address IS NULL OR ${sqlWalletNeq("t.wallet", "c.creator_address", isSolanaLeagueChain(chainId))})
            ) AS unique_buyers,
            (
              SELECT COALESCE(SUM(t.bnb_amount_raw::numeric), 0)::numeric(78,0)
              FROM curve_trades t
              WHERE t.chain_id = c.chain_id
                AND t.campaign_address = c.campaign_address
                AND t.side = 'buy'
                AND t.block_number >= c.created_block
                AND (c.graduated_block IS NULL OR t.block_number <= c.graduated_block)
                AND (c.creator_address IS NULL OR ${sqlWalletNeq("t.wallet", "c.creator_address", isSolanaLeagueChain(chainId))})
            ) AS buy_total_raw
          FROM campaigns c
          WHERE c.chain_id = $1
            AND c.created_at_chain IS NOT NULL
            AND c.graduated_at_chain IS NOT NULL
            AND ($2::timestamptz IS NULL OR c.graduated_at_chain >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR c.graduated_at_chain < $3::timestamptz)
            AND NOT EXISTS (
              SELECT 1
              FROM curve_trades t
              WHERE t.chain_id = c.chain_id
                AND t.campaign_address = c.campaign_address
                AND t.side = 'sell'
                AND t.block_number >= c.created_block
                AND (c.graduated_block IS NULL OR t.block_number <= c.graduated_block)
            )
        )
        SELECT *
        FROM qualified
        ORDER BY buy_total_raw DESC, unique_buyers DESC, duration_seconds ASC
        LIMIT $4
        `,
        params
      );

      return finishStandings(rows, {
        warning: rows.length ? undefined : "No Perfect Run qualifiers found for this monthly epoch.",
      });
    }

    // -------------------------------------------------
    // Biggest Hit (largest single buy in bonding)
    // One rank per campaign in the selected epoch (weekly OR monthly window).
    // Weekly and monthly are independent live boards over different [epochStart, rangeEnd).
    // -------------------------------------------------
    if (category === "biggest_hit") {
      const params = [chainId, epochStartIso, rangeEndIso, limit];

      const { rows } = await pool.query(
        `
        WITH buys AS (
          SELECT
            t.chain_id,
            t.campaign_address,
            c.name,
            c.symbol,
            c.logo_uri,
            c.creator_address,
            c.fee_recipient_address,
            c.token_address,
            t.wallet AS buyer_address,
            t.bnb_amount_raw,
            t.tx_hash,
            t.log_index,
            t.block_number,
            t.block_time,
            ROW_NUMBER() OVER (
              PARTITION BY t.campaign_address
              ORDER BY t.bnb_amount_raw::numeric DESC NULLS LAST, t.block_number DESC, t.log_index DESC
            ) AS rn
          FROM curve_trades t
          JOIN campaigns c
            ON c.chain_id = t.chain_id
           AND c.campaign_address = t.campaign_address
          WHERE t.chain_id = $1
            AND t.side = 'buy'
            AND ($2::timestamptz IS NULL OR t.block_time >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR t.block_time < $3::timestamptz)
            AND t.wallet <> c.campaign_address
            AND (c.creator_address IS NULL OR t.wallet <> c.creator_address)
            AND (c.fee_recipient_address IS NULL OR t.wallet <> c.fee_recipient_address)
            AND (c.graduated_block IS NULL OR c.graduated_block = 0 OR t.block_number <= c.graduated_block)
        )
        SELECT
          chain_id,
          campaign_address,
          name,
          symbol,
          logo_uri,
          creator_address,
          fee_recipient_address,
          token_address,
          buyer_address,
          bnb_amount_raw,
          tx_hash,
          log_index,
          block_number,
          block_time
        FROM buys
        WHERE rn = 1
        ORDER BY bnb_amount_raw::numeric DESC NULLS LAST, block_number DESC, log_index DESC
        LIMIT $4
        `,
        params
      );

      return finishStandings(rows);
    }

    // -------------------------------------------------
    // Crowd Favorite (most upvotes)
    // -------------------------------------------------
    if (category === "crowd_favorite") {
      const params = [chainId, epochStartIso, rangeEndIso, limit];

      // IMPORTANT: Our indexer writes paid upvotes (VoteCast events) to public.votes.
      // Strict places (1,2,3…) with fair tie-breaks — never shared rank:
      // 1) vote count  2) unique voters  3) total BNB voted
      // 4) earliest vote in epoch (first to that score)  5) campaign address
      const { rows } = await pool.query(
        `
        WITH agg AS (
          SELECT
            v.chain_id,
            v.campaign_address,
            COUNT(*)::bigint AS votes_count,
            COUNT(DISTINCT v.voter_address)::bigint AS unique_voters,
            COALESCE(SUM(v.amount_raw), 0)::numeric AS amount_raw_sum,
            MIN(v.block_timestamp) AS first_vote_at,
            MIN(v.block_number) AS first_vote_block
          FROM public.votes v
          WHERE v.chain_id = $1
            AND ($2::timestamptz IS NULL OR v.block_timestamp >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR v.block_timestamp < $3::timestamptz)
          GROUP BY v.chain_id, v.campaign_address
        )
        SELECT
          a.chain_id,
          a.campaign_address,
          c.name,
          c.symbol,
          c.logo_uri,
          c.creator_address,
          a.votes_count,
          a.unique_voters,
          a.amount_raw_sum,
          a.first_vote_at,
          a.first_vote_block
        FROM agg a
        JOIN public.campaigns c
          ON c.chain_id = a.chain_id
         AND c.campaign_address = a.campaign_address
        ORDER BY
          a.votes_count DESC,
          a.unique_voters DESC,
          a.amount_raw_sum DESC,
          a.first_vote_at ASC NULLS LAST,
          a.first_vote_block ASC NULLS LAST,
          a.campaign_address ASC
        LIMIT $4
        `,
        params
      );

      return finishStandings(rows);
    }

    // -------------------------------------------------
    // Top Earner (bonding curve trader PnL)
    // -------------------------------------------------
    // Locked rule update:
    // - trader (NOT campaign owner)
    // - realized net BNB profit from curve trades in the period
    //   profit = sum(sell payouts) - sum(buy costs)
    if (category === "top_earner") {
      if (periodNorm === "all_time") {
        return json(res, 200, {
          items: [],
          warning: "top_earner is paid weekly/monthly only",
          prize: prizeForCategory,
          epoch: epochMeta,
          stats,
        });
      }

      const params = [chainId, epochStartIso, rangeEndIso, limit];

      // Realized curve PnL in the epoch. Own-campaign creator trades excluded; same wallet
      // trading other campaigns counts. Prefer positive profit; if none, show best nets
      // among wallets that completed at least one sell (still ranked by profit).
      const { rows } = await pool.query(
        `
        WITH filtered AS (
          SELECT
            ${sqlWalletGroup("t.wallet", isSolanaLeagueChain(chainId))} AS wallet,
            t.side,
            t.bnb_amount_raw::numeric AS bnb_raw
          FROM public.curve_trades t
          JOIN public.campaigns c
            ON c.chain_id = t.chain_id
           AND c.campaign_address = t.campaign_address
          WHERE t.chain_id = $1
            AND t.wallet IS NOT NULL
            AND ($2::timestamptz IS NULL OR t.block_time >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR t.block_time < $3::timestamptz)
            AND ${sqlWalletNeq("t.wallet", "c.campaign_address", isSolanaLeagueChain(chainId))}
            AND (c.creator_address IS NULL OR ${sqlWalletNeq("t.wallet", "c.creator_address", isSolanaLeagueChain(chainId))})
            AND (c.fee_recipient_address IS NULL OR ${sqlWalletNeq("t.wallet", "c.fee_recipient_address", isSolanaLeagueChain(chainId))})
        ),
        agg AS (
          SELECT
            wallet,
            SUM(CASE WHEN side = 'sell' THEN bnb_raw ELSE 0 END)::numeric(78,0) AS sells_raw,
            SUM(CASE WHEN side = 'buy' THEN bnb_raw ELSE 0 END)::numeric(78,0) AS buys_raw,
            COUNT(*)::bigint AS trades_count,
            COUNT(*) FILTER (WHERE side = 'sell')::bigint AS sell_trades
          FROM filtered
          GROUP BY wallet
        ),
        calc AS (
          SELECT
            wallet,
            (sells_raw - buys_raw)::numeric(78,0) AS profit_raw,
            sells_raw,
            buys_raw,
            trades_count,
            sell_trades
          FROM agg
        )
        SELECT wallet, profit_raw, sells_raw, buys_raw, trades_count
        FROM calc
        WHERE sell_trades > 0 OR profit_raw > 0
        ORDER BY profit_raw DESC, sells_raw DESC, trades_count DESC, wallet ASC
        LIMIT $4
        `,
        params
      );

      return finishStandings(rows, {
        warning: rows.length
          ? undefined
          : "No realized trader profits in this epoch yet (needs non-creator sells on the curve).",
      });
    }

    return json(res, 200, { items: [], prize: prizeForCategory, epoch: epochMeta, stats });
  } catch (e) {
    // If the DB schema hasn't been migrated yet, avoid breaking the UI with 500s.
    const code = e?.code;
    console.error("[api/league]", e);
    if (code === "42P01" || code === "42703") {
      return json(res, 200, { items: [], warning: "DB schema missing league columns/tables" });
    }
    return json(res, 500, { error: "Server error" });
  }
}

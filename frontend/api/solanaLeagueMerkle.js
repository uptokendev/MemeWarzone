import { ethers } from "ethers";
import { findProgramAddressSync } from "./dev-fix/solana-v4-primitives.js";

export const REWARDS_TREASURY_PROGRAM_ID = String(
  process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "",
).trim();
export const LEAGUE_LEAF_PREFIX = Buffer.from("MWZ_LEAGUE_LEAF", "utf8");
export const PERIOD_WEEKLY = 0;
export const PERIOD_MONTHLY = 1;
/** Quarterly finals share the league root + claim rail (program PERIOD_QUARTERLY). */
export const PERIOD_QUARTERLY = 2;
/** Major War League monthly round (post-grad); pays from mwl_vault like the quarterly finals. */
export const PERIOD_MWL_MONTHLY = 3;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Program period code for a league period. Fails closed: an unknown period
 * must never silently derive the weekly epoch PDA (that would sign leaves and
 * derive receipts for the wrong epoch).
 */
export function periodCode(period) {
  if (period === PERIOD_WEEKLY || period === PERIOD_MONTHLY || period === PERIOD_QUARTERLY || period === PERIOD_MWL_MONTHLY) return period;
  const key = String(period ?? "").trim().toLowerCase();
  if (key === "weekly" || key === "0") return PERIOD_WEEKLY;
  if (key === "monthly" || key === "1") return PERIOD_MONTHLY;
  if (key === "quarterly" || key === "2") return PERIOD_QUARTERLY;
  if (key === "mwl_monthly" || key === "3") return PERIOD_MWL_MONTHLY;
  throw new Error(`Unknown league period: ${String(period)}`);
}

export function categoryHashBytes(category) {
  const hex = ethers.keccak256(ethers.toUtf8Bytes(String(category || ""))).slice(2);
  return Buffer.from(hex, "hex");
}

export function base58Decode(value) {
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

function u64le(value) {
  let n = BigInt(value);
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function i64le(value) {
  let n = BigInt(value);
  if (n < 0n) n = (1n << 64n) + n;
  return u64le(n);
}

export function leagueLeaf({ epochStartSec, period, category, rank, recipient, amountRaw }) {
  const winner = base58Decode(recipient);
  if (winner.length !== 32) throw new Error("Invalid Solana recipient");
  const bytes = Buffer.concat([
    LEAGUE_LEAF_PREFIX,
    i64le(epochStartSec),
    Buffer.from([periodCode(period)]),
    categoryHashBytes(category),
    Buffer.from([Number(rank)]),
    winner,
    u64le(amountRaw),
  ]);
  return ethers.keccak256(bytes);
}

function hashPair(a, b) {
  const aa = String(a).toLowerCase();
  const bb = String(b).toLowerCase();
  const [x, y] = aa <= bb ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

export function buildMerkleRoot(leaves) {
  if (!leaves.length) return ethers.ZeroHash;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return layer[0];
}

export function buildMerkleProof(leaves, leafIndex) {
  if (!leaves.length) return [];
  const proof = [];
  let index = leafIndex;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const pairIndex = index ^ 1;
    proof.push(layer[pairIndex] ?? layer[index]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }
    layer = next;
    index = Math.floor(index / 2);
  }
  return proof;
}

/**
 * The vault a league period pays from -- must match the program's league_payout_vault: weekly from
 * league_vault, monthly and quarterly (Major War League) from monthly_league_vault.
 */
export function leagueVaultForPeriod(period, programId = REWARDS_TREASURY_PROGRAM_ID) {
  // Two competitions: pre-grad weekly (0) / monthly (1); Major War League quarterly (2) / monthly (3).
  const code = periodCode(period);
  const seed = code === PERIOD_WEEKLY ? "league_vault" : code === PERIOD_MONTHLY ? "monthly_league_vault" : "mwl_vault";
  return findProgramAddressSync([Buffer.from(seed)], programId).publicKey;
}

export function deriveRewardsVaults(programId = REWARDS_TREASURY_PROGRAM_ID) {
  return {
    programId,
    leagueVault: findProgramAddressSync([Buffer.from("league_vault")], programId).publicKey,
    monthlyLeagueVault: findProgramAddressSync([Buffer.from("monthly_league_vault")], programId).publicKey,
    airdropVault: findProgramAddressSync([Buffer.from("airdrop_vault")], programId).publicKey,
    config: findProgramAddressSync([Buffer.from("rewards_config")], programId).publicKey,
  };
}

export function deriveLeagueEpochPda(period, epochStartSec, programId = REWARDS_TREASURY_PROGRAM_ID) {
  const periodBuf = Buffer.from([periodCode(period)]);
  const startBuf = i64le(epochStartSec);
  return findProgramAddressSync(
    [Buffer.from("league_epoch"), periodBuf, startBuf],
    programId,
  ).publicKey;
}

export function deriveLeagueClaimPda(period, epochStartSec, category, rank, programId = REWARDS_TREASURY_PROGRAM_ID) {
  return findProgramAddressSync(
    [
      Buffer.from("league_claim"),
      Buffer.from([periodCode(period)]),
      i64le(epochStartSec),
      categoryHashBytes(category),
      Buffer.from([Number(rank)]),
    ],
    programId,
  ).publicKey;
}

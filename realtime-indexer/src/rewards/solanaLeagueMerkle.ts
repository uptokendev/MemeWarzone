/**
 * Solana league Merkle primitives, byte-for-byte the same as the API
 * (frontend/api/solanaLeagueMerkle.js) and the program
 * (programs/mwz_rewards_treasury/src/lib.rs claim_league):
 *
 *   leaf = keccak256("MWZ_LEAGUE_LEAF" || i64le(epochStart) || period || keccak256(category) || rank || recipient(32) || u64le(amount))
 *   node = keccak256(sorted(left, right)); an odd node pairs with itself.
 *
 * src/tests/solanaLeagueMerkleParity.test.ts proves parity against the API module.
 */
import { PublicKey } from "@solana/web3.js";
import { concat, keccak256, toUtf8Bytes } from "ethers";

export const LEAGUE_LEAF_PREFIX = Buffer.from("MWZ_LEAGUE_LEAF", "utf8");
export const PERIOD_WEEKLY = 0;
export const PERIOD_MONTHLY = 1;
export const PERIOD_QUARTERLY = 2;
export const LEAGUE_EPOCH_ACCOUNT_SIZE = 8 + 1 + 8 + 32 + 8 + 8 + 1 + 1 + 1;

export type LeaguePeriod = "weekly" | "monthly" | "quarterly";

export function periodCode(period: string | number): number {
  if (period === PERIOD_WEEKLY || period === PERIOD_MONTHLY || period === PERIOD_QUARTERLY) return period;
  const key = String(period ?? "").trim().toLowerCase();
  if (key === "weekly" || key === "0") return PERIOD_WEEKLY;
  if (key === "monthly" || key === "1") return PERIOD_MONTHLY;
  if (key === "quarterly" || key === "2") return PERIOD_QUARTERLY;
  throw new Error(`Unknown league period: ${String(period)}`);
}

export function i64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  if (n < 0n) n = (1n << 64n) + n;
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function u64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("u64 overflow");
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function categoryHashBytes(category: string): Buffer {
  return Buffer.from(keccak256(toUtf8Bytes(String(category || ""))).slice(2), "hex");
}

export function leagueLeaf(input: {
  epochStartSec: number | bigint;
  period: string | number;
  category: string;
  rank: number;
  recipient: string;
  amountRaw: bigint | string | number;
}): string {
  const winner = new PublicKey(input.recipient).toBuffer();
  return keccak256(
    Buffer.concat([
      LEAGUE_LEAF_PREFIX,
      i64le(input.epochStartSec),
      Buffer.from([periodCode(input.period)]),
      categoryHashBytes(input.category),
      Buffer.from([Number(input.rank)]),
      winner,
      u64le(input.amountRaw),
    ]),
  );
}

function hashPair(a: string, b: string): string {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([x, y]));
}

export function buildMerkleRoot(leaves: string[]): string {
  if (!leaves.length) return `0x${"00".repeat(32)}`;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return layer[0];
}

export function rootBytes(root: string): Buffer {
  const raw = String(root || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Invalid Solana Merkle root");
  return Buffer.from(raw, "hex");
}

export function deriveRewardsConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("rewards_config")], programId)[0];
}

export function deriveLeagueVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("league_vault")], programId)[0];
}

/** The program's league_payout_vault: weekly -> league_vault, monthly / quarterly -> monthly_league_vault. */
export function deriveLeaguePayoutVaultPda(programId: PublicKey, period: string | number): PublicKey {
  const seed = periodCode(period) === 0 ? "league_vault" : "monthly_league_vault";
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
}

export function deriveRewardPosterPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("reward_poster")], programId)[0];
}

/** RewardPoster: disc 8 | poster 32 | max_airdrop u64 | max_league u64 | 4 x i64 last posts | bump. */
export function parseRewardPosterAccount(data: Buffer): { poster: string; maxAirdropLamports: bigint; maxLeagueLamports: bigint } | null {
  if (data.length < 8 + 32 + 8 + 8) return null;
  return {
    poster: new PublicKey(data.subarray(8, 40)).toBase58(),
    maxAirdropLamports: data.readBigUInt64LE(40),
    maxLeagueLamports: data.readBigUInt64LE(48),
  };
}

export function deriveLeagueEpochPda(programId: PublicKey, period: string | number, epochStartSec: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("league_epoch"), Buffer.from([periodCode(period)]), i64le(epochStartSec)],
    programId,
  )[0];
}

export type LeagueEpochAccount = {
  period: number;
  epochStart: bigint;
  root: string;
  totalLamports: bigint;
  claimedLamports: bigint;
  initialized: boolean;
  sealed: boolean;
};

/** Anchor LeagueEpoch: discriminator, period u8, epoch_start i64, root [32], total u64, claimed u64, bump u8, initialized bool, sealed bool. */
export function parseLeagueEpochAccount(data: Uint8Array | Buffer): LeagueEpochAccount {
  const buf = Buffer.from(data);
  if (buf.length < LEAGUE_EPOCH_ACCOUNT_SIZE) throw new Error(`LeagueEpoch has unexpected size ${buf.length}`);
  return {
    period: buf[8],
    epochStart: buf.readBigInt64LE(9),
    root: `0x${buf.subarray(17, 49).toString("hex")}`,
    totalLamports: buf.readBigUInt64LE(49),
    claimedLamports: buf.readBigUInt64LE(57),
    initialized: buf[66] === 1,
    sealed: buf[67] === 1,
  };
}

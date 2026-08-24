import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

/**
 * Verify mainnet DB recruiter batches against the on-chain Merkle root.
 *
 *   npm run cron:verify-recruiter-settlement-root
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";

const BATCH_SEED = Buffer.from("recruiter_batch");
const BATCH_SIZE = 8 + 8 + 32 + 8 + 8 + 8 + 1 + 1;
const MAINNET_CHAIN_ID = 101;

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

function i64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  if (n < 0n) n = (1n << 64n) + n;
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function rpcUrl(chainId: number): string {
  return (
    env(`SOLANA_REWARDS_RPC_URL_${chainId}`) ||
    env(`SOLANA_RPC_URL_${chainId}`) ||
    env("SOLANA_REWARDS_RPC_URL") ||
    env("SOLANA_RPC_URL") ||
    env("SOLANA_RPC_HTTP")
  ).split(",").map((item) => item.trim()).find(Boolean) || "";
}

async function main() {
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  console.log(`[verifyRecruiterSettlementRoot] BUILD_SHA=${sha}`);
  const programId = env("SOLANA_REWARDS_TREASURY_PROGRAM_ID");
  if (!programId) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  const { rows } = await pool.query(
    `select id, chain_id, epoch_id, merkle_root, total_lamports, status, batch_address,
            claim_deadline, deadline
       from public.solana_reward_lane_batches
      where lane='recruiter' and chain_id=$1
      order by epoch_id desc
      limit 20`,
    [MAINNET_CHAIN_ID],
  );
  const pid = new PublicKey(programId);
  const reports = [];
  for (const row of rows) {
    const chainId = Number(row.chain_id);
    const epochId = String(row.epoch_id);
    const url = rpcUrl(chainId);
    if (!url) throw new Error(`Solana RPC is not configured for chain ${chainId}`);
    const connection = new Connection(url, "confirmed");
    const [batchAddress] = PublicKey.findProgramAddressSync([BATCH_SEED, i64le(epochId)], pid);
    let onChain: { root: string; totalLamports: string; deadline: string; initialized: boolean } | null = null;
    const info = await connection.getAccountInfo(batchAddress, "confirmed");
    if (info && info.data.length >= BATCH_SIZE) {
      const data = Buffer.from(info.data);
      onChain = {
        root: `0x${data.subarray(16, 48).toString("hex")}`,
        totalLamports: data.readBigUInt64LE(48).toString(),
        deadline: data.readBigInt64LE(64).toString(),
        initialized: data[73] === 1,
      };
    }
    const dbRoot = String(row.merkle_root || "").toLowerCase();
    const chainRoot = String(onChain?.root || "").toLowerCase();
    const dbDeadline = String(row.claim_deadline || row.deadline || "0");
    const rootMatches = Boolean(onChain?.initialized && dbRoot && dbRoot === chainRoot);
    const totalsMatch = Boolean(onChain && onChain.totalLamports === String(row.total_lamports));
    const deadlineMatches = Boolean(onChain && onChain.deadline === dbDeadline);
    const claimable = String(row.status) === "claim_open" && rootMatches && totalsMatch && deadlineMatches;
    reports.push({
      batchId: row.id,
      chainId,
      epochId,
      dbStatus: row.status,
      dbRoot: row.merkle_root,
      onChainRoot: onChain?.root || null,
      dbTotalLamports: String(row.total_lamports),
      onChainTotalLamports: onChain?.totalLamports || null,
      dbDeadline,
      onChainDeadline: onChain?.deadline || null,
      rootMatches,
      totalsMatch,
      deadlineMatches,
      claimable,
    });
  }
  console.log(JSON.stringify({ ok: true, batches: reports }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[verifyRecruiterSettlementRoot] failed", error);
    process.exit(1);
  });

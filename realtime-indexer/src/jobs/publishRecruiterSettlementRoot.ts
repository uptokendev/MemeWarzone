import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

/**
 * Operator step: ready DB batch → on-chain recruiter Merkle root → claim_open.
 *
 *   npm run cron:publish-recruiter-settlement-root
 *
 * Requires SOLANA_REWARDS_TREASURY_PROGRAM_ID, SOLANA_RPC_URL (or SOLANA_REWARDS_RPC_URL),
 * and SOLANA_REWARDS_AUTHORITY_SECRET_KEY. Does not mark claim_open unless the
 * on-chain batch root matches the DB merkle_root.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { pool } from "../db.js";

const BATCH_SEED = Buffer.from("recruiter_batch");
const BATCH_SIZE = 8 + 8 + 32 + 8 + 8 + 8 + 1 + 1;

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

function u64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function rootBytes(root: string): Buffer {
  const raw = String(root || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Invalid Solana Merkle root");
  return Buffer.from(raw, "hex");
}

function authorityKeypair(): Keypair {
  const raw = env("SOLANA_REWARDS_AUTHORITY_SECRET_KEY");
  if (!raw) throw new Error("SOLANA_REWARDS_AUTHORITY_SECRET_KEY is required to publish the recruiter Merkle root");
  let bytes: Uint8Array;
  if (raw.startsWith("[")) bytes = Uint8Array.from(JSON.parse(raw).map(Number));
  else bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Solana rewards authority must decode to 32 or 64 bytes, got ${bytes.length}`);
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

function programId(): string {
  const id = env("SOLANA_REWARDS_TREASURY_PROGRAM_ID");
  if (!id) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  return id;
}

async function readOnChainBatch(connection: Connection, batchAddress: string) {
  const info = await connection.getAccountInfo(new PublicKey(batchAddress), "confirmed");
  if (!info) return null;
  const data = Buffer.from(info.data);
  if (data.length < BATCH_SIZE) throw new Error(`RewardLaneBatch has unexpected size ${data.length}`);
  return {
    epochId: data.readBigInt64LE(8),
    root: `0x${data.subarray(16, 48).toString("hex")}`,
    totalLamports: data.readBigUInt64LE(48),
    deadline: data.readBigInt64LE(64),
    initialized: data[73] === 1,
  };
}

async function main() {
  const { rows } = await pool.query(
    `select id, chain_id, epoch_id, merkle_root, total_lamports, deadline, batch_address, status
       from public.solana_reward_lane_batches
      where lane='recruiter' and status in ('draft','ready')
      order by epoch_id asc`,
  );
  if (!rows.length) {
    console.log(JSON.stringify({ ok: true, published: 0, note: "No recruiter batches in draft/ready." }, null, 2));
    return;
  }

  const signer = authorityKeypair();
  const pid = new PublicKey(programId());
  const reports = [];

  for (const row of rows) {
    const chainId = Number(row.chain_id);
    const epochId = String(row.epoch_id);
    const url = rpcUrl(chainId);
    if (!url) throw new Error(`Solana RPC is not configured for chain ${chainId}`);
    const connection = new Connection(url, "confirmed");
    const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("rewards_config")], pid);
    const [vaultAddress] = PublicKey.findProgramAddressSync([Buffer.from("recruiter_vault")], pid);
    const [batchAddress] = PublicKey.findProgramAddressSync([BATCH_SEED, i64le(epochId)], pid);
    const storedRoot = String(row.merkle_root);
    const totalLamports = BigInt(String(row.total_lamports));
    const deadline = BigInt(String(row.deadline || 0));

    const existing = await readOnChainBatch(connection, batchAddress.toBase58());
    let txHash: string | null = null;
    if (existing) {
      if (
        !existing.initialized ||
        existing.epochId !== BigInt(epochId) ||
        existing.root.toLowerCase() !== storedRoot.toLowerCase() ||
        existing.totalLamports !== totalLamports
      ) {
        throw new Error(`On-chain recruiter batch for epoch ${epochId} does not match DB root`);
      }
    } else {
      const latest = await connection.getLatestBlockhash("confirmed");
      const ix = new TransactionInstruction({
        programId: pid,
        keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: configAddress, isSigner: false, isWritable: false },
          { pubkey: vaultAddress, isSigner: false, isWritable: false },
          { pubkey: batchAddress, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          discriminator("set_recruiter_batch_root"),
          i64le(epochId),
          rootBytes(storedRoot),
          u64le(totalLamports),
          i64le(deadline),
        ]),
      });
      const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: latest.blockhash }).add(ix);
      tx.sign(signer);
      txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await connection.confirmTransaction({ signature: txHash, ...latest }, "confirmed");
      const confirmed = await readOnChainBatch(connection, batchAddress.toBase58());
      if (!confirmed?.initialized || confirmed.root.toLowerCase() !== storedRoot.toLowerCase() || confirmed.totalLamports !== totalLamports) {
        throw new Error(`Recruiter batch publication confirmed but did not reconcile for epoch ${epochId}`);
      }
    }

    await pool.query(
      `update public.solana_reward_lane_batches
          set status='claim_open', batch_address=$2, updated_at=now(),
              metadata = coalesce(metadata,'{}'::jsonb) || $3::jsonb
        where id=$1`,
      [row.id, batchAddress.toBase58(), JSON.stringify({ publishedAt: new Date().toISOString(), txHash })],
    );
    await pool.query(
      `update public.solana_reward_lane_claims
          set status='claimable', updated_at=now()
        where batch_id=$1 and status='pending'`,
      [row.id],
    );
    reports.push({
      batchId: row.id,
      chainId,
      epochId,
      root: storedRoot,
      totalLamports: totalLamports.toString(),
      txHash,
      status: "claim_open",
    });
  }

  console.log(JSON.stringify({ ok: true, published: reports.length, batches: reports }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[publishRecruiterSettlementRoot] failed", error);
    process.exit(1);
  });

/**
 * Solana side of the weekly airdrop: the pool from the rewards treasury's airdrop_vault, one Merkle
 * tree per week (trader and creator leaves share the epoch's AirdropBatch PDA -- the program keys a
 * batch by epoch id and puts the program code in the leaf), and the root posted with the narrow
 * reward-poster key (programs/mwz_rewards_treasury/src/reward_poster.rs), never the authority.
 *
 * Leaf and tree are byte-for-byte the program's: keccak(MWZ_AIRDROP_LEAF || i64le epoch ||
 * u8 program || winner32 || u64le amount), sorted-pair keccak, odd node paired with itself -- the
 * construction tests/solana/rewards-claims-acceptance.cjs proves against a validator.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export const SOLANA_AIRDROP_PROGRAM_CODES = Object.freeze({ airdrop_trader: 0, airdrop_creator: 1 });
const LEAF_PREFIX = Buffer.from("MWZ_AIRDROP_LEAF", "utf8");
const AIRDROP_BATCH_DISC = createHash("sha256").update("account:AirdropBatch").digest().subarray(0, 8);
const POST_ROOT_DISC = createHash("sha256").update("global:post_airdrop_batch_root").digest().subarray(0, 8);
// discriminator + epoch_id i64 + root + total u64 + claimed u64 + deadline i64 + bump + initialized
const AIRDROP_BATCH_BYTES = 8 + 8 + 32 + 8 + 8 + 8 + 1 + 1;

export function treasuryProgramId() {
  return new PublicKey(String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").trim());
}

const pda = (programId, ...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const i64le = (value) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; };
const u64le = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const keccak = (bytes) => Buffer.from(keccak256(bytes).slice(2), "hex");

export function airdropLeaf({ epochId, programCode, winner, amount }) {
  return keccak(Buffer.concat([LEAF_PREFIX, i64le(epochId), Buffer.from([programCode]), new PublicKey(winner).toBuffer(), u64le(amount)]));
}

function hashPair(a, b) {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak(Buffer.concat([left, right]));
}

/** Root and per-leaf proofs; an odd node pairs with itself (the program's verify_merkle_proof). */
export function merkleTree(leaves) {
  if (!leaves.length) throw new Error("Cannot build an empty airdrop tree");
  const proofs = leaves.map(() => []);
  let layer = leaves.map((leaf, index) => ({ hash: leaf, members: [index] }));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? layer[i];
      for (const member of left.members) proofs[member].push(right.hash);
      if (layer[i + 1]) for (const member of right.members) proofs[member].push(left.hash);
      next.push({ hash: hashPair(left.hash, right.hash), members: layer[i + 1] ? [...left.members, ...right.members] : left.members });
    }
    layer = next;
  }
  return { root: layer[0].hash, proofs };
}

export function verifyProof(leaf, proof, root) {
  return proof.reduce((computed, sibling) => hashPair(computed, sibling), leaf).equals(root);
}

export function solanaConnection() {
  const url = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!url) throw new Error("SOLANA_RPC_URL is required for the Solana airdrop");
  return new Connection(url, "confirmed");
}

export function loadPosterKeypair() {
  const inline = String(process.env.SOLANA_AIRDROP_POSTER_SECRET || "").trim();
  const file = String(process.env.SOLANA_AIRDROP_POSTER_KEYPAIR || "").trim();
  const raw = inline || (file ? fs.readFileSync(file, "utf8") : "");
  if (!raw) throw new Error("SOLANA_AIRDROP_POSTER_SECRET (inline JSON) or SOLANA_AIRDROP_POSTER_KEYPAIR is required");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function decodeBatch(data) {
  if (data.length < AIRDROP_BATCH_BYTES || !Buffer.from(data.subarray(0, 8)).equals(AIRDROP_BATCH_DISC)) return null;
  return {
    epochId: data.readBigInt64LE(8),
    root: Buffer.from(data.subarray(16, 48)),
    total: data.readBigUInt64LE(48),
    claimed: data.readBigUInt64LE(56),
    deadline: data.readBigInt64LE(64),
    initialized: data[73] === 1,
  };
}

/**
 * What the vault can fund this week: its rent-free balance minus what still-open batches may yet
 * pay (batches do not reserve lamports on chain, so the runner must).
 */
export async function readSolanaAirdropPool(connection = solanaConnection(), now = Math.floor(Date.now() / 1000)) {
  const programId = treasuryProgramId();
  const vault = pda(programId, Buffer.from("airdrop_vault"));
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`airdrop vault ${vault.toBase58()} not found`);
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
  const spendable = BigInt(info.lamports) > rent ? BigInt(info.lamports) - rent : 0n;
  const batches = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: AIRDROP_BATCH_BYTES }, { memcmp: { offset: 0, bytes: bs58Encode(AIRDROP_BATCH_DISC) } }],
  });
  let outstanding = 0n;
  for (const { account } of batches) {
    const batch = decodeBatch(Buffer.from(account.data));
    if (!batch?.initialized) continue;
    if (batch.deadline !== 0n && batch.deadline <= BigInt(now)) continue;
    outstanding += batch.total > batch.claimed ? batch.total - batch.claimed : 0n;
  }
  const available = spendable > outstanding ? spendable - outstanding : 0n;
  return { vault: vault.toBase58(), spendable, outstanding, available };
}

function bs58Encode(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte === 0) out = `1${out}`; else break; }
  return out;
}

export async function readAirdropBatch(connection, epochId) {
  const programId = treasuryProgramId();
  const address = pda(programId, Buffer.from("airdrop_batch"), i64le(epochId));
  const info = await connection.getAccountInfo(address, "confirmed");
  return { address: address.toBase58(), batch: info ? decodeBatch(Buffer.from(info.data)) : null };
}

/** Posts the week's root with the reward poster; a re-run with the same root is a no-op. */
export async function postSolanaAirdropRoot({ connection = solanaConnection(), poster = loadPosterKeypair(), epochId, root, totalLamports, deadline }) {
  const programId = treasuryProgramId();
  const existing = await readAirdropBatch(connection, epochId);
  if (existing.batch?.initialized) {
    if (existing.batch.root.equals(root) && existing.batch.total === BigInt(totalLamports)) {
      return { alreadyPosted: true, batchAddress: existing.address, signature: null };
    }
    throw new Error(`Airdrop batch ${existing.address} for epoch ${epochId} already holds a different root`);
  }
  const keys = [
    { pubkey: poster.publicKey, isSigner: true, isWritable: true },
    { pubkey: pda(programId, Buffer.from("rewards_config")), isSigner: false, isWritable: false },
    { pubkey: pda(programId, Buffer.from("reward_poster")), isSigner: false, isWritable: true },
    { pubkey: pda(programId, Buffer.from("airdrop_vault")), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(existing.address), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([POST_ROOT_DISC, i64le(epochId), Buffer.from(root), u64le(totalLamports), i64le(deadline)]);
  const instruction = new TransactionInstruction({ programId, keys, data });
  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: poster.publicKey, recentBlockhash: latest.blockhash, instructions: [instruction] }).compileToV0Message());
    tx.sign([poster]);
    return { tx, latest };
  };
  const simulated = await compile();
  const simulation = await connection.simulateTransaction(simulated.tx, { commitment: "confirmed" });
  if (simulation.value.err) {
    throw new Error(`post_airdrop_batch_root simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).slice(-8).join("\n")}`);
  }
  const final = await compile();
  const signature = await connection.sendRawTransaction(final.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...final.latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`post_airdrop_batch_root failed: ${JSON.stringify(confirmation.value.err)}`);
  const after = await readAirdropBatch(connection, epochId);
  if (!after.batch?.root.equals(root) || after.batch.total !== BigInt(totalLamports)) {
    throw new Error(`Airdrop batch ${after.address} does not read back the posted root`);
  }
  return { alreadyPosted: false, batchAddress: after.address, signature };
}

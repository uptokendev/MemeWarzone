import crypto from "node:crypto";
import { keccak256 } from "ethers";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const CONFIG_SEED = Buffer.from("rewards_config");
const VAULT_SIZE = 9;
const BATCH_SIZE = 8 + 8 + 32 + 8 + 8 + 8 + 1 + 1;

const LANES = Object.freeze({
  recruiter: {
    prefix: Buffer.from("MWZ_RECRUITER_LEAF"),
    vaultSeed: Buffer.from("recruiter_vault"),
    batchSeed: Buffer.from("recruiter_batch"),
    claimSeed: Buffer.from("recruiter_claim"),
    setInstruction: "set_recruiter_batch_root",
    claimInstruction: "claim_recruiter",
    laneCode: 1,
  },
  squad: {
    prefix: Buffer.from("MWZ_SQUAD_LEAF"),
    vaultSeed: Buffer.from("squad_vault"),
    batchSeed: Buffer.from("squad_batch"),
    claimSeed: Buffer.from("squad_claim"),
    setInstruction: "set_squad_batch_root",
    claimInstruction: "claim_squad",
    laneCode: 2,
  },
});

function laneConfig(lane) {
  const config = LANES[String(lane || "").toLowerCase()];
  if (!config) throw new Error(`Unsupported Solana reward lane ${lane}`);
  return config;
}

function env(name, fallback = "") { return String(process.env[name] ?? fallback).trim(); }
function boolEnv(name, fallback = false) {
  const raw = env(name);
  return raw ? ["1", "true", "yes", "on"].includes(raw.toLowerCase()) : fallback;
}

function i64le(value) {
  let n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error("i64 overflow");
  if (n < 0n) n = (1n << 64n) + n;
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function u64le(value) {
  let n = BigInt(value);
  if (n < 0n || n > (1n << 64n) - 1n) throw new Error("u64 overflow");
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function rootBytes(root) {
  const raw = String(root || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Invalid Solana Merkle root");
  return Buffer.from(raw, "hex");
}
function publicKey(value) { return new PublicKey(String(value || "").trim()); }

export function solanaLaneProgramId() {
  const programId = env("SOLANA_REWARDS_TREASURY_PROGRAM_ID");
  if (!programId) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  return programId;
}

export function solanaLaneAddresses(lane, epochId, walletAddress = null, programId = solanaLaneProgramId()) {
  const config = laneConfig(lane);
  const pid = publicKey(programId);
  const [rewardsConfig] = PublicKey.findProgramAddressSync([CONFIG_SEED], pid);
  const [vault] = PublicKey.findProgramAddressSync([config.vaultSeed], pid);
  const [batch] = PublicKey.findProgramAddressSync([config.batchSeed, i64le(epochId)], pid);
  const receipt = walletAddress
    ? PublicKey.findProgramAddressSync([config.claimSeed, i64le(epochId), publicKey(walletAddress).toBuffer()], pid)[0]
    : null;
  return {
    programId: pid.toBase58(),
    configAddress: rewardsConfig.toBase58(),
    vaultAddress: vault.toBase58(),
    batchAddress: batch.toBase58(),
    claimReceiptAddress: receipt?.toBase58() || null,
  };
}

export function solanaLaneLeaf(lane, epochId, walletAddress, amountLamports) {
  const config = laneConfig(lane);
  return keccak256(Buffer.concat([
    config.prefix,
    i64le(epochId),
    publicKey(walletAddress).toBuffer(),
    u64le(amountLamports),
  ]));
}

function hashPair(a, b) {
  const aa = Buffer.from(String(a).replace(/^0x/, ""), "hex");
  const bb = Buffer.from(String(b).replace(/^0x/, ""), "hex");
  return keccak256(Buffer.concat(Buffer.compare(aa, bb) <= 0 ? [aa, bb] : [bb, aa]));
}

export function buildSolanaLaneMerklePlan(lane, epochId, recipients) {
  if (!Array.isArray(recipients) || !recipients.length) throw new Error(`Cannot build empty ${lane} settlement batch`);
  const normalized = recipients.map((item) => {
    const walletAddress = publicKey(item.walletAddress).toBase58();
    const amountLamports = BigInt(item.amountLamports);
    if (amountLamports <= 0n) throw new Error(`Invalid ${lane} amount for ${walletAddress}`);
    return { ...item, walletAddress, amountLamports: amountLamports.toString() };
  });
  const leaves = normalized.map((item) => solanaLaneLeaf(lane, epochId, item.walletAddress, item.amountLamports));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let i = 0; i < current.length; i += 2) next.push(hashPair(current[i], current[i + 1] ?? current[i]));
    levels.push(next);
  }
  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const pair = index ^ 1;
      proof.push(levels[level][pair] ?? levels[level][index]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return {
    recipients: normalized,
    leaves,
    proofs,
    root: levels.at(-1)[0],
    totalLamports: normalized.reduce((sum, item) => sum + BigInt(item.amountLamports), 0n),
  };
}

function rpcUrl(chainId) {
  return (
    env(`SOLANA_REWARDS_RPC_URL_${chainId}`) || env(`SOLANA_RPC_URL_${chainId}`) ||
    env("SOLANA_REWARDS_RPC_URL") || env("SOLANA_RPC_URL") || env("SOLANA_RPC_HTTP")
  ).split(",").map((item) => item.trim()).find(Boolean) || "";
}
function connectionFor(chainId) {
  const url = rpcUrl(chainId);
  if (!url) throw new Error(`Solana reward RPC is not configured for chain ${chainId}`);
  return new Connection(url, "confirmed");
}
function authorityKeypair() {
  const raw = env("SOLANA_REWARDS_AUTHORITY_SECRET_KEY");
  if (!raw) throw new Error("SOLANA_REWARDS_AUTHORITY_SECRET_KEY is required");
  let bytes;
  if (raw.startsWith("[")) bytes = Uint8Array.from(JSON.parse(raw).map(Number));
  else bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Solana rewards authority must decode to 32 or 64 bytes, got ${bytes.length}`);
}
async function send(connection, signer, ix) {
  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return { transaction, latest };
  };

  const simulated = await compile();
  const simulation = await connection.simulateTransaction(simulated.transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.slice(-12).join("\n") || "";
    throw new Error(`Solana reward lane simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? `\n${logs}` : ""}`);
  }

  const final = await compile();
  const signature = await connection.sendRawTransaction(final.transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...final.latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`Solana reward lane transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}
async function assertConfig(connection, configAddress, signer) {
  const info = await connection.getAccountInfo(publicKey(configAddress), "confirmed");
  if (!info || info.data.length < 44) throw new Error("Solana RewardsConfig is missing or malformed");
  const authority = new PublicKey(info.data.subarray(8, 40));
  if (!authority.equals(signer.publicKey)) throw new Error(`RewardsConfig authority mismatch: ${authority.toBase58()}`);
  return { claimsEnabled: info.data[43] === 1 };
}
async function ensureClaimsEnabled(connection, signer, addresses) {
  const state = await assertConfig(connection, addresses.configAddress, signer);
  if (state.claimsEnabled) return null;
  if (!boolEnv("SOLANA_REWARDS_AUTO_ENABLE_CLAIMS", false)) throw new Error("Solana reward batch is published but claims remain disabled; set SOLANA_REWARDS_AUTO_ENABLE_CLAIMS=true only when ready to open claims");
  const ix = new TransactionInstruction({
    programId: publicKey(addresses.programId),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: publicKey(addresses.configAddress), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("set_claims_enabled"), Buffer.from([1])]),
  });
  const signature = await send(connection, signer, ix);
  const after = await assertConfig(connection, addresses.configAddress, signer);
  if (!after.claimsEnabled) throw new Error("Claims-enable transaction confirmed but config remains disabled");
  return signature;
}
async function readBatch(connection, batchAddress) {
  const info = await connection.getAccountInfo(publicKey(batchAddress), "confirmed");
  if (!info) return null;
  const data = Buffer.from(info.data);
  if (data.length < BATCH_SIZE) throw new Error(`RewardLaneBatch has unexpected size ${data.length}`);
  return {
    epochId: data.readBigInt64LE(8),
    root: `0x${data.subarray(16, 48).toString("hex")}`,
    totalLamports: data.readBigUInt64LE(48),
    claimedLamports: data.readBigUInt64LE(56),
    deadline: data.readBigInt64LE(64),
    initialized: data[73] === 1,
  };
}

export async function publishSolanaRewardLaneBatch({ lane, chainId, epochId, root, totalLamports, deadline }) {
  const config = laneConfig(lane);
  const cid = Number(chainId);
  if (![101, 102].includes(cid)) throw new Error("Solana lane publisher only supports chain 101/102");
  const addresses = solanaLaneAddresses(lane, epochId);
  const connection = connectionFor(cid);
  const signer = authorityKeypair();
  await assertConfig(connection, addresses.configAddress, signer);

  const existing = await readBatch(connection, addresses.batchAddress);
  let alreadyExisted = false;
  let txHash = null;
  if (existing) {
    if (!existing.initialized || existing.epochId !== BigInt(epochId) || existing.root.toLowerCase() !== String(root).toLowerCase() || existing.totalLamports !== BigInt(totalLamports) || existing.deadline !== BigInt(deadline)) {
      throw new Error(`Existing ${lane} batch does not match prepared settlement`);
    }
    alreadyExisted = true;
  } else {
    const [balance, rent] = await Promise.all([
      connection.getBalance(publicKey(addresses.vaultAddress), "confirmed"),
      connection.getMinimumBalanceForRentExemption(VAULT_SIZE, "confirmed"),
    ]);
    if (BigInt(Math.max(0, balance - rent)) < BigInt(totalLamports)) throw new Error(`${lane} vault has insufficient distributable SOL`);
    const ix = new TransactionInstruction({
      programId: publicKey(addresses.programId),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: publicKey(addresses.configAddress), isSigner: false, isWritable: false },
        { pubkey: publicKey(addresses.vaultAddress), isSigner: false, isWritable: false },
        { pubkey: publicKey(addresses.batchAddress), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator(config.setInstruction), i64le(epochId), rootBytes(root), u64le(totalLamports), i64le(deadline)]),
    });
    txHash = await send(connection, signer, ix);
    const confirmed = await readBatch(connection, addresses.batchAddress);
    if (!confirmed?.initialized || confirmed.root.toLowerCase() !== String(root).toLowerCase() || confirmed.totalLamports !== BigInt(totalLamports)) {
      throw new Error(`${lane} batch publication confirmed but did not reconcile`);
    }
  }

  // Open claims only after this lane's root exists and exactly matches the prepared batch.
  const claimsEnableTxHash = await ensureClaimsEnabled(connection, signer, addresses);
  return { ...addresses, alreadyExisted, txHash, claimsEnableTxHash };
}

function accountText(item) { return typeof item === "string" ? item : String(item?.pubkey || ""); }
function instructionAccounts(ix, keys) {
  if (!Array.isArray(ix?.accounts)) return [];
  if (ix.accounts.every((item) => typeof item === "string")) return ix.accounts;
  return ix.accounts.map((index) => accountText(keys[Number(index)])).filter(Boolean);
}
function instructionProgram(ix, keys) {
  if (ix?.programId) return String(ix.programId);
  return Number.isInteger(ix?.programIdIndex) ? accountText(keys[ix.programIdIndex]) : "";
}

export async function verifySolanaRewardLaneClaim({ lane, chainId, epochId, walletAddress, amountLamports, txHash }) {
  const addresses = solanaLaneAddresses(lane, epochId, walletAddress);
  const connection = connectionFor(chainId);
  const tx = await connection.getTransaction(txHash, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) throw new Error("Solana reward lane transaction is missing or failed");
  const keys = tx.transaction.message.getAccountKeys ? Array.from(tx.transaction.message.getAccountKeys().staticAccountKeys || []) : [];
  const rawMessage = tx.transaction.message;
  const compiled = rawMessage.compiledInstructions || [];
  const hasExpected = compiled.some((ix) => {
    const program = accountText(keys[ix.programIdIndex]);
    const accounts = Array.from(ix.accountKeyIndexes || []).map((index) => accountText(keys[index]));
    return program === addresses.programId && accounts[0] === walletAddress && accounts[1] === addresses.configAddress && accounts[2] === addresses.vaultAddress && accounts[3] === addresses.batchAddress && accounts[4] === addresses.claimReceiptAddress;
  });
  if (!hasExpected) throw new Error("Confirmed transaction did not execute expected reward lane accounts");
  const vaultIndex = keys.findIndex((key) => accountText(key) === addresses.vaultAddress);
  if (vaultIndex < 0 || tx.meta.preBalances[vaultIndex] == null || tx.meta.postBalances[vaultIndex] == null) throw new Error("Reward lane vault balance delta unavailable");
  const delta = BigInt(tx.meta.preBalances[vaultIndex]) - BigInt(tx.meta.postBalances[vaultIndex]);
  if (delta !== BigInt(amountLamports)) throw new Error(`Reward lane vault moved ${delta}, expected ${amountLamports}`);
  return { ...addresses, slot: tx.slot, txHash, amountLamports: String(amountLamports), walletAddress, epochId: String(epochId), lane };
}

export { LANES };

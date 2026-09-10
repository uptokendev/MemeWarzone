import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const CHAIN_ID = 102;
const PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const CONFIG_SEED = Buffer.from("arena_config");
const POOL_SEED = Buffer.from("arena_pool");
const VAULT_SEED = Buffer.from("arena_vault");
const BUYIN_SEED = Buffer.from("arena_buyin");
const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
function enabled(name) { return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim()); }
function apiBase() { return required("T2_API_BASE_URL").replace(/\/+$/, ""); }
function apiUrl(route) { return `${apiBase()}${route.startsWith("/api/") ? route : `/api${route}`}`; }
async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init); const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(`${response.status} ${body?.code || ""} ${body?.error || body?.reason || "request failed"}`.trim());
  return body;
}
function keypairFromEnv() {
  const parsed = JSON.parse(required("T2_SOLANA_OWNER_KEYPAIR_JSON"));
  if (!Array.isArray(parsed) || parsed.length !== 64) throw new Error("T2_SOLANA_OWNER_KEYPAIR_JSON must be a 64-byte JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}
function poolIdBytes(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Tournament pool id must be 32-byte hex");
  return Buffer.from(hex, "hex");
}
function pda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]; }
function discriminator(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8); }
function signApiMessage(keypair, message) {
  const seed = Buffer.from(keypair.secretKey).subarray(0, 32);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}
async function status(tournamentId, token, wallet) {
  const qs = new URLSearchParams({ tokenAddress: token, walletAddress: wallet, chainId: String(CHAIN_ID) });
  return jsonFetch(apiUrl(`/arena/tournaments/${encodeURIComponent(tournamentId)}/buy-in-status?${qs}`));
}
function buildMessage({ wallet, nonce, tournamentId, token, txHash = "" }) {
  return ["MemeWarzone API Action", "Action: arena_tournament_buy_in", `Wallet: ${wallet}`, `Chain ID: ${CHAIN_ID}`, `Tournament: ${tournamentId}`, `Token: ${token}`, txHash ? `Tx: ${txHash}` : "Reconcile: authoritative chain state", `Nonce: ${nonce}`].join("\n");
}
async function auth(keypair, tournamentId, token, txHash = "") {
  const wallet = keypair.publicKey.toBase58();
  const nonceBody = await jsonFetch(apiUrl(`/auth/nonce?${new URLSearchParams({ chainId: String(CHAIN_ID), address: wallet })}`));
  const nonce = String(nonceBody.nonce); const message = buildMessage({ wallet, nonce, tournamentId, token, txHash });
  return { action: "arena_tournament_buy_in", walletAddress: wallet, chainId: CHAIN_ID, nonce, message, signature: signApiMessage(keypair, message), walletType: "solana" };
}
async function reconcile(keypair, tournamentId, token, txHash = "") {
  const credential = await auth(keypair, tournamentId, token, txHash);
  return jsonFetch(apiUrl(`/arena/tournaments/${encodeURIComponent(tournamentId)}/buy-in-receipt`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddress: token, walletAddress: keypair.publicKey.toBase58(), chainId: CHAIN_ID, ...(txHash ? { txHash } : {}), auth: credential }) });
}

async function main() {
  if (!enabled("T2_ALLOW_REAL_PAYMENT")) throw new Error("Real payment gate is closed. Set T2_ALLOW_REAL_PAYMENT=true only after Launch Control authorizes financial staging execution.");
  const kind = required("T2_TOURNAMENT_TYPE").toLowerCase(); if (!new Set(["battle", "vote"]).has(kind)) throw new Error("T2_TOURNAMENT_TYPE must be battle or vote");
  const tournamentId = required("T2_TOURNAMENT_ID"); const token = new PublicKey(required("T2_TOKEN_ADDRESS")).toBase58();
  const rpc = process.env.SOLANA_RPC_HTTP_102 || process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_DEVNET_RPC || process.env.VITE_SOLANA_RPC_URL;
  if (!rpc) throw new Error("Solana devnet RPC env is missing");
  const connection = new Connection(String(rpc), "confirmed"); const genesis = await connection.getGenesisHash();
  const expectedGenesis = String(process.env.T2_SOLANA_DEVNET_GENESIS_HASH || "EtWTRABZaYq6iMfeYKouRu166VU2xqa1").trim();
  if (expectedGenesis && genesis !== expectedGenesis) throw new Error(`Solana cluster mismatch: ${genesis}`);
  const keypair = keypairFromEnv(); const wallet = keypair.publicKey.toBase58();
  const before = await status(tournamentId, token, wallet); if (Number(before.chainId) !== CHAIN_ID) throw new Error("Backend returned wrong Solana chain");
  const poolId = poolIdBytes(before.poolId); const pool = pda([POOL_SEED, poolId]); const config = pda([CONFIG_SEED]); const vault = pda([VAULT_SEED, poolId]);
  const receiptPda = pda([BUYIN_SEED, poolId, new PublicKey(token).toBuffer(), keypair.publicKey.toBuffer()]);
  const preReceipt = await connection.getAccountInfo(receiptPda, "confirmed"); let txHash = "";
  if (!before.chainPaid && !preReceipt) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: receiptPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator("deposit_buy_in_v2"), poolId, new PublicKey(token).toBuffer()]),
    });
    txHash = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [keypair], { commitment: "confirmed" });
  }
  const receipt = await connection.getAccountInfo(receiptPda, "confirmed");
  if (!receipt || !receipt.owner.equals(PROGRAM_ID)) throw new Error("Authoritative Arena buy-in receipt PDA was not created by the canonical program");
  const first = await reconcile(keypair, tournamentId, token, txHash);
  const after = await status(tournamentId, token, wallet); if (!after.buyInPaid || !after.chainPaid) throw new Error("API/chain did not converge to paid=true");
  const duplicate = await reconcile(keypair, tournamentId, token);
  const receiptAfterDuplicate = await connection.getAccountInfo(receiptPda, "confirmed"); if (!receiptAfterDuplicate || !receiptAfterDuplicate.owner.equals(PROGRAM_ID)) throw new Error("Duplicate reconciliation changed authoritative receipt state");
  const evidence = { accepted: true, type: kind, chainId: CHAIN_ID, tournamentId, token, wallet, programId: PROGRAM_ID.toBase58(), poolId: `0x${poolId.toString("hex")}`, poolPda: pool.toBase58(), receiptPda: receiptPda.toBase58(), amountLamports: String(before.amountRaw), txHash: txHash || null, recoveredExistingDeposit: Boolean(before.chainPaid || preReceipt), firstReconciliationIdempotent: Boolean(first.idempotent), duplicateReconciliationIdempotent: Boolean(duplicate.idempotent), dbPaidAfter: Boolean(after.buyInPaid), chainPaidAfter: Boolean(after.chainPaid) };
  const out = path.resolve(process.env.T2_EVIDENCE_FILE || `reports/t2-${kind}-tournament-buyin-solana-devnet.json`); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

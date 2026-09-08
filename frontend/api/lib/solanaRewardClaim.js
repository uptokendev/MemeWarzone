import { findProgramAddressSync, publicKeyBytes } from "../dev-fix/solana-v4-primitives.js";

const CONFIG_SEED = Buffer.from("rewards_config");
const AIRDROP_VAULT_SEED = Buffer.from("airdrop_vault");
const AIRDROP_BATCH_SEED = Buffer.from("airdrop_batch");
const AIRDROP_CLAIM_SEED = Buffer.from("airdrop_claim");
const SQUAD_VAULT_SEED = Buffer.from("squad_vault");
const SQUAD_BATCH_SEED = Buffer.from("squad_batch");
const SQUAD_CLAIM_SEED = Buffer.from("squad_claim");
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

const PROGRAM_CODES = Object.freeze({
  airdrop_trader: 0,
  airdrop_creator: 1,
});

function i64le(value) {
  let n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error("i64 overflow");
  if (n < 0n) n = (1n << 64n) + n;
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function metadata(row) {
  const raw = row?.metadata;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function proofFromMeta(meta) {
  const raw = Array.isArray(meta?.merkleProof)
    ? meta.merkleProof
    : Array.isArray(meta?.proof)
      ? meta.proof
      : Array.isArray(meta?.claimProof)
        ? meta.claimProof
        : [];
  const proof = raw.map((item) => String(item || "").trim()).filter(Boolean);
  return { proof, valid: proof.every((item) => BYTES32_RE.test(item)) };
}

export function solanaRewardsProgramId() {
  const programId = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
  if (!programId) return "";
  try {
    return publicKeyBytes(programId).length === 32 ? programId : "";
  } catch {
    return "";
  }
}

export function solanaRewardRpcUrl(chainId = 101) {
  const chain = Number(chainId);
  const candidates = [
    process.env[`SOLANA_REWARDS_RPC_URL_${chain}`],
    process.env[`SOLANA_RPC_URL_${chain}`],
    process.env.SOLANA_REWARDS_RPC_URL,
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_RPC_HTTP,
  ];
  return String(candidates.find(Boolean) || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function unavailableCall(row, chainId, rewardType, amount) {
  return {
    rewardLedgerId: String(row.id),
    chainId,
    tokenSymbol: row.token_symbol || "SOL",
    mode: "solana_unavailable",
    enabled: false,
    reason: `SOLANA_${rewardType.toUpperCase() || "REWARD"}_CLAIM_NOT_WIRED`,
    amount,
  };
}

function buildSolanaSquadCall(row, meta, chainId, amount) {
  const laneMeta = meta?.solanaRewardLane && typeof meta.solanaRewardLane === "object"
    ? meta.solanaRewardLane
    : {};
  const lane = firstString(laneMeta, ["lane"]) || "squad";
  const epochId = firstString(laneMeta, ["epochId", "onchainEpochId"]);
  const recipient = String(row.wallet_address || "").trim();
  const { proof, valid: proofValid } = proofFromMeta(laneMeta);
  const amountValid = /^\d+$/.test(amount) && BigInt(amount) > 0n;
  const epochValid = /^-?\d+$/.test(epochId);
  let walletBytes = null;
  try { walletBytes = publicKeyBytes(recipient); } catch {}

  let reason = null;
  if (lane !== "squad") reason = "INVALID_SOLANA_REWARD_LANE";
  else if (!walletBytes || walletBytes.length !== 32) reason = "INVALID_SOLANA_RECIPIENT";
  else if (!epochValid) reason = "MISSING_SOLANA_EPOCH_ID";
  else if (!proofValid) reason = "INVALID_MERKLE_PROOF";
  else if (!amountValid) reason = "AMOUNT_ZERO";

  const programId = solanaRewardsProgramId();
  if (!reason && !programId) reason = "MISSING_SOLANA_REWARDS_PROGRAM_ID";
  if (reason) {
    return {
      rewardLedgerId: String(row.id),
      chainId,
      tokenSymbol: row.token_symbol || "SOL",
      mode: "solana_airdrop",
      kind: "solana_reward_lane",
      lane: "squad",
      instruction: "claim_squad",
      enabled: false,
      reason,
      amount,
      proof,
      recipient,
      epochId,
      programId,
    };
  }

  const configAddress = findProgramAddressSync([CONFIG_SEED], programId).publicKey;
  const vaultAddress = findProgramAddressSync([SQUAD_VAULT_SEED], programId).publicKey;
  const batchAddress = findProgramAddressSync([SQUAD_BATCH_SEED, i64le(epochId)], programId).publicKey;
  const claimReceiptAddress = findProgramAddressSync([
    SQUAD_CLAIM_SEED,
    i64le(epochId),
    walletBytes,
  ], programId).publicKey;

  return {
    rewardLedgerId: String(row.id),
    chainId,
    tokenSymbol: row.token_symbol || "SOL",
    // Keep the compatibility envelope expected by the existing Claim Center.
    // `kind` is the authoritative dispatcher for the actual Solana instruction.
    mode: "solana_airdrop",
    kind: "solana_reward_lane",
    lane: "squad",
    instruction: "claim_squad",
    enabled: true,
    reason: null,
    programId,
    configAddress,
    vaultAddress,
    batchAddress,
    claimReceiptAddress,
    epochId,
    amount,
    proof,
    recipient,
    explorerTxBase: "https://explorer.solana.com/tx/",
  };
}

export function buildSolanaRewardCall(row) {
  const meta = metadata(row);
  const rewardType = String(row?.reward_type || "").toLowerCase();
  const chainId = Number(row?.chain) || Number(meta.chainId) || 101;
  const amount = String(row?.amount ?? "0");

  if (rewardType === "squad") return buildSolanaSquadCall(row, meta, chainId, amount);
  if (rewardType !== "airdrop") return unavailableCall(row, chainId, rewardType, amount);

  const program = firstString(meta, ["program", "rewardProgram"]);
  const programCode = Number(meta.programCode ?? PROGRAM_CODES[program]);
  const epochId = firstString(meta, ["solanaEpochId", "epochStartSec", "epochIdNumeric"]);
  const recipient = String(row.wallet_address || "").trim();
  const { proof, valid: proofValid } = proofFromMeta(meta);
  const amountValid = /^\d+$/.test(amount) && BigInt(amount) > 0n;
  const epochValid = /^-?\d+$/.test(epochId);
  let walletBytes = null;
  try { walletBytes = publicKeyBytes(recipient); } catch {}

  let reason = null;
  if (!walletBytes || walletBytes.length !== 32) reason = "INVALID_SOLANA_RECIPIENT";
  else if (!Number.isInteger(programCode) || programCode < 0 || programCode > 255) reason = "MISSING_SOLANA_PROGRAM_CODE";
  else if (!epochValid) reason = "MISSING_SOLANA_EPOCH_ID";
  else if (!proofValid) reason = "INVALID_MERKLE_PROOF";
  else if (!amountValid) reason = "AMOUNT_ZERO";

  const programId = solanaRewardsProgramId();
  if (!reason && !programId) reason = "MISSING_SOLANA_REWARDS_PROGRAM_ID";
  if (reason) {
    return {
      rewardLedgerId: String(row.id), chainId, tokenSymbol: row.token_symbol || "SOL",
      mode: "solana_airdrop", kind: "solana_airdrop", enabled: false, reason, amount, proof, recipient, epochId, programCode, programId,
    };
  }

  const configAddress = findProgramAddressSync([CONFIG_SEED], programId).publicKey;
  const vaultAddress = findProgramAddressSync([AIRDROP_VAULT_SEED], programId).publicKey;
  const batchAddress = findProgramAddressSync([AIRDROP_BATCH_SEED, i64le(epochId)], programId).publicKey;
  const claimReceiptAddress = findProgramAddressSync([
    AIRDROP_CLAIM_SEED,
    i64le(epochId),
    Buffer.from([programCode]),
    walletBytes,
  ], programId).publicKey;

  return {
    rewardLedgerId: String(row.id),
    chainId,
    tokenSymbol: row.token_symbol || "SOL",
    mode: "solana_airdrop",
    kind: "solana_airdrop",
    enabled: true,
    reason: null,
    programId,
    configAddress,
    vaultAddress,
    batchAddress,
    claimReceiptAddress,
    epochId,
    programCode,
    amount,
    proof,
    recipient,
    explorerTxBase: "https://explorer.solana.com/tx/",
  };
}

function rpcPayload(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

async function rpc(chainId, method, params) {
  const url = solanaRewardRpcUrl(chainId);
  if (!url) throw new Error("Solana reward RPC is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpcPayload(method, params),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(body.error.message || JSON.stringify(body.error));
    return body?.result;
  } finally {
    clearTimeout(timer);
  }
}

function accountKeyText(item) {
  if (typeof item === "string") return item;
  return String(item?.pubkey || "");
}

function instructionProgramId(ix, keys) {
  if (ix?.programId) return String(ix.programId);
  if (Number.isInteger(ix?.programIdIndex)) return accountKeyText(keys[ix.programIdIndex]);
  return "";
}

function instructionAccounts(ix, keys) {
  if (Array.isArray(ix?.accounts) && ix.accounts.every((item) => typeof item === "string")) return ix.accounts;
  if (Array.isArray(ix?.accounts)) return ix.accounts.map((index) => accountKeyText(keys[Number(index)])).filter(Boolean);
  return [];
}

export function isSolanaSignature(value) {
  return SOLANA_SIGNATURE_RE.test(String(value || "").trim());
}

export async function verifySolanaRewardClaim({ row, txHash, walletAddress }) {
  const call = buildSolanaRewardCall(row);
  if (!call.enabled) {
    const error = new Error(call.reason || "Solana reward claim is not ready");
    error.code = call.reason || "SOLANA_CLAIM_NOT_READY";
    error.status = 409;
    throw error;
  }
  if (!isSolanaSignature(txHash)) {
    const error = new Error("Invalid Solana transaction signature");
    error.code = "INVALID_SOLANA_TX_SIGNATURE";
    error.status = 400;
    throw error;
  }
  if (String(walletAddress || "").trim() !== call.recipient) {
    const error = new Error("Solana claim wallet does not match entitlement recipient");
    error.code = "SOLANA_CLAIM_WALLET_MISMATCH";
    error.status = 409;
    throw error;
  }

  const [tx, statusResult] = await Promise.all([
    rpc(call.chainId, "getTransaction", [txHash, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]),
    rpc(call.chainId, "getSignatureStatuses", [[txHash], { searchTransactionHistory: true }]),
  ]);
  if (!tx || tx?.meta?.err) {
    const error = new Error("Solana reward transaction is missing or failed");
    error.code = "SOLANA_CLAIM_TX_FAILED";
    error.status = 409;
    throw error;
  }
  const status = statusResult?.value?.[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(String(status.confirmationStatus))) {
    const error = new Error("Solana reward transaction is not confirmed");
    error.code = "SOLANA_CLAIM_NOT_CONFIRMED";
    error.status = 409;
    throw error;
  }

  const message = tx?.transaction?.message || {};
  const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  const matching = instructions.find((ix) => {
    if (instructionProgramId(ix, keys) !== call.programId) return false;
    const accounts = instructionAccounts(ix, keys);
    return accounts[0] === call.recipient &&
      accounts[1] === call.configAddress &&
      accounts[2] === call.vaultAddress &&
      accounts[3] === call.batchAddress &&
      accounts[4] === call.claimReceiptAddress;
  });
  if (!matching) {
    const error = new Error("Confirmed transaction did not execute the expected Solana reward claim accounts");
    error.code = "SOLANA_CLAIM_INSTRUCTION_MISMATCH";
    error.status = 409;
    throw error;
  }

  const vaultIndex = keys.findIndex((key) => accountKeyText(key) === call.vaultAddress);
  const pre = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
  const post = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
  if (vaultIndex < 0 || pre[vaultIndex] == null || post[vaultIndex] == null) {
    const error = new Error("Solana reward vault balance delta is unavailable");
    error.code = "SOLANA_CLAIM_BALANCE_UNAVAILABLE";
    error.status = 409;
    throw error;
  }
  const vaultDelta = BigInt(pre[vaultIndex]) - BigInt(post[vaultIndex]);
  if (vaultDelta !== BigInt(call.amount)) {
    const error = new Error(`Solana reward vault moved ${vaultDelta} lamports, expected ${call.amount}`);
    error.code = "SOLANA_CLAIM_AMOUNT_MISMATCH";
    error.status = 409;
    throw error;
  }

  return {
    chainId: call.chainId,
    txHash,
    slot: tx.slot,
    confirmationStatus: status.confirmationStatus,
    programId: call.programId,
    walletAddress: call.recipient,
    vaultAddress: call.vaultAddress,
    batchAddress: call.batchAddress,
    claimReceiptAddress: call.claimReceiptAddress,
    epochId: call.epochId,
    programCode: call.kind === "solana_airdrop" ? call.programCode : null,
    lane: call.kind === "solana_reward_lane" ? call.lane : null,
    amount: call.amount,
  };
}

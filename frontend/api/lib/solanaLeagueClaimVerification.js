import {
  REWARDS_TREASURY_PROGRAM_ID,
  deriveLeagueClaimPda,
  deriveLeagueEpochPda,
  deriveRewardsVaults,
} from "../solanaLeagueMerkle.js";

const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function rpcUrl(chainId) {
  const cid = Number(chainId);
  return (
    String(process.env[`SOLANA_REWARDS_RPC_URL_${cid}`] || "").trim() ||
    String(process.env[`SOLANA_RPC_URL_${cid}`] || "").trim() ||
    String(process.env.SOLANA_REWARDS_RPC_URL || "").trim() ||
    String(process.env.SOLANA_RPC_URL || "").trim() ||
    String(process.env.SOLANA_RPC_HTTP || "").trim()
  ).split(",").map((item) => item.trim()).find(Boolean) || "";
}

async function rpc(chainId, method, params) {
  const url = rpcUrl(chainId);
  if (!url) {
    const error = new Error(`Solana reward RPC is not configured for chain ${chainId}`);
    error.code = "SOLANA_LEAGUE_RPC_MISSING";
    error.status = 500;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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

export function buildExpectedSolanaLeagueClaim({ chainId, period, epochStart, category, rank, recipient, amountRaw }) {
  const cid = Number(chainId);
  if (cid !== 101 && cid !== 102) throw new Error("Solana League verification only supports chain IDs 101/102");
  const epochDate = new Date(epochStart);
  if (Number.isNaN(epochDate.getTime())) throw new Error("Invalid Solana League epochStart");
  const epochStartSec = Math.floor(epochDate.getTime() / 1000);
  const programId = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || REWARDS_TREASURY_PROGRAM_ID).trim();
  const vaults = deriveRewardsVaults(programId);
  return {
    chainId: cid,
    programId,
    recipient: String(recipient || "").trim(),
    amountRaw: String(amountRaw || "0"),
    configAddress: vaults.config,
    vaultAddress: vaults.leagueVault,
    epochAddress: deriveLeagueEpochPda(period, epochStartSec, programId),
    claimReceiptAddress: deriveLeagueClaimPda(period, epochStartSec, category, rank, programId),
    epochStartSec,
  };
}

export async function verifySolanaLeagueClaimTransaction({
  chainId,
  period,
  epochStart,
  category,
  rank,
  recipient,
  amountRaw,
  txHash,
}) {
  const expected = buildExpectedSolanaLeagueClaim({
    chainId,
    period,
    epochStart,
    category,
    rank,
    recipient,
    amountRaw,
  });
  const signature = String(txHash || "").trim();
  if (!SOLANA_SIGNATURE_RE.test(signature)) {
    const error = new Error("Invalid Solana League transaction signature");
    error.code = "SOLANA_LEAGUE_TX_INVALID";
    error.status = 400;
    throw error;
  }
  if (!/^\d+$/.test(expected.amountRaw) || BigInt(expected.amountRaw) <= 0n) {
    const error = new Error("Invalid Solana League payout amount");
    error.code = "SOLANA_LEAGUE_AMOUNT_INVALID";
    error.status = 409;
    throw error;
  }

  const [tx, statusResult] = await Promise.all([
    rpc(expected.chainId, "getTransaction", [signature, {
      encoding: "jsonParsed",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    }]),
    rpc(expected.chainId, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]),
  ]);

  if (!tx || tx?.meta?.err) {
    const error = new Error("Solana League transaction is missing or failed");
    error.code = "SOLANA_LEAGUE_TX_FAILED";
    error.status = 409;
    throw error;
  }
  const status = statusResult?.value?.[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(String(status.confirmationStatus))) {
    const error = new Error("Solana League transaction is not confirmed");
    error.code = "SOLANA_LEAGUE_TX_NOT_CONFIRMED";
    error.status = 409;
    throw error;
  }

  const message = tx?.transaction?.message || {};
  const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  const matching = instructions.find((ix) => {
    if (instructionProgramId(ix, keys) !== expected.programId) return false;
    const accounts = instructionAccounts(ix, keys);
    return accounts[0] === expected.recipient &&
      accounts[1] === expected.configAddress &&
      accounts[2] === expected.vaultAddress &&
      accounts[3] === expected.epochAddress &&
      accounts[4] === expected.claimReceiptAddress;
  });
  if (!matching) {
    const error = new Error("Confirmed transaction did not execute the expected Solana League claim accounts");
    error.code = "SOLANA_LEAGUE_INSTRUCTION_MISMATCH";
    error.status = 409;
    throw error;
  }

  const recipientIndex = keys.findIndex((key) => accountKeyText(key) === expected.recipient);
  const vaultIndex = keys.findIndex((key) => accountKeyText(key) === expected.vaultAddress);
  const pre = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
  const post = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
  if (vaultIndex < 0 || pre[vaultIndex] == null || post[vaultIndex] == null) {
    const error = new Error("Solana League vault balance delta is unavailable");
    error.code = "SOLANA_LEAGUE_VAULT_DELTA_UNAVAILABLE";
    error.status = 409;
    throw error;
  }
  const vaultDelta = BigInt(pre[vaultIndex]) - BigInt(post[vaultIndex]);
  if (vaultDelta !== BigInt(expected.amountRaw)) {
    const error = new Error(`Solana League vault moved ${vaultDelta} lamports, expected ${expected.amountRaw}`);
    error.code = "SOLANA_LEAGUE_AMOUNT_MISMATCH";
    error.status = 409;
    throw error;
  }

  // The winner normally pays transaction fees, so recipient net balance is not
  // required to rise by exactly amountRaw. Still require the expected winner to
  // be present in the balance arrays; the exact payout is proven by vault delta.
  if (recipientIndex < 0 || pre[recipientIndex] == null || post[recipientIndex] == null) {
    const error = new Error("Solana League recipient balance evidence is unavailable");
    error.code = "SOLANA_LEAGUE_RECIPIENT_BALANCE_UNAVAILABLE";
    error.status = 409;
    throw error;
  }

  return {
    ...expected,
    txHash: signature,
    slot: tx.slot,
    confirmationStatus: status.confirmationStatus,
    vaultDeltaLamports: vaultDelta.toString(),
    recipientPreLamports: String(pre[recipientIndex]),
    recipientPostLamports: String(post[recipientIndex]),
  };
}

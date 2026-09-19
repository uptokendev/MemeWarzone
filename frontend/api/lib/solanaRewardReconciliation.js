import {
  buildSolanaRewardCall,
  solanaRewardRpcUrl,
  verifySolanaRewardClaim,
} from "./solanaRewardClaim.js";
import { withRpcRetry } from "./rpcResilience.js";

function reconciliationError(message, code, status = 409, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
}

async function rpc(chainId, method, params) {
  const url = solanaRewardRpcUrl(chainId);
  if (!url) {
    throw reconciliationError(
      `Solana reward RPC is not configured for chain ${chainId}`,
      "SOLANA_CLAIM_RECONCILE_RPC_UNAVAILABLE",
      503,
    );
  }

  // The retry runs on the raw failure, before it is normalised below. Every
  // failure here ends up a 503, and a 503 reads as transient, so normalising
  // first would make even a malformed request burn the whole retry budget.
  try {
    return await withRpcRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const body = await response.json();
        if (body?.error) throw new Error(body.error.message || JSON.stringify(body.error));
        return body?.result;
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (error) {
    throw reconciliationError(
      `Solana RPC ${method} failed: ${String(error?.message || error)}`,
      "SOLANA_CLAIM_RECONCILE_RPC_UNAVAILABLE",
      503,
    );
  }
}

/**
 * Resolve the transaction that created/touched a deterministic claim receipt.
 *
 * The receipt account is authoritative evidence that a claim instruction committed,
 * but it is not enough by itself to repair the database. Every candidate signature is
 * still passed through the existing strict claim verifier (program/accounts/vault delta).
 */
export async function discoverVerifiedReceiptTransaction({
  claimCall,
  rpcCall = rpc,
  verifyCandidate,
  signatureLimit = 8,
}) {
  if (!claimCall?.enabled || !claimCall?.claimReceiptAddress) {
    throw reconciliationError(
      claimCall?.reason || "Solana reward claim receipt is not derivable",
      claimCall?.reason || "SOLANA_CLAIM_RECEIPT_NOT_DERIVABLE",
      409,
    );
  }
  if (typeof verifyCandidate !== "function") {
    throw new TypeError("verifyCandidate is required");
  }

  const receipt = await rpcCall(claimCall.chainId, "getAccountInfo", [
    claimCall.claimReceiptAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!receipt?.value) return null;

  const signatures = await rpcCall(claimCall.chainId, "getSignaturesForAddress", [
    claimCall.claimReceiptAddress,
    { commitment: "confirmed", limit: Math.max(1, Math.min(Number(signatureLimit) || 8, 20)) },
  ]);

  let attempted = 0;
  let lastVerificationError = null;
  for (const entry of Array.isArray(signatures) ? signatures : []) {
    const signature = String(entry?.signature || "").trim();
    if (!signature || entry?.err) continue;
    attempted += 1;
    try {
      return await verifyCandidate(signature);
    } catch (error) {
      lastVerificationError = error;
    }
  }

  throw reconciliationError(
    "Claim receipt exists, but no matching confirmed settlement transaction could be strictly verified.",
    "SOLANA_CLAIM_RECEIPT_TX_UNVERIFIED",
    409,
    {
      claimReceiptAddress: claimCall.claimReceiptAddress,
      attemptedSignatures: attempted,
      lastVerificationCode: lastVerificationError?.code || null,
      lastVerificationMessage: lastVerificationError?.message || null,
    },
  );
}

export async function discoverSolanaRewardClaim({ row, walletAddress, signatureLimit = 8 }) {
  const call = buildSolanaRewardCall(row);
  if (!call.enabled) {
    throw reconciliationError(
      call.reason || "Solana reward claim is not ready",
      call.reason || "SOLANA_CLAIM_NOT_READY",
      409,
    );
  }

  const wallet = String(walletAddress || "").trim();
  if (!wallet || wallet !== call.recipient) {
    throw reconciliationError(
      "Solana reconciliation wallet does not match entitlement recipient",
      "SOLANA_CLAIM_RECONCILE_WALLET_MISMATCH",
      409,
    );
  }

  return discoverVerifiedReceiptTransaction({
    claimCall: call,
    signatureLimit,
    verifyCandidate: (txHash) => verifySolanaRewardClaim({
      row,
      txHash,
      walletAddress: wallet,
    }),
  });
}

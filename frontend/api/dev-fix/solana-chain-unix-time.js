/**
 * Confirmed Solana unix time for authorization deadlines.
 * getSlot then getBlockTime on the same slot races on load-balanced RPCs
 * ("Block not available for slot N"). Retry the head slot, then walk back.
 */

const SLOT_OFFSETS = [0, 0, 1, 2, 4, 8, 16, 32];
const RETRY_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  const cause = error && typeof error === "object" ? error.cause : null;
  return [error?.message, cause?.message, String(error || "")].filter(Boolean).join(" ");
}

export function isTransientSolanaBlockTimeError(error) {
  const text = errorText(error);
  return /block not available/i.test(text)
    || /was skipped/i.test(text)
    || /cleaned up/i.test(text)
    || /slot .* not available/i.test(text);
}

async function jsonRpc(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
  }
  if (payload?.error) {
    throw new Error(`Solana RPC ${method} failed: ${payload.error.message || "unknown"}`);
  }
  return payload?.result;
}

export async function getSolanaChainUnixTime(rpcUrl, rpc = jsonRpc) {
  const slot = await rpc(rpcUrl, "getSlot", [{ commitment: "confirmed" }]);
  const head = Number(slot);
  if (!Number.isInteger(head) || head <= 0) {
    throw new Error("Solana RPC getSlot returned an invalid slot.");
  }

  let lastError = null;
  for (let index = 0; index < SLOT_OFFSETS.length; index += 1) {
    const candidate = head - SLOT_OFFSETS[index];
    if (candidate <= 0) break;
    if (index === 1) await sleep(RETRY_DELAY_MS);
    try {
      const blockTime = await rpc(rpcUrl, "getBlockTime", [candidate]);
      if (Number.isInteger(blockTime) && blockTime > 0) return blockTime;
      lastError = new Error("Solana RPC did not return a confirmed block time.");
    } catch (error) {
      lastError = error;
      if (!isTransientSolanaBlockTimeError(error)) throw error;
    }
  }
  throw lastError || new Error("Solana RPC did not return a confirmed block time.");
}

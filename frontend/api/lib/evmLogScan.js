/**
 * Shared eth_getLogs resilience for claim recovery.
 *
 * Claim recovery reads the chain to decide whether a paid-out entitlement is
 * recoverable. A provider hiccup there does not look like a hiccup to the
 * caller: it looks like "this claim cannot be recovered", which is the exact
 * failure mode that must never happen on a real payout.
 *
 * Two different provider limits surface as the same kind of rejection and need
 * opposite responses:
 *
 *   - a block-range limit ("range too large"): the request will never succeed
 *     as issued, so the window has to shrink;
 *   - a rate / compute-unit limit (BlockPI answers -32005 "limit exceeded" even
 *     for a 150-block span): the request is fine, the caller is simply going
 *     too fast, so shrinking the window makes it strictly worse by issuing more
 *     requests. It has to wait and retry instead.
 *
 * Callers combine both: retry with backoff first, then narrow.
 */

const TRANSIENT_MESSAGE = /limit exceeded|rate.?limit|too many requests|429|request timed out|timeout|etimedout|econnreset|econnrefused|socket hang up|network error|bad gateway|service unavailable|temporarily unavailable|server error|try again/i;

const TRANSIENT_JSON_RPC_CODES = new Set([
  -32005, // request/rate limit exceeded (BlockPI, Infura, Alchemy)
  -32016, // over compute-unit quota (some providers)
  -32603, // internal error; usually transient upstream trouble
  -32000, // generic server error; providers overload this one
]);

function jsonRpcCodes(error) {
  const codes = [];
  const seen = new Set();
  let node = error;
  for (let depth = 0; node && typeof node === "object" && depth < 6; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    if (typeof node.code === "number") codes.push(node.code);
    node = node.error || node.info?.error || node.cause;
  }
  return codes;
}

function errorText(error) {
  if (!error) return "";
  const parts = [];
  if (typeof error === "string") parts.push(error);
  if (typeof error?.message === "string") parts.push(error.message);
  if (typeof error?.shortMessage === "string") parts.push(error.shortMessage);
  if (typeof error?.error?.message === "string") parts.push(error.error.message);
  if (typeof error?.info?.error?.message === "string") parts.push(error.info.error.message);
  return parts.join(" | ");
}

/**
 * True when the rejection is worth waiting out rather than reporting as a
 * permanent "cannot recover this claim".
 */
export function isTransientRpcError(error) {
  if (!error) return false;
  if (jsonRpcCodes(error).some((code) => TRANSIENT_JSON_RPC_CODES.has(code))) return true;
  const status = Number(error?.status ?? error?.info?.status);
  if (Number.isFinite(status) && (status === 429 || status >= 500)) return true;
  const code = String(error?.code || "");
  if (code === "SERVER_ERROR" || code === "TIMEOUT" || code === "NETWORK_ERROR") return true;
  return TRANSIENT_MESSAGE.test(errorText(error));
}

/**
 * True when the provider is objecting to the size of the span, so narrowing the
 * window is the response that can actually help.
 */
export function isRangeLimitRpcError(error) {
  return /range|block range|too large|exceed(s|ed)? .{0,24}blocks?|more than .{0,16}blocks?|query returned more than/i.test(errorText(error));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * eth_getLogs with bounded exponential backoff on transient rejections.
 *
 * Non-transient rejections (a malformed filter, an unsupported method) are
 * rethrown immediately: retrying those only wastes the caller's time budget.
 */
export async function getLogsWithRetry(provider, filter, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? 5));
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs ?? 400));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs ?? 8_000));
  const wait = options.sleep || sleep;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await provider.getLogs(filter);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      if (!isTransientRpcError(error)) throw error;
      // Jitter keeps concurrent recoveries of the same wallet from retrying in
      // lockstep and re-tripping the same quota together.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await wait(backoff + Math.floor(Math.random() * Math.min(250, backoff)));
    }
  }
  throw lastError;
}

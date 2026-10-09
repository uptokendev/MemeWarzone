// Read-provider failover across a list of public RPC URLs.
//
// The browser's read provider used only the first URL of VITE_PUBLIC_RPC_<id>.
// With the paid key out of the browser bundle the list holds public endpoints,
// which rate-limit (-32005 / HTTP 429) or drop requests now and then. This
// sends each request to the first URL and, only when that URL fails at the
// transport level or answers with a rate limit, to the next one. A normal
// JSON-RPC error (a revert, a bad argument) is a real answer and is returned
// as is. No quorum: one answer is used, as before.

const RATE_LIMIT = /limit exceeded|rate limit|too many requests|429|capacity|-32005/i;

function isRateLimited(entry) {
  const error = entry?.error;
  if (!error) return false;
  return Number(error.code) === -32005 || Number(error.code) === 429 || RATE_LIMIT.test(String(error.message || ""));
}

/**
 * Returns a send(payload) that tries `senders` in order. Each sender is the
 * `_send` of one ethers JsonRpcProvider (payload -> array of results/errors).
 * The URL that answered last is tried first next time.
 */
export function failoverSend(senders) {
  let preferred = 0;
  return async function send(payload) {
    let lastError = null;
    let lastResult = null;
    for (let i = 0; i < senders.length; i += 1) {
      const index = (preferred + i) % senders.length;
      try {
        const result = await senders[index](payload);
        if (Array.isArray(result) && result.some(isRateLimited) && i < senders.length - 1) {
          lastResult = result;
          continue;
        }
        preferred = index;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastResult) return lastResult;
    throw lastError || new Error("No RPC URL answered");
  };
}

/**
 * Builds one read provider over `urls`: a JsonRpcProvider on the first URL
 * whose _send fails over to providers on the other URLs. One URL: a plain
 * JsonRpcProvider, exactly as before.
 */
export function makeFailoverReadProvider(ethers, urls, network, options) {
  const primary = new ethers.JsonRpcProvider(urls[0], network, options);
  if (urls.length < 2) return primary;
  const others = urls.slice(1).map((url) => new ethers.JsonRpcProvider(url, network, options));
  const primarySend = primary._send.bind(primary);
  primary._send = failoverSend([primarySend, ...others.map((p) => p._send.bind(p))]);
  return primary;
}

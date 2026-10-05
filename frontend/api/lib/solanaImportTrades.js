/**
 * Recent trades of an imported Solana coin read straight from the chain (founder, 2026-10-06:
 * GeckoTerminal showed trades minutes late). Per pool: one getSignaturesForAddress (1 Helius
 * credit), then getTransaction once per signature we have not parsed yet (1 credit each, batched).
 * A pool is read at most once per 10 seconds.
 * Parsed transactions are kept, and a pool's answer is shared by every viewer for a few seconds, so
 * the cost follows the number of coins open, not the number of visitors.
 *
 * A trade is read from the signer's own balance changes: the coin's token balance (bought or sold)
 * and its SOL / wrapped SOL change, fee added back. That works the same on Pump.fun, PumpSwap,
 * Meteora and Raydium without parsing each program.
 */

const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
export const ONCHAIN_POOL_TTL_MS = 10_000;
const SIGNATURE_PAGE = 40;
const MAX_NEW_PER_REFRESH = 40;
const PARSED_CACHE_MAX = 5_000;

export function solanaRpcUrl(env = process.env) {
  return String(env.SOLANA_RPC_URL || env.SOLANA_MAINNET_RPC_URL || env.SOLANA_RPC_HTTP || "").trim();
}

function uiAmount(b) {
  const t = b?.uiTokenAmount;
  if (!t) return 0;
  if (t.uiAmountString != null) return Number(t.uiAmountString) || 0;
  return Number(t.uiAmount) || 0;
}

function deltasByOwner(meta, mint) {
  const out = new Map();
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b?.mint !== mint || !b.owner) continue;
      out.set(b.owner, (out.get(b.owner) || 0) + sign * uiAmount(b));
    }
  };
  add(meta?.preTokenBalances, -1);
  add(meta?.postTokenBalances, 1);
  return out;
}

/**
 * One parsed transaction -> a trade row for `tokenAddress`, or null when it is not a swap of it.
 * The trader is the wallet whose coin balance changed (also when a bot signed for it); the pool is
 * the owner that holds both the coin and SOL. The SOL amount is the pool's own SOL change (its
 * wrapped SOL, or the curve account's lamports on Pump.fun), which leaves out fees and rent.
 */
export function parseSolanaTrade(tx, signature, tokenAddress, solUsd = 0, pairAddress = null) {
  const meta = tx?.meta;
  if (!tx || !meta || meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const pubkeys = keys.map((k) => (typeof k === "string" ? k : k?.pubkey)).filter(Boolean);
  const signerIndex = keys.findIndex((k) => typeof k === "object" && k?.signer);
  const signer = pubkeys[signerIndex >= 0 ? signerIndex : 0];

  const tokenDeltas = deltasByOwner(meta, tokenAddress);
  const wsolDeltas = deltasByOwner(meta, WSOL);
  const stableDeltas = new Map();
  for (const mint of STABLES) for (const [o, d] of deltasByOwner(meta, mint)) stableDeltas.set(o, (stableDeltas.get(o) || 0) + d);
  const moved = (o) => Math.abs(tokenDeltas.get(o) || 0) > 1e-12;
  const preTokens = new Map();
  for (const bal of meta.preTokenBalances || []) if (bal?.mint === tokenAddress && bal.owner) preTokens.set(bal.owner, (preTokens.get(bal.owner) || 0) + uiAmount(bal));

  // The pool trades the coin against SOL: coin and wrapped SOL move in opposite directions. With
  // more than one such wallet (a trader paying in wrapped SOL), the pool holds by far the most coins.
  const poolCandidates = [...tokenDeltas.keys()].filter((o) => {
    if (o === pairAddress) return true;
    const t = tokenDeltas.get(o) || 0;
    const q = wsolDeltas.get(o) || 0;
    return Math.abs(t) > 1e-12 && Math.abs(q) > 1e-12 && Math.sign(t) !== Math.sign(q);
  });
  poolCandidates.sort((x, y) => (preTokens.get(y) || 0) - (preTokens.get(x) || 0));
  const pool = poolCandidates[0] || null;
  const poolSign = pool ? Math.sign(tokenDeltas.get(pool) || 0) : 0;

  // The trader: the signer when its coin moved (most trades), else the wallet whose coin moved the
  // other way from the pool (a bot signed for it), largest first.
  let maker = moved(signer) && signer !== pool ? signer : null;
  if (!maker) {
    const others = [...tokenDeltas.keys()].filter((o) => o !== pool && moved(o) && (!poolSign || Math.sign(tokenDeltas.get(o)) === -poolSign));
    others.sort((x, y) => Math.abs(tokenDeltas.get(y)) - Math.abs(tokenDeltas.get(x)));
    maker = others[0] || null;
  }
  if (!maker) return null;
  const tokenDelta = tokenDeltas.get(maker);
  const poolOwners = new Set(pool ? [pool] : []);
  if (pairAddress) poolOwners.add(pairAddress);

  // SOL amount: the pool's wrapped SOL change, else the pool account's lamports, else the trader's.
  let nativeAmount = null;
  for (const owner of poolOwners) {
    const d = wsolDeltas.get(owner);
    if (d && Math.abs(d) > 1e-9) nativeAmount = Math.max(nativeAmount || 0, Math.abs(d));
  }
  if (nativeAmount == null && pairAddress) {
    const i = pubkeys.indexOf(pairAddress);
    if (i >= 0) {
      const d = (Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0)) / 1e9;
      if (Math.abs(d) > 1e-9) nativeAmount = Math.abs(d);
    }
  }
  if (nativeAmount == null) {
    const i = pubkeys.indexOf(maker);
    const lamports = i >= 0 ? Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0) : 0;
    const fee = i === 0 ? Number(meta.fee || 0) : 0;
    const d = (lamports + fee) / 1e9 + (wsolDeltas.get(maker) || 0);
    if (Math.abs(d) > 1e-9) nativeAmount = Math.abs(d);
  }
  let stableDelta = 0;
  for (const owner of poolOwners) stableDelta += stableDeltas.get(owner) || 0;
  const volumeUsd = Math.abs(stableDelta) > 1e-9 ? Math.abs(stableDelta) : nativeAmount != null && solUsd > 0 ? nativeAmount * solUsd : null;
  return {
    txHash: signature,
    side: tokenDelta > 0 ? "buy" : "sell",
    maker,
    tokenAmount: Math.abs(tokenDelta),
    nativeAmount: Math.abs(stableDelta) > 1e-9 && nativeAmount == null ? null : nativeAmount,
    volumeUsd,
    blockTime: Number(tx.blockTime || 0),
    blockNumber: tx.slot != null ? Number(tx.slot) : null,
  };
}

export function createSolanaImportTrades({ fetchImpl = fetch, rpcUrl = solanaRpcUrl(), now = () => Date.now(), solUsdPrice = async () => 0 } = {}) {
  const pools = new Map(); // pool -> { at, trades }
  const inflight = new Map();
  const parsed = new Map(); // signature -> trade | null
  const misses = new Map(); // signature -> times the node had no answer yet
  let calls = 0;

  async function rpc(body) {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw Object.assign(new Error(`Solana RPC ${res.status}`), { status: res.status });
    calls += Array.isArray(body) ? body.length : 1;
    return res.json();
  }

  function remember(signature, value) {
    parsed.set(signature, value);
    if (parsed.size > PARSED_CACHE_MAX) parsed.delete(parsed.keys().next().value);
  }

  async function refresh(pairAddress, tokenAddress) {
    const sigRes = await rpc({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [pairAddress, { limit: SIGNATURE_PAGE, commitment: "confirmed" }] });
    if (sigRes?.error) throw new Error(sigRes.error.message || "getSignaturesForAddress failed");
    const sigs = (sigRes?.result || []).filter((s) => s && !s.err).map((s) => s.signature);
    const fresh = sigs.filter((s) => !parsed.has(`${tokenAddress}:${s}`)).slice(0, MAX_NEW_PER_REFRESH);
    if (fresh.length) {
      const solUsd = await solUsdPrice().catch(() => 0);
      for (let i = 0; i < fresh.length; i += 20) {
        const chunk = fresh.slice(i, i + 20);
        const out = await rpc(
          chunk.map((sig, j) => ({ jsonrpc: "2.0", id: j, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] })),
        );
        const byId = new Map((Array.isArray(out) ? out : []).map((r) => [r.id, r]));
        chunk.forEach((sig, j) => {
          const r = byId.get(j);
          const key = `${tokenAddress}:${sig}`;
          // An error answer is final (remembered, never fetched again). A transaction the node does
          // not have yet is tried at most three more times.
          if (r?.error) return remember(key, null);
          if (!r || r.result == null) {
            const tries = (misses.get(key) || 0) + 1;
            if (tries >= 3) {
              misses.delete(key);
              remember(key, null);
            } else misses.set(key, tries);
            return;
          }
          misses.delete(key);
          remember(key, parseSolanaTrade(r.result, sig, tokenAddress, solUsd, pairAddress));
        });
      }
    }
    return sigs.map((s) => parsed.get(`${tokenAddress}:${s}`)).filter(Boolean).sort((a, b) => b.blockTime - a.blockTime);
  }

  /** Newest trades first. Throws when the chain cannot be read (the caller falls back). */
  async function trades({ pairAddress, tokenAddress }) {
    if (!rpcUrl) throw new Error("Solana RPC is not configured");
    const key = `${pairAddress}:${tokenAddress}`;
    const hit = pools.get(key);
    if (hit && now() - hit.at < ONCHAIN_POOL_TTL_MS) return hit.trades;
    if (inflight.has(key)) return inflight.get(key);
    const request = refresh(pairAddress, tokenAddress)
      .then((list) => {
        pools.set(key, { at: now(), trades: list });
        return list;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }

  return { trades, stats: () => ({ calls, parsed: parsed.size, pools: pools.size }) };
}

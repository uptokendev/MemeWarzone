// Unmatched outflows: native-coin transfers OUT of our multisig and operator
// wallets that no recorded movement covers (same tx hash and sending account),
// so the founder can record each one with one click (prefilled). Read-only:
// JSON-RPC getSignaturesForAddress / getTransaction on Solana, public explorer
// APIs on EVM. Nothing signs, nothing sends, no key is loaded except an
// optional explorer API key, which is never echoed.
//
//   Solana (101)       RPC: the account's lamport change per transaction.
//   BNB Chain (56)     Etherscan API v2 (chainid=56): normal + internal txs.
//                      Needs ETHERSCAN_API_KEY; without it the read says so.
//   Robinhood (4663)   Blockscout API v2 (robinhoodchain.blockscout.com).
//
// Gas-sized moves are left out (below the per-chain threshold): they are
// network fees, not treasury movements.
//
// Program-mediated outflows: on Solana each row also carries the programs the
// transaction called and the tokens the wallet received in it, so a buy of a
// coin through our launchpad program is recognized (the handler then names the
// coin from curve_trades by the transaction hash).

import { solanaRpcUrls } from "./financeFeeRouting.js";
import { atomicToDecimal } from "./financeFeeRouting.js";
import { SOLANA_LAUNCHPAD_PROGRAM_ID } from "./financeFeeRoutingSolana.js";

const SYSTEM_PROGRAMS = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"]);

/** Programs a parsed Solana transaction called (top level), and the tokens `owner` received in it. */
export function solanaTxDetails(tx, owner) {
  const programs = [...new Set((tx?.transaction?.message?.instructions || []).map((ix) => ix.programId).filter((id) => id && !SYSTEM_PROGRAMS.has(id)))];
  const balance = (list) => {
    const out = new Map();
    for (const b of list || []) {
      if (b.owner !== owner) continue;
      out.set(b.mint, { raw: BigInt(b.uiTokenAmount?.amount || "0"), decimals: Number(b.uiTokenAmount?.decimals || 0) });
    }
    return out;
  };
  const pre = balance(tx?.meta?.preTokenBalances);
  const post = balance(tx?.meta?.postTokenBalances);
  const tokensIn = [];
  for (const [mint, p] of post) {
    const delta = p.raw - (pre.get(mint)?.raw || 0n);
    if (delta > 0n) tokensIn.push({ mint, amount: atomicToDecimal(delta.toString(), p.decimals) });
  }
  return { programs, tokensIn, viaLaunchpad: programs.includes(SOLANA_LAUNCHPAD_PROGRAM_ID) };
}

const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60_000;
const MAX_SOLANA_TX = 60;
const TX_PAUSE_MS = Number(process.env.FINANCE_DETECT_TX_PAUSE_MS || 250);
export const MIN_OUTFLOW = Object.freeze({ SOL: 0.01, BNB: 0.001, ETH: 0.0005 });
const NATIVE = Object.freeze({ 101: { asset: "SOL", decimals: 9 }, 56: { asset: "BNB", decimals: 18 }, 4663: { asset: "ETH", decimals: 18 } });
const cache = new Map();

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function rpc(fetchImpl, url, method, params) {
  let res;
  // A rate-limited public RPC answers 429: wait and try twice more.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    res = await withTimeout(fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    if (res.status !== 429) break;
    await pause(1000 * (attempt + 1));
  }
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`${method}: ${body.error.message || "rpc error"}`);
  return body?.result;
}

async function getJson(fetchImpl, url) {
  const res = await withTimeout(fetchImpl(url, { headers: { accept: "application/json" } }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers?.get?.("content-type") || "");
  if (type && !type.includes("json")) throw new Error("The explorer did not answer with JSON (blocked or down).");
  return res.json();
}

/** Outflows of one Solana account from its recent transactions. */
export async function solanaOutflows({ address, sinceMs, fetchImpl = fetch, env = process.env }) {
  const urls = solanaRpcUrls(env);
  let lastError = null;
  for (const url of urls) {
    try {
      const sigs = await rpc(fetchImpl, url, "getSignaturesForAddress", [address, { limit: 200, commitment: "finalized" }]);
      const recent = (sigs || []).filter((s) => !s.err && s.blockTime && s.blockTime * 1000 >= sinceMs).slice(0, MAX_SOLANA_TX);
      const out = [];
      for (const s of recent) {
        if (out.length || s !== recent[0]) await pause(TX_PAUSE_MS);
        const tx = await rpc(fetchImpl, url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
        if (!tx?.meta) continue;
        const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
        const i = keys.indexOf(address);
        if (i < 0) continue;
        const delta = Number(tx.meta.postBalances[i]) - Number(tx.meta.preBalances[i]);
        if (!(delta < 0)) continue;
        // Counterpart: the account that gained the most in the same transaction.
        let best = null;
        keys.forEach((k, j) => {
          const d = Number(tx.meta.postBalances[j]) - Number(tx.meta.preBalances[j]);
          if (j !== i && d > 0 && (!best || d > best.delta)) best = { address: k, delta: d };
        });
        out.push({ txHash: s.signature, at: new Date(s.blockTime * 1000).toISOString(), raw: String(-delta), to: best?.address || null, ...solanaTxDetails(tx, address) });
      }
      return { rows: out, source: `Solana RPC ${new URL(url).host}`, truncated: (sigs || []).length >= 200 || recent.length >= MAX_SOLANA_TX };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Solana RPC.");
}

/** Outflows of one EVM address on BNB Chain from Etherscan API v2 (normal and internal transactions). */
export async function etherscanOutflows({ chainId, address, sinceMs, fetchImpl = fetch, env = process.env }) {
  const key = String(env.ETHERSCAN_API_KEY || env.BSCSCAN_API_KEY || "").trim();
  if (!key) throw new Error("Set ETHERSCAN_API_KEY on the API to read BNB Chain transfers (Etherscan API v2).");
  const lower = address.toLowerCase();
  const rows = [];
  for (const action of ["txlist", "txlistinternal"]) {
    const params = new URLSearchParams({ chainid: String(chainId), module: "account", action, address, startblock: "0", endblock: "99999999", page: "1", offset: "200", sort: "desc", apikey: key });
    const body = await getJson(fetchImpl, `https://api.etherscan.io/v2/api?${params}`);
    if (body?.status !== "1" && !/No transactions found/i.test(String(body?.message || ""))) throw new Error(`Etherscan ${action}: ${String(body?.result || body?.message || "error").slice(0, 120)}`);
    for (const t of Array.isArray(body?.result) ? body.result : []) {
      const at = Number(t.timeStamp) * 1000;
      if (String(t.from).toLowerCase() !== lower || !(at >= sinceMs) || t.isError === "1" || !/^\d+$/.test(String(t.value)) || t.value === "0") continue;
      rows.push({ txHash: t.hash, at: new Date(at).toISOString(), raw: String(t.value), to: t.to || null });
    }
  }
  return { rows, source: "Etherscan API v2", truncated: false };
}

/** Outflows of one EVM address on Robinhood Chain from Blockscout. */
export async function blockscoutOutflows({ address, sinceMs, fetchImpl = fetch, base = "https://robinhoodchain.blockscout.com" }) {
  const lower = address.toLowerCase();
  const rows = [];
  for (const path of ["transactions", "internal-transactions"]) {
    const body = await getJson(fetchImpl, `${base}/api/v2/addresses/${address}/${path}?filter=from`);
    for (const t of body?.items || []) {
      const at = Date.parse(t.timestamp);
      const from = String(t.from?.hash || "").toLowerCase();
      if (from !== lower || !(at >= sinceMs) || (t.status && t.status !== "ok" && t.success !== true) || !/^\d+$/.test(String(t.value)) || t.value === "0") continue;
      rows.push({ txHash: t.hash || t.transaction_hash, at: new Date(at).toISOString(), raw: String(t.value), to: t.to?.hash || null });
    }
  }
  return { rows, source: "Blockscout robinhoodchain.blockscout.com", truncated: false };
}

/**
 * Unmatched outflows for the given wallet accounts.
 * @param {object} input
 * @param {object[]} input.accounts     finance accounts (multisig / operator_wallet with chainId + address)
 * @param {object[]} input.movements    recorded movements (live)
 * @param {number} input.sinceMs
 * @returns {Promise<{wallets: object[], unmatched: object[]}>}
 */
export async function unmatchedOutflows({ accounts, movements, sinceMs, fetchImpl = fetch, env = process.env, readers = {}, nowMs = Date.now() }) {
  const read = {
    101: readers.solana || ((a) => solanaOutflows({ address: a.address, sinceMs, fetchImpl, env })),
    56: readers.bnb || ((a) => etherscanOutflows({ chainId: 56, address: a.address, sinceMs, fetchImpl, env })),
    4663: readers.robinhood || ((a) => blockscoutOutflows({ address: a.address, sinceMs, fetchImpl })),
  };
  const recorded = new Set(movements.filter((m) => !m.deletedAt && m.txHash).map((m) => `${m.txHash.toLowerCase()}|${m.fromAccountId || ""}`));
  const byAddress = new Map(accounts.filter((a) => a.address && !a.archivedAt).map((a) => [`${a.chainId}|${a.chainId === 101 ? a.address : a.address.toLowerCase()}`, a]));
  const wallets = [];
  const unmatched = [];
  const targets = accounts.filter((a) => !a.archivedAt && (a.kind === "multisig" || a.kind === "operator_wallet") && a.address && read[a.chainId]);
  // One wallet at a time per chain (public RPCs rate-limit bursts); chains in parallel.
  const byChain = new Map();
  for (const a of targets) byChain.set(a.chainId, [...(byChain.get(a.chainId) || []), a]);
  const readOne = async (a) => {
    const native = NATIVE[a.chainId];
    const cacheKey = `${a.chainId}|${a.address}|${sinceMs}`;
    try {
      let result = cache.get(cacheKey);
      if (!result || nowMs - result.at > CACHE_MS) {
        result = { at: nowMs, value: await read[a.chainId](a) };
        cache.set(cacheKey, result);
      }
      const { rows, source, truncated } = result.value;
      let count = 0;
      for (const r of rows) {
        const amount = atomicToDecimal(r.raw, native.decimals);
        if (!(Number(amount) >= MIN_OUTFLOW[native.asset])) continue;
        if (recorded.has(`${r.txHash.toLowerCase()}|${a.id}`)) continue;
        count += 1;
        const toKey = r.to ? `${a.chainId}|${a.chainId === 101 ? r.to : r.to.toLowerCase()}` : null;
        const toAccount = toKey ? byAddress.get(toKey) || null : null;
        unmatched.push({
          accountId: a.id, account: a.name, accountKind: a.kind, chainId: a.chainId, asset: native.asset, amount, txHash: r.txHash, at: r.at, to: r.to,
          toAccountId: toAccount?.id || null, toAccount: toAccount?.name || null, source,
          programs: r.programs || [], tokensIn: r.tokensIn || [], viaLaunchpad: Boolean(r.viaLaunchpad),
          prefill: { kind: toAccount ? "transfer_internal" : "conversion", occurredAt: r.at, fromAccountId: a.id, toAccountId: toAccount?.id || "", assetOut: native.asset, amountOut: amount, assetIn: toAccount ? native.asset : "", amountIn: toAccount ? amount : "", txHash: r.txHash },
        });
      }
      wallets.push({ accountId: a.id, account: a.name, chainId: a.chainId, address: a.address, status: "ok", source, unmatched: count, truncated: Boolean(truncated) });
    } catch (error) {
      wallets.push({ accountId: a.id, account: a.name, chainId: a.chainId, address: a.address, status: "unavailable", error: String(error?.message || error).slice(0, 200), unmatched: null });
    }
  };
  await Promise.all([...byChain.values()].map(async (list) => {
    for (const a of list) await readOne(a);
  }));
  unmatched.sort((x, y) => (x.at < y.at ? 1 : -1));
  return { wallets, unmatched, minimums: MIN_OUTFLOW, note: "Read from the chain now; never moves funds. Transfers below the minimum per coin are network fees and are left out. A transfer to an address that is not one of our accounts is prefilled as a conversion (for example to an exchange deposit address): change the kind and the to account before saving." };
}

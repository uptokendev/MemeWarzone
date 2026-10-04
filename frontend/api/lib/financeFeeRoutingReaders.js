// Read-only balance readers for the finance fee-routing view.
//
// Every read here is a JSON-RPC GET-class call: eth_getBalance, eth_call
// (balanceOf / view getters) on EVM, getBalance / getTokenAccountBalance /
// getMultipleAccounts on Solana. Nothing signs, nothing sends, no key is loaded.
// A failed read is reported as { status: "unknown", error }, never as zero.

const RPC_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function jsonRpc(fetchImpl, url, method, params) {
  const response = await withTimeout(
    fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    RPC_TIMEOUT_MS,
    method,
  );
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`${method}: ${payload.error.message || "rpc error"}`);
  return payload?.result;
}

/** Tries each RPC in order; returns { value, rpc } or throws the last error. */
async function firstRpc(urls, fn) {
  let lastError = new Error("No RPC configured.");
  for (const url of urls) {
    try {
      return { value: await fn(url), rpc: rpcLabel(url) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Host only: never echo a keyed RPC URL back to the browser. */
export function rpcLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

const ERC20_BALANCE_OF = "0x70a08231";

function hexToBigInt(hex) {
  const text = String(hex || "").trim();
  if (!/^0x[0-9a-fA-F]*$/.test(text)) throw new Error("Malformed hex quantity.");
  return text === "0x" ? 0n : BigInt(text);
}

function padAddress(address) {
  return String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function encodeBalanceOf(holder) {
  return `${ERC20_BALANCE_OF}${padAddress(holder)}`;
}

/** Decodes a single `address` return word. */
export function decodeAddressWord(hex) {
  const text = String(hex || "").replace(/^0x/, "");
  if (text.length < 64) throw new Error("Empty address return.");
  return `0x${text.slice(24, 64)}`;
}

export async function readEvmNative({ urls, address, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) => jsonRpc(fetchImpl, url, "eth_getBalance", [address, "latest"]));
  return { raw: hexToBigInt(value).toString(), rpc };
}

export async function readEvmToken({ urls, token, holder, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) =>
    jsonRpc(fetchImpl, url, "eth_call", [{ to: token, data: encodeBalanceOf(holder) }, "latest"]),
  );
  return { raw: hexToBigInt(value).toString(), rpc };
}

export async function readEvmCall({ urls, to, data, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) => jsonRpc(fetchImpl, url, "eth_call", [{ to, data }, "latest"]));
  return { hex: String(value || "0x"), rpc };
}

export async function readEvmBlock({ urls, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) => jsonRpc(fetchImpl, url, "eth_blockNumber", []));
  return { block: Number(hexToBigInt(value)), rpc };
}

export async function readSolanaLamports({ urls, address, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) =>
    jsonRpc(fetchImpl, url, "getBalance", [address, { commitment: "confirmed" }]),
  );
  const lamports = value?.value;
  if (!Number.isSafeInteger(lamports)) throw new Error("getBalance returned no value.");
  return { raw: String(lamports), slot: Number(value?.context?.slot || 0) || null, rpc };
}

/** SPL / Token-2022 balance held by `owner` for `mint`, summed over its token accounts. */
export async function readSolanaTokenByOwner({ urls, owner, mint, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) =>
    jsonRpc(fetchImpl, url, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]),
  );
  let total = 0n;
  for (const entry of value?.value || []) {
    const amount = entry?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
  }
  return { raw: total.toString(), slot: Number(value?.context?.slot || 0) || null, rpc };
}

/** Raw account data (base64) for decoding program config accounts. */
export async function readSolanaAccountData({ urls, address, fetchImpl = fetch }) {
  const { value, rpc } = await firstRpc(urls, (url) =>
    jsonRpc(fetchImpl, url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]),
  );
  const encoded = value?.value?.data?.[0];
  if (typeof encoded !== "string") throw new Error("Account does not exist.");
  return { data: Buffer.from(encoded, "base64"), slot: Number(value?.context?.slot || 0) || null, rpc };
}

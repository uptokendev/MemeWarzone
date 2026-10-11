// Shared helpers for the V4 hook fork proof. Research only.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ethers } from "ethers";

export const WAD = 10n ** 18n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const BPS = 10_000n;

export function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

export async function startAnvil(rpc, port, label, chainId, forkBlock) {
  // pin the fork a few blocks behind the tip (fresh-block "header not found" flakes on public nodes)
  if (!forkBlock) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    forkBlock = BigInt((await r.json()).result) - 2n;
  }
  try {
    await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    throw new Error(`port ${port} already serves an RPC (stale anvil?)`);
  } catch (e) {
    if (String(e.message).includes("stale anvil")) throw e;
  }
  const child = spawn("anvil", ["--fork-url", rpc, "--fork-block-number", String(forkBlock), "--port", String(port), "--silent", "--accounts", "10", "--balance", "100000000", "--no-rate-limit"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("exit", () => (exited = true));
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, Number(chainId), { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 50;
  for (let i = 0; i < 240 && !exited; i++) {
    try {
      await provider.send("eth_chainId", []);
      return { child, provider, forkBlock };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  throw new Error(`anvil did not start for ${label}: ${stderr.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 300)}`);
}

export const fmt = (wei, dp = 6) => {
  const neg = wei < 0n;
  const s = ethers.formatUnits(neg ? -wei : wei, 18);
  const [i, f = ""] = s.split(".");
  return (neg ? "-" : "") + i + (dp > 0 ? "." + (f + "0".repeat(dp)).slice(0, dp) : "");
};
export const absDiff = (a, b) => (a > b ? a - b : b - a);
/** relative difference a vs b in parts-per-million (number) */
export const ppm = (a, b) => (b === 0n ? 0 : Number((absDiff(a, b) * 10n ** 12n) / (b < 0n ? -b : b)) / 1e6);
export const ceilDiv = (a, b) => a / b + (a % b === 0n ? 0n : 1n);

// SqrtPriceMath ports (exact)
export function amount0Delta(sqrtA, sqrtB, liq, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const n1 = liq << 96n;
  const n2 = sqrtB - sqrtA;
  if (!roundUp) return (n1 * n2) / sqrtB / sqrtA;
  return ceilDiv(ceilDiv(n1 * n2, sqrtB), sqrtA);
}
export function amount1Delta(sqrtA, sqrtB, liq, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? ceilDiv(liq * (sqrtB - sqrtA), Q96) : (liq * (sqrtB - sqrtA)) / Q96;
}
/** market cap in native wei for the whole supply at pool sqrt price (coins per native) */
export const mcFromSqrt = (sqrtP, supply) => (supply * Q192) / (sqrtP * sqrtP);

export function decodeRevert(data, ifaces) {
  if (!data || data === "0x") return "revert (no data)";
  const WRAPPED = ethers.id("WrappedError(address,bytes4,bytes,bytes)").slice(0, 10);
  const EXEC = ethers.id("ExecutionFailed(uint256,bytes)").slice(0, 10);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  if (data.startsWith(WRAPPED)) {
    const [target, sel, reason] = coder.decode(["address", "bytes4", "bytes", "bytes"], "0x" + data.slice(10));
    return `WrappedError(${target.slice(0, 8)}..,${sel}) <- ${decodeRevert(reason, ifaces)}`;
  }
  if (data.startsWith(EXEC)) {
    const [, msg] = coder.decode(["uint256", "bytes"], "0x" + data.slice(10));
    return `UR.ExecutionFailed <- ${decodeRevert(msg, ifaces)}`;
  }
  for (const i of ifaces) {
    try {
      const e = i.parseError(data);
      if (e) return e.name + (e.args.length ? `(${e.args.map(String).join(",")})` : "");
    } catch {}
  }
  if (data.startsWith("0x08c379a0")) return "Error(" + coder.decode(["string"], "0x" + data.slice(10))[0] + ")";
  return "selector " + data.slice(0, 10);
}

export async function revertOf(fn, ifaces) {
  try {
    await fn();
    return null;
  } catch (e) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string") return decodeRevert(data, ifaces);
    return (e?.shortMessage || String(e?.message || e)).slice(0, 160);
  }
}

// Shared helpers for the Barkswap plugin fork proof. Research only.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { ethers } from "ethers";

export const WAD = 10n ** 18n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const FEE_DENOM = 1_000_000n;

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
export const pct = (num, den, dp = 4) => (den === 0n ? "n/a" : (Number((num * 10n ** 10n) / den) / 1e8).toFixed(dp) + "%");

// Algebra TokenDeltaMath ports (exact)
export function token0Delta(sLower, sUpper, liq, roundUp) {
  if (sLower > sUpper) [sLower, sUpper] = [sUpper, sLower];
  const d = sUpper - sLower;
  const shifted = liq << 96n;
  if (roundUp) return ceilDiv(ceilDiv(d * shifted, sUpper), sLower);
  return (d * shifted) / sUpper / sLower;
}
export function token1Delta(sLower, sUpper, liq, roundUp) {
  if (sLower > sUpper) [sLower, sUpper] = [sUpper, sLower];
  return roundUp ? ceilDiv((sUpper - sLower) * liq, Q96) : ((sUpper - sLower) * liq) / Q96;
}
/** largest liquidity whose rounded-up token0 amount fits in `amount0` over [sLower, sUpper] */
export function liquidityForAmount0(sLower, sUpper, amount0) {
  let l = (amount0 * sLower * sUpper) / Q96 / (sUpper - sLower);
  while (token0Delta(sLower, sUpper, l, true) > amount0) l -= 1n;
  return l;
}
/** market cap in native wei for `supply` coins (token0) at pool sqrt price (token1 per token0) */
export const mcFromSqrt = (sqrtP, supply) => (supply * sqrtP * sqrtP) / Q192;

/** Starts `hardhat node` (node + hardhat's bootstrap.js, no shell, so the pid is the node itself) on the DogeOS
 *  testnet fork config, mines one local block (calls at the fork block itself would need a hardfork history the
 *  node does not apply), and returns { child, provider }. */
export async function startHardhatFork(repoRoot, config, port, chainId) {
  const url = `http://127.0.0.1:${port}`;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    throw new Error(`port ${port} already serves an RPC (stale node?)`);
  } catch (e) {
    if (String(e.message).includes("stale node")) throw e;
  }
  const cli = path.join(repoRoot, "node_modules", "hardhat", "internal", "cli", "bootstrap.js");
  const child = spawn(process.execPath, [cli, "node", "--config", config, "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("exit", () => (exited = true));
  const provider = new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 50;
  for (let i = 0; i < 360 && !exited; i++) {
    try {
      await provider.send("eth_chainId", []);
      await provider.send("evm_mine", []);
      return { child, provider };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try { child.kill(); } catch {}
  throw new Error(`hardhat node did not start: ${stderr.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 400)}`);
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill("SIGKILL"); } catch {}
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else child.kill("SIGTERM");
}

export function decodeRevert(data, ifaces) {
  if (!data || data === "0x") return "revert (no data)";
  const coder = ethers.AbiCoder.defaultAbiCoder();
  for (const i of ifaces) {
    try {
      const e = i.parseError(data);
      if (e) return e.name + (e.args.length ? `(${e.args.map(String).join(",")})` : "");
    } catch {}
  }
  if (data.startsWith("0x08c379a0")) return "Error(" + coder.decode(["string"], "0x" + data.slice(10))[0] + ")";
  if (data.startsWith("0x4e487b71")) return "Panic(" + coder.decode(["uint256"], "0x" + data.slice(10))[0] + ")";
  return "selector " + data.slice(0, 10);
}

/** null if fn() succeeds, else the decoded revert */
export async function revertOf(fn, ifaces) {
  try {
    await fn();
    return null;
  } catch (e) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string") return decodeRevert(data, ifaces);
    if (data && typeof data.data === "string") return decodeRevert(data.data, ifaces);
    return (e?.shortMessage || String(e?.message || e)).slice(0, 200);
  }
}

export const repoRootFrom = (here) => path.resolve(here, "../../..");

import { ethers } from "ethers";

import { IMPORT_SWAP_PROBE_ABI, IMPORT_SWAP_PROBE_RUNTIME } from "./importSwapProbeArtifact.js";

/**
 * A buy and an immediate sell of an imported token on its own pool, simulated in one eth_call: the
 * probe's runtime code sits at a throwaway address through a state override, a throwaway origin is
 * given gas money, nothing is signed or sent. Unlike a quote, this runs the token's transfer code,
 * so a token that blocks sells or taxes transfers shows it.
 */
export const PROBE_KIND = Object.freeze({ V2: 2, V3: 3 });
export const PROBE_ADDRESS = ethers.getAddress(`0x${ethers.id("mwz-import-swap-probe").slice(26)}`);
export const PROBE_ORIGIN = ethers.getAddress(`0x${ethers.id("mwz-import-swap-probe-origin").slice(26)}`);
const probeInterface = new ethers.Interface(IMPORT_SWAP_PROBE_ABI);

/** Error(string) reverts read as their message; anything else keeps a short hex prefix. */
export function revertReason(data) {
  const hex = String(data || "0x");
  if (hex.startsWith("0x08c379a0")) {
    try {
      return ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${hex.slice(10)}`)[0].slice(0, 160);
    } catch {
      // fall through
    }
  }
  return hex === "0x" ? "reverted without a reason" : hex.slice(0, 74);
}

function bps(part, whole) {
  if (whole <= 0n) return null;
  return Number((part * 10000n) / whole);
}

/** Pure decode, exported for tests: the probe's Result struct into the scan's evidence. */
export function decodeRoundTrip(raw, amountIn) {
  const [r] = probeInterface.decodeFunctionResult("probe", raw);
  const tokenOut = BigInt(r.tokenOut);
  const tokenReceived = BigInt(r.tokenReceived);
  const tokenIntoPool = BigInt(r.tokenIntoPool);
  const nativeBack = BigInt(r.nativeBack);
  return {
    ran: true,
    buyOk: Boolean(r.buyOk),
    sellOk: Boolean(r.sellOk),
    buyTaxBps: r.buyOk ? bps(tokenOut > tokenReceived ? tokenOut - tokenReceived : 0n, tokenOut) : null,
    sellTaxBps: r.sellOk ? bps(tokenReceived > tokenIntoPool ? tokenReceived - tokenIntoPool : 0n, tokenReceived) : null,
    // Pool fees and price impact included: context for a reviewer, not a finding on its own.
    roundTripLossBps: r.sellOk ? bps(amountIn > nativeBack ? amountIn - nativeBack : 0n, amountIn) : null,
    sellError: r.sellOk ? null : revertReason(r.sellError),
  };
}

export async function simulateRoundTrip(provider, { kind, pool, router, weth, token, amountIn, v2FeeBps = 0, v3Fee = 0 }) {
  const data = probeInterface.encodeFunctionData("probe", [kind, pool, router, weth, token, v2FeeBps, v3Fee]);
  const call = {
    from: PROBE_ORIGIN,
    to: PROBE_ADDRESS,
    value: ethers.toQuantity(amountIn),
    data,
    gas: ethers.toQuantity(8_000_000),
  };
  const overrides = {
    [PROBE_ADDRESS]: { code: IMPORT_SWAP_PROBE_RUNTIME },
    [PROBE_ORIGIN]: { balance: ethers.toQuantity(ethers.parseEther("10")) },
  };
  let raw;
  try {
    raw = await provider.send("eth_call", [call, "latest", overrides]);
  } catch (error) {
    // RPC without state overrides, or the probe itself reverted (e.g. the wrapped native refused
    // the deposit): no evidence either way, the quote result stands.
    return { ran: false, error: String(error?.shortMessage || error?.message || error).slice(0, 200) };
  }
  try {
    return decodeRoundTrip(raw, BigInt(amountIn));
  } catch (error) {
    return { ran: false, error: `decode: ${String(error?.message || error).slice(0, 180)}` };
  }
}

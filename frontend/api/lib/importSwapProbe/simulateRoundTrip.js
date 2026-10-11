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
export function decodeRoundTrip(raw, amountIn, fn = "probe") {
  const [r] = probeInterface.decodeFunctionResult(fn, raw);
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

const coder = ethers.AbiCoder.defaultAbiCoder();
const BALANCE_OF = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
// OpenZeppelin v5 ERC20Storage (namespaced); Solady's balance slot seed.
const OZ5_ERC20_STORAGE = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";
const SOLADY_BALANCE_SEED = 0x87a211a2n;

/** Every balance-slot layout we try, as holder -> storage slot. */
function balanceSlotCandidates() {
  const mapping = (i) => ({ label: `mapping@${i}`, slotFor: (holder) => ethers.keccak256(coder.encode(["address", "uint256"], [holder, i])) });
  // Common layouts first (plain OZ / WETH9 / OZ v5 / Solady / OZ upgradeable v4 at 51), then the rest of 0..110.
  const first = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 51, 52, 101];
  const out = first.map(mapping);
  out.push({ label: "oz5-namespaced", slotFor: (holder) => ethers.keccak256(coder.encode(["address", "bytes32"], [holder, OZ5_ERC20_STORAGE])) });
  out.push({ label: "solady", slotFor: (holder) => ethers.keccak256(ethers.solidityPacked(["address", "uint96"], [holder, SOLADY_BALANCE_SEED])) });
  for (let i = 11; i <= 110; i += 1) if (!first.includes(i)) out.push(mapping(i));
  return out;
}

const balanceSlotCache = new Map();

/**
 * Where `token` keeps an address's balance, found by setting a candidate slot in an eth_call override and reading
 * balanceOf back. Cached per token. Returns { label, slotFor } or null (unknown layout: no simulation).
 */
export async function findBalanceSlot(provider, token) {
  const key = String(token).toLowerCase();
  if (balanceSlotCache.has(key)) return balanceSlotCache.get(key);
  const marker = 0x5eed5eedn;
  const data = BALANCE_OF.encodeFunctionData("balanceOf", [PROBE_ADDRESS]);
  let found = null;
  for (const candidate of balanceSlotCandidates()) {
    const slot = candidate.slotFor(PROBE_ADDRESS);
    try {
      const raw = await provider.send("eth_call", [{ to: token, data }, "latest", { [token]: { stateDiff: { [slot]: ethers.toBeHex(marker, 32) } } }]);
      if (BigInt(raw) === marker) {
        found = candidate;
        break;
      }
    } catch {
      // try the next layout
    }
  }
  balanceSlotCache.set(key, found);
  return found;
}

/**
 * Uniswap V4 round trip (probeV4): buy with `quoteIn` of the pool's quote currency, sell everything back, both
 * through the UniversalRouter. A native quote is sent as value; an ERC20 quote is preset on the probe through its
 * balance slot, so a coin quoted in a stock token or PONS is tested with that token, as a wallet would trade it.
 */
export async function simulateRoundTripV4(provider, { router, permit2, poolManager, key, coinIs0, quoteIn }) {
  const quote = coinIs0 ? key.currency1 : key.currency0;
  const native = quote === ethers.ZeroAddress;
  const overrides = {
    [PROBE_ADDRESS]: { code: IMPORT_SWAP_PROBE_RUNTIME },
    [PROBE_ORIGIN]: { balance: ethers.toQuantity(ethers.parseEther("10")) },
  };
  if (!native) {
    const layout = await findBalanceSlot(provider, quote);
    if (!layout) return { ran: false, error: `quote token ${quote} balance layout unknown` };
    overrides[quote] = { stateDiff: { [layout.slotFor(PROBE_ADDRESS)]: ethers.toBeHex(quoteIn, 32) } };
  }
  const args = [router, permit2, poolManager, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], coinIs0, quoteIn];
  const call = {
    from: PROBE_ORIGIN,
    to: PROBE_ADDRESS,
    value: ethers.toQuantity(native ? quoteIn : 0n),
    data: probeInterface.encodeFunctionData("probeV4", [args]),
    gas: ethers.toQuantity(8_000_000),
  };
  let raw;
  try {
    raw = await provider.send("eth_call", [call, "latest", overrides]);
  } catch (error) {
    return { ran: false, error: String(error?.shortMessage || error?.message || error).slice(0, 200) };
  }
  try {
    return { ...decodeRoundTrip(raw, BigInt(quoteIn), "probeV4"), quoteToken: native ? "native" : quote };
  } catch (error) {
    return { ran: false, error: `decode: ${String(error?.message || error).slice(0, 180)}` };
  }
}

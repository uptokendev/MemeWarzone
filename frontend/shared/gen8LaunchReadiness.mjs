/**
 * Launch readiness once a chain has a generation 8 launcher.
 *
 * Gen-8 replaces gen-6/7 on 56 and 4663. There is no native gen-6/7 launch on those chains.
 * When the launcher env is set (even to a bad value), the launch gate looks only at the gen-8
 * contracts the launch uses and names the missing env. It does not look at the gen-6/7 factory,
 * treasury, registries, oracle, locker, vote treasury, or Topaz. With no launcher env, the caller
 * keeps the old 15-contract check and the old sentence.
 *
 * scope "launch" is the app button: launcher, hook, lens, PoolManager, Universal Router plus layout,
 * V4 quoter. The first buy is msg.value on launcher.launch; it does not call the quoter. The quoter
 * and router are still required here because the founder listed them with the launch set.
 * scope "create" is the API signer: launcher, hook, PoolManager. Lens, router, and quoter are trades.
 *
 * PoolManager defaults match CANONICAL_V4_POOL_MANAGER in frontend/api/lib/evmGen8Config.js
 * (56 and 4663 only). An explicit PoolManager env that does not parse does not fall back to that default.
 * Router and quoter defaults live in evmGen8Swap.mjs (56 and 4663 only). Testnets 97 and 46630 have none.
 *
 * Barkswap venue (DogeOS 6281971, GEN8_CHAIN_VENUE): there is no hook, PoolManager, Universal Router or V4 quoter.
 * scope "launch" is launcher, plugin, lens; scope "create" is launcher, plugin. Barkswap's SwapRouter, QuoterV2 and
 * WDOGE have defaults (src/lib/barkswapSwap.mjs BARKSWAP_PERIPHERY), so they are not listed. A Uniswap V4 setting on
 * that chain disables gen-8 there (the app's barkAppConfig: hook, PoolManager, Universal Router, V4 quoter; the API's
 * evmGen8Config.js: hook, PoolManager), so it makes the chain not ready and is named in the message.
 */
import { getAddress } from "ethers";
import { GEN8_VENUE_BARKSWAP, gen8VenueFor } from "./evmGen8.mjs";
import { gen8QuoterFor, gen8RouterFor } from "./evmGen8Swap.mjs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;

const CANONICAL_V4_POOL_MANAGER = Object.freeze({
  56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
});

export function gen8ChainLabel(chainId) {
  const id = Number(chainId);
  if (id === 56) return "BNB";
  if (id === 97) return "BNB Testnet";
  if (id === 4663) return "Robinhood";
  if (id === 46630) return "Robinhood Testnet";
  if (id === 6281971) return "DogeOS Testnet";
  return `Chain ${id}`;
}

/** The step-6 sentence Create.tsx shows when the chain has no gen-8 launcher. */
export function legacyLaunchIncompleteMessage(chainLabel) {
  return `${chainLabel} launch contracts are incomplete — choose Draft or fix env wiring.`;
}

function preferredName(base, chainId, vite) {
  const bare = `${base}_${chainId}`;
  return vite ? `VITE_${bare}` : bare;
}

function readSlot(env, base, chainId, vite) {
  const bare = `${base}_${chainId}`;
  const viteName = `VITE_${bare}`;
  const primary = vite ? viteName : bare;
  const secondary = vite ? bare : viteName;
  const primaryText = String(env?.[primary] ?? "").trim();
  const secondaryText = String(env?.[secondary] ?? "").trim();
  if (primaryText) return { present: true, text: primaryText, envName: primary };
  if (secondaryText) return { present: true, text: secondaryText, envName: secondary };
  return { present: false, text: "", envName: primary };
}

function readAddress(env, base, chainId, vite) {
  const slot = readSlot(env, base, chainId, vite);
  if (!slot.present) return { present: false, valid: false, address: null, envName: slot.envName };
  const addressPart = slot.text.split("@")[0].trim();
  const valid = ADDR.test(addressPart) && !ZERO.test(addressPart);
  return { present: true, valid, address: valid ? addressPart : null, envName: slot.envName };
}

function missingAddress(env, base, chainId, vite, label) {
  const part = readAddress(env, base, chainId, vite);
  if (part.valid) return [];
  return [{ env: part.envName, label }];
}

function poolManagerGap(chainId, env, vite) {
  const id = Number(chainId);
  const part = readAddress(env, "EVM_GEN8_POOL_MANAGER", id, vite);
  if (part.present) {
    if (part.valid) return [];
    return [{ env: part.envName, label: "PoolManager" }];
  }
  if (CANONICAL_V4_POOL_MANAGER[id]) return [];
  return [{ env: preferredName("EVM_GEN8_POOL_MANAGER", id, vite), label: "PoolManager" }];
}

function routerGap(chainId, env, vite) {
  const id = Number(chainId);
  if (gen8RouterFor(id, env)) return [];
  const part = readAddress(env, "EVM_GEN8_UNIVERSAL_ROUTER", id, vite);
  if (!part.present || !part.valid) return [{ env: part.envName, label: "Universal Router" }];
  const layout = readSlot(env, "EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT", id, vite);
  return [{ env: layout.envName, label: "Universal Router layout" }];
}

function quoterGap(chainId, env, vite) {
  const id = Number(chainId);
  if (gen8QuoterFor(id, env)) return [];
  const part = readAddress(env, "EVM_GEN8_V4_QUOTER", id, vite);
  return [{ env: part.envName, label: "V4 quoter" }];
}

/**
 * @returns {{ active: boolean, ready: boolean, missing: {env: string, label: string}[], message: string, launcher: string | null }}
 * active is true when the launcher env is non-empty, including a value that is not an address.
 */
export function gen8LaunchReadiness(chainId, env = {}, { vite = true, scope = "launch" } = {}) {
  const id = Number(chainId);
  if (gen8VenueFor(id) === GEN8_VENUE_BARKSWAP) return barkLaunchReadiness(id, env, { vite, scope });
  const launcher = readAddress(env, "EVM_GEN8_LAUNCHER", id, vite);
  const missing = [];
  if (!launcher.valid) missing.push({ env: launcher.envName, label: "launcher" });
  missing.push(...missingAddress(env, "EVM_GEN8_HOOK", id, vite, "hook"));
  if (scope !== "create") missing.push(...missingAddress(env, "EVM_GEN8_LENS", id, vite, "lens"));
  missing.push(...poolManagerGap(id, env, vite));
  if (scope !== "create") {
    missing.push(...routerGap(id, env, vite));
    missing.push(...quoterGap(id, env, vite));
  }
  const ready = missing.length === 0;
  const names = missing.map((item) => item.env).join(", ");
  return {
    active: launcher.present,
    ready,
    missing,
    message: ready ? "" : `${gen8ChainLabel(id)} launch contracts are incomplete. Missing ${names}.`,
    launcher: launcher.valid ? getAddress(launcher.address) : null,
  };
}

/** The Uniswap V4 settings set on a Barkswap chain (any of them disables gen-8 there; see the header). */
function barkV4Settings(env, id, vite, scope) {
  const bases = scope === "create" ? ["EVM_GEN8_HOOK", "EVM_GEN8_POOL_MANAGER"] : ["EVM_GEN8_HOOK", "EVM_GEN8_POOL_MANAGER", "EVM_GEN8_UNIVERSAL_ROUTER", "EVM_GEN8_V4_QUOTER"];
  return bases.map((base) => readSlot(env, base, id, vite)).filter((slot) => slot.present).map((slot) => ({ env: slot.envName, label: "Uniswap V4 setting" }));
}

function barkLaunchReadiness(id, env, { vite, scope }) {
  const launcher = readAddress(env, "EVM_GEN8_LAUNCHER", id, vite);
  const missing = [];
  if (!launcher.valid) missing.push({ env: launcher.envName, label: "launcher" });
  missing.push(...missingAddress(env, "EVM_GEN8_PLUGIN", id, vite, "plugin"));
  if (scope !== "create") missing.push(...missingAddress(env, "EVM_GEN8_LENS", id, vite, "lens"));
  const v4 = barkV4Settings(env, id, vite, scope);
  const ready = missing.length === 0 && v4.length === 0;
  const parts = [];
  if (missing.length) parts.push(`Missing ${missing.map((item) => item.env).join(", ")}.`);
  if (v4.length) parts.push(`Remove the Uniswap V4 settings ${v4.map((item) => item.env).join(", ")} (this chain trades on Barkswap).`);
  return {
    active: launcher.present,
    ready,
    missing: [...missing, ...v4],
    message: ready ? "" : `${gen8ChainLabel(id)} launch contracts are incomplete. ${parts.join(" ")}`,
    launcher: launcher.valid ? getAddress(launcher.address) : null,
  };
}

/** Hook, Universal Router (and layout), and V4 quoter. Lens is not a trade-panel hard block. Barkswap: the plugin. */
export function gen8TradeGap(chainId, env = {}, { vite = true } = {}) {
  const id = Number(chainId);
  if (gen8VenueFor(id) === GEN8_VENUE_BARKSWAP) {
    const missing = [...missingAddress(env, "EVM_GEN8_PLUGIN", id, vite, "plugin"), ...barkV4Settings(env, id, vite, "launch")];
    return {
      ready: missing.length === 0,
      missing,
      message: missing.length ? `Trading for this coin is not set up on this chain yet. Missing or wrong: ${missing.map((item) => item.env).join(", ")}.` : "",
    };
  }
  const missing = [
    ...missingAddress(env, "EVM_GEN8_HOOK", id, vite, "hook"),
    ...routerGap(id, env, vite),
    ...quoterGap(id, env, vite),
  ];
  const names = missing.map((item) => item.env).join(", ");
  return {
    ready: missing.length === 0,
    missing,
    message: missing.length ? `Trading for this coin is not set up on this chain yet. Missing ${names}.` : "",
  };
}

/**
 * App launch button. When a launcher env is set, legacyReady and legacyFactory are ignored.
 * Otherwise configured is the old check: every gen-6/7 contract ready, and a launch factory address.
 */
export function evmLaunchConfigured({ chainId, env = {}, legacyReady = false, legacyFactory = "", chainLabel = "" } = {}) {
  const gen8 = gen8LaunchReadiness(chainId, env, { vite: true, scope: "launch" });
  if (gen8.active) {
    return { configured: gen8.ready, legacy: false, message: gen8.ready ? "" : gen8.message, gen8 };
  }
  const configured = Boolean(legacyReady && legacyFactory);
  const label = chainLabel || gen8ChainLabel(chainId);
  return {
    configured,
    legacy: true,
    message: configured ? "" : legacyLaunchIncompleteMessage(label),
    gen8,
  };
}

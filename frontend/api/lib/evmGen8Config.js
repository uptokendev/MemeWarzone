/**
 * EVM generation 8 configuration for the API, per chain. Same env names and "0xaddr@startBlock" convention as the
 * indexer (realtime-indexer/src/evm/evmGen8Config.ts), plus the API-only lens. Everything gen-8 in the API is inert
 * until both EVM_GEN8_LAUNCHER_<chainId> and EVM_GEN8_HOOK_<chainId> are set on the API service: no extra query, no
 * RPC call, no changed SQL for any other generation.
 *
 *   EVM_GEN8_LAUNCHER_<id>       MwzV4Launcher (create authorization target)
 *   EVM_GEN8_HOOK_<id>           MwzLaunchHook (pool ids, claims, ledgers)
 *   EVM_GEN8_LENS_<id>           MwzLaunchLens (progress, current fee, quotes); optional, campaign state falls back to the hook
 *   EVM_GEN8_POOL_MANAGER_<id>   Uniswap V4 PoolManager (default: the canonical one on 56 / 4663)
 *   EVM_GEN8_SPLITTER_<id>       MwzFeeSplitter (finance)
 *   EVM_GEN8_CHOICE_VAULT_<id>   MwzCreatorChoiceVault (fee choice balances)
 *   EVM_GEN8_RESERVE_LOCK_<id>   MwzReserveLock (creator reserve)
 *   EVM_GEN8_ESCROW_<id>         MwzCreatorEscrow (creator buy escrow)
 * Signer for create authorizations: EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY, else the route authority key (route-auth.js);
 * the launcher's createSigner() must equal its address.
 */
import { ethers } from "ethers";

export const GEN8_API_CHAIN_IDS = Object.freeze([56, 97, 4663, 46630, 31337]);

/** Canonical Uniswap V4 PoolManager per mainnet (design 2.1). Testnets and local chains: env only. */
export const CANONICAL_V4_POOL_MANAGER = Object.freeze({
  56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
});

function parseEntry(raw) {
  const text = String(raw || "").trim();
  if (!text) return { value: null, invalid: false };
  const [addressPart, blockPart] = text.split("@").map((s) => String(s || "").trim());
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart) || /^0x0{40}$/i.test(addressPart) || (blockPart && !/^\d+$/.test(blockPart))) {
    return { value: null, invalid: true };
  }
  return { value: { address: ethers.getAddress(addressPart), startBlock: blockPart ? Number(blockPart) : 0 }, invalid: false };
}

/**
 * The chain's gen-8 config, or null when gen-8 is not configured there (or the env is malformed, which is reported
 * in `reason` and also disables gen-8: a half-set config never signs or reads).
 */
export function evmGen8ApiConfig(chainId, env = process.env) {
  const id = Number(chainId);
  if (!GEN8_API_CHAIN_IDS.includes(id)) return { config: null, reason: "unsupported_chain" };
  const name = (base) => `${base}_${id}`;
  const read = (base) => parseEntry(env[name(base)]);
  const launcher = read("EVM_GEN8_LAUNCHER");
  const hook = read("EVM_GEN8_HOOK");
  if (!launcher.value && !hook.value && !launcher.invalid && !hook.invalid) return { config: null, reason: "unset" };
  const parts = {
    lens: read("EVM_GEN8_LENS"),
    poolManager: read("EVM_GEN8_POOL_MANAGER"),
    splitter: read("EVM_GEN8_SPLITTER"),
    choiceVault: read("EVM_GEN8_CHOICE_VAULT"),
    reserveLock: read("EVM_GEN8_RESERVE_LOCK"),
    escrow: read("EVM_GEN8_ESCROW"),
  };
  const envBase = { lens: "EVM_GEN8_LENS", poolManager: "EVM_GEN8_POOL_MANAGER", splitter: "EVM_GEN8_SPLITTER", choiceVault: "EVM_GEN8_CHOICE_VAULT", reserveLock: "EVM_GEN8_RESERVE_LOCK", escrow: "EVM_GEN8_ESCROW" };
  const invalid = [["EVM_GEN8_LAUNCHER", launcher], ["EVM_GEN8_HOOK", hook], ...Object.entries(parts).map(([k, v]) => [envBase[k], v])]
    .filter(([, v]) => v.invalid)
    .map(([k]) => name(k));
  if (invalid.length) return { config: null, reason: `invalid gen-8 env: ${invalid.join(", ")}` };
  if (!launcher.value || !hook.value) return { config: null, reason: "launcher and hook must both be set" };
  const poolManager = parts.poolManager.value?.address || (CANONICAL_V4_POOL_MANAGER[id] ? ethers.getAddress(CANONICAL_V4_POOL_MANAGER[id]) : null);
  if (!poolManager) return { config: null, reason: `no PoolManager for chain ${id} (set ${name("EVM_GEN8_POOL_MANAGER")})` };
  return {
    config: {
      chainId: id,
      launcher: launcher.value.address,
      hook: hook.value.address,
      lens: parts.lens.value?.address || null,
      poolManager,
      splitter: parts.splitter.value?.address || null,
      choiceVault: parts.choiceVault.value?.address || null,
      reserveLock: parts.reserveLock.value?.address || null,
      escrow: parts.escrow.value?.address || null,
    },
    reason: null,
  };
}

/** The chain's gen-8 config or null (inert). */
export function gen8ConfigFor(chainId, env = process.env) {
  return evmGen8ApiConfig(chainId, env).config;
}

/** True when `address` is the chain's gen-8 launcher. */
export function isGen8Launcher(chainId, address, env = process.env) {
  const cfg = gen8ConfigFor(chainId, env);
  return Boolean(cfg && address && String(address).toLowerCase() === cfg.launcher.toLowerCase());
}

/** Chains with a complete gen-8 config. Empty when no gen-8 env is set. */
export function configuredGen8ChainIds(env = process.env) {
  return GEN8_API_CHAIN_IDS.filter((id) => gen8ConfigFor(id, env));
}

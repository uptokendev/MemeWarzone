/** Pure configuration of the EVM graduation keeper (env names: see evmGraduationKeeperWorker.ts). */
import { ethers } from "ethers";
import { assertKeeperKeyAllowed, type KeeperConfig } from "./evmGraduationKeeper.js";

export function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const DEFAULT_MAX_GAS: Record<number, bigint> = { 56: 15_000_000n, 97: 15_000_000n, 4663: 30_000_000n, 46630: 30_000_000n };

export function keeperConfig(chainId: number, env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const gasRaw = String(env[`EVM_GRADUATION_KEEPER_MAX_GAS_${chainId}`] || env.EVM_GRADUATION_KEEPER_MAX_GAS || "").trim();
  const maxGas = /^\d+$/.test(gasRaw) ? BigInt(gasRaw) : DEFAULT_MAX_GAS[chainId] ?? 15_000_000n;
  const flushRaw = String(env.EVM_GRADUATION_KEEPER_MIN_FLUSH_WEI || "1").trim();
  const minFlushWei = /^\d+$/.test(flushRaw) ? BigInt(flushRaw) : 1n;
  const halvings = Math.max(0, Math.min(32, Number(env.EVM_GRADUATION_KEEPER_REPAIR_HALVINGS || 8) || 0));
  return { maxGas, minFlushWei, maxRepairHalvings: halvings };
}

export function enabledKeeperChains(env: NodeJS.ProcessEnv = process.env): number[] {
  return [56, 4663, 97, 46630].filter((id) => truthy(env[`EVM_GRADUATION_KEEPER_ENABLED_${id}`]));
}

export function keeperWallet(chainId: number, env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env[`EVM_GRADUATION_KEEPER_PRIVATE_KEY_${chainId}`] || env.EVM_GRADUATION_KEEPER_PRIVATE_KEY || "").trim();
  if (!raw) return null;
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  assertKeeperKeyAllowed(wallet.address, env);
  return wallet;
}


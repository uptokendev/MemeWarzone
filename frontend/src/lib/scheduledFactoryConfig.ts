import { ethers } from "ethers";
import { isDogeosChainId } from "@/lib/chainConfig";

export const OBSOLETE_BSC_TESTNET_SCHEDULED_FACTORY = "0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6";

function env(name: string) {
  return String((import.meta.env as Record<string, unknown>)[name] || "").trim();
}

function validAddress(value?: string | null) {
  const raw = String(value || "").trim();
  return ethers.isAddress(raw) ? ethers.getAddress(raw) : "";
}

function isObsoleteFactory(chainId: number, address: string) {
  return Number(chainId) === 97 && address.toLowerCase() === OBSOLETE_BSC_TESTNET_SCHEDULED_FACTORY.toLowerCase();
}

/**
 * The unsuffixed names are the BNB-era scheduled factory. BNB (56/97) and Robinhood read them as before; DogeOS
 * (6281971) has no gen-7 scheduled factory and never borrows them (gen-8 Barkswap only).
 */
function unsuffixedScheduledFactory(chainId: number) {
  if (isDogeosChainId(Number(chainId))) return "";
  return env("VITE_SCHEDULED_FACTORY_ADDRESS") || env("VITE_SCHEDULED_LAUNCH_FACTORY_ADDRESS");
}

export function getScheduledFactoryAddress(chainId: number, genericFactoryAddress?: string | null) {
  const explicit = validAddress(
    env(`VITE_SCHEDULED_FACTORY_ADDRESS_${Number(chainId)}`) ||
      env(`VITE_SCHEDULED_LAUNCH_FACTORY_ADDRESS_${Number(chainId)}`) ||
      unsuffixedScheduledFactory(chainId),
  );
  const candidate = explicit || validAddress(genericFactoryAddress);
  if (!candidate || isObsoleteFactory(chainId, candidate)) return "";
  return candidate;
}

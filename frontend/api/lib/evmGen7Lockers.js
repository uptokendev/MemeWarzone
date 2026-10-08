// Generation-7 LP lockers (one per gen-7 factory, deployFactoryWithLocker). Their addresses exist only
// after the gen-7 deploy, so they come from EVM_GEN7_LOCKER_<chainId> (comma-separated) and are
// appended after the pinned gen-6 lockers by evmLpHarvestCrank.js and financeFeeRoutingEvm.js.
// Unset: no extra lockers, so both lists stay exactly as before.
import { getAddress } from "ethers";

/** { lockers: checksummed, deduplicated addresses; invalid: entries that are not an address }. */
export function evmGen7Lockers(chainId, env = process.env) {
  const raw = String(env?.[`EVM_GEN7_LOCKER_${Number(chainId)}`] || "");
  const lockers = [];
  const invalid = [];
  const seen = new Set();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(entry)) {
      invalid.push(entry);
      continue;
    }
    let address;
    try {
      address = getAddress(entry); // a mixed-case entry must carry a valid checksum
    } catch {
      invalid.push(entry);
      continue;
    }
    if (/^0x0{40}$/i.test(address)) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    lockers.push(address);
  }
  return { lockers, invalid };
}

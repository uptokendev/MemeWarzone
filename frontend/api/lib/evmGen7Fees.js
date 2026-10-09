// Generation-7 fees stack per EVM chain (founder decision 2026-10-08): gen-7 has its own TreasuryRouterV4,
// CreatorRewardsVaultV2 (pinned to the gen-7 factory), holder RewardDistributor (batchOperator = the gen-7
// vault) and CommunityRewardsVault (serves the gen-7 router). The weekly, monthly, recruiter and protocol
// vaults are the gen-6 ones. The addresses exist only after the gen-7 deploy, so they come from env, one
// variable per contract and chain (the same names the indexer reads, realtime-indexer/src/evm/evmGen7Fees.ts):
//
//   EVM_GEN7_ROUTER_<chainId>              "0xaddr@startBlock"  TreasuryRouterV4 (gen-7)
//   EVM_GEN7_CREATOR_VAULT_<chainId>       "0xaddr@startBlock"  CreatorRewardsVaultV2 (gen-7)
//   EVM_GEN7_HOLDER_DISTRIBUTOR_<chainId>  "0xaddr@startBlock"  holder RewardDistributor (gen-7)
//   EVM_GEN7_COMMUNITY_VAULT_<chainId>     "0xaddr"             CommunityRewardsVault (gen-7); falls back to the
//                                                               airdrop runner's COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<chainId>
//
// The start block is optional (0 when absent). Unset: no gen-7 stack, and every reader that appends it stays
// exactly as before. Which stack a coin uses is never decided from these lists: it is read per campaign on
// chain (campaign.feeRecipient() -> router.creatorRewardsVault(), or factory.campaignFeeChoice(campaign).vault).
// The lists only tell scanners and the finance view which contracts exist.
import { getAddress } from "ethers";

export const EVM_GEN7_FEES_ENV = Object.freeze({
  router: "EVM_GEN7_ROUTER",
  creatorVault: "EVM_GEN7_CREATOR_VAULT",
  holderDistributor: "EVM_GEN7_HOLDER_DISTRIBUTOR",
  communityVault: "EVM_GEN7_COMMUNITY_VAULT",
});

/** The holder batch program of gen-7 (gen-6 keeps "airdrop_holders"). The batch id is derived from it. */
export const EVM_GEN7_HOLDER_PROGRAM = "airdrop_holders_gen7";

function parseEntry(raw) {
  const text = String(raw || "").trim();
  if (!text) return { entry: null, invalid: null };
  const [addressPart, blockPart] = text.split("@").map((s) => String(s || "").trim());
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart) || /^0x0{40}$/i.test(addressPart)) return { entry: null, invalid: text };
  let address;
  try {
    address = getAddress(addressPart); // a mixed-case entry must carry a valid checksum
  } catch {
    return { entry: null, invalid: text };
  }
  if (blockPart != null && blockPart !== "" && !/^\d+$/.test(blockPart)) return { entry: null, invalid: text };
  return { entry: { address, startBlock: blockPart ? Number(blockPart) : 0 }, invalid: null };
}

/**
 * { configured, router, creatorVault, holderDistributor, communityVault, invalid } for one chain. Each contract
 * is { address (checksummed), startBlock } or null; `invalid` lists "NAME_<id>: value" for entries that are not
 * an address (ignored). `configured` is true when at least one contract is set.
 */
export function evmGen7FeesStack(chainId, env = process.env) {
  const id = Number(chainId);
  const out = { chainId: id, configured: false, router: null, creatorVault: null, holderDistributor: null, communityVault: null, invalid: [] };
  for (const [key, base] of Object.entries(EVM_GEN7_FEES_ENV)) {
    let name = `${base}_${id}`;
    // The weekly airdrop names the same gen-7 community vault COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<id>
    // (frontend/scripts/weekly-airdrop/pots.mjs); either name works, EVM_GEN7_COMMUNITY_VAULT_<id> first.
    if (key === "communityVault" && !String(env?.[name] ?? "").trim() && String(env?.[`COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${id}`] ?? "").trim()) {
      name = `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${id}`;
    }
    const { entry, invalid } = parseEntry(env?.[name]);
    if (invalid) out.invalid.push(`${name}: ${invalid}`);
    if (entry) {
      out[key] = entry;
      out.configured = true;
    }
  }
  return out;
}

/** The gen-7 router as a { address (lowercase), startBlock } scan entry, or null. */
export function evmGen7RouterScanEntry(chainId, env = process.env) {
  const r = evmGen7FeesStack(chainId, env).router;
  return r ? { address: r.address.toLowerCase(), startBlock: r.startBlock } : null;
}

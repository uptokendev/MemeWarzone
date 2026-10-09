/**
 * Generation-7 fees stack per EVM chain (founder decision 2026-10-08). Gen-7 cannot use the gen-6 router and
 * creator vault: CreatorRewardsVaultV2.setFactoryOnce pins ONE factory, TreasuryRouterV4.setCreatorRewardsVault
 * is set-once and CommunityRewardsVault serves ONE router. So each chain gets a gen-7 TreasuryRouterV4,
 * CreatorRewardsVaultV2 (pinned to the gen-7 factory), holder RewardDistributor (batchOperator = gen-7 vault) and
 * CommunityRewardsVault. Weekly, monthly, recruiter and protocol vaults are reused.
 *
 * Env (the same names the API reads, frontend/api/lib/evmGen7Fees.js), one contract per variable:
 *   EVM_GEN7_ROUTER_<chainId>              "0xaddr@startBlock"  TreasuryRouterV4 (gen-7): RouteExecuted scan
 *   EVM_GEN7_CREATOR_VAULT_<chainId>       "0xaddr@startBlock"  CreatorRewardsVaultV2 (gen-7): event scan + operator
 *   EVM_GEN7_HOLDER_DISTRIBUTOR_<chainId>  "0xaddr@startBlock"  holder RewardDistributor (gen-7)
 *   EVM_GEN7_COMMUNITY_VAULT_<chainId>     "0xaddr"             CommunityRewardsVault (gen-7)
 * Unset: nothing is added and every list stays as before. Which stack a coin belongs to is read per campaign
 * (its fee_vault, from CampaignChoiceSet of the vault that recorded it), never from these lists.
 */
import { ethers } from "ethers";

export const EVM_GEN7_HOLDER_PROGRAM = "airdrop_holders_gen7";

export type Gen7Entry = { address: string; startBlock: number };
export type Gen7FeesStack = {
  router: Gen7Entry | null;
  creatorVault: Gen7Entry | null;
  holderDistributor: Gen7Entry | null;
  communityVault: Gen7Entry | null;
  invalid: string[];
};

const NAMES = {
  router: "EVM_GEN7_ROUTER",
  creatorVault: "EVM_GEN7_CREATOR_VAULT",
  holderDistributor: "EVM_GEN7_HOLDER_DISTRIBUTOR",
  communityVault: "EVM_GEN7_COMMUNITY_VAULT",
} as const;

function parseEntry(raw: string | undefined): { entry: Gen7Entry | null; invalid: string | null } {
  const text = String(raw || "").trim();
  if (!text) return { entry: null, invalid: null };
  const [addressPart, blockPart] = text.split("@").map((s) => String(s || "").trim());
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart) || /^0x0{40}$/i.test(addressPart)) return { entry: null, invalid: text };
  let address: string;
  try {
    address = ethers.getAddress(addressPart);
  } catch {
    return { entry: null, invalid: text };
  }
  if (blockPart && !/^\d+$/.test(blockPart)) return { entry: null, invalid: text };
  return { entry: { address, startBlock: blockPart ? Number(blockPart) : 0 }, invalid: null };
}

export function evmGen7FeesStack(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen7FeesStack {
  const out: Gen7FeesStack = { router: null, creatorVault: null, holderDistributor: null, communityVault: null, invalid: [] };
  for (const [key, base] of Object.entries(NAMES) as Array<[keyof typeof NAMES, string]>) {
    const name = `${base}_${chainId}`;
    const { entry, invalid } = parseEntry(env[name]);
    if (invalid) out.invalid.push(`${name}: ${invalid}`);
    if (entry) out[key] = entry;
  }
  return out;
}

/** A router scan list (lowercase addresses) with the gen-7 router appended once; unchanged when unset. */
export function withGen7Router(
  chainId: number,
  routers: Array<{ address: string; startBlock: number }>,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ address: string; startBlock: number }> {
  const gen7 = evmGen7FeesStack(chainId, env).router;
  if (!gen7) return routers;
  const address = gen7.address.toLowerCase();
  if (routers.some((r) => r.address === address)) return routers;
  return [...routers, { address, startBlock: gen7.startBlock }];
}

import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, json } from "../server/http.js";

/**
 * GET /api/evm/creator-fees?creator=0x..&chainId=56|4663
 *
 * The creator's 5% of every trade on their BNB / Robinhood coins (2026-09-26). TreasuryRouterV3 sends
 * it to CreatorRewardsVault.accrueTradeFee(campaign), where it waits per campaign in
 * pendingCreatorFees; only campaign.creator() can claimCreatorFees(campaign). Read from chain, never
 * from the DB. Campaigns of the first BNB generation route through TreasuryRouterV2, which has no
 * creator slice, so they have nothing here by design.
 */

const VAULT_ABI = [
  "function pendingCreatorFees(address) view returns (uint256)",
  "function lifetimeCreatorFees(address) view returns (uint256)",
  "function claimedCreatorFees(address) view returns (uint256)",
];

const MAINNET_VAULTS = {
  56: "0x72A963682B261195EB43F8f75e0515ab279EbD14",
  4663: "0xD9E381408A4e361C66D8b1e657583bdE6c52402d",
};

export function creatorRewardsVaultAddress(chainId) {
  const configured = String(process.env[`CREATOR_REWARDS_VAULT_ADDRESS_${chainId}`] || process.env[`VITE_CREATOR_REWARDS_VAULT_ADDRESS_${chainId}`] || "").trim();
  return configured || MAINNET_VAULTS[chainId] || "";
}

function rpcUrl(chainId) {
  const perChain = String(process.env[`ROBINHOOD_RPC_HTTP_${chainId}`] || process.env[`BSC_RPC_HTTP_${chainId}`] || process.env[`VITE_PUBLIC_RPC_${chainId}`] || "").trim();
  if (perChain) return perChain.split(",")[0].trim();
  if (chainId === 4663) return String(process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
  if (chainId === 56) return String(process.env.BSC_RPC_HTTP || "https://bsc-dataseed.binance.org").trim();
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    const creator = String(q.creator || q.wallet || "").trim().toLowerCase();
    const chainId = Number(q.chainId);
    if (!isAddress(creator)) return json(res, 400, { error: "Invalid creator" });
    const vaultAddress = creatorRewardsVaultAddress(chainId);
    const url = rpcUrl(chainId);
    if (!vaultAddress || !url) return json(res, 200, { chainId, items: [], vaultAddress: null });

    const { rows } = await pool.query(
      `select campaign_address, name, symbol
         from public.campaigns
        where chain_id = $1 and lower(creator_address) = $2
        order by created_block desc nulls last
        limit 100`,
      [chainId, creator],
    );
    if (!rows.length) return json(res, 200, { chainId, vaultAddress, items: [] });

    const network = ethers.Network.from(chainId);
    const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
    const items = [];
    for (const row of rows) {
      const campaign = String(row.campaign_address).toLowerCase();
      const [pending, lifetime, claimed] = await Promise.all([
        vault.pendingCreatorFees(campaign),
        vault.lifetimeCreatorFees(campaign),
        vault.claimedCreatorFees(campaign),
      ]);
      if (lifetime === 0n && pending === 0n) continue; // never earned here (e.g. a first-generation campaign)
      items.push({
        campaignAddress: campaign,
        name: row.name || null,
        symbol: row.symbol || null,
        pendingWei: pending.toString(),
        lifetimeWei: lifetime.toString(),
        claimedWei: claimed.toString(),
      });
    }
    return json(res, 200, { chainId, vaultAddress, items });
  } catch (error) {
    console.error("[api/evm/creator-fees]", error);
    return json(res, 500, { error: "Server error" });
  }
}

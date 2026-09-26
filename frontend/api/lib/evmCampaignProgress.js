import { ethers } from "ethers";

/**
 * BNB / Robinhood bonding progress for the campaign list, exactly as Token Details computes it
 * (src/pages/TokenDetails.tsx curveProgress): the larger of tokens sold / curve supply and the
 * campaign's native balance / graduationNativeTarget() -- each campaign's own USD target through the
 * graduation oracle. Robinhood's graduationTarget is USD, so like Token Details it is not read as a
 * native target there. Replaces the fixed 50 BNB default. Batched per page, cached briefly.
 */
const CACHE_MS = 15_000;
const cache = new Map(); // `${chainId}:${address}` -> { at, pct }
const CAMPAIGN_ABI = [
  "function sold() view returns (uint256)",
  "function curveSupply() view returns (uint256)",
  "function graduationNativeTarget() view returns (uint256)",
  "function graduationTarget() view returns (uint256)",
];

function rpcUrl(chainId) {
  const perChain = String(process.env[`ROBINHOOD_RPC_HTTP_${chainId}`] || process.env[`BSC_RPC_HTTP_${chainId}`] || process.env[`VITE_PUBLIC_RPC_${chainId}`] || "").trim();
  if (perChain) return perChain.split(",")[0].trim();
  if (chainId === 4663) return String(process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
  if (chainId === 46630) return String(process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com").trim();
  if (chainId === 56) return String(process.env.BSC_RPC_HTTP || "https://bsc-dataseed.binance.org").trim();
  if (chainId === 97) return String(process.env.BSC_TESTNET_RPC_HTTP || "https://data-seed-prebsc-1-s1.binance.org:8545").trim();
  return "";
}

const providers = new Map();
function providerFor(chainId) {
  if (!providers.has(chainId)) {
    const network = ethers.Network.from(chainId);
    providers.set(chainId, new ethers.JsonRpcProvider(rpcUrl(chainId), network, { staticNetwork: network }));
  }
  return providers.get(chainId);
}

const pctOf = (num, den) => (den > 0n ? Number((num * 1_000_000n) / den) / 10_000 : 0);

async function progressFor(chainId, address) {
  const provider = providerFor(chainId);
  const campaign = new ethers.Contract(address, CAMPAIGN_ABI, provider);
  const robinhood = chainId === 4663 || chainId === 46630;
  const [sold, curveSupply, balance, nativeTarget] = await Promise.all([
    campaign.sold().catch(() => 0n),
    campaign.curveSupply().catch(() => 0n),
    provider.getBalance(address).catch(() => 0n),
    robinhood ? Promise.resolve(0n) : campaign.graduationNativeTarget().catch(() => campaign.graduationTarget().catch(() => 0n)),
  ]);
  if (curveSupply <= 0n && nativeTarget <= 0n) return null;
  return Math.max(0, Math.min(100, Math.max(pctOf(sold, curveSupply), pctOf(balance, nativeTarget))));
}

/** Sets progressPct on BNB / Robinhood items from their own contracts (never throws). */
export async function withEvmBondingProgress(items) {
  const now = Date.now();
  const evm = items.filter((item) => [56, 97, 4663, 46630].includes(Number(item.chainId)) && !item.isDexTrading && rpcUrl(Number(item.chainId)));
  await Promise.all(evm.map(async (item) => {
    const key = `${item.chainId}:${String(item.campaignAddress).toLowerCase()}`;
    let entry = cache.get(key);
    if (!entry || entry.at < now - CACHE_MS) {
      const pct = await progressFor(Number(item.chainId), item.campaignAddress).catch(() => undefined);
      if (pct === undefined) return; // RPC failed: keep whatever the row had
      entry = { at: now, pct };
      cache.set(key, entry);
    }
    if (entry.pct != null) item.progressPct = entry.pct;
  }));
  for (const item of items) if (item.isDexTrading) item.progressPct = 100;
  return items;
}

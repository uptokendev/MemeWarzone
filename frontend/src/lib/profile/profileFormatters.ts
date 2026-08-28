import type { CampaignSummary } from "@/lib/launchpadClient";

export function getExplorerBase(chainId?: number): string {
  // Solana
  if (chainId === 101 || chainId === 102) return "https://explorer.solana.com";
  // Robinhood Chain
  if (chainId === 46630) return "https://explorer.testnet.chain.robinhood.com";
  if (chainId === 4663) return "https://robinhoodchain.blockscout.com";
  // BSC
  if (chainId === 97) return "https://testnet.bscscan.com";
  if (chainId === 56) return "https://bscscan.com";

  // Unknown chain: do not silently send users to BscScan.
  return "";
}

export function shorten(addr?: string | null): string {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function pickTokenAddressFromSummary(s: CampaignSummary): string | null {
  const anyCampaign: any = s?.campaign as any;
  return (
    anyCampaign?.token ||
    anyCampaign?.tokenAddress ||
    anyCampaign?.tokenContract ||
    anyCampaign?.tokenAddr ||
    null
  );
}

export function formatTimeAgo(createdAt?: number): string {
  if (!createdAt) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - createdAt);
  if (diff < 60) return "now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

export function formatNumber(value?: number | null, maxDecimals = 4): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
}

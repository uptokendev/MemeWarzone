/**
 * Per-chain display helpers (symbol, short chain name, DEX name, explorer) used by pages and components.
 * They live here, not in the .tsx files, so React Fast Refresh keeps working on those files and the node
 * tests can run them (src/lib/dogeosPresentation.test.mjs). Each helper keeps the exact values its page
 * had for 56, 97, 101, 102, 4663 and 46630; DogeOS (6281971) has its own branch, never the BNB fallthrough.
 */
import {
  getExplorerTxBase,
  getNativeSymbol,
  isDogeosChainId,
  isRobinhoodChainId,
  isSolanaChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import { DOGEOS_DEX_LABEL, DOGEOS_EXPLORER_BASE, DOGEOS_SHORT_LABEL } from "@/lib/dogeosPresentation.mjs";

/** Feed card chain chip (components/feed/FeedCards.tsx). Null for an unknown chain: no chip. */
export function feedChainLabel(chainId?: number | null) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "Solana";
  if (id === 4663 || id === 46630) return "Robinhood";
  if (id === 56 || id === 97) return "BNB";
  if (isDogeosChainId(id)) return DOGEOS_SHORT_LABEL;
  return null;
}

/** Native unit on feed trade cards (components/feed/FeedCards.tsx). */
export function feedNativeSymbol(chainId?: number | null) {
  if (Number(chainId) === 101 || Number(chainId) === 102) return "SOL";
  if (Number(chainId) === 4663 || Number(chainId) === 46630) return "ETH";
  if (isDogeosChainId(Number(chainId))) return getNativeSymbol(Number(chainId));
  return "BNB";
}

/** Draft card chain name (components/home/DraftCampaignGrid.tsx). */
export function draftChainLabel(chainId: number) {
  if (chainId === SOLANA_CHAIN_ID) return "Solana";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "Robinhood";
  if (isDogeosChainId(chainId)) return DOGEOS_SHORT_LABEL;
  return "BNB";
}

/** Draft card chain badge colours (components/home/DraftCampaignGrid.tsx). */
export function draftChainBadgeClass(chainId: number) {
  if (chainId === SOLANA_CHAIN_ID) return "border-violet-400/60 bg-violet-400/10 text-violet-300";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return "border-sky-400/60 bg-sky-400/10 text-sky-300";
  }
  if (isDogeosChainId(chainId)) return "border-yellow-300/60 bg-yellow-300/10 text-yellow-200";
  return "border-amber-400/60 bg-amber-400/10 text-amber-300";
}

/** Native unit the UpVote is paid in (components/token/UpvoteDialog.tsx). */
export function upvoteNativeUnit(chainId: number, isSolanaCampaign: boolean): string {
  if (isSolanaCampaign) return "SOL";
  if (isRobinhoodChainId(chainId)) return "ETH";
  if (isDogeosChainId(chainId)) return getNativeSymbol(chainId);
  return "BNB";
}

/** Network name in the UpVote switch-wallet copy (components/token/UpvoteDialog.tsx). */
export function upvoteNetworkLabel(chainId: number): string {
  if (isRobinhoodChainId(chainId)) return "Robinhood";
  if (isDogeosChainId(chainId)) return DOGEOS_SHORT_LABEL;
  return "BNB";
}

function isRobinhoodRewardChainId(chainId?: number | null) {
  const id = Number(chainId || 0);
  return id === 4663 || id === 46630;
}

/** Reward native unit (pages/command-center/CommandCenterClaims.tsx). */
export function rewardNativeSymbol(chainId?: number | null) {
  if (isSolanaRewardChainId(chainId)) return "SOL";
  if (isRobinhoodRewardChainId(chainId)) return "ETH";
  if (isDogeosChainId(Number(chainId || 0))) return getNativeSymbol(Number(chainId));
  return "BNB";
}

/** Reward chain name (pages/command-center/CommandCenterClaims.tsx). */
export function rewardChainLabel(chainId?: number | null) {
  if (isSolanaRewardChainId(chainId)) return "Solana";
  if (isRobinhoodRewardChainId(chainId)) return "Robinhood";
  if (isDogeosChainId(Number(chainId || 0))) return DOGEOS_SHORT_LABEL;
  return "BNB";
}

/** Explorer base on the public profile (pages/PublicProfile.tsx). */
export function publicProfileExplorerBase(chainId?: number): string {
  if (chainId === 101 || chainId === 102) return "https://explorer.solana.com";
  if (chainId === 46630) return "https://explorer.testnet.chain.robinhood.com";
  if (chainId === 4663) return "https://explorer.chain.robinhood.com";
  if (chainId === 97) return "https://testnet.bscscan.com";
  if (chainId === 56) return "https://bscscan.com";
  if (isDogeosChainId(chainId)) return DOGEOS_EXPLORER_BASE;
  return "https://bscscan.com";
}

/** Explorer base on the token page (pages/TokenDetails.tsx). */
export function tokenDetailsExplorerBase(chainId?: number): string {
  const id = Number(chainId ?? 0);
  if (id === 101) return "https://explorer.solana.com";
  if (id === 46630) return "https://explorer.testnet.chain.robinhood.com";
  if (id === 4663) return "https://explorer.chain.robinhood.com";
  if (id === 56) return "https://bscscan.com";
  if (id === 97) return "https://testnet.bscscan.com";
  if (isDogeosChainId(id)) return DOGEOS_EXPLORER_BASE;
  return "https://bscscan.com";
}

/** "View tx" link on a chart pin (components/token/UnifiedMarketChart.tsx). */
export function chartExplorerTxUrl(chainId: number, txHash: string): string {
  if (isSolanaChainId(chainId)) {
    const cluster = Number(chainId) === 102 ? "?cluster=devnet" : "";
    return `https://explorer.solana.com/tx/${encodeURIComponent(txHash)}${cluster}`;
  }
  if (Number(chainId) === 46630) return `https://explorer.testnet.chain.robinhood.com/tx/${txHash}`;
  if (Number(chainId) === 4663) return `https://explorer.chain.robinhood.com/tx/${txHash}`;
  if (isDogeosChainId(Number(chainId))) return `${getExplorerTxBase(Number(chainId) as SupportedChainId)}${txHash}`;
  const base = Number(chainId) === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com";
  return `${base}/tx/${txHash}`;
}

/** Native unit on an EVM token page: ETH on Robinhood, DOGE on DogeOS, else BNB (pages/TokenDetails.tsx). */
export function evmPageNativeUnit(chainId?: number | null): string {
  if (isRobinhoodChainId(chainId)) return "ETH";
  if (isDogeosChainId(chainId)) return getNativeSymbol(chainId);
  return "BNB";
}

/** DEX an EVM coin trades on after graduation: Uniswap on Robinhood, MuchFi on DogeOS, else Topaz (pages/TokenDetails.tsx). */
export function evmPageDexVenueLabel(chainId?: number | null): string {
  if (isRobinhoodChainId(chainId)) return "Uniswap";
  if (isDogeosChainId(chainId)) return DOGEOS_DEX_LABEL;
  return "Topaz";
}

/** Native unit of the profile's EVM chain: ETH on Robinhood, DOGE on DogeOS, else BNB (hooks/profile/useProfileBalances.ts). */
export function profileNativeSymbol(chainId: number): string {
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "ETH";
  if (isDogeosChainId(chainId)) return getNativeSymbol(chainId);
  return "BNB";
}

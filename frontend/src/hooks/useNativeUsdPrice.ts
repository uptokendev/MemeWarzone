import { isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { useEthUsdPrice } from "@/hooks/useEthUsdPrice";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";

/** USD per native coin for the campaign chain. Never cross-price SOL/ETH with BNB/USD. */
export function useNativeUsdPrice(chainId?: number | null) {
  const id = Number(chainId);
  const solana = isSolanaChainId(id);
  const robinhood = isRobinhoodChainId(id);
  const bnb = useBnbUsdPrice(!solana && !robinhood);
  const sol = useSolUsdPrice(solana);
  const eth = useEthUsdPrice(robinhood);
  if (solana) return sol;
  if (robinhood) return eth;
  return bnb;
}

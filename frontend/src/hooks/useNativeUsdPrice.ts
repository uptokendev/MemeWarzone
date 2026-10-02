import { isDogeosChainId, isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { useDogeUsdPrice } from "@/hooks/useDogeUsdPrice";
import { useEthUsdPrice } from "@/hooks/useEthUsdPrice";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";

/** USD per native coin for the campaign chain. Never cross-price SOL/ETH/DOGE with BNB/USD. */
export function useNativeUsdPrice(chainId?: number | null) {
  const id = Number(chainId);
  const solana = isSolanaChainId(id);
  const robinhood = isRobinhoodChainId(id);
  const dogeos = isDogeosChainId(id);
  const bnb = useBnbUsdPrice(!solana && !robinhood && !dogeos);
  const sol = useSolUsdPrice(solana);
  const eth = useEthUsdPrice(robinhood);
  const doge = useDogeUsdPrice(dogeos);
  if (solana) return sol;
  if (robinhood) return eth;
  if (dogeos) return doge;
  return bnb;
}

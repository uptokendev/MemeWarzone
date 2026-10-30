import { isDogeosChainId, isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { useDogeUsdPrice } from "@/hooks/useDogeUsdPrice";
import { useEthUsdPrice } from "@/hooks/useEthUsdPrice";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";

export type NativeUsdPriceSource = "sol" | "eth" | "doge" | "bnb";

/** Which native/USD feed prices a chain. DogeOS has its own branch: it never falls through to BNB. */
export function nativeUsdPriceSource(chainId?: number | null): NativeUsdPriceSource {
  const id = Number(chainId);
  if (isSolanaChainId(id)) return "sol";
  if (isRobinhoodChainId(id)) return "eth";
  if (isDogeosChainId(id)) return "doge";
  return "bnb";
}

/** USD per native coin for the campaign chain. Never cross-price SOL/ETH/DOGE with BNB/USD. */
export function useNativeUsdPrice(chainId?: number | null) {
  const source = nativeUsdPriceSource(chainId);
  const bnb = useBnbUsdPrice(source === "bnb");
  const sol = useSolUsdPrice(source === "sol");
  const eth = useEthUsdPrice(source === "eth");
  const doge = useDogeUsdPrice(source === "doge");
  if (source === "sol") return sol;
  if (source === "eth") return eth;
  if (source === "doge") return doge;
  return bnb;
}

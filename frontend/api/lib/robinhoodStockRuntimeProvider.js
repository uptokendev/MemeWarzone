import { ethers } from "ethers";

export function createRobinhoodRuntimeProvider(rpcUrl, chainId = 4663) {
  if (!String(rpcUrl || "").trim()) throw new Error("Robinhood runtime RPC URL is required");
  return new ethers.JsonRpcProvider(String(rpcUrl).trim(), Number(chainId), { staticNetwork: true });
}

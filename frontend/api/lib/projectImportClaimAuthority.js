import { FetchRequest, JsonRpcProvider } from "ethers";
import { resolveProjectOwnershipEvm } from "./projectOwnershipResolveEvm.js";

const BNB_CHAIN_ID = 56;
const ROBINHOOD_CHAIN_ID = 4663;
let bnbProvider = null;
let robinhoodProvider = null;

function rpcUrl(chainId) {
  if (Number(chainId) === BNB_CHAIN_ID) return String(process.env.BNB_RPC_URL || process.env.BSC_RPC_URL || process.env.BSC_MAINNET_RPC_URL || "").trim();
  if (Number(chainId) === ROBINHOOD_CHAIN_ID) return String(process.env.ROBINHOOD_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.RH_RPC_URL || process.env.RPC_URL_4663 || "").trim();
  return "";
}

function providerFor(chainId) {
  const id = Number(chainId);
  if (id !== BNB_CHAIN_ID && id !== ROBINHOOD_CHAIN_ID) throw Object.assign(new Error("EVM claim authority is only supported on BNB and Robinhood"), { code: "INVALID_CHAIN" });
  if (id === BNB_CHAIN_ID && bnbProvider) return bnbProvider;
  if (id === ROBINHOOD_CHAIN_ID && robinhoodProvider) return robinhoodProvider;
  const url = rpcUrl(id);
  if (!url) throw Object.assign(new Error(id === BNB_CHAIN_ID ? "BNB claim RPC is not configured" : "Robinhood claim RPC is not configured"), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
  const request = new FetchRequest(url); request.timeout = 7000;
  const provider = new JsonRpcProvider(request, id, { batchMaxCount: 1 });
  if (id === BNB_CHAIN_ID) bnbProvider = provider; else robinhoodProvider = provider;
  return provider;
}

export async function resolveProjectImportClaimAuthority({ chainId, tokenAddress, connectedWallet }) {
  const id = Number(chainId);
  const wallet = String(connectedWallet || "0x0000000000000000000000000000000000000000").trim();
  const raw = await resolveProjectOwnershipEvm({
    provider: providerFor(id),
    chainId: id,
    contractAddress: tokenAddress,
    signedConnectedWallet: wallet,
  });
  if (!raw?.ok) throw Object.assign(new Error(raw?.error || "EVM claim authority lookup failed"), { code: raw?.errorCode || "PROJECT_IMPORT_RESOLVE_FAILED" });
  return {
    chainId: id,
    tokenAddress: raw.contractAddress,
    available: raw.ownership?.automaticOwnershipVerification !== "unavailable" && Boolean(raw.ownership?.currentOwner),
    currentAuthority: raw.ownership?.currentOwner ?? null,
    matchesConnected: Boolean(raw.ownership?.automaticOwnershipVerified),
    authoritySource: raw.ownership?.method ? `evm_${raw.ownership.method}` : null,
  };
}

export function setProjectImportClaimProvidersForTest({ bnb = null, robinhood = null } = {}) {
  bnbProvider = bnb;
  robinhoodProvider = robinhood;
}

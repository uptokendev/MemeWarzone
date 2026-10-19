/**
 * Protected (private mempool) RPCs for BNB Chain trades (F13, audit D-M2: a buy sent through a public BSC RPC can be
 * sandwiched at almost any slippage).
 *
 * What the app can and cannot do: every EVM trade is sent by the user's wallet (eth_sendTransaction through ethers'
 * BrowserProvider), and the wallet submits it to the RPC configured in the wallet. The app cannot pick that RPC, and
 * injected wallets do not offer eth_signTransaction (sign without sending) that would let the app hand the signed
 * transaction to a private relay itself. What the app can do is ask the wallet, through wallet_addEthereumChain, to
 * add a private RPC for chain 56. Whether the wallet then uses it for chain 56 is the wallet's decision: MetaMask asks
 * the user to add the RPC to the existing BNB Chain network and switch to it; other wallets may ignore the request or
 * keep their own RPC. So this is an offer, not a guarantee, and the copy says so.
 *
 * Endpoints are the free BSC private RPCs BNB Chain lists for sandwich protection (bnbchain.org blog "Protecting users
 * from sandwich attacks", and the providers' docs). None of them guarantees protection; each sends the transaction to
 * block builders without the public mempool. There is no such RPC for BNB testnet (97).
 *
 * The per-browser memory (added / dismissed) lives in localStorage, every access wrapped in try/catch: a private
 * window or blocked storage only means the notice shows again.
 */

export const BSC_CHAIN_ID = 56;

export const BSC_PROTECTED_RPCS = Object.freeze([
  Object.freeze({ id: "pancakeswap", label: "PancakeSwap private RPC", url: "https://bscrpc.pancakeswap.finance" }),
  Object.freeze({ id: "48club", label: "48 Club private RPC", url: "https://rpc-bsc.48.club" }),
  Object.freeze({ id: "merkle", label: "Merkle BSC private RPC", url: "https://bsc.merkle.io" }),
  Object.freeze({ id: "bloxroute", label: "bloXroute BSC Protect", url: "https://bsc.rpc.blxrbdn.com" }),
]);

export const BSC_PROTECTED_RPC_DEFAULT = BSC_PROTECTED_RPCS[0];

const STORAGE_KEY = "mwz:bsc-protected-rpc";

/** True when the app offers a protected RPC for gen-8 trades on this chain (BNB Chain mainnet only). */
export function offersProtectedRpc(chainId) {
  return Number(chainId) === BSC_CHAIN_ID;
}

/** wallet_addEthereumChain params that add `rpc` as an RPC of BNB Chain (chain id 0x38). */
export function protectedBscChainParams(rpc = BSC_PROTECTED_RPC_DEFAULT) {
  return {
    chainId: "0x38",
    chainName: "BNB Smart Chain (private RPC)",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: [rpc.url],
    blockExplorerUrls: ["https://bscscan.com/"],
  };
}

function storage(scope) {
  try {
    return scope?.localStorage || null;
  } catch {
    return null;
  }
}

/** What this browser remembers: { state: "added" | "dismissed", rpc, at } or null. */
export function readProtectedRpcChoice(scope = globalThis) {
  try {
    const raw = storage(scope)?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && (v.state === "added" || v.state === "dismissed") ? v : null;
  } catch {
    return null;
  }
}

export function rememberProtectedRpcChoice(state, rpcId = BSC_PROTECTED_RPC_DEFAULT.id, scope = globalThis, now = Date.now()) {
  try {
    storage(scope)?.setItem(STORAGE_KEY, JSON.stringify({ state, rpc: rpcId, at: now }));
  } catch {
    // storage blocked: the notice shows again next time
  }
}

export function forgetProtectedRpcChoice(scope = globalThis) {
  try {
    storage(scope)?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Asks the wallet to add the protected RPC for BNB Chain. `wallet` is an EIP-1193 provider ({ request }) or an
 * ethers BrowserProvider ({ send }). Remembers "added" when the wallet accepted the request; a rejection throws and
 * remembers nothing. The wallet may still keep its own RPC: there is no standard way to read back which RPC it uses.
 */
export async function addProtectedBscRpc(wallet, { rpc = BSC_PROTECTED_RPC_DEFAULT, scope = globalThis } = {}) {
  const params = [protectedBscChainParams(rpc)];
  if (wallet && typeof wallet.request === "function") await wallet.request({ method: "wallet_addEthereumChain", params });
  else if (wallet && typeof wallet.send === "function") await wallet.send("wallet_addEthereumChain", params);
  else throw new Error("Connect a wallet first.");
  rememberProtectedRpcChoice("added", rpc.id, scope);
  return rpc;
}

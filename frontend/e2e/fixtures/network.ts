import type { Page, Request } from "@playwright/test";
import { ethers } from "ethers";

import {
  BNB_CAMPAIGN,
  BNB_CHAIN_ID,
  BNB_CREATOR,
  BNB_NAME,
  BNB_SYMBOL,
  BNB_TOKEN,
  SOLANA_CAMPAIGN,
  SOLANA_CHAIN_ID,
  SOLANA_MINT,
  bnbCampaignItem,
  solanaCampaignItem,
} from "./campaigns";

const abi = ethers.AbiCoder.defaultAbiCoder();
const selector = (signature: string) => ethers.id(signature).slice(0, 10);
const SELECTORS = {
  token: selector("token()"),
  name: selector("name()"),
  symbol: selector("symbol()"),
  creator: selector("creator()"),
  logoURI: selector("logoURI()"),
  launched: selector("launched()"),
  finalizedAt: selector("finalizedAt()"),
  sold: selector("sold()"),
  curveSupply: selector("curveSupply()"),
  liquiditySupply: selector("liquiditySupply()"),
  creatorReserve: selector("creatorReserve()"),
  basePrice: selector("basePrice()"),
  priceSlope: selector("priceSlope()"),
  graduationTarget: selector("graduationTarget()"),
  graduationNativeTarget: selector("graduationNativeTarget()"),
  liquidityBps: selector("liquidityBps()"),
  protocolFeeBps: selector("protocolFeeBps()"),
  currentPrice: selector("currentPrice()"),
  quoteBuyExactTokens: selector("quoteBuyExactTokens(uint256)"),
  quoteSellExactTokens: selector("quoteSellExactTokens(uint256)"),
  quoteBuyExactBnb: selector("quoteBuyExactBnb(uint256)"),
  quoteSellExactBnb: selector("quoteSellExactBnb(uint256)"),
};

function evmCallResult(data: string): string {
  const method = String(data || "").slice(0, 10).toLowerCase();
  if (method === SELECTORS.token) return abi.encode(["address"], [BNB_TOKEN]);
  if (method === SELECTORS.creator) return abi.encode(["address"], [BNB_CREATOR]);
  if (method === SELECTORS.name) return abi.encode(["string"], [BNB_NAME]);
  if (method === SELECTORS.symbol) return abi.encode(["string"], [BNB_SYMBOL]);
  if (method === SELECTORS.logoURI) return abi.encode(["string"], ["/placeholder.svg"]);
  if (method === SELECTORS.launched) return abi.encode(["bool"], [false]);
  if (
    method === SELECTORS.finalizedAt ||
    method === SELECTORS.sold ||
    method === SELECTORS.creatorReserve ||
    method === SELECTORS.priceSlope
  ) {
    return abi.encode(["uint256"], [0]);
  }
  if (method === SELECTORS.curveSupply) return abi.encode(["uint256"], [ethers.parseUnits("800000000", 18)]);
  if (method === SELECTORS.liquiditySupply) return abi.encode(["uint256"], [ethers.parseUnits("200000000", 18)]);
  if (method === SELECTORS.basePrice || method === SELECTORS.currentPrice) {
    return abi.encode(["uint256"], [ethers.parseEther("0.00012")]);
  }
  if (method === SELECTORS.graduationTarget || method === SELECTORS.graduationNativeTarget) {
    return abi.encode(["uint256"], [ethers.parseEther("1")]);
  }
  if (method === SELECTORS.liquidityBps) return abi.encode(["uint256"], [2000]);
  if (method === SELECTORS.protocolFeeBps) return abi.encode(["uint256"], [100]);
  if (method === SELECTORS.quoteBuyExactBnb) {
    return abi.encode(
      ["uint256", "uint256", "uint256"],
      [ethers.parseUnits("1000", 18), ethers.parseEther("0.1"), ethers.parseEther("0.001")],
    );
  }
  if (method === SELECTORS.quoteSellExactBnb) {
    return abi.encode(
      ["uint256", "uint256", "uint256"],
      [ethers.parseUnits("1000", 18), ethers.parseEther("0.1"), ethers.parseEther("0.001")],
    );
  }
  if (method === SELECTORS.quoteBuyExactTokens || method === SELECTORS.quoteSellExactTokens) {
    return abi.encode(["uint256"], [ethers.parseEther("0.1")]);
  }
  return "0x";
}

export type ClassifiedRequest = {
  url: string;
  host: string;
  pathname: string;
  chainId: number | null;
  family: "solanaRpc" | "evmRpc" | "api" | "other";
};

export type RequestLedger = {
  requests: ClassifiedRequest[];
};

const EVM_RPC_HOSTS = new Set(["rpc-evm-56.test.mwz", "rpc-evm-97.test.mwz"]);
const SOLANA_RPC_HOSTS = new Set(["rpc-solana-101.test.mwz"]);

function parseChainId(url: string): number | null {
  try {
    const parsed = new URL(url);
    const query = Number(parsed.searchParams.get("chainId") || "");
    if (query === 56 || query === 97 || query === 101) return query;
    if (parsed.hostname === "rpc-evm-56.test.mwz") return 56;
    if (parsed.hostname === "rpc-evm-97.test.mwz") return 97;
    if (parsed.hostname === "rpc-solana-101.test.mwz") return 101;
  } catch {
    // ignore
  }
  return null;
}

function classify(url: string): ClassifiedRequest {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, host: "", pathname: "", chainId: null, family: "other" };
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  const chainId = parseChainId(url);
  if (
    SOLANA_RPC_HOSTS.has(host) ||
    host.includes("solana.com") ||
    host.includes("helius") ||
    host.includes("triton")
  ) {
    return { url, host, pathname, chainId: chainId ?? 101, family: "solanaRpc" };
  }
  if (
    EVM_RPC_HOSTS.has(host) ||
    host.includes("bsc-dataseed") ||
    host.includes("publicnode") ||
    host.includes("binance.org") ||
    host.includes("bsc-testnet")
  ) {
    return { url, host, pathname, chainId, family: "evmRpc" };
  }
  if (pathname.startsWith("/api/") || pathname.includes("/api/")) {
    return { url, host, pathname, chainId, family: "api" };
  }
  return { url, host, pathname, chainId, family: "other" };
}

function json(route: { fulfill: Function }, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function campaignList(chainId: number) {
  if (chainId === SOLANA_CHAIN_ID) return { items: [solanaCampaignItem()], nextCursor: null, pageSize: 24, source: "api" };
  return { items: [bnbCampaignItem(chainId === 56 ? 56 : BNB_CHAIN_ID)], nextCursor: null, pageSize: 24, source: "api" };
}

function tokenScopedPayload(chainId: number, address: string) {
  const solana = chainId === SOLANA_CHAIN_ID;
  const item = solana ? solanaCampaignItem() : bnbCampaignItem(chainId === 56 ? 56 : BNB_CHAIN_ID);
  return {
    chainId,
    campaignAddress: solana ? SOLANA_CAMPAIGN : BNB_CAMPAIGN,
    tokenAddress: solana ? SOLANA_MINT : BNB_TOKEN,
    address,
    last_price_bnb: item.lastPriceBnb,
    marketcap_bnb: item.marketcapBnb,
    vol_24h_bnb: item.vol24hBnb,
    items: [],
    trades: [],
    candles: [],
    ok: true,
  };
}

function evmRpcResult(method: string, params?: unknown) {
  if (method === "eth_chainId") return "0x61";
  if (method === "net_version") return "97";
  if (method === "eth_blockNumber") return "0x10";
  if (method === "eth_gasPrice") return "0x3b9aca00";
  if (method === "eth_estimateGas") return "0x5208";
  if (method === "eth_getBalance") return "0x0";
  if (method === "eth_getCode") return "0x";
  if (method === "eth_call") {
    const data = String((params as { data?: string }[] | undefined)?.[0]?.data || "");
    return evmCallResult(data);
  }
  if (method === "eth_getLogs" || method === "eth_getBlockByNumber") return method === "eth_getLogs" ? [] : null;
  return "0x";
}

function solanaRpcResult(method: string) {
  if (method === "getHealth") return "ok";
  if (method === "getBalance") return { context: { slot: 1 }, value: 0 };
  if (method === "getAccountInfo" || method === "getMultipleAccounts") {
    return { context: { slot: 1 }, value: method === "getMultipleAccounts" ? [] : null };
  }
  if (method === "getLatestBlockhash") {
    return { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } };
  }
  if (method === "getTokenAccountsByOwner") return { context: { slot: 1 }, value: [] };
  return { context: { slot: 1 }, value: null };
}

function fulfillJsonRpc(route: { fulfill: Function; request: () => { postDataJSON?: () => unknown; postData: () => string | null } }) {
  let payload: any = null;
  try {
    payload = route.request().postDataJSON?.() ?? JSON.parse(route.request().postData() || "null");
  } catch {
    payload = null;
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const host = new URL(route.request().url()).hostname;
  const solana = host.includes("rpc-solana") || host.includes("solana.com");
  const mapped = batch.map((item) => {
    const method = String(item?.method || "");
    return {
      jsonrpc: "2.0",
      id: item?.id ?? 1,
      result: solana ? solanaRpcResult(method) : evmRpcResult(method, item?.params),
    };
  });
  return json(route, Array.isArray(payload) ? mapped : mapped[0]);
}

export async function installNetworkStubs(page: Page): Promise<RequestLedger> {
  const ledger: RequestLedger = { requests: [] };

  const record = (request: Request) => {
    const url = request.url();
    if (!/\/api\/|rpc-evm-|rpc-solana-|solana\.com|bsc-dataseed|publicnode|binance\.org/.test(url)) return;
    ledger.requests.push(classify(url));
  };

  page.on("request", record);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      await route.continue();
      return;
    }

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    const chainId = Number(parsed.searchParams.get("chainId") || "0");

    if (
      host.includes("rpc-evm-") ||
      host.includes("rpc-solana-") ||
      host.includes("solana.com") ||
      host.includes("bsc-dataseed") ||
      host.includes("publicnode") ||
      host.includes("binance.org")
    ) {
      await fulfillJsonRpc(route);
      return;
    }

    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/campaigns" || pathname === "/api/featured" || pathname === "/api/war-room") {
      await json(route, campaignList(chainId === 101 ? 101 : chainId === 56 ? 56 : 97));
      return;
    }

    if (pathname === "/api/market/resolve") {
      const address = String(parsed.searchParams.get("address") || "").toLowerCase();
      if (address === BNB_CAMPAIGN || address === BNB_TOKEN) {
        await json(route, {
          ok: true,
          chainId: chainId === 56 ? 56 : 97,
          campaignAddress: BNB_CAMPAIGN,
          tokenAddress: BNB_TOKEN,
          matchedBy: "campaign",
          inputAddress: address,
          publicUrlAddress: BNB_TOKEN,
        });
        return;
      }
      await json(route, { ok: false }, 404);
      return;
    }

    if (pathname.startsWith("/api/token/")) {
      const address = decodeURIComponent(pathname.split("/")[3] || "");
      await json(route, tokenScopedPayload(chainId === 101 ? 101 : chainId === 56 ? 56 : 97, address));
      return;
    }

    if (pathname.includes("bnb-usd") || pathname.includes("sol-usd") || pathname.includes("/price/")) {
      await json(route, { price: 600, usd: 600 });
      return;
    }

    if (pathname.startsWith("/api/drafts") || pathname.includes("lifecycle")) {
      await json(route, { items: [], drafts: [] });
      return;
    }

    if (pathname.includes("launchpad/preflight")) {
      await json(route, { allowed: true, reasons: [], warnings: [] });
      return;
    }

    if (pathname.includes("trade-authorization")) {
      await json(route, { error: "e2e" }, 404);
      return;
    }

    await json(route, { ok: true, items: [] });
  });

  return ledger;
}

export function apiChainIds(ledger: RequestLedger, pathIncludes: string): number[] {
  return ledger.requests
    .filter((row) => row.family === "api" && row.pathname.includes(pathIncludes) && row.chainId != null)
    .map((row) => row.chainId as number);
}

export function hasSolanaRpc(ledger: RequestLedger) {
  return ledger.requests.some((row) => row.family === "solanaRpc");
}

export function hasEvmRpc(ledger: RequestLedger) {
  return ledger.requests.some((row) => row.family === "evmRpc");
}

export function tokenApiChainIds(ledger: RequestLedger): number[] {
  return apiChainIds(ledger, "/api/token/");
}

/**
 * The swap widget's EVM box on BNB Chain and Robinhood Chain:
 *
 *   MemeWarzoneSwap.mount("#mwz-swap", { chainId: 56, token: "0x...", partner: "crypticpump" });
 *
 * It asks the API what the coin is (/api/widget/swap/evm/token, frontend/api/widgetSwapEvm.js):
 *   gen8    a MemeWarzone generation 8 coin: the flow below, unchanged.
 *   import  an imported coin, or a graduated MemeWarzone coin: the import route (KyberSwap on BNB Chain, Uniswap V3 on
 *           Robinhood Chain), quoted and built by our API (/api/widget/swap/quote|build) with the import fee in it
 *           (1%, half to the creator, where the chain's split is on; the API's quote says what it is). The partner's
 *           share is paid from that fee after the swap, by the build fingerprint the API records.
 *   memewarzone  our own coin the widget does not trade (still bonding, or graduated where the creator split is off):
 *           a link to its MemeWarzone page.
 *
 * Generation 8 coins:
 * Every swap is built by our API (/api/widget/swap/gen8/*, frontend/api/gen8Swap.js): a UniversalRouter V4_SWAP in
 * the coin's own Uniswap V4 pool, so a partner's builds carry the partner fingerprint the API records. The fee is the
 * pool's own (2% before graduation, 1% after, half of it to the coin's creator), taken on chain. The widget talks to
 * the page's EVM wallet through EIP-1193 only (no ethers, no RPC of its own): eth_requestAccounts,
 * wallet_switchEthereumChain, and eth_sendTransaction. The first sell of a coin approves Permit2 and sets one
 * allowance for our router. Every later sell is only the swap.
 */
import { gen8FormatAmount } from "../../shared/gen8FormatAmount.mjs";
import { pollGen8Receipt } from "../../shared/gen8ReceiptPoll.mjs";
import { STYLE, fromRaw, toRaw } from "./widgetShared";
import { addProtectedBscRpc, offersProtectedRpc, readProtectedRpcChoice, rememberProtectedRpcChoice } from "../lib/bscProtectedRpc.mjs";

type Side = "buy" | "sell";

/** EIP-1193: what window.ethereum and every injected EVM wallet expose. */
export type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export type Gen8MountOptions = {
  chainId: number;
  token: string;
  side?: Side;
  apiBase?: string;
  slippageBps?: number;
  theme?: "dark" | "light";
  evmProvider?: Eip1193;
  partner?: string;
  onSwap?: (event: { txHash: string; side: Side; token: string; chainId: number }) => void;
};

type TokenKind = "gen8" | "import" | "memewarzone";
type TokenInfo = {
  chainId: number;
  token: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  nativeSymbol: string;
  phase?: string;
  feeBps: number | null;
  pageUrl: string;
  /** Missing on an API from before the EVM import box: gen8. */
  kind?: TokenKind;
  tradable?: boolean;
  reason?: string | null;
  claimUrl?: string | null;
  creatorShareBps?: number;
  tradingOpen?: boolean;
  openAt?: number;
  maxSellable?: string | null;
};
type Quote = {
  amountIn: string;
  amountOut: string;
  minAmountOut: string | null;
  slippageBps?: number;
  slippageAuto?: boolean;
  priceImpactBps?: number | null;
  /** Import quotes (Kyber, Uniswap V3): percent, null when not measured. */
  priceImpactPct?: number | null;
  feeBps: number;
  feeNativeRaw: string | null;
  creatorShareNativeRaw?: string;
  creatorShareBps?: number;
  phase?: string;
  /** Import quotes: the route the build takes (Kyber's route summary on BNB Chain). */
  quote?: unknown;
};
type Built = { to: string; data: string; value: string; quote: Quote };
type TxStep = { to: string; data: string; value: string };
type NeedsAllowance = { needsAllowance: true; approval: TxStep | null; permit2Approval: TxStep | null; quote: Quote };
type PermitTypedData = { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };

const DEFAULT_API = "https://api.memewar.zone";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Where an import swap must go (the API's build is checked against it before the wallet sees it). */
export const IMPORT_ROUTERS: Record<number, string> = {
  56: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", // KyberSwap MetaAggregationRouterV2 (api/importSwap.js KYBER_ROUTER)
  4663: "0x8876789976decbfcbbbe364623c63652db8c0904", // Uniswap Universal Router (src/lib/robinhoodImportSwap.mjs)
};
const NO_ROUTE_TEXT = "No route here. Trade it on its MemeWarzone page.";

/** Throws unless an import build goes to the chain's router with the swap's own value (buy: the amount in; sell: 0). */
export function assertImportBuild(built: { to: string; value: string }, chainId: number, side: Side, amountRaw: bigint) {
  const router = IMPORT_ROUTERS[chainId];
  if (!router || String(built.to).toLowerCase() !== router.toLowerCase()) throw new Error("Swap targets an unexpected router.");
  const value = BigInt(built.value || "0");
  if (side === "buy" ? value !== amountRaw : value !== 0n) throw new Error("Swap amount does not match.");
}

/** Why an EVM coin is not tradable in the widget, in one line (the page link sits under it). */
export function notTradableText(reason: string | null | undefined): string {
  if (reason === "bonding") return "This coin is on its MemeWarzone bonding curve. Trade it on its MemeWarzone page.";
  if (reason === "graduated") return "This coin is not tradable here yet. Trade it on its MemeWarzone page.";
  if (reason === "fee") return "Swaps for this coin are paused here. Trade it on its MemeWarzone page.";
  if (reason === "chain") return "Imported coins trade in the widget on BNB Chain and Robinhood Chain mainnet.";
  return "This coin is not tradable here. Trade it on its MemeWarzone page.";
}
/** Lens and balances. A confirmed swap also reloads immediately. The 1 s paintOpens clock is not an RPC read. */
export const GEN8_WIDGET_REFRESH_MS = 60_000;
/** Native kept for gas on buys (as the app's evmBuyGasReserveWei). */
const GAS_RESERVE: Record<number, bigint> = { 56: 500_000_000_000_000n, 97: 500_000_000_000_000n, 4663: 200_000_000_000_000n, 46630: 200_000_000_000_000n };

export function hexValue(value: string | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}

/** EIP-712 JSON for a Permit2 permit (the EIP712Domain type added from the domain's fields). The sell path does not ask for one. */
export function typedDataJson(t: PermitTypedData): string {
  const domainTypes = [
    { name: "name", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ].filter((f) => f.name in t.domain);
  return JSON.stringify({ domain: t.domain, types: { EIP712Domain: domainTypes, ...t.types }, primaryType: t.primaryType, message: t.message });
}

/** "2.45%", "<0.01%" under one bp, "-" when the API could not measure it. */
export function formatPriceImpact(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(Number(bps))) return "-";
  if (Number(bps) < 1) return "<0.01%";
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/**
 * The slippage the widget asks the API for: the partner's slippageBps when it set one, else nothing, so the API uses
 * the chain's default (sized from the price impact on BNB Chain, 1% on Robinhood).
 */
export function slippageRequest(options: { slippageBps?: number }): { slippageBps?: number } {
  return options.slippageBps == null ? {} : { slippageBps: options.slippageBps };
}

/**
 * F13 (founder 2026-10-12): the widget offers the protected BSC RPC too, on BNB Chain mainnet only, once a wallet is
 * connected and until this browser has added or dismissed it (src/lib/bscProtectedRpc.mjs keeps the memory).
 */
export function shouldOfferProtectedRpc(chainId: number | null | undefined, connected: boolean, choice: { state: string } | null): boolean {
  return connected && offersProtectedRpc(Number(chainId)) && !choice;
}

/**
 * wallet_addEthereumChain params for a wallet that does not know the coin's chain yet (wallet_switchEthereumChain
 * answers 4902). Public keyless RPCs only: a URL written into a visitor's wallet stays there (as the app's
 * getChainParams, src/lib/chainConfig.ts; Robinhood's public RPC is the one the live app uses).
 */
export const WALLET_CHAIN_PARAMS: Record<number, { chainId: string; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  56: { chainId: "0x38", chainName: "BNB Smart Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: ["https://bsc-dataseed.bnbchain.org"], blockExplorerUrls: ["https://bscscan.com/"] },
  4663: { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com/"] },
};

/** EIP-1193 error code of a wallet error (MetaMask nests the 4902 of a mobile switch in data.originalError). */
export function walletErrorCode(error: unknown): number {
  const e = error as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  return Number(e?.code ?? e?.data?.originalError?.code ?? 0);
}

/** Puts the wallet on chain `want`: switch; a wallet without that chain (4902) adds it, then switches again. */
export async function ensureWalletChain(wallet: Eip1193, want: number) {
  const readChain = async () => Number(BigInt(String(await wallet.request({ method: "eth_chainId" }))));
  if ((await readChain()) === want) return;
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexValue(BigInt(want)) }] });
  } catch (error) {
    const params = WALLET_CHAIN_PARAMS[want];
    if (walletErrorCode(error) !== 4902 || !params) throw error;
    await wallet.request({ method: "wallet_addEthereumChain", params: [params] });
    // EIP-3085 does not require the wallet to stay on the added chain: switch again (as the app's useWallet).
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexValue(BigInt(want)) }] });
  }
  if ((await readChain()) !== want) throw new Error("Switch your wallet to this coin's chain and try again.");
}

export function findEvmWallet(scope: Record<string, any> = globalThis as any): Eip1193 | null {
  const w = scope.ethereum;
  return w && typeof w.request === "function" ? (w as Eip1193) : null;
}

export class Gen8SwapWidget {
  private root: ShadowRoot;
  private api: string;
  private side: Side;
  private token: TokenInfo | null = null;
  private quote: Quote | null = null;
  private account: string | null = null;
  private balances: { nativeRaw: bigint; tokenRaw: bigint } | null = null;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quoteSeq = 0;
  private openTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private el: Record<string, HTMLElement> = {};
  private noRoute = false;

  constructor(host: HTMLElement, private options: Gen8MountOptions) {
    this.root = host.shadowRoot || host.attachShadow({ mode: "open" });
    this.api = String(options.apiBase || DEFAULT_API).replace(/\/+$/, "");
    this.side = options.side === "sell" ? "sell" : "buy";
    this.render();
    void this.loadToken();
    this.openTimer = setInterval(() => this.paintOpens(), 1000);
    this.refreshTimer = setInterval(() => void this.refreshLive(), GEN8_WIDGET_REFRESH_MS);
  }

  /** Token state (the lens, via the API) and balances. Re-quotes only when an amount is already typed. */
  private async refreshLive() {
    await this.loadToken();
    await this.loadBalances();
    if (this.amountRaw()) void this.fetchQuote();
  }

  private wallet(): Eip1193 | null {
    return this.options.evmProvider || findEvmWallet();
  }

  private native() {
    return this.token?.nativeSymbol || "ETH";
  }

  private symbol() {
    return this.token?.symbol || "token";
  }

  /** An imported coin, a graduated MemeWarzone coin, or our coin the widget does not trade (not gen-8). */
  private isImport(): boolean {
    return Boolean(this.token && this.token.kind && this.token.kind !== "gen8");
  }

  /** The coin's decimals: 18 for gen-8 (as before), the chain's answer for every other coin. */
  private tokenDecimals(): number {
    return this.isImport() ? Number(this.token?.decimals ?? 18) : 18;
  }

  private inputDecimals(): number {
    return this.side === "buy" ? 18 : this.tokenDecimals();
  }

  private outDecimals(): number {
    return this.side === "buy" ? this.tokenDecimals() : 18;
  }

  /** Balances and receipts: the gen-8 routes for gen-8 coins (unchanged), the generic EVM routes for the others. */
  private route(name: "balances" | "status"): string {
    return this.isImport() ? `/api/widget/swap/evm/${name}` : `/api/widget/swap/gen8/${name}`;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.api}${path}`, { ...init, credentials: "omit", headers: { "content-type": "application/json", ...(init?.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw Object.assign(new Error(String(body?.error || `Request failed (${response.status})`)), { code: body?.code ?? null, status: response.status });
    return body as T;
  }

  private render() {
    this.root.innerHTML = `<style>${STYLE}</style>
      <div class="box ${this.options.theme === "light" ? "light" : ""}" part="box">
        <div class="head"><img data-k="logo" alt="" hidden /><div><div class="title" data-k="title">Loading...</div><div class="sub" data-k="sub"></div></div></div>
        <div class="tabs"><button type="button" class="buy" data-k="buy">BUY</button><button type="button" class="sell" data-k="sell">SELL</button></div>
        <div class="field"><input data-k="amount" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount" /><span class="unit" data-k="unit"></span></div>
        <div class="row"><span data-k="balance"></span><button type="button" class="max" data-k="max" hidden>MAX</button></div>
        <div class="row"><span>You receive ~</span><b data-k="out">-</b></div>
        <div class="row" data-k="impactRow"><span>Price impact</span><b data-k="impact">-</b></div>
        <div class="row" data-k="minRow"><span data-k="minLabel">At least</span><b data-k="min">-</b></div>
        <div class="row"><span data-k="feeLabel">Fee</span><b data-k="fee">-</b></div>
        <div class="row" data-k="creatorRow" hidden><span>Of which to the coin's creator</span><b data-k="creator">-</b></div>
        <button type="button" class="go" data-k="go">CONNECT WALLET</button>
        <div class="rpc" data-k="rpcRow" hidden>
          <span>Trades on BNB Chain sent through a public RPC can be front-run. Add a private RPC to your wallet so it sends them without the public mempool.</span>
          <span class="rpc-actions"><button type="button" class="rpc-add" data-k="rpcAdd">ADD PROTECTED BSC RPC</button><button type="button" class="rpc-later" data-k="rpcLater">NOT NOW</button></span>
        </div>
        <div class="msg" data-k="opens" role="status"></div>
        <div class="msg" data-k="msg" role="status"></div>
        <div class="claim" data-k="page" hidden><a data-k="pageLink" target="_blank" rel="noopener">Open it on MemeWarzone</a></div>
        <div class="claim" data-k="claim" hidden>Created this coin? <a data-k="claimLink" target="_blank" rel="noopener">Claim it on MemeWarzone</a></div>
        <div class="foot">Swaps by <a data-k="link" href="https://app.memewar.zone" target="_blank" rel="noopener">MemeWarzone</a><span data-k="via">, in the coin's Uniswap pool</span></div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>("[data-k]").forEach((node) => {
      this.el[node.dataset.k as string] = node;
    });
    this.el.buy.addEventListener("click", () => this.setSide("buy"));
    this.el.sell.addEventListener("click", () => this.setSide("sell"));
    this.el.amount.addEventListener("input", () => this.scheduleQuote());
    this.el.max.addEventListener("click", () => this.fillMax());
    this.el.go.addEventListener("click", () => void this.onGo());
    this.el.rpcAdd.addEventListener("click", () => void this.addProtectedRpc());
    this.el.rpcLater.addEventListener("click", () => {
      rememberProtectedRpcChoice("dismissed");
      this.paintRpcOffer();
    });
    this.paintSide();
  }

  private paintRpcOffer() {
    this.el.rpcRow.hidden = !shouldOfferProtectedRpc(this.token?.chainId, Boolean(this.account), readProtectedRpcChoice());
  }

  private async addProtectedRpc() {
    const wallet = this.wallet();
    if (!wallet) return;
    try {
      const rpc = await addProtectedBscRpc(wallet);
      this.say(`${rpc.label} added. The wallet decides whether it uses it for BNB Chain.`, "ok");
    } catch (error) {
      this.say(error instanceof Error ? error.message : "The wallet did not add the RPC.", "err");
    }
    this.paintRpcOffer();
  }

  private say(text: string, kind: "" | "err" | "ok" = "") {
    this.el.msg.textContent = text;
    this.el.msg.className = `msg ${kind}`;
  }

  private setSide(side: Side) {
    if (this.busy || side === this.side) return;
    this.side = side;
    (this.el.amount as HTMLInputElement).value = "";
    this.quote = null;
    this.paintSide();
    this.paintQuote();
  }

  private paintSide() {
    this.el.buy.setAttribute("aria-pressed", String(this.side === "buy"));
    this.el.sell.setAttribute("aria-pressed", String(this.side === "sell"));
    this.el.unit.textContent = this.side === "buy" ? this.native() : this.symbol();
    this.paintBalance();
    this.paintButton();
  }

  private paintBalance() {
    if (!this.balances) {
      this.el.balance.textContent = "";
      this.el.max.hidden = true;
      return;
    }
    const raw = this.side === "buy" ? this.balances.nativeRaw : this.balances.tokenRaw;
    this.el.balance.textContent = `Balance ${gen8FormatAmount(raw, this.inputDecimals())} ${this.side === "buy" ? this.native() : this.symbol()}`;
    this.el.max.hidden = this.side !== "sell" || raw === 0n;
  }

  private tradingOpen(): boolean {
    if (!this.token) return false;
    if (this.isImport()) return this.token.tradable !== false;
    const openAt = Number(this.token.openAt || 0);
    if (openAt > 0 && Math.floor(Date.now() / 1000) < openAt) return false;
    if (this.token.tradingOpen === false || this.token.tradable === false) return Math.floor(Date.now() / 1000) >= openAt;
    return true;
  }

  private paintOpens() {
    const node = this.el.opens;
    if (!node) return;
    if (!this.token || this.isImport() || this.tradingOpen()) {
      node.textContent = "";
      return;
    }
    const openAt = Number(this.token.openAt || 0);
    const left = Math.max(0, openAt - Math.floor(Date.now() / 1000));
    node.textContent = openAt ? `Trading opens at ${new Date(openAt * 1000).toLocaleString()}. ${left}s left.` : "Trading on this coin has not opened yet.";
    this.paintButton();
  }

  private paintButton() {
    const go = this.el.go as HTMLButtonElement;
    if (!this.token) {
      go.textContent = "LOADING...";
      go.disabled = true;
      return;
    }
    if (this.isImport() && (this.token.tradable === false || this.noRoute)) {
      go.textContent = "NOT AVAILABLE HERE";
      go.disabled = true;
      return;
    }
    if (!this.account) {
      go.textContent = this.wallet() ? "CONNECT WALLET" : "NO EVM WALLET FOUND";
      go.disabled = this.busy || !this.wallet();
      return;
    }
    if (!this.tradingOpen()) {
      go.textContent = "TRADING NOT OPEN YET";
      go.disabled = true;
      return;
    }
    go.textContent = this.busy ? "WORKING..." : `${this.side === "buy" ? "BUY" : "SELL"} ${this.symbol().toUpperCase()}`;
    go.disabled = this.busy || !this.quote;
  }

  private paintQuote() {
    if (this.isImport()) return this.paintImportQuote();
    const q = this.quote;
    const outUnit = this.side === "buy" ? this.symbol() : this.native();
    this.el.out.textContent = q ? `${gen8FormatAmount(q.amountOut)} ${outUnit}` : "-";
    this.el.min.textContent = q ? `${gen8FormatAmount(q.minAmountOut)} ${outUnit}` : "-";
    this.el.impact.textContent = q ? formatPriceImpact(q.priceImpactBps) : "-";
    this.el.minLabel.textContent = q && Number.isFinite(Number(q.slippageBps)) ? `At least (${Number(q.slippageBps) / 100}% slippage)` : "At least";
    const feeBps = q?.feeBps ?? this.token?.feeBps ?? null;
    this.el.feeLabel.textContent = feeBps ? `Fee ${Number((feeBps / 100).toFixed(2))}%` : "Fee";
    this.el.fee.textContent = q ? `${gen8FormatAmount(q.feeNativeRaw || "0")} ${this.native()}` : "-";
    const creatorRaw = q ? BigInt(q.creatorShareNativeRaw || "0") : 0n;
    this.el.creatorRow.hidden = creatorRaw === 0n;
    this.el.creator.textContent = `${gen8FormatAmount(creatorRaw)} ${this.native()}`;
    this.paintButton();
  }

  /** Import quotes: rows only for what the quote has (Kyber quotes carry no minimum or impact; a sell's fee comes off the native out). */
  private paintImportQuote() {
    const q = this.quote;
    const outUnit = this.side === "buy" ? this.symbol() : this.native();
    this.el.out.textContent = q ? `${gen8FormatAmount(q.amountOut, this.outDecimals())} ${outUnit}` : "-";
    const impactBps = q ? (q.priceImpactBps ?? (q.priceImpactPct == null ? null : Math.round(Number(q.priceImpactPct) * 100))) : null;
    this.el.impactRow.hidden = impactBps == null;
    this.el.impact.textContent = formatPriceImpact(impactBps);
    this.el.minRow.hidden = !q?.minAmountOut;
    this.el.min.textContent = q?.minAmountOut ? `${gen8FormatAmount(q.minAmountOut, this.outDecimals())} ${outUnit}` : "-";
    this.el.minLabel.textContent = q && Number.isFinite(Number(q.slippageBps)) ? `At least (${Number(q.slippageBps) / 100}% slippage)` : "At least";
    const feeBps = q?.feeBps ?? this.token?.feeBps ?? null;
    this.el.feeLabel.textContent = feeBps ? `Fee ${Number((feeBps / 100).toFixed(2))}%` : "Fee";
    this.el.fee.textContent = q?.feeNativeRaw ? `${gen8FormatAmount(q.feeNativeRaw)} ${this.native()}` : q && feeBps ? `taken from the ${this.native()} out` : "-";
    const creatorBps = Number(q?.creatorShareBps ?? this.token?.creatorShareBps ?? 0);
    const creatorRaw = q?.feeNativeRaw && creatorBps > 0 && q.feeBps ? (BigInt(q.feeNativeRaw) * BigInt(creatorBps)) / BigInt(q.feeBps) : 0n;
    this.el.creatorRow.hidden = !(creatorBps > 0);
    this.el.creator.textContent = creatorRaw > 0n ? `${gen8FormatAmount(creatorRaw)} ${this.native()}` : `${Number((creatorBps / 100).toFixed(2))}% of the swap`;
    this.paintButton();
  }

  private async loadToken() {
    const token = String(this.options.token || "").trim();
    const chainId = Number(this.options.chainId);
    if (!EVM_ADDRESS.test(token) || !Number.isInteger(chainId)) {
      this.el.title.textContent = "Swap";
      this.say("This widget needs `chainId` and the coin's `token` address.", "err");
      return;
    }
    try {
      this.token = await this.loadTokenInfo(chainId, token);
      const short = `${token.slice(0, 6)}...${token.slice(-4)}`;
      if (this.isImport() && !this.token.name && !this.token.symbol) {
        this.el.title.textContent = `Swap ${short}`;
        this.el.sub.textContent = "Unlisted coin";
      } else {
        this.el.title.textContent = this.token.symbol ? `Swap ${this.token.symbol}` : "Swap";
        this.el.sub.textContent = this.token.name || short;
      }
      if (this.token.imageUrl) {
        (this.el.logo as HTMLImageElement).src = this.token.imageUrl;
        this.el.logo.hidden = false;
      }
      (this.el.link as HTMLAnchorElement).href = this.token.pageUrl;
      if (this.isImport()) this.paintImportToken();
      this.paintSide();
      this.paintQuote();
      this.paintOpens();
    } catch (error) {
      this.say(error instanceof Error ? error.message : "Could not load this token.", "err");
    }
  }

  /**
   * What the coin is: /api/widget/swap/evm/token (kind gen8 / import / memewarzone). An API without that route (or a
   * failed answer) falls back to the gen-8 answer, which is what this box loaded before.
   */
  private async loadTokenInfo(chainId: number, token: string): Promise<TokenInfo> {
    try {
      return await this.call<TokenInfo>(`/api/widget/swap/evm/token?chainId=${chainId}&token=${token}`);
    } catch (error) {
      try {
        return { ...(await this.call<TokenInfo>(`/api/widget/swap/gen8/token?chainId=${chainId}&token=${token}`)), kind: "gen8" };
      } catch {
        throw error;
      }
    }
  }

  /** Import / not-tradable coins: route line, claim line, page link. */
  private paintImportToken() {
    const t = this.token;
    if (!t) return;
    this.el.via.textContent = t.kind !== "import" ? "" : t.chainId === 56 ? ", routed by KyberSwap" : ", routed by Uniswap";
    if (t.claimUrl) {
      (this.el.claimLink as HTMLAnchorElement).href = t.claimUrl;
      this.el.claim.hidden = false;
    } else {
      this.el.claim.hidden = true;
    }
    (this.el.pageLink as HTMLAnchorElement).href = t.pageUrl;
    const blocked = t.tradable === false || this.noRoute;
    this.el.page.hidden = !blocked;
    if (t.tradable === false) this.say(notTradableText(t.reason), "err");
    else if (this.noRoute) this.say(NO_ROUTE_TEXT, "err");
  }

  private async loadBalances() {
    if (!this.account || !this.token) return;
    try {
      const out = await this.call<{ nativeRaw: string; tokenRaw: string }>(`${this.route("balances")}?chainId=${this.token.chainId}&wallet=${this.account}&token=${this.token.token}`);
      this.balances = { nativeRaw: BigInt(out.nativeRaw), tokenRaw: BigInt(out.tokenRaw) };
    } catch {
      this.balances = null;
    }
    this.paintBalance();
  }

  private fillMax() {
    if (!this.balances) return;
    const cap = this.token?.maxSellable ? BigInt(this.token.maxSellable) : this.balances.tokenRaw;
    const raw = cap < this.balances.tokenRaw ? cap : this.balances.tokenRaw;
    const decimals = this.tokenDecimals();
    (this.el.amount as HTMLInputElement).value = fromRaw(raw, decimals, decimals).replace(/,/g, "");
    this.scheduleQuote();
  }

  private scheduleQuote() {
    if (this.timer) clearTimeout(this.timer);
    if (this.noRoute) {
      // A new amount gets a new route search; "no route" comes back with the next quote if it still holds.
      this.noRoute = false;
      this.paintImportToken();
    }
    this.quote = null;
    this.paintQuote();
    this.timer = setTimeout(() => void this.fetchQuote(), 450);
  }

  private amountRaw(): bigint | null {
    return toRaw((this.el.amount as HTMLInputElement).value, this.inputDecimals());
  }

  private async fetchQuote(): Promise<Quote | null> {
    const raw = this.amountRaw();
    if (!this.token || !raw) return null;
    if (!this.tradingOpen()) {
      this.say("Trading on this coin has not opened yet.", "err");
      return null;
    }
    if (this.side === "sell" && this.token.maxSellable && raw > BigInt(this.token.maxSellable)) {
      this.say("This sell is larger than the bonding range can take back. Sell a smaller amount.", "err");
      return null;
    }
    const seq = ++this.quoteSeq;
    if (this.isImport()) return this.fetchImportQuote(raw, seq);
    try {
      const quote = await this.call<Quote>("/api/widget/swap/gen8/quote", {
        method: "POST",
        body: JSON.stringify({ chainId: this.token.chainId, token: this.token.token, side: this.side, amountRaw: raw.toString(), ...slippageRequest(this.options) }),
      });
      if (seq !== this.quoteSeq) return null;
      this.quote = quote;
      this.say("");
      this.paintQuote();
      return quote;
    } catch (error) {
      if (seq === this.quoteSeq) this.say(error instanceof Error ? error.message : "No quote", "err");
      return null;
    }
  }

  /** Import quote through our API (= /api/imports/swap/quote): the fee is in it, the API's terms. */
  private async fetchImportQuote(raw: bigint, seq: number): Promise<Quote | null> {
    const token = this.token;
    if (!token) return null;
    try {
      const quote = await this.call<Quote>("/api/widget/swap/quote", {
        method: "POST",
        body: JSON.stringify({ chainId: token.chainId, token: token.token, side: this.side, amountRaw: raw.toString(), slippageBps: this.options.slippageBps ?? 100 }),
      });
      if (seq !== this.quoteSeq) return null;
      this.quote = quote;
      this.say("");
      this.paintQuote();
      return quote;
    } catch (error) {
      if (seq !== this.quoteSeq) return null;
      if ((error as { code?: string })?.code === "IMPORT_SWAP_NO_ROUTE") {
        this.noRoute = true;
        this.paintImportToken();
        this.paintButton();
        return null;
      }
      this.say(error instanceof Error ? error.message : "No quote", "err");
      return null;
    }
  }

  private async ensureChain(wallet: Eip1193) {
    await ensureWalletChain(wallet, Number(this.token?.chainId));
  }

  private async onGo() {
    if (this.busy) return;
    const wallet = this.wallet();
    if (!wallet) return;
    if (!this.account) {
      try {
        const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
        const first = String(accounts?.[0] || "");
        if (!EVM_ADDRESS.test(first)) throw new Error("The wallet did not share an address.");
        this.account = first;
        this.paintButton();
        this.paintRpcOffer();
        await this.loadBalances();
      } catch (error) {
        this.say(error instanceof Error ? error.message : "Wallet connection failed.", "err");
      }
      return;
    }
    await this.swap(wallet);
  }

  private async send(wallet: Eip1193, tx: { to: string; data: string; value: string }): Promise<string> {
    const hash = String(await wallet.request({ method: "eth_sendTransaction", params: [{ from: this.account, to: tx.to, data: tx.data, value: hexValue(tx.value || "0") }] }));
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The wallet returned no transaction hash.");
    this.say("Waiting for confirmation");
    await this.waitFor(hash);
    return hash;
  }

  private async swap(wallet: Eip1193) {
    if (!this.token || !this.account) return;
    const raw = this.amountRaw();
    if (!raw) {
      this.say("Enter an amount.", "err");
      return;
    }
    if (!this.tradingOpen()) {
      this.say("Trading on this coin has not opened yet.", "err");
      return;
    }
    const reserve = GAS_RESERVE[this.token.chainId] ?? 0n;
    if (this.balances && (this.side === "buy" ? raw + reserve > this.balances.nativeRaw : raw > this.balances.tokenRaw)) {
      this.say(this.side === "buy" ? `Keep about ${gen8FormatAmount(reserve)} ${this.native()} for gas: lower the amount.` : "Amount is above your balance.", "err");
      return;
    }
    if (this.isImport()) {
      await this.swapImport(wallet, raw);
      return;
    }
    this.busy = true;
    this.paintButton();
    try {
      await this.ensureChain(wallet);
      const body = { chainId: this.token.chainId, token: this.token.token, side: this.side, wallet: this.account, amountRaw: raw.toString(), ...slippageRequest(this.options), ...(this.options.partner ? { partner: this.options.partner } : {}) };
      this.say("Getting the latest price...");
      let built = await this.call<Built | NeedsAllowance>("/api/widget/swap/gen8/build", { method: "POST", body: JSON.stringify(body) });
      let stepIndex = 1;
      let stepTotal = 1;
      if ((built as NeedsAllowance).needsAllowance) {
        const step = built as NeedsAllowance;
        const approvals = (step.approval ? 1 : 0) + (step.permit2Approval ? 1 : 0);
        stepTotal = approvals + 1;
        const note = step.approval && step.permit2Approval ? "The first sell of a coin needs two one-time approvals. " : "";
        if (step.approval) {
          this.say(`${note}Step ${stepIndex} of ${stepTotal}: approve the coin (one time)`);
          await this.send(wallet, step.approval);
          stepIndex += 1;
        }
        if (step.permit2Approval) {
          this.say(`Step ${stepIndex} of ${stepTotal}: allow the Uniswap router (one time)`);
          await this.send(wallet, step.permit2Approval);
          stepIndex += 1;
        }
        built = await this.call<Built | NeedsAllowance>("/api/widget/swap/gen8/build", { method: "POST", body: JSON.stringify(body) });
        if ((built as NeedsAllowance).needsAllowance) throw new Error("The allowance is not visible yet. Try the sell again.");
      }
      const tx = built as Built;
      this.say(`Step ${stepIndex} of ${stepTotal}: ${this.side === "buy" ? "buy" : "sell"}`);
      const hash = await this.send(wallet, tx);
      this.say(`Swap confirmed (${hash.slice(0, 10)}...).`, "ok");
      (this.el.amount as HTMLInputElement).value = "";
      this.quote = null;
      this.paintQuote();
      this.options.onSwap?.({ txHash: hash, side: this.side, token: this.token.token, chainId: this.token.chainId });
      void this.loadToken();
      void this.loadBalances();
    } catch (error) {
      const text = error instanceof Error ? error.message : String((error as { message?: string })?.message || "Swap failed.");
      this.say(/user rejected|denied/i.test(text) ? "You rejected the request in your wallet." : text, "err");
    } finally {
      this.busy = false;
      this.paintButton();
    }
  }

  /**
   * An import swap: a fresh quote, our API's build (partner fingerprint recorded there), a sell's one-time approvals
   * when the API asks for them (BNB: this sell's amount to the Kyber router; Robinhood: Permit2, then the router), a
   * new quote and build, a check of the build's router and value, then the wallet sends it.
   */
  private async swapImport(wallet: Eip1193, raw: bigint) {
    const token = this.token;
    if (!token || !this.account) return;
    this.busy = true;
    this.paintButton();
    try {
      await this.ensureChain(wallet);
      this.say("Getting the latest price...");
      const build = async (): Promise<Built | NeedsAllowance | null> => {
        const quote = await this.fetchQuote();
        if (!quote) return null;
        const body = { chainId: token.chainId, token: token.token, side: this.side, wallet: this.account, amountRaw: raw.toString(), quote: quote.quote ?? null, slippageBps: this.options.slippageBps ?? 100, ...(this.options.partner ? { partner: this.options.partner } : {}) };
        return this.call<Built | NeedsAllowance>("/api/widget/swap/build", { method: "POST", body: JSON.stringify(body) });
      };
      let built = await build();
      if (!built) return;
      let stepIndex = 1;
      let stepTotal = 1;
      if ((built as NeedsAllowance).needsAllowance) {
        const step = built as NeedsAllowance;
        stepTotal = (step.approval ? 1 : 0) + (step.permit2Approval ? 1 : 0) + 1;
        const note = step.approval && step.permit2Approval ? "The first sell of a coin needs two one-time approvals. " : "";
        if (step.approval) {
          this.say(`${note}Step ${stepIndex} of ${stepTotal}: ${token.chainId === 56 ? "approve this sell's amount" : "approve the coin (one time)"}`);
          await this.send(wallet, step.approval);
          stepIndex += 1;
        }
        if (step.permit2Approval) {
          this.say(`Step ${stepIndex} of ${stepTotal}: allow the Uniswap router (one time)`);
          await this.send(wallet, step.permit2Approval);
          stepIndex += 1;
        }
        built = await build();
        if (!built) return;
        if ((built as NeedsAllowance).needsAllowance) throw new Error("The allowance is not visible yet. Try the sell again.");
      }
      const tx = built as Built;
      assertImportBuild(tx, token.chainId, this.side, raw);
      this.say(`Step ${stepIndex} of ${stepTotal}: ${this.side === "buy" ? "buy" : "sell"}`);
      const hash = await this.send(wallet, tx);
      this.say(`Swap confirmed (${hash.slice(0, 10)}...).`, "ok");
      (this.el.amount as HTMLInputElement).value = "";
      this.quote = null;
      this.paintQuote();
      this.options.onSwap?.({ txHash: hash, side: this.side, token: token.token, chainId: token.chainId });
      void this.loadBalances();
    } catch (error) {
      const text = error instanceof Error ? error.message : String((error as { message?: string })?.message || "Swap failed.");
      this.say(/user rejected|denied/i.test(text) ? "You rejected the request in your wallet." : text, "err");
    } finally {
      this.busy = false;
      this.paintButton();
    }
  }

  private async waitFor(hash: string) {
    let status: { status?: string } | null;
    try {
      status = await pollGen8Receipt(
        (signal: AbortSignal) => this.call<{ status: string }>(`${this.route("status")}?chainId=${this.token?.chainId}&txHash=${hash}`, { signal }).catch(() => null),
        {
          timeoutMs: 120_000,
          intervalMs: 250,
          isDone: (row: { status?: string } | null) => row?.status === "success" || row?.status === "failed",
        },
      );
    } catch (error) {
      if ((error as { code?: string })?.code === "GEN8_RECEIPT_TIMEOUT") {
        throw new Error(`Not confirmed yet. Check ${hash.slice(0, 10)}... in your wallet.`);
      }
      throw error;
    }
    if (status?.status === "failed") throw new Error("The transaction failed on chain.");
  }
}

/**
 * The swap widget for MemeWarzone generation 8 coins on BNB Chain and Robinhood Chain:
 *
 *   MemeWarzoneSwap.mount("#mwz-swap", { chainId: 56, token: "0x...", partner: "crypticpump" });
 *
 * Every swap is built by our API (/api/widget/swap/gen8/*, frontend/api/gen8Swap.js): a UniversalRouter V4_SWAP in
 * the coin's own Uniswap V4 pool, so a partner's builds carry the partner fingerprint the API records. The fee is the
 * pool's own (2% before graduation, 1% after, half of it to the coin's creator), taken on chain. The widget talks to
 * the page's EVM wallet through EIP-1193 only (no ethers, no RPC of its own): eth_requestAccounts,
 * wallet_switchEthereumChain, and eth_sendTransaction. The first sell of a coin approves Permit2 and sets one
 * allowance for our router. Every later sell is only the swap.
 */
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

type TokenInfo = {
  chainId: number;
  token: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  nativeSymbol: string;
  phase: string;
  feeBps: number;
  pageUrl: string;
  tradable?: boolean;
  tradingOpen?: boolean;
  openAt?: number;
  maxSellable?: string | null;
};
type Quote = { amountIn: string; amountOut: string; minAmountOut: string; slippageBps: number; slippageAuto?: boolean; priceImpactBps?: number | null; feeBps: number; feeNativeRaw: string; creatorShareNativeRaw: string; phase: string };
type Built = { to: string; data: string; value: string; quote: Quote };
type TxStep = { to: string; data: string; value: string };
type NeedsAllowance = { needsAllowance: true; approval: TxStep | null; permit2Approval: TxStep | null; quote: Quote };
type PermitTypedData = { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };

const DEFAULT_API = "https://api.memewar.zone";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
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

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.api}${path}`, { ...init, credentials: "omit", headers: { "content-type": "application/json", ...(init?.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(String(body?.error || `Request failed (${response.status})`));
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
        <div class="row"><span>Price impact</span><b data-k="impact">-</b></div>
        <div class="row"><span data-k="minLabel">At least</span><b data-k="min">-</b></div>
        <div class="row"><span data-k="feeLabel">Fee</span><b data-k="fee">-</b></div>
        <div class="row" data-k="creatorRow" hidden><span>Of which to the coin's creator</span><b data-k="creator">-</b></div>
        <button type="button" class="go" data-k="go">CONNECT WALLET</button>
        <div class="rpc" data-k="rpcRow" hidden>
          <span>Trades on BNB Chain sent through a public RPC can be front-run. Add a private RPC to your wallet so it sends them without the public mempool.</span>
          <span class="rpc-actions"><button type="button" class="rpc-add" data-k="rpcAdd">ADD PROTECTED BSC RPC</button><button type="button" class="rpc-later" data-k="rpcLater">NOT NOW</button></span>
        </div>
        <div class="msg" data-k="opens" role="status"></div>
        <div class="msg" data-k="msg" role="status"></div>
        <div class="foot">Swaps by <a data-k="link" href="https://app.memewar.zone" target="_blank" rel="noopener">MemeWarzone</a>, in the coin's Uniswap pool</div>
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
    this.el.balance.textContent = `Balance ${fromRaw(raw, 18, 4)} ${this.side === "buy" ? this.native() : this.symbol()}`;
    this.el.max.hidden = this.side !== "sell" || raw === 0n;
  }

  private tradingOpen(): boolean {
    if (!this.token) return false;
    const openAt = Number(this.token.openAt || 0);
    if (openAt > 0 && Math.floor(Date.now() / 1000) < openAt) return false;
    if (this.token.tradingOpen === false || this.token.tradable === false) return Math.floor(Date.now() / 1000) >= openAt;
    return true;
  }

  private paintOpens() {
    const node = this.el.opens;
    if (!node) return;
    if (!this.token || this.tradingOpen()) {
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
    const q = this.quote;
    const outUnit = this.side === "buy" ? this.symbol() : this.native();
    this.el.out.textContent = q ? `${fromRaw(q.amountOut, 18)} ${outUnit}` : "-";
    this.el.min.textContent = q ? `${fromRaw(q.minAmountOut, 18)} ${outUnit}` : "-";
    this.el.impact.textContent = q ? formatPriceImpact(q.priceImpactBps) : "-";
    this.el.minLabel.textContent = q && Number.isFinite(Number(q.slippageBps)) ? `At least (${Number(q.slippageBps) / 100}% slippage)` : "At least";
    const feeBps = q?.feeBps ?? this.token?.feeBps ?? null;
    this.el.feeLabel.textContent = feeBps ? `Fee ${Number((feeBps / 100).toFixed(2))}%` : "Fee";
    this.el.fee.textContent = q ? `${fromRaw(q.feeNativeRaw, 18, 8)} ${this.native()}` : "-";
    const creatorRaw = q ? BigInt(q.creatorShareNativeRaw || "0") : 0n;
    this.el.creatorRow.hidden = creatorRaw === 0n;
    this.el.creator.textContent = `${fromRaw(creatorRaw, 18, 8)} ${this.native()}`;
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
      this.token = await this.call<TokenInfo>(`/api/widget/swap/gen8/token?chainId=${chainId}&token=${token}`);
      this.el.title.textContent = this.token.symbol ? `Swap ${this.token.symbol}` : "Swap";
      this.el.sub.textContent = this.token.name || `${token.slice(0, 6)}...${token.slice(-4)}`;
      if (this.token.imageUrl) {
        (this.el.logo as HTMLImageElement).src = this.token.imageUrl;
        this.el.logo.hidden = false;
      }
      (this.el.link as HTMLAnchorElement).href = this.token.pageUrl;
      this.paintSide();
      this.paintQuote();
      this.paintOpens();
    } catch (error) {
      this.say(error instanceof Error ? error.message : "Could not load this token.", "err");
    }
  }

  private async loadBalances() {
    if (!this.account || !this.token) return;
    try {
      const out = await this.call<{ nativeRaw: string; tokenRaw: string }>(`/api/widget/swap/gen8/balances?chainId=${this.token.chainId}&wallet=${this.account}&token=${this.token.token}`);
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
    (this.el.amount as HTMLInputElement).value = fromRaw(raw, 18, 18).replace(/,/g, "");
    this.scheduleQuote();
  }

  private scheduleQuote() {
    if (this.timer) clearTimeout(this.timer);
    this.quote = null;
    this.paintQuote();
    this.timer = setTimeout(() => void this.fetchQuote(), 450);
  }

  private amountRaw(): bigint | null {
    return toRaw((this.el.amount as HTMLInputElement).value, 18);
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

  private async ensureChain(wallet: Eip1193) {
    const want = Number(this.token?.chainId);
    const current = Number(BigInt(String(await wallet.request({ method: "eth_chainId" }))));
    if (current === want) return;
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexValue(BigInt(want)) }] });
    const after = Number(BigInt(String(await wallet.request({ method: "eth_chainId" }))));
    if (after !== want) throw new Error("Switch your wallet to this coin's chain and try again.");
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
      this.say(this.side === "buy" ? `Keep about ${fromRaw(reserve, 18)} ${this.native()} for gas: lower the amount.` : "Amount is above your balance.", "err");
      return;
    }
    this.busy = true;
    this.paintButton();
    try {
      await this.ensureChain(wallet);
      const body = { chainId: this.token.chainId, token: this.token.token, side: this.side, wallet: this.account, amountRaw: raw.toString(), ...slippageRequest(this.options), ...(this.options.partner ? { partner: this.options.partner } : {}) };
      this.say("Getting the latest price...");
      let built = await this.call<Built | NeedsAllowance>("/api/widget/swap/gen8/build", { method: "POST", body: JSON.stringify(body) });
      if ((built as NeedsAllowance).needsAllowance) {
        const step = built as NeedsAllowance;
        if (step.approval) {
          this.say("Approve this coin once in your wallet...");
          await this.send(wallet, step.approval);
        }
        if (step.permit2Approval) {
          this.say("Allow the router once in your wallet...");
          await this.send(wallet, step.permit2Approval);
        }
        built = await this.call<Built | NeedsAllowance>("/api/widget/swap/gen8/build", { method: "POST", body: JSON.stringify(body) });
        if ((built as NeedsAllowance).needsAllowance) throw new Error("The allowance is not visible yet. Try the sell again.");
      }
      const tx = built as Built;
      this.say("Confirm the swap in your wallet...");
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

  private async waitFor(hash: string) {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const status = await this.call<{ status: string }>(`/api/widget/swap/gen8/status?chainId=${this.token?.chainId}&txHash=${hash}`).catch(() => null);
      if (status?.status === "failed") throw new Error("The transaction failed on chain.");
      if (status?.status === "success") return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(`Not confirmed yet. Check ${hash.slice(0, 10)}... in your wallet.`);
  }
}

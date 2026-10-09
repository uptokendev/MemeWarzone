/**
 * MemeWarzone swap widget: a Solana swap box any website can embed for a coin.
 *
 *   <script src="https://app.memewar.zone/widget/mwz-swap.js"></script>
 *   <div id="mwz-swap"></div>
 *   <script>MemeWarzoneSwap.mount("#mwz-swap", { mint: "<token mint>" });</script>
 *
 * Swaps go through our API (api/importSwapWidget.js -> api/importSwap.js): Jupiter routing, 1% fee,
 * half of it to the coin's creator (paid by MemeWarzone once they claim the coin on memewar.zone).
 * The API enforces the fee; this script checks the built transaction before the wallet signs it
 * (src/lib/jupiterSwapGuard.ts, the same check the app runs). It uses the page's own Solana wallet
 * (Phantom, Solflare, Backpack) or one the host passes in, and needs no RPC: balances and
 * confirmation come from our API. Everything renders in a shadow root.
 */
import { VersionedTransaction } from "@solana/web3.js";

import { assertJupiterSwapForWallet } from "../lib/jupiterSwapGuard";
import type { BondingKind, BondingQuote } from "./bonding";

/** The bonding part (mwz-swap-bonding.js) sits next to this script and loads only for bonding coins. */
type BondingApi = {
  quoteBonding: (input: { kind: BondingKind; campaignAddress: string; side: Side; amountIn: bigint }) => Promise<BondingQuote>;
  tradeBonding: (input: { kind: BondingKind; campaignAddress: string; creator: string | null; side: Side; amountIn: bigint; trader: string }) => Promise<string>;
  setWidgetApiBase: (base: string) => void;
  setWidgetSolanaProvider: (provider: never) => void;
};
const SCRIPT_DIR = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src || "";
    return src ? src.slice(0, src.lastIndexOf("/")) : "https://app.memewar.zone/widget";
  } catch {
    return "https://app.memewar.zone/widget";
  }
})();
let bondingPromise: Promise<BondingApi> | null = null;
function loadBonding(apiBase: string): Promise<BondingApi> {
  if (!bondingPromise) {
    bondingPromise = new Promise<BondingApi>((resolve, reject) => {
      const ready = () => {
        const api = (globalThis as any).__MemeWarzoneSwapBonding as BondingApi | undefined;
        if (api) { api.setWidgetApiBase(apiBase); resolve(api); } else reject(new Error("Could not load the trading module."));
      };
      if ((globalThis as any).__MemeWarzoneSwapBonding) return ready();
      const script = document.createElement("script");
      script.src = `${SCRIPT_DIR}/mwz-swap-bonding.js`;
      script.async = true;
      script.onload = ready;
      script.onerror = () => { bondingPromise = null; reject(new Error("Could not load the trading module.")); };
      document.head.appendChild(script);
    });
  }
  return bondingPromise;
}

type Side = "buy" | "sell";

/** The wallet the widget talks to: injected providers have this shape; a host can pass its own. */
export type WidgetWallet = {
  publicKey?: { toString(): string } | null;
  connect?: () => Promise<unknown>;
  signAndSendTransaction: (tx: VersionedTransaction) => Promise<{ signature: string } | string>;
  /** Needed for bonding coins (the app's launchpad and DBC trades sign, then send themselves). */
  signTransaction?: (tx: never) => Promise<unknown>;
};

export type MountOptions = {
  mint: string;
  side?: Side;
  apiBase?: string;
  slippageBps?: number;
  theme?: "dark" | "light";
  wallet?: WidgetWallet;
  /** Swap-widget partner id (for example "crypticpump"): imported-coin fees go to that partner's fee account and split creator / partner / MemeWarzone. */
  partner?: string;
  onSwap?: (event: { signature: string; side: Side; mint: string }) => void;
};

type TokenInfo = {
  mint: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  feeBps?: number;
  pageUrl: string;
  kind: "import" | BondingKind;
  /** Unclaimed imported coin: its MemeWarzone page with the claim dialog open. */
  claimUrl?: string | null;
  tradable: boolean;
  reason?: string | null;
  campaignAddress?: string;
  creator?: string | null;
};
/** Bonding coins: a fee reserve stays in the wallet on buys, as on the token page. */
const SOLANA_BUY_FEE_RESERVE_LAMPORTS = 5_000_000n;
type Quote = { amountIn: string; amountOut: string; minAmountOut: string | null; feeBps: number; feeNativeRaw: string | null; creatorShareBps?: number; priceImpactPct: number | null; quote: unknown };

const DEFAULT_API = "https://api.memewar.zone";
const SOL_DECIMALS = 9;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------- amounts (no floats for money)

export function toRaw(text: string, decimals: number): bigint | null {
  const value = String(text || "").trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(value) || value === "" || value === ".") return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return raw > 0n ? raw : null;
}

export function fromRaw(raw: string | bigint, decimals: number, maxFraction = 6): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  let frac = (value % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (!frac && whole === 0n && value > 0n) return `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------- wallet

type Injected = WidgetWallet & { isPhantom?: boolean; isSolflare?: boolean; isBackpack?: boolean };

export function findInjectedWallet(scope: Record<string, any> = globalThis as any): { name: string; wallet: Injected } | null {
  const candidates: Array<[string, any]> = [
    ["Phantom", scope.phantom?.solana],
    ["Solflare", scope.solflare],
    ["Backpack", scope.backpack?.solana ?? scope.backpack],
    ["Solana wallet", scope.solana],
  ];
  for (const [name, wallet] of candidates) {
    if (wallet && typeof wallet.signAndSendTransaction === "function") return { name, wallet };
  }
  return null;
}

function signatureOf(result: { signature: string } | string): string {
  const signature = typeof result === "string" ? result : String(result?.signature || "");
  if (!signature) throw new Error("The wallet returned no signature.");
  return signature;
}

// ---------------------------------------------------------------- styles

const STYLE = `
:host { all: initial; display: block; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.box { --bg:#0e1114; --panel:#161b20; --line:#2e353d; --text:#f2f4f5; --muted:#8a949e; --accent:#ff7a1a; --accent-text:#140a02; --up:#2ecc71; --down:#ff5c5c;
  box-sizing:border-box; max-width:420px; width:100%; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:14px; padding:16px; }
.box.light { --bg:#ffffff; --panel:#f4f5f7; --line:#dfe3e8; --text:#14181c; --muted:#5c6670; }
.box * { box-sizing:border-box; }
.box [hidden] { display:none !important; }
.head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
.head img { width:32px; height:32px; border-radius:50%; object-fit:cover; background:var(--panel); }
.title { font-weight:700; font-size:15px; }
.sub { color:var(--muted); font-size:12px; }
.tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:12px; }
.tabs button { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:10px; padding:8px; font-weight:700; cursor:pointer; font-size:13px; }
.tabs button[aria-pressed="true"].buy { background:var(--up); color:#06210f; border-color:var(--up); }
.tabs button[aria-pressed="true"].sell { background:var(--down); color:#2a0606; border-color:var(--down); }
.field { position:relative; }
.field input { width:100%; height:48px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--text); font-size:18px; padding:0 84px 0 12px; outline:none; font-family:ui-monospace, Menlo, monospace; }
.field input:focus { border-color:var(--accent); }
.unit { position:absolute; right:12px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:13px; pointer-events:none; }
.row { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-top:8px; }
.row b { color:var(--text); font-weight:600; font-family:ui-monospace, Menlo, monospace; }
.max { background:none; border:none; color:var(--accent); cursor:pointer; font-size:12px; padding:0; }
.go { margin-top:14px; width:100%; height:46px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); font-weight:800; font-size:14px; cursor:pointer; }
.go:disabled { opacity:.55; cursor:not-allowed; }
.msg { margin-top:10px; font-size:12px; min-height:16px; }
.msg.err { color:var(--down); } .msg.ok { color:var(--up); }
.foot { margin-top:12px; font-size:11px; color:var(--muted); text-align:center; }
.foot a { color:var(--muted); }
.claim { margin-top:8px; font-size:12px; text-align:center; color:var(--muted); }
.claim a { color:var(--accent); font-weight:600; }
`;

// ---------------------------------------------------------------- widget

class SwapWidget {
  private root: ShadowRoot;
  private api: string;
  private side: Side;
  private token: TokenInfo | null = null;
  private quote: Quote | null = null;
  private account: string | null = null;
  private balances: { lamports: bigint; tokenRaw: bigint } | null = null;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quoteSeq = 0;
  private el: Record<string, HTMLElement> = {};

  constructor(host: HTMLElement, private options: MountOptions) {
    this.root = host.shadowRoot || host.attachShadow({ mode: "open" });
    this.api = String(options.apiBase || DEFAULT_API).replace(/\/+$/, "");
    this.side = options.side === "sell" ? "sell" : "buy";
    this.render();
    void this.loadToken();
  }

  private wallet(): { name: string; wallet: WidgetWallet } | null {
    if (this.options.wallet) return { name: "Wallet", wallet: this.options.wallet };
    return findInjectedWallet();
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
        <div class="row"><span data-k="feeLabel">Fee</span><b data-k="fee">-</b></div>
        <div class="row" data-k="creatorRow" hidden><span>Of which to the coin's creator</span><b data-k="creator">-</b></div>
        <button type="button" class="go" data-k="go">CONNECT WALLET</button>
        <div class="msg" data-k="msg" role="status"></div>
        <div class="claim" data-k="claim" hidden>Created this coin? <a data-k="claimLink" target="_blank" rel="noopener">Claim it on MemeWarzone</a></div>
        <div class="foot">Swaps by <a data-k="link" href="https://app.memewar.zone" target="_blank" rel="noopener">MemeWarzone</a><span data-k="via">, routed by Jupiter</span></div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>("[data-k]").forEach((node) => { this.el[node.dataset.k as string] = node; });
    this.el.buy.addEventListener("click", () => this.setSide("buy"));
    this.el.sell.addEventListener("click", () => this.setSide("sell"));
    this.el.amount.addEventListener("input", () => this.scheduleQuote());
    this.el.max.addEventListener("click", () => this.fillMax());
    this.el.go.addEventListener("click", () => void this.onGo());
    this.paintSide();
  }

  private say(text: string, kind: "" | "err" | "ok" = "") {
    this.el.msg.textContent = text;
    this.el.msg.className = `msg ${kind}`;
  }

  private symbol() {
    return this.token?.symbol || "token";
  }

  private inputDecimals() {
    return this.side === "buy" ? SOL_DECIMALS : (this.token?.decimals ?? 6);
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
    this.el.unit.textContent = this.side === "buy" ? "SOL" : this.symbol();
    this.paintBalance();
    this.paintButton();
  }

  private paintBalance() {
    if (!this.balances || !this.token) {
      this.el.balance.textContent = "";
      this.el.max.hidden = true;
      return;
    }
    const raw = this.side === "buy" ? this.balances.lamports : this.balances.tokenRaw;
    this.el.balance.textContent = `Balance ${fromRaw(raw, this.inputDecimals(), 4)} ${this.side === "buy" ? "SOL" : this.symbol()}`;
    this.el.max.hidden = this.side !== "sell" || raw === 0n;
  }

  private paintButton() {
    const go = this.el.go as HTMLButtonElement;
    if (!this.token) { go.textContent = "LOADING..."; go.disabled = true; return; }
    if (!this.token.tradable) { go.textContent = "NOT AVAILABLE HERE"; go.disabled = true; return; }
    if (!this.account) { go.textContent = this.wallet() ? "CONNECT WALLET" : "NO SOLANA WALLET FOUND"; go.disabled = this.busy || !this.wallet(); return; }
    go.textContent = this.busy ? "WORKING..." : `${this.side === "buy" ? "BUY" : "SELL"} ${this.symbol().toUpperCase()}`;
    go.disabled = this.busy || !this.quote;
  }

  private paintQuote() {
    const q = this.quote;
    const outDecimals = this.side === "buy" ? (this.token?.decimals ?? 6) : SOL_DECIMALS;
    this.el.out.textContent = q ? `${fromRaw(q.amountOut, outDecimals)} ${this.side === "buy" ? this.symbol() : "SOL"}` : "-";
    const feeBps = q?.feeBps ?? this.token?.feeBps ?? null;
    this.el.feeLabel.textContent = feeBps ? `Fee ${Number((feeBps / 100).toFixed(2))}%` : "Fee";
    this.el.fee.textContent = q?.feeNativeRaw ? `${fromRaw(q.feeNativeRaw, SOL_DECIMALS)} SOL` : feeBps ? "-" : this.token && this.token.kind !== "import" ? "as on MemeWarzone" : "-";
    const creatorRaw = q?.feeNativeRaw && q.creatorShareBps && q.feeBps ? (BigInt(q.feeNativeRaw) * BigInt(q.creatorShareBps)) / BigInt(q.feeBps) : 0n;
    this.el.creatorRow.hidden = creatorRaw === 0n;
    this.el.creator.textContent = `${fromRaw(creatorRaw, SOL_DECIMALS)} SOL`;
    this.paintButton();
  }

  private async loadToken() {
    const mint = String(this.options.mint || "").trim();
    if (!BASE58.test(mint)) {
      this.el.title.textContent = "Swap";
      this.say("This widget needs a Solana token mint (mount option `mint`).", "err");
      return;
    }
    try {
      const token = await this.call<TokenInfo>(`/api/widget/swap/token?mint=${encodeURIComponent(mint)}`);
      // An API from before bonding support answers without kind / tradable: those coins are imports.
      this.token = { ...token, kind: token.kind || "import", tradable: token.tradable !== false };
      this.el.title.textContent = this.token.symbol ? `Swap ${this.token.symbol}` : "Swap";
      this.el.sub.textContent = this.token.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
      if (this.token.imageUrl) { (this.el.logo as HTMLImageElement).src = this.token.imageUrl; this.el.logo.hidden = false; }
      (this.el.link as HTMLAnchorElement).href = this.token.pageUrl;
      this.el.via.textContent = this.token.kind === "import" ? ", routed by Jupiter" : ", on its bonding curve";
      if (this.token.kind === "import" && this.token.claimUrl) {
        (this.el.claimLink as HTMLAnchorElement).href = this.token.claimUrl;
        this.el.claim.hidden = false;
      }
      if (!this.token.tradable) {
        this.say(this.token.reason === "quote"
          ? "This coin's curve is not paired with SOL. Trade it on its MemeWarzone page."
          : "This coin has left its bonding curve. Trade it on its MemeWarzone page.", "err");
      }
      this.paintSide();
      this.paintQuote();
    } catch (error) {
      this.say(error instanceof Error ? error.message : "Could not load this token.", "err");
    }
  }

  private async loadBalances() {
    if (!this.account || !this.token) return;
    try {
      const out = await this.call<{ lamports: string; tokenRaw: string }>(`/api/widget/swap/balances?wallet=${this.account}&mint=${this.token.mint}`);
      this.balances = { lamports: BigInt(out.lamports), tokenRaw: BigInt(out.tokenRaw) };
    } catch {
      this.balances = null;
    }
    this.paintBalance();
  }

  private fillMax() {
    if (!this.balances) return;
    (this.el.amount as HTMLInputElement).value = fromRaw(this.balances.tokenRaw, this.inputDecimals(), this.inputDecimals()).replace(/,/g, "");
    this.scheduleQuote();
  }

  private scheduleQuote() {
    if (this.timer) clearTimeout(this.timer);
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
    const seq = ++this.quoteSeq;
    if (this.token.kind !== "import") return this.fetchBondingQuote(raw, seq);
    try {
      const quote = await this.call<Quote>("/api/widget/swap/quote", {
        method: "POST",
        body: JSON.stringify({ chainId: 101, token: this.token.mint, side: this.side, amountRaw: raw.toString(), slippageBps: this.options.slippageBps ?? 100 }),
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

  /** Bonding coins: quoted from chain with the app's own curve maths (no API call). */
  private async fetchBondingQuote(raw: bigint, seq: number): Promise<Quote | null> {
    const token = this.token;
    if (!token || token.kind === "import" || !token.campaignAddress || !token.tradable) return null;
    try {
      const bonding = await loadBonding(this.api);
      const q = await bonding.quoteBonding({ kind: token.kind, campaignAddress: token.campaignAddress, side: this.side, amountIn: raw });
      if (seq !== this.quoteSeq) return null;
      const quote: Quote = {
        amountIn: q.amountInUsed.toString(),
        amountOut: q.amountOut.toString(),
        minAmountOut: null,
        feeBps: q.feeBps ?? 0,
        feeNativeRaw: q.feeBps && this.side === "buy" ? ((q.amountInUsed * BigInt(q.feeBps)) / 10_000n).toString() : null,
        creatorShareBps: 0,
        priceImpactPct: null,
        quote: null,
      };
      this.quote = quote;
      this.say(q.note || "");
      this.paintQuote();
      return quote;
    } catch (error) {
      if (seq === this.quoteSeq) this.say(error instanceof Error ? error.message : "No quote", "err");
      return null;
    }
  }

  private async onGo() {
    if (this.busy) return;
    const found = this.wallet();
    if (!found) return;
    if (!this.account) {
      try {
        if (found.wallet.connect) await found.wallet.connect();
        const key = found.wallet.publicKey?.toString() || "";
        if (!BASE58.test(key)) throw new Error("The wallet did not share an address.");
        this.account = key;
        this.paintButton();
        await this.loadBalances();
      } catch (error) {
        this.say(error instanceof Error ? error.message : "Wallet connection failed.", "err");
      }
      return;
    }
    await this.swap(found.wallet);
  }

  private async swap(wallet: WidgetWallet) {
    if (!this.token || !this.account) return;
    const raw = this.amountRaw();
    if (!raw) { this.say("Enter an amount.", "err"); return; }
    const balance = this.side === "buy" ? this.balances?.lamports : this.balances?.tokenRaw;
    if (balance != null && raw > balance) { this.say("Amount is above your balance.", "err"); return; }
    if (this.token.kind !== "import") {
      await this.swapBonding(wallet, raw);
      return;
    }
    this.busy = true;
    this.paintButton();
    try {
      this.say("Getting the latest price...");
      const quote = await this.fetchQuote();
      if (!quote) throw new Error("No quote for this amount.");
      const built = await this.call<{ transactionBase64: string; feeAccount: string }>("/api/widget/swap/build", {
        method: "POST",
        body: JSON.stringify({ chainId: 101, token: this.token.mint, side: this.side, wallet: this.account, quote: quote.quote, slippageBps: this.options.slippageBps ?? 100, ...(this.options.partner ? { partner: this.options.partner } : {}) }),
      });
      const tx = VersionedTransaction.deserialize(decodeBase64(built.transactionBase64));
      assertJupiterSwapForWallet(tx, this.account, built.feeAccount);
      this.say("Confirm the swap in your wallet...");
      const signature = signatureOf(await wallet.signAndSendTransaction(tx));
      this.say("Swap sent, waiting for confirmation...");
      await this.waitFor(signature);
      this.say(`Swap confirmed (${signature.slice(0, 8)}...).`, "ok");
      (this.el.amount as HTMLInputElement).value = "";
      this.quote = null;
      this.paintQuote();
      this.options.onSwap?.({ signature, side: this.side, mint: this.token.mint });
      void this.loadBalances();
    } catch (error) {
      this.say(error instanceof Error ? error.message : "Swap failed.", "err");
    } finally {
      this.busy = false;
      this.paintButton();
    }
  }

  /** Bonding coins: the app's own trade code builds, signs (signTransaction) and sends the transaction. */
  private async swapBonding(wallet: WidgetWallet, raw: bigint) {
    const token = this.token;
    if (!token || token.kind === "import" || !token.campaignAddress || !this.account) return;
    if (!token.tradable) return;
    if (typeof wallet.signTransaction !== "function") { this.say("This wallet cannot sign this trade.", "err"); return; }
    if (this.side === "buy" && this.balances && raw + SOLANA_BUY_FEE_RESERVE_LAMPORTS > this.balances.lamports) {
      this.say("Keep about 0.005 SOL for network fees: lower the amount.", "err");
      return;
    }
    this.busy = true;
    this.paintButton();
    try {
      const bonding = await loadBonding(this.api);
      bonding.setWidgetSolanaProvider(wallet as never);
      this.say("Confirm the trade in your wallet...");
      const signature = await bonding.tradeBonding({ kind: token.kind, campaignAddress: token.campaignAddress, creator: token.creator ?? null, side: this.side, amountIn: raw, trader: this.account });
      this.say(`Trade confirmed (${signature.slice(0, 8)}...).`, "ok");
      (this.el.amount as HTMLInputElement).value = "";
      this.quote = null;
      this.paintQuote();
      this.options.onSwap?.({ signature, side: this.side, mint: token.mint });
      void this.loadBalances();
    } catch (error) {
      this.say(error instanceof Error ? error.message : "Trade failed.", "err");
    } finally {
      this.busy = false;
      this.paintButton();
    }
  }

  private async waitFor(signature: string) {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const status = await this.call<{ confirmation: string | null; err: unknown }>(`/api/widget/swap/status?signature=${signature}`).catch(() => null);
      if (status?.err) throw new Error("The swap failed on chain.");
      if (status?.confirmation === "confirmed" || status?.confirmation === "finalized") return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(`Not confirmed yet. Check ${signature.slice(0, 8)}... in your wallet.`);
  }
}

export function mount(target: string | HTMLElement, options: MountOptions) {
  const host = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`MemeWarzoneSwap: no element matches ${String(target)}`);
  const widget = new SwapWidget(host, options);
  return { widget };
}

(globalThis as any).MemeWarzoneSwap = { mount, version: "1" };

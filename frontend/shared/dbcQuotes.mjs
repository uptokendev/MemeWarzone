/**
 * DBC quote registry (D20). One file per cluster: mint, symbol, decimals,
 * token program, kind, enabled. SOL is the default everywhere.
 *
 * 7a enables SOL + USDC/USDT (classic SPL). Stock tokens are listed disabled
 * until 7b.
 */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
export const TSLAX_MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
export const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
export const QQQX_MINT = "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ";

export const DBC_QUOTE_KINDS = Object.freeze(["native", "stable", "stock"]);

function row({ mint, symbol, decimals, tokenProgram, kind, enabled, cluster }) {
  return Object.freeze({
    mint: String(mint),
    symbol: String(symbol),
    decimals: Number(decimals),
    tokenProgram: String(tokenProgram),
    kind: String(kind),
    enabled: Boolean(enabled),
    cluster: String(cluster),
  });
}

const NATIVE = (cluster) => row({
  mint: WSOL_MINT,
  symbol: "SOL",
  decimals: 9,
  tokenProgram: SPL_TOKEN_PROGRAM_ID,
  kind: "native",
  enabled: true,
  cluster,
});

const STOCKS_MAINNET = [
  row({ mint: NVDAX_MINT, symbol: "NVDAx", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID, kind: "stock", enabled: false, cluster: "mainnet-beta" }),
  row({ mint: TSLAX_MINT, symbol: "TSLAx", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID, kind: "stock", enabled: false, cluster: "mainnet-beta" }),
  row({ mint: SPYX_MINT, symbol: "SPYx", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID, kind: "stock", enabled: false, cluster: "mainnet-beta" }),
  row({ mint: QQQX_MINT, symbol: "QQQx", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID, kind: "stock", enabled: false, cluster: "mainnet-beta" }),
];

const REGISTRY = Object.freeze({
  "mainnet-beta": Object.freeze([
    NATIVE("mainnet-beta"),
    row({ mint: USDC_MINT_MAINNET, symbol: "USDC", decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID, kind: "stable", enabled: true, cluster: "mainnet-beta" }),
    row({ mint: USDT_MINT_MAINNET, symbol: "USDT", decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID, kind: "stable", enabled: true, cluster: "mainnet-beta" }),
    ...STOCKS_MAINNET,
  ]),
  devnet: Object.freeze([
    NATIVE("devnet"),
    row({ mint: USDC_MINT_DEVNET, symbol: "USDC", decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID, kind: "stable", enabled: true, cluster: "devnet" }),
  ]),
});

export function normalizeDbcCluster(cluster) {
  const raw = String(cluster || "").trim();
  if (raw === "devnet") return "devnet";
  if (raw === "mainnet-beta" || raw === "solana-mainnet-beta" || raw === "mainnet") return "mainnet-beta";
  return "";
}

/**
 * Devnet-only override of the USDC mint (proofs mint their own 6-decimal SPL).
 * Mainnet rows never read this env.
 */
export function readDevnetUsdcMint(env = typeof process !== "undefined" ? process.env : {}) {
  const fromProcess = String(env?.DBC_DEVNET_USDC_MINT || "").trim();
  let fromVite = "";
  try {
    fromVite = String(import.meta.env?.VITE_DBC_DEVNET_USDC_MINT || "").trim();
  } catch {
    fromVite = "";
  }
  return fromProcess || fromVite || USDC_MINT_DEVNET;
}

export function quotesForCluster(cluster, env) {
  const key = normalizeDbcCluster(cluster) || "mainnet-beta";
  const list = REGISTRY[key] || REGISTRY["mainnet-beta"];
  if (key !== "devnet") return list;
  const mint = readDevnetUsdcMint(env);
  if (mint === USDC_MINT_DEVNET) return list;
  return Object.freeze(list.map((q) => (
    q.kind === "stable" && q.symbol === "USDC"
      ? row({ mint, symbol: q.symbol, decimals: q.decimals, tokenProgram: q.tokenProgram, kind: q.kind, enabled: q.enabled, cluster: q.cluster })
      : q
  )));
}

export function nativeQuote(cluster) {
  const found = quotesForCluster(cluster).find((q) => q.kind === "native");
  return found || NATIVE(normalizeDbcCluster(cluster) || "mainnet-beta");
}

export function findQuote(cluster, mint) {
  const want = String(mint || "").trim();
  if (!want) return null;
  return quotesForCluster(cluster).find((q) => q.mint === want) || null;
}

export function requireEnabledQuote(cluster, mint) {
  const quote = findQuote(cluster, mint);
  if (!quote) {
    throw Object.assign(new Error("That quote mint is not in the DBC registry."), { code: "DBC_QUOTE_UNKNOWN" });
  }
  if (!quote.enabled) {
    throw Object.assign(new Error(`${quote.symbol} is not enabled as a DBC quote.`), { code: "DBC_QUOTE_DISABLED" });
  }
  return quote;
}

export function enabledQuotes(cluster) {
  return quotesForCluster(cluster).filter((q) => q.enabled);
}

export function isNativeQuoteMint(mint) {
  return String(mint || "").trim() === WSOL_MINT;
}

export function quoteScale(quote) {
  const decimals = Number(quote?.decimals ?? 9);
  return 10n ** BigInt(decimals);
}

/**
 * Threshold in the quote's smallest unit.
 * Stables are 1:1 USD (no SOL price step). SOL keeps thresholdLamportsFor.
 */
export function thresholdQuoteRaw(targetUsdMicros, quote, stepUsdMicros) {
  const target = BigInt(targetUsdMicros);
  if (target <= 0n) throw new Error("target must be positive");
  if (!quote || quote.kind === "native") {
    const step = BigInt(stepUsdMicros);
    if (step <= 0n) throw new Error("step must be positive");
    return (target * 1_000_000_000n + step - 1n) / step;
  }
  if (quote.kind === "stable") {
    return (target * quoteScale(quote)) / 1_000_000n;
  }
  throw Object.assign(new Error("stock quote threshold needs a live price (step 7b)"), { code: "DBC_QUOTE_STOCK" });
}

export function stableStep() {
  return { stepIndex: 0, stepUsdMicros: 1_000_000n };
}

export function defaultQuoteMint(cluster) {
  return nativeQuote(cluster).mint;
}

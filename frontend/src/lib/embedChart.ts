/**
 * Partner chart iframe (CrypticPump and later).
 * Indexer HTTP only — never Solana/EVM RPC, never the Token Details page.
 */

export const EMBED_CHART_PATH_PREFIX = "/embed/chart";
export const EMBED_CHART_POLL_MS = 15_000;
export const EMBED_CHART_DEFAULT_RESOLUTION = "1m";
export const EMBED_CHART_RESOLUTIONS = ["1s", "5s", "1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type EmbedChartResolution = (typeof EMBED_CHART_RESOLUTIONS)[number];

/** Origins allowed to frame /embed/chart. Keep in lockstep with Netlify _headers. */
export const EMBED_CHART_FRAME_ANCESTORS = [
  "https://crypticpump.com",
  "https://www.crypticpump.com",
] as const;

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_CHAIN_IDS = new Set([56, 97, 101, 4663, 46630]);

export type EmbedChartIdentity = {
  chainId: number;
  token: string;
};

export function isEmbedPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0];
  return path === "/embed" || path.startsWith("/embed/");
}

export function isEmbedChartPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0];
  return path === EMBED_CHART_PATH_PREFIX || path.startsWith(`${EMBED_CHART_PATH_PREFIX}/`);
}

export function isEmbedChartToken(value: unknown): boolean {
  const raw = String(value || "").trim();
  return SOLANA_ADDRESS_RE.test(raw) || EVM_ADDRESS_RE.test(raw);
}

export function parseEmbedChartPath(pathname: string): EmbedChartIdentity | null {
  const path = String(pathname || "").split("?")[0];
  const match = path.match(/^\/embed\/chart\/(\d+)\/([^/]+)\/?$/);
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!SUPPORTED_CHAIN_IDS.has(chainId)) return null;
  let token = String(match[2] || "").trim();
  try {
    token = decodeURIComponent(token);
  } catch {
    // keep raw
  }
  token = token.trim();
  if (chainId === 56 || chainId === 97 || chainId === 4663 || chainId === 46630) {
    token = token.toLowerCase();
  }
  if (!isEmbedChartToken(token)) return null;
  return { chainId, token };
}

export function parseEmbedChartResolution(search: string | URLSearchParams | null | undefined): EmbedChartResolution {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const raw = String(params.get("interval") || params.get("tf") || params.get("resolution") || "")
    .trim()
    .toLowerCase();
  return (EMBED_CHART_RESOLUTIONS as readonly string[]).includes(raw)
    ? (raw as EmbedChartResolution)
    : EMBED_CHART_DEFAULT_RESOLUTION;
}

export function buildEmbedChartPath(
  chainId: number,
  token: string,
  options?: { interval?: string | null },
): string {
  const identity = parseEmbedChartPath(
    `${EMBED_CHART_PATH_PREFIX}/${Number(chainId)}/${encodeURIComponent(String(token || "").trim())}`,
  );
  if (!identity) return EMBED_CHART_PATH_PREFIX;
  const params = new URLSearchParams();
  const interval = parseEmbedChartResolution(`interval=${String(options?.interval || "").trim()}`);
  if (interval !== EMBED_CHART_DEFAULT_RESOLUTION) params.set("interval", interval);
  const qs = params.toString();
  return `${EMBED_CHART_PATH_PREFIX}/${identity.chainId}/${encodeURIComponent(identity.token)}${qs ? `?${qs}` : ""}`;
}

function finitePositive(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** SOL/BNB/ETH USD from the indexer summary — never a browser RPC or CoinGecko call. */
export function nativeUsdFromSummary(summary: Record<string, unknown> | null | undefined): number {
  const direct =
    finitePositive(summary?.reference_price_usd) || finitePositive(summary?.quote_reference_price_usd);
  if (direct) return direct;
  const mcapUsd = finitePositive(summary?.market_cap_usd);
  const mcapNative = finitePositive(summary?.market_cap_bnb);
  if (mcapUsd && mcapNative) return mcapUsd / mcapNative;
  const priceUsd = finitePositive(summary?.last_price_usd);
  const priceNative = finitePositive(summary?.last_price_bnb);
  if (priceUsd && priceNative) return priceUsd / priceNative;
  return 0;
}

export function liveNativeFromSummary(summary: Record<string, unknown> | null | undefined): {
  priceNative: number | null;
  mcapNative: number | null;
} {
  const priceNative = finitePositive(summary?.last_price_bnb);
  const mcapNative = finitePositive(summary?.market_cap_bnb);
  return {
    priceNative: priceNative || null,
    mcapNative: mcapNative || null,
  };
}

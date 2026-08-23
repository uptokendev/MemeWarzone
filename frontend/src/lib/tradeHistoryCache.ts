import type { CurveTradePoint } from "@/hooks/useCurveTrades";
import { isSolanaChainId } from "@/lib/chainConfig";
import { isPlausibleBondingTrade, normalizeTradeTxHash } from "@/lib/tradeDedupe";

const PREFIX = "mwz:trade-history:v3:";
const LEGACY_PREFIX = "mwz:trade-history:v2:";
const MAX = 120;

type Stored = {
  type: "buy" | "sell";
  from: string;
  to: string;
  tokensWei: string;
  nativeWei: string;
  pricePerToken: number;
  soldTokensAfterRaw?: string | null;
  timestamp: number;
  txHash: string;
  blockNumber: number;
  logIndex: number;
};

function normalizeAddress(chainId: number, value: unknown) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function key(chainId: number, campaign: string) {
  return `${PREFIX}${Number(chainId)}:${normalizeAddress(chainId, campaign)}`;
}

function storageFor(_chainId: number): Storage | null {
  if (typeof window === "undefined") return null;
  // Shared across tabs and wallet kinds. sessionStorage made Phantom and
  // MetaMask on the same WIC page keep two different trade books.
  return window.localStorage;
}

function toStored(p: CurveTradePoint, chainId: number): Stored | null {
  const txHash = normalizeTradeTxHash(p.txHash);
  if (!txHash) return null;
  return {
    type: p.type === "sell" ? "sell" : "buy",
    from: normalizeAddress(chainId, p.from),
    to: normalizeAddress(chainId, p.to),
    tokensWei: String(p.tokensWei ?? 0n),
    nativeWei: String(p.nativeWei ?? 0n),
    pricePerToken: Number(p.pricePerToken || 0),
    soldTokensAfterRaw:
      p.soldTokensAfterRaw != null
        ? String(p.soldTokensAfterRaw)
        : null,
    timestamp: Number(p.timestamp || 0),
    txHash,
    blockNumber: Number(p.blockNumber || 0),
    logIndex: Number(p.logIndex || 0),
  };
}

function fromStored(s: Stored, chainId: number): CurveTradePoint | null {
  try {
    const txHash = normalizeTradeTxHash(s.txHash);
    if (!txHash) return null;
    return {
      type: s.type === "sell" ? "sell" : "buy",
      from: normalizeAddress(chainId, s.from),
      to: normalizeAddress(chainId, s.to),
      tokensWei: BigInt(s.tokensWei || "0"),
      nativeWei: BigInt(s.nativeWei || "0"),
      pricePerToken: Number(s.pricePerToken || 0),
      soldTokensAfterRaw:
        s.soldTokensAfterRaw != null && String(s.soldTokensAfterRaw).trim() !== ""
          ? BigInt(String(s.soldTokensAfterRaw))
          : null,
      timestamp: Number(s.timestamp || 0),
      txHash,
      blockNumber: Number(s.blockNumber || 0),
      logIndex: Number(s.logIndex || 0),
    };
  } catch {
    return null;
  }
}

function readStoredArray(storage: Storage, storageKey: string, chainId: number): CurveTradePoint[] {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Stored[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => fromStored(row, chainId))
      .filter((x): x is CurveTradePoint => Boolean(x) && isPlausibleBondingTrade(x));
  } catch {
    return [];
  }
}

export function clearCachedTradeHistory(chainId: number, campaign: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(chainId, campaign));
    window.localStorage.removeItem(`${LEGACY_PREFIX}${Number(chainId)}:${normalizeAddress(chainId, campaign)}`);
    window.sessionStorage.removeItem(`${LEGACY_PREFIX}${Number(chainId)}:${normalizeAddress(chainId, campaign)}`);
  } catch {
    // ignore
  }
}

export function loadCachedTradeHistory(chainId: number, campaign: string): CurveTradePoint[] {
  if (typeof window === "undefined") return [];
  const currentKey = key(chainId, campaign);
  const legacyKey = `${LEGACY_PREFIX}${Number(chainId)}:${normalizeAddress(chainId, campaign)}`;
  const fromLocal = readStoredArray(window.localStorage, currentKey, chainId);
  // Legacy v2 often stored double-scaled Solana fills (10M SOL). Only use it
  // when v3 is empty, and never keep implausible rows.
  const fromLegacyLocal = fromLocal.length
    ? []
    : readStoredArray(window.localStorage, legacyKey, chainId);
  const fromSession = fromLocal.length
    ? []
    : readStoredArray(window.sessionStorage, legacyKey, chainId);
  const map = new Map<string, CurveTradePoint>();
  for (const row of [...fromLegacyLocal, ...fromSession, ...fromLocal]) {
    if (!isPlausibleBondingTrade(row)) continue;
    map.set(`${row.txHash}:${row.logIndex}`, row);
  }
  return Array.from(map.values())
    .sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .slice(-MAX);
}

export function saveCachedTradeHistory(chainId: number, campaign: string, trades: CurveTradePoint[]) {
  const storage = storageFor(chainId);
  if (!storage) return;
  try {
    const map = new Map<string, Stored>();
    for (const t of [...loadCachedTradeHistory(chainId, campaign), ...trades]) {
      const s = toStored(t, chainId);
      if (!s) continue;
      map.set(`${s.txHash}:${s.logIndex}`, s);
    }
    const rows = Array.from(map.values())
      .sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      .slice(-MAX);
    storage.setItem(key(chainId, campaign), JSON.stringify(rows));
  } catch {
    // ignore
  }
}

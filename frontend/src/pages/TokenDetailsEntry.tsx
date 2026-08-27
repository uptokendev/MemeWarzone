import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { apiFetch } from "@/lib/apiBase";
import { useLaunchpad, type CampaignInfo } from "@/lib/launchpadClient";
import {
  fetchSolanaCampaignCurveState,
  type SolanaCampaignCurveState,
} from "@/lib/solanaCampaignRead";
import { requestSolanaGraduationHandoff } from "@/lib/solanaGraduationHandoff";
import { isSolanaTokenRouteId } from "@/lib/tokenDetailsPath";
import { recordRecentlyViewed } from "@/lib/searchHistory";
import { analytics } from "@/lib/analytics/ProductAnalytics";
import { lookupArenaImport, type ArenaImportItem } from "@/lib/arenaImports";

import TokenDetails from "./TokenDetails";
import ImportedTokenDetails from "./ImportedTokenDetails";

const SOLANA_ROUTE_CACHE_PREFIX = "mwz:solana-token-route:v2:";
const SOLANA_ROUTE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SolanaRouteCache = {
  campaignAddress: string;
  updatedAt: number;
};

function tokenIdMatches(candidate?: string | null, routeId?: string | null): boolean {
  const left = String(candidate || "").trim();
  const right = String(routeId || "").trim();
  if (!left || !right) return false;
  return left === right || left.toLowerCase() === right.toLowerCase();
}

function routeCacheKey(routeId: string): string {
  return `${SOLANA_ROUTE_CACHE_PREFIX}${routeId}`;
}

function readRouteCache(routeId: string): SolanaRouteCache | null {
  if (typeof window === "undefined" || !routeId) return null;
  try {
    const raw = window.localStorage.getItem(routeCacheKey(routeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SolanaRouteCache>;
    const campaignAddress = String(parsed.campaignAddress || "").trim();
    const updatedAt = Number(parsed.updatedAt || 0);
    if (!campaignAddress || !Number.isFinite(updatedAt)) return null;
    if (Date.now() - updatedAt > SOLANA_ROUTE_CACHE_TTL_MS) return null;
    return { campaignAddress, updatedAt };
  } catch {
    return null;
  }
}

function writeRouteCache(routeId: string, cache: SolanaRouteCache) {
  if (typeof window === "undefined" || !routeId || !cache.campaignAddress) return;
  try {
    window.localStorage.setItem(routeCacheKey(routeId), JSON.stringify(cache));
  } catch {
    // Best-effort only.
  }
}

const TokenDetailsEntry = () => {
  const { campaignAddress } = useParams<{ campaignAddress: string }>();
  const [searchParams] = useSearchParams();
  const { fetchCampaigns } = useLaunchpad();

  const routeId = String(campaignAddress || "").trim();
  const forcedChainId = Number(searchParams.get("chainId") || "");
  const isSolanaRoute = useMemo(() => {
    // A 0x BNB/ETH token is never a Solana route, even if the wallet latch
    // or a stale ?chainId=101 is present. That was collapsing WIC trades/holders.
    if (/^0x[a-fA-F0-9]{40}$/i.test(routeId)) return false;
    return forcedChainId === SOLANA_CHAIN_ID || isSolanaTokenRouteId(routeId);
  }, [forcedChainId, routeId]);
  const initialCache = useMemo(
    () => (isSolanaRoute ? readRouteCache(routeId) : null),
    [isSolanaRoute, routeId],
  );

  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  const [campaignResolved, setCampaignResolved] = useState<boolean>(!isSolanaRoute);
  const [curve, setCurve] = useState<SolanaCampaignCurveState | null>(null);
  const [curveResolved, setCurveResolved] = useState<boolean>(!isSolanaRoute);
  const [cachedCampaignAddress, setCachedCampaignAddress] = useState<string>(initialCache?.campaignAddress || "");
  const [imported, setImported] = useState<ArenaImportItem | null>(null);
  const [importLookupDone, setImportLookupDone] = useState(false);

  useEffect(() => {
    if (!routeId) return;
    analytics.track("token_page_viewed", { chain: isSolanaRoute ? "solana" : "bnb" });
  }, [routeId, isSolanaRoute]);

  useEffect(() => {
    if (!isSolanaRoute) {
      setCampaign(null);
      setCampaignResolved(true);
      setCurve(null);
      setCurveResolved(true);
      setCachedCampaignAddress("");
      return;
    }

    const cache = readRouteCache(routeId);
    setCampaign(null);
    setCurve(null);
    setCampaignResolved(Boolean(cache?.campaignAddress));
    setCurveResolved(Boolean(cache?.campaignAddress));
    setCachedCampaignAddress(cache?.campaignAddress || "");
  }, [isSolanaRoute, routeId]);

  useEffect(() => {
    if (!isSolanaRoute || !routeId) {
      setCampaign(null);
      setCampaignResolved(true);
      return;
    }

    let cancelled = false;
    setCampaignResolved(Boolean(cachedCampaignAddress));

    (async () => {
      try {
        const [campaigns, rawCampaignJson] = await Promise.all([
          fetchCampaigns(),
          (async () => {
            try {
              const res = await apiFetch(
                `/api/campaigns?chainId=${encodeURIComponent(String(SOLANA_CHAIN_ID))}&limit=500&status=all`,
                { cache: "no-store" as RequestCache },
              );
              return await res.json().catch(() => null);
            } catch {
              return null;
            }
          })(),
        ]);
        if (cancelled) return;

        const match =
          campaigns.find((item) => tokenIdMatches(item.token, routeId) || tokenIdMatches(item.campaign, routeId)) ??
          null;
        if (match) {
          setCampaign(match);
          if (match.campaign) setCachedCampaignAddress(String(match.campaign).trim());
        }

        const rawItems = Array.isArray(rawCampaignJson?.items) ? rawCampaignJson.items : [];
        const rawMatch = rawItems.find((item: any) =>
          tokenIdMatches(item?.tokenAddress ?? item?.token_address ?? item?.token, routeId) ||
          tokenIdMatches(item?.campaignAddress ?? item?.campaign_address ?? item?.campaign, routeId),
        );
        const rawCampaignAddress = String(
          rawMatch?.campaignAddress ?? rawMatch?.campaign_address ?? rawMatch?.campaign ?? "",
        ).trim();
        if (rawCampaignAddress) setCachedCampaignAddress(rawCampaignAddress);
      } catch {
        // Keep any previously resolved identity instead of clearing it.
      } finally {
        if (!cancelled) setCampaignResolved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cachedCampaignAddress, fetchCampaigns, isSolanaRoute, routeId]);

  const curveLookupAddress = useMemo(
    () => String(campaign?.campaign || cachedCampaignAddress || routeId || "").trim(),
    [cachedCampaignAddress, campaign?.campaign, routeId],
  );

  useEffect(() => {
    if (!isSolanaRoute || !curveLookupAddress) {
      setCurve(null);
      setCurveResolved(true);
      return;
    }

    let cancelled = false;
    setCurveResolved(Boolean(curve?.campaignAddress || cachedCampaignAddress));

    const loadCurve = async () => {
      try {
        const nextCurve = await fetchSolanaCampaignCurveState(curveLookupAddress);
        if (cancelled) return;
        if (nextCurve) {
          setCurve(nextCurve);
          setCachedCampaignAddress(String(nextCurve.campaignAddress || "").trim());
          if (nextCurve.curveClosed && !nextCurve.graduated) {
            void requestSolanaGraduationHandoff(nextCurve.campaignAddress || curveLookupAddress);
          }
        }
      } catch {
        // Preserve the last known curve identity.
      } finally {
        if (!cancelled) setCurveResolved(true);
      }
    };

    void loadCurve();
    const pollMs = curve?.curveClosed && !curve?.graduated ? 8_000 : 0;
    const timer = pollMs ? window.setInterval(() => void loadCurve(), pollMs) : 0;

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [cachedCampaignAddress, curve?.campaignAddress, curve?.curveClosed, curve?.graduated, curveLookupAddress, isSolanaRoute]);

  const resolvedCampaignAddress = useMemo(
    () => String(campaign?.campaign || curve?.campaignAddress || cachedCampaignAddress || "").trim(),
    [cachedCampaignAddress, campaign?.campaign, curve?.campaignAddress],
  );

  useEffect(() => {
    if (!isSolanaRoute || !routeId) return;
    const campaignAddressToCache = String(resolvedCampaignAddress || cachedCampaignAddress || curveLookupAddress || "").trim();
    if (!campaignAddressToCache) return;
    writeRouteCache(routeId, {
      campaignAddress: campaignAddressToCache,
      updatedAt: Date.now(),
    });
  }, [cachedCampaignAddress, curveLookupAddress, isSolanaRoute, resolvedCampaignAddress, routeId]);

  useEffect(() => {
    const campaignAddress = String(campaign?.campaign || resolvedCampaignAddress || (!isSolanaRoute ? routeId : "") || "").trim();
    const tokenAddress = String(campaign?.token || (isSolanaRoute ? routeId : campaignAddress) || "").trim();
    if (!campaignAddress && !tokenAddress) return;
    const chainId = isSolanaRoute ? SOLANA_CHAIN_ID : Number((campaign as { chainId?: number } | null)?.chainId || 97);
    recordRecentlyViewed({
      name: String(campaign?.name || campaign?.symbol || tokenAddress.slice(0, 6) || "Token"),
      symbol: campaign?.symbol,
      logoURI: (campaign as { logoURI?: string } | null)?.logoURI,
      tokenAddress,
      campaignAddress,
      chainId,
    });
  }, [campaign, isSolanaRoute, resolvedCampaignAddress, routeId]);

  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setImportLookupDone(false);
    setImported(null);
    const preferred = isSolanaRoute
      ? SOLANA_CHAIN_ID
      : (forcedChainId === BNB_CHAIN_ID || forcedChainId === BNB_TESTNET_CHAIN_ID ? forcedChainId : 0);
    const chainIds = [...new Set([preferred, BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, SOLANA_CHAIN_ID].filter((id) => id > 0))];
    (async () => {
      for (const chainId of chainIds) {
        const item = await lookupArenaImport(routeId, chainId);
        if (cancelled) return;
        if (item) {
          setImported(item);
          setImportLookupDone(true);
          return;
        }
      }
      if (!cancelled) {
        setImported(null);
        setImportLookupDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [forcedChainId, isSolanaRoute, routeId]);

  if (!importLookupDone) return null;
  if (imported) {
    return <ImportedTokenDetails item={imported} />;
  }

  return <TokenDetails key={routeId || (isSolanaRoute ? "solana" : "evm")} />;
};

export default TokenDetailsEntry;

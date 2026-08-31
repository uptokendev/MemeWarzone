import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { getFrontendApiOrigin } from "@/lib/apiBase";
import { analytics } from "./client";

function ingestUrl() {
  const origin = getFrontendApiOrigin().replace(/\/+$/, "");
  return origin ? `${origin}/api/analytics/ingest` : "/api/analytics/ingest";
}

export function ProductAnalytics() {
  const location = useLocation();
  const wallet = useActiveFeedWallet();

  useEffect(() => {
    analytics.init({
      endpoint: ingestUrl(),
      writeKey: String(import.meta.env.VITE_ANALYTICS_WRITE_KEY || "").trim(),
      app: "public",
    });
    analytics.observeWebVitals();
  }, []);

  useEffect(() => {
    analytics.page(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (wallet.address) analytics.identify(wallet.address);
  }, [wallet.address]);

  return null;
}

export { analytics };
export { runCatalogAction, analyticsErrorCode, analyticsErrorMessage } from "./actions";

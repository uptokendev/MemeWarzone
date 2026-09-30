/**
 * Shown on the Create page while creation is limited to the launch team (API env
 * CREATE_CANARY_WALLETS). Informational only: the API decides who may create, so an
 * allowlisted wallet keeps using the page as normal.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";

export function LaunchCanaryBanner() {
  const [canary, setCanary] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch("/api/launch-status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active) setCanary(Boolean(data?.canary));
      })
      .catch(() => {
        // No status means no banner; the API still enforces the canary.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!canary) return null;
  return (
    <div
      role="status"
      className="mx-1 mb-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100"
    >
      Launches open soon. Right now only the launch team can create coins while we run a short test on each
      chain. You can still prepare and save a draft.
    </div>
  );
}

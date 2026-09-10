import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { projectImportsEnabled } from "@/features/projectImports/config";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { lookupProjectImport, type ProjectImportItem } from "@/lib/projectImports";

import ImportedProjectDetails from "./ImportedProjectDetails";
import TokenDetailsLiveEntry from "./TokenDetailsLiveEntry";

/**
 * Import-only compatibility boundary.
 *
 * When the dedicated project-import flag is enabled we resolve the canonical
 * imported-project row before mounting the historical token-details runtime.
 * This keeps imported project pages DB/API-only and prevents campaign,
 * bonding, graduation, trading, claims or Arena code from being mounted for
 * a registered external token. Non-imported token routes keep the exact live
 * TokenDetailsEntry implementation through TokenDetailsLiveEntry.
 */
export default function TokenDetailsEntry() {
  const { campaignAddress } = useParams<{ campaignAddress: string }>();
  const [searchParams] = useSearchParams();
  const routeId = String(campaignAddress || "").trim();

  const importChainId = useMemo(() => {
    const requested = Number(searchParams.get("chainId") || "");
    if (requested === BNB_CHAIN_ID || requested === SOLANA_CHAIN_ID) return requested;
    return /^0x[a-fA-F0-9]{40}$/.test(routeId) ? BNB_CHAIN_ID : SOLANA_CHAIN_ID;
  }, [routeId, searchParams]);

  const [project, setProject] = useState<ProjectImportItem | null>(null);
  const [resolved, setResolved] = useState(!projectImportsEnabled);

  useEffect(() => {
    if (!projectImportsEnabled || !routeId) {
      setProject(null);
      setResolved(true);
      return;
    }

    let cancelled = false;
    setProject(null);
    setResolved(false);

    void lookupProjectImport(routeId, importChainId)
      .then((item) => {
        if (!cancelled) setProject(item);
      })
      .catch(() => {
        if (!cancelled) setProject(null);
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [importChainId, routeId]);

  // Manual ownership decisions happen in the private operator dashboard while
  // a claimant may already have this page open. Re-read only pending/manual
  // imported projects so approval/rejection is reflected without a hard reload.
  useEffect(() => {
    if (!projectImportsEnabled || !routeId || !project) return;
    if (project.ownershipStatus !== "ownership_pending" && project.ownershipStatus !== "ownership_manual_review") return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await lookupProjectImport(routeId, importChainId);
        if (!cancelled && next) setProject(next);
      } catch {
        // Keep the last authoritative state visible on transient API failures.
      }
    };
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [importChainId, project?.id, project?.ownershipStatus, routeId]);

  if (!projectImportsEnabled) return <TokenDetailsLiveEntry />;
  if (!resolved) return null;
  if (project) return <ImportedProjectDetails key={`${project.id}:${project.ownershipStatus}:${project.ownershipVerifiedAt || ""}`} item={project} />;
  return <TokenDetailsLiveEntry />;
}

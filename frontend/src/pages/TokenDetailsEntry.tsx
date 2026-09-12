import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import ProjectXClaimDialog from "@/components/imports/ProjectXClaimDialog";
import { projectImportsEnabled, projectImportRobinhoodEnabled } from "@/features/projectImports/config";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { lookupProjectImport, type ProjectImportItem } from "@/lib/projectImports";

import ImportedProjectDetails from "./ImportedProjectDetails";
import TokenDetailsLiveEntry from "./TokenDetailsLiveEntry";

export default function TokenDetailsEntry() {
  const { campaignAddress } = useParams<{ campaignAddress: string }>();
  const [searchParams] = useSearchParams();
  const routeId = String(campaignAddress || "").trim();

  const importChainId = useMemo(() => {
    const requested = Number(searchParams.get("chainId") || "");
    if (requested === BNB_CHAIN_ID || requested === SOLANA_CHAIN_ID || (requested === 4663 && projectImportRobinhoodEnabled)) return requested;
    return /^0x[a-fA-F0-9]{40}$/.test(routeId) ? BNB_CHAIN_ID : SOLANA_CHAIN_ID;
  }, [routeId, searchParams]);

  const [project, setProject] = useState<ProjectImportItem | null>(null);
  const [resolved, setResolved] = useState(!projectImportsEnabled);
  const claimResult = searchParams.get("claim");
  const [claimOpen, setClaimOpen] = useState(claimResult === "prompt" || claimResult === "x_failed");

  useEffect(() => {
    if (!projectImportsEnabled || !routeId) { setProject(null); setResolved(true); return; }
    let cancelled = false;
    setProject(null); setResolved(false);
    void lookupProjectImport(routeId, importChainId)
      .then((item) => { if (!cancelled) setProject(item); })
      .catch(() => { if (!cancelled) setProject(null); })
      .finally(() => { if (!cancelled) setResolved(true); });
    return () => { cancelled = true; };
  }, [importChainId, routeId]);

  useEffect(() => {
    if (!projectImportsEnabled || !routeId || !project) return;
    if (project.ownershipStatus !== "ownership_pending" && project.ownershipStatus !== "ownership_manual_review") return;
    let cancelled = false;
    const refresh = async () => {
      try { const next = await lookupProjectImport(routeId, importChainId); if (!cancelled && next) setProject(next); } catch {}
    };
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisibility); };
  }, [importChainId, project?.id, project?.ownershipStatus, routeId]);

  if (!projectImportsEnabled) return <TokenDetailsLiveEntry />;
  if (!resolved) return null;
  if (project) return <>
    <ImportedProjectDetails key={`${project.id}:${project.ownershipStatus}:${project.ownershipVerifiedAt || ""}`} item={project} onClaimMemecoin={() => setClaimOpen(true)} />
    <ProjectXClaimDialog item={project} open={claimOpen} onOpenChange={setClaimOpen} onResolvedImage={(imageUrl) => setProject((current) => current ? { ...current, imageUrl } : current)} onManualReviewRequested={(next) => { setProject(next); setClaimOpen(false); }} />
  </>;
  return <TokenDetailsLiveEntry />;
}

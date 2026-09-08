import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { projectImportsEnabled } from "@/features/projectImports/config";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { lookupProjectImport, type ProjectImportItem } from "@/lib/projectImports";

import ImportedTokenDetailsPage from "./ImportedTokenDetailsPage";
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

  if (!projectImportsEnabled) return <TokenDetailsLiveEntry />;
  if (!resolved) return null;
  if (project) return <ImportedTokenDetailsPage item={project} />;
  return <TokenDetailsLiveEntry />;
}

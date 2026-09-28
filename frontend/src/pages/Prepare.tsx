import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import PrepareBase from "./PrepareBase";
import { ScheduledLaunchCountdown } from "@/components/prepare/ScheduledLaunchCountdown";
import {
  fetchPublicCampaignLifecycleDrafts,
  readCampaignLaunchAt,
  timestampSeconds,
  type CampaignDraftLifecycle,
} from "@/lib/scheduledLaunchApi";

export default function Prepare() {
  const { slug = "memewarzone-mwz-demo" } = useParams();
  const [draft, setDraft] = useState<CampaignDraftLifecycle | null>(null);
  const [onChainLaunchAt, setOnChainLaunchAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicCampaignLifecycleDrafts({ limit: 500 })
      .then((items) => {
        if (cancelled) return;
        setDraft(items.find((item) => String(item.slug) === String(slug)) || null);
      })
      .catch(() => {
        if (!cancelled) setDraft(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const storedScheduledLaunchAt = timestampSeconds(draft?.scheduledLaunchAt);

  useEffect(() => {
    let cancelled = false;
    setOnChainLaunchAt(null);
    if (!storedScheduledLaunchAt || !draft?.campaignAddress || !draft.chainId) return;
    void readCampaignLaunchAt(Number(draft.chainId), draft.campaignAddress).then((value) => {
      if (!cancelled) setOnChainLaunchAt(value);
    });
    return () => {
      cancelled = true;
    };
  }, [draft?.campaignAddress, draft?.chainId, storedScheduledLaunchAt]);

  const dbcWaiting = String((draft as { launchType?: string } | null)?.launchType || "") === "dbc" && storedScheduledLaunchAt && !draft?.campaignAddress;
  const isScheduledLifecycle = Boolean((draft?.campaignAddress && storedScheduledLaunchAt) || dbcWaiting);
  const launchAt = isScheduledLifecycle ? onChainLaunchAt || storedScheduledLaunchAt : null;

  return (
    <div data-scheduled-lifecycle={isScheduledLifecycle ? "true" : "false"} className="relative">
      {isScheduledLifecycle && launchAt ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2 px-2 md:top-4">
          <ScheduledLaunchCountdown
            launchAt={launchAt}
            chainId={draft?.chainId}
            campaignAddress={draft?.campaignAddress}
            contractDeployed={Boolean(draft?.campaignAddress)}
            waitingForCreatorDeploy={Boolean(dbcWaiting)}
            variant="pill"
            className="pointer-events-auto whitespace-nowrap"
          />
        </div>
      ) : null}

      {isScheduledLifecycle ? (
        <style>{`
          [data-scheduled-lifecycle="true"] main > section:first-child > .mwz-chip { display: none !important; }
        `}</style>
      ) : null}

      <PrepareBase />
    </div>
  );
}

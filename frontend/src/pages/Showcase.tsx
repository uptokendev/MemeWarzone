import { useEffect, useMemo, useState } from "react";
import { ChainFeedSwitch } from "@/components/common/ChainFeedSwitch";
import { CampaignGrid, HomeQuery } from "@/components/home/CampaignGrid";
import { DiscoveryControls } from "@/components/home/DiscoveryControls";
import { DraftCampaignGrid } from "@/components/home/DraftCampaignGrid";
import { SafeFeaturedCampaigns } from "@/components/home/SafeFeaturedCampaigns";
import { HeaderBand } from "@/components/home/HeaderBand";
import { CampaignTickerBar } from "@/components/home/CampaignTickerBar";
import { ContentContainer } from "@/components/layout/ContentContainer";

const Showcase = () => {
  const [query, setQuery] = useState<HomeQuery>({ tab: "trending", timeFilter: "24h", search: "", status: "all" });

  useEffect(() => {
    const onSearch = (e: Event) => {
      const q = String((e as CustomEvent<string>).detail ?? "");
      setQuery((prev) => ({ ...prev, search: q }));
    };
    window.addEventListener("memewarzone:homeSearch", onSearch);
    return () => window.removeEventListener("memewarzone:homeSearch", onSearch);
  }, []);

  const effectiveQuery = useMemo(() => {
    return {
      ...query,
      tab: query.tab ?? "trending",
    } as HomeQuery;
  }, [query]);

  const isDraftRow = effectiveQuery.tab === "drafts";
  const isGraduatedRow = effectiveQuery.tab === "dex" || effectiveQuery.status === "graduated";

  return (
    <div className="mwz-launchpad-page h-full overflow-y-auto">
      <div className="mwz-launchpad-inner">
        <HeaderBand showTicker={false} />
      </div>

      <ContentContainer className="relative px-1 md:px-2 pb-10 space-y-3">
        <CampaignTickerBar className="-mt-12 !pt-0" />

        <div className="relative z-20 -mt-1 mb-2 md:-mt-2 md:mb-3">
          <SafeFeaturedCampaigns />
        </div>

        <div className="mwz-live-heading flex flex-col gap-3 pt-2 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent">
              {isDraftRow ? "Prepare Mode" : isGraduatedRow ? "DEX Campaigns" : ""}
            </div>
            <h2 className="mwz-section-title text-2xl text-success md:text-3xl">
              {isDraftRow ? "Draft Campaigns" : isGraduatedRow ? "Graduated Coins" : "Explore Coins"}
            </h2>
          </div>
          <ChainFeedSwitch className="shrink-0 self-start md:self-auto" />
        </div>

        <DiscoveryControls query={effectiveQuery} onChange={setQuery} />
        {isDraftRow ? (
          <DraftCampaignGrid query={effectiveQuery} />
        ) : (
          <CampaignGrid query={effectiveQuery} />
        )}
      </ContentContainer>
    </div>
  );
};

export default Showcase;

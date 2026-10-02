import { useEffect, useMemo, useState } from "react";
import { ChainFeedSwitch } from "@/components/common/ChainFeedSwitch";
import { CampaignGrid, HomeQuery } from "@/components/home/CampaignGrid";
import { DiscoveryControls } from "@/components/home/DiscoveryControls";
import { DraftCampaignGrid } from "@/components/home/DraftCampaignGrid";
import { SafeFeaturedCampaigns } from "@/components/home/SafeFeaturedCampaigns";
import { AirdropStrip } from "@/components/home/AirdropStrip";
import { CampaignTickerBar } from "@/components/home/CampaignTickerBar";
import { ImportedProjectsOverlay } from "@/components/home/ImportedProjectsOverlay";
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
    <div className="mwz-launchpad-page h-full overflow-y-auto font-mw-body text-mw-text">
      <ContentContainer className="relative flex flex-col gap-4 px-1 pb-6 pt-1 md:px-2">
        <CampaignTickerBar />

        <SafeFeaturedCampaigns />

        <AirdropStrip />

        <div className="flex flex-wrap items-end gap-3 pt-2">
          <div className="min-w-0">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
              {isDraftRow ? "Prepare mode" : isGraduatedRow ? "DEX campaigns" : "Discover"}
            </div>
            <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none md:text-[36px]">
              {isDraftRow ? "Draft campaigns" : isGraduatedRow ? "Graduated coins" : "Explore coins"}
            </h1>
          </div>
          <ChainFeedSwitch className="ml-auto shrink-0" />
        </div>

        <DiscoveryControls query={effectiveQuery} onChange={setQuery} />
        {isDraftRow ? (
          <DraftCampaignGrid query={effectiveQuery} />
        ) : (
          <CampaignGrid query={effectiveQuery} />
        )}
      </ContentContainer>
      <ImportedProjectsOverlay />
    </div>
  );
};

export default Showcase;

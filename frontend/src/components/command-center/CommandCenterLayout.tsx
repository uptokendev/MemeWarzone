import type { ReactNode } from "react";

import { ArenaDailyBriefing } from "@/components/command-center/ArenaDailyBriefing";
import { ChallengeInboxDialog } from "@/components/command-center/ChallengeInboxDialog";
import { CommandCenterDataProvider } from "@/components/command-center/CommandCenterContext";
import { CommandCenterHero } from "@/components/command-center/CommandCenterHero";
import { CommandCenterSidebar } from "@/components/command-center/CommandCenterSidebar";
import { ContentContainer } from "@/components/layout/ContentContainer";

type CommandCenterLayoutProps = {
  walletAddress: string;
  basePath: string;
  children: ReactNode;
};

export function CommandCenterLayout({ walletAddress, basePath, children }: CommandCenterLayoutProps) {
  return (
    <CommandCenterDataProvider key={walletAddress} walletAddress={walletAddress}>
      <ContentContainer className="mwz-command-center-layout space-y-4 pb-8 pt-28 md:pt-32 lg:pt-36">
        <CommandCenterHero walletAddress={walletAddress} />
        <ArenaDailyBriefing />
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <CommandCenterSidebar basePath={basePath} />
          <div className="min-w-0">{children}</div>
        </div>
        <ChallengeInboxDialog />
      </ContentContainer>
    </CommandCenterDataProvider>
  );
}

import type { ReactNode } from "react";

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
      <ContentContainer className="flex flex-col gap-3.5 px-1 pb-16 md:px-2">
        <CommandCenterHero walletAddress={walletAddress} />
        <CommandCenterSidebar basePath={basePath} />
        <div className="min-w-0 pt-1.5 lg:pt-1.5">{children}</div>
      </ContentContainer>
    </CommandCenterDataProvider>
  );
}

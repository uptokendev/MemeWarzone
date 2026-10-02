import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { ProfileSquadPanel } from "@/components/profile/ProfileSquadPanel";

export default function CommandCenterSquad() {
  const { walletAddress } = useCommandCenterData();

  return (
    <div className="flex flex-col gap-3.5">
      <CommandCenterPageHeader
        title="Squad"
        description="View your squad status, contribution, estimated rewards, and public squad standings."
      >
        <Link to="/squads" className="mw-focus inline-flex min-h-9 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
          Public squads
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </CommandCenterPageHeader>

      <ProfileSquadPanel account={walletAddress} isConnected={true} isOwnProfile={true} />
    </div>
  );
}

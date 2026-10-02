import { Link } from "react-router-dom";
import { ArrowRight, ShieldAlert, Trophy, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { ProfileSquadPanel } from "@/components/profile/ProfileSquadPanel";

const squadRules = [
  "Squad Pool access requires squad membership",
  "Solo users can still qualify for Warzone Airdrops",
  "Squad rewards are based on your contribution",
  "Your contribution appears after squad activity is recorded",
  "Squad standings stay public",
  "Personal reward details stay inside your Command Center",
];

export default function CommandCenterSquad() {
  const { walletAddress } = useCommandCenterData();

  return (
    <div className="space-y-4">
      <CommandCenterPageHeader
        title="Squad"
        description="View your squad status, contribution, estimated rewards, and public squad standings."
      >
        <Button asChild variant="outline" className="font-semibold">
          <Link to="/squads">
            Public squads
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CommandCenterPageHeader>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <CommandCenterCard
          title="Squad status"
          description="This page shows the squad state connected to this wallet. If you are not in a squad yet, this page explains how to join one."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {squadRules.map((rule) => (
              <div key={rule} className="rounded-[14px] border border-mw-border bg-mw-input p-3 text-sm text-mw-muted">
                {rule}
              </div>
            ))}
          </div>
        </CommandCenterCard>

        <CommandCenterCard title="Reward model" description="Squad rewards are based on weekly squad activity.">
          <div className="space-y-3">
            <div className="rounded-2xl border border-[#7A3A0C] bg-[#2A1609] p-4">
              <div className="flex items-start gap-3">
                <Users className="mt-1 h-4 w-4 shrink-0 text-mw-accent-soft" />
                <div>
                  <div className="font-semibold text-sm text-mw-text">When your wallet is part of a squad, your contribution and estimated reward will appear here.</div>
                  <p className="mt-1 text-sm text-mw-muted">
                    When you’re an active squad member, you’ll see your score and estimated weekly reward here.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-[14px] border border-mw-border bg-mw-input p-4">
              <div className="flex items-start gap-3">
                <Trophy className="mt-1 h-4 w-4 shrink-0 text-mw-accent-soft" />
                <div>
                  <div className="font-semibold text-sm text-mw-text">Leaderboard visibility</div>
                  <p className="mt-1 text-sm text-mw-muted">
                    Public squad standings stay on the squad leaderboard, while wallet-specific reward details remain inside your Command Center.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-amber-100" />
                <div>
                  <div className="font-semibold text-sm text-mw-text">Fair reward rules</div>
                  <p className="mt-1 text-sm text-mw-muted">
                    MemeWarzone applies fair-play rules automatically before weekly squad rewards are shown.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CommandCenterCard>
      </div>

      <ProfileSquadPanel account={walletAddress} isConnected={true} isOwnProfile={true} />
    </div>
  );
}

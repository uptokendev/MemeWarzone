import { Link } from "react-router-dom";
import { Coins, Lock, ShieldAlert, Trophy } from "lucide-react";
import type { Battle, WarPool } from "@/features/postgrad/contracts";
import { Button } from "@/components/ui/button";
import { TacticalTag, poolStateLabels } from "@/components/postgrad/PostGradPrimitives";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaWarPool } from "@/hooks/useArenaWarPoolFeed";

function formatUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatWhen(value?: string) {
  if (!value) return "No cutoff";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No cutoff";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const stateTone: Record<WarPool["state"], "default" | "hot" | "sponsored" | "success"> = {
  open: "success",
  locked: "hot",
  settling: "sponsored",
  paid: "default",
};

const nextPoolActions: Record<WarPool["state"], { label: string; state: WarPool["state"] }[]> = {
  open: [{ label: "Close support", state: "locked" }],
  locked: [],
  settling: [],
  paid: [],
};

export function WarPoolPanel({ battle }: { battle: Battle }) {
  const { pool, settlementSummary, supportSide, transitionWarPool } = useArenaWarPool(battle.id);

  if (!pool) return null;

  const supportedParticipants = battle.participants.filter((participant) => !participant.tokenId.startsWith("pending-"));

  return (
    <section className="mwz-hud-frame p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Support pool</div>
          <div className="mt-1 font-retro text-xl text-foreground">Community support (donation)</div>
          <div className="mt-2 text-sm text-muted-foreground">
            Support is a donation, not betting. Supporters are not paid. 85% winning campaign / 5% protocol / 10% Major War League once escrow is live.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <TacticalTag label={poolStateLabels[pool.state]} tone={stateTone[pool.state]} />
          <TacticalTag label={`${pool.entries.length} supporters`} tone="sponsored" />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <div className="mwz-hud-frame p-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground"><Coins className="h-3.5 w-3.5" />Total pot</div>
          <div className="mt-1 font-retro text-2xl text-foreground">{formatUsd(pool.totalPotUsd)}</div>
        </div>
        <div className="mwz-hud-frame p-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground"><Lock className="h-3.5 w-3.5" />Support closes</div>
          <div className="mt-1 text-sm font-semibold text-foreground">{formatWhen(pool.cutoffAt)}</div>
        </div>
        <div className="mwz-hud-frame p-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground"><Trophy className="h-3.5 w-3.5" />Campaign share</div>
          <div className="mt-1 text-sm font-semibold text-foreground">{formatUsd(pool.routingBreakdown.winnersUsd)}</div>
        </div>
        <div className="mwz-hud-frame p-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground"><ShieldAlert className="h-3.5 w-3.5" />Platform fee</div>
          <div className="mt-1 text-sm font-semibold text-foreground">{formatUsd(pool.routingBreakdown.protocolUsd + pool.routingBreakdown.featuredUsd)}</div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3">
          {supportedParticipants.map((participant) => {
            const sideTotal = pool.entries.filter((entry) => entry.sideTokenId === participant.tokenId).reduce((total, entry) => total + entry.amountUsd, 0);
            const share = pool.totalPotUsd > 0 ? Math.round((sideTotal / pool.totalPotUsd) * 100) : 0;
            const tokenRoute = getArenaTokenRoute(participant.tokenId);
            return (
              <div key={participant.tokenId} className="mwz-hud-frame p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-foreground">{participant.tokenName}</div>
                      <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{participant.symbol}</div>
                      <TacticalTag label={`${share}% of support`} tone={share >= 50 ? "hot" : "default"} />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground/80">{formatUsd(sideTotal)} supported · Score: {participant.score.toFixed(1)} · {participant.uniqueTraders} traders</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[250, 500, 1000].map((amount) => (
                      <Button
                        key={amount}
                        size="sm"
                        variant="outline"
                        className="font-retro"
                        disabled={pool.state !== "open"}
                        onClick={() => supportSide(battle.id, participant.tokenId, amount)}
                      >
                        Back with {formatUsd(amount)}
                      </Button>
                    ))}
                    {tokenRoute ? (
                      <Button asChild size="sm" variant="outline" className="font-retro">
                        <Link to={tokenRoute}>Token</Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mwz-hud-frame p-4">
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Payout preview</div>
          {settlementSummary ? (
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <div className="mwz-hud-frame p-3">
                <div className="text-xs text-muted-foreground/80">Current front-runner</div>
                <div className="mt-1 font-semibold text-foreground">{settlementSummary.winnerLabel}</div>
                <div className="mt-2 text-xs text-muted-foreground/80">{settlementSummary.settlementStateLabel}</div>
                <div className="mt-1 text-xs text-muted-foreground">{settlementSummary.settlementStateBody}</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <div className="mwz-hud-frame p-3">Winning side: <span className="text-foreground">{formatUsd(settlementSummary.winnerSideUsd)}</span></div>
                <div className="mwz-hud-frame p-3">Opposing side: <span className="text-foreground">{formatUsd(settlementSummary.loserSideUsd)}</span></div>
                <div className="mwz-hud-frame p-3">Estimated return: <span className="text-foreground">{settlementSummary.projectedPayoutMultiple.toFixed(2)}x</span></div>
                <div className="mwz-hud-frame p-3">Estimated payout: <span className="text-foreground">{formatUsd(settlementSummary.projectedWinnerPayoutUsd)}</span></div>
                <div className="mwz-hud-frame p-3">Estimated profit: <span className="text-foreground">{formatUsd(settlementSummary.projectedNetProfitUsd)}</span></div>
                <div className="mwz-hud-frame p-3">Eligible winning supports: <span className="text-foreground">{settlementSummary.eligibleWinningEntries}</span></div>
              </div>
              <div className="mwz-hud-frame p-3">
                <div className="text-xs text-muted-foreground/80">Prize breakdown</div>
                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                  <div>Winners: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.winnersUsd)}</span></div>
                  <div>Platform: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.protocolUsd)}</span></div>
                  <div>Promotions: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.featuredUsd)}</span></div>
                </div>
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {nextPoolActions[pool.state].map((action) => (
              <Button key={action.state} size="sm" className="font-retro" onClick={() => transitionWarPool(battle.id, action.state)}>
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
import { Link } from "react-router-dom";
import { Coins, Lock, ShieldAlert, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TacticalTag, poolStateLabels } from "@/components/postgrad/PostGradPrimitives";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaWarPool } from "@/hooks/useArenaWarPoolFeed";
import { ArenaSupportButton } from "@/components/arena/ArenaSupportButton";
import { postGradFlags } from "@/features/postgrad/config";
import { getNativeSymbol } from "@/lib/chainConfig";

type SupportSide = {
  tokenId: string;
  tokenName?: string;
  symbol?: string;
  score?: number;
  uniqueTraders?: number;
  eligible?: boolean;
};

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

const stateTone: Record<"open" | "locked" | "settling" | "paid", "default" | "hot" | "sponsored" | "success"> = {
  open: "success",
  locked: "hot",
  settling: "sponsored",
  paid: "default",
};

export function WarPoolPanel({
  poolSubjectId,
  chainId,
  nativeSymbol,
  sides,
  kind = "battle",
  redirectTo,
}: {
  poolSubjectId: string;
  chainId?: number;
  nativeSymbol?: string;
  sides: SupportSide[];
  kind?: "battle" | "tournament";
  redirectTo?: { href: string; label: string } | null;
}) {
  const { pool, settlementSummary, supportSide, refreshPool, meta } = useArenaWarPool(poolSubjectId);
  const symbol = nativeSymbol || meta?.nativeSymbol || getNativeSymbol(chainId);

  if (redirectTo) {
    return (
      <section className="mwz-hud-frame space-y-3 p-5">
        <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Community support</div>
        <p className="text-sm text-muted-foreground">
          This is a tournament match. Support the memecoin on the tournament page — the overall champion takes the pot.
        </p>
        <Button asChild size="sm" className="font-retro">
          <Link to={redirectTo.href}>{redirectTo.label}</Link>
        </Button>
      </section>
    );
  }

  if (!pool) return null;

  const displaySides = sides.map((side) => {
    const live = meta.sides?.find((item) => String(item.tokenId).toLowerCase() === String(side.tokenId).toLowerCase());
    return { ...side, eligible: live?.eligible ?? side.eligible };
  });
  const supportOpen = pool.state === "open";
  const title = kind === "tournament" ? "Tournament support (donation)" : "Community support (donation)";
  const body =
    kind === "tournament"
      ? "Pick a roster memecoin. Support is a donation, not betting. The overall champion takes 85% of buy-ins plus Support. 5% protocol / 10% Major War League. Supporters are not paid."
      : "Support is a donation, not betting. Supporters are not paid. 85% winning campaign / 5% protocol / 10% Major War League once escrow is live.";

  return (
    <section className="mwz-hud-frame p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Support pool</div>
          <div className="mt-1 font-retro text-xl text-foreground">{title}</div>
          <div className="mt-2 text-sm text-muted-foreground">{body}</div>
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
          {displaySides.map((participant) => {
            const sideTotal = pool.entries.filter((entry) => entry.sideTokenId === participant.tokenId).reduce((total, entry) => total + entry.amountUsd, 0);
            const share = pool.totalPotUsd > 0 ? Math.round((sideTotal / pool.totalPotUsd) * 100) : 0;
            const tokenRoute = getArenaTokenRoute(participant.tokenId);
            const eligible = participant.eligible !== false;
            return (
              <div key={participant.tokenId} className="mwz-hud-frame p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-foreground">{participant.tokenName || participant.symbol || participant.tokenId.slice(0, 8)}</div>
                      <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{participant.symbol || "---"}</div>
                      <TacticalTag label={`${share}% of support`} tone={share >= 50 ? "hot" : "default"} />
                      {!eligible ? <TacticalTag label="Eliminated" tone="default" /> : null}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground/80">
                      {formatUsd(sideTotal)} supported
                      {participant.score != null ? ` · Score: ${participant.score.toFixed(1)}` : ""}
                      {participant.uniqueTraders != null ? ` · ${participant.uniqueTraders} traders` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {supportOpen && eligible ? (
                      <ArenaSupportButton
                        poolSubjectId={poolSubjectId}
                        sideTokenId={participant.tokenId}
                        chainId={chainId}
                        nativeSymbol={symbol}
                        treasury={meta.treasury}
                        poolId={meta.onchainPoolId}
                        opened={meta.onchainOpened}
                        configured={meta.configured}
                        onDone={() => void refreshPool(poolSubjectId)}
                      />
                    ) : null}
                    {postGradFlags.mocks && supportOpen && eligible ? (
                      [250, 500, 1000].map((usd) => (
                        <Button
                          key={usd}
                          size="sm"
                          variant="outline"
                          className="font-retro"
                          onClick={() => void supportSide(poolSubjectId, participant.tokenId, usd)}
                        >
                          Mock {formatUsd(usd)}
                        </Button>
                      ))
                    ) : null}
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
              <div className="mwz-hud-frame p-3">
                <div className="text-xs text-muted-foreground/80">Prize breakdown</div>
                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                  <div>Champion: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.winnersUsd)}</span></div>
                  <div>Protocol: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.protocolUsd)}</span></div>
                  <div>Major War League: <span className="text-foreground">{formatUsd(settlementSummary.routingBreakdown.featuredUsd)}</span></div>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Payout preview appears once Support is recorded.</p>
          )}
        </div>
      </div>
    </section>
  );
}

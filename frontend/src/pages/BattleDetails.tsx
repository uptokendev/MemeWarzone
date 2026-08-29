import { Link, useParams } from "react-router-dom";
import { ArenaMatchRow } from "@/components/postgrad/ArenaMatchRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleDetails } from "@/hooks/useArenaBattleFeed";
import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { WarPoolPanel } from "@/components/postgrad/WarPoolPanel";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";
import { resolveImageUri } from "@/lib/media";

const BattleDetails = () => {
  const { id } = useParams();
  const { battle, source } = useArenaBattleDetails(id);

  if (!battle) {
    return (
      <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
        <section className="mwz-hud-frame p-5">
          <h1 className="font-retro text-2xl text-foreground">Battle unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {source === "empty" ? "Battle data is not available right now." : "This battle could not be loaded."}
          </p>
          <div className="mt-4">
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/warzone/battles">Back to battles</Link>
            </Button>
          </div>
        </section>
      </ContentContainer>
    );
  }

  const lane = publicBattleLane(battle.state);
  const tournamentId = String((battle as { tournamentId?: string }).tournamentId || "");
  const tournamentMatch = String((battle as { source?: string }).source || "") === "tournament" && Boolean(tournamentId);
  const sides = battle.participants
    .filter((participant) => participant.tokenId && !String(participant.tokenId).startsWith("pending-"))
    .map((participant) => ({
      tokenId: String(participant.tokenAddress || participant.tokenId),
      tokenName: participant.tokenName,
      symbol: participant.symbol,
      score: participant.score,
      uniqueTraders: participant.uniqueTraders,
      eligible: true,
    }));

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Battle</div>
            <h1 className="mt-1 font-retro text-2xl text-foreground">
              {battle.participants[0]?.symbol || battle.participants[0]?.tokenName || "Coin"} vs{" "}
              {battle.participants[1]?.symbol || battle.participants[1]?.tokenName || "Awaiting rival"}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <TacticalTag label={publicBattleLabel(lane, battle.state)} tone={lane === "live" ? "hot" : battle.state === "matched" ? "hot" : "default"} />
            <TacticalTag label={source === "api" ? "Live data" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
          </div>
        </div>
        <div className="mt-4">
          <ArenaMatchRow battle={battle} />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {battle.participants.slice(0, 2).map((participant) => {
          const route = getArenaTokenRoute(participant.tokenAddress ?? participant.tokenId ?? participant.campaignAddress ?? null);
          const image = resolveImageUri((participant as { imageUrl?: string }).imageUrl) || "/placeholder.svg";
          const body = (
            <div className="mwz-hud-frame p-4">
              <div className="flex items-center gap-3">
                <img src={image} alt="" className="h-12 w-12 border border-white/10 object-cover" />
                <div>
                  <div className="font-retro text-sm text-foreground">{participant.tokenName}</div>
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{participant.symbol}</div>
                </div>
              </div>
            </div>
          );
          return route ? (
            <Link key={participant.tokenId} to={route}>
              {body}
            </Link>
          ) : (
            <div key={participant.tokenId}>{body}</div>
          );
        })}
      </section>

      <section className="mwz-hud-frame space-y-2 p-4 text-sm text-muted-foreground">
        <p>
          {battle.state === "matched"
            ? Number((battle as { chainId?: number }).chainId) === 101 || Number((battle as { chainId?: number }).chainId) === 102
              ? "Settlement is agreed. The first owner pays their SOL stake while opening the pool. The rival then deposits the same stake. The fight clock starts only when both have paid."
              : "Settlement is agreed. Open the pool, then both owners deposit the same stake. The fight clock starts only when both have paid. If the other owner never deposits, refund after the pay window."
            : "Agree stake and fight length first (24 hours, 3 days, or 7 days). After that both owners deposit. Live starts when both have paid."}
        </p>
        <p>
          Support is a donation into the battle treasury for the memecoins in the fight, not betting and not charity. Supporters are not paid. Winner-takes-all: 85% winning campaign owner, 5% protocol, 10% Major War League. The winning owner claims — protocol does not send.
        </p>
        {battle.state === "matched" ? (
          <ArenaStakeButton
            battleId={battle.id}
            chainId={(battle as { chainId?: number }).chainId}
            battleState={battle.state}
          />
        ) : null}
        {battle.state === "finished" && !tournamentMatch ? (
          <ArenaWarPoolClaimButton battleId={battle.id} chainId={(battle as { chainId?: number }).chainId} />
        ) : null}
      </section>

      <WarPoolPanel
        poolSubjectId={tournamentMatch ? tournamentId : battle.id}
        chainId={(battle as { chainId?: number }).chainId}
        nativeSymbol={(battle as { nativeSymbol?: string }).nativeSymbol}
        sides={sides}
        kind={tournamentMatch ? "tournament" : "battle"}
        redirectTo={
          tournamentMatch
            ? { href: `/warzone/tournament/${encodeURIComponent(tournamentId)}`, label: "Support this coin in the tournament" }
            : null
        }
      />

      <Button asChild size="sm" variant="outline" className="font-retro">
        <Link to="/warzone/battles">Back to battles</Link>
      </Button>
    </ContentContainer>
  );
};

export default BattleDetails;

import { Link, useParams } from "react-router-dom";
import { ArenaMatchRow } from "@/components/postgrad/ArenaMatchRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleDetails } from "@/hooks/useArenaBattleFeed";
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
              <Link to="/arena/battles">Back to battles</Link>
            </Button>
          </div>
        </section>
      </ContentContainer>
    );
  }

  const lane = publicBattleLane(battle.state);

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
            <TacticalTag label={publicBattleLabel(lane)} tone={lane === "live" ? "hot" : "default"} />
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

      <section className="mwz-hud-frame p-4 text-sm text-muted-foreground">
        Support (donation, not betting) will sit here once escrow is live. 85% to the winning campaign, 5% protocol, 10% Major War League.
      </section>

      <Button asChild size="sm" variant="outline" className="font-retro">
        <Link to="/arena/battles">Back to battles</Link>
      </Button>
    </ContentContainer>
  );
};

export default BattleDetails;

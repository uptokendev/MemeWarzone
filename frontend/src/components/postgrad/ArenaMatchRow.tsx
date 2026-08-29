import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";
import { resolveImageUri } from "@/lib/media";

function participantName(battle: Battle, index: number) {
  const participant = battle.participants?.[index];
  if (!participant) return "Awaiting rival";
  return participant.symbol || participant.tokenName || "Unknown";
}

function participantImage(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; image?: string; logoUri?: string } | undefined;
  return resolveImageUri(participant?.imageUrl || participant?.image || participant?.logoUri) || "/placeholder.svg";
}

export function ArenaMatchRow({ battle }: { battle: Battle }) {
  const lane = publicBattleLane(battle.state);
  const left = participantName(battle, 0);
  const right = participantName(battle, 1);

  return (
    <Link
      to={`/battle/${encodeURIComponent(battle.id)}`}
      className="mwz-hud-frame flex items-center gap-3 p-3 transition hover:border-accent/50 hover:bg-accent/5"
    >
      <img src={participantImage(battle, 0)} alt="" className="h-10 w-10 shrink-0 border border-white/10 object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={publicBattleLabel(lane)} tone={lane === "live" ? "hot" : lane === "finished" ? "default" : "success"} />
          {battle.featured ? <TacticalTag label="Featured" tone="hot" /> : null}
        </div>
        <div className="mt-1 truncate font-retro text-sm text-foreground">
          {left} vs {right}
        </div>
      </div>
      <img src={participantImage(battle, 1)} alt="" className="h-10 w-10 shrink-0 border border-white/10 object-cover" />
    </Link>
  );
}

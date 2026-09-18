import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import type { Battle } from "@/features/postgrad/contracts";
import { presentChallengeActionCard } from "@/lib/arena/creatorChallengePresentation.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";

type Props = {
  battle: Battle;
  ownedKeys: Set<string>;
  chainId?: number | null;
  busyId?: string | null;
  onAccept: (battleId: string) => Promise<void> | void;
  onDecline: (battleId: string) => Promise<void> | void;
  onCounter: (battleId: string, stake: string, durationHours: number) => Promise<void> | void;
};

export function FocusedChallengePanel({
  battle,
  ownedKeys,
  chainId,
  busyId,
  onAccept,
  onDecline,
  onCounter,
}: Props) {
  const presented = presentChallengeActionCard(battle, ownedKeys, chainId);
  const native = presented.nativeSymbol || getNativeSymbol(Number(chainId || 0));
  const left = battle.participants?.[0];
  const right = battle.participants?.[1];

  return (
    <section className="space-y-4" data-focused-challenge-panel={battle.id} data-challenge-phase={presented.phase}>
      <ChallengeActionCard
        battle={battle}
        ownedKeys={ownedKeys}
        chainId={chainId}
        busyId={busyId}
        onAccept={onAccept}
        onDecline={onDecline}
        onCounter={onCounter}
        showViewLink={false}
      />
      <div className="grid min-w-0 grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <BattleWallCombatant battle={battle} participant={left} accent="ember" combatSide="left" />
        <BattleWallVs
          leftLabel={presented.headlineLeft}
          rightLabel={presented.headlineRight}
          leftPoints={null}
          rightPoints={null}
          leaderIndex={null}
          deploymentPending
          stakeLabel={`${presented.stakeNative} ${native}`.trim()}
          durationLabel={presented.durationLabel}
        />
        <BattleWallCombatant battle={battle} participant={right} accent="cyan" combatSide="right" />
      </div>
    </section>
  );
}

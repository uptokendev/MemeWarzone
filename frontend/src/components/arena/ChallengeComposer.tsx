import { MatchQualityPreview } from "@/components/command-center/MatchQualityPreview";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { Button } from "@/components/ui/button";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { BATTLE_DURATIONS, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { canChallengeAs, coinIdentityKey, eligibleFightAsCoins } from "@/lib/arena/creatorChallengePresentation.mjs";
import type { presentManualOpponentPreview } from "@/lib/arena/findMatchPresentation.mjs";

type Preview = ReturnType<typeof presentManualOpponentPreview>;

type Props = {
  coins: CreatorBattleStatus[];
  fightAsId: string;
  onFightAsChange: (tokenId: string) => void;
  opponentId: string;
  onOpponentChange: (tokenId: string) => void;
  opponentLocked?: boolean;
  opponentLabel?: string;
  stake: string;
  onStakeChange: (value: string) => void;
  durationHours: number;
  onDurationChange: (hours: number) => void;
  chainId?: number | null;
  nativeSymbol: string;
  busy?: boolean;
  matchPreview?: Preview | null;
  waitingRivals?: Array<{ id: string; label: string; target: string }>;
  onSend: () => void;
};

export function ChallengeComposer({
  coins,
  fightAsId,
  onFightAsChange,
  opponentId,
  onOpponentChange,
  opponentLocked = false,
  opponentLabel,
  stake,
  onStakeChange,
  durationHours,
  onDurationChange,
  chainId,
  nativeSymbol,
  busy,
  matchPreview,
  waitingRivals,
  onSend,
}: Props) {
  const eligible = eligibleFightAsCoins(coins, { chainId, excludeTokenId: opponentLocked ? opponentId : "" });
  const authorized = canChallengeAs(fightAsId, coins, { chainId, excludeTokenId: opponentLocked ? opponentId : "" });
  const stakeAmount = Number(stake);
  const canSend = Boolean(
    authorized && opponentId.trim() && Number.isFinite(stakeAmount) && stakeAmount > 0 && !busy,
  );
  const unauthorizedReason = !coins.length
    ? "Connect the wallet that owns an eligible coin."
    : !eligible.length
      ? "This wallet has no eligible coin to fight as on this chain."
      : !authorized
        ? "You can only challenge as a coin this wallet controls."
        : null;

  return (
    <CommandCenterCard
      title="Send challenge"
      description="Fight as one of your coins. Set stake and duration, then send through the authenticated Battle API."
    >
      <div className="space-y-3" id="command-center-challenge" data-challenge-composer="true">
        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Fight as
          {eligible.length > 1 ? (
            <select
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              value={fightAsId}
              onChange={(event) => onFightAsChange(event.target.value)}
              data-fight-as-select
            >
              {eligible.map((item) => (
                <option key={coinIdentityKey(item)} value={item.tokenAddress || item.tokenId || item.campaignAddress}>
                  ${item.symbol || item.tokenName} ({item.origin === "import" ? "imported" : "graduated"})
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-1 font-retro text-sm text-foreground" data-fight-as-label>
              {eligible[0] ? `$${eligible[0].symbol || eligible[0].tokenName}` : "No eligible coin"}
            </div>
          )}
        </label>

        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Opponent
          {opponentLocked ? (
            <div className="mt-1 font-retro text-sm text-foreground" data-challenge-opponent-locked>
              {opponentLabel || opponentId}
            </div>
          ) : (
            <input
              value={opponentId}
              onChange={(event) => onOpponentChange(event.target.value)}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Token address"
              data-challenge-opponent-input
            />
          )}
        </label>

        {matchPreview ? (
          <MatchQualityPreview
            preview={matchPreview}
            onChallengeAnyway={() => undefined}
            onContinueWithChallenge={() => undefined}
          />
        ) : null}

        {waitingRivals?.length ? (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Waiting now</div>
            {waitingRivals.slice(0, 8).map((rival) => (
              <button
                key={rival.id}
                type="button"
                className="mwz-hud-frame flex w-full items-center justify-between p-3 text-left text-sm"
                onClick={() => onOpponentChange(rival.target)}
              >
                <span className="font-retro text-foreground">{rival.label}</span>
                <span className="text-xs text-muted-foreground">Waiting</span>
              </button>
            ))}
          </div>
        ) : null}

        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Stake ({nativeSymbol})
          <input
            type="number"
            min="0"
            step="any"
            value={stake}
            onChange={(event) => onStakeChange(event.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            placeholder={`Amount in ${nativeSymbol}`}
            data-challenge-stake
          />
        </label>

        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Duration
          <select
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            value={durationHours}
            onChange={(event) => onDurationChange(parseBattleDurationHours(event.target.value, 24))}
            data-challenge-duration
          >
            {BATTLE_DURATIONS.map((item) => (
              <option key={item.hours} value={item.hours}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        {unauthorizedReason ? (
          <p className="text-sm text-muted-foreground" data-challenge-unauthorized>
            {unauthorizedReason}
          </p>
        ) : null}

        <Button className="font-retro" disabled={!canSend} onClick={onSend} data-send-challenge>
          {busy ? "Sending..." : "SEND CHALLENGE"}
        </Button>
      </div>
    </CommandCenterCard>
  );
}

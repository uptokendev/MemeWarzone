import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { fetchArenaBattleMatches } from "@/features/postgrad/apiClient";
import {
  FIND_MATCH_LIMIT,
  normalizeMatchIdentity,
  presentMatchCandidates,
} from "@/lib/arena/findMatchPresentation.mjs";

type FindMatchPanelProps = {
  tokenId: string;
  chainId?: number | null;
  selectedTargetId?: string;
  onSelectTarget: (tokenId: string) => void;
  onCandidatesChange?: (candidates: ReturnType<typeof presentMatchCandidates>) => void;
};

export function FindMatchPanel({
  tokenId,
  chainId,
  selectedTargetId,
  onSelectTarget,
  onCandidatesChange,
}: FindMatchPanelProps) {
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");
  const [candidates, setCandidates] = useState<ReturnType<typeof presentMatchCandidates>>([]);
  const onCandidatesChangeRef = useRef(onCandidatesChange);
  onCandidatesChangeRef.current = onCandidatesChange;

  useEffect(() => {
    const identity = String(tokenId || "").trim();
    if (!identity) {
      setCandidates([]);
      onCandidatesChangeRef.current?.([]);
      return;
    }

    const controller = new AbortController();
    setBusy(true);
    setWarning("");
    void fetchArenaBattleMatches(identity, chainId, FIND_MATCH_LIMIT, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        const next = presentMatchCandidates(payload);
        setCandidates(next);
        onCandidatesChangeRef.current?.(next);
        if (!payload) setWarning("Match recommendations are unavailable. You can still search a token and send a challenge.");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCandidates([]);
        onCandidatesChangeRef.current?.([]);
        setWarning("Match recommendations are unavailable. You can still search a token and send a challenge.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });

    return () => controller.abort();
  }, [tokenId, chainId]);

  if (!tokenId) return null;

  return (
    <CommandCenterCard
      title="Find Match"
      description="Server-ranked rivals for the coin you selected. Challenge only picks the opponent — you still set stake, duration, and send the challenge."
    >
      <div className="mb-3 flex items-center gap-2 text-muted-foreground">
        <Crosshair className="h-4 w-4 text-accent" />
        <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Opponent recommendations</span>
      </div>
      {busy ? <p className="text-sm text-muted-foreground">Scanning for ranked rivals...</p> : null}
      {warning ? <p className="text-sm text-muted-foreground">{warning}</p> : null}
      {!busy && !warning && !candidates.length ? (
        <p className="text-sm text-muted-foreground">
          No recommended rivals returned. Search a token below — you can still issue a challenge.
        </p>
      ) : null}
      {candidates.length ? (
        <div className="space-y-3">
          {candidates.map((candidate) => {
            const selected = normalizeMatchIdentity(selectedTargetId) === candidate.tokenId;
            return (
              <div
                key={candidate.tokenId}
                className={`mwz-hud-frame space-y-3 p-4 ${selected ? "border-accent/50" : ""}`}
                data-find-match-candidate={candidate.tokenId}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-retro text-sm text-foreground">
                      {candidate.tokenName}{" "}
                      <span className="text-muted-foreground">${candidate.symbol}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <TacticalTag label={candidate.classificationLabel} tone={candidate.ranked ? "success" : "hot"} />
                      <TacticalTag label={candidate.rankedLabel} tone={candidate.ranked ? "sponsored" : "hot"} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Match Quality</div>
                    <div className="font-retro text-lg text-foreground">{candidate.matchQualityLabel || "—"}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <div>
                    MCAP
                    <div className="font-retro text-foreground">{candidate.marketCapLabel}</div>
                  </div>
                  <div>
                    Holders
                    <div className="font-retro text-foreground">{candidate.holdersLabel}</div>
                  </div>
                  <div>
                    Liquidity
                    <div className="font-retro text-foreground">{candidate.liquidityLabel}</div>
                  </div>
                  <div>
                    24h vol
                    <div className="font-retro text-foreground">{candidate.volumeLabel}</div>
                  </div>
                </div>
                <Button type="button" size="sm" className="font-retro" onClick={() => onSelectTarget(candidate.tokenId)}>
                  Challenge
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </CommandCenterCard>
  );
}

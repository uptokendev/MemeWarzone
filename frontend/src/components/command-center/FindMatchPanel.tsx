import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
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
      <div className="mb-3 flex items-center gap-2 font-mw-body text-mw-muted">
        <Crosshair className="h-4 w-4 text-mw-accent" />
        <span className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Opponent recommendations</span>
      </div>
      {busy ? <p className="text-sm text-mw-muted">Scanning for ranked rivals...</p> : null}
      {warning ? <p className="rounded-[10px] border border-[#5A3416] bg-mw-accent-fill px-3 py-2.5 text-sm text-mw-accent-soft">{warning}</p> : null}
      {!busy && !warning && !candidates.length ? (
        <p className="text-sm text-mw-muted">
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
                className={`space-y-3 rounded-[14px] border bg-mw-input p-4 font-mw-body text-mw-text ${selected ? "border-mw-accent-edge" : "border-mw-border"}`}
                data-find-match-candidate={candidate.tokenId}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="break-words font-mw-cond text-lg font-bold text-mw-text">
                      {candidate.tokenName}{" "}
                      <span className="font-mw-body text-sm font-semibold text-mw-muted">${candidate.symbol}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className={candidate.ranked ? "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#1F5133] bg-[#0F2418] px-2.5 text-[13px] font-semibold text-[#6EE7A0]" : "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2.5 text-[13px] font-semibold text-mw-accent-soft"}>{candidate.classificationLabel}</span>
                      <span className={candidate.ranked ? "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-2.5 text-[13px] font-semibold text-[#C9CED4]" : "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2.5 text-[13px] font-semibold text-mw-accent-soft"}>{candidate.rankedLabel}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Match Quality</div>
                    <div className="font-mw-mono text-lg font-bold text-mw-text">{candidate.matchQualityLabel || "—"}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-mw-muted sm:grid-cols-4">
                  <div>
                    MCAP
                    <div className="mt-0.5 break-words font-mw-mono text-sm font-bold text-mw-text">{candidate.marketCapLabel}</div>
                  </div>
                  <div>
                    Holders
                    <div className="mt-0.5 break-words font-mw-mono text-sm font-bold text-mw-text">{candidate.holdersLabel}</div>
                  </div>
                  <div>
                    Liquidity
                    <div className="mt-0.5 break-words font-mw-mono text-sm font-bold text-mw-text">{candidate.liquidityLabel}</div>
                  </div>
                  <div>
                    24h vol
                    <div className="mt-0.5 break-words font-mw-mono text-sm font-bold text-mw-text">{candidate.volumeLabel}</div>
                  </div>
                </div>
                <Button type="button" size="sm" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" onClick={() => onSelectTarget(candidate.tokenId)}>
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

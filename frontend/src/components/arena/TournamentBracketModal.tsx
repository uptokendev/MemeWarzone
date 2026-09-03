import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { identitiesFromEntries, presentSymmetricBracket } from "@/lib/arena/tournamentBracketPresentation.mjs";
import { cn } from "@/lib/utils";

type BracketMatch = {
  id: string;
  tokenA: string;
  tokenB: string | null;
  battleId?: string | null;
  winner?: string | null;
  bye?: boolean;
};

function NodeCard({
  node,
  active = false,
}: {
  node: { symbol?: string | null; name?: string | null; imageUrl?: string | null; won?: boolean; lost?: boolean } | null;
  active?: boolean;
}) {
  if (!node) {
    return <div className="mwz-flat-card h-[3.25rem] opacity-40" />;
  }
  return (
    <div
      data-tournament-bracket-node={node.symbol || "token"}
      data-bracket-winner={node.won ? "true" : undefined}
      className={cn(
        "mwz-flat-card flex items-center gap-2 px-2 py-1.5",
        node.lost && "opacity-45",
        node.won && "border-orange-400/40",
        active && !node.won && "border-orange-400/70",
      )}
    >
      <WarzoneTokenMark imageUrl={node.imageUrl} symbol={node.symbol} name={node.name} size="sm" />
      <div className="min-w-0">
        <div className="truncate font-retro text-xs text-foreground">${node.symbol || "----"}</div>
        {node.won ? <div className="text-[9px] uppercase tracking-[0.14em] text-orange-200">Win</div> : null}
      </div>
    </div>
  );
}

function MatchPair({ match }: { match: ReturnType<typeof presentSymmetricBracket>["left"][number]["matches"][number] }) {
  return (
    <div className="space-y-1" data-tournament-bracket-match={match.id}>
      <NodeCard node={match.left} active={match.live} />
      {match.bye ? (
        <div className="px-2 text-[9px] uppercase tracking-[0.14em] text-white/35">Bye</div>
      ) : (
        <NodeCard node={match.right} active={match.live} />
      )}
    </div>
  );
}

export function TournamentBracketModal({
  open,
  onOpenChange,
  title,
  statusLabel,
  stageLabel,
  rounds,
  entries,
  chainId = 56,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  statusLabel?: string | null;
  stageLabel?: string | null;
  rounds: Array<{ round: number; matches?: BracketMatch[] }>;
  entries?: Array<Record<string, unknown>>;
  chainId?: number;
}) {
  const identities = identitiesFromEntries(entries);
  const bracket = presentSymmetricBracket(rounds, identities);
  const champion = bracket.championship?.champion || null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-bracket-modal="true"
        data-bracket-chain={chainId}
        className="max-h-[90vh] w-[95vw] max-w-[95vw] overflow-hidden border bg-[#050505] p-4 md:max-h-[88vh] md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="font-retro text-xl text-foreground">{title}</DialogTitle>
          <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">
            {[statusLabel, stageLabel].filter(Boolean).join(" · ") || "Tournament bracket"}
          </DialogDescription>
        </DialogHeader>
        {bracket.empty ? (
          <p className="py-8 text-sm text-muted-foreground">The bracket appears after the roster locks.</p>
        ) : (
          <div className="overflow-x-auto overflow-y-auto" data-tournament-bracket-scroll="true">
            <div className="flex min-w-[64rem] items-stretch gap-4 pb-4 pt-2">
              {bracket.left.map((column) => (
                <div key={`left-${column.round}`} className="flex min-w-[9.5rem] flex-1 flex-col justify-around gap-4">
                  <div className="text-center text-[10px] uppercase tracking-[0.16em] text-white/45">{column.label}</div>
                  {column.matches.map((match) => (
                    <MatchPair key={match.id} match={match} />
                  ))}
                </div>
              ))}
              <div className="flex min-w-[12rem] flex-col items-center justify-center gap-3 px-3" data-tournament-championship="true">
                <div className="text-[10px] uppercase tracking-[0.18em] text-orange-200">Championship</div>
                {champion ? (
                  <div className="mwz-flat-card flex flex-col items-center p-4 text-center">
                    <WarzoneTokenMark imageUrl={champion.imageUrl} symbol={champion.symbol} name={champion.name} size="lg" />
                    <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-orange-200">Champion</div>
                    <div className="font-retro text-lg text-foreground">${champion.symbol}</div>
                  </div>
                ) : bracket.championship ? (
                  <div className="mwz-flat-card space-y-2 p-3 text-center">
                    <div className="font-retro text-sm">${bracket.championship.left?.symbol || "----"}</div>
                    <div className="font-retro text-orange-400">VS</div>
                    <div className="font-retro text-sm">${bracket.championship.right?.symbol || "----"}</div>
                  </div>
                ) : (
                  <div className="text-xs uppercase tracking-[0.14em] text-white/40">Pending</div>
                )}
              </div>
              {bracket.right.map((column) => (
                <div key={`right-${column.round}`} className="flex min-w-[9.5rem] flex-1 flex-col justify-around gap-4">
                  <div className="text-center text-[10px] uppercase tracking-[0.16em] text-white/45">{column.label}</div>
                  {column.matches.map((match) => (
                    <MatchPair key={match.id} match={match} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

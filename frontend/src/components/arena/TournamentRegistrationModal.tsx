import { useState } from "react";
import { Link } from "react-router-dom";
import { ArenaBuyInButton } from "@/components/arena/ArenaBuyInButton";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TournamentTokenIdentity } from "@/components/arena/TournamentTokenIdentity";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTournamentCommandState } from "@/hooks/useTournamentCommandState";
import { cn } from "@/lib/utils";

export function TournamentRegistrationModal({
  tournamentId,
  open,
  onOpenChange,
  onViewBracket,
}: {
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewBracket?: () => void;
}) {
  const [bracketOpen, setBracketOpen] = useState(false);
  const state = useTournamentCommandState(open ? tournamentId : "", { loadMetrics: false });
  const card = state.card;
  const selected = state.eligible.find((item) => item.tokenId === state.selectedToken);
  const entered = state.optedIn && (!state.needsBuyIn || state.buyInPaid);
  const payBuyIn = state.optedIn && state.needsBuyIn && !state.buyInPaid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-registration-modal="true"
        data-tournament-details-modal="true"
        className="max-h-[90vh] w-[95vw] max-w-lg overflow-y-auto border bg-[#050505] p-4 md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="font-black text-xl text-foreground">{card?.title || "Tournament"}</DialogTitle>
          <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">
            {[card?.status.label, card?.chain?.label, card?.participantCount != null ? `${card.participantCount} CONTENDERS` : null, card?.dateTimeLabel || card?.dateLabel]
              .filter(Boolean)
              .join(" · ")}
          </DialogDescription>
        </DialogHeader>

        {!state.tournament ? (
          <p className="text-sm text-muted-foreground">This tournament could not be loaded.</p>
        ) : (
          <div data-tournament-opt-in="true" className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <TacticalTag label={card?.status.label || "UPCOMING"} tone="default" />
              {card?.chain ? <TacticalTag label={card.chain.label} tone="default" /> : null}
              {card?.registration ? <TacticalTag label={card.registration.label} tone={card.registration.key === "open" ? "success" : "default"} /> : null}
            </div>

            <section>
              <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Registration</div>
              <h3 className="mt-1 font-black text-sm uppercase tracking-[0.12em] text-foreground">Your token</h3>
              {!state.walletAddress ? (
                <p className="mt-2 text-sm text-muted-foreground">Connect the owner wallet to opt in.</p>
              ) : !state.eligible.length ? (
                <div className="mt-3 space-y-2" data-tournament-no-eligible="true">
                  <div className="font-black text-sm uppercase tracking-[0.12em] text-foreground">No eligible coins on this wallet</div>
                  <p className="text-sm text-muted-foreground">Only eligible post-grad coins can enter this tournament.</p>
                  <Link
                    to={`/profile/${encodeURIComponent(state.walletAddress)}/command/coins`}
                    className="inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] text-accent hover:underline"
                  >
                    View your coins
                  </Link>
                </div>
              ) : (
                <div className="mt-2 space-y-1" data-tournament-eligible-select="true">
                  {state.eligible.length > 1 ? (
                    <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-white/45">Select your contender</div>
                  ) : null}
                  {state.eligible.map((item) => {
                    const active = item.tokenId === state.selectedToken;
                    return (
                      <button
                        key={item.tokenId}
                        type="button"
                        onClick={() => state.setSelectedToken(item.tokenId)}
                        className={cn(
                          "flex w-full items-center gap-2 border px-2 py-2 text-left",
                          active ? "border-orange-400/50 bg-orange-500/[0.06]" : "border-transparent hover:border-white/15",
                        )}
                      >
                        <span className={cn("h-2.5 w-2.5 rounded-full border", active ? "border-orange-300 bg-orange-400" : "border-white/35")} />
                        <TournamentTokenIdentity
                          chainId={state.tournamentChainId}
                          tokenAddress={item.tokenId}
                          symbol={item.symbol}
                          tokenName={item.tokenName}
                          imageUrl={item.imageUrl}
                          compact
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {state.buyInMeta ? (
              <section>
                <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Entry</div>
                <div className="mt-1 font-black text-lg text-foreground">{state.buyInMeta.label}</div>
              </section>
            ) : null}

            <section>
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Registration status</div>
              <div className="mt-1 text-sm uppercase tracking-[0.14em] text-white/70">
                {!state.walletAddress ? "Connect wallet" : !state.eligible.length ? "No eligible coins" : entered ? "Entered" : payBuyIn ? "Pay buy-in" : "Ready"}
              </div>
            </section>

            {state.walletAddress && state.eligible.length ? (
              <div className="flex flex-col gap-2">
                {!entered && !payBuyIn ? (
                  <button
                    type="button"
                    disabled={state.busy || !state.selectedToken}
                    onClick={() => void state.handleOptIn()}
                    className="mwz-button inline-flex min-h-11 items-center justify-center px-4 text-xs uppercase tracking-[0.16em] disabled:opacity-60"
                  >
                    {state.busy ? "Recording..." : "Enter tournament"}
                  </button>
                ) : null}
                {payBuyIn && selected ? (
                  <ArenaBuyInButton
                    tournamentId={state.id}
                    tokenAddress={selected.tokenId}
                    chainId={state.tournamentChainId}
                    poolId={state.warPoolMeta.onchainPoolId}
                    configured={state.warPoolMeta.configured}
                    live={state.warPoolMeta.live}
                    opened={state.warPoolMeta.onchainOpened}
                    buyInPaid={state.buyInPaid}
                    buyInNative={state.buyIn}
                    nativeSymbol={state.symbol}
                    onDone={() => {
                      void state.reloadDetail();
                      void state.refreshPool(state.id);
                    }}
                  />
                ) : null}
                {entered ? (
                  <div className="inline-flex min-h-11 items-center justify-center px-4 text-xs uppercase tracking-[0.16em] text-white/55">Entered</div>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              data-tournament-view-bracket={state.id}
              onClick={() => {
                if (onViewBracket) onViewBracket();
                else setBracketOpen(true);
              }}
              className="inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] text-accent hover:underline"
            >
              View bracket
            </button>
            <TournamentBracketModal
              open={bracketOpen}
              onOpenChange={setBracketOpen}
              title={card?.title || "Tournament"}
              statusLabel={card?.status.label}
              stageLabel={card?.bracketStage}
              rounds={state.bracketRounds}
              entries={state.entries}
              chainId={state.tournamentChainId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

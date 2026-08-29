import { Link, useParams } from "react-router-dom";
import { ArrowLeftRight, BellRing, Flame, Globe, MessagesSquare, Shield, Swords, Users } from "lucide-react";
import { BattleCard, MockModeBanner, TacticalHint, TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { PostGradStatusStrip } from "@/components/postgrad/PostGradStatusStrip";
import { Button } from "@/components/ui/button";
import { getMockBattleForToken } from "@/features/postgrad/mockRegistry";
import { useMockWarRoomToken } from "@/hooks/useMockWarRoomRuntime";

const sentimentCopy = {
  heating_up: "Heat climbing fast",
  stable: "Steady battle posture",
  volatile: "High swing candidate",
} as const;

const styleCopy = {
  momentum: "Momentum battle profile",
  holder_grind: "Holder-grind profile",
  whale_surge: "Whale-surge profile",
  community_swarm: "Community-swarm profile",
} as const;

const MockTokenDetails = () => {
  const { tokenId } = useParams();
  const { token, toggleMockWarRoomWatchlist } = useMockWarRoomToken(tokenId);

  if (!token) {
    return (
      <div className="space-y-4 px-1 pb-10">
        <div className="rounded-2xl border border-white/10 bg-black/25 p-6 text-white/70">
          <div className="text-lg font-semibold text-white">Mock token not found</div>
          <p className="mt-2">This frontend test route expects a token from the post-grad mock roster.</p>
          <Link to="/warzone" className="mt-4 inline-flex text-sm text-accent hover:text-accent/80">
            Return to Warzone
          </Link>
        </div>
      </div>
    );
  }

  const battleDetails = getMockBattleForToken(token.id);

  return (
    <div className="space-y-6 px-1 pb-10">
      <MockModeBanner subject="Mock token sandbox" />
      <PostGradStatusStrip />

      <section className="rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.14),transparent_28%),linear-gradient(180deg,rgba(13,15,20,0.92),rgba(6,7,10,0.98))] p-5 md:p-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="text-[10px] uppercase tracking-[0.32em] text-accent/80">Mock memecoin sandbox</div>
            <h1 className="mt-2 text-3xl font-semibold text-white md:text-5xl">{token.name} frontend test profile.</h1>
            <p className="mt-3 max-w-2xl text-sm text-white/70 md:text-base">This is a frontend-only token profile built to test navigation, battle discovery, intel panels, and call-to-action flow before real post-grad APIs are wired in.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <TacticalTag label={sentimentCopy[token.sentiment]} tone={token.sentiment === "heating_up" ? "hot" : token.sentiment === "stable" ? "success" : "default"} />
            <TacticalTag label={styleCopy[token.battleStyle]} tone="sponsored" />
            {token.watched ? <TacticalTag label="Watched in War Room" tone="success" /> : null}
            <TacticalHint label="Frontend-only" body="This route is intentionally isolated from live token infrastructure so battle and event flows can be QA'd safely." />
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
          <div className="flex flex-wrap items-center gap-2">
            {token.tacticalTags.map((tag) => (
              <TacticalTag key={tag} label={tag} tone={tag === "Sponsored" ? "sponsored" : tag === "Featured" ? "hot" : "default"} />
            ))}
          </div>
          <div className="mt-4 text-xl font-semibold text-white">{token.symbol}</div>
          <p className="mt-3 text-sm text-white/70">{token.thesis}</p>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Market cap</div>
              <div className="mt-1 text-lg font-semibold text-white">${(token.marketCapUsd / 1000000).toFixed(2)}M</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Liquidity</div>
              <div className="mt-1 text-lg font-semibold text-white">${(token.liquidityUsd / 1000).toFixed(0)}K</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Watchlists</div>
              <div className="mt-1 text-lg font-semibold text-white">{token.effectiveWatchlistCount.toLocaleString()}</div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Quick actions</div>
          <div className="mt-4 space-y-3 text-sm text-white/70">
            <Button
              size="sm"
              variant={token.watched ? "default" : "outline"}
              onClick={() => toggleMockWarRoomWatchlist(token.id)}
              className="w-full justify-start"
            >
              {token.watched ? "Remove from War Room watchlist" : "Add to War Room watchlist"}
            </Button>
            <Link to={`/war-room?search=${encodeURIComponent(token.symbol)}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10">
              <ArrowLeftRight className="h-4 w-4 text-accent" />
              Open War Room filtered to this token
            </Link>
            {battleDetails ? (
              <Link to={`/battle/${battleDetails.id}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10">
                <Swords className="h-4 w-4 text-accent" />
                Jump into related battle
              </Link>
            ) : null}
            <Link to="/events" className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10">
              <BellRing className="h-4 w-4 text-accent" />
              Review event deployment lane
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Commander notes</div>
          <ul className="mt-4 space-y-3 text-sm text-white/70">
            {token.commanderNotes.map((note) => (
              <li key={note} className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                {note}
              </li>
            ))}
          </ul>
          <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
            <div className="flex items-center gap-2 text-white">
              <Shield className="h-4 w-4 text-accent" />
              Testing posture
            </div>
            <div className="mt-2">Use this page to verify route continuity: Arena → Mock Token → Battle → War Room → Events.</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Mock trade tape</div>
          <div className="mt-4 space-y-3">
            {token.mockTrades.map((trade) => (
              <div key={`${trade.timeLabel}-${trade.traderLabel}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
                <div>
                  <div className="font-semibold text-white">{trade.traderLabel}</div>
                  <div className="text-xs text-white/50">{trade.timeLabel}</div>
                </div>
                <div className="flex items-center gap-3">
                  <TacticalTag label={trade.side} tone={trade.side === "buy" ? "success" : "default"} />
                  <div className="text-white">{trade.sizeLabel}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <a href={token.socials.website} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70 hover:bg-white/10">
              <Globe className="h-4 w-4 text-accent" />
              Website
            </a>
            <a href={token.socials.x} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70 hover:bg-white/10">
              <Flame className="h-4 w-4 text-accent" />
              X feed
            </a>
            <a href={token.socials.telegram} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70 hover:bg-white/10">
              <MessagesSquare className="h-4 w-4 text-accent" />
              Telegram
            </a>
          </div>
        </div>
      </section>

      {battleDetails ? <BattleCard battle={battleDetails} ctaLabel="Re-open battle route" /> : null}

      <section className="rounded-2xl border border-white/10 bg-black/25 p-5 text-sm text-white/70">
        <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Flow checkpoints</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2 text-white"><Users className="h-4 w-4 text-accent" /> Discovery</div>
            <div className="mt-2">Arena cards and War Room rows should both route cleanly here.</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2 text-white"><Swords className="h-4 w-4 text-accent" /> Battle</div>
            <div className="mt-2">Related battle CTA should preserve the mock context and highlight the matching token.</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2 text-white"><BellRing className="h-4 w-4 text-accent" /> Event lane</div>
            <div className="mt-2">Event and league routes stay reachable from the same test roster without backend dependencies.</div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default MockTokenDetails;

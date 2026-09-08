import { Link } from "react-router-dom";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";

type IntelSide = {
  side: "left" | "right";
  ticker: string;
  name?: string | null;
  tokenId?: string | null;
  ownerWallet?: string | null;
  ownerLabel?: string | null;
  liquidityLabel?: string | null;
  marketCapLabel?: string | null;
  originLabel?: string | null;
};

type IntelModel = {
  chainLabel?: string | null;
  typeLabel?: string | null;
  originLabel?: string | null;
  classification?: string | null;
  matchQualityLabel?: string | null;
  scoringGeneration?: string | null;
  healthLabel?: string | null;
  realtimeLabel?: string | null;
  dataSourceLabel?: string | null;
  combinedMcapLabel?: string | null;
  left: IntelSide;
  right: IntelSide;
};

function CopyableWallet({ wallet, label }: { wallet: string; label: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet);
    } catch {
      // Clipboard can be denied; the full address remains on title.
    }
  }

  return (
    <button
      type="button"
      title={wallet}
      onClick={() => void copy()}
      className="truncate text-left text-xs text-white/78 underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {label}
    </button>
  );
}

function IntelFact({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 py-1.5 last:border-b-0">
      <span className="text-white/42">{label}</span>
      <span className="text-right font-medium text-white/82">{value}</span>
    </div>
  );
}

function SideIntel({ side, chainId }: { side: IntelSide; chainId?: number }) {
  const href = side.tokenId ? getArenaTokenRoute(side.tokenId, chainId) : null;
  return (
    <div data-battle-intel-side={side.side} className="mwz-hud-frame space-y-3 p-3">
      <div>
        <div className="font-retro text-lg text-foreground">{side.ticker}</div>
        {side.name ? <div className="text-[11px] uppercase tracking-[0.16em] text-white/50">{side.name}</div> : null}
      </div>
      <div className="space-y-1 text-[10px] uppercase tracking-[0.16em]">
        {side.originLabel ? <IntelFact label="Origin" value={side.originLabel} /> : null}
        {side.ownerWallet && side.ownerLabel ? (
          <div className="flex items-center justify-between gap-3 border-b border-white/10 py-1.5">
            <span className="text-white/42">Commander</span>
            <CopyableWallet wallet={side.ownerWallet} label={side.ownerLabel} />
          </div>
        ) : null}
        {side.liquidityLabel ? <IntelFact label="Liquidity" value={side.liquidityLabel} /> : null}
        {side.marketCapLabel ? <IntelFact label="MCAP" value={side.marketCapLabel} /> : null}
      </div>
      {href ? (
        <Link
          to={href}
          className="inline-flex text-[10px] uppercase tracking-[0.16em] text-white/70 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Token intel
        </Link>
      ) : null}
    </div>
  );
}

export function BattleIntel({ intel, chainId }: { intel: IntelModel; chainId?: number }) {
  return (
    <section data-battle-intel="true" className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle intel</div>
      <div className="grid gap-3 md:grid-cols-2">
        <SideIntel side={intel.left} chainId={chainId} />
        <SideIntel side={intel.right} chainId={chainId} />
      </div>
      <div className="grid gap-1 text-[10px] uppercase tracking-[0.16em] text-white/70">
        <IntelFact label="Chain" value={intel.chainLabel} />
        <IntelFact label="Battle type" value={intel.typeLabel} />
        {intel.classification ? <IntelFact label="Class" value={intel.classification} /> : null}
        {intel.matchQualityLabel ? <IntelFact label="Match quality" value={intel.matchQualityLabel} /> : null}
        {intel.combinedMcapLabel ? <IntelFact label="Combined MCAP" value={intel.combinedMcapLabel} /> : null}
        {intel.scoringGeneration ? <IntelFact label="Scoring generation" value={intel.scoringGeneration} /> : null}
        {intel.healthLabel ? <IntelFact label="Data health" value={intel.healthLabel} /> : null}
        {intel.dataSourceLabel ? <IntelFact label="Source" value={intel.dataSourceLabel} /> : null}
        {intel.realtimeLabel ? <IntelFact label="Realtime" value={intel.realtimeLabel} /> : null}
      </div>
    </section>
  );
}

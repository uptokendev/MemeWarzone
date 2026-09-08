import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { getPostGradTokenDetailRoute } from "@/features/postgrad/identityRoutes";

interface CoinRowItem {
  id: string;
  type: 'draft' | 'coin' | 'imported';
  name: string;
  ticker: string;
  image: string;
  status?: string;
  statusLabel?: string;
  statusTone?: string;
  marketCap?: string;
  battleInfo?: string;
  battleRouteId?: string | null;
  tokenRoute?: string | null;
  visibility?: string;
  updatedAt?: string;
  category?: string;
  href?: string;
  raw?: any;
  isOpening?: boolean;
  creatorState?: string;
  /** Graduated Topaz pool address when known */
  pairAddress?: string | null;
  lpFeeSummary?: string | null;
  canClaimLpFees?: boolean;
  claimingLpFees?: boolean;
}

interface CommandCenterCoinRowProps {
  item: CoinRowItem;
  onOpenForBattle?: (campaignAddress: string, name: string) => void;
  onClaimLpFees?: (campaignAddress: string) => void;
  battleBusyToken?: string | null;
  battleFeaturesEnabled?: boolean;
}

export function CommandCenterCoinRow({
  item,
  onOpenForBattle,
  onClaimLpFees,
  battleBusyToken,
  battleFeaturesEnabled = false,
}: CommandCenterCoinRowProps) {
  const [expanded, setExpanded] = useState(false);

  const isDraft = item.type === 'draft';
  const isImported = item.type === 'imported';
  const tokenRoute = item.tokenRoute || item.href || (item.type === 'coin' ? getPostGradTokenDetailRoute(item.id) : null);
  const showBattleInfo = battleFeaturesEnabled && Boolean(item.battleInfo);
  const identityClassName = "min-w-0 rounded-xl text-left transition-colors hover:bg-white/[0.03]";
  const identity = (
          <div className="flex items-center gap-2.5">
            <img
              src={item.image}
              alt={item.name}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/placeholder.svg"; }}
              className="h-9 w-9 rounded-lg border border-white/10 object-cover lg:h-10 lg:w-10"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="truncate text-[13px] font-semibold text-white lg:text-[15px]">{item.ticker || item.name}</div>
                <div className="truncate text-[11px] font-semibold text-white/45 lg:text-sm">{item.name}</div>
                {isImported && (
                  <TacticalTag label="IMPORTED" tone="sponsored" />
                )}
                {item.statusLabel && (
                  <TacticalTag label={item.statusLabel} tone={(item.statusTone as any) || "default"} />
                )}
                {showBattleInfo && (
                  <TacticalTag label={item.battleInfo || ""} tone="hot" />
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-white/55">
                {item.marketCap && <span>MC {item.marketCap}</span>}
                {isDraft && item.visibility && <span>{item.visibility}</span>}
                {item.category && <span>{item.category}</span>}
              </div>
            </div>
          </div>
  );

  return (
    <div className="border-b border-white/8 last:border-b-0">
      <div className="grid grid-cols-1 gap-2 px-2.5 py-2.5 transition-colors hover:bg-white/[0.025] lg:grid-cols-[minmax(280px,1.4fr)_100px_100px_100px_28px] lg:items-center lg:gap-3 lg:px-4 lg:py-2.5">
        {isImported && tokenRoute ? (
          <Link to={tokenRoute} className={identityClassName} data-imported-project-row="true">
            {identity}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={identityClassName}
          >
            {identity}
          </button>
        )}

        <div className="hidden lg:block text-sm font-semibold text-white">
          {item.marketCap || "—"}
        </div>
        <div className="hidden lg:block text-sm font-semibold text-white">
          {item.marketCap || "—"}
        </div>
        <div className="hidden lg:block text-sm font-semibold text-white">
          {item.marketCap || "—"}
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="ml-auto h-8 px-2 lg:col-start-5 lg:ml-0 lg:justify-self-end"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="mx-2.5 mb-2.5 rounded-[18px] border border-white/10 bg-white/[0.04] p-3 md:mx-3 md:mb-3 md:p-4">
          <div className="space-y-3 text-sm">
            {isDraft ? (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Draft Info</div>
                  <div className="mt-1 text-white/80">Status: {item.status} • Visibility: {item.visibility} • Updated: {item.updatedAt}</div>
                </div>
                {item.href && (
                  <Button asChild size="sm" variant="outline" className="w-full justify-between">
                    <Link to={item.href}>Edit Draft</Link>
                  </Button>
                )}
              </>
            ) : isImported ? (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Imported project</div>
                  <div className="mt-1 text-white/80">{item.statusLabel || "IMPORTED"}</div>
                </div>
                {tokenRoute ? (
                  <Button asChild size="sm" variant="outline" className="w-full justify-between">
                    <Link to={tokenRoute}>Open imported project</Link>
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Coin Info</div>
                  <div className="mt-1 text-white/80">Market Cap: {item.marketCap || "—"}</div>
                  {showBattleInfo && <div className="text-accent">Current: {item.battleInfo}</div>}
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  {item.tokenRoute && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={item.tokenRoute}>Token Details</Link>
                    </Button>
                  )}

                  {item.canClaimLpFees && onClaimLpFees ? (
                    <Button
                      size="sm"
                      className="bg-accent text-white hover:bg-accent/90 hover:text-white"
                      disabled={item.claimingLpFees}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClaimLpFees(item.id);
                      }}
                    >
                      {item.claimingLpFees ? "Claiming LP fees…" : "Claim LP fees"}
                    </Button>
                  ) : null}
                  {item.lpFeeSummary ? (
                    <div className="w-full text-[11px] text-white/55">{item.lpFeeSummary}</div>
                  ) : null}

                  {battleFeaturesEnabled && item.creatorState === "eligible" && onOpenForBattle && (
                    <Button
                      size="sm"
                      disabled={item.isOpening || battleBusyToken === item.id}
                      onClick={() => onOpenForBattle(item.id, item.name)}
                    >
                      {item.isOpening || battleBusyToken === item.id ? "Opening..." : "Open for Battle"}
                    </Button>
                  )}

                  {battleFeaturesEnabled && item.battleRouteId && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/battle/${item.battleRouteId}`}>
                        {item.creatorState?.includes("battle") ? "View Battle" : "Battle Details"}
                      </Link>
                    </Button>
                  )}

                  {battleFeaturesEnabled && item.battleInfo === "Open for Battle" && (
                    <Button size="sm" variant="default">
                      <Swords className="mr-2 h-4 w-4" />
                      Challenge
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

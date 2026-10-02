import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Swords } from "lucide-react";
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
  onChallenge?: (tokenId: string) => void;
  onClaimLpFees?: (campaignAddress: string) => void;
  battleBusyToken?: string | null;
  battleFeaturesEnabled?: boolean;
}

export function CommandCenterCoinRow({
  item,
  onOpenForBattle,
  onChallenge,
  onClaimLpFees,
  battleBusyToken,
  battleFeaturesEnabled = false,
}: CommandCenterCoinRowProps) {
  const [expanded, setExpanded] = useState(false);

  const isDraft = item.type === 'draft';
  const isImported = item.type === 'imported';
  const tokenRoute = item.tokenRoute || item.href || (item.type === 'coin' ? getPostGradTokenDetailRoute(item.id) : null);
  const showBattleInfo = battleFeaturesEnabled && Boolean(item.battleInfo);
  const displayedTicker = isImported
    ? (item.ticker && item.ticker !== "???" ? `$${item.ticker}` : item.name)
    : (item.ticker || item.name);
  const identityClassName = "mw-focus min-w-0 flex-1 rounded-[10px] text-left text-mw-text hover:text-mw-text";
  const chip = "inline-flex h-[22px] shrink-0 items-center rounded-full border px-2 text-xs font-semibold";
  const toneClass = (tone?: string) =>
    tone === "success" ? "border-[#1F5133] text-[#6EE7A0]" : tone === "hot" || tone === "sponsored" ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft" : "border-mw-edge text-[#C9CED4]";
  const actionButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50";
  const primaryButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02] disabled:opacity-50";
  const identity = (
          <div className="flex min-w-0 items-center gap-3">
            <img
              src={item.image}
              alt={item.name}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/placeholder.svg"; }}
              className="h-12 w-12 shrink-0 rounded-[10px] border border-mw-border object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate font-bold">{displayedTicker}</div>
                {item.name && item.name !== displayedTicker ? <span className="hidden truncate text-sm text-mw-muted sm:inline">{item.name}</span> : null}
              </div>
              <div className="truncate font-mw-mono text-xs text-mw-muted">
                {[item.marketCap ? `mcap ${item.marketCap}` : null, isDraft ? item.visibility : null, item.category].filter(Boolean).join(" · ") || (isDraft ? "Draft" : "—")}
              </div>
            </div>
          </div>
  );

  return (
    <div className="rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text">
      <div className="flex flex-wrap items-center gap-3 p-3">
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

        <div className="flex flex-wrap items-center gap-1.5">
          {isImported && <span className={`${chip} ${toneClass("sponsored")}`}>Imported</span>}
          {item.statusLabel && <span className={`${chip} ${toneClass(item.statusTone)}`}>{item.statusLabel}</span>}
          {showBattleInfo && <span className={`${chip} ${toneClass("hot")}`}>{item.battleInfo}</span>}
        </div>

        {item.type === "coin" ? (
          <Link to={`/token/${encodeURIComponent(item.id)}/edit`} className={actionButton}>
            Edit page
          </Link>
        ) : null}

        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mw-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[#1E2329] px-3 pb-3 pt-2.5 text-sm">
          <div className="flex flex-col gap-2.5">
            {isDraft ? (
              <>
                <div className="text-mw-muted">Status: {item.status} • Visibility: {item.visibility} • Updated: {item.updatedAt}</div>
                {item.href && (
                  <div className="flex flex-wrap gap-2">
                    <Link to={item.href} className={actionButton}>Edit Draft</Link>
                  </div>
                )}
              </>
            ) : isImported ? (
              <>
                <div className="text-mw-muted">{item.statusLabel || "IMPORTED"}{item.battleInfo ? ` · ${item.battleInfo}` : ""}</div>
                <div className="flex flex-wrap gap-2">
                  {tokenRoute ? (
                    <Link to={tokenRoute} className={actionButton}>Open imported project</Link>
                  ) : null}
                  {item.creatorState === "eligible" && onOpenForBattle ? (
                    <button type="button" className={primaryButton} disabled={item.isOpening || battleBusyToken === item.id} onClick={() => onOpenForBattle(item.raw?.tokenAddress || item.id, item.name)}>
                      {item.isOpening || battleBusyToken === item.id ? "Opening..." : "Open for Battle"}
                    </button>
                  ) : null}
                  {onChallenge ? (
                    <button type="button" className={primaryButton} onClick={() => onChallenge(String(item.raw?.tokenAddress || item.tokenRoute || item.id))}>
                      <Swords className="h-4 w-4" aria-hidden="true" />
                      Challenge
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="text-mw-muted">
                  Market cap: <span className="font-mw-mono text-mw-text">{item.marketCap || "—"}</span>
                  {showBattleInfo && <span className="ml-2 text-mw-accent-soft">Current: {item.battleInfo}</span>}
                </div>

                <div className="flex flex-wrap gap-2">
                  {item.tokenRoute && (
                    <Link to={item.tokenRoute} className={actionButton}>Token Details</Link>
                  )}

                  {item.canClaimLpFees && onClaimLpFees ? (
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={item.claimingLpFees}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClaimLpFees(item.id);
                      }}
                    >
                      {item.claimingLpFees ? "Claiming LP fees…" : "Claim LP fees"}
                    </button>
                  ) : null}

                  {battleFeaturesEnabled && item.creatorState === "eligible" && onOpenForBattle && (
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={item.isOpening || battleBusyToken === item.id}
                      onClick={() => onOpenForBattle(item.id, item.name)}
                    >
                      {item.isOpening || battleBusyToken === item.id ? "Opening..." : "Open for Battle"}
                    </button>
                  )}

                  {battleFeaturesEnabled && item.battleRouteId && (
                    <Link to={`/battle/${item.battleRouteId}`} className={actionButton}>
                      {item.creatorState?.includes("battle") ? "View Battle" : "Battle Details"}
                    </Link>
                  )}

                  {battleFeaturesEnabled && item.battleInfo === "Open for Battle" && (
                    <button type="button" className={primaryButton}>
                      <Swords className="h-4 w-4" aria-hidden="true" />
                      Challenge
                    </button>
                  )}
                </div>
                {item.lpFeeSummary ? (
                  <div className="text-xs text-mw-muted">{item.lpFeeSummary}</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

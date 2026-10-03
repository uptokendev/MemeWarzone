import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CampaignCard } from "@/components/home/CampaignCard";
import { FeaturedCampaignCard } from "@/components/home/FeaturedCampaignCard";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { cp } from "@/components/token/coinPageStyles";
import { formatCompactUsd } from "@/features/postgrad/warRoomMetrics";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import type { PortfolioHolding } from "@/lib/profileApi";

type Section = "created" | "platform" | "imported" | "wallet";

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Public profile Coins tab (founder, 2026-10-03): Created coins, coins from MemeWarzone in the wallet and
 * imported coins in the wallet as full cards, and every token in the wallet as a list with its value.
 * Holdings come from /api/profile/portfolio; `holdings` null means an API without the list.
 */
export function ProfileCoinsTab({
  createdGrid,
  createdCount,
  holdings,
  loadingHoldings,
  chainId,
}: {
  createdGrid: ReactNode;
  createdCount: number;
  holdings: PortfolioHolding[] | null;
  loadingHoldings: boolean;
  chainId: number;
}) {
  const navigate = useNavigate();
  const list = holdings || [];
  const launched = list.filter((h) => h.kind === "launched");
  const imported = list.filter((h) => h.kind === "imported");
  const counts: Record<Section, number> = { created: createdCount, platform: launched.length, imported: imported.length, wallet: list.length };
  const [section, setSection] = useState<Section>("created");
  const [picked, setPicked] = useState(false);
  // Open on the first section that has something, until the visitor picks one.
  useEffect(() => {
    if (picked) return;
    const first = (["created", "platform", "imported", "wallet"] as Section[]).find((s) => counts[s] > 0);
    if (first) setSection(first);
  }, [picked, counts.created, counts.platform, counts.imported, counts.wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  const empty = `${cp.card} p-4 text-sm text-mw-muted`;
  const grid = "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4";
  const pathFor = (h: PortfolioHolding) => tokenDetailsPath({ tokenAddress: h.mint, campaignAddress: h.campaignAddress || h.mint, chainId }, { chainId });
  const waiting = loadingHoldings && !holdings;

  const tabs: Array<{ key: Section; label: string }> = [
    { key: "created", label: "Created" },
    { key: "platform", label: "On MemeWarzone" },
    { key: "imported", label: "Imported" },
    { key: "wallet", label: "In wallet" },
  ];

  let body: ReactNode;
  if (section === "created") {
    body = createdGrid;
  } else if (waiting) {
    body = <div className={empty}>Loading the wallet...</div>;
  } else if (section === "platform") {
    body = launched.length ? (
      <div className={grid}>
        {launched.map((h) => {
          const graduated = /dex|graduat/i.test(String(h.marketStage || ""));
          return (
            <CampaignCard
              key={`l:${h.mint}`}
              chainIdForStorage={chainId}
              vm={{
                campaignAddress: String(h.campaignAddress || h.mint || ""),
                tokenAddress: h.mint,
                name: h.name || h.ticker || "Coin",
                symbol: h.ticker || "",
                logoURI: h.image || undefined,
                marketCapUsdLabel: h.marketCapUsd != null ? formatCompactUsd(h.marketCapUsd) : null,
                progressPct: graduated ? 100 : null,
                isDexTrading: graduated,
              }}
            />
          );
        })}
      </div>
    ) : (
      <div className={empty}>No coins launched on MemeWarzone in this wallet.</div>
    );
  } else if (section === "imported") {
    body = imported.length ? (
      <div className={grid}>
        {imported.map((h) => (
          <FeaturedCampaignCard
            key={`i:${h.mint}`}
            rank={0}
            name={h.name || h.ticker || "Coin"}
            symbol={h.ticker}
            imageUrl={h.image}
            mcapUsdLabel={h.marketCapUsd != null ? formatCompactUsd(h.marketCapUsd) : null}
            layout="grid"
            onOpen={() => navigate(pathFor(h))}
            actions={
              h.mint ? (
                <ArenaUpvoteDialog
                  tokenAddress={h.mint}
                  chainId={chainId}
                  className="h-10 w-full rounded-[10px] border border-mw-edge bg-mw-raised text-sm font-semibold text-mw-text hover:border-mw-accent hover:bg-mw-accent hover:text-[#140A02]"
                  buttonVariant="ghost"
                  buttonSize="sm"
                />
              ) : null
            }
          />
        ))}
      </div>
    ) : (
      <div className={empty}>No imported MemeWarzone coins in this wallet.</div>
    );
  } else {
    body = list.length ? (
      <div className={`${cp.card} flex flex-col px-4 py-1`} data-profile-wallet-list="true">
        {list.map((h) => {
          const content = (
            <>
              <img
                src={h.image || "/placeholder.svg"}
                alt=""
                className="h-9 w-9 shrink-0 rounded-lg border border-mw-border object-cover"
                onError={(event) => { (event.currentTarget as HTMLImageElement).src = "/placeholder.svg"; }}
              />
              <span className="min-w-0 flex-1">
                <b className="block truncate">{h.ticker ? `$${String(h.ticker).replace(/^\$/, "")}` : h.name || "Token"}</b>
                <span className="block truncate text-xs text-mw-muted">
                  {h.name || ""}
                  {h.kind === "imported" ? " · Imported on MemeWarzone" : h.kind === "launched" ? " · Launched on MemeWarzone" : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {h.valueUsd > 0 ? <b className="block font-mw-mono">{usd(h.valueUsd)}</b> : null}
                <span className="block font-mw-mono text-xs text-mw-muted">{Number(h.balanceFormatted).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </span>
            </>
          );
          const row = "flex min-h-14 items-center gap-3 border-b border-[#1E2329] py-2 text-mw-text last:border-b-0";
          return h.platform ? (
            <Link key={`w:${h.mint}`} to={pathFor(h)} className={`${row} hover:text-mw-text`}>{content}</Link>
          ) : (
            <div key={`w:${h.mint}`} className={row}>{content}</div>
          );
        })}
      </div>
    ) : holdings ? (
      <div className={empty}>No tokens in this wallet.</div>
    ) : (
      <div className={empty}>Wallet holdings are not available right now.</div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-profile-coins-tab="true">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Coins">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={section === t.key}
            onClick={() => {
              setPicked(true);
              setSection(t.key);
            }}
            className={`mw-focus inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold ${section === t.key ? "border-mw-accent bg-[#1A130D] text-mw-accent-soft" : "border-mw-edge bg-mw-surface text-mw-muted hover:text-mw-text"}`}
          >
            {t.label}
            <span className="font-mw-mono text-xs">{t.key === "created" || holdings ? counts[t.key] : "…"}</span>
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}

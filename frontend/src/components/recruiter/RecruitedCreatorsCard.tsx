import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";
import { loadLeagueSummary } from "@/lib/leagueApi";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { FeedAvatar } from "@/components/feed/FeedCards";
import { cp } from "@/components/token/coinPageStyles";

type CreatorCoin = { chainId: number; campaignAddress: string; tokenAddress: string | null; name: string | null; symbol: string | null; logoUri: string | null; marketCapUsd: number | null };

function usd(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Public recruiter page (CO-9, founder 2026-10-03): recruited creators, their top 5 coins by market
 * cap and this week's Recruiter League rank. Recruited wallets are not shown.
 */
export function RecruitedCreatorsCard({ code, linkedCreatorsCount }: { code: string; linkedCreatorsCount: number }) {
  const coins = useQuery({
    queryKey: ["recruiter-creator-coins", code],
    queryFn: async () => {
      const res = await apiFetch(`/api/recruiters/${encodeURIComponent(code)}/creator-coins`);
      if (!res.ok) return { creatorsWithCoins: 0, coins: [] as CreatorCoin[] };
      return (await res.json()) as { creatorsWithCoins: number; coins: CreatorCoin[] };
    },
    staleTime: 60_000,
    retry: 1,
  }).data;

  // Recruiter League is one league across chains; the weekly summary carries its standings.
  const rank = useQuery({
    queryKey: ["recruiter-league-rank", code],
    queryFn: async () => {
      const summary: any = await loadLeagueSummary({ chain: "bnb", chainId: 56, period: "weekly", epochOffset: 0 } as any);
      const league = (summary?.leagues || []).find((l: any) => l.key === "recruiter_league");
      const rows: any[] = Array.isArray(league?.rows) ? league.rows : [];
      const index = rows.findIndex((r) => String(r?.recruiterCode || r?.code || "").toLowerCase() === code.toLowerCase());
      return { rank: index >= 0 ? Number(rows[index]?.rank || index + 1) : null, entrants: rows.length };
    },
    staleTime: 60_000,
    retry: 1,
  }).data;

  return (
    <section className={`${cp.card} flex flex-col gap-3 p-4`} data-recruited-creators="true">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cp.title}>Recruited creators</span>
        <span className={cp.chipAccent}>
          Recruiter League {rank?.rank ? `#${rank.rank} this week` : "unranked this week"}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-mw-muted">
        <span><b className="text-mw-text">{linkedCreatorsCount.toLocaleString()}</b> {linkedCreatorsCount === 1 ? "creator" : "creators"} recruited</span>
        <span><b className="text-mw-text">{(coins?.creatorsWithCoins ?? 0).toLocaleString()}</b> launched a coin</span>
      </div>
      {coins?.coins?.length ? (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {coins.coins.map((coin, i) => (
            <li key={`${coin.chainId}:${coin.campaignAddress}`}>
              <Link
                to={tokenDetailsPath({ tokenAddress: coin.tokenAddress || undefined, campaignAddress: coin.campaignAddress, chainId: coin.chainId })}
                className="mw-focus flex items-center gap-3 rounded-[10px] border border-mw-border bg-mw-input p-2.5 text-mw-text hover:border-[#3A424C] hover:text-mw-text"
              >
                <span className="w-5 shrink-0 text-center font-mw-mono text-sm text-mw-muted">{i + 1}</span>
                <FeedAvatar url={coin.logoUri} label={coin.symbol || coin.name || "?"} square size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{coin.name || coin.symbol}</span>
                  {coin.symbol ? <span className="font-mw-mono text-xs text-mw-muted">${coin.symbol}</span> : null}
                </span>
                <span className="font-mw-mono text-sm font-bold">{usd(coin.marketCapUsd)}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-sm text-mw-muted">No coins from recruited creators yet.</p>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Gift } from "lucide-react";

import { apiFetch } from "@/lib/apiBase";

type PoolRow = {
  ok: boolean;
  chainId: number;
  symbol: string;
  poolNative?: number;
  poolUsd?: number | null;
  nextDrawAt?: string;
  rules?: { traderMinUsd: number; traderMinTrades: number; traderMinActiveDays: number; creatorMinUsd: number; creatorMinUniqueBuyers: number };
};

const CHAINS = [101, 56, 4663];

// Shown only once the weekly airdrop is set up on our server (founder, 2026-09-25): set
// VITE_AIRDROP_STRIP_ENABLED=true on the app when the Coolify job and the on-chain roles are live.
const enabled = /^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_AIRDROP_STRIP_ENABLED || "").trim());

function formatUsd(value: number) {
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value.toFixed(0)}`;
}

function drawLabel(iso?: string) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return "Draw running now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `Next draw in ${days}d ${hours}h` : `Next draw in ${hours}h`;
}

/** Slim front-page strip: the weekly airdrop pool across chains, how to enter, the next draw. */
export function AirdropStrip() {
  const [rows, setRows] = useState<PoolRow[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      Promise.all(
        CHAINS.map((chainId) =>
          apiFetch(`/api/airdrops/pool?chainId=${chainId}`)
            .then((response) => response.json() as Promise<PoolRow>)
            .catch(() => null),
        ),
      ).then((results) => {
        if (!cancelled) setRows(results.filter((row): row is PoolRow => Boolean(row?.ok)));
      });
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!enabled) return null;
  const totalUsd = rows.reduce((sum, row) => sum + (Number(row.poolUsd) || 0), 0);
  if (!(totalUsd > 0)) return null;
  const rules = rows.find((row) => row.rules)?.rules;
  const draw = drawLabel(rows.find((row) => row.nextDrawAt)?.nextDrawAt);

  return (
    <Link
      to="/airdrops"
      className="mwz-hud-frame group flex flex-col gap-2 px-3 py-2.5 transition hover:border-accent/50 hover:bg-accent/5 md:flex-row md:items-center md:gap-4 md:px-4"
      data-airdrop-strip="true"
    >
      <div className="flex shrink-0 items-center gap-2">
        <Gift className="h-4 w-4 text-amber-300" aria-hidden />
        <span className="font-retro text-xs uppercase tracking-[0.2em] text-amber-200">Weekly airdrop</span>
        <span className="font-retro text-base text-foreground md:text-lg">{formatUsd(totalUsd)}</span>
      </div>
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">
        {rules
          ? `Trade $${rules.traderMinUsd}+ over ${rules.traderMinActiveDays} days (${rules.traderMinTrades}+ trades), or launch a coin with ${rules.creatorMinUniqueBuyers}+ buyers, to enter.`
          : "Trade or launch this week to enter."}
        {draw ? <span className="ml-1 text-foreground/80">{draw}.</span> : null}
      </div>
      <span className="shrink-0 text-xs uppercase tracking-[0.16em] text-accent group-hover:underline">See airdrop →</span>
    </Link>
  );
}

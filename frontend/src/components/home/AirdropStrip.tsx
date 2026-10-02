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
      className="mw-focus group flex flex-col gap-1.5 rounded-[14px] border border-mw-border bg-mw-surface px-4 py-3 font-mw-body text-mw-text transition-colors hover:border-[#3A424C] hover:text-mw-text md:flex-row md:items-center md:gap-3"
      data-airdrop-strip="true"
    >
      <div className="flex shrink-0 items-center gap-2">
        <Gift className="h-[18px] w-[18px] text-[#FF9A4D]" aria-hidden />
        <span className="font-bold">Weekly airdrop</span>
        <span className="font-mw-mono font-bold">{formatUsd(totalUsd)}</span>
      </div>
      <div className="min-w-0 flex-1 text-sm text-mw-muted">
        {rules
          ? `Trade $${rules.traderMinUsd}+ over ${rules.traderMinActiveDays} days (${rules.traderMinTrades}+ trades), or launch a coin with ${rules.creatorMinUniqueBuyers}+ buyers, to enter.`
          : "Trade or launch this week to enter."}
        {draw ? <span className="ml-1 text-mw-text">{draw}.</span> : null}
      </div>
      <span className="shrink-0 text-sm font-semibold text-mw-accent-soft group-hover:text-[#FFD0A8]">See airdrop</span>
    </Link>
  );
}

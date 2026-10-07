import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/apiBase";
import {
  submitDbcCreatorLpClaim,
  submitDbcGraduationPayout,
  submitDbcReserveClaim,
} from "@/lib/dbcGraduationClaimsSubmit";

type Rewards = {
  graduationPayout: string;
  graduationPayoutClaimable?: boolean;
  /** False for v2 coins: the creator has no share of the graduation fee. */
  creatorGraduationShare?: boolean;
  reserve: string;
  lpFees: string;
  locker: string;
  dammPool: string;
  mint: string;
  migrated: boolean;
  showLpFees?: boolean;
  feeChoiceLine?: string | null;
  feeChoice?: string;
};

function lamports(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value || "0"));
  } catch {
    return 0n;
  }
}

/** A payout in the coin's quote (SOL, USDC, USDT or a stock, shown through its multiplier). */
function quoteLabel(raw: string, symbol: string, decimals: number, multiplier: number): string {
  const n = (Number(raw) / 10 ** decimals) * multiplier;
  if (!Number.isFinite(n)) return `${raw} raw ${symbol}`;
  if (n === 0) return `0 ${symbol}`;
  if (n < 0.000001) return `${raw} raw ${symbol}`;
  return `${n.toFixed(6)} ${symbol}`;
}

/** The creator reserve in whole tokens (DBC coins have 6 decimals). */
function tokenLabel(raw: string): string {
  const whole = lamports(raw) / 1_000_000n;
  return whole > 0n ? `${whole.toLocaleString("en-US")} tokens waiting` : "Nothing waiting";
}

export default function DbcCreatorRewardsPanel({
  pool,
  creator,
  mint,
  quoteSymbol = "SOL",
  quoteDecimals = 9,
  quoteMultiplier = 1,
}: {
  pool: string;
  creator: string;
  mint: string;
  quoteSymbol?: string;
  quoteDecimals?: number;
  quoteMultiplier?: number;
}) {
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function refresh() {
    const response = await apiFetch(
      `/api/dbc/creator-rewards?pool=${encodeURIComponent(pool)}&creator=${encodeURIComponent(creator)}`,
      { cache: "no-store" },
    );
    const payload = await response.json().catch(() => ({}));
    if (!payload?.ok) {
      setRewards(null);
      return;
    }
    setRewards(payload);
  }

  useEffect(() => {
    let cancelled = false;
    void refresh().catch(() => {
      if (!cancelled) setRewards(null);
    });
    return () => {
      cancelled = true;
    };
  }, [pool, creator]);

  if (!pool || !creator) return null;

  const rows = [
    // v2 coins (2026-10-08) give the creator no share of the graduation fee: no payout row.
    ...(rewards?.creatorGraduationShare === false ? [] : [{
      key: "payout",
      title: "Graduation payout",
      detail: rewards?.graduationPayoutClaimable
        ? "Your share of the graduation fee"
        : rewards?.migrated
          ? "Your share of the graduation fee, claimed"
          : "Your share of the graduation fee, paid when the coin graduates",
      amount: rewards?.graduationPayout || "0",
      unit: "quote",
      disabled: !rewards?.graduationPayoutClaimable,
      run: () => submitDbcGraduationPayout({ pool, creator }),
    }]),
    {
      key: "reserve",
      title: "Creator reserve",
      detail: "2% locked vesting, released at graduation",
      amount: rewards?.reserve || "0",
      unit: "tokens",
      disabled: lamports(rewards?.reserve) <= 0n || !rewards?.locker,
      run: () => submitDbcReserveClaim({ mint: rewards?.mint || mint, creator, locker: rewards!.locker }),
    },
    ...(rewards?.showLpFees === false ? [] : [{
      key: "lp",
      title: "LP fees",
      detail: "80% permanently locked position",
      amount: rewards?.lpFees || "0",
      unit: "quote",
      disabled: lamports(rewards?.lpFees) <= 0n || !rewards?.dammPool,
      run: () => submitDbcCreatorLpClaim({ dammPool: rewards!.dammPool, creator }),
    }]),
  ];

  return (
    <div className="mt-3 rounded-xl border border-orange-400/30 bg-background/60 p-3 space-y-2">
      <p className="font-retro text-xs text-orange-200">Creator rewards</p>
      {rewards?.feeChoiceLine ? (
        <p className="text-[11px] text-muted-foreground">{rewards.feeChoiceLine}</p>
      ) : null}
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">{row.title}</p>
            <p className="text-[11px] text-muted-foreground">{row.detail}</p>
            <p className="text-[11px] font-mono">
              {row.unit === "quote" ? quoteLabel(row.amount, quoteSymbol, quoteDecimals, quoteMultiplier) : tokenLabel(row.amount)}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={Boolean(pending) || row.disabled}
            onClick={async () => {
              try {
                setPending(row.key);
                setError(null);
                const result = await row.run();
                setNote(`Tx ${result.signature.slice(0, 12)}…`);
                await refresh();
              } catch (err: any) {
                setError(String(err?.message || err));
              } finally {
                setPending(null);
              }
            }}
          >
            {pending === row.key ? "Claiming…" : "Claim"}
          </Button>
        </div>
      ))}
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

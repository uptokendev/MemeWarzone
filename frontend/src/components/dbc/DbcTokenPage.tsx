import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchDbcToken } from "@/lib/dbcCreate";
import { resolveImageUri } from "@/lib/media";

function formatSol(lamports: string | number | bigint | null | undefined) {
  try {
    const n = Number(BigInt(String(lamports || "0"))) / 1_000_000_000;
    if (!Number.isFinite(n)) return "—";
    return `${n.toFixed(4)} SOL`;
  } catch {
    return "—";
  }
}

export function DbcTokenPage({ token }: { token: string }) {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDbcToken(token)
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setError("This DBC coin could not be loaded.");
          return;
        }
        setPayload(next);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-orange-300">{error}</p>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 font-retro text-muted-foreground">Loading DBC coin…</div>
    );
  }

  const live = (payload.poolLive || null) as { quoteReserveLamports?: string; migrationQuoteThresholdLamports?: string; progressBps?: number } | null;
  const progressPct = Math.min(100, Math.max(0, Number(live?.progressBps || 0) / 100));
  const logo = resolveImageUri(String(payload.logoUri || "")) || String(payload.logoUri || "");
  const socials = [
    payload.website ? ["Website", String(payload.website)] : null,
    payload.x ? ["X", String(payload.x)] : null,
    payload.telegram ? ["Telegram", String(payload.telegram)] : null,
    payload.discord ? ["Discord", String(payload.discord)] : null,
  ].filter(Boolean) as Array<[string, string]>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mwz-card p-5 md:p-7">
        <div className="flex items-start gap-4">
          <img src={logo || "/placeholder.svg"} alt={String(payload.name || "token")} className="h-20 w-20 rounded-lg object-cover" />
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-orange-300">DBC · Solana</div>
            <h1 className="mt-1 font-retro text-3xl text-foreground">{String(payload.name || "—")}</h1>
            <p className="mt-1 font-retro text-sm text-muted-foreground">${String(payload.symbol || "")}</p>
          </div>
        </div>
        {payload.description ? <p className="mt-4 text-sm leading-6 text-muted-foreground">{String(payload.description)}</p> : null}

        <div className="mt-5 space-y-2">
          <div className="flex justify-between text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <span>Progress to graduation</span>
            <span>{progressPct.toFixed(1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-muted">
            <div className="h-full bg-accent" style={{ width: `${progressPct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            Raised {formatSol(live?.quoteReserveLamports)} of {formatSol(live?.migrationQuoteThresholdLamports)}
          </p>
        </div>

        {socials.length ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {socials.map(([label, href]) => (
              <a key={label} href={href} target="_blank" rel="noreferrer" className="mwz-chip px-3 py-1 text-xs">
                {label}
              </a>
            ))}
          </div>
        ) : null}

        <p className="mt-6 text-xs text-muted-foreground">
          Trading on this page lands in a later step. Pool{" "}
          <span className="font-mono text-foreground">{String(payload.pool || "").slice(0, 8)}…</span>
        </p>
        <Link to="/" className="mt-4 inline-block text-xs text-accent">Back to feed</Link>
      </div>
    </div>
  );
}

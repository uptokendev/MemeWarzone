import { useEffect, useMemo, useRef, useState } from "react";

function parseCompactUsd(input?: string | null): number | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw || raw === "—") return null;

  // Only parse the first token (prevents misreading trailing units like "BNB").
  const first = raw.split(/\s+/)[0] ?? "";
  if (!first) return null;

  // Accept forms like "$340.1K", "340.1K", "$1.2M", "$12,345", "€12.3K", etc.
  const cleaned = first
    .replace(/[,\s]/g, "")
    .replace(/^[^\d\-\.]+/, ""); // strip leading currency symbols/letters

  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;

  const suffix = (m[2] ?? "").toUpperCase();
  const mult =
    suffix === "K" ? 1e3 :
    suffix === "M" ? 1e6 :
    suffix === "B" ? 1e9 :
    suffix === "T" ? 1e12 :
    1;

  return n * mult;
}

function formatCompactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  const fmt = (v: number, suffix: string) => {
    const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${sign}$${v.toFixed(decimals)}${suffix}`;
  };

  if (abs >= 1e12) return fmt(abs / 1e12, "T");
  if (abs >= 1e9) return fmt(abs / 1e9, "B");
  if (abs >= 1e6) return fmt(abs / 1e6, "M");
  if (abs >= 1e3) return fmt(abs / 1e3, "K");

  // Small values: show more precision to avoid looking "wrong" on tiny MCAPs.
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${sign}$${abs.toFixed(decimals)}`;
}

type AthBarProps = {
  /** Current market cap label as shown in UI (e.g. "$340.1K"). */
  currentLabel?: string | null;
  /** Indexed/canonical ATH in USD. Outranks empty or stale localStorage. */
  canonicalAthUsd?: number | null;
  /** Optional stable key used for localStorage persistence. */
  storageKey: string;
  /** Optional className wrapper. */
  className?: string;
  /** Optional fixed bar width in pixels (card-friendly). */
  barWidthPx?: number;
  /** Optional max-width for the bar (e.g. "100%"). */
  barMaxWidth?: string;
};

export function AthBar({ currentLabel, canonicalAthUsd, storageKey, className, barWidthPx, barMaxWidth }: AthBarProps) {
  const current = useMemo(() => parseCompactUsd(currentLabel), [currentLabel]);
  const canonicalAth = useMemo(() => {
    const n = Number(canonicalAthUsd);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [canonicalAthUsd]);

  // v3: drop ATH values polluted by bad session trades (e.g. 510k BNB rows → fake USD ATH).
  const storageKeyV2 = useMemo(() => `${storageKey}:v3`, [storageKey]);

  const [ath, setAth] = useState<number | null>(null);
  const [burst, setBurst] = useState(0);
  const prevAthRef = useRef<number | null>(null);

  // Load persisted ATH (per token) once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKeyV2);
      const n = raw ? Number(raw) : NaN;
      let stored = Number.isFinite(n) ? n : null;
      if (stored != null && current != null && current > 0 && stored > current * 50 && stored > 100) {
        stored = current;
      }
      const seeded = Math.max(stored ?? 0, canonicalAth ?? 0, current ?? 0);
      const next = seeded > 0 ? seeded : null;
      if (next != null) localStorage.setItem(storageKeyV2, String(next));
      setAth(next);
      prevAthRef.current = next;
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKeyV2, current, canonicalAth]);

  // Update ATH if we surpass it.
  useEffect(() => {
    if (current == null || !Number.isFinite(current)) return;
    // Ignore absurd spikes (bad local trade pollution).
    if (current > 1e12) return;

    setAth((prev) => {
      const p = prev ?? prevAthRef.current;
      if (p == null || current > p) {
        // Spark burst on new ATH.
        setBurst((b) => b + 1);

        try {
          localStorage.setItem(storageKeyV2, String(current));
        } catch {
          // ignore
        }
        prevAthRef.current = current;
        return current;
      }
      prevAthRef.current = p;
      return prev;
    });
  }, [current, storageKeyV2]);

  const ratio = useMemo(() => {
    if (current == null || ath == null || ath <= 0) return 0;
    return Math.max(0, Math.min(1, current / ath));
  }, [current, ath]);

  const pct = Math.round(ratio * 1000) / 10; // 1 decimal %

  const athLabel = useMemo(() => formatCompactUsd(ath), [ath]);

  // Position spark at end of fill (clamped so it doesn't overflow container)
  const sparkLeft = useMemo(() => {
    const p = Math.max(2, Math.min(98, ratio * 100));
    return `${p}%`;
  }, [ratio]);

  // No mcap yet → text only. Avoid an empty rounded "pill" track that looks broken.
  const hasAthData = ath != null && ath > 0 && current != null && Number.isFinite(current);

  return (
    <div className={className}>
      <style>
        {`
          @keyframes athSparkUp {
            0%   { transform: translate(0, 0) scale(1); opacity: 0.95; }
            65%  { opacity: 0.95; }
            100% { transform: translate(var(--dx), var(--dy)) scale(0.6); opacity: 0; }
          }
          @keyframes athGlowPulse {
            0%, 100% { opacity: 0.65; }
            50% { opacity: 1; }
          }
        `}
      </style>

      <div className="flex items-center gap-2 min-w-0">
        {hasAthData ? (
          <div
            className="relative h-[8px] flex-1 min-w-0 overflow-hidden border border-orange-400/35 bg-black/70"
            style={{
              width: barWidthPx != null ? `${barWidthPx}px` : undefined,
              maxWidth: barMaxWidth ?? "100%",
            }}
          >
            {/* Fill — square tactical track (not a soft rounded pill) */}
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${Math.max(0, Math.min(100, ratio * 100))}%`,
                background:
                  "linear-gradient(90deg, #80350f 0%, #f06a1a 55%, #ff4b24 100%)",
                transition: "width 350ms ease",
              }}
            />

            <div
              className="absolute inset-y-0 left-0 pointer-events-none"
              style={{
                width: `${Math.max(0, Math.min(100, ratio * 100))}%`,
                background:
                  "repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 6px, rgba(0,0,0,0) 6px, rgba(0,0,0,0) 12px)",
                mixBlendMode: "overlay",
                opacity: 0.55,
                transition: "width 350ms ease",
              }}
            />

            <div
              className="absolute top-0 bottom-0 w-10"
              style={{
                left: `calc(${Math.max(0, Math.min(100, ratio * 100))}% - 20px)`,
                background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)",
                filter: "blur(0.2px)",
                animation: "athGlowPulse 1.4s ease-in-out infinite",
                pointerEvents: "none",
              }}
            />

            {burst > 0 && (
              <div
                key={burst}
                className="absolute top-1/2"
                style={{
                  left: sparkLeft,
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "none",
                }}
              >
                {Array.from({ length: 10 }).map((_, i) => {
                  const dx = (Math.sin((burst + 1) * (i + 3)) * 18).toFixed(1);
                  const dy = (-8 - (Math.abs(Math.cos((burst + 2) * (i + 5))) * 18)).toFixed(1);
                  const delay = (i * 10).toFixed(0);
                  return (
                    <span
                      key={i}
                      className="absolute block h-[2px] w-[8px]"
                      style={{
                        background: "rgba(240, 106, 26, 0.95)",
                        boxShadow: "0 0 10px rgba(240, 106, 26, 0.65)",
                        transform: "translate(0,0)",
                        opacity: 0.9,
                        animation: `athSparkUp 520ms ease-out ${delay}ms forwards`,
                        "--dx": `${dx}px`,
                        "--dy": `${dy}px`,
                      } as any}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        <div className="shrink-0 text-[11px] whitespace-nowrap">
          <span className="text-muted-foreground">ATH</span>{" "}
          <span className="font-semibold text-foreground">{athLabel}</span>
          {hasAthData && (
            <span className="ml-1 text-[10px] text-muted-foreground/80">{pct}%</span>
          )}
        </div>
      </div>
    </div>
  );
}
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { readStockPowers } from "@/lib/dbcQuoteMultiplier.mjs";
import { dbcStockRiskSeverity, dbcStockRisks } from "../../../shared/dbcStockRisks.mjs";

type StockPowers = Awaited<ReturnType<typeof readStockPowers>>;

/**
 * D22: shown before a DBC coin is paired with a stock token. The issuer powers are read from the
 * mint when the dialog opens, so "set today" is what the chain says, not what we assumed.
 */
export function DbcStockRiskDialog({
  mint,
  symbol,
  ticker,
  onConfirm,
  onCancel,
}: {
  mint: string;
  symbol: string;
  ticker: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [powers, setPowers] = useState<StockPowers | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const web3 = await loadSolanaWeb3();
        const connection = new web3.Connection(
          String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID),
          { commitment: "confirmed", disableRetryOnRateLimit: true },
        );
        const read = await readStockPowers(connection, mint);
        if (!cancelled) setPowers(read);
      } catch {
        if (!cancelled) setPowers(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mint]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const risks = dbcStockRisks(symbol, powers || {});
  const paused = Boolean(powers?.paused);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dbc-stock-risk-title"
      data-testid="dbc-stock-risk-dialog"
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-orange-400/40 bg-background p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-orange-300" aria-hidden />
          <div className="min-w-0">
            <h2 id="dbc-stock-risk-title" className="font-retro text-base text-foreground">
              Pair {ticker ? `$${ticker}` : "your coin"} with {symbol}?
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {powers === undefined
                ? `Reading ${symbol} from the chain.`
                : paused
                  ? `${symbol} is paused by its issuer right now, so a coin cannot launch against it.`
                  : `${symbol} is a stock token. Its issuer keeps powers over it that SOL does not have.`}
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2.5">
          {risks.map((risk) => (
            <li
              key={risk.code}
              data-testid={`dbc-stock-risk-${risk.code}`}
              className={cn(
                "rounded-md border p-2.5",
                dbcStockRiskSeverity(risk) === "high" ? "border-orange-400/40 bg-orange-400/10" : "border-border/60 bg-background/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-foreground">{risk.title}</span>
                {risk.armed === true ? (
                  <span className="rounded-sm border border-orange-300/60 px-1 text-[9px] uppercase tracking-wider text-orange-200">set today</span>
                ) : risk.armed === false ? (
                  <span className="rounded-sm border border-border/60 px-1 text-[9px] uppercase tracking-wider text-muted-foreground">not set</span>
                ) : null}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{risk.detail}</p>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            data-testid="dbc-stock-risk-cancel"
            className="rounded-md border border-border/70 px-3 py-2 text-[13px] text-muted-foreground transition hover:border-border"
          >
            Pick another quote
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={powers === undefined || paused}
            data-testid="dbc-stock-risk-confirm"
            className="rounded-md border border-orange-300 bg-orange-400/20 px-3 py-2 text-[13px] text-foreground transition hover:bg-orange-400/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            I understand, use {symbol}
          </button>
        </div>
      </div>
    </div>
  );
}

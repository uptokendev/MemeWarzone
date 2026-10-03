import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol } from "@/lib/chainConfig";
import {
  createBattleBoostQuote,
  createSolanaBattleBoostQuote,
  fetchBattleBoostState,
  fetchSolanaBattleBoostPaymentState,
  formatBoostLamports,
  formatBoostNative,
  recoverSolanaBattleBoost,
  submitBattleBoost,
  submitSolanaBattleBoost,
  type BattleBoostSummary,
  type BattlePointsV3BoostState,
  type SolanaBattleBoostRecoveryState,
} from "@/lib/arena/battleBoostClient";

const APPROVED_V3_CURVE = "boost_hyperbolic_100_v1";
const SOLANA_ARENA_CHAIN_IDS = new Set([101]);

type Side = { tokenId?: string | null; ticker?: string | null; name?: string | null };
type PaymentStates = { left: SolanaBattleBoostRecoveryState | null; right: SolanaBattleBoostRecoveryState | null };

function unitsFor(summary: BattleBoostSummary | null, side: "left" | "right") {
  const raw = summary?.[side]?.boostUnits;
  try { const number = Number(BigInt(String(raw || "0"))); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
  catch { return 0; }
}

function paymentLabel(state: SolanaBattleBoostRecoveryState | null) {
  if (!state || state.status === "none") return null;
  if (state.status === "confirmed") return "Confirmed";
  if (state.status === "expired") return "Expired — retry allowed";
  if (state.status === "failed") return state.retryable ? "Failed — retry allowed" : "Failed";
  if (state.status === "recovering" || state.status === "verifying" || state.status === "confirming") return "Recovering payment…";
  return "Payment pending…";
}

/** Battle Boost state and action for one battle; shared by the MORE panel and the battle card. */
export function useBattleBoost({ battleId, chainId, left, right }: { battleId: string; chainId: number; left: Side; right: Side }) {
  const wallet = useWallet();
  const solana = useSolanaWallet();
  const [summary, setSummary] = useState<BattleBoostSummary | null>(null);
  const [v3Rows, setV3Rows] = useState<BattlePointsV3BoostState[]>([]);
  const [v3TotalAuthoritative, setV3TotalAuthoritative] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [busySide, setBusySide] = useState<"left" | "right" | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [paymentStates, setPaymentStates] = useState<PaymentStates>({ left: null, right: null });
  const recoveringRef = useRef(false);
  const isSolana = SOLANA_ARENA_CHAIN_IDS.has(Number(chainId));
  const nativeSymbol = isSolana ? "SOL" : getNativeSymbol(chainId);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const json = await fetchBattleBoostState(battleId, signal);
      setSummary(json.summary || null);
      setV3Rows(Array.isArray(json.battlePointsV3) ? json.battlePointsV3 : []);
      setV3TotalAuthoritative(json.scoringActive === true);
      setRuntimeReady(true);
      return json;
    } catch {
      if (!signal?.aborted) { setSummary(null); setV3Rows([]); setV3TotalAuthoritative(false); setRuntimeReady(false); }
      return null;
    }
  }, [battleId]);

  const refreshSolanaPayments = useCallback(async (signal?: AbortSignal) => {
    if (!isSolana || !solana.solanaAccount) {
      setPaymentStates({ left: null, right: null });
      return { left: null, right: null } as PaymentStates;
    }
    const read = async (tokenId?: string | null) => tokenId ? fetchSolanaBattleBoostPaymentState({ battleId, wallet: solana.solanaAccount, targetToken: tokenId, signal }).catch(() => null) : null;
    const [leftState, rightState] = await Promise.all([read(left.tokenId), read(right.tokenId)]);
    const next = { left: leftState, right: rightState };
    if (!signal?.aborted) setPaymentStates(next);
    return next;
  }, [battleId, isSolana, left.tokenId, right.tokenId, solana.solanaAccount]);

  const recoverUnresolved = useCallback(async (states: PaymentStates) => {
    if (!isSolana || !solana.solanaAccount || recoveringRef.current) return;
    const unresolved = (["left", "right"] as const).filter((side) => states[side]?.unresolved && (side === "left" ? left.tokenId : right.tokenId));
    if (!unresolved.length) return;
    recoveringRef.current = true;
    try {
      for (const side of unresolved) {
        const targetToken = side === "left" ? left.tokenId : right.tokenId;
        if (!targetToken) continue;
        try {
          await recoverSolanaBattleBoost({ battleId, chainId, wallet: solana.solanaAccount, targetToken });
        } catch (error) {
          const message = String((error as Error)?.message || "Battle Boost recovery is still pending.");
          if (!/Do not retry|not available yet|recovery/i.test(message)) toast.error(message);
        }
      }
    } finally {
      recoveringRef.current = false;
      await refreshSolanaPayments();
      await refresh();
    }
  }, [battleId, chainId, isSolana, left.tokenId, refresh, refreshSolanaPayments, right.tokenId, solana.solanaAccount]);

  useEffect(() => {
    const controller = new AbortController();
    setRuntimeReady(null);
    void (async () => {
      await refresh(controller.signal);
      const states = await refreshSolanaPayments(controller.signal);
      if (!controller.signal.aborted) void recoverUnresolved(states);
    })();
    return () => controller.abort();
  }, [recoverUnresolved, refresh, refreshSolanaPayments]);

  const totals = useMemo(() => ({ left: unitsFor(summary, "left"), right: unitsFor(summary, "right") }), [summary]);
  const approvedRows = useMemo(() => v3Rows.filter((row) => row.boostCurveVersion === APPROVED_V3_CURVE), [v3Rows]);

  async function boost(side: "left" | "right", tokenId?: string | null) {
    if (runtimeReady !== true) return toast.error("Battle Boost runtime is unavailable.");
    if (!tokenId) return toast.error("Battle combatant address is unavailable.");
    const previousUnits = side === "left" ? totals.left : totals.right;
    setBusySide(side);
    try {
      if (isSolana) {
        if (!solana.solanaAccount) return toast.error("Connect a Solana wallet to Boost this battle.");
        let state = await fetchSolanaBattleBoostPaymentState({ battleId, wallet: solana.solanaAccount, targetToken: tokenId });
        if (state.unresolved) {
          await recoverSolanaBattleBoost({ battleId, chainId, wallet: solana.solanaAccount, targetToken: tokenId });
          state = await fetchSolanaBattleBoostPaymentState({ battleId, wallet: solana.solanaAccount, targetToken: tokenId });
        }
        if (state.unresolved || state.newPaymentAllowed !== true) throw new Error("A prior SOL Battle Boost payment is still unresolved. No replacement payment will be signed.");
        const quote = await createSolanaBattleBoostQuote({ battleId, chainId, wallet: solana.solanaAccount, targetToken: tokenId, boostUnits: quantity });
        const payment = await submitSolanaBattleBoost({ battleId, wallet: solana.solanaAccount, quote });
        toast.success(`Battle Boost confirmed${payment.signature ? `: ${payment.signature.slice(0, 10)}…` : "."}`);
        await refreshSolanaPayments();
      } else {
        if (!wallet.signer || !wallet.account) return toast.error("Connect an EVM wallet to Boost this battle.");
        if (Number(wallet.chainId) !== Number(chainId)) return toast.error("Switch your wallet to the battle chain before Boosting.");
        const quoted = await createBattleBoostQuote({ battleId, chainId, wallet: wallet.account, targetToken: tokenId, boostUnits: quantity, signer: wallet.signer });
        const submitted = await submitBattleBoost({ signer: wallet.signer, quote: quoted.quote });
        toast.success(`Battle Boost submitted${submitted.txHash ? `: ${submitted.txHash.slice(0, 10)}…` : "."}`);
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1_000 : 1_500));
        const fresh = await refresh();
        if (unitsFor(fresh?.summary || null, side) > previousUnits) break;
      }
    } catch (error) {
      toast.error(String((error as Error)?.message || "Battle Boost failed."));
      await refresh();
      if (isSolana) await refreshSolanaPayments();
    } finally { setBusySide(null); }
  }

  const sideBlocked = (side: "left" | "right") => Boolean(paymentStates[side]?.unresolved) || paymentStates[side]?.newPaymentAllowed === false;
  const disabled = Boolean(busySide) || runtimeReady !== true;

  return { isSolana, nativeSymbol, summary, runtimeReady, busySide, quantity, setQuantity, paymentStates, totals, approvedRows, v3TotalAuthoritative, boost, sideBlocked, disabled };
}

export function boostPaymentLabel(state: SolanaBattleBoostRecoveryState | null) {
  return paymentLabel(state);
}

export function BattleBoostPanel({ battleId, chainId, left, right }: {
  battleId: string;
  chainId: number;
  left: Side;
  right: Side;
}) {
  const { isSolana, nativeSymbol, summary, runtimeReady, quantity, setQuantity, paymentStates, totals, approvedRows, v3TotalAuthoritative, boost, sideBlocked, disabled } =
    useBattleBoost({ battleId, chainId, left, right });

  return (
    <section data-battle-boost-panel="true" className="space-y-3 font-mw-body text-mw-text">
      <div>
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Battle Boost</div>
        <p className="mt-1 text-sm text-mw-muted">$1 paid Boosts add to the competition prize pool. 90% goes to the prize pool and 10% to protocol. V3 Boost points use backend-authoritative {APPROVED_V3_CURVE} scoring.</p>
      </div>
      {runtimeReady === null ? <div role="status" aria-live="polite" className="text-xs text-mw-muted">Checking Battle Boost runtime…</div> : runtimeReady === false ? <div role="status" aria-live="polite" data-battle-boost-runtime="unavailable" className="text-xs text-mw-accent-soft">Battle Boost unavailable</div> : null}
      <div className="flex flex-wrap gap-2" aria-label="Battle Boost quantity">
        {[1, 5, 10].map((value) => <Button key={value} type="button" size="sm" variant={quantity === value ? "default" : "outline"} className={`mw-focus inline-flex min-h-11 min-w-14 items-center justify-center whitespace-nowrap rounded-full border px-4 font-mw-mono text-sm font-semibold disabled:opacity-50 ${quantity === value ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft hover:bg-[#341C0B]" : "border-mw-edge bg-[#171B20] text-[#C9CED4] hover:bg-[#1F252C] hover:text-mw-text"}`} disabled={runtimeReady !== true} onClick={() => setQuantity(value)}>{value}x</Button>)}
      </div>
      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        <div className="min-w-0 space-y-1"><Button type="button" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-between gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 w-full min-w-0" disabled={disabled || !left.tokenId || sideBlocked("left")} onClick={() => void boost("left", left.tokenId)}><span className="truncate">Boost {left.ticker || left.name || "left"}</span><span className="shrink-0 font-mw-mono text-sm text-mw-muted">{totals.left}</span></Button>{isSolana && paymentLabel(paymentStates.left) ? <div data-solana-boost-state="left" className="text-xs text-mw-muted">{paymentLabel(paymentStates.left)}</div> : null}</div>
        <div className="min-w-0 space-y-1"><Button type="button" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-between gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 w-full min-w-0" disabled={disabled || !right.tokenId || sideBlocked("right")} onClick={() => void boost("right", right.tokenId)}><span className="truncate">Boost {right.ticker || right.name || "right"}</span><span className="shrink-0 font-mw-mono text-sm text-mw-muted">{totals.right}</span></Button>{isSolana && paymentLabel(paymentStates.right) ? <div data-solana-boost-state="right" className="text-xs text-mw-muted">{paymentLabel(paymentStates.right)}</div> : null}</div>
      </div>
      {approvedRows.length ? (
        <div data-battle-v3-authoritative-boost="true" className="grid gap-1 rounded-[14px] border border-mw-border bg-mw-input p-3 text-xs text-mw-muted">
          {approvedRows.map((row) => <div key={row.side}>{row.side}: {row.boostPoints == null ? "—" : row.boostPoints.toFixed(2)} / 10 Boost pts · {row.boostUnits} confirmed units{v3TotalAuthoritative && row.totalPoints != null ? ` · ${row.totalPoints.toFixed(2)} / 100 total` : ""}</div>)}
          {!v3TotalAuthoritative ? <div>Final V3 total awaiting backend authoritative-total status.</div> : null}
        </div>
      ) : null}
      {summary?.total?.grossNativeRaw ? <div className="text-xs text-mw-muted">Confirmed Boost support: {isSolana ? formatBoostLamports(summary.total.grossNativeRaw) : formatBoostNative(summary.total.grossNativeRaw, nativeSymbol)}</div> : null}
    </section>
  );
}

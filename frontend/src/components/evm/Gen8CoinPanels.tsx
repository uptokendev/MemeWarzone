import { useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cp } from "@/components/token/coinPageStyles";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol, type SupportedChainId } from "@/lib/chainConfig";
import { evmFeeChoiceLine } from "@/lib/evmGen6.mjs";
import {
  acceptGen8Creator,
  claimGen8Escrow,
  claimGen8HookCreatorFees,
  claimGen8VaultCreatorFees,
  gen8AppConfig,
  gen8ErrorMessage,
  gen8PoolVenueLabel,
  isGen8BarkAppConfig,
  proposeGen8Creator,
  pullGen8VaultFees,
  releaseGen8Reserve,
} from "@/lib/evmGen8Client.mjs";
import type { Gen8CoinState } from "@/hooks/useGen8Coin";
import { GEN8_RATES } from "../../../shared/evmGen8.mjs";

// 560 bps of the 2% bonding fee = 0.112% of volume; 50 bps of volume after graduation (MwzV4Launcher constants).
const CREATOR_BONDING_PCT = ((GEN8_RATES.bondingBps * GEN8_RATES.creatorBondingBps) / 1_000_000).toString();
const CREATOR_POST_PCT = (GEN8_RATES.creatorPostBps / 100).toString();

const fmtNative = (wei: string | bigint | null | undefined, digits = 6) => (wei == null ? "—" : Number(ethers.formatEther(BigInt(wei))).toLocaleString(undefined, { maximumFractionDigits: digits }));
const fmtTokens = (raw: string | bigint | null | undefined) => (raw == null ? "—" : Number(ethers.formatUnits(BigInt(raw), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Phase, bonding progress, market cap and the fee line of a generation 8 coin. A gen-8 coin has no pair address: it
 * trades in its own Uniswap V4 pool before and after graduation. On BNB the display pair (for DexScreener) is linked.
 */
export function Gen8CoinStatus({ chainId, state, explorerBase, nativeUsd = null }: { chainId: number; state: Gen8CoinState; explorerBase: string; nativeUsd?: number | null }) {
  const native = getNativeSymbol(chainId as SupportedChainId);
  const graduated = (state.platformStatus || state.graduation?.phase) === "graduated";
  const pct = state.graduation?.progressPct ?? null;
  const mcWei = state.market?.marketCapNativeWei ? BigInt(state.market.marketCapNativeWei) : null;
  const mcNative = mcWei != null ? Number(ethers.formatEther(mcWei)) : null;
  const choiceLine = evmFeeChoiceLine(state.creatorClaims?.feeChoice?.name, state.creatorClaims?.feeChoice?.creatorPct);
  const feeBps = graduated ? state.tradeFee?.postGraduationBps ?? 100 : state.tradeFee?.bondingBps ?? 200;
  return (
    <div className="flex flex-col gap-2 text-sm" data-gen8-status={graduated ? "graduated" : "bonding"}>
      <div className="flex items-center justify-between gap-2">
        <span className={cp.label}>Phase</span>
        <span className={graduated ? cp.chipGood : cp.chipAccent}>{graduated ? "Graduated" : "Bonding"}</span>
      </div>
      {!graduated ? (
        <div>
          <div className="flex items-center justify-between gap-2 text-xs text-mw-muted">
            <span>Bonding progress</span>
            <span className="font-mw-mono">{pct != null ? `${pct.toFixed(2)}%` : "—"}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-mw-input">
            <div className="h-full rounded-full bg-mw-accent" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-emerald-300">Graduated. It keeps trading in the same {gen8PoolVenueLabel(chainId)} pool.</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-mw-muted">Market cap</span>
        <span className="font-mw-mono text-mw-text">
          {mcNative != null ? `${mcNative.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${native}` : "—"}
          {mcNative != null && nativeUsd ? ` ($${Math.round(mcNative * nativeUsd).toLocaleString()})` : ""}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-mw-muted">Fee</span>
        <span className="font-mw-mono text-mw-text">{(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}%{graduated ? ", half to the creator" : ""}</span>
      </div>
      {choiceLine ? <p className="text-[11px] text-mw-muted">{choiceLine}</p> : null}
      {state.gen8?.displayPair ? (
        <a className="text-xs text-mw-muted underline" href={`${explorerBase}/address/${state.gen8.displayPair}`} target="_blank" rel="noreferrer">
          Display pair {short(state.gen8.displayPair)}
        </a>
      ) : null}
    </div>
  );
}

type Action = { key: string; title: string; detail: string; amount?: string; disabled?: boolean; button: string; run: () => Promise<unknown> };

/**
 * The creator panel of a generation 8 coin (design section 4): the hook ledger (keep coins) or the creator-choice
 * vault (holders / split / buyback), both claimable to any address; the two-step creator transfer; the 2% reserve
 * released after graduation; the creator's escrowed app buys. Shown to the creator, a proposed new creator, and a
 * wallet with escrowed coins.
 *
 * Barkswap (DogeOS): the same actions keyed by the coin address; the creator ledger and the keep-coin transfer live in
 * MwzBarkLauncher (the API's creatorClaims.claimContract), the rest in the Bark vault / reserve lock / escrow.
 */
export function Gen8CreatorPanel({ chainId, state, onDone }: { chainId: number; state: Gen8CoinState; onDone?: () => void }) {
  const wallet = useWallet();
  const native = getNativeSymbol(chainId as SupportedChainId);
  const cfg = gen8AppConfig(chainId);
  const account = wallet.account ? String(wallet.account) : "";
  const claims = state.creatorClaims;
  const [to, setTo] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!cfg || !account || !claims) return null;

  const bark = isGen8BarkAppConfig(cfg);
  // Bark contracts are keyed by the coin; the V4 ones by the pool id.
  const poolId = bark ? state.token : state.gen8.poolId;
  const vaultCoin = Boolean(claims.vault && same(claims.hookCreator, claims.vault.address));
  const isHookCreator = same(account, claims.hookCreator);
  const isHumanCreator = same(account, state.creator);
  const pendingHook = claims.hookPendingCreator;
  const pendingVault = claims.vault?.pendingCreator || null;
  const canAccept = (pendingHook && same(account, pendingHook)) || (pendingVault && same(account, pendingVault));
  const escrowClaimable = claims.escrow?.claimableTokens ? BigInt(claims.escrow.claimableTokens) : 0n;
  const escrowTotal = claims.escrow?.totalTokens ? BigInt(claims.escrow.totalTokens) : 0n;
  if (!isHookCreator && !isHumanCreator && !canAccept && escrowTotal === 0n) return null;

  const payTo = to.trim() || account;
  const toValid = ethers.isAddress(payTo);
  const signerFor = async () => {
    if (!wallet.signer) throw new Error(`Connect the ${native} wallet first.`);
    if (Number(wallet.chainId) !== Number(chainId)) {
      const switched = await wallet.switchToChain(chainId as SupportedChainId);
      if (Number(switched?.chainId) !== Number(chainId) || !switched?.signer) throw new Error("The wallet did not switch chains.");
      return switched.signer as any;
    }
    return wallet.signer as any;
  };
  const run = async (key: string, fn: (signer: any) => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn(await signerFor());
      toast.success(done);
      onDone?.();
    } catch (error) {
      toast.error(gen8ErrorMessage(error) || String((error as Error)?.message || "The transaction failed."));
    } finally {
      setBusy(null);
    }
  };

  const actions: Action[] = [];
  const owed = claims.hookCreatorOwedWei ? BigInt(claims.hookCreatorOwedWei) : 0n;
  if (!vaultCoin && isHookCreator) {
    actions.push({
      key: "hook",
      title: "Your trading fees",
      detail: `Your share of every trade: ${CREATOR_BONDING_PCT}% of the volume before graduation, ${CREATOR_POST_PCT}% after it. Paid to the address below.`,
      amount: `${fmtNative(owed)} ${native}`,
      disabled: owed <= 0n || !toValid,
      button: "Claim",
      run: () => run("hook", (signer) => claimGen8HookCreatorFees({ signer, chainId, cfg, poolId, to: payTo }), "Fees claimed."),
    });
  }
  if (vaultCoin && isHumanCreator) {
    if (owed > 0n) {
      actions.push({
        key: "pull",
        title: "Fees waiting in the pool",
        detail: "Moves them into the fee vault, split by your fee choice.",
        amount: `${fmtNative(owed)} ${native}`,
        button: "Move",
        run: () => run("pull", (signer) => pullGen8VaultFees({ signer, chainId, cfg, poolId }), "Fees moved into the vault."),
      });
    }
    const vaultClaimable = claims.vault?.creatorClaimableWei ? BigInt(claims.vault.creatorClaimableWei) : 0n;
    if (claims.feeChoice?.name === "split") {
      actions.push({
        key: "vault",
        title: "Your part of the fees",
        detail: "Paid to the address below.",
        amount: `${fmtNative(vaultClaimable)} ${native}`,
        disabled: vaultClaimable <= 0n || !toValid,
        button: "Claim",
        run: () => run("vault", (signer) => claimGen8VaultCreatorFees({ signer, chainId, cfg, poolId, to: payTo }), "Fees claimed."),
      });
    }
  }
  if (claims.reserve && BigInt(claims.reserve.amount || "0") > 0n && (isHookCreator || isHumanCreator)) {
    const releasable = Boolean(state.reserveReleasable ?? claims.reserve.releasable);
    const releaseAt = Number(state.reserveReleaseAt ?? claims.reserve.releaseAt ?? 0);
    let reserveDetail = "Unlocks when the coin graduates.";
    if (releasable) reserveDetail = "Unlocked. Paid to the coin's creator.";
    else if ((state.platformStatus || state.graduation?.phase) === "graduated" && releaseAt > Math.floor(Date.now() / 1000)) {
      reserveDetail = `Unlocks at ${new Date(releaseAt * 1000).toLocaleString()} (one hour after graduation).`;
    } else if (state.latched && state.postPhase === false) {
      reserveDetail = "Unlocks only while the price is at or past the graduation price.";
    } else if (state.latched && releaseAt > Math.floor(Date.now() / 1000)) {
      reserveDetail = `Unlocks at ${new Date(releaseAt * 1000).toLocaleString()} (one hour after graduation).`;
    }
    actions.push({
      key: "reserve",
      title: "Creator reserve (2%)",
      detail: reserveDetail,
      amount: `${fmtTokens(claims.reserve.amount)} tokens`,
      disabled: !releasable,
      button: "Release",
      run: () => run("reserve", (signer) => releaseGen8Reserve({ signer, chainId, cfg, poolId }), "Reserve released."),
    });
  }
  if (escrowTotal > 0n) {
    actions.push({
      key: "escrow",
      title: "Your locked buys",
      detail: `Bought ${fmtTokens(escrowTotal)}, claimed ${fmtTokens(claims.escrow?.claimedTokens)}. 20% unlocks after 30 days, then 20% every 7 days.`,
      amount: `${fmtTokens(escrowClaimable)} tokens unlocked`,
      disabled: escrowClaimable <= 0n,
      button: "Claim",
      run: () => run("escrow", (signer) => claimGen8Escrow({ signer, chainId, cfg, token: state.token }), "Unlocked tokens claimed."),
    });
  }

  // Two-step transfer: on the hook for keep coins, in the vault for holders / split / buyback coins.
  const creatorLedger = bark ? cfg.launcher : cfg.hook;
  const transferTarget = vaultCoin ? cfg.choiceVault : creatorLedger;
  const pending = vaultCoin ? pendingVault : pendingHook;
  const canPropose = vaultCoin ? isHumanCreator : isHookCreator;

  return (
    <section aria-label="Creator" className={`${cp.inset} flex flex-col gap-3 p-3 text-sm`} data-gen8-creator-panel="true">
      <div className={cp.label}>Creator</div>
      {actions.some((a) => a.key === "hook" || a.key === "vault") ? (
        <label className="flex flex-col gap-1 text-xs text-mw-muted">
          Pay to
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={account} className="font-mw-mono text-xs" />
          {!toValid ? <span className="text-mw-down">Enter a valid address.</span> : null}
        </label>
      ) : null}
      {actions.map((a) => (
        <div key={a.key} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-mw-text">{a.title}</div>
            <p className="text-[11px] text-mw-muted">{a.detail}</p>
            {a.amount ? <p className="font-mw-mono text-xs text-mw-text">{a.amount}</p> : null}
          </div>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(busy) || a.disabled} onClick={() => void a.run()}>
            {busy === a.key ? "…" : a.button}
          </Button>
        </div>
      ))}
      {canPropose && transferTarget ? (
        <div className="flex flex-col gap-1">
          <div className="font-semibold text-mw-text">Hand over the creator role</div>
          <p className="text-[11px] text-mw-muted">The new wallet accepts it in a second step. Until then nothing changes.{pending ? ` Proposed: ${short(pending)}.` : ""}</p>
          <div className="flex items-center gap-2">
            <Input value={next} onChange={(e) => setNext(e.target.value)} placeholder="0x… new creator wallet" className="font-mw-mono text-xs" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || !ethers.isAddress(next.trim())}
              onClick={() => void run("propose", (signer) => proposeGen8Creator({ signer, chainId, target: transferTarget, poolId, next: next.trim() }), "Proposed. The new wallet must accept.")}
            >
              {busy === "propose" ? "…" : "Propose"}
            </Button>
          </div>
          {pending ? (
            <Button type="button" size="sm" variant="ghost" className={cp.smallButton} disabled={Boolean(busy)} onClick={() => void run("cancel", (signer) => proposeGen8Creator({ signer, chainId, target: transferTarget, poolId, next: null }), "Proposal cancelled.")}>
              Cancel the proposal
            </Button>
          ) : null}
        </div>
      ) : null}
      {canAccept ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-mw-muted">This wallet was proposed as the coin&apos;s new creator.</p>
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => void run("accept", (signer) => acceptGen8Creator({ signer, chainId, target: pendingVault && same(account, pendingVault) ? cfg.choiceVault : creatorLedger, poolId }), "You are now the coin's creator.")}
          >
            {busy === "accept" ? "…" : "Accept"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

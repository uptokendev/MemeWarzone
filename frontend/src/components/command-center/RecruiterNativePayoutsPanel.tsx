import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { CheckCircle2, ShieldAlert, WalletCards } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useRecruiterWallet } from "@/hooks/useRecruiterWallet";
import { fetchRecruiterSignupStatus } from "@/lib/recruiterApi";
import {
  createRecruiterNativeClaim,
  fetchRecruiterNativePayouts,
  recordRecruiterSolanaClaim,
  requestRecruiterAuthNonce,
  requestRecruiterPayoutWalletChallenge,
  verifyRecruiterAuth,
  verifyRecruiterPayoutWallet,
  type RecruiterNativePayouts,
  type RecruiterPayoutBalance,
} from "@/lib/recruiterPortalApi";
import { submitSolanaRewardLaneClaim } from "@/lib/solanaRewardLaneClaim";

type NativeChain = "bnb" | "solana";
type RecruiterWalletIdentity = { chain: NativeChain; address: string; canSign: boolean };

type BalanceStateCopy = {
  badge: string;
  tone: "ready" | "pending" | "warning" | "idle";
  amountRaw: string;
  caption: string;
};

const EMPTY_BALANCES: RecruiterPayoutBalance[] = [
  { chain: "bnb", token: "BNB", claimableRaw: "0", pendingRaw: "0", payoutWallet: null, status: "missing_payout_wallet" },
  { chain: "solana", token: "SOL", claimableRaw: "0", pendingRaw: "0", payoutWallet: null, status: "missing_payout_wallet" },
];

function shortAddress(value?: string | null) {
  const raw = String(value || "");
  return raw.length > 12 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw || "Not verified";
}

function formatNative(raw?: string | null, token?: string | null): string {
  try {
    const isSol = String(token || "").toUpperCase() === "SOL";
    const units = BigInt(raw || "0");
    const value = isSol ? Number(units) / 1_000_000_000 : Number(formatEther(units));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : isSol ? 9 : 6 });
  } catch {
    return "0";
  }
}

function chainLabel(chain: NativeChain) { return chain === "bnb" ? "BNB" : "Solana"; }
function walletPlaceholder(chain: NativeChain) { return chain === "bnb" ? "0x..." : "Solana wallet address"; }
function balanceSort(balance: RecruiterPayoutBalance) { return balance.chain === "bnb" ? 0 : 1; }
function randomNonce() {
  try {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
}
function buildPayoutWalletMessage(input: { recruiterId: string; chain: NativeChain; walletAddress: string; nonce: string }) {
  return ["MemeWarzone Recruiter Payout Wallet", "Action: LINK_PAYOUT_WALLET", `RecruiterId: ${input.recruiterId}`, `Chain: ${input.chain}`, `Wallet: ${input.walletAddress}`, `Nonce: ${input.nonce}`].join("\n");
}
function payoutErrorCopy(message: string) {
  const raw = String(message || "");
  if (/batch pending|awaiting the next published weekly settlement/i.test(raw)) return "Your SOL recruiter reward is earned, but its weekly claim batch has not been published yet.";
  if (/unsupported action|request failed|unknown route|not found|ledger|vault|portal|backend|api/i.test(raw)) return "Recruiter rewards are not available right now. Please try again later.";
  if (/application not found/i.test(raw)) return "This wallet is not approved for recruiter rewards.";
  if (/unauthorized|not authenticated|session/i.test(raw)) return "Please sign in with your approved recruiter wallet first.";
  return raw || "Could not load recruiter rewards.";
}
function rewardReady(balance: RecruiterPayoutBalance) {
  try {
    return String(balance.status || "") === "claimable" && BigInt(balance.claimableRaw || "0") > 0n && Boolean(balance.payoutWallet);
  } catch {
    return false;
  }
}
function balanceStateCopy(balance: RecruiterPayoutBalance): BalanceStateCopy {
  const status = String(balance.status || "");
  if (status === "claimable") {
    return { badge: "Ready", tone: "ready", amountRaw: balance.claimableRaw || "0", caption: `Available ${balance.token}` };
  }
  if (status === "pending_batch_publication") {
    return {
      badge: "Batch awaiting publication",
      tone: "pending",
      amountRaw: balance.pendingRaw || balance.claimableRaw || "0",
      caption: `Earned ${balance.token} is not claimable until the weekly Merkle root is published on-chain`,
    };
  }
  if (status === "pending_finality") {
    return {
      badge: "Pending",
      tone: "pending",
      amountRaw: balance.pendingRaw || balance.claimableRaw || "0",
      caption: `Pending ${balance.token}`,
    };
  }
  if (status === "missing_payout_wallet") {
    return {
      badge: "Wallet needed",
      tone: "warning",
      amountRaw: balance.claimableRaw || balance.pendingRaw || "0",
      caption: `Verify payout wallet to claim ${balance.token}`,
    };
  }
  return {
    badge: "No rewards yet",
    tone: "idle",
    amountRaw: balance.claimableRaw || balance.pendingRaw || "0",
    caption: `Available ${balance.token}`,
  };
}
function balanceBadgeClass(copy: BalanceStateCopy) {
  if (copy.tone === "ready") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  if (copy.tone === "warning") return "border-amber-400/30 bg-amber-400/10 text-amber-100";
  if (copy.tone === "pending") return "border-sky-400/30 bg-sky-400/10 text-sky-100";
  return "border-border/40 bg-card/25 text-muted-foreground";
}

export function RecruiterNativePayoutsPanel() {
  const recruiterWallet = useRecruiterWallet();
  const [state, setState] = useState<RecruiterNativePayouts | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [isRecruiterWallet, setIsRecruiterWallet] = useState(false);
  const [activeRecruiterWallet, setActiveRecruiterWallet] = useState<RecruiterWalletIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [bnbWallet, setBnbWallet] = useState("");
  const [solWallet, setSolWallet] = useState("");

  useEffect(() => {
    let cancelled = false;
    const candidates = recruiterWallet.connectedWallets.map((wallet) => ({ chain: wallet.chain, address: wallet.address, canSign: wallet.canSign }));
    if (!candidates.length) {
      setIsRecruiterWallet(false); setActiveRecruiterWallet(null); setIdentityError(null); setState(null); setBnbWallet(""); setSolWallet("");
      return;
    }
    setIdentityLoading(true); setIdentityError(null); setState(null);
    void (async () => {
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          const status = await fetchRecruiterSignupStatus(candidate.address);
          if (cancelled) return;
          if (status?.isRecruiter && status.recruiter) { setIsRecruiterWallet(true); setActiveRecruiterWallet(candidate); return; }
        } catch (err) { lastError = err; }
      }
      if (cancelled) return;
      setIsRecruiterWallet(false); setActiveRecruiterWallet(null); setState(null);
      if (lastError) setIdentityError(String((lastError as any)?.message || lastError || "Could not verify recruiter wallet."));
    })().finally(() => { if (!cancelled) setIdentityLoading(false); });
    return () => { cancelled = true; };
  }, [recruiterWallet.bnbAddress, recruiterWallet.solanaAddress, recruiterWallet.connectedWallets]);

  const load = useCallback(async () => {
    if (!isRecruiterWallet || !activeRecruiterWallet) return null;
    setLoading(true); setError(null);
    try {
      const next = await fetchRecruiterNativePayouts(activeRecruiterWallet.address);
      setState(next);
      const bnb = next?.balances?.find((item) => item.chain === "bnb")?.payoutWallet || recruiterWallet.bnbAddress || "";
      const sol = next?.balances?.find((item) => item.chain === "solana")?.payoutWallet || recruiterWallet.solanaAddress || "";
      setBnbWallet((current) => current || bnb); setSolWallet((current) => current || sol);
      return next;
    } catch (err: any) {
      setState(null); setError(payoutErrorCopy(String(err?.message || err || ""))); return null;
    } finally { setLoading(false); }
  }, [activeRecruiterWallet, isRecruiterWallet, recruiterWallet.bnbAddress, recruiterWallet.solanaAddress]);

  useEffect(() => { if (!identityLoading && isRecruiterWallet) void load(); }, [identityLoading, isRecruiterWallet, load]);
  useEffect(() => { if (recruiterWallet.bnbAddress) setBnbWallet((current) => current || recruiterWallet.bnbAddress || ""); }, [recruiterWallet.bnbAddress]);
  useEffect(() => { if (recruiterWallet.solanaAddress) setSolWallet((current) => current || recruiterWallet.solanaAddress || ""); }, [recruiterWallet.solanaAddress]);

  const balances = useMemo(() => [...(state?.balances?.length ? state.balances : EMPTY_BALANCES)].sort((a, b) => balanceSort(a) - balanceSort(b)), [state?.balances]);

  const signInRecruiter = async () => {
    if (!activeRecruiterWallet?.canSign) return toast.error("Connect your approved recruiter wallet first.");
    setPendingAction("signin"); setError(null);
    try {
      const challenge = await requestRecruiterAuthNonce(activeRecruiterWallet.address);
      const signature = await recruiterWallet.signMessage(activeRecruiterWallet.chain, activeRecruiterWallet.address, challenge.message);
      await verifyRecruiterAuth(activeRecruiterWallet.address, signature);
      toast.success("Recruiter rewards unlocked"); await load();
    } catch (err: any) {
      const message = payoutErrorCopy(String(err?.message || "Could not unlock recruiter rewards.")); setError(message); toast.error(message);
    } finally { setPendingAction(null); }
  };

  const linkBnbWallet = async () => {
    if (!activeRecruiterWallet) return;
    const payoutWallet = bnbWallet.trim() || recruiterWallet.bnbAddress || "";
    if (!payoutWallet) return toast.error("Connect or enter the BNB wallet first.");
    setPendingAction("link-bnb"); setError(null);
    try {
      const challenge = await requestRecruiterPayoutWalletChallenge("bnb", payoutWallet, activeRecruiterWallet.address);
      const signature = await recruiterWallet.signMessage("bnb", payoutWallet, challenge.message);
      await verifyRecruiterPayoutWallet("bnb", payoutWallet, challenge.nonce, signature, activeRecruiterWallet.address);
      toast.success("BNB wallet verified"); await load();
    } catch (err: any) { const message = payoutErrorCopy(String(err?.message || "Could not verify BNB wallet.")); setError(message); toast.error(message); }
    finally { setPendingAction(null); }
  };

  const linkSolanaWallet = async () => {
    if (!activeRecruiterWallet) return;
    let publicKey = solWallet.trim() || recruiterWallet.solanaAddress;
    setPendingAction("link-solana"); setError(null);
    try {
      if (!publicKey) { publicKey = await recruiterWallet.connect("solana"); setSolWallet(publicKey); }
      if (!publicKey) throw new Error("Connect or enter a Solana wallet first.");
      const latest = state?.recruiterId ? state : await load();
      const recruiterId = String(latest?.recruiterId || "").trim();
      if (!recruiterId) throw new Error("Unlock recruiter rewards first, then verify your Solana wallet.");
      const nonce = randomNonce();
      const message = buildPayoutWalletMessage({ recruiterId, chain: "solana", walletAddress: publicKey, nonce });
      const signature = await recruiterWallet.signMessage("solana", publicKey, message);
      await verifyRecruiterPayoutWallet("solana", publicKey, nonce, signature, activeRecruiterWallet.address);
      toast.success("Solana wallet verified"); await load();
    } catch (err: any) { const message = payoutErrorCopy(String(err?.message || "Could not verify Solana wallet.")); setError(message); toast.error(message); }
    finally { setPendingAction(null); }
  };

  const createClaim = async (chain: NativeChain) => {
    if (!activeRecruiterWallet) return;
    setPendingAction(`claim-${chain}`); setError(null);
    try {
      const result = await createRecruiterNativeClaim(chain, activeRecruiterWallet.address);
      if (chain === "solana") {
        if (!result.solanaClaim) throw new Error("Solana recruiter claim payload is missing.");
        if (recruiterWallet.solanaAddress !== result.solanaClaim.recipient) {
          throw new Error("Connect the verified Solana payout wallet before claiming this reward.");
        }
        const txHash = await submitSolanaRewardLaneClaim(result.solanaClaim);
        await recordRecruiterSolanaClaim(result.claim.id, txHash, activeRecruiterWallet.address);
        toast.success("SOL recruiter reward claimed on-chain");
      } else {
        toast.success(String(result?.message || "BNB recruiter claim created"));
      }
      await load();
    } catch (err: any) {
      const message = payoutErrorCopy(String(err?.message || `Could not claim ${chainLabel(chain)} rewards.`)); setError(message); toast.error(message);
    } finally { setPendingAction(null); }
  };

  if (identityLoading || identityError || !isRecruiterWallet) return null;

  return (
    <CommandCenterCard title="Recruiter Rewards" description="Verify your BNB and Solana wallets, then claim available recruiter rewards." action={<WalletCards className="h-5 w-5 text-accent" />}>
      {error ? <div className="mb-4 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">{error}</div> : null}
      {!state?.recruiterId ? (
        <div className="mb-4 rounded-2xl border border-border/50 bg-background/25 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div><div className="font-retro text-sm text-foreground">Unlock recruiter rewards</div><p className="mt-1 text-sm text-muted-foreground">Sign once with your approved recruiter wallet to view and claim rewards.</p></div>
            <Button onClick={signInRecruiter} disabled={pendingAction === "signin" || loading} className="font-retro">{pendingAction === "signin" || loading ? "Unlocking..." : "Unlock Rewards"}</Button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {balances.map((balance) => {
          const chain = balance.chain as NativeChain;
          const isBnb = chain === "bnb";
          const inputValue = isBnb ? bnbWallet : solWallet;
          const setInputValue = isBnb ? setBnbWallet : setSolWallet;
          const canClaim = rewardReady(balance);
          const verified = Boolean(balance.payoutWallet);
          const verifyPending = pendingAction === (isBnb ? "link-bnb" : "link-solana");
          const claimPending = pendingAction === `claim-${chain}`;
          const stateCopy = balanceStateCopy(balance);
          return (
            <div key={chain} className="rounded-2xl border border-border/50 bg-background/25 p-4">
              <div className="flex items-start justify-between gap-3">
                <div><div className="font-retro text-sm text-foreground">{chainLabel(chain)} Rewards</div><div className="mt-1 text-xs text-muted-foreground">Paid in {balance.token}</div></div>
                <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] ${balanceBadgeClass(stateCopy)}`}>{stateCopy.badge}</span>
              </div>
              <div className="mt-5 rounded-xl border border-border/40 bg-card/25 p-4 text-center"><div className="font-retro text-2xl text-foreground">{formatNative(stateCopy.amountRaw, balance.token)}</div><div className="mt-1 text-xs text-muted-foreground">{stateCopy.caption}</div></div>
              <div className="mt-4 rounded-xl border border-border/40 bg-card/25 p-3 text-xs text-muted-foreground"><div className="flex items-center gap-2 font-retro text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{verified ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <ShieldAlert className="h-4 w-4 text-amber-200" />}{chainLabel(chain)} wallet verification</div><div className="mt-2 font-mono text-sm text-foreground">{shortAddress(balance.payoutWallet)}</div></div>
              <div className="mt-4 space-y-2"><label className="font-retro text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{chainLabel(chain)} wallet</label><input value={inputValue} onChange={(event) => setInputValue(event.target.value)} placeholder={walletPlaceholder(chain)} className="min-h-10 w-full rounded-xl border border-border/50 bg-background/60 px-3 font-mono text-sm text-foreground outline-none transition focus:border-accent/60" /></div>
              <div className="mt-4 flex flex-wrap gap-2">
                {verified && String(balance.status || "") === "pending_batch_publication" ? (
                  <p className="w-full text-xs text-sky-100">Wallet verified. {formatNative(stateCopy.amountRaw, balance.token)} {balance.token} is earned. Batch awaiting on-chain publication — you cannot claim until the Merkle root is live.</p>
                ) : isBnb ? (
                  <Button onClick={linkBnbWallet} disabled={verifyPending} variant="outline" className="font-retro">{verifyPending ? "Waiting..." : verified ? "Update BNB Wallet" : "Verify BNB Wallet"}</Button>
                ) : (
                  <Button onClick={linkSolanaWallet} disabled={verifyPending || recruiterWallet.connecting} variant="outline" className="font-retro">{verifyPending || recruiterWallet.connecting ? "Waiting..." : verified ? "Update Solana Wallet" : "Verify Solana Wallet"}</Button>
                )}
                <Button onClick={() => createClaim(chain)} disabled={!canClaim || claimPending} className="font-retro">{claimPending ? "Claiming..." : `Claim ${balance.token}`}</Button>
              </div>
            </div>
          );
        })}
      </div>
    </CommandCenterCard>
  );
}

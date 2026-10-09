import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cp } from "@/components/token/coinPageStyles";
import { useWallet } from "@/contexts/WalletContext";
import { useFeedSession } from "@/hooks/useFeedSession";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveWalletKind } from "@/lib/activeWalletChain";
import { getActiveChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { openFeedSession, signFeedSession } from "@/lib/feedSession";
import { signSolanaMessage } from "@/lib/solanaWallet";
import {
  captureRecruiterReferral,
  fetchRecruiterReplacements,
  fetchWalletAttributionState,
  WALLET_SIGNED_IN_EVENT,
  type RecruiterSummary,
  type WalletAttributionPublicState,
} from "@/lib/recruiterApi";
import {
  getRecruiterJoinRole,
  setRecruiterJoinRole,
  syncRecruiterJoinRole,
  type RecruiterJoinRole,
} from "@/lib/recruiterJoinRole";
import { analytics } from "@/lib/analytics/ProductAnalytics";

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

type ReferralState = {
  recruiter: null | {
    code: string;
    displayName: string | null;
    isOg: boolean;
    status: string;
  };
  expiresAt: string | null;
};

export default function RecruiterReferral() {
  const { code = "" } = useParams<{ code: string }>();
  const wallet = useWallet();
  const { solanaAccount, connectingSolana } = useSolanaWallet();
  const activeWalletKind = getActiveWalletKind();
  const connectedAccount =
    activeWalletKind === "bnb"
      ? wallet.account || solanaAccount
      : activeWalletKind === "solana"
        ? solanaAccount || wallet.account
        : solanaAccount || wallet.account;
  const connectedIsSolana = Boolean(solanaAccount && connectedAccount === solanaAccount);
  const walletConnecting = wallet.connecting || connectingSolana;

  const [loading, setLoading] = useState(true);
  const [syncingRole, setSyncingRole] = useState(false);
  const [syncRetry, setSyncRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [roleMessage, setRoleMessage] = useState<string | null>(null);
  const [memberRole, setMemberRole] = useState<RecruiterJoinRole | null>(() => getRecruiterJoinRole());
  const [state, setState] = useState<ReferralState | null>(null);
  const [walletState, setWalletState] = useState<WalletAttributionPublicState | null>(null);
  const [replacementSuggestions, setReplacementSuggestions] = useState<RecruiterSummary[]>([]);
  const lastSyncedKey = useRef("");
  const { account: feedAccount, ensureSession } = useFeedSession();
  // The sign-in must be for the wallet that joins. useFeedSession prefers the Solana wallet, so with
  // both connected and BNB active it would sign in the wrong one: sign the joining wallet directly.
  const signInJoiningWallet = async (walletAddress: string, solana: boolean) => {
    if (walletAddress === feedAccount) return ensureSession();
    const chainId = solana ? SOLANA_CHAIN_ID : getActiveChainId((wallet as { chainId?: number })?.chainId) || 56;
    const auth = await signFeedSession({
      walletAddress,
      chainId,
      walletType: solana ? "solana" : "evm",
      signMessage: solana ? async (message) => (await signSolanaMessage(message, walletAddress)).signature : undefined,
      signer: solana ? undefined : (wallet as { signer?: Parameters<typeof signFeedSession>[0]["signer"] }).signer,
    });
    return openFeedSession({ walletAddress, chainId, auth });
  };
  const signInRef = useRef(signInJoiningWallet);
  signInRef.current = signInJoiningWallet;

  useEffect(() => {
    const trimmed = String(code || "").trim();
    if (!trimmed) return;
    analytics.track("recruiter_link_landed", { code: trimmed });
  }, [code]);

  // Capture the recruiter invite independently from wallet attachment. The referral
  // API only needs the browser session/fingerprint at this stage. Sending a Solana
  // address here made older recruiter API deployments reject the entire invite page
  // before the user could select a role. Wallet attribution happens in the separate
  // effect below after a role is known.
  useEffect(() => {
    let cancelled = false;
    const recruiterCode = code.trim();
    if (!recruiterCode) {
      setLoading(false);
      setError("Recruiter code missing.");
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [result, replacementData] = await Promise.all([
          captureRecruiterReferral(recruiterCode, null),
          fetchRecruiterReplacements(recruiterCode, 3).catch(() => ({ replacements: [] })),
        ]);

        if (cancelled) return;
        setState({
          recruiter: result.recruiter ?? null,
          expiresAt: result.referral?.expiresAt ?? null,
        });
        setReplacementSuggestions(Array.isArray(replacementData?.replacements) ? replacementData.replacements : []);
      } catch (err: any) {
        if (cancelled) return;
        setError(String(err?.message || err || "Failed to capture referral"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  // Wallet state is supplemental. A bad/stale wallet lookup must never make the
  // recruiter invite itself unusable.
  useEffect(() => {
    let cancelled = false;
    if (!connectedAccount) {
      setWalletState(null);
      return;
    }

    void fetchWalletAttributionState(connectedAccount)
      .then((nextWalletState) => {
        if (!cancelled) setWalletState(nextWalletState);
      })
      .catch(() => {
        if (!cancelled) setWalletState(null);
      });

    return () => {
      cancelled = true;
    };
  }, [connectedAccount]);

  useEffect(() => {
    if (!connectedAccount || !memberRole) return;
    const addressKey = connectedIsSolana ? connectedAccount : connectedAccount.toLowerCase();
    const syncKey = `${addressKey}:${memberRole}:${code.toLowerCase()}`;
    if (lastSyncedKey.current === syncKey && syncRetry === 0) return;
    lastSyncedKey.current = syncKey;

    let cancelled = false;
    setSyncingRole(true);
    void (async () => {
      try {
        const result = await syncRecruiterJoinRole(connectedAccount, memberRole);
        const nextWalletState = await fetchWalletAttributionState(connectedAccount).catch(() => null);
        if (cancelled) return;
        setWalletState(nextWalletState);
        if (result?.linked) setRoleMessage(`Wallet linked as ${memberRole}. Your squad connection is active.`);
        else if (result?.needsRoleSelection) setRoleMessage("Choose creator, trader, or both first, then connect again.");
        else if (result?.needsSignIn) {
          // Joining needs the 30-day sign-in (one signature, no fee); the join retries once it is stored.
          lastSyncedKey.current = "";
          setRoleMessage("Sign in with this wallet to join the squad: one signature, no transaction, no fee.");
          void signInRef.current(connectedAccount, connectedIsSolana).catch(() => {
            if (!cancelled) setRoleMessage("Not signed in. Sign in with this wallet to join the squad.");
          });
        }
        else if (result?.blocked) setRoleMessage(result.reason || "This wallet cannot be linked as a squad member.");
        else setRoleMessage(result?.reason || "Wallet connected. Recruiter attribution is being checked.");
      } catch (err: any) {
        lastSyncedKey.current = "";
        if (!cancelled) setRoleMessage(String(err?.message || err || "Could not sync recruiter attribution."));
      } finally {
        if (!cancelled) setSyncingRole(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, connectedAccount, connectedIsSolana, memberRole, syncRetry]);

  // The sign-in landed: retry the join for this wallet.
  useEffect(() => {
    if (!connectedAccount) return;
    const onSignedIn = (event: Event) => {
      const signed = String((event as CustomEvent<{ walletAddress?: string }>).detail?.walletAddress || "");
      const same = connectedIsSolana ? signed === connectedAccount : signed.toLowerCase() === connectedAccount.toLowerCase();
      if (!same) return;
      lastSyncedKey.current = "";
      setSyncRetry((value) => value + 1);
    };
    window.addEventListener(WALLET_SIGNED_IN_EVENT, onSignedIn);
    return () => window.removeEventListener(WALLET_SIGNED_IN_EVENT, onSignedIn);
  }, [connectedAccount, connectedIsSolana]);

  const lockedToOtherRecruiter = useMemo(() => {
    const capturedCode = String(state?.recruiter?.code || code).trim().toLowerCase();
    const linkedCode = String(walletState?.recruiterCode || "").trim().toLowerCase();
    return Boolean(
      walletState?.recruiterLinkState === "linked_locked"
        && linkedCode
        && capturedCode
        && linkedCode !== capturedCode
    );
  }, [code, state?.recruiter?.code, walletState]);

  const linkedToThisRecruiter = useMemo(() => {
    const capturedCode = String(state?.recruiter?.code || code).trim().toLowerCase();
    const linkedCode = String(walletState?.recruiterCode || "").trim().toLowerCase();
    return Boolean(capturedCode && linkedCode && capturedCode === linkedCode && walletState?.squadState === "in_squad");
  }, [code, state?.recruiter?.code, walletState]);

  const chooseRole = async (role: RecruiterJoinRole) => {
    setMemberRole(role);
    setRecruiterJoinRole(role);
    lastSyncedKey.current = "";
    setRoleMessage(connectedAccount
      ? `Selected ${role}. Syncing ${connectedAccount.slice(0, 6)}...${connectedAccount.slice(-4)} to the recruiter squad...`
      : `Selected ${role}. Now connect the wallet you want to add to this recruiter's squad.`);
  };

  const handleWalletAction = async () => {
    if (!memberRole) {
      setRoleMessage("Choose creator, trader, or both first. Then connect the wallet for that role.");
      return;
    }

    if (connectedAccount) {
      lastSyncedKey.current = "";
      setRoleMessage(`Using connected ${connectedIsSolana ? "Solana" : "BNB"} wallet ${connectedAccount.slice(0, 6)}...${connectedAccount.slice(-4)}. Syncing recruiter attribution...`);
      setSyncRetry((value) => value + 1);
      return;
    }

    try {
      await wallet.connect();
    } catch (err: any) {
      setRoleMessage(String(err?.message || err || "Could not open wallet modal."));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 py-10 font-mw-body text-mw-text md:px-2">
      <div className="max-w-3xl">
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
          Recruiter Invite
        </div>
        <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">
          {loading ? "Saving your recruiter invite..." : "Join this recruiter's squad"}
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-mw-muted">
          Step 1: choose whether this wallet joins as a creator, trader, or both. Step 2: connect a wallet if one is not already connected.
          MemeWarzone uses the active connected wallet and locks it to this recruiter squad when the referral window is valid.
        </p>
      </div>

      <section className={`${cp.card} p-4`}>
        {error ? (
          <div className="space-y-3">
            <p className="font-semibold text-mw-sell">{error}</p>
            <Link to="/" className={cp.btn}>Back to app</Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className={cp.label}>Recruiter</p>
              <p className={`mt-1 ${cp.title}`}>
                {state?.recruiter?.displayName || state?.recruiter?.code || code}
              </p>
              <p className="text-[15px] text-mw-muted">
                Code: <span className="font-mw-mono text-mw-text">{state?.recruiter?.code || code}</span>
                {state?.recruiter?.isOg ? " | OG recruiter" : ""}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className={`${cp.inset} p-3`}>
                <p className={cp.label}>1. Choose role</p>
                <p className="mt-1 text-[15px] text-mw-muted">
                  Pick how this wallet should count inside the squad.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-pressed={memberRole === "creator"}
                    className={memberRole === "creator" ? PRIMARY_BTN : cp.btn}
                    onClick={() => void chooseRole("creator")}
                    disabled={syncingRole}
                  >
                    Creator
                  </button>
                  <button
                    type="button"
                    aria-pressed={memberRole === "trader"}
                    className={memberRole === "trader" ? PRIMARY_BTN : cp.btn}
                    onClick={() => void chooseRole("trader")}
                    disabled={syncingRole}
                  >
                    Trader
                  </button>
                  <button
                    type="button"
                    aria-pressed={memberRole === "both"}
                    className={memberRole === "both" ? PRIMARY_BTN : cp.btn}
                    onClick={() => void chooseRole("both")}
                    disabled={syncingRole}
                  >
                    Both
                  </button>
                </div>
              </div>

              <div className="rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] p-3 font-mw-body">
                <p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">
                  {connectedAccount ? "2. Wallet ready" : "2. Connect wallet"}
                </p>
                <p className="mt-1 text-[15px] text-[#E8D5C4]">
                  {connectedAccount
                    ? `Using your active connected ${connectedIsSolana ? "Solana" : "BNB"} wallet for this recruiter link.`
                    : "Connect the exact wallet you want linked to this recruiter. Do not use the recruiter's own wallet here."}
                </p>
                <button
                  type="button"
                  className={`mt-3 ${PRIMARY_BTN}`}
                  onClick={() => void handleWalletAction()}
                  disabled={syncingRole || walletConnecting || !memberRole}
                >
                  {syncingRole || walletConnecting
                    ? "Linking..."
                    : connectedAccount
                      ? `Continue with ${connectedAccount.slice(0, 6)}...${connectedAccount.slice(-4)}`
                      : memberRole
                        ? `Connect wallet as ${memberRole}`
                        : "Choose role first"}
                </button>
                {connectedAccount ? <p className="mt-2 break-all font-mw-mono text-xs text-[#E8D5C4]">{connectedAccount}</p> : null}
              </div>
            </div>

            {linkedToThisRecruiter ? (
              <div className="rounded-[10px] border border-[#1F5133] bg-[#0F2418] p-3 font-mw-body text-[15px] text-[#6EE7A0]">
                Connected. This wallet is now in the squad for {walletState?.recruiterDisplayName || walletState?.recruiterCode || code}.
              </div>
            ) : null}

            {roleMessage ? <p className={`${cp.inset} p-3 text-[15px] text-mw-muted`}>{roleMessage}</p> : null}

            <div className={`${cp.inset} p-3`}>
              <p className="text-[15px] text-mw-muted">
                Referral window: {state?.expiresAt ? new Date(state.expiresAt).toLocaleString() : "stored"}
              </p>
              <p className="mt-1 text-[15px] text-mw-muted">
                Current squad state: {walletState?.squadState || "not connected yet"}
              </p>
            </div>

            {lockedToOtherRecruiter ? (
              <div className="rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] p-3 font-mw-body">
                <p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">
                  Recruiter link already locked
                </p>
                <p className="mt-1 text-[15px] text-[#E8D5C4]">
                  This wallet is already locked to recruiter{" "}
                  <span className="font-semibold text-mw-text">{walletState?.recruiterDisplayName || walletState?.recruiterCode}</span>.
                  This referral was stored, but it cannot replace the current recruiter because first activity already
                  happened on this wallet.
                </p>
                {walletState?.recruiterCode ? (
                  <Link to={`/recruiters/${encodeURIComponent(walletState.recruiterCode)}`} className={`mt-3 ${cp.btn}`}>
                    View current recruiter
                  </Link>
                ) : null}
              </div>
            ) : null}

            {state?.recruiter?.status !== "active" && replacementSuggestions.length > 0 ? (
              <div className={`${cp.inset} p-3`}>
                <p className={cp.label}>
                  Active replacement suggestions
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  {replacementSuggestions.map((replacement) => (
                    <Link
                      key={replacement.code}
                      to={`/recruiters/${encodeURIComponent(replacement.code)}`}
                      className="mw-focus flex min-h-11 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text transition-colors hover:bg-[#222830]"
                    >
                      {replacement.displayName || replacement.code}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/recruiters/${encodeURIComponent(code)}`} className={cp.btn}>View recruiter profile</Link>
              {connectedAccount ? (
                <Link to={`/profile/${encodeURIComponent(connectedAccount)}/command/squad`} className={cp.btn}>Open squad status</Link>
              ) : null}
              <Link to="/" className={cp.btn}>Continue to app</Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

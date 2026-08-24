import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveWalletKind } from "@/lib/activeWalletChain";
import {
  captureRecruiterReferral,
  fetchRecruiterReplacements,
  fetchWalletAttributionState,
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6 py-10">
      <Card className="overflow-hidden border-border/50 bg-card/70 p-6 md:p-8">
        <div className="space-y-4">
          <p className="font-retro text-xs uppercase tracking-[0.25em] text-muted-foreground">
            Recruiter Invite
          </p>
          <h1 className="font-retro text-3xl text-foreground md:text-4xl">
            {loading ? "Saving your recruiter invite..." : "Join this recruiter's squad"}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
            Step 1: choose whether this wallet joins as a creator, trader, or both. Step 2: connect a wallet if one is not already connected.
            MemeWarzone uses the active connected wallet and locks it to this recruiter squad when the referral window is valid.
          </p>
        </div>
      </Card>

      <Card className="border-border/50 bg-card/60 p-6">
        {error ? (
          <div className="space-y-3">
            <p className="font-medium text-destructive">{error}</p>
            <Button asChild variant="outline">
              <Link to="/">Back to app</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Recruiter</p>
              <p className="mt-1 text-xl font-semibold text-foreground">
                {state?.recruiter?.displayName || state?.recruiter?.code || code}
              </p>
              <p className="text-sm text-muted-foreground">
                Code: {state?.recruiter?.code || code}
                {state?.recruiter?.isOg ? " | OG recruiter" : ""}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-border/60 bg-background/40 p-4">
                <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">1. Choose role</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Pick how this wallet should count inside the squad.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant={memberRole === "creator" ? "default" : "outline"}
                    onClick={() => void chooseRole("creator")}
                    disabled={syncingRole}
                  >
                    Creator
                  </Button>
                  <Button
                    type="button"
                    variant={memberRole === "trader" ? "default" : "outline"}
                    onClick={() => void chooseRole("trader")}
                    disabled={syncingRole}
                  >
                    Trader
                  </Button>
                  <Button
                    type="button"
                    variant={memberRole === "both" ? "default" : "outline"}
                    onClick={() => void chooseRole("both")}
                    disabled={syncingRole}
                  >
                    Both
                  </Button>
                </div>
              </div>

              <div className="rounded-2xl border border-orange-400/25 bg-orange-400/10 p-4">
                <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-100">
                  {connectedAccount ? "2. Wallet ready" : "2. Connect wallet"}
                </p>
                <p className="mt-2 text-sm text-orange-50/80">
                  {connectedAccount
                    ? `Using your active connected ${connectedIsSolana ? "Solana" : "BNB"} wallet for this recruiter link.`
                    : "Connect the exact wallet you want linked to this recruiter. Do not use the recruiter's own wallet here."}
                </p>
                <Button
                  type="button"
                  className="mt-4"
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
                </Button>
                {connectedAccount ? <p className="mt-3 font-mono text-xs text-orange-50/80">{connectedAccount}</p> : null}
              </div>
            </div>

            {linkedToThisRecruiter ? (
              <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">
                Connected. This wallet is now in the squad for {walletState?.recruiterDisplayName || walletState?.recruiterCode || code}.
              </div>
            ) : null}

            {roleMessage ? <p className="rounded-2xl border border-border/60 bg-background/35 p-4 text-sm text-muted-foreground">{roleMessage}</p> : null}

            <div className="rounded-2xl border border-border/60 bg-background/40 p-4">
              <p className="text-sm text-muted-foreground">
                Referral window: {state?.expiresAt ? new Date(state.expiresAt).toLocaleString() : "stored"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Current squad state: {walletState?.squadState || "not connected yet"}
              </p>
            </div>

            {lockedToOtherRecruiter ? (
              <div className="rounded-2xl border border-amber-300/35 bg-amber-300/10 p-4">
                <p className="font-retro text-xs uppercase tracking-[0.2em] text-amber-100">
                  Recruiter link already locked
                </p>
                <p className="mt-2 text-sm text-amber-50/90">
                  This wallet is already locked to recruiter{" "}
                  <span className="font-semibold">{walletState?.recruiterDisplayName || walletState?.recruiterCode}</span>.
                  This referral was stored, but it cannot replace the current recruiter because first activity already
                  happened on this wallet.
                </p>
                {walletState?.recruiterCode ? (
                  <Button asChild variant="outline" className="mt-4">
                    <Link to={`/recruiters/${encodeURIComponent(walletState.recruiterCode)}`}>
                      View current recruiter
                    </Link>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {state?.recruiter?.status !== "active" && replacementSuggestions.length > 0 ? (
              <div className="rounded-2xl border border-sky-300/30 bg-sky-300/10 p-4">
                <p className="font-retro text-xs uppercase tracking-[0.2em] text-sky-100">
                  Active replacement suggestions
                </p>
                <div className="mt-3 flex flex-col gap-3">
                  {replacementSuggestions.map((replacement) => (
                    <Link
                      key={replacement.code}
                      to={`/recruiters/${encodeURIComponent(replacement.code)}`}
                      className="rounded-xl border border-sky-300/20 bg-background/35 px-4 py-3 text-sm text-foreground transition-colors hover:border-sky-300/40"
                    >
                      {replacement.displayName || replacement.code}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="outline">
                <Link to={`/recruiters/${encodeURIComponent(code)}`}>View recruiter profile</Link>
              </Button>
              {connectedAccount ? (
                <Button asChild variant="outline">
                  <Link to={`/profile/${encodeURIComponent(connectedAccount)}/command/squad`}>Open squad status</Link>
                </Button>
              ) : null}
              <Button asChild variant="outline">
                <Link to="/">Continue to app</Link>
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

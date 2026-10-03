import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ShieldCheck, Users } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useRecruiterWallet } from "@/hooks/useRecruiterWallet";
import { fetchRecruiterSignupStatus, type RecruiterSignupStatus } from "@/lib/recruiterApi";

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

export default function Recruiter() {
  const recruiterWallet = useRecruiterWallet();
  const activeWallet = recruiterWallet.activeWallet;
  const account = activeWallet?.address || "";
  const isConnected = Boolean(activeWallet && account);
  const [status, setStatus] = useState<RecruiterSignupStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setStatus(null);
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        const next = await fetchRecruiterSignupStatus(account).catch(() => null);
        if (!cancelled) setStatus(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account]);

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 py-8 font-mw-body text-mw-text md:px-2">
      <div className="max-w-3xl">
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter Program</div>
        <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Build your squad before the battlefield opens.</h1>
        <p className="mt-2 text-[15px] text-mw-muted">
          Recruit creators and traders, share your referral link, grow your squad and track your rewards from the Command Center.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className={`${cp.card} p-4`}>
          <Users className="h-5 w-5 text-mw-accent-soft" aria-hidden="true" />
          <h2 className={`mt-3 ${cp.title}`}>Grow your network</h2>
          <p className="mt-1 text-[15px] text-mw-muted">
            Invite creators and traders with your recruiter link and grow your squad as your network expands.
          </p>
        </div>
        <div className={`${cp.card} p-4`}>
          <ShieldCheck className="h-5 w-5 text-mw-accent-soft" aria-hidden="true" />
          <h2 className={`mt-3 ${cp.title}`}>Track rewards</h2>
          <p className="mt-1 text-[15px] text-mw-muted">
            See pending, claimable, claimed and historical recruiter rewards in one place.
          </p>
        </div>
        <div className={`${cp.card} p-4`}>
          <ArrowRight className="h-5 w-5 text-mw-accent-soft" aria-hidden="true" />
          <h2 className={`mt-3 ${cp.title}`}>Stay public</h2>
          <p className="mt-1 text-[15px] text-mw-muted">
            Your leaderboard position, public recruiter profile and referral link remain visible to the community. Manage your recruiter account from the Command Center.
          </p>
        </div>
      </div>

      {!isConnected || !account ? (
        <section className={`${cp.card} p-4`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className={cp.label}>Wallet required</p>
              <h2 className={`mt-1 ${cp.title}`}>Connect to continue into recruiter setup.</h2>
              <p className="mt-1 text-[15px] text-mw-muted">
                Connect the wallet you want to use as your recruiter identity, then choose your recruiter code and complete signup.
              </p>
            </div>
            <ConnectWalletButton />
          </div>
        </section>
      ) : loading ? (
        <div className={`${cp.card} px-4 py-10 text-center text-[15px] text-mw-muted`}>
          Checking recruiter wallet status...
        </div>
      ) : status?.isRecruiter && status.recruiter ? (
        <section className={`${cp.card} p-4`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className={cp.label}>Existing recruiter</p>
              <h2 className={`mt-1 ${cp.title}`}>{status.recruiter.displayName || status.recruiter.code}</h2>
              <p className="mt-1 text-[15px] text-mw-muted">
                This {activeWallet?.chain === "solana" ? "Solana" : "BNB"} wallet already owns recruiter code <span className="font-mw-mono font-bold text-mw-text">{status.recruiter.code}</span>. Continue in Command Center → Recruiter.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link to="/profile?tab=recruiter" className={PRIMARY_BTN}>Open recruiter dashboard</Link>
              <Link to={`/recruiters/${encodeURIComponent(status.recruiter.code)}`} className={cp.btn}>Public profile</Link>
            </div>
          </div>
        </section>
      ) : (
        <section className={`${cp.card} p-4`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className={cp.label}>Recruiter signup</p>
              <h2 className={`mt-1 ${cp.title}`}>This wallet is not a recruiter yet.</h2>
              <p className="mt-1 text-[15px] text-mw-muted">
                Choose your recruiter code, add your contact details and confirm the signup with your wallet.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link to="/recruiter/signup" className={PRIMARY_BTN}>Start recruiter signup</Link>
              <Link to="/recruiters" className={cp.btn}>Browse public recruiters</Link>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

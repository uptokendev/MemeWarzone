import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cp } from "@/components/token/coinPageStyles";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRecruiterWallet } from "@/hooks/useRecruiterWallet";
import {
  buildRecruiterSignupMessage,
  checkRecruiterCodeAvailability,
  fetchRecruiterSignupStatus,
  requestRecruiterSignupNonce,
  submitRecruiterSignup,
  type RecruiterCodeAvailability,
  type RecruiterSignupStatus,
} from "@/lib/recruiterApi";

type SignupFormState = {
  displayName: string;
  desiredCode: string;
  email: string;
  telegram: string;
  discord: string;
  xHandle: string;
  pitch: string;
  acceptTerms: boolean;
};

const initialForm: SignupFormState = {
  displayName: "",
  desiredCode: "",
  email: "",
  telegram: "",
  discord: "",
  xHandle: "",
  pitch: "",
  acceptTerms: false,
};

const pageShellClass = "mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 pt-24 pb-8 font-mw-body text-mw-text md:px-2 md:pt-28";

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";
const INPUT =
  "h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text placeholder:text-[#5C6670] focus-visible:ring-mw-accent md:text-[15px]";
const TEXTAREA =
  "rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2 text-[15px] text-mw-text placeholder:text-[#5C6670] focus-visible:ring-mw-accent md:text-[15px]";
const LABEL = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";

export default function RecruiterSignup() {
  const navigate = useNavigate();
  const recruiterWallet = useRecruiterWallet();
  const activeWallet = recruiterWallet.activeWallet;
  const account = activeWallet?.address || "";
  const walletMode = activeWallet?.chain || null;
  const isConnected = Boolean(activeWallet && account);

  const [signupStatus, setSignupStatus] = useState<RecruiterSignupStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [form, setForm] = useState<SignupFormState>(initialForm);
  const [codeAvailability, setCodeAvailability] = useState<RecruiterCodeAvailability | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setSignupStatus(null);
      setStatusError(null);
      return;
    }

    setLoadingStatus(true);
    setStatusError(null);
    void (async () => {
      try {
        const status = await fetchRecruiterSignupStatus(account);
        if (!cancelled) setSignupStatus(status);
      } catch {
        if (!cancelled) setStatusError("We couldn’t load your recruiter status. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    let cancelled = false;
    const nextCode = form.desiredCode.trim();
    if (!nextCode) {
      setCodeAvailability(null);
      setCheckingCode(false);
      return;
    }

    setCheckingCode(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const availability = await checkRecruiterCodeAvailability(nextCode);
          if (!cancelled) setCodeAvailability(availability);
        } catch {
          if (!cancelled) {
            setCodeAvailability({
              code: nextCode,
              isAvailable: null,
              checkedVia: "unavailable",
              message: "Code availability couldn’t be checked. Try again.",
            });
          }
        } finally {
          if (!cancelled) setCheckingCode(false);
        }
      })();
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [form.desiredCode]);

  const updateField = <K extends keyof SignupFormState>(key: K, value: SignupFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const canSubmit = useMemo(() => {
    return Boolean(
      isConnected &&
        account &&
        activeWallet?.canSign &&
        form.displayName.trim() &&
        form.desiredCode.trim() &&
        form.email.trim() &&
        form.pitch.trim() &&
        form.acceptTerms &&
        codeAvailability?.isAvailable,
    );
  }, [activeWallet?.canSign, isConnected, account, form, codeAvailability]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isConnected || !account || !activeWallet) {
      toast.error("Connect your wallet to start recruiter signup.");
      return;
    }
    if (!activeWallet.canSign) {
      toast.error("Wallet signer is unavailable. Reconnect and try again.");
      return;
    }
    if (!form.acceptTerms) {
      toast.error("Accept the recruiter terms before submitting.");
      return;
    }
    if (!codeAvailability?.isAvailable) {
      toast.error("Choose an available recruiter code before submitting.");
      return;
    }

    setSubmitting(true);
    try {
      const chainId = activeWallet.chainId;
      const { nonce } = await requestRecruiterSignupNonce(account, chainId);
      const message = buildRecruiterSignupMessage({
        walletAddress: account,
        chainId,
        nonce,
        displayName: form.displayName,
        desiredCode: form.desiredCode,
        email: form.email,
        telegram: form.telegram,
        discord: form.discord,
        xHandle: form.xHandle,
        pitch: form.pitch,
      });
      const signature = await recruiterWallet.signMessage(activeWallet.chain, account, message);

      await submitRecruiterSignup({
        walletAddress: account,
        chainId,
        displayName: form.displayName.trim(),
        desiredCode: form.desiredCode.trim(),
        email: form.email.trim(),
        telegram: form.telegram.trim(),
        discord: form.discord.trim(),
        xHandle: form.xHandle.trim(),
        pitch: form.pitch.trim(),
        acceptTerms: form.acceptTerms,
        nonce,
        signature,
      });

      toast.success("Recruiter signup submitted.");
      navigate("/command/recruiter", { replace: true });
    } catch {
      toast.error("Recruiter signup couldn’t be completed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isConnected || !account) {
    return (
      <div className={pageShellClass}>
        <section className={`${cp.card} p-4`}>
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter signup</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Connect your wallet to register as a recruiter.</h1>
          <p className="mt-2 text-[15px] text-mw-muted">
            Use the wallet that should own the recruiter profile. BNB and Solana wallets are both supported.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ConnectWalletButton />
            <Link to="/recruiter" className={cp.btn}>Back to recruiter overview</Link>
          </div>
        </section>
      </div>
    );
  }

  if (loadingStatus) {
    return (
      <div className={pageShellClass}>
        <div className={`${cp.card} px-4 py-10 text-center text-[15px] text-mw-muted`}>
          Checking recruiter signup status...
        </div>
      </div>
    );
  }

  if (signupStatus?.isRecruiter && signupStatus.recruiter) {
    return (
      <div className={pageShellClass}>
        <section className={`${cp.card} p-4`}>
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter signup</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">This wallet is already a recruiter.</h1>
          <p className="mt-2 text-[15px] text-mw-muted">
            Wallet <span className="break-all font-mw-mono text-mw-text">{account}</span> already owns recruiter code{" "}
            <span className="font-mw-mono font-bold text-mw-text">{signupStatus.recruiter.code}</span>.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/command/recruiter" className={PRIMARY_BTN}>Open recruiter dashboard</Link>
            <Link to={`/recruiters/${encodeURIComponent(signupStatus.recruiter.code)}`} className={cp.btn}>Public recruiter profile</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={pageShellClass}>
      <div className="max-w-3xl">
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter signup</div>
        <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Claim your recruiter identity.</h1>
        <p className="mt-2 break-all text-[15px] text-mw-muted">Connected via {walletMode === "solana" ? "Solana" : "BNB"}: <span className="font-mw-mono text-mw-text">{account}</span></p>
      </div>

      {statusError ? <div className="rounded-[10px] border border-[#5C1F2B] bg-[#2A1016] p-3 text-[15px] text-mw-sell">{statusError}</div> : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <section className={`${cp.card} p-4`}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="wallet-address" className={LABEL}>Wallet address</Label><Input id="wallet-address" value={account} readOnly className={`${INPUT} font-mw-mono text-xs md:text-xs`} /></div>
            <div className="space-y-2"><Label htmlFor="display-name" className={LABEL}>Recruiter display name</Label><Input id="display-name" value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} placeholder="Warzone Alpha" maxLength={40} className={INPUT} /></div>
            <div className="space-y-2">
              <Label htmlFor="desired-code" className={LABEL}>Desired recruiter code</Label>
              <Input id="desired-code" value={form.desiredCode} onChange={(event) => updateField("desiredCode", event.target.value)} placeholder="alpha-squad" maxLength={24} className={INPUT} />
              <div className="flex items-center gap-2 text-[13px]">
                {checkingCode ? <Loader2 className="h-3.5 w-3.5 animate-spin text-mw-muted" /> : null}
                {codeAvailability?.isAvailable === true ? <span className="flex items-center gap-1 text-[#6EE7A0]"><CheckCircle2 className="h-3.5 w-3.5" />{codeAvailability.message || "Code available"}</span> : null}
                {codeAvailability?.isAvailable === false ? <span className="flex items-center gap-1 text-mw-sell"><AlertCircle className="h-3.5 w-3.5" />{codeAvailability.message || "Code unavailable"}</span> : null}
                {codeAvailability?.isAvailable == null ? <span className="text-mw-muted">{codeAvailability?.message || "Use lowercase letters, numbers, dashes, or underscores."}</span> : null}
              </div>
            </div>
            <div className="space-y-2"><Label htmlFor="email" className={LABEL}>Email</Label><Input id="email" type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} placeholder="you@example.com" className={INPUT} /></div>
            <div className="space-y-2"><Label htmlFor="telegram" className={LABEL}>Telegram</Label><Input id="telegram" value={form.telegram} onChange={(event) => updateField("telegram", event.target.value)} placeholder="@handle" className={INPUT} /></div>
            <div className="space-y-2"><Label htmlFor="discord" className={LABEL}>Discord</Label><Input id="discord" value={form.discord} onChange={(event) => updateField("discord", event.target.value)} placeholder="username#1234" className={INPUT} /></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="x-handle" className={LABEL}>X handle</Label><Input id="x-handle" value={form.xHandle} onChange={(event) => updateField("xHandle", event.target.value)} placeholder="@memewarzone" className={INPUT} /></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="pitch" className={LABEL}>Short pitch / audience description</Label><Textarea id="pitch" value={form.pitch} onChange={(event) => updateField("pitch", event.target.value)} placeholder="Tell us how you plan to grow your squad." rows={5} className={TEXTAREA} /></div>
          </div>
        </section>

        <section className={`${cp.card} p-4`}>
          <div className="flex items-start gap-3">
            <Checkbox id="accept-terms" checked={form.acceptTerms} onCheckedChange={(checked) => updateField("acceptTerms", Boolean(checked))} className="mt-0.5 h-5 w-5 rounded-[2px] border-mw-edge data-[state=checked]:border-mw-accent data-[state=checked]:bg-mw-accent data-[state=checked]:text-[#140A02]" />
            <div className="space-y-1">
              <Label htmlFor="accept-terms" className="text-[15px] font-semibold leading-snug text-mw-text">I confirm this wallet is the recruiter owner and I accept the recruiter program terms.</Label>
              <p className="text-[13px] text-mw-muted">Submitting asks your wallet to sign the recruiter signup message.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className={PRIMARY_BTN} disabled={!canSubmit || submitting}>{submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Signing and submitting...</> : "Sign and submit"}</button>
            <Link to="/recruiter" className={cp.btn}>Back to recruiter overview<ArrowRight className="h-4 w-4" /></Link>
          </div>
        </section>
      </form>
    </div>
  );
}

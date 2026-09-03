import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

const pageShellClass = "mx-auto flex max-w-4xl flex-col gap-6 px-4 pt-24 pb-8 md:pt-28";

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
        <Card className="border-border/60 bg-card/65 p-6">
          <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Recruiter signup</p>
          <h1 className="mt-2 font-retro text-3xl text-foreground">Connect your wallet to register as a recruiter.</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Use the wallet that should own the recruiter profile. BNB and Solana wallets are both supported.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ConnectWalletButton />
            <Button asChild variant="outline" className="font-retro">
              <Link to="/recruiter">Back to recruiter overview</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (loadingStatus) {
    return (
      <div className={pageShellClass}>
        <Card className="border-border/60 bg-card/65 px-6 py-12 text-center text-sm text-muted-foreground">
          Checking recruiter signup status...
        </Card>
      </div>
    );
  }

  if (signupStatus?.isRecruiter && signupStatus.recruiter) {
    return (
      <div className={pageShellClass}>
        <Card className="border-border/60 bg-card/65 p-6">
          <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Recruiter signup</p>
          <h1 className="mt-2 font-retro text-3xl text-foreground">This wallet is already a recruiter.</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Wallet <span className="text-foreground">{account}</span> already owns recruiter code{" "}
            <span className="text-foreground">{signupStatus.recruiter.code}</span>.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild className="font-retro">
              <Link to="/command/recruiter">Open recruiter dashboard</Link>
            </Button>
            <Button asChild variant="outline" className="font-retro">
              <Link to={`/recruiters/${encodeURIComponent(signupStatus.recruiter.code)}`}>Public recruiter profile</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={pageShellClass}>
      <Card className="overflow-hidden border-border/60 bg-[radial-gradient(circle_at_top_left,rgba(240,106,26,0.16),transparent_36%),linear-gradient(180deg,rgba(18,22,28,0.94),rgba(9,12,16,0.98))] p-6 md:p-8">
        <div className="max-w-3xl space-y-4">
          <p className="font-retro text-xs uppercase tracking-[0.24em] text-amber-100/70">Recruiter signup</p>
          <h1 className="font-retro text-3xl text-foreground md:text-5xl">Claim your recruiter identity.</h1>
          <p className="text-sm text-muted-foreground">Connected via {walletMode === "solana" ? "Solana" : "BNB"}: {account}</p>
        </div>
      </Card>

      {statusError ? <Card className="border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">{statusError}</Card> : null}

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="border-border/60 bg-card/65 p-6">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="wallet-address">Wallet address</Label><Input id="wallet-address" value={account} readOnly className="font-mono text-xs" /></div>
            <div className="space-y-2"><Label htmlFor="display-name">Recruiter display name</Label><Input id="display-name" value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} placeholder="Warzone Alpha" maxLength={40} /></div>
            <div className="space-y-2">
              <Label htmlFor="desired-code">Desired recruiter code</Label>
              <Input id="desired-code" value={form.desiredCode} onChange={(event) => updateField("desiredCode", event.target.value)} placeholder="alpha-squad" maxLength={24} />
              <div className="flex items-center gap-2 text-xs">
                {checkingCode ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                {codeAvailability?.isAvailable === true ? <span className="flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{codeAvailability.message || "Code available"}</span> : null}
                {codeAvailability?.isAvailable === false ? <span className="flex items-center gap-1 text-rose-200"><AlertCircle className="h-3.5 w-3.5" />{codeAvailability.message || "Code unavailable"}</span> : null}
                {codeAvailability?.isAvailable == null ? <span className="text-muted-foreground">{codeAvailability?.message || "Use lowercase letters, numbers, dashes, or underscores."}</span> : null}
              </div>
            </div>
            <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} placeholder="you@example.com" /></div>
            <div className="space-y-2"><Label htmlFor="telegram">Telegram</Label><Input id="telegram" value={form.telegram} onChange={(event) => updateField("telegram", event.target.value)} placeholder="@handle" /></div>
            <div className="space-y-2"><Label htmlFor="discord">Discord</Label><Input id="discord" value={form.discord} onChange={(event) => updateField("discord", event.target.value)} placeholder="username#1234" /></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="x-handle">X handle</Label><Input id="x-handle" value={form.xHandle} onChange={(event) => updateField("xHandle", event.target.value)} placeholder="@memewarzone" /></div>
            <div className="space-y-2 md:col-span-2"><Label htmlFor="pitch">Short pitch / audience description</Label><Textarea id="pitch" value={form.pitch} onChange={(event) => updateField("pitch", event.target.value)} placeholder="Tell us how you plan to grow your squad." rows={5} /></div>
          </div>
        </Card>

        <Card className="border-border/60 bg-card/65 p-6">
          <div className="flex items-start gap-3">
            <Checkbox id="accept-terms" checked={form.acceptTerms} onCheckedChange={(checked) => updateField("acceptTerms", Boolean(checked))} />
            <div className="space-y-2">
              <Label htmlFor="accept-terms">I confirm this wallet is the recruiter owner and I accept the recruiter program terms.</Label>
              <p className="text-sm text-muted-foreground">Submitting asks your wallet to sign the recruiter signup message.</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button type="submit" className="font-retro" disabled={!canSubmit || submitting}>{submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Signing and submitting...</> : "Sign and submit"}</Button>
            <Button asChild type="button" variant="outline" className="font-retro"><Link to="/recruiter">Back to recruiter overview<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
          </div>
        </Card>
      </form>
    </div>
  );
}

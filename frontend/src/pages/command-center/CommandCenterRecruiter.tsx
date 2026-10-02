import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Copy, ExternalLink, Gift, Image, Link2, LogOut, ShieldCheck, Trophy, UploadCloud, WalletCards } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { useRecruiterWallet, type RecruiterWalletCandidate } from "@/hooks/useRecruiterWallet";
import { apiFetch } from "@/lib/apiBase";
import { fetchRecruiterSignupStatus, type RecruiterSignupStatus } from "@/lib/recruiterApi";
import {
  fetchRecruiterPortal,
  getPortalSquadImageUrl,
  logoutRecruiterPortal,
  requestRecruiterAuthNonce,
  updateRecruiterPortalCode,
  updateRecruiterPortalSquadImage,
  verifyRecruiterAuth,
  type RecruiterPortalData,
} from "@/lib/recruiterPortalApi";

const MAX_SQUAD_IMAGE_BYTES = 5 * 1024 * 1024;

const benefits = [
  "Your own recruiter code and referral link",
  "Public recruiter profile and leaderboard visibility",
  "Track the creators and traders who join through your link",
  "Weekly recruiter rewards",
  "Claimable recruiter rewards through your creator dashboard",
  "Grow your squad as more creators and traders join",
];

const programSteps = [
  "Apply with your connected wallet",
  "Choose your recruiter code",
  "Share your recruiter link",
  "Grow creators, traders, and squads",
  "Track rewards inside your creator dashboard",
];

function shortAddress(value?: string | null) {
  const raw = String(value || "");
  return raw.length > 10 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw;
}

function formatDate(value?: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleString();
}

function normalizeCode(value: string) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sameWallet(left?: string | null, right?: string | null) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a.startsWith("0x") || b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function uploadChainIdForWallet(walletAddress?: string | null) {
  return String(walletAddress || "").trim().startsWith("0x") ? 56 : 101;
}

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export default function CommandCenterRecruiter() {
  const { walletAddress } = useCommandCenterData();
  const recruiterWallet = useRecruiterWallet();
  const squadImageInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<RecruiterSignupStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [portal, setPortal] = useState<RecruiterPortalData | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [preferredCode, setPreferredCode] = useState("");
  const [squadImageUrl, setSquadImageUrl] = useState("");
  const [authing, setAuthing] = useState(false);
  const [savingCode, setSavingCode] = useState(false);
  const [savingSquadImage, setSavingSquadImage] = useState(false);
  const [uploadingSquadImage, setUploadingSquadImage] = useState(false);

  const activeRecruiterWallet = useMemo<RecruiterWalletCandidate | null>(() => {
    return recruiterWallet.connectedWallets.find((candidate) => sameWallet(candidate.address, walletAddress)) || null;
  }, [recruiterWallet.connectedWallets, walletAddress]);

  useEffect(() => {
    let cancelled = false;
    setLoadingStatus(true);
    setStatusError(null);
    setPortal(null);
    setPortalError(null);

    void fetchRecruiterSignupStatus(walletAddress)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((err: any) => {
        if (!cancelled) setStatusError(String(err?.message || err || "Could not load recruiter status."));
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const recruiter = status?.recruiter ?? null;
  const isRecruiter = Boolean(status?.isRecruiter && recruiter);

  const applyPortal = useCallback((nextPortal: RecruiterPortalData | null) => {
    setPortal(nextPortal);
    setPreferredCode(nextPortal?.recruiter?.recruiter_code || recruiter?.code || "");
    setSquadImageUrl(getPortalSquadImageUrl(nextPortal));
  }, [recruiter?.code]);

  const loadPortal = useCallback(async () => {
    setLoadingPortal(true);
    setPortalError(null);
    try {
      const nextPortal = await fetchRecruiterPortal(walletAddress);
      applyPortal(nextPortal);
      return nextPortal;
    } catch (err: any) {
      setPortal(null);
      setPortalError(String(err?.message || err || "Failed to load recruiter tools."));
      return null;
    } finally {
      setLoadingPortal(false);
    }
  }, [applyPortal, walletAddress]);

  useEffect(() => {
    if (!isRecruiter) {
      setPortal(null);
      setPreferredCode("");
      setSquadImageUrl("");
      return;
    }
    void loadPortal();
  }, [isRecruiter, loadPortal]);

  const activeCode = portal?.recruiter?.recruiter_code || recruiter?.code || walletAddress.slice(2, 8).toLowerCase();
  const baseUrl = typeof window !== "undefined" ? window.location.origin.replace(/\/$/, "") : "https://memewar.zone";
  const canonicalLink = `${baseUrl}/r/${encodeURIComponent(activeCode)}`;
  const queryLink = `${baseUrl}/?ref=${encodeURIComponent(activeCode)}`;
  const activeSquadImage = squadImageUrl || getPortalSquadImageUrl(portal);

  const shareText = useMemo(() => {
    const squadSize = safeCount(portal?.squad?.counts?.total ?? recruiter?.linkedWalletCount);
    return `I’m building my MemeWarzone squad early. ${squadSize} creators and traders already locked in. Join with my code ${activeCode}: ${canonicalLink}`;
  }, [activeCode, canonicalLink, portal?.squad?.counts?.total, recruiter?.linkedWalletCount]);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  };

  const signIntoPortal = async () => {
    if (!activeRecruiterWallet) {
      toast.error("Connect the approved recruiter wallet first.");
      return;
    }
    if (!activeRecruiterWallet.canSign) {
      toast.error(`Connect the approved ${activeRecruiterWallet.label} recruiter wallet first.`);
      return;
    }

    setAuthing(true);
    setPortalError(null);
    try {
      const challenge = await requestRecruiterAuthNonce(activeRecruiterWallet.address);
      const signature = await recruiterWallet.signMessage(activeRecruiterWallet.chain, activeRecruiterWallet.address, challenge.message);
      await verifyRecruiterAuth(activeRecruiterWallet.address, signature);
      const nextPortal = await fetchRecruiterPortal(activeRecruiterWallet.address);
      if (!nextPortal) throw new Error("Signature accepted, but recruiter tools session was not restored. Please try again or refresh once.");
      applyPortal(nextPortal);
      toast.success("Recruiter tools unlocked");
    } catch (err: any) {
      const message = String(err?.message || err || "Wallet sign-in failed.");
      setPortal(null);
      setPortalError(message);
      toast.error(message);
    } finally {
      setAuthing(false);
    }
  };

  const saveCode = async () => {
    const nextCode = normalizeCode(preferredCode);
    if (!nextCode) {
      toast.error("Enter a recruiter code first.");
      return;
    }

    setSavingCode(true);
    setPortalError(null);
    try {
      const result = await updateRecruiterPortalCode(nextCode, walletAddress);
      setPreferredCode(result.recruiter_code);
      await loadPortal();
      toast.success("Recruiter code updated");
    } catch (err: any) {
      setPortalError(String(err?.message || err || "Failed to update recruiter code."));
      toast.error(String(err?.message || "Failed to update recruiter code."));
    } finally {
      setSavingCode(false);
    }
  };

  const saveSquadImageUrl = async (nextImageUrl: string) => {
    setSavingSquadImage(true);
    setPortalError(null);
    try {
      const result = await updateRecruiterPortalSquadImage(nextImageUrl, walletAddress);
      setSquadImageUrl(result.squad_image_url);
      await loadPortal();
      toast.success("Squad image updated");
    } catch (err: any) {
      setPortalError(String(err?.message || err || "Failed to update squad image."));
      toast.error(String(err?.message || "Failed to update recruiter code."));
    } finally {
      setSavingSquadImage(false);
    }
  };

  const uploadSquadImage = async (file: File) => {
    if (!portal) {
      toast.error("Sign in to recruiter tools before uploading a squad image.");
      return;
    }
    if (file.size > MAX_SQUAD_IMAGE_BYTES) {
      toast.error("Squad image is too large. Max upload size is 5 MB.");
      return;
    }
    if (!/^(image\/png|image\/jpeg|image\/jpg|image\/webp)$/.test(file.type)) {
      toast.error("Unsupported image type. Use PNG, JPG, or WebP.");
      return;
    }

    if (!activeRecruiterWallet?.canSign) {
      toast.error("Connect the approved recruiter wallet and sign in before uploading a squad image.");
      return;
    }

    setUploadingSquadImage(true);
    setSavingSquadImage(true);
    setPortalError(null);
    const toastId = toast.loading("Uploading squad image...");

    try {
      // Keep chain aligned with the connected wallet (same as Create logo upload).
      // Do not hardcode 56 — EVM and Solana uploads must sign for their actual chain.
      const chainId = Number(activeRecruiterWallet.chainId || uploadChainIdForWallet(walletAddress));
      const address =
        activeRecruiterWallet.chain === "solana"
          ? String(activeRecruiterWallet.address || walletAddress || "").trim()
          : String(activeRecruiterWallet.address || walletAddress || "").trim().toLowerCase();
      const fd = new FormData();
      fd.append("file", file);
      const qs = new URLSearchParams({
        kind: "squad",
        chainId: String(chainId),
        address,
      });
      // Dual-auth: put signature on the query string (same proven path as Create logo).
      // Multipart form fields with multiline "message" get mangled by some proxies → MESSAGE_MISMATCH.
      // API maps non-logo kinds (including squad) to action upload_avatar.
      try {
        const { signWalletAction, appendAuthToSearchParams } = await import("@/lib/walletActionAuth");
        const auth = await signWalletAction({
          action: "upload_avatar",
          walletAddress: address,
          chainId,
          walletType: activeRecruiterWallet.chain === "solana" ? "solana" : "evm",
          signMessage: (message) =>
            recruiterWallet.signMessage(activeRecruiterWallet.chain, address, message),
        });
        appendAuthToSearchParams(qs, auth);
      } catch (signErr) {
        console.warn("[CommandCenterRecruiter] upload auth sign failed", signErr);
        throw new Error(
          String((signErr as Error)?.message || signErr || "Wallet signature required for upload."),
        );
      }
      const res = await apiFetch(`/api/upload?${qs.toString()}`, { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(json?.error || json?.message || `Upload failed (${res.status})`));
      const uploadedUrl = String(json?.url || "").trim();
      if (!uploadedUrl) throw new Error("Upload succeeded but no image URL was returned.");

      const result = await updateRecruiterPortalSquadImage(uploadedUrl, walletAddress);
      setSquadImageUrl(result.squad_image_url || uploadedUrl);
      await loadPortal();
      toast.success("Squad image uploaded");
    } catch (err: any) {
      const message = String(err?.message || err || "Failed to upload squad image.");
      setPortalError(message);
      toast.error(message);
    } finally {
      toast.dismiss(toastId);
      setUploadingSquadImage(false);
      setSavingSquadImage(false);
    }
  };

  const disconnectPortal = async () => {
    await logoutRecruiterPortal(walletAddress);
    setPortal(null);
    setPreferredCode(recruiter?.code || "");
    setSquadImageUrl("");
    toast.success("Recruiter tools disconnected");
  };

  const shareToX = () => {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const nativeShare = async () => {
    if (navigator.share) {
      await navigator.share({ title: "My MemeWarzone squad", text: shareText, url: canonicalLink });
      return;
    }
    shareToX();
  };

  // UI redesign (artboard Recruiter section): presentation only, every handler above is unchanged.
  const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const tile = "rounded-[14px] border border-mw-border bg-mw-surface p-3";
  const tileValue = "break-all font-mw-mono text-[19px] font-bold text-mw-text";
  const smallButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50";
  const primaryButton = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 font-mw-body text-[15px] font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02] disabled:opacity-50";
  const inputClass = "mw-focus h-11 min-w-0 flex-1 rounded-[10px] border border-[#2E353D] bg-mw-input px-3.5 font-mw-mono text-[13px] text-mw-text outline-none focus:border-mw-accent";
  const errorBox = "rounded-[10px] border border-[#5A1A26] bg-[#2A0E14] p-3 text-sm text-[#FFB4C0]";
  const copyRow = (label: string, value: string, copyLabel: string) => (
    <div className="flex flex-col gap-1">
      <span className={lbl}>{label}</span>
      <div className="flex gap-1.5">
        <input readOnly value={value} aria-label={label} className={inputClass} />
        <button type="button" onClick={() => copyText(value, copyLabel)} className={`${smallButton} min-h-11`}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy
        </button>
      </div>
    </div>
  );

  if (loadingStatus) {
    return (
      <div className="flex flex-col gap-3.5">
        <CommandCenterPageHeader title="Recruiter" />
        <CommandCenterCard title="Recruiter status">
          <div className="text-sm text-mw-muted">Loading recruiter program state...</div>
        </CommandCenterCard>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="flex flex-col gap-3.5">
        <CommandCenterPageHeader title="Recruiter" />
        <CommandCenterCard title="Recruiter status unavailable" description="Try again after refreshing.">
          <div className={errorBox}>{statusError}</div>
        </CommandCenterCard>
      </div>
    );
  }

  if (!isRecruiter) {
    return (
      <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
        <CommandCenterPageHeader title="Recruiter Program">
          <Link to="/recruiters" className={smallButton}>Public leaderboard<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </CommandCenterPageHeader>

        <section className="grid overflow-hidden rounded-[14px] border border-[#5A3416] bg-mw-surface lg:grid-cols-2">
          <RecruiterSignupImage />
          <div className="flex flex-col gap-3 p-3.5 lg:p-[22px]">
            <h3 className="m-0 font-mw-cond text-2xl font-bold">Become a MemeWarzone Recruiter</h3>
            <p className="m-0 text-sm text-mw-muted">Recruiters help grow the arena by bringing in creators, traders, and squads.</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {benefits.map((benefit) => (
                <li key={benefit} className="flex gap-2 text-sm">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-mw-accent" aria-hidden="true" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[13px] text-mw-muted">Your recruiter link is tracked automatically. When creators and traders join through you, MemeWarzone keeps the squad and reward records updated.</p>
            <Link to="/recruiter/signup" className={`${primaryButton} mt-auto min-h-[50px]`}>Become a recruiter</Link>
          </div>
        </section>

        <CommandCenterCard title="How it works">
          <ol className="m-0 flex list-none flex-col p-0">
            {programSteps.map((step, index) => (
              <li key={step} className="flex min-h-11 items-center gap-3 border-b border-[#1E2329] text-sm last:border-b-0">
                <span className="w-5 font-mw-mono font-bold text-mw-accent-soft">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </CommandCenterCard>
      </div>
    );
  }

  const portalLocked = !portal;
  const linkedWalletCount = safeCount(portal?.squad?.counts?.total ?? recruiter?.linkedWalletCount);
  const tiles: Array<[string, string]> = [
    ["Linked wallets", linkedWalletCount.toLocaleString()],
    ...(portal ? ([["Creators", String(safeCount(portal.squad?.counts?.creators))], ["Traders", String(safeCount(portal.squad?.counts?.traders))]] as Array<[string, string]>) : []),
    ["Code", activeCode],
    ["Status", String(portal?.recruiter?.status || recruiter?.status || "unknown")],
  ];

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <CommandCenterPageHeader title="Recruiter Management">
        <Link to="/recruiters" className={smallButton}>Public leaderboard<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
      </CommandCenterPageHeader>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 lg:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
        {tiles.map(([label, value]) => (
          <div key={label} className={tile}>
            <div className={lbl}>{label}</div>
            <div className={`${tileValue} ${label === "Status" ? "capitalize" : ""}`}>{value}</div>
          </div>
        ))}
      </div>

      <CommandCenterCard title="Your links">
        {copyRow("Referral link", canonicalLink, "Canonical link")}
        {copyRow("Home link", queryLink, "Universal link")}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={shareToX} className={smallButton}><ExternalLink className="h-4 w-4" aria-hidden="true" />Share on X</button>
          <button type="button" onClick={() => void nativeShare()} className={smallButton}><Gift className="h-4 w-4" aria-hidden="true" />Share squad</button>
          <Link to={`/recruiters/${encodeURIComponent(activeCode)}`} className={smallButton}>Public recruiter page</Link>
          <Link to="/command/claims" className={smallButton}><WalletCards className="h-4 w-4" aria-hidden="true" />Rewards and claims</Link>
        </div>
      </CommandCenterCard>

      <CommandCenterCard title="Recruiter tools">
        {portalLocked ? (
          <div className="flex flex-col gap-2.5">
            <p className="m-0 text-sm text-mw-muted">Sign with the approved recruiter wallet to edit your recruiter code, squad image, and sharing links.</p>
            {!activeRecruiterWallet && <div className={errorBox}>The connected wallet does not match this command-center wallet. Switch to {shortAddress(walletAddress)} first.</div>}
            {portalError && <div className={errorBox}>{portalError}</div>}
            <button type="button" onClick={signIntoPortal} disabled={authing || loadingPortal || !activeRecruiterWallet} className={`${primaryButton} w-max`}>{authing ? "Waiting for signature..." : loadingPortal ? "Loading tools..." : "Sign in to manage"}</button>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1">
              <label htmlFor="recruiter-code" className={lbl}>Recruiter code</label>
              <div className="flex flex-col gap-1.5 sm:flex-row">
                <input id="recruiter-code" value={preferredCode} onChange={(event) => setPreferredCode(normalizeCode(event.target.value))} className={inputClass} placeholder="YOURCODE" />
                <button type="button" onClick={saveCode} disabled={savingCode} className={`${primaryButton} min-h-11`}>{savingCode ? "Saving..." : "Save code"}</button>
              </div>
              {portalError && <div className={`${errorBox} mt-1.5`}>{portalError}</div>}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={`${lbl} flex items-center gap-1.5`}><Image className="h-4 w-4 text-mw-accent" aria-hidden="true" />Squad image</span>
              <p className="m-0 text-[13px] text-mw-muted">Upload a PNG, JPG, or WebP image. The uploaded image is saved to your public recruiter squad profile.</p>
              <input
                ref={squadImageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadSquadImage(file);
                  event.currentTarget.value = "";
                }}
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {activeSquadImage ? <img src={activeSquadImage} alt="Squad preview" className="h-16 w-16 rounded-[10px] border border-mw-border object-cover" /> : <div className="flex h-16 w-16 items-center justify-center rounded-[10px] border border-dashed border-mw-edge bg-mw-input"><Image className="h-5 w-5 text-mw-muted" aria-hidden="true" /></div>}
                <div className="min-w-0 flex-1 text-xs text-mw-muted">
                  {activeSquadImage ? <div className="truncate font-mw-mono">{activeSquadImage}</div> : "No squad image uploaded yet."}
                </div>
                <button type="button" onClick={() => squadImageInputRef.current?.click()} disabled={savingSquadImage || uploadingSquadImage} className={smallButton}>
                  {uploadingSquadImage ? <><UploadCloud className="h-4 w-4 animate-pulse" aria-hidden="true" />Uploading...</> : <><UploadCloud className="h-4 w-4" aria-hidden="true" />Upload image</>}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => copyText(canonicalLink, "Referral link")} className={smallButton}><Link2 className="h-4 w-4" aria-hidden="true" />Copy referral link</button>
              <button type="button" onClick={() => void disconnectPortal()} className={smallButton}><LogOut className="h-4 w-4" aria-hidden="true" />Disconnect session</button>
              <Link to="/recruiters" className={smallButton}><Trophy className="h-4 w-4" aria-hidden="true" />Leaderboard</Link>
            </div>
          </div>
        )}
      </CommandCenterCard>

      {portal && (
        <CommandCenterCard title="Recent referrals">
          {!Array.isArray(portal.squad?.rows) || portal.squad.rows.length === 0 ? (
            <div className="text-sm text-mw-muted">No squad members yet. Share your code and start onboarding creators or traders.</div>
          ) : (
            <div className="flex flex-col">
              {portal.squad.rows.map((row) => (
                <div key={`${row.wallet_address}-${row.bound_at}`} className="flex min-h-[44px] flex-wrap items-center gap-2.5 border-b border-[#1E2329] py-1.5 text-sm last:border-b-0">
                  <span className="font-mw-mono">{shortAddress(row.wallet_address)}</span>
                  <span className="text-mw-muted">· {row.role}</span>
                  <span className="flex-1 text-right text-[13px] text-mw-muted">Joined {formatDate(row.bound_at)}</span>
                  <button type="button" onClick={() => copyText(row.wallet_address, "Wallet")} className={smallButton}>Copy</button>
                </div>
              ))}
              {safeCount(portal.squad?.counts?.unknown) > 0 ? <div className="pt-2 text-[13px] text-mw-muted">Role pending: {safeCount(portal.squad?.counts?.unknown)}</div> : null}
            </div>
          )}
        </CommandCenterCard>
      )}
    </div>
  );
}

/** Founder's recruiter image (680 x 400). Drop the file at public/assets/recruiter-signup.png; a placeholder shows until then. */
function RecruiterSignupImage() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex min-h-[190px] items-center justify-center border-b border-mw-border bg-mw-input p-4 text-center text-sm text-mw-muted lg:min-h-[340px] lg:border-b-0 lg:border-r">
        Recruiter image · 680 × 400
      </div>
    );
  }
  return (
    <img
      src="/assets/recruiter-signup.png"
      alt="Become a MemeWarzone recruiter"
      onError={() => setFailed(true)}
      className="h-full min-h-[190px] w-full object-cover lg:min-h-[340px]"
    />
  );
}

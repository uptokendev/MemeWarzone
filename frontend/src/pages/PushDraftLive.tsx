import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Clock3, Rocket, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GraduationTierSelector } from "@/components/launchpad/GraduationTierSelector";
import {
  emitCreatorArmBlocked,
  resolveCreatorArmBlock,
} from "@/components/prepare/CreatorArmEligibilityDialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { fetchCampaignDraft, type PrepareDraftBundle } from "@/lib/draftApi";
import { signDraftAction } from "@/lib/draftAuth";
import { apiFetch } from "@/lib/apiBase";
import { getChainLabel, isSolanaChainId } from "@/lib/chainConfig";
import {
  DEFAULT_GRADUATION_TARGET_WEI,
  graduationTargetToUsdMicros,
  graduationTierLabel,
  isSupportedGraduationTarget,
} from "@/lib/graduationTiers";
import { useLaunchpad } from "@/lib/launchpadClient";
import { resolveImageUri } from "@/lib/media";
import { isCreatorArmCooldownActive } from "@/lib/creatorArmCooldown";
import {
  deployScheduledDraftCampaignV2,
  readScheduledCreatorLaunchEligibility,
  type ScheduledCreatorLaunchEligibility,
} from "@/lib/scheduledLaunchClientV2";
import { getScheduledFactoryAddress } from "@/lib/scheduledFactoryConfig";
import { requestSolanaCreateAuthorizationV4 } from "@/lib/solanaCreateAuthorizationV4";
import { submitSolanaV4CreateFromAuthorization } from "@/lib/solanaV4CreateSubmit";
import { signSolanaDraftAction } from "@/lib/solanaWallet";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

const DRAFT_PUSH_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_DRAFT_PUSH_LIVE_ENABLED || import.meta.env.VITE_ENABLE_DRAFT_PUSH_LIVE || "")
    .trim()
    .toLowerCase(),
);

function canPushLive(status?: string) {
  return status === "promotion_published" || status === "ready_to_launch";
}

function sameWallet(a?: string | null, b?: string | null) {
  if (!a || !b) return false;
  if (a.length >= 32 && !a.startsWith("0x")) return a === b || a.toLowerCase() === b.toLowerCase();
  return a.toLowerCase() === b.toLowerCase();
}

function toLocalInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local browser time";
  } catch {
    return "Local browser time";
  }
}

function timeZoneOffset(date: Date) {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(totalMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function formatLocalLaunch(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function markDraftDeployment(input: {
  draftId: string;
  auth: any;
  campaignAddress: string;
  tokenAddress?: string;
  deployTxHash?: string;
  scheduledLaunchAt?: number;
  tokenVault?: string | null;
  solVault?: string | null;
  campaignId?: number[] | string | null;
  factoryAddress?: string | null;
}) {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(input.draftId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth: input.auth,
      campaignAddress: input.campaignAddress,
      tokenAddress: input.tokenAddress || null,
      deployTxHash: input.deployTxHash || null,
      scheduledLaunchAt: input.scheduledLaunchAt || null,
      tokenVault: input.tokenVault || null,
      solVault: input.solVault || null,
      campaignId: input.campaignId || null,
      factoryAddress: input.factoryAddress || null,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
  return json;
}

export default function PushDraftLive() {
  const { draftId = "" } = useParams();
  const navigate = useNavigate();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const launchpad = useLaunchpad();

  const [bundle, setBundle] = useState<PrepareDraftBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [creatorEligibility, setCreatorEligibility] = useState<ScheduledCreatorLaunchEligibility | null>(null);
  const [creatorEligibilityError, setCreatorEligibilityError] = useState<string | null>(null);
  const [mode, setMode] = useState<"now" | "scheduled">("now");
  const [graduationTargetWei, setGraduationTargetWei] = useState(DEFAULT_GRADUATION_TARGET_WEI);
  const [launchAtInput, setLaunchAtInput] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));

  const showArmBlock = (detail: Parameters<typeof emitCreatorArmBlocked>[0]) => {
    emitCreatorArmBlocked(detail);
  };

  const viewerWallet = wallet.account || solanaWallet.solanaAccount || null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCampaignDraft(draftId, viewerWallet)
      .then((data) => {
        if (cancelled) return;
        setBundle(data);
        try {
          const persistedTarget = BigInt(String(data.draft.graduationTargetWei || DEFAULT_GRADUATION_TARGET_WEI));
          if (isSupportedGraduationTarget(Number(data.draft.chainId), persistedTarget)) {
            setGraduationTargetWei(persistedTarget);
          }
        } catch {
          setGraduationTargetWei(DEFAULT_GRADUATION_TARGET_WEI);
        }
      })
      .catch(() => toast.error("We couldn’t load this draft. Please refresh and try again."))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draftId, viewerWallet]);

  const draft = bundle?.draft;
  const draftIsSolana = isSolanaChainId(Number(draft?.chainId));
  const ownerConnected = draftIsSolana
    ? Boolean(
        draft?.creatorWallet &&
          solanaWallet.solanaAccount &&
          String(draft.creatorWallet).trim() === String(solanaWallet.solanaAccount).trim(),
      )
    : sameWallet(draft?.creatorWallet, wallet.account);
  const logoURI = useMemo(() => resolveImageUri(draft?.logoUrl) || draft?.logoUrl || "", [draft?.logoUrl]);
  const chainLabel = draft ? getChainLabel(Number(draft.chainId)) : "Unknown";
  const selectedTier = graduationTierLabel(graduationTargetWei);
  const scheduledFactoryAddress = useMemo(
    () => getScheduledFactoryAddress(Number(draft?.chainId || 0), launchpad.factoryAddress),
    [draft?.chainId, launchpad.factoryAddress],
  );
  const eligibilityFactoryAddress = scheduledFactoryAddress || launchpad.factoryAddress;
  const creatorTimeZone = useMemo(() => browserTimeZone(), []);
  const selectedLaunchDate = useMemo(() => new Date(launchAtInput), [launchAtInput]);
  const selectedLaunchValid = Number.isFinite(selectedLaunchDate.getTime());

  useEffect(() => {
    if (!draft || draftIsSolana || !wallet.signer || !wallet.account || !eligibilityFactoryAddress) {
      setCreatorEligibility(null);
      setCreatorEligibilityError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      readScheduledCreatorLaunchEligibility({
        signer: wallet.signer!,
        chainId: Number(draft.chainId),
        factoryAddress: eligibilityFactoryAddress,
      })
        .then((result) => {
          if (!cancelled) {
            setCreatorEligibility(result);
            setCreatorEligibilityError(null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCreatorEligibility(null);
            setCreatorEligibilityError("We couldn’t check creator eligibility right now. Please try again shortly.");
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft, draftIsSolana, wallet.signer, wallet.account, eligibilityFactoryAddress]);

  const deploySolanaV4 = async () => {
    if (!draft) return;
    if (!DRAFT_PUSH_LIVE_ENABLED) {
      return toast.error("Launching is temporarily unavailable. Your draft remains saved. Please try again later.");
    }
    if (!solanaWallet.solanaAccount) return toast.error("Connect the draft owner Solana wallet first.");
    if (!ownerConnected) return toast.error("Only the draft owner Solana wallet can deploy this draft.");
    if (!canPushLive(draft.status)) return toast.error("Publish the promotion page before deployment.");
    if (!logoURI) {
      return toast.error("Draft needs a saved logo. Re-upload a PNG, JPG or WebP under 5 MB on the promotion page.");
    }
    toast.message("Preparing your Solana launch…");

    setSubmitting(true);
    try {
      const graduationTargetUsdMicros = graduationTargetToUsdMicros(graduationTargetWei);

      let launchAt: string | number = "0";
      if (mode === "scheduled") {
        const at = Math.floor(new Date(launchAtInput).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isInteger(at) || at < now + 5 * 60) {
          throw new Error("Choose a trading-open time at least five minutes in the future.");
        }
        if (at > now + 30 * 24 * 60 * 60) {
          throw new Error("Scheduled launches cannot be more than 30 days away.");
        }
        launchAt = at;
      }

      const { clearSolanaDraftOwnerSession } = await import("@/lib/solanaWallet");
      let deployAuth = await signSolanaDraftAction({
        walletAddress: solanaWallet.solanaAccount,
        chainId: Number(draft.chainId),
        action: "deploy_draft",
        draftId: draft.id,
      });

      const refreshDeployAuth = async () => {
        clearSolanaDraftOwnerSession({
          walletAddress: solanaWallet.solanaAccount!,
          chainId: Number(draft.chainId),
          draftId: draft.id,
        });
        deployAuth = await signSolanaDraftAction({
          walletAddress: solanaWallet.solanaAccount!,
          chainId: Number(draft.chainId),
          action: "deploy_draft",
          draftId: draft.id,
          forceNewOwnerSession: true,
        });
        return deployAuth;
      };

      let authorization;
      try {
        authorization = await requestSolanaCreateAuthorizationV4({
          draftId: draft.id,
          auth: deployAuth,
          graduationTargetUsdMicros,
          launchAt,
        });
      } catch (authErr: any) {
        const msg = String(authErr?.message || authErr || "");
        if (/CreatorProfile|RiskProfile|sync-creator|sync-risk|profile is not initialized/i.test(msg)) {
          throw new Error(`Your creator profile for wallet ${solanaWallet.solanaAccount} isn’t ready for launch yet. Please try again shortly. If this continues, contact support.`);
        }
        if (/DRAFT_PUSH_LIVE|Push Live is locked/i.test(msg)) {
          throw new Error("Launching is temporarily unavailable. Your draft remains saved. Please try again later.");
        }
        if (/nonce invalid|already used|sign again|Unauthorized|401/i.test(msg)) {
          await refreshDeployAuth();
          authorization = await requestSolanaCreateAuthorizationV4({
            draftId: draft.id,
            auth: deployAuth,
            graduationTargetUsdMicros,
            launchAt,
          });
        } else {
          throw authErr;
        }
      }

      if (authorization.alreadyOnChain || authorization.draftFinalized || authorization.existingDeployment) {
        const campaignAddress = authorization.existingDeployment?.campaignAddress || authorization.accounts?.campaign || "";
        const mintAddress = authorization.existingDeployment?.mintAddress || authorization.accounts?.mint || "";
        const chainId = Number(draft.chainId) || 101;
        const tokenPath =
          (authorization as any).tokenPath ||
          authorization.existingDeployment?.tokenPath ||
          tokenDetailsPath(
            { tokenAddress: mintAddress, campaignAddress, chainId },
            { chainId },
          );
        const recoveryVaults = {
          tokenVault: authorization.accounts?.tokenVault || (authorization.existingDeployment as any)?.tokenVault || null,
          solVault: authorization.accounts?.solVault || (authorization.existingDeployment as any)?.solVault || null,
          campaignId: authorization.createArgs?.campaignId || (authorization.existingDeployment as any)?.campaignIdHex || null,
          factoryAddress: authorization.programId || null,
        };

        try {
          await markDraftDeployment({
            draftId: draft.id,
            auth: deployAuth,
            campaignAddress,
            tokenAddress: mintAddress,
            deployTxHash: "already-on-chain",
            scheduledLaunchAt: mode === "scheduled" && launchAt !== "0" ? Number(launchAt) : null,
            ...recoveryVaults,
          });
        } catch (markErr: any) {
          console.warn("[PushDraftLive] recovery mark-deploy", markErr);
        }

        const registryOk = (authorization as any).registryUpserted !== false && !(authorization as any).registryError;
        if (!registryOk && (authorization as any).registryError) {
          toast.message("Your campaign is live, but it may take a moment to appear in public listings. Opening the token page now.", { duration: 16_000 });
        } else {
          toast.success(`Solana campaign is live. Opening token page (${(mintAddress || campaignAddress).slice(0, 8)}…).`, { duration: 12_000 });
        }
        if (mode === "scheduled") {
          toast.success("Solana campaign is linked. Trading stays closed until the scheduled open time.");
          navigate(`/prepare/${draft.slug}`);
          return;
        }
        navigate(tokenPath);
        return;
      }

      const created = await submitSolanaV4CreateFromAuthorization(authorization, {
        creatorAddress: solanaWallet.solanaAccount,
        onPreflightReady: (preview) => {
          toast.success(
            `Solana deployment ready · Security checks passed ✓ · Transaction simulation passed ✓ · Estimated deployment cost: ≈ ${(preview.estimatedDeploymentLamports / 1_000_000_000).toFixed(4)} SOL`,
            { duration: 8_000 },
          );
        },
      });
      if (created.recovered) {
        toast.message("Existing Solana campaign found for this draft — finalizing without a new create.");
      }

      const createVaults = {
        tokenVault: authorization.accounts?.tokenVault || null,
        solVault: authorization.accounts?.solVault || null,
        campaignId: authorization.createArgs?.campaignId || null,
        factoryAddress: authorization.programId || null,
      };
      let marked = false;
      try {
        await markDraftDeployment({
          draftId: draft.id,
          auth: deployAuth,
          campaignAddress: created.campaignAddress,
          tokenAddress: created.mintAddress,
          deployTxHash: created.signature,
          scheduledLaunchAt: mode === "scheduled" && launchAt !== "0" ? Number(launchAt) : null,
          ...createVaults,
        });
        marked = true;
      } catch (markErr: any) {
        const msg = String(markErr?.message || markErr || "");
        if (/nonce invalid|already used|sign again|Unauthorized|401|already has an on-chain|ALREADY_DEPLOYED/i.test(msg)) {
          try {
            if (/401|nonce|Unauthorized|sign again/i.test(msg)) {
              await refreshDeployAuth();
            }
            await markDraftDeployment({
              draftId: draft.id,
              auth: deployAuth,
              campaignAddress: created.campaignAddress,
              tokenAddress: created.mintAddress,
              deployTxHash: created.signature,
              scheduledLaunchAt: mode === "scheduled" && launchAt !== "0" ? Number(launchAt) : null,
              ...createVaults,
            });
            marked = true;
          } catch {
            if (/already has an on-chain|ALREADY_DEPLOYED|alreadyDeployed/i.test(msg)) {
              marked = true;
            }
          }
        }
        if (!marked) {
          console.error("[PushDraftLive] mark-deploy failed after Solana create", markErr);
          toast.success(
            `Your Solana campaign was created, but we couldn’t finish linking it to your draft. Campaign: ${created.campaignAddress.slice(0, 8)}… Transaction: ${created.signature.slice(0, 12)}… Retry Push Live to finish linking it without creating another campaign.`,
            { duration: 20_000 },
          );
          navigate(`/prepare/${draft.slug}`);
          return;
        }
      }

      const livePath = tokenDetailsPath(
        {
          tokenAddress: created.mintAddress,
          campaignAddress: created.campaignAddress,
          chainId: Number(draft.chainId) || 101,
        },
        { chainId: Number(draft.chainId) || 101 },
      );
      if (mode === "scheduled") {
        toast.success("Solana campaign deployed. Trading stays closed until the scheduled open time.");
        navigate(`/prepare/${draft.slug}`);
        return;
      }
      toast.success("Solana campaign deployed. Opening the token page.");
      navigate(livePath);
    } catch (error: any) {
      const message = String(error?.message || error || "Solana deploy failed.");
      const isKnownUserMessage =
        message.startsWith("Choose a trading-open time") ||
        message.startsWith("Scheduled launches cannot") ||
        message.startsWith("Your creator profile") ||
        message.startsWith("Launching is temporarily unavailable");
      toast.error(isKnownUserMessage ? message : "We couldn’t launch your Solana campaign. Your draft remains saved. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const deploy = async () => {
    if (!draft) return;
    if (!DRAFT_PUSH_LIVE_ENABLED) return toast.error("Launching is temporarily unavailable. Your draft remains saved. Please try again later.");
    if (draftIsSolana) return deploySolanaV4();
    if (!wallet.account || !wallet.signer) return toast.error("Connect the draft owner wallet first.");
    if (!ownerConnected) return toast.error("Only the draft owner wallet can deploy this draft.");
    if (Number(wallet.chainId) !== Number(draft.chainId)) return toast.error(`Switch your wallet to ${chainLabel}.`);
    if (!canPushLive(draft.status)) return toast.error("Publish the promotion page before deployment.");
    if (!logoURI) return toast.error("Draft needs a saved logo before deployment.");
    try {
      const { assertOnchainLogoUri } = await import("@/lib/onchainLogoUri");
      assertOnchainLogoUri(logoURI);
    } catch (error: any) {
      return toast.error(String(error?.message || "Draft logo must be an uploaded https URL."));
    }
    if (!eligibilityFactoryAddress || (mode === "scheduled" && !scheduledFactoryAddress) || (mode === "now" && !launchpad.factoryAddress)) {
      return toast.error(`Launching is temporarily unavailable on ${chainLabel}. Your draft remains saved. Please try again later.`);
    }

    setSubmitting(true);
    let latestEligibility: ScheduledCreatorLaunchEligibility | null = creatorEligibility;
    try {
      const eligibility = await readScheduledCreatorLaunchEligibility({
        signer: wallet.signer,
        chainId: Number(draft.chainId),
        factoryAddress: eligibilityFactoryAddress,
      });
      latestEligibility = eligibility;
      setCreatorEligibility(eligibility);
      if (!eligibility.allowed) {
        const now = Math.floor(Date.now() / 1000);
        let message = "This creator wallet cannot deploy or arm another campaign right now.";
        if (eligibility.currentLiveCount >= eligibility.maxLiveBonding) {
          message =
            `Live campaign limit reached (${eligibility.currentLiveCount}/${eligibility.maxLiveBonding}). ` +
            "Graduate an existing live campaign before another deploy/arm. Tier 1 max is 3 concurrent live campaigns (including timed arms).";
        } else if (isCreatorArmCooldownActive({ ...eligibility, nowSeconds: now })) {
          message =
            `Creator arm cooldown active until ${new Date(eligibility.cooldownEndsAt * 1000).toISOString()}. ` +
            "Immediate and timed arms both require 24h between on-chain deploys. A later trading-open time does not bypass this.";
        }
        showArmBlock(resolveCreatorArmBlock({ mode, eligibility, errorMessage: message }));
        return;
      }

      let scheduledLaunchAt: number | null = null;
      if (mode === "scheduled") {
        const launchAt = Math.floor(new Date(launchAtInput).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isInteger(launchAt) || launchAt < now + 5 * 60) {
          throw new Error("Choose a trading-open time at least five minutes in the future.");
        }
        if (launchAt > now + 30 * 24 * 60 * 60) {
          throw new Error("Scheduled launches cannot be more than 30 days away.");
        }
        scheduledLaunchAt = launchAt;
      }

      const deployAuth = await signDraftAction({
        signer: wallet.signer,
        walletAddress: wallet.account,
        chainId: draft.chainId,
        action: "deploy_draft",
        draftId: draft.id,
      });

      if (mode === "scheduled" && scheduledLaunchAt) {
        const created = await deployScheduledDraftCampaignV2({
          signer: wallet.signer,
          auth: deployAuth,
          chainId: draft.chainId,
          factoryAddress: scheduledFactoryAddress,
          draftId: draft.id,
          launchAt: scheduledLaunchAt,
          graduationTargetWei,
        });
        if (!created.campaignAddress) throw new Error("Scheduled campaign was deployed but its address could not be read from the receipt.");

        await markDraftDeployment({
          draftId: draft.id,
          auth: deployAuth,
          campaignAddress: created.campaignAddress,
          tokenAddress: created.tokenAddress,
          deployTxHash: created.txHash,
          scheduledLaunchAt,
        });

        toast.success(`${selectedTier} campaign deployed. Gas is paid now; trading opens at the selected time.`);
        navigate(`/prepare/${draft.slug}`);
        return;
      }

      const created = await launchpad.createCampaign({
        name: draft.name,
        symbol: draft.ticker.toUpperCase(),
        logoURI,
        xAccount: draft.xUrl || bundle?.promotion?.xUrl || "",
        website: draft.websiteUrl || bundle?.promotion?.websiteUrl || "",
        extraLink: draft.otherUrl || "",
        basePriceWei: 0n,
        priceSlopeWei: 0n,
        graduationTargetWei,
        lpReceiver: "",
      });

      if (!created.campaignAddress) throw new Error("Campaign was deployed but its address could not be read from the receipt.");
      await markDraftDeployment({
        draftId: draft.id,
        auth: deployAuth,
        campaignAddress: created.campaignAddress,
        tokenAddress: created.tokenAddress,
        deployTxHash: String((created as any)?.hash || ""),
      });

      toast.success(`${selectedTier} campaign is live.`);
      navigate(`/token/${created.tokenAddress || created.campaignAddress}`);
    } catch (err: any) {
      const message = String(
        err?.shortMessage ||
          err?.reason ||
          err?.info?.error?.message ||
          err?.data?.message ||
          err?.message ||
          "Draft deployment failed.",
      );
      const code = String(err?.code || err?.data?.code || err?.error?.code || err?.preflight?.code || "");
      const lower = message.toLowerCase();
      const looksLikeArmBlock =
        lower.includes("cooldown") ||
        lower.includes("not eligible") ||
        lower.includes("creatornoteligible") ||
        lower.includes("live campaign limit") ||
        lower.includes("cannot deploy or arm") ||
        lower.includes("cannot arm another") ||
        code.includes("ELIGIB") ||
        code.includes("COOLDOWN") ||
        (latestEligibility != null && latestEligibility.allowed === false);

      if (looksLikeArmBlock || (latestEligibility != null && isCreatorArmCooldownActive(latestEligibility))) {
        showArmBlock(resolveCreatorArmBlock({ mode, eligibility: latestEligibility, errorMessage: message, errorCode: code }));
      } else if (message.startsWith("Choose a trading-open time") || message.startsWith("Scheduled launches cannot")) {
        toast.error(message);
      } else {
        toast.error(`We couldn’t deploy your campaign on ${chainLabel}. Your draft remains saved. Please try again.`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="mx-auto max-w-4xl py-20 text-center font-retro text-muted-foreground">Loading draft...</div>;
  if (!draft || !bundle) {
    return (
      <div className="mx-auto max-w-4xl py-20 text-center">
        <h1 className="font-retro text-4xl text-foreground">Draft not found</h1>
        <Button asChild className="mwz-button mt-6 font-retro"><Link to="/profile?tab=drafts">Back to Drafts</Link></Button>
      </div>
    );
  }

  const blocked = submitting || !DRAFT_PUSH_LIVE_ENABLED || !canPushLive(draft.status) || (draftIsSolana ? !ownerConnected : false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mwz-card p-5 md:p-7">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-orange-400">Prepare Mode</div>
            <h1 className="mwz-section-title mt-1 text-3xl text-success md:text-4xl">Deploy Draft</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Choose the graduation tier and deploy immediately, or pay gas now and arm a countdown that blocks trading until launch time.
            </p>
          </div>
          <Button asChild variant="outline" className="mwz-button h-10 font-retro text-xs">
            <Link to={`/drafts/${draft.id}/promotion`}>Back to Setup</Link>
          </Button>
        </div>

        <div className="mb-5 grid gap-4 md:grid-cols-[140px_1fr]">
          <div className="mwz-card overflow-hidden border-success/35 bg-black/70">
            <img src={logoURI || "/placeholder.svg"} alt={draft.name} className="aspect-square h-full w-full object-cover" />
          </div>
          <div className="mwz-card p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-success" /> {chainLabel} · ${draft.ticker} · {draft.status.replace(/_/g, " ")}
            </div>
            <h2 className="mt-3 font-retro text-2xl text-foreground">{draft.name}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{bundle.promotion.missionStatement || draft.description || "No mission statement saved yet."}</p>
          </div>
        </div>

        <GraduationTierSelector chainId={Number(draft.chainId)} value={graduationTargetWei} onChange={setGraduationTargetWei} disabled={submitting} />

        <div className="mwz-card mt-5 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Creator deployment eligibility</div>
          {creatorEligibility?.allowed ? (
            <div className="mt-2 space-y-1">
              <p className="text-sm text-green-300">Eligible to deploy or arm now.</p>
              <p className="text-xs text-muted-foreground">Live campaigns: {creatorEligibility.currentLiveCount} / {creatorEligibility.maxLiveBonding}</p>
            </div>
          ) : creatorEligibility ? (
            <div className="mt-2 space-y-2 text-sm text-orange-300">
              {isCreatorArmCooldownActive(creatorEligibility) ? (
                <p>Creator cooldown active. Another campaign may be deployed or armed after {formatLocalLaunch(creatorEligibility.cooldownEndsAt)} ({creatorTimeZone}).</p>
              ) : creatorEligibility.currentLiveCount >= creatorEligibility.maxLiveBonding ? (
                <p>Live campaign limit reached ({creatorEligibility.currentLiveCount} / {creatorEligibility.maxLiveBonding}).</p>
              ) : (
                <p>This creator wallet cannot deploy or arm another campaign right now.</p>
              )}
              <p className="text-xs text-muted-foreground">Trading-open time does not affect arm cooldown. Arming, even with a timer, starts the 24h creator cooldown immediately.</p>
              <Button
                type="button"
                variant="outline"
                className="h-8 border-orange-400/40 bg-orange-500/10 px-3 text-xs text-orange-200 hover:bg-orange-500/20"
                onClick={() => showArmBlock(resolveCreatorArmBlock({ mode, eligibility: creatorEligibility, errorMessage: "Deployment not available for this wallet right now." }))}
              >
                Why can&apos;t I deploy?
              </Button>
            </div>
          ) : null}
          {creatorEligibilityError ? <p className="mt-2 text-sm text-orange-300">{creatorEligibilityError}</p> : null}
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <button type="button" onClick={() => setMode("now")} className={`mwz-card p-4 text-left ${mode === "now" ? "border-success/60 bg-success/10" : "border-border"}`}>
            <div className="flex items-center gap-2 font-retro text-lg text-foreground"><Rocket className="h-4 w-4" /> Deploy now</div>
            <p className="mt-2 text-sm text-muted-foreground">Pay gas, deploy the campaign, and open trading immediately.</p>
          </button>
          <button type="button" onClick={() => setMode("scheduled")} className={`mwz-card p-4 text-left ${mode === "scheduled" ? "border-orange-400/60 bg-orange-500/10" : "border-border"}`}>
            <div className="flex items-center gap-2 font-retro text-lg text-foreground"><Clock3 className="h-4 w-4" /> Deploy with countdown</div>
            <p className="mt-2 text-sm text-muted-foreground">Pay gas now. The campaign is created immediately, but trading remains blocked until the selected time.</p>
          </button>
        </div>

        {mode === "scheduled" ? (
          <div className="mwz-card mt-4 p-4">
            <label className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Trading opens at ({creatorTimeZone})</label>
            <Input
              type="datetime-local"
              value={launchAtInput}
              onChange={(event) => setLaunchAtInput(event.target.value)}
              min={toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000))}
              max={toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))}
              className="mt-2 max-w-md"
              disabled={submitting}
            />
            {selectedLaunchValid ? (
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <p>Creator timezone: <span className="text-foreground">{creatorTimeZone} ({timeZoneOffset(selectedLaunchDate)})</span></p>
                <p>UTC time: <span className="text-foreground">{selectedLaunchDate.toISOString().replace("T", " ").slice(0, 16)} UTC</span></p>
                <p className="pt-1 text-orange-200">This timestamp controls only when trading opens. It is not reserved, queued, or made exclusive to this campaign.</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {!ownerConnected ? (
          <p className="mt-4 text-sm text-orange-300">
            {draftIsSolana ? "Connect the draft owner Solana wallet (Phantom/Solflare) before deployment." : "Connect the draft owner wallet before deployment."}
          </p>
        ) : null}
        {draftIsSolana && ownerConnected ? (
          <p className="mt-4 text-sm text-muted-foreground">Your wallet will confirm the Solana launch transaction. Trading becomes available according to the launch time you selected.</p>
        ) : null}
        {!DRAFT_PUSH_LIVE_ENABLED ? <p className="mt-4 text-sm text-orange-300">Draft deployment is temporarily unavailable. Your draft remains saved.</p> : null}

        <Button onClick={deploy} disabled={blocked} className="mwz-button mwz-button-orange mt-5 h-12 w-full justify-center font-retro">
          {submitting ? "Confirming Deployment..." : mode === "scheduled" ? `Deploy ${selectedTier} Countdown Campaign` : `Deploy ${selectedTier} Campaign Now`}
        </Button>
      </div>
    </div>
  );
}

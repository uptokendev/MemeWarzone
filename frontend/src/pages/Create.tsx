/**
 * Create coin — 5-step card slide wizard.
 * Draft / deploy handlers preserve existing API + navigation contracts.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ImageIcon, FileText, Rocket, BookOpen, ChevronDown } from "lucide-react";
import { z } from "zod";
import { AnimatePresence, motion } from "framer-motion";
import { useTokenForm } from "@/hooks/useTokenForm";
import { tokenSchema, TOKEN_VALIDATION_LIMITS } from "@/constants/validation";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { LaunchpadSafetyStatus } from "@/components/launchpad/LaunchpadSafetyStatus";
import { emitCreatorArmBlocked, resolveCreatorArmBlock } from "@/components/prepare/CreatorArmEligibilityDialog";
import { getBnbContractAddresses, getBnbContractReadiness } from "@/lib/bnbContracts";
import { checkTickerAvailability, createCampaignDraft, type TickerAvailability } from "@/lib/draftApi";
import { signDraftAction } from "@/lib/draftAuth";
import { signSolanaDraftAction } from "@/lib/solanaWallet";
import {
  authorizeSolanaDirectCreate,
  beginSolanaDirectCreate,
  finalizeSolanaDirectCreate,
  preflightSolanaDirectCreate,
} from "@/lib/solanaDirectCreate";
import { submitSolanaV4CreateFromAuthorization } from "@/lib/solanaV4CreateSubmit";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { apiFetch } from "@/lib/apiBase";
import {
  BNB_CHAIN_ID,
  getActiveChainId,
  getChainLabel,
  getDefaultChainId,
  isEvmChainId,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { getBnbLaunchpadSafetyStatus } from "@/lib/launchpad/adapters/bnbLaunchpadAdapter";
import { useLaunchpad } from "@/lib/launchpadClient";
import {
  getDefaultGraduationTargetWei,
  getGraduationTiers,
  graduationTargetToUsdMicros,
  type GraduationTier,
} from "@/lib/graduationTiers";
import { isCreatorArmCooldownActive } from "@/lib/creatorArmCooldown";
import {
  readScheduledCreatorLaunchEligibility,
  type ScheduledCreatorLaunchEligibility,
} from "@/lib/scheduledLaunchClientV2";
import { getScheduledFactoryAddress } from "@/lib/scheduledFactoryConfig";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { normalizeSocialUrl } from "@/lib/socialLinks";
import { CreateDraftCardPreview, CreateLiveCardPreview } from "@/components/create/CreateCardPreviews";
import { CreateSplitPane, CreateWizardShell } from "@/components/create/CreateWizardShell";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** next = slide left (new from right); back = slide right (new from left) */
type SlideDir = "next" | "back";

const stepSlideVariants = {
  enter: (dir: SlideDir) => ({
    x: dir === "next" ? "55%" : "-55%",
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: SlideDir) => ({
    x: dir === "next" ? "-55%" : "55%",
    opacity: 0,
  }),
};

const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;
const TOTAL_STEPS = 5;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

type CreateMode = "draft" | "deploy" | null;

function readFlag(value: unknown, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return TRUE_VALUES.has(raw);
}

function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeTicker(value: string) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH);
}

function cacheDraftLogo(draftId: string, logoUrl: string) {
  if (typeof window === "undefined" || !draftId || !logoUrl) return;
  try {
    window.sessionStorage.setItem(`mwz:draft-logo:${draftId}`, logoUrl);
  } catch {
    // ignore
  }
}

const Create = () => {
  const {
    formData,
    setTokenName,
    setTicker,
    setDescription,
    setWebsite,
    setTwitter,
    setTelegram,
    setDiscord,
    setOtherLink,
    handleImageChange,
    handleRemoveImage,
  } = useTokenForm();

  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const launchpad = useLaunchpad();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState(1);
  const [slideDir, setSlideDir] = useState<SlideDir>("next");
  const [mode, setMode] = useState<CreateMode>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [checkingTicker, setCheckingTicker] = useState(false);
  const [tickerAvailability, setTickerAvailability] = useState<TickerAvailability | null>(null);
  const [tickerCheckError, setTickerCheckError] = useState<string | null>(null);
  // Seed from the explicitly configured production default.
  const [graduationTargetWei, setGraduationTargetWei] = useState<bigint>(() =>
    getDefaultGraduationTargetWei(getDefaultChainId()),
  );
  const [creatorEligibility, setCreatorEligibility] = useState<ScheduledCreatorLaunchEligibility | null>(null);
  const [creatorEligibilityError, setCreatorEligibilityError] = useState<string | null>(null);
  const armDialogShownForWallet = useRef<string | null>(null);
  /** Once the user picks a graduation tier, stop auto-resetting on chain switches. */
  const graduationTouchedRef = useRef(false);

  const normalizedTicker = useMemo(() => normalizeTicker(formData.ticker), [formData.ticker]);
  const isSolanaCreator = Boolean(solanaWallet.isSolanaConnected && solanaWallet.solanaAccount && (getActiveChainId(wallet.chainId) === SOLANA_CHAIN_ID || !wallet.isConnected));
  const creatorWallet = isSolanaCreator ? solanaWallet.solanaAccount : wallet.account || "";
  const chainId = isSolanaCreator ? SOLANA_CHAIN_ID : getActiveChainId(wallet.chainId);
  // BNB testnet (97) + Solana (101): include $6 test grad when flag allows (default on).
  const graduationOptions: GraduationTier[] = useMemo(() => getGraduationTiers(chainId), [chainId]);
  const configuredBnbChainId = useMemo(() => {
    const configured = getDefaultChainId();
    return isEvmChainId(configured) ? configured : BNB_CHAIN_ID;
  }, []);
  const bnbContractReadiness = useMemo(
    () => getBnbContractReadiness(configuredBnbChainId),
    [configuredBnbChainId],
  );
  const bnbAddresses = useMemo(
    () => getBnbContractAddresses(configuredBnbChainId),
    [configuredBnbChainId],
  );
  const launchpadSafetyStatus = useMemo(() => {
    if (isSolanaCreator) return launchpad.getSafetyStatus();
    return getBnbLaunchpadSafetyStatus({
      chainId: configuredBnbChainId,
      factoryAddress: bnbAddresses.launchFactory,
      hasSigner: Boolean(wallet.signer),
      hasAccount: Boolean(wallet.account),
      walletChainId: wallet.chainId,
      contractReadiness: bnbContractReadiness,
    });
  }, [
    bnbAddresses.launchFactory,
    bnbContractReadiness,
    configuredBnbChainId,
    isSolanaCreator,
    launchpad,
    wallet.account,
    wallet.chainId,
    wallet.signer,
  ]);
  const isSolanaProtocolPending = launchpadSafetyStatus.protocolStatus === "protocol_pending";
  // Direct deploy:
  //  - BNB: flag + contracts + correct wallet network
  //  - Solana: wallet connected → creates draft, auto-publishes promotion, opens Push Live
  //    (on-chain create still needs reservation + V4 authorize; Push Live finishes that)
  const bnbDirectDeployEnabled = readFlag(import.meta.env.VITE_ENABLE_DIRECT_BNB_DEPLOY, false);
  const bnbContractsConfigured =
    bnbContractReadiness.ready && Boolean(bnbAddresses.launchFactory);
  const walletOkForBnbDeploy =
    !wallet.account || Number(wallet.chainId) === Number(configuredBnbChainId);
  const solanaDirectDeployReady = Boolean(isSolanaCreator && solanaWallet.solanaAccount);
  const bnbDirectDeployReady =
    !isSolanaCreator && bnbDirectDeployEnabled && bnbContractsConfigured && walletOkForBnbDeploy;
  const directDeployRouteReady = solanaDirectDeployReady || bnbDirectDeployReady;
  const tickerConfirmedAvailable = Boolean(
    normalizedTicker && tickerAvailability?.ticker === normalizedTicker && tickerAvailability.available,
  );

  useEffect(() => {
    let cancelled = false;
    const ticker = normalizedTicker;
    setTickerAvailability(null);
    setTickerCheckError(null);
    if (!ticker) {
      setCheckingTicker(false);
      return;
    }
    setCheckingTicker(true);
    const timer = window.setTimeout(() => {
      checkTickerAvailability({ ticker, chainId })
        .then((result) => {
          if (cancelled) return;
          setTickerAvailability(result);
          setTickerCheckError(null);
        })
        .catch((err: any) => {
          if (cancelled) return;
          setTickerAvailability(null);
          setTickerCheckError(err?.message || "Could not verify ticker availability.");
        })
        .finally(() => {
          if (!cancelled) setCheckingTicker(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedTicker, chainId]);

  useEffect(() => {
    const selectedStillAvailable = graduationOptions.some((option) => option.targetWei === graduationTargetWei);
    if (!selectedStillAvailable) {
      setGraduationTargetWei(getDefaultGraduationTargetWei(chainId));
      return;
    }
    // First time we land on a test chain (97/101), prefer $6 unless the user already picked a tier.
    if (!graduationTouchedRef.current) {
      const preferred = getDefaultGraduationTargetWei(chainId);
      if (preferred !== graduationTargetWei && graduationOptions.some((o) => o.targetWei === preferred)) {
        setGraduationTargetWei(preferred);
      }
    }
  }, [graduationOptions, graduationTargetWei, chainId]);

  useEffect(() => {
    if (isSolanaCreator || !wallet.account || !wallet.signer || !isEvmChainId(chainId)) {
      setCreatorEligibility(null);
      setCreatorEligibilityError(null);
      return;
    }
    const factoryAddress =
      getScheduledFactoryAddress(Number(chainId), launchpad.factoryAddress) || launchpad.factoryAddress || "";
    if (!factoryAddress) {
      setCreatorEligibility(null);
      setCreatorEligibilityError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      readScheduledCreatorLaunchEligibility({
        signer: wallet.signer!,
        chainId: Number(chainId),
        factoryAddress,
      })
        .then((result) => {
          if (cancelled) return;
          setCreatorEligibility(result);
          setCreatorEligibilityError(null);
          const liveCap =
            Number(result.maxLiveBonding || 0) > 0 &&
            Number(result.currentLiveCount || 0) >= Number(result.maxLiveBonding || 0);
          const cooldownActive = isCreatorArmCooldownActive(result);
          if (result.allowed) {
            armDialogShownForWallet.current = null;
          } else if (cooldownActive || liveCap) {
            const walletKey = `${wallet.account}:${chainId}:${result.lastRecordedLaunchAt}:${result.cooldownEndsAt}:${result.currentLiveCount}`;
            if (armDialogShownForWallet.current !== walletKey) {
              armDialogShownForWallet.current = walletKey;
              emitCreatorArmBlocked(
                resolveCreatorArmBlock({
                  mode: "now",
                  eligibility: result,
                  errorMessage: cooldownActive
                    ? `Creator arm cooldown active until ${new Date(result.cooldownEndsAt * 1000).toISOString()}. Immediate and timed arms both require 24h between on-chain deploys.`
                    : `Live campaign limit reached (${result.currentLiveCount}/${result.maxLiveBonding}).`,
                }),
              );
            }
          } else {
            armDialogShownForWallet.current = null;
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setCreatorEligibility(null);
          setCreatorEligibilityError(String(error?.message || error || "Could not check creator deployment eligibility."));
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isSolanaCreator, wallet.account, wallet.signer, chainId, launchpad.factoryAddress]);

  const ensureTickerAvailable = () => {
    if (!normalizedTicker) {
      toast.error("Ticker is required.");
      return false;
    }
    if (checkingTicker) {
      toast.error("Wait for ticker availability check to finish.");
      return false;
    }
    if (tickerCheckError) {
      toast.error("Ticker availability could not be verified. Try again before signing.");
      return false;
    }
    if (!tickerConfirmedAvailable) {
      toast.error(tickerAvailability?.reason || "Ticker is not available.");
      return false;
    }
    return true;
  };

  const validateCoreForm = () => {
    if (formData.category === "project") {
      toast.error("Project tokens coming soon!");
      return false;
    }
    try {
      tokenSchema.parse({
        name: formData.name,
        ticker: formData.ticker,
        description: formData.description || undefined,
        website: normalizeSocialUrl(formData.website, "website") || undefined,
        twitter: normalizeSocialUrl(formData.twitter, "x") || undefined,
        otherLink: normalizeSocialUrl(formData.otherLink, "other") || undefined,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0]?.message ?? "Validation error");
        return false;
      }
      toast.error("Validation failed");
      return false;
    }
    if (!ensureTickerAvailable()) return false;
    if (!formData.imagePreview || !formData.image) {
      toast.error("Please upload a token image");
      return false;
    }
    if (formData.image.size > MAX_LOGO_UPLOAD_BYTES) {
      toast.error(`Token image is too large (${formatFileSize(formData.image.size)}). Please upload an image under 5 MB.`);
      return false;
    }
    if (!creatorWallet) {
      toast.error("Please connect your BNB or Solana wallet first");
      return false;
    }
    if (!isSolanaCreator && !wallet.signer) {
      toast.error("Wallet signer unavailable. Reconnect your BNB wallet and try again.");
      return false;
    }
    return true;
  };

  const uploadLogo = async (options?: { directSessionToken?: string }) => {
    if (!formData.image || !creatorWallet) throw new Error("Missing logo or wallet");
    const chainIdForUpload = String(chainId);
    const address = isSolanaCreator ? creatorWallet : creatorWallet.toLowerCase();
    const qs = new URLSearchParams({ kind: "logo", chainId: chainIdForUpload, address });
    if (options?.directSessionToken && isSolanaCreator) {
      qs.set("directSession", options.directSessionToken);
    } else {
      try {
        if (!isSolanaCreator && wallet.signer) {
          const { signWalletAction, appendAuthToSearchParams } = await import("@/lib/walletActionAuth");
          const auth = await signWalletAction({
            action: "upload_logo",
            walletAddress: address,
            chainId: Number(chainId),
            signer: wallet.signer,
          });
          appendAuthToSearchParams(qs, auth);
        } else if (isSolanaCreator) {
          const { signWalletAction, appendAuthToSearchParams } = await import("@/lib/walletActionAuth");
          const { signSolanaMessage } = await import("@/lib/solanaWallet");
          const auth = await signWalletAction({
            action: "upload_logo",
            walletAddress: address,
            chainId: Number(chainId),
            walletType: "solana",
            signMessage: async (message) => (await signSolanaMessage(message, address)).signature,
          });
          appendAuthToSearchParams(qs, auth);
        }
      } catch (signErr) {
        console.warn("[Create] upload auth sign skipped", signErr);
      }
    }
    const fd = new FormData();
    fd.append("file", formData.image);
    const res = await apiFetch(`/api/upload?${qs.toString()}`, { method: "POST", body: fd });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `Logo upload failed (${res.status})`);
    }
    const json = (await res.json()) as { url?: string };
    if (!json?.url) throw new Error("Logo upload failed (missing url)");
    const { assertOnchainLogoUri } = await import("@/lib/onchainLogoUri");
    return assertOnchainLogoUri(json.url);
  };

  const createDraftAuth = async (draftId?: string) => {
    if (isSolanaCreator) {
      return signSolanaDraftAction({
        walletAddress: creatorWallet,
        chainId,
        action: draftId ? "save_promotion" : "create_draft",
        draftId,
      });
    }
    return signDraftAction({
      signer: wallet.signer,
      walletAddress: creatorWallet,
      chainId,
      action: draftId ? "save_promotion" : "create_draft",
      draftId,
    });
  };

  const handleCreateDraft = async () => {
    if (!validateCoreForm()) return;
    setIsDrafting(true);
    try {
      // Logo upload may sign a separate auth nonce. auth_nonces is unique per
      // (chain_id, address), so uploading AFTER create_draft auth would replace
      // the create_draft nonce and cause "nonce invalid / already used".
      const logoUrl = await uploadLogo();
      const auth = await createDraftAuth();
      const draft = await createCampaignDraft({
        auth,
        chainId,
        creatorWallet,
        name: formData.name,
        ticker: normalizedTicker,
        description: formData.description || null,
        category: formData.category || "meme",
        logoUrl,
        websiteUrl: normalizeSocialUrl(formData.website, "website") || null,
        xUrl: normalizeSocialUrl(formData.twitter, "x") || null,
        telegramUrl: normalizeSocialUrl(formData.telegram, "telegram") || null,
        discordUrl: normalizeSocialUrl(formData.discord, "discord") || null,
        docs: formData.otherLink ? [normalizeSocialUrl(formData.otherLink, "other")] : [],
        otherUrl: normalizeSocialUrl(formData.otherLink, "other") || null,
        graduationTargetWei: graduationTargetWei.toString(),
        visibility: "private",
        // Keep Solana reservations on the same cluster as create-auth (Railway SOLANA_CLUSTER).
        ...(isSolanaCreator
          ? { cluster: String(import.meta.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta") }
          : {}),
      });
      cacheDraftLogo(draft.id, logoUrl);
      toast.success(isSolanaCreator ? "Solana draft signed and saved. No gas spent." : "Draft saved. No gas spent.");
      navigate(`/drafts/${draft.id}/promotion`);
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || "Failed to create draft");
    } finally {
      setIsDrafting(false);
    }
  };

  const handleDeployNow = async () => {
    if (!validateCoreForm()) return;

    // ── Solana Direct deploy ───────────────────────────────────────────────
    // Product invariant: Direct is not Draft. This path never creates or mutates a
    // campaign_drafts row. It uses a nullable-draft ticker reservation + short-lived
    // signed Direct session, then finalizes straight into the campaigns registry.
    if (isSolanaCreator) {
      if (!solanaWallet.solanaAccount) {
        toast.error("Connect your Solana wallet first.");
        return;
      }
      setIsDeploying(true);
      try {
        const graduationTargetUsdMicros = graduationTargetToUsdMicros(graduationTargetWei);

        // Read-only preflight happens before any upload or wallet signature, so a
        // creator cooldown/live-cap block is surfaced immediately.
        toast.message("Checking Solana launch eligibility…");
        const directPreflight = await preflightSolanaDirectCreate({
          creatorWallet,
          chainId: SOLANA_CHAIN_ID,
          graduationTargetUsdMicros,
        });
        const directEligibility = directPreflight.preflight;
        if (!directEligibility.allowed) {
          const cooldownActive =
            Boolean(directEligibility.cooldownActive) ||
            Number(directEligibility.nextAllowedAt || 0) > Number(directEligibility.chainNow || 0);
          const errorMessage = cooldownActive
            ? `Creator arm cooldown active until ${new Date(Number(directEligibility.nextAllowedAt || 0) * 1000).toISOString()}. Immediate and timed arms both require 24h between on-chain deploys.`
            : `Live campaign limit reached (${directEligibility.creatorLiveBondingCount}/${directEligibility.creatorMaxLiveBondingCount}).`;
          emitCreatorArmBlocked(
            resolveCreatorArmBlock({
              mode: "now",
              eligibility: {
                allowed: false,
                cooldownEndsAt: directEligibility.nextAllowedAt || 0,
                currentLiveCount: directEligibility.creatorLiveBondingCount,
                maxLiveBonding: directEligibility.creatorMaxLiveBondingCount,
              },
              errorMessage,
              errorCode: cooldownActive ? "SOLANA_CREATOR_COOLDOWN" : "SOLANA_CREATOR_LAUNCH_LIMIT",
            }),
          );
          return;
        }

        // One off-chain signature creates a short-lived Direct session. The same
        // session authorizes the logo upload and create authorization — no draft
        // owner/promotion/deploy signatures are involved.
        const { signWalletAction } = await import("@/lib/walletActionAuth");
        const { signSolanaMessage } = await import("@/lib/solanaWallet");
        toast.message("Sign Direct deploy in your Solana wallet…");
        const directAuth = await signWalletAction({
          action: "solana_direct_create",
          walletAddress: creatorWallet,
          chainId: SOLANA_CHAIN_ID,
          extraLines: [`Ticker: ${normalizedTicker}`],
          walletType: "solana",
          signMessage: async (message) => (await signSolanaMessage(message, creatorWallet)).signature,
        });
        const begun = await beginSolanaDirectCreate({
          creatorWallet,
          chainId: SOLANA_CHAIN_ID,
          ticker: normalizedTicker,
          auth: directAuth,
        });

        if (begun.alreadyOnChain && begun.tokenPath) {
          toast.success("Existing Direct campaign recovered.");
          navigate(begun.tokenPath);
          return;
        }
        if (!begun.sessionToken) {
          throw new Error("Railway did not return a Direct deployment session.");
        }

        const logoUrl = await uploadLogo({ directSessionToken: begun.sessionToken });
        if (!logoUrl || logoUrl.startsWith("data:")) {
          if (!logoUrl) throw new Error("Logo upload returned no URL. Check Railway Supabase upload env.");
        }

        toast.message("Authorizing Solana Direct create…");
        const authorization = await authorizeSolanaDirectCreate({
          sessionToken: begun.sessionToken,
          name: formData.name,
          ticker: normalizedTicker,
          description: formData.description || null,
          category: formData.category || "meme",
          logoUrl,
          websiteUrl: formData.website || null,
          xUrl: formData.twitter || null,
          telegramUrl: formData.telegram || null,
          discordUrl: formData.discord || null,
          otherUrl: formData.otherLink || null,
          graduationTargetUsdMicros,
        });

        if (authorization.alreadyOnChain && authorization.tokenPath) {
          toast.success("Existing Direct campaign recovered.");
          navigate(authorization.tokenPath);
          return;
        }
        if (!("finalizeToken" in authorization) || !authorization.finalizeToken) {
          throw new Error("Railway did not return a Direct finalization token.");
        }

        toast.message("Running Solana security simulation…");
        const created = await submitSolanaV4CreateFromAuthorization(authorization, {
          creatorAddress: creatorWallet,
          onPreflightReady: (preview) => {
            toast.success(
              `Solana deployment ready · Security checks passed ✓ · Transaction simulation passed ✓ · Estimated deployment cost: ≈ ${(preview.estimatedDeploymentLamports / 1_000_000_000).toFixed(4)} SOL`,
              { duration: 8_000 },
            );
          },
        });

        toast.message("Finalizing Direct campaign registry…");
        const finalized = await finalizeSolanaDirectCreate({
          finalizeToken: authorization.finalizeToken,
          deployTxHash: created.signature,
        });

        toast.success("Solana token deployed.");
        navigate(
          finalized.tokenPath ||
            tokenDetailsPath(
              {
                tokenAddress: finalized.mintAddress || created.mintAddress,
                campaignAddress: finalized.campaignAddress || created.campaignAddress,
                chainId: SOLANA_CHAIN_ID,
              },
              { chainId: SOLANA_CHAIN_ID },
            ),
        );
      } catch (error: any) {
        console.error(error);
        const errorCode = String(error?.code || "");
        const errorMessage = String(error?.message || "Solana direct deploy failed");
        if (/SOLANA_CREATOR_(?:COOLDOWN|LAUNCH_LIMIT)/i.test(errorCode + " " + errorMessage)) {
          emitCreatorArmBlocked(
            resolveCreatorArmBlock({
              mode: "now",
              errorMessage,
              errorCode,
            }),
          );
        } else {
          toast.error(errorMessage);
        }
      } finally {
        setIsDeploying(false);
      }
      return;
    }

    if (!bnbDirectDeployEnabled) {
      toast.error("Direct BNB deploy is disabled for this environment. Save a draft instead.");
      return;
    }
    if (!directDeployRouteReady) {
      toast.error("Direct BNB deploy needs the final launchpad and Topaz contract env values first.");
      return;
    }
    if (!wallet.account || !wallet.signer) {
      toast.error("Connect your BNB wallet first.");
      return;
    }
    setIsDeploying(true);

    let latestEligibility = creatorEligibility;
    try {
      const factoryAddress =
        getScheduledFactoryAddress(Number(chainId), launchpad.factoryAddress) || launchpad.factoryAddress || "";
      if (factoryAddress) {
        const eligibility = await readScheduledCreatorLaunchEligibility({
          signer: wallet.signer,
          chainId: Number(chainId),
          factoryAddress,
        });
        latestEligibility = eligibility;
        setCreatorEligibility(eligibility);
        if (!eligibility.allowed) {
          const now = Math.floor(Date.now() / 1000);
          const message =
            eligibility.currentLiveCount >= eligibility.maxLiveBonding
              ? `Live campaign limit reached (${eligibility.currentLiveCount}/${eligibility.maxLiveBonding}). Graduate an existing live campaign before another deploy.`
              : isCreatorArmCooldownActive({ ...eligibility, nowSeconds: now })
                ? `Creator arm cooldown active until ${new Date(eligibility.cooldownEndsAt * 1000).toISOString()}. Immediate and timed arms both require 24h between on-chain deploys.`
                : "This creator wallet cannot deploy or arm another campaign right now.";
          emitCreatorArmBlocked(resolveCreatorArmBlock({ mode: "now", eligibility, errorMessage: message }));
          return;
        }
      }

      const logoUrl = await uploadLogo();
      const receipt: any = await launchpad.createCampaign({
        name: formData.name,
        symbol: normalizedTicker,
        logoURI: logoUrl,
        xAccount: normalizeSocialUrl(formData.twitter, "x"),
        website: normalizeSocialUrl(formData.website, "website"),
        extraLink: normalizeSocialUrl(formData.otherLink, "other"),
        graduationTargetWei,
      });

      const campaignAddress = String(receipt?.campaignAddress || "").trim();
      const tokenAddress = String(receipt?.tokenAddress || "").trim();
      toast.success("Campaign deployed on BNB.");
      if (tokenAddress || campaignAddress) {
        navigate(`/token/${tokenAddress || campaignAddress}?chainId=${chainId}`);
      }
    } catch (error: any) {
      console.error(error);
      const message = String(error?.shortMessage || error?.reason || error?.message || "Failed to deploy campaign");
      const code = String(error?.code || error?.data?.code || "");
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
        (latestEligibility != null && latestEligibility.allowed === false) ||
        (latestEligibility != null && isCreatorArmCooldownActive(latestEligibility));

      if (looksLikeArmBlock) {
        emitCreatorArmBlocked(
          resolveCreatorArmBlock({
            mode: "now",
            eligibility: latestEligibility,
            errorMessage: message,
            errorCode: code,
          }),
        );
      } else {
        toast.error(message);
      }
    } finally {
      setIsDeploying(false);
    }
  };

  // --- Step gates (strict — no forward without required fields) ---
  const hasImage = Boolean(formData.imagePreview?.trim() && formData.image);
  const identityReady = Boolean(
    formData.name.trim().length > 0 &&
      normalizedTicker.length > 0 &&
      hasImage &&
      tickerConfirmedAvailable &&
      !checkingTicker &&
      !tickerCheckError,
  );
  const storyReady = Boolean(formData.description.trim().length > 0);
  const canGoNext = (fromStep: number) => {
    if (fromStep === 1) return mode === "draft" || mode === "deploy";
    if (fromStep === 2) return identityReady;
    if (fromStep === 3) return storyReady;
    if (fromStep === 4) return true;
    return false;
  };

  const goNext = () => {
    if (step >= TOTAL_STEPS) return;
    if (!canGoNext(step)) {
      if (step === 1) toast.error("Choose Draft mode or Direct deploy first.");
      else if (step === 2) {
        if (!hasImage) toast.error("Upload a token image first.");
        else if (!formData.name.trim()) toast.error("Enter a coin name.");
        else if (!normalizedTicker) toast.error("Enter a ticker.");
        else if (checkingTicker) toast.error("Wait for ticker availability check to finish.");
        else toast.error(tickerAvailability?.reason || "Ticker must be available before continuing.");
      } else if (step === 3) toast.error("Add a short description before continuing.");
      return;
    }
    setSlideDir("next");
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const goBack = () => {
    if (step <= 1 || isDrafting || isDeploying) return;
    setSlideDir("back");
    setStep((s) => Math.max(1, s - 1));
  };

  const selectedGraduation = graduationOptions.find((o) => o.targetWei === graduationTargetWei);
  const preview =
    mode === "deploy" ? (
      <CreateLiveCardPreview
        name={formData.name}
        symbol={normalizedTicker || formData.ticker}
        logoUrl={formData.imagePreview}
        creator={creatorWallet}
        description={formData.description}
      />
    ) : (
      <CreateDraftCardPreview
        name={formData.name}
        ticker={normalizedTicker || formData.ticker}
        logoUrl={formData.imagePreview}
        mission={formData.description}
        creatorWallet={creatorWallet}
      />
    );

  const modeSelectedClass =
    "border-orange-400/70 bg-orange-500/10 shadow-lg shadow-orange-500/10";
  const modeIdleClass = "border-border bg-background/40 hover:border-orange-400/40";

  const tickerStatusLine = !normalizedTicker
    ? "Enter a ticker to check availability."
    : checkingTicker
      ? "Checking ticker…"
      : tickerCheckError
        ? tickerCheckError
        : tickerConfirmedAvailable
          ? "Ticker is available."
          : tickerAvailability?.reason || "Ticker is not available.";

  return (
    <ContentContainer className="flex flex-col px-1 pb-3 pt-2 sm:px-2 md:px-3">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <div className="text-xs text-muted-foreground">
          Wallet{" "}
          <span className="text-foreground">
            {creatorWallet ? `${creatorWallet.slice(0, 4)}…${creatorWallet.slice(-4)}` : "not connected"}
          </span>
          {" · "}
          {isSolanaCreator ? "Solana" : getChainLabel(chainId)}
        </div>
        <Button asChild size="sm" variant="outline" className="font-retro text-xs">
          <Link to="/playbook">
            <BookOpen className="mr-1.5 h-3.5 w-3.5" />
            Playbook
          </Link>
        </Button>
      </div>

      <CreateWizardShell
        step={step}
        totalSteps={TOTAL_STEPS}
        canBack={step > 1 && !isDrafting && !isDeploying}
        canNext={step < TOTAL_STEPS && canGoNext(step) && !isDrafting && !isDeploying}
        onBack={goBack}
        onNext={goNext}
      >
        <AnimatePresence mode="wait" custom={slideDir} initial={false}>
          <motion.div
            key={step}
            custom={slideDir}
            variants={stepSlideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
          >
            {/* STEP 1 — mode */}
            {step === 1 ? (
              <CreateSplitPane
                left={
                  <div className="max-w-md space-y-3 text-sm leading-relaxed text-muted-foreground">
                    <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-300">// Choose your path</p>
                    <h2 className="font-retro text-xl text-foreground sm:text-2xl">Draft first — or go live now</h2>
                    <p>
                      <span className="font-semibold text-orange-200">Draft mode</span> saves your coin with a wallet signature only
                      (no gas). You get a promotion page, can build heat, then push live when ready.
                    </p>
                    <p>
                      <span className="font-semibold text-orange-200">Direct deploy</span> uploads the creative, asks your BNB wallet
                      to sign the LaunchFactory transaction, pays gas, and lands you on Token Details when the contract is live.
                    </p>
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => setMode("draft")}
                      className={cn("rounded-xl border p-4 text-left transition", mode === "draft" ? modeSelectedClass : modeIdleClass)}
                    >
                      <div className="flex items-center gap-2 font-retro text-lg text-foreground">
                        <FileText className="h-5 w-5 text-orange-300" />
                        Draft mode
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        Free to save. Sign once, open the promotion setup page, launch later.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMode("deploy")}
                      className={cn("rounded-xl border p-4 text-left transition", mode === "deploy" ? modeSelectedClass : modeIdleClass)}
                    >
                      <div className="flex items-center gap-2 font-retro text-lg text-foreground">
                        <Rocket className="h-5 w-5 text-orange-300" />
                        Direct deploy
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {directDeployRouteReady
                          ? isSolanaCreator
                            ? "One flow: logo + wallet createCampaign → opens Token Details (no promotion page)."
                            : "Wallet + gas. Live bonding campaign as soon as the tx confirms."
                          : isSolanaCreator
                            ? "Connect a Solana wallet to enable Direct deploy."
                            : !bnbDirectDeployEnabled
                              ? "Locked in this environment — pick Draft, or enable VITE_ENABLE_DIRECT_BNB_DEPLOY."
                              : !bnbContractsConfigured
                                ? "BNB contracts still incomplete in env — pick Draft or finish factory/Topaz wiring."
                                : !walletOkForBnbDeploy
                                  ? `Switch wallet to chain ${configuredBnbChainId} (${getChainLabel(configuredBnbChainId)}) for Direct deploy.`
                                  : "Direct deploy is not ready — pick Draft for now."}
                      </p>
                    </button>

                    <Button
                      type="button"
                      className="mwz-button mwz-button-orange mt-auto h-11 font-retro"
                      disabled={!mode}
                      onClick={goNext}
                    >
                      Next
                    </Button>
                  </div>
                }
              />
            ) : null}

            {/* STEP 2 — identity */}
            {step === 2 ? (
              <CreateSplitPane
                left={
                  <div className="flex w-full flex-col items-center gap-2">
                    <p className="font-retro text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {mode === "deploy" ? "Live card preview" : "Draft card preview"}
                    </p>
                    {preview}
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div>
                      <label className="font-retro text-sm text-foreground">Token image</label>
                      <p className="mt-0.5 text-xs text-muted-foreground">PNG / JPG / WebP · max 5 MB</p>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp"
                      className="hidden"
                      onChange={handleImageChange}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" className="font-retro" onClick={() => fileRef.current?.click()}>
                        <ImageIcon className="mr-2 h-4 w-4" />
                        {formData.imagePreview ? "Replace image" : "Upload image"}
                      </Button>
                      {formData.imagePreview ? (
                        <Button type="button" variant="ghost" size="sm" onClick={handleRemoveImage}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    <div>
                      <label className="mb-1 block font-retro text-sm">Name</label>
                      {/* Normal casing font so mixed-case names like WhatIsThisForACoin display correctly */}
                      <Input
                        value={formData.name}
                        onChange={(e) => setTokenName(e.target.value)}
                        placeholder="WhatIsThisForACoin"
                        maxLength={TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH}
                        className="font-sans normal-case tracking-normal"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-retro text-sm">Ticker</label>
                      <Input
                        value={formData.ticker}
                        onChange={(e) => setTicker(e.target.value)}
                        placeholder="TICKER"
                        maxLength={TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH}
                        className="font-retro uppercase"
                      />
                      <p
                        className={cn(
                          "mt-1 text-xs",
                          tickerConfirmedAvailable
                            ? "text-green-300"
                            : tickerCheckError || tickerAvailability
                              ? "text-orange-300"
                              : "text-muted-foreground",
                        )}
                      >
                        {tickerStatusLine}
                      </p>
                    </div>
                    <Button
                      type="button"
                      className="mwz-button mwz-button-orange mt-auto h-11 font-retro"
                      disabled={!canGoNext(2)}
                      onClick={goNext}
                    >
                      Next
                    </Button>
                  </div>
                }
              />
            ) : null}

            {/* STEP 3 — story + socials */}
            {step === 3 ? (
              <CreateSplitPane
                left={
                  <div className="flex w-full flex-col items-center gap-2">
                    <p className="font-retro text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Preview updates live</p>
                    {preview}
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div>
                      <label className="mb-1 block font-retro text-sm">
                        Short description <span className="text-orange-300">*</span>
                      </label>
                      <Textarea
                        value={formData.description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What should visitors know?"
                        className="min-h-20 font-sans text-sm normal-case tracking-normal"
                        maxLength={TOKEN_VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH}
                      />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input value={formData.website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website" className="font-sans text-sm normal-case" />
                      <Input value={formData.twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="X / @handle / url" className="font-sans text-sm normal-case" />
                      <Input value={formData.telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="Telegram" className="font-sans text-sm normal-case" />
                      <Input value={formData.discord} onChange={(e) => setDiscord(e.target.value)} placeholder="Discord" className="font-sans text-sm normal-case" />
                      <Input value={formData.otherLink} onChange={(e) => setOtherLink(e.target.value)} placeholder="Other link" className="font-sans text-sm normal-case sm:col-span-2" />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Socials optional. Use @memewarzone, https://x.com/memewarzone, or bare memewarzone.
                    </p>
                    <Button
                      type="button"
                      className="mwz-button mwz-button-orange mt-auto h-11 font-retro"
                      disabled={!canGoNext(3)}
                      onClick={goNext}
                    >
                      Next
                    </Button>
                  </div>
                }
              />
            ) : null}

            {/* STEP 4 — graduation + safety */}
            {step === 4 ? (
              <CreateSplitPane
                left={
                  <div className="flex w-full flex-col items-center gap-2">
                    {preview}
                    {selectedGraduation ? (
                      <p className="text-center text-xs text-muted-foreground">
                        Graduation: <span className="text-accent">{selectedGraduation.label}</span> · {selectedGraduation.title}
                      </p>
                    ) : null}
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div>
                      <div className="font-retro text-sm text-foreground">Graduation threshold</div>
                      <p className="mt-0.5 text-xs text-muted-foreground">Bonding volume before DEX graduation.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {graduationOptions.map((option) => {
                        const selected = graduationTargetWei === option.targetWei;
                        const isTest = option.id === "test";
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                              graduationTouchedRef.current = true;
                              setGraduationTargetWei(option.targetWei);
                            }}
                            className={cn(
                              "rounded-lg border px-2.5 py-2 text-left transition",
                              isTest && "col-span-2 border-dashed",
                              selected
                                ? isTest
                                  ? "border-orange-300 bg-orange-400/15 text-orange-100"
                                  : "border-accent bg-accent/15 text-foreground"
                                : "border-border bg-muted/30 text-muted-foreground hover:border-accent/60",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-retro text-sm">{option.label}</span>
                              <span className="font-retro text-[10px] uppercase tracking-[0.12em]">{option.title}</span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[0.65rem] leading-4 opacity-90">{option.description}</p>
                          </button>
                        );
                      })}
                    </div>

                    <Collapsible open={safetyOpen} onOpenChange={setSafetyOpen} className="rounded-xl border border-border/50 bg-background/25">
                      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 p-3 text-left">
                        <div>
                          <div className="font-retro text-sm text-foreground">Launch Safety</div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {launchpadSafetyStatus.protocolLabel
                              ?? (launchpadSafetyStatus.protocolStatus === "ready" ? "Live" : launchpadSafetyStatus.protocolStatus)}
                            {" · "}
                            {launchpadSafetyStatus.chainLabel}
                          </p>
                        </div>
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-3 pb-3">
                        <LaunchpadSafetyStatus status={launchpadSafetyStatus} compact embedded />
                      </CollapsibleContent>
                    </Collapsible>

                    <Button type="button" className="mwz-button mwz-button-orange mt-auto h-11 font-retro" onClick={goNext}>
                      Next
                    </Button>
                  </div>
                }
              />
            ) : null}

            {/* STEP 5 — confirm: preview left, summary + CTA right */}
            {step === 5 ? (
              <CreateSplitPane
                left={
                  <div className="flex w-full flex-col items-center gap-2">
                    <p className="font-retro text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Final preview</p>
                    {preview}
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div className="space-y-2 rounded-xl border border-border/50 bg-background/30 p-3 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Mode</span>
                        <span className="font-retro text-foreground">{mode === "deploy" ? "Direct deploy" : "Draft"}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Name</span>
                        <span className="truncate font-medium text-foreground">{formData.name || "—"}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Ticker</span>
                        <span className="font-medium text-foreground">{normalizedTicker ? `$${normalizedTicker}` : "—"}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Graduation</span>
                        <span className="text-foreground">{selectedGraduation?.label || "—"}</span>
                      </div>
                      {!creatorWallet ? (
                        <p className="pt-1 text-xs text-orange-300">Connect your wallet before launching.</p>
                      ) : null}
                      {mode === "deploy" && !directDeployRouteReady ? (
                        <p className="pt-1 text-xs text-orange-300">
                          {isSolanaCreator
                            ? "Connect Solana wallet to Direct deploy (draft → Push Live)."
                            : !bnbDirectDeployEnabled
                              ? "Direct BNB deploy is disabled in this build — choose Draft."
                              : !bnbContractsConfigured
                                ? "BNB launch contracts are incomplete — choose Draft or fix env wiring."
                                : !walletOkForBnbDeploy
                                  ? `Switch wallet to ${getChainLabel(configuredBnbChainId)} (chain ${configuredBnbChainId}).`
                                  : "Direct deploy is not ready — go back and choose Draft."}
                        </p>
                      ) : null}
                      {creatorEligibilityError ? (
                        <p className="pt-1 text-xs text-orange-300">{creatorEligibilityError}</p>
                      ) : null}
                    </div>

                    {mode === "deploy" ? (
                      <Button
                        type="button"
                        className="mwz-button mwz-button-orange mt-auto h-12 w-full font-retro text-base"
                        disabled={isDeploying || isDrafting || !directDeployRouteReady}
                        onClick={() => void handleDeployNow()}
                      >
                        <Rocket className="mr-2 h-5 w-5" />
                        {isDeploying ? "Deploying… waiting for confirmation" : "Deploy now"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        className="mwz-button mt-auto h-12 w-full font-retro text-base"
                        disabled={isDrafting || isDeploying}
                        onClick={() => void handleCreateDraft()}
                      >
                        <FileText className="mr-2 h-5 w-5" />
                        {isDrafting ? "Signing & saving draft…" : "Save Draft"}
                      </Button>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {mode === "deploy"
                        ? "Wallet signs + gas. Stay here until deploy confirms — then Token Details."
                        : "One signature to save. No gas. Next: promotion setup / edit page."}
                    </p>
                  </div>
                }
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </CreateWizardShell>
    </ContentContainer>
  );
};

export default Create;

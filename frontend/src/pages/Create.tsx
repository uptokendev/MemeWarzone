/**
 * Create coin — 6-step card slide wizard.
 * Draft / deploy handlers preserve existing API + navigation contracts.
 * Graduation Market selection is presentation-only; server validation remains authority.
 */
import { Button } from "@/components/ui/button";
import { DBC_FIRST_BUY_MAX_BPS } from "../../shared/dbcEconomics.mjs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ImageIcon, FileText, Rocket, BookOpen, ChevronDown } from "lucide-react";
import { z } from "zod";
import { AnimatePresence, motion } from "framer-motion";
import { useTokenForm } from "@/hooks/useTokenForm";
import { tokenSchema, tokenNameByteLength, TOKEN_VALIDATION_LIMITS } from "@/constants/validation";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { LaunchpadSafetyStatus } from "@/components/launchpad/LaunchpadSafetyStatus";
import { emitCreatorArmBlocked, resolveCreatorArmBlock } from "@/components/prepare/CreatorArmEligibilityDialog";
import { GraduationMarketStep } from "@/components/create/GraduationMarketStep";
import { LaunchCanaryBanner } from "@/components/create/LaunchCanaryBanner";
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
import { isDbcLaunchEnabled } from "@/lib/dbcLaunchEnabled";
import { enabledQuotes, quoteUiToRaw, WSOL_MINT } from "../../shared/dbcQuotes.mjs";
import { readQuoteUiMultiplier } from "@/lib/dbcQuoteMultiplier.mjs";
import { DbcStockRiskDialog } from "@/components/create/DbcStockRiskDialog";
import { getDbcGraduationTiers } from "@/lib/dbcGraduationTiers";
import {
  authorizeDbcCreate,
  beginDbcCreate,
  finalizeDbcCreate,
  preflightDbcCreate,
  quoteDbcFirstBuy,
  type DbcFeeChoice,
} from "@/lib/dbcCreate";
import { submitDbcCreateTransaction } from "@/lib/dbcCreateSubmit";
import { CreatorFeeChoicePicker, type CreatorFeeChoice } from "@/components/create/CreatorFeeChoicePicker";
import {
  EvmGen6LaunchOptions,
  freshEvmFirstBuyPlan,
  parseNativeInput,
  type EvmFirstBuyPlan,
} from "@/components/create/EvmGen6LaunchOptions";
import { gen6CreateFields, LAUNCH_FEE_NOTE } from "@/lib/evmGen6.mjs";
import { isGen6Factory } from "@/lib/evmGen6Client";
import { getReadProvider } from "@/lib/readProvider";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { apiFetch } from "@/lib/apiBase";
import {
  createRobinhoodStockCampaign,
} from "@/lib/robinhoodStockCreate";
import {
  buildCreateDraftGraduationFields,
  directDeployBindPath,
  selectedMarketSummary,
} from "@/lib/graduationMarketPresentation.mjs";
import {
  assertFreshGraduationQuote,
  resolveRobinhoodStockTokenForQuote,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";
import {
  BNB_CHAIN_ID,
  getActiveChainId,
  getChainLabel,
  getNativeSymbol,
  isEvmChainId,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
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
import { CreateFullPane, CreateSplitPane, CreateWizardShell } from "@/components/create/CreateWizardShell";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChainFeedSwitch, useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { cn } from "@/lib/utils";
import { analytics, analyticsErrorCode } from "@/lib/analytics/ProductAnalytics";

type SlideDir = "next" | "back";

const stepSlideVariants = {
  enter: (dir: SlideDir) => ({ x: dir === "next" ? "55%" : "-55%", opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: SlideDir) => ({ x: dir === "next" ? "-55%" : "55%", opacity: 0 }),
};

const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;
const TOTAL_STEPS = 6;
const DBC_FEE_CHOICE_LABEL: Record<string, string> = {
  keep: "Keep it",
  holders: "Give it to holders",
  split: "Split",
  buyback: "Buyback and burn",
};
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

function isRobinhoodChain(chainId: number) {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
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
  const [graduationTargetWei, setGraduationTargetWei] = useState<bigint>(() =>
    getDefaultGraduationTargetWei(getActiveChainId()),
  );
  const [graduationQuoteAsset, setGraduationQuoteAsset] = useState<GraduationQuoteAsset | null>(null);
  const dbcEnabled = isDbcLaunchEnabled();
  const [dbcFeeChoice, setDbcFeeChoice] = useState<DbcFeeChoice>("keep");
  const [dbcCreatorSharePct, setDbcCreatorSharePct] = useState("50");
  const [dbcFirstBuySol, setDbcFirstBuySol] = useState("");
  const [dbcQuoteMint, setDbcQuoteMint] = useState(WSOL_MINT);
  const dbcQuoteOptions = useMemo(
    () => enabledQuotes(String(import.meta.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta")),
    [],
  );
  const dbcQuote = dbcQuoteOptions.find((q) => q.mint === dbcQuoteMint) || dbcQuoteOptions[0];
  // A stock quote is only chosen through the risk dialog (D22).
  const [pendingStockMint, setPendingStockMint] = useState<string | null>(null);
  const pendingStock = dbcQuoteOptions.find((q) => q.mint === pendingStockMint) || null;
  // Wallets show a stock's raw amount x its multiplier, so a typed first buy is divided by it.
  const [dbcQuoteMultiplier, setDbcQuoteMultiplier] = useState(1);
  useEffect(() => {
    if (dbcQuote?.kind !== "stock") {
      setDbcQuoteMultiplier(1);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { loadSolanaWeb3 } = await import("@/lib/solanaWeb3");
        const { getPublicRpcUrl, SOLANA_CHAIN_ID } = await import("@/lib/chainConfig");
        const web3 = await loadSolanaWeb3();
        const connection = new web3.Connection(
          String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID),
          { commitment: "confirmed", disableRetryOnRateLimit: true },
        );
        const multiplier = await readQuoteUiMultiplier(connection, dbcQuote.mint);
        if (!cancelled) setDbcQuoteMultiplier(multiplier);
      } catch {
        // stays 1: the first buy is then at most the multiplier (under 1%) above what was typed
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbcQuote?.kind, dbcQuote?.mint]);
  const dbcFirstBuyRaw = (): bigint => quoteUiToRaw(dbcFirstBuySol, Number(dbcQuote?.decimals ?? 9), dbcQuoteMultiplier);
  const chooseDbcQuote = (mint: string) => setDbcQuoteMint(mint);
  const [dbcFirstBuyQuote, setDbcFirstBuyQuote] = useState<{ tokensOut: string; bps: string; exceedsCap: boolean; capBps: number } | null>(null);
  // EVM generation-6 factories only (E14: older factories keep today's create form).
  const [evmFeeChoice, setEvmFeeChoice] = useState<CreatorFeeChoice>("keep");
  const [evmCreatorSharePct, setEvmCreatorSharePct] = useState("50");
  const [evmFirstBuyInput, setEvmFirstBuyInput] = useState("");
  const [evmFirstBuyPlan, setEvmFirstBuyPlan] = useState<EvmFirstBuyPlan | null>(null);
  const [evmGen6FactoryAddress, setEvmGen6FactoryAddress] = useState("");
  const [creatorEligibility, setCreatorEligibility] = useState<ScheduledCreatorLaunchEligibility | null>(null);
  const [creatorEligibilityError, setCreatorEligibilityError] = useState<string | null>(null);
  const armDialogShownForWallet = useRef<string | null>(null);
  const graduationTouchedRef = useRef(false);

  const normalizedTicker = useMemo(() => normalizeTicker(formData.ticker), [formData.ticker]);
  // Re-render when the feed chain changes (the header switch below, or the wallet latch),
  // so the chain this page builds for is never a stale read of localStorage.
  const [feedChainId] = useSelectedFeedChainId();
  const noWalletConnected = !wallet.isConnected && !solanaWallet.isSolanaConnected;
  // A connected Solana wallet makes this a Solana launch only while Solana is the
  // chosen chain. It used to win whenever no EVM wallet was connected, so picking
  // Robinhood or BNB with Phantom open still showed the Solana quote list.
  const isSolanaCreator = Boolean(
    solanaWallet.isSolanaConnected &&
      solanaWallet.solanaAccount &&
      getActiveChainId(wallet.chainId ?? feedChainId) === SOLANA_CHAIN_ID,
  );
  const creatorWallet = isSolanaCreator ? solanaWallet.solanaAccount : wallet.account || "";
  const chainId = isSolanaCreator ? SOLANA_CHAIN_ID : getActiveChainId(wallet.chainId ?? feedChainId);
  const dbcLaunch = Boolean(dbcEnabled && isSolanaCreator);
  const graduationOptions: GraduationTier[] = useMemo(
    () => (dbcLaunch ? getDbcGraduationTiers(String(import.meta.env.VITE_SOLANA_CLUSTER || "")) : getGraduationTiers(chainId)),
    [chainId, dbcLaunch],
  );
  const configuredEvmChainId = useMemo(
    () => (isEvmChainId(chainId) ? chainId : BNB_CHAIN_ID),
    [chainId],
  );
  const evmContractReadiness = useMemo(
    () => getBnbContractReadiness(configuredEvmChainId),
    [configuredEvmChainId],
  );
  const evmAddresses = useMemo(
    () => getBnbContractAddresses(configuredEvmChainId),
    [configuredEvmChainId],
  );
  const launchpadSafetyStatus = useMemo(() => {
    if (isSolanaCreator) return launchpad.getSafetyStatus();
    return getBnbLaunchpadSafetyStatus({
      chainId: configuredEvmChainId,
      factoryAddress: evmAddresses.launchFactory,
      hasSigner: Boolean(wallet.signer),
      hasAccount: Boolean(wallet.account),
      walletChainId: wallet.chainId,
      contractReadiness: evmContractReadiness,
    });
  }, [
    evmAddresses.launchFactory,
    evmContractReadiness,
    configuredEvmChainId,
    isSolanaCreator,
    launchpad,
    wallet.account,
    wallet.chainId,
    wallet.signer,
  ]);
  const isSolanaProtocolPending = launchpadSafetyStatus.protocolStatus === "protocol_pending";
  const robinhoodSelected = isRobinhoodChain(Number(configuredEvmChainId));
  const graduationMarketReady = Boolean(
    graduationQuoteAsset?.id && graduationQuoteAsset.newGraduationEligible === true,
  );
  const evmDirectDeployEnabled = robinhoodSelected
    ? readFlag(import.meta.env.VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY, false)
    : readFlag(import.meta.env.VITE_ENABLE_DIRECT_BNB_DEPLOY, false);
  const evmContractsConfigured = evmContractReadiness.ready && Boolean(evmAddresses.launchFactory);
  const walletOkForEvmDeploy = !wallet.account || Number(wallet.chainId) === Number(configuredEvmChainId);
  const solanaDirectDeployReady = Boolean(isSolanaCreator && solanaWallet.solanaAccount);
  const evmDirectDeployReady =
    !isSolanaCreator && evmDirectDeployEnabled && evmContractsConfigured && walletOkForEvmDeploy;
  const directDeployRouteReady = solanaDirectDeployReady || evmDirectDeployReady;
  const tickerConfirmedAvailable = Boolean(
    normalizedTicker && tickerAvailability?.ticker === normalizedTicker && tickerAvailability.available,
  );
  const evmChainLabel = getChainLabel(configuredEvmChainId);

  useEffect(() => {
    setGraduationQuoteAsset(null);
  }, [chainId]);

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
    if (!graduationTouchedRef.current) {
      const preferred = getDefaultGraduationTargetWei(chainId);
      if (preferred !== graduationTargetWei && graduationOptions.some((o) => o.targetWei === preferred)) {
        setGraduationTargetWei(preferred);
      }
    }
  }, [graduationOptions, graduationTargetWei, chainId]);

  useEffect(() => {
    if (!dbcLaunch) {
      setDbcFirstBuyQuote(null);
      return;
    }
    const sol = Number(dbcFirstBuySol);
    if (!Number.isFinite(sol) || sol <= 0) {
      setDbcFirstBuyQuote(null);
      return;
    }
    const lamports = dbcFirstBuyRaw().toString();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteDbcFirstBuy({
        targetUsd: Number(graduationTargetToUsdMicros(graduationTargetWei)) / 1_000_000,
        feeChoice: dbcFeeChoice,
        creatorSharePct: dbcFeeChoice === "split" ? Number(dbcCreatorSharePct) : null,
        firstBuyLamports: lamports,
        quoteMint: dbcQuoteMint,
        creatorWallet: solanaWallet.solanaAccount,
      })
        .then((next) => {
          if (!cancelled) {
            setDbcFirstBuyQuote({
              tokensOut: String(next.tokensOut || "0"),
              bps: String(next.bps || "0"),
              exceedsCap: Boolean(next.exceedsCap),
              capBps: Number(next.capBps) || DBC_FIRST_BUY_MAX_BPS,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setDbcFirstBuyQuote(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dbcLaunch, dbcFirstBuySol, dbcFeeChoice, dbcCreatorSharePct, graduationTargetWei, dbcQuoteMint, dbcQuote, dbcQuoteMultiplier, solanaWallet.solanaAccount]);

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

  useEffect(() => {
    const factoryAddress = launchpad.factoryAddress || "";
    if (isSolanaCreator || !isEvmChainId(chainId) || !factoryAddress) {
      setEvmGen6FactoryAddress("");
      return;
    }
    let cancelled = false;
    void isGen6Factory(getReadProvider(Number(chainId) as any), factoryAddress)
      .then((yes) => {
        if (!cancelled) setEvmGen6FactoryAddress(yes ? factoryAddress : "");
      })
      .catch(() => {
        if (!cancelled) setEvmGen6FactoryAddress("");
      });
    return () => {
      cancelled = true;
    };
  }, [isSolanaCreator, chainId, launchpad.factoryAddress]);
  const evmGen6 = Boolean(evmGen6FactoryAddress) && !isSolanaCreator;

  /** The four gen-6 create fields, priced again right before the wallet signs. */
  const buildEvmGen6Fields = async () => {
    if (!evmGen6) return undefined;
    const budgetWei = parseNativeInput(evmFirstBuyInput);
    const plan = budgetWei > 0n
      ? await freshEvmFirstBuyPlan({ chainId: Number(chainId), factoryAddress: evmGen6FactoryAddress, graduationTarget: graduationTargetWei, budgetWei })
      : null;
    if (plan?.exceedsCap) {
      throw new Error("Your first buy is over the cap. Lower the amount.");
    }
    return gen6CreateFields({ choice: evmFeeChoice, creatorSharePct: evmCreatorSharePct, firstBuy: plan });
  };

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
      toast.error("Please connect your EVM or Solana wallet first");
      return false;
    }
    if (!isSolanaCreator && !wallet.signer) {
      toast.error(`Wallet signer unavailable. Reconnect your ${evmChainLabel} wallet and try again.`);
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
    if (!dbcLaunch && (!graduationMarketReady || !graduationQuoteAsset)) {
      toast.error("Choose a Graduation Market first.");
      return;
    }
    setIsDrafting(true);
    try {
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
        ...(dbcLaunch
          ? {
              launchType: "dbc",
              dbcFeeChoice,
              dbcCreatorSharePct: dbcFeeChoice === "split" ? Number(dbcCreatorSharePct) : null,
              dbcFirstBuyLamports: dbcFirstBuySol ? dbcFirstBuyRaw().toString() : null,
              dbcQuoteMint,
            }
          : {}),
        ...(dbcLaunch ? {} : buildCreateDraftGraduationFields(graduationQuoteAsset, chainId)),
        ...(evmGen6
          ? {
              feeChoice: evmFeeChoice,
              feeCreatorPct: evmFeeChoice === "split" ? Number(evmCreatorSharePct) : 0,
              firstBuyTokens: (evmFirstBuyPlan?.tokens ?? 0n).toString(),
            }
          : {}),
        ...(isSolanaCreator
          ? { cluster: String(import.meta.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta") }
          : {}),
      } as any);
      cacheDraftLogo(draft.id, logoUrl);

      if (dbcLaunch) {
        toast.success("Solana draft signed and saved. No gas spent.");
        navigate(`/drafts/${draft.id}/promotion`);
        return;
      }
      const expectedSelection = buildCreateDraftGraduationFields(graduationQuoteAsset, chainId);
      const persistedId = String((draft as any).graduationQuoteAssetId || "");
      const persistedKind = String((draft as any).graduationMarketKind || "").toUpperCase();
      const quoteSelectionPersisted = persistedId === expectedSelection.graduationQuoteAssetId;
      const legacyStockPersisted =
        expectedSelection.graduationMarketKind === "STOCK_TOKEN" &&
        persistedKind === "STOCK_TOKEN";
      if (!quoteSelectionPersisted && !legacyStockPersisted) {
        toast.error("Draft saved, but its Graduation Market selection did not persist. Do not deploy it until the policy is restored.");
        navigate(`/drafts/${draft.id}/promotion`);
        return;
      }

      toast.success(isSolanaCreator ? "Solana draft signed and saved. No gas spent." : `${evmChainLabel} draft signed and saved. No gas spent.`);
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
    if (!dbcLaunch && (!graduationMarketReady || !graduationQuoteAsset)) {
      toast.error("Choose a Graduation Market first.");
      return;
    }

    if (isSolanaCreator && dbcLaunch) {
      if (!solanaWallet.solanaAccount) {
        toast.error("Connect your Solana wallet first.");
        return;
      }
      setIsDeploying(true);
      analytics.track("token_create_started", { surface: "dbc", chain: "solana" });
      try {
        const targetUsd = Number(graduationTargetToUsdMicros(graduationTargetWei)) / 1_000_000;
        const firstBuyLamports = dbcFirstBuySol ? dbcFirstBuyRaw().toString() : "0";
        if (dbcFirstBuyQuote?.exceedsCap) {
          throw new Error(`The first buy cannot be more than ${dbcFirstBuyQuote.capBps / 100}% of supply.`);
        }
        toast.message("Checking that this wallet can launch…");
        const preflight = await preflightDbcCreate({ creatorWallet, targetUsd });
        if (!preflight?.preflight?.allowed) {
          const errorMessage = preflight?.preflight?.cooldownActive
            ? "This wallet launched a coin in the last 24 hours. It can launch again after that."
            : `Live DBC coin limit reached (${preflight?.preflight?.creatorLiveBondingCount}/${preflight?.preflight?.creatorMaxLiveBondingCount}).`;
          emitCreatorArmBlocked(resolveCreatorArmBlock({ mode: "now", errorMessage, errorCode: "DBC_CREATOR_LAUNCH_LIMIT" }));
          return;
        }
        const { signWalletAction } = await import("@/lib/walletActionAuth");
        const { signSolanaMessage } = await import("@/lib/solanaWallet");
        toast.message("Sign in your wallet to start the launch…");
        const dbcAuth = await signWalletAction({
          action: "dbc_create",
          walletAddress: creatorWallet,
          chainId: SOLANA_CHAIN_ID,
          extraLines: [`Ticker: ${normalizedTicker}`],
          walletType: "solana",
          signMessage: async (message) => (await signSolanaMessage(message, creatorWallet)).signature,
        });
        const begun = await beginDbcCreate({
          creatorWallet,
          ticker: normalizedTicker,
          auth: dbcAuth,
        });
        if (!begun.sessionToken) throw new Error("The launch could not start. Try again.");
        const logoUrl = await uploadLogo({ directSessionToken: begun.sessionToken });
        const web3 = await loadSolanaWeb3();
        const mint = web3.Keypair.generate();
        toast.message("Preparing your launch…");
        const authorization = await authorizeDbcCreate({
          sessionToken: begun.sessionToken,
          mint: mint.publicKey.toBase58(),
          name: formData.name,
          symbol: normalizedTicker,
          description: formData.description || null,
          logoUrl,
          website: formData.website || null,
          x: formData.twitter || null,
          telegram: formData.telegram || null,
          discord: formData.discord || null,
          targetUsd,
          feeChoice: dbcFeeChoice,
          creatorSharePct: dbcFeeChoice === "split" ? Number(dbcCreatorSharePct) : null,
          firstBuyLamports,
          quoteMint: dbcQuoteMint,
        });
        toast.message("Confirm the launch in your wallet…");
        const created = await submitDbcCreateTransaction({
          transactionBase64: authorization.transaction,
          mintSecretKey: mint.secretKey,
          creatorAddress: creatorWallet,
          pool: authorization.pool,
          mintAddress: mint.publicKey.toBase58(),
          config: authorization.config,
        });
        const finalized = await finalizeDbcCreate({
          finalizeToken: authorization.finalizeToken,
          signature: created.signature,
        });
        analytics.track("token_create_succeeded", { surface: "dbc", chain: "solana" });
        toast.success("Your coin is live.");
        navigate(finalized.tokenPath || `/token/${created.mintAddress}?chainId=101`);
      } catch (error: any) {
        console.error(error);
        analytics.track("token_create_failed", { surface: "dbc", chain: "solana", error_code: analyticsErrorCode(error) });
        toast.error(String(error?.message || "The launch did not go through. Try again."));
      } finally {
        setIsDeploying(false);
      }
      return;
    }

    if (isSolanaCreator) {
      if (!solanaWallet.solanaAccount) {
        toast.error("Connect your Solana wallet first.");
        return;
      }
      // Solana binds any catalog Graduation Market server-side at finalize
      // (campaign_graduation_quote_bindings); only unknown paths are refused.
      if (!["native", "solana-quote"].includes(String(directDeployBindPath(graduationQuoteAsset)))) {
        toast.error("This Graduation Market cannot be bound on Solana Direct Deploy. Save a Draft instead.");
        return;
      }
      setIsDeploying(true);
      analytics.track("token_create_started", { surface: "launchpad", chain: "solana" });
      try {
        await assertFreshGraduationQuote(graduationQuoteAsset);
        const graduationTargetUsdMicros = graduationTargetToUsdMicros(graduationTargetWei);
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
          analytics.track("token_create_failed", { surface: "launchpad", chain: "solana", error_code: "not_eligible" });
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
        if (!begun.sessionToken) throw new Error("Railway did not return a Direct deployment session.");

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
          // The chosen Graduation Market; the server validates it against the
          // catalog and binds it to the campaign when the create is finalized.
          graduationQuoteAssetId: graduationQuoteAsset.presentationDefault ? null : graduationQuoteAsset.id,
        });

        if (authorization.alreadyOnChain && authorization.tokenPath) {
          // A campaign reaches this branch when its create already landed, and
          // under v7 that means the launch is complete: create_campaign writes
          // the metadata, revokes the mint authority and creates the fee
          // accounts in the same transaction that mints the supply. There is no
          // half-finished state left to detect or repair.
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

        // No second transaction. v7's create_campaign writes the Metaplex
        // metadata, revokes the mint authority and creates both fee accounts in
        // the same instruction that mints the supply, so the token is named and
        // tradeable the moment this returns. The v6 split existed only because
        // create could not afford the bytes; removing five arguments that were
        // never read back bought enough room to put it back, and with it the
        // entire class of half-finished launch.
        analytics.track("token_create_succeeded", { surface: "launchpad", chain: "solana" });
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
        analytics.track("token_create_failed", {
          surface: "launchpad",
          chain: "solana",
          error_code: analyticsErrorCode(error),
        });
        if (/SOLANA_CREATOR_(?:COOLDOWN|LAUNCH_LIMIT)/i.test(errorCode + " " + errorMessage)) {
          emitCreatorArmBlocked(resolveCreatorArmBlock({ mode: "now", errorMessage, errorCode }));
        } else {
          toast.error(errorMessage);
        }
      } finally {
        setIsDeploying(false);
      }
      return;
    }

    if (!evmDirectDeployEnabled) {
      toast.error(`Direct ${evmChainLabel} deploy is disabled for this environment. Save a draft instead.`);
      return;
    }
    if (!directDeployRouteReady) {
      toast.error(`Direct ${evmChainLabel} deploy needs the final launchpad contract env values first.`);
      return;
    }
    if (!wallet.account || !wallet.signer) {
      toast.error(`Connect your ${evmChainLabel} wallet first.`);
      return;
    }
    if (!graduationMarketReady || !graduationQuoteAsset) {
      toast.error("Choose a Graduation Market first.");
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

      const gen6Fields = await buildEvmGen6Fields();
      const logoUrl = await uploadLogo();
      let campaignAddress = "";
      let tokenAddress = "";
      const freshQuote = await assertFreshGraduationQuote(graduationQuoteAsset);
      const bindPath = directDeployBindPath(freshQuote);

      if (bindPath === "robinhood-stock") {
        const stockToken = await resolveRobinhoodStockTokenForQuote(Number(chainId), freshQuote);
        const stockFactoryAddress = launchpad.factoryAddress || evmAddresses.launchFactory;
        const created = await createRobinhoodStockCampaign({
          signer: wallet.signer,
          chainId: Number(chainId),
          factoryAddress: stockFactoryAddress,
          creatorAddress: wallet.account,
          name: formData.name,
          symbol: normalizedTicker,
          logoURI: logoUrl,
          xAccount: normalizeSocialUrl(formData.twitter, "x"),
          website: normalizeSocialUrl(formData.website, "website"),
          extraLink: normalizeSocialUrl(formData.otherLink, "other"),
          graduationTargetWei,
          stockToken,
          ...(gen6Fields ? { gen6: gen6Fields } : {}),
        });
        campaignAddress = created.campaignAddress;
        tokenAddress = created.tokenAddress;
        analytics.track("token_create_succeeded", {
          surface: "launchpad",
          chain: "robinhood",
          graduation_market: "stock_token",
          stock_symbol: stockToken.symbol,
        });
        toast.success(`Campaign deployed on ${evmChainLabel} · permanent market $${normalizedTicker}/${stockToken.symbol}.`);
      } else if (bindPath !== "native") {
        throw new Error("Direct Deploy for this Graduation Market is not available until server quote binding is integrated.");
      } else {
        const receipt: any = await launchpad.createCampaign({
          name: formData.name,
          symbol: normalizedTicker,
          logoURI: logoUrl,
          xAccount: normalizeSocialUrl(formData.twitter, "x"),
          website: normalizeSocialUrl(formData.website, "website"),
          extraLink: normalizeSocialUrl(formData.otherLink, "other"),
          graduationTargetWei,
          ...(gen6Fields ? { gen6: gen6Fields } : {}),
        });
        campaignAddress = String(receipt?.campaignAddress || "").trim();
        tokenAddress = String(receipt?.tokenAddress || "").trim();
        toast.success(`Campaign deployed on ${evmChainLabel}.`);
      }

      if (tokenAddress || campaignAddress) {
        navigate(tokenDetailsPath({ tokenAddress, campaignAddress, chainId }, { chainId }));
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
    // A DBC coin graduates into its own Meteora pool: no Graduation Market catalog choice.
    if (fromStep === 5) return dbcLaunch || graduationMarketReady;
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
      else if (step === 5) toast.error("Choose a Graduation Market first.");
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
  const graduationSummary = graduationQuoteAsset
    ? selectedMarketSummary({
        ticker: normalizedTicker,
        asset: graduationQuoteAsset,
        chainId,
      })
    : {
        pair: "—",
        quoteAsset: "—",
        provider: "—",
        bonding: getNativeSymbol(chainId),
        moving: false,
      };
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

  const modeSelectedClass = "border-mw-accent bg-mw-accent-fill text-mw-text";
  const modeIdleClass = "border-mw-border bg-mw-input text-mw-text hover:border-[#3A424C]";

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
        <div className="flex flex-wrap items-center gap-2 text-xs text-mw-muted">
          <span>
            Wallet{" "}
            <span className="text-mw-text">{creatorWallet ? `${creatorWallet.slice(0, 4)}…${creatorWallet.slice(-4)}` : "not connected"}</span>
            {" · "}
            {isSolanaCreator ? "Solana" : getChainLabel(chainId)}
          </span>
          {/* No wallet yet: the chain is a choice, so show it as one. Connected: the wallet's network is the chain. */}
          {noWalletConnected ? <ChainFeedSwitch /> : null}
        </div>
        <Button asChild size="sm" variant="outline" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50 min-h-9 text-sm">
          <Link to="/playbook"><BookOpen className="mr-1.5 h-3.5 w-3.5" />Playbook</Link>
        </Button>
      </div>

      <LaunchCanaryBanner />

      <CreateWizardShell
        v2
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
            data-testid={`create-step-${step}`}
          >
            {step === 1 ? (
              <CreateSplitPane
                v2
                left={
                  <div className="max-w-md space-y-3 text-sm leading-relaxed text-mw-muted">
                    <p className="m-0 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Choose your path</p>
                    <h2 className="m-0 font-mw-cond text-2xl font-bold text-mw-text sm:text-[28px]">Draft first — or go live now</h2>
                    <p><span className="font-semibold text-mw-accent-soft">Draft mode</span> saves your coin with a wallet signature only (no gas). You get a promotion page, can build heat, then push live when ready.</p>
                    <p><span className="font-semibold text-mw-accent-soft">Direct deploy</span> uploads the creative, asks your {isSolanaCreator ? "Solana" : evmChainLabel} wallet to sign the deployment transaction, pays gas, and lands you on Token Details when the contract is live.</p>
                  </div>
                }
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <button type="button" onClick={() => setMode("draft")} className={cn("mw-focus rounded-xl border p-4 text-left transition", mode === "draft" ? modeSelectedClass : modeIdleClass)}>
                      <div className="flex items-center gap-2 font-mw-cond text-xl font-bold text-mw-text"><FileText className="h-5 w-5 text-mw-accent-soft" />Draft mode</div>
                      <p className="mt-2 text-xs leading-relaxed text-mw-muted">Free to save. Sign once, open the promotion setup page, launch later.</p>
                    </button>
                    <button type="button" onClick={() => setMode("deploy")} className={cn("mw-focus rounded-xl border p-4 text-left transition", mode === "deploy" ? modeSelectedClass : modeIdleClass)}>
                      <div className="flex items-center gap-2 font-mw-cond text-xl font-bold text-mw-text"><Rocket className="h-5 w-5 text-mw-accent-soft" />Direct deploy</div>
                      <p className="mt-2 text-xs leading-relaxed text-mw-muted">
                        {directDeployRouteReady
                          ? isSolanaCreator
                            ? "Sign once in your wallet and go straight to your coin's page. No promotion page."
                            : `${evmChainLabel} wallet + gas. Live bonding campaign as soon as the tx confirms.`
                          : isSolanaCreator
                            ? "Connect a Solana wallet to enable Direct deploy."
                            : !evmDirectDeployEnabled
                              ? `Locked in this environment — pick Draft, or enable the Direct ${evmChainLabel} deployment flag.`
                              : !evmContractsConfigured
                                ? `${evmChainLabel} contracts are incomplete in env — pick Draft or finish chain wiring.`
                                : !walletOkForEvmDeploy
                                  ? `Switch wallet to chain ${configuredEvmChainId} (${evmChainLabel}) for Direct deploy.`
                                  : "Direct deploy is not ready — pick Draft for now."}
                      </p>
                    </button>
                    <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-11" disabled={!mode} onClick={goNext}>Next</Button>
                  </div>
                }
              />
            ) : null}

            {step === 2 ? (
              <CreateSplitPane
                v2
                left={<div className="flex w-full flex-col items-center gap-2"><p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{mode === "deploy" ? "Live card preview" : "Draft card preview"}</p>{preview}</div>}
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div><label className="text-sm font-semibold text-mw-text">Token image</label><p className="mt-0.5 text-xs text-mw-muted">PNG / JPG / WebP · max 5 MB</p></div>
                    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/jpg,image/webp,image/gif" className="hidden" onChange={handleImageChange} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50" onClick={() => fileRef.current?.click()}><ImageIcon className="mr-2 h-4 w-4" />{formData.imagePreview ? "Replace image" : "Upload image"}</Button>
                      {formData.imagePreview ? <Button type="button" variant="ghost" size="sm" onClick={handleRemoveImage}>Remove</Button> : null}
                    </div>
                    <div>
                      <label className="mb-1.5 flex items-baseline justify-between font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                        <span>Name</span>
                        {/* Metaplex caps the on-chain name at 32 bytes. Showing the
                            count means a creator sees the limit rather than
                            discovering it when the field stops accepting input. */}
                        <span className={`font-sans text-xs ${tokenNameByteLength(formData.name) > TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH ? "text-red-400" : "text-mw-muted"}`}>
                          {tokenNameByteLength(formData.name)}/{TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH}
                        </span>
                      </label>
                      <Input value={formData.name} onChange={(e) => setTokenName(e.target.value)} placeholder="WhatIsThisForACoin" maxLength={TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH} className="font-sans normal-case tracking-normal" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                    </div>
                    <div>
                      <label className="mb-1.5 block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Ticker</label>
                      <Input value={formData.ticker} onChange={(e) => setTicker(e.target.value)} placeholder="TICKER" maxLength={TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH} className="font-mw-cond font-bold uppercase" />
                      <p className={cn("mt-1 text-xs", tickerConfirmedAvailable ? "text-green-300" : tickerCheckError || tickerAvailability ? "text-mw-accent-soft" : "text-mw-muted")}>{tickerStatusLine}</p>
                    </div>
                    <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-11" disabled={!canGoNext(2)} onClick={goNext}>Next</Button>
                  </div>
                }
              />
            ) : null}

            {step === 3 ? (
              <CreateSplitPane
                v2
                left={<div className="flex w-full flex-col items-center gap-2"><p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Preview updates live</p>{preview}</div>}
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div><label className="mb-1.5 block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Short description <span className="text-mw-accent-soft">*</span></label><Textarea value={formData.description} onChange={(e) => setDescription(e.target.value)} placeholder="What should visitors know?" className="min-h-20 font-sans text-sm normal-case tracking-normal" maxLength={TOKEN_VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH} /></div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input value={formData.website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website" className="font-sans text-sm normal-case" />
                      <Input value={formData.twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="X / @handle / url" className="font-sans text-sm normal-case" />
                      <Input value={formData.telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="Telegram" className="font-sans text-sm normal-case" />
                      <Input value={formData.discord} onChange={(e) => setDiscord(e.target.value)} placeholder="Discord" className="font-sans text-sm normal-case" />
                      <Input value={formData.otherLink} onChange={(e) => setOtherLink(e.target.value)} placeholder="Other link" className="font-sans text-sm normal-case sm:col-span-2" />
                    </div>
                    <p className="text-[11px] text-mw-muted">Socials optional. Use @memewarzone, https://x.com/memewarzone, or bare memewarzone.</p>
                    <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-11" disabled={!canGoNext(3)} onClick={goNext}>Next</Button>
                  </div>
                }
              />
            ) : null}

            {step === 4 ? (
              <CreateSplitPane
                v2
                left={<div className="flex w-full flex-col items-center gap-2">{preview}{selectedGraduation ? <p className="text-center text-xs text-mw-muted">Graduation: <span className="text-accent">{selectedGraduation.label}</span> · {selectedGraduation.title}</p> : null}</div>}
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
                    <div><div className="text-sm font-semibold text-mw-text">Graduation threshold</div><p className="mt-0.5 text-xs text-mw-muted">Bonding volume before DEX graduation.</p></div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {graduationOptions.map((option) => {
                        const selected = graduationTargetWei === option.targetWei;
                        const isTest = option.id === "test";
                        return (
                          <button key={option.id} type="button" onClick={() => { graduationTouchedRef.current = true; setGraduationTargetWei(option.targetWei); }} className={cn("rounded-lg border px-2.5 py-2 text-left transition", isTest && "col-span-2 border-dashed", selected ? isTest ? "border-orange-300 bg-orange-400/15 text-orange-100" : "border-accent bg-accent/15 text-mw-text" : "border-border bg-muted/30 text-mw-muted hover:border-accent/60") }>
                            <div className="flex items-center justify-between gap-2"><span className="font-mw-cond font-bold text-sm">{option.label}</span><span className="font-mw-cond font-bold text-[10px] uppercase tracking-[0.12em]">{option.title}</span></div>
                            <p className="mt-0.5 line-clamp-2 text-[0.65rem] leading-4 opacity-90">{option.description}</p>
                          </button>
                        );
                      })}
                    </div>
                    {dbcLaunch ? (
                      <div className="space-y-3 rounded-xl border border-border/50 bg-background/25 p-3">
                        <CreatorFeeChoicePicker value={dbcFeeChoice} onChange={setDbcFeeChoice} sharePct={dbcCreatorSharePct} onSharePctChange={setDbcCreatorSharePct} />
                        <p className="text-xs text-mw-muted">{LAUNCH_FEE_NOTE}</p>
                      </div>
                    ) : null}
                    {evmGen6 ? (
                      <EvmGen6LaunchOptions
                        chainId={Number(chainId)}
                        factoryAddress={evmGen6FactoryAddress}
                        graduationTarget={graduationTargetWei}
                        feeChoice={evmFeeChoice}
                        onFeeChoiceChange={setEvmFeeChoice}
                        sharePct={evmCreatorSharePct}
                        onSharePctChange={setEvmCreatorSharePct}
                        firstBuyInput={evmFirstBuyInput}
                        onFirstBuyInputChange={setEvmFirstBuyInput}
                        onPlanChange={setEvmFirstBuyPlan}
                      />
                    ) : null}
                    <Collapsible open={safetyOpen} onOpenChange={setSafetyOpen} className="rounded-xl border border-border/50 bg-background/25">
                      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 p-3 text-left">
                        <div><div className="text-sm font-semibold text-mw-text">Launch Safety</div><p className="mt-0.5 text-xs text-mw-muted">{launchpadSafetyStatus.protocolLabel ?? (launchpadSafetyStatus.protocolStatus === "ready" ? "Live" : launchpadSafetyStatus.protocolStatus)}{" · "}{launchpadSafetyStatus.chainLabel}</p></div>
                        <ChevronDown className="h-4 w-4 shrink-0 text-mw-muted transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="px-3 pb-3"><LaunchpadSafetyStatus status={launchpadSafetyStatus} compact embedded /></CollapsibleContent>
                    </Collapsible>
                    <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-11 shrink-0" disabled={!canGoNext(4)} onClick={goNext}>Next</Button>
                  </div>
                }
              />
            ) : null}

            {step === 5 && dbcLaunch ? (
              <CreateFullPane>
                <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
                  <div>
                    <div className="font-mw-cond text-xl font-bold text-mw-text">Market</div>
                    <p className="mt-1 text-sm text-mw-muted">
                      Your coin trades in this token on the curve and pairs with it in its Meteora pool after graduation. SOL is the default; a stock or stablecoin is your call and shows its risks before you confirm.
                    </p>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-mw-text">Quote</div>
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                      {dbcQuoteOptions.map((q) => (
                        <button
                          key={q.mint}
                          type="button"
                          onClick={() => (q.kind === "stock" && q.mint !== dbcQuoteMint ? setPendingStockMint(q.mint) : chooseDbcQuote(q.mint))}
                          className={cn("rounded-lg border px-2.5 py-2 text-left", dbcQuoteMint === q.mint ? "border-accent bg-accent/15" : "border-border bg-muted/30")}
                        >
                          <div className="font-mw-cond font-bold text-sm">{q.symbol}</div>
                          <p className="mt-0.5 text-[0.65rem] leading-4 text-mw-muted">{q.kind === "native" ? "Chain coin" : q.kind === "stable" ? "1:1 USD" : "Stock token"}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-mw-text">Your first buy (optional)</div>
                    <p className="mt-0.5 text-xs text-mw-muted">Buys in the same transaction as the launch, at the normal 2% fee.</p>
                    <Input type="number" min={0} step="0.01" value={dbcFirstBuySol} onChange={(e) => setDbcFirstBuySol(e.target.value)} placeholder={`${dbcQuote?.symbol || "SOL"} amount`} className="mt-2 max-w-[12rem]" />
                    {dbcFirstBuyQuote ? (
                      <p className={cn("mt-1 text-xs", dbcFirstBuyQuote.exceedsCap ? "text-mw-accent-soft" : "text-mw-muted")}>
                        About {(Number(dbcFirstBuyQuote.bps) / 100).toFixed(2)}% of supply
                        {dbcFirstBuyQuote.exceedsCap ? ` (over the ${dbcFirstBuyQuote.capBps / 100}% cap)` : ""}.
                      </p>
                    ) : null}
                  </div>
                  {pendingStock ? (
                    <DbcStockRiskDialog
                      mint={pendingStock.mint}
                      symbol={pendingStock.symbol}
                      ticker={normalizedTicker}
                      onConfirm={() => {
                        chooseDbcQuote(pendingStock.mint);
                        setPendingStockMint(null);
                      }}
                      onCancel={() => setPendingStockMint(null)}
                    />
                  ) : null}
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                    <div className="flex justify-between gap-3"><span className="text-mw-muted">Pool after graduation</span><span className="text-mw-text">{normalizedTicker || "TICKER"}/{dbcQuote?.symbol || "SOL"} on Meteora, liquidity locked</span></div>
                    <div className="flex justify-between gap-3"><span className="text-mw-muted">Your share at graduation</span><span className="text-mw-text">19.8% of what the curve raised</span></div>
                  </div>
                  <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-11 shrink-0" onClick={goNext}>Next</Button>
                </div>
              </CreateFullPane>
            ) : null}

            {step === 5 && !dbcLaunch ? (
              <CreateFullPane>
                <GraduationMarketStep
                  chainId={chainId}
                  ticker={normalizedTicker}
                  selected={graduationQuoteAsset}
                  onSelectedChange={setGraduationQuoteAsset}
                  onNext={goNext}
                  canNext={canGoNext(5)}
                  nativeOnly={dbcLaunch}
                />
              </CreateFullPane>
            ) : null}

            {step === 6 ? (
              <CreateSplitPane
                v2
                left={<div className="flex w-full flex-col items-center gap-2"><p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Final preview</p>{preview}</div>}
                right={
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <div className="space-y-2 rounded-xl border border-border/50 bg-background/30 p-3 text-sm" data-testid="create-review">
                      <div className="flex justify-between gap-3"><span className="text-mw-muted">Mode</span><span className="font-mw-cond font-bold text-mw-text">{mode === "deploy" ? "Direct deploy" : "Draft"}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-mw-muted">Name</span><span className="truncate font-medium text-mw-text">{formData.name || "—"}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-mw-muted">Ticker</span><span className="font-medium text-mw-text">{normalizedTicker ? `$${normalizedTicker}` : "—"}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-mw-muted">Graduation threshold</span><span className="text-mw-text">{selectedGraduation?.label || "—"}</span></div>
                      {dbcLaunch ? (
                        <div className="flex justify-between gap-3"><span className="text-mw-muted">Graduates into</span><span className="text-right text-mw-text">{normalizedTicker || "TICKER"}/{dbcQuote?.symbol || "SOL"} on Meteora</span></div>
                      ) : (
                        <>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Graduation Market</span><span className="text-right text-mw-text">{graduationSummary.pair}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Quote Asset</span><span className="text-mw-text">{graduationSummary.quoteAsset}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Provider</span><span className="text-mw-text">{graduationSummary.provider}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Bonding currency</span><span className="text-mw-text">{graduationSummary.bonding}</span></div>
                        </>
                      )}
                      {dbcLaunch ? (
                        <>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Creator fee</span><span className="text-mw-text">{DBC_FEE_CHOICE_LABEL[dbcFeeChoice] || dbcFeeChoice}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">First buy</span><span className="text-mw-text">{dbcFirstBuySol ? `${dbcFirstBuySol} ${dbcQuote?.symbol || "SOL"}` : "None"}</span></div>
                        </>
                      ) : null}
                      {evmGen6 ? (
                        <>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">Creator fee</span><span className="text-mw-text">{DBC_FEE_CHOICE_LABEL[evmFeeChoice] || evmFeeChoice}{evmFeeChoice === "split" ? ` (${evmCreatorSharePct}% to you)` : ""}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-mw-muted">First buy</span><span className="text-mw-text">{evmFirstBuyPlan && evmFirstBuyPlan.tokens > 0n ? `${evmFirstBuyInput} ${getNativeSymbol(chainId)} (${(evmFirstBuyPlan.supplyBps / 100).toFixed(2)}% of supply)` : "None"}</span></div>
                        </>
                      ) : null}
                      {!creatorWallet ? <p className="pt-1 text-xs text-mw-accent-soft">Connect your wallet before launching.</p> : null}
                      {mode === "deploy" && !directDeployRouteReady ? (
                        <p className="pt-1 text-xs text-mw-accent-soft">
                          {isSolanaCreator
                            ? "Connect Solana wallet to Direct deploy (draft → Push Live)."
                            : !evmDirectDeployEnabled
                              ? `Direct ${evmChainLabel} deploy is disabled in this build — choose Draft.`
                              : !evmContractsConfigured
                                ? `${evmChainLabel} launch contracts are incomplete — choose Draft or fix env wiring.`
                                : !walletOkForEvmDeploy
                                  ? `Switch wallet to ${evmChainLabel} (chain ${configuredEvmChainId}).`
                                  : "Direct deploy is not ready — go back and choose Draft."}
                        </p>
                      ) : null}
                      {creatorEligibilityError ? <p className="pt-1 text-xs text-mw-accent-soft">{creatorEligibilityError}</p> : null}
                    </div>

                    {mode === "deploy" ? (
                      <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-auto h-12 w-full text-base" disabled={isDeploying || isDrafting || !directDeployRouteReady || !(dbcLaunch || graduationMarketReady)} onClick={() => void handleDeployNow()}><Rocket className="mr-2 h-5 w-5" />{isDeploying ? "Deploying… waiting for confirmation" : "Deploy now"}</Button>
                    ) : (
                      <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50 mt-auto h-12 w-full" disabled={isDrafting || isDeploying || !(dbcLaunch || graduationMarketReady)} onClick={() => void handleCreateDraft()}><FileText className="mr-2 h-5 w-5" />{isDrafting ? "Signing & saving draft…" : "Save Draft"}</Button>
                    )}
                    <p className="text-[11px] text-mw-muted">{mode === "deploy" ? "Wallet signs + gas. Stay here until deploy confirms — then Token Details." : "One signature to save. No gas. Next: promotion setup / edit page."}</p>
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

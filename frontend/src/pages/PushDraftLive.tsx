import { useEffect, useMemo, useState } from "react";
import { DBC_FIRST_BUY_MAX_BPS } from "../../shared/dbcEconomics.mjs";
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
import { isDbcLaunchEnabled } from "@/lib/dbcLaunchEnabled";
import { getDbcGraduationTiers } from "@/lib/dbcGraduationTiers";
import type { CreatorFeeChoice } from "@/components/create/CreatorFeeChoicePicker";
import {
  EvmGen6LaunchOptions,
  freshEvmFirstBuyPlan,
  parseNativeInput,
} from "@/components/create/EvmGen6LaunchOptions";
import { gen6CreateFields } from "@/lib/evmGen6.mjs";
import { isGen6Factory } from "@/lib/evmGen6Client";
import { getReadProvider } from "@/lib/readProvider";
import {
  authorizeDbcCreate,
  beginDbcCreate,
  finalizeDbcCreate,
  preflightDbcCreate,
  quoteDbcFirstBuy,
  scheduleDbcDraft,
} from "@/lib/dbcCreate";
import { enabledQuotes, quoteRawToUi, quoteUiToRaw, WSOL_MINT } from "../../shared/dbcQuotes.mjs";
import { submitDbcCreateTransaction } from "@/lib/dbcCreateSubmit";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { isScheduleLocked } from "../../shared/dbcSchedule.mjs";

const DRAFT_PUSH_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_DRAFT_PUSH_LIVE_ENABLED || import.meta.env.VITE_ENABLE_DRAFT_PUSH_LIVE || "")
    .trim()
    .toLowerCase(),
);

function canPushLive(status?: string, opts?: { dbc?: boolean; due?: boolean }) {
  if (opts?.dbc && (status === "scheduled" || status === "ready_to_launch" || status === "promotion_published")) return true;
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
  // EVM generation-6 factories only (E14: older factories keep today's deploy form).
  const [evmFeeChoice, setEvmFeeChoice] = useState<CreatorFeeChoice>("keep");
  const [evmCreatorSharePct, setEvmCreatorSharePct] = useState("50");
  const [evmFirstBuyInput, setEvmFirstBuyInput] = useState("");
  const [evmGen6FactoryAddress, setEvmGen6FactoryAddress] = useState("");
  const [evmSavedFirstBuyTokens, setEvmSavedFirstBuyTokens] = useState(0n);
  // DBC first buy on Push live (founder, 2026-10-06): filled with the amount saved on the draft, and
  // editable here. Stock quotes keep the saved amount (their wallet multiplier is read on Create).
  const [dbcFirstBuyInput, setDbcFirstBuyInput] = useState("");
  const [dbcFirstBuyQuote, setDbcFirstBuyQuote] = useState<{ bps: string; exceedsCap: boolean; capBps: number } | null>(null);

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
          const dbc = String((data.draft as { launchType?: string }).launchType || "") === "dbc";
          // A DBC draft keeps its own target ($15K/$30K/$50K, or $150 on devnet).
          const supported = dbc
            ? getDbcGraduationTiers().some((tier) => tier.targetWei === persistedTarget)
            : isSupportedGraduationTarget(Number(data.draft.chainId), persistedTarget);
          if (supported) setGraduationTargetWei(persistedTarget);
          const saved = data.draft.evmLaunchOptions;
          if (saved?.feeChoiceName) setEvmFeeChoice(saved.feeChoiceName);
          if (saved?.feeChoiceName === "split" && saved.feeCreatorPct) setEvmCreatorSharePct(String(saved.feeCreatorPct));
          if (saved?.firstBuyTokens && BigInt(saved.firstBuyTokens) > 0n) setEvmSavedFirstBuyTokens(BigInt(saved.firstBuyTokens));
          const savedDbcFirstBuy = String((data.draft as { dbcFirstBuyLamports?: string | null }).dbcFirstBuyLamports || "");
          const savedQuote = enabledQuotes(String(import.meta.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta")).find(
            (q) => q.mint === ((data.draft as { dbcQuoteMint?: string | null }).dbcQuoteMint || WSOL_MINT),
          );
          if (dbc && /^\d+$/.test(savedDbcFirstBuy) && BigInt(savedDbcFirstBuy) > 0n && savedQuote) {
            setDbcFirstBuyInput(String(quoteRawToUi(savedDbcFirstBuy, Number(savedQuote.decimals ?? 9))));
          }
          // A scheduled DBC draft shows the time it was saved with, not a fresh default.
          const savedAt = dbc && data.draft.scheduledLaunchAt ? new Date(String(data.draft.scheduledLaunchAt)) : null;
          if (savedAt && Number.isFinite(savedAt.getTime())) setLaunchAtInput(toLocalInputValue(savedAt));
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
  const deployFactoryAddress = mode === "scheduled" ? scheduledFactoryAddress : launchpad.factoryAddress;

  useEffect(() => {
    if (!draft || draftIsSolana || !deployFactoryAddress) {
      setEvmGen6FactoryAddress("");
      return;
    }
    let cancelled = false;
    void isGen6Factory(getReadProvider(Number(draft.chainId) as any), deployFactoryAddress)
      .then((yes) => {
        if (!cancelled) setEvmGen6FactoryAddress(yes ? deployFactoryAddress : "");
      })
      .catch(() => {
        if (!cancelled) setEvmGen6FactoryAddress("");
      });
    return () => {
      cancelled = true;
    };
  }, [draft, draftIsSolana, deployFactoryAddress]);
  const evmGen6 = Boolean(evmGen6FactoryAddress) && !draftIsSolana;

  /** The four gen-6 create fields, priced again right before the wallet signs. */
  const buildEvmGen6Fields = async () => {
    if (!evmGen6 || !draft) return undefined;
    const budgetWei = parseNativeInput(evmFirstBuyInput);
    const plan = budgetWei > 0n
      ? await freshEvmFirstBuyPlan({ chainId: Number(draft.chainId), factoryAddress: evmGen6FactoryAddress, graduationTarget: graduationTargetWei, budgetWei })
      : null;
    if (plan?.exceedsCap) throw new Error("Your first buy is over the cap. Lower the amount.");
    return gen6CreateFields({ choice: evmFeeChoice, creatorSharePct: evmCreatorSharePct, firstBuy: plan });
  };
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
        // Under v7 a landed create is a finished launch: the same instruction
        // writes the metadata, revokes the mint authority and creates the fee
        // accounts. There is no half-finished state left to detect.
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

      // No second transaction. Draft and scheduled launches go through the same
      // create as Direct Deploy, and under v7 that one instruction names the
      // token, revokes the mint authority and creates the fee accounts.
      // launch_at still gates trading; it never gated naming.
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

  const dbcDraftQuote = draft
    ? enabledQuotes(String(import.meta.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta")).find(
        (q) => q.mint === ((draft as { dbcQuoteMint?: string | null }).dbcQuoteMint || WSOL_MINT),
      ) || null
    : null;
  const dbcFirstBuyEditable = Boolean(dbcDraftQuote && dbcDraftQuote.kind !== "stock");
  /** Raw first-buy amount for the launch: the field when it is editable, else the saved draft amount. */
  const dbcFirstBuyLamports = (): string => {
    if (!dbcFirstBuyEditable || !dbcDraftQuote) return String((draft as any)?.dbcFirstBuyLamports || "0");
    const n = Number(dbcFirstBuyInput);
    if (!dbcFirstBuyInput.trim() || !Number.isFinite(n) || n <= 0) return "0";
    return quoteUiToRaw(dbcFirstBuyInput, Number(dbcDraftQuote.decimals ?? 9)).toString();
  };

  // Share of supply for the typed first buy, and this creator's cap (same quote call as Create).
  const dbcLaunchDraft = isDbcLaunchEnabled() && String((draft as { launchType?: string } | undefined)?.launchType || "") === "dbc";
  useEffect(() => {
    const n = Number(dbcFirstBuyInput);
    if (!dbcLaunchDraft || !dbcFirstBuyEditable || !Number.isFinite(n) || n <= 0) {
      setDbcFirstBuyQuote(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteDbcFirstBuy({
        targetUsd: Number(graduationTargetToUsdMicros(graduationTargetWei)) / 1_000_000,
        feeChoice: (draft as any)?.dbcFeeChoice || "keep",
        creatorSharePct: (draft as any)?.dbcFeeChoice === "split" ? Number((draft as any)?.dbcCreatorSharePct) : null,
        firstBuyLamports: dbcFirstBuyLamports(),
        quoteMint: (draft as any)?.dbcQuoteMint || WSOL_MINT,
        creatorWallet: solanaWallet.solanaAccount,
      })
        .then((next) => {
          if (!cancelled) {
            setDbcFirstBuyQuote({
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbcLaunchDraft, dbcFirstBuyEditable, dbcFirstBuyInput, graduationTargetWei, draft?.id, solanaWallet.solanaAccount]);

  const deployDbc = async () => {
    if (!draft) return;
    if (dbcFirstBuyQuote?.exceedsCap) return toast.error(`The first buy cannot be more than ${dbcFirstBuyQuote.capBps / 100}% of supply.`);
    if (!solanaWallet.solanaAccount) return toast.error("Connect the draft owner Solana wallet first.");
    if (!ownerConnected) return toast.error("Only the draft owner Solana wallet can deploy this draft.");
    if (mode === "scheduled" && (!draft.scheduledLaunchAt || isScheduleLocked(new Date(launchAtInput).toISOString(), Date.now()))) {
      const at = Math.floor(new Date(launchAtInput).getTime() / 1000);
      setSubmitting(true);
      try {
        const { signWalletAction } = await import("@/lib/walletActionAuth");
        const { signSolanaMessage } = await import("@/lib/solanaWallet");
        const auth = await signWalletAction({
          action: "dbc_schedule",
          walletAddress: solanaWallet.solanaAccount,
          chainId: Number(draft.chainId),
          extraLines: [`Draft ID: ${draft.id}`],
          walletType: "solana",
          signMessage: async (message) => (await signSolanaMessage(message, solanaWallet.solanaAccount!)).signature,
        });
        await scheduleDbcDraft({
          draftId: draft.id,
          creatorWallet: solanaWallet.solanaAccount,
          auth,
          scheduledLaunchAt: at,
          targetUsd: Number(graduationTargetToUsdMicros(graduationTargetWei)) / 1_000_000,
          feeChoice: (draft as any).dbcFeeChoice || "keep",
          creatorSharePct: (draft as any).dbcCreatorSharePct,
          firstBuyLamports: dbcFirstBuyLamports(),
        });
        toast.success("Launch time saved. Nothing is created on chain until you deploy.");
        navigate(`/prepare/${draft.slug}`);
      } catch (error: any) {
        toast.error(String(error?.message || "Could not save the launch time."));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (isScheduleLocked(draft.scheduledLaunchAt, Date.now())) {
      return toast.error("Deploy is locked until the scheduled launch time.");
    }
    setSubmitting(true);
    try {
      const targetUsd = Number(graduationTargetToUsdMicros(graduationTargetWei)) / 1_000_000;
      const preflight = await preflightDbcCreate({ creatorWallet: solanaWallet.solanaAccount, targetUsd });
      if (!preflight?.preflight?.allowed) {
        throw new Error(preflight?.preflight?.cooldownActive ? "This wallet launched a coin in the last 24 hours. It can launch again after that." : "This wallet already has 3 live coins, the most one wallet can have.");
      }
      const { signWalletAction } = await import("@/lib/walletActionAuth");
      const { signSolanaMessage } = await import("@/lib/solanaWallet");
      const dbcAuth = await signWalletAction({
        action: "dbc_create",
        walletAddress: solanaWallet.solanaAccount,
        chainId: Number(draft.chainId),
        extraLines: [`Ticker: ${draft.ticker}`],
        walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, solanaWallet.solanaAccount!)).signature,
      });
      const begun = await beginDbcCreate({
        creatorWallet: solanaWallet.solanaAccount,
        ticker: draft.ticker,
        auth: dbcAuth,
        draftId: draft.id,
      });
      const web3 = await loadSolanaWeb3();
      const mint = web3.Keypair.generate();
      const authorization = await authorizeDbcCreate({
        sessionToken: begun.sessionToken,
        mint: mint.publicKey.toBase58(),
        name: draft.name,
        symbol: draft.ticker,
        description: draft.description,
        logoUrl: logoURI,
        website: draft.websiteUrl,
        x: draft.xUrl,
        targetUsd,
        feeChoice: (draft as any).dbcFeeChoice || "keep",
        creatorSharePct: (draft as any).dbcCreatorSharePct,
        firstBuyLamports: dbcFirstBuyLamports(),
        draftId: draft.id,
        quoteMint: (draft as any).dbcQuoteMint || undefined,
      });
      const created = await submitDbcCreateTransaction({
        transactionBase64: authorization.transaction,
        mintSecretKey: mint.secretKey,
        creatorAddress: solanaWallet.solanaAccount,
        pool: authorization.pool,
        mintAddress: mint.publicKey.toBase58(),
        config: authorization.config,
      });
      const finalized = await finalizeDbcCreate({ finalizeToken: authorization.finalizeToken, signature: created.signature });
      toast.success("Your coin is live.");
      navigate(finalized.tokenPath || `/token/${created.mintAddress}?chainId=101`);
    } catch (error: any) {
      toast.error(String(error?.message || "The launch did not go through. Your draft is still saved."));
    } finally {
      setSubmitting(false);
    }
  };

  const deploy = async () => {
    if (!draft) return;
    if (!DRAFT_PUSH_LIVE_ENABLED) return toast.error("Launching is temporarily unavailable. Your draft remains saved. Please try again later.");
    if (isDbcLaunchEnabled() && String((draft as any).launchType || "") === "dbc") return deployDbc();
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

      const gen6Fields = await buildEvmGen6Fields();

      if (mode === "scheduled" && scheduledLaunchAt) {
        const created = await deployScheduledDraftCampaignV2({
          signer: wallet.signer,
          auth: deployAuth,
          chainId: draft.chainId,
          factoryAddress: scheduledFactoryAddress,
          draftId: draft.id,
          launchAt: scheduledLaunchAt,
          graduationTargetWei,
          ...(gen6Fields ? { gen6: gen6Fields } : {}),
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
        ...(gen6Fields ? { gen6: gen6Fields } : {}),
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
      } else if (
        message.startsWith("Choose a trading-open time") ||
        message.startsWith("Scheduled launches cannot") ||
        (evmGen6 && /first buy|first-buy|fee choice|price feed|graduation target|signed launch/i.test(message))
      ) {
        toast.error(message);
      } else {
        toast.error(`We couldn’t deploy your campaign on ${chainLabel}. Your draft remains saved. Please try again.`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="mx-auto max-w-4xl py-20 text-center font-mw-body text-[15px] text-mw-muted">Loading draft...</div>;
  if (!draft || !bundle) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-20 text-center font-mw-body">
        <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Draft not found</h1>
        <Button asChild className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-6"><Link to="/profile?tab=drafts">Back to Drafts</Link></Button>
      </div>
    );
  }

  const dbcDraft = isDbcLaunchEnabled() && String((draft as { launchType?: string }).launchType || "") === "dbc";
  const dbcLocked = dbcDraft && isScheduleLocked(draft.scheduledLaunchAt, Date.now());
  const dbcDue = dbcDraft && Boolean(draft.scheduledLaunchAt) && !dbcLocked;
  const blocked = submitting || !DRAFT_PUSH_LIVE_ENABLED || !canPushLive(draft.status, { dbc: dbcDraft, due: dbcDue }) || (draftIsSolana ? !ownerConnected : false) || (dbcDraft && mode === "now" && dbcLocked);

  return (
    <div className="mx-auto w-full max-w-[1480px] px-1 py-8 md:px-2">
      <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 font-mw-body text-mw-text md:p-7">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Prepare Mode</div>
            <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px] mt-2">Deploy Draft</h1>
            <p className="mt-3 max-w-3xl text-[15px] text-mw-muted">
              {dbcDraft
                ? "Set a launch time (nothing is created on chain yet). When the timer ends, you launch the coin with one wallet signature."
                : "Choose the graduation tier and deploy immediately, or pay gas now and arm a countdown that blocks trading until launch time."}
            </p>
          </div>
          <Button asChild variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60">
            <Link to={`/drafts/${draft.id}/promotion`}>Back to Setup</Link>
          </Button>
        </div>

        <div className="mb-5 grid gap-4 md:grid-cols-[140px_1fr]">
          <div className="mx-auto w-full max-w-[160px] overflow-hidden rounded-[14px] border border-mw-border bg-mw-input md:max-w-none">
            <img src={logoURI || "/placeholder.svg"} alt={draft.name} className="aspect-square h-full w-full object-cover" />
          </div>
          <div className="rounded-[10px] border border-mw-border bg-mw-input p-4">
            <div className="flex flex-wrap items-center gap-2 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
              <ShieldCheck className="h-4 w-4 text-[#6EE7A0]" /> {chainLabel} · ${draft.ticker} · {draft.status.replace(/_/g, " ")}
            </div>
            <h2 className="mt-3 break-words font-mw-cond text-2xl font-bold text-mw-text">{draft.name}</h2>
            <p className="mt-2 break-words text-sm leading-6 text-mw-muted">{bundle.promotion.missionStatement || draft.description || "No mission statement saved yet."}</p>
          </div>
        </div>

        <GraduationTierSelector
          chainId={Number(draft.chainId)}
          value={graduationTargetWei}
          onChange={setGraduationTargetWei}
          disabled={submitting}
          tiers={dbcDraft ? getDbcGraduationTiers() : undefined}
        />

        {dbcDraft ? null : (
        <div className="rounded-[10px] border border-mw-border bg-mw-input mt-5 p-4">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Creator deployment eligibility</div>
          {creatorEligibility?.allowed ? (
            <div className="mt-2 space-y-1">
              <p className="text-sm text-[#6EE7A0]">Eligible to deploy or arm now.</p>
              <p className="font-mw-mono text-xs text-mw-muted">Live campaigns: {creatorEligibility.currentLiveCount} / {creatorEligibility.maxLiveBonding}</p>
            </div>
          ) : creatorEligibility ? (
            <div className="mt-2 space-y-2 text-sm text-mw-accent-soft">
              {isCreatorArmCooldownActive(creatorEligibility) ? (
                <p>Creator cooldown active. Another campaign may be deployed or armed after {formatLocalLaunch(creatorEligibility.cooldownEndsAt)} ({creatorTimeZone}).</p>
              ) : creatorEligibility.currentLiveCount >= creatorEligibility.maxLiveBonding ? (
                <p>Live campaign limit reached ({creatorEligibility.currentLiveCount} / {creatorEligibility.maxLiveBonding}).</p>
              ) : (
                <p>This creator wallet cannot deploy or arm another campaign right now.</p>
              )}
              <p className="text-xs text-mw-muted">Trading-open time does not affect arm cooldown. Arming, even with a timer, starts the 24h creator cooldown immediately.</p>
              <Button
                type="button"
                variant="outline"
                className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] px-4 text-sm font-semibold text-mw-accent-soft hover:bg-[#341B0B] hover:text-mw-accent-soft"
                onClick={() => showArmBlock(resolveCreatorArmBlock({ mode, eligibility: creatorEligibility, errorMessage: "Deployment not available for this wallet right now." }))}
              >
                Why can&apos;t I deploy?
              </Button>
            </div>
          ) : null}
          {creatorEligibilityError ? <p className="mt-2 text-sm text-mw-sell">{creatorEligibilityError}</p> : null}
        </div>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <button type="button" onClick={() => setMode("now")} className={`mw-focus rounded-[14px] border p-4 text-left ${mode === "now" ? "border-[#1F5133] bg-[#0F2418]" : "border-mw-border bg-mw-input hover:border-mw-edge"}`}>
            <div className="flex items-center gap-2 font-mw-cond text-lg font-bold text-mw-text"><Rocket className="h-4 w-4" /> Deploy now</div>
            <p className="mt-2 text-sm text-mw-muted">{dbcDraft ? "Sign once in your wallet and your coin goes live." : "Pay gas, deploy the campaign, and open trading immediately."}</p>
          </button>
          <button type="button" onClick={() => setMode("scheduled")} className={`mw-focus rounded-[14px] border p-4 text-left ${mode === "scheduled" ? "border-[#7A3A0C] bg-[#2A1609]" : "border-mw-border bg-mw-input hover:border-mw-edge"}`}>
            <div className="flex items-center gap-2 font-mw-cond text-lg font-bold text-mw-text"><Clock3 className="h-4 w-4" /> Deploy with countdown</div>
            <p className="mt-2 text-sm text-mw-muted">{dbcDraft ? "Save a launch time. The pool is created only when you deploy after that time." : "Pay gas now. The campaign is created immediately, but trading remains blocked until the selected time."}</p>
          </button>
        </div>

        {mode === "scheduled" ? (
          <div className="rounded-[10px] border border-mw-border bg-mw-input mt-4 p-4">
            <label className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{dbcDraft ? "You can launch from" : "Trading opens at"} ({creatorTimeZone})</label>
            <Input
              type="datetime-local"
              value={launchAtInput}
              onChange={(event) => setLaunchAtInput(event.target.value)}
              min={toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000))}
              max={toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))}
              className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text placeholder:text-[#5C6670] mt-2 w-full max-w-md font-mw-mono"
              disabled={submitting}
            />
            {selectedLaunchValid ? (
              <div className="mt-3 space-y-1 text-xs text-mw-muted">
                <p>Creator timezone: <span className="font-mw-mono text-mw-text">{creatorTimeZone} ({timeZoneOffset(selectedLaunchDate)})</span></p>
                <p>UTC time: <span className="font-mw-mono text-mw-text">{selectedLaunchDate.toISOString().replace("T", " ").slice(0, 16)} UTC</span></p>
                <p className="pt-1 text-mw-accent-soft">
                  {dbcDraft
                    ? "Nothing is created until you launch. At this time you get a reminder on any page of the site while your wallet is connected."
                    : "This timestamp controls only when trading opens. It is not reserved, queued, or made exclusive to this campaign."}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {dbcDraft && dbcFirstBuyEditable ? (
          <div className="mt-4" data-push-live-dbc-first-buy="true">
            <div className="text-sm font-semibold text-mw-text">Your first buy (optional)</div>
            <p className="mt-0.5 text-xs text-mw-muted">Buys in the same transaction as the launch, at the normal 2% fee. Leave empty for no first buy.</p>
            <Input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={dbcFirstBuyInput}
              onChange={(e) => setDbcFirstBuyInput(e.target.value)}
              placeholder={`${dbcDraftQuote?.symbol || "SOL"} amount`}
              className="mt-2 max-w-[12rem]"
            />
            {dbcFirstBuyQuote ? (
              <p className={`mt-1 text-xs ${dbcFirstBuyQuote.exceedsCap ? "text-mw-accent-soft" : "text-mw-muted"}`}>
                About {(Number(dbcFirstBuyQuote.bps) / 100).toFixed(2)}% of supply
                {dbcFirstBuyQuote.exceedsCap ? ` (over the ${dbcFirstBuyQuote.capBps / 100}% cap)` : ""}.
              </p>
            ) : null}
          </div>
        ) : null}

        {evmGen6 && !dbcDraft ? (
          <div className="mt-4">
            <EvmGen6LaunchOptions
              chainId={Number(draft.chainId)}
              factoryAddress={evmGen6FactoryAddress}
              graduationTarget={graduationTargetWei}
              feeChoice={evmFeeChoice}
              onFeeChoiceChange={setEvmFeeChoice}
              sharePct={evmCreatorSharePct}
              onSharePctChange={setEvmCreatorSharePct}
              firstBuyInput={evmFirstBuyInput}
              onFirstBuyInputChange={setEvmFirstBuyInput}
              initialFirstBuyTokens={evmSavedFirstBuyTokens}
            />
          </div>
        ) : null}

        {!ownerConnected ? (
          <p className="mt-4 text-sm text-mw-accent-soft">
            {draftIsSolana ? "Connect the draft owner Solana wallet (Phantom/Solflare) before deployment." : "Connect the draft owner wallet before deployment."}
          </p>
        ) : null}
        {draftIsSolana && ownerConnected ? (
          <p className="mt-4 text-sm text-mw-muted">{dbcDraft ? "Your wallet confirms one Solana transaction when you launch. The coin trades from that moment." : "Your wallet will confirm the Solana launch transaction. Trading becomes available according to the launch time you selected."}</p>
        ) : null}
        {!DRAFT_PUSH_LIVE_ENABLED ? <p className="mt-4 text-sm text-mw-accent-soft">Draft deployment is temporarily unavailable. Your draft remains saved.</p> : null}

        <Button onClick={deploy} disabled={blocked} className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-5 h-auto min-h-[54px] w-full whitespace-normal py-3 text-center text-[17px]">
          {submitting
            ? "Confirming Deployment..."
            : dbcDraft && mode === "scheduled"
              ? "Set launch time"
              : dbcDraft && dbcLocked
                ? `Launch opens ${new Date(String(draft.scheduledLaunchAt)).toLocaleString()}`
                : dbcDraft
                  ? `Launch ${getDbcGraduationTiers().find((tier) => tier.targetWei === graduationTargetWei)?.label || ""} coin now`.replace("  ", " ")
                  : mode === "scheduled"
                  ? `Deploy ${selectedTier} Countdown Campaign`
                  : `Deploy ${selectedTier} Campaign Now`}
        </Button>
      </div>
    </div>
  );
}

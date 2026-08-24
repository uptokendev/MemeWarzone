/**
 * Submit Solana V4 authorized createCampaign.
 *
 * Builds: Ed25519 verify (route-signer digest) → createCampaign (creator fee-payer).
 * Does not use the legacy solanaLaunchpadAdapter scaffold.
 */
import {
  buildSolanaCreateCampaignV4Plan,
  type SolanaV4GeneratedIdlInvocationPlan,
} from "@/lib/solanaCreateCampaignV4Plan";
import type { SolanaV4CreateAuthorizationResponse } from "@/lib/solanaCreateAuthorizationV4";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import {
  buildCreateCampaignInstruction,
  buildLaunchpadEd25519Instruction,
} from "@/lib/solanaLaunchpadInstructions";
import {
  assertLaunchpadV0Intent,
  buildLaunchpadAltPlan,
  compileLaunchpadV0WithLatestBlockhash,
  fetchAndVerifyLaunchpadLookupTable,
  requireLaunchpadAltAddress,
  simulateLaunchpadV0OrThrow,
} from "@/lib/solanaV0Transaction";
import {
  CREATE_EXPIRED_BEFORE_CONFIRMATION,
  LaunchpadSignatureExpiredError,
  LaunchpadSignatureUnconfirmedError,
  confirmLaunchpadSignature,
  isLaunchpadBlockhashError,
} from "@/lib/solanaConfirmSignature";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_CREATE_LAMPORTS = 30_000_000; // conservative balance guard / fallback only
const CREATE_RENT_ACCOUNT_SIZES = [720, 82, 165, 81, 155] as const;
const CREATOR_PROFILE_ACCOUNT_BYTES = 84;

export type SolanaV4CreateSubmitResult = {
  signature: string;
  campaignAddress: string;
  mintAddress: string;
  programId: string;
  plan: SolanaV4GeneratedIdlInvocationPlan | null;
  recovered?: boolean;
};

export type SolanaV4CreatePreflightPreview = {
  walletBalanceLamports: number;
  serializedBytes: number;
  instructionCount: number;
  unitsConsumed: number | null;
  estimatedFeeLamports: number | null;
  estimatedRentLamports: number | null;
  estimatedDeploymentLamports: number;
  estimateSource: "rpc-fee+rent" | "conservative-fallback";
};

export type SolanaV4CreateSubmitOptions = {
  creatorAddress?: string;
  onPreflightReady?: (preview: SolanaV4CreatePreflightPreview) => void | Promise<void>;
};

/**
 * Authorize response → wallet-signed V4 create transaction.
 */
export async function submitSolanaV4CreateFromAuthorization(
  authorization: SolanaV4CreateAuthorizationResponse,
  opts?: SolanaV4CreateSubmitOptions,
): Promise<SolanaV4CreateSubmitResult> {
  // Recovery: campaign PDA already exists for this draft (create succeeded earlier).
  if (authorization.alreadyOnChain || authorization.existingDeployment) {
    const campaignAddress =
      authorization.existingDeployment?.campaignAddress || authorization.accounts.campaign;
    const mintAddress = authorization.existingDeployment?.mintAddress || authorization.accounts.mint;
    return {
      signature: "already-on-chain",
      campaignAddress,
      mintAddress,
      programId: authorization.programId,
      plan: null as unknown as SolanaV4GeneratedIdlInvocationPlan,
      recovered: true,
    };
  }

  const plan = buildSolanaCreateCampaignV4Plan(authorization);
  return submitSolanaV4CreatePlan(plan, opts);
}

export async function submitSolanaV4CreatePlan(
  plan: SolanaV4GeneratedIdlInvocationPlan,
  opts?: SolanaV4CreateSubmitOptions,
): Promise<SolanaV4CreateSubmitResult> {
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet that can sign transactions (e.g. Phantom).");
  }

  const creatorPk = String(provider.publicKey.toString?.() || provider.publicKey || "");
  if (opts?.creatorAddress && creatorPk && opts.creatorAddress !== creatorPk) {
    // base58 is case-sensitive — do not lowercase
    if (String(opts.creatorAddress).trim() !== creatorPk) {
      throw new Error("Connected Solana wallet does not match the draft creator.");
    }
  }
  if (plan.createCampaign.accounts.creator && plan.createCampaign.accounts.creator !== creatorPk) {
    throw new Error("Authorization creator account does not match the connected Solana wallet.");
  }

  const web3 = await loadSolanaWeb3();
  const { Connection, PublicKey } = web3;
  const rpc =
    String(import.meta.env.VITE_SOLANA_RPC || "").trim() ||
    getPublicRpcUrl(SOLANA_CHAIN_ID) ||
    "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const campaignPk = new PublicKey(plan.createCampaign.accounts.campaign);
  const mintPk = new PublicKey(plan.createCampaign.accounts.mint);
  const programPk = new PublicKey(plan.programId);

  // Preflight: deterministic PDAs may already exist from a prior successful create
  // that failed to mark the draft (would otherwise sim-fail with InvalidCampaign).
  // Create order is mint → vault → campaign; catch mint-only partials too.
  const existing = await connection.getMultipleAccountsInfo([campaignPk, mintPk], "confirmed");
  if (existing[0] && existing[0].owner.equals(programPk)) {
    return {
      signature: "already-on-chain",
      campaignAddress: plan.createCampaign.accounts.campaign,
      mintAddress: plan.createCampaign.accounts.mint,
      programId: plan.programId,
      plan,
      recovered: true,
    };
  }
  if (existing[1] && existing[1].owner.equals(new PublicKey(TOKEN_PROGRAM))) {
    throw new Error(
      "Solana create blocked: mint PDA already exists but campaign account is empty (partial prior create). " +
        "Retry will keep failing — use a new draft or ask ops to reclaim the mint PDA.",
    );
  }

  const ed25519Ix = buildLaunchpadEd25519Instruction(web3, plan.ed25519Verification);
  const createIx = buildCreateCampaignInstruction(web3, {
    programId: plan.programId,
    args: plan.createCampaign.args,
    accounts: plan.createCampaign.accounts,
  });
  const createInstructions = [ed25519Ix, createIx];
  const lookupTable = await fetchAndVerifyLaunchpadLookupTable(web3, connection, {
    address: requireLaunchpadAltAddress(),
    requiredAddresses: buildLaunchpadAltPlan(web3).map((entry) => entry.address),
  });
  const v0Input = {
    payer: creatorPk,
    instructions: createInstructions,
    lookupTableAccounts: [lookupTable],
  };
  const v0Expectation = {
    payer: creatorPk,
    ed25519Instruction: ed25519Ix,
    programInstruction: createIx,
    lookupTableAccounts: [lookupTable],
  };

  const balance = await connection.getBalance(new PublicKey(creatorPk), "confirmed");
  if (balance < MIN_CREATE_LAMPORTS) {
    throw new Error(
      `Not enough SOL to deploy this campaign. Need about 0.03 SOL for rent; this wallet has ${(balance / 1_000_000_000).toFixed(4)} SOL.`,
    );
  }

  const compileUnsignedCreate = () =>
    compileLaunchpadV0WithLatestBlockhash(web3, connection, v0Input, v0Expectation);

  const simulateUnsignedCreate = async (
    unsigned: Awaited<ReturnType<typeof compileUnsignedCreate>>,
  ) => {
    const simulated = await simulateLaunchpadV0OrThrow(
      connection,
      unsigned.transaction,
      "Solana create blocked before wallet signing",
    );
    console.info("[solanaV4CreateSubmit] unsigned create simulation passed", {
      serializedBytes: unsigned.stats.serializedBytes,
      unitsConsumed: simulated.unitsConsumed,
      instructionCount: unsigned.stats.instructionCount,
      requiredWalletSigners: unsigned.stats.requiredSigners,
    });
    return {
      serializedBytes: unsigned.stats.serializedBytes,
      unitsConsumed: simulated.unitsConsumed,
      instructionCount: unsigned.stats.instructionCount,
    };
  };

  const estimateDeploymentCost = async (
    unsigned: Awaited<ReturnType<typeof compileUnsignedCreate>>,
    simulation: { serializedBytes: number; unitsConsumed: number | null; instructionCount: number },
  ): Promise<SolanaV4CreatePreflightPreview> => {
    let estimatedFeeLamports: number | null = null;
    try {
      const fee = await connection.getFeeForMessage(unsigned.transaction.message, "confirmed");
      estimatedFeeLamports = typeof fee.value === "number" ? fee.value : null;
    } catch (error) {
      console.warn("[solanaV4CreateSubmit] fee estimate unavailable", error);
    }

    let estimatedRentLamports: number | null = null;
    try {
      const sizes: number[] = [...CREATE_RENT_ACCOUNT_SIZES];
      const creatorProfilePk = new PublicKey(plan.createCampaign.accounts.creatorProfile);
      const creatorProfileInfo = await connection.getAccountInfo(creatorProfilePk, "confirmed");
      if (!creatorProfileInfo) sizes.push(CREATOR_PROFILE_ACCOUNT_BYTES);
      const rents = await Promise.all(sizes.map((size) => connection.getMinimumBalanceForRentExemption(size, "confirmed")));
      estimatedRentLamports = rents.reduce((sum, lamports) => sum + lamports, 0);
    } catch (error) {
      console.warn("[solanaV4CreateSubmit] rent estimate unavailable", error);
    }

    const precise = estimatedFeeLamports != null && estimatedRentLamports != null;
    const preview: SolanaV4CreatePreflightPreview = {
      walletBalanceLamports: balance,
      serializedBytes: simulation.serializedBytes,
      instructionCount: simulation.instructionCount,
      unitsConsumed: simulation.unitsConsumed,
      estimatedFeeLamports,
      estimatedRentLamports,
      estimatedDeploymentLamports: precise ? estimatedFeeLamports + estimatedRentLamports : MIN_CREATE_LAMPORTS,
      estimateSource: precise ? "rpc-fee+rent" : "conservative-fallback",
    };
    console.info("[solanaV4CreateSubmit] deployment preflight ready", {
      ...preview,
      estimatedDeploymentSol: preview.estimatedDeploymentLamports / LAMPORTS_PER_SOL,
    });
    return preview;
  };

  let preflightPreviewShown = false;
  let sentSignature: string | null = null;
  const signAndSend = async () => {
    const preflight = await compileUnsignedCreate();
    const simulation = await simulateUnsignedCreate(preflight);
    const preview = await estimateDeploymentCost(preflight, simulation);
    if (!preflightPreviewShown && opts?.onPreflightReady) {
      await opts.onPreflightReady(preview);
      preflightPreviewShown = true;
    }
    const unsigned = await compileUnsignedCreate();
    await simulateUnsignedCreate(unsigned);
    const signed = await provider.signTransaction(unsigned.transaction);
    assertLaunchpadV0Intent(web3, signed, {
      ...v0Expectation,
      // The unsigned transaction must remain below our conservative 1000-byte
      // release gate. Wallets such as Phantom may safely append wallet-side
      // protection / priority instructions after signing. For the returned
      // transaction enforce the real Solana packet limit instead while still
      // validating payer, signer count, MWZ intent and Ed25519 adjacency.
      releaseMaxBytes: null,
    });
    const raw = typeof signed?.serialize === "function" ? signed.serialize() : signed;
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    sentSignature = signature;
    const confirmed = await confirmLaunchpadSignature(connection, {
      signature,
      lastValidBlockHeight: unsigned.latest.lastValidBlockHeight,
      recover: async () => {
        const again = await connection.getAccountInfo(campaignPk, "confirmed");
        return Boolean(again && again.owner.equals(programPk));
      },
    });
    if (confirmed.err) {
      const logs = await fetchTransactionLogs(connection, signature);
      throw Object.assign(new Error("Solana create transaction failed on-chain."), {
        logs,
        simulationErr: confirmed.err,
      });
    }
    return signature;
  };

  const recoverIfLanded = async (knownSignature?: string | null) => {
    if (knownSignature) {
      try {
        const status = await connection.getSignatureStatuses([knownSignature], {
          searchTransactionHistory: true,
        });
        const value = status?.value?.[0];
        if (!value?.err && (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized")) {
          return {
            signature: knownSignature,
            campaignAddress: plan.createCampaign.accounts.campaign,
            mintAddress: plan.createCampaign.accounts.mint,
            programId: plan.programId,
            plan,
            recovered: true as const,
          };
        }
        const tx = await connection.getTransaction(knownSignature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (tx && !tx.meta?.err) {
          return {
            signature: knownSignature,
            campaignAddress: plan.createCampaign.accounts.campaign,
            mintAddress: plan.createCampaign.accounts.mint,
            programId: plan.programId,
            plan,
            recovered: true as const,
          };
        }
      } catch {
        // Fall through to campaign PDA ownership.
      }
    }
    const again = await connection.getAccountInfo(campaignPk, "confirmed");
    if (again && again.owner.equals(programPk)) {
      return {
        signature: knownSignature || ("already-on-chain" as const),
        campaignAddress: plan.createCampaign.accounts.campaign,
        mintAddress: plan.createCampaign.accounts.mint,
        programId: plan.programId,
        plan,
        recovered: true as const,
      };
    }
    return null;
  };

  let signature: string;
  try {
    signature = await signAndSend();
  } catch (error: unknown) {
    const recovered = await recoverIfLanded(sentSignature);
    if (recovered) return recovered;
    if (error instanceof LaunchpadSignatureExpiredError) {
      throw new Error(CREATE_EXPIRED_BEFORE_CONFIRMATION);
    }
    if (error instanceof LaunchpadSignatureUnconfirmedError) {
      throw error;
    }
    const msg = await formatSolanaSendError(error);
    // A signature that left the wallet must not be rebuilt — that would prompt Phantom twice.
    if (sentSignature || !(isLaunchpadBlockhashError(error) || isLaunchpadBlockhashError(msg))) {
      throw new Error(msg);
    }
    try {
      signature = await signAndSend();
    } catch (retryError: unknown) {
      const recoveredRetry = await recoverIfLanded(sentSignature);
      if (recoveredRetry) return recoveredRetry;
      if (retryError instanceof LaunchpadSignatureExpiredError) {
        throw new Error(CREATE_EXPIRED_BEFORE_CONFIRMATION);
      }
      throw new Error(await formatSolanaSendError(retryError));
    }
  }

  return {
    signature,
    campaignAddress: plan.createCampaign.accounts.campaign,
    mintAddress: plan.createCampaign.accounts.mint,
    programId: plan.programId,
    plan,
  };
}

async function fetchTransactionLogs(
  connection: { getTransaction: Function },
  signature: string,
): Promise<string[]> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
  } catch {
    return [];
  }
}

const LAUNCHPAD_ERROR_BY_CODE: Record<number, { name: string; hint: string }> = {
  6000: { name: "Unauthorized", hint: "The signer is not authorized for this launchpad action." },
  6015: { name: "InvalidCreatorProfile", hint: "Creator profile data is invalid or the PDA is leftover from a failed create." },
  6021: { name: "LaunchpadPaused", hint: "The Solana launchpad is paused on-chain." },
  6022: { name: "CreatePaused", hint: "Solana campaign creation is paused on-chain." },
  6023: { name: "InvalidCreateAuthorization", hint: "Route digest mismatch, expired auth, or Ed25519 verify is not immediately before CreateCampaign." },
  6024: { name: "CreateAuthorizationExpired", hint: "The create authorization deadline expired. Retry Push Live to get a fresh signature." },
  6025: { name: "InvalidCampaign", hint: "Campaign/mint/vault data is invalid — often a partial prior create or a bad launch time." },
  6026: { name: "InvalidMetadata", hint: "Campaign metadata hash is missing or invalid." },
  6027: { name: "GraduationTargetNotAllowed", hint: "This graduation target is not allowed by the active mainnet generation." },
  6029: { name: "InvalidNonce", hint: "Create authorization nonce is invalid. Retry Push Live." },
  6030: { name: "CampaignGenerationInactive", hint: "The selected generation is not active for campaign creation." },
  6031: { name: "CreatorLaunchLimitExceeded", hint: "This wallet already has the maximum live bonding campaigns." },
  6032: { name: "CreatorCooldownActive", hint: "Creator launch cooldown is still active. If a prior create landed, retry Push Live for recovery." },
  6033: { name: "CreatorRestricted", hint: "This creator is restricted from launching campaigns." },
  6037: { name: "MathOverflow", hint: "Arithmetic overflow while creating the campaign." },
  2006: { name: "ConstraintSeeds", hint: "A PDA address does not match the program seeds (wrong campaign id, nonce, or account order)." },
  2003: { name: "ConstraintMut", hint: "An account that must be writable was passed read-only." },
  3007: { name: "AccountOwnedByWrongProgram", hint: "An account is owned by the wrong program — leftover mint/vault from a partial create." },
};

function collectEmbeddedLogs(message: string): string[] {
  const logs: string[] = [];
  const quoted = message.matchAll(/"(Program[^"]+)"/g);
  for (const match of quoted) logs.push(match[1]);
  const raw = message.matchAll(/Program log: [^\n]+/g);
  for (const match of raw) logs.push(match[0]);
  return logs;
}

async function collectSolanaLogs(error: unknown): Promise<{ message: string; logs: string[] }> {
  const anyErr = error as {
    message?: string;
    logs?: string[];
    getLogs?: () => string[] | Promise<string[]>;
  };
  const message = String(anyErr?.message || error || "Solana transaction failed.");
  const logs = [...(Array.isArray(anyErr?.logs) ? anyErr.logs : []), ...collectEmbeddedLogs(message)];
  if (typeof anyErr?.getLogs === "function") {
    try {
      const extra = await anyErr.getLogs();
      if (Array.isArray(extra)) logs.push(...extra.map(String));
    } catch {
      // Keep whatever we already parsed from the message.
    }
  }
  return { message, logs: Array.from(new Set(logs)) };
}

function explainCustomProgramError(source: string): string | null {
  const hex = source.match(/custom program error:\s*(0x[0-9a-f]+)/i)?.[1];
  const dec = source.match(/Error Number:\s*(\d+)/i)?.[1];
  const code = hex ? Number.parseInt(hex, 16) : dec ? Number(dec) : NaN;
  if (!Number.isFinite(code)) return null;
  const mapped = LAUNCHPAD_ERROR_BY_CODE[code];
  if (!mapped) return `custom program error ${hex || code}`;
  return `${mapped.name} (${hex || code}): ${mapped.hint}`;
}

/** Collapse wallet/RPC simulation dumps into a short operator-readable message. */
async function formatSolanaSendError(error: unknown): Promise<string> {
  const { message, logs } = await collectSolanaLogs(error);
  const combined = `${logs.join("\n")}\n${message}`;
  try {
    console.error("[solanaV4CreateSubmit] create failed", { message, logs });
  } catch {
    // ignore console failures
  }

  const explained = explainCustomProgramError(combined);
  if (/Access violation|stack frame|Program failed to complete/i.test(combined)) {
    return "Solana create blocked before signing: the deployed program hit a BPF execution/stack failure. Do not approve or deploy this transaction.";
  }
  if (isLaunchpadBlockhashError(combined)) {
    return "Solana create failed: the wallet took too long and the transaction blockhash expired. Approve the next Phantom popup quickly after MemeWarzone simulation passes.";
  }
  if (/InvalidCreateAuthorization/i.test(combined) || explained?.startsWith("InvalidCreateAuthorization")) {
    return "Solana create failed (InvalidCreateAuthorization): route digest mismatch, expired auth, or Ed25519 is not immediately before CreateCampaign. Retry Push Live.";
  }
  if (/CreatorCooldownActive/i.test(combined) || explained?.startsWith("CreatorCooldownActive")) {
    return "Solana create failed: creator launch cooldown is active on-chain. If a prior create already landed, retry Push Live for recovery.";
  }
  if (/CreatePaused|LaunchpadPaused/i.test(combined) || explained?.startsWith("CreatePaused") || explained?.startsWith("LaunchpadPaused")) {
    return "Solana create failed: creation is paused on-chain.";
  }
  if (/GraduationTargetNotAllowed/i.test(combined) || explained?.startsWith("GraduationTargetNotAllowed")) {
    return "Solana create failed: that graduation target is not allowed on this mainnet generation.";
  }
  if (/ConstraintSeeds/i.test(combined) || explained?.startsWith("ConstraintSeeds")) {
    return "Solana create failed (ConstraintSeeds): a PDA does not match the program seeds. Retry Push Live; if it persists the authorize payload and wallet accounts are out of sync.";
  }
  if (/insufficient lamports/i.test(combined)) {
    return "Solana create failed: wallet does not have enough SOL to rent the campaign / mint / vault accounts.";
  }

  const usefulLog = logs.find((line) =>
    /AnchorError|Error Code:|Error Message:|custom program error|failed:|insufficient lamports/i.test(line)
    && !/Instruction:\s*CreateCampaign/i.test(line),
  );
  if (usefulLog) {
    const code = usefulLog.match(/Error Code:\s*([A-Za-z0-9_]+)/i)?.[1];
    const msg = usefulLog.match(/Error Message:\s*([^.]+)/i)?.[1];
    const account = usefulLog.match(/account:\s*([A-Za-z0-9_]+)/i)?.[1];
    const parts = ["Solana create failed"];
    if (code) parts.push(code);
    if (account) parts.push(`account ${account}`);
    if (msg) parts.push(msg.trim());
    else if (explained) parts.push(explained);
    else parts.push(usefulLog.replace(/^Program log:\s*/i, "").trim());
    return parts.join(" — ");
  }

  if (explained) return `Solana create failed — ${explained}`;

  if (/AccountDiscriminatorMismatch/i.test(combined)) {
    return "Solana create failed: on-chain account layout does not match the deployed program (AccountDiscriminatorMismatch).";
  }
  if (/Simulation failed/i.test(message)) {
    const short = message.split(/Logs:/i)[0]?.trim() || message;
    return short.length > 280 ? `${short.slice(0, 277)}...` : short;
  }
  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

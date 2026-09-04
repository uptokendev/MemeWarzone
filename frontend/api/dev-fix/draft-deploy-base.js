import { ethers } from "ethers";
import { badMethod, isAddress, isSolanaChain, normalizeAddress as normalizeAddressBase, json, readJson } from "../../server/http.js";
import { requireDraftActionAuth } from "./draft-auth.js";
import { notifyDraftOwner, notifyDraftSubscribers } from "./prepare-notify.js";
import { evaluateCreatePreflight } from "./security-current-time.js";
import { getRouteDecision } from "./route-decision.js";
import { logRouteAuthorization } from "./route-auth-log.js";
import {
  assertSupportedGenerations,
  generationRule,
  signScheduledCreateAuthorization,
} from "./routeAuthorizationSigner.js";
import {
  TickerReservationError,
  authorizeScheduledTickerReservation,
  isTickerReservationConflict,
  markTickerReservationDeployed,
  promoteTickerReservation,
  withTickerReservationTransaction,
} from "./ticker-reservation-service.js";
import { upsertCampaignFromDraft } from "./campaign-registry.js";

const MIN_SCHEDULE_SECONDS = 5 * 60;
const MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
const WAD = 10n ** 18n;
const STANDARD_TARGETS = new Set([
  (15_000n * WAD).toString(),
  (30_000n * WAD).toString(),
  (50_000n * WAD).toString(),
]);
const TEST_TARGET = (6n * WAD).toString();

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value, chainId) {
  if (normalizeAddressBase) return normalizeAddressBase(value, chainId);
  const raw = String(value || "").trim().toLowerCase();
  return isAddress(raw) ? raw : "";
}

function isDraftPushLiveEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.DRAFT_PUSH_LIVE_ENABLED || process.env.ENABLE_DRAFT_PUSH_LIVE || process.env.VITE_DRAFT_PUSH_LIVE_ENABLED || "")
      .trim()
      .toLowerCase(),
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readVerifiedGenerations(chainId, body) {
  const factoryGeneration = Number(body?.onChainPreflight?.factoryGeneration || 0);
  const campaignGeneration = Number(body?.onChainPreflight?.campaignGeneration || 0);
  try {
    const { factoryGen, campaignGen } = assertSupportedGenerations(chainId, factoryGeneration, campaignGeneration);
    return { factoryGeneration: factoryGen, campaignGeneration: campaignGen };
  } catch (error) {
    throw new Error(
      `Verified on-chain factory generation is required before scheduled authorization; ` +
        `chain ${chainId} requires ${generationRule(chainId)}, ` +
        `got ${factoryGeneration}/${campaignGeneration}.`,
    );
  }
}

function normalizeTarget(chainId, value) {
  let target;
  try {
    target = BigInt(String(value ?? 0)).toString();
  } catch {
    throw new Error("graduationTarget must be a uint-compatible value");
  }
  if (STANDARD_TARGETS.has(target)) return target;
  const testEnabled = isTruthy(
    process.env.VITE_ENABLE_TEST_GRADUATION_THRESHOLD || process.env.ENABLE_TEST_GRADUATION_THRESHOLD || "true",
  );
  const cid = Number(chainId);
  // $6 test threshold: EVM testnets + Solana development generations.
  if (testEnabled && (cid === 97 || cid === 46630 || cid === 101 || cid === 102) && target === TEST_TARGET) return target;
  throw new Error("Unsupported graduation target");
}

function getRouteSigner() {
  const key = String(
    process.env.ROUTE_AUTHORITY_PRIVATE_KEY ||
      process.env.MWZ_ROUTE_AUTHORITY_PRIVATE_KEY ||
      process.env.ROUTE_AUTH_PRIVATE_KEY ||
      "",
  ).trim();
  if (!key) return null;
  try {
    return new ethers.Wallet(key);
  } catch {
    return null;
  }
}

async function getPool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (err) {
    console.warn("[draft-deploy] DB unavailable", err?.message || err);
    return null;
  }
}

function mapDraftRow(row) {
  if (!row) return null;
  const draftChainId = Number(row.chain_id ?? 97);
  const rawCreator = String(row.creator_wallet || row.creatorWallet || "");
  return {
    id: String(row.id),
    chainId: draftChainId,
    creatorWallet: isSolanaChain(draftChainId) ? rawCreator : rawCreator.toLowerCase(),
    name: String(row.name || ""),
    ticker: String(row.ticker || ""),
    description: row.description || null,
    category: row.category || "meme",
    logoUrl: row.logo_url ?? null,
    websiteUrl: row.website_url ?? null,
    xUrl: row.x_url ?? null,
    otherUrl: row.other_url ?? null,
    slug: String(row.slug || ""),
    status: String(row.status || "draft"),
    visibility: String(row.visibility || "private"),
    campaignAddress: row.campaign_address ?? null,
    tokenAddress: row.token_address ?? null,
    deployTxHash: row.deploy_tx_hash ?? null,
    scheduledLaunchAt: row.scheduled_launch_at ?? null,
    archivedAt: row.archived_at ?? null,
    deployedAt: row.deployed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value ?? "")));
}

async function authorizeScheduledLaunch({ body, row, pool, draftId, res }) {
  const routeSigner = getRouteSigner();
  if (!routeSigner) return json(res, 503, { error: "Route authorization signer is not configured." });

  const chainId = Number(row.chain_id);
  const walletAddress = normalizeAddress(body.auth?.walletAddress || body.walletAddress, chainId);
  const factoryAddress = normalizeAddress(body.factoryAddress, chainId);
  const launchAt = Number(body.launchAt || 0);
  const now = Math.floor(Date.now() / 1000);

  if (!walletAddress || !factoryAddress) return json(res, 400, { error: "Missing wallet or factory address." });
  if (!Number.isInteger(launchAt) || launchAt < now + MIN_SCHEDULE_SECONDS || launchAt > now + MAX_SCHEDULE_SECONDS) {
    return json(res, 400, { error: "Launch time must be at least five minutes in the future and no more than 30 days away." });
  }
  if (row.campaign_address) return json(res, 409, { error: "This draft already has an on-chain campaign." });
  if (!["promotion_published", "ready_to_launch"].includes(String(row.status))) {
    return json(res, 409, { error: "Publish the promotion page before scheduling launch." });
  }
  if (!String(row.logo_url || "").trim()) return json(res, 409, { error: "Draft requires a saved logo before launch." });

  let generations;
  try {
    generations = readVerifiedGenerations(chainId, body);
  } catch (error) {
    return json(res, 409, { error: error.message, code: "SCHEDULED_CREATE_GENERATION_NOT_VERIFIED" });
  }
  const { factoryGeneration, campaignGeneration } = generations;

  let graduationTarget;
  try {
    graduationTarget = normalizeTarget(chainId, body.graduationTargetWei);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const campaign = {
    name: String(row.name || ""),
    symbol: String(row.ticker || "").toUpperCase(),
    logoURI: String(row.logo_url || ""),
    xAccount: String(row.x_url || ""),
    website: String(row.website_url || ""),
    extraLink: String(row.other_url || ""),
    graduationTarget,
  };

  // The creator cooldown applies to this irreversible arm/deploy action now.
  // launchAt remains an immutable signed trading-open timestamp, but it must
  // never be used to evaluate or bypass the current creator cooldown.
  const preflight = await evaluateCreatePreflight({ walletAddress });
  if (!preflight.allowed) {
    return json(res, 403, {
      error: preflight.reasons?.[0] || "This creator wallet cannot arm another campaign yet.",
      code: "CREATE_PREFLIGHT_BLOCKED",
      preflight,
    });
  }

  const { tradeRouteProfileId, finalizeRouteProfileId, decision } = await getRouteDecision(walletAddress);
  const normalizedTickerHash = hashText(campaign.symbol);
  const metadataHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32"],
      [hashText(campaign.logoURI), hashText(campaign.xAccount), hashText(campaign.website), hashText(campaign.extraLink)],
    ),
  );
  const deadline = now + 10 * 60;
  const validUntil = new Date(deadline * 1000).toISOString();

  try {
    // Published drafts created before the canonical reservation migration may
    // legitimately have no reservation row yet. The owner-authenticated deploy
    // path repairs that state transactionally before binding the authorization.
    await withTickerReservationTransaction(pool, async (db) => {
      await promoteTickerReservation(db, {
        draftId,
        creatorWallet: walletAddress,
        chainId,
        cluster: body.cluster || body.reservationCluster || "",
        ticker: campaign.symbol,
        publishedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
      });
    });

    const canonical = await authorizeScheduledTickerReservation(pool, {
      draftId,
      creatorWallet: walletAddress,
      launchAt,
      buildAuthorization: async (reservation) => {
        const draftReferenceHash = `0x${reservation.reservationIdHash}`;
        const reservationVersion = reservation.reservationVersion;
        const authorizationNonce = BigInt(reservation.authorizationNonce);
        const scheduledRequest = {
          campaign,
          launchAt,
          draftReferenceHash,
          normalizedTickerHash,
          metadataHash,
          reservationId: reservation.id,
          reservationIdHash: reservation.reservationIdHash,
          reservationVersion,
          authorizationNonce: authorizationNonce.toString(),
        };
        const signature = await signScheduledCreateAuthorization({
          signer: routeSigner,
          chainId,
          factoryAddress,
          creator: walletAddress,
          request: scheduledRequest,
          launchAt,
          draftReferenceHash,
          normalizedTickerHash,
          metadataHash,
          reservationVersion,
          authorizationNonce,
          factoryGeneration,
          campaignGeneration,
          tradeRouteProfileId,
          finalizeRouteProfileId,
          deadline,
        });
        return {
          scheduledRequest,
          authorization: {
            tradeRouteProfileId,
            finalizeRouteProfileId,
            factoryGeneration,
            campaignGeneration,
            validUntil,
            signature,
          },
        };
      },
    });

    await logRouteAuthorization({
      chainId,
      walletAddress,
      routeKind: "scheduled_create",
      routeProfileId: tradeRouteProfileId,
      finalizeRouteProfileId,
      factoryAddress,
      decision,
      routeAuthority: routeSigner.address,
      authorizationDeadline: deadline,
      validUntil,
      metadata: {
        endpoint: `/api/drafts/${draftId}/deploy`,
        operation: "authorize_scheduled",
        scheduledRequest: canonical.scheduledRequest,
        tickerReservation: canonical.reservation,
        preflight,
        factoryGeneration,
        campaignGeneration,
      },
    });

    return json(res, 200, {
      scheduledRequest: canonical.scheduledRequest,
      authorization: canonical.authorization,
      tickerReservation: canonical.reservation,
      preflight: { ...preflight, factoryGeneration, campaignGeneration },
    });
  } catch (error) {
    if (error instanceof TickerReservationError || isTickerReservationConflict(error)) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function draftDeploy(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  if (!isDraftPushLiveEnabled()) {
    return json(res, 403, {
      error: "Push Live is locked until the platform launch switch is enabled.",
      code: "DRAFT_PUSH_LIVE_LOCKED",
    });
  }

  const draftId = String(req.params?.draftId || "");
  const body = await readJson(req);
  const pool = await getPool();
  if (!pool) return json(res, 503, { error: "Draft deploy requires DATABASE_URL-backed wallet auth." });

  const existing = await pool.query(
    `select id, creator_wallet, chain_id, status, ticker, slug, name, logo_url, website_url, x_url, other_url,
            campaign_address, token_address, created_at, updated_at
       from campaign_drafts
      where id::text = $1
      limit 1`,
    [draftId],
  );
  if (!existing.rows.length) return json(res, 404, { error: "Draft not found" });

  const row = existing.rows[0];
  if (row.status === "archived") return json(res, 409, { error: "Archived drafts cannot be pushed live." });

  const ok = await requireDraftActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: row.creator_wallet,
    chainId: Number(row.chain_id),
    action: "deploy_draft",
    draftId,
  });
  if (!ok) return;

  if (body.operation === "authorize_scheduled") {
    return authorizeScheduledLaunch({ body, row, pool, draftId, res });
  }

  const campaignAddress = normalizeAddress(body.campaignAddress, Number(row.chain_id));
  const tokenAddress = normalizeAddress(body.tokenAddress, Number(row.chain_id));
  const deployTxHash = String(body.deployTxHash || "").trim().slice(0, 120) || null;
  const scheduledLaunchAt = body.scheduledLaunchAt ? Number(body.scheduledLaunchAt) : null;
  const isScheduled = Number.isInteger(scheduledLaunchAt) && scheduledLaunchAt > Math.floor(Date.now() / 1000);
  // Solana V4 vaults / campaignId — optional; stored in campaigns.meta.solana for trade-authorize.
  const solanaVaults = isSolanaChain(Number(row.chain_id))
    ? {
        tokenVault: body.tokenVault ? String(body.tokenVault).trim() : null,
        solVault: body.solVault ? String(body.solVault).trim() : null,
        campaignId: body.campaignId ?? body.campaignIdHex ?? null,
        programId: String(body.factoryAddress || body.programId || "").trim() || null,
      }
    : null;

  if (!campaignAddress) return json(res, 400, { error: "Missing deployed campaign address." });

  // Idempotent mark: draft already linked to this same campaign (re-try after partial mark).
  const existingCampaign = String(row.campaign_address || "").trim();
  if (existingCampaign) {
    const sameCampaign = isSolanaChain(Number(row.chain_id))
      ? existingCampaign === campaignAddress
      : existingCampaign.toLowerCase() === String(campaignAddress).toLowerCase();
    if (!sameCampaign) {
      return json(res, 409, {
        error: "This draft already has an on-chain campaign.",
        code: "DRAFT_ALREADY_DEPLOYED",
      });
    }
    try {
      const redeployed = await withTickerReservationTransaction(pool, async (db) => {
        const updated = await db.query(
          `update campaign_drafts
              set status = case
                    when $4::bigint is not null then 'scheduled'
                    when status in ('deployed', 'scheduled', 'live') then status
                    else 'deployed'
                  end,
                  visibility = 'public',
                  token_address = coalesce($3, token_address),
                  deploy_tx_hash = coalesce(deploy_tx_hash, $5),
                  deployed_at = coalesce(deployed_at, now()),
                  updated_at = now()
            where id::text = $1
            returning *`,
          [
            draftId,
            existingCampaign,
            tokenAddress || null,
            isScheduled ? scheduledLaunchAt : null,
            deployTxHash || "already-on-chain",
          ],
        );
        let tickerReservation = null;
        try {
          tickerReservation = await markTickerReservationDeployed(db, {
            draftId,
            creatorWallet: row.creator_wallet,
            campaignAddress: existingCampaign,
            mint: tokenAddress || null,
            deploymentSignature: deployTxHash || "already-on-chain",
            scheduledLaunchAt: isScheduled ? scheduledLaunchAt : null,
            programId: String(body.factoryAddress || "").trim() || null,
            generationId: body.generationId == null ? null : String(body.generationId),
          });
        } catch (err) {
          if (!(err instanceof TickerReservationError)) throw err;
        }
        const draft = mapDraftRow(updated.rows[0]);
        const registry = await upsertCampaignFromDraft(db, {
          chainId: Number(row.chain_id),
          campaignAddress: existingCampaign,
          tokenAddress: tokenAddress || draft?.tokenAddress || null,
          creatorWallet: row.creator_wallet,
          name: row.name || draft?.name,
          symbol: row.ticker || draft?.ticker,
          logoUrl: row.logo_url || draft?.logoUrl,
          deployTxHash: deployTxHash || "already-on-chain",
          factoryAddress: String(body.factoryAddress || "").trim() || null,
          ...(solanaVaults || {}),
        });
        return { draft, tickerReservation, registry };
      });
      return json(res, 200, {
        ok: true,
        alreadyDeployed: true,
        draft: redeployed.draft,
        tickerReservation: redeployed.tickerReservation,
        registryUpserted: Boolean(redeployed.registry?.ok),
        registryError: redeployed.registry?.ok ? null : redeployed.registry?.error || null,
        registryMetaMerged: Boolean(redeployed.registry?.metaMerged),
      });
    } catch (error) {
      if (error instanceof TickerReservationError || isTickerReservationConflict(error)) {
        return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
      }
      throw error;
    }
  }

  let deployed;
  try {
    deployed = await withTickerReservationTransaction(pool, async (db) => {
      const updated = await db.query(
        `update campaign_drafts
            set status = case when $5::bigint is not null then 'scheduled' else 'deployed' end,
                visibility = 'public',
                campaign_address = $2,
                token_address = coalesce($3, token_address),
                deploy_tx_hash = coalesce($4, deploy_tx_hash),
                scheduled_launch_at = case when $5::bigint is not null then to_timestamp($5) else null end,
                deployed_at = coalesce(deployed_at, now()),
                updated_at = now()
          where id::text = $1
          returning *`,
        [draftId, campaignAddress, tokenAddress || null, deployTxHash, isScheduled ? scheduledLaunchAt : null],
      );
      const draft = mapDraftRow(updated.rows[0]);
      const tickerReservation = await markTickerReservationDeployed(db, {
        draftId,
        creatorWallet: row.creator_wallet,
        campaignAddress,
        mint: tokenAddress || null,
        deploymentSignature: deployTxHash,
        scheduledLaunchAt: isScheduled ? scheduledLaunchAt : null,
        programId: String(body.factoryAddress || "").trim() || null,
        generationId: body.generationId == null ? null : String(body.generationId),
      });
      const registry = await upsertCampaignFromDraft(db, {
        chainId: Number(row.chain_id),
        campaignAddress,
        tokenAddress: tokenAddress || draft?.tokenAddress || null,
        creatorWallet: row.creator_wallet,
        name: row.name || draft?.name,
        symbol: row.ticker || draft?.ticker,
        logoUrl: row.logo_url || draft?.logoUrl,
        deployTxHash,
        factoryAddress: String(body.factoryAddress || "").trim() || null,
        ...(solanaVaults || {}),
      });
      return { draft, tickerReservation, registry };
    });
  } catch (error) {
    if (error instanceof TickerReservationError || isTickerReservationConflict(error)) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    throw error;
  }

  const draft = deployed.draft;
  const target = `/token/${tokenAddress || campaignAddress}`;
  const launchNotification = isScheduled
    ? {
        eventType: "schedule",
        title: "Campaign countdown armed",
        body: `$${draft?.ticker || row.ticker || "DRAFT"} opens for trading at ${new Date(scheduledLaunchAt * 1000).toLocaleString("en-GB")}.`,
        metadata: { target, campaignAddress, tokenAddress: tokenAddress || null, deployTxHash, scheduledLaunchAt },
      }
    : {
        eventType: "launch",
        title: "Campaign pushed live",
        body: `$${draft?.ticker || row.ticker || "DRAFT"} is now live in the Warzone.`,
        metadata: { target, campaignAddress, tokenAddress: tokenAddress || null, deployTxHash },
      };

  await notifyDraftOwner(pool, draft, launchNotification);
  await notifyDraftSubscribers(pool, draft, launchNotification);

  return json(res, 200, {
    draft,
    tickerReservation: deployed.tickerReservation,
    registryUpserted: Boolean(deployed.registry?.ok),
    registryError: deployed.registry?.ok ? null : deployed.registry?.error || null,
    registryMetaMerged: Boolean(deployed.registry?.metaMerged),
  });
}

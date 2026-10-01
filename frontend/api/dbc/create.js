/**
 * POST /api/dbc/create — DBC launch: preflight / begin / authorize / finalize.
 * Modelled on solana-direct-create.js; that file is not edited.
 */
import crypto from "node:crypto";
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { json, badMethod, readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";
import {
  TickerReservationError,
  mapTickerReservationRow,
  normalizeTicker,
  refreshExpiredTickerReservations,
  sha256Hex,
  withTickerReservationTransaction,
} from "../dev-fix/ticker-reservation-service.js";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_FIRST_BUY_MAX_BPS,
  DBC_PROGRAM_ID,
  DBC_QUOTE_MINT,
  DBC_SOL_USD_MAX_STALE_MS,
  parseTargetUsdToMicros,
} from "../../shared/dbcEconomics.mjs";
import { readSolUsdMicros } from "../lib/solUsdMicros.js";
import { solPriceStep } from "../lib/dbc/dbcPriceSteps.mjs";
import { requiredCluster, createDbcConfigLadder } from "../lib/dbc/dbcConfigLadder.js";
import { parseFeeChoice } from "../lib/dbc/dbcFeeChoice.mjs";
import { requireEnabledQuote, stableStep } from "../../shared/dbcQuotes.mjs";
import { DbcStockQuoteError, dbcTokenBadgeAddress, stockPriceStep } from "../lib/dbc/dbcStockQuote.mjs";
import { firstBuyExceedsCap, quoteFirstBuyOnConfig } from "../lib/dbc/dbcFirstBuyQuote.mjs";
import { assertDbcCreatorLimits, loadDbcCreatorLimits } from "../lib/dbc/dbcCreateLimits.js";
import { isDbcLaunchEnabled, dbcLaunchDisabledPayload } from "./launch-config.js";
import {
  assertScheduleWindow,
  isDueScheduledDraft,
  isScheduleLocked,
  parseUnixSeconds,
} from "../lib/dbc/dbcSchedule.mjs";
import { notifyDraftOwner } from "../dev-fix/prepare-notify.js";
import { notifyDraftCreated } from "../lib/campaignLifecycleNotifications.js";

const SESSION_PURPOSE = "MEMEWARZONE_SOLANA_DIRECT_SESSION_V1";
const FINALIZE_PURPOSE = "MEMEWARZONE_DBC_CREATE_FINALIZE_V1";
const SESSION_TTL_SECONDS = 15 * 60;
const FINALIZE_TTL_SECONDS = 60 * 60;

class DbcCreateError extends Error {
  constructor(message, { code = "DBC_CREATE_ERROR", httpStatus = 409 } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function requiredEnv(name, env) {
  const value = String(env[name] || "").trim();
  if (!value) throw new DbcCreateError(`${name} is not configured.`, { code: "DBC_CREATE_CONFIGURATION", httpStatus: 503 });
  return value;
}

function tokenKey(env) {
  return crypto.createHash("sha256")
    .update("MEMEWARZONE_SOLANA_DIRECT_TOKEN_KEY_V1\0", "utf8")
    .update(requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY", env), "utf8")
    .digest();
}

function signOpaqueToken(payload, purpose, env) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", tokenKey(env)).update(`${purpose}.${body}`, "utf8").digest("base64url");
  return `${body}.${signature}`;
}

function verifyOpaqueToken(token, purpose, env) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) throw new DbcCreateError("Your signing session is not valid. Sign again.", { code: "DBC_SESSION_INVALID", httpStatus: 401 });
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", tokenKey(env)).update(`${purpose}.${body}`, "utf8").digest();
  let provided;
  try { provided = Buffer.from(signature, "base64url"); } catch { provided = Buffer.alloc(0); }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new DbcCreateError("Your signing session is not valid. Sign again.", { code: "DBC_SESSION_INVALID", httpStatus: 401 });
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new DbcCreateError("Your signing session is not valid. Sign again.", { code: "DBC_SESSION_INVALID", httpStatus: 401 }); }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload?.exp) || payload.exp <= now) {
    throw new DbcCreateError("Your signing session expired. Sign again.", { code: "DBC_SESSION_EXPIRED", httpStatus: 401 });
  }
  return payload;
}

export function verifyDbcCreateSessionToken(token, env = process.env) {
  return verifyOpaqueToken(token, SESSION_PURPOSE, env);
}

function metadataUriFor(mint) {
  return `https://api.memewar.zone/api/token-metadata/101/${mint}`;
}

function tokenPathFor(mint) {
  return `/token/${mint}?chainId=101`;
}

function mapDraft(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id ?? row.chainId ?? 101),
    creatorWallet: String(row.creator_wallet ?? row.creatorWallet ?? ""),
    name: String(row.name || ""),
    ticker: normalizeTicker(row.ticker),
    description: row.description || null,
    logoUrl: row.logo_url ?? row.logoUrl ?? null,
    websiteUrl: row.website_url ?? row.websiteUrl ?? null,
    xUrl: row.x_url ?? row.xUrl ?? null,
    otherUrl: row.other_url ?? row.otherUrl ?? null,
    slug: String(row.slug || ""),
    status: String(row.status || "draft"),
    campaignAddress: row.campaign_address ?? row.campaignAddress ?? null,
    tokenAddress: row.token_address ?? row.tokenAddress ?? null,
    launchType: String(row.launch_type ?? row.launchType ?? "launchpad"),
    dbcFeeChoice: row.dbc_fee_choice ?? row.dbcFeeChoice ?? null,
    dbcCreatorSharePct: row.dbc_creator_share_pct ?? row.dbcCreatorSharePct ?? null,
    dbcFirstBuyLamports: row.dbc_first_buy_lamports != null ? String(row.dbc_first_buy_lamports) : (row.dbcFirstBuyLamports != null ? String(row.dbcFirstBuyLamports) : null),
    graduationTargetWei: String(row.graduation_target_wei ?? row.graduationTargetWei ?? ""),
    scheduledLaunchAt: row.scheduled_launch_at ?? row.scheduledLaunchAt ?? null,
  };
}

async function loadDraftById(db, draftId) {
  const id = String(draftId || "").trim();
  if (!id) return null;
  const found = await db.query(`select * from public.campaign_drafts where id::text = $1 limit 1`, [id]);
  return mapDraft(found.rows[0]);
}

async function loadReservationForDraft(db, { draftId, creatorWallet, chainId, cluster, ticker }) {
  const existing = await db.query(
    `select * from public.ticker_reservations
      where draft_id::text = $1
        and status not in ('DRAFT_UNRESERVED', 'RELEASED')
      order by created_at desc limit 1 for update`,
    [String(draftId)],
  );
  const row = mapTickerReservationRow(existing.rows[0]);
  if (!row) {
    throw new TickerReservationError("This draft has no ticker reservation.", { code: "TICKER_UNAVAILABLE", httpStatus: 409 });
  }
  if (String(row.creatorWallet) !== String(creatorWallet)) {
    throw new TickerReservationError("Ticker already reserved by another active launch.", { code: "TICKER_UNAVAILABLE", httpStatus: 409 });
  }
  return row;
}

async function createOrLoadReservation(db, { creatorWallet, chainId, cluster, ticker, draftId }) {
  if (draftId) return loadReservationForDraft(db, { draftId, creatorWallet, chainId, cluster, ticker });
  await refreshExpiredTickerReservations(db, { chainId, cluster, normalizedTicker: ticker });
  const existing = await db.query(
    `select * from public.ticker_reservations
      where draft_id is null and chain_id = $1 and cluster = $2 and normalized_ticker = $3
        and status not in ('DRAFT_UNRESERVED', 'RELEASED')
      order by created_at desc limit 1 for update`,
    [Number(chainId), String(cluster), ticker],
  );
  const row = mapTickerReservationRow(existing.rows[0]);
  if (row) {
    if (row.metadata?.source !== "dbc_create" || String(row.creatorWallet) !== String(creatorWallet)) {
      throw new TickerReservationError("Ticker already reserved by another active launch.", { code: "TICKER_UNAVAILABLE", httpStatus: 409 });
    }
    return row;
  }
  const id = crypto.randomUUID();
  try {
    const inserted = await db.query(
      `insert into public.ticker_reservations
         (id, draft_id, creator_wallet, chain_id, cluster, original_ticker, normalized_ticker,
          ticker_hash, reservation_id_hash, status, reserved_at, expires_at, grace_end_at,
          reservation_version, metadata)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8,'SOFT_RESERVED',now(),now() + interval '1 hour',
               now() + interval '2 hours',1,$9::jsonb)
       returning *`,
      [
        id, creatorWallet, Number(chainId), cluster, ticker, ticker,
        sha256Hex(Buffer.from(ticker, "utf8")), sha256Hex(Buffer.from(id, "utf8")),
        JSON.stringify({ source: "dbc_create" }),
      ],
    );
    return mapTickerReservationRow(inserted.rows[0]);
  } catch (error) {
    if (error?.code === "23505") {
      throw new TickerReservationError("Ticker already reserved by another active launch.", { code: "TICKER_UNAVAILABLE", httpStatus: 409, cause: error });
    }
    throw error;
  }
}

function resolveCreateQuote(cluster, mint) {
  return requireEnabledQuote(cluster, String(mint || "").trim() || DBC_QUOTE_MINT);
}

function poolConfigStateFromParams(configParams, quoteMint = DBC_QUOTE_MINT) {
  return {
    tokenType: Number(configParams.tokenType ?? 0),
    quoteMint: new PublicKey(quoteMint),
    quoteTokenFlag: 0,
    activationType: Number(configParams.activationType ?? 0),
    poolFees: configParams.poolFees,
    sqrtStartPrice: configParams.sqrtStartPrice,
    migrationQuoteThreshold: configParams.migrationQuoteThreshold,
    curve: configParams.curve,
    collectFeeMode: configParams.collectFeeMode,
  };
}

async function buildCreatePoolTransaction({
  client,
  creatorWallet,
  mint,
  configAddress,
  name,
  symbol,
  uri,
  firstBuyLamports,
  configParams,
  quoteMint = DBC_QUOTE_MINT,
  tokenBadge = null,
}) {
  const creator = new PublicKey(creatorWallet);
  const baseMint = new PublicKey(mint);
  const config = new PublicKey(configAddress);
  const createPoolParam = {
    name: String(name).slice(0, 32),
    symbol: String(symbol).slice(0, 10),
    uri,
    payer: creator,
    poolCreator: creator,
    config,
    baseMint,
    ...(tokenBadge ? { tokenBadge: new PublicKey(tokenBadge) } : {}),
  };
  let tx;
  if (firstBuyLamports > 0n) {
    tx = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: creator,
        buyAmount: new BN(firstBuyLamports.toString()),
        minimumAmountOut: new BN(1),
        referralTokenAccount: null,
      },
    });
  } else {
    tx = await client.creator.createPool(createPoolParam);
  }
  tx.feePayer = creator;
  const pool = deriveDbcPoolAddress(new PublicKey(quoteMint), baseMint, config);
  return { tx, pool: pool.toBase58() };
}

function serializeUnsigned(tx) {
  // Placeholder blockhash is transport-only. The browser (dbcCreateSubmit) must
  // replace it with a fresh getLatestBlockhash before simulate + sign.
  if (typeof tx.serialize === "function") {
    try {
      if (!tx.recentBlockhash) tx.recentBlockhash = "11111111111111111111111111111111";
      return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    } catch {
      return Buffer.from(tx.serializeMessage()).toString("base64");
    }
  }
  throw new DbcCreateError("createPool did not return a transaction", { code: "DBC_CREATE_TX", httpStatus: 500 });
}

function parseFirstBuyLamports(value) {
  const raw = String(value ?? "0").trim();
  if (!raw) return 0n;
  if (!/^\d+$/.test(raw)) {
    const err = new DbcCreateError("firstBuyLamports must be a non-negative integer.", { code: "DBC_BAD_FIRST_BUY", httpStatus: 400 });
    throw err;
  }
  return BigInt(raw);
}

function pubkeyField(value) {
  if (!value) return "";
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value).trim();
}

async function upsertTokenMetadata(db, row) {
  const existing = await db.query(
    `select id from public.token_metadata_registry
      where chain_id = $1 and (campaign_address = $2 or token_address = $3)
      order by id asc limit 1`,
    [row.chainId, row.pool, row.mint],
  );
  const fields = [
    row.pool, row.mint, row.creator, row.name, row.symbol, row.description,
    row.logoUrl, row.metadataUri, row.website, row.x, row.telegram, row.discord,
  ];
  if (existing.rows[0]?.id) {
    await db.query(
      `update public.token_metadata_registry
          set campaign_address = $2, token_address = $3, creator_address = $4,
              name = $5, symbol = $6, description = $7, logo_uri = $8, metadata_uri = $9,
              website = $10, x_account = $11, telegram = $12, discord = $13, source = 'dbc_create'
        where id = $1`,
      [existing.rows[0].id, ...fields],
    );
    return;
  }
  await db.query(
    `insert into public.token_metadata_registry (
       chain_id, campaign_address, token_address, creator_address,
       name, symbol, description, logo_uri, metadata_uri, website, x_account, telegram, discord, source, metadata
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'dbc_create',$14::jsonb)`,
    [row.chainId, ...fields, JSON.stringify({ launchType: "dbc" })],
  );
}

async function insertDbcCampaign(db, row) {
  await db.query(
    `insert into public.campaigns (
        chain_id, campaign_address, token_address, creator_address,
        name, symbol, logo_uri, factory_address, launch_type,
        created_block, is_active, launched, created_at_chain, created_at, updated_at, meta,
        fee_recipient_address
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,'dbc',
        0, true, true, now(), now(), now(), $9::jsonb, $10
      )
      on conflict (chain_id, campaign_address) do update set
        token_address = excluded.token_address,
        creator_address = excluded.creator_address,
        name = excluded.name,
        symbol = excluded.symbol,
        logo_uri = coalesce(nullif(excluded.logo_uri, ''), campaigns.logo_uri),
        launch_type = 'dbc',
        is_active = true,
        launched = true,
        meta = coalesce(campaigns.meta, '{}'::jsonb) || excluded.meta,
        fee_recipient_address = coalesce(excluded.fee_recipient_address, campaigns.fee_recipient_address),
        updated_at = now()`,
    [
      row.chainId, row.pool, row.mint, row.creator, row.name, row.symbol, row.logoUrl,
      DBC_PROGRAM_ID,
      JSON.stringify({ dbc: row.dbcMeta }),
      // Our collector buys back platform coins (step 5b). The league categories already skip a
      // campaign's fee_recipient_address, so buybacks never score.
      row.feeRecipient || null,
    ],
  );
}

export function createDbcCreateHandler(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());

  async function db() {
    if (deps.db) return deps.db;
    const mod = await import("../../server/db.js");
    return mod.pool;
  }

  function connection() {
    if (deps.connection) return deps.connection;
    const url = env.SOLANA_RPC_URL || env.SOLANA_RPC_HTTP;
    if (!url) throw new DbcCreateError("SOLANA_RPC_URL is required", { code: "DBC_RPC_MISSING", httpStatus: 503 });
    return new Connection(url, "confirmed");
  }

  function clientFor(conn) {
    if (deps.client) return deps.client;
    return new DynamicBondingCurveClient(conn, "confirmed");
  }

  /** SOL: the 2% SOL/USD step. Stock: the mint re-checked on chain, then its 2% price step. Stable: 1:1. */
  async function stepForQuote(quote) {
    if (quote.kind === "native") {
      const solUsdMicros = await (deps.readSolUsdMicros || readSolUsdMicros)({ maxStaleMs: DBC_SOL_USD_MAX_STALE_MS });
      return (deps.solPriceStep || solPriceStep)(solUsdMicros);
    }
    if (quote.kind === "stock") return (deps.stockPriceStep || stockPriceStep)(connection(), quote);
    return stableStep();
  }

  async function handlePreflight(body, res) {
    const creatorWallet = String(body.creatorWallet || "").trim();
    if (!creatorWallet) return json(res, 400, { ok: false, error: "creatorWallet is required", code: "DBC_BAD_WALLET" });
    const cluster = requiredCluster(env);
    const targetUsdMicros = parseTargetUsdToMicros(body.targetUsd);
    if (targetUsdMicros == null) {
      return json(res, 400, { ok: false, error: "targetUsd must be 15000, 30000 or 50000", code: "DBC_BAD_TARGET" });
    }
    if (targetUsdMicros === DBC_DEVNET_TEST_TARGET_USD_MICROS && cluster !== "devnet") {
      return json(res, 400, { ok: false, error: "the $150 target is only for devnet", code: "DBC_TEST_TARGET_REFUSED" });
    }
    const limits = await loadDbcCreatorLimits(await db(), { creatorWallet, chainId: 101, now });
    return json(res, 200, {
      ok: true,
      chainId: 101,
      cluster,
      preflight: {
        ...limits,
        allowed: limits.allowed,
        creatorLiveBondingCount: limits.liveBondingCount,
        creatorMaxLiveBondingCount: limits.maxLiveBondingCount,
      },
    });
  }

  async function handleBegin(body, res) {
    const creatorWallet = String(body.creatorWallet || "").trim();
    const ticker = normalizeTicker(body.ticker);
    if (!ticker) return json(res, 400, { ok: false, error: "Ticker is required.", code: "INVALID_RESERVATION_TICKER" });
    const cluster = requiredCluster(env);
    const database = await db();
    const verified = await (deps.requireWalletActionAuth || requireWalletActionAuth)({
      res,
      pool: database,
      auth: body.auth,
      expectedWallet: creatorWallet,
      chainId: 101,
      action: "dbc_create",
      extraLines: [`Ticker: ${ticker}`],
      routeLabel: "dbc/create/begin",
    });
    if (!verified) return;
    const draftId = String(body.draftId || "").trim() || null;
    if (draftId) {
      const draft = await loadDraftById(database, draftId);
      if (!draft || draft.creatorWallet !== creatorWallet) {
        return json(res, 403, { ok: false, error: "Only the draft owner can launch this coin.", code: "DBC_DRAFT_OWNER" });
      }
      if (isScheduleLocked(draft.scheduledLaunchAt, now().getTime())) {
        return json(res, 409, { ok: false, error: "Deploy is locked until the scheduled launch time.", code: "DBC_SCHEDULED_LOCKED" });
      }
    }
    assertDbcCreatorLimits(await loadDbcCreatorLimits(database, { creatorWallet, now }));
    const reservation = await withTickerReservationTransaction(database, async (tx) => (
      createOrLoadReservation(tx, { creatorWallet, chainId: 101, cluster, ticker, draftId })
    ));
    const nowTs = Math.floor(Date.now() / 1000);
    const sessionToken = signOpaqueToken({
      v: 1,
      type: "dbc_create_session",
      reservationId: String(reservation.id),
      creatorWallet,
      chainId: 101,
      cluster,
      ticker,
      draftId,
      iat: nowTs,
      exp: nowTs + SESSION_TTL_SECONDS,
    }, SESSION_PURPOSE, env);
    return json(res, 200, {
      ok: true,
      chainId: 101,
      cluster,
      sessionToken,
      tickerReservation: reservation,
    });
  }

  async function handleAuthorize(body, res) {
    const session = verifyOpaqueToken(body.sessionToken, SESSION_PURPOSE, env);
    const creatorWallet = session.creatorWallet;
    const ticker = session.ticker;
    const cluster = session.cluster;
    const fee = parseFeeChoice(body.feeChoice, body.creatorSharePct);
    if (!fee.ok) return json(res, 400, { ok: false, error: fee.error, code: fee.code });
    const targetUsdMicros = parseTargetUsdToMicros(body.targetUsd);
    if (targetUsdMicros == null) return json(res, 400, { ok: false, error: "targetUsd must be 15000, 30000 or 50000", code: "DBC_BAD_TARGET" });
    if (targetUsdMicros === DBC_DEVNET_TEST_TARGET_USD_MICROS && cluster !== "devnet") {
      return json(res, 400, { ok: false, error: "the $150 target is only for devnet", code: "DBC_TEST_TARGET_REFUSED" });
    }
    const mint = String(body.mint || body.baseMint || "").trim();
    if (!mint) return json(res, 400, { ok: false, error: "the new token public key is required", code: "DBC_BAD_MINT" });
    const name = String(body.name || "").trim();
    const symbol = normalizeTicker(body.symbol || ticker);
    if (!name || !symbol) return json(res, 400, { ok: false, error: "name and symbol are required", code: "DBC_BAD_NAME" });
    const firstBuyLamports = parseFirstBuyLamports(body.firstBuyLamports);
    const draftId = String(body.draftId || session.draftId || "").trim() || null;
    const database = await db();
    assertDbcCreatorLimits(await (deps.loadDbcCreatorLimits || loadDbcCreatorLimits)(database, { creatorWallet, now }));
    if (draftId) {
      const draft = await loadDraftById(database, draftId);
      if (!draft || draft.creatorWallet !== creatorWallet) {
        return json(res, 403, { ok: false, error: "Only the draft owner can launch this coin.", code: "DBC_DRAFT_OWNER" });
      }
      if (isScheduleLocked(draft.scheduledLaunchAt, now().getTime())) {
        return json(res, 409, { ok: false, error: "Deploy is locked until the scheduled launch time.", code: "DBC_SCHEDULED_LOCKED" });
      }
    }

    let quote;
    try {
      quote = resolveCreateQuote(cluster, body.quoteMint || body.quote);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message, code: error.code || "DBC_QUOTE_UNKNOWN" });
    }
    const step = await stepForQuote(quote);
    const ladder = deps.ladder || createDbcConfigLadder({ db: database, env, cluster });
    const ensured = await ladder.ensureLaunchConfig({
      targetUsdMicros,
      stepIndex: step.stepIndex,
      stepUsdMicros: step.stepUsdMicros,
      creatorFeeMode: fee.creatorFeeMode,
      quoteMint: quote.mint,
    });
    const quoteFn = deps.quoteFirstBuyOnConfig || quoteFirstBuyOnConfig;
    const firstBuy = quoteFn(ensured.configParams, firstBuyLamports);
    if (firstBuyExceedsCap(firstBuy, DBC_FIRST_BUY_MAX_BPS)) {
      return json(res, 400, {
        ok: false,
        error: "The first buy cannot be more than 10% of supply.",
        code: "DBC_FIRST_BUY_CAP",
        tokensOut: firstBuy.tokensOut.toString(),
        bps: firstBuy.bps.toString(),
      });
    }

    const uri = metadataUriFor(mint);
    const conn = connection();
    const client = clientFor(conn);
    const { tx, pool } = await (deps.buildCreatePoolTransaction || buildCreatePoolTransaction)({
      client,
      creatorWallet,
      mint,
      configAddress: ensured.configAddress,
      name,
      symbol,
      uri,
      firstBuyLamports,
      configParams: ensured.configParams,
      quoteMint: quote.mint,
      tokenBadge: quote.kind === "stock" ? dbcTokenBadgeAddress(quote.mint).toBase58() : null,
    });
    const serialized = serializeUnsigned(tx);
    const nowTs = Math.floor(Date.now() / 1000);
    const finalizeToken = signOpaqueToken({
      v: 1,
      type: "dbc_create_finalize",
      reservationId: session.reservationId,
      creatorWallet,
      chainId: 101,
      cluster,
      ticker,
      mint,
      pool,
      config: ensured.configAddress,
      name,
      symbol,
      description: String(body.description || "").trim() || null,
      logoUrl: String(body.logoUrl || "").trim() || null,
      website: String(body.website || body.websiteUrl || "").trim() || null,
      x: String(body.x || body.xUrl || "").trim() || null,
      telegram: String(body.telegram || body.telegramUrl || "").trim() || null,
      discord: String(body.discord || body.discordUrl || "").trim() || null,
      feeChoice: fee.feeChoice,
      creatorSharePct: fee.creatorSharePct,
      creatorFeeMode: fee.creatorFeeMode,
      quoteMint: quote.mint,
      quoteDecimals: quote.decimals,
      quoteSymbol: quote.symbol,
      quoteKind: quote.kind,
      targetUsdMicros: targetUsdMicros.toString(),
      stepIndex: step.stepIndex,
      firstBuyLamports: firstBuyLamports.toString(),
      uri,
      draftId,
      iat: nowTs,
      exp: nowTs + FINALIZE_TTL_SECONDS,
    }, FINALIZE_PURPOSE, env);

    return json(res, 200, {
      ok: true,
      config: ensured.configAddress,
      pool,
      mint,
      transaction: serialized,
      signerCount: 2,
      firstBuy: {
        lamports: firstBuyLamports.toString(),
        tokensOut: firstBuy.tokensOut.toString(),
        bps: firstBuy.bps.toString(),
      },
      quoteMint: quote.mint,
      quoteSymbol: quote.symbol,
      quoteDecimals: quote.decimals,
      finalizeToken,
      metadataUri: uri,
    });
  }

  async function handleFinalize(body, res) {
    const token = verifyOpaqueToken(body.finalizeToken, FINALIZE_PURPOSE, env);
    const conn = connection();
    const client = clientFor(conn);
    const poolPk = new PublicKey(token.pool);
    const onChain = await (deps.readPool
      ? deps.readPool(token.pool)
      : client.state.getPool(poolPk).then((r) => r?.poolState ?? r));
    if (!onChain) {
      return json(res, 409, { ok: false, error: "DBC pool is not on chain yet.", code: "DBC_POOL_MISSING" });
    }
    const owner = deps.poolOwner
      ? await deps.poolOwner(token.pool)
      : (await conn.getAccountInfo(poolPk, "confirmed"))?.owner?.toBase58?.();
    if (!owner || owner !== DBC_PROGRAM_ID) {
      return json(res, 409, { ok: false, error: "That account is not a DBC pool.", code: "DBC_POOL_OWNER" });
    }
    const configOnChain = pubkeyField(onChain.config);
    const creatorOnChain = pubkeyField(onChain.creator) || pubkeyField(onChain.poolCreator);
    const mintOnChain = pubkeyField(onChain.baseMint);
    if (!configOnChain || configOnChain !== token.config) {
      return json(res, 409, { ok: false, error: "The pool config does not match the authorized config.", code: "DBC_POOL_CONFIG" });
    }
    if (!creatorOnChain || creatorOnChain !== token.creatorWallet) {
      return json(res, 409, { ok: false, error: "The pool creator does not match the wallet that authorized this launch.", code: "DBC_POOL_CREATOR" });
    }
    if (!mintOnChain || mintOnChain !== token.mint) {
      return json(res, 409, { ok: false, error: "The pool mint does not match the reserved token.", code: "DBC_POOL_MINT" });
    }

    const database = await db();
    const dbcMeta = {
      config: token.config,
      target: token.targetUsdMicros,
      stepIndex: token.stepIndex,
      feeChoice: token.feeChoice,
      creatorSharePct: token.creatorSharePct,
      quoteMint: token.quoteMint || DBC_QUOTE_MINT,
      quoteDecimals: token.quoteDecimals ?? 9,
      quoteSymbol: token.quoteSymbol || "SOL",
      quoteKind: token.quoteKind || "native",
      firstBuySignature: String(body.signature || body.deployTxHash || "") || null,
      firstBuyLamports: token.firstBuyLamports,
    };
    await withTickerReservationTransaction(database, async (tx) => {
      await insertDbcCampaign(tx, {
        chainId: 101,
        pool: token.pool,
        mint: token.mint,
        creator: token.creatorWallet,
        name: token.name,
        symbol: token.symbol,
        logoUrl: token.logoUrl,
        dbcMeta,
        feeRecipient: String(env.DBC_FEE_COLLECTOR || "").trim() || null,
      });
      await upsertTokenMetadata(tx, {
        chainId: 101,
        pool: token.pool,
        mint: token.mint,
        creator: token.creatorWallet,
        name: token.name,
        symbol: token.symbol,
        description: token.description,
        logoUrl: token.logoUrl,
        metadataUri: token.uri,
        website: token.website,
        x: token.x,
        telegram: token.telegram,
        discord: token.discord,
      });
      await tx.query(
        `update public.ticker_reservations
            set status = 'LIVE',
                live_at = coalesce(live_at, now()),
                expires_at = null,
                grace_end_at = null,
                campaign_pda = $2,
                mint = $3,
                deployment_signature = coalesce(nullif(deployment_signature, ''), $4),
                updated_at = now()
          where id::text = $1`,
        [token.reservationId, token.pool, token.mint, dbcMeta.firstBuySignature || "on-chain"],
      );
      if (token.draftId) {
        await tx.query(
          `update public.campaign_drafts
              set status = 'deployed',
                  campaign_address = $2,
                  token_address = $3,
                  deploy_tx_hash = $4,
                  deployed_at = coalesce(deployed_at, now()),
                  updated_at = now()
            where id::text = $1`,
          [token.draftId, token.pool, token.mint, dbcMeta.firstBuySignature || "on-chain"],
        );
      }
    });

    return json(res, 200, {
      ok: true,
      campaignAddress: token.pool,
      mintAddress: token.mint,
      tokenPath: tokenPathFor(token.mint),
      pool: token.pool,
    });
  }

  async function ensureConfigForQuote(body) {
    const cluster = requiredCluster(env);
    const fee = parseFeeChoice(body.feeChoice || "keep", body.creatorSharePct);
    if (!fee.ok) return { error: fee };
    const targetUsdMicros = parseTargetUsdToMicros(body.targetUsd);
    if (targetUsdMicros == null) {
      return { error: { ok: false, error: "targetUsd must be 15000, 30000 or 50000", code: "DBC_BAD_TARGET" } };
    }
    if (targetUsdMicros === DBC_DEVNET_TEST_TARGET_USD_MICROS && cluster !== "devnet") {
      return { error: { ok: false, error: "the $150 target is only for devnet", code: "DBC_TEST_TARGET_REFUSED" } };
    }
    let quote;
    try {
      quote = resolveCreateQuote(cluster, body.quoteMint || body.quote);
    } catch (error) {
      return { error: { ok: false, error: error.message, code: error.code || "DBC_QUOTE_UNKNOWN" } };
    }
    const step = await stepForQuote(quote);
    const database = await db();
    const ladder = deps.ladder || createDbcConfigLadder({ db: database, env, cluster });
    const ensured = await ladder.ensureLaunchConfig({
      targetUsdMicros,
      stepIndex: step.stepIndex,
      stepUsdMicros: step.stepUsdMicros,
      creatorFeeMode: fee.creatorFeeMode,
      quoteMint: quote.mint,
    });
    return { fee, targetUsdMicros, cluster, step, ensured, quote };
  }

  async function handleQuoteFirstBuy(body, res) {
    const prepared = await ensureConfigForQuote(body);
    if (prepared.error) return json(res, 400, { ok: false, ...prepared.error, error: prepared.error.error });
    const firstBuyLamports = parseFirstBuyLamports(body.firstBuyLamports);
    const quoteFn = deps.quoteFirstBuyOnConfig || quoteFirstBuyOnConfig;
    const firstBuy = quoteFn(prepared.ensured.configParams, firstBuyLamports);
    const capped = firstBuyExceedsCap(firstBuy, DBC_FIRST_BUY_MAX_BPS);
    return json(res, 200, {
      ok: true,
      tokensOut: firstBuy.tokensOut.toString(),
      bps: firstBuy.bps.toString(),
      totalSupply: firstBuy.totalSupply.toString(),
      exceedsCap: capped,
    });
  }

  async function handleSchedule(body, res) {
    const creatorWallet = String(body.creatorWallet || "").trim();
    const draftId = String(body.draftId || "").trim();
    if (!creatorWallet || !draftId) {
      return json(res, 400, { ok: false, error: "draftId and creatorWallet are required", code: "DBC_BAD_DRAFT" });
    }
    const database = await db();
    const verified = await (deps.requireWalletActionAuth || requireWalletActionAuth)({
      res,
      pool: database,
      auth: body.auth,
      expectedWallet: creatorWallet,
      chainId: 101,
      action: "dbc_schedule",
      extraLines: [`Draft ID: ${draftId}`],
      routeLabel: "dbc/create/schedule",
    });
    if (!verified) return;
    const draft = await loadDraftById(database, draftId);
    if (!draft || draft.creatorWallet !== creatorWallet) {
      return json(res, 403, { ok: false, error: "Only the draft owner can schedule this launch.", code: "DBC_DRAFT_OWNER" });
    }
    if (draft.campaignAddress) {
      return json(res, 409, { ok: false, error: "This draft is already live.", code: "DBC_DRAFT_LIVE" });
    }
    const nowSec = Math.floor(now().getTime() / 1000);
    const at = assertScheduleWindow(parseUnixSeconds(body.scheduledLaunchAt), nowSec);
    const atIso = new Date(at * 1000).toISOString();
    let feeChoice = draft.dbcFeeChoice;
    let creatorSharePct = draft.dbcCreatorSharePct;
    if (body.feeChoice) {
      const fee = parseFeeChoice(body.feeChoice, body.creatorSharePct);
      if (!fee.ok) return json(res, 400, { ok: false, error: fee.error, code: fee.code });
      feeChoice = fee.feeChoice;
      creatorSharePct = fee.creatorSharePct;
    }
    const firstBuyLamports = body.firstBuyLamports != null ? String(body.firstBuyLamports) : draft.dbcFirstBuyLamports;
    await database.query(
      `update public.campaign_drafts
          set status = 'scheduled',
              launch_type = 'dbc',
              scheduled_launch_at = $2::timestamptz,
              dbc_fee_choice = coalesce($3, dbc_fee_choice),
              dbc_creator_share_pct = coalesce($4, dbc_creator_share_pct),
              dbc_first_buy_lamports = coalesce($5, dbc_first_buy_lamports),
              updated_at = now()
        where id::text = $1`,
      [draftId, atIso, feeChoice, creatorSharePct, firstBuyLamports],
    );
    const updated = await loadDraftById(database, draftId);
    try {
      await notifyDraftOwner(database, updated, {
        eventType: "dbc_launch_scheduled",
        title: "Launch time set",
        body: `Your launch time is ${atIso}. Deploy when the timer ends to go live.`,
        metadata: { scheduledLaunchAt: atIso, slug: updated?.slug },
      });
      await notifyDraftCreated(database, {
        chainId: 101,
        draftId,
        slug: updated?.slug,
        name: updated?.name,
        ticker: updated?.ticker,
        imageUrl: updated?.logoUrl,
        creatorWallet,
        scheduledFor: atIso,
      });
    } catch {
      // Notifications are best-effort.
    }
    return json(res, 200, { ok: true, draft: updated, scheduledLaunchAt: atIso });
  }

  async function handleDueDrafts(req, res) {
    const url = new URL(req.url || "http://localhost/", "http://localhost");
    const wallet = String(url.searchParams.get("wallet") || "").trim();
    if (!wallet) return json(res, 400, { ok: false, error: "wallet is required", code: "DBC_BAD_WALLET" });
    const database = await db();
    const found = await database.query(
      `select *
         from public.campaign_drafts
        where creator_wallet = $1
          and coalesce(launch_type, 'launchpad') = 'dbc'
          and status = 'scheduled'
          and campaign_address is null
          and scheduled_launch_at is not null
          and scheduled_launch_at <= now()
        order by scheduled_launch_at asc`,
      [wallet],
    );
    const items = found.rows.map(mapDraft).filter((row) => isDueScheduledDraft(row, now().getTime()));
    for (const item of items) {
      try {
        await notifyDraftOwner(database, item, {
          eventType: "dbc_launch_due",
          title: "Your launch time has arrived",
          body: "Your launch time has arrived. Deploy now to go live.",
          metadata: { draftId: item.id, slug: item.slug },
        });
      } catch {
        // Best-effort.
      }
    }
    return json(res, 200, { ok: true, items, copy: "Your launch time has arrived. Deploy now to go live." });
  }

  async function handleLookup(req, res) {
    const url = new URL(req.url || "http://localhost/", "http://localhost");
    const token = String(url.searchParams.get("token") || url.searchParams.get("mint") || "").trim();
    if (!token) return json(res, 400, { ok: false, error: "token is required", code: "DBC_BAD_TOKEN" });
    const database = await db();
    const found = await database.query(
      `select c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri, c.creator_address, c.meta, c.launch_type,
              m.description, m.website, m.x_account, m.telegram, m.discord, m.logo_uri as metadata_logo
         from public.campaigns c
         left join public.token_metadata_registry m
           on m.chain_id = c.chain_id and (m.token_address = c.token_address or m.campaign_address = c.campaign_address)
        where c.chain_id = 101
          and coalesce(c.launch_type, 'launchpad') = 'dbc'
          and (c.token_address = $1 or c.campaign_address = $1)
        limit 1`,
      [token],
    );
    const row = found.rows[0];
    if (!row) return json(res, 404, { ok: false, error: "not a DBC coin", code: "DBC_NOT_FOUND" });
    const payload = {
      ok: true,
      launchType: "dbc",
      pool: row.campaign_address,
      mint: row.token_address,
      name: row.name,
      symbol: row.symbol,
      logoUri: row.logo_uri || row.metadata_logo || null,
      creator: row.creator_address,
      description: row.description || null,
      website: row.website || null,
      x: row.x_account || null,
      telegram: row.telegram || null,
      discord: row.discord || null,
      meta: row.meta?.dbc || null,
    };
    if (url.searchParams.get("live") === "1") {
      try {
        const conn = connection();
        const client = clientFor(conn);
        const onChain = await (deps.readPool
          ? deps.readPool(row.campaign_address)
          : client.state.getPool(new PublicKey(row.campaign_address)).then((r) => r?.poolState ?? r));
        if (onChain) {
          const quoteReserve = BigInt(onChain.quoteReserve?.toString?.() || onChain.quote_reserve || 0);
          // The migration threshold lives on the pool's CONFIG, not on the pool. meta.target is the
          // dollar target in USD micros and must never stand in for it (that put $150 = 150_000_000
          // against a lamport reserve and showed 18.75% for a coin 2.2% of the way). Our ladder row
          // records the config's threshold; the chain is read only when the row is missing.
          let threshold = BigInt(onChain.migrationQuoteThreshold?.toString?.() || onChain.migration_quote_threshold || 0);
          const configAddress = String(onChain.config?.toBase58?.() || onChain.config || payload.meta?.config || "");
          if (threshold === 0n && configAddress) {
            const cfg = await database
              .query(`select threshold_lamports from public.dbc_launch_configs where config_address = $1 limit 1`, [configAddress])
              .catch(() => ({ rows: [] }));
            threshold = BigInt(String(cfg.rows?.[0]?.threshold_lamports || "0"));
            if (threshold === 0n && !deps.readPool) {
              const onChainConfig = await client.state.getPoolConfig(new PublicKey(configAddress)).catch(() => null);
              threshold = BigInt(onChainConfig?.migrationQuoteThreshold?.toString?.() || 0);
            }
          }
          payload.poolLive = {
            quoteReserveLamports: quoteReserve.toString(),
            migrationQuoteThresholdLamports: threshold.toString(),
            progressBps: threshold > 0n ? Number((quoteReserve * 10_000n) / threshold) : 0,
            sqrtPrice: String(onChain.sqrtPrice || onChain.sqrt_price || ""),
            activationPoint: String(onChain.activationPoint || onChain.activation_point || ""),
            isMigrated: Boolean(onChain.isMigrated || onChain.is_migrated),
            baseVault: String(onChain.baseVault || onChain.base_vault || ""),
          };
          payload.migratedPool = row.meta?.solanaGraduation?.pool || row.meta?.dbc?.migration?.pool || null;
        }
      } catch {
        payload.poolLive = null;
      }
    }
    return json(res, 200, payload);
  }

  return async function handle(req, res) {
    const method = String(req.method || "").toUpperCase();
    if (method === "GET") {
      const url = new URL(req.url || "http://localhost/", "http://localhost");
      if (url.searchParams.get("due") === "1" || url.searchParams.get("operation") === "due-drafts") {
        if (!isDbcLaunchEnabled(env)) return json(res, 200, dbcLaunchDisabledPayload());
        return handleDueDrafts(req, res);
      }
      return handleLookup(req, res);
    }
    if (method !== "POST") return badMethod(res);
    if (!isDbcLaunchEnabled(env)) return json(res, 200, dbcLaunchDisabledPayload());
    const body = await readJson(req);
    const operation = String(body.operation || "").trim();
    try {
      if (operation === "preflight") return await handlePreflight(body, res);
      if (operation === "begin") return await handleBegin(body, res);
      if (operation === "authorize") return await handleAuthorize(body, res);
      if (operation === "finalize") return await handleFinalize(body, res);
      if (operation === "schedule") return await handleSchedule(body, res);
      if (operation === "quote-first-buy") return await handleQuoteFirstBuy(body, res);
      return json(res, 400, { ok: false, error: "operation must be preflight, begin, authorize, finalize, schedule or quote-first-buy", code: "DBC_BAD_OPERATION" });
    } catch (error) {
      if (error instanceof DbcCreateError || error instanceof TickerReservationError || error instanceof DbcStockQuoteError) {
        return json(res, error.httpStatus || 409, { ok: false, error: error.message, code: error.code });
      }
      if (error?.code === "DBC_PRICE_STALE") {
        return json(res, 503, { ok: false, error: "SOL/USD price is missing or stale", code: "DBC_PRICE_STALE" });
      }
      if (error?.code === "DBC_CREATOR_COOLDOWN" || error?.code === "DBC_CREATOR_LAUNCH_LIMIT") {
        return json(res, error.httpStatus || 403, { ok: false, error: error.message, code: error.code });
      }
      if (error?.code === "DBC_SCHEDULE_TOO_SOON" || error?.code === "DBC_SCHEDULE_TOO_FAR") {
        return json(res, 400, { ok: false, error: error.message, code: error.code });
      }
      console.error("[dbc/create]", error);
      return json(res, 500, { ok: false, error: "Server error", code: error?.code });
    }
  };
}

const defaultHandler = createDbcCreateHandler();
export default async function dbcCreate(req, res) {
  return defaultHandler(req, res);
}

export { DbcCreateError, buildCreatePoolTransaction, poolConfigStateFromParams, serializeUnsigned, mapDraft };

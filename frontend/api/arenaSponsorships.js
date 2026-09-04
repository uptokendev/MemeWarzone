import { pool } from "../server/db.js";
import { badMethod, json, normalizeAddress, readJson } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { isSolanaChainId } from "./lib/chainNative.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import {
  readSponsorshipPricingConfig,
  serializeSponsorshipQuote,
  signSponsorshipQuote,
  sponsorshipSplit,
  verifySponsorshipPayment,
} from "./lib/arenaSponsorshipRuntime.mjs";

function ident(value) {
  return String(value || "").trim();
}

function routePath(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function centsToMicros(cents) {
  const n = BigInt(String(cents));
  if (n <= 0n) throw new Error("USD cents must be positive");
  return n * 10_000n;
}

function parseRequestedCents(value, minimumCents) {
  if (value === undefined || value === null || value === "") return BigInt(String(minimumCents));
  const requested = BigInt(String(value));
  if (requested < BigInt(String(minimumCents))) throw new Error("Requested sponsorship is below the authoritative minimum");
  return requested;
}

async function loadEvent(eventRef, chainId = null) {
  const value = ident(eventRef);
  if (!value) return null;
  const params = [value];
  let chainFilter = "";
  if (chainId != null) {
    params.push(Number(chainId));
    chainFilter = `and chain_id = $${params.length}`;
  }
  const result = await pool.query(
    `select id, event_type, event_reference_id, chain_id, starts_at, ends_at, sponsorship_open,
            prize_native_raw, sponsorship_prize_native_raw
       from public.sponsorship_events
      where (id::text = $1 or event_reference_id = $1)
        ${chainFilter}
      order by created_at desc
      limit 1`,
    params,
  );
  return result.rows[0] || null;
}

async function loadApprovedSponsor(wallet, chainId) {
  const normalized = normalizeAddress(wallet, Number(chainId));
  if (!normalized) return null;
  const solana = isSolanaChainId(Number(chainId));
  const verifiedMatch = solana ? `verified_wallet = $1` : `lower(verified_wallet) = lower($1)`;
  const result = await pool.query(
    `select id, project_name, wallet, verified_wallet, status, founding_sponsor
       from public.sponsor_profiles
      where status = 'approved'
        and verified_wallet is not null
        and ${verifiedMatch}
      order by approved_at desc nulls last, created_at desc
      limit 1`,
    [normalized],
  );
  return result.rows[0] || null;
}

async function activeTier() {
  const snapshot = (await pool.query(
    `select rolling_30d_qualified_users, active_tier_id, recommended_tier_id
       from public.sponsorship_traffic_snapshots
      order by snapshot_date desc, created_at desc
      limit 1`,
  )).rows[0];
  if (snapshot?.active_tier_id) {
    const row = (await pool.query(
      `select * from public.sponsorship_price_tiers where id = $1 and active = true limit 1`,
      [snapshot.active_tier_id],
    )).rows[0];
    if (row) return row;
  }
  const users = Number(snapshot?.rolling_30d_qualified_users || 0);
  return (await pool.query(
    `select * from public.sponsorship_price_tiers
      where active = true
        and effective_from <= now()
        and (effective_until is null or effective_until > now())
        and min_qualified_users <= $1
        and (max_qualified_users is null or max_qualified_users >= $1)
      order by sort_order asc
      limit 1`,
    [users],
  )).rows[0] || null;
}

function tierMinimumCents(tier, eventType) {
  if (!tier) throw new Error("No active sponsorship pricing tier is configured");
  if (eventType === "normal_tournament" || eventType === "vote_tournament") return BigInt(String(tier.tournament_min_usd_cents));
  if (eventType === "monthly_mwl") return BigInt(String(tier.mwl_min_usd_cents));
  if (eventType === "quarterly_championship") return BigInt(String(tier.quarterly_min_usd_cents));
  throw new Error("Unsupported sponsorship event type");
}

async function authoritativeMinimumCents(event, tier) {
  const override = (await pool.query(
    `select min_usd_cents
       from public.sponsorship_price_overrides
      where active = true
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at > now())
        and (event_type is null or event_type = $3)
        and (
          (scope_type = 'event' and scope_id in ($1, $2))
          or (scope_type = 'chain' and chain_id = $4)
        )
      order by case when scope_type = 'event' then 0 else 1 end, created_at desc
      limit 1`,
    [String(event.id), String(event.event_reference_id), String(event.event_type), Number(event.chain_id)],
  )).rows[0];
  return override ? BigInt(String(override.min_usd_cents)) : tierMinimumCents(tier, event.event_type);
}

async function handleQuote(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId || body.chain_id || 0);
  const event = await loadEvent(body.eventId || body.eventReferenceId, chainId || null);
  if (!event) return json(res, 404, { ok: false, error: "Sponsorship event not found", code: "SPONSORSHIP_EVENT_NOT_FOUND" });
  if (!event.sponsorship_open) return json(res, 409, { ok: false, error: "Sponsorship is closed for this event", code: "SPONSORSHIP_CLOSED" });
  if (isSolanaChainId(event.chain_id)) {
    return json(res, 409, { ok: false, error: "A Solana sponsorship router/vault is not active yet", code: "SPONSORSHIP_CHAIN_NOT_SUPPORTED" });
  }
  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", Number(event.chain_id));
  if (!wallet) return json(res, 400, { ok: false, error: "walletAddress is required", code: "SPONSORSHIP_WALLET_REQUIRED" });
  const sponsor = await loadApprovedSponsor(wallet, event.chain_id);
  if (!sponsor) return json(res, 403, { ok: false, error: "An approved profile with a verified sponsor wallet is required", code: "SPONSOR_PROFILE_NOT_APPROVED" });

  const tier = await activeTier();
  const minimumCents = await authoritativeMinimumCents(event, tier);
  let requestedCents;
  try {
    requestedCents = parseRequestedCents(body.requestedUsdCents, minimumCents);
  } catch (error) {
    return json(res, 409, { ok: false, error: String(error?.message || error), code: "SPONSORSHIP_BELOW_MINIMUM" });
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId: Number(event.chain_id),
    action: "arena_sponsorship_quote",
    routeLabel: "arena/sponsorships/quote",
    extraLines: [
      `Event: ${event.id}`,
      `Event Reference: ${event.event_reference_id}`,
      `Tier: ${tier.code}`,
      `Minimum USD cents: ${minimumCents}`,
      `Requested USD cents: ${requestedCents}`,
    ],
  });
  if (!verified) return;

  let config;
  let signed;
  try {
    config = readSponsorshipPricingConfig(event.chain_id);
    signed = await signSponsorshipQuote({
      config,
      eventUuid: event.id,
      sponsor: wallet,
      pricingTierCode: tier.code,
      minimumUsdMicros: centsToMicros(minimumCents),
      requestedUsdMicros: centsToMicros(requestedCents),
    });
  } catch (error) {
    return json(res, 503, { ok: false, error: "Sponsorship quote signing is unavailable", code: "SPONSORSHIP_QUOTE_UNAVAILABLE", detail: String(error?.message || error) });
  }

  const quote = serializeSponsorshipQuote(signed);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quoteRow = (await client.query(
      `insert into public.sponsorship_payment_quotes (
         event_id, chain_id, sponsor_profile_id, sponsor_wallet, pricing_tier_id, pricing_version,
         minimum_usd_cents, requested_usd_cents, requested_native_raw, minimum_native_raw,
         native_usd_reference_micro_cents, oracle_timestamp, expires_at, nonce
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13),$14)
       returning *`,
      [
        event.id,
        Number(event.chain_id),
        sponsor.id,
        wallet,
        tier.id,
        quote.value.pricingVersion,
        minimumCents.toString(),
        requestedCents.toString(),
        quote.value.requestedNativeRaw,
        quote.value.minimumNativeRaw,
        quote.value.nativeUsdReferenceMicros,
        quote.value.oracleTimestamp,
        quote.value.deadline,
        quote.value.nonce,
      ],
    )).rows[0];
    const sponsorship = (await client.query(
      `insert into public.event_sponsorships (
         event_id, sponsor_profile_id, pricing_tier_id, quote_id, status
       ) values ($1,$2,$3,$4,'pending_payment')
       returning id`,
      [event.id, sponsor.id, tier.id, quoteRow.id],
    )).rows[0];
    await client.query("commit");
    return json(res, 201, {
      ok: true,
      eventId: event.id,
      eventReferenceId: event.event_reference_id,
      eventType: event.event_type,
      sponsorshipId: sponsorship.id,
      quoteId: quoteRow.id,
      minimumUsdCents: minimumCents.toString(),
      requestedUsdCents: requestedCents.toString(),
      allocation: { prizeBps: 7000, marketingOpsBps: 2000, protocolBps: 1000 },
      quote,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleConfirm(req, res) {
  const internal = await requireInternalAuth(req, res, { routeLabel: "arena_sponsorship_confirm" });
  if (!internal) return;
  const body = await readJson(req);
  const quoteId = ident(body.quoteId || body.quote_id);
  const txHash = ident(body.txHash || body.tx_hash).toLowerCase();
  const logIndex = Number(body.logIndex ?? body.log_index);
  if (!quoteId || !/^0x[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(logIndex) || logIndex < 0) {
    return json(res, 400, { ok: false, error: "quoteId, txHash and logIndex are required", code: "SPONSORSHIP_CONFIRM_INPUT_REQUIRED" });
  }

  const quote = (await pool.query(
    `select q.*, e.event_reference_id, e.event_type, t.code as pricing_tier_code
       from public.sponsorship_payment_quotes q
       join public.sponsorship_events e on e.id = q.event_id
       left join public.sponsorship_price_tiers t on t.id = q.pricing_tier_id
      where q.id = $1
      limit 1`,
    [quoteId],
  )).rows[0];
  if (!quote) return json(res, 404, { ok: false, error: "Sponsorship quote not found", code: "SPONSORSHIP_QUOTE_NOT_FOUND" });
  if (!quote.pricing_tier_code) return json(res, 409, { ok: false, error: "Sponsorship quote has no authoritative pricing tier", code: "SPONSORSHIP_TIER_MISSING" });

  let proof;
  try {
    proof = await verifySponsorshipPayment({
      provider: getServerReadProvider(Number(quote.chain_id)),
      chainId: Number(quote.chain_id),
      txHash,
      logIndex,
      expected: {
        eventUuid: quote.event_id,
        sponsor: quote.sponsor_wallet,
        nonce: quote.nonce,
        pricingTierCode: quote.pricing_tier_code,
        pricingVersion: quote.pricing_version,
        minimumUsdMicros: centsToMicros(quote.minimum_usd_cents),
        requestedUsdMicros: centsToMicros(quote.requested_usd_cents),
        requestedNativeRaw: quote.requested_native_raw,
      },
    });
  } catch (error) {
    return json(res, 409, { ok: false, error: "Sponsorship payment could not be verified on-chain", code: "SPONSORSHIP_PAYMENT_UNVERIFIED", reason: String(error?.message || error) });
  }

  const split = sponsorshipSplit(proof.grossNativeRaw);
  const confirmedAt = proof.confirmedAt || new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`arena-sponsorship-tx:${txHash}:${logIndex}`]);
    const existing = (await client.query(
      `select p.id, p.event_sponsorship_id, p.status, p.confirmed_at
         from public.sponsorship_payments p
        where p.chain_id = $1 and lower(coalesce(p.tx_hash, '')) = $2
        limit 1`,
      [Number(quote.chain_id), txHash],
    )).rows[0];
    if (existing) {
      await client.query("rollback");
      return json(res, 200, { ok: true, idempotent: true, paymentId: existing.id, sponsorshipId: existing.event_sponsorship_id, proof: { txHash: proof.txHash, logIndex: proof.logIndex, blockNumber: proof.blockNumber } });
    }

    const sponsorship = (await client.query(
      `select id, status
         from public.event_sponsorships
        where quote_id = $1
        for update`,
      [quoteId],
    )).rows[0];
    if (!sponsorship) throw new Error("event-sponsorship-row-missing");
    const payment = (await client.query(
      `insert into public.sponsorship_payments (
         event_sponsorship_id, quote_id, chain_id, gross_native_raw, prize_native_raw,
         marketing_native_raw, protocol_native_raw, tx_hash, signature_reference, status, confirmed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10::timestamptz)
       returning id`,
      [
        sponsorship.id,
        quoteId,
        Number(quote.chain_id),
        split.gross.toString(),
        split.prize.toString(),
        split.marketing.toString(),
        split.protocol.toString(),
        txHash,
        `${txHash}:${logIndex}`,
        confirmedAt,
      ],
    )).rows[0];
    await client.query(
      `update public.event_sponsorships
          set status = 'active', gross_native_raw = $2, prize_native_raw = $3,
              marketing_native_raw = $4, protocol_native_raw = $5,
              activated_at = coalesce(activated_at, $6::timestamptz), updated_at = now()
        where id = $1`,
      [sponsorship.id, split.gross.toString(), split.prize.toString(), split.marketing.toString(), split.protocol.toString(), confirmedAt],
    );
    await client.query(
      `update public.sponsorship_events
          set sponsorship_prize_native_raw = sponsorship_prize_native_raw + $2,
              prize_native_raw = prize_native_raw + $2,
              updated_at = now()
        where id = $1`,
      [quote.event_id, split.prize.toString()],
    );
    await client.query("commit");
    return json(res, 201, {
      ok: true,
      paymentId: payment.id,
      sponsorshipId: sponsorship.id,
      allocation: {
        grossNativeRaw: split.gross.toString(),
        prizeNativeRaw: split.prize.toString(),
        marketingOpsNativeRaw: split.marketing.toString(),
        protocolNativeRaw: split.protocol.toString(),
        prizeBps: 7000,
        marketingOpsBps: 2000,
        protocolBps: 1000,
      },
      proof: { routerAddress: proof.routerAddress, txHash: proof.txHash, logIndex: proof.logIndex, blockNumber: proof.blockNumber, confirmedAt },
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const path = routePath(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (path === "/arena/sponsorships/quote") return method === "POST" ? handleQuote(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/confirm") return method === "POST" ? handleConfirm(req, res) : badMethod(res);
    return json(res, 404, { ok: false, error: "Unknown Arena sponsorship route" });
  } catch (error) {
    console.error("[api/arenaSponsorships]", error);
    return json(res, 503, { ok: false, error: "Arena sponsorship runtime is unavailable", detail: String(error?.message || error) });
  }
}

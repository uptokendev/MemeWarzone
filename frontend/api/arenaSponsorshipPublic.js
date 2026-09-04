import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { isSolanaChainId } from "./lib/chainNative.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { sponsorshipEventId } from "./lib/arenaSponsorshipRuntime.mjs";
import { readEventPrizeVaultV1, readSponsorshipEventV1 } from "./lib/solanaArenaMoneyV2Read.js";
import {
  assertSolanaPubkey,
  buildSolanaSponsorshipInstructionRequirements,
  quoteSolanaSponsorship,
  randomMoneyId32,
  verifySolanaSponsorshipPayment,
} from "./lib/solanaArenaMoneyV2Runtime.mjs";

const SUPPORTED_EVENT_TYPES = new Set(["normal_tournament", "vote_tournament", "monthly_mwl", "quarterly_championship"]);
const QUOTE_TTL_SECONDS = 300;

function pathOf(req) { return String(req.path || new URL(req.url, "http://localhost").pathname); }
function queryOf(req) { return new URL(req.url, "http://localhost").searchParams; }
function ident(value) { return String(value || "").trim(); }
function centsToMicros(cents) { return BigInt(String(cents)) * 10_000n; }

async function activeTier() {
  const snapshot = (await pool.query(`select rolling_30d_qualified_users, active_tier_id from public.sponsorship_traffic_snapshots order by snapshot_date desc, created_at desc limit 1`)).rows[0];
  if (snapshot?.active_tier_id) {
    const row = (await pool.query(`select * from public.sponsorship_price_tiers where id=$1 and active=true and effective_from<=now() and (effective_until is null or effective_until>now()) limit 1`, [snapshot.active_tier_id])).rows[0];
    if (row) return row;
  }
  const users = Number(snapshot?.rolling_30d_qualified_users || 0);
  return (await pool.query(`select * from public.sponsorship_price_tiers where active=true and effective_from<=now() and (effective_until is null or effective_until>now()) and min_qualified_users<=$1 and (max_qualified_users is null or max_qualified_users>=$1) order by sort_order asc limit 1`, [users])).rows[0] || null;
}

function tierMinimumCents(tier, type) {
  if (!tier) return null;
  if (type === "normal_tournament" || type === "vote_tournament") return BigInt(String(tier.tournament_min_usd_cents));
  if (type === "monthly_mwl") return BigInt(String(tier.mwl_min_usd_cents));
  if (type === "quarterly_championship") return BigInt(String(tier.quarterly_min_usd_cents));
  return null;
}

async function authoritativeMinimumCents(event, tier) {
  const base = tierMinimumCents(tier, event.event_type);
  if (base == null) return null;
  const override = (await pool.query(
    `select min_usd_cents from public.sponsorship_price_overrides
      where active=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now())
        and (event_type is null or event_type=$3)
        and ((scope_type='event' and scope_id in ($1,$2)) or (scope_type='chain' and chain_id=$4))
      order by case when scope_type='event' then 0 else 1 end, created_at desc limit 1`,
    [String(event.id), String(event.event_reference_id), String(event.event_type), Number(event.chain_id)],
  )).rows[0];
  return override ? BigInt(String(override.min_usd_cents)) : base;
}

async function loadEvent(ref, chainId = null) {
  const params = [ident(ref)];
  let chain = "";
  if (chainId != null) { params.push(Number(chainId)); chain = `and chain_id=$${params.length}`; }
  return (await pool.query(
    `select id,event_type,event_reference_id,chain_id,starts_at,ends_at,sponsorship_open,prize_native_raw,sponsorship_prize_native_raw
       from public.sponsorship_events where (id::text=$1 or event_reference_id=$1) ${chain}
       order by created_at desc limit 1`, params,
  )).rows[0] || null;
}

async function sponsorProfile(wallet, chainId) {
  if (!wallet) return null;
  const predicate = isSolanaChainId(chainId) ? "verified_wallet=$1" : "lower(verified_wallet)=lower($1)";
  return (await pool.query(
    `select id,project_name,verified_wallet,status,founding_sponsor from public.sponsor_profiles
      where verified_wallet is not null and ${predicate} order by approved_at desc nulls last,created_at desc limit 1`, [wallet],
  )).rows[0] || null;
}

function profileShape(profile) {
  return profile ? { id: profile.id, projectName: profile.project_name, status: profile.status, approved: profile.status === "approved", foundingSponsor: Boolean(profile.founding_sponsor) } : { status: "missing", approved: false, foundingSponsor: false };
}

async function solanaChainState(event) {
  if (!isSolanaChainId(event.chain_id)) return null;
  const eventId = sponsorshipEventId(event.id);
  const [onchainEvent, vault] = await Promise.all([readSponsorshipEventV1(event.chain_id, eventId), readEventPrizeVaultV1(event.chain_id, eventId)]);
  return {
    eventId,
    ready: Boolean(onchainEvent.ok && onchainEvent.event?.enabled && vault.ok),
    reason: !onchainEvent.ok ? onchainEvent.reason : !onchainEvent.event?.enabled ? "event-disabled" : !vault.ok ? vault.reason : "ok",
    eventPda: onchainEvent.pda || null,
    vaultPda: vault.pda || null,
    minimumLamports: onchainEvent.event?.minimumLamports?.toString?.() || null,
    prizeLamports: vault.vault?.prizeLamports?.toString?.() || null,
  };
}

async function handleOptions(req, res) {
  const query = queryOf(req);
  const walletRaw = ident(query.get("walletAddress") || query.get("wallet"));
  const chainFilter = query.get("chainId") ? Number(query.get("chainId")) : null;
  const tier = await activeTier();
  const rows = (await pool.query(
    `select id,event_type,event_reference_id,chain_id,starts_at,ends_at,sponsorship_open,prize_native_raw,sponsorship_prize_native_raw
       from public.sponsorship_events
      where event_type = any($1::text[]) and ($2::integer is null or chain_id=$2)
      order by starts_at asc nulls last, created_at desc`,
    [[...SUPPORTED_EVENT_TYPES], Number.isInteger(chainFilter) ? chainFilter : null],
  )).rows;
  const options = [];
  for (const event of rows) {
    const minimum = await authoritativeMinimumCents(event, tier);
    let wallet = walletRaw;
    if (wallet && isSolanaChainId(event.chain_id)) { try { wallet = assertSolanaPubkey(wallet); } catch { wallet = ""; } }
    const profile = wallet ? await sponsorProfile(wallet, Number(event.chain_id)) : null;
    const chainState = await solanaChainState(event);
    const open = Boolean(event.sponsorship_open) && (!event.ends_at || new Date(event.ends_at).getTime() > Date.now());
    options.push({
      eventId: String(event.id), eventReferenceId: event.event_reference_id, eventType: event.event_type, chainId: Number(event.chain_id),
      sponsorshipOpen: open, authoritativeTier: tier ? { id: tier.id, code: tier.code } : null,
      minimumUsdCents: minimum?.toString() || null, sponsorProfile: profileShape(profile), chainState,
      allowedRequest: minimum == null ? null : { minimumUsdCents: minimum.toString(), maximumUsdCents: null },
      allocation: { prizeBps: 7000, marketingOpsBps: 2000, protocolBps: 1000 },
    });
  }
  res.setHeader("cache-control", "no-store");
  return json(res, 200, { ok: true, options, supportedEventTypes: [...SUPPORTED_EVENT_TYPES], individualBattleSponsorship: false });
}

async function handleState(req, res, eventRef) {
  const event = await loadEvent(eventRef);
  if (!event || !SUPPORTED_EVENT_TYPES.has(event.event_type)) return json(res, 404, { ok: false, error: "Sponsorship event not found" });
  const sponsors = (await pool.query(
    `select es.id,es.status,es.prize_native_raw,es.activated_at,sp.project_name,sp.founding_sponsor,sp.verified_wallet,
            p.status as payment_status,p.confirmed_at
       from public.event_sponsorships es
       join public.sponsor_profiles sp on sp.id=es.sponsor_profile_id
       left join lateral (select status,confirmed_at from public.sponsorship_payments where event_sponsorship_id=es.id order by confirmed_at desc nulls last limit 1) p on true
      where es.event_id=$1 and es.status in ('active','completed') order by es.activated_at asc nulls last,es.created_at asc`, [event.id],
  )).rows;
  const chainState = await solanaChainState(event);
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    event: { id: String(event.id), referenceId: event.event_reference_id, type: event.event_type, chainId: Number(event.chain_id), sponsorshipOpen: Boolean(event.sponsorship_open) && (!event.ends_at || new Date(event.ends_at).getTime() > Date.now()), prizeNativeRaw: String(event.prize_native_raw || 0), sponsorshipPrizeNativeRaw: String(event.sponsorship_prize_native_raw || 0) },
    sponsors: sponsors.map((row) => ({ sponsorshipId: row.id, projectName: row.project_name, foundingSponsor: Boolean(row.founding_sponsor), prizeContributionNativeRaw: String(row.prize_native_raw || 0), status: row.status, paymentStatus: row.payment_status || null, confirmedAt: row.confirmed_at || null })),
    foundingSponsors: sponsors.filter((r) => r.founding_sponsor).map((r) => ({ projectName: r.project_name, sponsorshipId: r.id })),
    chainState,
    allocation: { prizeBps: 7000, marketingOpsBps: 2000, protocolBps: 1000 },
  });
}

async function handlePaymentReadback(_req, res, quoteId) {
  const row = (await pool.query(
    `select q.id as quote_id,q.event_id,q.chain_id,q.expires_at,q.solana_receipt_pda,es.id as sponsorship_id,es.status as sponsorship_status,
            p.id as payment_id,p.status as payment_status,p.confirmed_at,p.signature_reference
       from public.sponsorship_payment_quotes q
       left join public.event_sponsorships es on es.quote_id=q.id
       left join lateral (select id,status,confirmed_at,signature_reference from public.sponsorship_payments where quote_id=q.id order by confirmed_at desc nulls last limit 1) p on true
      where q.id=$1 limit 1`, [quoteId],
  )).rows[0];
  if (!row) return json(res, 404, { ok: false, error: "Sponsorship quote not found" });
  res.setHeader("cache-control", "no-store");
  return json(res, 200, { ok: true, quoteId: row.quote_id, eventId: row.event_id, chainId: Number(row.chain_id), sponsorshipId: row.sponsorship_id || null, sponsorshipStatus: row.sponsorship_status || "pending_payment", payment: { verified: row.payment_status === "confirmed", status: row.payment_status || "pending", confirmedAt: row.confirmed_at || null, signature: row.signature_reference || null, receiptPda: row.solana_receipt_pda || null }, expiresAt: row.expires_at });
}

async function handleSolanaQuote(req, res) {
  const body = await readJson(req);
  const event = await loadEvent(body.eventId || body.eventReferenceId, body.chainId ?? null);
  if (!event || !SUPPORTED_EVENT_TYPES.has(event.event_type) || !isSolanaChainId(event.chain_id)) return json(res, 404, { ok: false, error: "Eligible Solana sponsorship event not found" });
  if (!event.sponsorship_open || (event.ends_at && new Date(event.ends_at).getTime() <= Date.now())) return json(res, 409, { ok: false, error: "Sponsorship is closed", code: "SPONSORSHIP_CLOSED" });
  let wallet;
  try { wallet = assertSolanaPubkey(body.walletAddress || body.auth?.walletAddress, "walletAddress"); } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  const profile = await sponsorProfile(wallet, Number(event.chain_id));
  if (!profile || profile.status !== "approved") return json(res, 403, { ok: false, error: "Approved sponsor profile is required", code: "SPONSOR_PROFILE_NOT_APPROVED" });
  const tier = await activeTier();
  const minimumCents = await authoritativeMinimumCents(event, tier);
  if (minimumCents == null) return json(res, 503, { ok: false, error: "Sponsorship pricing is unavailable" });
  let requestedCents;
  try { requestedCents = body.requestedUsdCents == null ? minimumCents : BigInt(String(body.requestedUsdCents)); } catch { return json(res, 400, { ok: false, error: "requestedUsdCents must be an integer" }); }
  if (requestedCents < minimumCents) return json(res, 409, { ok: false, error: "Requested sponsorship is below the authoritative minimum", code: "SPONSORSHIP_BELOW_MINIMUM" });
  const auth = await requireWalletActionAuth({ res, pool, auth: body.auth || body, expectedWallet: wallet, chainId: Number(event.chain_id), action: "arena_sponsorship_quote", routeLabel: "arena/sponsorships/solana-quote", extraLines: [`Event: ${event.id}`, `Tier: ${tier.code}`, `Minimum USD cents: ${minimumCents}`, `Requested USD cents: ${requestedCents}`] });
  if (!auth || auth.legacy) return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined;

  const eventId = sponsorshipEventId(event.id);
  const [onchainEvent, vault] = await Promise.all([readSponsorshipEventV1(event.chain_id, eventId), readEventPrizeVaultV1(event.chain_id, eventId)]);
  if (!onchainEvent.ok || !onchainEvent.event?.enabled || !vault.ok) return json(res, 503, { ok: false, error: "Solana sponsorship event/vault is not active", code: "SOLANA_SPONSORSHIP_NOT_ACTIVE", reason: onchainEvent.reason || vault.reason });
  let money, minimumMoney;
  try {
    money = quoteSolanaSponsorship({ chainId: event.chain_id, requestedUsdMicros: centsToMicros(requestedCents) });
    minimumMoney = quoteSolanaSponsorship({ chainId: event.chain_id, requestedUsdMicros: centsToMicros(minimumCents) });
  } catch (error) { return json(res, 503, { ok: false, error: "SOL sponsorship pricing is unavailable", detail: String(error?.message || error) }); }
  if (money.gross < onchainEvent.event.minimumLamports || minimumMoney.gross < onchainEvent.event.minimumLamports) return json(res, 409, { ok: false, error: "On-chain sponsorship minimum exceeds authoritative USD minimum", code: "SOLANA_SPONSORSHIP_MINIMUM_MISMATCH" });
  const paymentId = randomMoneyId32();
  const transaction = buildSolanaSponsorshipInstructionRequirements({ eventId, paymentId, sponsor: wallet, grossLamports: money.gross });
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quote = (await client.query(
      `insert into public.sponsorship_payment_quotes (
         event_id,chain_id,sponsor_profile_id,sponsor_wallet,pricing_tier_id,pricing_version,minimum_usd_cents,requested_usd_cents,
         requested_native_raw,minimum_native_raw,native_usd_reference_micro_cents,oracle_timestamp,expires_at,nonce,solana_payment_id,solana_receipt_pda
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13),$14,$15,$16) returning id`,
      [event.id,event.chain_id,profile.id,wallet,tier.id,money.pricingVersion.toString(),minimumCents.toString(),requestedCents.toString(),money.gross.toString(),minimumMoney.gross.toString(),money.nativeUsdMicros.toString(),money.oracleTimestamp.toString(),expiresAtSeconds,BigInt(paymentId).toString(),paymentId,transaction.receiptPda],
    )).rows[0];
    const sponsorship = (await client.query(`insert into public.event_sponsorships(event_id,sponsor_profile_id,pricing_tier_id,quote_id,status) values($1,$2,$3,$4,'pending_payment') returning id`, [event.id,profile.id,tier.id,quote.id])).rows[0];
    await client.query("commit");
    return json(res, 201, { ok: true, eventId: String(event.id), eventReferenceId: event.event_reference_id, eventType: event.event_type, chainId: Number(event.chain_id), sponsorshipId: sponsorship.id, quoteId: quote.id, minimumUsdCents: minimumCents.toString(), requestedUsdCents: requestedCents.toString(), grossLamports: money.gross.toString(), prizeLamports: money.prize.toString(), marketingLamports: money.marketing.toString(), protocolLamports: money.protocol.toString(), allocation: { prizeBps: 7000, marketingOpsBps: 2000, protocolBps: 1000 }, paymentId, transaction, expiresAt: new Date(expiresAtSeconds * 1000).toISOString() });
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

async function handleSolanaPayment(req, res) {
  const body = await readJson(req);
  const quoteId = ident(body.quoteId);
  const signature = ident(body.signature || body.txSignature);
  if (!quoteId || !signature) return json(res, 400, { ok: false, error: "quoteId and signature are required" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const quote = (await client.query(
      `select q.*,e.event_type,e.event_reference_id from public.sponsorship_payment_quotes q join public.sponsorship_events e on e.id=q.event_id where q.id=$1 for update`, [quoteId],
    )).rows[0];
    if (!quote || !isSolanaChainId(quote.chain_id) || !quote.solana_payment_id) { await client.query("rollback"); return json(res, 404, { ok: false, error: "Solana sponsorship quote not found" }); }
    const existing = (await client.query(`select p.id,p.event_sponsorship_id,p.status,p.confirmed_at from public.sponsorship_payments p where p.quote_id=$1 limit 1`, [quoteId])).rows[0];
    if (existing?.status === "confirmed") { await client.query("rollback"); return json(res, 200, { ok: true, idempotent: true, paymentId: existing.id, sponsorshipId: existing.event_sponsorship_id, confirmedAt: existing.confirmed_at }); }
    const auth = await requireWalletActionAuth({ res, pool: client, auth: body.auth || body, expectedWallet: quote.sponsor_wallet, chainId: Number(quote.chain_id), action: "arena_sponsorship_payment", routeLabel: "arena/sponsorships/solana-payment", extraLines: [`Quote: ${quoteId}`, `Signature: ${signature}`] });
    if (!auth || auth.legacy) { await client.query("rollback"); return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined; }
    const eventId = sponsorshipEventId(quote.event_id);
    const gross = BigInt(quote.requested_native_raw);
    const money = quoteSolanaSponsorship({ chainId: quote.chain_id, requestedUsdMicros: centsToMicros(quote.requested_usd_cents), pricing: { chainId: Number(quote.chain_id), nativeUsdMicros: BigInt(quote.native_usd_reference_micro_cents), pricingVersion: BigInt(quote.pricing_version), oracleTimestamp: BigInt(Math.floor(new Date(quote.oracle_timestamp).getTime()/1000)), nativeDecimals: 9 } });
    if (money.gross !== gross) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Stored sponsorship quote no longer conserves", code: "SPONSORSHIP_QUOTE_MISMATCH" }); }
    let proof;
    try { proof = await verifySolanaSponsorshipPayment({ chainId: quote.chain_id, signature, eventId, paymentId: quote.solana_payment_id, sponsor: quote.sponsor_wallet, grossLamports: gross, prizeLamports: money.prize, marketingLamports: money.marketing, protocolLamports: money.protocol }); }
    catch (error) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Solana sponsorship payment is not authoritative", code: "SPONSORSHIP_PAYMENT_UNVERIFIED", reason: String(error?.message || error) }); }
    if (Number(proof.receipt.createdAt) * 1000 > new Date(quote.expires_at).getTime()) { await client.query("rollback"); return json(res, 409, { ok: false, error: "Sponsorship payment was created after quote expiry", code: "SPONSORSHIP_QUOTE_EXPIRED" }); }
    const sponsorship = (await client.query(`select id,status from public.event_sponsorships where quote_id=$1 for update`, [quoteId])).rows[0];
    if (!sponsorship) throw new Error("event-sponsorship-row-missing");
    const confirmedAt = new Date(Number(proof.receipt.createdAt) * 1000).toISOString();
    const payment = (await client.query(
      `insert into public.sponsorship_payments(event_sponsorship_id,quote_id,chain_id,gross_native_raw,prize_native_raw,marketing_native_raw,protocol_native_raw,tx_hash,signature_reference,status,confirmed_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$8,'confirmed',$9::timestamptz) returning id`,
      [sponsorship.id,quoteId,quote.chain_id,money.gross.toString(),money.prize.toString(),money.marketing.toString(),money.protocol.toString(),signature,confirmedAt],
    )).rows[0];
    await client.query(`update public.event_sponsorships set status='active',gross_native_raw=$2,prize_native_raw=$3,marketing_native_raw=$4,protocol_native_raw=$5,activated_at=coalesce(activated_at,$6::timestamptz),updated_at=now() where id=$1`, [sponsorship.id,money.gross.toString(),money.prize.toString(),money.marketing.toString(),money.protocol.toString(),confirmedAt]);
    await client.query(`update public.sponsorship_events set sponsorship_prize_native_raw=sponsorship_prize_native_raw+$2,prize_native_raw=prize_native_raw+$2,updated_at=now() where id=$1`, [quote.event_id,money.prize.toString()]);
    await client.query("commit");
    return json(res, 201, { ok: true, paymentId: payment.id, sponsorshipId: sponsorship.id, signature, receiptPda: proof.receiptPda, confirmedAt, allocation: { grossNativeRaw: money.gross.toString(), prizeNativeRaw: money.prize.toString(), marketingOpsNativeRaw: money.marketing.toString(), protocolNativeRaw: money.protocol.toString(), prizeBps: 7000, marketingOpsBps: 2000, protocolBps: 1000 } });
  } catch (error) { await client.query("rollback").catch(() => {}); console.error("[api/arenaSponsorshipPublic] Solana payment", error); return json(res, 500, { ok: false, error: "Failed to confirm Solana sponsorship" }); } finally { client.release(); }
}

export default async function handler(req, res) {
  const path = pathOf(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (path === "/arena/sponsorships/options") return method === "GET" ? handleOptions(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/solana-quote") return method === "POST" ? handleSolanaQuote(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/solana-payment") return method === "POST" ? handleSolanaPayment(req, res) : badMethod(res);
    let m = path.match(/^\/arena\/sponsorships\/payments\/([^/]+)$/);
    if (m) return method === "GET" ? handlePaymentReadback(req, res, decodeURIComponent(m[1])) : badMethod(res);
    m = path.match(/^\/arena\/sponsorships\/([^/]+)\/state$/);
    if (m) return method === "GET" ? handleState(req, res, decodeURIComponent(m[1])) : badMethod(res);
    return json(res, 404, { ok: false, error: "Unknown public Arena sponsorship route" });
  } catch (error) {
    console.error("[api/arenaSponsorshipPublic]", error);
    return json(res, 503, { ok: false, error: "Arena sponsorship public runtime is unavailable", detail: String(error?.message || error) });
  }
}

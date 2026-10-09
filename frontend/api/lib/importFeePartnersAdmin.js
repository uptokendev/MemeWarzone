/**
 * Command Center "Partners": swap-widget partners (import_fee_partners) added and changed from the dashboard
 * instead of by SQL (founder, 2026-10-10). A partner is one row per chain: its payout wallet and the split of the
 * 1% fee (creator_bps / partner_bps of the fee, the rest is ours). Swaps are attributed by build fingerprint
 * (importSwapFingerprint.js), so a new row needs no account, contract or deploy; the widget passes `partner: "<id>"`.
 *
 * Rules: id and chain never change (they key the ledger). A switched-off partner earns nothing on swaps that land
 * afterwards but is still paid what it earned. A payout wallet change sends everything still owed to the new
 * wallet. Every create / update writes import_fee_partner_audit in the same transaction.
 */
import { PublicKey } from "@solana/web3.js";

export const PARTNER_CHAINS = Object.freeze([101, 56, 4663, 97, 46630, 6281971]);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export class PartnerAdminError extends Error {
  constructor(message, status = 400, code = "PARTNER_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, code = "PARTNER_INVALID", status = 400) {
  throw new PartnerAdminError(message, status, code);
}

/** The payout wallet for a chain: a Solana wallet on the curve (the worker skips anything else) or an EVM address. */
export function normalizePayoutWallet(chainId, raw) {
  const wallet = String(raw ?? "").trim();
  if (Number(chainId) === 101) {
    try {
      const key = new PublicKey(wallet);
      if (key.toBase58() === wallet && PublicKey.isOnCurve(key.toBytes())) return wallet;
    } catch {
      // fall through
    }
    fail("Payout wallet must be a Solana wallet address (not a token account or program).", "PARTNER_WALLET_INVALID");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) fail("Payout wallet must be a 0x address.", "PARTNER_WALLET_INVALID");
  return wallet.toLowerCase();
}

function bps(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) fail(`${label} must be a whole number of basis points between 0 and 10000.`);
  return n;
}

/** Validated create input. Defaults: creator 50% / partner 25% of the fee (founder, 2026-10-09). */
export function parsePartnerCreate(body) {
  const id = String(body?.id ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) fail("Partner id: 2 to 41 lowercase letters, digits or dashes, starting with a letter or digit.", "PARTNER_ID_INVALID");
  const chainId = Number(body?.chainId);
  if (!PARTNER_CHAINS.includes(chainId)) fail(`Chain must be one of ${PARTNER_CHAINS.join(", ")}.`, "PARTNER_CHAIN_INVALID");
  const name = String(body?.name ?? "").trim();
  if (name.length < 1 || name.length > 80) fail("Name: 1 to 80 characters.");
  const payoutWallet = normalizePayoutWallet(chainId, body?.payoutWallet);
  const creatorBps = bps(body?.creatorBps, 5000, "Creator share");
  const partnerBps = bps(body?.partnerBps, 2500, "Partner share");
  if (creatorBps + partnerBps > 10_000) fail("Creator share + partner share cannot be more than 100% of the fee.");
  return { id, chainId, name, payoutWallet, creatorBps, partnerBps, active: body?.active === false ? false : true };
}

/** Validated update: only the fields given. id and chain_id never change. */
export function parsePartnerUpdate(body, current) {
  const next = {};
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 1 || name.length > 80) fail("Name: 1 to 80 characters.");
    next.name = name;
  }
  if (body?.payoutWallet !== undefined) next.payout_wallet = normalizePayoutWallet(current.chain_id, body.payoutWallet);
  if (body?.creatorBps !== undefined) next.creator_bps = bps(body.creatorBps, null, "Creator share");
  if (body?.partnerBps !== undefined) next.partner_bps = bps(body.partnerBps, null, "Partner share");
  if (body?.active !== undefined) {
    if (typeof body.active !== "boolean") fail("active must be true or false.");
    next.active = body.active;
  }
  const creator = next.creator_bps ?? Number(current.creator_bps);
  const partner = next.partner_bps ?? Number(current.partner_bps);
  if (creator + partner > 10_000) fail("Creator share + partner share cannot be more than 100% of the fee.");
  if (!Object.keys(next).length) fail("Nothing to change.", "PARTNER_NOTHING_TO_CHANGE");
  return next;
}

const ROW = `id, chain_id, name, fee_account, payout_wallet, creator_bps, partner_bps, active, created_at, updated_at`;

function publicRow(row) {
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    name: String(row.name),
    feeAccount: row.fee_account ? String(row.fee_account) : null,
    payoutWallet: String(row.payout_wallet),
    creatorBps: Number(row.creator_bps),
    partnerBps: Number(row.partner_bps),
    active: Boolean(row.active),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** Every partner with what it earned (partner_raw), what was paid / is being sent, and its swaps. */
export async function listPartners(db) {
  const { rows } = await db.query(
    `select p.id, p.chain_id, p.name, p.fee_account, p.payout_wallet, p.creator_bps, p.partner_bps, p.active, p.created_at, p.updated_at,
            coalesce(f.earned, 0)::text as earned_raw, coalesce(f.swaps, 0)::int as swaps, f.last_swap_at,
            coalesce(t.paid, 0)::text as paid_raw, coalesce(t.sending, 0)::text as sending_raw, t.last_paid_at
       from public.import_fee_partners p
       left join lateral (
         select sum(partner_raw) as earned, count(*) as swaps, max(occurred_at) as last_swap_at
           from public.finance_import_swap_fees where chain_id = p.chain_id and partner_id = p.id
       ) f on true
       left join lateral (
         select sum(amount_raw) filter (where status = 'landed') as paid,
                sum(amount_raw) filter (where status = 'sending') as sending,
                max(updated_at) filter (where status = 'landed') as last_paid_at
           from public.import_fee_transfers where chain_id = p.chain_id and kind = 'partner' and partner_id = p.id
       ) t on true
      order by p.active desc, p.id, p.chain_id`,
  );
  return rows.map((row) => {
    const earned = BigInt(row.earned_raw || "0");
    const paid = BigInt(row.paid_raw || "0");
    const sending = BigInt(row.sending_raw || "0");
    const owed = earned - paid - sending;
    return {
      ...publicRow(row),
      swaps: Number(row.swaps || 0),
      lastSwapAt: row.last_swap_at ? new Date(row.last_swap_at).toISOString() : null,
      earnedRaw: earned.toString(),
      paidRaw: paid.toString(),
      sendingRaw: sending.toString(),
      owedRaw: (owed > 0n ? owed : 0n).toString(),
      lastPaidAt: row.last_paid_at ? new Date(row.last_paid_at).toISOString() : null,
    };
  });
}

export async function listPartnerAudit(db, limit = 50) {
  const { rows } = await db.query(
    `select id, occurred_at, actor_email, action, partner_id, chain_id, before, after
       from public.import_fee_partner_audit order by occurred_at desc, id desc limit $1`,
    [Math.max(1, Math.min(200, Number(limit) || 50))],
  );
  return rows.map((row) => ({
    id: String(row.id),
    occurredAt: new Date(row.occurred_at).toISOString(),
    actorEmail: String(row.actor_email),
    action: String(row.action),
    partnerId: String(row.partner_id),
    chainId: Number(row.chain_id),
    before: row.before || null,
    after: row.after || null,
  }));
}

async function audit(client, actor, action, partner, before, after) {
  await client.query(
    `insert into public.import_fee_partner_audit (actor_id, actor_email, action, partner_id, chain_id, before, after)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [actor?.id ? String(actor.id) : null, String(actor?.email || "unknown"), action, partner.id, partner.chainId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

async function inTransaction(db, fn) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error?.code === "42P01") throw new PartnerAdminError("Partner tables are missing: apply db/migrations/20261010_000010_import_fee_partner_audit.sql.", 503, "PARTNER_SCHEMA_MISSING");
    throw error;
  } finally {
    if (client !== db) client.release?.();
  }
}

export async function createPartner(db, body, actor) {
  const input = parsePartnerCreate(body);
  return inTransaction(db, async (client) => {
    const { rows } = await client.query(
      `insert into public.import_fee_partners (id, chain_id, name, fee_account, payout_wallet, creator_bps, partner_bps, active)
       values ($1, $2, $3, null, $4, $5, $6, $7)
       on conflict (id, chain_id) do nothing
       returning ${ROW}`,
      [input.id, input.chainId, input.name, input.payoutWallet, input.creatorBps, input.partnerBps, input.active],
    );
    if (!rows[0]) fail(`Partner "${input.id}" already exists on chain ${input.chainId}.`, "PARTNER_EXISTS", 409);
    const created = publicRow(rows[0]);
    await audit(client, actor, "create", created, null, created);
    return created;
  });
}

export async function updatePartner(db, { id, chainId, body }, actor) {
  const key = { id: String(id || "").trim().toLowerCase(), chainId: Number(chainId) };
  if (!ID_RE.test(key.id) || !PARTNER_CHAINS.includes(key.chainId)) fail("Unknown partner.", "PARTNER_NOT_FOUND", 404);
  return inTransaction(db, async (client) => {
    const current = (await client.query(`select ${ROW} from public.import_fee_partners where id = $1 and chain_id = $2 for update`, [key.id, key.chainId])).rows[0];
    if (!current) fail("Unknown partner.", "PARTNER_NOT_FOUND", 404);
    const next = parsePartnerUpdate(body, current);
    const columns = Object.keys(next);
    const sets = columns.map((column, i) => `${column} = $${i + 3}`).join(", ");
    const { rows } = await client.query(
      `update public.import_fee_partners set ${sets}, updated_at = now() where id = $1 and chain_id = $2 returning ${ROW}`,
      [key.id, key.chainId, ...columns.map((column) => next[column])],
    );
    const before = publicRow(current);
    const after = publicRow(rows[0]);
    await audit(client, actor, "update", after, before, after);
    return after;
  });
}

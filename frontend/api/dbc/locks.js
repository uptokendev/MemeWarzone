/**
 * GET /api/dbc/locks?mint= — recorded creator locks for the token page badge.
 * POST /api/dbc/locks — verify a Jupiter Lock escrow on chain and store it.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { json, badMethod, readJson } from "../../server/http.js";
import { DBC_JUPITER_LOCK_PROGRAM_ID, DBC_LOCK_FREQUENCY_SECONDS, DBC_LOCK_PERIODS } from "../../shared/dbcEconomics.mjs";
import { escrowLockedAmount, parseVestingEscrow } from "../../src/lib/dbcJupiterLock.mjs";
import { lockFullyFreeUnix } from "../../shared/dbcLockSchedule.mjs";

const LOCK_PROGRAM = DBC_JUPITER_LOCK_PROGRAM_ID;

export class DbcLockRecordError extends Error {
  constructor(message, { code = "DBC_LOCK_REFUSED", httpStatus = 400 } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function assertEscrowMatchesLock({ parsed, mint, creator, amount }) {
  if (!parsed) throw new DbcLockRecordError("Escrow could not be decoded.", { code: "DBC_LOCK_UNREADABLE" });
  if (String(parsed.recipient) !== String(creator)) {
    throw new DbcLockRecordError("Escrow recipient is not the creator.", { code: "DBC_LOCK_RECIPIENT" });
  }
  if (String(parsed.tokenMint) !== String(mint)) {
    throw new DbcLockRecordError("Escrow mint does not match this coin.", { code: "DBC_LOCK_MINT" });
  }
  if (Number(parsed.cancelMode) !== 0) {
    throw new DbcLockRecordError("Escrow cancel mode must be 0.", { code: "DBC_LOCK_CANCEL_MODE" });
  }
  if (Number(parsed.updateRecipientMode) !== 0) {
    throw new DbcLockRecordError("Escrow recipient updates must be disabled.", { code: "DBC_LOCK_RECIPIENT_MODE" });
  }
  if (amount != null && escrowLockedAmount(parsed) !== BigInt(amount)) {
    throw new DbcLockRecordError("Escrow amount does not match the locked buy.", { code: "DBC_LOCK_AMOUNT" });
  }
  return true;
}

export function createDbcLocksHandler(deps = {}) {
  const env = deps.env || process.env;

  async function db() {
    if (deps.db) return deps.db;
    const mod = await import("../../server/db.js");
    return mod.pool;
  }

  function connection() {
    if (deps.connection) return deps.connection;
    const url = env.SOLANA_RPC_URL || env.SOLANA_RPC_HTTP;
    if (!url) throw new DbcLockRecordError("SOLANA_RPC_URL is required", { code: "DBC_RPC_MISSING", httpStatus: 503 });
    return new Connection(url, "confirmed");
  }

  async function handleGet(req, res) {
    const url = new URL(req.url || "http://localhost/", "http://localhost");
    const mint = String(url.searchParams.get("mint") || url.searchParams.get("token") || "").trim();
    if (!mint) return json(res, 400, { ok: false, error: "mint is required", code: "DBC_LOCK_BAD_MINT" });
    const database = await db();
    const found = await database.query(
      `select pool, mint, creator, escrow, amount, cliff, frequency, periods, tx, created_at
         from public.dbc_creator_locks
        where mint = $1
        order by created_at asc`,
      [mint],
    );
    const rows = found.rows || [];
    let locked = 0n;
    let fullyFree = 0;
    for (const row of rows) {
      locked += BigInt(row.amount || 0);
      const until = lockFullyFreeUnix(Number(row.cliff));
      if (until > fullyFree) fullyFree = until;
    }
    return json(res, 200, {
      ok: true,
      mint,
      locks: rows.map((row) => ({
        pool: row.pool,
        mint: row.mint,
        creator: row.creator,
        escrow: row.escrow,
        amount: String(row.amount),
        cliff: Number(row.cliff),
        frequency: Number(row.frequency),
        periods: Number(row.periods),
        tx: row.tx,
        createdAt: row.created_at,
      })),
      lockedAmount: locked.toString(),
      fullyFreeUnix: fullyFree || null,
    });
  }

  async function handlePost(body, res) {
    const pool = String(body.pool || "").trim();
    const mint = String(body.mint || "").trim();
    const creator = String(body.creator || "").trim();
    const escrow = String(body.escrow || "").trim();
    const tx = String(body.tx || body.signature || "").trim();
    const amountHint = body.amount != null ? BigInt(String(body.amount)) : null;
    if (!pool || !mint || !creator || !escrow) {
      return json(res, 400, { ok: false, error: "pool, mint, creator and escrow are required", code: "DBC_LOCK_BAD_BODY" });
    }

    const conn = connection();
    const info = deps.readAccount
      ? await deps.readAccount(escrow)
      : await conn.getAccountInfo(new PublicKey(escrow), "confirmed");
    if (!info) {
      throw new DbcLockRecordError("Escrow account is not on chain.", { code: "DBC_LOCK_MISSING", httpStatus: 404 });
    }
    if (String(info.owner?.toBase58?.() || info.owner) !== LOCK_PROGRAM) {
      throw new DbcLockRecordError("Escrow is not owned by Jupiter Lock.", { code: "DBC_LOCK_OWNER" });
    }
    const parsed = parseVestingEscrow(info.data);
    assertEscrowMatchesLock({ parsed, mint, creator, amount: amountHint });

    const database = await db();
    const campaign = await database.query(
      `select campaign_address, token_address, creator_address
         from public.campaigns
        where chain_id = 101
          and coalesce(launch_type, 'launchpad') = 'dbc'
          and campaign_address = $1
          and token_address = $2
        limit 1`,
      [pool, mint],
    );
    const row = campaign.rows?.[0];
    if (!row) throw new DbcLockRecordError("Not a DBC campaign.", { code: "DBC_LOCK_NOT_DBC", httpStatus: 404 });
    if (String(row.creator_address) !== creator) {
      throw new DbcLockRecordError("Creator does not match the campaign.", { code: "DBC_LOCK_CREATOR" });
    }

    const amount = escrowLockedAmount(parsed);
    const inserted = await database.query(
      `insert into public.dbc_creator_locks
         (pool, mint, creator, escrow, amount, cliff, frequency, periods, tx)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (escrow) do update set tx = excluded.tx
       returning pool, mint, creator, escrow, amount, cliff, frequency, periods, tx, created_at`,
      [
        pool,
        mint,
        creator,
        escrow,
        amount.toString(),
        Number(parsed.cliffTime),
        Number(parsed.frequency || DBC_LOCK_FREQUENCY_SECONDS),
        Number(parsed.numberOfPeriod || DBC_LOCK_PERIODS),
        tx || null,
      ],
    );
    return json(res, 200, { ok: true, lock: inserted.rows[0], parsed });
  }

  return async function handle(req, res) {
    const method = String(req.method || "").toUpperCase();
    try {
      if (method === "GET") return handleGet(req, res);
      if (method === "POST") {
        const body = await readJson(req);
        return handlePost(body, res);
      }
      return badMethod(res);
    } catch (error) {
      if (error instanceof DbcLockRecordError) {
        return json(res, error.httpStatus || 400, { ok: false, error: error.message, code: error.code });
      }
      console.error("[dbc/locks]", error);
      return json(res, 500, { ok: false, error: "lock record failed", code: "DBC_LOCK_ERROR" });
    }
  };
}

const defaultHandler = createDbcLocksHandler();
export default async function dbcLocks(req, res) {
  return defaultHandler(req, res);
}

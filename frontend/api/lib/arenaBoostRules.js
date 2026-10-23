/**
 * Boost rules (founder, 2026-10-15), for normal battles, Vote Battles and Vote Tournament rounds:
 *
 *   - One wallet buys at most 2 Boosts per battle, both sides together. A tournament matchup is
 *     its own battle row, so in a tournament the 2 apply per matchup.
 *   - Boosts close when 80% of the battle clock has run: no Boosts in the last 20%.
 *   - A Vote Battle / Vote Tournament Boost is worth 1 point (VOTE_BATTLE_BOOST_POINTS_PER_UNIT).
 *     Normal battles keep the Battle Points V3 curve.
 *
 * Points are stored per confirmed action, so Boosts confirmed before this change keep the points
 * they were sold with.
 *
 * The rules are enforced where the server signs a Boost quote; no Boost can be paid without one.
 * EVM quotes carry a deadline that the treasury enforces (block.timestamp <= deadline), and the
 * server clamps it to the Boost close. Solana quotes carry expires_at, clamped the same way, and a
 * receipt that lands after it earns no points (arenaSolanaBoosts.js persistVerifiedBoost).
 */
import { Contract } from "ethers";

export const BOOST_MAX_UNITS_PER_WALLET = 2;
export const BOOST_WINDOW_FRACTION = 0.8;

/**
 * An EVM quote past its deadline is only treated as unpaid once this much later, so a payment mined
 * just before the deadline is visible to the RPC before the server decides it never happened.
 */
export const EVM_RESERVATION_SETTLE_GRACE_MS = 120_000;

const USED_BOOST_NONCES_ABI = ["function usedBoostNonces(address,uint256) view returns (bool)"];

function timeMs(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

/** Epoch ms at which Boosts close for a battle row, or null when its clock is unknown. */
export function boostWindowCloseMs(battle) {
  const endMs = timeMs(battle?.ends_at);
  if (!Number.isFinite(endMs)) return null;
  let startMs = timeMs(battle?.started_at);
  if (!Number.isFinite(startMs)) {
    const hours = Number(battle?.duration_hours);
    startMs = Number.isFinite(hours) && hours > 0 ? endMs - hours * 3_600_000 : Number.NaN;
  }
  if (!Number.isFinite(startMs) || startMs >= endMs) return null;
  return Math.floor(startMs + (endMs - startMs) * BOOST_WINDOW_FRACTION);
}

export function boostWindowOpen(battle, nowMs = Date.now()) {
  const closeMs = boostWindowCloseMs(battle);
  return closeMs !== null && Number(nowMs) < closeMs;
}

/** Null while Boosts are open, else the 409 body the quote routes return. */
export function boostWindowClosed(battle, nowMs = Date.now()) {
  if (boostWindowOpen(battle, nowMs)) return null;
  const closeMs = boostWindowCloseMs(battle);
  return {
    status: 409,
    error: "Boosts are closed for the last 20% of the battle",
    code: "BOOST_WINDOW_CLOSED",
    boostClosesAt: closeMs === null ? null : new Date(closeMs).toISOString(),
  };
}

/** Null when the wallet may buy `requested` more Boosts, else the 409 body. */
export function walletBoostCapExceeded(usedUnits, requestedUnits) {
  const used = BigInt(usedUnits);
  const requested = BigInt(requestedUnits);
  const limit = BigInt(BOOST_MAX_UNITS_PER_WALLET);
  if (used + requested <= limit) return null;
  const remaining = used >= limit ? 0n : limit - used;
  return {
    status: 409,
    error: remaining === 0n
      ? `This wallet already used its ${BOOST_MAX_UNITS_PER_WALLET} Boosts in this battle`
      : `This wallet can buy ${remaining} more Boost${remaining === 1n ? "" : "s"} in this battle`,
    code: "BOOST_WALLET_LIMIT",
    boostLimit: BOOST_MAX_UNITS_PER_WALLET,
    walletBoostUnits: used.toString(),
  };
}

/** Rules block for read routes, so the UI shows the same numbers the server enforces. */
export function boostRulesShape(battle, nowMs = Date.now()) {
  const closeMs = battle ? boostWindowCloseMs(battle) : null;
  return {
    maxUnitsPerWallet: BOOST_MAX_UNITS_PER_WALLET,
    windowFraction: BOOST_WINDOW_FRACTION,
    closesAt: closeMs === null ? null : new Date(closeMs).toISOString(),
    open: closeMs !== null && Number(nowMs) < closeMs,
  };
}

/** Serializes cap checks for one wallet in one battle until the caller's transaction ends. */
export async function lockWalletBoostCap(client, { chainId, battleId, wallet }) {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`arena-boost-cap:${Number(chainId)}:${battleId}:${wallet}`]);
}

/** Confirmed regulation Boost units a wallet holds in a battle (both sides). */
export async function confirmedWalletBoostUnits(db, { chainId, battleId, wallet }) {
  const result = await db.query(
    `select coalesce(sum(boost_units), 0)::text as units
       from public.arena_contest_actions
      where chain_id = $1 and battle_id = $2 and wallet = $3
        and action_type = 'boost' and phase = 'regulation' and confirmed_at is not null`,
    [Number(chainId), String(battleId), String(wallet)],
  );
  return BigInt(result.rows[0]?.units || "0");
}

/**
 * Solana: confirmed units plus units in quotes that can still land (signed and unresolved, or
 * unsigned and not yet expired). Confirmed quotes are already in arena_contest_actions.
 */
export async function solanaWalletBoostUnitsUsed(db, { chainId, battleId, wallet }) {
  const confirmed = await confirmedWalletBoostUnits(db, { chainId, battleId, wallet });
  const open = await db.query(
    `select coalesce(sum(boost_units), 0)::text as units
       from public.arena_solana_boost_quotes
      where chain_id = $1 and battle_id = $2 and wallet = $3
        and payment_status in ('pending','submitted','confirming','recovering','verifying')
        and (signature_reference is not null or expires_at > now())`,
    [Number(chainId), String(battleId), String(wallet)],
  );
  return confirmed + BigInt(open.rows[0]?.units || "0");
}

export async function readEvmBoostNonceUsed({ provider, treasuryAddress, wallet, nonce }) {
  const treasury = new Contract(treasuryAddress, USED_BOOST_NONCES_ABI, provider);
  return Boolean(await treasury.usedBoostNonces(wallet, BigInt(nonce)));
}

/**
 * EVM: every Boost needs a server-signed quote, and every quote is reserved here before it is
 * returned. A reservation counts while it can still be paid (deadline not passed) and once it is
 * paid. A reservation past its deadline (plus grace) is resolved once from the treasury's
 * usedBoostNonces: used -> paid, unused -> void (the treasury refuses it from now on). If that read
 * fails the reservation keeps counting, so the cap fails closed.
 */
export async function evmWalletBoostUnitsUsed(db, { chainId, battleId, wallet, nowMs = Date.now(), readNonceUsed }) {
  const rows = (await db.query(
    `select id, treasury_address, nonce, boost_units, deadline, status
       from public.arena_boost_quote_reservations
      where chain_id = $1 and battle_id = $2 and wallet = $3 and status in ('pending','paid')`,
    [Number(chainId), String(battleId), String(wallet)],
  )).rows || [];
  let used = 0n;
  for (const row of rows) {
    const units = BigInt(String(row.boost_units));
    if (row.status === "paid" || timeMs(row.deadline) + EVM_RESERVATION_SETTLE_GRACE_MS > Number(nowMs)) {
      used += units;
      continue;
    }
    let paid;
    try {
      paid = await readNonceUsed({ treasuryAddress: row.treasury_address, wallet, nonce: row.nonce });
    } catch (error) {
      console.warn("[arenaBoostRules] usedBoostNonces read failed; reservation keeps counting", error?.message || error);
      used += units;
      continue;
    }
    await db.query(
      `update public.arena_boost_quote_reservations set status = $2, resolved_at = now() where id = $1 and status = 'pending'`,
      [row.id, paid ? "paid" : "void"],
    );
    if (paid) used += units;
  }
  return used;
}

export async function insertEvmBoostReservation(db, { chainId, battleId, tournamentId = null, roundNumber = 0, matchId = null, wallet, side, boostUnits, treasuryAddress, nonce, deadlineSeconds }) {
  await db.query(
    `insert into public.arena_boost_quote_reservations
       (chain_id, battle_id, tournament_id, round_number, match_id, wallet, side, boost_units, treasury_address, nonce, deadline)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11))`,
    [
      Number(chainId), String(battleId), tournamentId, Number(roundNumber), matchId, String(wallet), side,
      String(boostUnits), String(treasuryAddress).toLowerCase(), String(nonce), Number(deadlineSeconds),
    ],
  );
}

/** A quote that leaves less than this to pay is not issued; the wallet could not land it in time. */
export const BOOST_MIN_QUOTE_SECONDS = 15;

/** Quote deadline: the normal TTL, never past the Boost close. Null when too little time is left. */
export function clampedQuoteDeadlineSeconds(battle, nowSeconds, ttlSeconds) {
  const closeMs = boostWindowCloseMs(battle);
  const ttlDeadline = Number(nowSeconds) + Number(ttlSeconds);
  const deadline = closeMs === null ? ttlDeadline : Math.min(ttlDeadline, Math.floor(closeMs / 1000));
  return deadline - Number(nowSeconds) >= BOOST_MIN_QUOTE_SECONDS ? deadline : null;
}

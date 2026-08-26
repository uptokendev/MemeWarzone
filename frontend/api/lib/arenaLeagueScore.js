import { pool } from "../../server/db.js";
import { normalizeWalletFlexible } from "../../server/http.js";

const WIN_POINTS = 3;
const LOSS_POINTS = 1;
const DRAW_POINTS = 1;

function ident(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

function currentQuarter(date = new Date()) {
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

export async function ensureActiveSeason(chainId) {
  const idNum = Number(chainId) || 56;
  const existing = await pool.query(
    `select * from public.arena_league_seasons where chain_id = $1 and active = true limit 1`,
    [idNum],
  );
  if (existing.rows[0]) return existing.rows[0];

  const now = new Date();
  const year = now.getUTCFullYear();
  const quarter = currentQuarter(now);
  const id = `mwl-${year}-q${quarter}-c${idNum}`;
  const resetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const inserted = await pool.query(
    `insert into public.arena_league_seasons (
        id, chain_id, label, state, week, quarter, year, reset_at, active
      ) values ($1,$2,$3,'live',1,$4,$5,$6,true)
      on conflict (id) do update set active = true, updated_at = now()
      returning *`,
    [id, idNum, `Major War League ${year} Q${quarter}`, quarter, year, resetAt],
  );
  return inserted.rows[0];
}

async function bumpEntry(seasonId, token, name, symbol, points, wins, losses) {
  const address = ident(token);
  if (!address) return;
  await pool.query(
    `insert into public.arena_league_entries (
        season_id, token_address, token_name, symbol, points, wins, losses
      ) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (season_id, token_address) do update set
        token_name = excluded.token_name,
        symbol = excluded.symbol,
        points = public.arena_league_entries.points + excluded.points,
        wins = public.arena_league_entries.wins + excluded.wins,
        losses = public.arena_league_entries.losses + excluded.losses,
        updated_at = now()`,
    [seasonId, address, String(name || symbol || "Unknown"), String(symbol || "---"), points, wins, losses],
  );
}

export async function recordFinishedBattle(row) {
  if (!row || row.state === "finished") return;
  const left = ident(row.challenger_token);
  const right = ident(row.defender_token);
  if (!left || !right) return;

  const season = await ensureActiveSeason(row.chain_id);
  const participants = Array.isArray(row.participants) ? row.participants : [];
  const leftPart = participants[0] || {};
  const rightPart = participants[1] || {};
  const winner = ident(row.winner_token);

  if (winner && winner === left) {
    await bumpEntry(season.id, left, leftPart.tokenName, leftPart.symbol, WIN_POINTS, 1, 0);
    await bumpEntry(season.id, right, rightPart.tokenName, rightPart.symbol, LOSS_POINTS, 0, 1);
    return;
  }
  if (winner && winner === right) {
    await bumpEntry(season.id, right, rightPart.tokenName, rightPart.symbol, WIN_POINTS, 1, 0);
    await bumpEntry(season.id, left, leftPart.tokenName, leftPart.symbol, LOSS_POINTS, 0, 1);
    return;
  }
  await bumpEntry(season.id, left, leftPart.tokenName, leftPart.symbol, DRAW_POINTS, 0, 0);
  await bumpEntry(season.id, right, rightPart.tokenName, rightPart.symbol, DRAW_POINTS, 0, 0);
}

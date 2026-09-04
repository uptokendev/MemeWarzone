import { badMethod, json, normalizeAddress, normalizeWalletFlexible, readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "./walletActionAuth.js";

async function loadDb(deps) {
  if (deps.query) return { query: deps.query, pool: deps.pool || null };
  const { pool } = await import("../../server/db.js");
  return { query: (text, params) => pool.query(text, params), pool };
}

export const CANCEL_OPEN_SQL = `
  update public.arena_battles
     set state = 'expired', finished_at = $2, updated_at = now()
   where id = $1
     and state = 'waiting'
     and source = 'queue'
   returning id, state, source, challenger_token
`;

export function inspectAutoDeployCancel(row) {
  if (!row) {
    return { ok: false, status: 404, error: "Battle not found", code: "NOT_FOUND" };
  }
  if (String(row.source || "") === "tournament" || row.tournament_id) {
    return {
      ok: false,
      status: 409,
      error: "Tournament battles cannot be cancelled through AUTO DEPLOY.",
      code: "TOURNAMENT_BATTLE",
      currentState: row.state,
    };
  }
  if (String(row.source || "") !== "queue") {
    return {
      ok: false,
      status: 409,
      error: "Only AUTO DEPLOY queue rows can be disabled.",
      code: "NOT_QUEUE",
      currentState: row.state,
    };
  }
  if (String(row.state || "") !== "waiting") {
    return {
      ok: false,
      status: 409,
      error: "AUTO DEPLOY can only be disabled while searching.",
      code: "STATE_CHANGED",
      currentState: row.state,
    };
  }
  return { ok: true };
}

export async function applyCancelOpenUpdate(query, battleId, finishedAt) {
  const result = await query(CANCEL_OPEN_SQL, [battleId, finishedAt]);
  return result?.rows?.[0] || null;
}

async function loadBattle(query, battleId) {
  const result = await query(
    `select id, chain_id, state, source, tournament_id, challenger_token, defender_token, creator_address, stake_native, duration_hours
       from public.arena_battles
      where id = $1
      limit 1`,
    [battleId],
  );
  return result?.rows?.[0] || null;
}

function ident(value, chainId) {
  const flexible = normalizeWalletFlexible(value);
  if (flexible) return flexible;
  return normalizeAddress(value, chainId) || String(value ?? "").trim();
}

async function ownerWalletForToken(query, chainId, token) {
  const identity = ident(token, chainId);
  if (!identity) return "";
  const native = await query(
    `select creator_address
       from public.campaigns
      where chain_id = $1
        and (lower(campaign_address::text) = lower($2) or lower(coalesce(token_address::text, '')) = lower($2))
      limit 1`,
    [chainId, identity],
  );
  if (native?.rows?.[0]?.creator_address) return ident(native.rows[0].creator_address, chainId);
  const imported = await query(
    `select owner_wallet
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2)
      limit 1`,
    [chainId, identity],
  );
  if (imported?.rows?.[0]?.owner_wallet) return ident(imported.rows[0].owner_wallet, chainId);
  return "";
}

export async function handleCancelOpen(req, res, battleId, deps = {}) {
  if (String(req.method || "GET").toUpperCase() !== "POST") return badMethod(res);
  const id = String(battleId || "").trim();
  if (!id) return json(res, 400, { ok: false, error: "Battle id is required" });

  const { query, pool } = await loadDb(deps);
  const authFn = deps.requireWalletActionAuth || requireWalletActionAuth;
  const readBody = deps.readJson || readJson;
  const now = deps.nowIso || (() => new Date().toISOString());

  const row = await loadBattle(query, id);
  const blocked = inspectAutoDeployCancel(row);
  if (!blocked.ok) return json(res, blocked.status, { ok: false, error: blocked.error, code: blocked.code, currentState: blocked.currentState || null });

  const chainId = Number(row.chain_id);
  const queuedToken = ident(row.challenger_token, chainId);
  const owner = (await ownerWalletForToken(query, chainId, queuedToken)) || ident(row.creator_address, chainId);
  if (!owner) return json(res, 404, { ok: false, error: "Queued coin not found", code: "COIN_NOT_FOUND" });

  const body = await readBody(req);
  const verified = await authFn({
    res,
    pool,
    auth: body?.auth || body,
    expectedWallet: owner,
    chainId,
    action: "arena_cancel_open_battle",
    routeLabel: "arena/battles/cancel-open",
    extraLines: [`Battle: ${id}`, `Token: ${queuedToken}`],
  });
  if (!verified) return;

  const updated = await applyCancelOpenUpdate(query, id, now());
  if (!updated) {
    const current = await loadBattle(query, id);
    return json(res, 409, {
      ok: false,
      error: "AUTO DEPLOY already left the waiting queue. Disable cannot undo a match.",
      code: "STATE_CHANGED",
      currentState: current?.state || null,
    });
  }
  return json(res, 200, { ok: true, battleId: updated.id, state: updated.state, source: updated.source });
}

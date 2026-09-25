#!/usr/bin/env node
/**
 * End-to-end Battle flow against a real Postgres (staging), through the real API handlers.
 *
 *   E2E_DATABASE_URL=<staging url> PG_SSL_ALLOW_SELF_SIGNED=1 node scripts/e2e-arena-battle-flow.mjs
 *
 * Generated wallets sign every action exactly as the app does (nonce + signed MemeWarzone API Action),
 * with signature enforcement ON. Throwaway imported coins are created, battles are driven through
 * challenge -> inbox -> counter -> inbox -> accept -> live -> votes / market move -> clock out ->
 * settlement -> winner -> league points, plus decline, timeout and every refusal. Everything created
 * is deleted at the end. Chain 56 with no war pool configured, so accepts go straight to live (the
 * on-chain escrow leg is proven separately by scripts/canary-arena-war-pool.ts).
 *
 * Refuses to run against production: the URL must not be DATABASE_URL from frontend/.env.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = String(process.env.E2E_DATABASE_URL || "").trim();
if (!url) {
  console.error("E2E_DATABASE_URL is required (staging).");
  process.exit(2);
}
try {
  const prod = fs.readFileSync(path.join(here, "..", ".env"), "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (prod && prod.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "") === url) {
    console.error("Refusing: E2E_DATABASE_URL is the production database.");
    process.exit(2);
  }
} catch {
  // no .env: nothing to compare against
}

// A clean environment: only what the battle path reads. No Ably, no mail, no war pools.
for (const key of Object.keys(process.env)) {
  if (/^(ABLY|RESEND|SMTP|MAIL|ARENA_WAR_POOL|ARENA_BOOST|POSTMARK|SENDGRID)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  DATABASE_URL: url,
  PG_SSL_ALLOW_SELF_SIGNED: "1",
  API_AUTH_ENFORCE_USER_WRITES: "true",
  POSTGRAD_API_ENABLED: "true",
  ARENA_BATTLE_POINTS_V3: "true",
  ARENA_POSTGRAD_LEAGUE_V2: "true",
  ARENA_VOTE_TOURNAMENTS: "true",
  ARENA_FINAL_SALVO: "true",
});

const { ethers } = await import("ethers");
const { pool } = await import("../server/db.js");
const battlesRuntime = (await import("../api/arenaBattlesRuntime.js")).default;
const battleVotes = (await import("../api/arenaBattleVotes.js")).default;
const { buildWalletActionMessage } = await import("../api/lib/walletActionAuth.js");
const { settleDueNormalBattles } = await import("../api/lib/arenaBattleSettlementRuntime.js");
const { finalizeDueVoteTournamentBattle } = await import("../api/lib/arenaVoteTournamentFinalizationService.js");
const { refreshAllLiveBattleMetrics } = await import("../api/lib/arenaBattleRealtime.js");

const CHAIN = 56;
const RUN = `e2e${Date.now().toString(36)}`;
const results = [];
const createdBattles = new Set();
const createdTokens = [];
const wallets = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

function newWallet() {
  const w = ethers.Wallet.createRandom();
  wallets.push(w.address.toLowerCase());
  return w;
}

async function call(handler, method, pathname, body) {
  const req = { method, url: pathname, path: pathname.split("?")[0], body: body ? JSON.stringify(body) : undefined, headers: {} };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      end(chunk) {
        let json = null;
        try { json = JSON.parse(String(chunk ?? "")); } catch { json = String(chunk ?? ""); }
        resolve({ status: this.statusCode, json });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function signed(wallet, action, extraLines) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const address = wallet.address.toLowerCase();
  await pool.query(
    // One pending nonce per wallet (primary key chain_id, address), as the nonce route issues them.
    `insert into public.auth_nonces (chain_id, address, nonce, expires_at, created_at, updated_at, used_at)
     values ($1,$2,$3, now() + interval '10 minutes', now(), now(), null)
     on conflict (chain_id, address) do update set nonce = excluded.nonce, expires_at = excluded.expires_at, used_at = null, updated_at = now()`,
    [CHAIN, address, nonce],
  );
  const message = buildWalletActionMessage({ action, walletAddress: address, chainId: CHAIN, nonce, extraLines });
  return { walletAddress: address, chainId: CHAIN, action, nonce, message, signature: await wallet.signMessage(message) };
}

async function coin(owner, label, market) {
  const token = ethers.Wallet.createRandom().address.toLowerCase();
  createdTokens.push(token);
  await pool.query(
    `insert into public.arena_token_imports
       (chain_id, token_address, owner_wallet, imported_by_wallet, project_owner_wallet, ownership_status, name, symbol, status, scan_json, scan_version, scanned_at)
     values ($1,$2,'',$3,$4,$5,$6,$7,'passed',$8::jsonb,'arena-import-scan-v2', now())`,
    [CHAIN, token, owner || "0x0000000000000000000000000000000000000001", owner, owner ? "ownership_verified" : "ownership_pending",
      `${RUN} ${label}`, label, JSON.stringify({ ok: true, findings: [], hardFindings: [], scanVersion: "arena-import-scan-v2", scannedAt: new Date().toISOString() })],
  );
  if (market) await setMarket(token, market);
  return token;
}

async function setMarket(token, { mcap, liq = 20_000, holders = 100, vol = 5_000 }) {
  await pool.query(
    `insert into public.arena_import_market_stats (chain_id, token_address, market_cap_usd, liquidity_usd, volume_24h_usd, holders, holders_updated_at, source, updated_at)
     values ($1,$2,$3,$4,$5,$6, now(), 'e2e', now())
     on conflict (chain_id, token_address) do update set market_cap_usd=excluded.market_cap_usd, liquidity_usd=excluded.liquidity_usd,
       volume_24h_usd=excluded.volume_24h_usd, holders=excluded.holders, updated_at=now()`,
    [CHAIN, token, mcap, liq, vol, holders],
  );
}

const inbox = async (wallet) => (await call(battlesRuntime, "GET", `/arena/battles/inbox?chainId=${CHAIN}&wallet=${wallet.address}`)).json;
const status = async (wallet) => (await call(battlesRuntime, "GET", `/arena/battles/creator-status?chainId=${CHAIN}&creator=${wallet.address}`)).json;
const detail = async (id) => (await call(battlesRuntime, "GET", `/arena/battles/${id}?chainId=${CHAIN}`)).json?.battle;
const events = (box) => (box?.items || []).map((i) => `${i.event}:${i.offerCount}`);

async function challenge(from, fromToken, toToken, { mode = "vote", stake = 0.01, hours = mode === "vote" ? 1 : 24 } = {}) {
  const lines = [`Challenger: ${fromToken}`, `Defender: ${toToken}`, `Stake: ${stake}`, `Duration: ${hours}`, ...(mode === "vote" ? [`Mode: vote`] : [])];
  const res = await call(battlesRuntime, "POST", "/arena/battles/challenge", {
    tokenId: fromToken, targetTokenId: toToken, chainId: CHAIN, stakeNative: stake, durationHours: hours, battleMode: mode,
    auth: await signed(from, "arena_challenge_battle", lines),
  });
  if (res.json?.battle?.id) createdBattles.add(res.json.battle.id);
  return res;
}
const accept = async (w, id) => call(battlesRuntime, "POST", `/arena/battles/${id}/accept`, { chainId: CHAIN, auth: await signed(w, "arena_accept_battle", [`Battle: ${id}`]) });
const decline = async (w, id, message) => call(battlesRuntime, "POST", `/arena/battles/${id}/decline`, { chainId: CHAIN, message, auth: await signed(w, "arena_decline_battle", [`Battle: ${id}`]) });
const counter = async (w, id, stake, hours) => call(battlesRuntime, "POST", `/arena/battles/${id}/counter`, {
  chainId: CHAIN, stakeNative: stake, durationHours: hours, auth: await signed(w, "arena_counter_battle", [`Battle: ${id}`, `Stake: ${stake}`, `Duration: ${hours}`]),
});
const vote = async (w, id, token) => call(battleVotes, "POST", `/arena/battles/${id}/votes`, {
  chainId: CHAIN, walletAddress: w.address.toLowerCase(), tokenAddress: token,
  auth: await signed(w, "arena_battle_vote", [`Battle: ${id}`, "Phase: regulation", `Token: ${token}`]),
});
// Simulated clock: the fight (or the answer window) ran its course. The start moves back with the end so
// arena_battles_window_check (ends_at after started_at) still holds.
const clockOut = (id) => pool.query(
  `update public.arena_battles
      set started_at = case when started_at is null then null else now() - interval '8 days' end,
          ends_at = now() - interval '1 minute'
    where id = $1`,
  [id],
);

async function main() {
  const A = newWallet();
  const B = newWallet();
  const C = newWallet();

  // ---- Setup: ownership follows the verified owner (trigger), coins are eligible
  const coinA = await coin(A.address.toLowerCase(), "ALPHA", { mcap: 60_000 });
  const coinB = await coin(B.address.toLowerCase(), "BRAVO", { mcap: 80_000 });
  const coinC = await coin(C.address.toLowerCase(), "CHARLIE", null); // no market data
  const orphan = await coin(null, "ORPHAN", { mcap: 70_000 }); // nobody verified
  const D = newWallet();
  const coinD = await coin(D.address.toLowerCase(), "DELTA", { mcap: 80_000 }); // metrics opponent (fresh pair)
  const owner = (await pool.query(`select owner_wallet from public.arena_token_imports where chain_id=$1 and token_address=$2`, [CHAIN, coinA])).rows[0]?.owner_wallet;
  check("verified owner is the battle owner (trigger mirrors project_owner_wallet)", owner === A.address.toLowerCase(), owner);
  const sa = await status(A);
  check("owner sees their coin as eligible in step 2 (creator-status)", sa.items?.some((i) => i.tokenId === coinA && i.eligibility), JSON.stringify(sa.items?.map((i) => [i.symbol, i.eligibility, i.unavailableReason])));

  // ---- Refusals
  let r = await challenge(A, coinA, orphan);
  check("challenge to a coin with no owner is refused", r.status === 409 && r.json?.code === "OPPONENT_HAS_NO_OWNER", `${r.status} ${r.json?.code}`);
  r = await challenge(A, coinA, coinC, { mode: "normal" });
  check("metrics challenge without market data is refused", r.status === 409 && r.json?.code === "METRICS_MARKET_DATA_UNAVAILABLE", `${r.status} ${r.json?.code}`);
  r = await challenge(B, coinA, coinB);
  check("challenge signed by someone else's wallet is refused", r.status === 401, `${r.status} ${r.json?.code}`);
  const opp = (await call(battlesRuntime, "GET", `/arena/battles/opponents?chainId=${CHAIN}&mode=vote&tokenId=${coinA}&limit=60`)).json;
  const orphanRow = opp?.items?.find((i) => i.token?.tokenId === orphan);
  check("opponent list answers with a chain id (was 404) and flags ownerless coins", Array.isArray(opp?.items) && orphanRow?.hasOwner === false, `items=${opp?.items?.length} orphan.hasOwner=${orphanRow?.hasOwner}`);

  // ---- Vote battle: challenge -> counter -> accept -> votes -> clock out -> winner -> league
  r = await challenge(A, coinA, coinB, { mode: "vote", hours: 1 });
  const vb = r.json?.battle;
  check("A challenges B to a 1-hour Vote Battle", r.status === 200 && vb?.state === "challenged" && vb?.durationHours === 1 && vb?.battleMode === "vote", `${r.status} ${vb?.state} ${vb?.durationHours}h ${vb?.battleMode}`);
  check("B's inbox has the challenge popup", events(await inbox(B)).includes("challenge_received:0"), JSON.stringify(events(await inbox(B))));
  check("A's inbox is empty while waiting", events(await inbox(A)).length === 0, JSON.stringify(events(await inbox(A))));
  r = await counter(B, vb.id, 0.02, 6);
  check("B counters: higher buy-in, 6 hours", r.status === 200 && r.json?.battle?.offeredDurationHours === 6, `${r.status} ${r.json?.error || ""}`);
  check("A's inbox gets the counter popup back", events(await inbox(A)).includes("counter_received:1"), JSON.stringify(events(await inbox(A))));
  check("B's inbox is empty while A decides", events(await inbox(B)).length === 0, JSON.stringify(events(await inbox(B))));
  r = await counter(A, vb.id, 0.015, 6);
  check("a counter that does not raise the buy-in is refused", r.status === 400, `${r.status}`);
  r = await accept(B, vb.id);
  check("the owner who made the live offer cannot accept it", r.status === 401 || r.status === 404 || r.status === 409, `${r.status} ${r.json?.code || r.json?.error || ""}`);
  r = await accept(A, vb.id);
  const vLive = r.json?.battle;
  check("A accepts B's counter: fight is live with the countered terms", r.status === 200 && vLive?.state === "live" && vLive?.durationHours === 6 && Number(vLive?.stakeNative) === 0.02, `${r.status} ${vLive?.state} ${vLive?.durationHours}h stake ${vLive?.stakeNative}`);
  const voters = [newWallet(), newWallet(), newWallet()];
  const v1 = await vote(voters[0], vb.id, coinA);
  const v2 = await vote(voters[1], vb.id, coinA);
  const v3 = await vote(voters[2], vb.id, coinB);
  check("three wallets vote (2 for ALPHA, 1 for BRAVO)", [v1, v2, v3].every((x) => x.status === 200 || x.status === 201), [v1, v2, v3].map((x) => `${x.status}${x.json?.code ? ` ${x.json.code}` : ""}`).join(","));
  const dup = await vote(voters[0], vb.id, coinB);
  check("a second free vote from the same wallet is refused", dup.status === 409, `${dup.status} ${dup.json?.code || ""}`);
  await clockOut(vb.id);
  const vFinal = await finalizeDueVoteTournamentBattle(pool, vb.id);
  const vDone = await detail(vb.id);
  const vWinner = String(vDone?.winnerToken || vDone?.moneyWinnerToken || vFinal?.winnerToken || "").toLowerCase();
  check("clock out: the Vote Battle settles and ALPHA wins on votes", vDone?.state === "finished" && vWinner === coinA, `state=${vDone?.state} winner=${vWinner} settled=${vFinal?.settled} ${vFinal?.reason || ""}`);

  // ---- Metrics battle: ranked (both under $150k), market move decides it
  r = await challenge(A, coinA, coinD, { mode: "normal", hours: 72 });
  const mb = r.json?.battle;
  check("A challenges B to a 3-day metrics Battle", r.status === 200 && mb?.durationHours === 72 && mb?.battleMode !== "vote", `${r.status} ${mb?.durationHours}h ${r.json?.code || r.json?.error || ""}`);
  check("both coins under $150k: the fight is ranked", mb?.rankedMode === "competitive", `rankedMode=${mb?.rankedMode} quality=${mb?.matchQuality}`);
  r = mb?.id ? await accept(D, mb.id) : { status: 0 };
  check("B accepts: the metrics fight is live for 72 hours", r.status === 200 && r.json?.battle?.state === "live" && r.json?.battle?.durationHours === 72, `${r.status} ${r.json?.battle?.state}`);
  if (mb?.id) {
    // As on live: the market moves (feed), the realtime scorer samples it, the deadline passes, the
    // settlement worker closes the fight with the last sample taken before the deadline.
    await setMarket(coinA, { mcap: 90_000, holders: 160, vol: 20_000 });
    await setMarket(coinD, { mcap: 76_000, holders: 101, vol: 5_000 });
    await pool.query(`update public.arena_battles set started_at = now() - interval '3 days', ends_at = now() + interval '3 seconds' where id = $1`, [mb.id]);
    await refreshAllLiveBattleMetrics();
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const outcomes = await settleDueNormalBattles({ pool });
    const mine = outcomes.find((o) => String(o?.battleId || o?.battle?.id) === mb.id);
    const mDone = await detail(mb.id);
    const mWinner = String(mDone?.moneyWinnerToken || mDone?.winnerToken || "").toLowerCase();
    check("clock out: the metrics Battle settles and ALPHA (market cap +50%) wins", mDone?.state === "finished" && mWinner === coinA, `state=${mDone?.state} winner=${mWinner} outcome=${mine?.reason || (mine?.settled ? "settled" : "none")} ${mine?.error || ""}`);
    const events = await pool.query(
      `select battle_id, token_address, kind, points::float as points from public.arena_league_point_events where battle_id = any($1::text[])`,
      [[vb.id, mb.id]],
    );
    const pts = (battle, token) => events.rows.find((e) => e.battle_id === battle && e.token_address === token);
    check("league: Vote Battle win 3 / loss 1 (vote battles always count in full)", pts(vb.id, coinA)?.points === 3 && pts(vb.id, coinB)?.points === 1, JSON.stringify(events.rows.filter((e) => e.battle_id === vb.id).map((e) => [e.kind, e.points])));
    check("league: ranked metrics win 3 / loss 1", pts(mb.id, coinA)?.points === 3 && pts(mb.id, coinD)?.points === 1, JSON.stringify(events.rows.filter((e) => e.battle_id === mb.id).map((e) => [e.kind, e.points])));
  }

  // ---- Open War: a metrics fight outside the match band counts at half league points
  const E = newWallet();
  const coinE = await coin(E.address.toLowerCase(), "ECHO", { mcap: 900_000, liq: 200_000, holders: 2_000 });
  await setMarket(coinA, { mcap: 90_000, holders: 160, vol: 20_000 });
  r = await challenge(A, coinA, coinE, { mode: "normal", hours: 24 });
  const ow = r.json?.battle;
  check("a $90k coin vs a $900k coin is an Open War (10x, above the $150k floor)", r.status === 200 && ow?.rankedMode === "open_war", `${r.status} rankedMode=${ow?.rankedMode} ${r.json?.code || ""}`);
  r = ow?.id ? await accept(E, ow.id) : { status: 0 };
  if (ow?.id && r.status === 200) {
    await setMarket(coinA, { mcap: 135_000, holders: 200, vol: 30_000 });
    await setMarket(coinE, { mcap: 880_000, liq: 200_000, holders: 2_001, vol: 1_000 });
    await pool.query(`update public.arena_battles set started_at = now() - interval '1 day', ends_at = now() + interval '3 seconds' where id = $1`, [ow.id]);
    await refreshAllLiveBattleMetrics();
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    await settleDueNormalBattles({ pool });
    const owDone = await detail(ow.id);
    const owEvents = (await pool.query(`select token_address, kind, points::float as points from public.arena_league_point_events where battle_id = $1`, [ow.id])).rows;
    const w = owEvents.find((e) => e.token_address === coinA);
    const l = owEvents.find((e) => e.token_address === coinE);
    check("Open War settles with half league points: win 1.5 / loss 0.5", owDone?.state === "finished" && w?.points === 1.5 && l?.points === 0.5, `state=${owDone?.state} ${JSON.stringify(owEvents.map((e) => [e.kind, e.points]))}`);
  } else {
    check("Open War accepted", false, `${r.status} ${r.json?.error || ""}`);
  }

  // ---- Decline, with and without a message; timeout
  r = await challenge(A, coinA, coinB, { mode: "vote", hours: 12 });
  const d1 = r.json?.battle?.id;
  r = d1 ? await decline(B, d1, "not this week") : { status: 0 };
  const boxA1 = await inbox(A);
  const declinedItem = boxA1.items?.find((i) => i.battleId === d1);
  check("B declines with a message: A gets the declined popup with it", r.status === 200 && declinedItem?.event === "challenge_declined" && declinedItem?.message === "not this week", `${r.status} ${JSON.stringify(declinedItem && { e: declinedItem.event, m: declinedItem.message })}`);
  r = await challenge(A, coinA, coinB, { mode: "vote", hours: 24 });
  const d2 = r.json?.battle?.id;
  r = d2 ? await decline(B, d2) : { status: 0 };
  const silent = (await inbox(A)).items?.find((i) => i.battleId === d2);
  check("B declines without a message: A is still told", r.status === 200 && silent?.event === "challenge_declined" && silent?.message === null, `${r.status} ${JSON.stringify(silent && { e: silent.event, m: silent.message })}`);
  r = await challenge(A, coinA, coinB, { mode: "vote", hours: 6 });
  const t1 = r.json?.battle?.id;
  if (t1) await clockOut(t1);
  const afterTimeout = await detail(t1);
  const tItem = (await inbox(A)).items?.find((i) => i.battleId === t1);
  check("an unanswered challenge expires at its deadline and is not reported as declined", afterTimeout?.state === "expired" && !tItem, `state=${afterTimeout?.state} inbox=${tItem?.event || "none"}`);
  r = t1 ? await counter(B, t1, 0.05, 6) : { status: 0 };
  check("a counter on an expired challenge is refused", r.status === 409, `${r.status}`);

  // ---- Durations per mode
  r = await challenge(A, coinA, coinB, { mode: "vote", hours: 72 });
  const badVote = r.json?.battle;
  check("a Vote Battle cannot run a metrics duration (refused, or clamped to a vote duration)", r.status !== 200 || [1, 6, 12, 24].includes(badVote?.durationHours), `${r.status} ${badVote?.durationHours ?? "-"}h`);
  if (badVote?.id) await decline(B, badVote.id);
}

async function cleanup() {
  const ids = [...createdBattles];
  const tables = await pool.query(
    `select table_name, column_name from information_schema.columns
      where table_schema='public' and column_name in ('battle_id','token_address','wallet','wallet_address','voter','address','owner_wallet')
        and table_name not like 'pg_%'`,
  );
  let removed = 0;
  for (const { table_name: t, column_name: c } of tables.rows) {
    if (t === "arena_battles" || t === "arena_token_imports" || t === "arena_token_import_history") continue;
    const values = c === "battle_id" ? ids : c === "token_address" ? createdTokens : wallets;
    if (!values.length) continue;
    try {
      const out = await pool.query(`delete from public.${t} where lower(${c}::text) = any($1::text[])`, [values.map((v) => String(v).toLowerCase())]);
      removed += out.rowCount || 0;
    } catch {
      // not a text-comparable column or FK order; the battle delete below cascades what remains
    }
  }
  if (ids.length) {
    // Notifications the run produced (keys carry the battle id); markers first, they reference the outbox.
    const like = ids.map((id) => `%${id}%`);
    removed += (await pool.query(`delete from public.notification_markers where marker_key like any($1::text[])`, [like]).catch(() => ({ rowCount: 0 }))).rowCount || 0;
    removed += (await pool.query(`delete from public.notification_outbox where dedup_key like any($1::text[])`, [like]).catch(() => ({ rowCount: 0 }))).rowCount || 0;
    removed += (await pool.query(`delete from public.arena_battles where id = any($1::text[])`, [ids])).rowCount || 0;
  }
  // Import history is append-only, so test coins are retired (declined), never deleted.
  const retired = (await pool.query(`update public.arena_token_imports set status = 'declined' where chain_id=$1 and token_address = any($2::text[])`, [CHAIN, createdTokens])).rowCount || 0;
  console.log(`cleanup: retired ${retired} test coins`);
  console.log(`cleanup: removed ${removed} rows (${ids.length} battles, ${createdTokens.length} coins)`);
}

try {
  await main();
} catch (error) {
  check("harness ran to the end", false, error?.stack || String(error));
} finally {
  await cleanup().catch((e) => console.log("cleanup failed", e?.message || e));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await pool.end().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

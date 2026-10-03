/**
 * Tournament Admin builder against a real local Postgres with the certified
 * Arena schema (CI: .github/workflows/tournament-admin-backend-contract.yml).
 *
 *   ARENA_SCHEMA_GATE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/arena_schema_gate \
 *     node --test api/arenaTournamentAdminInvites.integration.test.mjs
 *
 * Runs only against a loopback database: it creates and deletes rows.
 */
import assert from "node:assert/strict";
import test from "node:test";

const gateUrl = process.env.ARENA_SCHEMA_GATE_DATABASE_URL || "";
let skip = "ARENA_SCHEMA_GATE_DATABASE_URL not set";
if (gateUrl) {
  const host = new URL(gateUrl).hostname;
  skip = ["127.0.0.1", "localhost", "::1"].includes(host) ? false : `refusing non-local database host ${host}`;
}
if (!skip) {
  process.env.DATABASE_URL = gateUrl;
  process.env.PG_DISABLE_SSL = "1";
}

const EVM_TOKEN_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const EVM_TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVM_TOKEN_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const EVM_WALLET = "0xdddddddddddddddddddddddddddddddddddddddd";
const SOL_MINT_A = "So11111111111111111111111111111111111111112";
const SOL_MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function call(handler, { method, path, body }) {
  const req = {
    method,
    url: path,
    path: path.split("?")[0],
    headers: {},
    body: JSON.stringify(body ?? {}),
    dashboardPrincipal: { authUserId: "integration", role: "owner", permissions: ["tournaments.manage"] },
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(data) { this.end(JSON.stringify(data)); },
      end(raw) { this.headersSent = true; resolve({ status: this.statusCode, body: raw ? JSON.parse(raw) : null }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const hour = 3_600_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test("Tournament builder: create, invites, edit lock, scoped removal, vote start", { skip }, async (t) => {
  const { pool } = await import("../server/db.js");
  const { default: tournaments } = await import("./arenaTournaments.js");
  const route = (method, path, body) => call(tournaments, { method, path, body });
  const created = [];
  t.after(async () => {
    if (created.length) {
      await pool.query("delete from public.arena_battles where tournament_id = any($1::text[])", [created]);
      await pool.query("delete from public.arena_tournaments where id = any($1::text[])", [created]);
    }
    await pool.end();
  });

  const base = {
    cap: 4,
    registrationMode: "invite_only",
    registrationOpensAt: iso(-hour),
    registrationClosesAt: iso(hour),
    startMode: "manual",
    startsAt: iso(-30 * 60_000),
    buyInNative: 0,
    terms: "Integration terms",
  };

  await t.test("battle create persists generation + invites (EVM lowercased)", async () => {
    const res = await route("POST", "/api/admin/arena/tournaments", {
      ...base, name: "Battle BNB staging", chainId: 97, environment: "staging", kind: "battle", roundDurationHours: 12,
      sponsorReference: "sponsor-1",
      invites: [{ tokenAddress: EVM_TOKEN_A, ownerWallet: EVM_WALLET }, EVM_TOKEN_B, EVM_TOKEN_A.toLowerCase()],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.push(res.body.tournament.id);
    const row = (await pool.query("select * from public.arena_tournaments where id = $1", [res.body.tournament.id])).rows[0];
    assert.equal(row.contest_scoring_version, "battle_points_v3");
    assert.equal(row.competition_generation, "arena_competition_v2");
    assert.equal(row.round_duration_hours, 12);
    assert.equal(row.environment, "staging");
    assert.equal(row.registration_state, "open");
    assert.equal(row.sponsor_reference, "sponsor-1");
    assert.deepEqual(res.body.invites.map((i) => i.tokenAddress).sort(), [EVM_TOKEN_A.toLowerCase(), EVM_TOKEN_B]);
    assert.equal(res.body.invites.find((i) => i.tokenAddress === EVM_TOKEN_A.toLowerCase()).ownerWallet, EVM_WALLET);
    assert.ok(res.body.invites.every((i) => i.status === "pending"));
  });

  await t.test("vote create needs 24h and lands on the vote runtime generation", async () => {
    const bad = await route("POST", "/api/admin/arena/tournaments", {
      ...base, name: "Vote 12h", chainId: 101, environment: "staging", kind: "vote", roundDurationHours: 12,
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /exactly 24 hours/);
    const res = await route("POST", "/api/admin/arena/tournaments", {
      ...base, name: "Vote SOL devnet", chainId: 101, environment: "staging", kind: "vote", roundDurationHours: 24,
      registrationMode: "invite_plus_open", invites: [{ tokenAddress: SOL_MINT_A }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.push(res.body.tournament.id);
    const row = (await pool.query("select * from public.arena_tournaments where id = $1", [res.body.tournament.id])).rows[0];
    assert.equal(row.battle_mode, "vote");
    assert.equal(row.tournament_type, "vote");
    assert.equal(row.contest_scoring_version, "vote_tournament_v1");
    assert.equal(row.competition_generation, "arena_competition_v2");
    assert.equal(row.round_duration_hours, 24);
    assert.equal(row.solana_cluster, "devnet");
    assert.equal(res.body.invites[0].tokenAddress, SOL_MINT_A);
  });

  await t.test("invalid invite address for the chain rejects the whole create", async () => {
    const before = Number((await pool.query("select count(*)::int c from public.arena_tournaments")).rows[0].c);
    const res = await route("POST", "/api/admin/arena/tournaments", {
      ...base, name: "Bad invite", chainId: 97, environment: "staging", kind: "battle", roundDurationHours: 24,
      invites: [{ tokenAddress: SOL_MINT_A }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /EVM address/);
    const after = Number((await pool.query("select count(*)::int c from public.arena_tournaments")).rows[0].c);
    assert.equal(after, before);
  });

  await t.test("invite add/remove is versioned and checked per chain", async () => {
    const id = created[1];
    const row = (await pool.query("select state_version from public.arena_tournaments where id = $1", [id])).rows[0];
    const v = Number(row.state_version);
    const wrongChain = await route("POST", `/api/admin/arena/tournaments/${id}/invites`, { expectedStateVersion: v, invites: [EVM_TOKEN_C] });
    assert.equal(wrongChain.status, 400);
    const added = await route("POST", `/api/admin/arena/tournaments/${id}/invites`, { expectedStateVersion: v, invites: [{ tokenAddress: SOL_MINT_B, ownerWallet: SOL_MINT_A }] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.tournament.stateVersion, v + 1);
    assert.equal(added.body.invites.length, 2);
    const stale = await route("POST", `/api/admin/arena/tournaments/${id}/invites`, { expectedStateVersion: v, invites: [SOL_MINT_B] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "TOURNAMENT_STATE_CONFLICT");
    const removed = await route("DELETE", `/api/admin/arena/tournaments/${id}/invites/${SOL_MINT_B}`, { expectedStateVersion: v + 1 });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.invites.map((i) => i.tokenAddress), [SOL_MINT_A]);
    const missing = await route("DELETE", `/api/admin/arena/tournaments/${id}/invites/${SOL_MINT_B}`, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "TOURNAMENT_INVITE_NOT_FOUND");
  });

  await t.test("edit persists every builder field but never switches environment/cluster", async () => {
    const id = created[1];
    const locked = await route("PATCH", `/api/admin/arena/tournaments/${id}`, { environment: "production", solanaCluster: "mainnet-beta" });
    assert.equal(locked.status, 400);
    assert.match(locked.body.error, /locked/);
    const id97 = created[0];
    const edited = await route("PATCH", `/api/admin/arena/tournaments/${id97}`, {
      name: "Battle renamed", cap: 8, registrationMode: "invite_plus_open", startMode: "scheduled",
      registrationOpensAt: iso(-hour), registrationClosesAt: iso(2 * hour), startsAt: iso(3 * hour),
      roundDurationHours: 24, buyInNative: 0.5, terms: "New terms", sponsorReference: "", environment: "staging", chainId: 97,
      expectedStatus: "upcoming",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const row = (await pool.query("select * from public.arena_tournaments where id = $1", [id97])).rows[0];
    assert.equal(row.name, "Battle renamed");
    assert.equal(row.cap, 8);
    assert.equal(row.registration_mode, "invite_plus_open");
    assert.equal(row.start_mode, "scheduled");
    assert.equal(row.round_duration_hours, 24);
    assert.equal(Number(row.buy_in_native), 0.5);
    assert.equal(row.terms, "New terms");
    assert.equal(row.sponsor_reference, null);
    assert.equal(row.environment, "staging");
    const toVote = await route("PATCH", `/api/admin/arena/tournaments/${id97}`, { kind: "vote", buyInNative: 0 });
    assert.equal(toVote.status, 200, JSON.stringify(toVote.body));
    const voteRow = (await pool.query("select * from public.arena_tournaments where id = $1", [id97])).rows[0];
    assert.equal(voteRow.battle_mode, "vote");
    assert.equal(voteRow.contest_scoring_version, "vote_tournament_v1");
    assert.equal(voteRow.round_duration_hours, 24);
    const back = await route("PATCH", `/api/admin/arena/tournaments/${id97}`, { kind: "battle", roundDurationHours: 12, startMode: "manual", startsAt: iso(-30 * 60_000) });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const battleRow = (await pool.query("select * from public.arena_tournaments where id = $1", [id97])).rows[0];
    assert.equal(battleRow.contest_scoring_version, "battle_points_v3");
    assert.equal(battleRow.round_duration_hours, 12);
  });

  await t.test("unpaid entrant removal is scoped to tournament + token", async () => {
    const id = created[0];
    await pool.query(
      `insert into public.arena_tournament_entries (tournament_id, token_address, owner_wallet, buy_in_intent)
       values ($1,$2,$4,true), ($1,$3,$4,true)`,
      [id, EVM_TOKEN_A.toLowerCase(), EVM_TOKEN_B, EVM_WALLET],
    );
    const ambiguous = await route("DELETE", `/api/admin/arena/tournaments/${id}/entrants/${EVM_WALLET}`);
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.code, "TOURNAMENT_ENTRY_TOKEN_REQUIRED");
    const invitedEntrant = await route("DELETE", `/api/admin/arena/tournaments/${id}/invites/${EVM_TOKEN_B}`, {});
    assert.equal(invitedEntrant.status, 409);
    assert.equal(invitedEntrant.body.code, "TOURNAMENT_INVITE_HAS_ENTRANT");
    const buyIn = await route("PATCH", `/api/admin/arena/tournaments/${id}`, { buyInNative: 1 });
    assert.equal(buyIn.status, 409);
    assert.equal(buyIn.body.code, "TOURNAMENT_BUY_IN_LOCKED");
    const scoped = await route("DELETE", `/api/admin/arena/tournaments/${id}/entrants/${EVM_WALLET}?tokenAddress=${EVM_TOKEN_A}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    const left = (await pool.query("select token_address from public.arena_tournament_entries where tournament_id = $1", [id])).rows;
    assert.deepEqual(left.map((r) => r.token_address), [EVM_TOKEN_B]);
    const single = await route("DELETE", `/api/admin/arena/tournaments/${id}/entrants/${EVM_WALLET}`);
    assert.equal(single.status, 200, JSON.stringify(single.body));
  });

  await t.test("vote tournament START builds 24h vote battles the vote runtime accepts", async () => {
    const res = await route("POST", "/api/admin/arena/tournaments", {
      ...base, name: "Vote BNB staging start", chainId: 97, environment: "staging", kind: "vote", registrationMode: "open",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.tournament.id;
    created.push(id);
    // The certified gate schema carries only the campaigns columns the Arena
    // migrations reference. START reads coin metadata from the launchpad
    // columns; add them (no-op on a full launchpad schema).
    await pool.query(`alter table public.campaigns
      add column if not exists name text, add column if not exists symbol text,
      add column if not exists creator_address text, add column if not exists created_at timestamptz,
      add column if not exists graduated_at_chain timestamptz, add column if not exists fee_recipient_address text,
      add column if not exists created_block bigint`);
    const tokens = ["0x1000000000000000000000000000000000000001", "0x1000000000000000000000000000000000000002",
      "0x1000000000000000000000000000000000000003", "0x1000000000000000000000000000000000000004"];
    for (const token of tokens) {
      await pool.query(
        "insert into public.arena_tournament_entries (tournament_id, token_address, owner_wallet, buy_in_intent) values ($1,$2,$3,true)",
        [id, token, EVM_WALLET],
      );
    }
    const closed = await route("POST", `/api/admin/arena/tournaments/${id}/registration/close`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const started = await route("POST", `/api/admin/arena/tournaments/${id}/start?chainId=97`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const battles = (await pool.query(
      `select battle_mode, contest_scoring_version, competition_generation, extract(epoch from ends_at - started_at)::int as seconds
         from public.arena_battles where tournament_id = $1`,
      [id],
    )).rows;
    assert.equal(battles.length, 2);
    for (const battle of battles) {
      assert.equal(battle.battle_mode, "vote");
      assert.equal(battle.contest_scoring_version, "vote_tournament_v1");
      assert.equal(battle.competition_generation, "arena_competition_v2");
      assert.equal(battle.seconds, 24 * 3600);
    }
    const { resolveTournamentVoteMatch } = await import("./lib/arenaTournamentVoteRuntime.mjs");
    const live = (await pool.query("select * from public.arena_tournaments where id = $1", [id])).rows[0];
    const firstBattle = live.bracket.rounds[0].matches[0].battleId;
    const match = resolveTournamentVoteMatch({ tournament: live, matchRef: firstBattle });
    assert.equal(match.ok, true, JSON.stringify(match));
    const afterLive = await route("POST", `/api/admin/arena/tournaments/${id}/invites`, { invites: [EVM_TOKEN_C] });
    assert.equal(afterLive.status, 409);
    assert.equal(afterLive.body.code, "TOURNAMENT_NOT_UPCOMING");
  });
});

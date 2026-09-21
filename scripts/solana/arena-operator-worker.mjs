import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  parseArenaConfig,
  parseArenaPool,
  REWARDS_TREASURY_PROGRAM_ID,
  validateCanonicalArenaConfig,
} from "../../frontend/src/lib/solanaArenaLayout.mjs";
import {
  ARENA_CLAIM_MWL,
  ARENA_CLAIM_PROTOCOL,
  deriveArenaBuyInReceipt,
  deriveArenaOperatorPdas,
} from "./arena-operator-v0.mjs";
import {
  assertEd25519Adjacency,
  canonicalBattlePoolIdBytes,
  canonicalTournamentPoolIdBytes,
  planBattleResolve,
  planOperatorClaim,
  planTournamentPlacesResolve,
  sendPlannedClaim,
  sendPlannedPlacesResolve,
  sendPlannedResolve,
} from "./arena-operator-resolve.mjs";
import { buildTournamentPlaces } from "../../frontend/api/lib/arenaTournamentPlaces.js";

function ident(value) {
  return String(value || "").trim();
}

function fail(reason, extra = {}) {
  return { ok: false, action: "block", reason, ...extra };
}

export function settlementFromBattleRow(row) {
  if (!row) return null;
  return {
    id: ident(row.id),
    battleId: ident(row.id),
    state: ident(row.state),
    chain_id: Number(row.chain_id),
    money_winner_token: ident(row.money_winner_token),
    mwl_draw: row.mwl_draw,
    mwl_result: ident(row.mwl_result),
    mwl_winner_token: ident(row.mwl_winner_token),
    challenger_end_mcap_usd: row.challenger_end_mcap_usd,
    defender_end_mcap_usd: row.defender_end_mcap_usd,
    settlement_version: row.settlement_version,
  };
}

const COMMANDS = ["resolve", "resolve-tournament", "claim-protocol", "claim-mwl"];

function resolverMatchesConfig(config, resolver) {
  const expectedResolver = ident(config?.resolver);
  if (!expectedResolver) return fail("config-unreadable");
  const actualResolver = ident(resolver?.publicKey?.toBase58?.() || resolver?.publicKey);
  if (!actualResolver) return fail("missing-resolver");
  if (actualResolver !== expectedResolver) return fail("resolver-config-mismatch");
  return { ok: true };
}

/**
 * Tournament jobs: resolve_pool_places_v2 from the places policy (1st / 2nd /
 * 3rd by entrant count, first place = bracket champion) and the operator
 * claims on the tournament pot. `loadTournament(id)` returns
 * { tournament, entries } with the paid entries (token_address, owner_wallet).
 */
async function runTournamentJob({
  command,
  tournamentId,
  send = false,
  loadTournament,
  loadPool,
  loadConfig,
  loadReceipts,
  sendResolvePlaces,
  sendClaim,
  resolver,
  payer,
} = {}) {
  const id = ident(tournamentId);
  if (!id) return fail("missing-tournament-id");
  if (typeof loadTournament !== "function") return fail("tournament-loader-missing");
  const loaded = await loadTournament(id);
  const tournament = loaded?.tournament || null;
  if (!ident(tournament?.id)) return fail("tournament-not-found");
  if (Number(tournament.chain_id) !== 101) {
    return fail(Number(tournament.chain_id) === 102 ? "legacy-solana-chain-not-authorized" : "not-solana");
  }
  if (ident(tournament.status) !== "finished") return fail("tournament-not-finished");

  const pool = await loadPool(id, tournament);
  if (!pool) return fail("pool-unreadable");
  const config = typeof loadConfig === "function" ? await loadConfig() : null;
  if (!config) return fail("config-unreadable");

  if (command === "resolve-tournament") {
    const resolverCheck = resolverMatchesConfig(config, resolver);
    if (!resolverCheck.ok) return resolverCheck;
    const entries = (Array.isArray(loaded.entries) ? loaded.entries : []).filter((entry) => entry?.buy_in_paid !== false && entry?.buyInPaid !== false);
    const policy = buildTournamentPlaces({ bracket: tournament.bracket, entries, entrantCount: entries.length });
    if (!policy.ok) return fail(`places-${policy.reason}`);
    const receiptAccounts = typeof loadReceipts === "function" ? await loadReceipts(policy.places, tournament) : [];
    const plan = planTournamentPlacesResolve({ tournament, pool, places: policy.places, receiptAccounts });
    if (!plan.ok) return plan;
    if (plan.action === "skip") return { ...plan, sent: false };
    if (!send) return { ...plan, sent: false };
    if (typeof sendResolvePlaces !== "function") return fail("send-not-configured");
    const signature = await sendResolvePlaces(plan, resolver, payer);
    const poolAfter = await loadPool(id, tournament);
    const after = planTournamentPlacesResolve({ tournament, pool: poolAfter, places: policy.places, receiptAccounts });
    if (!after.ok) return { ok: false, action: "block", reason: "post-send-inconsistent", signature, after };
    if (after.action !== "skip") return { ok: false, action: "block", reason: "post-send-not-resolved", signature, after };
    return { ok: true, action: "sent", reason: "resolved-places", signature, after };
  }

  const bucket = command === "claim-mwl" ? ARENA_CLAIM_MWL : ARENA_CLAIM_PROTOCOL;
  const plan = planOperatorClaim({ pool, config, bucket });
  if (!plan.ok) return plan;
  if (plan.action === "skip") return { ...plan, sent: false };
  if (!send) return { ...plan, sent: false };
  if (typeof sendClaim !== "function") return fail("send-not-configured");
  const signature = await sendClaim(plan, payer);
  const poolAfter = await loadPool(id, tournament);
  const after = planOperatorClaim({ pool: poolAfter, config, bucket });
  if (!after.ok) return { ok: false, action: "block", reason: "post-send-inconsistent", signature, after };
  if (after.action !== "skip") return { ok: false, action: "block", reason: "post-send-not-claimed", signature, after };
  return { ok: true, action: "sent", reason: "claimed", signature, after };
}

export async function runOperatorJob({
  command,
  battleId,
  tournamentId,
  send = false,
  loadSettlement,
  loadTournament,
  loadPool,
  loadConfig,
  loadReceipts,
  sendResolve,
  sendResolvePlaces,
  sendClaim,
  resolver,
  payer,
} = {}) {
  if (!COMMANDS.includes(command)) return fail("unsupported-command");
  if (command === "resolve-tournament" || (ident(tournamentId) && !ident(battleId))) {
    return runTournamentJob({
      command, tournamentId, send, loadTournament, loadPool, loadConfig, loadReceipts, sendResolvePlaces, sendClaim, resolver, payer,
    });
  }
  const id = ident(battleId);
  if (!id) return fail("missing-battle-id");

  const settlement = settlementFromBattleRow(await loadSettlement(id));
  if (!settlement?.id) return fail("battle-not-found");
  if (settlement.state !== "finished") return fail("battle-not-finished");
  if (Number(settlement.chain_id) !== 101) {
    return fail(Number(settlement.chain_id) === 102 ? "legacy-solana-chain-not-authorized" : "not-solana");
  }

  const pool = await loadPool(id, settlement);
  if (!pool) return fail("pool-unreadable");

  if (command === "resolve") {
    const config = typeof loadConfig === "function" ? await loadConfig() : null;
    if (!config) return fail("config-unreadable");
    const resolverCheck = resolverMatchesConfig(config, resolver);
    if (!resolverCheck.ok) return resolverCheck;
    const plan = planBattleResolve({ settlement, pool });
    if (!plan.ok) return plan;
    if (plan.action === "skip") return { ...plan, sent: false };
    if (!send) return { ...plan, sent: false };
    if (typeof sendResolve !== "function") return fail("send-not-configured");
    const signature = await sendResolve(plan, resolver, payer);
    const poolAfter = await loadPool(id, settlement);
    const after = planBattleResolve({ settlement, pool: poolAfter });
    if (!after.ok) return { ok: false, action: "block", reason: "post-send-inconsistent", signature, after };
    if (after.action !== "skip") return { ok: false, action: "block", reason: "post-send-not-resolved", signature, after };
    return { ok: true, action: "sent", reason: "resolved", signature, after };
  }

  const config = await loadConfig();
  if (!config) return fail("config-unreadable");
  const bucket = command === "claim-mwl" ? ARENA_CLAIM_MWL : ARENA_CLAIM_PROTOCOL;
  const plan = planOperatorClaim({ pool, config, bucket });
  if (!plan.ok) return plan;
  if (plan.action === "skip") return { ...plan, sent: false };
  if (!send) return { ...plan, sent: false };
  if (typeof sendClaim !== "function") return fail("send-not-configured");
  const signature = await sendClaim(plan, payer);
  const poolAfter = await loadPool(id, settlement);
  const after = planOperatorClaim({ pool: poolAfter, config, bucket });
  if (!after.ok) return { ok: false, action: "block", reason: "post-send-inconsistent", signature, after };
  if (after.action !== "skip") return { ok: false, action: "block", reason: "post-send-not-claimed", signature, after };
  return { ok: true, action: "sent", reason: "claimed", signature, after };
}

export function poolAccountToPlanner(account, PublicKeyCtor = PublicKey) {
  if (!account?.data) return null;
  const owner = account.owner?.toBase58?.() || String(account.owner || "");
  if (owner !== REWARDS_TREASURY_PROGRAM_ID) return null;
  const parsed = parseArenaPool(
    account.data instanceof Uint8Array ? account.data : Uint8Array.from(account.data),
    PublicKeyCtor,
  );
  if (!parsed) return null;
  return {
    ...parsed,
    poolId: Buffer.from(parsed.poolId, "hex"),
    actionNonce: parsed.actionNonce,
  };
}

export function configAccountToPlanner(account, genesisHash, chainId, PublicKeyCtor = PublicKey) {
  const validated = validateCanonicalArenaConfig({
    account,
    owner: account?.owner?.toBase58?.() || "",
    genesisHash,
    chainId,
    PublicKey: PublicKeyCtor,
  });
  if (!validated.live || !validated.config) return null;
  return validated.config;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadKeypair(envName) {
  const file = requiredEnv(envName);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function defaultLoadSettlement(battleId) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    const result = await pool.query(
      `select id, chain_id, state, money_winner_token, mwl_draw, mwl_result, mwl_winner_token,
              challenger_end_mcap_usd, defender_end_mcap_usd, settlement_version
         from public.arena_battles where id = $1 limit 1`,
      [battleId],
    );
    return result.rows[0] || null;
  } finally {
    await pool.end();
  }
}

function rpcUrl() {
  return (
    String(process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || process.env.SOLANA_REWARDS_RPC_URL || "").trim()
  );
}

async function defaultLoadTournament(tournamentId) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    const tournament = (await pool.query(
      `select id, chain_id, status, bracket, winner_token
         from public.arena_tournaments where id = $1 limit 1`,
      [tournamentId],
    )).rows[0] || null;
    if (!tournament) return { tournament: null, entries: [] };
    const entries = (await pool.query(
      `select token_address, owner_wallet, buy_in_paid
         from public.arena_tournament_entries
        where tournament_id = $1 and buy_in_paid = true
        order by created_at asc`,
      [tournamentId],
    )).rows;
    return { tournament, entries };
  } finally {
    await pool.end();
  }
}

async function defaultChainReaders({ chainId, poolId }) {
  const url = rpcUrl();
  if (!url) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(url, "confirmed");
  const pdas = deriveArenaOperatorPdas(poolId);
  const loadPool = async () => {
    const info = await connection.getAccountInfo(pdas.pool, "confirmed");
    return poolAccountToPlanner(info);
  };
  const loadConfig = async () => {
    const [info, genesisHash] = await Promise.all([
      connection.getAccountInfo(pdas.config, "confirmed"),
      connection.getGenesisHash(),
    ]);
    return configAccountToPlanner(info, genesisHash, Number(chainId));
  };
  // One buy-in receipt per place, in place order, as the program reads them.
  const loadReceipts = async (places) => Promise.all((places || []).map(async (place) => {
    const pubkey = deriveArenaBuyInReceipt(poolId, place.asset, place.wallet);
    const info = await connection.getAccountInfo(pubkey, "confirmed");
    return info ? { pubkey, owner: info.owner, data: info.data } : null;
  }));
  return { connection, loadPool, loadConfig, loadReceipts, pdas };
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

function printUsage() {
  console.error(`Arena operator worker is server-side only. Never route this through Phantom.

Usage:
  node scripts/solana/arena-operator-worker.mjs resolve --battle-id <id>
  node scripts/solana/arena-operator-worker.mjs claim-protocol --battle-id <id> | --tournament-id <id>
  node scripts/solana/arena-operator-worker.mjs claim-mwl --battle-id <id> | --tournament-id <id>
  node scripts/solana/arena-operator-worker.mjs resolve-tournament --tournament-id <id>
  Add --send to submit after a successful plan and simulation.
`);
}

function argValue(argv, flag) {
  return argv.includes(flag) ? String(argv[argv.indexOf(flag) + 1] || "") : "";
}

if (runningAsCli()) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const battleId = argValue(argv, "--battle-id");
  const tournamentId = argValue(argv, "--tournament-id");
  const send = argv.includes("--send");
  const tournamentScoped = command === "resolve-tournament" || (Boolean(tournamentId) && !battleId);
  if (!COMMANDS.includes(command) || (tournamentScoped ? !tournamentId : !battleId)) {
    printUsage();
    process.exit(2);
  }
  const resolver = loadKeypair("ARENA_RESOLVER_KEYPAIR");
  const payer = process.env.ARENA_OPERATOR_PAYER_KEYPAIR
    ? loadKeypair("ARENA_OPERATOR_PAYER_KEYPAIR")
    : resolver;
  const job = tournamentScoped
    ? defaultLoadTournament(tournamentId).then(async (loaded) => {
        if (!loaded?.tournament) return fail("tournament-not-found");
        const { connection, loadPool, loadConfig, loadReceipts } = await defaultChainReaders({
          chainId: loaded.tournament.chain_id,
          poolId: canonicalTournamentPoolIdBytes(tournamentId),
        });
        return runOperatorJob({
          command,
          tournamentId,
          send,
          loadTournament: async () => loaded,
          loadPool,
          loadConfig,
          loadReceipts,
          resolver,
          payer,
          sendResolvePlaces: async (plan, resolverKey, payerKey) =>
            sendPlannedPlacesResolve(connection, payerKey, plan, resolverKey),
          sendClaim: async (plan, payerKey) => sendPlannedClaim(connection, payerKey, plan, payerKey.publicKey),
        });
      })
    : defaultLoadSettlement(battleId).then(async (row) => {
        const settlement = settlementFromBattleRow(row);
        if (!settlement?.id) return fail("battle-not-found");
        const { connection, loadPool, loadConfig } = await defaultChainReaders({
          chainId: settlement.chain_id,
          poolId: canonicalBattlePoolIdBytes(settlement.id),
        });
        return runOperatorJob({
          command,
          battleId,
          send,
          loadSettlement: async () => row,
          loadPool,
          loadConfig,
          resolver,
          payer,
          sendResolve: async (plan, resolverKey, payerKey) =>
            sendPlannedResolve(connection, payerKey, plan, resolverKey),
          sendClaim: async (plan, payerKey) => sendPlannedClaim(connection, payerKey, plan, payerKey.publicKey),
        });
      });
  job
    .then((result) => {
      console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(String(error?.message || error));
      process.exit(1);
    });
}

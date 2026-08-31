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
  deriveArenaOperatorPdas,
} from "./arena-operator-v0.mjs";
import {
  assertEd25519Adjacency,
  canonicalBattlePoolIdBytes,
  planBattleResolve,
  planOperatorClaim,
  sendPlannedClaim,
  sendPlannedResolve,
} from "./arena-operator-resolve.mjs";

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

export async function runOperatorJob({
  command,
  battleId,
  send = false,
  loadSettlement,
  loadPool,
  loadConfig,
  sendResolve,
  sendClaim,
  resolver,
  payer,
} = {}) {
  const id = ident(battleId);
  if (!id) return fail("missing-battle-id");
  if (!["resolve", "claim-protocol", "claim-mwl"].includes(command)) return fail("unsupported-command");

  const settlement = settlementFromBattleRow(await loadSettlement(id));
  if (!settlement?.id) return fail("battle-not-found");
  if (settlement.state !== "finished") return fail("battle-not-finished");
  if (Number(settlement.chain_id) !== 101 && Number(settlement.chain_id) !== 102) return fail("not-solana");

  const pool = await loadPool(id, settlement);
  if (!pool) return fail("pool-unreadable");

  if (command === "resolve") {
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

async function defaultChainReaders(settlement) {
  const url = rpcUrl();
  if (!url) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(url, "confirmed");
  const chainId = Number(settlement.chain_id);
  const poolId = canonicalBattlePoolIdBytes(settlement.id);
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
    return configAccountToPlanner(info, genesisHash, chainId);
  };
  return { connection, loadPool, loadConfig, pdas };
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
  node scripts/solana/arena-operator-worker.mjs claim-protocol --battle-id <id>
  node scripts/solana/arena-operator-worker.mjs claim-mwl --battle-id <id>
  Add --send to submit after a successful plan and simulation.
`);
}

if (runningAsCli()) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const battleId = argv.includes("--battle-id") ? argv[argv.indexOf("--battle-id") + 1] : "";
  const send = argv.includes("--send");
  if (!["resolve", "claim-protocol", "claim-mwl"].includes(command) || !battleId) {
    printUsage();
    process.exit(2);
  }
  const resolver = loadKeypair("ARENA_RESOLVER_KEYPAIR");
  const payer = process.env.ARENA_OPERATOR_PAYER_KEYPAIR
    ? loadKeypair("ARENA_OPERATOR_PAYER_KEYPAIR")
    : resolver;
  defaultLoadSettlement(battleId)
    .then(async (row) => {
      const settlement = settlementFromBattleRow(row);
      if (!settlement?.id) return fail("battle-not-found");
      const { connection, loadPool, loadConfig } = await defaultChainReaders(settlement);
      const result = await runOperatorJob({
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
      console.log(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(String(error?.message || error));
      process.exit(1);
    });
}

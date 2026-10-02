import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pool } from "../server/db.js";
import {
  closeChampionshipEpoch,
  ensureChampionshipEpoch,
  finalizeMwlForChampionship,
} from "../api/lib/arenaQuarterlyChampionship.js";

const mode = String(process.argv[2] || "").trim();
const artifactPath = String(process.argv[3] || "artifacts/mwl-destructive-evidence.json").trim();

const AUTHORITY_SHA = String(process.env.AUTHORITY_SHA || "").trim();
const CERT_YEAR = Number(process.env.CERT_YEAR || 0);
const CERT_MONTH = Number(process.env.CERT_MONTH || 0);
const BSC97_RPC_URL = String(process.env.BSC97_RPC_URL || "").trim();
const SOLANA_DEVNET_RPC_URL = String(process.env.SOLANA_DEVNET_RPC_URL || "").trim();
const SOLANA_DEVNET_GENESIS_HASH = String(process.env.SOLANA_DEVNET_GENESIS_HASH || "").trim();

const EXPECTED_AUTHORITY = "df8e9dd32387cfe82f208c372461aa629f14cf84";
const BSC_CHAIN_ID = 97;
const SOLANA_APP_CHAIN_ID = 101;
const BPS_TOTAL = 10_000;
const MWL_BPS = 6_000;
const QUARTERLY_BPS = 4_000;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function assert(condition, code, details = {}) {
  if (!condition) fail(code, details);
}

function quarterForMonth(month) {
  return Math.floor((month - 1) / 3) + 1;
}

function canonicalSeasonId(chainId) {
  return `mwl-${CERT_YEAR}-m${String(CERT_MONTH).padStart(2, "0")}-c${chainId}`;
}

function canonicalEpochId(chainId) {
  return `quarterly-championship-${CERT_YEAR}-q${quarterForMonth(CERT_MONTH)}-c${chainId}`;
}

function certificationEventTimeIso() {
  return new Date(Date.UTC(CERT_YEAR, CERT_MONTH - 1, 15, 12, 0, 0)).toISOString();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert(response.ok, "RPC_HTTP_ERROR", { method, status: response.status });
  const body = await response.json();
  assert(!body.error, "RPC_JSON_ERROR", { method, error: body.error });
  return body.result;
}

async function proveChainIdentity() {
  const bscHex = await rpc(BSC97_RPC_URL, "eth_chainId");
  const bscChain = Number.parseInt(String(bscHex), 16);
  assert(bscChain === BSC_CHAIN_ID, "BSC97_CHAIN_ID_MISMATCH", { expected: BSC_CHAIN_ID, actual: bscChain, raw: bscHex });
  const bscBlockHex = await rpc(BSC97_RPC_URL, "eth_blockNumber");

  const solanaGenesis = String(await rpc(SOLANA_DEVNET_RPC_URL, "getGenesisHash"));
  assert(solanaGenesis === SOLANA_DEVNET_GENESIS_HASH, "SOLANA_DEVNET_GENESIS_MISMATCH", {
    expected: SOLANA_DEVNET_GENESIS_HASH,
    actual: solanaGenesis,
  });
  const solanaSlot = await rpc(SOLANA_DEVNET_RPC_URL, "getSlot", [{ commitment: "confirmed" }]);

  return {
    bsc97: {
      applicationChainId: BSC_CHAIN_ID,
      rpcChainId: bscChain,
      latestBlock: Number.parseInt(String(bscBlockHex), 16),
    },
    solanaDevnet: {
      applicationChainId: SOLANA_APP_CHAIN_ID,
      genesisHash: solanaGenesis,
      confirmedSlot: Number(solanaSlot),
    },
  };
}

async function requireSchema() {
  const required = [
    "arena_league_seasons",
    "arena_league_entries",
    "arena_league_point_events",
    "arena_mwl_finalizations",
    "arena_mwl_settlement_entitlements",
    "arena_championship_epochs",
    "arena_championship_entries",
    "arena_championship_mwl_results",
    "arena_championship_mwl_transfers",
    "arena_championship_point_events",
  ];
  const found = await pool.query(
    `select table_name from information_schema.tables where table_schema='public' and table_name = any($1::text[])`,
    [required],
  );
  const names = new Set(found.rows.map((row) => String(row.table_name)));
  const missing = required.filter((name) => !names.has(name));
  assert(missing.length === 0, "MWL_SCHEMA_INCOMPLETE", { missing });
}

async function assertNoFounderBonusPolicy(chainId) {
  const result = await pool.query(
    `select version,chain_id,status,active
       from public.arena_championship_bonus_policies
      where active=true and status='approved' and (chain_id=$1 or chain_id is null)`,
    [chainId],
  );
  assert(result.rows.length === 0, "FOUNDER_BONUS_POLICY_UNEXPECTEDLY_CONFIGURED", { chainId, policies: result.rows });
}

async function loadRealPostGradCandidates() {
  const result = await pool.query(
    `select chain_id,
            coalesce(nullif(token_address::text,''), campaign_address::text) as token_address,
            creator_address::text as creator_address,
            coalesce(name,'') as name,
            coalesce(symbol,'') as symbol,
            graduated_at_chain
       from public.campaigns
      where chain_id = any($1::int[])
        and graduated_at_chain is not null
        and coalesce(nullif(token_address::text,''), campaign_address::text) is not null
      order by graduated_at_chain desc nulls last, created_block desc nulls last`,
    [[BSC_CHAIN_ID, SOLANA_APP_CHAIN_ID]],
  );

  const byChain = new Map();
  for (const row of result.rows) {
    const chainId = Number(row.chain_id);
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(row);
  }
  const bsc = byChain.get(BSC_CHAIN_ID) || [];
  const sol = byChain.get(SOLANA_APP_CHAIN_ID) || [];
  assert(bsc.length > 0, "NO_REAL_POSTGRAD_TOKEN_BSC97");
  assert(sol.length > 0, "NO_REAL_POSTGRAD_TOKEN_SOLANA101");

  const solByText = new Map(sol.map((row) => [String(row.token_address).toLowerCase(), row]));
  const commonBsc = bsc.find((row) => solByText.has(String(row.token_address).toLowerCase()));
  if (commonBsc) {
    return {
      bsc: commonBsc,
      solana: solByText.get(String(commonBsc.token_address).toLowerCase()),
      sameTextIdentifierPractical: true,
    };
  }
  return { bsc: bsc[0], solana: sol[0], sameTextIdentifierPractical: false };
}

async function assertFreshCertificationIdentity() {
  const ids = [canonicalSeasonId(BSC_CHAIN_ID), canonicalSeasonId(SOLANA_APP_CHAIN_ID)];
  const seasons = await pool.query(`select id,chain_id,state,finalized_at from public.arena_league_seasons where id = any($1::text[])`, [ids]);
  assert(seasons.rows.length === 0, "CERTIFICATION_PERIOD_ALREADY_USED", { seasons: seasons.rows });
}

async function createCertificationSeason(chainId) {
  const quarter = quarterForMonth(CERT_MONTH);
  const epoch = await ensureChampionshipEpoch(pool, { chainId, year: CERT_YEAR, quarter });
  assert(String(epoch.id) === canonicalEpochId(chainId), "QUARTERLY_EPOCH_IDENTITY_MISMATCH", { chainId, epoch });
  assert(String(epoch.event_type) === "quarterly_championship", "QUARTERLY_EVENT_TYPE_MISMATCH", { chainId, epoch });

  const id = canonicalSeasonId(chainId);
  const resetAt = new Date(Date.UTC(CERT_YEAR, CERT_MONTH, 1, 0, 0, 0)).toISOString();
  const inserted = await pool.query(
    `insert into public.arena_league_seasons
       (id,chain_id,label,state,week,month,quarter,year,reset_at,active,mwl_epoch_key,championship_epoch_id)
     values ($1,$2,$3,'live',1,$4,$5,$6,$7,false,$1,$8)
     returning *`,
    [id, chainId, `MWL destructive certification ${CERT_YEAR}-${String(CERT_MONTH).padStart(2, "0")} c${chainId}`, CERT_MONTH, quarter, CERT_YEAR, resetAt, epoch.id],
  );
  return inserted.rows[0];
}

async function intakeAndMutateStanding(season, token, points) {
  const tokenAddress = String(token.token_address);
  await pool.query(
    `insert into public.arena_league_entries
       (season_id,token_address,token_name,symbol,points,wins,losses,finished_fights,checkin_streak)
     values ($1,$2,$3,$4,0,0,0,0,0)`,
    [season.id, tokenAddress, token.name || token.symbol || "Certification token", token.symbol || "CERT"],
  );

  const before = await pool.query(
    `select season_id,token_address,points,wins,losses,finished_fights
       from public.arena_league_entries where season_id=$1 and token_address=$2`,
    [season.id, tokenAddress],
  );
  assert(Number(before.rows[0]?.points) === 0, "MWL_INTAKE_INITIAL_STANDING_INVALID", { seasonId: season.id, row: before.rows[0] });

  const event = await pool.query(
    `insert into public.arena_league_point_events
       (season_id,token_address,kind,points,wallet,battle_id,pair_key,utc_day,metadata,created_at)
     values ($1,$2,'dispatch',$3,$4,null,null,$5,$6::jsonb,$7)
     returning id::text as id`,
    [
      season.id,
      tokenAddress,
      points,
      `mwz-certification-c${season.chain_id}`,
      certificationEventTimeIso().slice(0, 10),
      JSON.stringify({ certificationOnly: true, sourceAuthority: AUTHORITY_SHA, realPostGradIntake: true }),
      certificationEventTimeIso(),
    ],
  );

  await pool.query(
    `update public.arena_league_entries
        set points=points+$3, updated_at=now()
      where season_id=$1 and token_address=$2`,
    [season.id, tokenAddress, points],
  );

  const after = await pool.query(
    `select season_id,token_address,points,wins,losses,finished_fights
       from public.arena_league_entries where season_id=$1 and token_address=$2`,
    [season.id, tokenAddress],
  );
  assert(Number(after.rows[0]?.points) === points, "MWL_STANDINGS_MUTATION_FAILED", { seasonId: season.id, row: after.rows[0], expected: points });

  const mirrored = await pool.query(
    `select base_points,mwl_bonus_points,total_points
       from public.arena_championship_entries
      where epoch_id=$1 and token_address=$2`,
    [season.championship_epoch_id, tokenAddress],
  );
  assert(Number(mirrored.rows[0]?.base_points) === points, "QUARTERLY_CONTINUOUS_BASE_POINTS_MISSING", { seasonId: season.id, mirrored: mirrored.rows[0], expected: points });
  assert(Number(mirrored.rows[0]?.mwl_bonus_points || 0) === 0, "FABRICATED_QUARTERLY_BONUS_POINTS", { seasonId: season.id, mirrored: mirrored.rows[0] });

  return { before: before.rows[0], after: after.rows[0], ledgerEventId: event.rows[0].id, quarterlyStanding: mirrored.rows[0] };
}

async function proveCrossChainIsolation(season97, season101, token97, token101, sameTextIdentifierPractical) {
  const rows = await pool.query(
    `select s.chain_id,e.season_id,e.token_address,e.points
       from public.arena_league_entries e
       join public.arena_league_seasons s on s.id=e.season_id
      where e.season_id = any($1::text[])
      order by s.chain_id,e.token_address`,
    [[season97.id, season101.id]],
  );
  assert(rows.rows.length === 2, "CROSS_CHAIN_ENTRY_COUNT_INVALID", { rows: rows.rows });
  const bsc = rows.rows.find((row) => Number(row.chain_id) === BSC_CHAIN_ID);
  const sol = rows.rows.find((row) => Number(row.chain_id) === SOLANA_APP_CHAIN_ID);
  assert(bsc && sol, "CROSS_CHAIN_SEASON_IDENTITY_MISSING", { rows: rows.rows });
  assert(String(bsc.season_id) === season97.id && String(sol.season_id) === season101.id, "CROSS_CHAIN_SEASON_CONTAMINATION", { rows: rows.rows });
  assert(Number(bsc.points) === 3 && Number(sol.points) === 5, "CROSS_CHAIN_STANDING_CONTAMINATION", { rows: rows.rows });

  if (sameTextIdentifierPractical) {
    assert(String(bsc.token_address).toLowerCase() === String(sol.token_address).toLowerCase(), "EXPECTED_SHARED_TEXT_IDENTIFIER_MISSING", { rows: rows.rows });
  } else {
    assert(String(bsc.token_address) === String(token97.token_address), "BSC_TOKEN_IDENTITY_CHANGED", { expected: token97.token_address, actual: bsc.token_address });
    assert(String(sol.token_address) === String(token101.token_address), "SOLANA_TOKEN_IDENTITY_CHANGED", { expected: token101.token_address, actual: sol.token_address });
  }

  return rows.rows;
}

async function persistFinalizationAuthority(season) {
  const chainId = Number(season.chain_id);
  const treasury = String(process.env[`MONTHLY_LEAGUE_TREASURY_ADDRESS_${chainId}`] || "").trim();
  assert(treasury, "MWL_TREASURY_SECRET_MISSING", { chainId });
  const monthId = `${CERT_YEAR}${String(CERT_MONTH).padStart(2, "0")}`;
  const configKey = `MONTHLY_LEAGUE_TREASURY_ADDRESS_${chainId}`;

  await pool.query(
    `insert into public.arena_mwl_finalizations
       (season_id,chain_id,year,month,month_id,treasury_id,treasury_config_key,reserve_share_bps,result_version,entitlement_identity_version,finalized_at)
     values ($1,$2,$3,$4,$5,$6,$7,6000,'mwl_result_v1','mwl_entitlement_v1',now())
     on conflict (season_id) do nothing`,
    [season.id, chainId, CERT_YEAR, CERT_MONTH, monthId, treasury, configKey],
  );
  const row = (await pool.query(`select * from public.arena_mwl_finalizations where season_id=$1`, [season.id])).rows[0];
  assert(Number(row.reserve_share_bps) === MWL_BPS, "MWL_60_PERCENT_RESERVE_ASSERTION_FAILED", { row });
  assert(BPS_TOTAL - Number(row.reserve_share_bps) === QUARTERLY_BPS, "QUARTERLY_40_PERCENT_RESERVE_ASSERTION_FAILED", { row });
  assert(Number(row.chain_id) === chainId && String(row.month_id) === monthId && String(row.treasury_id) === treasury, "MWL_FINALIZATION_IDENTITY_MISMATCH", { row });
  return {
    seasonId: row.season_id,
    chainId: Number(row.chain_id),
    monthId: row.month_id,
    treasuryId: row.treasury_id,
    treasuryConfigKey: row.treasury_config_key,
    mwlReserveBps: Number(row.reserve_share_bps),
    quarterlyReserveBps: BPS_TOTAL - Number(row.reserve_share_bps),
    resultVersion: row.result_version,
    entitlementIdentityVersion: row.entitlement_identity_version,
  };
}

async function snapshotForSeason(seasonId) {
  const rows = (await pool.query(
    `select season_id,token_address,token_name,symbol,final_rank,mwl_points,wins,losses,finished_fights,captured_at
       from public.arena_championship_mwl_results
      where season_id=$1 order by final_rank,token_address`,
    [seasonId],
  )).rows;
  return { rows, hash: stableHash(rows.map(({ captured_at, ...row }) => row)) };
}

async function proveFinalization(season) {
  const first = await finalizeMwlForChampionship(pool, season.id);
  assert(first.ok === true && first.idempotent === false, "MWL_FIRST_FINALIZER_FAILED", { seasonId: season.id, first });
  assert(first.bonusTransfer?.status === "pending_policy", "QUARTERLY_TRANSFER_NOT_PENDING_POLICY", { seasonId: season.id, first });
  assert(first.bonusTransfer?.reason === "CHAMPIONSHIP_BONUS_POLICY_NOT_CONFIGURED", "QUARTERLY_POLICY_FAIL_CLOSED_REASON_MISMATCH", { seasonId: season.id, first });

  const authority = await persistFinalizationAuthority(season);
  const snapshot1 = await snapshotForSeason(season.id);
  assert(snapshot1.rows.length > 0, "MWL_FINALIZED_SNAPSHOT_EMPTY", { seasonId: season.id });

  const firstRow = snapshot1.rows[0];
  await pool.query(
    `insert into public.arena_championship_mwl_results
       (season_id,token_address,token_name,symbol,final_rank,mwl_points,wins,losses,finished_fights)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (season_id,token_address) do nothing`,
    [season.id, firstRow.token_address, "MUTATION MUST NOT LAND", "NOPE", firstRow.final_rank, Number(firstRow.mwl_points) + 999, 999, 999, 999],
  );
  const snapshotAfterMutationAttempt = await snapshotForSeason(season.id);
  assert(snapshotAfterMutationAttempt.hash === snapshot1.hash, "MWL_FINALIZED_SNAPSHOT_MUTATED", { seasonId: season.id, before: snapshot1, after: snapshotAfterMutationAttempt });

  const second = await finalizeMwlForChampionship(pool, season.id);
  assert(second.ok === true && second.idempotent === true, "MWL_SECOND_FINALIZER_NOT_INERT", { seasonId: season.id, second });
  const snapshot2 = await snapshotForSeason(season.id);
  assert(snapshot2.hash === snapshot1.hash, "MWL_SECOND_FINALIZER_CHANGED_SNAPSHOT", { seasonId: season.id, before: snapshot1, after: snapshot2 });

  const transferRows = (await pool.query(`select * from public.arena_championship_mwl_transfers where season_id=$1`, [season.id])).rows;
  assert(transferRows.length === 1 && transferRows[0].status === "pending_policy" && transferRows[0].policy_version == null && transferRows[0].applied_at == null,
    "QUARTERLY_PENDING_TRANSFER_IDENTITY_INVALID", { seasonId: season.id, transferRows });

  const bonusEvents = await pool.query(
    `select count(*)::int as count,coalesce(sum(points),0)::text as points
       from public.arena_championship_point_events
      where epoch_id=$1 and source_kind='mwl_bonus'`,
    [first.quarterlyChampionshipId],
  );
  assert(Number(bonusEvents.rows[0].count) === 0 && Number(bonusEvents.rows[0].points) === 0,
    "FABRICATED_CHAMPIONSHIP_BONUS_EVENT", { seasonId: season.id, bonusEvents: bonusEvents.rows[0] });

  const epoch = (await pool.query(`select * from public.arena_championship_epochs where id=$1`, [first.quarterlyChampionshipId])).rows[0];
  const close = await closeChampionshipEpoch(pool, { epochId: epoch.id, nowMs: new Date(epoch.closes_at).getTime() + 1 });
  assert(close.ok === false && close.reason === "CHAMPIONSHIP_BONUS_TRANSFERS_PENDING",
    "QUARTERLY_CLOSE_DID_NOT_FAIL_CLOSED", { seasonId: season.id, close });

  const entitlements = await pool.query(`select * from public.arena_mwl_settlement_entitlements where season_id=$1`, [season.id]);
  assert(entitlements.rows.length === 0, "UNAPPROVED_MWL_ENTITLEMENT_FABRICATED", { seasonId: season.id, entitlements: entitlements.rows });

  return {
    firstFinalizer: first,
    secondFinalizer: second,
    finalizationAuthority: authority,
    immutableSnapshotHash: snapshot1.hash,
    snapshotRows: snapshot1.rows,
    pendingTransfer: transferRows[0],
    bonusEvents: bonusEvents.rows[0],
    quarterlyClose: close,
    entitlementGeneration: {
      currentRuntimeGeneratorDefined: false,
      generatedRows: 0,
      status: "NOT_DEFINED_AT_CURRENT_RUNTIME_NO_FABRICATION",
    },
  };
}

async function destroy() {
  assert(AUTHORITY_SHA === EXPECTED_AUTHORITY, "SOURCE_AUTHORITY_MISMATCH", { expected: EXPECTED_AUTHORITY, actual: AUTHORITY_SHA });
  assert(Number.isInteger(CERT_YEAR) && CERT_YEAR >= 2030 && CERT_YEAR <= 2199, "CERT_YEAR_INVALID", { CERT_YEAR });
  assert(Number.isInteger(CERT_MONTH) && CERT_MONTH >= 1 && CERT_MONTH <= 12, "CERT_MONTH_INVALID", { CERT_MONTH });
  assert(BSC97_RPC_URL && SOLANA_DEVNET_RPC_URL && SOLANA_DEVNET_GENESIS_HASH, "CHAIN_RPC_CONFIGURATION_MISSING");

  await requireSchema();
  await assertNoFounderBonusPolicy(BSC_CHAIN_ID);
  await assertNoFounderBonusPolicy(SOLANA_APP_CHAIN_ID);
  await assertFreshCertificationIdentity();

  const chainIdentity = await proveChainIdentity();
  const candidates = await loadRealPostGradCandidates();
  const season97 = await createCertificationSeason(BSC_CHAIN_ID);
  const season101 = await createCertificationSeason(SOLANA_APP_CHAIN_ID);

  const bscStanding = await intakeAndMutateStanding(season97, candidates.bsc, 3);
  const solanaStanding = await intakeAndMutateStanding(season101, candidates.solana, 5);
  const isolation = await proveCrossChainIsolation(season97, season101, candidates.bsc, candidates.solana, candidates.sameTextIdentifierPractical);

  const bscFinalization = await proveFinalization(season97);
  const solanaFinalization = await proveFinalization(season101);

  const evidence = {
    verdict: "DESTROY_PHASE_PASS_RELOAD_REQUIRED",
    productionAuthority: AUTHORITY_SHA,
    certificationOnly: true,
    generatedAt: new Date().toISOString(),
    certificationPeriod: { year: CERT_YEAR, month: CERT_MONTH, quarter: quarterForMonth(CERT_MONTH) },
    chainIdentity,
    realPostGradIntake: {
      bsc97: candidates.bsc,
      solanaDevnet: candidates.solana,
      sameTextIdentifierPractical: candidates.sameTextIdentifierPractical,
    },
    seasons: {
      bsc97: { id: season97.id, chainId: Number(season97.chain_id), championshipEpochId: season97.championship_epoch_id },
      solanaDevnet: { id: season101.id, chainId: Number(season101.chain_id), championshipEpochId: season101.championship_epoch_id },
    },
    standingsMutation: { bsc97: bscStanding, solanaDevnet: solanaStanding },
    crossChainIsolation: isolation,
    finalization: { bsc97: bscFinalization, solanaDevnet: solanaFinalization },
    approvedEconomics: { mwlReserveBps: MWL_BPS, quarterlyReserveBps: QUARTERLY_BPS },
  };
  await fs.writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: evidence.verdict, artifactPath, seasons: evidence.seasons, sameTextIdentifierPractical: candidates.sameTextIdentifierPractical }, null, 2));
}

async function reload() {
  const original = JSON.parse(await fs.readFile(artifactPath, "utf8"));
  assert(original.productionAuthority === EXPECTED_AUTHORITY, "RELOAD_AUTHORITY_MISMATCH", { originalAuthority: original.productionAuthority });
  const results = {};

  for (const [label, seasonInfo] of Object.entries(original.seasons)) {
    const season = (await pool.query(`select * from public.arena_league_seasons where id=$1 and chain_id=$2`, [seasonInfo.id, seasonInfo.chainId])).rows[0];
    assert(season && season.state === "completed" && season.active === false && season.finalized_at, "RELOAD_FINALIZED_SEASON_MISSING", { label, seasonInfo, season });

    const snapshot = await snapshotForSeason(seasonInfo.id);
    const expectedHash = original.finalization[label].immutableSnapshotHash;
    assert(snapshot.hash === expectedHash, "RELOAD_SNAPSHOT_HASH_MISMATCH", { label, expectedHash, actualHash: snapshot.hash });

    const transfer = (await pool.query(`select * from public.arena_championship_mwl_transfers where season_id=$1`, [seasonInfo.id])).rows[0];
    assert(transfer?.status === "pending_policy" && transfer.policy_version == null && transfer.applied_at == null, "RELOAD_PENDING_POLICY_TRANSFER_MISSING", { label, transfer });

    const finalization = (await pool.query(`select * from public.arena_mwl_finalizations where season_id=$1`, [seasonInfo.id])).rows[0];
    assert(Number(finalization?.reserve_share_bps) === MWL_BPS, "RELOAD_MWL_RESERVE_SPLIT_MISMATCH", { label, finalization });
    assert(BPS_TOTAL - Number(finalization.reserve_share_bps) === QUARTERLY_BPS, "RELOAD_QUARTERLY_RESERVE_SPLIT_MISMATCH", { label, finalization });

    const bonus = (await pool.query(
      `select count(*)::int as count,coalesce(sum(points),0)::text as points from public.arena_championship_point_events where epoch_id=$1 and source_kind='mwl_bonus'`,
      [seasonInfo.championshipEpochId],
    )).rows[0];
    assert(Number(bonus.count) === 0 && Number(bonus.points) === 0, "RELOAD_FABRICATED_BONUS_POINTS", { label, bonus });

    const epoch = (await pool.query(`select * from public.arena_championship_epochs where id=$1`, [seasonInfo.championshipEpochId])).rows[0];
    const close = await closeChampionshipEpoch(pool, { epochId: epoch.id, nowMs: new Date(epoch.closes_at).getTime() + 1 });
    assert(close.ok === false && close.reason === "CHAMPIONSHIP_BONUS_TRANSFERS_PENDING", "RELOAD_QUARTERLY_CLOSE_NOT_FAIL_CLOSED", { label, close });

    results[label] = {
      seasonState: season.state,
      finalizedAt: season.finalized_at,
      snapshotHash: snapshot.hash,
      transferStatus: transfer.status,
      mwlReserveBps: Number(finalization.reserve_share_bps),
      quarterlyReserveBps: BPS_TOTAL - Number(finalization.reserve_share_bps),
      bonusPoints: Number(bonus.points),
      quarterlyCloseReason: close.reason,
    };
  }

  original.reload = {
    verdict: "PASS",
    restartedProcess: true,
    reloadedAt: new Date().toISOString(),
    results,
  };
  original.verdict = "PASS";
  await fs.writeFile(artifactPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: "PASS", restartedProcess: true, results }, null, 2));
}

try {
  if (mode === "destroy") await destroy();
  else if (mode === "reload") await reload();
  else fail("MODE_REQUIRED", { supported: ["destroy", "reload"] });
} catch (error) {
  const failure = {
    verdict: "FAIL",
    mode,
    productionAuthority: AUTHORITY_SHA,
    error: String(error?.message || error),
    code: error?.code || null,
    details: error?.details || null,
    failedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(new URL(".", `file://${process.cwd()}/${artifactPath}`).pathname, { recursive: true });
  } catch {}
  try {
    await fs.writeFile(artifactPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  } catch {}
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}

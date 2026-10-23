// t23: the DogeOS (6281971) staging migrations for Barkswap, applied by database/staging_apply_dogeos_barkswap.sh:
//   1. 20261010_000020_dogeos_chain_launch_path.sql (unchanged; its checks moved here from the deleted
//      dogeosLaunchPathMigration.test.mjs): every constraint it re-creates equals its latest prior definition with
//      6281971 added in exactly the expected place and nothing else;
//   2. 20261015_000010_dogeos_barkswap.sql: the Bark conversion bookkeeping tables, the side-pool venue 'algebra' and
//      the attribution replay's accrual index. Pinned against the indexer source so the two cannot drift.
//   3. 20261023_000010_dogeos_drafts_graduation_target.sql: the draft graduation check as 20261019 (staging-live-gen8)
//      has it plus 6281971, so applying 20261010 never takes 97 / 46630 out of the $150 clause.
//
//   node --test db/migrations/dogeosBarkswapMigration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MIGRATIONS_DIR, "..", "..");
const LAUNCH_FILE = "20261010_000020_dogeos_chain_launch_path.sql";
const BARK_FILE = "20261015_000010_dogeos_barkswap.sql";
const TARGET_FILE = "20261023_000010_dogeos_drafts_graduation_target.sql";
const APPLY_SCRIPT = join(REPO_ROOT, "database", "staging_apply_dogeos_barkswap.sh");
const OLD_APPLY_SCRIPT = join(REPO_ROOT, "database", "staging_apply_dogeos_launch_path.sh");
const INDEXER_EVM = join(REPO_ROOT, "realtime-indexer", "src", "evm");
const DOGEOS = 6281971;

// ------------------------------------------------------------------ helpers

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

function normalize(expr) {
  return expr.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

// Index of the parenthesis that closes the one at `open`.
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parentheses");
}

// Text of the check expression (outer parentheses included) for `constraint <name> check (...)`.
function checkExpression(sql, name) {
  const body = stripComments(sql);
  const re = new RegExp(`constraint\\s+${name}\\s+check\\s*\\(`, "gi");
  const matches = [...body.matchAll(re)];
  if (matches.length === 0) return null;
  assert.equal(matches.length, 1, `${name} is defined more than once in one file`);
  const open = matches[0].index + matches[0][0].length - 1;
  return normalize(body.slice(open, closingParen(body, open) + 1));
}

// Latest migration (by filename order) before `beforeFile` that defines the constraint.
function latestPriorDefinition(name, beforeFile) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < beforeFile)
    .sort();
  let found = null;
  for (const f of files) {
    const expr = checkExpression(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), name);
    if (expr) found = { file: f, expr };
  }
  assert.ok(found, `no prior definition of ${name}`);
  return found;
}

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `expected fragment not found: ${from}`);
  assert.equal(text.indexOf(from, at + 1), -1, `fragment occurs more than once: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

function statementsOf(body) {
  return body
    .split(";")
    .map((s) => normalize(s))
    .filter(Boolean);
}

function quotedValues(expr) {
  return [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => normalize(s)).filter(Boolean);
}

// Columns (name -> definition text) and unique column lists of `create table if not exists public.<table> (...)`.
function tableDef(sql, table) {
  const body = stripComments(sql);
  const re = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\(`, "gi");
  const matches = [...body.matchAll(re)];
  assert.equal(matches.length, 1, `public.${table} must be created exactly once, with if not exists`);
  const open = matches[0].index + matches[0][0].length - 1;
  const items = splitTopLevel(body.slice(open + 1, closingParen(body, open)));
  const columns = new Map();
  const uniques = [];
  for (const item of items) {
    const unique = item.match(/^(?:constraint\s+\w+\s+)?unique\s*\(([^)]*)\)$/i);
    if (unique) {
      uniques.push(unique[1].split(",").map((s) => s.trim()));
      continue;
    }
    if (/^(constraint|primary|check|foreign)\b/i.test(item)) continue;
    const [name, ...rest] = item.split(" ");
    columns.set(name, rest.join(" ").toLowerCase());
  }
  return { columns, uniques };
}

// SQL template literals of an indexer source file.
function sqlLiterals(file) {
  const src = readFileSync(join(INDEXER_EVM, file), "utf8");
  return [...src.matchAll(/`([^`]*)`/g)].map((m) => normalize(m[1]));
}

const SQL_WORDS = new Set(["min", "max", "sum", "count", "coalesce", "text", "as", "null", "and", "or", "is", "not", "now"]);

// Every column a statement names on `table` (inserts, set lists, select lists, where / order by). A deliberately small
// parser for the indexer's own SQL shapes, not general SQL: its job is to catch a column the indexer uses that the
// migration lacks (drift). If a statement shape changes so the parser no longer sees it, the "checked" floor in the
// test below fails instead of the check silently covering nothing.
function columnsUsedOn(stmt, table) {
  const used = new Set();
  const add = (s) => {
    for (const id of s.match(/[a-z_][a-z0-9_]*/gi) || []) if (!SQL_WORDS.has(id.toLowerCase())) used.add(id);
  };
  const ins = stmt.match(new RegExp(`insert into public\\.${table}\\s*\\(([^)]*)\\)`, "i"));
  if (ins) ins[1].split(",").forEach((c) => used.add(c.trim()));
  const conflict = stmt.match(/on conflict \(([^)]*)\)/i);
  if (ins && conflict) conflict[1].split(",").forEach((c) => used.add(c.trim()));
  const upd = stmt.match(new RegExp(`^update public\\.${table} set (.*?) where (.*)$`, "i"));
  if (upd) {
    for (const part of splitTopLevel(upd[1])) used.add(part.split("=")[0].trim());
    add(upd[2].replace(/\$\d+/g, ""));
  }
  const sel = stmt.match(new RegExp(`^select (.*?) from public\\.${table} where (.*)$`, "i"));
  if (sel) {
    for (const item of splitTopLevel(sel[1])) add(item.replace(/\s+as\s+\w+$/i, "").replace(/::\w+/g, "").replace(/\b\d+\b/g, ""));
    add(sel[2].replace(/\$\d+/g, "").replace(/'[^']*'/g, "").replace(/\blimit \d+/i, "").replace(/\border by\b/i, ""));
  }
  const alias = stmt.match(new RegExp(`public\\.${table} (\\w+)\\b(?! set)`, "i"));
  if (alias && !["where", "set"].includes(alias[1].toLowerCase())) {
    for (const m of stmt.matchAll(new RegExp(`\\b${alias[1]}\\.([a-z_]+)`, "gi"))) used.add(m[1]);
  }
  // order by aliases of the select list (source_log_index as log_index ... order by credit_log_index) are not columns
  for (const m of stmt.matchAll(/\bas (\w+)/gi)) used.delete(m[1]);
  return used;
}

const launchSql = readFileSync(join(MIGRATIONS_DIR, LAUNCH_FILE), "utf8");
const launchBody = stripComments(launchSql);
const barkSql = readFileSync(join(MIGRATIONS_DIR, BARK_FILE), "utf8");
const barkBody = stripComments(barkSql);
const barkStatements = statementsOf(barkBody);

// ================================================================== 20261010 (moved from dogeosLaunchPathMigration.test.mjs)

function chainIdLists(expr) {
  return [...expr.matchAll(/chain_id in \(([^)]*)\)/g)].map((m) => m[1].split(",").map((s) => Number(s.trim())));
}

// Each re-created constraint: its table and the single textual change from the prior definition.
const LAUNCH_EXPECTED = {
  campaign_draft_evm_launch_options_chain_chk: {
    table: "public.campaign_draft_evm_launch_options",
    priorFile: "20260930_100001_campaign_draft_evm_launch_options.sql",
    from: "chain_id in (56, 97, 4663, 46630, 31337)",
    to: "chain_id in (56, 97, 4663, 46630, 31337, 6281971)",
  },
  campaign_drafts_graduation_target_check: {
    table: "public.campaign_drafts",
    priorFile: "20260929_000011_campaign_drafts_dbc_quote.sql",
    // Only the $150 clause gains 6281971; the $6 clause stays (97, 101, 102).
    from: "graduation_target_wei <> 150000000000000000000::numeric or chain_id in (101, 102)",
    to: "graduation_target_wei <> 150000000000000000000::numeric or chain_id in (101, 102, 6281971)",
  },
};

for (const [name, spec] of Object.entries(LAUNCH_EXPECTED)) {
  test(`20261010 ${name}: equals its latest prior definition plus 6281971 only`, () => {
    const prior = latestPriorDefinition(name, LAUNCH_FILE);
    assert.equal(prior.file, spec.priorFile, "latest prior definition moved; re-check this migration");
    const actual = checkExpression(launchSql, name);
    assert.ok(actual, `${name} is not re-created`);
    assert.equal(actual, replaceOnce(prior.expr, spec.from, spec.to));
  });

  test(`20261010 ${name}: every pre-existing chain id kept, 6281971 added`, () => {
    const prior = chainIdLists(latestPriorDefinition(name, LAUNCH_FILE).expr);
    const actual = chainIdLists(checkExpression(launchSql, name));
    assert.equal(actual.length, prior.length);
    prior.forEach((ids, i) => {
      for (const id of ids) assert.ok(actual[i].includes(id), `${name} list ${i} lost chain ${id}`);
      const added = actual[i].filter((id) => !ids.includes(id));
      assert.ok(added.every((id) => id === DOGEOS), `${name} list ${i} added ${added}`);
    });
    assert.ok(actual.some((ids) => ids.includes(DOGEOS)), `${name} does not include 6281971`);
  });

  test(`20261010 ${name}: idempotent drop if exists, then add, on ${spec.table}`, () => {
    const t = spec.table.replace(".", "\\.");
    const drop = new RegExp(`alter table ${t} drop constraint if exists ${name};`, "i");
    const add = new RegExp(`alter table ${t} add constraint ${name} check`, "i");
    const flat = normalize(launchBody);
    assert.match(flat, drop);
    assert.match(flat, add);
    assert.ok(flat.search(drop) < flat.search(add), "drop must precede add");
  });
}

test("20261010 $6 graduation clause is untouched (no 6281971)", () => {
  const expr = checkExpression(launchSql, "campaign_drafts_graduation_target_check");
  assert.ok(expr.includes("graduation_target_wei <> 6000000000000000000::numeric or chain_id in (97, 101, 102))"));
});

test("20261010 own transaction: begin; first, commit; last", () => {
  const statements = launchBody
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements[0].toLowerCase(), "begin");
  assert.equal(statements.at(-1).toLowerCase(), "commit");
  assert.equal(statements.filter((s) => /^(begin|commit)$/i.test(s)).length, 2);
});

test("20261010 touches no other constraint, table or data", () => {
  const names = new Set([...launchBody.matchAll(/constraint\s+(?:if\s+exists\s+)?(\w+)/gi)].map((m) => m[1]));
  assert.deepEqual([...names].sort(), Object.keys(LAUNCH_EXPECTED).sort());
  const tables = new Set([...launchBody.matchAll(/alter\s+table\s+([\w.]+)/gi)].map((m) => m[1]));
  assert.deepEqual([...tables].sort(), Object.values(LAUNCH_EXPECTED).map((s) => s.table).sort());
  const statements = launchBody
    .split(";")
    .map((s) => normalize(s))
    .filter((s) => s && !/^(begin|commit)$/i.test(s));
  assert.equal(statements.length, 4, "exactly a drop + add per constraint");
  for (const s of statements) assert.match(s, /^alter table [\w.]+ (drop constraint if exists|add constraint) \w+/i);
  assert.doesNotMatch(launchBody, /\b(insert|update|delete|truncate|drop\s+table|drop\s+column|create)\b/i);
});

// ================================================================== 20261023 (draft graduation check on top of 20261019)

const TARGET_CHK = "campaign_drafts_graduation_target_check";
const targetSql = readFileSync(join(MIGRATIONS_DIR, TARGET_FILE), "utf8");
const targetBody = stripComments(targetSql);

test("20261023 graduation check: equals its latest prior definition (20261019) plus 6281971 in the $150 clause only", () => {
  const prior = latestPriorDefinition(TARGET_CHK, TARGET_FILE);
  assert.equal(prior.file, "20261019_000001_campaign_drafts_gen8_test_target.sql", "latest prior definition moved; re-check this migration");
  assert.equal(
    checkExpression(targetSql, TARGET_CHK),
    replaceOnce(prior.expr, "graduation_target_wei <> 150000000000000000000::numeric or chain_id in (97, 46630, 101, 102)", "graduation_target_wei <> 150000000000000000000::numeric or chain_id in (97, 46630, 101, 102, 6281971)"),
  );
});

test("20261023 graduation check: the bundle's last definition keeps every chain of every earlier definition", () => {
  // Every definition before 20261023, including 20261010 (applied earlier in the same bundle) and 20261019.
  const expr = checkExpression(targetSql, TARGET_CHK);
  const finalLists = chainIdLists(expr);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql") && x < TARGET_FILE).sort()) {
    const earlier = checkExpression(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), TARGET_CHK);
    if (!earlier) continue;
    const lists = chainIdLists(earlier);
    if (lists.length !== finalLists.length) continue; // the pre-Solana shapes had a different clause layout
    lists.forEach((ids, i) => ids.forEach((id) => assert.ok(finalLists[i].includes(id), `${f}: list ${i} chain ${id} lost`)));
  }
});

test("20261023 own transaction, one drop + one add, no data change", () => {
  const statements = targetBody.split(";").map((x) => normalize(x)).filter(Boolean);
  assert.equal(statements[0].toLowerCase(), "begin");
  assert.equal(statements.at(-1).toLowerCase(), "commit");
  const body = statements.filter((x) => !/^(begin|commit)$/i.test(x));
  assert.equal(body.length, 2);
  assert.match(body[0], new RegExp(`^alter table public\\.campaign_drafts drop constraint if exists ${TARGET_CHK}$`, "i"));
  assert.match(body[1], new RegExp(`^alter table public\\.campaign_drafts add constraint ${TARGET_CHK} check`, "i"));
  assert.doesNotMatch(targetBody, /\b(insert|update|delete|truncate|drop\s+table|drop\s+column|create)\b/i);
});

// ================================================================== 20261015 (Barkswap rows)

const SELL_FEES = "evm_gen8_bark_sell_fees";
const CREDITS = "evm_gen8_bark_credits";
const BARK_TABLES = [SELL_FEES, CREDITS];

// The indexer's ON CONFLICT targets (evmGen8BarkAttribution.ts insertBarkSellFee / insertCredit).
const UNIQUE_TARGETS = {
  [SELL_FEES]: ["chain_id", "tx_hash", "log_index"],
  [CREDITS]: ["chain_id", "tx_hash", "log_index", "book", "source_tx_hash", "source_log_index"],
};

test("20261015: header records that 20261010 stays as is and is applied first", () => {
  assert.match(barkSql, /20261010_000020_dogeos_chain_launch_path\.sql stays as is/);
});

test("20261015: own transaction: begin; first, commit; last", () => {
  assert.equal(barkStatements[0].toLowerCase(), "begin");
  assert.equal(barkStatements.at(-1).toLowerCase(), "commit");
  assert.equal(barkStatements.filter((s) => /^(begin|commit)$/i.test(s)).length, 2);
});

for (const table of BARK_TABLES) {
  test(`20261015 ${table}: unique (${UNIQUE_TARGETS[table].join(", ")}) is the indexer's ON CONFLICT target`, () => {
    const { uniques } = tableDef(barkSql, table);
    assert.deepEqual(uniques, [UNIQUE_TARGETS[table]]);
  });

  test(`20261015 ${table}: RLS on, no access for anon / authenticated (as the gen-8 tables)`, () => {
    const flat = barkStatements.join(";\n");
    assert.ok(flat.includes(`alter table public.${table} enable row level security`), "RLS not enabled");
    assert.ok(flat.includes(`revoke all on public.${table} from anon, authenticated`), "anon / authenticated not revoked");
  });
}

test("indexer ON CONFLICT targets on the Bark tables equal the migration's unique columns (no drift)", () => {
  const seen = new Set();
  for (const file of readdirSync(INDEXER_EVM).filter((f) => f.endsWith(".ts"))) {
    for (const stmt of sqlLiterals(file)) {
      const ins = stmt.match(/insert into public\.(evm_gen8_bark_\w+)\s*\(/i);
      if (!ins) continue;
      const conflict = stmt.match(/on conflict \(([^)]*)\)/i);
      assert.ok(conflict, `${file}: insert into ${ins[1]} without an on conflict target`);
      const target = conflict[1].split(",").map((s) => s.trim());
      const { uniques } = tableDef(barkSql, ins[1]);
      assert.ok(uniques.some((u) => u.join(",") === target.join(",")), `${file}: on conflict (${target}) on ${ins[1]} has no matching unique in ${BARK_FILE}`);
      seen.add(ins[1]);
    }
  }
  assert.deepEqual([...seen].sort(), [...BARK_TABLES].sort(), "every Bark table is written by the indexer");
});

test("every column the indexer names on the Bark tables exists in the migration", () => {
  const defs = Object.fromEntries(BARK_TABLES.map((t) => [t, tableDef(barkSql, t).columns]));
  let checked = 0;
  for (const file of readdirSync(INDEXER_EVM).filter((f) => f.endsWith(".ts"))) {
    for (const stmt of sqlLiterals(file)) {
      for (const table of BARK_TABLES) {
        if (!stmt.includes(`public.${table}`)) continue;
        for (const col of columnsUsedOn(stmt, table)) {
          if (stmt.match(/public\.evm_gen8_fee_accruals a\b/) && !stmt.includes(`c.${col}`)) continue; // the join's other side
          assert.ok(defs[table].has(col), `${file}: column ${col} of ${table} is not in ${BARK_FILE}\n${stmt}`);
          checked += 1;
        }
      }
    }
  }
  // Floor, not a pin: today 99 column references are checked. Fewer than 60 means columnsUsedOn stopped recognizing
  // the indexer's statements (a parser miss), which would make the loop above pass vacuously.
  assert.ok(checked > 60, `too few columns checked (${checked}); the source parser lost the statements`);
});

// Types and nullability of what the indexer writes: amounts are uint256 strings, positions are the gen-8 types,
// run_id is the splitter run (bigint, as evm_gen8_fee_accruals.run_id and evm_gen8_route_runs.run_id).
const TYPE_PINS = {
  [SELL_FEES]: {
    chain_id: /^integer not null/, tx_hash: /^text not null/, log_index: /^integer not null/, block_number: /^bigint not null/, block_time: /^timestamptz not null/,
    phase: /^text not null/, trader: /^text$/, swap_sender: /^text$/, profile: /^text$/,
    gross_fee_coins: /^numeric\(78,0\) not null$/, net_fee_coins: /^numeric\(78,0\) not null$/, creator_coins: /^numeric\(78,0\) not null$/,
    router_coins: /^numeric\(78,0\) not null$/, expected_native: /^numeric\(78,0\) not null$/,
    booked_coins: /^numeric\(78,0\)$/, collect_tx_hash: /^text$/, collect_log_index: /^integer$/,
    converted_coins: /^numeric\(78,0\) not null default 0$/, converted_native: /^numeric\(78,0\) not null default 0$/,
    updated_at: /^timestamptz not null default now\(\)$/,
  },
  [CREDITS]: {
    chain_id: /^integer not null/, tx_hash: /^text not null/, log_index: /^integer not null/, block_number: /^bigint not null/, block_time: /^timestamptz not null/,
    book: /^text not null/, source_tx_hash: /^text not null/, source_log_index: /^integer not null/, credit_kind: /^text not null/, kind: /^text not null/,
    phase: /^text not null/, side: /^text$/, trader: /^text$/, swap_sender: /^text$/, profile: /^text$/,
    coins: /^numeric\(78,0\) not null default 0$/, fee: /^numeric\(78,0\) not null$/, router_amount: /^numeric\(78,0\) not null$/,
    league_weekly: /^numeric\(78,0\) not null default 0$/, league_monthly: /^numeric\(78,0\) not null default 0$/, recruiter: /^numeric\(78,0\) not null default 0$/,
    squad: /^numeric\(78,0\) not null default 0$/, airdrop: /^numeric\(78,0\) not null default 0$/, protocol: /^numeric\(78,0\) not null default 0$/,
    run_id: /^bigint$/,
  },
};

for (const table of BARK_TABLES) {
  test(`20261015 ${table}: column types and nullability`, () => {
    const { columns } = tableDef(barkSql, table);
    for (const [col, re] of Object.entries(TYPE_PINS[table])) {
      assert.ok(columns.has(col), `${table}.${col} missing`);
      assert.match(columns.get(col), re, `${table}.${col}`);
    }
  });
}

test("Bark credits run_id has the gen-8 run_id type", () => {
  const gen8 = readFileSync(join(MIGRATIONS_DIR, "20261011_000010_evm_gen8_indexer.sql"), "utf8");
  assert.match(tableDef(gen8, "evm_gen8_fee_accruals").columns.get("run_id"), /^bigint$/);
  assert.match(tableDef(gen8, "evm_gen8_route_runs").columns.get("run_id"), /^bigint not null$/);
});

// ------------------------------------------------------------------ side-pool venue

const VENUE_CHK = "evm_gen8_side_pools_venue_chk";

test(`20261015 ${VENUE_CHK}: its latest prior definition plus 'algebra' only`, () => {
  const prior = latestPriorDefinition(VENUE_CHK, BARK_FILE);
  assert.equal(prior.file, "20261011_000010_evm_gen8_indexer.sql", "latest prior definition moved; re-check this migration");
  const actual = checkExpression(barkSql, VENUE_CHK);
  assert.ok(actual, `${VENUE_CHK} is not re-created`);
  assert.equal(actual, replaceOnce(prior.expr, "'infinity_cl')", "'infinity_cl', 'algebra')"));
  const before = quotedValues(prior.expr);
  const after = quotedValues(actual);
  assert.deepEqual(before, ["v2", "v3", "v3_pancake", "solidly", "v4", "infinity_cl"]);
  for (const v of before) assert.ok(after.includes(v), `lost venue ${v}`);
  assert.deepEqual(after.filter((v) => !before.includes(v)), ["algebra"]);
});

test(`20261015 ${VENUE_CHK}: idempotent drop if exists, then add, on public.evm_gen8_side_pools`, () => {
  const drop = barkStatements.indexOf(`alter table public.evm_gen8_side_pools drop constraint if exists ${VENUE_CHK}`);
  const add = barkStatements.findIndex((s) => s.startsWith(`alter table public.evm_gen8_side_pools add constraint ${VENUE_CHK} check`));
  assert.notEqual(drop, -1, "no drop constraint if exists");
  assert.notEqual(add, -1, "no add constraint");
  assert.equal(add, drop + 1, "add must directly follow the drop");
});

test("every side-pool venue the indexer can write is allowed by the new check", () => {
  const src = readFileSync(join(INDEXER_EVM, "evmGen8SidePools.ts"), "utf8");
  const union = src.match(/export type SideVenue = ([^;]+);/);
  assert.ok(union, "SideVenue type not found");
  const venues = quotedValues(union[1].replace(/"/g, "'"));
  assert.ok(venues.includes("algebra"), "the Bark watch writes venue algebra");
  const allowed = quotedValues(checkExpression(barkSql, VENUE_CHK));
  for (const v of venues) assert.ok(allowed.includes(v), `venue ${v} written by the indexer is refused by ${VENUE_CHK}`);
});

// ------------------------------------------------------------------ event kinds

// The only kind CHECK on a table the Bark indexer writes events into: evm_campaign_events.contract_kind. Bark events
// are recorded through recordGen8Event (evmGen8Store.ts), whose kind type is the four gen-8 kinds already allowed since
// 20261011, so 20261015 leaves the constraint alone. Alerts go to reward_alerts (kind in metadata jsonb, no check).
test("evm_campaign_events contract kinds the Bark indexer writes are already allowed (no change in 20261015)", () => {
  const store = readFileSync(join(INDEXER_EVM, "evmGen8Store.ts"), "utf8");
  const sig = store.match(/export async function recordGen8Event\([^)]*?kind: ([^;]+);/s);
  assert.ok(sig, "recordGen8Event kind type not found");
  const storeKinds = [...sig[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(storeKinds, ["gen8_hook", "gen8_launcher", "gen8_splitter", "gen8_choice_vault"]);

  const bark = readFileSync(join(INDEXER_EVM, "evmGen8Bark.ts"), "utf8");
  const barkKinds = new Set();
  for (const line of bark.split("\n").filter((l) => /recordGen8Event\(|const kind = e\.source/.test(l))) {
    for (const m of line.matchAll(/"(gen8_\w+)"/g)) barkKinds.add(m[1]);
  }
  assert.ok(barkKinds.size >= 3, `Bark contract kinds not found (${[...barkKinds]})`);
  for (const k of barkKinds) assert.ok(storeKinds.includes(k), `Bark writes contract kind ${k} outside recordGen8Event's type`);

  const allowed = quotedValues(latestPriorDefinition("evm_campaign_events_kind_check", BARK_FILE).expr);
  for (const k of storeKinds) assert.ok(allowed.includes(k), `contract kind ${k} refused by evm_campaign_events_kind_check`);
  assert.equal(checkExpression(barkSql, "evm_campaign_events_kind_check"), null, "20261015 must not touch evm_campaign_events_kind_check");
});

test("Bark rows use only the gen-8 accrual / reward kinds (no new values)", () => {
  const credits = checkExpression(barkSql, "evm_gen8_bark_credits_kind_chk");
  assert.deepEqual(quotedValues(credits), ["collect", "convert", "graduation", "trade", "graduation"]);
  const gen8 = readFileSync(join(MIGRATIONS_DIR, "20261011_000010_evm_gen8_indexer.sql"), "utf8");
  assert.deepEqual(quotedValues(checkExpression(gen8, "evm_gen8_fee_accruals_kind_chk")), ["trade", "graduation"]);
});

// ------------------------------------------------------------------ the attribution replay's accrual index

test("20261015: index for the attribution replay's buy read on evm_gen8_fee_accruals", () => {
  const src = sqlLiterals("evmGen8BarkAttribution.ts").find((s) => /from public\.evm_gen8_fee_accruals where/i.test(s));
  assert.ok(src, "the attribution replay's accrual read not found");
  const where = src.match(/where (.*?) order by (.*)$/i);
  assert.ok(where, "accrual read has no where / order by");
  // the equality prefix: everything before the (block_number, log_index) position bound
  const [prefix, bound] = where[1].split(/ and \((?=block_number)/i);
  assert.ok(bound, "accrual read lost its position bound");
  const eq = [...prefix.matchAll(/\b([a-z_]+) = (?:\$\d+|'[^']*')/gi)].map((m) => m[1]);
  assert.deepEqual(eq, ["chain_id", "hook_address", "token_address", "kind", "side"]);
  const order = where[2].split(",").map((s) => s.trim());
  assert.deepEqual(order, ["block_number", "log_index"]);

  const idx = barkStatements.find((s) => /^create index if not exists \w+ on public\.evm_gen8_fee_accruals /i.test(s));
  assert.ok(idx, "no create index if not exists on public.evm_gen8_fee_accruals");
  const cols = idx.match(/\(([^)]*)\)$/)[1].split(",").map((s) => s.trim());
  assert.deepEqual(cols, [...eq, ...order], "index = the equality columns, then the order");
});

// ------------------------------------------------------------------ market_stats USD (t18)

test("market_stats columns of the Bark USD update exist in the migration chain (20260903_000101 USD columns)", () => {
  const bark = readFileSync(join(INDEXER_EVM, "evmGen8Bark.ts"), "utf8");
  const stmt = [...bark.matchAll(/`([^`]*)`/g)].map((m) => normalize(m[1])).find((s) => s.startsWith("update public.market_stats set"));
  assert.ok(stmt, "Bark market_stats update not found");
  const set = stmt.match(/^update public\.market_stats set (.*?) where (.*)$/i);
  const used = new Set();
  for (const part of splitTopLevel(set[1])) for (const id of part.replace(/\$\d+/g, "").replace(/'[^']*'/g, "").match(/[a-z_][a-z0-9_]*/gi) || []) if (id !== "now") used.add(id);
  for (const id of set[2].replace(/\$\d+/g, "").match(/[a-z_][a-z0-9_]*/gi) || []) if (id !== "and") used.add(id);

  const have = new Map(); // column -> the migrations that create it
  const addHave = (col, f) => have.set(col, new Set([...(have.get(col) || []), f]));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql") && x < BARK_FILE).sort()) {
    const body = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const create = body.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.market_stats\s*\(/i);
    if (create) {
      const open = create.index + create[0].length - 1;
      for (const item of splitTopLevel(body.slice(open + 1, closingParen(body, open)))) {
        if (!/^(constraint|primary|unique|check|foreign)\b/i.test(item)) addHave(item.split(" ")[0], f);
      }
    }
    for (const s of statementsOf(body).filter((x) => /^alter table (if exists )?public\.market_stats /i.test(x))) {
      for (const m of s.matchAll(/add column (?:if not exists )?(\w+)/gi)) addHave(m[1], f);
    }
  }
  for (const col of used) assert.ok(have.has(col), `market_stats.${col} is not created by any migration`);
  for (const col of ["last_price_usd", "market_cap_usd", "liquidity_usd", "volume_24h_usd", "reference_price_usd", "reference_price_updated_at", "valuation_source", "valuation_healthy", "valuation_error"]) {
    assert.ok(used.has(col), `the Bark update no longer writes ${col}; re-check this test`);
    assert.ok(have.get(col).has("20260903_000101_robinhood_shared_market_valuation.sql"), `market_stats.${col} not added by 20260903_000101`);
  }
  // valuation_source 'dogeos_doge_usd_oracle' passes: no migration puts a check on it
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
    assert.doesNotMatch(stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")), /check\s*\([^;]*valuation_source/i, f);
  }
});

// ------------------------------------------------------------------ idempotency and scope

test("20261015 is idempotent: if not exists / drop if exists before every add, no data or destructive statement", () => {
  const body = barkStatements.filter((s) => !/^(begin|commit)$/i.test(s));
  for (const s of body) {
    if (/^create table/i.test(s)) assert.match(s, /^create table if not exists /i, s.slice(0, 80));
    if (/^create (unique )?index/i.test(s)) assert.match(s, /^create (unique )?index if not exists /i, s.slice(0, 80));
    if (/ add column /i.test(s)) assert.match(s, / add column if not exists /i, s.slice(0, 80));
    const add = s.match(/^alter table ([\w.]+) add constraint (\w+)/i);
    if (add) {
      const at = body.indexOf(s);
      assert.ok(body.slice(0, at).includes(`alter table ${add[1]} drop constraint if exists ${add[2]}`), `${add[2]} added without a prior drop if exists`);
    }
  }
  assert.doesNotMatch(barkBody, /\b(insert\s+into|update\s+public|delete\s+from|truncate|drop\s+table|drop\s+column|drop\s+index)\b/i);
  assert.doesNotMatch(barkBody, /\bdrop\s+constraint\s+(?!if\s+exists)/i);
});

test("20261015 touches only the Bark tables, the side-pool venue check and the accrual index; no market_trades_v label", () => {
  const altered = new Set(barkStatements.map((s) => s.match(/^alter table ([\w.]+)/i)?.[1]).filter(Boolean));
  assert.deepEqual([...altered].sort(), ["public.evm_gen8_bark_credits", "public.evm_gen8_bark_sell_fees", "public.evm_gen8_side_pools"]);
  const dropped = barkStatements.map((s) => s.match(/drop constraint if exists (\w+)/i)?.[1]).filter(Boolean);
  assert.deepEqual(dropped, [VENUE_CHK]);
  const created = new Set(barkStatements.map((s) => s.match(/^create table if not exists ([\w.]+)/i)?.[1]).filter(Boolean));
  assert.deepEqual([...created].sort(), BARK_TABLES.map((t) => `public.${t}`).sort());
  const indexed = new Set(barkStatements.map((s) => s.match(/^create (?:unique )?index if not exists \w+ on ([\w.]+)/i)?.[1]).filter(Boolean));
  assert.deepEqual([...indexed].sort(), ["public.evm_gen8_bark_credits", "public.evm_gen8_bark_sell_fees", "public.evm_gen8_fee_accruals"]);
  assert.doesNotMatch(barkBody, /market_trades_v/i);
  assert.doesNotMatch(barkBody, /\b(create|replace)\s+(or\s+replace\s+)?view\b/i);
});

// ------------------------------------------------------------------ the apply script

test("apply script: staging-only (refuses production), dryrun|apply, one transaction, 20261010 then 20261015", () => {
  const sh = readFileSync(APPLY_SCRIPT, "utf8");
  assert.match(sh, /STAGING_DATABASE_URL/);
  assert.match(sh, /\*"\$STAGING_REF"\*\) ;;/);
  assert.match(sh, /STAGING_REF="vrnsbguutnwgtekcexls"/);
  assert.match(sh, /PROD_REF="ellkfgoxnzykxqybajtn"/);
  assert.match(sh, /case "\$DB" in \*"\$PROD_REF"\*\) echo "refusing: [^"]*production[^"]*" >&2; exit 1;; esac/);
  assert.match(sh, /case "\$MODE" in dryrun\|apply\) ;;/);
  assert.match(sh, /ON_ERROR_STOP on/);
  assert.match(sh, /lock_timeout = '5s'/);
  const files = [...sh.matchAll(/^\s*(db\/migrations\/\S+\.sql)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(files, [`db/migrations/${LAUNCH_FILE}`, `db/migrations/${BARK_FILE}`, `db/migrations/${TARGET_FILE}`]);
  // begin/commit of the files are stripped so the bundle is exactly one transaction.
  assert.ok(sh.includes(`sed -E '/^[[:space:]]*([Bb][Ee][Gg][Ii][Nn]|[Cc][Oo][Mm][Mm][Ii][Tt])[[:space:]]*;[[:space:]]*$/d'`), "begin/commit strip (portable sed) missing");
  assert.match(sh, /echo "begin;"/);
  assert.match(sh, /if \[ "\$MODE" = apply \]; then echo "commit;"; else echo "rollback;"; fi/);
});

test("the launch-path-only apply script is gone (superseded: 20261010 is applied with 20261015)", () => {
  assert.equal(existsSync(OLD_APPLY_SCRIPT), false);
});

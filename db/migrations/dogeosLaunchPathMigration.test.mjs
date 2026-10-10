// t22: the DogeOS (6281971) launch-path staging migration. Every constraint it re-creates must equal
// its latest prior definition with 6281971 added in exactly the expected place and nothing else.
//
//   node --test db/migrations/dogeosLaunchPathMigration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MIGRATIONS_DIR, "..", "..");
const MIGRATION_FILE = "20261010_000020_dogeos_chain_launch_path.sql";
const APPLY_SCRIPT = join(REPO_ROOT, "database", "staging_apply_dogeos_launch_path.sh");
const DOGEOS = 6281971;

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

function normalize(expr) {
  return expr.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

// Text of the check expression (outer parentheses included) for `constraint <name> check (...)`.
function checkExpression(sql, name) {
  const body = stripComments(sql);
  const re = new RegExp(`constraint\\s+${name}\\s+check\\s*\\(`, "gi");
  const matches = [...body.matchAll(re)];
  if (matches.length === 0) return null;
  assert.equal(matches.length, 1, `${name} is defined more than once in one file`);
  const open = matches[0].index + matches[0][0].length - 1;
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "(") depth += 1;
    else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) return normalize(body.slice(open, i + 1));
    }
  }
  throw new Error(`unbalanced parentheses in ${name}`);
}

// Latest migration (by filename order) before ours that defines the constraint.
function latestPriorDefinition(name) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < MIGRATION_FILE)
    .sort();
  let found = null;
  for (const f of files) {
    const expr = checkExpression(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), name);
    if (expr) found = { file: f, expr };
  }
  assert.ok(found, `no prior definition of ${name}`);
  return found;
}

function chainIdLists(expr) {
  return [...expr.matchAll(/chain_id in \(([^)]*)\)/g)].map((m) => m[1].split(",").map((s) => Number(s.trim())));
}

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `expected fragment not found: ${from}`);
  assert.equal(text.indexOf(from, at + 1), -1, `fragment occurs more than once: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const migrationSql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
const migrationBody = stripComments(migrationSql);

// Each re-created constraint: its table and the single textual change from the prior definition.
const EXPECTED = {
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

for (const [name, spec] of Object.entries(EXPECTED)) {
  test(`${name}: equals its latest prior definition plus 6281971 only`, () => {
    const prior = latestPriorDefinition(name);
    assert.equal(prior.file, spec.priorFile, "latest prior definition moved; re-check this migration");
    const actual = checkExpression(migrationSql, name);
    assert.ok(actual, `${name} is not re-created`);
    assert.equal(actual, replaceOnce(prior.expr, spec.from, spec.to));
  });

  test(`${name}: every pre-existing chain id kept, 6281971 added`, () => {
    const prior = chainIdLists(latestPriorDefinition(name).expr);
    const actual = chainIdLists(checkExpression(migrationSql, name));
    assert.equal(actual.length, prior.length);
    prior.forEach((ids, i) => {
      for (const id of ids) assert.ok(actual[i].includes(id), `${name} list ${i} lost chain ${id}`);
      const added = actual[i].filter((id) => !ids.includes(id));
      assert.ok(added.every((id) => id === DOGEOS), `${name} list ${i} added ${added}`);
    });
    assert.ok(actual.some((ids) => ids.includes(DOGEOS)), `${name} does not include 6281971`);
  });

  test(`${name}: idempotent drop if exists, then add, on ${spec.table}`, () => {
    const t = spec.table.replace(".", "\\.");
    const drop = new RegExp(`alter table ${t} drop constraint if exists ${name};`, "i");
    const add = new RegExp(`alter table ${t} add constraint ${name} check`, "i");
    const flat = normalize(migrationBody);
    assert.match(flat, drop);
    assert.match(flat, add);
    assert.ok(flat.search(drop) < flat.search(add), "drop must precede add");
  });
}

test("$6 graduation clause is untouched (no 6281971)", () => {
  const expr = checkExpression(migrationSql, "campaign_drafts_graduation_target_check");
  assert.ok(expr.includes("graduation_target_wei <> 6000000000000000000::numeric or chain_id in (97, 101, 102))"));
});

test("own transaction: begin; first, commit; last", () => {
  const statements = migrationBody
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements[0].toLowerCase(), "begin");
  assert.equal(statements.at(-1).toLowerCase(), "commit");
  assert.equal(statements.filter((s) => /^(begin|commit)$/i.test(s)).length, 2);
});

test("touches no other constraint, table or data", () => {
  const names = new Set([...migrationBody.matchAll(/constraint\s+(?:if\s+exists\s+)?(\w+)/gi)].map((m) => m[1]));
  assert.deepEqual([...names].sort(), Object.keys(EXPECTED).sort());
  const tables = new Set([...migrationBody.matchAll(/alter\s+table\s+([\w.]+)/gi)].map((m) => m[1]));
  assert.deepEqual([...tables].sort(), Object.values(EXPECTED).map((s) => s.table).sort());
  const statements = migrationBody
    .split(";")
    .map((s) => normalize(s))
    .filter((s) => s && !/^(begin|commit)$/i.test(s));
  assert.equal(statements.length, 4, "exactly a drop + add per constraint");
  for (const s of statements) assert.match(s, /^alter table [\w.]+ (drop constraint if exists|add constraint) \w+/i);
  assert.doesNotMatch(migrationBody, /\b(insert|update|delete|truncate|drop\s+table|drop\s+column|create)\b/i);
});

test("apply script: staging-only, dryrun|apply, one transaction, lock_timeout 5s, ON_ERROR_STOP", () => {
  const sh = readFileSync(APPLY_SCRIPT, "utf8");
  assert.match(sh, /\*vrnsbguutnwgtekcexls\*\) ;;/);
  assert.match(sh, /refusing: not the staging project/);
  assert.match(sh, /case "\$MODE" in dryrun\|apply\) ;;/);
  assert.match(sh, /ON_ERROR_STOP on/);
  assert.match(sh, /lock_timeout = '5s'/);
  assert.ok(sh.includes(`db/migrations/${MIGRATION_FILE}`), "script does not apply the migration");
  // begin/commit of the file are stripped so the bundle is exactly one transaction.
  assert.match(sh, /sed -E '\/\^\[\[:space:\]\]\*\(begin\|commit\)/);
  assert.match(sh, /echo "begin;"/);
  assert.match(sh, /if \[ "\$MODE" = apply \]; then echo "commit;"; else echo "rollback;"; fi/);
});

// A posted league root freezes the epoch's winner set (2026-09-28 incident).
// Real data: Solana weekly epoch 2026-09-14. Its root went on chain with 3 winners; on 2026-09-27 the
// settlement job added a recruiter_league winner to the already-sealed epoch, so every proof built
// from the rows failed on chain with InvalidProof (6009).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMerkleProof, buildMerkleRoot, leagueLeaf } from "./solanaLeagueMerkle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const EPOCH_START = Math.floor(Date.parse("2026-09-14T00:00:00Z") / 1000);
const POSTED_ROOT = "0x47f2f66b50588133ac76eebc6890e4d4a8bc1af49be4b3221393f3c66d4c322c";
const POSTED_TOTAL = 493_926n;
const SEALED_ROWS = [
  { category: "biggest_hit", rank: 1, recipient: "DcstAP7sxb7QY6MK35ERAUV4gyGc7Ex4dEXbL7Vm481x", amount: 202_571n },
  { category: "crowd_favorite", rank: 1, recipient: "8doLGRWZsKTGcAYg84PGo8agW4WaDdqQynByMnbtwG4R", amount: 202_569n },
  { category: "top_earner", rank: 1, recipient: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", amount: 88_786n },
];
const LATE_ROW = { category: "recruiter_league", rank: 1, recipient: "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9", amount: 10_074_896n };

const leaves = (rows) => [...rows]
  .sort((a, b) => a.category.localeCompare(b.category) || a.rank - b.rank || a.recipient.localeCompare(b.recipient))
  .map((r) => leagueLeaf({ epochStartSec: EPOCH_START, period: "weekly", category: r.category, rank: r.rank, recipient: r.recipient, amountRaw: r.amount }));

test("the rows the root was posted with rebuild the on-chain root", () => {
  assert.equal(buildMerkleRoot(leaves(SEALED_ROWS)), POSTED_ROOT);
  assert.equal(SEALED_ROWS.reduce((a, r) => a + r.amount, 0n), POSTED_TOTAL);
});

test("one row added after posting changes the root, so every proof fails on chain", () => {
  assert.notEqual(buildMerkleRoot(leaves([...SEALED_ROWS, LATE_ROW])), POSTED_ROOT);
  const all = leaves([...SEALED_ROWS, LATE_ROW]);
  const proof = buildMerkleProof(all, all.length - 1);
  assert.ok(proof.length > 0);
});

test("settlement never adds winners to an epoch with a posted root", () => {
  const src = fs.readFileSync(path.join(repo, "realtime-indexer/src/jobs/finalizeEpochWinners.ts"), "utf8");
  const body = src.slice(src.indexOf("async function finalizeEpochFor("));
  const freeze = body.indexOf("postedRootExists(chainId, period, epochStartIso)");
  const firstWrite = body.indexOf("for (let i = 0; i < categories.length; i++)");
  assert.ok(freeze > 0 && freeze < firstWrite, "the frozen-epoch check must run before any category is settled");
  assert.match(src, /from public\.league_epoch_roots/);
});

test("the claim API refuses a proof that does not rebuild the posted root", () => {
  const src = fs.readFileSync(path.join(here, "league.js"), "utf8");
  assert.match(src, /SELECT root FROM league_epoch_roots WHERE chain_id = \$1 AND period = \$2 AND epoch_start = \$3::timestamptz/);
  assert.match(src, /code: "LEAGUE_ROOT_MISMATCH"/);
});

test("EVM roots are recorded so the same freeze covers BNB and Robinhood", () => {
  const src = fs.readFileSync(path.join(repo, "frontend/scripts/publish-evm-league-roots.mjs"), "utf8");
  assert.match(src, /insert into public\.league_epoch_roots/);
  for (const status of ["already_published", "published", "already_sealed", "sealed"]) {
    assert.match(src, new RegExp(`recordPostedRoot\\(item, [^,]+, "${status}"\\)`));
  }
});

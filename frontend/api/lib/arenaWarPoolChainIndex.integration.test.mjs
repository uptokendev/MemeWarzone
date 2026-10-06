// Runs the real migrations and the indexer's SQL against a throwaway Postgres.
// Skipped unless ARENA_INDEX_TEST_DATABASE_URL points at a disposable database (it drops and
// recreates the arena war pool tables there). Never point it at staging or production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ABSORB_SHADOWED_RECEIPTS_SQL,
  decodeSolanaArenaTransaction,
  movementRow,
  readCursor,
  receiptDepositSql,
  subjectMap,
  writeChainRow,
  writeCursor,
} from "./arenaWarPoolChainIndex.js";
import { ARENA_CHAIN_ROWS_SQL, ARENA_RECORDED_SQL_V2, chainDepositsComplete, groupChainRows } from "./financePayoutsArena.js";

const URL_ = String(process.env.ARENA_INDEX_TEST_DATABASE_URL || "").trim();
const TXS = JSON.parse(readFileSync(new URL("./arenaWarPoolChainIndex.fixtures.json", import.meta.url), "utf8"));
const OPEN = "495VDDq3qqns3EWDeSUQPmen1fy1mC8ipUeb1fGNMuwYLG3NHi9v726mYvmepRXWsQghT2sNgNryNtE1qEvxRRAM";
const STAKE_B = "3khothUkon3qshHTjHGv8LfyKoZ3p7hedJ4LVGQ3oFtqLRVTSveiG7Q5PrdC2KUn2HfyHFAvgt1ai84U28pWQF7";
const BOOST = "wq3g1nJhrQwABy8j4qLJuVbvK3WL4vmV2SqrsMqq1PDBTLo1E1K7EdJSMwSMy1spsTyY9BPmsGbm5ySuPCQDwD9";
const CLAIM_WINNER = "5tSmpCDrgJLQgaPPeRHBSTZAbeeVYY4yyZV3ZbiWLNhZqgXo2AoRfdoSXvZgCpqWDg99jnZkqtDDAbKQQPJiKnS9";
const POOL = "0xc6e87fbb715159082bef6c682e926810ac47e6d893c8cc5cd4cb0c92edb6b8b7";
const SUBJECTS = subjectMap([{ kind: "battle", id: "arena-mugwhj11-9b1973" }]);

function rowsOf(signature) {
  const d = decodeSolanaArenaTransaction(TXS[signature]);
  return d.movements.map((m) => movementRow(m, { chainId: 101, txHash: d.signature, slot: d.slot, blockTime: d.blockTime, subjects: SUBJECTS }));
}

const migration = (name) => readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");

test("chain index SQL on a real Postgres: idempotent, receipt and chain rows never double count", { skip: !URL_ && "set ARENA_INDEX_TEST_DATABASE_URL to a throwaway database" }, async () => {
  const { default: pg } = await import("pg");
  const db = new pg.Pool({ connectionString: URL_, max: 2 });
  try {
    await db.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$`);
    await db.query("drop table if exists public.arena_war_pool_deposits, public.arena_war_pool_claims, public.arena_war_pool_index_cursors");
    await db.query(migration("20260827_000002_arena_war_pool_escrow.sql"));
    // Only the columns the finance recorded query reads.
    await db.query(`create table if not exists public.arena_contest_actions (
      id bigserial primary key, chain_id integer, battle_id text, action_type text, gross_native_raw bigint,
      tx_hash text, signature_reference text, confirmed_at timestamptz)`);

    // Production today: owner A's browser receipt for the open transaction, nothing for owner B.
    await db.query(
      `insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id) values ($1,'stake',$2,50000000,$3,101)`,
      [POOL, "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv", OPEN],
    );
    // The new receipt insert works on the old schema too (deploy order: API first).
    await db.query(receiptDepositSql("stake"), [POOL, "x", "1", OPEN, 101]);
    assert.equal((await db.query("select count(*)::int as n from public.arena_war_pool_deposits")).rows[0].n, 1);

    // Migration, twice (idempotent).
    await db.query(migration("20261006_000010_arena_war_pool_chain_index.sql"));
    await db.query(migration("20261006_000010_arena_war_pool_chain_index.sql"));
    assert.equal((await db.query("select source from public.arena_war_pool_deposits")).rows[0].source, "receipt");

    // Chain rows: the open replaces the receipt, owner B's stake is new, the boost and claim are new.
    const [openRow] = rowsOf(OPEN);
    assert.equal(await writeChainRow(db, openRow), "replaced-receipt");
    assert.equal(await writeChainRow(db, rowsOf(STAKE_B)[0]), "inserted");
    assert.equal(await writeChainRow(db, rowsOf(BOOST)[0]), "inserted");
    assert.equal(await writeChainRow(db, rowsOf(CLAIM_WINNER)[0]), "inserted");
    // Second pass changes nothing.
    for (const sig of [OPEN, STAKE_B, BOOST, CLAIM_WINNER]) assert.equal(await writeChainRow(db, rowsOf(sig)[0]), "updated");

    const deposits = (await db.query("select purpose, wallet, amount_wei::text as amount, source, ix_index, subject_id, block_time from public.arena_war_pool_deposits order by block_time")).rows;
    assert.deepEqual(deposits.map((r) => [r.purpose, r.amount, r.source, r.ix_index, r.subject_id]), [
      ["stake", "50000000", "chain", 4, "arena-mugwhj11-9b1973"],
      ["stake", "50000000", "chain", 0, "arena-mugwhj11-9b1973"],
      ["boost", "8200755", "chain", 5, "arena-mugwhj11-9b1973"],
    ]);
    const claims = (await db.query("select bucket, place, amount_wei::text as amount, wallet, tx_hash from public.arena_war_pool_claims")).rows;
    assert.deepEqual(claims, [{ bucket: "winner", place: 1, amount: "112024541", wallet: "BVTKvynQ8VBJKKA2uau4FC4mNoTmkmb1t4h1y8gMv3Gk", tx_hash: CLAIM_WINNER }]);

    // A late browser receipt for owner B's (already indexed) deposit is skipped.
    await db.query(receiptDepositSql("stake"), [POOL, "BVTKvynQ8VBJKKA2uau4FC4mNoTmkmb1t4h1y8gMv3Gk", "50000000", STAKE_B, 101]);
    assert.equal((await db.query("select count(*)::int as n from public.arena_war_pool_deposits")).rows[0].n, 3);

    // A receipt that raced the indexer (written between its check and the chain insert) is absorbed.
    await db.query(`insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id) values ($1,'stake','x',50000000,$2,101)`, [POOL, STAKE_B]);
    const absorbed = await db.query(ABSORB_SHADOWED_RECEIPTS_SQL, [101]);
    assert.equal(absorbed.rows.length, 1);

    // EVM: two Claimed logs in one transaction (operator + protocol) are two rows.
    const evm = { table: "claims", chainId: 56, poolId: POOL, bucket: "operator", place: null, refundOf: null, wallet: "0x11", amount: "5", txHash: "0xabc", ixIndex: 3, slot: 10, blockTime: "2026-10-01T00:00:00Z", subjectKind: null, subjectId: null };
    assert.equal(await writeChainRow(db, evm), "inserted");
    assert.equal(await writeChainRow(db, { ...evm, bucket: "protocol", amount: "7", ixIndex: 4 }), "inserted");
    // An EVM receipt row with a differently cased hash is replaced by the chain row.
    await db.query(receiptDepositSql("stake"), [POOL, "0x22", "9", "0xDEF", 56]);
    assert.equal(await writeChainRow(db, { ...evm, table: "deposits", purpose: "stake", bucket: null, wallet: "0x22", amount: "9", txHash: "0xdef", ixIndex: 1 }), "replaced-receipt");

    // Finance: the recorded figures count each deposit once, boosts from chain rows.
    const recorded = (await db.query(ARENA_RECORDED_SQL_V2, [101])).rows.filter((r) => r.source === "deposit");
    assert.deepEqual(recorded.map((r) => [r.purpose, r.n, r.raw]).sort(), [["boost", 1, "8200755"], ["stake", 2, "100000000"]]);
    const chain = groupChainRows((await db.query(ARENA_CHAIN_ROWS_SQL, [101])).rows).get(POOL);
    assert.equal(chain.deposits.length, 3);
    assert.equal(chainDepositsComplete({ paidIn: 108200755n }, chain), true);
    assert.equal(chainDepositsComplete({ paidIn: 141138378n }, chain), false);

    // Cursors.
    assert.equal(await readCursor(db, 101, `pool:${POOL}`), null);
    await writeCursor(db, 101, `pool:${POOL}`, CLAIM_WINNER);
    await writeCursor(db, 101, `pool:${POOL}`, CLAIM_WINNER);
    assert.equal(await readCursor(db, 101, `pool:${POOL}`), CLAIM_WINNER);

    // RLS unchanged on the two tables; cursors are not readable by anon.
    const rls = (await db.query(`select relname, relrowsecurity from pg_class where relname in ('arena_war_pool_deposits','arena_war_pool_claims','arena_war_pool_index_cursors') order by relname`)).rows;
    assert.ok(rls.every((r) => r.relrowsecurity));
    const anonCursor = (await db.query(`select has_table_privilege('anon', 'public.arena_war_pool_index_cursors', 'select') as can`)).rows[0].can;
    assert.equal(anonCursor, false);
    const anonDeposits = (await db.query(`select has_table_privilege('anon', 'public.arena_war_pool_deposits', 'select') as can, has_table_privilege('anon', 'public.arena_war_pool_deposits', 'insert') as ins`)).rows[0];
    assert.deepEqual(anonDeposits, { can: true, ins: false });
  } finally {
    await db.end();
  }
});

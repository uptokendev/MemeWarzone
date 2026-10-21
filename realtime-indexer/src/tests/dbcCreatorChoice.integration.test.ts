import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";

process.env.ABLY_API_KEY ||= "test:key";
process.env.PG_DISABLE_SSL = "1";
process.env.SOLANA_MIN_PAYOUT_LAMPORTS = "5000000";

const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
test.after(async () => {
  await pg.stop();
});

const { runWeeklyPayouts, resolvePendingPayouts, coinLedgers, dues } = await import("../dbc/dbcCreatorPayouts.js");
const { heldCreatorPoolSum } = await import("../dbc/dbcFeeRouter.js");

const collector = Keypair.generate();

/** A chain that accepts every send; getTransaction answers from `landed`. */
function stubChain(opts: { failSends?: boolean } = {}) {
  const sent: string[] = [];
  const outcome = new Map<string, "ok" | "err">();
  let n = 0;
  return {
    sent,
    outcome,
    async getBalance() { return 1_000_000_000_000; },
    async getMinimumBalanceForRentExemption() { return 890_880; },
    async getLatestBlockhash() {
      n += 1;
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 + n };
    },
    async sendRawTransaction(raw: Buffer) {
      sent.push(Buffer.from(raw).toString("base64"));
      return "ignored";
    },
    async confirmTransaction(args: { signature: string }) {
      outcome.set(args.signature, opts.failSends ? "err" : "ok");
      return { value: { err: opts.failSends ? { InstructionError: [0, "x"] } : null } };
    },
    async getTransaction(sig: string) {
      const o = outcome.get(sig);
      return o ? { meta: { err: o === "err" ? { x: 1 } : null } } : null;
    },
    async getSignatureStatuses() { return { value: [null] }; },
    async getBlockHeight() { return 5_000; },
  };
}

async function seedCoin(pool: string, mint: string, creator: string, choice: string, pct: number | null, creatorPool: bigint) {
  await pg.pool.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, launch_type, meta)
     values (101,$1,$2,$3,'dbc',$4::jsonb)`,
    [pool, mint, creator, JSON.stringify({ dbc: { feeChoice: choice, creatorSharePct: pct } })],
  );
  await pg.pool.query(
    `insert into public.dbc_fee_accruals (pool, tx_hash, log_index, trader, profile, fee_total, trading_fee,
       protocol_fee, referral_fee, collector_amount, league_weekly, league_monthly, recruiter, squad, airdrop,
       protocol, creator_pool, status)
     values ($1,$2,0,'t','standard_unlinked',0,0,0,0,$3,0,0,0,0,0,0,$3,'routed')`,
    [pool, `tx-${pool}`, creatorPool.toString()],
  );
}

const WEEK = "2026-09-28";
const MONDAY_AFTER = new Date("2026-10-05T01:00:00Z");

test("split and holders: exact payouts, held sum drops by what was paid, a rerun pays nothing twice", async () => {
  const w1 = Keypair.generate().publicKey.toBase58();
  const w2 = Keypair.generate().publicKey.toBase58();
  const tiny = Keypair.generate().publicKey.toBase58();
  const splitCreator = Keypair.generate().publicKey.toBase58();
  await seedCoin("PoolSplit", "MintSplit", splitCreator, "split", 60, 100_000_000n);
  await seedCoin("PoolHold", "MintHold", Keypair.generate().publicKey.toBase58(), "holders", null, 50_000_000n);
  for (const [mint, owner, amount] of [
    ["MintSplit", w1, 3n], ["MintSplit", w2, 1n],
    ["MintHold", w1, 1n], ["MintHold", w2, 1n], ["MintHold", tiny, 0n],
  ] as const) {
    await pg.pool.query(`insert into public.dbc_holder_snapshots (week_id, mint, owner, amount) values ($1,$2,$3,$4)`, [WEEK, mint, owner, amount.toString()]);
  }
  const heldBefore = await heldCreatorPoolSum(pg.pool);
  const chain = stubChain();
  const result = await runWeeklyPayouts({ db: pg.pool, connection: chain as any, collector, send: true, now: MONDAY_AFTER });
  assert.equal(result.weekId, WEEK);
  assert.equal(result.holderRound, "landed");

  const creatorRow = (await pg.pool.query(`select lamports, status, recipient from public.dbc_creator_pool_payouts where kind='creator'`)).rows[0];
  assert.equal(String(creatorRow.lamports), "60000000"); // 60% of 100,000,000
  assert.equal(creatorRow.recipient, splitCreator);
  assert.equal(creatorRow.status, "landed");

  // holders: split coin 40,000,000 over w1:w2 = 3:1; holders coin 50,000,000 over 1:1
  const round = (await pg.pool.query(`select total_lamports, leaves, status from public.dbc_holder_rounds where week_id=$1`, [WEEK])).rows[0];
  const leaves = Object.fromEntries(round.leaves.leaves.map((l: any) => [l.owner, l.amount]));
  assert.equal(leaves[w1], String(30_000_000n + 25_000_000n));
  assert.equal(leaves[w2], String(10_000_000n + 25_000_000n));
  assert.equal(String(round.total_lamports), "90000000");
  assert.equal(round.status, "landed");

  const heldAfter = await heldCreatorPoolSum(pg.pool);
  assert.equal(heldBefore - heldAfter, 150_000_000n); // 60M creator + 90M holders

  const ledgers = await coinLedgers(pg.pool);
  assert.deepEqual(dues({ choice: "split", creatorSharePct: 60 }, ledgers.get("PoolSplit")!), { creator: 0n, holders: 0n, buyback: 0n });

  const sends = chain.sent.length;
  await runWeeklyPayouts({ db: pg.pool, connection: chain as any, collector, send: true, now: MONDAY_AFTER });
  assert.equal(chain.sent.length, sends, "a rerun of the same week sends nothing");
});

test("a payout that failed on chain is retried; a failed one never counts as paid", async () => {
  await pg.pool.query(`delete from public.dbc_creator_pool_payouts`);
  await pg.pool.query(`delete from public.dbc_holder_rounds`);
  const failing = stubChain({ failSends: true });
  const first = await runWeeklyPayouts({ db: pg.pool, connection: failing as any, collector, send: true, now: MONDAY_AFTER });
  assert.equal(first.holderRound, "failed");
  const paidWhileFailed = await pg.pool.query(`select count(*)::int n from public.dbc_creator_pool_payouts where status in ('sending','landed')`);
  assert.equal(paidWhileFailed.rows[0].n, 0);
  const ok = stubChain();
  const second = await runWeeklyPayouts({ db: pg.pool, connection: ok as any, collector, send: true, now: MONDAY_AFTER });
  assert.equal(second.holderRound, "landed");
  const creator = await pg.pool.query(`select status from public.dbc_creator_pool_payouts where kind='creator' order by id`);
  assert.deepEqual(creator.rows.map((r: any) => r.status), ["failed", "landed"]);
  await resolvePendingPayouts(pg.pool, ok as any);
});

test("hold-through week: four checks, lowest balance, 0.01% minimum; a coin created mid-week skips earlier checks", async () => {
  const { takeDueSnapshots } = await import("../dbc/dbcCreatorPayouts.js");
  const { holdThroughMoments, weekSecret } = await import("../dbc/dbcCreatorChoice.js");
  const MASTER = "hold-through-master";
  const WEEK2 = "2026-10-26";
  const moments = holdThroughMoments(weekSecret(MASTER, WEEK2), new Date(`${WEEK2}T00:00:00Z`));
  const SUPPLY = 1_000_000_000n * 1_000_000n;
  const MIN = SUPPLY / 10_000n;

  // the coins above use placeholder mints that are not public keys; this week only has real ones
  await pg.pool.query(`delete from public.campaigns where campaign_address in ('PoolSplit', 'PoolHold')`);
  const key = () => Keypair.generate().publicKey.toBase58();
  const [steady, dipper, flipper, small, lateBuyer, lateHolder] = [key(), key(), key(), key(), key(), key()];
  const mintHT = key();
  const mintLate = key();
  await seedCoin("PoolHT", mintHT, key(), "holders", null, 30_000_000n);
  await seedCoin("PoolLate", mintLate, key(), "holders", null, 10_000_000n);
  // created between check 1 and check 2
  await pg.pool.query(`update public.campaigns set created_at_chain = $2 where campaign_address = $1`, [
    "PoolLate", new Date((moments[1].getTime() + moments[2].getTime()) / 2),
  ]);

  // balances per check, by mint
  const held: Record<string, Array<Array<[string, bigint]>>> = {
    [mintHT]: [
      [[steady, 10n * MIN], [dipper, 20n * MIN], [small, MIN - 1n]],
      [[steady, 10n * MIN], [dipper, 20n * MIN], [small, MIN - 1n], [lateBuyer, 40n * MIN]],
      [[steady, 10n * MIN], [dipper, 5n * MIN], [small, MIN - 1n], [lateBuyer, 40n * MIN], [flipper, 90n * MIN]],
      [[steady, 10n * MIN], [dipper, 20n * MIN], [small, MIN - 1n], [lateBuyer, 40n * MIN]],
    ],
    [mintLate]: [[], [], [[lateHolder, 3n * MIN]], [[lateHolder, 3n * MIN]]],
  };
  function tokenAccount(mint: string, owner: string, amount: bigint) {
    const data = Buffer.alloc(165);
    new PublicKey(mint).toBuffer().copy(data, 0);
    new PublicKey(owner).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    return data;
  }
  const chainAt = (i: number) => ({
    async getSlot() { return 1_000 + i; },
    async getTokenSupply() { return { value: { amount: SUPPLY.toString() } }; },
    async getProgramAccounts(_program: unknown, opts: any) {
      const mint = String(opts.filters[1].memcmp.bytes);
      return (held[mint]?.[i] || []).map(([owner, amount]) => ({ account: { data: tokenAccount(mint, owner, amount) } }));
    },
  });

  for (let i = 0; i < 4; i += 1) {
    const take = (at: number) =>
      takeDueSnapshots({ db: pg.pool, connection: chainAt(i) as any, masterSecret: MASTER, excluded: new Set(), now: new Date(at) });
    assert.equal(await take(moments[i].getTime() - 1_000), 0, `nothing new is due just before check ${i}`);
    assert.ok((await take(moments[i].getTime() + 1_000)) > 0, `check ${i} is taken at its moment`);
    assert.equal(await take(moments[i].getTime() + 2_000), 0, `check ${i} is taken once`);
  }
  const lateRuns = await pg.pool.query(
    `select check_index from public.dbc_holder_check_runs where week_id = $1 and mint = $2 order by check_index`, [WEEK2, mintLate],
  );
  assert.deepEqual(lateRuns.rows.map((r: any) => Number(r.check_index)), [2, 3]);
  const oldTable = await pg.pool.query(`select 1 from public.dbc_holder_snapshots where week_id = $1`, [WEEK2]);
  assert.equal(oldTable.rows.length, 0, "nothing is settled while the week runs");

  const result = await runWeeklyPayouts({ db: pg.pool, connection: stubChain() as any, collector, send: true, now: new Date("2026-11-02T01:00:00Z") });
  assert.equal(result.weekId, WEEK2);
  assert.equal(result.holderRound, "landed");
  const round = (await pg.pool.query(`select total_lamports, leaves from public.dbc_holder_rounds where week_id = $1`, [WEEK2])).rows[0];
  const leaves = Object.fromEntries(round.leaves.leaves.map((l: any) => [l.owner, l.amount]));
  // PoolHT 30M over steady 10 : dipper 5 (its lowest); flipper, small and lateBuyer are out. PoolLate 10M to lateHolder.
  assert.deepEqual(leaves, { [steady]: "20000000", [dipper]: "10000000", [lateHolder]: "10000000" });
  assert.equal(String(round.total_lamports), "40000000");
});

// Two airdrop pots per EVM chain (founder, 2026-10-08). No database, no chain: fake client + injected deps.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { weeklyContractBatchId, materializeAirdropBatch } from "./materialize.mjs";
import { findEpochBatch, otherPotWallets, stageWinners } from "./candidates.mjs";
import {
  GEN7_POT, MAIN_POT, airdropPots, drawLabel, gen7PotConfig, potMetadata, potOperatorKey, winnerSourceId,
} from "./pots.mjs";
import { runAllPots } from "./potRun.mjs";

const CHAIN = 56;
const EPOCH = "2026-10-05";
const MAIN_VAULT = "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e";
const MAIN_DIST = "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75";
const GEN7_VAULT = "0x1000000000000000000000000000000000000007";
const GEN7_DIST = "0x2000000000000000000000000000000000000007";

// ---------------------------------------------------------------------------- batch ids

test("main-pot batch ids are the ids the Safe already pre-authorized (P1 batches on BNB and Robinhood)", () => {
  const coder = AbiCoder.defaultAbiCoder();
  let checked = 0;
  for (const file of ["../../../deployments/bnb/mainnet.P1-payouts.safe-batch.json", "../../../deployments/robinhood/mainnet.P1-payouts.safe-batch.json"]) {
    const batch = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
    const chainId = Number(batch.chainId);
    for (const tx of batch.transactions.filter((item) => item.contractMethod?.name === "authorizeBatch")) {
      const [batchId, , publishAfter] = coder.decode(["bytes32", "uint256", "uint64", "uint64"], `0x${tx.data.slice(10)}`);
      const epochId = new Date((Number(publishAfter) - 7 * 86_400) * 1000).toISOString().slice(0, 10);
      const mainIds = ["airdrop_trader", "airdrop_creator"].map((program) => weeklyContractBatchId(chainId, epochId, program));
      const explicitMain = ["airdrop_trader", "airdrop_creator"].map((program) => weeklyContractBatchId(chainId, epochId, program, MAIN_POT));
      const gen7Ids = ["airdrop_trader", "airdrop_creator"].map((program) => weeklyContractBatchId(chainId, epochId, program, GEN7_POT));
      assert.ok(mainIds.includes(batchId), `${chainId} ${epochId} ${batchId} is reproduced`);
      assert.deepEqual(explicitMain, mainIds);
      assert.ok(!gen7Ids.includes(batchId), "a gen-7 id never equals a pre-authorized main id");
      checked += 1;
    }
  }
  assert.ok(checked >= 24, `checked ${checked} pre-authorized ids`);
});

test("main id = keccak of the original string; gen-7 id appends :gen7 and differs", () => {
  const original = keccak256(toUtf8Bytes(`mwz-weekly-airdrop:${CHAIN}:${EPOCH}:airdrop_trader`));
  assert.equal(weeklyContractBatchId(CHAIN, EPOCH, "airdrop_trader"), original);
  assert.equal(weeklyContractBatchId(56, "2026-09-21", "airdrop_trader"), "0x50b18e4762407c91c9d80a857164b640ea008cfb9eb04d9321d4636c833644d5");
  assert.equal(weeklyContractBatchId(4663, "2026-10-05", "airdrop_creator"), "0x64231bc9be30c13a98e453bd4faa176aa92e540bd6b8c6e9e7e8b5e61db0d75b");
  const gen7 = weeklyContractBatchId(CHAIN, EPOCH, "airdrop_trader", GEN7_POT);
  assert.equal(gen7, keccak256(toUtf8Bytes(`mwz-weekly-airdrop:${CHAIN}:${EPOCH}:airdrop_trader:gen7`)));
  assert.notEqual(gen7, original);
  // Holder batches (other agent's lane) keep their own namespace.
  assert.notEqual(gen7, weeklyContractBatchId(CHAIN, EPOCH, "airdrop_holders"));
});

// ---------------------------------------------------------------------------- env scheme

test("unset gen-7 env = one main pot read exactly as before", () => {
  const env = { COMMUNITY_REWARDS_VAULT_ADDRESS_56: MAIN_VAULT, REWARD_DISTRIBUTOR_ADDRESS_56: MAIN_DIST };
  assert.deepEqual(airdropPots(56, env), [{ pot: "main", label: "main pot", vaultAddress: MAIN_VAULT, distributorAddress: MAIN_DIST }]);
  assert.equal(airdropPots(56, { COMMUNITY_REWARDS_VAULT_ADDRESS: MAIN_VAULT })[0].vaultAddress, MAIN_VAULT, "generic fallback kept");
  assert.equal(gen7PotConfig(56, env), null);
});

test("both gen-7 vars = a second pot; one of them or a copy of main = config error", () => {
  const env = {
    COMMUNITY_REWARDS_VAULT_ADDRESS_56: MAIN_VAULT, REWARD_DISTRIBUTOR_ADDRESS_56: MAIN_DIST,
    COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: GEN7_VAULT.toLowerCase(), REWARD_DISTRIBUTOR_ADDRESS_GEN7_56: GEN7_DIST,
  };
  const pots = airdropPots(56, env);
  assert.deepEqual(pots.map((p) => p.pot), ["main", "gen7"]);
  assert.equal(pots[1].vaultAddress, GEN7_VAULT);
  assert.equal(pots[1].distributorAddress, GEN7_DIST);
  assert.equal(airdropPots(4663, env).length, 1, "per chain");
  assert.throws(() => airdropPots(56, { ...env, REWARD_DISTRIBUTOR_ADDRESS_GEN7_56: "" }), /needs both/);
  assert.throws(() => airdropPots(56, { ...env, COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: "" }), /needs both/);
  assert.throws(() => airdropPots(56, { ...env, COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: MAIN_VAULT }), /equals the main pot's vault/);
  assert.throws(() => airdropPots(56, { ...env, REWARD_DISTRIBUTOR_ADDRESS_GEN7_56: MAIN_DIST }), /equals the main pot's distributor/);
});

test("operator key: gen-7 uses the main key unless the gen-7 override is set", () => {
  const env = { AIRDROP_OPERATOR_PRIVATE_KEY_56: "0xmain" };
  assert.equal(potOperatorKey(56, MAIN_POT, env), "0xmain");
  assert.equal(potOperatorKey(56, GEN7_POT, env), "0xmain");
  assert.equal(potOperatorKey(56, GEN7_POT, { ...env, AIRDROP_OPERATOR_PRIVATE_KEY_GEN7_56: "0xgen7" }), "0xgen7");
  assert.equal(potOperatorKey(56, MAIN_POT, { ...env, AIRDROP_OPERATOR_PRIVATE_KEY_GEN7_56: "0xgen7" }), "0xmain");
});

test("draw labels, source ids and metadata: main unchanged, gen-7 tagged", () => {
  assert.equal(drawLabel(56, EPOCH, "airdrop_trader"), `56:${EPOCH}:airdrop_trader`);
  assert.equal(drawLabel(56, EPOCH, "airdrop_trader", MAIN_POT), `56:${EPOCH}:airdrop_trader`);
  assert.equal(drawLabel(56, EPOCH, "airdrop_trader", GEN7_POT), `56:${EPOCH}:airdrop_trader:gen7`);
  assert.equal(winnerSourceId(EPOCH, "airdrop_creator", 3), `${EPOCH}:airdrop_creator:3`);
  assert.equal(winnerSourceId(EPOCH, "airdrop_creator", 3, GEN7_POT), `${EPOCH}:gen7:airdrop_creator:3`);
  assert.deepEqual(potMetadata(MAIN_POT), {});
  assert.deepEqual(potMetadata(undefined), {});
  assert.deepEqual(potMetadata(GEN7_POT), { airdropPot: "gen7" });
});

// ---------------------------------------------------------------------------- DB helpers (fake client)

function fakeClient(answer = () => ({ rows: [] })) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      seen.push({ sql, params });
      return answer(sql, params) || { rows: [] };
    },
  };
}

test("findEpochBatch / stageWinners / otherPotWallets filter by pot (main = rows without airdropPot)", async () => {
  const client = fakeClient();
  await findEpochBatch(client, { chainId: 56, epochId: EPOCH, program: "airdrop_trader" });
  await findEpochBatch(client, { chainId: 56, epochId: EPOCH, program: "airdrop_trader", pot: GEN7_POT });
  assert.match(client.seen[0].sql, /coalesce\(metadata->>'airdropPot','main'\)=\$4/);
  assert.deepEqual(client.seen[0].params, ["56", EPOCH, "airdrop_trader", "main"]);
  assert.deepEqual(client.seen[1].params, ["56", EPOCH, "airdrop_trader", "gen7"]);

  const staged = fakeClient();
  const winner = { walletAddress: "0xabc", winnerRank: 1, finalWeight: 1, activityScore: 1 };
  const common = { chainId: 56, epochId: EPOCH, program: "airdrop_trader", winners: [winner], payouts: [5n], start: new Date(0), end: new Date(0), poolWei: 5n, seedCommitment: "c" };
  await stageWinners(staged, common);
  await stageWinners(staged, { ...common, pot: GEN7_POT });
  assert.deepEqual(staged.seen[0].params, ["airdrop_trader", EPOCH, "56", "main"]);
  assert.equal(staged.seen[1].params[7], `${EPOCH}:airdrop_trader:1`);
  assert.equal(JSON.parse(staged.seen[1].params[8]).airdropPot, undefined, "main metadata unchanged");
  assert.deepEqual(staged.seen[2].params, ["airdrop_trader", EPOCH, "56", "gen7"]);
  assert.equal(staged.seen[3].params[7], `${EPOCH}:gen7:airdrop_trader:1`);
  assert.equal(JSON.parse(staged.seen[3].params[8]).airdropPot, "gen7");

  const other = fakeClient(() => ({ rows: [{ wallet_address: "0xaaa" }] }));
  assert.deepEqual(await otherPotWallets(other, { chainId: 56, epochId: EPOCH, pot: GEN7_POT }), ["0xaaa"]);
  assert.match(other.seen[0].sql, /<>\$3/);
  assert.deepEqual(other.seen[0].params, ["56", EPOCH, "gen7"]);
});

test("materializeAirdropBatch: main rows carry no pot and the original id; gen-7 rows carry their pot, id and distributor", async () => {
  const run = async (pot, distributorAddress) => {
    const client = fakeClient((sql, params) => {
      if (/insert into public\.reward_batches/.test(sql)) return { rows: [{ id: "b1", metadata: JSON.parse(params[3]) }] };
      if (/update public\.reward_batches/.test(sql)) return { rows: [{ id: "b1", metadata: JSON.parse(params[1]) }] };
      if (/insert into public\.reward_ledger/.test(sql)) return { rows: [{ id: "l1" }] };
      return { rows: [] };
    });
    const out = await materializeAirdropBatch(client, {
      chainId: 56, epochId: EPOCH, program: "airdrop_trader", claimDeadline: 1,
      winners: [{ walletAddress: "0x00000000000000000000000000000000000000aa", winnerRank: 1 }], payouts: [7n],
      distributorAddress, ...(pot ? { pot } : {}),
    });
    return { client, out };
  };
  const main = await run(undefined, MAIN_DIST);
  const dup = main.client.seen.find((q) => /for update/.test(q.sql));
  assert.deepEqual(dup.params, ["56", EPOCH, "airdrop_trader", "main"]);
  const mainBatchMeta = JSON.parse(main.client.seen.find((q) => /insert into public\.reward_batches/.test(q.sql)).params[3]);
  assert.equal(mainBatchMeta.airdropPot, undefined);
  const mainLedger = main.client.seen.find((q) => /insert into public\.reward_ledger/.test(q.sql));
  assert.equal(mainLedger.params[0], `${EPOCH}:airdrop_trader:1`);
  const mainLeaf = JSON.parse(mainLedger.params[4]);
  assert.equal(mainLeaf.contractBatchId, weeklyContractBatchId(56, EPOCH, "airdrop_trader"));
  assert.equal(mainLeaf.distributorAddress, MAIN_DIST);
  assert.equal(mainLeaf.airdropPot, undefined);

  const gen7 = await run(GEN7_POT, GEN7_DIST);
  assert.deepEqual(gen7.client.seen.find((q) => /for update/.test(q.sql)).params, ["56", EPOCH, "airdrop_trader", "gen7"]);
  const gen7BatchMeta = JSON.parse(gen7.client.seen.find((q) => /insert into public\.reward_batches/.test(q.sql)).params[3]);
  assert.equal(gen7BatchMeta.airdropPot, "gen7");
  const gen7Ledger = gen7.client.seen.find((q) => /insert into public\.reward_ledger/.test(q.sql));
  assert.equal(gen7Ledger.params[0], `${EPOCH}:gen7:airdrop_trader:1`);
  const gen7Leaf = JSON.parse(gen7Ledger.params[4]);
  assert.equal(gen7Leaf.contractBatchId, weeklyContractBatchId(56, EPOCH, "airdrop_trader", GEN7_POT));
  assert.equal(gen7Leaf.distributorAddress, GEN7_DIST, "the claim goes to the gen-7 distributor");
  assert.equal(gen7Leaf.airdropPot, "gen7");
  assert.equal(gen7Leaf.merkleRoot, mainLeaf.merkleRoot, "same tree shape, different batch");
});

// ---------------------------------------------------------------------------- the draw over pots

const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const candidates = (from, count, kind) => Array.from({ length: count }, (_, i) => ({ walletAddress: wallet(from + i), finalWeight: 1 + (i % 3), activityScore: 1, kind }));

function harness({ pools = { main: 10n ** 18n, gen7: 10n ** 18n }, traders = candidates(0x100, 6, "t"), creators = candidates(0x200, 6, "c"), fail = {}, dbOtherPot = [] } = {}) {
  const log = { draws: [], materialized: [], funded: [], alerts: [], otherPotCalls: 0 };
  const deps = {
    findEpochBatch: async () => null,
    otherPotWallets: async () => { log.otherPotCalls += 1; return dbOtherPot; },
    resolvePoolWei: async (_chain, potConfig) => {
      const pot = potConfig?.pot || "main";
      if (fail[`pool:${pot}`]) throw new Error(fail[`pool:${pot}`]);
      return { availableWei: pools[pot] ?? 0n, source: "community_rewards_vault", vaultAddress: potConfig.vaultAddress };
    },
    nativeUsdFor: async () => 600,
    exclusionSets: async () => ({ all: new Set(), totalCount: 0 }),
    traderCandidates: async () => traders.map((c) => ({ ...c })),
    creatorCandidates: async () => creators.map((c) => ({ ...c })),
    stageWinners: async () => {},
    materializeAirdropBatch: async (_client, args) => {
      log.materialized.push(args);
      return { batch: { id: `${args.pot}:${args.program}`, metadata: { pot: args.pot } } };
    },
    ensureOnChainBatch: async (args) => {
      if (fail[`fund:${args.pot}`]) throw new Error(fail[`fund:${args.pot}`]);
      log.funded.push(args);
      return { txHash: "0x1" };
    },
    markClaimOpen: async () => ({}),
    keepFundingCheck: async () => {},
    markFundingCheck: async () => {},
    writeRewardAlert: async (_client, alert) => { log.alerts.push(alert); },
    audit: async () => {},
    batchWallets: async () => [],
  };
  return { log, deps };
}

const ctx = { chainId: 56, epochId: EPOCH, start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-12T00:00:00Z"), claimDeadline: 1, commitment: "c", drawSecret: "secret", dryRun: false, distributionBps: 10_000 };
const MAIN = { pot: "main", label: "main pot", vaultAddress: MAIN_VAULT, distributorAddress: MAIN_DIST };
const GEN7 = { pot: "gen7", label: "gen-7 pot", vaultAddress: GEN7_VAULT, distributorAddress: GEN7_DIST };
const winnersOf = (log, pot) => log.materialized.filter((m) => (m.pot || "main") === pot).flatMap((m) => m.winners.map((w) => w.walletAddress));

test("single main pot: draws, materializes and funds exactly as the single-pot runner (no cross-pot read)", async () => {
  const process_env = process.env.AIRDROP_TRADER_WINNERS;
  process.env.AIRDROP_TRADER_WINNERS = "2";
  process.env.AIRDROP_CREATOR_WINNERS = "2";
  try {
    const { log, deps } = harness();
    await runAllPots(fakeClient(), ctx, [MAIN], deps);
    assert.equal(log.otherPotCalls, 0);
    assert.deepEqual(log.materialized.map((m) => [m.program, m.pot, m.distributorAddress]), [["airdrop_trader", "main", MAIN_DIST], ["airdrop_creator", "main", MAIN_DIST]]);
    assert.deepEqual(log.funded.map((f) => [f.distributorAddress, f.vaultAddress, f.pot]), [[MAIN_DIST, MAIN_VAULT, "main"], [MAIN_DIST, MAIN_VAULT, "main"]]);
    // Pool split as before: half trader, half creator, of the whole vault at 10000 bps.
    assert.equal(log.materialized[0].payouts.reduce((a, b) => a + b, 0n), 5n * 10n ** 17n);

    // Adding a gen-7 pot leaves the main pot's draw byte-identical (main draws first, nothing reserved).
    const two = harness();
    await runAllPots(fakeClient(), ctx, [MAIN, GEN7], two.deps);
    assert.deepEqual(winnersOf(two.log, "main"), winnersOf(log, "main"));
    assert.deepEqual(two.log.materialized.filter((m) => m.pot === "main").map((m) => m.payouts), log.materialized.map((m) => m.payouts));
  } finally {
    if (process_env === undefined) delete process.env.AIRDROP_TRADER_WINNERS; else process.env.AIRDROP_TRADER_WINNERS = process_env;
    delete process.env.AIRDROP_CREATOR_WINNERS;
  }
});

test("two pots: each pays its own balance through its own distributor; a wallet wins from at most one pot a week", async () => {
  process.env.AIRDROP_TRADER_WINNERS = "2";
  process.env.AIRDROP_CREATOR_WINNERS = "2";
  try {
    const { log, deps } = harness({ pools: { main: 4n * 10n ** 18n, gen7: 2n * 10n ** 18n }, dbOtherPot: ["0x0000000000000000000000000000000000000101"] });
    await runAllPots(fakeClient(), ctx, [MAIN, GEN7], deps);
    assert.equal(log.otherPotCalls, 2, "each pot reads the other pots' winners from the DB");
    const main = winnersOf(log, "main");
    const gen7 = winnersOf(log, "gen7");
    assert.equal(main.length, 4);
    assert.equal(gen7.length, 4);
    for (const w of gen7) assert.ok(!main.includes(w), `${w} won in both pots`);
    assert.ok(!main.includes("0x0000000000000000000000000000000000000101") && !gen7.includes("0x0000000000000000000000000000000000000101"), "DB winners of another pot stay out");
    const total = (pot) => log.materialized.filter((m) => m.pot === pot).reduce((sum, m) => sum + m.payouts.reduce((a, b) => a + b, 0n), 0n);
    assert.equal(total("main"), 4n * 10n ** 18n);
    assert.equal(total("gen7"), 2n * 10n ** 18n);
    for (const f of log.funded) {
      assert.equal(f.distributorAddress, f.pot === "gen7" ? GEN7_DIST : MAIN_DIST);
      assert.equal(f.vaultAddress, f.pot === "gen7" ? GEN7_VAULT : MAIN_VAULT);
    }
  } finally {
    delete process.env.AIRDROP_TRADER_WINNERS;
    delete process.env.AIRDROP_CREATOR_WINNERS;
  }
});

test("gen-7 pot rolls over (no batch, no error) when the main pot already drew every eligible wallet", async () => {
  process.env.AIRDROP_TRADER_WINNERS = "10";
  process.env.AIRDROP_CREATOR_WINNERS = "10";
  try {
    const { log, deps } = harness({ traders: candidates(0x100, 3, "t"), creators: candidates(0x200, 3, "c") });
    await runAllPots(fakeClient(), ctx, [MAIN, GEN7], deps);
    assert.equal(winnersOf(log, "main").length, 6);
    assert.equal(log.materialized.filter((m) => m.pot === "gen7").length, 0);
    assert.equal(log.alerts.length, 0);
  } finally {
    delete process.env.AIRDROP_TRADER_WINNERS;
    delete process.env.AIRDROP_CREATOR_WINNERS;
  }
});

test("main pot with no candidates still fails loudly (unchanged); an empty main pot is skipped while gen-7 still pays", async () => {
  const none = harness({ traders: [], creators: [] });
  await assert.rejects(runAllPots(fakeClient(), ctx, [MAIN], none.deps), /No eligible candidates remain for airdrop_trader/);

  const empty = harness({ pools: { main: 0n, gen7: 10n ** 18n } });
  await runAllPots(fakeClient(), ctx, [MAIN, GEN7], empty.deps);
  assert.equal(empty.log.materialized.filter((m) => m.pot === "main").length, 0);
  assert.equal(empty.log.materialized.filter((m) => m.pot === "gen7").length, 2);
});

test("one pot failing never stops the other; one pot rethrows its own error, two pots name the failed pot", async (t) => {
  process.env.AIRDROP_TRADER_WINNERS = "2";
  process.env.AIRDROP_CREATOR_WINNERS = "2";
  t.after(() => { delete process.env.AIRDROP_TRADER_WINNERS; delete process.env.AIRDROP_CREATOR_WINNERS; });
  const single = harness({ fail: { "fund:main": "Batch x is not pre-authorized by the Safe (or already used)" } });
  const error = await runAllPots(fakeClient(), ctx, [MAIN], single.deps).catch((e) => e);
  assert.equal(error.message, "Batch x is not pre-authorized by the Safe (or already used)");
  assert.equal(error.pots, undefined);
  assert.equal(single.log.alerts[0].title, "Airdrop batch funding failed");

  const two = harness({ fail: { "fund:main": "main unauthorized" } });
  const both = await runAllPots(fakeClient(), ctx, [MAIN, GEN7], two.deps).catch((e) => e);
  assert.match(both.message, /^main pot: main unauthorized$/);
  assert.deepEqual(both.pots, ["main"]);
  assert.equal(two.log.funded.filter((f) => f.pot === "gen7").length, 2, "gen-7 still funded");
  assert.equal(two.log.alerts.find((a) => a.metadata.airdropPot === undefined).title, "Airdrop batch funding failed");

  const gen7Fails = harness({ fail: { "pool:gen7": "rpc down" } });
  const g = await runAllPots(fakeClient(), ctx, [MAIN, GEN7], gen7Fails.deps).catch((e) => e);
  assert.match(g.message, /gen7 pot: rpc down/);
  assert.equal(gen7Fails.log.funded.filter((f) => f.pot === "main").length, 2);
});

test("dry run: nothing materialized or funded, and gen-7 still excludes the main pot's in-memory winners", async () => {
  process.env.AIRDROP_TRADER_WINNERS = "3";
  process.env.AIRDROP_CREATOR_WINNERS = "3";
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const { log, deps } = harness();
    const reserved = await runAllPots(fakeClient(), { ...ctx, dryRun: true }, [MAIN, GEN7], deps);
    assert.equal(log.materialized.length, 0);
    assert.equal(log.funded.length, 0);
    const outputs = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const main = outputs.filter((o) => !o.pot).flatMap((o) => o.winners.map((w) => w.walletAddress));
    const gen7 = outputs.filter((o) => o.pot === "gen7").flatMap((o) => o.winners.map((w) => w.walletAddress));
    assert.equal(main.length, 6);
    assert.equal(gen7.length, 6);
    for (const w of gen7) assert.ok(!main.includes(w));
    assert.equal(reserved.size, 12);
  } finally {
    console.log = original;
    delete process.env.AIRDROP_TRADER_WINNERS;
    delete process.env.AIRDROP_CREATOR_WINNERS;
  }
});

/**
 * Payout watchdog, gen-8, end to end on a LOCAL chain (anvil, chain 97, no fork) with a throwaway Postgres 16:
 *
 *   - the production gen-8 contracts (build/evm-gen8 artifacts, gen8LocalChain.ts), the choice vault's admin being a
 *     module avatar (MockModuleAvatar, the Safe stand-in of test/PayoutRolesPolicy.spec.ts), its holder RewardDistributor
 *     owned by the same avatar;
 *   - the REAL Zodiac Roles v2.1.0 bytecode (vendored init code, deployed through the ERC-2470 factory at its canonical
 *     addresses), a proxy whose owner = avatar = target = the avatar, scoped with scripts/lib/payoutRolesPolicy.ts for
 *     gen-8 only (the 4-arg approve on the vault, authorizeBatch on its distributor);
 *   - a holders coin, trades across a simulated week (time travel), the four check blocks inside the week's windows;
 *   - the operator's leaf file built HERE with the shared rule (evmGen8HoldThrough.ts) from chain balances, stored in
 *     public.evm_holder_batches, and the operator's proposeHolderBatch;
 *   - the watchdog tick (payoutWatchdogWorker.runWatchdogTick, its own key): a tampered stored file is refused
 *     (critical alert, not approved); the valid file: dry run signs nothing, then the watchdog approves through Roles and
 *     authorizes the gen-8 distributor's ids; the operator executes after the 24 h window; a holder claims.
 *
 * Skips when the gen-8 artifacts, anvil, Postgres 16 or the root hardhat artifacts (MockModuleAvatar) are missing.
 * Ports: GEN8_ANVIL_PORT (8791) and DBC_THROWAY_PG_PORT (55451).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { artifactsAvailable, deployArtifact, deployGen8Local, fund, launchCoin, startAnvil, swap, WAD } from "./gen8/gen8LocalChain.js";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";
import { buildGen8LeafFileV2 } from "./gen8/gen8LeafFileV2.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PG16 = "/usr/lib/postgresql/16/bin";
const AVATAR_ARTIFACT = path.join(ROOT, "artifacts/contracts/mocks/MockModuleAvatar.sol/MockModuleAvatar.json");
const ZODIAC = path.join(ROOT, "scripts/lib/zodiac/roles-v2.1.0.json");
const runnable = artifactsAvailable() && fs.existsSync(`${PG16}/initdb`) && fs.existsSync(AVATAR_ARTIFACT);
const ANVIL_PORT = Number(process.env.GEN8_ANVIL_PORT || 8791);
const PG_PORT = Number(process.env.DBC_THROWAY_PG_PORT || 55451);
const CHAIN = 97;
const DAY = 86_400;
const MASTER = "gen8-watchdog-e2e-master";
const UINT64_MAX = (1n << 64n) - 1n;

/** Zodiac Roles v2.1.0, its libraries and the ModuleProxyFactory at their canonical addresses on the local chain. */
async function installZodiac(provider: ethers.JsonRpcProvider, signer: ethers.Wallet) {
  const v = JSON.parse(fs.readFileSync(ZODIAC, "utf8"));
  await provider.send("anvil_setCode", [v.singletonFactory, v.singletonFactoryRuntime]);
  const factory = new ethers.Contract(v.singletonFactory, ["function deploy(bytes initCode, bytes32 salt) returns (address)"], signer);
  const initOf = (c: any) => ethers.concat([c.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(c.constructorArgs.types, c.constructorArgs.values)]);
  const deploy = async (initCode: string, salt: string, address: string) => {
    if ((await provider.getCode(address)) !== "0x") return;
    await (await factory.deploy(initCode, salt, { gasLimit: 15_000_000 })).wait();
    assert.notEqual(await provider.getCode(address), "0x", `zodiac ${address}`);
  };
  for (const name of ["Integrity", "Packer", "Roles"]) await deploy(initOf(v.contracts[name]), v.contracts[name].salt, v.contracts[name].address);
  await deploy(v.moduleProxyFactory.initCode, v.moduleProxyFactory.salt, v.moduleProxyFactory.address);
  return { rolesAbi: v.contracts.Roles.abi as any[] };
}

test("gen-8 watchdog end to end: shared-rule leaf file, tampered file refused, valid batch approved through the real Roles module, executed, claimed", { skip: runnable ? false : "gen-8 artifacts, anvil, Postgres 16 or root artifacts missing", timeout: 900_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.PG_DISABLE_SSL = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs" as string);
  const pg = await startThrowawayPostgres({
    port: PG_PORT,
    extraFiles: [
      ...gen8SchemaFiles(),
      "db/migrations/20260930_300001_evm_creator_choice_operator.sql",
      "db/migrations/20261008_000040_evm_holder_batches_per_vault.sql",
      "db/migrations/20261008_000050_payout_watchdog_state.sql",
    ],
  });
  const anvil = await startAnvil(ANVIL_PORT, CHAIN);
  try {
    process.env.DATABASE_URL = pg.url;
    const db = pg.pool;
    const provider = new ethers.JsonRpcProvider(anvil.url, CHAIN, { staticNetwork: true, cacheTimeout: -1 });
    const rpc = (m: string, p: unknown[] = []) => provider.send(m, p);
    const now = async () => Number((await provider.getBlock("latest"))!.timestamp);
    const at = async (t: number) => {
      await rpc("evm_setNextBlockTimestamp", [t]);
      await rpc("evm_mine", []);
      return provider.getBlockNumber();
    };
    const key = (s: string) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`mwz-gen8-watchdog-e2e-${s}`)), provider);
    const [owner, zdeployer, watchdog, h1, h2, h3, h4] = ["owner", "zodiac", "watchdog", "h1", "h2", "h3", "h4"].map(key);
    await fund(provider, [owner, zdeployer, watchdog, h1, h2, h3, h4].map((w) => w.address));

    // ---- Zodiac, the avatar (Safe stand-in), gen-8 with the avatar as the vault's admin, its holder distributor.
    const { rolesAbi } = await installZodiac(provider, zdeployer);
    const avArt = JSON.parse(fs.readFileSync(AVATAR_ARTIFACT, "utf8"));
    const avatar = (await new ethers.ContractFactory(avArt.abi, avArt.bytecode, owner).deploy(owner.address)) as unknown as ethers.Contract;
    await avatar.waitForDeployment();
    const AV = await avatar.getAddress();
    const asSafe = async (to: string, data: string) => (await (avatar.connect(owner) as any).exec(to, 0n, data)).wait();
    const env = await deployGen8Local(provider, { display: false, vaultAdmin: AV });
    const deployBlock = await provider.getBlockNumber();
    const vault = env.vault;
    const V = await vault.getAddress();
    const dist = await deployArtifact(env.deployer, "RewardDistributor", [AV]);
    const D = await dist.getAddress();
    const cap = 32n * WAD;
    await asSafe(D, dist.interface.encodeFunctionData("setBatchOperator", [V]));
    await asSafe(V, vault.interface.encodeFunctionData("setHolderDistributorOnce", [D]));
    await asSafe(V, vault.interface.encodeFunctionData("setOperator", [env.operator.address, false]));
    await asSafe(V, vault.interface.encodeFunctionData("setCaps", [WAD, WAD, 60, 50, cap]));
    assert.equal(await vault.admin(), AV);

    // ---- The Roles proxy (owner = avatar = target = avatar) and the gen-8-only scope, built by the policy code.
    const policyMod: any = await import("../../../scripts/lib/payoutRolesPolicy.ts" as string);
    const MODULE_PROXY_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236";
    const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";
    const plan = policyMod.rolesProxyPlan({ factory: MODULE_PROXY_FACTORY, mastercopy: ROLES_MASTERCOPY, safe: AV, saltNonce: 1n });
    const mpf = new ethers.Contract(MODULE_PROXY_FACTORY, ["function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)"], zdeployer);
    await (await mpf.deployModule(ROLES_MASTERCOPY, plan.initializer, 1n)).wait();
    const policy = policyMod.buildPayoutRolesPolicy({
      chainId: CHAIN, safe: AV, roles: plan.proxy, watchdog: watchdog.address, vaults: [],
      gen8Vaults: [{ label: "gen-8", address: V, maxTotalWei: cap, claimDeadlineMax: UINT64_MAX }],
      distributors: [{ label: "gen-8 holder", kind: "holders", address: D, capWei: cap, idsPerWeek: 1, program: "airdrop_holders_gen8", scheme: "gen8" }],
      allowance: { maxWeeks: 2, initialWeeks: 2 },
    });
    const rolesIface = new ethers.Interface(rolesAbi);
    for (const c of policy.calls) {
      const data = c.contract === "IZodiacRolesV2" ? rolesIface.encodeFunctionData(c.fn, c.args) : avatar.interface.encodeFunctionData(c.fn, c.args);
      await asSafe(c.to, data);
    }
    assert.equal(await (avatar as any).isModuleEnabled(plan.proxy), true);
    assert.deepEqual(policy.table.map((r: any) => [r.target, r.selector]), [[V, "0xc62732bb"], [D, policyMod.SELECTOR.authorizeBatch]]);

    // ---- A holders coin, launched before the week; trades before and across the week's four checks.
    const coin = await launchCoin(env, env.creator, { feeChoice: 2, firstBuyValue: WAD / 1000n, name: "Watchdog Eight", symbol: "WD8" });
    const id = coin.id;
    const token = coin.token;
    const cfgOnVault = await vault.cfg(id);
    assert.equal(Number(cfgOnVault[1]), 2, "holders coin on the vault");
    const launchBlock = coin.rc.blockNumber;
    const launchedAt = Number((await provider.getBlock(launchBlock))!.timestamp);
    await rpc("evm_increaseTime", [120]);
    for (const [w, v] of [[h1, WAD / 50n], [h2, WAD / 100n], [h3, WAD / 200n], [h4, WAD / 400n]] as const) await swap(env, coin, w, { buy: true, exactIn: true, amount: v });

    const { weekOf, weekSecret, holderBatchId, merklePlan } = await import("../evm/evmCreatorChoice.js");
    const { gen8CheckMoments, gen8CheckWindow, gen8EligibleAt, gen8HardSkip } = await import("../evm/evmGen8HoldThrough.js");
    const { evmGen8Config } = await import("../evm/evmGen8Config.js");
    const { gen8HolderExclusions } = await import("../evm/evmGen8Holders.js");
    const week = weekOf(new Date((Math.floor(launchedAt / (7 * DAY)) * 7 * DAY + 8 * 7 * DAY) * 1000)); // a Monday-based week well after launch
    const moments = gen8CheckMoments(weekSecret(MASTER, CHAIN, week.weekId), CHAIN, week.start).map((m) => Math.floor(m.getTime() / 1000));
    const weekEnd = Math.floor(week.end.getTime() / 1000);
    const genv: NodeJS.ProcessEnv = {
      EVM_GEN8_LAUNCHER_97: `${(await env.launcher.getAddress()).toLowerCase()}@${deployBlock}`,
      EVM_GEN8_HOOK_97: `${(await env.hook.getAddress()).toLowerCase()}@${deployBlock}`,
      EVM_GEN8_POOL_MANAGER_97: (await env.pm.getAddress()).toLowerCase(),
      EVM_GEN8_CHOICE_VAULT_97: V.toLowerCase(),
      EVM_GEN8_RESERVE_LOCK_97: (await env.reserveLock.getAddress()).toLowerCase(),
      EVM_GEN8_ESCROW_97: (await env.escrow.getAddress()).toLowerCase(),
    };
    const g8cfg = evmGen8Config(CHAIN, genv).config!;
    assert.ok(g8cfg);

    const checkBlocks: number[] = [];
    // Check 0, then h2 sells part, check 1, h4 buys more, check 2, h3 sells almost all (below 0.01%), check 3. Each
    // trade sits halfway between a check block and the next check's moment.
    const mid = (i: number) => Math.floor((moments[i] + 60 + moments[i + 1]) / 2);
    await provider.send("evm_setNextBlockTimestamp", [moments[0] - 3600]);
    await swap(env, coin, h1, { buy: true, exactIn: true, amount: WAD / 100n });
    checkBlocks.push(await at(moments[0] + 60));
    await provider.send("evm_setNextBlockTimestamp", [mid(0)]);
    await swap(env, coin, h2, { buy: false, exactIn: true, amount: ((await coin.coin.balanceOf(h2.address)) as bigint) / 3n });
    checkBlocks.push(await at(moments[1] + 60));
    await provider.send("evm_setNextBlockTimestamp", [mid(1)]);
    await swap(env, coin, h4, { buy: true, exactIn: true, amount: WAD / 100n });
    // H2: the creator right moves to h4 mid-week (proposeCreator / acceptCreator): from check 2 on, h4 is the skipped creator.
    await (await (vault.connect(env.creator) as any).proposeCreator(id, h4.address)).wait();
    await (await (vault.connect(h4) as any).acceptCreator(id)).wait();
    checkBlocks.push(await at(moments[2] + 60));
    await provider.send("evm_setNextBlockTimestamp", [mid(2)]);
    const h3bal: bigint = await coin.coin.balanceOf(h3.address);
    await swap(env, coin, h3, { buy: false, exactIn: true, amount: h3bal - 10_000n * WAD });
    checkBlocks.push(await at(moments[3] + 60));
    for (let i = 0; i < 4; i += 1) {
      const t = Number((await provider.getBlock(checkBlocks[i]))!.timestamp);
      const w = gen8CheckWindow(moments.map((m) => new Date(m * 1000)), i, week.end);
      assert.ok(t >= w.from && t < w.to, `check ${i} inside its window`);
    }
    // The coin's creator fees to the vault (holders pot).
    await (await (vault.connect(env.other) as any).pull(id)).wait();
    const pot: bigint = await vault.holderBalance(id);
    assert.ok(pot > 0n, "holder pot");

    // ---- The operator: census at each check block (balanceOf at that block for every address that ever held), the
    // shared rule, the leaf file, the proposal on Monday 00:10 after the week.
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const logs = await provider.getLogs({ address: token, topics: [transferTopic], fromBlock: launchBlock, toBlock: checkBlocks[3] });
    const seen = new Set<string>();
    for (const l of logs) for (const t of [l.topics[1], l.topics[2]]) seen.add(ethers.dataSlice(t, 12).toLowerCase());
    seen.delete(ethers.ZeroAddress.toLowerCase());
    const noContracts = new Set<string>(); // only known contracts are skipped (founder 2026-10-22)
    const checks = [];
    for (let i = 0; i < 4; i += 1) {
      const b = checkBlocks[i];
      // The vault's creator at the check block (the operator reads cfg(id).creator when it takes the check).
      const creatorAt = String((await vault.cfg(id, { blockTag: b }))[0]);
      const skip = gen8HardSkip({ token, vault: V, operator: env.operator.address, creator: creatorAt, censusExclusions: gen8HolderExclusions(g8cfg).map((x) => x.wallet) });
      const balances = new Map<string, bigint>();
      for (const w of seen) balances.set(w, await coin.coin.balanceOf(w, { blockTag: b }));
      const supply: bigint = await coin.coin.totalSupply({ blockTag: b });
      const { holders } = gen8EligibleAt(balances, skip, new Set(), noContracts);
      checks.push({ index: i, block: b, blockTime: Number((await provider.getBlock(b))!.timestamp), supply, holders });
    }
    assert.ok(checks[0].holders.some((h) => h.owner === h3.address.toLowerCase()), "h3 held at check 0");
    await at(weekEnd + 600);
    const proposeAt = weekEnd + 660;
    const claimDeadline = proposeAt + DAY + 60 * DAY;
    const built = buildGen8LeafFileV2({ chainId: CHAIN, vault: V, holderDistributor: D, weekId: week.weekId, claimDeadline, minPayoutWei: 10n ** 12n, pools: [{ poolId: id, token, pot, launchedAt, checks }] });
    const file = built.file;
    assert.ok(!file.leaves.some((l) => l.account.toLowerCase() === h3.address.toLowerCase()), "h3 fell below 0.01% at check 3");
    assert.ok(file.leaves.some((l) => l.account.toLowerCase() === h1.address.toLowerCase()));
    assert.ok(!file.leaves.some((l) => [h4.address, env.creator.address].map((x) => x.toLowerCase()).includes(l.account.toLowerCase())), "the creator before and after the transfer is skipped at its checks, so neither holds through");
    assert.equal(file.batchId, holderBatchId(CHAIN, week.weekId, "airdrop_holders_gen8"));
    await provider.send("evm_setNextBlockTimestamp", [proposeAt]);
    const proposeRc = await (await (vault.connect(env.operator) as any).proposeHolderBatch(file.batchId, file.root, claimDeadline, built.ids, built.amounts)).wait();
    const total = built.amounts.reduce((s, x) => s + x, 0n);
    const tampered = JSON.parse(JSON.stringify(file));
    const [la, lb] = tampered.leaves;
    la.parts[0].amount = String(BigInt(la.parts[0].amount) - 1n);
    la.amount = String(BigInt(la.amount) - 1n);
    lb.parts[0].amount = String(BigInt(lb.parts[0].amount) + 1n);
    lb.amount = String(BigInt(lb.amount) + 1n);
    const store = async (f: unknown) =>
      db.query(
        `insert into public.evm_holder_batches (chain_id, week_id, vault_address, batch_id, root, total_raw, claim_deadline, leaf_file, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'proposed')
         on conflict (chain_id, vault_address, week_id) do update set leaf_file = excluded.leaf_file`,
        [CHAIN, week.weekId, V.toLowerCase(), file.batchId.toLowerCase(), file.root, total.toString(), claimDeadline, JSON.stringify(f)],
      );
    await store(tampered);

    // ---- The watchdog.
    const { createEthersWatchdogChain, createEthersWatchdogSender, readGen8VaultFacts } = await import("../evm/payoutWatchdogChain.js");
    const { runWatchdogTick, emptyMemory, gen8CensusExclusionsFor } = await import("../evm/payoutWatchdogWorker.js");
    const lane = { label: "gen-8" as const, vault: V, program: "airdrop_holders_gen8" as const, startBlock: deployBlock, hook: await env.hook.getAddress(), expectedRouter: await env.splitter.getAddress(), holderCapWei: null };
    const wdCfg: any = {
      chainId: CHAIN, send: true, roles: plan.proxy, safe: AV, vaults: [], airdrops: [], gen8Vaults: [lane],
      weeks: 1, intervalMs: 60_000, lookbackBlocks: 100_000, logChunk: 5_000, censusLagBlocks: 0, snapshotToleranceSec: 0, maxExcludedBps: 2_000,
      maxTxPerTick: 10, minPayoutWei: 10n ** 12n, claimWindowDays: 60, excluded: new Set<string>(), masterSecret: MASTER,
    };
    const chain = createEthersWatchdogChain(provider, { logChunk: 5_000 });
    const sender = createEthersWatchdogSender(provider, new ethers.Wallet(watchdog.privateKey));
    const tickDeps = (memory: any, send: boolean) => ({
      db, cfg: { ...wdCfg, send }, chain, sender, memory, riskExcluded: async () => new Set<string>(),
      gen8CensusExclusions: () => gen8CensusExclusionsFor(db, CHAIN, genv),
      readGen8Vault: async (l: any) => readGen8VaultFacts(provider, { ...l, chainId: CHAIN }, { fromBlock: deployBlock, toBlock: await provider.getBlockNumber(), knownClaimers: new Set<string>() }),
      log: () => {},
    });

    // 1. The tampered stored file: refused, critical alert, nothing sent to the vault.
    const nonce0 = await provider.getTransactionCount(watchdog.address);
    const m1 = emptyMemory();
    const r1 = await runWatchdogTick(tickDeps(m1, true) as any);
    assert.equal(r1.roleOk && r1.moduleEnabled && r1.wiringOk, true, JSON.stringify(r1));
    const a1 = r1.actions.find((x: any) => x.kind === "approve");
    assert.equal(a1?.decision, "mismatch", JSON.stringify(r1.actions));
    assert.match(String(a1?.reason), /under the rule, the file says/);
    assert.equal((await vault.holderBatches(file.batchId)).approved, false);
    const alerts = (await db.query(`select severity, metadata->>'kind' as kind from public.reward_alerts where status = 'open' and reward_type = 'payout_watchdog'`)).rows;
    assert.ok(alerts.some((x: any) => x.kind === "payout_watchdog_mismatch" && x.severity === "critical"));
    // The same tick still keeps the gen-8 distributor's runway (authorizations only).
    assert.ok(r1.actions.filter((x: any) => x.kind === "authorize").every((x: any) => x.decision === "sent" && x.target === D), JSON.stringify(r1.actions));
    const sentByTampered = (await provider.getTransactionCount(watchdog.address)) - nonce0;
    assert.equal(sentByTampered, r1.actions.filter((x: any) => x.decision === "sent").length);

    // 1b. The Safe signers' manual fallback script (read-only) on the same chain: the tampered file is refused and no
    // batch is printed; the valid file matches and the printed batch is the 4-arg approve (the id is already authorized).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-verify-"));
    fs.writeFileSync(path.join(tmp, "tampered.json"), JSON.stringify(tampered));
    fs.writeFileSync(path.join(tmp, "valid.json"), JSON.stringify(file));
    const script = (f: string, out: string) =>
      spawnSync(process.execPath, [path.join(ROOT, "scripts/evm-gen8-holder-batch-verify.mjs"), "--chain", String(CHAIN), "--file", path.join(tmp, f), "--rpc", anvil.url, "--vault", V, "--vault-block", String(deployBlock), "--tx", proposeRc.hash, "--out", path.join(tmp, out)], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...genv, EVM_BUYBACK_SEED_SECRET: MASTER, EVM_HOLDER_MIN_PAYOUT_WEI_97: String(10n ** 12n), EVM_HOLDER_CLAIM_WINDOW_DAYS: "60" },
      });
    const bad = script("tampered.json", "bad.json");
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /REFUSED \(mismatch\): .*under the rule, the file says/);
    assert.equal(fs.existsSync(path.join(tmp, "bad.json")), false);
    const good = script("valid.json", "good.json");
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /MATCH: week /);
    const printed = JSON.parse(fs.readFileSync(path.join(tmp, "good.json"), "utf8"));
    assert.deepEqual(printed.transactions.map((x: any) => [x.to, x.data.slice(0, 10), x.value]), [[V, "0xc62732bb", "0"]]);
    assert.deepEqual(Object.values(printed.transactions[0].contractInputsValues), [file.batchId, file.root, total.toString(), String(claimDeadline)]);

    // 2. The valid file (a fresh watchdog memory): dry run signs nothing, then the approval through the module.
    await store(file);
    const m2 = emptyMemory();
    const nonce1 = await provider.getTransactionCount(watchdog.address);
    const r2 = await runWatchdogTick(tickDeps(m2, false) as any);
    assert.equal(await provider.getTransactionCount(watchdog.address), nonce1, "dry run sends nothing");
    assert.equal(r2.actions.find((x: any) => x.kind === "approve")?.decision, "dry-run", JSON.stringify(r2.actions));
    const r3 = await runWatchdogTick(tickDeps(m2, true) as any);
    const approved = r3.actions.find((x: any) => x.kind === "approve");
    assert.equal(approved?.decision, "sent", JSON.stringify(r3.actions));
    const hb = await vault.holderBatches(file.batchId);
    assert.equal(hb.approved, true);
    assert.equal(BigInt(hb.total), total);
    const approveTx = await provider.getTransactionReceipt(approved!.txHash!);
    const ev = approveTx!.logs.filter((l) => l.address === V).map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "HolderBatchApproved");
    assert.deepEqual([String(ev!.args.batchId), String(ev!.args.root), BigInt(ev!.args.total), BigInt(ev!.args.claimDeadline)], [file.batchId, file.root, total, BigInt(claimDeadline)]);
    // The week's distributor id was authorized by the watchdog (tick 1) at the cap, in the 6-day window after the week.
    const auth = await dist.batchAuthorization(file.batchId);
    assert.deepEqual([auth.authorized, BigInt(auth.maxAmount), Number(auth.publishAfter), Number(auth.publishDeadline)], [true, cap, weekEnd, weekEnd + 6 * DAY]);
    // A further tick sees HolderBatchApproved and leaves the batch alone.
    const r4 = await runWatchdogTick(tickDeps(m2, true) as any);
    assert.equal(r4.actions.filter((x: any) => x.kind === "approve").length, 0, JSON.stringify(r4.actions));

    // ---- The operator executes after the veto window; a holder claims.
    await at(Number(hb.executableAt) + 60);
    await (await (vault.connect(env.operator) as any).executeHolderBatch(file.batchId)).wait();
    const batch = await dist.batches(file.batchId);
    assert.equal(BigInt(batch.totalFunded), total);
    const entries = file.leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }));
    const tree = merklePlan(entries);
    const i1 = entries.findIndex((e) => e.account.toLowerCase() === h1.address.toLowerCase());
    const before = await provider.getBalance(h1.address);
    const claimRc = await (await (dist.connect(h1) as any).claim(file.batchId, entries[i1].amount, tree.proofs[i1])).wait();
    const after = await provider.getBalance(h1.address);
    assert.equal(after - before + BigInt(claimRc.gasUsed) * BigInt(claimRc.gasPrice), entries[i1].amount);
    console.log(`      gen-8 e2e: week ${week.weekId}, ${file.leaves.length} leaves, total ${ethers.formatEther(total)}, propose block ${proposeRc.blockNumber}; tampered file refused; valid batch approved via Roles (${approved!.txHash}); executed; h1 claimed ${ethers.formatEther(entries[i1].amount)}`);
  } finally {
    await anvil.stop();
    await pg.stop();
  }
});

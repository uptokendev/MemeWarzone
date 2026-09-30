import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { deployEvmGen, createCoin, E, mineAt, buyNative } from "./fixtures/evmgenCore";

/**
 * The indexer's EVM graduation keeper (realtime-indexer/src/evm/evmGraduationKeeper.ts) run against the
 * compiled LaunchCampaign on a local chain: it simulates, records the job before broadcasting, sends,
 * resolves by receipt, and flushes an escrowed protocol fee once the router accepts it. realtime-indexer is
 * an ES module package, so its sources are transpiled here with a require shim.
 */
function loadKeeper() {
  const dir = path.join(__dirname, "../realtime-indexer/src/evm");
  const load = (file: string, deps: Record<string, unknown>) => {
    const js = ts.transpileModule(readFileSync(path.join(dir, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} as any };
    const req = (id: string) => (id in deps ? deps[id] : require(id));
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return mod.exports;
  };
  const abi = load("evmGen5Abi.ts", {});
  // The keeper's harvest step (step 7) reads the generation's lockers from evmGen5Aux, which also pulls in
  // the database store. This spec has no lockers configured, so a stub with the same config reading is enough.
  const aux = { configuredGen5AuxContracts: () => [] };
  return load("evmGraduationKeeper.ts", { ethers: require("ethers"), "./evmGen5Abi.js": abi, "./evmGen5Aux.js": aux });
}
const keeper = loadKeeper();

function memoryDb() {
  const jobs: any[] = [];
  const order: string[] = [];
  let id = 0;
  return {
    jobs,
    order,
    async query(sql: string, params: any[] = []) {
      if (/select \* from public\.evm_graduation_keeper_jobs/.test(sql)) return { rows: jobs.filter((j) => j.status === "sending") };
      if (/insert into public\.evm_graduation_keeper_jobs/.test(sql)) {
        id += 1;
        order.push("recorded");
        jobs.push({ id, campaign: params[1], action: params[2], nonce: params[5], tx_hash: params[7], raw_tx: params[8], status: "sending", attempt: 0 });
        return { rows: [{ id }] };
      }
      if (/update public\.evm_graduation_keeper_jobs/.test(sql)) {
        const job = jobs.find((j) => j.id === params[0]);
        if (job && /set status = \$2/.test(sql)) job.status = params[1];
        if (job && /set status = 'dropped'/.test(sql)) job.status = "dropped";
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("indexer: EVM graduation keeper against the gen-5 campaign", function () {
  it("Pending -> graduate() recorded then sent; a refused routeFinalize is flushed once the router accepts", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await env.evmRouter.setReverts(false, true); // routeFinalize refuses -> the 2.2% is escrowed at graduation
    await buyNative(env, campaign, env.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(true);

    const keeperWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await env.owner.sendTransaction({ to: keeperWallet.address, value: E(1) });
    const provider = ethers.provider as any;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const reader = keeper.createEthersKeeperReader(provider, chainId, keeperWallet.address, {});
    const baseSender = keeper.createEthersKeeperSender(provider, new ethers.Wallet(keeperWallet.privateKey), chainId);
    const db = memoryDb();
    const sender = {
      ...baseSender,
      async broadcast(raw: string) {
        db.order.push("broadcast");
        await baseSender.broadcast(raw);
      },
    };
    const cfg = { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 4 };
    const addr = (await campaign.getAddress()).toLowerCase();

    // Dry run: decides graduate, sends nothing.
    const dry = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg, send: false, campaigns: [addr] });
    expect(dry.steps[0].decision.kind).to.eq("send");
    expect(dry.steps[0].decision.call.fn).to.eq("graduate");
    expect(db.jobs.length).to.eq(0);
    expect(await campaign.launched()).to.eq(false);

    // Send: recorded, then broadcast; graduates.
    const pass1 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg, send: true, campaigns: [addr] });
    expect(db.order).to.deep.eq(["recorded", "broadcast"]);
    expect(pass1.steps[0].sent).to.eq(true);
    expect(await campaign.launched()).to.eq(true);
    const escrowed = await campaign.pendingProtocolGraduationFee();
    expect(escrowed > 0n).to.eq(true);

    // Next pass: the job resolves by receipt; the flush is blocked while the router still refuses.
    const pass2 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg, send: true, campaigns: [addr] });
    expect(pass2.resolved.confirmed).to.eq(1);
    expect(db.jobs[0].status).to.eq("confirmed");
    expect(pass2.steps[0].decision.kind).to.eq("blocked");

    // Router accepts again: the keeper flushes the escrowed 2.2%.
    await env.evmRouter.setReverts(false, false);
    const pass3 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg, send: true, campaigns: [addr] });
    expect(pass3.steps[0].decision.call.fn).to.eq("flushProtocolGraduationFee");
    expect(await campaign.pendingProtocolGraduationFee()).to.eq(0n);
    const pass4 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg, send: true, campaigns: [addr] });
    expect(pass4.resolved.confirmed).to.eq(1);
    expect(pass4.steps[0].decision.kind).to.eq("idle");
    expect(db.jobs.map((j) => [j.action, j.status])).to.deep.eq([["graduate", "confirmed"], ["flush", "confirmed"]]);
  });

  it("a graduation the adapter refuses is blocked with the campaign's named revert, and nothing is sent", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(60));
    await env.adapter.setLie(true);
    const provider = ethers.provider as any;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const w = ethers.Wallet.createRandom();
    const reader = keeper.createEthersKeeperReader(provider, chainId, w.address, {});
    const decision = await keeper.decideKeeperStep(reader, (await campaign.getAddress()).toLowerCase(), { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 2 });
    expect(decision.kind).to.eq("blocked");
    expect(decision.reason).to.match(/AdapterResultInvalid/);
  });

  it("graduate() over the gas cap -> repairPool(0) steps first, then graduate() under a normal cap", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(60));
    await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
    await env.adapter.setStep(E(1000), E(1), 0, 0, 0);
    const addr = (await campaign.getAddress()).toLowerCase();
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await env.owner.sendTransaction({ to: w.address, value: E(1) });
    const gradGas = await ethers.provider.estimateGas({ to: addr, from: w.address, data: campaign.interface.encodeFunctionData("graduate", []) });
    const repairGas = await ethers.provider.estimateGas({ to: addr, from: w.address, data: campaign.interface.encodeFunctionData("repairPool", [0]) });
    expect(repairGas < gradGas).to.eq(true);
    const tightCap = (repairGas + gradGas) / 2n;

    const provider = ethers.provider as any;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const reader = keeper.createEthersKeeperReader(provider, chainId, w.address, {});
    const sender = keeper.createEthersKeeperSender(provider, new ethers.Wallet(w.privateKey), chainId);
    const db = memoryDb();

    const p1 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg: { maxGas: tightCap, minFlushWei: 1n, maxRepairHalvings: 2 }, send: true, campaigns: [addr] });
    expect(p1.steps[0].decision.call.fn).to.eq("repairPool");
    expect(await campaign.repairMemeSold()).to.eq(E(1000));
    expect(await campaign.launched()).to.eq(false);

    const p2 = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader, sender, cfg: { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 2 }, send: true, campaigns: [addr] });
    expect(p2.resolved.confirmed).to.eq(1);
    expect(p2.steps[0].decision.call.fn).to.eq("graduate");
    expect(await campaign.launched()).to.eq(true);
  });

  it("due but not Pending (the crossing buy's oracle read failed): the due filter lists it and graduate() marks and graduates", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    const t = Number((await ethers.provider.getBlock("latest"))!.timestamp);
    await env.feed.setRoundData(2, 0, t, t, 2); // oracle reverts on the crossing buy
    await buyNative(env, campaign, env.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(false);

    const addr = (await campaign.getAddress()).toLowerCase();
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await env.owner.sendTransaction({ to: w.address, value: E(1) });
    const provider = ethers.provider as any;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const reader = keeper.createEthersKeeperReader(provider, chainId, w.address, { EVM_GRADUATION_KEEPER_TARGET_TTL_MS: "5000" });
    const sender = keeper.createEthersKeeperSender(provider, new ethers.Wallet(w.privateKey), chainId);
    const cfg = { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 2, dueSlackBps: 200, maxDueCandidates: 5 };

    // Indexed state: the campaign's net raise as the indexer derives it (gross buys - gross sells).
    const netRaised = (await campaign.netRaisedWei()).toString();
    const sold = (await campaign.sold()).toString();
    const db = memoryDb();
    const baseQuery = db.query.bind(db);
    (db as any).query = async (sql: string, params: any[] = []) => {
      if (/from public\.campaigns c\s+join public\.curve_trades t/.test(sql)) {
        return { rows: [{ campaign_address: addr, net_raised_raw: netRaised, sold_raw: sold }] };
      }
      if (/from public\.campaigns c\s+left join public\.evm_campaign_gen5_state/.test(sql)) return { rows: [] };
      return baseQuery(sql, params);
    };

    // Oracle still down: the target is unreadable and the curve is not sold out, so nothing is listed.
    expect(await keeper.listDueCampaigns({ db, chainId, reader, cfg })).to.deep.eq([]);

    // Oracle back (fresh reader: no cached null target): listed, simulated, sent; Pending and Graduated in one call.
    const t2 = Number((await ethers.provider.getBlock("latest"))!.timestamp);
    await env.feed.setRoundData(3, 600n * 10n ** 8n, t2, t2, 3);
    const fresh = keeper.createEthersKeeperReader(provider, chainId, w.address, {});
    expect(await keeper.listDueCampaigns({ db, chainId, reader: fresh, cfg })).to.deep.eq([addr]);
    const pass = await keeper.runEvmGraduationKeeperPass({ db, chainId, reader: fresh, sender, cfg, send: true });
    const step = pass.steps.find((s: any) => s.campaign === addr);
    expect(step.decision.kind).to.eq("send");
    expect(step.decision.reason).to.eq("due, not pending");
    expect(await campaign.launched()).to.eq(true);
  });

  it("a trading campaign short of its target is simulated only as a due candidate and answers idle (GraduationNotDue)", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(1));
    const addr = (await campaign.getAddress()).toLowerCase();
    const provider = ethers.provider as any;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const w = ethers.Wallet.createRandom();
    const reader = keeper.createEthersKeeperReader(provider, chainId, w.address, {});
    const cfg = { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 2 };
    const d = await keeper.decideKeeperStep(reader, addr, cfg, { dueCandidate: true });
    expect(d.kind).to.eq("idle");
    expect(d.reason).to.eq("not due (GraduationNotDue)");
    const due = await reader.dueInputs(addr);
    expect(keeper.isLikelyDue({ netRaisedWei: await campaign.netRaisedWei(), soldRaw: await campaign.sold(), curveSupply: due.curveSupply, nativeTarget: due.nativeTarget, slackBps: 200 })).to.eq(false);
  });
});

// Contract sizes (EIP-170, hook target <= 21,500 bytes) and a local gas table for every gen-8 money path.
// Local numbers come from a v4-core 1.0.2 PoolManager built here; the fork suite measures the canonical deployments.
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { ethers, artifacts } from "hardhat";
import { deployGen8, launch, trade, mineAt, now, graduate, slot0, Env, Pool } from "./fixtures/gen8";
import { WAD } from "./fixtures/v4math";

const PRODUCTION = [
  "MwzLaunchHook", "MwzSwapSim", "MwzLaunchLens", "MwzV4Launcher", "MwzV4Token", "MwzReserveLock", "MwzCreatorEscrow", "MwzFeeSplitter",
  "MwzCreatorChoiceVault", "MwzDisplayPair", "MwzDisplayPairFactory",
];

describe("gen8 sizes and gas", function () {
  it("every production contract fits EIP-170; the hook is at most 21,500 bytes", async () => {
    const rows: Record<string, { runtime: number; initcode: number }> = {};
    for (const n of PRODUCTION) {
      const a = await artifacts.readArtifact(n);
      rows[n] = { runtime: (a.deployedBytecode.length - 2) / 2, initcode: (a.bytecode.length - 2) / 2 };
      expect(rows[n].runtime, n).to.be.lte(24_576);
      expect(rows[n].initcode, n).to.be.lte(49_152);
    }
    expect(rows.MwzLaunchHook.runtime).to.be.lte(21_500);
    console.table(rows);
    write("sizes", rows);
  });

  it("gas table (local PoolManager)", async () => {
    const g: Record<string, number> = {};
    const rec = (k: string, rc: any) => (g[k] = Number(rc.gasUsed));
    for (const display of [true, false]) {
      const tag = display ? "bnb" : "rh";
      const env = await deployGen8({ display });
      const a = await launch(env, env.creator, { firstBuyValue: 0n });
      rec(`launch ${tag}, no first buy`, a.rc);
      const b = await launch(env, env.creator2, { firstBuyValue: WAD });
      rec(`launch ${tag}, with first buy`, b.rc);
      const c = await launch(env, env.creator, { firstBuyValue: WAD, feeChoice: 3, feeCreatorPct: 50 });
      rec(`launch ${tag}, split choice + first buy`, c.rc);
      const P = b.P;
      await mineAt(P.launchTs + 61n);
      const R = (await env.lens.progress(P.id)).nativeTargetA;
      // warm up both directions
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n });
      await trade(env, P, { wallet: env.bot, buy: false, exactIn: true, amount: 1_000n * WAD });
      for (const phase of ["bonding", "post-grad"]) {
        if (phase === "post-grad") await graduate(env, P, env.bot);
        g[`${tag} ${phase} buy exactIn`] = Number((await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n })).gas);
        g[`${tag} ${phase} buy exactOut`] = Number((await trade(env, P, { wallet: env.bot, buy: true, exactIn: false, amount: 1_000_000n * WAD, limit: R })).gas);
        g[`${tag} ${phase} sell exactIn`] = Number((await trade(env, P, { wallet: env.bot, buy: false, exactIn: true, amount: 1_000_000n * WAD })).gas);
        g[`${tag} ${phase} sell exactOut`] = Number((await trade(env, P, { wallet: env.bot, buy: false, exactIn: false, amount: WAD / 100n, limit: 10n ** 30n })).gas);
        const s = await slot0(env, P);
        g[`${tag} ${phase} buy exactIn with price limit (library replay)`] = Number(
          (await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: 10n * WAD, sqrtLimit: s.sqrtP - s.sqrtP / 1000n })).gas,
        );
      }
      // graduation crossing on a fresh coin
      const d = await launch(env, env.creator, { firstBuyValue: WAD / 10n });
      await mineAt(d.P.launchTs + 61n);
      g[`${tag} crossing buy (graduates)`] = Number((await graduate(env, d.P, env.bot)).gas);
      // hookless twin pool for the per-swap overhead
      const plainTok = await (await ethers.getContractFactory("MwzV4Token")).deploy("Plain", "PLN", 10n ** 27n, await (await ethers.getContractFactory("V4PlainSeeder")).deploy(await env.pm.getAddress()).then(async (sd) => { (env as any).seeder = sd; return sd.getAddress(); }));
      const seeder = (env as any).seeder;
      await (await seeder.seed(await plainTok.getAddress(), 10, P.tickStart, P.tickGrad, 850_000_000n * WAD, 130_000_000n * WAD)).wait();
      const plainKey: Pool["key"] = [ethers.ZeroAddress, await plainTok.getAddress(), 0, 10, ethers.ZeroAddress];
      const plain = { key: plainKey, id: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], plainKey)), token: await plainTok.getAddress(), coin: plainTok } as any as Pool;
      await trade(env, plain, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n });
      await trade(env, plain, { wallet: env.bot, buy: false, exactIn: true, amount: 1_000n * WAD });
      g[`${tag} hookless twin buy exactIn`] = Number((await trade(env, plain, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n })).gas);
      g[`${tag} hookless twin sell exactIn`] = Number((await trade(env, plain, { wallet: env.bot, buy: false, exactIn: true, amount: 1_000_000n * WAD })).gas);
      // claims and periphery
      rec(`${tag} claimCreator`, await (await env.hook.connect(env.creator2).claimCreator(P.id, env.payee.address)).wait());
      rec(`${tag} claimRouter`, await (await env.hook.claimRouter()).wait());
      if (display) {
        const [, B, G] = await env.splitter.pending();
        const [, , rsaMin, , squadMax] = await env.splitter.bands(B, G);
        rec("splitter route (all six destinations)", await (await env.splitter.connect(env.operator).route(1, rsaMin - squadMax - 1n, squadMax, 1n, ethers.id("r"))).wait());
        await trade(env, c.P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
        rec("choice vault pull", await (await env.vault.pull(c.P.id)).wait());
        rec("escrow buy", await (await env.escrow.connect(env.creator).buy(P.token, 0n, { value: WAD })).wait());
        await mineAt((await now()) + 30n * 86400n);
        rec("escrow claim", await (await env.escrow.connect(env.creator).claim(P.token)).wait());
        rec("reserve release", await (await env.reserveLock.release(P.id)).wait());
        await (await env.feed.set(600n * 10n ** 8n, await now())).wait(); // keep the oracle fresh after the 30-day jump
        const e = await launch(env, env.creator, { feeChoice: 4, firstBuyValue: WAD });
        await mineAt(e.P.launchTs + 61n);
        for (let i = 0; i < 3; i++) await trade(env, e.P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
        await (await env.vault.pull(e.P.id)).wait();
        rec("choice vault buyback (impact-limited V4 swap)", await (await env.vault.connect(env.operator).buyback(e.P.id, (await env.vault.buybackBalance(e.P.id)) / 2n)).wait());
      }
    }
    for (const tag of ["bnb", "rh"]) {
      g[`${tag} hook overhead buy exactIn (bonding)`] = g[`${tag} bonding buy exactIn`] - g[`${tag} hookless twin buy exactIn`];
      g[`${tag} hook overhead sell exactIn (bonding)`] = g[`${tag} bonding sell exactIn`] - g[`${tag} hookless twin sell exactIn`];
    }
    console.table(g);
    write("gas", g);
  });
});

function write(name: string, data: unknown) {
  const dir = path.join(__dirname, "..", "..", "reports", "gen8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `local-${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

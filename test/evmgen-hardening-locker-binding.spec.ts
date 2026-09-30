import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { deployEvmGen } from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

/**
 * The factory no longer creates its locker. The locker is deployed first with its immutable `admin`
 * set to the factory's CREATE address, and the factory constructor refuses anything else. These
 * tests pin the binding (only this factory can ever register on the locker) and the size headroom
 * the change bought (EIP-3860 initcode limit 49,152; EIP-170 runtime limit 24,576).
 */
const INITCODE_LIMIT = 49_152;
const INITCODE_TARGET = 45_000;
const RUNTIME_LIMIT = 24_576;

function sizes(name: string) {
  const a = JSON.parse(fs.readFileSync(path.join(process.cwd(), "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8"));
  return { initcode: (a.bytecode.length - 2) / 2, runtime: (a.deployedBytecode.length - 2) / 2 };
}

async function v3Stack() {
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3Factory.getAddress(), await weth.getAddress());
  const swap = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3Factory.getAddress(), await weth.getAddress());
  await v3Factory.configurePeriphery(await npm.getAddress(), await swap.getAddress());
  const adapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(
    await v3Factory.getAddress(),
    await npm.getAddress(),
    await weth.getAddress(),
    3000,
  );
  return { adapter };
}

async function nextAddresses() {
  const [signer] = await ethers.getSigners();
  const from = await signer.getAddress();
  const nonce = await ethers.provider.getTransactionCount(from, "pending");
  return { from, nonce, at: (k: number) => ethers.getCreateAddress({ from, nonce: nonce + k }) };
}

describe("EVM generation hardening: factory/locker binding and initcode headroom", function () {
  it("keeps both factories' initcode <= 45,000 bytes and runtime under EIP-170", function () {
    for (const name of ["LaunchFactory", "BnbBasicLaunchFactory"]) {
      const s = sizes(name);
      console.log(`      ${name}: initcode ${s.initcode} / ${INITCODE_LIMIT}, runtime ${s.runtime} / ${RUNTIME_LIMIT}`);
      expect(s.initcode, `${name} initcode`).to.be.lte(INITCODE_TARGET);
      expect(s.runtime, `${name} runtime`).to.be.lt(RUNTIME_LIMIT);
    }
    for (const name of ["PermanentLpLocker", "PermanentV3PositionLocker"]) {
      const s = sizes(name);
      expect(s.initcode, `${name} initcode`).to.be.lt(INITCODE_LIMIT);
      expect(s.runtime, `${name} runtime`).to.be.lt(RUNTIME_LIMIT);
    }
  });

  it("binds the V2 locker: admin is the factory, revenue configured, nobody else can configure or register", async function () {
    const env = await deployEvmGen();
    const factoryAddress = await env.factory.getAddress();
    expect(await env.locker.admin()).to.equal(factoryAddress);
    expect(await env.locker.treasuryRouter()).to.equal(await env.evmRouter.getAddress());
    expect(await env.locker.topazFactory()).to.equal(await env.topazFactory.getAddress());

    const [owner, , attacker] = await ethers.getSigners();
    for (const who of [owner, attacker]) {
      await expect(env.locker.connect(who).configureRevenue(await env.evmRouter.getAddress(), await env.topazFactory.getAddress()))
        .to.be.revertedWithCustomError(env.locker, "OnlyAdmin");
      await expect(
        env.locker.connect(who).registerGraduatedPool(who.address, who.address, who.address, who.address, who.address, who.address, 1n),
      ).to.be.revertedWithCustomError(env.locker, "OnlyAdmin");
      await expect(env.locker.connect(who).registerLpToken(who.address)).to.be.revertedWithCustomError(env.locker, "OnlyAdmin");
    }
  });

  it("binds the V3 locker to a Robinhood factory the same way", async function () {
    const env = await deployEvmGen();
    const { adapter } = await v3Stack();
    const { factory, lockerAddress, lockerKind } = await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await adapter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress()],
    });
    expect(lockerKind).to.equal("v3");
    expect(await factory.liquidityKind()).to.equal(2n);
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress);
    expect(await locker.admin()).to.equal(await factory.getAddress());
    expect(await locker.integrationSource()).to.equal(await adapter.getAddress());
    const [, , attacker] = await ethers.getSigners();
    await expect(locker.connect(attacker).configureRevenue(await env.evmRouter.getAddress(), await adapter.getAddress()))
      .to.be.revertedWithCustomError(locker, "OnlyAdmin");
    await expect(locker.connect(attacker).setIntegrationSourceAuthorized(attacker.address, true))
      .to.be.revertedWithCustomError(locker, "OnlyAdmin");
  });

  it("refuses a locker without code, one bound to another admin, and one of the wrong kind", async function () {
    const env = await deployEvmGen();
    const Factory = await ethers.getContractFactory("LaunchFactory");
    const base = [await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress()];
    const [owner] = await ethers.getSigners();

    await expect(Factory.deploy(...base, owner.address)).to.be.revertedWithCustomError(Factory, "ContractCodeMissing");

    // A locker whose admin is somebody else (here: the deployer EOA) -- the squatting / mix-up case.
    const foreign = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
    await expect(Factory.deploy(...base, await foreign.getAddress())).to.be.revertedWithCustomError(Factory, "LockerNotBoundToFactory");

    // Another factory's locker: already bound to that factory, refused here.
    await expect(Factory.deploy(...base, await env.locker.getAddress())).to.be.revertedWithCustomError(Factory, "LockerNotBoundToFactory");

    // V3 locker bound to the right address, but the router is Topaz V2: the V2-only kind probe reverts.
    {
      const n = await nextAddresses();
      const v3Locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(n.at(1));
      await expect(Factory.deploy(...base, await v3Locker.getAddress())).to.be.reverted;
    }
    // V2 locker bound to the right address, but the router is a V3 adapter: the V3-only kind probe reverts.
    {
      const { adapter } = await v3Stack();
      const n = await nextAddresses();
      const v2Locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(n.at(1));
      await expect(
        Factory.deploy(await adapter.getAddress(), base[1], base[2], base[3], await v2Locker.getAddress()),
      ).to.be.reverted;
    }
  });

  it("BnbBasicLaunchFactory takes the same bound locker as its last argument", async function () {
    const env = await deployEvmGen();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
    const { factory, lockerAddress } = await deployFactoryWithLocker({
      factoryName: "BnbBasicLaunchFactory",
      args: [await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await quoteImpl.getAddress()],
    });
    expect(await factory.permanentLpLocker()).to.equal(lockerAddress);
    const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress);
    expect(await locker.admin()).to.equal(await factory.getAddress());

    const Basic = await ethers.getContractFactory("BnbBasicLaunchFactory");
    const [owner] = await ethers.getSigners();
    const foreign = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
    await expect(
      Basic.deploy(await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await quoteImpl.getAddress(), await foreign.getAddress()),
    ).to.be.revertedWithCustomError(Basic, "LockerNotBoundToFactory");
  });
});

describe("EVM generation hardening: V3 impact bound is on the bought token in both orientations", function () {
  it("zeroForOne and oneForZero both let the bought token's price rise by at most maxImpactBps, and not by much less", async function () {
    const harness = await (await ethers.getContractFactory("EvmGenPoolSwapHarness")).deploy();
    const a = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const b = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await a.getAddress(), await b.getAddress(), 3000);
    const [owner] = await ethers.getSigners();
    const Q96 = 2n ** 96n;
    for (const sqrtP of [Q96, (Q96 * 1000n) / 31n, Q96 / 1000n, Q96 * 1000n]) {
      await pool.setup(owner.address, sqrtP, 10n ** 18n);
      for (const impact of [1n, 50n]) {
        const S = 10n ** 12n;
        // zeroForOne buys token1 (price 1/p): rise = sqrtP^2 / limit^2
        const [ok0, l0] = await harness.v3Limit(await pool.getAddress(), true, impact);
        expect(ok0).to.equal(true);
        const rise0 = (sqrtP * sqrtP * S) / (l0 * l0);
        expect(rise0).to.be.lte(S + (S * impact) / 10_000n);
        expect(rise0).to.be.gte(S + (S * impact) / 10_000n - S / 10n ** 7n);
        // oneForZero buys token0 (price p): rise = limit^2 / sqrtP^2
        const [ok1, l1] = await harness.v3Limit(await pool.getAddress(), false, impact);
        expect(ok1).to.equal(true);
        const rise1 = (l1 * l1 * S) / (sqrtP * sqrtP);
        expect(rise1).to.be.lte(S + (S * impact) / 10_000n);
        expect(rise1).to.be.gte(S + (S * impact) / 10_000n - S / 10n ** 7n);
      }
    }
  });
});

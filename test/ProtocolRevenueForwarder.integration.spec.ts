import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { createCoin, req, buyNative, sellTokens, mineAt, now, E } from "./fixtures/evmgenCore";
import { installRealV3, RH_V3 } from "./helpers/evmgenRhRealV3";
import { installRealWbnb } from "./helpers/realWbnb";

// ProtocolRevenueForwarder with the real TreasuryRouterV4, the real ProtocolRevenueVault (operator fill +
// overflow), the real CreatorRewardsVaultV2, the real LaunchFactory / LaunchCampaign (gen 6/5) and both real
// locker types, on the plain hardhat network:
//   BNB  - PermanentLpLocker, real WBNB (WETH9) bytecode, Topaz V2 test doubles (MockGraduationAdapterEvmGen).
//   RH   - PermanentV3PositionLocker, real Uniswap V3 factory / NPM / SwapRouter02 bytecode (4663),
//          RobinhoodV3NativeGraduationAdapterV2; WETH at its canonical address is MockWETH9 (full-gas payout,
//          like Robinhood's aeWETH).
// The same create / buy / sell / graduate / harvest scenario runs twice from one EVM snapshot: once with the
// router's protocol vault = the ProtocolRevenueVault (today), once after propose -> 1 h -> accept of the
// forwarder. Every destination must receive exactly the same native amounts; the only difference is the LP
// protocol 20%: before it lands in the vault as wrapped native (stuck: the vault has no token path), after it
// lands in the forwarder and flush() delivers it to the operator / overflow exactly.

const WAD = 10n ** 18n;
const CAP_USD = 5n * WAD; // small, so the scenario crosses from operator fill into overflow

type Kind = "bnb" | "rh";

async function deployStack(kind: Kind) {
  const signers = await ethers.getSigners();
  const [owner, creator, alice, bob, authority, carol] = signers;
  const operator = signers[7];
  const overflow = signers[8];
  const forwarderDeployer = signers[9];
  const trader = signers[10];

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const router: any = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const vault: any = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(owner.address);
  const nativeUsd = kind === "bnb" ? 600n : 2694n;
  await vault.setOperatorFill(operator.address, overflow.address, CAP_USD, nativeUsd * WAD);

  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = await now();
  await feed.setRoundData(1, nativeUsd * 10n ** 8n, t, t, 1);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);
  const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();

  let wrapped: any;
  let dexFactory: string;
  let dexRouterArg: string;
  let adapter: any;
  let topazFactory: any = null;
  if (kind === "bnb") {
    wrapped = await installRealWbnb();
    topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wrapped.getAddress());
    dexFactory = await topazFactory.getAddress();
    dexRouterArg = await topazRouter.getAddress();
    adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(dexFactory, await wrapped.getAddress());
  } else {
    const v3 = await installRealV3();
    wrapped = v3.weth;
    dexFactory = RH_V3.v3Factory;
    adapter = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth, owner.address);
    dexRouterArg = await adapter.getAddress();
  }

  const creatorVault: any = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
    owner.address,
    await router.getAddress(),
    await wrapped.getAddress(),
    kind === "bnb" ? 1 : 2,
    dexFactory,
    86400,
  );
  await router.setRecruiterRewardsVault(await recruiter.getAddress());
  await router.setCommunityRewardsVault(await community.getAddress());
  await router.setProtocolRevenueVault(await vault.getAddress());
  await router.setCreatorRewardsVault(await creatorVault.getAddress());

  const { factory } = await deployFactoryWithLocker({
    factoryName: "LaunchFactory",
    args: [dexRouterArg, await router.getAddress(), await impl.getAddress(), await oracle.getAddress()],
    lockerKind: kind === "bnb" ? "v2" : "v3",
  });
  const f: any = factory;
  const locker: any = await ethers.getContractAt(kind === "bnb" ? "PermanentLpLocker" : "PermanentV3PositionLocker", await f.permanentLpLocker());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await router.setPrimaryLpLocker(await locker.getAddress());
  await creatorVault.setFactoryOnce(await f.getAddress());
  if (kind === "bnb") await adapter.setLocker(await locker.getAddress());
  await f.setNativeGraduationAdapter(await adapter.getAddress());
  await f.setLaunchTokenDeployer(await tokenDeployer.getAddress());
  await f.setRouteAuthority(authority.address);
  await f.enableLive();
  if (kind === "rh") await adapter.setCampaignFactoryOnce(await f.getAddress());

  return { kind, owner, creator, alice, bob, carol, authority, operator, overflow, forwarderDeployer, trader, weekly, monthly, recruiter, community, router, vault, creatorVault, factory: f, locker, wrapped, adapter, topazFactory };
}

type Stack = Awaited<ReturnType<typeof deployStack>>;

async function snapshotBalances(s: Stack, forwarder: string | null) {
  const b = (a: any) => ethers.provider.getBalance(a);
  const addr = async (c: any) => c.getAddress();
  const r: Record<string, bigint> = {
    weekly: await b(await addr(s.weekly)),
    monthly: await b(await addr(s.monthly)),
    recruiter: await b(await addr(s.recruiter)),
    community: await b(await addr(s.community)),
    creatorVault: await b(await addr(s.creatorVault)),
    protocolVaultNative: await b(await addr(s.vault)),
    operator: await b(s.operator.address),
    overflow: await b(s.overflow.address),
    vaultWrapped: await s.wrapped.balanceOf(await addr(s.vault)),
    operatorFilledUsd: await s.vault.operatorFilledUsd(),
  };
  if (forwarder) {
    r.forwarderNative = await b(forwarder);
    r.forwarderWrapped = await s.wrapped.balanceOf(forwarder);
  }
  return r;
}

function diff(a: Record<string, bigint>, b: Record<string, bigint>) {
  const out: Record<string, bigint> = {};
  for (const k of Object.keys(b)) out[k] = b[k] - (a[k] ?? 0n);
  return out;
}

function parse(contract: any, rc: any, name: string) {
  return rc.logs
    .map((l: any) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e: any) => e && e.name === name);
}

/** create (with a creator first buy) -> buy -> sell -> buy to the target -> graduate -> DEX trade -> harvest. */
async function scenario(s: Stack, forwarder: string | null) {
  const steps: Record<string, Record<string, bigint>> = {};
  const gas: Record<string, bigint> = {};
  const routed: Record<string, bigint[]> = {};
  let before = await snapshotBalances(s, forwarder);
  const step = async (name: string, fn: () => Promise<any>) => {
    const tx = await fn();
    const rc = await tx.wait();
    gas[name] = rc.gasUsed;
    routed[name] = parse(s.router, rc, "RouteExecuted").map((e: any) => e.args.protocolAmount as bigint);
    const after = await snapshotBalances(s, forwarder);
    steps[name] = diff(before, after);
    before = after;
    return rc;
  };

  const firstBuyTokens = E(10_000_000);
  const r = req({ graduationTarget: E(30_000), firstBuyTokens, firstBuyMaxCost: E(1) });
  let created: any;
  await step("create", async () => {
    created = await createCoin(s as any, r, { value: E(1) });
    return created.tx;
  });
  const { campaign, token } = created;
  await mineAt(Number(await campaign.launchAt()) + 120);
  await step("buy", () => buyNative(s as any, campaign, s.alice, E(1)));
  const bought: bigint = await token.balanceOf(s.alice.address);
  await step("sell", () => sellTokens(s as any, campaign, token, s.alice, bought / 2n));
  for (let i = 0; i < 40 && !(await campaign.graduationPending()); i++) {
    await step(`grow${i}`, () => buyNative(s as any, campaign, s.bob, E(s.kind === "bnb" ? 10 : 2)));
  }
  expect(await campaign.graduationPending()).to.equal(true);
  await step("graduate", () => campaign.connect(s.carol).graduate());
  const pool = (await campaign.getGraduationState()).dexPair as string;

  // LP fees accrue to the locked position.
  if (s.kind === "bnb") {
    const p: any = await ethers.getContractAt("MockTopazPool", pool);
    const feeWrapped = E(0.4);
    await s.wrapped.connect(s.trader).deposit({ value: feeWrapped });
    await s.wrapped.connect(s.trader).approve(pool, feeWrapped);
    const tokenIs0 = (await p.token0()).toLowerCase() === (await token.getAddress()).toLowerCase();
    await p.connect(s.trader).fundFees(await s.locker.getAddress(), tokenIs0 ? 0n : feeWrapped, tokenIs0 ? feeWrapped : 0n);
  } else {
    const swapIn = E(1);
    await s.wrapped.connect(s.trader).deposit({ value: swapIn });
    await s.wrapped.connect(s.trader).approve(RH_V3.swapRouter02, swapIn);
    const swap = await ethers.getContractAt(
      ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
      RH_V3.swapRouter02,
    );
    await (swap.connect(s.trader) as any).exactInputSingle({ tokenIn: RH_V3.weth, tokenOut: await token.getAddress(), fee: 3000, recipient: s.trader.address, amountIn: swapIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0 });
  }
  const harvestRc = await step("harvest", () => s.locker.connect(s.trader).harvest(pool));
  const harvested = parse(s.locker, harvestRc, "FeesHarvested").filter((e: any) => e.args.token.toLowerCase() === RH_V3.weth.toLowerCase() || e.args.token.toLowerCase() === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
  expect(harvested.length).to.equal(1);
  const protocolLp: bigint = harvested[0].args.protocolRouted;
  expect(protocolLp).to.be.gt(0n);
  expect(harvested[0].args.creatorPaid + protocolLp).to.equal(harvested[0].args.collected);
  return { steps, gas, routed, protocolLp, campaign, token, pool };
}

async function switchToForwarder(s: Stack) {
  const fwd: any = await (await ethers.getContractFactory("ProtocolRevenueForwarder", s.forwarderDeployer)).deploy(s.owner.address, await s.vault.getAddress(), await s.wrapped.getAddress());
  const addr = await fwd.getAddress();
  // S1 / S2 exactly as the Safe batches do it.
  await expect(s.router.connect(s.owner).proposeProtocolRevenueVault(addr)).to.emit(s.router, "ProtocolRevenueVaultProposed");
  await expect(s.router.connect(s.owner).acceptProtocolRevenueVault()).to.be.revertedWith("delay");
  await network.provider.send("evm_increaseTime", [3600]);
  await network.provider.send("evm_mine");
  await expect(s.router.connect(s.owner).acceptProtocolRevenueVault())
    .to.emit(s.router, "ProtocolRevenueVaultUpdated")
    .withArgs(await s.vault.getAddress(), addr);
  expect(await s.router.protocolRevenueVault()).to.equal(addr);
  expect(await s.router.pendingProtocolRevenueVault()).to.equal(ethers.ZeroAddress);
  return fwd;
}

const report: any = {};

for (const kind of ["bnb", "rh"] as Kind[]) {
  describe(`ProtocolRevenueForwarder integration (${kind === "bnb" ? "BNB: PermanentLpLocker, real WBNB" : "Robinhood: PermanentV3PositionLocker, real Uniswap V3"})`, function () {
    this.timeout(600_000);

    it("before/after the switch: identical splits for every destination; LP 20% stuck before, delivered after flush", async function () {
      const s = await deployStack(kind);
      const snap = await network.provider.send("evm_snapshot");

      // A: today. Same 1 h of elapsed time as the switch, so nothing time-dependent differs.
      await network.provider.send("evm_increaseTime", [3601]);
      await network.provider.send("evm_mine");
      const A = await scenario(s, null);
      const vaultWrappedA: bigint = await s.wrapped.balanceOf(await s.vault.getAddress());
      // The bug being fixed: the LP protocol share sits in the vault as wrapped native and the vault has no
      // function that can move an ERC20.
      expect(vaultWrappedA).to.equal(A.protocolLp);
      expect(s.vault.interface.fragments.filter((x: any) => x.type === "function" && /token|erc20|sweep|rescue/i.test(x.name))).to.deep.equal([]);

      await network.provider.send("evm_revert", [snap]);

      // B: after S1 -> 1 h -> S2.
      const fwd = await switchToForwarder(s);
      const fwdAddr = await fwd.getAddress();
      const B = await scenario(s, fwdAddr);

      // Every step, every destination: identical native amounts. The vault's own native balance does not
      // move in either run (the vault forwards everything to operator / overflow in the same call).
      const keys = ["weekly", "monthly", "recruiter", "community", "creatorVault", "protocolVaultNative", "operator", "overflow", "operatorFilledUsd"];
      expect(Object.keys(B.steps)).to.deep.equal(Object.keys(A.steps));
      for (const name of Object.keys(A.steps)) {
        for (const k of keys) {
          const operatorOrOverflowOnHarvest = name === "harvest";
          if (operatorOrOverflowOnHarvest && (k === "operator" || k === "overflow" || k === "operatorFilledUsd")) continue;
          expect(B.steps[name][k], `${name}.${k}`).to.equal(A.steps[name][k]);
        }
        expect(B.routed[name], `${name}.RouteExecuted.protocolAmount`).to.deep.equal(A.routed[name]);
        expect(B.steps[name].forwarderNative, `${name}: forwarder keeps no native`).to.equal(0n);
      }
      // The trade and finalize protocol shares reached operator + overflow in both runs, through the forwarder in B.
      const routedTotal = Object.values(A.routed).flat().reduce((x, y) => x + y, 0n);
      const sum = (r: any, k: string) => Object.entries(r.steps).filter(([n]) => n !== "harvest").reduce((x: bigint, [, v]: any) => x + v[k], 0n);
      expect(sum(A, "operator") + sum(A, "overflow")).to.equal(routedTotal);
      expect(sum(B, "operator") + sum(B, "overflow")).to.equal(routedTotal);
      expect(await s.vault.operatorFilledUsd()).to.equal(CAP_USD); // the scenario crossed into overflow

      // Harvest in B: the LP protocol 20% is in the forwarder, not in the vault.
      expect(B.protocolLp).to.equal(A.protocolLp);
      expect(B.steps.harvest.forwarderWrapped).to.equal(B.protocolLp);
      expect(B.steps.harvest.vaultWrapped).to.equal(0n);
      expect(B.steps.harvest.operator).to.equal(0n);
      expect(B.steps.harvest.overflow).to.equal(0n);

      // flush (anyone): exact amount to the vault, which forwards it to the overflow (operator cap is full).
      const op0 = await ethers.provider.getBalance(s.operator.address);
      const ov0 = await ethers.provider.getBalance(s.overflow.address);
      const flushRc = await (await fwd.connect(s.carol).flush()).wait();
      const flushed = parse(fwd, flushRc, "Flushed")[0];
      expect(flushed.args.unwrapped).to.equal(B.protocolLp);
      expect(flushed.args.forwarded).to.equal(B.protocolLp);
      const deposit = parse(s.vault, flushRc, "Deposit")[0];
      expect(deposit.args.from).to.equal(fwdAddr);
      expect(deposit.args.amount).to.equal(B.protocolLp);
      expect((await ethers.provider.getBalance(s.operator.address)) - op0).to.equal(0n);
      expect((await ethers.provider.getBalance(s.overflow.address)) - ov0).to.equal(B.protocolLp);
      expect(await s.wrapped.balanceOf(fwdAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(fwdAddr)).to.equal(0n);
      expect(await s.wrapped.balanceOf(await s.vault.getAddress())).to.equal(0n);

      report[kind] = {
        buy: { before: A.gas.buy, after: B.gas.buy, delta: B.gas.buy - A.gas.buy },
        sell: { before: A.gas.sell, after: B.gas.sell, delta: B.gas.sell - A.gas.sell },
        create: { before: A.gas.create, after: B.gas.create, delta: B.gas.create - A.gas.create },
        graduate: { before: A.gas.graduate, after: B.gas.graduate, delta: B.gas.graduate - A.gas.graduate },
        harvest: { before: A.gas.harvest, after: B.gas.harvest, delta: B.gas.harvest - A.gas.harvest },
        flush: flushRc.gasUsed,
      };
      console.log(`        gas (${kind}): ${JSON.stringify(report[kind], (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      // One extra CALL with value per routed protocol share: bounded, and never on the harvest path's caller.
      expect(report[kind].buy.delta).to.be.gt(0n);
      expect(report[kind].buy.delta).to.be.lt(20_000n);
      expect(report[kind].sell.delta).to.be.lt(20_000n);
    });

    it("operator fill below the cap: flush pays the operator first, then overflow, exactly as a trade fee would", async function () {
      const s = await deployStack(kind);
      const fwd = await switchToForwarder(s);
      const fwdAddr = await fwd.getAddress();
      // Fresh vault accounting: cap $5. Put 0.01 native of wrapped into the forwarder the way routeLpToken does
      // (impersonating the authorized locker through the router).
      const amount = E(0.01);
      const lockerAddr = await s.locker.getAddress();
      await network.provider.send("hardhat_impersonateAccount", [lockerAddr]);
      await network.provider.send("hardhat_setBalance", [lockerAddr, ethers.toQuantity(E(1))]);
      const lockerSigner = await ethers.getSigner(lockerAddr);
      await s.wrapped.connect(lockerSigner).deposit({ value: amount });
      await s.wrapped.connect(lockerSigner).approve(await s.router.getAddress(), amount);
      await expect(s.router.connect(lockerSigner).routeLpToken(await s.wrapped.getAddress(), amount))
        .to.emit(s.router, "LpTokenRouted")
        .withArgs(lockerAddr, await s.wrapped.getAddress(), fwdAddr, amount);
      await network.provider.send("hardhat_stopImpersonatingAccount", [lockerAddr]);

      const price = await s.vault.nativeUsdPrice();
      const usd = (amount * price) / WAD;
      const toOperator = usd <= CAP_USD ? amount : (amount * CAP_USD) / usd;
      const op0 = await ethers.provider.getBalance(s.operator.address);
      const ov0 = await ethers.provider.getBalance(s.overflow.address);
      await fwd.flush();
      expect((await ethers.provider.getBalance(s.operator.address)) - op0).to.equal(toOperator);
      expect((await ethers.provider.getBalance(s.overflow.address)) - ov0).to.equal(amount - toOperator);
      expect(toOperator).to.be.gt(0n);
      expect(amount - toOperator).to.be.gt(0n); // $6 (BNB) / $26.94 (RH) > $5 cap: both branches exercised
    });

    it("rollback: propose the old vault -> 1 h -> accept restores today's routing; the forwarder keeps nothing", async function () {
      const s = await deployStack(kind);
      const fwd = await switchToForwarder(s);
      await s.router.connect(s.owner).proposeProtocolRevenueVault(await s.vault.getAddress());
      // During the delay the forwarder stays live: routing never pauses.
      expect(await s.router.protocolRevenueVault()).to.equal(await fwd.getAddress());
      await network.provider.send("evm_increaseTime", [3600]);
      await network.provider.send("evm_mine");
      await s.router.connect(s.owner).acceptProtocolRevenueVault();
      expect(await s.router.protocolRevenueVault()).to.equal(await s.vault.getAddress());
      expect(await ethers.provider.getBalance(await fwd.getAddress())).to.equal(0n);
    });
  });
}

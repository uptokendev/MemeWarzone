import { expect } from "chai";
import { ethers, network } from "hardhat";

// CO-IMP (docs/evm-launch/CO-IMPORT-SWAP-FEE.md): 1% on the native side of every import swap, 0.50% protocol /
// 0.50% creator receiver, rounding to the protocol, min-out on what the trader actually gets.
const E = (v: string | number) => ethers.parseEther(String(v));
const RATE = E(1_000_000); // 1,000,000 tokens per native
const P_BPS = 50n;
const C_BPS = 50n;

async function deadline(s = 600) {
  const b = await ethers.provider.getBlock("latest");
  return Number(b!.timestamp) + s;
}

function split(x: bigint, p = P_BPS, c = C_BPS) {
  const fee = (x * (p + c)) / 10_000n;
  const creator = (x * c) / 10_000n;
  return { fee, creator, protocol: fee - creator };
}

async function deploy(opts: { fotBps?: number; p?: bigint; c?: bigint } = {}) {
  const [deployer, trader, protocol, creator, other] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const token = opts.fotBps
    ? await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(opts.fotBps)
    : await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(0);
  const factoryAddr = ethers.Wallet.createRandom().address;
  const v2 = await (await ethers.getContractFactory("MockImportV2Router")).deploy(await weth.getAddress(), factoryAddr, RATE);
  const v3 = await (await ethers.getContractFactory("MockImportV3Router")).deploy(await weth.getAddress(), RATE);
  const router = await (await ethers.getContractFactory("ImportSwapFeeRouter")).deploy(
    await weth.getAddress(), protocol.address, creator.address, opts.p ?? P_BPS, opts.c ?? C_BPS, await v3.getAddress(), await v2.getAddress(),
  );
  // Venue liquidity: tokens for buys, native / wrapped for sells; the trader holds tokens to sell.
  await token.mint(await v2.getAddress(), E(1e12));
  await token.mint(await v3.getAddress(), E(1e12));
  await token.mint(trader.address, E(1e9));
  await deployer.sendTransaction({ to: await v2.getAddress(), value: E(50) });
  await v3.fundWrapped({ value: E(50) });
  return { deployer, trader, protocol, creator, other, weth, token, v2, v3, router, factoryAddr };
}

type Env = Awaited<ReturnType<typeof deploy>>;

async function balances(env: Env, who: string) {
  return {
    protocol: await ethers.provider.getBalance(env.protocol.address),
    creator: await ethers.provider.getBalance(env.creator.address),
    tokens: await env.token.balanceOf(who),
    native: await ethers.provider.getBalance(who),
  };
}

describe("CO-IMP ImportSwapFeeRouter", function () {
  describe("constructor (CI1)", () => {
    it("refuses zero receivers, a fee above 1%, a zero fee, no venue and a V2 router on another wrapped native", async () => {
      const env = await deploy();
      const F = await ethers.getContractFactory("ImportSwapFeeRouter");
      const w = await env.weth.getAddress();
      const v2 = await env.v2.getAddress();
      const v3 = await env.v3.getAddress();
      const z = ethers.ZeroAddress;
      const p = env.protocol.address;
      const c = env.creator.address;
      await expect(F.deploy(z, p, c, 50, 50, v3, v2)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(w, z, c, 50, 50, v3, v2)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(w, p, z, 50, 50, v3, v2)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(w, p, c, 51, 50, v3, v2)).to.be.revertedWithCustomError(F, "FeeTooHigh");
      await expect(F.deploy(w, p, c, 0, 0, v3, v2)).to.be.revertedWithCustomError(F, "FeeZero");
      await expect(F.deploy(w, p, c, 50, 50, z, z)).to.be.revertedWithCustomError(F, "NoVenue");
      const otherWeth = await (await ethers.getContractFactory("MockWETH9")).deploy();
      await expect(F.deploy(await otherWeth.getAddress(), p, c, 50, 50, z, v2)).to.be.revertedWithCustomError(F, "WrappedNativeMismatch");
      const r = await F.deploy(w, p, c, 50, 50, v3, v2);
      expect(await r.v2Factory()).to.eq(env.factoryAddr);
      expect(await r.deployedChainId()).to.eq((await ethers.provider.getNetwork()).chainId);
    });

    it("a venue that is not configured refuses its calls", async () => {
      const env = await deploy();
      const F = await ethers.getContractFactory("ImportSwapFeeRouter");
      const onlyV3 = await F.deploy(await env.weth.getAddress(), env.protocol.address, env.creator.address, 50, 50, await env.v3.getAddress(), ethers.ZeroAddress);
      await expect(onlyV3.connect(env.trader).buyV2(await env.token.getAddress(), false, 1, env.trader.address, await deadline(), { value: E(1) }))
        .to.be.revertedWithCustomError(onlyV3, "VenueNotConfigured");
      expect(await onlyV3.v2Factory()).to.eq(ethers.ZeroAddress);
    });
  });

  for (const venue of ["V2", "V3"] as const) {
    describe(`${venue} buys (CI2)`, () => {
      it("takes 1% before the swap, 0.50% / 0.50% to the receivers, swaps the rest to the recipient, emits ImportSwap", async () => {
        const env = await deploy();
        const value = E("1.234567890123456789");
        const s = split(value);
        const before = await balances(env, env.other.address);
        const want = ((value - s.fee) * RATE) / E(1);
        const tx = venue === "V2"
          ? env.router.connect(env.trader).buyV2(await env.token.getAddress(), true, want, env.other.address, await deadline(), { value })
          : env.router.connect(env.trader).buyV3(await env.token.getAddress(), 3000, want, env.other.address, await deadline(), { value });
        await expect(tx).to.emit(env.router, "ImportSwap").withArgs(
          env.trader.address, await env.token.getAddress(), venue === "V2" ? 2 : 3, true, value, s.protocol, s.creator, want, env.other.address,
        );
        const after = await balances(env, env.other.address);
        expect(after.protocol - before.protocol).to.eq(s.protocol);
        expect(after.creator - before.creator).to.eq(s.creator);
        expect(after.tokens - before.tokens).to.eq(want);
        expect(await ethers.provider.getBalance(await env.router.getAddress())).to.eq(0n);
        expect(await env.weth.balanceOf(await env.router.getAddress())).to.eq(0n);
        if (venue === "V2") {
          expect(await env.v2.lastStable()).to.eq(true);
          expect(await env.v2.lastFactory()).to.eq(env.factoryAddr);
        } else {
          expect(await env.v3.lastFee()).to.eq(3000);
        }
      });

      it("min-out is checked on the recipient's delta: a 5% transfer-tax token passes at the taxed amount and fails one unit above", async () => {
        const env = await deploy({ fotBps: 500 });
        const value = E(1);
        const s = split(value);
        const gross = ((value - s.fee) * RATE) / E(1);
        const net = gross - (gross * 500n) / 10_000n;
        const buy = (min: bigint) => venue === "V2"
          ? env.router.connect(env.trader).buyV2(env.token, false, min, env.other.address, deadline(), { value })
          : env.router.connect(env.trader).buyV3(env.token, 3000, min, env.other.address, deadline(), { value });
        await expect(buy(net + 1n)).to.be.revertedWithCustomError(env.router, "InsufficientOutput");
        const before = await env.token.balanceOf(env.other.address);
        await buy(net);
        expect((await env.token.balanceOf(env.other.address)) - before).to.eq(net);
      });

      it("dust cannot trade fee-free; deadline, zero min, wrapped native, zero recipient and zero value are refused", async () => {
        const env = await deploy();
        const t = await env.token.getAddress();
        const w = await env.weth.getAddress();
        const call = (token: string, min: bigint, to: string, dl: number, value: bigint) => venue === "V2"
          ? env.router.connect(env.trader).buyV2(token, false, min, to, dl, { value })
          : env.router.connect(env.trader).buyV3(token, 3000, min, to, dl, { value });
        await expect(call(t, 1n, env.other.address, await deadline(), 99n)).to.be.revertedWithCustomError(env.router, "FeeZero");
        await expect(call(t, 1n, env.other.address, (await deadline()) - 700, E(1))).to.be.revertedWithCustomError(env.router, "DeadlineExpired");
        await expect(call(t, 0n, env.other.address, await deadline(), E(1))).to.be.revertedWithCustomError(env.router, "ZeroMinimumOut");
        await expect(call(w, 1n, env.other.address, await deadline(), E(1))).to.be.revertedWithCustomError(env.router, "InvalidToken");
        await expect(call(ethers.ZeroAddress, 1n, env.other.address, await deadline(), E(1))).to.be.revertedWithCustomError(env.router, "InvalidToken");
        await expect(call(t, 1n, ethers.ZeroAddress, await deadline(), E(1))).to.be.revertedWithCustomError(env.router, "ZeroAddress");
        await expect(call(t, 1n, env.other.address, await deadline(), 0n)).to.be.revertedWithCustomError(env.router, "ZeroInput");
        // 100 wei is the smallest buy with a fee (1 wei, to the protocol by rounding).
        const pBefore = await ethers.provider.getBalance(env.protocol.address);
        await call(t, 1n, env.other.address, await deadline(), 100n);
        expect((await ethers.provider.getBalance(env.protocol.address)) - pBefore).to.eq(1n);
      });
    });

    describe(`${venue} sells (CI3)`, () => {
      it("fee on the native the swap returned; min-out on the amount after fee; recipient paid, then the receivers", async () => {
        const env = await deploy();
        const amount = E(123_456);
        const gross = (amount * E(1)) / RATE;
        const s = split(gross);
        const net = gross - s.fee;
        await env.token.connect(env.trader).approve(env.router, amount);
        const sell = (min: bigint) => venue === "V2"
          ? env.router.connect(env.trader).sellV2(env.token, false, amount, min, env.other.address, deadline())
          : env.router.connect(env.trader).sellV3(env.token, 3000, amount, min, env.other.address, deadline());
        await expect(sell(net + 1n)).to.be.revertedWithCustomError(env.router, "InsufficientOutput");
        const before = await balances(env, env.other.address);
        await expect(sell(net)).to.emit(env.router, "ImportSwap").withArgs(
          env.trader.address, await env.token.getAddress(), venue === "V2" ? 2 : 3, false, gross, s.protocol, s.creator, amount, env.other.address,
        );
        const after = await balances(env, env.other.address);
        expect(after.native - before.native).to.eq(net);
        expect(after.protocol - before.protocol).to.eq(s.protocol);
        expect(after.creator - before.creator).to.eq(s.creator);
        expect(await env.token.balanceOf(env.router)).to.eq(0n);
        expect(await env.token.allowance(env.router, venue === "V2" ? env.v2 : env.v3)).to.eq(0n);
        expect(await ethers.provider.getBalance(env.router)).to.eq(0n);
        expect(await env.weth.balanceOf(env.router)).to.eq(0n);
      });

      it("a transfer-tax token sells what actually arrived, and the event says so", async () => {
        const env = await deploy({ fotBps: 500 });
        const amount = E(100_000);
        const received = amount - (amount * 500n) / 10_000n;
        // The venue receives `received` minus the tax again on its own pull.
        const atVenue = received - (received * 500n) / 10_000n;
        const gross = (atVenue * E(1)) / RATE;
        const s = split(gross);
        await env.token.connect(env.trader).approve(env.router, amount);
        const tx = venue === "V2"
          ? env.router.connect(env.trader).sellV2(env.token, false, amount, 1n, env.other.address, deadline())
          : env.router.connect(env.trader).sellV3(env.token, 3000, amount, 1n, env.other.address, deadline());
        await expect(tx).to.emit(env.router, "ImportSwap").withArgs(
          env.trader.address, await env.token.getAddress(), venue === "V2" ? 2 : 3, false, gross, s.protocol, s.creator, received, env.other.address,
        );
      });

      it("a donation (tokens and forced native) neither blocks a sell nor gets swept into it", async () => {
        const env = await deploy();
        const r = await env.router.getAddress();
        await env.token.connect(env.trader).transfer(r, 7n);
        await network.provider.send("hardhat_setBalance", [r, "0x5"]);
        await env.weth.connect(env.trader).deposit({ value: 3n });
        await env.weth.connect(env.trader).transfer(r, 3n);
        const amount = E(10_000);
        await env.token.connect(env.trader).approve(r, amount);
        const before = await ethers.provider.getBalance(env.other.address);
        if (venue === "V2") await env.router.connect(env.trader).sellV2(env.token, false, amount, 1n, env.other.address, await deadline());
        else await env.router.connect(env.trader).sellV3(env.token, 3000, amount, 1n, env.other.address, await deadline());
        const gross = (amount * E(1)) / RATE;
        expect((await ethers.provider.getBalance(env.other.address)) - before).to.eq(gross - split(gross).fee);
        expect(await env.token.balanceOf(r)).to.eq(7n);
        expect(await ethers.provider.getBalance(r)).to.eq(5n);
        expect(await env.weth.balanceOf(r)).to.eq(3n);
        // Buys too.
        await (venue === "V2"
          ? env.router.connect(env.trader).buyV2(env.token, false, 1n, env.other.address, await deadline(), { value: E(1) })
          : env.router.connect(env.trader).buyV3(env.token, 3000, 1n, env.other.address, await deadline(), { value: E(1) }));
        expect(await ethers.provider.getBalance(r)).to.eq(5n);
      });

      it("zero amount, zero min, wrapped native, zero recipient and an expired deadline are refused", async () => {
        const env = await deploy();
        const t = await env.token.getAddress();
        const sell = (token: string, amount: bigint, min: bigint, to: string, dl: number) => venue === "V2"
          ? env.router.connect(env.trader).sellV2(token, false, amount, min, to, dl)
          : env.router.connect(env.trader).sellV3(token, 3000, amount, min, to, dl);
        await expect(sell(t, 0n, 1n, env.other.address, await deadline())).to.be.revertedWithCustomError(env.router, "ZeroInput");
        await expect(sell(t, 1n, 0n, env.other.address, await deadline())).to.be.revertedWithCustomError(env.router, "ZeroMinimumOut");
        await expect(sell(await env.weth.getAddress(), 1n, 1n, env.other.address, await deadline())).to.be.revertedWithCustomError(env.router, "InvalidToken");
        await expect(sell(t, 1n, 1n, ethers.ZeroAddress, await deadline())).to.be.revertedWithCustomError(env.router, "ZeroAddress");
        await expect(sell(t, 1n, 1n, env.other.address, (await deadline()) - 700)).to.be.revertedWithCustomError(env.router, "DeadlineExpired");
      });
    });
  }

  it("a V2 venue that leaves pulled tokens behind is refused (LeftoverBalance)", async () => {
    const env = await deploy();
    await env.v2.setTakeBps(9_000);
    const amount = E(10_000);
    await env.token.connect(env.trader).approve(env.router, amount);
    await expect(env.router.connect(env.trader).sellV2(env.token, false, amount, 1n, env.other.address, await deadline()))
      .to.be.revertedWithCustomError(env.router, "LeftoverBalance");
  });

  it("a token that re-enters during the swap hits the guard; the outer trade completes", async () => {
    const env = await deploy();
    const re = await (await ethers.getContractFactory("MockReenteringImportToken")).deploy();
    await re.mint(await env.v2.getAddress(), E(1e12));
    const payload = env.router.interface.encodeFunctionData("buyV2", [await re.getAddress(), false, 1n, env.other.address, await deadline()]);
    await re.arm(await env.router.getAddress(), payload);
    await env.router.connect(env.trader).buyV2(re, false, 1n, env.other.address, await deadline(), { value: E(1) });
    expect(await re.reentered()).to.eq(true);
    expect(await re.reentryReverted()).to.eq(true);
    expect(await re.balanceOf(env.other.address)).to.eq(((E(1) - split(E(1)).fee) * RATE) / E(1));
  });

  it("a reverting fee receiver or sell recipient reverts that trade only (NativeTransferFailed)", async () => {
    const env = await deploy();
    const bad = await (await ethers.getContractFactory("RevertingNativeReceiver")).deploy();
    const F = await ethers.getContractFactory("ImportSwapFeeRouter");
    const r = await F.deploy(await env.weth.getAddress(), env.protocol.address, await bad.getAddress(), 50, 50, await env.v3.getAddress(), await env.v2.getAddress());
    await expect(r.connect(env.trader).buyV2(env.token, false, 1n, env.other.address, await deadline(), { value: E(1) }))
      .to.be.revertedWithCustomError(r, "NativeTransferFailed");
    await env.token.connect(env.trader).approve(env.router, E(1000));
    await expect(env.router.connect(env.trader).sellV2(env.token, false, E(1000), 1n, await bad.getAddress(), await deadline()))
      .to.be.revertedWithCustomError(env.router, "NativeTransferFailed");
  });

  it("plain native from anyone but the wrapped native and the V2 router is refused", async () => {
    const env = await deploy();
    await expect(env.trader.sendTransaction({ to: await env.router.getAddress(), value: 1n }))
      .to.be.revertedWithCustomError(env.router, "UnexpectedNativeSender");
  });

  it("property: fee split exact for 200 random amounts and both bps settings, rounding always to the protocol", async () => {
    const env = await deploy();
    const asym = await deploy({ p: 70n, c: 30n });
    let seed = 0x1234567n;
    const rnd = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const x = rnd() % 10n ** BigInt(2 + (i % 24));
      for (const [r, p, c] of [[env.router, P_BPS, C_BPS], [asym.router, 70n, 30n]] as const) {
        const [fp, fc] = await r.feeSplit(x);
        const s = split(x, p, c);
        expect(fp).to.eq(s.protocol);
        expect(fc).to.eq(s.creator);
        expect(fp + fc).to.eq((x * (p + c)) / 10_000n);
        // Rounding goes to the protocol: the creator never exceeds its exact share, the protocol never gets less
        // than its own share rounded down.
        expect(fc * 10_000n <= x * c).to.eq(true);
        expect(fp >= (x * p) / 10_000n).to.eq(true);
      }
    }
  });

  it("property: random buy / sell sequences never leave value in the router and pay fees exactly", async () => {
    const env = await deploy();
    let seed = 99n;
    const rnd = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return seed;
    };
    let protocolSum = 0n;
    let creatorSum = 0n;
    const p0 = await ethers.provider.getBalance(env.protocol.address);
    const c0 = await ethers.provider.getBalance(env.creator.address);
    await env.token.connect(env.trader).approve(env.router, ethers.MaxUint256);
    for (let i = 0; i < 40; i += 1) {
      const buy = rnd() % 2n === 0n;
      const v3 = rnd() % 2n === 0n;
      if (buy) {
        const value = 100n + (rnd() % E(3));
        const s = split(value);
        protocolSum += s.protocol;
        creatorSum += s.creator;
        if (v3) await env.router.connect(env.trader).buyV3(env.token, 3000, 1n, env.trader.address, await deadline(), { value });
        else await env.router.connect(env.trader).buyV2(env.token, false, 1n, env.trader.address, await deadline(), { value });
      } else {
        const amount = E(200) + (rnd() % E(2_000_000));
        const gross = (amount * E(1)) / RATE;
        const s = split(gross);
        if (s.fee === 0n) continue;
        protocolSum += s.protocol;
        creatorSum += s.creator;
        if (v3) await env.router.connect(env.trader).sellV3(env.token, 3000, amount, 1n, env.trader.address, await deadline());
        else await env.router.connect(env.trader).sellV2(env.token, false, amount, 1n, env.trader.address, await deadline());
      }
      expect(await ethers.provider.getBalance(env.router)).to.eq(0n);
      expect(await env.weth.balanceOf(env.router)).to.eq(0n);
      expect(await env.token.balanceOf(env.router)).to.eq(0n);
    }
    expect((await ethers.provider.getBalance(env.protocol.address)) - p0).to.eq(protocolSum);
    expect((await ethers.provider.getBalance(env.creator.address)) - c0).to.eq(creatorSum);
  });
});

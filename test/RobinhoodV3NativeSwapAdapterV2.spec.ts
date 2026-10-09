import { expect } from "chai";
import { ethers, network } from "hardhat";

// docs/evm-launch/CO-IMPORT-SWAP-FEE.md A.2: RobinhoodV3NativeSwapAdapterV2 = the live adapter with start-of-call
// balance checks instead of exact-zero ones, so a donation can no longer brick buys or sells.
const E = (v: string | number) => ethers.parseEther(String(v));
const RATE = E(1_000_000); // MockImportV3Router: 1,000,000 tokens per native
const FEE = 3000;

async function deadline(s = 600) {
  const b = await ethers.provider.getBlock("latest");
  return Number(b!.timestamp) + s;
}

const tokensFor = (native: bigint) => (native * RATE) / E(1);
const nativeFor = (tokens: bigint) => (tokens * E(1)) / RATE;

async function deploy() {
  const [deployer, trader, other, donor] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const token = await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(0);
  const router = await (await ethers.getContractFactory("MockImportV3Router")).deploy(await weth.getAddress(), RATE);
  const adapter = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapterV2")).deploy(router, weth);
  const oldAdapter = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter")).deploy(router, weth);
  await token.mint(await router.getAddress(), E(1e12));
  await token.mint(trader.address, E(1e9));
  await token.mint(donor.address, E(1e9));
  await router.fundWrapped({ value: E(100) });
  await weth.connect(donor).deposit({ value: E(1) });
  return { deployer, trader, other, donor, weth, token, router, adapter, oldAdapter };
}

type Env = Awaited<ReturnType<typeof deploy>>;

async function holdings(env: Env, who: any) {
  const a = await who.getAddress();
  return {
    token: await env.token.balanceOf(a),
    weth: await env.weth.balanceOf(a),
    native: await ethers.provider.getBalance(a),
  };
}

/** One token unit, one wei of WETH and one wei of native forced in with selfdestruct (no receive() runs). */
async function donateAll(env: Env, target: any) {
  const t = await target.getAddress();
  await env.token.connect(env.donor).transfer(t, 1n);
  await env.weth.connect(env.donor).transfer(t, 1n);
  await (await ethers.getContractFactory("ForwarderForceSend")).connect(env.donor).deploy(t, { value: 1n });
  const h = await holdings(env, target);
  expect(h).to.deep.eq({ token: 1n, weth: 1n, native: 1n });
}

describe("RobinhoodV3NativeSwapAdapterV2 (CO-IMP A.2)", function () {
  it("has the live adapter's exact ABI and refuses zero dependencies", async () => {
    const { artifacts } = require("hardhat");
    const v1 = await artifacts.readArtifact("RobinhoodV3NativeSwapAdapter");
    const v2 = await artifacts.readArtifact("RobinhoodV3NativeSwapAdapterV2");
    expect(JSON.stringify(v2.abi)).to.eq(JSON.stringify(v1.abi));
    const env = await deploy();
    expect(await env.adapter.swapRouter()).to.eq(await env.router.getAddress());
    expect(await env.adapter.wrappedNative()).to.eq(await env.weth.getAddress());
    const F = await ethers.getContractFactory("RobinhoodV3NativeSwapAdapterV2");
    await expect(F.deploy(ethers.ZeroAddress, env.weth)).to.be.revertedWith("zero dependency");
    await expect(F.deploy(env.router, ethers.ZeroAddress)).to.be.revertedWith("zero dependency");
  });

  it("buy: exact token amount to the recipient, NativeBuy, nothing left in the adapter", async () => {
    const env = await deploy();
    const value = E("0.37");
    const out = tokensFor(value);
    expect(await env.adapter.connect(env.trader).buyExactNativeIn.staticCall(env.token, FEE, out, env.other.address, await deadline(), { value })).to.eq(out);
    await expect(env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, out, env.other.address, await deadline(), { value }))
      .to.emit(env.adapter, "NativeBuy")
      .withArgs(env.trader.address, await env.token.getAddress(), FEE, value, out, env.other.address);
    expect(await env.token.balanceOf(env.other.address)).to.eq(out);
    expect(await env.router.lastFee()).to.eq(FEE);
    expect(await holdings(env, env.adapter)).to.deep.eq({ token: 0n, weth: 0n, native: 0n });
    expect(await env.weth.allowance(env.adapter, env.router)).to.eq(0n);
  });

  it("sell: exact native to the recipient (the WETH delta), NativeSell, nothing left in the adapter", async () => {
    const env = await deploy();
    const amount = E(123_456);
    const out = nativeFor(amount);
    await env.token.connect(env.trader).approve(env.adapter, amount);
    const before = await ethers.provider.getBalance(env.other.address);
    expect(await env.adapter.connect(env.trader).sellExactTokenIn.staticCall(env.token, FEE, amount, out, env.other.address, await deadline())).to.eq(out);
    await expect(env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, amount, out, env.other.address, await deadline()))
      .to.emit(env.adapter, "NativeSell")
      .withArgs(env.trader.address, await env.token.getAddress(), FEE, amount, out, env.other.address);
    expect((await ethers.provider.getBalance(env.other.address)) - before).to.eq(out);
    expect(await holdings(env, env.adapter)).to.deep.eq({ token: 0n, weth: 0n, native: 0n });
    expect(await env.token.allowance(env.adapter, env.router)).to.eq(0n);
  });

  it("min-out boundary: the exact output passes, one more reverts (buy and sell)", async () => {
    const env = await deploy();
    const value = E(1);
    const out = tokensFor(value);
    await expect(env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, out + 1n, env.other.address, await deadline(), { value })).to.be.revertedWith("min");
    await env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, out, env.other.address, await deadline(), { value });

    const amount = E(5_000);
    const nOut = nativeFor(amount);
    await env.token.connect(env.trader).approve(env.adapter, amount * 2n);
    await expect(env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, amount, nOut + 1n, env.other.address, await deadline())).to.be.revertedWith("min");
    await env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, amount, nOut, env.other.address, await deadline());
  });

  it("deadline: the deadline second itself passes, one second later reverts", async () => {
    const env = await deploy();
    const t = (await deadline(0)) + 100;
    await network.provider.send("evm_setNextBlockTimestamp", [t]);
    await env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, 1n, env.other.address, t, { value: E("0.01") });
    await network.provider.send("evm_setNextBlockTimestamp", [t + 2]);
    await expect(env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, 1n, env.other.address, t + 1, { value: E("0.01") }))
      .to.be.revertedWith("deadline");
    await env.token.connect(env.trader).approve(env.adapter, E(10));
    const d = await deadline(-1);
    await expect(env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, E(10), 1n, env.other.address, d)).to.be.revertedWith("deadline");
  });

  it("refuses zero input, zero minimum, invalid token, zero / self recipient and zero fee", async () => {
    const env = await deploy();
    const a = env.adapter.connect(env.trader);
    const d = await deadline();
    const self = await env.adapter.getAddress();
    const o = env.other.address;
    await expect(a.buyExactNativeIn(env.token, FEE, 1n, o, d)).to.be.revertedWith("zero input");
    await expect(a.buyExactNativeIn(env.token, FEE, 0n, o, d, { value: 1n })).to.be.revertedWith("zero minimum out");
    await expect(a.buyExactNativeIn(ethers.ZeroAddress, FEE, 1n, o, d, { value: 1n })).to.be.revertedWith("invalid token");
    await expect(a.buyExactNativeIn(env.weth, FEE, 1n, o, d, { value: 1n })).to.be.revertedWith("invalid token");
    await expect(a.buyExactNativeIn(env.token, FEE, 1n, ethers.ZeroAddress, d, { value: 1n })).to.be.revertedWith("zero recipient");
    await expect(a.buyExactNativeIn(env.token, FEE, 1n, self, d, { value: 1n })).to.be.revertedWith("invalid recipient");
    await expect(a.buyExactNativeIn(env.token, 0, 1n, o, d, { value: 1n })).to.be.revertedWith("zero fee");
    await expect(a.sellExactTokenIn(env.token, FEE, 0n, 1n, o, d)).to.be.revertedWith("zero input");
    await expect(a.sellExactTokenIn(env.token, FEE, 1n, 0n, o, d)).to.be.revertedWith("zero minimum out");
    await expect(a.sellExactTokenIn(ethers.ZeroAddress, FEE, 1n, 1n, o, d)).to.be.revertedWith("invalid token");
    await expect(a.sellExactTokenIn(env.weth, FEE, 1n, 1n, o, d)).to.be.revertedWith("invalid token");
    await expect(a.sellExactTokenIn(env.token, FEE, 1n, 1n, ethers.ZeroAddress, d)).to.be.revertedWith("zero recipient");
    await expect(a.sellExactTokenIn(env.token, FEE, 1n, 1n, self, d)).to.be.revertedWith("invalid recipient");
    await expect(a.sellExactTokenIn(env.token, 0, 1n, 1n, o, d)).to.be.revertedWith("zero fee");
  });

  it("receive() takes native only from WETH", async () => {
    const env = await deploy();
    await expect(env.trader.sendTransaction({ to: env.adapter, value: 1n })).to.be.revertedWith("native only from WETH");
  });

  it("donated token, WETH and forced native do NOT brick buys or sells and stay untouched", async () => {
    const env = await deploy();
    await donateAll(env, env.adapter);
    for (let i = 0; i < 2; i++) {
      const value = E("0.25");
      const before = await env.token.balanceOf(env.other.address);
      await env.adapter.connect(env.trader).buyExactNativeIn(env.token, FEE, tokensFor(value), env.other.address, await deadline(), { value });
      expect((await env.token.balanceOf(env.other.address)) - before).to.eq(tokensFor(value));
      expect(await holdings(env, env.adapter)).to.deep.eq({ token: 1n, weth: 1n, native: 1n });

      const amount = E(77_777);
      await env.token.connect(env.trader).approve(env.adapter, amount);
      const nBefore = await ethers.provider.getBalance(env.other.address);
      await expect(env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, amount, nativeFor(amount), env.other.address, await deadline()))
        .to.emit(env.adapter, "NativeSell")
        .withArgs(env.trader.address, await env.token.getAddress(), FEE, amount, nativeFor(amount), env.other.address);
      expect((await ethers.provider.getBalance(env.other.address)) - nBefore).to.eq(nativeFor(amount));
      expect(await holdings(env, env.adapter)).to.deep.eq({ token: 1n, weth: 1n, native: 1n });
    }
  });

  it("regression: the OLD adapter is bricked by the same donations (the A.1 finding)", async () => {
    const env = await deploy();
    const d = await deadline();
    // 1 token unit: every later sell of that token reverts.
    await env.token.connect(env.donor).transfer(env.oldAdapter, 1n);
    await env.token.connect(env.trader).approve(env.oldAdapter, E(1_000_000));
    await expect(env.oldAdapter.connect(env.trader).sellExactTokenIn(env.token, FEE, E(1_000), 1n, env.other.address, d)).to.be.revertedWith("token dust");
    // Forced native: every sell of every token reverts.
    const env2 = await deploy();
    await (await ethers.getContractFactory("ForwarderForceSend")).connect(env2.donor).deploy(await env2.oldAdapter.getAddress(), { value: 1n });
    await env2.token.connect(env2.trader).approve(env2.oldAdapter, E(1_000));
    await expect(env2.oldAdapter.connect(env2.trader).sellExactTokenIn(env2.token, FEE, E(1_000), 1n, env2.other.address, await deadline())).to.be.revertedWith("native dust");
    // 1 wei of WETH: every buy (and sell) reverts.
    const env3 = await deploy();
    await env3.weth.connect(env3.donor).transfer(env3.oldAdapter, 1n);
    await expect(env3.oldAdapter.connect(env3.trader).buyExactNativeIn(env3.token, FEE, 1n, env3.other.address, await deadline(), { value: E("0.1") })).to.be.revertedWith("wrapped dust");
    // The new adapter, same donations, same calls: all pass.
    await donateAll(env3, env3.adapter);
    await env3.adapter.connect(env3.trader).buyExactNativeIn(env3.token, FEE, 1n, env3.other.address, await deadline(), { value: E("0.1") });
    await env3.token.connect(env3.trader).approve(env3.adapter, E(1_000));
    await env3.adapter.connect(env3.trader).sellExactTokenIn(env3.token, FEE, E(1_000), 1n, env3.other.address, await deadline());
  });

  it("a token that re-enters during a buy or a sell hits the guard; the outer trade completes", async () => {
    const env = await deploy();
    const re = await (await ethers.getContractFactory("MockReenteringImportToken")).deploy();
    await re.mint(await env.router.getAddress(), E(1e12));
    await re.mint(env.trader.address, E(1e6));
    const d = await deadline();
    const buyPayload = env.adapter.interface.encodeFunctionData("buyExactNativeIn", [await re.getAddress(), FEE, 1n, env.other.address, d]);
    await re.arm(await env.adapter.getAddress(), buyPayload);
    await env.adapter.connect(env.trader).buyExactNativeIn(re, FEE, 1n, env.other.address, d, { value: E(1) });
    expect(await re.reentered()).to.eq(true);
    expect(await re.reentryReverted()).to.eq(true);
    expect(await re.balanceOf(env.other.address)).to.eq(tokensFor(E(1)));

    const amount = E(1_000);
    await re.connect(env.trader).approve(env.adapter, amount);
    const sellPayload = env.adapter.interface.encodeFunctionData("sellExactTokenIn", [await re.getAddress(), FEE, 1n, 1n, env.other.address, d]);
    await re.arm(await env.adapter.getAddress(), sellPayload);
    const before = await ethers.provider.getBalance(env.other.address);
    await env.adapter.connect(env.trader).sellExactTokenIn(re, FEE, amount, 1n, env.other.address, d);
    expect(await re.reentryReverted()).to.eq(true);
    expect((await ethers.provider.getBalance(env.other.address)) - before).to.eq(nativeFor(amount));
    expect(await holdings(env, env.adapter)).to.deep.eq({ token: 0n, weth: 0n, native: 0n });
  });

  it("a reverting sell recipient fails only its own trade", async () => {
    const env = await deploy();
    const bad = await (await ethers.getContractFactory("RevertingNativeReceiver")).deploy();
    await env.token.connect(env.trader).approve(env.adapter, E(1_000));
    await expect(env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, E(1_000), 1n, bad, await deadline()))
      .to.be.revertedWith("native transfer failed");
    await env.adapter.connect(env.trader).sellExactTokenIn(env.token, FEE, E(1_000), 1n, env.other.address, await deadline());
  });

  it("a fee-on-transfer sell is refused before the router can touch a donation", async () => {
    const env = await deploy();
    const fot = await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(1000);
    await fot.mint(env.trader.address, E(1_000));
    await fot.mint(env.donor.address, E(1_000));
    await fot.connect(env.donor).transfer(env.adapter, E(500)); // arrives as 450
    const parked = await fot.balanceOf(env.adapter);
    await fot.connect(env.trader).approve(env.adapter, E(100));
    await expect(env.adapter.connect(env.trader).sellExactTokenIn(fot, FEE, E(100), 1n, env.other.address, await deadline()))
      .to.be.revertedWith("token in mismatch");
    expect(await fot.balanceOf(env.adapter)).to.eq(parked);
  });
});

/** Parity on the Uniswap-V3 math mock (the old spec's fixture): same input, same output, old vs new. */
describe("RobinhoodV3NativeSwapAdapterV2 parity with the old adapter on MockUniswapV3SwapRouter", function () {
  it("buy and sell return the same amounts from the same snapshot", async () => {
    const [owner, trader] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const pm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(factory, weth);
    const sr = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(factory, weth);
    await factory.configurePeriphery(pm, sr);
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("T", "T", E(1_000_000), owner.address);
    const [t0, t1] = (await token.getAddress()).toLowerCase() < (await weth.getAddress()).toLowerCase() ? [token, weth] : [weth, token];
    await pm.createAndInitializePoolIfNecessary(t0, t1, FEE, 1n << 96n);
    await weth.deposit({ value: E(10) });
    await token.approve(pm, E(1000));
    await weth.approve(pm, E(10));
    const tokenIs0 = t0 === token;
    await pm.mint({
      token0: t0, token1: t1, fee: FEE, tickLower: -887220, tickUpper: 887220,
      amount0Desired: tokenIs0 ? E(1000) : E(10), amount1Desired: tokenIs0 ? E(10) : E(1000),
      amount0Min: 0, amount1Min: 0, recipient: owner.address, deadline: await deadline(),
    });
    const oldA = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter")).deploy(sr, weth);
    const newA = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapterV2")).deploy(sr, weth);

    const run = async (a: any) => {
      const snap = await network.provider.send("evm_snapshot", []);
      const d = await deadline();
      const got = await a.connect(trader).buyExactNativeIn.staticCall(token, FEE, 1n, trader.address, d, { value: E(1) });
      await a.connect(trader).buyExactNativeIn(token, FEE, 1n, trader.address, d, { value: E(1) });
      await token.connect(trader).approve(a, got);
      const back = await a.connect(trader).sellExactTokenIn.staticCall(token, FEE, got, 1n, trader.address, d);
      await a.connect(trader).sellExactTokenIn(token, FEE, got, 1n, trader.address, d);
      await network.provider.send("evm_revert", [snap]);
      return { got, back };
    };
    const o = await run(oldA);
    const n = await run(newA);
    expect(n).to.deep.eq(o);
    expect(o.got > 0n && o.back > 0n).to.eq(true);
  });
});

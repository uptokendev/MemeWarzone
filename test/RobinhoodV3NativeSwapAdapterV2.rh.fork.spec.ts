/**
 * CO-IMP A.2 fork proof on Robinhood 4663: RobinhoodV3NativeSwapAdapterV2, deployed by
 * scripts/deploy-robinhood-swap-adapter-v2.ts (constructor args read from the live adapter 0xDfd381EC), against the live
 * adapter on the same fork snapshot, on two real V3 pools:
 *   1. an imported coin: HOODFUN 0xfbeD2D06 (its deepest WETH pool, picked the way arenaImportedRobinhood.ts picks it);
 *   2. the real gen-6 coin MWZRH (campaign 0x404D723d of the live gen-6 factory 0xc673B116), graduated on the fork:
 *      the factory is impersonated to open unsigned trading (setRequireAuthorizedTrading(false), the Safe's exit path),
 *      one buy reaches the $15,000 target, graduate() creates and locks its V3 pool. No gen-6 coin has graduated on
 *      4663 yet, so this is the only real gen-6 pool there can be.
 * For each: buy and sell through V2 == through the live adapter (same snapshot, to the wei); then 1 token unit is
 * donated to both adapters: the live adapter's sell reverts "token dust", V2's sell works and the unit stays. On the
 * imported coin also 1 wei WETH (live buy reverts "wrapped dust") and 1 wei forced native (live sell reverts
 * "native dust"); V2 trades through all three.
 *
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/RobinhoodV3NativeSwapAdapterV2.rh.fork.spec.ts
 *
 * In-process fork: nothing is sent to Robinhood Chain.
 */
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers, network } from "hardhat";
import { main as deployV2 } from "../scripts/deploy-robinhood-swap-adapter-v2";

const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 4663;
const d = FORKED ? describe : describe.skip;

const LIVE_ADAPTER = "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296";
const SWAP_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const HOODFUN = ethers.getAddress("0xfbed2d0698b3140358816969789559745efe600d");
const GEN6_FACTORY = "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F";
const GEN6_CAMPAIGN = "0x404D723dAbab33F0303d9fD26fA36936a87627F8";
const GEN6_TOKEN = "0x3765d71619C2ddf1d20fB85827754AfADf359389";
const FEE_TIERS = [500, 3000, 10000];
const E = (v: string | number) => ethers.parseEther(String(v));

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
];
const WETH_ABI = [...ERC20, "function deposit() payable"];
const CAMPAIGN = [
  "function setRequireAuthorizedTrading(bool)",
  "function graduationNativeTarget() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function quoteBuyExactBnb(uint256) view returns (uint256 tokensOut,uint256 totalCostWei,uint256 feeWei)",
  "function buyExactBnb(uint256 minTokensOut) payable returns (uint256,uint256)",
  "function graduationPending() view returns (bool)",
  "function launched() view returns (bool)",
  "function graduate() returns (address)",
];

async function deadline() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 1200);
}

/** The deepest WETH pool of `token` (arenaImportedRobinhood.ts's choice). */
async function deepestPool(token: string) {
  const f = new ethers.Contract(V3_FACTORY, ["function getPool(address,address,uint24) view returns (address)"], ethers.provider);
  let best = { pool: ethers.ZeroAddress, fee: 0, liquidity: -1n };
  for (const fee of FEE_TIERS) {
    const pool = await f.getPool(token, WETH, fee);
    if (pool === ethers.ZeroAddress) continue;
    const liquidity = BigInt(await new ethers.Contract(pool, ["function liquidity() view returns (uint128)"], ethers.provider).liquidity());
    if (liquidity > best.liquidity) best = { pool, fee, liquidity };
  }
  if (best.pool === ethers.ZeroAddress) throw new Error(`no WETH pool for ${token}`);
  return best;
}

d("RobinhoodV3NativeSwapAdapterV2 on a Robinhood 4663 fork: equals the live adapter, survives donations", function () {
  this.timeout(1_800_000);
  let v2: any;
  let live: any;
  let trader: any;
  let donor: any;
  let recipient: string;
  const rows: string[] = [];

  before(async function () {
    // A call at the fork block itself is "historical" to EDR; mine one first (as the evmgen-rh fork specs do).
    await network.provider.send("evm_mine", []);
    [trader, donor] = await ethers.getSigners();
    recipient = ethers.Wallet.createRandom().address;
    process.env.REHEARSAL_OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rh-swap-adapter-v2-"));
    const { record } = await deployV2({ signer: donor });
    expect(record.sourceAdapter).to.eq(LIVE_ADAPTER);
    expect(record.constructorArgs).to.deep.eq({ swapRouter: SWAP_ROUTER, wrappedNative: WETH });
    v2 = await ethers.getContractAt("RobinhoodV3NativeSwapAdapterV2", record.address, trader);
    live = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", LIVE_ADAPTER, trader);
    console.log(`      fork block ${await ethers.provider.getBlockNumber()}, V2 ${record.address} (${record.runtimeBytes} bytes)`);
  });

  after(() => {
    for (const r of rows) console.log(`      ${r}`);
    const out = process.env.REHEARSAL_OUT_DIR;
    if (out && out.startsWith(os.tmpdir())) fs.rmSync(out, { recursive: true, force: true });
    delete process.env.REHEARSAL_OUT_DIR;
  });

  // Each case starts from the same post-deploy state (no donations carried over).
  let caseSnap: string;
  beforeEach(async () => {
    caseSnap = await network.provider.send("evm_snapshot", []);
  });
  afterEach(async () => {
    await network.provider.send("evm_revert", [caseSnap]);
  });

  /** Buy `value` then sell everything bought, to a fresh recipient; reverted afterwards. */
  async function roundTrip(adapter: any, token: string, fee: number, value: bigint) {
    const snap = await network.provider.send("evm_snapshot", []);
    const t = new ethers.Contract(token, ERC20, trader);
    const dl = await deadline();
    const before = await t.balanceOf(trader.address);
    const buyRet = await adapter.buyExactNativeIn.staticCall(token, fee, 1n, trader.address, dl, { value });
    await (await adapter.buyExactNativeIn(token, fee, 1n, trader.address, dl, { value })).wait();
    const tokensOut = (await t.balanceOf(trader.address)) - before;
    await (await t.approve(await adapter.getAddress(), tokensOut)).wait();
    const nBefore = await ethers.provider.getBalance(recipient);
    const sellRet = await adapter.sellExactTokenIn.staticCall(token, fee, tokensOut, 1n, recipient, dl);
    await (await adapter.sellExactTokenIn(token, fee, tokensOut, 1n, recipient, dl)).wait();
    const nativeOut = (await ethers.provider.getBalance(recipient)) - nBefore;
    await network.provider.send("evm_revert", [snap]);
    return { buyRet, tokensOut, sellRet, nativeOut };
  }

  async function proveParity(label: string, token: string, fee: number, value: bigint) {
    const a = await roundTrip(live, token, fee, value);
    const b = await roundTrip(v2, token, fee, value);
    expect(b).to.deep.eq(a);
    expect(a.buyRet).to.eq(a.tokensOut);
    expect(a.sellRet).to.eq(a.nativeOut);
    expect(a.tokensOut > 0n && a.nativeOut > 0n).to.eq(true);
    rows.push(`${label} fee ${fee}: buy ${ethers.formatEther(value)} ETH -> ${a.tokensOut} tokens (live == V2); sell -> ${a.nativeOut} wei (live == V2, V2 = WETH delta == router return)`);
    return a;
  }

  /** Gets the trader `amount` of `token` through the live adapter (before any donation). */
  async function acquire(token: string, fee: number, value: bigint) {
    const t = new ethers.Contract(token, ERC20, trader);
    const before = await t.balanceOf(trader.address);
    await (await live.buyExactNativeIn(token, fee, 1n, trader.address, await deadline(), { value })).wait();
    return (await t.balanceOf(trader.address)) - before;
  }

  async function proveTokenDonation(label: string, token: string, fee: number, held: bigint) {
    const t = new ethers.Contract(token, ERC20, trader);
    await (await t.transfer(LIVE_ADAPTER, 1n)).wait();
    await (await t.transfer(await v2.getAddress(), 1n)).wait();
    const amount = (held - 2n) / 4n;
    await (await t.approve(LIVE_ADAPTER, amount)).wait();
    await expect(live.sellExactTokenIn(token, fee, amount, 1n, recipient, await deadline())).to.be.revertedWith("token dust");
    await (await t.approve(await v2.getAddress(), amount)).wait();
    const nBefore = await ethers.provider.getBalance(recipient);
    await (await v2.sellExactTokenIn(token, fee, amount, 1n, recipient, await deadline())).wait();
    const got = (await ethers.provider.getBalance(recipient)) - nBefore;
    expect(got > 0n).to.eq(true);
    expect(await t.balanceOf(await v2.getAddress())).to.eq(1n);
    expect(await t.balanceOf(LIVE_ADAPTER)).to.eq(1n);
    rows.push(`${label}: 1 token unit donated to both: live sell of ${amount} reverts "token dust"; V2 sell pays ${got} wei, the unit stays in V2`);
  }

  it("imported coin HOODFUN: V2 == live adapter; token, WETH and forced-native donations brick live, not V2", async () => {
    const { pool, fee, liquidity } = await deepestPool(HOODFUN);
    rows.push(`HOODFUN pool ${pool} fee ${fee} liquidity ${liquidity}`);
    await proveParity("HOODFUN", HOODFUN, fee, E("0.01"));

    const held = await acquire(HOODFUN, fee, E("0.01"));
    await proveTokenDonation("HOODFUN", HOODFUN, fee, held);

    // 1 wei WETH: the live adapter refuses every buy; V2 buys.
    const weth = new ethers.Contract(WETH, WETH_ABI, donor);
    await (await weth.deposit({ value: 2n })).wait();
    await (await weth.transfer(LIVE_ADAPTER, 1n)).wait();
    await (await weth.transfer(await v2.getAddress(), 1n)).wait();
    await expect(live.buyExactNativeIn(HOODFUN, fee, 1n, trader.address, await deadline(), { value: E("0.001") })).to.be.revertedWith("wrapped dust");
    await (await v2.buyExactNativeIn(HOODFUN, fee, 1n, trader.address, await deadline(), { value: E("0.001") })).wait();
    expect(await weth.balanceOf(await v2.getAddress())).to.eq(1n);

    // 1 wei forced native (selfdestruct): the live adapter refuses every sell; V2 sells.
    const Force = await ethers.getContractFactory("ForwarderForceSend", donor);
    await Force.deploy(LIVE_ADAPTER, { value: 1n });
    await Force.deploy(await v2.getAddress(), { value: 1n });
    const t = new ethers.Contract(HOODFUN, ERC20, trader);
    const amount = (await t.balanceOf(trader.address)) / 4n;
    await (await t.approve(LIVE_ADAPTER, amount)).wait();
    await expect(live.sellExactTokenIn(HOODFUN, fee, amount, 1n, recipient, await deadline())).to.be.reverted; // token dust first
    await (await t.approve(await v2.getAddress(), amount)).wait();
    await (await v2.sellExactTokenIn(HOODFUN, fee, amount, 1n, recipient, await deadline())).wait();
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.eq(1n);
    expect(await t.balanceOf(await v2.getAddress())).to.eq(1n);
    expect(await weth.balanceOf(await v2.getAddress())).to.eq(1n);
    rows.push(`HOODFUN: + 1 wei WETH: live buy reverts "wrapped dust", V2 buys; + 1 wei forced native: V2 still sells; V2 holds exactly the 3 donations`);
  });

  it("forced native alone bricks every live sell (a token with no donated units), not V2", async () => {
    const { fee } = await deepestPool(HOODFUN);
    const held = await acquire(HOODFUN, fee, E("0.005"));
    await (await ethers.getContractFactory("ForwarderForceSend", donor)).deploy(LIVE_ADAPTER, { value: 1n });
    await (await ethers.getContractFactory("ForwarderForceSend", donor)).deploy(await v2.getAddress(), { value: 1n });
    const t = new ethers.Contract(HOODFUN, ERC20, trader);
    await (await t.approve(LIVE_ADAPTER, held / 2n)).wait();
    await expect(live.sellExactTokenIn(HOODFUN, fee, held / 2n, 1n, recipient, await deadline())).to.be.revertedWith("native dust");
    await (await t.approve(await v2.getAddress(), held / 2n)).wait();
    await (await v2.sellExactTokenIn(HOODFUN, fee, held / 2n, 1n, recipient, await deadline())).wait();
    rows.push(`HOODFUN, forced native only: live sell reverts "native dust"; V2 sells`);
  });

  it("gen-6 coin MWZRH graduated on the fork: V2 == live adapter on its V3 pool; a token donation bricks live, not V2", async () => {
    const campaign = new ethers.Contract(GEN6_CAMPAIGN, CAMPAIGN, trader);
    await network.provider.send("hardhat_impersonateAccount", [GEN6_FACTORY]);
    await network.provider.send("hardhat_setBalance", [GEN6_FACTORY, ethers.toQuantity(E(1))]);
    const factory = await ethers.getSigner(GEN6_FACTORY);
    await (await (campaign.connect(factory) as any).setRequireAuthorizedTrading(false)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [GEN6_FACTORY]);

    const target: bigint = await campaign.graduationNativeTarget();
    const need = target - (await campaign.netRaisedWei());
    const value = need + need / 10n + (need * 300n) / 10_000n;
    await (await campaign.buyExactBnb(1n, { value })).wait();
    expect(await campaign.graduationPending()).to.eq(true);
    await (await (campaign.connect(donor) as any).graduate({ gasLimit: 12_000_000 })).wait();
    expect(await campaign.launched()).to.eq(true);
    const { pool, fee, liquidity } = await deepestPool(GEN6_TOKEN);
    rows.push(`MWZRH graduated on the fork (target ${ethers.formatEther(target)} ETH): pool ${pool} fee ${fee} liquidity ${liquidity}`);

    await proveParity("MWZRH", GEN6_TOKEN, fee, E("0.05"));
    const held = await acquire(GEN6_TOKEN, fee, E("0.05"));
    await proveTokenDonation("MWZRH", GEN6_TOKEN, fee, held);
  });
});

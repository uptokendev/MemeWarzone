import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, E, area, mineAt, buyTokens, sellTokens, signTrade, DAY } from "./fixtures/evmgenCore";

const CLIFF = 30 * DAY;
const STEP = 7 * DAY;

/** The spec's formula: vested(t) = floor(sum_k Cum(t - 30d - 7d*k) / 5). */
function vestedModel(buys: Array<{ at: number; amount: bigint }>, t: number): bigint {
  let sum = 0n;
  for (let k = 0; k < 5; k++) {
    const off = CLIFF + k * STEP;
    if (t < off) break;
    for (const b of buys) if (b.at <= t - off) sum += b.amount;
  }
  return sum / 5n;
}

/** Per-buy reference: each buy releases a/5 at s+30d+7dk (k=0..4). */
function perBuyModel(buys: Array<{ at: number; amount: bigint }>, t: number): bigint {
  let v = 0n;
  for (const b of buys) {
    let steps = 0n;
    for (let k = 0; k < 5; k++) if (t >= b.at + CLIFF + k * STEP) steps++;
    v += (b.amount * steps) / 5n;
  }
  return v;
}

async function tradingCoin() {
  const env = await deployEvmGen();
  const { campaign, token } = await createCoin(env);
  await mineAt(Number(await campaign.launchAt()) + 61);
  return { env, campaign, token };
}

describe("evmgen core C4: creator buy escrow", function () {
  it("a creator buy lands in escrow: wallet delta 0, 0 at +30d-1s, 20% at +30d, 100% at +58d", async () => {
    const { env, campaign, token } = await tradingCoin();
    const amount = E(3_000_000);
    const tx = await buyTokens(env, campaign, env.creator, amount);
    const at = (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp;
    await expect(tx).to.emit(campaign, "CreatorBuyEscrowed").withArgs(env.creator.address, amount, at);
    expect(await token.balanceOf(env.creator.address)).to.eq(0n);
    expect(await campaign.creatorEscrowTotal()).to.eq(amount);
    expect(await campaign.creatorEscrowVested(at + CLIFF - 1)).to.eq(0n);
    expect(await campaign.creatorEscrowVested(at + CLIFF)).to.eq(amount / 5n);
    expect(await campaign.creatorEscrowVested(at + CLIFF + STEP - 1)).to.eq(amount / 5n);
    expect(await campaign.creatorEscrowVested(at + CLIFF + STEP)).to.eq((amount * 2n) / 5n);
    expect(await campaign.creatorEscrowVested(at + CLIFF + 4 * STEP - 1)).to.eq((amount * 4n) / 5n);
    expect(await campaign.creatorEscrowVested(at + 58 * DAY)).to.eq(amount);
    expect(await campaign.creatorEscrowVested(2n ** 255n)).to.eq(amount);
    // other wallets are not escrowed
    await buyTokens(env, campaign, env.alice, amount);
    expect(await token.balanceOf(env.alice.address)).to.eq(amount);
  });

  it("two buys 10 days apart match the per-buy schedule at every step boundary", async () => {
    const { env, campaign } = await tradingCoin();
    const buys: Array<{ at: number; amount: bigint }> = [];
    let tx = await buyTokens(env, campaign, env.creator, E(1_000_003));
    buys.push({ at: (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp, amount: E(1_000_003) });
    await mineAt(buys[0].at + 10 * DAY);
    tx = await buyTokens(env, campaign, env.creator, E(2_500_007));
    buys.push({ at: (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp, amount: E(2_500_007) });
    const points = new Set<number>();
    for (const b of buys) for (let k = 0; k < 5; k++) for (const d of [-1, 0, 1]) points.add(b.at + CLIFF + k * STEP + d);
    for (const t of [...points].sort((a, b) => a - b)) {
      const v = await campaign.creatorEscrowVested(t);
      expect(v, `t=${t}`).to.eq(vestedModel(buys, t));
      const ref = perBuyModel(buys, t);
      expect(v >= ref && v - ref <= 1n, `per-buy t=${t}`).to.eq(true);
    }
  });

  it("buys in one block merge into one checkpoint and still vest exactly", async () => {
    const { env, campaign } = await tradingCoin();
    const a1 = E(1_000_000);
    const a2 = E(700_000);
    const c1 = (await campaign.quoteBuyExactTokens(a1)) * 2n;
    const c2 = (await campaign.quoteBuyExactTokens(a1 + a2)) * 2n;
    const s1 = await signTrade(env.authority, await campaign.getAddress(), env.creator.address, 0, a1, c1);
    const s2 = await signTrade(env.authority, await campaign.getAddress(), env.creator.address, 0, a2, c2);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await campaign.connect(env.creator).buyExactTokensAuthorized(a1, c1, s1.profile, s1.deadline, s1.signature, { value: c1, gasLimit: 1_500_000 });
      await campaign.connect(env.creator).buyExactTokensAuthorized(a2, c2, s2.profile, s2.deadline, s2.signature, { value: c2, gasLimit: 1_500_000 });
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const at = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await campaign.creatorEscrowTotal()).to.eq(a1 + a2);
    expect(await campaign.creatorEscrowVested(at + CLIFF)).to.eq((a1 + a2) / 5n);
  });

  it("claims pay only the creator, only what is released, in any state; strangers and zero claims revert", async () => {
    const { env, campaign, token } = await tradingCoin();
    const amount = E(5_000_000);
    const tx = await buyTokens(env, campaign, env.creator, amount);
    const at = (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp;
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    await expect(campaign.connect(env.alice).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NotCreator");
    await mineAt(at + CLIFF);
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.emit(campaign, "CreatorEscrowClaimed").withArgs(env.creator.address, amount / 5n);
    expect(await token.balanceOf(env.creator.address)).to.eq(amount / 5n);
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    // paused campaign: debts still paid
    await env.factory.setCampaignPauses(await campaign.getAddress(), true, true, true, true);
    await mineAt(at + CLIFF + STEP);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(env.creator.address)).to.eq((amount * 2n) / 5n);
    // escrowed tokens cannot be sold from the wallet (they are not there)
    await env.factory.setCampaignPauses(await campaign.getAddress(), false, false, false, false);
    await expect(sellTokens(env, campaign, token, env.creator, amount)).to.be.reverted;
  });

  it("fuzz: invariants 3-5 hold over random creator/other buys, sells and claims", async () => {
    const { env, campaign, token } = await tradingCoin();
    const buys: Array<{ at: number; amount: bigint }> = [];
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const campaignAddr = await campaign.getAddress();
    const curveSupply = await campaign.curveSupply();
    const liq = await campaign.liquiditySupply();
    const reserve = await campaign.creatorReserve();
    let aliceHeld = 0n;
    for (let i = 0; i < 24; i++) {
      const op = rnd(4);
      const amt = E(100_000 + rnd(900_000));
      if (op === 0 || op === 1) {
        const tx = await buyTokens(env, campaign, env.creator, amt);
        buys.push({ at: (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp, amount: amt });
      } else if (op === 2) {
        await buyTokens(env, campaign, env.alice, amt);
        aliceHeld += amt;
      } else if (aliceHeld > 0n) {
        const s = aliceHeld / 2n;
        await sellTokens(env, campaign, token, env.alice, s);
        aliceHeld -= s;
      }
      const t = (await ethers.provider.getBlock("latest"))!.timestamp;
      await mineAt(t + rnd(12) * DAY + 1);
      if (rnd(3) === 0 && (await campaign.creatorEscrowClaimable()) > 0n) await campaign.connect(env.creator).claimCreatorEscrow();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const vested = await campaign.creatorEscrowVested(now);
      const claimed = await campaign.creatorEscrowClaimed();
      const total = await campaign.creatorEscrowTotal();
      expect(claimed <= vested && vested <= total).to.eq(true);
      expect(vested).to.eq(vestedModel(buys, now));
      for (const b of buys) {
        // invariant 4: nothing of a buy is released before its 30 days
        const t4 = b.at + CLIFF - 1;
        expect(await campaign.creatorEscrowVested(t4)).to.eq(vestedModel(buys.filter((x) => x !== b), t4));
      }
      // invariant 5
      const sold = await campaign.sold();
      expect(await token.balanceOf(campaignAddr)).to.eq(curveSupply - sold + liq + reserve + (total - claimed));
    }
    expect(buys.length).to.be.gt(3);
    // after the last buy + 58 d, everything is vested
    const last = buys[buys.length - 1].at;
    expect(await campaign.creatorEscrowVested(last + 58 * DAY)).to.eq(await campaign.creatorEscrowTotal());
  });
});

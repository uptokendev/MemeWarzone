import { expect } from "chai";
import { ethers } from "hardhat";
import { increaseTime, latestTs } from "./helpers/settlementAuth";
import { buildBatch } from "../scripts/make-safe-batch";
import { MONTHLY_CAP_USD_WHOLE, assertCapValue, capNativeAt, capUsdWad, replacementBatches } from "../scripts/replace-monthly-league-treasury";

/**
 * Rehearses scripts/replace-monthly-league-treasury.ts: the mainnet monthly vaults were deployed with
 * monthlyCapUsd = 30000 raw, which caps a month at a few wei. These tests use a REALISTIC oracle price
 * and a REALISTIC prize, which is what the original unit test (cap 0 -> 1.5M default) never did.
 */
const STANDARD_LINKED = 0;
const CATEGORY = ethers.keccak256(ethers.toUtf8Bytes("monthly-overall"));

function leaf(monthId: bigint, rank: number, recipient: string, amount: bigint) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "uint8", "address", "uint256"], [monthId, CATEGORY, rank, recipient, amount]));
}

async function fixture() {
  const [safe, operator, winner, creator, trader] = await ethers.getSigners();
  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const setPrice = async () => {
    const now = await latestTs();
    await feed.setRoundData(1n, ethers.parseUnits("773", 8), now, now, 1n); // BNB, 2026-09-27
  };
  await setPrice();
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 3600n);
  const charity = await (await ethers.getContractFactory("CharityTreasury")).deploy(await safe.getAddress());
  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
  // Exactly what mainnet holds: raw 30000.
  const old = await Monthly.deploy(await safe.getAddress(), await operator.getAddress(), await oracle.getAddress(), await charity.getAddress(), 30_000n);

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV3")).deploy(await safe.getAddress(), await weekly.getAddress(), await old.getAddress(), 3600);
  await router.setRecruiterRewardsVault(await (await Receiver.deploy()).getAddress());
  await router.setCommunityRewardsVault(await (await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy()).getAddress());
  await router.setProtocolRevenueVault(await (await Receiver.deploy()).getAddress());
  await router.setCreatorRewardsVault(await (await (await ethers.getContractFactory("CreatorRewardsVault")).deploy(await safe.getAddress(), await router.getAddress())).getAddress());
  const campaign = await (await ethers.getContractFactory("CreatorFeeCampaignMock")).deploy(await creator.getAddress());
  const price = BigInt(await oracle.nativeUsdPrice());
  return { safe, operator, winner, trader, oracle, charity, old, router, campaign, Monthly, setPrice, price };
}

/** Sends every transaction of the Safe Transaction Builder JSON, exactly as encoded, from the Safe. */
async function executeBatch(safe: any, batch: any) {
  for (const tx of batch.transactions) {
    await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0) })).wait();
  }
}

describe("MonthlyLeagueTreasury replacement (mainnet cap-unit fix)", function () {
  it("the deployed raw-30000 cap cannot seal a real month, and the script's value check refuses it", async () => {
    const { safe, operator, old, price } = await fixture();
    expect(capNativeAt(30_000n, price)).to.be.lessThan(100n); // a few wei, not $30k
    expect(() => assertCapValue(30_000n, price)).to.throw(/unit mistake/);
    const now = await latestTs();
    await old.connect(safe).authorizeMonth(202609n, ethers.parseEther("40"), now, now + 86_400, true);
    await safe.sendTransaction({ to: await old.getAddress(), value: ethers.parseEther("1") });
    await expect(old.connect(operator).sealMonth(202609n, leaf(202609n, 1, await operator.getAddress(), ethers.parseEther("0.5")), ethers.parseEther("0.5")))
      .to.be.revertedWithCustomError(old, "WinnerTotalAboveCap");
  });

  it("refuses cap figures outside $1..$10M before anything is deployed", () => {
    expect(() => capUsdWad(0n)).to.throw();
    expect(() => capUsdWad(10_000_001n)).to.throw();
    expect(capUsdWad()).to.equal(ethers.parseUnits("30000", 18));
  });

  it("runs M1 and M2 as written, routes fees to the new vault, and pays a real month in full", async () => {
    const { safe, operator, winner, trader, oracle, charity, old, router, campaign, Monthly, setPrice, price } = await fixture();
    await safe.sendTransaction({ to: await old.getAddress(), value: 36_239_495_805_697n }); // the BNB vault's dust

    const capUsd = capUsdWad();
    const fresh = await Monthly.deploy(await safe.getAddress(), await operator.getAddress(), await oracle.getAddress(), await charity.getAddress(), capUsd);
    const { capNative, impliedUsd } = assertCapValue(await fresh.monthlyCapUsd(), price);
    expect(impliedUsd).to.equal(MONTHLY_CAP_USD_WHOLE);
    expect(capNative).to.be.greaterThan(ethers.parseEther("38")); // $30k / $773

    const now = new Date(Number(await latestTs()) * 1000);
    const { m1, m2 } = replacementBatches({
      router: await router.getAddress(), oldVault: await old.getAddress(), newVault: await fresh.getAddress(),
      oldUnallocated: await old.unallocatedBalance(), now, months: 12, maxWinnerPool: ethers.parseEther("40"),
    });
    await executeBatch(safe, buildBatch(56, "M1", "rehearsal", m1));
    expect(await old.unallocatedBalance()).to.equal(0n);
    expect(await ethers.provider.getBalance(await fresh.getAddress())).to.equal(36_239_495_805_697n);

    // M2 is refused until the router's delay has passed, then takes.
    const m2Batch = buildBatch(56, "M2", "rehearsal", m2);
    await expect(executeBatch(safe, m2Batch)).to.be.revertedWith("delay");
    await increaseTime(3600);
    await executeBatch(safe, m2Batch);
    expect(await router.monthlyLeagueTreasury()).to.equal(await fresh.getAddress());

    // A real trade fee now lands in the new vault, not the old one.
    const before = await ethers.provider.getBalance(await fresh.getAddress());
    await campaign.connect(trader).routeTrade(await router.getAddress(), STANDARD_LINKED, { value: ethers.parseEther("2") });
    expect(await ethers.provider.getBalance(await fresh.getAddress())).to.be.greaterThan(before);
    expect(await ethers.provider.getBalance(await old.getAddress())).to.equal(0n);

    // A month of fees ($3,865 at $773), sealed and claimed in full by the operator key.
    await safe.sendTransaction({ to: await fresh.getAddress(), value: ethers.parseEther("5") });
    const monthId = BigInt(now.getUTCFullYear() * 100 + now.getUTCMonth() + 1);
    const auth = await fresh.monthAuthorization(monthId);
    expect(auth.authorized).to.equal(true);
    await increaseTime(Number(auth.sealAfter) - (await latestTs()) + 60);
    await setPrice();
    const prize = ethers.parseEther("5");
    const root = leaf(monthId, 1, await winner.getAddress(), prize);
    await fresh.connect(operator).sealMonth(monthId, root, prize);
    const winnerBefore = await ethers.provider.getBalance(await winner.getAddress());
    await fresh.connect(trader).claim(monthId, CATEGORY, 1, await winner.getAddress(), prize, []);
    expect(await ethers.provider.getBalance(await winner.getAddress())).to.equal(winnerBefore + prize);
    expect(await ethers.provider.getBalance(await charity.getAddress())).to.equal(0n); // under the cap: nothing overflowed
  });
});

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { buildBatch } from "../scripts/make-safe-batch";
import { MWL_CODES, mwlEpochId, mwlVaultSafeCalls, periodWindows } from "../scripts/deploy-mwl-payout-vaults";

/**
 * Rehearses scripts/deploy-mwl-payout-vaults.ts on a local chain with the script's own Safe calls:
 * a league share arrives in PostGradLeagueTreasuryV2 -> batch MWL1 -> claimMonthly sweeps the month
 * into the MWL monthly vault -> the root poster publishes the poker list -> every winner is paid.
 * And the safety properties the founder asked for: the hot key can never take more than one epoch's
 * authorized max, never an unauthorized epoch, never withdraw; only the Safe can.
 */
const OCT_2026 = new Date("2026-10-15T00:00:00Z");
const MWL_CATEGORY = ethers.keccak256(ethers.toUtf8Bytes("mwl"));

function leaf(epochId: bigint, rank: number, recipient: string, amount: bigint) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "uint8", "address", "uint256"], [epochId, MWL_CATEGORY, rank, recipient, amount]));
}
function pairRoot(a: string, b: string) {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

describe("MWL payout vaults (scripts/deploy-mwl-payout-vaults.ts)", () => {
  it("pays every MWL winner end to end and bounds the hot key", async () => {
    const [deployer, safe, poster, source, winner1, winner2, anyone] = await ethers.getSigners();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // Mainnet shape: the league treasury is Safe-owned and pays the Safe until MWL1 runs.
    const league = await (await ethers.getContractFactory("PostGradLeagueTreasuryV2")).deploy(safe.address, safe.address, safe.address);
    await league.connect(safe).setSource(source.address, true);
    const Vault = await ethers.getContractFactory("TreasuryVaultV2");
    const monthlyVault = await Vault.deploy(safe.address, ethers.ZeroAddress, poster.address);
    const quarterlyVault = await Vault.deploy(safe.address, ethers.ZeroAddress, poster.address);

    // One battle's league share, filed under October 2026 / Q4 2026: 60% month, 40% quarter.
    const share = ethers.parseEther("1");
    await league.connect(source).depositCompetitionShare(ethers.id("pool-1"), ethers.id("2026-10"), ethers.id("2026-Q4"), { value: share });
    expect(await league.pendingMonthlyByEpoch(ethers.id("2026-10"))).to.equal(ethers.parseEther("0.6"));

    // Batch MWL1 exactly as the script writes it, executed as the Safe.
    const calls = mwlVaultSafeCalls({
      chainId, leagueTreasury: await league.getAddress(), monthlyVault: await monthlyVault.getAddress(), quarterlyVault: await quarterlyVault.getAddress(),
      monthlyMaxWei: ethers.parseEther("3"), quarterlyMaxWei: ethers.parseEther("6"), from: OCT_2026,
    });
    expect(calls.length).to.equal(1 + 4 + 24 + 8);
    const batch = buildBatch(chainId, "MWL1 rehearsal", "rehearsal", calls);
    for (const tx of batch.transactions) await safe.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    expect(await league.monthlyReceiver()).to.equal(await monthlyVault.getAddress());
    expect(await monthlyVault.claimsPaused()).to.equal(false);

    // October is over: the sweep moves the month into the MWL vault (permissionless).
    const octoberEnd = periodWindows("monthly", OCT_2026, 1)[0].end;
    await network.provider.send("evm_setNextBlockTimestamp", [octoberEnd + 3600]);
    await league.connect(anyone).claimMonthly(ethers.id("2026-10"));
    expect(await ethers.provider.getBalance(await monthlyVault.getAddress())).to.equal(ethers.parseEther("0.6"));

    // The poker list for October (two places) under the same epoch id the API derives.
    const epochId = mwlEpochId(chainId, MWL_CODES.monthly, Date.UTC(2026, 9, 1) / 1000);
    const a1 = ethers.parseEther("0.37"), a2 = ethers.parseEther("0.23");
    const l1 = leaf(epochId, 1, winner1.address, a1), l2 = leaf(epochId, 2, winner2.address, a2);
    const root = pairRoot(l1, l2);

    // Hot key limits: above the authorized max, an unauthorized epoch, or a withdraw all fail.
    await expect(monthlyVault.connect(poster).setEpochRoot(epochId, root, ethers.parseEther("3.01"))).to.be.revertedWith("above authorized max");
    await expect(monthlyVault.connect(poster).setEpochRoot(123n, root, a1 + a2)).to.be.revertedWith("epoch not authorized");
    await expect(monthlyVault.connect(poster).withdraw(poster.address, 1n)).to.be.reverted;

    await monthlyVault.connect(poster).setEpochRoot(epochId, root, a1 + a2);
    await expect(monthlyVault.connect(poster).setEpochRoot(epochId, root, a1 + a2)).to.be.revertedWith("root already set");

    // Every winner is paid in full; a third party can trigger it, the money still goes to the winner.
    const before1 = await ethers.provider.getBalance(winner1.address);
    const before2 = await ethers.provider.getBalance(winner2.address);
    await monthlyVault.connect(anyone).claim(epochId, MWL_CATEGORY, 1, winner1.address, a1, [l2]);
    await monthlyVault.connect(anyone).claim(epochId, MWL_CATEGORY, 2, winner2.address, a2, [l1]);
    expect(await ethers.provider.getBalance(winner1.address)).to.equal(before1 + a1);
    expect(await ethers.provider.getBalance(winner2.address)).to.equal(before2 + a2);
    // A second claim of the same leaf is refused (here the empty vault's balance check fires first).
    await expect(monthlyVault.connect(anyone).claim(epochId, MWL_CATEGORY, 1, winner1.address, a1, [l2])).to.be.reverted;
    expect(await monthlyVault.epochClaimedTotal(epochId)).to.equal(await monthlyVault.epochTotal(epochId));

    // The quarterly 40% stays in the league treasury until the quarter ends, then sweeps to its own vault.
    await expect(league.connect(anyone).claimQuarterly(ethers.id("2026-Q3"))).to.be.revertedWithCustomError(league, "NothingToClaim");
    await league.connect(anyone).claimQuarterly(ethers.id("2026-Q4"));
    expect(await ethers.provider.getBalance(await quarterlyVault.getAddress())).to.equal(ethers.parseEther("0.4"));

    // Only the Safe can withdraw (e.g. to recover dust), never the poster, never a stranger.
    await expect(quarterlyVault.connect(anyone).withdraw(anyone.address, 1n)).to.be.reverted;
    await quarterlyVault.connect(safe).withdraw(safe.address, 1n);
    void deployer;
  });

  it("authorizes 24 consecutive months and 8 quarters with two-year publish windows", () => {
    const months = periodWindows("monthly", new Date("2026-11-20T00:00:00Z"), 24);
    expect(months[0].label).to.equal("2026-11");
    expect(months[1].label).to.equal("2026-12");
    expect(months[2].label).to.equal("2027-01");
    expect(months[23].label).to.equal("2028-10");
    const quarters = periodWindows("quarterly", new Date("2026-11-20T00:00:00Z"), 8);
    expect(quarters.map((q) => q.label)).to.deep.equal(["2026-Q4", "2027-Q1", "2027-Q2", "2027-Q3", "2027-Q4", "2028-Q1", "2028-Q2", "2028-Q3"]);
    expect(quarters[0].end).to.equal(Date.UTC(2027, 0, 1) / 1000);
  });

  it("derives the same epoch id as the API (api/leagueRoot.js computeEpochId, code 3 / 4)", async () => {
    const { computeEpochId } = await import("../frontend/api/leagueRoot.js");
    const start = Date.UTC(2026, 9, 1) / 1000;
    expect(mwlEpochId(56, 3, start)).to.equal(computeEpochId(56, "mwl_monthly", start));
    expect(mwlEpochId(4663, 4, Date.UTC(2026, 6, 1) / 1000)).to.equal(computeEpochId(4663, "quarterly", Date.UTC(2026, 6, 1) / 1000));
  });
});

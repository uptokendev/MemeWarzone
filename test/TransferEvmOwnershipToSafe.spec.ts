import { expect } from "chai";
import { ethers } from "hardhat";

import { transferOwnershipToSafe } from "../scripts/transfer-evm-ownership-to-safe";

describe("transfer-evm-ownership-to-safe", function () {
  async function ownables() {
    const a = await (await ethers.getContractFactory("CreatorRegistry")).deploy(); await a.waitForDeployment();
    const b = await (await ethers.getContractFactory("RiskRegistry")).deploy(); await b.waitForDeployment();
    return [await a.getAddress(), await b.getAddress()];
  }

  it("transfers every listed contract and reads each owner back", async function () {
    const [deployer, , holder] = await ethers.getSigners();
    // A contract stands in for the Safe: mainnet requires the new owner to have code.
    const safeLike = await (await ethers.getContractFactory("AcceptingReceiver")).deploy(); await safeLike.waitForDeployment();
    const contracts = await ownables();
    await transferOwnershipToSafe({ contracts, newOwner: await safeLike.getAddress(), senderAddress: await deployer.getAddress(), requireContractOwner: true, log: () => {} });
    for (const address of contracts) {
      const c = await ethers.getContractAt(["function owner() view returns (address)"], address);
      expect(await (c as any).owner()).to.equal(await safeLike.getAddress());
    }
    void holder;
  });

  it("sends nothing if any listed contract is not owned by the sender", async function () {
    const [deployer, other] = await ethers.getSigners();
    const safeLike = await (await ethers.getContractFactory("AcceptingReceiver")).deploy(); await safeLike.waitForDeployment();
    const [mine, theirs] = await ownables();
    const t = await ethers.getContractAt(["function transferOwnership(address)", "function owner() view returns (address)"], theirs);
    await (await (t as any).transferOwnership(await other.getAddress())).wait();

    let message = "";
    try {
      await transferOwnershipToSafe({ contracts: [mine, theirs], newOwner: await safeLike.getAddress(), senderAddress: await deployer.getAddress(), requireContractOwner: true, log: () => {} });
    } catch (error: any) { message = String(error?.message || error); }
    expect(message).to.match(/not the sender .* nothing was sent/);
    const m = await ethers.getContractAt(["function owner() view returns (address)"], mine);
    expect(await (m as any).owner(), "the good one was not touched either").to.equal(await deployer.getAddress());
  });

  it("on mainnet refuses an owner with no code", async function () {
    const [deployer, eoa] = await ethers.getSigners();
    const contracts = await ownables();
    let message = "";
    try {
      await transferOwnershipToSafe({ contracts, newOwner: await eoa.getAddress(), senderAddress: await deployer.getAddress(), requireContractOwner: true, log: () => {} });
    } catch (error: any) { message = String(error?.message || error); }
    expect(message).to.match(/has no code; on mainnet the owner must be the Safe/);
  });
});

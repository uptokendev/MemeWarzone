import { expect } from "chai";
import { ethers } from "hardhat";
import { deploySponsorshipV1 } from "../scripts/deploy-evm-sponsorship-v1";

describe("Sponsorship V1 deployment", function () {
  it("deploys, wires vault.router, hands both to the final owner, and refuses bad inputs", async function () {
    const [deployer, safe, signer, marketing] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(safe.address); await vault.waitForDeployment();
    const r = await deploySponsorshipV1({ deployerAddress: deployer.address, finalOwner: safe.address, quoteSigner: signer.address, marketingReceiver: marketing.address, protocolReceiver: await vault.getAddress() });
    const router = await ethers.getContractAt("WarzoneSponsorshipRouterV1", r.router);
    const prize = await ethers.getContractAt("EventPrizeVaultV1", r.vault);
    expect(await router.owner()).to.equal(safe.address);
    expect(await prize.owner()).to.equal(safe.address);
    expect(await prize.router()).to.equal(r.router);
    expect(await router.eventPrizeVault()).to.equal(r.vault);
    expect(await router.protocolReceiver()).to.equal(await vault.getAddress());
    expect(r.paymentsPaused).to.equal(false);
    // the deployer holds nothing afterwards
    await expect(router.connect(deployer).setPaymentsPaused(true)).to.be.reverted;
    await expect(prize.connect(deployer).setDepositsPaused(true)).to.be.reverted;

    await expect(deploySponsorshipV1({ deployerAddress: deployer.address, finalOwner: safe.address, quoteSigner: deployer.address, marketingReceiver: marketing.address, protocolReceiver: await vault.getAddress() })).to.be.rejectedWith(/quoteSigner must not be the deployer/);
    await expect(deploySponsorshipV1({ deployerAddress: deployer.address, finalOwner: safe.address, quoteSigner: signer.address, marketingReceiver: marketing.address, protocolReceiver: ethers.Wallet.createRandom().address })).to.be.rejectedWith(/protocolReceiver has no code/);
  });
});

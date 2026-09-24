import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

import { deploySponsorshipV1 } from "../scripts/deploy-evm-sponsorship-v1";
import { sponsorshipEventBatch, sponsorshipEventId } from "../scripts/make-sponsorship-event-batch";

describe("Sponsorship event Safe batch", function () {
  it("derives the same eventId the API signs, and the generated calls open the event on a Safe-owned router + vault", async function () {
    const api = fs.readFileSync(path.resolve(__dirname, "..", "frontend", "api", "lib", "arenaSponsorshipRuntime.mjs"), "utf8");
    expect(api).to.match(/return id\(`warzone-sponsorship-event:\$\{value\}`\);/);

    const [deployer, safe, signer, marketing, receiver] = await ethers.getSigners();
    const protocolVault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(safe.address);
    await protocolVault.waitForDeployment();
    const r = await deploySponsorshipV1({ deployerAddress: deployer.address, finalOwner: safe.address, quoteSigner: signer.address, marketingReceiver: marketing.address, protocolReceiver: await protocolVault.getAddress() });

    const uuid = "3f1c2b8e-9a41-4d7e-8f0a-2c5b6d7e8f90";
    const { eventId, batch } = sponsorshipEventBatch({ chainId: 31337, router: r.router, vault: r.vault, eventUuid: uuid, receiver: receiver.address });
    expect(eventId).to.equal(ethers.id(`warzone-sponsorship-event:${uuid}`));
    expect(batch.transactions).to.have.length(2);

    const router = await ethers.getContractAt("WarzoneSponsorshipRouterV1", r.router);
    const vault = await ethers.getContractAt("EventPrizeVaultV1", r.vault);
    expect(await router.enabledEvents(eventId)).to.equal(false);
    for (const tx of batch.transactions) await safe.sendTransaction({ to: tx.to, data: tx.data, value: 0 });
    expect(await router.enabledEvents(eventId)).to.equal(true);
    expect(await vault.eventReceivers(eventId)).to.equal(receiver.address);
  });

  it("refuses a non-uuid event id and a zero receiver", function () {
    expect(() => sponsorshipEventId("tournament-42")).to.throw(/must be a uuid/);
    expect(() => sponsorshipEventBatch({ chainId: 56, router: ethers.ZeroAddress, vault: ethers.ZeroAddress, eventUuid: "3f1c2b8e-9a41-4d7e-8f0a-2c5b6d7e8f90", receiver: ethers.ZeroAddress })).to.throw(/receiver/);
    const treasury = "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238";
    expect(() => sponsorshipEventBatch({ chainId: 4663, router: ethers.ZeroAddress, vault: ethers.ZeroAddress, eventUuid: "3f1c2b8e-9a41-4d7e-8f0a-2c5b6d7e8f90", receiver: treasury, forbiddenReceivers: [treasury] })).to.throw(/could never call claimEventPrize/);
  });
});

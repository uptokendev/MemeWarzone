import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Audit-grade coverage for the EVM sponsorship rail before its first deployment:
 * EventPrizeVaultV1 (router-only credits, pull claims) and
 * WarzoneSponsorshipRouterV1 (EIP-712 quote, 70/20/10, per-sender nonces).
 * Every money path is checked against balances that moved, not events alone.
 */
const TIER = ethers.id("tier:gold");
const EVENT = ethers.id("event:launch-week");

async function fixture() {
  const [owner, signerWallet, sponsor, marketing, protocol, eventReceiver, stranger] = await ethers.getSigners();
  const Vault = await ethers.getContractFactory("EventPrizeVaultV1");
  const vault = await Vault.deploy(owner.address); await vault.waitForDeployment();
  const Router = await ethers.getContractFactory("WarzoneSponsorshipRouterV1");
  const router = await Router.deploy(owner.address, signerWallet.address, await vault.getAddress(), marketing.address, protocol.address);
  await router.waitForDeployment();
  await (await vault.setRouter(await router.getAddress())).wait();
  await (await vault.setEventReceiver(EVENT, eventReceiver.address)).wait();
  await (await router.setEventEnabled(EVENT, true)).wait();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { name: "WarzoneSponsorshipRouter", version: "1", chainId, verifyingContract: await router.getAddress() };
  const types = { SponsorshipQuote: [
    { name: "eventId", type: "bytes32" }, { name: "sponsor", type: "address" }, { name: "pricingTier", type: "bytes32" }, { name: "pricingVersion", type: "uint256" },
    { name: "minimumUsdMicros", type: "uint256" }, { name: "requestedUsdMicros", type: "uint256" }, { name: "minimumNativeRaw", type: "uint256" }, { name: "requestedNativeRaw", type: "uint256" },
    { name: "nativeUsdReferenceMicros", type: "uint256" }, { name: "oracleTimestamp", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const quote = async (overrides: Record<string, any> = {}, signer = signerWallet) => {
    const q = { eventId: EVENT, sponsor: sponsor.address, pricingTier: TIER, pricingVersion: 1n, minimumUsdMicros: 500_000_000n, requestedUsdMicros: 500_000_000n, minimumNativeRaw: ethers.parseEther("0.5"), requestedNativeRaw: ethers.parseEther("0.5"), nativeUsdReferenceMicros: 1_000_000_000n, oracleTimestamp: BigInt(now), nonce: 1n, deadline: BigInt(now + 3600), ...overrides };
    const signature = await signer.signTypedData(domain, types, q);
    return { q, signature };
  };
  const pay = (q: any, signature: string, value = q.requestedNativeRaw, from = sponsor) =>
    router.connect(from).paySponsorship(q.eventId, q.pricingTier, q.pricingVersion, q.minimumUsdMicros, q.requestedUsdMicros, q.minimumNativeRaw, q.requestedNativeRaw, q.nativeUsdReferenceMicros, q.oracleTimestamp, q.nonce, q.deadline, signature, { value });
  return { owner, signerWallet, sponsor, marketing, protocol, eventReceiver, stranger, vault, router, quote, pay, now };
}

describe("WarzoneSponsorshipRouterV1 + EventPrizeVaultV1", function () {
  it("splits a signed sponsorship 70/20/10 by balances, credits the event, and the receiver pulls the prize", async function () {
    const f = await fixture();
    const { q, signature } = await f.quote();
    const before = { m: await ethers.provider.getBalance(f.marketing.address), p: await ethers.provider.getBalance(f.protocol.address), v: await ethers.provider.getBalance(await f.vault.getAddress()) };
    await expect(f.pay(q, signature)).to.emit(f.router, "SponsorshipPaid");
    const value = q.requestedNativeRaw;
    expect((await ethers.provider.getBalance(f.marketing.address)) - before.m).to.equal(value * 2000n / 10000n);
    expect((await ethers.provider.getBalance(f.protocol.address)) - before.p).to.equal(value * 1000n / 10000n);
    expect((await ethers.provider.getBalance(await f.vault.getAddress())) - before.v).to.equal(value * 7000n / 10000n);
    expect(await f.vault.eventBalances(EVENT)).to.equal(value * 7000n / 10000n);
    expect(await ethers.provider.getBalance(await f.router.getAddress())).to.equal(0n); // router keeps nothing

    await expect(f.vault.connect(f.stranger).claimEventPrize(EVENT)).to.be.revertedWithCustomError(f.vault, "Unauthorized");
    const rb = await ethers.provider.getBalance(f.eventReceiver.address);
    const tx = await f.vault.connect(f.eventReceiver).claimEventPrize(EVENT); const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect((await ethers.provider.getBalance(f.eventReceiver.address)) - rb + gas).to.equal(value * 7000n / 10000n);
    expect(await f.vault.eventBalances(EVENT)).to.equal(0n);
    await expect(f.vault.connect(f.eventReceiver).claimEventPrize(EVENT)).to.be.revertedWithCustomError(f.vault, "NothingToClaim");
  });

  it("refuses replay, a foreign signer, an expired quote, a disabled event, a paused router, and a wrong value", async function () {
    const f = await fixture();
    const { q, signature } = await f.quote();
    await (await f.pay(q, signature)).wait();
    await expect(f.pay(q, signature)).to.be.revertedWithCustomError(f.router, "Replay");

    const forged = await f.quote({ nonce: 2n }, f.stranger);
    await expect(f.pay(forged.q, forged.signature)).to.be.revertedWithCustomError(f.router, "BadSignature");

    const tampered = await f.quote({ nonce: 3n });
    await expect(f.pay({ ...tampered.q, requestedUsdMicros: tampered.q.requestedUsdMicros + 1n }, tampered.signature)).to.be.revertedWithCustomError(f.router, "BadSignature");

    const expired = await f.quote({ nonce: 4n, deadline: BigInt(f.now - 1) });
    await expect(f.pay(expired.q, expired.signature)).to.be.revertedWithCustomError(f.router, "QuoteExpired");

    const short = await f.quote({ nonce: 5n });
    await expect(f.pay(short.q, short.signature, short.q.requestedNativeRaw - 1n)).to.be.revertedWithCustomError(f.router, "InvalidAmount");

    const other = await f.quote({ nonce: 6n, eventId: ethers.id("event:unknown") });
    await expect(f.pay(other.q, other.signature)).to.be.revertedWithCustomError(f.router, "InvalidEvent");

    await (await f.router.setPaymentsPaused(true)).wait();
    const paused = await f.quote({ nonce: 7n });
    await expect(f.pay(paused.q, paused.signature)).to.be.revertedWithCustomError(f.router, "PaymentsArePaused");
    await (await f.router.setPaymentsPaused(false)).wait();

    // A quote signed for one sponsor cannot be spent by another (sponsor is in the digest).
    const mine = await f.quote({ nonce: 8n });
    await expect(f.pay(mine.q, mine.signature, mine.q.requestedNativeRaw, f.stranger)).to.be.revertedWithCustomError(f.router, "BadSignature");
  });

  it("vault: only the router credits, only for events with a receiver, never while paused; stray ETH is refused by both", async function () {
    const f = await fixture();
    await expect(f.vault.connect(f.stranger).depositForEvent(EVENT, { value: 1n })).to.be.revertedWithCustomError(f.vault, "Unauthorized");
    await expect(f.owner.sendTransaction({ to: await f.vault.getAddress(), value: 1n })).to.be.revertedWithCustomError(f.vault, "InvalidAmount");
    await expect(f.owner.sendTransaction({ to: await f.router.getAddress(), value: 1n })).to.be.revertedWithCustomError(f.router, "InvalidAmount");

    const noReceiver = ethers.id("event:no-receiver");
    await (await f.router.setEventEnabled(noReceiver, true)).wait();
    const q1 = await f.quote({ nonce: 9n, eventId: noReceiver });
    await expect(f.pay(q1.q, q1.signature)).to.be.revertedWithCustomError(f.vault, "InvalidEvent");

    await (await f.vault.setDepositsPaused(true)).wait();
    const q2 = await f.quote({ nonce: 10n });
    await expect(f.pay(q2.q, q2.signature)).to.be.revertedWithCustomError(f.vault, "DepositsArePaused");

    await expect(f.vault.connect(f.stranger).setRouter(f.stranger.address)).to.be.reverted;
    await expect(f.router.connect(f.stranger).setQuoteSigner(f.stranger.address)).to.be.reverted;
  });

  it("owner can rotate the signer and receivers; the split follows the new receivers", async function () {
    const f = await fixture();
    const [, , , , , , , newSigner, newMarketing, newProtocol] = await ethers.getSigners();
    await (await f.router.setQuoteSigner(newSigner.address)).wait();
    await (await f.router.setReceivers(newMarketing.address, newProtocol.address)).wait();
    const old = await f.quote({ nonce: 11n });
    await expect(f.pay(old.q, old.signature)).to.be.revertedWithCustomError(f.router, "BadSignature");
    const fresh = await f.quote({ nonce: 12n }, newSigner);
    const bm = await ethers.provider.getBalance(newMarketing.address), bp = await ethers.provider.getBalance(newProtocol.address);
    await (await f.pay(fresh.q, fresh.signature)).wait();
    expect((await ethers.provider.getBalance(newMarketing.address)) - bm).to.equal(fresh.q.requestedNativeRaw * 2000n / 10000n);
    expect((await ethers.provider.getBalance(newProtocol.address)) - bp).to.equal(fresh.q.requestedNativeRaw * 1000n / 10000n);
  });
});

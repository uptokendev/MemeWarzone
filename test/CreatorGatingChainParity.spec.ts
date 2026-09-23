import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The EVM creator gating has to be the Solana creator gating.
 *
 * programs/memewarzone_solana/src/lib.rs carries the same model on chain:
 * a creator profile with live_bonding_count, a per-tier max_live_bonding_count
 * and cooldown_seconds. The constants there are
 *
 *   TIER_COOLDOWN_SECONDS   = 86_400
 *   TIER_1_MAX_LIVE_BONDING = 3
 *   TIER_2_MAX_LIVE_BONDING = 5
 *   TIER_3_MAX_LIVE_BONDING = 10
 *
 * and CreatorRegistry's three tiers must agree with them, because a creator
 * rate-limited on one chain and not the other is the same account getting two
 * different answers from one product. Nothing enforced that agreement, so this
 * does: both sides are hard-coded, and the only way to keep them together is to
 * fail when they part.
 */
describe("creator gating parity with Solana", function () {
  const SOLANA_TIER_COOLDOWN_SECONDS = 86_400n;
  const SOLANA_TIER_MAX_LIVE_BONDING = [3n, 5n, 10n];

  // CreatorTier: 0 Unknown, 1 NewCreator, 2 TrustedCreator, 3 ProvenCreator.
  const TIERS = [
    { name: "NewCreator", tier: 1, solanaIndex: 0 },
    { name: "TrustedCreator", tier: 2, solanaIndex: 1 },
    { name: "ProvenCreator", tier: 3, solanaIndex: 2 },
  ];

  async function registry() {
    const deployed = await (await ethers.getContractFactory("CreatorRegistry")).deploy();
    await deployed.waitForDeployment();
    return deployed;
  }

  it("matches Solana's per-tier live-campaign caps and cooldown", async function () {
    const creatorRegistry = await registry();
    const [, creator] = await ethers.getSigners();

    for (const { name, tier, solanaIndex } of TIERS) {
      await (await (creatorRegistry as any).setCreatorTier(await creator.getAddress(), tier)).wait();
      const rules = await (creatorRegistry as any).getCreatorRules(await creator.getAddress());
      expect(rules.maxLiveBonding, `${name} maxLiveBonding`).to.equal(SOLANA_TIER_MAX_LIVE_BONDING[solanaIndex]);
      expect(rules.cooldownSeconds, `${name} cooldownSeconds`).to.equal(SOLANA_TIER_COOLDOWN_SECONDS);
    }
  });

  it("treats an unknown creator as the lowest tier, not as ungated", async function () {
    const creatorRegistry = await registry();
    const [, , stranger] = await ethers.getSigners();

    // Solana's profile defaults the same way: a creator nobody has classified
    // gets tier 1's limits, not unlimited launches.
    const rules = await (creatorRegistry as any).getCreatorRules(await stranger.getAddress());
    expect(rules.maxLiveBonding).to.equal(SOLANA_TIER_MAX_LIVE_BONDING[0]);
    expect(rules.cooldownSeconds).to.equal(SOLANA_TIER_COOLDOWN_SECONDS);
  });

  it("an empty registry gates rather than blocks: the first launch goes through", async function () {
    const creatorRegistry = await registry();
    const [owner, creator] = await ethers.getSigners();

    // The question that decides whether enabling registries on a live factory
    // is safe. A fresh registry must let a first-time creator launch; only the
    // second launch inside the cooldown may be refused.
    await (await (creatorRegistry as any).setLaunchRecorder(await owner.getAddress(), true)).wait();
    await (await (creatorRegistry as any).recordLaunch(await creator.getAddress())).wait();

    await expect((creatorRegistry as any).recordLaunch(await creator.getAddress()))
      .to.be.revertedWithCustomError(creatorRegistry, "CreatorCooldown");

    const profile = await (creatorRegistry as any).getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.equal(1n);
  });
});

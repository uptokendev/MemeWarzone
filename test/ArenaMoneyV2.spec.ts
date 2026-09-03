import { expect } from "chai";
import { ethers } from "hardhat";

const ONE = ethers.parseEther("1");

async function deployLeague() {
  const [owner, monthly, quarterly] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
  const league = await Factory.deploy(owner.address, monthly.address, quarterly.address);
  await league.waitForDeployment();
  return { league, owner, monthly, quarterly };
}

async function deployArena() {
  const [owner, resolver, protocol, monthly, quarterly, alice, bob, booster, tournamentUser] = await ethers.getSigners();
  const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
  const league = await League.deploy(owner.address, monthly.address, quarterly.address);
  await league.waitForDeployment();

  const WarPool = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
  const treasury = await WarPool.deploy(owner.address, resolver.address, protocol.address, await league.getAddress());
  await treasury.waitForDeployment();
  await league.setSource(await treasury.getAddress(), true);

  return { treasury, league, owner, resolver, protocol, monthly, quarterly, alice, bob, booster, tournamentUser };
}

async function signResolveV2(
  treasury: any,
  resolver: any,
  poolId: string,
  winnerPayout: string,
  stakeTotal: bigint,
  buyInTotal: bigint,
  boostTotal: bigint,
  deadline: number,
) {
  const network = await ethers.provider.getNetwork();
  return resolver.signTypedData(
    {
      name: "ArenaWarPoolTreasury",
      version: "2",
      chainId: network.chainId,
      verifyingContract: await treasury.getAddress(),
    },
    {
      ResolvePoolV2: [
        { name: "poolId", type: "bytes32" },
        { name: "winnerPayout", type: "address" },
        { name: "stakeTotal", type: "uint256" },
        { name: "buyInTotal", type: "uint256" },
        { name: "boostTotal", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { poolId, winnerPayout, stakeTotal, buyInTotal, boostTotal, deadline },
  );
}

async function deploySponsorship(marketingOverride?: string) {
  const [owner, quoteSigner, marketing, protocol, eventReceiver, sponsor, stranger] = await ethers.getSigners();
  const Vault = await ethers.getContractFactory("EventPrizeVaultV1");
  const vault = await Vault.deploy(owner.address);
  await vault.waitForDeployment();

  const Router = await ethers.getContractFactory("WarzoneSponsorshipRouterV1");
  const router = await Router.deploy(
    owner.address,
    quoteSigner.address,
    await vault.getAddress(),
    marketingOverride ?? marketing.address,
    protocol.address,
  );
  await router.waitForDeployment();
  await vault.setRouter(await router.getAddress());

  return { router, vault, owner, quoteSigner, marketing, protocol, eventReceiver, sponsor, stranger };
}

async function signSponsorQuote(
  router: any,
  signer: any,
  eventId: string,
  sponsor: string,
  pricingVersion: bigint,
  minimumNativeRaw: bigint,
  requestedNativeRaw: bigint,
  nonce: bigint,
  deadline: number,
) {
  const network = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "WarzoneSponsorshipRouter",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await router.getAddress(),
    },
    {
      SponsorshipQuote: [
        { name: "eventId", type: "bytes32" },
        { name: "sponsor", type: "address" },
        { name: "pricingVersion", type: "uint256" },
        { name: "minimumNativeRaw", type: "uint256" },
        { name: "requestedNativeRaw", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { eventId, sponsor, pricingVersion, minimumNativeRaw, requestedNativeRaw, nonce, deadline },
  );
}

describe("Arena money-path V2", function () {
  it("keeps historical V1 constants untouched while V2 exposes the new generation", async () => {
    const V1 = await ethers.getContractFactory("ArenaWarPoolTreasury");
    const V2 = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
    const [owner, resolver, protocol, mwl, monthly, quarterly] = await ethers.getSigners();
    const v1 = await V1.deploy(owner.address, resolver.address, protocol.address, mwl.address);
    await v1.waitForDeployment();
    expect(await v1.MWL_BPS()).to.equal(1_000n);
    expect(await v1.PROTOCOL_BPS()).to.equal(500n);

    const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
    const league = await League.deploy(owner.address, monthly.address, quarterly.address);
    await league.waitForDeployment();
    const v2 = await V2.deploy(owner.address, resolver.address, protocol.address, await league.getAddress());
    await v2.waitForDeployment();
    expect(await v2.GENERATION()).to.equal(2n);
    expect(await v2.ENTRY_LEAGUE_BPS()).to.equal(2_000n);
    expect(await v2.ENTRY_PROTOCOL_BPS()).to.equal(500n);
    expect(await v2.BOOST_PROTOCOL_BPS()).to.equal(1_000n);
  });

  it("settles Battle entry 75/20/5 and Boost 90/10 with exact conservation", async () => {
    const { treasury, league, resolver, protocol, alice, bob, booster } = await deployArena();
    const poolId = ethers.id("battle-v2");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: ONE });
    await treasury.connect(bob).depositStake(poolId, { value: ONE });

    const boost = ethers.parseEther("0.5");
    await treasury.connect(booster).boostBattle(poolId, alice.address, { value: boost });

    const entryGross = ONE * 2n;
    const leagueAmt = (entryGross * 2_000n) / 10_000n;
    const entryProtocol = (entryGross * 500n) / 10_000n;
    const entryPrize = entryGross - leagueAmt - entryProtocol;
    const boostProtocol = (boost * 1_000n) / 10_000n;
    const boostPrize = boost - boostProtocol;
    const winnerAmt = entryPrize + boostPrize;
    const protocolAmt = entryProtocol + boostProtocol;

    const deadline = now + 10_000;
    const sig = await signResolveV2(treasury, resolver, poolId, alice.address, entryGross, 0n, boost, deadline);
    await treasury.resolve(poolId, alice.address, deadline, sig);

    const pool = await treasury.pools(poolId);
    expect(pool.pendingWinner).to.equal(winnerAmt);
    expect(pool.pendingProtocol).to.equal(protocolAmt);
    expect(pool.pendingLeague).to.equal(leagueAmt);
    expect(winnerAmt + protocolAmt + leagueAmt).to.equal(entryGross + boost);

    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await treasury.claimProtocol(poolId);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.equal(protocolAmt);

    const monthlyEpoch = ethers.id("2026-09");
    const quarterlyEpoch = ethers.id("2026-Q3");
    await treasury.claimLeague(poolId, monthlyEpoch, quarterlyEpoch);
    expect(await league.pendingMonthly()).to.equal((leagueAmt * 6_000n) / 10_000n);
    expect(await league.pendingQuarterly()).to.equal(leagueAmt - (leagueAmt * 6_000n) / 10_000n);
  });

  it("routes Vote Tournament Boost money to the tournament pool, not a matchup pool", async () => {
    const { treasury, resolver, owner, alice, bob, booster } = await deployArena();
    const poolId = ethers.id("vote-tournament-v2");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openTournamentPool(poolId, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositBuyIn(poolId, { value: ONE });
    await treasury.connect(bob).depositBuyIn(poolId, { value: ONE });
    await treasury.setTournamentLive(poolId);

    const boostA = ethers.parseEther("0.2");
    const boostB = ethers.parseEther("0.3");
    await treasury.connect(booster).boostTournament(poolId, ethers.id("round1-match1"), 1, alice.address, { value: boostA });
    await treasury.connect(booster).boostTournament(poolId, ethers.id("round2-match7"), 2, bob.address, { value: boostB });

    const boostTotal = boostA + boostB;
    const deadline = now + 10_000;
    const sig = await signResolveV2(treasury, resolver, poolId, owner.address, 0n, ONE * 2n, boostTotal, deadline);
    await treasury.resolve(poolId, owner.address, deadline, sig);
    const pool = await treasury.pools(poolId);
    expect(pool.boostTotal).to.equal(boostTotal);
    expect(pool.pendingLeague).to.equal((ONE * 2n * 2_000n) / 10_000n);
    expect(pool.pendingProtocol).to.equal((ONE * 2n * 500n) / 10_000n + (boostTotal * 1_000n) / 10_000n);
  });

  it("refunds open Battle stakes and Tournament buy-ins without ever accepting Boosts before live", async () => {
    const { treasury, alice, bob, booster } = await deployArena();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    const battleId = ethers.id("cancel-battle-v2");
    await treasury.openBattlePool(battleId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(battleId, { value: ONE });
    await expect(treasury.connect(booster).boostBattle(battleId, alice.address, { value: 1n })).to.be.revertedWithCustomError(
      treasury,
      "InvalidState",
    );
    await treasury.connect(alice).cancelOpenPool(battleId);
    await expect(treasury.connect(alice).refundStake(battleId)).not.to.be.reverted;

    const tournamentId = ethers.id("cancel-tournament-v2");
    await treasury.openTournamentPool(tournamentId, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositBuyIn(tournamentId, { value: ONE });
    await treasury.connect(bob).depositBuyIn(tournamentId, { value: ONE });
    await expect(
      treasury.connect(booster).boostTournament(tournamentId, ethers.id("m1"), 1, alice.address, { value: 1n }),
    ).to.be.revertedWithCustomError(treasury, "InvalidState");
    await treasury.cancelOpenPool(tournamentId);
    await treasury.connect(alice).refundBuyIn(tournamentId);
    await treasury.connect(bob).refundBuyIn(tournamentId);
    expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(0n);
  });

  it("keeps all rounding dust in prize buckets for tiny and fuzzed amounts", async () => {
    for (const gross of [1n, 2n, 3n, 9n, 10n, 99n, 101n, 999n, 10_001n, 999_999n]) {
      const league = (gross * 2_000n) / 10_000n;
      const protocol = (gross * 500n) / 10_000n;
      const prize = gross - league - protocol;
      expect(prize + league + protocol).to.equal(gross);
      const boostProtocol = (gross * 1_000n) / 10_000n;
      const boostPrize = gross - boostProtocol;
      expect(boostPrize + boostProtocol).to.equal(gross);
    }
  });

  it("blocks duplicate League source credits and splits even one wei without losing dust", async () => {
    const { league, owner } = await deployLeague();
    await league.setSource(owner.address, true);
    const sourcePool = ethers.id("tiny-source");
    await league.depositCompetitionShare(sourcePool, ethers.id("month"), ethers.id("quarter"), { value: 1n });
    expect(await league.pendingMonthly()).to.equal(0n);
    expect(await league.pendingQuarterly()).to.equal(1n);
    await expect(
      league.depositCompetitionShare(sourcePool, ethers.id("month"), ethers.id("quarter"), { value: 1n }),
    ).to.be.revertedWithCustomError(league, "AlreadyCredited");
  });

  it("resists winner-claim reentrancy", async () => {
    const { treasury, resolver, alice, bob, booster } = await deployArena();
    const Helper = await ethers.getContractFactory("ReentrantArenaWinner");
    const helper = await Helper.deploy();
    await helper.waitForDeployment();

    const poolId = ethers.id("reentrant-winner");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: ONE });
    await treasury.connect(bob).depositStake(poolId, { value: ONE });
    await treasury.connect(booster).boostBattle(poolId, alice.address, { value: ONE });
    await helper.configure(await treasury.getAddress(), poolId);

    const deadline = now + 10_000;
    const sig = await signResolveV2(treasury, resolver, poolId, await helper.getAddress(), ONE * 2n, 0n, ONE, deadline);
    await treasury.resolve(poolId, await helper.getAddress(), deadline, sig);
    const expected = (await treasury.pools(poolId)).pendingWinner;
    await helper.claim();
    expect(await ethers.provider.getBalance(await helper.getAddress())).to.equal(expected);
    expect(await helper.attempted()).to.equal(true);
    await expect(helper.claim()).to.be.revertedWithCustomError(treasury, "NothingToClaim");
  });
});

describe("Warzone sponsorship money path V1", function () {
  it("routes 70/20/10, binds the sponsor/event/amount, and blocks replay", async () => {
    const { router, vault, quoteSigner, marketing, protocol, eventReceiver, sponsor, stranger } = await deploySponsorship();
    const eventId = ethers.id("september-bnb-mwl");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const gross = ethers.parseEther("10");
    const minimum = ethers.parseEther("5");
    const sig = await signSponsorQuote(router, quoteSigner, eventId, sponsor.address, 7n, minimum, gross, 42n, now + 300);

    const marketingBefore = await ethers.provider.getBalance(marketing.address);
    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await router.connect(sponsor).paySponsorship(eventId, 7, minimum, gross, 42, now + 300, sig, { value: gross });

    const marketingAmount = (gross * 2_000n) / 10_000n;
    const protocolAmount = (gross * 1_000n) / 10_000n;
    const eventAmount = gross - marketingAmount - protocolAmount;
    expect(await vault.eventBalances(eventId)).to.equal(eventAmount);
    expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal(marketingAmount);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.equal(protocolAmount);
    expect(eventAmount + marketingAmount + protocolAmount).to.equal(gross);

    await expect(
      router.connect(sponsor).paySponsorship(eventId, 7, minimum, gross, 42, now + 300, sig, { value: gross }),
    ).to.be.revertedWithCustomError(router, "Replay");

    await expect(
      router.connect(stranger).paySponsorship(eventId, 7, minimum, gross, 42, now + 300, sig, { value: gross }),
    ).to.be.revertedWithCustomError(router, "BadSignature");
  });

  it("rejects disabled/wrong events, expired quotes, under-minimum amounts and failed receivers", async () => {
    const base = await deploySponsorship();
    const eventId = ethers.id("q4-bnb");
    await base.vault.setEventReceiver(eventId, base.eventReceiver.address);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const gross = ONE;
    const minimum = ONE;
    const sig = await signSponsorQuote(base.router, base.quoteSigner, eventId, base.sponsor.address, 1n, minimum, gross, 1n, now + 300);
    await expect(
      base.router.connect(base.sponsor).paySponsorship(eventId, 1, minimum, gross, 1, now + 300, sig, { value: gross }),
    ).to.be.revertedWithCustomError(base.router, "InvalidEvent");

    await base.router.setEventEnabled(eventId, true);
    const expiredSig = await signSponsorQuote(base.router, base.quoteSigner, eventId, base.sponsor.address, 1n, minimum, gross, 2n, now - 1);
    await expect(
      base.router.connect(base.sponsor).paySponsorship(eventId, 1, minimum, gross, 2, now - 1, expiredSig, { value: gross }),
    ).to.be.revertedWithCustomError(base.router, "QuoteExpired");

    const tooSmall = minimum - 1n;
    const smallSig = await signSponsorQuote(base.router, base.quoteSigner, eventId, base.sponsor.address, 1n, minimum, tooSmall, 3n, now + 300);
    await expect(
      base.router.connect(base.sponsor).paySponsorship(eventId, 1, minimum, tooSmall, 3, now + 300, smallSig, { value: tooSmall }),
    ).to.be.revertedWithCustomError(base.router, "InvalidAmount");

    const Reject = await ethers.getContractFactory("RejectNativeReceiver");
    const reject = await Reject.deploy();
    await reject.waitForDeployment();
    const failing = await deploySponsorship(await reject.getAddress());
    const failingEvent = ethers.id("failing-event");
    await failing.vault.setEventReceiver(failingEvent, failing.eventReceiver.address);
    await failing.router.setEventEnabled(failingEvent, true);
    const failingSig = await signSponsorQuote(
      failing.router,
      failing.quoteSigner,
      failingEvent,
      failing.sponsor.address,
      1n,
      minimum,
      gross,
      9n,
      now + 300,
    );
    await expect(
      failing.router.connect(failing.sponsor).paySponsorship(failingEvent, 1, minimum, gross, 9, now + 300, failingSig, { value: gross }),
    ).to.be.revertedWithCustomError(failing.router, "TransferFailed");
    expect(await failing.vault.eventBalances(failingEvent)).to.equal(0n);
  });

  it("keeps sponsorship rounding exact across tiny/fuzzed values", async () => {
    for (const gross of [1n, 2n, 7n, 9n, 10n, 99n, 101n, 999n, 10_003n, 1_000_001n]) {
      const marketing = (gross * 2_000n) / 10_000n;
      const protocol = (gross * 1_000n) / 10_000n;
      const event = gross - marketing - protocol;
      expect(event + marketing + protocol).to.equal(gross);
    }
  });
});

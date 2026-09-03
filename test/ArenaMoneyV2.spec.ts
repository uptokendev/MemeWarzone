import { expect } from "chai";
import { ethers } from "hardhat";

const ONE = ethers.parseEther("1");
const FOUNDING = ethers.id("FOUNDING");
const MIN_USD_MICROS = 49_000_000n;
const REQUESTED_USD_MICROS = 100_000_000n;
const NATIVE_USD_REFERENCE_MICROS = 600_000_000n;

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

type SponsorQuote = {
  eventId: string;
  sponsor: string;
  pricingTier: string;
  pricingVersion: bigint;
  minimumUsdMicros: bigint;
  requestedUsdMicros: bigint;
  minimumNativeRaw: bigint;
  requestedNativeRaw: bigint;
  nativeUsdReferenceMicros: bigint;
  oracleTimestamp: bigint;
  nonce: bigint;
  deadline: bigint;
};

async function signSponsorQuote(router: any, signer: any, quote: SponsorQuote) {
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
        { name: "pricingTier", type: "bytes32" },
        { name: "pricingVersion", type: "uint256" },
        { name: "minimumUsdMicros", type: "uint256" },
        { name: "requestedUsdMicros", type: "uint256" },
        { name: "minimumNativeRaw", type: "uint256" },
        { name: "requestedNativeRaw", type: "uint256" },
        { name: "nativeUsdReferenceMicros", type: "uint256" },
        { name: "oracleTimestamp", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    quote,
  );
}

async function paySponsor(router: any, sponsor: any, quote: SponsorQuote, signature: string) {
  return router.connect(sponsor).paySponsorship(
    quote.eventId,
    quote.pricingTier,
    quote.pricingVersion,
    quote.minimumUsdMicros,
    quote.requestedUsdMicros,
    quote.minimumNativeRaw,
    quote.requestedNativeRaw,
    quote.nativeUsdReferenceMicros,
    quote.oracleTimestamp,
    quote.nonce,
    quote.deadline,
    signature,
    { value: quote.requestedNativeRaw },
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
    const { treasury, league, resolver, protocol, monthly, quarterly, alice, bob, booster } = await deployArena();
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
    const monthlyAmt = (leagueAmt * 6_000n) / 10_000n;
    const quarterlyAmt = leagueAmt - monthlyAmt;
    expect(await league.pendingMonthly()).to.equal(monthlyAmt);
    expect(await league.pendingQuarterly()).to.equal(quarterlyAmt);
    expect(await league.pendingMonthlyByEpoch(monthlyEpoch)).to.equal(monthlyAmt);
    expect(await league.pendingQuarterlyByEpoch(quarterlyEpoch)).to.equal(quarterlyAmt);

    const monthlyBefore = await ethers.provider.getBalance(monthly.address);
    await league.claimMonthly(monthlyEpoch);
    expect((await ethers.provider.getBalance(monthly.address)) - monthlyBefore).to.equal(monthlyAmt);
    expect(await league.pendingMonthlyByEpoch(monthlyEpoch)).to.equal(0n);
    await expect(league.claimMonthly(monthlyEpoch)).to.be.revertedWithCustomError(league, "NothingToClaim");

    const quarterlyBefore = await ethers.provider.getBalance(quarterly.address);
    await league.claimQuarterly(quarterlyEpoch);
    expect((await ethers.provider.getBalance(quarterly.address)) - quarterlyBefore).to.equal(quarterlyAmt);
    expect(await league.pendingQuarterlyByEpoch(quarterlyEpoch)).to.equal(0n);
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
    await expect(
      treasury.connect(booster).boostTournament(poolId, ethers.id("round1-match1"), 1, alice.address, { value: boostA }),
    )
      .to.emit(treasury, "TournamentBoosted")
      .withArgs(poolId, ethers.id("round1-match1"), 1, booster.address, alice.address, boostA);
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
    const month = ethers.id("month");
    const quarter = ethers.id("quarter");
    await league.depositCompetitionShare(sourcePool, month, quarter, { value: 1n });
    expect(await league.pendingMonthly()).to.equal(0n);
    expect(await league.pendingQuarterly()).to.equal(1n);
    expect(await league.pendingMonthlyByEpoch(month)).to.equal(0n);
    expect(await league.pendingQuarterlyByEpoch(quarter)).to.equal(1n);
    await expect(
      league.depositCompetitionShare(sourcePool, month, quarter, { value: 1n }),
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
  it("routes 70/20/10, binds the full pricing snapshot, and blocks replay", async () => {
    const { router, vault, quoteSigner, marketing, protocol, eventReceiver, sponsor, stranger } = await deploySponsorship();
    const eventId = ethers.id("september-bnb-mwl");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);

    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const gross = ethers.parseEther("10");
    const quote: SponsorQuote = {
      eventId,
      sponsor: sponsor.address,
      pricingTier: FOUNDING,
      pricingVersion: 7n,
      minimumUsdMicros: MIN_USD_MICROS,
      requestedUsdMicros: REQUESTED_USD_MICROS,
      minimumNativeRaw: ethers.parseEther("5"),
      requestedNativeRaw: gross,
      nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS,
      oracleTimestamp: now,
      nonce: 42n,
      deadline: now + 300n,
    };
    const sig = await signSponsorQuote(router, quoteSigner, quote);

    const marketingBefore = await ethers.provider.getBalance(marketing.address);
    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await paySponsor(router, sponsor, quote, sig);

    const marketingAmount = (gross * 2_000n) / 10_000n;
    const protocolAmount = (gross * 1_000n) / 10_000n;
    const eventAmount = gross - marketingAmount - protocolAmount;
    expect(await vault.eventBalances(eventId)).to.equal(eventAmount);
    expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal(marketingAmount);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.equal(protocolAmount);
    expect(eventAmount + marketingAmount + protocolAmount).to.equal(gross);

    await expect(paySponsor(router, sponsor, quote, sig)).to.be.revertedWithCustomError(router, "Replay");
    await expect(paySponsor(router, stranger, { ...quote, sponsor: stranger.address }, sig)).to.be.revertedWithCustomError(
      router,
      "BadSignature",
    );
  });

  it("rejects mutation of a signed tier, USD reference, native reference, event or requested amount", async () => {
    const { router, vault, quoteSigner, eventReceiver, sponsor } = await deploySponsorship();
    const eventId = ethers.id("signed-snapshot");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const quote: SponsorQuote = {
      eventId,
      sponsor: sponsor.address,
      pricingTier: FOUNDING,
      pricingVersion: 1n,
      minimumUsdMicros: MIN_USD_MICROS,
      requestedUsdMicros: REQUESTED_USD_MICROS,
      minimumNativeRaw: ONE,
      requestedNativeRaw: ONE,
      nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS,
      oracleTimestamp: now,
      nonce: 5n,
      deadline: now + 300n,
    };
    const sig = await signSponsorQuote(router, quoteSigner, quote);

    const mutations: SponsorQuote[] = [
      { ...quote, pricingTier: ethers.id("EARLY") },
      { ...quote, requestedUsdMicros: REQUESTED_USD_MICROS + 1n },
      { ...quote, nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS + 1n },
      { ...quote, eventId: ethers.id("another-event") },
      { ...quote, requestedNativeRaw: ONE + 1n },
    ];
    await router.setEventEnabled(mutations[3].eventId, true);
    await vault.setEventReceiver(mutations[3].eventId, eventReceiver.address);

    for (const mutated of mutations) {
      await expect(paySponsor(router, sponsor, mutated, sig)).to.be.revertedWithCustomError(router, "BadSignature");
    }
  });

  it("rejects disabled events, expired quotes, invalid pricing snapshots, under-minimum native amounts and failed receivers", async () => {
    const base = await deploySponsorship();
    const eventId = ethers.id("q4-bnb");
    await base.vault.setEventReceiver(eventId, base.eventReceiver.address);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const baseQuote: SponsorQuote = {
      eventId,
      sponsor: base.sponsor.address,
      pricingTier: FOUNDING,
      pricingVersion: 1n,
      minimumUsdMicros: MIN_USD_MICROS,
      requestedUsdMicros: REQUESTED_USD_MICROS,
      minimumNativeRaw: ONE,
      requestedNativeRaw: ONE,
      nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS,
      oracleTimestamp: now,
      nonce: 1n,
      deadline: now + 300n,
    };
    const sig = await signSponsorQuote(base.router, base.quoteSigner, baseQuote);
    await expect(paySponsor(base.router, base.sponsor, baseQuote, sig)).to.be.revertedWithCustomError(base.router, "InvalidEvent");

    await base.router.setEventEnabled(eventId, true);
    const expired = { ...baseQuote, nonce: 2n, deadline: now - 1n };
    const expiredSig = await signSponsorQuote(base.router, base.quoteSigner, expired);
    await expect(paySponsor(base.router, base.sponsor, expired, expiredSig)).to.be.revertedWithCustomError(base.router, "QuoteExpired");

    const invalidPricing = { ...baseQuote, nonce: 3n, pricingVersion: 0n };
    const invalidPricingSig = await signSponsorQuote(base.router, base.quoteSigner, invalidPricing);
    await expect(paySponsor(base.router, base.sponsor, invalidPricing, invalidPricingSig)).to.be.revertedWithCustomError(
      base.router,
      "InvalidQuote",
    );

    const tooSmall = { ...baseQuote, nonce: 4n, requestedNativeRaw: ONE - 1n };
    const tooSmallSig = await signSponsorQuote(base.router, base.quoteSigner, tooSmall);
    await expect(paySponsor(base.router, base.sponsor, tooSmall, tooSmallSig)).to.be.revertedWithCustomError(
      base.router,
      "InvalidAmount",
    );

    const Reject = await ethers.getContractFactory("RejectNativeReceiver");
    const reject = await Reject.deploy();
    await reject.waitForDeployment();
    const failing = await deploySponsorship(await reject.getAddress());
    const failingEvent = ethers.id("failing-event");
    await failing.vault.setEventReceiver(failingEvent, failing.eventReceiver.address);
    await failing.router.setEventEnabled(failingEvent, true);
    const failingQuote: SponsorQuote = {
      ...baseQuote,
      eventId: failingEvent,
      sponsor: failing.sponsor.address,
      nonce: 9n,
    };
    const failingSig = await signSponsorQuote(failing.router, failing.quoteSigner, failingQuote);
    await expect(paySponsor(failing.router, failing.sponsor, failingQuote, failingSig)).to.be.revertedWithCustomError(
      failing.router,
      "TransferFailed",
    );
    expect(await failing.vault.eventBalances(failingEvent)).to.equal(0n);
    expect(await failing.router.usedNonces(failing.sponsor.address, 9n)).to.equal(false);
  });

  it("lets only the configured event receiver claim the accumulated event prize once", async () => {
    const { router, vault, quoteSigner, eventReceiver, sponsor, stranger } = await deploySponsorship();
    const eventId = ethers.id("claim-event-prize");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const quote: SponsorQuote = {
      eventId,
      sponsor: sponsor.address,
      pricingTier: FOUNDING,
      pricingVersion: 1n,
      minimumUsdMicros: MIN_USD_MICROS,
      requestedUsdMicros: REQUESTED_USD_MICROS,
      minimumNativeRaw: ONE,
      requestedNativeRaw: ONE,
      nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS,
      oracleTimestamp: now,
      nonce: 77n,
      deadline: now + 300n,
    };
    await paySponsor(router, sponsor, quote, await signSponsorQuote(router, quoteSigner, quote));
    const prize = await vault.eventBalances(eventId);
    await expect(vault.connect(stranger).claimEventPrize(eventId)).to.be.revertedWithCustomError(vault, "Unauthorized");
    const before = await ethers.provider.getBalance(eventReceiver.address);
    const tx = await vault.connect(eventReceiver).claimEventPrize(eventId);
    const receipt = await tx.wait();
    const gas = (receipt?.gasUsed ?? 0n) * (receipt?.gasPrice ?? 0n);
    expect((await ethers.provider.getBalance(eventReceiver.address)) - before + gas).to.equal(prize);
    expect(await vault.eventBalances(eventId)).to.equal(0n);
    await expect(vault.connect(eventReceiver).claimEventPrize(eventId)).to.be.revertedWithCustomError(vault, "NothingToClaim");
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

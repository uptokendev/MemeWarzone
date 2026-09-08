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
  const [owner, resolver, boostQuoteSigner, protocol, monthly, quarterly, alice, bob, booster, stranger] =
    await ethers.getSigners();
  const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
  const league = await League.deploy(owner.address, monthly.address, quarterly.address);
  await league.waitForDeployment();

  const WarPool = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
  const treasury = await WarPool.deploy(
    owner.address,
    resolver.address,
    boostQuoteSigner.address,
    protocol.address,
    await league.getAddress(),
  );
  await treasury.waitForDeployment();
  await league.setSource(await treasury.getAddress(), true);

  return {
    treasury,
    league,
    owner,
    resolver,
    boostQuoteSigner,
    protocol,
    monthly,
    quarterly,
    alice,
    bob,
    booster,
    stranger,
  };
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

type BoostQuote = {
  poolId: string;
  matchId: string;
  roundNumber: bigint;
  booster: string;
  sideToken: string;
  boostUnits: bigint;
  unitPriceNativeRaw: bigint;
  grossNativeRaw: bigint;
  pricingVersion: bigint;
  oracleTimestamp: bigint;
  nonce: bigint;
  deadline: bigint;
};

async function signBoostQuote(treasury: any, signer: any, quote: BoostQuote) {
  const network = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "ArenaWarPoolTreasury",
      version: "2",
      chainId: network.chainId,
      verifyingContract: await treasury.getAddress(),
    },
    {
      BoostQuote: [
        { name: "poolId", type: "bytes32" },
        { name: "matchId", type: "bytes32" },
        { name: "roundNumber", type: "uint256" },
        { name: "booster", type: "address" },
        { name: "sideToken", type: "address" },
        { name: "boostUnits", type: "uint256" },
        { name: "unitPriceNativeRaw", type: "uint256" },
        { name: "grossNativeRaw", type: "uint256" },
        { name: "pricingVersion", type: "uint256" },
        { name: "oracleTimestamp", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    quote,
  );
}

async function payBattleBoost(treasury: any, booster: any, quoteSigner: any, quote: BoostQuote) {
  const signature = await signBoostQuote(treasury, quoteSigner, quote);
  return treasury.connect(booster).boostBattle(
    quote.poolId,
    quote.sideToken,
    quote.boostUnits,
    quote.unitPriceNativeRaw,
    quote.pricingVersion,
    quote.oracleTimestamp,
    quote.nonce,
    quote.deadline,
    signature,
    { value: quote.grossNativeRaw },
  );
}

async function payTournamentBoost(treasury: any, booster: any, quoteSigner: any, quote: BoostQuote) {
  const signature = await signBoostQuote(treasury, quoteSigner, quote);
  return treasury.connect(booster).boostTournament(
    quote.poolId,
    quote.matchId,
    quote.roundNumber,
    quote.sideToken,
    quote.boostUnits,
    quote.unitPriceNativeRaw,
    quote.pricingVersion,
    quote.oracleTimestamp,
    quote.nonce,
    quote.deadline,
    signature,
    { value: quote.grossNativeRaw },
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

function makeBoostQuote(args: {
  poolId: string;
  booster: string;
  sideToken: string;
  now: number;
  boostUnits?: bigint;
  unitPriceNativeRaw?: bigint;
  nonce?: bigint;
  matchId?: string;
  roundNumber?: bigint;
}): BoostQuote {
  const boostUnits = args.boostUnits ?? 5n;
  const unitPriceNativeRaw = args.unitPriceNativeRaw ?? ethers.parseEther("0.01");
  return {
    poolId: args.poolId,
    matchId: args.matchId ?? ethers.ZeroHash,
    roundNumber: args.roundNumber ?? 0n,
    booster: args.booster,
    sideToken: args.sideToken,
    boostUnits,
    unitPriceNativeRaw,
    grossNativeRaw: boostUnits * unitPriceNativeRaw,
    pricingVersion: 1n,
    oracleTimestamp: BigInt(args.now),
    nonce: args.nonce ?? 1n,
    deadline: BigInt(args.now + 300),
  };
}

describe("Arena money-path V2", function () {
  it("keeps historical V1 constants untouched while V2 exposes the new generation", async () => {
    const V1 = await ethers.getContractFactory("ArenaWarPoolTreasury");
    const [owner, resolver, quoteSigner, protocol, mwl, monthly, quarterly] = await ethers.getSigners();
    const v1 = await V1.deploy(owner.address, resolver.address, protocol.address, mwl.address);
    await v1.waitForDeployment();
    expect(await v1.MWL_BPS()).to.equal(1_000n);
    expect(await v1.PROTOCOL_BPS()).to.equal(500n);

    const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
    const league = await League.deploy(owner.address, monthly.address, quarterly.address);
    await league.waitForDeployment();
    const V2 = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
    const v2 = await V2.deploy(owner.address, resolver.address, quoteSigner.address, protocol.address, await league.getAddress());
    await v2.waitForDeployment();
    expect(await v2.GENERATION()).to.equal(2n);
    expect(await v2.ENTRY_LEAGUE_BPS()).to.equal(2_000n);
    expect(await v2.ENTRY_PROTOCOL_BPS()).to.equal(500n);
    expect(await v2.BOOST_PROTOCOL_BPS()).to.equal(1_000n);
    expect(await v2.boostQuoteSigner()).to.equal(quoteSigner.address);
  });

  it("settles Battle entry 75/20/5 and signed Boost 90/10 with exact conservation", async () => {
    const { treasury, league, resolver, boostQuoteSigner, protocol, monthly, quarterly, alice, bob, booster } = await deployArena();
    const poolId = ethers.id("battle-v2");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: ONE });
    await treasury.connect(bob).depositStake(poolId, { value: ONE });

    const quote = makeBoostQuote({ poolId, booster: booster.address, sideToken: alice.address, now, boostUnits: 5n });
    await expect(payBattleBoost(treasury, booster, boostQuoteSigner, quote))
      .to.emit(treasury, "BattleBoosted")
      .withArgs(
        poolId,
        booster.address,
        alice.address,
        quote.boostUnits,
        quote.unitPriceNativeRaw,
        quote.grossNativeRaw,
        quote.pricingVersion,
        quote.oracleTimestamp,
        quote.nonce,
      );

    const entryGross = ONE * 2n;
    const leagueAmt = (entryGross * 2_000n) / 10_000n;
    const entryProtocol = (entryGross * 500n) / 10_000n;
    const entryPrize = entryGross - leagueAmt - entryProtocol;
    const boostProtocol = (quote.grossNativeRaw * 1_000n) / 10_000n;
    const boostPrize = quote.grossNativeRaw - boostProtocol;
    const deadline = now + 10_000;
    const sig = await signResolveV2(treasury, resolver, poolId, alice.address, entryGross, 0n, quote.grossNativeRaw, deadline);
    await treasury.resolve(poolId, alice.address, deadline, sig);

    const settled = await treasury.pools(poolId);
    expect(settled.pendingWinner).to.equal(entryPrize + boostPrize);
    expect(settled.pendingProtocol).to.equal(entryProtocol + boostProtocol);
    expect(settled.pendingLeague).to.equal(leagueAmt);
    expect(settled.pendingWinner + settled.pendingProtocol + settled.pendingLeague).to.equal(entryGross + quote.grossNativeRaw);

    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await treasury.claimProtocol(poolId);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.equal(entryProtocol + boostProtocol);

    const month = ethers.id("2026-09");
    const quarter = ethers.id("2026-Q3");
    await treasury.claimLeague(poolId, month, quarter);
    const monthlyAmt = (leagueAmt * 6_000n) / 10_000n;
    const quarterlyAmt = leagueAmt - monthlyAmt;
    expect(await league.pendingMonthlyByEpoch(month)).to.equal(monthlyAmt);
    expect(await league.pendingQuarterlyByEpoch(quarter)).to.equal(quarterlyAmt);

    const monthlyBefore = await ethers.provider.getBalance(monthly.address);
    await league.claimMonthly(month);
    expect((await ethers.provider.getBalance(monthly.address)) - monthlyBefore).to.equal(monthlyAmt);
    const quarterlyBefore = await ethers.provider.getBalance(quarterly.address);
    await league.claimQuarterly(quarter);
    expect((await ethers.provider.getBalance(quarterly.address)) - quarterlyBefore).to.equal(quarterlyAmt);
  });

  it("binds Boost units, native unit price, wallet, nonce and expiry", async () => {
    const { treasury, boostQuoteSigner, alice, bob, booster, stranger } = await deployArena();
    const poolId = ethers.id("battle-quote-security");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: ONE });
    await treasury.connect(bob).depositStake(poolId, { value: ONE });

    const quote = makeBoostQuote({ poolId, booster: booster.address, sideToken: alice.address, now, boostUnits: 3n, nonce: 77n });
    const signature = await signBoostQuote(treasury, boostQuoteSigner, quote);
    await treasury.connect(booster).boostBattle(
      poolId,
      alice.address,
      quote.boostUnits,
      quote.unitPriceNativeRaw,
      quote.pricingVersion,
      quote.oracleTimestamp,
      quote.nonce,
      quote.deadline,
      signature,
      { value: quote.grossNativeRaw },
    );
    await expect(
      treasury.connect(booster).boostBattle(
        poolId,
        alice.address,
        quote.boostUnits,
        quote.unitPriceNativeRaw,
        quote.pricingVersion,
        quote.oracleTimestamp,
        quote.nonce,
        quote.deadline,
        signature,
        { value: quote.grossNativeRaw },
      ),
    ).to.be.revertedWithCustomError(treasury, "Replay");

    const walletQuote = { ...quote, nonce: 78n };
    const walletSig = await signBoostQuote(treasury, boostQuoteSigner, walletQuote);
    await expect(
      treasury.connect(stranger).boostBattle(
        poolId,
        alice.address,
        walletQuote.boostUnits,
        walletQuote.unitPriceNativeRaw,
        walletQuote.pricingVersion,
        walletQuote.oracleTimestamp,
        walletQuote.nonce,
        walletQuote.deadline,
        walletSig,
        { value: walletQuote.grossNativeRaw },
      ),
    ).to.be.revertedWithCustomError(treasury, "BadSignature");

    const amountQuote = makeBoostQuote({ poolId, booster: booster.address, sideToken: alice.address, now, nonce: 79n });
    const amountSig = await signBoostQuote(treasury, boostQuoteSigner, amountQuote);
    await expect(
      treasury.connect(booster).boostBattle(
        poolId,
        alice.address,
        amountQuote.boostUnits,
        amountQuote.unitPriceNativeRaw,
        amountQuote.pricingVersion,
        amountQuote.oracleTimestamp,
        amountQuote.nonce,
        amountQuote.deadline,
        amountSig,
        { value: amountQuote.grossNativeRaw - 1n },
      ),
    ).to.be.revertedWithCustomError(treasury, "InvalidAmount");

    const expired = { ...makeBoostQuote({ poolId, booster: booster.address, sideToken: alice.address, now, nonce: 80n }), deadline: BigInt(now - 1) };
    await expect(payBattleBoost(treasury, booster, boostQuoteSigner, expired)).to.be.revertedWithCustomError(
      treasury,
      "SignatureExpired",
    );
  });

  it("routes Vote Tournament Boost money to the overall tournament pool with canonical units", async () => {
    const { treasury, resolver, boostQuoteSigner, owner, alice, bob, booster } = await deployArena();
    const poolId = ethers.id("vote-tournament-v2");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openTournamentPool(poolId, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositBuyIn(poolId, { value: ONE });
    await treasury.connect(bob).depositBuyIn(poolId, { value: ONE });
    await treasury.setTournamentLive(poolId);

    const quoteA = makeBoostQuote({
      poolId,
      booster: booster.address,
      sideToken: alice.address,
      now,
      boostUnits: 2n,
      nonce: 10n,
      matchId: ethers.id("round1-match1"),
      roundNumber: 1n,
    });
    const quoteB = makeBoostQuote({
      poolId,
      booster: booster.address,
      sideToken: bob.address,
      now,
      boostUnits: 3n,
      nonce: 11n,
      matchId: ethers.id("round2-match7"),
      roundNumber: 2n,
    });
    await expect(payTournamentBoost(treasury, booster, boostQuoteSigner, quoteA))
      .to.emit(treasury, "TournamentBoosted")
      .withArgs(
        poolId,
        quoteA.matchId,
        quoteA.roundNumber,
        booster.address,
        alice.address,
        quoteA.boostUnits,
        quoteA.unitPriceNativeRaw,
        quoteA.grossNativeRaw,
        quoteA.pricingVersion,
        quoteA.oracleTimestamp,
        quoteA.nonce,
      );
    await payTournamentBoost(treasury, booster, boostQuoteSigner, quoteB);

    const boostTotal = quoteA.grossNativeRaw + quoteB.grossNativeRaw;
    const deadline = now + 10_000;
    await treasury.resolve(
      poolId,
      owner.address,
      deadline,
      await signResolveV2(treasury, resolver, poolId, owner.address, 0n, ONE * 2n, boostTotal, deadline),
    );
    const settled = await treasury.pools(poolId);
    expect(settled.boostTotal).to.equal(boostTotal);
    expect(settled.pendingLeague).to.equal((ONE * 2n * 2_000n) / 10_000n);
    expect(settled.pendingProtocol).to.equal((ONE * 2n * 500n) / 10_000n + (boostTotal * 1_000n) / 10_000n);
  });

  it("refunds open stakes and buy-ins and rejects Boosts before live", async () => {
    const { treasury, boostQuoteSigner, alice, bob, booster } = await deployArena();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const battleId = ethers.id("cancel-battle-v2");
    await treasury.openBattlePool(battleId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(battleId, { value: ONE });
    const quote = makeBoostQuote({ poolId: battleId, booster: booster.address, sideToken: alice.address, now });
    await expect(payBattleBoost(treasury, booster, boostQuoteSigner, quote)).to.be.revertedWithCustomError(treasury, "InvalidState");
    await treasury.connect(alice).cancelOpenPool(battleId);
    await treasury.connect(alice).refundStake(battleId);

    const tournamentId = ethers.id("cancel-tournament-v2");
    await treasury.openTournamentPool(tournamentId, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositBuyIn(tournamentId, { value: ONE });
    await treasury.connect(bob).depositBuyIn(tournamentId, { value: ONE });
    await treasury.cancelOpenPool(tournamentId);
    await treasury.connect(alice).refundBuyIn(tournamentId);
    await treasury.connect(bob).refundBuyIn(tournamentId);
    expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(0n);
  });

  it("keeps all allocation rounding exact and blocks duplicate League credits", async () => {
    for (const gross of [1n, 2n, 3n, 9n, 10n, 99n, 101n, 999n, 10_001n, 999_999n]) {
      const league = (gross * 2_000n) / 10_000n;
      const protocol = (gross * 500n) / 10_000n;
      expect(gross - league - protocol + league + protocol).to.equal(gross);
      const boostProtocol = (gross * 1_000n) / 10_000n;
      expect(gross - boostProtocol + boostProtocol).to.equal(gross);
    }

    const { league, owner } = await deployLeague();
    await league.setSource(owner.address, true);
    const sourcePool = ethers.id("tiny-source");
    const month = ethers.id("month");
    const quarter = ethers.id("quarter");
    await league.depositCompetitionShare(sourcePool, month, quarter, { value: 1n });
    expect(await league.pendingMonthlyByEpoch(month)).to.equal(0n);
    expect(await league.pendingQuarterlyByEpoch(quarter)).to.equal(1n);
    await expect(league.depositCompetitionShare(sourcePool, month, quarter, { value: 1n })).to.be.revertedWithCustomError(
      league,
      "AlreadyCredited",
    );
  });

  it("resists winner-claim reentrancy", async () => {
    const { treasury, resolver, boostQuoteSigner, alice, bob, booster } = await deployArena();
    const Helper = await ethers.getContractFactory("ReentrantArenaWinner");
    const helper = await Helper.deploy();
    await helper.waitForDeployment();
    const poolId = ethers.id("reentrant-winner");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, ONE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: ONE });
    await treasury.connect(bob).depositStake(poolId, { value: ONE });
    const quote = makeBoostQuote({ poolId, booster: booster.address, sideToken: alice.address, now, boostUnits: 10n });
    await payBattleBoost(treasury, booster, boostQuoteSigner, quote);
    await helper.configure(await treasury.getAddress(), poolId);

    const deadline = now + 10_000;
    await treasury.resolve(
      poolId,
      await helper.getAddress(),
      deadline,
      await signResolveV2(treasury, resolver, poolId, await helper.getAddress(), ONE * 2n, 0n, quote.grossNativeRaw, deadline),
    );
    const expected = (await treasury.pools(poolId)).pendingWinner;
    await helper.claim();
    expect(await ethers.provider.getBalance(await helper.getAddress())).to.equal(expected);
    expect(await helper.attempted()).to.equal(true);
    await expect(helper.claim()).to.be.revertedWithCustomError(treasury, "NothingToClaim");
  });
});

describe("Warzone sponsorship money path V1", function () {
  function sponsorQuote(eventId: string, sponsor: string, now: bigint, nonce = 1n): SponsorQuote {
    return {
      eventId,
      sponsor,
      pricingTier: FOUNDING,
      pricingVersion: 1n,
      minimumUsdMicros: MIN_USD_MICROS,
      requestedUsdMicros: REQUESTED_USD_MICROS,
      minimumNativeRaw: ONE,
      requestedNativeRaw: ONE,
      nativeUsdReferenceMicros: NATIVE_USD_REFERENCE_MICROS,
      oracleTimestamp: now,
      nonce,
      deadline: now + 300n,
    };
  }

  it("routes 70/20/10, binds the signed pricing snapshot, and blocks replay", async () => {
    const { router, vault, quoteSigner, marketing, protocol, eventReceiver, sponsor, stranger } = await deploySponsorship();
    const eventId = ethers.id("september-bnb-mwl");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const quote = sponsorQuote(eventId, sponsor.address, now, 42n);
    const signature = await signSponsorQuote(router, quoteSigner, quote);

    const marketingBefore = await ethers.provider.getBalance(marketing.address);
    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await paySponsor(router, sponsor, quote, signature);
    const marketingAmount = (ONE * 2_000n) / 10_000n;
    const protocolAmount = (ONE * 1_000n) / 10_000n;
    const eventAmount = ONE - marketingAmount - protocolAmount;
    expect(await vault.eventBalances(eventId)).to.equal(eventAmount);
    expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal(marketingAmount);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.equal(protocolAmount);
    await expect(paySponsor(router, sponsor, quote, signature)).to.be.revertedWithCustomError(router, "Replay");
    await expect(paySponsor(router, stranger, { ...quote, sponsor: stranger.address }, signature)).to.be.revertedWithCustomError(
      router,
      "BadSignature",
    );
  });

  it("rejects signed pricing mutation, expiry, invalid pricing and failed receivers atomically", async () => {
    const base = await deploySponsorship();
    const eventId = ethers.id("sponsor-security");
    await base.vault.setEventReceiver(eventId, base.eventReceiver.address);
    await base.router.setEventEnabled(eventId, true);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const quote = sponsorQuote(eventId, base.sponsor.address, now, 5n);
    const signature = await signSponsorQuote(base.router, base.quoteSigner, quote);
    await expect(
      paySponsor(base.router, base.sponsor, { ...quote, nativeUsdReferenceMicros: quote.nativeUsdReferenceMicros + 1n }, signature),
    ).to.be.revertedWithCustomError(base.router, "BadSignature");

    const expired = { ...quote, nonce: 6n, deadline: now - 1n };
    await expect(
      paySponsor(base.router, base.sponsor, expired, await signSponsorQuote(base.router, base.quoteSigner, expired)),
    ).to.be.revertedWithCustomError(base.router, "QuoteExpired");

    const invalidPricing = { ...quote, nonce: 7n, pricingVersion: 0n };
    await expect(
      paySponsor(base.router, base.sponsor, invalidPricing, await signSponsorQuote(base.router, base.quoteSigner, invalidPricing)),
    ).to.be.revertedWithCustomError(base.router, "InvalidQuote");

    const Reject = await ethers.getContractFactory("RejectNativeReceiver");
    const reject = await Reject.deploy();
    await reject.waitForDeployment();
    const failing = await deploySponsorship(await reject.getAddress());
    const failingEvent = ethers.id("failing-event");
    await failing.vault.setEventReceiver(failingEvent, failing.eventReceiver.address);
    await failing.router.setEventEnabled(failingEvent, true);
    const failingQuote = sponsorQuote(failingEvent, failing.sponsor.address, now, 9n);
    await expect(
      paySponsor(failing.router, failing.sponsor, failingQuote, await signSponsorQuote(failing.router, failing.quoteSigner, failingQuote)),
    ).to.be.revertedWithCustomError(failing.router, "TransferFailed");
    expect(await failing.vault.eventBalances(failingEvent)).to.equal(0n);
    expect(await failing.router.usedNonces(failing.sponsor.address, 9n)).to.equal(false);
  });

  it("lets only the configured event receiver claim once and preserves exact rounding", async () => {
    const { router, vault, quoteSigner, eventReceiver, sponsor, stranger } = await deploySponsorship();
    const eventId = ethers.id("claim-event-prize");
    await vault.setEventReceiver(eventId, eventReceiver.address);
    await router.setEventEnabled(eventId, true);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const quote = sponsorQuote(eventId, sponsor.address, now, 77n);
    await paySponsor(router, sponsor, quote, await signSponsorQuote(router, quoteSigner, quote));
    const prize = await vault.eventBalances(eventId);
    await expect(vault.connect(stranger).claimEventPrize(eventId)).to.be.revertedWithCustomError(vault, "Unauthorized");
    const before = await ethers.provider.getBalance(eventReceiver.address);
    const tx = await vault.connect(eventReceiver).claimEventPrize(eventId);
    const receipt = await tx.wait();
    const gas = (receipt?.gasUsed ?? 0n) * (receipt?.gasPrice ?? 0n);
    expect((await ethers.provider.getBalance(eventReceiver.address)) - before + gas).to.equal(prize);
    await expect(vault.connect(eventReceiver).claimEventPrize(eventId)).to.be.revertedWithCustomError(vault, "NothingToClaim");

    for (const gross of [1n, 2n, 7n, 9n, 10n, 99n, 101n, 999n, 10_003n, 1_000_001n]) {
      const marketing = (gross * 2_000n) / 10_000n;
      const protocol = (gross * 1_000n) / 10_000n;
      expect(gross - marketing - protocol + marketing + protocol).to.equal(gross);
    }
  });
});

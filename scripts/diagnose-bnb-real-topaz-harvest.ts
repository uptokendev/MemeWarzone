import { ethers, network } from "hardhat";

const CHAIN_ID = 97;
const BPS = 10_000n;
const CREATOR_BPS = 8_000n;

function sameAddress(a: string, b: string): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function asString(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

async function harvestEvents(locker: any, pool: string) {
  const latest = await ethers.provider.getBlockNumber();
  const maxLookbackBlocks = 5_000;
  const chunkSize = 100;
  const floor = Math.max(0, latest - maxLookbackBlocks);
  const filter = locker.filters.FeesHarvested(pool);

  for (let to = latest; to >= floor; to -= chunkSize) {
    const from = Math.max(floor, to - chunkSize + 1);
    const rows = await locker.queryFilter(filter, from, to);
    if (rows.length > 0) return { from, latest, rows };
    if (from === floor) break;
  }

  return { from: floor, latest, rows: [] as any[] };
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "bscTestnet" || chainId !== CHAIN_ID) {
    throw new Error(`diagnostic refuses ${network.name}/${chainId}`);
  }

  const rawFactory = String(process.env.BNB_REAL_TOPAZ_DIAGNOSTIC_FACTORY || "").trim();
  if (!ethers.isAddress(rawFactory)) throw new Error("BNB_REAL_TOPAZ_DIAGNOSTIC_FACTORY must be a valid address");
  const factoryAddress = ethers.getAddress(rawFactory);
  if ((await ethers.provider.getCode(factoryAddress)) === "0x") throw new Error("diagnostic factory has no bytecode");

  const factory = await ethers.getContractAt("LaunchFactory", factoryAddress, ethers.provider);
  const [factoryGeneration, campaignGeneration, count, lockerAddress, treasuryAddress] = await Promise.all([
    factory.FACTORY_GENERATION(),
    factory.CAMPAIGN_GENERATION(),
    factory.campaignsCount(),
    factory.permanentLpLocker(),
    factory.feeRecipient(),
  ]);
  if (factoryGeneration !== 4n || campaignGeneration !== 3n) {
    throw new Error(`diagnostic requires Gen-4/3 factory; got ${factoryGeneration}/${campaignGeneration}`);
  }
  if (count <= 0n) throw new Error("diagnostic factory has no campaigns");

  const info = await factory.getCampaign(count - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, ethers.provider);
  const state = await campaign.getGraduationState();
  if (!state.dexPair || sameAddress(state.dexPair, ethers.ZeroAddress)) throw new Error("latest campaign has no graduated pool");

  const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress, ethers.provider);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", treasuryAddress, ethers.provider);
  const registration = await locker.poolInfo(state.dexPair);
  const configuredRecipient = await locker.creatorPayoutRecipient(registration.creator);
  const recipient = sameAddress(configuredRecipient, ethers.ZeroAddress) ? registration.creatorFeeRecipient : configuredRecipient;
  const protocolVault = await treasury.protocolRevenueVault();
  const authorizedLocker = await treasury.authorizedLpLocker(lockerAddress);

  const eventScan = await harvestEvents(locker, state.dexPair);
  const totals = new Map<string, { token: string; collected: bigint; creatorPaid: bigint; protocolRouted: bigint; txHashes: string[] }>();
  for (const row of eventScan.rows) {
    const args: any = (row as any).args;
    const token = ethers.getAddress(args.token);
    const key = token.toLowerCase();
    const current = totals.get(key) || { token, collected: 0n, creatorPaid: 0n, protocolRouted: 0n, txHashes: [] };
    current.collected += BigInt(args.collected);
    current.creatorPaid += BigInt(args.creatorPaid);
    current.protocolRouted += BigInt(args.protocolRouted);
    if ((row as any).transactionHash && !current.txHashes.includes((row as any).transactionHash)) current.txHashes.push((row as any).transactionHash);
    totals.set(key, current);
  }

  const assets = [registration.token0, registration.token1];
  const assetDiagnostics = [];
  for (const rawToken of assets) {
    const token = ethers.getAddress(rawToken);
    const erc20 = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    const event = totals.get(token.toLowerCase()) || { token, collected: 0n, creatorPaid: 0n, protocolRouted: 0n, txHashes: [] };
    const expectedCreator = (event.collected * CREATOR_BPS) / BPS;
    const expectedProtocol = event.collected - expectedCreator;
    const [cumulativeCreator, cumulativeProtocol, pendingCreator, pendingProtocol, recipientBalance, protocolVaultBalance, lockerBalance] = await Promise.all([
      locker.cumulativeCreatorPaid(state.dexPair, token),
      locker.cumulativeProtocolRouted(state.dexPair, token),
      locker.pendingToken(recipient, token),
      locker.pendingProtocolToken(token),
      erc20.balanceOf(recipient),
      erc20.balanceOf(protocolVault),
      erc20.balanceOf(lockerAddress),
    ]);
    const creatorAccounted = cumulativeCreator + pendingCreator;
    const protocolAccounted = cumulativeProtocol + pendingProtocol;
    assetDiagnostics.push({
      token,
      eventCollected: event.collected.toString(),
      eventCreatorPaid: event.creatorPaid.toString(),
      eventProtocolRouted: event.protocolRouted.toString(),
      expectedCreator80: expectedCreator.toString(),
      expectedProtocol20: expectedProtocol.toString(),
      cumulativeCreatorPaid: cumulativeCreator.toString(),
      cumulativeProtocolRouted: cumulativeProtocol.toString(),
      pendingCreator: pendingCreator.toString(),
      pendingProtocol: pendingProtocol.toString(),
      creatorAccounted: creatorAccounted.toString(),
      protocolAccounted: protocolAccounted.toString(),
      creatorAccountingExact: creatorAccounted === expectedCreator,
      protocolAccountingExact: protocolAccounted === expectedProtocol,
      creatorDirectPaid: cumulativeCreator === expectedCreator,
      protocolDirectRouted: cumulativeProtocol === expectedProtocol,
      recipientBalance: recipientBalance.toString(),
      protocolVaultBalance: protocolVaultBalance.toString(),
      lockerResidualBalance: lockerBalance.toString(),
      harvestTxHashes: event.txHashes,
    });
  }

  let retryStatic: [bigint, bigint] | null = null;
  let retryStaticError = "";
  try {
    const result = await locker.harvest.staticCall(state.dexPair);
    retryStatic = [BigInt(result[0]), BigInt(result[1])];
  } catch (error) {
    retryStaticError = error instanceof Error ? error.message : String(error);
  }

  const pool = new ethers.Contract(state.dexPair, ["function balanceOf(address) view returns (uint256)", "function factory() view returns (address)", "function stable() view returns (bool)"], ethers.provider);
  const [lpBalance, poolFactory, stable, lockerTreasury, lockerTopazFactory] = await Promise.all([
    pool.balanceOf(lockerAddress),
    pool.factory(),
    pool.stable(),
    locker.treasuryRouter(),
    locker.topazFactory(),
  ]);

  const output = {
    mode: "READ_ONLY_REAL_TOPAZ_HARVEST_DIAGNOSTIC",
    chainId,
    factory: factoryAddress,
    factoryGeneration: Number(factoryGeneration),
    campaignGeneration: Number(campaignGeneration),
    campaignsCount: count.toString(),
    latestCampaign: info.campaign,
    latestToken: info.token,
    creator: info.creator,
    pool: state.dexPair,
    poolFactory,
    poolStable: stable,
    locker: lockerAddress,
    lockerTreasury,
    lockerTopazFactory,
    treasury: treasuryAddress,
    treasuryProtocolVault: protocolVault,
    treasuryAuthorizesLocker: authorizedLocker,
    registeredCreator: registration.creator,
    registeredCreatorFeeRecipient: registration.creatorFeeRecipient,
    activeCreatorPayoutRecipient: recipient,
    lockedLpAmount: asString(registration.lockedLpAmount),
    lockerLpBalance: asString(lpBalance),
    lpPrincipalPreserved: lpBalance >= registration.lockedLpAmount,
    eventScanFromBlock: eventScan.from,
    eventScanToBlock: eventScan.latest,
    harvestEventCount: eventScan.rows.length,
    assets: assetDiagnostics,
    retryHarvestStatic: retryStatic ? retryStatic.map((v) => v.toString()) : null,
    retryHarvestStaticError: retryStaticError,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

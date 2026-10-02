import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

export const CHAIN_ID = 46630;
export const FORBIDDEN_CHAIN_ID = 4663;
export const FACTORY = '0xa20388579323e22076b07e89Ac916aE6Ff91A0E0';
export const CAMPAIGN_IMPL = '0x1e463947d28f2c878312139b87aD482a614F1cDC';
export const ADAPTER = '0x71F0B8358Ed3BE3584C8cF69664C0e9202d00730';
export const LOCKER = '0x401B2F703B4756E0BC98dd4BCD92eaa9AaAd70c9';
export const TREASURY = '0xF8A14d0e91A02DEc487615Ce13286b11dDad7efF';
export const GRAD_ORACLE = '0x9561899be9E88f2Bb867d50915EAb63Ff651C854';
export const ETH_USD_ORACLE = '0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb';
export const CREATOR = '0xf0558484531204645fB6eaF35c5082Fc55d869A6';
export const DEPLOYER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';
export const UPDATER = '0xE755A2c52654b2133c7A4fdC5349821C6527A766';
export const TRADER_A = '0x38D8054789aB2068C3E6B04382787eFE15617ac7';
export const TRADER_B = '0xeAE58347aA643a228C88Bd62295651388163E1CA';
export const EXISTING_CAMPAIGN = '0xD364B89d4E78Fc489E5ce39AB7fE4f7272B3fE50';
export const EXISTING_TOKEN = '0x14A1C93dB6d733aa328fb8d8c6e8944BaBc7C75C';
export const OUT = process.env.RH46630_ZERO_WRITE_PREFLIGHT || 'rh46630-zero-write-preflight.json';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const req = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
};
const json = (v) => JSON.stringify(v, (_k, value) => typeof value === 'bigint' ? value.toString() : value, 2);
const assert = (value, message) => { if (!value) throw new Error(message); };
const loadAbi = (path) => JSON.parse(fs.readFileSync(path, 'utf8')).abi;

export function classifyCreatorEligibility({ allowed, restricted, manualReviewRequired, lastLaunchTimestamp, cooldownSeconds, liveBondingCount, maxLiveBonding, now }) {
  const last = BigInt(lastLaunchTimestamp ?? 0);
  const cooldown = BigInt(cooldownSeconds ?? 0);
  const live = BigInt(liveBondingCount ?? 0);
  const max = BigInt(maxLiveBonding ?? 0);
  const current = BigInt(now ?? 0);
  const cooldownEndsAt = last === 0n ? current : last + cooldown;
  if (restricted) return { reason: 'RESTRICTED', cooldownEndsAt };
  if (manualReviewRequired) return { reason: 'REVIEW', cooldownEndsAt };
  if (live >= max) return { reason: 'LIVE_COUNT', cooldownEndsAt };
  if (last !== 0n && current < cooldownEndsAt) return { reason: 'COOLDOWN', cooldownEndsAt };
  if (!allowed) return { reason: 'OTHER', cooldownEndsAt };
  return { reason: 'ELIGIBLE', cooldownEndsAt };
}

export function chooseLifecycleAction({ creatorAllowed, existingCampaign }) {
  if (existingCampaign?.resumable === true) {
    return { mode: 'RESUME_EXISTING', resumeExistingCampaign: true, createRequired: false, resumeStep: existingCampaign.resumeStep || 'BUY_SELL_THEN_BOND_TO_GRADUATION' };
  }
  if (!creatorAllowed) throw new Error('CREATE_REQUIRED_BUT_CREATOR_NOT_ELIGIBLE');
  return { mode: 'CREATE_NEW', resumeExistingCampaign: false, createRequired: true, resumeStep: 'CREATE' };
}

export function normalizeFeedPrice(answer, decimals) {
  const a = BigInt(answer);
  const d = Number(decimals);
  if (a <= 0n) throw new Error('PRICE_ANSWER_NOT_POSITIVE');
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('PRICE_DECIMALS_INVALID');
  if (d === 18) return a;
  if (d < 18) return a * (10n ** BigInt(18 - d));
  return a / (10n ** BigInt(d - 18));
}

export function ceilMulDiv(a, b, denominator) {
  const x = BigInt(a);
  const y = BigInt(b);
  const d = BigInt(denominator);
  if (d <= 0n) throw new Error('DIVISOR_NOT_POSITIVE');
  const product = x * y;
  return product === 0n ? 0n : (product + d - 1n) / d;
}

export function computeNativeTargetFromUsd(usdAmount, feedAnswer, feedDecimals) {
  const price18 = normalizeFeedPrice(feedAnswer, feedDecimals);
  return ceilMulDiv(BigInt(usdAmount), 10n ** 18n, price18);
}

export function computeFirstBuyValue(nativeTarget) {
  let value = BigInt(nativeTarget) / 5n;
  if (value < 10_000_000_000_000n) value = 10_000_000_000_000n;
  return value;
}

export function makeTradeDigest(campaign, actor, profile, action, amount, limit, deadline) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(
    ['string','uint256','address','address','uint8','uint8','uint256','uint256','uint64'],
    ['MWZ_ROUTE_TRADE_AUTH', CHAIN_ID, campaign, actor, profile, action, amount, limit, deadline]
  ));
}

export function assessLaunchProtection({ blockNumber, endBlock, pendingBlocks, maxBuyWei, maxWalletWei, protectedBuyWei, costNoFee }) {
  const block = BigInt(blockNumber);
  const end = BigInt(endBlock);
  const pending = BigInt(pendingBlocks);
  const maxBuy = BigInt(maxBuyWei);
  const maxWallet = BigInt(maxWalletWei);
  const protectedSoFar = BigInt(protectedBuyWei);
  const proposedCost = BigInt(costNoFee);
  const currentlyActive = end !== 0n && block <= end;
  const willActivateOnNextBuy = pending !== 0n;
  const appliesToNextBuy = currentlyActive || willActivateOnNextBuy;
  const effectiveEndBlock = willActivateOnNextBuy ? block + pending : end;
  const proposedWalletProtectedWei = protectedSoFar + proposedCost;
  return {
    currentlyActive,
    willActivateOnNextBuy,
    appliesToNextBuy,
    effectiveEndBlock,
    proposedCostNoFee: proposedCost,
    proposedWalletProtectedWei,
    buyLimitExceeded: appliesToNextBuy && maxBuy > 0n && proposedCost > maxBuy,
    walletLimitExceeded: appliesToNextBuy && maxWallet > 0n && proposedWalletProtectedWei > maxWallet,
  };
}

function findHexData(value, seen = new Set()) {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const key of ['data', 'error', 'info', 'revert', 'cause']) {
    const found = findHexData(value[key], seen);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    const found = findHexData(nested, seen);
    if (found) return found;
  }
  return null;
}

function decodedArgs(parsed) {
  if (!parsed?.fragment?.inputs?.length) return [];
  return parsed.fragment.inputs.map((input, index) => ({
    name: input.name || String(index),
    type: input.type,
    value: typeof parsed.args[index] === 'bigint' ? parsed.args[index].toString() : String(parsed.args[index]),
  }));
}

export function decodeRevertData(data, decoders = []) {
  if (!data || typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) {
    return { selector: null, decodedErrorName: 'NO_REVERT_DATA', decodedArguments: [] };
  }
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (selector === '0x08c379a0') {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], `0x${data.slice(10)}`);
      return { selector, decodedErrorName: 'Error', decodedArguments: [{ name: 'reason', type: 'string', value: reason }] };
    }
    if (selector === '0x4e487b71') {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], `0x${data.slice(10)}`);
      return { selector, decodedErrorName: 'Panic', decodedArguments: [{ name: 'code', type: 'uint256', value: code.toString() }] };
    }
  } catch {}
  for (const decoder of decoders) {
    try {
      const parsed = decoder.iface.parseError(data);
      if (parsed) return { selector, scope: decoder.scope, decodedErrorName: parsed.name, decodedArguments: decodedArgs(parsed) };
    } catch {}
  }
  return { selector, decodedErrorName: 'UNKNOWN_CUSTOM_ERROR', decodedArguments: [] };
}

export function decodeEthersError(error, decoders = []) {
  const data = findHexData(error);
  const decoded = decodeRevertData(data, decoders);
  return { ...decoded, data, shortMessage: String(error?.shortMessage || error?.reason || error?.message || error) };
}

function walletAddress(pkName, expected) {
  const raw = req(pkName);
  const wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
  assert(same(wallet.address, expected), `SIGNER_MISMATCH_${pkName}_${wallet.address}`);
  return wallet.address;
}

function protectedWallet(pkName, expected, provider = null) {
  const raw = req(pkName);
  const wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : `0x${raw}`, provider || undefined);
  assert(same(wallet.address, expected), `SIGNER_MISMATCH_${pkName}_${wallet.address}`);
  return wallet;
}

function printBlocked(nextWrite) {
  console.log('RH46630_NEXT_WRITE_PREFLIGHT=BLOCKED');
  console.log(`operation=${nextWrite.operation}`);
  console.log(`campaign=${nextWrite.campaign}`);
  console.log(`actor=${nextWrite.actor}`);
  console.log(`value=${nextWrite.value}`);
  console.log(`selector=${nextWrite.revertSelector || nextWrite.operationSelector}`);
  console.log(`decodedErrorName=${nextWrite.decodedErrorName}`);
  console.log(`decodedArguments=${JSON.stringify(nextWrite.decodedArguments || [])}`);
  console.log(`relevant_state=${JSON.stringify(nextWrite.relevantState)}`);
  console.log('CHAIN_WRITES=0');
}

async function main() {
  const provider = new ethers.JsonRpcProvider(req('ROBINHOOD_TESTNET_RPC_URL'));
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId === FORBIDDEN_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');
  if (chainId !== CHAIN_ID) throw new Error(`WRONG_CHAIN_${chainId}`);

  const factoryAbi = loadAbi('artifacts/contracts/LaunchFactory.sol/LaunchFactory.json');
  const campaignAbi = loadAbi('artifacts/contracts/LaunchCampaign.sol/LaunchCampaign.json');
  const registryAbi = loadAbi('artifacts/contracts/CreatorRegistry.sol/CreatorRegistry.json');
  const riskRegistryAbi = loadAbi('artifacts/contracts/RiskRegistry.sol/RiskRegistry.json');
  const treasuryAbi = loadAbi('artifacts/contracts/TreasuryRouterV3.sol/TreasuryRouterV3.json');
  const graduationOracleAbi = loadAbi('artifacts/contracts/GraduationOracle.sol/GraduationOracle.json');
  const launchTokenAbi = loadAbi('artifacts/contracts/token/LaunchToken.sol/LaunchToken.json');
  const decoders = [
    { scope: 'LaunchCampaign', iface: new ethers.Interface(campaignAbi) },
    { scope: 'RiskRegistry', iface: new ethers.Interface(riskRegistryAbi) },
    { scope: 'TreasuryRouterV3', iface: new ethers.Interface(treasuryAbi) },
    { scope: 'GraduationOracle', iface: new ethers.Interface(graduationOracleAbi) },
    { scope: 'LaunchFactory', iface: new ethers.Interface(factoryAbi) },
    { scope: 'LaunchToken', iface: new ethers.Interface(launchTokenAbi) },
  ];

  const factory = new ethers.Contract(FACTORY, factoryAbi, provider);
  const runtimeAddresses = {
    factory: FACTORY,
    campaignImplementation: await factory.campaignImplementation(),
    adapter: await factory.router(),
    graduationOracle: await factory.graduationOracle(),
    locker: await factory.permanentLpLocker(),
    treasury: await factory.leagueReceiver(),
    creatorRegistry: await factory.creatorRegistry(),
  };
  for (const [label, address] of Object.entries(runtimeAddresses)) {
    assert(address && address !== ethers.ZeroAddress, `ZERO_RUNTIME_${label}`);
    assert((await provider.getCode(address)) !== '0x', `MISSING_RUNTIME_${label}`);
  }
  assert(same(runtimeAddresses.campaignImplementation, CAMPAIGN_IMPL), 'CAMPAIGN_IMPL_MISMATCH');
  assert(same(runtimeAddresses.adapter, ADAPTER), 'FACTORY_ADAPTER_MISMATCH');
  assert(same(runtimeAddresses.graduationOracle, GRAD_ORACLE), 'GRAD_ORACLE_MISMATCH');
  assert(same(runtimeAddresses.locker, LOCKER), 'LOCKER_MISMATCH');
  assert(same(runtimeAddresses.treasury, TREASURY), 'TREASURY_MISMATCH');
  assert(Number(await factory.FACTORY_GENERATION()) === 4, 'FACTORY_GENERATION_NOT_4');
  assert(Number(await factory.CAMPAIGN_GENERATION()) === 3, 'CAMPAIGN_GENERATION_NOT_3');
  assert(Number(await factory.liquidityKind()) === 2, 'LIQUIDITY_KIND_NOT_2');

  const signerIdentities = {
    deployer: walletAddress('ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY', DEPLOYER),
    updater: walletAddress('ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY', UPDATER),
    creator: walletAddress('ROBINHOOD_TESTNET_CREATOR_PRIVATE_KEY', CREATOR),
    traderA: walletAddress('ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY', TRADER_A),
    traderB: walletAddress('ROBINHOOD_TESTNET_TRADER_B_PRIVATE_KEY', TRADER_B),
  };

  const factoryState = {
    live: await factory.live(),
    createPaused: await factory.createPaused(),
    globalPaused: await factory.globalPaused(),
    securityDefaultsLocked: await factory.securityDefaultsLocked(),
    requireAuthorizedTrading: await factory.requireAuthorizedTrading(),
    requireRouteAuthorization: await factory.requireRouteAuthorization(),
    campaignsCount: (await factory.campaignsCount()).toString(),
  };
  assert(factoryState.live === true, 'FACTORY_NOT_LIVE');
  assert(factoryState.createPaused === true && factoryState.globalPaused === true, 'FACTORY_NOT_FAIL_CLOSED');
  assert(factoryState.securityDefaultsLocked && factoryState.requireAuthorizedTrading && factoryState.requireRouteAuthorization, 'FACTORY_SECURITY_DEFAULTS_INVALID');

  const registry = new ethers.Contract(runtimeAddresses.creatorRegistry, registryAbi, provider);
  const eligibilityTuple = await factory.creatorLaunchEligibility(CREATOR);
  const profile = await registry.getCreatorProfile(CREATOR);
  const rules = await registry.getCreatorRules(CREATOR);
  const latestBlock = await provider.getBlock('latest');
  assert(latestBlock, 'LATEST_BLOCK_MISSING');

  const eligibility = {
    allowed: Boolean(eligibilityTuple.allowed ?? eligibilityTuple[0]),
    restricted: Boolean(profile.restricted ?? profile[4]),
    manualReviewRequired: Boolean(profile.manualReviewRequired ?? profile[5]),
    lastLaunchTimestamp: (profile.lastLaunchTimestamp ?? profile[3]).toString(),
    cooldownSeconds: (rules.cooldownSeconds ?? rules[1]).toString(),
    cooldownEndsAt: (eligibilityTuple.cooldownEndsAt ?? eligibilityTuple[1]).toString(),
    liveBondingCount: (profile.liveBondingCount ?? profile[2]).toString(),
    currentLiveCount: (eligibilityTuple.currentLiveCount ?? eligibilityTuple[2]).toString(),
    maxLiveBonding: (eligibilityTuple.maxLiveBonding ?? eligibilityTuple[3]).toString(),
    tier: (profile.tier ?? profile[0]).toString(),
    trustScore: (profile.trustScore ?? profile[1]).toString(),
  };
  const classification = classifyCreatorEligibility({ ...eligibility, now: latestBlock.timestamp });
  eligibility.reason = classification.reason;
  eligibility.computedCooldownEndsAt = classification.cooldownEndsAt.toString();
  assert(eligibility.liveBondingCount === eligibility.currentLiveCount, 'ELIGIBILITY_LIVE_COUNT_MISMATCH');
  assert(eligibility.maxLiveBonding === (rules.maxLiveBonding ?? rules[0]).toString(), 'ELIGIBILITY_MAX_LIVE_MISMATCH');

  let existingCampaign = { campaign: EXISTING_CAMPAIGN, token: EXISTING_TOKEN, resumable: false, resumeStep: null };
  const campaignCount = BigInt(await factory.campaignsCount());
  if (campaignCount > 0n) {
    let matched = null;
    for (let i = 0n; i < campaignCount; i++) {
      const info = await factory.getCampaign(i);
      if (same(info.campaign, EXISTING_CAMPAIGN)) { matched = { id: i, info }; break; }
    }
    assert(matched, 'EXISTING_CAMPAIGN_NOT_REGISTERED_IN_FACTORY');
    assert(same(matched.info.token, EXISTING_TOKEN), `EXISTING_TOKEN_MISMATCH_${matched.info.token}`);
    assert(same(matched.info.creator, CREATOR), `EXISTING_CREATOR_MISMATCH_${matched.info.creator}`);
    assert(await factory.isCampaign(EXISTING_CAMPAIGN), 'EXISTING_CAMPAIGN_NOT_CANONICAL');
    assert((await provider.getCode(EXISTING_CAMPAIGN)) !== '0x', 'EXISTING_CAMPAIGN_CODE_MISSING');
    assert((await provider.getCode(EXISTING_TOKEN)) !== '0x', 'EXISTING_TOKEN_CODE_MISSING');

    const campaign = new ethers.Contract(EXISTING_CAMPAIGN, campaignAbi, provider);
    const campaignToken = await campaign.token();
    const campaignCreator = await campaign.creator();
    const launched = await campaign.launched();
    const graduationRecorded = await factory.campaignGraduationRecorded(EXISTING_CAMPAIGN);
    const pauseState = {
      paused: await campaign.paused(),
      buyPaused: await campaign.buyPaused(),
      sellPaused: await campaign.sellPaused(),
      graduationPaused: await campaign.graduationPaused(),
    };
    const graduationState = await campaign.getGraduationState();
    const dexPair = graduationState[0];
    const graduationTarget = await campaign.graduationTarget();
    const tradeRouteProfile = await campaign.tradeRouteProfile();
    const finalizeRouteProfile = await campaign.finalizeRouteProfile();
    const requireAuthorizedTrading = await campaign.requireAuthorizedTrading();
    const netRaisedWei = await campaign.netRaisedWei();
    const sold = await campaign.sold();

    const healthyPreGrad = same(campaignToken, EXISTING_TOKEN)
      && same(campaignCreator, CREATOR)
      && !launched
      && !graduationRecorded
      && dexPair === ethers.ZeroAddress
      && !pauseState.paused
      && !pauseState.buyPaused
      && !pauseState.sellPaused
      && !pauseState.graduationPaused
      && requireAuthorizedTrading
      && graduationTarget === ethers.parseEther('6');

    existingCampaign = {
      id: matched.id.toString(),
      campaign: EXISTING_CAMPAIGN,
      token: EXISTING_TOKEN,
      creator: campaignCreator,
      factoryGeneration: '4',
      campaignGeneration: '3',
      launched,
      graduationRecorded,
      dexPair,
      graduationTarget: graduationTarget.toString(),
      netRaisedWei: netRaisedWei.toString(),
      sold: sold.toString(),
      tradeRouteProfile: tradeRouteProfile.toString(),
      finalizeRouteProfile: finalizeRouteProfile.toString(),
      requireAuthorizedTrading,
      pauseState,
      resumable: healthyPreGrad,
      resumeStep: healthyPreGrad ? 'BUY_SELL_THEN_BOND_TO_GRADUATION' : null,
    };
  }

  const action = chooseLifecycleAction({ creatorAllowed: eligibility.allowed, existingCampaign });
  if (action.createRequired) assert(eligibility.allowed, `CREATOR_NOT_ELIGIBLE_${eligibility.reason}_${JSON.stringify(eligibility)}`);

  const balances = {};
  for (const [label, address] of Object.entries({ DEPLOYER, UPDATER, CREATOR, TRADER_A, TRADER_B })) {
    balances[label] = (await provider.getBalance(address)).toString();
    assert(BigInt(balances[label]) > 0n, `FUNDING_ZERO_${label}`);
  }

  const report = {
    mode: 'ZERO_WRITE_PREFLIGHT',
    chainId,
    production4663Rejected: true,
    sourceSha: process.env.RH46630_CERT_HEAD_SHA || process.env.GITHUB_SHA || 'local',
    runtimeAddresses,
    generations: { factory: 4, campaign: 3 },
    signerIdentities,
    factoryState,
    creatorEligibility: eligibility,
    existingCampaign,
    action,
    balances,
    nextWritePreflight: null,
    chainWrites: 0,
  };

  if (action.mode !== 'RESUME_EXISTING') {
    fs.writeFileSync(OUT, json(report));
    throw new Error('EXACT_NEXT_WRITE_PREFLIGHT_REQUIRES_RESUMABLE_EXISTING_CAMPAIGN');
  }

  const campaign = new ethers.Contract(existingCampaign.campaign, campaignAbi, provider);
  const campaignState = {
    launched: await campaign.launched(),
    graduationPending: await campaign.graduationPending(),
    paused: await campaign.paused(),
    buyPaused: await campaign.buyPaused(),
    sellPaused: await campaign.sellPaused(),
    graduationPaused: await campaign.graduationPaused(),
    launchAt: (await campaign.launchAt()).toString(),
    currentBlockNumber: latestBlock.number.toString(),
    currentBlockTimestamp: latestBlock.timestamp.toString(),
  };

  const launchProtectionRaw = {
    launchProtectionEndBlock: await campaign.launchProtectionEndBlock(),
    launchProtectionBlocksPending: await campaign.launchProtectionBlocksPending(),
    launchProtectionMaxBuyWei: await campaign.launchProtectionMaxBuyWei(),
    launchProtectionMaxWalletWei: await campaign.launchProtectionMaxWalletWei(),
    protectedBuyWei: await campaign.protectedBuyWei(TRADER_A),
  };

  const riskRegistryAddress = await campaign.riskRegistry();
  let riskRegistryState = {
    address: riskRegistryAddress,
    walletRiskProfile: null,
    walletRestricted: false,
    clusterId: ethers.ZeroHash,
    clusterProfile: null,
    clusterRestricted: false,
    assertWalletCanTrade: { pass: true, decodedErrorName: null, selector: null, decodedArguments: [] },
  };
  if (riskRegistryAddress !== ethers.ZeroAddress) {
    assert((await provider.getCode(riskRegistryAddress)) !== '0x', 'RISK_REGISTRY_CODE_MISSING');
    const riskRegistry = new ethers.Contract(riskRegistryAddress, riskRegistryAbi, provider);
    const walletRisk = await riskRegistry.getWalletRisk(TRADER_A);
    const clusterId = walletRisk.clusterId ?? walletRisk[2];
    let clusterRisk = null;
    if (clusterId !== ethers.ZeroHash) clusterRisk = await riskRegistry.getClusterRisk(clusterId);
    riskRegistryState = {
      address: riskRegistryAddress,
      walletRiskProfile: {
        riskLevel: Number(walletRisk.riskLevel ?? walletRisk[0]),
        restricted: Boolean(walletRisk.restricted ?? walletRisk[1]),
        clusterId,
      },
      walletRestricted: Boolean(walletRisk.restricted ?? walletRisk[1]),
      clusterId,
      clusterProfile: clusterRisk ? {
        size: (clusterRisk.size ?? clusterRisk[0]).toString(),
        riskLevel: Number(clusterRisk.riskLevel ?? clusterRisk[1]),
        restricted: Boolean(clusterRisk.restricted ?? clusterRisk[2]),
      } : null,
      clusterRestricted: clusterRisk ? Boolean(clusterRisk.restricted ?? clusterRisk[2]) : false,
      assertWalletCanTrade: { pass: true, decodedErrorName: null, selector: null, decodedArguments: [] },
    };
    try {
      await riskRegistry.assertWalletCanTrade.staticCall(TRADER_A);
    } catch (error) {
      const decoded = decodeEthersError(error, decoders);
      riskRegistryState.assertWalletCanTrade = { pass: false, ...decoded };
    }
  }

  const graduationOracle = new ethers.Contract(runtimeAddresses.graduationOracle, graduationOracleAbi, provider);
  const priceFeedAddress = await graduationOracle.priceFeed();
  assert(same(priceFeedAddress, ETH_USD_ORACLE), `GRADUATION_PRICE_FEED_MISMATCH_${priceFeedAddress}`);
  const maxPriceAge = await graduationOracle.maxPriceAge();
  const feed = new ethers.Contract(ETH_USD_ORACLE, [
    'function decimals() view returns(uint8)',
    'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  ], provider);
  const feedDecimals = Number(await feed.decimals());
  const feedRound = await feed.latestRoundData();
  assert(feedRound.answer > 0n, 'PRICE_FEED_ANSWER_NOT_POSITIVE');
  const feedAge = BigInt(latestBlock.timestamp) - BigInt(feedRound.updatedAt);
  const feedFresh = feedRound.updatedAt > 0n && feedRound.answeredInRound >= feedRound.roundId && feedAge >= 0n && feedAge <= maxPriceAge;
  const operatorPriceRaw = String(process.env.ROBINHOOD_ETH_USD_8 || '').trim();
  const operatorPriceValid = /^[0-9]+$/.test(operatorPriceRaw) && BigInt(operatorPriceRaw || '0') > 0n;
  const sizingFeedAnswer = feedFresh ? feedRound.answer : (operatorPriceValid ? BigInt(operatorPriceRaw) : feedRound.answer);
  const sizingPriceSource = feedFresh ? 'CURRENT_FRESH_FEED' : (operatorPriceValid ? 'PROSPECTIVE_ORACLE_REFRESH_INPUT' : 'CURRENT_STALE_FEED_DIAGNOSTIC_ONLY');
  const exactForProspectiveOracleRefresh = feedFresh || operatorPriceValid;
  const priceState = {
    feed: ETH_USD_ORACLE,
    decimals: feedDecimals,
    roundId: feedRound.roundId.toString(),
    answer: feedRound.answer.toString(),
    updatedAt: feedRound.updatedAt.toString(),
    answeredInRound: feedRound.answeredInRound.toString(),
    maxPriceAge: maxPriceAge.toString(),
    ageSeconds: feedAge.toString(),
    freshNow: feedFresh,
    sizingFeedAnswer: sizingFeedAnswer.toString(),
    sizingPriceSource,
    exactForProspectiveOracleRefresh,
    sizingRule: 'SAME GraduationOracle.nativeTargetForUsd CEILING FORMULA; if stale, use protected workflow oracle-refresh input',
  };

  const graduationTargetUsd = await campaign.graduationTarget();
  const targetForFirstBuy = computeNativeTargetFromUsd(graduationTargetUsd, sizingFeedAnswer, feedDecimals);
  const firstValue = computeFirstBuyValue(targetForFirstBuy);
  const quote = await campaign.quoteBuyExactBnb(firstValue);
  const tokensOut = quote[0];
  const totalCostWei = quote[1];
  const feeWei = quote[2];
  assert(tokensOut > 0n, 'NEXT_BUY_QUOTE_ZERO');
  const costNoFee = totalCostWei - feeWei;
  const protectionAssessment = assessLaunchProtection({
    blockNumber: latestBlock.number,
    endBlock: launchProtectionRaw.launchProtectionEndBlock,
    pendingBlocks: launchProtectionRaw.launchProtectionBlocksPending,
    maxBuyWei: launchProtectionRaw.launchProtectionMaxBuyWei,
    maxWalletWei: launchProtectionRaw.launchProtectionMaxWalletWei,
    protectedBuyWei: launchProtectionRaw.protectedBuyWei,
    costNoFee,
  });
  const launchProtection = {
    launchProtectionEndBlock: launchProtectionRaw.launchProtectionEndBlock.toString(),
    launchProtectionBlocksPending: launchProtectionRaw.launchProtectionBlocksPending.toString(),
    launchProtectionMaxBuyWei: launchProtectionRaw.launchProtectionMaxBuyWei.toString(),
    launchProtectionMaxWalletWei: launchProtectionRaw.launchProtectionMaxWalletWei.toString(),
    protectedBuyWei: launchProtectionRaw.protectedBuyWei.toString(),
    currentlyActive: protectionAssessment.currentlyActive,
    willActivateOnNextBuy: protectionAssessment.willActivateOnNextBuy,
    protectionActiveForProposedBuy: protectionAssessment.appliesToNextBuy,
    effectiveEndBlockForProposedBuy: protectionAssessment.effectiveEndBlock.toString(),
    proposedCostNoFee: protectionAssessment.proposedCostNoFee.toString(),
    proposedWalletProtectedWei: protectionAssessment.proposedWalletProtectedWei.toString(),
    buyLimitExceeded: protectionAssessment.buyLimitExceeded,
    walletLimitExceeded: protectionAssessment.walletLimitExceeded,
  };

  const routeAuthority = await factory.routeAuthority();
  const requireAuthorizedTrading = await campaign.requireAuthorizedTrading();
  const tradeRouteProfile = Number(await campaign.tradeRouteProfile());
  const minTokensOut = 0n;
  const deadline = BigInt(latestBlock.timestamp) + 611n;
  const rawDigest = makeTradeDigest(existingCampaign.campaign, TRADER_A, tradeRouteProfile, 1, firstValue, minTokensOut, deadline);
  const updater = protectedWallet('ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY', UPDATER);
  const routeSignature = await updater.signMessage(ethers.getBytes(rawDigest));
  const recoveredSigner = ethers.verifyMessage(ethers.getBytes(rawDigest), routeSignature);
  const eip191Digest = ethers.hashMessage(ethers.getBytes(rawDigest));
  const operationSelector = campaign.interface.getFunction('buyExactBnbAuthorized').selector;
  const routeAuthorization = {
    routeAuthority,
    requireAuthorizedTrading,
    tradeRouteProfile,
    action: 1,
    actionName: 'BUY_EXACT_BNB',
    amount: firstValue.toString(),
    limit: minTokensOut.toString(),
    rawDigest,
    eip191Digest,
    signerAddress: recoveredSigner,
    signerMatchesRouteAuthority: same(recoveredSigner, routeAuthority),
    deadline: deadline.toString(),
    currentBlockTimestamp: latestBlock.timestamp.toString(),
    expiresInSeconds: (deadline - BigInt(latestBlock.timestamp)).toString(),
  };
  assert(routeAuthorization.signerMatchesRouteAuthority, `ROUTE_SIGNER_MISMATCH_${recoveredSigner}_${routeAuthority}`);

  const relevantState = {
    campaignState,
    launchProtection,
    riskRegistry: riskRegistryState,
    routeAuthorization,
    priceState,
    quote: {
      msgValue: firstValue.toString(),
      minTokensOut: minTokensOut.toString(),
      tokensOut: tokensOut.toString(),
      totalCostWei: totalCostWei.toString(),
      feeWei: feeWei.toString(),
      costNoFee: costNoFee.toString(),
      targetForFirstBuy: targetForFirstBuy.toString(),
    },
  };

  let nextWritePreflight;
  try {
    const traderA = protectedWallet('ROBINHOOD_TESTNET_TRADER_A_PRIVATE_KEY', TRADER_A, provider);
    const connectedCampaign = campaign.connect(traderA);
    const result = await connectedCampaign.buyExactBnbAuthorized.staticCall(
      minTokensOut,
      tradeRouteProfile,
      deadline,
      routeSignature,
      { value: firstValue }
    );
    nextWritePreflight = {
      status: 'PASS',
      operation: 'BUY_EXACT_BNB_AUTHORIZED',
      campaign: existingCampaign.campaign,
      actor: TRADER_A,
      value: firstValue.toString(),
      msgValue: firstValue.toString(),
      minTokensOut: minTokensOut.toString(),
      tradeRouteProfile,
      deadline: deadline.toString(),
      rawDigest,
      routeSignature,
      operationSelector,
      revertSelector: null,
      decodedErrorName: null,
      decodedArguments: [],
      staticCallResult: { tokensOut: result[0].toString(), totalSpent: result[1].toString() },
      exactForProspectiveOracleRefresh,
      relevantState,
      chainWrites: 0,
    };
  } catch (error) {
    const decoded = decodeEthersError(error, decoders);
    nextWritePreflight = {
      status: 'BLOCKED',
      operation: 'BUY_EXACT_BNB_AUTHORIZED',
      campaign: existingCampaign.campaign,
      actor: TRADER_A,
      value: firstValue.toString(),
      msgValue: firstValue.toString(),
      minTokensOut: minTokensOut.toString(),
      tradeRouteProfile,
      deadline: deadline.toString(),
      rawDigest,
      routeSignature,
      operationSelector,
      revertSelector: decoded.selector,
      decodedErrorName: decoded.decodedErrorName,
      decodedArguments: decoded.decodedArguments,
      decodedErrorScope: decoded.scope || null,
      revertData: decoded.data,
      shortMessage: decoded.shortMessage,
      exactForProspectiveOracleRefresh,
      relevantState,
      chainWrites: 0,
    };
  }

  report.nextWritePreflight = nextWritePreflight;
  fs.writeFileSync(OUT, json(report));
  if (nextWritePreflight.status === 'BLOCKED') {
    printBlocked(nextWritePreflight);
    throw new Error(`RH46630_NEXT_WRITE_BLOCKED_${nextWritePreflight.decodedErrorName}`);
  }
  console.log(json(report));
  console.log('RH46630_NEXT_WRITE_PREFLIGHT=PASS');
  console.log('CHAIN_WRITES=0');
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

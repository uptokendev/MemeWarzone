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

function walletAddress(pkName, expected) {
  const raw = req(pkName);
  const wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
  assert(same(wallet.address, expected), `SIGNER_MISMATCH_${pkName}_${wallet.address}`);
  return wallet.address;
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
    chainWrites: 0,
  };
  fs.writeFileSync(OUT, json(report));
  console.log(json(report));
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROUTE_BPS = 10_000;
export const PROTOCOL_FEE_BPS = 200;
export const CREATOR_SHARE_OF_FEE_POT_BPS = 500;
export const CREATOR_ABSOLUTE_BPS_OF_VOLUME = 10;
export const LEAGUE_SHARE_BPS = 3_750;
export const STANDARD_LINKED = {
  name: "Standard",
  recruiterBps: 1_250,
  airdropBps: 0,
  squadBps: 250,
};
export const STANDARD_UNLINKED = {
  name: "Unlinked",
  recruiterBps: 0,
  airdropBps: 1_500,
  squadBps: 0,
};
export const OG_LINKED = {
  name: "OG",
  recruiterBps: 1_500,
  airdropBps: 0,
  squadBps: 250,
};

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

function requireIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} is missing required proof text: ${needle}`);
}

export function creatorAbsoluteBpsOfVolume() {
  return (PROTOCOL_FEE_BPS * CREATOR_SHARE_OF_FEE_POT_BPS) / ROUTE_BPS;
}

export function expectedTradeSplit(feeAmount, profile) {
  const fee = BigInt(feeAmount);
  const league = (fee * BigInt(LEAGUE_SHARE_BPS)) / BigInt(ROUTE_BPS);
  const creator = (fee * BigInt(CREATOR_SHARE_OF_FEE_POT_BPS)) / BigInt(ROUTE_BPS);
  const recruiter = (fee * BigInt(profile.recruiterBps)) / BigInt(ROUTE_BPS);
  const airdrop = (fee * BigInt(profile.airdropBps)) / BigInt(ROUTE_BPS);
  const squad = (fee * BigInt(profile.squadBps)) / BigInt(ROUTE_BPS);
  const protocol = fee - league - creator - recruiter - airdrop - squad;
  return { league, creator, recruiter, airdrop, squad, protocol };
}

export function expectedFeeFromNotional(costNoFee) {
  return (BigInt(costNoFee) * BigInt(PROTOCOL_FEE_BPS)) / BigInt(ROUTE_BPS);
}

export function proveCreatorFeeMath() {
  const absoluteBps = creatorAbsoluteBpsOfVolume();
  if (absoluteBps !== CREATOR_ABSOLUTE_BPS_OF_VOLUME) {
    throw new Error(
      `creator royalty must be ${CREATOR_ABSOLUTE_BPS_OF_VOLUME} bps (0.10%) of trade volume; got ${absoluteBps}`,
    );
  }
  if (PROTOCOL_FEE_BPS * CREATOR_SHARE_OF_FEE_POT_BPS !== CREATOR_ABSOLUTE_BPS_OF_VOLUME * ROUTE_BPS) {
    throw new Error("0.10% of volume must equal 5% of the 2% routed fee with integer identity");
  }

  const sampleNotional = 1_000_000n;
  const fee = expectedFeeFromNotional(sampleNotional);
  if (fee !== 20_000n) throw new Error("2% of 1_000_000 must be 20_000");
  for (const profile of [STANDARD_LINKED, STANDARD_UNLINKED, OG_LINKED]) {
    const split = expectedTradeSplit(fee, profile);
    if (split.creator !== 1_000n) {
      throw new Error(`${profile.name} creator share must be 1_000 on a 20_000 fee pot (0.10% of 1_000_000)`);
    }
    const total = split.league + split.creator + split.recruiter + split.airdrop + split.squad + split.protocol;
    if (total !== fee) throw new Error(`${profile.name} fee buckets must consume the entire 2% pot`);
  }
  return {
    protocolFeeBps: PROTOCOL_FEE_BPS,
    creatorShareOfFeePotBps: CREATOR_SHARE_OF_FEE_POT_BPS,
    creatorAbsoluteBpsOfVolume: absoluteBps,
    sample: {
      notional: sampleNotional.toString(),
      fee: fee.toString(),
      creator: "1000",
    },
  };
}

export function proveCreatorFeeSource() {
  const router = readRepoFile("contracts/TreasuryRouterV3.sol");
  requireIncludes(router, "amounts.creator = (amount * 500) / ROUTE_BPS;", "TreasuryRouterV3 previewTrade");
  requireIncludes(router, "amounts.league = (amount * 3750) / ROUTE_BPS;", "TreasuryRouterV3 previewTrade");
  requireIncludes(router, "recruiterBps = 1250;", "TreasuryRouterV3 Standard");
  requireIncludes(router, "airdropBps = 1500;", "TreasuryRouterV3 Unlinked");
  requireIncludes(router, "recruiterBps = 1500;", "TreasuryRouterV3 OG");
  if (!/function _routeFinalize[\s\S]*amounts = previewFinalize/.test(router)) {
    throw new Error("TreasuryRouterV3 finalize path must use previewFinalize");
  }
  if (/function previewFinalize[\s\S]*amounts\.creator = \(amount \* 500\)/.test(router)) {
    throw new Error("finalize routing must stay creator-free");
  }

  const factory = readRepoFile("contracts/LaunchFactory.sol");
  requireIncludes(factory, "uint32 public constant FACTORY_GENERATION = 4;", "LaunchFactory");
  requireIncludes(factory, "uint32 public constant CAMPAIGN_GENERATION = 3;", "LaunchFactory");
  requireIncludes(factory, "uint8 public constant LIQUIDITY_KIND_V2_ERC20 = 1;", "LaunchFactory");
  requireIncludes(factory, "protocolFeeBps = 200;", "LaunchFactory");
  requireIncludes(factory, "strictFeeRouting: true", "LaunchFactory");

  const campaign = readRepoFile("contracts/LaunchCampaign.sol");
  requireIncludes(campaign, "return (amountWei * protocolFeeBps) / MAX_BPS;", "LaunchCampaign fee");
  requireIncludes(campaign, "IPhase1TreasuryRouterV3(payable(feeRecipient)).routeTrade{value: feeAmount}(routeProfile);", "LaunchCampaign");

  const census = JSON.parse(readRepoFile("deployments/bnb/mainnet.current.json"));
  if (Number(census.factoryGeneration) !== 3 || Number(census.campaignGeneration) !== 2) {
    throw new Error("6B must not rewrite live BNB census away from 3/2");
  }
  if (census.uniswapV3Rejected !== true) throw new Error("6B must keep BNB Uniswap V3 rejected");
  return { sourceHead: "4/3", liveBnb: "3/2", uniswapV3Rejected: true };
}

export function proveBnbCreatorFeeGeneration() {
  return {
    math: proveCreatorFeeMath(),
    source: proveCreatorFeeSource(),
  };
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const result = proveBnbCreatorFeeGeneration();
  console.log("BNB 6B creator-fee generation source proof passed");
  console.log(JSON.stringify(result, null, 2));
}

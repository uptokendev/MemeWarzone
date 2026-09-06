import { ethers } from "hardhat";
import { assertCode, loadDeployment, resolveContracts } from "./verify-deployment";

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  return BigInt(raw);
}

function numberEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}: expected non-negative integer`);
  return value;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function quoteBinding(campaignAddress: string): Promise<string> {
  try {
    const quoteCampaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", campaignAddress);
    return String(await quoteCampaign.quoteCatalogBindingHash());
  } catch {
    return ethers.ZeroHash;
  }
}

async function retryPendingQuoteGraduation(id: number, symbol: string, campaignAddress: string, dryRun: boolean) {
  const binding = await quoteBinding(campaignAddress);
  if (binding === ethers.ZeroHash) {
    console.log(`[graduation-keeper] #${id} ${symbol} pending but not a BNB BASIC catalog-bound quote campaign`);
    return false;
  }

  console.log(`[graduation-keeper] #${id} ${symbol} BNB BASIC pending catalogBinding=${binding}`);
  if (dryRun) return false;

  const quoteCampaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", campaignAddress);
  try {
    const tx = await quoteCampaign.retryQuoteGraduation();
    console.log(`[graduation-keeper] retry submitted #${id} tx=${tx.hash}`);
    await tx.wait();
    return true;
  } catch (error: any) {
    // Unsafe/unavailable routes are expected to remain PENDING. The keeper is restart-safe:
    // a later run retries from current on-chain state without an operator-specific payload.
    console.warn(`[graduation-keeper] retry pending #${id}: ${String(error.message).split("\n")[0]}`);
    return false;
  }
}

async function main() {
  const dryRun = boolEnv("KEEPER_DRY_RUN", true);
  const offset = numberEnv("KEEPER_CAMPAIGN_OFFSET", 0);
  const limit = numberEnv("KEEPER_CAMPAIGN_LIMIT", 100);
  const minBalanceBufferWei = bigintEnv("GRADUATION_KEEPER_MIN_BUFFER_WEI", 0n);
  const minTokens = bigintEnv("GRADUATION_KEEPER_MIN_TOKENS", 0n);
  const minNative = bigintEnv("GRADUATION_KEEPER_MIN_NATIVE", 0n);

  const deployment = loadDeployment();
  const contracts = resolveContracts(deployment);
  await assertCode("LaunchFactory", contracts.LaunchFactory);
  const factory = await ethers.getContractAt("LaunchFactory", contracts.LaunchFactory);
  const total = Number(await factory.campaignsCount());
  const end = Math.min(total, offset + limit);

  console.log(`[graduation-keeper] dryRun=${dryRun} campaigns=${offset}-${Math.max(offset, end - 1)} total=${total}`);

  let submitted = 0;
  for (let id = offset; id < end; id += 1) {
    const info = await factory.getCampaign(BigInt(id));
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    if (await campaign.launched()) continue;
    if (await campaign.paused()) continue;
    if (await campaign.graduationPaused()) continue;

    if (await campaign.graduationPending()) {
      if (await retryPendingQuoteGraduation(id, info.symbol, info.campaign, dryRun)) submitted += 1;
      continue;
    }

    let target: bigint;
    try {
      target = await campaign.graduationNativeTarget();
    } catch (error: any) {
      console.warn(`[graduation-keeper] #${id} oracle unavailable: ${String(error.message).split("\n")[0]}`);
      continue;
    }

    const balance = await ethers.provider.getBalance(info.campaign);
    const eligible = balance >= target + minBalanceBufferWei;
    console.log(
      `[graduation-keeper] #${id} ${info.symbol} eligible=${eligible} balance=${balance} target=${target} campaign=${info.campaign}`
    );
    if (!eligible || dryRun) continue;

    const tx = await campaign.graduateIfEligible(minTokens, minNative);
    console.log(`[graduation-keeper] submitted #${id} tx=${tx.hash}`);
    await tx.wait();
    submitted += 1;

    // New BNB BASIC quote campaigns deliberately cross into PENDING first so route failures
    // cannot revert the user's threshold-crossing trade. Immediately retry in a separate atomic
    // transaction; if unsafe, the catch above leaves PENDING for the next keeper restart/run.
    if (await campaign.graduationPending()) {
      if (await retryPendingQuoteGraduation(id, info.symbol, info.campaign, false)) submitted += 1;
    }
  }

  console.log(`[graduation-keeper] complete submitted=${submitted}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

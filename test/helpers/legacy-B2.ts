import { ethers } from "hardhat";

/**
 * Group B2 (legacy route-authorization / launch-protection tests) helpers.
 *
 * The backend signer (frontend/api/dev-fix/routeAuthorizationSigner.js) still hashes the OLD 7-field
 * CampaignRequest because the live mainnet factories are the old generation. These tests sign the
 * CREATE authorization locally with the generation-6 11-field layout (test/fixtures/evmgenCore.ts
 * hashReq / signCreate) and keep the backend helper for trade signatures, whose digest is unchanged.
 */
export { signCreate, hashReq, req } from "../fixtures/evmgenCore";

/** Re-prices the factory's oracle feed (MockUsdPriceFeed) to `usd` per native, stamped now. */
export async function setNativeUsd(factory: any, usd: number) {
  const oracle = await ethers.getContractAt("GraduationOracle", await factory.graduationOracle());
  const feed = await ethers.getContractAt("MockUsdPriceFeed", await oracle.priceFeed());
  const block = await ethers.provider.getBlock("latest");
  const t = BigInt(block!.timestamp);
  await feed.setRoundData(2n, BigInt(usd) * 10n ** 8n, t, t, 2n);
}

/** Moves past the C2 anti-sniper window (launchAt + 60 s) so the trade fee is the flat protocolFeeBps. */
export async function passAntiSniperWindow(campaign: any) {
  const launchAt = Number(await campaign.launchAt());
  const block = await ethers.provider.getBlock("latest");
  const target = launchAt + 61;
  if (block!.timestamp < target) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [target]);
    await ethers.provider.send("evm_mine", []);
  }
}

/** Splits a quoteBuyExactTokens total into (costNoFee, fee) for fee = floor(costNoFee * bps / 1e4). */
export function splitBuyTotal(total: bigint, bps: bigint): { costNoFee: bigint; fee: bigint } {
  let c = (total * 10_000n) / (10_000n + bps);
  for (let d = -3n; d <= 3n; d++) {
    const cand = c + d;
    if (cand >= 0n && cand + (cand * bps) / 10_000n === total) {
      return { costNoFee: cand, fee: (cand * bps) / 10_000n };
    }
  }
  throw new Error(`no costNoFee for total ${total} at ${bps} bps`);
}

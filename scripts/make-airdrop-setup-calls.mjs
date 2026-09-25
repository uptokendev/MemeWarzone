#!/usr/bin/env node
/**
 * Calls for the Safe batch that lets our Coolify weekly airdrop job run unattended on an EVM chain
 * (founder, 2026-09-25: own server, pre-authorize 12 weeks). Output feeds scripts/make-safe-batch.ts.
 *
 *   1. CommunityRewardsVault.setRewardDistributor(distributor)
 *   2. CommunityRewardsVault.setAirdropOperator(operator)       -- the Coolify key
 *   3. RewardDistributor.setBatchOperator(vault)                -- the vault calls createBatch
 *   4. RewardDistributor.authorizeBatch(id, cap, after, deadline) x 12 weeks x {trader, creator}
 *
 * The batch ids are the runner's own (weeklyContractBatchId, imported, not re-typed), so the job can
 * fund exactly these and nothing else; each is capped and only publishable in its own 6-day window.
 *
 *   node scripts/make-airdrop-setup-calls.mjs --chain 56 --vault 0x.. --distributor 0x.. \
 *     --operator 0x.. --cap 0.5 [--weeks 12] [--skip-wiring] > /tmp/airdrop-56.json
 *   npx ts-node scripts/make-safe-batch.ts deployments/bnb/mainnet.airdrop-setup.safe-batch.json 56 \
 *     "MWZ airdrop: wire + pre-authorize 12 weeks" "..." /tmp/airdrop-56.json
 */
import { getAddress, parseEther } from "ethers";
import { weeklyContractBatchId } from "../frontend/scripts/weekly-airdrop/materialize.mjs";
import { epochWindow } from "../frontend/scripts/weekly-airdrop/config.mjs";

const DAY = 86_400;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const chainId = Number(flag("chain"));
if (![56, 97, 4663, 46630].includes(chainId)) throw new Error("--chain must be 56, 97, 4663 or 46630");
const vault = getAddress(flag("vault"));
const distributor = getAddress(flag("distributor"));
const operator = flag("operator") ? getAddress(flag("operator")) : null;
const cap = parseEther(String(flag("cap") || ""));
if (cap <= 0n) throw new Error("--cap (max native per weekly batch per program) is required");
const weeks = Math.max(1, Math.min(26, Number(flag("weeks") || 12)));
const skipWiring = args.includes("--skip-wiring");
if (!skipWiring && !operator) throw new Error("--operator (the Coolify airdrop key) is required unless --skip-wiring");

const calls = [];
if (!skipWiring) {
  calls.push({ contract: "CommunityRewardsVault", to: vault, fn: "setRewardDistributor", args: [distributor] });
  calls.push({ contract: "CommunityRewardsVault", to: vault, fn: "setAirdropOperator", args: [operator] });
  calls.push({ contract: "RewardDistributor", to: distributor, fn: "setBatchOperator", args: [vault] });
}

// The next run draws the week that ends at the coming Monday 00:00 UTC.
const { end: lastEnded } = epochWindow();
const firstEnd = lastEnded.getTime() / 1000 <= Date.now() / 1000 ? lastEnded.getTime() / 1000 + 7 * DAY : lastEnded.getTime() / 1000;
for (let week = 0; week < weeks; week += 1) {
  const end = firstEnd + week * 7 * DAY;
  const epochId = new Date((end - 7 * DAY) * 1000).toISOString().slice(0, 10);
  for (const program of ["airdrop_trader", "airdrop_creator"]) {
    calls.push({
      contract: "RewardDistributor",
      to: distributor,
      fn: "authorizeBatch",
      args: [weeklyContractBatchId(chainId, epochId, program), cap.toString(), String(end), String(end + 6 * DAY)],
      note: `${epochId} ${program}`,
    });
  }
}
process.stdout.write(`${JSON.stringify(calls, null, 2)}\n`);

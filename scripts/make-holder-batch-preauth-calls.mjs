#!/usr/bin/env node
/**
 * Calls for the Safe batch that pre-authorizes the coming weeks' HOLDER batches on a creator vault's holder
 * RewardDistributor (gen-6 vault, or gen-7's own vault: founder 2026-10-08, its own stack). Output feeds
 * scripts/make-safe-batch.ts, like make-airdrop-setup-calls.mjs.
 *
 * Why: CreatorRewardsVaultV2.executeHolderBatch funds RewardDistributor.createBatch, which needs
 * authorizeBatch(batchId, maxAmount, publishAfter, publishDeadline) from the owner (Safe) first
 * (contracts/RewardDistributor.sol:78-118). The holder batch ids are deterministic per chain, week and program
 * (keccak256("mwz-weekly-airdrop:<chain>:<week>:<program>"), realtime-indexer/src/evm/evmCreatorChoice.ts), so the
 * Safe can authorize weeks ahead and the weekly Safe step shrinks to approveHolderBatch on the vault, which binds the
 * exact root and total and cannot be given ahead (CreatorRewardsVaultV2.sol:434-439, audit 5 M1). A pre-authorization
 * moves nothing: only the vault (batchOperator) or the Safe can call createBatch, and the vault only does so in
 * executeHolderBatch for a root the Safe approved. The Fee routing page warns FINANCE_HOLDER_PREAUTH_WARN_WEEKS (3)
 * weeks before the authorized weeks run out (frontend/api/lib/financeHolderBatchAlerts.js); this batch renews them.
 *
 * Per week W (Monday epochId) the batch for W is built on the Monday that ends it (end = W + 7 days), so:
 *   authorizeBatch(holderBatchId(chain, W, program), cap, end, end + 6 days)
 *
 *   node scripts/make-holder-batch-preauth-calls.mjs --chain 56 --distributor 0x.. --cap 2 \
 *     [--program airdrop_holders | airdrop_holders_gen7] [--weeks 12] [--from 2026-10-12] > /tmp/holders-56.json
 *   npx ts-node scripts/make-safe-batch.ts deployments/bnb/mainnet.holders-preauth.safe-batch.json 56 \
 *     "MWZ holders: pre-authorize 12 weeks" "..." /tmp/holders-56.json
 *
 * --cap: native per weekly batch (ether units), at most the vault's maxHolderBatchPerWeek (check-evm-payout-bounds
 * fails above it); keep EVM_HOLDER_BATCH_MAX_WEI / EVM_GEN7_HOLDER_BATCH_MAX_WEI on the worker at or below it, or the
 * execute reverts BatchAboveAuthorizedMax. --from <epochId> starts at that week instead of the current one.
 * authorizeBatch reverts on a consumed id, so a renewal must not include a week whose batch already executed.
 */
import { pathToFileURL } from "node:url";
import { getAddress, keccak256, parseEther, toUtf8Bytes } from "ethers";

const DAY = 86_400;
const CHAINS = [56, 97, 4663, 46630];
const PROGRAMS = ["airdrop_holders", "airdrop_holders_gen7"];

export function holderBatchId(chainId, weekId, program = "airdrop_holders") {
  return keccak256(toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${weekId}:${program}`));
}

/** Monday 00:00 UTC (unix seconds) of the week containing `now`, or of --from. */
export function firstWeekStart({ now = new Date(), from = null } = {}) {
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("--from must be an epochId (YYYY-MM-DD, a Monday)");
    const start = Date.parse(`${from}T00:00:00Z`) / 1000;
    if (!Number.isFinite(start) || new Date(start * 1000).getUTCDay() !== 1) throw new Error("--from must be a Monday");
    return start;
  }
  const d = new Date(now);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

export function holderPreauthCalls({ chainId, distributor, cap, program = "airdrop_holders", weeks = 12, now = new Date(), from = null }) {
  if (!CHAINS.includes(Number(chainId))) throw new Error("--chain must be 56, 97, 4663 or 46630");
  if (!PROGRAMS.includes(program)) throw new Error(`--program must be ${PROGRAMS.join(" or ")}`);
  if (BigInt(cap) <= 0n) throw new Error("--cap must be positive");
  const to = getAddress(distributor);
  const count = Math.max(1, Math.min(26, Number(weeks) || 12));
  const first = firstWeekStart({ now, from });
  const calls = [];
  for (let i = 0; i < count; i += 1) {
    const start = first + i * 7 * DAY;
    const end = start + 7 * DAY;
    const weekId = new Date(start * 1000).toISOString().slice(0, 10);
    calls.push({
      contract: "RewardDistributor",
      to,
      fn: "authorizeBatch",
      args: [holderBatchId(Number(chainId), weekId, program), BigInt(cap).toString(), String(end), String(end + 6 * DAY)],
      note: `${weekId} ${program}`,
    });
  }
  return calls;
}

export function parsePreauthArgs(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const chainId = Number(flag("chain"));
  const cap = parseEther(String(flag("cap") || "0"));
  if (cap <= 0n) throw new Error("--cap (max native per weekly holder batch) is required");
  return { chainId, distributor: getAddress(String(flag("distributor") || "")), cap, program: flag("program") || "airdrop_holders", weeks: Number(flag("weeks") || 12), from: flag("from") || null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const calls = holderPreauthCalls(parsePreauthArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(calls, null, 2)}\n`);
}

#!/usr/bin/env node
/**
 * Calls for the Safe batch that lets our Coolify weekly airdrop job run unattended on an EVM chain
 * (founder, 2026-09-25: own server, pre-authorize 12 weeks). Output feeds scripts/make-safe-batch.ts.
 *
 * Per pot (main = the existing vault/distributor; gen-7 = the gen-7 router's own vault + a second
 * airdrop RewardDistributor, founder 2026-10-08), in ONE batch:
 *
 *   1. CommunityRewardsVault.setRewardDistributor(distributor)
 *   2. CommunityRewardsVault.setAirdropOperator(operator)       -- the Coolify key (same key on both pots)
 *   3. RewardDistributor.setBatchOperator(vault)                -- the vault calls createBatch
 *   4. RewardDistributor.authorizeBatch(id, cap, after, deadline) x weeks x {trader, creator}
 *
 * Order: main wiring, gen-7 wiring, main authorizations, gen-7 authorizations. Without --gen7-* the
 * output is exactly the single-pot batch this script always wrote.
 *
 * The batch ids are the runner's own (weeklyContractBatchId with the pot, imported, not re-typed), so
 * the job can fund exactly these and nothing else; each is capped and only publishable in its own
 * 6-day window. The weekly runner alerts when any pot has fewer than AIRDROP_AUTH_ALERT_WEEKS (3)
 * authorized weeks left; this one batch renews every pot.
 *
 *   node scripts/make-airdrop-setup-calls.mjs --chain 56 --vault 0x.. --distributor 0x.. \
 *     --operator 0x.. --cap 0.5 [--weeks 12] [--from 2026-10-12] \
 *     [--gen7-vault 0x.. --gen7-distributor 0x.. [--gen7-cap 0.5] [--gen7-operator 0x..]] \
 *     [--skip-wiring | --wiring all|none|main|gen7] [--only main|gen7] > /tmp/airdrop-56.json
 *   npx ts-node scripts/make-safe-batch.ts deployments/bnb/mainnet.airdrop-setup.safe-batch.json 56 \
 *     "MWZ airdrop: wire + pre-authorize 12 weeks" "..." /tmp/airdrop-56.json
 *
 * --from <epochId> starts at that week (a Monday) instead of the coming one, so a renewal can begin
 * after the last authorized week. authorizeBatch reverts on a consumed id, so a renewal that overlaps a
 * week already drawn makes the whole Safe batch revert; sign renewals before Monday 00:15 UTC or use --from.
 */
import { pathToFileURL } from "node:url";
import { getAddress, parseEther } from "ethers";
import { weeklyContractBatchId } from "../frontend/scripts/weekly-airdrop/materialize.mjs";
import { epochWindow } from "../frontend/scripts/weekly-airdrop/config.mjs";

const DAY = 86_400;
const CHAINS = [56, 97, 4663, 46630];
const PROGRAMS = ["airdrop_trader", "airdrop_creator"];

function wiringCalls({ vault, distributor, operator }) {
  return [
    { contract: "CommunityRewardsVault", to: vault, fn: "setRewardDistributor", args: [distributor] },
    { contract: "CommunityRewardsVault", to: vault, fn: "setAirdropOperator", args: [operator] },
    { contract: "RewardDistributor", to: distributor, fn: "setBatchOperator", args: [vault] },
  ];
}

/** Unix seconds of the end (Monday 00:00 UTC) of the first week to authorize. */
export function firstWeekEnd({ now = new Date(), from = null } = {}) {
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("--from must be an epochId (YYYY-MM-DD, a Monday)");
    const start = Date.parse(`${from}T00:00:00Z`) / 1000;
    if (!Number.isFinite(start) || new Date(start * 1000).getUTCDay() !== 1) throw new Error("--from must be a Monday");
    return start + 7 * DAY;
  }
  // The next run draws the week that ends at the coming Monday 00:00 UTC.
  const { end: lastEnded } = epochWindow(now);
  return lastEnded.getTime() / 1000 <= now.getTime() / 1000 ? lastEnded.getTime() / 1000 + 7 * DAY : lastEnded.getTime() / 1000;
}

/**
 * pots: [{ pot: "main" | "gen7", vault, distributor, cap (wei), operator, wire }]
 */
export function airdropSetupCalls({ chainId, pots, weeks = 12, now = new Date(), from = null }) {
  if (!CHAINS.includes(Number(chainId))) throw new Error("--chain must be 56, 97, 4663 or 46630");
  const count = Math.max(1, Math.min(26, Number(weeks) || 12));
  const seen = new Set();
  for (const p of pots) {
    for (const address of [p.vault, p.distributor]) {
      const key = getAddress(address).toLowerCase();
      if (seen.has(key)) throw new Error(`${address} is used twice; each pot needs its own vault and distributor`);
      seen.add(key);
    }
    if (BigInt(p.cap) <= 0n) throw new Error(`cap for the ${p.pot} pot must be positive`);
    if (p.wire && !p.operator) throw new Error(`--operator (the Coolify airdrop key) is required to wire the ${p.pot} pot`);
  }
  const calls = [];
  for (const p of pots) if (p.wire) calls.push(...wiringCalls(p));
  const firstEnd = firstWeekEnd({ now, from });
  for (const p of pots) {
    for (let week = 0; week < count; week += 1) {
      const end = firstEnd + week * 7 * DAY;
      const epochId = new Date((end - 7 * DAY) * 1000).toISOString().slice(0, 10);
      for (const program of PROGRAMS) {
        calls.push({
          contract: "RewardDistributor",
          to: p.distributor,
          fn: "authorizeBatch",
          args: [weeklyContractBatchId(chainId, epochId, program, p.pot), BigInt(p.cap).toString(), String(end), String(end + 6 * DAY)],
          note: p.pot === "main" ? `${epochId} ${program}` : `${epochId} ${program} (${p.pot} pot)`,
        });
      }
    }
  }
  return calls;
}

export function parseSetupArgs(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const chainId = Number(flag("chain"));
  if (!CHAINS.includes(chainId)) throw new Error("--chain must be 56, 97, 4663 or 46630");
  const vault = getAddress(flag("vault"));
  const distributor = getAddress(flag("distributor"));
  const operator = flag("operator") ? getAddress(flag("operator")) : null;
  const cap = parseEther(String(flag("cap") || ""));
  if (cap <= 0n) throw new Error("--cap (max native per weekly batch per program) is required");
  const wiring = argv.includes("--skip-wiring") ? "none" : String(flag("wiring") || "all");
  if (!["all", "none", "main", "gen7"].includes(wiring)) throw new Error("--wiring must be all, none, main or gen7");
  const pots = [{ pot: "main", vault, distributor, cap, operator, wire: wiring === "all" || wiring === "main" }];
  const gen7Vault = flag("gen7-vault");
  const gen7Distributor = flag("gen7-distributor");
  if (Boolean(gen7Vault) !== Boolean(gen7Distributor)) throw new Error("--gen7-vault and --gen7-distributor go together");
  if (gen7Vault) {
    pots.push({
      pot: "gen7",
      vault: getAddress(gen7Vault),
      distributor: getAddress(gen7Distributor),
      cap: flag("gen7-cap") ? parseEther(String(flag("gen7-cap"))) : cap,
      operator: flag("gen7-operator") ? getAddress(flag("gen7-operator")) : operator,
      wire: wiring === "all" || wiring === "gen7",
    });
  } else if (wiring === "gen7") {
    throw new Error("--wiring gen7 needs --gen7-vault and --gen7-distributor");
  }
  // --only gen7: just that pot's calls (e.g. the gen-7 deploy, so a main week drawn before the Safe
  // signs cannot make authorizeBatch revert with BatchAuthConsumed). Renewals leave it out: one batch, both pots.
  const only = flag("only");
  if (only && !pots.some((p) => p.pot === only)) throw new Error(`--only ${only}: no such pot configured`);
  return { chainId, pots: only ? pots.filter((p) => p.pot === only) : pots, weeks: Number(flag("weeks") || 12), from: flag("from") || null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const calls = airdropSetupCalls(parseSetupArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(calls, null, 2)}\n`);
}

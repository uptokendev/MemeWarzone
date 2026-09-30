#!/usr/bin/env node
/**
 * Every payout bound on BNB (56) and Robinhood (4663), read from chain and expressed in DOLLARS.
 * Read-only; sends nothing. Exits 1 if any bound is absurd.
 *
 * Why (2026-09-27): both MonthlyLeagueTreasury vaults were deployed with monthlyCapUsd = 30000 raw.
 * The contract's unit is 18-decimal USD, so the cap was 38 / 11 wei. The setup scripts, the deploy
 * rehearsal and the P1 read-back all checked that a cap was *set*, never what it was *worth*. This
 * checks what it is worth: each bound is priced through the chain's own oracle and must sit between
 * $1 and $1,000,000. A unit mistake lands 18 orders of magnitude outside that window.
 *
 * The monthly vaults are the 2026-09-27 replacements (the few-wei originals 0xF62A09de... / 0xE72A281b... are
 * retired). Generation 6 adds two more kinds of bound, read when the fees record exists (or the env names them):
 *   - CreatorRewardsVaultV2.limits(): buyback per tx, per coin per week, holder batch per week (native, priced),
 *     plus the minimum interval (60 s .. 30 days) and the impact cap (1 .. 50 bps);
 *   - the holder RewardDistributor's open authorizations (BatchAuthorized, not consumed, not revoked): each
 *     maxAmount priced, and never above the vault's maxHolderBatchPerWeek (the Safe's own rule, runbook 9.4).
 *
 *   node scripts/check-evm-payout-bounds.mjs            # both chains
 *   MONTHLY_LEAGUE_TREASURY_56=0x.. node scripts/...    # check another monthly vault instead
 *   EVM_CREATOR_VAULT_V2_56=0x.. EVM_HOLDER_DISTRIBUTOR_56=0x.. EVM_HOLDER_DISTRIBUTOR_FROM_BLOCK_56=<n>
 *                                                       # generation 6 contracts when no record is on disk
 *   BOUNDS_CHAINS=56 ...                                # one chain; BOUNDS_RPC_<id> overrides the RPC
 *   EVMGEN_FEES_RECORD_<id>=<path>                      # another fees record (the fork rehearsal's)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { ethers } = require("ethers");

const WAD = 10n ** 18n;
const MIN_USD = 1n;
const MAX_USD = 1_000_000n;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** The generation 6 fees record (router, vault, holder distributor, deploy blocks), when it is on disk. */
function feesRecord(chainId, dir) {
  const file = process.env[`EVMGEN_FEES_RECORD_${chainId}`] || path.join(ROOT, "deployments", dir, "mainnet.evmgen-fees.json");
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number(r.chainId) === Number(chainId) ? r : null;
  } catch {
    return null;
  }
}

const CHAINS = {
  56: {
    rpc: process.env.BOUNDS_RPC_56 || process.env.BSC_RPC_HTTP_56 || "https://bsc-dataseed.binance.org",
    native: "BNB",
    dir: "bnb",
    oracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    // Replacement of 0xF62A09de... (capped at a few wei, 2026-09-27).
    monthly: process.env.MONTHLY_LEAGUE_TREASURY_56 || "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    protocol: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
  },
  4663: {
    rpc: process.env.BOUNDS_RPC_4663 || process.env.ROBINHOOD_RPC_HTTP_4663 || "https://rpc.mainnet.chain.robinhood.com",
    native: "ETH",
    dir: "robinhood",
    oracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    // Replacement of 0xE72A281b... (capped at a few wei, 2026-09-27).
    monthly: process.env.MONTHLY_LEAGUE_TREASURY_4663 || "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
  },
};

const fmtUsd = (v) => `$${v.toLocaleString("en-US")}`;
let failures = 0;

function judge(label, usd, detail) {
  const ok = usd >= MIN_USD && usd <= MAX_USD;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${fmtUsd(usd).padStart(16)}   ${detail}`);
}

async function read(contract, fn) {
  try {
    return BigInt(await contract[fn]());
  } catch {
    return null;
  }
}

function judgeRange(label, value, min, max, unit) {
  const ok = value >= min && value <= max;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${`${value} ${unit}`.padStart(16)}   allowed ${min}..${max} ${unit}`);
}

const selected = String(process.env.BOUNDS_CHAINS || "").split(",").map((s) => s.trim()).filter(Boolean);
for (const [chainId, chain] of Object.entries(CHAINS)) {
  if (selected.length && !selected.includes(chainId)) continue;
  const network = ethers.Network.from(Number(chainId));
  const provider = new ethers.JsonRpcProvider(chain.rpc, network, { staticNetwork: network, batchMaxCount: 1 });
  const price = BigInt(await new ethers.Contract(chain.oracle, ["function nativeUsdPrice() view returns (uint256)"], provider).nativeUsdPrice());
  const nativeToUsd = (wei) => (wei * price) / WAD / WAD;
  console.log(`\nchain ${chainId}: ${chain.native} = $${ethers.formatEther(price)} (oracle ${chain.oracle})`);

  // Monthly league: a USD cap in 18 decimals, priced by the contract as cap * 1e18 / price.
  const monthly = new ethers.Contract(chain.monthly, ["function monthlyCapUsd() view returns (uint256)"], provider);
  const capUsd = await read(monthly, "monthlyCapUsd");
  if (capUsd === null) { failures += 1; console.log(`  FAIL monthly league ${chain.monthly}: monthlyCapUsd unreadable`); }
  else {
    const capNative = (capUsd * WAD + price - 1n) / price;
    judge(`monthly league cap`, nativeToUsd(capNative), `${ethers.formatEther(capNative)} ${chain.native} (${chain.monthly})`);
  }

  // Protocol vault operator fill: USD in 18 decimals, plus the price it books with.
  const protocol = new ethers.Contract(chain.protocol, ["function operatorFillCapUsd() view returns (uint256)", "function nativeUsdPrice() view returns (uint256)"], provider);
  const fillCap = await read(protocol, "operatorFillCapUsd");
  if (fillCap !== null) judge("protocol operator fill cap", fillCap / WAD, `raw ${fillCap}`);
  const bookedPrice = await read(protocol, "nativeUsdPrice");
  if (bookedPrice !== null) judge("protocol vault booked price", bookedPrice / WAD, `oracle says $${ethers.formatEther(price)}`);

  // Native-denominated caps.
  const native = [
    ["weekly league max claim / tx", chain.weekly, "maxClaimPerTx"],
    ["weekly league max epoch total", chain.weekly, "maxEpochTotal"],
    ["recruiter max payout / tx", chain.recruiter, "maxPayoutPerTx"],
    ["recruiter daily payout cap", chain.recruiter, "dailyPayoutCap"],
  ];
  for (const [label, address, fn] of native) {
    const wei = await read(new ethers.Contract(address, [`function ${fn}() view returns (uint256)`], provider), fn);
    if (wei === null) { console.log(`  n/a  ${label.padEnd(34)} (${address} has no ${fn})`); continue; }
    judge(label, nativeToUsd(wei), `${ethers.formatEther(wei)} ${chain.native}`);
  }

  // Generation 6: the creator vault's operator caps and the holder distributor's open authorizations.
  const rec = feesRecord(chainId, chain.dir);
  const vaultAddr = process.env[`EVM_CREATOR_VAULT_V2_${chainId}`]?.split("@")[0] || rec?.contracts?.vault;
  const distAddr = process.env[`EVM_HOLDER_DISTRIBUTOR_${chainId}`] || rec?.contracts?.holderDistributor;
  const distFrom = Number(process.env[`EVM_HOLDER_DISTRIBUTOR_FROM_BLOCK_${chainId}`] || rec?.deployBlocks?.holderDistributor || 0);
  if (!vaultAddr) {
    console.log(`  n/a  creator vault V2 (no deployments/${chain.dir}/mainnet.evmgen-fees.json and no EVM_CREATOR_VAULT_V2_${chainId}: generation 6 not deployed here yet)`);
    continue;
  }
  const vault = new ethers.Contract(vaultAddr, ["function limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)"], provider);
  let holderWeekMax = null;
  try {
    const [paused, perTx, perCoinWeek, interval, impactBps, holderWeek] = await vault.limits();
    holderWeekMax = holderWeek;
    console.log(`  vault V2 ${vaultAddr}: operator ${paused ? "PAUSED" : "active"}`);
    judge("vault buyback max / tx", nativeToUsd(perTx), `${ethers.formatEther(perTx)} ${chain.native}`);
    judge("vault buyback max / coin / week", nativeToUsd(perCoinWeek), `${ethers.formatEther(perCoinWeek)} ${chain.native}`);
    judge("vault holder batches / week", nativeToUsd(holderWeek), `${ethers.formatEther(holderWeek)} ${chain.native}`);
    judgeRange("vault min buyback interval", Number(interval), 60, 30 * 86_400, "s");
    judgeRange("vault max buyback impact", Number(impactBps), 1, 50, "bps");
    if (perTx > perCoinWeek) { failures += 1; console.log("  FAIL buyback max / tx is above the per-coin weekly cap"); }
  } catch (error) {
    failures += 1;
    console.log(`  FAIL creator vault V2 ${vaultAddr}: limits() unreadable (${error?.shortMessage || error?.message})`);
  }
  if (!distAddr) continue;
  if (!distFrom) {
    console.log(`  n/a  holder distributor ${distAddr}: no deploy block (EVM_HOLDER_DISTRIBUTOR_FROM_BLOCK_${chainId}), authorizations not scanned`);
    continue;
  }
  const dist = new ethers.Contract(distAddr, [
    "event BatchAuthorized(bytes32 indexed batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
    "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
  ], provider);
  const latest = await provider.getBlockNumber();
  const step = Number(process.env.BOUNDS_LOG_STEP || 5000);
  const ids = new Set();
  for (let from = distFrom; from <= latest; from += step) {
    const logs = await dist.queryFilter(dist.filters.BatchAuthorized(), from, Math.min(latest, from + step - 1));
    for (const l of logs) ids.add(l.args.batchId);
  }
  let open = 0;
  for (const id of ids) {
    const a = await dist.batchAuthorization(id);
    if (!a.authorized || a.consumed) continue;
    open += 1;
    judge(`holder auth ${id.slice(0, 10)}…`, nativeToUsd(a.maxAmount), `${ethers.formatEther(a.maxAmount)} ${chain.native}, publish ${new Date(Number(a.publishAfter) * 1000).toISOString().slice(0, 16)}..${new Date(Number(a.publishDeadline) * 1000).toISOString().slice(0, 16)}`);
    if (holderWeekMax !== null && a.maxAmount > holderWeekMax) { failures += 1; console.log(`  FAIL holder auth ${id} max ${ethers.formatEther(a.maxAmount)} is above the vault's weekly holder cap`); }
  }
  console.log(`  holder distributor ${distAddr}: ${ids.size} authorization(s) since block ${distFrom}, ${open} open`);
}

console.log(failures ? `\n${failures} bound(s) outside ${fmtUsd(MIN_USD)}..${fmtUsd(MAX_USD)} -- a unit mistake until proven otherwise` : "\nall payout bounds are within $1..$1,000,000");
process.exit(failures ? 1 : 0);

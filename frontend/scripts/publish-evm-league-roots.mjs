#!/usr/bin/env node
/**
 * BNB / Robinhood league payouts, unattended (2026-09-26). The settlement job writes each epoch's
 * winners (league_epoch_winners, poker places); this posts the Merkle root the claim card needs:
 *   weekly  -> TreasuryVaultV2.setEpochRoot(epochId, root, total)
 *   monthly -> MonthlyLeagueTreasury.sealMonth(monthId, root, total)
 * signed by the vaults' rootPoster key LEAGUE_ROOT_POSTER_PK. Until now this was only the admin
 * endpoint POST /api/leagueRoot, so no EVM league prize became claimable by itself.
 *
 * The leaves and roots are leagueRoot.js's own (same helpers, byte-identical). Every epoch is
 * static-called against the live contract before sending, so the Safe's authorization, its window,
 * its max, the vault caps and (monthly) the player pool are all checked up front; the weekly vault
 * must also hold the whole list. Anything that would fail is BLOCKED with the reason and retried on
 * the next run -- a list is never shrunk, split or partially posted. An epoch already on chain is
 * skipped (and a different root on chain is reported, never overwritten -- the contracts refuse too).
 *
 *   node scripts/publish-evm-league-roots.mjs --dry-run      # reads + static calls, sends nothing
 *   node scripts/publish-evm-league-roots.mjs                # hourly Coolify task on the API
 *
 * Env: DATABASE_URL, LEAGUE_ROOT_POSTER_PK, EVM_LEAGUE_ROOT_CHAINS (default 56,4663),
 * TREASURY_VAULT_V2_ADDRESS_<id>, MONTHLY_LEAGUE_TREASURY_ADDRESS_<id> (mainnet defaults below),
 * BSC_RPC_HTTP_<id> / ROBINHOOD_RPC_HTTP_<id> (public RPC defaults).
 */
import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { buildMerkleRoot, categoryHashFromString, computeEpochId, leafHash, monthIdFromDate } from "../api/leagueRoot.js";

const dryRun = process.argv.includes("--dry-run");
const LOOKBACK_DAYS = Number(process.env.EVM_LEAGUE_ROOT_LOOKBACK_DAYS || 120);

const MAINNET = {
  56: { weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5", monthly: "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8" },
  4663: { weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e", monthly: "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238" },
};

const WEEKLY_ABI = [
  "function epochRoot(uint256) view returns (bytes32)",
  "function setEpochRoot(uint256 epochId, bytes32 root, uint256 totalAmount)",
];
const MONTHLY_ABI = [
  "function monthSeal(uint256) view returns (bool isSealed, bytes32 winnersRoot, uint256 oraclePrice, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow, uint256 sealedAt)",
  "function sealMonth(uint256 monthId, bytes32 winnersRoot, uint256 winnerTotal)",
  // Custom errors, so a BLOCKED line names the reason (contracts/MonthlyLeagueTreasury.sol).
  ...["NotRootPosterOrMultisig", "RootZero", "MonthAlreadySealed", "WinnerTotalAboveCap", "WinnerTotalAbovePlayerPool",
    "MonthNotAuthorized", "MonthAuthConsumed", "MonthAuthRevoked", "SealTooEarly", "SealAuthExpired",
    "WinnerTotalAboveAuthorizedMax", "InvalidMonthId"].map((name) => `error ${name}()`),
];

function address(kind, chainId) {
  const envName = kind === "weekly" ? "TREASURY_VAULT_V2_ADDRESS" : "MONTHLY_LEAGUE_TREASURY_ADDRESS";
  return String(process.env[`${envName}_${chainId}`] || MAINNET[chainId]?.[kind] || "").trim();
}

function rpcUrl(chainId) {
  const configured = String(process.env[`ROBINHOOD_RPC_HTTP_${chainId}`] || process.env[`BSC_RPC_HTTP_${chainId}`] || "").trim();
  if (configured) return configured.split(",")[0].trim();
  if (chainId === 56) return "https://bsc-dataseed.binance.org";
  if (chainId === 4663) return "https://rpc.mainnet.chain.robinhood.com";
  return "";
}

function reason(error) {
  if (error?.revert?.name === "Error" && error.revert.args?.[0]) return String(error.revert.args[0]); // require("...")
  if (error?.revert?.name) return error.revert.name;
  return String(error?.reason || error?.shortMessage || error?.info?.error?.message || error?.message || error).split("\n")[0];
}

async function epochList(chainId) {
  const { rows } = await pool.query(
    `select distinct period, epoch_start
       from public.league_epoch_winners
      where chain_id = $1 and period in ('weekly','monthly')
        and epoch_start > now() - make_interval(days => $2::int)
      order by epoch_start asc`,
    [chainId, LOOKBACK_DAYS],
  );
  return rows;
}

async function buildRoot(chainId, period, epochStart) {
  const epochDate = new Date(epochStart);
  const claimId = period === "monthly" ? monthIdFromDate(epochDate) : computeEpochId(chainId, period, Math.floor(epochDate.getTime() / 1000));
  const { rows } = await pool.query(
    `select category, rank, recipient_address as "recipientAddress", amount_raw::text as "amountRaw"
       from public.league_epoch_winners
      where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz
      order by category asc, rank asc, recipient_address asc`,
    [chainId, period, epochDate.toISOString()],
  );
  const leaves = [];
  let total = 0n;
  for (const row of rows) {
    const recipient = String(row.recipientAddress || "").toLowerCase();
    const rank = Number(row.rank);
    const amount = BigInt(row.amountRaw);
    // One bad leaf blocks the whole epoch: posting without it would pay that winner nothing.
    if (!ethers.isAddress(recipient)) throw new Error(`winner ${row.category} #${rank} has a non-EVM recipient ${recipient}`);
    if (!Number.isInteger(rank) || rank < 1 || rank > 255) throw new Error(`winner ${row.category} rank ${rank} outside 1..255`);
    if (amount <= 0n) throw new Error(`winner ${row.category} #${rank} amount ${amount}`);
    total += amount;
    leaves.push(leafHash({ claimId, categoryHash: categoryHashFromString(String(row.category).toLowerCase().trim()), rank, recipient, amountRaw: amount }));
  }
  return { claimId, root: buildMerkleRoot(leaves), total, count: rows.length };
}

async function main() {
  if (!pool) throw new Error("DATABASE_URL is required");
  const pk = String(process.env.LEAGUE_ROOT_POSTER_PK || "").trim();
  if (!pk && !dryRun) throw new Error("LEAGUE_ROOT_POSTER_PK (the vaults' rootPoster key) is required");
  const chains = String(process.env.EVM_LEAGUE_ROOT_CHAINS || "56,4663").split(",").map((v) => Number(v.trim())).filter(Number.isFinite);
  const report = [];

  for (const chainId of chains) {
    const url = rpcUrl(chainId);
    if (!url) { report.push({ chainId, status: "skipped_no_rpc" }); continue; }
    const network = ethers.Network.from(chainId);
    const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
    const signer = pk ? new ethers.Wallet(pk, provider) : ethers.Wallet.createRandom().connect(provider);

    for (const { period, epoch_start: epochStart } of await epochList(chainId)) {
      const at = new Date(epochStart).toISOString();
      const vaultAddress = address(period, chainId);
      const base = { chainId, period, epochStart: at, vault: vaultAddress };
      try {
        if (!ethers.isAddress(vaultAddress)) throw new Error(`no ${period} league vault configured for chain ${chainId}`);
        const built = await buildRoot(chainId, period, epochStart);
        const item = { ...base, claimId: built.claimId.toString(), root: built.root, total: built.total.toString(), winners: built.count };

        if (period === "weekly") {
          const vault = new ethers.Contract(vaultAddress, WEEKLY_ABI, signer);
          const onChain = await vault.epochRoot(built.claimId);
          if (onChain !== ethers.ZeroHash) {
            report.push({ ...item, status: onChain.toLowerCase() === built.root.toLowerCase() ? "already_published" : "ON_CHAIN_ROOT_DIFFERS", onChainRoot: onChain });
            continue;
          }
          const balance = await provider.getBalance(vaultAddress);
          if (balance < built.total) throw new Error(`vault holds ${balance}, the list pays ${built.total}; nothing shrunk -- fund or wait`);
          await vault.setEpochRoot.staticCall(built.claimId, built.root, built.total);
          if (dryRun) { report.push({ ...item, status: "would_publish" }); continue; }
          const tx = await vault.setEpochRoot(built.claimId, built.root, built.total);
          await tx.wait(1);
          const after = await vault.epochRoot(built.claimId);
          report.push({ ...item, status: after.toLowerCase() === built.root.toLowerCase() ? "published" : "PUBLISHED_ROOT_MISMATCH", txHash: tx.hash });
        } else {
          const treasury = new ethers.Contract(vaultAddress, MONTHLY_ABI, signer);
          const seal = await treasury.monthSeal(built.claimId);
          if (seal.isSealed) {
            report.push({ ...item, status: seal.winnersRoot.toLowerCase() === built.root.toLowerCase() ? "already_sealed" : "ON_CHAIN_ROOT_DIFFERS", onChainRoot: seal.winnersRoot });
            continue;
          }
          await treasury.sealMonth.staticCall(built.claimId, built.root, built.total);
          if (dryRun) { report.push({ ...item, status: "would_seal" }); continue; }
          const tx = await treasury.sealMonth(built.claimId, built.root, built.total);
          await tx.wait(1);
          const after = await treasury.monthSeal(built.claimId);
          report.push({ ...item, status: after.isSealed && after.winnersRoot.toLowerCase() === built.root.toLowerCase() ? "sealed" : "SEALED_ROOT_MISMATCH", txHash: tx.hash });
        }
      } catch (error) {
        report.push({ ...base, status: "BLOCKED", reason: reason(error) });
      }
    }
  }

  console.log(JSON.stringify({ dryRun, report }, null, 2));
  for (const row of report) if (row.status === "BLOCKED" || /DIFFERS|MISMATCH/.test(row.status)) console.error(`[evm-league-roots] ${row.status} chain=${row.chainId} ${row.period} ${row.epochStart}: ${row.reason || row.onChainRoot || ""}`);
  await pool.end().catch(() => undefined);
}

main().catch((error) => {
  console.error("[evm-league-roots]", error);
  process.exit(1);
});

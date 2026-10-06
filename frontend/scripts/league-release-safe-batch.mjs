#!/usr/bin/env node
/**
 * BNB / Robinhood league prizes released after their root was published (B7, founder 2026-10-06).
 *
 * A winner on moderation hold when its epoch root was posted got no leaf (moderation_root_exclusions);
 * its amount stayed in the vault. Roots are immutable and one per epoch, so the only path that touches
 * no contract and no other winner is the Safe: every league vault lets its multisig move native out
 * (TreasuryVaultV2.withdraw for weekly and Major War League vaults, MonthlyLeagueTreasury.withdrawNative
 * for monthly, which only reaches unallocated money -- never a sealed month's reserve). Read back on
 * 2026-10-06: all eight mainnet vaults have it and their multisig is the Safe 0x1edcEdf5...A7A7.
 *
 *   node scripts/league-release-safe-batch.mjs --chain 56 --out out/league-release-56.calls.json
 *       reads the released prizes (release_status awaiting_multisig), eth_calls each withdraw FROM the
 *       Safe (read-only, nothing is sent), and writes a calls file for the existing batch builder:
 *       npx ts-node scripts/make-safe-batch.ts <batch.json> 56 "League release" "<why>" <calls.json>
 *   node scripts/league-release-safe-batch.mjs --chain 56 --record <txHash>
 *       after the Safe executed it: reads the receipt, matches each Withdraw / NativeWithdrawn event to a
 *       released prize (vault, winner, exact amount) and records it paid (league_epoch_payouts +
 *       league_epoch_claims with the tx, exclusion -> paid). A prize without a matching event stays
 *       awaiting; nothing is guessed.
 */
import "../api/load-local-env.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { isMwlPayoutPeriod, mwlVaultAddress } from "../api/lib/mwlPayoutVaults.js";
import { monthlyLeagueTreasuryForMonth } from "../api/lib/evmMonthlyLeagueTreasury.js";
import { monthIdFromDate } from "../api/leagueRoot.js";

const WEEKLY_MAINNET = { 56: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5", 4663: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e" };
const VAULT_ABI = [
  "function multisig() view returns (address)",
  "function withdraw(address to, uint256 amount)",
  "function withdrawNative(address to, uint256 amount)",
  "function unallocatedBalance() view returns (uint256)",
  "event Withdraw(address indexed to, uint256 amount)",
  "event NativeWithdrawn(address indexed to, uint256 amount)",
];
const iface = new ethers.Interface(VAULT_ABI);

/** The contract + function that pays one released prize from its own vault. */
export function releaseCall(row, vault) {
  const monthly = row.period === "monthly";
  return {
    contract: monthly ? "MonthlyLeagueTreasury" : "TreasuryVaultV2",
    to: ethers.getAddress(vault),
    fn: monthly ? "withdrawNative" : "withdraw",
    args: [ethers.getAddress(String(row.recipient_address).toLowerCase()), String(row.amount_raw)],
    note: `${row.period} ${new Date(row.epoch_start).toISOString().slice(0, 10)} ${row.category} #${row.rank}`,
  };
}

/**
 * Receipt logs -> the released prizes they pay. A prize matches one log of its own vault with the same
 * recipient and exact amount; each log pays at most one prize.
 */
export function matchWithdrawLogs(logs, pending, vaultOf) {
  const used = new Set();
  const matches = [];
  for (const row of pending) {
    const vault = String(vaultOf(row) || "").toLowerCase();
    const index = logs.findIndex((log, i) => {
      if (used.has(i) || String(log.address).toLowerCase() !== vault) return false;
      let parsed;
      try { parsed = iface.parseLog(log); } catch { return false; }
      if (!parsed || !["Withdraw", "NativeWithdrawn"].includes(parsed.name)) return false;
      return String(parsed.args.to).toLowerCase() === String(row.recipient_address).toLowerCase() && BigInt(parsed.args.amount) === BigInt(String(row.amount_raw));
    });
    if (index >= 0) {
      used.add(index);
      matches.push(row);
    }
  }
  return matches;
}

function rpcUrl(chainId) {
  const configured = String(process.env[`ROBINHOOD_RPC_HTTP_${chainId}`] || process.env[`BSC_RPC_HTTP_${chainId}`] || "").trim();
  if (configured) return configured.split(",")[0].trim();
  return chainId === 56 ? "https://bsc-dataseed.binance.org" : "https://rpc.mainnet.chain.robinhood.com";
}

async function vaultFor(provider, chainId, row) {
  if (isMwlPayoutPeriod(row.period)) return mwlVaultAddress(row.period, chainId);
  if (row.period === "monthly") return monthlyLeagueTreasuryForMonth(provider, chainId, monthIdFromDate(new Date(row.epoch_start)));
  return String(process.env[`TREASURY_VAULT_V2_ADDRESS_${chainId}`] || WEEKLY_MAINNET[chainId] || "").trim();
}

async function pendingReleases(pool, chainId) {
  const { rows } = await pool.query(
    `select x.chain_id, x.period, x.epoch_start, x.category, x.rank, x.recipient_address, x.amount_raw::text as amount_raw
       from public.moderation_root_exclusions x
       join public.moderation_holds h
         on h.subject_kind = 'league_winner' and h.state = 'released'
        and h.chain_id = x.chain_id and h.subject->>'period' = x.period
        and (h.subject->>'epochStart')::timestamptz = x.epoch_start and h.subject->>'category' = x.category
        and (h.subject->>'rank')::int = x.rank
      where x.chain_id = $1 and x.release_path = 'evm_safe_withdraw' and x.release_status = 'awaiting_multisig'
      order by x.epoch_start, x.period, x.category, x.rank`,
    [chainId],
  );
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const chainId = Number(arg("--chain"));
  if (![56, 4663].includes(chainId)) throw new Error("--chain 56 or 4663");
  const { pool } = await import("../server/db.js");
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl(chainId), network, { staticNetwork: network, batchMaxCount: 1 });
  const pending = await pendingReleases(pool, chainId);
  const vaults = new Map();
  for (const row of pending) vaults.set(row, await vaultFor(provider, chainId, row));

  const record = arg("--record");
  if (record) {
    const receipt = await provider.getTransactionReceipt(record);
    if (!receipt || receipt.status !== 1) throw new Error(`transaction ${record} is not a successful mined transaction on chain ${chainId}`);
    const paid = matchWithdrawLogs(receipt.logs, pending, (row) => vaults.get(row));
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const row of paid) {
        const key = [row.chain_id, row.period, row.epoch_start, row.category, row.rank];
        await client.query(
          `insert into public.league_epoch_payouts (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
           values ($1, $2, $3, $4, $5, $6, $7::numeric, $8) on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
          [...key, row.recipient_address, row.amount_raw, record],
        );
        await client.query(
          `insert into public.league_epoch_claims (chain_id, period, epoch_start, category, rank, recipient_address, signature)
           values ($1, $2, $3, $4, $5, $6, 'safe-multisig-release') on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
          [...key, row.recipient_address],
        );
        await client.query(
          `update public.moderation_root_exclusions set release_status = 'paid', paid_tx = $6, updated_at = now()
            where chain_id = $1 and period = $2 and epoch_start = $3 and category = $4 and rank = $5 and release_status = 'awaiting_multisig'`,
          [...key, record],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    console.log(JSON.stringify({ chainId, tx: record, recordedPaid: paid.length, stillAwaiting: pending.length - paid.length }, null, 2));
    await pool.end().catch(() => undefined);
    return;
  }

  const calls = [];
  const refused = [];
  for (const row of pending) {
    const vault = vaults.get(row);
    const call = releaseCall(row, vault);
    const contract = new ethers.Contract(call.to, VAULT_ABI, provider);
    try {
      const safe = await contract.multisig();
      await provider.call({ to: call.to, from: safe, data: iface.encodeFunctionData(call.fn, call.args) });
      calls.push(call);
    } catch (error) {
      refused.push({ ...call, reason: String(error?.shortMessage || error?.message || error).split("\n")[0] });
    }
  }
  const out = arg("--out") || `out/league-release-${chainId}.calls.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(calls.map(({ note: _note, ...call }) => call), null, 2)}\n`);
  console.log(JSON.stringify({ chainId, out, calls, refused, next: `npx ts-node scripts/make-safe-batch.ts <batch.json> ${chainId} "League release after moderation" "<reason>" ${out}` }, null, 2));
  await pool.end().catch(() => undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[league-release-safe-batch]", error);
    process.exit(1);
  });
}

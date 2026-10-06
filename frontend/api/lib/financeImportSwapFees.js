// Import swap fee (0.5%) records: reads every fee transfer of an imported-coin
// swap from the chain and stores it in public.finance_import_swap_fees, so the
// revenue lane "Import swaps 0.5%" (financeRevenueLanes.js) can count it.
//
// Where the fee goes (frontend/api/importSwap.js, src/lib/robinhoodImportSwap.mjs):
//   Solana 101   Jupiter platform fee in wrapped SOL to the WSOL token account
//                (ATA) of SOLANA_IMPORT_SWAP_FEE_OWNER (operator 2AMfRaxS...).
//                Read: getSignaturesForAddress(ATA) + getTransaction; a row is a
//                transaction that raised the ATA's balance and ran Jupiter.
//   BNB 56       KyberSwap extra fee in BNB, sent by the Kyber router to the
//                ProtocolRevenueVault. The vault emits Deposit(from, amount,
//                balance) on receive(); a row is a Deposit with from = router.
//   Robinhood    Universal Router PAY_PORTION in ETH to the ProtocolRevenueVault:
//   4663         a Deposit with from = Universal Router.
// Other vault deposits (trade fees from the treasury router, UP votes,
// sponsorships) come from other senders and are not read here.
//
// Runs as a step of cron:finance-snapshots (financeSnapshotJobs.js) every 5
// minutes, from where the last run stopped (finance_import_swap_fee_cursors).
// scripts/finance-import-swap-fees.mjs runs the same scan by hand (backfill,
// --dry-run). Read-only towards the chain; the only writes are these rows.

import { getRpcUrls } from "./getServerReadProvider.js";
import { isOwnerWallet } from "../../shared/ownerWallets.mjs";
import { solanaFeeAccount, JUPITER_PROGRAM, KYBER_ROUTER } from "../importSwap.js";

const WSOL = "So11111111111111111111111111111111111111112";
// keccak256("Deposit(address,uint256,uint256)"), NativeTreasuryVaultBase / ProtocolRevenueVault.
export const VAULT_DEPOSIT_TOPIC = "0x90890809c654f11d6e72a28fa60149770a0d11ec6c92319d6ceb2bb0a4ea1a15";
// keccak256("Transfer(address,address,uint256)")
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Same values as src/lib/robinhoodImportSwap.mjs (UNIVERSAL_ROUTER_4663,
// IMPORT_SWAP_FEE_RECEIVER_4663, WETH_4663); the test checks they match.
export const UNIVERSAL_ROUTER_4663 = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const IMPORT_SWAP_FEE_RECEIVER_4663 = "0x632061ca786f7b585bbd46a792fda92b02f70671";
const WRAPPED = { 56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", 4663: "0x0bd7d308f8e1639fab988df18a8011f41eacad73" };

/**
 * Scan settings per chain. startBlock: the block at 00:00 UTC of the day before
 * import swaps went live there (Robinhood 2026-10-03, commit 6f60665b), read
 * from the chain by block timestamp. BNB starts at 2026-10-01 00:00 UTC (block
 * 125000755): nothing was earned there in September (founder 2026-10-06), and a
 * later start keeps the scan within the log history the BSC RPC serves.
 */
export function importSwapFeeSources(env = process.env) {
  return {
    101: { chainId: 101, kind: "solana", asset: "SOL", decimals: 9, feeOwner: String(env.SOLANA_IMPORT_SWAP_FEE_OWNER || "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB").trim() },
    56: { chainId: 56, kind: "evm", asset: "BNB", decimals: 18, receiver: String(env.IMPORT_SWAP_FEE_RECEIVER_56 || "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c").trim().toLowerCase(), payer: KYBER_ROUTER.toLowerCase(), startBlock: 125000755, maxRange: 5000, maxBlocksPerRun: 300000, confirmations: 15 },
    4663: { chainId: 4663, kind: "evm", asset: "ETH", decimals: 18, receiver: IMPORT_SWAP_FEE_RECEIVER_4663, payer: UNIVERSAL_ROUTER_4663, startBlock: 77787156, maxRange: 500000, maxBlocksPerRun: 5000000, confirmations: 20 },
  };
}

export function solanaImportSwapRpcUrls(env = process.env) {
  const urls = [];
  for (const name of ["SOLANA_MAINNET_RPC_HTTP", "SOLANA_MAINNET_RPC_URL", "SOLANA_RPC_URL", "SOLANA_RPC_HTTP", "VITE_SOLANA_RPC_URL"]) {
    for (const part of String(env[name] || "").split(",")) {
      const url = part.trim();
      if (url && !/devnet|testnet/i.test(url) && !urls.includes(url)) urls.push(url);
    }
  }
  urls.push("https://api.mainnet-beta.solana.com");
  return [...new Set(urls)];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON-RPC with URL fallback: the first URL that answers wins; each round of URLs is retried with backoff (rate limits). */
export function rpcClient(urls, { fetchImpl = fetch, timeoutMs = 20_000, retries = 3, backoffMs = 1000 } = {}) {
  return async function call(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      const result = await once(method, params);
      if (result.ok) return result.value;
      lastError = result.error;
    }
    throw lastError || new Error(`${method}: no RPC configured`);
  };
  async function once(method, params) {
    let lastError = null;
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
        const body = await response.json();
        if (body?.error) throw new Error(`${method}: ${String(body.error.message || JSON.stringify(body.error)).slice(0, 200)}`);
        return { ok: true, value: body.result };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError };
  }
}

const hexToBig = (hex) => BigInt(hex && hex !== "0x" ? hex : "0x0");
const topicAddress = (topic) => `0x${String(topic).slice(-40)}`.toLowerCase();
const padTopic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

// ------------------------------------------------------------------ Solana

/**
 * One fee row from a parsed Solana transaction, or null when the fee account's
 * balance did not rise or Jupiter did not run (a deposit, a close, an unwrap).
 */
export function solanaFeeRow(tx, { signature, feeAccount, feeOwner }) {
  if (!tx || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k?.pubkey));
  const index = keys.indexOf(feeAccount);
  if (index < 0) return null;
  const amountOf = (list) => String((list || []).find((b) => b.accountIndex === index)?.uiTokenAmount?.amount ?? "0");
  const delta = BigInt(amountOf(tx.meta.postTokenBalances)) - BigInt(amountOf(tx.meta.preTokenBalances));
  if (delta <= 0n) return null;
  const inner = (tx.meta.innerInstructions || []).flatMap((i) => i.instructions || []);
  const programs = [...(tx.transaction.message.instructions || []), ...inner].map((ix) => ix.programId);
  if (!keys.includes(JUPITER_PROGRAM) && !programs.includes(JUPITER_PROGRAM)) return null;
  const wallet = keys[0] || null;
  // The imported coin: the non-WSOL mint whose balance moved for the signer.
  let token = null;
  let side = null;
  const byMint = new Map();
  for (const [list, sign] of [[tx.meta.preTokenBalances, -1n], [tx.meta.postTokenBalances, 1n]]) {
    for (const b of list || []) {
      if (b.owner !== wallet || b.mint === WSOL) continue;
      byMint.set(b.mint, (byMint.get(b.mint) || 0n) + sign * BigInt(b.uiTokenAmount?.amount ?? "0"));
    }
  }
  for (const [mint, change] of byMint) {
    if (change === 0n) continue;
    token = mint;
    side = change > 0n ? "buy" : "sell";
    break;
  }
  return {
    chainId: 101, txHash: signature, logIndex: 0, blockNumber: tx.slot ?? null,
    occurredAt: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    wallet, tokenAddress: token, side, feeRaw: delta.toString(), feeAsset: "SOL",
    feeReceiver: feeAccount, router: JUPITER_PROGRAM, source: "solana_fee_account",
    internalWallet: Boolean(wallet && isOwnerWallet(wallet)), feeOwner,
  };
}

/** New fee rows on Solana since `cursor` (newest signature already stored), oldest first. */
export async function scanSolanaImportSwapFees({ source, rpc, cursor = null, maxSignatures = 5000 }) {
  const feeAccount = solanaFeeAccount(source.feeOwner);
  const signatures = [];
  let before;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [feeAccount, { limit: 1000, ...(before ? { before } : {}), ...(cursor ? { until: cursor } : {}) }]);
    signatures.push(...(page || []));
    if (!page || page.length < 1000 || signatures.length >= maxSignatures) break;
    before = page.at(-1).signature;
  }
  // Oldest first, so a run cut short still leaves a cursor with nothing missed before it.
  const ordered = signatures.slice(0, maxSignatures).reverse();
  const rows = [];
  let newest = cursor;
  for (const s of ordered) {
    if (!s.err) {
      const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) break; // not yet visible: stop here and retry next run
      const row = solanaFeeRow(tx, { signature: s.signature, feeAccount, feeOwner: source.feeOwner });
      if (row) rows.push(row);
    }
    newest = s.signature;
  }
  return { rows, cursor: newest, scanned: ordered.length, feeAccount, complete: signatures.length < maxSignatures };
}

// ------------------------------------------------------------------ EVM

/** Token and side of an EVM import swap from its receipt: the ERC20 (not wrapped native) that moved to or from the signer. */
export function evmSwapTokenSide(receipt, wallet, wrapped) {
  const me = String(wallet || "").toLowerCase();
  for (const log of receipt?.logs || []) {
    if (log.topics?.[0] !== ERC20_TRANSFER_TOPIC || log.topics.length < 3) continue;
    const token = String(log.address).toLowerCase();
    if (token === wrapped) continue;
    if (topicAddress(log.topics[2]) === me) return { token, side: "buy" };
    if (topicAddress(log.topics[1]) === me) return { token, side: "sell" };
  }
  return { token: null, side: null };
}

/** New fee rows on BNB / Robinhood from block `fromBlock`, oldest first, and the next block to scan. */
export async function scanEvmImportSwapFees({ source, rpc, fromBlock, maxBlocks = source.maxBlocksPerRun }) {
  const head = Number(hexToBig(await rpc("eth_blockNumber", []))) - source.confirmations;
  const start = Math.max(Number(fromBlock ?? source.startBlock), source.startBlock);
  const end = Math.min(head, start + maxBlocks - 1);
  const rows = [];
  if (end < start) return { rows, nextBlock: start, scanned: 0, head, complete: true };
  const blockTimes = new Map();
  for (let from = start; from <= end; from += source.maxRange) {
    const to = Math.min(end, from + source.maxRange - 1);
    const logs = await rpc("eth_getLogs", [{ address: source.receiver, topics: [VAULT_DEPOSIT_TOPIC, padTopic(source.payer)], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    for (const log of logs || []) {
      if (log.removed) continue;
      const amount = hexToBig(String(log.data).slice(0, 66));
      if (amount <= 0n) continue;
      const blockNumber = Number(hexToBig(log.blockNumber));
      const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [log.transactionHash]), rpc("eth_getTransactionReceipt", [log.transactionHash])]);
      if (!blockTimes.has(blockNumber)) blockTimes.set(blockNumber, Number(hexToBig((await rpc("eth_getBlockByNumber", [log.blockNumber, false])).timestamp)));
      const wallet = String(tx?.from || "").toLowerCase() || null;
      const { token, side } = evmSwapTokenSide(receipt, wallet, WRAPPED[source.chainId]);
      rows.push({
        chainId: source.chainId, txHash: String(log.transactionHash).toLowerCase(), logIndex: Number(hexToBig(log.logIndex)), blockNumber,
        occurredAt: new Date(blockTimes.get(blockNumber) * 1000).toISOString(),
        wallet, tokenAddress: token, side, feeRaw: amount.toString(), feeAsset: source.asset,
        feeReceiver: source.receiver, router: source.payer, source: "evm_vault_deposit",
        internalWallet: Boolean(wallet && isOwnerWallet(wallet)),
      });
    }
  }
  return { rows, nextBlock: end + 1, scanned: end - start + 1, head, complete: end >= head };
}

// ------------------------------------------------------------------ store

export async function readImportSwapCursor(db, chainId) {
  const { rows } = await db.query("select cursor from public.finance_import_swap_fee_cursors where chain_id = $1", [chainId]);
  return rows[0]?.cursor ?? null;
}

const INSERT_SQL = `
  insert into public.finance_import_swap_fees
    (chain_id, tx_hash, log_index, block_number, occurred_at, wallet, token_address, side, fee_raw, fee_asset, fee_receiver, router, source, internal_wallet)
  select * from unnest($1::int[], $2::text[], $3::int[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::text[], $11::text[], $12::text[], $13::text[], $14::boolean[])
  on conflict (chain_id, tx_hash, log_index) do nothing`;

/** Stores rows (a fee already stored is skipped) and moves the cursor, in one transaction. */
export async function storeImportSwapFees(db, chainId, rows, cursor) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("begin");
    let inserted = 0;
    if (rows.length) {
      const col = (k) => rows.map((r) => r[k] ?? null);
      const result = await client.query(INSERT_SQL, [col("chainId"), col("txHash"), col("logIndex"), col("blockNumber"), col("occurredAt"), col("wallet"), col("tokenAddress"), col("side"), col("feeRaw"), col("feeAsset"), col("feeReceiver"), col("router"), col("source"), col("internalWallet")]);
      inserted = result.rowCount ?? 0;
    }
    if (cursor != null) {
      await client.query(`insert into public.finance_import_swap_fee_cursors (chain_id, cursor, updated_at) values ($1, $2, now())
        on conflict (chain_id) do update set cursor = excluded.cursor, updated_at = now()`, [chainId, String(cursor)]);
    }
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (client !== db) client.release?.();
  }
}

/**
 * Scans one chain from its cursor and stores what it finds. dryRun: reads the
 * chain (and the cursor) but writes nothing. fromBlock / fromScratch override
 * the cursor for a backfill.
 */
export async function ingestImportSwapFees({ db, chainId, env = process.env, fetchImpl = fetch, dryRun = false, fromScratch = false, fromBlock = null, rpc = null, log = null }) {
  const source = importSwapFeeSources(env)[chainId];
  if (!source) throw new Error(`No import swap fee source for chain ${chainId}.`);
  let cursor = null;
  if (!fromScratch && db) {
    try {
      cursor = await readImportSwapCursor(db, chainId);
    } catch (error) {
      if (error?.code !== "42P01") throw error;
      if (!dryRun) throw new Error("finance_import_swap_fees is missing: apply db/migrations/20261006_000002_finance_import_swap_fees.sql first.");
    }
  }
  const call = rpc || rpcClient(source.kind === "solana" ? solanaImportSwapRpcUrls(env) : getRpcUrls(chainId), { fetchImpl });
  const scan = source.kind === "solana"
    ? await scanSolanaImportSwapFees({ source, rpc: call, cursor })
    : await scanEvmImportSwapFees({ source, rpc: call, fromBlock: fromBlock ?? (cursor == null ? null : Number(cursor)) });
  const nextCursor = source.kind === "solana" ? scan.cursor : String(scan.nextBlock);
  const inserted = dryRun ? 0 : await storeImportSwapFees(db, chainId, scan.rows, nextCursor);
  const feeRaw = scan.rows.reduce((sum, r) => sum + BigInt(r.feeRaw), 0n).toString();
  const summary = { chainId, dryRun, cursorBefore: cursor, cursorAfter: nextCursor, scanned: scan.scanned, found: scan.rows.length, inserted, feeRaw, asset: source.asset, complete: scan.complete };
  log?.(summary, scan.rows);
  return { ...summary, rows: scan.rows };
}

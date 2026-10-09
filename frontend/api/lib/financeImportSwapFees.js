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
import { evmFingerprint, partnersForFingerprints, solanaFingerprintFromLanded } from "./importSwapFingerprint.js";

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
    // Testnets (CO-IMP rev 2 CI5): no old 0.5% receiver, only the ImportFeeVault split source (below);
    // scan settings as their mainnets, RPC from getRpcUrls (BSC_RPC_HTTP_97 / ROBINHOOD_RPC_HTTP_46630, ...).
    // Their rows never reach finance: the revenue lanes run per mainnet chain id only.
    97: { chainId: 97, kind: "evm", asset: "BNB", decimals: 18, receiver: null, payer: null, testnet: true, maxRange: 5000, maxBlocksPerRun: 300000, confirmations: 15 },
    46630: { chainId: 46630, kind: "evm", asset: "ETH", decimals: 18, receiver: null, payer: null, testnet: true, maxRange: 500000, maxBlocksPerRun: 5000000, confirmations: 20 },
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

/** Host of an RPC URL for error messages: never the path or query (they carry the provider key). */
export function rpcHost(url) {
  try {
    return new URL(url).host || "rpc";
  } catch {
    return "rpc";
  }
}

// eth_getLogs refusals that a smaller block range can fix: range caps, result
// caps, and the "limit exceeded" (-32005) public BSC nodes answer to any getLogs.
const RANGE_LIMIT_ERROR = /block range|range (is )?too (large|wide|big)|range limit|limit exceeded|exceeds? (the )?(max|limit)|exceeded (the )?(max|limit)|too many (results|blocks|logs)|more than \d+ (results|logs)|query returned more than|response size|max(imum)? (block )?range|-32005/i;

/** True when an eth_getLogs error says the block range (or its result) was too big. */
export function isRangeLimitError(error) {
  return Boolean(error?.rangeLimited) || RANGE_LIMIT_ERROR.test(String(error?.message || error || ""));
}

/**
 * JSON-RPC with URL fallback: the first URL that answers wins; each round of
 * URLs is retried with backoff (rate limits). An error names the host of every
 * URL that refused (host only, never the key in the path). An eth_getLogs that
 * a URL refused for its range is not retried at the same range: the caller
 * shrinks the range instead.
 */
export function rpcClient(urls, { fetchImpl = fetch, timeoutMs = 20_000, retries = 3, backoffMs = 1000 } = {}) {
  return async function call(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      const result = await once(method, params);
      if (result.ok) return result.value;
      lastError = result.error;
      if (lastError?.rangeLimited) break;
    }
    throw lastError || new Error(`${method}: no RPC configured`);
  };
  async function once(method, params) {
    const refusals = [];
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
        let body = null;
        try {
          body = await response.json();
        } catch (error) {
          if (response?.ok === false) throw new Error(`HTTP ${response.status}`);
          throw error;
        }
        if (body?.error) throw new Error(String(body.error.message || JSON.stringify(body.error)).slice(0, 200));
        if (response?.ok === false) throw new Error(`HTTP ${response.status}`);
        return { ok: true, value: body.result };
      } catch (error) {
        refusals.push({ host: rpcHost(url), message: String(error?.name === "AbortError" ? "timeout" : error?.message || error).slice(0, 200) });
      } finally {
        clearTimeout(timer);
      }
    }
    if (!refusals.length) return { ok: false, error: null };
    const error = new Error(`${method}: ${refusals.map((r) => `${r.host} refused: ${r.message}`).join(" | ")}`);
    error.hosts = refusals.map((r) => r.host);
    error.rangeLimited = method === "eth_getLogs" && refusals.some((r) => RANGE_LIMIT_ERROR.test(r.message));
    return { ok: false, error };
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
    // Swap-widget partner attribution (importSwapFingerprint.js); not stored, matched before the split.
    fingerprint: solanaFingerprintFromLanded(tx, wallet),
    feeReceiver: feeAccount, router: JUPITER_PROGRAM, source: "solana_fee_account",
    internalWallet: Boolean(wallet && isOwnerWallet(wallet)), feeOwner,
  };
}

/** New fee rows on Solana since `cursor` (newest signature already stored), oldest first. */
export async function scanSolanaImportSwapFees({ source, rpc, cursor = null, maxSignatures = 5000 }) {
  const feeAccount = source.feeAccount || solanaFeeAccount(source.feeOwner);
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

/**
 * New fee rows on BNB / Robinhood from block `fromBlock`, oldest first, and the next block to scan.
 * A getLogs range the RPC refuses is halved (down to source.minRange, default 50 blocks) and the
 * scan goes on at that size. When even the smallest range is refused, or another getLogs error
 * hits after some ranges were read, the scan stops there and returns what it read with `error`
 * set, so the cursor still moves past the finished ranges.
 */
export async function scanEvmImportSwapFees({ source, rpc, fromBlock, maxBlocks = source.maxBlocksPerRun }) {
  const head = Number(hexToBig(await rpc("eth_blockNumber", []))) - source.confirmations;
  const start = Math.max(Number(fromBlock ?? source.startBlock), source.startBlock);
  const end = Math.min(head, start + maxBlocks - 1);
  const rows = [];
  if (end < start) return { rows, nextBlock: start, scanned: 0, head, complete: true };
  const blockTimes = new Map();
  const minRange = Math.max(1, Math.min(source.maxRange, Number(source.minRange || 50)));
  let range = source.maxRange;
  // A split receiver (ImportFeeVault) can be paid by several routers: topic OR-list.
  const payerTopic = source.payers ? source.payers.map(padTopic) : padTopic(source.payer);
  let from = start;
  while (from <= end) {
    const to = Math.min(end, from + range - 1);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: source.receiver, topics: [VAULT_DEPOSIT_TOPIC, payerTopic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    } catch (error) {
      if (isRangeLimitError(error) && range > minRange) {
        range = Math.max(minRange, Math.floor(range / 2));
        continue;
      }
      const reason = `eth_getLogs ${from}-${to} (${to - from + 1} blocks): ${String(error?.message || error).slice(0, 400)}`;
      if (from === start) throw new Error(reason);
      return { rows, nextBlock: from, scanned: from - start, head, complete: false, range, error: reason };
    }
    for (const log of logs || []) {
      if (log.removed) continue;
      const amount = hexToBig(String(log.data).slice(0, 66));
      if (amount <= 0n) continue;
      const blockNumber = Number(hexToBig(log.blockNumber));
      const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [log.transactionHash]), rpc("eth_getTransactionReceipt", [log.transactionHash])]);
      if (!blockTimes.has(blockNumber)) blockTimes.set(blockNumber, Number(hexToBig((await rpc("eth_getBlockByNumber", [log.blockNumber, false])).timestamp)));
      let wallet = String(tx?.from || "").toLowerCase() || null;
      let { token, side } = evmSwapTokenSide(receipt, wallet, WRAPPED[source.chainId]);
      // ImportSwapFeeRouter (CO-IMP CI4): token, side and trader from its own ImportSwap event, never guessed.
      const payerAddress = source.payers ? topicAddress(log.topics[1]) : source.payer;
      if ((source.feeRouters || []).includes(payerAddress)) ({ wallet, token, side } = importSwapRouterAttribution(receipt, payerAddress, log, amount));
      rows.push({
        chainId: source.chainId, txHash: String(log.transactionHash).toLowerCase(), logIndex: Number(hexToBig(log.logIndex)), blockNumber,
        occurredAt: new Date(blockTimes.get(blockNumber) * 1000).toISOString(),
        wallet, tokenAddress: token, side, feeRaw: amount.toString(), feeAsset: source.asset,
        fingerprint: evmFingerprint(tx?.to, tx?.input, tx?.value),
        feeReceiver: source.receiver, router: source.payers ? topicAddress(log.topics[1]) : source.payer, source: "evm_vault_deposit",
        internalWallet: Boolean(wallet && isOwnerWallet(wallet)),
      });
    }
    from = to + 1;
  }
  return { rows, nextBlock: end + 1, scanned: end - start + 1, head, complete: end >= head, range };
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
  if (source.kind === "evm" && !source.receiver) return ingestSplitOnly({ db, source, env, fetchImpl, dryRun, fromScratch, rpc, log });
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
  const summary = { chainId, dryRun, cursorBefore: cursor, cursorAfter: nextCursor, scanned: scan.scanned, found: scan.rows.length, inserted, feeRaw, asset: source.asset, complete: scan.complete, ...(scan.error ? { error: scan.error } : {}) };
  log?.(summary, scan.rows);
  const split = [];
  const splitSources = [...importSwapFeeSplitSources(env).filter((s) => s.chainId === chainId), ...partnerSplitSources(await readActivePartners(db, chainId), env)];
  for (const splitSource of splitSources) {
    split.push(await ingestSplitReceiver({ db, source: splitSource, env, fetchImpl, dryRun, fromScratch, rpc, log }));
  }
  // Coins that earned creator fees without a MemeWarzone page get one (importAutoImport.js); best effort.
  let autoImport = null;
  if (!dryRun && split.length) {
    try {
      const { autoImportMissing } = await import("./importAutoImport.js");
      autoImport = await autoImportMissing({ db, chainId, env });
    } catch (error) {
      autoImport = { chainId, error: String(error?.message || error).slice(0, 200) };
    }
  }
  // A scan that stopped early stored what it read; the step still reports the refusal.
  const stopped = [scan.error && `stopped at block ${nextCursor}: ${scan.error}`, ...split.filter((s) => s.error).map((s) => `${s.receiver} stopped at block ${s.cursorAfter}: ${s.error}`)].filter(Boolean);
  if (stopped.length) throw Object.assign(new Error(stopped.join(" || ")), { summary: { ...summary, ...(split.length ? { split } : {}) } });
  return { ...summary, rows: scan.rows, ...(split.length ? { split } : {}), ...(autoImport ? { autoImport } : {}) };
}

// ------------------------------------------------------------------ 1% split receivers (founder, 2026-10-08)
//
// From the switch to 1%, every import swap pays the whole fee to ONE receiver per chain and the
// split happens afterwards: half is the protocol's, half the coin creator's. Each fee row stores
// its creator half (creator_raw) and gets an import_creator_fees accrual that waits 90 days.
//   Solana 101   the wrapped-SOL account of the import fee collector key (SOLANA_IMPORT_FEE_COLLECTOR,
//                the key lives only in the indexer, which pays creators and sweeps the protocol half).
//   BNB 56 /     an ImportFeeVault (RecruiterRewardsVault bytecode): IMPORT_FEE_VAULT_<chainId>, paid
//   Robinhood    by the routers in IMPORT_FEE_VAULT_PAYERS_<chainId> (default: Kyber router on 56,
//   4663         Universal Router on 4663), scanned from IMPORT_FEE_VAULT_START_BLOCK_<chainId>.
// The old 0.5% receivers stay in importSwapFeeSources() for history; their rows are 100% protocol.

export const IMPORT_CREATOR_FEE_WINDOW_DAYS = 90;

/** The creator's half of a split fee (floor; the odd unit stays with the protocol). */
export function creatorHalf(feeRaw) {
  return (BigInt(feeRaw) / 2n).toString();
}

export function importSwapFeeSplitSources(env = process.env) {
  const out = [];
  const collector = String(env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim();
  if (collector) out.push({ chainId: 101, kind: "solana", asset: "SOL", decimals: 9, feeOwner: collector, split: true });
  const legacy = importSwapFeeSources(env);
  const defaults = { 56: [KYBER_ROUTER.toLowerCase()], 4663: [UNIVERSAL_ROUTER_4663], 97: [], 46630: [] };
  for (const chainId of [56, 4663, 97, 46630]) {
    const vault = String(env[`IMPORT_FEE_VAULT_${chainId}`] || "").trim().toLowerCase();
    const startBlock = Number(env[`IMPORT_FEE_VAULT_START_BLOCK_${chainId}`] || 0);
    if (!/^0x[0-9a-f]{40}$/.test(vault) || !Number.isInteger(startBlock) || startBlock <= 0) continue;
    const listed = String(env[`IMPORT_FEE_VAULT_PAYERS_${chainId}`] || "").split(",").map((p) => p.trim().toLowerCase()).filter((p) => /^0x[0-9a-f]{40}$/.test(p));
    const { payer: _payer, receiver: _receiver, startBlock: _start, ...rest } = legacy[chainId];
    const feeRouters = importSwapFeeRouters(chainId, env);
    const payers = listed.length ? listed : [...defaults[chainId], ...feeRouters];
    if (!payers.length) continue; // e.g. testnet 46630 without a fee router: nothing pays this vault
    out.push({ ...rest, receiver: vault, payers, startBlock, split: true, feeRouters: feeRouters.filter((r) => payers.includes(r)) });
  }
  return out;
}

const splitReceiverOf = (source) => (source.kind === "solana" ? source.feeAccount || solanaFeeAccount(source.feeOwner) : source.receiver);

/**
 * Swap-widget partners (founder 2026-10-09): each active partner row is one more split receiver on its
 * chain (Solana: a WSOL account owned by the collector; EVM: its own ImportFeeVault, scanned from
 * start_block). Its fees split by the row's creator_bps / partner_bps of the fee; the rest is ours.
 */
export function partnerSplitSources(partners, env = process.env) {
  const legacy = importSwapFeeSources(env);
  const defaults = { 56: [KYBER_ROUTER.toLowerCase()], 4663: [UNIVERSAL_ROUTER_4663] };
  const out = [];
  for (const p of partners || []) {
    const chainId = Number(p.chain_id);
    const partner = { id: String(p.id), creatorBps: Number(p.creator_bps), partnerBps: Number(p.partner_bps) };
    if (!p.fee_account) continue; // attributed by fingerprint, no receiver of its own
    if (chainId === 101) {
      out.push({ chainId, kind: "solana", asset: "SOL", decimals: 9, feeAccount: String(p.fee_account), split: true, partner });
      continue;
    }
    const base = legacy[chainId];
    const receiver = String(p.fee_account || "").toLowerCase();
    const startBlock = Number(p.start_block || 0);
    if (!base || !/^0x[0-9a-f]{40}$/.test(receiver) || !Number.isInteger(startBlock) || startBlock <= 0) continue;
    const listed = String(env[`IMPORT_FEE_VAULT_PAYERS_${chainId}`] || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x));
    const { payer: _payer, receiver: _receiver, startBlock: _start, ...rest } = base;
    out.push({ ...rest, receiver, payers: listed.length ? listed : defaults[chainId], startBlock, split: true, partner });
  }
  return out;
}

export async function readActivePartners(db, chainId) {
  if (!db) return [];
  try {
    const { rows } = await db.query(
      `select id, chain_id, fee_account, payout_wallet, creator_bps, partner_bps, start_block from public.import_fee_partners where active and chain_id = $1 order by id`,
      [chainId],
    );
    return rows;
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

/**
 * Split terms of the active partners on a chain. A partner that is switched off earns nothing on swaps that
 * land after that, even through its old widget code: its part stays ours, the creator's half is unchanged
 * (founder, 2026-10-09). What it earned while active is still paid (the worker pays recorded partner_raw).
 */
export async function partnerTermsById(db, chainId) {
  if (!db) return new Map();
  try {
    const { rows } = await db.query(`select id, creator_bps, partner_bps from public.import_fee_partners where chain_id = $1 and active`, [chainId]);
    return new Map(rows.map((row) => [String(row.id), { id: String(row.id), creatorBps: Number(row.creator_bps), partnerBps: Number(row.partner_bps) }]));
  } catch (error) {
    if (error?.code === "42P01") return new Map();
    throw error;
  }
}

/** Creator / partner parts of one split fee: a partner row's bps, else half to the creator. Floors; the rest is ours. */
export function splitFee(feeRaw, partner = null) {
  const fee = BigInt(feeRaw);
  if (!partner) return { creatorRaw: creatorHalf(fee), partnerRaw: "0", partnerId: null };
  return {
    creatorRaw: ((fee * BigInt(partner.creatorBps)) / 10_000n).toString(),
    partnerRaw: ((fee * BigInt(partner.partnerBps)) / 10_000n).toString(),
    partnerId: partner.id,
  };
}

export async function readSplitReceiverCursor(db, chainId, receiver) {
  const { rows } = await db.query("select cursor from public.finance_import_swap_fee_receiver_cursors where chain_id = $1 and receiver = $2", [chainId, receiver]);
  return rows[0]?.cursor ?? null;
}

const INSERT_SPLIT_SQL = `
  with ins as (
    insert into public.finance_import_swap_fees
      (chain_id, tx_hash, log_index, block_number, occurred_at, wallet, token_address, side, fee_raw, fee_asset, fee_receiver, router, source, internal_wallet, creator_raw, partner_id, partner_raw)
    select * from unnest($1::int[], $2::text[], $3::int[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::text[], $11::text[], $12::text[], $13::text[], $14::boolean[], $15::numeric[], $17::text[], $18::numeric[])
    on conflict (chain_id, tx_hash, log_index) do nothing
    returning id, chain_id, token_address, creator_raw, occurred_at
  ), acc as (
    insert into public.import_creator_fees (fee_id, chain_id, token_address, creator_raw, occurred_at, expires_at)
    select id, chain_id, token_address, creator_raw, occurred_at, occurred_at + make_interval(days => $16::int)
      from ins where creator_raw > 0
    on conflict (fee_id) do nothing
    returning fee_id
  )
  select (select count(*) from ins)::int as inserted, (select count(*) from acc)::int as accrued`;

/** Stores split fee rows with their creator accruals and moves the receiver's cursor, in one transaction. */
export async function storeSplitImportSwapFees(db, source, rows, cursor) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("begin");
    let inserted = 0;
    let accrued = 0;
    if (rows.length) {
      const col = (k) => rows.map((r) => r[k] ?? null);
      const result = await client.query(INSERT_SPLIT_SQL, [col("chainId"), col("txHash"), col("logIndex"), col("blockNumber"), col("occurredAt"), col("wallet"), col("tokenAddress"), col("side"), col("feeRaw"), col("feeAsset"), col("feeReceiver"), col("router"), col("source"), col("internalWallet"), col("creatorRaw"), IMPORT_CREATOR_FEE_WINDOW_DAYS, col("partnerId"), rows.map((r) => r.partnerRaw ?? "0")]);
      inserted = Number(result.rows?.[0]?.inserted ?? 0);
      accrued = Number(result.rows?.[0]?.accrued ?? 0);
    }
    if (cursor != null) {
      await client.query(`insert into public.finance_import_swap_fee_receiver_cursors (chain_id, receiver, cursor, updated_at) values ($1, $2, $3, now())
        on conflict (chain_id, receiver) do update set cursor = excluded.cursor, updated_at = now()`, [source.chainId, splitReceiverOf(source), String(cursor)]);
    }
    await client.query("commit");
    return { inserted, accrued };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (client !== db) client.release?.();
  }
}

async function ingestSplitReceiver({ db, source, env, fetchImpl, dryRun, fromScratch, rpc, log }) {
  const receiver = splitReceiverOf(source);
  let cursor = null;
  if (!fromScratch && db) {
    try {
      cursor = await readSplitReceiverCursor(db, source.chainId, receiver);
    } catch (error) {
      if (error?.code !== "42P01") throw error;
      if (!dryRun) throw new Error("finance_import_swap_fee_receiver_cursors is missing: apply db/migrations/20261008_000020_import_creator_fees.sql first.");
    }
  }
  const call = rpc || rpcClient(source.kind === "solana" ? solanaImportSwapRpcUrls(env) : getRpcUrls(source.chainId), { fetchImpl });
  const scan = source.kind === "solana"
    ? await scanSolanaImportSwapFees({ source, rpc: call, cursor })
    : await scanEvmImportSwapFees({ source, rpc: call, fromBlock: cursor == null ? null : Number(cursor) });
  // A partner's own receiver splits by that partner; elsewhere a recorded build fingerprint names the partner.
  let byFingerprint = new Map();
  let partnerTerms = new Map();
  if (!source.partner && scan.rows.some((row) => row.fingerprint)) {
    byFingerprint = await partnersForFingerprints(db, source.chainId, scan.rows.map((row) => row.fingerprint));
    if (byFingerprint.size) partnerTerms = await partnerTermsById(db, source.chainId);
  }
  const rows = scan.rows.map((row) => {
    const partnerId = source.partner ? null : byFingerprint.get(row.fingerprint);
    const partner = source.partner || (partnerId ? partnerTerms.get(partnerId) || null : null);
    return { ...row, ...splitFee(row.feeRaw, partner) };
  });
  const nextCursor = source.kind === "solana" ? scan.cursor : String(scan.nextBlock);
  const stored = dryRun ? { inserted: 0, accrued: 0 } : await storeSplitImportSwapFees(db, source, rows, nextCursor);
  const summary = { chainId: source.chainId, receiver, split: true, ...(source.partner ? { partner: source.partner.id } : {}), dryRun, cursorBefore: cursor, cursorAfter: nextCursor, scanned: scan.scanned, found: rows.length, ...stored, complete: scan.complete, ...(scan.error ? { error: scan.error } : {}) };
  log?.(summary, rows);
  return summary;
}

// ------------------------------------------------------------------ ImportSwapFeeRouter (CO-IMP rev 2 CI4 / CI5)
//
// BNB coins without a PancakeSwap route trade their Topaz pool through ImportSwapFeeRouter, which pays
// its fee to the ImportFeeVault (a Deposit with from = the router, like Kyber's). The router is a payer
// of the split source: IMPORT_SWAP_FEE_ROUTER_<chainId>, added to the default payers (or named in
// IMPORT_FEE_VAULT_PAYERS_<chainId> when that list is set). On testnet 97 it is the only payer (no Kyber
// there). Testnet 46630 keeps the fee-less adapter route for imports, so it has no payer and no split
// source unless a router is deployed there and named in IMPORT_SWAP_FEE_ROUTER_46630.
// Attribution of a router row comes from the router's own ImportSwap event in the same transaction.

// keccak256("ImportSwap(address,address,uint8,bool,uint256,uint256,uint256,uint256,address)")
export const IMPORT_SWAP_EVENT_TOPIC = "0xb4f5e1e932a4f5eca5b210d658e3b7fd589d216300f43e4053ca3b770bce6028";

/** Fee routers configured for a chain (IMPORT_SWAP_FEE_ROUTER_<chainId>), lower-cased. */
export function importSwapFeeRouters(chainId, env = process.env) {
  return String(env[`IMPORT_SWAP_FEE_ROUTER_${chainId}`] || "").split(",").map((p) => p.trim().toLowerCase()).filter((p) => /^0x[0-9a-f]{40}$/.test(p));
}

/**
 * wallet / token / side of a vault Deposit paid by an ImportSwapFeeRouter: its ImportSwap event in the
 * same receipt. The router pays its fees (Deposits) and then emits ImportSwap, so the event is the first
 * one from that router after the Deposit whose feeProtocol or feeCreator equals the Deposit's amount.
 * Nothing found: all null (the row is stored, unattributed, never guessed).
 */
export function importSwapRouterAttribution(receipt, router, depositLog, amount) {
  const depositIndex = Number(hexToBig(depositLog.logIndex));
  const logs = [...(receipt?.logs || [])].sort((a, b) => Number(hexToBig(a.logIndex)) - Number(hexToBig(b.logIndex)));
  for (const log of logs) {
    if (String(log.address || "").toLowerCase() !== router || log.topics?.[0] !== IMPORT_SWAP_EVENT_TOPIC || log.topics.length < 3) continue;
    if (Number(hexToBig(log.logIndex)) <= depositIndex) continue;
    const data = String(log.data || "").slice(2);
    const wordAt = (i) => hexToBig(`0x${data.slice(i * 64, (i + 1) * 64)}`);
    // data: venue, isBuy, nativeGross, feeProtocol, feeCreator, tokenAmount, recipient
    if (data.length < 7 * 64) continue;
    const isBuy = wordAt(1) === 1n;
    const feeProtocol = wordAt(3);
    const feeCreator = wordAt(4);
    if (feeProtocol !== amount && feeCreator !== amount) continue;
    return { wallet: topicAddress(log.topics[1]), token: topicAddress(log.topics[2]), side: isBuy ? "buy" : "sell" };
  }
  return { wallet: null, token: null, side: null };
}

/** A testnet (no old receiver): only its split receiver, in the same summary shape as ingestImportSwapFees. */
async function ingestSplitOnly({ db, source, env, fetchImpl, dryRun, fromScratch, rpc, log }) {
  const split = [];
  for (const splitSource of importSwapFeeSplitSources(env).filter((s) => s.chainId === source.chainId)) {
    split.push(await ingestSplitReceiver({ db, source: splitSource, env, fetchImpl, dryRun, fromScratch, rpc, log }));
  }
  const complete = split.every((s) => s.complete);
  return { chainId: source.chainId, dryRun, cursorBefore: null, cursorAfter: null, scanned: 0, found: 0, inserted: 0, feeRaw: "0", asset: source.asset, complete, rows: [], ...(split.length ? { split } : {}) };
}

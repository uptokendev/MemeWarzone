import assert from "node:assert/strict";
import test from "node:test";
import { id as keccakId } from "ethers";

import {
  IMPORT_SWAP_FEE_RECEIVER_4663,
  UNIVERSAL_ROUTER_4663,
  VAULT_DEPOSIT_TOPIC,
  evmSwapTokenSide,
  importSwapFeeSources,
  ingestImportSwapFees,
  rpcClient,
  rpcHost,
  isRangeLimitError,
  scanEvmImportSwapFees,
  scanSolanaImportSwapFees,
  solanaFeeRow,
  storeImportSwapFees,
  creatorHalf,
  importSwapFeeSplitSources,
  storeSplitImportSwapFees,
  IMPORT_CREATOR_FEE_WINDOW_DAYS,
  splitFee,
  partnerSplitSources,
  readActivePartners,
} from "./financeImportSwapFees.js";
import { EVENT_QUERIES, LANE_QUERIES } from "./financeRevenueLanes.js";
import { vatLaneOf } from "./financeTaxRules.js";
import * as rh from "../../src/lib/robinhoodImportSwap.mjs";
import { JUPITER_PROGRAM, KYBER_ROUTER, solanaFeeAccount } from "../importSwap.js";

const WSOL = "So11111111111111111111111111111111111111112";
const OWNER = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";
const FEE_ACCOUNT = solanaFeeAccount(OWNER);
const USER = "8doLGRWZsKTGcAYg84PGo8agW4WaDdqQynByMnbtwG4R";
const COIN = "7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump";

test("constants match the swap code: topic, Robinhood router and receiver, Kyber router", () => {
  assert.equal(VAULT_DEPOSIT_TOPIC, keccakId("Deposit(address,uint256,uint256)"));
  assert.equal(UNIVERSAL_ROUTER_4663, rh.UNIVERSAL_ROUTER_4663.toLowerCase());
  assert.equal(IMPORT_SWAP_FEE_RECEIVER_4663, rh.IMPORT_SWAP_FEE_RECEIVER_4663.toLowerCase());
  const sources = importSwapFeeSources({});
  assert.equal(sources[56].payer, KYBER_ROUTER.toLowerCase());
  assert.equal(sources[56].receiver, "0xc2d4e6f846446f3921a34a34e007295dbc19bc4c");
  assert.equal(sources[101].feeOwner, OWNER);
  assert.equal(importSwapFeeSources({ IMPORT_SWAP_FEE_RECEIVER_56: "0xABC0000000000000000000000000000000000001" })[56].receiver, "0xabc0000000000000000000000000000000000001");
});

function solanaTx({ feeBefore = "100", feeAfter = "50100", jupiter = true, coinBefore = "0", coinAfter = "1000", err = null, signer = USER } = {}) {
  return {
    slot: 123,
    blockTime: 1_791_262_484,
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 3, mint: WSOL, owner: OWNER, uiTokenAmount: { amount: feeBefore } }, { accountIndex: 4, mint: COIN, owner: signer, uiTokenAmount: { amount: coinBefore } }],
      postTokenBalances: [{ accountIndex: 3, mint: WSOL, owner: OWNER, uiTokenAmount: { amount: feeAfter } }, { accountIndex: 4, mint: COIN, owner: signer, uiTokenAmount: { amount: coinAfter } }],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: signer }, { pubkey: "11111111111111111111111111111111" }, { pubkey: jupiter ? JUPITER_PROGRAM : "ComputeBudget111111111111111111111111111111" }, { pubkey: FEE_ACCOUNT }, { pubkey: "Coin4ccount111111111111111111111111111111111" }],
        instructions: [{ programId: jupiter ? JUPITER_PROGRAM : "ComputeBudget111111111111111111111111111111" }],
      },
    },
  };
}

test("Solana: a Jupiter swap that raised the fee account is one row; deposits, closes and failures are not", () => {
  const row = solanaFeeRow(solanaTx(), { signature: "sig1", feeAccount: FEE_ACCOUNT, feeOwner: OWNER });
  assert.equal(row.feeRaw, "50000");
  assert.equal(row.side, "buy");
  assert.equal(row.tokenAddress, COIN);
  assert.equal(row.wallet, USER);
  assert.equal(row.occurredAt, "2026-10-06T04:54:44.000Z");
  assert.equal(row.internalWallet, false);
  assert.equal(row.source, "solana_fee_account");
  assert.equal(solanaFeeRow(solanaTx({ coinBefore: "1000", coinAfter: "0" }), { signature: "s", feeAccount: FEE_ACCOUNT }).side, "sell");
  assert.equal(solanaFeeRow(solanaTx({ jupiter: false }), { signature: "s", feeAccount: FEE_ACCOUNT }), null, "no Jupiter: not a swap fee");
  assert.equal(solanaFeeRow(solanaTx({ feeAfter: "100" }), { signature: "s", feeAccount: FEE_ACCOUNT }), null, "no rise");
  assert.equal(solanaFeeRow(solanaTx({ feeAfter: "0" }), { signature: "s", feeAccount: FEE_ACCOUNT }), null, "a withdrawal is not revenue");
  assert.equal(solanaFeeRow(solanaTx({ err: { InstructionError: [0, "x"] } }), { signature: "s", feeAccount: FEE_ACCOUNT }), null, "failed tx");
  const own = solanaFeeRow(solanaTx({ signer: "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9" }), { signature: "s", feeAccount: FEE_ACCOUNT });
  assert.equal(own.internalWallet, true, "our own wallet is marked");
});

test("Solana scan: pages back to the cursor, stores oldest first, skips failed signatures, stops at an unseen tx", async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "getSignaturesForAddress") {
      assert.equal(params[0], FEE_ACCOUNT);
      assert.equal(params[1].until, "old");
      return [{ signature: "c", err: null }, { signature: "b", err: { x: 1 } }, { signature: "a", err: null }];
    }
    return solanaTx();
  };
  const out = await scanSolanaImportSwapFees({ source: importSwapFeeSources({})[101], rpc, cursor: "old" });
  assert.deepEqual(out.rows.map((r) => r.txHash), ["a", "c"]);
  assert.equal(out.cursor, "c");
  assert.equal(calls.filter(([m]) => m === "getTransaction").length, 2, "failed signature not fetched");

  const missing = await scanSolanaImportSwapFees({ source: importSwapFeeSources({})[101], rpc: async (m) => (m === "getSignaturesForAddress" ? [{ signature: "y", err: null }, { signature: "x", err: null }] : null), cursor: "old" });
  assert.equal(missing.cursor, "old", "an unseen transaction keeps the cursor so it is retried");
});

const pad = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const USER_EVM = "0x1111111111111111111111111111111111111111";
const TOKEN_EVM = "0x2222222222222222222222222222222222222222";
const TRANSFER = keccakId("Transfer(address,address,uint256)");

test("EVM: token and side from the receipt; wrapped native ignored", () => {
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const receipt = { logs: [
    { address: wbnb, topics: [TRANSFER, pad(USER_EVM), pad(TOKEN_EVM)] },
    { address: TOKEN_EVM, topics: [TRANSFER, pad("0x3333333333333333333333333333333333333333"), pad(USER_EVM)] },
  ] };
  assert.deepEqual(evmSwapTokenSide(receipt, USER_EVM, wbnb), { token: TOKEN_EVM, side: "buy" });
  const sell = { logs: [{ address: TOKEN_EVM, topics: [TRANSFER, pad(USER_EVM), pad(KYBER_ROUTER)] }] };
  assert.deepEqual(evmSwapTokenSide(sell, USER_EVM, wbnb), { token: TOKEN_EVM, side: "sell" });
  assert.deepEqual(evmSwapTokenSide({ logs: [] }, USER_EVM, wbnb), { token: null, side: null });
});

test("EVM scan: vault Deposit logs from the swap router only, chunked, with confirmations and the launch block as floor", async () => {
  const source = importSwapFeeSources({})[56];
  const ranges = [];
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return `0x${(source.startBlock + 12_000 + source.confirmations).toString(16)}`;
    if (method === "eth_getLogs") {
      const f = params[0];
      assert.equal(f.address, source.receiver);
      assert.deepEqual(f.topics, [VAULT_DEPOSIT_TOPIC, pad(KYBER_ROUTER)]);
      ranges.push([Number(f.fromBlock), Number(f.toBlock)]);
      if (Number(f.fromBlock) !== source.startBlock) return [];
      return [
        { transactionHash: "0xAB", logIndex: "0x5", blockNumber: `0x${(source.startBlock + 7).toString(16)}`, data: `${word(25_000_000_000_000n)}${word(1).slice(2)}` },
        { transactionHash: "0xCD", logIndex: "0x1", blockNumber: `0x${(source.startBlock + 9).toString(16)}`, data: word(1), removed: true },
      ];
    }
    if (method === "eth_getTransactionByHash") return { from: USER_EVM.toUpperCase().replace("0X", "0x"), value: "0x1" };
    if (method === "eth_getTransactionReceipt") return { logs: [{ address: TOKEN_EVM, topics: [TRANSFER, pad(KYBER_ROUTER), pad(USER_EVM)] }] };
    if (method === "eth_getBlockByNumber") return { timestamp: word(1_790_000_000) };
    throw new Error(method);
  };
  const out = await scanEvmImportSwapFees({ source, rpc, fromBlock: 5 });
  assert.equal(ranges[0][0], source.startBlock, "never before the launch block");
  assert.deepEqual(ranges.map(([a, b]) => b - a + 1), [5000, 5000, 2001]);
  assert.equal(out.nextBlock, source.startBlock + 12_001);
  assert.equal(out.complete, true);
  assert.equal(out.rows.length, 1, "a removed log is skipped");
  const [row] = out.rows;
  assert.equal(row.txHash, "0xab");
  assert.equal(row.logIndex, 5);
  assert.equal(row.feeRaw, "25000000000000");
  assert.equal(row.feeAsset, "BNB");
  assert.equal(row.wallet, USER_EVM);
  assert.equal(row.side, "buy");
  assert.equal(row.tokenAddress, TOKEN_EVM);
  assert.equal(row.occurredAt, new Date(1_790_000_000_000).toISOString());
});

test("store: one transaction, insert skips duplicates, cursor upserted; dry run writes nothing", async () => {
  const statements = [];
  const client = { query: async (sql, params) => { statements.push([sql.trim().split(/\s+/).slice(0, 3).join(" "), params]); return { rowCount: params?.[0]?.length ?? 0 }; }, release() { statements.push(["release"]); } };
  const db = { connect: async () => client };
  const rows = [{ chainId: 56, txHash: "0xab", logIndex: 5, blockNumber: 1, occurredAt: "2026-10-01T00:00:00.000Z", wallet: USER_EVM, tokenAddress: TOKEN_EVM, side: "buy", feeRaw: "25", feeAsset: "BNB", feeReceiver: "0xc2d4", router: "0x6131", source: "evm_vault_deposit", internalWallet: false }];
  const inserted = await storeImportSwapFees(db, 56, rows, "123");
  assert.equal(inserted, 1);
  assert.deepEqual(statements.map(([s]) => s), ["begin", "insert into public.finance_import_swap_fees", "insert into public.finance_import_swap_fee_cursors", "commit", "release"]);
  assert.match(String(statements[1][0]), /finance_import_swap_fees/);

  const writes = [];
  const readOnly = { query: async (sql) => { writes.push(sql); if (/^select/i.test(sql.trim())) return { rows: [{ cursor: "125000000" }] }; throw new Error("write in dry run"); } };
  const rpc = async (method) => (method === "eth_blockNumber" ? "0x0" : []);
  const out = await ingestImportSwapFees({ db: readOnly, chainId: 56, dryRun: true, rpc });
  assert.equal(out.inserted, 0);
  assert.equal(out.cursorBefore, "125000000");
  assert.ok(writes.every((sql) => /^select/i.test(sql.trim())));
});

test("ingest: a missing table is a clear error outside a dry run", async () => {
  const db = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  await assert.rejects(ingestImportSwapFees({ db, chainId: 56, rpc: async () => "0x0" }), /apply db\/migrations\/20261006_000002_finance_import_swap_fees\.sql/);
});

test("rpc client: retries with backoff, then falls back to the next URL", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url === "a") return { json: async () => ({ error: { message: "limit exceeded" } }) };
    return { json: async () => ({ result: "ok" }) };
  };
  assert.equal(await rpcClient(["a", "b"], { fetchImpl, backoffMs: 1 })("eth_blockNumber", []), "ok");
  assert.equal(calls, 2);
  await assert.rejects(rpcClient(["a"], { fetchImpl, backoffMs: 1, retries: 2 })("x", []), /limit exceeded/);
});

test("revenue lane: import swaps read the fee table per chain, CSV events from the same spec, VAT lane mapped", () => {
  assert.match(LANE_QUERIES.import_swaps, /from public\.finance_import_swap_fees f/);
  assert.match(LANE_QUERIES.import_swaps, /f\.chain_id = \$1/);
  // From the 1% switch half of a fee row is the creator's: revenue is fee_raw - creator_raw.
  assert.match(LANE_QUERIES.import_swaps, /sum\(\(f\.fee_raw - f\.creator_raw - f\.partner_raw\)\)/);
  assert.match(EVENT_QUERIES.import_swaps, /f\.tx_hash as tx_hash/);
  assert.equal(vatLaneOf("import-swaps:56"), "import_swaps");
});

test("founder 2026-10-06: own-wallet import swaps are left out of revenue; BNB scan starts 2026-10-01", async () => {
  const fs = await import("node:fs");
  const lanes = fs.readFileSync(new URL("./financeRevenueLanes.js", import.meta.url), "utf8");
  assert.match(lanes, /from: "public\.finance_import_swap_fees f",\s*where: `f\.chain_id = \$1\s*and f\.fee_raw > 0\s*and not f\.internal_wallet`/);
  const { importSwapFeeSources } = await import("./financeImportSwapFees.js");
  assert.equal(importSwapFeeSources({})[56].startBlock, 125000755);
});

// ------------------------------------------------------------------ 1% split receivers (founder, 2026-10-08)

test("split: creator half is floor(fee / 2), the odd unit stays with the protocol", () => {
  assert.equal(creatorHalf("100"), "50");
  assert.equal(creatorHalf("101"), "50");
  assert.equal(creatorHalf("1"), "0");
  assert.equal(IMPORT_CREATOR_FEE_WINDOW_DAYS, 90);
});

test("split sources: only what the env switches on; EVM needs vault + start block; payers default to the swap router", () => {
  assert.deepEqual(importSwapFeeSplitSources({}), []);
  const sol = importSwapFeeSplitSources({ SOLANA_IMPORT_FEE_COLLECTOR: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB" });
  assert.equal(sol.length, 1);
  assert.equal(sol[0].chainId, 101);
  assert.equal(sol[0].split, true);
  const vault = "0x00000000000000000000000000000000000000AA";
  assert.deepEqual(importSwapFeeSplitSources({ IMPORT_FEE_VAULT_56: vault }), [], "no start block: off");
  const [bnb] = importSwapFeeSplitSources({ IMPORT_FEE_VAULT_56: vault, IMPORT_FEE_VAULT_START_BLOCK_56: "130000000" });
  assert.equal(bnb.receiver, vault.toLowerCase());
  assert.deepEqual(bnb.payers, [KYBER_ROUTER.toLowerCase()]);
  assert.equal(bnb.startBlock, 130000000);
  assert.equal(bnb.payer, undefined, "a split source never carries the old single payer");
  const [rh] = importSwapFeeSplitSources({ IMPORT_FEE_VAULT_4663: vault, IMPORT_FEE_VAULT_START_BLOCK_4663: "80000000", IMPORT_FEE_VAULT_PAYERS_4663: `${UNIVERSAL_ROUTER_4663},0x00000000000000000000000000000000000000BB` });
  assert.deepEqual(rh.payers, [UNIVERSAL_ROUTER_4663, "0x00000000000000000000000000000000000000bb"]);
});

test("split EVM scan: payer topic is an OR-list and the row's router is the actual payer", async () => {
  const vault = "0x00000000000000000000000000000000000000aa";
  const [source] = importSwapFeeSplitSources({ IMPORT_FEE_VAULT_56: vault, IMPORT_FEE_VAULT_START_BLOCK_56: "100" });
  const seen = [];
  const payer = KYBER_ROUTER.toLowerCase();
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return "0x80";
    if (method === "eth_getLogs") {
      seen.push(params[0].topics);
      return [{ removed: false, data: `0x${(1000n).toString(16).padStart(64, "0")}`, blockNumber: "0x64", logIndex: "0x1", transactionHash: "0xAB", topics: [VAULT_DEPOSIT_TOPIC, `0x${"0".repeat(24)}${payer.slice(2)}`] }];
    }
    if (method === "eth_getTransactionByHash") return { from: USER_EVM };
    if (method === "eth_getTransactionReceipt") return { logs: [] };
    if (method === "eth_getBlockByNumber") return { timestamp: "0x6700" };
    return null;
  };
  const out = await scanEvmImportSwapFees({ source, rpc, fromBlock: null });
  assert.ok(Array.isArray(seen[0][1]), "OR-list of payers");
  assert.equal(out.rows[0].router, payer);
  assert.equal(out.rows[0].feeReceiver, vault);
});

test("split store: fee rows with creator_raw and their 90-day accruals in one statement, receiver cursor upserted", async () => {
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push([sql.trim().split(/\s+/).slice(0, 3).join(" "), params]);
      return /^with ins/i.test(sql.trim()) ? { rows: [{ inserted: 1, accrued: 1 }] } : { rowCount: 1 };
    },
    release() { statements.push(["release"]); },
  };
  const db = { connect: async () => client };
  const [source] = importSwapFeeSplitSources({ SOLANA_IMPORT_FEE_COLLECTOR: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB" });
  const rows = [{ chainId: 101, txHash: "sig", logIndex: 0, blockNumber: 1, occurredAt: "2026-10-09T00:00:00.000Z", wallet: "w", tokenAddress: "mint", side: "buy", feeRaw: "1001", feeAsset: "SOL", feeReceiver: "acct", router: JUPITER_PROGRAM, source: "solana_fee_account", internalWallet: false, creatorRaw: creatorHalf("1001") }];
  const out = await storeSplitImportSwapFees(db, source, rows, "sig");
  assert.deepEqual(out, { inserted: 1, accrued: 1 });
  assert.deepEqual(statements.map(([s]) => s), ["begin", "with ins as", "insert into public.finance_import_swap_fee_receiver_cursors", "commit", "release"]);
  const params = statements[1][1];
  assert.deepEqual(params[14], ["500"], "creator_raw column");
  assert.equal(params[15], 90, "window days");
  assert.deepEqual(statements[2][1], [101, solanaFeeAccount("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"), "sig"]);
});

test("split ingest: runs after the old receiver, from its own cursor; none configured = old behaviour only", async () => {
  const reads = [];
  const db = { query: async (sql) => { reads.push(sql.trim()); return { rows: [] }; } };
  const rpc = async (method) => (method === "getSignaturesForAddress" ? [] : null);
  const plain = await ingestImportSwapFees({ db, chainId: 101, env: {}, dryRun: true, rpc });
  assert.equal(plain.split, undefined);
  const both = await ingestImportSwapFees({ db, chainId: 101, env: { SOLANA_IMPORT_FEE_COLLECTOR: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB" }, dryRun: true, rpc });
  assert.equal(both.split.length, 1);
  assert.equal(both.split[0].split, true);
  assert.ok(reads.some((sql) => /finance_import_swap_fee_receiver_cursors/.test(sql)));
});

test("revenue: creator halves nobody claimed in 90 days count when they expire, VAT lane import_swaps", () => {
  assert.match(LANE_QUERIES.import_swaps_expired, /from public\.import_creator_fees c join public\.finance_import_swap_fees f/);
  assert.match(LANE_QUERIES.import_swaps_expired, /c\.status = 'expired'/);
  assert.match(LANE_QUERIES.import_swaps_expired, /sum\(c\.creator_raw\)/);
  assert.equal(vatLaneOf("import-swaps-expired:101"), "import_swaps");
});

test("rpc client: a refusal names the host only, never the key in the path; a getLogs range refusal is not retried", async () => {
  const keyed = "https://bsc-mainnet.core.chainstack.com/0123456789abcdef0123456789abcdef";
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === keyed) return { ok: false, status: 429, json: async () => { throw new Error("not json"); } };
    return { ok: true, json: async () => ({ error: { code: -32005, message: "limit exceeded" } }) };
  };
  const call = rpcClient([keyed, "https://bsc-dataseed.binance.org"], { fetchImpl, backoffMs: 1, retries: 3 });
  const error = await call("eth_getLogs", [{}]).then(() => null, (e) => e);
  assert.ok(error, "rejects");
  assert.match(error.message, /bsc-mainnet\.core\.chainstack\.com refused: HTTP 429/);
  assert.match(error.message, /bsc-dataseed\.binance\.org refused: limit exceeded/);
  assert.ok(!error.message.includes("0123456789abcdef"), "no key in the message");
  assert.deepEqual(error.hosts, ["bsc-mainnet.core.chainstack.com", "bsc-dataseed.binance.org"]);
  assert.equal(error.rangeLimited, true);
  assert.equal(isRangeLimitError(error), true);
  assert.equal(calls.length, 2, "one round: a smaller range is the fix, not a retry");
  assert.equal(rpcHost("not a url"), "rpc");
  assert.equal(rpcHost("https://rpc.example.com:8545/key?x=1"), "rpc.example.com:8545");
});

test("EVM scan: a refused getLogs range is halved until the RPC answers, and the scan goes on at that size", async () => {
  const source = { ...importSwapFeeSources({})[56], minRange: 50 };
  const ranges = [];
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return `0x${(source.startBlock + 2_000 - 1 + source.confirmations).toString(16)}`;
    if (method === "eth_getLogs") {
      const size = Number(params[0].toBlock) - Number(params[0].fromBlock) + 1;
      ranges.push(size);
      if (size > 700) throw new Error("eth_getLogs: bsc-dataseed.binance.org refused: limit exceeded");
      return [];
    }
    throw new Error(method);
  };
  const out = await scanEvmImportSwapFees({ source, rpc, fromBlock: null });
  assert.deepEqual(ranges, [2000, 2000, 1250, 625, 625, 625, 125], "5000 -> 2500 -> 1250 -> 625, then on at 625");
  assert.equal(out.complete, true);
  assert.equal(out.nextBlock, source.startBlock + 2_000);
  assert.equal(out.range, 625);
  assert.equal(out.error, undefined);
});

test("EVM scan: at the smallest range a refusal stops the scan; progress so far is kept, a refusal at the start throws with the host", async () => {
  const source = { ...importSwapFeeSources({})[56], maxRange: 100, minRange: 25 };
  const head = source.startBlock + 300 - 1 + source.confirmations;
  let served = 0;
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getLogs") {
      if (served < 2) { served += 1; return []; }
      throw new Error("eth_getLogs: bsc-dataseed.binance.org refused: limit exceeded");
    }
    throw new Error(method);
  };
  const out = await scanEvmImportSwapFees({ source, rpc, fromBlock: null });
  assert.equal(out.nextBlock, source.startBlock + 200, "the two answered ranges count");
  assert.equal(out.complete, false);
  assert.match(out.error, /bsc-dataseed\.binance\.org refused: limit exceeded/);
  assert.match(out.error, /\(25 blocks\)/, "shrunk to the floor before giving up");

  served = 99;
  await assert.rejects(scanEvmImportSwapFees({ source, rpc, fromBlock: null }), /eth_getLogs \d+-\d+ \(25 blocks\): .*bsc-dataseed\.binance\.org/);
});

test("ingest: a scan that stopped early stores its rows and cursor, then reports the refusal", async () => {
  const writes = [];
  const client = { query: async (sql, params) => { writes.push([sql.trim().split(/\s+/).slice(0, 3).join(" "), params]); return { rows: [], rowCount: 0 }; }, release() {} };
  const db = { query: async () => ({ rows: [{ cursor: "125000755" }] }), connect: async () => client };
  const source = importSwapFeeSources({})[56];
  let served = 0;
  const rpc = async (method) => {
    if (method === "eth_blockNumber") return `0x${(source.startBlock + 20_000 + source.confirmations).toString(16)}`;
    if (method === "eth_getLogs") {
      if (served < 1) { served += 1; return []; }
      throw new Error("eth_getLogs: rpc.example.org refused: socket hang up");
    }
    throw new Error(method);
  };
  await assert.rejects(ingestImportSwapFees({ db, chainId: 56, env: {}, rpc }), /stopped at block 125005755: .*rpc\.example\.org refused: socket hang up/);
  const cursorWrite = writes.find(([s]) => s === "insert into public.finance_import_swap_fee_cursors");
  assert.equal(cursorWrite[1][1], "125005755", "cursor moved past the range that was read");
});


// ------------------------------------------------------------------ swap-widget partners (2026-10-09)

test("partner split: creator / partner by the row's bps of the fee, floors; no partner = half to the creator", () => {
  assert.deepEqual(splitFee("1000"), { creatorRaw: "500", partnerRaw: "0", partnerId: null });
  assert.deepEqual(splitFee("1001", { id: "crypticpump", creatorBps: 5000, partnerBps: 2500 }), { creatorRaw: "500", partnerRaw: "250", partnerId: "crypticpump" });
});

test("partner sources: Solana uses the partner's own fee account; EVM needs a vault and its start block", () => {
  const rows = [
    { id: "crypticpump", chain_id: 101, fee_account: "PartnerWsol111111111111111111111111111111111", creator_bps: 5000, partner_bps: 2500, start_block: null },
    { id: "crypticpump", chain_id: 56, fee_account: "0x00000000000000000000000000000000000000Cc", creator_bps: 5000, partner_bps: 2500, start_block: "130000000" },
    { id: "nostart", chain_id: 4663, fee_account: "0x00000000000000000000000000000000000000Dd", creator_bps: 5000, partner_bps: 2500, start_block: null },
  ];
  const [sol, bnb, ...rest] = partnerSplitSources(rows, {});
  assert.equal(rest.length, 0, "an EVM vault without a start block is not scanned");
  assert.equal(sol.feeAccount, "PartnerWsol111111111111111111111111111111111");
  assert.deepEqual(sol.partner, { id: "crypticpump", creatorBps: 5000, partnerBps: 2500 });
  assert.equal(bnb.receiver, "0x00000000000000000000000000000000000000cc");
  assert.deepEqual(bnb.payers, [KYBER_ROUTER.toLowerCase()]);
  assert.equal(bnb.startBlock, 130000000);
});

test("partner table missing: no partner sources, nothing breaks", async () => {
  const db = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  assert.deepEqual(await readActivePartners(db, 101), []);
});

test("split store passes partner id and partner part as their own columns", async () => {
  const seen = [];
  const client = { query: async (sql, params) => { seen.push(params); return /^with ins/i.test(sql.trim()) ? { rows: [{ inserted: 1, accrued: 1 }] } : { rowCount: 1 }; }, release() {} };
  const db = { connect: async () => client };
  const source = { chainId: 101, kind: "solana", feeAccount: "PartnerWsol", split: true };
  const row = { chainId: 101, txHash: "s", logIndex: 0, blockNumber: 1, occurredAt: "2026-10-09T00:00:00.000Z", wallet: "w", tokenAddress: "m", side: "buy", feeRaw: "1000", feeAsset: "SOL", feeReceiver: "PartnerWsol", router: "JUP", source: "solana_fee_account", internalWallet: false, ...splitFee("1000", { id: "crypticpump", creatorBps: 5000, partnerBps: 2500 }) };
  await storeSplitImportSwapFees(db, source, [row], "s");
  const params = seen.find((p) => Array.isArray(p) && p.length === 18);
  assert.deepEqual([params[14], params[16], params[17]], [["500"], ["crypticpump"], ["250"]]);
  assert.deepEqual(seen.find((p) => Array.isArray(p) && p.length === 3 && p[0] === 101), [101, "PartnerWsol", "s"], "cursor per partner account");
});

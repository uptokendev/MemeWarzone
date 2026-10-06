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
  scanEvmImportSwapFees,
  scanSolanaImportSwapFees,
  solanaFeeRow,
  storeImportSwapFees,
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
  assert.match(LANE_QUERIES.import_swaps, /sum\(f\.fee_raw\)/);
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

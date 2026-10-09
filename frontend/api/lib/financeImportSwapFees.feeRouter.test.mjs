// CO-IMP rev 2 CI4 / CI5: ImportSwapFeeRouter as a payer of the ImportFeeVault split source, its rows
// attributed from its own ImportSwap event (real ABI-encoded logs), and the testnet sources (97 / 46630)
// that never reach finance.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Interface } from "ethers";

import {
  IMPORT_SWAP_EVENT_TOPIC,
  VAULT_DEPOSIT_TOPIC,
  importSwapFeeRouters,
  importSwapFeeSources,
  importSwapFeeSplitSources,
  importSwapRouterAttribution,
  ingestImportSwapFees,
  scanEvmImportSwapFees,
} from "./financeImportSwapFees.js";
import { LANE_QUERIES } from "./financeRevenueLanes.js";
import { feeRoutingAllNetworks } from "./financeFeeRouting.js";
import { KYBER_ROUTER } from "../importSwap.js";

const routerAbi = JSON.parse(fs.readFileSync(new URL("../../src/abi/ImportSwapFeeRouter.json", import.meta.url), "utf8")).abi;
const vaultAbi = JSON.parse(fs.readFileSync(new URL("../../src/abi/RecruiterRewardsVault.json", import.meta.url), "utf8")).abi;
const routerIface = new Interface(routerAbi);
const vaultIface = new Interface(vaultAbi);

const VAULT = "0x00000000000000000000000000000000000000aa";
const ROUTER = "0x00000000000000000000000000000000000000bb";
const OTHER = "0x00000000000000000000000000000000000000cc";
const TRADER = "0x1111111111111111111111111111111111111111";
const RELAYER = "0x9999999999999999999999999999999999999999";
const TOKEN = "0x2222222222222222222222222222222222222222";
const TOKEN_B = "0x3333333333333333333333333333333333333333";

test("the ImportSwap topic is the router artifact's event", () => {
  assert.equal(IMPORT_SWAP_EVENT_TOPIC, routerIface.getEvent("ImportSwap").topicHash);
  assert.equal(VAULT_DEPOSIT_TOPIC, vaultIface.getEvent("Deposit").topicHash);
});

test("split sources: the fee router joins the payers; 97 pays only through it; 46630 has none without one", () => {
  const base = { IMPORT_FEE_VAULT_56: VAULT, IMPORT_FEE_VAULT_START_BLOCK_56: "100" };
  const [plain] = importSwapFeeSplitSources(base);
  assert.deepEqual(plain.payers, [KYBER_ROUTER.toLowerCase()]);
  assert.deepEqual(plain.feeRouters, []);
  const [bnb] = importSwapFeeSplitSources({ ...base, IMPORT_SWAP_FEE_ROUTER_56: ROUTER.toUpperCase().replace("0X", "0x") });
  assert.deepEqual(bnb.payers, [KYBER_ROUTER.toLowerCase(), ROUTER]);
  assert.deepEqual(bnb.feeRouters, [ROUTER]);
  const [listed] = importSwapFeeSplitSources({ ...base, IMPORT_SWAP_FEE_ROUTER_56: ROUTER, IMPORT_FEE_VAULT_PAYERS_56: KYBER_ROUTER });
  assert.deepEqual(listed.payers, [KYBER_ROUTER.toLowerCase()], "an explicit payer list wins");
  assert.deepEqual(listed.feeRouters, [], "a router that is not a payer attributes nothing");

  const testnet = { IMPORT_FEE_VAULT_97: VAULT, IMPORT_FEE_VAULT_START_BLOCK_97: "200", IMPORT_FEE_VAULT_46630: VAULT, IMPORT_FEE_VAULT_START_BLOCK_46630: "300" };
  const noRouter = importSwapFeeSplitSources(testnet);
  assert.deepEqual(noRouter, [], "no Kyber / Universal Router on the testnets: no payer, no source");
  const withRouters = importSwapFeeSplitSources({ ...testnet, IMPORT_SWAP_FEE_ROUTER_97: ROUTER, IMPORT_SWAP_FEE_ROUTER_46630: OTHER });
  const bsc = withRouters.find((s) => s.chainId === 97);
  assert.deepEqual(bsc.payers, [ROUTER]);
  assert.deepEqual(bsc.feeRouters, [ROUTER]);
  assert.equal(bsc.asset, "BNB");
  assert.equal(bsc.startBlock, 200);
  assert.equal(bsc.split, true);
  assert.equal(bsc.maxRange, 5000);
  assert.equal(bsc.confirmations, 15);
  const rh = withRouters.find((s) => s.chainId === 46630);
  assert.equal(rh.asset, "ETH");
  assert.equal(rh.maxRange, 500000);
  assert.equal(rh.confirmations, 20);
  assert.deepEqual(importSwapFeeRouters(97, { IMPORT_SWAP_FEE_ROUTER_97: "junk" }), []);
});

test("testnet sources have no old receiver and their rows never reach finance", () => {
  const sources = importSwapFeeSources({});
  assert.equal(sources[97].receiver, null);
  assert.equal(sources[46630].receiver, null);
  assert.equal(sources[97].testnet, true);
  assert.deepEqual(feeRoutingAllNetworks().map((n) => n.chainId).sort((a, b) => a - b), [56, 101, 4663], "finance runs per mainnet only");
  assert.match(LANE_QUERIES.import_swaps, /f\.chain_id = \$1/);
  assert.match(LANE_QUERIES.import_swaps_expired, /c\.chain_id = \$1/);
});

function depositLog({ from, amount, logIndex, tx = "0xaa" }) {
  const encoded = vaultIface.encodeEventLog("Deposit", [from, amount, 10n ** 18n]);
  return { address: VAULT, topics: encoded.topics, data: encoded.data, logIndex: `0x${logIndex.toString(16)}`, transactionHash: tx, blockNumber: "0x64", removed: false };
}

function importSwapLog({ router = ROUTER, trader = TRADER, token = TOKEN, isBuy, gross, feeProtocol, feeCreator = 0n, tokenAmount = 123n, logIndex }) {
  const encoded = routerIface.encodeEventLog("ImportSwap", [trader, token, 2, isBuy, gross, feeProtocol, feeCreator, tokenAmount, trader]);
  return { address: router, topics: encoded.topics, data: encoded.data, logIndex: `0x${logIndex.toString(16)}` };
}

test("attribution: the router's own ImportSwap after the Deposit, matched on the fee amount", () => {
  const dep = depositLog({ from: ROUTER, amount: 500n, logIndex: 4 });
  const buy = importSwapLog({ isBuy: true, gross: 50_000n, feeProtocol: 500n, logIndex: 5 });
  assert.deepEqual(importSwapRouterAttribution({ logs: [dep, buy] }, ROUTER, dep, 500n), { wallet: TRADER, token: TOKEN, side: "buy" });
  const sell = importSwapLog({ isBuy: false, gross: 50_000n, feeProtocol: 500n, logIndex: 5 });
  assert.equal(importSwapRouterAttribution({ logs: [sell, dep] }, ROUTER, dep, 500n).side, "sell", "receipt order does not matter");
  // Not ours: another emitter, an event before the Deposit, a different fee.
  const foreign = importSwapLog({ router: OTHER, isBuy: true, gross: 50_000n, feeProtocol: 500n, logIndex: 5 });
  assert.deepEqual(importSwapRouterAttribution({ logs: [dep, foreign] }, ROUTER, dep, 500n), { wallet: null, token: null, side: null });
  const earlier = importSwapLog({ isBuy: true, gross: 50_000n, feeProtocol: 500n, logIndex: 3 });
  assert.deepEqual(importSwapRouterAttribution({ logs: [earlier, dep] }, ROUTER, dep, 500n), { wallet: null, token: null, side: null });
  const otherFee = importSwapLog({ isBuy: true, gross: 50_000n, feeProtocol: 501n, logIndex: 5 });
  assert.deepEqual(importSwapRouterAttribution({ logs: [dep, otherFee] }, ROUTER, dep, 500n), { wallet: null, token: null, side: null });
  // Two receivers on the vault (creatorBps > 0): both Deposits map to the one event.
  const p = depositLog({ from: ROUTER, amount: 250n, logIndex: 4 });
  const c = depositLog({ from: ROUTER, amount: 240n, logIndex: 5 });
  const both = importSwapLog({ isBuy: true, gross: 49_000n, feeProtocol: 250n, feeCreator: 240n, logIndex: 6 });
  assert.equal(importSwapRouterAttribution({ logs: [p, c, both] }, ROUTER, p, 250n).token, TOKEN);
  assert.equal(importSwapRouterAttribution({ logs: [p, c, both] }, ROUTER, c, 240n).token, TOKEN);
});

test("scan: router rows take wallet / token / side from ImportSwap; Kyber rows keep the receipt heuristic", async () => {
  const [source] = importSwapFeeSplitSources({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_FEE_VAULT_START_BLOCK_56: "100", IMPORT_SWAP_FEE_ROUTER_56: ROUTER });
  const kyber = KYBER_ROUTER.toLowerCase();
  // tx 0xaa: a relayer contract calls the router for TRADER; two swaps in one tx (sell of TOKEN_B, then buy of TOKEN).
  const routerReceipt = {
    logs: [
      depositLog({ from: ROUTER, amount: 300n, logIndex: 1 }),
      importSwapLog({ token: TOKEN_B, isBuy: false, gross: 30_000n, feeProtocol: 300n, logIndex: 2 }),
      depositLog({ from: ROUTER, amount: 500n, logIndex: 7 }),
      importSwapLog({ token: TOKEN, isBuy: true, gross: 50_000n, feeProtocol: 500n, logIndex: 8 }),
    ],
  };
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const kyberReceipt = { logs: [depositLog({ from: kyber, amount: 1000n, logIndex: 3, tx: "0xbb" }), { address: TOKEN, topics: [TRANSFER, pad(kyber), pad(TRADER)], data: "0x", logIndex: "0x4" }] };
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return "0x80";
    if (method === "eth_getLogs") {
      assert.deepEqual(params[0].topics[1], [kyber, ROUTER].map(pad), "OR-list incl. the router");
      return [routerReceipt.logs[0], routerReceipt.logs[2], { ...kyberReceipt.logs[0] }];
    }
    if (method === "eth_getTransactionByHash") return { from: params[0] === "0xaa" ? RELAYER : TRADER };
    if (method === "eth_getTransactionReceipt") return params[0] === "0xaa" ? routerReceipt : kyberReceipt;
    if (method === "eth_getBlockByNumber") return { timestamp: "0x6700" };
    throw new Error(method);
  };
  const out = await scanEvmImportSwapFees({ source, rpc, fromBlock: null });
  assert.equal(out.rows.length, 3);
  const [sellRow, buyRow, kyberRow] = out.rows;
  assert.deepEqual([sellRow.wallet, sellRow.tokenAddress, sellRow.side, sellRow.feeRaw, sellRow.router], [TRADER, TOKEN_B, "sell", "300", ROUTER]);
  assert.deepEqual([buyRow.wallet, buyRow.tokenAddress, buyRow.side, buyRow.feeRaw, buyRow.logIndex], [TRADER, TOKEN, "buy", "500", 7]);
  assert.equal(buyRow.wallet, TRADER, "the trader from the event, not the relayer that sent the tx");
  assert.deepEqual([kyberRow.wallet, kyberRow.tokenAddress, kyberRow.side, kyberRow.router], [TRADER, TOKEN, "buy", kyber]);
});

test("ingest on a testnet: no old receiver scanned; only the split source, from its own cursor", async () => {
  const reads = [];
  const db = { query: async (sql) => { reads.push(sql.trim()); return { rows: [] }; } };
  const rpc = async (method) => (method === "eth_blockNumber" ? "0x1000" : []);
  const none = await ingestImportSwapFees({ db, chainId: 97, env: {}, dryRun: true, rpc });
  assert.equal(none.split, undefined);
  assert.equal(none.found, 0);
  assert.equal(reads.length, 0, "the old cursor table is never read for a testnet");
  const env = { IMPORT_FEE_VAULT_97: VAULT, IMPORT_FEE_VAULT_START_BLOCK_97: "200", IMPORT_SWAP_FEE_ROUTER_97: ROUTER };
  const one = await ingestImportSwapFees({ db, chainId: 97, env, dryRun: true, rpc });
  assert.equal(one.split.length, 1);
  assert.equal(one.split[0].receiver, VAULT);
  assert.ok(reads.every((sql) => /finance_import_swap_fee_receiver_cursors/.test(sql)));
});

// Run: npx tsx --tsconfig tsconfig.app.json --test src/lib/chart/normalizeTradeFeeFree.test.ts (tsx resolves the @/ alias).
// An indexer /trades row for RH 0xe35a trade 2 (production): price_bnb is the fill, gross_raw the fee-free amount.
import assert from "node:assert/strict";
import test from "node:test";
import { indexerRowToCurvePoint, marketTradeToCurvePoint } from "./normalizeTrade.ts";

const CAMPAIGN = "0xe35aea83ccc7efd0604edc5dfd0962d9f6b7de60";
const ROW = {
  tx_hash: "0xc4f147fc9d8c5ddb94f0ebf5a91d9c65da3dec07093f88709b441ee39fdfb6ff",
  log_index: 12,
  block_number: "85052355",
  block_time: "2026-10-10T14:01:57.000Z",
  side: "buy",
  wallet: "0x00000000000000000000000000000000000000b1",
  token_amount_raw: "267967622812168189246132",
  bnb_amount_raw: "94225163475931",
  token_amount: "267967.622812168189246132",
  bnb_amount: "0.000094225163475931",
  price_bnb: "0.00000000035162891131059547",
  sold_tokens_after_raw: null,
  gross_raw: "78783581501615",
  fee_raw: "15441581974316",
};

test("an EVM indexer row keeps the fill as pricePerToken and adds gross_raw / tokens as the fee-free price", () => {
  const point = indexerRowToCurvePoint(ROW, 4663, CAMPAIGN);
  assert.ok(point);
  assert.equal(point.pricePerToken, 3.5162891131059547e-10);
  assert.ok(point.feeFreePricePerToken != null && Math.abs(point.feeFreePricePerToken - 2.94004106e-10) < 1e-18);
});

test("rows without gross_raw (older generations, other payloads) have no fee-free price", () => {
  const { gross_raw: _g, fee_raw: _f, ...legacy } = ROW;
  assert.equal(indexerRowToCurvePoint(legacy, 4663, CAMPAIGN)?.feeFreePricePerToken, null);
});

test("Solana rows never get a fee-free price from gross_raw", () => {
  const solana = {
    ...ROW,
    tx_hash: "5".repeat(88),
    wallet: "So11111111111111111111111111111111111111112",
  };
  const point = indexerRowToCurvePoint(solana, 101, "So11111111111111111111111111111111111111112");
  assert.equal(point?.feeFreePricePerToken, null);
});

test("market-trade rows that carry grossRaw get the same fee-free price", () => {
  const point = marketTradeToCurvePoint(
    {
      txHash: ROW.tx_hash,
      logIndex: 12,
      blockNumber: 85052355,
      blockTime: ROW.block_time,
      side: "buy",
      wallet: ROW.wallet,
      tokenAmountRaw: ROW.token_amount_raw,
      nativeAmountRaw: ROW.bnb_amount_raw,
      priceBnb: ROW.price_bnb,
      grossRaw: ROW.gross_raw,
    } as any,
    4663,
  );
  assert.ok(point?.feeFreePricePerToken != null && Math.abs(point.feeFreePricePerToken - 2.94004106e-10) < 1e-18);
});

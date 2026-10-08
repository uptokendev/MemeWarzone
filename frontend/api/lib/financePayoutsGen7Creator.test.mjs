// Creator fees on Payouts with gen-7's own CreatorRewardsVaultV2 (founder decision 2026-10-08): a coin is in exactly
// one V2 vault, so per coin earned / paid / claimable come from its own vault, and the owed total adds both vaults.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPayouts } from "./financePayouts.js";

const NOW = "2026-10-08T12:00:00.000Z";
const V6 = "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66";
const V7 = "0x2222222222222222222222222222222222222222";
const C6 = "0x00000000000000000000000000000000000006c1";
const C7 = "0x00000000000000000000000000000000000007c1";
const BNB = { chainId: 56, chain: "bnb", environment: "mainnet", nativeSymbol: "BNB", nativeDecimals: 18 };

const prices = {
  async valueAtSpot() { return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null }; },
  async valueEvents() { return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null }; },
  async spotTable(assets) { return assets.map((asset) => ({ asset, priceUsd: null, source: "test", at: NOW })); },
};
const bal = (raw) => [{ asset: "BNB", decimals: 18, raw, amount: String(Number(raw) / 1e18), status: "ok", source: "rpc:test", asOf: NOW, amountUsd: null }];
function feeRouting({ gen7 }) {
  const d = (id, address, raw) => ({ id, label: id, address, flags: [], balances: bal(raw) });
  return {
    destinations: [
      d("creator_vault_v2", V6, "300"),
      ...(gen7 ? [d("creator_vault_v2_gen7", V7, "200")] : []),
      d("creator_vault_v1", "0x72A963682B261195EB43F8f75e0515ab279EbD14", "0"),
    ],
    wiring: [],
  };
}

const ev = (vault, campaign, event_name, args, tx) => ({ contract_address: vault.toLowerCase(), campaign_address: campaign, event_name, args, tx_hash: tx, log_index: 0, block_time: "2026-10-07T00:00:00Z" });
function db() {
  return {
    async query(sql, params) {
      if (/from public\.campaigns\s+where chain_id = \$1 and campaign_address is not null/.test(sql)) {
        return { rows: [{ campaign_address: C6, token_address: null, name: "Six", symbol: "SIX", test_coin: false }, { campaign_address: C7, token_address: null, name: "Seven", symbol: "SVN", test_coin: false }] };
      }
      if (/contract_kind = 'creator_vault'/.test(sql)) {
        return { rows: [
          ev(V6, C6, "TradeFeeAccrued", { campaign: C6, amount: "100", toCreator: "100", toHolders: "0", toBuyback: "0" }, "0x61"),
          ev(V7, C7, "TradeFeeAccrued", { campaign: C7, amount: "50", toCreator: "50", toHolders: "0", toBuyback: "0" }, "0x71"),
          ev(V7, C7, "CreatorFeesClaimed", { campaign: C7, creator: "0x00000000000000000000000000000000000000e1", amount: "20" }, "0x72"),
        ] };
      }
      if (/from public\.indexer_state where chain_id = \$1 and cursor = \$2/.test(sql)) return { rows: [{ last_indexed_block: "9", updated_at: NOW }] };
      return { rows: [] };
    },
  };
}

function readers(calls) {
  return {
    async readEvmCall() { return { hex: `0x${(10_000n * 10n ** 18n).toString(16)}`, rpc: "test" }; },
    async readEvmNative() { return { raw: "0", rpc: "test" }; },
    async readEvmCreatorV2Logs(_ctx, args) { calls.logs.push(args); return { rows: [], complete: true, head: 10, scannedTo: 10 }; },
    async readEvmCreatorCoins(_ctx, { v1, v2, campaigns }) {
      calls.coins.push({ v1, v2 });
      return campaigns.map((campaign) => ({
        campaign,
        v1: v1 ? { earnedRaw: "0", claimedRaw: "0", claimableRaw: "0" } : null,
        v2: { claimableRaw: v2 === V6 && campaign === C6 ? "80" : v2 === V7 && campaign === C7 ? "30" : "0" },
      }));
    },
  };
}

test("gen-7 vault: per-coin figures from the coin's own vault, owed adds both vaults, its logs read from its deploy block", async () => {
  const calls = { logs: [], coins: [] };
  const out = await buildPayouts({
    network: BNB, days: 30, db: db(), env: { EVM_GEN7_CREATOR_VAULT_56: `${V7}@130000001` }, feeRouting: feeRouting({ gen7: true }),
    readers: readers(calls), prices, now: () => NOW,
  });
  const creator = out.types.find((t) => t.id === "creator_fees");
  assert.deepEqual(calls.coins.map((c) => c.v2), [V6, V7]);
  assert.deepEqual(calls.logs.map((l) => l.fromBlock ?? null), [null, 130000001]);
  const row = (c) => creator.creatorFees.coins.find((x) => x.campaignAddress === c);
  assert.deepEqual([row(C6).earned.raw, row(C6).paid.raw, row(C6).claimable.raw], ["100", "0", "80"]);
  assert.deepEqual([row(C7).earned.raw, row(C7).paid.raw, row(C7).claimable.raw], ["50", "20", "30"]);
  assert.equal(row(C7).paid.count, 1);
  assert.deepEqual(creator.vaults.map((v) => v.id), ["creator_vault_v2", "creator_vault_v2_gen7", "creator_vault_v1"]);
  assert.equal(creator.owed.total.raw, "500");
  assert.match(creator.owed.note, /these three vaults/);
});

test("no gen-7 vault: one V2 vault read as before, two vaults owed", async () => {
  const calls = { logs: [], coins: [] };
  const out = await buildPayouts({ network: BNB, days: 30, db: db(), env: {}, feeRouting: feeRouting({ gen7: false }), readers: readers(calls), prices, now: () => NOW });
  const creator = out.types.find((t) => t.id === "creator_fees");
  assert.deepEqual(calls.coins.map((c) => c.v2), [V6]);
  assert.equal(calls.logs.length, 1);
  assert.deepEqual(creator.vaults.map((v) => v.id), ["creator_vault_v2", "creator_vault_v1"]);
  assert.equal(creator.owed.total.raw, "300");
  assert.match(creator.owed.note, /these two vaults/);
});

test("gen-7 vault without a deploy block: its claims come from the indexer, with a note", async () => {
  const calls = { logs: [], coins: [] };
  const out = await buildPayouts({ network: BNB, days: 30, db: db(), env: { EVM_GEN7_CREATOR_VAULT_56: V7 }, feeRouting: feeRouting({ gen7: true }), readers: readers(calls), prices, now: () => NOW });
  const creator = out.types.find((t) => t.id === "creator_fees");
  assert.equal(calls.logs.length, 1, "no chain log read without a start block");
  assert.ok(creator.notes.some((n) => /Gen-7 CreatorRewardsVaultV2 logs could not be read/.test(n)));
  assert.equal(creator.creatorFees.coins.find((x) => x.campaignAddress === C7).paid.raw, "20");
});

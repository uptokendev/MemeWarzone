import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

import { buildPayouts } from "./financePayouts.js";
import {
  ARENA_CLAIM_RECEIPT_DISCRIMINATOR,
  clearArenaPayoutsCache,
  decodeClaimReceipt,
  decodeEvmPool,
  deriveSolanaArenaAccounts,
  normalizeSolanaPool,
  poolIdFor,
  poolMoney,
  splitPool,
  summarizePools,
} from "./financePayoutsArena.js";
import { parseArenaPool } from "../../src/lib/solanaArenaLayout.mjs";

const NOW = "2026-10-05T12:00:00.000Z";
const PROGRAM = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const VAULT_RENT = 695960;

// Real mainnet accounts read on 2026-10-05 (getMultipleAccounts, base64): the
// pool account, its vault and the winner / protocol / MWL claim receipts.
// arena-mugwhj11: resolved, everything claimed. arena-muoo3g87: resolved,
// protocol and MWL claimed, the winner's 1.437304278 SOL not claimed yet.
const MAINNET = {
  "arena-mugwhj11-9b1973": {
    "pool": "GN4v7G8tQdT5zGASzomkr2ACLsxfCa66FijuShU9xxw3",
    "vault": "BFcDRAfXZ58oauiHb3ko12ctPQVGe7QW5EdPuF9aBd32",
    "receipts": [
      "DeDrL6NLeij2qTUDrZCq6fjRhgKkfgnrzrQNinhw6n2T",
      "EbvCy9yY21a9Wy75mwQEKRiZrBZRqZiFePJqEToqifNm",
      "AjkQrfobE3THddWbi6e2C93PWWPtcM4z4Xke4VnCFQrd"
    ],
    "accounts": [
      {
        "lamports": 4526280,
        "data": "x5tvWvKIaQjG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twACHM6WrsolAlhSUk1CpPB++bFh9n5ZhCMd7cZslOufeDNblDTchNmx2tcyyFY379lrH2XdEbhpTUKq+LPujTYQP2GJmN8Qmq7gqlS1qL1yMEpwBStqdqRvHKgE57CBD9v1m97mNhT1WfeM6r7RVNfoWdemTt6bh9HQ1lbahS9lpIGA8PoCAAAAAIDw+gIAAAAAgPD6AgAAAACA8PoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADKuHMCAAAAAKW6t2oAAAAApbq3agAAAAClXbpqAAAAAAEBAluUNNyE2bHa1zLIVjfv2WsfZd0RuGlNQqr4s+6NNhA/m97mNhT1WfeM6r7RVNfoWdemTt6bh9HQ1lbahS9lpIEZXMOblDulu1RrTGV3y6m1fBrap43Ap712uufvR7AeawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQEAAP//AQAAAAAAAAABW5Q03ITZsdrXMshWN+/Zax9l3RG4aU1Cqviz7o02ED8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAm97mNhT1WfeM6r7RVNfoWdemTt6bh9HQ1lbahS9lpIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
      },
      {
        "lamports": 695960,
        "data": "bq4ci2/0HLgA"
      },
      {
        "lamports": 1066800,
        "data": "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twCb3uY2FPVZ94zqvtFU1+hZ16ZO3puH0dDWVtqFL2Wkgd1brQYAAAAA/w=="
      },
      {
        "lamports": 1066800,
        "data": "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twGiQvtRL26GHZVluaVGJcE4zX0En0+zFgClIjcbUJ+jVe0QiwAAAAAA+w=="
      },
      {
        "lamports": 1066800,
        "data": "qRI34kwavhTG6H+7cVFZCCvvbGgukmgQrEfm2JPIzFzUywyS7ba4twIFr3UcbxFPfI98EH6BGLq8/G1XNCIlxZMlAnma6eEdSAAtMQEAAAAA/w=="
      }
    ]
  },
  "arena-muoo3g87-1efbe9": {
    "pool": "DSNtEoM791A7Y3DqsPMX9cXyUHX3d5iNwNcWvtxgjzUF",
    "vault": "DXCgxr5UHjTdDzFjZVUpyYnf59EvEsMmdrQ9drFkdpoR",
    "receipts": [
      "E4xzpFKKGFdReKDuQZtMjabUgMxvjGmt3aSWmCYLBCs",
      "2K6D4WwrsA6ePHPWPifyUhzRWRcgt7PdPr1bT5EJaADn",
      "B2AcYFNbFxQapDbESZoUC5YrbWcVEZesq63yq11CSp4Y"
    ],
    "accounts": [
      {
        "lamports": 4526280,
        "data": "x5tvWvKIaQggr27+C/mpVwMJYWmaxAG1NCDo8saM2kpwXJyFuMC7ygACHM6WrsolAlhSUk1CpPB++bFh9n5ZhCMd7cZslOufeDPhPdEdG8avguyaX6UTo2sn+C9J7W8tJXPwlWWOHOeiD2GJmN8Qmq7gqlS1qL1yMEpwBStqdqRvHKgE57CBD9v11Bh8gPtwGcFKIwJgHWC+b4Ew0LBDl1WXQLcaBfV/OmQAwusLAAAAAADC6wsAAAAAAMLrCwAAAAAAwusLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB7GFJLAAAAAJI7v2oAAAAAkju/agAAAACS3sFqAAAAAAEBARzOlq7KJQJYUlJNQqTwfvmxYfZ+WYQjHe3GbJTrn3gzYYmY3xCaruCqVLWovXIwSnAFK2p2pG8cqATnsIEP2/WMN6Gr3Epx/G5IhCTZSuAQO48G1brfo6SAPc7L9waO3wDWhatVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAP//AQAAAAAAAAABHM6WrsolAlhSUk1CpPB++bFh9n5ZhCMd7cZslOufeDMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYYmY3xCaruCqVLWovXIwSnAFK2p2pG8cqATnsIEP2/UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1oWrVQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
      },
      {
        "lamports": 1438000238,
        "data": "bq4ci2/0HLgA"
      },
      null,
      {
        "lamports": 1066800,
        "data": "qRI34kwavhQgr27+C/mpVwMJYWmaxAG1NCDo8saM2kpwXJyFuMC7ygGiQvtRL26GHZVluaVGJcE4zX0En0+zFgClIjcbUJ+jVaViuQgAAAAA/A=="
      },
      {
        "lamports": 1066800,
        "data": "qRI34kwavhQgr27+C/mpVwMJYWmaxAG1NCDo8saM2kpwXJyFuMC7ygIFr3UcbxFPfI98EH6BGLq8/G1XNCIlxZMlAnma6eEdSAC0xAQAAAAA+A=="
      }
    ]
  }
};

const CLAIM_TX = "5tSmpCDrgJLQgaPPeRHBSTZAbeeVYY4yyZV3ZbiWLNhZqgXo2AoRfdoSXvZgCpqWDg99jnZkqtDDAbKQQPJiKnS9";
const CLAIM_TIME = 1790545015; // 2026-09-27T21:36:55Z

function bytes(b64) {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function decodedPool(id) {
  return normalizeSolanaPool(parseArenaPool(bytes(MAINNET[id].accounts[0].data), PublicKey));
}

// ---------------------------------------------------------------------------
// Decode and money math on real accounts

test("PDAs and pool ids match the accounts read on mainnet", () => {
  for (const id of Object.keys(MAINNET)) {
    const d = deriveSolanaArenaAccounts(poolIdFor({ kind: "battle", id }));
    assert.equal(d.pool, MAINNET[id].pool);
    assert.equal(d.vault, MAINNET[id].vault);
    assert.deepEqual([0, 1, 2].map((b) => d.claim(b)), MAINNET[id].receipts);
  }
});

test("resolved pool with the prize unclaimed: owed = pending winner, vault holds exactly that", () => {
  const pool = decodedPool("arena-muoo3g87-1efbe9");
  assert.equal(pool.state, "resolved");
  assert.equal(pool.winnerSide, "a");
  assert.equal(pool.winnerWallet, "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv");
  assert.equal(pool.stakeA + pool.stakeB, 400_000_000n);
  assert.equal(pool.boosts, 1_263_671_419n);
  const m = poolMoney(pool);
  assert.equal(m.paidIn, 1_663_671_419n);
  assert.equal(m.prizePot, 1_437_304_278n);
  assert.equal(m.prizeOwed, 1_437_304_278n);
  assert.equal(m.prizeClaimed, 0n);
  assert.equal(m.protocolClaimed, 146_367_141n); // 5% of 0.4 + 10% of the boosts
  assert.equal(m.mwlClaimed, 80_000_000n); // 20% of 0.4
  assert.equal(m.protocolPending + m.mwlPending + m.held + m.refundsOwed, 0n);
  assert.equal(BigInt(MAINNET["arena-muoo3g87-1efbe9"].accounts[1].lamports) - BigInt(VAULT_RENT), m.obligations);
});

test("fully claimed pool: prize claimed equals the winner's claim receipt; receipts decode", () => {
  const pool = decodedPool("arena-mugwhj11-9b1973");
  const m = poolMoney(pool);
  assert.equal(m.prizePot, 112_024_541n);
  assert.equal(m.prizeClaimed, 112_024_541n);
  assert.equal(m.prizeOwed, 0n);
  assert.equal(m.obligations, 0n);
  const [winner, protocol, mwl] = MAINNET["arena-mugwhj11-9b1973"].accounts.slice(2).map((a) => decodeClaimReceipt(Buffer.from(a.data, "base64")));
  assert.deepEqual(Buffer.from(MAINNET["arena-mugwhj11-9b1973"].accounts[2].data, "base64").subarray(0, 8), ARENA_CLAIM_RECEIPT_DISCRIMINATOR);
  assert.equal(winner.bucket, 0);
  assert.equal(winner.recipient, "BVTKvynQ8VBJKKA2uau4FC4mNoTmkmb1t4h1y8gMv3Gk");
  assert.equal(winner.amount, m.prizeClaimed);
  assert.equal(protocol.bucket, 1);
  assert.equal(protocol.amount, m.protocolClaimed);
  assert.equal(mwl.bucket, 2);
  assert.equal(mwl.amount, m.mwlClaimed);
  assert.equal(decodeClaimReceipt(Buffer.from(MAINNET["arena-mugwhj11-9b1973"].accounts[1].data, "base64")), null);
});

test("split: prize + protocol + MWL always equals what went in (rounding goes to the prize)", () => {
  for (const [entries, boosts] of [[0n, 0n], [1n, 1n], [9_999n, 19n], [400_000_000n, 1_263_671_419n], [123_456_789_012n, 3n]]) {
    const s = splitPool({ entries, boosts });
    assert.equal(s.prize + s.protocol + s.mwl, entries + boosts);
  }
});

test("open and live pools are held, not owed; cancelled pools owe refunds of what is left", () => {
  const base = { stakeA: 50n, stakeB: 50n, support: 0n, buyIns: 0n, boosts: 10n, places: [] };
  assert.deepEqual([poolMoney({ ...base, state: "live" }).held, poolMoney({ ...base, state: "live" }).prizeOwed], [110n, 0n]);
  assert.equal(poolMoney({ ...base, state: "open", stakeB: 0n }).held, 60n);
  // Owner A already took the refund (its stake field is zeroed on chain); B and the booster have not.
  const c = poolMoney({ ...base, state: "cancelled", stakeA: 0n, refundedStakes: 50n });
  assert.equal(c.refundsOwed, 60n);
  assert.equal(c.paidIn, 110n);
  assert.equal(c.prizeOwed + c.held, 0n);
});

test("tournament places: unclaimed later places are owed; claimed first place is paid", () => {
  const m = poolMoney({
    state: "resolved", stakeA: 0n, stakeB: 0n, support: 0n, buyIns: 1_000n, boosts: 0n,
    pendingWinner: 0n, claimedWinner: true, pendingProtocol: 50n, claimedProtocol: false, pendingMwl: 200n, claimedMwl: false,
    places: [{ pending: 0n, claimed: true }, { pending: 225n, claimed: false }, { pending: 75n, claimed: true }],
  });
  assert.equal(m.prizePot, 750n);
  assert.equal(m.prizeOwed, 225n);
  assert.equal(m.prizeClaimed, 525n);
  assert.equal(m.protocolPending, 50n);
  assert.equal(m.obligations, 475n);
});

test("summary: an unreadable real pool makes the real totals unknown (null), never 0; test pools apart", () => {
  const live = { status: "live", testCoin: false, money: poolMoney({ state: "live", stakeA: 5n, stakeB: 5n, places: [] }) };
  const test = { status: "resolved", testCoin: true, money: poolMoney({ state: "resolved", stakeA: 100n, stakeB: 100n, pendingWinner: 150n, places: [{ pending: 150n, claimed: false }] }) };
  const ok = summarizePools([live, test]);
  assert.equal(ok.real.held, 10n);
  assert.equal(ok.real.prizeOwed, 0n);
  assert.equal(ok.test.prizeOwed, 150n);
  const bad = summarizePools([live, test, { status: "unknown", testCoin: false }]);
  assert.equal(bad.real.held, null);
  assert.equal(bad.all.obligations, null);
  assert.equal(bad.test.prizeOwed, 150n);
  assert.equal(bad.unknownReal, 1);
});

test("EVM pools(poolId): 21 words decode; never-opened pool is null; short return throws", () => {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addr = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const owner = "0x1111111111111111111111111111111111111111";
  const winner = "0x2222222222222222222222222222222222222222";
  const fields = [w(0), w(2), addr(owner), addr(winner), w(10n ** 17n), w(0), w(10n ** 17n), w(10n ** 17n), w(0), w(10n ** 16n), addr(winner), w(0), w(10n ** 16n), w(4n * 10n ** 16n), w(1), w(1790000000), w(1), w(0), w(1), w(0), w(0)];
  const pool = decodeEvmPool(`0x${fields.join("")}`);
  assert.equal(pool.state, "resolved");
  assert.equal(pool.boosts, 10n ** 16n);
  assert.equal(pool.claimedWinner, true);
  const m = poolMoney(pool);
  assert.equal(m.prizePot, 15n * 10n ** 16n + 9n * 10n ** 15n);
  assert.equal(m.prizeClaimed, m.prizePot);
  assert.equal(m.protocolPending, 10n ** 16n);
  assert.equal(m.mwlClaimed, 4n * 10n ** 16n);
  assert.equal(decodeEvmPool(`0x${"0".repeat(64 * 21)}`), null);
  assert.throws(() => decodeEvmPool("0x"), /21/);
});

// ---------------------------------------------------------------------------
// Full payout type through buildPayouts, with a fake database and a fake RPC

function priceService() {
  return {
    async valueAtSpot(_a, amount) { return { amountUsd: amount == null ? null : Number(amount) * 100, priceUsd: 100, priceSource: "test", priceAt: NOW, priceBasis: "current" }; },
    async valueEvents(_a, buckets, decimals) { return { amountUsd: buckets.reduce((s, b) => s + Number(b.raw) / 10 ** decimals, 0) * 100, priceUsd: 100, priceSource: "test", priceAt: NOW, priceBasis: "event_time" }; },
    async spotTable(assets) { return assets.map((asset) => ({ asset, priceUsd: 100, source: "test", at: NOW })); },
  };
}

function fakeDb(subjects, recorded = []) {
  return {
    async query(sql) {
      if (/'battle' as kind/.test(sql)) return { rows: subjects };
      if (/'deposit' as source/.test(sql)) return { rows: recorded };
      return { rows: [] };
    },
  };
}

function fakeSolanaRpc({ fail = false } = {}) {
  const accounts = new Map();
  for (const v of Object.values(MAINNET)) {
    [v.pool, v.vault, ...v.receipts].forEach((key, i) => {
      const a = v.accounts[i];
      if (a) accounts.set(key, { lamports: a.lamports, owner: PROGRAM, data: [a.data, "base64"], executable: false });
    });
  }
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (fail && method === "getMultipleAccounts") return { ok: false, status: 503, json: async () => ({}) };
    let result;
    if (method === "getMinimumBalanceForRentExemption") result = VAULT_RENT;
    else if (method === "getMultipleAccounts") result = { value: params[0].map((k) => accounts.get(k) || null) };
    else if (method === "getSignaturesForAddress") result = params[0] === MAINNET["arena-mugwhj11-9b1973"].receipts[0] ? [{ signature: CLAIM_TX, blockTime: CLAIM_TIME, err: null }] : [];
    else throw new Error(`unexpected ${method}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { fetchImpl, calls };
}

const SOLANA = { chainId: 101, chain: "solana", environment: "production", cluster: "mainnet-beta", nativeSymbol: "SOL", nativeDecimals: 9 };
const SUBJECTS = [
  { kind: "battle", id: "arena-muoo3g87-1efbe9", chain_id: 101, app_state: "finished", created_at: "2026-09-30T22:19:00Z", test_coin: false },
  { kind: "battle", id: "arena-muhe0ykg-3254c5", chain_id: 101, app_state: "expired", created_at: "2026-09-25T20:02:44Z", test_coin: false },
  { kind: "battle", id: "arena-mugwhj11-9b1973", chain_id: 101, app_state: "finished", created_at: "2026-09-25T11:51:44Z", test_coin: false },
];

async function arenaFor(subjects, rpc, recorded) {
  clearArenaPayoutsCache();
  const out = await buildPayouts({
    network: SOLANA, days: 30, db: fakeDb(subjects, recorded), env: { SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://rpc.test" },
    fetchImpl: rpc.fetchImpl, feeRouting: { destinations: [], wiring: [] },
    readers: { readSolanaAccountData: async () => { throw new Error("offline"); }, readSolanaCreatorClaimable: async () => ({ status: "ok", raw: "0", coins: 0, coinsWithFees: 0 }) },
    prices: priceService(), now: () => NOW,
  });
  return out.types.find((t) => t.id === "arena_prizes");
}

test("Solana: paid, owed, held and cover come from the pool accounts; the claim has its transaction", async () => {
  const t = await arenaFor(SUBJECTS, fakeSolanaRpc(), [{ source: "deposit", ref: "0x20af6efe0bf9a957030961699ac401b53420e8f2c68cda4a705c9c85b8c0bbca", purpose: "stake", n: 2, raw: "400000000" }, { source: "deposit", ref: "0xc6e87fbb715159082bef6c682e926810ac47e6d893c8cc5cd4cb0c92edb6b8b7", purpose: "stake", n: 1, raw: "50000000" }]);
  assert.equal(t.owed.known, true);
  assert.equal(t.owed.total.amount, "1.437304278");
  assert.equal(t.paid.allTime.amount, "0.112024541");
  assert.equal(t.paid.period.amount, "0.112024541");
  assert.equal(t.paid.lastPayout.txUrl, `https://solscan.io/tx/${CLAIM_TX}`);
  assert.equal(t.paid.lastPayout.at, "2026-09-27T21:36:55.000Z");
  assert.equal(t.paidIn.allTime.amount, "1.804809797");
  assert.equal(t.coverage.status, "covered");
  assert.equal(t.coverage.vaultAmount, "1.437304278");
  assert.equal(t.arena.counts.resolved, 2);
  assert.equal(t.arena.counts.not_opened, 1);
  assert.equal(t.arena.totals.protocolClaimed, "0.155480978");
  assert.equal(t.arena.totals.mwlClaimed, "0.1");
  assert.equal(t.arena.totals.held, "0");
  const expired = t.arena.pools.find((p) => p.id === "arena-muhe0ykg-3254c5");
  assert.equal(expired.status, "not_opened");
  assert.equal(expired.staked, null);
  // The deposit table missed one 0.05 SOL stake; the chain figure is used and the gap is named.
  assert.ok(t.notes.some((n) => /records 0.45 SOL of stakes; the pools hold 0.5 SOL/.test(n)));
  assert.equal(t.arena.pools.find((p) => p.id === "arena-mugwhj11-9b1973").recorded.stakes, "0.05");
});

test("Solana: a test-coin battle is left out of paid, owed and paid in, but still counted for cover", async () => {
  const subjects = SUBJECTS.map((s) => (s.id === "arena-muoo3g87-1efbe9" ? { ...s, test_coin: true } : s));
  const t = await arenaFor(subjects, fakeSolanaRpc());
  assert.equal(t.owed.total.amount, "0");
  assert.equal(t.owed.testCoins.amount, "1.437304278");
  assert.equal(t.paidIn.allTime.amount, "0.141138378");
  assert.equal(t.coverage.owedAmount, "1.437304278");
  assert.equal(t.coverage.status, "covered");
});

test("Solana: pools that cannot be read are unknown, never 0", async () => {
  const t = await arenaFor(SUBJECTS, fakeSolanaRpc({ fail: true }));
  assert.equal(t.owed.known, false);
  assert.equal(t.owed.total.amount, null);
  assert.equal(t.paidIn.allTime.amount, null);
  assert.equal(t.coverage.status, "unknown");
  assert.equal(t.vaults[0].balance.status, "unknown");
  assert.equal(t.arena.totals.prizeOwed, null);
  assert.ok(t.arena.pools.every((p) => p.status === "unknown" && p.prizeOwed === null));
  assert.ok(t.warnings.some((w) => /could not be read/.test(w.message)));
});

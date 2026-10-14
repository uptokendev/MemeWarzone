import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { escrowPairKey, prefetchEscrowAccounts } from "../solanaFeeEscrowPrefetch.js";

function rowsOf(n: number, withEscrow = true) {
  return Array.from({ length: n }, () => ({
    campaign_address: Keypair.generate().publicKey.toBase58(),
    escrow_address: withEscrow ? Keypair.generate().publicKey.toBase58() : null,
  }));
}

/** Fake connection: each account's data is its own address, so pairing errors show. */
function fakeConnection(opts: { failOnCall?: number; missing?: Set<string> } = {}) {
  const calls: PublicKey[][] = [];
  return {
    calls,
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.push(keys);
      if (opts.failOnCall === calls.length) throw new Error("429 Too Many Requests");
      return keys.map((key) =>
        opts.missing?.has(key.toBase58())
          ? null
          : { data: Buffer.from(key.toBase58()), owner: key, lamports: 1, executable: false, rentEpoch: 0 },
      );
    },
  };
}

const neverDerive = () => {
  throw new Error("escrow_address is set; derive must not be called");
};

test("25 rows (the normal flush lane) cost one call instead of 25", async () => {
  const rows = rowsOf(25);
  const conn = fakeConnection();
  const map = await prefetchEscrowAccounts(conn as any, rows, neverDerive);
  assert.equal(conn.calls.length, 1);
  assert.equal(conn.calls[0].length, 50);
  for (const row of rows) {
    const escrow = new PublicKey(String(row.escrow_address));
    const campaign = new PublicKey(row.campaign_address);
    const [escrowInfo, campaignInfo] = map!.get(escrowPairKey(escrow, campaign))!;
    assert.equal(escrowInfo!.data.toString(), escrow.toBase58());
    assert.equal(campaignInfo!.data.toString(), campaign.toBase58());
  }
});

test("100 rows (the reconcile pass) cost two calls of at most 100 keys", async () => {
  const conn = fakeConnection();
  const map = await prefetchEscrowAccounts(conn as any, rowsOf(100), neverDerive);
  assert.deepEqual(conn.calls.map((c) => c.length), [100, 100]);
  assert.equal(map!.size, 100);
});

test("a missing account stays null in its own slot", async () => {
  const rows = rowsOf(3);
  const missing = new Set([String(rows[1].escrow_address)]);
  const map = await prefetchEscrowAccounts(fakeConnection({ missing }) as any, rows, neverDerive);
  const pair = map!.get(escrowPairKey(new PublicKey(String(rows[1].escrow_address)), new PublicKey(rows[1].campaign_address)))!;
  assert.equal(pair[0], null);
  assert.equal(pair[1]!.data.toString(), rows[1].campaign_address);
});

test("rows without escrow_address use the derived escrow", async () => {
  const rows = rowsOf(2, false);
  const derived = new Map(rows.map((r) => [r.campaign_address, Keypair.generate().publicKey.toBase58()]));
  const conn = fakeConnection();
  const map = await prefetchEscrowAccounts(conn as any, rows, (campaign) => derived.get(campaign)!);
  for (const row of rows) {
    assert.ok(map!.has(escrowPairKey(new PublicKey(derived.get(row.campaign_address)!), new PublicKey(row.campaign_address))));
  }
});

test("any failed batch returns null so the worker reads per row as before", async () => {
  const conn = fakeConnection({ failOnCall: 2 });
  assert.equal(await prefetchEscrowAccounts(conn as any, rowsOf(60), neverDerive), null);
});

test("no rows, no RPC", async () => {
  const conn = fakeConnection();
  const map = await prefetchEscrowAccounts(conn as any, [], neverDerive);
  assert.equal(conn.calls.length, 0);
  assert.equal(map!.size, 0);
});

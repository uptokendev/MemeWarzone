import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ARENA_BUYIN_DISCRIMINATOR,
  ARENA_CONFIG_DISCRIMINATOR,
  ARENA_POOL_ACCOUNT_SIZE,
  ARENA_POOL_DISCRIMINATOR,
  REWARDS_TREASURY_PROGRAM_ID,
  parseArenaPool,
  isSolanaWarzoneChainId,
  isSolanaWarzoneMoneyLive,
  parseArenaConfig,
  poolIdToBytes,
  stakeToLamports,
  validateCanonicalArenaConfig,
  verifyAuthoritativeBuyInReceipt,
  walletsEqual,
} from "./solanaArenaLayout.mjs";

test("stakeToLamports uses 9 decimals not 18", () => {
  assert.equal(stakeToLamports(0.1), 100_000_000n);
  assert.notEqual(stakeToLamports(0.1).toString(), "100000000000000000");
});

test("walletsEqual is case-sensitive", () => {
  assert.equal(walletsEqual("AbcDefGhijk", "AbcDefGhijk"), true);
  assert.equal(walletsEqual("AbcDefGhijk", "abcdefghijk"), false);
});

test("poolIdToBytes rejects short ids", () => {
  assert.throws(() => poolIdToBytes("0x1234"));
});

function writeU64le(data, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

test("parseArenaPool requires the full V2 tail and never defaults actionNonce to 0", () => {
  const data = new Uint8Array(ARENA_POOL_ACCOUNT_SIZE);
  data.set(ARENA_POOL_DISCRIMINATOR, 0);
  writeU64le(data, 393, 7n);
  const parsed = parseArenaPool(data, PublicKey);
  assert.equal(parsed.actionNonce, 7n);

  assert.equal(parseArenaPool(data.subarray(0, 393), PublicKey), null);
  assert.equal(parseArenaPool(data.subarray(0, 400), PublicKey), null);
  assert.equal(parseArenaPool(data.subarray(0, 8 + 385), PublicKey), null);
});

test("canonical ArenaConfig discriminator matches Anchor account:ArenaConfig", () => {
  const digest = createHash("sha256").update("account:ArenaConfig").digest().subarray(0, 8);
  assert.deepEqual([...ARENA_CONFIG_DISCRIMINATOR], [...digest]);
  const poolDigest = createHash("sha256").update("account:ArenaPool").digest().subarray(0, 8);
  assert.deepEqual([...ARENA_POOL_DISCRIMINATOR], [...poolDigest]);
});

test("validateCanonicalArenaConfig requires owner, layout, version, unpaused, genesis", () => {
  const authority = Keypair.generate().publicKey;
  const resolver = Keypair.generate().publicKey;
  const protocol = Keypair.generate().publicKey;
  const mwl = Keypair.generate().publicKey;
  const data = new Uint8Array(8 + 32 * 4 + 3);
  data.set(ARENA_CONFIG_DISCRIMINATOR, 0);
  data.set(authority.toBytes(), 8);
  data.set(resolver.toBytes(), 40);
  data.set(protocol.toBytes(), 72);
  data.set(mwl.toBytes(), 104);
  data[136] = 0;
  data[137] = 1;
  data[138] = 2;
  const ok = validateCanonicalArenaConfig({
    account: { data },
    owner: REWARDS_TREASURY_PROGRAM_ID,
    genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t",
    chainId: 101,
    PublicKey,
  });
  assert.equal(ok.live, true);
  assert.equal(isSolanaWarzoneChainId(101), true);

  const paused = new Uint8Array(data);
  paused[136] = 1;
  assert.equal(
    validateCanonicalArenaConfig({
      account: { data: paused },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t",
      chainId: 101,
      PublicKey,
    }).live,
    false,
  );

  assert.equal(
    validateCanonicalArenaConfig({
      account: { data },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      genesisHash: "wrong",
      chainId: 101,
      PublicKey,
    }).reason,
    "cluster-mismatch",
  );

  assert.equal(parseArenaConfig(data, PublicKey)?.version, 2);
});

test("isSolanaWarzoneMoneyLive requires configured and live both explicitly true", () => {
  // configured true + live missing → BLOCK
  assert.equal(isSolanaWarzoneMoneyLive({ configured: true }), false);
  assert.equal(isSolanaWarzoneMoneyLive({ configured: true, live: undefined }), false);
  // configured true + live false → BLOCK
  assert.equal(isSolanaWarzoneMoneyLive({ configured: true, live: false }), false);
  // configured false → BLOCK (even if live is true)
  assert.equal(isSolanaWarzoneMoneyLive({ configured: false }), false);
  assert.equal(isSolanaWarzoneMoneyLive({ configured: false, live: true }), false);
  // configured true + live true → ALLOW
  assert.equal(isSolanaWarzoneMoneyLive({ configured: true, live: true }), true);
});

test("verifyAuthoritativeBuyInReceipt requires owner, layout, pool, asset, entrant, amount, not refunded", () => {
  const digest = createHash("sha256").update("account:ArenaBuyInReceipt").digest().subarray(0, 8);
  assert.deepEqual([...ARENA_BUYIN_DISCRIMINATOR], [...digest]);
  const poolId = new Uint8Array(32).fill(7);
  const asset = Keypair.generate().publicKey;
  const entrant = Keypair.generate().publicKey;
  const data = new Uint8Array(8 + 32 + 32 + 32 + 8 + 1 + 1);
  data.set(ARENA_BUYIN_DISCRIMINATOR, 0);
  data.set(poolId, 8);
  data.set(asset.toBytes(), 40);
  data.set(entrant.toBytes(), 72);
  data[104] = 100;
  data[112] = 0;
  const expectedPool = `0x${Buffer.from(poolId).toString("hex")}`;
  const ok = verifyAuthoritativeBuyInReceipt({
    account: { data },
    owner: REWARDS_TREASURY_PROGRAM_ID,
    expectedPoolId: expectedPool,
    expectedEntryAsset: asset.toBase58(),
    expectedEntrant: entrant.toBase58(),
    expectedAmountLamports: 100,
    PublicKey,
  });
  assert.equal(ok.ok, true);

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data },
      owner: Keypair.generate().publicKey.toBase58(),
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "wrong-owner",
  );

  const refunded = new Uint8Array(data);
  refunded[112] = 1;
  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data: refunded },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "refunded",
  );

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: Keypair.generate().publicKey.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "entrant-mismatch",
  );

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 99,
      PublicKey,
    }).reason,
    "amount-mismatch",
  );

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: `0x${"11".repeat(32)}`,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "pool-mismatch",
  );

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: Keypair.generate().publicKey.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "asset-mismatch",
  );

  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: null,
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "missing-account",
  );

  const badLayout = new Uint8Array(data);
  badLayout[0] ^= 1;
  assert.equal(
    verifyAuthoritativeBuyInReceipt({
      account: { data: badLayout },
      owner: REWARDS_TREASURY_PROGRAM_ID,
      expectedPoolId: expectedPool,
      expectedEntryAsset: asset.toBase58(),
      expectedEntrant: entrant.toBase58(),
      expectedAmountLamports: 100,
      PublicKey,
    }).reason,
    "bad-layout",
  );
});

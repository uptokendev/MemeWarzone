import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ARENA_CONFIG_DISCRIMINATOR,
  ARENA_POOL_DISCRIMINATOR,
  REWARDS_TREASURY_PROGRAM_ID,
  isSolanaWarzoneChainId,
  parseArenaConfig,
  poolIdToBytes,
  stakeToLamports,
  validateCanonicalArenaConfig,
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

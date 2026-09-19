import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CREATE_AUTH_SCHEMA_VERSION,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildCreateAuthorizationPayload,
  buildMetaplexFields,
  createAuthorizationDigest,
  createEd25519Signer,
  decodeBase58,
  encodeBase58,
  findProgramAddressSync,
  integerToBytes32,
  isEd25519Point,
  publicKeyBytes,
  sha256,
  u16,
  u64,
} from "./solana-v4-primitives.js";

function hash32(label) {
  return sha256(Buffer.from(label, "utf8"));
}

function fixtureInput() {
  const programId = encodeBase58(hash32("program"));
  const generationConfigKey = encodeBase58(hash32("generation-config"));
  const creator = encodeBase58(hash32("creator"));
  const campaignId = hash32("campaign-id");
  const campaign = findProgramAddressSync([Buffer.from("campaign"), campaignId], programId).publicKey;
  const mint = findProgramAddressSync([Buffer.from("campaign-mint"), campaignId], programId).publicKey;
  const tokenVault = findProgramAddressSync([Buffer.from("token-vault"), campaignId], programId).publicKey;
  const solVault = findProgramAddressSync([Buffer.from("sol-vault"), campaignId], programId).publicKey;

  return {
    programId,
    generationConfigKey,
    generation: {
      generationId: hash32("generation-id"),
      programId,
      configPda: generationConfigKey,
      startSlot: 42n,
      clusterKind: 1,
      allowedGraduationTierMask: 1,
      economicsVersion: 1,
      curveKind: 1,
      tokenTotalSupply: 1_000_000_000_000n,
      tokenDecimals: 6,
      curveSupplyBps: 8_000,
      liquidityTokenBps: 1_000,
      basePriceLamports: 1_000n,
      priceSlopeLamports: 10n,
      buyFeeBps: 200,
      sellFeeBps: 200,
      finalizeFeeBps: 200,
      creatorPostFinalizeBps: 2_000,
      liquidityPostFinalizeBps: 8_000,
      dexAdapter: 1,
      tradeRouteProfile: hash32("trade"),
      finalizeRouteProfile: hash32("finalize"),
      treasuryProfile: hash32("treasury"),
      dexProfile: hash32("dex"),
      oracleProfile: hash32("oracle"),
      manifestHash: hash32("manifest"),
      routeAuthorizationRequired: true,
      authorizedTradingRequired: true,
    },
    creator,
    riskClusterId: hash32("risk-cluster"),
    creatorBuyLockSeconds: 86_400,
    creatorBuyCapBps: 1_000,
    campaign,
    mint,
    tokenVault,
    solVault,
    tokenProgram: TOKEN_PROGRAM_ID,
    args: {
      campaignId,
      name: "Kaiju88",
      symbol: "K88",
      metadataHash: hash32("metadata"),
      clusterHash: hash32("cluster"),
      tickerHash: hash32("ticker"),
      reservationIdHash: hash32("reservation"),
      reservationVersion: 7n,
      launchAt: 0n,
      graduationTargetUsdMicros: 6_000_000n,
      nonce: hash32("nonce"),
      deadline: 1_900_000_000n,
    },
  };
}

test("base58 preserves canonical 32-byte public keys", () => {
  assert.equal(encodeBase58(Buffer.alloc(32)), SYSTEM_PROGRAM_ID);
  assert.deepEqual(decodeBase58(SYSTEM_PROGRAM_ID), Buffer.alloc(32));
  const tokenProgramBytes = publicKeyBytes(TOKEN_PROGRAM_ID);
  assert.equal(tokenProgramBytes.length, 32);
  assert.equal(encodeBase58(tokenProgramBytes), TOKEN_PROGRAM_ID);
});

test("integer encoders use canonical little-endian bytes", () => {
  assert.deepEqual(u16(0x1234), Buffer.from([0x34, 0x12]));
  assert.deepEqual(u64(0x0102030405060708n), Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]));
  assert.equal(integerToBytes32(1n).toString("hex"), `${"00".repeat(31)}01`);
});

test("PDA derivation is deterministic and produces an off-curve address", () => {
  const programId = encodeBase58(hash32("pda-program"));
  const first = findProgramAddressSync([Buffer.from("campaign"), hash32("campaign")], programId);
  const second = findProgramAddressSync([Buffer.from("campaign"), hash32("campaign")], programId);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(first.bump, second.bump);
  assert.equal(first.publicKeyBytes.length, 32);
  assert.equal(isEd25519Point(first.publicKeyBytes), false);
});

test("V4 serializer is deterministic and binds every mutated field", () => {
  assert.equal(CREATE_AUTH_SCHEMA_VERSION, 5);
  const fixture = fixtureInput();
  const payload = buildCreateAuthorizationPayload(fixture);
  const digest = createAuthorizationDigest(fixture);
  assert.ok(payload.length > 500);
  assert.equal(digest.length, 32);
  assert.deepEqual(digest, createAuthorizationDigest(fixture));

  const modified = {
    ...fixture,
    args: { ...fixture.args, reservationVersion: fixture.args.reservationVersion + 1n },
  };
  assert.notDeepEqual(digest, createAuthorizationDigest(modified));

  // v5: the Metaplex fields are what wallets actually display, so a client must
  // not be able to substitute them behind the route signer's back.
  for (const [field, value] of [
    ["name", "NotKaiju"],
    ["symbol", "EVIL"],
  ]) {
    assert.notDeepEqual(
      digest,
      createAuthorizationDigest({ ...fixture, args: { ...fixture.args, [field]: value } }),
      `${field} must be bound into the create authorization digest`,
    );
  }

  // Length prefixes must keep field boundaries unambiguous.
  const ab = createAuthorizationDigest({ ...fixture, args: { ...fixture.args, name: "AB", symbol: "C" } });
  const a_bc = createAuthorizationDigest({ ...fixture, args: { ...fixture.args, name: "A", symbol: "BC" } });
  assert.notDeepEqual(ab, a_bc, "length-prefixing must prevent field-boundary collisions");
});



test("Node Ed25519 signer accepts a Solana seed and signs the raw digest", () => {
  const seed = Buffer.alloc(32, 7);
  const signer = createEd25519Signer(seed.toString("hex"));
  const digest = createAuthorizationDigest(fixtureInput());
  const signature = signer.sign(digest);
  assert.equal(signer.publicKey.length, 32);
  assert.equal(signature.length, 64);
  assert.equal(signer.verify(digest, signature), true);
  const modified = Buffer.from(digest);
  modified[0] ^= 1;
  assert.equal(signer.verify(modified, signature), false);
});



test("Metaplex fields are clipped to Metaplex limits, not rejected", () => {
  const fields = buildMetaplexFields({ name: "A".repeat(80), symbol: "VERYLONGSYMBOL" });
  assert.equal(Buffer.byteLength(fields.name, "utf8"), 32);
  assert.equal(Buffer.byteLength(fields.symbol, "utf8"), 10);
  assert.equal(fields.uri, undefined, "the program derives the uri, the signer must not send one");
});

test("empty name or symbol falls back rather than failing the launch", () => {
  const fields = buildMetaplexFields({ name: "", symbol: "" });
  assert.equal(fields.name, "MemeWarzone Token");
  assert.equal(fields.symbol, "MWZ");
});

test("the create args the client receives carry every field the instruction encodes", () => {
  // Both create paths build a full args object and then hand-copy a whitelist of
  // fields into the HTTP response. A field added to CreateCampaignArgs but not to
  // that whitelist is silently dropped, and the browser fails far away with
  // "name must not be empty". This pins the response shape to the wire format.
  const encodedFields = [
    "campaignId",
    "name",
    "symbol",
    "metadataHash",
    "clusterHash",
    "tickerHash",
    "reservationIdHash",
    "reservationVersion",
    "launchAt",
    "graduationTargetUsdMicros",
    "deadline",
    "nonce",
  ];
  const sources = [
    "frontend/api/dev-fix/solana-direct-create.js",
    "frontend/api/dev-fix/solana-create-authorization-v4.js",
  ];
  for (const file of sources) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    const start = source.indexOf("createArgs = {");
    assert.ok(start > 0, `${file} must build a createArgs response`);
    const block = source.slice(start, source.indexOf("};", start));
    for (const field of encodedFields) {
      assert.ok(
        new RegExp(`\\b${field}\\s*:`).test(block),
        `${file} drops ${field} from the create args it returns to the client`,
      );
    }
  }
});

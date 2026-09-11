"use strict";

/**
 * Certification-only source repair for the legacy Gate K lifecycle fixture.
 *
 * The production Solana program and backend authorization builder use graduation
 * authorization schema v4. The historical local-validator lifecycle fixture was
 * still signing schema v2 and omitted generation + quote-policy binding fields.
 * This script fails closed unless it finds that exact stale fixture, then upgrades
 * only the test fixture in the Actions checkout before Gate K runs.
 *
 * It does NOT modify production program logic, weaken verification, or introduce
 * a test-only program bypass. The resulting Ed25519 message matches the v4 field
 * order enforced by graduation.rs and solana-graduation-auth-bytes.js.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const FILE = path.join(ROOT, "tests/solana/v4-lifecycle-acceptance.cjs");

let source = fs.readFileSync(FILE, "utf8");

const staleSchema = "const GRADUATION_AUTH_SCHEMA_VERSION = 2;";
const currentSchema = [
  "const GRADUATION_AUTH_SCHEMA_VERSION = 4;",
  "const NATIVE_QUOTE_CONFIG_ID = hash32(\"gate-k:solana-basic-native-binding-v1\");",
].join("\n");

if (!source.includes(staleSchema)) {
  throw new Error("Gate K recovery expected the exact stale schema-v2 fixture; refusing to patch an unknown fixture.");
}
source = source.replace(staleSchema, currentSchema);

const staleDigest = `  function graduationDigest(input) {
    return crypto
      .createHash("sha256")
      .update(
        Buffer.concat([
          GRADUATION_AUTH_DOMAIN,
          u16le(GRADUATION_AUTH_SCHEMA_VERSION),
          program.programId.toBuffer(),
          input.campaign.toBuffer(),
          input.mint.toBuffer(),
          input.authority.toBuffer(),
          u64le(input.graduationTargetUsdMicros),
          u64le(input.nativeTargetLamports),
          u64le(input.oraclePriceUsdMicros),
          input.pool.toBuffer(),
          input.position.toBuffer(),
          input.nftMint.toBuffer(),
          i64le(input.deadline),
          input.nonce,
          Buffer.from([input.finalizeRouteProfile ?? ROUTE_PROFILE_UNLINKED]),
        ]),
      )
      .digest();
  }`;

const currentDigest = `  function graduationDigest(input) {
    const quoteMint = input.quoteMint || NATIVE_MINT;
    const quoteConfigId = Buffer.from(input.quoteConfigId || NATIVE_QUOTE_CONFIG_ID);
    const quotePolicyVersion = input.quotePolicyVersion ?? 1;
    const quoteProfile = input.quoteProfile ?? 0;
    const quoteProviderClass = input.quoteProviderClass ?? 0;
    const acquisitionProgram = input.acquisitionProgram || SystemProgram.programId;
    const quoteReferenceUsdMicros = input.quoteReferenceUsdMicros ?? input.oraclePriceUsdMicros;
    const quoteDecimals = input.quoteDecimals ?? 9;
    const expectedQuoteAmount = input.expectedQuoteAmount ?? 0;
    const minQuoteAmount = input.minQuoteAmount ?? 0;
    const maxSlippageBps = input.maxSlippageBps ?? 0;
    const maxImpactBps = input.maxImpactBps ?? 0;
    const maxDeviationBps = input.maxDeviationBps ?? 0;
    const quoteRecoveryAccount = input.quoteRecoveryAccount || SystemProgram.programId;
    assert.equal(quoteConfigId.length, 32, "quote config binding must be exactly 32 bytes");
    return crypto
      .createHash("sha256")
      .update(
        Buffer.concat([
          GRADUATION_AUTH_DOMAIN,
          u16le(GRADUATION_AUTH_SCHEMA_VERSION),
          program.programId.toBuffer(),
          input.campaign.toBuffer(),
          input.mint.toBuffer(),
          input.authority.toBuffer(),
          generationConfig.toBuffer(),
          u64le(input.graduationTargetUsdMicros),
          u64le(input.nativeTargetLamports),
          u64le(input.oraclePriceUsdMicros),
          input.pool.toBuffer(),
          input.position.toBuffer(),
          input.nftMint.toBuffer(),
          i64le(input.deadline),
          input.nonce,
          Buffer.from([input.finalizeRouteProfile ?? ROUTE_PROFILE_UNLINKED]),
          quoteMint.toBuffer(),
          quoteConfigId,
          u16le(quotePolicyVersion),
          Buffer.from([quoteProfile]),
          Buffer.from([quoteProviderClass]),
          acquisitionProgram.toBuffer(),
          u64le(quoteReferenceUsdMicros),
          Buffer.from([quoteDecimals]),
          u64le(expectedQuoteAmount),
          u64le(minQuoteAmount),
          u16le(maxSlippageBps),
          u16le(maxImpactBps),
          u16le(maxDeviationBps),
          quoteRecoveryAccount.toBuffer(),
        ]),
      )
      .digest();
  }`;

if (!source.includes(staleDigest)) {
  throw new Error("Gate K recovery could not find the exact stale graduationDigest implementation.");
}
source = source.replace(staleDigest, currentDigest);

const staleArgsTail = `        positionNftMint: nftMint.publicKey,
        finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
      })
      .accountsStrict`;
const currentArgsTail = `        positionNftMint: nftMint.publicKey,
        finalizeRouteProfile: ROUTE_PROFILE_UNLINKED,
        quoteMint: NATIVE_MINT,
        quoteConfigId: fixed32(NATIVE_QUOTE_CONFIG_ID),
        quotePolicyVersion: 1,
        quoteProfile: 0,
        quoteProviderClass: 0,
        acquisitionProgram: SystemProgram.programId,
        quoteReferenceUsdMicros: new BN(oraclePrice.toString()),
        quoteDecimals: 9,
        expectedQuoteAmount: new BN(0),
        minQuoteAmount: new BN(0),
        maxSlippageBps: 0,
        maxImpactBps: 0,
        maxDeviationBps: 0,
        quoteRecoveryAccount: SystemProgram.programId,
      })
      .accountsStrict`;

const occurrences = source.split(staleArgsTail).length - 1;
if (occurrences !== 3) {
  throw new Error(`Gate K recovery expected exactly 3 stale beginGraduation arg blocks, found ${occurrences}.`);
}
source = source.split(staleArgsTail).join(currentArgsTail);

if (source.includes(staleSchema)) throw new Error("stale graduation schema remains after fixture repair");
if (!source.includes("generationConfig.toBuffer()")) throw new Error("generation binding missing from repaired digest");
if ((source.match(/quoteConfigId: fixed32\(NATIVE_QUOTE_CONFIG_ID\)/g) || []).length !== 3) {
  throw new Error("not every beginGraduation fixture received quote config binding");
}

fs.writeFileSync(FILE, source, "utf8");
console.log("GATE_K_AUTH_FIXTURE_SCHEMA=4");
console.log("GATE_K_AUTH_FIXTURE_GENERATION_BINDING=PASS");
console.log("GATE_K_AUTH_FIXTURE_QUOTE_BINDING=PASS");
console.log("GATE_K_AUTH_FIXTURE_BEGIN_ARGS_PATCHED=3");

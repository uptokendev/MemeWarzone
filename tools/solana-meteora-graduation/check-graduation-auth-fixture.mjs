import assert from "node:assert/strict";
import { buildGraduationDigest, GRADUATION_AUTH_SCHEMA_VERSION } from "../../frontend/api/dev-fix/solana-graduation-auth-bytes.js";

assert.equal(GRADUATION_AUTH_SCHEMA_VERSION, 4);
const fields = {
  programId: "11111111111111111111111111111111",
  campaign: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  mint: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
  authority: "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
  generationConfig: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
  graduationTargetUsdMicros: 30_000_000_000n,
  nativeTargetLamports: 200_000_000_000n,
  oraclePriceUsdMicros: 150_000_000n,
  meteoraPool: "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
  meteoraPosition: "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF",
  positionNftMint: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
  deadline: 1_900_000_000n,
  nonce: Buffer.alloc(32, 12),
  finalizeRouteProfile: 1,
  quoteMint: "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf",
  quoteConfigHash: Buffer.alloc(32, 11),
  quotePolicyVersion: 7,
  quoteProfile: 1,
  quoteProviderClass: 1,
  acquisitionProgram: "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
  quoteReferenceUsdMicros: 1_000_000n,
  quoteDecimals: 6,
  expectedQuoteAmount: 123_456_789n,
  minQuoteAmount: 120_000_000n,
  maxSlippageBps: 100,
  maxImpactBps: 100,
  maxDeviationBps: 100,
  quoteRecoveryAccount: "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5",
};
const expected = Buffer.from([212, 43, 6, 198, 126, 184, 102, 231, 52, 54, 221, 59, 12, 119, 171, 53, 171, 83, 229, 118, 225, 159, 15, 65, 23, 197, 228, 40, 104, 47, 219, 197]);
const exact = buildGraduationDigest(fields);
assert.deepEqual(exact, expected, "JS bytes must match the Rust schema-v4 fixture");
const substituted = buildGraduationDigest({ ...fields, generationConfig: "swqrv48gsrwpBFbftEwnP2vB4jckpvfGJfXkwaniLCC" });
assert.notDeepEqual(substituted, exact, "generation substitution must change authorization bytes");
console.log("graduation authorization schema-v4 cross-language fixture: PASS");

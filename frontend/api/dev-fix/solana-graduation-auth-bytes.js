import {
  i64,
  publicKeyBytes,
  sha256,
  u16,
  u64,
  u8,
} from "./solana-v4-primitives.js";

export const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");
export const GRADUATION_AUTH_SCHEMA_VERSION = 4;

export function buildGraduationDigest(fields) {
  return sha256(
    GRADUATION_AUTH_DOMAIN,
    u16(GRADUATION_AUTH_SCHEMA_VERSION, "schemaVersion"),
    publicKeyBytes(fields.programId),
    publicKeyBytes(fields.campaign),
    publicKeyBytes(fields.mint),
    publicKeyBytes(fields.authority),
    publicKeyBytes(fields.generationConfig),
    u64(fields.graduationTargetUsdMicros),
    u64(fields.nativeTargetLamports),
    u64(fields.oraclePriceUsdMicros),
    publicKeyBytes(fields.meteoraPool),
    publicKeyBytes(fields.meteoraPosition),
    publicKeyBytes(fields.positionNftMint),
    i64(fields.deadline),
    Buffer.from(fields.nonce),
    u8(fields.finalizeRouteProfile),
    publicKeyBytes(fields.quoteMint),
    Buffer.from(fields.quoteConfigHash),
    u16(fields.quotePolicyVersion),
    u8(fields.quoteProfile),
    u8(fields.quoteProviderClass),
    publicKeyBytes(fields.acquisitionProgram),
    u64(fields.quoteReferenceUsdMicros),
    u8(fields.quoteDecimals),
    u64(fields.expectedQuoteAmount),
    u64(fields.minQuoteAmount),
    u16(fields.maxSlippageBps),
    u16(fields.maxImpactBps),
    u16(fields.maxDeviationBps),
    publicKeyBytes(fields.quoteRecoveryAccount),
  );
}

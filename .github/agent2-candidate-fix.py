from pathlib import Path
import hashlib
import re

BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = BASE58[r] + out
    zeros = len(raw) - len(raw.lstrip(b"\0"))
    return "1" * zeros + (out or "")

def le(value: int, size: int) -> bytes:
    return int(value).to_bytes(size, "little", signed=False)

def sle(value: int, size: int) -> bytes:
    return int(value).to_bytes(size, "little", signed=True)

keys = {name: bytes([i]) * 32 for i, name in enumerate([
    "program", "campaign", "mint", "authority", "generation", "pool", "position",
    "nft", "quote", "acquisition", "recovery"
])}
nonce = bytes([12]) * 32
config_hash = bytes([11]) * 32
parts = [
    b"MEMEWARZONE_SOLANA_GRADUATION_V1",
    le(4, 2),
    keys["program"], keys["campaign"], keys["mint"], keys["authority"], keys["generation"],
    le(30_000_000_000, 8), le(200_000_000_000, 8), le(150_000_000, 8),
    keys["pool"], keys["position"], keys["nft"],
    sle(1_900_000_000, 8), nonce, le(1, 1),
    keys["quote"], config_hash, le(7, 2), le(1, 1), le(1, 1), keys["acquisition"],
    le(1_000_000, 8), le(6, 1), le(123_456_789, 8), le(120_000_000, 8),
    le(100, 2), le(100, 2), le(100, 2), keys["recovery"],
]
expected = hashlib.sha256(b"".join(parts)).digest()
expected_array = ", ".join(str(x) for x in expected)

# 1) Pure cross-language serializer with no catalog/DB import boundary.
pure = Path("frontend/api/dev-fix/solana-graduation-auth-bytes.js")
pure.write_text('''import {\n  i64,\n  publicKeyBytes,\n  sha256,\n  u16,\n  u64,\n  u8,\n} from "./solana-v4-primitives.js";\n\nexport const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");\nexport const GRADUATION_AUTH_SCHEMA_VERSION = 4;\n\nexport function buildGraduationDigest(fields) {\n  return sha256(\n    GRADUATION_AUTH_DOMAIN,\n    u16(GRADUATION_AUTH_SCHEMA_VERSION, "schemaVersion"),\n    publicKeyBytes(fields.programId),\n    publicKeyBytes(fields.campaign),\n    publicKeyBytes(fields.mint),\n    publicKeyBytes(fields.authority),\n    publicKeyBytes(fields.generationConfig),\n    u64(fields.graduationTargetUsdMicros),\n    u64(fields.nativeTargetLamports),\n    u64(fields.oraclePriceUsdMicros),\n    publicKeyBytes(fields.meteoraPool),\n    publicKeyBytes(fields.meteoraPosition),\n    publicKeyBytes(fields.positionNftMint),\n    i64(fields.deadline),\n    Buffer.from(fields.nonce),\n    u8(fields.finalizeRouteProfile),\n    publicKeyBytes(fields.quoteMint),\n    Buffer.from(fields.quoteConfigHash),\n    u16(fields.quotePolicyVersion),\n    u8(fields.quoteProfile),\n    u8(fields.quoteProviderClass),\n    publicKeyBytes(fields.acquisitionProgram),\n    u64(fields.quoteReferenceUsdMicros),\n    u8(fields.quoteDecimals),\n    u64(fields.expectedQuoteAmount),\n    u64(fields.minQuoteAmount),\n    u16(fields.maxSlippageBps),\n    u16(fields.maxImpactBps),\n    u16(fields.maxDeviationBps),\n    publicKeyBytes(fields.quoteRecoveryAccount),\n  );\n}\n''')

# 2) Backend uses the pure serializer; catalog DB remains production-only and unmocked.
auth = Path("frontend/api/dev-fix/solana-graduation-authorization-v2.js")
text = auth.read_text()
text = text.replace('import { getGraduationQuoteAssetDetail } from "../lib/quoteAssetCatalog.js";\n', 'import { getGraduationQuoteAssetDetail } from "../lib/quoteAssetCatalog.js";\nimport { GRADUATION_AUTH_SCHEMA_VERSION, buildGraduationDigest } from "./solana-graduation-auth-bytes.js";\n')
text = text.replace('const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");\nconst GRADUATION_AUTH_SCHEMA_VERSION = 3;\n', '')
text, n = re.subn(r'\nfunction buildGraduationDigest\(fields\) \{.*?\n\}\n\nexport async function solanaGraduationAuthorizationV2', '\nexport async function solanaGraduationAuthorizationV2', text, count=1, flags=re.S)
if n != 1:
    raise SystemExit("backend digest function replacement failed")
text = text.replace('programId, campaign: campaignAddress, mint: campaign.mint, authority: authorityAddress,\n      graduationTargetUsdMicros:', 'programId, campaign: campaignAddress, mint: campaign.mint, authority: authorityAddress, generationConfig: campaign.generationConfig,\n      graduationTargetUsdMicros:')
text = text.replace('chainId must be Solana (101).', 'chainId must be a supported Solana chain.')
auth.write_text(text)

# 3) Rust schema v4 + exact generation binding + exact rational deviation comparison.
rust = Path("programs/memewarzone_solana/src/graduation.rs")
text = rust.read_text()
text = text.replace('pub const GRADUATION_AUTH_SCHEMA_VERSION: u16 = 3;', 'pub const GRADUATION_AUTH_SCHEMA_VERSION: u16 = 4;')
text = text.replace('        ctx.accounts.authority.key(),\n        campaign.graduation_target_usd_micros,', '        ctx.accounts.authority.key(),\n        campaign.generation_config,\n        campaign.graduation_target_usd_micros,', 1)
text = text.replace('    authority: Pubkey,\n    target: u64,\n    args: &BeginGraduationArgs,', '    authority: Pubkey,\n    generation_config: Pubkey,\n    target: u64,\n    args: &BeginGraduationArgs,', 1)
text = text.replace('    m.extend_from_slice(authority.as_ref());\n    m.extend_from_slice(&target.to_le_bytes());', '    m.extend_from_slice(authority.as_ref());\n    m.extend_from_slice(generation_config.as_ref());\n    m.extend_from_slice(&target.to_le_bytes());', 1)

pattern = re.compile(r'fn validate_quote_pool_deviation\(.*?\n\}\n\n#\[inline\(never\)\]', re.S)
replacement = r'''fn gcd_u128(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a
}

fn mul_div_reduced(mut numerators: [u128; 3], mut denominators: [u128; 2]) -> Result<u128> {
    for denominator in &mut denominators {
        require!(*denominator > 0, LaunchpadError::GraduationPriceDrift);
        for numerator in &mut numerators {
            let common = gcd_u128(*numerator, *denominator);
            if common > 1 {
                *numerator /= common;
                *denominator /= common;
            }
        }
    }
    let numerator = numerators.into_iter().try_fold(1u128, |acc, value| {
        acc.checked_mul(value).ok_or(LaunchpadError::MathOverflow)
    })?;
    let denominator = denominators.into_iter().try_fold(1u128, |acc, value| {
        acc.checked_mul(value).ok_or(LaunchpadError::MathOverflow)
    })?;
    numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

fn validate_quote_pool_deviation(
    quote_raw: u64,
    token_raw: u64,
    token_decimals: u8,
    quote_decimals: u8,
    final_spot_nano: u128,
    sol_usd_micros: u64,
    quote_usd_micros: u64,
    max_deviation_bps: u16,
) -> Result<()> {
    require!(
        quote_raw > 0
            && token_raw > 0
            && final_spot_nano > 0
            && sol_usd_micros > 0
            && quote_usd_micros > 0,
        LaunchpadError::GraduationPriceDrift
    );

    // Compare both ratios at high fixed-point precision without performing an
    // early integer division. Cross-cancelling denominator factors first keeps
    // legitimate sub-raw-unit quote/token ratios representable and bounds u128
    // multiplication pressure. No floating point is used.
    const RATIO_SCALE: u128 = 1_000_000_000_000;
    const NANO_LAMPORTS_PER_SOL: u128 = 1_000_000_000_000_000_000;
    let actual_scaled = mul_div_reduced(
        [u128::from(quote_raw), token_scale(token_decimals)?, RATIO_SCALE],
        [u128::from(token_raw), token_scale(quote_decimals)?],
    )?;
    let expected_scaled = mul_div_reduced(
        [final_spot_nano, u128::from(sol_usd_micros), RATIO_SCALE],
        [NANO_LAMPORTS_PER_SOL, u128::from(quote_usd_micros)],
    )?;
    require!(expected_scaled > 0, LaunchpadError::GraduationPriceDrift);

    let drift_bps = actual_scaled
        .abs_diff(expected_scaled)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(expected_scaled)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        drift_bps <= u128::from(max_deviation_bps),
        LaunchpadError::GraduationPriceDrift
    );
    Ok(())
}

#[inline(never)]'''
text, n = pattern.subn(replacement, text, count=1)
if n != 1:
    raise SystemExit("deviation function replacement failed")

insert_at = text.find('    #[test]\n    fn native_target_matches_ceil_usd_conversion()')
if insert_at < 0:
    raise SystemExit("Rust test insertion marker missing")
fixture_test = f'''    #[test]\n    fn graduation_authorization_binds_exact_generation() {{\n        let args = BeginGraduationArgs {{\n            native_target_lamports: 200_000_000_000,\n            oracle_price_usd_micros: 150_000_000,\n            deadline: 1_900_000_000,\n            nonce: [12u8; 32],\n            position_nft_mint: Pubkey::new_from_array([7u8; 32]),\n            finalize_route_profile: 1,\n            quote_mint: Pubkey::new_from_array([8u8; 32]),\n            quote_config_id: [11u8; 32],\n            quote_policy_version: 7,\n            quote_profile: 1,\n            quote_provider_class: 1,\n            acquisition_program: Pubkey::new_from_array([9u8; 32]),\n            quote_reference_usd_micros: 1_000_000,\n            quote_decimals: 6,\n            expected_quote_amount: 123_456_789,\n            min_quote_amount: 120_000_000,\n            max_slippage_bps: 100,\n            max_impact_bps: 100,\n            max_deviation_bps: 100,\n            quote_recovery_account: Pubkey::new_from_array([10u8; 32]),\n        }};\n        let exact = build_graduation_authorization_digest(\n            Pubkey::new_from_array([0u8; 32]),\n            Pubkey::new_from_array([1u8; 32]),\n            Pubkey::new_from_array([2u8; 32]),\n            Pubkey::new_from_array([3u8; 32]),\n            Pubkey::new_from_array([4u8; 32]),\n            30_000_000_000,\n            &args,\n            Pubkey::new_from_array([5u8; 32]),\n            Pubkey::new_from_array([6u8; 32]),\n        );\n        assert_eq!(exact.to_bytes(), [{expected_array}]);\n\n        let substituted = build_graduation_authorization_digest(\n            Pubkey::new_from_array([0u8; 32]),\n            Pubkey::new_from_array([1u8; 32]),\n            Pubkey::new_from_array([2u8; 32]),\n            Pubkey::new_from_array([3u8; 32]),\n            Pubkey::new_from_array([13u8; 32]),\n            30_000_000_000,\n            &args,\n            Pubkey::new_from_array([5u8; 32]),\n            Pubkey::new_from_array([6u8; 32]),\n        );\n        assert_ne!(substituted.to_bytes(), exact.to_bytes());\n    }}\n\n    #[test]\n    fn quote_deviation_accepts_sub_raw_unit_and_rejects_excessive_drift() {{\n        assert!(validate_quote_pool_deviation(\n            150,\n            1_000_000_000,\n            9,\n            6,\n            1_000_000_000,\n            150_000_000,\n            1_000_000,\n            1,\n        )\n        .is_ok());\n        assert!(validate_quote_pool_deviation(\n            180,\n            1_000_000_000,\n            9,\n            6,\n            1_000_000_000,\n            150_000_000,\n            1_000_000,\n            100,\n        )\n        .is_err());\n    }}\n\n'''
text = text[:insert_at] + fixture_test + text[insert_at:]
rust.write_text(text)

# 4) Cross-language fixture imports only the pure serializer, never the catalog DB.
fixture = Path("tools/solana-meteora-graduation/check-graduation-auth-fixture.mjs")
jskeys = {k: b58encode(v) for k, v in keys.items()}
fixture.write_text(f'''import assert from "node:assert/strict";\nimport {{ buildGraduationDigest, GRADUATION_AUTH_SCHEMA_VERSION }} from "../../frontend/api/dev-fix/solana-graduation-auth-bytes.js";\n\nassert.equal(GRADUATION_AUTH_SCHEMA_VERSION, 4);\nconst fields = {{\n  programId: "{jskeys['program']}",\n  campaign: "{jskeys['campaign']}",\n  mint: "{jskeys['mint']}",\n  authority: "{jskeys['authority']}",\n  generationConfig: "{jskeys['generation']}",\n  graduationTargetUsdMicros: 30_000_000_000n,\n  nativeTargetLamports: 200_000_000_000n,\n  oraclePriceUsdMicros: 150_000_000n,\n  meteoraPool: "{jskeys['pool']}",\n  meteoraPosition: "{jskeys['position']}",\n  positionNftMint: "{jskeys['nft']}",\n  deadline: 1_900_000_000n,\n  nonce: Buffer.alloc(32, 12),\n  finalizeRouteProfile: 1,\n  quoteMint: "{jskeys['quote']}",\n  quoteConfigHash: Buffer.alloc(32, 11),\n  quotePolicyVersion: 7,\n  quoteProfile: 1,\n  quoteProviderClass: 1,\n  acquisitionProgram: "{jskeys['acquisition']}",\n  quoteReferenceUsdMicros: 1_000_000n,\n  quoteDecimals: 6,\n  expectedQuoteAmount: 123_456_789n,\n  minQuoteAmount: 120_000_000n,\n  maxSlippageBps: 100,\n  maxImpactBps: 100,\n  maxDeviationBps: 100,\n  quoteRecoveryAccount: "{jskeys['recovery']}",\n}};\nconst expected = Buffer.from([{expected_array}]);\nconst exact = buildGraduationDigest(fields);\nassert.deepEqual(exact, expected, "JS bytes must match the Rust schema-v4 fixture");\nconst substituted = buildGraduationDigest({{ ...fields, generationConfig: "{b58encode(bytes([13]) * 32)}" }});\nassert.notDeepEqual(substituted, exact, "generation substitution must change authorization bytes");\nconsole.log("graduation authorization schema-v4 cross-language fixture: PASS");\n''')

# 5) Certification tool accepts explicit Solana chain id instead of hardcoding 101.
tool = Path("tools/solana-meteora-graduation/graduate-basic-quote.mjs")
text = tool.read_text()
text = text.replace('async function fetchGraduationAuthorization({ campaign, authority, positionNftMint, quoteConfigId }) {', 'async function fetchGraduationAuthorization({ campaign, authority, positionNftMint, quoteConfigId, chainId }) {')
text = text.replace('body: JSON.stringify({ chainId: 101, campaignAddress:', 'body: JSON.stringify({ chainId, campaignAddress:')
needle = '  const quoteConfigId = String(process.env.SOLANA_GRADUATION_QUOTE_CONFIG_ID || "").trim();'
if needle in text and 'SOLANA_GRADUATION_CHAIN_ID' not in text:
    text = text.replace(needle, '  const chainId = Number(process.env.SOLANA_GRADUATION_CHAIN_ID || "101");\n  if (!Number.isInteger(chainId)) fail("SOLANA_GRADUATION_CHAIN_ID must be an integer Solana chain id");\n' + needle)
text = text.replace('const auth = await fetchGraduationAuthorization({ campaign: campaignPk, authority: operator.publicKey, positionNftMint: positionNft.publicKey, quoteConfigId });', 'const auth = await fetchGraduationAuthorization({ campaign: campaignPk, authority: operator.publicKey, positionNftMint: positionNft.publicKey, quoteConfigId, chainId });')
tool.write_text(text)

print("candidate corrections applied")

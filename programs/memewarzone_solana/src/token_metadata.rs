//! Metaplex Token Metadata creation for launched campaign mints.
//!
//! Why this exists: wallets and aggregators (Phantom, Jupiter, Solscan,
//! DexScreener) read a token's name, symbol and image from the Metaplex
//! Token Metadata account at PDA ["metadata", mpl_program, mint]. A mint
//! without one shows as its raw base58 address everywhere, which is what
//! happened to every token launched before this instruction existed.
//!
//! Ordering is the whole point: `CreateMetadataAccountV3` requires the mint
//! authority to sign. `create_campaign` revokes the mint authority as part of
//! the same instruction, so metadata that is not created BEFORE that revocation
//! can never be created at all. Keep this CPI above `set_authority`.
//!
//! The instruction is built by hand rather than through `mpl-token-metadata`.
//! This crate's dependency versions are pinned hard to keep Anchor 0.30 /
//! Solana 1.18 SBF builds working, and pulling in the Metaplex crate drags a
//! transitive tree that breaks that pinning. The wire format below is stable
//! and small enough to own.

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::AccountMeta, instruction::Instruction, program::invoke_signed},
};

use crate::LaunchpadError;

/// Metaplex Token Metadata program: metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
pub const MPL_TOKEN_METADATA_ID: Pubkey = Pubkey::new_from_array([
    0x0b, 0x70, 0x65, 0xb1, 0xe3, 0xd1, 0x7c, 0x45, 0x38, 0x9d, 0x52, 0x7f, 0x6b, 0x04, 0xc3, 0xcd,
    0x58, 0xb8, 0x6c, 0x73, 0x1a, 0xa0, 0xfd, 0xb5, 0x49, 0xb6, 0xd1, 0xbc, 0x03, 0xf8, 0x29, 0x46,
]);

pub const METADATA_SEED: &[u8] = b"metadata";

/// Metaplex's own field caps. Exceeding any of them makes the CPI fail, so they
/// are rejected here with a clear error instead.
pub const MAX_NAME_LENGTH: usize = 32;
pub const MAX_SYMBOL_LENGTH: usize = 10;
pub const MAX_URI_LENGTH: usize = 200;

/// CreateMetadataAccountV3 instruction discriminator.
const CREATE_METADATA_ACCOUNT_V3: u8 = 33;

fn push_borsh_string(buffer: &mut Vec<u8>, value: &str) {
    buffer.extend_from_slice(&(value.len() as u32).to_le_bytes());
    buffer.extend_from_slice(value.as_bytes());
}

pub fn validate_metadata_fields(name: &str, symbol: &str, uri: &str) -> Result<()> {
    require!(!name.is_empty(), LaunchpadError::InvalidMetadata);
    require!(!symbol.is_empty(), LaunchpadError::InvalidMetadata);
    require!(!uri.is_empty(), LaunchpadError::InvalidMetadata);
    require!(name.len() <= MAX_NAME_LENGTH, LaunchpadError::InvalidMetadata);
    require!(symbol.len() <= MAX_SYMBOL_LENGTH, LaunchpadError::InvalidMetadata);
    require!(uri.len() <= MAX_URI_LENGTH, LaunchpadError::InvalidMetadata);
    Ok(())
}

/// Borsh body for CreateMetadataAccountV3.
///
/// DataV2 { name, symbol, uri, seller_fee_basis_points: u16,
///          creators: Option<Vec<Creator>>, collection: Option<Collection>,
///          uses: Option<Uses> }
/// followed by is_mutable: bool and collection_details: Option<CollectionDetails>.
///
/// Every optional field is None: this is a plain fungible launch with no
/// royalties, no verified creators and no collection.
pub fn build_create_metadata_v3_data(name: &str, symbol: &str, uri: &str, is_mutable: bool) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 12 + name.len() + symbol.len() + uri.len() + 8);
    data.push(CREATE_METADATA_ACCOUNT_V3);
    push_borsh_string(&mut data, name);
    push_borsh_string(&mut data, symbol);
    push_borsh_string(&mut data, uri);
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.push(0); // creators: None
    data.push(0); // collection: None
    data.push(0); // uses: None
    data.push(u8::from(is_mutable));
    data.push(0); // collection_details: None
    data
}

/// Where the off-chain metadata JSON lives.
///
/// Built in the program rather than passed in, for two reasons. It keeps ~96
/// bytes of URI out of every create transaction, which is what put the V0
/// envelope over its size ceiling. And it removes the chance that a
/// misconfigured environment variable writes a URL nobody can read into a mint
/// that can never be corrected.
///
/// Changing this needs a program upgrade. That is the right trade: it is a
/// stable address, and being wrong here is permanent per token.
pub const METADATA_URI_BASE: &str = "https://api.memewar.zone/api/token-metadata/101/";

const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Base58 of a 32-byte public key, matching how Solana renders addresses.
///
/// Repeated division of the 256-bit value by 58. Leading zero bytes become
/// leading '1's, which is the part naive implementations drop.
pub fn base58_encode_pubkey(bytes: &[u8; 32]) -> String {
    let leading_zeros = bytes.iter().take_while(|b| **b == 0).count();

    let mut digits: Vec<u8> = Vec::with_capacity(44);
    let mut buffer = *bytes;
    let mut start = leading_zeros;
    while start < 32 {
        let mut remainder: u16 = 0;
        for byte in buffer.iter_mut().skip(start) {
            let value = (remainder << 8) | u16::from(*byte);
            *byte = (value / 58) as u8;
            remainder = value % 58;
        }
        digits.push(BASE58_ALPHABET[remainder as usize]);
        while start < 32 && buffer[start] == 0 {
            start += 1;
        }
    }

    let mut out = Vec::with_capacity(leading_zeros + digits.len());
    out.extend(std::iter::repeat(b'1').take(leading_zeros));
    out.extend(digits.iter().rev());
    String::from_utf8(out).unwrap_or_default()
}

/// Off-chain metadata URL for a mint. Always under MAX_URI_LENGTH: the base is
/// fixed and a base58 pubkey is at most 44 characters.
pub fn build_metadata_uri(mint: &Pubkey) -> String {
    let mut uri = String::with_capacity(METADATA_URI_BASE.len() + 44);
    uri.push_str(METADATA_URI_BASE);
    uri.push_str(&base58_encode_pubkey(&mint.to_bytes()));
    uri
}

pub fn metadata_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[METADATA_SEED, MPL_TOKEN_METADATA_ID.as_ref(), mint.as_ref()],
        &MPL_TOKEN_METADATA_ID,
    )
}

/// Create the Metaplex metadata account for a campaign mint.
///
/// `mint_authority` and `update_authority` are both the campaign PDA, so the
/// program stays the only thing that can ever amend this metadata; no human key
/// can. `is_mutable` is true on purpose: the first generation of launches could
/// not be corrected at all, and a program-owned update path is the difference
/// between a fixable mistake and a permanent one.
#[allow(clippy::too_many_arguments)]
pub fn create_campaign_metadata<'info>(
    metadata_account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    campaign: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_metadata_program: &AccountInfo<'info>,
    campaign_signer: &[&[&[u8]]],
    name: &str,
    symbol: &str,
) -> Result<()> {
    let uri = build_metadata_uri(&mint.key());
    validate_metadata_fields(name, symbol, &uri)?;

    require_keys_eq!(
        token_metadata_program.key(),
        MPL_TOKEN_METADATA_ID,
        LaunchpadError::InvalidMetadata
    );

    // Derived here rather than as an Anchor seeds constraint: try_accounts on
    // this instruction is already close to the 4KB BPF stack limit, which is
    // why the surrounding accounts are all UncheckedAccount.
    let (expected_metadata, _bump) = metadata_address(&mint.key());
    require_keys_eq!(
        metadata_account.key(),
        expected_metadata,
        LaunchpadError::InvalidMetadata
    );

    let instruction = Instruction {
        program_id: MPL_TOKEN_METADATA_ID,
        accounts: vec![
            AccountMeta::new(metadata_account.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new_readonly(campaign.key(), true), // mint authority
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(campaign.key(), false), // update authority
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        data: build_create_metadata_v3_data(name, symbol, &uri, true),
    };

    invoke_signed(
        &instruction,
        &[
            metadata_account.clone(),
            mint.clone(),
            campaign.clone(),
            payer.clone(),
            system_program.clone(),
            token_metadata_program.clone(),
        ],
        campaign_signer,
    )
    .map_err(|_| error!(LaunchpadError::InvalidMetadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metaplex_program_id_matches_the_documented_address() {
        assert_eq!(
            MPL_TOKEN_METADATA_ID.to_string(),
            "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        );
    }

    #[test]
    fn create_metadata_data_is_borsh_shaped() {
        let data = build_create_metadata_v3_data("Kaiju88", "K88", "https://x/y", true);
        assert_eq!(data[0], CREATE_METADATA_ACCOUNT_V3);
        // name
        assert_eq!(&data[1..5], &7u32.to_le_bytes());
        assert_eq!(&data[5..12], b"Kaiju88");
        // symbol
        assert_eq!(&data[12..16], &3u32.to_le_bytes());
        assert_eq!(&data[16..19], b"K88");
        // uri
        assert_eq!(&data[19..23], &11u32.to_le_bytes());
        assert_eq!(&data[23..34], b"https://x/y");
        // seller_fee_basis_points, then creators/collection/uses = None
        assert_eq!(&data[34..36], &0u16.to_le_bytes());
        assert_eq!(&data[36..39], &[0, 0, 0]);
        assert_eq!(data[39], 1); // is_mutable
        assert_eq!(data[40], 0); // collection_details: None
        assert_eq!(data.len(), 41);
    }

    #[test]
    fn metadata_pda_matches_metaplex_derivation() {
        // Kaiju88's mint and the metadata PDA that mainnet reports for it.
        let mint = "YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9"
            .parse::<Pubkey>()
            .unwrap();
        let (pda, _) = metadata_address(&mint);
        assert_eq!(
            pda.to_string(),
            "9fQZEUBYgJVLdDuZb5PEBagUNHSdQjQwGuF79DWLKuC9"
        );
    }

    #[test]
    fn base58_matches_solana_rendering() {
        // Round-trip through Pubkey's own Display, which is the reference.
        for seed in 0u8..16 {
            let key = Pubkey::new_from_array([seed; 32]);
            assert_eq!(base58_encode_pubkey(&key.to_bytes()), key.to_string());
        }
        let kaiju = "YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9"
            .parse::<Pubkey>()
            .unwrap();
        assert_eq!(base58_encode_pubkey(&kaiju.to_bytes()), kaiju.to_string());
        // All-zero key: every byte is a leading zero, so the result is 32 '1's.
        assert_eq!(base58_encode_pubkey(&[0u8; 32]), "1".repeat(32));
        // A single leading zero byte must survive as exactly one '1'.
        let mut one_zero = [7u8; 32];
        one_zero[0] = 0;
        let expected = Pubkey::new_from_array(one_zero).to_string();
        assert_eq!(base58_encode_pubkey(&one_zero), expected);
        assert!(expected.starts_with('1'));
    }

    #[test]
    fn derived_uri_is_absolute_and_within_the_metaplex_cap() {
        let kaiju = "YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9"
            .parse::<Pubkey>()
            .unwrap();
        let uri = build_metadata_uri(&kaiju);
        assert_eq!(
            uri,
            "https://api.memewar.zone/api/token-metadata/101/YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9"
        );
        assert!(uri.starts_with("https://"));
        // Worst case is the longest possible base58 pubkey.
        assert!(build_metadata_uri(&Pubkey::new_from_array([255u8; 32])).len() <= MAX_URI_LENGTH);
    }

    #[test]
    fn field_caps_are_metaplex_caps() {
        assert!(validate_metadata_fields("n", "s", "u").is_ok());
        assert!(validate_metadata_fields("", "s", "u").is_err());
        assert!(validate_metadata_fields("n", "", "u").is_err());
        assert!(validate_metadata_fields("n", "s", "").is_err());
        assert!(validate_metadata_fields(&"n".repeat(33), "s", "u").is_err());
        assert!(validate_metadata_fields("n", &"s".repeat(11), "u").is_err());
        assert!(validate_metadata_fields("n", "s", &"u".repeat(201)).is_err());
    }
}

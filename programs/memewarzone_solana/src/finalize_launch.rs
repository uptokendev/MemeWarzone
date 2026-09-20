//! Finishing a launch: Metaplex metadata, mint authority revocation, fee accounts.
//!
//! These three steps used to live inside `create_campaign`. They were moved out
//! for one reason: transaction size. Phantom rewrites a transaction before it
//! signs, prepending ComputeBudget instructions and inserting Lighthouse
//! assertions for every account the transaction writes. A create that landed on
//! mainnet at 1181 bytes was handed to Phantom at 924 — Phantom used 257 bytes
//! of the 1232-byte packet limit for itself. Adding the metadata PDA, the fee
//! escrow and the creator fee vault to `create_campaign` pushed the unsigned
//! transaction to 1087 bytes, leaving 145 for a wallet that needed at least 257
//! and, with three more written accounts, rather more than that. Phantom could
//! not simulate, so it blocked the request as potentially malicious. Creators
//! saw a full-screen warning on every launch.
//!
//! Splitting the work restores `create_campaign` to the 14-account shape Phantom
//! has always accepted, and moves the expensive part into a transaction that
//! never goes near a wallet.
//!
//! The ordering constraint that made the original design tempting still holds:
//! `CreateMetadataAccountV3` requires the mint authority to sign, and revoking
//! that authority is irreversible. So metadata creation and revocation must stay
//! in the same instruction as each other — just not in the same instruction as
//! create. The campaign PDA is the mint authority and can sign whenever it is
//! asked to, so nothing forces that to be at create time.
//!
//! Between create and finalize a campaign is deliberately unusable: the fee
//! escrow does not exist yet, and every trade path already requires it. That is
//! what makes the window safe rather than merely short.
//!
//! # Why this is not permissionless
//!
//! The obvious design is to let anyone finalize, so the work cannot be stranded
//! by an offline keeper. It does not survive contact with an adversary. The name
//! and symbol have to come in as arguments — the program cannot recover them
//! from `Campaign.metadata_hash`, which is a hash of an off-chain JSON document
//! containing a draft id, a description and URLs. An attacker watching for
//! `create_campaign` could therefore call `finalize_campaign_launch` first with
//! a name of their choosing, and because revocation is one-way, the token would
//! carry that name in every wallet and aggregator forever.
//!
//! So finalize carries the same detached route authorization as create: an
//! ed25519 instruction immediately before it, signed by `GlobalConfig.route_signer`
//! over a digest that binds the campaign, the mint, the creator, the exact name
//! and symbol, and a deadline. Front-running it requires the route signer's key.
//!
//! Stranding is handled by retry rather than by openness: the signature is
//! reusable until its deadline, and the keeper reissues one afterwards.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program_option::COption,
    program_pack::Pack,
    sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_spl::token::{self, spl_token::state::Mint as SplMint, SetAuthority};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use crate::authorized_create::{
    create_program_account, verify_detached_create_authorization, Campaign, CAMPAIGN_MINT_SEED,
    CAMPAIGN_SEED,
};
use crate::fee_escrow::{CREATOR_FEE_VAULT_SEED, FEE_ESCROW_SEED};
use crate::token_metadata::{MAX_NAME_LENGTH, MAX_SYMBOL_LENGTH, MPL_TOKEN_METADATA_ID};
use crate::{GlobalConfig, LaunchpadError, GLOBAL_CONFIG_SEED};

/// Distinct from `CREATE_AUTH_DOMAIN` so a create signature can never be
/// replayed as a finalize signature, or the reverse.
pub const FINALIZE_LAUNCH_DOMAIN: &[u8] = b"MEMEWARZONE_SOLANA_FINALIZE_LAUNCH_V1";
pub const FINALIZE_LAUNCH_SCHEMA_VERSION: u16 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FinalizeCampaignLaunchArgs {
    /// Metaplex on-chain name. Capped at MAX_NAME_LENGTH.
    pub name: String,
    /// Metaplex on-chain symbol. Capped at MAX_SYMBOL_LENGTH.
    pub symbol: String,
    pub deadline: i64,
}

/// Build the message the route signer signs.
///
/// Name and symbol are length-prefixed so that ("ab", "c") and ("a", "bc")
/// cannot produce the same message. Only the 32-byte digest of this travels in
/// the transaction, so binding fields generously here costs nothing on the wire.
pub fn build_finalize_launch_message(
    program_id: &Pubkey,
    campaign: &Pubkey,
    mint: &Pubkey,
    creator: &Pubkey,
    campaign_id: &[u8; 32],
    args: &FinalizeCampaignLaunchArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(
        FINALIZE_LAUNCH_DOMAIN.len() + 2 + 32 * 5 + 8 + args.name.len() + args.symbol.len() + 8,
    );
    message.extend_from_slice(FINALIZE_LAUNCH_DOMAIN);
    message.extend_from_slice(&FINALIZE_LAUNCH_SCHEMA_VERSION.to_le_bytes());
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(campaign.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.extend_from_slice(creator.as_ref());
    message.extend_from_slice(campaign_id.as_ref());
    message.extend_from_slice(&(args.name.len() as u32).to_le_bytes());
    message.extend_from_slice(args.name.as_bytes());
    message.extend_from_slice(&(args.symbol.len() as u32).to_le_bytes());
    message.extend_from_slice(args.symbol.as_bytes());
    message.extend_from_slice(&args.deadline.to_le_bytes());
    message
}

#[derive(Accounts)]
pub struct FinalizeCampaignLaunch<'info> {
    /// Pays rent for the metadata account, the fee escrow and the creator fee
    /// vault. Any funded wallet will do — the route signature, not the payer,
    /// is what authorizes this.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: global config PDA; typed load in the handler.
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: campaign PDA; seeds verified against the decoded campaign_id.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: mint PDA; seeds checked in the handler.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA; address derived and verified in the handler.
    #[account(mut)]
    pub token_metadata: UncheckedAccount<'info>,
    /// CHECK: pinned to MPL_TOKEN_METADATA_ID in the handler.
    pub token_metadata_program: UncheckedAccount<'info>,
    /// CHECK: per-campaign fee escrow PDA; created here.
    #[account(mut, seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()], bump)]
    pub fee_escrow: UncheckedAccount<'info>,
    /// CHECK: per-campaign creator fee vault PDA; created here.
    #[account(mut, seeds = [CREATOR_FEE_VAULT_SEED, campaign.key().as_ref()], bump)]
    pub creator_fee_vault: UncheckedAccount<'info>,
    /// CHECK: pinned to the Instructions sysvar so the ed25519 instruction can
    /// be read back.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: System program.
    pub system_program: UncheckedAccount<'info>,
}

pub fn finalize_campaign_launch_handler(
    ctx: Context<FinalizeCampaignLaunch>,
    args: FinalizeCampaignLaunchArgs,
) -> Result<()> {
    require!(
        !args.name.is_empty() && args.name.len() <= MAX_NAME_LENGTH,
        LaunchpadError::InvalidMetadata
    );
    require!(
        !args.symbol.is_empty() && args.symbol.len() <= MAX_SYMBOL_LENGTH,
        LaunchpadError::InvalidMetadata
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        args.deadline > now,
        LaunchpadError::CreateAuthorizationExpired
    );

    let global_config = {
        let data = ctx.accounts.global_config.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        GlobalConfig::try_deserialize(&mut slice)?
    };
    require!(!global_config.paused, LaunchpadError::LaunchpadPaused);

    let campaign_info = ctx.accounts.campaign.to_account_info();
    let campaign_state = {
        let data = campaign_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        Campaign::try_deserialize(&mut slice)?
    };
    require_keys_eq!(
        *campaign_info.owner,
        crate::id(),
        LaunchpadError::InvalidCampaign
    );

    // Seeds, not just the stored pubkeys: an attacker supplying a look-alike
    // campaign account would otherwise get to pick the mint this writes to.
    let (expected_campaign, _) = Pubkey::find_program_address(
        &[CAMPAIGN_SEED, campaign_state.campaign_id.as_ref()],
        &crate::id(),
    );
    require_keys_eq!(
        expected_campaign,
        campaign_info.key(),
        LaunchpadError::InvalidCampaign
    );
    let (expected_mint, _) = Pubkey::find_program_address(
        &[CAMPAIGN_MINT_SEED, campaign_state.campaign_id.as_ref()],
        &crate::id(),
    );
    require_keys_eq!(
        expected_mint,
        ctx.accounts.mint.key(),
        LaunchpadError::InvalidCampaign
    );
    require_keys_eq!(
        campaign_state.mint,
        ctx.accounts.mint.key(),
        LaunchpadError::InvalidCampaign
    );

    // Idempotency comes from the mint itself, checked below, not from
    // Campaign.mint_authority_revoked. That field is a cached claim, and it has
    // already been wrong once: create_campaign wrote it true while the authority
    // was still held, which would have made every launch unfinishable if this
    // gate trusted it. The mint either still has an authority to revoke or it
    // does not, and that answer cannot drift from reality.
    require!(
        ctx.accounts.token_metadata.data_is_empty(),
        LaunchpadError::InvalidMetadata
    );
    // Deliberately NOT requiring these to be empty. initialize_fee_escrow and
    // initialize_creator_fee_vault are permissionless, and the indexer's fee
    // escrow worker calls them for any campaign that lacks one. It wins that
    // race often enough that demanding a clean slate here made finalize
    // impossible: the escrow already existed, finalize refused, and the token
    // was left unnamed with no way to fix it. Create what is missing, verify
    // what is already there.

    let expected_message = build_finalize_launch_message(
        &crate::id(),
        &campaign_info.key(),
        &ctx.accounts.mint.key(),
        &campaign_state.creator,
        &campaign_state.campaign_id,
        &args,
    );
    verify_detached_create_authorization(
        &ctx.accounts.instructions.to_account_info(),
        global_config.route_signer,
        &expected_message,
    )?;

    let mint_info = ctx.accounts.mint.to_account_info();
    verify_mint_authority_is_campaign(&mint_info, &campaign_info.key())?;

    let campaign_bump = [campaign_state.bump];
    let campaign_id_ref = campaign_state.campaign_id;
    let campaign_seeds: &[&[u8]] = &[CAMPAIGN_SEED, campaign_id_ref.as_ref(), &campaign_bump];
    let campaign_signer: &[&[&[u8]]] = &[campaign_seeds];

    // Metadata first: it needs the mint authority that the next call destroys.
    crate::token_metadata::create_campaign_metadata(
        &ctx.accounts.token_metadata.to_account_info(),
        &mint_info,
        &campaign_info,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_metadata_program.to_account_info(),
        campaign_signer,
        &args.name,
        &args.symbol,
    )?;

    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                account_or_mint: mint_info.clone(),
                current_authority: campaign_info.clone(),
            },
            campaign_signer,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    verify_token_metadata_created(&ctx.accounts.token_metadata.to_account_info())?;
    verify_mint_authority_revoked(&mint_info)?;

    ensure_campaign_fee_accounts(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.fee_escrow.to_account_info(),
        &ctx.accounts.creator_fee_vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        campaign_info.key(),
        campaign_state.creator,
        ctx.bumps.fee_escrow,
        ctx.bumps.creator_fee_vault,
    )?;

    {
        let mut updated = campaign_state;
        updated.mint_authority_revoked = true;
        let mut data = campaign_info.try_borrow_mut_data()?;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        updated.try_serialize(&mut cursor)?;
    }

    Ok(())
}

/// Create whichever fee accounts are missing, and check the ones that are not.
///
/// Both are PDAs of this program, so an account that already exists was created
/// by us — by create_campaign before V6, or by the permissionless initializers
/// the indexer's worker calls. That makes skipping it safe. The checks below are
/// not about trust, they are about catching a campaign/creator mismatch that
/// would otherwise route this campaign's fees to another campaign's escrow.
fn ensure_campaign_fee_accounts<'info>(
    payer: &AccountInfo<'info>,
    fee_escrow: &AccountInfo<'info>,
    creator_fee_vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    campaign: Pubkey,
    creator: Pubkey,
    fee_escrow_bump: u8,
    creator_fee_vault_bump: u8,
) -> Result<()> {
    if fee_escrow.data_is_empty() {
        create_fee_escrow(payer, fee_escrow, system_program, campaign, fee_escrow_bump)?;
    } else {
        require_keys_eq!(*fee_escrow.owner, crate::id(), LaunchpadError::InvalidFeeEscrow);
        let data = fee_escrow.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let existing = crate::FeeEscrow::try_deserialize(&mut slice)
            .map_err(|_| error!(LaunchpadError::InvalidFeeEscrow))?;
        require_keys_eq!(existing.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
    }

    if creator_fee_vault.data_is_empty() {
        create_creator_fee_vault(
            payer,
            creator_fee_vault,
            system_program,
            campaign,
            creator,
            creator_fee_vault_bump,
        )?;
    } else {
        require_keys_eq!(*creator_fee_vault.owner, crate::id(), LaunchpadError::InvalidFeeEscrow);
        let data = creator_fee_vault.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let existing = crate::CreatorFeeVault::try_deserialize(&mut slice)
            .map_err(|_| error!(LaunchpadError::InvalidFeeEscrow))?;
        require_keys_eq!(existing.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
        require_keys_eq!(existing.creator, creator, LaunchpadError::InvalidFeeEscrow);
    }
    Ok(())
}

fn create_fee_escrow<'info>(
    payer: &AccountInfo<'info>,
    fee_escrow: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    campaign: Pubkey,
    bump: u8,
) -> Result<()> {
    let campaign_ref = campaign.as_ref();
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, campaign_ref, &bump_seed];
    create_program_account(
        payer,
        fee_escrow,
        system_program,
        8 + crate::FeeEscrow::INIT_SPACE,
        seeds,
    )?;
    let escrow = crate::FeeEscrow {
        campaign,
        weekly_pending: 0,
        monthly_pending: 0,
        recruiter_pending: 0,
        airdrop_pending: 0,
        squad_pending: 0,
        protocol_pending: 0,
        total_received: 0,
        total_flushed: 0,
        bump,
        version: crate::FEE_ESCROW_VERSION,
    };
    let mut data = fee_escrow.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    escrow.try_serialize(&mut cursor)?;
    Ok(())
}

fn create_creator_fee_vault<'info>(
    payer: &AccountInfo<'info>,
    creator_fee_vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    campaign: Pubkey,
    creator: Pubkey,
    bump: u8,
) -> Result<()> {
    let campaign_ref = campaign.as_ref();
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[CREATOR_FEE_VAULT_SEED, campaign_ref, &bump_seed];
    create_program_account(
        payer,
        creator_fee_vault,
        system_program,
        8 + crate::CreatorFeeVault::INIT_SPACE,
        seeds,
    )?;
    let vault = crate::CreatorFeeVault {
        campaign,
        creator,
        pending_lamports: 0,
        total_received: 0,
        total_claimed: 0,
        bump,
        version: crate::CREATOR_FEE_VAULT_VERSION,
    };
    let mut data = creator_fee_vault.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    vault.try_serialize(&mut cursor)?;
    Ok(())
}

/// The campaign PDA must still hold the mint authority, or the metadata CPI
/// below would fail anyway — but with a confusing Metaplex error rather than
/// one that says which invariant broke.
fn verify_mint_authority_is_campaign(mint_info: &AccountInfo<'_>, campaign: &Pubkey) -> Result<()> {
    let state = {
        let data = mint_info.try_borrow_data()?;
        SplMint::unpack(&data)?
    };
    require!(
        state.mint_authority == COption::Some(*campaign),
        LaunchpadError::InvalidCampaign
    );
    Ok(())
}

fn verify_token_metadata_created(metadata_info: &AccountInfo<'_>) -> Result<()> {
    require!(
        metadata_info.owner == &MPL_TOKEN_METADATA_ID,
        LaunchpadError::InvalidMetadata
    );
    require!(
        !metadata_info.data_is_empty(),
        LaunchpadError::InvalidMetadata
    );
    Ok(())
}

fn verify_mint_authority_revoked(mint_info: &AccountInfo<'_>) -> Result<()> {
    let state = {
        let data = mint_info.try_borrow_data()?;
        SplMint::unpack(&data)?
    };
    require!(
        state.mint_authority == COption::None,
        LaunchpadError::InvalidCampaign
    );
    require!(
        state.freeze_authority == COption::None,
        LaunchpadError::InvalidCampaign
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(name: &str, symbol: &str, deadline: i64) -> FinalizeCampaignLaunchArgs {
        FinalizeCampaignLaunchArgs {
            name: name.to_string(),
            symbol: symbol.to_string(),
            deadline,
        }
    }

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn message_for(name: &str, symbol: &str) -> Vec<u8> {
        build_finalize_launch_message(
            &key(1),
            &key(2),
            &key(3),
            &key(4),
            &[5u8; 32],
            &args(name, symbol, 1_800_000_000),
        )
    }

    /// The whole reason finalize is authorized rather than open: if the signed
    /// message did not pin the name, a front-runner could name the token.
    #[test]
    fn a_different_name_is_a_different_message() {
        assert_ne!(message_for("Kaiju", "KAIJU"), message_for("Kaijo", "KAIJU"));
        assert_ne!(message_for("Kaiju", "KAIJU"), message_for("Kaiju", "KAIJO"));
    }

    /// Without length prefixes, ("ab","c") and ("a","bc") would serialize into
    /// the same bytes and one signature would authorize both.
    #[test]
    fn name_and_symbol_boundaries_cannot_be_shifted() {
        assert_ne!(message_for("ab", "c"), message_for("a", "bc"));
        assert_ne!(message_for("", "abc"), message_for("abc", ""));
    }

    #[test]
    fn every_bound_field_changes_the_message() {
        let base = build_finalize_launch_message(
            &key(1),
            &key(2),
            &key(3),
            &key(4),
            &[5u8; 32],
            &args("Kaiju", "KAIJU", 1_800_000_000),
        );
        let cases = vec![
            (
                "program",
                build_finalize_launch_message(
                    &key(9),
                    &key(2),
                    &key(3),
                    &key(4),
                    &[5u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_000),
                ),
            ),
            (
                "campaign",
                build_finalize_launch_message(
                    &key(1),
                    &key(9),
                    &key(3),
                    &key(4),
                    &[5u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_000),
                ),
            ),
            (
                "mint",
                build_finalize_launch_message(
                    &key(1),
                    &key(2),
                    &key(9),
                    &key(4),
                    &[5u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_000),
                ),
            ),
            (
                "creator",
                build_finalize_launch_message(
                    &key(1),
                    &key(2),
                    &key(3),
                    &key(9),
                    &[5u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_000),
                ),
            ),
            (
                "campaign_id",
                build_finalize_launch_message(
                    &key(1),
                    &key(2),
                    &key(3),
                    &key(4),
                    &[9u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_000),
                ),
            ),
            (
                "deadline",
                build_finalize_launch_message(
                    &key(1),
                    &key(2),
                    &key(3),
                    &key(4),
                    &[5u8; 32],
                    &args("Kaiju", "KAIJU", 1_800_000_001),
                ),
            ),
        ];
        for (field, other) in cases {
            assert_ne!(base, other, "{field} is not bound into the signed message");
        }
    }

    /// A create signature must never be spendable as a finalize signature.
    #[test]
    fn the_domain_is_distinct_from_create() {
        assert_ne!(
            FINALIZE_LAUNCH_DOMAIN,
            crate::authorized_create::CREATE_AUTH_DOMAIN
        );
        assert!(message_for("Kaiju", "KAIJU").starts_with(FINALIZE_LAUNCH_DOMAIN));
    }

    /// Cross-language vector. The backend builds this message in JavaScript and
    /// the program rebuilds it here; if the two ever drift, finalize stops
    /// verifying and every new launch is stranded unnamed. Pinning the digest on
    /// both sides turns that into a failing test instead of a production outage.
    /// The JavaScript side asserts the same hex in
    /// frontend/api/dev-fix/solana-v4-primitives.test.mjs.
    #[test]
    fn the_signed_message_matches_the_backend_byte_for_byte() {
        use anchor_lang::solana_program::hash::hash;
        let message = build_finalize_launch_message(
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([2u8; 32]),
            &Pubkey::new_from_array([3u8; 32]),
            &Pubkey::new_from_array([4u8; 32]),
            &[5u8; 32],
            &args("Kaiju88", "K88", 1_800_000_000),
        );
        assert_eq!(message.len(), 225, "payload length drifted from the backend");
        let digest = hash(&message).to_bytes();
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "20f2cb27694797eb37c3131d0f553954110f4bba0b2a0478f57a40305a8a544d",
        );
    }

    /// create_campaign must leave this false, because finalize refuses a
    /// campaign already marked revoked and the revocation is what sets it.
    ///
    /// It was true for as long as create did the revoking itself, in the same
    /// atomic transaction. Splitting the two made the flag a lie: no V6 launch
    /// could be finalized, and anything reading it to mean "supply is fixed"
    /// was wrong while the campaign PDA could still mint. A grep is the honest
    /// test here — the value is a literal in a struct this crate builds, not
    /// something reachable without a running bank.
    #[test]
    fn create_campaign_does_not_claim_the_authority_is_revoked() {
        let source = include_str!("authorized_create.rs");
        let account_start = source
            .find("Box::new(Campaign {")
            .expect("create_campaign must build the Campaign account");
        let account_end = source[account_start..]
            .find("\n    });")
            .expect("unterminated Campaign literal")
            + account_start;
        let account = &source[account_start..account_end];
        assert!(
            account.contains("mint_authority_revoked: false"),
            "create_campaign writes the campaign as already revoked; finalize will refuse every launch",
        );
        assert!(
            !account.contains("mint_authority_revoked: true"),
            "create_campaign still claims the mint authority is revoked",
        );

        let event_start = source
            .find("emit!(CampaignCreated {")
            .expect("create_campaign must emit CampaignCreated");
        let event_end = source[event_start..]
            .find("\n    });")
            .expect("unterminated CampaignCreated literal")
            + event_start;
        assert!(
            source[event_start..event_end].contains("mint_authority_revoked: false"),
            "the created event disagrees with the account it describes",
        );
    }

    /// Finalizing twice must fail, and must fail on chain state rather than on
    /// the cached flag. A campaign whose flag says revoked but whose mint still
    /// has an authority is exactly the state V6 shipped, and it has to remain
    /// finishable.
    #[test]
    fn idempotency_is_gated_on_the_mint_not_the_cached_flag() {
        let source = include_str!("finalize_launch.rs");
        let handler_start = source
            .find("pub fn finalize_campaign_launch_handler")
            .expect("handler must exist");
        let handler = &source[handler_start..];
        let body_end = handler.find("\nfn ").unwrap_or(handler.len());
        let body = &handler[..body_end];
        assert!(
            !body.contains("!campaign_state.mint_authority_revoked"),
            "finalize gates on the cached flag; a campaign created with it wrongly set can never be finished",
        );
        assert!(
            body.contains("verify_mint_authority_is_campaign"),
            "finalize must check the mint still has an authority to revoke",
        );
    }

    /// The only place that may set it true is finalize, and only after the
    /// revocation it verifies.
    #[test]
    fn finalize_sets_the_flag_only_after_revoking() {
        let source = include_str!("finalize_launch.rs");
        let revoke = source
            .find("verify_mint_authority_revoked(&mint_info)?")
            .expect("finalize must verify the revocation");
        let set = source
            .find("updated.mint_authority_revoked = true")
            .expect("finalize must record the revocation");
        assert!(revoke < set, "the flag is recorded before the revocation is verified");
    }

    #[test]
    fn metaplex_limits_are_what_the_handler_enforces() {
        assert_eq!(MAX_NAME_LENGTH, 32);
        assert_eq!(MAX_SYMBOL_LENGTH, 10);
        let long = "A".repeat(MAX_NAME_LENGTH);
        let message = message_for(&long, "SYMBOL1234");
        assert!(message.len() > FINALIZE_LAUNCH_DOMAIN.len());
    }
}

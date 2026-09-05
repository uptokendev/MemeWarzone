use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use super::config::ARENA_MONEY_GENERATION_V2;
use super::errors::ArenaMoneyV2Error;

pub const COMPETITION_ENTRY_RECEIPT_SEED_V2: &[u8] = b"arena_money_entry_v2";
pub const BOOST_RECEIPT_SEED_V2: &[u8] = b"arena_money_boost_v2";
pub const LEAGUE_SOURCE_RECEIPT_SEED_V2: &[u8] = b"arena_money_league_src_v2";
pub const SPONSORSHIP_RECEIPT_SEED_V1: &[u8] = b"arena_sponsor_receipt_v1";

#[account]
pub struct CompetitionEntryReceiptV2 {
    pub generation: u8,
    pub competition_id: [u8; 32],
    pub entrant: Pubkey,
    pub entry_asset: Pubkey,
    pub amount_lamports: u64,
    pub created_at: i64,
    pub refunded: bool,
    pub bump: u8,
}
impl CompetitionEntryReceiptV2 {
    pub const SIZE: usize = 1 + 32 + 32 + 32 + 8 + 8 + 1 + 1;
}

#[account]
pub struct BoostReceiptV2 {
    pub generation: u8,
    pub competition_id: [u8; 32],
    pub funding_id: [u8; 32],
    pub funder: Pubkey,
    pub gross_lamports: u64,
    pub prize_lamports: u64,
    pub protocol_lamports: u64,
    pub created_at: i64,
    pub refunded: bool,
    pub bump: u8,
}
impl BoostReceiptV2 {
    pub const SIZE: usize = 1 + 32 + 32 + 32 + 8 * 4 + 1 + 1;
}

#[account]
pub struct LeagueSourceReceiptV2 {
    pub generation: u8,
    pub source_id: [u8; 32],
    pub source_kind: u8,
    pub amount_lamports: u64,
    pub monthly_lamports: u64,
    pub quarterly_lamports: u64,
    pub created_at: i64,
    pub bump: u8,
}
impl LeagueSourceReceiptV2 {
    pub const SIZE: usize = 1 + 32 + 1 + 8 * 4 + 1;
}

#[account]
pub struct SponsorshipReceiptV1 {
    pub generation: u8,
    pub event_id: [u8; 32],
    pub payment_id: [u8; 32],
    pub sponsor: Pubkey,
    pub gross_lamports: u64,
    pub prize_lamports: u64,
    pub marketing_lamports: u64,
    pub protocol_lamports: u64,
    pub created_at: i64,
    pub bump: u8,
}
impl SponsorshipReceiptV1 {
    pub const SIZE: usize = 1 + 32 + 32 + 32 + 8 * 5 + 1;
}

pub fn validate_competition_entry_receipt_v2(
    receipt_info: &AccountInfo,
    competition_id: [u8; 32],
    entry_asset: Pubkey,
    entrant: Pubkey,
    expected_amount_lamports: u64,
) -> Result<()> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[
            COMPETITION_ENTRY_RECEIPT_SEED_V2,
            competition_id.as_ref(),
            entry_asset.as_ref(),
            entrant.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(expected_pda, receipt_info.key(), ArenaMoneyV2Error::ReceiptMismatch);
    require_keys_eq!(*receipt_info.owner, crate::ID, ArenaMoneyV2Error::ReceiptMismatch);
    let data = receipt_info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let receipt = CompetitionEntryReceiptV2::try_deserialize(&mut slice)
        .map_err(|_| error!(ArenaMoneyV2Error::ReceiptMismatch))?;
    require!(receipt.generation == ARENA_MONEY_GENERATION_V2, ArenaMoneyV2Error::GenerationMismatch);
    require!(
        receipt.competition_id == competition_id
            && receipt.entry_asset == entry_asset
            && receipt.entrant == entrant
            && receipt.amount_lamports == expected_amount_lamports
            && !receipt.refunded,
        ArenaMoneyV2Error::ReceiptMismatch
    );
    Ok(())
}

pub fn transfer_sol<'info>(
    payer: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    require!(lamports > 0, ArenaMoneyV2Error::InvalidAmount);
    invoke(
        &system_instruction::transfer(payer.key, destination.key, lamports),
        &[payer.clone(), destination.clone(), system_program.clone()],
    )?;
    Ok(())
}

pub fn debit_program_vault(vault: &AccountInfo, receiver: &AccountInfo, lamports: u64, data_size: usize) -> Result<()> {
    require!(lamports > 0, ArenaMoneyV2Error::InvalidAmount);
    let rent_reserve = Rent::get()?.minimum_balance(8 + data_size);
    require!(
        vault.lamports().saturating_sub(rent_reserve) >= lamports,
        ArenaMoneyV2Error::InsufficientVaultBalance
    );
    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(lamports)
        .ok_or(ArenaMoneyV2Error::InsufficientVaultBalance)?;
    **receiver.try_borrow_mut_lamports()? = receiver
        .lamports()
        .checked_add(lamports)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?;
    Ok(())
}

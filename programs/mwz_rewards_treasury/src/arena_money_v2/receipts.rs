use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

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

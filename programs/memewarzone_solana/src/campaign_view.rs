//! Bounded Campaign account view for Mainnet Agave.
//!
//! Full `Campaign::try_deserialize()` exceeds the effective 4KB SBF frame when
//! account-data direct mapping is off (live Mainnet / Agave `--clone-feature-set`).
//! Trade and graduation only need this subset, read from fixed Borsh offsets of
//! the 720-byte account (8-byte Anchor discriminator + 712-byte payload).

use anchor_lang::prelude::*;

use crate::{authorized_create::Campaign, LaunchpadError};

pub const CAMPAIGN_ACCOUNT_BYTES: usize = 720;

pub const CAMPAIGN_ID_OFFSET: usize = 8;
pub const CAMPAIGN_GENERATION_ID_OFFSET: usize = 40;
pub const CAMPAIGN_GENERATION_CONFIG_OFFSET: usize = 72;
pub const CAMPAIGN_CREATOR_OFFSET: usize = 136;
pub const CAMPAIGN_MINT_OFFSET: usize = 168;
pub const CAMPAIGN_TOKEN_VAULT_OFFSET: usize = 200;
pub const CAMPAIGN_SOL_VAULT_OFFSET: usize = 232;
pub const CAMPAIGN_LAUNCH_AT_OFFSET: usize = 400;
pub const CAMPAIGN_GRADUATION_TARGET_OFFSET: usize = 408;
pub const CAMPAIGN_ECONOMICS_VERSION_OFFSET: usize = 417;
pub const CAMPAIGN_CURVE_KIND_OFFSET: usize = 419;
pub const CAMPAIGN_CURVE_SUPPLY_OFFSET: usize = 428;
pub const CAMPAIGN_LIQUIDITY_TOKEN_SUPPLY_OFFSET: usize = 436;
pub const CAMPAIGN_RESERVE_TOKEN_SUPPLY_OFFSET: usize = 444;
pub const CAMPAIGN_TOKEN_DECIMALS_OFFSET: usize = 452;
pub const CAMPAIGN_BASE_PRICE_OFFSET: usize = 457;
pub const CAMPAIGN_PRICE_SLOPE_OFFSET: usize = 465;
pub const CAMPAIGN_BUY_FEE_OFFSET: usize = 473;
pub const CAMPAIGN_SELL_FEE_OFFSET: usize = 475;
pub const CAMPAIGN_FINALIZE_FEE_OFFSET: usize = 477;
pub const CAMPAIGN_LIQUIDITY_POST_FINALIZE_OFFSET: usize = 481;
pub const CAMPAIGN_DEX_ADAPTER_OFFSET: usize = 483;
pub const CAMPAIGN_CREATOR_LOCK_OFFSET: usize = 644;
pub const CAMPAIGN_CREATOR_CAP_OFFSET: usize = 652;
pub const CAMPAIGN_SOLD_TOKENS_OFFSET: usize = 662;
pub const CAMPAIGN_NET_RAISED_OFFSET: usize = 670;
pub const CAMPAIGN_BUY_VOLUME_OFFSET: usize = 678;
pub const CAMPAIGN_SELL_VOLUME_OFFSET: usize = 686;
pub const CAMPAIGN_BUYER_COUNT_OFFSET: usize = 694;
pub const CAMPAIGN_CREATOR_BOUGHT_OFFSET: usize = 702;
/// Written by create_campaign once the revocation it performs has been
/// verified. Never read as a gate: it is a cached claim about the mint, and
/// create_campaign shipped it set while the authority was still held.
pub const CAMPAIGN_MINT_AUTHORITY_REVOKED_OFFSET: usize = 712;
pub const CAMPAIGN_GRADUATED_OFFSET: usize = 713;
pub const CAMPAIGN_CURVE_CLOSED_OFFSET: usize = 714;
pub const CAMPAIGN_PAUSED_OFFSET: usize = 715;
pub const CAMPAIGN_BUMP_OFFSET: usize = 716;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CampaignView {
    pub campaign_id: [u8; 32],
    pub generation_id: [u8; 32],
    pub generation_config: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
    pub launch_at: i64,
    pub graduation_target_usd_micros: u64,
    pub economics_version: u16,
    pub curve_kind: u8,
    pub curve_token_supply: u64,
    pub liquidity_token_supply: u64,
    pub reserve_token_supply: u64,
    pub token_decimals: u8,
    pub base_price_lamports: u64,
    pub price_slope_lamports: u64,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub finalize_fee_bps: u16,
    pub liquidity_post_finalize_bps: u16,
    pub dex_adapter: u8,
    pub creator_buy_lock_until: i64,
    pub creator_buy_cap_bps: u16,
    pub sold_tokens: u64,
    pub net_raised_lamports: u64,
    pub creator_bought_tokens: u64,
    pub graduated: bool,
    pub curve_closed: bool,
    pub paused: bool,
    pub bump: u8,
}

pub(crate) fn data_range<'a>(data: &'a [u8], offset: usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidCampaign);
    Ok(&data[offset..end])
}

pub(crate) fn read_u8(data: &[u8], offset: usize) -> Result<u8> {
    Ok(*data_range(data, offset, 1)?
        .first()
        .ok_or(LaunchpadError::InvalidCampaign)?)
}

pub(crate) fn read_bool(data: &[u8], offset: usize) -> Result<bool> {
    let value = read_u8(data, offset)?;
    require!(value <= 1, LaunchpadError::InvalidCampaign);
    Ok(value == 1)
}

pub(crate) fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let raw = data_range(data, offset, 2)?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

pub(crate) fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let raw = data_range(data, offset, 8)?;
    Ok(u64::from_le_bytes(
        raw.try_into()
            .map_err(|_| error!(LaunchpadError::InvalidCampaign))?,
    ))
}

pub(crate) fn read_i64(data: &[u8], offset: usize) -> Result<i64> {
    let raw = data_range(data, offset, 8)?;
    Ok(i64::from_le_bytes(
        raw.try_into()
            .map_err(|_| error!(LaunchpadError::InvalidCampaign))?,
    ))
}

pub(crate) fn read_32(data: &[u8], offset: usize) -> Result<[u8; 32]> {
    data_range(data, offset, 32)?
        .try_into()
        .map_err(|_| error!(LaunchpadError::InvalidCampaign))
}

pub(crate) fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    Ok(Pubkey::new_from_array(read_32(data, offset)?))
}

pub(crate) fn assert_campaign_data(data: &[u8]) -> Result<()> {
    require!(
        data.len() >= CAMPAIGN_ACCOUNT_BYTES,
        LaunchpadError::InvalidCampaign
    );
    require!(
        data.get(..8) == Some(<Campaign as anchor_lang::Discriminator>::DISCRIMINATOR.as_ref()),
        LaunchpadError::InvalidCampaign
    );
    Ok(())
}

pub(crate) fn write_u64(data: &mut [u8], offset: usize, value: u64) -> Result<()> {
    let end = offset.checked_add(8).ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidCampaign);
    data[offset..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

pub(crate) fn write_u8(data: &mut [u8], offset: usize, value: u8) -> Result<()> {
    require!(offset < data.len(), LaunchpadError::InvalidCampaign);
    data[offset] = value;
    Ok(())
}

pub(crate) fn campaign_view_from_bytes(data: &[u8]) -> Result<CampaignView> {
    assert_campaign_data(data)?;
    Ok(CampaignView {
        campaign_id: read_32(data, CAMPAIGN_ID_OFFSET)?,
        generation_id: read_32(data, CAMPAIGN_GENERATION_ID_OFFSET)?,
        generation_config: read_pubkey(data, CAMPAIGN_GENERATION_CONFIG_OFFSET)?,
        creator: read_pubkey(data, CAMPAIGN_CREATOR_OFFSET)?,
        mint: read_pubkey(data, CAMPAIGN_MINT_OFFSET)?,
        token_vault: read_pubkey(data, CAMPAIGN_TOKEN_VAULT_OFFSET)?,
        sol_vault: read_pubkey(data, CAMPAIGN_SOL_VAULT_OFFSET)?,
        launch_at: read_i64(data, CAMPAIGN_LAUNCH_AT_OFFSET)?,
        graduation_target_usd_micros: read_u64(data, CAMPAIGN_GRADUATION_TARGET_OFFSET)?,
        economics_version: read_u16(data, CAMPAIGN_ECONOMICS_VERSION_OFFSET)?,
        curve_kind: read_u8(data, CAMPAIGN_CURVE_KIND_OFFSET)?,
        curve_token_supply: read_u64(data, CAMPAIGN_CURVE_SUPPLY_OFFSET)?,
        liquidity_token_supply: read_u64(data, CAMPAIGN_LIQUIDITY_TOKEN_SUPPLY_OFFSET)?,
        reserve_token_supply: read_u64(data, CAMPAIGN_RESERVE_TOKEN_SUPPLY_OFFSET)?,
        token_decimals: read_u8(data, CAMPAIGN_TOKEN_DECIMALS_OFFSET)?,
        base_price_lamports: read_u64(data, CAMPAIGN_BASE_PRICE_OFFSET)?,
        price_slope_lamports: read_u64(data, CAMPAIGN_PRICE_SLOPE_OFFSET)?,
        buy_fee_bps: read_u16(data, CAMPAIGN_BUY_FEE_OFFSET)?,
        sell_fee_bps: read_u16(data, CAMPAIGN_SELL_FEE_OFFSET)?,
        finalize_fee_bps: read_u16(data, CAMPAIGN_FINALIZE_FEE_OFFSET)?,
        liquidity_post_finalize_bps: read_u16(data, CAMPAIGN_LIQUIDITY_POST_FINALIZE_OFFSET)?,
        dex_adapter: read_u8(data, CAMPAIGN_DEX_ADAPTER_OFFSET)?,
        creator_buy_lock_until: read_i64(data, CAMPAIGN_CREATOR_LOCK_OFFSET)?,
        creator_buy_cap_bps: read_u16(data, CAMPAIGN_CREATOR_CAP_OFFSET)?,
        sold_tokens: read_u64(data, CAMPAIGN_SOLD_TOKENS_OFFSET)?,
        net_raised_lamports: read_u64(data, CAMPAIGN_NET_RAISED_OFFSET)?,
        creator_bought_tokens: read_u64(data, CAMPAIGN_CREATOR_BOUGHT_OFFSET)?,
        graduated: read_bool(data, CAMPAIGN_GRADUATED_OFFSET)?,
        curve_closed: read_bool(data, CAMPAIGN_CURVE_CLOSED_OFFSET)?,
        paused: read_bool(data, CAMPAIGN_PAUSED_OFFSET)?,
        bump: read_u8(data, CAMPAIGN_BUMP_OFFSET)?,
    })
}

#[inline(never)]
pub(crate) fn load_campaign_view(info: &AccountInfo) -> Result<CampaignView> {
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::InvalidCampaign);
    let data = info.try_borrow_data()?;
    campaign_view_from_bytes(&data)
}

#[inline(never)]
pub(crate) fn mark_campaign_graduated(info: &AccountInfo) -> Result<()> {
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::InvalidCampaign);
    let mut data = info.try_borrow_mut_data()?;
    assert_campaign_data(&data)?;
    write_u8(&mut data, CAMPAIGN_GRADUATED_OFFSET, 1)
}

#[allow(dead_code)]
pub(crate) fn campaign_view_from_campaign(campaign: &Campaign) -> CampaignView {
    CampaignView {
        campaign_id: campaign.campaign_id,
        generation_id: campaign.generation_id,
        generation_config: campaign.generation_config,
        creator: campaign.creator,
        mint: campaign.mint,
        token_vault: campaign.token_vault,
        sol_vault: campaign.sol_vault,
        launch_at: campaign.launch_at,
        graduation_target_usd_micros: campaign.graduation_target_usd_micros,
        economics_version: campaign.economics_version,
        curve_kind: campaign.curve_kind,
        curve_token_supply: campaign.curve_token_supply,
        liquidity_token_supply: campaign.liquidity_token_supply,
        reserve_token_supply: campaign.reserve_token_supply,
        token_decimals: campaign.token_decimals,
        base_price_lamports: campaign.base_price_lamports,
        price_slope_lamports: campaign.price_slope_lamports,
        buy_fee_bps: campaign.buy_fee_bps,
        sell_fee_bps: campaign.sell_fee_bps,
        finalize_fee_bps: campaign.finalize_fee_bps,
        liquidity_post_finalize_bps: campaign.liquidity_post_finalize_bps,
        dex_adapter: campaign.dex_adapter,
        creator_buy_lock_until: campaign.creator_buy_lock_until,
        creator_buy_cap_bps: campaign.creator_buy_cap_bps,
        sold_tokens: campaign.sold_tokens,
        net_raised_lamports: campaign.net_raised_lamports,
        creator_bought_tokens: campaign.creator_bought_tokens,
        graduated: campaign.graduated,
        curve_closed: campaign.curve_closed,
        paused: campaign.paused,
        bump: campaign.bump,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DEX_ADAPTER_METEORA_DAMM_V2, ECONOMICS_VERSION_V3, GRADUATION_TARGET_6_USD_MICROS,
    };

    fn sample_campaign() -> Campaign {
        Campaign {
            campaign_id: [1; 32],
            generation_id: [2; 32],
            generation_config: Pubkey::new_from_array([3; 32]),
            generation_manifest_hash: [4; 32],
            creator: Pubkey::new_from_array([5; 32]),
            mint: Pubkey::new_from_array([6; 32]),
            token_vault: Pubkey::new_from_array([7; 32]),
            sol_vault: Pubkey::new_from_array([8; 32]),
            metadata_hash: [9; 32],
            cluster_hash: [10; 32],
            ticker_hash: [11; 32],
            reservation_id_hash: [12; 32],
            reservation_version: 7,
            launch_at: 1_700_000_000,
            graduation_target_usd_micros: GRADUATION_TARGET_6_USD_MICROS,
            cluster_kind: 2,
            economics_version: ECONOMICS_VERSION_V3,
            curve_kind: 1,
            token_total_supply: 1_000_000_000_000_000,
            curve_token_supply: 840_000_000_000_000,
            liquidity_token_supply: 140_000_000_000_000,
            reserve_token_supply: 20_000_000_000_000,
            token_decimals: 6,
            curve_supply_bps: 8_400,
            liquidity_token_bps: 1_400,
            base_price_lamports: 1,
            price_slope_lamports: 850,
            buy_fee_bps: 200,
            sell_fee_bps: 200,
            finalize_fee_bps: 200,
            creator_post_finalize_bps: 2_000,
            liquidity_post_finalize_bps: 8_000,
            dex_adapter: DEX_ADAPTER_METEORA_DAMM_V2,
            trade_route_profile: [13; 32],
            finalize_route_profile: [14; 32],
            treasury_profile: [15; 32],
            dex_profile: [16; 32],
            oracle_profile: [17; 32],
            creator_buy_lock_until: 1_700_086_400,
            creator_buy_cap_bps: 1_000,
            created_at: 1_699_000_000,
            sold_tokens: 10_000_000_000_000,
            net_raised_lamports: 40_000_000,
            total_buy_volume_lamports: 41_000_000,
            total_sell_volume_lamports: 1_000_000,
            buyer_count: 4,
            creator_bought_tokens: 500_000_000,
            asset_initialization_version: 1,
            mint_authority_revoked: true,
            graduated: false,
            curve_closed: true,
            paused: false,
            bump: 255,
            mint_bump: 254,
            token_vault_bump: 253,
            sol_vault_bump: 252,
        }
    }

    #[test]
    fn campaign_account_is_exactly_720_bytes() {
        let campaign = sample_campaign();
        let mut data = Vec::new();
        campaign.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), CAMPAIGN_ACCOUNT_BYTES);
        assert_eq!(
            &data[..8],
            <Campaign as anchor_lang::Discriminator>::DISCRIMINATOR
        );
    }

    #[test]
    fn snapshot_offsets_match_serialized_campaign() {
        let campaign = sample_campaign();
        let mut data = Vec::new();
        campaign.try_serialize(&mut data).unwrap();
        let view = campaign_view_from_bytes(&data).unwrap();
        assert_eq!(view, campaign_view_from_campaign(&campaign));
        assert_eq!(view.sold_tokens, 10_000_000_000_000);
        assert_eq!(view.net_raised_lamports, 40_000_000);
        assert_eq!(view.graduated, false);
        assert_eq!(view.curve_closed, true);
        assert_eq!(view.paused, false);
        assert_eq!(view.bump, 255);
        assert_eq!(
            view.graduation_target_usd_micros,
            GRADUATION_TARGET_6_USD_MICROS
        );
        assert_eq!(view.liquidity_token_supply, 140_000_000_000_000);
        assert_eq!(view.dex_adapter, DEX_ADAPTER_METEORA_DAMM_V2);
    }

    #[test]
    fn mark_graduated_only_flips_the_graduated_byte() {
        let campaign = sample_campaign();
        let mut data = Vec::new();
        campaign.try_serialize(&mut data).unwrap();
        let before = data.clone();
        write_u8(&mut data, CAMPAIGN_GRADUATED_OFFSET, 1).unwrap();
        assert_eq!(data[CAMPAIGN_GRADUATED_OFFSET], 1);
        for (index, (left, right)) in before.iter().zip(data.iter()).enumerate() {
            if index == CAMPAIGN_GRADUATED_OFFSET {
                continue;
            }
            assert_eq!(left, right, "offset {index} mutated");
        }
        let view = campaign_view_from_bytes(&data).unwrap();
        assert!(view.graduated);
        assert_eq!(view.sold_tokens, campaign.sold_tokens);
        assert!(!view.paused);
    }
}

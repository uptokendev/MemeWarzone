//! Canonical fee envelope — same numbers as TreasuryRouterV3.previewTrade/previewFinalize.
//! Router bps are of the 2% fee, not of trade volume.

use anchor_lang::prelude::*;

pub const ROUTE_BPS: u16 = 10_000;
pub const ROUTE_KIND_TRADE: u8 = 0;
pub const ROUTE_KIND_FINALIZE: u8 = 1;
pub const PROFILE_STANDARD_LINKED: u8 = 0;
pub const PROFILE_STANDARD_UNLINKED: u8 = 1;
pub const PROFILE_OG_LINKED: u8 = 2;

pub const WEEKLY_LEAGUE_BPS: u16 = 3_000;
pub const MONTHLY_LEAGUE_BPS: u16 = 7_000;
pub const OPERATOR_FILL_CAP_USD_MICROS: u64 = 10_000 * 1_000_000;
pub const USD_MICROS: u64 = 1_000_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Default)]
pub struct RouteAmounts {
    pub weekly_league: u64,
    pub monthly_league: u64,
    pub creator: u64,
    pub recruiter: u64,
    pub airdrop: u64,
    pub squad: u64,
    pub protocol: u64,
}

pub fn preview_route(kind: u8, profile: u8, fee_amount: u64) -> Result<RouteAmounts> {
    require!(fee_amount > 0, crate::TreasuryError::InvalidAmount);
    require!(
        kind == ROUTE_KIND_TRADE || kind == ROUTE_KIND_FINALIZE,
        crate::TreasuryError::InvalidPeriod
    );
    require!(
        profile == PROFILE_STANDARD_LINKED
            || profile == PROFILE_STANDARD_UNLINKED
            || profile == PROFILE_OG_LINKED,
        crate::TreasuryError::InvalidPeriod
    );

    let (league_bps, creator_bps, recruiter_bps, airdrop_bps, squad_bps) =
        if kind == ROUTE_KIND_TRADE {
            match profile {
                PROFILE_STANDARD_LINKED => (3750, 500, 1250, 0, 250),
                PROFILE_STANDARD_UNLINKED => (3750, 500, 0, 1500, 0),
                _ => (3750, 500, 1500, 0, 250),
            }
        } else {
            match profile {
                PROFILE_STANDARD_LINKED => (0, 0, 1500, 0, 250),
                PROFILE_STANDARD_UNLINKED => (0, 0, 0, 1750, 0),
                _ => (0, 0, 1750, 0, 250),
            }
        };

    let league = bps(fee_amount, league_bps)?;
    let creator = bps(fee_amount, creator_bps)?;
    let recruiter = bps(fee_amount, recruiter_bps)?;
    let airdrop = bps(fee_amount, airdrop_bps)?;
    let squad = bps(fee_amount, squad_bps)?;
    let weekly = bps(league, WEEKLY_LEAGUE_BPS)?;
    let monthly = league.saturating_sub(weekly);
    let used = weekly
        .checked_add(monthly)
        .and_then(|v| v.checked_add(creator))
        .and_then(|v| v.checked_add(recruiter))
        .and_then(|v| v.checked_add(airdrop))
        .and_then(|v| v.checked_add(squad))
        .ok_or(crate::TreasuryError::MathOverflow)?;
    let protocol = fee_amount.saturating_sub(used);
    Ok(RouteAmounts {
        weekly_league: weekly,
        monthly_league: monthly,
        creator,
        recruiter,
        airdrop,
        squad,
        protocol,
    })
}

pub fn split_operator_fill(
    protocol_lamports: u64,
    native_usd_micros: u64,
    filled_usd_micros: u64,
    cap_usd_micros: u64,
) -> Result<(u64, u64, u64)> {
    if protocol_lamports == 0 || native_usd_micros == 0 || filled_usd_micros >= cap_usd_micros {
        return Ok((0, protocol_lamports, filled_usd_micros));
    }
    let remaining_usd = cap_usd_micros.saturating_sub(filled_usd_micros);
    let protocol_usd = u128::from(protocol_lamports)
        .checked_mul(u128::from(native_usd_micros))
        .ok_or(crate::TreasuryError::MathOverflow)?
        .checked_div(u128::from(LAMPORTS_PER_SOL))
        .ok_or(crate::TreasuryError::MathOverflow)?;
    if protocol_usd == 0 {
        return Ok((0, protocol_lamports, filled_usd_micros));
    }
    let take_usd = protocol_usd.min(u128::from(remaining_usd));
    let to_operator = u128::from(protocol_lamports)
        .checked_mul(take_usd)
        .ok_or(crate::TreasuryError::MathOverflow)?
        .checked_div(protocol_usd)
        .ok_or(crate::TreasuryError::MathOverflow)?;
    let to_operator = u64::try_from(to_operator).map_err(|_| error!(crate::TreasuryError::MathOverflow))?;
    let to_treasury = protocol_lamports.saturating_sub(to_operator);
    let new_filled = filled_usd_micros.saturating_add(
        u64::try_from(take_usd).map_err(|_| error!(crate::TreasuryError::MathOverflow))?,
    );
    Ok((to_operator, to_treasury, new_filled.min(cap_usd_micros)))
}

fn bps(amount: u64, bps: u16) -> Result<u64> {
    if bps == 0 || amount == 0 {
        return Ok(0);
    }
    let out = u128::from(amount)
        .checked_mul(u128::from(bps))
        .ok_or(crate::TreasuryError::MathOverflow)?
        .checked_div(u128::from(ROUTE_BPS))
        .ok_or(crate::TreasuryError::MathOverflow)?;
    u64::try_from(out).map_err(|_| error!(crate::TreasuryError::MathOverflow))
}
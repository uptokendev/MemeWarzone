use anchor_lang::prelude::*;

use super::errors::ArenaMoneyV2Error;

pub const BPS_DENOMINATOR_U128: u128 = 10_000;

pub fn mul_bps_u64(value: u64, bps: u64) -> Result<u64> {
    require!(bps <= BPS_DENOMINATOR_U128 as u64, ArenaMoneyV2Error::InvalidSplit);
    let product = (value as u128)
        .checked_mul(bps as u128)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?;
    let quotient = product / BPS_DENOMINATOR_U128;
    u64::try_from(quotient).map_err(|_| error!(ArenaMoneyV2Error::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_bps_handles_u64_max_without_intermediate_overflow() {
        let value = u64::MAX;
        assert_eq!(mul_bps_u64(value, 10_000).unwrap(), value);
        assert_eq!(mul_bps_u64(value, 5_000).unwrap(), ((value as u128 * 5_000) / 10_000) as u64);
    }

    #[test]
    fn mul_bps_rejects_invalid_bps() {
        assert!(mul_bps_u64(1, 10_001).is_err());
    }
}

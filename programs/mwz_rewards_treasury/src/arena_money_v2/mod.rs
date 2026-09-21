pub mod config;
pub mod errors;
pub mod math;
pub mod receipts;
pub mod sponsorship;

pub use config::*;
pub use errors::*;
pub use math::*;
pub use receipts::*;
pub use sponsorship::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sponsorship_split_is_70_20_10_and_conserves() {
        let split = split_sponsorship_v1(10_000).unwrap();
        assert_eq!(split.prize, 7_000);
        assert_eq!(split.marketing, 2_000);
        assert_eq!(split.protocol, 1_000);
        assert_eq!(split.prize + split.marketing + split.protocol, split.gross);
    }

    #[test]
    fn sponsorship_rounding_remainder_stays_in_prize() {
        let sponsor = split_sponsorship_v1(101).unwrap();
        assert_eq!(sponsor.marketing, 20);
        assert_eq!(sponsor.protocol, 10);
        assert_eq!(sponsor.prize, 71);
        assert_eq!(sponsor.prize + sponsor.marketing + sponsor.protocol, 101);
    }

    #[test]
    fn sponsorship_split_rejects_zero_and_conserves_u64_max() {
        assert!(split_sponsorship_v1(0).is_err());
        let sponsorship = split_sponsorship_v1(u64::MAX).unwrap();
        assert_eq!(
            sponsorship.prize as u128 + sponsorship.marketing as u128 + sponsorship.protocol as u128,
            u64::MAX as u128,
        );
    }

    #[test]
    fn generations_are_explicit_and_separate() {
        assert_eq!(ARENA_MONEY_GENERATION_V2, 2);
        assert_eq!(SPONSORSHIP_GENERATION_V1, 1);
    }
}

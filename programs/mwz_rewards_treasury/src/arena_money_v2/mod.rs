pub mod boost;
pub mod competition;
pub mod config;
pub mod errors;
pub mod league;
pub mod math;
pub mod receipts;
pub mod sponsorship;

pub use boost::*;
pub use competition::*;
pub use config::*;
pub use errors::*;
pub use league::*;
pub use math::*;
pub use receipts::*;
pub use sponsorship::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn competition_split_is_75_20_5_and_conserves() {
        let split = split_competition_v2(10_000).unwrap();
        assert_eq!(split.prize, 7_500);
        assert_eq!(split.league, 2_000);
        assert_eq!(split.protocol, 500);
        assert_eq!(split.prize + split.league + split.protocol, split.gross);
    }

    #[test]
    fn boost_split_is_90_10_0_and_conserves() {
        let split = split_boost_v2(10_000).unwrap();
        assert_eq!(split.prize, 9_000);
        assert_eq!(split.protocol, 1_000);
        assert_eq!(BOOST_LEAGUE_BPS, 0);
        assert_eq!(split.prize + split.protocol, split.gross);
    }

    #[test]
    fn league_split_is_60_40_and_conserves() {
        let split = split_postgrad_league_v2(10_000).unwrap();
        assert_eq!(split.monthly, 6_000);
        assert_eq!(split.quarterly, 4_000);
        assert_eq!(split.monthly + split.quarterly, split.gross);
    }

    #[test]
    fn sponsorship_split_is_70_20_10_and_conserves() {
        let split = split_sponsorship_v1(10_000).unwrap();
        assert_eq!(split.prize, 7_000);
        assert_eq!(split.marketing, 2_000);
        assert_eq!(split.protocol, 1_000);
        assert_eq!(split.prize + split.marketing + split.protocol, split.gross);
    }

    #[test]
    fn rounding_remainder_stays_in_prize_or_monthly_bucket() {
        let competition = split_competition_v2(101).unwrap();
        assert_eq!(competition.league, 20);
        assert_eq!(competition.protocol, 5);
        assert_eq!(competition.prize, 76);
        assert_eq!(competition.prize + competition.league + competition.protocol, 101);

        let boost = split_boost_v2(101).unwrap();
        assert_eq!(boost.protocol, 10);
        assert_eq!(boost.prize, 91);
        assert_eq!(boost.prize + boost.protocol, 101);

        let league = split_postgrad_league_v2(101).unwrap();
        assert_eq!(league.quarterly, 40);
        assert_eq!(league.monthly, 61);
        assert_eq!(league.monthly + league.quarterly, 101);

        let sponsor = split_sponsorship_v1(101).unwrap();
        assert_eq!(sponsor.marketing, 20);
        assert_eq!(sponsor.protocol, 10);
        assert_eq!(sponsor.prize, 71);
        assert_eq!(sponsor.prize + sponsor.marketing + sponsor.protocol, 101);
    }

    #[test]
    fn split_functions_reject_zero() {
        assert!(split_competition_v2(0).is_err());
        assert!(split_boost_v2(0).is_err());
        assert!(split_postgrad_league_v2(0).is_err());
        assert!(split_sponsorship_v1(0).is_err());
    }

    #[test]
    fn split_functions_accept_u64_max_and_conserve() {
        let competition = split_competition_v2(u64::MAX).unwrap();
        assert_eq!(
            competition.prize as u128 + competition.league as u128 + competition.protocol as u128,
            u64::MAX as u128,
        );

        let boost = split_boost_v2(u64::MAX).unwrap();
        assert_eq!(boost.prize as u128 + boost.protocol as u128, u64::MAX as u128);

        let league = split_postgrad_league_v2(u64::MAX).unwrap();
        assert_eq!(league.monthly as u128 + league.quarterly as u128, u64::MAX as u128);

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

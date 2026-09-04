use anchor_lang::prelude::*;

#[error_code]
pub enum ArenaMoneyV2Error {
    #[msg("Arena Money V2 address may not be zero.")]
    ZeroAddress,
    #[msg("Arena Money V2 caller is not authorized.")]
    Unauthorized,
    #[msg("Arena Money V2 is paused.")]
    Paused,
    #[msg("Arena Money V2 generation mismatch.")]
    GenerationMismatch,
    #[msg("Arena Money V2 identifier is invalid.")]
    InvalidId,
    #[msg("Arena Money V2 amount is invalid.")]
    InvalidAmount,
    #[msg("Arena Money V2 split does not conserve value.")]
    InvalidSplit,
    #[msg("Arena Money V2 state is invalid.")]
    InvalidState,
    #[msg("Arena Money V2 participant is invalid.")]
    InvalidParticipant,
    #[msg("Arena Money V2 winner is invalid.")]
    InvalidWinner,
    #[msg("Arena Money V2 bucket has nothing to claim.")]
    NothingToClaim,
    #[msg("Arena Money V2 arithmetic overflow.")]
    MathOverflow,
    #[msg("Arena Money V2 replay receipt already exists.")]
    Replay,
    #[msg("Arena Money V2 deadline has passed.")]
    DeadlinePassed,
    #[msg("Arena Money V2 event is not enabled.")]
    EventDisabled,
    #[msg("Arena Money V2 sponsorship payment is below the event minimum.")]
    SponsorshipBelowMinimum,
    #[msg("Arena Money V2 receipt does not match its source.")]
    ReceiptMismatch,
    #[msg("Arena Money V2 vault has insufficient distributable SOL.")]
    InsufficientVaultBalance,
}

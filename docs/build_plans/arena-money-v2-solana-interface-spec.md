# MemeWarzone Arena Money V2 — Solana Interface Specification

Date: 2026-09-03
Authority: `docs/build_plans/arena-vote-boost-sponsorship-v1.md`
Status: Phase 2 interface specification only. No Solana deployment or runtime implementation in this phase.

## 1. Purpose

Define the Solana-native account and instruction surface required to reproduce the founder-locked Arena V2 money guarantees without copying Solidity implementation details onto Solana.

Product invariants are shared across chains:

- V2 Battle/Tournament entry or buy-in: `75% prize / 20% Post-Grad League / 5% protocol`.
- Battle/Tournament Boost: `90% competition prize / 10% protocol / 0% League`.
- Post-Grad League income: `60% current Monthly MWL / 40% active Quarterly Reserve`.
- Sponsorship: `70% selected event prize / 20% marketing / 10% protocol`.
- Native SOL/lamports are accounting truth. USD is quote/reference data only.
- All raw money values are integer lamports. Never floating point.
- Historical Solana Arena generations remain interpretable; V2 uses explicit generation/version fields.
- No developer wallet may be a protocol, marketing, league, or prize receiver.

## 2. Program/account model

Recommended PDAs:

### ArenaMoneyConfigV2

Seeds conceptually:

`["arena-money-v2", generation]`

Stores:

- generation = 2
- admin / governance authority
- resolver authority
- quote-signing authority
- protocol receiver
- Post-Grad League treasury PDA
- event-prize-vault authority
- sponsorship marketing receiver
- pause flags for entries, Boosts, settlement, sponsorship
- supported generation flag

### CompetitionPoolV2

Seeds conceptually:

`["arena-pool-v2", competition_id]`

Stores:

- competition ID
- kind: battle | tournament
- state: open | live | resolved | cancelled
- owner A / owner B where applicable
- entry or buy-in amount in lamports
- stake A / stake B lamports
- tournament buy-in total lamports
- Boost gross total lamports
- winner payout key
- pending prize lamports
- pending protocol lamports
- pending League lamports
- deposit deadline
- resolve deadline
- settlement generation = 2
- claimed/refunded state

### CompetitionEntryReceiptV2

For tournament entrants and other replay-sensitive deposits.

Seeds include competition + entrant wallet.

Stores deposited lamports and refund/claim state.

### BoostReceiptV2

Seeds include competition + payment signature or canonical payment nonce.

Stores:

- competition ID
- optional tournament match ID
- tournament round
- side token/mint
- booster wallet
- gross lamports
- prize lamports
- protocol lamports
- confirmed slot/signature reference
- replay-consumed state

Money destination for Vote Tournament Boosts is the tournament-level `CompetitionPoolV2`; match/round/side are score attribution only.

### PostGradLeagueTreasuryV2

Stores:

- current monthly epoch ID
- current quarterly epoch ID
- monthly pending lamports
- quarterly pending lamports
- authorized Arena V2 source program/config
- pause state

### LeagueSourceReceiptV2

Seeds include source competition pool.

Prevents a competition League allocation from being credited twice.

Stores source pool, monthly epoch, quarterly epoch, gross League lamports, 60/40 split, source signature/slot.

### SponsorshipConfigV1

Stores:

- governance authority
- quote signer
- marketing receiver
- protocol receiver
- Event Prize Vault authority/PDA namespace
- payments pause
- generation = 1

### SponsorshipEventV1

Seeds include canonical sponsorship event ID.

Stores:

- event ID
- canonical event reference
- supported event type only: normal tournament | vote tournament | monthly MWL | quarterly championship
- chain/cluster binding
- enabled/open state
- event prize receiver/config

Normal Battle is not a supported sponsorship event type.

### EventPrizeVaultV1

Seeds include event ID.

Stores/owns the SOL event-prize lamports attributable to sponsorship.

### SponsorshipReceiptV1

Seeds include sponsor wallet + quote nonce (or canonical signed quote digest).

Stores:

- event ID
- sponsor wallet
- pricing version
- minimum native lamports
- requested/gross lamports
- event lamports
- marketing lamports
- protocol lamports
- nonce
- quote expiry
- payment signature/slot
- consumed state

## 3. Instructions

### initialize_arena_money_v2

Creates `ArenaMoneyConfigV2` under governance control. Receivers and authorities are explicit configuration, never browser/user inputs.

### open_battle_pool_v2

Creates a Battle `CompetitionPoolV2` with owner identities, stake, deadlines, generation and state.

### open_tournament_pool_v2

Creates a Tournament `CompetitionPoolV2` with buy-in, deadlines and generation.

### deposit_battle_stake_v2

Transfers exact lamports from the expected owner into the competition PDA/vault. When both required stakes are present, battle may enter `live`.

### deposit_tournament_buyin_v2

Transfers exact buy-in lamports and creates an entrant receipt. Duplicate entry by the same wallet must fail.

### set_tournament_live_v2

Authorized transition from registration/open to live. Paid Boosts are rejected before live so cancellation/refund never leaves untracked Boost liabilities.

### boost_battle_v2

Transfers paid Boost lamports into a live Battle pool and records side attribution. No League allocation is created from Boost money.

### boost_tournament_v2

Transfers paid Boost lamports into the overall live Tournament pool. Instruction also carries match ID, round and side for scoring attribution; those fields do not change the money destination.

### resolve_competition_v2

Consumes a detached authorization verified through the Ed25519 verification instruction + Instructions sysvar, following the existing MemeWarzone Solana authorization pattern.

Authorization binds at minimum:

- program ID
- cluster
- generation
- competition ID
- winner payout
- stake total
- buy-in total
- Boost total
- settlement version
- nonce
- deadline

Settlement math:

Entry/buy-in gross:

- League = floor(gross * 20 / 100)
- protocol = floor(gross * 5 / 100)
- prize = gross - League - protocol

Boost gross:

- protocol = floor(gross * 10 / 100)
- prize = gross - protocol
- League = 0

Remainder/dust therefore always stays in the competition prize bucket.

### claim_competition_prize_v2

Winner/champion claims the resolved prize exactly once.

### claim_protocol_v2

Routes resolved protocol amount to configured governance-controlled protocol receiver exactly once.

### route_postgrad_league_v2

Moves the resolved 20% League allocation to `PostGradLeagueTreasuryV2` and creates `LeagueSourceReceiptV2`.

League split:

- monthly = floor(grossLeague * 60 / 100)
- quarterly = grossLeague - monthly

Remainder stays in Quarterly Reserve so no lamport disappears.

### cancel_open_competition_v2

Cancellation is only valid while a pool is still open/pre-live. A live competition that accepted Boosts cannot use the simple pre-live refund path.

### refund_battle_stake_v2

Returns deposited stake to the original owner for an eligible cancelled Battle.

### refund_tournament_buyin_v2

Returns buy-in to the original entrant from its receipt for an eligible cancelled Tournament.

### register_sponsorship_event_v1

Governance-only registration of a canonical event reference and supported event type.

### pay_event_sponsorship_v1

Requires a detached quote authorization verified through Ed25519 + Instructions sysvar.

Quote binds:

- program ID / cluster
- event ID
- sponsor wallet
- pricing tier/version
- minimum USD reference (informational signed field if retained)
- minimum native lamports
- requested native lamports
- native/USD reference and oracle timestamp where included by backend quote format
- nonce
- expiry

Program checks:

- event enabled
- correct cluster
- sponsor is signer
- quote signer is configured authority
- requested >= minimum
- transferred lamports exactly equal requested
- quote not expired
- nonce/receipt unused

Split:

- marketing = floor(gross * 20 / 100)
- protocol = floor(gross * 10 / 100)
- event = gross - marketing - protocol

The event remainder rule preserves exact conservation and routes dust to the selected Event Prize Vault.

## 4. Replay and idempotency

Canonical replay barriers:

- tournament entry receipt per competition + wallet
- Boost receipt per canonical payment identity
- League source receipt per source competition
- sponsorship receipt per sponsor + quote nonce/digest
- settlement authorization nonce

Workers/indexers must treat Solana signature ingestion as idempotent. A repeated signature must not create a second score action, second League credit or second sponsorship receipt.

## 5. Receiver failure and safety behavior

Solana instructions must be atomic where a split is performed. If a required destination account is invalid or fails validation, the instruction fails without partially recording a successful payment.

Configuration changes are governance/admin actions and must not rewrite historical receipts or settled pool generations.

Pause controls should separately cover:

- new entries
- Boosts
- settlement
- sponsorship payments

Pausing must never create a manual-winner path.

## 6. BNB/EVM parity fixtures

Use shared cross-chain fixture vectors containing only integers and canonical IDs.

Required fixtures include:

- 1 raw unit
- 2 raw units
- values immediately below/above split boundaries
- normal-size competition pools
- very large values below integer limits
- entry 75/20/5 conservation
- Boost 90/10 conservation
- sponsorship 70/20/10 conservation
- League 60/40 conservation

For every fixture:

`all destination raw amounts sum exactly to gross raw amount`.

Product percentages must match EVM. Technical account layout need not.

## 7. Phase 2 acceptance boundary

Phase 2 does not implement or deploy these Solana accounts/instructions.

Phase 2 is complete for Solana when this interface specification is committed alongside the tested EVM V2 contracts.

Future chain-parity implementation remains behind the existing Arena feature flags and must first run on Solana devnet. No Solana mainnet addresses, PDAs or production authorities are invented in this document.

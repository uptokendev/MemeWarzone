# MemeWarzone Battle, Vote Tournament, Boost & Sponsorship Build Plan

## v1.0 - Founder-Locked Implementation Authority

Date: 2026-09-03
Repository: `uptokendev/MemeWarzone`
PR: `#158`
Branch: `build/cross-chain-stabilization-rh-base`

This document is the authoritative repository source of truth for Battle Boosts, Battle Points V3, Vote Tournaments, Final Salvo, V2 Arena money paths, Post-Grad League V2 routing, and native-chain sponsorship.

Source authority: `battlevotesponsor.md` / uploaded `01-battlevotesponsor.md`.

This authority supersedes older Arena assumptions only where explicitly stated here. Existing Battle architecture remains unchanged:

```text
MATCH QUALITY
= opponent compatibility

CHALLENGE NEGOTIATION
= ACCEPT / COUNTER / DECLINE

BATTLE POINTS
= battle winner

LEAGUE POINTS
= persistent competitive consequence
```

## Frozen baseline

Accepted Battle Wall baseline SHA: `2d3cccae4ef867a0415a9a7f9237278ced0c5231`

Preserve Grok's accepted Battle Wall and realtime work. Do not edit these files unless backend or schema compatibility absolutely requires it:

- `frontend/src/pages/ArenaBattles.tsx`
- `frontend/src/components/arena/BattleWallModule.tsx`
- `frontend/src/components/arena/BattleWallCombatant.tsx`
- `frontend/src/components/arena/BattleCombatEffects.tsx`
- `frontend/src/hooks/useBattleWallViewport.ts`
- `frontend/src/hooks/useBattleWallRealtime.ts`
- `frontend/src/lib/arena/battleWallRealtime.mjs`

Avoid the creator challenge carousel lane as well.

## Current repository assumptions now obsolete

1. Battle Points `50 / 30 / 20` is superseded for future V3 by `45 / 27 / 18 / 10`.
2. Tournament modes `normal / boost` plus `BOOST_RULES_NOT_CONFIGURED` is obsolete. Product vocabulary is now `normal / vote`.
3. Historical ArenaWarPool treasury generation `85 / 10 / 5` remains historical only. New competition money paths require a distinguishable V2 generation.

## Founder-locked product rules

### Normal Battles

Normal Battles remain market-performance fights.

Battle Points V3 weights are founder-locked:

```text
MCAP performance       45
Holder performance     27
Eligible volume        18
Battle Boost pressure  10
TOTAL                 100
```

Battle Boost is:

```text
$1 per Boost
90% -> that Battle prize pool
10% -> protocol
```

Battle Boost does not feed Post-Grad League Treasury, does not replace Arena UpVotes, and does not replace MCAP / holders / eligible volume.

### Battle Boost scoring configuration

The `10` maximum Boost weight is founder-locked.

The exact Boost conversion curve is not yet separately founder-locked. Implementation must therefore support:

```text
battle_points_v3
boost.curveVersion
boost.curveParameters
```

Do not hardcode an irreversible production settlement curve yet. Production activation remains behind `ARENA_BATTLE_POINTS_V3`.

### Vote Tournaments

Tournament product modes are:

```text
normal
vote
```

Every Vote Tournament matchup is exactly `24 hours`.

Regulation scoring:

```text
FREE VOTE  = 1 point
BOOST $1   = 2 points
```

Vote Tournament matchups use:

- free-vote points
- paid Boost points

Vote Tournament matchups do not use:

- MCAP
- holder score
- eligible volume
- Battle Points V3 settlement

Free-vote eligibility is `1 free vote per matchup per tournament round per wallet`.

Boost eligibility is unrestricted by wallet count. Vote Tournament Boost money routes:

```text
90% -> overall Tournament prize pool
10% -> protocol
```

### Final Salvo

Exact regulation ties must never fall back to MCAP, holders, volume, random selection, or token ordering.

Instead enter Final Salvo:

- best of five shots
- each shot lasts `60 seconds`
- free votes only
- one free vote per wallet per shot
- winner is the side with the most unique voting wallets
- Boosts are disabled
- wallet eligibility resets at the start of every shot
- early stop when a side is mathematically eliminated

If the best-of-five score remains tied, enter Sudden Death:

- repeated `60 second` rounds
- wallet eligibility resets every round
- one free vote per wallet
- Boosts remain disabled
- most unique voters wins

Operational recovery may pause infrastructure, but an operator may not manually choose the winner.

### Attention systems remain separate

The following are distinct systems and must not share canonical ledgers:

1. Pre-grad UpVote: `$3`, `100% -> protocol`
2. Post-grad Featured UpVote: `$3`, `100% -> protocol`
3. Battle / Tournament Boost: `$1`, `90% -> prize`, `10% -> protocol`

Never reuse `arena_votes` or `arena_vote_aggregates` as the canonical Battle or Tournament contest ledger.

## Competition and league economics

New V2 Battle and Tournament entry/buy-in pools route:

```text
75% -> competition prize
20% -> Post-Grad League Treasury
 5% -> protocol
```

Historical V1 pools remain historical and interpretable under their original generation.

Post-Grad League Treasury V2 incoming competition revenue routes:

```text
60% -> current Monthly MWL
40% -> current Quarterly Championship Reserve
```

All accounting remains native-chain and chain-specific.

## Sponsorship authority

Sponsorship exists only for MemeWarzone-organized competitions.

Supported sponsorship event types:

- `normal_tournament`
- `vote_tournament`
- `monthly_mwl`
- `quarterly_championship`

Not supported:

- `normal_battle`

V1 sponsorship payment is native-chain only. The event chain determines the payment asset. No cross-chain conversion is part of V1.

Sponsor payment split:

```text
70% -> selected Event Prize Pool
20% -> Marketing Treasury
10% -> Protocol Revenue
```

Pricing is configured as minimum USD targets and paid in native assets. Seed the founder-approved launch tiers exactly:

| Tier | Rolling 30d qualified users | Tournament | MWL | Quarterly |
| --- | ---: | ---: | ---: | ---: |
| FOUNDING | 0-999 | $49 | $99 | $249 |
| EARLY | 1,000-4,999 | $99 | $199 | $499 |
| GROWING | 5,000-24,999 | $249 | $499 | $1,199 |
| ESTABLISHED | 25,000-99,999 | $599 | $1,199 | $2,999 |
| LARGE | 100,000-499,999 | $1,499 | $2,999 | $7,499 |
| MAJOR | 500,000+ | $2,999+ | $7,499+ | $15,000+ |

Traffic may recommend a tier. It may not automatically activate or downgrade pricing.

Price lookup order:

1. Event-specific override
2. Chain-specific override
3. Active traffic-tier price
4. Global default

Founding-tier sponsors retain durable `FOUNDING SPONSOR MEMEWARZONE 2026` history on the sponsor profile.

Quote lifecycle must bind event, chain, wallet, tier, pricing version, minimum USD, requested USD/native, minimum native raw amount, native/USD reference, oracle timestamp, expiry, and nonce. Suggested quote validity is `5 minutes`.

## Required additive data model foundations

Phase 1 foundation must add schema for:

1. Tournament mode vocabulary `normal | vote`, both locked to `24h`
2. Contest action ledger using raw integer native money fields
3. Free-vote uniqueness for regulation and per-shot Final Salvo resets
4. Final Salvo / Sudden Death state storage
5. Battle Points V3 persistence and versioning without overwriting V2
6. Competition settlement and WarPool generation/version fields so V1 remains readable and future V2 is distinguishable
7. Post-Grad League V2 ledger storage
8. Event-specific sponsorship schema
9. Sponsorship founder tier seeds
10. Feature/config boundaries:
   - `ARENA_BATTLE_POINTS_V3`
   - `ARENA_BATTLE_BOOSTS`
   - `ARENA_VOTE_TOURNAMENTS`
   - `ARENA_FINAL_SALVO`
   - `ARENA_POOL_V2`
   - `ARENA_SPONSORSHIP_V1`
   - `ARENA_SPONSORSHIP_PRICING`
   - `ARENA_POSTGRAD_LEAGUE_V2`

All native money columns must use integer raw native units. Never float.

## Required schema concepts

### Contest action ledger

Add a table equivalent to `arena_contest_actions` storing:

- chain
- tournament
- battle or matchup identity
- round number
- phase: `regulation | salvo | sudden_death`
- salvo index
- side
- wallet
- action type: `free_vote | boost`
- boost units
- points
- gross, pool, and protocol native raw amounts
- tx / signature references
- confirmation timestamps

Free-vote uniqueness must be:

- regulation: `match + round + regulation + wallet`
- Final Salvo and Sudden Death: `match + round + phase + salvo_index + wallet`

### Final Salvo state

Add a table equivalent to `arena_vote_tiebreaks` storing:

- state: `pending | salvo | sudden_death | resolved | paused`
- regulation totals
- current salvo index
- Salvo score
- shot times
- current unique-voter counts
- sudden-death round
- winner
- resolution timestamps

### Battle Points V3 persistence

Store future V3 scoring with:

- `mcap_points`
- `holder_points`
- `volume_points`
- `boost_points`
- `total_points`
- `boost_units`
- `boost_gross_native_raw`
- `boost_pool_native_raw`
- `boost_protocol_native_raw`
- `scoring_version`
- `boost_curve_version`
- `boost_curve_parameters`

Historical V1 and V2 records must remain readable.

### Post-Grad League V2 ledger

Store future V2 competition routing by:

- chain
- monthly epoch
- quarterly epoch
- source pool
- raw native amount
- tx or signature reference

### Sponsorship schema

Add event sponsorship foundations equivalent to:

- `sponsor_profiles`
- `sponsorship_events`
- `sponsorship_price_tiers`
- `sponsorship_price_overrides`
- `sponsorship_traffic_snapshots`
- `sponsorship_payment_quotes`
- `event_sponsorships`
- `sponsorship_payments`

Do not ambiguously repurpose the old duration or placement package rows as the new event sponsorship authority.

## Execution boundaries

This implementation assignment stops after Phase 0 and Phase 1.

Explicitly out of scope for this pass:

- ArenaWarPoolTreasuryV2 contract
- PostGradLeagueTreasuryV2 contract
- SponsorshipRouter
- EventPrizeVault
- Battle Boost payment APIs
- Battle Boost frontend
- Battle Points V3 production calculation or settlement
- Vote Tournament voting APIs
- Final Salvo worker
- sponsorship quote or payment execution backend
- sponsorship dashboard
- public sponsor UX
- Solana or Robinhood money-path implementation
- Battle Wall Phase 4 or 5

Do not begin Phase 2 contracts or payment execution until this work is audited.

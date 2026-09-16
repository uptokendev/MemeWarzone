---
title: Events and Tournaments
description: Normal Tournaments, Vote Tournaments, Final Salvo, event timing, settlement, and chain-specific competition rules.
---

Events and Tournaments are the structured competition layer around Arena.

> **Production note:** these pages document the current product rules and implementation target. Production financial activation remains independently gated.

## Normal Tournaments

Normal Tournaments preserve chain identity through:

- registration and enrolment
- eligibility
- entry payment
- participant state
- brackets or rounds
- scoring
- winner settlement
- claims

A Tournament record must never silently mix BNB, Solana, and Robinhood participants or settlement state.

## Vote Tournaments

Vote Tournament uses a different regulation model from Normal Battle scoring.

Current frozen regulation rules are:

- regulation lasts **24 hours**
- one free vote = **1 Vote Point**
- one free vote per wallet / matchup / round
- one **$1 paid Boost = 2 Vote Points**
- paid Boosts are unlimited during regulation
- market cap does not score during regulation
- holder growth does not score during regulation
- trading volume does not score during regulation

The backend remains authoritative for eligibility, vote totals, winner, and advancement.

## Vote Tournament money rules

Current-generation Vote Tournament entry uses:

- 75% Prize
- 20% Post-Grad League
- 5% Protocol

Paid Vote Boost uses:

- 90% Prize
- 10% Protocol
- 0% League

These rules are separate from Normal Battle V3 scoring and its hyperbolic Boost curve.

## Final Salvo

Final Salvo activates only when Vote Tournament regulation ends in an exact tie.

The canonical format is:

1. best of five shots
2. each shot lasts 60 seconds
3. free vote only
4. one vote per wallet per shot
5. tied shots award no series point
6. mathematical early resolution is allowed
7. if the series is still tied after five shots, repeated 60-second Sudden Death rounds continue until a winner

Paid Boost is disabled during Final Salvo.

There is no market-metric fallback and no manual/admin winner in the canonical rules.

## Event timing and state

Public event pages should clearly show:

- chain
- event format
- registration or enrolment window where applicable
- start time
- round timing
- participant state
- active/closed status
- settlement or claim status once complete

## Event Sponsorship

Normal Tournaments, Vote Tournaments, and Monthly Major War League can carry Event Sponsorship where the sponsorship record is valid for the exact event and chain.

Quarterly Championship may use **Presented by PROJECT** under the same active sponsorship authority.

Event Sponsorship is not the same thing as an ordinary featured placement.

Read **[Sponsorships](/arena/sponsorships)** for the allocation and authority rules.

## Claims and recovery

Tournament claims are financial claims and must be exactly-once, replay-safe, and restart-safe.

If on-chain payment succeeds but the client or API loses the response, retry must reconcile the original payment rather than send another one.

## Related docs

Read **[Arena Overview](/arena)**, **[Battle Scoring & Boosts](/arena/scoring-and-boosts)**, and **[Quarterly Championship](/arena/quarterly-championship)**.
---
title: Live Battles
description: How Normal Battles work from challenge and entry settlement through LIVE scoring, settlement, and claim history.
---

Normal Battles are the direct campaign-vs-campaign format inside Arena.

> **Production note:** this page documents the current Battle model. Arena financial activation remains independently gated and can stay disabled on production even while other MemeWarzone surfaces are live.

## Battle lifecycle

The canonical flow is:

**Challenge / AUTO DEPLOY → Accept / Counter / Decline → entry settlement → scheduled start → LIVE baseline → scoring → settlement → claim/history**

### Challenge

A campaign can challenge a rival manually. AUTO DEPLOY is an opt-in matchmaking path where enabled.

A challenged project can **ACCEPT**, **COUNTER**, or **DECLINE** according to the current Battle state.

### Entry settlement

A Battle is not financially active merely because a matchup exists.

The current-generation competition entry allocation is:

- 75% Prize
- 20% Post-Grad League
- 5% Protocol

Payment confirmation and market-data health are separate authorities.

### Scheduled start

Battles have a scheduled start. The score baseline is not captured when the challenge is created or funded.

### LIVE baseline

The market baseline is captured only when the Battle actually transitions to **LIVE**.

Once captured, that baseline is immutable for the Battle.

## V3 scoring

Current V3 Battles score four components:

| Metric | Weight |
| --- | ---: |
| Market-cap growth | 45 |
| Holder growth | 27 |
| Eligible real volume | 18 |
| Community Boost | 10 max |

Historical V1 and V2 Battles keep the scoring generation they were created with.

Read **[Battle Scoring & Boosts](/arena/scoring-and-boosts)** for the formula and Boost rules.

## Community Boost

Normal Battle Boosts are confirmed $1 units that feed the V3 Boost curve.

Boost money uses its own allocation:

- 90% Prize
- 10% Protocol
- 0% League

Boost points use diminishing returns and are capped at 10 Battle points.

## Chain identity

Battle identity stays chain-specific from challenge through settlement and claim.

A BNB Battle, Solana Battle, and Robinhood Battle are not interchangeable records even when the score metrics are normalized into the same V3 model.

## Settlement and history

After the competition closes, the authoritative result moves through settlement and the claim/history path.

Claims must be exactly-once and replay-safe. A reload, retry, double-click, concurrent request, or API interruption after a successful chain payment must not create a duplicate payout.

## What the Battle board should communicate

The Battle surface can show states such as:

- awaiting response
- scheduled
- LIVE
- completed
- settlement/claim state

The score should make clear which campaign is leading and which metrics are driving the result.

## Imported tokens

An imported project is not automatically Battle-eligible.

Project ownership verification only controls the project page. Arena admission remains a separate authority, and an imported project can remain visible with **WARZONE ACCESS LOCKED** until financial competition is activated and approved.

Read **[Arena Overview](/arena)**, **[Battle Scoring & Boosts](/arena/scoring-and-boosts)**, and **[Import an Existing Token](/import)**.
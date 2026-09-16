---
title: Battle Scoring & Boosts
description: The current V3 Normal Battle score, historical scoring generations, Boost curve, and Battle money allocation.
---

MemeWarzone Battles are versioned by scoring generation.

A Battle keeps the scoring rules it was created with. Newer scoring generations do not rewrite historical Battles.

> **Production note:** these are the current founder-approved V3 rules. Arena production activation remains independently gated.

## V3 score weights

Current V3 Normal Battles use:

| Metric | Weight |
| --- | ---: |
| Market-cap growth | 45 |
| Holder growth | 27 |
| Eligible real volume | 18 |
| Community Boost | 10 max |

The non-Boost metrics total 90 points. Community Boost can add at most 10 points.

## Historical scoring generations

| Generation | Market cap | Holders | Eligible volume | Boost |
| --- | ---: | ---: | ---: | ---: |
| V1 | historical rules | historical rules | historical rules | none |
| V2 | 50 | 30 | 20 | 0 |
| V3 | 45 | 27 | 18 | 10 max |

Historical Battles are not migrated into V3 interpretation.

## Boost curve

V3 uses the immutable curve identified as:

`boost_hyperbolic_100_v1`

The formula is:

`BoostPoints = 10 × U / (U + 100)`

where `U` is the number of confirmed **$1 Normal Battle Boost units**.

Because the curve is hyperbolic, each additional Boost unit contributes less than the previous one as the total grows.

### Examples

| Confirmed $1 Boost units (U) | Boost points |
| ---: | ---: |
| 10 | 0.91 |
| 25 | 2.00 |
| 50 | 3.33 |
| 100 | 5.00 |
| 200 | 6.67 |
| 500 | 8.33 |

The score approaches 10 but never exceeds the 10-point cap.

## What counts as a Boost

Only confirmed $1 Normal Battle Boost units count toward the V3 Boost component.

A UI click, pending payment, failed payment, or unrelated project action must not be counted as confirmed Battle Boost activity.

## Normal Battle Boost economics

Normal Battle Boost money uses:

- **90% Prize**
- **10% Protocol**
- **0% League**

This is different from competition-entry money.

## Competition entry economics

Current-generation Battle / Competition entry uses:

- **75% Prize**
- **20% Post-Grad League**
- **5% Protocol**

The Post-Grad League intake is reserved **60% Monthly Major War League / 40% Quarterly reserve** under the current model.

## Vote Tournament Boost is a different rail

Vote Tournament regulation does not use the V3 Normal Battle score.

During Vote Tournament regulation:

- one free vote = 1 Vote Point
- $1 paid Boost = 2 Vote Points
- market cap, holders, and volume do not score
- paid Vote Boost money uses 90% Prize / 10% Protocol

Do not mix Vote Tournament Boost points with Normal Battle V3 Boost points.

## Baseline integrity

The Normal Battle market baseline is captured when the Battle actually becomes LIVE.

It is immutable after the LIVE transition. Changing, refreshing, or reinterpreting that baseline later would change the meaning of the competition and is not allowed.

## Data health versus payment health

MemeWarzone treats score-data health and financial settlement as separate authorities.

A market-data problem must not fabricate a payment state, and a confirmed payment must not automatically imply healthy market-data scoring.

Read **[Live Battles](/arena/live-battles)**, **[Events and Tournaments](/arena/events)**, and **[Major War League](/arena/major-war-league)**.
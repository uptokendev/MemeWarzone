---
title: Arena Overview
description: The post-graduation Warzone for Normal Battles, Tournaments, Major War League, Quarterly Championship, Boosts, sponsorships, and chain-native competition claims.
---

Arena is MemeWarzone's post-graduation competitive layer.

It is where campaigns stop behaving like one-day launches and start fighting for recurring attention through Battles, Tournaments, league standings, community support, and sponsored events.

> **Production note:** Arena is documented here as the current product design and implementation target. Production financial activation is independent from launch and Import. The public production release can keep Arena OFF while project Import and other product surfaces remain ON.

![Arena overview](/images/docs/arena-overview.png)

## What enters Arena

Arena eligibility is a separate authority from project ownership and from launch status.

A project can be:

- a native MemeWarzone campaign that has graduated
- an existing token imported into MemeWarzone
- owner-verified for its public project page

without automatically being admitted to financial competition.

**OWNER VERIFIED** does not mean **Arena approved**.

## Normal Battles

The canonical Normal Battle lifecycle is:

**Challenge / AUTO DEPLOY → Accept / Counter / Decline → entry settlement → scheduled start → LIVE baseline → scoring → settlement → claim/history**

Battle identity remains chain-specific. The LIVE baseline is captured at the actual start and is immutable after that point.

Read **[Live Battles](/arena/live-battles)** and **[Battle Scoring & Boosts](/arena/scoring-and-boosts)**.

## Current V3 scoring

Normal Battle V3 uses four score components:

| Metric | Weight |
| --- | ---: |
| Market-cap growth | 45 |
| Holder growth | 27 |
| Eligible real volume | 18 |
| Community Boost | 10 max |

Community Boost uses a diminishing-return curve rather than linear points. Historical Battle generations keep their own scoring rules and are never reinterpreted as V3.

## Tournaments

Arena supports two different tournament families.

### Normal Tournaments

Normal Tournaments use chain-specific registration, entry settlement, participant state, brackets or rounds, scoring, winner settlement, and claims.

### Vote Tournaments

Vote Tournament regulation uses community voting instead of market metrics:

- 24-hour regulation
- one free vote = 1 Vote Point
- one free vote per wallet / matchup / round
- $1 paid Boost = 2 Vote Points
- unlimited paid Boosts during regulation
- no market-cap, holder, or volume scoring during regulation

An exact regulation tie moves into **Final Salvo**.

Read **[Events and Tournaments](/arena/events)**.

## Final Salvo

Final Salvo is the exact-tie breaker for Vote Tournaments.

It uses best-of-five 60-second free-vote shots. Paid Boosts are disabled. If the series is still tied after five shots, repeated sudden-death rounds continue until a winner is produced.

There is no manual/admin winner fallback in the canonical rules.

## Major War League

Monthly Major War League is the recurring post-graduation league layer.

Its identity, standings, rewards, and claims stay chain-specific. The current Arena money model reserves the Post-Grad League intake between Monthly MWL and Quarterly reserve.

Read **[Major War League](/arena/major-war-league)**.

## Quarterly Championship

Quarterly Championship is a **continuous chain-specific standing across the quarter**.

It is not a quarterfinal / semifinal / final knockout tournament. Legacy knockout structures can exist for historical compatibility, but they are not the current championship model.

Read **[Quarterly Championship](/arena/quarterly-championship)**.

## Arena money rules

Current-generation Arena rails use different allocations depending on the action:

| Rail | Prize | League / Marketing | Protocol |
| --- | ---: | ---: | ---: |
| Battle / competition entry | 75% | 20% Post-Grad League | 5% |
| Normal Battle Boost | 90% | 0% | 10% |
| Vote Tournament entry | 75% | 20% Post-Grad League | 5% |
| Vote Tournament Boost | 90% | 0% | 10% |
| Event Sponsorship | 70% | 20% Marketing | 10% |

No economic percentage should be inferred from a different rail.

## Event Sponsorship

Event Sponsorship is separate from ordinary visibility placement.

The current event split is **70% Event Prize / 20% Marketing / 10% Protocol**. Public sponsor attribution requires an authoritative paid/active sponsorship record for the correct event and chain.

Individual Battle sponsorship is not part of the current launch authority.

Read **[Sponsorships](/arena/sponsorships)**.

## Claims and chain identity

Arena settlement and claims preserve the chain where the event occurred:

- BNB settles in BNB
- Solana settles in SOL
- Robinhood settles in ETH

Claim paths must be replay-safe, exactly-once, and recoverable after reload/restart or an API interruption after on-chain settlement.

## Imported projects and the locked Warzone

Imported projects can exist publicly before Arena opens.

Until competition access is separately activated and approved, the project page remains financially inert and displays **WARZONE ACCESS LOCKED**. Import never fabricates campaign economics, graduation history, or competition eligibility.

Read **[Import an Existing Token](/import)** for that boundary.

## Move between Arena and the market

Arena is the competition layer.

Token Details, imported Project Details, and the War Trade Room remain the surfaces for project identity and market context. Arena adds competition; it does not replace the underlying project or market view.
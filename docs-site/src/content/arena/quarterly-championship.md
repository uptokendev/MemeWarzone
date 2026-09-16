---
title: Quarterly Championship
description: The continuous chain-specific quarterly standing that extends MemeWarzone competition beyond monthly Major War League periods.
---

Quarterly Championship is the long-horizon competitive standing inside the MemeWarzone Arena model.

> **Production note:** this page documents the current championship model. Production Arena activation remains independently gated.

## Continuous standing, not a knockout bracket

The canonical Quarterly Championship is a **continuous chain-specific standing across the quarter**.

It is not a quarterfinal / semifinal / final knockout tournament.

Older knockout-shaped structures may remain in historical data or compatibility code, but they must not be presented as the current championship format.

## Chain-specific identity

Quarterly Championship preserves the chain where campaign activity occurred.

BNB, Solana, and Robinhood standings, rewards, and claims are not mixed into one financial record.

The canonical championship type is:

`quarterly_championship`

A canonical identity follows the current chain-specific quarter convention rather than using a generic cross-chain event ID.

## Relationship with Monthly Major War League

Current Arena competition entry routes a Post-Grad League share that is reserved:

- **60% Monthly Major War League**
- **40% Quarterly reserve**

This reserve relationship does not mean Monthly MWL and Quarterly Championship are the same competition. They are separate periods and standings with separate identities.

## What is not currently fixed

No founder-approved numeric monthly-placement bonus is currently locked for Quarterly Championship.

No final Quarterly prize percentage is currently founder-approved.

The docs intentionally do not invent either number.

## Claims

Any future public Quarterly claim path must preserve the same exactly-once principles as other financial claims:

- correct chain
- correct recipient
- correct event/entitlement identity
- replay rejection
- no duplicate payout after retries or concurrent requests
- recovery when chain payment succeeds but API persistence is interrupted

## Presentation

Quarterly standings should make the current quarter, chain, ranking, and campaign identity clear.

Where an Event Sponsorship is active and valid for the championship, the presentation may use **Presented by PROJECT** according to current sponsorship authority.

Read **[Major War League](/arena/major-war-league)**, **[Events and Tournaments](/arena/events)**, and **[Arena Overview](/arena)**.
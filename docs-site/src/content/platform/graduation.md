---
title: Graduation
description: How BNB, Solana, and Robinhood campaigns leave native bonding and enter their permanent post-graduation markets.
---

Graduation is the handoff from the native launchpad bonding phase into the campaign's permanent post-graduation market.

MemeWarzone uses the same product rule on **BNB, Solana, and Robinhood**: bonding stays native, the selected Graduation Market is revalidated at threshold, and the permanent market is created through the venue architecture for that chain.

## Chain paths

| Chain | Native bonding | Post-grad venue architecture |
| --- | --- | --- |
| BNB Chain | BNB | Topaz |
| Solana | SOL | Meteora |
| Robinhood Chain | ETH | chain-local V3 infrastructure |

## Graduation Market

The creator chooses from Graduation Markets that MemeWarzone currently allows on the selected chain.

Authoritative quote identity is chain-specific. A symbol alone is not enough: the system binds the exact contract or mint plus provider/profile identity.

The selected market is checked again when the threshold is reached. Selection at campaign creation does not permanently guarantee market health.

## No silent fallback

If a selected non-native quote becomes unsafe or unavailable at graduation, MemeWarzone does **not** silently replace it with WBNB, WSOL, or WETH.

The campaign enters a recoverable pending state until the selected market is safe again or another explicitly authorized recovery path is used.

## What graduation changes

When a campaign graduates:

1. the active generation's threshold is reached
2. the selected Graduation Market identity and route are revalidated
3. the finalize/graduation policy runs
4. the permanent market is created or confirmed through the chain's venue architecture
5. permanent liquidity or position custody is established according to the chain generation
6. the campaign moves from PRE to POST
7. post-grad market indexing, fee accounting, community continuity, and Warzone eligibility can continue from the same MemeWarzone campaign identity

## BNB

BNB campaigns move from native BNB bonding into the verified Topaz market path for their generation. Permanent LP custody remains generation-aware.

## Solana

Solana campaigns move from SOL bonding into the accepted Meteora graduation/post-grad architecture, preserving Solana-native program and transaction rules.

## Robinhood

Robinhood campaigns move from ETH bonding into the chain-local V3 path.

The Robinhood graduation model includes the V3 pool/position lifecycle, permanent position custody through the locker architecture, and ETH-in / ETH-out routing for the user-facing trading experience.

Robinhood is therefore part of the same full launchpad lifecycle, not only a post-grad or Import integration.

## After graduation

Graduation changes the underlying liquidity venue, not the MemeWarzone project identity.

Token Details, the War Trade Room, community surfaces, rewards, claims, and the Warzone continue to use the campaign's explicit chain and generation.

Read **[Campaign System](/platform/campaign-lifecycle)**, **[Chain Readiness](/platform/chain-readiness)**, **[Economic Model](/economics)**, and **[War Trade Room](/traders/war-trade-room)**.
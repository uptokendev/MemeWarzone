---
title: War Trade Room
description: Find campaigns across BNB, Solana, and Robinhood and act according to their current market state.
---

The War Trade Room is the cross-chain campaign board for MemeWarzone.

It brings Draft, PRE, and POST campaigns from **BNB Chain, Solana, and Robinhood Chain** into one operating view while preserving each campaign's real chain and market route.

![War Trade Room campaign board](/images/docs/war-trade-room-board.png)

## Read the state first

Every campaign row carries a chain and a state. Together they determine the actions and underlying venue.

### DRAFT

DRAFT is the preparation state.

Use the campaign row to inspect identity, chain, timing, official links, and public campaign information before trading opens.

### PRE

PRE is the live launchpad state.

The campaign is trading through native bonding:

- BNB campaign → BNB bonding
- Solana campaign → SOL bonding
- Robinhood campaign → ETH bonding

Open Token Details for the full campaign view and use the active buy, sell, quote, and discovery controls shown for that chain.

### POST

POST is the post-graduation state.

The campaign has completed bonding and moved to its permanent market architecture:

- BNB → Topaz
- Solana → Meteora
- Robinhood → chain-local V3

The War Trade Room remains the MemeWarzone surface even though the underlying venue has changed.

## Find a campaign

Use search and filters to narrow the board by:

- BNB, Solana, or Robinhood
- campaign state
- ticker
- campaign name
- creator
- campaign, token contract, or mint address

![War Trade Room filters](/images/docs/war-trade-room-filters.png)

## Imported projects

Import is a separate onboarding path from a native campaign.

An imported BNB, Solana, or Robinhood project can have a MemeWarzone project identity without fabricating bonding or graduation history. Trading controls only appear when the relevant market/product rail is actually available for that project.

## Verify before you trade

Before submitting a transaction:

1. confirm BNB, Solana, or Robinhood
2. confirm the campaign state
3. verify ticker and exact address/mint
4. confirm the asset being spent
5. open Token Details when you need the full campaign record
6. review the wallet transaction before signing

Read **[Trading Basics](/traders/trading-basics)**, **[Campaign System](/platform/campaign-lifecycle)**, **[Chain Readiness](/platform/chain-readiness)**, and **[Import an Existing Token](/import)**.
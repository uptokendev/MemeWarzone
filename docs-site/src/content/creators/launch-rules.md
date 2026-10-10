---
title: Launch Rules
description: The rules every new coin launches with on BNB Chain, Solana and Robinhood Chain.
---

Every new coin follows the same rules on BNB Chain, Solana and Robinhood Chain. Create shows them as you go. This page puts them in one place.

## Graduation market cap

You pick one of two in the **Bond** step:

| Choice | Graduates at |
| --- | --- |
| Fast grad | $30K market cap |
| Normal (the default) | $50K market cap |

The coin graduates when its bonding curve sells out at that market cap. The choice is part of the launch and does not change afterwards.

## Supply

Every coin has 1 billion tokens:

| Share | Tokens | Goes to |
| --- | ---: | --- |
| 85% | 850M | the bonding curve |
| 13% | 130M | the DEX pool at graduation |
| 2% | 20M | the creator reserve, released at graduation |

## Launch fee

The trade fee starts at 90% when trading opens and falls to the normal 2% within 60 seconds. Bots that buy in the first seconds pay for it. Your own first buy does not.

## Your first buy

You can buy your own coin in the launch transaction, before anyone else:

- up to 70% of the supply, with no cost limit, so at least 15% stays for everyone else
- at the normal 2% fee
- the tokens go to your wallet unlocked
- **MAX** in Create fills in the most your wallet can pay after gas and launch fees

On BNB Chain and Robinhood Chain the first buy is in the **Bond** step. On Solana it is in the **Market** step, because you pay in the token you pick there.

## Later buys by the creator

Buys you make from the creator wallet on your own coin after launch go into escrow:

- 20% is released after 30 days
- then 20% every 7 days
- everything is free after 58 days

## Creator fee

In the **Bond** step you choose what happens to your share of the trade fee: keep it, give it to holders, split it, or use it for buyback and burn. Read **[Creator Earnings](/creators/creator-earnings)**.

## Graduation

At graduation the coin's liquidity moves into its DEX pool and is locked for good: Topaz on BNB Chain, Meteora on Solana, Uniswap on Robinhood Chain. A 2% graduation fee goes to MemeWarzone's fee routing. The creator gets the 2% reserve, not a share of the graduation fee. Read **[Graduation](/platform/graduation)**.

## No wait between launches

There is no cooldown between launches and no limit on how many live coins one wallet can have.

A launch can still be refused when:

- the wallet, or a group of wallets it belongs to, is restricted for abuse
- the creator is under manual review
- the wallet cannot pay for the first buy plus gas and launch fees

Coins launched before these rules keep the rules they launched with.

Read **[Create a Campaign](/creators/create-a-campaign)** and **[Fee Model](/fees)**.

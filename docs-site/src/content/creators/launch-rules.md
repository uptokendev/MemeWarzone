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

The coin graduates when its bonding curve sells out at that market cap. On gen-8 BNB Chain and Robinhood Chain launches, that happens in the trade that reaches the market cap, and the coin stays in the same Uniswap V4 pool. The choice is part of the launch and does not change afterwards.

## Supply

Every coin has 1 billion tokens:

| Share | Tokens | Goes to |
| --- | ---: | --- |
| 85% | 850M | the bonding curve |
| 13% | 130M | the DEX pool at graduation |
| 2% | 20M | the creator reserve. Released at graduation on today's launches. On gen-8, after 1 hour at or above the graduation market cap |

## Launch fee

The trade fee starts at 90% when trading opens and falls to the normal 2% within 60 seconds. Bots that buy in the first seconds pay for it. Your own first buy does not. On gen-8 you can pick an open time up to 30 days ahead; the 90% to 2% fee starts then, not when you sign.

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

At graduation a 2% fee comes out of what the curve raised and goes to MemeWarzone's fee routing. The creator does not get a share of that fee.

On today's launches the coin's liquidity then moves into its DEX pool and is locked for good: Topaz on BNB Chain, Meteora on Solana, Uniswap on Robinhood Chain. The 2% reserve is released at graduation.

On gen-8 BNB Chain and Robinhood Chain launches the coin is already in a Uniswap V4 pool. Graduation does not migrate it, so the chart and the listing on other sites continue. The 2% reserve can be released once the coin has been graduated for at least 1 hour and the price is at or above the graduation market cap. If the price later falls back below that market cap, trades there pay the 2% bonding fee again.

Read **[Graduation](/platform/graduation)**.

## No wait between launches

There is no cooldown between launches and no limit on how many live coins one wallet can have.

A launch can still be refused when:

- the wallet, or a group of wallets it belongs to, is restricted for abuse
- the creator is under manual review
- the wallet cannot pay for the first buy plus gas and launch fees

## Gen-8 launches (BNB Chain and Robinhood Chain)

This applies to new coins paired with BNB or ETH after the gen-8 release. Solana stays as documented above. Coins paired with a stock or another quote token keep the current rules for now. Coins launched before the gen-8 release keep the rules they launched with.

- From the first second the coin trades in a real Uniswap V4 pool. Anyone can trade it: the MemeWarzone app, other wallets, trading bots and aggregators. On Robinhood Chain it shows on DexScreener and GeckoTerminal. On BNB Chain it shows on GeckoTerminal.
- Optional open time: you launch now and pick when trading opens, up to 30 days ahead. Nobody can trade before that time. This replaces "launch later" for drafts and scheduled launches.
- Before graduation: 2% on every buy and sell, paid in BNB or ETH, never in the coin.
- After graduation: 1% on every buy and sell. The creator gets 0.5% of the trade amount. MemeWarzone gets the rest. Your fee choice (keep, give to holders, split, buyback and burn) works as today.
- You claim your fee share to any wallet you choose, and you can hand your creator rights to another wallet in two steps: propose, then accept. MemeWarzone cannot change this.
- Partner sites can show the swap widget for gen-8 coins. Trades go through the coin's pool.

Read **[Create a Campaign](/creators/create-a-campaign)** and **[Fee Model](/fees)**.

---
title: Fee Model
description: Every fee on MemeWarzone in one table, on BNB Chain, Solana and Robinhood Chain, with who pays it and where it goes.
---

This page lists every fee MemeWarzone charges. The pages after it show the exact split of each fee and where the money ends up.

## Every fee at a glance

| Fee | Size | Who pays it | Where it goes |
| --- | ---: | --- | --- |
| Trade fee on a bonding curve | 2% of every buy and sell | the trader | Leagues, the creator, recruiters, squads or airdrops, and MemeWarzone. Read **[Fee Routing](/fees/fee-routing)**. |
| Launch fee, first 60 seconds of a new coin | starts at 90%, falls to 2% | traders who buy in the first minute | the same split as the trade fee |
| Graduation fee | 2% of the coin's raise | the coin's raise, once, when it graduates | recruiters, squads or airdrops, and MemeWarzone. The creator gets nothing from it. |
| DEX pool fee after graduation | set by the pool (0.25% on Solana) | traders in the pool | 80% to the creator side, 20% to MemeWarzone |
| Imported coin swap | 1% on Solana, 0.5% on BNB Chain and Robinhood Chain | the trader | Solana: half to the coin's creator, half to MemeWarzone |
| Battle buy-in | 25% of the buy-in | the coin owners in the battle | 20% to the Major War League, 5% to MemeWarzone. The other 75% is the prize. |
| Battle boost | 10% of the boost | the person who boosts | MemeWarzone. The other 90% is the prize. |
| Event sponsorship | 30% of the sponsorship | the sponsor | 20% marketing, 10% MemeWarzone. The other 70% is the event prize. |
| UpVote | the price in the UpVote popup | the voter | MemeWarzone |

You pay network fees (gas) on top of these. They go to the network, not to MemeWarzone.

## Three rules behind the numbers

1. **One trade fee, split inside it.** The 2% is the whole fee. League prizes, the creator share, recruiter and squad rewards and airdrops are all paid out of that 2%. None of them adds a fee of its own.
2. **The split is fixed in code.** On BNB Chain and Robinhood Chain the router contract splits the fee in the same transaction as the trade. On the Solana launchpad curve the program does it in the trade transaction. For Solana coins on Meteora, our fee worker splits each collected fee into the same reward vaults by the same numbers.
3. **MemeWarzone takes the remainder.** Every reward slice is counted first. The protocol share is whatever is left.

## Which numbers apply to your coin

The creator share depends on when the coin launched:

| Coin | Creator share of the trade fee |
| --- | ---: |
| New coins on BNB Chain and Robinhood Chain | 5.6% of the fee (0.112% of the trade) |
| New coins on Solana (Meteora) | 5.6% of the fee (0.112% of the trade) |
| Coins on the Solana launchpad curve, and BNB Chain and Robinhood Chain coins launched before October 2026 | 5% of the fee (0.10% of the trade) |

A coin keeps the rules it launched with. Its fee never changes after launch.

Read next: **[Fee Routing](/fees/fee-routing)**, **[Where Fees Go](/fees/where-fees-go)** and **[After Graduation](/fees/after-graduation)**.

---
title: Fee Routing
description: The exact split of the 2% trade fee and the 2% graduation fee on BNB Chain, Solana and Robinhood Chain, for linked, unlinked and OG wallets.
---

Every trade fee and graduation fee is split into fixed slices. This page shows every slice, as a share of the fee and as a share of the trade.

## Who counts as linked

The split depends on the wallet's recruiter link:

| Profile | Meaning |
| --- | --- |
| Linked | the wallet joined through a recruiter's link |
| OG | the wallet is linked to an OG recruiter |
| Unlinked | the wallet has no recruiter |

For a trade, the trader's wallet decides. For a graduation, the creator's wallet decides.

When a wallet is unlinked, nobody earns the recruiter and squad slices, so they go to Warzone Airdrops instead.

## Trade fee: new coins on BNB Chain and Robinhood Chain

The router contract splits the 2% in the same transaction as the trade.

| Slice | Linked | OG | Unlinked |
| --- | ---: | ---: | ---: |
| League (30% weekly, 70% monthly) | 37.5% (0.75%) | 37.5% (0.75%) | 37.5% (0.75%) |
| Creator | 5.6% (0.112%) | 5.6% (0.112%) | 5.6% (0.112%) |
| Recruiter | 12.5% (0.25%) | 15% (0.30%) | 0 |
| Squad Pool | 2.5% (0.05%) | 2.5% (0.05%) | 0 |
| Warzone Airdrops | 0 | 0 | 15% (0.30%) |
| MemeWarzone | 41.9% (0.838%) | 39.4% (0.788%) | 41.9% (0.838%) |

Shares are of the 2% fee. The number in brackets is the share of the trade.

## Trade fee: new coins on Solana (Meteora)

New Solana coins trade on a Meteora bonding curve, so Jupiter and other apps can trade them too. Meteora keeps 20% of every fee. Our fee worker splits our part into the same reward vaults the launchpad uses.

| Slice | Linked | OG | Unlinked |
| --- | ---: | ---: | ---: |
| Meteora | 20% (0.40%) | 20% (0.40%) | 20% (0.40%) |
| League (30% weekly, 70% monthly) | 37.5% (0.75%) | 37.5% (0.75%) | 37.5% (0.75%) |
| Creator | 5.6% (0.112%) | 5.6% (0.112%) | 5.6% (0.112%) |
| Recruiter | 12.5% (0.25%) | 15% (0.30%) | 0 |
| Squad Pool | 2.5% (0.05%) | 2.5% (0.05%) | 0 |
| Warzone Airdrops | 0 | 0 | 15% (0.30%) |
| MemeWarzone | 21.9% (0.438%) | 19.4% (0.388%) | 21.9% (0.438%) |

When the trade is made on memewar.zone, Meteora pays a fifth of its 20% back to MemeWarzone as a referral fee (4% of the fee, 0.08% of the trade). In other apps, such as Jupiter, that referral does not come to MemeWarzone.

The creator's 5.6% is 7% of the 80% left after Meteora's cut.

## Trade fee: older coins

Coins on the Solana launchpad curve, and BNB Chain and Robinhood Chain coins launched before October 2026, use the earlier creator share of 5%:

| Slice | Linked | OG | Unlinked |
| --- | ---: | ---: | ---: |
| League (30% weekly, 70% monthly) | 37.5% (0.75%) | 37.5% (0.75%) | 37.5% (0.75%) |
| Creator | 5% (0.10%) | 5% (0.10%) | 5% (0.10%) |
| Recruiter | 12.5% (0.25%) | 15% (0.30%) | 0 |
| Squad Pool | 2.5% (0.05%) | 2.5% (0.05%) | 0 |
| Warzone Airdrops | 0 | 0 | 15% (0.30%) |
| MemeWarzone | 42.5% (0.85%) | 40% (0.80%) | 42.5% (0.85%) |

## Launch fee

On new coins the fee starts at 90% when trading opens and falls to 2% over 60 seconds. It is split by the same table as the 2%. The creator's own first buy in the launch transaction pays 2%.

## Graduation fee

When a coin graduates, 2% of its raise is taken once. It has no League slice and no creator slice.

| Slice | Linked | OG | Unlinked |
| --- | ---: | ---: | ---: |
| Recruiter | 15% (0.30%) | 17.5% (0.35%) | 0 |
| Squad Pool | 2.5% (0.05%) | 2.5% (0.05%) | 0 |
| Warzone Airdrops | 0 | 0 | 17.5% (0.35%) |
| MemeWarzone | 82.5% (1.65%) | 80% (1.60%) | 82.5% (1.65%) |

The number in brackets is the share of the raise. The same split applies on all three chains.

On Solana, Meteora also keeps 0.2% of the liquidity it moves into the new pool. That is Meteora's own fee, not ours.

Coins launched before the current rules keep their old graduation terms. On the Solana launchpad curve, the creator received 20% of the raise after the fee and 80% went into the pool.

Read next: **[Where Fees Go](/fees/where-fees-go)** and **[Fee Examples](/fees/examples)**.

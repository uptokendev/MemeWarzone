---
title: Fee Examples
description: Simple BNB examples for trading fees, creator trade earnings, fee routing, UpVotes, finalize routing, and graduation walkthroughs.
---

These examples use BNB amounts to keep the math easy.

Examples are simplified for clarity. Actual wallet balances can also be affected by gas, slippage, rounding, and network conditions.

## Linked trade example

If a linked standard user buys or sells with 1 BNB, the 2.00% fee is 0.0200 BNB.

| Destination | Amount |
| --- | ---: |
| LeagueTreasury, 0.75% | 0.0075 BNB |
| Creator wallet, 0.10% | 0.0010 BNB |
| RecruiterRewardsVault, 0.25% | 0.0025 BNB |
| Squad Pool, 0.05% | 0.0005 BNB |
| ProtocolRevenueVault, 0.85% | 0.0085 BNB |
| Total fee | 0.0200 BNB |

The creator wallet receives the 0.10% directly because the trade happened on that creator's own token bonding curve.

## Unlinked trade example

If an unlinked user buys or sells with 1 BNB, the 2.00% fee is still 0.0200 BNB.

| Destination | Amount |
| --- | ---: |
| LeagueTreasury, 0.75% | 0.0075 BNB |
| Creator wallet, 0.10% | 0.0010 BNB |
| Warzone Airdrops, 0.30% | 0.0030 BNB |
| ProtocolRevenueVault, 0.85% | 0.0085 BNB |
| Total fee | 0.0200 BNB |

Unlinked activity sends the unassigned recruiter and squad slices to Warzone Airdrops. The creator still receives the 0.10% direct trade share.

## OG trade example

If an OG linked user buys or sells with 1 BNB:

| Destination | Amount |
| --- | ---: |
| LeagueTreasury, 0.75% | 0.0075 BNB |
| Creator wallet, 0.10% | 0.0010 BNB |
| OG recruiter, 0.30% | 0.0030 BNB |
| Squad Pool, 0.05% | 0.0005 BNB |
| ProtocolRevenueVault, 0.80% | 0.0080 BNB |
| Total fee | 0.0200 BNB |

The OG override comes from protocol revenue. It does not increase the user facing fee.

## Creator trade earnings example

If a creator's campaign receives 100 BNB of bonding curve buy and sell notional before graduation, the creator earns:

| Item | Amount |
| --- | ---: |
| Bonding curve trade notional | 100 BNB |
| Creator direct trade share | 0.10% |
| Direct creator trade earnings | 0.100 BNB |

This is separate from the creator payout. It is earned from trading activity on the creator's own campaign.

## Creator trade earnings example

If a creator's campaign receives 100 BNB of bonding-curve buy/sell notional before graduation, the creator earns:

| Item | Amount |
| --- | ---: |
| Bonding-curve trade notional | 100 BNB |
| Creator direct trade share | 0.10% |
| Direct creator trade earnings | 0.100 BNB |

This is separate from the graduation payout. It is earned from trading activity on the creator's own campaign.

## UpVote example

If a campaign receives 100 UpVotes:

| Item | Amount |
| --- | ---: |
| UpVote price | $3, paid in the chain's native coin |
| UpVotes | 100 |
| Total UpVote spend | $300 |

UpVotes are paid visibility actions. They are not a safety label and do not guarantee graduation or price performance.

## Example graduation walkthrough

This walkthrough uses a 50 BNB raise only as a round number for math.

| Item | Amount |
| --- | ---: |
| Raised liquidity | 50 BNB |
| Finalize fee, 2.00% | 1 BNB |
| Remaining after fee | 49 BNB |
| Launch liquidity | 39.2 BNB |
| Creator payout | 9.8 BNB |

The numbers above are illustrative. Use the live deployment policy for the current target and distribution rules.

## Standard linked finalize example

If a standard linked campaign finalizes with a 1 BNB finalize fee:

| Destination | Share | Amount |
| --- | ---: | ---: |
| RecruiterRewardsVault | 0.30% | 0.150 BNB |
| Squad Pool | 0.05% | 0.025 BNB |
| ProtocolRevenueVault | 1.65% | 0.825 BNB |
| Total finalize fee | 2.00% | 1.000 BNB |

Finalize does not route to LeagueTreasury or the creator direct trade share path.

## Unlinked finalize example

If an unlinked campaign finalizes with a 1 BNB finalize fee:

| Destination | Share | Amount |
| --- | ---: | ---: |
| Warzone Airdrops | 0.35% | 0.175 BNB |
| ProtocolRevenueVault | 1.65% | 0.825 BNB |
| Total finalize fee | 2.00% | 1.000 BNB |

The unassigned recruiter and squad slices route to Warzone Airdrops.

## OG linked finalize example

If an OG linked campaign finalizes with a 1 BNB finalize fee:

| Destination | Share | Amount |
| --- | ---: | ---: |
| RecruiterRewardsVault | 0.35% | 0.175 BNB |
| Squad Pool | 0.05% | 0.025 BNB |
| ProtocolRevenueVault | 1.60% | 0.800 BNB |
| Total finalize fee | 2.00% | 1.000 BNB |

The extra OG recruiter amount is carved out of protocol revenue, not added on top of the finalize fee.

Read next: **[Fee Routing](/fees/fee-routing)** and **[Graduation](/platform/graduation)**.

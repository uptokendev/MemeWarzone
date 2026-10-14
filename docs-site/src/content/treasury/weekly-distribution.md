---
title: Weekly Distribution
description: How MemeWarzone's protocol revenue moves from the operating wallet to the multisig, and how the weekly payout to the owners is set and signed.
---

MemeWarzone's protocol revenue follows the same order every week. Reward vaults are not part of this: League prizes, creator earnings, recruiter and squad rewards and airdrops stay in their own vaults and are paid to the people who earned them. Read **[Where Fees Go](/fees/where-fees-go)**.

## Where protocol revenue lands

| Wallet | What it holds |
| --- | --- |
| Operating wallet | at most $10,000, used to pay for gas, servers and day-to-day costs |
| Multisig (Squads on Solana, Safe on BNB Chain and Robinhood Chain) | everything above that |

On Solana the protocol vault is paid out once an hour: the operating wallet is topped up to $10,000 and the rest goes to the multisig. On BNB Chain and Robinhood Chain the protocol revenue vault forwards each payment as it arrives.

The operating wallet is a buffer. It is never paid out to the owners.

## The weekly payout

Once a week the amount that can be paid out is worked out from the multisig balance:

1. start with what the multisig holds
2. set aside the reserve for taxes
3. set aside costs that are due but not yet paid
4. what is left is split between the owners by their share in the company

## Who signs

The payout is prepared as a proposal on the multisig. It moves nothing until enough of the multisig's signers approve it. No single person can move multisig funds alone, and no software pays out on its own.

## What this prevents

- protocol revenue landing directly in a personal wallet
- one person taking fees without the others signing
- a large balance sitting in a wallet that one key controls
- reward money being mixed with company money

Read: **[Treasury Structure](/treasury)** and **[Where Fees Go](/fees/where-fees-go)**.

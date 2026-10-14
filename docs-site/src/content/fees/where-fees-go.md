---
title: Where Fees Go
description: Each place MemeWarzone fees land, what fills it and who it pays out to, on BNB Chain, Solana and Robinhood Chain.
---

Fees land in separate vaults, one per purpose. On BNB Chain and Robinhood Chain each vault is its own contract. On Solana each vault is an account of the MemeWarzone rewards treasury program. Reward money and protocol money never share a vault.

## The map

| Vault | Filled by | Pays out to | When |
| --- | --- | --- | --- |
| Weekly League | 30% of the League slice of every trade fee | weekly League winners | after each weekly epoch |
| Monthly League | 70% of the League slice of every trade fee | monthly League winners | after each month |
| Creator | the creator slice of trades on that creator's coin, and 80% of its pool fees after graduation | the coin's creator, its holders, or a buyback, as the creator chose | creator claims, or paid out weekly for holders and buyback |
| Recruiter | the recruiter slice of linked wallets' trades and graduations | the recruiter who brought the wallet in | the recruiter claims |
| Squad Pool | the squad slice of linked wallets' trades and graduations | eligible squad members | after each epoch |
| Warzone Airdrops | the recruiter and squad slices of unlinked wallets | weekly airdrop winners | every Monday |
| Major War League | 20% of every battle buy-in | owners of the best coins in the Major War League | 60% after each month, 40% after each quarter |
| Protocol | what is left of every fee after the slices above, plus UpVotes and the protocol share of battles | MemeWarzone | see below |

## Leagues

The League slice is 37.5% of every trade fee, so 0.75% of all bonding-curve volume goes to League prizes. Prizes are paid over many ranks, not only first place. The prize pool shown on the League page is the vault balance, including any amount carried over. Read **[Epochs and Prizes](/leagues/epochs-and-prizes)**.

## Creator

On new coins the creator gets 5.6% of every trade fee. In the **Bond** step of Create, the creator chooses what happens to it:

| Choice | What happens |
| --- | --- |
| Keep | the creator claims it in Command Center, under **Rewards and claims** |
| Holders | it is paid to the coin's holders in the weekly round |
| Split | part to the creator, the rest to holders |
| Buyback | it buys the coin back and burns what it buys |

On a Solana coin paired with another token, such as USDC or a stock token, the creator is paid in that token. Read **[Creator Earnings](/creators/creator-earnings)**.

## Recruiters and squads

A recruiter earns 12.5% of every trade fee paid by wallets they brought in, and 15% of the graduation fee of coins those wallets create. OG recruiters earn 15% and 17.5%. Read **[Recruiter Program](/programs/recruiter-program)** and **[Squad Pool](/rewards/squad-pool)**.

## Warzone Airdrops

When a wallet has no recruiter, the recruiter and squad slices are nobody's, so they fund the weekly airdrop: 15% of the trade fee and 17.5% of the graduation fee. Drops not claimed within 60 days go back into the pot. Read **[Warzone Airdrops](/rewards/warzone-airdrops)**.

## Protocol revenue

MemeWarzone's share is what is left after every reward slice. It pays for development, servers, audits and the team.

- **Solana:** the protocol share collects in the treasury program's protocol vault. Once an hour it is paid out: the operating wallet is topped up to at most $10,000, and everything above that goes to the MemeWarzone multisig, which needs several signers to move funds.
- **BNB Chain and Robinhood Chain:** the protocol revenue vault forwards each payment to the MemeWarzone treasury as it arrives.

The deployer wallet, which publishes our contracts and programs, never holds user money.

Read: **[Treasury Structure](/treasury)** and **[Fee Examples](/fees/examples)**.

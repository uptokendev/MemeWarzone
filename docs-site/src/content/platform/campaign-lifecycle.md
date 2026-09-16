---
title: Campaign System
description: The three-chain campaign path from preparation and launch to trading, graduation, post-graduation markets, competition, and rewards.
---

A campaign is the core native-launch unit of MemeWarzone.

It combines the token, creator identity, official links, market state, trading activity, discovery signals, graduation state, and competition history in one public record.

MemeWarzone uses the same product lifecycle across **BNB Chain, Solana, and Robinhood Chain**. Execution differs by chain, but the meaning of Draft, Prepare, PRE, graduation, POST, claims, and Arena does not.

![Campaign lifecycle](/images/docs/campaign-lifecycle.png)

## 1. Prepare

The creator chooses **BNB, Solana, or Robinhood** and prepares the campaign identity.

A complete campaign normally includes:

- name and ticker
- logo and campaign media
- description
- official website and social links
- community plan
- launch timing
- Graduation Market selection where the current campaign flow exposes it

Prepare Mode is the pre-launch distribution surface. It can be used to build the public project page, followers, community attention, and launch notifications before trading starts.

## 2. Direct, Draft, or scheduled launch

**Direct** moves a ready campaign toward launch without a long public staging period.

**Draft / Prepare Mode** creates the project identity first so the creator can prepare the public page and community before deployment.

**Scheduled launch** deploys the campaign before the chosen launch time and opens trading according to the authoritative `launchAt` behavior. It is not a second backend deployment at launch time.

Read **[Direct and Draft Launches](/creators/direct-and-draft)**.

## 3. Native bonding / PRE trading

PRE is the launch market state.

Bonding stays chain-native:

| Chain | Bonding asset |
| --- | --- |
| BNB Chain | BNB |
| Solana | SOL |
| Robinhood Chain | ETH |

During PRE:

- traders can use the active buy and sell controls for that chain
- the campaign advances through its launch market
- trading fees follow the active generation and Treasury routing
- UpVotes and public activity can increase visibility where enabled
- league, recruiter, squad, and airdrop accounting can track qualifying activity
- creator safety, cooldown, wallet, and risk controls remain enforced by the active chain generation

Read **[Bonding Curve](/platform/bonding-curve)** and **[Fee Model](/fees)**.

## 4. Graduation Market

Bonding currency and permanent post-graduation quote market are separate concepts.

A creator may choose from Graduation Markets that are currently offered for the selected chain. The exact quote identity is chain-specific and must be revalidated when the graduation threshold is reached.

Unsafe selected markets fail closed. MemeWarzone does not silently replace an unsafe selected market with the native asset.

## 5. Graduation

Graduation ends the bonding phase when the campaign reaches the active threshold for its generation.

The chain then hands the campaign into its permanent post-graduation venue:

| Chain | Post-graduation venue architecture |
| --- | --- |
| BNB Chain | Topaz |
| Solana | Meteora |
| Robinhood Chain | chain-local V3 infrastructure |

Permanent liquidity custody and fee rights remain generation- and chain-specific.

Read **[Graduation](/platform/graduation)**.

## 6. POST trading

POST is the post-graduation state on **all three first-class chains**.

Graduation changes the liquidity venue, not the MemeWarzone campaign identity. Token Details and the War Trade Room remain the user-facing operating surfaces while the underlying route becomes Topaz, Meteora, or Robinhood V3 according to chain.

Read **[War Trade Room](/traders/war-trade-room)**.

## 7. Competition and recurring rewards

Graduation is not the end of the campaign lifecycle.

A campaign can continue through:

- Normal Battles
- Tournaments and Vote Tournaments
- Major War League
- Quarterly Championship
- chain-native claims
- recruiter and squad activity
- creator fee/position entitlement where supported
- community growth and recurring attention

Arena and financial competition activation remain separate from the existence of the launchpad campaign itself.

Read **[Arena Overview](/arena)** and **[Epochs & Claims](/rewards/epochs-and-claims)**.

## Native launch versus Import

Native launch deploys a MemeWarzone campaign/token and gives it the lifecycle above.

**Import** registers an already-existing token and its project page without fabricating a native campaign, bonding history, graduation, or creator economics.

Read **[Import an Existing Token](/import)** for BNB, Solana, and Robinhood existing projects.
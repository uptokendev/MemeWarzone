---
title: How MemeWarzone Works
description: The full MemeWarzone lifecycle across Prepare, Launch or Import, trading, graduation, rewards, Arena competition, Tournaments, Major War League, and Quarterly Championship.
---

MemeWarzone connects the full memecoin lifecycle instead of ending at graduation.

The product thesis is simple: **graduation is when the real battle starts**.

## The full lifecycle

**Prepare → Launch / Import → Trade → Graduate → Compete → Recruit → Earn → Battle → Tournament → League → Return**

Not every project uses every step. Native MemeWarzone campaigns begin in Draft or Prepare Mode and can move through bonding and graduation. Existing projects can enter through Import without creating a new token.

![MemeWarzone ecosystem loop](/images/docs/how-it-works-ecosystem-loop.png)

## Path A: launch a new campaign

1. Create a Draft or use Direct Deploy.
2. Build the project identity and community in Prepare Mode.
3. Deploy the campaign through the supported chain flow.
4. Trade through native bonding before graduation.
5. Reach the graduation threshold.
6. Revalidate the selected Graduation Market.
7. Move into the chain-specific permanent post-graduation market.
8. Continue inside MemeWarzone through trading, community, rewards, and future Arena competition.

## Path B: import an existing token

1. Connect the project wallet.
2. Choose BNB or Solana in the current public Import flow.
3. Enter the existing contract address or mint.
4. MemeWarzone resolves the token identity.
5. Prove current project ownership automatically when possible, or request manual review.
6. Create or claim the project page.
7. Add project information, media, and socials.
8. Share the page and build community without relaunching the token.

Import does not fabricate a native campaign, bonding history, graduation, or creator economics. It also does not automatically grant Arena access.

Read **[Import an Existing Token](/import)** for the full boundary.

## Market lifecycle for native campaigns

Native campaigns bond in the native asset of their chain:

- BNB campaigns bond in BNB
- Solana campaigns bond in SOL
- Robinhood campaigns are designed to bond in ETH when production creation is enabled

At graduation, MemeWarzone revalidates the selected Graduation Market before moving liquidity to the permanent venue. There is no silent fallback to another quote market if the selected market becomes unsafe.

Current post-graduation venue architecture is:

| Chain | Venue |
| --- | --- |
| BNB | Topaz |
| Solana | Meteora |
| Robinhood | chain-local V3 infrastructure once production activation is approved |

## The Warzone after graduation

The Arena is the post-graduation competitive layer.

Its documented product model includes:

- Normal Battles
- manual challenges and AUTO DEPLOY where enabled
- scheduled starts and immutable LIVE baselines
- V3 scoring
- community Boosts
- Normal Tournaments
- Vote Tournaments
- Final Salvo tie-breaks
- Monthly Major War League
- Quarterly Championship
- Event Sponsorship
- chain-native competition claims

These systems are documented so projects can understand the Warzone before production activation. Their production feature flags remain separate from launch/import functionality.

## How a Normal Battle works

The canonical flow is:

**Challenge / AUTO DEPLOY → Accept / Counter / Decline → entry settlement → scheduled start → LIVE baseline → scoring → settlement → claim/history**

Battle identity is chain-specific even when metrics are normalized for scoring.

The current V3 score weights are:

| Metric | Weight |
| --- | ---: |
| Market-cap growth | 45 |
| Holder growth | 27 |
| Eligible real volume | 18 |
| Community Boost | 10 max |

The Boost curve is **10 × U / (U + 100)**, where `U` is confirmed $1 Normal Battle Boost units. Boost can contribute at most 10 Battle points.

Read **[Battle Scoring & Boosts](/arena/scoring-and-boosts)** for the full scoring and money rules.

## Tournaments and league progression

Normal Tournaments use chain-specific registration, entry, participant state, rounds, winners, settlement, and claims.

Vote Tournaments use a different regulation format:

- 24-hour regulation
- one free vote = 1 Vote Point
- $1 paid Boost = 2 Vote Points
- no market-cap, holder, or volume scoring during regulation
- exact ties move into Final Salvo

Monthly Major War League and Quarterly Championship preserve chain identity. Quarterly Championship is a continuous chain-specific standing across the quarter, not a quarterfinal/semi/final knockout bracket.

## How rewards fit the system

MemeWarzone also includes recurring incentive systems around the campaign lifecycle.

Leagues create recurring competition. Recruiter and Squad systems reward growth and contribution. Airdrops create another reward lane for qualifying activity. Claims keep earned rewards visible and settled through chain-native payout paths.

Financial rules are generation- and subsystem-specific. Production activation is never inferred just because a feature is documented or merged.

## Current production boundary

Project Import can be ON while Arena is OFF.

An imported project can be public and owner-verified while Battle, Tournament, Boost, League, Arena claim, and imported-token trading actions remain unavailable.

Likewise, Robinhood being a strategic first-class chain does not mean Robinhood production creation is currently enabled.

## Core surfaces

| Surface | Purpose |
| --- | --- |
| Create / Prepare | build or deploy a native campaign |
| Import your memecoin | register an existing token without relaunching it |
| Token / Project Details | public project state, identity, community, and supported market actions |
| War Trade Room | normalized discovery and trading context across market stages |
| Arena | post-graduation competition and event context |
| Command Center | private wallet, project, reward, and account operations |

## Where to go next

Read **[Campaign System](/platform/campaign-lifecycle)** for native campaign states.

Read **[Import an Existing Token](/import)** for external projects.

Read **[Arena Overview](/arena)** for the Warzone.

Read **[Epochs & Claims](/rewards/epochs-and-claims)** for reward settlement.
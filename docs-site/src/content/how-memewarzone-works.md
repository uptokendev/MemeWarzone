---
title: How MemeWarzone Works
description: The full three-chain MemeWarzone lifecycle across Prepare, Launch or Import, trading, graduation, rewards, Arena competition, Tournaments, Major War League, and Quarterly Championship.
---

MemeWarzone connects the full memecoin lifecycle instead of ending at graduation.

The product thesis is simple: **graduation is when the real battle starts**.

The same product model spans **BNB Chain, Solana, and Robinhood Chain**.

## The full lifecycle

**Prepare → Launch / Import → Trade → Graduate → Compete → Recruit → Earn → Battle → Tournament → League → Return**

Not every project uses every step. Native MemeWarzone campaigns begin in Draft or Prepare Mode and can move through bonding and graduation. Existing projects can enter through Import without creating a new token.

![MemeWarzone ecosystem loop](/images/docs/how-it-works-ecosystem-loop.png)

## Path A: launch a new campaign

1. Choose BNB, Solana, or Robinhood.
2. Create a Draft / Prepare project or use Direct launch.
3. Select the launch timing and Graduation Market where available.
4. Deploy through the chain-specific launch path.
5. Trade through native bonding: BNB, SOL, or ETH.
6. Reach the active graduation threshold.
7. Revalidate the selected Graduation Market.
8. Move into the chain's permanent post-graduation venue.
9. Continue inside MemeWarzone through trading, community, rewards, claims, and Warzone competition.

The chain-specific post-grad venue architecture is:

| Chain | Native bonding | Post-grad venue |
| --- | --- | --- |
| BNB | BNB | Topaz |
| Solana | SOL | Meteora |
| Robinhood | ETH | chain-local V3 infrastructure |

## Path B: import an existing token

1. Connect the project wallet.
2. Choose **BNB, Solana, or Robinhood**.
3. Enter the existing contract address or mint.
4. MemeWarzone resolves the token identity on that chain.
5. Prove current project ownership automatically when possible, or request manual review.
6. Create or claim the project page.
7. Add project information, media, and socials.
8. Share the page and build community without relaunching the token.

Import does not fabricate a native campaign, bonding history, graduation, or creator economics. It also does not automatically grant Graduation Market or Arena eligibility.

Read **[Import an Existing Token](/import)** for the full boundary.

## Native launch is the same product on three chains

The chain changes execution, not the product meaning.

### BNB

BNB uses EVM launch contracts, BNB-native bonding, chain-local Graduation Market validation, Topaz post-grad execution, permanent LP custody, and BNB-native reward settlement.

### Solana

Solana stays Solana-native for wallets and transaction construction, bonds in SOL, graduates through the accepted Solana market architecture, and uses SOL-native settlement.

### Robinhood

Robinhood uses the shared EVM product model with Robinhood-specific chain identity, ETH-native bonding, chain-local Graduation Market assets, V3 post-grad execution, permanent V3 position custody, ETH-in / ETH-out routing, and ETH-native settlement.

Read **[Robinhood Operations](/platform/robinhood-operations)** for the complete Robinhood flow.

## Graduation Market

Bonding asset and permanent quote market are separate.

Creators select from Graduation Markets currently offered on their chain. The exact quote identity is chain-specific and revalidated at graduation for identity, route, reference health, and executable capacity.

If a selected non-native quote becomes unsafe, MemeWarzone fails closed instead of silently switching to WBNB, WSOL, or WETH.

## The Warzone after graduation

Arena is the post-graduation competitive layer across the three-chain product.

Its product model includes:

- Normal Battles
- manual challenges and AUTO DEPLOY where enabled
- scheduled starts and immutable LIVE baselines
- V3 scoring
- Community Boosts
- Normal Tournaments
- Vote Tournaments
- Final Salvo tie-breaks
- Monthly Major War League
- Quarterly Championship
- Event Sponsorship
- chain-native competition claims

Battle, Tournament, League, and Claim identity stays chain-specific even when scoring metrics are normalized.

## How a Normal Battle works

The canonical flow is:

**Challenge / AUTO DEPLOY → Accept / Counter / Decline → entry settlement → scheduled start → LIVE baseline → scoring → settlement → claim/history**

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

Monthly Major War League and Quarterly Championship preserve BNB, Solana, or Robinhood identity. Quarterly Championship is a continuous chain-specific standing across the quarter, not a quarterfinal/semi/final knockout bracket.

## How rewards fit the system

MemeWarzone includes recurring incentive systems around the campaign lifecycle.

Leagues create recurring competition. Recruiter and Squad systems reward growth and contribution. Airdrops create another reward lane for qualifying activity. Claims keep earned rewards visible and settled through chain-native payout paths.

BNB settles in BNB, Solana in SOL, and Robinhood in ETH for the applicable native reward rail.

## Product support and activation

MemeWarzone separates **what a chain supports** from **which financial rails are currently enabled**.

BNB, Solana, and Robinhood are all first-class integrated product chains. Creation, graduation, claims, Arena, quote assets, or other financial rails can still be enabled or paused independently for operational safety without changing that product parity.

Likewise, Import can be active for a project while its Arena access remains locked.

## Core surfaces

| Surface | Purpose |
| --- | --- |
| Create / Prepare | build or deploy a native BNB, Solana, or Robinhood campaign |
| Import your memecoin | register an existing BNB, Solana, or Robinhood token without relaunching it |
| Token / Project Details | public project state, identity, community, and supported market actions |
| War Trade Room | normalized discovery and trading context across chains and market stages |
| Arena | post-graduation competition and event context |
| Command Center | private wallet, project, reward, and account operations |

## Where to go next

Read **[Campaign System](/platform/campaign-lifecycle)** for native campaign states.

Read **[Robinhood Operations](/platform/robinhood-operations)** for the Robinhood launchpad and post-grad flow.

Read **[Import an Existing Token](/import)** for external projects.

Read **[Arena Overview](/arena)** for the Warzone.

Read **[Epochs & Claims](/rewards/epochs-and-claims)** for reward settlement.
---
title: Chain Readiness
description: How BNB, Solana, and Robinhood fit into the same MemeWarzone product, including launchpad, Import, post-grad venues, rewards, claims, and Arena.
---

MemeWarzone has **three first-class product chains: BNB Chain, Solana, and Robinhood Chain**.

Robinhood is not a side integration or an Import-only network. It is integrated into the same MemeWarzone product model as BNB and Solana: creators can use the launch lifecycle, traders use chain-native bonding and post-grad markets, existing projects can use Import, and the chain identity continues into rewards, claims, and the Warzone.

Production activation of an individual rail can still be controlled independently. That operational safety gate does not change the product parity documented here.

## Product parity

| Product capability | BNB | Solana | Robinhood |
| --- | --- | --- | --- |
| Draft / Prepare Mode | Yes | Yes | Yes |
| Direct launch | Yes | Yes | Yes |
| Scheduled launch model | Yes | Yes | Yes |
| Native bonding | BNB | SOL | ETH |
| Graduation Market | chain-specific | chain-specific | chain-specific |
| Post-grad venue | Topaz | Meteora | V3 infrastructure |
| Existing-token Import | Yes | Yes | Yes |
| UpVotes / discovery model | Yes | Yes | Yes |
| Recruiter / Squad / Airdrop accounting | chain-aware | chain-aware | chain-aware |
| Claims settlement asset | BNB | SOL | ETH |
| Arena chain identity | Yes | Yes | Yes |
| Major War League / Quarterly identity | chain-specific | chain-specific | chain-specific |

## BNB Chain

**Production chain:** 56  
**Native asset:** BNB

BNB uses the EVM launch architecture with native BNB bonding, Graduation Market selection, Topaz post-graduation markets, permanent liquidity custody, Treasury routing, creator protections, Import, rewards, claims, and Arena identity.

Historical factory generations keep the rules they launched with. New generations do not reinterpret old campaigns.

## Solana

**Production:** mainnet-beta  
**Native asset:** SOL

Solana implements the same MemeWarzone product semantics through Solana-native transaction and program mechanics.

That includes Wallet Standard support, Draft / Prepare, Direct and scheduled launch behavior, bonding BUY/SELL, Graduation Market identity, Meteora graduation/post-grad continuity, Import, rewards, claims, and Arena identity.

Solana wallet transaction mechanics remain Solana-native: V0 transactions, address lookup tables where used, fresh blockhash/last-valid-height handling, signer correctness, simulation, and replay protection are part of the implementation model rather than changes to the product rules.

## Robinhood Chain

**Production chain:** 4663  
**Native asset:** ETH

Robinhood uses the shared EVM product architecture while keeping Robinhood-specific chain identity and V3 execution.

### Full Robinhood launchpad path

The Robinhood launchpad follows the same user lifecycle as BNB and Solana:

**Draft / Prepare Mode → Direct or Scheduled Deploy → ETH bonding → graduation threshold → Graduation Market revalidation → V3 post-grad market → permanent position custody → continuous MemeWarzone trading/community → Warzone**

Robinhood launchpad parity includes:

- Draft and Prepare Mode
- Direct deployment
- scheduled launch semantics
- ticker reservation and creator safety
- ETH-native bonding BUY/SELL
- chain-local Graduation Market selection
- generation-aware campaign state
- graduation into the Robinhood V3 venue
- permanent V3 position custody/locker behavior
- ETH-in / ETH-out user routing
- fee and Treasury reconciliation
- creator position-fee entitlement where the active generation supports it
- UpVotes and discovery where enabled
- Recruiter, Squad, Airdrop, League, and claim identity
- Command Center chain identity
- post-grad Arena, Tournament, MWL, Quarterly, and claim identity

Robinhood is therefore documented as a complete MemeWarzone chain, not merely as an upcoming network.

### Robinhood Import

Existing Robinhood tokens can use the same project-onboarding concept as BNB and Solana.

Robinhood Import resolves the token on chain 4663, keeps ownership proof separate from launch and Arena eligibility, and does not create a fake MemeWarzone campaign or bonding history.

Read **[Import an Existing Token](/import)**.

## Chain activation is independent

MemeWarzone separates product support from operational activation.

For any of the three chains, these rails can be enabled or paused independently:

- project Import
- campaign creation
- bonding/trading
- graduation
- claims
- Arena
- Graduation Market quote assets
- canary/operational access

This means a temporary operational gate on one rail does not remove the chain from the product or documentation.

## Native settlement

| Chain | Bonding asset | Native reward / claim settlement |
| --- | --- | --- |
| BNB | BNB | BNB |
| Solana | SOL | SOL |
| Robinhood | ETH | ETH |

Rewards stay chain-native. A reward generated on one chain is not silently bridged or converted into another chain asset.

## Post-graduation venue architecture

| Chain | Current venue architecture |
| --- | --- |
| BNB | Topaz |
| Solana | Meteora |
| Robinhood | chain-local V3 infrastructure |

Graduation changes the liquidity venue, not the MemeWarzone experience. Campaign identity, chain, generation, pool, and route remain explicit end to end.

## Before signing anything

Always verify:

- selected chain
- connected wallet
- contract address, mint, or campaign identity
- current campaign state
- asset being spent
- destination/route shown by the wallet

Read **[Campaign System](/platform/campaign-lifecycle)** for the full three-chain launch lifecycle, **[Import an Existing Token](/import)** for existing projects, and **[Arena Overview](/arena)** for the Warzone.
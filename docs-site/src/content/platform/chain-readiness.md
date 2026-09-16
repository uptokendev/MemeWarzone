---
title: Chain Readiness
description: How BNB, Solana, and Robinhood fit into MemeWarzone, including the difference between strategic support, staging certification, and production activation.
---

MemeWarzone's strategic first-class chains are **BNB Chain, Solana, and Robinhood Chain**.

A chain being part of the product architecture does not mean every subsystem on that chain is active in production. Creation, graduation, claims, Arena, quote assets, and operational canaries can each be enabled or held independently.

## BNB Chain

**Production chain:** 56  
**Destructive staging:** BSC Testnet 97  
**Native asset:** BNB

BNB is the most mature EVM campaign lifecycle.

The native path includes BNB bonding, graduation, Topaz post-graduation markets, permanent liquidity custody, Treasury routing, creator protections, and historical campaign generations.

BNB existing-token Import is part of the current public onboarding flow.

## Solana

**Production:** mainnet-beta  
**Destructive staging:** devnet  
**Native asset:** SOL

Solana remains Solana-native rather than being forced into an EVM-shaped model.

The product preserves Wallet Standard support, known-good wallet CREATE, bonding BUY/SELL, V0 transactions where established, ALT handling, fresh blockhash/last-valid-height behavior, signer correctness, simulation, replay safeguards, Meteora graduation, and post-graduation continuity.

Solana existing-token Import is part of the current public onboarding flow.

## Robinhood Chain

**Production chain:** 4663  
**Permanent destructive staging:** 46630  
**Native asset:** ETH

Robinhood is a first-class strategic chain, but production creation remains fail-closed until the required staging lifecycle, deployment identity, V3 infrastructure, locker, oracle/route, recovery, claims, Arena, and canary evidence are complete.

Robinhood Import is a separate concern from Robinhood launch deployment. If enabled, Import uses a narrow read-only token/project-ownership path and must not pull Robinhood launch, graduation, trading, or claim dependencies into onboarding.

The public Import UI currently keeps Robinhood behind its own disabled-by-default switch.

## Chain activation is independent

Each chain can have a separate state for:

- general support
- project Import
- campaign creation
- bonding/trading
- graduation
- claims
- Arena
- Graduation Market quote assets
- canary/operational readiness

This allows MemeWarzone to keep one feature active while another remains fail-closed.

For example, **project Import can be ON while Arena is OFF**, and Robinhood can remain present in the product roadmap while production creation stays disabled.

## Native bonding and settlement

| Chain | Native bonding asset | Native financial settlement |
| --- | --- | --- |
| BNB | BNB | BNB |
| Solana | SOL | SOL |
| Robinhood | ETH | ETH |

Rewards and claims stay chain-native. No user should assume that a reward generated on one chain is automatically bridged or swapped into another.

## Post-graduation venue architecture

| Chain | Current venue architecture |
| --- | --- |
| BNB | Topaz |
| Solana | Meteora |
| Robinhood | chain-local V3 infrastructure |

Graduation changes the liquidity venue, not the intended MemeWarzone user experience. Market identity, chain, pool, route, and generation remain explicit.

## Before signing anything

Always verify:

- selected chain
- connected wallet
- contract address or mint
- campaign or imported-project identity
- current state
- asset being spent
- destination/route shown by the wallet

Read **[Campaign System](/platform/campaign-lifecycle)** for native launches, **[Import an Existing Token](/import)** for external tokens, and **[Arena Overview](/arena)** for the post-graduation Warzone.
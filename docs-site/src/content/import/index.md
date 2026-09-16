---
title: Import an Existing Token
description: Register an existing BNB or Solana token with MemeWarzone, prove project ownership, and build a public project page without relaunching the token.
---

MemeWarzone has two entry paths: **launch a new campaign** or **import a token that already exists**.

Import does not create a second ticker, deploy a new token, move liquidity, or turn an external token into a MemeWarzone launch. It creates a MemeWarzone project identity around the token you already have.

## Current availability

The public Import flow currently supports:

- **BNB** existing-token registration
- **Solana** existing-token registration

Robinhood import is implemented behind its own disabled-by-default switch and is not a public production promise until it is explicitly enabled.

Import is independent from Arena activation. A project can be imported while Battles, Tournaments, Major War League, Quarterly, Boost payments, Arena claims, and imported-token trading remain disabled.

## Import flow

1. Open **Import your memecoin**.
2. Connect the wallet that controls the project where possible.
3. Choose the token chain.
4. Enter the contract address or mint.
5. MemeWarzone resolves the token identity from the selected chain.
6. Prove project ownership automatically when an authoritative owner is exposed, or request manual review when automatic verification is unavailable.
7. Add the public project image, description, website, X, Telegram, and other supported profile details.
8. Publish and share the MemeWarzone project page.

## Ownership verification

Ownership verification answers one question:

> Who is allowed to control this MemeWarzone project page?

It does **not** certify the token as safe and it does **not** approve the token for Arena competition.

### BNB and EVM ownership

When the contract exposes a current owner through a supported ownership method, the connected wallet must match that current authority and complete the signed wallet-action flow.

MemeWarzone does not trust a wallet address typed into a form, and a historical deployer is not treated as the current owner by itself.

### Solana ownership

MemeWarzone resolves the current token authority from authoritative Solana token data and compares it with the connected signed wallet.

A revoked or unavailable authority does not auto-verify a project.

## Manual ownership review

Some tokens are renounced, use authority models that cannot be verified automatically, or need additional project-level evidence.

Those projects can request a manual ownership review. A manual review request stays separate from Arena approval and cannot self-approve the project.

Projects waiting for manual ownership review remain hidden until the ownership review is approved under the current public import flow.

## Imported project page

An imported project page can show:

- project image
- name and ticker
- chain
- contract address or mint
- description
- website
- X and Telegram
- **IMPORTED** status
- **OWNER VERIFIED** status when ownership has been proven
- owner-only profile editing where enabled
- sharing and community onboarding surfaces

## Warzone access is separate

An imported token does not automatically receive financial or competitive access.

Until Arena activation and token-specific eligibility are separately approved, the imported project remains financially inert and displays **WARZONE ACCESS LOCKED**.

That means Import alone does not enable:

- buy or sell actions
- bonding or graduation
- MemeWarzone creator economics
- UpVote payments
- Battles or AUTO DEPLOY
- Tournaments or Vote Tournaments
- Major War League or Quarterly Championship
- Boost payments
- Arena claims
- Graduation Market eligibility
- competition eligibility

## What OWNER VERIFIED means

**OWNER VERIFIED** means MemeWarzone has verified control of the project page through the current ownership process.

It does not mean the token was launched by MemeWarzone, has been audited, is risk-free, has been approved for a Graduation Market, or has been admitted to Arena competition.

Read **[Arena Overview](/arena)** to understand the competitive layer and **[Campaign System](/platform/campaign-lifecycle)** if you want to launch a new MemeWarzone campaign instead.
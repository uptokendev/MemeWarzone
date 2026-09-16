---
title: Import an Existing Token
description: Register an existing BNB, Solana, or Robinhood token with MemeWarzone, prove project ownership, and build a public project page without relaunching the token.
---

MemeWarzone has two entry paths: **launch a new campaign** or **import a token that already exists**.

Import does not create a second ticker, deploy a new token, move liquidity, or turn an external token into a MemeWarzone launch. It creates a MemeWarzone project identity around the token you already have.

## Supported chains

The Import system is built for all three first-class MemeWarzone chains:

- **BNB Chain**
- **Solana**
- **Robinhood Chain**

Robinhood Import uses the EVM ownership model just like BNB at the product layer, while keeping its chain identity, RPC, token address, and ownership evidence separate. Import does not depend on Robinhood launch, bonding, graduation, V3 trading, claims, or Arena activation.

## Import flow

1. Open **Import your memecoin**.
2. Connect the wallet that controls the project where possible.
3. Choose **BNB, Solana, or Robinhood**.
4. Enter the contract address or mint.
5. MemeWarzone resolves the token identity on that chain.
6. Prove project ownership automatically when an authoritative owner is exposed, or request manual review when automatic verification is unavailable.
7. Add the public project image, description, website, X, Telegram, and other supported profile details.
8. Publish and share the MemeWarzone project page.

## Ownership verification

Ownership verification answers one question:

> Who is allowed to control this MemeWarzone project page?

It does **not** certify the token as safe and it does **not** approve the token for Arena competition.

### BNB and Robinhood ownership

BNB and Robinhood use the EVM ownership path.

Where the token exposes current ownership through a supported method such as `owner()` or `getOwner()`, the connected wallet must match that current authority and complete the signed wallet-action flow.

MemeWarzone does not trust a wallet address typed into a form, and a historical deployer is not treated as the current owner by itself.

### Solana ownership

MemeWarzone resolves the current token authority from authoritative Solana token data and compares it with the connected signed wallet.

A revoked or unavailable authority does not auto-verify a project.

## Manual ownership review

Some tokens are renounced, use authority models that cannot be verified automatically, or need additional project-level evidence.

Those projects can request a manual ownership review. A manual review request stays separate from Arena approval and cannot self-approve the project.

## Imported project page

An imported project page can show:

- project image
- name and ticker
- BNB, Solana, or Robinhood chain identity
- contract address or mint
- description
- website
- X and Telegram
- **IMPORTED** status
- **OWNER VERIFIED** status when ownership has been proven
- owner-only profile editing where enabled
- sharing and community onboarding surfaces

## Import is not a launch

Import and native launch are deliberately separate.

An imported project does not automatically receive MemeWarzone launch economics, bonding, graduation, a Graduation Market, or post-graduation liquidity simply because the project page exists.

The project may later enter Warzone systems only through the separate eligibility and activation rules for those systems.

## Warzone access is separate

Project ownership authority and Arena competition authority are different state machines.

**OWNER VERIFIED** means the project page controller has been verified. It does not mean:

- launched by MemeWarzone
- audited or risk-free
- approved as a Graduation Market asset
- approved for Battle or Tournament entry
- financially endorsed by MemeWarzone

Where Arena access is not active for an imported project, the page remains financially inert and can show **WARZONE ACCESS LOCKED**.

Read **[Chain Readiness](/platform/chain-readiness)** for the three-chain model, **[Arena Overview](/arena)** for competition, and **[Campaign System](/platform/campaign-lifecycle)** if you want to launch a new MemeWarzone campaign instead.
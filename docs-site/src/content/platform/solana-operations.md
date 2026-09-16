---
title: Solana Operations
description: Launch, trade, graduate, import, and follow campaigns on the Solana side of the three-chain MemeWarzone product.
---

Solana is one of MemeWarzone's three first-class product chains alongside **BNB Chain and Robinhood Chain**.

The campaign lifecycle stays familiar across all three networks while Solana keeps Solana-native wallet, transaction, mint, program, and market mechanics.

![Solana campaign flow](/images/docs/solana-campaign-flow.png)

## Create a Solana campaign

Choose Solana before starting the campaign form.

Creators can use Direct, Draft / Prepare Mode, and scheduled launch behavior according to the active campaign flow.

Bonding is SOL-native. Graduation moves the campaign into the Solana post-grad venue architecture while keeping the same MemeWarzone campaign identity.

## Import an existing Solana token

Already have a Solana token? Use **[Import an Existing Token](/import)** instead of launching a duplicate ticker.

Import resolves the existing mint, verifies project ownership where possible, and creates the MemeWarzone project identity without fabricating bonding or graduation history.

## Token Details

Token Details is the main campaign view after creation.

Use it to verify the campaign, read its current state, inspect public information, and use the actions available for that stage of the campaign.

![Solana Token Details](/images/docs/solana-token-details.png)

## Buy and sell

When the campaign is in PRE, use the active Solana trading controls shown by the product.

Before signing:

1. confirm Solana is selected
2. confirm the campaign and mint information
3. review the quoted transaction
4. confirm the wallet request
5. wait for the transaction result before submitting another action

## Solana transaction model

Solana remains Solana-native rather than being forced through an EVM abstraction.

The implementation can use Wallet Standard providers, VersionedTransaction/V0, address lookup tables, fresh blockhash/last-valid-height handling, simulation, and Solana-native signer rules where required.

Those execution details do not change the product semantics shared with BNB and Robinhood.

## UpVotes and discovery

Solana campaigns participate in MemeWarzone discovery through the campaign surfaces available to them, including UpVotes and the War Trade Room.

UpVotes increase visibility. They do not verify a campaign or guarantee its performance.

## Campaign address and mint address

These are different references.

The campaign address identifies the MemeWarzone campaign record and its state.

The mint address identifies the Solana token.

Verify which address a wallet, explorer, or product field is asking for before copying it.

## Graduation and POST

Solana campaigns bond in SOL and graduate into the accepted Solana post-grad market architecture, currently based around Meteora for the supported generation.

The selected Graduation Market remains chain-specific and is revalidated at graduation.

## Warzone identity

Solana remains explicit through Battles, Tournaments, Major War League, Quarterly Championship, rewards, and claims. Chain-normalized scoring does not erase chain identity or settlement asset.

Read **[Chain Readiness](/platform/chain-readiness)**, **[Campaign System](/platform/campaign-lifecycle)**, **[Graduation](/platform/graduation)**, and **[War Trade Room](/traders/war-trade-room)**.
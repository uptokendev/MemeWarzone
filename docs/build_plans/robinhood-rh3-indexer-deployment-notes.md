# Robinhood RH-3 — EVM Indexer and Deployment Boundary

Date: 2026-08-26
Branch: `feat/robinhood-chain-phase0-3`
Current inspected main baseline: `0d26317b74d3fe027e8307b09bfa6c3124cb5ff9`

## Purpose

Keep BNB indexing behavior unchanged while making the chain/runtime boundary reusable for Robinhood and later EVM chains.

## Current indexer finding

The existing `realtime-indexer/src/indexer.ts` already carries chain IDs through database campaign identity, indexer cursors, activity-event keys, campaign caches, trade/event processing, confirmation handling, and RPC provider creation.

The main BNB-specific runtime assumption is the small chain configuration list that currently constructs only chain 56 and 97 from BSC-named environment variables.

Therefore RH-3 does **not** require rewriting the scanning engine.

## Implemented boundary

`realtime-indexer/src/evmIndexerChains.ts` now defines:

- known EVM chains: 56, 97, 4663, 46630;
- active EVM indexer chains: 56, 97 only;
- normalized RPC/factory/start-block/vote-treasury runtime config;
- explicit chain activation rather than "RPC present = enabled" behavior.

The live `indexer.ts` is intentionally untouched in this first extraction batch. We first prove the generic config independently, then wire it into the live indexer only after the adapter test and TypeScript build are green. This gives us a rollback point with zero behavioral change to the BNB scanning engine.

## Deployment manifest finding

The existing `scripts/lib/indexerManifest.cjs` is generation-aware but still embeds BNB/Topaz post-graduation requirements:

- `PermanentLpLocker` is a required contract;
- `launchRouter` is required;
- `topazRouter` is required;
- `topazRouterAdapter` is Topaz-specific;
- `topazInfrastructure` is Topaz-specific.

That builder must not become Robinhood-compatible by filling Topaz fields with unrelated Robinhood contracts.

## Required later split

The target manifest model should have two layers.

### EVM protocol deployment

Chain-neutral launchpad data:

- environment;
- chain ID;
- generation;
- factory;
- campaign implementation;
- creator registry;
- risk registry;
- treasury router;
- graduation oracle;
- route authority/domain;
- deployment block;
- creation/support flags.

### Graduation venue deployment

DEX/venue-specific data:

- adapter kind;
- adapter address;
- canonical router/factory/program identifiers;
- wrapped native asset;
- locker/locked-position implementation;
- pool fee requirements where applicable;
- deployment blocks;
- indexing event profile.

For BNB the venue profile is Topaz. For Robinhood the venue profile remains unset until RH-5 verifies the accepted DEX.

## Non-activation invariant

Neither Robinhood RPC availability nor an empty deployment manifest may activate creation, factory discovery, campaign indexing, post-grad indexing, or public chain selectors.

Activation requires explicit approved configuration after testnet deployment and verification.

## CI baseline note

The repository's existing PR proof currently stops at `npm ci` before source tests execute, and this PR does not modify either package manifest or lockfile involved. The dedicated Robinhood foundation proof uses a no-lockfile-write install solely to exercise source compilation/tests while preserving the existing baseline failure for separate cleanup.

## Next safe wiring step

Only after the dedicated RH-3 proof is green:

1. fetch current-main `realtime-indexer/src/indexer.ts` again;
2. confirm no overlapping main changes;
3. replace only the local `CHAINS` construction with the tested EVM-chain config builder;
4. keep active chain IDs at 56/97;
5. run indexer TypeScript build and existing BNB tests;
6. compare PR to current main again.

No Robinhood runtime chain is enabled by that wiring step.

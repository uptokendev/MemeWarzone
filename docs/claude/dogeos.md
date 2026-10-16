# DogeOS (Chikyū testnet, chain 6281971)

Program state and decisions for DogeOS. Testnet only. Read this before touching any DogeOS work.
Integration branch: `feat/dogeos-testnet` (worktree `C:\Users\sven\Projects\MemeWarzone-dogeos`).

## Decisions (founder, 2026-10-14)

- **Base:** DogeOS builds on `release/evm-gen8` (merged at `126ffbc8b`). Gen-8 = coins launch into a
  Uniswap V4 pool with our hook (BNB 56/97, Robinhood 4663/46630). Its design is
  `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` on `origin/build/evm-gen8`; Appendix A leaves DogeOS out
  because Uniswap V4 is not on Chikyū.
- **Venue:** every DogeOS coin launches straight into a **Barkswap custom pool** (Algebra Integral
  1.2.1, unmodified) with our own plugin. This is "gen-8 on Algebra". MuchFi is dropped. The gen-7 curve +
  MuchFi V3 graduation path built earlier on this branch was never deployed and is being removed.
- **Economics:** gen-8 one-to-one. Testnet graduation target $150 (DOGE/USD testnet oracle, read once at launch).
- **Barkswap cut (B10):** comes out of MemeWarzone's share; the creator gets exactly gen-8's amounts on the gross fee.
- **Splitter base (B11):** gen-8 percentages over the net DOGE actually credited to the router bucket.
- **Side pools:** the coin stays a plain ERC-20; we detect side pools and alert (like gen-8 design 6.8, audit point A5). No token guard.
- **Fee mode:** LP-fee mode. The plugin sets the swap's pool fee; our positions are the only liquidity,
  so fees accrue to our positions and are collectable at any time. Barkswap keeps 3% of every fee
  (community fee, admin-settable up to 100%).
- **Sell fees in the coin:** sold for DOGE by a permissionless, impact-capped step our keeper calls.
  All money flows after that are native-only, as gen-8.
- **Scope:** full gen-8 parity (launcher, plugin, fee splitter, creator choice vault, creator escrow,
  reserve lock, lens). Each is a Barkswap variant with an audit diff against its gen-8 counterpart.
- **Barkswap dependency for testnet:** none. Any contract can create custom pools through their entry
  point (no per-deployer role, contrary to their own message). The signed letter matters for mainnet only.

## Sub-projects (parallel, each its own worktree, branch and session)

| # | Sub-project | Branch | Merges into `feat/dogeos-testnet` |
|---|---|---|---|
| 1 | Launch on Barkswap (gen-8 parity): contracts + app/API/indexer adapter | `feat/dogeos-testnet` | — (integration branch) |
| 2 | Rewards: leagues (weekly, MWL), recruiters, airdrops, holder payouts, reward claims, payout operators | `feat/dogeos-rewards` | after #1's contracts land |
| 3 | Arena: battles, vote battles + paid UP votes, vote treasury, war pools, tournaments, boost, sponsorship | `feat/dogeos-arena` | after #1 |
| 4 | MyDoge / DogeOS SDK wallet (needs a DogeOS `clientId`) | `feat/dogeos-mydoge` | any time |
| 5 | Social + display: notifications, share cards, embed, Testnet badge, Command Center Testnets panel | `feat/dogeos-social` | any time |

Out of scope everywhere: mainnet, imports on DogeOS, the token guard.

Merge rule: each sub-project branch merges into `feat/dogeos-testnet` (never into live), one at a time,
#1's contract and indexer work first. `scripts/dogeos-chain-list-exceptions.json` and the chain lists
are the usual conflict points; the chain-list guard (`node --test scripts/dogeos-chain-list-guard.test.mjs`)
must pass after every merge.

## Verified facts

- Barkswap on Chikyū: `docs/dogeos/barkswap-facts.md` (addresses, custom-pool path, plugin API, admin
  powers, side pools). Key points: one admin EOA `0xFB1525e1…045b` controls the factory; launch ≈ 6.1M gas
  of the 10M block; fees are input-side; `exactInputSingle` needs `deployer` = our launcher.
- Fork proof: `scripts/research/barkswap-plugin/` (README + results), 117/117 checks on a Chikyū fork.
  Use tick spacing 10; direct `pool.mint` (6.13M gas) beats the NPM route.
- DogeOS chain facts (RPC, explorer, gas, L1 fee, getLogs caps): `docs/templar/specs/2026-10-10-dogeos-foundation-launch-design.md`.
- Indexer (t18, `realtime-indexer/src/evm/evmGen8Bark.ts`): a Barkswap pool's gen-8 **pool id is its address
  left-padded to bytes32** (`barkPoolId`), so `campaigns-base.js gen8FieldsFromRow` and the holder batch accept
  DogeOS rows; `evm_gen8_pools.hook_address` = the plugin, `pool_manager_address` = the pool, `dex_trades.pair_address`
  = the pool; ticks / sqrt prices are stored in Barkswap orientation (coin = token0, price rises on buys). Rows keep
  `venue 'gen8'` / `execution_source 'gen8_v4'`. Conversion swaps write no trade/accrual row; sell accruals are t19's.
- Ingestion depth: DogeOS money rows (accruals, reward events, route runs, holder census) read to **20 blocks below
  `latest`** (founder 2026-10-15; `EVM_GEN8_MONEY_DEPTH_6281971` floor 17 = Chikyū's max reorg); display rows follow
  `latest` (`realtime-indexer/src/evm/evmGen8Config.ts` `GEN8_MONEY_DEPTH`). Cadence (since the release/evm-gen8 merge
  `ed508ed3a`): display every 4 s fast / 15 s idle, money lane once a minute, so accrual rows can lag ~60 s.
- Bark attribution (t19, `evmGen8BarkAttribution.ts`): `evm_gen8_bark_sell_fees` = one row per sell's coin fee,
  `evm_gen8_bark_credits` = one row per DOGE amount a launcher log credited to the router bucket; route runs read the credits.
- Migration `db/migrations/20261015_000010_dogeos_barkswap.sql` (the two tables, an accrual index, side-pool venue
  `'algebra'`), applied after 20261010 by `database/staging_apply_dogeos_barkswap.sh` (`dryrun` | `apply`, staging only, founder runs it).
- Measured on the fork: worst launch 6,293,026 gas (gate 7M); rounding ≤ 1 wei against us, ≤ 45 wei in our favour per
  swap per book (`docs/dogeos/barkswap-audit.md`, plugin "Tolerance").

## Deploy, wiring, keepers, canary

Runbook: **`docs/dogeos/barkswap-runbook.md`** (deploy order and commands, explorer verification, env blocks, staging
migration, keeper lanes, canary checks, known gaps). Keepers in short (`realtime-indexer/src/evm/dogeosBarkKeepers.ts`):
every lane off by default and dry-run until `DOGEOS_BARK_SEND_6281971=true`. Keeper key: collect/convert/pull, gradFee,
reserve, adminWatch + `restore`; operator key: route (`claimRouter` → `splitter.route`) and choice-vault buyback
(`EVM_CREATOR_CHOICE_ENABLED_6281971`); side-pool watch reads only and stays off until 20261015 is applied.

## Keys

Separate DogeOS keys live in the gitignored `config/dogeos.local` (deployer, oracle updater, keeper,
route authority = create signer, and from 2026-10-15 a fifth "DogeOS operator" key for the splitter,
router-claim and choice-vault operator roles; the keeper holds no contract role). Never read, print or commit
their values. The Bark keeper key **is** the graduation keeper key (`DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY`);
the operator key's name is `DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY`, generated by the founder before the deploy.

## Open before mainnet (founder decisions)

- D-1: `convert` writes its books right after the swap returns (spec wording says before); accepted for testnet.
- D-3: conversion cap (1%) and interval (10 min) are compile-time constants, not deploy-time inputs.
- D-9: MIT contracts compiled against the GPL-2.0-or-later Algebra interfaces: licence line.
- Choice-vault `PoolNotRestored`: buyback money depends on `restore`, so on Barkswap keeping the entry point's
  `POOLS_ADMINISTRATOR` role; testnet accepts; mainnet: founder decides (one option, not in any spec yet: a timelocked admin re-credit).
- Vault multisig = deployer (`TreasuryVaultV2`, `CharityTreasury`, `MonthlyLeagueTreasury`) must become the Safe on mainnet.
- Airdrop operator (`CommunityRewardsVault.airdropOperator`) = deployer (gen-8 46630 parity); sub-project 2 may move it.

## Rules

CLAUDE.md applies. In particular: no transaction with our keys without the founder's go, nothing on live
or mainnet, TEST stack only, contracts audited as a diff before tests, BNB/Robinhood/Solana behaviour unchanged.

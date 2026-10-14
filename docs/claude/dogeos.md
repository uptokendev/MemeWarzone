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
- **Side pools:** the coin stays a plain ERC-20; we detect side pools and alert (like gen-8 F18). No token guard.
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

## Keys

Separate DogeOS keys live in the gitignored `config/dogeos.local` (deployer, oracle updater, graduation
keeper, route authority). Never read, print or commit their values.

## Rules

CLAUDE.md applies. In particular: no transaction with our keys without the founder's go, nothing on live
or mainnet, TEST stack only, contracts audited as a diff before tests, BNB/Robinhood/Solana behaviour unchanged.

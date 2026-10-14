# DogeOS sub-project 1 (revised): EVM generation 8 on Barkswap custom pools (Chikyū testnet)

Date: 2026-10-14. Status: approved by the founder section by section (1-4), 2026-10-14.
Chain: DogeOS Chikyū testnet `6281971`. Testnet only. Branch: `feat/dogeos-testnet` (merged with
`release/evm-gen8` at `126ffbc8b`).

This spec **supersedes the launch part** of `docs/templar/specs/2026-10-10-dogeos-foundation-launch-design.md`
(gen-7 curve + MuchFi V3 graduation). That spec's **foundation** (chain identity, keys, DOGE/USD testnet
oracle, chain lists + guard, presentation, env generator, TEST-stack exposure) stays in force and is not
repeated here. Program context and the other four DogeOS sub-projects: `docs/claude/dogeos.md`.

## 1. Why and what

Gen-8 (design `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` on `origin/build/evm-gen8`, "the gen-8 design" below)
launches every BNB and Robinhood coin straight into a Uniswap V4 pool that our hook controls. Coins are
tradable and discoverable from the first trade, by anyone, without our signature. The gen-8 design leaves
DogeOS out (Appendix A): Uniswap V4 is not deployed on Chikyū.

DogeOS gets the same product on **Barkswap**, an unmodified Algebra Integral 1.2.1 DEX on Chikyū: each coin
launches into its own **Barkswap custom pool** with **our own plugin**. Verified facts:
`docs/dogeos/barkswap-facts.md`. Feasibility: `scripts/research/barkswap-plugin/` (fork proof, 117/117 checks
on a Chikyū fork; README has every check and gas figure).

### Founder decisions (2026-10-14)

| # | Decision |
|---|---|
| B1 | Venue: Barkswap custom pools with our plugin. MuchFi is dropped. |
| B2 | Economics: gen-8 one-to-one (section 2). Testnet graduation target $150. |
| B3 | Side pools: the coin stays a plain ERC-20; we detect side pools and alert (gen-8 F18). No token guard. |
| B4 | Fee mode: **LP-fee mode**. The plugin sets each swap's pool fee; our positions are the only liquidity, so fees accrue to our positions and are collectable at any time. |
| B5 | Sell fees arrive in the coin; they are sold for DOGE by a permissionless, price-impact-capped step our keeper calls. All later money flows are native-only. |
| B6 | Scope: **full gen-8 parity**: launcher, plugin, fee splitter, creator choice vault, creator escrow, reserve lock, lens. |
| B7 | Off-chain: gen-8's app/API/indexer layer with a Barkswap venue adapter; BNB/Robinhood's V4 path unchanged. |
| B8 | The 2026-10-10 gen-7/MuchFi DogeOS launch path (never deployed) is removed from the branch. |

### Out of scope

Mainnet (no Barkswap letter, mainnet oracle or external audit yet); the token guard; imports on DogeOS; the
gen-8 partner swap widget (`gen8Widget`) for DogeOS; everything owned by sub-projects 2-5 (rewards, arena,
MyDoge SDK, social/display). Those sub-projects build on the rows this one writes.

## 2. Economics (gen-8, unchanged)

- 1B supply: **850M** in position A (bonding range), **130M** in position B (above graduation), **20M** creator
  reserve.
- Curve: A spans the gen-7 start price to the gen-7 graduation price for the coin's target, from the virtual
  reserves of `LaunchFactoryGen7.curveForMarketCap` (gen-8 design 2.2). Target sized once at launch from the
  DOGE/USD testnet oracle through `GraduationOracle`. Testnet target **$150 market cap** (test-target chain
  list); the production tiers ($30K / $50K) exist but are not used on testnet.
- Fee **2%** while the price at swap start is inside A; **launch fee 90% falling linearly to 2% over 60 s**
  from `openAt`; the creator's first buy pays 2%. Gen-8 F1: the rate follows the price at swap start, not the
  latch.
- **Graduation** is the swap whose price crosses the graduation price: latch + `graduatedAt`, and a **one-time
  2% graduation fee** (2% of A's native) to fee routing (creator 0%).
- After graduation (price at or past the graduation price at swap start): **1%**, creator exactly **0.50% of
  volume**, MemeWarzone 0.50%.
- Creator first buy up to **70%** of supply, in the launch transaction. Later creator buys go through the
  creator escrow (gen-8 4.3). Scheduled open (`openAt`, gen-8 amendment B).
- Liquidity is locked forever: no function withdraws A or B principal.
- Fee split (league, recruiter, airdrop, squad, creator, protocol): as gen-8 decided (D1 = A, off-chain
  attribution with a bounded on-chain splitter).

### Barkswap differences (accepted)

- **Barkswap community fee**: 3% of every fee goes to Barkswap's vault (admin-settable up to 100%). Net to us:
  1.94% while bonding, 0.97% after graduation.
- **Fees are input-side**: buys pay in WDOGE, sells pay in the coin (B5). Buy fees are charged as r/(1+r) of
  the input so a buy costs the curve amount plus r, matching gen-7 within fee-unit rounding (1e6 units; worst
  case a few units in 1e6, measured 1.9999% for 2%).
- **Graduation fee** is taken inline in the crossing swap (try/catch) with a permissionless fallback step.

## 3. Contracts

New contracts only. No existing contract changes (gen-8's, gen-7's and every other). Compiler as gen-8
(Solidity 0.8.26, `cancun`; Chikyū supports PUSH0, MCOPY and TSTORE). No proxies, no upgrades: a fix is a new
generation. Testnet ownership: the DogeOS deployer key.

| Contract | Gen-8 counterpart | Responsibility |
|---|---|---|
| `MwzV4Token` | same | Plain 1B ERC-20. **Same bytecode**, reused as is. |
| `MwzBarkLauncher` | `MwzV4Launcher` + the money side of `MwzLaunchHook` | Barkswap custom-pool deployer and plugin factory (`beforeCreatePoolHook` returns the shared plugin). One-tx launch: coin CREATE2 (salt from the create signer so the coin sorts below WDOGE; reverts otherwise), `createCustomPool` through Barkswap's entry point, initialize, tick spacing **10**, pool fee setup for LP-fee mode, mint A and B one-sided directly on the pool (owned by the launcher), 20M to the reserve lock, optional creator first buy. Signed create (gen-8 D3) with `openAt`. Fee books: per-coin creator owed, router bucket, parked router (gen-8 F3/F4). Fee collection and coin-fee conversion (B4, B5). Graduation fee. Creator transfer (two-step). No function withdraws A or B principal. |
| `MwzBarkPlugin` | swap side of `MwzLaunchHook` | One shared plugin for all our pools. `beforeInitialize`: only the launcher. `beforeModifyPosition`: only the launcher may add liquidity. `beforeSwap`: the gen-8 rate (phase by price at swap start, launch decay from `openAt`, no swap before `openAt` except the creator first buy). `afterSwap`: graduation latch + `graduatedAt`, inline graduation fee (try/catch), no sell may leave the price below the start price (gen-8 F2), and one complete swap event per swap (pool, trader-side amounts, fee, rate, phase, price after the swap). Swaps by the launcher's conversion path pay no fee. |
| `MwzBarkFeeSplitter` | `MwzFeeSplitter` | Gen-8 claim-first fee routing to the vaults (`expectedPaid`), reading the launcher instead of the V4 PoolManager. |
| `MwzBarkCreatorChoiceVault` | `MwzCreatorChoiceVault` | Keep / holders / split / buyback; buybacks swap in our Barkswap pool. |
| `MwzBarkCreatorEscrow` | `MwzCreatorEscrow` | Escrow of creator buys after launch, through our pool. |
| `MwzBarkReserveLock` | `MwzReserveLock` | Releases the 2% reserve when latched, the price is at or past the graduation price, the pool is not mid-swap, and 1 h has passed since the latch. |
| `MwzBarkLaunchLens` | `MwzLaunchLens` | Views for app and API: progress, phase, price, current fee, owed amounts. |

Reused unchanged (same bytecode, DogeOS constructor arguments): the DOGE/USD testnet oracle (foundation),
`GraduationOracle`, and the vaults gen-8 routes into (weekly `TreasuryVaultV2`, `MonthlyLeagueTreasury`,
`RecruiterRewardsVault`, `ProtocolRevenueVault`, `RewardDistributor` for holders and airdrop,
`CommunityRewardsVault`). The DogeOS deploy stack keeps those and drops the gen-7 factory, campaign and MuchFi parts.

### Money flow (LP-fee mode)

1. Each swap's fee accrues to our A/B positions; Barkswap's 3% goes to its vault in the same swap.
2. A permissionless **collect** takes accrued fees (never principal) from the positions into the launcher.
3. WDOGE fees (from buys) are unwrapped and split by gen-8's rules: creator share per coin, the rest to the
   router bucket.
4. Coin fees (from sells) are sold for DOGE by a permissionless conversion that pays no fee and is bounded by
   a per-call price-impact cap; the DOGE is split by the same rules, per coin.
5. From there gen-8 unchanged: router bucket → fee splitter → vaults; creator claims from the launcher.
   The per-swap event carries what the indexer needs to attribute each fee (D1).

### Invariants (audit list, each with a fork test)

The gen-8 invariant list (gen-8 design 2.9) translated to Barkswap, at least:
A and B principal can never be withdrawn; only the launcher initializes and adds liquidity; the rate
per swap matches phase and decay; no swap before `openAt` except the creator first buy; no sell below the start
price; graduation latches once and the 2% graduation fee is taken exactly once; after graduation the creator
gets exactly 0.50% of volume (net of Barkswap's cut, stated as a share of what we receive); the fee books equal
the balances at all times; coin conversion never exceeds its impact cap; the reserve releases only under its
four conditions; claims pay only the entitled party; parked-router rules (F3/F4) hold.
Plus gen-8 audit regressions F1-F18 where they apply, and Barkswap-specific cases: the community fee cut,
admin `setPlugin` / `setPluginConfig` / `setCommunityFee` on our pools (principal stays safe, books stay correct,
the change is detected), and side-pool creation.

### Audit

Per CLAUDE.md, audited before tested. `MwzBarkLauncher` and `MwzBarkPlugin` are new code (an Algebra plugin is
too different from a V4 hook for a line diff): **full audit against the invariant list**. The other five:
**diff audit** against their gen-8 counterpart. Each change states reentrancy guard, checks-effects-interactions
order, reachable states, over/underflow and griefing, as CLAUDE.md requires.

### Accepted testnet risks

- Barkswap's admin (one EOA plus 19 configurator contracts) can change our pools' plugin, plugin config and
  community fee. It cannot move A/B principal. Detected and alerted; mitigated for mainnet by the letter.
- About 6.1M gas per launch (Barkswap deploys a 22.5 KB pool per coin): at most one launch per 10M block.
- Side pools (B3).
- Discovery: no DexScreener / GeckoTerminal indexing of DogeOS yet; Barkswap's router and UI route custom pools.

## 4. App, API and indexer

Principle: DogeOS uses gen-8's off-chain layer (create flow, one trade panel before and after graduation, gen-8
tables, the D14 split at the graduation block, D1 fee accruals, holders, coin page). A **Barkswap venue adapter**
sits next to the V4 path. Downstream readers (leagues, battles, coin page, Ably channels) see the same rows
and events for 6281971 as for BNB and Robinhood. **The V4 path for BNB and Robinhood stays byte-for-byte**,
proven by gen-8's existing tests.

**Indexer.** Reads two addresses per chain: the launcher (`Launched`, claims, creator transfer, router events)
and the plugin (one complete event per swap, `Graduated`). No per-pool log scans; the DogeOS 10k-block getLogs
window stays. Trader = `tx.from` (gen-8). Writes as gen-8: `curve_trades` up to and including the crossing
swap, `dex_trades` after (D14); `token_stats` / `market_stats` from the pool price; candles; D1 fee accrual
rows and `reward_events`. Config follows gen-8's env pattern (`0xaddr@startBlock`) with the DogeOS launcher
and plugin and a `barkswap` venue.

**API.** Gen-8 endpoints serve 6281971 through the adapter: campaign state (lens), progress, coin page, and
the signed create (D3) with `openAt`. The create signer also returns the CREATE2 salt that sorts the coin below
WDOGE. Gen-8 chain lists that the post-merge cleanup excluded DogeOS from (`GEN8_API_CHAIN_IDS` and the other
`evm-gen8-v4` exceptions) are re-decided one by one: 6281971 with venue `barkswap` where the path serves DogeOS,
an exception otherwise.

**App.** Gen-8's create branch calls our launcher (first-buy preview, 70% cap). Gen-8's single trade panel
executes through Barkswap's SwapRouter: buy = `exactInputSingle` with DOGE in and `deployer` = our launcher;
sell = approve the router, then `multicall(exactInputSingle, unwrapWNativeToken)`; quotes from QuoterV2 with
`deployer` (equal to execution, proven). Fee line and launch countdown from the lens. No trade authorization.
DOGE gas reserve and the "DogeOS" / "Barkswap" labels come from the foundation.

**Keepers** (in the indexer, existing DogeOS keeper key): fee collect + coin conversion; route worker
(`claimRouter` → splitter → vaults); graduation-fee fallback; reserve release; side-pool watch (Barkswap
factory pool creation for our coins → alert, shown on the coin page).

**Database.** Gen-8's migrations exist. A staging migration lets 6281971 pass gen-8's chain constraints;
the 2026-10-10 DogeOS migration is revised to drop the MuchFi-only parts. Production SQL is handed to the
founder, never run.

**Removed (B8).** MuchFi contracts (`contracts/dogeos/muchfi/*`), their audit diff, fork specs and fixtures;
MuchFi swap decoding in the V3 pool indexer; the keeper's MuchFi slot0 path; DogeOS in gen-7 factory discovery
and the gen-7 graduation keeper; the fee-10000 DogeOS trade path; the gen-7 factory/campaign/MuchFi parts of
the DogeOS deploy stack and their env. Anything a later reader still needs stays in git history.

## 5. Testing, gates, deployment

**Contract tests** on a Chikyū fork against Barkswap's real contracts: one test per invariant (section 3),
gen-8 regressions F1-F18 where applicable, Barkswap-specific cases, and gas per step (launch under ~7M; every
transaction under the 10M block).

**Off-chain tests.** Adapter: a recorded plugin swap event (fork fixture) produces the same rows a V4 swap
produces. Gen-8's V4 tests pass unchanged. The chain-list guard passes. Source pins change only to admit
reviewed DogeOS changes.

**Gates, in order:**
1. Gate 1: full suites against the base (`release/evm-gen8`); no new failures.
2. Gate 2: whole-branch review by a fresh branch reviewer.
3. Gate 3: fork rehearsal of the full deploy plus lifecycle in one fork process (deploy the stack, launch, 5+
   buyer wallets in the launch window, sell, graduate, collect, convert, route, creator claim, reserve
   release, creator choice, escrow), with gas per step and the DOGE budget including each transaction's L1
   data fee (`L1GasPriceOracle 0x5300000000000000000000000000000000000002 getL1Fee`).

**Deployment, each step only after an explicit founder go:**
1. Chikyū deploy with the DogeOS deployer key (shared vaults, oracle, the eight contracts), explorer
   verification, manifest.
2. TEST wiring: env blocks for the TEST API, indexer and frontend from the env generator; staging migration;
   no Coolify change without a go per call.
3. Testnet canary: one coin graduated by 5+ buyer wallets the founder funds; the gate-3 lifecycle on the real
   chain.

Barkswap does not need to grant anything for testnet: their entry point already holds the custom-pool role
and any contract can create custom pools through it (`docs/dogeos/barkswap-facts.md` section 2).

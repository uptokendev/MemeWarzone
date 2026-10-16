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
| B3 | Side pools: the coin stays a plain ERC-20; we detect side pools and alert (gen-8 design 6.8, audit point A5). No token guard. |
| B4 | Fee mode: **LP-fee mode**. The plugin sets each swap's pool fee; our positions are the only liquidity, so fees accrue to our positions and are collectable at any time. |
| B5 | Sell fees arrive in the coin; they are sold for DOGE by a permissionless, price-impact-capped step our keeper calls. All later money flows are native-only. |
| B6 | Scope: **full gen-8 parity**: launcher, plugin, fee splitter, creator choice vault, creator escrow, reserve lock, lens. |
| B7 | Off-chain: gen-8's app/API/indexer layer with a Barkswap venue adapter; BNB/Robinhood's V4 path unchanged. |
| B8 | The 2026-10-10 gen-7/MuchFi DogeOS launch path (never deployed) is removed from the branch. |
| B9 | Keys (2026-10-15): the create signer is the existing DogeOS route-authority key; a new fifth key, the **DogeOS operator**, holds the splitter, router-claim and choice-vault operator roles; the keeper key holds no contract role and only calls permissionless steps. |
| B10 | Barkswap's community fee (2026-10-15) comes entirely out of MemeWarzone's share: the creator gets exactly gen-8's amounts, computed on the gross fee (560 bps of every bonding fee, 0.50% of volume after graduation). |
| B11 | Splitter base (2026-10-15): gen-8's splitter percentages (league 37.5% of B, recruiter + squad + airdrop in their bands of B and G, protocol the rest) apply to the **net DOGE actually credited to the router bucket** (after Barkswap's cut, the creator's amount and coin conversion). League, recruiter, airdrop and protocol therefore share Barkswap's cut pro-rata; routing never stops because of the cut. Sub-project 2's pot readers use the same base. |

### Out of scope

Mainnet (no Barkswap letter, mainnet oracle or external audit yet); the token guard; imports on DogeOS; the
gen-8 partner swap widget (`gen8Widget`) for DogeOS; everything owned by sub-projects 2-5 (rewards, arena,
MyDoge SDK, social/display). In particular the creator choices `holders` and `split` (holder batches, the
holder `RewardDistributor` runs and their operator workflow) are wired and deployed here but exercised by
sub-project 2; this sub-project exercises `keep` and `buyback`. Those sub-projects build on the rows this one writes.

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
  volume**; MemeWarzone the rest of the fee net of Barkswap's cut (0.47% of volume at a 3% community fee, B10).
- Creator first buy up to **70%** of supply, in the launch transaction. Later creator buys go through the
  creator escrow (gen-8 4.3). Scheduled open (`openAt`, gen-8 amendment B).
- Liquidity is locked forever (gen-8 I6): A and B lose liquidity exactly once, `floor(liqA × 2%)` from A for
  the graduation fee; no other path removes liquidity from A or B.
- Fee split (league, recruiter, airdrop, squad, creator, protocol): as gen-8 decided (D1 = A, off-chain
  attribution with a bounded on-chain splitter). The creator's share of each **bonding** fee is gen-8's
  `creatorBondingBps` (D2, 560 bps of the gross fee); the rest of a bonding fee, net of Barkswap's cut, and the
  whole graduation fee go to the router bucket; after graduation the creator gets 50% of the gross fee (0.50% of
  volume) and the router bucket the rest net of the cut (B10). The crossing swap's own fee is a **bonding** fee
  (gen-8 audit A12, `HookFee.graduated == false`); the one-time 2% is the only entry in the graduation book.
- Oracle band (gen-8 F6): the launcher refuses a launch when the DOGE/USD price is outside a deploy-time band,
  **$0.01 to $10** per DOGE; the oracle reading may be at most **3600 s** old (the foundation's
  `GraduationOracle.maxPriceAge`, also passed as the launcher's age input).

### Barkswap differences (accepted)

- **Barkswap community fee**: 3% of every swap fee goes to Barkswap's vault (admin-settable up to 100%). Net
  received: 1.94% while bonding, 0.97% after graduation, all of the cut borne by MemeWarzone's share (B10). The
  plugin reads the pool's community fee at swap time, never a constant. The graduation fee is a liquidity burn,
  not a swap fee, and is not cut. If an admin raised the cut so far that the net fee is below the creator's
  amount, the creator still gets its full amount first and the router bucket gets what remains (never negative).
- **Fees are input-side**: buys pay in WDOGE, sells pay in the coin (B5). Buy fees are charged as r/(1+r) of
  the input so a buy costs the curve amount plus r, matching gen-7 within fee-unit rounding (1e6 units; worst
  case a few units in 1e6, measured 1.9999% for 2%).
- **Graduation fee** is taken inline in the crossing swap (try/catch) with a permissionless fallback step. The
  fallback runs only while the price is at or past the graduation price and the pool is not mid-swap, so the burn
  only ever returns WDOGE; it is taken at most once and never while the price is inside A.

## 3. Contracts

New contracts only. No existing contract changes (gen-8's, gen-7's and every other). Compiler as gen-8
(Solidity 0.8.26, `cancun`; Chikyū supports PUSH0, MCOPY and TSTORE). No proxies, no upgrades: a fix is a new
generation.

**Gen-8 sources.** Gen-8's contracts are not on this branch (only its off-chain layer came in with
`release/evm-gen8`). The counterparts are taken from `origin/build/evm-gen8` at `e129712b9` (`contracts/gen8/`
unchanged since `38ee22c18`) and added to this branch as new files under `contracts/gen8/`, byte-identical to
that commit, so `MwzV4Token` keeps its bytecode and every diff audit has a fixed base.

### Roles and keys (B9)

| Role | Holder |
|---|---|
| Owner / admin of every DogeOS contract (testnet) | DogeOS deployer key |
| Create signer (`createSigner`, signed create D3) | DogeOS route-authority key (existing) |
| Splitter operator (`route`), router-claim operator (`claimRouter`, F4), choice-vault operator (`buyback`, `executeHolderBatch`) | **DogeOS operator** key (new, fifth key in `config/dogeos.local`) |
| Collect, coin conversion, `restore`, graduation-fee fallback, reserve release, side-pool and admin-change watch | permissionless; called by the DogeOS keeper key, which holds no contract role (the foundation's rule stands) |
| DOGE/USD oracle updates | DogeOS oracle-updater key (foundation) |

| Contract | Gen-8 counterpart | Responsibility |
|---|---|---|
| `MwzV4Token` | same | Plain 1B ERC-20. **Same bytecode**, reused as is. |
| `MwzBarkLauncher` | `MwzV4Launcher` + the money side of `MwzLaunchHook` | Barkswap custom-pool deployer and plugin factory (`beforeCreatePoolHook` returns the shared plugin). One-tx launch: coin CREATE2 (salt from the create signer so the coin sorts below WDOGE; reverts otherwise), `createCustomPool` through Barkswap's entry point, initialize, tick spacing **10**, `EP.setFee(pool, 0)` before the dynamic-fee flag is enabled (so the pool's `lastFee` is 0 on every pool), mint A and B one-sided directly on the pool (owned by the launcher), 20M to the reserve lock, optional creator first buy. Signed create (gen-8 D3) with `openAt`; oracle band (F6). Fee books: per-coin creator owed, router bucket, parked router (gen-8 F3/F4). Fee collection and coin-fee conversion (B4, B5); the launcher itself sends the conversion swap. Graduation fee. Creator transfer (two-step). **Restore**: a permissionless `restore(coin)` re-applies our plugin, `setFee(0)` (while the dynamic-fee flag is off) and then the fixed launch plugin config through the entry point if a Barkswap admin changed them; it takes no arguments beyond the coin, so it cannot set anything else. No other post-launch entry-point call exists (no fee, tick-spacing or config choice after launch). No path removes liquidity except the one graduation burn (I6). |
| `MwzBarkPlugin` | swap side of `MwzLaunchHook` | One shared plugin for all our pools. `beforeInitialize`: only the launcher. `beforeModifyPosition`: only the launcher may add liquidity. `beforeSwap`: the gen-8 rate as `overrideFee` (phase by price at swap start, launch decay from `openAt`, no swap before `openAt` except the creator first buy); a coin-conversion swap returns `overrideFee` 0, which with `lastFee` 0 is a true 0 fee; it is recognised by a transient flag the launcher sets only inside `convert`, so the launcher's other swap (the creator first buy inside `launch`, 2%) is charged normally. `afterSwap`: graduation latch + `graduatedAt`, inline graduation fee (try/catch), no sell may leave the price below the start price (gen-8 F2), and one swap event per swap (fields below). |
| `MwzBarkFeeSplitter` | `MwzFeeSplitter` | Gen-8 claim-first fee routing to the vaults (`expectedPaid`), reading the launcher (`routerPaid`) instead of the hook. |
| `MwzBarkCreatorChoiceVault` | `MwzCreatorChoiceVault` | Keep / holders / split / buyback; buybacks swap in our Barkswap pool (WDOGE wrap, `deployer` = launcher) instead of V4 native currency 0, keeping gen-8's buyback caps. |
| `MwzBarkCreatorEscrow` | `MwzCreatorEscrow` | Escrow of creator buys after launch, through our pool (WDOGE wrap, `deployer` = launcher). |
| `MwzBarkReserveLock` | `MwzReserveLock` | Releases the 2% reserve when latched, the price is at or past the graduation price, the pool is not mid-swap, and 1 h has passed since the latch. |
| `MwzBarkLaunchLens` | `MwzLaunchLens` | Views for app and API: progress, phase, price, current fee, owed amounts. |

Reused unchanged (same bytecode, DogeOS constructor arguments): the DOGE/USD testnet oracle (foundation),
`GraduationOracle`, and the vaults gen-8 routes into (weekly `TreasuryVaultV2`, `MonthlyLeagueTreasury`,
`RecruiterRewardsVault`, `ProtocolRevenueVault`, `RewardDistributor` for holders and airdrop,
`CommunityRewardsVault`). The DogeOS deploy stack keeps those and drops the gen-7 factory, campaign and MuchFi
parts, and also gen-7's `TreasuryRouterV4` and its capped main vault: the splitter is the only depositor into the
vaults, as on gen-8.

### Money flow (LP-fee mode)

1. Each swap's fee accrues to that coin's A/B positions (one pool per coin, so fees never mix between coins);
   Barkswap's cut goes to its vault in the same swap. What we collect is net of that cut; the creator's amount is
   computed on the gross fee and the router bucket takes the remainder (B10).
2. A permissionless **collect(coin)** takes the accrued fees (never principal) from that coin's positions into
   the launcher's books for that coin, split by phase: the plugin keeps per-pool, per-phase running totals of the
   fee it charged in two phases, **bonding** (including the crossing swap's own fee) and **post-graduation**,
   each split into the creator's amount and the router remainder. Collect apportions the collected WDOGE and
   coin to those books by the plugin's totals; the uncollected rest stays in the positions.
3. **WDOGE fees** (from buys) are unwrapped and credited at collect: the creator's amount to the coin's creator,
   the remainder to the router bucket's **bonding** book (bonding phase) or to the post-graduation creator/router
   split. The router bucket's **graduation** book receives only the one-time 2% graduation fee (creator 0%).
4. **Coin fees** (from sells) stay booked in coins per coin and per phase until a permissionless
   **convert(coin)** sells them in that coin's pool at 0 fee. It always converts `min(pending, cap amount)` (the
   most the price-impact cap allows), whatever the caller, so a dust call cannot use up an interval. Each call draws coins **pro-rata across
   that coin's pending phase books** (the same fraction of every book), and the DOGE proceeds go back to those
   books in the same proportions, then are credited as in step 3. The launcher emits
   `CoinFeesConverted(coin, coinsIn, nativeOut, per-phase coins and DOGE)`.
   **Griefing bounds** (CLAUDE.md): the conversion sell is subject to F2 (it is cut short so the price never
   ends below the start price); a per-call price-impact cap and a minimum interval per coin between conversions
   (both deploy-time constants) bound the cumulative sell pressure an outside caller can force; no conversion
   runs inside the 60 s launch window. Anyone may call it; our keeper calls it on a schedule. State and
   ordering: nonReentrant; books updated before the swap's external calls settle (checks-effects-interactions);
   reachable in every phase after the launch window; a revert leaves the books unchanged.
5. From there gen-8 unchanged: router bucket → fee splitter → vaults; creator claims from the launcher.
   `routerPaid`-style totals (amount, bonding, graduation) are the launcher's **post-conversion** books, so the
   splitter's `expectedPaid` checks compare against realised DOGE, never swap-time estimates. The splitter's
   B and G are those net books (B11), so its bands hold whatever Barkswap's cut is: a route run never reverts
   `OutOfBand` because of the cut.

**Attribution for D1** (off-chain, gen-8's pipeline): a buy's accrual row is final at the swap (its WDOGE fee is
known). A sell's row is written at the swap with its coin fee and an expected value. Because every conversion
draws the same fraction of every pending coin fee of that coin, each pending sell row converts by that same
fraction at that conversion's average price: a row accrues DOGE per conversion and is routable for the part
already converted. Route runs and league-pot readers use converted (final) amounts only: a pot at epoch close
holds what was converted by the close, and an unconverted remainder counts in the epoch in which it converts
(boundary with sub-project 2, which owns the pots and follows this rule). A route run's row set is the buy rows
covered by collects up to the operator's plan plus the converted parts of sell rows, and it matches
`expectedPaid` (the Barkswap form of gen-8's "rows up to the `RouterClaimed` that reaches the splitter", audit V13).

**Per-swap event fields** (what gen-8's `HookFee` + PoolManager `Swap` give its indexer): pool and coin, swap
sender (the router; gen-8's link policy counts distinct swap senders and whitelists Barkswap's SwapRouter for
6281971), side, trader-side native and coin amounts, `curveAmount` (gen-7 volume, fee excluded; for a sell the
WDOGE payout, gen-7's "payout"), gross fee, net fee and their token, community fee at swap time, rate, phase
(bonding / post; plus a crossing flag), creator amount (in the fee token), price after the swap, and a **swap
kind**: trade, conversion (launcher), escrow buy, choice-vault buyback.

### Invariants (audit list, each with a fork test)

The gen-8 invariant list (gen-8 design 2.9) translated to Barkswap, at least:
A and B lose liquidity exactly once, `floor(liqA × 2%)` at graduation (I6), and `restore` can only re-apply our plugin and launch config; only the launcher initializes and adds liquidity; the rate
per swap matches phase and decay; no swap before `openAt` except the creator first buy; no sell below the start
price; graduation latches once and the 2% graduation fee is taken at most once and never while the price is inside A; after graduation the creator
amount is exactly 50% of the gross fee (buys: 0.50% of volume within the 1e6 fee-unit rounding; sells: 50% of
the gross coin fee, valued at its conversion price) and the bonding creator amount is exactly D2's
`creatorBondingBps` of the gross fee, whatever Barkswap's cut (B10); the launcher's collected books (per coin,
per phase, in WDOGE, coin and DOGE) equal its balances exactly, and the plugin's per-phase totals equal what
collect can still take from the positions within a stated rounding tolerance (Algebra's Q128 fee growth);
a conversion never ends below the start price, never exceeds its impact cap, respects its interval and always
converts the full capped amount; a conversion swap pays 0 fee and every other swap the phase rate; a route run
never reverts `OutOfBand` whatever the community fee (B11); the reserve releases only under its
four conditions; claims pay only the entitled party; parked-router rules (F3/F4) hold.
Plus gen-8 audit regressions F1-F17 where they apply, and Barkswap-specific cases: the community fee cut,
admin `setPlugin` / `setPluginConfig` / `setCommunityFee` on our pools (principal stays safe, books stay correct,
the change is detected), and side-pool creation.

### Audit

Per CLAUDE.md, audited before tested. `MwzBarkLauncher` and `MwzBarkPlugin` are new code (an Algebra plugin is
too different from a V4 hook for a line diff): **full audit against the invariant list**. The other five:
**diff audit** against their gen-8 counterpart. Each change states reentrancy guard, checks-effects-interactions
order, reachable states, over/underflow and griefing, as CLAUDE.md requires.

### Accepted testnet risks

- Barkswap's admin (one EOA; POOLS_ADMINISTRATOR has 20 members: the entry point plus 19 configurator contracts) can change our pools' plugin, plugin config and
  community fee. It cannot move A/B principal except through the one graduation burn, which a swapped-in plugin
  could tax; clearing our config would also let outsiders add liquidity and share LP fees. Detected and alerted (section 4, admin-change watch); mitigated for mainnet by the letter. If the dynamic-fee flag or our plugin is removed, trades fall back to `lastFee` 0: they keep working but we earn nothing until the keeper calls `restore`, which an admin can undo again.
- About 6.1M gas per launch (Barkswap deploys a 22.5 KB pool per coin): at most one launch per 10M block.
- Side pools (B3).
- Discovery: no DexScreener / GeckoTerminal indexing of DogeOS yet. Barkswap says its router and UI route custom
  pools (their message, unverified for pools with our `deployer`); our app routes through our pool directly.

### Amendments to the 2026-10-10 foundation spec

- Worker table for 6281971: the gen-7 graduation keeper is **off** (no gen-7 campaigns on DogeOS); the
  choice-vault operator worker is **on** for `buyback` (sub-project 2 turns on holder batches); the new keepers of
  section 4 are on.
- Keeper keys for 6281971 also refuse the DogeOS operator. As built (t16/t20,
  `realtime-indexer/src/evm/evmGraduationKeeper.ts`): the exported `FORBIDDEN_KEEPER_ADDRESSES` constant stays
  **without** the operator, because the creator-choice operator guard reads that constant and the operator (B9) must
  pass `assertOperatorKeyAllowed`. Keeper keys are checked with `forbiddenKeeperAddresses(env, chainId)`, which adds
  `DOGEOS_OPERATOR_ADDRESS`; a set but malformed value throws only for chain 6281971 (other chains' keepers ignore it).

### Audit scope note

The five diff-audited contracts change more than an address: the fee splitter reads the launcher instead of the
hook, the reserve lock checks the Algebra pool's unlocked flag instead of the PoolManager, and the escrow and
choice vault swap through the Barkswap pool with WDOGE instead of V4 native currency 0. Each diff audit covers
those swap paths in full.

## 4. App, API and indexer

Principle: DogeOS uses gen-8's off-chain layer (create flow, one trade panel before and after graduation, gen-8
tables, the D14 split at the graduation block, D1 fee accruals, holders, coin page). A **Barkswap venue adapter**
sits next to the V4 path. Downstream readers (leagues, battles, coin page, Ably channels) see the same rows
and events for 6281971 as for BNB and Robinhood. **The V4 path for BNB and Robinhood stays byte-for-byte**,
proven by gen-8's existing tests.

**Indexer.** Trades come from two addresses per chain: the launcher (`Launched`, claims, creator transfer,
router events, `CoinFeesConverted`) and the plugin (one event per swap, `Graduated`). The splitter, choice vault,
reserve lock and escrow are read as on gen-8 (finance, owner hand-over, holder and league exclusions). No
per-pool log scans for trades; the DogeOS 10k-block getLogs
window stays. Trader = `tx.from` (gen-8). Writes as gen-8: `curve_trades` up to and including the crossing
swap, `dex_trades` after (D14); `token_stats` / `market_stats` from the pool price; candles; D1 fee accrual
rows and `reward_events`. By swap kind: a **conversion** swap writes no trade row and no accrual row (it is fee
movement, not trading; the pool price it leaves feeds stats and candles as any price change does, its volume
counts nowhere); **escrow** buys and **choice-vault buybacks** are written as gen-8 writes them
(`league_excluded`). Config follows gen-8's env pattern (`0xaddr@startBlock`) with the DogeOS launcher
and plugin and a `barkswap` venue. Money ingestion depth (founder 2026-10-15): money rows (accruals, reward
events, route runs, holder census) read to 20 blocks below `latest` (`GEN8_MONEY_DEPTH`; the
`EVM_GEN8_MONEY_DEPTH_6281971` override is floored at 17, Chikyū's max reorg); display rows follow `latest`.

**API.** Gen-8 endpoints serve 6281971 through the adapter: campaign state (lens), progress, coin page, and
the signed create (D3) with `openAt`. The create signer also returns the CREATE2 salt that sorts the coin below
WDOGE. Gen-8 chain lists that the post-merge cleanup excluded DogeOS from (`GEN8_API_CHAIN_IDS` and the other
`evm-gen8-v4` exceptions) are re-decided one by one: 6281971 with venue `barkswap` where the path serves DogeOS,
an exception otherwise.

**App.** Gen-8's create branch calls our launcher (first-buy preview, 70% cap). Gen-8's single trade panel
executes through Barkswap's SwapRouter: buy = `exactInputSingle` with DOGE in and `deployer` = our launcher;
sell = approve the router, then `multicall(exactInputSingle, unwrapWNativeToken)`; quotes from QuoterV2 with
`deployer` (equal to execution, proven). Sells set `limitSqrtPrice` at the start price (or are capped from the
lens) so an oversized sell is cut rather than reverted by F2. Fee line and launch countdown from the lens. No trade authorization.
DOGE gas reserve and the "DogeOS" / "Barkswap" labels come from the foundation.

**Keepers** (in the indexer; permissionless steps with the DogeOS keeper key, role steps with the DogeOS
operator key): fee collect + coin conversion; route worker (`claimRouter` → splitter → vaults, operator key);
choice-vault buybacks (operator key); graduation-fee fallback; reserve
release; **side-pool watch** (Barkswap factory `Pool` and `CustomPool` events whose pair contains one of our
coins → alert, shown on the coin page); **admin-change watch** (batched reads of each of our pools'
`plugin()`, plugin config, community fee and `lastFee` every few minutes → alert on any change from the
launch values, then `restore`). The side-pool watch also covers MuchFi's V3 factory
(`0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B`), the other DEX on Chikyū.

**Database.** Gen-8's migrations exist. A staging migration lets 6281971 pass gen-8's chain constraints;
the 2026-10-10 DogeOS migration is revised to drop the MuchFi-only parts. Production SQL is handed to the
founder, never run.

**Removed (B8).** MuchFi contracts (`contracts/dogeos/muchfi/*`), their audit diff, fork specs and fixtures;
MuchFi swap decoding in the V3 pool indexer; the keeper's MuchFi slot0 path; DogeOS in gen-7 factory discovery
and the gen-7 graduation keeper; the fee-10000 DogeOS trade path; the gen-7 factory/campaign/MuchFi parts of
the DogeOS deploy stack and their env. Anything a later reader still needs stays in git history.

## 5. Testing, gates, deployment

**Contract tests** on a Chikyū fork against Barkswap's real contracts: one test per invariant (section 3),
gen-8 regressions F1-F17 where applicable, Barkswap-specific cases, and gas per step (launch under ~7M; every
transaction under the 10M block). The proof's 6.30M launch excludes on-chain curve planning, signature checks and
reserve-lock / choice-vault registration, so the 7M gate is real headroom, not slack.

**Off-chain tests.** Adapter: a recorded plugin swap event (fork fixture) produces the same rows a V4 swap
produces. Gen-8's V4 tests pass unchanged. The chain-list guard passes. Source pins change only to admit
reviewed DogeOS changes.

**Gates, in order:**
0. Gate 0 (before any contract test): the audit (section 3) with verdict PASS for each of the seven contracts.
1. Gate 1: full suites against the base (`release/evm-gen8`); no new failures.
2. Gate 2: whole-branch review by a fresh branch reviewer.
3. Gate 3: fork rehearsal of the full deploy plus lifecycle in one fork process (deploy the stack, launch, 5+
   buyer wallets in the launch window, sell, graduate, collect, convert, route, creator claim, reserve
   release, creator choice keep and buyback through the choice vault, escrow), with gas per step and the DOGE budget including each transaction's L1
   data fee (`L1GasPriceOracle 0x5300000000000000000000000000000000000002 getL1Fee`).

**Deployment, each step only after an explicit founder go:**
1. Chikyū deploy with the DogeOS deployer key (shared vaults, oracle, the seven per-chain contracts; the token is
   deployed per launch), explorer
   verification, manifest.
2. TEST wiring: env blocks for the TEST API, indexer and frontend from the env generator; staging migration;
   no Coolify change without a go per call.
3. Testnet canary: one coin graduated by 5+ buyer wallets the founder funds; the gate-3 lifecycle on the real
   chain.

Barkswap does not need to grant anything for testnet: their entry point already holds the custom-pool role
and any contract can create custom pools through it (`docs/dogeos/barkswap-facts.md` section 2).

# DogeOS Barkswap Launch (gen-8 on Algebra) Implementation Plan
**Spec:** docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md
**Profile note:** Contract tasks (t3-t6) and the audit (t7) are the hard part: implementation tier for t3-t6, review tier for t7 and t26. The removal tasks (t11-t14) are mechanical but touch byte-pin tests; implementation tier. Contract tests run only on a Chikyū fork (no Algebra npm package). t11-t14 can run in parallel with t1-t10. t29-t31 are founder-gated: the controller stops and asks before each.

File inventory for every task (paths, line ranges, REMOVE/KEEP/ADAPT calls): `docs/dogeos/barkswap-plan-inventory.md` ("Inv." below). It was read at `3dcafb4a1`; verify before editing. Facts: `docs/dogeos/barkswap-facts.md`. Proof: `scripts/research/barkswap-plugin/`.

## Global constraints

- CLAUDE.md section 1 rules bind every task. In particular: no change to BNB/Robinhood/Solana behaviour; never change the CREATE/BUY/SELL shape of existing chains (`evmGen7Wiring`/`evmGen6Wiring` tests and `tests/solana` pins untouched and green); no transaction with any real key; never read, print or commit `config/*.local` values; production SQL is handed to the founder.
- **Existing contracts are never edited.** Gen-8 contracts are vendored byte-identical from `origin/build/evm-gen8` at `e129712b9` (`contracts/gen8/` unchanged since `38ee22c18`); DogeOS contracts are new files under `contracts/dogeos/barkswap/`.
- **Two compilers, no bytecode drift.** The root `hardhat.config.ts` stays solc 0.8.24 for every existing contract and skips `contracts/gen8/**` and `contracts/dogeos/barkswap/**`; gen-8 and Bark contracts build with gen-8's settings (0.8.26, cancun, viaIR, 200 runs, `bytecodeHash none`). Adding 0.8.26 to the root compiler list is forbidden (Inv. §A).
- **Audit before test** (spec §3 Audit, §5 Gate 0): t3-t6 write contracts and their audit sections; no contract test is written before t7 records PASS for all seven contracts. A contract change after t7 updates `docs/dogeos/barkswap-audit.md` in the same commit (the changed function's reentrancy guard, CEI order, reachable states, over/underflow, griefing) and is re-reviewed.
- EIP-170: every deployed contract's runtime is ≤ 24,576 bytes; every transaction ≤ 10M gas, launch ≤ 7M (spec §5).
- Off-chain: the gen-8 V4 path for 56/97/4663/46630 stays byte-for-byte in behaviour; gen-8's existing tests (`npm --prefix realtime-indexer run test:evm-gen8` and the frontend gen-8 `node --test` files listed in Inv. §B) pass unchanged. 6281971 enters gen-8 code only through a `barkswap` venue branch.
- Every hand-kept chain list: 6281971 or a named entry in `scripts/dogeos-chain-list-exceptions.json`; `node --test scripts/dogeos-chain-list-guard.test.mjs` passes after every task. Source-pin tests change only to admit reviewed DogeOS changes (never weakened).
- New keepers/workers are off by default behind per-chain env flags; nothing points at production services.
- Commits: conventional style, scope `dogeos`, ending with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Lki7rghdxpAu59W1mRaVjS`. Never stage `package-lock.json` except in t1, nor `HybridSetup.txt`, `build-plan.md`, `chatmuchfi.md`, `DOGEOS_FULL_INTEGRATION_PLAN.md`, `barkswap.md`, `config/*.local`.
- Verify commands referenced below: root `npx hardhat test`; gen-8 `npx hardhat --config hardhat.gen8.config.ts test`; Bark fork `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test <spec>`; frontend `cd frontend && node --test <files>`; indexer `npm --prefix realtime-indexer run <script>`; frontend typecheck `cd frontend && npx tsc --noEmit -p tsconfig.app.json` (error count must not rise above the t25 baseline).

## Tasks

### Task 1: Vendor gen-8 contracts and their build            [id: t1]
**Depends-on:** none
**TDD:** waived (byte-identical vendoring and build config; the gen-8 suite is the test)
**Files:** `contracts/gen8/**` (from `e129712b9`), `test/gen8/**`, `hardhat.gen8.config.ts`, `docs/evm-launch/EVM_GEN8_V4_DESIGN.md`, `docs/evm-launch/GEN8_INTERNAL_AUDIT.md`, `hardhat.config.ts` (source filter only), `package.json` + `package-lock.json` (`@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3`, exact pins), `.gitignore`
- Spec §3 "Gen-8 sources"; Inv. §A.
- Copy with `git show e129712b9:<path>`; the copied tree must equal `e129712b9`'s.
- Root config: exclude `contracts/gen8/**` and `contracts/dogeos/barkswap/**` from compilation and `test/gen8/**` from root `hardhat test`.
- Lockfile: the working copy has the founder's uncommitted lockfile edits. Save them as a patch in the scratchpad, reset the lockfile to HEAD, install the two deps, commit, then re-apply the patch (report if it conflicts).
**Verify:** `git diff --stat e129712b9 HEAD -- contracts/gen8 test/gen8 hardhat.gen8.config.ts docs/evm-launch/EVM_GEN8_V4_DESIGN.md docs/evm-launch/GEN8_INTERNAL_AUDIT.md` → empty; `npx hardhat --config hardhat.gen8.config.ts test` → 102 passing; root `npx hardhat compile` → existing artifacts' deployed bytecode unchanged (compare `artifacts/**/*.json` deployedBytecode hashes before/after for every contract outside the excluded dirs) and root `npx hardhat test` → same pass/fail as before

### Task 2: Bark fork harness and Barkswap fact pins            [id: t2]
**Depends-on:** [t1]
**TDD:** required
**Files:** `hardhat.dogeos-bark-fork.config.ts` (gen-8 compiler + Chikyū fork, chainId 6281971, block gas 10M), `contracts/dogeos/barkswap/interfaces/**` (Algebra Integral 1.2.1 GPL interfaces only, as used by the proof), `test/dogeos/barkswap/fixtures/barkswap.ts` (addresses, impersonation, funding helpers), `test/dogeos/barkswap/BarkswapFacts.fork.spec.ts`
- Spec §1, facts §1-§2; proof `run-proof.mjs` (local-block workaround for the fork's first block).
- Facts test pins: factory/EP/router/QuoterV2/NPM/WDOGE addresses have code, `POOL_INIT_CODE_HASH` = 1.2.1's, EP holds `CUSTOM_POOL_DEPLOYER`, community fee default 30.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkswapFacts.fork.spec.ts` → all passing

### Task 3: MwzBarkPlugin and MwzBarkLauncher launch path            [id: t3]
**Depends-on:** [t2]
**TDD:** waived (audit-before-test rule: contracts and their audit sections are written first; their tests are t8-t10 after the t7 audit)
**Files:** `contracts/dogeos/barkswap/MwzBarkPlugin.sol`, `contracts/dogeos/barkswap/MwzBarkLauncher.sol`, `docs/dogeos/barkswap-audit.md` (sections for these two)
- Spec §2, §3 (launcher and plugin rows, Roles, Invariants, "Barkswap differences"), B3-B5, B9, B10.
- This task: launch (signed create D3 incl. CREATE2 salt check, `openAt`, oracle band $0.01-$10 and 3600 s age, A/B mint direct on the pool, reserve hand-off, creator first buy ≤70%), plugin hooks (init guard, LP block, rate F1 + decay + `openAt`, launcher-conversion transient flag, latch + `graduatedAt`, inline graduation fee with try/catch and the guarded fallback, F2, per-swap event with swap kind and the spec's fields, per-pool per-phase fee totals incl. creator amount on gross fee), `restore(coin)`.
- Model: gen-8 `MwzV4Launcher`/`MwzLaunchHook` (vendored in t1) and the proof's `MwzBarkLauncher`/`MwzBarkPlugin` (research only: no research switches, cancun).
- Audit section: full audit against the spec's invariant list for the functions written here (reentrancy, CEI, states, over/underflow, griefing); verdict line `Verdict: PASS` or `FAIL` per contract left for t7.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile` → success, no warnings in the two files; a size check prints both runtimes ≤ 24,576 bytes; `grep -c "^## MwzBark" docs/dogeos/barkswap-audit.md` → 2

### Task 4: Launcher money side            [id: t4]
**Depends-on:** [t3]
**TDD:** waived (audit-before-test rule; tests in t9)
**Files:** `contracts/dogeos/barkswap/MwzBarkLauncher.sol`, `contracts/dogeos/barkswap/MwzBarkPlugin.sol` (only if the books need a plugin view), `docs/dogeos/barkswap-audit.md`
- Spec §3 "Money flow" 1-5, "Attribution for D1" (on-chain part), B10, B11; gen-8 F3/F4/F5 (`routerPaid`, parked router, `claimRouter` gate).
- `collect(coin)` (fees only, apportioned by the plugin's per-phase totals), creator owed per coin, router bucket bonding and graduation books (net, B11), `convert(coin)` (full capped amount, pro-rata over phase books, interval, launch-window and F2 bounds, `CoinFeesConverted`), `claimCreator`, two-step creator transfer, `claimRouter`/parked router, `routerPaid(router)` view.
- Deploy-time constants (impact cap, interval) chosen here with a one-paragraph rationale in the audit doc.
**Verify:** Bark compile → success; size ≤ 24,576 bytes (if not, split into a library in this task); `grep -n "convert\|collect\|claimRouter" docs/dogeos/barkswap-audit.md` shows each function's audit entry

### Task 5: Fee splitter, reserve lock and lens variants            [id: t5]
**Depends-on:** [t4]
**TDD:** waived (audit-before-test rule; tests in t10)
**Files:** `contracts/dogeos/barkswap/MwzBarkFeeSplitter.sol`, `MwzBarkReserveLock.sol`, `MwzBarkLaunchLens.sol`, `docs/dogeos/barkswap-audit.md`
- Spec §3 rows and "Audit scope note"; gen-8 counterparts vendored in t1.
- Minimal diffs: splitter reads `launcher.routerPaid` (net books, B11); reserve lock checks the Algebra pool's unlocked flag and the launcher's latch/price/`graduatedAt` (1 h); lens reads the Algebra pool and launcher/plugin.
- Audit: a diff audit per contract against its gen-8 file (`git diff --no-index`), each hunk explained.
**Verify:** Bark compile → success; `grep -c "^## MwzBark" docs/dogeos/barkswap-audit.md` → 5

### Task 6: Creator choice vault and escrow variants            [id: t6]
**Depends-on:** [t4]
**TDD:** waived (audit-before-test rule; tests in t10)
**Files:** `contracts/dogeos/barkswap/MwzBarkCreatorChoiceVault.sol`, `MwzBarkCreatorEscrow.sol`, `docs/dogeos/barkswap-audit.md`
- Spec §3 rows and "Audit scope note". Swap paths through our Barkswap pool with WDOGE and `deployer` = launcher; gen-8 caps kept.
**Verify:** Bark compile → success; `grep -c "^## MwzBark" docs/dogeos/barkswap-audit.md` → 7 (once t5 has landed)

### Task 7: Audit gate 0            [id: t7]
**Depends-on:** [t3, t4, t5, t6]
**TDD:** waived (audit document)
**Files:** `docs/dogeos/barkswap-audit.md`
- Spec §3 Audit, §5 Gate 0. Review-tier. Full audit of launcher and plugin against every spec invariant; diff audit of the five variants; gen-8 F1-F17 mapping (applies / not applicable, why); Barkswap admin powers (facts §5). Any finding is fixed in the contract in this task and re-audited.
**Verify:** `grep -cE "^Verdict: PASS" docs/dogeos/barkswap-audit.md` → 7; `grep -cE "^Verdict: FAIL" docs/dogeos/barkswap-audit.md` → 0

### Task 8: Fork tests: launch and plugin invariants            [id: t8]
**Depends-on:** [t7]
**TDD:** required
**Files:** `test/dogeos/barkswap/BarkLaunch.fork.spec.ts`, `test/dogeos/barkswap/BarkPlugin.fork.spec.ts`, `test/fixtures/dogeos/barkSwapEvent.json` (recorded plugin swap events for t18)
- Spec §3 Invariants (launch, init/LP guards, rate/decay/`openAt`, conversion 0 fee vs creator first buy 2%, latch, graduation burn I6 at most once and never inside A, F2, restore incl. `setFee(0)`, swap-event fields and kinds), §5 gas (launch ≤ 7M).
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkLaunch.fork.spec.ts test/dogeos/barkswap/BarkPlugin.fork.spec.ts` → all passing; the gas table printed by the spec shows launch ≤ 7,000,000

### Task 9: Fork tests: money flow, attribution and Barkswap admin cases            [id: t9]
**Depends-on:** [t7]
**TDD:** required
**Files:** `test/dogeos/barkswap/BarkMoney.fork.spec.ts`, `test/dogeos/barkswap/BarkAdmin.fork.spec.ts`
- Spec §3 Money flow, Attribution, Invariants (books = balances, creator amounts B10 on gross, B11 net splitter base, never `OutOfBand` at any community fee incl. an impersonated admin raise, conversion cap/interval/dust/F2/launch window), admin `setPlugin`/`setPluginConfig`/`setCommunityFee`/`setFee` (principal safe, books correct, `restore`), side-pool creation.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkMoney.fork.spec.ts test/dogeos/barkswap/BarkAdmin.fork.spec.ts` → all passing

### Task 10: Fork tests: splitter, choice vault, escrow, reserve lock, lens, gen-8 regressions            [id: t10]
**Depends-on:** [t7]
**TDD:** required
**Files:** `test/dogeos/barkswap/BarkPeriphery.fork.spec.ts`, `test/dogeos/barkswap/BarkGen8Regressions.fork.spec.ts`
- Spec §3 rows and Invariants (reserve four conditions, claims to entitled party, F3/F4 parked router, buyback caps, escrow); gen-8 F1-F17 regressions marked "applies" in t7. Splitter routes into real vault bytecode deployed on the fork.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkPeriphery.fork.spec.ts test/dogeos/barkswap/BarkGen8Regressions.fork.spec.ts` → all passing

### Task 11: Remove MuchFi contracts and gen-7 DogeOS fork code            [id: t11]
**Depends-on:** none
**TDD:** waived (deletion; the root suite and compile are the check)
**Files:** per Inv. §C "contracts and tests": `contracts/dogeos/muchfi/*`, `contracts/test/Muchfi*`, `docs/dogeos/muchfi-variants-audit-diff.md`, `test/Muchfi*.fork.spec.ts` + helper + `test/fixtures/muchfi*`, `test/DogeosGen7*.fork.spec.ts`, `scripts/lib/dogeosV3Stack.ts` + its spec
- Spec §4 "Removed (B8)". `scripts/lib/dogeosGen7Stack.ts` and the deploy scripts are handled in t15 (their reusable parts move first).
**Verify:** `git ls-files contracts/dogeos/muchfi test | grep -ci muchfi` → 0; root `npx hardhat compile` → success; root `npx hardhat test` → no new failures vs before the task

### Task 12: Remove the gen-7/MuchFi DogeOS trade path from the app            [id: t12]
**Depends-on:** none
**TDD:** required (pin and launch-path tests change in the same commit)
**Files:** per Inv. §C "frontend": `frontend/src/lib/robinhoodV3Trade.ts` (back to `3a10c6bf`), `robinhoodAdapter`/`robinhoodNativeSwapAdapterEnv` DogeOS branches, `TokenDetails.tsx` `isV3GraduatedTradePage` hunks, related tests (`graduatedEvmTradeRoute.test.mjs` `DOGEOS_REVIEWED`, `dogeosLaunchPath.test.mjs`, `robinhoodNativeSwapAdapterEnv` tests), chain-list exceptions
- Spec §4 "Removed (B8)". Keep the DOGE gas reserve and the foundation's identity/presentation.
**Verify:** `cd frontend && node --test src/lib/graduatedEvmTradeRoute.test.mjs src/lib/dogeosLaunchPath.test.mjs src/lib/evmGen7Wiring.test.mjs src/lib/evmGen6Wiring.test.mjs` → no failures beyond the CRLF-only ones recorded in MINORS; `git diff 3a10c6bf -- frontend/src/lib/robinhoodV3Trade.ts` → empty; chain-list guard → pass

### Task 13: Remove the gen-7/MuchFi DogeOS paths from the indexer            [id: t13]
**Depends-on:** none
**TDD:** required
**Files:** per Inv. §C "indexer": `robinhoodV3PoolIndexer.ts` MuchFi decode, `evm/evmGraduationKeeper*.ts` MuchFi slot0 + 6281971 config, `factoryDiscovery.ts`/`env.ts` gen-7 DogeOS entries, `robinhoodCmsHeal.ts` DogeOS windowing, `evmIndexerChains.ts` `graduatedMarketFor` DogeOS branch, their tests (`dogeosV3PoolIndexer`, `dogeosKeeperSlot0`, …), chain-list exceptions
- Spec §4 "Removed (B8)", foundation amendments (gen-7 keeper off for 6281971). Keep `dogeosNativeUsdOracle.ts`, the oracle push worker, chain identity and `FORBIDDEN_KEEPER_ADDRESSES`.
**Verify:** `npm --prefix realtime-indexer run build` → rc 0; `npm --prefix realtime-indexer run test:evm-gen5` and `test:evm-gen8` → all pass; the remaining DogeOS indexer tests (`git grep -l -i dogeos -- realtime-indexer/src/tests`) → all pass; chain-list guard → pass

### Task 14: Remove the gen-7 DogeOS paths from the API            [id: t14]
**Depends-on:** none
**TDD:** required
**Files:** per Inv. §C "API": `route-auth.js` / `routeAuthorizationSigner.js` 6281971 generation pair `[7,6]` and gen-7 test-target gates, `bnbContracts.ts` gen-7 DogeOS readiness (t37), related tests (`dogeosRouteAuth`, `dogeosApiIdentity` parts), chain-list exceptions
- Spec §4 "Removed (B8)". The `20261010` migration keeps its $150 constraint (Inv. §C).
**Verify:** `cd frontend && node --test api/dev-fix/dogeosRouteAuth.test.mjs api/dogeosApiIdentity.test.mjs api/dev-fix/route-authorization-gen7.test.mjs` (or their successors) → pass; chain-list guard → pass

### Task 15: DogeOS Bark deploy stack            [id: t15]
**Depends-on:** [t5, t6, t11]
**TDD:** required
**Files:** `scripts/lib/dogeosBarkStack.ts` (new; lifts oracle, `GraduationOracle`, vault deploys and the manifest writer from `dogeosGen7Stack.ts`, which is then deleted), `scripts/deploy-dogeos-testnet.ts`, `scripts/verify-dogeos-testnet.ts`, `scripts/activate-dogeos-testnet.ts`, `scripts/lib/dogeosTestnetDeployGuards.mjs` (+ test), `test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts`
- Spec §3 (contracts, "Reused unchanged", Roles B9: operator address as an input, never derived from a key file), §5 Deployment 1; Inv. §C/§D for what is lifted.
- No `TreasuryRouterV4` or capped main vault; wire `CommunityRewardsVault` the way gen-8 does (check gen-8's deploy planner in `e129712b9:scripts/gen8/deploy/`). Guards: Barkswap addresses and code-hash pins replace MuchFi's; operator ≠ deployer/keeper/updater/route authority.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts` → passing (deploy + activate in one fork, read-backs of every role and address); `node --test scripts/lib/dogeosTestnetDeployGuards.test.mjs` → pass; `git ls-files scripts/lib/dogeosGen7Stack.ts` → empty

### Task 16: Env generator and keeper guards for the Bark stack            [id: t16]
**Depends-on:** [t15]
**TDD:** required
**Files:** `scripts/dogeos-env-blocks.mjs` (+ test), `realtime-indexer/src/evm/*` `FORBIDDEN_KEEPER_ADDRESSES` for 6281971 (+ operator), `scripts/dogeos-chain-list-exceptions.json`
- Spec §4 Indexer config pattern, Keepers; B9. Placeholders only, never key values.
**Verify:** `node --test scripts/dogeos-env-blocks.test.mjs` → pass; chain-list guard → pass

### Task 17: Gen-8 venue seam and DogeOS config            [id: t17]
**Depends-on:** [t12, t13, t14]
**TDD:** required
**Files:** `frontend/api/lib/evmGen8Config.js`, `realtime-indexer/src/evm/evmGen8Config.ts`, `frontend/shared/evmGen8.mjs`, `frontend/src/lib/dogeosPresentation.mjs` (`DOGEOS_DEX_LABEL` → "Barkswap"), their tests, `scripts/dogeos-chain-list-exceptions.json` (re-decide the 10 `evm-gen8-v4` entries, Inv. §B)
- Spec §4 Principle, API (chain lists re-decided), B7. Add the `venue` (`v4` | `barkswap`) to gen-8 config; 6281971 = `barkswap`; V4 chains unchanged.
**Verify:** `npm --prefix realtime-indexer run test:evm-gen8` → all pass (unchanged); the gen-8 frontend tests in Inv. §B → same results as before; the new venue tests → pass; chain-list guard → pass

### Task 18: Indexer Barkswap ingestion            [id: t18]
**Depends-on:** [t8, t17]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGen8Bark.ts` (new: launcher + plugin log decode and ingestion), `evmGen8Abi.ts` (Bark ABIs added, V4 untouched), wiring in `evmGen8Pool.ts`/`server.ts` by venue, `realtime-indexer/src/tests/evmGen8Bark.test.ts`
- Spec §4 Indexer (two addresses, windowed getLogs, trader `tx.from`, D14 split, stats from pool price, swap kinds: conversion writes no trade/accrual row, escrow/buyback `league_excluded`); fixture from t8.
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/evmGen8Bark.test.ts` → pass (a recorded Bark swap produces the same row shape as a recorded V4 swap); `npm --prefix realtime-indexer run test:evm-gen8` → all pass

### Task 19: Fee accrual, sell attribution and route-run rows            [id: t19]
**Depends-on:** [t18, t9]
**TDD:** required
**Files:** the gen-8 D1 accrual and route-run modules (Inv. §B), `realtime-indexer/src/evm/evmGen8Bark*.ts`, tests
- Spec §3 "Attribution for D1" (buy rows final at swap; sell rows converted by `CoinFeesConverted` fraction at its average price; route row set matches `expectedPaid`), B11 net base, epoch rule (unconverted remainder counts in the converting epoch).
**Verify:** the new attribution tests → pass (a scripted sequence of swaps, collects, partial conversions and a route plan reconciles to the wei with the fork-recorded `routerPaid`); `test:evm-gen8` → all pass

### Task 20: DogeOS keepers            [id: t20]
**Depends-on:** [t18, t16]
**TDD:** required
**Files:** `realtime-indexer/src/evm/dogeosBarkKeepers.ts` (new) + config, wiring in the indexer worker loop (off by default), tests
- Spec §4 Keepers: collect + convert, route worker (operator key), choice-vault buyback (operator key), graduation-fee fallback, reserve release, side-pool watch (Barkswap `Pool`/`CustomPool` + MuchFi factory), admin-change watch + `restore`. Keeper vs operator key per B9.
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosBarkKeepers.test.ts` → pass (each keeper picks the right key, respects its flag, never calls a role function with the keeper key)

### Task 21: API: campaign state and signed create for Barkswap            [id: t21]
**Depends-on:** [t17, t5]
**TDD:** required
**Files:** `frontend/api/lib/evmGen8CampaignState.js` (venue branch), `frontend/api/lib/evmGen8CreateAuthorization.js` (+ CREATE2 salt search so the coin sorts below WDOGE), `evmCampaignProgress.js`, tests
- Spec §4 API, §3 launcher (salt, `openAt`). V4 branch unchanged.
**Verify:** the gen-8 API tests (Inv. §B) → unchanged results; new Bark tests → pass (salt always sorts below WDOGE; signed payload matches the launcher's check, using the t3 contract ABI)

### Task 22: App: create and trade on Barkswap            [id: t22]
**Depends-on:** [t21]
**TDD:** required
**Files:** `frontend/src/lib/evmGen8Client.mjs` (venue branch), new `frontend/src/lib/barkswapSwap.mjs` (SwapRouter `exactInputSingle` with `deployer`, sell `multicall` + unwrap, `limitSqrtPrice` at the start price, QuoterV2), the gen-8 create branch and trade panel wiring, Create readiness for 6281971 under gen-8, tests
- Spec §4 App. No trade authorization; DOGE gas reserve kept.
**Verify:** `cd frontend && node --test src/lib/barkswapSwap.test.mjs` plus the gen-8 client tests → pass; `npx tsc --noEmit -p tsconfig.app.json` → error count not above baseline

### Task 23: Staging migration for Barkswap rows            [id: t23]
**Depends-on:** [t19]
**TDD:** required
**Files:** `db/migrations/20261015_000010_dogeos_barkswap.sql` (side-pool venue value, event kinds, `market_trades_v` label, conversion bookkeeping if t19 needs a table/column), `database/staging_apply_dogeos_barkswap.sh`, the db-migration test
- Spec §4 Database. Not run anywhere in this task.
**Verify:** the repo's db-migration test (Inv. §E) → pass; `grep -c "6281971\|barkswap" db/migrations/20261015_000010_dogeos_barkswap.sql` → ≥ 1

### Task 24: Program docs            [id: t24]
**Depends-on:** [t15, t20, t22]
**TDD:** waived (documentation)
**Files:** `docs/claude/dogeos.md`, `docs/dogeos/barkswap-runbook.md` (deploy, wiring, canary steps; keys by role, never values)
**Verify:** `grep -c "barkswap-runbook" docs/claude/dogeos.md` → ≥ 1

### Task 25: Gate 1: full suites against release/evm-gen8            [id: t25]
**Depends-on:** [t8, t9, t10, t15, t16, t18, t19, t20, t21, t22, t23, t24]
**TDD:** waived (verification run)
**Files:** report only (scratchpad)
- Spec §5 Gate 1. Fresh baseline from `origin/release/evm-gen8` (the t26 report of 2026-10-10 predates the merge). Root hardhat, gen-8 suite, Bark fork suites, frontend, scripts, indexer, typecheck. New failures are fixed by a dispatched fix before the gate passes.
**Verify:** report states "NEW FAILURES: 0"

### Task 26: Gate 2: whole-branch review            [id: t26]
**Depends-on:** [t25]
**TDD:** waived (review)
**Files:** none (review report; MINORS triage)
- Spec §5 Gate 2. A fresh `templar-powers:branch-reviewer` over `3dcafb4a1..HEAD` with the spec, this plan and `MINORS-dogeos.md`.
**Verify:** verdict "Approved" (or "With fixes" with every fix landed and re-reviewed)

### Task 27: Gate 3: fork rehearsal and DOGE budget            [id: t27]
**Depends-on:** [t26]
**TDD:** required
**Files:** `scripts/rehearse-dogeos-bark-fork.ts`, `reports/dogeos/bark-fork-rehearsal.json`
- Spec §5 Gate 3: one fork process runs the t15 deploy + activate, launch, 5+ buyer wallets in the launch window, sell, graduate, collect, convert, route (operator), creator claim, reserve release, keep + buyback, escrow; gas per step; DOGE budget with `getL1Fee` per tx from the live `L1GasPriceOracle`.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts run scripts/rehearse-dogeos-bark-fork.ts` → exit 0 and the report lists every step with gas ≤ 10M and a total DOGE budget

### Task 28: Review the rehearsal            [id: t28]
**Depends-on:** [t27]
**TDD:** waived (review)
**Files:** none
- A fresh task reviewer reviews t27's script and report (they come after the t26 branch review).
**Verify:** reviewer verdict "Approved"

### Task 29: FOUNDER-GATED — deploy to Chikyū            [id: t29]
**Depends-on:** [t28]
**TDD:** waived (on-chain deploy)
**Files:** `deployments/dogeos/testnet.bark.json` (manifest)
- Spec §5 Deployment 1. **Stop and ask the founder for an explicit go first.** The founder generates the operator key and provides its address; deployer funded. Deploy, verify on the explorer, activate.
**Verify:** `node scripts/verify-dogeos-testnet.ts` read-backs all pass against the manifest

### Task 30: FOUNDER-GATED — TEST wiring            [id: t30]
**Depends-on:** [t29]
**TDD:** waived (environment configuration)
**Files:** none in the repo (env blocks printed by the generator; staging migration)
- Spec §5 Deployment 2. **Stop and ask the founder for an explicit go first**, and again per Coolify call. Staging SQL with a go; never production.
**Verify:** TEST API `/health` and the indexer health show 6281971 with the Bark launcher/plugin configured

### Task 31: FOUNDER-GATED — testnet canary            [id: t31]
**Depends-on:** [t30]
**TDD:** waived (live testnet run)
**Files:** `reports/dogeos/bark-canary.json`
- Spec §5 Deployment 3. **Stop and ask the founder for an explicit go first.** One coin graduated by 5+ buyer wallets the founder funds; the gate-3 lifecycle on Chikyū; the TEST app shows it.
**Verify:** the report lists every step with its tx hash and the coin page on the TEST frontend shows the graduated coin trading on Barkswap

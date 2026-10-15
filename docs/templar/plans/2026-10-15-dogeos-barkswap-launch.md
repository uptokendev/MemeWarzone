# DogeOS Barkswap Launch (gen-8 on Algebra) Implementation Plan
**Spec:** docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md
**Profile note:** Contract tasks (t3, t32, t4-t6) and the audit (t7) are the hard part: implementation tier for t3/t32/t4-t6, review tier for t7, t26 and t28. The removal chain (t11, t12 → t13 → t14) is mechanical but touches byte-pin tests; implementation tier. Contract tests run only on a Chikyū fork (no Algebra npm package). The removal chain runs in parallel with t1-t10. t29-t31 are founder-gated: the controller stops and asks before each.

File inventory for every task (paths, line ranges, REMOVE/KEEP/ADAPT calls): `docs/dogeos/barkswap-plan-inventory.md` ("Inv." below). It was read at `3dcafb4a1`; verify before editing. Facts: `docs/dogeos/barkswap-facts.md`. Proof: `scripts/research/barkswap-plugin/`. Accumulated review minors: `C:/Users/sven/Projects/MemeWarzone/.git/templar/MINORS-dogeos.md` (outside the working tree).

## Global constraints

- CLAUDE.md section 1 rules bind every task. In particular: no change to BNB/Robinhood/Solana behaviour; never change the CREATE/BUY/SELL shape of existing chains (`evmGen7Wiring`/`evmGen6Wiring` tests and `tests/solana` pins untouched and green); no transaction with any real key; never read, print or commit `config/*.local` values; production SQL is handed to the founder.
- **Existing contracts are never edited.** Gen-8 contracts are vendored byte-identical from `origin/build/evm-gen8` at `e129712b9` (`contracts/gen8/` unchanged since `38ee22c18`); DogeOS contracts are new files under `contracts/dogeos/barkswap/`.
- **Two compilers, no bytecode drift.** The root `hardhat.config.ts` stays solc 0.8.24 for every existing contract and skips `contracts/gen8/**` and `contracts/dogeos/barkswap/**` (sources) and `test/gen8/**`, `test/dogeos/barkswap/**` (tests). Gen-8 and Bark contracts build with gen-8's settings (0.8.26, cancun, viaIR, 200 runs, `bytecodeHash none`) into their own artifact directories. Adding 0.8.26 to the root compiler list is forbidden (Inv. §A).
- **Audit before test** (spec §3 Audit, §5 Gate 0): t3, t32 and t4-t6 write contracts and their audit sections; no task deploys, calls or tests a Bark contract before t7 records PASS for all seven. A contract change after t7 updates `docs/dogeos/barkswap-audit.md` in the same commit (the changed function's reentrancy guard, CEI order, reachable states, over/underflow, griefing) and is re-reviewed.
- EIP-170: every Bark contract's runtime ≤ 24,576 bytes (`node scripts/dogeos-bark-sizes.mjs`, added in t3, exits non-zero otherwise); every transaction ≤ 10M gas, launch ≤ 7M (spec §5).
- Off-chain: the gen-8 V4 path for 56/97/4663/46630 keeps its behaviour; gen-8's existing tests (`npm --prefix realtime-indexer run test:evm-gen8` and the frontend gen-8 `node --test` files in Inv. §B) pass unchanged. 6281971 enters gen-8 code only through a `barkswap` venue branch.
- **Row identity:** Bark rows keep `execution_source = 'gen8_v4'`, `venue = 'gen8'` and `factory_generation = 8`; the Barkswap venue lives only in gen-8 config and `evm_gen8_pools`. So every existing gen-8 reader (`useUnifiedMarket.ts`, `chart/gen8TokenPage.ts`, `marketContinuityApi.ts`, `tokenTradeList.ts`, `evmGen8SidePools.ts`) serves DogeOS unchanged, and no new `market_trades_v` label is added.
- Every hand-kept chain list: 6281971 or a named entry in `scripts/dogeos-chain-list-exceptions.json`; `node --test scripts/dogeos-chain-list-guard.test.mjs` passes after every task. Source-pin tests change only to admit reviewed DogeOS changes (never weakened).
- The DogeOS operator's public address is unknown until t29: code and guards take it from `DOGEOS_OPERATOR_ADDRESS` (env or deploy input), never hard-coded.
- New keepers/workers are off by default behind per-chain env flags; nothing points at production services.
- Commits: conventional style, scope `dogeos`, ending with the attribution lines given in the session's system reminder (today: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Lki7rghdxpAu59W1mRaVjS`). Never stage `package-lock.json` except in t1, nor `HybridSetup.txt`, `build-plan.md`, `chatmuchfi.md`, `DOGEOS_FULL_INTEGRATION_PLAN.md`, `barkswap.md`, `config/*.local`.
- Command forms: root `npx hardhat test`; gen-8 `npx hardhat --config hardhat.gen8.config.ts test`; Bark fork `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test <spec>`; frontend `cd frontend && node --test <files>`; indexer `cd realtime-indexer && npx tsx --test src/tests/<file>` or `npm --prefix realtime-indexer run <script>`; frontend typecheck `cd frontend && npx tsc --noEmit -p tsconfig.app.json` (error count must not rise above the t25 baseline).
- Known pre-existing frontend failures (Inv. §E, MINORS): `graduatedEvmTradeRoute.test.mjs` tests "every graduated EVM trade surface…" and "the BNB import API…" (CRLF only); `solanaCurrentAuthority.test.mjs` "admin finance removes 102…" and "graduation test tier…"; `mobileTradePresentation` "DBC launch…"; `robinhoodBondingWalletSwitchPresentation` "Robinhood TokenDetails keeps…". A Verify "no new failures" means none beyond these.

## Tasks

### Task 1: Vendor gen-8 contracts and their build            [id: t1]
**Depends-on:** none
**TDD:** waived (byte-identical vendoring and build config; the gen-8 suite is the test)
**Files:** `contracts/gen8/**` (from `e129712b9`), `test/gen8/**`, `hardhat.gen8.config.ts`, `docs/evm-launch/EVM_GEN8_V4_DESIGN.md`, `docs/evm-launch/GEN8_INTERNAL_AUDIT.md`, `hardhat.config.ts` (source and test filters only), `package.json` + `package-lock.json` (`@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3`, exact pins), `.gitignore`
- Spec §3 "Gen-8 sources"; Inv. §A.
- Copy with `git show e129712b9:<path>`; the copied tree must equal `e129712b9`'s.
- Root config: skip `contracts/gen8/**`, `contracts/dogeos/barkswap/**` in compilation and `test/gen8/**`, `test/dogeos/barkswap/**` in root `hardhat test`.
- Lockfile: the working copy has the founder's uncommitted lockfile edits. Save them as a patch in the scratchpad, reset the lockfile to HEAD, install the two deps, commit, then re-apply the patch (report if it conflicts).
**Verify:** `git diff --stat e129712b9 HEAD -- contracts/gen8 test/gen8 hardhat.gen8.config.ts docs/evm-launch/EVM_GEN8_V4_DESIGN.md docs/evm-launch/GEN8_INTERNAL_AUDIT.md` → empty; `npx hardhat --config hardhat.gen8.config.ts test` → 102 passing; root `npx hardhat compile`, then a hash of every `artifacts/**/*.json` `deployedBytecode` outside the skipped dirs → identical to the hashes taken before the task; root `npx hardhat test` → same pass/fail as before

### Task 2: Bark fork harness and Barkswap fact pins            [id: t2]
**Depends-on:** [t1]
**TDD:** required
**Files:** `hardhat.dogeos-bark-fork.config.ts`, `.gitignore` (`artifacts-bark`, `cache-bark`), `contracts/dogeos/barkswap/interfaces/**` (Algebra Integral 1.2.1 GPL interfaces only, as used by the proof), `test/dogeos/barkswap/fixtures/barkswap.ts` (addresses, impersonation, funding), `test/dogeos/barkswap/BarkswapFacts.fork.spec.ts`
- Spec §1, facts §1-§2; proof `run-proof.mjs` (local-block workaround for the fork's first block).
- Config: gen-8 compiler settings; compiles `contracts/gen8/**` and `contracts/dogeos/barkswap/**` (source-paths override, own `artifacts-bark` / `cache-bark`, gitignored); Chikyū fork, chainId 6281971, block gas 10M, fork block pinned by `DOGEOS_FORK_BLOCK` (default: the proof's 8,578,734).
- Facts test pins: factory/EP/router/QuoterV2/NPM/WDOGE have code, `POOL_INIT_CODE_HASH` = 1.2.1's, EP holds `CUSTOM_POOL_DEPLOYER`, default community fee 30.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkswapFacts.fork.spec.ts` → all passing; `MwzV4Token` `deployedBytecode` in `artifacts-bark` equals the one in the gen-8 build (a one-line node comparison printed in the task report)

### Task 3: MwzBarkPlugin            [id: t3]
**Depends-on:** [t2]
**TDD:** waived (audit-before-test rule: contract and audit section first; tests in t8-t10 after t7)
**Files:** `contracts/dogeos/barkswap/MwzBarkPlugin.sol`, `contracts/dogeos/barkswap/interfaces/IMwzBarkLauncher.sol` (the launcher surface the plugin calls), `scripts/dogeos-bark-sizes.mjs`, `docs/dogeos/barkswap-audit.md` (plugin section)
- Spec §2, §3 (plugin row, Invariants, "Barkswap differences", per-swap event fields), B4, B10.
- Hooks: init guard, LP block, rate F1 + decay + `openAt` as `overrideFee`, the launcher-conversion transient flag (0 fee) vs the creator first buy (2%), latch + `graduatedAt`, inline graduation fee via the launcher interface (try/catch), F2, per-pool per-phase fee totals with creator amount on the gross fee and the community fee read at swap time, one event per swap with swap kind.
- Model: gen-8 `MwzLaunchHook` (vendored) and the proof's `MwzBarkPlugin` (research only; no research switches).
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile` → success; `node scripts/dogeos-bark-sizes.mjs` → exit 0 and lists `MwzBarkPlugin` ≤ 24,576; `grep -c "^## MwzBarkPlugin" docs/dogeos/barkswap-audit.md` → 1

### Task 32: MwzBarkLauncher launch path and restore            [id: t32]
**Depends-on:** [t3]
**TDD:** waived (audit-before-test rule; tests in t8)
**Files:** `contracts/dogeos/barkswap/MwzBarkLauncher.sol`, `docs/dogeos/barkswap-audit.md` (launcher section, launch part)
- Spec §3 (launcher row, Roles), B9.
- Launch: signed create D3 incl. the CREATE2 salt check (coin below WDOGE), `openAt`, oracle band $0.01-$10 and 3600 s age, `createCustomPool` + initialize + tick spacing 10 + `setFee(0)` before the dynamic-fee flag, A/B mint directly on the pool, reserve hand-off, creator first buy ≤ 70%; `restore(coin)` incl. `setFee(0)`; the graduation-fee entry the plugin calls plus its guarded permissionless fallback (I6 at most once, never inside A).
**Verify:** Bark compile → success; `node scripts/dogeos-bark-sizes.mjs` → exit 0; `grep -c "^## MwzBarkLauncher" docs/dogeos/barkswap-audit.md` → 1

### Task 4: Launcher money side            [id: t4]
**Depends-on:** [t32]
**TDD:** waived (audit-before-test rule; tests in t9)
**Files:** `contracts/dogeos/barkswap/MwzBarkLauncher.sol` (and a library under `contracts/dogeos/barkswap/libraries/` if needed for size), `MwzBarkPlugin.sol` (only for a books view), `docs/dogeos/barkswap-audit.md`
- Spec §3 "Money flow" 1-5, "Attribution for D1" (on-chain part), B10, B11; gen-8 F3/F4/F5.
- `collect(coin)` (fees only, apportioned by the plugin's per-phase totals), creator owed per coin, router bonding/graduation books (net, B11), `convert(coin)` (full capped amount, pro-rata over phase books, interval, launch-window and F2 bounds, `CoinFeesConverted`), `claimCreator`, two-step creator transfer, `claimRouter`/parked router, `routerPaid(router)`.
- Deploy-time constants (impact cap, interval) chosen here, with a one-paragraph rationale in the audit doc.
**Verify:** Bark compile → success; `node scripts/dogeos-bark-sizes.mjs` → exit 0; `grep -cE "^### (collect|convert|claimCreator|claimRouter)" docs/dogeos/barkswap-audit.md` → 4

### Task 5: Fee splitter, reserve lock and lens variants            [id: t5]
**Depends-on:** [t4]
**TDD:** waived (audit-before-test rule; tests in t10)
**Files:** `contracts/dogeos/barkswap/MwzBarkFeeSplitter.sol`, `MwzBarkReserveLock.sol`, `MwzBarkLaunchLens.sol`, `docs/dogeos/barkswap-audit.md`
- Spec §3 rows and "Audit scope note"; gen-8 counterparts vendored in t1. Minimal diffs: splitter reads `launcher.routerPaid` (net books, B11); reserve lock checks the Algebra pool's unlocked flag and the launcher's latch/price/`graduatedAt` (1 h); lens reads the Algebra pool and launcher/plugin.
- Audit: one diff audit per contract against its gen-8 file (`git diff --no-index`), each hunk explained.
**Verify:** Bark compile → success; `node scripts/dogeos-bark-sizes.mjs` → exit 0; `grep -c "^## MwzBark" docs/dogeos/barkswap-audit.md` → 5

### Task 6: Creator choice vault and escrow variants            [id: t6]
**Depends-on:** [t4, t5]
**TDD:** waived (audit-before-test rule; tests in t10)
**Files:** `contracts/dogeos/barkswap/MwzBarkCreatorChoiceVault.sol`, `MwzBarkCreatorEscrow.sol`, `docs/dogeos/barkswap-audit.md`
- Spec §3 rows and "Audit scope note". Swaps through our Barkswap pool with WDOGE and `deployer` = launcher; gen-8 caps kept.
**Verify:** Bark compile → success; `node scripts/dogeos-bark-sizes.mjs` → exit 0; `grep -c "^## MwzBark" docs/dogeos/barkswap-audit.md` → 7

### Task 7: Audit gate 0 and ABI export            [id: t7]
**Depends-on:** [t3, t32, t4, t5, t6]
**TDD:** waived (audit document and generated ABIs)
**Files:** `docs/dogeos/barkswap-audit.md`, `scripts/dogeos-bark-export-abis.mjs`, `contracts/dogeos/barkswap/abi/*.abi.json` (the seven contracts plus Algebra SwapRouter and QuoterV2)
- Spec §3 Audit, §5 Gate 0. Review tier. Full audit of launcher and plugin against every spec invariant; diff audit of the five variants; gen-8 F1-F17 mapping (applies / not applicable, why); Barkswap admin powers (facts §5). Findings are fixed in the contract in this task and re-audited.
- After PASS: export ABIs (pattern `e129712b9:scripts/gen8/export-abis.mjs`); t15, t18, t21 and t22 consume only these files. The Algebra SwapRouter and QuoterV2 ABIs are not built here: take them from the proof (`scripts/research/barkswap-plugin/run-proof.mjs`) cross-checked against the upstream v1.2.1 interfaces, and exclude them from `--check`.
**Verify:** `grep -cE "^Verdict: PASS" docs/dogeos/barkswap-audit.md` → 7; `grep -cE "^Verdict: FAIL" docs/dogeos/barkswap-audit.md` → 0; `node scripts/dogeos-bark-export-abis.mjs --check` → exit 0 (the seven exported Bark ABIs match the build)

### Task 8: Fork tests: launch and plugin invariants            [id: t8]
**Depends-on:** [t7]
**TDD:** required
**Files:** `test/dogeos/barkswap/fixtures/barkswap.ts` (full-stack deploy helpers; this task owns the fixture), `test/dogeos/barkswap/BarkLaunch.fork.spec.ts`, `test/dogeos/barkswap/BarkPlugin.fork.spec.ts`, `test/fixtures/dogeos/barkSwapEvent.json` (recorded plugin and launcher events for t18, plus one signed create request: struct fields, salt, signature and signer, for t21)
- Spec §3 Invariants (launch, init/LP guards, rate/decay/`openAt`, conversion 0 fee vs creator first buy 2%, latch, I6 burn at most once and never inside A, F2, restore incl. `setFee(0)`, swap-event fields and kinds), §5 gas.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkLaunch.fork.spec.ts test/dogeos/barkswap/BarkPlugin.fork.spec.ts` → all passing, including an assertion that launch gas ≤ 7,000,000

### Task 9: Fork tests: money flow, attribution and Barkswap admin cases            [id: t9]
**Depends-on:** [t8]
**TDD:** required
**Files:** `test/dogeos/barkswap/BarkMoney.fork.spec.ts`, `test/dogeos/barkswap/BarkAdmin.fork.spec.ts`, `test/fixtures/dogeos/barkMoneyFlow.json` (recorded swaps, collects, `CoinFeesConverted` events, a route plan and the `routerPaid`/book read-backs, for t19)
- Spec §3 Money flow, Attribution, Invariants (books = balances; uncollected within the stated tolerance; creator amounts B10 on gross; B11 net splitter base; never `OutOfBand` at any community fee incl. an impersonated admin raise; conversion cap/interval/dust/F2/launch window), admin `setPlugin`/`setPluginConfig`/`setCommunityFee`/`setFee` (principal safe, books correct, `restore`), side-pool creation.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkMoney.fork.spec.ts test/dogeos/barkswap/BarkAdmin.fork.spec.ts` → all passing

### Task 10: Fork tests: splitter, choice vault, escrow, reserve lock, lens, gen-8 regressions            [id: t10]
**Depends-on:** [t8]
**TDD:** required
**Files:** `test/dogeos/barkswap/BarkPeriphery.fork.spec.ts`, `test/dogeos/barkswap/BarkGen8Regressions.fork.spec.ts`
- Spec §3 rows and Invariants (reserve four conditions, claims to the entitled party, F3/F4, buyback caps, escrow); gen-8 F1-F17 regressions marked "applies" in t7. The splitter routes into real vault bytecode deployed on the fork.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkPeriphery.fork.spec.ts test/dogeos/barkswap/BarkGen8Regressions.fork.spec.ts` → all passing

### Task 11: Remove MuchFi contracts and gen-7 DogeOS fork code            [id: t11]
**Depends-on:** [t1]
**TDD:** waived (deletion; the root suite and compile are the check)
**Files:** per Inv. §C: `contracts/dogeos/muchfi/*`, `contracts/test/Muchfi*`, `docs/dogeos/muchfi-variants-audit-diff.md`, `test/Muchfi*.fork.spec.ts` + their helper, `test/DogeosGen7*.fork.spec.ts`, `scripts/lib/dogeosV3Stack.ts` + its spec
- Spec §4 "Removed (B8)". The MuchFi JSON fixtures stay until t13 (indexer tests read them); `scripts/lib/dogeosGen7Stack.ts` and the deploy scripts go in t15 (their reusable parts move first).
**Verify:** `git ls-files contracts test | grep -i muchfi` → nothing except possibly `test/fixtures/muchfiSlot0.json` and `test/fixtures/muchfiSwapLog.json` (t13 deletes them); root `npx hardhat compile` → success; root `npx hardhat test` → no new failures vs before the task

### Task 12: Remove the gen-7/MuchFi DogeOS trade path from the app            [id: t12]
**Depends-on:** none
**TDD:** required (pin and launch-path tests change in the same commit)
**Files:** per Inv. §C: `frontend/src/lib/robinhoodV3Trade.ts` (back to `3a10c6bf`), `robinhoodAdapter`/`robinhoodNativeSwapAdapterEnv` DogeOS branches, `TokenDetails.tsx` `isV3GraduatedTradePage` hunks, tests (`graduatedEvmTradeRoute.test.mjs` `DOGEOS_REVIEWED`, `dogeosLaunchPath.test.mjs`, adapter-env tests), `frontend/.gitignore` (`.mwz-dogeos-launch-path-*`), chain-list exceptions (frontend block), `scripts/dogeos-chain-list-guard.test.mjs` (anchors for removed branches)
- Spec §4 "Removed (B8)". Keep the DOGE gas reserve and the foundation's identity/presentation.
**Verify:** `cd frontend && node --test src/lib/graduatedEvmTradeRoute.test.mjs src/lib/dogeosLaunchPath.test.mjs src/lib/evmGen7Wiring.test.mjs src/lib/evmGen6Wiring.test.mjs` → no failures beyond the known pre-existing ones; `git diff 3a10c6bf -- frontend/src/lib/robinhoodV3Trade.ts` → empty; chain-list guard → pass

### Task 13: Remove the gen-7/MuchFi DogeOS paths from the indexer            [id: t13]
**Depends-on:** [t12]
**TDD:** required
**Files:** per Inv. §C: `robinhoodV3PoolIndexer.ts` MuchFi decode, `evm/evmGraduationKeeper*.ts` MuchFi slot0 + 6281971 gen-7 config, `factoryDiscovery.ts`/`env.ts` gen-7 DogeOS entries, `robinhoodCmsHeal.ts` DogeOS windowing, `evmIndexerChains.ts` `graduatedMarketFor` DogeOS branch, tests (`dogeosV3PoolIndexer`, `dogeosKeeperSlot0`, …), `test/fixtures/muchfiSwapLog.json`, `test/fixtures/muchfiSlot0.json`, chain-list exceptions (indexer block)
- Spec §4 "Removed (B8)", foundation amendments (gen-7 keeper off for 6281971). Keep `dogeosNativeUsdOracle.ts`, the oracle push worker, chain identity and `FORBIDDEN_KEEPER_ADDRESSES`.
**Verify:** `npm --prefix realtime-indexer run build` → rc 0; `npm --prefix realtime-indexer run test:evm-gen5` and `test:evm-gen8` → all pass; every remaining DogeOS indexer test (`git grep -l -i dogeos -- realtime-indexer/src/tests`) → pass; chain-list guard → pass

### Task 14: Remove the gen-7 DogeOS paths from the API            [id: t14]
**Depends-on:** [t13]
**TDD:** required
**Files:** per Inv. §C: `route-auth.js` / `routeAuthorizationSigner.js` 6281971 pair `[7,6]` and gen-7 test-target gates, tests (`frontend/api/dev-fix/dogeosRouteAuth.test.mjs`, `frontend/api/lib/dogeosApiIdentity.test.mjs` parts), chain-list exceptions (API block), `scripts/dogeos-chain-list-guard.test.mjs` (anchors for removed branches)
- Spec §4 "Removed (B8)". The `20261010` migration keeps its $150 constraint (Inv. §C). The gen-7 DogeOS Create readiness in `frontend/src/lib/bnbContracts.ts` is not touched here: t22 replaces it in one edit. `dogeosRouteAuth.test.mjs` is deleted here; its route-key resolution cases (L212-273) are re-created in t21's `evmGen8BarkCreate.test.mjs`.
**Verify:** `cd frontend && node --test api/dev-fix/route-authorization-gen7.test.mjs api/lib/dogeosApiIdentity.test.mjs` → pass; chain-list guard → pass

### Task 15: DogeOS Bark deploy stack            [id: t15]
**Depends-on:** [t7, t11, t17]
**TDD:** required
**Files:** `scripts/lib/dogeosBarkStack.ts` (new; lifts oracle, `GraduationOracle`, vault deploys and the manifest writer from `dogeosGen7Stack.ts`, which is deleted), `scripts/deploy-dogeos-testnet.ts`, `scripts/verify-dogeos-testnet.ts`, `scripts/activate-dogeos-testnet.ts`, `scripts/lib/dogeosTestnetDeployGuards.mjs`, `scripts/dogeos-testnet-deploy-guards.test.mjs` (rewritten), `hardhat.dogeos-bark-verify.config.ts` (new: Bark build settings + `dogeosTestnet` network + explorer, for the seven Bark contracts; `hardhat.dogeos-verify.config.ts` stays 0.8.24 for the reused contracts) and an npm script `verify:dogeos-bark-testnet` that runs explorer verification with it, `package.json` (that script line only), `scripts/lib/deployFactoryWithLocker.ts` (revert the DogeOS `lockerName` option if nothing else uses it), `scripts/make-airdrop-setup-calls.mjs`, `scripts/dogeos-chain-list-exceptions.json` (drop entries made stale by the guard changes), `test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts` (imports only t2's fixture exports and adds nothing to the fixture file, which t8 owns)
- Spec §3 (contracts, "Reused unchanged", Roles B9), §5 Deployment 1; Inv. §C/§D.
- No `TreasuryRouterV4` or capped main vault; wire `CommunityRewardsVault` the way gen-8 does (`e129712b9:scripts/gen8/deploy/`). Guards: Barkswap addresses and code-hash pins replace MuchFi's; the operator address comes from `DOGEOS_OPERATOR_ADDRESS` and must differ from deployer/keeper/updater/route authority.
**Verify:** `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts` → passing (deploy + activate in one fork, read-backs of every role and address); `node --test scripts/dogeos-testnet-deploy-guards.test.mjs` → pass; `git ls-files scripts/lib/dogeosGen7Stack.ts` → empty; chain-list guard → pass

### Task 16: Env generator, env examples and keeper guards            [id: t16]
**Depends-on:** [t15, t17]
**TDD:** required
**Files:** `scripts/dogeos-env-blocks.mjs` (+ its test), `.env.example`, `frontend/.env.example`, `config/coolify-qa-staging.env.example`, `realtime-indexer/src/evm/evmGraduationKeeper.ts` `FORBIDDEN_KEEPER_ADDRESSES` for 6281971 (operator from `DOGEOS_OPERATOR_ADDRESS`), `scripts/dogeos-chain-list-exceptions.json`
- Spec §4 Indexer config, Keepers; B9. Placeholders only, never key values.
**Verify:** `node --test scripts/dogeos-env-blocks.test.mjs` → pass; `cd realtime-indexer && npx tsx --test src/tests/dogeosGraduationKeeper.test.ts` → pass (forbidden list includes the operator when set); chain-list guard → pass

### Task 17: Gen-8 venue seam and DogeOS config            [id: t17]
**Depends-on:** [t14]
**TDD:** required
**Files:** `frontend/api/lib/evmGen8Config.js`, `realtime-indexer/src/evm/evmGen8Config.ts` (incl. `GEN8_LINK_ROUTERS` with Barkswap's SwapRouter for 6281971), `frontend/shared/evmGen8.mjs`, `frontend/src/lib/dogeosPresentation.mjs` (`DOGEOS_DEX_LABEL` → "Barkswap"), their tests, `scripts/dogeos-chain-list-exceptions.json` (re-decide the 10 `evm-gen8-v4` entries, Inv. §B)
- Spec §4 Principle, API (chain lists re-decided), §3 per-swap event fields (link routers), B7. A `venue` (`v4` | `barkswap`) in gen-8 config; 6281971 = `barkswap`; V4 chains unchanged. The admin-finance gen-8 gate (`frontend/api/admin/finance.js`) keeps its 6281971 exception: finance stays out (spec §4 lists no finance path).
**Verify:** `npm --prefix realtime-indexer run test:evm-gen8` → all pass; the gen-8 frontend tests in Inv. §B → same results as before; new venue tests → pass; chain-list guard → pass

### Task 18: Indexer Barkswap ingestion            [id: t18]
**Depends-on:** [t8, t17]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGen8Bark.ts` (launcher + plugin log decode and ingestion, from the t7 ABIs), wiring in `evmGen8Pool.ts`/`server.ts` by venue, `evmGen8Holders.ts` (exclude pool, launcher, plugin, reserve lock, escrow, choice vault for 6281971), `evmGen8HolderBatch.ts` (pool-id representation for Algebra pools), `realtime-indexer/src/tests/evmGen8Bark.test.ts`
- Rows use `execution_source = 'gen8_v4'` (global constraint "Row identity").
- Spec §4 Indexer (two addresses, windowed getLogs, trader `tx.from`, D14, stats from pool price, swap kinds: conversion writes no trade/accrual row, escrow/buyback `league_excluded`); fixture from t8.
**Verify:** `cd realtime-indexer && npx tsx --test src/tests/evmGen8Bark.test.ts` → pass (a recorded Bark swap produces the same row shape as a recorded V4 swap); `npm --prefix realtime-indexer run test:evm-gen8` → all pass

### Task 19: Fee accrual, sell attribution and route-run rows            [id: t19]
**Depends-on:** [t18, t9]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGen8Fees.ts`, `realtime-indexer/src/evm/evmGen8FeeRouting.ts` (route-run row selection and the Bark `ethersRouteChain` venue branch reading the launcher's `routerPaid` and sending `claimRouter`), `realtime-indexer/src/evm/evmGen8Pool.ts` (apply-trade only if needed), `realtime-indexer/src/evm/evmGen8BarkAttribution.ts`, `realtime-indexer/src/tests/evmGen8BarkAttribution.test.ts`
- Spec §3 "Attribution for D1" (buy rows final at swap; sell rows converted by each `CoinFeesConverted` fraction at its average price; route row set matches `expectedPaid`), B11 net base, epoch rule (unconverted remainder counts in the converting epoch).
**Verify:** `cd realtime-indexer && npx tsx --test src/tests/evmGen8BarkAttribution.test.ts` → pass (a scripted sequence of swaps, collects, partial conversions and a route plan reconciles to the wei with `routerPaid` and the books in `test/fixtures/dogeos/barkMoneyFlow.json`); `npm --prefix realtime-indexer run test:evm-gen8` → all pass

### Task 20: DogeOS keepers            [id: t20]
**Depends-on:** [t19, t16]
**TDD:** required
**Files:** `realtime-indexer/src/evm/dogeosBarkKeepers.ts` (new) + config, `realtime-indexer/src/evm/evmGen8Worker.ts` (scheduling, off by default), `realtime-indexer/src/evm/evmGen8SidePools.ts` (Algebra `Pool`/`CustomPool` side venue + MuchFi factory for 6281971), `realtime-indexer/src/evm/evmCreatorChoiceConfig.ts` (6281971 in the chain list and defaults for the buyback worker), `realtime-indexer/src/tests/dogeosBarkKeepers.test.ts`. The route worker's chain-side code is t19's; this task only schedules it with the operator key.
- Spec §4 Keepers: collect + convert, route worker (operator key), choice-vault buyback (operator key), graduation-fee fallback, reserve release, side-pool watch (Barkswap `Pool`/`CustomPool` + MuchFi factory), admin-change watch + `restore`. Keeper vs operator key per B9.
**Verify:** `cd realtime-indexer && npx tsx --test src/tests/dogeosBarkKeepers.test.ts` → pass (each keeper uses the right key, respects its flag, never calls a role function with the keeper key)

### Task 21: API: campaign state and signed create for Barkswap            [id: t21]
**Depends-on:** [t17, t7]
**TDD:** required
**Files:** `frontend/api/lib/evmGen8CampaignState.js` (venue branch), `frontend/api/dev-fix/evmGen8CreateAuthorization.js` (+ CREATE2 salt search so the coin sorts below WDOGE), `frontend/api/lib/evmCampaignProgress.js`, `frontend/api/lib/evmGen8Coins.js` (`findGen8Coin` RPC fallback reads the launcher for 6281971), `frontend/api/lib/evmGen8BarkCreate.test.mjs` (new; includes the route-key resolution cases moved from t14)
- Spec §4 API, §3 launcher (salt, `openAt`); the create signer is the DogeOS route-authority key (B9). V4 branch unchanged.
**Verify:** the gen-8 API tests (Inv. §B) → unchanged results; `cd frontend && node --test api/lib/evmGen8BarkCreate.test.mjs` → pass (salt always sorts below WDOGE; the test replays the launcher's create digest from `MwzBarkLauncher.sol` and the t8 fixture, and the signature recovers to the create signer)

### Task 22: App: create and trade on Barkswap            [id: t22]
**Depends-on:** [t21]
**TDD:** required
**Files:** `frontend/src/lib/evmGen8Client.mjs` (venue branch), `frontend/src/lib/barkswapSwap.mjs` + `barkswapSwap.test.mjs` (SwapRouter `exactInputSingle` with `deployer`, sell `multicall` + unwrap, `limitSqrtPrice` at the start price, QuoterV2; t7 ABIs), the gen-8 create branch and trade panel wiring, `frontend/src/lib/bnbContracts.ts` (replace the gen-7 DogeOS readiness with gen-8 readiness for 6281971), `frontend/src/lib/dogeosLaunchPath.test.mjs` (its readiness pins)
- Spec §4 App. No trade authorization; DOGE gas reserve kept.
**Verify:** `cd frontend && node --test src/lib/barkswapSwap.test.mjs src/lib/dogeosLaunchPath.test.mjs src/lib/graduatedEvmTradeRoute.test.mjs` and the gen-8 client tests → pass, no failures beyond the known pre-existing ones; typecheck error count not above baseline

### Task 23: Staging migration for Barkswap rows            [id: t23]
**Depends-on:** [t19]
**TDD:** required
**Files:** `db/migrations/20261015_000010_dogeos_barkswap.sql` (side-pool venue value, event kinds, conversion bookkeeping if t19 needs it; no new `market_trades_v` label), `database/staging_apply_dogeos_barkswap.sh` (new; applies 20261010 then 20261015), `database/staging_apply_dogeos_launch_path.sh` and `db/migrations/dogeosLaunchPathMigration.test.mjs` (deleted; the new test covers the 20261010 checks it had), `db/migrations/dogeosBarkswapMigration.test.mjs` (new)
- Spec §4 Database (incl. "the 2026-10-10 DogeOS migration is revised": record in the new migration's header that `20261010` stays as is, per Inv. §C). Not run anywhere in this task.
**Verify:** `node --test db/migrations/*.test.mjs` → pass

### Task 24: Program docs            [id: t24]
**Depends-on:** [t15, t20, t22]
**TDD:** waived (documentation)
**Files:** `docs/claude/dogeos.md`, `docs/dogeos/barkswap-runbook.md` (deploy, wiring, canary; keys by role, never values)
**Verify:** `grep -c "barkswap-runbook" docs/claude/dogeos.md` → ≥ 1

### Task 25: Gate 1: full suites against release/evm-gen8            [id: t25]
**Depends-on:** [t8, t9, t10, t15, t16, t18, t19, t20, t21, t22, t23, t24]
**TDD:** waived (verification run)
**Files:** report only (scratchpad)
- Spec §5 Gate 1. Fresh baseline from `origin/release/evm-gen8`. Root hardhat, gen-8 suite, Bark fork suites, frontend, scripts, indexer, typecheck. State whether the anvil-backed gen-8 frontend tests are enabled (`GEN8_ARTIFACTS`); by default they skip on both sides. New failures get a fix dispatch before the gate passes.
**Verify:** the report states "NEW FAILURES: 0"

### Task 26: Gate 2: whole-branch review            [id: t26]
**Depends-on:** [t25]
**TDD:** waived (review)
**Files:** none (review report; MINORS triage)
- Spec §5 Gate 2. A fresh `templar-powers:branch-reviewer` over `3dcafb4a1..HEAD` with the spec, this plan and `C:/Users/sven/Projects/MemeWarzone/.git/templar/MINORS-dogeos.md`.
**Verify:** verdict "Approved" (or "With fixes" with every fix landed and re-reviewed)

### Task 27: Gate 3: fork rehearsal and DOGE budget            [id: t27]
**Depends-on:** [t26]
**TDD:** required
**Files:** `scripts/rehearse-dogeos-bark-fork.ts`, `reports/dogeos/bark-fork-rehearsal.json`
- Spec §5 Gate 3: one fork process runs the t15 deploy + activate, launch, 5+ buyer wallets in the launch window, sell, graduate, collect, convert, route (operator), creator claim, reserve release, keep + buyback, escrow; gas per step; DOGE budget with `getL1Fee` per transaction from the live `L1GasPriceOracle`.
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
- Spec §5 Deployment 1. **Stop and ask the founder for an explicit go first.** The founder generates the operator key and provides its address (`DOGEOS_OPERATOR_ADDRESS`); deployer funded. Deploy, verify on the explorer, activate.
**Verify:** `npm run verify:dogeos-testnet` → every read-back passes against the manifest; `npm run verify:dogeos-bark-testnet` → the seven Bark contracts verified on the explorer

### Task 30: FOUNDER-GATED — TEST wiring            [id: t30]
**Depends-on:** [t29]
**TDD:** waived (environment configuration)
**Files:** none in the repo (env blocks printed by the generator; staging migration)
- Spec §5 Deployment 2. **Stop and ask the founder for an explicit go first**, and again per Coolify call. Staging SQL only with a go; never production. Wires `DOGEOS_OPERATOR_ADDRESS` into the indexer.
**Verify:** TEST API `/health` and the indexer health show 6281971 with the Bark launcher/plugin configured

### Task 31: FOUNDER-GATED — testnet canary            [id: t31]
**Depends-on:** [t30]
**TDD:** waived (live testnet run)
**Files:** `reports/dogeos/bark-canary.json`
- Spec §5 Deployment 3. **Stop and ask the founder for an explicit go first.** One coin graduated by 5+ buyer wallets the founder funds; the gate-3 lifecycle on Chikyū; the TEST app shows it.
**Verify:** the report lists every step with its tx hash, and the coin page on the TEST frontend shows the graduated coin trading on Barkswap

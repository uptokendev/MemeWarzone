# Barkswap plan inventory (2026-10-15)

> Read-only file inventory used to write `docs/templar/plans/2026-10-15-dogeos-barkswap-launch.md`. Paths and line ranges are as read on 2026-10-15 at `3dcafb4a1`; verify before editing. Sections B and C were partly spot-checked.


Repo `C:\Users\sven\Projects\MemeWarzone-dogeos`, branch `feat/dogeos-testnet`, HEAD `3dcafb4a1`.
Spec: `docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md` (309 lines). Program doc: `docs/claude/dogeos.md` (65).
Facts: `docs/dogeos/barkswap-facts.md` (265; addresses L22-39, admin L203). Research proof: `scripts/research/barkswap-plugin/`.

## 0. Research proof (`scripts/research/barkswap-plugin/`, commit 0328e797e)

| File | Lines | Purpose |
|---|---|---|
| README.md | ~150 | Checks 1-9 (117/117 PASS, fork block 8,578,734), gas table, fee-mode analysis (LP-fee mode recommended), deviations 1-12 |
| contracts/BarkInterfaces.sol | 130 | Hand-written GPL Algebra interfaces: IAlgebraPlugin L7, IAlgebraPluginFactory L44, IAlgebraPoolMin L51 (globalState L63), IAlgebraCustomPoolEntryPoint L69, IAlgebraFactoryMin L76, NPM L80, IWNative L119. No npm Algebra package is used. Production needs its own interfaces file (same approach). |
| contracts/MwzBarkLauncher.sol | 244 | Research launcher D (launch, takeGraduationFee, collectLpFees). Starting point for production MwzBarkLauncher, not production code. |
| contracts/MwzBarkPlugin.sol | 223 | Research plugin P (rates, latch, handlePluginFee, convertCoinFees, research-only `setResearchRevertHandle`). |
| contracts/MwzBarkToken.sol | 49 | Research token with optional side-pool guard (B3: guard NOT adopted; production uses gen-8 MwzV4Token). |
| contracts/ResearchBarkHelpers.sol | 39 | Outsider minter + direct pool trader (useful as test helpers). |
| compile.mjs | 50 | solc-js 0.8.26, **evm paris** (spec: production is cancun), via-IR, runs 200; OZ from root node_modules. |
| lib.mjs | 117 | math helpers; `startHardhatFork(repoRoot, config, port, chainId)` L47 (spawns `hardhat node --config hardhat.dogeos-testnet-fork.config.ts`), revert decoding L90-116. |
| tickmath.mjs | 87 | JS TickMath + `snapNearest`, `realTick` (curve planning off-chain). |
| run-proof.mjs | 823 | constants L31-41 (A/B/reserve, FEES 1e6 units, config 135/133), Barkswap addresses L43-55, ABIs L56-115 (pool, factory, router, NPM, QuoterV2, EP), off-chain curve `plan()` L143, `setup` L169, `launch` L240, `feeState/parseSwap/buy/sell` L273-375, checks 1+2 L377, main flow L485-789, main L791. Run: `node scripts/research/barkswap-plugin/run-proof.mjs [--port 8681]` (~6 min). |
| results/barkswap-plugin-proof.{log,json} | — | last run output |

## A. Gen-8 contracts on `origin/build/evm-gen8` @ `e129712b9`

`git diff --stat 38ee22c18 e129712b9 -- contracts/gen8` is empty (spec claim verified). **None** of
`contracts/gen8`, `test/gen8`, `scripts/gen8`, `hardhat.gen8.config.ts`, `hardhat.audit-rerun.config.ts` exists on HEAD.
`origin/release/evm-gen8` (merged into this branch at 126ffbc8b) has no `contracts/gen8` either. Merge-base of HEAD and
e129712b9 is 9c2b71c74.

### A1. contracts/gen8 (all pragma `0.8.26`)

| Path @e129712b9 | Lines | Purpose | Vendor? |
|---|---|---|---|
| contracts/gen8/MwzV4Token.sol | 13 | Plain 1B ERC20 (OZ ERC20 only) | **Yes, byte-identical; reused as is (same bytecode)** |
| contracts/gen8/MwzV4Launcher.sol | 473 | V4 one-tx launch L1-L5, signed create D3, oracle band F6, CREATE2 coin | Yes (diff base for MwzBarkLauncher) |
| contracts/gen8/MwzLaunchHook.sol | 770 | V4 hook: fees, lock, latch, creator ledger, router bucket (`routerPaid`), display | Yes (diff/audit base for launcher money side + plugin) |
| contracts/gen8/MwzFeeSplitter.sol | 197 | Bounded D1 splitter (`expectedPaid`, `bands`) | Yes (diff base for MwzBarkFeeSplitter) |
| contracts/gen8/MwzCreatorChoiceVault.sol | 480 | keep/holders/split/buyback (V4 unlock callback swaps) | Yes (diff base) |
| contracts/gen8/MwzCreatorEscrow.sol | 126 | creator-buy escrow (V4 swap) | Yes (diff base) |
| contracts/gen8/MwzReserveLock.sol | 110 | 2% reserve release (uses TransientStateLibrary for PM unlocked) | Yes (diff base) |
| contracts/gen8/MwzLaunchLens.sol | 94 | views: currentFeeBps, previewFill, grossForNet, progress | Yes (diff base) |
| contracts/gen8/MwzDisplayPair.sol | 130 | BNB-only display pair + factory | Yes (not used on DogeOS) |
| contracts/gen8/interfaces/IMwzLaunchHook.sol | 61 | FeeConfig struct + hook view interface (imports v4 PoolKey/PoolId/IPoolManager) | Yes |
| contracts/gen8/libraries/MwzFeeMath.sol | 39 | rate schedule + exact-output gross (uses v4 FullMath) | Yes (Bark plugin/lens may import it) |
| contracts/gen8/libraries/MwzSwapSim.sol | 125 | external linked lib: exact V4 Pool.swap replay | Yes (V4-only) |
| contracts/gen8/test/Gen8TestHelpers.sol | 341 | local test helpers (V4 router/positions) | Yes (needed for test/gen8 to run) |
| contracts/gen8/test/Gen8AuditRegressionHelpers.sol | 148 | audit regression helpers | Yes |
| contracts/gen8/test/Gen8TestImports.sol | 11 | forces build of v4 PoolManager, V4Quoter + `../../GraduationOracle.sol`, `../../CommunityRewardsVault.sol`, `../../RewardDistributor.sol` (exist on HEAD) | Yes |
| contracts/gen8/abi/*.abi.json (11 files: ChoiceVault 1419, Escrow 359, DisplayPair 321, DisplayPairFactory 209, FeeSplitter 659, LaunchHook 2193, Lens 224, ReserveLock 295, SwapSim 90, V4Launcher 1493, V4Token 336) | — | exported ABIs (`node scripts/gen8/export-abis.mjs`) | Yes. Check whether frontend/realtime-indexer on HEAD already carry copies (section B). |

External imports: `@uniswap/v4-core/src/...` (IPoolManager, IHooks, IUnlockCallback, Hooks, TickMath, LPFeeLibrary,
StateLibrary, TransientStateLibrary, SqrtPriceMath, FullMath, SafeCast, SwapMath, ProtocolFeeLibrary, LiquidityMath,
PoolKey, PoolId, Currency, BalanceDelta, BeforeSwapDelta, PoolOperation, PoolManager), `@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol`,
`@uniswap/v4-periphery/src/lens/V4Quoter.sol`, OZ (ERC20, IERC20, SafeERC20, ReentrancyGuard, Math, ECDSA, MessageHashUtils, Checkpoints).

### A2. test/gen8 (local hardhat, in-process PoolManager)

| Path | Lines | Purpose |
|---|---|---|
| test/gen8/fixtures/gen8.ts | 446 | deploy fixture, signed-create digest (`MWZ_GEN8_CREATE_AUTH` L164), pool-id / state-slot helpers |
| test/gen8/fixtures/v4math.ts | 108 | BPS, COINS_A/B, sqrtAtTick, amount deltas, rateAt, grossForNet |
| test/gen8/hook.spec.ts | 756 | hook unit tests |
| test/gen8/launcher.spec.ts | 312 | launcher (plan() == gen-7 curveForMarketCap, signature, oracle band) |
| test/gen8/periphery.spec.ts | 563 | splitter, escrow, choice vault, reserve lock, lens |
| test/gen8/invariants.spec.ts | 439 | seeded property runs (GEN8_FUZZ_SEEDS / GEN8_FUZZ_STEPS) |
| test/gen8/fixes-2026-10-12.spec.ts | 463 | audit fix round regressions |
| test/gen8/gas-and-sizes.spec.ts | 106 | gas + EIP-170 sizes |
Run: `npx hardhat --config hardhat.gen8.config.ts test` (102 passing on 2026-10-12, ~5 min). Not "use as is" for
DogeOS (V4); vendor only if the plan wants gen-8's own suite runnable here (recommended: proves vendored sources compile and behave).

### A3. Build config

- `hardhat.gen8.config.ts` @e129712b9 (75 lines): solc 0.8.26, cancun, viaIR, runs 200, `bytecodeHash: none`;
  override `@uniswap/v4-core/src/PoolManager.sol` at runs 44444444; remapping subtask `solmate/` -> `node_modules/@uniswap/v4-core/lib/solmate/`;
  `paths.sources ./contracts/gen8`, tests `./test/gen8`, cache `cache-gen8`, artifacts `artifacts-gen8`, typechain `typechain-types-gen8`;
  hardhat network cancun, `allowUnlimitedContractSize`, 12 accounts from `id("mwz-gen8-local/i")` (never default keys).
- `hardhat.audit-rerun.config.ts` @e129712b9: extends gen8 config, sources `./audit-rerun/contracts` (gitignored). Optional.
- `.gitignore` @e129712b9 adds `cache-gen8`, `artifacts-gen8`, `typechain-types-gen8`, `reports/gen8/local-*.json`, `audit-rerun*` (HEAD lacks them).
- `package.json` @e129712b9 adds devDependencies **`"@uniswap/v4-core": "1.0.2"`, `"@uniswap/v4-periphery": "1.0.3"`** (exact pins).
  HEAD has neither; `node_modules/@uniswap` does not exist on HEAD. `package-lock.json` must be regenerated (it is
  already locally modified, `M package-lock.json`, unrelated, in git status). OZ on HEAD: `^5.0.2`, installed 5.4.0 = the
  audited version (GEN8_INTERNAL_AUDIT.md L40-44). solc 0.8.26 download is needed by hardhat (lockfile @e129712b9 L7850 pins solc-js 0.8.26 for scripts).
- HEAD package.json scripts `deploy:dogeos-testnet` / `verify:dogeos-testnet` (gen-7 DogeOS; see C).

### A4. scripts/gen8 @e129712b9

| Path | Lines | Purpose | Reuse for DogeOS |
|---|---|---|---|
| scripts/gen8/deploy/plan-gen8-deploy.mjs | 169 | dry-run deploy planner (nonces, CREATE/CREATE2 via proxy 0x4e59…, hook salt mining, compiler record L146, display for 56/97 L69) | pattern for a DogeOS planner |
| scripts/gen8/deploy/deploy-gen8-testnet.mjs | 380 | sends gen-8 to 46630 only (CHAIN L24 hard pin), keys from exported env, reads gen-7 GraduationOracle maxPriceAge L115 | pattern only; DogeOS needs its own script with dogeos guards |
| scripts/gen8/deploy/inputs.example.json | 117 | per-chain inputs | pattern |
| scripts/gen8/fork-suite/artifacts.mjs | 57 | loads `artifacts-gen8/` (throws if not compiled) | reusable as is (if Bark contracts build into same artifact dir) |
| scripts/gen8/fork-suite/lib.mjs | 127 | `startAnvil` (needs foundry anvil), helpers | DogeOS proof uses hardhat node instead |
| scripts/gen8/fork-suite/run-fork-suite.mjs | 1229 | 746 checks BSC+RH (imports `frontend/shared/evmGen7Curve.mjs`) | V4 only |
| scripts/gen8/fork-suite/step2.mjs | 1473 | step-2 areas | V4 only |
| scripts/gen8/fork-suite/fixes.mjs | 271 | fix-round checks | V4 only |
| scripts/gen8/fork-suite/compare-with-research.mjs | 56 | equivalence with 702 research checks | V4 only |
| scripts/gen8/fork-suite/tickmath.mjs | 87 | TickMath JS | same as research tickmath |
| scripts/gen8/fork-suite/results/* | 21016+2547 | results | do not vendor |
| scripts/gen8/export-abis.mjs | 19 | writes contracts/gen8/abi | pattern for Bark ABIs export |
| scripts/gen8/audit-rerun.sh | 37 | re-runs AI-audit PoCs | optional |

### A5. Audit / design docs @e129712b9 (not on HEAD)

- `docs/evm-launch/GEN8_INTERNAL_AUDIT.md` (853 lines): scope table L23-36, compiler L40-44, results L46+, local suite coverage §2.1,
  invariants, A1-A15, deviations V1-V13, events for indexer ~L410, verification manifest L582.
- `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` (design; 2.2 curve, 2.9 invariants, 6.8 side pools, Appendix A DogeOS).
- `docs/claude/evm-contracts-audit.md` @e129712b9 L140-152 gen-8 section (HEAD's copy lacks it).
Plan should either vendor these two docs or reference them by `git show e129712b9:<path>` (diff audits need a fixed base).

### A6. Compile conflicts on this branch (VERIFIED)

1. **Root `npx hardhat compile` breaks once `contracts/gen8/` exists.** HEAD `hardhat.config.ts` L184-198: single compiler
   0.8.24, `paths.sources ./contracts` (recursive). Verified in a scratch copy of e129712b9 (git archive + junctioned
   node_modules): with deps missing -> `HH411 @uniswap/v4-core not installed`; with only `contracts/gen8/MwzV4Token.sol`
   present -> **`HH606 ... contracts/gen8/MwzV4Token.sol (0.8.26)`**. So build/evm-gen8 itself cannot run the root compile.
   Root pragmas: 115x `^0.8.24`, 4x `0.8.24`, 2x `^0.8.20`, 2x `^0.8.19`. **Do not add 0.8.26 to root compilers**: every
   `^0.8.24` file would then compile with 0.8.26 (bytecode change for every earlier generation). Fix: a root-config
   `TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS` subtask filtering out `contracts/gen8/**` (and wherever the Bark contracts go),
   or keep 0.8.26 sources outside `./contracts`. Spec pins `contracts/gen8/` -> filter subtask is the fit. Every config
   that spreads `base` (hardhat.dogeos-testnet-fork, dogeos-verify, rh-fork, deploy, bnb-gen7-fork, rh-gen7-testnet-fork,
   bsc-testnet) inherits it.
2. **Root `hardhat test`** (`paths.tests ./test`, recursive; `"test": "hardhat test"`) would pick up `test/gen8/*.spec.ts`
   and fail (no gen-8 artifacts in root build). Needs a mocha/test-path exclusion or the gen-8 specs outside `test/`
   (spec does not pin their path). `tsconfig.json` includes `./test/**/*.ts` (typecheck sees them; fine once deps installed).
3. **Fork testing**: `hardhat.dogeos-testnet-fork.config.ts` (65 lines) spreads the ROOT config (0.8.24, ./contracts) and sets
   chainId 6281971, hardfork history cancun@2, blockGasLimit 10M, fork URL/block (curl eth_blockNumber - 16). Bark contract
   fork tests need a **new config = gen8 compiler settings + this fork network** (e.g. spread hardhat.gen8.config with a
   sources dir containing both gen8 and bark contracts). Unlimited contract size must be OFF on the fork (EIP-170 real).
4. Bark contracts' location is not pinned by the spec ("new files"); options: `contracts/gen8/bark/` (inside the gen8
   build, imports `../MwzV4Token.sol`, `../libraries/MwzFeeMath.sol`) or `contracts/dogeos/barkswap/` with its own config.
   `MwzV4Token` "same bytecode": with `bytecodeHash: none` the source path does not change bytecode; same solc/settings required.
5. "Reused unchanged" vaults/GraduationOracle/RewardDistributor/CommunityRewardsVault/oracle are 0.8.24 root-build artifacts;
   deploy them from root `artifacts/`, not from the gen8 build (Gen8TestImports compiles them with 0.8.26 for tests only).
6. Research compiled for **paris**; production cancun (TSTORE for the conversion flag). Chikyū fork config already enables cancun.
7. Local tests: gen-8 local tests build a v4 PoolManager; Bark local tests have no Algebra build (no Algebra npm dep; facts
   doc compiled upstream v1.2.1 with solc 0.8.20 paris in a scratch dir). So Bark contract tests are **fork-only** (as spec §5 says).

## B. Gen-8 off-chain layer on this branch (came with release/evm-gen8)

Summary: every gen-8 chain list excludes 6281971 (widening one as-is would put DogeOS on the V4 path). V4-specific code
is concentrated in: indexer ingest loop + log decoder, PoolManager price read in campaign state, UniversalRouter/Permit2
encoder, app trade client, launcher create/sign path. The rest keys on `venue='gen8'`, `execution_source='gen8_v4'`,
`factory_generation=8`, `evm_gen8_pools.graduated_block/last_phase`. No gen-8 migration has a chain-id CHECK. No frontend
gen-8 test is in any npm script; no `.github` workflow runs gen-8 tests. `database/` has no gen-8 files.

### B1. Chain lists holding gen-8 chain ids

| file:line | constant | contents | 6281971 |
|---|---|---|---|
| frontend/api/lib/evmGen8Config.js:20 | GEN8_API_CHAIN_IDS | [56,97,4663,46630,31337] | excluded (exception) |
| frontend/api/lib/evmGen8Config.js:23-26 | CANONICAL_V4_POOL_MANAGER | 56, 4663 | n/a (V4) |
| realtime-indexer/src/evm/evmGen8Config.ts:60 | GEN8_EVM_CHAIN_IDS | [56,97,4663,46630] | excluded (exception); `evmGen8Config()` L78 does not check it |
| realtime-indexer/src/evm/evmGen8Config.ts:35-38 | CANONICAL_V4_POOL_MANAGER | 56, 4663 | n/a |
| realtime-indexer/src/evm/evmGen8Config.ts:45-50 | GEN8_WRAPPED_NATIVE | 56,97,4663,46630 | excluded (exception L106); `gen8WrappedNative` L52 throws without entry/env |
| realtime-indexer/src/evm/evmGen8Config.ts:168 | isRobinhood (head tags) | 4663,46630 | excluded (exception) |
| realtime-indexer/src/evm/evmGen8Config.ts:212-215 | GEN8_LINK_ROUTERS | 56,4663 (UniversalRouters) | n/a; spec: whitelist Barkswap SwapRouter for 6281971 |
| realtime-indexer/src/evm/evmGen8Pool.ts:776 | quoteAsset ternary | 4663/46630 -> ETH else BNB | excluded (exception) |
| realtime-indexer/src/evm/evmGen8SidePools.ts:55-58, 61-77 | INFINITY_VAULT, DEFAULT_FACTORIES | 56, 4663 | n/a; needs Barkswap factory + MuchFi V3 factory for 6281971 |
| frontend/shared/evmGen8.mjs:58 | GEN8_TEST_TARGET_CHAIN_IDS | [97,46630,31337] | excluded (exception); spec needs 6281971 ($150 target) |
| frontend/shared/evmGen8Swap.mjs:38-49 | GEN8_KNOWN_ROUTERS | 56,4663 | n/a |
| frontend/shared/evmGen8Swap.mjs:51-54 | GEN8_V4_QUOTER | 56,4663 | n/a |
| frontend/shared/evmGen8Swap.mjs:385 | GEN8_SIZED_SLIPPAGE_CHAIN_IDS | [56,97] | absent, no exception needed |
| frontend/api/gen8Swap.js:66 | NATIVE_SYMBOL | 56,97,4663,46630,31337 | excluded (exception); widget out of scope |
| frontend/src/widget/gen8Widget.ts:57 | GAS_RESERVE | 56,97,4663,46630 | excluded (exception); widget out of scope |
| frontend/src/lib/chart/gen8TokenPage.ts:12-15 | PANCAKE_INFINITY_VAULT | 56,4663 | n/a |
| frontend/api/admin/finance.js:957-958 | gen-8 finance gate + error text | 56,97,4663,46630 | excluded (two exceptions) |
| frontend/src/lib/graduatedEvmTradeRoute.mjs:25 | GRADUATED_IMPORT_ROUTE_CHAINS | 56,97,4663 | n/a; L66 returns `gen8_pool` for generation 8 on any chain |

Mixed lists already including 6281971: `frontend/api/evmCampaignState.js:23` EVM_CHAIN_IDS (+ error text L74);
`frontend/api/campaigns-base.js:20,27,31` SQL `chain_id in (56,97,4663,46630,6281971)` (gen-8 variant L26-29 excludes `venue='gen8'`).

`scripts/dogeos-chain-list-exceptions.json` category `evm-gen8-v4` (L12; its text says DogeOS "stays on gen-7 + MuchFi V3
graduation" -> must be reworded). 10 entries L100-109 (exact source-line patterns; guard fails stale entries):
L100/101 admin/finance.js gate + text; L102 api/gen8Swap.js NATIVE_SYMBOL; L103 api/lib/evmGen8Config.js GEN8_API_CHAIN_IDS;
L104 shared/evmGen8.mjs GEN8_TEST_TARGET_CHAIN_IDS; L105 widget/gen8Widget.ts GAS_RESERVE; L106 indexer evmGen8Config.ts
GEN8_WRAPPED_NATIVE 46630 line; L107 GEN8_EVM_CHAIN_IDS; L108 isRobinhood; L109 evmGen8Pool.ts quoteAsset. Spec §4: re-decide
each (6281971 with venue `barkswap` where the path serves DogeOS, an exception otherwise).

### B2. db/migrations (no chain-id CHECK in any gen-8 migration)

- `20261011_000010_evm_gen8_indexer.sql` (199): L9-55 `evm_gen8_pools` (V4 columns pool_id bytes32, hook_address,
  pool_manager_address, tick_start, tick_grad, liq_a, liq_b, last_sqrt_price_x96, last_tick + generic; profile CHECK L52);
  L59-103 `evm_gen8_fee_accruals` (generic; unique (chain,tx,log); CHECKs kind/phase/side/profile/nonneg L91-95; `swap_log_index`,
  `hook_address`) — sell rows need conversion-fraction columns per spec D1 attribution (no home yet); L106-135 `evm_gen8_route_runs`
  (status CHECK L134); L138-159 `evm_gen8_side_pools` **venue CHECK L157 ('v2','v3','v3_pancake','solidly','v4','infinity_cl')** -> needs
  an Algebra/barkswap value; L161-178 side_pool_volume, holder_exclusions; L181-184 `evm_campaign_events_kind_check` adds
  gen8_hook/launcher/splitter/choice_vault (Bark plugin kind needed); L186-191 RLS.
- `20261011_000020_market_trades_v_gen8.sql` (51): patches `market_trades_v` so `execution_source='gen8_v4'` -> GEN8_V4 (regex
  insert L38-50). A Barkswap execution_source needs an analogous patch or it falls into TOPAZ.
- `20261012_000011_evm_gen8_display.sql` (38): `evm_gen8_display_blocks` L9-15, `evm_gen8_swaps` L17-38 (phase/side CHECKs L34-35). Agnostic.
- `20261012_000012_evm_gen8_open_at_phase.sql` (16): `open_at`, `last_phase` CHECK ('bonding','post') L14. Agnostic.
- Test-only schema: `realtime-indexer/src/tests/gen8/gen8-test-schema.sql` (68).
- Related: `20261010_000020_dogeos_chain_launch_path.sql` L9, L24: the only CHECKs naming 6281971 (draft launch options, $150 tier). See C.
- Spec "staging migration lets 6281971 pass gen-8's chain constraints": the gen-8 tables have none; the constraints to touch are
  the draft-launch-options/tier CHECKs and the side-pool venue / event-kind CHECKs.

### B3. realtime-indexer/src/evm/evmGen8*

| file | lines | class | seam |
|---|---|---|---|
| evmGen8Abi.ts | 165 | V4 | V4_POOL_MANAGER_EVENTS L62-65; hook events L22-41 (HookFee/Graduated/PoolLaunched); GEN8_TOPICS L106-136; gen8PoolId L158 (dyn-fee flag L154, spacing 10 L155). Seam: per-venue ABI/topic module (Bark launcher + plugin events). |
| evmGen8Config.ts | 282 | MIXED | Gen8ChainConfig L20-30 has poolManager; evmGen8Config L78-109 needs PM (L91), falls back to CANONICAL_V4 (L84). Seam: `venue` + venue core address (launcher+plugin `0xaddr@startBlock`). Generic: parseEntry, head tags L121-201, gen8LinkCheck L255, gen8LeagueExcluded L273. GEN8_LINK_ROUTERS L212 per-venue. |
| evmGen8Decode.ts | 271 | MIXED (core V4) | decodeGen8Log L63-167 (L71 PM Swap); Gen8Event union L30-56; joinSwapsWithFees L206-247 (Swap+HookFee per (tx,poolId)); classify L191-204. Seam: swap-event decoder — Bark plugin emits ONE event per swap with all fields, so no join needed. Generic: groupByTx L249, gen8TradeTable L264, traderNative L269. |
| evmGen8Pool.ts | 993 | MIXED (core V4) | ingestGen8Range L195-286; control logs L199-200; **V4 swap-log source L229-242** (getLogs PM + poolIds); join L259; applyLaunches L288-357; priceState L369; gen8PricePhase L509-516; applyTrade L376-507 (accrual L386-418 generic given JoinedSwap; swap-kind filtering for conversion goes here); applyEvent L619-744; applyGraduation L746-806 (L776 venue `uniswap_v4`, quoteAsset); reorg L808-886, runGen8ChainOnce L894, startEvmGen8Indexer L944 generic. 10k-block getLogs window for DogeOS must apply. |
| evmGen8Store.ts | 642 | agnostic (labels) | GEN8_VENUE/EXECUTION_SOURCE/REWARD_SOURCE L16-18; Gen8PoolRow L49-75 (poolManager); upsertGen8Pool L118; markGen8Campaign L159-181. Seam: execution_source/venue per adapter. |
| evmGen8Fees.ts | 232 | agnostic | input HookFee-shaped {fee, creatorShare, graduated} L54 |
| evmGen8FeeRouting.ts | 593 | agnostic (hook-coupled) | reads hook RouterClaimed/routerPaid (ethersRouteChain L242-293) -> must read launcher for Bark; sell rows routable only for converted part |
| evmGen8Math.ts | 155 | MIXED | Q96 maths shared; gen8Progress/gen8DisplayStats L77-108, gen8PoolHoldings L144 assume A/B layout (same in Bark) |
| evmGen8SidePools.ts | 323 | MIXED | V4 Initialize L107-116, L197; V4 Swap by ids L242; generic V2/V3/Solidly L61-77. Seam: Algebra factory `Pool`+`CustomPool` events as new SideVenue (+ DB CHECK) |
| evmGen8Holders.ts | 183 | agnostic | exclusions L22-36 include poolManager/hook -> venue-specific (pool, launcher, plugin, community vault) |
| evmGen8HolderBatch.ts | 182 | agnostic | keys on bytes32 pool id (L26) — Bark pool id = pool address? decide |
| evmGen8Guard.ts | 17 | agnostic | isGen8Campaign |
| evmGen8VaultWatch.ts | 89 | agnostic | — |
| evmGen8Worker.ts | 81 | agnostic | startEvmGen8Workers L58; seam: per-venue dispatch; new keepers (collect/convert, grad-fee fallback, reserve release, admin-change watch) have no home yet |

Other indexer gen-8 touch points (guards/SQL, agnostic): main.ts L15,38-39; indexer.ts L52,503,932,1407-1408;
canonicalCandleMaterializer.ts L462-463; emptyTradeCursorRewind.ts L48-49; ensureCampaignTradeHistory.ts L355; marketApi.ts L134,486
("Uniswap V4 pool" text); robinhoodMarketApi.ts L346; lpFeesRoutes.ts L223; tokenTradeList.ts L22-50 (`execution_source='gen8_v4'`);
rewards/leagueLeaderboard.ts L13-82 (gen8 SQL, `'gen8-money:%'` cursor); rewards/airdrops.ts L865-874; rewards/eligibility.ts
L211-218; rewards/recruiterLeague.ts L61-68; evm/payoutWatchdog{Config,Chain,Worker}.ts (Chain L8 GEN8_HOOK_IFACE); package.json L46-47.

### B4. frontend shared / API / config

| file | lines | class | seam |
|---|---|---|---|
| api/lib/evmGen8Config.js | 96 | MIXED | evmGen8ApiConfig L42-80 rejects chains not in GEN8_API_CHAIN_IDS (L44), needs PM (L64-65). gen8ConfigFor L83, isGen8Launcher L88, configuredGen8ChainIds L94 generic. |
| shared/evmGen8.mjs | 480 | MIXED | V4: gen8PoolKey/Id L87-103, TickMath/swap sim L105-340, WrappedError L449. Generic: rates/targets L44-61, isGen8TargetAllowed L68, gen8FeeRate L220, launch request/hash/auth payload L344-425 (MwzV4Launcher struct), labels L21-26 |
| shared/evmGen8Swap.mjs | 448 | V4 encoder + generic helpers | Encoder L20-345 (PERMIT2, UR_COMMANDS, V4_ACTIONS, encodeGen8V4SwapInput L162, buildGen8RouterCall L200, decodeGen8RouterCall L226, gen8PermitTypedData L289); generic L347-448 |
| api/gen8Swap.js | 470 | MIXED | widget API (out of scope for DogeOS) |
| api/evmCampaignState.js | 154 | dispatcher | gen-8 branch L101-121 (readGen8Pool -> readGen8CampaignState / indexed fallback); seam: venue lookup |
| api/lib/evmGen8CampaignState.js | 473 | MIXED (core V4) | poolStateSlot/decodeSlot0 L80-95, readSqrtPrice L131-135 (PM extsload); readGen8Pool L97-129 (hook.pools); readGen8CampaignState L176-389 (gen8 block L357-372); generic: gen8PhaseFields L154-174, readGen8IndexedPool L391-428, gen8IndexedCampaignState L430-473. Seam: pool-record + spot-price reader (Bark: lens + pool.globalState) |
| api/lib/evmGen8Coins.js | 80 | MIXED | findGen8Coin L22-68 RPC fallback via hook ABI L14 |
| api/lib/evmGen8Schema.js 47, evmGen8StrictWallet.js 30, evmGen8PlatformSql.js 55 (gen8PhaseRuleOn L17), evmGen8LeagueSql.js 102, evmGen8BattleNetting.js 98 | — | agnostic | — |
| api/lib/financeGen8.js | 263 | MIXED | readLive L125-157 hook/splitter; gen8PartnerAttribution L50 UR fingerprint |
| api/lib/evmCampaignProgress.js | 133 | MIXED | gen8ItemProgress L73 |

### B5. Create / route-auth (D3) / app

| file | lines | class | seam |
|---|---|---|---|
| api/dev-fix/evmGen8CreateAuthorization.js | 512 | MIXED | isGen8CreateRequest L91-98; parseGen8CreateRequest L201-255; readGen8LauncherPreflight L257-295; signGen8CreateAuthorization L320; gen8CreateAuthorization L338-467; gen8RoutingStatus L469. Seam: launcher adapter (+ CREATE2 salt sorting coin below WDOGE, signer = DogeOS route authority) |
| api/dev-fix/route-auth.js | 774 | hooks | L365-372 status; L428-449 create-auth body; L455-456 dispatch; L667-675 trade-auth 409 for gen-8 |
| api/dev-fix/draftGen8Schedule.js 90; draft-deploy-base.js 703 (L34, L492-513) | agnostic | — |
| api/server.mjs | 738 | routes | L551-556 /widget/swap/gen8/*; L658 /routing/gen8/create-authorization |
| src/lib/evmGen8Client.mjs | 741 | MIXED | gen8AppConfig L171-187 (VITE_EVM_GEN8_*); isGen8Coin L195; create L214-381 (ABI L71, launchGen8Coin L369, parseGen8Launch L307); **trade L383-575 V4** (readGen8PoolRecord L401, quoteGen8Trade L442, previewGen8Fill L491, buildGen8TradeCall L513, prepareGen8SellPermit L536, executeGen8Trade L554, executeGen8EscrowBuy L565); claims L577-617; strings L619-741 |
| src/lib/evmGen8Create.ts 151 (createGen8Campaign L93); evmGen8Draft.ts 23 | agnostic | — |
| src/components/evm/Gen8TradePanel.tsx | 438 | MIXED | cfg L93, hook match L96, gen8MaxSellable L162, quote L189, execute L246-247; BSC protected RPC L405 |
| src/components/evm/Gen8CoinPanels.tsx | 275 | MIXED | claims L149-180 |
| src/components/create/EvmGen8LaunchOptions.tsx | 193 | MIXED | readGen8LaunchPlan |
| src/hooks/useGen8Coin.ts | 111 | agnostic | Gen8CoinState L9-66 (gen8.poolManager) |
| src/pages/Create.tsx | 1715 | seam | L68-70, L262-264, L338-349, L444-459, L1106-1190, L1271-1290, L1514-1529, L1669-1675 |
| src/pages/PushDraftLive.tsx | 1292 | seam | L73-75, L181, L227-228, L301-318, deployGen8 L832-895, L1066-1114, L1226-1244, L1277 |
| src/pages/TokenDetails.tsx | 6752 | MIXED | buildGen8CampaignFromToken L366-380; L622-625; L904-912; holder excludes L1108-1130; L1453; L1902-1907 |
| src/components/postgrad/WarRoomTradePanel.tsx | 1394 | agnostic | L285-287, L1236 |
| src/widget/gen8Widget.ts 478, mwzSwapWidget.ts 483 (L472-478), widgetShared.ts 60 | agnostic / out of scope | — |
| src/lib/chart/gen8TokenPage.ts | 160 | MIXED | Infinity vault L12-15; isGen8DexSource L139 ('gen8_v4') |
| useUnifiedMarket.ts 327, marketContinuityApi.ts 346, chart/normalizeTrade.ts 208 | label `gen8_v4` | — |

Mixed API consumers (only gen8ConfigFor / gen8PhaseRuleOn / venue / execution_source): campaigns-base.js (858; L64-90, L188-256,
L257+, L349+, L494-505, L567-590, L812-843), campaigns-safe.js, coinPage.js, featured.js, warRoom.js, searchAddress.js,
arenaBattles.js, arenaLeague.js, lib/arenaEligibility.js, lib/arenaBattleMetrics.js L440-442, lib/arenaImportScan.js L392-394,
league.js L476-485, leagueRecruiter.js L122-129, importSwap.js gen8ImportRouteRefusal L452, lib/financeRevenueLanes.js L309-311/L408,
admin/finance.js financeGen8 L943-960, scripts/weekly-airdrop/candidates.mjs L171-188.

### B6. Existing gen-8 tests ("gen-8 V4 tests pass unchanged")

realtime-indexer (`tsx --test`):
- `npm run test:evm-gen8` (package.json L46): evmGen8Decode.test.ts (304), evmGen8Fees.test.ts (191), evmGen8AuditFixes.test.ts (312).
- `npm run test:evm-gen8-integration` (L47): evmGen8.integration.test.ts (390), evmGen8Reorg.integration.test.ts (133),
  evmGen8DexQuote.integration.test.ts (70) — throwaway Postgres `tests/gen8/gen8TestDb.ts`, local chain `tests/gen8/gen8LocalChain.ts`.
- In no script: evmGen8HolderBatch.test.ts (124), evmGen8AirdropEligibility.integration.test.ts (123), evmGen8DisplayStats.integration.test.ts (130),
  evmGen8LeagueSettlement.integration.test.ts (254).
- `npm run test:payout-watchdog`: src/evm/payoutWatchdog.test.ts (gen-8 vault cases L443-461).
- Fixtures: tests/fixtures/gen8-logs.json (940), tests/gen8/recordGen8Fixtures.ts (pattern for a recorded Bark plugin fixture).

frontend (`node --test <file>` from frontend/, none in package.json scripts):
- Unit: shared/evmGen8.test.mjs (136), shared/evmGen8Swap.test.mjs (216), api/lib/evmGen8Config.test.mjs (45),
  api/lib/evmGen8BattleNetting.test.mjs (110), api/lib/evmGen8CampaignState.cache.test.mjs (91), api/gen8Swap.test.mjs (85),
  api/dev-fix/draftGen8Schedule.test.mjs (60), api/dev-fix/evmGen8CreateRouteCanary.test.mjs (51),
  src/lib/graduatedEvmTradeRouteGen8.test.mjs (15), src/widget/gen8Widget.test.mjs (84), src/lib/chart/gen8TokenPage.test.ts (129; runner unconfirmed).
- DB: api/evmGen8.db.test.mjs (753), scripts/weekly-airdrop/gen8Netting.db.test.mjs (113).
- Anvil/artifacts (skip when GEN8_ARTIFACTS/anvil/RPC missing): api/dev-fix/evmGen8CreateAuthorization.test.mjs (468; testkit
  api/lib/evmGen8LocalChain.testkit.mjs 254), src/lib/evmGen8Client.chain.test.mjs (428; forks 56/4663), src/widget/gen8Widget.browser.test.mjs (145; Playwright).
  NOTE: these need `artifacts-gen8` — they silently skip on this branch today because contracts/gen8 is absent; vendoring gen-8 makes them runnable.
- DogeOS guard tests referencing gen-8: src/lib/dogeosLaunchPath.test.mjs L318-319 (TokenDetails dependency list incl. gen8State);
  scripts/dogeos-chain-list-guard.test.mjs (reads exceptions JSON).

## C. DogeOS gen-7/MuchFi code to REMOVE (B8)

Attribution: `git log --first-parent --no-merges 6c5ca159a..HEAD`. Line numbers on HEAD. REMOVE = gen-7/MuchFi only; KEEP = foundation; ADAPT = strip gen-7 parts.
Two removals break tests unless the tests change in the same commit: (1) chain-list guard (removing a `6281971` term from a list
that also names `46630` leaves a bare 46630 site needing an exception; removing a DogeOS sibling branch makes its exception stale);
(2) `graduatedEvmTradeRoute.test.mjs` "lost" check fails when a line added by a `DOGEOS_REVIEWED` commit disappears.

Commit key: 50f618a50 gen-7 launch path + MuchFi trade; 79bdad1a6 MuchFi trade gate; 0d2eb7938 V3 header price/liquidity + 0.01 DOGE
reserve; a5b9b03c1 (t32), 39df4b8f8 (t33), fc280f55b (t31), 1b2226875 (t34) MuchFi variant contracts + audit; e3c30cf87 fork config +
MuchFi facts; e0e3ef227/1b4df23bc (t6) gen-7 stack lib; 37bcf52d9/79e798335 (t8) deploy/verify/activate; 3240657c1 (t7) lifecycle spec;
31e0972b6 (t36) open creator rules; 019fab57d (t37) create readiness; 36a34688f route auth 7/6 pair + $150 tier; 993bebfcc DOGE/USD
reader + MuchFi pools in V3 pool indexer; 46c9fd722 CMS heal windows; 3b3537075 keeper slot0 uint32; 00582feff graduation keeper;
ab7512dd7 staging migration; 4b6d8d7f3 (t24) env generator; 613bc9fb8 guard after gen-8 merge; ed187d5ba/3c3471fd7 pin re-scopes;
7de96e8e8 canonical Uniswap V3 stack; foundation: fd8aa9213, c6ec38e30, c8f4ca98d, f0b60bc36, 054c6b63f, 3c47c1ce3, 581d7beba.

### C1. Contracts, fork specs, fixtures, audit doc — all REMOVE

| Path (lines) | Commit |
|---|---|
| contracts/dogeos/muchfi/MuchfiCreatorRewardsVault.sol (749) | 39df4b8f8 |
| contracts/dogeos/muchfi/MuchfiPoolSwap.sol (186), MuchfiV3PositionLocker.sol (520) | a5b9b03c1 |
| contracts/dogeos/muchfi/MuchfiV3NativeGraduationAdapter.sol (94), MuchfiV3PoolRepair.sol (593) | fc280f55b |
| contracts/test/MuchfiForkTestCallers.sol (82) | e3c30cf87 |
| contracts/test/MuchfiForkLockerIntegration.sol (41) | a5b9b03c1 |
| contracts/test/MuchfiForkPriceMathHarness.sol (26) | fc280f55b |
| test/MuchfiFork.facts.spec.ts (267), test/helpers/muchfiFork.ts (99), test/fixtures/muchfiSlot0.json (31), test/fixtures/muchfiSwapLog.json (39) | e3c30cf87 |
| test/MuchfiPositionLocker.fork.spec.ts (433) | a5b9b03c1 |
| test/MuchfiCreatorRewardsVault.fork.spec.ts (411) | 39df4b8f8 |
| test/MuchfiGraduationAdapter.fork.spec.ts (552) | fc280f55b |
| test/MuchfiHarvestGas.fork.spec.ts (321), docs/dogeos/muchfi-variants-audit-diff.md (745) | 1b2226875 |
| test/DogeosGen7Stack.fork.spec.ts (651) | e0e3ef227, 1b4df23bc, 31e0972b6 |
| test/DogeosGen7Lifecycle.fork.spec.ts (625) | 3240657c1, 31e0972b6 |
| scripts/lib/dogeosV3Stack.ts (226), test/DogeosV3Stack.spec.ts (258) | 7de96e8e8 (dead code: only its own spec imports it) |

Fixture coupling: realtime-indexer/src/tests/dogeosV3PoolIndexer.test.ts:44 and dogeosKeeperSlot0.test.ts:18 read the two muchfi
fixtures — remove together. KEEP: DogeosTestnetDogeUsdOracle.sol + spec, DogeosNetworkConfig.spec.ts, docs/dogeos/oracle-audit-diff.md,
docs/dogeos/barkswap-facts.md. Untracked, no action: chatmuchfi.md, DOGEOS_FULL_INTEGRATION_PLAN.md.

### C2. Deploy scripts and guards

- **scripts/lib/dogeosGen7Stack.ts** (591) — REMOVE file, salvage. Gen-7/MuchFi only: 1-30 header; 42-55 MUCHFI_ADDRESSES/fee/spacing;
  61-64 DOGEOS_VAULT_DEX_KIND, DOGEOS_GEN7_CURVE_USD; 66-70 FORBIDDEN_SELECTORS; 175-202 assertMuchfiFeeTierSpacing, dogeosFeeBatchCalls
  (TreasuryRouterV4); 235-242 MuchFi code checks; 273-281 F1 TreasuryRouterV4 + F2 MuchfiCreatorRewardsVault; 288-321 RiskRegistry,
  LaunchCampaignGen7, MuchFi adapter, deployFactoryWithLocker; 323-324 S1 RobinhoodV3NativeSwapAdapterV2; 326-368 fee batch; 370-398 airdrop
  pot (capped F4 main vault + F5 planGen7AirdropCalls); 400-462 factory steps 3-12; 536-585 dogeosManifestRecord (kind dogeos-testnet-gen7).
  Reusable for a gen-8 stack lib: 57-60 DOGEOS_MAX_PRICE_AGE_SECONDS (3600), DOGEOS_DEFAULT_MONTHLY_CAP_USD; 152-156 chain assert;
  158-173 rescaleNativeCaps; 204-213 requireAddress/check; 219-233 signer=admin, route-authority≠admin; 244-259 deploy/send;
  262-263 O1 DogeosTestnetDogeUsdOracle, O2 GraduationOracle; 266-270 V1 TreasuryVaultV2, V2 CharityTreasury, V3 MonthlyLeagueTreasury,
  V4 RecruiterRewardsVault, V5 ProtocolRevenueVault; 282 F3 RewardDistributor; 283-285 CommunityRewardsVault + airdrop RewardDistributor
  (**CRV constructor takes F1 TreasuryRouterV4 -> ADAPT: on gen-8 the splitter is the only depositor; check how gen-8 wires CRV**);
  587-591 writeDogeosManifest.
- **scripts/lib/deployFactoryWithLocker.ts** (e0e3ef227) — REVERT lines 31-44 (lockerContractName), 51-52, 58; callers only dogeosGen7Stack.ts:309, DogeosGen7Stack spec 18, 50-54.
- **scripts/make-airdrop-setup-calls.mjs:39,67,103** (e0e3ef227) — ADAPT: revert 6281971 unless gen-8 DogeOS airdrop pot reuses the planner.
- **scripts/deploy-dogeos-testnet.ts** (122) — ADAPT/rewrite on gen-8 lib. Reusable 34-43, 48-71, 73-76, 104-112. Gen-7: 28, 29-30, 77-81, 83-92, 95-110, 113; header 1-22.
- **scripts/activate-dogeos-testnet.ts** (101) — gen-7 52-93 (LaunchFactoryGen7 enableLive etc.); reusable 29-50. Gen-8 activation is a different call set (ADAPT or REMOVE).
- **scripts/verify-dogeos-testnet.ts** (63) — KEEP; fix header 2-11, line 35 (assertVerificationMatchesManifest keyed on LaunchFactoryGen7).
- **scripts/lib/dogeosTestnetDeployGuards.mjs** (443) — ADAPT. KEEP 23-36, 41-45 (add operator), 61-179, 183-219, 241-265, 330-371, 385-388.
  REMOVE 37-38 + 221-237 (airdrop cap from 46630 gen-7; makes two exceptions stale), 47-59 MUCHFI_EXTERNAL_ADDRESSES (+ use 350-356; replace with
  Barkswap/WDOGE), 269-328 dogeosVerificationEntries (gen-7 set), 373-383 assertVerificationMatchesManifest (ADAPT to launcher), 390-443 planActivation/assertActivated.
- **scripts/dogeos-testnet-deploy-guards.test.mjs** (700) — REMOVE 93-102, 295-316; rewrite 344-388, 389-457, 476-491, 510-530, 594-669, 670-700;
  KEEP 79-92 (+operator), 104-253, 254-294, 318-343, 459-475, 493-509, 532-593.
- package.json:16-17 deploy:/verify:dogeos-testnet — KEEP names, repoint. hardhat.config.ts:8-13, 18, 59-62, 165-169 — KEEP.
  hardhat.dogeos-verify.config.ts — KEEP. hardhat.dogeos-testnet-fork.config.ts (e3c30cf87) — KEEP, ADAPT header 1-10.

### C3. Frontend

- **src/lib/robinhoodV3Trade.ts** (50f618a50) — REMOVE all DogeOS hunks so the file returns to BASE 3a10c6bf: 8; 103-112 (isV3TradeChainId,
  DOGEOS_MUCHFI_POOL_FEE = 10_000); 136-137 `_6281971` env branch; 198-201 normalizeV3Fee DogeOS branch; 264 gate -> isRobinhoodChainId;
  268 wording; 324, 375 normalizeV3Fee(market).
- **src/lib/robinhoodNativeSwapAdapterEnv.mjs:10, 19-20** (79bdad1a6) — REMOVE.
- **src/lib/tradeBalanceReserve.ts** (0d2eb7938) — KEEP (1, 19-22, 28-32 DOGE_BUY_GAS_RESERVE_WEI, evmBuyGasReserveWeiForChain; foundation DOGE reserve).
- **src/pages/TokenDetails.tsx** — ADAPT. REMOVE isV3GraduatedTradePage hunks (79bdad1a6, 0d2eb7938), restore isRobinhoodPage: 823-825, 2081,
  2378-2379, 2395, 3486, 3493, 3757, 3777, 3844, 3847, 6143. KEEP evmBuyGasReserveWeiForChain lines 134, 4921, 5089, 6714 and presentation
  (34, 822, 892, 2747-2751, 3817-3819, 4517, 5296, 5320, 5665-5669, 6590).
- **src/components/postgrad/RobinhoodWarRoomTradePanel.tsx** — REMOVE 19 (isDogeosChainId import part), 20, 82-83, 126-129; nativeSymbol/
  buyGasReserveWei generalisation (127, 130-131, 168-282, 374, 469) can stay (pins reference these).
- **features/launchpad**: robinhoodAdapter.ts:5, 57, 60-61; useLaunchpadAdapter.ts:7, 22-23 (DogeOS -> gen-7 robinhood adapter) — REMOVE/ADAPT.
  **lib/launchpadClient.ts**: 13, 596-597 KEEP (product chain identity); 740-741 REMOVE (gen-7 USD target); 1038-1053 REMOVE (gen-7 buy switch).
- Gen-7 launch UI (50f618a50): pages/TokenDetailsLiveEntry.tsx:13, 68-71, 114, 119, 122, 312 (isV3FamilyChainId) KEEP identity, rename;
  components/postgrad/WarRoomCampaignRow.tsx:13-14, 133-135, 154, 392-394 REMOVE (130, 178 identity stay); lib/lpFeeHarvest.ts:8, 24-27,
  216-231, 238-250 REMOVE; lib/evmGen7.mjs:20, 96-102, 111 REMOVE; components/create/EvmGen6LaunchOptions.tsx:7, 93-94, 309 REMOVE;
  pages/Create.tsx:92, 384-385 KEEP/ADAPT (gen-8 create runs through evmDirectDeployEnabled 389-396); lib/graduationTiers.ts:68-74 KEEP ($150),
  fix comment; lib/scheduledLaunchClientV2.ts:66 (`6281971: [[7, 6]]`) REMOVE with API pair.
- **src/lib/bnbContracts.ts:16, 165-170, 196** (t37, 019fab57d) — ADAPT: readiness set is gen-7 (launchFactory, campaign impl, TreasuryRouter,
  permanentLpLocker); Create gate (Create.tsx:355-396) still requires launchFactory -> gen-8 DogeOS readiness must be re-decided.
- Presentation: lib/dogeosPresentation.mjs:4, 14 DOGEOS_DEX_LABEL "MuchFi" -> "Barkswap"; consumers chainPresentation.ts:136-139,
  homeFeedData.ts:87, evmLaunchpadSafetyPresentation.mjs:83; chainRegistry.ts:140-143 (comment + shared `robinhood-dex-testnet` adapter keys).
- frontend/.gitignore `.mwz-dogeos-launch-path-*/` (79bdad1a6) — REMOVE if dogeosLaunchPath.test.mjs goes.
- frontend/.env.example (4b6d8d7f3): KEEP 17-18 RPC; REMOVE/ADAPT 201-222 (factory, campaign impl, router, LP locker, VITE_ROBINHOOD_V3_*_6281971,
  MuchFi note 205) and 291-301 (FACTORY_ADDRESS, LP_LOCKER, EVM_GEN7_*_6281971; keep DOGEOS_RPC_HTTP_6281971). Root .env.example:43-50, 125 KEEP; add operator key.

### C4. Indexer

- **robinhoodV3PoolIndexer.ts** (993bebfcc) — REMOVE all DogeOS: 26; 42-57 (MuchFi Swap ABI, slot0 ABI, constants, 10k cap); 67, 70; 75;
  155-164 chainConfigs DogeOS block (sibling anchor); 168-182 startingLogChunk/swapTopicsFor/slot0AbiFor; call sites 934, 1490, 1502, 1517;
  1752-1756 internals (chainConfigs, scanPool, spotQuotePerBase exported only for the DogeOS test).
- **evm/evmGraduationKeeper.ts** (3b3537075) — REMOVE 98-110 (MUCHFI_V3_POOL_OBSERVATIONS_IFACE), 823-828 (v3PoolPriceAbi), call sites ~1007,
  1056-1058. KEEP 1112-1114 forbidden DogeOS keys (+ operator per spec).
- **evm/evmGraduationKeeperConfig.ts** (9, 10-11 + 18-21, 28-32 V3_GRADUATION_CHAINS, 45) and **evmGraduationKeeperWorker.ts** (5, 9-10, 18, 38) — REMOVE DogeOS (gen-7 keeper off).
- **robinhoodCmsHeal.ts** — REMOVE 5, 25-45, 78-79 (46c9fd722 windows), 220-224 (993bebfcc). Gen-8 keeps its own 10k window.
- **robinhoodMarketApi.ts** — REMOVE 4, 16-23 (V3_MARKET_ROUTE_CHAIN_IDS; 23 sibling anchor JSON 139), 47-58, 92, 301, 347, 525.
- **robinhoodMarketValuation.ts:1-2, 156-159** — REMOVE dispatch. dogeosNativeUsdOracle.ts KEEP (no runtime import after removal -> re-wire in gen-8 adapter for USD pricing).
- **evmIndexerChains.ts** (fd8aa9213): 84-89 isV3GraduationIndexerChainId REMOVE DogeOS; 91-96 graduatedMarketFor DogeOS -> v3/WDOGE REMOVE (+ "WDOGE" type);
  KEEP 1, 24, 80-81, 98, 106; 160-169 CHAINS entry ADAPT (RPC/identity stay; factoryAddress/FACTORY_START_BLOCK_6281971 dead).
  NOTE: merge 126ffbc8b put `indexer.ts`: "gen-8 market override, else graduatedMarketFor(chainId)".
- **factoryDiscovery.ts:96-105** REMOVE (99 sibling anchor JSON 138). **env.ts** 64-66 (ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971) REMOVE;
  78, 92-93, 121 (FACTORY_* / SUPPORTED_FACTORY_*_6281971) REMOVE (92 anchor JSON 136); KEEP 53-55, 113-114, 128.
  **emptyTradeCursorRewind.ts:4, 12-13** REMOVE (anchor JSON 134).
- KEEP: oracle push (dogeosOraclePushConfig.ts, dogeosOraclePushWorker.ts, main.ts:12, 34-35), server.ts:409-410, notification/symbol/airdrop foundation.

### C5. API

- routeAuthorizationSigner.js (36a34688f): 22-23, 172-173 (`[DOGEOS_TESTNET_CHAIN_ID, [[7, 6]]]`) REMOVE.
- route-auth.js:190, 199 (`|| cid === 6281971` in $6/$150 gen-7 gates) REMOVE; gen-8 create goes through evmGen8CreateAuthorization.js.
- drafts-base.js:93-97 ($150 tier on 6281971) KEEP for gen-8 $150 drafts; fix comment.
- security.js:237-241 OPEN_CREATOR_CHAIN_IDS incl. 6281971 (31e0972b6) KEEP; fix gen-7 wording.
- Foundation, KEEP but inert for gen-7: dashboard/lp-fees.js:50-56 (V3 locker branch, REMOVE/ADAPT), 147, 553; lib/evmCampaignProgress.js:26, 52, 119;
  evmCampaignState.js:23, 74; campaigns-base.js:20, 27, 31; draftEvmLaunchOptions.js:10; rewards.js:18; reward-claim-*.js; rewardClaimVerification.js;
  recruiter-payouts.js:217, 527; profile/portfolio.js; lib/arenaMarketSnapshot.js; lib/dogeUsdPrice.js.
- config/coolify-qa-staging.env.example (4b6d8d7f3): REMOVE 113, 116-132 (keep 115 RPC, 128 WDOGE as needed), 213-220, 268-277, 279-286 (gen-7 keeper +
  EVM_KEEPER_V3_* MuchFi 10000); KEEP 111, 114-115, 210-212, 221-223, 264-267, 278, 287-291 (oracle push).

### C6. DB

- db/migrations/20261010_000020_dogeos_chain_launch_path.sql (27; ab7512dd7): nothing MuchFi-specific. Constraint 2 (L11-25, $150 clause + 6281971)
  KEEP (gen-8 $150 drafts), rewrite comment 11-13. Constraint 1 (L6-9 campaign_draft_evm_launch_options_chain_chk, gen-6/7 launch-options table)
  needed only if gen-8 DogeOS drafts write that table (check draftEvmLaunchOptions.js / gen-8 schedule); sibling anchor JSON 120.
- database/staging_apply_dogeos_launch_path.sh (47), db/migrations/dogeosLaunchPathMigration.test.mjs (162): DELETED by t23. Superseded by
  database/staging_apply_dogeos_barkswap.sh (applies 20261010 unchanged, then 20261015) and db/migrations/dogeosBarkswapMigration.test.mjs
  (carries every 20261010 check over).

### C7. Env generator scripts/dogeos-env-blocks.mjs (308; 4b6d8d7f3) — KEEP file, ADAPT

KEEP 1-24 (fix 7-10), 35-75, 111-119, 228-308. REMOVE/rewrite: 25-33 MUCHFI pins/fee tier; 62-68 requirePinned text; 77-109 readManifest
(requires dex.feeTier 10000, LaunchFactoryGen7, LaunchCampaignGen7Implementation, MuchfiV3PositionLocker, nativeSwapAdapter, fees.router);
121-159 frontend block (keep 129 RPC, 134-138 vault names if needed, 144-147 notes); 161-167 gen7FeeStack; 169-188 API (173-180 go, KEEP 172,
181-186 route key = create signer per B9); 190-226 indexer (195-215 go; KEEP 216-224 oracle push); 247 placeholder text.
scripts/dogeos-env-blocks.test.mjs (417): REMOVE/rewrite 215-233, 304-315, 322-364; KEEP 234-303, 365-417.

### C8. Chain-list guard and source pins that must change

**scripts/dogeos-chain-list-exceptions.json**: category text L12 (`evm-gen8-v4`, "stays on gen-7 + MuchFi V3 graduation") reword; L107 reason
cites gen-7 + MuchFi. Stale after removal: 116-117 (deploy guards airdrop-cap 46630 ref); 114 gen7AirdropPot.ts reason only; 112 draft-deploy-base
"$6 tier, gen-7 arming" reword. Sibling entries whose DogeOS branch goes: 120 (migration), 122 (route signer pair), 133 (`6281971: [[7, 6]],`),
134 (rewind), 136 (SUPPORTED_FACTORY_ADDRESSES_6281971), 138 (factoryDiscovery), 139 (V3_MARKET_ROUTE_CHAIN_IDS), 141 (V3 pool indexer block);
140 (dogeosNativeUsdOracle.ts) stays if reader kept. New bare 46630 sites (need exceptions, e.g. a "gen-7-only (B8)" category): route-auth.js:190,
199; evmGraduationKeeperConfig.ts:9, 32, 45; evmGraduationKeeperWorker.ts:37; evmIndexerChains.ts:88, 94; robinhoodCmsHeal.ts:222; evmGen7.mjs:101;
WarRoomCampaignRow.tsx:130 (if touched); lp-fees.js:47; robinhoodMarketApi.ts; any 46630 within 3 lines of a removed 6281971.

**scripts/dogeos-chain-list-guard.test.mjs** INDIRECT_LAUNCH_PATH_CHECKS L42-75: remove 44-57 entries as branches go (launchpadClient x3,
robinhoodAdapter, useLaunchpadAdapter, Create, EvmGen6LaunchOptions, lpFeeHarvest, robinhoodV3Trade, TokenDetailsLiveEntry, TokenDetails,
tradeBalanceReserve, RobinhoodWarRoomTradePanel, WarRoomCampaignRow), 59 (routeAuthorizationSigner pairs), 63 (lp-fees V3 locker). Keep 55
tradeBalanceReserve, 49 Create, 53 TokenDetailsLiveEntry, 44 productChain. Update comment 43.

**frontend/src/lib/graduatedEvmTradeRoute.test.mjs**: DOGEOS_REVIEWED L160-168 — drop `"lib/robinhoodV3Trade.ts": ["50f618a50"]` (164; file must
equal BASE). TokenDetails (167) and panel (166) keep 0d2eb7938/50f618a50 but the "lost" check (258, 290-293) fails once reviewed lines such as
`const isV3GraduatedTradePage = …` are gone: 79bdad1a6 leaves the TokenDetails list and removals need an allowance (reviewed-removal commit /
REVERTED set). Rewrite comments 6, 133, 273-274, 283-286; revert assertion 134 to `!isRobinhoodPage`. MERGE_REAPPLIED 175-183 keeps DOGEOS_DEX_LABEL.

**frontend/src/lib/dogeosLaunchPath.test.mjs** (585): REMOVE 11-12, 14-17, 27-34, 232-246, 250-265, 267-283, 285-293, 295-334, 352-444, 446-477;
KEEP/move 336-350 (DOGE reserve) and 479-585 (t37 readiness, ADAPT); L318-319 gen8State pin (3c3471fd7) is in the removed token-page block.

Other frontend tests: robinhoodWalletSwitchPresentation.test.mjs:39-41, 47-50 revert; robinhoodBondingWalletSwitchPresentation.test.mjs:19-20
revert; mobileTradePresentation.test.mjs:107-109 KEEP if panel reserve stays; robinhoodNativeSwapAdapterEnv.test.mjs:36-55 REMOVE;
dogeosPresentation.test.mjs:123, 178, 214, 218, 325, 328 "MuchFi" -> "Barkswap".

API tests: route-authorization-gen7.test.mjs:62-66 restore `isSupportedGenerationPair(6281971, 7, 6) === false`; route-authorization-signer.test.mjs:262
drop 6281971; dogeosRouteAuth.test.mjs (292, whole file, gen-7 factory stub) REMOVE but rewrite 212-273 (route-key resolution reused by gen-8 B9);
creator-open-limits.test.mjs KEEP.

Indexer tests: dogeosV3PoolIndexer.test.ts (630) REMOVE 145-329, 484-630, KEEP 330-483 (DOGE/USD reader) moved to own file minus valuation
dispatch test at 436; dogeosKeeperSlot0.test.ts REMOVE; dogeosGraduationKeeper.test.ts REMOVE 38-75, 104-122, KEEP 77-102; dogeosIndexerChains.test.ts:143-157
REMOVE, adjust 74-89 / 90-141 if env factory fields go.

Unaffected foundation tests: searchAddress.test.mjs:59-60, solanaCurrentAuthority.test.mjs:149-159 (ed187d5ba).

## D. Foundation pieces to KEEP and reuse (2026-10-10 foundation spec)

| Piece | Files (lines) | Commit | Keep / adapt for Barkswap |
|---|---|---|---|
| DOGE/USD testnet oracle | contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol (90); test/DogeosTestnetDogeUsdOracle.spec.ts (136); docs/dogeos/oracle-audit-diff.md (236) | 7abea7299 | KEEP unchanged (same bytecode). Its deploy currently lives inside `scripts/lib/dogeosGen7Stack.ts` (see C) -> extract. |
| Network config | scripts/lib/dogeosNetwork.ts (42: chain id, RPC, explorer, key resolve L16-35); hardhat.config.ts dogeosTestnet network + `config/dogeos.local` dotenv (HEAD-only hunks vs e129712b9); test/DogeosNetworkConfig.spec.ts (122) | foundation | KEEP |
| Fork config | hardhat.dogeos-testnet-fork.config.ts (65) | foundation/MuchFi | KEEP; header comment mentions MuchFi; add a gen8-compiler sibling for Bark fork tests (A6.3) |
| Verify config | hardhat.dogeos-verify.config.ts (42) | foundation | KEEP/ADAPT (0.8.24 vaults/oracle verify; Bark contracts need 0.8.26 settings) |
| Deploy guards | scripts/lib/dogeosTestnetDeployGuards.mjs (443): constants L23-38, `DOGEOS_TESTNET_ROLES` L41-45 (deployer 0x6c5C…82f8, oracleUpdater 0x7dBD…E9c1, graduationKeeper 0xb07B…B078), `MUCHFI_EXTERNAL_ADDRESSES` L51-59 (REMOVE/replace with Barkswap addresses from barkswap-facts L25-39), assertDogeosTarget L93, assertBroadcastToken L104 (`I_HAVE_FOUNDER_GO`), assertDeployerSigner L114, resolveRouteAuthority L134 (0x4fcD…76FF), assertDeployGuards L160, assertActivateGuards L173, Binance price L184-216, airdrop cap from 46630 gen7 reference L225 (`deployments/robinhood/testnet.gen7.json`), output paths L245, verification entries L275-330 (has `vaultDexKind` — gen-7 vault arg), verify helpers L347-385; test scripts/dogeos-testnet-deploy-guards.test.mjs (700) | t8 | KEEP core; ADAPT: add operator role (fifth key; its public address is not in the repo — founder must supply it, never read config/dogeos.local), drop MuchFi addresses, verification entries for the 7 Bark contracts |
| Env generator | scripts/dogeos-env-blocks.mjs (308): MUCHFI consts L26-33 (REMOVE), frontendBlock L121, gen7FeeStack L161 (REMOVE/replace), apiBlock L169, indexerBlock L190, renderDogeosEnvBlocks L229, forbidden-input guard L261; test scripts/dogeos-env-blocks.test.mjs (417) | foundation | ADAPT: emit gen-8 env pattern (`0xaddr@startBlock`) for Bark launcher + plugin + venue `barkswap`, splitter, vaults, operator/keeper worker toggles |
| Chain lists + guard | scripts/dogeos-chain-list-guard.test.mjs (288), scripts/dogeos-chain-list-exceptions.json (144; categories incl. `evm-gen8-v4` L12, entries L100-109) | 65c2e56a9, 613bc9fb8 | KEEP; re-decide gen-8 entries (B1) and drop MuchFi/gen-7 ones (C) |
| Presentation | frontend/src/lib/dogeosPresentation.mjs (18; **`DOGEOS_DEX_LABEL = "MuchFi"` L14 -> ADAPT to "Barkswap"**), test (361); chainPresentation.ts, chainConfig.ts (13 refs), feedChainConfig.ts, activeWalletChain.ts, walletChainGuard.mjs, ChainFeedSwitch.tsx | f0b60bc36, 054c6b63f | KEEP, adapt label |
| Chain identity tests | frontend/src/lib/dogeosChainIdentity.test.mjs (243), frontend/api/lib/dogeosApiIdentity.test.mjs (617) | foundation | KEEP; check for MuchFi strings (C) |
| DOGE/USD price (API) | frontend/api/lib/dogeUsdPrice.js (72: resolveDogeUsdPrice L44, readDogeUsdPriceSync L68) + test (308); frontend/src/hooks/useDogeUsdPrice.ts (128) | c8f4ca98d | KEEP |
| DOGE/USD reader (indexer) | realtime-indexer/src/dogeosNativeUsdOracle.ts (151: evaluate L56, getDogeosNativeUsdReference L94) | 993bebfcc, 46c9fd722 | KEEP oracle reader; graduation-anchor/CMS-heal windowing parts are gen-7 (C) |
| Oracle push worker | realtime-indexer/src/evm/dogeosOraclePushWorker.ts (225), dogeosOraclePushConfig.ts (156; max age 3600 L17, FORBIDDEN_ORACLE_PUSH_SIGNERS L27), main.ts L12/L34; test src/tests/dogeosOraclePush.test.ts (308) | foundation | KEEP |
| Keeper key guard | realtime-indexer/src/evm/evmGraduationKeeper.ts `FORBIDDEN_KEEPER_ADDRESSES` L1108-1115 (DogeOS deployer, updater, route authority), assertKeeperKeyAllowed L1117; used by payoutWatchdogConfig.ts L9/24, evmCreatorChoiceConfig.ts L3/20, protocolForwarderKeeper.ts L27/105; test src/tests/dogeosGraduationKeeper.test.ts L27-89 | foundation | ADAPT: add DogeOS operator address (spec §3 amendments) |
| Indexer chain wiring | realtime-indexer/src/tests/dogeosIndexerChains.test.ts (219), dogeosIndexerSymbols.test.ts (124); getServerReadProvider.js (8 refs), rpcUsage.js | foundation | KEEP (gen-7 factory entries are C) |
| Route authority (create signer) | frontend/api/dev-fix/routeAuthorizationSigner.js, route-auth.js (2 refs each), security.js; test frontend/api/dev-fix/dogeosRouteAuth.test.mjs (292) | foundation + gen-7 | KEEP the key wiring; gen-7 route-auth for DogeOS factory is C; spec B9 reuses this key as gen-8 `createSigner` |
| Manifest | `deployments/dogeos/testnet.json` (not on disk yet), `config/verification/dogeos-testnet-contracts.json` (not on disk) | — | new manifest shape for the Bark stack |

## E. Test infrastructure

- **Root hardhat (0.8.24)**: `npx hardhat test` (package.json `"test": "hardhat test"`). Gate-1 runner used an explicit file list:
  `node node_modules/hardhat/internal/cli/cli.js test $(find test -name "*.ts" | grep -v test/evmgen-indexer-graduation-keeper.spec.ts)`
  (scratchpad/run-hh.sh). Once test/gen8 exists, exclude it (A6.2).
- **Gen-8 local suite**: `npx hardhat --config hardhat.gen8.config.ts compile|test` (needs v4-core/periphery installed). Fuzz:
  `GEN8_FUZZ_SEEDS=101..140 GEN8_FUZZ_STEPS=300`.
- **Gen-8 fork suite**: `node scripts/gen8/fork-suite/run-fork-suite.mjs` (anvil, BSC 56 + RH 4663 RPCs; V4 only; 2,388 checks ~).
- **DogeOS fork tests**: `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/<spec>` one spec at a time
  (scratchpad/run-fork.sh; MuchFi+gen-7 specs took 43-447 s each, ~30 min total). Env: `DOGEOS_TESTNET_FORK_RPC`, `DOGEOS_FORK_BLOCK`.
  Uses the root compiler -> Bark specs need the new gen8+fork config.
- **Research proof runner**: `node scripts/research/barkswap-plugin/run-proof.mjs [--port 8681]` (~6 min; spawns `hardhat node` with the
  dogeos fork config, solc-js compile in-process, fresh research keys). Good template for the gate-3 one-process rehearsal.
- **Frontend**: `cd frontend && node --test <files>` over `find src shared api -name "*.test.mjs"` excluding `api/campaigns/upsert.test.mjs`,
  which runs as `node --import ./api/campaigns/upsert.test.register.mjs --test api/campaigns/upsert.test.mjs`. Typecheck
  `npx tsc --noEmit -p tsconfig.app.json` (88 pre-existing `error TS` at 2026-10-10).
- **scripts**: `node --test scripts/*.test.mjs`; **db migrations**: `node --test db/migrations/*.test.mjs`.
- **realtime-indexer**: `npx tsx --test $(find src -name "*.test.ts" | grep -v .integration.test.ts)`; `npm run build`;
  `npm run test:evm-gen8`, `test:evm-gen8-integration` (throwaway Postgres).
- Full gate runner: scratchpad/run-node-suites.sh (frontend, upsert, scripts, dbmig, indexer, TAP + spec reporters to scratchpad/logs).
- **Baseline known failures** (scratchpad/t26-gate1-report.md, 2026-10-10, HEAD 31e0972b6 vs 385e2d58c — i.e. BEFORE the
  release/evm-gen8 merge; spec gate 1 now compares against `release/evm-gen8` (e5abd04bc), so a fresh baseline run is needed):
  - Hardhat (3, both sides): MwlPayoutVaults timestamp ordering; MwlPayoutVaults `DATABASE_URL missing`; indexer EVM creator-choice
    operator `c:` URL scheme.
  - Frontend 31 pre-existing (whole-file: squadJoinOwnership.db, leagueHiddenTestCoins.db, agent5ClaimsCloseout.integration,
    bnbBattleClaimRecovery.integration, moderationActions.db, projectImport{Core,Identity,ManualClaimRetry}, projectOwnershipReview,
    robinhoodStockGraduationRegistry, votes-ingest.rh46630, solanaArenaPaymentLifecycle, solanaWallet.detect, mwzSwapWidget;
    individual mostly CRLF pins: arenaTournamentAdminContract, dbc/create, solana-create-authorization-v4 x2,
    arenaImportProfileCertification x2, arenaPhase12QaCertification, createCanary, solanaCurrentArenaAuthority,
    solanaCurrentAuthority x2, imported-token-details-page, graduatedEvmTradeRoute x2, mobileTradePresentation,
    robinhoodBondingWalletSwitchPresentation, walletConnectTarget).
  - Then-new DogeOS failures (searchAddress pin, solanaCurrentAuthority UpvoteDialog pin, graduatedEvmTradeRoute byte pins
    robinhoodV3Trade.ts / tradeBalanceReserve.ts / RobinhoodWarRoomTradePanel.tsx) — re-scoped later by ed187d5ba and 3c3471fd7.
  - scripts 11 pre-existing (arenaV2DeploymentAuthority, prove-bnb-6c-rehearsal, prove-bnb-creator-fee-generation,
    prove-bnb-current-generation x3, prove-bnb-real-topaz-executor #13, prove-bsc97-topaz-30bps, rh46630-indexer-scan-wired x2,
    robinhood-current-stage-authority).
  - indexer 5 pre-existing (phase4-phase7, robinhoodBeatTheMarketService, robinhoodMarketRoutes, solanaGraduationEventDecode whole files;
    solanaGraduationQuoteBinding keeper SQL byte-identical). Integration tests needing DB excluded.
  - DogeOS fork specs at that time: 80 passing (these specs are to be REMOVED, section C).

## F. Risks for the plan

1. **Root compile/test breakage (verified HH606)** when `contracts/gen8/` lands: need a source-path filter in hardhat.config.ts
   (excluding contracts/gen8 + Bark dir) and a test-path exclusion for test/gen8; never add 0.8.26 to the root compiler list.
   Changing hardhat.config.ts touches every config that spreads it — prove root artifact bytecode is unchanged (compare
   artifacts before/after).
2. **New deps** `@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3` (exact) + package-lock regen; lockfile is already
   locally modified (uncommitted) — decide what to do with that first. Frontend/indexer do not need them.
3. **No Algebra npm package**: interfaces are hand-written (research BarkInterfaces.sol); local unit tests impossible without
   building Algebra 1.2.1 -> all Bark contract tests are Chikyū-fork tests (slow: minutes per spec, needs public RPC; pin
   `DOGEOS_FORK_BLOCK` for reproducibility).
4. **Contract size**: MwzBarkLauncher combines MwzV4Launcher (473 lines) + money side of MwzLaunchHook (770) + collect/convert/
   restore/graduation fee -> EIP-170 24,576-byte risk with via-IR runs 200; may need an external library split (gen-8 used
   linked MwzSwapSim). Fork config keeps `allowUnlimitedContractSize: false`.
5. **Launch gas** 6.13M proof vs 7M gate, with on-chain curve planning (gen-7 `curveForMarketCap` port), signature check,
   reserve-lock/choice-vault registration still to add.
6. **Huge files touched by the adapter**: TokenDetails.tsx 6752, Create.tsx 1715, PushDraftLive.tsx 1292, WarRoomTradePanel.tsx 1394,
   evmGen8Pool.ts 993, campaigns-base.js 858, evmGen8Client.mjs 741 — byte-pin tests (graduatedEvmTradeRoute, dogeosLaunchPath)
   guard several of them; "V4 path byte-for-byte" means adapter seams must be additive (new modules + dispatch), not edits inside V4 functions.
7. **Spec items with no code home yet**: (a) Bark contracts directory + build config; (b) DogeOS deploy script for the new stack
   (gen8's deploy script is 46630-pinned; DogeOS gen-7 stack lib to be stripped); (c) keepers: collect + convert scheduler,
   graduation-fee fallback, reserve release, admin-change watch (+ `restore`), side-pool watch on Barkswap factory `Pool`/`CustomPool`
   and MuchFi V3 factory — evmGen8Worker.ts is the natural host; (d) D1 sell-row conversion attribution (per-conversion fraction,
   partial routability) — new columns/table beside `evm_gen8_fee_accruals`, and route-run row selection in evmGen8FeeRouting.ts;
   (e) swap-kind field handling (conversion = no trade/accrual row); (f) CREATE2 salt mining in the create-signer API (coin < WDOGE);
   (g) app Barkswap trade client (SwapRouter exactInputSingle/multicall+unwrap, QuoterV2 with `deployer`, sell limitSqrtPrice) — no
   Algebra ABIs exist in frontend yet; (h) L1 data-fee budget via `L1GasPriceOracle 0x5300…0002 getL1Fee` in the rehearsal;
   (i) market_trades_v label for a Barkswap execution_source; (j) side-pool venue CHECK value; (k) operator key public address
   (not in repo); (l) the D2 `creatorBondingBps` on a Bark launcher vs hook FeeConfig struct (IMwzLaunchHook FeeConfig reuse?).
8. **Gate-1 baseline is stale** (pre-merge). New baseline = release/evm-gen8 e5abd04bc.
9. Gen-8 anvil-backed frontend tests (evmGen8CreateAuthorization, evmGen8Client.chain) silently skip today; vendoring
   artifacts-gen8 changes their behaviour (may start running and need anvil/RPC).
10. Chain-list guard: exception entries are exact-line patterns; any edit to those lines must update the JSON in the same commit.
11. Barkswap admin can change plugin/config/community fee — tests must cover; the `restore` flow is new.

# DogeOS Foundation + Launch Implementation Plan
**Spec:** docs/templar/specs/2026-10-10-dogeos-foundation-launch-design.md
**Profile note:** All code tasks are implementation-tier (opus). They touch money-adjacent launch paths and many hand-kept lists, where a missed branch silently reads the wrong chain, so none qualify for the mechanical-edit tier. t4 and t34 (audit diffs) and the final branch review are review-tier. t28 and t29 are founder-gated: the controller stops and asks for an explicit go before running them, and never runs them on its own. Tasks t10–t22 are independent of the contract tasks and may run in parallel batches, except t13, t19 and t35, which need t30's MuchFi facts.

## Global constraints

- **Chain:** DogeOS Chikyū testnet, chain id `6281971`, native DOGE (18 decimals), RPC `https://rpc.testnet.dogeos.com`, explorer `https://dogeos-testnet.l2scan.co` (Etherscan-style `/api`), WDOGE `0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE`. Spec "Verified chain facts".
- **MuchFi (graduation venue, spec §1):** Factory `0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B`, PoolDeployer `0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348`, NPM `0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5`, SmartRouter `0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB`, SwapRouter `0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c`, QuoterV2 `0x5DE1Ea595653419f295511DEb781b98387a77cc2`. Fee tier 10000 / tick spacing 200. Pool callbacks `muchfiV3SwapCallback` / `muchfiV3MintCallback`; `slot0().feeProtocol` is `uint32`. Nothing Uniswap is deployed on Chikyū; `scripts/lib/dogeosV3Stack.ts` is local-test only.
- **Bytecode:** solc 0.8.24, the existing `hardhat.config.ts` compiler settings (optimizer runs 1, viaIR, `bytecodeHash: none`, default evm target paris). Never add a DogeOS compiler profile. Never edit any `contracts/gen7/*`, `contracts/integrations/*`, or any existing contract. The only new Solidity is the DOGE/USD testnet oracle (t3) and the MuchFi variants under `contracts/dogeos/muchfi/` (t31–t33: graduation adapter, position locker, creator vault, and `MuchfiPoolSwap`, a copy of `contracts/EvmGenPoolSwap.sol` with only the `uint32` slot0 interface changed), each a minimal diff from its original (callback name, `slot0` uint32, fee 10000/200 where the original hard-codes 3000/60) with no other logic change.
- **CREATE/BUY/SELL:** transaction flow and shape stay unchanged. `frontend/src/lib/evmGen7Wiring.test.mjs`, `frontend/src/lib/evmGen6Wiring.test.mjs` and `test/evmgen7-core*.spec.ts` stay green and are never re-pinned.
- **Do not change unrelated logic.** Every change on an existing chain list or branch only *adds* 6281971 (or a DogeOS branch). Behaviour for 56, 97, 101, 4663 and 46630 stays byte-for-byte the same. Never add 6281971 to `isRobinhoodChainId` / `ROBINHOOD_CHAIN_IDS` sets, because they also drive ETH symbols and stock logic. Use `isDogeosChainId` plus explicit branches.
- **Never fall back to BSC/BNB/ETH for 6281971.** RPC, start block, symbol and USD price each get an explicit DogeOS branch. Spec §4.
- **Named exceptions** (6281971 deliberately not added):
  - the hard-coded indexer `ACTIVE` lists and mainnet-only sets
  - stock/quote/Robinhood-stock paths and the quote catalog plus its admin/verification
  - imports and import-fee jobs, creator-choice, payout watchdog, LP-harvest crank, league crank
  - recruiter rails and payouts (except the testnet *exclusion* in `dev-fix/recruiter-payouts.js`, where 6281971 is added so testnet rows stay out of payouts)
  - finance fee-routing registry (`lib/financeFeeRoutingEvm.js:19,112`)
  - arena, battles, leagues, MWL, votes, vote treasury, war pools and tournaments: sub-project 3
  - Robinhood-only features (beat-the-market, local scanner, RH dev scripts)

  An exception means "may exclude". Pre-existing 6281971 entries stay as they are. Spec §6.
- **Keys:** `config/dogeos.local` only (gitignored), with `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY`, `DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY` and `DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY`.
  - Addresses: deployer `0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8`, updater `0x7dBDFe829309B4170346CF7e4496094CD126E9c1`, keeper `0xb07B9E70D1759Fc42103458039AaE2413026B078`.
  - Never read, print, log or commit a private key. No fallback to `DEPLOYER_PK` / `PRIVATE_KEY_DEPLOY`.
  - Route authority = a **new DogeOS key**, `DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY` in `config/dogeos.local`, address `0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF` (spec §1 Route authority). Not `0x2501…Bde0`: the TEST API holds no key for it. The route-authority address is a deploy parameter, passed as public `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS`, never derived by reading the key in scripts.
- **No transaction on Chikyū** and no staging DB write without the founder's explicit go (t28, t29). No production DB writes ever. Local Hardhat (31337) and read-only fork runs are fine.
- **Indexer:** `CONFIRMATIONS` stays global 1. `getLogs` ≤ 10,000 blocks per call for 6281971.
- **Commits:** conventional commits `type(scope): description`, scope `dogeos`, on branch `feat/dogeos-testnet`. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `package-lock.json` drift unrelated to the task, `HybridSetup.txt`, `build-plan.md` or `config/*.local`.
- **Verify commands:**
  - root `npx hardhat test <spec>`
  - frontend/API `node --test <file>` run from `frontend/` (some need `--import ./api/campaigns/upsert.test.register.mjs`, as the neighbouring package scripts show)
  - indexer `npx --prefix realtime-indexer tsx --test <file>` and `npm --prefix realtime-indexer run build`
- **Facts over theories.** If a task finds the code differs from this plan or the spec, stop and report. Do not improvise.

## Tasks

### Task 1: Install worktree dependencies            [id: t1]
**Depends-on:** none
**TDD:** waived (dependency install, no behaviour)
**Files:** none committed (`frontend/node_modules`, `realtime-indexer/node_modules`, `tools/robinhood-testnet-infra/node_modules`)
- Run `npm ci --prefix frontend` and `npm ci --prefix realtime-indexer`. `tools/robinhood-testnet-infra` has no lockfile (its versions are pinned exactly in package.json), so use `npm install --prefix tools/robinhood-testnet-infra --no-package-lock`.
- Do not commit lockfile changes. If `npm ci` rewrites a lockfile, stop and report.
- Root `node_modules` already exists.
**Verify:** `ls frontend/node_modules/esbuild realtime-indexer/node_modules/tsx tools/robinhood-testnet-infra/node_modules/@uniswap/v3-core >/dev/null && git status --short -- '*package-lock.json'` → listings succeed and git prints no `package-lock.json` changes caused by this task (the pre-existing root `package-lock.json` drift is not ours; leave it untouched).

### Task 2: Hardhat `dogeosTestnet` network, no-fallback key, L2Scan verify config            [id: t2]
**Depends-on:** none
**TDD:** required
**Files:** `scripts/lib/dogeosNetwork.ts` (new), `hardhat.config.ts`, `hardhat.dogeos-verify.config.ts` (new), `test/DogeosNetworkConfig.spec.ts` (new)
- Spec §1 Keys.
- `scripts/lib/dogeosNetwork.ts` exports pure resolvers:
  - `resolveDogeosTestnetRpcUrl(env)`, defaulting to `https://rpc.testnet.dogeos.com`
  - `resolveDogeosTestnetDeployerKey(env)`, which reads only `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY`, ignores `DEPLOYER_PK` / `PRIVATE_KEY_DEPLOY`, and returns `""` when it is missing
  - `assertDogeosKeyPresentWhenSelected(argv, key)`, which throws `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY missing` when `--network dogeosTestnet` is on argv and the key is empty
- `hardhat.config.ts` changes:
  - add `dotenv.config({ path: path.resolve(__dirname, "config/dogeos.local") })` after the `config/bnb.local` line (`:11`)
  - add the network `dogeosTestnet: { url, accounts: key ? [key] : [], chainId: 6281971 }`
  - the import of the resolvers and a config-load call `assertDogeosKeyPresentWhenSelected(process.argv, key)` (spec §1: a missing key fails the run)
  - nothing else
- `hardhat.dogeos-verify.config.ts` extends the base config. It adds `etherscan.customChains` (`network: "dogeosTestnet"`, chainId 6281971, `apiURL: https://dogeos-testnet.l2scan.co/api`, `browserURL: https://dogeos-testnet.l2scan.co`) and an object-form `apiKey` for `dogeosTestnet` only. The shared config's `etherscan` stays unchanged, so BSC verify is not touched.
- Tests:
  - the resolvers ignore `DEPLOYER_PK`
  - the missing-key throw
  - the network entry's chainId
  - `hre.config.etherscan.customChains` deep-equals `[]` and `apiKey` equals the value the base config resolves (`explorerApiKey`), so the shared config is untouched. Don't re-import the config inside the test.
**Verify:** `npx hardhat test test/DogeosNetworkConfig.spec.ts` → all passing; `npx hardhat --config hardhat.dogeos-verify.config.ts verify --list-networks | grep -i dogeosTestnet` → one line with 6281971

### Task 3: DOGE/USD testnet oracle contract            [id: t3]
**Depends-on:** none
**TDD:** required
**Files:** `contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol` (new), `test/DogeosTestnetDogeUsdOracle.spec.ts` (new)
- Spec §1 "New contract".
- Copy `contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol` with exactly these changes:
  - chain constants → `DOGEOS_TESTNET_CHAIN_ID = 6281971`
  - no mainnet-forbid branch, because DogeOS has no mainnet id; the constructor refuses every chain except 6281971, or 31337 with `allowLocalRehearsal`
  - `description = "DOGE / USD - DogeOS Chikyu Testnet 6281971"`
  - `SOURCE_VERSION = "mwz-dogeos6281971-doge-usd-aggregator-v1"`
- Everything else stays line-for-line: the single immutable updater, positive answers, monotonic rounds, 8 decimals, the AggregatorV3 reads.
- Tests, modelled on `test/RobinhoodTestnetInfrastructureBootstrap.spec.ts:186-201`:
  - `WrongChain` on 31337 without the flag
  - deploys with the flag
  - `UnauthorizedUpdater`
  - `InvalidAnswer` on 0 and −1
  - rounds 1→2, `answeredInRound == roundId`
  - `latestRoundData` and `getRoundData`, `RoundUnavailable`
  - `decimals() == 8`
  - `GraduationOracle(feed, 3600).nativeUsdPrice()` reads it, and reverts `StalePrice` after `evm_increaseTime(3601)`
**Verify:** `npx hardhat test test/DogeosTestnetDogeUsdOracle.spec.ts` → all passing; `git diff --stat 6c5ca159a -- contracts/gen7 contracts/integrations contracts/robinhood` → empty

### Task 4: Oracle audit diff (gate 2)            [id: t4]
**Depends-on:** [t3]
**TDD:** waived (written audit document)
**Files:** `docs/dogeos/oracle-audit-diff.md` (new)
- Spec gate 2. Review-tier.
- Produce `diff -u contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol` and explain every hunk.
- Then state for the oracle, per the CLAUDE.md audit rule:
  - reentrancy (no external calls)
  - checks-effects-interactions ordering
  - reachable states (constructor / updater / readers)
  - overflow (`uint80` round id)
  - griefing (updater key compromise → price manipulation bounded by the GraduationOracle staleness window; mitigations)
  - the trust model: the updater is a hot key, and what a wrong price does to the graduation target
- Conclude PASS or FAIL. FAIL blocks t9.
**Verify:** `grep -cE "^## (Diff|Reentrancy|CEI|Reachable states|Overflow|Griefing|Trust model|Verdict)" docs/dogeos/oracle-audit-diff.md` → `8`, and `grep -E "^Verdict: PASS" docs/dogeos/oracle-audit-diff.md` → one line

### Task 5: Canonical Uniswap V3 stack deploy library on WDOGE            [id: t5]
**Depends-on:** [t1]
**TDD:** required
**Files:** `scripts/lib/dogeosV3Stack.ts` (new), `test/DogeosV3Stack.spec.ts` (new)
- Spec §1, the "local tests only" paragraph under "MuchFi variant contracts".
- `deployDogeosV3Stack({ signer, wrappedNative, chainId, allowLocalRehearsal })` deploys, from the pinned `tools/robinhood-testnet-infra` artifacts, the same shape as `scripts/deploy-robinhood-testnet-infrastructure.ts:122-150`:
  - UniswapV3Factory
  - NFTDescriptor (library)
  - NonfungibleTokenPositionDescriptor(W, bytes32 "DOGE"), linked
  - NonfungiblePositionManager(factory, W, descriptor)
  - SwapRouter02(0x0, factory, npm, W)
  - QuoterV2(factory, W) from v3-periphery, always deployed (spec §1 includes the quoter)
- It returns the addresses, including the quoter. The quoter goes into the manifest (t6) and the env blocks (t24, `VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971`). It throws unless `chainId === 6281971`, or `31337 && allowLocalRehearsal`.
- It asserts that fee 3000 has spacing 60, as `assertFeeTierSpacing` does.
- Tests on 31337 with a local WETH9-style stand-in for WDOGE (`MockWETH9`):
  - chain refusal on 31337 without the flag
  - deploy succeeds
  - create a pool, initialize it and check that `slot0()` is readable
  - one `exactInputSingle` swap through SwapRouter02 with native wrapped via the stand-in
- Skip with `ctx.skip()` when `tools/robinhood-testnet-infra/node_modules` is absent, using the pattern at `test/RobinhoodTestnetInfrastructureBootstrap.spec.ts:18-23`.
**Verify:** `npx hardhat test test/DogeosV3Stack.spec.ts` → all passing, 0 pending

### Task 30: Chikyū fork config + MuchFi fork facts            [id: t30]
**Depends-on:** [t2]
**TDD:** required
**Files:** `hardhat.dogeos-testnet-fork.config.ts` (new), `test/helpers/muchfiFork.ts` (new), `test/MuchfiFork.facts.spec.ts` (new)
- Spec §1 "Graduation venue: MuchFi CLMM". Fork tests are the only way to exercise MuchFi (no source).
- Fork config: a copy of `hardhat.rh-gen7-testnet-fork.config.ts` with chainId 6281971, `chains: { 6281971: { hardforkHistory: {...} } }`, url `DOGEOS_TESTNET_FORK_RPC || https://rpc.testnet.dogeos.com`, `DOGEOS_FORK_BLOCK` (default: head − 16), **`blockGasLimit: 10_000_000`**, funded local accounts. No private key from `config/dogeos.local` is used on the fork.
- `test/helpers/muchfiFork.ts` exports the MuchFi addresses (global constraints), minimal ABIs, and a `skipUnlessChikyuFork(ctx)` guard (skip when not running under the fork config).
- `MuchfiFork.facts.spec.ts` pins on the fork, with evidence in assertions:
  - `factory.feeAmountTickSpacing(10000) == 200` and `(3000) == 0`
  - NPM, SmartRouter, SwapRouter and QuoterV2 `WETH9()` equal the official WDOGE; NPM `factory()` equals the MuchFi factory
  - a 1% pool created via `NPM.createAndInitializePoolIfNecessary` for a fresh test ERC-20 has `slot0().feeProtocol` decoding as uint32, and a uint8 decode reverts
  - a direct `pool.swap` from a test contract implementing only `uniswapV3SwapCallback` reverts, and one implementing `muchfiV3SwapCallback` succeeds (proves the callback name)
  - the pool `Swap` event signature/topic0 from a real swap log (recorded for t19)
  - SmartRouter `exactInputSingle` (no-deadline struct) swaps native via WDOGE
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiFork.facts.spec.ts` → all passing, 0 pending

### Task 31: MuchFi graduation adapter variant            [id: t31]
**Depends-on:** [t30]
**TDD:** required
**Files:** `contracts/dogeos/muchfi/MuchfiV3NativeGraduationAdapter.sol` and its pool-repair base (new), `test/MuchfiGraduationAdapter.fork.spec.ts` (new)
- Spec §1 "MuchFi variant contracts" item 1.
- Derive from `contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol` + `RobinhoodV3PoolRepair.sol`. Prefer inheritance/override where the originals allow it without editing them; otherwise copy into `contracts/dogeos/muchfi/`. Changes only: `muchfiV3SwapCallback` instead of `uniswapV3SwapCallback` (same body), a `slot0` interface with `uint32 feeProtocol`, `POOL_FEE = 10000`, `TICK_SPACING = 200`, and every full-range bound for spacing 200: `FULL_RANGE_LOWER/UPPER` (±887200) **and** the matching `MIN/MAX_FULL_RANGE_SQRT` bounds (`RobinhoodV3PoolRepair.sol:82-84`), computed with `@uniswap/v3-core` `TickMath.getSqrtRatioAtTick(±887200)` and pinned by a test. It still exposes `v3Factory()`, `WETH()`, `POOL_FEE()` and `liquidityKind() == 2` (the keeper and factory read them).
- Fork tests (t30 helpers; test factory/campaign stand-ins as the existing adapter specs use): graduation into a fresh 1% MuchFi pool; graduation into a pool pre-created at a wrong price (the repair path ends at the target price); the position NFT ends in the locker; no residual native/WDOGE/MEME in the adapter.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiGraduationAdapter.fork.spec.ts` → all passing; `git diff --stat 6c5ca159a -- contracts/gen7 contracts/integrations contracts/PermanentV3PositionLocker.sol contracts/CreatorRewardsVaultV2.sol contracts/EvmGenPoolSwap.sol` → empty

### Task 32: MuchFi position locker variant            [id: t32]
**Depends-on:** [t30]
**TDD:** required
**Files:** `contracts/dogeos/muchfi/MuchfiPoolSwap.sol` (new), `contracts/dogeos/muchfi/MuchfiV3PositionLocker.sol` (new), `test/MuchfiPositionLocker.fork.spec.ts` (new)
- Spec §1 "MuchFi variant contracts" item 2.
- `MuchfiPoolSwap.sol`: a copy of `contracts/EvmGenPoolSwap.sol` (which declares and decodes `uint8 feeProtocol` at :36 and :130) whose only change is the `uint32 feeProtocol` slot0 interface. `EvmGenPoolSwap.sol` itself is not edited.
- From `contracts/PermanentV3PositionLocker.sol`: `muchfiV3SwapCallback` instead of `uniswapV3SwapCallback` (same body), and `MuchfiPoolSwap` instead of `EvmGenPoolSwap` (`:408-422`). Nothing else. Same inheritance-first rule as t31.
- Fork tests: lock a MuchFi 1% position; collect LP fees after swaps (MuchFi's 32% protocol cut taken at the pool, the remainder reaching the locker); the `sellMemeForPaired` swap path works via `muchfiV3SwapCallback`; the revenue split to the router matches the original; the NFT can never leave.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiPositionLocker.fork.spec.ts` → all passing; `git diff --stat 6c5ca159a -- contracts/EvmGenPoolSwap.sol contracts/PermanentV3PositionLocker.sol` → empty

### Task 33: MuchFi creator vault variant            [id: t33]
**Depends-on:** [t30, t32]
**TDD:** required
**Files:** `contracts/dogeos/muchfi/MuchfiCreatorRewardsVault.sol` (new), `test/MuchfiCreatorRewardsVault.fork.spec.ts` (new)
- Spec §1 "MuchFi variant contracts" item 3.
- From `contracts/CreatorRewardsVaultV2.sol`: `muchfiV3SwapCallback` instead of `uniswapV3SwapCallback` (same body), and `MuchfiPoolSwap` (from t32) instead of `EvmGenPoolSwap` (`:645-711`). Nothing else. Same inheritance-first rule.
- Fork tests: `dexKind` V3 with the MuchFi factory and fee 10000; a buyback swap through a MuchFi 1% pool; the existing caps/impact checks still bind; creator claim is unaffected.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiCreatorRewardsVault.fork.spec.ts` → all passing

### Task 34: MuchFi variants audit diffs (gate 2)            [id: t34]
**Depends-on:** [t31, t32, t33]
**TDD:** waived (written audit documents)
**Files:** `docs/dogeos/muchfi-variants-audit-diff.md` (new)
- Spec gate 2. Review-tier. Same format as `docs/dogeos/oracle-audit-diff.md`. Per variant:
  - a `diff -u --strip-trailing-cr` against its original (or the override set when inherited), every hunk explained
  - Reentrancy, CEI, Reachable states, Overflow, Griefing
  - Trust model: MuchFi's unverified source, the owner-settable protocol fee, and callback-caller validation against the MuchFi factory/PoolDeployer
  - a per-variant `Verdict: PASS|FAIL`
- Any FAIL blocks t6.
**Verify:** `grep -cE "^Verdict: PASS" docs/dogeos/muchfi-variants-audit-diff.md` → `4` (adapter, locker, vault, `MuchfiPoolSwap`); `grep -c "^Verdict: FAIL" docs/dogeos/muchfi-variants-audit-diff.md` → `0`

### Task 6: Fresh gen-7 stack deploy + wiring library            [id: t6]
**Depends-on:** [t3, t34]
**TDD:** required
**Files:** `scripts/lib/dogeosGen7Stack.ts` (new), `test/DogeosGen7Stack.fork.spec.ts` (new)
- **MuchFi revision:** no DEX is deployed.
  - D1 = MuchFi factory, D4 = MuchFi NPM, D5 = MuchFi SmartRouter (global constraints).
  - G2 = `MuchfiV3NativeGraduationAdapter` (t31).
  - G3 = `MuchfiV3PositionLocker` (t32), via `deployFactoryWithLocker`. Extend that helper only if it hard-codes the locker contract name, without changing its behaviour for existing callers.
  - F2 = `MuchfiCreatorRewardsVault` (t33), with dexFactory = MuchFi factory.
  - a DogeOS-local fee-tier check (10000 → 200) replaces `assertFeeTierSpacing`, whose RH helper hard-codes 3000/60 (`scripts/deploy-robinhood-quote-generation.ts:72-79`).
  - The table below otherwise applies.
- Spec §1 "complete fresh set", "Route authority", "Deploy outputs".
- `deployDogeosGen7Stack(params)` implements this ordered table:
  - D1, D4, D5: MuchFi addresses (no deploy)
  - O1: the t3 oracle, initial answer from the param
  - O2: `GraduationOracle(O1, 3600)`
  - V1–V5: `TreasuryVaultV2`, `CharityTreasury`, `MonthlyLeagueTreasury`, `RecruiterRewardsVault`, `ProtocolRevenueVault`, with constructor args as in `scripts/deploy-robinhood-current-stage.ts:155-199`
  - F1–F5: `TreasuryRouterV4(A, V1, V3, 3600)`, `CreatorRewardsVaultV2(A, F1, W, 2, D1, 86400)`, `RewardDistributor` (holders), `CommunityRewardsVault(A, F1)`, `RewardDistributor` (airdrop)
  - R1, R2
  - G1: `LaunchCampaignGen7` implementation
  - G2: `RobinhoodV3NativeGraduationAdapterV2(D1, D4, W, A)`
  - G3/G4 via `scripts/lib/deployFactoryWithLocker.ts`: `PermanentV3PositionLocker` + `LaunchFactoryGen7(G2, F1, G1, O2, G3)`
  - G5: `LaunchTokenDeployer`, via `wireGenerationCreatePath`
  - S1: `RobinhoodV3NativeSwapAdapterV2(D5, W)`
- Then the wiring in this order, every call from A:
  1. Fee batch: `scripts/deploy-evm-treasury-router-v4.ts` `batchACalls` minus the old-factory and `CommunityRewardsVault.setRouter` calls. Caps are re-scaled to DOGE from `TESTNET_CAPS` (`scripts/deploy-robinhood-testnet-gen6-fees.ts:48-55`) via a `caps` param.
  2. Airdrop pot: F4 is the fresh main vault; F5 distributor; `planGen7AirdropCalls` with an explicit `airdropCap` param. Do not call `resolveGen7AirdropSetup`'s gen-6 lookup.
  3. Pre-asserts: `assertRouterCanServeStrictRouting(F1)`, `assertFeeTierSpacing(D1)`.
  4. Verify `FACTORY_GENERATION()==7`, `CAMPAIGN_GENERATION()==6`, `liquidityKind()==2`, `feeRecipient()==F1`.
  5. `G4.setRouteAuthority(routeAuthority)`.
  6. `G4.setRegistries(R1, R2)`.
  7. `G2.setCampaignFactoryOnce(G4)`.
  8. `R1.setLaunchRecorder(G4, true)`. Check whether `RiskRegistry` needs a recorder: read the contract and do what it requires.
  9. `wireGenerationCreatePath` (G5, `setNativeGraduationAdapter`, `setLaunchTokenDeployer`, `F2.setFactoryOnce`).
  10. `F1.setAuthorizedLpLocker(G3, true)`, then `F1.setPrimaryLpLocker(G3)`.
  11. `G4.setCreatePaused(true)`, then assert `createPaused()==true && live()==false`.
  12. Record `curvesAtDeploy` for 30k/50k/150 USD.
- **Never** call `enableLive` or `lockSecurityDefaults`. Exclude every reuse/supersede/stock/mainnet step listed in the RH gen-7 script.
- Chain guard: 6281971 only (the fork reports 6281971). The deployer must equal `params.admin`.
- `writeDogeosManifest(path, record)` writes `deployments/dogeos/testnet.json` in the shape described in spec §1. Mirror the `testnet.gen7.json` keys, replacing `reused` with `dex`, `oracle`, `registries` and `vaults`, adding `nativeSwapAdapter`, keeping the `deployed.LaunchFactory` alias, and leaving out stock keys and `liveRouter` / `liveVaultPinnedTo` / `supersedesForCreate`.
- Tests on the Chikyū fork (t30 config, real WDOGE and MuchFi, routeAuthority = a test signer) assert every wiring read-back above, plus `createPaused && !live`, and that no `enableLive` was sent: scan the deploy receipts for that selector.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/DogeosGen7Stack.fork.spec.ts` → all passing

### Task 7: Full lifecycle on the fresh stack (Chikyū fork)            [id: t7]
**Depends-on:** [t6]
**TDD:** required
**Files:** `test/DogeosGen7Lifecycle.fork.spec.ts` (new)
- Spec gate 3 (behaviour proven locally first).
- On the Chikyū fork (t30 config), using `deployDogeosGen7Stack`:
  1. owner `enableLive` and unpause create (test-only, local)
  2. a route-authorized create via `createCampaignAuthorized`, signed by the test route authority as `frontend/api/dev-fix/routeAuthorizationSigner.js` does, with the `$150` target `TEST_GRADUATION_USD_THRESHOLD`
  3. buys from **5 distinct buyer signers**
  4. a sell
  5. buys until Pending
  6. `graduate()` called by a non-deployer keeper signer
  7. assert the MuchFi 1% pool exists on the MuchFi factory and the position is locked in G3
  8. a post-graduation swap through S1 (MuchFi SmartRouter)
  9. LP fees collected through G3 after swaps (MuchFi's 32% cut taken), and the revenue split reaches F1
  10. creator claim from the creator vault
- Assert balances and events at each step.
- Model the authorized-create and buy calls on `test/evmgen7-core-lifecycle.spec.ts` and `scripts/test-robinhood-testnet-gen7-lifecycle.ts`. Do not change any create/buy/sell call shape.
- If creator claim needs the creator-choice operator, stop and report. That is a spec decision.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/DogeosGen7Lifecycle.fork.spec.ts` → all passing

### Task 8: Deploy and verify entrypoints with broadcast guards            [id: t8]
**Depends-on:** [t2, t6]
**TDD:** required
**Files:** `scripts/deploy-dogeos-testnet.ts` (new), `scripts/verify-dogeos-testnet.ts` (new), `scripts/activate-dogeos-testnet.ts` (new), `config/verification/dogeos-testnet-contracts.json` (generated by deploy; not committed until t28), `scripts/dogeos-testnet-deploy-guards.test.mjs` (new), `package.json` (new scripts only)
- Spec §1 Deploy outputs, gate 4.
- `deploy-dogeos-testnet.ts`:
  - refuses unless chainId is 6281971 and the network is `dogeosTestnet`, or the Hardhat fork of Chikyū (`hardhat.dogeos-testnet-fork.config.ts`, which reports 6281971). There is no 31337 path: the t6 library and the oracle are 6281971-only.
  - refuses unless `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO`, following the broadcast-token pattern in `scripts/robinhood-testnet-infrastructure-authority.test.mjs`
  - on Chikyū, refuses unless the signer address equals `0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8` (on the in-process fork the fork's first signer is the deployer/admin; the broadcast token is still required)
  - takes the route authority from public `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS` and refuses if it is missing, the zero address, or equal to the deployer, updater or keeper address
  - takes the initial DOGE/USD answer from Binance `DOGEUSDT` at run time, converted to 8 decimals, and refuses if ≤ 0
  - calls `deployDogeosGen7Stack`, then writes the manifest and the verification JSON (`chains["6281971"]`, the `verificationEntries` shape from `scripts/deploy-robinhood-gen7-generation.ts:561-581`)
- `verify-dogeos-testnet.ts` runs with `--config hardhat.dogeos-verify.config.ts`. It verifies our contracts and tolerates "already verified". MuchFi contracts are external and are not verified by us.
- `package.json`: add `deploy:dogeos-testnet` and `verify:dogeos-testnet`. Do not rename existing scripts (`test/PackageScripts.spec.ts`).
- `activate-dogeos-testnet.ts` (used only in t29) has the same network, broadcast-token and signer guards. It reads the factory from `deployments/dogeos/testnet.json`, refuses unless `factory.routeAuthority()` equals `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS` and the oracle is fresh (`GraduationOracle.nativeUsdPrice()` does not revert), then calls `enableLive()` and `setCreatePaused(false)`, and asserts `live()==true && createPaused()==false`.
- Node tests cover every refusal path for deploy and activate: wrong network, missing token, wrong signer, missing/zero/colliding route-authority address, bad price, activate with a mismatched route authority.
**Verify:** `node --test scripts/dogeos-testnet-deploy-guards.test.mjs` → all pass; `npx hardhat test test/PackageScripts.spec.ts` → passing

### Task 36: Upstream merge + DogeOS on the open creator rules            [id: t36]
**Depends-on:** [t7, t8]
**TDD:** required
**Files:** merge of `origin/build/cross-chain-stabilization-rh-base` into `feat/dogeos-testnet` (controller), then `frontend/api/dev-fix/security.js`, `scripts/lib/dogeosGen7Stack.ts`, `test/DogeosGen7Stack.fork.spec.ts`, `test/DogeosGen7Lifecycle.fork.spec.ts`, `scripts/dogeos-chain-list-exceptions.json`, related tests
- Spec §1 Registries (founder decision 2026-10-10, upstream `dea912b0c`).
- The controller merges the 9 upstream commits first (expected small conflicts in `route-auth.js`, `UpvoteDialog.tsx`, `launchpadClient.ts`) and resolves them keeping both sides.
- `OPEN_CREATOR_CHAIN_IDS` (`frontend/api/dev-fix/security.js`) gains 6281971; test that the DogeOS preflight skips cooldown/live-limit/cluster-size but keeps restricted/manual-review.
- `deployDogeosGen7Stack`: no CreatorRegistry. `G4.setRegistries(address(0), R2)`; no `setLaunchRecorder`; the manifest records `registries.creator: null`; read-back asserts `creatorRegistry() == 0x0`. Update the t6/t7 fork specs (tx count changes).
- `BASE_FEE_PRICED_CHAIN_IDS` (`frontend/src/lib/evmGasHeadroom.mjs`, upstream): 6281971 is a named guard-test exception with reason (DogeOS legacy txs pay the full gas price; headroom would overpay; base fee was flat on Chikyū). Revisit if the canary sees base-fee refusals.
- Re-run the t23 guard test and the touched suites.
**Verify:** `node --test scripts/dogeos-chain-list-guard.test.mjs` → pass; the DogeOS security preflight test → pass; `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/DogeosGen7Stack.fork.spec.ts` → pass, then `test/DogeosGen7Lifecycle.fork.spec.ts` → pass (run separately)

### Task 37: Create readiness without CreatorRegistry / vote treasury on DogeOS            [id: t37]
**Depends-on:** [t13, t24]
**TDD:** required
**Files:** `frontend/src/lib/bnbContracts.ts`, a DogeOS readiness test (new or extend `frontend/src/lib/dogeosLaunchPath.test.mjs`)
- Spec §1 Registries (no CreatorRegistry, founder decision 2026-10-10) and scope (vote treasury is sub-project 3).
- `commonRequiredContracts` (`bnbContracts.ts:144-156`) treats `creatorRegistry` and `voteTreasury` as required for every EVM chain, and `Create.tsx:382` gates direct deploy on that readiness. For 6281971 only (via `isDogeosChainId`), neither is required; every other chain's required set stays byte-for-byte. The readiness still requires every other contract.
- Tests: with the DogeOS env set and no creator registry / vote treasury, readiness is `ready` for 6281971; 56/97/4663/46630 still require both; Create's direct-deploy gate follows.
**Verify:** `cd frontend && node --test src/lib/dogeosLaunchPath.test.mjs src/lib/evmGen7Wiring.test.mjs` → pass; tsc error count ≤ 88

### Task 9: Chikyū fork rehearsal + DOGE budget (gate 3)            [id: t9]
**Depends-on:** [t4, t7, t8, t26, t27, t34, t36, t37]
**TDD:** waived (rehearsal run against a read-only fork; behaviour already covered by t6/t7)
**Files:** `scripts/rehearse-dogeos-fork.ts` (new), `reports/dogeos/fork-rehearsal.json` (new), `package.json` (add `rehearse:dogeos-fork` only)
- Spec gate 3.
- Uses the t30 fork config (`hardhat.dogeos-testnet-fork.config.ts`).
- The rehearsal:
  1. impersonate the deployer on the fork with `hardhat_setBalance` (no real key needed)
  2. run the `deploy-dogeos-testnet` logic with the real WDOGE. The route authority is a **throwaway local signer**, because signing authorizations needs a private key and impersonation can't sign typed data. The real route-authority address is only checked in t8's guard tests and t28.
  3. that throwaway signer signs the `createCampaignAuthorized` request in step 4
  4. run the t7 lifecycle with 5 buyer accounts and a keeper account
- It records per transaction the gas used and the calldata/raw-tx size. For each transaction it calls the **live** RPC `L1GasPriceOracle(0x5300000000000000000000000000000000000002).getL1Fee(bytes)` (read-only `eth_call`) on the signed-equivalent serialized transaction.
- It writes `reports/dogeos/fork-rehearsal.json` with: total deploy DOGE (L2 + L1), per-step canary DOGE including the buys needed for $150 at the rehearsal's oracle price, the max single-transaction gas (must be < 10M), and the required balances for deployer, updater and keeper.
**Verify:** `npx hardhat --config hardhat.dogeos-testnet-fork.config.ts run scripts/rehearse-dogeos-fork.ts` → exits 0, prints `REHEARSAL OK`; `node -e "const r=require('./reports/dogeos/fork-rehearsal.json');if(!(r.maxTxGas<10e6&&r.lifecycle.graduated&&r.lifecycle.creatorClaimed))process.exit(1)"` → exit 0

### Task 10: Frontend chain identity, registry, wallet params            [id: t10]
**Depends-on:** [t1]
**TDD:** required
**Files:** `frontend/src/lib/chainConfig.ts`, `frontend/src/lib/chainRegistry.ts`, `frontend/src/lib/evmChainAdapter.ts`, `frontend/src/lib/walletConnect.ts`, `frontend/src/hooks/useWallet.ts`, `frontend/src/lib/chainConfig.test.mjs`, `frontend/src/lib/dogeosChainIdentity.test.mjs` (new)
- Spec §2.
- `chainConfig.ts`:
  - `SupportedChainId` (:12), `SUPPORTED_CHAIN_IDS` (:19) and `isSupportedChainId` (:53) gain 6281971
  - new `DOGEOS_TESTNET_CHAIN_ID` and `isDogeosChainId` beside :18
  - `isEvmChainId` includes it
  - `getNativeSymbol` returns `DOGE`, with no BNB fallthrough
  - `getPublicRpcUrl/Urls` DogeOS default `https://rpc.testnet.dogeos.com`, with no BSC-testnet fallthrough (:303-404)
  - `getExplorerTxBase` → L2Scan (:530)
  - a `getChainParams` DogeOS block (hex `0x5fdaf3`)
  - `CHAIN_LABELS` / `getChainLabel` → "DogeOS Chikyū Testnet"
- `chainRegistry.ts`: `ChainKey` gets `dogeos-testnet`, plus an entry like :110-126 with family evm, networkClass test, runtime staging, `publicRpcEnvKey: "VITE_PUBLIC_RPC_6281971"`, explorer L2Scan, nativeAsset DOGE/18, `deploymentManifest: "deployments/dogeos/testnet.json"`, and adapters/`supportsCreation` as the RH testnet entry.
- `evmChainAdapter.ts`: the union (:3), `KNOWN_EVM_CHAIN_IDS` (:23; not ACTIVE :29), `walletChainName`, `nativeCurrencyName` and `getEvmChainLabel`.
- `walletConnect.ts` `rpcMapFor` (:63); the `useWallet.ts:401` cast.
- Tests:
  - `isDogeosChainId`
  - symbol DOGE
  - the RPC default is DogeOS, never BSC
  - explorer
  - wallet params (chainId hex, DOGE/18, L2Scan)
  - registry entry
  - every pre-existing chain's outputs equal before/after, via a table snapshot test over 56/97/101/4663/46630
**Verify:** `cd frontend && node --test src/lib/dogeosChainIdentity.test.mjs src/lib/chainConfig.test.mjs` → all pass

### Task 11: Frontend feed isolation and chain selection            [id: t11]
**Depends-on:** [t10]
**TDD:** required
**Files:** `frontend/src/lib/feedChainConfig.ts`, `frontend/src/lib/activeWalletChain.ts`, `frontend/src/lib/embedChart.ts`, `frontend/src/lib/marketIdentity.ts`, `frontend/src/components/common/ChainFeedSwitch.tsx`, `frontend/src/components/home/DraftCampaignGrid.tsx`, `frontend/src/lib/searchClient.ts`, `frontend/src/lib/feedChainIsolation.test.mjs`
- Spec §2 feed isolation.
- `getBnbCampaignFeedChainIds` (:76-89) returns `[6281971]` when DogeOS is selected, never the BNB list. `resolveFeedChainId` (:101-109) and `getFeaturedFeedChainId` (:129-137) honour an explicit DogeOS selection.
- `activeWalletChain.ts` :8,59,77,79; `embedChart.ts` :20,55; `marketIdentity.ts` :73.
- In the switch, grid and search: a DogeOS selection is isolated the way 46630 is.
- Extend `feedChainIsolation.test.mjs`: with `VITE_ALLOWED_CHAIN_IDS` including 6281971, DogeOS feeds contain only 6281971; without it, DogeOS never appears; existing cases unchanged.
**Verify:** `cd frontend && npm run test:feed-isolation` → all pass

### Task 12: Frontend native symbol, labels, explorer, DOGE/USD hook            [id: t12]
**Depends-on:** [t10]
**TDD:** required
**Files:**
- `frontend/src/lib/graduationMarketPresentation.mjs`, `lib/homeFeedData.ts`, `lib/rewardProgramsApi.ts`, `lib/profile/profileFormatters.ts`, `lib/walletChainGuard.mjs`, `lib/tokenShareCard.mjs`, `lib/launchpad/adapters/evmLaunchpadSafetyPresentation.mjs`
- `components/feed/FeedCards.tsx`, `components/home-feed/HomeParts.tsx`, `components/token/UnifiedMarketChart.tsx`, `components/home/CampaignTickerBar.tsx`, `components/token/CreatorProtectionDialog.tsx`, `components/token/UpvoteDialog.tsx`
- `hooks/useNativeUsdPrice.ts`, `hooks/useDogeUsdPrice.ts` (new), `hooks/profile/useProfileBalances.ts`
- `pages/PublicProfile.tsx`, `pages/TokenDetails.tsx`, `pages/command-center/CommandCenterClaims.tsx`
- `frontend/src/lib/dogeosPresentation.test.mjs` (new)

Changes:
- Spec §2 native symbol.
- Every chainId → symbol, label, DEX name or explorer branch in the files above gets an explicit 6281971 branch: DOGE, "DogeOS Chikyū Testnet", L2Scan, and the DEX label "MuchFi" (controller change; DogeOS graduates into MuchFi).
- `graduationMarketPresentation.mjs`: `nativeSymbol` (:45-52) DOGE; `EVM_NATIVE_LAUNCH_CHAIN_IDS` (:243) gets 6281971.
- `useDogeUsdPrice.ts`: Binance `DOGEUSDT`, the same shape as `useEthUsdPrice.ts`. `useNativeUsdPrice` dispatches 6281971 to it, with no BNB fallthrough.
- Arena/league/airdrop pages are out of scope (SP3 exception).
- Tests run the pure `.mjs` and `.ts`-extractable helpers for 6281971 and snapshot existing chains as unchanged.
**Verify:** `cd frontend && node --test src/lib/dogeosPresentation.test.mjs && npm run test:graduation-market` → all pass; `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` → no more errors than the same command at the task's starting commit (record both counts)

### Task 13: Frontend launch path: V3 family branches, generation pairs, post-grad trade            [id: t13]
**Depends-on:** [t10, t30]
**TDD:** required
**Files:**
- `frontend/src/lib/graduationTiers.ts`, `lib/scheduledLaunchClientV2.ts`, `features/launchpad/useLaunchpadAdapter.ts`, `features/launchpad/robinhoodAdapter.ts`
- `pages/Create.tsx`, `components/create/EvmGen6LaunchOptions.tsx`
- `lib/launchpadClient.ts`, `lib/robinhoodV3Trade.ts`, `lib/evmGen7.mjs`, `lib/lpFeeHarvest.ts`
- `pages/TokenDetailsLiveEntry.tsx`, `components/postgrad/RobinhoodWarRoomTradePanel.tsx`, `components/postgrad/WarRoomCampaignRow.tsx`
- `frontend/src/lib/dogeosLaunchPath.test.mjs` (new)

Changes:
- Spec §2, §3 generation pair; global constraint CREATE/BUY/SELL.
- Where the Robinhood check really means "gen-7 + V3 graduation + USD target", include 6281971 through `isDogeosChainId` without touching `isRobinhoodChainId`:
  - `launchpadClient.ts:593,735,1032`
  - `useLaunchpadAdapter.ts:20`
  - `robinhoodAdapter.ts:58-60`: an explicit 6281971, never the default 46630
  - `Create.tsx:169`, `EvmGen6LaunchOptions.tsx:93,308`, `lpFeeHarvest.ts:19-20`
  - `robinhoodV3Trade.ts:99-100,248` (not the :138 stock branch)
  - `TokenDetailsLiveEntry.tsx:44-45,90-98,297`; RobinhoodWarRoomTradePanel :81 never defaults 6281971 to 46630
- `graduationTiers.ts:74` `isTestGraduationChain` gets 6281971.
- `scheduledLaunchClientV2.ts:64` gets `6281971: [[7, 6]]`.
- `evmGen7.mjs:97` DEX label: "MuchFi". Fix the `chainRegistry.ts:140-142` comment for `dogeos-testnet` to say MuchFi (the adapter keys stay `robinhood-dex-testnet`: same adapter family).
- **MuchFi post-graduation trade** for 6281971 (spec §1):
  - quotes come from MuchFi QuoterV2 and swaps go through the MuchFi SmartRouter, using the per-chain env `_6281971` names `robinhoodV3Trade.ts` already reads
  - the pool fee is **10000**: any hard-coded 3000 in that trade path gets an explicit DogeOS branch, with Robinhood unchanged
  - the frontend calls S1 (`RobinhoodV3NativeSwapAdapterV2`), which does `exactInputSingle` into the SmartRouter; check that path against t30's SmartRouter fact
- Stock UI stays off for DogeOS.
- Tests:
  - the DogeOS adapter is selected
  - the USD-target read path
  - the generation-pair mirror equals the API table (existing parity test)
  - the V3 trade env resolution for `_6281971`
  - the DogeOS trade path uses fee 10000 and the MuchFi SmartRouter/QuoterV2 addresses; 46630 still uses 3000
  - `evmGen7Wiring.test.mjs` and `evmGen6Wiring.test.mjs` unchanged and green
**Verify:** `cd frontend && node --test src/lib/dogeosLaunchPath.test.mjs src/lib/evmGen7Wiring.test.mjs src/lib/evmGen6Wiring.test.mjs && npm run test:evm-gen6` → all pass

### Task 14: API chain identity and RPC            [id: t14]
**Depends-on:** [t1]
**TDD:** required
**Files:**
- `frontend/api/lib/defaultEvmChain.js`, `lib/chainNative.js`, `lib/getServerReadProvider.js`, `lib/evmCampaignProgress.js`, `lib/rpcUsage.js`
- `lib/notificationContract.js`, `lib/notificationProducers.js`, `lib/rewardClaimVerification.js`, `lib/draftEvmLaunchOptions.js`
- `evmCampaignState.js`, `campaigns-base.js`, `rewards.js`
- `dev-fix/reward-claim-closeout-router.js`, `dev-fix/reward-claim-intent-generic.js`, `dev-fix/recruiter-payouts.js`
- `dashboard/lp-fees.js`
- `frontend/api/lib/dogeosApiIdentity.test.mjs` (new)

Changes:
- Spec §3.
- `defaultEvmChain.js:1`; `chainNative.js`: `isDogeosChainId` and `nativeSymbolFor(6281971)` = DOGE; `isRobinhoodChainId` is unchanged.
- `getServerReadProvider.js`: `PUBLIC_FALLBACKS[6281971]`, `networkName`, and a 6281971 env branch (`DOGEOS_RPC_HTTP_6281971`, `EVM_RPC_HTTP_6281971`, `VITE_PUBLIC_RPC_6281971`) that never appends `BSC_RPC_HTTP` (:101-106).
- `evmCampaignProgress.js:23,43,57`: :43 USD-target semantics as 46630; check against the gen-7 read.
- `rpcUsage.js:185`; `notificationContract.js:22` (new family `dogeos`), `:39`; `notificationProducers.js:23`; `rewardClaimVerification.js:4,23-26`; `draftEvmLaunchOptions.js:10`.
- `evmCampaignState.js:19,38`; `campaigns-base.js:17,21`; `rewards.js:18`.
- `reward-claim-closeout-router.js:12,184,207`; `reward-claim-intent-generic.js:14,15→DOGE symbol branch,125,356`.
- `recruiter-payouts.js:217,527`: add to the testnet **exclusion**.
- `lp-fees.js:47,138,543`: V3 locker path plus DOGE.
- Tests: each function for 6281971, plus a before/after table for existing chains; `getRpcUrls(6281971)` contains no BSC URL.
**Verify:** `cd frontend && node --test api/lib/dogeosApiIdentity.test.mjs && npm run test:rpc-usage` → all pass

### Task 15: API DOGE/USD reader and price/symbol fallthroughs            [id: t15]
**Depends-on:** [t14]
**TDD:** required
**Files:** `frontend/api/lib/dogeUsdPrice.js` (new), `lib/arenaNativeUsdFeed.mjs`, `lib/financePrices.js`, `lib/arenaMarketSnapshot.js`, `profile/portfolio.js`, `dev-fix/airdrop-preview.js`, `frontend/scripts/weekly-airdrop/materialize.mjs`, `frontend/scripts/weekly-airdrop/usdRules.mjs`, `frontend/api/lib/dogeUsdPrice.test.mjs` (new)
- Spec §3 DOGE/USD for display.
- `dogeUsdPrice.js` copies the `ethUsdPrice.js` shape: env `DOGE_USD_PRICE`, `DOGE_USD_PRICE_FETCH`, `DOGE_USD_PRICE_CACHE_MS`; Binance `DOGEUSDT`; returns `{price, source, cached, at}`.
- Wire it in:
  - `arenaNativeUsdFeed.mjs`: `NATIVE_ASSET_BY_CHAIN[6281971]="DOGE"` and the reader
  - `financePrices.js`: `PRICE_FEEDS` / `priceAssetFor`
- Explicit DOGE branches, no BNB fallthrough: `arenaMarketSnapshot.js:41-42`, `portfolio.js:349,376`, `airdrop-preview.js:54`, `materialize.mjs:17`, `usdRules.mjs:56`.
- Tests: the reader with a mocked fetch (cache, env override, fetch-off); dispatch for 6281971 returns DOGE and never BNB; existing chains unchanged.
**Verify:** `cd frontend && node --test api/lib/dogeUsdPrice.test.mjs` → all pass

### Task 16: API route authorization and draft gates            [id: t16]
**Depends-on:** [t14]
**TDD:** required
**Files:** `frontend/api/dev-fix/route-auth.js`, `dev-fix/routeAuthorizationSigner.js`, `dev-fix/route-authorization-gen7.test.mjs`, `dev-fix/draft-deploy-base.js`, `dev-fix/drafts-base.js`, `frontend/api/dev-fix/dogeosRouteAuth.test.mjs` (new)
- Spec §3 route authorization, generation pair.
- `route-auth.js:185,194` gates gain `|| cid === 6281971`.
- `routeAuthorizationSigner.js`: `ALLOWED_GENERATION_PAIRS` (:164-170) gains `[6281971n, [[7, 6]]]`.
- Both `ROBINHOOD_CHAIN_IDS` sets stay unchanged: `routeAuthorizationSigner.js:49` and `draft-deploy.js:21`.
- Flip `route-authorization-gen7.test.mjs:62` to assert true for `[7,6]` and false for `[6,5]`, `[7,5]`, `[6,6]` on 6281971.
- `drafts-base.js:95` (the $150 gen-7 tier) includes 6281971. `dev-fix/drafts.js:29` `ROBINHOOD_CHAIN_IDS` (used at :90 and :212) is the Graduation Market stock/quote policy. It is a stock exception: leave it alone and list it in t23's exceptions file. Leave `draft-deploy-base.js:162` (the $6 tier) alone: gen-7 arming rejects $6, so adding it would let DogeOS drafts be saved that can never be armed.
- `dev-fix/draft-deploy.js:21` RH route-authority key lookup: **no change**. DogeOS uses the global `ROUTE_AUTHORITY_PRIVATE_KEY`. Add a test that `draft-deploy.js` resolves the global key for 6281971.
- Find out how a 46630 `$150` gen-7 draft passes the DB `campaign_drafts_graduation_target_check` (`db/migrations/20260929_000011_campaign_drafts_dbc_quote.sql:11-22`, which allows $150 only on 101/102). Record the finding in the task report: either the drafts path doesn't store the target for gen-7, or 46630 also fails today. If 6281971 needs the CHECK extended, hand that requirement to t22. Do not change behaviour for 46630.
**Verify:** `cd frontend && node --test api/dev-fix/route-authorization-gen7.test.mjs api/dev-fix/dogeosRouteAuth.test.mjs && npm run test:evm-gen6` → all pass

### Task 17: Indexer chain lists, env block, CHAINS, discovery, fallthroughs            [id: t17]
**Depends-on:** [t1]
**TDD:** required
**Files:** `realtime-indexer/src/evmIndexerChains.ts`, `src/env.ts`, `src/indexer.ts`, `src/factoryDiscovery.ts`, `src/canonicalCandleMaterializer.ts`, `src/ensureCampaignTradeHistory.ts`, `src/emptyTradeCursorRewind.ts`, `src/marketIdentity.ts`, `src/marketApi.ts`, `src/server.ts`, `realtime-indexer/src/tests/dogeosIndexerChains.test.ts` (new)
- Spec §4.
- `evmIndexerChains.ts:1,24` (`ACTIVE` :30 unchanged).
- `env.ts`: a DogeOS block beside the 46630 fields (:51,53-56,69,80-81,99,105,111): `DOGEOS_RPC_HTTP_6281971`, `ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971` (or the existing per-chain naming), `FACTORY_ADDRESS_6281971`, `SUPPORTED_FACTORY_ADDRESSES/START_BLOCKS_6281971`, `FACTORY_START_BLOCK_6281971`, and empty vote-treasury fields.
- `indexer.ts`:
  - a `CHAINS` entry (:302-336, gated on RPC)
  - :488 graduated market `quoteAsset` = `WDOGE` for 6281971 (WETH unchanged for RH)
  - :1458 and :2461 V3 branches include 6281971
- `factoryDiscovery.ts:76-83` block.
- Explicit 6281971 branches, never the BSC default: `canonicalCandleMaterializer.ts:108-117,455`, `ensureCampaignTradeHistory.ts:39,381`, `emptyTradeCursorRewind.ts:42-43`.
- `marketIdentity.ts:28`, `marketApi.ts:872`, and `server.ts:394` (`rpc6281971Configured`).
- `CONFIRMATIONS` is untouched.
- Tests: RPC/start-block resolution for 6281971 returns DogeOS values or empty, never BSC; the CHAINS entry exists only with an RPC; existing chains unchanged.
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosIndexerChains.test.ts && npm --prefix realtime-indexer run build` → pass, exit 0

### Task 18: Indexer symbols, labels, notifications            [id: t18]
**Depends-on:** [t17]
**TDD:** required
**Files:** `realtime-indexer/src/notificationContract.ts`, `src/campaignLifecycleNotifications.ts`, `src/evm/evmCreatorChoicePass.ts`, `src/rewards/airdropThresholds.ts`, `realtime-indexer/src/tests/dogeosIndexerSymbols.test.ts` (new)
- Spec §2 native symbol, applied to the indexer.
- `notificationContract.ts:14` (family `dogeos`), `:31` `STAGING_IDS`; `campaignLifecycleNotifications.ts:87`.
- `evmCreatorChoicePass.ts:355`: add a DOGE branch. The creator-choice job stays off, but the symbol must not lie if it is ever read.
- `airdropThresholds.ts:72`: `DOGEUSDT`.
- Tests for each, with existing chains unchanged.
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosIndexerSymbols.test.ts` → pass

### Task 19: DogeOS native USD oracle reader + V3 pool indexer parametrization            [id: t19]
**Depends-on:** [t17, t30]
**TDD:** required
**Files:** `realtime-indexer/src/dogeosNativeUsdOracle.ts` (new), `src/robinhoodV3PoolIndexer.ts`, `src/robinhoodMarketValuation.ts`, `src/robinhoodCmsHeal.ts`, `src/robinhoodMarketApi.ts`, `realtime-indexer/src/tests/dogeosV3PoolIndexer.test.ts` (new)
- Spec §4 graduated trades and oracle reading.
- `dogeosNativeUsdOracle.ts` is a sibling of `robinhoodNativeUsdOracle.ts` with the same AggregatorV3 read/evaluate shape: env `DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971`, RPC from the t17 env, maxAge 3600. `robinhoodNativeUsdOracle.ts` is untouched.
- `robinhoodMarketValuation.ts:125-165` dispatches 6281971 to the DogeOS reader.
- `robinhoodV3PoolIndexer.ts`:
  - the `ChainConfig.chainId` type (:55) and a `chainConfigs()` block (:116-136) for 6281971
  - `maxChunk` (:1435) becomes `Math.min(existing, 10_000)` **only** for 6281971
  - the narrowing (:1449-1454) stays as is
  - the spot-price `slot0` read (~:877-893) uses a `uint32 feeProtocol` ABI for 6281971 (tested against t30's recorded `slot0` fixture); Robinhood's ABI unchanged
  - **MuchFi pools** (spec §4): for 6281971, decode MuchFi's pool `Swap` event (PancakeV3 shape with protocol-fee fields; topic0 as recorded by t30) and treat fee 10000. Robinhood's Uniswap decoding stays byte-for-byte. The router env is the existing per-chain name, set to the MuchFi SmartRouter.
- `robinhoodCmsHeal.ts:127` guard and `robinhoodMarketApi.ts:14` include 6281971 only if the token page's post-grad panel reads those routes. Check `TokenDetailsLiveEntry.tsx` and report; otherwise mark it as an exception.
- Tests:
  - the DogeOS chainConfig built from env
  - starting chunk 10,000 for 6281971 and 50,000 for 46630 (unchanged)
  - narrowing pinned: a mock provider rejecting >2,500 shrinks to ≤ 2,500 and completes
  - valuation for 6281971 uses the DogeOS reader; 46630 unchanged
  - a recorded MuchFi Swap log (fixture from t30) decodes to the right amounts and price; a Uniswap Swap log for 46630 still decodes as before
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosV3PoolIndexer.test.ts && npm --prefix realtime-indexer run build` → pass

### Task 20: Graduation keeper for 6281971            [id: t20]
**Depends-on:** [t17]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGraduationKeeperConfig.ts`, `src/evm/evmGraduationKeeper.ts`, `src/evm/evmGraduationKeeperWorker.ts`, `realtime-indexer/src/tests/dogeosGraduationKeeper.test.ts` (new)
- Spec §1 Keys, §4 jobs table.
- `V3_GRADUATION_CHAINS` (:25) and `enabledKeeperChains` (:38) gain 6281971.
- The max gas for 6281971 defaults to ≤ 10,000,000 (`EVM_GRADUATION_KEEPER_MAX_GAS_6281971` may lower it, never raise it above 10M). `DEFAULT_MAX_GAS` for other chains is unchanged.
- `keeperRpc` (`evmGraduationKeeperWorker.ts:36`): a DogeOS branch.
- `FORBIDDEN_KEEPER_ADDRESSES` (`evmGraduationKeeper.ts:1087-1091`) gains lowercase `0x6c5c684d8ddf1d4338dbed21beb7d342dc8382f8` (deployer), `0x7dbdfe829309b4170346cf7e4496094cd126e9c1` (updater) and `0x4fcd24d620f8ecd298bf4d43cb1ca2f4d23876ff` (route authority).
- Tests:
  - enabled only with `EVM_GRADUATION_KEEPER_ENABLED_6281971`
  - max gas ≤ 10M, including when env tries 15M
  - `assertKeeperKeyAllowed` refuses all three DogeOS addresses (deployer, updater, route authority) (use throwaway test keys whose addresses you inject via `EVM_KEEPER_FORBIDDEN_ADDRESSES` for the positive path; never use the real keys)
  - observation slots 180 for 6281971
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosGraduationKeeper.test.ts && npm --prefix realtime-indexer run test:evm-gen5` → all pass

### Task 35: Keeper slot0 decoding for MuchFi pools            [id: t35]
**Depends-on:** [t20, t30]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGraduationKeeper.ts`, `realtime-indexer/src/tests/dogeosKeeperSlot0.test.ts` (new)
- Spec §4 "Off-chain `slot0` reads". The keeper decodes `slot0` with `uint8 feeProtocol` at `evmGraduationKeeper.ts:94`, `:808` and `:1015-1021` (V3_POOL_OBSERVATIONS_IFACE); ethers masks MuchFi's 209718400 to 128 (it does not throw); the uint32 ABI makes feeProtocol correct and guards against a stricter decoder. For 6281971 use a `uint32 feeProtocol` ABI in the observation-cardinality step and the partial-repair price read; Robinhood/BNB ABIs and behaviour unchanged.
- Tests: decode t30's recorded MuchFi `slot0` fixture via the DogeOS path (succeeds, correct sqrtPrice/tick), the same bytes via the Robinhood path still behave as before, and the observation/repair helpers select the DogeOS ABI only for 6281971.
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosKeeperSlot0.test.ts && npm --prefix realtime-indexer run test:evm-gen5` → all pass

### Task 21: DOGE/USD oracle push worker            [id: t21]
**Depends-on:** [t19]
**TDD:** required
**Files:** `realtime-indexer/src/evm/dogeosOraclePushConfig.ts` (new), `src/evm/dogeosOraclePushWorker.ts` (new), `src/main.ts`, `realtime-indexer/src/tests/dogeosOraclePush.test.ts` (new)
- Spec §4 "DOGE/USD oracle push".
- Config from env:
  - `DOGEOS_ORACLE_PUSH_ENABLED`
  - `DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY`
  - `DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971`
  - `DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS` (default 1800)
  - `DOGEOS_ORACLE_PUSH_DEVIATION_BPS` (default 100)
- Pure decision fn `shouldPush({lastAnswer, lastUpdatedAt, price, now, cfg})` → push when older than the interval or deviation ≥ threshold.
- Price: Binance `DOGEUSDT` → 8-decimal integer. On fetch failure or a non-positive price, skip and log; never push ≤ 0.
- Before the first push:
  - refuse unless the chainId is 6281971
  - refuse unless `oracle.updater()` equals the signer address
  - refuse if the signer address is the deployer, the keeper or the route authority
- Register `startDogeosOraclePushWorker()` in `main.ts` beside `startEvmGraduationKeeperWorker()` (:30), with a `started` guard. It is a no-op unless enabled.
- Tests:
  - `shouldPush` matrix
  - price conversion and rounding
  - refusals (wrong chain, wrong updater, deployer/keeper key — throwaway keys only)
  - skip on fetch error
  - never ≤ 0
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosOraclePush.test.ts && npm --prefix realtime-indexer run build` → pass

### Task 22: Staging migration for the launch path            [id: t22]
**Depends-on:** [t16]
**TDD:** required
**Files:** `db/migrations/20261010_000020_dogeos_chain_launch_path.sql` (new), `database/staging_apply_dogeos_launch_path.sh` (new), `db/migrations/dogeosLaunchPathMigration.test.mjs` (new)
- Spec §5.
- The idempotent migration (own `begin;`/`commit;`, `drop constraint if exists` + `add constraint`) re-creates `campaign_draft_evm_launch_options_chain_chk` with `(56,97,4663,46630,31337,6281971)`.
- If t16 found that `campaign_drafts_graduation_target_check` must include 6281971 for `$150` drafts, it re-creates that constraint too, as the latest definition plus 6281971 only.
- No other table.
- The apply script copies the `database/staging_apply_2026_10_04_catchup.sh` pattern:
  - refuses unless the URL contains `vrnsbguutnwgtekcexls`
  - `dryrun` | `apply` modes
  - one transaction, `lock_timeout 5s`, `ON_ERROR_STOP`
- The node test parses the SQL: every listed constraint contains all pre-existing ids plus 6281971; it has `begin;` and `commit;`; it touches no other constraint name.
- **Do not run it against any database.** That is part of t29.
**Verify:** `node --test db/migrations/dogeosLaunchPathMigration.test.mjs` → all pass; `bash -n database/staging_apply_dogeos_launch_path.sh` → exit 0

### Task 23: Chain-list guard test            [id: t23]
**Depends-on:** [t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t22, t35]
**TDD:** required
**Files:** `scripts/dogeos-chain-list-guard.test.mjs` (new), `scripts/dogeos-chain-list-exceptions.json` (new)
- Spec §6.
- The test runs `git grep -n 46630` over `frontend/src frontend/api frontend/scripts frontend/shared realtime-indexer/src db/migrations scripts/lib`, excluding tests, specs and comments.
- For each hit it requires one of:
  - (a) `6281971` on the same line or within the same statement (±3 lines), or
  - (b) a `file:pattern` entry in `dogeos-chain-list-exceptions.json` with category and reason, where the categories are the global-constraints exception list
- It also asserts a fixed list of **indirect** launch-path checks that don't use the literal (the `isRobinhoodChainId` / `ROBINHOOD_TESTNET_CHAIN_ID` sites from t10–t21) each reference `isDogeosChainId` or 6281971.
- It also asserts the exceptions file has no stale entries (each pattern still matches).
- Make it fail first by temporarily removing one addition. Do not commit that.
**Verify:** `node --test scripts/dogeos-chain-list-guard.test.mjs` → all pass

### Task 24: Env placeholders and TEST env-block generator            [id: t24]
**Depends-on:** [t8, t17, t21]
**TDD:** required
**Files:** `.env.example`, `frontend/.env.example`, `config/coolify-qa-staging.env.example`, `scripts/dogeos-env-blocks.mjs` (new), `scripts/dogeos-env-blocks.test.mjs` (new)
- Spec §7, gate 5.
- Add DogeOS placeholders with empty addresses and **no key values**, next to the 46630 entries. `config/coolify-qa-staging.env.example` gets the DogeOS block per service (frontend, API, indexer), including `EVM_INDEXER_CHAIN_IDS` and keeper/oracle-push flags commented as TEST-only.
- The MuchFi addresses (factory, NPM, SmartRouter, QuoterV2) and fee 10000 go into the frontend, API and indexer blocks under the existing per-chain env names (for example `ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971`, `VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971`, `EVM_KEEPER_V3_FACTORY_6281971`, `EVM_KEEPER_WETH_6281971`, `EVM_KEEPER_V3_FEE_6281971=10000`).
- `dogeos-env-blocks.mjs <manifest>` prints three paste-ready blocks (TEST frontend, TEST API, TEST indexer) from `deployments/dogeos/testnet.json`.
  - Key values are always the literal placeholder `<paste from config/dogeos.local>`. The TEST API block includes `ROUTE_AUTHORITY_PRIVATE_KEY=<paste DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY from config/dogeos.local>`. The TEST indexer block includes the updater and keeper keys the same way.
  - It never reads `config/dogeos.local`.
  - `VITE_ALLOWED_CHAIN_IDS` / `EVM_INDEXER_CHAIN_IDS` show the existing TEST value + `,6281971` as an instruction comment, not a full overwrite.
- Tests on a fixture manifest:
  - every expected key is present
  - no string matching `/0x[0-9a-fA-F]{64}/` (private-key shape) in output
  - it doesn't open `config/dogeos.local` (mock fs)
**Verify:** `node --test scripts/dogeos-env-blocks.test.mjs` → all pass

### Task 25: DogeOS topic doc and CLAUDE.md index            [id: t25]
**Depends-on:** [t9]
**TDD:** waived (documentation)
**Files:** `docs/claude/dogeos.md` (new), `CLAUDE.md` (topic index row only)
- Spec Definition of done.
- `dogeos.md`: the verified chain facts table (from the spec), quirks (getLogs caps, reorg depth vs `CONFIRMATIONS=1`, L1 fee, 10M gas, disabled opcodes, 18-decimal faucet stables), the key roles and addresses (public only), the fork rehearsal budget from `reports/dogeos/fork-rehearsal.json`, and the four sub-projects.
- Addresses and canary hashes are filled in by t28/t29.
- `CLAUDE.md`: one new row in §3 topic index. Nothing else in CLAUDE.md changes.
**Verify:** `grep -c "dogeos.md" CLAUDE.md` → `1`; after the task's commit, `git diff HEAD~1 --stat -- CLAUDE.md` → `1 file changed, 1 insertion(+)`

### Task 26: Gate 1, full test suites            [id: t26]
**Depends-on:** [t2, t3, t5, t6, t7, t8, t30, t31, t32, t33, t34, t35, t36, t37, t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24]
**TDD:** waived (verification-only gate; no code)
**Files:** none
- Spec gate 1.
- Run every suite and paste the summaries:
  - `npm test` (all Hardhat specs)
  - `cd frontend && npm test` if defined, else each `test:*` package script plus `node --test` on every new DogeOS test file
  - `npm --prefix realtime-indexer test` if defined, else each `test:*` script
  - `npm --prefix realtime-indexer run build`
  - `npx --prefix frontend tsc -p frontend --noEmit`
- Compare against a baseline run of the same commands on the merge base (`git stash`-free: use `git worktree add` on `main` in the scratchpad) and list any failure that is new.
- Any new failure blocks t9: report it, don't fix it here.
- Also run the unchanged-live check: `git diff 6c5ca159a --stat -- deployments/ ':!deployments/dogeos'` → empty.
**Verify:** all suites report 0 new failures versus baseline; `git diff 6c5ca159a --stat -- deployments/ ':!deployments/dogeos'` → empty output

### Task 27: Whole-branch review            [id: t27]
**Depends-on:** [t26]
**TDD:** waived (review)
**Files:** none
- A fresh `templar-powers:branch-reviewer` reviews against the spec and global constraints. It focuses on: any change to existing-chain behaviour, any BSC/BNB/ETH fallthrough left for 6281971, any key handling, and CREATE/BUY/SELL shape.
- Findings are fixed in follow-up commits before t9.
**Verify:** reviewer verdict `Approved` or `With fixes` with all fixes committed

### Task 28: Gate 4, Chikyū deploy (FOUNDER GO REQUIRED)            [id: t28]
**Depends-on:** [t9, t25, t27]
**TDD:** waived (on-chain deployment, founder-gated)
**Files:** `deployments/dogeos/testnet.json` (new), `config/verification/dogeos-testnet-contracts.json` (new), `docs/claude/dogeos.md`, `docs/claude/evm-deployments.md`
- Before asking: a fresh `templar-powers:task-reviewer` reviews the file t9 added after the t27 branch review (`scripts/rehearse-dogeos-fork.ts`).
- Spec gate 4. **The controller stops and asks the founder for an explicit go**, naming the key (`0x6c5C…82f8`), the network (6281971), the budget from `reports/dogeos/fork-rehearsal.json` and the deployer's current balance (read-only `eth_getBalance`).
- On go, the founder runs (or approves the controller running) `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO npx hardhat run scripts/deploy-dogeos-testnet.ts --network dogeosTestnet`, then `npx hardhat --config hardhat.dogeos-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet`.
- Fund the updater and the keeper from the deployer with the amounts from the rehearsal report. That is also a transaction, covered by the same go.
- Commit the manifest, the verification JSON, and the addresses in `docs/claude/dogeos.md` and `docs/claude/evm-deployments.md`.
**Verify:** read-only: `createPaused()==true`, `live()==false` and `routeAuthority()==DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS` on the deployed factory via `eth_call`; every contract in the manifest has code (`eth_getCode` non-empty); L2Scan `getabi` returns status 1 for each verified contract

### Task 29: Gate 5, TEST wiring + canary (FOUNDER GO REQUIRED)            [id: t29]
**Depends-on:** [t28, t22, t24]
**TDD:** waived (on-chain canary, founder-gated)
**Files:** `docs/claude/dogeos.md`, `docs/claude/evm-deployments.md`, `deployments/dogeos/testnet.json` (canary section)
- Spec gate 5, Definition of done. **Each sub-step below needs the founder's explicit go.**
1. Staging DB: `database/staging_apply_dogeos_launch_path.sh dryrun`, then `apply`.
2. Print env blocks: `node scripts/dogeos-env-blocks.mjs deployments/dogeos/testnet.json`. The founder pastes them into the TEST services in Coolify, adds the updater and keeper keys, and redeploys. TEST services (Coolify project MemeWarzone, environment `testnet-devnet`):
   - API "Backend API Dev" `jkq5rjveklrueuuuputnpj6o`
   - indexer "realtime-indexer Dev" `s75mnp6dfpjtv8m8fcefxlay`
   - frontend "Frontend Dev" `4kdlgixhrtsorbqn6wi7kmr0`

   With the Coolify MCP, check that every key name exists on the right service (`list_env_keys`; names only).
   - Never touch any resource in environment `production`, which shares the project.
   - Never call MCP `deploy`/`control` without the founder's go for that specific call.
3. Health:
   - TEST API `/health` responds
   - TEST API `/api/routing/status?chainId=6281971` reports `signerConfigured: true` and `matchesOnchain: true` (the founder set `ROUTE_AUTHORITY_PRIVATE_KEY` = the DogeOS route-authority key)
   - TEST indexer reports `rpc6281971Configured: true`
   - the oracle push makes its first update (`latestRoundData` fresh)
   - If the routing status fails, stop. Don't activate.
4. `DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO npx hardhat run scripts/activate-dogeos-testnet.ts --network dogeosTestnet` (`enableLive` + unpause create, from the deployer).
5. Canary through the TEST app with MetaMask:
   - create (creator wallet)
   - buys from ≥ 5 buyer wallets funded from the founder's account
   - a sell
   - reach `$150`
   - the keeper graduates
   - a post-graduation swap
   - creator claim
   - For each step, record the tx hash and check chain (L2Scan) = indexer = DB/app (price, chart, balances, status).
6. 24 h later: the oracle is still fresh with nobody touching it.
- Record all hashes in `docs/claude/dogeos.md` and `docs/claude/evm-deployments.md`.
**Verify:** every canary step has a tx hash with receipt status 1; the indexer API returns the DogeOS coin with status graduated and a pool; `latestRoundData().updatedAt` is within 1800 s at the 24 h check

# DogeOS Foundation + Launch Implementation Plan
**Spec:** docs/templar/specs/2026-10-10-dogeos-foundation-launch-design.md
**Profile note:** All code tasks are implementation-tier (opus). They touch money-adjacent launch paths and many hand-kept lists, where a missed branch silently reads the wrong chain, so none qualify for the mechanical-edit tier. t4 (oracle audit diff) and the final branch review are review-tier. t28 and t29 are founder-gated: the controller stops and asks for an explicit go before running them, and never runs them on its own. Tasks t10–t22 are independent of the contract tasks and may run in parallel batches.

## Global constraints

- **Chain:** DogeOS Chikyū testnet, chain id `6281971`, native DOGE (18 decimals), RPC `https://rpc.testnet.dogeos.com`, explorer `https://dogeos-testnet.l2scan.co` (Etherscan-style `/api`), WDOGE `0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE`. Spec "Verified chain facts".
- **Bytecode:** solc 0.8.24, the existing `hardhat.config.ts` compiler settings (optimizer runs 1, viaIR, `bytecodeHash: none`, default evm target paris). Never add a DogeOS compiler profile. Never edit any `contracts/gen7/*`, `contracts/integrations/*`, or any existing contract. The only new Solidity file is the DOGE/USD testnet oracle (t3).
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
  - Route authority = TEST API key address `0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0` (re-read from the 46630 gen-7 factory before deploy).
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
- Run `npm ci --prefix frontend`, `npm ci --prefix realtime-indexer` and `npm ci --prefix tools/robinhood-testnet-infra`.
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
  - nothing else
- `hardhat.dogeos-verify.config.ts` extends the base config. It adds `etherscan.customChains` (`network: "dogeosTestnet"`, chainId 6281971, `apiURL: https://dogeos-testnet.l2scan.co/api`, `browserURL: https://dogeos-testnet.l2scan.co`) and an object-form `apiKey` for `dogeosTestnet` only. The shared config's `etherscan` stays unchanged, so BSC verify is not touched.
- Tests:
  - the resolvers ignore `DEPLOYER_PK`
  - the missing-key throw
  - the network entry's chainId
  - `hardhat.config.ts` `etherscan` is deep-equal before and after (import the config, snapshot the field)
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
**Verify:** `npx hardhat test test/DogeosTestnetDogeUsdOracle.spec.ts` → all passing; `git diff --stat main -- contracts/gen7 contracts/integrations contracts/robinhood` → empty

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
- Spec §1 "Staging DEX".
- `deployDogeosV3Stack({ signer, wrappedNative, chainId, allowLocalRehearsal })` deploys, from the pinned `tools/robinhood-testnet-infra` artifacts, the same shape as `scripts/deploy-robinhood-testnet-infrastructure.ts:122-150`:
  - UniswapV3Factory
  - NFTDescriptor (library)
  - NonfungibleTokenPositionDescriptor(W, bytes32 "DOGE"), linked
  - NonfungiblePositionManager(factory, W, descriptor)
  - SwapRouter02(0x0, factory, npm, W)
- It returns the addresses. It throws unless `chainId === 6281971`, or `31337 && allowLocalRehearsal`.
- It asserts that fee 3000 has spacing 60, as `assertFeeTierSpacing` does.
- No QuoterV2 is needed unless `lib/robinhoodV3Trade.ts` requires a quoter address. If it does, deploy QuoterV2(factory, W) from v3-periphery and include it.
- Tests on 31337 with a local WETH9-style stand-in for WDOGE (`MockWETH9`):
  - chain refusal on 31337 without the flag
  - deploy succeeds
  - create a pool, initialize it and check that `slot0()` is readable
  - one `exactInputSingle` swap through SwapRouter02 with native wrapped via the stand-in
- Skip with `ctx.skip()` when `tools/robinhood-testnet-infra/node_modules` is absent, using the pattern at `test/RobinhoodTestnetInfrastructureBootstrap.spec.ts:18-23`.
**Verify:** `npx hardhat test test/DogeosV3Stack.spec.ts` → all passing, 0 pending

### Task 6: Fresh gen-7 stack deploy + wiring library            [id: t6]
**Depends-on:** [t3, t5]
**TDD:** required
**Files:** `scripts/lib/dogeosGen7Stack.ts` (new), `test/DogeosGen7Stack.spec.ts` (new)
- Spec §1 "complete fresh set", "Route authority", "Deploy outputs".
- `deployDogeosGen7Stack(params)` implements this ordered table:
  - D1–D5: from t5
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
- The same chain guard as t5. The deployer must equal `params.admin`.
- `writeDogeosManifest(path, record)` writes `deployments/dogeos/testnet.json` in the shape described in spec §1. Mirror the `testnet.gen7.json` keys, replacing `reused` with `dex`, `oracle`, `registries` and `vaults`, adding `nativeSwapAdapter`, keeping the `deployed.LaunchFactory` alias, and leaving out stock keys and `liveRouter` / `liveVaultPinnedTo` / `supersedesForCreate`.
- Tests on 31337 (rehearsal flag, MockWETH9 as W, routeAuthority = a test signer) assert every wiring read-back above, plus `createPaused && !live`, and that no `enableLive` was sent: scan the deploy receipts for that selector.
**Verify:** `npx hardhat test test/DogeosGen7Stack.spec.ts` → all passing

### Task 7: Local full lifecycle on the fresh stack            [id: t7]
**Depends-on:** [t6]
**TDD:** required
**Files:** `test/DogeosGen7Lifecycle.spec.ts` (new)
- Spec gate 3 (behaviour proven locally first).
- On 31337, using `deployDogeosGen7Stack`:
  1. owner `enableLive` and unpause create (test-only, local)
  2. a route-authorized create via `createCampaignAuthorized`, signed by the test route authority as `frontend/api/dev-fix/routeAuthorizationSigner.js` does, with the `$150` target `TEST_GRADUATION_USD_THRESHOLD`
  3. buys from **5 distinct buyer signers**
  4. a sell
  5. buys until Pending
  6. `graduate()` called by a non-deployer keeper signer
  7. assert the pool exists on D1 and the position is locked in G3
  8. a post-graduation swap through S1
  9. creator claim from the creator vault
- Assert balances and events at each step.
- Model the authorized-create and buy calls on `test/evmgen7-core-lifecycle.spec.ts` and `scripts/test-robinhood-testnet-gen7-lifecycle.ts`. Do not change any create/buy/sell call shape.
- If creator claim needs the creator-choice operator, stop and report. That is a spec decision.
**Verify:** `npx hardhat test test/DogeosGen7Lifecycle.spec.ts` → all passing

### Task 8: Deploy and verify entrypoints with broadcast guards            [id: t8]
**Depends-on:** [t2, t6]
**TDD:** required
**Files:** `scripts/deploy-dogeos-testnet.ts` (new), `scripts/verify-dogeos-testnet.ts` (new), `config/verification/dogeos-testnet-contracts.json` (generated by deploy; not committed until t28), `scripts/dogeos-testnet-deploy-guards.test.mjs` (new), `package.json` (new scripts only)
- Spec §1 Deploy outputs, gate 4.
- `deploy-dogeos-testnet.ts`:
  - refuses unless `network.name === "dogeosTestnet"` and chainId 6281971, or the 31337 rehearsal flag
  - refuses unless `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO`, following the broadcast-token pattern in `scripts/robinhood-testnet-infrastructure-authority.test.mjs`
  - refuses unless the signer address equals `0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8`
  - reads the 46630 gen-7 factory `routeAuthority()` via `ROBINHOOD_TESTNET_RPC_URL` (read-only) and refuses if it differs from `0x2501…Bde0`
  - takes the initial DOGE/USD answer from Binance `DOGEUSDT` at run time, converted to 8 decimals, and refuses if ≤ 0
  - calls `deployDogeosGen7Stack`, then writes the manifest and the verification JSON (`chains["6281971"]`, the `verificationEntries` shape from `scripts/deploy-robinhood-gen7-generation.ts:561-581`)
- `verify-dogeos-testnet.ts` runs with `--config hardhat.dogeos-verify.config.ts`. It verifies our contracts and tolerates "already verified". Uniswap artifacts are verified via the standard-JSON route only if L2Scan accepts it; otherwise they are listed as unverified in the manifest.
- `package.json`: add `deploy:dogeos-testnet`, `verify:dogeos-testnet` and `rehearse:dogeos-fork` (t9). Do not rename existing scripts (`test/PackageScripts.spec.ts`).
- Node tests cover every refusal path: wrong network, missing token, wrong signer, route-authority mismatch, bad price.
**Verify:** `node --test scripts/dogeos-testnet-deploy-guards.test.mjs` → all pass; `npx hardhat test test/PackageScripts.spec.ts` → passing

### Task 9: Chikyū fork rehearsal + DOGE budget (gate 3)            [id: t9]
**Depends-on:** [t4, t7, t8, t26]
**TDD:** waived (rehearsal run against a read-only fork; behaviour already covered by t6/t7)
**Files:** `hardhat.dogeos-testnet-fork.config.ts` (new), `scripts/rehearse-dogeos-fork.ts` (new), `reports/dogeos/fork-rehearsal.json` (new)
- Spec gate 3.
- Fork config: a copy of `hardhat.rh-gen7-testnet-fork.config.ts` with
  - chainId 6281971, `chains: { 6281971: { hardforkHistory: {...} } }`
  - url `DOGEOS_TESTNET_FORK_RPC || https://rpc.testnet.dogeos.com`, `DOGEOS_FORK_BLOCK` (default: head − 16)
  - **`blockGasLimit: 10_000_000`**
- The rehearsal:
  1. impersonate the deployer on the fork with `hardhat_setBalance` (no real key needed)
  2. run `deploy-dogeos-testnet` logic with the real WDOGE and the real route-authority address
  3. impersonate the route authority to sign one create, or use a local signer and `hardhat_setStorageAt` only if impersonation can't sign. Document which.
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
- Every chainId → symbol, label, DEX name or explorer branch in the files above gets an explicit 6281971 branch: DOGE, "DogeOS Chikyū Testnet", L2Scan, and the DEX label "Uniswap V3 (DogeOS staging)".
- `graduationMarketPresentation.mjs`: `nativeSymbol` (:45-52) DOGE; `EVM_NATIVE_LAUNCH_CHAIN_IDS` (:243) gets 6281971.
- `useDogeUsdPrice.ts`: Binance `DOGEUSDT`, the same shape as `useEthUsdPrice.ts`. `useNativeUsdPrice` dispatches 6281971 to it, with no BNB fallthrough.
- Arena/league/airdrop pages are out of scope (SP3 exception).
- Tests run the pure `.mjs` and `.ts`-extractable helpers for 6281971 and snapshot existing chains as unchanged.
**Verify:** `cd frontend && node --test src/lib/dogeosPresentation.test.mjs && npm run test:graduation-market` → all pass; `npx --prefix frontend tsc -p frontend --noEmit` → exit 0

### Task 13: Frontend launch path: V3 family branches, generation pairs, post-grad trade            [id: t13]
**Depends-on:** [t10]
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
- `evmGen7.mjs:97` DEX label.
- Stock UI stays off for DogeOS.
- Tests:
  - the DogeOS adapter is selected
  - the USD-target read path
  - the generation-pair mirror equals the API table (existing parity test)
  - the V3 trade env resolution for `_6281971`
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
- `route-auth.js:185,194` gates gain `|| cid === 6281971`. `ALLOWED_GENERATION_PAIRS` (:164-170) gains `[6281971n, [[7, 6]]]`; `ROBINHOOD_CHAIN_IDS` (:49) is unchanged.
- Flip `route-authorization-gen7.test.mjs:62` to assert true for `[7,6]` and false for `[6,5]`, `[7,5]`, `[6,6]` on 6281971.
- `draft-deploy-base.js:162`, `drafts-base.js:95`: the test-target gates include 6281971.
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
**Depends-on:** [t17]
**TDD:** required
**Files:** `realtime-indexer/src/dogeosNativeUsdOracle.ts` (new), `src/robinhoodV3PoolIndexer.ts`, `src/robinhoodMarketValuation.ts`, `src/robinhoodCmsHeal.ts`, `src/robinhoodMarketApi.ts`, `realtime-indexer/src/tests/dogeosV3PoolIndexer.test.ts` (new)
- Spec §4 graduated trades and oracle reading.
- `dogeosNativeUsdOracle.ts` is a sibling of `robinhoodNativeUsdOracle.ts` with the same AggregatorV3 read/evaluate shape: env `DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971`, RPC from the t17 env, maxAge 3600. `robinhoodNativeUsdOracle.ts` is untouched.
- `robinhoodMarketValuation.ts:125-165` dispatches 6281971 to the DogeOS reader.
- `robinhoodV3PoolIndexer.ts`:
  - the `ChainConfig.chainId` type (:55) and a `chainConfigs()` block (:116-136) for 6281971
  - `maxChunk` (:1435) becomes `Math.min(existing, 10_000)` **only** for 6281971
  - the narrowing (:1449-1454) stays as is
- `robinhoodCmsHeal.ts:127` guard and `robinhoodMarketApi.ts:14` include 6281971 only if the token page's post-grad panel reads those routes. Check `TokenDetailsLiveEntry.tsx` and report; otherwise mark it as an exception.
- Tests:
  - the DogeOS chainConfig built from env
  - starting chunk 10,000 for 6281971 and 50,000 for 46630 (unchanged)
  - narrowing pinned: a mock provider rejecting >2,500 shrinks to ≤ 2,500 and completes
  - valuation for 6281971 uses the DogeOS reader; 46630 unchanged
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosV3PoolIndexer.test.ts && npm --prefix realtime-indexer run build` → pass

### Task 20: Graduation keeper for 6281971            [id: t20]
**Depends-on:** [t17]
**TDD:** required
**Files:** `realtime-indexer/src/evm/evmGraduationKeeperConfig.ts`, `src/evm/evmGraduationKeeper.ts`, `src/evm/evmGraduationKeeperWorker.ts`, `realtime-indexer/src/tests/dogeosGraduationKeeper.test.ts` (new)
- Spec §1 Keys, §4 jobs table.
- `V3_GRADUATION_CHAINS` (:25) and `enabledKeeperChains` (:38) gain 6281971.
- The max gas for 6281971 defaults to ≤ 10,000,000 (`EVM_GRADUATION_KEEPER_MAX_GAS_6281971` may lower it, never raise it above 10M). `DEFAULT_MAX_GAS` for other chains is unchanged.
- `keeperRpc` (`evmGraduationKeeperWorker.ts:36`): a DogeOS branch.
- `FORBIDDEN_KEEPER_ADDRESSES` (`evmGraduationKeeper.ts:1087-1091`) gains lowercase `0x6c5c684d8ddf1d4338dbed21beb7d342dc8382f8` and `0x7dbdfe829309b4170346cf7e4496094cd126e9c1`.
- Tests:
  - enabled only with `EVM_GRADUATION_KEEPER_ENABLED_6281971`
  - max gas ≤ 10M, including when env tries 15M
  - `assertKeeperKeyAllowed` refuses both DogeOS addresses (use throwaway test keys whose addresses you inject via `EVM_KEEPER_FORBIDDEN_ADDRESSES` for the positive path; never use the real keys)
  - observation slots 180 for 6281971
**Verify:** `npx --prefix realtime-indexer tsx --test realtime-indexer/src/tests/dogeosGraduationKeeper.test.ts && npm --prefix realtime-indexer run test:evm-gen5` → all pass

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
  - refuse if the signer address is the deployer or the keeper
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
**Depends-on:** [t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t22]
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
- `dogeos-env-blocks.mjs <manifest>` prints three paste-ready blocks (TEST frontend, TEST API, TEST indexer) from `deployments/dogeos/testnet.json`.
  - Key values are always the literal placeholder `<paste from config/dogeos.local>`.
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
**Verify:** `grep -c "dogeos.md" CLAUDE.md` → `1`; `git diff --stat -- CLAUDE.md` → `1 file changed, 1 insertion(+)`

### Task 26: Gate 1, full test suites            [id: t26]
**Depends-on:** [t2, t3, t5, t6, t7, t8, t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24]
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
- Also run the unchanged-live check: `git diff main --stat -- deployments/ ':!deployments/dogeos'` → empty.
**Verify:** all suites report 0 new failures versus baseline; `git diff main --stat -- deployments/ ':!deployments/dogeos'` → empty output

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
- Spec gate 4. **The controller stops and asks the founder for an explicit go**, naming the key (`0x6c5C…82f8`), the network (6281971), the budget from `reports/dogeos/fork-rehearsal.json` and the deployer's current balance (read-only `eth_getBalance`).
- On go, the founder runs (or approves the controller running) `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO npx hardhat run scripts/deploy-dogeos-testnet.ts --network dogeosTestnet`, then `npx hardhat --config hardhat.dogeos-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet`.
- Fund the updater and the keeper from the deployer with the amounts from the rehearsal report. That is also a transaction, covered by the same go.
- Commit the manifest, the verification JSON, and the addresses in `docs/claude/dogeos.md` and `docs/claude/evm-deployments.md`.
**Verify:** read-only: `createPaused()==true`, `live()==false` and `routeAuthority()==0x2501…Bde0` on the deployed factory via `eth_call`; every contract in the manifest has code (`eth_getCode` non-empty); L2Scan `getabi` returns status 1 for each verified contract

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
3. Health: TEST API `/health` and TEST indexer `rpc6281971Configured: true`; the oracle push makes its first update (`latestRoundData` fresh).
4. `enableLive` + unpause create on the DogeOS factory, sent from the deployer.
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

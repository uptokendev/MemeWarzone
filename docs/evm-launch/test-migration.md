# Legacy test migration to the EVM launch generation (factory 6 / campaign 5)

Hardening builder, 2026-09-30, branch `claude/evm-core`.

`npx hardhat test`: before **703 passing, 4 pending, 136 failing** -> after **826 passing, 14 pending, 0 failing**.

The old generation (the factories live on mainnet today) was replaced in place in `contracts/LaunchFactory.sol` and
`contracts/LaunchCampaign.sol`; its source and tests are recoverable at `c676ed7f` (build/dbc-staging). Tests that
pinned only old-generation constants (generation 4/3, 8400/1400 curve, `liquidityBps`) were ported to assert the new
values and, where useful, that the old value is now refused.

Shared helper changes: `test/helpers/deployFactory.ts` (`wireEvmGenTestDoubles`: native graduation adapter,
LaunchTokenDeployer, choice-aware creator vault), `test/helpers/deployRouting.ts` (V3 router's creator vault is
`MockCreatorRewardsVaultEvmGen`), `scripts/lib/deployFactoryWithLocker.ts`; per-group helpers
`test/helpers/legacy-{B1,B2,C}.ts`.

## Counts per decision (the 136 originally failing tests)

| decision | count |
|---|---|
| port | 112 |
| delete (replacement named) | 13 |
| pending: backend gap | 3 |
| pending: blocked on adapters not yet in tree / contract finding | 4 |
| env (tool install absent) | 3 |
| fixed incidentally (infra tests now run without the install) | 2 |

Pending also includes 4 pre-existing fork tests (BSC/Robinhood forks, need `*_FORK_RPC`) and 1 pre-existing.

## Pending with a reason (not fork/env)

| file | test | reason |
|---|---|---|
| RouteAuthorization.backend.integration.spec.ts | submits signatures from the dependency-free backend helper… | BACKEND GAP: `frontend/api/dev-fix/routeAuthorizationSigner.js:62` and `scripts/verify-route-authority.cjs:5` hash the old 7-field request; generation 6 hashes 11 |
| RouteAuthorityVerifier.spec.ts | hashes campaign requests exactly like the route auth ABI | same BACKEND GAP |
| RouteAuthorityHelperEdges.spec.ts | exports the ABI type layout used by request hashes | same BACKEND GAP (create/trade layout half is ported and passes) |
| LaunchFactoryLiquidityKinds.spec.ts | auto-registers a Robinhood V3 graduation NFT through the factory | no V3 `IGraduationAdapterV2` in tree (claude/evm-rh); binding half ported |
| RobinhoodStockGraduationCompletion.spec.ts | keeps the campaign pending after a failed route… | BLOCKED ON claude/evm-rh (no V3 IGraduationAdapterV2) |
| RobinhoodV3GraduationAdapter.spec.ts | graduates the unchanged LaunchCampaign into a permanently locked V3 NFT… | same |
| IndexerFactoryRegistry.spec.ts | preserves factory address and generation on decoded LaunchFactory events | `scripts/lib/indexerManifest.cjs:34-60` lists removed events; fallback ABI loses `indexed` and decoding throws |
| RobinhoodTestnetInfrastructureBootstrap.spec.ts (3) | canonical V3 deploy / real V3 pool / identities qualification | env: `tools/robinhood-testnet-infra/node_modules` absent (`npm ci` there) |

## Per test

| file | test | decision | reason | replacement test |
|---|---|---|---|---|
| LaunchCampaign.spec.ts | buyExactTokens transfers/refunds; slippage & value checks; sellExactTokens transfers; slippage (4) | port | C2 anti-sniper fee; fixture moves past the 60 s window, exact amounts kept | – |
| LaunchCampaign.spec.ts | fee receivers cannot DOS (feeRecipient revert escrows…) | delete | `pendingNative` escrow removed; strict routing reverts the trade | LaunchCampaign.audit > a paused treasury router halts trading…; Security > reentrancy defense; evmgen-core-graduation > a reverting router escrows the protocol share… |
| LaunchCampaign.spec.ts | pending escrow does not count toward graduation threshold | delete | trade-fee escrow removed | LaunchCampaign.audit > does not count direct native transfers toward graduation |
| LaunchCampaign.spec.ts | auto-finalize x3, oracle threshold, price-driven graduation, rejects callers, rejects router liquidity outside tolerance, post-finalize (8) | port | Pending then permissionless `graduate()`; exact Graduated args and 2.2/19.8/78; `DexPriceDrift` -> `StartPriceOutOfBand` at 50/51 bps | – |
| LaunchCampaign.audit.spec.ts | 3 tests | port | `graduate()`; exact split; `pendingNative` getters dropped | – |
| LaunchCampaign.excessNative.audit.spec.ts | allows only finalized excess native to be rescued | port | + `NotFinalized` while Pending; creator pull balance never excess | – |
| Security.spec.ts | 5 tests (crossing buy, finalize fee, DEX reserves, reentrancy, LP lock) | port | exact 220/1980 bps, reentrancy on MockTreasuryRouterEvmGen, LP held by locker | – |
| Launchpad.ts | default config | port | new defaults, generation 6 | – |
| TopazV2Mocks.spec.ts | graduates through a Topaz volatile pool | port | through the native adapter | – |
| LaunchCampaignTopazAdapter.spec.ts (file) | graduates through the production-router adapter… | delete | campaign no longer calls a DEX router at graduation | evmgen-core-graduation > exact 2.2 / 19.8 / 78…; TopazRouterAdapter.spec > pulls approved campaign tokens… |
| LaunchCampaignCloseout.spec.ts | 7 tests | port | default target + 61 s; `graduate()`; `GraduationPaused` | – |
| LaunchCampaignCloseout.spec.ts | caps graduation liquidity instead of reverting… | delete | 14% cap removed; config now `SupplyBoundBroken` | evmgen-core-graduation > setConfig refuses today's 8400/1400/850…; fuzz: every curve setConfig accepts graduates within its budget |
| LaunchCampaignQuoteEdges.spec.ts | 7 tests | port | target 0 + 61 s; sold out asserts Pending trigger 1 | – |
| LaunchCampaign.Phase2Graduation.spec.ts | 4 tests | port | `StartPriceOutOfBand` both sides; single burn lane; telemetry vs `getGraduationState` | – |
| LaunchCampaign.Phase1Routing.spec.ts | 6 routing tests | port | past the window; finalize = 2.2% via `previewRoute` exact per vault | – |
| Phase1Envelope.spec.ts | migrating the treasury router keeps unified routing | port | no routing setter exists; new factory on the new router routes exactly | – |
| Phase1Security.spec.ts | creator buy lock; creator buy cap; graduation record (3) | port | lock -> C4 escrow; cap kept; `graduate()` decrements live count | evmgen-core-escrow (also) |
| LaunchFactory.spec.ts | 11 tests | port | generation 6/5, 11-field InitParams/request, removed setters asserted absent, slope 1e22, `SupplyBoundBroken`, `FactoryLocked` on new setters | – |
| LaunchFactoryDefaultEconomics.spec.ts | 2 tests | port | defaults 7000/2800/200, 1e9, 1080, $30k | – |
| LaunchFactoryLifecycle.spec.ts | 2 tests | port | escrow instead of lock; Pending then `graduate()` | – |
| LaunchFactoryLiquidityKinds.spec.ts | V2 path; V3 no switch back | port | router immutable; no routing setter | evmgen-hardening-locker-binding > refuses a locker … of the wrong kind |
| LaunchFactoryLiquidityKinds.spec.ts | V3 NFT auto-registration | port (partial) + pending | see pending table | – |
| LaunchFactoryProtectionConfigBounds.spec.ts (file, 3) | protection bounds | delete | block protection removed (E7) | evmgen-core-antisniper > view follows 5000 - 80*t…; a sniper in the create block pays 5000 bps |
| LaunchFactory.lpReceiver.audit.spec.ts | no LP receiver exposed | port | adapter.locker == factory locker; locker admin == factory | – |
| LaunchFactoryGraduationThresholds.spec.ts | 3 tests | port | 11-field request; production curve + $600 | – |
| ScheduledLaunchFactory.spec.ts | 3 tests | port | launch-anchored fee clock 5000/2600/200 | – |
| CreatorArmCooldown.spec.ts | 2 tests | port | fixture only | – |
| IndexerFactoryRegistry.spec.ts | decoded events | pending | see pending table | – |
| bnb-launch-protection.test.ts | authorized buys; no authority; invalid profile; expired; sells gated; wrong signer/action/limit (6) | port | route-auth properties on the trade path of a gen-6 coin | – |
| bnb-launch-protection.test.ts | per-tx buy caps; wallet cap; normal behaviour after expiry (3) | delete | caps and block window removed (E7) | evmgen-core-antisniper > a sniper in the create block pays 5000 bps; evmgen-core-graduation > paused-by-default direct trading is the Safe's exit |
| bnb-launch-safety.test.ts | creator review/cooldown/live count; direct trading blocked; restricted wallets/pauses/cap; route authority + create replay (4) | port | config; escrow replaces lock; create signed with 11 fields | – |
| bnb-launch-safety.test.ts | protected launch blocks and early caps | delete | removed | evmgen-core-antisniper; evmgen-core-graduation > paused-by-default direct trading… |
| Phase6LaunchProtection.spec.ts | direct buys blocked/signed allowed; replay; wrong campaign/chain/profile; sells authorized; expiry & no restart (5) | port | `RouteAuthReplayed`, `BadRouteAuth`, `FactoryLocked` | – |
| Phase6LaunchProtection.spec.ts | per-buy and wallet caps | delete | removed | evmgen-core-antisniper > a sniper in the create block pays 5000 bps |
| phase6-route-authorization.test.ts | 6 tests | port | create signed locally (11 fields), trade via backend helper | – |
| RouteAuthorization.backend.integration.spec.ts | rejects a backend signature when a value changes | port | local create; backend trade signature rejected | – |
| RouteAuthorization.backend.integration.spec.ts / RouteAuthorityVerifier / RouteAuthorityHelperEdges | request hash (3) | pending | BACKEND GAP | – |
| BnbBasicGraduationMarket.spec.ts | 4 tests | port | Pending + `graduate()`; exact 19.8%; LP 80/20; refusing adapter keeps Pending | – |
| BnbCreatorFeeGeneration.spec.ts | 4/3 + V3 router pays 0.10% | port | 4/3 pin is old source (c676ed7f); routing ported to 6/5 + V4 (560 bps) | – |
| BnbFactoryReplacementSecuritySequence.spec.ts | pause/lock/handoff | port | 8400/1400 refused; protection setter absent | evmgen-core-antisniper (protection part) |
| BnbLifecycleCertification.spec.ts | 2 tests | port | V4 + vault V2; 100 bps pool: `graduate()` reverts `InvalidTradingFee`, Pending survives | – |
| BnbQuoteGenerationDeploy.spec.ts | 2 tests | port | rehearsal follows the script (locker first); missing script wiring asserted | – |
| RobinhoodStockCampaignImplementationDeploy / RobinhoodStockFactoryBinding | 2 tests | port | V3 defaults, evmgen doubles | – |
| RobinhoodStockPendingGraduation.spec.ts | 2 tests | port | Pending trigger 0; `StockGraduationConfigLocked`, `OnlyFactory` | – |
| RobinhoodStockGraduationCompletion / RobinhoodV3GraduationAdapter | 2 tests | pending | BLOCKED ON claude/evm-rh | evmgen-core-quote (campaign side) |
| RobinhoodTestnetInfrastructureBootstrap.spec.ts | WETH; oracle (2) | port | now run from local deployments | – |
| RobinhoodTestnetInfrastructureBootstrap.spec.ts | 3 infra tests | env | tool install absent | – |
| evmgen-fees-vault-v3.spec.ts | pool buyback stops at 0.5% impact (nonce-dependent) | fixed in contract | `EvmGenPoolSwap.v3Limit` let zeroForOne move the bought token +0.5025% | evmgen-hardening-locker-binding > V3 impact bound… |

## Findings raised by the migration (not fixed here)

1. Backend create signer on the 7-field request hash (see pending table).
2. No V3 (Robinhood) or real Topaz V2 `IGraduationAdapterV2` in tree; graduation tests run on `MockGraduationAdapterEvmGen`.
3. `scripts/lib/indexerManifest.cjs` lists removed events and misses the new ones.
4. ~~`scripts/deploy-bnb-quote-generation.ts` / `deploy-robinhood-quote-generation.ts` never call `setNativeGraduationAdapter` / `setLaunchTokenDeployer`.~~ Fixed: both require `BNB_NATIVE_GRADUATION_ADAPTER` / `RH_NATIVE_GRADUATION_ADAPTER`, deploy the `LaunchTokenDeployer`, set both and pin the creator vault (`setFactoryOnce`) through `scripts/lib/evmGenerationCreateWiring.ts`, sending what the deployer may and returning the rest as pending owner actions. `BnbQuoteGenerationDeploy.spec.ts` runs the BNB script's `main()` in-process and creates on the result.
5. ~~`assertRouterCanServeStrictRouting` accepts a router whose creator vault lacks `setCampaignChoice`.~~ Fixed: the vault must answer `isKeep/factory/router/dexKind` (CreatorRewardsVaultV2), pay this router, match the chain's DEX kind and be unpinned; refusals tested on both scripts.
6. ~~`error LiquidityBps()` in `LaunchFactory.sol` is unused.~~ Removed (bytecode unchanged).
7. No script deploys TreasuryRouterV4 + CreatorRewardsVaultV2: `deploy-evm-treasury-router-v3.ts` (and the older cutover/testnet-stage scripts) deploy TreasuryRouterV3 with the first-generation `CreatorRewardsVault`, which the tightened guard now refuses.

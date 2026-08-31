# Robinhood Testnet Deployment & Acceptance Runbook

## Purpose

Deploy the complete MemeWarzone Robinhood testnet stack to chain `46630`, including the controlled Uniswap V3-compatible mock contracts, then prove the user-facing lifecycle before Robinhood support is enabled in staging.

Robinhood is a separate MemeWarzone chain. Never reuse BNB contract addresses, campaign inventory, reward state, indexer cursors, or unsuffixed BNB frontend variables.

## Safety model

- Testnet chain ID: `46630`.
- Production chain ID: `4663`.
- Mock V3 and mock USD price-feed contracts are testnet-only and must never be promoted to production.
- `deploy-robinhood-testnet-stage.ts` deploys the core protocol with `LaunchFactory.live() == false` and `createPaused() == true`.
- Independent verification happens before the acceptance runner is allowed to call `enableLive()`.
- Enabling the staged factory requires the explicit `ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=true` guard. That run may `enableLive()` and `setCreatePaused(false)`, then must `setCreatePaused(true)` again.
- `enableLive()` is one-way. Post-acceptance safety is `setCreatePaused(true)`, not pretending the factory can become un-live.
- Local Hardhat rehearsal may set `rehearsalPassed=true` and **must** set `accepted=false`. Only `provider.chainId == 46630` can set `accepted=true`.
- Staging service activation remains separate from on-chain factory acceptance. Keep `ENABLE_ROBINHOOD_CREATION=false` and `VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY=false`.
- Robinhood testnet signing is factory generation **4** / campaign generation **3**. BNB stays campaign generation **2**. Robinhood production `4663` stays fail-closed on campaign generation **2**.

## Deployed stack

Core staged deployment:

- MockWETH9
- MockUniswapV3Factory
- MockUniswapV3PositionManager
- MockUniswapV3SwapRouter
- RobinhoodUniswapV3GraduationAdapter
- MockUsdPriceFeed
- GraduationOracle
- TreasuryVaultV2 weekly league vault
- CharityTreasury
- MonthlyLeagueTreasury
- RecruiterRewardsVault
- ProtocolRevenueVault
- TreasuryRouterV2
- CommunityRewardsVault
- CreatorRegistry
- RiskRegistry
- LaunchCampaign implementation
- LaunchFactory generation 4 / campaign generation 3
- PermanentV3PositionLocker created by LaunchFactory

Auxiliary parity deployment:

- UPVoteTreasury, forwarding testnet vote revenue into ProtocolRevenueVault
- RobinhoodV3NativeSwapAdapter for native ETH post-grad buy/sell

## Required local environment

Never commit real private keys. Hardhat loads `.env` then `config/robinhood.local` (gitignored). Put the 46630 acceptance keys in `config/robinhood.local`:

```text
ROBINHOOD_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
PRIVATE_KEY_DEPLOY=<staging deployer key>
ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY=<staging route authority key>
ROBINHOOD_TEST_CREATOR_PRIVATE_KEY=<funded test creator wallet key>
ROBINHOOD_TEST_SCHEDULED_CREATOR_PRIVATE_KEY=<funded test scheduled-creator wallet key>
ROBINHOOD_TEST_BUYER_PRIVATE_KEY=<funded test buyer wallet key>
ROBINHOOD_TEST_TRADER_PRIVATE_KEY=<funded test post-grad trader wallet key>
ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=false
ROBINHOOD_STAGE_DEPLOYMENT_FILE=deployments/robinhood/testnet.staged.json
```

Keep `ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=false` in the file. Enable it only for the lifecycle command:

```bash
ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=true npx hardhat run scripts/test-robinhood-testnet-lifecycle.ts --network robinhoodTestnet
```

The deployer/admin, creator, buyer, and trader wallets must hold Robinhood testnet ETH. Keep these wallets testnet-only.

## Phase 1 — compile and confirm network

```bash
npm ci
npx hardhat compile
npx hardhat console --network robinhoodTestnet
```

Inside the console, confirm the provider reports chain ID `46630`, then exit. Do not deploy if the chain ID differs.

## Phase 2 — deploy the staged core stack

```bash
export ROBINHOOD_STAGE_DEPLOYMENT_FILE='deployments/robinhood/testnet.staged.json'
export ROBINHOOD_TEST_NATIVE_USD_PRICE='3000'
npx hardhat run scripts/deploy-robinhood-testnet-stage.ts --network robinhoodTestnet
```

The deploy script must finish with self-verification and write the staged manifest. The manifest must report:

- `targetChainId = 46630`
- `factoryGeneration = 4`
- `campaignGeneration = 3`
- `liquidityKind = 2`
- `supportEnabled = false`
- `creationEnabled = false`
- `factoryLive = false`
- `securityDefaultsLocked = true`
- `stagingOnly.productionCompatible = false`

## Phase 3 — independently verify the staged stack

```bash
npx hardhat run scripts/verify-robinhood-testnet-stage.ts --network robinhoodTestnet
```

Do not continue if bytecode, immutable wiring, treasury routing, route authority, registry authorization, graduation adapter, V3 locker, or disabled activation state fails verification.

## Phase 4 — deploy auxiliary parity contracts

```bash
npx hardhat run scripts/deploy-robinhood-testnet-auxiliary.ts --network robinhoodTestnet
```

This appends `upVoteTreasury` to the same staged manifest and verifies ownership, fee receiver, and native-vote support.

## Phase 5 — generate Robinhood frontend contract variables

The shared frontend environment exporter understands Robinhood staged manifests and must produce chain-suffixed `46630` variables only. It must not generate Topaz variables for Robinhood.

Expected variables include:

```text
VITE_FACTORY_ADDRESS_46630
VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_46630
VITE_TREASURY_ROUTER_ADDRESS_46630
VITE_TREASURY_VAULT_ADDRESS_46630
VITE_RECRUITER_REWARDS_VAULT_ADDRESS_46630
VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_46630
VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_46630
VITE_CREATOR_REGISTRY_ADDRESS_46630
VITE_RISK_REGISTRY_ADDRESS_46630
VITE_GRADUATION_ORACLE_ADDRESS_46630
VITE_PERMANENT_LP_LOCKER_ADDRESS_46630
VITE_VOTE_TREASURY_ADDRESS_46630
VITE_LAUNCH_ROUTER_ADDRESS_46630
VITE_ROBINHOOD_V3_FACTORY_ADDRESS_46630
VITE_ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630
VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630
VITE_WRAPPED_NATIVE_ADDRESS_46630
```

Never set `VITE_TOPAZ_*_46630` and never copy unsuffixed BNB contract variables into Robinhood staging.

## Phase 6 — on-chain lifecycle acceptance

Only after Phase 3 verification succeeds:

```bash
export ROBINHOOD_ACCEPTANCE_ENABLE_LIVE='true'
npx hardhat run scripts/test-robinhood-testnet-lifecycle.ts --network robinhoodTestnet
```

The runner must prove, on the same staged deployment:

1. Testnet signer/API resolves factory 4 / campaign 3. BNB and production `4663` stay campaign generation 2.
2. Immediate authorized create.
3. Scheduled create through the same `MWZ_CREATE_SCHEDULED_V2_AUTH` model the API uses.
4. Wrong campaign generation rejected by the signer and by the factory.
5. Wrong chain rejected.
6. Replayed scheduled authorization rejected.
7. Scheduled campaign exists on-chain before `launchAt`.
8. Pre-`launchAt` buy and sell revert with `TradingNotOpen`.
9. Real chain 46630 uses actual clock progression. Local Hardhat may warp; that is rehearsal, not acceptance.
10. Post-`launchAt` buy and sell work on the scheduled campaign.
11. Bonding buy/sell remains correct on the immediate campaign.
12. Graduation enters V3 at the `$6` test threshold.
13. V3 LP position/NFT is permanently locked.
14. Native post-grad buy and native sell use `RobinhoodV3NativeSwapAdapter`.
15. Fee accrual occurs and 80/20 harvest reconciles.
16. DB/indexer records `chain_id=46630` and never aliases to 56.
17. MWL/league identity uses Robinhood as its own chain.
18. Creation is paused again with `setCreatePaused(true)` after the run.
19. Production RH flags remain off. Local rehearsal writes `rehearsalPassed=true`, `accepted=false`. Only `provider.chainId == 46630` may set `accepted=true`.

A failed on-chain item fails the run. Missing DB/indexer continuity on 46630 leaves Batch 5B **OPEN**. Local CI/rehearsal never closes 5B.

After the run, keep `ENABLE_ROBINHOOD_CREATION=false` and `VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY=false`. The factory `live` latch may remain true; creation stays paused.

## Phase 7 — infrastructure wiring

After on-chain acceptance passes:

- Configure a dedicated Robinhood staging database.
- Configure the Robinhood indexer with chain ID `46630` and its own cursor/checkpoint state.
- Configure dedicated Robinhood RPC and failover RPC.
- Configure staging frontend/API origins.
- Configure route-authority signer for chain `46630`.
- Configure the generated chain-suffixed frontend contract variables.
- Keep BNB `56/97` and Solana `101` infrastructure untouched.

## Phase 8 — application acceptance

Test with real wallets against staging, not only Hardhat scripts:

- Select Robinhood independently from BNB and Solana.
- Connect an EVM wallet already on Robinhood testnet.
- Create a draft.
- Publish Prepare Mode.
- Immediate deploy.
- Timed deploy.
- Buy.
- Sell.
- UpVote.
- Watchlist/follow.
- Recruiter attribution and squad tracking.
- Command Center campaign and wallet metadata.
- Weekly/monthly chain-specific league attribution.
- Airdrop/reward attribution by chain ID.
- Graduate at `$6` test threshold.
- Token Details remains continuous through graduation.
- War Trade Room changes from bonding trade to V3 post-grad trade without changing token identity.
- Post-grad buy/sell updates chart, trade feed, volume, price, market cap, liquidity and holder views.
- Fee harvest is indexed and visible to the appropriate accounting surfaces.

## Activation gate

Only after the application acceptance matrix is green may staging set:

```text
ENABLE_ROBINHOOD_CREATION=true
```

Production chain `4663` remains disabled until a separate mainnet deployment and acceptance process uses production DEX/oracle infrastructure. Mock V3 and mock price-feed addresses are forbidden in the mainnet manifest.

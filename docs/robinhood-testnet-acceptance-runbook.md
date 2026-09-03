# Robinhood Testnet Deployment & Acceptance Runbook

## Purpose

Deploy the complete MemeWarzone Robinhood testnet stack to chain `46630`, including the controlled Uniswap V3-compatible mock contracts, then prove the user-facing lifecycle before Robinhood support is enabled in staging.

Robinhood is a separate MemeWarzone chain. Never reuse BNB contract addresses, campaign inventory, reward state, indexer cursors, or unsuffixed BNB frontend variables.

## Safety model

- Testnet chain ID: `46630`.
- Production chain ID: `4663`.
- Mock V3 and mock USD price-feed contracts are testnet-only and must never be promoted to production.
- `deploy-robinhood-testnet-stage.ts` deploys the core protocol with `LaunchFactory.live() == false`.
- Independent verification happens before the acceptance runner is allowed to call `enableLive()`.
- Enabling the staged factory requires the explicit `ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=true` guard.
- Staging service activation remains separate from on-chain factory acceptance. Keep `ENABLE_ROBINHOOD_CREATION=false` until the complete acceptance checklist passes.

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
- LaunchFactory generation 4
- PermanentV3PositionLocker created by LaunchFactory

Auxiliary parity deployment:

- UPVoteTreasury, forwarding testnet vote revenue into ProtocolRevenueVault

## Required local environment

Never commit real private keys. Configure them in the shell/secret manager:

```bash
export ROBINHOOD_TESTNET_RPC_URL='https://rpc.testnet.chain.robinhood.com'
export PRIVATE_KEY_DEPLOY='<staging deployer key>'
export ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY='<staging route authority key>'
export ROBINHOOD_TEST_CREATOR_PRIVATE_KEY='<funded test creator wallet key>'
export ROBINHOOD_TEST_BUYER_PRIVATE_KEY='<funded test buyer wallet key>'
export ROBINHOOD_TEST_TRADER_PRIVATE_KEY='<funded test post-grad trader wallet key>'
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
- `campaignGeneration = 2`
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

1. Generation-4 signed campaign creation.
2. Authorized pre-graduation buy.
3. Authorized pre-graduation sell.
4. Graduation using the Robinhood `$6` test threshold.
5. V3 pool creation through the controlled mock factory.
6. V3 position NFT permanently owned by PermanentV3PositionLocker.
7. Post-graduation swap through the mock V3 swap router.
8. V3 fees accrue and harvest successfully.
9. Harvest splits exactly 80% creator / 20% protocol.
10. Position NFT remains permanently locked after harvest.

A failed item blocks staging activation.

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

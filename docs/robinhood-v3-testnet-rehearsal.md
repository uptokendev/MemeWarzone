# Robinhood Chain Uniswap V3 staging rehearsal

Status: RH-5 staging foundation. This document describes the deterministic Uniswap V3-compatible mock DEX used only on Robinhood Chain testnet (chain ID `46630`).

## Why a mock V3 stack exists

Robinhood Chain mainnet has official Uniswap deployments, but MemeWarzone needs a permanent staging venue that we control and can reset without depending on production liquidity or third-party testnet deployments. This mirrors the existing BNB Topaz rehearsal pattern.

The staging DEX is intentionally minimal. It tests MemeWarzone's integration contract, not Uniswap's implementation correctness.

## Contracts

- `MockWETH9`: WETH9-compatible native wrapper for test ETH.
- `MockUniswapV3Factory`: deterministic V3-style factory with the standard 0.05%, 0.30% and 1.00% fee-tier spacings. MemeWarzone uses 0.30% (`3000`).
- `MockUniswapV3Pool`: one-position-per-pool deterministic reserve engine with initialization, exact-input swaps and fee accrual.
- `MockUniswapV3PositionManager`: NFT position manager surface used by the graduation adapter and permanent position locker.
- `MockUniswapV3SwapRouter`: `SwapRouter02`-style `exactInputSingle` path used for post-graduation staging trades.
- `RobinhoodUniswapV3GraduationAdapter`: compatibility adapter that lets the unchanged MemeWarzone `LaunchCampaign` graduation ABI mint a full-range V3 NFT position.
- `PermanentV3PositionLocker`: permanent NFT custody and fee-only harvest boundary. Liquidity principal has no transfer, approval, decrease-liquidity, burn, migration, or rescue path.

## What this proves

The rehearsal must prove all of the following before Robinhood creation is enabled:

1. A token/WETH V3 pool can be created and initialized.
2. Graduation liquidity is represented by an NFT position rather than an ERC-20 LP token.
3. The position owns real staging reserves.
4. Test swaps move those reserves and charge the configured 0.30% fee.
5. Swap fees accrue to the graduation position and can be collected independently of principal.
6. The permanent locker remains owner of the NFT and the recorded V3 liquidity cannot change during harvest.
7. Harvest preserves the MemeWarzone LP revenue split: 80% creator, 20% protocol.
8. The current `LaunchCampaign` can graduate through the compatibility adapter without Robinhood-specific source or bytecode changes.
9. Robinhood staging contracts are never accepted as production deployment contracts.

The mock does **not** emulate concentrated-liquidity tick traversal, oracle observations, flash loans or arbitrary multi-position fee distribution. Those are Uniswap responsibilities and must be covered by later fork/ABI compatibility tests against the official Robinhood mainnet Uniswap contracts.

## Testnet configuration

Hardhat network: `robinhoodTestnet`

Required environment values:

- `ROBINHOOD_TESTNET_RPC_URL`: dedicated Robinhood Chain testnet RPC endpoint.
- `PRIVATE_KEY_DEPLOY` (or `DEPLOYER_PK`): staging-only funded deployer key.

These values belong only in the permanent staging environment. Do not reuse production secrets.

## Deployment and verification

Deploy the minimal V3 test stack and graduation adapter:

```bash
npx hardhat run scripts/deploy-robinhood-v3-mock.ts --network robinhoodTestnet
```

The deploy script refuses any public chain other than `46630`, deploys the mock factory/WETH/position manager/swap router plus graduation adapter, self-verifies all wiring and the 0.30% fee tier, and then writes:

`deployments/robinhood/testnet-v3-mock.json`

Verify an existing persistent deployment independently:

```bash
npx hardhat run scripts/verify-robinhood-v3-mock.ts --network robinhoodTestnet
```

The verifier requires chain `46630`, deployed bytecode at every recorded address, correct factory/periphery/adapter wiring, fee tier `3000`, tick spacing `60`, and `productionCompatible=false`.

CI may exercise the deployment script against an ephemeral local Hardhat network only when `ALLOW_LOCAL_RH_V3_MOCK=true`. That local override does not permit deployment to any other public chain.

## Promotion rule

Production does not promote these mock contracts. Production promotes only the MemeWarzone adapter/locker/factory source commit that passed this rehearsal and then binds that same accepted code to the verified official Uniswap V3 contracts on Robinhood mainnet.

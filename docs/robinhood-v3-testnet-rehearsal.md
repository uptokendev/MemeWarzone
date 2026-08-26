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

## What this proves

The rehearsal must prove all of the following before Robinhood creation is enabled:

1. A token/WETH V3 pool can be created and initialized.
2. Graduation liquidity is represented by an NFT position rather than an ERC-20 LP token.
3. The position owns real staging reserves.
4. Test swaps move those reserves and charge the configured 0.30% fee.
5. Swap fees accrue to the graduation position and can be collected independently of principal.
6. An account that does not own/hold approval for the position cannot move the NFT.
7. Robinhood staging contracts are never accepted by a production deployment manifest.

The mock does **not** emulate concentrated-liquidity tick traversal, oracle observations, flash loans or arbitrary multi-position fee distribution. Those are Uniswap responsibilities and must be covered by later fork/ABI compatibility tests against the official Robinhood mainnet Uniswap contracts.

## Deployment rule

Run `scripts/deploy-robinhood-v3-mock.ts` only on Robinhood Chain testnet (`46630`). The script refuses other public chain IDs. Local Hardhat use requires `ALLOW_LOCAL_RH_V3_MOCK=true`.

The generated `deployments/robinhood/testnet-v3-mock.json` is staging-only evidence. Its addresses must never be copied into the Robinhood production manifest.

## Promotion rule

Production does not promote these contracts. Production promotes only the MemeWarzone adapter/locker build that passed this rehearsal and then binds that same accepted code to the verified official Uniswap V3 contracts on Robinhood mainnet.

# Robinhood RH-4 — EVM Contract Chain-Assumption Audit

Date: 2026-08-26
Branch: `feat/robinhood-chain-phase0-3`
Audited against current `main`: `fc5887f84b48c18b630622094c9d3b047ac4c429`

## Rule

This phase is classification first. Do not change protocol rules while discovering BNB/Topaz assumptions.

Classifications:

- **PROTOCOL RULE** — must remain equivalent on every chain.
- **CHAIN INTEGRATION** — belongs behind a chain/DEX adapter or deployment profile.
- **TEST-ONLY** — staging-only behavior that must be environment-gated.
- **NAMING / ABI LEGACY** — BNB terminology that may remain for existing generations if changing it adds migration risk.
- **OBSOLETE** — removable only after independent proof; none classified yet.

## Executive finding

The current contracts are mostly chain-neutral for bonding, authorization, risk, scheduling, treasury routing, and creator protections. The principal hard coupling is the graduation/liquidity subsystem:

1. `LaunchFactory` configures its permanent locker from a Topaz router/factory.
2. `LaunchCampaign` directly imports Topaz router/factory interfaces and performs Topaz-style liquidity creation and pool lookup.
3. `PermanentLpLocker` directly validates Topaz pool/factory/fee semantics and calls Topaz `claimFees()`.

Robinhood must not be implemented by adding `if (block.chainid == 4663)` branches to those contracts. The accepted direction is an external graduation/DEX boundary with chain-specific implementations.

## LaunchFactory.sol

### PROTOCOL RULE — keep

- One campaign implementation per factory generation.
- Route-authorized creation.
- Replay protection.
- Creator eligibility and risk enforcement.
- Scheduled launch evidence and immutable launch timing.
- Graduation target allowlist concept.
- Factory generation / campaign generation binding.
- Permanent-liquidity custody requirement.
- `block.chainid` in authorization/domain material. This is desirable replay-domain separation and must remain chain-aware.

### TEST-ONLY — refactor before Robinhood testnet activation

Current test graduation allowlist contains a direct chain assumption:

- `$6` is accepted only when `chainId == 97`.

Robinhood staging requires the same test-tier product rule on chain `46630`, while production must reject it. Do not simply add `|| chainId == 46630` repeatedly across contracts and frontend code. Resolve test-tier availability from an immutable/deployment-time environment or approved-target profile, with production deployment verification proving the test tier is impossible.

### CHAIN INTEGRATION — extract

The constructor currently accepts a Topaz router, stores it as `router`, creates `PermanentLpLocker`, and configures locker revenue using `ITopazRouter02(topazRouter_).poolFactory()`.

This makes factory construction aware of the BNB graduation venue. The factory should instead receive an approved graduation integration/profile whose configuration can be verified independently.

## LaunchCampaign.sol

### PROTOCOL RULE — keep identical

- Bonding-curve math and generation-owned economics.
- Net-raised accounting.
- Buy/sell fee semantics.
- Treasury route profiles.
- Creator buy lock and cap.
- Wallet risk enforcement.
- Scheduled trading-open rule.
- Graduation threshold semantics.
- Graduation overshoot behavior.
- Price-continuity/tolerance requirement.
- Creator payout semantics.
- Supply burn/retirement semantics where required by the accepted generation.
- `block.chainid` inside trade-authorization digest. This is security-domain binding, not BNB coupling.

### CHAIN INTEGRATION — highest-priority extraction

The current campaign directly imports:

- `ITopazRouter02`
- `ITopazV2Factory`

and graduation directly performs:

- router token approval;
- `addLiquidityETH(..., stable=false, ...)`;
- Topaz-style LP receipt;
- `router.poolFactory()` lookup;
- `router.WETH()` lookup;
- `ITopazV2Factory(...).getPool(token, wrappedNative, false)`.

This is the main contract obstacle to clean Robinhood reuse.

**Required RH direction:** `LaunchCampaign` should invoke a compact graduation interface and receive normalized results such as used token amount, used native amount, locked-position/LP amount, and canonical pool address. Topaz-specific pool creation/lookup stays in the BNB adapter; Robinhood-specific DEX mechanics stay in the Robinhood adapter.

Because the campaign has historically operated near the internal bytecode limit, the extraction should reduce or hold campaign bytecode rather than add Robinhood branches.

### NAMING / ABI LEGACY

Existing BNB-facing state/events use names such as:

- `graduatedLiquidityBnb`
- `minBnb`
- `usedBnb`

These values semantically represent the chain-native asset. Renaming existing-generation ABI fields is not required for Robinhood and may create needless compatibility work. New normalized backend/public APIs should use native-asset terminology even if legacy BNB ABI names remain supported.

## PermanentLpLocker.sol

### PROTOCOL RULE — keep

- Graduation principal cannot be withdrawn.
- Principal integrity is checked before/after fee harvest.
- Creator/protocol fee rights remain claimable/routable.
- Failed payouts remain safely pending.
- Only approved graduation pools/positions may be registered.
- Pool/token pair must match the expected graduated market.

### CHAIN INTEGRATION — extract or implement per DEX generation

The current locker is explicitly Topaz-specific:

- `ITopazPoolFeeSource.claimFees()`
- Topaz pool `stable()` requirement
- Topaz `factory()` validation
- Topaz factory `getFee()` validation
- hard expectation of the live Topaz volatile-pool fee
- `topazFactory` storage and Topaz-specific errors/events/comments

Robinhood must not weaken those checks. It needs equivalent DEX-native verification through either:

1. a generic locked-position/fee-source adapter accepted by the locker, or
2. a Robinhood-specific locker implementation behind the same product-level custody/harvest interface.

Choice depends on the actual Robinhood graduation DEX primitive and should be decided in RH-5 after its contracts are verified.

## TopazRouterAdapter.sol

### CHAIN INTEGRATION — useful existing pattern

The repository already contains an immutable `TopazRouterAdapter` that translates production Topaz ABI into MemeWarzone's expected router interface and caches the pool factory and wrapped-native asset.

This proves the adapter pattern is already accepted in the codebase. RH-5 should extend that architectural idea upward into a graduation interface rather than cloning Topaz semantics into Robinhood code.

## Mocks / tests

### TEST-ONLY

- `MockTopazRouter.sol`
- `MockTopazPool.sol`
- `MockWBNB.sol`
- related Topaz-specific fixtures

Keep these for BNB regression. Do not rename/remove them merely for multichain aesthetics. Add parallel adapter-level Robinhood fixtures later.

## Chain-ID findings

### Keep

`block.chainid` used in signed authorization hashes and deterministic uniqueness/domain inputs is correct and should remain. It prevents cross-chain replay/collision.

### Replace as environment/profile logic

Direct business-policy checks such as `chainId == 97` for test graduation are deployment-environment concerns, not protocol identity. Robinhood testnet needs equivalent staging behavior without proliferating test-chain conditionals.

## RH-5 implementation boundary proposed by this audit

Do **not** edit `LaunchCampaign` yet.

First define a minimal adapter contract/interface outside the campaign, conceptually:

```solidity
interface IGraduationAdapter {
    struct Result {
        uint256 usedTokens;
        uint256 usedNative;
        uint256 lockedPositionAmount;
        address canonicalPool;
    }

    function graduate(
        address token,
        uint256 tokenAmount,
        uint256 nativeAmount,
        uint256 minTokens,
        uint256 minNative,
        address lockedLiquidityReceiver
    ) external payable returns (Result memory result);
}
```

The exact ABI is not locked by this audit; it must be optimized for safety and campaign bytecode size before implementation.

Then:

- BNB implementation wraps Topaz.
- Robinhood implementation wraps the approved Robinhood DEX.
- Campaign verifies normalized graduation invariants.
- Locker/position subsystem verifies permanent principal and fee rights.
- Backend/indexer resolves DEX-specific event semantics separately.

## No-change list from this audit

Do not change these merely because Robinhood is EVM:

- bonding curve;
- 2% protocol fee envelope/current routed economics;
- creator safety model;
- route authorization/replay protection;
- risk/cluster enforcement;
- scheduled-launch semantics;
- ticker binding;
- production graduation tiers;
- treasury reward profiles;
- creator/recruiter/squad identity rules;
- post-grad continuity requirement.

## Gate before RH-5 contract edits

- RH-3 BNB/frontend regression gate green.
- Current `main` rechecked for contract changes.
- Current contract-size evidence recorded.
- Robinhood graduation DEX contracts verified.
- Adapter ABI reviewed against both BNB Topaz and Robinhood DEX requirements.
- No product/economic rule changes hidden inside chain integration work.

# DogeOS MuchFi variant contracts — audit diffs (gate 2)

**Subjects (all under `contracts/dogeos/muchfi/`, branch `feat/dogeos-testnet`):**

| # | Variant | Original (frozen) | Variant commit |
|---|---|---|---|
| 1 | `MuchfiPoolSwap.sol` | `contracts/EvmGenPoolSwap.sol` | `a5b9b03c1` (t32) |
| 2 | `MuchfiV3PositionLocker.sol` | `contracts/PermanentV3PositionLocker.sol` | `a5b9b03c1` (t32) |
| 3 | `MuchfiCreatorRewardsVault.sol` | `contracts/CreatorRewardsVaultV2.sol` | `39df4b8f8` (t33) |
| 4 | `MuchfiV3PoolRepair.sol` + `MuchfiV3NativeGraduationAdapter.sol` | `contracts/integrations/RobinhoodV3PoolRepair.sol` + `contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol` | `fc280f55b` (t31) |

**Baselines:** every original is byte-identical to the branch point `6c5ca159a` (2026-10-09): `git diff --stat 6c5ca159a -- contracts/EvmGenPoolSwap.sol contracts/PermanentV3PositionLocker.sol contracts/CreatorRewardsVaultV2.sol contracts/integrations contracts/gen7 contracts/interfaces` is empty. The originals stay deployed on BNB and Robinhood and are not touched by this branch.
**Plan:** `docs/templar/plans/2026-10-10-dogeos-foundation-launch.md`, Task 34; spec `docs/templar/specs/2026-10-10-dogeos-foundation-launch-design.md` §1 "Graduation venue: MuchFi CLMM" and "MuchFi variant contracts"; gate 2.
**Rule applied:** CLAUDE.md §1 "Contracts are written to pass a real audit on the first pass": reentrancy guard, checks-effects-interactions, reachable states, over/underflow, griefing, stated per money path; a variant is audited as a diff before it is tested and tested before it is deployed. All four variants hold or move money (LP principal and fees, creator/holder/buyback balances, the graduation budget), so each gets the full treatment.
**Date:** 2026-10-10. Written as an external auditor would; each verdict is allowed to be FAIL, and a FAIL blocks t6.

**Method.** For each variant: `diff -u --strip-trailing-cr <original> <variant>` (the originals are CRLF in the working tree, the variants LF; the flag removes that noise so only semantic lines show), every hunk classified; then the five CLAUDE.md audit points, the trust model (MuchFi's unverified bytecode, the owner-settable protocol fee and LM-pool hook, callback-caller validation), the fork-test coverage, and a verdict. The spec's rule for the variants is "no other logic change: the callback body, checks and accounting stay byte-for-byte the original's logic; the only substitution inside them is the MuchFi pool-swap library"; the plan's enumerated changes are: callback name, `slot0` `uint32`, fee 10000 / spacing 200 and the full-range ticks where the original hard-codes 3000 / 60, and the library substitution. A hunk outside that list is a finding unless it is NatSpec or a rename the file name implies.

**Fork runs behind this document (2026-10-10, `hardhat.dogeos-testnet-fork.config.ts`, fork of Chikyū at latest−16, nothing broadcast).** `test/MuchfiHarvestGas.fork.spec.ts` (new): 2/2 passing. The four existing specs run together in one process: 37 of 39 tests observed passing with 0 failures (facts 8/8, locker 7/7, vault 6/6, adapter 16 of 18) before the session harness stopped the process for low host memory; the two not reached are the adapter's "MEME>WDOGE" variants of "pre-created at 1000x with WDOGE bids" and "chunked repairStep then graduate", whose MEME<WDOGE twins passed in the same run and which passed in t31's own run per its commit. They were not re-run here (the harness asked not to restart under memory pressure); t6 should run `test/MuchfiGraduationAdapter.fork.spec.ts` alone once before relying on it.

**Scope note.** This audit covers the four variants and the way they consume MuchFi. It does not re-audit gen-7 or the originals (unchanged, see Baselines); where the variant's behaviour is "unchanged vs original" that claim is backed by the diff, not re-derived. The off-chain pieces (indexer decoding of the PancakeV3-shaped `Swap` event, frontend trade path, keeper) are other tasks.

---

## 0. Shared on-chain facts (read-only, Chikyū 6281971)

Read with `eth_call` against `https://rpc.testnet.dogeos.com` at block 8,462,680 on 2026-10-10 (script in the session scratchpad; nothing was signed or sent). Selectors are `keccak256(signature)[:4]`.

| Fact | Call | Value |
|---|---|---|
| Factory owner | `factory.owner()` (`0x8da5cb5b`) | `0xDa4dD6614fb07F4Eececa864b4Ff9E8e4C3B0056` (an EOA; also the deployer of every MuchFi contract) |
| LM pool deployer | `factory.lmPoolDeployer()` (`0x5e492ac8`) | `0x0000000000000000000000000000000000000000` |
| Pool deployer | `factory.poolDeployer()` | `0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348` |
| Tier 10000 | `factory.feeAmountTickSpacing(10000)` | `200` |
| Tier 3000 | `factory.feeAmountTickSpacing(3000)` | `0` (not enabled; the originals' tier) |
| Tier 10000 creation policy | `factory.feeAmountTickSpacingExtraInfo(10000)` | `(whitelistRequested=false, enabled=true)`: permissionless |
| A real 1% pool | `PoolCreated` in tx `0x552d703a…` (a MuchFi launchpad graduation, 2026-10-06) | `0x9d0833f03F1934f665358b23165E395224F7ad34`, token0 `0x4597…45Ca`, token1 WDOGE, fee 10000, spacing 200 |
| Its `slot0()` | `pool.slot0()` | `sqrtPriceX96 167620298238897929160187357, tick -123174, obs 0/1/1, feeProtocol 209718400, unlocked true`; raw word 6 = `0x0c800c80` |
| `feeProtocol` decoded | `209718400 = 3200 \| 3200 << 16` | 32% of LP fees per side (PancakeV3 `PROTOCOL_FEE_DENOMINATOR` 10000) |
| Its `lmPool()` | `pool.lmPool()` (`0x540d4918`) | `0x0000…0000` |
| Its `protocolFees()` | `pool.protocolFees()` | `(0, 191999999999999999)`: 0.192 WDOGE accrued to MuchFi, uncollected |
| Its `factory()` / `fee()` / `liquidity()` | | the factory above / `10000` / `49043148664919125040755` |
| Owner-only selectors present in the factory bytecode | PUSH4 scan | `setFeeProtocol(address,uint32,uint32)` `0x7e8435e6`, `setLmPoolDeployer(address)` `0x80d6a792`, `setLmPool(address,address)` `0x11ff5e8d`, `setOwner(address)` `0x13af4035`, `collectProtocol(address,address,uint128,uint128)` `0x43db87da`, `lmPoolDeployer()` `0x5e492ac8` |
| Selectors present in the pool bytecode | PUSH4 scan | `setFeeProtocol(uint32,uint32)` `0xb0d0d211`, `setLmPool(address)` `0xcc7e7fa2`, `lmPool()` `0x540d4918`, `collectProtocol(address,uint128,uint128)` `0x85b66729`, **`muchfiV3SwapCallback(int256,int256,bytes)` `0xe98f1458`**; **absent:** `uniswapV3SwapCallback` `0xfa461e33`, `pancakeV3SwapCallback` `0x23a69e75` |
| Code sizes | `eth_getCode` | factory 4,815 B, pool 22,718 B, NPM 24,466 B, PoolDeployer 24,421 B: full contracts, not EIP-1167 stubs (the CLOB router/poolManager are 291-byte proxies; the V3 set is not). Whether they delegate internally cannot be excluded without source. |
| Verified source | Blockscout / L2Scan | none, for any MuchFi contract (`is_verified:false`; "Contract source code not verified") |

These facts are the ground the variants stand on; every one that a contract depends on is also pinned by `test/MuchfiFork.facts.spec.ts` against the real bytecode on a fork (fee tiers, `slot0` layout and the `uint8` decode revert, the callback name, the PoolDeployer CREATE2 address, the `Swap` event shape with the 32% protocol cut, SmartRouter `exactInputSingle`).

---

## 1. `MuchfiPoolSwap` vs `EvmGenPoolSwap`

### Diff

```
diff -u --strip-trailing-cr contracts/EvmGenPoolSwap.sol contracts/dogeos/muchfi/MuchfiPoolSwap.sol
```

```diff
--- contracts/EvmGenPoolSwap.sol	2026-10-10 10:46:15.560161900 +0200
+++ contracts/dogeos/muchfi/MuchfiPoolSwap.sol	2026-10-10 15:23:19.738319600 +0200
@@ -33,7 +33,7 @@
             uint16 observationIndex,
             uint16 observationCardinality,
             uint16 observationCardinalityNext,
-            uint8 feeProtocol,
+            uint32 feeProtocol, // MuchFi (PancakeV3) pools: uint32 (both sides packed), not uint8
             bool unlocked
         );
     function observe(uint32[] calldata secondsAgos)
@@ -51,7 +51,7 @@
     function withdraw(uint256 amount) external;
 }
 
-/// @title EvmGenPoolSwap
+/// @title MuchfiPoolSwap: DogeOS MuchFi copy of EvmGenPoolSwap; the only code change is the uint32 slot0 feeProtocol
 /// @notice Price-impact and TWAP bounded single-pool swaps shared by the permanent lockers (E9: MEME-side
 /// LP fees sold for the paired asset) and CreatorRewardsVaultV2 (buyback, quote->native conversion).
 /// @dev Internal library: inlined into each caller, no linking, no storage of its own.
@@ -70,7 +70,7 @@
 /// What bounds d is the TWAP guard (skip when spot is worse than the pool's TWAP by more than
 /// maxTwapDevBps; fails CLOSED when the pool cannot serve a TWAP): an LP attacker's edge is then at most
 /// ~maxTwapDevBps of one bounded sale.
-library EvmGenPoolSwap {
+library MuchfiPoolSwap {
     using SafeERC20 for IERC20;
 
     uint256 internal constant BPS = 10_000;
@@ -160,7 +160,7 @@
         } catch {}
     }
 
-    /// @notice Exact-input V3 swap up to the price limit. The caller's uniswapV3SwapCallback pays.
+    /// @notice Exact-input V3 swap up to the price limit. The caller's muchfiV3SwapCallback pays.
     /// @return spent input actually taken by the pool (<= amountIn); out output sent to `recipient`.
     function v3Swap(address pool, bool zeroForOne, uint256 amountIn, uint160 limit, address recipient)
         internal
```

Four hunks. Everything outside them is byte-identical after CR stripping: `IEvmGenV2Pool`, the rest of `IEvmGenV3Pool` (`token0`, `token1`, `fee`, `observe`, `increaseObservationCardinalityNext`, `swap`), `IEvmGenWrappedNative`, the constants (`BPS`, `MIN_SQRT_RATIO_PLUS_ONE`, `MAX_SQRT_RATIO_MINUS_ONE`), `v2Plan`, `feeScaledImpact`, `v2Execute`, `v3Limit`, `v3TwapTick`, `v3Swap`, `v3PayOwed`.

| Hunk | Change | Enumerated? | Classification |
|---|---|---|---|
| 1 (interface) | `uint8 feeProtocol` → `uint32 feeProtocol` in the `slot0()` return tuple, plus a trailing comment | Yes (`slot0` `uint32`) | **Required.** The only consumer of the tuple is `v3Limit`, which destructures `(sqrtP, tick, , , , , )` and discards the sixth word: no arithmetic, no branch, no storage touches it. The change is purely in the ABI decoder. Solidity's return-data decoder validates that a `uint8` word has no high bits set, so the original reverts (empty reason) on MuchFi's `209718400`; the fork test `MuchfiForkSlot0Probe.feeProtocolAsUint8` proves that revert and `feeProtocolAsUint32` the decode. If MuchFi ever returned a different layout again, the decoder would revert and every caller fails closed (locker: the sale reverts inside its `try` and the MEME is carried; vault: the operator's buyback reverts; adapter: the graduation reverts). |
| 2 (`@title`) | title and provenance line | No (NatSpec) | Acceptable; states the one code change truthfully. |
| 3 (name) | `library EvmGenPoolSwap` → `library MuchfiPoolSwap` | Implied by the file name | Required: both compile in one Hardhat project. Internal library, inlined, no linking, so the name is not part of any deployed ABI. |
| 4 (`v3Swap` `@notice`) | "uniswapV3SwapCallback" → "muchfiV3SwapCallback" | No (NatSpec) | Acceptable and truthful: the pool really calls that name (fact table). |

**Stale NatSpec left in the copy (known-stale, no bytecode effect; NatSpec is not compiled and `bytecodeHash: none`):** the `@notice` still names "CreatorRewardsVaultV2" as the buyback consumer (on DogeOS it is `MuchfiCreatorRewardsVault`); the sandwich-economics `@dev` says the attacker "pays the pool fee (0.30%) twice" (on MuchFi's 1% tier it pays 1% twice, which only strengthens the argument); `feeScaledImpact`'s doc example "3000 = 0.30%" is generic and still correct. Recommendation: a NatSpec-only cleanup commit before explorer verification, not required for this gate.

### Reentrancy

Unchanged vs original, by diff. The library holds no storage and makes two kinds of external calls: `view` reads (`slot0`, `observe`, `token0`, `getReserves`, …, STATICCALLs that cannot re-enter) and the two swap entries (`v2Execute`, `v3Swap`). `v3Swap` calls `pool.swap`, which calls back into the *caller's* `muchfiV3SwapCallback`; the guard against misuse of that callback is the caller's (`activeSwapPool` / `_active.pool`, sections 2–4), not the library's, exactly as in the original. During the callback the pool holds its own `lock`, so the callback cannot re-enter the pool.

### CEI

Unchanged. `v3PayOwed` is check (`owedSigned > 0 && uint256(owedSigned) <= maxPay`) then interaction (`safeTransfer` to `msg.sender`). `v3Swap` is interaction then pure post-processing of the returned deltas. `v2Plan` is a pure plan; `v2Execute` pays then swaps, with the pair's own K check enforcing the price (original's design).

### Reachable states

None: a stateless internal library. Its callers' states are analysed in their sections.

### Overflow

Unchanged. In `v3Limit`, `uint256(sqrtP) * (r + 1)`: `sqrtP < 2^160`, `r ≤ sqrt(1.005e18) ≈ 1.0025e9 < 2^30`, product `< 2^190`; the `Math.sqrt` argument is at most `1.005e18 · 1e14`-scale values, well inside `uint256`; the clamps to `MIN_SQRT_RATIO_PLUS_ONE` / `MAX_SQRT_RATIO_MINUS_ONE` keep every limit strictly inside the pool's `(MIN, MAX)` so `SPL` is unreachable. The `uint32` adds no arithmetic. `feeScaledImpact(50, 10000) = min(50, 10000 / 60 = 166) = 50`: on the 1% tier the impact bound stays 50 bps, as on the 0.30% tier (`min(50, 50) = 50`). `v3Swap`'s `require(amountIn <= int256.max)` is unchanged. `v3TwapTick`'s floor division on a negative delta is unchanged.

### Griefing

Unchanged in mechanism. The bound is the pool's own price limit (partial fill, no revert). The TWAP guard fails closed when the pool cannot serve the window. MuchFi-specific economics: the sandwich attacker on a 1% tier pays ~3.3× more fee per unit of price moved than on 0.30%, so the "plain sandwich loses for every d" claim holds with more margin; the "LP who earns its own fees back" residual (audit 3 M2) is unchanged and still bounded by the callers' TWAP guard (vault) or by one bounded sale per block (locker, which runs with `twapWindow = 0` as the original does).

### Trust model

The library trusts whatever pool address its caller passes; the callers bind that address (sections 2–4). It reads `slot0` and `observe` from unverified bytecode: a lying `sqrtPriceX96` would mis-place the limit, but a limit is only ever a *cap* on price movement the pool itself enforces, and the pool enforcing a lie against its own state is the pool defrauding itself. `feeProtocol`, the one field MuchFi's owner can change per pool, is discarded; no path in this library depends on it.

### Test coverage (audit view)

Exercised on the real bytecode by all three consumer fork specs (`MuchfiPositionLocker.fork.spec.ts`: a bounded MEME sale within 0.50%; `MuchfiCreatorRewardsVault.fork.spec.ts`: a buyback stopped at the 0.50% bound with the remainder unfilled, the TWAP guard refusing a pumped spot and accepting it after the window) and by `MuchfiFork.facts.spec.ts` (the `uint8` vs `uint32` decode). The V2 branch (`v2Plan`/`v2Execute`) is unreachable on DogeOS (section 3, dexKind) and is not fork-tested there; it is unchanged code.

Verdict: PASS

---

## 2. `MuchfiV3PositionLocker` vs `PermanentV3PositionLocker`

### Diff

```
diff -u --strip-trailing-cr contracts/PermanentV3PositionLocker.sol contracts/dogeos/muchfi/MuchfiV3PositionLocker.sol
```

```diff
--- contracts/PermanentV3PositionLocker.sol	2026-10-10 10:46:15.568324600 +0200
+++ contracts/dogeos/muchfi/MuchfiV3PositionLocker.sol	2026-10-10 15:23:19.766038400 +0200
@@ -6,7 +6,7 @@
 import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
 import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
 import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
-import {EvmGenPoolSwap} from "./EvmGenPoolSwap.sol";
+import {MuchfiPoolSwap} from "./MuchfiPoolSwap.sol";
 
 interface IRobinhoodV3LockerIntegration {
     function liquidityKind() external view returns (uint8);
@@ -54,7 +54,9 @@
     function routeLpToken(address token, uint256 amount) external;
 }
 
-/// @notice Permanent locker for MemeWarzone Robinhood Chain Uniswap V3 graduation positions.
+/// @notice Permanent locker for MemeWarzone DogeOS MuchFi V3 graduation positions. MuchFi variant of
+/// PermanentV3PositionLocker: muchfiV3SwapCallback instead of uniswapV3SwapCallback and MuchfiPoolSwap instead of
+/// EvmGenPoolSwap (MuchFi pools return slot0.feeProtocol as uint32); nothing else differs.
 /// @dev The locker deliberately exposes no NFT transfer, approve, decrease-liquidity, burn,
 /// migration or rescue path. Principal remains in the position forever; only earned fees can move.
 /// EVM launch generation (E9, docs/evm-launch/spec/C1-C6-fees.md): every harvest sells the MEME-side fees
@@ -67,7 +69,7 @@
 /// does: below MIN_SALE_GAS at the sale it reverts InsufficientSaleGas instead of carrying). Creator and
 /// protocol are paid in the paired asset only: WETH on native pools, the stock token on stock-bound pools,
 /// both through today's paths (creator transfer with pending fallback, protocol via routeLpToken).
-contract PermanentV3PositionLocker is IERC721Receiver, ReentrancyGuard {
+contract MuchfiV3PositionLocker is IERC721Receiver, ReentrancyGuard {
     using SafeERC20 for IERC20;
 
     uint8 public constant REQUIRED_LIQUIDITY_KIND = 2;
@@ -129,7 +131,7 @@
     /// @notice Block of the pool's last MEME sale attempt: one sale per pool per block, so a loop of the
     /// permissionless harvest in one transaction cannot compound the bound (audit 4 M1).
     mapping(address => uint256) public lastSaleBlock;
-    // In-flight V3 swap, checked by uniswapV3SwapCallback; zero outside sellMemeForPaired.
+    // In-flight V3 swap, checked by muchfiV3SwapCallback; zero outside sellMemeForPaired.
     address private activeSwapPool;
     uint256 private activeSwapMaxPay;
 
@@ -405,21 +407,21 @@
     function sellMemeForPaired(address pool, bool memeIs0, uint256 amount) external returns (uint256 sold, uint256 out) {
         if (msg.sender != address(this)) revert OnlySelf();
         (bool ok, uint160 limit) =
-            EvmGenPoolSwap.v3Limit(pool, memeIs0, MEME_SALE_MAX_IMPACT_BPS, 0, 0);
+            MuchfiPoolSwap.v3Limit(pool, memeIs0, MEME_SALE_MAX_IMPACT_BPS, 0, 0);
         if (!ok) return (0, 0);
         activeSwapPool = pool;
         activeSwapMaxPay = amount;
-        (sold, out) = EvmGenPoolSwap.v3Swap(pool, memeIs0, amount, limit, address(this));
+        (sold, out) = MuchfiPoolSwap.v3Swap(pool, memeIs0, amount, limit, address(this));
         activeSwapPool = address(0);
         activeSwapMaxPay = 0;
     }
 
     /// @notice Pays the pool during sellMemeForPaired only. Any other caller or time reverts.
-    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
+    function muchfiV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
         if (msg.sender != activeSwapPool || msg.sender == address(0)) revert UnexpectedCallback();
         PoolRegistration storage info = poolInfo[msg.sender];
         bool memeIs0 = info.memeToken == info.token0;
-        EvmGenPoolSwap.v3PayOwed(info.memeToken, memeIs0, amount0Delta, amount1Delta, activeSwapMaxPay);
+        MuchfiPoolSwap.v3PayOwed(info.memeToken, memeIs0, amount0Delta, amount1Delta, activeSwapMaxPay);
     }
 
     function claimPendingToken(address token) external nonReentrant returns (uint256 amount) {
```

Five hunks (the last spans both `sellMemeForPaired` and the callback). Byte-identical after CR stripping: the three integration interfaces, every constant (`REQUIRED_LIQUIDITY_KIND`, the 8000/2000 split, `MEME_SALE_MAX_IMPACT_BPS = 50`, `MIN_SALE_GAS = 500_000`), the `PoolRegistration` struct, all storage, events and errors, `constructor`, `configureRevenue`, `setIntegrationSourceAuthorized`, `onERC721Received`, `registerGraduatedPool`, `updateCreatorPayoutRecipient`, `harvest`, `claimPendingToken`, `retryPendingProtocolToken`, `recoverUnregisteredToken`, `_splitAndRoute`, `_routeProtocolToken`, `_tryTransferToken`, `_positionCore`, `_samePair`.

| Hunk | Change | Enumerated? | Classification |
|---|---|---|---|
| 1 | import `MuchfiPoolSwap` for `EvmGenPoolSwap` | Yes (library substitution) | Required. |
| 2 | `@notice` header | No (NatSpec) | Acceptable; lists the two differences truthfully. |
| 3 | contract name | Implied | Required (same project; `getContractFactory` by name). The ABI fork test (below) proves the function/event/error surface is the original's modulo the callback name. |
| 4 | comment on `activeSwapPool` | No (comment) | Acceptable, truthful. |
| 5a | `sellMemeForPaired`: two library call sites renamed | Yes | Required; arguments identical (`MEME_SALE_MAX_IMPACT_BPS`, `0, 0` = no TWAP, `address(this)` recipient). |
| 5b | `uniswapV3SwapCallback` → `muchfiV3SwapCallback`; `v3PayOwed` call renamed | Yes (callback name) | Required: the pool calls `0xe98f1458` and nothing else (fact table; the facts spec shows a `uniswapV3SwapCallback`-only caller reverts with empty data on a direct `pool.swap`). The body is byte-identical: the `msg.sender == activeSwapPool && != 0` gate, the orientation from `poolInfo[msg.sender]`, the bounded pay. |

**Stale NatSpec / identifiers left in the copy (known-stale, no bytecode effect):** `@dev` lines still say "(EvmGenPoolSwap)" and "see EvmGenPoolSwap" for the bound discussion; "WETH on native pools, the stock token on stock-bound pools" and `registerGraduatedPool`'s "`expectedTokenB` the paired asset (WETH or the stock token)" describe the Robinhood deployment: on DogeOS the paired asset is WDOGE and the stock path is a named exception that gen-7 on 6281971 never takes (the factory passes `quoteToken = router.WETH()` for native coins, `LaunchFactoryGen7.sol:598-602`); the interface names `IRobinhoodV3LockerIntegration` / `IRobinhoodV3LockerFactory` / `IRobinhoodV3LockerPositionManager` / `IRobinhoodV3LpRevenueTreasuryRouter` are code identifiers for generic V3/router shapes; renaming them would widen the diff for zero bytecode change and was rightly not done. Recommendation: NatSpec-only cleanup, optional, not blocking.

### Reentrancy

Unchanged vs original, by diff; restated for the MuchFi venue:
- Every entry that moves value is `nonReentrant`: `harvest`, `claimPendingToken`, `retryPendingProtocolToken`, `recoverUnregisteredToken`. `sellMemeForPaired` is `external` only so a failed sale reverts atomically inside `try`; it is `OnlySelf` and runs inside `harvest`'s guard (a self-call does not pass a `nonReentrant` modifier, so the guard does not block it, and nobody else can reach it).
- `muchfiV3SwapCallback` is not guarded and must not be (it runs inside our own swap); it is gated by `activeSwapPool`, set immediately before `v3Swap` and cleared immediately after, and the pool holds its `lock` while calling it, so the callback cannot re-enter the pool.
- **MuchFi-specific re-entry surface: the LM-pool hook.** A PancakeV3 pool with `lmPool != 0` calls out to it from inside `swap` (and, in the reference source, from in-range liquidity changes). Today `lmPool() == 0` on real pools and `lmPoolDeployer() == 0` on the factory (fact table), but the owner can set one. If a hostile `lmPool` re-entered this locker during the sale: `harvest`/`claim*`/`retry*`/`recover*` revert on the guard; `registerGraduatedPool`/`configureRevenue`/`setIntegrationSourceAuthorized` are `onlyAdmin`; `sellMemeForPaired` is `OnlySelf`; `muchfiV3SwapCallback` requires `msg.sender == activeSwapPool`, and the lmPool is not the pool, so it gets `UnexpectedCallback`; `updateCreatorPayoutRecipient` only touches the lmPool's own mapping entry. The only `view` it could use is public state. So an lmPool can revert the sale or burn its gas (both land in the `catch`: the MEME is carried, the harvest succeeds, see Griefing) and cannot move anything.

### CEI

Unchanged. `harvest`: checks (`registered`, `ownerOf`, principal) → interaction (`collect`) → re-checks (`ownerOf`, principal unchanged) → effects before the sale (`lastSaleBlock[pool] = block.number`, then the gas floor) → the sale as an atomic self-call → effects (`carriedMeme`, event) → `_splitAndRoute` (transfer with pending fallback; router call with approve-then-reset and pending fallback). The transient `activeSwapPool`/`activeSwapMaxPay` are set before and cleared after the swap in the same frame; a revert anywhere in the sale frame undoes both. `registerGraduatedPool`: all checks, then all effects, no interaction after the effects (the NPM reads happen before). `claimPendingToken`: zero the balance, then transfer.

### Reachable states

Unchanged in structure; the gate that matters for the callback is restated with the DogeOS actors:
- **Who registers a pool.** `registerGraduatedPool` is `onlyAdmin`. In the gen-7 deployment the admin is the `LaunchFactoryGen7` itself: its constructor reverts `LockerNotBoundToFactory` unless `locker.admin() == address(this)` (`LaunchFactoryGen7.sol:318`), and `deployFactoryWithLocker` deploys the locker with the predicted factory address as admin. The factory calls `registerGraduatedPool` from exactly one place, `notifyCampaignGraduated`, which requires `isCampaign[msg.sender]` and records graduation once per campaign (`LaunchFactoryGen7.sol:593-623`). No human key can register a pool.
- **How the pool is validated against the MuchFi factory.** Before registration a position must have arrived through `onERC721Received`, where `msg.sender` must be the configured `positionManager` (MuchFi NPM), `operator` an authorized integration source (the graduation adapter, authorized by the factory), the position's `fee` must equal `configuredFeeTier` (10000), and the pool is *computed* as `v3Factory.getPool(token0, token1, fee)` — not taken from the caller. `registerGraduatedPool` then re-reads the position from the NPM, requires `ownerOf == this`, `fee == configuredFeeTier`, the pair to match `(expectedTokenA, expectedTokenB)` with `expectedTokenA != wrappedNative`, **and `v3Factory.getPool(token0_, token1_, fee_) == pool`** (`InvalidPool` otherwise), and `liquidity != 0`. `v3Factory`, `positionManager`, `wrappedNative`, `configuredFeeTier` are read from the integration source in `configureRevenue` (the adapter's `v3Factory()` = MuchFi factory, `positionManager()` = MuchFi NPM, `WETH()` = WDOGE, `feeTier()` = 10000; pinned by the adapter fork spec) and locked by `IntegrationLocked` once anything is registered or pending.
- **Therefore `activeSwapPool`** (set only in `sellMemeForPaired`, reachable only from `harvest`, which reverts `PoolNotRegistered` for anything unregistered) is always an address the MuchFi factory returned for a registered pair at tier 10000, and `muchfiV3SwapCallback`'s `msg.sender` is always that pool. The callback pays at most `activeSwapMaxPay` (= the MEME it meant to sell) per invocation; a second invocation after the swap finds `activeSwapPool == 0`.
- Unreachable by construction, unchanged: a registered pool with the wrapped native as the MEME side; two positions for one pool; a registration without a pending delivered NFT; any path that moves the NFT or its liquidity (no transfer/approve/decrease/burn function exists: the ABI fork test asserts the function set is the original's modulo the callback rename and contains no `transfer`/`approv`/`decrease`/`burn`/`migrat`/`withdraw`/`rescue` name; the "NFT can never leave" test exercises the real MuchFi NPM's `transferFrom`/`safeTransferFrom`/`decreaseLiquidity`/`collect` from strangers and the admin, all reverting).

### Overflow

Unchanged. `carriedMeme[pool] = memeToSell - memeSold`: `memeSold = spent ≤ amountIn` (an exact-input swap never takes more than `amountSpecified`, and the callback refuses to pay more than `maxPay`), so no underflow. `collected0/1 = after - before` cannot underflow (`collect` only adds). The 8000/10000 split, `pendingPositionCount -= 1` (guarded by `tokenId != 0`), and the `uint128` liquidity comparisons are the original's. The `uint32 feeProtocol` is decoded and discarded inside the library; nothing here computes with it.

### Griefing

Unchanged in mechanism, with the one number the spec's venue change could invalidate re-measured:

**MIN_SALE_GAS (500,000) re-measured on MuchFi.** The guard exists because `harvest` is permissionless and the sale runs inside `try` with 63/64 of the remaining gas (EIP-150): a caller sending just-too-little gas would make the sale OOG inside the `try`, the `catch` carries the MEME, and the MEME side could be kept unsold forever (F9 in `docs/evm-launch/spec/C1-C6-fees.md`). The value was set from Robinhood Uniswap V3 at 0.30% (`sellMemeForPaired` frame **89,610** gas) and BSC Topaz (**98,891**), with a pessimistic worst case of ~220k and the rule `2 × measured ≤ MIN_SALE_GAS × 63/64 = 492,187`. A PancakeV3 pool does more per swap (the protocol-fee split in `uint32`, the `lmPool` check, the `crossLmTick` check per crossed tick), and the 1% tier has a different spacing, so the number had to be re-taken on the real bytecode. `test/MuchfiHarvestGas.fork.spec.ts` (new, fork-only, read-only; nothing broadcast, no `config/*.local` key) harvests a real MuchFi 1% MEME/WDOGE pool through the variant and reads the self-call frame from the transaction trace (Hardhat's struct logger: gas before the `CALL` to self minus gas at the next step back in the caller's frame, which also counts the `CALL` overhead and is therefore pessimistic). Run 2026-10-10 against the fork at latest−16:

| Scenario | `sellMemeForPaired` frame | Whole harvest `gasUsed` | 2 × frame vs 492,187 |
|---|---|---|---|
| Robinhood Uniswap V3 0.30% (original, from the spec) | 89,610 | 470,819 | 179,220 ✓ |
| BSC Topaz (original V2 locker, from the spec) | 98,891 | 410,571 | 197,782 ✓ |
| **MuchFi 1%, plain** (locker is the only LP, no tick crossed) | **104,382** | 475,484 | 208,764 ✓ |
| MuchFi 1%, the same frame called **cold** from the locker's own address (no slot warmed by `collect`; upper bound) | 122,116 | (143,924 tx) | 244,232 ✓ |
| **MuchFi 1%, pessimistic**: a griefer's narrow WDOGE bid one spacing away, the pool steered so the current tick is 5 ticks from its boundary, the sale crosses that initialized tick inside the 0.50% band | **133,149** | 498,498 | 266,298 ✓ |

At spacing 200 a 0.50% move is ~50 ticks, so at most one initialized tick can be crossed inside the band, and the pessimistic row contains it. The guard leaves the sale ≥ 492,187 gas: **3.7× the pessimistic MuchFi frame and 4.7× the plain one; 500,000 holds on MuchFi.** The spec's remaining pessimistic add-ons (a `LaunchToken` instead of the mock ERC-20, ~+2k; a fresh oracle observation slot, ~+22k) keep the total far below the floor. The guard remains a floor, not a cap, exactly as the original documents: a venue-side change that made a sale cost more than ~492k — the only candidate is an owner-set `lmPool` burning gas inside `swap` — would again expose the carry grief, and would do so on the original too. That is an owner-level DoS of the MEME-side sale only (paired-side fees still flow; principal is untouched) and is recorded in the trust model.

Other vectors, unchanged: one sale per pool per block (`lastSaleBlock`); the bound is the pool's price limit, so a sandwich on the sale is bounded by 50 bps of one bounded sale; a creator whose wallet rejects WDOGE gets `pendingToken`; a router that reverts parks the protocol share in `pendingProtocolToken`; a stranger's harvest costs the stranger gas only. MuchFi's 32% protocol cut and 1% tier change the *amount* of fees (the fork test asserts the locker receives 68% of the 1%), not any safety property.

### Trust model

The locker trusts the MuchFi NPM for `positions()` (the principal invariant) and `collect()`, the MuchFi factory for `getPool`, and the pool for `slot0`/`swap`/the callback. None of that source is verified. What the variant relies on is pinned on the real bytecode by the fork specs (surface and behaviour), and the failure modes of a lie are fail-closed: a wrong `positions().liquidity` makes every harvest revert `PositionPrincipalChanged`; a wrong `getPool` makes registration revert `InvalidPool`; a pool that does not call `muchfiV3SwapCallback` makes the sale revert inside `try` (carried, as the original locker demonstrably does on MuchFi in the "only the variant can sell" test). The owner's `feeProtocol` affects revenue only. The owner's `lmPool` can DoS the sale, not drain (see Reentrancy and section 5). The NPM is the custodian of the principal on every venue; that is the same trust as on Robinhood, with the difference that Robinhood's Uniswap source is verified and MuchFi's is not — the spec accepts that for testnet and names re-verification a mainnet precondition.

### Test coverage (audit view)

`test/MuchfiPositionLocker.fork.spec.ts` (7 tests): registration on the real factory/NPM/WDOGE at 10000; a WDOGE-in swap's fee reaching the locker at 68% and split 80/20 to the real recipients through `TreasuryRouterV4`; a MEME-side sale through `muchfiV3SwapCallback` with the pool paid exactly `memeSold`, the price moved ≤ 0.50%, proceeds split, nothing left in the locker; the callback rejecting strangers and the (impersonated) pool outside a sale, and `sellMemeForPaired` rejecting non-self; the paired-fee split equal to the original locker's on the same pool and the original failing to sell MEME on MuchFi (carried); the ABI identity modulo the callback rename; the NFT never leaving (real NPM transfer/decrease/collect attempts, `recoverUnregisteredToken` aimed at the NPM, `IntegrationLocked`, harvests leaving principal intact). Plus `test/MuchfiHarvestGas.fork.spec.ts` (2 tests) above. Gaps, none blocking: the `InsufficientSaleGas` path is not re-run on the fork (its logic is unchanged and `test/evmgen-fees-harvest-gas-guard.spec.ts` covers it on the original); the `pendingToken` fallback for a rejecting creator wallet is not fork-tested (unchanged code).

Verdict: PASS

---

## 3. `MuchfiCreatorRewardsVault` vs `CreatorRewardsVaultV2`

### Diff

```
diff -u --strip-trailing-cr contracts/CreatorRewardsVaultV2.sol contracts/dogeos/muchfi/MuchfiCreatorRewardsVault.sol
```

```diff
--- contracts/CreatorRewardsVaultV2.sol	2026-10-10 10:46:15.558155500 +0200
+++ contracts/dogeos/muchfi/MuchfiCreatorRewardsVault.sol	2026-10-10 15:47:51.726000600 +0200
@@ -4,7 +4,7 @@
 import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
 import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
 import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
-import {EvmGenPoolSwap, IEvmGenV2Pool, IEvmGenV3Pool, IEvmGenWrappedNative} from "./EvmGenPoolSwap.sol";
+import {MuchfiPoolSwap, IEvmGenV2Pool, IEvmGenV3Pool, IEvmGenWrappedNative} from "./MuchfiPoolSwap.sol";
 import {
     ICreatorRewardsVaultV2,
     IEvmGenCampaignForVault,
@@ -12,7 +12,7 @@
     IEvmGenLockerForVault,
     IEvmGenV2LockerPoolInfo,
     IEvmGenV3LockerPoolInfo
-} from "./interfaces/ICreatorRewardsVaultV2.sol";
+} from "../../interfaces/ICreatorRewardsVaultV2.sol";
 
 interface IEvmGenHolderDistributor {
     function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable;
@@ -31,7 +31,9 @@
     function tradingEnabled() external view returns (bool);
 }
 
-/// @title CreatorRewardsVaultV2
+/// @title MuchfiCreatorRewardsVault
+/// @dev DogeOS MuchFi variant of CreatorRewardsVaultV2: muchfiV3SwapCallback instead of uniswapV3SwapCallback
+/// and MuchfiPoolSwap instead of EvmGenPoolSwap (MuchFi pools return slot0.feeProtocol as uint32); nothing else differs.
 /// @notice The creator fee choice (C6, D5, D19, E10): per campaign keep / holders / split(1..99) / buyback,
 /// set once by the factory at create. Trade fees arrive from TreasuryRouterV4 in native; LP fees of non-keep
 /// coins arrive from the permanent locker in the pool's paired asset only (E9: WBNB/WETH, or the quote token on
@@ -50,7 +52,7 @@
 /// coins' holder balances; it pays nobody.
 /// A compromised operator can therefore pick bad moments within the caps, or propose a bad holder root that
 /// never executes unless the admin approves that root; it cannot send value to itself.
-contract CreatorRewardsVaultV2 is ICreatorRewardsVaultV2, ReentrancyGuard {
+contract MuchfiCreatorRewardsVault is ICreatorRewardsVaultV2, ReentrancyGuard {
     using SafeERC20 for IERC20;
 
     enum Choice {
@@ -639,10 +641,10 @@
 
     // ------------------------------------------------------------------ V3 callback
 
-    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
+    function muchfiV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
         if (msg.sender != activeSwapPool || msg.sender == address(0)) revert UnexpectedCallback();
         address tokenIn = activeSwapTokenIn;
-        EvmGenPoolSwap.v3PayOwed(tokenIn, tokenIn == IEvmGenV3Pool(msg.sender).token0(), amount0Delta, amount1Delta, activeSwapMaxPay);
+        MuchfiPoolSwap.v3PayOwed(tokenIn, tokenIn == IEvmGenV3Pool(msg.sender).token0(), amount0Delta, amount1Delta, activeSwapMaxPay);
     }
 
     // ------------------------------------------------------------------ internal
@@ -696,19 +698,19 @@
         returns (uint256 spent, uint256 out)
     {
         if (dexKind == DEX_TOPAZ_V2) {
-            impactBps = EvmGenPoolSwap.feeScaledImpact(impactBps, IEvmGenV2PoolFactory(dexFactory).getFee(pool, false) * 100);
-            (spent, out) = EvmGenPoolSwap.v2Plan(pool, tokenIn, amountIn, impactBps, TWAP_DEVIATION_BPS);
+            impactBps = MuchfiPoolSwap.feeScaledImpact(impactBps, IEvmGenV2PoolFactory(dexFactory).getFee(pool, false) * 100);
+            (spent, out) = MuchfiPoolSwap.v2Plan(pool, tokenIn, amountIn, impactBps, TWAP_DEVIATION_BPS);
             if (spent == 0) revert NothingSwapped();
-            EvmGenPoolSwap.v2Execute(pool, tokenIn, spent, out, recipient);
+            MuchfiPoolSwap.v2Execute(pool, tokenIn, spent, out, recipient);
         } else {
             bool zeroForOne = tokenIn == IEvmGenV3Pool(pool).token0();
-            impactBps = EvmGenPoolSwap.feeScaledImpact(impactBps, IEvmGenV3Pool(pool).fee());
-            (bool ok, uint160 limit) = EvmGenPoolSwap.v3Limit(pool, zeroForOne, impactBps, TWAP_DEVIATION_BPS, TWAP_WINDOW);
+            impactBps = MuchfiPoolSwap.feeScaledImpact(impactBps, IEvmGenV3Pool(pool).fee());
+            (bool ok, uint160 limit) = MuchfiPoolSwap.v3Limit(pool, zeroForOne, impactBps, TWAP_DEVIATION_BPS, TWAP_WINDOW);
             if (!ok) revert NothingSwapped();
             activeSwapPool = pool;
             activeSwapTokenIn = tokenIn;
             activeSwapMaxPay = amountIn;
-            (spent, out) = EvmGenPoolSwap.v3Swap(pool, zeroForOne, amountIn, limit, recipient);
+            (spent, out) = MuchfiPoolSwap.v3Swap(pool, zeroForOne, amountIn, limit, recipient);
             activeSwapPool = address(0);
             activeSwapTokenIn = address(0);
             activeSwapMaxPay = 0;
```

Six hunks. Byte-identical after CR stripping: the three local interfaces, `Choice`, `Cfg`, `HolderBatch`, every constant (`DEX_TOPAZ_V2 = 1`, `DEX_UNISWAP_V3 = 2`, `DEAD`, `MAX_IMPACT_BPS_LIMIT = 50`, `TWAP_DEVIATION_BPS = 100`, `TWAP_WINDOW = 1800`, `V3_ROUTE_OBSERVATIONS = 180`, caps), all storage, events and errors, `constructor`, `receive`, the admin functions (`setFactoryOnce`, `setHolderDistributorOnce`, `setOperator`, `limits`, `setCaps`, `setQuoteRoute`), `setCampaignChoice`, `isKeep`, `accrueTradeFee`, `claimCreatorFees`, `claimCreatorQuote`, `syncLpFees`, `convertHolderQuote`, `proposeHolderBatch`, `approveHolderBatch`, `vetoHolderBatch`, `creditUnclaimedHolders`, `executeHolderBatch`, `buybackCurve`, `flushBuybackTokens`, `buybackPool`, `convertBuybackNativeToQuote`, `pullLockerPending`, `attributeExcessQuote`, `rescueExcessNative`, `rescueExcessToken`, `_poolParties`, `_credit`, `_creditQuote`, `_quoteToNative`, the shape of `_swap`, `_useBuybackAllowance`, `_usePulled`, `_checkInterval`, `_useWeekCap`.

| Hunk | Change | Enumerated? | Classification |
|---|---|---|---|
| 1 | import `MuchfiPoolSwap` and the three interfaces from `./MuchfiPoolSwap.sol` | Yes | Required. The interfaces `IEvmGenV2Pool`, `IEvmGenV3Pool`, `IEvmGenWrappedNative` are the library file's; `IEvmGenV3Pool` is the one with the `uint32` `slot0`. The vault itself calls only `token0()`, `fee()`, `increaseObservationCardinalityNext()` on it directly, none of which changed. |
| 2 | interface import path `./interfaces/` → `../../interfaces/` | Implied by the directory | Required: the variant lives two levels down and imports the *same* frozen `ICreatorRewardsVaultV2.sol` (unchanged since branch point). No duplicate interface was created. |
| 3 | `@title` + a new `@dev` provenance line | No (NatSpec) | Acceptable, truthful. |
| 4 | contract name | Implied | Required. The ABI fork test proves the function set is the original's modulo the callback rename and the events, errors, constructor and `receive` are identical. |
| 5 | callback rename; `v3PayOwed` call renamed | Yes | Required; body byte-identical (the `activeSwapPool` gate, orientation read from the pool's `token0()`, bounded pay). |
| 6 | `_swap`: six library call sites renamed, in both the V2 and the V3 branch | Yes | Required; every argument identical. The V2 branch stays (see Reachable states: `dexKind`). |

**Stale NatSpec left in the copy (known-stale):** "WBNB/WETH, or the quote token on quote-bound coins" (E9/E10) in the `@notice`; "WETH/WBNB unwrapping" on `receive`; the audit references to "the Safe" as admin. On DogeOS the wrapped native is WDOGE and the admin is whatever t6 passes (spec "Keys and ownership"); quote-bound coins do not exist on 6281971 (named exception). The constant names `DEX_TOPAZ_V2` / `DEX_UNISWAP_V3` are identifiers. Recommendation: NatSpec-only cleanup, optional, not blocking.

### Reentrancy

Unchanged vs original, by diff. Every function that moves value is `nonReentrant` (`claimCreatorFees`, `claimCreatorQuote`, `syncLpFees`, `convertHolderQuote`, `proposeHolderBatch`, `vetoHolderBatch`, `creditUnclaimedHolders`, `executeHolderBatch`, `buybackCurve`, `flushBuybackTokens`, `buybackPool`, `convertBuybackNativeToQuote`, `pullLockerPending`, `attributeExcessQuote`, `rescueExcessNative`, `rescueExcessToken`). `accrueTradeFee` is deliberately not guarded (a buyback's own trade fee re-enters it from inside `buybackCurve`; it makes no external call and only adds to balances) — unchanged and still correct. `receive` accepts only the wrapped native's unwrap and factory campaigns. `muchfiV3SwapCallback` is gated by `activeSwapPool` and runs under the pool's `lock`. **LM-pool hook re-entry (MuchFi-specific):** every entry a hostile `lmPool` could call during a buyback is `nonReentrant`, role-gated (`onlyAdmin`, `onlyOperator`, `onlyFactory`, `OnlyRouter`) or the callback, which rejects any `msg.sender` but the active pool. `accrueTradeFee` is reachable only by `router`. So an lmPool can only revert or exhaust the operator's buyback transaction.

### CEI

Unchanged. The two V3 money paths through this variant: `buybackPool` (native): checks → `_checkInterval`/caps (effects) → `deposit` → `_swap` (the transient context set before and cleared after `v3Swap`, inside the same frame) → `withdraw` the unspent remainder → balance/liability effects → event. The state writes after the external calls are protected by `nonReentrant`, and the original's audits accepted that ordering; the fork test asserts `buybackBalance` and `totalLiabilities` fall by exactly `spent`, the vault's WDOGE is 0 afterwards and its native balance covers `totalLiabilities`. `syncLpFees`: checks → effects (`c.pool` binding, `lpSynced`) → `withdraw(delta)` → credit. `_quoteToNative`/`convertBuybackNativeToQuote`: same shape, unreachable on DogeOS (no quote coins) but unchanged.

### Reachable states

Unchanged in structure, with two DogeOS-specific points the reviewers asked for:

**`dexKind`: the constructor still accepts 1 (Topaz V2).** Hunk-free and deliberate ("nothing else differs"). The reachable states of a *misdeployment* with `dexKind_ = 1` on DogeOS, with the MuchFi locker pinned: `_poolParties` would decode `MuchfiV3PositionLocker.poolInfo` (14 words, `IEvmGenV3LockerPoolInfo`) with the 13-field V2 shape; word 10 (`creatorFeeBps = 8000`) would land in `bool registered`, and Solidity's decoder reverts on a bool word that is not 0 or 1, so `syncLpFees` always reverts; `setQuoteRoute` would call `getPool(address,address,bool)` on the MuchFi factory, a selector it does not have (reverts); `_swap`'s V2 branch would call `getFee`/`getReserves` on MuchFi contracts that do not have them (reverts). Trade fees via `accrueTradeFee` and creator claims would still work. So the misdeployment fails closed for LP sync, routes and buybacks, but it would strand every LP fee the locker pays to the vault as unattributed WDOGE (`rescueExcessToken` blocks the wrapped native; `syncLpFees` is the only way to attribute it), and `dexKind` is immutable: the only fix would be a new vault and a new factory (the router binds its creator vault once). **Carried requirement: t6 must assert `vault.dexKind() == 2` and `vault.dexFactory() == 0x7d17…fF0B` after deployment, before anything else is wired.** The fork test pins `dexKind() == 2` on a correctly constructed instance and `BadChoice` for 3.

**Which pools the callback can be called from.** `activeSwapPool` is set only in `_swap`, whose `pool` argument comes from exactly two sources: (a) `c.pool` for the coin's own locked pool, bound in `syncLpFees` only when the pinned locker's `poolInfo(pool)` says `registered && creator == campaign && creatorFeeRecipient == this` — i.e. the MuchFi locker's registration gate (section 2), which is itself `onlyAdmin` = the gen-7 factory and verifies the pool against the MuchFi factory; and (b) `quoteRoutePool[quote]`, which is read from `dexFactory.getPool(wrappedNative, quote, feeTier)` with `dexFactory` immutable (the MuchFi factory) and the admin choosing only the fee tier (unreachable on DogeOS, no quote coins; the fork test still proves it resolves 10000 and refuses 3000 on MuchFi and grows the real pool's observation slots to 180). So the vault's coin-pool trust *is* the locker's registration, as the reviewers put it, and its route-pool trust is the factory's `getPool`. The callback pays `tokenIn` (WDOGE for a native buyback) to `msg.sender == activeSwapPool`, at most `activeSwapMaxPay = amountIn` **per invocation**. That bound is per call, not cumulative: the vault does not track how much the callback has paid across invocations. In PancakeV3 (as in Uniswap V3) a swap invokes the callback exactly once, and after `v3Swap` returns the context is zeroed, so the pool cannot call it again. A pool that invoked the callback twice inside one swap could take up to `2 × amountIn` of `tokenIn` from whatever the vault holds — identical exposure to the original on Uniswap; on MuchFi it rests on the pool bytecode behaving as PancakeV3, which the fork tests observe (one `Swap` event per buyback, the pool paid exactly `spent`). Recorded as an accepted property, not a defect of the diff.

### Overflow

Unchanged. Caps (`maxBuyPerTx`, weekly, interval), the 95% curve ceiling, `uint128` batch totals with the explicit `> type(uint128).max` check, the split percentages (1..99) — all the original's. The `uint32 feeProtocol` is never seen by this contract.

### Griefing

Unchanged. The operator is bounded by caps, interval and impact (`MAX_IMPACT_BPS_LIMIT = 50`), the TWAP guard fails closed, holder batches need the admin's exact-root approval and survive a veto. MuchFi-specific: `feeScaledImpact(50, 10000) = 50`, so the buyback bound is the same 50 bps as on 0.30%; the coin pool's TWAP is served from a pool with `observationCardinality 1` (the position's pool is created by the adapter, which does not grow it), so `observe(1800)` extrapolates from the last written observation — the same property the original has on Robinhood, and the fork test demonstrates it both refusing a pumped spot and accepting after the window. The 32% protocol cut reduces what the locker pays the vault, nothing more.

### Trust model

The vault trusts the pinned locker's `poolInfo` (our contract), the MuchFi factory for route lookups and the pool for `token0`/`fee`/`slot0`/`observe`/`swap`/callback. Every MuchFi read is fail-closed on a shape change (decoder revert → `NothingSwapped` is not reached, the whole operator transaction reverts; no state is written before `_swap` except caps and interval, which are then rolled back with the revert). The owner's `feeProtocol` is invisible here; the owner's `lmPool` can only DoS buybacks.

### Test coverage (audit view)

`test/MuchfiCreatorRewardsVault.fork.spec.ts` (6 tests): construction with `dexKind 2` on the MuchFi factory, pool binding by `syncLpFees` on a real 1% pool, `setQuoteRoute` on MuchFi (`NoRoute` for a missing pool and for tier 3000, 180 observation slots on the real pool); `buybackPool` paid through `muchfiV3SwapCallback` with MEME to `DEAD`, stopped at the 0.50% bound (rise in (4900, 5000] ppm) with exact accounting; caps, interval, impact limit and the TWAP guard on MuchFi; creator claims equal to the original vault's for trade fees and MuchFi LP fees; the callback rejecting strangers and the impersonated pool outside a buyback, and the original vault's buyback reverting on MuchFi (uint8 decode); ABI identity. Gaps, none blocking: holder batches, `buybackCurve` and the quote paths are not re-run on the fork (unchanged code, covered by the original's suites; quote paths unreachable on DogeOS).

Verdict: PASS

---

## 4. `MuchfiV3PoolRepair` + `MuchfiV3NativeGraduationAdapter` vs `RobinhoodV3PoolRepair` + `RobinhoodV3NativeGraduationAdapterV2`

One verdict for the pair: the adapter is a thin subclass; every check, swap and mint lives in the repair base.

### Diff: repair base

```
diff -u --strip-trailing-cr contracts/integrations/RobinhoodV3PoolRepair.sol contracts/dogeos/muchfi/MuchfiV3PoolRepair.sol
```

```diff
--- contracts/integrations/RobinhoodV3PoolRepair.sol	2026-10-10 10:46:15.594462200 +0200
+++ contracts/dogeos/muchfi/MuchfiV3PoolRepair.sol	2026-10-10 15:42:38.011682000 +0200
@@ -6,7 +6,7 @@
 import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
 import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
 
-import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";
+import {IGraduationAdapterV2} from "../../interfaces/IGraduationAdapterV2.sol";
 
 interface IRhV3Factory {
     function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
@@ -23,7 +23,7 @@
             uint16 observationIndex,
             uint16 observationCardinality,
             uint16 observationCardinalityNext,
-            uint8 feeProtocol,
+            uint32 feeProtocol, // MuchFi (PancakeV3) pools: uint32 (both sides packed), not uint8
             bool unlocked
         );
 
@@ -72,16 +72,16 @@
 /// @notice Price conversions between the curve's "paired per MEME" price and Uniswap V3 sqrtPriceX96.
 /// @dev `pairedPerMemeWad` is the paired token's raw amount per 1e18 raw MEME (for the native path: wei per
 /// whole MEME, exactly the curve's `curvePriceWad`). Both directions use 512-bit mulDiv; sqrt rounds down.
-library RobinhoodV3PriceMath {
+library MuchfiV3PriceMath {
     uint256 internal constant WAD = 1e18;
     uint256 internal constant Q192 = uint256(1) << 192;
     uint256 internal constant Q128 = uint256(1) << 128;
     uint256 internal constant Q64 = uint256(1) << 64;
     uint256 internal constant Q96 = uint256(1) << 96;
 
-    /// @dev TickMath.getSqrtRatioAtTick(-887220) and (887220): the full-range ticks at spacing 60.
-    uint160 internal constant MIN_FULL_RANGE_SQRT = 4306310044;
-    uint160 internal constant MAX_FULL_RANGE_SQRT = 1457652066949847389969617340386294118487833376468;
+    /// @dev TickMath.getSqrtRatioAtTick(-887200) and (887200): the full-range ticks at spacing 200.
+    uint160 internal constant MIN_FULL_RANGE_SQRT = 4310618292;
+    uint160 internal constant MAX_FULL_RANGE_SQRT = 1456195216270955103206513029158776779468408838535;
 
     error InvalidPrice();
     error TargetOutOfRange();
@@ -122,15 +122,17 @@
     }
 }
 
-/// @notice Shared Robinhood Uniswap V3 graduation engine: pre-made pool repair, full-range mint, lock.
+/// @notice Shared DogeOS MuchFi V3 graduation engine: pre-made pool repair, full-range mint, lock. MuchFi variant of
+/// RobinhoodV3PoolRepair: muchfiV3SwapCallback instead of uniswapV3SwapCallback, uint32 slot0.feeProtocol, the 1%
+/// tier (POOL_FEE 10000, TICK_SPACING 200) and its full-range bounds (ticks +-887200); nothing else differs.
 /// Spec: docs/evm-launch/spec/C7-robinhood-adapters.md section 2, C5-graduation.md sections 7 and 10.
 ///
 /// Why the repair is safe (C7 section 2, "Claim"): before `graduate()` no pool can hold MEME, because
 /// `LaunchToken` refuses every transfer whose `from` and `msg.sender` are not the campaign. So every
-/// position in the canonical (MEME, Q, 3000) pool is a Q-only bid at a MEME price at or below the
+/// position in the canonical (MEME, Q, 10000) pool is a Q-only bid at a MEME price at or below the
 /// current price. Moving the price toward the curve price P therefore either (a) crosses zero liquidity
 /// (MEME too cheap: the move costs exactly 0 and pays no Q), or (b) sells spare MEME into bids at
-/// marginal prices >= P before the 0.30% pool fee (MEME too expensive). The callback refuses to pay Q
+/// marginal prices >= P before the 1% pool fee (MEME too expensive). The callback refuses to pay Q
 /// and refuses to pay more MEME than the spare, so a broken assumption reverts instead of costing money.
 ///
 /// AUDIT
@@ -147,22 +149,22 @@
 /// - Reachable states: only `campaignFactory.isCampaign(msg.sender)` callers, and only for their own
 ///   token (`campaign.token() == r.token`). The callback only while `_active.pool == msg.sender`.
 /// - Overflow: prices go through 512-bit mulDiv; sqrt targets are range-checked to the full-range
-///   ticks (+-887220), which also keeps every swap limit strictly inside V3's (MIN, MAX) sqrt ratio,
+///   ticks (+-887200), which also keeps every swap limit strictly inside V3's (MIN, MAX) sqrt ratio,
 ///   so the pool's `SPL` revert is unreachable. `amountSpecified` <= memeMax <= 1e27 < 2^255.
-/// - Griefing: see C7 section 5 (a)-(h); the relevant ones here: bids above P are filled at >= 0.997*P;
+/// - Griefing: see C7 section 5 (a)-(h); the relevant ones here: bids above P are filled at >= 0.99*P;
 ///   bids beyond the spare leave the pool above P (allowed only with memeBack == 0, C5 section 1.9);
 ///   heavy tick seeding is chunked with `repairStep`, whose progress is monotone because pushing the
 ///   price back through filled ranges needs MEME out of the pool, which the token refuses. Stray tokens
 ///   sent to this contract are never swept into a graduation (every amount is a delta), so a donation to
 ///   the adapter cannot inflate `nativeBack`.
-abstract contract RobinhoodV3PoolRepair is IGraduationAdapterV2, ReentrancyGuard {
+abstract contract MuchfiV3PoolRepair is IGraduationAdapterV2, ReentrancyGuard {
     using SafeERC20 for IERC20;
 
     uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;
-    uint24 public constant POOL_FEE = 3000;
-    int24 public constant TICK_SPACING = 60;
-    int24 internal constant FULL_RANGE_LOWER = -887220;
-    int24 internal constant FULL_RANGE_UPPER = 887220;
+    uint24 public constant POOL_FEE = 10000;
+    int24 public constant TICK_SPACING = 200;
+    int24 internal constant FULL_RANGE_LOWER = -887200;
+    int24 internal constant FULL_RANGE_UPPER = 887200;
     /// @notice Upper bound of the MEME a full-range mint can leave unused when the MEME side binds
     /// (V3 liquidity rounding: at most ~1/sqrt(price) raw units, ~3.2e4 at the curve's price range).
     /// A campaign treats `memeBack <= MAX_MEME_DUST` as "the budget was used up" (C5 sections 1.9, 10).
@@ -259,8 +261,8 @@
         if (v3Factory_.code.length == 0 || positionManager_.code.length == 0 || weth_.code.length == 0) {
             revert ContractCodeMissing();
         }
-        // Decision E6: 0.30%. The full-range ticks and the range check in RobinhoodV3PriceMath are
-        // spacing-60 constants, so anything else is refused here rather than mis-minted later.
+        // MuchFi: 1% (3000 is not enabled there). The full-range ticks and the range check in MuchfiV3PriceMath are
+        // spacing-200 constants, so anything else is refused here rather than mis-minted later.
         if (IRhV3Factory(v3Factory_).feeAmountTickSpacing(POOL_FEE) != TICK_SPACING) revert InvalidFeeTier();
         admin = admin_;
         v3Factory = v3Factory_;
@@ -362,7 +364,7 @@
 
     // ------------------------------------------------------------------ V3 swap callback
 
-    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
+    function muchfiV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
         CallbackContext memory ctx = _active;
         if (ctx.pool == address(0) || msg.sender != ctx.pool) revert UnauthorizedCallback();
         int256 memeOwed = ctx.memeIs0 ? amount0Delta : amount1Delta;
@@ -494,7 +496,7 @@
         // The pool opens above the target only when the budget was used up absorbing bids; then the
         // MEME that comes back is V3 rounding dust (C5 sections 1.9 and 10).
         if (sqrtAfter != x.sqrtTarget && memeReturned > MAX_MEME_DUST) revert RepairInvariantBroken();
-        res.startPriceWad = RobinhoodV3PriceMath.priceFromSqrt(sqrtAfter, x.memeIs0);
+        res.startPriceWad = MuchfiV3PriceMath.priceFromSqrt(sqrtAfter, x.memeIs0);
 
         // V3 rounding dust goes into the pool instead of back, so the campaign's exact checks hold:
         // (a) MEME side bound the mint (budget used up): memeUsed == memeMax exactly;
@@ -539,9 +541,9 @@
         // estimate can only leave the MEME side binding. From sqrtPriceX96 directly (audit 2: a price
         // rounded to paired raw per 1e18 MEME is far too coarse for a low-decimal quote).
         uint256 keep = Math.mulDiv(
-            RobinhoodV3PriceMath.memeForPaired(x.pairedIn + proceeds, sqrtNow, x.memeIs0),
-            RobinhoodV3PriceMath.WAD - 1e9,
-            RobinhoodV3PriceMath.WAD
+            MuchfiV3PriceMath.memeForPaired(x.pairedIn + proceeds, sqrtNow, x.memeIs0),
+            MuchfiV3PriceMath.WAD - 1e9,
+            MuchfiV3PriceMath.WAD
         );
         uint256 memeLeft = x.memeAvailable - memeSold;
         if (memeLeft <= keep) return (memeSold, proceeds);
```

Nine hunks (the fifth spans the AUDIT comment, the contract declaration and its constants). Byte-identical after CR stripping: `IRhV3Factory`, the rest of `IRhV3Pool` (`swap`), `IRhV3PositionManager`, `IRhCampaignFactory`, `IRhCampaignToken`, every function of the price-math library (`sqrtFromPrice`, `sqrtFromRatio`, `memeForPaired`, `priceFromSqrt`), `MAX_MEME_DUST`, the immutables and storage (`repairLedger`, `_active`), events and errors, `constructor` body apart from the comment, `liquidityKind`, `feeTier`, `poolFactory`, `getPool`, `setCampaignFactoryOnce`, the three hooks, `repairStep`, the callback body, `_checkCaller`, `_swapToward`, `_graduateInto`, `_preparePool`, `_mintLockRefund`, `_repairInGraduation`, `_mintAndLock`, `_sendNative`.

| Hunk | Change | Enumerated? | Classification |
|---|---|---|---|
| 1 | interface import path | Implied by the directory | Required; the same frozen `IGraduationAdapterV2.sol`. |
| 2 | `slot0` `uint8` → `uint32` | Yes | Required; the base reads `slot0` in five places (`repairStep` twice, `_swapToward`, `_mintLockRefund`, `_repairInGraduation` twice) and every one destructures `(sqrtC,,,,,,)`: the sixth word is discarded. Same fail-closed property as section 1. |
| 3 | library rename + `MIN/MAX_FULL_RANGE_SQRT` for ticks ±887200 | Yes ("full-range ticks") | Required and **verified**: the adapter fork spec computes `getSqrtRatioAtTick(±887200)` with a line-for-line port of `@uniswap/v3-core` `TickMath` (cross-checked against the documented `MIN_SQRT_RATIO`/`MAX_SQRT_RATIO` at ±887272 and against the original's ±887220 constants), asserts the harness returns these constants, then initialises four real MuchFi pools at the bound and at bound−1 and reads back ticks −887200 / −887201 / 887200 / 887199 — proof that MuchFi's own `TickMath` places these exact values on those ticks. ±887200 is the widest multiple of 200 inside ±887272 (887400 > 887272). Both constants are strictly inside the pool's `(MIN_SQRT_RATIO 4295128739, MAX_SQRT_RATIO 1461446703485210103287273052203988822378723970342)`, so the AUDIT comment's "`SPL` revert is unreachable" still holds (4310618292 > 4295128739; 1456195216…535 < 1461446703…342). The range check `s <= MIN || s >= MAX` is unchanged, so a target that would sit outside the mintable range is refused with `TargetOutOfRange` as before. |
| 4 | `@notice` header and the "Claim" comment: 3000 → 10000, 0.30% → 1% | No (NatSpec) | Acceptable, truthful; the claim's logic does not depend on the fee. |
| 5a | AUDIT comment: ±887220 → ±887200; "≥ 0.997·P" → "≥ 0.99·P" | No (NatSpec) | Acceptable and necessary for truth: a sale at marginal price ≥ P before a 1% fee nets ≥ 0.99·P. The fork spec asserts `repairProceeds · 100 ≥ 99 · P · repairMemeSold` on every repair. |
| 5b | contract rename; `POOL_FEE 3000 → 10000`, `TICK_SPACING 60 → 200`, `FULL_RANGE_LOWER/UPPER ±887220 → ±887200` | Yes | Required. `POOL_FEE` feeds `getPool`, `createAndInitializePoolIfNecessary`, `mint` and the locker's `feeTier()`; `TICK_SPACING` is checked against `factory.feeAmountTickSpacing(POOL_FEE)` in the constructor (on-chain `200`, fact table; the original cannot be constructed on MuchFi, `InvalidFeeTier`, and the variant refuses a spacing-60 factory, both fork-tested); the full-range ticks are multiples of 200 as the pool's `mint` requires and match the sqrt bounds in hunk 3. The locker fork spec reads `pos.tickLower/Upper == ∓887200` on the real NPM after a graduation. |
| 6 | constructor comment | No (comment) | Acceptable, truthful. |
| 7 | callback rename | Yes | Required; body byte-identical: `_active.pool` gate, refuse to pay the paired token, refuse more MEME than `spare`, single-use (`spare` zeroed), pay from the campaign's allowance. |
| 8, 9 | library references in `_mintLockRefund` and `_repairInGraduation` | Implied by hunk 3 | Required; arguments identical. |

### Diff: native adapter

```
diff -u --strip-trailing-cr contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol contracts/dogeos/muchfi/MuchfiV3NativeGraduationAdapter.sol
```

```diff
--- contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol	2026-10-10 10:46:15.592107100 +0200
+++ contracts/dogeos/muchfi/MuchfiV3NativeGraduationAdapter.sol	2026-10-10 15:42:57.481365000 +0200
@@ -3,14 +3,16 @@
 
 import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
 
-import {RobinhoodV3PoolRepair, RobinhoodV3PriceMath} from "./RobinhoodV3PoolRepair.sol";
+import {MuchfiV3PoolRepair, MuchfiV3PriceMath} from "./MuchfiV3PoolRepair.sol";
 
 interface IRhWETH9 {
     function deposit() external payable;
     function withdraw(uint256 amount) external;
 }
 
-/// @notice Robinhood native graduation (MEME/WETH, Uniswap V3 0.30%, full range, permanently locked).
+/// @notice DogeOS native graduation (MEME/WDOGE, MuchFi V3 1%, full range, permanently locked). MuchFi variant of
+/// RobinhoodV3NativeGraduationAdapterV2 on MuchfiV3PoolRepair (whose natspec lists the differences); this contract
+/// differs only in the base and library names. WETH below is the chain's wrapped native (WDOGE on DogeOS).
 /// Implements IGraduationAdapterV2 exactly. Spec: C5-graduation.md sections 1.8-1.10, 7, 10 and
 /// C7-robinhood-adapters.md section 2. Replaces RobinhoodUniswapV3GraduationAdapter, which minted at a
 /// griefer's price on a pre-initialized pool and had no caller check.
@@ -18,23 +20,23 @@
 /// Flow of `graduate` (msg.sender = a registered campaign, in Pending, trading just enabled):
 /// 1. wrap msg.value (the pool native, plus any native the campaign got back from earlier `repairStep`s);
 /// 2. target sqrtT from `curvePriceWad` (wei per whole MEME);
-/// 3. find or create+initialize (MEME, WETH, 3000) at sqrtT;
+/// 3. find or create+initialize (MEME, WETH, 10000) at sqrtT;
 /// 4. if initialized elsewhere, swap the pool itself to sqrtT: free when MEME is too cheap, a sale of
 ///    at most the spare (memeMax - memeTarget) at >= P when MEME is too expensive;
 /// 5. mint full range with the rest of the budget and all WETH, lock the NFT, refund unused MEME and
 ///    (unwrapped) native to the campaign.
 ///
-/// AUDIT (money path `graduate`): see RobinhoodV3PoolRepair for the shared block. Specific here:
+/// AUDIT (money path `graduate`): see MuchfiV3PoolRepair for the shared block. Specific here:
 /// - Guard `nonReentrant`; native leaves only as (a) unused WETH, unwrapped and sent to msg.sender (the
 ///   campaign), computed as `pairedIn + proceeds - pairedMinted` (never `balance`), and (b) repairStep
 ///   proceeds to msg.sender. `receive` accepts only WETH's unwrap.
 /// - Conservation: WETH and MEME balances of this adapter are asserted equal to the entry snapshot.
 /// - Native in == native minted + native returned (+0 held). MEME pulled == MEME minted + MEME returned,
 ///   and MEME sold in the repair was paid by the campaign directly to the pool from its allowance.
-contract RobinhoodV3NativeGraduationAdapterV2 is RobinhoodV3PoolRepair {
+contract MuchfiV3NativeGraduationAdapter is MuchfiV3PoolRepair {
     /// @param admin_ Binds the campaign factory once (`setCampaignFactoryOnce`); the Safe on 4663.
     constructor(address v3Factory_, address positionManager_, address weth_, address admin_)
-        RobinhoodV3PoolRepair(v3Factory_, positionManager_, weth_, admin_)
+        MuchfiV3PoolRepair(v3Factory_, positionManager_, weth_, admin_)
     {}
 
     receive() external payable {
@@ -61,7 +63,7 @@
             meme: r.token,
             paired: paired,
             memeIs0: memeIs0,
-            sqrtTarget: RobinhoodV3PriceMath.sqrtFromPrice(r.curvePriceWad, memeIs0),
+            sqrtTarget: MuchfiV3PriceMath.sqrtFromPrice(r.curvePriceWad, memeIs0),
             targetPriceWad: r.curvePriceWad,
             memeAvailable: r.memeMax,
             pairedIn: msg.value,
@@ -82,7 +84,7 @@
     }
 
     function _repairStepSqrt(Request calldata r, address, bool memeIs0) internal pure override returns (uint160) {
-        return RobinhoodV3PriceMath.sqrtFromPrice(r.curvePriceWad, memeIs0);
+        return MuchfiV3PriceMath.sqrtFromPrice(r.curvePriceWad, memeIs0);
     }
 
     function _sendPaired(address, address to, uint256 amount) internal override {
```

Four hunks: (1) import and `@notice`; (2) two comment lines (fee, AUDIT reference) and the contract name with the base constructor; (3) and (4) the two library references. The whole of `graduate` (caller check, `msg.value != 0`, entry snapshots, ledger consume, wrap, `Execution` build, `_graduateInto`, `ConservationBroken`), `receive` (WETH only), `_pairedToken` (`quoteToken == 0 && token != WETH`), `_sendPaired` (unwrap, send) is byte-identical. The variant is the native adapter only: no stock adapter was copied, consistent with the named exception.

**Stale NatSpec / identifiers left in the copies (known-stale, no bytecode effect):** the price-math library's `@notice` says "Uniswap V3 sqrtPriceX96" (the format is the same on PancakeV3); the AUDIT block's CEI bullet lists "SwapRouter02 (stock path), the route's STOCK" as callees — the stock path does not exist in this variant set; the constructor `@param admin_` says "the deploy script passes the Safe and refuses the deployer on 4663" and the adapter's `@param admin_` "the Safe on 4663" — on DogeOS the admin is whatever t6 passes and there is no 4663 branch; the "Legacy lookup shape used by LaunchFactory/PermanentV3PositionLocker" comment on `poolFactory`/`getPool` names the original locker; `MAX_MEME_DUST`'s "~3.2e4 at the curve's price range" is unchanged and still right (the full-range rounding depends on the sqrt price, not on the spacing); `IRhV3*` / `IRhWETH9` interface names and the `WETH` immutable are identifiers (the adapter's `@notice` now says WETH means WDOGE here). Recommendation: NatSpec-only cleanup, optional, not blocking.

### Reentrancy

Unchanged vs original, by diff. `graduate` and `repairStep` are `nonReentrant`. The callback is gated by `_active.pool`, set immediately before `pool.swap` and deleted immediately after, single-use (`spare` zeroed on the first MEME payment), refuses any paired-token payment, and pays MEME only from the campaign's allowance (`safeTransferFrom(ctx.payer, msg.sender, owed)`): this adapter never holds the MEME it sells. **LM-pool hook (MuchFi-specific):** a hostile `lmPool` re-entering during the repair swap or the mint hits `nonReentrant` on `graduate`/`repairStep`, `onlyAdmin` on `setCampaignFactoryOnce`, `UnauthorizedCallback` on the callback (`msg.sender != _active.pool`), and views elsewhere. It can revert the swap or mint (the whole graduation reverts: fail closed, the campaign stays Pending and can retry) or burn gas; it cannot move the budget (held by the campaign until `_mintLockRefund` pulls it, and conserved by `ConservationBroken`).

### CEI

Unchanged. Per call: validate (`_checkCaller`: factory-known campaign, own token, deadline, sane request) → snapshots → external calls only to WDOGE, the factory (`getPool`), the NPM (`createAndInitializePoolIfNecessary`, `mint`, `safeTransferFrom` to the locker), the canonical pool (`swap`), the token (`transferFrom`/`transfer`) and the locker (through the NPM's `onERC721Received`) → computed refunds → conservation assertion. The repair ledger is written after the swap from the swap's own deltas (reordering cannot change them) and consumed and zeroed by `graduate` before any external call that could observe it. `_active` is set/deleted around the one `swap`.

### Reachable states

Unchanged. Callers: only `campaignFactory.isCampaign(msg.sender)` after `setCampaignFactoryOnce` (admin, once), only for `campaign.token() == r.token`. **Callback-caller validation (the reviewers' point):** `_active.pool` is set in `_swapToward` from `pool`, which both callers obtain only as (a) `IRhV3Factory(v3Factory).getPool(r.token, paired, POOL_FEE)` in `repairStep`, or (b) in `_preparePool`: the address returned by the NPM's `createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, sqrtTarget)` **re-checked against `v3Factory.getPool(t0, t1, POOL_FEE)` (`PoolMismatch` otherwise)**. `v3Factory` is immutable = the MuchFi factory. So the callback's `msg.sender` is always the MuchFi factory's canonical (MEME, WDOGE, 10000) pool for the campaign's own token; the PoolDeployer indirection (PancakeV3 deploys pools from a separate `PoolDeployer`, under which the CREATE2 address is derived) is irrelevant to these contracts, which never derive addresses and always ask the factory (it matters to the frontend/indexer, other tasks). The position is minted to the adapter and safe-transferred to `permanentPositionLocker` (read once from `campaignFactory.permanentLpLocker()`), whose `onERC721Received` requires `msg.sender == NPM` and `operator == this adapter` (authorized by the factory); the locker's fee-tier check (`configuredFeeTier` from this adapter's `feeTier() == 10000`) and pool derivation close the loop. `getPool(…, stable=true)` reverts `InvalidPair`; `_pairedToken` refuses a quote request and a MEME equal to WETH.

### Overflow

Unchanged. 512-bit `mulDiv` throughout the price math; `sqrtFromRatio` range-checked to the (new, verified) full-range bounds; `amountSpecified ≤ memeMax ≤ 1e27 < 2^255`; `memeForPaired` shaded by `1e-9`; `x.memeAvailable - memeSold` cannot underflow (`memeSold ≤ spare ≤ memeAvailable` by the callback's `spare` check); `pairedForMint - pairedMinted` and `memeForMint - memeMinted` cannot underflow (the NPM uses at most `amountDesired`). The `uint32` is discarded in every `slot0` read.

### Griefing

Unchanged in mechanism (C7 §5 (a)–(h)): a pre-created pool at any price is repaired for free through empty liquidity or by selling at most the spare into bids at ≥ P before fee (now ≥ 0.99·P net, at the 1% tier); bids beyond the spare leave the pool above P only with `memeBack == 0`; heavy tick seeding is chunked by `repairStep` with monotone progress; donations cannot inflate `nativeBack`. MuchFi-specific: the 32% protocol cut is taken out of the 1% fee the *bidder's* liquidity would have earned on the repair sale; it does not change what the campaign receives (the sale's net proceeds are the pool's output, fee already removed on the input side). The fork spec runs the full griefing matrix on real MuchFi pools for both token orderings: fresh pool; pre-created at 1/1000× and 1000× (free move through zero liquidity, no "repair" in the C5 sense); pre-created at 1000× with five WDOGE bids between 2P and 900P (spare sold at ≥ 0.99·P, pool ends exactly at P, `donationFound` equals the pool's WDOGE); and a chunked `repairStep` to a halfway limit followed by `graduate` consuming the ledger.

### Trust model

The adapter trusts the MuchFi NPM to mint what it says (checked: `tokenId != 0`, `liquidity != 0`, used amounts ≤ desired, then the locker re-reads the position), the factory's `getPool`, and the pool's `slot0`/`swap`. A lie in `slot0` after the mint would trip `RepairInvariantBroken` (`sqrtAfter != sqrtTarget` with real MEME returned) or the campaign's own exact checks; a pool that refused the callback name would revert the repair (fail closed). The venue-owner powers that can touch graduation: `setLmPool` on the canonical pool (DoS of the mint/repair until unset: the graduation reverts, nothing is lost, the campaign stays Pending), and `setWhiteListAddress` with `whitelistRequested` on tier 10000 (would make `createAndInitializePoolIfNecessary` revert for a non-whitelisted NPM caller: DoS of every new graduation; today `whitelistRequested == false`, fact table). `enableFeeAmount` can only add tiers, and `feeAmountTickSpacing(10000)` cannot be changed once set in the reference source (unverified here). Accepted for testnet per the spec; the mainnet preconditions are listed in section 6.

### Test coverage (audit view)

`test/MuchfiGraduationAdapter.fork.spec.ts` (18 tests): the locker/keeper surface (`POOL_FEE 10000`, `TICK_SPACING 200`, `feeTier`, `liquidityKind`, `getPool`, locker configured from the adapter); the original failing to construct on MuchFi and the variant's fee/zero/code checks; ABI identity modulo the callback rename; callback refusal for strangers; `UnauthorizedCampaign` for `graduate` and `repairStep`; the three full-range-bound tests (port vs constants, MuchFi's own `TickMath` at the bounds, the range check at the new bound); and for both token orderings the five graduation scenarios above, each asserting zero residue on the adapter, MEME and native conservation into the pool, the 1% full-range position in the locker, the pool opening exactly at `sqrt(P)`, `nativeBack ≤ 1 bp` unless the budget was used up, and repair proceeds ≥ 0.99·P. Gap, not blocking: no scenario crosses more initialized ticks than one graduation can afford (the chunking path is exercised with one chunk, not with a pool that *requires* chunking); unchanged code, covered by the original's Robinhood fork suite.

Verdict: PASS

---

## 5. Cross-cutting trust model

**What "unverified source" means here.** Nothing MuchFi deployed can be compiled or read; every claim about it is a bytecode observation (selector presence), an `eth_call` result, or a behaviour observed on a fork of the real chain state. The variants were therefore written against the PancakeV3 reference *shape* and then proven against the real bytecode: callback name, `slot0` width, fee tier and spacing, `TickMath` agreement at the bounds, NPM `mint`/`collect`/`positions`/`ownerOf`/`safeTransferFrom`, factory `getPool`/`feeAmountTickSpacing`, pool `swap` partial fills at a limit, `observe`/`increaseObservationCardinalityNext`, the `Swap` event with protocol fees, the 32%-of-1% arithmetic. Where a reference property could not be observed (hook call sites inside the pool, the `setFeeProtocol` bound, `feeAmountTickSpacing` immutability, internal delegation), this document says so and treats it as a venue-owner power.

**The owner (`0xDa4d…0056`, one EOA, holds every MuchFi admin role) can, per the selectors in the bytecode:**

| Power | Effect on our contracts | Bound |
|---|---|---|
| `setFeeProtocol(pool, uint32, uint32)` per pool (today 3200/3200 = 32%) | Changes the share of each swap's 1% fee that goes to MuchFi instead of the locker's position. Our contracts never read `feeProtocol` (decoded and discarded) and never compute with it. Revenue only; principal, swap output and the repair's proceeds are unaffected. | Reference PancakeV3 requires each side to be 0 or in [1000, 4000] (max 40% of fees); unverified here. The spec accepts 32% and names re-checking it a mainnet precondition. |
| `collectProtocol` | Moves only the accrued protocol share (`protocolFees()`), never position principal or LP fees. | — |
| `setLmPoolDeployer` / `setLmPool(pool, lmPool)` (today both 0) | Installs a contract the pool calls from inside `swap` (and, in the reference, from in-range `mint`/`burn` with non-zero delta). | See below: DoS at most. |
| `setOwner` | Hands the above to another key or contract. | — |
| `enableFeeAmount`, `setWhiteListAddress` | Can add tiers; can make pool creation on a tier whitelist-only (graduation DoS, nothing lost). Cannot remove tier 10000 or change its spacing in the reference. | Today `(whitelistRequested=false, enabled=true)` for 10000. |

**Why an `lmPool` can at most DoS, not drain.** The pool passes the lmPool no tokens and no approvals: in the reference it calls `accumulateReward(timestamp)`, `crossLmTick(tick, zeroForOne)` and position-update hooks, all of which act on the lmPool's own storage. The pool holds its `lock` while calling out, so the lmPool cannot re-enter the pool to swap, mint, burn or collect on anyone's behalf. Towards our contracts it is just another external caller: every value-moving entry on the locker, the vault and the adapter is `nonReentrant`, role-gated or self-only (sections 2–4), and the three callbacks check `msg.sender == <the active pool>`, which the lmPool is not. Outstanding approvals during a hooked call: the adapter's `forceApprove` to the NPM is granted immediately before `mint` and reset to 0 right after (the lmPool runs inside `mint`, but it is not the NPM and cannot spend an approval granted to the NPM); the locker's and vault's approvals to the router are granted and reset in the same frame and are not reachable from a swap. The campaign's allowance to the adapter for the spare is spent only by the adapter's callback, which the lmPool cannot invoke. So the lmPool's reachable effects are: revert the swap or mint (locker: sale reverts inside `try`, MEME carried, harvest succeeds, paired fees still paid; vault: operator's buyback reverts; adapter: graduation reverts, campaign stays Pending), or consume gas (same outcomes; for the locker the 500k floor becomes insufficient only if the lmPool itself burns > ~360k per swap). None of these touch the NFT (the locker has no transfer path and never approves anyone; proven against the real NPM) or any balance.

**Callback-caller validation, summarised:**

| Contract | Transient context | Set where | Pool source | Gate |
|---|---|---|---|---|
| `MuchfiV3PositionLocker` | `activeSwapPool`, `activeSwapMaxPay` | `sellMemeForPaired` (self-only, from `harvest`) | `poolInfo[pool].registered`; registration `onlyAdmin` (= `LaunchFactoryGen7`, from `notifyCampaignGraduated` with `isCampaign[msg.sender]`), pool derived from the delivered NFT's pair via `v3Factory.getPool` and re-checked `== pool` | `msg.sender == activeSwapPool && != 0`; pays `info.memeToken` ≤ `activeSwapMaxPay` per invocation |
| `MuchfiCreatorRewardsVault` | `activeSwapPool`, `activeSwapTokenIn`, `activeSwapMaxPay` | `_swap` | `c.pool` bound in `syncLpFees` from the locker's registration; `quoteRoutePool` from `dexFactory.getPool` | `msg.sender == activeSwapPool && != 0`; pays `tokenIn` ≤ `activeSwapMaxPay` per invocation |
| `MuchfiV3PoolRepair` | `_active{pool, memeIs0, meme, payer, spare}` | `_swapToward` | `v3Factory.getPool(token, WDOGE, 10000)`, or the NPM's created pool re-checked `== getPool` (`PoolMismatch`) | `msg.sender == _active.pool != 0`; refuses paired payment; MEME ≤ `spare`, single-use; pays from the campaign's allowance |

In all three the "per invocation, not cumulative" bound rests on the pool invoking the callback once per swap, as PancakeV3 and Uniswap V3 do; the fork tests observe exactly that (one `Swap` event, the pool paid exactly `spent`/`memeSold`), and the exposure is identical to the originals'.

---

## 6. Carried follow-ups (none blocks this gate)

1. **t6 must assert, after deployment and before wiring:** `vault.dexKind() == 2`, `vault.dexFactory() == 0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B`, `vault.wrappedNative() == 0xF6BD…78aE`; `locker.v3Factory()`, `positionManager()`, `wrappedNative()`, `configuredFeeTier() == 10000` after `configureRevenue` from the adapter; `adapter.POOL_FEE() == 10000`, `TICK_SPACING() == 200`, `v3Factory`, `positionManager`, `WETH`; and `factory.feeAmountTickSpacing(10000) == 200` on the live chain at deploy time (the constructor checks it, so a wrong factory address fails loudly; the assertion documents it).
2. **NatSpec-only cleanup (optional):** the stale Robinhood/stock/Safe-on-4663/`EvmGenPoolSwap`/`CreatorRewardsVaultV2` mentions listed per variant. Zero bytecode effect (`bytecodeHash: none`, NatSpec not compiled). Worth doing before explorer verification so the published source does not describe a chain it is not on; not required for gate 2.
3. **Mainnet preconditions (spec §1, restated with what this audit found):** verified MuchFi source, or at minimum a re-read of the selectors and `slot0` layout at the mainnet addresses; a governance answer for the single-EOA owner (`setFeeProtocol`, `setLmPool`, `setWhiteListAddress`, `setOwner`); `feeProtocol` re-checked per pool; `lmPoolDeployer()` and each canonical pool's `lmPool()` read as 0 before graduation; and the `MIN_SALE_GAS` margin re-measured if MuchFi ever installs an LM pool.
4. **Fork measurement script kept:** `test/MuchfiHarvestGas.fork.spec.ts` (fork-only, read-only; skips under any non-Chikyū-fork config) so the number in section 2 can be re-taken after any venue change.

---

## Summary

| Variant | Hunks | Outside the enumerated list | Verdict |
|---|---|---|---|
| `MuchfiPoolSwap` | 4 | NatSpec only | PASS |
| `MuchfiV3PositionLocker` | 5 | NatSpec only | PASS |
| `MuchfiCreatorRewardsVault` | 6 | NatSpec + the import path the directory implies | PASS |
| `MuchfiV3PoolRepair` + `MuchfiV3NativeGraduationAdapter` | 9 + 4 | NatSpec + import paths | PASS |

Every hunk in the four variants is one of: the enumerated changes (callback name, `uint32` `slot0`, tier 10000 / spacing 200 and its full-range ticks and sqrt bounds, the library substitution), a rename the file name or directory implies, or a NatSpec rewording that keeps the documentation true about those changes. No hunk touches a check, an accounting line, storage, access control, an event or an error. Reentrancy, CEI, reachable states and overflow are unchanged vs the originals by diff and restated above against the MuchFi venue; the one number the venue change could have invalidated, the locker's 500,000-gas sale floor, was re-measured on the real bytecode at 104k (plain) and 133k (tick crossed) against a 492k budget and holds. The remaining risks are properties of the venue the spec chose and accepted for testnet, not defects in the copies: unverified bytecode, a single owner EOA with a per-pool fee dial and an LM-pool hook that can stall but not drain. They are recorded in sections 5 and 6 so the mainnet plan does not inherit them unexamined.

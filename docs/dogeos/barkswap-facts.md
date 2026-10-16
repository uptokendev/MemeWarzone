# Barkswap on DogeOS Chikyu testnet: verified fact sheet

> Copied from the read-only research run of 2026-10-14. `src/` and `scripts/` paths below refer to that run's scratch directory, not to this repo.

Date: 2026-10-14. Chain 6281971, RPC https://rpc.testnet.dogeos.com (latest block ~8,577,550, gasLimit 10,000,000, ~3 s blocks).
Read-only research. No transactions were sent and nothing was signed.
Labels: **VERIFIED** (how), **INFERRED** (reasoned from verified facts), **UNKNOWN**.

Source references are to upstream `cryptoalgebra/Algebra` tag **v1.2.1-integral**, cloned to `src/algebra-v1.2.1-integral/`.
Line numbers are from that tag. Scratch scripts are in `scripts/`, raw data in `src/`.

---

## 1. Addresses, version, verification

### Version: Algebra Integral **1.2.1**, unmodified
- **VERIFIED.** `factory.POOL_INIT_CODE_HASH()` = `0xa18736c3ee97fe3c96c9428c0cc2a9116facec18e84f95f9da30543f8238a782`. That is the constant in v1.2.1-integral `AlgebraFactory.sol:60`. In v1.2.2 and v1.2.3 it is `0x62441ebe…`.
- **VERIFIED, bytecode-identical.** I compiled upstream v1.2.1 with solc 0.8.20, evm `paris`, `bytecodeHash: none` and the per-file optimizer runs from the repo's hardhat configs (`scripts/compile.cjs`), then compared runtime bytecode with immutables masked. All of these are IDENTICAL: AlgebraFactory, AlgebraPool (checked on custom pool 0x330F…), AlgebraPoolDeployer, AlgebraCommunityVault, AlgebraVaultFactoryStub, AlgebraCustomPoolEntryPoint, SwapRouter, Quoter, QuoterV2, TickLens, NonfungiblePositionManager, AlgebraInterfaceMulticall, BasePluginV1Factory.
- **VERIFIED** behaviour matches 1.2.1: custom-pool creation txs emit only `CustomPool`, not `Pool`. That is 1.2.1/1.2.2 behaviour; 1.2.3 emits both.
- The "Algebra Integral 1.2" claim is therefore **VERIFIED as 1.2.1** (not 1.2.2 or 1.2.3). It is the stock code with no SofaLabs changes to core or periphery.

### Addresses (all created by EOA `0xFB1525e16FDA109a5180a3Ec23A7146b870E045b`, blocks 5,032,996 – 5,033,042, 2026-05-20)
| Role | Address | How verified |
|---|---|---|
| AlgebraFactory | `0xF3961157f56C983316657f0267B4C04460beE43f` | bytecode match; `EP.factory()`, `NPM.factory()`, `Router.factory()` |
| AlgebraPoolDeployer | `0x4151224471B0EeA41eE4295c632cc61779d339C2` | `factory.poolDeployer()` |
| AlgebraCustomPoolEntryPoint | `0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5` | bytecode match; `factory()` = factory |
| Default plugin factory (BasePluginV1Factory) | `0xa3411873111B2A6d2C107Ba146764C6E636d4b29` | `factory.defaultPluginFactory()`; bytecode match |
| Vault factory (Stub) | `0x1dB26728A2f5E56A3652aE766301dBa038346b56` | `factory.vaultFactory()`; returns a single vault for every pool |
| Community vault (all pools) | `0xA305F8BDf7EaA3233b3918A39d1e0867c6116c83` | `stub.defaultAlgebraCommunityVault()`; `pool.communityVault()` |
| SwapRouter | `0x911E5A1630fD1768E5A1710DAAFaBb865cB79531` | `factory()`, `poolDeployer()`, `WNativeToken()`; bytecode match |
| Quoter | `0x87d4cC67377B8AbE91BBD04bc8a8E9869559Ee36` | bytecode match |
| QuoterV2 | `0x187b41968063Cb8A04A5f4d2113844EF2Ba21493` | bytecode match |
| TickLens | `0x0b565c5fc0d35a9a28b4f7be69a209cef69c318c` | bytecode match |
| AlgebraInterfaceMulticall | `0xe21002c6d5b79b990f422aca638b1ef04bc8bbbf` | bytecode match |
| NonfungiblePositionManager ("Barkswap Positions NFT-V2", BARKSW-POS) | `0xf596329a6c7E03F0708199cB5435f86783DB4302` | `name()`/`symbol()`, bytecode match |
| NFT position descriptor (EIP-1967 proxy → impl `0x79b70d6a…`) | `0x786cacef121a3f041f790d35c603a7be00206c3b` | EIP-1967 slot |
| EternalFarming / FarmingCenter | `0xfdF9C6D8034733830AbE170fe203C69A6C1e7169` / `0xaBECc858bE28b4dD6200e3CD68F01a5422d48450` | cross-references `NPM.farmingCenter()`, `eternalFarming()` |
| WDOGE | `0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE` | `WNativeToken()` on NPM/Router/Quoters; `symbol()`=WDOGE |

- None of these contracts is source-verified on Blockscout (`is_verified:false`) or on L2Scan ("Contract source code not verified"). **VERIFIED.** The bytecode matches above stand in for source verification.
- **VERIFIED, low relevance.** Block 5,032,980 – 5,032,985 holds an earlier factory set (factory `0xe60ae1dc…`) that was abandoned. Do not use it.
- Factory deploy gas was 2,540,946.

### Licence
- **VERIFIED.** `src/core/LICENSE` (v1.2.1) is BUSL-1.1, Licensor Algebra DAO, Change Date "the earlier of 2027-03-15" or 4 years after first distribution, then GPL-2.0-or-later. The plugin package (`BasePluginV1Factory.sol`, the base plugins) is also BUSL-1.1. Interfaces (`IAlgebraPlugin`, `IAlgebraPluginFactory`, `Constants`, `Plugins`) are GPL-2.0-or-later.
- **INFERRED.** We may write our own plugin against the GPL interfaces. If we copy Algebra's BUSL base-plugin code, it falls under BUSL.

---

## 2. Custom pool creation

### Call path (VERIFIED from source and from a live tx trace)
1. Our **deployer contract D** calls `EP.createCustomPool(address deployer, address creator, address tokenA, address tokenB, bytes data)` (selector `0xdbbf3db4`).
   - EP requires `msg.sender == deployer` ("Only deployer", `AlgebraCustomPoolEntryPoint.sol:33`). D must therefore be a contract and pass `deployer = address(D)`.
2. EP calls `factory.createCustomPool(...)`. The factory checks `hasRole(CUSTOM_POOL_DEPLOYER, msg.sender)` (`AlgebraFactory.sol:112`). **msg.sender here is the EP**, not D.
3. The factory calls `EP.beforeCreatePoolHook(pool, creator, deployer, token0, token1, data)`. EP forwards it to `IAlgebraPluginFactory(deployer).beforeCreatePoolHook(...)` (EP:46-58).
   - **D's return value is the plugin address.** D must implement `IAlgebraPluginFactory`.
4. The PoolDeployer CREATE2s the pool with salt `keccak256(abi.encode(deployer, token0, token1))`. The address is predictable via `factory.computeCustomPoolAddress(D, t0, t1)`; I checked that this function returns the live pool 0x330F….
5. The factory calls `EP.afterCreatePoolHook(plugin, pool, deployer)`, which goes on to `D.afterCreatePoolHook`. It then registers `customPoolByPair[D][t0][t1]`, emits `CustomPool(deployer, token0, token1, pool)` (**no `Pool` event in 1.2.1**), and calls `vaultFactory.createVaultForPool` → `pool.setCommunityVault(0xA305…)`.

### Roles
- `CUSTOM_POOL_DEPLOYER` = `keccak256("CUSTOM_POOL_DEPLOYER")` = `0xc9cf8125…683b`. **VERIFIED on-chain:** member count 1, and that member is the EP `0x19B1…`. Granted at block 5,033,019 by `0xFB15…`.
- `POOLS_ADMINISTRATOR` = `0xb73ce166…3442`. The EP holds it (granted at block 5,033,020). EP needs it so it can forward `setTickSpacing/setPlugin/setPluginConfig/setFee` to pools.
- Role admin for both is `DEFAULT_ADMIN_ROLE`. Its single holder is the factory `owner()` = EOA `0xFB1525e1…045b` (nonce 545,251). `pendingOwner()` is also `0xFB15…`, a self-transfer that was started and never accepted.
- **CONTRADICTION (VERIFIED).** No role is granted per deployer. Because only the EP holds the role, **any contract can create custom pools through the EP without permission**. Three distinct third-party deployer contracts (`0xC2f6…`, `0x27D2…`, `0xEF38…`, created by EOA `0xd25aF8A1…`) have done so, and no `RoleGranted` was ever issued to them (all 26 `RoleGranted` logs on the factory were decoded). Barkswap's line "custom pools are permissioned (a factory role we grant per deployer)" does not match the deployed contracts. They *could* revoke the EP's role at any time, which would stop all custom-pool creation for everyone.
  - **INFERRED.** If they later replace the EP with a gated one, the deployer address we use on mainnet must be whitelisted there. Ask them to confirm the mainnet setup.

### Plugin choice for a custom pool
- **VERIFIED.** The plugin is whatever D returns from `beforeCreatePoolHook`. The pool constructor stores `plugin` but leaves `pluginConfig = 0` (`AlgebraPoolBase.sol:100-108`).
- The config (hook flags) must then be set by one of:
  - the plugin itself, via `pool.setPluginConfig` (`AlgebraPool.sol:504-510` allows `msg.sender == plugin`), typically inside `beforeInitialize`;
  - D, via `EP.setPluginConfig(pool, cfg)`.
- Returning `address(0)` gives a pool without a plugin. All 5 existing custom pools do this.

### Default pool for the same pair
- **VERIFIED (source).** A custom pool can exist next to a default pool for the same pair. The uniqueness check uses `customPoolByPair[deployer]` for custom pools and `poolByPair` for default ones (`AlgebraFactory.sol:120-122`).
- **Side-pool risk (VERIFIED, source).** Anyone can call `factory.createPool(tokenA, tokenB, data)` or `NPM.createAndInitializePoolIfNecessary(t0, t1, address(0), price, data)` for our coin and WDOGE, at any time. There is no access check, and the factory does not even check that the token has code.
  - Anyone can also create a *custom* pool for the same pair under their own deployer contract.
  - The default pool gets the BasePluginV1 adaptive fee: `defaultFeeConfiguration` = (alpha1 2900, alpha2 12000, beta1 360, beta2 60000, gamma1 59, gamma2 8500, baseFee 100), i.e. 0.01% base rising to about 1.5% when volatility is high. That is cheaper than our 2%.
  - Barkswap confirms their router picks the best quote. This is the same side-pool risk as gen-8 design 6.8 (audit point A5).

### Who may initialize, and when
- **VERIFIED.** `pool.initialize(uint160)` has no access control (`AlgebraPool.sol:32`). Anyone can call it once, directly or through `NPM.createAndInitializePoolIfNecessary` with our deployer address (PoolInitializer.sol:29-43).
- It calls `plugin.beforeInitialize(msg.sender, price)` unconditionally whenever `plugin != 0` (line 40). Our plugin can therefore revert unless `sender == D`.
- Simplest safe pattern: create, initialize and set up in the same tx. The live launchpad does exactly this.
- `initialize` then writes the factory defaults: fee 500, tickSpacing 60, **communityFee 30** (`AlgebraPool.sol:43-48`).
- After that, D can call `EP.setTickSpacing(pool, ts)` (1..500) and `EP.setFee(pool, fee)` (uint16, only while the DYNAMIC_FEE flag is off). D **cannot** change the community fee: the EP has no such function. Only a POOLS_ADMINISTRATOR or the owner can.

### Live example (VERIFIED, tx `0x66cfe04d064e2ca6e4bb9a6fcf3298a5541054e82a4b593ab80bc7cd6f4b6e95`, block 8,453,797)
- Sequence: CREATE2 token BBSS → EP.createCustomPool → hooks → pool CREATE2 → setCommunityVault → initialize (tick −102800) → events Fee 500 / TickSpacing 60 / CommunityFee 30 → EP.setTickSpacing 200 → EP.setFee 10000 → NPM.mint (one-sided, see §4) → 2 WDOGE dev-buy → NFT 543 to locker `0x3073321b…`.
- Total gas: **6,426,752**.

---

## 3. Plugin interface (1.2.1)

**VERIFIED** from `interfaces/plugin/IAlgebraPlugin.sol` and `libraries/Plugins.sol`.

### Hooks
- `defaultPluginConfig() view returns (uint8)`
- `handlePluginFee(uint256 fee0, uint256 fee1) returns (bytes4)`. Called by the pool after it transfers plugin fees. It **must** return the selector, otherwise the swap or burn reverts.
- `beforeInitialize(sender, sqrtPriceX96)` returns bytes4. **Always called** if `plugin != 0`.
- `afterInitialize(sender, sqrtPriceX96, tick)` returns bytes4. Flag `AFTER_INIT_FLAG` = 64.
- `beforeModifyPosition(sender, recipient, bottomTick, topTick, int128 liquidityDelta, data)` returns `(bytes4, uint24 pluginFee)`. Flag 4.
  - On **burn**, `pluginFee` (< 1e6) is withheld from the withdrawn amounts and sent to the plugin (`AlgebraPool.sol:136-158`). On mint the value is ignored.
- `afterModifyPosition(..., amount0, amount1, data)` returns bytes4. Flag 8.
- `beforeSwap(sender, recipient, zeroToOne, amountRequired, limitSqrtPrice, withPaymentInAdvance, data)` returns `(bytes4, uint24 feeOverride, uint24 pluginFee)`. Flag 1.
  - Non-zero override or plugin fee requires flag `DYNAMIC_FEE` = 128, otherwise the swap reverts with `dynamicFeeDisabled` (line 404).
- `afterSwap(sender, recipient, zeroToOne, amountRequired, limitSqrtPrice, amount0, amount1, data)` returns bytes4. Flag 2.
- `beforeFlash` (flag 16) and `afterFlash` (flag 32).
- **Hooks are skipped when `msg.sender == plugin`** for before/after swap and modifyPosition (lines 186, 195, 401, 412). The plugin's own swaps and mints pay no plugin fee and are not blocked by its own hooks.

### Fee units and caps
- **VERIFIED** (`Constants.sol`, `SwapCalculation.sol:63-70`).
- `FEE_DENOMINATOR = 1e6`: 10000 = 1%, 20000 = 2%, 900000 = 90%.
- If `overrideFee != 0`, the total fee is `overrideFee + pluginFee`. Otherwise it is `lastFee + pluginFee`. Either way it must be `< 1e6`, or the swap reverts with `incorrectPluginFee`. **A 90% launch fee is possible.**
- The static `lastFee` is uint16, so at most 65535 (6.55%). Large fees must come from `beforeSwap`.
- **Pitfall:** `overrideFee == 0` means "use lastFee", not "0% LP fee". For "all fee to plugin, none to LP", set the pool's lastFee to 0 via `EP.setFee` *before* turning on DYNAMIC_FEE, or return `overrideFee = 1`.

### Where the fee is charged
- **VERIFIED.** Always the **input token**. `step.feeAmount` is taken from or added to the input (SwapCalculation:89-105).
- Plugin and community fees are booked to the input side: `_changeReserves(amount0, amount1, communityFee, 0, pluginFee, 0)` for zeroToOne, mirrored otherwise (`AlgebraPool.sol` swap).
- Confirmed live: in tx 0x66cfe0… the vault received 0.0006 WDOGE (= 2 WDOGE × 1% × 3%) in WDOGE, the input token.

### The community fee also cuts the plugin fee
- **VERIFIED** (`SwapCalculation.sol:108-117`). Per step:
  1. `communityFeeAmount += feeAmount × communityFee / 1000`, taken from the **total** fee (LP + plugin);
  2. `pluginFeeAmount += remaining × pluginFee / fee`.
- So the plugin receives `pluginFee × (1 − cf)`, and LPs receive `lpFee × (1 − cf)`.
- **Default `communityFee = 30` means 3% of the whole swap fee, not 3% of volume.** At a 2% plugin fee and 0% LP fee: 0.06% of volume goes to Barkswap and 1.94% to us.
- `MAX_COMMUNITY_FEE = 1000` (100%). At 100%, LPs and the plugin get nothing (the remaining feeAmount is 0).
- Flash fee 0.01% is also cut by the community fee.

### How the plugin fee is paid
- **VERIFIED** (`base/ReservesManager.sol` `_changeReserves`/`_accrueAndTransferFees`).
- Fees accrue in `pluginFeePending0/1` (uint104; view `getPluginFeePending()`).
- They are pushed to the address in `plugin`, then `plugin.handlePluginFee(sent0, sent1)` is called. This happens on the next fee-bearing swap, burn or flash once `block.timestamp − lastFeeTransferTimestamp ≥ FEE_TRANSFER_FREQUENCY = 8 hours`, or when pending would overflow uint104.
- **`lastFeeTransferTimestamp` is shared with the community fee.** The first fee after creation is sent immediately because the timestamp starts at 0.
- There is no pull or `collectPluginFee` function. The plugin cannot force a payout earlier than 8 h.
- If an admin swaps the plugin, **pending plugin fees are paid to the new plugin** (the recipient is read from the `plugin` slot at transfer time).
- `skim()` is plugin-only and sends balance above reserves to the plugin. `sync()` is plugin-only.

### Swapping from afterSwap
- **VERIFIED, contradicts our internal note.** The pool calls `_unlock()` **before** `_afterSwap` (`AlgebraPool.sol:293-294`, 373-374). The pool is *not* locked during afterSwap.
- A plugin can swap in the same pool from afterSwap. That swap skips its own hooks and the plugin fee, but still pays LP fee (lastFee) and the community fee.
- **INFERRED.** It is still impractical for converting sell fees to DOGE at swap time. The plugin only *receives* fee tokens in 8-hour batches, so at afterSwap time it holds no fee coins from that swap. It would also add gas to every trade and make the pool re-entrant during user trades. A keeper or an 8-hour batch in `handlePluginFee` is cleaner. Barkswap's suggestion is technically possible; our "locked" premise was wrong.

---

## 4. Liquidity

### One-sided coin-only position above the current price
- **VERIFIED, live.** Tx 0x66cfe0… minted via the NPM with `[tickLower = −102800 (= current tick), tickUpper = 887200]`: amount0 = 999,999,999.99… BBSS, amount1 = 0 WDOGE.
- In source, `pool.mint` only needs ticks to be multiples of `tickSpacing` (`AlgebraPool.sol:70-73`) and inside MIN/MAX. Ranges entirely above or below the price are allowed (standard V3 math). Our gen-8 style positions A and B (stacked one-sided ranges) map 1:1.
- Note: `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` does not exist in this worktree, so I could not cross-check sections 2.2-2.3.

### Minting directly on the pool vs via the NPM
- **VERIFIED.** Both work.
- Directly: our contract calls `pool.mint(leftoversRecipient, recipient, bottomTick, topTick, liquidity, data)` and pays in `algebraMintCallback(amount0Owed, amount1Owed, data)`. The position belongs to `recipient`, and only `msg.sender == owner` can `burn` or `collect` it (`AlgebraPool.sol:126-141, 207-233`).
- If the plugin itself mints, `beforeModifyPosition` is skipped (line 186).

### Locking
- **INFERRED from source.** A position whose owner contract has no burn path is permanently locked. Nothing in pool, factory or EP can move another owner's liquidity: there is no admin burn and no admin collect.
- Fees on our own position stay collectable by us via `pool.collect`.

### Blocking other LPs
- **VERIFIED (source).** With flag 4, `beforeModifyPosition` can revert for any `sender` other than our launcher. Reverting only when `liquidityDelta > 0` lets existing LPs exit. Via the NPM, `sender` is the NPM, so all NPM mints would be blocked.
- **Caveat:** an admin can clear the flag with `pool.setPluginConfig` (admin path).

### Tick spacing
- `initialize` sets the default 60.
- After that only `pool.setTickSpacing` changes it. That needs POOLS_ADMINISTRATOR: our deployer goes through `EP.setTickSpacing(pool, ts)`, range 1..500 (`AlgebraPool.sol:490-495`). **VERIFIED.**
- The plugin cannot set tick spacing itself.
- The live custom pools use 200.

---

## 5. Admin powers over our pools

### Pool functions gated by `factory.hasRoleOrOwner(POOLS_ADMINISTRATOR, sender)` (`AlgebraPool.sol:472`)
- `setCommunityFee(uint16 ≤ 1000)`: up to **100% of all swap fees** (LP and plugin) to the vault.
- `setPlugin(address)`: replaces our plugin and resets config to 0.
- `setPluginConfig(uint8)`: can switch off our hooks (fee, anti-snipe, LP block).
- `setFee(uint16)`: only when DYNAMIC_FEE is off.
- `setTickSpacing(int24)`.
- `setCommunityVault(address)`: redirects community fees. The factory may also call it at creation.

### Factory functions
- `onlyOwner`: `setDefaultCommunityFee`, `setDefaultFee`, `setDefaultTickspacing`, `setDefaultPluginFactory`, `setVaultFactory`, `transferOwnership`, `start/stopRenounceOwnership`, `renounceOwnership`.
- `DEFAULT_ADMIN`: `grantRole` / `revokeRole`. Revoking the EP's `CUSTOM_POOL_DEPLOYER` role would stop all new custom pools.

### EP functions (only the pool's own deployer D)
- `setTickSpacing`, `setPlugin`, `setPluginConfig`, `setFee`.
- **No `setCommunityFee`.** Our own D is therefore also a privileged actor over our pools and must be audited.

### Vault `0xA305…`
- `algebraFee = 1000/1000` (100% of withdrawn community fees go to `algebraFeeReceiver` = `0xFB15…`).
- `communityFeeReceiver` = `0xFB15…`, `algebraFeeManager` = `0xFB15…`.
- Withdrawals are gated by `COMMUNITY_FEE_WITHDRAWER` or the fee manager.

### Who holds power (VERIFIED, AccessControlEnumerable + all RoleGranted logs)
- Owner and sole `DEFAULT_ADMIN`: **EOA `0xFB1525e16FDA109a5180a3Ec23A7146b870E045b`**. It is a single key, not a multisig, with 545k txs.
- `POOLS_ADMINISTRATOR`: 20 members, the EP plus 19 contracts, **all deployed by `0xFB15…` and all `owner()` = `0xFB15…`**:
  - `0x101646f8…`, `0x5D45Ea11…`, `0xF1583Fc0…`, `0x78492855…`, `0xCb9C0c25…`, `0x55d57004…`, `0x9B355668…`, `0xceA6BF81…`, `0xd5B506ec…`, `0x14f8CE9A…`, `0x7B863836…`, `0x41a3827b…`, `0x11a282E2…`, `0xbFa8E142…`, `0x74F81d6a…`, `0x967eAf16…`, `0x407c235F…`, `0xcf59F9E2…`, `0xC0B339e3…` (granted between block 7,620,632 and 8,548,939).
  - **INFERRED from unverified bytecode:** these look like iterations of a Barkswap launch/ICO "pool configurator". Selectors include `configure(address,address)`, `icoManager()`, `creator()`, `liquidityLock()`, `splitterOf`, `setLimits`, `maxPoolFee`, `setLpFee`. Their code calls the pool functions `setFee`, `setPluginConfig` and `setCommunityVault`. Strings include "!laika", "!eco", "!dao".
  - **UNKNOWN:** who may call `configure()` on them, and whether a third party could use them to touch our pool. The 19 contracts are not verified.
  - The "~20 admin addresses" claim is **VERIFIED** (20 incl. EP).
- `INCENTIVE_MAKER_ROLE` (`0xa777c102…`, farming) is held by 4 contracts.

### Can anyone move funds out of the pool or our positions?
- Principal of a locked position: **no** admin path (no admin burn or collect). **VERIFIED (source).**
- **But (VERIFIED, source):**
  1. An admin can set the community fee to 100% and take all future LP and plugin fees.
  2. `setPlugin` to their own plugin redirects pending and future plugin fees, and can add up to 99.9999% fees to every trade (the fee goes to LPs or their plugin).
  3. A plugin swapped in by an admin can charge up to 99.9999% `pluginFee` on any **burn**. That matters only for positions that ever withdraw.
  4. Clearing `pluginConfig` removes our LP block and anti-snipe.
- **INFERRED.** The worst case is loss of all fee income plus trader harm, not theft of locked principal.

---

## 6. Live custom pools (VERIFIED, factory logs from block 5,032,996 to 8,577,569; 118 Pool events and 5 CustomPool events)
| Pool | Deployer (EIP-1967 proxy) | Pair | Block | Gas |
|---|---|---|---|---|
| `0x0264C1ed…0Ab5` | `0xC2f648BC…` | 0x394b…7777 / UUSD `0x6FB651c4…` | 8,425,070 | 6,420,908 |
| `0x87307d26…16F0` | `0x27D21FcB…` | UUSD / 0xda88…7777 | 8,429,543 | 6,419,731 |
| `0x6F41a829…c4F1` | `0xEF38Cf3b…` | 0x183C…7777 / UUSD | 8,429,747 | 6,416,240 |
| `0x1ebade9E…0c39` | `0xEF38Cf3b…` | 0x639E…7777 / UUSD | 8,449,788 | 6,419,076 |
| `0x330F1b44…EC0D` | `0xEF38Cf3b…` | BBSS 0xA389…7777 / WDOGE | 8,453,797 | 6,426,752 |

- All five were created by EOA `0xd25aF8A1c524F7c554FAced699f5D34d150B5B8d`, a third-party launchpad with vanity "…7777" tokens. The last was sent by `0x75eA8219…`.
- Common state: plugin = 0, fee 10000 (1%), communityFee 30, tickSpacing 200, vault 0xA305….
- Pool 0x330F… has `getCommunityFeePending()` = (4.33e18 BBSS, 0).
- None of these pairs has a default pool (`poolByPair` = 0).
- **No custom pool with a plugin exists yet.** Ours would be the first.

---

## 7. Gas and limits
- Block gas limit **10,000,000** (VERIFIED, `eth_getBlockByNumber`). Block time ~3 s. baseFee ~0.0157 gwei.
- Pool deployment alone (CREATE2 of the 22,493-byte AlgebraPool) ≈ **4.4-4.5 M gas**. **INFERRED** from internal-tx gas limits (5,443,454 before the create2 call, ~1,006,589 left at the next call), consistent with 200 gas/byte code deposit.
- Default `createPool` = **8,114,099 gas** (tx 0x0ebb409d…). About 3.1 M of that is deploying a per-pool BasePluginV1 (internal tx 7,896,980 → 4,780,353).
- Whole custom launch (token CREATE2 + custom pool, no plugin + init + setTickSpacing + setFee + NPM mint + 2 WDOGE buy + lock) = **6.42-6.43 M** (VERIFIED, table in §6).
- **INFERRED.** Adding a per-pool plugin contract (~200 gas/byte, so a 10-15 KB plugin costs 2-3 M) would put a single launch tx at ~8.5-9.5 M+, uncomfortably close to or above 10 M.
  - Use a **singleton plugin**: one contract returned for every pool. Hooks receive `msg.sender = pool`, and `handlePluginFee` is called by each pool.
  - Alternatively, split the launch across txs, guarded by `beforeInitialize` and `beforeModifyPosition`.
- `debug_traceTransaction` is not available on the public RPC. I used Blockscout `/internal-transactions` instead.

---

## 8. Hypotheses vs findings
| Claim | Verdict |
|---|---|
| Factory 0xF396… | VERIFIED |
| Custom pool entry point 0x19b1… | VERIFIED (stock 1.2.1 EP, byte-identical) |
| Router 0x911E5A16… / NPM 0xf596329a… | VERIFIED: `0x911E5A1630fD1768E5A1710DAAFaBb865cB79531` / `0xf596329a6c7E03F0708199cB5435f86783DB4302` |
| Algebra Integral 1.2 | VERIFIED, more precisely **1.2.1**, unmodified |
| Core BUSL until 2027-03-15 | VERIFIED (earlier of 2027-03-15 or 4 years) |
| Default community fee 3% | VERIFIED: `defaultCommunityFee = 30/1000` = **3% of the total swap fee (LP fee + plugin fee)**, in the input token. Not 3% of volume. Applied to every new pool, custom ones included, at `initialize`. |
| ~20 admins can setPlugin/setFee/setCommunityFee on any pool | VERIFIED (20 POOLS_ADMINISTRATOR: EP + 19 contracts, all owned by one EOA `0xFB15…`, which as owner can also do all of it directly) |
| Plugin fees paid every 8 h, reduced by the community fee | VERIFIED. The 8 h timer is shared with the community fee, the first payout is immediate, it is push-only, and pending fees follow the current `plugin` address. |
| All fees input-side | VERIFIED |
| Custom pools need a factory role per deployer | **CONTRADICTED.** Only the EP holds `CUSTOM_POOL_DEPLOYER`. Any contract can create custom pools via the EP; 3 unrelated deployers already have, with no grant. |
| Our note "pool is locked during afterSwap" | **CONTRADICTED.** `_unlock()` runs before `_afterSwap`. |
| "If a default pool exists the router may pick it" | VERIFIED as possible. Anyone can create a default pool (BasePluginV1, ~0.01-1.5% adaptive fee) or their own custom pool for our pair at any time. |

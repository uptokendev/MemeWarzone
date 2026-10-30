# Barkswap custom-pool plugin: fork proof (research only)

Can a MemeWarzone coin launch on Barkswap (DogeOS Chikyu 6281971) the gen-8 way, with Barkswap's Algebra Integral
v1.2.1 custom pools and one shared plugin taking the place of the V4 hook? This folder is the proof.

Nothing here is production code. Nothing is sent to a real network. `run-proof.mjs` starts
`hardhat node --config hardhat.dogeos-testnet-fork.config.ts`, an in-process fork with Chikyu's 10,000,000
block gas limit. It signs with fresh deterministic research keys that are funded on the fork only, and it never
reads a key from `config/*.local`.

```
node scripts/research/barkswap-plugin/run-proof.mjs [--port 8681]     # about 6 minutes
```

Outputs: `results/barkswap-plugin-proof.log` (console) and `results/barkswap-plugin-proof.json` (checks, gas, data).
The last run: **117/117 PASS** on fork block 8,578,734.

## Contracts (`contracts/`)

| File | Role |
|---|---|
| `MwzBarkLauncher.sol` (D) | The custom-pool deployer and plugin factory. `beforeCreatePoolHook` returns the one shared plugin P. `launch()` does everything in one tx: coin CREATE2, `EP.createCustomPool`, `initialize`, `EP.setTickSpacing`, `EP.setFee(0)`, `EP.setPluginConfig(135)`, mint A and B (direct `pool.mint`, or NPM as a variant), send the 20M reserve, burn dust, and the optional creator first buy. The only other non-view functions are `takeGraduationFee` and `collectLpFees` (LP-fee mode, fees only). There is no withdraw path for A or B. |
| `MwzBarkPlugin.sol` (P) | One plugin for every pool. `beforeInitialize`: only D. `beforeModifyPosition`: only D may add liquidity. `beforeSwap`: the gen-8 rate. `afterSwap`: the graduation latch. `handlePluginFee`: per-pool books. `convertCoinFees` turns coin fees into WDOGE. Written against the GPL interfaces only, with no BUSL base-plugin code. |
| `MwzBarkToken.sol` | A plain 1B ERC20. It has an optional side-pool guard (check 8, research option). |
| `ResearchBarkHelpers.sol` | An outsider direct minter and a direct pool trader. |

Every pool has the coin as token0 and WDOGE as token1. The launcher reverts otherwise, and the runner picks the
CREATE2 salt off chain (about 96% of addresses sort below WDOGE `0xF6BD…`). A buy is therefore oneToZero, and the
price is WDOGE per coin and rises on buys.

## Checks

| # | What was proven | Result |
|---|---|---|
| 1 | One-tx launch: create, init, tick spacing, lastFee 0, config 135, A and B one-sided coin-only owned by D, 20M reserve, dust burned. Pool address = `computeCustomPoolAddress(D, coin, WDOGE)`. `beforeInitialize` reverts for anyone but D. Re-init reverts. Nobody but D can create a pool under deployer D (`EP: Only deployer`). The direct `pool.mint` route works and is the cheaper one: 6.13M gas, against 6.64M through the NPM (+505k, because two NFTs are minted, and the NPM mints must happen *before* the LP block is switched on). | PASS |
| 2 | The curve. With tickSpacing 10, grad MC, start MC and A's raise are all within 482 ppm of gen-7. tickSpacing 60 is within 2,102 ppm. **tickSpacing 200, Barkswap's usual, is up to 9,241 ppm off** ($150: grad MC 1,486 DOGE vs 1,500). On chain, a price-limited buy of all of A stops exactly at `tickGrad`, gives out 850M coins, and takes native equal to the plan within 2 wei. At DOGE $0.10: **$150 target** gives A's raise 198.94 DOGE ($19.89) at sp 10 and 198.64 at sp 200. **$30K target** gives A's raise 39,785 DOGE ($3,978.50) and grad MC 297,649 DOGE at sp 200, 300,040 at sp 10/60. | PASS |
| 3 | Fees. The launch decay 90% to 2% is linear over 60 s from the launch block (t+1 88.53%, t+30 46%, t+59 3.47%, t+60 2%), then 2% bonding and 1% at or past the graduation price at swap start (F1). The creator first buy pays 2%. **The buy fee is in WDOGE (input) and the sell fee is in coins (input).** Community vault takes 3% of the whole fee, so we keep 97%: 1.94% of bonding volume, 0.97% after graduation. `overrideFee` semantics: see the fee-mode section below. | PASS |
| 4 | Outsider mints revert with `LiquidityIsLocked`: through the NPM (coin side above the price, and WDOGE side below it) and through a direct `pool.mint` with its own callback. D's own mints pass (every launch). | PASS |
| 5 | The crossing buy (start inside A, end in B) pays the bonding rate. The `afterSwap` latch sets `graduated` and `graduatedAt = block.timestamp` and emits `Graduated`. **The plugin can also reconfigure the pool from afterSwap**: the pool is unlocked, so it switches config 135 to 133 and drops its own afterSwap hook. It can also call D there. The next buy pays 1%. A sell that starts at or above the graduation price pays 1%; a sell that starts back inside A pays 2%, and the latch stays set. `takeGraduationFee` (permissionless, separate tx) burns floor(2% of liqA). A is entirely native at that price, so it returns 3.972864420 WDOGE = floor(2% of 198.643221043) exactly, sent to the treasury. A keeps 98%, B is untouched, and a second call reverts. The **inline variant** (P's afterSwap calls `D.takeGraduationFee` inside the crossing swap, wrapped in try/catch) works as well. | PASS |
| 6 | Pending fees are not pushed until 8 h have passed. The next swap after 8 h calls `P.handlePluginFee(fee0, fee1)` once, with all pending fees in **both tokens** (1,513,200 coins + 3.742 WDOGE). P's balances move by exactly those amounts. The vault gets its 3% in both tokens in the same swap. msg.sender is the pool, so the per-pool books reconcile with P's balances across three pools. **A reverting `handlePluginFee` reverts every payout swap**; swaps before the 8 h mark keep working. The first fee after pool creation is pushed at once, inside the launch tx. `convertCoinFees`: P's own swap skips every hook and pays no fee and no community fee (lastFee 0); it sold 1.51M coins for 0.6086 WDOGE. | PASS |
| 7 | The Barkswap SwapRouter `exactInputSingle(tokenIn, tokenOut, **deployer = D**, …)` with `msg.value` wraps DOGE and trades in our pool. Sells use `multicall(exactInputSingle → router, unwrapWNativeToken)`, and limited buys use `multicall(…, refundNativeToken)`. `deployer = address(0)` targets the non-existent default pool and reverts. QuoterV2 with `deployer = D` quotes exactly what the swap returns, plugin fee included. | PASS |
| 8 | Anyone can `factory.createPool(coin, WDOGE)`: 8,114,099 gas, which fits a 10M block. They can then add coin liquidity to that pool. The optional coin guard refuses transfers *to* any other Barkswap Algebra pool before our pool graduates. The test for "another pool" is `factory() == Barkswap factory` plus a `token0()` that answers; the router and NPM fail the second test, so they still work. With the guard, the NPM mint into the side pool reverts (`STF`), a direct transfer reverts `SidePoolBlocked`, router swaps on our pool still work, and the guard lifts at graduation. | PASS |
| 9 | Gas: see the table below. | measured |

## Gas (hardhat fork of Chikyu, block gas limit 10,000,000)

| Step | Gas |
|---|---|
| Deploy D + P (once per chain) | 4,599,820 |
| Launch, direct mint, sp 200 / 60 / 10 | 6,131,654 / 6,123,293 / 6,132,142 (61% of a block) |
| Launch via NPM | 6,636,853 |
| Launch with creator first buy 10 DOGE | 6,298,252 |
| Launch with coin guard | 6,158,392 |
| (coin deploy alone, for reference) | 763,441 |
| Router buy (native in), bonding | 175,645 |
| Direct pool buy (no router) | 149,178 |
| Router sell (coin in, native out, multicall + unwrap) | 158,294 |
| Graduation-crossing buy (latch + config switch) | 183,257 |
| Crossing buy with inline 2% graduation fee | 310,057 |
| Buy out all of A to the graduation price (limited multicall) | 285,237 |
| Post-graduation buy (no afterSwap call) | 136,930 |
| `takeGraduationFee`, separate tx | 143,660 |
| Payout swap (8 h push of plugin + community fees, 2 tokens each) | 234,093 (+58k over a plain buy) |
| `convertCoinFees` | 144,774 |
| `collectLpFees` (LP-fee mode) | 164,954 |
| Coin guard overhead: router buy / router sell / transfer to an EOA / transfer to a contract | +140 / +2,341 / +2,640 / +5,385 |
| Outsider `factory.createPool` (side pool, deploys a BasePluginV1) | 8,114,099 |

## Fee mode: plugin fee vs LP fee

- **`overrideFee == 0` means "use lastFee"**, not "LP fee 0". The factory default lastFee is 500 (0.05%).
- **Plugin-fee mode** (the main pool): D calls `EP.setFee(pool, 0)` *before* turning on DYNAMIC_FEE (afterwards `setFee` reverts with `dynamicFeeActive`), and P returns `(0, rate)`.
  - Measured: totalFeeGrowth does not change, so the LP fee is 0.
  - P gets 97% of the fee in 8-hour pushes.
- **LP-fee mode** (pool L): P returns `(rate, 0)`. The fee accrues to D's own positions, which are the only liquidity.
  - `collectLpFees` sends it to the treasury at once: no 8 h wait, no `handlePluginFee`, nothing pending that follows the `plugin` slot.
  - The 97/3 split is the same.
  - Measured: 0.2853 WDOGE collected in one call.
- **Recommendation to discuss: LP-fee mode.**
  - It removes the 8 h push, the "handler must never revert" liability and the risk that an admin `setPlugin` redirects pending fees. Accrued LP fees belong to D's positions, and no admin can move them.
  - The cost is a fee-only collect function on D.
  - Sell fees still arrive as coins in both modes.

## Deviations from gen-8 (what cannot be done the gen-8 way, and the workaround)

1. **Fees are always charged in the input token.** Sells pay in **coins**, not native, so gen-8's "MemeWarzone never receives coins" rule cannot hold. Workaround: P (or the treasury in LP mode) sells the coin fees in our own pool. P's own swap is fee-free and hook-free (proven). The catch: it is a sell on the curve, and a keeper has to trigger it.
2. **Algebra takes the fee out of the input.** gen-7 charges buys r *on top of* the curve cost. Workaround: P returns r/(1+r) on buys, which is 19,607 for 2%. Fee units are 1e6, so the result is 1.9999% instead of the exact-to-the-wei 2% of gen-8 (worst 3 units in 1e6). Sells pay r of the coins in; gen-7 takes r of the native payout. The value is the same, the token differs.
3. **Barkswap's community fee is 3% of every fee**, plugin fee included, and is paid to their vault. We cannot change it: the EP has no `setCommunityFee`, and their admins can raise it to 100%. Net to us: 1.94% bonding and 0.97% after graduation.
4. **Plugin fees are pushed, not pulled**, every 8 h, on a timer shared with the community fee. The handler must never revert. Pending fees go to whatever address is in the `plugin` slot at push time. Workaround: LP-fee mode (above).
5. **Admin trust.** Gen-8's V4 hook is immutable and nobody can touch a pool. Barkswap's single admin EOA and its 19 configurator contracts can call `setPlugin`, `setPluginConfig` (which can remove our LP block and fee hooks) and `setCommunityFee` on our pools. The principal of A and B cannot be moved by anyone, but future fees can.
6. **Graduation fee.** Gen-8 takes the 2% inside the crossing swap. Here both ways are proven: a separate permissionless step, and inline from afterSwap (+127k gas on the crossing swap). The separate step needs the price at or above the graduation price when it is called; if the price has fallen back, it waits. Suggestion: inline with try/catch, plus the separate step as the fallback.
7. **Tick spacing.** Barkswap pools use 200, which moves grad MC by up to 0.92%. Use 10 (gen-8's value, no gas difference). Only D can change it, through `EP.setTickSpacing`; the plugin cannot.
8. **Launch cost.** A launch costs 6.1M gas against 1.1-1.7M for gen-8, because a 22.5 KB pool is deployed per coin (about 4.5M). That is 61% of a Chikyu block, so at most one launch fits per block. A per-pool plugin would push it past roughly 8.5M; the shared plugin avoids that.
9. **Pool orientation.** The pool trades WDOGE (an ERC20), not native currency 0. The coin must sort below WDOGE (salt mining) unless the launcher and plugin handle both orders.
10. **Routing.** Every router or quoter call needs `deployer = D`. Aggregator support for Algebra custom pools, and DexScreener or GeckoTerminal indexing of `CustomPool`-only pools (1.2.1 emits no `Pool` event), are **unknown**.
11. **Side pools.** Same as gen-8 F18. The coin guard is cheap but bends gen-8's "plain ERC20" decision. It only catches pools of the Barkswap factory: other DEXes and non-Algebra wrappers get through.
12. **Research shortcuts, not production.** Ticks, prices and liquidities are computed by the runner (production: on chain, plus a DOGE/USD source; there is no gen-7 oracle on DogeOS here). Fee rates are parameters. P has a research-only `setResearchRevertHandle` switch.

## Open questions

- Will Barkswap give up or limit their admin power over our pools (plugin, config, community fee)? Is the mainnet EP gated?
- Which fee mode do we use, plugin or LP? Who converts the coin fees, and when?
- Do DexScreener, GeckoTerminal and aggregators index and route Algebra custom pools that use a plugin?
- Do we want the coin guard? It changes gen-8's free-transfer decision.
- Production launcher: on-chain curve planning, the oracle on DogeOS, both token orders, and a pause.

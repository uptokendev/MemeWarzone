# DogeOS Barkswap contracts (gen-8 on Algebra): internal audit, Gate 0

**Spec:** `docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md` (sections 2-3, B4, B10, B11; Invariants;
Audit; Accepted testnet risks). **Plan:** `docs/templar/plans/2026-10-15-dogeos-barkswap-launch.md` (t3, t32, t4-t7).
**Facts:** `docs/dogeos/barkswap-facts.md` (Algebra Integral 1.2.1 behaviour and Barkswap admin powers).
**Proof (research only):** `scripts/research/barkswap-plugin/` (117/117 on a Chikyu fork).
**Rule applied:** CLAUDE.md section 1, "Contracts are written to pass a real audit on the first pass": every function on
or next to a money path states its reentrancy guard, its checks-effects-interactions order, which states can and
cannot reach it, what happens on over/underflow, and how it can be griefed. Written as an external auditor would; a
verdict may be FAIL.

## Scope

| Contract | File | Audit kind | Section written by |
|---|---|---|---|
| MwzBarkPlugin (+ `IMwzBarkLauncher`, the launcher surface it calls) | `contracts/dogeos/barkswap/MwzBarkPlugin.sol`, `contracts/dogeos/barkswap/interfaces/IMwzBarkLauncher.sol` | full audit (new code) | t3 |
| MwzBarkLauncher | `contracts/dogeos/barkswap/MwzBarkLauncher.sol` | full audit (new code) | t32 (launch, restore), t4 (money side) |
| MwzBarkFeeSplitter, MwzBarkReserveLock, MwzBarkLaunchLens | `contracts/dogeos/barkswap/` | diff audit against gen-8 `contracts/gen8/` (vendored from `e129712b9`) | t5 |
| MwzBarkCreatorChoiceVault, MwzBarkCreatorEscrow | `contracts/dogeos/barkswap/` | diff audit against gen-8 | t6 |

Out of scope: the Algebra Integral 1.2.1 contracts Barkswap runs (unmodified upstream, bytecode-matched, facts section
1; only their GPL interfaces are vendored, under `contracts/dogeos/barkswap/interfaces/`); the gen-8 contracts reused as
is (`MwzV4Token`, the `MwzFeeMath` library, both byte-identical to `e129712b9` and audited in
`docs/evm-launch/GEN8_INTERNAL_AUDIT.md`); the unchanged vaults and oracles the stack is wired to.

## Compiler and build

solc 0.8.26, EVM `cancun` (TSTORE/TLOAD; Chikyu supports PUSH0, MCOPY and TSTORE), via-IR, optimizer 200 runs,
`bytecodeHash: none`: gen-8's exact settings, taken from `hardhat.gen8.config.ts` by
`hardhat.dogeos-bark-fork.config.ts` (artifacts in `artifacts-bark/`). OpenZeppelin 5.4.0 (root lockfile; only
`SafeCast` is used by the plugin); `@uniswap/v4-core` 1.0.2 `TickMath` (pinned exactly, the gen-8 dependency; an
internal library, no external call). Sizes: `node scripts/dogeos-bark-sizes.mjs` (EIP-170, exits non-zero above 24,576
bytes).

| Contract | Runtime bytes (2026-10-15) |
|---|---|
| MwzBarkPlugin | 9,569 (fix round 1; 7,978 at first write) |

## Method

- `MwzBarkLauncher` and `MwzBarkPlugin`: an Algebra plugin is too different from a V4 hook for a line diff, so both
  get a full audit against the spec's invariant list, function by function, plus the Barkswap admin powers of facts
  section 5 and the gen-8 audit points (A1-A15, F1-F17) where they apply.
- The other five: a diff audit against their gen-8 counterpart (`git diff --no-index contracts/gen8/<file>
  contracts/dogeos/barkswap/<file>`), every hunk explained, swap paths covered in full (spec "Audit scope note").
- Each function entry gives: **Guard** (reentrancy), **CEI** (order of checks, effects, external calls),
  **States** (who and which contract states can reach it, which cannot), **Over/underflow**, **Griefing**.
- Facts that rest on upstream Algebra source not vendored here (call order inside `swap`, rounding per swap step) are
  marked "fork-checked in tN" and become test cases there; nothing is deployed or tested before Gate 0 (t7).

## How verdicts are given

Each contract section ends with exactly one verdict line, at the start of a line: `Verdict: PASS`, `Verdict: FAIL` or,
until the Gate-0 review, `Verdict: pending (t7)`. Verdicts are written only by the Gate-0 reviewer (t7), after every
finding of that contract is fixed in code and re-audited in this file. PASS means: no open finding that can lose or
misroute money, break an invariant of the spec list, or stop trading, claims or graduation; informational items are
listed with the reason they are accepted. Severity scale for findings: Critical (funds lost or stolen), High (an
invariant broken or funds frozen), Medium (a bounded loss or a griefing vector with real cost), Low (defense in depth,
edge cases without loss), Informational. A contract change after its PASS re-opens the verdict: the same commit updates
the changed function's entry here and the change is re-reviewed (plan, global constraints).

---

## MwzBarkPlugin

**Files:** `contracts/dogeos/barkswap/MwzBarkPlugin.sol` (577 lines), `contracts/dogeos/barkswap/interfaces/IMwzBarkLauncher.sol`
(45 lines). **Imports:** the vendored Algebra 1.2.1 interfaces `IAlgebraPlugin`, `IAlgebraPoolState`,
`IAlgebraPoolImmutables`; gen-8 `FeeConfig` and `MwzFeeMath` (unchanged); OZ `SafeCast`; v4-core `TickMath`.

**Fix round 1 (t3 review, 2026-10-15).** (a) Tick alignment: `registerPool` takes A's ticks and derives `sqrtStart`
and `sqrtGrad` with `TickMath` (gen-8 `MwzLaunchHook.createPool` pattern), stated as obligation O1; `beforeModifyPosition`
now checks the ranges of launcher mints and of the graduation burn. (b) `getCurrentFee()` added so `pool.fee()` works.
(c) A conversion is refused inside the 60 s launch window. (d) The inline graduation-fee claim is narrowed (a revert
cannot revert the trade, an out-of-gas can). (e) Open questions 1 and 8 rewritten against the upstream v1.2.1-integral
source. Every changed entry below is updated.

### Role

The one shared Algebra Integral 1.2.1 plugin for every MemeWarzone custom pool on Barkswap: the swap side of gen-8's
`MwzLaunchHook` (spec section 3, plugin row). It decides each swap's fee (LP-fee mode, B4), refuses outside liquidity,
enforces the scheduled open and the start-price floor (gen-8 B, F2), keeps per-pool per-phase fee totals with the
creator amount on the gross fee (B10), emits one `BarkSwap` event per swap, sets the graduation latch and
`graduatedAt`, and triggers the one-time graduation fee through the launcher. It holds no money of ours and moves none:
it charges no plugin fee (pluginFee is always 0), has no token transfer, no withdraw, no owner and no setter.

Pool orientation (checked at initialize): token0 = the coin, token1 = WDOGE. A buy is `zeroToOne == false` (WDOGE
in), a sell `zeroToOne == true` (coin in). The pool price (WDOGE per coin, Q64.96) rises on buys; position A spans
ticks [tickStart, tickGrad], B [tickGrad, tickMax]. "Inside A" means `price < sqrtGrad`; "at or past graduation"
`price >= sqrtGrad`.

**Tick alignment** (underpins I6 and F2). The plugin stores A's two ticks and derives
`sqrtStart = getSqrtPriceAtTick(tickStart)` and `sqrtGrad = getSqrtPriceAtTick(tickGrad)` itself, so `sqrtStart` is
exactly A's lower bound (below it no liquidity exists: the F2 floor) and `sqrtGrad` exactly A's upper bound and B's
lower bound (at or past it A holds WDOGE only: the graduation burn returns WDOGE only). The launcher cannot hand in
prices that are off the ticks; O1 requires it to mint A at [tickStart, tickGrad] and B at [tickGrad, tickMax], and
`beforeModifyPosition` refuses any launcher mint below tickStart or straddling tickGrad and any launcher burn outside
[tickStart, tickGrad]. `getSqrtPriceAtTick` (v4-core 1.0.2) is the gas-optimised Uniswap V3 `getSqrtRatioAtTick`;
Algebra Integral's TickMath is the same V3 function. Equality on the three ticks is fork-checked in t8 (the pool
initialized at `sqrtStart` reports tick == tickStart; A's mint at [tickStart, tickGrad] takes coins only).

### Trust model and wiring

| Actor | Power over the plugin |
|---|---|
| `launcher` (immutable, MwzBarkLauncher) | registers pools (`registerPool`, once per not-yet-deployed pool address); is the only address that may initialize and add liquidity; its swaps get the creator-first-buy exception (bonding rate, before openAt) and, while its conversion flag is set, the 0-fee conversion; its one non-zero burn is checked. Trusted, audited in this file (t32/t4), bound by obligations O1-O4 below. |
| `creatorEscrow`, `choiceVault` (immutable) | labels only: their swaps are tagged escrow buy / buyback in `BarkSwap`. No fee, rate or permission depends on them. |
| `wNative` (immutable, WDOGE) | pool orientation check and the `feeToken` of buys. |
| Our pools (msg.sender of every hook) | each hook acts only on the calling pool's own entry. |
| Anyone else | no state-changing entry: every hook reverts `UnknownPool` for a caller that is not a registered pool; `registerPool` is launcher-only; views are free. |
| Barkswap admin (factory owner EOA + 20 POOLS_ADMINISTRATOR members) | cannot call the plugin, but can change our pools' plugin, config, community fee and (dynamic flag off) static fee: see "Barkswap admin powers". |

**Deploy wiring.** All four constructor arguments are immutable and must be non-zero; launcher, escrow and choice vault
must be distinct (`BadWiring`). The plugin must exist before the launcher's first launch and the launcher must return
it from `beforeCreatePoolHook`. Two orders work, both decided in t32/t15: (a) the launcher deploys the plugin in its own
constructor (`new MwzBarkPlugin(address(this), wdoge, escrow, vault)`, escrow and vault deployed first against the
launcher's predicted address, as gen-8 deploys the reserve lock and choice vault), or (b) the plugin is deployed first
against the launcher's predicted address. Either way the launcher's constructor must check
`plugin.launcher() == address(this)` and the deploy script must check `creatorEscrow()` / `choiceVault()` against the
deployed periphery (a wrong label address mislabels swaps; it cannot move money).

**Launcher obligations** (declared in `IMwzBarkLauncher`, to be verified in the MwzBarkLauncher section):
- O1: `registerPool(pool, coin, tickStart, tickGrad, openAt)` before the pool exists, coin below WDOGE, then
  `pool.initialize(plugin.pools(pool).sqrtStart)` by the launcher; A minted at [tickStart, tickGrad] and B at
  [tickGrad, tickMax], so `sqrtStart == getSqrtRatioAtTick(bottomTick of A)` and
  `sqrtGrad == getSqrtRatioAtTick(topTick of A) == getSqrtRatioAtTick(bottomTick of B)`.
- O2: the launcher swaps only for the creator first buy inside `launch` and the conversion sell inside `convert`;
  `conversionInProgress(pool)` is true exactly around the conversion's `pool.swap`, is a plain view without a
  reentrancy guard, and never reverts.
- O3: the launcher mints only inside `launch`, to itself; its only non-zero burn is the graduation burn; collects use
  zero-amount burns.
- O4: `EP.setFee(pool, 0)` while the dynamic-fee flag is off, then `PLUGIN_CONFIG` (135), at launch and in `restore`.

### State

| Variable | Kind | Written by | Notes |
|---|---|---|---|
| `pools[pool]` slot 0: `sqrtGrad`, `openAt`, `graduated`, `graduatedAt`, `gradBurnDone` | storage, 32 bytes packed | `registerPool` (all, once), `afterSwap` (latch: `graduated`, `graduatedAt`, once), `beforeModifyPosition` (`gradBurnDone`, once) | `sqrtGrad != 0` is the "registered" test |
| `pools[pool]` slot 1: `coin`, `tickStart`, `tickGrad`; slot 2: `sqrtStart` | storage | `registerPool` only | never changed; `sqrtStart` / `sqrtGrad` derived from the ticks |
| `_fees[pool]` (`bondingNative`, `bondingCoin`, `postNative`, `postCoin`, each `{uint128 creator, uint128 router}`) | storage | `afterSwap` (`_book`) only, monotonic | read through `feeTotals(pool)` |
| hand-over `keccak256(abi.encode(T_SWAP, pool))` | transient | `beforeSwap` (set), `afterSwap` (read and cleared) | one slot per pool |

No owner, no pause, no setter. Rates are constants (gen-8 L1: 200 / 100 / 50 / 9000 bps, creator bonding 560 bps) and
`PLUGIN_CONFIG` is the constant 135 (`BEFORE_SWAP | AFTER_SWAP | BEFORE_POSITION_MODIFY | DYNAMIC_FEE`), so stored rates
can never change (I12).

### Fee math

- **Rate** (bps of the curve amount, gen-7 definition): `MwzFeeMath.rate(feeConfig(), post, isLauncher, openAt, now)`,
  the gen-8 library unchanged: `post` (price at swap start `>= sqrtGrad`) gives 100; otherwise the launcher's swap gets
  200; otherwise 200 + 8800 x secondsLeft / 60 for the first 60 s after `openAt`, then 200. Gen-8 F1 (phase by start
  price, not the latch) and B (decay from `openAt`) carry over as is.
- **Algebra fee** (1e6 units, charged on the input token): a sell pays `r x 100` (rate r of its coin input; 90% at
  t = openAt is 900,000 < 1e6); a buy pays `floor(u x 1e6 / (1e6 + u))` with `u = r x 100` (r/(1+r) of its WDOGE
  input, so the curve receives input/(1+r) and the fee is r on top of the curve cost, gen-7). 2% gives 19,607 units:
  1.99996% of the curve cost instead of 2% (spec: "within fee-unit rounding", measured 1.9999% in the proof); the
  difference is below one fee unit (1e-6 of the input) and favours the trader. Exact-output swaps charge the same
  fraction (Algebra adds `input x f / (1e6 - f)`, which for a buy is exactly r x input).
- **Partial fills** (gen-8 I2): Algebra charges the fee per step on the input actually consumed, so a price-limited
  swap pays only on its filled part by construction. Gen-8 needed `MwzSwapSim` and the `PartialFill` safety net for
  this; neither is needed here (gen-8 A1 does not apply).
- **Sells vs gen-7**: gen-7 takes r of the WDOGE payout; here the fee is r of the coins in, and the trader receives the
  payout of the remaining coins. Since the payout is concave in the coins sold, the trader gets slightly more than
  gen-7's `(1 - r) x payout` (spec "Fees are input-side", accepted).
- **Per-swap booking** (`_book`, in `afterSwap`, from the amounts the pool reports): `amountIn` = the positive pool
  delta (fee included), `gross = floor(amountIn x feeUnits / 1e6)`, `net = gross - floor(gross x cf / 1000)` with `cf`
  Barkswap's community fee at swap time (clamped to 1000), creator amount on the GROSS fee:
  `floor(gross x 560 / 10000)` in the bonding phase, `floor(gross x 50 / 100)` (50% of the fee = 0.50% of volume) in the
  post phase; creator first: `creator = min(creator, net)`; router remainder `net - creator` (never negative). Both are
  added to the phase book of the fee token (WDOGE for buys, the coin for sells). So `creator + router == net` per swap
  and per book, and the creator amount is exactly B10's whenever Barkswap's cut leaves enough (cut <= 94.4% while
  bonding, <= 50% after graduation; the default is 3%). Above that the creator receives the whole net fee and the
  router 0; nothing can pay more than the net fee that reached our positions.
- **Tolerance** (spec "within a stated rounding tolerance"): the plugin books an estimate; the pool computes the fee
  per step (`mulDivRoundingUp(input, f, 1e6 - f)` on a step that reaches its target, `amountAvailable - input` on the
  last step), takes the community cut per step, and credits our position through Q128 fee growth (floored). The
  estimate is therefore below the pool's fee by up to about 2 wei per step and differs from what `collect` can take by
  a few wei per step either way; a swap crosses at most three initialized ticks (start, graduation, max), so at most
  four steps. Expected bound: <= 16 wei per swap per book. Fork-checked in t9, which pins the measured bound; the
  launcher's collect (t4) must tolerate both signs (see open questions 4 and 5).

### Transient hand-over and nested swaps

`beforeSwap` writes one packed word per pool (`HANDOVER_SET | kind << 64 | phase << 56 | communityFee << 40 | rateBps
<< 24 | feeUnits`); `afterSwap` reads and zeroes it. The slot is keyed by pool because Algebra calls the payer's
`algebraSwapCallback` between the two hooks (pool locked), and that payer may swap on another of our pools: a single
global slot (gen-8's pattern, safe in V4 where no foreign code runs between the hooks) would be overwritten. The same
pool cannot be re-entered while locked. Field widths: `feeUnits < 1e6 < 2^24`, `rateBps <= 9000 < 2^16`,
`communityFee <= 1000` (uint16), `kind, phase < 4`. A hand-over that is set but never consumed (only if an admin turned
off the after-swap hook) lives until the end of the transaction and is overwritten by the next `beforeSwap` of that
pool. solc prints its generic EIP-1153 notice for the `tstore`; the slot is cleared in the same swap.

### registerPool(pool, coin, tickStart, tickGrad, openAt)

- **Guard:** none needed: launcher-only and no external call (`TickMath` is internal).
- **CEI:** checks (caller is the launcher; non-zero `pool` and `coin`; the pool is not registered and has no code yet;
  `MIN_TICK <= tickStart < tickGrad < MAX_TICK` (`BadTicks`; B needs room above tickGrad); `openAt` in
  `[now, now + 30 days]`, gen-8's `BadOpenAt` bound), then the two prices are derived from the ticks, then one storage
  write and the event. No interaction. Tick-spacing alignment is not checked here: the pool's own `mint` refuses ticks
  that are not multiples of its spacing, so a misaligned launch reverts as a whole.
- **States:** once per pool address, before the pool is deployed (O1). An existing pool (ours or foreign) can never be
  registered (`pool.code.length != 0` reverts), so the launcher cannot attach our rules to someone else's pool even by
  mistake. A launch that reverts reverts the registration.
- **Over/underflow:** `block.timestamp + 30 days` cannot overflow; `openAt` is a uint40 argument;
  `getSqrtPriceAtTick` cannot revert because both ticks are inside `[MIN_TICK, MAX_TICK]`.
- **Griefing:** none: only the launcher calls it.

### beforeInitialize(sender, price) (view)

- **Guard:** view; makes two view calls to the calling pool (`token0()`, `token1()`, immutables).
- **CEI:** checks only: registered pool, `sender == launcher` (`OnlyLauncherMayInitialize`), `price == sqrtStart`
  (`BadStartPrice`), `token0 == coin` and `token1 == WDOGE` (`BadPoolTokens`).
- **States:** Algebra calls it on every `initialize` when a plugin is set, and `initialize` succeeds once per pool. A
  front-runner cannot initialize our pool (the launcher creates and initializes it in one transaction anyway, O1), and
  the pool can only start exactly at the registered start price with the orientation every other hook assumes.
- **Over/underflow:** none.
- **Griefing:** none.

### beforeModifyPosition(sender, recipient, bottomTick, topTick, liquidityDelta, .)

- **Guard:** no lock; the only external call is the calling pool's `globalState()` view.
- **CEI:** checks, then at most one storage write (`gradBurnDone = true`), no external call after it.
- **States:**
  - add (`liquidityDelta > 0`): only `sender == launcher` and `recipient == launcher`; everyone else, including every
    NonfungiblePositionManager mint (sender = the NPM), reverts `LiquidityIsLocked` (proof check 4). The launcher's
    range must start at or above tickStart and must not straddle tickGrad (`bottomTick < tickGrad < topTick` refused,
    `BadPositionRange`): A = [tickStart, tickGrad] and B = [tickGrad, tickMax] pass, so no liquidity can ever sit below
    the F2 floor and no launcher position other than B can hold coins at or past the graduation price. The launcher
    adds only inside `launch` (O3). Ticks are compared instead of their sqrt prices; `getSqrtPriceAtTick` is strictly
    increasing, so the two comparisons are identical.
  - burn by the launcher (`liquidityDelta < 0`): the range must lie inside [tickStart, tickGrad] (`BadPositionRange`;
    among our positions only A's range qualifies), only after the latch, with the pool price at or past `sqrtGrad` (a
    range whose top is at most tickGrad is all WDOGE there, so the burn can only return WDOGE, and only from A), and
    only once (`GraduationBurnRefused` otherwise). This is defense in depth for I6 ("A and B lose liquidity exactly once, never while the price is inside
    A"); the amount (`floor(liqA x 2%)`) and the once-rule remain the launcher's own duty (t32), because the plugin does
    not see the burn if an admin removed the position-modify flag at that moment.
  - burn by anyone else: passes (no other position exists unless an admin cleared our config; such LPs can always exit).
  - zero-amount burns (the launcher's fee pokes for collect): always pass.
  - pluginFee returned is always 0: we never tax a burn.
- **Over/underflow:** none.
- **Griefing:** none on others; the launcher's own graduation burn can be refused only if the latch is not set, the
  price is inside A or the range is not A's, which is exactly when it must not run.

### beforeSwap(sender, ., zeroToOne, ., ., ., .)

- **Guard:** no lock (it must work for nested swaps on other pools from a swap callback, see "Transient hand-over").
  External calls: `pool.globalState()` (view on the caller) and, only when `sender == launcher`,
  `launcher.conversionInProgress(pool)` (view, cannot change state).
- **CEI:** checks (registered pool; `TradingNotOpen` for every sender but the launcher before `openAt`; for a
  conversion: a sell (`ConversionMustSell`), not before `openAt + 60 s` (`ConversionInLaunchWindow`, spec Money flow 4:
  no conversion inside the launch window) and `lastFee == 0` (`ConversionFeeNotZero`)), then the transient hand-over
  write, then the return value. No storage write.
- **States:**
  - before `openAt`: only the launcher's swap (O2: the creator first buy inside `launch`) passes, at the bonding rate
    (gen-8 B, I16).
  - phase by the price at swap start (gen-8 F1, A12): the crossing swap starts inside A and is a bonding swap with the
    bonding rate; a swap that starts at or past `sqrtGrad` is post-graduation (100 bps), also before the latch is set
    and also after the price fell back and rose again.
  - conversion (launcher swap with the flag set): returns overrideFee 0, i.e. "use lastFee", which is 0 (O4), so a
    true 0 fee and no community cut; refused if lastFee is not 0 (only possible after an admin `setFee` with the
    dynamic flag off; the keeper's `restore` fixes it). Never a buy, never inside the 60 s launch window (enforced
    here as well as in the launcher).
  - every other swap: overrideFee = `algebraFee(rate, buy)` > 0 (the smallest rate is 100 bps), pluginFee 0.
  - dynamic-fee flag off (admin): a non-zero overrideFee would revert the swap (`dynamicFeeDisabled`), so the plugin
    returns 0 and records `lastFee` as the fee: trading keeps working at lastFee (0 after launch / restore), as the
    spec's accepted risk states, and the books record what was really charged.
  - unknown pool (an admin attached our plugin to a foreign pool): reverts `UnknownPool`; no effect on our pools.
- **Over/underflow:** `rate <= 9000` (MwzFeeMath, constants); `algebraFee` <= 900,000, cast through `SafeCast.toUint24`
  (cannot revert); `openAt + 60` (in MwzFeeMath and in the conversion window check) cannot overflow.
- **Griefing:** a swap costs its sender the gas and the fee; nothing a swapper does changes another pool or another
  swap's rate. The fee schedule depends on `block.timestamp` exactly as gen-7 and gen-8 (gen-8 A7, accepted).

### afterSwap(sender, ., zeroToOne, ., ., amount0, amount1, .)

- **Guard:** no lock (same reason as `beforeSwap`). Algebra runs `_unlock()` before `afterSwap` (facts section 3,
  "Swapping from afterSwap"), so the pool is unlocked here; that is what lets the launcher burn inline.
- **CEI:** checks: registered pool; F2 (`PriceBelowStart`: a sell may not leave the price below `sqrtStart`, where no
  liquidity exists; gen-8 F2 mirrored for the inverted price orientation); the hand-over (or its fallback, below).
  Effects: the fee books (`_book`), then the latch (`graduated = true`, `graduatedAt = now`, both once). Then the
  `BarkSwap` event and, for the latching swap, `Graduated`. Interaction last: the inline graduation fee
  (`launcher.takeGraduationFee(pool)` through a low-level call that forwards 63/64 of the remaining gas, copies no
  return data and ignores a revert; `GraduationFeeInline(pool, ok)`). When the launcher runs, every plugin write of this swap is done;
  its burn re-enters only `beforeModifyPosition` (which sees the latch set and the price at or past `sqrtGrad`).
- **States:**
  - every swap on a registered pool with the after-swap hook on, any phase, any sender; conversions book 0 fee and still
    emit their event (kind 1) and are subject to F2 (the launcher sets the price limit at the start price, spec Money
    flow 4).
  - the latch: the first swap that leaves the price at or past `sqrtGrad` (I7); never reset; `graduatedAt` is its block
    time (I17, read by the reserve lock through the launcher, t5). A buy can latch in any later swap too if the
    crossing happened while an admin had our hook off: the first swap after `restore` that ends at or past `sqrtGrad`
    latches.
  - fallback without a hand-over (only if an admin turned the before-swap hook off and kept the after-swap hook):
    `openAt` and the conversion rules (launch window, `lastFee == 0`) are re-checked here, the swap was charged `lastFee`, it is booked at that fee in the
    phase given by the latch (the start price is unknown here) with `rateBps = 0` in the event.
  - unknown pool: reverts.
- **Over/underflow:** `amountIn x feeUnits` with `feeUnits < 2^24` and `amountIn` bounded by the pool's uint128 reserves:
  no overflow; `gross <= amountIn` because `feeUnits < 1e6`, so `curveAmount = amountIn - gross` cannot underflow;
  `cut <= gross` because `cf` is clamped to 1000; `creator <= net` by the min, so `net - creator` cannot underflow;
  book additions are checked uint128 (`SafeCast.toUint128`): 2^128 is about 3.4e38, i.e. 3.4e11 times the coin supply
  (1e27) and over 1e9 times the whole DOGE supply (about 1.5e29 wei); with fees of at most 2% of volume outside the 60 s
  window, no cumulative book can get there (a revert would only revert that swap). `uint40(block.timestamp)`
  is exact until year 36,812. `-amount` of an int256 cannot hit `type(int256).min` (pool amounts fit uint128).
- **Griefing:**
  - The inline graduation fee can fail. A revert in the launcher (for example a latching swap sent by the launcher
    while its own lock is held) cannot revert the trade: the trade completes and the fee is left to the launcher's
    guarded permissionless fallback, which takes it while the price is at or past `sqrtGrad` (spec: "if the price has
    fallen back, it waits"). An out-of-gas is different: the plugin keeps only 1/64 of the gas for the rest of
    `afterSwap` and the pool, so a gas limit that starves the launcher either still finishes the swap (fee deferred to
    the fallback, as above) or reverts the whole swap (nothing committed). Either way no loss, only deferral or a failed
    transaction for the sender who chose that gas limit; `GraduationFeeInline(pool, false)` tells the keeper.
  - A 1-wei swap books `gross = 0` while the pool may take 1 wei: within the tolerance, in our favour.
  - An event per swap costs gas to the swapper only.

### handlePluginFee(fee0, fee1)

- **Guard:** none needed: no state, no external call.
- **CEI:** event only (for our pools), returns the selector.
- **States:** never reached in normal operation: the plugin always returns pluginFee 0, so our pools accrue no plugin
  fee. Reachable only if a Barkswap admin installed another plugin that charged a plugin fee and ours was restored
  before the pool's 8-hour push (pending plugin fees go to whatever address is in the `plugin` slot at push time,
  facts section 3). Those tokens then sit in this contract with no way out.
- **Over/underflow:** none.
- **Griefing:** it must never revert: a revert here would revert every fee-bearing swap, burn and flash of that pool
  after 8 hours, i.e. freeze trading and the graduation burn. It returns the selector unconditionally. Anyone can call
  it from any contract; for non-pool callers it does nothing.

### getCurrentFee() (view)

- **Guard:** view; one view call to the calling pool (`globalState()`).
- **CEI:** reads only.
- **States:** Algebra's `pool.fee()` calls it on the plugin when the dynamic-fee flag is set (msg.sender = the pool);
  Barkswap's UI, subgraph and periphery read `fee()`, which would revert on our pools without it. It returns the fee a
  non-launcher SELL would pay now in 1e6 units: phase by the current price, the launch decay from `openAt` included
  (before `openAt` the start rate), capped at `type(uint16).max` (6.5535%) because the Algebra interface is uint16, so
  it reports the cap during most of the 60 s launch window. A buy pays r/(1+r) of its input, slightly less than the
  value shown. For a caller that is not one of our pools it returns 0 (no revert). Nothing on chain that matters reads
  it: `beforeSwap` computes the real fee itself and returns it as overrideFee. The plugin does not inherit Algebra's
  `IAlgebraDynamicFeePlugin` (not vendored); the function has that interface's exact signature and selector.
- **Over/underflow:** rate <= 9000 bps, units <= 900,000, clamped before the uint16 cast.
- **Griefing:** none (view).

### Views and the other callbacks

`feeTotals`, `feeConfig`, `algebraFee`, `defaultPluginConfig` (135), `getCurrentFee`, the `pools` getter: views or pure. `afterInitialize`,
`afterModifyPosition`, `beforeFlash`, `afterFlash` are not in `PLUGIN_CONFIG`; they are pure and return their selector,
so an admin who sets those flags cannot brick initialize, burns or flash loans through us (gen-8's hook reverted unused
callbacks because V4 permissions are fixed in the hook address; here they are admin-settable flags). Flash loans stay
possible: they do not move the price, and their 0.01% fee goes to our positions (unbooked, open question 4).

### Invariants this contract upholds (spec "Invariants")

| Spec invariant | How the plugin upholds it | Fork test |
|---|---|---|
| Only the launcher initializes and adds liquidity | `beforeInitialize`, `beforeModifyPosition` (with config 135) | t8 |
| A and B lose liquidity exactly once, never inside A (I6) | launcher duty (t32); the plugin refuses a launcher burn before the latch, inside A, outside A's range, or a second time | t8 |
| Rate per swap matches phase (start price) and decay from `openAt` | `beforeSwap` with gen-8 `MwzFeeMath` (F1, I3, I14) | t8 |
| No swap before `openAt` except the creator first buy | `beforeSwap` (and the fallback in `afterSwap`), O2 | t8 |
| No sell below the start price | `afterSwap` F2 (I15) | t8 |
| Graduation latches once; `graduatedAt` set once | `afterSwap` latch (I7, I17) | t8 |
| 2% graduation fee at most once, never while inside A | inline call only from the latching swap at price >= `sqrtGrad`; burn guard; launcher once-flag | t8 |
| Creator amount exactly 560 bps of the gross bonding fee and 50% of the gross post fee, whatever the cut (B10) | `_book`, community fee read at swap time; exact up to a cut of 94.4% / 50% | t9 |
| Plugin per-phase totals equal what collect can take, within a stated tolerance | `_book` from the pool's own amounts; tolerance above | t9 |
| A conversion pays 0 fee; every other swap the phase rate | `beforeSwap` (`ConversionFeeNotZero`, `ConversionMustSell`) | t8 |
| No conversion inside the 60 s launch window | `beforeSwap` (`ConversionInLaunchWindow`), also the launcher | t8 |
| Start / graduation prices sit exactly on A's ticks; no launcher liquidity below the start or straddling the graduation price; the graduation burn takes from A only | `registerPool` derives the prices from the ticks; `beforeModifyPosition` range checks | t8 |
| Stored rates never change (I12) | constants, no setter | t8 |
| One swap event per swap with every spec field incl. kind | `BarkSwap` | t8 |
| The plugin holds no funds of ours | pluginFee always 0; no transfer path | t8 |

`BarkSwap` carries every "Per-swap event fields" item of the spec: pool and coin (indexed), swap sender (indexed; the
router for router trades), side (`buy`), trader-side native and coin amounts, `curveAmount`, gross fee, net fee and
`feeToken`, community fee at swap time, rate (`rateBps` and the charged `feeUnits`), phase plus `crossing`, creator
amount (router remainder = net - creator), price after the swap, and `kind`. Gen-8's `referrer` (first word of
`hookData`) is dropped: Algebra passes the router's callback data, not a trader field.

**How the swap kind is learnt.** By the address that called `pool.swap` (`sender`): the launcher with its conversion
flag set is a conversion; `creatorEscrow` is an escrow buy; `choiceVault` is a buyback; everything else is a trade
(including the launcher's creator first buy). Both periphery addresses are immutable constructor arguments (no setter,
no admin power). This requires MwzBarkCreatorEscrow and MwzBarkCreatorChoiceVault (t6) to call `pool.swap` directly
with their own callback; a swap they routed through Barkswap's SwapRouter would be labelled a trade (open question 6).

### Barkswap admin powers relevant to the plugin (facts section 5)

| Admin action on our pool | Effect with this plugin | Detection / remedy |
|---|---|---|
| `setPlugin(other)` | our hooks stop: no fee rule, no LP block, no F2, no latch, no events, no books; swaps pay whatever the other plugin and lastFee say, and any LP fee they pay accrues to our positions unbooked; the other plugin can tax burns (up to 99.9999%), so the graduation burn must not run while it is installed (open question 2). Our plugin's state (latch, books) is kept and resumes after `restore`. | admin-change watch; `restore` |
| `setPluginConfig` without `DYNAMIC_FEE` | the plugin returns overrideFee 0 and books lastFee (0): trades work, we earn nothing. | watch; `restore` |
| `setPluginConfig` without `BEFORE_SWAP` (after-swap kept) | fallback booking at lastFee, phase by the latch, `rateBps` 0. | watch; `restore` |
| `setPluginConfig` without `AFTER_SWAP` | fees still charged (unbooked), no F2, no latch, no events. A sell can then push the price below the start for free (gen-8 A-3) until restored; the next swap with our hooks back re-applies F2 to sells. | watch; `restore` |
| `setPluginConfig` without `BEFORE_POSITION_MODIFY` | outsiders can add liquidity and share LP fees (spec accepted risk); the plugin's graduation-burn check is skipped (the launcher's once-flag still binds). | watch; `restore` |
| `setCommunityFee(up to 1000)` | read at every swap; the creator is paid first on the gross fee, the router gets the rest, never negative; above 94.4% / 50% the creator gets the whole net fee. Graduation fee (a burn) is not cut. | watch |
| `setFee(x)` (only with the dynamic flag off) | if lastFee is not 0, conversions are refused (`ConversionFeeNotZero`); other swaps with our config are unaffected (overrideFee is never 0 for them). | watch; `restore` (setFee(0) with the flag off, then 135) |
| `setTickSpacing`, `setCommunityVault` | no effect on the plugin (our positions are minted at launch). | watch |
| Pending plugin fees pushed to us after a plugin swap | accepted by `handlePluginFee`, stuck in the plugin (open question 3). | event |

No admin action can make the plugin move or hold our money, change our rates, register a pool, or reset a latch.

### Gen-8 audit points (for the t7 mapping)

A1 (simulation drift) does not apply: no simulation, Algebra charges per step. A10 becomes the r/(1+r) fee-unit
rounding above. A11 becomes O2 plus `conversionInProgress`. A12 holds (phase by start price). A14: hooks hold no lock;
transient state is per pool; the only non-view external call is the last action. F1, F2 and B are implemented as
described under `beforeSwap` / `afterSwap`. A2, A3 (display pair) do not apply: there is no display pair on DogeOS.

### Open questions

1. **Upstream behaviour (verified in the v1.2.1-integral source by the t3 reviewer, 2026-10-15; t8 confirms each on
   the fork).** `AlgebraPool.swap` runs `_beforeSwap` -> `_lock` -> the swap calculation, transfers and the payer
   callback -> `_unlock` -> `_afterSwap`, so `beforeSwap` reads the start price and the community fee the calculation
   uses, and the pool is unlocked in `afterSwap`. `swapWithPaymentInAdvance` takes the payment (callback) first and then
   follows the same `_beforeSwap` -> calculation -> `_unlock` -> `_afterSwap` order, so the same holds. `mint` passes
   `(msg.sender, recipient)` to `beforeModifyPosition`, `burn` passes `(msg.sender, msg.sender)`. `_calculateSwap`
   writes only price and tick into `globalState`, so an overrideFee is never stored in `lastFee` (a conversion after
   any number of swaps is still fee-free). Hooks are skipped only when `msg.sender == plugin`; the launcher is not the
   plugin, so its swaps, mints and burns all pass through our hooks.
2. **Launcher fallback vs a swapped-in plugin (t32).** The graduation-fee fallback should refuse unless
   `pool.plugin() == plugin` and the config holds `BEFORE_POSITION_MODIFY`: a foreign plugin can tax burns, and with
   our flag off the plugin's burn guard is skipped.
3. **Foreign plugin fees.** Tokens pushed through `handlePluginFee` stay in the plugin forever (no withdraw path; adding
   one would be an admin power). Accept as Informational, or forward them to the launcher's router book (t4 would need
   an entry that keeps books equal to balances)? Decision for t7.
4. **Unbooked LP fees (t4).** Flash-loan fees, direct token transfers to the pool (Algebra credits a balance surplus to
   in-range LPs) and swaps made while our hooks were off all accrue to our positions without a plugin booking. Collect
   must credit any surplus over the plugin's totals somewhere defined (router book of the current phase is the natural
   choice) so the launcher's books still equal its balances.
5. **Rounding tolerance (t9).** The <= 16 wei per swap per book bound above is derived from the per-step rounding, not
   measured; t9 measures it and pins the value it asserts, and t4's apportionment must accept totals a few wei above
   what collect returns.
6. **Swap kinds (t6).** Escrow and choice vault must swap directly on the pool for the kind label; if t6 routes them
   through the SwapRouter, the plugin needs another rule (for example recipient-based) and this section changes.
7. **Licence.** The plugin is MIT (as gen-8) and compiles the vendored GPL-2.0-or-later Algebra interfaces; confirm the
   licence line for the Bark contracts before mainnet.
8. **`setFee(0)` stays mandatory (O4).** Upstream `initialize` calls `_setFee(defaultFee)` unconditionally, so every
   pool starts with the factory default `lastFee` (500) whatever the plugin config; only `EP.setFee(pool, 0)` while the
   dynamic-fee flag is off brings it to 0. (The first version of this section suggested the opposite; that was wrong.)

Verdict: pending (t7)

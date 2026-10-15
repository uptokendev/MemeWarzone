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
| MwzBarkLauncher (+ its linked libraries `MwzBarkLaunchLib`, `MwzBarkFeeBooks`) | `contracts/dogeos/barkswap/MwzBarkLauncher.sol`, `contracts/dogeos/barkswap/libraries/MwzBarkLaunchLib.sol`, `contracts/dogeos/barkswap/libraries/MwzBarkFeeBooks.sol` | full audit (new code) | t32 (launch, restore), t4 (money side, library split) |
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
internal library, no external call). Sizes: `node scripts/dogeos-bark-sizes.mjs` (EIP-170 for every contract and
linked library, exits non-zero above 24,576 bytes).

| Contract | Runtime bytes (2026-10-15) |
|---|---|
| MwzBarkPlugin | 9,569 (fix round 1; 7,978 at first write) |
| MwzBarkLauncher | 22,307 (t4, with the money side; 2,269 headroom; 21,588 at t32 before the split, see "Size and the library split") |
| MwzBarkLaunchLib (linked library) | 10,255 (t4) |
| MwzBarkFeeBooks (linked library) | 1,133 (t4) |
| MwzBarkFeeSplitter | 3,486 (t5) |
| MwzBarkReserveLock | 2,607 (t5) |
| MwzBarkLaunchLens | 7,304 (t5; no linked library) |

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
   choice) so the launcher's books still equal its balances. **Resolved in t4** (MwzBarkLauncher, "Fee books",
   "Unbooked surplus"): router post, not the current phase's router book, so no splitter band grows without a trade row.
5. **Rounding tolerance (t9).** The <= 16 wei per swap per book bound above is derived from the per-step rounding, not
   measured; t9 measures it and pins the value it asserts, and t4's apportionment must accept totals a few wei above
   what collect returns. **t4:** the launcher books what collect returns and lets the plugin's totals only steer the
   split, so either sign is absorbed by the router books (MwzBarkLauncher, "Fee books", "Tolerance").
6. **Swap kinds (t6).** Escrow and choice vault must swap directly on the pool for the kind label; if t6 routes them
   through the SwapRouter, the plugin needs another rule (for example recipient-based) and this section changes.
7. **Licence.** The plugin is MIT (as gen-8) and compiles the vendored GPL-2.0-or-later Algebra interfaces; confirm the
   licence line for the Bark contracts before mainnet.
8. **`setFee(0)` stays mandatory (O4).** Upstream `initialize` calls `_setFee(defaultFee)` unconditionally, so every
   pool starts with the factory default `lastFee` (500) whatever the plugin config; only `EP.setFee(pool, 0)` while the
   dynamic-fee flag is off brings it to 0. (The first version of this section suggested the opposite; that was wrong.)

Verdict: pending (t7)

---

## MwzBarkLauncher

**Files:** `contracts/dogeos/barkswap/MwzBarkLauncher.sol` (t32: launch path, plugin-factory hooks, pool callbacks,
graduation fee, restore; t4: the money side, the library split and the t32 review minors), and its two linked libraries
`contracts/dogeos/barkswap/libraries/MwzBarkLaunchLib.sol` (coin deployment, curve planning, the pool calls of
`restore`, the graduation burn and `collect`) and `contracts/dogeos/barkswap/libraries/MwzBarkFeeBooks.sol` (pure book
arithmetic). **Imports:** the vendored Algebra 1.2.1 interfaces (`IAlgebraPool`, `IAlgebraFactory`,
`IAlgebraPluginFactory`, `IAlgebraMintCallback`, `IAlgebraSwapCallback`, `IAlgebraCustomPoolEntryPoint`,
`IWNativeToken`); `IMwzBarkLauncher` and `MwzBarkPlugin` (type only, no bytecode); gen-8 `MwzV4Token` (deployed by
CREATE2 from the library, same bytecode as gen-8) and `MwzFeeMath` (only its `SNIPER_WINDOW` constant); v4-core 1.0.2
`TickMath`, `FullMath`; v4-periphery 1.0.3 `LiquidityAmounts` (library); OZ 5.4.0 `Math` (library), `SafeCast`, `ECDSA`,
`MessageHashUtils`, `SafeERC20`, `ReentrancyGuardTransient`. Small interfaces declared for the contracts it calls:
`IMwzBarkOracle` (the foundation's GraduationOracle, reused unchanged; now declared in the library file),
`IMwzBarkReserveLockForLauncher` (t5) and `IMwzBarkChoiceVaultForLauncher` (t6). Their names differ from gen-8's so the
Bark build has no duplicate artifact names.

**Diff base:** gen-8 `contracts/gen8/MwzV4Launcher.sol` (vendored at `e129712b9`) for the signed create, the oracle
band and curve sizing; gen-8 `MwzLaunchHook` for the graduation fee (`_graduate`) and the whole money side
(`creatorOwed`, `claimCreator`, two-step creator transfer, `routerOwed` / `pendingBondingFees` / `pendingGradFees`,
`claimRouter` with F4, `routerPaid`, `routerParked` / `payParkedRouter` / `executeTreasuryRouter` with F3, the 48 h
router timelock); the research proof `scripts/research/barkswap-plugin/contracts/MwzBarkLauncher.sol` for the Barkswap
call sequence (one-tx launch through the entry point, CREATE2 coin, direct `pool.mint` with callback). Every production
difference is listed below. New code with no gen-8 counterpart: `collect` and `convert` (gen-8 took its fees in native
inside the swap; here they accrue to positions in both tokens, spec B4/B5).

### Role

The Barkswap custom-pool deployer and plugin factory of every MemeWarzone coin on DogeOS, and the holder of every
coin's fees (spec section 3, launcher row; Money flow 1-5). It covers the one-transaction launch, the plugin-factory
hooks the entry point forwards, the mint and swap callbacks, the one-time graduation fee (inline from the plugin, or the
guarded permissionless fallback), the permissionless `restore`, and the money side: permissionless `collect(coin)` and
`convert(coin)`, the per-coin creator balance with `claimCreator` and the two-step creator transfer, and the router
bucket with `claimRouter`, `routerPaid` and the parked router (gen-8 F3/F4). It owns positions A and B of every coin.
After launch it makes exactly these calls into a pool or the entry point: `restore` (our plugin, lastFee 0, config 135,
nothing else), the one graduation burn plus the collect of exactly its principal, `collect`'s two zero-amount burns and
two fee collects, and `convert`'s one sell. There is no withdraw and no admin path to a pool or to any balance. Nothing
removes liquidity except the graduation burn (I6).

### Trust model and wiring

| Actor | Power over the launcher |
|---|---|
| `owner` (DogeOS deployer key, testnet, B9) | `setCreatePaused`, `setCreateSigner`, two-step ownership (launches only, gen-8 L5); redirect the router bucket behind a 48 h timelock (`proposeTreasuryRouter` / `cancelTreasuryRouter` / `executeTreasuryRouter`, the bucket accrued before is parked for the old router, F3); `claimRouter` (pays the current router only, F4). No power over pools, positions, fees, books, creator balances, creators, the graduation fee, restore, collect or convert. |
| `createSigner` (DogeOS route-authority key, B9) | signs launch requests (D3) and picks the CREATE2 salt so the coin sorts below WDOGE. Cannot launch by itself (the creator sends the transaction) and cannot touch a launched coin. |
| creator (msg.sender of `launch`) | launches with a valid signature for itself only; receives the first buy. Its fee recipient (`feeCreator`) is itself (keep) or the choice vault (holders / split / buyback). |
| `feeCreator` of a coin | `claimCreator(coin, to)` (the coin's whole native creator balance, to any address), `proposeCreator(coin, next)`; the proposed address `acceptCreator(coin)`. Nothing else. |
| `treasuryRouter` (MwzBarkFeeSplitter, t5) and its `operator()` (DogeOS operator key, B9) | `claimRouter` (F4: router, its operator, or the owner); the payout goes to the router only. |
| `plugin` (immutable, MwzBarkPlugin) | calls `takeGraduationFee` inline and `conversionInProgress`; its `pools(pool)` is the source of the latch, `sqrtStart` and `sqrtGrad`; its `feeTotals(pool)` steers how `collect` splits what it receives. |
| `entryPoint` (immutable, Barkswap's AlgebraCustomPoolEntryPoint) | the only caller of `beforeCreatePoolHook` / `afterCreatePoolHook`; the launcher's only path to `setTickSpacing`, `setFee`, `setPluginConfig`, `setPlugin`. |
| our pools | the only callers of the mint / swap callbacks, and only while this launcher is minting into / swapping on that very pool (transient `T_ACTIVE_POOL`). |
| `oracle`, `reserveLock`, `choiceVault`, `wNative` (immutable) | read at launch (oracle), called at launch (lock, register), WDOGE wrap/unwrap. |
| linked libraries `MwzBarkLaunchLib`, `MwzBarkFeeBooks` | code only, run by DELEGATECALL in the launcher's context (see "Size and the library split"); fixed at deploy by linking. |
| keeper / anyone | `restore(coin)`, the graduation-fee fallback, `collect(coin)`, `convert(coin)`, `payParkedRouter(router)`, views. |
| Barkswap admin | can change our pools' plugin, config, community fee, (flag off) static fee and tick spacing; cannot call the launcher with any effect beyond what anyone can. See "Barkswap admin powers". |

**Deploy wiring.** Plugin, reserve lock, choice vault and fee splitter are deployed first against the launcher's
predicted address (option (b) of the plugin section), and both libraries are deployed and linked. The constructor
reverts `ZeroAddress` for a zero entry point, WDOGE, plugin, oracle, reserve lock, choice vault, owner or
`treasuryRouter_` (t4, the 9th argument), and `WiringMismatch` unless `plugin.launcher()`, `reserveLock.launcher()` and
`choiceVault.launcher()` are this contract, `plugin.wNative()` is the given WDOGE, `plugin.choiceVault()` is the given
choice vault and `plugin.PLUGIN_CONFIG()` equals the launcher's own constant 135. The router is not cross-checked (gen-8
did not either); a wrong router can only be paid what `claimRouter` pays it, and the owner can redirect behind the 48 h
timelock with the bucket parked for the wrong one. The Algebra factory is read from `entryPoint.factory()` (non-zero).
Oracle checks (`OracleUnsuitable`): band `0 < minNativeUsd < maxNativeUsd` (DogeOS inputs: $0.01 = 1e16 and $10 = 10e18
USD per DOGE, F6), the age input `0 < maxOracleAge <= MAX_ORACLE_AGE_INPUT` (2 days; renamed from `MAX_ORACLE_AGE` in
t4 so it reads as the bound on the input, not the oracle's age; DogeOS input 3600 s), and the oracle's own immutable
`maxPriceAge` in `(0, maxOracleAge]`. The GraduationOracle reverts on a reading older than its `maxPriceAge`, so every
launch uses a price at most `maxOracleAge` old. `plugin.creatorEscrow()` is a label only; the deploy script (t15)
checks it. `createPaused` starts true.

### State

| Variable | Kind | Written by | Notes |
|---|---|---|---|
| `owner`, `pendingOwner`, `createSigner`, `createPaused` | storage | owner functions | launches only |
| `usedAuthorizations[digest]` | storage | `launch` (`_consumeAuthorization`) | replay map, never cleared |
| `launches[coin]` slot 0: `pool`, `openAt`, `tickStart`, `tickGrad`, `gradFeeTaken` | storage | `launch` (all, once); `takeGraduationFee` (`gradFeeTaken`, once) | `pool != 0` is the "ours" test |
| `launches[coin]` slot 1: `feeCreator`, `lastConvertAt` | storage | `launch`; `acceptCreator` (`feeCreator`); `convert` (`lastConvertAt`) | `feeCreator` = creator (keep) or the choice vault, gen-8's "hook creator"; never 0 for a launched coin |
| `launches[coin]` slot 2: `liqA`, `liqB` | storage | `launch` only | |
| `launches[coin].graduationFee` | storage | `takeGraduationFee` | record of the native taken by the burn (also credited to the graduation book) |
| `coinOf[pool]` | storage | `launch` only | pool -> coin |
| `creatorOwed[coin]` | storage | `collect`, `convert` (+), `claimCreator` (zeroed) | native |
| `pendingCreator[coin]` | storage | `proposeCreator`, `acceptCreator` | |
| `coinFees[coin]` (`creatorBonding`, `routerBonding`, `creatorPost`, `routerPost`, uint128 each) | storage | `collect` (+), `convert` (-) | pending coin fees, in coins |
| `_collectedTotals[coin]` (view `collectedTotals`) | storage | `collect` only | the plugin's `feeTotals(pool)` at the coin's last collect |
| `routerOwed`, `pendingBondingFees` (uint128 pair), `pendingGradFees` | storage | `collect`, `convert`, `takeGraduationFee` (+); `claimRouter`, `executeTreasuryRouter` (zeroed) | the router bucket and the B11 net bonding / graduation DOGE inside it |
| `routerPaid[router]`, `routerParked[router]`, `parkedOwed` | storage | `claimRouter` / `payParkedRouter` (paid); `executeTreasuryRouter` (parked) / `payParkedRouter` (unparked) | gen-8 F3 |
| `treasuryRouter`, `pendingRouter`, `routerEta` | storage | constructor; owner router functions | 48 h timelock |
| `T_ACTIVE_POOL` | transient | `_createPool` (set), `_seed` (cleared), `_firstBuy` and `convert` (set, cleared around the swap) | gates the plugin-factory hook and both callbacks |
| `T_CONVERSION` per pool | transient | `convert` only (set immediately before its `pool.swap`, cleared immediately after) | read by `conversionInProgress` |
| reentrancy lock | transient (OZ `ReentrancyGuardTransient`) | every state-changing external function except the owner / creator-transfer setters (no external call) and the callbacks (gated by `T_ACTIVE_POOL` inside a locked caller) | shared by all of them, and by the library code they DELEGATECALL |

Constants: supply split 850M / 130M / 20M and first buy <= 700M (spec section 2); gen-7 C8 constants (library); targets
$30K and $50K everywhere, $150 on 6281971 and 31337 only (B2, test-target chain list); `TICK_SPACING` 10, `TICK_MAX`
887,270 (`maxUsableTick(10)`, a multiple of 10), `PLUGIN_CONFIG` 135, `GRAD_FEE_BPS` 200, `MAX_AUTH_TTL` 1 day,
`MAX_OPEN_DELAY` 30 days, `MAX_ORACLE_AGE_INPUT` 2 days; money side: `CONVERT_IMPACT_BPS` 100 (with the sqrt factor
`CONVERT_SQRT_FACTOR_E9` = 994,987,438), `CONVERT_INTERVAL` 10 minutes, `ROUTER_TIMELOCK` 48 h, `OPERATOR_READ_GAS`
30,000 (gen-8 F4).

### Curve sizing in the Barkswap orientation

Gen-8's `curveForMarketCap` (gen-7 integer math and C8 bounds) and `nearestGridTick` are copied unchanged (now in
`MwzBarkLaunchLib`, public pure, callable on the library address). The price orientation is inverted. In V4 native is
currency0 (coin per native, buys move the price down); here the coin is token0 and the pool price is WDOGE per coin
(buys move it up). With gen-7's price at sold `s` = `vN x vT / (vT - s)^2`: `sqrtStart = sqrt(vN x 2^192 / vT)` and
`sqrtGrad = sqrt(vN x vT x 2^192 / (vT - 850M)^2)` (`curveSqrtPrices`). This is the formula of the proof's off-chain
`plan()`, which measured the spacing-10 grid within 1,000 ppm of gen-7 on start market cap, graduation market cap and
A's raise. Each is rounded to the nearest spacing-10 tick. **tickStart < tickGrad** does not depend on that rounding:
`sqrtGrad / sqrtStart = vT / (vT - 850M)`, about 1,007.2M / 157.2M = 6.41 for every target (a constant of the supply
split, since `vT` does not depend on the market cap), i.e. a price ratio of about 41 and about 37,150 ticks between the
two prices, far more than the 10 ticks the two roundings can move them (reworded at t4, controller minor; the check
`tickStart < tickGrad` stays as a guard). Ranges: `vN <= 1e30` (C8) and `vT ~ 1.007e27`, so `vN x vT < 2^256`,
`mulDiv(vN, 2^192, vT) <= ~6e60`, and both square roots are below 2^160 (checked cast) and inside TickMath's domain
(`vN >= 1` gives `sqrtStart >= ~2.5e15 > MIN_SQRT_PRICE`). `getTickAtSqrtPrice` therefore cannot revert for any
C8-valid curve; tickStart >= -622,000 and tickGrad <= 107,000, well inside `[minUsableTick, TICK_MAX)`.

Liquidity follows gen-8's `createPool` with token0 instead of token1: `liqA = getLiquidityForAmount0(sqrtStart, sqrtGrad,
850M)`, `liqB = getLiquidityForAmount0(sqrtGrad, sqrt(TICK_MAX), 130M)`, both rounded down, so the mint never asks for
more than the planned coins. The rounding remainder is burned to `0x...dEaD` (gen-8 and the proof). Both are about 1e23
at the testnet target, far below Algebra's per-tick liquidity cap.

### constructor

- **Guard:** n/a. **CEI:** checks (zero addresses incl. the router, factory, wiring, oracle suitability; all view calls),
  then immutables and storage, then events (`OwnershipTransferred`, `CreateSignerUpdated`, `RouterChanged(0, router)`,
  `CreatePauseUpdated`). **States:** once. **Over/underflow:** none. **Griefing:** none (wrong wiring reverts the
  deployment).

### setCreatePaused / setCreateSigner / transferOwnership / acceptOwnership

- Gen-8 L5 unchanged. **Guard:** none needed (no external call). **CEI:** check owner, write, event. **States:** any
  time; opening launches requires a non-zero signer, and a zero signer is a second pause. **Over/underflow:** none.
  **Griefing:** only the owner, who can stop new launches and nothing else (trading, restore, the graduation fee,
  collect, convert and every claim ignore the pause).

### plan / isGraduationTargetAllowed / hashRequest / authorizationDigest (views); curveForMarketCap / curveSqrtPrices / nearestGridTick (library, pure)

- **Guard:** views. `plan(targetUsd)` returns `MwzBarkLaunchLib.planLaunch(oracle, minNativeUsd, maxNativeUsd,
  targetUsd)`, the exact plan `launch` uses (t4: it now returns the whole `LaunchPlan`, liquidity included, and reverts
  with the launch's own tick and liquidity errors). `planLaunch` makes two view calls to the oracle inside try/catch and
  maps any failure to `OraclePriceUnavailable`; the band check gives `OraclePriceOutOfBand` (F6). **Over/underflow:** see
  "Curve sizing". `vT - 850M` cannot underflow for the curve `curveForMarketCap` returns (`vT = curve x rd / (rd - rn) >
  curve`); for arbitrary inputs the public pure function reverts. **Griefing:** none.
- `hashRequest` and `authorizationDigest` are gen-8's, with the same `LaunchRequest` fields and order and the same
  `CREATE_AUTH_TYPE` string, so the API's gen-8 signer code is reused (t21). The digest binds `block.chainid` and this
  launcher's address, so a gen-8 authorization cannot be replayed here or the reverse.
- `collectedTotals(coin)` returns the plugin totals at the coin's last collect; `plugin.feeTotals(pool)` minus it is what
  the next collect will book (within the tolerance in "Fee books").

### launch(req, auth) (payable)

- **Guard:** `nonReentrant` (OZ transient). Every external call goes to our own contracts (plugin, reserve lock, choice
  vault, the brand-new coin), our linked library (DELEGATECALL), Barkswap's entry point / factory / the pool being
  created, the oracle (view) or WDOGE.
- **CEI, in order:**
  1. Checks: not paused; name, symbol, logo non-empty; target on the allow-list; fee choice 1..4 with `feeCreatorPct`
     1..99 iff split, else 0; `msg.value == firstBuyValue`; `openAt` = now if 0 or past, refused above now + 30 days
     (`OpenAtTooFar`); the signature (`_consumeAuthorization`: signer set, deadline in [now, now + 1 day], ECDSA recover
     rejects malleable and invalid signatures, digest not used), then its effect `usedAuthorizations[digest] = true`.
  2. Plan (`MwzBarkLaunchLib.planLaunch`, a view DELEGATECALL: oracle views, see above) and its checks: `BadTicks` unless
     tickStart and tickGrad are multiples of 10, tickStart >= minUsableTick(10) and tickStart < tickGrad < TICK_MAX
     (t4 dropped the dead `TICK_MAX % TICK_SPACING` term: TICK_MAX is the constant 887,270); `BadLiquidity` unless
     `liqA >= 10,000` (so the 2% burn is non-zero) and `liqB > 0`. Alignment is checked so a bad plan reverts with our
     reason instead of the pool's `tickIsNotSpaced`.
  3. Coin: `MwzBarkLaunchLib.deployCoin(name, symbol, creator, req.salt)`, a DELEGATECALL running `new
     MwzV4Token{salt: keccak256(abi.encode(creator, req.salt))}(name, symbol, 1B, address(this))` in the launcher's
     context, so the CREATE2 deployer and the initial holder are the launcher: same coin address and bytecode as t32's
     direct `new`. Refused unless `coin < WDOGE` (`CoinNotBelowWNative`; the coin must be token0, O1). The salt includes
     the creator, so two creators never collide; a repeated (creator, salt, name, symbol) collides in CREATE2 and
     reverts. Pool address: `factory.computeCustomPoolAddress(this, coin, WDOGE)`. (A `Create2.computeAddress`
     pre-check was considered, controller minor, and left out: the revert reason and the outcome are the same, it would
     only save the gas of a refused launch, and the API mines the salt off chain, open question 2.)
  4. Effects: `launches[coin]` (pool, openAt, ticks, `feeCreator`, `lastConvertAt` 0, liqA, liqB) and `coinOf[pool]`,
     before any call that could observe them.
  5. Interactions: choice-vault `registerCoin` (holders / split / buyback only); `plugin.registerPool(pool, coin,
     tickStart, tickGrad, openAt)`; `T_ACTIVE_POOL = pool`; `entryPoint.createCustomPool(this, creator, coin, WDOGE, "")`,
     which must return the predicted pool (`UnexpectedPool`); `pool.initialize(plugin.pools(pool).sqrtStart)` (the
     9-tuple getter, destructured); `setTickSpacing(pool, 10)`, `setFee(pool, 0)`, `setPluginConfig(pool, 135)`; mint A
     `[tickStart, tickGrad]` and B `[tickGrad, TICK_MAX]` to this contract, each minting exactly the planned liquidity
     and owing no WDOGE (`MintMismatch`); `T_ACTIVE_POOL = 0`; 20M to the reserve lock and `reserveLock.lock(coin, 20M)`;
     the rounding dust (this contract's whole remaining balance of the brand-new coin) to `0x...dEaD`.
  6. First buy, only if `msg.value > 0`: wrap `msg.value`, `T_ACTIVE_POOL = pool`, `pool.swap(creator, oneToZero,
     exact input msg.value, limit sqrtGrad)`, `T_ACTIVE_POOL = 0`. The pool must have taken all of `msg.value`
     (`FirstBuyTooLarge` otherwise: the swap stopped at the graduation price, which means more than A's 850M > 700M);
     out <= 700M (`FirstBuyTooLarge`) and out >= `minFirstBuyOut` (`FirstBuyTooSmall`). The coins go straight to the
     creator (gen-8 L8). Its 2% fee accrues to A like any buy fee and is booked by the plugin; `collect` takes it later.
  7. Events `Launched` and `LaunchMetadata`.
- **States:** only while not paused and with a fresh, valid signature for msg.sender; once per (creator, salt, name,
  symbol); any `openAt` in [now, now + 30 days]. The first buy is the launcher's only swap in `launch` and runs with the
  conversion flag clear, so the plugin charges it the bonding rate and admits it before `openAt` (O2). It cannot latch:
  its price limit is the graduation price, and reaching it would mean more than 700M out, which reverts. If it ever did
  latch, the plugin's inline graduation-fee call would hit this function's lock and be deferred, not run.
- **Native and WDOGE:** the only native in is `msg.value`, wrapped and spent whole by the first buy or the launch reverts;
  the launcher keeps no WDOGE from a launch. Coins: SUPPLY = A's mint + B's mint + 20M + dust, and the launcher keeps none.
- **Over/underflow:** `block.timestamp + 30 days` and `+ 1 day` cannot overflow; `uint40(req.openAt)` is exact because
  `req.openAt <= now + 30 days`; `msg.value` -> int256 through `SafeCast` (reverts above 2^255); `-a0` of a pool amount
  (fits int128) cannot hit `type(int256).min`; curve math as above.
- **Griefing:** a launch can only be sent by the signed creator. A front-runner cannot create our pool (the entry point
  requires msg.sender == deployer, and the deployer is this contract) or deploy at the coin's address (CREATE2 from this
  contract only; the library's `deployCoin` is state-changing, so Solidity's library guard refuses any call that is not
  a DELEGATECALL, and a DELEGATECALL from elsewhere deploys from that caller's address, not ours). Anyone can create a
  default or foreign custom pool for the predicted coin/WDOGE pair, before or after the launch: that is the accepted
  side-pool risk (B3; detected, not prevented) and does not block or affect our pool. WDOGE or coins sent to the
  launcher do not change the launch (the first-buy check uses the pool's own amounts; the dust burn only sees the
  brand-new coin, which nobody else can hold before the launch). Native arrives only from WDOGE (`receive`) or a forced
  transfer (selfdestruct), which changes nothing here and is never booked ("Fee books"). Oracle: a testnet feed moved by
  the oracle-updater key; the band limits the damage to curves sized at a DOGE price between $0.01 and $10 (accepted,
  spec section 2).

### beforeCreatePoolHook / afterCreatePoolHook (plugin factory, views)

- **Guard:** views, no external call. **CEI:** checks only: `msg.sender == entryPoint` (`OnlyEntryPoint`);
  `deployer == this` and a non-zero `pool` equal to `T_ACTIVE_POOL` (`UnexpectedPool`). Returns the shared plugin.
- **States:** reachable only inside our own `createCustomPool` call in `launch`. The entry point refuses
  `createCustomPool` unless msg.sender == deployer, and only this contract can name itself as deployer. Outside a launch
  `T_ACTIVE_POOL` is 0 and the hook reverts, so nobody else can ever create a pool with our plugin.
- **Over/underflow / Griefing:** none.

### algebraMintCallback(amount0Owed, amount1Owed, .)

- **Guard:** the caller must be the pool in `T_ACTIVE_POOL`, i.e. our pool while `launch` is minting into it
  (`BadCallback`), and `amount1Owed == 0` (A and B sit at or above the start price, so they owe no WDOGE). The `launch`
  lock is held. (t4 dropped the redundant `msg.sender == address(0)` term, controller minor: msg.sender is never 0, so a
  cleared slot never matches.)
- **CEI:** checks, then one transfer of the coin (`coinOf[pool]`, our plain ERC-20) to the pool. No state.
- **States:** two calls per launch (A, B). Outside a mint the slot is 0 or another pool, so a direct call reverts; after
  `_seed` clears the slot not even the pool itself can pull more.
- **Over/underflow:** none. **Griefing:** none: only the pool being minted into can call it, and that pool is Barkswap's
  unmodified AlgebraPool code (bytecode-matched, facts section 1).

### algebraSwapCallback(amount0Delta, amount1Delta, .)

- **Guard:** the caller must be the pool in `T_ACTIVE_POOL` (`BadCallback`; the redundant zero-address term dropped as
  above); the launcher's lock is held (inside `launch` or `convert`).
- **CEI:** checks, then pays the pool what it is owed: a positive `amount0Delta` in the coin, a positive `amount1Delta`
  in WDOGE. No state.
- **States:** the creator first buy (WDOGE owed, exactly the `msg.value` just wrapped) and the conversion sell (coins
  owed, at most the pending coin books, which this contract holds; see `convert`). Both set and clear `T_ACTIVE_POOL`
  around their one `pool.swap`.
- **Over/underflow:** positive int256 -> uint256 casts only. **Griefing:** as for the mint callback. A swap the pool runs
  for another caller calls that caller's callback, never ours.

### conversionInProgress(pool) (view)

- Reads the per-pool transient flag `keccak256(abi.encode(T_CONVERSION, pool))`. No guard, never reverts (O2 and the
  `IMwzBarkLauncher` contract). `convert` sets it immediately before its `pool.swap` and clears it immediately after,
  for that pool only; nothing else writes it, so it is false during the first buy and at every other moment.

### takeGraduationFee(pool)

- **Guard:** `nonReentrant`. Called by the plugin from the latching swap's `afterSwap` (inline; the plugin ignores a
  revert) or by anyone later (the fallback). One function, the same guards for both callers.
- **CEI:**
  1. Checks: known pool (`UnknownPool`); not taken (`GraduationFeeAlreadyTaken`); `pool.plugin() == plugin`
     (`ForeignPlugin`: a swapped-in plugin could tax the burn with up to 99.9999% `pluginFee`, facts section 5; resolves
     plugin open question 2 and the controller minor); the pool unlocked (`PoolBusy`: not mid-swap, mint, burn or flash;
     in `afterSwap` the pool is unlocked, facts section 3); the plugin's latch (`NotGraduated`); pool price >= `sqrtGrad`
     (`PriceBelowGraduation`). The latch and `sqrtGrad` are read from `plugin.pools(pool)`.
  2. Effect: `gradFeeTaken = true` (I6: at most once).
  3. Interactions (`MwzBarkLaunchLib.graduationBurn`, DELEGATECALL, so the pool sees the launcher as the position
     owner): `pool.burn(tickStart, tickGrad, floor(liqA x 200 / 10,000))`, which re-enters only the plugin's
     `beforeModifyPosition` (it re-checks range, latch, price and its own once-flag). The burn must return no coin
     (`GraduationBurnNotNative`; unreachable, because at a price at or past A's top tick A is WDOGE only).
     `pool.collect(this, A, 0, a1)` takes exactly the burned WDOGE principal (`CollectMismatch` otherwise); WDOGE
     `withdraw` to native.
  4. Books (t4): `graduationFee = a1` (record), `routerOwed += a1`, `pendingGradFees += a1`: the router bucket's
     graduation book, creator 0%. The base is the whole burn: it is a liquidity burn, not a swap fee, so Barkswap's
     community fee does not cut it, and B11's net base equals the gross. Then the event `GraduationFeeTaken(coin, pool,
     amount, liquidity, inlineCall)`.
- **States:** only after the latch, at a price at or past the graduation price, with our plugin installed, the pool idle,
  and once. The amount is fixed by `liqA` and the two tick prices (`liq x (sqrtGrad - sqrtStart) / 2^96`, floored by the
  pool) whatever the price above graduation, so moving the price before the call cannot change it. The config flag
  `BEFORE_POSITION_MODIFY` is deliberately NOT required (plugin open question 2 asked for it). With our plugin installed
  and the flag off, the burn skips the plugin's check, but every condition that check enforces (range = A, latch,
  price, once) is enforced here first, and no plugin fee can be charged on the burn (the hook is not even called).
  Requiring the flag would only defer the fee until `restore`. Reached inline from swaps of any sender except the
  launcher itself. A latching swap sent while the launcher's lock is held makes the inline call revert on the lock, and
  the fallback takes the fee later. Only `convert` (a sell) could be such a swap, and only if the price was already
  past graduation with the latch unset after an admin outage.
- **Collectable after the burn:** Algebra's burn updates A's fee growth, so afterwards A's owed amounts hold the burned
  principal plus all of A's accrued, uncollected fees in BOTH tokens (WDOGE from buys, coins from sells). This function
  collects exactly the principal (`amount0Requested = 0`, `amount1Requested = a1`), so A's accrued fees stay owed to the
  position and `collect` takes them as fees, in both tokens (it never assumes WDOGE only; controller minor for t4/t32).
- **Over/underflow:** `liqA x 200` fits uint256 and the result is below `liqA` (uint128); `a1` -> uint128 through
  `SafeCast` (the burn of a uint128 liquidity returns at most uint128 amounts); `routerOwed + a1` through `SafeCast`
  (uint128: DogeOS's native supply is far below 2^128 wei).
- **Griefing:** the inline call can be made to fail by a gas limit that starves the launcher (plugin section, `afterSwap`
  griefing); the fee is then deferred to the fallback and nothing is lost. Anyone can call the fallback; it pays the fee
  to the router bucket, never to the caller. A sandwich around the fallback (buy past graduation, call it, sell back)
  gains nothing because the amount does not depend on the price.

### receive()

- Accepts native only from WDOGE (`NotWNative`), i.e. the unwraps of the graduation burn, `collect` and `convert`. A
  WETH9-style `withdraw` forwards 2,300 gas; the check reads one immutable and fits. No state. WDOGE pays native only to
  the address that calls `withdraw`, so no third party can make native arrive here through it.

### restore(coin)

- **Guard:** `nonReentrant`; permissionless (the keeper calls it after the admin-change watch fires).
- **CEI:** check: known coin (`UnknownCoin`). Then `MwzBarkLaunchLib.restorePool(entryPoint, pool, plugin)` (t4: moved
  to the library unchanged; DELEGATECALL, so the entry point sees the launcher, the pool's deployer, as the caller):
  the pool unlocked (`PoolBusy`: never mid-swap, so a swap's hooks and fee cannot change under it); then interactions
  only, in this order (O4):
  1. if `pool.plugin()` is not ours: `entryPoint.setPlugin(pool, plugin)` (upstream `setPlugin` also resets the config
     to 0); the state is re-read after it;
  2. if `lastFee != 0`: if the dynamic-fee flag is on, `setPluginConfig(pool, 0)` first (Algebra refuses `setFee` while
     the flag is on), then `setFee(pool, 0)`;
  3. if the config is not 135: `setPluginConfig(pool, 135)`.
  Then `Restored(coin, pool, pluginReset, feeReset, configReset)`. It reverts `NothingToRestore` if all three already
  held (no event spam, and a keeper can simulate cheaply).
- **States:** any time after launch, any phase. It takes only the coin, so the only values it can write are our plugin,
  lastFee 0 and config 135. It cannot set a fee, a tick spacing, a community fee or any other config (spec: "no other
  post-launch entry-point call exists"). The intermediate config 0 in step 2 exists only inside this call (the pool is
  idle and nothing else runs in between). The plugin's state (latch, books, `gradBurnDone`) survives a plugin swap and
  resumes. It touches no book.
- **Over/underflow:** none.
- **Griefing:** an admin can undo it again at will (accepted testnet risk; the letter mitigates mainnet), and each round
  costs the keeper one transaction. It cannot be used against us: re-applying our own settings is always correct, and it
  refuses to run mid-swap. Tick spacing and community fee are left as the admin set them (the community fee is read at
  every swap; tick spacing only affects new mints, and only the launcher mints, only at launch).

### Fee books (money side design, spec Money flow 1-5, B10, B11)

**Where every wei sits.** Native (DOGE): `creatorOwed[coin]` per coin, the router bucket `routerOwed` (with
`pendingBondingFees` and `pendingGradFees` inside it), parked buckets `routerParked[router]` (sum `parkedOwed`). Coins:
`coinFees[coin]`, four books per coin in `MwzBarkFeeBooks` order [creator bonding, router bonding, creator post, router
post] (the order of the plugin's `FeeTotals`). WDOGE: none at rest (every WDOGE the launcher receives is unwrapped in the
same call).

**Books equal balances (spec invariant).** At the end of every transaction:
`address(this).balance == sum(creatorOwed) + routerOwed + parkedOwed + F`, `WDOGE.balanceOf(this) == D_w` and, per coin,
`coin.balanceOf(this) == sum(coinFees[coin]) + D_c`, where F is native forced in without a call (selfdestruct, block
reward; `receive` refuses everything but WDOGE), and `D_w`, `D_c` are tokens transferred straight to the launcher. Those
three are donations: every booking uses the amounts the pool returns (`collect`, `burn`, `swap`), never `balanceOf`, so
a donation can never be booked, paid or swapped, and it can never make a book exceed its balance; it stays inert (no
sweep exists; open question 4). Every function keeps the equality: `collect` books exactly what the two pool collects
returned (`apportion` sums exactly) and unwraps exactly the WDOGE part; `convert` removes exactly the coins the pool took
from the coin books (`draw` sums exactly), and credits exactly the WDOGE the pool paid, unwrapped; the graduation fee
credits exactly the WDOGE collected, unwrapped; claims zero a book and send exactly that amount; a router change moves
amounts between router books without a transfer. The launch keeps no coin (dust burned) and no WDOGE (first buy spends
its deposit whole). Fork test (t9): the equality after every step of a scripted run, and `balance - books ==` the
donation after a donation.

**Collect apportionment (`MwzBarkFeeBooks.apportion`).** The plugin books, per swap, the creator amount on the gross
fee and the router remainder of the net fee (B10), per pool, per phase and per token, as running totals. A collect reads
the totals, takes the difference `d` against `_collectedTotals[coin]` (the totals at the coin's last collect) and moves
the snapshot to the current totals. It then splits what it actually received, per token, over the four books:
1. each creator book gets its plugin amount `d`, capped by what is left of the received amount (creators first, B10:
   the creator's amount is exactly the plugin's, computed on the gross fee);
2. router bonding gets its plugin amount if the rest covers both router amounts, otherwise its pro-rata share of the
   rest (`mulDiv(rest, dRb, dRb + dRp)`, floored);
3. router post gets everything else.
So the four results always sum to the received amount (books == balances), and the creator books equal the plugin's
creator totals unless the whole collect is smaller than the creator amounts alone (only possible if an outside LP shares
our fees after a Barkswap admin cleared our config; then the creators get all of it and the router 0).

**Tolerance (spec: "the plugin's per-phase totals equal what collect can still take, within a stated rounding
tolerance").** The plugin's per-swap estimate and the pool's per-step fee, community cut and Q128 fee-growth flooring
differ by a few wei per swap either way (plugin section, "Tolerance": derived <= 16 wei per swap per book; t9 measures
and pins it). The launcher books collected amounts only, so the difference never enters a creator book and never
accumulates: rounding in our favour lands in router post, rounding against us shrinks the two router books pro rata,
and each collect moves the snapshot to the plugin's current totals (no carry). The plugin's books and the pool's fee
growth always describe the same set of completed swaps, because `collect` can only run with the pool idle: its first
zero burn reverts on a locked pool, and the plugin books a swap in `afterSwap` before the pool can be entered again.

**Unbooked surplus (plugin open question 4, controller minor).** Flash-loan fees (cut by the community fee), tokens
transferred straight to the pool (Algebra's `_updateReserves`, run by every burn including our zero burns, hands any
balance above the reserves to the in-range liquidity as fees; we are the only liquidity) and the LP fees of a period in
which a Barkswap admin had turned our swap hooks off or installed another plugin all reach our positions without a
plugin booking. They land in **router post**, by step 3 above. Why router post and not the router book of the current
phase: B (bonding) and G (graduation) are the splitter's band bases (league 37.5% of B, recruiter + squad + airdrop in
bands of B and G), and the off-chain pipeline backs every B wei with an attributed trade row (D1); surplus has no trade
row, so it must not grow a band. Router post is part of `routerPaid.amount` only, which the splitter routes as the
protocol remainder: nothing is lost, no band moves, and a route run still matches `expectedPaid` (the indexer reads the
surplus from `FeesCollected`: the router post book minus the plugin's router post delta).

**Conversion draw (`MwzBarkFeeBooks.draw`).** `convert` sells `used` of the `pending` coins (the four books' sum) and
receives `out` WDOGE. Each book gives `floor(book x used / pending)` (the whole book if `used == pending`); the at most 3
coins the floors leave are placed on books with room, router post first, so the four draws sum to `used` exactly and no
book goes negative (total room = pending - sum(floors) >= the leftover, since used <= pending). Each book then gets
`floor(out x drawn / used)` of the WDOGE, and the at most 3 wei left go to router post. So every pending coin of the coin,
creator or router, bonding or post, converts by the same fraction `used / pending` at the same average price (D1,
on-chain part; within 3 coins of dust per call), and the DOGE goes back to the same books.

**Credit (`_creditNative`).** Native per book: creator bonding + creator post to `creatorOwed[coin]`; router bonding +
router post to `routerOwed`; router bonding also to `pendingBondingFees`. The graduation fee goes to `routerOwed` and
`pendingGradFees` only. So, cumulatively and per router payout, `bondingFees` is the router's NET bonding DOGE (after
Barkswap's cut, the creator's amount and coin conversion), `gradFees` the graduation fees, and `amount - bondingFees -
gradFees` the router's post-graduation DOGE plus rounding and surplus.

**B11 (a route run never reverts `OutOfBand` because of the cut).** The splitter (t5, gen-8's arithmetic) needs
`floor(3750 B / 1e4)` (league) plus a recruiter + squad + airdrop sum in `[1500 B + 1750 G, 1750 B + 2000 G] / 1e4` to fit
in the run's total. With B and G the net books above, the most it can commit is `0.55 B + 0.2 G <= B + G <= total`
whatever Barkswap's community fee is (B and G shrink with the cut, and so does the total, but never below B + G). The
spec's Barkswap cut is therefore shared pro rata by league, recruiter, airdrop and protocol, as B11 decided.

**Routable totals are realised DOGE (spec Money flow 5).** `routerPaid` and the bucket hold native only: buy fees from
the moment they are collected and unwrapped, sell fees only from the moment they are converted. A coin fee that has not
been converted is in no router total, so the splitter's `expectedPaid` always compares against DOGE that exists.

### collect(coin)

- Permissionless; the keeper calls it on a schedule. Moves the fees accrued to the coin's A and B into the books.
- **Guard:** `nonReentrant`.
- **CEI, in order:**
  1. Checks: known coin (`UnknownCoin`).
  2. Effects that depend on no external outcome: `t = plugin.feeTotals(pool)` (view), the eight differences `d` against
     `_collectedTotals[coin]` (checked uint128 subtraction; the plugin's totals only ever grow, `+=` in its `_book`), and
     `_collectedTotals[coin] = t`.
  3. Interactions (`MwzBarkLaunchLib.collectFees`, DELEGATECALL, so the pool sees the launcher as the owner): zero-amount
     `burn` on A `[tickStart, tickGrad]` and on B `[tickGrad, TICK_MAX]` (O3: collect's only burns; the pool first runs
     `_updateReserves`, then moves each position's accrued fees into its owed amounts; our plugin's
     `beforeModifyPosition` lets zero-amount burns pass and its plugin fee is 0, and any plugin fee applies to burned
     principal only, which is 0 here), then `collect(this, range, max, max)` on both, then `WDOGE.withdraw` of the WDOGE
     part. Principal is never in the owed amounts: the only non-zero burn (the graduation burn) collects exactly its
     principal in its own call. `NothingToCollect` if nothing arrived and the plugin booked nothing since the last
     collect.
  4. Books: `apportion` per token ("Fee books"); WDOGE credited at once (`_creditNative`), coins added to `coinFees[coin]`
     (`SafeCast` to uint128). Event `FeesCollected(coin, native, coins, nativeBooks[4], coinBooks[4])`.
- **Reentrancy reasoning:** the code that runs between steps 2 and 4 is Barkswap's unmodified AlgebraPool, our plugin
  (`beforeModifyPosition`, no call back), our plain `MwzV4Token` and WDOGE (transfers; WDOGE's `withdraw` calls our
  `receive`, which only checks the sender). No third-party code runs, so nothing can observe the books between the
  snapshot and the credit, and every state-changing launcher entry is locked anyway.
- **States:** any launched coin, any phase, before or after `openAt`, any time the pool is idle (a pool that is mid-swap,
  mint, burn or flash reverts the first burn with Algebra's lock error). Also with a foreign plugin installed (its
  `beforeModifyPosition` runs on the zero burns; if it reverts them, collect waits for `restore`). Collect never swaps
  and never moves a price.
- **Over/underflow:** differences of uint128 totals, checked; sums of eight uint128 values < 2^131; book additions
  checked through `SafeCast` (a coin book cannot exceed the coin's 1e27 supply; native books stay far below 2^128);
  `apportion` as argued in "Fee books" (`mulDiv` with `rest < dR`, so the result is below `dRb`).
- **Griefing:** anyone may call it at any time; it only moves our own fees into our own books. The booked totals are
  path-independent up to rounding: the creator amounts are the plugin's whatever the collect schedule, and timing can
  only move rounding-level wei between the two router books. A donation to the pool is a gift to router post. Spam
  costs the caller gas and gives nothing (`NothingToCollect` when there is nothing). Fixed work per call (2 burns, 2
  collects), so no gas griefing. Gas: about 0.25-0.33M (fork-measured in t9), far below the 10M gate.

### convert(coin)

- Permissionless; the keeper calls it on a schedule. Sells the coin's pending coin fees for DOGE (B5).
- **Guard:** `nonReentrant`.
- **CEI, in order:**
  1. Checks: known coin (`UnknownCoin`); `now >= openAt + 60` (`ConversionInLaunchWindow`; the plugin refuses it too);
     `now >= lastConvertAt + CONVERT_INTERVAL` (`ConversionTooSoon`); `pool.plugin() == plugin` (`ForeignPlugin`: a
     foreign plugin could charge a plugin fee of up to 99.9999% on the sell); `lastFee == 0` (`ConversionFeeNotZero`).
     With our plugin installed and lastFee 0, the conversion's fee is 0 by the launcher's own checks whatever hooks an
     admin left on: our `beforeSwap` returns overrideFee 0 for a conversion and never a plugin fee, and with the
     before-swap hook off the pool charges lastFee = 0 (spec invariant "a conversion swap pays 0 fee"). Price limit:
     `limit = max(ceil(sqrtPrice x 994,987,438 / 1e9), sqrtStart)` with `sqrtStart = getSqrtPriceAtTick(tickStart)`
     (exactly the plugin's `sqrtStart`, same ticks and the same TickMath); `NothingToConvert` if nothing is pending or
     `limit >= sqrtPrice` (the price is at the start price: no coin can be sold without breaking F2).
  2. Effect: `lastConvertAt = now` (the one outcome-independent write).
  3. Interaction: `T_ACTIVE_POOL = pool` and the pool's `T_CONVERSION` flag set immediately before
     `pool.swap(this, zeroToOne, exact input = pending, limit)`, both cleared immediately after (O2). Inside the swap
     the pool calls our plugin (`beforeSwap` reads `conversionInProgress`, a transient view, and returns overrideFee 0;
     `afterSwap` books nothing for a 0 fee, checks F2, emits the conversion kind), transfers the WDOGE out to us, and
     calls our `algebraSwapCallback`, which pays the coins owed (at most `pending`, which this contract holds as the coin
     books) from our balance.
  4. Books: `coinsIn` = the pool's positive coin delta (`NothingToConvert` if 0), `nativeOut` = its negative WDOGE delta;
     `draw` ("Fee books"); the four coin books lowered by their draws; `WDOGE.withdraw(nativeOut)`; `_creditNative`;
     event `CoinFeesConverted(coin, pending, coinsIn, nativeOut, coins[4], native[4])`.
- **Always the full capped amount, whatever the caller:** the call has no amount argument. It offers the pool everything
  pending, exact input, with the impact-capped limit, so the pool sells exactly min(pending, the coins that move the
  price to the limit): a dust call cannot use up an interval, because every call converts everything the cap allows.
- **Bounds (spec "Griefing bounds"):** the price never ends below the start price (the limit is at least `sqrtStart`, so
  F2 holds by the launcher's own limit even if an admin turned the plugin's after-swap check off); the price moves at most
  1% per call (`CONVERT_SQRT_FACTOR_E9` is `ceil(sqrt(0.99) x 1e9)`, so `(limit / sqrtPrice)^2 >= 0.990000001`, and
  the limit itself is rounded up); one call per coin per 10 minutes; none inside the 60 s launch window.
- **Deviation from the spec's wording (for t7):** the spec says "books updated before the swap's external calls settle".
  The coin and DOGE books depend on the filled amount, which only the swap's return value gives, so they are updated
  right after the swap returns, before any further external call except the WDOGE unwrap. This is safe for the same
  reason as in `collect`: no third-party code runs inside the swap (Barkswap's unmodified pool, our plugin, our swap
  callback, our plain coin and WDOGE); the plugin's only calls back are the transient view and, only if this sell were
  to latch graduation (possible only if an admin outage left the latch unset past graduation), `takeGraduationFee`,
  which hits the lock and is deferred to the fallback; and every state-changing launcher entry is locked. The interval
  stamp, the one effect that does not depend on the outcome, is written before the swap. A revert anywhere (plugin
  refusal, F2, callback, cast) reverts the stamp and every book.
- **States:** any launched coin, after the launch window, at most once per interval, any phase (in A, in B, or crossing
  back from B into A: the rate rule does not apply to a conversion), only with our plugin installed and lastFee 0 (after
  an admin change: `restore` first), only with coins pending and the price above the start price, and only with the
  pool idle (a locked pool reverts the swap).
- **Over/underflow:** `mulDivRoundingUp(sqrtPrice < 2^160, 994,987,438, 1e9)` is below `sqrtPrice`, so the uint160 cast is
  exact; `pending` (four uint128) -> int256 through `SafeCast`; `a0 >= 0` and `a1 <= 0` for an exact-input zeroToOne swap
  (guarded casts anyway); `book - draw >= 0` by `draw`'s construction and the uint128 cast of a smaller value is exact;
  `lastConvertAt` is uint40 (block times fit until year 36,812); native credits checked.
- **Griefing:** (1) Sandwich: an outsider who sells before a conversion and buys back after gains at most the conversion's
  own price move (<= 1%) on the size it buys back, and pays the phase fee on both legs (2 x 2% = 4% while bonding, 2 x 1%
  = 2% after graduation; the 90% window is excluded): unprofitable in both phases. (2) Timing: anyone can trigger the
  conversion at a moment of their choosing, at most once per interval, and only for coins that are actually pending; the
  coins sold over time are fixed by the fee books (a fee is 2% / 1% of a sell that moved the price far more), so the cap
  and the interval bound only when, never how much. Front-running the keeper delays the next conversion by at most 10
  minutes and costs nothing. (3) Blocking: pushing the price to the start price makes `convert` revert
  `NothingToConvert` until the price rises (selling down to the start costs the seller the 2% fee and gives no gain);
  an admin's plugin or fee change makes it revert until `restore`. Nothing is lost while it waits; pending coins stay
  booked. Gas: about 0.2-0.3M (fork-measured in t9).
- **Deploy-time constants and rationale.** `CONVERT_IMPACT_BPS` = 100 (1% of price per call) and `CONVERT_INTERVAL` =
  10 minutes are compile-time constants (fixed at deployment; changing them is a new generation, so they are no admin
  knob and no griefing surface). The cap is set below the cheapest round trip an outsider can make around a conversion
  (2% after graduation, 4% while bonding), so sandwiching a conversion never pays, while one call still converts
  everything ordinary trading leaves pending: the coin fee of a sell is 2% (1%) of that sell, whose own price impact was
  far larger, so the cap binds only after a burst of selling, and then the remainder converts over the next intervals.
  The interval caps forced conversions at six per coin per hour (at most 1% each), which bounds the sell pressure an
  outsider can time, and it is short against what waits on conversion: the keeper's schedule, and attribution and league
  pots, which count converted DOGE only (spec D1, weekly epochs), so a coin fee is never held back more than one
  interval beyond the keeper's own cadence.

### claimCreator(coin, to)

- Gen-8 `claimCreator(PoolId, to)` keyed by coin. **Guard:** `nonReentrant`.
- **CEI:** checks (`msg.sender == launches[coin].feeCreator`, `NotCreator`; an unknown coin has feeCreator 0, which no
  sender equals; `to != 0`, `ZeroAddress`; amount > 0, `NothingOwed`), effect (`creatorOwed[coin] = 0`), then the payout
  (native `call` with all gas and no return-data copy, `SendFailed` on failure) as the last call, then the event.
- **States:** any time, any phase, also while launches are paused; only the coin's current `feeCreator` (the creator for
  keep coins, the choice vault for holders / split / buyback, which claims to itself, t6). The owner has no path.
  Pays only what `collect` and `convert` have credited: the keeper (or the creator) calls `collect` and `convert` first
  to bring recent fees in.
- **Over/underflow:** none (a stored value is paid and zeroed).
- **Griefing:** none on others. A recipient that rejects native (or re-enters, which hits the lock) reverts the claim and
  the balance stays (gen-8 A13); it can only hurt its own claim. A return bomb cannot cost the claimer gas for copying.

### proposeCreator(coin, next) / acceptCreator(coin)

- Gen-8 4.6 two-step transfer of `feeCreator`, keyed by coin. **Guard:** none needed (no external call).
- **CEI:** `proposeCreator`: known coin (`UnknownCoin`), caller is the current feeCreator (`NotCreator`), write
  `pendingCreator`, event; `address(0)` cancels. `acceptCreator`: caller is the pending address (`NotPendingCreator`;
  a cleared slot is 0, which no sender equals, so t4 drops gen-8's redundant zero check), event, then `feeCreator =
  caller` and the pending slot cleared.
- **States:** any time. After the hand-over only the new feeCreator can claim, including the balance owed before it (gen-8
  semantics: the balance belongs to the coin's creator seat). For holders / split / buyback coins the seat is the choice
  vault, which decides itself whether it ever proposes. **Over/underflow:** none. **Griefing:** none; a wrong proposal
  can be overwritten or cancelled before it is accepted.

### claimRouter()

- Gen-8 F4 unchanged in substance. **Guard:** `nonReentrant`.
- **CEI:** checks: the caller is the current `treasuryRouter`, the `owner`, or the router's `operator()` (read with a
  30,000-gas `staticcall`; a router without one, or one that reverts, returns short data or burns the gas, simply has no
  operator) (`NotRouterCaller`); `routerOwed > 0` (`NothingOwed`). Effects: the bucket and its two counters zeroed, then
  `routerPaid[router] += (amount, bonding, grad)`. Interaction: the native payout to the router as the last call
  (`SendFailed` on failure), then `RouterClaimed(router, amount, bondingFees, gradFees)`.
- **States:** any time with a non-zero bucket; also while launches are paused. Pays the current router only.
- **What the splitter sees (B11, spec Money flow 5):** `routerPaid(router)` = cumulative (amount, net bonding DOGE,
  graduation DOGE) actually paid, all post-conversion realised DOGE; the splitter's `expectedPaid` pins a run to it as in
  gen-8 (V13).
- **Over/underflow:** cumulative sums are uint256 of uint128 buckets.
- **Griefing:** a third party cannot claim (gen-8 C-M1 / D-L3 closed), so it cannot move `routerPaid` between the
  operator's plan and its route. Our own second claim (two workers, or the owner) makes a stale plan revert
  `PaidMismatch`, which the worker handles by re-planning. A router that rejects native reverts the claim and the bucket
  stays. A malicious router could return any address from `operator()`; the router is chosen by the owner behind the
  48 h timelock, and whoever it names can only pay the router its own bucket.

### payParkedRouter(router) / proposeTreasuryRouter / cancelTreasuryRouter / executeTreasuryRouter

- Gen-8 A4 / F3 unchanged (gen-8 audit 15.3). **Guard:** `payParkedRouter` is `nonReentrant`; the three owner functions
  make no external call.
- **CEI:** `proposeTreasuryRouter(next)`: owner, `next != 0`, pending router and `eta = now + 48 h`, event.
  `cancelTreasuryRouter`: owner, a pending router (`NoPendingRouter`), cleared, event. `executeTreasuryRouter`: owner, a
  pending router at or after its eta (`TimelockActive`); if the bucket is non-zero it moves into `routerParked[old]`
  with its two counters and `parkedOwed += amount` (event `RouterParked`), then the router switches (event
  `RouterChanged`). `payParkedRouter(r)`: amount > 0 (`NothingOwed`), `delete routerParked[r]`, `parkedOwed -= amount`,
  `routerPaid[r] +=`, then the payout to `r` as the last call.
- **States:** execute only by the owner with a pending proposal at or after its eta; pay parked by anyone, any time, to
  the router the bucket was accrued under only. Re-proposing the same router parks to itself; proposing an old router
  again adds to its parked counters.
- **Over/underflow:** `parkedOwed -= amount` follows an earlier `+=` of the same amount; sums are uint256.
- **Griefing:** gen-8 A-2 is closed (no flush to make fail: the change makes no external call). A refusing old router
  keeps its parked bucket until it accepts and cannot block the change. `payParkedRouter` is one-shot per change, so it
  can move the old splitter's cumulative paid between that splitter's plan and route at most once per change (the
  operator re-plans).

### routerPaid / routerParked / routerOwed / creatorOwed / coinFees (views)

- Public getters. `routerPaid(router)` returns `(amount, bondingFees, gradFees)` in gen-8's order, so the t5 splitter
  reads it with gen-8's code; the meaning of `bondingFees` is B11's net bonding DOGE ("Fee books").

### Launcher obligations (O1-O4 of `IMwzBarkLauncher`, checked)

- [x] **O1 Registration.** `plugin.registerPool(pool, coin, tickStart, tickGrad, openAt)` runs before
  `entryPoint.createCustomPool` (the pool has no code yet; the plugin checks it). The coin is token0 (`coin < WDOGE` or
  revert) and WDOGE token1. `pool.initialize` is called by the launcher with `plugin.pools(pool).sqrtStart` (9-tuple
  getter, destructured), so the start price is exactly the plugin's. A is minted at exactly `[tickStart, tickGrad]` and
  B at exactly `[tickGrad, TICK_MAX]` (B's lower tick is tickGrad itself, controller minor), so
  `sqrtStart == getSqrtRatioAtTick(A.bottom)` and `sqrtGrad == getSqrtRatioAtTick(A.top) == getSqrtRatioAtTick(B.bottom)`.
  Both planned ticks are checked to be multiples of 10 before `registerPool` (TICK_MAX is the constant 887,270). (v4-core
  vs Algebra sqrt-at-tick equality is a t8 fork check.)
- [x] **O2 Swaps.** Exactly two launcher swaps exist: the creator first buy in `launch` (conversion flag clear, bonding
  rate, may run before openAt) and the conversion sell in `convert`, which sets the pool's `T_CONVERSION` flag
  immediately before its `pool.swap` and clears it immediately after. No other `pool.swap` call exists (the libraries
  make none). `conversionInProgress` is a plain view without the reentrancy guard and cannot revert.
- [x] **O3 Liquidity.** `pool.mint` appears only in `_seed`, called only from `launch`, with this contract as recipient
  (and leftovers recipient). The only non-zero `pool.burn` is the graduation burn (`MwzBarkLaunchLib.graduationBurn`,
  called only from `takeGraduationFee`, `floor(liqA x 2%)`, once). `collect`'s burns (`MwzBarkLaunchLib.collectFees`)
  have amount 0.
- [x] **O4 Fee setting.** Launch: `setFee(pool, 0)` before `setPluginConfig(pool, 135)` (the config is 0 after
  creation, so the flag is off). `restore` (`MwzBarkLaunchLib.restorePool`): `setFee(pool, 0)` only while the flag is
  off (cleared first if needed), then 135. `setFee(0)` is unconditional at launch because upstream `initialize` always
  sets the factory default fee (plugin open question 8).
- [x] `takeGraduationFee(pool)`: at most once per pool, never below the graduation price, fallback guards (unlocked,
  latch, price, plus our plugin installed) applied to every caller.

### Invariants this contract upholds

| Spec invariant | How | Fork test |
|---|---|---|
| A and B lose liquidity exactly once, `floor(liqA x 2%)` at graduation (I6) | no burn path but `takeGraduationFee`; `gradFeeTaken` once-flag; plugin `gradBurnDone` as defense in depth; `collect` burns amount 0 only | t8 |
| 2% graduation fee at most once, never inside A; the only entry in the graduation book, creator 0% | latch + price >= `sqrtGrad` + once-flag; the burn returns WDOGE only; `pendingGradFees` written only there | t8, t9 |
| `restore` re-applies only our plugin and launch config | no argument but the coin; writes only `plugin`, lastFee 0, config 135 | t9 |
| Only the launcher initializes and adds liquidity | launcher side: `initialize` and `mint` only inside `launch` (plugin side in its section) | t8 |
| No swap before `openAt` except the creator first buy | the first buy is the launcher's only pre-open swap (O2); `convert` refuses before `openAt + 60` | t8 |
| Supply split 850M / 130M / 20M, first buy <= 70% | constants; `MintMismatch`, dust burn, `FirstBuyTooLarge` | t8 |
| Target sized once at launch from the oracle; band $0.01-$10; age <= 3600 s | `planLaunch` (F6), constructor age check | t8 |
| Signed create (D3) with `openAt`, replay-safe | `_consumeAuthorization`, gen-8 digest | t8 |
| Pool tick spacing 10, lastFee 0, config 135 at launch | `_createPool` | t8 |
| Creator amount exactly B10 (bonding: 560 bps of the gross fee; post: 50% of the gross fee, sells valued at their conversion price), whatever the cut | the plugin's creator totals booked unchanged (`apportion`, creators first); converted pro rata with the router books | t9 |
| The launcher's books (per coin, per phase, in WDOGE, coin and DOGE) equal its balances | bookings from pool return amounts only; `apportion` / `draw` sum exactly; unwrap in the same call ("Fee books") | t9 |
| The plugin's per-phase totals equal what collect can take, within the stated tolerance | snapshot differences; the tolerance goes to the router books only; no carry | t9 |
| A conversion never ends below the start price, never exceeds its impact cap, respects its interval, converts the full capped amount | limit `max(ceil(sqrtP x sqrt(0.99)), sqrtStart)`; exact input of all pending; `lastConvertAt` | t9 |
| A conversion swap pays 0 fee; every other swap the phase rate | our plugin installed + lastFee 0 checked by `convert`; the flag only inside `convert` | t9 |
| A route run never reverts `OutOfBand` whatever the community fee (B11) | `routerPaid` bonding / graduation are the net books; `0.55 B + 0.2 G <= total` | t10 |
| Claims pay only the entitled party | `claimCreator`: the coin's feeCreator; `claimRouter`: the current router; `payParkedRouter`: the router it was parked for | t9 |
| Parked-router rules (F3 / F4) | gen-8's code, keyed the same | t9 |

### Barkswap admin powers relevant to the launcher (facts section 5)

| Admin action | Effect on the launcher | Remedy |
|---|---|---|
| `setPlugin(other)` | graduation fee and `convert` refused (`ForeignPlugin`) until restored; `collect` keeps working unless the other plugin reverts burns; LP fees charged meanwhile (lastFee) reach our positions unbooked and land in router post; positions and principal untouched (no admin burn exists) | `restore` |
| config / static fee changes | `convert` refused while lastFee != 0 (`ConversionFeeNotZero`); swaps charged lastFee without our before-swap hook are booked by the plugin's after-swap fallback, or, with both hooks off, not at all (router post surplus); `restore` re-applies 135 and lastFee 0 | `restore` |
| `setTickSpacing` | none: positions are minted once, at launch; zero burns, collects and the graduation burn address the existing ranges (t9 case) | none needed |
| `setCommunityFee` | the net fee shrinks; the plugin books net per swap with the creator first (B10), so only the router books shrink; B11 keeps route runs inside the bands; the graduation burn is not cut | watch |
| revoke the entry point's `CUSTOM_POOL_DEPLOYER` role | new launches revert inside `createCustomPool`; existing pools unaffected; `restore` reverts until the role is back | founder / Barkswap |

### Launch gas (estimate against the 7M gate; fork-measured in t8)

The proof's launch through the entry point with direct `pool.mint` measured 6,132,142 gas at spacing 10 (README "Gas").
That includes the coin CREATE2 (763,441 for the proof's token, which carried guard code; `MwzV4Token`'s runtime is 1,502
bytes), the pool deployment (~4.5M), registration, initialize, the three entry-point setters, both mints, the 20M
transfer and the dust burn. t32 added about: calldata of the signed request (~1-1.5 KB, ~20k); request hashing, ecrecover
and the replay-map SSTORE (~35k); two oracle reads (~30k); curve math, `getTickAtSqrtPrice` x2 and `getSqrtPriceAtTick`
x6 (~15k); `launches` (3 new slots) and `coinOf` (~90k); the `plugin.pools` read-back (~5k); `reserveLock.lock` (~45k
beyond the proof's 20M transfer); the two events with the metadata strings (~15k). That is about +255k: **~6.39M**
without a first buy and **~6.46M** with a non-keep fee choice (choice-vault registration, ~60k). **t4 re-estimate with
the library split:** `launch` now makes two DELEGATECALLs into `MwzBarkLaunchLib` (`planLaunch`, `deployCoin`): one cold
account access (2,600) plus one warm (100), the ABI encoding of name and symbol and of the 7-word plan (~2-3k), and the
library's call guard (a few gas): about +6k. `lastConvertAt` shares slot 1 with `feeCreator` and starts at 0 (no extra
SSTORE); nothing else of the money side runs in `launch`. So **~6.40M** / **~6.47M**, and with the creator first buy
(167k in the proof, 10 DOGE) a worst case of **~6.56-6.66M**, about 0.34M under the 7M gate (66-67% of a 10M block). t8
pins the measured figure.

### Size and the library split (done in t4)

At t32 the launcher was 21,588 bytes (2,988 under EIP-170) and the money side could not fit beside the launch code. t4
split it as planned and further, measured with `node scripts/dogeos-bark-sizes.mjs` (which now labels libraries and the
libraries each contract links):

| Artifact | Kind | Runtime bytes (t4) | Holds |
|---|---|---|---|
| `MwzBarkLauncher` | contract | 22,307 (2,269 headroom) | launch, callbacks, plugin-factory hooks, graduation-fee guards and books, restore entry, the whole money side |
| `MwzBarkLaunchLib` | linked library | 10,255 | `deployCoin` (the embedded `MwzV4Token` creation code), `planLaunch` + the pure curve helpers, `restorePool`, `graduationBurn`, `collectFees` |
| `MwzBarkFeeBooks` | linked library | 1,133 | `apportion`, `draw` (pure) |

Measured steps: moving the coin deployment and the curve planning first (the plan), then the pool calls of `restore`
(-672 bytes), of the graduation burn (-265) and of `collect` (-676), and making the two book functions linked instead of
inlined (-322). The book arithmetic, the books themselves and every guard stay in the launcher; the libraries hold no
state, read none of the launcher's storage and receive every value as an argument. Every library function that writes
state (`deployCoin`, `restorePool`, `graduationBurn`, `collectFees`) is reachable only by DELEGATECALL (Solidity's
library guard), so a direct call on the library address reverts; a DELEGATECALL from any other contract acts as that
contract (its own address deploys, its own positions are touched), never as the launcher. The launch path and the
graduation fee changed only by moving code: the same calls, in the same order, from the same address. The deploy
script (t15) deploys and links both libraries (link references in the launcher's artifact); errors raised inside a
library (`OraclePriceUnavailable`, `OraclePriceOutOfBand`, `TargetOutOfRangeAtPrice`, `SupplyBoundBroken`, `BadTicks`,
`BadLiquidity`, `PoolBusy` from `restorePool`, `NothingToRestore`, `GraduationBurnNotNative`, `CollectMismatch`) are in
the library's ABI, not the launcher's, so the t7 ABI export must merge them.

### Hand-off from t4

- t5 splitter: reads `routerPaid(address)` (gen-8 order), receives native from the launcher (gen-8's `receive` accepted
  only the PoolManager: it must accept the launcher), exposes `operator()` (F4), is deployed against the launcher's
  predicted address and passed to the launcher as `treasuryRouter_`.
- t5 lens and reserve lock: `launches(coin)` is now a 10-tuple (`lastConvertAt` after `feeCreator`); owed amounts are
  `creatorOwed(coin)`, `coinFees(coin)`, `routerOwed()`; the uncollected estimate is `plugin.feeTotals(pool)` minus
  `collectedTotals(coin)`; `plan(targetUsd)` returns the `LaunchPlan` struct.
- t6 choice vault: claims with `launcher.claimCreator(coin, address(this))` and must accept native from the launcher.
- t15: deploy `MwzBarkLaunchLib` and `MwzBarkFeeBooks`, link them, then the launcher with 12 constructor arguments
  (`treasuryRouter_` 9th).
- t9: the money invariants in the table above; the surplus cases (flash, direct transfer to the pool, hooks off); the
  tolerance measurement; conversion cap, interval, window, F2 limit, `ForeignPlugin` and `ConversionFeeNotZero`; a sandwich
  around `convert` loses money; claims and F3 / F4 cases; `setTickSpacing` then a collect and the graduation burn.
- t18-t20 (indexer, attribution, keepers): events `FeesCollected`, `CoinFeesConverted` (with `pending`, so every pending
  sell row converts by `coinsIn / pending`), `CreatorClaimed`, `RouterClaimed`, `RouterParked`; the keeper runs
  `collect` then `convert` per coin (after `restore` when the admin watch fires).

### Open questions

1. **Reserve lock and choice vault interfaces (t5, t6).** The launcher calls `reserveLock.lock(coin, amount)` and
   `choiceVault.registerCoin(coin, creator, choice, creatorPct)`, keyed by coin (gen-8 keys them by V4 `PoolId`). t5 and
   t6 must implement exactly these signatures and `launcher()`; their diff audits explain the key change. The reserve
   lock reads the latch, `sqrtGrad` and `graduatedAt` from `plugin.pools(pool)` and the pool from
   `launcher.launches(coin)`.
2. **CREATE2 salt mining (t21).** The API must find `req.salt` with
   `create2(launcher, keccak256(abi.encode(creator, salt)), keccak256(MwzV4Token.creationCode ++ abi.encode(name,
   symbol, 1e27, launcher))) < WDOGE`. The deployer is the launcher even though the CREATE2 runs in `MwzBarkLaunchLib`
   (DELEGATECALL). WDOGE is `0xF6BD...`, so about 96% of salts qualify. There is no on-chain predictor view; t8 computes
   the address off chain the same way.
3. **Test target chains.** `TEST_GRADUATION_USD` ($150) is allowed on 6281971 and 31337 only; the fork runs as 6281971.
4. **Donations to the launcher (t7 decision).** Native forced in, and WDOGE or coins transferred straight to the
   launcher, are never booked and stay inert (books use pool return amounts only). A permissionless sweep into router
   post would make `balance == books` hold exactly instead of `balance - books == donations`, at the cost of one more
   entry point (~300 bytes). Proposed: Informational, accept.
5. **"Books updated before the swap's external calls settle" (t7 decision).** See `convert`, "Deviation from the spec's
   wording": the books move right after the swap returns, under the lock, with no third-party code inside the swap.
   Proposed: accept as written.
6. **Conversion constants are compile-time.** The spec calls them deploy-time constants; they are code constants fixed
   at deployment (no setter). A different cap or interval is a new generation.

Verdict: pending (t7)

---

## MwzBarkFeeSplitter

**File:** `contracts/dogeos/barkswap/MwzBarkFeeSplitter.sol` (203 lines). **Counterpart:** `contracts/gen8/MwzFeeSplitter.sol`
(197 lines, vendored from `e129712b9`; gen-8 audit 4.5, V13, 15.4). **Diff:** `git diff --no-index
contracts/gen8/MwzFeeSplitter.sol contracts/dogeos/barkswap/MwzBarkFeeSplitter.sol` (36 insertions, 30 deletions, 10
hunks). **Imports:** OZ `ReentrancyGuard` (unchanged); `MwzBarkLauncher` as a type only (no library link, no code
reuse). Written by t5.

**What changed, in one line:** the payer is the launcher instead of the hook. `route`, `bands`, the run sequencing, the
operator / admin model, the effects order, the destinations, the errors and both events are byte-for-byte gen-8's; the
band arithmetic is untouched on purpose (the t4 B11 proof depends on it).

### Diff hunks

1. `@@ -1,20 +1,21 @@` imports and title. The V4 `IPoolManager` and `IMwzLaunchHook` imports go; `MwzBarkLauncher` is
   imported as a type. Typing the payer as the launcher contract (not a hand-written interface) makes the compiler check
   `routerPaid`'s return shape against the launcher's `RouterPaid` struct, so a layout drift breaks the build instead of
   mis-decoding. `IMwzCommunityRewardsVault` is kept verbatim (same vault, same two functions). NatSpec: the attribution
   source is now the plugin's `BarkSwap` and the launcher's `FeesCollected` / `CoinFeesConverted` events (spec
   "Attribution for D1") instead of `HookFee`. No code.
2. `@@ -22,16 +23,20 @@` NatSpec only, plus the contract name. States B11 (B and G are the launcher's post-conversion
   net books, see "B11" below) and replaces gen-8's "router-change flush" with `payParkedRouter` (the launcher's F3
   form: a router change parks the bucket, and the parked bucket is paid by a separate permissionless call).
3. `@@ -52,8 +57,9 @@` immutables. `hook` and `poolManager` become one immutable `launcher` (getter `launcher()`). ABI
   change: `hook()` and `poolManager()` are gone. No off-chain caller reads either from the splitter (the indexer's
   `GEN8_SPLITTER_ABI` lists `hook()` but never calls it; `financeGen8.js` reads `pending`, `runs`, `routedAmount`,
   which are unchanged). The Bark venue's ABI (t17 / t18) lists `launcher()`.
4. `@@ -61,6 +67,7 @@` a comment on `operator`: the launcher's `claimRouter` reads it (gen-8 F4, 30,000-gas
   `staticcall`). The state variable was already public in gen-8, so `operator()` exists unchanged (controller note:
   "expose `operator()`").
5. `@@ -83,7 +90,7 @@` constructor parameter type `IMwzLaunchHook hook_` -> `MwzBarkLauncher launcher_` (same
   position, first of eight; ABI type `address` either way).
6. `@@ -93,11 +100,10 @@` constructor body. Zero check on `launcher_` (as on `hook_`). Gen-8 called
   `hook_.poolManager()` here; the splitter now makes **no call at construction**, because it is deployed before the
   launcher, against the launcher's predicted address, and handed to the launcher's constructor as `treasuryRouter_`
   (12-argument constructor, 9th; the launcher does not call the splitter at construction either). Deploy risk: a
   wrong predicted address makes every router payout revert in the launcher (below, hunk 7). t15 checks
   `splitter.launcher() == launcher` after deployment.
7. `@@ -108,9 +114,9 @@` `receive()`: native accepted only from the launcher (gen-8: only from the PoolManager, because
   the hook paid through burn-claim + take). The launcher pays the router with a plain `call` carrying all gas
   (`MwzBarkLauncher._send`, from `claimRouter` and `payParkedRouter`), so the check is the exact counterpart.
   - **Guard:** none needed; `receive` writes no state and makes no call. It runs inside the launcher's `nonReentrant`
     `claimRouter` / `payParkedRouter`, after the launcher's own effects (bucket zeroed, `routerPaid` raised). It
     cannot reach `route` (no call), and `route` is itself `nonReentrant`.
   - **States:** any other sender reverts `UnexpectedSender`, so neither the vaults (they are paid by `route`) nor
     anyone else can push native through a call. Native forced in without a call (selfdestruct, block reward) is
     unchanged gen-8 behaviour: it is above every `routerPaid` delta, so no run ever routes it; it stays here (no
     withdraw by design, gen-8 4.5).
   - **Griefing:** if this splitter's `launcher` is not the real launcher (deploy error), every launcher payout to it
     reverts `SendFailed`; the money stays in the launcher's bucket and the owner re-points the router (48 h
     timelock, F3). Nothing is lost.
8. `@@ -120,11 +126,11 @@` `pending()`: reads `launcher.routerPaid(this)` instead of `hook.routerPaid(this)`; NatSpec.
   Same tuple order `(amount, bondingFees, gradFees)` (launcher audit, "routerPaid ... views").
9. `@@ -143,11 +149,11 @@` `route` NatSpec: "hook" -> "launcher", "flush" -> "parked payout". No code.
10. `@@ -156,7 +162,7 @@` `route`: the one `routerPaid` read, now on the launcher. Everything after it is gen-8's.

### route(runId, expectedPaid, recruiter, squad, airdrop, accrualRoot)

- **Guard:** `nonReentrant` (OZ storage guard), unchanged.
- **CEI (unchanged order):** checks: caller is `operator` or `admin` (`NotOperator`); `runId == runs + 1` (`BadRunId`);
  `launcher.routerPaid(this).amount == expectedPaid` (`PaidMismatch`), the only external call before the effects, a
  `view` (compiled to STATICCALL: the launcher cannot write or re-enter through it); `total > 0` (`NothingToRoute`); the
  bands and `committed <= total` (`OutOfBand`); `balance >= total` (`Underfunded`). Effects: `runs`, `routedAmount`,
  `routedBondingFees`, `routedGradFees`. Interactions: the six payouts (plain calls to the four vault addresses, the two
  `CommunityRewardsVault` deposits); any failure reverts the whole run.
- **Why `expectedPaid` still pins B, G and total (V13 argument, launcher form):** only `MwzBarkLauncher._payRouter`
  writes `routerPaid[r]`, and it raises `amount`, `bondingFees` and `gradFees` together in one step, from either
  `claimRouter` (the whole bucket with both counters) or `payParkedRouter` (the whole parked bucket with both
  counters). All three only grow. So an equal cumulative `amount` means equal B, G and total.
- **B11 (a run never reverts `OutOfBand` because of Barkswap's cut):** B and G are the launcher's net books: router
  bonding DOGE after the cut, the creator's amount and coin conversion; graduation DOGE (launcher audit, "Fee books").
  Every credit raises `routerOwed` by at least what it adds to `pendingBondingFees + pendingGradFees`
  (`_creditNative` adds router bonding + router post to the bucket and router bonding to the bonding counter;
  `takeGraduationFee` adds the burn to both), and payouts move all three together, so per run `total >= B + G`. The
  most a run can commit is `floor(3750 B / 1e4) + floor(1750 B / 1e4) + floor(2000 G / 1e4) <= 0.55 B + 0.2 G <= B + G
  <= total`, for any community fee (the cut shrinks B, G and total together; it never makes `total < B + G`). So
  `OutOfBand` can only come from operator inputs outside `[rsaMin, rsaMax]` or `squad > squadMax`, exactly as in
  gen-8. Fork test (t10): a route run at community fee 0, the live Barkswap value and 1000 (100%).
- **Realised DOGE only (spec Money flow 5):** `routerPaid` counts native the launcher has actually paid; coin fees not
  yet converted are in no router total, so `expectedPaid` never compares against a swap-time estimate.
- **States:** any time the caller is operator or admin; a splitter that is no longer the launcher's router still
  routes what it was paid (claims before the change, or the parked bucket). Fees still owed in the launcher wait for a
  claim (the operator calls `launcher.claimRouter()` first; F4 admits it through `operator()`).
- **Over/underflow:** `paid - routedAmount` (and the two counters) cannot underflow: `routedAmount` is only ever set
  to an earlier `paid`, and `paid` only grows (launcher `_payRouter` only adds, uint256). Band products are uint256 of
  router amounts far below 2^128.
- **Griefing:** unchanged from gen-8 15.4. A third party cannot claim the router bucket (F4 in the launcher), so it
  cannot move `routerPaid` between plan and route; `payParkedRouter` is permissionless but one-shot per router change
  (a stale plan reverts `PaidMismatch` once and the operator re-plans). A vault that refuses native blocks runs until
  fixed (funds wait here, gen-8 risk 4). Forced native stays here forever (no withdraw).

### Informational

- `IMwzCommunityRewardsVault` is declared in both `contracts/gen8/MwzFeeSplitter.sol` and this file (same body). The Bark
  build compiles both trees, so Hardhat's artifact name is ambiguous: tests (t10) use the fully qualified name.
- Size: 3,486 runtime bytes.

Verdict: pending (t7)

---

## MwzBarkReserveLock

**File:** `contracts/dogeos/barkswap/MwzBarkReserveLock.sol` (109 lines). **Counterpart:** `contracts/gen8/MwzReserveLock.sol`
(110 lines; gen-8 audit 4.3, 15.1, 15.10). **Diff:** `git diff --no-index contracts/gen8/MwzReserveLock.sol
contracts/dogeos/barkswap/MwzBarkReserveLock.sol` (53 insertions, 54 deletions, 2 hunks; the second hunk spans the
whole body and is explained change by change). **Imports:** OZ `IERC20`, `SafeERC20`, `ReentrancyGuard` (unchanged);
the vendored Algebra `IAlgebraPoolState`; `MwzBarkLauncher` and `MwzBarkPlugin` as types only. Written by t5.

**What changed:** the key (coin instead of V4 `PoolId`), where the latch and price come from (plugin and Algebra pool
instead of hook and PoolManager), the "not mid-transaction" check (the pool's own lock instead of the PoolManager's),
the price direction (Barkswap orientation), and the wiring (one constructor argument). The four release conditions,
their order, the 1 h constant, the one-step payout, the CEI order and the "no owner, no rescue" property are gen-8's.

### Diff hunks

1. `@@ -1,35 +1,33 @@` imports, choice-vault interface, NatSpec, contract name, `using` lines.
   - The V4 imports (`PoolId`, `IPoolManager`, `StateLibrary`, `TransientStateLibrary`, `IMwzLaunchHook`) and the two
     `using ... for IPoolManager` lines go. New: `IAlgebraPoolState` (for `globalState()`), `MwzBarkLauncher` and
     `MwzBarkPlugin` as types (the compiler checks the 10-field `launches(coin)` and 9-field `pools(pool)` tuples, so a
     getter drift breaks the build).
   - `IMwzChoiceVaultCreator.creatorOf(PoolId)` becomes `IMwzBarkChoiceVaultCreator.creatorOf(address coin)`: the Bark
     choice vault is keyed by coin (`registerCoin(coin, creator, choice, pct)`, launcher t32). **Obligation on t6:**
     `MwzBarkCreatorChoiceVault` exposes `creatorOf(address coin) view returns (address)`, non-zero for every coin it
     registered. Renamed so the two interfaces (different ABIs) do not share an artifact name.
   - NatSpec: the four conditions restated for the venue (condition 2 rewritten, below). Gen-8's sentence "whoever
     wants the reserve out must keep the coin at or past its graduation price for an hour, i.e. hold A's whole raise
     in the market for that long" is dropped because it overstates what the delay enforces (see "Griefing", F1
     residual); nothing else in the rule changed. Beneficiary wording: the launcher's `feeCreator` (current, after a
     two-step transfer) instead of the hook creator.
2. `@@ -39,72 +37,73 @@` body:
   - **Error** `PoolManagerUnlocked` -> `PoolBusy` (the launcher's name for the same condition on an Algebra pool). Same
     position in the check order.
   - **Comment** "hook's graduation latch" -> "plugin's graduation latch".
   - **`Reserve` struct** unchanged; `token` is now always the coin itself. It is kept (instead of a bare amount) for
     two reasons: the public getter keeps gen-8's shape `reserves(key) -> (token, amount)` for the off-chain reader
     (`evmGen8CampaignState.js` reads it; the Bark venue changes only the key type), and `token != 0` stays the
     "locked once, ever" marker (`amount` goes to 0 at release, `token` never does), so `AlreadyLocked` keeps its gen-8
     meaning. Still one storage slot (20 + 12 bytes).
   - **Immutables:** `hook`, `launcher` (address), `choiceVault`, `poolManager` become one `MwzBarkLauncher public
     immutable launcher` (getter `launcher()` returns `address`, which the launcher's constructor checks:
     `reserveLock_.launcher() == address(this)`). The plugin and the choice vault are **read from the launcher at
     release** (`launcher.plugin()`, `launcher.choiceVault()`, both launcher immutables) instead of being copied in at
     construction. Reason: the launcher's constructor checks its plugin and choice vault against each other and checks
     this lock's `launcher()`, but nothing would check copies held here, so a deploy with a stale plugin or vault
     address would compile, deploy and then mis-read the latch or pay the vault instead of the human creator. Reading
     the launcher's own immutables removes that failure mode; the cost is two view calls (about 5k gas) per release,
     once per coin.
   - **Mapping** `mapping(PoolId => Reserve)` -> `mapping(address coin => Reserve)`. One pool per coin
     (`launches[coin].pool`, `coinOf[pool]`), so the coin key is a bijection with gen-8's pool key.
   - **Events** `ReserveLocked(PoolId indexed id, address indexed token, uint256 amount)` -> `ReserveLocked(address
     indexed coin, uint256 amount)`; `ReserveReleased(PoolId indexed id, address indexed token, address indexed to,
     uint256 amount)` -> `ReserveReleased(address indexed coin, address indexed to, uint256 amount)`. Gen-8's id and token
     collapse into the coin. New topic0s (t18 indexes them for 6281971).
   - **Constructor** `(IMwzLaunchHook hook_, address launcher_, IMwzChoiceVaultCreator choiceVault_)` ->
     `(MwzBarkLauncher launcher_)`: zero check, store. No call at construction (the lock is deployed before the
     launcher, against its predicted address; gen-8 called `hook_.poolManager()`, the hook existing already).
   - **`lock`**: see its entry below.
   - **`beneficiaryOf`**, **`release`**: see their entries below.

### lock(coin, amount)

- Interface fixed by the launcher (t32): `IMwzBarkReserveLockForLauncher.lock(address coin, uint256 amount)`, called in
  `MwzBarkLauncher._seed` right after `IERC20(coin).safeTransfer(address(reserveLock), CREATOR_RESERVE)`. Gen-8's
  `lock(PoolId id, address token, uint256 amount)` lost the separate token argument: the key is the token.
- **Guard:** none (gen-8 same). Only the launcher can call it, inside its own `nonReentrant` `launch`; the only external
  call is `balanceOf` on the brand-new coin (our plain `MwzV4Token`, a view).
- **CEI:** checks in gen-8's order: caller (`OnlyLauncher`), not locked before (`AlreadyLocked`), coin non-zero
  (`ZeroAddress`), `0 < amount <= type(uint96).max` (`BadAmount`), `balanceOf(this) >= amount` (`NotFunded`); effect: one
  slot; event.
- **States:** once per coin, ever (`token` marker). The coin is deployed in the same transaction, so nobody else can have
  sent it here; the balance is exactly the 20M the launcher just transferred.
- **Over/underflow:** the `uint96` cast follows the bound check (2e25 < 2^96).
- **Griefing:** none; launch gas cost is gen-8's (one fresh slot, one view call, one event with one topic less).

### beneficiaryOf(coin) (view)

- `launcher.launches(coin).feeCreator`; if that is the launcher's choice vault, `choiceVault.creatorOf(coin)`. So the
  reserve follows the current fee creator: after `proposeCreator` / `acceptCreator` the new address gets it (controller
  note: "pays the CURRENT creator"). For holders / split / buyback coins the human creator recorded in the vault gets
  it, as gen-8. An unknown coin returns address(0).

### release(coin)

- **The four conditions (spec section 3 row and Invariants), in gen-8's order:**
  1. **Latched:** `plugin.pools(pool).graduated`, the plugin's latch (I7: set once in `afterSwap` of the first swap
     that leaves the price at or past `sqrtGrad`, never cleared). Gen-8 read the hook's latch. `NotGraduated`.
  2. **Pool not mid-operation:** `IAlgebraPoolState(pool).globalState().unlocked`, the pool's own reentrancy lock,
     instead of V4's `PoolManager.isUnlocked()` (spec "Audit scope note"). In Algebra every state-changing pool
     operation (swap, mint, burn, flash; our launcher's collects and graduation burn included) holds this lock while
     tokens are in flight, and the swap / mint / flash callbacks run while it is held; a price read there is not
     settled (the swap writes the new price before the callback pays for it). With the lock free, `globalState().price`
     is a settled price. Algebra releases the lock before `afterSwap` (plugin audit, facts), so a call from a plugin's
     `afterSwap` sees the settled post-swap price, the same as a call right after the swap. Difference from V4: V4's
     flag is global (no release inside any unlock of any pool); Algebra's is per pool, so a release can run inside a
     callback of another pool (for example a flash loan from another Algebra pool). That adds no capability: in V4 the
     same sequence was always possible from outside the PoolManager with outside capital. `PoolBusy`; fork-checked in
     t10 (a release from inside our pool's swap callback reverts `PoolBusy`).
  3. **Price at or past graduation now:** Barkswap orientation, coin = token0 and the price is WDOGE per coin, rising on
     buys: `sqrtP >= sqrtGrad`, else `PriceBelowGraduation` (gen-8 V4 orientation was `sqrtP <= sqrtGrad`). Exactly the
     comparison of the plugin's latch and phase (`price >= sqrtGrad`) and of the launcher's `takeGraduationFee`.
     `sqrtGrad` is the plugin's stored `getSqrtPriceAtTick(tickGrad)`.
  4. **At least 1 h since the latch:** `block.timestamp >= graduatedAt + RESERVE_RELEASE_DELAY`, `graduatedAt` the
     plugin's (I17: written with the latch, never again). Unchanged. `ReserveTooEarly`.
  Then the beneficiary must be non-zero (`ZeroAddress`).
- **Guard:** `nonReentrant` (OZ storage guard), unchanged.
- **CEI:** checks: `amount > 0` (`NothingLocked`), then the reads `launcher.launches`, `launcher.plugin`,
  `plugin.pools`, `pool.globalState`, and inside `beneficiaryOf` `launcher.launches`, `launcher.choiceVault`,
  `choiceVault.creatorOf`. All are `view` calls, compiled to STATICCALL: no callee can write state or re-enter with a
  state change. Effect: `amount = 0`. Interaction: `safeTransfer` of our plain ERC20 (no hooks) as the last call, then
  the event (gen-8 order).
- **States:** a locked coin, once (afterwards `NothingLocked`). A coin that never graduates keeps its reserve forever
  (gen-7 / gen-8 same; no owner, no rescue). Barkswap admin powers: a foreign plugin swapped in cannot set our latch or
  `graduatedAt` (they live in our plugin's storage); while it is installed our plugin sees no swaps, so the latch can
  only be set after `restore`. The price is the pool's own state whatever the plugin. The community fee and tick
  spacing play no part. Launch pause: irrelevant (release reads only).
- **Over/underflow:** `graduatedAt + 1 hours` in uint256 (`uint40` time); `amount` is uint96.
- **Griefing:**
  - Delaying a legitimate release: only by holding the price below graduation at the moment of the call (selling into
    A at the post rate and holding the coins); the clock cannot be reset (gen-8 15.10, unchanged).
  - `PoolBusy` can only be hit from inside a callback of our pool, i.e. inside the caller's own transaction.
  - **F1 residual (gen-8 parity; Informational for t7):** the 1 h delay stops the same-block bundle "buy to the
    graduation price, release, sell back" (the release runs in the latch block and reverts). It does not require the
    price to stay at graduation for the hour: a forced latch at T (buy to graduation and sell back) followed at T + 1 h
    by a second bundle (buy to graduation, release, sell back, both legs possibly funded by a flash loan from another
    pool) releases the reserve. Who gains: only the creator (the reserve goes nowhere else), early. Cost: two round
    trips through all of A at the bonding rate up and the post rate down, plus the 2% graduation burn out of A; all
    fees go to our books. Gen-8 has the same residual (its bundle runs outside the PoolManager's unlock with outside
    capital), which is why the NatSpec sentence was dropped rather than the rule changed. No code change proposed.
  - A choice vault that returns address(0) for a coin it registered would block that release (`ZeroAddress`); the vault
    is our own contract (t6 obligation above).

### Informational

- Size: 2,607 runtime bytes (gen-8: 2,640).
- The reserve lock does not check that the pool still runs our plugin before reading the price: the latch and
  `graduatedAt` come from our plugin's storage, and the price from the pool, neither of which a foreign plugin can
  forge.

Verdict: pending (t7)

---

## MwzBarkLaunchLens

**File:** `contracts/dogeos/barkswap/MwzBarkLaunchLens.sol` (159 lines). **Counterpart:** `contracts/gen8/MwzLaunchLens.sol`
(94 lines; gen-8 audit 4.7, V4, 15.10). **Diff:** `git diff --no-index contracts/gen8/MwzLaunchLens.sol
contracts/dogeos/barkswap/MwzBarkLaunchLens.sol` (129 insertions, 64 deletions; git reports one hunk over the whole
file, explained function by function). **Imports:** v4-core `TickMath` and `SqrtPriceMath` (internal libraries,
unchanged), gen-8 `MwzFeeMath` (unchanged, the plugin's fee math); the vendored Algebra `IAlgebraPool`;
`MwzBarkLauncher` and `MwzBarkPlugin` as types. No linked library (gen-8 linked `MwzSwapSim`). Written by t5.

**Money-path status:** none. The lens is stateless, holds no funds, has no owner, and no contract of ours calls it.
Every function is `view` or `pure`; reentrancy guards, CEI and griefing do not apply beyond the read-only notes below.

### Diff, change by change

- **Imports / using:** `IPoolManager`, `StateLibrary`, `PoolId`, `FeeConfig` / `IMwzLaunchHook` and `MwzSwapSim` go;
  `IAlgebraPool`, `MwzBarkLauncher`, `MwzBarkPlugin` come in; `MwzFeeMath` is imported from its vendored gen-8 path.
- **Title / NatSpec:** reads the launcher, the plugin and the pool; keyed by coin; quotes come from Barkswap's QuoterV2
  (below); Barkswap orientation stated once.
- **Error** `UnknownPool` -> `UnknownCoin` (the key is a coin; the launcher uses the same name). An unknown coin is
  `launches(coin).pool == 0`.
- **Immutables:** `hook`, `poolManager`, `launcher` -> `launcher` and `plugin`. The constructor takes the launcher and
  reads `launcher.plugin()` (the lens is deployed after the launcher, as gen-8's after the hook; no wiring to get wrong).
- **`Progress`:** same fields, same order; comments say WDOGE. The off-chain decoder's tuple is unchanged; only the key
  type of `progress()` changes.
- **`currentFeeBps(coin, sender)`:** key coin; `openAt` from `launches(coin)` (the launcher passes the same `openAt` to
  `plugin.registerPool`, so it equals the plugin's); `sqrtGrad` from `plugin.pools(pool)`; the price from
  `globalState()`; the phase test `sqrtP >= sqrtGrad` (Barkswap orientation; gen-8 `<=`); the rates from
  `plugin.feeConfig()` (the plugin's fixed constants; gen-8 had per-pool `FeeConfig`). This is the plugin's own
  `beforeSwap` computation (`MwzFeeMath.rate(feeConfig(), price >= sqrtGrad, isLauncher, openAt, now)`) with the same
  inputs, so the quote equals what the plugin sets. Two documented exceptions: the launcher's conversion pays 0 (the
  lens returns the launcher's first-buy rate for `sender == launcher`, gen-8 same), and if a Barkswap admin removed our
  plugin or the dynamic-fee flag the pool charges `lastFee` (0) instead; `poolState(coin).launchSettings` shows that.
  The rate is in gen-7 bps of the curve amount; `plugin.algebraFee(rate, buy)` converts it to the pool's input-side
  fee units.
- **`tradingOpen(coin)`:** key change only.
- **`previewFill` and `grossForNet` removed.** `previewFill` replayed V4 swaps over the PoolManager's tick bitmap
  (`MwzSwapSim`, V4 `StateLibrary` reads); there is no Algebra counterpart, and writing one would add a new swap
  simulator to the audit that could only approximate the pool's per-step fee and rounding. Barkswap's QuoterV2
  (bytecode-identical to upstream, facts section 1) runs the real pool and plugin code inside a reverted call and takes
  a price limit, so its quotes are exact by construction (fork-checked for our custom pools, deployer = launcher, in
  t10 / t22). `grossForNet` encoded gen-7's output-side sell fee (taken from the payout); the plugin charges sells on
  the input (coin side), so it would misquote a Bark sell. The gen-8 V4 lens is untouched; the Bark venue (t17 / t22)
  uses this lens's own ABI (address keys) and the quoter for amounts.
- **`progress(coin)`:** the gen-8 formulas mirrored into Barkswap orientation (coin = token0, A = [sqrtStart, sqrtGrad]
  with sqrtStart < sqrtGrad, coins at the start price, WDOGE at or past graduation):
  - `coinsInA = getAmount0Delta(sqrtStart, sqrtGrad, liqA, roundUp)` (gen-8 `getAmount1Delta`, the coin was token1);
    `nativeTargetA = getAmount1Delta(sqrtStart, sqrtGrad, liqA, down)`.
  - Nothing sold while `sqrtP <= sqrtStart` (gen-8 `>=`); F2 keeps the price from going below.
  - `hi = min(sqrtP, sqrtGrad)` (gen-8 `lo = max`); `coinsSoldFromA = coinsInA - getAmount0Delta(hi, sqrtGrad, liqA,
    down)`; `nativeInA = getAmount1Delta(sqrtStart, hi, liqNow, down)`.
  - `liqNow` is reduced by `floor(liqA x 200 / 10,000)` (the same expression as `MwzBarkLauncher.takeGraduationFee`,
    `GRAD_FEE_BPS / BPS`) when the launcher's **`gradFeeTaken`** is set, where gen-8 used the hook's `graduated`. Gen-8
    burned inside the latching swap, so the two were the same; here the burn runs in the launcher (inline from the
    latching swap, or later through the permissionless fallback), and between a latch and a delayed fallback A still
    holds `liqA`.
  - Over/underflow: `coinsInA` (rounded up over the whole range) is at least `getAmount0Delta` over the sub-range
    `[hi, sqrtGrad]` rounded down, so the subtraction cannot underflow; `liqA - floor(liqA x 2%)` is non-negative.
    `SqrtPriceMath` (v4) and Algebra's `TokenDeltaMath` compute the same formulas; any difference is rounding of at
    most 1 unit (informational value; t10 compares against the pool).
- **New `poolState(coin)`** (controller note: "reads the Algebra pool (globalState price/tick, liquidity)"): the pool's
  `globalState()` fields, `liquidity()`, and `launchSettings = plugin() == our plugin && lastFee == 0 && pluginConfig ==
  135`, i.e. exactly what `MwzBarkLauncher.restore` re-applies. False means a Barkswap admin changed the pool and the
  keeper calls `restore` (spec section 4, admin-change watch).
- **New `owed(coin)`** (spec row: "owed amounts"): `feeCreator`, `pendingCreator`, `creatorOwed` (claimable native);
  the four pending coin books (`coinFees`); the uncollected estimate per book, `plugin.feeTotals(pool)` minus
  `launcher.collectedTotals(coin)`, in WDOGE and in coins; `lastConvertAt`; `nextConvertAt = max(openAt + 60 s,
  lastConvertAt + CONVERT_INTERVAL)` (the two time checks of `convert`; the price and pending checks are not
  predicted); `gradFeeTaken`, `graduationFee`. Book order is the launcher's (`MwzBarkFeeBooks`: creator bonding, router
  bonding, creator post, router post), as in `FeesCollected` / `CoinFeesConverted`. Router amounts are pooled across
  coins in the launcher (`routerOwed`, `routerPaid`) and are read there.
  - Over/underflow: each uncollected difference is a uint128 subtraction of the launcher's snapshot from the plugin's
    current total. The plugin's totals only grow (`_book` only adds) and `collect` sets the snapshot to the totals it
    read, so the snapshot is never above the current total; checked arithmetic would revert rather than mis-report.
  - The uncollected figure is the plugin's estimate (within its stated rounding tolerance) and excludes unbooked
    surplus (flash fees, donations), which `collect` puts into router post.

### Read-only notes

- A lens read made from inside a callback of the pool sees an unsettled price (Algebra's own note on its state views);
  `poolState().unlocked` exposes the pool's lock. No contract of ours reads the lens, so this matters only to
  integrators, who must not base on-chain money decisions on it.
- No loops; every function is a bounded number of view calls.

### Informational

- Size: 7,304 runtime bytes (gen-8: 4,114 plus the linked `MwzSwapSim`).

### Hand-off from t5

- t6: `MwzBarkCreatorChoiceVault.creatorOf(address coin) view returns (address)`, non-zero for every registered coin
  (the reserve lock pays it).
- t15: deploy order plugin, reserve lock (`MwzBarkReserveLock(launcher)`), choice vault, fee splitter
  (`MwzBarkFeeSplitter(launcher, admin, weekly, monthly, recruiter, community, protocol, operator)`), all against the
  launcher's predicted address and with no call to it at construction; then the launcher (it checks the plugin, the
  reserve lock and the choice vault; it does not check the splitter, so the script asserts `splitter.launcher() ==
  launcher`); then `MwzBarkLaunchLens(launcher)` (no library to link).
- t10: the splitter's B11 run at community fee 0 / live / 1000; `receive` refusing any sender but the launcher; the
  reserve lock's four conditions (incl. `PoolBusy` from inside our pool's swap callback, +59 / +60 min, price fallen
  back, beneficiary after `acceptCreator` and for a choice-vault coin); the lens against the pool (progress within 1
  unit, `currentFeeBps` equal to the rate in the `BarkSwap` event, `owed` equal to the books after collect / convert,
  `launchSettings` false after an admin `setPluginConfig` and true after `restore`); QuoterV2 quoting our custom pool.
- t17 / t18 / t22: splitter getter `launcher()` instead of `hook()`; reserve lock keyed by coin, `reserves(coin) ->
  (token, amount)`, events `ReserveLocked(address,uint256)` and `ReserveReleased(address,address,uint256)`; lens keyed by
  coin, no `previewFill` / `grossForNet` (amounts from QuoterV2), new `poolState` and `owed`.

Verdict: pending (t7)

# EVM launch generation 8: coins launch into a Uniswap V4 pool with our hook (BNB 56, Robinhood 4663)

Status 2026-10-11: design for founder approval, then for the external audit and the build. Nothing here is
deployed or built for production. The research contracts are proven on local forks only.

Every point carries one of two markers:

- **[Decided]**: a founder decision of 2026-10-10/11 or a fact measured in the proof. Do not reopen without the founder.
- **[Open]**: needs a founder decision. Each one is numbered in section 10 with a recommendation.

Evidence used (all read-only):

| Source | What it proves |
|---|---|
| `scripts/research/v4-hook/` on `research/v4-hook-fork-proof` (commits `d9b7606b`, `68cd72d1`) | Hook v2, launcher, token, display pair. 702/702 checks on BSC 56 and Robinhood 4663 forks, $30K and $50K targets (`results/v4-hook-proof.log`, `results/v4-hook-proof-bsc-rh.json`). The v2 commit is `68cd72d1` in this worktree (the memory note calls it `6eafe6b9`; same content, rebased hash). |
| `~/mwz-wt/evm-gen7` (`build/evm-gen7`) | Gen-7 as built and live since 2026-10-09/10: `contracts/gen7/*`, `TreasuryRouterV4.sol`, `CreatorRewardsVaultV2.sol`, `PermanentLpLocker.sol`, `PermanentV3PositionLocker.sol`, `docs/evm-launch/EVM_GEN7_V2_PLAN.md`. |
| `origin/build/cross-chain-stabilization-rh-base` | Live app, API and indexer (route authorization, route profiles, EVM ingestion, Solana DBC fee pipeline). |
| `~/mwz-wt/v3-2pct` (`research/v3-2pct-fork-proof`, `fa80c7b6`) | DogeOS V3 2%-tier research (appendix A). |

Words used throughout:

- **Native**: BNB on BNB Chain, ETH on Robinhood Chain.
- **Hook**: a contract Uniswap V4 calls before and after every swap in a pool that names it. Ours takes the fee and holds the liquidity.
- **PoolManager**: the one Uniswap V4 contract per chain that holds every V4 pool's money.
- **Bps**: basis points, 100 bps = 1%.
- **Position A / B**: two blocks of coins placed in the pool at launch, each covering a fixed price range (section 2.2).
- **Router bucket**: the hook's running total of MemeWarzone's fees, paid out in one transfer to our TreasuryRouter.
- **Side pool**: any other pool for one of our coins that does not use our hook (we cannot prevent these).

---

## 1. Summary for the founder

**What changes**

| | Gen-7 (live) | Gen-8 (this design) |
|---|---|---|
| Who can trade | Only through our site: every buy and sell needs a signature from our API | Anyone, any wallet, bot, aggregator or router, from the first block. No signature. [Decided] |
| Where the coin trades before graduation | Our own curve contract (`LaunchCampaignGen7`) | A real Uniswap V4 pool (native vs coin) that our hook controls. The price path is the gen-7 curve to within 0.03%. [Decided, proven] |
| Discovery | Not visible to DexScreener, GeckoTerminal, GMGN, aggregators until graduation, and on BNB not even after (Topaz V2 is not indexed) | Robinhood: indexed as a V4 pool from launch (DexScreener and GeckoTerminal index V4 hook pools there). BNB: GeckoTerminal indexes V4 hook pools; DexScreener does not index V4 on BSC, so we add a display-only V2-style pair per coin (section 7). [Decided] |
| Graduation | A keeper calls `graduate()`: moves money into a Topaz V2 (BNB) or Uniswap V3 (Robinhood) pool, LP locked in a separate locker | Happens inside the swap that crosses the threshold. No migration, no keeper, no second pool: the same pool keeps trading. [Decided, proven] |
| Fee after graduation | 0.30% LP fee in the DEX pool: creator 0.24% of volume, MemeWarzone 0.06%. Trades through our app additionally pay the 1% import route fee | 1% on every trade anywhere: creator exactly 0.50% of volume, MemeWarzone 0.50%. [Decided] |
| Fee currency | Native on the curve; both tokens in the graduated pool (sold to native by the harvest crank) | Native only, always. MemeWarzone never receives coins. [Decided, proven] |
| Creator payout | Vault balance, claimed by the creator wallet | A per-coin balance in the hook, claimed by the creator to any address; the creator can hand the right to another wallet in two steps. MemeWarzone has no power over it. [Decided, proven] |
| How the 2% is split (league, recruiter, airdrop, squad, creator, protocol) | Per trade, on chain, from the signed route profile | The hook pays one pooled bucket; the split is computed per trade from on-chain events and paid in batches. This is the main open design question (section 3.4). [Open, D1] |

**What stays the same** [Decided]

- 1B supply: 85% in the bonding range, 13% above graduation, 2% creator reserve.
- Graduation market cap $30K or $50K, sized from the gen-7 oracle once at launch.
- 2% fee on buys (on top of the curve cost) and on sells (out of the payout), the gen-7 definition to the wei.
- Launch anti-sniper fee 90% falling linearly to 2% over 60 seconds, for every caller. The creator's first buy pays 2%.
- One-time 2% graduation fee (2% of the native raised in A).
- Creator first buy up to 70% of supply, in the launch transaction.
- Liquidity is locked forever. Here the hook itself is the locker: no function exists that removes A or B, except the one-time 2% graduation fee.
- Leagues, recruiters, airdrops, battles, MWL keep their rules. Their inputs come from different events (section 5).

**MemeWarzone income per coin (same as gen-7 before graduation, higher after)**

| Stage | Gen-7 | Gen-8 |
|---|---|---|
| Bonding fee | 2% of volume, ~41.9% of it to protocol after league/recruiter/creator shares | 2% of volume, same split if D1 keeps it |
| Graduation fee | 2% of the raise, 82.5% protocol after recruiter/airdrop/squad | 2% of A's raise, same |
| After graduation, trades outside our app | 0.06% of volume | 0.50% of volume |
| After graduation, trades in our app | 0.06% LP + import route share (1% minus creator 0.50% and partner 0.25%) | 0.50% (no import fee on top, see D9) |

Worked dollar figures: section 3.

**The main costs and risks**

- **Gas.** Each swap costs about 34,000 to 56,000 more gas than a hookless V4 swap (BSC +55-56k including the display pair, Robinhood +34-46k). Launch costs 1.67M gas on BSC and 1.10M on Robinhood. Both are measured.
- **Side pools.** Anyone can open a hookless pool for our coin on any DEX and trade there without our fee. Every launchpad has this problem. We watch for them and alert (section 6.8).
- **No upgrade.** The hook is immutable. A bug fix means a new hook and a new generation. That is why the external audit comes before mainnet (section 8).
- **Recruiter attribution** can no longer be decided per trade on chain. Section 3.4 recommends doing it the way Solana DBC already does.

---

## 2. Contracts

Research files: `scripts/research/v4-hook/contracts/`. Production files will live in `contracts/gen8/` (proposed).
All contracts: Solidity 0.8.26 (transient storage needs >= 0.8.24 and Cancun), no proxy, no upgrade.

### 2.1 Uniswap V4 infrastructure we rely on [Decided, verified on the forks]

| | BNB Chain 56 | Robinhood 4663 |
|---|---|---|
| PoolManager | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x7a4a5c919ae2541aed11041a1aeee68f1287f95b` | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| V4Quoter | `0x9f75dd27d6664c475b90e105573e550ff69437b0` | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4` | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| UniversalRouter | docs main `0x1906c1d6…` (V4_SWAP params layout v2.0), 2.1.1 `0x8b844f88…` and 2.1.2 `0xDc264714…` (layout v2.1) | docs main `0x88767899…`, 2.1.2 `0x204FAca1…` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| Gen-7 GraduationOracle (reused) | `0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B` | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` |

Facts from the proof: the UniversalRouter versions encode `ExactInputSingleParams` differently (v2.0 vs v2.1); the
app must pick one router per chain and encode for it. `V4Quoter.QuoteExactSingleParams` has no price limit field, so
price-limited partial fills are quoted with `hook.previewFill` (2.3).

### 2.2 Pool and price path [Decided, proven]

- Pool key: `currency0 = address(0)` (native), `currency1 = coin`, `fee = DYNAMIC_FEE_FLAG`, `tickSpacing = 10`,
  `hooks = MwzLaunchHook`. The LP fee is never set, so it stays 0 forever. V4 prices are coin per native, so buying
  the coin moves the price (and tick) down.
- **Position A**: 850M coins, one-sided, from the gen-7 start price (`tickStart`) to the gen-7 graduation price
  (`tickGrad`). It is exactly the gen-7 constant-product curve: same virtual reserves `vN`, `vT` from
  `LaunchFactoryGen7.curveForMarketCap`, ticks rounded to the nearest multiple of 10.
- **Position B**: 130M coins, one-sided, from `tickGrad` to the minimum usable tick (all higher coin prices).
- **Creator reserve**: 20M coins.
- Measured against gen-7: start market cap within 142 ppm, market cap at 10-99% of A within 277 ppm, native raised in A
  within 288 ppm of gen-7's `R`, top-of-A market cap within 300 ppm. All differences come from tick rounding.

| Target | Chain (oracle price at fork) | Graduation MC | Start MC | Native raised in A | Graduation fee (2%) |
|---|---|---|---|---|---|
| $30K | BNB ($748.84) | 40.0616 BNB | 0.9756 BNB (~$731) | 5.3132 BNB (~$3,979) | 0.10626 BNB (~$79.6) |
| $50K | BNB ($748.77) | 66.7753 BNB | 1.6263 BNB (~$1,218) | 8.8566 BNB (~$6,632) | 0.17713 BNB (~$132.6) |
| $30K | Robinhood ($2,501.69) | 11.9919 ETH | 0.2920 ETH (~$731) | 1.5908 ETH (~$3,980) | 0.031816 ETH (~$79.6) |
| $50K | Robinhood | 19.9865 ETH | 0.4867 ETH (~$1,218) | 2.6518 ETH (~$6,634) | 0.053035 ETH (~$132.7) |

### 2.3 `MwzLaunchHook` (research: `MwzLaunchHook.sol`, 706 lines, runtime 23,465 bytes)

**Hook permissions** (address flags `0x28EC`, mined with CREATE2): `beforeInitialize`, `beforeAddLiquidity`,
`beforeSwap`, `afterSwap`, `beforeDonate`, `beforeSwapReturnDelta`, `afterSwapReturnDelta`. All other callbacks
revert `HookNotImplemented`.

**Immutables**: `poolManager`, `launcher`, `displayFactory` (`address(0)` on Robinhood).

**Constants**

| Name | Value | Meaning |
|---|---|---|
| `MAX_BONDING_FEE_BPS` | 200 | cap on a coin's bonding rate |
| `MAX_POST_FEE_BPS` | 100 | cap on a coin's post-graduation rate |
| `MAX_SNIPER_START_BPS` | 9000 | cap on the launch rate |
| `SNIPER_WINDOW` | 60 s | anti-sniper decay length |
| `GRAD_FEE_BPS` | 200 | one-time share of A's liquidity removed at graduation |
| `ROUTER_TIMELOCK` | 48 h | delay on changing the TreasuryRouter |
| `DISPLAY_GAS` | 60,000 | hard gas cap for the display pair call |
| `TICK_SPACING` | 10 | |

**State**

| Variable | Type | Written by |
|---|---|---|
| `pools[id]` | `PoolState {creator, launchTime (uint40), graduated, tickGrad, tickStart, liqA, liqB, sqrtGrad, fees}` | `createPool` (once), `acceptCreator` (creator only), `_graduate` (latch) |
| `fees` | `FeeConfig {bondingBps <= 200, postBps <= 100, creatorPostBps <= postBps, sniperStartBps in [bondingBps, 9000]}` | `createPool` only. Never changed. |
| `pendingCreator[id]` | address | `proposeCreator` |
| `creatorOwed[id]` | uint256 native wei | `_accrue` (+), `claimCreator` (to 0) |
| `routerOwed` | uint256 native wei | `_accrue`, `_graduate` (+), `claimRouter` (to 0) |
| `displayPair[id]` | address | `createPool` (BNB only) |
| `owner`, `pendingOwner` | address | two-step ownership (the Safe) |
| `treasuryRouter`, `pendingRouter`, `routerEta` | | 48 h timelock |
| transient `T_RATE`, `T_EXPECT`, `T_FEE` | | `beforeSwap` -> `afterSwap` hand-over within one swap |

**Functions**

| Function | Who | Effect |
|---|---|---|
| `createPool(token, creator, tickStart, tickGrad, coinsA, coinsB, fees)` | launcher only | Checks caps and ticks, stores state, `initialize`s the pool (the hook's own call skips `beforeInitialize`), mints A and B through `unlock`, burns seed dust to `0xdEaD`, creates and seeds the display pair (BNB). Emits `PoolLaunched`. |
| `beforeInitialize` | PoolManager | Always reverts `OnlyThisHookMayInitialize`: nobody else can create a pool with our hook, so a launch cannot be front-run. |
| `beforeAddLiquidity` | PoolManager | Always reverts `LiquidityIsLocked`. Outside liquidity is impossible. |
| `beforeDonate` | PoolManager | Always reverts `DonateDisabled`. |
| `beforeSwap` | PoolManager | Reads the rate. For exact-input buys and exact-output sells (fee in the specified currency) it computes the fee up front, simulates the swap if a price limit is set, takes the fee via `BeforeSwapDelta`, and accrues it. |
| `afterSwap` | PoolManager | For exact-output buys and exact-input sells (fee in the unspecified currency) it computes the fee from the actual amounts and takes it via the return delta. Checks the simulation was exact (`PartialFill` revert as a safety net). Runs the graduation latch. Updates the display pair. |
| `previewFill(id, zeroForOne, amountSpecified, limit)` | view | Exact fill of a price-limited swap, for quotes. |
| `currentFeeBps(id, sender)` | view | The rate this caller pays now. |
| `claimCreator(id, to)` | the coin's creator | Pays the whole `creatorOwed[id]` to `to`. `nonReentrant`, zeroes before paying. |
| `proposeCreator(id, next)` / `acceptCreator(id)` | creator / proposed address | Two-step hand-over of the creator right. `address(0)` cancels. |
| `claimRouter()` | anyone | Pays the whole `routerOwed` to the current `treasuryRouter`. |
| `proposeTreasuryRouter` / `cancelTreasuryRouter` / `executeTreasuryRouter` | owner | Changes where the router bucket is paid, 48 h after proposing. |
| `transferOwnership` / `acceptOwnership` | owner / pending owner | Two-step. |
| `unlockCallback` | PoolManager (only reachable through the hook's own `unlock`) | `ACTION_SEED` (mint A and B at launch) and `ACTION_PAYOUT` (burn ERC6909 claim, `take` native to the payee). |

**The owner cannot**: change any rate, any creator, any creator balance, any liquidity, or pause trading. The proof
enumerates the external functions and checks none can do it (`no function exists that changes rates, liquidity or
creator balances for the owner`).

**Events**: `PoolLaunched(id, token, creator, tickStart, tickGrad, liqA, liqB, fees, display)`,
`HookFee(id, swapSender, referrer, buy, curveAmount, fee, feeBps, creatorShare)`,
`Graduated(id, gradFeeNative, nativeInA, liquidityRemoved)`, `CreatorClaimed`, `CreatorProposed`,
`CreatorTransferred`, `RouterClaimed`, `RouterProposed`, `RouterChanged`, `RouterProposalCancelled`,
`OwnershipTransferStarted`, `OwnershipTransferred`, `DisplayUpdateFailed(id)`.

**How money is held**: every fee is minted to the hook as an ERC6909 claim on native inside the PoolManager
(`poolManager.mint(hook, 0, fee)`). Native never sits in the hook between swaps. Payouts burn the claim and `take`
native to the payee.

#### Fee rules (gen-7 definition) [Decided, proven exact]

`rate` = the coin's `postBps` once graduated; otherwise `bondingBps` for the launcher's own swap (the creator's first
buy inside the launch transaction); otherwise
`bondingBps + (sniperStartBps - bondingBps) * secondsLeft / 60` during the first 60 s, then `bondingBps`.

| Swap type | Curve amount | Fee | Trader pays / gets |
|---|---|---|---|
| Buy, exact input `g` | `cost = floor(g * 10000 / (10000 + rate))` | `g - cost` (gen-7 `floor(cost*rate/10000)` plus 0-2 wei rounding, measured max 1 wei over 40 sizes) | pays `g` |
| Buy, exact output | actual cost | `floor(cost * rate / 10000)` | pays `cost + fee` |
| Sell, exact input | actual payout | `floor(payout * rate / 10000)` | gets `payout - fee` |
| Sell, exact output `net` | smallest `gross` with `gross - floor(gross*rate/10000) == net` | `gross - net` | gets `net` |

Partial fills: if a buy (exact input) or sell (exact output) carries a price limit, `beforeSwap` replays
`Pool.swap` step by step on the live pool (only three ticks can ever be initialized: min tick, `tickGrad`,
`tickStart`), and charges `floor(filled * rate / 10000)` on the part that fills. Proven for limits inside A, inside
B, across the A/B boundary, exactly at the boundary, with a 0.1% Uniswap protocol fee forced on.

Post-graduation split: `creatorShare = floor(curveAmount * creatorPostBps / 10000)` (capped at the fee) goes to
`creatorOwed[id]`; the rest of the fee goes to `routerOwed`. With 100 / 50 bps the creator gets exactly 0.50% of
native volume. During bonding the whole fee goes to `routerOwed` in the research hook (see D2 for the creator's
bonding share).

#### Graduation latch [Decided, proven]

In `afterSwap`, if not yet graduated and the pool price is at or below `sqrtGrad` (A fully bought):

1. `graduated = true` (never reset).
2. Remove `floor(liqA * 2%)` liquidity from A. A is entirely native at that price, so this returns only native:
   exactly 2% of A's native raise (proven within 2 wei of `floor(2% of raise)`).
3. Mint that native as a claim to `routerOwed`. Emit `Graduated`.

The crossing swap itself pays the bonding rate on its whole amount (the rate is fixed in `beforeSwap`). From the next
swap on, the post-graduation rate applies, also if the price falls back into A. Re-crossing never graduates again.

### 2.4 `MwzV4Launcher` (research: `MwzV4Launcher.sol`, runtime 9,196 bytes)

One transaction: deploy the coin (CREATE2, salt = `keccak(creator, nonce)`), size the curve from the oracle
(`plan(targetUsd)` = `curveForMarketCap` + nearest grid ticks), move 980M coins to the hook, send 20M to the
creator, `hook.createPool`, and if `msg.value > 0` make the creator's first buy at the bonding rate (exact input,
`out <= 700M`, `out >= minFirstBuyOut`). Emits `Launched(token, id, creator, targetUsd, mc, vN, vT, tickStart,
tickGrad, firstBuyIn, firstBuyOut)`. `unlockCallback` only works inside `launch()` (lock flag).

The research launcher is deliberately loose. Production changes (all must be in the audit scope):

| # | Research behaviour | Production rule | Marker |
|---|---|---|---|
| L1 | `fees` is caller-supplied (any value under the caps, including 0) | Launcher constants `200 / 100 / 50 / 9000`. A caller cannot pick them. | [Decided by the fee decisions; implementation detail] |
| L2 | `targetUsdWad` is any value | Allow-list: `30_000e18`, `50_000e18` on mainnet; a small test target on 97 / 46630 | [Decided: gen-7 targets] |
| L3 | Oracle value used unchecked | Staleness and sane-band check as `LaunchFactoryGen7` C8; a stale or out-of-band price reverts the launch, never a trade | [Decided: gen-7 rule] |
| L4 | Anyone can launch | Signed create authorization from our API, or permissionless | [Open, D3] |
| L5 | No pause | `createPaused` flag (Safe), needed for coexistence with gen-7 and for incidents. Pauses launches only, never trading. | [Open, D4; recommended yes] |
| L6 | Creator reserve sent to the creator at launch | See 4.5 | [Open, D6] |
| L7 | Fee choice not recorded | Choice set once at launch, see 4.1 | [Open, D2] |
| L8 | Creator first buy goes to the creator wallet | Unchanged: not escrowed, as gen-7 | [Decided] |

### 2.5 `MwzV4Token` (research: `MwzV4Token.sol`)

Plain OpenZeppelin ERC20, 18 decimals, 1B fixed supply minted once to the launcher. No owner, no tax, no transfer
hook, no blacklist, no pause. Transfers are free from block one (proven untaxed). [Decided]

This differs from gen-7, whose `LaunchToken` blocks transfers before graduation. Free transfers are required for
permissionless trading; the consequence is that side pools can exist from the first block (6.8).

Metadata (image, description, socials) stays off chain as today. [Decided]

### 2.6 `MwzDisplayPair` + `MwzDisplayPairFactory` (BNB only; research: `MwzDisplayPair.sol`) [Decided]

Purpose: DexScreener does not index Uniswap V4 on BSC. A display pair emits Uniswap V2 events for every trade in our
V4 pool, modelled on flap.sh's `FlapCurvePairFactory` pairs (read on chain).

- Pair: `name "Uniswap V2"`, `symbol "UNI-V2"`, `decimals 18`, `token0/token1` sorted (WBNB vs coin),
  `getReserves()`, `totalSupply() = sqrt(r0*r1)`. Only the hook can write (`init`, `update`). It never holds or moves funds.
- Reserves are the virtual reserves of the active liquidity (`L / sqrtP`, `L * sqrtP`), so their ratio is the pool
  price exactly (proven 0.000000 ppm), and inside A they equal gen-7's virtual reserves.
- Events: at launch `Sync` then `Mint`; per trade `Sync` then `Swap(sender, in/out amounts, to)` with the trader-side
  native amounts (fee included).
- Factory: emits V2 `PairCreated(token0, token1, pair, length)`; `getPair`, `allPairs`, `allPairsLength`; `setHook`
  once by the deployer (the hook address depends on the mined salt).
- The hook calls `update` with a fixed 60,000 gas cap and copies no return data. A reverting or gas-burning display
  cannot revert the swap (proven: `DisplayUpdateFailed` logged, trade succeeds). Display cost: 9,644 gas per swap.

Open item: add `factory()` to the pair returning the display factory, so DexScreener may auto-index it as an
unknown V2 factory. flap's pairs do not have it (they are a named listing). Unknown until tried on mainnet. [Open, D10]

### 2.7 Contract size and the library split [Decided: must be done; Open: exact split, engineering]

The hook runtime is 23,465 bytes of the 24,576-byte limit (1,111 bytes free). Production adds at least: the bonding
creator share (D2), possibly a fee-choice recipient, the `executeTreasuryRouter` flush (8.2 A6), and audit fixes.
Plan, in order, each step measured before the next:

1. Move the swap simulation (`_simulate`, `_step`, `_nextTick`, `_grossForNet`) into an external library
   `MwzSwapSim` with `public` functions (linked, called by DELEGATECALL). It is the largest block and is pure / view.
2. Move `previewFill` and `currentFeeBps` into a stateless `MwzHookLens` that reads hook state through getters and
   calls the same library, so quotes and swaps share one implementation.
3. Keep in the hook only: callbacks, accrual, latch, claims, creator transfer, router timelock, display call.
4. Target <= 21,500 bytes so audit fixes fit without another split. Optimizer settings are pinned and recorded in
   the verification manifest.

Each external library call adds roughly 2,600 gas (cold DELEGATECALL) to price-limited swaps only; swaps without a
limit do not simulate.

### 2.8 Upgradeability [Decided]

None. Hook, launcher, token, display pair and factory are immutable, no proxies. The only mutable settings are
`treasuryRouter` (48 h timelock, Safe), `owner` (two-step), and in production the launcher's `createPaused`.

A change to fees, the curve, the latch or the payout logic requires: a new hook (new mined address, so new pools), a
new launcher, the audit of the diff, the full test ladder (8.4), and a new generation (gen-9). Existing gen-8 coins
keep their hook and their stored rates forever.

### 2.9 Invariants (the audit's property list)

| # | Invariant | Proof status |
|---|---|---|
| I1 | Fee = gen-7 formula for the swap type and rate, to the wei (exact-input buys: +0..2 wei) | proven on both forks, every router path |
| I2 | Fee is charged only on the filled part of a price-limited swap | proven |
| I3 | `rate <= 9000` during the window, `== bondingBps <= 200` after it, `== postBps <= 100` after graduation | proven, caps revert at launch |
| I4 | Sum of ERC6909 native claims held by the hook == `routerOwed + sum(creatorOwed)` | proven (checked at end of each run); production: fuzz after every action |
| I5 | The hook never holds coins after `createPool` returns | proven |
| I6 | A and B can only lose liquidity once, by exactly `floor(liqA * 2%)` from A, at graduation | proven (no remove path; `beforeAddLiquidity`, donate, initialize revert) |
| I7 | `graduated` goes false -> true once, only when the price is at or below `sqrtGrad`, and never back | proven |
| I8 | Post-graduation `creatorShare == floor(curveAmount * creatorPostBps / 10000)` | proven |
| I9 | Only the creator (or after `acceptCreator`, the new creator) can move `creatorOwed[id]`; the owner cannot | proven |
| I10 | `treasuryRouter` changes only via propose + 48 h + execute by the owner | proven |
| I11 | A swap never reverts because of the display pair | proven (revert and out-of-gas displays) |
| I12 | Stored rates never change after launch | proven (router change keeps both coins' rates) |
| I13 | Supply: 850M + 130M + 20M = 1B, hook seed uses exactly the coins sent (dust burned) | proven |

---

## 3. Fee and money flows

### 3.1 Bonding trades (2%) [Decided]

| Example | Trader | Curve | Fee | Fee as % of what the trader moves |
|---|---|---|---|---|
| Buy, 1 BNB of curve (exact output) | pays 1.02 BNB | 1.00 BNB | 0.02 BNB | 2% of cost, 1.961% of what is sent |
| Buy, sends 1 BNB (exact input) | pays 1.00 BNB | 0.980392 BNB | 0.019608 BNB | same rule |
| Sell, curve pays 1 BNB | gets 0.98 BNB | 1.00 BNB | 0.02 BNB | 2% of payout |
| Buy on Robinhood, sends 0.1 ETH | pays 0.1 ETH | 0.098039 ETH | 0.001961 ETH | |
| Proof: BSC direct exact-in buy | sent 0.106275 | 0.104191 | 0.002083827 | 2.000000% of cost |

### 3.2 Launch window [Decided, proven]

`rate(t) = 200 + 8800 * (60 - t) / 60` bps for `t` seconds after the launch block, every caller except the launcher's
first buy.

| t | Rate (of curve amount) | Buy sending 0.053137 BNB: curve / fee (proof) | Share of what is sent |
|---|---|---|---|
| 1 s | 88.53% | 0.028185 / 0.024952 | 47.0% |
| 10 s | 75.33% | 0.030307 / 0.022830 | 43.0% |
| 30 s | 46.00% | 0.036395 / 0.016742 | 31.5% |
| 45 s | 24.00% | 0.042852 / 0.010285 | 19.4% |
| 59 s | 3.46% | 0.051360 / 0.001777 | 3.3% |
| 60 s+ | 2.00% | 0.052095 / 0.001042 | 1.96% |

Note for the copy: "90%" means 90% on top of the curve cost, which is 47.4% of what a buyer sends at t = 0. A sell
in the window pays the same rate out of its payout (88.53% at 1 s). That includes a creator selling first-buy coins.

Creator first buy (proof, BSC $30K): sent 0.265688 BNB = cost 0.260478 + fee 0.005210 (2%).

### 3.3 Graduation crossing and after [Decided, proven]

BSC $30K example: the buy that takes the price to the top of A pays 2% on its curve cost to the router bucket. In the
same swap, the hook removes 2% of A: 0.106264 BNB (~$79.6) to the router bucket. A keeps 98% of its liquidity, B is
untouched. Robinhood $30K: 0.031816 ETH.

After graduation, 1%, split creator 0.50% / router 0.50% of curve volume (proof, BSC):

| Trade | Curve volume | Fee 1% | Creator | Router |
|---|---|---|---|---|
| Buy exact in, sent 0.265688 BNB | 0.263057 | 0.002631 | 0.001315 | 0.001315 |
| Buy exact out (UR) | 0.135890 | 0.001359 | 0.000679 | 0.000679 |
| Sell exact in (UR) | 0.222882 | 0.002229 | 0.001114 | 0.001114 |
| Robinhood buy exact in | 0.131237 ETH | 0.001312 | 0.000656 | 0.000656 |

### 3.4 How the router bucket is split: THE KEY OPEN DESIGN QUESTION [Open, D1]

**Today (gen-7).** Every buy and sell carries an API signature (EIP-191 personal-sign over
`MWZ_ROUTE_TRADE_AUTH, chainId, campaign, actor, routeProfile, action, amount, limit, deadline`;
`frontend/api/dev-fix/routeAuthorizationSigner.js:451-482`, checked in `LaunchCampaignGen7.sol:1023-1043`, TTL 600 s
from the API, at most 1 day on chain, replay map, no nonce). The profile is chosen by the API
(`frontend/api/dev-fix/route-decision.js:176-200`): linked if the wallet has an active recruiter link (OG if the
recruiter is OG) or owns a recruiter row itself; otherwise unlinked, including on DB errors. The campaign sends the
fee to `TreasuryRouterV4.routeTrade{value: fee}(profile)`, which splits on chain
(`TreasuryRouterV4.sol:187-209, 408-432`):

| Share of the fee (bps) | standard_linked | standard_unlinked | og_linked | Destination |
|---|---|---|---|---|
| League (weekly 30 / monthly 70) | 3750 | 3750 | 3750 | weekly league vault / monthly league treasury |
| Creator | 560 | 560 | 560 | `CreatorRewardsVaultV2.accrueTradeFee(campaign)` |
| Recruiter | 1250 | 0 | 1500 | `recruiterRewardsVault` (one pooled vault) |
| Squad | 250 | 0 | 250 | `CommunityRewardsVault.depositSquadPool` |
| Airdrop | 0 | 1500 | 0 | `CommunityRewardsVault.depositAirdrop` |
| Protocol | 4190 | 4190 | 3940 | `protocolRevenueVault` |

Graduation (`previewFinalize`, creator's profile fixed at create): recruiter 1500 / 0 / 1750, squad 250 / 0 / 250,
airdrop 0 / 1750 / 0, protocol the rest (8250 / 8250 / 8000).

Two facts matter for the choice:

1. **Even today the recruiter is not identified on chain.** The recruiter share goes into one pooled vault; the
   indexer credits the individual recruiter from the trade's actor and the DB link. The on-chain profile only sizes
   the buckets.
2. **Solana DBC already runs the pooled model in production.** DBC trades are permissionless; fees accrue on our
   collector; the indexer computes per-swap slices from the trader's recruiter link at trade time
   (`realtime-indexer/src/dbc/dbcFeeSplit.ts` `profileBps`, `dbcFeeAccruals.ts` `resolveTraderProfile`, idempotent on
   `(tx, log_index)`), claims (`dbcFeeClaimer.ts`) and routes the summed slices to the reward vaults in one
   transaction per run (`dbcFeeRouter.ts`). Same bps as the EVM table above.

**With gen-8 the hook cannot know the trader.** The swap's `sender` is the router contract (UniversalRouter, an
aggregator, a bot contract). The hook only sees what is in `hookData`, which any caller can fill.

**Options**

| | A. Off-chain attribution, bounded on-chain splitter (DBC model) | B. Per-trade profile in `hookData`, signed by our API, verified by the hook | C. No linked routing for gen-8 coins |
|---|---|---|---|
| How | Hook pays the pooled bucket to a new `MwzFeeSplitter` (the TreasuryRouter for gen-8). The indexer reads every `HookFee` with the transaction sender (`tx.from`), resolves the profile with the DBC SQL, accrues slices per trade. A route run sends each bucket's sum to its vault. | App asks the API for a signature (as today), puts it in `hookData`; the hook checks it (ECDSA) and keeps per-bucket ledgers per trade. Trades without a valid signature use the unlinked profile. | One fixed on-chain split for every trade (the unlinked profile: airdrop gets the 15%). Recruiters earn on gen-8 coins only from graduation fees, or not at all. |
| Recruiter, squad, airdrop shares | Same as today, for every trade wherever it is made, attributed by `tx.from` | Same as today for app trades; bot and aggregator trades go to airdrop | Recruiter and squad shares go to airdrop |
| Effect on MemeWarzone protocol income | None (protocol stays 41.9% / 39.4% of fees) | None | None (protocol stays 41.9%) |
| Effect on recruiters | Unchanged; slightly more, because third-party trades of linked wallets also count | Lower: only app trades count | Gone on BNB/Robinhood gen-8 coins |
| Contract cost | New small splitter (no ECDSA in the hook); hook unchanged | ECDSA + EIP-712 + 5 ledgers in the hook: does not fit in 1.1 KB, forces a larger split; +~6-10k gas per app trade | None |
| Trust | Operator key computes amounts off chain; bounded on chain (below) | API signer becomes a money-path key again; mempool copying of signatures possible (it only credits that recruiter) | None |
| Abuse | Smart-contract wallets (ERC-4337) show the bundler as `tx.from`: unattributable, default unlinked. Wash trading to farm recruiter shares costs 2% to earn 0.25-0.30%: unprofitable, same as today. | Same, plus signature replay inside the TTL | None new |
| Fits "permissionless" | Yes | Partly: bots trade without a profile | Yes |
| Off-chain work | Port of the DBC accrual + router pipeline to EVM | API signer + app encoding; indexer still needed for recruiter credit | Least |

**Recommendation: A.** It keeps every income share and the recruiter programme intact, keeps the hook small and
signature-free, and it is the pipeline Solana DBC already runs. The on-chain splitter makes the operator unable to
take money:

`MwzFeeSplitter` (proposed; one per chain, immutable):

- Receives native only from the hook (`claimRouter`) and tracks `received` per run.
- Destinations fixed at deploy: weekly league vault, monthly league treasury, recruiter vault, community vault
  (airdrop and squad deposits), protocol vault, creator-choice vault (if D2 routes bonding creator shares here).
- `route(runId, amounts[], accrualRoot)` by an operator key (a new key, Zodiac Roles scoped as in gen-7):
  - `sum(amounts) == received since the last run` (all of it, nothing left behind, nothing invented).
  - League share exactly `floor(3750 * total / 10000)` (profile-independent) and its 30 / 70 sub-split.
  - Recruiter + squad + airdrop between 1500 and 1750 bps of the trade total; graduation-fee part between 1750 and 2000.
  - Protocol is the remainder and can never exceed 4190 bps of trades + 8250 bps of graduation fees.
  - `accrualRoot` (Merkle root of the per-trade slice rows) is emitted, so anyone can recompute.
- If the operator never runs, the funds stay in the splitter (no loss, delayed payouts); the Safe can run the same
  bounded `route`. No `withdraw`.
- Worst case with a stolen operator key: money moves between airdrop and recruiter/squad within the 1500-1750 band,
  and only to our own vaults. It cannot reach a wallet.

Attribution rules for A (indexer):

- Trader = `tx.from` of the transaction that emitted `HookFee`. The `referrer` in `hookData` is never used for
  money (anyone can write any address there; trusting it would let a trader pay their own recruiter share to
  themselves). It is stored for analytics and partner attribution only. [Decided: referrer is attribution only]
- Profile at trade time via the DBC link SQL (`wallet_recruiter_links` at `occurred_at`), same fallback to unlinked.
- Graduation fee profile: the creator's profile at graduation time (gen-7 uses the creator's profile fixed at create;
  the indexer can store it at launch to match exactly).

### 3.5 Money flow diagram (text)

```
trader --native--> PoolManager --swap--> pool (A, B)
                      |
             hook takes fee in native (ERC6909 claim)
                      |
         +------------+----------------------+
         | bonding fee, router share,        | post-grad creator share (0.5% of volume)
         | graduation fee                    |
     routerOwed                          creatorOwed[coin]
         | claimRouter() (anyone)            | claimCreator(coin, to) (creator only)
     MwzFeeSplitter (D1 = A)              any address the creator names
         | route(): league / recruiter / squad / airdrop / protocol / creator-choice
     existing vaults (gen-7 per-chain stack)
```

---

## 4. Creator features

### 4.1 Fee choice: keep / holders / split / buyback [Open, D2]

Gen-7: the choice is set once at create (`LaunchFactoryGen7.sol:127-130, 551`; `CreatorRewardsVaultV2.setCampaignChoice`).
During bonding the creator gets 560 bps of the fee (0.112% of volume) into `CreatorRewardsVaultV2`, credited by
choice (keep -> creator balance; holders -> holder balance; split -> pct / rest; buyback -> buyback balance). After
graduation the LP fees (creator 80% of 0.30%) follow the choice through the locker.

Gen-8 has two creator streams: the bonding share (whatever D2 decides) and the post-graduation 0.50% of volume in
`creatorOwed`. The founder fixed that the post-graduation balance is the creator's, claimable to any address, and
MemeWarzone cannot change it.

**Proposal**

1. **Bonding share**: keep gen-7's 560 bps of the bonding fee for the creator. Two ways:
   - (a) Hook credits it to `creatorOwed[id]` directly: add `creatorBondingBps` to `FeeConfig` (cap e.g. 1000 of the
     fee). Exact, on chain, no operator. Costs a few hundred bytes.
   - (b) It stays in the router bucket and the splitter pays it to a creator-choice vault per coin (needs the
     per-coin amounts from events; operator-computed).
   Recommend (a): the creator's money never passes through an operator.
2. **Fee choice for both streams** via the creator role:
   - `keep`: the launcher registers the creator wallet as the coin's creator in the hook. Creator claims directly.
   - `holders` / `split` / `buyback`: the launcher registers a gen-8 `CreatorChoiceVault` (one per chain, immutable
     rules) as the coin's creator in the hook, with the human creator recorded in the vault. Anyone can call
     `vault.pull(id)`, which calls `hook.claimCreator(id, vault)` and credits the amount by the stored choice, exactly
     like `CreatorRewardsVaultV2._credit`. The creator's `keep` part is claimable by the human creator; holder and
     buyback balances are operated as today (weekly holder batches, randomized buybacks under the E15 caps).
   - The choice is fixed at launch, as gen-7. The human creator can still transfer their right inside the vault
     (two-step), mirroring the hook rule.
   This keeps "MemeWarzone cannot change it" true at the hook level: the vault's rules are immutable and the Safe has
   only the bounded operator and veto powers it has today.
3. **Buyback** in gen-8 is a plain swap in our own V4 pool by the vault (no signature needed any more). It pays the
   2% / 1% fee like any trade. Guards as gen-7: not inside the 60 s window, impact cap 50 bps, per-coin weekly cap,
   coins to `0xdEaD`. Before graduation gen-7 also refused buybacks past 95% curve progress; keep that rule (it stops a
   buyback from triggering graduation).

### 4.2 Holder batches [Decided: unchanged process, new holder source]

Same weekly HMAC-timed snapshot and Monday batch (`realtime-indexer/src/evm/evmCreatorChoice*.ts`, program
`airdrop_holders_gen7`, `evm_holder_batches` per chain, vault and week; `docs/evm-launch/creator-choice-operator.md`).
Input change: today the holder census (`realtime-indexer/src/tokenHolders.ts`, `Transfer` replay into
`token_holder_balances` / `token_holder_sync`) is only caught up on demand by `evm/evmCreatorChoiceWorker.ts:47`.
For gen-8 coins it must be kept caught up continuously (6.5), because there is no curve contract and the coin is
transferable from block one. Excluded from holder lists: the PoolManager (holds the pool's coins), the hook,
`0xdEaD`, the launcher, the reserve lock and the escrow contract. The display pair holds nothing.

### 4.3 Creator buy escrow [Open, D5]

Gen-7: any creator buy except the first is escrowed (20% at 30 days, then 20% every 7 days;
`LaunchCampaignGen7.sol:630-711`), enforced because the signed actor is known. In gen-8 the hook sees the router,
not the trader.

| Option | Enforced against | Cost / risk |
|---|---|---|
| E1. App-level escrow (Solana model): our app sends buys from the coin's creator wallet through a small `MwzCreatorEscrow` periphery contract that swaps and holds the coins on the gen-7 schedule | Creator buys made in our app | Creator can buy elsewhere unescrowed, as on Solana. No hook change. |
| E2. Hook-level escrow keyed on `tx.origin == creator`: on such buys the hook takes the coin output into escrow via the return delta | The creator wallet on any router | Uses `tx.origin` (an audit flag; smart wallets bypass); third-party routers' `minOut` checks then fail, so the creator effectively cannot buy outside escrow; adds code to a full hook |
| E3. No escrow for gen-8 | Nobody | Simplest; relies on public creator-holding display |

Recommendation: **E1**, matching Solana and the founder's note that only app buys can be escrowed. Show creator
holdings and escrowed amounts on the coin page; creator buys never count for leagues (indexer rule, as today).

### 4.4 Creator first buy [Decided]

Up to 70% of supply, in the launch transaction, at 2%, unlocked, not escrowed. Proven. It does not start the clock
early for others: everyone else in the launch block and the next 60 s pays the decaying rate.

### 4.5 Creator reserve (2%, 20M coins) [Open, D6]

Gen-7 holds the reserve in the campaign until graduation, then sends it in one step to the creator (no vesting;
`LaunchCampaignGen7.sol:757-759, 789`). The research launcher sends it to the creator at launch, because there is no
campaign contract to hold it.

| Option | Effect |
|---|---|
| R1. Hook holds it and releases it to the creator in the graduation latch | Same as gen-7. Needs coin handling in the hook (it holds no coins today: invariant I5 changes) and a transfer inside a swap. |
| R2. A tiny `MwzReserveLock` per chain holds it; `release(id)` is permissionless once `hook.pools(id).graduated` is true, pays the current hook creator | Same outcome as gen-7, hook untouched. Recommended. |
| R3. Send at launch (research behaviour) | Creator can sell 2% immediately. Differs from gen-7. |

### 4.6 Creator transfer [Decided, proven]

`proposeCreator(id, next)` then `acceptCreator(id)` by `next`. After that the old creator cannot claim or propose;
accruals after the transfer go to the new creator. The app shows it in the creator panel and the indexer updates
the coin's owner on `CreatorTransferred`. A creator contract that rejects native must claim to another address
(proven).

---

## 5. Leagues, recruiters, airdrops, battles, graduation, MWL, market stats

Today every one of these reads `curve_trades` (bonding trades, written from campaign `TokensPurchased` / `TokensSold`)
and, after graduation, `dex_trades` / `market_stats` (written by the DEX pool indexers). If gen-8 writes the same
tables with the same split at the graduation block (6.3, D14), none of the readers below needs a logic change; they
need gen-8 rows and the gen-8 fee rate.

| Area | Reads today (live branch) | Gen-8 change | Marker |
|---|---|---|---|
| League standings and payouts | `realtime-indexer/src/rewards/leagueLeaderboard.ts`, `jobs/generateLeagueStandings.ts`, `finalizeEpochWinners.ts`: `curve_trades` with `block_number <= graduated_block`; `frontend/api/league.js` (:480, :1297-1385; pot = `curve_trades` gross x fee bps, :470-535) | Rows come from gen-8 bonding swaps; actor = `tx.from`; volume = `HookFee.curveAmount`. The pot formula must take the fee from the row (`fee_raw`), not a fixed bps, because gen-8 has the 60 s decay and 2% / 1% rates. "League shown = paid" check re-run on gen-8 rows. | [Decided: same rules, new source] |
| Which trades count | Our site only (every trade was signed) | Every trade in our pool from any router; side pools never (no fee, not ingested) | [Open, D7] |
| Creator's own trades | `league_excluded` (`curveTradeGen5Columns.ts`, `evmGen5Store.ts:270`) | Same column; set when `tx.from` is the hook creator or the trade came through the escrow contract | [Decided] |
| Recruiter league and earnings | `rewards/recruiterLeague.ts`, `frontend/api/leagueRecruiter.js` (volume from `curve_trades`, earnings from `reward_events`); `rewards/creditRecruiterEarnings.ts` attributes from `route_authorization_log`, else the wallet's recruiter link (header :6-20) | No trade authorizations exist any more, so attribution always uses the wallet link at trade time (the existing fallback). `reward_events` rows come from the gen-8 fee accruals (6.3) instead of `RouteExecuted`. | [Open, D1] |
| Airdrop pots and candidates | `frontend/scripts/weekly-airdrop/` (`pots.mjs` main + gen7, `candidates.mjs:183, 225` from `curve_trades`), `rewards/airdrops.ts`, `api/airdropPool.js`, `scripts/lib/gen7AirdropPot.ts` | Candidates unchanged (gen-8 rows in `curve_trades`). Pot inflow is the splitter's airdrop / squad deposits; whether that is the gen-7 pot or a third pot follows D8 | [Open, D8] |
| Battles | `lib/arenaBattleMetrics.js:398` (`market_trades_v`), `lib/arenaMarketSnapshot.js` (`market_stats` :162-180, `token_stats` :215, `token_holder_balances` :233, `dex_pools` :253), `arenaBattles.js` | Unchanged if 6.3 fills `token_stats` before and `market_stats` / `dex_pools` after graduation; holders need the continuous census (6.5) | [Decided] |
| Graduation for the platform | Campaign `Graduated` -> `markEvmCampaignGraduated` (`indexer.ts:1430`) -> `setCampaignGraduated` (:471, `notifyCampaignGraduated`); keeper `evm/evmGraduationKeeper.ts`; `graduationReconciler.ts` | Hook `Graduated` event drives the same `markEvmCampaignGraduated` path, same block as the crossing trade. No pending state; keeper excludes gen-8. | [Decided] |
| MWL | `arenaLeagueScore.js` and related: battle and check-in points, not trade volume (confirmed by the founder 2026-10-11) | Owner = hook creator (follows `CreatorTransferred`) | [Decided] |
| Market cap | price x 1B (gen-6/7 rule; `campaigns-base.js:15-22` fully diluted when `factory_generation >= 6`) | Same; gen-8 has `factory_generation = 8` | [Decided] |

## 6. App, API and indexer changes

All references are on `origin/build/cross-chain-stabilization-rh-base`. Line numbers are as read on 2026-10-11.

### 6.0 What gen-8 breaks in the live stack

| # | Today | Why gen-8 breaks it | Fix (section) |
|---|---|---|---|
| B1 | Trades, candles, stats are ingested per campaign contract from `TokensPurchased` / `TokensSold` | Gen-8 has no campaign contract; trades are PoolManager `Swap` events keyed by pool id, fees are hook events | 6.3 |
| B2 | `curve_trades` vs `dex_trades`, `token_stats` vs `market_stats`, and "graduated" all assume a switch from the curve to a separate DEX pool | Gen-8 is one pool before and after | 6.3, D14 |
| B3 | Discovery via factory `CampaignCreated` | Launcher `Launched` / hook `PoolLaunched` | 6.3 |
| B4 | Fee income, recruiter credit, airdrop pot and finance all come from router `RouteExecuted` | Hook `HookFee` + splitter runs | 6.3, 6.6 |
| B5 | Signed trade authorization and `route_authorization_log` | Gone for trades | 6.1, 6.2 |
| B6 | Graduated EVM coins trade through the import swap route, which does not support V4 hook pools (`CO-IMPORT-SWAP-FEE.md:66`); LP crank and pool indexers target V2 / V3 | Gen-8 graduated coins are V4 hook pools | 6.2, 6.7 |
| B7 | Holder count = distinct buyers in `curve_trades` (`frontend/api/campaigns-base.js` ~546) | Coins move freely; buyers is not holders | 6.5 |

### 6.1 Create flow [Open, D3]

Today: `frontend/src/pages/Create.tsx` reads the launch generation (`readEvmLaunchGeneration` :548-566, `evmGen7`
:330, gen-7 inputs :578-587, `components/create/EvmGen6LaunchOptions.tsx`, `createCampaign` :1152);
`frontend/src/lib/launchpadClient.ts` `createCampaign` :864-960 runs preflight-create, then
`POST /api/routing/create-authorization` (:158), then `createCampaignAuthorized` /
`createBasicQuoteCampaignAuthorized`. Signer: `frontend/api/dev-fix/route-auth.js` (`routingCreateAuthorization`
:411, gen-7 targets :155-236), `routeAuthorizationSigner.js`, log `route-auth-log.js` (`route_authorization_log`).

Gen-8:

- A third generation branch in `Create.tsx` / `launchpadClient.ts` that calls `launcher.launch(...)` with
  `msg.value` = first buy. First-buy preview from `launcher.plan(target)` plus `frontend/shared/evmGen7Curve.mjs`
  (same `vN`, `vT`). 70% MAX and balance block as gen-7.
- Recommendation for D3: **create-only signing**. `routingCreateAuthorization` gains a gen-8 payload (creator, name,
  symbol, target, fee choice, metadata hash, deadline) signed with the same scheme; it keeps bans (`RiskRegistry`),
  metadata and draft checks, and logs to `route_authorization_log` as today. If D3 = permissionless, the create
  endpoint only stores metadata and the indexer adopts any `Launched` coin.

### 6.2 Trade panel [Decided]

Today: `launchpadClient.ts:1030-1145` runs preflight-buy/sell, `POST /api/routing/trade-authorization` (:174,
`routingTradeAuthorization` `route-auth.js:620`), then `buyExactTokensAuthorized` / `sellExactTokensAuthorized`.
Quotes from campaign views (`TokenDetails.tsx:4231-4275, 4908, 4944`, `launchpadClient.ts:747`, `readGen5Quotes`).
After graduation: `WarRoomTradePanel.tsx` -> `ImportedTradePanel` via `graduatedEvmTradeRoute.mjs`
(`/api/imports/swap/quote|build`).

Gen-8 (both before and after graduation, one panel):

- Quotes: `V4Quoter.quoteExactInputSingle` / `quoteExactOutputSingle` with our pool key (proven equal to execution);
  `previewFill` (lens) when a price limit is set; `currentFeeBps` for the fee line and the launch-rate countdown.
- Execution: UniversalRouter `V4_SWAP` (one router version per chain, layout v2.1), native in for buys, Permit2 for
  sells. `hookData` = our attribution word (analytics only, never money).
- No trade authorization call and no `route_authorization_log` row for gen-8 trades. Preflight keeps only the
  client-side checks (balance, slippage).
- Graduated gen-8 coins stay on this panel; `graduatedEvmTradeRoute.mjs` must not send them to the import route
  (D9). If the widget is to support gen-8 coins, the import swap build gains a V4 hook-pool path via UniversalRouter.
- The Solana CREATE / BUY / SELL shape rule in CLAUDE.md is untouched (EVM only).

### 6.3 Indexer ingestion [Decided: sources; Open: table split D14]

Today (`realtime-indexer/src/`):

- Chains: `indexer.ts:302-341` (`CHAINS` 56 / 97 / 46630 / 4663; env `BSC_RPC_HTTP_<id>`, `ROBINHOOD_RPC_HTTP_<id>`,
  `FACTORY_ADDRESS_<id>`, `FACTORY_START_BLOCK_<id>`). Loops: `server.ts` `runIndexerOnce` (~2851), `runTipScanOnce`
  every 10 s (~2950).
- Generation: `evm/evmGen5Store.ts` `resolveCampaignGeneration` (`FACTORY_GENERATION` / `CAMPAIGN_GENERATION`,
  `EVM_GEN7_FACTORIES_<id>` :54); gen-7 = 7/6 (`evm/evmGen7Curve.ts:14-15`).
- Discovery: `scanFactoryRange` (`indexer.ts:996-1095`, `CampaignCreated`) -> `upsertCampaign` (:383) ->
  `notifyCampaignCreated` + Ably `league:<chain>` `campaign_created`; `factoryDiscovery.ts`, `factoryInventory.ts`,
  `SUPPORTED_FACTORY_ADDRESSES_<id>` (`env.ts:76-82`).
- Trades: `scanCampaignRange` (`indexer.ts:1522-1860`), `getLogs` per campaign with `GEN5_ALL_TOPICS`
  (`evm/evmGen5CampaignLogs.ts`, ABI `evm/evmGen5Abi.ts:22-37`); per trade `insertTrade` -> `curve_trades`
  (:560-627), `gen5AnnotateAfterInsert` / `annotateCurveTrade` (`fee_raw`, `league_excluded`), activity, milestones,
  `upsertCandle` -> `token_candles` (:769-818), `patchStats` -> `token_stats` (:877-952) from `virtualNative` /
  `virtualToken` (`loadBnbCurveParams` :847, `bnbCurvePricing.ts`); other logs -> `evm_campaign_events`;
  `canonicalCandleMaterializer.ts` also reads the virtual reserves.
- After graduation: `topazPoolIndexer.ts` (BNB), `robinhoodV3PoolIndexer.ts` (Robinhood), pools from
  `campaign_market_state`, writing `dex_pools`, `market_pairs`, `dex_trades`, `token_candles`, `market_stats`.
  `market_trades_v` = `curve_trades` UNION `dex_trades` (`db/migrations/20260921_000002_...`).
- Fees: `RouteExecuted` per router (`indexer.ts:1213-1330`, cursor `rewards-router:<addr>`) -> `reward_events`
  (`rewards/ingest.ts:186`); gen-7 router `EVM_GEN7_ROUTER_<id>` (`evm/evmGen7Fees.ts`); vault and locker events via
  `evm/evmGen5Aux.ts:48-56`.

Gen-8: one new module `evm/evmGen8Pool.ts` per chain, own cursor, env `EVM_GEN8_LAUNCHER_<id>` and
`EVM_GEN8_HOOK_<id>` (`0xaddr@startBlock`, same convention as `EVM_GEN7_ROUTER_<id>`):

| Event | Source | Writes |
|---|---|---|
| `Launched` + `PoolLaunched` | launcher, hook | `upsertCampaign` with `factory_generation = 8`, token, pool id, hook, creator, target, ticks, rates, display pair; `notifyCampaignCreated`; Ably `campaign_created` |
| `Swap` (PoolManager, topic filtered by our pool ids) | PoolManager | one trade row per swap: side, native and coin amounts, price from `sqrtPriceX96`, trader = `tx.from` |
| `HookFee` | hook | joined to the `Swap` of the same swap (same tx, consecutive logs): `fee_raw`, rate, creator share, referrer; fee accrual row (D1) |
| `Graduated` | hook | `markEvmCampaignGraduated` (same path as gen-7), graduation fee accrual row |
| `CreatorClaimed`, `CreatorProposed`, `CreatorTransferred` | hook | `evm_campaign_events`, owner change |
| `RouterClaimed`, `RouterProposed`, `RouterChanged`, `DisplayUpdateFailed` | hook | finance, `reward_alerts` |
| splitter `Routed` | `MwzFeeSplitter` | `reward_events` (per bucket), finance |

**D14, where gen-8 trades go.** Recommendation: split at the graduation block, exactly as the live readers expect.
Swaps up to and including the crossing swap go to `curve_trades` (+ `token_candles`, `token_stats`); swaps after it
go to `dex_trades` (+ `market_stats`, `dex_pools` / `market_pairs` row for our pool, seeded at launch so the coin page
can switch without a gap). Reason: leagues, airdrop candidates and `finalizeEpochWinners` read `curve_trades` with
`block_number <= graduated_block`; battles and the coin page read `market_trades_v`, which unions both. With this
split no reader changes logic. Alternative: one table for both phases, which would require changing every reader
listed in section 5. Price for `token_stats` comes from the pool price, not `virtualNative` / `virtualToken`
(gen-8 has no such views); `loadBnbCurveParams` and `canonicalCandleMaterializer.ts` gain a gen-8 branch that uses
`sqrtPriceX96`.

Ably (`realtime-indexer/src/ably.ts`): unchanged channel and event names. Before graduation `token:<chain>:<addr>`
`trade`, `stats_patch`, `candle_upsert`; after `market_trade`, `market_stats_patch`, `market_candle_upsert`;
`market_stage_changed` at graduation; `league:<chain>` `campaign_created`, `campaign_patch`. Consumers
(`useCurveTrades.ts`, `useUnifiedMarket.ts`, `useTokenStatsRealtime.ts`, `useLeagueRealtimeBase.ts`) need no change if
D14 is taken as recommended.

Fee accruals (D1 = A): per `HookFee`, profile from the wallet link at trade time (the `dbcFeeAccruals.ts` SQL), slices
as `dbcFeeSplit.ts`, idempotent on `(tx, log_index)`; a route worker calls `claimRouter` then
`MwzFeeSplitter.route`; `reward_events` rows written per trade with `sourceEvent = 'HookFee'` so
`creditRecruiterEarnings.ts` and finance read them like today's `RouteExecuted` rows.

### 6.4 Campaign state API [Decided]

Today: `/api/campaigns` (`frontend/api/campaigns-base.js`, `server.mjs:452`) decides graduated from
`graduated_at_chain` / `cms.dex_pair_address` / DEX `market_stage` (:31-40, :157), joins `token_stats` +
`market_stats` (:420-422); progress from `frontend/api/lib/evmCampaignProgress.js` (`sold()`, `curveSupply()`,
`graduationNativeTarget()`, `graduationTarget()`, SQL fallback 50 BNB). Coin page `GET /api/evm/campaign-state`
(`server.mjs:561`) -> `evmCampaignState.js` -> `lib/evmGen5CampaignState.js` (`isEvmGen7Pair` :318, `generationKind`
:434); shared maths `frontend/shared/evmGen7Curve.mjs`, `frontend/src/lib/evmGen7.mjs`; `lib/evmGen7Fees.js`,
`evmGen7Lockers.js`.

Gen-8: `generationKind` gains `gen8`; `evmGen8CampaignState` reads the hook (`pools(id)`, `currentFeeBps`,
`creatorOwed`) and StateView (`getSlot0`); progress = coins sold from A / 850M from the pool tick (exact), so
`evmCampaignProgress.js` gets a gen-8 branch and the 50 BNB fallback never applies. Graduated = `graduated_at_chain`
set from the hook event; `cms.dex_pair_address` holds the hook address and the pool id goes into the market-state
metadata (a V4 pool has no pair address).

### 6.5 Holders [Decided]

Gen-8 coins are added to the continuous `tokenHolders.ts` `Transfer` census (not only on demand), and
`campaigns-base.js` takes `holder_count` from `token_holder_balances` for `factory_generation = 8` instead of
distinct buyers. Exclusions as 4.2.

### 6.6 Finance views [Decided: lanes; detail in step 4]

Today EVM income = `reward_events` + locker `FeesHarvested`, assembled in `frontend/api/admin/finance.js`,
`lib/financeFeeRouting.js`, `financeFeeRoutingEvm.js`, `financeRevenueLanes.js`, `financeAccountingSources.js`,
`financePayouts.js` (`reward_events`, `evm_campaign_events` :965), `financeRouterScan.js`, `financeTreasuryStore.js`,
`financeHolderBatchAlerts.js`. No finance DB views.

Gen-8 lanes: `evm_trade_gen8` (bonding fee by bucket from the accruals), `evm_graduation_gen8`, `evm_postgrad_gen8`
(protocol 0.5% and creator 0.5%), splitter runs (`financeRouterScan.js` gains the splitter), creator claims from
`evm_campaign_events`, and the unclaimed `routerOwed` / `creatorOwed` read live from the hook. No LP lane.

### 6.7 LP harvest crank [Decided]

Today: `frontend/api/lib/evmLpHarvestCrank.js`, run by `frontend/scripts/run-arena-battle-realtime-worker.mjs:202-219`
(`EVM_LP_HARVEST=dry|send`, `EVM_LP_HARVEST_SCAN_MS`); Solana `realtime-indexer/src/solanaLpHarvestLoop.ts`.
Gen-8 has no LP locker and nothing to harvest: the hook takes every fee in native per swap. The crank is not used
for gen-8 and keeps running unchanged for gen-6/7 pools. The gen-8 periodic job is the splitter route run (6.3).

### 6.8 Side-pool watcher, alerts, notification center [Decided: build, nothing exists today]

Facts: no `PairCreated` / `PoolCreated` / PoolManager `Initialize` watcher exists anywhere. Ops alerts live in
`public.reward_alerts` (`realtime-indexer/src/evm/payoutWatchdog*.ts`, `raiseAlert` :88, `payout_watchdog_state`,
`rewards/rewardOps.ts`, `reminders.ts`), served by `/api/admin/rewards/alerts` and `/internal/rewards/ops/alerts`.
User notifications are separate (`prepare_mode_notifications`, `db/migrations/20261003_000004_notification_feed.sql`,
`lib/notificationProducers.js`, `notifications.js`, indexer `campaignLifecycleNotifications.ts`, `notifications.ts`,
bell `usePrepareNotificationCenter.ts`).

Gen-8:

- Watcher (new indexer module): PoolManager `Initialize` with our coin and any hook other than ours; Uniswap V2/V3,
  PancakeSwap V2/V3/Infinity, Topaz factory `PairCreated` / `PoolCreated` with our coin; per pool liquidity and 24 h
  volume. Writes a `side_pools` table.
- Alerts via `raiseAlert` into `reward_alerts` (one alert source, no second table): new side pool; side-pool volume
  above a share of our pool's volume; `RouterProposed`; `DisplayUpdateFailed` bursts; splitter run failures or
  backlog; oracle staleness at launch.
- Notification center in the web-dashboard repo (`uptokendev/web-dashboard`, Command Center): list, unread state,
  acknowledge, links to coin and explorer, on top of `/api/admin/rewards/alerts`. The user bell
  (`usePrepareNotificationCenter.ts`) is not used for ops alerts.
- Coin page shows our pool as the main market and does not link side pools.

## 7. Discovery and listing plan

| Venue | Robinhood 4663 | BNB 56 | What it needs | Marker |
|---|---|---|---|---|
| DexScreener | Indexes Uniswap V4 hook pools (Pons coins visible). Nothing to do. | Does not index Uniswap V4 or Pancake Infinity on BSC (checked 2026-10-11). Display pair (2.6). Whether it picks up our display factory is unknown: flap is a named listing; "a small launchpad will never get an answer from DexScreener". | One small real mainnet test coin on BNB after the audit (founder go) to see whether the display pair (with `factory()`, D10) appears | [Decided: display pair; Open: D10] |
| GeckoTerminal | Indexes V4 hook pools | Indexes V4 hook pools | Nothing; optionally submit our launcher for a "MemeWarzone" DEX label | [Decided] |
| GMGN | Lists from on-chain pools on supported chains | Same | Verify after the test coin; contact for a launchpad tag | [Open, follow-up] |
| KyberSwap, 0x | Route new hooks only after allowlisting the hook address | Same | Per-chain request with: hook address, audit report, fee description (native-side, on-top for buys), proof that quotes equal execution (V4Quoter == executed, 702/702) | [Decided: apply after audit] |
| Uniswap interface / UniversalRouter | Routes V4 hook pools when the hook is not flagged | Same | Nothing; our app uses UR directly | [Decided] |
| Binance Wallet, OKX Wallet | Their aggregators use the venues above (OKX DEX aggregator, Binance Alpha/Meme Rush listings are curated) | Same | Follows from aggregator allowlisting; Binance Alpha is a business contact | [Open, follow-up] |

---

## 8. Security and audit plan

### 8.1 Threat model

| Actor | Can | Cannot (by construction) |
|---|---|---|
| Any trader / bot / router | Trade at the stored rate; set any `hookData`; set price limits | Avoid the fee in our pool; add liquidity; donate; initialize a pool with our hook; remove liquidity |
| Sniper in the launch block | Buy at the 90% rate | Get the 2% rate (only the launcher's own swap does) |
| Coin creator | Claim its balance to any address; hand over the right | Change rates, liquidity, other coins, the router |
| MemeWarzone Safe (hook owner) | Redirect the router bucket after 48 h; transfer ownership | Change rates, creators, creator balances, liquidity; pause trading |
| Operator key (splitter, D1 = A) | Split each run within the fixed bands, only to our vaults | Send money to a wallet; change bands or destinations |
| Uniswap governance | Turn on the V4 protocol fee for a pool (max 0.1% = 1000 pips) | Touch our hook state |
| Anyone else | Open side pools with our coin; call `claimRouter` | Affect our pool's fee or liquidity |

### 8.2 Auditor points from the proof

| # | Point | Analysis | Mitigation / status |
|---|---|---|---|
| A1 | Simulation drift: `beforeSwap` predicts the fill of a price-limited swap | Exact because only three ticks can ever be initialized and outside liquidity is blocked; `afterSwap` reverts `PartialFill` if the actual amount differs, so a drift can only revert, never mis-charge | Proven exact incl. a 0.1% protocol fee; fuzz in the audit suite |
| A2 | Display gas forcing: a caller can send just enough gas that the 60k display call fails | Only the display misses one update (`DisplayUpdateFailed`); funds unaffected; next swap re-syncs reserves | Accepted; indexer ignores display pairs for money |
| A3 | `tx.origin` in the display `Swap.to` | Display only, never used for authorization or money; smart wallets show the bundler | Documented; must stay display-only |
| A4 | Router redirect window | The Safe can redirect the router bucket after 48 h; `routerOwed` accrued before the change is paid to the new router unless someone calls `claimRouter` first | Production: `executeTreasuryRouter` first pays `routerOwed` to the old router (flush). Alert on `RouterProposed` |
| A5 | Side pools | Cannot be prevented (free ERC20). They split liquidity and volume, carry no fee | Watcher + alerts + dashboard (6.8); coin page links only our pool |
| A6 | Uniswap protocol fee up to 0.1% | Charged by the PoolManager on the swap input, on top of our fee; our fee and quotes stay exact (proven) | Disclosed; quotes include it |
| A7 | Timestamp | The 60 s decay uses `block.timestamp`. BSC validators and the Robinhood sequencer can skew it by seconds at most; the effect is a few hundred bps on the launch rate for one block | Accepted, as gen-7 |
| A8 | Oracle | Read once at launch only. A stale or manipulated price mis-sizes one coin's curve; it never affects trading | L3: staleness + band check; Chainlink feeds as gen-7 |
| A9 | Hook size | 23,465 / 24,576 bytes | Library split (2.7) before audit |
| A10 | Exact-input buy fee = `g - cost` | Up to 2 wei above the gen-7 floor; always in the protocol's favour, bounded | Documented, measured max 1 wei |
| A11 | `sender == launcher` rate exception | Only the launcher can be the `sender` of a swap it initiates; its callback only works inside `launch()` | Proven; keep the lock flag |
| A12 | Crossing swap pays the bonding rate on its whole amount, incl. the part in B | By design (rate fixed in `beforeSwap`); at most 1% extra on the part above graduation for one swap | Documented [Decided] |
| A13 | `claimCreator` to a contract that rejects native | Reverts, balance stays; the creator claims to another address | Proven |
| A14 | Reentrancy | Claims are `nonReentrant` and zero state before the external payout (CEI); callbacks are `onlyPoolManager`; `unlockCallback` only reachable through the hook's own `unlock` | Audit to confirm |
| A15 | Research launcher accepts caller fees and targets | Must be fixed (L1, L2) | Production rule |

Each money path in production code states its reentrancy guard, CEI order, reachable states, overflow behaviour and
griefing (working agreement). Hook: `beforeSwap`/`afterSwap` (PoolManager-only, no external calls except the capped
display call after all accounting), `claimCreator`/`claimRouter` (guard, CEI), `_graduate` (inside the PoolManager
lock, latch set first).

### 8.3 What the external audit must cover

1. Hook, library, lens, launcher, token, display pair + factory, splitter (D1), creator-choice vault (D2), reserve lock
   (D6), creator escrow periphery (D5). As a full review, not a diff (new code base).
2. V4-specific: return-delta accounting for all four swap types, `BeforeSwapDelta` sign conventions, ERC6909 claim
   accounting, hook address flags, behaviour under every UniversalRouter version listed in 2.1, behaviour with the
   protocol fee on.
3. The invariants I1-I13 as properties, fuzzed.
4. The off-chain splitter computation (D1): reproducibility from events, the bands.
5. Deployment script: salt mining, launcher address prediction, `setHook` once, ownership to the Safe.

Founder decision E16 (no paid external audit for gen-6/7) was a budget decision for that release. This generation
moves user funds through a new code base with no upgrade path. [Open, D11; recommendation: a paid external audit]

### 8.4 Test plan [Decided: ladder; Open: dates]

1. Unit + property tests (Foundry or Hardhat) for every function and I1-I13.
2. Fork tests (existing `run-proof.mjs` extended): both chains, both targets, every UR version, side-pool scenario,
   splitter runs.
3. Testnets 97 and 46630: Uniswap V4 must be deployed there (check; if not, deploy V4 core for testing only).
   Full lifecycle in the browser: create, snipe window, trades from our app and from a third-party router, graduation,
   claims, splitter run, holder batch, buyback.
4. Mainnet: one small BNB test coin (founder go) for DexScreener; then canary launch on each chain with
   `createPaused` lifted only for the canary creator (if D3 = signed create, simply only sign for it).

### 8.5 One combined release and gen-7 coexistence [Decided]

- Per CLAUDE.md: no Solana mainnet upgrade until BNB and Robinhood are ready; one combined release with new launchpad
  contracts on BNB and Robinhood and both Solana programs, tested together, then live. Gen-8 is the BNB/Robinhood part
  of that release.
- Gen-7 stays live; existing gen-7 coins keep trading and graduating on gen-7 rules forever.
- Gen-8 launcher deploys with `createPaused = true`. On opening day: gen-8 opens, gen-7 factories
  `setCreatePaused(true)` in the same Safe batch (as C11 did for gen-6).
- No mainnet transaction without an explicit founder go; every step after this document needs one.

---

## 9. Migration and rollout steps

Each step needs an explicit founder go. Effort is engineering days for one developer with Claude, excluding audit
turnaround.

| Step | Work | Effort | Gate |
|---|---|---|---|
| 0 | Founder answers section 10 | | founder |
| 1 | Production contracts: hook (library split, D2 bonding share, A4 flush), lens, launcher (L1-L5), reserve lock, splitter, creator-choice vault, escrow periphery, display factory with `factory()`; unit + property tests; internal audit write-up | 8-10 | founder go |
| 2 | Fork suite extended (all paths, splitter, choice vault, side pools) | 3 | step 1 |
| 3 | Indexer: `evmGen8Pool.ts` (Launched/PoolLaunched/Swap/HookFee/Graduated), D14 table split, pool-price stats and candles, accruals + splitter route worker, continuous holder census, side-pool watcher + `raiseAlert` | 8-10 | step 1 ABIs |
| 4 | API: gen-8 create authorization (D3), `evmGen8CampaignState` + `evmCampaignProgress.js` branch, `campaigns-base.js` holders and status, league pot from `fee_raw`, finance lanes + splitter scan, graduated route not to imports (D9) | 5-6 | step 3 |
| 5 | App: Create.tsx / launchpadClient.ts gen-8 branch, one V4 trade panel before and after graduation (V4Quoter, UR, Permit2, previewFill), coin page, creator panel (claim, transfer), Playbook copy; widget V4 path only if wanted | 6-8 | step 4 |
| 6 | Command Center notification center + side-pool alerts + gen-8 finance views (web-dashboard repo) | 3-4 | step 3 |
| 7 | External audit, fixes, re-test | 10-20 calendar | step 2 |
| 8 | Testnets 97 / 46630 full lifecycle + browser test | 2-3 | step 7, founder go |
| 9 | Mainnet: deploy paused through the Safe; BNB small test coin (DexScreener); canary each chain | 1-2 | founder go per transaction batch |
| 10 | Opening day inside the combined release: gen-8 open, gen-7 create paused | 1 | founder go |

---

## 10. Open decisions

**Founder decisions 2026-10-11:** D1 to D13 accepted as recommended, with this condition on D9: after
graduation the hook fee is 1% (D13), of which the creator gets exactly 0.5% of volume and MemeWarzone 0.5%. When a
widget partner is involved (today CrypticPump), MemeWarzone's 0.5% is split in half with the partner: partner 0.25%,
MemeWarzone 0.25%. The partner share is paid off chain from MemeWarzone's share (the hook stays partner-agnostic;
attribution as today, by the widget build fingerprint). The creator's 0.5% is never reduced. Confirmed: the Major
War League scores battles and check-ins, not trade volume. Still open: D14.


| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | How the router bucket is split per trade (3.4) | A off-chain attribution + bounded splitter; B signed profile in hookData; C no linked routing | **A**: same income, recruiters intact, hook stays signature-free, it is the Solana DBC pipeline |
| D2 | Creator share during bonding and the fee choice (4.1) | (a) hook credits 560 bps of the bonding fee to the creator ledger; (b) splitter pays it; none | **(a)**, plus a gen-8 `CreatorChoiceVault` registered as creator for holders / split / buyback coins |
| D3 | Create authorization (6.1) | signed create-only; fully permissionless | **Signed create-only**: keeps bans, metadata, and app-created pools; trading stays permissionless |
| D4 | Launcher pause (L5) | `createPaused` (launches only); none | **Yes**, launches only, never trading |
| D5 | Creator buy escrow (4.3) | E1 app-level; E2 hook `tx.origin`; E3 none | **E1** (Solana model) |
| D6 | Creator reserve 2% (4.5) | R1 hook; R2 reserve lock released at graduation; R3 at launch | **R2** (same outcome as gen-7, hook untouched) |
| D7 | League volume from third-party trades in our pool (5) | count all; app only | **Count all** trades in our pool (they pay the fee); side pools never |
| D8 | Vaults for gen-8 income (5) | reuse gen-7 per-chain stack; new stack | **Reuse gen-7 vaults** where the splitter can deposit; new contracts only where a vault pins one depositor |
| D9 | Graduated gen-8 coins and the 1% import route fee | no import fee (hook 1% only); add it | **No extra fee**; widget partner share (0.25%) paid off chain from the protocol's 0.50% if wanted |
| D10 | `factory()` on the display pair | add; leave flap-identical | **Add**, prove with one small BNB mainnet test coin (founder go) |
| D11 | External paid audit | paid external; internal only (as E16) | **Paid external audit** before mainnet (immutable, new code base) |
| D12 | Quote-bound coins (BNB quote tokens, Robinhood stocks) | stay on gen-7; gen-8 native only | **Stay on gen-7** for now; gen-8 is native vs coin only |
| D13 | Rates at launch | 200 / 100 / 50 / 9000 as decided; per-coin variants | **Fixed launcher constants** (L1); per-coin variants only by a new launcher |
| D14 | Where gen-8 trades are stored (6.3) | split at the graduation block: `curve_trades` / `token_stats` before, `dex_trades` / `market_stats` after; one table | **Split at the graduation block**: every live reader (leagues, airdrops, battles, coin page) works unchanged |


---

## Appendix A. DogeOS (not in this generation) [Decided: waits]

DogeOS (Chikyū testnet 6281971) is out of gen-8. It waits on answers from DogeOS (Hoff), Barkswap and MuchFi.

| Option | Facts | Fit |
|---|---|---|
| A1. Own Uniswap V3 deployment with a 2% tier (research `research/v3-2pct-fork-proof`, `9e11a3e0`, `fa80c7b6`) | Unmodified V3 core + periphery, 2% tier at tick spacing 400, one-sided A/B positions, fee-only locker, permissionless `graduate()` at the top of A, creator exactly 0.5% of volume after graduation even with MuchFi's 32% protocol cut. 188/188 (Robinhood fork) and 224/224 (DogeOS fork) checks. V3 fees are input-side: sells pay in coin; the range-order compounding realised ~65% of the 2% in native. Anti-sniper needs a token-level tax. Our own V3 is not indexed anywhere on DogeOS (no indexer supports DogeOS yet). Uniswap V3 is GPL now, so self-deploy is legal. | Works without anyone's permission; weaker fee capture; discovery depends on DogeOS indexers arriving |
| A2. Barkswap plugin (Algebra Integral 1.2) | Live factory `0xF3961157…`, custom pools permissionless via `0x19b1a502…`. Plugins can set a per-swap fee (anti-sniper decay possible) but all fees are input-side; plugin fees paid every 8 h and cut by the community fee (default 3%). Barkswap admins (~20 addresses) can `setPlugin` / `setFee` / `setCommunityFee` to 100% on any pool, including ours. Core BUSL until 2027-03-15. | Admin keys over our pools are a blocker unless Barkswap renounces or exempts them |
| A3. MuchFi (PancakeSwap V3 fork) | Tiers 100/500/2500/10000, no 2% tier; `slot0.feeProtocol` uint32, ~32% cut; factory owner is an EOA | Needs a 2% tier from MuchFi and accepts their cut and admin key |
| A4. Uniswap V4 on DogeOS | Not deployed by Uniswap (a third-party BUSL PoolManager exists on testnet). If Uniswap deploys, this gen-8 hook applies unchanged. | Best fit if it happens |

Recommendation: wait for the three answers; if Uniswap V4 comes, reuse gen-8 as is.
